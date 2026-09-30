---
title: eBPF
published: 2026-09-30T23:11:23+08:00
description: 学习eBPF的原理和在可观测性系统里面的应用 
image: './images/a33.jpg'
tags: [linux,可观测性系统]
category: '计算机技术'
draft: false
lang: '中文'
---


## eBPF介绍
- eBPF（extended Berkeley Packet Filter）一句话概括：**一个运行在内核里的虚拟机，让我们能把自己写的代码安全地送进内核态执行，而不需要修改内核源码，也不用加载危险的内核模块**。
- 它的前身是 1992 年的 BPF——一个用于 tcpdump 的高效报文过滤器。2014 年 Linux 3.18 引入 eBPF，把"过滤报文"扩展成了"通用的内核可编程接口"，从此内核多了一种官方认可的扩展方式。
- eBPF可以让我们都能够简单地在一定程度上对内核代码进行自定义修改，它把"修改内核"变成了"扩展内核"——扩展点是内核官方暴露的受控接口。**代码由开发者编写，安全性由 Verifier 保证，性能由 JIT 保证，生命周期由加载/卸载控制**。装完即用、卸载即走，内核不用重启；配合 CO-RE（一次编译、到处运行），内核升级后程序甚至不用重编。

### 在可观测性系统中的应用

可观测性最缺的不是存储和展示，而是**数据源**。而内核天然拥有最全的数据：所有系统调用、所有网络包、所有进程调度都要经过内核。eBPF 可以挂在 kprobe（动态探针,几乎 任何内核函数 的入口或返回处）、tracepoint（静态探针,内核开发者 主动预埋 在代码里的固定观测点）、XDP、TC 等钩子上，把这些数据"就地"采集起来。

典型应用：  
- **零侵入追踪**：`bpftrace` 一行命令观测任意内核函数，应用不用接任何 SDK；
```bash
# ①内存：统计各进程触发的 page fault 次数（定位内存抖动/swap 元凶）
#    Ctrl-C 退出时自动打印聚合结果；@ 开头的变量就是聚合 Map
bpftrace -e 'tracepoint:exceptions:page_fault_user { @[comm] = count(); }'

#  进程：追踪新进程的创建（排查"谁在频繁 fork/exec"）
bpftrace -e 'tracepoint:sched:sched_process_exec
    { printf("%s -> %s\n", comm, str(args->filename)); }'
```
> 速查语法：`tracepoint:` 用内核预埋的静态探针（稳定，推荐优先用）；`kprobe:` 动态挂任意内核函数（灵活但随内核版本可能失效）。`@变量` 是 eBPF Map，进程退出（Ctrl-C）时自动打印聚合值；`comm` 是进程名，`args->xxx` 取 tracepoint 的参数。

- **持续性能剖析**：Grafana Pyroscope 用 eBPF 采样所有进程的 CPU/内存火焰图，语言无关；
- **网络可观测**：Cilium Hubble 基于 XDP/TC 钩子输出服务间调用拓扑与策略审计；
- **应用自动识别**：Grafana Beyla 通过 eBPF 自动探测应用的 HTTP/gRPC 调用，转成 RED 指标和 Trace，应用零改造。

### 和 Grafana 全家桶、OTel SDK 的分工

摆正 eBPF 在整个可观测性体系里的位置，可以按"数据从哪来"分三层：

| 层            | 手段                                           | 拿到什么                                                  |
| ------------- | ---------------------------------------------- | --------------------------------------------------------- |
| 集群/基础设施 | exporter、日志 agent（推给 Prometheus / Loki） | Pod 状态、节点资源、容器日志                              |
| 应用层        | OTel SDK 手动埋点                              | 带业务上下文的 Trace（订单号、用户 ID）、自定义业务指标   |
| 内核层        | **eBPF**                                       | 系统调用、网络包、进程行为，乃至应用进程的 HTTP/gRPC 调用 |

