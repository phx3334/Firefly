---
title: Istio
published: 2026-10-25T20:11:23+08:00
description: 理解 Istio 服务网格的架构与核心资源，掌握流量治理的常见应用场景
image: './images/a45.avif'
tags: [k8s]
category: '计算机技术'
draft: false
lang: '中文'
---



## 服务网格简介

### 服务网格是什么

**服务网格（Service Mesh）是把"服务间网络通信"这件事从业务代码里抽出来，下沉到一个独立的基础设施层**。Istio 是这个领域的事实标准实现，其架构只有两个角色：

- **数据平面（Data Plane）**：每个 Pod 里注入一个 **Sidecar 代理（Envoy）**，应用的所有进出流量都被它劫持转发——所有服务间的连接交织起来，形似一张"网"，这就是"网格"名字的由来。
- **控制平面（Control Plane）**：**istiod**，负责把用户写的流量规则（VirtualService 等 CR）翻译成 Envoy 配置、下发给所有 Sidecar，并维护服务发现、证书签发。

```text
传统模式：app-a 的代码 ──(SDK 处理重试/熔断/TLS)──→ app-b 的代码

网格模式：app-a 的代码 ──→ 本 Pod 的 Envoy Sidecar ──(mTLS)──→ app-b 的 Envoy Sidecar ──→ app-b 的代码
                              ↑                        ↑
                              └──── istiod 统一下发规则 ─┘
```

关键认知：**业务代码感知不到 Sidecar 的存在**——应用以为自己在直连对方，实际上流量被透明劫持。这个"透明"正是服务网格最大的卖点，也解释了它的收益和代价（后文展开）。

### mTLS是什么

mTLS（双向 TLS）是普通 TLS 的加强版，区别只在握手阶段：

| | 普通 TLS（浏览器访问网站） | mTLS（服务网格内） |
| ---- | ---- | ---- |
| 客户端验服务端 | ✅ 服务端出示证书 | ✅ 服务端出示证书 |
| 服务端验客户端 | ❌ 任意客户端都能连 | ✅ **客户端也必须出示证书** |
| 防什么 | 防窃听、防冒充服务端 | 额外防"不明身份的服务混进来" |

**Istio 中如何落地**：Citadel（istiod 内的证书模块，见下文）用根证书的私钥给每个 Pod 签发一张 X.509 证书，证书里绑定的身份是该 Pod 的 serviceaccount。两个 Pod 通信时，双方 Sidecar 各自出示证书验证对方身份——**身份来自 K8s 的 serviceaccount，而不是 IP**，Pod 漂移换 IP 身份不变，这正是零信任网络的基础。

**应用场景**：

1. **服务间加密**：内网明文通信的时代结束了——一台 Pod 被入侵后抓包即可看到所有敏感数据，mTLS 让链路上全是密文。
2. **服务身份认证**：连接方必须证明"我是支付服务"，无证书的陌生 Pod 根本握不上手，横向渗透被阻断在握手阶段。
3. **细粒度授权的依据**：支付服务只想让结账服务调它。开了 mTLS 后写一条 AuthorizationPolicy 限定调用方身份为 `sa/checkout`；此时黑客拿下了内网另一台 Pod，它没有（也伪造不了）checkout 的证书。
```yaml
rules:
- from:
  - source:
      principals: ["cluster.local/ns/prod/sa/checkout"]   # 只认 serviceaccount 为 checkout 的调用方
  to:
  - operation:
      paths: ["/api/pay"]                                  # 只许调支付接口
```

### 服务网格可以解决哪些问题

微服务把一个进程拆成几十个服务后，"调一次接口"从函数调用变成了跨越网络的远程调用，原来根本不存在的问题全冒出来了。逐个看，每个问题对应网格的一个能力：

| 微服务引入的问题 | 没有网格时的解法 | 网格的解法 |
| ---- | ---- | ---- |
| 服务间明文通信，内网被攻破即裸奔 | 业务代码里集成 mTLS SDK，每个服务改一遍 | Sidecar 间自动 mTLS，**业务代码零改动** |
| 重试、超时、熔断、限流每个服务自己写 | 沉淀公共 SDK，但多语言团队版本各自漂移 | istiod 下发策略，Envoy 统一执行 |
| 灰度发布只能靠 K8s 的随机负载均衡 | 入口网关写复杂的权重路由脚本 | VirtualService 按 90/10 权重精确切流 |
| 排障时不知道请求在服务间怎么走的 | 每个服务自己埋 OTel SDK（post30 做过） | Sidecar 转发流量时自动记录每次调用的延迟、状态码、上下游服务名，自动产出指标和调用链 |

一句话总结收益边界：**网格统一收编了"跨横切面的流量治理"（安全/路由/观测），代价是每个 Pod 多一个 Envoy、多一跳代理的资源和延迟**。小规模微服务（几个服务、单一团队）上 SDK + K8s 原生能力就够；服务数量上规模、多语言、多团队共用平台时，网格的边际收益才盖过成本——先想清楚自己的规模再决定是否引入。


## Istio架构

前文从"能解决什么问题"的视角看了服务网格，现在进入 Istio 内部，看它靠什么实现这些能力。

![Istio 架构：左侧控制平面 istiod（Pilot 配置下发、Citadel 证书签发、Galley 配置校验），右侧数据平面由注入 Envoy Sidecar 的业务 Pod 组成，流量在 Sidecar 之间直接传输，控制平面只下发配置不碰流量](./images/Istio-arch.png)

对照上图，两条铁律贯穿 Istio 的所有设计：

