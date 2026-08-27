---
title: k8s的部署和常用操作
published: 2026-08-24T20:11:23+08:00
description: 进一步学习k8s的内容
image: './images/a22.avif'
tags: [k8s]
category: '计算机技术'
draft: false
lang: '中文'
---

kubeadm部署见https://egonlin.com/?p=10762（对于Ubuntu来说默认不用networkmanager和selinux，前端防火墙命令用ufw）

## 手动二进制包部署



## 常用操作
### containerd客户端命令介绍
#### crictl
> K8s 官方推荐的节点调试工具，通过 CRI 协议与 containerd 交互，天然理解"Pod 沙箱 + 容器"的抽象。默认连接 `/run/containerd/containerd.sock`。
**环境配置**（可选，配置后可省略 `--runtime-endpoint`）：
```bash
cat > /etc/crictl.yaml <<EOF
runtime-endpoint: unix:///run/containerd/containerd.sock
image-endpoint: unix:///run/containerd/containerd.sock
timeout: 10
debug: false
EOF
```
**常用命令：**

```bash
# Pod 沙箱（crictl 独有能力）
crictl pods                      # 列出所有 Pod 沙箱
crictl runp <config.json>        # 创建 Pod 沙箱（调试用）
crictl stopp <pod-id>            # 停止沙箱
crictl rmp <pod-id>              # 删除沙箱
crictl inspectp <pod-id>         # 查看沙箱详情

# 容器
crictl ps                        # 查看运行中的容器
crictl ps -a                     # 查看所有容器（含已退出）
crictl exec -it <container-id> sh    # 进入容器
crictl logs <container-id>       # 查看日志
crictl logs -f <container-id>    # 实时跟踪日志
crictl stop <container-id>       # 停止容器
crictl rm <container-id>         # 删除容器
crictl inspect <container-id>    # 查看容器详情

# 镜像
crictl pull <image>              # 拉取镜像
crictl images                    # 列出镜像
crictl rmi <image>               # 删除镜像
crictl inspecti <image>          # 查看镜像详情

# 其他
crictl stats                     # 查看资源使用（CPU/内存）
```

#### ctr

> containerd 自带的原生 CLI，直接调用 containerd 的 gRPC API，能看到并管理所有命名空间及底层内容仓库。它是"底层调试器"，不推荐日常使用。

**命名空间概念**：K8s 的容器都在 `k8s.io` 命名空间，默认命名空间是 `default`，用 `-n` 指定：

```bash
ctr -n k8s.io ps          # 查看 k8s 的容器
ctr -n default ps         # 查看 default 命名空间
```

**常用命令：**

```bash
# 命名空间管理
ctr namespaces ls         # 列出所有命名空间
ctr namespaces create <name>
ctr namespaces rm <name>

# 镜像
ctr images pull <image>             # 拉取镜像
ctr images list                     # 列出镜像
ctr images rm <image>               # 删除镜像
ctr images tag <image> <new-tag>    # 打标签
ctr images import <file.tar>        # 导入镜像（crictl 没有的能力）
ctr images export <file.tar> <image> # 导出镜像

# 容器（ctr 里容器和任务是分开的）
ctr containers list                 # 列出容器
ctr containers rm <id>              # 删除容器
ctr run <image> <name> <cmd>        # 创建并启动容器
ctr tasks list                      # 列出任务（运行中的容器进程）
ctr tasks exec -t <task-id> sh      # 进入任务
ctr tasks kill <task-id>            # 终止任务

# 底层仓库（crictl 完全没有）
ctr content ls                      # 查看内容仓库（blob）
ctr snapshots ls                    # 查看快照层
ctr plugins ls                      # 查看 containerd 插件
ctr events                          # 监听事件流
```

#### nerdctl
> containerd 的 docker 兼容 CLI，几乎把 `docker` 命令 1:1 搬到 containerd 上，支持构建镜像、compose。**日常操作最推荐的工具**。

**命名空间**：默认操作 `default` 命名空间，查看 K8s 容器需加 `-n k8s.io`：

```bash
nerdctl ps                # 默认命名空间（通常为空）
nerdctl -n k8s.io ps      # 查看 k8s 的容器
```

**常用命令（和 docker 基本一样）：**
```bash
# 容器
nerdctl run -it --rm nginx        # 运行容器
nerdctl run -d -p 8080:80 nginx   # 后台运行并映射端口
nerdctl ps                        # 查看运行中的容器
nerdctl ps -a                     # 查看所有容器
nerdctl exec -it <id> sh          # 进入容器
nerdctl logs -f <id>              # 实时日志
nerdctl stop <id>                 # 停止
nerdctl start <id>                # 启动
nerdctl rm <id>                   # 删除
nerdctl stats                     # 资源统计
# 镜像
nerdctl pull <image>              # 拉取
nerdctl images                    # 列表
nerdctl build -t <tag> .          # 构建镜像（crictl/ctr 都没有）
nerdctl push <image>              # 推送
nerdctl tag <image> <new-tag>     # 打标签
nerdctl save -o app.tar <image>   # 导出
nerdctl load -i app.tar           # 导入
nerdctl rmi <image>               # 删除
# 其他
nerdctl compose up -d             # compose 编排
nerdctl volume ls                 # 卷管理
nerdctl network ls                # 网络管理
nerdctl inspect <id>              # 查看详情
nerdctl -n k8s.io exec -it <id> sh  # 进入 k8s 容器
```
**使用提示：**
- 在 K8s 节点上排查问题优先 `crictl`；测试/构建镜像用 `nerdctl`；`ctr` 只在 containerd 本身出问题时才用。
- `nerdctl` 在 K8s 节点上通常不需要装，它是给日常开发和调试用的。
- 三个工具可以共存，互不影响。

