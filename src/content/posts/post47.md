---
title: ArgoCD
published: 2026-10-27T20:11:23+08:00
description: 学习ArgoCD的资源以及各种实践场景
image: './images/a47.avif'
tags: [k8s,devops]
category: '计算机技术'
draft: false
lang: '中文'
---



## 从DevOps到GitOps

### DevOps：先厘清这个被用滥的词

**DevOps 不是工具，也不是一个岗位，而是一套"让代码到生产的路径尽可能短、尽可能可重复"的工程实践**——开发（Dev）对交付速度负责，运维（Ops）对稳定性负责，两者传统上是彼此牵制的：开发想天天发版，运维想变更越少越好。DevOps 的解法不是让两边互相体谅，而是**用自动化流水线把"发布"从人工事件变成机器动作**：人只负责提交变更，验证、发布、回滚全部由流水线按同样的步骤执行。落地载体就是 CI/CD：

- **CI（持续集成）**：代码合并触发构建 + 测试，产出物是**不可变的制品**（镜像 + tag/digest）；
- **CD（持续交付/部署）**：把制品可靠地送到目标环境——难点全在这里：**往哪送、按什么配置送、送错了怎么退**。

上一篇 Tekton 解决的是 CI 侧的"怎么构建"；这篇的 ArgoCD 解决 CD 侧的"怎么部署"——而且它的答案是釜底抽薪的：**把部署这件事从 CI 流水线里拿出来，交给一个常驻集群的控制器**。

### 传统Push模式的三个结构性缺陷

在 GitOps 出现之前，CD 的主流形态是 **Push 模式**：CI 工具（Jenkins/GitLab CI）构建完镜像后，拿着 kubeconfig 在流水线最后一步 `kubectl apply`。它能用，但有三个结构性缺陷，在规模化后必然爆雷：

| 缺陷 | 表现 | 根因 |
| ---- | ---- | ---- |
| **配置漂移** | 有人手动改了线上副本数/资源限额，集群状态与仓库里的 YAML 对不上，没人知道"现在线上到底是什么配置" | 没有任何组件持续比对"期望状态"与"实际状态" |
| **黑盒变更** | 出了问题翻 Jenkins 日志才能还原"上周三谁改了什么"，审计靠人肉 | 变更记录散落在流水线日志里，而不是结构化的提交历史 |
| **权限过大** | CI 系统持有生产集群的 admin kubeconfig，Jenkins 被打穿 = 生产集群被打穿 | 部署凭证长期驻留在集群外部 |

生产实例——某电商团队大促前排障，一个服务的 Pod 反复重启，排查两小时后发现是三个月前某次"临时调大内存救火"后没有回写仓库，此后每次重新 apply 都把内存改回小值，问题周期性复发。**根因就是 Push 模式下"仓库里的配置"和"集群里的配置"是两份事实**，靠纪律维持一致，而纪律一定会失效。

### GitOps：以Git为唯一事实源的Pull模式

**GitOps 的核心只有一句话：Git 仓库是系统期望状态（Desired State）的唯一事实源（Single Source of Truth），集群向 Git 收敛，而不是向人的操作收敛。**

```text
Push 模式（CI 驱动，集群被动接受）：
  Git ──→ CI 流水线 ──kubectl apply──→ 集群     （推完即走，无人看管）

Pull 模式（控制器驱动，集群主动对齐）：
  Git（期望状态） ←──持续对比──→ 集群（实际状态）
                     │
                出现漂移 → 自动/手动同步，把集群拉回 Git 定义的状态
```

它有四条原则（OpenGitOps 社区的标准表述）：**声明式**（一切配置是 YAML，可被机器执行）、**版本化且不可变**（期望状态在 Git 里，变更即提交，历史即审计）、**自动拉取**（控制器持续把实际状态向期望状态收敛）、**持续可观测**（任何时刻都能回答"当前状态是否与 Git 一致、健康与否"）。

两种模式的关键差异放在一张表里：

| 维度 | 传统 Push（Jenkins） | GitOps Pull（ArgoCD） |
| ---- | ---- | ---- |
| 配置事实源 | CI 脚本里的参数 | Git 仓库 |
| 部署发起方 | CI 工具推 | 集群内控制器拉 |
| 回滚 | 重跑旧流水线 | `git revert` 一次提交 |
| 审计 | 翻流水线日志 | 看 Git 提交历史 |
| 凭证位置 | CI 手里握着集群 admin | 部署凭证不出集群，CI 反而**不需要**集群凭证 |

