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

打开后 sidecar 会在本地起一个 **Envoy DNS 代理**，把业务容器发出的 DNS 查询劫持到 Envoy 解析，而不是直连节点的 CoreDNS。

#### 作用

默认行为下，应用 `getaddrinfo("api.example.com")` 直接走 `/etc/resolv.conf` → CoreDNS，拿到的是**真实 IP**，应用拿着真实 IP 去连 → iptables 按目的 IP 分流时，Envoy 看到一个不认识的外网 IP，**没法把它和 ServiceEntry 的域名规则对上**，于是"按域名做出口路由/策略"全部失效。

开启 DNS capture 后：应用的 DNS 查询被 Envoy 拦截 → Envoy 查到 `api.example.com` 匹配某条 ServiceEntry → 返回一个 **Envoy 分配的虚拟 IP（240.0.0.0/4 段）** → 应用拿虚拟 IP 建连 → iptables 把这条连接捕获进 Envoy → Envoy 按虚拟 IP 反查回域名，命中 ServiceEntry 规则。收益场景：

- **出站流量按域名管控**：把 `*.thirdparty.com` 的调用经 egress gateway、加 mTLS/重试/观测，对那些只认域名不认 IP 的调用方是唯一解法；
- 应用代码零改动——不需要改成写 IP，也不需要知道网格的存在。

生产经验：**这是一个"为少数出站流量管理需求，改变全部 Pod DNS 路径"的开关。**

#### 坏处

1. **DNS 解析从"节点级共享组件"变成"每个 Pod 私有 sidecar 的职责"。** CoreDNS 挂了是全集群统一故障、排障路径清晰；Envoy DNS 代理挂了/OOM/正在推配置，是**这一个 Pod 的所有域名解析全断**——业务连 mysql.middleware、连 K8s API 全都解析失败，而且故障现象是"个别 Pod 神秘网络异常"，比 CoreDNS 故障难排查得多。爆炸半径从"横向一刀切"变成了"纵向打进每个 Pod"。
2. **解析行为和系统 stub resolver 有差异。** Envoy 用 c-ares 异步解析，对 ndots/search domain 的拼接顺序、负缓存 TTL、CNAME 链、超时重试的细节和 glibc nss 不完全一致。某些依赖精确解析行为的应用（老 gRPC 客户端、有 DNS 缓存假设的 SDK）会出诡异的解析失败——这类问题在测试环境不复现，只在生产特定查询路径上出现。
3. **多一跳故障面 + 性能开销。** 每条 DNS 查询先进 Envoy 转一手，Envoy 配置热更新（xDS push 期间）查询延迟会抖；大流量下 DNS 查询本身也有 QPS 开销。
4. **排障动作变了。** 以前 `tcpdump`/`nslookup` 直接看节点 DNS，开启后抓到的是发往 sidecar 的查询，排查链路多一层认知成本。

#### 为什么大集群一般不考虑开

核心逻辑：**收益是局部的，成本是全局的。**

- 它唯一的刚需场景是"大量出站域名需要按 hostname 做网格管控"。绝大多数集群（包括本项目）出站调用极少、或者对方就固定几个 IP/域名，用静态 ServiceEntry + 显式路由就能覆盖，犯不上开这个开关。
- 大集群里 Pod 数以千计，开了之后**每个 Pod 的 DNS 路径都换了一遍**——把一个稳定十几年的系统组件（/etc/resolv.conf → CoreDNS）替换成一个和 Envoy 生命周期强绑定的新解析器，为的只是服务列表里可能一条都没有的出站规则。生产系统的改法应该是：**默认不开，哪个工作负载真有出站域名管控需求，就用 Pod 注解 `proxy.istio.io/config` 对它单独开**，按需开、按需关、爆炸半径锁在单个 Pod 上。
- 出站管控还有不碰 DNS 的替代路径：egress gateway + 显式 VIP、或约定应用直接调集群内出口代理，都能拿到大部分收益而不引入全局 DNS 行为变更。

一句话：**DNS capture 是给"出站域名流量管理"这个窄场景准备的工具，不是网格默认配置；大集群的惯例是按 Pod 注解按需开，绝不 mesh 全局开。**


