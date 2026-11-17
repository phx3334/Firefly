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

### 控制器

cgroup v2 支持的控制器（`cat /sys/fs/cgroup/cgroup.controllers` 看当前内核实际支持哪些）：

| 控制器 | 管什么 |
| --- | --- |
| cpu | CPU 时间配额（`cpu.max`）与权重（`cpu.weight`） |
| cpuset | 把进程绑定到特定 CPU 核心 / NUMA 节点 |
| memory | 内存上限、回收、统计 |
| io | 块设备 IO 带宽 / IOPS 限制（v1 的 blkio 改名而来） |
| pids | 限制组内能创建的进程/线程总数 |
| hugetlb | 大页内存用量 |
| rdma | RDMA 资源用量 |
| misc | 其他杂项资源（如 `misc.max`） |

### v2 的结构：一棵树 + 三条规则

- **单层级树**：所有控制器统一挂在 `/sys/fs/cgroup`（unified hierarchy），一个进程**只属于一个 cgroup 节点**，不再像 v1 那样分散在多棵树里
- **控制器逐层分发**：父节点通过 `cgroup.subtree_control` 决定往下开放哪些控制器，子节点才会出现 `cpu.max`、`memory.max`——"子组里没有 memory.max"就是这里没开
- **no internal process**：一个 cgroup **要么放进程，要么当中间层**，自己直接持有进程就不能再往下分发控制器。所以真实层级总是长这样：

```text
/sys/fs/cgroup
└── system.slice              ← 中间层：只开 subtree_control，不放进程
    └── docker-<id>.scope     ← 叶子层：进程在这儿，限制也写在这儿
```

> 版本说明：v2 从内核 4.15 起提供，宿主机是否走 unified 由发行版 / systemd（247+ 默认 unified）决定；Docker 20.10+、containerd 1.5+ 只是**支持** v2，实际用哪套跟着宿主机走，不是 Docker 选的。

### 怎么用（实践，v2）
cgroup 的接口就是一组虚拟文件系统，**顺序不能反：先给父组开控制器，再建子组**：
```bash
# 1. 看内核支持哪些控制器，以及根组已经往下分发了哪些
cat /sys/fs/cgroup/cgroup.controllers
cat /sys/fs/cgroup/cgroup.subtree_control   # systemd 机器上通常已启用 cpu/memory

# 2. 给根组启用 cpu、memory（先开，再建子目录）
sudo bash -c 'echo "+cpu +memory" > /sys/fs/cgroup/cgroup.subtree_control'

# 3. 建子组：此时它下面才会出现 cpu.max、memory.max 等文件
sudo mkdir /sys/fs/cgroup/demo

# 4. 限制 CPU：每 100ms 周期最多用 50ms → 半核
sudo bash -c 'echo "50000 100000" > /sys/fs/cgroup/demo/cpu.max'

# 5. 限制内存最多 100MB
sudo bash -c 'echo 104857600 > /sys/fs/cgroup/demo/memory.max'

# 6. 把当前 shell 移进这个 cgroup（它创建的子进程全部受控）
echo $$ | sudo tee /sys/fs/cgroup/demo/cgroup.procs
```

之后在这个 shell 里跑 `stress --vm 1 --vm-bytes 200M`，超过 100MB 的部分会被内核直接 OOM 杀掉（对应 docker 里看到的 OOMKilled）。

注意 `demo` 里已经放了进程，**它就不能再当下层组的父节点**（no internal process）。要在它下面继续分层，得再插一层：进程放 `demo/leaf`，`demo` 只负责开 `subtree_control`。

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
OCI 全称 Open Container Initiative（开放容器协议），目的是把容器技术里各家各实现的部分沉淀成通用标准，目前有三份规范：**runtime-spec**（怎么跑容器）、**image-spec**（镜像长什么样）、**distribution-spec**（镜像怎么分发）。

