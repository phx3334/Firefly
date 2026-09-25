---
title: 学习helm和kustomize
published: 2026-09-22T23:11:23+08:00
description: 掌握helm和kustomize的应用场景和使用方法
image: './images/a29.avif'
tags: [k8s]
category: '计算机技术'
draft: false
lang: '中文'
---


## helm
helm是k8s的包管理工具，可以将k8s应用打包成类似于windows/mac安装包的形式，简化复杂应用的部署过程，例如当服务数量达到十几个或者数十个，使用k8s manifest的方式难以管理。   
### chart
- 定义: K8s应用安装包，包含应用的所有K8s对象
- 来源: 可来自本地或远程仓库(包括Git和OCI格式仓库)
- 类比: 类似Windows的.exe或Mac的.dmg安装包
### release
- 定义: Chart安装后的运行实例
- 特点: 同一Chart可在不同命名空间多次安装，形成多个Release
### 示例投票应用举例
`/templates`文件夹下面都是各种资源的模板文件，有：  
``` yaml
#result-deployment.yaml（web前端）
apiVersion: apps/v1
kind: Deployment
metadata:
  labels:
    app: result
  name: result
spec:
  replicas: 1
  selector:
    matchLabels:
      app: result
  template:
    metadata:
      labels:
        app: result
    spec:
      containers:
      - image: "{{ .Values.result.image }}:{{ .Values.result.tag }}"
        name: result
        ports:
        - containerPort: 80
          name: result
- - - - - - - - - - - - - - - - - - - - - - - -- - - -  -- - --  -
#result-service.yaml
apiVersion: v1
kind: Service
metadata:
  labels:
    app: result
  name: result
spec:
  type: NodePort
  ports:
  - name: "result-service"
    port: 5001
    targetPort: 80
    nodePort: 31001
  selector:
    app: result
- - - - - - - - - - - - - - - - - - - - - - - -- - - -  -- - --  -
#vote-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  labels:
    app: vote
  name: vote
spec:
  replicas: 1
  selector:
    matchLabels:
      app: vote
  template:
    metadata:
      labels:
        app: vote
    spec:
      containers:
      - image: "{{ .Values.vote.image }}:{{ .Values.vote.tag }}"
        name: vote
        ports:
        - containerPort: 80
          name: vote
- - - - - - - - - - - - - - - - - - - - - - - -- - - -  -- - --  -
#vote-service.yaml
apiVersion: v1
kind: Service
metadata:
  labels:
    app: vote
  name: vote
spec:
  type: NodePort
  ports:
  - name: "vote-service"
    port: 5000
    targetPort: 80
    nodePort: 31000
  selector:
    app: vote
  
- - - - - - - - - - - - - - - - - - - - - - - -- - - -  -- - --  -
#worker-deployment.yaml         后台数据处理程序,投票先写进 redis （内存操作，扛并发能力极强，秒级响应），再写进数据库。由于该程序不监听任何端口，只是主动连接redis和数据库，所以不需要负载均衡。
apiVersion: apps/v1
kind: Deployment
metadata:
  labels:
    app: worker
  name: worker
spec:
  replicas: 1
  selector:
    matchLabels:
      app: worker
  template:
    metadata:
      labels:
        app: worker
    spec:
      containers:
      - image: "{{ .Values.worker.image }}:{{ .Values.worker.tag }}"
        name: worker
```
下面是`Chart.yaml`文件,与`/templates`处于同一级
``` yaml
apiVersion: v2
name: vote
description: Kubernetes vote application
type: application
version: 0.1.0
appVersion: "0.1.0"

dependencies:
  - name: redis
    version: "17.16.0"
    repository: "oci://registry-1.docker.io/bitnamicharts"
    condition: redis.enabled
    tags:
      - middleware
  - name: postgresql-ha
    version: "11.9.0"
    repository: "oci://registry-1.docker.io/bitnamicharts"
    condition: postgresql-ha.enabled
    tags:
      - middleware
```
通过命令`helm dependency update`可以获取redis和postgresql-ha的依赖，将他们的.tgz文件下载到/Charts文件夹下.    
`helm upgrade --install vote .  --namespace vote  --create-namespace`（vote是该release的名称）拉起目前当前目录下所有的资源，创建vote命名空间。利用`upgrade,-- install`可以实现幂等（CICD过程可能会重复拉起），即便release存在也不会报错，而是更新，release不存在则安装。  
至于为什么template文件夹下的资源没写redis和postgresql-ha的资源，是因为安装过程中，会自动解压这两个`.tgz` ，各自内部都有自己完整的`templates/` （StatefulSet、Service、ConfigMap、Secret、PVC 等几十种资源）。采取这种方式的原因如下：  
- 不用重复造轮子 ：生产级的 Redis/PostgreSQL（高可用、持久化、备份、探针、密码管理）配置极其复杂，postgresql-ha 子 chart 里有几十个模板文件，自己写不现实
- 统一升级 ：改 Chart.yaml 里的版本号就能升级中间件
- 关注点分离 ：本项目只负责业务应用（vote/result/worker），中间件是"引入"的
 
