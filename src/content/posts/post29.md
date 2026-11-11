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
- 资源最终叫什么名、nameOverride/fullnameOverride 怎么用，统一见后文「命名」一节
### 典型目录结构
一个 chart 就是一个普通目录，`helm upgrade --install vote .` 里的 `.` 指向的就是它的根目录：
``` 
vote/                        # chart 根目录（也是 helm 命令执行的路径）
├── Chart.yaml               # chart 元数据：名称、版本、dependencies 依赖声明
├── values.yaml              # 默认配置值，模板里通过 .Values.xxx 读取
├── values-prod.yaml         # 可选：环境覆盖值，安装时用 -f 引入
├── charts/                  # helm dependency update 下载的子 chart 压缩包
│   ├── redis-17.16.0.tgz
│   └── postgresql-ha-11.9.0.tgz
├── templates/               # K8s 资源模板，渲染后才是最终要提交的 manifest
│   ├── _helpers.tpl         # 可复用模板片段（下划线开头，不渲染为资源）
│   ├── vote-deployment.yaml
│   ├── vote-service.yaml
│   ├── result-deployment.yaml
│   ├── result-service.yaml
│   ├── worker-deployment.yaml
│   └── NOTES.txt            # helm install 成功后在终端打印的使用提示
└── .helmignore              # 打包时排除的文件，写法同 .gitignore
```
要点：
- `Chart.yaml` 管"我是谁、依赖谁"，`values.yaml` 管"参数默认值"，`templates/` 管"长什么样"——三者职责分离。
- `charts/` 里是 `helm dependency update` 拉下来的 `.tgz`，安装时自动解压渲染，所以 `templates/` 里看不到中间件的资源。
- `NOTES.txt` 不是 K8s 资源，只在命令行输出，常用来打印访问地址、查看日志的提示命令。
- `helm lint vote`（静态检查）和 `helm template vote .`（只渲染不提交，本地预览最终 yaml）是改动模板后的两个常用验证命令。
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
#注意这个apiversion仅是针对helm版本，与k8s的那个没有任何关系
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
### 模板内置变量
渲染模板时 helm 会注入一组内置变量，最常用的是 `.Release` 和 `.Chart`：
- `.Release.Name`：release 名称，即执行 `helm install/upgrade` 命令时指定的名字（如 `vote`），在模板中通过 `.Release.Name` 获取，资源命名、标签里经常引用它。
- `.Release.IsInstall` / `.Release.IsUpgrade`：布尔值，区分当前操作是安装还是升级/回滚。执行 `helm install` 时 IsInstall 为 true；执行 `helm upgrade` 或 `helm rollback` 时 IsUpgrade 为 true。典型应用：安装时初始化数据库，升级时跳过初始化（库已存在）。
- `.Release.Revision`：修订版本号，从 1 开始计数，每次升级或回滚都加 1。了解即可，实际使用场景较少。
- `.Chart`：访问 `Chart.yaml` 文件的内容，如 `.Chart.AppVersion`（应用版本）、`.Chart.Version`（chart 版本）、`.Chart.Description`（描述）。

生产小例子：CI 发布时把 `{{ .Release.Name }}-{{ .Chart.AppVersion }}` 写进镜像 tag 或 Pod 注解，配合 `helm history vote` 就能追溯每个 revision 对应的版本；回滚时 revision 照样递增，不会和历史版本混淆。
### range 循环
遍历 values 里的列表或字典用 `range`（对应 Go 的 for），有两种形态。

**遍历列表**——单变量模式，`.` 指向当前迭代元素：
``` yaml
# values.yaml
flavors:
  - cheese
  - peppers
  - onions
```
``` yaml
# 模板
{{- range .Values.flavors }}
{{ . | title | quote }}
{{- end }}
```
处理过程：第一次迭代 `.` 为 `cheese`，经 `title` 首字母大写、`quote` 加引号后输出 `"Cheese"`；第二次输出 `"Peppers"`，第三次输出 `"Onions"`。

**遍历字典（map）**——必须显式声明 key、value 两个变量，变量名可任意指定（如 `$k/$v`），但需保持语义清晰：
``` yaml
# values.yaml
favorite:
  drink: coffee
  food: pizza
```
``` yaml
{{- range $key, $val := .Values.favorite }}
{{ $key }}: {{ $val | quote }}
{{- end }}
```
处理过程：第一次迭代 `$key="drink"`、`$val="coffee"`，输出 `drink: "coffee"`；第二次输出 `food: "pizza"`。

要点：
- 核心区别：列表循环是单变量模式，通过 `.` 获取元素；字典循环需显式声明 key 和 value 两个变量。
- 所有循环都通过 `range` 启动，且循环体内定义的变量作用域仅在循环体内有效。
- 管道操作符 `|` 可链式调用多个函数，常用函数：`title`（首字母大写）、`quote`（添加双引号）、`default`（兜底值）。
### with 作用域控制
`.` 默认指向根作用域，访问深层嵌套的 values 时路径一长就很冗长：
``` yaml
{{ .Values.favorite.drink | default "tea" | quote }}
{{ .Values.favorite.food | default "pizza" | quote }}
```
用 `with` 把取值作用域切换到指定路径，之后直接用子属性名访问：
``` yaml
{{- with .Values.favorite }}
{{ .drink | default "tea" | quote }}
{{ .food | default "pizza" | quote }}
{{- end }}
```
作用域转换原理：默认作用域在根（`.`），通过 `with .Values.favorite` 把作用域切换到该节点，切换后 `.drink` 就等价于原来的 `.Values.favorite.drink`。