**runtime-spec 只规定两件事**：
1. **文件系统包（bundle）**：一个目录，里面必须有 `config.json`（容器怎么跑）和 `rootfs/`（容器根文件系统）——runc 的输入就是这个目录
2. **生命周期操作**：`create` / `start` / `state` / `kill` / `delete`。任何 runtime 只要实现这几个命令，就能被 containerd、podman 等上层无差别调用，这正是"运行时可插拔"的基础

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
- **shim 为什么会被 PID 1 收养**：containerd 拉起 shim 后，shim 通过类似 `setsid` 的机制脱离原父进程，被宿主机 init 收养。**主因是让容器生命周期与 containerd 解耦**（即上一条：containerd 重启不杀容器）；僵尸回收是附带收益——shim 产生的僵尸由 init 统一收掉，containerd 不必频繁 `waitpid`。两层收益都有，但别把主次记反。

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
| 看镜像 | `docker images` | `crictl images` / `ctr -n k8s.io images` |
| 拉镜像 | `docker pull` | `crictl pull` |
| 进容器 | `docker exec -it` | `crictl exec -it` / `crictl attach` |
| 看日志 | `docker logs` | `crictl logs` |
| 兼容 docker CLI | — | `nerdctl`（命令几乎 1:1） |

**两个必踩的坑**：
- `ctr` 默认连的是 `default` namespace，而 k8s 的镜像在 `k8s.io` 里——不加 `-n k8s.io` 会"什么都看不到"，第一次排查极易误判成镜像丢了：`ctr -n k8s.io images ls`
- 迁移后 docker 与 containerd 的镜像/容器存储**互不共享**：节点上 `docker images` 里有，不代表 k8s 能直接调度，反向也一样。别再靠 docker 命令"预热镜像"，用 `crictl pull` 或镜像仓库直拉

**5. 构建镜像不再依赖 docker daemon**：CI/CD 里从 `docker build` 转向 BuildKit、`nerdctl build` 等，集群节点也不再需要挂载 `docker.sock`（以前的 dind 方案逐步淘汰）。
**6. 对应用层几乎零感知**：业务照常打包成镜像、照常跑容器，`kubectl` 命令完全不变。变的只是底层运行时和运维排查手段。

## 容器安全

### 隔离根基：六个 namespace

下面所有关于权限的讨论，都建立在"容器先被关进一个独立视图"之上。这个视图就是 namespace——**它不管"能用多少"（cgroup 的事），也不管"能做什么"（capability 的事），只管"能看见什么"**。容器必用的有六种：

| namespace | 隔离什么 | 对应的逃逸面 |
| --- | --- | --- |
| **Mount**（mnt） | 挂载点列表、根文件系统视图 | 最关键的一层，rootfs 靠它；一旦 `-v /:/host` 或 `hostPath` 把宿主目录挂进来，这层等于作废 |
| **PID** | 进程号分配与进程可见性 | 容器内 PID 1 与宿主 PID 毫无关系；但 `/proc/self/status` 的 `NSpid` 会暴露宿主侧编号，配合 `CAP_SYS_PTRACE` 可注入宿主进程 |
| **Network**（net） | 网卡、Pod IP、端口空间、路由、iptables | 共享 `hostNetwork` 等于让容器改节点 iptables、抓节点流量 |
| **IPC** | 共享内存、消息队列、信号量 | 共享 host IPC 时可读写别的进程的 shm 段（SysV 共享内存是重灾区） |
| **UTS** | hostname / domainname | 危害最小，但容器 hostname 常被当成情报收集入口（能推断节点名/集群名） |
| **User** | UID/GID 映射与capability权限判定(特权只在该ns生效) | 唯一**改变权限语义**的 namespace，下一段单独讲 |

默认情况下，Docker、K8s 都不开启 user namespace 隔离（容器和宿主机共用顶层根 user ns），UID/GID 直通。

