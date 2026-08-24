---
title: 初步认识虚拟化技术
published: 2026-08-06T20:00:21+08:00
description: '了解docker的基本原理和使用方法'
image: './images/a12.avif'
tags: [docker,虚拟化]
category: '计算机技术'
draft: false
lang: '中文'
---

## 前置
### 名称空间
内核级资源视图隔离机制，让一组进程「看到」不同的全局资源。类型：`mnt` `net` `pid` `uts` `ipc` `user` `cgroup` `time`。通过 `unshare()` / 容器运行时创建，用 `lsns` 或 `/proc/<pid>/ns/` 查看，以 inode 编号标识，**编号相同即同一命名空间**。决定「进程能看到什么资源」。

### 会话
UNIX 进程关系 / 作业控制机制。一个会话 = 一组进程组，由会话首领经 `setsid()` 创建。典型场景：终端登录、`tmux`、守护进程脱离终端。用 `ps -o sid` 查看。决定「进程在作业控制上归谁管」，与资源视图隔离无关。
> 两者正交：命名空间管「资源视图」，会话管「进程从属」，可叠加但互不相等。

### cgroup
#### 补充
**硬件中断**:  
由 CPU 外部设备通过中断线主动通知，异步、不可预期。中断处理分两步：上半部（top half）只做紧急简短的收尾，耗时的剩余工作推迟执行。
- **网卡中断**：网卡收到数据包后触发中断，CPU 暂停当前任务，把数据从网卡缓冲区拷入内核交给协议栈处理（中断处理完成后用软中断继续）。
- **时钟中断**：定时器周期性触发（Linux 默认 1000 次/秒），是进程调度的基础，负责时间片轮转、系统时间统计、超时与睡眠唤醒。
**软中断**：  
- 内核把硬件中断中耗时的剩余处理延迟到软中断（softirq）执行，保证硬中断快速返回。典型：网络收包后的协议栈处理、时钟中断后的调度统计。
- 意义：硬件中断对cpu占有的优先级最高，硬件中断过程，其他中断进不来，例如网卡又来包了，时钟中断又来了，如果硬中断时间过长，会导致丢包，系统时间紊乱和系统调度异常。而软中断的优先级低于硬中断，但高于用户进程。例如用户正在玩怪猎，后台百度网盘正在下载小电影（ 网卡持续收包），游戏画面可能会有些许掉帧，卡顿，但是下载速度几乎不受影响。
**软件中断**
程序通过特殊指令（`syscall` / `int 0x80`）主动陷入内核，同步、可控。典型：系统调用（`read`、`write`）、异常（缺页、除零）。

#### cpu cgroup
**定义**：  
cpu cgroup顾名思义就是限制进程对cpu的使用（硬件中断和软件中断的时间不计入cpu usage），属于cgroup的一个子系统
......   
**cgroup详情将会放在后面写k8s或者docker深入的文章里面**


## 虚拟化技术简要介绍
- **定义**：虚拟化是在硬件与操作系统之间（或之上）加一层抽象，把一台物理机的计算/存储/网络资源切分、模拟成多台逻辑上独立的「机器」，让多个隔离的环境能共用同一套物理资源。
- **两种部署形态对比**：
  | 维度 | 虚拟机（VM） | 容器（Docker 等） |
  | --- | --- | --- |
  | 隔离单位 | 完整操作系统 | 进程级隔离 |
  | 需要的内核 | **各自带一个完整内核** | **共享宿主机内核**，只需自己的文件系统 |
  | 需要的内容 | 内核 + 完整文件系统 + 硬件模拟 | 仅文件系统（应用 + 依赖） |
  | 启动速度 | 慢（分钟级，要 boot 内核） | 快（秒级，直接跑进程） |
  | 体积 | 大（GB 级） | 小（MB~百 MB 级） |
  | 隔离强度 | 强（内核级隔离） | 较弱（共享内核，靠 namespace/cgroup 隔离） |
- **Hypervisor（虚拟机监控器）**：负责创建和管理虚拟机的那层软件，分两类：
  - **Type 1（裸金属 / 原生）**：直接跑在物理硬件上，不依赖宿主 OS。性能好、接近原生，常用于生产服务器。
  - **Type 2（宿主型）**：跑在现有操作系统之上，由宿主 OS 调度硬件。易用、适合桌面开发测试。例：VirtualBox、VMware Workstation。
  > KVM 关键点：它以内核模块形式存在，利用 CPU 的硬件虚拟化扩展让 Guest 指令近乎原生执行；用户态用 QEMU 模拟网卡/磁盘等设备，二者配合才是完整 VM 方案。