### kubectl
#### 基本语法
`kubectl[command][TYPE][NAME][flags]`  
- command：子命令，用于操作资源对象。例如get、delete、describe、exec、cp、logs、apply等  
- TYPE：资源类型区分大小写，并且可以简写。
- NAME：具体的资源名区分大小写，如果不指定具体的资源NAME，则默认返回全部，并且在一条命令里可指定多个资源操作
- flags：可选参数
```bash
#实时查看变动
kubectl get pods -w
# -o wide就是让输出的数据更详细
kubectl get deploy,pods -o wide -n 某个名称空间
#-A不能直接跟在kubectl后，要往后放，代表查看所有名称空间
kubectl get deploy,pods -o wide -A
#1、基于yaml创建资源
kubectl apply -f 1.yaml
#启动临时容器，用于测试，exit退出后则删除
kubectl run -i --tty --image busybox:1.27 egon-test --restart=Never --rm sh
#查看某个 Deployment 资源的完整定义，以 YAML 格式显示。
kubectl get deploy nginx -o yaml
#实时滚动查看某个 Pod 的输出日志
kubectl logs -f nginx-7d8b9c5c4f-abcde
#没有正常启动，可以describe查看一下node01这个节点的事件，还可以查看pod,service等资源类型
kubectl describe node node01
#关于describe的结果示例：
#ControlledBy指明此Pod是由ReplicaSet/xxx创建。Events记录了Pod的启动过程。
#如果操作失败（比如image不存在），也能在这里查看到原因

# 只拧副本数这一个旋钮
kubectl scale deployment nginx --replicas=0
#改镜像版本、加配置。这个和上面那个改的都是etcd里面存的yaml文件，本地yaml文件不变，再次apply -f可以重置
kubectl edit deployment nginx
#删除
kubectl delete deloyment xxx
#按配置文件删
kubectl delete -f1.yaml
#看资源上都打了什么标签
kubectl get pods --show-labels
#按标签删。
kubectl delete pods,services -l <label-key>=<label-value>
#进入Pod内
kubectl exec -it pod 名字 bash
#pod拷贝到本机
kubectl cp pod名:/etc/fstab /tmp/a.txt
#本机拷贝到pod内
kubectl cp /tmp/a.txt pod名:/tmp
#补充：pod内有多个容器的场景，指定拷贝的某个容器中
kubectl cp egon.txt web-77887cf499-4spwp:/tmp -c c2
```
#### kubectl插件
- 创建一个可执行文件，文件名必须以kubectl-开头（例如kubectl-hello），该文件就是kubectl的插件文件名kubectl-hello，注意必须以kubectl-开头必须添加可执行权限
- 将插件放到$PATH下，例如/usr/local/bin
- 然后就可以执行kubectl来运行自定义插件了`kubectl hello`
想删除插件的话直接删就行`rm-rf/usr/local/bin/kubectl-hello`


### 创建与删除资源
K8S的资源有Pod、Service、Volume、Namespace、ReplicaSet、Deployment、StatefulSet、DaemonSet、Job等等，如
下：  
| 类别名称 | 资源对象 |
|---------|---------|
| 工作负载型资源对象 | Pod、ReplicaSet、ReplicationController、Deployment、StatefulSet、DaemonSet、Job、CronJob |
| 服务发现及负载均衡 | Service、Ingress |
| 配置与存储 | Volume、PersistentVolume、CSI、ConfigMap、Secret |
| 集群资源 | Namespace、Node、Role、ClusterRole、RoleBinding、ClusterRoleBinding |
| 元数据资源 | HPA（HorizontalPodAutoscaler）、PodTemplate、LimitRange |
**强调**：我们通常不会只拉起一个裸pod（怎么叫裸pod就是没有任何管理者的pod，注意静态pod是有管理者的它的管理者是kubelet）
#### 什么是静态Pod
**静态 Pod** 是指由 **kubelet 直接管理、不经过 API Server** 的 Pod。kubelet 会自动监听节点上的固定目录：
```bash
/etc/kubernetes/manifests/
```
往这个目录放 YAML 文件，kubelet 就自动创建对应 Pod；改文件自动重启；删文件自动删除。整个生命周期由 kubelet 管理，不经过 API Server。
| 对比项 | 普通 Pod | 静态 Pod |
|--------|---------|---------|
| 管理者 | Deployment、ReplicaSet 等控制器 | **kubelet** |
| 创建方式 | `kubectl apply -f xxx.yaml` | 文件放进 manifests 目录 |
| 能否 `kubectl delete` | 能 | **不能**（kubelet 会重建） |
| 名字特征 | 随机后缀 | **后面带节点名**（如 `kube-apiserver-master01`） |
**为什么存在（自举）**：控制面组件 apiserver、etcd 等本身也是容器，但需要 API Server 才能创建——集群初始化时 API Server 还不存在，怎么办？静态 Pod 绕开这个死循环：**kubelet 直接读文件拉起控制面，不依赖 API Server**。所以 `kubectl get pods -n kube-system` 里名字带节点名后缀的就是静态 Pod。
**两个坑**：
```bash
# 1. 删不掉：kubectl delete 会被 kubelet 立刻重建，只能删源文件
rm /etc/kubernetes/manifests/kube-apiserver.yaml
# 2. 改不了：kubectl edit 改的是副本，会被覆盖回去，要改就改源文件
vim /etc/kubernetes/manifests/kube-apiserver.yaml   # 保存后 kubelet 自动重启
```
小结：**静态 Pod = kubelet 根据 manifests 目录文件自动管理的 Pod**，不经过 API Server、删不掉、只能改文件控制，核心用途是自举控制面组件。


### 节点污点（哪些物理节点不被调度）
#### 什么是污点（Taint）
污点是打在 Node 上的标记，告诉调度器："这个节点有特殊要求，普通 Pod 别往我这放"。  
默认情况下，调度器会把 Pod 分配到任意满足条件的节点。但有些节点"不欢迎"普通 Pod，比如：  
- 主节点：要跑控制面组件，不希望被业务 Pod 打扰
- 专用节点：只跑 GPU 任务，不希望普通任务来抢资源
- 故障节点：磁盘要坏了，别再往这调度了
**污点就是实现这种"拒绝/限制调度"的机制**。
| effect | 中文理解 | 对未调度 Pod | 对已在跑的 Pod |
| --- | --- | --- | --- |
| NoSchedule | 一定不被调度 | 新 Pod 不调度过来 | 不影响 |
| PreferNoSchedule | 尽量不被调度 | 尽量不调度（资源不足时可能调过来） | 不影响 |
| NoExecute | 驱赶 | 新 Pod 不调度过来 | 驱逐节点上已有的、不容忍的 Pod |

