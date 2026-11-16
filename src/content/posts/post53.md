---
title: BuildKit
published: 2026-11-15T20:11:23+08:00
description: 从 LLB 执行链路到 DinD/DooD 的安全边界，再到 CI 远程缓存、K8s 无守护构建、多架构与密钥挂载的生产落地
image: './images/a53.avif'
tags: [devops,docker]
category: '计算机技术'
draft: false
lang: '中文'
---


## 一、BuildKit 是什么

一句话：**Docker 的构建引擎**。它把 Dockerfile 编译成一张有向无环图（LLB），按依赖并行执行，产出 OCI 镜像。Docker Engine 23.0 起 `docker build` 默认就走它。

它不是一个命令，而是三件东西：

| 组件 | 角色 |
| --- | --- |
| `buildkitd` | 守护进程，真正干活：解析、调度、执行、存缓存 |
| `buildctl` | 原生客户端，直连 buildkitd 的 gRPC |
| `docker buildx` | docker CLI 插件，直接调 BuildKit 的 client 库（不经过 buildctl 二进制） |

## 二、先分清这几个角色谁调谁

很多人卡住，是因为把 "BuildKit"、"buildkitd"、"docker daemon" 混成一件事。实际是**两条互不相干的链路**，只在 `docker build` 这里交叉一次：

```text
① 运行容器：
docker CLI ──HTTP──> dockerd ──gRPC──> containerd ──> shim ──> runc ──> 容器进程

② 构建镜像：
                       ┌─ docker build        ──> dockerd 内嵌的 BuildKit（无独立进程）
构建请求 ──────────────┤
                       ├─ docker buildx build ──> buildx 插件 ──gRPC──┐
                       └─ buildctl ───────────────gRPC───────────────┴──> buildkitd ──> runc ──> 构建用临时容器
```

- **dockerd**：管镜像、网络、volume、API。它把容器生命周期甩给 containerd，containerd 再调 runc 真正 `clone()` 出进程。
- **BuildKit**：是一个库（Moby 项目），**buildkitd 只是它的独立进程形态**。`docker build` 用的 BuildKit 是**编译进 dockerd 里的**，所以宿主机上没有 buildkitd 进程，缓存也在 dockerd 的 data-root 下。
- **buildx**：只是个前端。它按 `--driver` 决定把构建请求发给谁：

| driver | 谁在执行构建 | 典型用途 |
| --- | --- | --- |
| `docker` | 复用 dockerd 内嵌的 BuildKit | 本地开发，零额外进程 |
| `docker-container` | buildx 起一个 `moby/buildkit` 容器 | CI，需要 `--cache-to`、多平台 |
| `remote` | 直连远端 buildkitd 的 gRPC（`tcp://host:1234`） | K8s 集群内的独立构建集群 |
| `kubernetes` | 在 K8s 里拉起 buildkitd Pod | 云原生 CI |

记住一条：**默认的 `driver=docker` 既不支持 `--cache-to`，也不支持多平台**。CI 里想用远程缓存，第一步就得换成 `docker-container`。

唯一的例外是 Engine 启用了 containerd image store（`/etc/docker/daemon.json` 里 `"features": {"containerd-snapshotter": true}`）：此时内嵌 BuildKit 走 containerd worker，docker driver 也能导缓存、构建多平台镜像。但生产构建节点极少这么配，按"不支持"记更安全。

## 三、它是怎么工作的

整条链路：

```text
Dockerfile → frontend(dockerfile.v0) → LLB DAG → solver → worker(runc) → snapshotter → exporter
```

