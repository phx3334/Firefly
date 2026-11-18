---
title: 云原生综合项目实践
published: 2026-11-21T20:11:23+08:00
description: 将大部分常用的云原生技术栈集为一体进行项目实践并记录实践中的一些重点和细节
image: './images/a52.avif'
tags: [项目实践]
category: '计算机技术'
draft: false
lang: '中文'
---



## 草稿
vscode编译器会把helm下面的/templates目录下的文件识别为纯yaml文件，于是会报错。所以我们需要声明.vscode/settings.json文件，内容如下：
```json
{
  "files.associations": {
    "**/templates/*.yaml": "plaintext",
    "**/templates/*.tpl": "plaintext"
  }
}
```
将上述这些文件声明为纯文本，避免编译器报错。

通过range循环渲染的业务yaml，其中探针部分如下：
```yaml
  # readinessProbe有默认超时时间
  readinessProbe:
    httpGet:
      path: /ready
      port: http
    initialDelaySeconds: 10
    periodSeconds: 10
    failureThreshold: 6
  livenessProbe:
    httpGet:
      path: /health
      port: http
    initialDelaySeconds: 30
    periodSeconds: 20
    failureThreshold: 3
```
对应业务代码
```go
// newEngine 构造 gin 引擎并挂上通用中间件、健康检查与指标端点。
func newEngine(cfg *config.Config, logger *zap.Logger, db *gorm.DB, redisConn *redisx.RedisConn) *gin.Engine {
	gin.SetMode(gin.ReleaseMode)
	engine := gin.New()
	// otelx 中间件放在日志中间件之前：日志能拿到请求 ctx 中的 trace_id
	engine.Use(otelx.GinMiddleware(), httpx.GinLogger(logger), httpx.GinRecovery(logger))

	// 存活探针：纯进程检查、零 IO——HTTP 还能响应就返回 200。
	// 不查依赖：MySQL/Redis 故障是"重启解决不了的病"，交给 /ready 摘流量即可，
	// 否则依赖宕机会让全体 Pod liveness 失败，触发无意义的重启风暴。
	engine.GET("/health", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "alive"})
	})
	// 就绪探针：探 MySQL 与 Redis（统一 2s 超时，防网络黑洞让 /ready 挂死）；
	// 任一不可用返回 503，K8s 据此从 Service 摘除流量
	engine.GET("/ready", func(c *gin.Context) {
		sqlDB, dbErr := db.DB()
		if dbErr != nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{"status": "unready", "mysql": dbErr.Error()})
			return
		}
		ctx, cancel := context.WithTimeout(c.Request.Context(), 2*time.Second)
		defer cancel()
		if pingErr := sqlDB.PingContext(ctx); pingErr != nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{"status": "unready", "mysql": pingErr.Error()})
			return
		}
		if pingErr := redisConn.Client.Ping(ctx).Err(); pingErr != nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{"status": "unready", "redis": pingErr.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"status": "ready"})
	})

	return engine
}
```

### 业务细节
grpc采取懒连接，懒连接把"进程启动"与"依赖可用"解耦——这正是 K8s 环境的标准姿势，因为 启动顺序本来就不可控 （调度器、就绪探针、滚动更新都可能让任意服务先后就绪）。
```go
// VideoGRPCClient 调用 video-svc 的 gRPC 客户端。
//
// 使用 grpc.NewClient 懒连接：构造时不做网络操作，
// 启动顺序不依赖 video-svc 已就绪；真正调用时才建立连接。
type VideoGRPCClient struct {
	client pb.VideoServiceClient
}

func NewVideoGRPCClient(addr string) (*VideoGRPCClient, error) {
	conn, err := grpc.NewClient(addr, grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithStatsHandler(otelgrpc.NewClientHandler()))
	if err != nil {
		return nil, err
	}
	return &VideoGRPCClient{client: pb.NewVideoServiceClient(conn)}, nil
}
```

app.kubernetes.io 前缀的字段是标准字段，社区统一约定，全世界通用。像自己写的自定义那种字段，适合自己内部使用。

### 采集细节（下面可能还会手动显示加_total，但不用影响，知道本项目其实是最后统一加后缀就行了）
#### Metrics 埋点上报流程（以 `video_upload_total` 为例）

先说明一点：RED 指标（请求量、延迟、状态码）已经不在代码里埋了，改由 collector 的 spanmetrics 从 span 派生（原因见后文）。现在代码里手写的指标只剩业务语义指标，下面用"上传成功率"这条链路走一遍完整流程。

##### 先认识四个名词

| 名称 | 是什么 | 层级 |
|---|---|---|
| **resource 属性** | 描述"**谁**产生了数据"的进程级身份 | 进程级，每个进程只有一组 |
| **attribute** | OTel 的键值对类型（`go.opentelemetry.io/otel/attribute`） | 类型 |
| `attribute.String("result", result)` | 构造一个键值对 `result="success"` | 数据点级 |
| `video_upload_total` | 指标名 | 指标级 |

```go
res, err := resource.New(ctx, resource.WithAttributes(
    attribute.String("service.name", serviceName),            // video-svc
    attribute.String("service.version", version),             // dev
    attribute.String("deployment.environment", environment),  // docker
))
```

这个 resource 会交给 `TracerProvider` 和 `MeterProvider`，所以该进程产出的**所有 span、所有指标**都自带它——相当于数据的"身份证"。collector 的 `resource_to_telemetry_conversion` 把它转成 Prometheus 标签时，点号会变成下划线。

特点：数量少、全进程共用。服务名、版本、环境、集群这类信息放这里；`user_id`、URL 这类高基数、只在单条数据上有意义的字段绝不能放。

**attribute** 是键值对类型，既可以挂 span 也可以挂指标，所以同一行代码能出现在两个地方：

```go
// 挂到指标
l.uploadTotal.Add(ctx, 1, metric.WithAttributes(attribute.String("result", result)))
// 挂到 span
span.SetAttributes(attribute.String("upload.result", result))
```

**`attribute.String("result", result)`** 里的 `result` 取值为 `success` / `client_error` / `server_error`，构造出来是 `result="success"`，落到 Prometheus 就是一个**标签**。它属于"这一次测量"的维度，决定这条 counter 被拆成几条时间序列：3 个取值 → 3 条序列。换成 `user_id` 就是 10 万条序列，直接把 Prometheus 打死——这也是 spanmetrics 的 dimensions 只放路由模板、不放真实路径的原因。

**`video_upload_total`** 是最终暴露给 Prometheus 的指标名，配合 `Int64Counter` 表示"只增不减的累计次数"。`_total` 后缀是 Prometheus 对 counter 的命名约定（OTel 自身不强制）。业务代码里注册的是裸名 `video_upload`，后缀由 collector 的 prometheus exporter 统一翻译（`add_metric_suffixes: true`）；名字里已有的 `total` 会先去重再加，不会变成 `video_upload_total_total`。

层级关系：

```
MeterProvider ── resource: service.name=video-svc, env=docker     ← 进程身份
    └── Int64Counter "video_upload"                                ← 指标定义（裸名）
            └── Add(1, result="success")                           ← 一次测量 + 数据点标签
                    ↓
video_upload_total{service_name="video-svc", result="success"} 3   ← exporter 翻译后的最终名
```

业务代码只表达语义（counter、单位、维度），后缀在 exporter 出口处统一生成。

Prometheus 里一条时间序列的唯一性 = 指标名 + 全部标签。resource 属性回答"哪个服务、哪个环境"，数据点属性回答"什么结果、什么路由"。

##### 完整流程

1. **进程启动：初始化 MeterProvider**
`otelx.Init` 创建 OTLP gRPC metric exporter（指向 `otel-collector.observability:4317`）和 `PeriodicReader`（间隔 10s），注册为全局 MeterProvider，同时挂上上面那组 resource 属性——这就是后面 `service_name` 等标签的来源。

2. **注册指标定义（服务构造阶段）**
`NewVideoUploadLogic` 里调用 `otelx.Meter("video-svc").Int64Counter("video_upload_total", ...)`，拿到 counter 句柄存进结构体。

> 这一步只注册元信息，还没有任何数据；真正上报发生在每次 `Add`。放在服务构造而不是 `init`，是因为必须晚于 `otelx.Init` 才能拿到生效的 MeterProvider。

3. **请求进入业务函数**
`Upload()` 一进来先 `result := "success"`，然后用 `defer` 声明"无论从哪条路径返回，都要计数一次"。

4. **执行业务**
校验大小/扩展名 → 写 MinIO → 落库（status=transcoding）→ 投递 `video.transcode`。

5. **确定 result 三分类**
超限/格式不支持 → `client_error`；对象存储/DB 失败 → `server_error`；正常走完 → `success`。defer 里还有兜底：返回了错误但没显式分类的，一律按 `server_error`。

6. **写入 SDK 本地聚合器**

```go
l.uploadTotal.Add(context.Background(), 1,
    metric.WithAttributes(attribute.String("result", result)))
```

> 注意用的是 `context.Background()` 而不是请求 ctx：客户端中途断开时请求 ctx 已 Done，继续用它可能丢记录。这一步只是把数据交给 SDK 内存里的聚合器，不是立刻发出去。

7. **SDK 周期导出**
PeriodicReader 每 10s 触发一次，把这段时间的聚合结果按 OTLP 打包，gRPC 推给 collector gateway。10s 刻意短于 Prometheus 的 15s 抓取间隔，保证每次抓到的都是新值。