- **控制平面（istiod）只下配置、不碰流量**：用户写流量规则 → istiod 翻译 → 下发给所有代理，数据流量永远不经过 istiod。
- **数据平面靠 Envoy 劫持流量做决策**：没有网格时，网络无法理解流量、也无法按流量类型/来源/目的地做决策；Envoy 负责补上这一层。

### 控制平面istiod内部组成

之前，Pilot、Citadel、Galley 是三个独立部署的控制平面组件，后来合并进了一个二进制——**istiod**。所以今天在集群里只有一个 istiod Deployment，但内部仍保留这三个逻辑模块（老架构图仍按它们分开画）：

| 模块 | 职责 | 关键词 |
| ---- | ---- | ---- |
| **Pilot** | Watch 所有流量 CR（VirtualService/DestinationRule/ServiceEntry），翻译成 xDS 配置下发给 Envoy；同时维护服务发现（对接 K8s API Server） | 配置翻译 + 流量下发，istiod 的**大脑** |
| **Citadel** | 签发和管理 SPIFFE 身份证书：给每个 Pod/工作负载发 X.509 证书，支撑自动 mTLS 的双向认证 | 身份与证书，mTLS 的**信任根** |
| **Galley** | 配置的校验与转发层：校验用户提交的 CR 合法性（写错字段直接拒绝），再分发给 Pilot | 配置的**质检员** |

三者各管一段：**Galley 收配置 → Pilot 翻译成 xDS 推给数据面；Citadel 另一条线发证书给数据面**。合并成 istiod 的动机就是简化部署——三个组件拆开时版本对齐、互相调用都是运维负担。

排查问题时的对应关系：路由不生效查 Pilot 的翻译结果（`istioctl proxy-config`，见下文）；mTLS 握手失败查 Citadel 发的证书（`istioctl proxy-config secret`）；CR 提交被拒、无效果但没报错，先看 Galley 的校验日志。

### Sidecar和Ambient模式

**Sidecar 模式**：每个 Pod 注入一个 Envoy，功能全、链路长。**Ambient 模式**：Istio 1.24 起正式 GA 的新架构，把"代理"从 Pod 里搬了出来，分两层：

- **ztunnel（必选，L4）**：每个**节点**一个 Rust 写的代理，DaemonSet 部署。负责 mTLS 加密和 L4 遥测，节点上所有 Pod 的流量都汇聚到它，**Pod 里不再注入任何东西**。
- **waypoint（可选，L7）**：按需部署的 Envoy 代理（通常每个 namespace 或每个 Service 一个）。只有需要 L7 能力（HTTP 路由、金丝雀切流、AuthorizationPolicy 按 header 授权）的流量才显式指向它，不需要的服务就停在 ztunnel 的 L4 层。

| 维度 | Sidecar 模式 | Ambient 模式 |
| ---- | ---- | ---- |
| 代理位置 | 每个 Pod 一个 Envoy | 节点级 ztunnel + 按需 waypoint |
| 资源开销 | 每个 Pod 常驻一份代理（CPU/内存随 Pod 数线性增长） | 大幅降低，ztunnel 全节点共享 |
| 升级/发布 | 代理与应用**耦合**：Envoy 升级要滚动重启全部业务 Pod | **解耦**：ztunnel/waypoint 升级与业务无关 |
| 接入方式 | 注入（namespace 加 label 或手动 inject） | namespace 加 `istio.io/dataplane-mode=ambient` label |
| L7 功能 | 全量，开箱即得 | 默认只有 L4，L7 需显式加 waypoint |
| 成熟度 | 多年生产验证，生态/排障资料最全 | GA 时间不长，生产案例仍在积累 |

### 实际选型：Sidecar还是Ambient

选型回答三个问题即可：

1. **L7 需求占多少？** Ambient 省钱的前提是流量停在 L4。如果几乎每个服务都要 HTTP 路由、header 授权，那就全得再挂 waypoint——代理没省下来还多一跳，不如直接用 Sidecar。
2. **规模有多大？** 3000 Pod 的集群（约百节点），Sidecar 约 **600 核**纯代理开销（0.2C/Pod 线性增长），Ambient 每节点一个 ztunnel 合计只要约 **6 核**——规模越大 Ambient 收益越明显，几十个 Pod 的小集群差距不大。
3. **能否接受新技术风险？** Sidecar 的坑社区踩了七八年，排障资料全；Ambient 出问题要分层查 ztunnel/waypoint，团队没积累时排障明显变慢。

| 你的情况 | 建议 |
| ---- | ---- |
| 首次上网格 / 几百 Pod 以内 | **Sidecar**（资料全、有人陪踩坑） |
| 大规模、多数服务只需 mTLS + 遥测 | **Ambient**（资源省一个数量级） |
| L7 治理需求遍布全网格 | **Sidecar** |
| 业务不能随代理升级滚动重启 | **Ambient**（数据面与业务解耦） |

关键认知：**不必一刀切**——两种模式可按 namespace 共存于同一网格（mTLS 自动协商互通）。生产常见路径是渐进式迁移：非核心业务先上 Ambient 试点，L7 重度链路（网关、交易核心）留在 Sidecar。


## 安装与接入

在写任何流量规则之前，先解决两个前置问题：控制平面怎么装、业务 Pod 怎么接入网格。

**安装**：一条命令装好控制平面和数据面网关：

```bash
istioctl install --set profile=demo -y   # demo 配置：含 istiod + ingress/egressgateway（default 配置不含 egressgateway）
kubectl get pod -n istio-system          # istiod + ingress/egressgateway 就位
```
**网关的层级**：
```text
istio-system namespace（Istio 自己的组件住这）
├── Deployment: istiod                    ← 控制平面
├── Deployment: istio-ingressgateway      ← 普通 Pod，容器里跑 Envoy，无业务容器
└── Deployment: istio-egressgateway       ← 同上

业务 namespace（bookinfo 等）
└── 业务 Pod：[业务容器 + istio-proxy 容器]  ← Sidecar 住这里，跟业务 Pod 同生共死
```

