---
title: 基于KEDA的弹性伸缩
published: 2026-10-22T20:11:23+08:00
description: 学习HPA的使用，KEDA的架构原理和应用
image: './images/a43.avif'
tags: [k8s]
category: '计算机技术'
draft: false
lang: '中文'
---


## 解决了什么问题

前面两章分别解决了"资源能用多少"（配额）和"谁有权操作"（RBAC），但有个前提一直没变：**副本数是人写死在 Deployment 里的**。线上流量却从来不是恒定的——白天高峰深夜低谷、促销活动瞬时脉冲，靠人盯着监控手动改 replicas，既不及时也不精确：扩慢了服务被冲垮，不缩回去白白烧钱。

弹性伸缩补的就是这一环：**让副本数跟着实际负载自动走**。K8s 自带的方案是 HPA（Horizontal Pod Autoscaler，水平 Pod 自动伸缩器），它根据指标自动调整副本数量，本章先用它做一个实战，再看它在真实业务里的局限——局限正是 KEDA（Kubernetes-based Event-Driven Autoscaler）出现的原因，后面展开讲它的架构原理和几个典型应用。


## HPA：指标驱动的自动扩缩容

HPA 的本质是一个控制循环：周期性采集目标工作负载的指标，和目标值比较，按公式算出期望副本数，然后直接修改 Deployment 的 replicas 字段——剩下的扩缩动作就是前面讲过的 Deployment 滚动更新。计算公式很直白：**期望副本数 = ceil(当前副本数 × 当前指标值 / 目标指标值)**，指标翻倍就扩一倍的机器，指标减半就缩一半。

指标数据从哪来？HPA 默认依赖 metrics-server：每个节点的 kubelet 采集容器资源使用情况，metrics-server 把它们汇总成 Pod 级的 CPU/内存使用率，HPA 拿这些数据做计算。

### 实战：CPU 使用率不超过 80%

最常见的伸缩需求：平时 2 个副本兜底，CPU 平均使用率一旦超过 80% 就自动扩容，上限 10 个，高峰过去自动缩回来。写成 HPA 资源就是：

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: web-hpa
  namespace: prod
spec:
  scaleTargetRef:              # 监控哪个工作负载
    apiVersion: apps/v1
    kind: Deployment
    name: web
  minReplicas: 2               # 缩容下限，流量再小也保底 2 个副本
  maxReplicas: 10              # 扩容上限，防止指标异常时副本失控
  metrics:
  - type: Resource             # Resource 类型：CPU/内存等内置资源指标
    resource:
      name: cpu
      target:
        type: Utilization      # 按使用率的百分比算（还有 AverageValue 按绝对值算）
        averageUtilization: 80 # 全部副本的 CPU 平均使用率目标：80%