8. **Collector 接收、转换、暴露**
collector 的 metrics 管道（memory_limiter → batch → prometheus exporter）收到后，在 `:8889` 以 Prometheus 文本格式暴露。exporter 的 `add_metric_suffixes: true` 负责把 OTel 语义名翻译成 Prometheus 方言（counter 补 `_total`、有单位的补单位，已含的 token 去重）；`resource_to_telemetry_conversion` 把 `service.name` 转成 `service_name` 标签。Prometheus 每 15s 抓一次，写入时序库，之后算 SLO、画图、告警。

9. **查询时怎么用**
上传 SLO 的分子分母都来自这一个 counter：

```promql
sum(rate(video_upload_total{result="success"}[5m]))
/
sum(rate(video_upload_total{result=~"success|server_error"}[5m]))
```

`client_error` 不计入分母——用户传了坏文件不是服务违约。

> 一句话 Metrics：启动时建 MeterProvider → 构造业务对象时注册 counter → 业务函数里 `defer` 保证记一次 → `Add` 写入 SDK 内存聚合器 → 每 10s OTLP 推给 collector → collector 转成 Prometheus 格式暴露 → Prometheus 拉取存储。

#### Trace上报流程
前提：同样在 Gin 中间件里开启 Trace（手写版本或者 otelgin 官方埋点），使用 OTel Tracer。

1. **程序初始化**
调用 `otel.Tracer("fake_tiktok/http")` 获取 Tracer，注册 Trace 相关 SDK、导出器（指向 otel-collector gateway 的 4317/4318 OTLP 端口）。
2. **请求进入 Gin Trace 中间件**
读取 HTTP 请求头里的 `traceparent`（W3C 标准链路头）：

- 如果上游带了合法 `traceparent`：解析出 `trace_id、span_id、trace_flags`，继承这个链路；
- 如果没有：**新建一条链路，生成全新 trace_id，生成本次请求的根 span**。

3. **创建根 Span**`tracer.Start(ctx, spanName, ...)`，创建代表整个 HTTP 请求的根 Span，打上 method、route 等属性；新的 ctx 会带着这个 Span 信息，替换原来的 ctx，往下传递。
4. **执行 c.Next ()，执行业务代码**
业务代码拿到携带 Span 的 ctx：

- 业务内部调用 RPC、MySQL、Redis、HTTP 下游时，把 ctx 传进去；
- 每一次下游调用，都用这个 ctx 新建**子 Span**，记录调用名称、地址、耗时、异常信息；
- 上下文自动把 `traceparent` 注入到下游请求的 Header，下游服务继续复用同一个 trace_id，形成整条链路。

5. **业务处理完成，回到中间件**
给根 Span 补充状态：如果 5xx 错误，设置 Span 状态为 Error，记录异常 message；
**调用 span.End ()** → 标记 Span 结束，计算这个 Span 的总耗时。
 
> ⚠️ span.End () 非常关键，不 End，这个 Span 不会交给 SDK 导出。

6. **SDK 后台批量上报 Span**
Span 结束后，先进入 OTel SDK 的内存队列；SDK 后台协程攒一批 Span，打包成 OTLP Trace 数据，推送给 OTel Collector Gateway。
7. **Collector 处理 Trace，写入 Tempo**
Gateway 收到 Trace，经过处理器，通过 Tempo Exporter 写入 Tempo；Tempo 底层把 Trace 块存在 MinIO 对象存储。

> Tempo 不做索引，靠 trace_id 查询；Grafana 前端输入 trace_id，去 Tempo 拉取整条链路展示。

> 一句话 Trace：接收请求，解析 / 生成 trace_id → 创建根 Span，ctx 携带 Span 往下透传 → 业务内部各个调用创建子 Span（自动传递 traceparent） → 业务完成结束 Span → SDK 批量推给 Collector → 存入 Tempo，Grafana 根据 traceId 查看链路。

#### log输出
1. Go 业务使用 zap，配置输出目标：`zapcore.AddSync(os.Stdout)`
打印 JSON 单行日志（就是你前面 operators 里 json_parser 解析的那种）
2. 业务 `zap.Info/zap.Error` → 输出到进程标准输出（stdout）
3. containerd 捕获容器 stdout，自动写到宿主机 `/var/log/pods/xxx/N.log`（日志实体文件）
4. OTel Agent（DaemonSet，filelog receiver）tail 这个目录下日志文件
5. filelog 的 operators：`container` 解析 CRI 格式 → `json_parser` 解析 zap json → 加工标签 → loki exporter 推 Loki

#### collector采集日志
otel collector 分两种形态，同一个镜像、两份配置：

| 形态 | 工作负载 | 职责 |
|------|----------|------|
| gateway | Deployment + Service | 接收业务上报的 OTLP 追踪与指标（4317/4318），分流给 Tempo / Prometheus |
| agent | DaemonSet | tail 节点上的容器 stdout，解析后写入 Loki |

agent 只能是 DaemonSet：它 tail 的是节点本地文件（hostPath `/var/log/pods`），一个 Pod 只能看到自己所在节点的日志，用 Deployment 多副本必然漏采。

必须用 **contrib 版**：`otel/opentelemetry-collector-contrib`。

core 版（`otel/opentelemetry-collector`）不含 `filelog` receiver 与 `loki` exporter，写进配置会直接启动失败报 unknown type。core 版只够纯 OTLP 收发的场景用。

otel-agent采集日志的时候需要从尾部采集，避免大量历史日志迅速涌入，此外还需要配置断点续采的文件，记录每个文件的读取位点，避免又从头开始读。
```yaml
#文件路径的key
storage: file_storage
```

日志文件是 kubelet / containerd 在宿主机上创建的，属主 `root:root`、权限 `0640`，所以 agent 容器必须以 uid=0 运行：

```yaml
securityContext:
  runAsUser: 0
  runAsGroup: 0
  readOnlyRootFilesystem: true
  allowPrivilegeEscalation: false
  capabilities:
    drop: ["ALL"]
  seccompProfile:
    type: RuntimeDefault
```

为什么不建议非 root：

- uid≠0 时权限表的 owner / group / other 三列全不命中，直接 Permission denied。即便用 `uid≠0 + gid=0` 靠 group 位读到日志，`file_storage` 的位点目录是 hostPath，**不受 `fsGroup` 管理**，非 root 写不进去——等于拿断点续采换非 root，不划算。
- 那换成"放宽宿主机 `/var/log/pods` 权限"？影响的是节点上**所有 Pod** 的日志隔离，代价比单个采集器用 root 大得多。

所以这里接受 root，但只给"最小特权 root"：**身份保留、权力清空**。uid=0 读属主为 root 的文件走 owner 位匹配，用不上 `DAC_OVERRIDE` 这枚"无视权限表"的徽章，所以 capability 可以全删；再配合只读根文件系统（也就是除了几类特殊挂载以及volumeMounts挂载之外受其自身规则控制，容器内其他所有文件只读）、禁止提权和 RuntimeDefault seccomp，即使日志解析器被恶意日志打穿，攻击者也拿不到任何越权能力，爆炸半径收敛到"能读日志 + 能发网络"。



**SLA**:对外给客户的服务保障协议，没达标需要赔付，追责。
**SLO**:内部服务目标，比SLA更严格，为了保证SLA可以达标。
**SLI**：用来衡量SLO的原始指标，比如请求成功率。

### 可观测性落地时，容易后知后觉的几个点

**1. 业务全返回 HTTP 200 时，RED 指标是假的**

本项目所有业务响应都是 `HTTP 200 + 业务码`：`pkg/httpx/response.go` 里的 `Result()` 不管成功失败，一律 `c.JSON(http.StatusOK, ...)`，失败只体现在 body 的 `code` 字段（3=成功，4=错误）。这意味着 `http_status_code=~"5.."` 一条序列都匹配不到，按状态码算出来的错误率恒为 0、可用性恒为 100%——不是服务真的健康，是这套指标根本看不见业务失败；5xx 里只剩 panic 和框架级故障。

所以这个 SLI 只能叫"进程可用性"；真正的业务可用性要靠业务指标：`video_upload_total{result="success|client_error|server_error"}`，并且分母排除 `client_error`——用户传了个损坏的视频，不该算服务违约。

反过来，如果直接拿"HTTP 200"当成功，SLO 会一直显示 100%，直到用户先发现故障。

**为什么很多项目都这么写（HTTP 200 + 业务码）**，简单说三条：

1. **前端省事**：统一拦截器只判 HTTP 是否成功，再读 body 的 `code` 分支处理，业务错误不必每个接口都写 try/catch；一旦返回 4xx/5xx，axios、fetch 都会走异常分支，反而要额外包一层。
2. **避开中间设施的"错误动作"**：网关、CDN、WAF、APM 对 5xx 有特殊策略（错误页、熔断、重试、告警），业务失败混进 5xx 会触发一堆与业务无关的机制。
3. **脚手架惯性**：gin-vue-admin 这类模板就是这么写的（`code=7` 之类），大量项目直接沿用。

合理的边界是：**业务错误可以 200，系统错误必须 5xx**（数据库连不上、依赖超时、panic 不该伪装成成功）。对外提供 API 时更应守 HTTP 语义，`200 + code` 只适合"只给自己前端/内部服务调用"的场景。

**2. RED 指标：为什么最后不用业务埋点，而是从 span 派生**

先还原旧方案。最开始是在 `pkg/otelx/gin.go` 里手写一个 HTTP 中间件，请求结束时记三个 OTel 指标：

```go
meter := otel.Meter("fake_tiktok/http")
requestsTotal, _ := meter.Int64Counter("http_server_requests_total")
requestDuration, _ := meter.Float64Histogram("http_server_request_duration_seconds")
errorsTotal, _ := meter.Int64Counter("http_server_errors_total")

// ... c.Next() 之后
requestsTotal.Add(metricCtx, 1, metric.WithAttributes(
    attribute.String("method", c.Request.Method),
    attribute.String("route", route),
    attribute.String("status", statusStr),
))
requestDuration.Record(metricCtx, time.Since(start).Seconds(), metric.WithAttributes(
    attribute.String("method", c.Request.Method),
    attribute.String("route", route),
))
```