1. **frontend 解析**：frontend 本身也是一个镜像（`docker/dockerfile:1`），把 Dockerfile 翻译成 LLB——一堆不可变的操作节点。
2. **solver 求值**：按 DAG 推进，互不依赖的阶段**并行**跑。老构建器是一条直线，多阶段构建里两个互不相干的基础镜像也只能排队。
3. **worker 执行**：每个 exec 节点 = 一个临时 OCI 容器（runc 启动，rootfs 是前面所有只读层叠出来的 overlay）。
4. **snapshotter 存层**：容器里产生的修改全部落在上层一个临时可写 diff；命令成功结束后，BuildKit 把这个 diff 打包成新的镜像层，然后销毁容器、扔掉临时可写层（只保留打包好的 layer）。
5. **exporter 决定结果往哪送**：构建结果不会自动落到任何地方，得由 exporter 指定去处——`type=image` 打成镜像（`push=true` 推到仓库，或 `load` 导入本地镜像列表）；`type=local` 把文件导出到本地目录（只想要编译产物时用）；`type=oci` 打成标准 OCI tar 包（离线拷贝、扫描用）；`type=cacheonly` 什么也不产出，只把缓存算出来（专门用来预热缓存）。

### buildkitd 里到底存了什么

上面那条链路里反复出现三个存储组件，容易混。其实就是三件事：

| 组件 | 存什么 | 干什么用 |
| --- | --- | --- |
| content store | 所有 blob：layer 的 tar、镜像 config、manifest | 按 sha256 内容寻址的仓库，天然去重；推拉镜像搬的就是这里的 blob |
| snapshotter（overlay） | 每层解压后的快照，以及 upper/lower/merged 的挂载视图 | 给 exec 容器准备 rootfs，RUN 实际跑在 merged 上 |
| cache index | DAG 节点 key → 结果 digest 的映射表 | 判断这条指令能不能直接跳过；命中就不执行 |

一句话串起来：**cache index 决定跳不跳，content store 提供层的内容，snapshotter 提供跑命令的工作台。**

它们存在哪？**buildkitd 进程在哪，这些数据就在哪。**

| 部署形态 | 落盘位置 | 容器 / Pod 删掉后 |
| --- | --- | --- |
| 裸机装 buildkitd | `/var/lib/buildkit` | 不受影响 |
| 容器里跑，用 emptyDir | buildkitd 容器的文件系统 | 直接消失 |
| 容器里跑，挂 PVC | PVC | 还在 |
| `docker build`（内嵌形态） | dockerd 的 data-root（`/var/lib/docker/buildkit`） | 跟 dockerd 一起没 |

请注意：dockerfile种的一些挂载，比如cache mount还是upperdir,lowerdir，以及他们diff产生出来的新的layer（lowerdir）,数据都存在snapshotter里面，但是挂载的数据实际上真正写入的文件夹是和upperdir所在的文件夹不一样的，这也就是为什么挂载的数据不会与lowerdir进行diff，最终变成不了blob，被装进content store，然后推送道harbor仓库。

## 四、一条 RUN 到底发生了什么

以 `RUN npm run build` 为例：

1. **准备 rootfs**：把前面所有层按顺序叠成 overlay 的 `lowerdir`（只读），再新建一个空的 `upperdir`。
2. **起临时容器**：runc 启动容器，`merged` 目录就是它的 `/`。
3. **执行命令**：采用 `COW` 对 `upperdir` 进行写入。
4. **容器退出**：对 `upperdir` 做 diff（本质是与空基线比较），把筛选出来的差异文件打包成一个 tar blob，就是**新 layer**，落进本地 content store。
5. **算 digest**：tar 的 sha256 就是这个 layer 的 digest，本地按 `blobs/sha256/<digest>` 存放，文件名即内容哈希。
6. **销毁**：临时容器和它的 `upperdir` 一起删掉。layer 留在 content store 里，至于要不要推到 Harbor，是下一步的事——由 exporter（`type=image,push=true`）推镜像层，或由 `--export-cache` 推缓存元数据，**这两件事别混**。

## 五、镜像到底在哪里构建

### 5.1 Docker-out-of-Docker（DooD）

容器里只装 CLI，把宿主机的 socket 挂进去。它是**宿主机 Docker 的 Unix 域套接字**，它是 Docker daemon 的入口；你把它挂载进容器，**容器里的 docker CLI 不是在调用容器内部的 docker，而是直接调用宿主机节点上的 dockerd（root 进程）**