最后一行是安全模型的质变：**CI 与集群彻底解耦，CI 只需要往 Git 推提交，不再需要任何 K8s 凭证**——即使 CI 系统被打穿，攻击者拿到的是"污染 Git 的机会"，而 Git 提交需要走代码评审，攻击面大幅收窄。

## ArgoCD架构与工作原理

### 核心组件

ArgoCD 本身就是一组跑在集群里的控制器——**它自己就是 GitOps 的第一个实践者**（全部用 CRD 和 controller 实现）。四个核心组件各司一环：

```text
┌───────────┐   gRPC/REST   ┌──────────────────┐
│ UI / CLI  │──────────────→│   API Server     │←── 认证、RBAC、统一入口
└───────────┘               └────────┬─────────┘
                                     │ 监听 Application CR
                                     ▼
                            ┌─────────────────────┐        ┌──────────────┐
                            │ Application         │───────→│  K8s API     │
                            │ Controller          │ 对比/同步 │ (目标集群)    │
                            └───────┬─────────────┘        └──────────────┘
                                    │ 请求"渲染后的清单"
                                    ▼
                            ┌─────────────────────┐        ┌──────────────┐
                            │ Repo Server         │←──────→│  Git/Helm 仓库 │
                            │ (clone+渲染模板)     │        └──────────────┘
                            └─────────────────────┘        ┌──────────────┐
                                    │        Redis（缓存）──→│  缓存清单/状态 │
                                    ▼                      └──────────────┘
```

| 组件 | 职责 | 关键细节 |
| ---- | ---- | ---- |
| **API Server** | UI/CLI/CI 的统一入口 | 处理认证（本地用户/SSO/OIDC）、RBAC、Webhook 接收；**它不执行同步**，只读写 Application CR |
| **Repo Server** | 拉仓库 + 渲染模板 | clone Git 仓库，把 Helm/Kustomize/裸 YAML 渲染成**最终 Kubernetes 清单**；是 CPU 大户，模板多时最先成为瓶颈 |
| **Application Controller** | 核心调谐循环 | 对比"Git 渲染后的期望状态"与"集群实际状态"，计算 Diff，执行同步，评估健康状态 |
| **Redis** | 缓存 | 缓存 Git 仓库内容与清单渲染结果，降低对 Git 仓库和 Repo Server 的压力 |

理解这套架构只需要记住一条数据流：**Application CR 是"愿望单"，Repo Server 负责"翻译"（把 Helm/Kustomize 翻译成裸清单），Controller 负责"执行"（让集群向翻译结果收敛）**。三者全部围绕 Application CR 这一个一等公民运转。

### 工作原理：持续调谐循环

ArgoCD 的本质是一个**控制循环**，与 kubelet 管理 Pod 的逻辑同构——kubelet 保证"容器向 PodSpec 收敛"，ArgoCD 保证"集群向 Git 收敛"：

```text
① 监听 Application CR（或收到 Webhook 通知）
        ↓
② 读取 source（仓库/分支/路径），经 Repo Server 渲染出期望清单
        ↓
③ 与集群实际状态做 Diff → 得出 Sync Status
        ↓
④ 不同步？→ 按 syncPolicy 决定：自动同步 / 等人点 Sync
        ↓
⑤ 同步完成后持续评估健康状态（Health Status）
        ↓
回到 ③（默认每 3 分钟轮询一次全量刷新）
```

两个维度分开看，这是排障的基础——**Sync Status 回答"配置一致吗"，Health Status 回答"运行正常吗"**，两者是正交的：

| 状态 | 含义 | 典型场景 |
| ---- | ---- | ---- |
| Synced + Healthy | 理想态 | 一切正常 |
| **OutOfSync + Healthy** | 集群与 Git 不一致，但服务还活着 | 有人手动 `kubectl scale` 改了副本数 |
| **Synced + Degraded** | 配置已按 Git 落地，但服务有问题 | 新版本镜像崩溃循环（镜像本来就是坏的） |
| OutOfSync + Progressing | 正在同步中 | 正常过渡态 |