四个进程照旧 OTLP 推给 collector，collector 用 prometheus exporter 在 `:8889` 暴露，Prometheus 再拉。**这条 push + pull 的链路本身没问题，现在也还在用，变的只是 RED 指标由谁产生。**

决定删掉这段埋点、改用 spanmetrics，原因有四个：

1. **漏埋是必然的，而且不会报错。** 中间件只对"走了 Gin 的 HTTP handler"生效。worker 的 Kafka 消费、gRPC server、以后新增的入口（定时任务、管理端口），都得各写一份；少包一个 handler，那个接口就在监控里消失——没有编译错误、没有运行时日志，只是面板少一条线。spanmetrics 不需要你记得：只要请求产生了 span，指标就有。

2. **口径会漂。** 手写意味着每个服务各自决定：单位用秒还是毫秒、分桶按什么粒度。

3. **同一份事实维护两遍。** 做链路追踪时，方法、路由、状态码这些属性本来就要打在 span 上（Tempo 里按状态码筛、按路由看耗时）。再在指标里重复一遍，等于同一件事写两次。

4. **对齐与下钻。** spanmetrics（collector处理器,通过span自动聚合出RED指标） 从 span 派生，指标和 trace 天生同源：错误率的分子和你在 Tempo 里筛出来的错误 span 是同一批；配合 exemplar（不是标签，只是挂在指标采样点上的一小段附加信息，里面带 trace_id。） 还能从指标数据点直接跳到那条 trace。手写埋点做不到这层对应，除非把 trace_id 塞进指标 label（高基数，基本不可行）。

| 指标类型 | 谁产生 | 例子 |
|---|---|---|
| RED（量、延迟、状态码） | collector 的 spanmetrics，从 server span 派生 | `calls_total`、`duration_seconds_bucket` |
| 业务语义 | 业务代码埋点，OTLP push | `video_upload_total{result=...}`、`counter_flush_lag_seconds` |

**3. 指标名**
业务代码只表达语义，不手写后缀：注册的就是裸名 `video_upload`、`calls`、`duration`（带 `unit=s`）。翻译成 Prometheus 方言是 exporter 的活，`add_metric_suffixes` 开着即可：
- counter 补 `_total`：`video_upload` → `video_upload_total`、`calls` → `calls_total`；
- 有单位的补单位：`duration`（unit=s）→ `duration_seconds`，直方图再加 `_bucket` → `duration_seconds_bucket`；
- 名字里已经有的 token 不会重复加：`counter_flush_lag_seconds` 结尾已是 `seconds`，保持原名；`xxx_total` 也不会变成 `xxx_total_total`（现代版本的 `normalizeName` 会先去重再追加）。

一个生成点、一套规则，看板和告警按 exporter 的输出写。**指标名是服务契约**：升级 collector 前先 diff 一次 `:8889/metrics` 的名字集合，名字一变，所有查询会静默变成 no data，而"没数据"和"一切正常"在面板上长得一模一样。（后缀`_total`并非语法强制，只是社区约定俗成）

**4. push 模式下，ServiceMonitor 只需要一个**

业务不暴露 `/metrics`，四个进程用 OTLP 推到 collector，Prometheus 只抓 `otel-collector:8889`。再给业务建 ServiceMonitor 只会抓到 404。

collector 侧必须开 `resource_to_telemetry_conversion`，把 `service.name` 转成 `service_name` 标签；否则四个服务的指标混成一坨，按服务聚合无从谈起。

**5.给 worker进程加探针**
worker 原来没有 HTTP 端口。推模式虽然不需要 `/metrics`，但探针需要一个端口，于是补一个只给探针用的 `:9091`：`/health` 只判心跳（90s 没更新返回 503），`/ready` 才查 MySQL。

**6. 采样只影响 trace，不影响指标；但指标也不带 trace_id**

指标是聚合数据，天然没有 trace_id。靠 exemplar（spanmetrics 的 `exemplars.enabled`）把 trace_id 挂到直方图数据点上，Grafana 才能从告警点直接跳到那条 trace；日志侧由 zap 写入 `trace_id` 字段，Loki 用 derivedFields 配跳转。

三个信号各司其职：指标负责"发现"，trace 负责"定位到哪一跳"，日志负责"看具体报错"。

### prometheus抓取中间件指标

#### SM配置

```yaml
prometheus:
  prometheusSpec:
    # 关键三行
    serviceMonitorSelectorNilUsesHelmValues: false
    podMonitorSelectorNilUsesHelmValues: false
    ruleSelectorNilUsesHelmValues: false
```

这三个字段解决的是同一个问题：**kube-prometheus-stack 默认只认自己 helm release 名下的 CR**。

装 chart 时，Prometheus CR 的 selector 会被模板渲染成 `matchLabels: {release: "<release名>"}`——意思是"我只发现带 `release=<我的名字>` 标签的 ServiceMonitor"。这个设计的初衷是防止一个集群里多个 kube-prometheus-stack 实例互相抢对方的监控对象，逻辑没问题，但对本项目是致命的：

本项目装 prometheus 时 release 名是 `prometheus`，而中间件是**另外装的 helm release**：像mysql,redis,kafka,minio等中间件用helm chart进行安装生成的SM都不带release标签,所以三行全为 false 的效果是把 label selector 渲染成 `{}`（空选择器 = 全要），即Prometheus可以发现所有ServiceMonitor.

- `serviceMonitorSelectorNilUsesHelmValues` 不关 → `/targets` 里**一个中间件 target 都没有**，MySQL/Redis/Kafka/MinIO 指标一条都抓不到，而且**没有任何报错**——selector 匹配不到是静默的，你只会发现面板没数据；
- `ruleSelectorNilUsesHelmValues` 不关 → 我们的 `fake-tiktok-slo` / `fake-tiktok-middleware` / `fake-tiktok-mesh` 三个 PrometheusRule 也没有 release 标签，**SLO 规则和告警整体不加载**——更阴险的是 `/rules` 页面空空如也，不报错，告警系统像"开了但永远不响"；
- `podMonitorSelectorNilUsesHelmValues` 不关 → 网格层的 `istio-sidecars` PodMonitor 同样带不了 release 标签，sidecar 指标一条抓不到——这行和上一行是同一批手写 CR 的命门。

#### 中间件的端口：全部交给 helm chart 默认生成，values 不 pin

一个端口在集群里其实有四层，以 MySQL 为例：

```
容器端口（3306）  ← bitnami chart 模板里的 containerPorts，仓库看不到
   ↓
svc.port（3306）  ← chart 生成的 Service，集群内寻址用
   ↓
svc.targetPort     ← 按"名字"指回容器端口（不是数字！）
   ↓
指标端口（9104）   ← values 里 metrics.enabled: true 触发 chart 起 mysqld_exporter sidecar
```

各中间件的四层全部由各自 chart 的默认值生成，**我们的 values 只写差异**（副本、资源、凭据、metrics 开关），不写任何端口。为什么不 pin，一条原则就够：

> **契约的两边在同一个 owner 手里，就让 owner 全权生成；跨 owner 才需要显式接缝。**

- MySQL/Redis/Kafka：容器端口、svc 端口、指标端口、**以及 chart 生成的 ServiceMonitor 的端口名**，四者同出一个 chart——同一个 owner 管两边，永远不可能互相漂移。我们去 values 里 pin 端口，等于凭空引入"我们对 chart 键名的猜测"（键名随大版本变，pin 了照样断），还多了一处会撒谎的配置。
- 唯一的**跨 owner 接缝**是业务侧填的连接地址（`mysql.middleware:3306`、`kafka.middleware:9092` 等，写在业务 chart 的 values 里）和我们手写的 ServiceMonitor 端口名（minio 的 `api`、collector 的 `prometheus`）。前者靠服务 fail-fast 兜底——连不通时服务启动直接失败，不会静默带病运行；后者靠部署后一条命令核对（`kubectl get svc -o jsonpath='{.spec.ports[*].name}'`），因为 ServiceMonitor 按**端口名**匹配，chart 改名会静默失配。

#### 命名空间划分

```
middleware      ← mysql、redis、kafka（helm -n middleware 装）
observability   ← prometheus、alertmanager、grafana、tempo、loki、otel-collector、kafka-exporter
fake-tiktok     ← 业务三服务 + worker + web
istio-system    ← ingress gateway
```

#### Prometheus 如何跨命名空间抓：两层发现，各管各的

```
第①层：Prometheus 找 ServiceMonitor（"去哪些命名空间找声明文件"）
   prometheusSpec.serviceMonitorNamespaceSelector: {}   ← 空集 = 所有命名空间
   prometheusSpec.serviceMonitorSelector: {}            ← 不看标签（就是上面那三行的效果）
        ↓ Operator 监视到 middleware 里的 SM

第②层：ServiceMonitor 找 Service（"按声明去哪抓服务"）
   chart 生成的 SM（bitnami 模板）→ spec.namespaceSelector.matchNames: [自己的命名空间]
        = 只在本命名空间（middleware）里选 Service ✓
   我们手写的 minio SM 在 observability → spec.namespaceSelector.matchNames: [middleware]
        = 显式跨到 middleware 选 Service ✓
        ↓ Operator 渲染成 Prometheus 的 scrape_configs

Prometheus ──ClusterIP:9104/9121/9308/9000──▶ 各中间件 /metrics
```