**坑点**：`with` 块内访问其他作用域的变量必须加 `$` 前缀——`$` 表示从根作用域开始解析：
``` yaml
{{- with .Values.favorite }}
release: {{ $.Release.Name }}   # 正确：$ 从根作用域解析
{{ .Release.Name }}             # 错误：在 .Values.favorite 下找 Release，找不到
{{- end }}
```
忘加 `$` 导致变量找不到是最常见的报错，嵌套 `with` 时作用域混淆尤其要注意。
### _helpers.tpl
`/templates` 下以 `_` 开头的文件（如 `_helpers.tpl`）**不会被渲染成独立的 K8s 资源**，而是存放可复用的模板片段，供其他模板通过 `include` 调用。典型内容：
``` yaml
{{- define "vote.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name (include "vote.name" .) | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}

{{- define "vote.labels" -}}
helm.sh/chart: {{ include "vote.chart" . }}
app.kubernetes.io/name: {{ include "vote.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "vote.selectorLabels" -}}
app.kubernetes.io/name: {{ include "vote.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}
```
在 Deployment/Service 模板里这样引用：
``` yaml
metadata:
  name: {{ include "vote.fullname" . }}
  labels:
    {{- include "vote.labels" . | nindent 4 }}
spec:
  selector:
    matchLabels:
      {{- include "vote.selectorLabels" . | nindent 4 }}
```
要点：
- `define` 定义片段、`include` 调用片段。`include` 返回字符串，可以接管道过滤器（如 `| trunc 63（截断字符串，取前63个） | trimSuffix "-"（丢弃字符串末尾的 "-"）| nindent 4`（缩进4空格））；`include "vote.fullname" .` 末尾的 `.` 是把当前作用域的上下文（.Values、.Release 等）传进去，漏传会导致模板内取不到变量。
- 命名必须加 chart 名前缀（如 `vote.`），否则会和子 chart 的同名 define 冲突。
- fullname 的拼接对应 K8s 命名规范（release 名、chart 名、63 字符上限、不能以连字符结尾），完整规则和生产用法统一放在下一节「命名」里讲。
- 核心价值是**一致性**：`selectorLabels` 同时被 Service 的 `selector` 和 Pod 的 `template.labels` 引用，保证两者永远匹配（Service 选不中 Pod 的经典故障就是这两处手写改岔了）；`labels` 统一输出 `app.kubernetes.io/*` 标准标签，改一处全生效。
- 维护优势：命名、标签逻辑集中在 `_helpers.tpl` 一处，改一个文件，deployment/service/ingress 全部生效，不用挨个配置文件改——典型场景是统一管理微服务各组件的名称格式。
### 命名：release 名、chart 名与两个 override 【必掌握】

资源最终叫什么名字，由三个名字共同决定——这个话题前面散落在 chart/release 定义、values 示例和 `_helpers.tpl` 里，这里一处说清。

**三个名字先分清**

| 名字 | 从哪来 | 能不能变 |
| --- | --- | --- |
| Chart 名 | `Chart.yaml` 的 `name` | 基本不变（它是包的身份） |
| Release 名 | `helm install <名字>` 时指定 | 随时可指定，同一 chart 装多次靠它区分 |
| 资源名 | 模板渲染出的 K8s 对象名（Deployment/Service 的 `metadata.name`） | 由下面的规则决定 |

release 名要进资源名，是有实际意义的：同一 chart 在两个命名空间各装一份，资源名不同才不会在全局（如 PV、ClusterRole 这类集群级对象）撞名——这就是 chart 作为"安装包"、release 作为"运行实例"的底层约定。

**默认规则**（`helm create` 生成的 `_helpers.tpl` 里）：`fullname = .Release.Name + "-" + .Chart.Name`，再 `trunc 63` 截到 K8s 资源名的 63 字符上限、`trimSuffix "-"` 去掉结尾连字符。所以 release `vote` 装 chart `vote`，默认资源名是 `vote-vote`；很多 chart 还会判断两值相等时只留一个，实际得到 `vote`。完整拼接逻辑就是前一节 `vote.fullname` 那段。

**两个 override**（写在 `values.yaml` 或 `-f` 里，只影响 `fullname`，即 `metadata.name` 和对应 label）：

- `fullnameOverride`：完全接管——资源名就用这个值，不再拼 release 和 chart 名。用于**外部系统按固定名访问你的场景**（比如外部 Prometheus 按固定名抓 Service、别的团队按约定名直连）。
- `nameOverride`：只替换拼接里的 chart 名那一段，release 名前缀保留。想把 `vote-vote` 里的 chart 段换成应用名时用它。
- 两者都**不影响 `selectorLabels`**——Service 的 selector 和 Pod 的 labels 依然匹配，这是 override 改名而服务不断流的关键。

**生产一般怎么用**

1. **release 名 = 应用名 = 命名空间名**（如都叫 `vote`），`helm list -n vote` 一眼对应；多环境靠命名空间区分，release 名保持一致，`helm history vote -n prod` 查的就是你熟悉的那个应用。
2. **默认规则不动**：资源名天然带 release 前缀，多实例、多环境不冲突，多数场景零配置。
3. **`fullnameOverride` 只在被外部按名依赖时用**，且一旦上线就不能随意改——它对同一 release 是改名（旧资源名的残留对象需要手动清理），对下游是接口变更。
4. **CI/CD 永远不要每次换 release 名**：release 名变了 helm 会当成全新实例重复部署，旧实例变孤儿。
5. 仓库里其它地方出现的 `fullnameOverride`（如 values 示例里的 redis）是子 chart 的——父 chart 通过 values 把这个名字传给子 chart，让中间件的资源名也服从同一套规划，不被子 chart 默认名（`vote-redis` 这种双拼）打乱。

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