**selfHeal 是消灭配置漂移的开关**：开启后任何绕过 Git 的手动修改（`kubectl edit`、`kubectl scale`）都会在下一个调谐周期被拉回 Git 定义的状态。生产实例——上面那个电商团队引入 ArgoCD 并开启 selfHeal 后，"救火改参数不回写"的操作直接失效：手动改完两分钟内被自动改回去，逼着所有人走"改 Git → 提 PR → 自动同步"的唯一路径。**这是 GitOps 最容易被低估的价值：它不靠纪律，靠机制把正确的做法变成唯一的做法。**

## 核心资源定义

ArgoCD 的 CRD 体系分层清晰：**Application 是单个应用的部署声明，AppProject 划权限边界，ApplicationSet 批量生成 Application**。按"从最小到最大"理解它们的分工：

| 资源 | 管什么 | 一句话定位 |
| ---- | ---- | ---- |
| **Application** | 一个应用的部署 | 定义"从哪个仓库、哪个路径，部署到哪个集群、哪个命名空间" |
| **AppProject** | 一组 Application 的边界 | 限制能用哪些仓库、能部署到哪些集群/命名空间，是 RBAC 的载体 |
| **ApplicationSet** | 批量生成 Application | 多环境/多集群场景下，用模板 + 生成器自动产出 N 个 Application |

### Application：部署声明的全部内容

一个 Application 完整定义了部署的全部要素——看注释即可理解每个字段的职责：

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: order-service
  namespace: argocd
  finalizers:
  - resources-finalizer.argocd.argoproj.io   # 删除 Application 时级联删除集群资源（默认不删）
spec:
  project: default                            # 所属 AppProject，生产环境必须按团队划分

  source:                                     # 从哪来：仓库 + 渲染方式
    repoURL: https://git.example.com/platform/order-service.git
    targetRevision: main                      # 分支 / tag / commit 均可；生产建议跟 tag
    path: deploy/overlays/prod                # 指向 Kustomize 目录或 Helm Chart 目录

  destination:                                # 到哪去：集群 + 命名空间
    server: https://kubernetes.default.svc    # 本集群；多集群时填注册集群的 API 地址
    namespace: order-prod

  syncPolicy:                                 # 怎么同步
    automated:                                # 自动同步；删掉这段则每次需手动点 Sync
      prune: true                             # Git 里删掉的资源，集群里也删掉
      selfHeal: true                          # 手动改集群 → 自动拉回 Git 状态
    syncOptions:
    - CreateNamespace=true                    # 目标 ns 不存在则自动创建
    - PruneLast=true                          # 被删资源最后清理，避免删除顺序引发的连锁故障
    retry:                                    # 同步失败重试（网络抖动、API 限流场景）
      limit: 5
      backoff:
        duration: 5s
        factor: 2
        maxDuration: 3m
```

**source 的渲染方式由 path 指向的内容自动识别**：目录里有 `kustomization.yaml` 走 Kustomize，有 `Chart.yaml` 走 Helm，否则按裸 YAML 逐个 apply。Helm 的 values 注入与 Kustomize 的 images 覆盖都写在 source 内：

```yaml
source:
  repoURL: https://charts.example.com        # 甚至可以直接指向 Helm 仓库
  chart: redis
  targetRevision: 19.6.0                     # Chart 版本，语义同 targetRevision
  helm:
    releaseName: redis
    valueFiles:
    - values-prod.yaml                       # Git 里的 values 文件
    values: |                                # 内联 values，优先级最高
      replica:
        replicaCount: 3
