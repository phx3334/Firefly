---
title: 深入了解docker工作机制
published: 2026-08-23T20:11:23+08:00
description: 学习cgroup原理和使用，dockerd,containerd,runc之间的区别和联系，容器安全等其他知识
image: './images/a21.avif'
tags: [docker]
category: '计算机技术'
draft: false
lang: '中文'
---


## cgroup
### 定义
cgroup（Control Groups，控制组）是 Linux 内核提供的一种**对进程组进行资源限制、统计和控制**的机制。
容器靠 namespace 完成"隔离"，让容器里的进程以为自己住在独立的世界里；但光有隔离还不够——如果没有约束，一个容器里的进程完全可以把宿主机的 CPU、内存吃光，其他容器和宿主机一起遭殃。所以：
> **namespace 管的是"进程能看到什么"，cgroup 管的是"进程能用多少"**，两者配合才是完整的容器隔离方案。

### 核心功能（官方定义的 4 个）
1. **资源限制（limiting）**：限制进程组最多能用多少内存、CPU、磁盘 IO
2. **优先级分配（prioritization）**：多个进程组竞争资源时，通过权重决定谁优先拿到
3. **资源统计（accounting）**：记录进程组实际用了多少资源，用于监控和计费
4. **资源隔离（isolation）**：把一组进程与其他组隔开，防止互相干扰

### 子系统（控制器）v1 叫 subsystem，v2 叫 controller）
cgroup 按资源类型分成多个子系统：
| 子系统 | 管什么 |
| --- | --- |
| cpu | CPU 时间配额与权重（CFS 调度） |
| memory | 内存使用上限、回收、统计 |
| cpuset | 把进程绑定到特定的 CPU 核心 / NUMA 节点 |
| blkio | 块设备（磁盘）IO 带宽限制 |
| pids | 限制组内能创建的进程/线程总数 |
| devices | 控制能否访问设备文件 |
| freezer | 挂起 / 恢复一组进程 |
| net_cls / net_prio | 给网络包打标签，配合 tc 做流量控制 |

### cgroup v1 与 v2
- **v1**（内核 2.6.24 ~ 4.x）：每个子系统各挂一棵独立的层级树（`/sys/fs/cgroup/cpu`、`/sys/fs/cgroup/memory`...），一个进程可以同时属于多棵树的节点。管理混乱，尤其 memory 和 blkio 耦合时容易出问题
- **v2**（内核 4.15 开始）：所有控制器统一挂载到**一棵树**（`/sys/fs/cgroup`），进程只属于一个 cgroup，通过 `cgroup.subtree_control` 在子节点逐个启用控制器，结构清晰。**Docker 20.10+、containerd 1.5+、systemd 247+ 默认走 v2**

### 怎么用（实践，v2）
cgroup 的接口就是一组虚拟文件系统：
```bash
# 1. 创建一个 cgroup 目录
sudo mkdir /sys/fs/cgroup/demo

# 2. 给根组启用 cpu、memory 控制器（子组才有这些文件可用）
sudo bash -c 'echo "+cpu +memory" > /sys/fs/cgroup/cgroup.subtree_control'

# 3. 限制 CPU：每 100ms 周期最多用 50ms → 半核
sudo bash -c 'echo "50000 100000" > /sys/fs/cgroup/demo/cpu.max'

# 4. 限制内存最多 100MB
sudo bash -c 'echo 104857600 > /sys/fs/cgroup/demo/memory.max'

# 5. 把当前 shell 移进这个 cgroup（它创建的子进程全部受控）
echo $$ | sudo tee /sys/fs/cgroup/demo/cgroup.procs
```

之后在这个 shell 里跑 `stress --vm 1 --vm-bytes 200M`，超过 100MB 的部分会被内核直接 OOM 杀掉（对应 docker 里看到的 OOMKilled）。

验证限制是否生效，直接读回文件：

```bash
cat /sys/fs/cgroup/demo/memory.current   # 当前内存用量
cat /sys/fs/cgroup/demo/cpu.stat         # CPU 运行统计
```

### 和 Docker 的关系
Docker 创建容器时，由底层的 runc 给容器进程创建 cgroup 目录并写入限制。所以 **Docker 的命令行参数本质上就是在帮你写 cgroup 文件**：
```bash
docker run --cpus=0.5 --memory=512m nginx
# --cpus=0.5     ≈ cpu.max    写入 "50000 100000"
# --memory=512m  ≈ memory.max 写入 512MiB
```
想验证的话：
```bash
docker run -d --name demo --cpus=0.5 --memory=512m nginx
cat /sys/fs/cgroup/system.slice/docker-<容器ID>.scope/memory.max
cat /sys/fs/cgroup/system.slice/docker-<容器ID>.scope/cpu.max
```
**补充** 默认宿主机中的/proc/<PID>/root ──► 指向容器内的 merged 目录
### 小结
一句话：**namespace 决定容器"看到"什么，cgroup 决定容器"能用"多少**，两者都是 Linux 内核原生的能力，Docker 只是把它们包装成了好用的命令。