这两个网关 Deployment 是**全集群共享**的：全集群的南北向流量都汇聚到这一两个 Pod，业务 Pod 有几千个、网关副本通常只有 1~2 个——是共享的进出口关卡，不是每 Pod 一份的东西。

**接入业务 Pod**：Sidecar 注入靠 namespace 标签触发——istiod 里的 sidecar injector webhook 监听所有 Pod 创建请求，发现 Pod 所在 namespace 带了这个标签，就自动把 istio-init（init 容器：K8s 的特殊容器，在业务容器启动前跑一次 iptables 劫持规则后即退出，让所有进出业务容器的流量先经过 Envoy） + istio-proxy（常驻容器，Envoy 进程住在这里）两个容器塞进 Pod：

```bash
# Sidecar 模式：namespace 打标签，之后新建的 Pod 自动注入
kubectl label namespace bookinfo istio-injection=enabled

# Ambient 模式：换一个标签（原理完全不同：Pod 不注入，流量由节点级 ztunnel 接管）
kubectl label namespace bookinfo istio.io/dataplane-mode=ambient
```

两个必须知道的细节：

- **标签只对打标签之后新建的 Pod 生效**。已运行的 Pod 要重启才会被注入：`kubectl rollout restart deployment -n bookinfo`；
- **验证注入成功**：Pod 容器数从 1/1 变成 2/2（业务容器 + istio-proxy）。`kubectl get pod -n bookinfo` 一眼可辨。

一句话总结接入模型：**网关天生有 Envoy（安装即带），业务 Pod 靠标签注入（webhook 自动塞）**——两批 Pod 的 Envoy 到位后，istiod 才有"工人"可下发配置，后面的流量治理资源才有执行者。


## 流量治理资源

Istio 的流量治理全靠几类 CR，按"流量从哪进、到哪去"理解它们的分工：

| 资源 | 管什么 | 一句话定位 |
| ---- | ---- | ---- |
| **Gateway** | 南北向流量（集群外→集群内） | 声明网格的"大门"：监听哪些端口/协议、管哪些证书 |
| **VirtualService** | 流量路由 | 按 host/路径/header 等条件，把请求转发到谁 |
| **DestinationRule** | 到达目标后的策略 | 定义目标服务的 subset（版本分组）、负载均衡策略、TLS 模式 |
| **ServiceEntry** | 出向流量（集群内→集群外） | 把外部服务（如三方 API）注册进网格，使其可被治理 |

先建立一个总括认知——这些 CR 与真正干活的 Envoy 是什么关系，再逐个拆解，每个资源都回答清楚"hosts 填什么、路由怎么生效"。

### CR与Envoy：逻辑规则与真实执行者

上表四类资源都是**逻辑声明**，集群里没有一个"叫 VirtualService 的进程"在转发流量。真正干活的是 **Envoy**——CNCF 毕业的高性能 C++ 代理，L3 到 L7 全能（HTTP/gRPC/TCP 都能解析），是 Istio 整个数据平面的引擎。它的工作方式只有一个：**接受 xDS 协议下发的配置，然后照着配置转发流量**。

理解 Envoy 是什么，四个资源的关系就一目了然：

```text
你写的 CR（逻辑规则，不存在于流量路径上）
    Gateway / VirtualService / DestinationRule / ServiceEntry
        ↓ istiod（Pilot）Watch 并翻译
        ↓ 组装成 Envoy 的原生配置对象
        ↓ 通过 xDS 协议下发
真实执行者：Envoy 实例（跑在对应容器里的进程）
    ├─ Sidecar：注入在业务 Pod 里，管东西向流量
    └─ istio-ingressgateway / egressgateway：独立的 Envoy Deployment，管南北向流量
```

三个直观的推论：

- **CR 是说明书，Envoy 是工人**：改 CR 只是改了说明书，工人们（所有 Envoy）拿到新版说明书才真正改变行为——所以配置下发有秒级延迟，不是改完立即生效。
- **排查必须看 Envoy 侧的最终配置**：CR 写了但没生效，说明翻译环节断了（典型：VirtualService 忘了绑 `gateways`）。用 `istioctl proxy-config` 系列命令 dump 某个 Envoy 实际收到的 Listener/Route/Cluster 配置，一翻便知规则有没有送达。
- **Sidecar 和 Gateway 是同一个引擎的两种摆位**：Pod 里那个是 Sidecar 摆法，ingressgateway 是独立 Deployment 摆法，跑的都是 Envoy 镜像——**差别只是站的位置**。

### Gateway：声明网格的大门

Gateway 本身**不转发任何流量**，它只是一份"大门规格书"——声明监听哪个端口、什么协议、接受哪些域名的请求。真正监听端口的是 `selector` 选中的那批 **istio-ingressgateway** Pod（独立的 Envoy Deployment）：

```yaml
apiVersion: networking.istio.io/v1
kind: Gateway
metadata:
  name: bookinfo-gateway
spec:
  selector:
    istio: ingressgateway        # 选中 istio-ingressgateway 的 Pod，由它们执行这份"规格书"
  servers:
  - port: { number: 80, name: http, protocol: HTTP }
    hosts: ["bookinfo.example.com"]   # 大门只放行请求这个域名的流量，其他域名直接拒之门外
```

