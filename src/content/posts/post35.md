---
title: operator
published: 2026-10-04T23:11:23+08:00
description: 学习operator的工作原理和用处
image: './images/a35.jpg'
tags: [k8s]
category: '计算机技术'
draft: false
lang: '中文'
---

## Operator

### 为什么需要 Operator

K8s 原生的 Deployment 已经能很好地管理无状态应用：副本挂了自动重建、滚动更新、扩缩容一条龙。但 Deployment 建出来的 Pod 本质上是"可替换的零件"，它无法理解一个 MySQL 或 Redis 集群的内部逻辑——主从关系、数据备份、故障转移、扩容时该先动谁，这些属于**领域运维知识**，K8s 自己不知道。

Operator 的思路很直接：把这些运维知识写成代码，做成一个自定义控制器。它由两部分组成：

- **CRD（自定义资源定义）**：向 API Server 注册一种新的资源类型，比如 `RedisCluster`，让我们可以像写 Deployment YAML 一样声明期望状态
- **自定义控制器**：一个持续运行的 Pod，Watch 这种新资源的变化，把"声明"翻译成真正的 K8s 操作

一句话总结：**Operator = CRD + 自定义控制器**，CRD 负责存期望状态，控制器负责让现实向期望收敛。

### Operator 的不同用处

Operator 并不只用于管数据库，凡是"需要一套固定操作流程才能维持运行"的东西都适合：

- **有状态中间件**：Redis Operator、PostgreSQL Operator（Zalando）。创建 CR 后自动生成 StatefulSet、Service、ConfigMap，处理主从复制、故障转移、备份
- **监控**：Prometheus Operator。声明一个 `Prometheus` CR，Operator 自动拉起 Prometheus 实例并生成抓取配置，`ServiceMonitor` CR 则声明"要抓哪些 Service"
- **证书管理**：cert-manager。声明 `Certificate` CR，Operator 自动向 Let's Encrypt 申请证书并自动续期，续期后替换 Secret
- **定时扩缩容**：自定义 CronHPA CR，Operator 在指定时间修改 Deployment 的 `spec.replicas`（工作日晚高峰扩容、凌晨缩容）
- **应用发布**：Argo Rollout 的 `Rollout` CR，提供金丝雀发布、蓝绿发布等 Deployment 不具备的能力

它们的共同模式都是：**用户写 CR 声明"我想要什么"，Operator 负责回答"怎么做到"**。

### 工作机制

先看 CRD 是怎么变成一种"真资源"的。提交一个 CRD 后，API Server 会为它动态注册一组 REST 端点（`apis/example.com/v1/namespaces/default/redisclusters`），数据照常存进 etcd。从此 `kubectl get redisclusters` 就是合法命令，权限、校验、事件机制与原生资源完全一致。

Operator 控制器内部是一个标准的**Reconcile 调谐循环**：

```
Watch CR 变化（Informer 监听 etcd 事件流）
   │
   ▼
事件进入工作队列
   │
   ▼
Reconcile 被触发，拿到最新 CR
   │
   ├── 读取 spec（期望状态）
   ├── 读取集群实际状态
   ├── 有差异 → 调 API Server 创建/修改原生资源（StatefulSet、Service...）
   └── 回写 status（实际状态）
   │
   ▼
结束并返回，等待下一次触发
```

两个关键设计：

- **水平触发（level-triggered）**：Reconcile 不是"收到事件执行一次就完"的边缘触发，而是随时可以被再次触发。哪怕 Operator 重启、错过事件，下一次 Reconcile 依然会对比 spec 与现实并补齐差异，所以逻辑必须**幂等**——执行一次和执行十次结果相同
- **只写自己的账本**：Reconcile 中对实际状态的判断不能只靠内存变量，一切以从 API Server 读到的数据为准

### 用 kubebuilder 搭脚手架

kubebuilder 是官方推荐的开发框架，两步生成项目骨架：

```bash
# 初始化项目（生成 Go module、manager 入口、Makefile 等）
kubebuilder init --domain example.com --repo github.com/example/redis-operator

# 创建 API：新增一种 CRD 类型 RedisCluster，并生成配套的控制器
kubebuilder create api --group cache --version v1 --kind RedisCluster --resource --controller
```