**User namespace：容器 root ≠ 宿主机 root 的根基**。其余五个 ns 只改变"看得见什么"，只有 user ns 改变"内核认你是谁"：

```text
容器内 uid 0  ──映射──>  宿主机 uid 1000
     ↓                        ↓
能 mount、能 chown        落盘文件属主是 1000
（但只对 ns 内的对象生效，出了 ns 一点权力都没有）
```

映射规则写在 `/proc/<pid>/uid_map`（格式：`ns内ID 宿主ID 长度`）。rootless 容器、rootless BuildKit 全靠它——ns 内是 root，逃逸上限被钉死在宿主那个普通 uid 上。代价是功能缺口（不能监听1–1023这些"特权端口"、部分内核文件系统挂不上、chown 受限）。

### 能力模型：容器里的 root 不是宿主机的 root

宿主机 root 拥有全部 capability；容器里的 root 只有运行时给的**默认集合**（Docker / containerd 默认 14 个：CHOWN、DAC_OVERRIDE、FOWNER、FSETID、KILL、SETGID、SETUID、SETPCAP、NET_BIND_SERVICE、NET_RAW、SYS_CHROOT、MKNOD、AUDIT_WRITE、SETFCAP）。

`--privileged` 会把全部 capability、全部设备、并关掉 seccomp/AppArmor 一次性还回去，等于把容器 root 变成宿主机 root。不要用它偷懒，按需 `--cap-add` 只加必要的那几个：

```bash
docker container run -it --rm --name test test_cap:v1.0 sh
# 看 CapEff：当前生效的 capability 位图
cat /proc/1/status | grep -i cap

# 按需添加：只给 NET_ADMIN
docker container run -it --rm --cap-add NET_ADMIN --name test test_cap:v1.0 sh
```

### 核心原则：身份（uid）和权力（capability）分开

为什么业务容器要非 root：容器与宿主机共享内核，容器 root 的默认 cap 里就有 `DAC_OVERRIDE`，而 `/proc/sys` 里有一部分内核参数是**全局的**、不属于任何 namespace——最典型的是 `/proc/sys/kernel/core_pattern`，容器 root 能把它改成"内核崩溃时执行任意程序"，这是经典的容器逃逸手法。**即便没有把宿主机目录挂进容器，容器 root 依然能影响宿主机。**

所以两件事要分开衡量：

- **uid 决定「以谁的名义」**：影响文件权限表里 owner / group / other 哪一列命中
- **capability 决定「能做什么」**：影响能否绕过权限表、能否 mount、能否改内核参数

非 root 砍掉的是身份；`drop: ["ALL"]` 砍掉的是权力。业务容器两者都砍；特殊情况只保留身份。

### root 的权限到底从哪来，边界在哪

内核做权限判定时**从不看"你叫什么程序"，只看进程凭据**。每次系统调用进来，内核拿三样东西做判定：

```text
cred（uid/gid + capability 位图）
  × LSM 标签（AppArmor profile / SELinux type）—— 允许碰哪些对象
  × seccomp 规则 —— 允许进哪些系统调用入口
```

**root 权限的三个来源**，本质都是"改进程凭据"这一个动作：

1. **内核启动时直接赋**：PID 1（init/systemd）的进程凭据由内核创建时写死 uid=0 + 全部 cap，系统上所有进程都是从它 fork 继承来的——这就是开机即 root 的链条；
2. **SUID/SGID**：exec 一个属主为 root 的 SUID 文件（如 `/usr/bin/passwd`），——这是普通用户借道 root 的合法入口；
3. **显式调用**：`setuid(2)`、`capset(2)`、写 `/proc/self/uid_map`——但前提是当前进程凭据有相应权限，**权限不能无中生有，只能被转移或缩小**。

capability——**"root"不再是一个开关，而是"恰好持有全部 cap 的进程"**。所以 `bounding set` 降到空之后，uid 还是 0 却连读别人文件都不行（缺 `DAC_OVERRIDE`）：身份还在，权力没了。