- **容器为什么不需要 Hypervisor**：容器不虚拟硬件、不跑独立内核，而是用宿主内核的 **namespace**（隔离视图：PID/网络/挂载等）和 **cgroup**（限制 CPU/内存等资源）把进程圈起来，所以比 VM 少了一层内核与硬件模拟的开销
**下面是一段c语言开发的容器引擎demo**
```c
#define _GNU_SOURCE 
#include <sys/types.h>
#include <sys/wait.h>
#include <stdio.h>
#include <sched.h>
#include <signal.h>
#include <unistd.h>
#include <sys/mount.h>
 
// 定义一个给 clone 用的栈，栈大小1M 
#define STACK_SIZE (1024 * 1024) 
static char container_stack[STACK_SIZE];
 
char* const container_args[] = {
    "/bin/bash",
    NULL
};
 
int container_main(void* arg) 
{ 
    printf("Container [%d] - inside the container!\n", getpid()); 
    sethostname("container",10); 
    //本demo实验在linux虚拟机的命令行执行，rootfs文件夹在/根文件夹下面，需要自己手动将根文件下面的重要文件复制到rootfs文件夹下面。
    //rootfs就作为容器内部的根文件。
    if (chdir("./rootfs")!=0 || chroot("./")!=0){
      perror("chdir/chroot");
    }
    //下面是导入虚拟文件系统，这里只举例一个，其他省略。
    if(mount("proc", "rootfs/proc", "proc", 0, NULL))!=0{
      perror("mount proc");
    }
    //......

    //模仿docker的从外向容器内mount相关的配置文件（因为这些配置经常变动，所以单独挂载）
    //conf文件所在目录和rootfs同级
    //这里也只是举例其中一个挂载
    if(mount("conf/resolv.conf","rootfs/etc/resolv.conf","none",MS_BIND,NULL)!=0){
      perror("mount resolv.conf");
    }
    //......
    //container_args[0]作为容器内的一号进程，也就是/bin/bash,它是shell解释器，支持交互模式的命令行界面
    execv(container_args[0], container_args); 
    printf("Something's wrong!\n"); 
    return 1; 
} 
 
int main() 
{ 
    printf("Parent [%d] - start a container!\n", getpid()); 
    /* 启用Mount Namespace - 增加CLONE_NEWNS参数 */ 
    //因为栈向下生长，所以传 container_stack+STACK_SIZE，另外堆向上生长
    //clone(container_main,...)就是创建一个新进程(子进程)，也就是容器内部的第一个进程。
    int container_pid = clone(container_main, container_stack+STACK_SIZE,  
            CLONE_NEWUTS | CLONE_NEWIPC | CLONE_NEWPID | CLONE_NEWNS | SIGCHLD, NULL); 
    waitpid(container_pid, NULL, 0); 
    printf("Parent - container stopped!\n"); 
    return 0; 
    //CLONE_NEWUTS：独立主机名（所以里面 sethostname 不影响宿主机）
    //CLONE_NEWIPC：独立进程间通信通道,保证容器内进程不能和容器外进程通信
    //CLONE_NEWPID：独立 PID 编号（里面从 1 开始数）
    //CLONE_NEWNS：独立挂载点（里面挂 /proc 不影响外面）
    //SIGCHLD：子进程退出时给父进程发 SIGCHLD 信号（当子进程状态变化了，自动通知父进程）
} 
```


## 联合挂载文件系统
- **概念**：联合挂载把多个目录（层）**叠加挂载**到同一个挂载点，上层覆盖下层同名文件，读取时看到的是合并后的统一视图。Docker 镜像/容器正是靠它实现「只读层复用 + 可写层独立」。
- **OverlayFS**：Linux 原生联合文件系统，核心由四部分组成：
  - `lowerdir`：只读的下层文件（可多个，镜像的各层）；
  - `upperdir`：可读写的上层（容器运行时的修改）；
  - `workdir`：内部暂存目录（供写时复制用，用户不可见）；
  - `merged`：最终呈现给用户的统一挂载视图。
  ```bash
  mount -t overlay overlay \
    -o lowerdir=/l1:/l2,upperdir=/upper,workdir=/work \
    /merged
  ```
