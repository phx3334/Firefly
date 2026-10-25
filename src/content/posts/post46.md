---
title: Tekton
published: 2026-10-27T20:11:23+08:00
description: 学习 Tekton 核心资源定义与"模板 + 参数注入"的工作模式，掌握 K8s 原生 CI/CD 的设计哲学
image: './images/a46.avif'
tags: [k8s,devops]
category: '计算机技术'
draft: false
lang: '中文'
---



## Tekton介绍

### Tekton是什么

**Tekton 是 Kubernetes 原生的 CI/CD 框架**——它没有自己发明一套流水线引擎，而是把"构建、测试、发布"这件事完全建模成 K8s CRD：流水线的每个环节是一个 Pod，整套 CI/CD 就是一堆 CR 的声明式组合。这带来两个根本性优势：

- **无自有架构**：Jenkins 要维护 Master/Agent、GitLab CI 要维护 Runner，Tekton 的执行载体就是 K8s 本身——Task 一跑起来就是个 Pod，调度、弹性、日志、资源限制全部复用 K8s 现有能力，CI 系统本身零额外运维；
- **声明式可迁移**：流水线是 YAML 资源，跟 Deployment 一样走 Git 仓库、走 `kubectl apply`——CI 配置和业务配置用同一套范式管理，跨集群迁移就是导出资源再 apply。

代价也要认清：Tekton 只提供"执行框架"，PaaS 化程度低——没有 Jenkins 那种开箱界面和插件生态，Webhook 触发、可视化都要靠附加组件拼装。**它适合已经深度使用 K8s、想把 CI 也纳入声明式管理的团队；小团队要"上传即用"的 CI，Jenkins/GitLab CI 更省事**。

### 核心资源总览

Tekton 的资源分层非常清晰，按"从最小单元到完整流水线"理解它们的分工：

| 资源 | 管什么 | 一句话定位 |
| ---- | ---- | ---- |
| **StepAction** | 最小可复用步骤 | 可复用的"动作片段"，被 Task 引用 |
| **Task** | 一次具体工作 | 有序的步骤集合，如"构建"、"扫描"、"推镜像" |
| **Pipeline** | 完整流水线 | 多个 Task 按依赖编排，定义流程框架 |
| **TaskRun / PipelineRun** | 实际执行 | 定义不会跑，Run 才会跑——一次 Run 对应真实的 Pod |
| **Triggers** | 事件触发（扩展组件） | 接收 Webhook 等外部事件，自动创建 Run |

先建立一个贯穿全文的总括认知——**定义与执行分离**：

```text
资源定义（静态的"说明书"，不会自动执行）
    StepAction / Task / Pipeline
        ↓ 需要一个"Run"来实例化
实际执行（真正跑起来的 Pod）
    TaskRun（执行一个 Task） / PipelineRun（执行整条 Pipeline）
```

这类似 Jenkins 里 **Job 定义与"立即构建"的关系**：写好 Job 不代表构建发生，点一次"立即构建"才产生一次执行。Tekton 把这次"点击"也建模成了资源——TaskRun/PipelineRun，于是"哪次构建、传了什么参数、跑到什么状态"全部是集群里可查的 CR，历史记录天然持久化。

### StepAction：最小工作单元

StepAction 是 Tekton 中**最小的可执行单元**（较新版本中从 Task 的 Step 拆分而来的独立 CRD），定位是**可复用的动作片段**：把一段具体操作（如 `mvn clean install`、SonarQube 扫描）封装成独立资源，供多个 Task 引用。

```yaml
apiVersion: tekton.dev/v1
kind: StepAction
metadata:
  name: maven-build
spec:
  image: maven:3.9-eclipse-temurin-21     # 步骤运行所在的容器镜像
  command: ["mvn"]
  args: ["clean", "install", "-DskipTests"]
```

但生产实践中有一句大实话：**StepAction 的复用收益常被高估**。它通常被 Task 调用，可多数团队发现直接在 Task 里写命令更省事——为每个小操作都抽一个 StepAction，会让资源数量膨胀、跳转链路变长，管理复杂度反而上升。建议只对**真正跨项目共享**的操作（如公司统一的代码扫描动作）抽 StepAction，其余直接写在 Task 里。

### Task：一次具体工作

Task 由多个有序的 Step 组成，Step 按**定义顺序串行执行**（本质是一个 Pod 里的多个容器，共享工作空间）。Step 有两种写法——直接写命令，或引用 StepAction：

```yaml
apiVersion: tekton.dev/v1
kind: Task
metadata:
  name: build-node-app
spec:
  params:
  - name: app-name
  workspaces:
  - name: source                          # 挂载代码的工作空间
  steps:
  - name: install                         # 写法一：直接写命令（生产主流写法）
    image: node:22
    workingDir: $(workspaces.source.path)
    script: npm ci && npm run build
  - name: scan                            # 写法二：引用 StepAction（仅真正共享的动作）
    ref:
      name: sonar-scan
```