## OCI
OCI全称 Open Container Initiative/开放容器协议，隶属于linux基金会，主要目的是制定容器技术的通用标准。  
OCI对容器runtime的标准主要是指定容器运行状态和runtime需要提供的命令  
下面是容器状态转换图：
![容器状态转换图](./images/p1.avif)  


## docker容器结构剖析
`docker inspect` 揭示了容器在宿主机上的真实结构：容器本质上既是宿主机上的一个进程，也是宿主机上的一组目录挂载。以下从守护进程的职责、containerd 与 containerd-shim 的分工、以及 Overlay2 存储驱动三个层面进行剖析。  
![docker容器创建流程图](./images/p2.avif)  
### 一、守护进程（dockerd）在整个结构中的作用

Docker 守护进程 `dockerd` 是用户与容器运行时之间的总入口，它并不亲自创建容器，而是把请求转交给下层组件：

- **接收并翻译指令**：`docker run`、`docker inspect` 等 CLI 命令经 daemon 接收，由 daemon 解析为对 `containerd` 的调用。
- **管理镜像与网络**：镜像的拉取、构建、存储，以及网络、卷的创建与编排，均由 daemon 负责并交由对应子系统执行。
- **不直接触碰运行时**：daemon 通过 gRPC 调用 `containerd`，再由 containerd 管理具体的容器生命周期，从而将"用户接口层"与"运行时实现层"解耦。

完整调用链为：  
```
Docker Daemon (dockerd) → containerd → containerd-shim → runC → 容器进程
```

### 二、containerd 与 containerd-shim
- **containerd 的定位**：作为守护进程与运行时之间的中间层，containerd 负责镜像管理、容器生命周期编排，并通过拉起 `containerd-shim` 来实际创建容器。
- **containerd-shim 的作用**：containerd 启动 shim 进程，由 shim 调用 runC（OCI 运行时）创建容器并初始化命名空间；runC 完成创建后即退出，容器的后续生命周期改由 shim 维持。这样即便 containerd 重启，已运行的容器也不受影响。
- **shim 父进程为 1 的原因**：shim 通过类似 `setsid` 的机制脱离原父进程，直接被宿主机 init（PID 1）收养。目的是利用 init 回收僵尸进程的特性——shim 产生的僵尸由 init 统一回收，从而**解放 containerd**，避免其频繁调用 `waitpid`。

### 三、Overlay2 存储驱动与文件系统原理

`docker inspect` 的 `GraphDriver` 字段揭示了容器文件系统的分层结构（基于联合挂载 UnionFS）：

| 目录 | 含义 |
|------|------|
| `LowerDir` | 只读镜像层，内容可通过 `docker save` 导出解压验证一致 |
| `UpperDir` | 可读写的容器层，存放运行期产生的修改 |
| `WorkDir` | 联合挂载所需的临时工作目录 |
| `MergedDir` | LowerDir + UpperDir 合并后的统一视图，即容器内看到的根 `/` |

此外，`resolv.conf`、`hostname`、`hosts` 等网络配置文件由 Docker 动态生成并单独挂载到容器，位于宿主机 `/var/lib/docker/containers/[ID]/` 下。

**宿主机直操作验证**：容器文件系统本质是宿主机目录的挂载。在宿主机的 `UpperDir` 或 `MergedDir` 中创建文件，容器内立即可见；容器内修改文件，实质写入宿主机 `UpperDir`。这意味着无需进入容器，即可通过 `docker inspect` 获取的 `GraphDriver` 路径直接在宿主机读写容器数据。

**补充要点**：
- `LowerDir` 是多容器共享的：同一镜像启动多个容器，只读层共用，只有 `UpperDir` 各自独立，这正是 Docker 镜像"分层复用、写时复制（CoW）"节省磁盘的原理。
- 删除容器只会清掉其 `UpperDir` 与 `MergedDir`，`LowerDir`（镜像层）不受影响，除非显式删除镜像。