```

**生产建议：Application 本身也进 Git**（放在独立的 deploy 仓库或同仓库的 argocd/ 目录），而不是在 UI 上点出来——UI 创建的 Application 无法被审计和迁移，违背 GitOps 自己的原则。这就是著名的 **App of Apps 模式**：一个根 Application 指向存放所有子 Application YAML 的目录，"部署一批应用"变成"在根目录加一个 YAML"。

### syncPolicy：自动同步的两个开关是核心

`automated` 段存在即自动同步，其中两个字段的行为差异必须辨析清楚：

- **prune: true**——Git 里删除的资源，集群里同步删除。不开的话资源删了只是变成"孤儿"，集群里永远留着；
- **selfHeal: true**——集群实际状态被人为改掉后，自动拉回 Git 状态。**不开的话 GitOps 只防"漏部署"，不防"配置漂移"**。

两者的取舍与配套机制：

| 场景 | 推荐配置 | 理由 |
| ---- | ---- | ---- |
| dev/test 环境 | automated + prune + selfHeal | 快速迭代，集群状态完全由 Git 说了算 |
| 生产环境 | automated + prune，**selfHeal 慎开** | 配合 HPA 的场景见下文 |
| 强管控生产（金融） | 手动同步（不写 automated） | 同步动作 = 变更审批后的确认动作，留人工闸门 |

**selfHeal 与 HPA 的冲突是生产第一大坑**：HPA 会动态修改 Deployment 的 `spec.replicas`，这在 ArgoCD 眼里就是"集群偏离了 Git"，selfHeal 会把它改回去——HPA 失效，且日志里毫无异常。解法是用 `ignoreDifferences` 显式豁免：

```yaml
spec:
  ignoreDifferences:
  - group: apps
    kind: Deployment
    jsonPointers:
    - /spec/replicas        # 副本数交给 HPA，不参与 Diff
```

同理适用于被 MutatingWebhook 注入字段的资源（如 Istio sidecar 注入的 `spec.template`、被 KYverno 改写的 SecurityContext）——**凡是"有别的控制器会改这个字段"的场景，都要用 ignoreDifferences 划出豁免区，否则 selfHeal 与对方控制器互相拉扯，Pod 反复重启**。

### AppProject：给Application划定权限边界

`default` Project 不设任何限制，生产环境等于裸奔。AppProject 从三个维度收紧边界：

```yaml
apiVersion: argoproj.io/v1alpha1
kind: AppProject
metadata:
  name: payment-team
  namespace: argocd
