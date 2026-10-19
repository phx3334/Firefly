---
title: pod调度和k8s资源的隔离与分配
published: 2026-10-19T20:11:23+08:00
description: 学习如何调整pod的调度策略，如何隔离，限制k8s集群的资源
image: './images/a41.avif'
tags: [k8s]
category: '计算机技术'
draft: false
lang: '中文'
---



## pod调度
### 亲和性和反亲和性
#### 解决的问题

默认情况下，调度器只关心"资源够不够"，不关心"分布合不合理"。把一个服务的 5 个副本全调度到同一个节点上，资源是够了，但这个节点一挂，服务整体不可用——这就是单点故障。

K8s 本身自带一定的高可用能力：节点故障后，控制器会在其他节点重建该节点上的 Pod。但这只是"恢复"，不是"预防"——副本都挤在一个节点上时，故障瞬间服务就整体不可用了。默认机制不够，需要额外策略增强。

再比如实际生产中的其他诉求：
- 集群里有高性能节点和普通节点，希望核心服务优先跑在高性能节点上
- 服务有网络要求，希望调度到特定子网或机房
- 前端服务希望和缓存服务部署在同一个可用域，降低访问延迟

**亲和性和反亲和性就是让 Pod 按照我们的意图"靠近"或"远离"某些节点/Pod 的调度机制**，核心价值是提升服务高可用性。

#### 三种亲和力

| 类型 | 理解 | 典型场景 |
| ---- | ---- | -------- ||
| 节点亲和性 nodeAffinity      | Pod 想去什么样的节点 | 优先调度到高性能节点、特定机房节点 |
| Pod 亲和性 podAffinity       | 和哪些 Pod 待在一起  | 与 cache 服务同可用域，降低延迟    |
| Pod 反亲和性 podAntiAffinity | 和哪些 Pod 分开      | 同一服务多副本分散到不同节点       |
每种类型也都有 preferred 和 required 两种策略。一种是优先调度，一种是必须按照要求调度，否则pod起不来。

#### preferred 和 required 怎么选

两种策略的核心区别就一条：**约束满足不了时怎么办**。

- **preferred（软策略）**：调度器尽量满足，实在满足不了就忽略约束，Pod 照常调度。适合"优化型"诉求——希望跑在高性能节点上、希望和某服务同可用区，即使没满足也不影响服务正常上线。
- **required（硬策略）**：必须满足，集群里找不到满足条件的节点，Pod 就一直 Pending。适合"边界型"诉求——GPU 任务必须去 GPU 节点（去了普通节点根本跑不了）、同一服务的副本必须分开（不分开高可用就失去意义）。

实际生产中 preferred 确实用得更多，因为它"兜底友好"：资源紧张、节点被占、标签漏打时，软策略自动退化为普通调度，服务照样跑得起来。required 的风险在于约束写错、或集群里根本没有满足条件的节点时，Pod 卡 Pending 且排查成本高，所以用 required 前要先确认节点标签真实存在、且有足够容量满足条件。

一个简单的判断标准：不满足约束，部署就"失去意义"的用 required；只是"希望更好"的用 preferred。

#### 亲和性配置示例

以下示例只展示关键部分，都配置在 Pod 模板的 `spec.affinity` 字段下。

节点亲和性：required 保证只能跑在 amd64 架构的节点上，preferred 尽量调度到打有 `node-type=high-performance` 标签的节点，weight 越大优先级越高（1~100）。

```yaml
spec:
  affinity:
    nodeAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        nodeSelectorTerms:
        - matchExpressions:
          - key: kubernetes.io/arch
            operator: In
            values: ["amd64"]
      preferredDuringSchedulingIgnoredDuringExecution:
      - weight: 80
        preference:
          matchExpressions:
          - key: node-type
            operator: In
            values: ["high-performance"]
```