注意抓取方向：**永远是 Prometheus 主动出去拉，中间件从不需要访问 Prometheus**——这就是中间件端口全部 ClusterIP 即可、一个 NodePort 都不用开的原因。

#### 指标端点是谁定义的：四种类型

| 中间件 | /metrics 端点来源 | 端口 | ServiceMonitor 谁写的 |
|---|---|---|---|
| MySQL | bitnami chart 起 **mysqld_exporter sidecar**（`metrics.enabled: true`） | 9104 | chart 自动生成 |
| Redis | bitnami chart 起 **redis_exporter sidecar** | 9121 | chart 自动生成 |
| Kafka | 独立 Deployment 跑 **kafka-exporter**（JMX 没有消费组 lag，所以单起一个） | 9308 | 我们手写（和 Deployment 同文件） |
| MinIO | **服务端原生自带** `/minio/v2/metrics/cluster`，与业务 API 共用 9000，`MINIO_PROMETHEUS_AUTH_TYPE=public` 免鉴权 | 9000 | 我们手写（`manifests/`） |
| 业务四进程 | 都不暴露——OTLP 推给 collector，只抓 `otel-collector:8889` | 8889 | 我们手写 |

共同点：**中间件没有"推"的能力，标准做法就是旁边跑一个（sidecar/exporter）或服务端自带，吐 HTTP `/metrics` 文本，等 Prometheus 来拉**。这也是 pull 模型的全部：Prometheus 按两层发现找到 Service，按端口名定位到端口，GET /metrics，解析入库。

### Kafka 的两路指标采集

Kafka 是本项目唯一一个**同时开两路采集**的中间件，不是配置冗余，是两路各自盯着一类故障模式，谁也替代不了谁。

#### JMX exporter

bitnami chart 的 `metrics.jmx.enabled: true` 会在 kafka 的 StatefulSet 里注入一个 `jmx-exporter` sidecar 容器（跑 jmx_prometheus_standalone.jar），读 JMX MBean 暴露在端口 `metrics` 上，Service/ServiceMonitor 由 chart 自动生成。抓的全是 **broker 自身状态**：线程池空闲度（请求处理能力）、副本/ISR/离线分区（数据冗余是否健康）、ActiveController（控制面选举）、BytesIn/Out、MessagesIn 等 topic 流量、JVM 堆/GC/线程、连接数。

一句话：**JMX 抓"broker 病没病"——线程/副本/JVM/流量**

#### kafka-exporter

独立 Deployment（`:9308`，ServiceMonitor 手写），抓的全是**消费进度**：`kafka_consumergroup_lag{consumergroup, topic, partition}`（每个消费组积压多少条）、current offset vs logEndOffset（消费者推没推进）、lag 的 rate/deriv（积压在涨还是在消，告警靠它区分"慢"和"死了"）。JMX 结构性拿不到 lag——消费进度存在内部 topic `__consumer_offsets`，broker 的 MBean 列表里没这个状态，所以必须独立一路。

一句话：**exporter 抓"业务消费跟没跟上"——lag/offset**

生产上这个组合就是标准形态：JMX + lag exporter 并存，Prometheus 里同时存在 `kafka_*` 和 `kafka_exporter_*` 两个指标族。

#### 两路有重复，为什么可以不管

重复区确实存在：topic 级流量（bytes/messages in-out）、分区计数、ISR 状态，两边都有近似实现。不裁剪的理由三条：

1. **成本可忽略，裁剪省不出钱。** Prometheus 存储按时间序列计费级别算，Kafka 全套 JMX 几千条序列、重复区撑死几百条，15s 间隔一年也就几十 GB。为了省这点存储砍掉一路信号，省下的是磁盘、引入的是"出事时少一个视角"——方向反了。
2. **重复的信号源本身就是生产追求的冗余。** exporter 挂了，JMX 还在，流量视角不断；jmx-exporter sidecar OOM 被杀，exporter 还在，lag 视角不断。更妙的是**两路对不上本身就是排障线索**：exporter 看到 lag 在涨、JMX 流量正常 → 问题在消费端不在 broker，一句话定位。
3. **真正要防的重复不是指标，是告警。** 同一个故障两路各报一条，值班的人收到的是噪音。裁决规则一句话：**告警只挂一路主信号**（本项目 lag 告警只写在 exporter 路、broker 健康只看 JMX 路），另一路只进看板做参考，绝不给重复指标写重复告警。另外真正危险的是"同名不同义"——两个 exporter 暴露同名指标但语义不同，查询时会静默取错；本项目天然不同名（`kafka_*` vs `kafka_exporter_*`），连这个风险都没有。

### Istio 链路追踪采集的数据是什么

先分清：**这部分数据全部由 Envoy sidecar 产生，不是业务代码埋的**。业务的 OTel SDK 埋点是另一路，两者最后在 Tempo 里拼成一条完整链路。

一个请求穿过网格时，最少会经过两个 Envoy：ingressgateway 的 span + 目标 Pod sidecar 的 span（client 侧一个、server 侧一个），每个 span 里记录的东西：

| 数据 | 内容 | 排障价值 |
|---|---|---|
| 拓扑 | span kind（client/server）、parent span id | 一眼看出请求走了哪几跳 |
| 操作 | HTTP method + path / gRPC 服务名+方法 | 定位是哪个接口 |
| 耗时拆分 | 总耗时 + 细分（代理排队、等下游响应 upstream service time、重试等待） | **业务代码看不见的那段耗时**：代理排队、mTLS 握手、重试都在这里 |
| 结果 | HTTP 状态码、gRPC status、response flags（UF=上游连接失败、UR=请求超时等） | 区分"下游挂了"还是"连接建不起来" |
| 策略动作 | 实际命中的 route、是否触发重试/熔断 | 验证 VirtualService/DestinationRule 有没有按预期生效 |

数据流：Envoy → `meshConfig.extensionProviders`（OTLP gRPC → collector:4317）→ Tempo。`traceparent` 在每一跳自动透传，所以 sidecar span 和业务 span 天然同链。

三个关键认知：

1. **trace_id的起点**。经过gateway生成该链路的第一个trace_id,业务代码的逻辑是上游有trace_id则续上，没有就自己创建。
2. **sidecar span 不许进 SLO**。它们同样带 `http.status_code`，会被 spanmetrics 统计导致 `calls_total` 翻倍，所以 collector 的 traces/metrics 管道加了 `only-app-spans` 过滤，只放业务 scope 的 span 进 spanmetrics。
3. 用途分工：指标说"错误率涨了"，trace 说"错在网格哪一跳"（mTLS 握手失败？被熔断摘了？），日志说"具体报了什么"。

**关闭 istio 的合并指标字段**
```yaml
  # 关闭指标合并：Prometheus抓取 :15020/stats/prometheus 时，Envoy仅返回自身 istio_* 网格指标；
  # 本项目业务采用 OTLP push 上报指标，没有业务侧 /metrics 拉取端点，无需拼接业务指标，关闭消除无效本地拉取请求。
  enablePrometheusMerge: false
```

### Prometheus 各部分采集策略

同一个 Prometheus 里并存四种采集模式，不是历史包袱，而是由"谁产生指标、指标在哪暴露"决定的：

```
① push 汇总      业务四进程 ──OTLP──▶ collector:8889 ◀──pull──┐
② 旁路 exporter   中间件 sidecar / lag exporter :9104/:9121/:9308 ◀──pull──┤
③ 按 Pod 抓       每个 sidecar 的 :15090/stats/prometheus        ◀──pull──┼─▶ Prometheus
④ 平台默认        node-exporter / kube-state-metrics / kubelet   ◀──pull──┘
```

| 层 | 目标 | 指标谁产生 | 发现方式 | 抓取地址 | 间隔 | 裁剪 |
|---|---|---|---|---|---|---|
| 应用 | 业务四进程 | OTel SDK 埋点 + collector spanmetrics | ServiceMonitor ×1 | `otel-collector:8889` | 15s | — |
| 中间件 | MySQL / Redis | chart 起的 exporter sidecar | chart 自动生成 SM | `:9104` / `:9121` | chart 默认 | — |
| 中间件 | Kafka broker | chart 注入的 jmx-exporter sidecar | chart 自动生成 SM | 端口名 `metrics` | chart 默认 | — |
| 中间件 | Kafka 消费组 | 独立 Deployment `kafka-exporter` | 手写 SM（与 Deployment 同目录） | `:9308` | 30s | 只盯 `worker.*` 消费组 |
| 中间件 | MinIO | 服务端原生 `/minio/v2/metrics/cluster` | 手写 SM（跨命名空间） | `:9000` 的 `api` 端口 | 30s | — |
| 网格 | 注入 sidecar 的 Pod | Envoy 自身 stats | PodMonitor（按 Pod，不按 Service） | 端口名 `http-envoy-prom` | 30s | 只留 4 个 `istio_*` |
| 平台 | 节点 | node-exporter（DaemonSet） | chart 自带 SM | chart 定义 | 全局 15s | — |
| 平台 | K8s 对象 | kube-state-metrics | chart 自带 SM | chart 定义 | 全局 15s | — |
| 平台 | 容器资源用量 | kubelet 内置 cAdvisor | chart 自带 SM | chart 定义 | 全局 15s | — |

#### ① 应用层：push 汇总，只留一个抓取口

四个业务进程不暴露 `/metrics`，用 OTLP 推到 collector，Prometheus 只抓 `otel-collector:8889` 这一个口。收益两条：**抓取目标数固定**（不随副本数、HPA 变化），STRICT mTLS 下**不用给 Prometheus 开任何业务端口例外**。代价是丢掉 per-pod 维度——排"某个 Pod 有问题"要回日志（Loki 的 `container` 标签）或 trace。