- **Overlay2（Docker 默认存储驱动）的层级结构**：相比早期 `overlay`（只支持单层 lower），`overlay2` 支持**多层 lowerdir 串联**，更贴合镜像「一层层叠出来」的模型：
  - 镜像层：都是只读 `lowerdir`，按从底到顶顺序 `lower1:lower2:...:lowerN` （导出的新镜像中原来的upperdir会成为lowerdir中的一个放在顶部）串联；
  - 容器层：在最上面加一个可读写 `upperdir`；
  - 修改文件时触发 **CoW（写时复制）**：先把 lower 里的文件复制到 upper，再改 upper 的副本，原只读层不受影响；
  - 删除文件时：`upperdir` 里建一个 `whiteout`（白障文件）遮盖下层同名文件，而非真删底层。
  ```
  视图(merged)
    └─ upperdir(容器可写层, 改动落这里)
       └─ lowerN (镜像层 N, 只读)
          └─ ...
             └─ lower1 (基础镜像层, 只读)
  ```
- **使用原理小结**：
  - **复用**：多个容器可共享同一批只读镜像层，只在最上层各带一个可写层，极大省磁盘与启动时间；
  - **隔离**：每个容器的 `upperdir` 相互独立，互不干扰；
  - **高效**：CoW 保证只读层零拷贝复用，直到真正修改才复制，避免整层复制的开销。
  > 一句话：Overlay2 把「多个只读镜像层 + 一个可写容器层」联合成统一视图，靠 CoW 和白障实现高效复用与隔离——这正是 Docker 镜像轻量、启动飞快的根本原因之一。


## docker
### 安装docker前需要做的一些准备工作
```bash
#需要将selinux和防火墙关掉，减少实验测试过程中出现的奇怪问题
sudo sed -i 's/^SELINUX=.*/SELINUX=disabled/' /etc/selinux/config
#使当前会话立刻生效
setenforce 0
sudo systemctl stop firewalld      # 立即停止
sudo systemctl disable firewalld   # 禁止开机自启
#关掉swap分区，因为这个会影响Cgroup设定的内存设置无法严格生效，不过实际生产环境中，某些特定容器需要灵活控制swap分区使用，这里简化操作。
#立即关闭。注释/etc/fab文件中的Swap分区自动挂载防止开机自启
swapoff -a
```
### 常用命令
#### docker及其容器的信息查看
```bash
#-d 代表后台运行容器进程，sleep 10000是容器启动后的第一个进程，这个进程必须一直存在且要是前台进程，不能过一会容器就退出了。此外，这个命令必须存在于你指定的镜像里面。如果你自己不指定命令，那么就按照镜像配置中CMD的命令
docker run -d --name test centos:7 sleep 10000
#查看所有容器，包括关闭的 
docker container ls -a
#查看所有镜像
docker images
#查看test容器详细信息
docker inspect test
#查看容器日志
docker logs test
#查看容器的资源占用情况
docker container stats（可指定或不指定名字）
#查看容器的进程信息
docker container top （可指定或不指定名字）
#查看当前系统/进程所使用的各种 Linux 命名空间信息
lsns
#查看 Docker 引擎（守护进程）的整体运行状态和配置信息
docker info
#docker守护进程的配置文件，里面主要包含了镜像源加速列表，docker数据目录存储位置,容器默认dns等等
/etc/docker/daemon.json
#查看某个进程所属的名称空间
/proc/[pid]/ns

```
#### pull与push
完整镜像地址格式：镜像仓库网址/项目名/镜像名:标签  
地址示例：  
官方镜像：docker.io/library/nginx:(版本)   
个人镜像：docker.io/phx3334(账号名)/nginx:(版本)    
```bash
#从官方仓库拉取可省略网址docker.io
docker pull docker.io/library/nginx:1.18
#删除本地镜像,必须先停止容器再删除镜像
docker image rm -f <镜像名>:<标签>或 <ID>
#推送前必须先对本地镜像打标签，使其符合目标仓库地址格式。
docker tag <本地镜像名>:<标签> <目标完整地址>
docker tag nginx:1.18 docker.io/phx3334/nginx:v1.0
#推送
docker push docker.io/phx3334/nginx:v1.0

登录：docker login -u <用户> -p <密码> <仓库地址>
登出：docker logout
```
#### save和load
```bash
#导出的 tar 包可通过 U 盘物理拷贝，或在网络互通但无仓库的情况下通过 SCP 命令传输。
docker save <镜像名>:<标签>  <文件名.tar>
#加载镜像
docker load -i <文件名.tar>
```
#### 进入容器
```bash
#采取交互式模式进入容器并运行sh进程
docker exec -it test sh

#当容器内部缺失特定命令且无法安装（如无网络、追求极致精简）时。
#利用宿主机已有的命令，在容器的命名空间中执行。
#nsenter 借助宿主机的命令二进制文件，切换到目标容器的命名空间（Namespace）中执行。
#无需在容器文件系统内存在该命令文件。

#获取容器主进程PID
docker inspect --format '{{.State.Pid}}' <container_name>
#-t指定目标进程 PID,-n：指定进入网络命名空间（也可结合其他参数进入不同命名空间）
nsenter -t <PID> -n netstat -an
```
#### 文件复制
```bash
#将宿主机文件复制到容器
docker cp <宿主机文件路径> <容器名>:<容器内路径>
#将容器文件复制到宿主机
docker cp <容器名>:<容器内路径> <宿主机文件路径>
```