### tekton构建代码的脚本
```bash
        #!/bin/sh
        set -eu

        # 处理多阶段target参数：为空时不传递参数，防止buildctl接收空串报错
        target_opt=""
        if [ -n "$(params.target)" ]; then
          target_opt="--opt target=$(params.target)"
        fi

        # 远程缓存配置：对接Harbor缓存镜像
        # mode=max：缓存所有构建阶段，Go mod等中间层可以复用，加速构建
        # ignore-error=true：缓存拉取/推送失败仅降级为无缓存构建，不阻断CI流水线
        cache_flags=""
        if [ -n "$(params.cache-ref)" ]; then
          cache_flags="--import-cache type=registry,ref=$(params.cache-ref) --export-cache type=registry,ref=$(params.cache-ref),mode=max,ignore-error=true"
        fi


        registry_host=$(printf '%s' "$(params.image)" | cut -d/ -f1)
        cat > /tmp/buildkitd.toml <<EOF
        [registry."${registry_host}"]
          ca = ["/certs/ca.crt"]
        EOF
        export BUILDKITD_FLAGS="--oci-worker-no-process-sandbox --config /tmp/buildkitd.toml"

        # 拆分Dockerfile路径：buildctl需要分开指定dockerfile目录和文件名
        dockerfile_dir=$(dirname "$(params.dockerfile)")
        dockerfile_name=$(basename "$(params.dockerfile)")

        # buildctl-daemonless.sh：单进程模式，自动拉起buildkitd，流水线无需单独部署buildkit服务
        # --output type=docker,dest=xxx：输出docker标准tar包，契约不变，下游scan、push完全不用改动
        buildctl-daemonless.sh build \
          --frontend dockerfile.v0 \
          --local context="$(workspaces.source.path)/$(params.context)" \
          --local dockerfile="$(workspaces.source.path)/${dockerfile_dir}" \
          --opt filename="${dockerfile_name}" \
          ${target_opt} \
          ${cache_flags} \
          --output type=docker,dest="$(workspaces.image.path)/image.tar",name="$(params.image)" \
          --progress plain
```

#### 这段脚本在流水线里的位置

脚本只做一件事：**产出 `image.tar`，不推 Harbor**。整条数据流：

```
source/ + Dockerfile
   └─ buildctl ──▶ /workspace/image/image.tar
                        ├─ trivy --input image.tar   （扫不过就退出，不推）
                        └─ skopeo copy docker-archive → Harbor
```

#### 逐段解释

**① `set -eu`**

- `-e`：任何命令失败立即退出。不加的话 buildctl 失败后脚本还会继续往下执行，最后报一个和根因无关的错；
- `-u`：引用未定义变量直接报错，防止变量名拼错后静默变成空串。

**② target 条件参数**

```sh
target_opt=""
if [ -n "$(params.target)" ]; then
  target_opt="--opt target=$(params.target)"
fi
```

根 Dockerfile 有 `user/video/interaction/worker` 四个命名 stage；web 的 Dockerfile 没有命名 stage。有 target 就拼参数，没有就**完全不能传**——BuildKit 收到空 target 会报错。

**③ 跨流水线缓存**

```sh
cache_flags="--import-cache type=registry,ref=$(params.cache-ref) \
             --export-cache type=registry,ref=$(params.cache-ref),mode=max,ignore-error=true"
```

| 选项 | 作用 |
|---|---|
| `type=registry` | 缓存以 OCI 镜像形式存到 Harbor，而不是本地目录 |
| `--import-cache` | 构建前先拉缓存，命中就跳过重复层 |
| `--export-cache` | 构建后把新产生的层写回缓存 |
| `mode=max` | 连中间 stage 一起缓存；Go 的 `go mod download` 层因此能被后面的镜像复用 |
| `ignore-error=true` | 缓存推不上去只降级为“无缓存构建”，不把 CI 判失败——缓存是优化，不是正确性 |

**为什么 Dockerfile 里不再用 `--mount=type=cache`**

BuildKit 的两套缓存容易混：

| | `RUN --mount=type=cache` | registry cache（`--export-cache`） |
|---|---|---|
| 缓存内容 | 目录内容（Go module、build cache） | 构建图层 / 多阶段中间层 |
| 存在哪 | buildkitd 本地状态目录 | Harbor 里的 OCI 缓存镜像 |
| 跨节点/跨流水线 | ❌ 换 Pod 就没了 | ✅ 可移植 |

关键在于：**cache mount 的内容不会被 cache export 带走**。本项目的 `buildkit-state` 是每个 TaskRun 的 emptyDir，所以 cache mount 在跨流水线场景下几乎不生效。

因此 Dockerfile 改成生产默认的 B 方案：