Pod 亲和性与反亲和性：required 要求和 cache 服务同可用区（降低访问延迟），preferred 尽量让本服务的副本按节点打散（避免单点故障）。注意 Pod 亲和/反亲和必须搭配 topologyKey，表示"在同一个拓扑域内"满足靠近/远离条件。

```yaml
spec:
  affinity:
    podAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
      - labelSelector:
          matchExpressions:
          - key: app
            operator: In
            values: ["cache"]
        topologyKey: topology.kubernetes.io/zone
    podAntiAffinity:
      preferredDuringSchedulingIgnoredDuringExecution:
      - weight: 100
        podAffinityTerm:
          labelSelector:
            matchExpressions:
            - key: app
              operator: In
              values: ["web"]
          topologyKey: kubernetes.io/hostname
```
| operator       | 含义               | 需要 values 吗 |
| -------------- | ------------------ | -------------- |
| `In`           | 键的值在给定列表里 | 要             |
| `NotIn`        | 键的值不在列表里   | 要             |
| `Exists`       | 键存在（值无所谓） | 不要           |
| `DoesNotExist` | 键不存在           | 不要           |
| `Gt`           | 值大于（数值比较） | 要             |
| `Lt`           | 值小于（数值比较） | 要             |

两种策略的字段名规律很统一：硬策略叫 `requiredDuringSchedulingIgnoredDuringExecution`，软策略叫 `preferredDuringSchedulingIgnoredDuringExecution`。后半段的 IgnoredDuringExecution 意思是调度完成后节点条件变化（比如节点标签被改）不会驱逐已运行的 Pod，只影响新 Pod 的调度。   
### 拓扑域

拓扑域不是 K8s 里的独立对象，而是**由节点标签定义的调度粒度单位**：topologyKey 指定标签的 key，所有"这个 key 的 value 相等"的节点构成同一个拓扑域。调度器做打散（反亲和、拓扑分布约束）或聚拢（亲和）计算时，都是以拓扑域为单位进行的。

判断标准：**节点的标签 key 和 value 都相等，才算同一个拓扑域**，value 不同就是不同的域。同一个集群，选不同的 topologyKey，域的粒度完全不同：

| topologyKey                   | 含义   | 域的粒度                     |
| ----------------------------- | ------ | ---------------------------- |
| kubernetes.io/hostname        | 节点名 | 每台节点一个域，最细         |
| topology.kubernetes.io/zone   | 可用区 | 同可用区的节点合成一个域     |
| topology.kubernetes.io/region | 地域   | 同地域的节点合成一个域，最粗 |

举例：集群 6 台节点，node1~node3 的 zone 标签是 zone-a，node4~node6 是 zone-b。topologyKey 取 zone 标签时全集群只有 2 个拓扑域；换成 hostname 标签则有 6 个域。前面反亲和示例中 topologyKey 用 hostname 就是"按节点打散"，用 zone 就是"按可用区打散"。

一个常见坑：**节点上必须真的存在 topologyKey 指定的标签**，没有该标签的节点不参与拓扑域计算——对拓扑分布约束来说该节点会被直接跳过，对 required 的亲和/反亲和来说可能导致 Pod 永远无法调度。云厂商自动纳管的节点一般自带 zone/region 标签，自建集群需要自己维护。

常用命令：

```bash
# 查看节点全部标签
kubectl get nodes --show-labels

# 按拓扑维度查看节点分布，-L 直接把指定标签的值按列展示
kubectl get nodes -L topology.kubernetes.io/zone

# 节点缺少拓扑标签时手动补打
kubectl label nodes node1 topology.kubernetes.io/zone=zone-a

# 查看服务副本在节点上的实际分布，验证打散效果
kubectl get pods -l app=example -o wide
```

### 举例
应用均匀分布在不同的机房
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: example-deployment
spec:
  replicas: 3
  selector:
    matchLabels:
      app: example
  template:
    metadata:
      labels:
        app: example
    spec:
      topologySpreadConstraints:
      - maxSkew: 1
        whenUnsatisfiable: DoNotSchedule
        topologyKey: kubernetes.io/hostname
        labelSelector:
          matchLabels:
            app: example
      containers:
      - name: example
        image: registry.cn-beijing.aliyuncs.com/dotbalo/nginx:1.15.12