关键副作用：**`up` 在这条链路上几乎失效**。pull 模式下 target 挂了 `up=0`，是最硬的故障信号；push 模式下 collector 假死、业务 SDK 停了，`otel-collector` 这个 target 照样 `up=1`，指标却早断了。所以 `MetricsAbsent`（`absent(calls_total)`）不是可选告警，是这套架构的必需品——**"没数据"必须被显式判成故障**。

指标口径也分两层：spanmetrics 派生的 `calls_total` 管 RED，业务埋点管语义（上传/转码结果），SLO 只吃这两类，不混网格指标。

#### ② 中间件：谁暴露 `/metrics` 就拉谁

中间件自己没有"推"的能力，标准形态就是旁边挂一个 exporter（sidecar 或独立 Deployment）或服务端原生端点，吐 HTTP 文本等 Prometheus 来拉。策略边界只有一条：

- **chart 能生成的（MySQL / Redis / Kafka JMX）一律不手写 SM**，跟着 chart 走，端口名和 SM 同源，永不漂移；
- **chart 生成不了的（Kafka lag exporter、MinIO 原生端点）手写 SM**，和被采集对象放同目录、同一次 `apply -k`。

pull 模型在这里的价值是自带的健康信号：exporter 挂了 `up=0`，一眼可见，不会像 push 那样"安静地没数据"。

#### ③ 网格层：唯一按 Pod 抓的一层

为什么不能用 ServiceMonitor：sidecar 的 `:15090` 不在业务 Service 的端口列表里（Service 只转发业务端口），**没有 Service 可挂，只能按 Pod 发现**——这就是 PodMonitor 存在的意义。

两个细节：

- 选择器用 `security.istio.io/tlsMode: istio`，这是注入 webhook 统一打的标签，比依赖业务自己的 app 标签稳定，新增服务不用改 PodMonitor；
- 必须裁剪：全量 Envoy stats 几百条，大量 cluster/listener 级指标对本项目无意义。`metricRelabelings` 只 keep `istio_requests_total` 和三个直方图的 bucket，间隔降到 30s。

范围只覆盖 `fake-tiktok`、`middleware` 两个命名空间；网关在 `istio-system`，不在选择范围内，要抓网关指标得单独再写一条 PodMonitor，不要顺手把命名空间加进来。

#### ④ 平台层：默认三件套直接用

chart 自带 SM，不手写。三者分工一句话：

- **node-exporter**：节点 OS 指标（CPU/内存/磁盘/网络），DaemonSet，每节点一个；
- **kube-state-metrics**：K8s 对象状态（Deployment 副本数、Pod phase、PVC、节点状态），只问 apiserver，不碰 cgroup；
- **kubelet / cAdvisor**：容器实际资源用量（`container_cpu_usage_seconds_total` 这类）。

注意托管集群（EKS/ACK 等）里 etcd、scheduler、controller-manager 这几个默认 SM 常年常驻 down（没有可抓端点或要鉴权），要么在 values 里关掉，要么接受这几个红点，别当故障排查。

#### 间隔与成本：先砍序列，再降频率

抓取成本 ≈ 目标数 × 每目标序列数 × (86400 / 间隔)。15s 一条序列 5760 点/天，30s 正好减半。分档只按用途：

- **15s**：参与 SLO 和告警的（业务指标、中间件基础指标）；
- **30s**：只做趋势和排障的（网格、MinIO 容量、Kafka lag）。

不统一 15s 的理由不是省钱，而是**序列数决定内存，抓取频率决定 WAL/磁盘/CPU**：频率翻倍，样本量翻倍，先撞的是 Prometheus 自己的解析入库能力；序列翻倍，先撞的是内存。所以裁剪顺序永远是先砍序列（`metricRelabelings` keep、spanmetrics 只放路由模板），其次才是降频率。保留期：base 15d，dev 7d / 5Gi，prod 30d / 30Gi。

#### 抓不到时，按这个顺序查

1. **CR 在不在**：`kubectl get servicemonitor,podmonitor -A`。CR 必须晚于 operator apply，否则报 no matches for kind；
2. **`/targets` 里有没有目标**：没有 → 两层发现失败（Prometheus 侧 selector、SM 侧 `namespaceSelector` + `matchLabels`）；有但 `up=0` → 端口名、网络策略、认证；
3. **端口名核对**：`kubectl -n middleware get svc <name> -o jsonpath='{.spec.ports[*].name}'`。SM 按**名字**匹配，chart 改端口名后 target 会静默消失，不报错；
4. **直连一次确认端点本身有数据**：`curl <podIP>:<port>/metrics`，区分"exporter 没吐"和"Prometheus 没抓到"。

CR 改动由 Operator 热更新 `scrape_configs`，不用重启 Prometheus；但手改 Service 端口名这类"声明之外的动作"不会同步，属于典型静默失配。

### Prometheus 告警规则：实际写了哪些

三个 PrometheusRule CR、四个规则组，合计 **7 条 recording rule + 18 条告警**，全部在 `observability/prometheus/manifests/` 下、随 kustomize 一起 apply（能不能被发现，取决于前面 SM配置 一节的 `ruleSelectorNilUsesHelmValues: false`）：

| CR 文件 | 规则组 | 数量 | 覆盖什么 |
|---|---|---|---|
| `prometheusrule-slo.yaml` | `slo-recording` | 7 条 recording | 四条 SLI 的 5m 比值 + 7d/30d 长窗均值 |
| | `slo-alerting` | 9 条告警 | 业务 SLO + 监控失联兜底 |
| `prometheusrule-middleware.yaml` | `middleware-alerting` | 7 条告警 | 中间件慢性故障与容量 |
| `prometheusrule-mesh.yaml` | `mesh-alerting` | 2 条告警 | 网格层 gRPC 与 503 |

挑选标准贯穿所有文件：**急性故障不自定义**——业务 5xx、Pod 重启、副本不齐由 K8s 自带 `defaultRules` 和业务指标覆盖；自定义规则只补三类"别的信号看不见"的：**慢性劣化**（连接数、键驱逐、消费积压）、**不可自愈的容量**（磁盘打满要人工扩容+迁移）、**监控自身失联**。

#### 第一层：7 条 recording——比值先落盘，陷阱只防一次

四条 SLI 统一两级结构：5 分钟比值先算好，长窗达标判定在它之上求平均：

```promql
slo:upload:ratio5m                          ← 告警的判据（5m 瞬时）
slo:upload:ratio7d = avg_over_time(...[7d])  ← 达标线（看板同源）
```

为什么不把整段表达式直接写进告警：比值里有两个**静默陷阱**，四条 SLI 各踩一遍，落成 recording 后陷阱只防一次，告警和看板读同一个数——口径不会两处漂移。以上传为例：

```promql
(
  sum(rate(video_upload_total{result="success"}[5m]))
  or (sum(rate(video_upload_total{result=~"success|server_error"}[5m])) * 0)  -- ① 补 0
)
/
(sum(rate(video_upload_total{result=~"success|server_error"}[5m])) > 0)       -- ② 分母过滤
```

- **① 全失败窗口补 0**：分子 `{result="success"}` 无样本时 `sum(rate())` 返回空向量，空向量参与除法让整条 ratio **丢样本**——"100% 失败"在曲线上反而不存在，长窗均值只剩有成功的时段，可用性被系统性拉高。`or (... * 0)` 把"没有样本"补成"值为 0"，全失败才如实记 0%。
- **② 无流量分母过滤**：没有上传流量时分母为 0，`0/0` 在 PromQL 里是 NaN 不是报错，NaN 混进 `avg_over_time` 会污染 7d/30d 均值。`> 0` 过滤后无流量时段不产样本，均值只统计有流量的时段。

两个陷阱都不报错、不缺数据，只是**在特定时段让数字朝错误方向漂**——这是比值类告警最值得花时间的地方。

#### 9 条 SLO 告警：燃烧率只有上传一条

燃烧率 = 实际错误率 / 允许错误率（99% 目标 → 0.01），回答"按当前速度错误预算还能撑多久"，只对**连续请求型、错误预算随流量持续消耗**的核心链路有意义。四条 SLO 里只有上传是核心用户链路（实验项目无对外 SLA 赔付，只把它纳入预算管理），其余三条按普通阈值告警：

| 告警 | 类型 | 条件 | for | 级别 |
|---|---|---|---|---|
| `SLOUploadBudgetBurning` | 燃烧率 | 1h 燃烧率 > 1 | 30m | warning |
| `SLOUploadBudgetFastBurn` | 燃烧率 | 5m 燃烧率 > 14 | 5m | critical |
| `Process5xxDetected` | 阈值 | 10m 内出现任何 5xx | 5m | warning |
| `Process5xxStorm` | 阈值 | 5m 5xx 率 > 10% | 5m | critical |
| `TranscodeFailureRateHigh` | 阈值 | 15m 失败率 > 10% | 15m | warning |
| `TranscodeFailureSpike` | 阈值 | 5m 失败率 > 30% | 5m | critical |
| `SLOCounterFreshnessWarning` | 阈值 | P99 账龄 > 5s | 10m | warning |
| `SLOCounterFreshnessBreach` | 阈值 | P99 账龄 > 10s | 10m | critical |
| `MetricsAbsent` | 失联兜底 | `calls_total` 消失 5m | 5m | critical |

三个判据细节：