```bash
kubectl get nodes

| NAME | STATUS | ROLES | AGE | VERSION |
|------|--------|-------|-----|---------|
| k8s-master-01 | Ready | control-plane | 6h25m | v1.30.3 |
| k8s-node-01 | Ready | <none> | 6h24m | v1.30.3 |
| k8s-node-02 | Ready | <none> | 6h24m | v1.30.3 |

### 查看节点污点

kubectl describe node k8s-master-01 | grep Taints
kubectl describe node k8s-node-01 | grep Taints
kubectl describe node k8s-node-02 | grep Taints

主节点默认带污点：

Taints: node-role.kubernetes.io/control-plane:NoSchedule

### 打污点 / 去掉污点

# 打污点
kubectl taint nodes 10.1.1.104 node-role.kubernetes.io/control-plane:NoSchedule

# 去掉污点（末尾加 -）
kubectl taint nodes 10.1.1.104 node-role.kubernetes.io/control-plane:NoSchedule-

# 打 NoExecute 污点
kubectl taint nodes 10.1.1.104 node-role.kubernetes.io/master:NoExecute

# 去掉 NoExecute 污点
kubectl taint nodes 10.1.1.104 node-role.kubernetes.io/master:NoExecute-

### 污点语法速记
kubectl taint nodes <节点名> <key>:<value>:<污点策略>
# 去掉污点：在最后加一个减号 -
```
#### 容忍度（Toleration）
容忍度写在 Pod 的 spec.tolerations 里，声明"我能容忍哪些污点"。  
**写法一：精确匹配（指定 key、value、effect）**：  
```yaml
tolerations:
- key: "node-role.kubernetes.io/control-plane"
  operator: "Equal"      # Equal = 精确匹配 key 和 value
  value: ""              # 必须和污点 value 一致
  effect: "NoSchedule"   # 必须和污点 effect 一致,	不写 effect 则容忍该 key 的所有 effect
```
**写法二：存在即容忍（只关心 key，不看 value）**
```yaml
tolerations:
- key: "node-role.kubernetes.io/control-plane"
  operator: "Equal"      # Equal = 精确匹配 key 和 value
  value: ""              # 必须和污点 value 一致
  effect: "NoSchedule"   # 必须和污点 effect 一致,	不写 effect 则容忍该 key 的所有 effect
```

### pod调度策略
（pod应该调度在哪些物理节点上），注意，污点的优先级更高    
- 根据资源。Pod声明的requests和limits，前者就是Pod需要多少资源，后者表示Pod最多用多少资源，资源比如CPU内存等
- 指哪打哪。节点标签选择器，会选择符合标签的节点进行调度
- 同上。节点亲和性，分为硬亲和和软亲和，前者必须满足，后者尝试满足，不强制
#### 1、requests和limits，修改web.yaml文件的resources: {}配置项
```yaml
resources:
    requests:
        memory:"3Gi"#声明需要3G内存
    limits:
        memory:"4Gi"#声明最大4G内存
[root@master01~]#kubectlapply-fweb.yaml
查看Pod，发现Pod一直在挂起状态中
这是为什么？因为我声明的需要3G内存，而我的虚拟机最多就2G内存，所以资源不满足，影响了Pod调度，更多详细内容请参考官方文档：Pod和容
器的资源请求和约束
```
#### 2、节点标签选择器
```yaml
为node02上打标签,就是键值对，随便起名字
kubectl label node10.1.1.104 xxx=yyy


然后在web.yaml中新增nodeSelector声明
[root@master01~]#catweb.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  creationTimestamp: null
  labels:
    app: web
  name: web
spec:
  replicas: 1
  selector:
    matchLabels:
      app: web
  strategy: {}
  template:
    metadata:
      creationTimestamp: null
      labels:
        app: web
    spec:
      containers:
      - image: nginx:1.14
        name: nginx
      nodeSelector:
        xxx: yyy
  status: {}
```
#### 3、节点亲和性(亲和性和节点选择器类似，只不过多了操作符表达式：In、NotIn、Exists、Gt、Lt)
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: node-affinity
  labels:
    app: node-affinity
spec:
  replicas: 8
  selector:
    matchLabels:
      app: node-affinity
  template:
    metadata:
      labels:
        app: node-affinity
    spec:
      containers:
      - name: nginx
        image: nginx:1.7.9
        ports:
        - containerPort: 80
          name: nginxweb
      affinity:
        nodeAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:  # 硬策略
            nodeSelectorTerms:
            - matchExpressions:
              - key: kubernetes.io/hostname
                operator: NotIn
                values:
                - xxx-node3
          preferredDuringSchedulingIgnoredDuringExecution:  # 软策略
          - weight: 1
            preference:
              matchExpressions:
              - key: com
                operator: In
                values:
                - yyy-zzz-mmm

[root@master01~]#
上面的亲和性表示如下含义
requiredDuringSchedulingIgnoredDuringExecution：硬亲和，test123_env等于dev或者test，必须满足
preferreDuringSchedulingIgnoredDuringExecution：软亲和，group等于ttttest，非必须满足
K8S搞这么多策略有啥用呢？又是节点污点、节点标签、Pod调度策略之类的，目的当然是提供最大的灵活性，最终提高整体资源利用率，这就是自动
装箱
此外强调：
preferredDuringSchedulingIgnoredDuringExecution和requiredDuringSchedulingIgnoredDuringExecution名字中后半段字符串
IgnoredDuringExecution表示的是，在Pod资源基于节点亲和性规则调度到某个节点之后，如果节点的标签发生了改变，调度器不会讲Pod对象从
该节点上移除，因为该规则仅对新建会更新Pod有效。
```

### Secret和配置管理
secret在K8S中表示一个存储在etcd中的配置，通常用Base64编码，此配置可以通过挂载卷或者环境变量的方式供Pod访问   
通过下面的secret.yaml声明创建一个Secret，名字和密码是base64编码后的
```yaml
apiVersion:v1
kind:Secret
metadata:
    name:test-secret
    namespace:default