**权限边界：root 也越不过的四道墙**

| 边界 | 管什么 | 容器 root 的实际表现 |
| --- | --- | --- |
| namespace | 能看见什么 | 没共享 host net ns 就动不了宿主 iptables，出了 mnt ns 挂载不生效 |
| capability bounding set | 能做什么动作 | 缺 `CAP_SYS_ADMIN` 连 `mount` 都发起不了 |
| LSM（AppArmor/SELinux） | 能碰哪些对象 | profile 写死 `/etc/shadow` 不可读，uid=0 照样被拒 |
| seccomp | 能进哪些 syscall | 白名单外的入口直接 EPERM，跟你有没有 cap 无关 |

所以容器 root 的真实权限是一个**交集**：

```text
实际权限 = uid 0 ∩ bounding set ∩ seccomp 白名单 ∩ LSM 策略 ∩ namespace 可见范围
```

### 怎么选：哪些用非 root，哪些用 root

判断口诀：**先问「这个进程要操作谁的文件」**。只碰自己的 → 非 root；必须碰节点上别人的 → 才考虑 root。

| 场景 | 用谁 | 依据 |
| --- | --- | --- |
| 业务容器（HTTP/gRPC 服务、静态资源、数据库、消息队列） | **非 root** | 只读写自己的数据、监听自己的端口 |
| 镜像构建阶段（Dockerfile 前半段） | root | 装包、改文件属主；末尾用 `USER` 切回非 root |
| 需要绑 80/443 等低端口 | **非 root** + 端口映射或 sysctl | 低端口限制针对 uid，绕过办法很多，没必要给 uid=0 |
| 节点级采集器（日志 / 指标 agent：otel-collector、Fluent Bit、Filebeat） | **最小特权 root** | 必须读节点上 root 属主、`0640` 权限的日志文件 |
| 需要操作内核参数、设备、挂载宿主机目录 | 基本是设计问题 | 确需时只加那一个 capability，绝不 `--privileged` |

一句话概括：**90% 的业务容器一律非 root；只有「读别人文件」的节点级 agent 才需要 root，而且要最小特权。**

### 非 root 的标准做法

Docker 经典模式：构建时 root、运行时非 root。

```dockerfile
COPY --chown=app:app ./app /app
USER app
```

K8s 声明式：

```yaml
securityContext:
  runAsNonRoot: true      # uid=0 直接启动失败：这是断言，不是赋值
  runAsUser: 1000
  runAsGroup: 1000
  allowPrivilegeEscalation: false
  capabilities:
    drop: ["ALL"]
  readOnlyRootFilesystem: true
```

`runAsNonRoot: true` 比单写 `runAsUser: 1000` 更值得加——它是**断言**：镜像里如果写了 `USER root`，Pod 会直接起不来，逼你在构建期就改掉。

更稳的做法是程序监听 8080，由 Service / Ingress 暴露 80，连这个 sysctl 都不用碰。

### 必须用 root 时：最小特权 root

以本项目的日志采集器为例（otel-collector agent，tail 节点上的容器 stdout）。

**判定链**：

1. 非 root 能读吗？`/var/log/pods` 下是 `0640 root:root`，uid≠0 时三个权限位全空 → 不能
2. 放宽宿主机权限？会影响节点上**所有 Pod** 的日志隔离 → 代价更高
3. 换采集方式（走 apiserver 读日志）？多一层 RBAC 和 apiserver 压力，还丢文件路径元数据 → 不选

三步都堵死，只能 uid=0。但身份给出去之后，立刻把权力收干净：

```yaml
securityContext:
  runAsUser: 0
  runAsGroup: 0
  readOnlyRootFilesystem: true
  allowPrivilegeEscalation: false
  capabilities:
    drop: ["ALL"]
  seccompProfile:
    type: RuntimeDefault
```