注意前两层和第三层的边界：**Prometheus/Loki/Tempo 只负责存储和展示，不负责采集**；OTel SDK 采的是"业务语义"，eBPF 采的是"系统事实"。

两者有一块明确的重叠——一次 HTTP 请求，OTel SDK 能采，eBPF（Beyla）也能采，都能产出 RED 指标和 Trace。区别在于：

- **SDK：深而不广**——span 里能塞业务语义（"这是下单接口，订单号 123"），但每个服务都要改代码，漏埋就看不到；
- **eBPF：广而不深**——所有进程自动覆盖、语言无关，但只有 URL、IP、耗时，不知道这笔请求在业务上是什么。

所以实践中两者是互补并用，而不是二选一：eBPF 兜底，先让所有服务都被观测到；SDK 补深核心链路的业务语义；两边靠 **trace_id 关联**——eBPF 把 trace_id 写进自己采集的 span，就能和 SDK 埋的完整链路对上。采集到的数据最终都汇入同一套后端（OTel Collector → Prometheus / Loki / Tempo），由 Grafana 统一展示。eBPF 不是替代这套全家桶，而是给它们补上了"零侵入、全覆盖"的数据源。


## eBPF的实现细节

### 沙箱：为什么不会把内核搞挂

内核态代码出 bug 是全局 panic，所以 eBPF 的"可编程"必须用沙箱兜底，核心是三道关卡：

1. **Verifier（验证器）**：加载时把程序的所有指令分支模拟执行一遍，检查：不允许越界访问内存、不允许死循环、指针必须先验证再解引用、程序大小有上限。任何一条不满足，直接拒绝加载——这就是"一个有 bug 的 eBPF 程序最多加载失败，不会搞挂内核"的原因。
2. **JIT 编译器**：验证通过后，把字节码即时编译成本平台机器码，运行性能接近原生内核代码。
3. **受限运行时**：程序运行时不能直接访问内核内存，只能调用内核提供的白名单 helper 函数（如 `bpf_map_lookup_elem`、`bpf_probe_read_kernel`），要碰什么数据都要"报备"。

三道关卡合起来就是沙箱的本质：**能力受限、加载可验证、随时可卸载**。

### 全流程：从用户态到内核态再回来
1. **① 编译**：开发者用 C（或 Rust）写 eBPF 程序，`clang/llvm` 编译成 `bpf.o` 字节码；
2. **② 加载**：loader（libbpf、cilium-ebpf 等）通过 `bpf()` 系统调用把字节码送进内核——这是第一次用户态到内核态的穿越；
3. **③ 验证**：Verifier 做静态安全检查，不通过则拒绝；
4. **④ JIT 挂载**：验证通过后 JIT 编译成机器码，挂载到指定 Hook 点（kprobe、tracepoint、XDP 等）；
5. **⑤ 事件触发**：每次有事件命中钩子（某进程调用了 `execve`、某网卡收到包……），就在沙箱里执行一次；
6. **⑥ 写入**：执行过程中把数据写进 eBPF Map；
7. **⑦ 读取**：用户态采集程序从 Map 读走数据——这是数据从内核态回到用户态的第二次穿越，之后再加工输出给 OTel / Grafana。

注意"用户态→内核态→用户态"里的两次穿越是解耦的：加载时一次（`bpf()` 系统调用），运行后数据回流一次（Map）。eBPF 程序本身不会反向调用用户态，它只管把数据放进 Map，什么时候读、谁来读，由用户态决定。
**补充CO-RE**
- 在之前，不同内核版本里的结构体字段布局可能不一样——字段顺序变了、偏移量变了、甚至字段被删了或改名了。eBPF 程序编译时把字段偏移量硬编码进字节码，导致在另一个内核版本的eBPF程序会运行异常。
- 开启BTF后（5.2+版本默认开启）,内核编译时会生成一份记录了所有数据结构体的一些元信息的BTF数据,然后把该数据转成一个`vmlinux.h`c头文件
- 在编写eBPF程序时，包含上面那个头文件，程序编译后，字节码记录的是我要访问xxx字段,而不是硬编码的偏移量,libbpf就会读BTF,计算出该字段的真实偏移量,然后把字节码里的"字段名引用" 重定位 成"实际偏移量"，最后，送进内核。

