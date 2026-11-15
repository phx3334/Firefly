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

到这一步才真正进入生产环境的坑区。要在容器里构建镜像，历史上只有两条路（DinD、DooD），现在多了第三条（daemonless）。三条路的差别不在你敲什么命令，而在**谁真正执行构建**——把这一点想清楚，后面的取舍都是推论。

### 5.1 Docker-in-Docker（DinD）

在容器里跑一个完整的 dockerd。

```bash
docker run --privileged -d --name dind \
  -e DOCKER_TLS_CERTDIR=/certs \
  -v dind-certs:/certs/client \
  docker:dind
```

- **为什么必须 `--privileged`**：容器里的 dockerd 还要 mount overlayfs、写 iptables、建 cgroup、管设备节点。这些操作对普通容器是被内核挡住的。
- **代价**：嵌套 overlay 通常不可用，退回 `vfs`（每层全量复制，又慢又占盘）或 `fuse-overlayfs`。镜像缓存层也在这个临时 daemon 里，容器一删全部归零。
- **好处**：每个 Job 一个干净的 daemon，镜像、容器、网络全隔离，不会互相踩。

### 5.2 Docker-out-of-Docker（DooD）

容器里只装 CLI，把宿主机的 socket 挂进去。

```bash
docker run -v /var/run/docker.sock:/var/run/docker.sock docker:cli docker ps
```

这里起出来的容器是**宿主的兄弟**，不是子容器——这就是"sibling containers"的由来。

**为什么这是安全隐患，拿 Jenkins 举例：**

一个挂载了 `docker.sock` 的 Jenkins Agent，实际上是把这个节点的全部控制权暴露给了流水线脚本。而流水线脚本（Jenkinsfile）是由开发者提交到仓库里的：

```groovy
// 一个"正常"的 Jenkinsfile，或者一个恶意 PR 里的 Jenkinsfile
sh 'docker run --rm -v /:/host --privileged alpine chroot /host cat /root/.ssh/id_rsa'
sh 'docker run --rm -v /:/host alpine chroot /host cat /var/lib/kubelet/kubeconfig'
```

注意，这条命令**不需要 `--privileged` 就能执行**，因为在宿主机上 docker 是以 root 起容器的，你请求的 `/` 会被老老实实挂到容器里。拿到节点 root 之后：

- 读走 SSH 私钥、kubelet kubeconfig、云厂商 metadata 里的临时凭证
- 写 `/etc/cron.d/` 或者 systemd unit 做持久化
- 从节点横向打内网、打镜像仓库，甚至推到生产集群

**这不是理论风险**：任何能提 MR 的人、任何能改 `Jenkinsfile` 的人、任何能改构建脚本依赖的人，都自动获得了节点 root。挂了 socket 就等于把 root 权限授给了所有代码提交者。

除了安全，还有运维代价：

- 并发构建互相踩：`docker tag` 冲突、有人跑 `docker system prune -af` 把别人刚推的镜像删了
- 构建产物持续堆在宿主机，磁盘打满没人认领
- 节点上的 Docker 版本被一个团队的构建需求绑架

那为什么还在用？因为**快**：不用起新 daemon，基础镜像的层可以跨构建复用。很多老 Jenkins 就是这么长出来的。

### 5.3 特权容器到底给了什么

```bash
docker run --privileged ...
```

| 维度 | 默认 | `--privileged` |
| --- | --- | --- |
| Capabilities | 有限集合（`CAP_NET_BIND_SERVICE` 等十几个） | 全部 capability |
| seccomp | 默认 profile 是黑名单，显式拒绝约 44 个 syscall，其余放行 | unconfined |
| AppArmor / SELinux | 默认策略 | unconfined |
| 设备访问 | 只映射少量 `/dev` 节点 | 全部宿主设备 |
| `/proc`、`/sys` | 大部分只读或已屏蔽 | 可写 |
| cgroup | 只读 | 可写 |

结论：`--privileged` 不是"多给一点权限"，而是**把所有边界一次性拆掉**。所以"为了跑 DinD 加个 `--privileged`"，本质是把宿主机 root 交给了这层容器。CI 里这么写，等于把节点 root 交给了每一个能改 Dockerfile 的人。

### 5.4 为什么 Jenkins 要 socket，Tekton 不要

这是整篇文章里最容易被误读成"平台差异"的一点。真正的分界线不是 CI 系统，而是**谁在执行构建**。

socket 是"客户端找 daemon"的产物。`docker` CLI 自己不会构建，它只是 API 客户端，必须找一个 daemon 替它干活。所以要不要 socket，取决于你敲的是哪条命令：

| 命令 | 谁在执行构建 | 需要 docker.sock |
| --- | --- | --- |
| `docker build` | 宿主 dockerd 内嵌的 BuildKit | 要 |
| `docker buildx build`（docker driver） | 同上 | 要 |
| `docker buildx build`（docker-container driver） | buildx 先通过 dockerd 起一个 buildkitd 容器 | 要（起容器那一步） |
| `docker buildx build --driver remote` | 远端 buildkitd | 不要 |
| `buildctl` / `buildctl-daemonless.sh` | buildkitd 自己 | 不要 |

Jenkins Agent 挂 socket 的原因不是"它是 Jenkins"，而是**流水线里写的是 `docker build`**：容器里的 CLI 找不到 dockerd，只能借宿主机的 socket。

反过来也成立：Jenkins Agent 里装 `buildctl` 连远端 buildkitd，一样不需要 socket；Tekton 里如果有人写 `docker build`，一样得挂 socket 或起 DinD。**绑定关系在命令，不在平台。**