**`hosts` 字段的含义**：只有 Host 头为 `bookinfo.example.com` 的请求能进门。一个 ingressgateway 上可以声明多个 Gateway，分别对应不同域名（`api.example.com`、`admin.example.com`），实现"一个入口按域名分流给多套业务"。

### VirtualService：定义路由规则

VirtualService 是路由的核心，**它管理的是"host"这个维度上的所有请求**，按匹配条件转发。它的 `hosts` 字段填两类值，含义完全不同：

- **对外域名**（如 `bookinfo.example.com`）：配合 `gateways` 字段绑定 Gateway，处理南北向流量——外部用户进门后的第一站路由；
- **内部服务名**（如 `reviews`）：处理网格内东西向流量——其他服务调用 reviews 时的路由。

```yaml
apiVersion: networking.istio.io/v1
kind: VirtualService
metadata:
  name: bookinfo
spec:
  hosts: ["bookinfo.example.com"]      # 对外域名，处理外部请求
  gateways: ["bookinfo-gateway"]       # 必须绑定 Gateway 才对外生效；不写则只作用于网格内部
  http:
  - match:                             # 规则从上到下依次匹配，命中即停
    - uri: { prefix: /static }
    route:
    - destination: { host: productpage, port: { number: 9080 } }  # productpage 是 Service 名，全名 <service>.<namespace>.svc.cluster.local
  - route:                             # 没有任何 match 的规则是兜底路由
    - destination: { host: productpage, port: { number: 9080 } }
---
apiVersion: networking.istio.io/v1
kind: VirtualService
metadata:
  name: reviews
spec:
  hosts: ["reviews"]                   # 内部服务名，即 K8s Service 名，处理网格内的调用
  http:
  - route:
    - destination: { host: reviews, subset: v1 }
      weight: 95
    - destination: { host: reviews, subset: v2 }
      weight: 5
```

**路由的匹配维度**：`uri`（路径前缀/精确匹配）、`headers`（请求头正则）、`query`（查询参数）、`port`——组合起来可以做"header 带 `user=admin` 的请求全走 v2"这类精细控制；`destination.subset` 指向的版本分组由 DestinationRule 定义，两者是配套的（引用未定义的 subset 会直接导致请求失败，典型的 503 no healthy upstream）。

### VirtualService 的重定向与重写

VirtualService 除了"路由到哪"，还能对请求本身做两类变形——redirect（重定向）与 rewrite（重写），语义完全不同：

**redirect：告诉客户端"换地址再来"**（HTTP 301/302）：

```yaml
http:
- match:
  - uri: { exact: /v1/products }
  redirect:
    uri: /v2/products              # 302 到新路径（默认；可用 httpCode 改 301），浏览器地址栏会变
    # authority: www.new-domain.com  # 还可整域跳转
    # scheme: https                  # 还可强制跳 https
  # 注意：redirect 规则里不写 route——响应 302/301 给客户端，由客户端重新发起请求
```

请求根本不会被转发到后端，网关直接回一个"302 请去新地址"，客户端自己再发一次。**典型场景**：① HTTP 强跳 HTTPS（`http://` 请求 302/301 到 `https://`，安全基线操作）；② 域名迁移（`old.example.com` 全量 301 到新域名，配 `httpCode: 301` 把搜索引擎权重带走）；③ 接口路径升级后兼容旧路径。

**rewrite：客户端无感地改"转发目标"**：

```yaml
http:
- match:
  - uri: { prefix: /bookinfo }
  rewrite:
    uri: /                # 前缀剥掉：/bookinfo/productpage 转发成 /productpage
  route:
  - destination: { host: productpage, port: { number: 9080 } }
```

浏览器地址栏**不变**，改写只发生在网关/Sidecar 内部转发时。**典型场景**：① 对外统一域名、内部各服务认自己的路径——多个业务共用一个入口靠前缀区分（`/bookinfo/*` 剥前缀给 productpage、`/shop/*` 剥给 shop 服务），后端代码完全不用改；② 把对外路径映射成后端真实路径，隐藏内部实现。

一句话对比：**redirect = "客户端自己去新地址"（地址栏变、两次请求）；rewrite = "我帮你改好了再转发"（地址栏不变、一次完成）**。生产高频坑：redirect 不能与 route 共存（同一规则里写了会校验报错）；rewrite 必须与 route 配套出现——先改写再路由，两步在一条规则里完成。

### DestinationRule：定义目的地

VirtualService 说"把 5% 流量给 reviews 的 v2"，但**v2 是哪些 Pod、按什么策略负载均衡，由 DestinationRule 回答**。它按 Pod label 把一个服务切分成命名的 subset：

```yaml
apiVersion: networking.istio.io/v1
kind: DestinationRule
metadata:
  name: reviews
spec:
  host: reviews                        # 针对哪个服务，K8s 内填 Service 名即可
  subsets:
  - name: v1
    labels: { version: v1 }            # 选中带 version=v1 label 的 Pod
  - name: v2
    labels: { version: v2 }            # 选中带 version=v2 label 的 Pod
  trafficPolicy:
    loadBalancer:
      simple: LEAST_REQUEST            # 负载均衡策略：最少请求数优先（还有 ROUND_ROBIN/RANDOM）
    # connectionPool:                  # 还可配置连接池（熔断的基础）
    # outlierDetection:                # 异常实例剔除：连续错误N次后摘除该Pod一段时间
```

`trafficPolicy` 里还有两个生产高频字段——`connectionPool`（过载保护）和 `outlierDetection`（熔断），见下文「熔断与过载保护」一节。

### 负载均衡算法：按服务定制"分活"策略