```bash
docker run -v /var/run/docker.sock:/var/run/docker.sock docker:cli docker ps
```

**为什么这是安全隐患，拿 Jenkins 举例：**

一个挂载了 `docker.sock` 的 Jenkins Agent，实际上是把这个节点的全部控制权暴露给了流水线脚本。而流水线脚本（Jenkinsfile）是由开发者提交到仓库里的：

```groovy
// 一个"正常"的 Jenkinsfile，或者一个恶意 PR 里的 Jenkinsfile，将启动容器的CLI命令直接发给宿主机的dockerd（具有root权限），将根目录挂载到容器，等于给容器敞开宿主机全部文件；只要能读就能偷凭证，只要能写就能留后门，拿下节点控制权。
sh 'docker run --rm -v /:/host alpine chroot /host cat /var/lib/kubelet/kubeconfig'
```
**补充**：与DOOD相对的是DinD策略，它是在容器内部再创建一个dockerd，自己管理镜像、容器、网桥、网络，而启动这个容器需要```--privileged```获取特权，例如：
1. 创建 cgroup、设置资源限制  
2. 创建 network namespace、网桥、iptables  
劣势：  
- 一旦发生容器逃逸，由于具有特权，攻击者可以直接控制宿主机
- 多跑一个 dockerd 进程，额外占用 CPU、内存

### 5.2 构建镜像的权限安全

Jenkins Agent 挂 socket 的原因不是"它是 Jenkins"，而是**流水线里写的是 `docker build`**：容器里的 CLI 找不到 dockerd，只能借宿主机的 socket。

反过来也成立：Jenkins Agent 里装 `buildctl` 连远端 buildkitd，一样不需要 socket；Tekton 里如果有人写 `docker build`，一样得挂 socket 或起 DinD。**绑定关系在命令，不在平台。**

**Tekton + BuildKit 为什么不需要**：因为 buildkitd 自己就是那个干活的 daemon。

```text
buildctl(BuildKit 原生客户端) / buildx(Docker 封装的上层插件，包装了 buildctl 的能力) ──gRPC──> buildkitd(构建服务) ──> runc ──> 构建用临时容器
                                ├──> snapshotter（落层）
                                └──> content store / exporter
```

它直接调 runc 起构建容器、用 snapshotter 记录层、把结果交给 exporter，全程不经过 dockerd，也就不存在"socket 入口"这回事。。

**不需要 socket ≠ 不需要权限**。socket 交出去的是 daemon API，等价于节点 root；rootless buildkitd 交出去的是 Pod 内的 user namespace、`/dev/fuse`、unshare()，逃逸边界是 Pod 里的 uid 1000。

最容易被忽略的是第三种情况：**非 rootless 的 buildkitd 依然是特权容器**，和 DinD 一个量级，只是换了个进程名字。所以 daemonless 不是安全标签，**rootless 才是**。

| 项目 | privileged DinD | rootless buildkitd |
| --- | --- | --- |
| 运行身份 | Pod 内真实 root | Pod 内 uid=1000，user ns 内映射为 root |
| overlay 实现 | 内核原生 overlayfs | 内核原生 overlay（kernel ≥ 5.11）或 fuse-overlayfs 兜底 |
| 需要 CAP_SYS_ADMIN | 需要 | 不需要 |
| 逃逸上限 | 宿主机节点 root | 最多 Pod 权限，无法直接节点逃逸 |
| 性能 | 快 | 略慢，fuse-overlayfs 下更明显 |

### 5.3 tekton task中的镜像构建部分
#### 回顾pod
首先回顾一下一个pod中的容器有哪些是资源是共用的：  
- **Network namespace**：网卡、Pod IP、端口、路由、iptables、socket。step1 监听端口，同 Pod 别的 step 可以通过 `localhost` 访问。
- **IPC namespace**：共享内存、消息队列、信号量
- **pause 容器**：上面两个 namespace 由 pause 持有，所有 step 容器加入 pause 的这两个 ns。
- **存储卷（Volume）**：`emptyDir`、PVC、ConfigMap、Secret、Tekton Workspace。  ⚠️ 注意：卷是**分别挂载到每个容器各自独立的 mount namespace 里**，不是共享 mount ns；只是后端存储介质是同一份。   