### dokcer数据迁移
#### 前置
Docker默认数据目录位于 /var/lib/docker：   
- 本地镜像：无论是从仓库拉取还是通过压缩包导入，所有本地镜像均存储于此。
- 容器新增数据：若容器未关联外部存储卷，其在运行过程中产生的新增数据（写入容器层 upper dir）默认也存储在该目录下。
#### 为什么需要数据迁移
- 迁移触发场景：随着本地镜像增多或容器运行产生大量数据，数据目录所在磁盘空间即将耗尽，且该磁盘无法扩容。  
- 根本原因：初始安装docker时未做好存储规划。
##### 正确规划建议：
- 初始配置：为docker数据目录分配足够大的磁盘，并建议使用逻辑卷管理 (LVM) 以便后期扩容。
- 容器配置：对于产生大量数据的容器，应将其特定路径挂载到外部存储卷，避免数据写入默认数据目录。
#### 数据迁移操作
`1`先停止容器`docker container stop <container_name>`，再停止docker`systemctl stop docker`  
`2`新增一块大磁盘，建议采取LVM配置（支持动态扩容），磁盘经过格式化，分区等处理后，通过 blkid 获取UUID，编辑 /etc/fstab 添加挂载信息  
`3`使用`cp -a /var/lib/docker /data/docker `将旧数据完整拷贝至新目录。  
`4`编辑 `/etc/docker/daemon.json`,指向新目录："data-root": "/data/docker"  
`5`最后重启docker和容器，执行 `docker info | grep "Root Dir"`，确认路径已变更为 /data/docker.通过 docker inspect 或查看文件系统挂载情况，确认镜像层和容器层数据已位于新目录下。若没有则手动umount.  
 
### 数据卷挂载和docker commit
#### 数据卷挂载
容器启动后产生的新数据写在 Overlay2 的 `UpperDir`（可写层），该层随容器销毁而被清除。为持久化关键数据，需把宿主机目录（或 Docker 管理卷）关联到容器内的某个路径——容器向该路径写入的数据**直接落到宿主机**，容器删除后数据依然保留。    
**Bind Mount（宿主机目录映射）**：`-v /宿主机目录:/容器内目录`，两边共享同一存储空间。容器内对该目录的读写直接作用于宿主机目录，容器销毁后宿主机目录及数据仍在，重启容器重新关联即可恢复。
> 背景补充：Docker 诞生早于 Kubernetes，自带完备的挂载卷能力；但 K8S 作为容器编排平台提供了重叠的存储管理模块，生产中多以 K8S 方式管理存储，Docker 原生挂载卷操作了解即可，基础命令仍需掌握。
```bash
docker run -p 8888:80 -d -v /test:/aaa --name test centos:7 tail -f /dev/null
```
#### docker commit
`docker commit` 将**正在运行的容器整个 rootfs**（初始镜像的 `LowerDir` + 修改后的 `UpperDir`）导出为一个新镜像，用于把"装好软件/改好配置"的容器固化成定制镜像。
它与数据卷挂载的目的不同：  
- **docker commit**：导出整个文件系统状态，包含不必要的初始镜像内容，无法只保存部分关键数据。
- **数据卷挂载**：仅针对 `UpperDir` 中的部分关键数据做持久化，不导出整体文件系统。
因此，commit 适合"定制镜像"，挂载卷适合"持久化数据"，二者不可互相替代。更高效的定制镜像方式是用 **Dockerfile** 编写构建流程，而非手动 commit 这种"笨方法"（下载基础镜像 → 安装修改 → commit）