**Istio 的核心优势：应用级别的负载均衡**。K8s 原生的负载均衡在 kube-proxy 层，只能集群级统一配置（改 kube-proxy 的全局 configmap），没法给单个服务定制；Istio 把这一层下沉到 Sidecar，用 DestinationRule **按服务单独配**——A 服务用最小请求、B 服务用随机，互不影响。而且算法直接作用于最终的 Pod（endpoint）选择，不管上面 VS 怎么路由，最后"挑哪个 Pod"都归 DR 管。

**算法怎么选**：

| 算法 | 行为 | 生产建议 |
| ---- | ---- | ---- |
| ROUND_ROBIN 轮询 | 依次轮流分配 | **不推荐**：请求耗时不均时，顺序分配会稳定踩中慢实例 |
| **LEAST_REQUEST 最小请求** | 随机挑两个实例，比活跃请求数，发给少的那个 | **无脑选它**：应对快慢实例混合最稳 |
| RANDOM 随机 | 随机挑一个 | 性能不如 LEAST_REQUEST，不作首选 |
| PASSTHROUGH 直通 | 不负载均衡，直连调用方请求的原始 IP | 特殊场景才用，了解即可 |
| UNSPECIFIED | 留空，让 Istio 挑默认值 | 建议**显式指定**，别把行为交给版本升级 |

三个相关细节：**LEAST_CONN 已废弃**（功能与 LEAST_REQUEST 相同，统一用后者）；旧版默认算法是 ROUND_ROBIN，因问题多已改为默认 LEAST_REQUEST；配置位置就是上面 DR 示例里的 `trafficPolicy.loadBalancer.simple`。

**配置位置与优先级**：`trafficPolicy` 可以写在 DR 的 `spec` 下（全局，对所有 subset 生效），也可以写在某个 subset 里（局部，仅该 subset 生效），**subset 级覆盖全局**：

```yaml
apiVersion: networking.istio.io/v1
kind: DestinationRule
metadata:
  name: reviews
spec:
  host: reviews
  trafficPolicy:                   # 全局策略：v2/v3 都用它
    loadBalancer:
      simple: RANDOM
  subsets:
  - name: v1
    labels: { version: v1 }
    trafficPolicy:                 # subset 级策略：优先级高于全局
      loadBalancer:
        simple: LEAST_REQUEST      # v1 用最小请求，v2/v3 用 RANDOM
  - name: v2
    labels: { version: v2 }
```

验证：`istioctl proxy-config cluster <pod> | grep reviews` 能看到每个 subset 的 cluster 用的负载均衡策略；Kiali 的 Istio Config 页面直接可视化 DR 配置。生产建议：**没有特殊诉求就保持 LEAST_REQUEST 不动**——它对"有的实例慢、有的请求重"的普遍现实最有韧性，其余算法只在确有理由时才改。

### 熔断与过载保护

**熔断解决的是"下游不行了，别把它拖死"**。微服务链路里最怕的雪崩剧本：C 服务变慢 → B 的调用线程全堵在等 C → B 也变慢 → A 堵在等 B……故障像多米诺一样逐级向上传播。熔断的思路是给这条链路装"保险丝"：**某实例连续出错/变慢就把它摘出负载均衡池，过一会儿再试探恢复**——把故障隔离在局部，而不是让全链路陪葬。

Istio 的熔断由 DestinationRule 的 `trafficPolicy` 承载，两个字段各管一摊：

```yaml
apiVersion: networking.istio.io/v1
kind: DestinationRule
metadata:
  name: reviews
spec:
  host: reviews
  trafficPolicy:
    connectionPool:                    # 过载保护：限制流量强度
      http:
        http1MaxPendingRequests: 100   # 最多 100 个请求排队，超出的直接拒绝（fast fail）
        maxRequestsPerConnection: 10   # 每个连接最多 10 个请求后重建，防连接老化
        http2MaxRequests: 1000         # 对该上游的最大并发请求数
    outlierDetection:                  # 熔断：摘除不健康实例
      consecutive5xxErrors: 5          # 连续 5 次 5xx → 摘除该 Pod
      interval: 10s                    # 每 10 秒检测一轮
      baseEjectionTime: 30s            # 摘除至少 30s，之后按比例试探性放回
      maxEjectionPercent: 50           # 最多摘除 50% 的实例，防止全摘导致服务整体不可用
```

两个字段的分工值得记牢：

- **connectionPool（过载保护）**：平时就在生效的"限流闸门"——排队满了、连接满了直接拒绝，**宁可快速失败也不排队雪崩**。快速失败本身就是保护：调用方立刻收到错误可以去重试/降级，而不是挂着等；
- **outlierDetection（异常剔除）**：事后清道夫——只针对**具体某个坏 Pod**，摘除是按健康度摘单个实例，`maxEjectionPercent` 保证即使全集群故障也不会把服务摘光（都摘了反而全断）。

关键认知：**业务代码一行熔断逻辑都不用写**。对比传统做法（Hystrix/Resilience4j 要每个调用点写注解、SDK 版本还要各语言对齐），Istio 把熔断下沉到了 Sidecar——配置在 DR 上，对业务完全透明。验证：`istioctl proxy-config cluster <pod>` 看 cluster 配置里的 outlierDetection 段，或故意 kill 掉一个副本观察 `istioctl proxy-config endpoint` 里它被摘出的过程。

### 故障注入：主动制造故障测韧性

前面所有能力都在"防故障"，故障注入反过来——**主动往链路里塞故障，测试系统扛不扛得住**。它的目的不是破坏，是**提前暴露**：A 调 B、B 调 C，如果 C 突然变慢或挂掉，上游会怎样？与其等生产半夜炸了才知道，不如在可控条件下主动演练一遍——这也是混沌工程的入门实践。