```
- topologySpreadConstraints：拓扑域约束配置，可以是多个副本均匀分布在不同的域中，配置多个时，需要全部满足
- maxSkew：指定允许的最大偏差。例如，如果maxSkew设置为1，那么在任何拓扑域中，副本的数量最多只能相差1
- whenUnsatisfiable：指定当无法满足拓扑约束时的行为。DoNotSchedule：不允许调度新的Pod，直到满足约束。ScheduleAnyway：即使不满足约束，也允许调度新的Pod
- topologyKey：指定拓扑域的键
- labelSelector：指定要应用拓扑约束的Pod的标签选择器，通常配置为当前Pod的标签



### 污点和容忍度
#### 什么是污点（Taint）
污点是打在 Node 上的标记，告诉调度器："这个节点有特殊要求，普通 Pod 别往我这放"。  
默认情况下，调度器会把 Pod 分配到任意满足条件的节点。但有些节点"不欢迎"普通 Pod，比如：  
- 主节点：要跑控制面组件，不希望被业务 Pod 打扰
- 专用节点：只跑 GPU 任务，不希望普通任务来抢资源
- 故障节点：磁盘要坏了，别再往这调度了
**污点就是实现这种"拒绝/限制调度"的机制**。
| effect           | 中文理解     | 对未调度 Pod                       | 对已在跑的 Pod                 |
| ---------------- | ------------ | ---------------------------------- | ------------------------------ |
| NoSchedule       | 一定不被调度 | 新 Pod 不调度过来                  | 不影响                         |
| PreferNoSchedule | 尽量不被调度 | 尽量不调度（资源不足时可能调过来） | 不影响                         |
| NoExecute        | 驱赶         | 新 Pod 不调度过来                  | 驱逐节点上已有的、不容忍的 Pod |
#### 解决的问题

上一节的亲和性站在 Pod 视角："我想去什么样的节点"。污点反过来，站在 Node 视角："我不欢迎什么样的 Pod"。实际生产里需要节点侧机制的场景主要有五类：

**节点故障快速恢复。** K8s 原生就有故障自愈：节点故障后 Pod 会自动迁移重建，天生具备、无需配置。但默认有约 5 分钟的容忍窗口——每个 Pod 会自动携带对故障污点的容忍，tolerationSeconds 默认 300 秒，期间服务持续受影响。目标是把恢复压到秒级或分钟级，办法就是把这个容忍的 tolerationSeconds 调小（比如 30 秒）：故障节点被打上 not-ready / unreachable 的 NoExecute 污点后，Pod 很快被驱逐、在其他节点重建。这里的关键动作是"驱逐"，而亲和性只影响新 Pod 调度到哪，对已运行的 Pod 毫无办法（就是前面说的 IgnoredDuringExecution），所以故障恢复只能靠污点机制。

**特殊资源不浪费。** GPU 节点资源昂贵稀缺，Master 节点承担控制面角色，都不希望被普通 Pod 占用——否则没有 GPU 需求的 Pod 占着 GPU 节点，真正需要 GPU 的任务反而无法调度。给这类节点打上 NoSchedule 污点后，默认所有 Pod 都调度不上去，只有显式带容忍的 GPU 任务能落上去。如果用亲和性解决，就得给集群里每一个 Deployment 都补一条"不去 GPU 节点"的 nodeAffinity 反向规则——漏掉任何一个（新上的服务、第三方模板、临时测试任务）它都会落上去。污点把"拒绝"收敛到节点侧一处配置，默认全拒、显式放行，维护成本从所有工作负载降到少数特殊任务。

**节点维护不影响服务。** 升级系统、内核或修复漏洞都需要重启节点，标准流程是：kubectl drain 先把节点上的 Pod 驱逐迁移，kubectl cordon 禁止新 Pod 调度上来，维护完成后再 uncordon 恢复。cordon 的本质就是打上 unschedulable 的 NoSchedule 污点，drain 的本质是 NoExecute 驱逐——无损维护的两个关键动作都是污点实现的。亲和性是 Pod 侧的选择规则，根本没有"让某个节点暂停调度"的开关。

**新增节点可用性保障。** K8s 支持随时弹性扩容节点，但新节点刚入集群、未经测试就直接接业务有稳定性风险。先打上类似 status=testing 的 NoSchedule 污点挡住调度，测试通过后删掉污点放行。整个过程只操作节点一个对象，所有工作负载零改动。

**多租户隔离。** 公有云大规模集群面向多用户，需要把大集群划分成小资源池：给租户 A 的节点打 tenant=a:NoSchedule 污点，租户 A 的服务带对应容忍，租户 B 的服务自然进不去，反向同理。用亲和性做的话，每个租户的每个服务都要写"排除其他租户节点"的规则，租户一多规则就互相纠缠。另外注意容忍只是调度层面的隔离，不是安全边界——租户若能改自己的 Pod 就能自己加容忍，硬隔离还要配合 namespace 和 RBAC。

五个场景的共同点是：**约束的主体是节点**。亲和性的规则写在每个 Pod 上，管理成本随工作负载线性增长，而且只管新 Pod 的调度；污点的规则打在节点上，一处配置对全集群生效，默认拒绝、显式放行，NoExecute 还能覆盖"驱逐已在跑的 Pod"这个亲和性完全做不了的动作。K8s 自己也是这么做的：故障节点的 not-ready 污点、Master 的 control-plane 污点，用的都是这套机制。

#### 什么是容忍度（Toleration）

污点打在节点上，容忍写在 Pod 上，两者是配套机制：污点负责"拒绝"，容忍负责"放行"。节点打了污点后默认拒绝所有 Pod，只有 Pod 显式声明了自己能"容忍"这个污点，才被允许调度到该节点（NoSchedule/PreferNoSchedule），或被允许继续留在该节点上（NoExecute）。

| 字段              | 说明                                                                             |
| ----------------- | -------------------------------------------------------------------------------- |
| key               | 要容忍的污点的键                                                                 |
| operator          | Equal：key 的值必须等于 value（默认值）；Exists：只要 key 存在即容忍，value 不填 |
| value             | 配合 Equal 使用                                                                  |
| effect            | 匹配的污点 effect，留空表示容忍该 key 的所有 effect                              |
| tolerationSeconds | 仅对 NoExecute 生效：被驱逐前的宽限时间，到点才真正驱逐                          |

注意 operator 默认是 Equal，但实践中更常用 Exists——容忍不关心污点的值，只关心有没有这个 key，语义更简单也不容易因为值改动而失效。

还有一个最容易踩的误区：**污点+容忍只做"排除"，不做"选中"**。给 GPU 节点打污点、给 GPU 任务加容忍，效果是"普通 Pod 进不来"，而不是"GPU 任务只能去这"——加了容忍的 Pod 依然可能被调度到任何普通节点。如果要求 GPU 任务必须落在 GPU 节点上，必须搭配 nodeAffinity 或 nodeSelector。完整的专属节点方案是三件套配合：污点挡住别人、容忍放行自己、亲和性选中自己。


#### 实战举例

节点侧打污点用 kubectl taint 命令：

```bash
# 给 GPU 节点打污点：key=gpu，value=true，effect=NoSchedule
kubectl taint nodes node1 gpu=true:NoSchedule

