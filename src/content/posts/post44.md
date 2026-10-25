---
title: AlertManager告警
published: 2026-10-24T20:11:23+08:00
description: 学习常见的promql表达式，配置AlertManager告警规则
image: './images/a44.avif'
tags: [k8s]
category: '计算机技术'
draft: false
lang: '中文'
---



## PromQL语法入门

### 选择器

PromQL 的一切表达式都从**选择器**开始，三要素：指标名圈定数据、`{}` 过滤标签、`[]` 圈定时间范围：

```text
http_requests_total{app="go-app", status=~"5.."}[5m]
└──────┬───────┘└────────────┬─────────────────┘└┬┘
     指标名              {} 标签过滤器        [] 时间范围
```

- `{}` 标签匹配符与 LogQL 完全同源：`=` 等于、`!=` 不等于、`=~` 正则匹配、`!~` 正则排除
- `[]` 把**瞬时向量**变成**区间向量**（如 `[5m]` 取最近 5 分钟的所有样本），`rate`、`increase` 这类函数只接受区间向量——这是新手最常撞的报错 `expected type range vector`
- 不写 `[]` 就是瞬时向量：每个时间序列只取最新一个样本

**实战小例**：`http_requests_total` 和 `http_requests_total[5m]` 是两种完全不同的东西——前者适合看"现在总共多少请求"，后者是喂给 `rate()` 算增长速率的原料。

### 操作符：算术、比较、集合

```text
# 算术：/ ^ 最常用，单位换算和比率计算都靠它
sum(node_filesystem_free_bytes{mountpoint="/"}) / 1024^3   # 字节 → GB

# 比较：默认只返回"比较为真"的样本；加 bool 则返回 0/1
node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes < 0.1   # 内存不足10%的机器
(node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes) < bool 0.1  # 返回 0 或 1，可画图

# 集合：and（都满足）/ or（满足其一）/ unless（排除），用于组合多个条件
node_load1 > 8 and on(instance) node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes < 0.1
```

### 聚合：`by` 与 `without`

聚合函数把多条时间序列合并成一条，`by` / `without` 决定按哪些标签分组，二者互补：

```text
sum by (handler) (prometheus_http_requests_total)      # 保留 handler 维度，按接口分组求和
sum without (instance) (prometheus_http_requests_total) # 去掉 instance 维度，其余标签全保留
```

- `by (instance, handler)`：支持多字段分组，统计"每个实例下各接口的请求量"
- 常用聚合函数：`sum` 求和、`avg` 平均、`max` / `min` 极值、`count` 计数、`avg` 求均值

**实战小例**：想快速发现"哪个接口被刷了"，`topk(3, sum by (handler) (prometheus_http_requests_total))` 一条语句就能在 Grafana 面板上定位异常路径，不用登录任何一台机器查日志。

### 常用函数

**1）topk / bottomk：找排名前 N / 后 N**

```text
topk(5, sum by (handler) (prometheus_http_requests_total))    # 请求量前5的接口
bottomk(3, sum by (handler) (prometheus_http_requests_total)) # 请求量最低的3个接口
```

**2）ceil / floor：向上 / 向下取整**

```text
ceil(node_filesystem_files_free{mountpoint="/"}/1024/1024)   # 向上取整
floor(node_filesystem_free_bytes{mountpoint="/"}/1024^3)     # 向下取整，磁盘可用GB整数
```

**3）sort / sort_desc：排序**

```text
sort(sum by (handler) (prometheus_http_requests_total))       # 从小到大
sort_desc(sum by (handler) (prometheus_http_requests_total))  # 从大到小，排行榜面板必备
```

**4）predict_linear：预测性告警**

```text
predict_linear(node_filesystem_files_free{mountpoint="/"}[1d], 4*3600) < 0
```

基于过去 1 天（`[1d]`）的数据做线性拟合，预测 4 小时（`4*3600` 秒）后的值，小于 0 意味着"按当前速度，4 小时后磁盘写满"。这类告警的价值在于**提前行动**：比起"磁盘已用 95%"的静态阈值，它能在凌晨磁盘缓慢填满、早上才爆掉的死亡剧本前提前几小时叫人。

**5）increase：区间内增量**

```text
increase(http_requests_total[1h])   # 过去1小时请求增加了多少
```