**两种故障类型**：

| 类型 | 行为 | 模拟什么 | 暴露什么问题 |
| ---- | ---- | ---- | ---- |
| **delay 注入延迟** | 请求卡住 N 秒再放行 | 网络抖动、下游变慢、DB 慢查询 | 上游超时设置合理吗？会不会被拖死？重试风暴吗？ |
| **abort 注入中断** | 直接返回指定错误码（如 503） | 服务完全不可用 | 上游降级逻辑有没有？错误处理会不会雪崩？ |

**配置位置**：故障注入写在**被调用服务的 VirtualService** 里（注意和熔断相反——熔断配在调用方视角的 DR 上，故障注入配在被调方的 VS 上，因为故障模拟的就是这个服务自身的表现）。但有一个排障时容易懵的细节：**配置在被调方的 VS 上，实际注入却发生在调用方的 Sidecar 上**——所有调用 details 的 Sidecar 评估这条路由时会各自执行 fault，而不是 details 自己的 Pod"变慢"。所以注入后去 details 的日志里找不到那 5 秒延迟，去调用方 Sidecar 的日志才能对上：

```yaml
apiVersion: networking.istio.io/v1
kind: VirtualService
metadata:
  name: details-fault
spec:
  hosts: [details]
  http:
  - fault:                              # 与 route 平级：先注入故障（delay 后仍按 route 转发；abort 直接返回错误）
      delay:
        percentage: { value: 100 }      # 100% 的请求注入（50 就是一半请求）
        fixedDelay: 5s                  # 延迟 5 秒
    route:                              # 兜底路由仍在：注入延迟后正常转发
    - destination: { host: details, port: { number: 9080 } }
```

**实操验证一条龙**（延续 Bookinfo 环境）：

```bash
# 1. 建一个测试 Pod 模拟调用方
kubectl create deploy -n bookinfo debug-tools \
  --image=registry.cn-beijing.aliyuncs.com/dotbalo/debug-tools -- sleep 36000

# 2. 注入前测基线：响应约 0.02s
kubectl exec -ti deploy/debug-tools -n bookinfo -- curl -o /dev/null -s -w 'total: %{time_total}s\n' details:9080

# 3. 应用上面的延迟故障 VS 后再测：约 5.19s —— 注入生效
kubectl exec -ti deploy/debug-tools -n bookinfo -- curl -o /dev/null -s -w 'total: %{time_total}s\n' details:9080

# 4. 测完删掉故障配置，恢复正常
kubectl delete vs details-fault -n bookinfo
```

**延迟注入的实战推演**：如果 productpage 调 details 的超时设的是 2s，而 details 被注入了 5s 延迟——productpage 必然超时报错，页面缺一块或整体变慢。这一刻你就**提前看到了生产事故的形状**：超时设短了导致连锁失败？还是根本没配超时导致线程堆积？修完再演练，直到链路在 5s 延迟下依然优雅降级。

**中断注入的示例**（换 fault 类型即可）：

```yaml
  - fault:
      abort:
        percentage: { value: 50 }       # 50% 的请求直接失败
        httpStatus: 503                 # 返回 503，模拟服务不可用
    route:
    - destination: { host: details, port: { number: 9080 } }
```

三个生产要点：

- **percentage 必须配**：上例写 100 只是为了测试环境里效果直观；生产演练永远别写 100——按 10%/20% 起步，只影响一小部分流量，可控观察；
- **故障注入对"谁能触发"没身份区分**：配了就对所有命中该 VS 的流量生效，所以**只在测试环境玩**，或配合 header 匹配限定特定测试用户；
- **测完即删**：故障配置残留是最经典的"生产灵异事件"来源——明明什么都没坏却偶发变慢/报错，查半天发现是半年前演练忘删的 VS。把故障配置纳入和应用代码相同的 CR 审批/清理流程。

一句话定位：**熔断是"被动挨打时的保险丝"，故障注入是"主动挨打时的疫苗"**——前者保证故障来了扛得住，后者保证故障来之前知道哪里扛不住，两者配在同一套 VS/DR 体系里，构成 Istio 流量韧性的完整闭环。

### ServiceEntry：把外部世界纳入网格

网格默认只认识集群内的 Service。想治理"访问外部 API"的流量（统一出口、mTLS、限流），先用 ServiceEntry 把外部目标注册成一个"逻辑服务"：

```yaml
apiVersion: networking.istio.io/v1
kind: ServiceEntry
metadata:
  name: external-api
spec:
  hosts: ["api.thirdparty.com"]        # 外部服务的域名，网格内从此可以用它做路由
  ports:
  - number: 443
    name: https
    protocol: HTTPS
  location: MESH_EXTERNAL              # 声明这是网格外的目标
```

注册之后，这个外部域名和其他内部服务一视同仁——可以给它写 VirtualService 做路由、配 DestinationRule 做超时重试，再配合 AuthorizationPolicy 限定"哪些服务允许访问它"。

### istio-ingressgateway与istio-egressgateway

```text
外部用户 ──→ istio-ingressgateway ──→ 网格内服务      （入口：南北向流入）
网格内服务 ──→ istio-egressgateway ──→ 外部 API/DB    （出口：南北向流出）
```

**istio-ingressgateway**：入口网关，即 Gateway CR 的 `selector: istio: ingressgateway` 选中的那批 Pod。生产上它前面通常再挂一个 LoadBalancer Service 把入口暴露出去。

