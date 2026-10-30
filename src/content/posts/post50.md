---
title: k8s集群调优
published: 2026-10-30T20:11:23+08:00
description: 学习如何在大规模pod的场景下对集群进行调优
image: './images/a50.avif'
tags: [k8s]
category: '计算机技术'
draft: false
lang: '中文'
---



## 面临的挑战

假设要一次性调度 1 万个 Pod，管理不当会导致：**调度器瓶颈**（Pending 堆积）、**API Server 过载**（高频 CREATE/LIST 触发限流）、**etcd 延迟升高**（写入频繁）、**节点资源不均**（部分节点被打爆）、**CNI 并发 IP 分配跟不上**。

要记住一条主线：**大规模调度的瓶颈从来不在"调度算法"本身，而在整条链路的控制面**——客户端 → apiserver → etcd → scheduler → kubelet/CNI，每一环都可能先垮。调优就是逐环减压。

## 调度器优化

### 1. 控制 Pod 创建速率（最简单、最有效）

不要一次性 apply 一万个 Pod，分批 + 限速：

```bash
# 每批 500~1000 个，批间 sleep 给控制面喘息
for file in batches/batch_*.yaml; do
  kubectl apply -f "$file" --wait=false   # 异步创建，不等资源就绪
  sleep 10
done
```

`--wait=false` 值得单独强调：kubectl 默认会阻塞等待资源就绪，一万次同步等待产生的连接和重试全是 apiserver 的无谓压力。

### 2. 调优 kube-scheduler

**提高并发度**（1.19+ 支持配置并行调度线程数）：

```yaml
apiVersion: kubescheduler.config.k8s.io/v1
kind: KubeSchedulerConfiguration
profiles:
  - schedulerName: default-scheduler
    parallelism: 64    # 推荐 CPU 核数的 2~4 倍，过高会反噬 etcd，需压测
```

**精简耗时插件**：调度框架的每个插件在每个 Pod × 每个候选节点上都要执行，插件越多越慢。无状态服务关闭 VolumeBinding（持久卷绑定要访问 API）、只保留必要的 Score 插件：

```yaml
plugins:
  score:
    disabled:
      - name: "NodeResourcesBalancedAllocation"
    enabled:
      - name: "NodeResourcesLeastAllocated"
```

**节点剪枝（缩小候选集）**：1 万 Pod × 1000 节点的组合是 10^7 次评估，必须提前剪枝。用 nodeAffinity/标签先筛掉不符合的节点：

```yaml
affinity:
  nodeAffinity:
    requiredDuringSchedulingIgnoredDuringExecution:
      nodeSelectorTerms:
        - matchExpressions:
            - key: node-role.kubernetes.io/worker
              operator: In
              values: [batch]
```

**调大失败重试退避**：Pod 调度失败会进 backoff 队列反复重试（默认 1s~10s），大规模失败场景下退避风暴会拖垮调度器——调大 `MaxBackoff` 减缓重试频率。

### 3. 扩展调度架构

- **多调度器隔离**：批处理任务用独立调度器（Pod spec 里 `schedulerName: batch-scheduler`），和在线业务互不抢调度器资源
- **高性能调度系统**：AI/批处理/HPC 场景直接上 **Volcano**（支持 gang scheduling 成组调度、任务依赖）或 **Koordinator**（NUMA 感知、QoS 分级），它们都构建在调度框架之上

### 4. 效果验证

```bash
# --v=5 输出调度详细日志；关注两个核心指标
framework_extension_point_duration_seconds      # 各插件阶段耗时
scheduler_scheduling_duration_seconds_bucket    # 单 Pod 调度总延迟
```

### 5. 日常监控

- `kubectl get pods -w` 实时盯 Pending；事件里重点关注 `FailedScheduling`
- 跟踪 apiserver 的 QPS / 延迟 / 内存；Prometheus + Grafana 做可视化

## etcd 优化

大规模写入下 etcd 延迟一升，apiserver 跟着慢，调度器、控制器全线变钝——etcd 是控制面里**最先死、死得最难看**的组件。

**配置层**：

```bash
--auto-compaction-retention=1h   # 定期压缩历史版本，防存储膨胀
--snapshot-count=10000           # 控制快照触发频率
# WAL 完整性检查
--experimental-initial-corrupt-check=true
--experimental-compact-hash-check-enabled=true
```

**硬件层（最关键）**：etcd 对磁盘 fsync 延迟极其敏感（raft 要等 WAL 落盘才能确认写入）——**必须 SSD（NVMe 最佳）+ 独立磁盘**（不和 kubelet/容器运行时混用），16G+ 内存、4 核起步，开 NUMA 亲和减少跨核访问。