data:
    username:ZWdvbg==
    password:MTIzNDU2
```

挂载卷的方式，声明文件如下；  
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  creationTimestamp: null
  labels:
    app: test
  name: test
spec:
  replicas: 3
  selector:
    matchLabels:
      app: test
  strategy: {}
  template:
    metadata:
      creationTimestamp: null
      labels:
        app: test
    spec:
      containers:
      - image: alpine
        name: alpine
        args: ["sleep", "36000"]
        # 挂载到容器内
        volumeMounts:
        #xxx是占位符而已，和下面卷声明的一样就行
        - name: xxx
          mountPath: /etc/secret-volume
      # 卷声明
      volumes:
      - name: xxx
        secret:
          secretName: test-secret
  status: {}
```
验证上述文件
```bash
kubectl apply -f test.yaml
# 进入容器（先到对应的节点上）
docker container exec -ti 9023b9cfa886 sh
# 查看挂载的 Secret 文件
cat /etc/secret-volume/username   # 显示 egon
cat /etc/secret-volume/password   # 显示 123456
```



### ConfigMap
**ConfigMap** 用于把**非敏感配置**（配置文件、环境变量、参数）从镜像里抽出来，实现**配置与代码分离**——改配置不用重新构建镜像。
#### 创建方式
```yaml
# app-config.yaml：用 YAML 声明 ConfigMap，apply 管理
apiVersion: v1
kind: ConfigMap
metadata:
  name: app-config
data:
  DB_HOST: "10.0.0.1"
  DB_PORT: "3306"
```
```yaml
# nginx-conf.yaml：整个配置文件作为 key 塞进去
apiVersion: v1
kind: ConfigMap
metadata:
  name: nginx-conf
data:
  nginx.conf: |
    server {
        listen 80;
        server_name example.com;
    }
```
```bash
# apply 部署（重复执行不会报错，这就是声明式的优势）
kubectl apply -f app-config.yaml
kubectl apply -f nginx-conf.yaml
```
也可以用 `kubectl create ... --dry-run=client -o yaml` 生成 YAML 模板再改（让 kubectl 帮你写对格式）：
```bash
kubectl create configmap app-config --from-literal=DB_HOST=10.0.0.1 --dry-run=client -o yaml > app-config.yaml
kubectl create configmap nginx-conf --from-file=nginx.conf --dry-run=client -o yaml > nginx-conf.yaml
```
#### 使用方式
```yaml
# 方式一：注入为环境变量
env:
- name: DB_HOST
  valueFrom:
    configMapKeyRef:
      name: app-config
      key: DB_HOST

# 方式二：挂载为文件（最常用，改配置不用改镜像）
volumes:
- name: conf
  configMap:
    name: nginx-conf
```
```yaml
volumeMounts:
- name: conf
  mountPath: /etc/nginx/nginx.conf
  subPath: nginx.conf        # 挂单文件，避免整个目录被覆盖
```
#### 应用场景
| 场景 | 说明 |
|------|------|
| 多环境配置 | 同一个镜像 + 不同 ConfigMap（dev/prod），不用各打一个镜像 |
| 配置文件管理 | Nginx、application.yml 等挂载进容器 |
| 环境变量注入 | 数据库地址、端口、开关标志、日志级别 |
#### 注意事项
- ConfigMap 必须**先创建**再部署 Pod，否则 Pod 报 `CreateContainerConfigError`
- 环境变量注入的配置**修改后不会自动生效**，需 `kubectl rollout restart deployment xxx`
- 挂载成卷的文件会自动同步更新（秒级延迟），配合热加载可实现不停机改配置
- **敏感信息用 Secret，不用 ConfigMap**


### 存储编排
Pod是由容器组成，Pod挂掉数据则丢失，想永久保存则需要为pod关联持久存储，为了让你能更方便的为pod关联持久存储，k8s提供了两
个资源
- PV：PersistentVolume，持久化卷，用于声明底层存储类型，关联的是底层存储，可以是本地磁盘，也可以是网络磁盘比如NFS、
Ceph之类
- PVC：PersistentVolumeClaim，持久化卷声明，用于上层pod定制自己的对存储的需求参数，例如大小（不关心底层存储是什么）
总结：
- 1、pv负责对接底层存储，屏蔽底层不同存储设备的差异
- 2、pvc负责对接pv，屏蔽pv的差异
PV说白了就是一层存储的抽象，底层的存储可以是本地磁盘，也可以是网络磁盘比如NFS、Ceph之类，既然有了PV那为什么又要搞一个PVC呢？  
PVC其实在Pod和PV之前又增加了一层抽象，这样做的目的在于将Pod的存储行为于具体的存储设备解耦，试想一下，假设哪天NFS网络存储
的IP地址变化了，如果没有PVC，就需要每个Pod都改一下IP的声明，那得多累，有PVC来屏蔽这些细节之后只用改PV即可！只需要变更PV
即可，POD对存储的需求参数都放在PVC里根本不需要变动，如此，便十分灵活
创建PVC之后，Kubernetes就会去查找满足我们声明要求的PV，如果满足要求就会将PV和PVC绑定在一起，目前PV和PVC之间是一
对一绑定的关系，也就是说一个PV只能被一个PVC绑定
如此，便可以极大地解开了耦合，管理分工明确


