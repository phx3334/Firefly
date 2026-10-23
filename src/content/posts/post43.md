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
  behavior:                    # 控制扩缩容节奏（autoscaling/v2 才有）
    scaleDown:
      stabilizationWindowSeconds: 300 # 缩容冷却窗口：指标持续低于目标 300 秒才真正缩，默认就是 300（5 分钟）
```

HPA 盯着的那个 `web` Deployment 长这样，关键在 `resources` 这一段：

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  namespace: prod
spec:
  replicas: 2
  selector:
    matchLabels:
      app: web
  template:
    metadata:
      labels:
        app: web
    spec:
      containers:
      - name: web
        image: web:v1
        resources:
          requests:            # HPA 百分比的分母，必须设置
            cpu: 500m
            memory: 256Mi
          limits:              # 只决定容器资源上限，不参与 HPA 计算
            cpu: "1"
            memory: 512Mi
```

这里 requests 是理解 HPA 的关键：Utilization 的分母不是 limit 也不是节点容量，而是 **requests**，所以 `averageUtilization: 80` 的真实含义是"CPU 用量达到 requests 的 80%"。两个生产要点：requests 没设置的话百分比算不出来，HPA 拿到的是 unknown 指标、什么都不做；requests 偏离真实水位，伸缩就会失真——设 100m 但业务实际跑 400m，使用率虚高到 400%，会一直扩到 maxReplicas；设 1000m 实际只跑 100m，使用率永远 10%，永远不会扩容。所以 requests 要按压测结果贴近真实均值来配。

过一遍工作过程。假设当前 3 个副本，平均 CPU 使用率被压到 90%，超过了 80% 的目标，HPA 算出期望副本数 = ceil(3 × 90 / 80) = 4，于是把 Deployment 扩到 4 副本；新副本加入后分摊流量，使用率回落，逐步趋向 80%。缩容同理，流量下降使用率低于目标时反向计算。

但缩容比扩容需要更谨慎——流量抖动是常态，指标跟着抖，如果每次抖动都立刻删 Pod，副本数会反复横跳（抖动），还会误杀正在处理请求的实例。所以 HPA 对缩容有冷却窗口：**指标必须持续低于目标一段时间（默认 5 分钟）才真正缩容**

验证很简单：`kubectl get hpa web-hpa -w` 盯住 REPLICAS 列，对服务压一轮测，能看见副本数从 2 爬上去再降回来的完整过程。

### HPA 的局限

CPU 驱动的伸缩覆盖了"算力型"业务，但真实集群里的伸缩需求远不止这一种，HPA 的短板在与业务对接时会逐个暴露：

**内置指标只有 CPU 和内存两个。** HPA 的 Resource 指标就这两样，想按别的数据伸缩——队列里积压的任务数、网关统计的 QPS、数据库里的记录数——HPA 自己无能为力。

**自定义指标的链路非常重。** 理论上可以装 prometheus-adapter 来实现 HPA 的自定义指标接口：业务先写一个 Exporter 把指标暴露给 Prometheus，adapter 再从 Prometheus 查询转交给 HPA。比如想按"数据库任务表里待执行的任务数"伸缩，就得专门开发部署一个 Exporter 应用、配 Prometheus 采集规则、再配 adapter 的查询映射——三层组件就为了一个数字，而且这个 Exporter 跟着业务走，每换一种事件源就要再写一个。

**副本数最低只能缩到 1，不能到 0。** 对有明显闲时的负载（夜间无人访问的内部系统、定时任务）来说，哪怕一整天没流量也得留一个副本空转，成本降不下去。

**只能被动响应，且只作用于"常驻副本"。** CPU 指标反映的是已经发生的压力，多级微服务里这个滞后会被逐级放大：A 被冲高才扩 A，A 扩完吞吐变大，B 才被冲高……每一级都在等上一级"传染"，全程被动挨打。而对"从队列取任务执行"这类场景，要的不是给常驻服务扩副本，而是**按任务数量动态创建一次性的 Job**——这超出了 HPA 的能力边界。

这四条局限指向同一个缺口：**HPA 只认 CPU/内存、只管常驻副本**。KEDA 的出现就是为了补上它。

## KEDA：事件驱动的弹性伸缩

KEDA 是 CNCF 毕业项目,定位很明确：**不是替代 HPA，而是增强 HPA**。它内置了几十种 Scaler，可以直接对接消息队列、关系型/时序/文档数据库、键值存储、事件总线等外部系统，把"队列长度""待处理任务数""QPS"这类外部事件数据变成 HPA 能理解的伸缩依据，还支持 Cron 定时伸缩和缩到 0。