## 容器运行时
用于管理容器运行时的诸多软件都可以称作容器运行时，事实上，dockerd,containerd,runc都是容器运行时。但是为了区分，所以这样叫了。前二者也可以称作high-level的容器运行时，而runc是low-level的容器运行时。  
- low-level的容器运行时：只涉及容器运行时的一些基础细节，例如namespaces创建，cgroups设置，联合文件系统的创建。  
- high-level的容器运行时：支持更多高级功能，例如镜像管理，grpc,对于高级运行时来说，他们是调用低级运行时来管理容器，可以简单理解为高级容器运行时是在低级的基础上做了上层封装
**为什么会有这种情况**：  
通常情况下，开发人员不仅需要低级别运行时提供的特性，还需要镜像格式，镜像管理相关api接口和特性，而这些特性通常由高级别运行时提供。
### Low-level容器运行时之Runc
**定义**：runc 是 OCI runtime 规范的**参考实现**（reference implementation）。2015 年 Docker 把自己的容器执行模块拆出来开源并捐给 OCI，如今主流容器引擎（docker、containerd、podman、k8s）底层跑的基本都是它（或其衍生）。
**特点：极简，只干一件事**——按一份 OCI 标准的 `config.json` 把容器"跑起来"，不涉及镜像拉取、网络、存储等高级功能。

**runc 实际做的事**（也就是 low-level 运行时该干的事）：
- 按 config.json 创建 namespaces（PID、Mount、Network...）
- 设置 cgroups（CPU、内存等资源限制）
- 挂载 rootfs 并 `pivot_root`，把根目录切到容器文件系统
- exec 容器进程，交付出容器的 PID 1
config.json 里的几个关键字段：
| 字段 | 含义 |
| --- | --- |
| root.path | 容器 rootfs 位置 |
| process.args | 容器内 PID 1 要执行的命令 |
| process.env / cwd | 环境变量、工作目录 |
| mounts | 挂载的设备/目录 |
| linux.namespaces | 启用哪些 namespace |
| linux.resources | cgroup 资源限制 |

**生命周期很短**：runc 创建完容器就退出，之后容器的状态由 shim 进程维持（见下文）。

### High-level容器运行时之Containerd
**定义**：2017 年 Docker 把镜像管理、存储、容器生命周期管理能力拆出来捐给 CNCF，2019 年成为继 Kubernetes、Prometheus 之后第三个毕业项目。它补上了 runc 缺少的部分：镜像、存储、网络、CRI。

**相比 runc 多出的能力**：
- 镜像管理：pull / push、分层存储、内容寻址
- 快照（snapshotter）：管理 overlay2 的镜像分层
- 容器生命周期编排：create / start / stop / exec 的完整流程
- CRI 实现：kubelet 通过 CRI（gRPC）直接对接 containerd，它是 **k8s 里最主流的运行时**
- 每个容器一个 shim 进程：shim 持有容器状态，containerd 重启也不影响正在运行的容器

**containerd 自己的 CLI**：
```bash
ctr images pull docker.io/library/nginx:latest   # ctr：containerd 自带调试工具
ctr run docker.io/library/nginx:latest nginx1
nerdctl run -d nginx                              # nerdctl：containerd 官方出的 docker 兼容 CLI
```
**docker 与 containerd 的关系**：`docker run` 的本质是 dockerd 调用 containerd 的 API 完成镜像管理和生命周期编排，containerd 再拉起 shim → runc。所以口语里的"docker"实际是**一整条链路**：CLI + dockerd + containerd + shim + runc。
**三者职责一句话对比**：
| | runc | containerd | dockerd |
| --- | --- | --- | --- |
| 级别 | low-level | high-level | 最上层（docker 客户端入口） |
| 管什么 | 创建并运行容器进程 | 镜像管理 + 生命周期编排 + CRI | 用户接口、网络、卷 |
| 会不会拉镜像 | ❌ | ✅ | ✅（转交 containerd） |
| 直接被 k8s 使用 | ❌ | ✅（CRI） | ❌ |
| 类比 | 执行者（干活的手） | 管家（统筹调度） | 前台（接待用户） |


## 为什么k8s抛弃了dockerd
**背景时间线**：k8s 在 1.20（2020.12）宣布弃用 `dockershim`（kubelet 里专门对接 docker 的胶水模块），给了 4 个版本的过渡期，1.24（2022.5）正式移除。之后的 k8s 集群**不再内置 docker 支持**。
### 为什么抛弃（简要）
1. **dockershim 是 k8s 自己维护的**：它对接 dockerd 的代码由 k8s 社区维护，不是 docker 官方提供，等于 k8s 白养一个"翻译官"，双倍维护负担
2. **dockerd 功能过剩**：dockerd 是面向用户的完整产品（网络、卷、build、swarm），而 k8s 只需要"拉镜像 + 跑容器"，中间隔着 dockerd 纯属多余
3. **链路太长**：`kubelet → dockershim → dockerd → containerd → shim → runc`，每多一跳就多一个故障点、多一点性能损耗
4. **containerd 自己就能干**：containerd 本身实现了 CRI（k8s 官方运行时接口），功能完整，没必要再包一层 dockerd
5. **与 docker 解耦**：k8s 不想把自己的运行时命运绑在第三方公司