### 存储方式
#### 本地存储hostPath
**创建PV：首先声明一个PV.yaml，内容如下，声明的本地存储路径为/data/hostpath**  
```yaml
apiVersion: v1
kind: PersistentVolume
metadata:
  name: my-pv
  labels:
    type: local
spec:
  storageClassName: manual
  capacity:
    storage: 1Gi
  accessModes:
  - ReadWriteMany
  hostPath:            # 声明本地存储，绑定该 pv 的 pod 调度到目标主机后，默认会自动创建出该路径
    path: /data/hostpath


kubectl apply -f PVC.yaml创建后  

NAME   CAPACITY   ACCESS MODES   RECLAIM POLICY   STATUS      CLAIM   STORAGECLASS   REASON   AGE
my-pv  1Gi        RWX            Retain           Available           manual                  39s

可以看到创建成功，并且状态是Available，说明还没有被PVC绑定，注意声明的hostPath会在pod被调度到目标主机之后默认自动创建
```
PV的关键参数解释:  
- Capacity（存储能力）：一般来说，一个PV对象都要指定一个存储能力，通过PV的capacity属性来设置的，目前只支持存储空间的
设置，就是我们这里的storage=1Gi，不过未来可能会加入IOPS、吞吐量等指标的配置。  
- AccessModes（访问模式）：用来对PV进行访问模式的设置，用于描述用户应用对存储资源的访问权限，访问权限包括下面几种方式  
    - ReadWriteOnce（RWO）：读写权限，但是只能被单个节点挂载
    - ReadOnlyMany（ROX）：只读权限，可以被多个节点挂载
    - ReadWriteMany（RWX）：读写权限，可以被多个节点挂载

**创建PVC**
```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: my-pvc
spec:
  storageClassName: manual
  accessModes:
  - ReadWriteMany
  resources:
    requests:
      storage: 1G


创建后
[root@master01 ~]# kubectl get pvc
NAME     STATUS   VOLUME   CAPACITY   ACCESS MODES   STORAGECLASS   AGE
my-pvc   Bound    my-pv    1Gi        RWX            manual         13s

[root@master01 ~]# kubectl get pv
NAME    CAPACITY   ACCESS MODES   RECLAIM POLICY   STATUS   CLAIM            STORAGECLASS   REASON   AGE
my-pv   1Gi        RWX            Retain           Bound    default/my-pvc   manual                  3m36s

可以看到PV的状态变成了Bound，说明PV被PVC绑定了（注意：创建PVC之后，Kubernetes就会去查找满足我们声明要求的PV，比如
storageClassName、accessModes以及容量这些是否满足要求，如果满足要求就会将PV和PVC绑定在一起，目前PV和
PVC之间是一对一绑定的关系，也就是说一个PV只能被一个PVC绑定
```
**最后通过如下web-test.yaml声明创建deploy**
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  labels:
    app: web-test
  name: web-test
spec:
  replicas: 1
  selector:
    matchLabels:
      app: web-test
  strategy: {}
  template:
    metadata:
      labels:
        app: web-test
    spec:
      containers:
      - image: nginx:1.14
        name: nginx
        # 挂载到容器内
        volumeMounts:
        - name: wwwroot
          mountPath: /usr/share/nginx/html
      # PVC 声明
      volumes:
      - name: wwwroot
        persistentVolumeClaim:
          claimName: my-pvc   # POD 关联的是 PVC，而不管 PV 是谁
  status: {}


[root@master01 ~]# kubectl get deploy,pods -o wide | grep web-test
deployment.apps/web-test   1/1   1   1   12m11s   nginx   nginx:1.14   app=web-test
pod/web-test-88bc96645-8mrgd   1/1   Running   0   2m11s   10.2.73.23   10.1.1.103   <none>   <none>

# 此声明将 Pod 内的 /usr/share/nginx/html 绑定到主机的 /data/hostpath（通过 PV 声明的）
# 如果此时访问一下 nginx 会报 403 Forbidden 错误，因为主机内的 /data/hostpath/index.html 并不存在
# 先创建一个（注意：Pod 在哪个节点上就在哪个节点上创建）
cat > /data/hostpath/index.html <<EOF
Hello egon
EOF

# 然后验证
[root@node02 ~]# curl 10.2.73.23
Hello egon
[root@node02 ~]#
```
#### 网络存储NFS
一般来讲，不会通过本地存储来持久化数据，因为Pod的调度不是固定的，一般会通过网络的方式来存储数据，比如NFS。我们可以新增一台服务器(192.168.88.100)作为NFS服务器  
只需要改PV.yaml
```yaml
apiVersion: v1
kind: PersistentVolume
metadata:
  name: my-pv
  labels:
    type: remote
spec:
  storageClassName: manual
  capacity:
    storage: 1Gi
  accessModes:
  - ReadWriteMany
  nfs:
    path: /data/nfs#NFS服务器的共享路径
    server: 192.168.88.100
```


### 服务发现与负载均衡
Service 的定位：**给一组 Pod 提供稳定的访问入口**。Pod 的 IP 是临时的（删了重建就变），但 Service 的 IP 是稳定的——客户端只认 Service，不用关心后端 Pod 是谁、在哪、什么时候换过。
#### Service 和 kube-proxy 的关系
- Service 资源本身由 **API Server 管理**（创建、存储、查询都在 etcd 里）
- Service 的**转发功能由 kube-proxy 实现**：kube-proxy 在每个节点上监听 Service/Endpoints 的变化，把"转发意图"翻译成 iptables/ipvs 规则，流量才能真正到达 Pod
- 类比：Service 是"红绿灯设备"（归 API Server 管），kube-proxy 是"交警"（负责让红绿灯真正工作）
- **kube-proxy 挂了，Service 还在但访问不通**——`kubectl get svc` 正常，curl ClusterIP 却失败
#### Service 使用案例
写两个 YAML 文件：Deployment 和 Service
```yaml
# web-deploy.yaml：先部署一组 Pod（3 个副本）
apiVersion: apps/v1
kind: Deployment
metadata:
  labels:
    app: web
  name: web
spec:
  replicas: 3
  selector:
    matchLabels:
      app: web
  template:
    metadata:
      labels:
        app: web
    spec:
      containers:
      - image: nginx:1.14
        name: nginx
```
```yaml
# web-svc.yaml：创建 Service 暴露 80 端口
apiVersion: v1
kind: Service
metadata:
  name: web