# 查看节点上的污点
kubectl describe node node1 | grep Taints

# 删除污点：在 key+effect 后面加减号
kubectl taint nodes node1 gpu=true:NoSchedule-
```

Pod 侧的容忍配置，对应上面的 GPU 污点：

```yaml
spec:
  tolerations:
  - key: "gpu"
    operator: "Equal"
    value: "true"
    effect: "NoSchedule"
```

节点故障快速恢复的容忍，把默认 5 分钟的驱逐窗口压到 30 秒（not-ready 和 unreachable 两个污点都要写）：

```yaml
spec:
  tolerations:
  - key: "node.kubernetes.io/not-ready"
    operator: "Exists"
    effect: "NoExecute"
    tolerationSeconds: 30
  - key: "node.kubernetes.io/unreachable"
    operator: "Exists"
    effect: "NoExecute"
    tolerationSeconds: 30
```

- 第一个例子解决"进入特殊节点"：污点挡住普通 Pod，容忍放行 GPU 任务
- 第二个例子解决"快速驱逐"：节点故障被自动打上 NoExecute 污点后，Pod 等待 tolerationSeconds 就被驱逐重建，而不是默认的 300 秒


## 资源隔离与分配

### 为什么需要资源隔离与分配

前面的调度章节解决的是"Pod 放到哪个节点合适"，这一章解决的是"集群资源怎么分"。默认情况下 K8s 的资源是先到先得，没有任何隔离：

- 不写 resources 的 Pod 可以无限吃节点资源，一个失控的内存型服务就能拖垮同节点上的所有服务
- 多团队共享集群时，先部署的团队抢占资源，后上线的核心业务反而调度不上去
- 开发/测试/生产混部在一个集群，测试环境的压测直接把生产服务挤垮

这些问题调度器管不了——调度器只保证"调度那一刻资源够"，不保证"以后一直够"，更不保证"大家分得公平"。资源隔离与分配就是补上这块的三重机制：

| 机制          | 作用层级     | 一句话理解                         |
| ------------- | ------------ | ---------------------------------- |
| ResourceQuota | namespace 级 | 一个团队/环境总共最多能用多少      |
| LimitRange    | Pod/容器级   | 单个容器默认申请多少、上下限是多少 |
| QoS           | Pod 级       | 资源紧张时先牺牲谁                 |

ResourceQuota 管"总量"，LimitRange 管"单份规格"，QoS 管"紧张时的牺牲顺序"，三者叠加才能把共享集群的资源分配理顺。

### ResourceQuota

解决的问题：防止单个团队占用过量资源导致集群整体资源紧张。它给 namespace 设一道资源预算天花板，namespace 里所有 Pod、PVC 加起来的申请量不能越过这道线。

实施维度：

- 租户隔离：给不同团队/用户组各分一个 namespace，各设各的配额
- 环境控制：开发、测试、生产环境 namespace 的配额不同，生产更高
- 资源天花板：namespace 整体的 CPU/内存/存储总量和对象数量上限

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: team-a-quota
  namespace: team-a
spec:
  hard:
    requests.cpu: "4"
    requests.memory: 8Gi
    limits.cpu: "8"
    limits.memory: 16Gi
    pods: "20"
    requests.storage: 100Gi
```