哪些是每个容器独有的呢：  
- **PID namespace**: 不同 PID ns 里看到的 PID 编号是独立的；一个 ns 里看不到另一个 ns 的进程列表。宿主机上一个真实进程 PID=12345，放到新 PID ns 里面可以变成 PID=1。(`unshare(CLONE_NEWPID)` / `clone(CLONE_NEWPID)` 创建新 PID namespace。)  
- **Mount namespace**:  `unshare(CLONE_NEWNS)` 创建新 mount namespace。每个 mount ns 拥有一套独立的 `/` 根文件系统视图、独立的挂载点列表。
- **User namespace**: 隔离用户 ID、组 ID 映射,典型 rootless buildkit：宿主机侧 uid=1000 → 在 user ns 里面映射成 uid=0（虚拟 root）。`unshare(CLONE_NEWUSER)` 创建 user namespace。然后向 `/proc/<pid>/uid_map`、`/proc/<pid>/gid_map` 写入映射规则。内核转换权限校验：  
- 在 ns 内写文件、检查权限，用 ns 内的 uid；
- 落到宿主机磁盘上，转换成外部真实 uid。
>Tekton step 容器默认各自独立 user ns；buildkitd 还会在 step 容器内部再开一层 user ns，用来做 fuse-overlay。

#### Buildkit构建镜像
```text
kubelet 起 step-build 容器（runAsUser=1000 / seccomp=Unconfined / 挂 /dev/fuse）
  └─ entrypoint: buildctl-daemonless.sh build --frontend dockerfile.v0 ...
       ├─① 后台拉起 buildkitd（此时只是一个 uid=1000 的普通进程）
       │    └─ rootless 初始化：进新 user ns（1000 → ns 内 0）→ 进新 mount ns
       │       → 初始化 snapshotter → 监听 unix socket
       ├─② 轮询 socket 就绪 → buildctl 走 gRPC 连上
       ├─③ buildctl 发出 Dockerfile + context（--local .）→ frontend 编译成 LLB
       ├─④ solver：拉基础镜像 → 解压进 snapshotter → 查 cache index 决定跳不跳
       ├─⑤ 逐条执行 RUN（fork + chroot，不建 runc 沙箱）
       │    └─ 每条结束：diff upper → 打 tar → 算 sha256 → 落 content store
       ├─⑥ exporter：拼 manifest/config → 直连 Harbor 推 blob
       └─⑦ 退出码返回脚本 → 杀掉 buildkitd → step 容器退出 → Tekton 收尾
```

**① buildkitd 以非 root 身份起来**。`buildctl-daemonless.sh` 是镜像里的包装脚本，职责就三件：起 `buildkitd`、等它的 socket、构建完杀掉它。关键是 `buildkitd` 以 uid 1000 启动时拿不到 `CAP_SYS_ADMIN`，**必须先把自己关进一个 user namespace**（镜像里的 `rootlesskit` 或内建 re-exec 负责这一步，`uid 1000` 在 ns 内映射为 `uid 0`），否则后面任何 `mount` 都会 `EACCES`。这一步成功与否，就是 5.5 里那些前置条件（userns 是否被禁、AppArmor 是否放行、seccomp 是否拦了 `unshare`）的落点。

**② socket 就绪与客户端连接**。rootless 下 socket 在 `$XDG_RUNTIME_DIR/buildkit/buildkitd.sock`（通常是 `/run/user/1000/buildkit/buildkitd.sock`），不是 rootful 的 `/run/buildkit/buildkitd.sock`——手工调试时 `--addr` 连错是最常见的"连不上"。脚本会轮询到这个文件出现再执行 `buildctl`，所以 `failed to dial` 一般发生在"buildkitd 起来了但立刻退出"，去翻 daemonless 脚本转发的 daemon 日志。