**部署架构**：
- **etcd 独立部署，不和 apiserver 混部**。原因：apiserver 突发流量（比如大规模创建）会占满节点资源，直接饿死同节点的 etcd；反过来 etcd 的 compaction 也会拖累 apiserver。局域网延迟微秒级，分离节点几乎零代价
- 3~5 个奇数节点副本，防单点

## kube-apiserver 优化

大规模创建时 apiserver 是请求汇聚点，卡顿表现为：请求响应慢、kubelet/controller-manager 与它通信超时、etcd QPS 激增触发熔断。三刀：

**调大并发窗口**：

```bash
--max-requests-inflight=4000           # 默认 400，读请求并发上限
--max-mutating-requests-inflight=2000  # 默认 200，写请求并发上限
--request-timeout=1m                   # 放宽请求超时窗口
--min-request-timeout=300
```

**让客户端别乱打**：
- 控制器/operator 一律用 **informer 本地缓存**（client-go 默认支持），禁止高频直接 List/GET——100 个 controller 各自轮询 List Pod，apiserver 直接被打爆；informer 是"一次 watch 全量缓存本地"，查询不产生 API 流量：

```go
informer := factory.Core().V1().Pods().Informer()   // 共享缓存，而非每次 GET
```

- 监控/审计类高频采集器注意限流，别和业务变更挤在一起
- 大批量的 pod/job 用自定义 CRD + controller 分组分批管理，而不是脚本裸打 apiserver

## 网络插件优化

调度成功了但 Pod 卡在 `ContainerCreating`，多半是 CNI 并发配网（IP 分配、veth 创建、路由下发）跟不上。现象对照：

| 现象 | 可能原因 |
|---|---|
| Pod 卡在 ContainerCreating | CNI 调用超时，网络未初始化 |
| 跨节点访问慢 | VXLAN 隧道延迟 / 转发路径性能不足 |
| kube-proxy CPU 占满 | iptables 规则过多 + 频繁变更（呼应 post23 的 O(n) 问题） |

**选型**：大规模集群直接上 **Cilium（eBPF 数据面）** 或 **Calico eBPF 模式**——规避 iptables 规则爆炸，IP 分配和策略下发都是 O(1) 哈希；flannel 只适合小规模。

**跨节点转发**：能用 BGP/native routing 就别走 VXLAN 封装（呼应 post23 calico BGP 模式——零封装纯三层转发）；大流量入口服务用 DSR + ECMP 避免流量中心化。

**kube-proxy**：不用 Cilium kube-proxy-free 的话，至少切 `--proxy-mode=ipvs`（大规模下比 iptables 省 CPU、低延迟，详见 post23）。

**节点内核参数**（大规模 Pod 高流量下的系统层地基，呼应 post19 的内核网络章节）：

```bash
# conntrack 表容量——K8s 节点每条连接都占表项，默认值远不够
sysctl -w net.netfilter.nf_conntrack_max=262144
sysctl -w net.netfilter.nf_conntrack_tcp_timeout_established=86400
# 文件句柄、监听队列、收包积压队列
ulimit -n 1048576
sysctl -w net.core.somaxconn=1024
sysctl -w net.core.netdev_max_backlog=250000
```

**网络层监控指标**：`conntrack_entries`（连接跟踪表水位，快满就丢新连接）、`cilium_drop_count_total`（丢包原因分布）、`iptables_rule_count`（规则规模）、转发延迟指标。

## 总结对比

| 优化方向 | 关键手段 |
|---|---|
| 创建速率 | 分批 + sleep + `--wait=false`，别让控制面吃瞬时洪峰 |
| 调度器 | parallelism 并发、精简插件、节点剪枝、多调度器/Volcano |
| etcd | SSD 独盘 + compaction + 独立部署 3~5 副本 |
| apiserver | inflight 上限、超时窗口、客户端 informer 缓存 |
| 网络层 | Cilium/Calico eBPF、BGP 替代 VXLAN、ipvs/eBPF 替代 iptables |
| 节点系统 | conntrack/句柄/队列长度等内核参数 |

一句话总结：**万级 Pod 的调度是一场"控制面抗压测试"——客户端限速是阀门，scheduler 是发动机，etcd 是地基，apiserver 是枢纽，CNI 是最后一公里；任何一环都是短板，调优就是把每一环都拉到能扛住洪峰的水平。**