---
title: 云原生综合项目实践
published: 2026-11-11T20:11:23+08:00
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
	// Prometheus 抓取端点，与探针端点同级（不挂业务路由前缀）
	engine.GET("/metrics", otelx.MetricsHandler())

	return engine
}
```