**Tekton + BuildKit 为什么不需要**：因为 buildkitd 自己就是那个干活的 daemon。

```text
buildctl / buildx ──gRPC──> buildkitd ──> runc ──> 构建用临时容器
                                ├──> snapshotter（落层）
                                └──> content store / exporter
```

它直接调 runc 起构建容器、用 snapshotter 记录层、把结果交给 exporter，全程不经过 dockerd，也就不存在"socket 入口"这回事。

Tekton 只是提供了跑它的地方：每个 TaskRun 是一个 Pod，`buildctl-daemonless.sh` 在 Pod 里 fork 一个 buildkitd，buildctl 通过 buildkitd 自己的 unix socket 连它，构建完进程退出、Pod 销毁。

**不需要 socket ≠ 不需要权限**。socket 交出去的是 daemon API，等价于节点 root；rootless buildkitd 交出去的是 Pod 内的 user namespace、`/dev/fuse`、unshare，逃逸边界是 Pod 里的 uid 1000。

最容易被忽略的是第三种情况：**非 rootless 的 buildkitd 依然是特权容器**，和 DinD 一个量级，只是换了个进程名字。所以 daemonless 不是安全标签，**rootless 才是**。完整对照见 5.6。

还有一条对称风险：`buildx --driver kubernetes` 也不需要 socket，但需要 **kubeconfig**——那是集群 API 凭证，能用 RBAC 收窄，但绝不是"无凭证"。判断安全边界看的是**凭证能干什么**，不是它长什么样。

### 5.5 Rootless：daemonless 为什么安全

Daemonless 之所以安全，核心在于 rootless 本身。原理是一条命名空间链：

```text
你的用户 (uid=1000)
  └─ rootlesskit  →  新建 user namespace，ns 内 uid=0 映射到宿主的 uid=1000
       └─ buildkitd  （ns 内是 root，宿主视角只是一个普通用户）
            └─ runc  →  构建用的临时容器
```

所以构建容器里 `id` 显示 `uid=0(root)`，但在宿主机上它只是 uid 1000，**拿不到宿主 root**。真被逃逸，也只能动这个普通用户能碰的东西。

代价和前置条件必须说清楚：

- **存储**：普通用户不能在 user namespace 里 mount 内核 overlayfs，所以要用 `fuse-overlayfs` 或 native snapshotter，**必须有 `/dev/fuse`**。
- **网络**：走 slirp4netns 之类的用户态转发，带宽和延迟都比 host 网络差，大依赖下载会明显变慢。
- **关键 flag**：`--oci-worker-no-process-sandbox`。rootless 下再套一层 runc 的 process sandbox 需要额外权限，这个 flag 把它关掉——构建容器和 buildkitd 共享命名空间，隔离度降低，但**仍然不是 root**。
- **内核开关**：`kernel.unprivileged_userns_clone=1`（Debian 系）、`user.max_user_namespaces > 0`。Ubuntu 24.04 起还有 AppArmor 对 unprivileged userns 的限制（`kernel.apparmor_restrict_unprivileged_userns`），这是最容易漏的一个坑。

`buildkitd.toml` 对应写法：

```toml
[worker.oci]
  noProcessSandbox = true
```

GitLab CI 里最省事的写法是用 `buildctl-daemonless.sh`，它会 fork 一个 buildkitd、构建完就退出：

```yaml
build-rootless:
  image:
    name: moby/buildkit:rootless
    entrypoint: [""]          # 必须覆盖，否则 job 会跑成常驻 daemon 直到超时
  variables:
    BUILDKITD_FLAGS: --oci-worker-no-process-sandbox
  script:
    - buildctl-daemonless.sh build \
        --frontend dockerfile.v0 \
        --local context=. --local dockerfile=. \
        --output type=image,name=$CI_REGISTRY_IMAGE:$CI_COMMIT_SHA,push=true
```

注意：rootless 用的是容器内的 home 目录，**不继承宿主机的 `docker login`**，registry 认证要自己写 `~/.docker/config.json`。

### 5.6 三种形态怎么选

| 形态 | 谁在执行 | 拿到什么权限 | 逃逸边界 | 缓存 / 首次构建 | 典型场景 |
| --- | --- | --- | --- | --- | --- |
| DooD | 宿主 dockerd | daemon API（socket） | **节点 root** | 快，宿主层天然复用 | 单机开发、老 Jenkins |
| DinD | 容器内的 dockerd | 全部 capability + 全部设备（`--privileged`） | **节点 root** | 慢（vfs、缓存随容器销毁） | GitLab Runner `dind` service |
| Daemonless（rootless） | 独立 buildkitd | Pod 内 userns、`/dev/fuse` | Pod 内 uid 1000 | 快，但要自己配 cache mount / registry cache | 生产 K8s、多租户 CI |
| Daemonless（非 rootless） | 独立 buildkitd | 全部 capability + 设备 | **节点 root** | 快 | 不建议，等价 DinD |

表里看不出来的三件事：

- **改造成本**：DooD 挂个 volume 就完事；daemonless 要准备镜像、securityContext、state 目录。
- **并发与多租户**：DooD 的 tag 冲突、`prune` 互删、磁盘无人认领；daemonless 是进程级隔离，配合 NetworkPolicy 可以放进多租户集群。
- **排障难度**：DooD 老工具链全兼容；daemonless 最常见的是卡在 rootless 前置条件（userns、`/dev/fuse`、AppArmor）。

一句话选型：**新部署直接选 daemonless + rootless；DooD 只留给内网单机和搬不动的老流水线。**

## 六、生产环境的五个高频场景

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