- **14 的来历**：5 分钟窗口占 1 小时预算的 1/12，燃烧率 12 意味着 5 分钟烧光 1 小时的预算，取 14 留余量。慢烧（1h>1 持续 30m）抓"预算持续透支"，快烧（5m>14 持续 5m）抓"急性出血"——只配慢烧，急性故障要烧半小时才响；只配快烧，流量毛刺就误报。
- **5xx "出现即告警"**：业务失败全是 200+code，5xx 只剩 panic/框架级故障，每一条都是代码缺陷，没有"正常波动"可言，所以判据是 `increase > 0` 而非比率；比率档（>10%）留给 `Process5xxStorm` 区分单点缺陷和 panic 风暴。
- **`MetricsAbsent` 是 push 架构的必需品**（采集策略一节讲过 `up` 失效）：collector 断流时 `rate()` 返回空，燃烧率和阈值规则**全部安静得像一切正常**——监控失联不能被伪装成服务健康，这条不写，其余 17 条都是盲的。

不给转码算燃烧率：异步批处理，失败成批出现（坏源文件），比率阈值比预算消耗更贴切；转码目标只定 95% 同理——损坏源文件归不到服务责任，定 100% 等于零错误预算。

#### 中间件 7 条：只挑"业务全绿、数据已错"的

| 告警 | 条件（for） | 为什么业务指标看不见 |
|---|---|---|
| `MySQLConnectionsHigh` | 连接使用率 > 80%（10m） | 到 100% 前业务全绿，打满后才报 too many connections |
| `RedisEvicted` | 5m 内有键被驱逐（10m） | 接口照样 200，但判重/热度计数静默算错 |
| `KafkaConsumerLagHigh` | 单消费组 lag > 10000（15m） | 只是变慢，没有错误 |
| `KafkaConsumerLagGrowing` | lag > 10000 且 15m 斜率 > 0（15m） | 消费者已停止推进，不是单纯变慢 |
| `KafkaDiskCapacityLow` | Kafka PVC 可用 < 20%（10m） | 打满前业务全绿，打满后写入被拒、可能掉副本 |
| `MinioCapacityLow` | 可用容量 < 20%（10m） | 同上，恢复必须扩容+迁移，不可自愈 |
| `MinioNodesOffline` | 离线节点 > 0（5m） | 多副本降级运行时业务指标完全正常 |

两个判据写法值得单独记：

- **Kafka lag 拆 warning/critical 靠的不是阈值翻倍，而是加了斜率项** `deriv(lag[15m:1m]) > 0`——"高"和"高且还在涨"是两个故障：前者慢，后者死了。单一阈值区分不了这两种状态，告警级别也就无从谈起。
- **容量指标取自 kubelet 的 PVC 级**（`kubelet_volume_stats_*`）而不是 node-exporter 按挂载点匹配——直接命中文案卷，不依赖节点挂载路径命名，路径一改不会静默失配。

#### 网格 2 条：判据必须用 gRPC 自己的状态码

| 告警 | 条件（for） | 看住什么 |
|---|---|---|
| `MeshGRPCErrorRateHigh` | 非 0 `grpc_response_status` 占比 > 5%（10m） | 服务间 gRPC 失败——不产生业务 span，`calls_total` 结构性看不到 |
| `MeshUpstream503` | sidecar 层 503 速率 > 1/s（5m） | 连接池打满 / 熔断摘除后无可用实例 / 上游未就绪 |

gRPC 判据踩过的坑：原规则照搬 `!="0"` 的写法写成了 `response_code!="0"`——HTTP 状态码取值是 200/500，**永远不等于 "0"**，分子恒等于分母，错误率恒为 100%，一开就是全量误报。正确判据是 Istio 专有的 `grpc_response_status`（`"0"` = OK）。阈值选错是不准，**标签选错是恒真或恒假**——后者更危险，因为它看起来"告警响得很勤"，实际什么都没筛。

#### 刻意没写的

- **K8s 层告警用 `defaultRules` 自带的**，不自定义心跳/Pod 重启类——平台规则已完全覆盖，再写一遍是重复噪音。
- **同一故障只挂一路告警**：Kafka 两路指标的重复区（流量、ISR）不再配第二条告警，告警归属 JMX 一路、lag 归 exporter 一路——重复指标可以容忍，重复告警是值班噪音。
- **SLO 不混网格指标**：`istio_requests_total` 只做排障与服务间告警，不进 SLO 分子分母——单一口径不混源，两层指标的分工见"各部分采集策略"。

#### 告警出口与验证

Alertmanager 接收器暂为 `null`：告警在 UI 全部可见、不外发；接飞书只是在 `receivers` 加一个 `webhook_configs`，规则层零改动。分组 `group_by: [alertname, service_name]`，普通告警 4h 重复、critical 1h 重复。

```bash
kubectl -n observability get prometheusrule    # 3 个对象
# /rules  → 四个规则组全部 loaded（slo-recording / slo-alerting / middleware-alerting / mesh-alerting）
# /alerts → 当前 firing 列表；/rules 空白 = ruleSelector 那行没关
```

### ISTIO_META_DNS_CAPTURE="true"：DNS 劫持开关

#### 作用

给网格内所有 Pod 的 sidecar 打开 **DNS 代理**：Pod 的域名解析请求不再一路走到集群 DNS（CoreDNS），而是在 sidecar 里就被接住、就地应答。一句话——**让服务发现不出本节点**。

#### 原理

`ISTIO_META_` 前缀的环境变量会成为代理的启动元数据（mesh 级配置 `meshConfig.proxyMetadata`，对全网格 sidecar 生效，改完要重启 Pod 才进 bootstrap）。打开后的数据路径：

```
Pod 里程序查 mysql.middleware.svc.cluster.local
  ↓ 53/udp
Pod 网络命名空间内的 iptables 把 DNS 查询重定向到 sidecar 的 :15053
  ↓
sidecar 内置 DNS proxy 分流：
  ├─ *.cluster.local 等集群名 → 从 xDS 下发的注册表里（istiod自动维护）本地应答，返回ip
  │   不出节点、不依赖 CoreDNS 可用性
  └─ 其它域名(公网域名、自定义内部域名等) → 转发给CoreDNS解析
```

附带的第二个能力：**按域名做出口策略**。当 egress 策略是 `REGISTRY_ONLY`（只允许访问注册过的地址）时，外部域名必须在ServiceEntry里面注册过了，内部服务才能访问它，否则DNS解析这一步被劫持到sidecar之后，解析会直接失败，内部服务就访问不了了。如果egress策略是`ALLOW_ANY`，则没有这个限制。

#### 为什么大集群的收益更高

| 收益 | 大集群的痛点 | 小集群的情况 |
|---|---|---|
| **CoreDNS 卸压** | 万级 Pod、短连接 RPC、分钟级滚动发布，服务发现 QPS 高且成簇出现；CoreDNS 是集群级共享组件，局部风暴拖垮全局 | 5 节点规模 CoreDNS 毫无压力 |
| **消峰** | 一次全量发布数百 Pod 同时解析 mysql/kafka/minio，排队拉长启动时间、拖到探针超时 | 几个 Pod 同时启动没有排队问题 |
| **故障域收窄** | CoreDNS 抖动 = 全集群服务发现瘫痪；有了本地应答，**已注册服务的解析不受影响** | CoreDNS不太可能有异常 |
| **按域名 egress 治理** | 外部 API 多、按 hostname 放行/审计是刚需 | 外联少，收益不明显 |
| **StatefulSet/headless、多集群** | 这些形态才用得到 DNS 代理的端点级解析 | 本项目用不到 |

反面也要写清楚：DNS 代理多一层故障面——容器里 `nslookup`（DNS 查询工具） 的行为和宿主机不一致，排障时容易困惑；sidecar 的 DNS 逻辑出 bug 影响全网格。**所以默认不开，是"收益 < 复杂度"时的理性选择**：本项目保持默认关闭，

### Harbor CA 证书模式

目标：**全链路 TLS 校验**——自签证书的世界里，要么所有客户端都关校验，要么让所有客户端信任同一个内部 CA。

#### 证书链

```
cert-manager（控制器：生成私钥、调 issuer 签名、写 Secret、到期续期）
  ├─ selfsigned-bootstrap（SelfSigned ClusterIssuer，只签发 CA）
  │    └─ fake-tiktok-ca          内部根 CA，10 年，CA 类型证书 —— 全集群唯一信任锚
  │         └─ fake-tiktok-ca（ClusterIssuer，用根 CA 签业务证书）
  │              ├─ harbor-tls    服务端证书，SAN = 节点 IP，1 年，提前 30 天自动续期
  │              └─ istio-ca      Istio 中间 CA，1 年，装配成 istio-system/cacerts
  │                   └─ 网格内 Pod 的 SVID（istiod 用中间 CA 签，链回同一个根）
```

#### 简述步骤

1. `helm install cert-manager`：只装控制器 + CRD，这一步一张证书都不签；
2. `kubectl apply -k manifests`：声明 2 个 ClusterIssuer + 3 个 Certificate（`istio-system` 命名空间一起建）；
3. 控制器异步 reconcile：`selfsigned-bootstrap` 签出根 CA → 根 CA 落成 Secret → CA Issuer 读 Secret 里的私钥 → 依次签出 `harbor-tls`、`istio-ca`；
4. `kubectl wait --for=condition=Ready certificate/...`：Ready 才代表 Secret 里 `tls.crt / tls.key / ca.crt` 三样齐全；
5. `istio-cacerts-sync` 把 `istio-ca` 转成 istiod 认的四件套；确认 `cacerts` 存在后，再装 Harbor 和 istiod；
6. 客户端侧只做一件事：拿到根 CA 的 `ca.crt`（四个信任点 + 网格的 `cacerts`）。

#### cert-manager 是控制器，不是 CA

它本身不持有任何 CA 私钥，而是一条"声明式证书流水线"：