**③ frontend 解析**。`buildctl` 通过 gRPC 把 Dockerfile 与 `--local context=.` 指定的上下文一并交给 buildkitd；`dockerfile.v0` frontend 把它翻译成 LLB DAG。注意上下文是**由客户端读取并流式上传**的，`.dockerignore` 在客户端侧生效，因此大量无用文件会直接拖慢这一跳。

**④ solver 求值与镜像拉取**。这一阶段全部发生在 buildkitd 进程内：
- 拉基础镜像走**容器自己的网络命名空间**，即 Pod IP，不经过任何 daemon；私有 Harbor 的凭证读 `~/.docker/config.json`（rootless 下是 `/home/user/.docker/config.json`，不继承宿主 `docker login`）；
- 拉下来的 layer 先解压成 snapshot：kernel ≥ 5.11 用 userns 内的内核 overlay，否则退回 fuse-overlayfs（这就是 `/dev/fuse` 的用途）；
- 每个节点算 cache key 查 cache index，命中直接复用已有 snapshot，**命中时连进程都不会起**。

**⑤ 执行一条 RUN（rootless 与 rootful 的最大差异）**。rootful 走 runc：新建 pid/mount ns、建 cgroup、起一个独立容器。rootless 下这条路代价太高（相当于把 5.3 讨论的创建容器特权又搬回来一层），所以官方写法是 `--oci-worker-no-process-sandbox`：

```text
rootful：   buildkitd → runc → 新 pid+mount ns → chroot → exec 命令
rootless：  buildkitd → fork（沿用 buildkitd 的 ns）→ chroot 到 merged → exec 命令
```

执行体感上等价，隔离强度差一档：**RUN 之间不再有 pid/mount ns 边界**，上一条命令残留的进程、挂进来的 secret，下一条都看得见（5.5 已列为代价）。具体每条的流程仍是第四章那五步：叠 lowerdir → 空 upperdir → COW 写入 → diff 打包成 blob → 销毁可写层。cache mount 则挂在 snapshotter 管理的独立目录上，**不参与上层 diff**，所以永远进不了 content store。

**⑥ exporter 推送**。`--output type=image,push=true` 时，buildkitd 在进程内组装 config / manifest list，然后**直接用 HTTP 把 blob 推到 Harbor**——同样不经过 dockerd。`--export-cache type=registry,mode=max` 是第二条独立的推送通道：把每一层（含中间层）的缓存元数据打成另一个镜像 tag 推上去，两者别混。

**⑦ 收尾**。`buildctl` 打印退出码 → daemonless 脚本杀掉 buildkitd → step 容器的 entrypoint 把退出码经由 Tekton 的 termination message 交回 kubelet → Pod 内下一个 step 启动或整个 TaskRun 判失败。**state 目录（`~/.local/share/buildkit`）随容器一起消失**，所以下一节说的 registry cache 不是优化项。

三个由 rootless 派生的实操限制：

| 你会想做的事 | rootless 下的结果 | 正确做法 |
| --- | --- | --- |
| `--output type=docker` / `--load` 导入本地镜像库 | 没有本地镜像库可导（那是 dockerd 的东西） | `push=true`，或 `type=oci` / `type=local` 落文件 |
| 用 `docker images` 看构建结果 | step 里根本没装 docker CLI | `crane/regctl` 查远端 tag，或看 tracker 记录的 digest |
| 构建中途 `docker exec` 进构建容器排查 | 构建容器不存在（没有 runc 容器，只有一个 fork 出来的进程） | `--progress=plain` 看日志，必要时临时去掉 `no-process-sandbox`（会失去 rootless 主体收益） |


## 六、生产环境种其余五个高频场景

### 6.1 CI/CD 远程缓存共享

CI 构建节点（GitLab Runner、GitHub Actions、Jenkins Agent、Tekton TaskRun）都是临时的、无状态的，`/var/lib/buildkit` 每次归零。BuildKit 的解法是把缓存**导出到镜像仓库**，下次构建再导回来。

先分清两条缓存通道，否则 Dockerfile 一定写错：