**istio-egressgateway**：出口网关。没有它时，Pod 访问外部 API 的流量会被 Sidecar 直接放出去——**出站策略分散在每个 Sidecar 上，外部审计看不到统一的出口 IP**。加了 egressgateway 后，"访问外部"的流量统一流经这个关卡，两个典型用途：

1. **统一出口 IP**：三方系统（银行、政府接口）通常要白名单对端 IP，几十个业务 Pod 的出口 IP 漂移没法维护；全部走 egressgateway 后给对方一个 IP 就行。
2. **出口审计与管控**：哪些服务能访问外网、访问哪些域名，在出口集中执行（配合 ServiceEntry + AuthorizationPolicy），而不是相信每个 Sidecar 的配置都配对了。

一句话对比：**ingressgateway 管"别人怎么进来"，egressgateway 管"自己怎么出去"**——两者都是独立的 Envoy Deployment。demo 配置两个都装；default 配置不含 egressgateway，需要时 `istioctl install --set components.egressGateways[0].enabled=true` 补开。

**出口资源配置**：入口就是前文 Gateway CR（`selector: istio: ingressgateway` + VirtualService 绑定），不再重复；**出口**需要几个资源配合，让"productpage 访问外部 API"的流量强制流经 egressgateway：

```yaml
# ① ServiceEntry：把外部域名注册进网格（前提条件，见前文）
apiVersion: networking.istio.io/v1
kind: ServiceEntry
metadata:
  name: external-api
spec:
  hosts: ["api.thirdparty.com"]
  ports:
  - number: 443
    name: https
    protocol: HTTPS
  location: MESH_EXTERNAL
---
# ② Gateway：在 egressgateway 上开一道通往该域名的小门
apiVersion: networking.istio.io/v1
kind: Gateway
metadata:
  name: egress-api-gateway
spec:
  selector:
    istio: egressgateway          # 关键：selector 换成 egressgateway 的 Pod
  servers:
  - port: { number: 443, name: https, protocol: HTTPS }
    hosts: ["api.thirdparty.com"]
---
# ③ VirtualService：把网格内访问该域名的流量"改道"到 egressgateway
apiVersion: networking.istio.io/v1
kind: VirtualService
metadata:
  name: route-via-egress
spec:
  hosts: ["api.thirdparty.com"]
  gateways:
  - mesh                          # 特殊值：匹配所有网格内部的调用（Sidecar 发出的）
  - egress-api-gateway            # 匹配从 egressgateway 进来的（转发给最终目标）
  http:
  - match:
    - gateways: ["mesh"]
      port: 443
    route:
    - destination:
        host: istio-egressgateway.istio-system.svc.cluster.local
        subset: external-api
        port: { number: 443 }
  - match:
    - gateways: ["egress-api-gateway"]
      port: 443
    route:
    - destination: { host: api.thirdparty.com }
      # egressgateway 收到流量后，转发给真正的外部域名
---
# 配套：给 egressgateway 定义上面的 subset（无 labels 的命名分组，供 VirtualService 引用）
apiVersion: networking.istio.io/v1
kind: DestinationRule
metadata:
  name: egress-external-api
spec:
  host: istio-egressgateway.istio-system.svc.cluster.local
  subsets:
  - name: external-api
---
# ④（可选）AuthorizationPolicy：只允许 productpage 借道出口
apiVersion: security.istio.io/v1
kind: AuthorizationPolicy
metadata:
  name: egress-allow-productpage
  namespace: istio-system         # 作用于 egressgateway 所在 namespace
spec:
  selector:
    matchLabels:
      app: istio-egressgateway
  action: ALLOW
  rules:
  - from:
    - source:
        principals: ["cluster.local/ns/bookinfo/sa/productpage"]   # 按服务身份放行（Bookinfo 部署在 bookinfo namespace）
    to:
    - operation:
        hosts: ["api.thirdparty.com"]
```
①②③ 三步的逻辑：ServiceEntry 让网格"认识"外部域名 → VirtualService 里 `gateways: ["mesh"]` 把所有出向流量第一跳改道到 egressgateway → 第二跳（egressgateway 收到后）按 `gateways: ["egress-api-gateway"]` 匹配，转发给真实目标。验证：`curl -I https://api.thirdparty.com` 从 productpage 发出后，egressgateway 的访问日志（`kubectl logs`）里应能看到这条请求——出口审计从此有据可查。


## 入口方案选型

网格自身的流量资源讲完了，回过头看"集群入口"这个特殊场景：K8s 原生还有 Gateway API 和 Ingress 两套方案，它们与 Istio 的关系值得单独讲清楚。

### 与 K8s Gateway API 的关系

K8s 官方的 **Gateway API**（`GatewayClass` / `Gateway`）与 Istio 自家的 Gateway CRD 是两套并存的入口体系：

- **`GatewayClass` 是集群级资源，回答"谁来实现 Gateway"**：它的 `spec.controllerName` 指向一个控制器实现，如 Istio 的 `istio.io/gateway-controller`。Gateway API 的设计哲学是"标准 API + 可插拔实现"——用户写标准的 Gateway/HTTPRoute，底层由 Istio、Envoy Gateway 等任意实现方驱动。
- **血缘关系**：Istio 的 Gateway CRD 比 Gateway API 诞生得早，Gateway API 大量吸收了 Istio 的实践；Istio 现在同时支持两套，且官方新文档更推荐用 Gateway API 作为入口配置。

### Ingress：上了网格就该下线

Istio 完全覆盖了 K8s Ingress 的功能，并且远超它：