```dockerfile
COPY server/go.mod server/go.sum ./
# 不加 mount：模块落进这一层，registry cache 才能把它导出到 Harbor
RUN go mod download

COPY server ./
# 只保留 go build 缓存目录：编译中间产物不落进镜像层
# 不能再挂 /go/pkg/mod——cache mount 会遮住上一层已下载的模块
RUN --mount=type=cache,target=/root/.cache/go-build go build ...
```

效果：

- `go.mod/go.sum` 不变时，任意节点、任意流水线都能命中 `go mod download` 层，依赖不用重下；
- `go build` 的编译中间产物留在 cache mount，不撑大 Harbor 里的缓存镜像；
- 如果挂了 `/go/pkg/mod`，cache mount 会**遮住**上一层已下载的模块，`go build` 又去下载一遍，registry cache 的收益被抵消——这是最容易踩的反向优化。

**④ 给 BuildKit 配 Harbor 的 CA**

```sh
registry_host=$(printf '%s' "$(params.image)" | cut -d/ -f1)
```

从 `10.0.0.10:30003/fake-tiktok/xxx:sha` 里按 `/` 切第一段，得到 `10.0.0.10:30003`。

```sh
cat > /tmp/buildkitd.toml <<EOF
[registry."${registry_host}"]
  ca = ["/certs/ca.crt"]
EOF
export BUILDKITD_FLAGS="--oci-worker-no-process-sandbox --config /tmp/buildkitd.toml"
```

- BuildKit 默认用系统 CA 校验 HTTPS；Harbor 是内部 CA 签发，必须显式把 `/certs/ca.crt` 加进信任列表；
- 这段 TOML 是 **buildkitd 的配置**，不是 buildctl 参数，所以通过 `--config` 传给 daemon；
- `/certs/ca.crt` 来自 cert-manager 生成的 `harbor-tls` Secret，随证书自动续期；
- `--oci-worker-no-process-sandbox` 是 rootless 模式在 K8s 里启动的前提。

**⑤ 拆分 Dockerfile 路径**

BuildKit 的 Dockerfile frontend 不接受“一个完整路径”，它要两个参数：

```sh
dockerfile_dir=$(dirname "$(params.dockerfile)")    # web
dockerfile_name=$(basename "$(params.dockerfile)")  # Dockerfile
```

对应 `--local dockerfile=<目录>` + `--opt filename=<文件名>`。

**⑥ buildctl 参数**

| 参数 | 含义 |
|---|---|
| `buildctl-daemonless.sh` | 在容器里临时拉起 buildkitd，构建完退出；不需要单独部署 BuildKit 服务，也不挂 docker.sock |
| `--frontend dockerfile.v0` | 用 Dockerfile 前端解析 |
| `--local context=...` | 构建上下文；Go 服务是仓库根，web 是 `web/` |
| `--local dockerfile=...` | Dockerfile 所在目录 |
| `--opt filename=...` | 目录下的 Dockerfile 文件名 |
| `--opt target=...` | 多阶段构建的目标 stage |
| `--output type=docker,dest=...` | 输出 docker-archive 格式 tar，**不 push** |
| `name=$(params.image)` | 把完整镜像名写进 tar 的 manifest，Skopeo 后续按这个引用推 |
| `--progress plain` | 按行输出日志，Tekton 日志里可读 |

**为什么输出 tar 而不是 `type=image,push=true` 直接推**：下一步 Trivy 要扫这个 tar，扫过才允许推。先推再扫的话，高危镜像已经进 Harbor，所谓“阻断”只是不部署，镜像仍可被任何有 pull 权限的人使用。

### Harbor 的认证体系

Harbor 不是“registry 加个密码”，而是 **core（认证/授权/签发 token）+ registry（只认 token）+ proxy** 的组合。认证和授权是分开的。

#### 请求路径

```
docker / skopeo / buildkit / containerd
        │  HTTPS :30003
        ▼
   Harbor proxy (nginx)
        ├── /api/*、/service/token  → core（查身份、查权限、签 JWT）
        └── /v2/*                   → registry（只验 token，不查数据库）
```

#### Token 认证流程（Docker Registry v2 标准）

以 `skopeo copy` 推镜像为例：

1. 第一次请求 `/v2/fake-tiktok/fake_tiktok-user/blobs/...`，不带凭证；
2. registry 返回 `401`，响应头带：
   ```
   WWW-Authenticate: Bearer realm="https://<harbor>/service/token",
                     service="harbor-registry",
                     scope="repository:fake-tiktok/fake_tiktok-user:pull,push"
   ```