下面是values.yaml文件。
``` yaml
worker:
  image: dockersamples/examplevotingapp_worker
  tag: latest
vote:
  image: dockersamples/examplevotingapp_vote
  tag: latest
result:
  image: dockersamples/examplevotingapp_result
  tag: latest

# 覆写子 chart 的默认值
redis:
  enabled: true
  fullnameOverride: redis
  auth:
    enabled: false

postgresql-ha:
  enabled: true
  fullnameOverride: db
  global:
    postgresql:
      username: postgres
      password: postgres
      database: postgres
      repmgrUsername: postgres
      repmgrPassword: postgres

```
> 不同环境可以采取不同的 values.yaml 文件：values-dev.yaml，values-prod.yaml,values-test.yaml。我们可以用`helm upgrade --install vote . --namespace vote  --create-namespace -f values-prod.yaml`在values.yaml的基础上,进一步采用`values-prod.yaml`。
**-f和-set的参数**  
- `-f <文件>`：指定一个 yaml 文件（如 values-prod.yaml），会叠加在 chart 自带的 values.yaml 之上，文件中的 key 覆盖同名默认值，未提及的 key 保留默认值。适合覆盖项多、需要长期维护的场景。  
- `--set key=value`：直接在命令行传入键值对，如`--set vote.tag=v2`，同样只覆盖指定的 key。适合临时改动、CICD 中注入镜像 tag 等少量参数。
- 优先级：`--set` > 后面的 `-f` > 前面的 `-f` > chart 默认 values.yaml。即命令行 set 的值永远最优先，多个 `-f` 按出现顺序后者覆盖前者。  
- 缺点：`--set` 的值不会保存在任何文件中，因此生产环境更推荐用 `-f` + 独立的 values 文件（可纳入 Git 管理）。  
### Hooks
Hooks（钩子）是 helm 提供的一种机制，可以让某些资源不随 release 的常规生命周期安装/卸载，而是在特定时间点执行，例如数据库迁移、数据初始化、发送通知等。通过给资源添加 annotation 声明：  
``` yaml
apiVersion: batch/v1
kind: Job                  #负责 跑一次性任务 的资源
metadata:
  name: pre-install-job
  annotations:
    # 在模板渲染之后、其他资源创建之前执行
    "helm.sh/hook": pre-install
    # 同一时机多个hook的执行顺序，值小的先执行，目前该job的值是-1
    "helm.sh/hook-weight": "-1"
    # hook执行完策略：成功即删除该Job资源
    "helm.sh/hook-delete-policy": hook-succeeded
spec:
  template:
    spec:
      containers:
      - name: migrate
        image: "{{ .Values.vote.image }}:{{ .Values.vote.tag }}"
        command: [["/app/myserver", "migrate"]]   #容器运行时的第一个进程
```
该Hooks模板采用vote这个应用镜像，以一个go后端项目镜像为例，`/app/myserver`是项目编译成二进制文件后在容器里的路径，`migrate`是项目里的迁移命令。例如
```go
func main () {
    if len (os.Args) > 1 && os.Args[ 1 ] == "migrate"{
      runMigrations()
    }
}
```