spec:
  selector:          # 标签选择器：给哪些 Pod 转发
    app: web
  ports:
  - port: 80         # Service 对外端口
    targetPort: 80   # 后端 Pod 的端口
  type: ClusterIP    # 默认类型
```
```bash
# apply 部署（声明式，重复执行不会报错）
kubectl apply -f web-deploy.yaml
kubectl apply -f web-svc.yaml

# 查看 Service 分配的 ClusterIP
kubectl get svc web

# 访问验证
curl 10.96.0.5:80          # 集群内访问 ClusterIP
curl web:80                # 集群内用 DNS 名访问（更方便）
```
#### Service 的三种类型
| 类型 | 作用 | 访问方式 |
|------|------|---------|
| ClusterIP（默认） | 集群内部访问 | 只能在集群内通过 ClusterIP 或 DNS 访问 |
| NodePort | 暴露到集群外 | 每个节点上开一个端口，`节点IP:NodePort` 即可访问 |
| LoadBalancer | 云平台负载均衡 | 云厂商分配公网 IP，流量经负载均衡器进来 |
```yaml
# web-svc-nodeport.yaml：把 Service 暴露到节点端口
apiVersion: v1
kind: Service
metadata:
  name: web
spec:
  selector:
    app: web
  ports:
  - port: 80
    targetPort: 80
    nodePort: 31234     # 节点端口范围 30000-32767，不写则由 K8s 随机分配
  type: NodePort
```
```bash
kubectl apply -f web-svc-nodeport.yaml
kubectl get svc web
# 输出 PORT(S) 列：80:31234/TCP  → 任意节点 IP:31234 都能访问
```
#### 不同 Pod 基于 Service 通信
Pod 之间直接互访是不可靠的（IP 会变），正确做法是通过 Service 名互相访问：
```text
pod-a (前端) ──请求 web:80──> Service web (ClusterIP 10.96.0.5)
                                 │ kube-proxy 转发
                                 ├──> pod-b-1 (app=web)
                                 ├──> pod-b-2 (app=web)
                                 └──> pod-b-3 (app=web)
```
- 前端 Pod 只需知道 Service 名 `web`，DNS 会自动解析成 ClusterIP
- Service 根据 `selector: app=web` 找到后端 Pod，自动做负载均衡（轮询）
- 后端 Pod 增减、IP 变化，Service 无感知地继续转发——这就是"服务发现"
#### kube-proxy 的工作模式
| 模式 | 原理 | 特点 |
|------|------|------|
| iptables（默认） | 用 iptables 规则转发 | 简单可靠，性能一般 |
| ipvs | 用内核 IPVS 模块 | 性能好、支持多种负载均衡算法（rr/wrr/lc 等），大集群推荐 |
| userspace（已废弃） | 用户态代理 | 老古董，性能最差 |
#### 细节知识
- **DNS 服务发现**：集群内置 CoreDNS，任何 Service 自动获得 `服务名.命名空间.svc.cluster.local` 域名，同命名空间内直接用服务名即可
- **Endpoints**：Service 通过 Endpoints 对象记录"当前有哪些后端 Pod IP"。`kubectl get endpoints web` 可查看
- **无头服务（Headless Service）**：`clusterIP: None` 的 Service 不分配 ClusterIP，DNS 直接返回所有 Pod IP，配合 StatefulSet 给每个 Pod 一个稳定域名（如 `pod名.服务名`）
- **端口命名**：如果 Service 要绑定多个端口，端口必须命名，否则 Kubernetes 1.20+ 会拒绝创建
- **selector 匹配不上**：如果后端 Pod 标签对不上，Service 的 Endpoints 为空，访问会失败——`kubectl describe svc web` 的 Endpoints 列为空即是此问题


### 自我修复
故障的分类：
- 1、副本数预期是3个，但是某个pod挂掉了，导致副本数比预期的少，需要调谐-----》控制器，例如deployment控制器
- 2、副本数没有变化，某一个pod中的容器进程挂掉了------------------》引入pod的重启机制
- 3、副本数没有变化、pod内的容器进程也没有挂掉依然在running运行着，但是对外无法提供服务----》引入Pod的健康检查（检查完之后采
取的动作分为两类，一类从service中清理掉本pod的代理，另外一类则是干脆触发重启pod）
#### Pod重启机制
当Pod异常停止时，就会触发Pod的重启机制，根据重启策略会表现出不同的行为。
重启策略主要分为以下三种
- Always：当容器终止退出后，总是重启容器，默认策略（spec.restartPolicy: Always）
- OnFailure：当容器异常退出（退出状态码非0）时，才重启
- Never：当容器终止退出，从不重启容器
| 对比维度 | restartPolicy: Always（重启策略） | Deployment 控制器（副本维护） |
| --- | --- | --- |
| 作用对象 | Pod 内部的容器 | 整个 Pod |
| 谁来执行 | kubelet | controller-manager（通过 ReplicaSet） |
| 触发条件 | 容器进程崩溃/异常退出 | Pod 整个消失（被删、节点宕机、被驱逐） |
| 动作 | 在同一个 Pod 里重启那个容器 | 创建一个全新的 Pod（新名字、新 IP） |
| Pod 会变吗 | 不变，Pod 还是原来那个 | 变，是另一个 Pod |
#### Pod健康检查
健康检查顾名思义就是检查Pod是否健康，怎么来定义健康呢?下述两种情况下服务均无法访问，为不健康状态
- 1、当程序内部发生了错误已经不能对外提供服务了，但此时主程序仍在运行，这种情况就是不健康的
- 2、当容器主进程已经启动了，但是服务还没有准备好，这种情况也是不健康的
这就需要从应用层面来检查，K8S中定义了两种检查机制  
- livenessProbe：存活检查，如果检查失败，将杀死容器，根据Pod的restartPolicy来操作
- readinessProbe：就绪检查，如果检查失败，Kubernetes会把Pod从Service endpoints中剔除，也就是让客户流量不打到
- readinessProbe检查失败的Pod上
具体的检查方式支持三种  
- http Get：发送HTTP请求，返回200 - 400范围状态码为成功
- exec：执行Shell命令返回状态码是0为成功
- tcpSocket：发起TCP Socket建立成功
实战思路：  
- 1、备一个多个副本的Deployment和一个Service
- 2、在Pod容器里面准备一个/tmp/healthy用于响应就绪检查和存活检查，其中一个副本设置为不健康（exec方式命令执行失败）
- 3、检查两个事情：  
一是检查非健康容器是否根据restartPolicy重启   
二是检查通过Service是否能访问到非就绪的容器。  
**health-test.yaml**：
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  labels:
    app: health-test
  name: health-test
spec:
  replicas: 3
  selector:
    matchLabels:
      app: health-test
  strategy: {}
  template:
    metadata:
      labels:
        app: health-test
    spec:
      containers:
        - image: nginx:1.14
          name: nginx
          # 就绪检查
          readinessProbe:
            exec:
              command:
                - cat
                - /tmp/healthy1
            # 初始化检查延迟时间
            initialDelaySeconds: 90
            # 隔多少秒检查一次（检查间隔）
            periodSeconds: 5
          # 存活检查
          livenessProbe:
            exec:
              command:
                - cat
                - /tmp/healthy2
            # 初始化检查延迟时间，一般设置比就绪检查的该时间大一点
            initialDelaySeconds: 95
            # 隔多少秒检查一次（检查间隔）
            periodSeconds: 5
          # 重启策略
          restartPolicy: Always
status: {}
```