### eBPFMap
内核态和用户态地址空间隔离，eBPF 程序又没有持久内存可用，Map 就是**两边共享数据的桥梁**，同时也是多个 eBPF 程序之间共享状态的手段。它本质上是内核提供的键值存储，通过 `bpf_map_lookup_elem` / `bpf_map_update_elem` / `bpf_map_delete_elem` 三个 helper 操作，内核态和用户态都能读写同一个 Map。

常用类型：

| 类型                            | 结构                 | 典型用途                                                     |
| ------------------------------- | -------------------- | ------------------------------------------------------------ |
| `BPF_MAP_TYPE_HASH`             | 哈希表               | 聚合统计：按 PID / 五元组聚合延迟、计数                      |
| `BPF_MAP_TYPE_ARRAY`            | 定长数组，key 是下标 | 每 CPU 编号的统计、全局配置                                  |
| `BPF_MAP_TYPE_RINGBUF`          | 环形缓冲区（5.8+）   | 事件流：每次触发产生的明细推给用户态，比 perf event 更省内存 |
| `BPF_MAP_TYPE_PERF_EVENT_ARRAY` | 环形缓冲区（老方案） | 同上，兼容老内核                                             |
| `BPF_MAP_TYPE_PERCPU_HASH`      | 每 CPU 一份副本      | 免锁的高频聚合                                               |
| `BPF_MAP_TYPE_LRU_HASH`         | 带淘汰的哈希         | 连接跟踪这类有上界的场景                                     |

由此衍生出两种数据回流模式：

- **聚合型**（Hash / Array）：eBPF 程序里直接累加，用户态定期读快照——适合**指标**；
- **事件型**（RingBuf / PerfEvent）：每个事件一条记录推给用户态——适合 **Trace / 日志明细**。

举个例子：统计每个进程的系统调用耗时。用一个 Hash Map，以 PID 为 key，value 存时间戳和累计耗时；kprobe 挂在系统调用入口记录时间，kretprobe 处计算差值累加写回。用户态程序每秒读一次 Map，就得到了"每进程系统调用耗时 Top N"——整个过程应用毫无感知。

### XDP
XDP（eXpress Data Path）不是一个独立机制，而是 **eBPF 的一个挂载点：网卡驱动收到包之后、进入内核协议栈之前(即分配协议栈的核心数据结构 skb 之前)**。这是内核里最早能碰到包的位置，所以性能天花板最高。

处理模型很简单：一个包到达，挂载到 XDP 的 eBPF 程序拿到"原始包帧头 + 少量元数据"，直接解析并决定去向，通过返回值告诉驱动：