```

过一遍工作过程。假设当前 3 个副本，平均 CPU 使用率被压到 90%，超过了 80% 的目标，HPA 算出期望副本数 = ceil(3 × 90 / 80) = 4，于是把 Deployment 扩到 4 副本；新副本加入后分摊流量，使用率回落，逐步趋向 80%。缩容同理，流量下降使用率低于目标时反向计算。

但缩容比扩容需要更谨慎——流量抖动是常态，指标跟着抖，如果每次抖动都立刻删 Pod，副本数会反复横跳（抖动），还会误杀正在处理请求的实例。所以 HPA 对缩容有冷却窗口：**指标必须持续低于目标一段时间（默认 5 分钟）才真正缩容**，扩容没有这个限制，响应要快。这个不对称的思想后面 KEDA 的配置里还会用到。

验证很简单：`kubectl get hpa web-hpa -w` 盯住 REPLICAS 列，对服务压一轮测，能看见副本数从 2 爬上去再降回来的完整过程。

### HPA 的局限

CPU 驱动的伸缩覆盖了"算力型"业务，但真实集群里的伸缩需求远不止这一种，HPA 的短板在与业务对接时会逐个暴露：

**内置指标只有 CPU 和内存两个。** HPA 的 Resource 指标就这两样，想按别的数据伸缩——队列里积压的任务数、网关统计的 QPS、数据库里的记录数——HPA 自己无能为力。

**自定义指标的链路非常重。** 理论上可以装 prometheus-adapter 来实现 HPA 的自定义指标接口：业务先写一个 Exporter 把指标暴露给 Prometheus，adapter 再从 Prometheus 查询转交给 HPA。比如想按"数据库任务表里待执行的任务数"伸缩，就得专门开发部署一个 Exporter 应用、配 Prometheus 采集规则、再配 adapter 的查询映射——三层组件就为了一个数字，而且这个 Exporter 跟着业务走，每换一种事件源就要再写一个。

**副本数最低只能缩到 1，不能到 0。** 对有明显闲时的负载（夜间无人访问的内部系统、定时任务）来说，哪怕一整天没流量也得留一个副本空转，成本降不下去。

**只能被动响应，且只作用于"常驻副本"。** CPU 指标反映的是已经发生的压力，多级微服务里这个滞后会被逐级放大：A 被冲高才扩 A，A 扩完吞吐变大，B 才被冲高……每一级都在等上一级"传染"，全程被动挨打。而对"从队列取任务执行"这类场景，要的不是给常驻服务扩副本，而是**按任务数量动态创建一次性的 Job**——这超出了 HPA 的能力边界。

这四条局限指向同一个缺口：**HPA 只认 CPU/内存、只管常驻副本**。KEDA 的出现就是为了补上它。

## KEDA：事件驱动的弹性伸缩

KEDA 是 CNCF 毕业项目（2020.3 接收，2021.8 孵化，2023.8 毕业），定位很明确：**不是替代 HPA，而是增强 HPA**。它内置了几十种 Scaler，可以直接对接消息队列、关系型/时序/文档数据库、键值存储、事件总线等外部系统，把"队列长度""待处理任务数""QPS"这类外部事件数据变成 HPA 能理解的伸缩依据，还支持 Cron 定时伸缩和缩到 0。

先看官方架构图建立整体印象：

![KEDA架构图](./images/KEDA-arch.png)

### 核心资源

KEDA 通过三个 CRD 把"事件源 → 伸缩"这件事资源化：

| 资源                  | 作用                                                                  |
| --------------------- | --------------------------------------------------------------------- |
| ScaledObject          | 核心资源：指定要伸缩的工作负载 + 触发器列表 + 伸缩范围，管理常驻副本  |
| ScaledJob             | 任务型场景：不伸缩副本，按事件数量直接创建 Job 来消费任务             |
| TriggerAuthentication | 触发器连接外部系统的凭证（连接串、token 等），引用 Secret，与资源解耦 |

三个资源的关系：一个 **ScaledObject** 通过 scaleTargetRef 指向一个 Deployment/StatefulSet，通过 triggers 列表声明一个或多个事件源（每个 trigger 可以用 TriggerAuthentication 引用凭证）；KEDA 为每个 ScaledObject **自动创建并接管一个 HPA**，管理员从此不需要手写 HPA。ScaledJob 则绕过常驻副本的概念，直接把队列里的任务变成一批 Job 跑完即走。

### 架构与运作

架构图里有两个关键组件：

- **keda-operator**：核心控制器，watch 所有 ScaledObject/ScaledJob，按 pollingInterval 周期轮询各触发器对应的事件源，拿到指标数据
- **keda-operator-metrics-apiserver**：对外实现 External Metrics 接口，供 HPA 查询指标

一条完整的伸缩链路是这样的：

```text
① ScaledObject 声明触发器（如 RabbitMQ 队列 task-queue）
        │
        ▼
② keda-operator 每 pollingInterval 轮询一次队列，取到"当前积压 30 条任务"
   把外部事件数据转换为 External Metrics 暴露出去
        │
        ▼
③ KEDA 自动创建的 HPA 查询 External Metrics，按目标值计算期望副本数
        │
        ▼
④ 修改 Deployment 副本数（K8s ≥ 1.18 时 behavior 字段仍可控制扩缩节奏）
```

分岔点在第④步，两类扩缩容的执行者不同：**常规的扩缩容由 HPA 完成**（KEDA 只负责把指标喂给它，直接复用了 HPA 全部成熟的能力，所以想"快速扩容、缓慢缩容"就直接配 HPA 的 behavior 字段）；**缩到闲时副本数和从闲时副本数拉起由 KEDA 自己动手**——闲时副本数可以小于 minReplicaCount 直到 0。缩到 0 之后所有 Pod 都没了，谁来感知"流量来了"？就是轮询事件源的 keda-operator：一旦队列再出现消息，它立刻把副本从 0 拉起，之后交给 HPA 接管。这正是"不能缩到 0"那条局限的解法。

每个 ScaledObject 可以配多个触发器，**任何一个触发器判定需要扩容，就按最激进的结果扩**——比如后面秒杀案例里 Cron 定时和 CPU 指标同时配置，活动时间到了先扩够，活动外靠 CPU 兜底。

除了伸缩常驻副本，KEDA 还能用 ScaledJob 处理任务计算类场景，按排队任务数量自动创建 Job 及时消费：

![KEDA任务执行](./images/KEDA-task.png)

## KEDA 的应用场景

### 场景一：周期性波峰——定时扩容

业务有固定的波峰波谷（每天固定时间的秒杀、早晚高峰），最好的策略不是等压力来了再扩，而是**提前扩容等流量**。Cron 触发器用 Cron 表达式声明时间段，区间内副本数抬到 desiredReplicas：

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: seckill
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: seckill
  pollingInterval: 15
  minReplicaCount: 2 # 至少保留 2 个副本
  maxReplicaCount: 1000
  advanced:
    horizontalPodAutoscalerConfig:
      behavior: # 控制扩缩容行为：快速扩容，缓慢缩容
        scaleDown: # 缓慢缩容：至少冷却 10 分钟才能缩
          stabilizationWindowSeconds: 600
          selectPolicy: Min
        scaleUp: # 快速扩容：每 15s 最多扩到 5 倍
          policies:
            - type: Percent
              value: 500
              periodSeconds: 15
  triggers:
    - type: cron # 每天上午 10 点秒杀，前后半小时保证 200 个副本
      metadata:
        timezone: Asia/Shanghai
        start: 30 9 * * *
        end: 30 10 * * *
        desiredReplicas: "200"
    - type: cron # 每天晚上 6 点秒杀
      metadata:
        timezone: Asia/Shanghai
        start: 30 17 * * *
        end: 30 18 * * *
        desiredReplicas: "200"
    - type: memory # 内存利用率超过 60% 扩容（兜底）
      metricType: Utilization
      metadata:
        value: "60"
    - type: cpu # CPU 利用率超过 60% 扩容（兜底）
      metricType: Utilization
      metadata:
        value: "60"
```