### 容器内网络
本质：四种模式 = 容器网络命名空间与宿主机网络栈的不同组合方式。
#### None模式
- 容器拥有独立网络命名空间，但**只有回环接口 `lo`**，无 eth0、无 IP。
- 无法访问外网，也无法被外部访问。
- 适合：完全不需要网络的隔离任务（批处理、敏感计算）。
- k8s中containerd创建 Pod 网络命名空间时就采用的None模式，后续CNI会填充这个网络名称空间，塞入veth，配ip等等
#### Bridge模式（默认）
- Docker 创建虚拟网桥（虚拟交换机） `docker0`，每个容器分配一对 veth 虚拟网卡：一端是容器内 `eth0`（分配 IP），另一端连上 `docker0`。
- **容器间通信**：经 docker0 二层直接互访，速度快。
- **访问外网**：经 iptables/nftables NAT把容器 IP 伪装成宿主机 IP。
- **暴露服务**：`-p 8080:80` 用 DNAT 把宿主机端口转发到容器。
- 优点：隔离好、可自定义网段；缺点：多一层转发，性能略低。
- **补充**：
  **veth 是什么**：veth pair = 一对连在一起的虚拟网卡，可看作一根"虚拟网线"，一端收的包必然从另一端出。Docker 为每个容器创建一对：宿主机侧叫 `veth+随机编号`（插在 docker0 上），容器侧叫 `eth0`。**同一根网线的两头，MAC 地址相同**。
  ```bash
  # 宿主机看 veth 接口
  ip link                    # veth9a2b3c4d@if3  ← @if3 是容器侧 eth0 的编号
  # 容器里找对端 veth 编号（sysfs，无需 ip 命令）
  cat /sys/class/net/eth0/iflink   # 12345（宿主机上 veth 的接口编号）
  # 宿主机按编号反查接口名
  ip -o link | awk -F'[ :]+' '$2==12345{print $2}'   # veth9a2b3c4d
  ```
  **数据包传递过程**：
  ```
  ① 容器A访问容器B：A进程 → A的eth0 → 虚拟网线 → vethA → docker0查转发表 → vethB → 网线 → B的eth0 → B进程
  ② 容器访问外网：容器 → eth0 → veth → docker0 → iptables NAT(MASQUERADE，源IP伪装成宿主机IP) → 物理网卡 → 外网
  ③ 外部访问容器(-p 8080:80)：外部 → 宿主机:8080 → DNAT(目标改写成172.17.0.x:80) → docker0 → veth → eth0 → 容器
  ```
  **tcpdump 抓包位置选择**：
  ```bash
  # 容器内抓 eth0（NAT 前，原始目标地址）——但精简镜像常无 tcpdump
  # 宿主机抓对应 veth（效果等同容器内，不用进容器）
  VETH=$(ip -o link | awk -F'[ :]+' '$2==$(cat /sys/class/net/eth0/iflink){print $2}')
  sudo tcpdump -i $VETH -nn
  # 宿主机抓 docker0：看到所有容器间流量；In=容器发出的包，Out=发给容器的包
  sudo tcpdump -i docker0 -nn
  # 宿主机抓物理网卡：看到 NAT 后流量（源 IP 已是宿主机 IP）
  sudo tcpdump -i eth0 -nn
  ```
  > 要点：NAT 前后源 IP 不同，想看清容器原始请求抓 veth/docker0，想确认外网链路抓物理网卡。