| 返回码         | 动作                                                   |
| -------------- | ------------------------------------------------------ |
| `XDP_PASS`     | 放行，进入正常协议栈                                   |
| `XDP_DROP`     | 直接丢包——内核里最快的丢弃路径，DDoS 清洗的核心        |
| `XDP_TX`       | 从收到包的同一网卡原路发回                             |
| `XDP_REDIRECT` | 转给另一块网卡或另一个 CPU，配合 AF_XDP 还能直通用户态 |
#### TC（Traffic Control，流量控制）
```text
网卡收包
  ↓
XDP（驱动层，无 skb）
  ↓
协议栈入口
  ↓
TC ingress（收包方向）     ← eBPF 挂载点 ①
  ↓ 路由决策
TC egress（发包方向）      ← eBPF 挂载点 ②
  ↓
网卡发出
```
只做“进门口”的粗过滤就用 XDP（最快），要做精细的策略判断或观测就用 TC（信息全）
#### XDP eBPF的应用场景
| 场景         | 做法                                                                                                                  | 主要返回码                | 代表                 |
| ------------ | --------------------------------------------------------------------------------------------------------------------- | ------------------------- | -------------------- |
| DDoS 清洗    | 解析五元组比对黑名单，恶意包在协议栈之前就丢，比 iptables（要完整走一遍 netfilter hook 链和 conntrack）快一个数量级。 | `XDP_DROP`                | Cloudflare           |
| L4 负载均衡  | 按一致性哈希把包直接转发给后端机器，每秒处理上亿包                                                                    | `XDP_TX` / `XDP_REDIRECT` | Facebook Katran      |
| 高性能防火墙 | hash Map 存规则一次查表放行/丢弃，比 iptables 逐条匹配快得多                                                          | `XDP_PASS` / `XDP_DROP`   | 各类云厂商安全组     |
| 网络可观测   | 记录流量的五元组、字节数、放行/丢弃结果，生成服务间调用拓扑与策略审计                                                 | `XDP_PASS`（旁路记录）    | Cilium Hubble        |
| 超低延迟抓包 | 重定向到与用户态共享的内存环，应用绕过协议栈直接拿包                                                                  | `XDP_REDIRECT` + AF_XDP   | 高性能代理、流量录制 |

规律很明显：**"让大量包消失"（DDoS、防火墙）和"抢在所有人之前做观测"（拓扑、计时）**，都因为"离协议栈越早，能省的开销越多"而天然适合 XDP。


## eBPF+Falco实时监测K8s安全威胁
Falco 是 CNCF 的运行时威胁检测工具：以 eBPF 探针挂在系统调用层，把每个容器里"谁起了进程、读了什么文件、连了哪个 IP"实时抓出来，和规则库比对后告警。**数据在内核态采集，容器内的攻击者即使是 root 也看不见也绕不过它**——这是和"进容器查日志"这类传统手段的本质区别。
### 工作架构
```text
每个节点一个 Falco Pod（DaemonSet）
  ↓ eBPF 探针采集系统调用（execve、open、connect……）
  ↓ 规则引擎匹配（内置规则库 + 自定义规则）
  ↓ 命中 → 产出告警事件
  → stdout / 日志文件
  → Falcosidekick（事件转发器）→ 通知渠道 / 联动处置
```
### 部署（Helm 一条命令）
```bash
helm repo add falcosecurity https://falcosecurity.github.io/charts
helm install falco falcosecurity/falco \
  -n falco --create-namespace \
  --set driver.kind=modern_ebpf        # 用纯 eBPF 探针，免编译内核模块（要求内核 5.8+）
kubectl get pods -n falco -w            # 每个节点一个 falco Pod
```

### 规则示例：容器内起 shell
自己写的规则放到 values 的 `customRules` 里，格式四要素——`condition`（匹配条件）、`output`（告警内容和字段）、`priority`、`desc`：
```yaml
- rule: Terminal shell in container
  desc: 容器内起了交互式 shell，疑似入侵
  condition: spawned_process and container
             and proc.name in (bash, sh, zsh, ash)
  output: "容器内起 shell (pod=%k8s.pod.name ns=%k8s.ns.name
           image=%container.image.repository user=%user.name
           proc=%proc.name parent=%proc.pname cmdline=%proc.cmdline)"
  priority: WARNING
```
进任意容器执行 `bash`，立刻能看到告警：

```text
WARNING 容器内起 shell (pod=test-7f9c... ns=default image=nginx:latest
         user=root proc=bash parent=sh cmdline=bash)
```