两个配置点值得注意。behavior 就是前面说的 HPA 字段，通过 KEDA 透传给自动创建的 HPA，秒杀场景的节奏是"提前扩好、结束慢收"：扩容窗口每 15 秒允许翻 5 倍，缩容则强制冷却 10 分钟——活动刚结束流量不会断崖式下跌，慢慢收刚好。另一个是 **Cron 触发器不能单独用**：在 start/end 区间之外，如果没有任何触发器活跃，副本会跌回 minReplicaCount，秒杀现场的突发流量就没人兜底了，所以必须像上面这样配一组 CPU/内存触发器作保险。

### 场景二：多级微服务同步扩容

多级调用链路上，传统 HPA 的逐级传导又慢又危险——每一级都是被上游压过来的流量"冲垮"后才扩容。KEDA 的解法是让下游**监听上游的副本数**，整条链路按固定比例同步扩容：kubernetes-workload 触发器可以盯住另一个工作负载的 Pod 数量。

假设 A:B:C 的容量比例是 3:3:2。A 按自身压力伸缩（CPU/内存触发器即可，配置和普通 ScaledObject 一样），B 和 C 则监听 A：

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: b
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: b
  pollingInterval: 15
  minReplicaCount: 10
  maxReplicaCount: 1000
  triggers:
    - type: kubernetes-workload
      metadata:
        podSelector: 'app=a' # 盯住 A 服务的 Pod
        value: '1'           # 比例换算：A/B = 3/3 = 1，A 有几个 Pod 我就配几个
```

C 的配置完全一样，只是 value 换成 A/C = 3/2 = 1.5。这样 A 一扩容，B、C 在下一个轮询周期内跟上，**三级几乎同时完成扩容**，压力不再逐级传导，也不存在中间环节被冲垮的窗口期。

### 场景三：任务执行——按积压量伸缩

从消息队列/数据库取任务执行的场景（数据分析、ETL、转码、机器学习推理），伸缩依据天然就是"积压了多少任务"。用 ScaledObject 配一个队列触发器，按积压量伸缩常驻的消费者副本：

```yaml
triggers:
  - type: rabbitmq
    metadata:
      queueName: task-queue
      mode: QueueLength
      value: "10" # 队列每积压 10 条任务，扩一个消费副本
```

如果是长耗时的一次性计算任务，更适合用 **ScaledJob**：不留常驻副本，KEDA 轮询到积压任务后直接创建 Job，任务跑完 Job 退出，队列空了连一个副本都不剩：

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledJob
metadata:
  name: video-transcode
spec:
  jobTargetRef: # 内嵌 Job 的模板，等价于 Job spec 里的 template
    template:
      spec:
        containers:
          - name: worker
            image: transcoder:v1
        restartPolicy: Never
  maxReplicaCount: 20 # 最多同时跑 20 个 Job
  pollingInterval: 30
  triggers:
    - type: rabbitmq
      metadata:
        queueName: video-tasks
        mode: QueueLength
        value: "1" # 每条待处理任务创建一个 Job
```

同一个队列，选 ScaledObject 还是 ScaledJob 的判断标准就一条：**流量是持续的就用常驻副本平滑伸缩，任务是离散的就用 Job 跑完即走**。

### 其他应用

KEDA 的伸缩依据本质上是"任何能查询到的外部数据"，所以玩法远不止上面三类：配 Prometheus 触发器可以直接拿网关统计的 QPS 来伸缩；开发测试环境给服务配上 Cron + 缩到 0，夜间没人用就把资源全部让出去；内置的几十种 Scaler 覆盖了主流的数据库、消息队列和云托管服务，真遇到不接管的系统，还可以按 gRPC 协议自己实现一个 external Scaler 挂进 triggers。

回头看这篇文章的主线：HPA 把"副本数跟着 CPU 走"自动化了，KEDA 把"副本数跟着任何事件走"自动化了——伸缩的决策依据从两个内置指标扩展为整个外部世界的状态，而扩缩容的执行仍然复用 HPA 的成熟机制。配额解决"能用多少"、RBAC 解决"谁能操作"、HPA/KEDA 解决"需要多少"，共享集群的资源管理拼图到这里就完整了。