#### container模式
- 新容器与指定容器**共享同一个网络命名空间**：IP、MAC、端口完全一致。
- 彼此通过 `localhost` 即可访问。
- 适合：紧密协作的容器对（如 sidecar：日志采集、网络代理）。
- 命令：`--network container:<容器名>`
#### host模式
- 容器**直接使用宿主机网络命名空间**：没有独立 IP，直接用宿主机 IP 和端口。
- 优点：性能最好，无网桥/NAT 转发开销；缺点：端口易与宿主机冲突，隔离性最差。
- 命令：`--network host`


### dockerfile编写
```Dockerfile
ARG GO_VERSION=1.26
ARG GOPROXY=https://goproxy.cn,direct
ARG GOSUMDB=sum.golang.google.cn

FROM golang:${GO_VERSION} AS builder
ARG GOPROXY
ARG GOSUMDB
ENV GOPROXY=${GOPROXY} \
  GOSUMDB=${GOSUMDB}

WORKDIR /src/server

COPY server/go.mod server/go.sum ./
# target=/go/pkg/mod是容器内路径，挂载卷类型为缓存卷
# 缓存卷保存在本地机器某一个文件路径下，这样除了第一次构建后，每次构建时都可以复用前一次下载在本地的缓存卷（将缓存卷挂载到容器内指定路径）
RUN --mount=type=cache,target=/go/pkg/mod \
  go mod download

COPY server ./

#禁止调用c语言接口，让镜像更小
#-trimpath隐藏二进制文件中构建机器路径，(二进制文件中不止有机器码，还有字符串)，如/server/cmd/api。
#-ldflags 是传给 Go 链接器的参数，-s 和 -w 是去掉两类调试信息，让镜像更小
#go编译器就是把每一个go文件编译成机器码，然后go链接器，就把以main.go为中心，依次寻找每一个文件的引用，将它们都链接成一个可执行文件
ENV CGO_ENABLED=0
RUN --mount=type=cache,target=/go/pkg/mod \
  --mount=type=cache,target=/root/.cache/go-build \  
  #/out/api这种中间临时文件不手动删除，最终都是存留在构建机本地某处文件夹
  go build -trimpath -ldflags="-s -w" -o /out/api ./cmd/api
RUN --mount=type=cache,target=/go/pkg/mod \
  --mount=type=cache,target=/root/.cache/go-build \
  go build -trimpath -ldflags="-s -w" -o /out/worker ./cmd/worker

FROM alpine:3.21 AS base
RUN apk add --no-cache ca-certificates tzdata
WORKDIR /app
RUN mkdir -p ./.run/uploads

FROM base AS api
COPY --from=builder /src/server/configs /app/configs
COPY --from=builder /out/api /app/api
ENTRYPOINT ["/app/api"]

FROM base AS worker
RUN apk add --no-cache ffmpeg
COPY --from=builder /src/server/configs /app/configs
COPY --from=builder /out/worker /app/worker
ENTRYPOINT ["/app/worker"]
```
我们来看看这段dockerfile  
- ARG是构建参数的关键字，每一个FROM后面都是一个新世界，需要重新声明一下变量。  
- WORKDIR /src/server表示后续所有的操作都是在这个目录下进行
- RUN是在临时容器内运行的命令，每次RUN结束后，临时容器就销毁。
- 多次FROM即多阶段构建，这样可以大幅减少镜像体积，比如说构建go可执行文件需要下载go环境，但是构建完成后其实只需要可执行文件就行，多阶段构建只引用之前构建的有用的东西
- “COPY --from=builder /src/server/configs /app/configs”实际上最终的镜像也只会保存/app/configs这一份文件，最终阶段前构建的文件都会自动删除
- ENTRYPOINT ["/app/api"]表示用exec（shell的内置命令）的方式运行容器内的第一个进程，如果不采用[]形式，而是ENTRYPOINT /app/api那么会隐式地转交给shell解释器执行，第一个进程就是shell解释器。也可以ENTRYPOINT ["sh", "-c", "exec /app/api --port $PORT"]这样既可以用shell解释器能够执行的变量展开（比如$HOME），管道符，第一个进程又是/app/api。信号可以不经过shell解释器直达/app/api


## FAQ
### sh和bin/bash区别
bin/bash是/bin/sh的都是shell解释器，前者功能更强，支持更多灵活的语法，后者完全符合POSIX标准，可移植性强。  
POSIX（可移植操作系统接口）是一组由 IEEE 制定的操作系统标准化规范,目的是让程序可以在不同的 Unix 系操作系统之间方便地移植。