**为什么 `drop: ALL` 之后还能读日志**：uid=0 读属主为 root 的文件走 **owner 位匹配**（owner 列有 r），根本不需要 `DAC_OVERRIDE` 这枚「无视权限表」的徽章。徽章只在「文件属主不是我自己」时才用得上。所以清空 capability 不影响功能，只是拆掉越权能力。

**防线分工别搞混**：`mount` 被拦住根本原因是缺 `CAP_SYS_ADMIN`（内核在 mount 时做 capability 检查），`ptrace` 靠 uid 匹配 + `CAP_SYS_PTRACE`（默认 seccomp profile 里它是「带该 cap 才放行」的条件规则）。**capability 管「能做什么」，seccomp 管「能进哪些内核入口」**，两层不能合并成一句。

按「日志解析器被恶意日志打穿（RCE）」这个场景看五道锁：

| 攻击者想干的事 | 谁拦住 | 内核回应 |
| --- | --- | --- |
| 挂载宿主机磁盘（逃逸常用手段） | 缺 `CAP_SYS_ADMIN` | 拒绝 |
| 给自己加回特权 | bounding set 启动时已降到底 | 永久加不回 |
| 借 SUID 程序提权 | `allowPrivilegeEscalation: false` | SUID 失效 |
| 写木马留持久后门 | `readOnlyRootFilesystem: true` | 镜像层只读（挂载卷仍可写） |
| 调用 `kexec_load` 等高危 syscall | `seccompProfile: RuntimeDefault` | 不在白名单，拒绝 |

爆炸半径收敛到「能读日志 + 能发网络」。想再收一层就用 NetworkPolicy 把出站限制到 `loki:3100`。

#### fsGroup 是什么

`fsGroup` 是 Pod 级 `securityContext` 里的一个字段，本质是**给容器指定一个"补充组"（GID），同时让 kubelet 在挂载卷时用它去调整卷的归属**：

```yaml
securityContext:
  runAsGroup: 1000   # 进程的主组
  fsGroup: 0         # 补充组，同时用于调整卷内文件的属组
```

kubelet 会替你做两件事：

1. 把卷内文件的**属组**改成 `fsGroup`，权限位补上 `rw-rw----`，并给卷目录设 setgid（此后新建的文件自动继承这个组）；
2. 把这个 GID 加进容器进程的**补充组**，进程于是能靠 group 位读写这些文件。

它和 `runAsGroup` 的区别是：`runAsGroup` 只决定"进程主组是谁"，`fsGroup` 负责"卷里文件属于哪个组 + 进程额外加入哪个组"。

关键是**它只对"支持归属管理"的卷生效**：

| 卷类型 | fsGroup 是否生效 |
| --- | --- |
| `emptyDir` | 生效 |
| `configMap` / `secret` | 生效 |
| `PVC`（多数 CSI 驱动） | 生效（取决于驱动） |
| `hostPath` | **不生效** |

因为 hostPath 挂的是宿主机目录，kubelet 不会去改宿主机上文件的属组——上面采集器要读的 `/var/log/pods` 正是 hostPath，所以 fsGroup 在这里帮不上忙，只能手动 `chgrp`（或走判定链里的 uid=0 方案）。

### seccomp：把「能进哪些内核入口」收掉

capability 按**操作能力**授权（mount、chown、改内核参数），seccomp 按**系统调用**授权。两者不重叠，因为有一批危险 syscall **不需要任何 capability** 就能调：`keyctl`、`perf_event_open`、`bpf`、`clone` 的危险 flag 组合。这就是 seccomp 存在的理由

三种 profile：

| 类型 | 含义 | 生产建议 |
| --- | --- | --- |
| `Unconfined` | 完全不过滤 | 只给构建类 Pod（rootless BuildKit 必须，见后文） |
| `RuntimeDefault` | seccomp默认值，docker / containerd 自带白名单，放行常用 syscall | **业务 Pod 的基线，且要显式写出来** |
| `Localhost` | 自写 JSON 白名单 | 只对高敏感负载（跑不可信代码的沙箱）值得投入 |