仅适用于 Counter（单调递增）指标。等价于 `rate(...) * 秒数`，所以想算"每小时增长量"用 increase 更直观；要"每秒速率"就直接用 rate，不必手动除 3600。

**6）rate：平均增长率（默认首选）**

```text
rate(http_requests_total[5m])      # 5分钟窗口内的每秒平均增长率
```

对窗口内**所有数据点**做外推平均，自动处理 Counter 重置（Pod 重启归零），结果平滑稳定——**画趋势图、写告警规则的默认选择**。

**7）irate：瞬时增长率**

```text
irate(http_requests_total[5m])     # 只用窗口内最后两个样本算瞬时速率
```

只取最后两个数据点，对突变极敏感：突发流量几秒内就能在曲线上反应出来。代价是毛刺多、窗口内历史点全浪费。**选型一句话**：告警和趋势用 `rate`，怀疑"刚才是不是抖了一下"用 `irate` 排查。

## Alertmanager核心配置详解

Prometheus 只负责"发现问题"，它把告警往外一推就完事；**去重、分组、路由、静默、抑制、重试这些"通知管理"的脏活全归 Alertmanager**。所有行为都由一份 `alertmanager.yml` 决定，四大块：

```yaml
global:          # 全局配置：SMTP、超时等
route:           # 路由树：告警进来后怎么分组、发给谁
receivers:       # 接收器：具体的通知渠道（邮件/webhook/钉钉……）
inhibit_rules:   # 抑制规则：高级别告警出现时屏蔽低级别噪音
```

### route：路由树与四个时间参数

Alertmanager 的路由是一棵**树**：`route` 顶层是根节点，每个告警从根开始匹配 `matchers`，命中的子节点决定走向，最终落到某个 `receiver`。根节点还负责**分组**：

```yaml
route:
  receiver: default-mail          # 兜底接收器，所有没匹配到子路由的告警都发这
  group_by: ["alertname", "cluster"]   # 按告警名和集群分组
  group_wait: 30s                 # 同组第一条告警到达后，等30s再发（攒同组后续告警）
  group_interval: 5m              # 已发送的组，新告警进来最少隔5m再发一次
  repeat_interval: 4h             # 组内告警未恢复，每4h重复通知一次
  routes:
    - matchers:
        - severity = "critical"
      receiver: oncall-webhook    # critical 告警走值班群
    - matchers:
        - team = "db"
      receiver: db-team-mail      # DB 相关告警发 DBA 邮箱
```

四个时间参数是面试和实战的高频考点，用一个生产剧本讲透：凌晨 1:00，某节点磁盘告警触发；1:10，同节点的 inode 告警也触发。

| 参数 | 作用 | 在剧本中的表现 |
| ---- | ---- | ---- |
| `group_wait` | 首条告警的**缓冲等待**，给同组告警留拼车时间 | 1:00 第一条到达后不立刻发，等到 1:00:30 才发第一条通知 |
| `group_interval` | 同组新告警的**最小发送间隔** | 1:10 inode 告警进组，距上次发送不足 5m，攒着；到点后与后续告警合并成一条发 |
| `repeat_interval` | 未恢复告警的**重复提醒周期** | 问题一直没修，每 4 小时再收到一条"还没恢复"的提醒 |
| `group_by` | 分组维度 | 两条告警 `alertname` 不同就不合并；若 `group_by: [cluster]` 则会合并成一条"该集群有2条告警" |

**调参经验**：`group_wait` 太长告警不及时、太短合并效果差，30s~1m 是常用值；`repeat_interval` 别设太短——告警轰炸会让值班人员产生"狼来了"疲劳，真正的大故障反而被忽略。

### inhibit_rules：抑制噪音

典型场景：整个集群挂了，Prometheus 不可达，随之产生几十条"服务无数据"告警——但根因只有一条"集群宕机"。抑制规则让根因告警出现时自动屏蔽下游噪音：

```yaml
inhibit_rules:
  - source_matchers:        # 根因：集群级故障（critical）
      - severity = "critical"
    target_matchers:        # 被抑制对象：所有 warning
      - severity = "warning"
    equal: ["cluster"]      # 只抑制同一个 cluster 的告警
```