先看官方架构图建立整体印象：

![KEDA架构图](./images/KEDA-arch.png)

逐个元素对照这张图讲。先看外围：大圆圈是 Kubernetes cluster，右下角的 **External trigger source** 是事件源（RabbitMQ、Kafka、Prometheus 等，图中的闪电符号），左上角的 **ScaledObject** 是我们前面介绍的 CRD——图里它通过 "Register + trigger and scaling definition" 这条线注册到 **Kubernetes API Server**，KEDA 再从 API Server watch 到它，也就是说 ScaledObject 和其他 K8s 资源一样走标准 apiserver 通道，KEDA 不需要单独的注册接口。

再看中间标着 KEDA 的大框，KEDA 运行时由四个子模块组成：

- **Scaler**：负责和 External trigger source 打交道，按周期轮询事件源，把图上那条双向线概括成一句话——"Any events?"（有事件吗？），拿到积压数、QPS 这类原始数据。
- **Metrics adapter**：实现 External Metrics 接口，把 Scaler 查到的数据换算成指标供 **Horizontal pod autoscaler** 查询——图中它专门有一条线连着 HPA。
- **Controller**：执行 HPA 管不了的 0↔1 动作，对应图中灰色的 "0->1 or 1->0"。
- **Admission Webhooks**：校验 ScaledObject/ScaledJob 的合法性，配置写错直接在 apply 时拒绝。

这四个是功能模块，落到部署形态上就是两个 Pod：**keda-operator** 一个进程实现了其中三个（Controller、Scaler、Webhooks），**keda-operator-metrics-apiserver** 单独承担 Metrics adapter——独立成进程是因为它要注册成 apiserver 的聚合层（APIService），得有自己的稳定服务端点供 HPA 查询。

最后看右侧两条颜色不同的执行路径，它们把 KEDA 和 HPA 的分工画得非常清楚：**橙色的 "1->n or n->1" 从 HPA 指向 Workload**——只要副本数在 1 以上，就由 KEDA 自动创建的 HPA 按指标常规伸缩；**灰色的 "0->1 or 1->0" 从 Controller 指向 Workload**——只有涉及到"从 0 拉起"和"缩到 0"时才由 KEDA 的 Controller 亲自出手。两条线在 1 这个数字上交接班，这就是"增强而非替代 HPA"在图上的直接体现。

一句话概括这张图：**KEDA 没有发明新的伸缩执行器，Scaler 负责查事件、Metrics adapter 负责翻译成指标，常规伸缩仍然由 HPA 执行，自己只在 0↔1 这段 HPA 够不着的区间补位**。

### 核心资源

KEDA 通过三个 CRD 把"事件源 → 伸缩"这件事资源化：

| 资源                  | 作用                                                                  |
| --------------------- | --------------------------------------------------------------------- |
| ScaledObject          | 核心资源：指定要伸缩的工作负载 + 触发器列表 + 伸缩范围，管理常驻副本  |
| ScaledJob             | 任务型场景：不伸缩副本，按事件数量直接创建 Job 来消费任务             |
| TriggerAuthentication | 触发器连接外部系统的凭证（连接串、token 等），引用 Secret，与资源解耦 |

三个资源不是孤立的，而是一组分工明确的组合，逐个写出 YAML 来看。

#### ScaledObject：伸缩常驻副本

ScaledObject 是最核心的资源：把"要伸缩的工作负载 + 触发器列表 + 伸缩范围"声明成一个对象。下面的例子实现"RabbitMQ 队列每积压 10 条任务，扩 1 个消费副本"：

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: rabbitmq-scale
  namespace: prod
spec:
  scaleTargetRef:
    name: rabbitmq-consumer      # 同 namespace 下要伸缩的 Deployment/StatefulSet
  pollingInterval: 15            # 每 15s 轮询一次事件源（默认 30s）
  cooldownPeriod: 300            # 指标降到目标以下后，冷却 300s 才开始缩容（默认 300s）
  minReplicaCount: 0             # 闲时允许缩到 0（不写默认 1）
  maxReplicaCount: 20            # 上限 20 个（不写默认 100）
  triggers:                      # 触发器列表，可以声明多个，任一活跃即扩容
  - type: rabbitmq               # type 即 Scaler 种类：rabbitmq/kafka/redis/cron/... 几十种内置
    metadata:
      queueName: task-queue
      mode: QueueLength
      value: "10"