**实际开发的建议**：通常直接在 Task 里配置具体命令（写法一），避免过度拆分为 StepAction。Task 的划分粒度按"职责"切——构建 Node.js 应用的 Task、代码扫描的独立 Task、镜像构建的专用 Task，各管一摊，Pipeline 层再编排它们。

### Pipeline：流水线框架

Pipeline 是 CI/CD 的核心模块，**把多个 Task 按依赖关系编排成流程**：支持顺序执行（代码下载 → 构建 → 镜像制作 → 推送 → 部署），也支持并行编排（无依赖关系的 Task 自动同时跑）。

```yaml
apiVersion: tekton.dev/v1
kind: Pipeline
metadata:
  name: build-deploy-pipeline
spec:
  params:
  - name: repo-url                        # 参数接口：Pipeline 只定义"要什么"，不管"是什么"
  - name: image-repo
  workspaces:
  - name: shared-workspace
  tasks:
  - name: fetch-source                    # ① 拉代码，所有后续 Task 的上游
    taskRef:
      name: git-clone
    workspaces:
    - name: output
      workspace: shared-workspace
    params:
    - name: url
      value: $(params.repo-url)
  - name: unit-test                       # ②③ 无依赖关系的 Task 自动并行
    taskRef: { name: run-tests }
    runAfter: [fetch-source]
    workspaces:
    - name: source
      workspace: shared-workspace
  - name: code-scan
    taskRef: { name: sonar-scan }
    runAfter: [fetch-source]
    workspaces:
    - name: source
      workspace: shared-workspace
  - name: build-image                     # ④ 等 ②③ 都完成才执行
    taskRef: { name: build-and-push }
    runAfter: [unit-test, code-scan]
    params:
    - name: image
      value: $(params.image-repo)
    workspaces:
    - name: source
      workspace: shared-workspace
```

注意 Pipeline 的层级分工：**Task 里写"具体怎么做"，Pipeline 里写"按什么顺序做、参数怎么传"**——命令实现下沉在 Task，Pipeline 保持纯框架。

### TaskRun与PipelineRun：让定义真正跑起来

Task/Pipeline 都只是资源定义，**不会自动触发任何执行**。要真正跑起来，必须创建对应的 Run 资源来实例化——TaskRun 执行一个 Task，PipelineRun 执行整条 Pipeline：

```yaml
apiVersion: tekton.dev/v1
kind: PipelineRun
metadata:
  name: order-service-run-42
spec:
  pipelineRef:
    name: build-deploy-pipeline           # 指向哪条流水线框架
  params:
  - name: repo-url
    value: https://git.example.com/order-service.git    # 注入运行时参数：这次跑的是谁
  - name: image-repo
    value: registry.example.com/order-service:v1.4.2
  workspaces:
  - name: shared-workspace
    volumeClaimTemplate:
      spec:
        accessModes: [ReadWriteOnce]
        resources: { requests: { storage: 5Gi } }
```

每个 TaskRun 对应一个真实 Pod，执行状态直接用 K8s 的方式查：

```bash
kubectl get pipelinerun order-service-run-42
kubectl get taskrun -l tekton.dev/pipeline=build-deploy-pipeline   # 看流水线下每个 Task 的执行状态
kubectl logs -f order-service-run-42-build-image-pod   # 某个步骤的构建日志
```

### Triggers：事件驱动的扩展组件

到目前为止流水线还要手动创建 PipelineRun 才会跑。**Tekton Triggers** 补上事件驱动这一环：接收外部系统事件（最典型的是 Git 仓库的 Webhook——push、tag、PR），解析后自动创建 PipelineRun，实现"提交代码即触发构建"。它需要单独安装，由三个核心资源协作：

| 资源 | 职责 |
| ---- | ---- |
| **EventListener** | 部署一个接收 Webhook 的服务入口（对应一个 Pod + Service） |
| **TriggerBinding** | 从事件里抽取字段（如仓库名、分支、commit SHA） |
| **TriggerTemplate** | 拿抽取的字段渲染出 PipelineRun 模板并创建 |

```text
Git push ──Webhook──→ EventListener（收到事件）
                        ↓ TriggerBinding 抽取 repo/branch/commit
                        ↓ TriggerTemplate 渲染参数
                     自动创建 PipelineRun ──→ 流水线开跑
```

### CLI与Dashboard