| 职责 | 具体动作 |
|---|---|
| 监听期望状态 | watch `Certificate` / `Issuer` / `ClusterIssuer`，以及每张证书的续期时间 |
| 生成与轮换私钥 | 按 `privateKey` 段生成私钥；`rotationPolicy: Always` = 每次续期换新私钥 |
| 组织签名请求 | 拼 CSR，按 `issuerRef` 找到 issuer，调它的签名实现 |
| 落盘 | 把 `tls.crt / tls.key / ca.crt` 写进 `secretName` 指定的 Secret，并置 `Ready` |
| 定时续期 | 到 `renewBefore` 就重跑一遍流程；`duration` 是单张证书寿命 |

所以链路上真正"签"的动作发生在 issuer 里，cert-manager 只是把**声明、私钥、Secret、时间表**串起来。信任关系也不由它决定——客户端信谁，取决于你把根 CA 的 `ca.crt` 分发到了哪里。

私钥全程在集群内生成，唯一载体是 Secret；`cert-manager` 命名空间里那张根 CA 的 Secret 是整套体系里最高敏的对象。

#### selfsigned-bootstrap：只用来"点火"的 Issuer

一个 `ClusterIssuer`，内容只有三行：

```yaml
spec:
  selfSigned: {}
```

签出来的证书 **issuer == subject**，没有上级——这正是根 CA 需要的形态（根没有别人能签它）。

它的两个局限决定了"只签 CA、签完封存"：

- **签出的东西没有可验证的信任锚**：自签名只能带外信任（手动导入、Ansible 分发）。拿它直接签服务端证书，就退化成"每台客户端各自导入一次"，统一信任的问题一点没解决；
- **没有吊销/轮换的抓手**：换证书只能靠人工重发，且客户端要跟着重导。

所以它的定位是 **bootstrap（点火）**：签一次根 CA，之后所有证书都走 CA Issuer。

#### 还有哪些 Issuer，本项目为什么只留两个

| Issuer 类型 | 签名凭据来自 | 本项目 | 说明 |
|---|---|---|---|
| `SelfSigned` | 无（自签） | ✅ `selfsigned-bootstrap` | 只签根 CA |
| `CA` | 存着 CA 私钥的 Secret | ✅ `fake-tiktok-ca` | 签所有业务证书；根私钥不出集群 |
| `ACME` | Let's Encrypt 等公网 CA | ❌ | 要公网域名 + 80/443 可达（HTTP-01）或 DNS-01；实验环境两样都没有 |
| `Vault` | Vault PKI 引擎 | ❌ | 多一个组件和一条运维路径，收益是动态短期证书，小集群用不上 |
| `Venafi` 等 | 商业 CA 平台 | ❌ | 同上 |

还有个作用域区别：`Issuer` 是命名空间级，`ClusterIssuer` 是集群级。本项目要跨 `cert-manager` / `platform-system` / `istio-system` 三个命名空间签，所以统一用 `ClusterIssuer`。

#### fake-tiktok-ca 的两个身份（最容易混的一处）

它同时是一个 Certificate 和一个 ClusterIssuer 的名字：

| 对象 | 位置 | 是什么 |
|---|---|---|
| `Certificate fake-tiktok-ca` | `cert-manager` 命名空间 | 根证书本体：`isCA: true`、10 年、ECDSA P-256，产物是 Secret `fake-tiktok-ca` |
| `ClusterIssuer fake-tiktok-ca` | 集群级 | 签发器：`spec.ca.secretName: fake-tiktok-ca` 只是**引用**上面的 Secret，读私钥去签别人 |

同名不是笔误，但读的时候要分清：**Certificate 是"这张证书"，ClusterIssuer 是"用这张证书去签别的证书"的能力**，两者不是同一份数据。

作用有两层：

1. **信任锚**：`ca.crt` 被分发到四个信任点 + 网格的 `cacerts`；
2. **签发者**：`harbor-tls`、`istio-ca`（进而全部 SVID）都由它签。

风险也集中在这一个对象上：根私钥泄露 = 攻击者能签任意 SAN 的证书，所有内部 TLS 的"服务端身份鉴别"直接失效——所以它 10 年一换、只用于内部、绝不对外。

#### harbor-tls 里有什么，谁在用

`Certificate platform-system/harbor-tls` 签出的是 **leaf（服务端）证书**，SAN 类型是 `ipAddresses`，值为节点 IP：

| Secret 里的 key | 内容 | 谁用 |
|---|---|---|
| `tls.crt` | 服务端证书（leaf），SAN = 节点 IP | Harbor chart（`expose.tls.certSource: secret`）起 30003 HTTPS |
| `tls.key` | 服务端私钥 | 同上 |
| `ca.crt` | 签发它的根 CA | Tekton（BuildKit/Skopeo）、containerd、浏览器 |

一份 Secret 两种用途，靠 `items` 过滤各取所需：服务端要 `tls.crt/tls.key`，客户端只要 `ca.crt`。续期只换 leaf，`ca.crt` 不变，客户端配置一行都不用改。

为什么 SAN 用 IP 而不是域名：实验环境没有内部 DNS，所有客户端都用 `IP:30003` 访问；证书里没有这个 IP，TLS 校验就过不去。**换域名时把 `ipAddresses` 改成 `dnsNames` 即可，其余不动。**

#### BuildKit 怎么借证书推、拉 Harbor 缓存

BuildKit 跟 Harbor 有两次交互，两次都要过完整 TLS 校验：

**第一次：拉旧缓存（import）**

```text
buildctl build --import-cache type=registry,ref=<IP>:30003/fake-tiktok/buildcache-go:main
  → 解析 ref，向 Harbor 要 manifest
  → TLS 握手：服务端出示 harbor-tls 的 tls.crt
  → BuildKit 用 /certs/ca.crt 验链，再校验 SAN 是否等于节点 IP
  → 通过 → 拉 manifest/blobs → 恢复到本地 buildkit state
```

**第二次：推新缓存（export）+ 推产物**

```text
buildctl ... --export-cache type=registry,ref=...,mode=max,ignore-error=true
  → 同一个 TLS 通道 PUT manifest/blobs；凭据来自 harbor-push（robot 账号）
  → 缓存失败不阻断构建

产物不走 BuildKit：--output type=docker,dest=image.tar
  → Skopeo 用 --dest-cert-dir=/certs 把 tar 推到 docker://<IP>:30003/...
```

证书怎么进容器：

1. `volume harbor-ca` 指向 Secret `harbor-tls`，`items` 只取 `ca.crt`，挂到 `/certs`（build / push 两个 step 共用）；
2. build step 运行时**动态生成** `buildkitd.toml`——registry host 来自参数（`params.image` 第一段），不能写死；且 BuildKit 只认配置文件，没有"传 CA 路径"的环境变量：

```toml
[registry."<IP>:30003"]
  ca = ["/certs/ca.crt"]
```

3. `BUILDKITD_FLAGS="--config /tmp/buildkitd.toml"` 生效后，BuildKit 对 `IP:30003` 的所有请求都按完整校验处理（对比老做法 `insecure = true`，那是关校验）。

三个容易踩的点：

- **ref 里的 host 必须与 SAN 逐字一致**：证书是 IP SAN，引用就只能写 `IP:30003`，写 `localhost` 或服务名会报 `x509: certificate is valid for ...`；
- **`ca` 是 registry 级别的配置**，不是全局；换 Harbor 地址就要换这段（脚本按参数取 host，天然适配）；
- **kubelet 拉镜像是另一条链**：containerd 的 `/etc/containerd/certs.d/<IP>:30003/{ca.crt,hosts.toml}`（Ansible 落地），跟 BuildKit 互不影响，但共用同一个 `ca.crt`。

#### 全集群共用一个根 CA：istio 不再用自签根

默认行为：`istio-system/cacerts` 不存在时，istiod 首启会**自签一套根 CA**（存进 `istio-ca-secret`），网格内所有 SVID 链到它。结果是集群里两套互不认的信任锚：Harbor 一套、网格一套——客户端要装两份，跨边界（网格 ↔ 非网格）也没法互相验证。

大厂的做法是**一个根 + 若干中间 CA**：根只签中间 CA，各组件（网格、registry、内部服务）用各自的中间 CA 签工作负载证书，最终链回同一个根。

本项目的落地：

| 步骤 | 对象 | 结果 |
|---|---|---|
| 1 | `Certificate istio-system/istio-ca`（`isCA: true`，issuerRef = `fake-tiktok-ca`） | 中间 CA，Secret `istio-ca`：`tls.crt`=中间 CA、`tls.key`、`ca.crt`=根 |
| 2 | CronJob `istio-cacerts-sync` | 装配 `istio-system/cacerts`：`ca-cert.pem`=tls.crt、`ca-key.pem`=tls.key、`root-cert.pem`=ca.crt、`cert-chain.pem`=tls.crt |
| 3 | `helm install istiod` | 启动时发现 `cacerts` → 用它签 SVID，不再自签根 |

**为什么不直接把根 CA 塞给 istiod**：

- istiod 必须把 CA 私钥长期挂在控制面 Pod 里（Secret → 文件）；给根等于把唯一信任锚的私钥复制一份进 `istio-system`，泄露面翻倍；
- 根 10 年一换，换的时候 Harbor、containerd、浏览器全都要重新分发 `ca.crt`；中间 CA 可以单独吊销/轮换，根私钥始终只留在 `cert-manager` 命名空间；
- 中间 CA 签出的证书照样链回根，客户端只认根，验链结果不变——**收益是隔离，损失为零**。

迁移注意：**已有集群**从自签根切过来时，旧 sidecar 证书链到旧根、新 sidecar 链到新根，互验不过，需要把所有注入 Pod 滚动重启一次（或等默认 24h 轮换到期）。全新安装没有这个问题。