- hard：配额上限，限制 requests 总量、limits 总量、Pod 数量、存储总量，还可以限制 Service、PVC 等对象的数量

几个关键行为：

- 超配额直接拒绝：创建对象时 API Server 校验，超了返回 403 Forbidden，不是排队等待
- 隐性强制声明资源：namespace 一旦启用计算资源配额，所有 Pod 必须显式写 requests/limits，否则创建被拒——这正是引出下一节 LimitRange 的问题
- 动态调整：直接修改 hard 字段即可，应对业务扩张或收缩；核心业务 namespace 分更高配额（分级管理）

查看配额使用情况：

```bash
kubectl get resourcequota -n team-a
# describe 能看到 Used 和 Hard 的对比
kubectl describe resourcequota team-a-quota -n team-a
```
### LimitRange

解决的问题：ResourceQuota 是 namespace 的总量天花板，管不了单个 Pod 的规格——总量 8Gi 的 namespace，第一个 Pod 就能一口气申请走 8Gi，总量控得再好，单份规格失控照样出问题。另外上一节提到配额启用后每个 Pod 都必须写资源声明，逐个写太繁琐。LimitRange 在 Pod/容器级做细粒度约束：给不写资源的 Pod 自动填充默认值，给写了资源的 Pod 校验上下限。