```

这份 YAML 里没有 HPA 的影子——apply 之后 KEDA 会**自动创建并接管一个 HPA**，管理员从此不需要手写 HPA。和上一节手写 HPA 对照：minReplicas/maxReplicas 对应 minReplicaCount/maxReplicaCount，缩容冷却窗口不再写进 behavior，而是 KEDA 提供的 cooldownPeriod。

#### ScaledJob：按任务创建一次性 Job

用一个场景理解它存在的意义：电商平台的商品图要生成缩略图，运营批量上传了 2000 张图，处理任务全部堆进 RabbitMQ 队列。这类负载不想留常驻副本——闲时一天没几条任务，留着空转就是浪费。ScaledJob 的方案是：不部署 Deployment，KEDA 轮询队列发现积压 2000 条，按"1 条任务 = 1 个 Job"批量创建（受 maxReplicaCount 限制同时最多 20 个，跑完一批再放一批）；每个 Job 处理完自己那张图正常退出；队列清空后，集群里连一个相关 Pod 都不剩。

任务型场景绕过"常驻副本"的概念：ScaledJob 不指向任何工作负载，而是内嵌一个 Job 模板，KEDA 轮询到积压任务后直接批量创建 Job，跑完即走：

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledJob
metadata:
  name: img-thumbnail
  namespace: prod
spec:
  jobTargetRef:                  # 内嵌 Job 的模板，等价于 Job spec 里的 template
    template:
      spec:
        containers:
        - name: worker
          image: thumbnailer:v1  # 处理一张图然后退出
        restartPolicy: Never
  pollingInterval: 30
  maxReplicaCount: 20            # 最多同时存在 20 个 Job
  triggers:
  - type: rabbitmq
    authenticationRef:           # 和 ScaledObject 一样，凭证引用 TriggerAuthentication
      name: rabbitmq-auth
    metadata:
      queueName: batch-tasks
      mode: QueueLength
      value: "1"                 # 每条积压任务对应创建 1 个 Job
```

注意 ScaledJob 没有 minReplicaCount——它本来就"不留常驻副本"，队列空了连一个 Job 都不剩。

两者还有个容易忽略的差异：**ScaledObject 借助 HPA 伸缩，ScaledJob 完全不走 HPA**。Job 的创建和删除是 keda-operator 直接执行的（HPA 只会改 Deployment 的 replicas，改不出一次性 Job），所以 ScaledJob 没有 cooldownPeriod、behavior 这些 HPA 概念，只有 pollingInterval 和 maxReplicaCount。除了"常驻副本 vs 一次性 Job"这一点，两者在触发器声明、凭证引用（authenticationRef）上用法完全一致。

#### TriggerAuthentication：凭证与资源解耦

触发器要连外部系统就要凭证（连接串、token）。直接写进 ScaledObject 的 metadata 既不安全也不好复用，TriggerAuthentication 把凭证抽成独立资源，从 Secret 里取值：

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: rabbitmq-auth
  namespace: prod
stringData:
  host: amqp://user:pass@rabbitmq.prod:5672/vhost
---
apiVersion: keda.sh/v1alpha1
kind: TriggerAuthentication
metadata:
  name: rabbitmq-auth
  namespace: prod
spec:
  secretTargetRef:               # 从 Secret 取值，填充 trigger 里缺失的参数
  - parameter: host
    name: rabbitmq-auth          # 引用的 Secret 名
    key: host
```

用的时候在 trigger 里通过 authenticationRef 引用即可：

```yaml
  triggers:
  - type: rabbitmq
    authenticationRef:           # 凭证在这，metadata 里就不用写 host 了
      name: rabbitmq-auth
    metadata:
      queueName: task-queue
      mode: QueueLength
      value: "10"
```

凭证和触发器由此解耦：换环境只换 Secret，ScaledObject 一行不用改。

### 架构与运作
把这套架构落到前面那个 RabbitMQ 消费者的例子上，走一遍完整流程。当前状态：Deployment `rabbitmq-consumer` 运行 2 个副本，队列 task-queue 平时没什么消息。

```text
准备：apply 三个资源（ScaledObject / 触发器 + Secret / TriggerAuthentication）
      keda-operator watch 到 ScaledObject，自动创建一个 HPA 并接管
        │
        ▼
① 业务系统往 task-queue 投了一批任务，队列积压涨到 30 条
        │
        ▼
② 下一个轮询周期（pollingInterval: 15s）到了：
   keda-operator 里的 rabbitmq Scaler 用连接串登录 rabbitmq.prod:5672，
   查询 task-queue 的消息数 → 30 条
        │
        ▼
③ Metrics adapter 把"积压 30 条"暴露成 External Metrics
   自动创建的 HPA 查到指标，按目标值 value=10 计算：
   期望副本数 = ceil(30 / 10) = 3
        │
        ▼