生成的项目结构如下（省略非核心文件）：

```
redis-operator/
├── main.go                          # 程序入口：启动 manager
├── api/v1/
│   └── rediscluster_types.go        # CRD 的 Go 定义：Spec、Status、GVK
├── internal/controller/
│   └── rediscluster_controller.go   # 控制器核心：Reconcile 逻辑写在这里
├── config/
│   ├── crd/                         # 由 types.go 自动生成的 CRD YAML（make manifests）
│   ├── rbac/                        # Operator 自身需要的权限（能 watch/list CR、能改 StatefulSet）
│   └── manager/                     # Operator 自身的 Deployment
└── Makefile                         # 封装生成代码、构建镜像、部署等命令
```

### 各文件职责详解

**`api/v1/rediscluster_types.go`——声明"资源长什么样"**

这是 CRD 的源头，Go 结构体会通过 controller-gen 转换成 CRD YAML。核心是 `Spec`（用户填的期望状态）和 `Status`（Operator 回写的实际状态）：

```go
// api/v1/rediscluster_types.go
// RedisClusterSpec 定义用户声明的期望状态
type RedisClusterSpec struct {
	// Shards 是分片数量，即最终要有几个 Redis 节点
	// +kubebuilder:validation:Minimum=1
	Shards int `json:"shards"`
	// Image 是 Redis 容器镜像
	Image string `json:"image"`
	// Storage 是每个节点的存储大小，如 "10Gi"
	Storage string `json:"storage"`
}

// RedisClusterStatus 定义 Operator 观察到的实际状态
type RedisClusterStatus struct {
	// ReadyShards 是当前已就绪的节点数，与 spec.Shards 对比即可判断是否收敛
	ReadyShards int `json:"readyShards"`
	// Conditions 记录各阶段状态，kubectl describe 时能看到
	Conditions []metav1.Condition `json:"conditions,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// RedisCluster 是整个 CR 的顶层结构，spec/status 分开存
type RedisCluster struct {
	metav1.TypeMeta   `json:",inline"`   // 记录 apiVersion 和 kind
	metav1.ObjectMeta `json:"metadata,omitempty"` // 名字、namespace 等元信息
	Spec   RedisClusterSpec   `json:"spec,omitempty"`
	Status RedisClusterStatus `json:"status,omitempty"`
}
```

`+kubebuilder:validation:Minimum=1` 这类注释不是普通注释，是 marker，`make manifests` 时会转成 CRD 的字段校验规则，用户写错值时 API Server 直接拒绝。

**`internal/controller/rediscluster_controller.go`——控制器的大脑**

Reconciler 只有一个核心方法 `Reconcile`，所有逻辑都围绕"让集群状态等于 spec"展开：

```go
// RedisClusterReconciler 负责调谐 RedisCluster CR
type RedisClusterReconciler struct {
	client.Client
	Scheme *runtime.Scheme
}

// +kubebuilder:rbac:groups=cache.example.com,resources=redisclusters,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=apps,resources=statefulsets,verbs=get;list;watch;create;update;patch;delete
// 上面的 rbac marker 会生成 config/rbac/role.yaml，声明 Operator 需要的权限