`equal` 指定两个告警必须在哪些标签上相等才构成抑制——没有它，A 集群的 critical 会误伤 B 集群的 warning。同理，"节点宕机"抑制该节点上所有 Pod 告警，也是这套写法。

### 静默（Silence）

除了配置文件里的抑制，Alertmanager UI（`Status → Silences`）支持手动静默：按标签圈定一批告警，指定时间段内不通知。**实战场景**：计划内维护窗口（如周日凌晨升级内核），提前建一条 Silence，避免告警电话把值班人员从床上炸起来——这是告警纪律的基本功。

## Prometheus与Alertmanager如何搭配

两者是彻底解耦的两个进程，靠一条单向的 HTTP 推送连接。完整链路分四步：

```text
① PrometheusRule 定义表达式（post30 已讲）
② Prometheus 持续求值：不满足 → inactive；满足但未到 for 时长 → pending；持续满足超过 for → firing
③ firing 的告警由 Prometheus 推给 Alertmanager（按 alerting 配置发现地址）
④ Alertmanager 分组/路由/抑制后，经 receiver 发出通知
```

**第③步的对接配置**在 Prometheus 侧的 `alerting` 段——它沿用同样的服务发现机制找到 Alertmanager：

```yaml
alerting:
  alertmanagers:
    - static_configs:          # 裸部署：静态写地址
        - targets: ["alertmanager:9093"]
      # k8s 里则用 kubernetes_sd_configs 自动发现 Alertmanager Service/Pod，
      # kube-prometheus-stack 已默认配好，无需手动写
```

**`for` 字段是防抖的关键**：`expr: cpu > 80%` 不带 `for` 时，一次瞬时毛刺就会触发告警；`for: 5m` 要求持续 5 分钟才升级为 firing——"持续多久才算真问题"由它定义。在 Prometheus UI 的 **Alerts** 页能直接看到每条规则处于 inactive / pending / firing 哪个状态，排"告警怎么还没发"时先看这里：还卡在 pending，就是 `for` 没熬够，和 Alertmanager 无关。

**kube-prometheus-stack 中的配置入口**：Alertmanager 配置不是文件而是存在 Secret（`alertmanager-main`）里，改 values 即可：

```yaml
# kube-prometheus-stack values.yaml
alertmanager:
  config:                      # 写这里，Operator 自动渲染进 Secret 并热加载
    global:
      resolve_timeout: 5m      # 告警恢复后多久标记为 resolved
    route:
      receiver: default-mail
      group_by: ["alertname"]
      group_wait: 30s
      group_interval: 5m
      repeat_interval: 4h
    receivers:
      - name: default-mail
        # ...见下文邮箱示例
```

这比 post30 里提过的 `AlertmanagerConfig` CR 更常用——CR 适合"按团队拆分路由权限"，全局路由仍走这份主配置。

## 告警发往邮箱

邮箱是 Alertmanager **原生支持**的通知渠道，只需在 `global` 配 SMTP、在 receiver 里配收件人。以 QQ 邮箱为例（163 等同理）：

```yaml
global:
  smtp_smarthost: "smtp.qq.com:465"    # QQ邮箱 SMTP 服务地址（465 SSL 端口）
  smtp_from: "alert-bot@qq.com"        # 发件人，必须与下面账号一致
  smtp_auth_username: "alert-bot@qq.com"
  smtp_auth_password: "abcdefghijklmn"  # 不是登录密码！是邮箱设置里生成的"授权码"
  smtp_require_tls: false              # 465 端口走 SSL，这里关掉 STARTTLS

route:
  receiver: default-mail

receivers:
  - name: default-mail
    email_configs:
      - to: "ops-team@example.com"     # 收件人，多人逗号分隔
        send_resolved: true            # 恢复时也发通知（强烈建议开启，否则"问题修没修好"只能靠猜）
        headers:
          subject: '{{ .CommonLabels.alertname }} - {{ .Status }}'   # 自定义邮件主题
```

三个生产要点：

- **`smtp_auth_password` 是授权码不是密码**：QQ/163 邮箱都要求先在网页端开启 SMTP 服务并生成授权码，直接填登录密码必然报 `535 authentication failed`——这是配邮件告警第一大坑。
- **`send_resolved: true` 必开**：告警解决没有"恢复通知"，值班人员无法确认问题是否已修复，只能去 UI 里查，闭环断了一半。
- 告警内容默认用内置模板，`{{ .CommonAnnotations.description }}` 等字段来自 PrometheusRule 里写的 `annotations`——所以规则里把 summary/description 写清楚，邮件就自带排障上下文。