### AppArmor：管「能碰哪些对象」

capability 和 seccomp 都是围绕**进程**做文章（能做什么动作、能进哪个内核入口），但没人管"这个进程允许读哪些文件、连哪些端口"——这是 LSM（Linux Security Modules）的活。内核在每次文件/网络操作前回调 LSM，由加载的策略判定放行与否，**uid=0 也照样被拦**。Ubuntu/Debian 系默认启用的实现就是 AppArmor。

**核心模型：按路径给二进制画圈**。一个 profile 就是挂到某个可执行文件上的白名单，描述它能碰哪些路径、开哪些网络、用哪些 capability：

```text
#include <tunables/global>
/profile-name flags=(attach_disconnected, mode=enforce) {
  #include <abstractions/base>
  /etc/nginx/nginx.conf   r,          # 只读这个配置
  /var/log/nginx/*        rw,         # 日志可读写
  /var/cache/nginx/**     rw,         # 缓存目录
  /etc/shadow             r,          # ← 没这行，就算 uid=0 也读不了
  network inet stream,                # 只允许 TCP 连接
}
```

三种模式：`enforce` 拦截并审计、`complain` 只记日志不拦（写 profile 时先跑这个收集真实访问）、`unconfined` 不受管。

**生产上你其实一直在用它**——containerd（现在 K8s 主流运行时）：自带的默认 profile 名叫 `containerd-default`，作用思路和当年 `docker-default` 几乎一样：禁止一批危险操作（如挂载宿主设备、改 AppArmor 自身状态）。

选型一句话：**容器场景 AppArmor 是性价比之选**（一条路径 profile 就挡住敏感路径和非白名单端口）；它与 capability/seccomp **并联不重叠**——capability 管动作、seccomp 管入口、LSM 管对象。

**简单说下 SELinux**：另一大 LSM 实现，RHEL/CentOS 系默认启用。区别在策略模型——AppArmor 按**路径**画圈，SELinux 按**标签**做类型强制（进程是 `httpd_t`、文件是 `httpd_sys_content_t`，策略只写"谁能碰谁"，不管具体路径），粒度更细（能管端口、IPC、协议），代价是要给全系统文件打标、调错就全线拒绝，上手成本高得多。容器生态里它是 OpenShift/CRI-O 的默认路径。要满足合规/等保或跑多租户不可信代码才值得上；一般业务容器上AppArmor 

### readOnlyRootFilesystem

**本质**：把容器的根挂载点以只读方式重新挂载，容器内任何写 rootfs 的操作都会被内核以 `Read-only file system`（EROFS）拒绝。**业务 Pod 一般都推荐打开**——它成本极低，却是「RCE（远程代码执行） 之后拿不到落盘持久化」最便宜的一道锁。

实现上是 runc 的活：`pivot_root` 到容器 rootfs 后执行一次 `mount -o remount,ro /`，对应 OCI spec 的 `root.readonly: true`。所以它不是 k8s 发明的策略，而是内核挂载属性，`/proc/mounts` 里 rootfs 那一项的 `ro` 就是它。

**可写边界必须记清**（只读只针对「根挂载点」，不影响其他挂载点）：

| 路径 | 可写 | 说明 |
| --- | --- | --- |
| `/`（镜像层 + UpperDir） | ❌ | `/usr`、`/bin`、`/etc`、应用二进制与配置全部只读，写操作 EROFS |
| 挂载的卷（emptyDir / PVC / configMap / secret） | ✅ | 独立挂载点，各自按自己的挂载属性，只读与否互不影响 |
| `/proc`、`/sys`、`/dev` | ✅ | 伪文件系统，不受 rootfs 只读约束；`/proc/sys` 的写入仍受 capability 管 |
| tmpfs（`emptyDir.medium: Memory` 或 `--tmpfs`） | ✅ | 内存盘，容器重启即清空 |