| 通道 | 存在哪 | 能否跨节点 | 进镜像 |
| --- | --- | --- | --- |
| 镜像层（registry cache） | 仓库里的一个 cache tag | 能，`--cache-to` / `--cache-from` 干的就是这个（buildctl 里叫 `--export-cache` / `--import-cache`） | 就是镜像层本身 |
| cache mount | buildkitd 的 state 目录 | **不能**，`export-cache` 不会带走它 | 不进 |

结论只有一句：**要跨节点复用的东西必须落进层，只想省编译时间的才用 cache mount。**

Tekton Task 里跑 rootless BuildKit + registry cache：

```yaml
apiVersion: tekton.dev/v1
kind: Task
metadata:
  name: build-image
spec:
  params:
    - name: image
    - name: cacheRef
  workspaces:
    - name: source
  steps:
    - name: build
      image: moby/buildkit:rootless
      workingDir: $(workspaces.source.path)
      env:
        - name: BUILDKITD_FLAGS
          value: --oci-worker-no-process-sandbox
      securityContext:
        runAsUser: 1000
        runAsGroup: 1000
        seccompProfile: { type: Unconfined }
      script: |
        #!/usr/bin/env sh
        set -eu
        buildctl-daemonless.sh build \
          --frontend dockerfile.v0 \
          --local context=. --local dockerfile=. \
          --import-cache type=registry,ref=$(params.cacheRef) \
          --export-cache type=registry,ref=$(params.cacheRef),mode=max \
          --output type=image,name=$(params.image),push=true
```

每个 TaskRun 是一个新 Pod，`buildctl-daemonless.sh` 每次 fork 一个全新 buildkitd，state 目录从零开始，只有 registry cache 能跨 Pod 存活。所以 `--import-cache` 不是优化项，是必填项。

对应的 Dockerfile 长这样：

```dockerfile
# syntax=docker/dockerfile:1
FROM --platform=$BUILDPLATFORM golang:1.23 AS builder
WORKDIR /src

COPY go.mod go.sum ./
# 不要加 --mount=type=cache：依赖必须落进这一层，
# registry cache（mode=max）才能把它导出到 Harbor，换节点、换流水线时直接复用。
RUN go mod download

COPY . .
# 只保留 go-build 的 cache mount：编译中间产物不落进镜像层，
# 避免 registry cache 被 Go build cache 撑大。
RUN --mount=type=cache,target=/root/.cache/go-build \
    go build -o /out/app ./cmd/app
```

剩下的实践：

- **CI 里 `mode=max` 直接写死**：除非确认构建是单阶段且不装依赖，否则默认的 `min` 就是让 builder 白干。
- **cache 用独立 tag**（如 `app:buildcache`），别混在业务 tag 上；Harbor 侧配保留策略，`mode=max` 会持续吃容量。
- **认证要给到 buildkitd**：`--import-cache` / `--export-cache` 同样要登录仓库，rootless 不继承宿主 `docker login`，把 `config.json` 挂到 `/home/user/.docker/`。

**生产上怎么定策略**：先看构建节点有没有持久盘，再决定主力和兜底。

| 构建节点 | 主力手段 | registry cache 的角色 |
| --- | --- | --- |
| 每次新 Pod（Tekton TaskRun、GitHub-hosted、GitLab SaaS） | registry / gha cache | 唯一手段 |
| 固定 Agent（长期跑的 Jenkins、裸机） | cache mount | 兜底，换节点时才用得上 |
| K8s buildkitd + PVC | cache mount（热路径） | 冷启动兜底 |

不管哪种形态，Dockerfile 都按「同一路径二选一」来写：

- **依赖路径**（`/go/pkg/mod`、`~/.m2`、`node_modules`）：要么落层，要么挂 mount，不要两个都想要。cache mount 是**空目录覆盖挂载**，会把镜像里同路径已有的内容全遮掉——依赖装在前一层、这一层又挂了 mount，构建会突然报"找不到包"；同时这一段产生的层差异也是空的，registry cache 永远命不中。
- **编译缓存路径**（`/root/.cache/go-build`、`target/`）：只挂 mount，永不进层。它的体量和碎片化程度不配占用 Harbor 的容量。