## 接入钉钉机器人

Alertmanager **不原生支持钉钉**，钉钉机器人的 API 格式和 Alertmanager 的 webhook 消息体不兼容——中间需要一层转换器 [prometheus-webhook-dingtalk](https://github.com/timonwong/prometheus-webhook-dingtalk)：Alertmanager 把告警以标准 webhook 推给它，它翻译成钉钉机器人消息格式再转发。

```text
PrometheusRule → Prometheus → Alertmanager
  → webhook_configs 推给 prometheus-webhook-dingtalk（翻译官）
    → 钉钉群机器人 API → 群里收到消息卡片
```

### 1）创建钉钉机器人

钉钉群里 **群设置 → 机器人 → 添加机器人 → 自定义**，安全设置选**加签**（最推荐，比关键词和 IP 白名单灵活），得到两个东西：

- `access_token`：机器人 webhook 地址里的一串 token
- `secret`：`SEC` 开头的加签密钥（泄露即被人冒发消息，当密码管理）

### 2）部署 prometheus-webhook-dingtalk

```yaml
# dingtalk.values.yaml
alertmanager:
  enabled: false        # 官方 chart 可捆绑 Alertmanager，我们复用已有的
config:
  targets:
    ops-bot:            # target 名，会出现在 webhook 路径里
      url: https://oapi.dingtalk.com/robot/send?access_token=你的access_token
      secret: SEC你的加签密钥     # 加签由它代算，不用手动拼签名
```

```bash
helm repo add timonwong https://timonwong.github.io/prometheus-webhook-dingtalk/
helm upgrade -i dingtalk-webhook timonwong/prometheus-webhook-dingtalk \
  -n monitoring -f dingtalk.values.yaml
```

### 3）Alertmanager 添加 webhook 接收器

```yaml
receivers:
  - name: oncall-webhook                      # 供路由树里的 critical 告警使用
    webhook_configs:
      - url: http://dingtalk-webhook.monitoring:8060/dingtalk/ops-bot/send
        # 路径规则：/dingtalk/<target名>/send，即上面配置里的 ops-bot
        send_resolved: true
```

默认消息模板比较朴素，想发"@所有人 + 自定义标题"的卡片，在 target 里加 `message` 模板：

```yaml
config:
  targets:
    ops-bot:
      url: https://oapi.dingtalk.com/robot/send?access_token=你的access_token
      secret: SEC你的加签密钥
      message:
        title: "{{ .Status }}: {{ .CommonLabels.alertname }}"
        text: '@所有人 {{ .Status }}: {{ .CommonLabels.alertname }}\n{{ .CommonAnnotations.description }}'
```

### 4）验证与排障

验证顺序自上而下：先在钉钉机器人页面点"测试"确认机器人本身通；再 curl 打 dingtalk-webhook 造一条假告警：

```bash
curl -X POST http://dingtalk-webhook.monitoring:8060/dingtalk/ops-bot/send \
  -H "Content-Type: application/json" -d '{
  "receiver": "oncall-webhook", "status": "firing",
  "alerts": [{"status": "firing",
    "labels": {"alertname": "TestAlert", "severity": "critical"},
    "annotations": {"description": "这是一条测试告警"}}]}'
```

群里没收到消息时按层排查：Alertmanager UI（`/api/v2/alerts`）里告警是否 firing → dingtalk-webhook 的 Pod 日志有无签名错误（多半是 secret 配错或 access_token 过期）→ 钉钉群机器人是否被安全策略限流（钉钉限制每分钟最多 20 条，告警风暴时会被吞，这也是 `group_by` 分组聚合真正上线前必须调好的原因）。

至此告警闭环完整成型：**PromQL 表达式发现异常（本文上半场）→ `for` 持续判定升级 firing → Alertmanager 分组路由 → 邮箱/钉钉通知到人 → resolved 通知确认恢复**。规则写得好（正确的 expr + 合理的 for）是第一环，通知通道稳定可达是最后一环，中间任何一环断了，监控都只是"看见了问题"而非"解决了问题"。