**打开前，先查应用往哪写**（下面几类是最常见的翻车点）：

| 写入位置 | 典型软件 | 处理方式 |
| --- | --- | --- |
| `/tmp` | JVM（`java.io.tmpdir`）、Python 临时文件、解压器 | 挂 emptyDir / tmpfs |
| `/var/cache`、`/run` | nginx（`/var/cache/nginx`、`nginx.pid`）、PHP-FPM、老 Tomcat | 挂 emptyDir |
| `/var/log` | 应用内部写文件日志 | 改 stdout（12-factor），或挂 emptyDir |
| `$HOME` | 非 root 下工具写的 `~/.cache`、`~/.config` | 设 `HOME=/tmp` |

标准形态是「根只读 + 按需开洞」：

```yaml
securityContext:
  readOnlyRootFilesystem: true
volumeMounts:
  - { name: tmp,   mountPath: /tmp }
  - { name: cache, mountPath: /var/cache/nginx }
volumes:
  - { name: tmp,   emptyDir: {} }
  - { name: cache, emptyDir: {} }
```

验证只需一行：

```bash
kubectl exec -it <pod> -- sh -c 'touch /t && echo writable || echo readonly'
# touch: /t: Read-only file system
```

**它挡什么、不挡什么**：能拦住写木马、改 `/bin/sh`、覆盖 `ld.so.preload`、改 `/etc/passwd`；拦不住往可写卷里落 webshell，也拦不住动 `/proc/sys`——后者归 capability 管。所以它和 `runAsNonRoot`、`drop: ALL`、`seccomp` 是**并联**的四道锁，互不替代。

**不适用的场景**：构建类 Pod（rootless BuildKit / Kaniko 要写 rootfs 与 state）、启动时往 rootfs 写 pid 文件或 `sed -i` 改配置的老应用、需要原地自更新二进制的 agent。

**为什么k8s并没有将其选择为默认打开**：
- 第一，大部分研发人员在日常工作中对于readOnlyRootFilesystem都并不太会去考虑，并且以往有大部分老业务都没有开启这个功能，如果默认开启，而大部分业务pod又没有对于需要进行写的文件进行对应挂载，则会出现大规模报错。
- 还有，对于临时构建镜像的容器，他们是需要对rootfs进行写操作的，比如需要将构建过程中改变的文件写到upperdir，后续与lowerdir进行diff.

**从根上解决**：根只读会逼你把「状态」从镜像里挤出去——日志走 stdout、临时文件走 tmpfs、数据走 PVC。这正是容器化该有的姿势，也是它值得打开的原因。

### 加固口径速查

| 开关 | 业务 Pod | 构建 Pod（rootless BuildKit） | 说明 |
| --- | --- | --- | --- |
| `runAsNonRoot: true` | 必开 | 用 `runAsUser: 1000` 代替 | 前者是断言，后者是赋值 |
| `capabilities.drop: [ALL]` | 必开 | 必开 | rootless 下本来也没有 cap |
| `allowPrivilegeEscalation: false` | 必开 | 必开 | 置 `no_new_privs`，无副作用 |
| `readOnlyRootFilesystem: true` | 推荐开（默认开） | **不开** | 构建要写 rootfs / state |
| `seccompProfile` | `RuntimeDefault` | `Unconfined` | rootless 需要 `unshare` |
| `privileged: true` | 永不 | 仅 DinD 需要，不推荐 | 等价于交出节点 root |

业务 Pod 上线前照这张表逐项对一遍，比事后做一次渗透测试便宜得多。

### 非 root 会影响使用吗

几乎不会。

- 90% 的应用只是读写自己的数据、监听端口、对外提供服务，普通用户完全够
- 构建时 root、运行时非 root 是 Dockerfile 的标准写法
- 低端口用端口映射或 sysctl 解决，不必为了绑 80 就给 uid=0