验证：`istioctl proxy-config secret <pod> -n fake-tiktok`，看 `ROOTCA` 是不是 `fake-tiktok-ca` 那张根证书。

#### 四个信任点（谁拿 ca.crt）

| 客户端 | 用法 |
|---|---|
| BuildKit（缓存 import/export） | 运行时生成 `buildkitd.toml`：`[registry."<IP>:30003"] ca = ["/certs/ca.crt"]` |
| Skopeo（push） | `--dest-cert-dir=/certs` |
| containerd（kubelet 拉镜像） | `/etc/containerd/certs.d/<IP>:30003/ca.crt` + `hosts.toml`（Ansible 03 落地） |
| 浏览器（Harbor UI / Grafana） | 系统导入根 CA，或内网访问时手动信任一次 |
| Istio 网格（istiod 签 SVID） | `cacerts` 的 `root-cert.pem` = 同一个根，sidecar 之间自动互验，不用人工分发 |

#### 部署顺序（错一步起不来）

```
cert-manager helm install
  → kubectl apply -k manifests（先替换成真实 IP 的 SAN）
    → wait certificate/fake-tiktok-ca / harbor-tls / istio-ca Ready
      → istio-cacerts-sync 生成 istio-system/cacerts（CronJob，可手动触发一次）
        → helm install istiod（看到 cacerts 才不自签根）
          → helm install Harbor（certSource: secret）
            → apply Tekton 流水线（Task 挂 ca.crt）
```

反过来会怎样：Harbor 缺 Secret 起不来（Pod 卡在挂载）；istiod 先起来会自签一套根，之后再塞 `cacerts` 就得额外做一次证书迁移（滚动重启所有注入 Pod）。

#### 轮换与演进

- **服务端证书自动续**（提前 30 天），CA 不变 → 客户端挂的 ca.crt 无感，客户端不用做任何事；Harbor 侧要重新读一次证书（Pod 滚动一次即可）；
- **中间 CA（istio-ca）1 年、提前 30 天续**：CronJob 对账后重启 istiod，之后新签的 SVID 用新中间 CA，旧证书在有效期内仍然验得过（链回同一个根）；
- 根 CA 10 年到期才需要重分发 ca.crt（Ansible 重跑一遍 certs.d 那步 + 重新装配 cacerts）；
- 生产如果有了公网域名 + 出口，可把签发者换成 Let's Encrypt——**信任模型不变，只换签发者**，四个信任点的配置一行不用动。

### 网格边界：谁进网格，谁走单向 TLS

一条总原则：**进网格是为了拿 L7 能力（路由/重试/熔断/按身份授权）；只需要"链路加密 + 服务端身份"的组件，用单向 TLS 更划算。**

| 组件 | 进网格 | 加密方式 | 依据 |
|---|---|---|---|
| fake-tiktok（业务三服务 + web + worker） | 是 | mTLS（自动） | 东西向调用最密集，重试/熔断/限流都靠 sidecar；身份即 ServiceAccount，可直接写 AuthorizationPolicy |
| 可观测性（prometheus / otel-collector / tempo / loki / grafana） | 是 | mTLS（自动） | 全是网格内调用：业务 sidecar→collector:4317、collector→tempo、grafana→prometheus/loki。进网格后这些链路自动 mTLS，**不用再为指标端口开 PERMISSIVE 例外** |
| mysql / redis / kafka | 否 | 服务端单向 TLS | 有状态第三方组件：注入 sidecar 会改端口与探针语义，主从切换时 sidecar 证书轮换是额外故障面；客户端身份本来就有账号密码/ACL 承担 |
| MinIO | 否 | 服务端单向 TLS | 9000 端口同时是业务 API 和指标端点；Tempo（若在网格内）也要读它，出网格才不牵连业务端口 |
| Harbor | 否 | 服务端单向 TLS（harbor-tls） | 不是 k8s 工作负载，被 kubelet / BuildKit / Skopeo / 浏览器多方访问，TLS 才是它能提供的全部 |

三个结论式的理由：

1. **可观测性进网格是对的**：它们都是无状态客户端/服务端，没有"端口语义被 sidecar 改写"的问题；粒度收益是抓取与写入两条链全都 mTLS，策略面收敛到一处。代价是 Prometheus 访问 K8s API 要多经过一跳 sidecar（mesh 出站默认 `ALLOW_ANY`，可通，但最好加 exclude 规则）、每个 Pod 多一个 sidecar 的资源与排障层。
2. **中间件出网格是对的**：单向 TLS 已经把"链路加密 + 服务端身份"覆盖掉，客户端身份由它们自己的账号体系负责——这正是单向 TLS 的能力边界，多一个 sidecar 只是把边界外的东西硬塞进来。
3. **单向 TLS 的缺口要写清楚**：它不鉴别客户端（谁都能连，只要知道账号）、没有 L7 策略（不能按 path/方法限流）、每套中间件要各配一份证书。前两条靠 Cilium NetworkPolicy 做 L3/L4 白名单补偿，第三条靠"都向 `fake-tiktok-ca` 申请证书"摊平成本。

**与当前仓库的差异（这一版是目标设计，尚未全量落地）**：

- 现状：[namespaces.yaml](file:///d:/study_project/fake_tiktok/project-infra/infra/base/namespaces.yaml) 里 `middleware` 是注入、`observability` 是不注入，正好相反；中间件也没开服务端 TLS（加密完全靠 mTLS）；
- 要落地这一版，需要改四处：① 两个命名空间的注入 label 对调；② 删掉 [peer-authentication.yaml](file:///d:/study_project/fake_tiktok/project-infra/infra/base/istio/peer-authentication.yaml) 里的三个 `portLevelMtls` 例外（出网格后不存在 mTLS 例外）；③ mysql/redis/kafka/minio 各自开 TLS 并挂 cert-manager 证书（`require_secure_transport` / `tls-port` / SSL listener / `public.crt`+`private.key`）；④ 业务连接串与 Prometheus 抓取改 `https` + CA；
- 本轮只落了证书侧（全集群单根 CA），网格范围与中间件 TLS 按上面清单推进。

### Tekton 的 RBAC 怎么配的

原则：**两个身份、职责分离、namespace 级最小授权**（[service-accounts.yaml](file:///d:/study_project/fake_tiktok/project-infra/cicd/tekton/rbac/service-accounts.yaml) + [roles.yaml](file:///d:/study_project/fake_tiktok/project-infra/cicd/tekton/rbac/roles.yaml)）：

| ServiceAccount | 用在哪 | 权限 |
|---|---|---|
| `tekton-triggers-sa` | EventListener sink（TriggerTemplate 渲染 PipelineRun 时的身份） | 仅 `pipelineruns` 的 create/get/list/watch + `pipelines/tasks` 的 get/list/watch（渲染要读元信息） |
| `tekton-build` | TaskRun Pod 跑流水线时的身份（TriggerTemplate 里 `taskRunTemplate.serviceAccountName`） | **不给任何 K8s 资源权限**；它需要的凭据全部来自挂载的 Secret（harbor-push、gitops-token） |

三个刻意的"不给"：

1. **Role 不用 ClusterRole**——作用域锁在 `platform-system`，被攻破也动不了别的命名空间；
2. **triggers 身份不挂仓库凭据**——它只"能建一次流水线"，即使被滥用，本身拿不到 token；
3. **build 身份不建资源**——跑任务的容器改不了集群对象。

诚实的威胁模型边界：能创建任意 PipelineRun 的人，**间接触发 tekton-build 身份的任务**——所以 RBAC 不是第一道门，**HMAC 校验（webhook 入口）才是**；RBAC 是纵深防御的第二层，把"入口失守"从"集群沦降"压缩成"多跑几次流水线"。生产加固方向：admission policy 限制 `taskRunTemplate.serviceAccountName` 只能是白名单 SA。

验证：

```bash
kubectl auth can-i create pipelineruns -n platform-system \
  --as system:serviceaccount:platform-system:tekton-triggers-sa   # yes
kubectl auth can-i list secrets -n platform-system \
  --as system:serviceaccount:platform-system:tekton-triggers-sa    # no ← 对了
```

### Tekton 与 GitHub 之间的权限矩阵

三个方向、**三把互不复用的钥匙**，每把最小 scope：

| 方向 | 凭据 | scope / 机制 | 失守影响 |
|---|---|---|---|
| GitHub → Tekton（触发） | `github-webhook-secret` HMAC | 只校验 `X-Hub-Signature-256`，sha256 对 payload；事件只勾 push；生产加固：EventListener 限 GitHub meta IP 段 | 伪造触发（可被 IP 白名单 + 事件过滤兜住），拿不到任何仓库凭据 |
| Tekton → 业务仓（读） | 默认**匿名**（公开仓）；私有仓用 `basic-auth` workspace + fine-grained PAT（只读、只此仓） | 官方 git-clone 退出时自动清理凭据文件；PAT 不写进 remote URL | 只读这一个仓 |
| Tekton → infra 仓（写） | `gitops-token` PAT（或演进到 GitHub App installation token） | **只对 micro-bl--manifest 一个仓 contents:write**；提交带 `[skip ci]` 防止触发 infra 仓自己的 CI 造成回环 | 只能改这一个仓的清单文件 |

设计要点三句话：

1. **触发、读、写三个方向不共享凭据**——webhook 密钥泄漏不能推代码，写 token 泄漏不能伪造触发；
2. **写权限给"产物通道"而不是"人"**——gitops-token 只用来 bump 一个 tag 字段，commit 作者是 `tekton-ci[bot]`，审计里一眼看出是机器；
3. **个人 PAT 是过渡，GitHub App 是终态**——installation token 短时效、可吊销、审计归属应用而非个人账号，生产环境优先它。