spec:
  description: 支付团队专属项目
  sourceRepos:                                # ① 只允许从这些仓库部署
  - https://git.example.com/payment/*
  destinations:                               # ② 只允许部署到这些集群+命名空间
  - server: https://kubernetes.default.svc
    namespace: payment-*
  clusterResourceWhitelist:                   # ③ 命名空间级资源全放开
  - group: '*'
    kind: '*'
  namespaceResourceBlacklist:                 # 但禁止碰集群级资源和 Node
  - group: ''
    kind: Node
  roles:                                      # ④ RBAC：团队组绑定角色
  - name: developer
    policies:
    - p, proj:payment-team:developer, applications, get, payment-team/*, allow
    - p, proj:payment-team:developer, applications, sync, payment-team/*, allow
    groups:
    - payment-team:developers                 # 对接 SSO 的用户组
```

生产实例——某团队按此模型落地后，新团队接入流程收敛为：申请一个 AppProject（限定仓库前缀 + 命名空间前缀）+ 在 SSO 里建用户组，**AppProject 之外的操作全部被 API Server 拒绝**，"误删别的团队的应用""从不可信仓库部署"这类事故从机制上不可能发生。

### ApplicationSet：多环境/多集群的批量生成器

一个应用 × 三个环境 = 三个几乎相同的 Application，手写三份 YAML 是典型的复制粘贴灾难——改一处漏两处。ApplicationSet 用**生成器 + 模板**解决：生成器产出参数列表，模板按参数渲染出 Application：

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: order-service
  namespace: argocd
spec:
  generators:
  - list:                                     # list 生成器：手动枚举参数（最直观）
      elements:
      - env: dev
        namespace: order-dev
      - env: staging
        namespace: order-staging
      - env: prod
        namespace: order-prod
  template:                                   # 模板：占位符被每个 element 渲染一次
    metadata:
      name: 'order-service-{{env}}'
    spec:
      project: payment-team
      source:
        repoURL: https://git.example.com/platform/order-service.git
        targetRevision: main
        path: 'deploy/overlays/{{env}}'       # 目录约定：overlays/dev|staging|prod
      destination:
        server: https://kubernetes.default.svc
        namespace: '{{namespace}}'
      syncPolicy:
        automated: { prune: true, selfHeal: true }
        syncOptions: [CreateNamespace=true]
```

生成器不止 list 一种，按场景选：**list** 适合环境枚举；**git directory** 适合"仓库里每加一个目录就自动多一个应用"（微服务 monorepo 的标配，新增服务零配置）；**cluster** 适合多集群——配合 `argocd cluster add` 注册的集群标签，一个模板把应用铺到所有带 `environment: production` 标签的集群，**新增集群 = 注册时打个标签，应用自动部署**，这就是多集群场景下 ApplicationSet 不可替代的原因。

## 安装与快速上手

### 安装与初始化

官方 manifest 一键安装（Helm Chart 适合需要定制参数的场景）：

```bash
kubectl create namespace argocd
kubectl apply -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml

# CLI（macOS 为 brew install argocd）
curl -sSL -o /usr/local/bin/argocd \
  https://github.com/argoproj/argo-cd/releases/latest/download/argocd-linux-amd64
chmod +x /usr/local/bin/argocd

# 初始 admin 密码（存放在 Secret 中，首次登录后应改掉并删除该 Secret）
kubectl -n argocd get secret argocd-initial-admin-secret \
  -o jsonpath="{.data.password}" | base64 -d

# 开发环境端口转发访问 UI；生产环境走 Ingress 并开启 SSO
kubectl port-forward svc/argocd-server -n argocd 8080:443
argocd login localhost:8080 --username admin
```

### 第一个应用

用 CLI 一步创建（UI 点选的字段与这几个参数一一对应）：

```bash
argocd app create guestbook \
  --repo https://github.com/argoproj/argocd-example-apps.git \
  --path guestbook \
  --dest-server https://kubernetes.default.svc \
  --dest-namespace default

argocd app get guestbook        # 状态为 OutOfSync：Git 与集群有差异
argocd app sync guestbook       # 执行同步，等价于 UI 上点 SYNC
argocd app wait guestbook       # 等待 Healthy
```

到这里已经能体会 GitOps 的最小闭环：**部署 = 把仓库指向集群，发布 = 改仓库**。后续所有章节都是在这个闭环上加工程化能力。

### 常用CLI速查

```bash
argocd app list / get <app> --tree        # 列表 / 详情+资源树
argocd app sync <app> [--prune]           # 手动同步
argocd app diff <app>                     # 查看期望与实际的差异（排障利器）
argocd app history <app>                  # 同步历史
argocd app rollback <app> <id>            # 回滚到历史版本（注意：开自动同步后回滚要 revert Git，见下文）
argocd app logs <app>                     # 查看应用 Pod 日志
```

**一个容易踩的认知坑：自动同步开启后，`rollback` 没有意义**——它把集群状态改回历史版本，但 Git 还在新版本，下一个调谐周期又会同步回去，状态反复横跳。自动同步模式下回滚的唯一正确姿势是 `git revert` 那次提交。手动同步的应用 rollback 才可用。

## 同步进阶：Hook与顺序控制

### Sync Hook：在同步前后插入动作

数据库 Schema 变更必须先于新版本应用启动，这是 CD 里最经典的编排需求。ArgoCD 用注解把任意资源变成 Hook，**Hook 资源不参与日常 Diff，只在同步流程的特定时机执行**：

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: db-migration
  annotations:
    argocd.argoproj.io/hook: PreSync              # 同步前执行，失败则整个同步中止
    argocd.argoproj.io/hook-delete-policy: BeforeHookCreation
spec:
  template:
    spec:
      containers:
      - name: migrate
        image: registry.example.com/order-service:migrations-v42
        command: ["./migrate", "--up"]
      restartPolicy: Never
```

四种 Hook 时机覆盖完整的同步生命周期：**PreSync**（同步前，迁移脚本）、**Sync**（同步中并阻塞）、**PostSync**（同步后健康时，通知/预热缓存）、**SyncFail**（同步失败时，告警回滚脚本）。删除策略用 `BeforeHookCreation`（下次同步前删旧的）最常用；`HookSucceeded` 则是"跑完即删"，适合一次性通知。

### sync-wave：同一波内的资源顺序

Hook 之外，普通资源之间也有顺序需求——先数据库 StatefulSet、再后端、最后前端。ArgoCD 按 `sync-wave` 注解把资源分波执行，**同一波内并行，波之间串行，且必须等上一波 Healthy 才进下一波**：

```yaml
metadata:
  annotations:
    argocd.argoproj.io/sync-wave: "-1"   # 数据库先行（默认波为 0）
```

生产实例——某团队一个含 Kafka + Schema Registry + 消费者的应用，曾因三者同波并行导致消费者连不上 Schema Registry 起不来、靠 Pod 重试碰运气恢复。拆波后（Kafka wave -1，Registry wave 0，消费者 wave 1），每次同步都是确定性顺序，Pod 重试日志消失。**需要跨资源依赖的部署，显式分波是唯一可靠解，"反正有重试"是赌博。**

## 多环境管理策略

多环境（dev/staging/prod）配置管理是 GitOps 落地时第一个需要拍板的架构决策，三种主流策略各有适用场景：

| 策略 | 做法 | 优点 | 缺点 | 适用 |
| ---- | ---- | ---- | ---- | ---- |
| **单分支 + 目录**（推荐） | `overlays/dev|prod`（Kustomize）或 `values-dev|prod.yaml`（Helm） | 同一提交可见所有环境差异，PR 里 Diff 一目了然 | 环境间无隔离，权限粒度粗 | 绝大多数团队 |
| **多分支** | dev/prod 各一个分支 | 环境天然隔离，可按分支配保护规则 | **跨分支 cherry-pick 是无底洞**，分支漂移后合并成本极高 | 环境间强隔离需求（合规） |
| **多仓库** | 每环境独立仓库 | 权限、历史完全隔离 | 跨仓库追踪变更链路，工具成本高 | 大组织多团队 |

推荐组合——**单分支 + Kustomize overlay + ApplicationSet**，目录约定：

```text
order-service/
├── base/
│   ├── deployment.yaml
│   ├── service.yaml
│   └── kustomization.yaml
└── overlays/
    ├── dev/kustomization.yaml        # replicas: 1, image: dev tag
    ├── staging/kustomization.yaml
    └── prod/kustomization.yaml       # replicas: 3, image: prod digest, resources 加大
```

前文 ApplicationSet 的 `path: 'deploy/overlays/{{env}}'` 正是消费这个结构：**base 承载共性，overlay 承载差异，新增环境 = 新增一个目录 + ApplicationSet elements 里加一个元素**。环境配置漂移（dev 有、prod 忘配）在这样的结构里直接肉眼可见——这正是把配置放进 Git 的复利。

## 与CI的衔接：镜像更新谁来做

GitOps 落地后必然遇到的问题：CI 构建出新镜像后，**谁来更新 Git 仓库里的镜像版本**？这一步是 CI 与 CD 的接缝，三种方案按成熟度排序：

| 方案 | 做法 | 评价 |
| ---- | ---- | ---- |
| **CI 末尾写 Git 提交**（主流） | 流水线最后一步 `kustomize edit set image`（或 yq 改 values）→ commit + push | 简单直给，变更历史在 Git；注意用机器人账号 + 提交签名 |
| **ArgoCD Image Updater** | 旁路控制器监听 registry 新镜像，自动改写 Application 的镜像参数并提交 Git | 免去 CI 侧改造；策略（latest/语义化版本）可控，但提交记录可读性一般 |
| **手动 PR** | 机器人开 PR，人审后合入 | 生产环境的最佳实践——发布动作拥有一次人工评审，成本换安全 |

生产实例——某团队 prod 环境采用"CI 构建推送镜像 → 机器人开版本升级 PR → 值班负责人批准合入 → ArgoCD 自动同步"的链路，**发布审批就是那个 PR 的 approve 按钮**，审批记录、变更内容、触发时间天然聚合在一个 PR 里，审计时一个链接说清一切。dev 环境则用 Image Updater 全自动跟最新镜像，零人工介入。同一套 ArgoCD，按环境选择接缝的自动化程度——**这比"全自动"或"全手动"的一刀切更贴近现实**。

## 生产实践与避坑

### 可观测：监控与告警

ArgoCD 原生暴露 Prometheus 指标（`:8082/metrics`），三个核心指标撑起 CD 层的可观测：

```yaml
# 告警规则示例
- alert: AppOutOfSync          # OutOfSync 持续 10 分钟：Git 与集群不一致且没被收敛
  expr: argocd_app_sync_status{sync_status="OutOfSync"} == 1
  for: 10m
- alert: AppDegraded           # 健康度降级：多半是新版本有问题或资源不足
  expr: argocd_app_health_status{health_status="Degraded"} == 1
  for: 5m
- alert: AppSyncFailed         # 同步失败：Hook 失败、清单非法、权限不足都会落到这
  expr: increase(argocd_app_sync_total{phase="Failed"}[10m]) > 0
```

事件通知用 ArgoCD Notifications（随主程序安装），把 on-sync-failed / on-sync-status-changed 推到钉钉/飞书/Slack——**同步失败不告警的 GitOps 是盲飞**：你以为 Git 提交了就会生效，实际 Repo Server 渲染失败卡了一整天。

### 安全：四条底线

- **凭证管理**：Git 仓库里的 Secret 明文是 GitOps 最大反模式。用 **External Secrets**（从 Vault/Nacos 等拉取）或 **Sealed Secrets**（加密后可安全入库）——密码进 Git 的那一刻，Git 的审计历史就变成了密码泄露历史；
- **SSO + RBAC**：禁用本地 admin 日常使用，对接 OIDC 后用 AppProject roles 按组授权；`admin` 密码只封存在断路器信封里；
- **收敛集群写权限**：目标是"除 ArgoCD 和少数运维平台外，人类账号对生产命名空间只有读权限"——GitOps 的 selfHeal 只能管 ArgoCD 自己的应用，管不住有人直接拿 kubeconfig 改集群，**把修改通道收窄到 Git 是制度问题，ArgoCD 只是让制度可执行**；
- **私有仓库凭证**：`argocd repo add --username xxx --password <token>` 或声明式 Secret，凭证留在 argocd 命名空间内不外泄。

### 常见故障排查

| 现象 | 排查顺序 | 高频根因 |
| ---- | ---- | ---- |
| 永远 OutOfSync | `argocd app diff` 看具体字段 | 被 HPA/webhook 改写的字段没加 ignoreDifferences |
| 卡在 Progressing | `argocd app get` 看 health message | 就绪探针配错、依赖服务不通、资源配额不足 |
| 同步失败 | `argocd app sync --dry-run` + Controller 日志 | Hook Job 失败、清单校验不通过、ns 无权限 |
| 渲染慢/超时 | 看 Repo Server CPU 与内存 | 大仓库 + 大量 Helm 模板，Repo Server 该扩副本了 |
| CRD 健康 Unknown | 无内置逻辑 | 自定义 CRD 需要写 Lua 健康检查（argocd-cm 的 `resource.customizations`） |

### 避坑清单

- **仓库粒度**：一个 Application 指向的路径不要塞几十个服务的清单——Diff 计算按 Application 全量做，单应用过大导致轮询变慢、UI 卡顿；按服务/按环境拆 Application 是常态；
- **targetRevision 用 main 有风险**：main 前进即发布，缺少"发布版本"概念。生产建议 prod 环境的 Application 跟 tag 或固定 commit，"发版"动作就是一次显式的版本号变更提交；
- **finalizer 要想清楚再抄**：`resources-finalizer` 让删 Application 级联删集群资源，方便但危险——误删 Application 就是误删服务。重要应用可以不加，删除动作走两步确认；
- **轮询周期与 Webhook**：默认 3 分钟轮询意味着提交后最长要等 3 分钟才同步。配 Git Webhook（repo 的 push 事件 → argocd-server）可把延迟降到秒级，生产必配；
- **Repo Server 是第一个瓶颈**：应用数量上百后优先扩 Repo Server 副本数，其次才是 Controller；
- **不要在 UI 上手改资源**：开 selfHeal 的应用改了也会被拉回，纯做无用功；UI 的正确用法是看拓扑、看 Diff、看日志，以及手动同步那一个按钮。

## 结语

把 ArgoCD 放回整个工具链看它的位置：Tekton/Jenkins 负责"把代码变成镜像"，ArgoCD 负责"让集群永远等于 Git 里声明的那样"。前者的产出是**不可变制品**，后者的不变量是**期望状态收敛**——两者以 Git 仓库为唯一接缝，构成完整的云原生 CI/CD。

GitOps 带来的不只是工具更替，而是运维范式的位移：**变更即提交，回滚即 revert，审计即日志，正确性由控制器机制而非人的自觉保证**。当"改集群"这件事只剩下"改 Git"一条路径时，前文那些靠纪律维持的流程（审批、回写、复盘）全部变成了机制本身——这是 ArgoCD 区别于一切 Push 型部署工具的本质价值。