func (r *RedisClusterReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	// 1. 按 req（namespace/name）取出 CR；NotFound 说明被删除了，直接返回即可
	var cluster cachev1.RedisCluster
	if err := r.Get(ctx, req.NamespacedName, &cluster); err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}

	// 2. 期望的 StatefulSet：由 CR 的 spec 翻译而来
	sts := &appsv1.StatefulSet{
		ObjectMeta: metav1.ObjectMeta{
			Name:      cluster.Name,
			Namespace: cluster.Namespace,
		},
		Spec: appsv1.StatefulSetSpec{
			Replicas: ptr.To(int32(cluster.Spec.Shards)), // 副本数来自 CR
			Selector: &metav1.LabelSelector{
				MatchLabels: map[string]string{"app": cluster.Name},
			},
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{
					Labels: map[string]string{"app": cluster.Name},
				},
				Spec: corev1.PodSpec{
					Containers: []corev1.Container{{
						Name:  "redis",
						Image: cluster.Spec.Image, // 镜像来自 CR
					}},
				},
			},
		},
	}

	// 3. CreateOrUpdate：已存在则按新 spec 更新，不存在则创建，天然幂等
	if err := controllerutil.CreateOrUpdate(ctx, r.Client, sts, func() error {
		sts.Spec.Replicas = ptr.To(int32(cluster.Spec.Shards)) // 每次 Reconcile 强制对齐
		return controllerutil.SetControllerReference(&cluster, sts, r.Scheme) // 建立归属关系，CR 删除时级联删除
	}); err != nil {
		return ctrl.Result{}, err
	}

	// 4. 回写 status：把实际就绪数写到 CR 上，kubectl get 时可见
	cluster.Status.ReadyShards = int(sts.Status.ReadyReplicas)
	if err := r.Status().Update(ctx, &cluster); err != nil {
		return ctrl.Result{}, err
	}

	// 5. 就绪数还没追上期望数时，30 秒后再触发一次 Reconcile 继续观察
	if sts.Status.ReadyReplicas != cluster.Spec.Shards {
		return ctrl.Result{RequeueAfter: 30 * time.Second}, nil
	}
	return ctrl.Result{}, nil
}
```

注意第 3 步：我们从不判断"这个 StatefulSet 是不是我自己创建的"，`SetControllerReference` 通过 ownerReference 建立归属后，CR 被删除时 K8s 会级联清理它创建的所有资源。

**`main.go`——程序入口**

main.go 做的事情很单一：创建 manager，把 Reconciler 和 CRD 注册进去，然后启动。manager 内部封装了 client、informer 缓存和工作队列，我们不需要手写 Watch 逻辑：

```go
func main() {
	mgr, err := ctrl.NewManager(ctrl.GetConfigOrDie(), ctrl.Options{Scheme: scheme})
	if err != nil {
		setupLog.Error(err, "unable to start manager")
		os.Exit(1)
	}

	// 把 Reconciler 注册进 manager，SetupWithManager 内部声明了"我要 Watch RedisCluster"
	if err := (&controller.RedisClusterReconciler{
		Client: mgr.GetClient(),
		Scheme: mgr.GetScheme(),
	}).SetupWithManager(mgr); err != nil {
		setupLog.Error(err, "unable to create controller")
		os.Exit(1)
	}

	setupLog.Info("starting manager")
	if err := mgr.Start(ctrl.SetupSignalHandler()); err != nil {
		setupLog.Error(err, "problem running manager")
		os.Exit(1)
	}
}
```

`SetupWithManager` 里的关键一行是 `For(&cachev1.RedisCluster{}).Complete(r)`，它声明了 Watch 的对象类型。如果 CR 的变化会间接影响其他资源（比如 StatefulSet 被人手动改了），还可以用 `.Owns(&appsv1.StatefulSet{})` 让这些资源的变化也触发 Reconcile。

### 部署与验证

```bash
# 把 types.go 里的 marker 转换成 CRD YAML 和 RBAC 清单
make manifests

# 安装 CRD 到集群
make install

# 本地运行 Operator（直接跑在终端，连的是当前 kubeconfig 集群，方便调试）
make run

# 另开终端创建一个 CR
kubectl apply -f config/samples/cache_v1_rediscluster.yaml
kubectl get redisclusters
# NAME          READYSHARDS   AGE
# redis-sample   2/3          5m    # READYSHARDS 就是 Reconcile 回写的 status
```

生产部署时 `make docker-build docker-push` 把 Operator 打成镜像，`make deploy` 会在集群里创建一个 Deployment 跑这个镜像，外加 CRD 和 RBAC。此时 Operator 自身就是一个普通工作负载，它 Watch 的 CR 和它创建的 StatefulSet 都在同一套 API Server 之下。

### 小结
回到最初的问题：Operator 解决的是"K8s 不懂你的应用"这个矛盾。CRD 把领域知识翻译成 API Server 能存储的声明，控制器把声明翻译成集群能执行的操作。写一个生产级 Operator 的复杂度主要在故障处理和升级逻辑上，但骨架始终是本文这一套：**定义 Spec/Status → 实现 Reconcile → 保持幂等 → 依赖水平触发自动收敛**。