④ HPA 把 rabbitmq-consumer 的 replicas 改成 3，新 Pod 加入分摊任务
   积压被消费下降后，指标回落，副本数趋向"积压 10 条 ÷ 1 副本"的平衡点
```

分岔点在第④步：到底谁来执行伸缩？按副本数区间分成两段。

**minReplicaCount ~ maxReplicaCount 的常规区间，由 HPA 执行。** KEDA 只负责把事件数据变成指标喂给 HPA，公式计算、behavior 节奏控制全部复用 HPA 的成熟能力——所以上一节的 behavior 字段在 KEDA 的 advanced 配置里原样出现，一个字都不用改。

**从 minReplicaCount 再往下直到 0 的区间，由 keda-operator 亲自执行。** 缩到 0 之后 metrics-server 采集不到任何 Pod 指标，HPA 既算不出该扩几个，也感知不到"流量回来了"——它天生是为常驻副本设计的，这段只能 KEDA 自己动手：在这个例子里，operator 轮询发现 task-queue 持续空闲（且过了 cooldownPeriod 冷却期），就把副本从 minReplicaCount 一路缩到 0；之后运营再批量投 30 条任务进来，下一个轮询周期 operator 立刻把副本从 0 拉到 1（激活），再交给 HPA 按公式接手（30 ÷ 10 = 3）。这正是"不能缩到 0"那条局限的解法。

每个 ScaledObject 可以配多个触发器，**任何一个触发器判定需要扩容，就按最激进的结果扩**——比如后面秒杀案例里 Cron 定时和 CPU 指标同时配置，活动时间到了先扩够，活动外靠 CPU 兜底。

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
      authenticationRef: # 凭证引用方式与 ScaledObject 相同
        name: rabbitmq-auth
      metadata:
        queueName: video-tasks
        mode: QueueLength
        value: "1" # 每条待处理任务创建一个 Job
```

轮询 → 按积压量创建 Job → 任务跑完退出，两类资源的完整工作过程如图：

![KEDA任务执行](./images/KEDA-task.png)

同一个队列，选 ScaledObject 还是 ScaledJob？先看相同点：**触发器声明和凭证引用的用法完全一致**——triggers 里都是 `type + metadata + authenticationRef`，连同一个 TriggerAuthentication 都可以共用。差异在伸缩机制这一层：

| | ScaledObject | ScaledJob |
| --- | --- | --- |
| 伸缩对象 | 已存在的 Deployment/StatefulSet 常驻副本 | 不指向任何工作负载，直接创建 Job |
| 执行者 | KEDA 自动创建的 HPA | keda-operator 亲自创建/删除 Job |
| 字段 | minReplicaCount / cooldownPeriod / behavior | 只有 pollingInterval / maxReplicaCount |
| 伸缩结果 | 改 replicas，Pod 永远在（可缩到 0） | Job 跑完自己退出，队列空了什么都不剩 |
| 中断风险 | 缩容会删 Pod，正在处理的任务被中断 | Job 有完成态，KEDA 只创建不杀 |

应用时机按业务形态判断：**流量是持续的、服务要一直在线**（API 网关后面的消费者、流式处理），用 ScaledObject，副本数平滑跟随负载；**任务是离散的、一任务一进程**（转码、ETL、批量推理），用 ScaledJob，任务跑完即走。再加一条经验砝码：单条任务**耗时长、中断代价高**（一跑几小时），ScaledObject 缩容删 Pod 会让半成品作废，ScaledJob 的完成态语义天然免疫这个问题，更要选它。

### 其他应用

KEDA 的伸缩依据本质上是"任何能查询到的外部数据"，所以玩法远不止上面三类：配 Prometheus 触发器可以直接拿网关统计的 QPS 来伸缩；开发测试环境给服务配上 Cron + 缩到 0，夜间没人用就把资源全部让出去；内置的几十种 Scaler 覆盖了主流的数据库、消息队列和云托管服务，真遇到不接管的系统，还可以按 gRPC 协议自己实现一个 external Scaler 挂进 triggers。

回头看这篇文章的主线：HPA 把"副本数跟着 CPU 走"自动化了，KEDA 把"副本数跟着任何事件走"自动化了——伸缩的决策依据从两个内置指标扩展为整个外部世界的状态，而扩缩容的执行仍然复用 HPA 的成熟机制。配额解决"能用多少"、RBAC 解决"谁能操作"、HPA/KEDA 解决"需要多少"，共享集群的资源管理拼图到这里就完整了。