### 自动上线与回滚
Kubernetes会分步骤地将针对应用或其配置的更改上线，同时监视应用程序运行状况以确保你不会同时终止所有实例。如果出现问题，
Kubernetes会为你回滚所作更改。你应该充分利用不断成长的部署方案生态系统。  
#### 升级
实战思路：创建一个多副本的Deployment和一个Service，不断的访问Service，然后更改镜像版本，查看Service是否停止服务
**nginx-balance.yaml**  
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  labels:
    app: nginx-balance
  name: nginx-balance
spec:
  replicas: 3
  selector:
    matchLabels:
      app: nginx-balance
  strategy: {}
  template:
    metadata:
      labels:
        app: nginx-balance
    spec:
      containers:
        - image: nginx:1.14
          name: nginx
status: {}
```
**service.yaml**
```yaml
apiVersion: v1
kind: Service
metadata:
  labels:
    app: nginx-balance
  name: nginx-balance
spec:
  ports:
    - port: 8080
      protocol: TCP
      targetPort: 80
  selector:
    app: nginx-balance
  type: NodePort
status:
  loadBalancer: {}
```
**升级流程**：
1. 创建 Deployment 和 Service，确认 3 个副本全部就绪
```bash
kubectl apply -f nginx-balance.yaml -f service.yaml
kubectl get pods -o wide
kubectl get svc
```
2. 在一个终端里循环访问 Service（模拟持续不断的请求）
```bash
# NodePort 端口以 kubectl get svc 输出的 PORT(S) 为准，这里假设 30080
while true; do curl -I -m 2 http://<任意节点IP>:30080; sleep 0.5; done
```
3. 在另一个终端触发滚动升级：把镜像从 nginx:1.14 改成 nginx:1.15
```bash
kubectl set image deployment nginx-balance nginx=nginx:1.15
kubectl rollout status deployment nginx-balance
```
4. 边升级边观察 Pod 的交替过程
```bash
kubectl get pods -w
```
结论：
- 升级过程是**滚动式**的：先启动一个新 Pod，等它就绪后，再下线一个旧 Pod，逐个替换（新旧 ReplicaSet 交替扩容/缩容）。
- 因为永远不会同时终止所有实例，Service 始终有可用后端，所以第 2 步的循环访问**全程不中断**——这就是"自动上线"不停服的原因。
- 默认更新策略是 RollingUpdate，`strategy: {}` 等价于不写（走默认值），控制参数如下：
```yaml
strategy:
  type: RollingUpdate
  rollingUpdate:
    maxSurge: 1        # 升级时最多允许多出的新 Pod 数（数字或百分比）
    maxUnavailable: 0  # 升级时允许同时不可用的旧 Pod 数（0 表示必须保证至少一个可用）
```

#### 回滚
**回滚实战**（接着上面的升级继续）：
1. 查看发布历史，确认现在处于哪个 revision
```bash
kubectl rollout history deployment nginx-balance
```
2. 回滚到上一个版本（撤销刚才的升级）
```bash
kubectl rollout undo deployment nginx-balance
kubectl rollout status deployment nginx-balance
```
3. 回滚到指定版本（比如最初部署的 nginx:1.14）
```bash
kubectl rollout undo deployment nginx-balance --to-revision=1
```
**回滚原理**：
- 每次修改 Deployment 的 spec（如镜像版本）都会生成一个新的 ReplicaSet，`rollout history` 里看到的就是这些历史 ReplicaSet。
- 回滚的本质是让控制器把 Pod 的 `pod-template-hash` 指回旧的 ReplicaSet，重新创建对应版本的副本。
- 回滚同样走滚动更新策略，因此也不会停服。
- 历史版本默认最多保留 10 个，由 `spec.revisionHistoryLimit: 10` 控制。
- 给每个版本加上变更备注，回滚时方便辨认：
```bash
kubectl annotate deployment nginx-balance kubernetes.io/change-cause="升级镜像到 nginx:1.15"
```
其他常用命令：
```bash
kubectl rollout pause deployment nginx-balance    # 暂停滚动，先观察新 Pod 是否健康
kubectl rollout resume deployment nginx-balance   # 恢复滚动
```

## 补充

### Service 端口详解（8080 vs 30080 的疑惑）
一次完整的访问链路：
```text
客户端
  │  curl http://<节点IP>:30080
  ▼
节点上的 nodePort 30080（NodePort 类型自动分配的端口）
  ▼
Service ClusterIP :8080（spec.ports[].port，集群内用 nginx-balance:8080 访问）
  ▼
Pod IP :80（spec.ports[].targetPort，转发给 Pod 里 nginx 实际监听的端口）
  ▼