**tkn** 是 Tekton 官方 CLI，覆盖创建/管理 Task、触发 Pipeline、跟踪日志、与集群内 Tekton 交互等日常操作。但生产建议是：**优先用 kubectl 管理 Tekton 资源**——因为 Task/Pipeline 本质就是 CRD，统一走 kubectl 意味着资源配置管理、跨环境迁移、声明式维护与业务资源同一套范式；tkn 的价值在交互式场景（`tkn pipelinerun logs -f` 跟日志确实比 kubectl 顺手），两者不冲突。

**Tekton Dashboard** 提供图形化界面：可视化查看 Task/Pipeline 配置、实时监控构建状态。对刚接触 Tekton 的团队，Dashboard 能显著降低学习曲线——排障时在页面上点开每个 Task 的状态和日志，比命令行翻 CR 直观得多；但它同样是可选组件，不影响核心链路。


## Tekton工作模式

上一节认清了资源分工，这一节看 Tekton 的设计哲学如何落到实际使用——**为什么它是"模板 + 参数注入"而不是"每个项目一条流水线"**。

![Tekton Pipeline 工作模式：Pipeline 由多个 Task 编排组成，无依赖的 Task 自动并行执行，通过 runAfter 声明依赖顺序，PipelineRun 注入参数后实例化整条流水线](./images/Tekton-pipeline.jpg)

### 流水线编排的三条规则

对照上图，Tekton 的编排语义可以浓缩成三条规则：

**① 最小单元原则：一个 Task 只包含一个步骤**。推荐把 Task 保持为最小执行单元，需要多个步骤时应拆分为多个 Task，而不是在一个 Task 里塞一段长脚本。收益是实打实的：每个 Task 独立成 Pod，**状态、日志、重试、资源配额都按 Task 粒度可见**——构建挂了能精确定位到是哪个环节，而不是翻一段几百行的混合日志。拆分后的 Task 还天然便于跨流水线复用（build-image 这个 Task 谁都能引用）。

**② 无依赖即并行**。没有声明依赖关系的 Task（如上图的 Task B 和 Task C）**自动并行执行**——典型场景是编译与代码扫描互不依赖，同时跑能显著压缩流水线总时长。Tekton 不需要你写任何 parallel 关键字，"默认并行、显式声明串行"是它的编排哲学。

**③ runAfter 显式控制顺序**。需要串行的 Task 用 `runAfter` 字段声明依赖（如 Task D 等待 B、C 完成后才启动）。注意 runAfter 语义是"等它们**成功**"，这就引出第四条隐含规则——

**④ 失败沿依赖图截断**。任一 Task 失败，其下游全部终止：Task A 失败则 B/C 不会执行；B、C 任一失败则 D 不执行。这个语义与直觉一致——上游构建都没产出，跑下游测试毫无意义。失败位置之前的并行分支不受牵连，这让排障时一眼就能从 PipelineRun 状态里看出故障边界。

### 模板+参数注入：一套流水线服务所有项目

这是 Tekton 最值得记住的设计。**Pipeline 只定义流程框架**（build/test/package 等阶段），不包含任何具体命令实现——构建什么语言、用什么命令，全部通过预留的参数接口（`params`）在执行时注入。

以一个多语言微服务团队为例：Go、Java、Node.js 三种服务的构建命令天差地别，但**流程完全同构**（拉代码 → 构建 → 制镜像 → 推送 → 部署）。做法是：

```text
一条通用 Pipeline（框架，定义阶段顺序和参数接口）
    ├── PipelineRun#1：传 go build ./...       → Go 服务跑一遍
    ├── PipelineRun#2：传 mvn clean package    → Java 服务跑一遍
    └── PipelineRun#3：传 npm run build        → Node 服务跑一遍
```

**维护优势立现**：不为每个微服务维护独立 Pipeline，流程变更（比如加一道安全扫描）只改一处框架，所有服务下次执行自动生效；各服务的差异全部收敛在 PipelineRun 的参数里。这就是"分离 Pipeline 定义与 Runtime 参数"的精髓——**定义稳定复用，参数各跑各的**。

### 工作流程总结

把 Tekton 的标准用法串成一条线：

```text
① 创建原子化 Task（单步骤为最佳实践，每个 Task 一个职责）
        ↓
② 组合 Task 构建 Pipeline（流程框架：顺序/并行/参数接口）
        ↓
③ 创建 PipelineRun 实例化执行（注入运行时参数，触发真实 Pod）
        ↓ （可选）
④ 配置 Triggers，Webhook 事件自动创建 PipelineRun
```

设计哲学一句话：**"模板 + 参数注入"实现流程复用**——Pipeline 是稳定的模板，PipelineRun 是一次性的注入。这个模式正是为多语言、多版本的 CI/CD 场景而生：流程收敛为一处维护，差异全部参数化，规模越大复用收益越明显。