| 能力 | K8s Ingress | Istio Gateway / Gateway API |
| ---- | ---- | ---- |
| L7 路由（路径/host） | 支持，但注解（annotation）各家实现五花八门 | 原生声明式 |
| 权重灰度、header 路由 | 做不到（要靠各实现的 annotation 魔法） | 原生支持 |
| mTLS 终结、证书管理 | 部分支持 | 原生支持 |
| 故障注入、熔断 | 无 | 原生支持 |
| 东西向流量治理 | 与入口无关，完全管不到 | 全网格覆盖 |
| 语义可移植性 | annotation 不跨实现 | Gateway API 是标准，实现可替换 |

结论：**在已经部署 Istio 的集群里，Ingress 没有存在价值**——上表前五行说明 Istio Gateway 是 Ingress 的严格超集，后两行更是 Ingress 永远补不齐的能力。保留 Ingress 等于维护两套入口逻辑，应该下线；唯一需要 Ingress 的场景是集群没上网格、又不值得为入口引入整个网格——那时 Ingress 才作为轻量替代出场。


## 流量管理的最佳实践：以Bookinfo为例

用 Istio 官方的经典示例应用 **Bookinfo** 把所有资源串一遍。它模拟一个书店，四个服务组成一条真实调用链：

```text
productpage（产品页，入口服务）
  ├── details（书籍详情）
  ├── reviews（书评，有 v1/v2/v3 三个版本）
  │     └── ratings（评分）
```

目标：外部用户通过 `bookinfo.example.com` 访问 productpage；reviews 做金丝雀发布（v1 承接 95%、v2 灰度 5%）。Gateway、VirtualService、DestinationRule 三类资源依次上场：

**① Gateway 开大门**（`bookinfo.example.com` 进得来）：前文 Gateway 一节创建的 `bookinfo-gateway` 正是这份配置，直接复用，不再重复。

**② VirtualService 接住入口流量**（进了门去哪）：

```yaml
apiVersion: networking.istio.io/v1
kind: VirtualService
metadata:
  name: bookinfo
spec:
  hosts: ["bookinfo.example.com"]
  gateways: ["bookinfo-gateway"]       # 绑定大门，不写则只对网格内部生效
  http:
  - match:
    - uri: { exact: /details }         # 路径路由：详情接口直接给 details 服务
    route:
    - destination: { host: details, port: { number: 9080 } }
  - match:
    - uri: { exact: /ratings }
    route:
    - destination: { host: ratings, port: { number: 9080 } }
  - route:                             # 兜底：其余路径全部给产品页
    - destination: { host: productpage, port: { number: 9080 } }
```

productpage 内部再调用 reviews 时，走的是网格内（东西向）流量，命中 ③ 里的 reviews VS。

**③ VirtualService + DestinationRule 配套做金丝雀**（reviews 的 95/5 切流）：reviews 的 95/5 VirtualService 前文 VirtualService 一节已完整给出，配套的 v1/v2 DestinationRule 见 DestinationRule 一节，直接 `kubectl apply` 即可，不再重复。

**验证闭环**：域名解析到 ingressgateway 的 LB IP 后（本地测试可加 hosts 或 `curl --resolve`），`curl http://bookinfo.example.com/productpage` 应正常返回页面；反复刷新页面（或 `for i in {1..100}; do curl -s http://bookinfo.example.com/productpage | grep -c "star"; done`），能观察到约 5% 的请求展示 v2 的星星评分——权重切流生效。灰度期间盯着 Grafana 里 reviews 的错误率和 P95，异常就把 weight 改回 `100/0`，一条 `kubectl apply` 完成回滚。

**④ header 路由做 A/B 测试**（内部用户先体验 v3）：

金丝雀是"**按比例随机分**"——谁命中那 5% 全凭概率，样本不可控；A/B 测试是"**按用户特征定向分**"——固定人群固定看某个版本，实验变量才干净。做法就是路由章节说的 header 匹配，配上 v3 的 subset：

```yaml
apiVersion: networking.istio.io/v1
kind: VirtualService
metadata:
  name: reviews
spec:
  hosts: ["reviews"]
  http:
  - match:                              # 第一条：内部用户定向到 v3
    - headers:
        end-user: { exact: internal }   # 入口层注入的内部用户标识头
    route:
    - destination: { host: reviews, subset: v3 }
  - route:                              # 兜底：其余用户走 95/5 金丝雀
    - destination: { host: reviews, subset: v1 }
      weight: 95
    - destination: { host: reviews, subset: v2 }
      weight: 5
```

（配套：DestinationRule 里补一个 `v3` subset，`labels: { version: v3 }`——subset 机制与前面完全一致。）

三个要点：

- **match 命中即停**：带 `end-user: internal` 头的请求被第一条截走，永远只到 v3；不带头的落入兜底的 95/5——定向规则永远写在权重规则前面；
- **end-user 头不是 Istio 生成的**：它由入口层注入（ingressgateway 解析 JWT 后的 header 注解、业务网关的 session 映射、或应用自己带上），Sidecar 只负责"按头匹配"，不负责"造头"；
- **验证**：`curl -H "end-user: internal" http://bookinfo.example.com/productpage` 反复请求，星星评分永远是 v3 的样式；不带头才出现 95/5 的摇摆。

生产上这个模式的变体全是"换个匹配条件"：白名单客户用 `user-id` 区间、按地区发布用 `region` 头、按设备灰度用 `user-agent`——组合出"**定向体验（A/B）→ 小比例放量（金丝雀）→ 全量**"的标准三段式发布。

这套"**Gateway 定大门 → VirtualService 定路由 → DestinationRule 定目的地**"的三板斧，覆盖了南北向入口、路径路由、金丝雀发布、A/B 定向发布四个最高频的生产需求，也是所有 Istio 流量管理任务的标准起手式。