```yaml
apiVersion: v1
kind: LimitRange
metadata:
  name: team-a-limits
  namespace: team-a
spec:
  limits:
  - type: Container
    defaultRequest:        # 容器没写 requests 时自动填充
      cpu: 100m
      memory: 128Mi
    default:               # 容器没写 limits 时自动填充
      cpu: 500m
      memory: 512Mi
    max:                   # 创建时校验，超过上限直接拒绝
      cpu: "2"
      memory: 2Gi
    min:                   # 低于下限直接拒绝
      cpu: 50m
      memory: 64Mi
  - type: PersistentVolumeClaim
    max:
      storage: 20Gi        # 限制单个 PVC 容量，防止存储滥用
    min:
      storage: 1Gi
```

关键行为：

- 自动填充发生在 Pod 创建时，值写进容器的 resources 字段，之后 kubectl describe 可以看到
- 校验发生在创建/更新时（admission 阶段），不合规直接报错，Pod 起不来
- 除了容器，还能约束 PVC 的存储大小，防止超大盘把集群存储吃满

与 ResourceQuota 的配合：RQ 定总量、LR 定单份规格，LR 的 defaultRequest 还顺带解决了"Pod 没写 requests 导致配额校验失败"的问题——两者通常成对部署在每个 namespace。

### QoS

解决的问题：节点资源不足（主要是内存压力）时，kubelet 必须驱逐一部分 Pod 保住节点，先驱逐谁？总不能随机杀。QoS（Quality of Service）就是给 Pod 自动分级的机制，等级决定驱逐顺序。

QoS 不需要手动配置，K8s 根据容器的 requests/limits 声明方式自动判定：

| QoS 等级   | 判定条件                                                              | 理解                   |
| ---------- | --------------------------------------------------------------------- | ---------------------- |
| Guaranteed | 每个容器的 CPU 和内存都设了 requests 和 limits，且 requests == limits | 绝对保障型             |
| Burstable  | 设了 requests 或 limits，但不满足 Guaranteed 条件                     | 弹性型，允许短期超用   |
| BestEffort | 完全不设 resources                                                    | 尽力而为型，无任何保证 |

三档的配置对比：

```yaml
# Guaranteed：requests 与 limits 完全相等
resources:
  requests:
    cpu: 500m
    memory: 512Mi
  limits:
    cpu: 500m
    memory: 512Mi

# Burstable：requests 小、limits 大，给突发流量留空间
resources:
  requests:
    cpu: 100m
    memory: 128Mi
  limits:
    cpu: 500m
    memory: 512Mi

# BestEffort：不写任何 resources，生产环境禁止
```

驱逐顺序：内存紧张时 BestEffort 最先被驱逐，Burstable 次之，Guaranteed 尽量不动。同等级内部再看"实际用量超出 request 的程度"——超得越多越先被驱逐。节点内存耗尽触发内核 OOM Killer 时，也是按同样的思路给进程打分。

要点：

- 驱逐主要看内存。CPU 是可压缩资源，不够了只会限流（throttle），不触发驱逐
- BestEffort 的真实代价：平时没事，资源一紧张第一批被杀，稳定性看运气。生产环境应杜绝
- Burstable 是生产最常用的形态：request 按日常用量申请（调度器按它算），limit 放大给突发流量留空间——这正是调度章节说的"request 决定能调度到哪、limit 决定最多能用多少"的具体落地
- 核心服务（数据库、网关）建议 Guaranteed，代价是资源利用率偏低

查看 Pod 的 QoS 等级：

```bash
kubectl get pods -o custom-columns=NAME:.metadata.name,QOS:.status.qosClass
```