运营上还有三件事：

- **cache tag 按分支隔离 + fallback**：`app:cache-<branch>`，拉不到再回退 `app:cache-main`。共用一个 tag 会互相覆盖，命中率断崖。
- **定时预热**：用 `--output type=cacheonly` 只跑缓存不推镜像，让主干分支的 cache 始终新鲜，避免第一个合并的人承担全量构建。
- **量化命中率**：`--progress=plain` 里每条 `CACHED` 就是命中。命中率低于 70% 就别再调参数了，去查层序和 `COPY` 范围。

### 6.2 

### 6.3 安全注入敏感凭证

私有 npm、Maven 源、私有 git 仓库，传统做法是 `ARG NPM_TOKEN` 或 `COPY .npmrc`——结果密码明晃晃躺在镜像 config 的 history 里，`docker history --no-trunc` 一眼看穿。

```dockerfile
# syntax=docker/dockerfile:1
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc \
    npm ci --registry=https://npm.internal/

RUN --mount=type=ssh,id=default \
    git clone git@github.com:company/private-repo.git /src
```

```bash
docker buildx build \
  --secret id=npmrc,src=$HOME/.npmrc \
  --ssh default=$SSH_AUTH_SOCK \
  -t app .
```

- secret 以 **tmpfs 内存挂载**的形式只在这条 RUN 期间存在，指令结束即销毁。不进层、不进 history、不进缓存、不落盘。
- 三个常见坑：
  - **secret 内容不参与 cache key**：改了密码不会让缓存失效，可能拿到用旧凭据构建出来的层。换密钥后要主动 `--no-cache` 或 bump cache bust。
  - **`COPY . .` 把 `.npmrc`、`id_rsa` 拷进镜像**，secret 白用了。`.dockerignore` 必须先挡住。
  - **忘了 `# syntax=docker/dockerfile:1`**，老 frontend 不认 `--mount`，报 `unknown flag: mount`。
- `--ssh` 依赖 ssh-agent 转发，CI 里就是 `eval $(ssh-agent) && ssh-add`；能换成 deploy token + secret 的场景就别用 SSH。

### 6.4 持久化缓存挂载加速编译



### 6.5 多架构构建

只有两条路，选错了就会在"为什么构建要 20 分钟"上白烧一周：

| 方式 | 怎么跑 | 代价 |
| --- | --- | --- |
| QEMU 模拟（binfmt） | 在 amd64 节点上直接执行 arm64 指令 | 慢 5–20 倍，Go/C++ 编译尤其惨 |
| 原生节点 | 各架构节点各跑一遍，最后合并 manifest | 要有异构节点，但速度是真实的 |

不管走哪条，Dockerfile 的原则都一样：**编译阶段留在 `$BUILDPLATFORM`，只有最终产物落 `$TARGETPLATFORM`**。

```dockerfile
# syntax=docker/dockerfile:1
FROM --platform=$BUILDPLATFORM golang:1.23 AS builder
ARG TARGETOS TARGETARCH
RUN GOOS=$TARGETOS GOARCH=$TARGETARCH go build -o /out/app ./cmd/app

FROM --platform=$TARGETPLATFORM alpine:3.20
COPY --from=builder /out/app /usr/local/bin/app
```

- `$BUILDPLATFORM` 是本机架构，编译在本机跑、交叉输出目标架构的二进制；`$TARGETPLATFORM` 才是产物镜像的架构。这两个写反，就等于"在 QEMU 里跑 arm64 的 `go build`"，时间直接翻十倍。
- 多平台**必须 `--output type=image,push=true`**：`--load` 和 `type=oci` 只能出单平台，本地镜像库放不下 manifest list。
- CI 里的完整写法：

```bash
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  --import-cache type=registry,ref=$CACHE_REF \
  --export-cache type=registry,ref=$CACHE_REF,mode=max \
  --output type=image,name=$IMAGE,push=true .
```