### 配合 Argo Workflows 自动处置（删 Pod）
Falco 本身**只检测不阻断**，自动处置靠联动：Falcosidekick 把告警转发给 Argo Events，由 Sensor 触发一条 Argo Workflow 执行删除
```text
Falco 告警 → Falcosidekick（webhook）
           → Argo Events EventSource（接收）
           → Sensor 触发 Workflow：kubectl delete pod <恶意Pod>
           → Deployment 控制器自动拉起干净的 Pod（止血）
```
Falcosidekick 侧只需把 webhook 指向 Argo Events 的 EventSource：
```bash
helm install falcosidekick falcosecurity/falcosidekick -n falco \
  --set config.webhook.address=http://webhook-eventsource-svc.argo-events:12000/falco
```
> 实践要点：①自动删 Pod 是"止血"不是"治病"——如果镜像本身带毒，重建的 Pod 还是坏的，根治要回溯到镜像构建（这正是 CI 阶段镜像扫描的职责）。② 自动处置有误杀风险，建议先跑"只告警不处置"积累两周规则，确认误报率可接受后，再只对高置信度规则（如容器内起 shell、写 /etc/）开启自动删除。


## eBPF+Cilium+Hubble实现零侵入可观测性
前面讲的都是原理和单点工具，这里用一个完整的落地方案收尾：**Cilium 负责"网络数据面"，Hubble 负责"把这些数据变成可观测性"**——两者都以 eBPF 为地基，应用零改造。
### Cilium 是什么
Cilium 是云原生的 CNI（容器网络接口）插件，定位是高性能、安全的网络互联，专注解决 K8s 环境下容器与微服务间的网络连接问题。核心思路：**用 eBPF 程序接管数据面**，把传统上由 iptables 干的活（转发、过滤、负载均衡）搬到内核钩子里执行。三大核心能力：
| 能力     | 说明                                                                                                         |
| -------- | ------------------------------------------------------------------------------------------------------------ |
| 网络连接 | 动态负载均衡、服务发现、多租户隔离，完全兼容 CNI 规范，可作为 iptables 的现代化替代                          |
| 网络安全 | 基于 eBPF 的流量过滤器，策略粒度从 L3/L4（IP/端口）到 L7（HTTP/gRPC），支持服务间微隔离（Microsegmentation） |
| 可观测性 | 网络与服务层面的实时流量观测，由 Hubble 提供 UI 拓扑和 CLI 事件流                                            |

### 为什么能取代 iptables
传统 kube-proxy 的 Service 转发依赖 iptables 链（PREROUTING/POSTROUTING……），每个包要**逐条遍历规则**，还得走完整的 netfilter 路径， Service 规模一大，规则条数线性膨胀，转发延迟显著上升。你前文 XDP 表格里"比 iptables 快一个数量级"说的就是这件事。

Cilium 的做法：eBPF 程序挂在 TC/XDP 钩子上，**包一来就用 Map 查表一次命中**，直接决定转发去向——绕过 iptables 链和大部分 conntrack 开销。eBPF 程序随集群网络拓扑变化动态加载，Service 增删不需要刷规则表，天然适合大规模集群。

### Cilium 架构

```text
┌─ Node ──────────────────────────────────────┐
│  ┌────────────┐   管理   ┌───────────────┐  │
│  │ Cilium     │ ←──────→ │ kube-apiserver│  │
│  │ Agent      │          └───────────────┘  │
│  │(DaemonSet) │   动态加载/卸载 eBPF 程序     │
│  └─────┬──────┘   gRPC：暴露流量观测数据     │
│        │                                    │
│  ┌─────▼──────┐                            │
│  │ CNI 插件 / │  ← 配置节点网络接口          │
│  │ eBPF 数据面 │                            │
│  └────────────┘                            │
└─────────────────────────────────────────────┘
   集群级管理面：Cilium Operator（处理集群状态变更，如 IPAM）
```

- **Cilium Agent**：每个节点一个（DaemonSet），从 kube-apiserver 监听 Pod/Service/NetworkPolicy 变化，把网络拓扑翻译成 eBPF 程序加载进内核，同时通过 gRPC 对外输出流量观测数据；
- **Cilium Operator**：集群级管理面，处理跨节点的状态（如 IPAM 分配）；
- **CNI 插件**：负责节点网络接口的基础配置。