nginx 容器
```
| 字段 | 名称 | 作用 | 访问方式 |
| --- | --- | --- | --- |
| port | Service 端口 | Service 自己的端口（ClusterIP 上监听），集群内入口 | 集群内 `curl nginx-balance:8080` |
| targetPort | 目标端口 | 流量转发到 Pod 内容器实际监听的端口 | 由 kube-proxy 转发，无需直接访问 |
| nodePort | 节点端口 | 暴露在每个节点上，供集群外部访问，范围 30000-32767 | 集群外 `curl <节点IP>:30080` |

要点：
- `port` 是 Service 的端口、`targetPort` 是容器的端口、`nodePort` 是节点的端口，三者可以各不相同。
- 不写 `targetPort` 时默认等于 `port`；不写 `nodePort` 时由 K8s 在 30000-32767 内自动分配。
- 实验里 curl 访问的是**自动分配的 nodePort**（假设 30080），所以不是 8080。
- 想固定就显式声明 `nodePort: 30080`。
- 只有 `type: NodePort` 或 `LoadBalancer` 才有 nodePort；`ClusterIP` 类型只有 port/targetPort。
- `selector` 决定流量转发给哪些 Pod（按标签匹配）。

### web-deploy.yaml 逐字段详解
```yaml
# web-deploy.yaml：先部署一组 Pod（3 个副本）
apiVersion: apps/v1
kind: Deployment
metadata:
  labels:
    app: web
  name: web
spec:
  replicas: 3
  selector:
    matchLabels:
      app: web
  template:
    metadata:
      labels:
        app: web
    spec:
      containers:
      - image: nginx:1.14
        name: nginx
```
| 字段 | 详细解释 | 举例 / 实战说明 |
| --- | --- | --- |
| `apiVersion` | API 版本号，告诉 K8s"我要创建哪种资源、按哪套规则校验"。格式是 `组/版本`；属于核心组（core）的资源（如 Service、Pod）省略组名，直接写 `v1`。Deployment 属于 apps 组，稳定版是 `apps/v1`，字段结构和校验规则都随版本走 | 写错版本 `kubectl apply` 直接报错|
| `metadata` | 资源的"身份证"。核心两个子字段：`name`（资源名，集群内唯一，后续所有命令都靠它引用）和 `labels`（标签，键值对，供 Selector 按标签批量找资源） | 同名 apply 是更新、换名是新建；`kubectl get all -l app=web` 按标签筛选出一批资源 |
| `selector` | Deployment 的"认领凭证"：`matchLabels` 声明"我只管理带 `app: web` 标签的 Pod"。它和 `template` 里的标签必须配对——template 决定"造出来的 Pod 贴什么标签"，selector 决定"我管带什么标签的 Pod" | 两者不一致 apply 直接校验失败；只改 selector 不改 template，Deployment 会认为旧 Pod 不属于自己，可能全部删掉重建 |
| `template` | Pod 模板，也就是 Deployment 造 Pod 用的"图纸"。里面的 `metadata` / `spec` 会原样拷贝给每个新 Pod（Pod 名字、IP 由系统自动生成，模板里的标签、容器、镜像等则由你定义） | 改镜像、加环境变量、加健康检查探针，全改这里；改完触发一次滚动更新 |
| `containers` | `template.spec.containers`：一个 Pod 内的容器列表，至少 1 个、可以多个（主进程 + sidecar）。每个容器至少要写 `name`（容器名，Pod 内唯一）和 `image`（镜像，`仓库:标签`） | 多容器时用 `kubectl exec <pod> -c <容器名>` 进入指定容器；升级/回滚本质就是改 `image` 后 apply 或用 `kubectl set image` |

两个最关键的"对应关系"（这个 yaml 的骨架逻辑）：
```
selector.matchLabels.app: web      ←── 选 Pod 用
template.metadata.labels.app: web ←── 造 Pod 时贴的标签
（两者必须一致，Deployment 才能"按标签找到自己造的 Pod"）

template 里的标签 app: web          ←── 也是 Service 转发流量的依据
Service.selector.app: web   →  只转发给贴了 app=web 标签的 Pod
```
一个容易踩的坑：如果 `template` 里的标签和 `selector.matchLabels` 不一致，apply 会直接报错；如果只改 `selector` 而不改 template，Deployment 会认为 Pod 全"不属于自己"，可能把新 Pod 全删了重建。所以这两个字段要一起动。
### 调谐与调度
调谐（Reconcile）和调度（Schedule）是两件不同的事：
- 调谐：由各类控制器（Deployment 控制器、ReplicaSet 控制器等）负责。控制器不断对比"期望状态 spec"和"实际状态 status"，发现不一致就驱动系统向 spec 收敛。比如前面讲的：副本数预期 3 个，某个 Pod 挂了，控制器发现实际比期望少 1 个，就重新创建一个补齐。
- 调度：由 kube-scheduler 负责，决定"新建的 Pod 放到哪个节点上运行"。Pod 创建后处于 Pending，调度器根据节点资源、节点亲和性、污点容忍等条件挑一个合适的节点。
一句话区分：**调谐管"数量对不对"，调度管"放哪台机器"。**

### spec与status
- `spec`（specification）：**期望状态**。就是你在 yaml 里写的"我想要什么"，比如 `replicas: 3`、`image: nginx:1.14`。声明式配置，由用户定义，控制器无权改它。
- `status`：**实际状态**。由控制器回填的"当前实际情况"，比如当前实际有几个副本、就绪几个、处于什么阶段。用户不用写也不用改，yaml 里的 `status: {}` 只是占位。
- 调谐循环：控制器读 spec → 对比 status → 执行动作（创建/删除/更新）→ 更新 status → 再来一遍，直到 status 与 spec 一致。
- 看 `kubectl get deployment` 的 DESIRED / CURRENT / READY 三列：DESIRED 来自 `spec.replicas`，CURRENT 和 READY 来自 `status` 里的 `replicas`、`readyReplicas`。
- 想看填充后的 status：`kubectl get deployment web -o yaml`，最下面的 `status:` 段就是控制器写好的实际状态。