3. 客户端拿 Basic Auth（用户名/密码或 robot 凭据）去 `/service/token` 换 token；
4. core 校验身份、查项目成员/robot 权限，签发一个 **JWT**，scope 限定在这个 repository 的 `pull,push`，默认 30 分钟有效；
5. 客户端带 `Authorization: Bearer <token>` 重试，registry 用 core 的公钥验签并检查 scope，通过才允许推拉。

三个关键推论：

- **registry 自己不存用户、不查库**，只信任 core 签的 token；
- 改密码/禁用 robot 后，已签发的 token 在过期前仍然有效（默认 30 分钟）；
- 节点时钟不同步会导致 JWT 验签失败，NTP 必须正常。

#### 身份来源

| 模式 | 说明 |
|---|---|
| Database（默认） | Harbor 本地用户，密码 bcrypt 存储 |
| LDAP / AD | 对接企业目录，用户不落 Harbor 库 |
| OIDC | 对接 Keycloak/Okta 等；CLI 用 UI 生成的 CLI Secret 当密码 |

Robot 账号是 Harbor **本地**身份，不随 LDAP/OIDC 变化，适合 CI。

#### 角色与 robot

| 层级 | 角色 |
|---|---|
| 系统级 | Administrator |
| 项目级 | Project Admin / Maintainer / Developer / Guest / Limited Guest |
| 机器身份 | Robot Account（项目级或系统级） |

- 项目可以是公开（匿名可 pull）或私有；CI 用的项目必须私有；
- Robot 只能做机器认证，不能登录 UI；
- Robot 可限制权限（pull / push / delete / scan）和有效期；
- 项目 robot 的完整用户名通常是 `robot$<项目名>+<机器人名>`，以 UI 创建后显示的为准。

#### 本项目里的两个身份

| Secret | 命名空间 | 使用者 | 权限 |
|---|---|---|---|
| `harbor-push` | `platform-system` | Tekton 的 Skopeo / BuildKit 缓存 | 项目 `fake-tiktok` 的 push + pull |
| `harbor-pull` | `fake-tiktok` | kubelet 拉业务镜像 | 项目 `fake-tiktok` 的 pull |

**为什么必须是两个**：最小权限 + 爆炸半径。构建机被攻破，攻击者只拿到 push 凭据；业务节点只拿 pull 凭据，泄露了也推不了镜像。永远不要用 admin 账号做 CI。

两个 Secret 都是 `kubernetes.io/dockerconfigjson` 类型：

```json
{"auths":{"10.0.0.10:30003":{"username":"robot$ci","password":"..."}}}
```

kubelet、Skopeo、BuildKit 读的都是这套 docker config 格式。

#### TLS 在认证里的位置

Harbor 的 token 是 Bearer JWT；**如果跳过 TLS，token 和 Basic 凭据都可能被中间人截获**。所以认证体系的可信度依赖 TLS：

- Harbor 证书由 cert-manager 内部 CA 签发；
- Skopeo：`--dest-cert-dir=/certs`；
- BuildKit：`buildkitd.toml` 的 `ca = [...]`；
- containerd：`/etc/containerd/certs.d/<host>/ca.crt`；
- 三处都**不再 skip-verify**。

#### 常见错误对照

| 报错 | 根因 |
|---|---|
| `401 Unauthorized` / `authentication required` | 没带凭据、robot 密码错、robot 过期/禁用 |
| `403 denied: requested access to the resource is denied` | robot 没有该项目 push 权限，或仓库路径/项目名写错 |
| `PROJECT_NOT_FOUND` | Harbor 里没建 `fake-tiktok` 项目 |
| `x509: certificate signed by unknown authority` | 客户端没挂 CA（已用 cert-manager 解决） |
| `no basic auth credentials` | `DOCKER_CONFIG` 路径不对，或 Secret 没挂进容器 |
| `manifest unknown`（缓存 import 时） | 第一次构建还没有缓存，正常提示，不影响构建 |

一句话：**Harbor 的认证 = Basic 换 JWT、registry 只认 token；授权 = 项目角色/robot 权限决定 token 的 scope。** `harbor-push` 负责“能推”、`harbor-pull` 负责“能拉”、CA 负责“推拉过程不可被篡改”，三者缺一不可。