### Hubble：建立在 Cilium 之上的观测层

Hubble 的数据不是自己采的——**Cilium 的 eBPF 程序在内核里本来就看到了每一流，Hubble 只是把数据导出来变成人能用的东西**，所以天然零侵入。每个节点的 Hubble（随 Cilium 一起以 DaemonSet 运行）从 eBPF Map 提取流量元数据，通过 gRPC 供上层消费，同时暴露 `/metrics` 接口被 Prometheus 拉取。

三大核心功能：

| 功能             | 内容                                                                                   |
| ---------------- | -------------------------------------------------------------------------------------- |
| 服务依赖与通信图 | 自动生成服务间调用拓扑（UI 可视化），支持 HTTP/gRPC 等应用层协议详情，无需任何代码改造 |
| 网络监控与告警   | 检测通信失败并区分 TCP 层和 HTTP 层中断、追踪 DNS 解析失败、对异常流量主动告警         |
| 应用程序监控     | 统计 5xx/4xx 状态码发生率、P95/P99 通信延迟，经 eBPF 无侵入采集，可直接接入 Grafana    |

### 实战：从零跑通

**1. 安装 K3s（禁用默认网络组件，为 Cilium 让位）**：`--flannel-backend=none` 关掉默认 flannel，`--disable-network-policy` 关掉内置网络策略，两者都由 Cilium 接管。Terraform 部署的话把这两个参数写进 module 的 `main.tf`。

**2. 安装 Cilium CLI**（从 [GitHub Release](https://github.com/cilium/cilium-cli/releases) 下载对应平台版本，Mac 例）：

```bash
sudo tar xzvfC cilium-darwin-arm64.tar.gz /usr/local/bin
cilium version        # 验证
cilium install        # 向集群部署 Cilium
```

**3. 安装示例应用**（星战主题：deathstar 服务 + 两类客户端）：

```bash
kubectl create -f https://raw.githubusercontent.com/cilium/cilium/1.16.4/examples/minikube/http-sw-app.yaml
kubectl get pods      # 确认全部 Running
# 生成测试流量：tiefighter/xwing 不停访问 deathstar
```

**4. 安装 Hubble CLI 并启用 UI**：

```bash
# 从 https://github.com/cilium/hubble/releases 下载，解压到 /usr/local/bin
cilium hubble enable --ui     # 部署 Hubble Relay + UI
cilium hubble port-forward &  # 端口转发
hubble status                 # 确认连上 Relay
cilium hubble ui              # 自动打开浏览器 UI
```

UI 里能看到：服务拓扑图、通信延迟与请求耗时、按 namespace/label 过滤、实时 TCP 连接状态。

**5. CLI 观测流量（排障最常用）**：

```bash
hubble observe        # 实时输出每一条流的详细日志
```

一条典型日志长这样：

```text
 synthetic deep packet: xwing → deathstar (HTTP GET /)
 TCP Flags: SYN, SYN-ACK, ACK（完整握手）→ PSH（传数据）→ FIN（关闭）
 方向: to-endpoint / to-stack   端点: 1234 (xwing) → 5678 (deathstar)
```

能直接看到 TCP 握手全过程、PSH/FIN 标志、源/目的 IP 与端点身份、转发方向——"服务连不上是哪一层出的问题"在这里一眼可辨。

```bash
hubble observe --verdict DROPPED    # 只看被丢弃的流量（策略拦截/路由失败）
hubble observe --protocol http      # 只看 HTTP 层调用（可看到方法、路径、状态码）
```

> 收尾呼应：这一整套零侵入能力——L7 调用拓扑、策略审计、RED 指标——数据源头全是前文讲的 **TC/XDP 钩子上的 eBPF 程序和 eBPF Map**。Cilium 是"把 eBPF 能力产品化成网络基础设施"，Hubble 是"把 eBPF 能力产品化成可观测性"，原理和工具在这里合上了。