需要本地跑一个跨架构镜像验证时，再装 binfmt：`docker run --privileged --rm tonistiigi/binfmt --install all`。它是**节点级**的内核注册，镜像里装没用。

## 七、故障排除

### 先看三个命令

```bash
docker buildx build --progress=plain .   # 看真实输出，默认的进度 UI 会吞掉细节
buildctl debug workers                   # worker 是否就绪、用的是哪个 snapshotter
buildctl du -v                           # 缓存占了多少盘，谁占的
```

### 常见报错对照表

| 现象 | 根因 | 处理 |
| --- | --- | --- |
| `failed to dial gRPC: connection closed` / `deadline exceeded` | buildkitd 没起、端口不通、或 mTLS 证书不匹配 | 查 `kubectl logs`、`ss -lntp \| grep 1234`；`remote` driver 检查证书 |
| Job 一直挂到超时 | `moby/buildkit` 镜像默认 entrypoint 会跑成常驻 daemon | `entrypoint: [""]` |
| `operation not permitted`、`failed to mount` | rootless 前置条件不满足 | 查 `sysctl kernel.unprivileged_userns_clone`、`ls /dev/fuse`、Ubuntu 24.04 的 AppArmor userns 限制 |
| `failed to authorize` / `401` | rootless 不继承 `docker login` | 手写 `~/.docker/config.json`，CI 里在 `before_script` 生成 |
| `x509: certificate signed by unknown authority` | 私有 Harbor 自签 CA | `buildkitd.toml` 里配 `[registry."host"] ca=[...]`，并设 `SSL_CERT_FILE` |
| 缓存完全不命中 | 层序错、`COPY` 了会变的文件、`mode=min`、或换了 driver | 先确认用的是 `docker-container` driver，再 `--progress=plain` 找第一个 cache miss 的指令 |
| `no space left on device` | buildkitd state 目录撑满 | `buildctl du -v` 定位，`buildctl prune`；state 放到独立盘 |
| `exec format error` | 多架构没注册 binfmt | `tonistiigi/binfmt --install all` |
| `Cannot connect to the Docker daemon`（DinD/DooD） | `DOCKER_HOST`、TLS 证书没配 | `DOCKER_HOST=tcp://docker:2376` + `DOCKER_TLS_VERIFY=1` + `DOCKER_CERT_PATH` |
| `unknown flag: mount` | frontend 版本太老 | Dockerfile 首行加 `# syntax=docker/dockerfile:1` |
| 卡在拉基础镜像 | 没配镜像加速 | `buildkitd.toml` 里配 `[registry."docker.io"] mirrors=[...]` |
| `--cache-to` 报不支持 | driver 是 `docker` | 换成 `--driver docker-container` |

### 排错的思路

BuildKit 的报错基本分四类，按这个顺序看就不会乱：

1. **连不上**——客户端和 buildkitd 之间的问题（gRPC、认证、证书）。
2. **跑不动**——worker 和内核之间的问题（namespace、fuse、seccomp、磁盘）。
3. **跑出来不对**——Dockerfile 和 cache key 的问题（层序、上下文、frontend 版本）。
4. **推不出去**——exporter 和目标仓库之间的问题（认证、CA、网络）。

绝大多数"玄学缓存不命中"，最后都归结到第 3 类：某一行 `COPY` 把整个仓库目录当上下文，或者 `ARG` 放在 `FROM` 之前而值每次都不一样。

## 八、怎么选

判断只有一个维度：**构建节点是否持久**。

- **持久**（本地开发、固定 Runner、K8s + PVC）：cache mount 当热路径，registry cache 兜冷启动和换节点。
- **不持久**（Tekton TaskRun、GitHub-hosted、GitLab SaaS）：registry cache 是唯一活路，`mode=max` 必开，`--import-cache` 和 `--export-cache` 都别省。
- **构建环境**：DinD 拿特权换隔离，DooD 拿 socket 换便利，两者本质都是把节点 root 交给构建代码。新部署一律 rootless buildkitd——一次性的部署成本，远低于一次供应链事故。