### 抛弃后做了什么改变（重点）

**1. kubelet 直连 containerd（CRI）**

改变前：
```
kubelet → dockershim → dockerd → containerd → shim → runc → 容器
```
改变后：
```
kubelet → containerd（CRI）→ shim → runc → 容器
```
少了一整层 dockerd + dockershim，链路更短、故障面更小。

**2. dockershim 代码从 k8s 仓库彻底删除**，k8s 此后不再内置 docker 支持。

**3. 运行时变得可插拔**：kubelet 只认 CRI 接口，底下装什么都行——containerd、CRI-O、Kata Containers（安全容器）、gVisor、Firecracker（微虚机）。这也是 k8s 抛弃 docker 的真正收益。

**4. 调试与使用工具的变化**（对运维影响最大的部分）：
| 场景 | 以前（docker 时代） | 现在（containerd 时代） |
| --- | --- | --- |
| 看容器列表 | `docker ps` | `crictl ps` / `nerdctl ps` |
| 看镜像 | `docker images` | `crictl images` / `ctr images` |
| 拉镜像 | `docker pull` | `crictl pull` |
| 进容器 | `docker exec -it` | `crictl exec -it` / `crictl attach` |
| 看日志 | `docker logs` | `crictl logs` |
| 兼容 docker CLI | — | `nerdctl`（命令几乎 1:1） |

**5. 构建镜像不再依赖 docker daemon**：CI/CD 里从 `docker build` 转向 BuildKit、`nerdctl build` 等，集群节点也不再需要挂载 `docker.sock`（以前的 dind 方案逐步淘汰）。、
**6. 对应用层几乎零感知**：业务照常打包成镜像、照常跑容器，`kubectl` 命令完全不变。变的只是底层运行时和运维排查手段。