## kustomize
### 什么是kustomize
kustomize 是一个和 helm 类似的 CLI 工具，但思路完全不同：helm 是把 manifest 改造成 `{{ .Values.xxx }}` 模板，通过渲染生成最终 yaml；kustomize 则**不改动原始 manifest**，直接对现成的 yaml 文件做**字段覆写**——任何字段都能覆写（镜像、副本数、annotations、labels……），不需要预先抽取模板变量。  
它由 Kubernetes 团队开发，已内置到 kubectl 中（`kubectl apply -k`），特别适合**多环境**场景。  
### 目录结构
典型结构是 base + overlays：  
``` 
├── base/                      # 所有环境相同的部分（通用的manifest）
│   ├── deployment.yaml        # 最原始的k8s manifest，无模板语法
│   ├── service.yaml
│   └── kustomization.yaml     # 必须有，声明引用哪些资源
└── overlays/                  # 每个环境只放自己独有的差异项
    ├── dev/
    │   ├── kustomization.yaml     # 差异写在配置里：images换tag、patches改副本数
    │   ├── configmap.yaml         # 连测试数据库、debug日志级别等开发配置
    │   └── redis.yaml             # dev用最简单的单机redis，手写一个Deployment就够
    ├── test/
    │   └── kustomization.yaml     # 差异恰好只是改字段，不需要额外资源文件
    └── production/
        ├── kustomization.yaml
        ├── hpa.yaml               # 生产特有的自动扩缩容（dev单副本用不上）
        ├── configmap.yaml         # 生产的数据库地址、正式域名等真实配置
        └── ingress.yaml           # 正式域名+HTTPS入口，一般也只有生产才配
```
- `base/`：放通用的 Deployment、Service 等，就是纯 k8s manifest
- `overlays/<env>/`：每个环境一个目录，放着该环境的差异项，**每个目录（包括base）都必须有 `kustomization.yaml`**
### 还是那个投票应用
把投票应用改造成 kustomize 管理。base 里的 deployment.yaml 就是**最原始的 manifest**（和文章开头的写法一模一样，镜像写死、无任何 `{{ }}` 模板），只是多了个 kustomization.yaml：  
``` yaml
# base/kustomization.yaml
resources:
  - deployment.yaml   # vote、result、worker 都在里面
  - service.yaml
```
base 通常使用默认配置。dev 环境覆写镜像 tag、副本数，并额外加一个单机版 redis（目录树里的 configmap.yaml、redis.yaml 都必须在这里声明，否则不生效）：  
``` yaml
# overlays/dev/kustomization.yaml
resources:
  - ../../base                    # 引入base的全部资源
  - redis.yaml                    # dev环境特有的资源：手写的单机redis
  - configmap.yaml                # dev环境特有的配置：测试库地址、debug日志

images:
  - name: dockersamples/examplevotingapp_vote   # 覆写哪个镜像
    newTag: "dev-abc123"                        # 覆写成什么tag
  - name: dockersamples/examplevotingapp_result
    newTag: "dev-abc123"

patches:
  - target:
      kind: Deployment
      name: vote                 # 定位到base里的vote Deployment
    patch: |-
      - op: replace              # JSON Patch规范：replace/add/remove等
        path: /spec/replicas
        value: 1                 # dev环境只要1个副本
```
production 环境换镜像仓库地址（对应 Jenkins 推到 Harbor 的场景），并且引用目录树里的 hpa、configmap、ingress，redis 这类高可用中间件则用 helmCharts 引入：  
``` yaml
# overlays/production/kustomization.yaml
resources:
  - ../../base
  - hpa.yaml                      # 生产特有的自动扩缩容
  - configmap.yaml                # 生产的数据库地址、正式域名
  - ingress.yaml                  # 正式域名+HTTPS入口

images:
  - name: dockersamples/examplevotingapp_vote
    newName: harbor.mycompany.com/vote/app     # 换镜像地址
    newTag: "git-abc123"                       # 用commit id做tag

helmCharts:                                      # 高可用redis用chart引入，不手写
  - name: redis
    repo: oci://registry-1.docker.io/bitnamicharts
    version: "17.16.0"
    releaseName: redis
    valuesInline:
      auth:
        enabled: false       #关闭redis密码验证
```
部署命令：  
``` bash
kubectl apply -k ./overlays/production                   
```
### kustomization.yaml 常用配置
- `resources`：引用 Manifest 资源，可以是文件、目录或 URL
- `secretGenerator` / `configMapGenerator`：动态生成 Secret/ConfigMap（内容变更时自动生成新名字，触发引用它的 Pod 滚动更新，这是手写 manifest 做不到的）  
``` yaml
configMapGenerator:
  - name: app-config
    files:
      - config.properties
secretGenerator:
  - name: db-password
    literals:
      - password=postgres
```
- `images`：专门覆写镜像的 newTag/newName/digest
- `patches`：通用字段覆写，采用 JSON Patch 规范（`replace`、`add`、`remove` 等操作）
- `helmCharts`：引用第三方 Helm Chart，和 helm 混合使用
### 和helm混合使用
上一节 production 示例中的 `helmCharts` 就是混合用法：中间件（redis/postgresql）不想手写 manifest，直接引现成的 chart，由 kustomize 统一渲染。要点：  
- `valuesInline` 相当于 helm 的 `-f`/`--set`，用来覆写 chart 默认值  
- 命令行要加 `--enable-helm` 才会调用 helm 渲染 chart：  
### kustomize与helm对比
|          | helm                                   | kustomize                                            |
| -------- | -------------------------------------- | ---------------------------------------------------- |
| 覆写方式 | 预先抽取模板变量，只能改暴露出来的变量 | 可改 manifest 任意字段（annotations、labels 等都行） |
| 学习成本 | 需学 Go template 模板语法              | 无模板语法，会 k8s manifest 就会用                   |
| 环境管理 | 多份 values 文件                       | base + overlays 目录结构                             |
| 分发     | 有集中仓库，chart 可打包分发           | 强依赖目录组织，没有集中仓库，生态较少               |
| API 暴露 | 模板包了一层，细节被隐藏               | 完整暴露 K8s API 细节                                |

**选择建议**：需要把应用打包分发给别人 → helm；需要精细控制 k8s 资源字段、多环境差异管理 → kustomize；两者不冲突，通过 `helmCharts` 字段可以混合使用——这也是很多人生产上的真实用法。