## 如何查看容器内cpu使用率
![top命令输出](./images/p3.avif)  
us:用户态占用CPU百分比
sy:内核态占用CPU百分比
ni:改过优先级的用户进程
id:空闲CPU百分比
wa:IO等待占用CPU百分比
hi:硬中断占用CPU百分比
si:软中断占用CPU百分比  
- load average: 1分钟、5分钟、15分钟的平均负载(在某段时间平均活跃的进程数，包含系统处于可运行状态以及不可中断状态的平均进程数)  
- cpu利用率：用户进程占用cpu时间（包括us和sy）/cpu经历的这段时间总和。进程对cpu利用率100%代表用满一颗cpu，200%则用满2颗
**top命令为什么在容器内无法查看容器cpu使用情况**： 
top的cpu数据是从 /proc/stat 读的，而 /proc/stat 记录的是整个宿主机的全局累计值，PID namespace 隔离不了它。  
```bash
# CPU% 那一列就是容器整体使用率,数据源来自cgroup
docker stats --no-stream <容器名>
#输出内容很多，包括进程pid,名字，运行状态，优先级等等。utime代表用户态部分在linux调度中获取cpu的ticks,stime则是内核态。
#ticks是linux系统中的时间单位，表示一次中断的周期，所消耗时间由HZ决定，默认100，即100分之1秒
#t秒为时间间隔，则某个进程cpu使用比=((u2-u1)+(s2-s1))/(HZ*t)
cat /proc/19838/stat
```
### 补充
#### 常见进程的运行状态
进程状态由内核记录，可通过 `ps -o stat,pid,cmd` 或 `/proc/<pid>/stat` 第 3 个字段查看：
| 状态 | 含义 | 能否被打断 | 典型场景 |
| --- | --- | --- | --- |
| R（Running） | 正在运行或在运行队列中等待 CPU | — | 正常计算任务 |
| S（Sleeping） | 可中断睡眠，等待某事件 | ✅ 可被信号唤醒 | 等 IO、等锁、sleep |
| D（Uninterruptible） | 不可中断睡眠，等 IO 完成 | ❌ kill -9 也没用 | 磁盘/NFS 读写卡住 |
| T（Stopped） | 停止 | 可继续 | Ctrl+Z（SIGTSTP） |
| Z（Zombie） | 僵尸：已退出但父进程没 wait 收尸 | — | 父进程没处理 SIGCHLD |
| I（Idle） | 内核空闲线程 | — | 不算入负载 |
**STAT 列是"主状态 + 修饰符"的复合**：`ps` 里的 STAT 用大写字母表示主状态（上表），后面可跟小写修饰符：
| 修饰符 | 含义 |
| --- | --- |
| s | 会话首领（由 `setsid()` 创建，脱离原会话） |
| l | 多线程 |
| + | 前台进程 |
| < | 高优先级（nice < 0） |
| N | 低优先级（nice > 0） |
所以 `Ss` = S（睡眠）+ s（会话首领）。**容器里的 PID 1 进程在宿主机 `ps` 里通常就是 `Ss`**——runc/shim 用类似 `setsid` 的机制让容器 init 成为会话首领，正好呼应前面 OCI 部分"会话由首领经 setsid 创建"的内容。
#### 平均负载和cpu占有率相关问题
**平均负载（load average）**：1/5/15 分钟"活跃任务数"的平均（R + D），Linux 特地把不可中断状态也算进去（为了暴露 IO 阻塞）。
**cpu 利用率**：CPU 在统计周期内真正干活的时间占比（us+sy 等），0~100%（N 核上限 100%×N）。
两者不是一回事，最直观的区别：
| | 平均负载 | cpu 利用率 |
| --- | --- | --- |
| 统计对象 | 任务数（排队的有几个） | CPU 忙不忙（时间占比） |
| 单位 | 个数（可以是小数/几十） | 百分比 |
| 数据源 | 运行队列长度 + D 状态数 | /proc/stat 的累计时间差值 |
| 类比 | 餐厅排队人数 | 厨房开火率 |
**经典判断组合**：
| 现象 | 结论 |
| --- | --- |
| load 高 + CPU 忙（us/sy 高） | CPU 瓶颈，扩容/优化 |
| load 高 + CPU 闲（id 高） | IO 瓶颈 或 D 状态堆积（NFS 失联、磁盘卡） |
| load 低 + CPU 高 | 任务少但都在跑，正常 |
| load 高 + CPU 闲 + wa 低 | 卡在不可中断 IO（NFS），最麻烦 |
**load 和核数的关系**：
- 经验上：load ≈ 核数 表示"刚好用满"（8 核 load 8），大于核数说明有排队
- 但要小心：D 状态进程会让 load 虚高——8 核机器 load 20 但 CPU 全闲，很可能是 IO 卡死而不是真忙
- 判断负载健康要用 `top`/`uptime` 结合 CPU%、D 进程数一起看，单看 load 会误判


## 容器安全
在宿主机上，root用户拥有所有capability(特权)，而在容器里面root用户只具备默认的capability.   
如果容器没有一些特权，我们不应该直接指定--privileged参数来启动容器，因为那样会让容器root具有所有特权。而是应该指定一些必要的capability.
我们可以起一个临时容器，进容器里面看看其所具备的特权
```bash
docker container run -it --run --name test test_cap:v1.0 sh
cat /proc/1/stat | grep -i cap
#该命令可以在启动容器时添加cap_net_admin特权
docker container run -it --rm --cap-add NET_ADMIN --name test test_cap:v1.0 sh
```
**重要**： 我们应该以非root用户启动容器，因为容器内root用户依然有部分特权且容器和宿主机是共享内核的，所以即便一些关键数据没用挂载给容器，在容器内依旧可以影响到宿主机的一些重要文件。一旦容器内的应用有安全漏洞，攻击者就会顺着该漏洞逃逸出容器对宿主机造成伤害。  
**综上，常见解决方案** ：  
- 如果需要用root用户运行，请最小化 capability，先`--cap-drop ALL`，在按需添加
- 非root用户运行容器`docker run --user appuser test_cap:v1.0 sh`，也可以在dockerfile和docker-compose中指定
- 不共享宿主命名空间
- 禁止危险挂载，如/proc,/var/run/docker.sock（Docker 守护进程（dockerd（以root用户运行）对外暴露的通信接口，如果挂载给容器，容器内就可以使用docker命令任意创建容器）
- 精简镜像、内核及时打补丁
**非root用户运行容器不会影响容器的使用吗？**：
几乎不会。  
- Web 服务、数据库、消息队列等 90% 的应用只是"读写自己的数据、监听端口、对外提供服务，只需要普通用户
- Dockerfile 的经典模式是构建时 root、运行时非 root
- 绑定 80/443 端口可用，可以通过端口映射，比如8080:80