---
title: 基于k8s的CICD流程
published: 2026-09-21T23:11:23+08:00
description: 学习如何基于k8s部署，使用gitlab,jenkins或者argo-cd，harbor进行自动化的cicd
image: './images/a28.avif'
tags: [devops]
category: '计算机技术'
draft: false
lang: '中文'
---


## 流程概览
- 开发人员从 GitLab 仓库拉取代码进行开发
- 开发完成后提交并推送到 GitLab 仓库，通过 Merge Request 合并
- GitLab 通过 webhook 通知 Jenkins，Jenkins 拉取最新代码并进行测试构建，最后根据 Dockerfile 构建镜像，并推送到 Harbor 仓库
- Jenkins 更新 K8s 的部署配置（如 `kubectl set image`），kubelet 从 Harbor 拉取新镜像，K8s 自动完成部署


## 分支判断与发布
实际项目中不会只有一个分支，通常采用多分支策略，不同分支对应不同环境：
- `dev` / `feature` 分支：日常开发，合并 MR 时触发构建，只做编译和单元测试，不部署
- `test` 分支：构建镜像并打上 `test-<commit id>` 标签，自动部署到测试环境
- `main` 分支：构建正式版本镜像，部署到生产环境
### Jenkins 如何区分分支
在 Jenkinsfile 中通过 `when + branch` 指令判断触发流水线的分支，走不同的阶段：
### 关键设计点
1. **镜像标签策略**：生产环境避免使用 `latest` 标签，使用 git commit id 或版本号作为 tag，方便回滚到任意历史版本
2. **生产发布需人工审批**：Jenkins Pipeline的`input` 指令会让流水线暂停，等待管理员确认后再执行部署，避免测试不充分的代码直接上线
3. **环境隔离**：生产实践主流做法是测试集群与生产集群各部署一套，物理级隔离故障影响。企业里通常两者结合：生产独立成集群。


## 在工具集群中部署jenkins,gitlab,harbor
### 部署jenkins
完整 YAML 如下（单文件包含 PV/PVC、ConfigMap、Deployment、Service）：
```yaml
# 存储配置：单机版使用 hostPath 本地路径，需提前在主机创建目录并赋权
apiVersion: v1
kind: PersistentVolume
metadata:
  name: jenkins-pv
spec:
  capacity:
    storage: 5Gi
  accessModes: ["ReadWriteOnce"]
  persistentVolumeReclaimPolicy: Retain                #pvc删除后，pv的数据保留，之后不能被新PVC复用
  hostPath:
    path: /data/jenkins
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: jenkins-pvc
spec:
  accessModes: ["ReadWriteOnce"]
  resources:
    requests:
      storage: 5G
---
# Nginx 插件代理配置：将请求代理转发至清华源，加速插件下载
apiVersion: v1
kind: ConfigMap
metadata:
  name: nginx-conf
data:
  default.conf: |
    server {
      listen 80;
      location / {
        proxy_pass https://mirrors.tuna.tsinghua.edu.cn/jenkins/updates/;
      }
    }
---
# Sidecar 模式：同一 Pod 内 Jenkins + Nginx 两个容器
apiVersion: apps/v1
kind: Deployment
metadata:
  name: jenkins
spec:
  replicas: 1
  selector:
    matchLabels:
      app: jenkins
  template:
    metadata:
      labels:
        app: jenkins
    spec:
      containers:
      - name: jenkins
        image: jenkins/jenkins:lts-jdk11   #docker hub上用户自己的仓库镜像
        resources:
          requests:
            cpu: 500m           #0.5核
            memory: 1Gi
          limits:
            cpu: "2"
            memory: 2Gi
        readinessProbe:
          httpGet:
            path: /login
            port: 8080
          initialDelaySeconds: 60             #容器启动后60秒做第一次探测
          periodSeconds: 10                     #每10秒做一次探测
        volumeMounts:
        - name: jenkins-data
          mountPath: /var/jenkins_home
      - name: nginx
        image: nginx
        volumeMounts:
        - name: nginx-conf
          mountPath: /etc/nginx/conf.d
      volumes:
      - name: jenkins-data
        persistentVolumeClaim:
          claimName: jenkins-pvc
      - name: nginx-conf
        configMap:        #Nginx采用配置注入的方式，将配置从镜像中解耦出来。不用configmap，则每个环境都要搭不同的镜像，因为配置不一样。
          name: nginx-conf  #用 ConfigMap 则 镜像只有一份，换环境只换配置 。
---
# NodePort 暴露：7096->8080（Web 访问），50000->50000（Agent 通信）
apiVersion: v1
kind: Service
metadata:
  name: jenkins
spec:
  type: NodePort   #服务类型：在每个节点IP上开放端口供集群外访问（默认ClusterIP仅限集群内部访问）
  selector:
    app: jenkins
  ports:
  - name: web
    port: 8080    #Service自身端口：集群内其他Pod通过 jenkins:8080 访问
    targetPort: 8080   #目标端口：容器内Jenkins进程实际监听的端口（转发终点）
    nodePort: 7096    #节点对外端口：在每个节点的IP上开放，浏览器访问 节点IP:7096
  - name: agent     
    port: 50000      # jenkins主节点和从节点之间通信默认用的50000端口。
    targetPort: 50000
    nodePort: 50000
```
启动后进入 Jenkins → Manage Plugins → Advanced，把 Update Site 改为 `http://localhost/update-center.json`，插件下载就会经 Sidecar Nginx 走清华源。
#### 部署前环境准备
1. **创建本地存储目录**：在节点上创建 PV 对应的本地目录，并赋予可写权限，确保 Jenkins 容器能正常写入数据：
```bash
mkdir -p /data/jenkins
chown -R 1000:1000 /data/jenkins
```
2. **修改 K8s NodePort 端口范围**：默认范围为 30000-32767，而实验中使用的 7096 和 50000 超出此范围。编辑 API Server 配置文件 `/etc/kubernetes/manifests/kube-apiserver.yaml`，在启动参数中添加：
```yaml
- --service-node-port-range=1024-65535
```
#### 部署及获取初始密码
1. **应用 YAML 并确认 Pod 状态**：
```bash
kubectl apply -f jenkins.yaml
kubectl get pods -w
```
Pod 处于 `Running` 且 READY 为 `1/2`（包含 Jenkins 和 Nginx 两个容器，全部就绪才是 `2/2`）。
2. **查看容器日志获取初始管理员密码**：
```bash
kubectl logs <pod-name> -c jenkins
```
> 关键点：Pod 内有两个容器，必须用 `-c jenkins` 指定容器名，否则报 `a container name must be specified` 错误。日志中会打印初始密码。
#### 动态slave
相比于静态slave浪费大量资源，每一套构建,测试环境都要单独维护，哪怕暂时用不到，动态slave大大减少了资源的滥用。   
**动态Slave的实现原理：镜像拆分与组合**  
**小镜像策略**
不再制作单一的大镜像，而是将工具拆分为多个小镜像（零件）：   
- 基础镜像：仅安装Git。
- 测试镜像：仅安装代码测试工具。
- 部署镜像：安装Docker和Kubectl。
- 语言环境镜像：单独制作包含Java环境或Go环境的小镜像。
**K8S Pod的多容器特性**
- 利用K8S中一个Pod可启动多个Container的特性。
- 每个Container选择对应的小镜像，按需组合。
#### 动态Slave的工作流程
- 用户在流水线代码中声明所需的环境“零件”（镜像地址/Tag）。
- 提交代码给Master，告知其需要创建的Slave Pod规格。
- Master读取流水线代码，理解所需的“临时工”标准。
- 根据指令动态启动一个Slave Pod，并在其中运行指定的容器组合。
- Pod创建好后，运行流水线代码完成构建任务。
- 任务结束后，自动销毁该Slave Pod。
- 系统回归到仅有Master的状态，实现资源的按需使用和零闲置浪费。
#### 如何让jenkins可以自主创建slave pod
- 在jenkins里面下载Kubernetes 插件
- 给Jenkins Pod 挂一个 ServiceAccount，并用 RBAC 授权，这样api server才认可（这里的 ServiceAccount 用于插件调 API Server 创建 slave Pod，授权细节见文末「RBAC详解」）
- 按照jenkins里面创建从节点的配置生成符合k8s创建pod的yaml文件格式
- 创建从节点pod

### 部署gitlab
GitLab 无法单容器独立工作，完整服务由三件套组成，需**按顺序部署**：
```
Redis（缓存与后台队列） → PostgreSQL（数据库） → GitLab 本体（Web + SSH）
```
完整 YAML 如下（三个文件，镜像与账号密码为实验配置）：
```yaml
# ========== gitlab-redis.yaml：无需持久化（纯缓存角色） ==========
apiVersion: apps/v1
kind: Deployment
metadata:
  name: redis
spec:
  replicas: 1
  selector:
    matchLabels:
      app: redis
  template:
    metadata:
      labels:
        app: redis
    spec:
      containers:
      - name: redis
        image: sameersbn/redis:latest
        ports:
        - containerPort: 6379
---
apiVersion: v1
kind: Service
metadata:
  name: redis
spec:
  selector:
    app: redis
  ports:               #Redis 和 PostgreSQL 只需要“集群内部”被访问，不需要“集群外部”访问，默认ClusterIP模式
  - port: 6379
    targetPort: 6379
---
# ========== gitlab-postgresql.yaml：hostPath 持久化，需先建目录 ==========
apiVersion: apps/v1
kind: Deployment
metadata:
  name: postgresql
spec:
  replicas: 1
  selector:
    matchLabels:
      app: postgresql
  template:
    metadata:
      labels:
        app: postgresql
    spec:
      containers:
      - name: postgresql
        image: sameersbn/postgresql:latest
        ports:
        - containerPort: 5432
        env:
        - name: DB_NAME          # 数据库名，GitLab 写死要求 gitlabhq_production
          value: gitlabhq_production
        - name: DB_USER
          value: gitlab
        - name: DB_PASS          # 实验用固定密码，正式环境用 Secret 管理
          value: gitlab@123
        volumeMounts:
        - name: pgdata
          mountPath: /var/lib/postgresql
      volumes:
      - name: pgdata
        hostPath:
          path: /data/postgresql
---
apiVersion: v1
kind: Service
metadata:
  name: postgresql
spec:
  selector:
    app: postgresql
  ports:
  - port: 5432
    targetPort: 5432
---
# ========== gitlab.yaml：GitLab 本体，hostPath 持久化 ==========
apiVersion: apps/v1         
kind: Deployment
metadata:
  name: gitlab
spec:
  replicas: 1
  selector:
    matchLabels:
      app: gitlab
  template:
    metadata:
      labels:
        app: gitlab
    spec:
      containers:
      - name: gitlab
        image: sameersbn/gitlab:latest
        ports:
        - containerPort: 80      # Web（HTTP）
        - containerPort: 22      # SSH（git 克隆/推送）
        env:
        - name: GITLAB_HOST      # 对外域名，决定 clone 地址中显示的域名
          value: git.k8s.local
        - name: GITLAB_PORT
          value: "1180"
        - name: GITLAB_SSH_PORT
          value: "30022"
        - name: GITLAB_ROOT_PASSWORD   # 初始 root 密码
          value: egg@666
        - name: DB_HOST          # ↓ 以下环境变量预设好与上面 Redis/PG 的配套关系
          value: postgresql
        - name: DB_NAME
          value: gitlabhq_production
        - name: DB_USER
          value: gitlab
        - name: DB_PASS
          value: gitlab@123
        - name: REDIS_HOST
          value: redis
        - name: REDIS_PORT
          value: "6379"
        resources:
          requests:
            cpu: "1"
            memory: 2Gi
          limits:
            cpu: "2"
            memory: 4Gi          # GitLab 本体吃资源，给足内存
        volumeMounts:
        - name: gitlab-data
          mountPath: /home/git/data
      volumes:
      - name: gitlab-data
        hostPath:
          path: /data/gitlab
---
apiVersion: v1
kind: Service
metadata:
  name: gitlab
spec:
  type: NodePort
  selector:
    app: gitlab
  ports:
  - name: web
    port: 80
    targetPort: 80
    nodePort: 1180         # 浏览器访问 节点IP:1180
  - name: ssh
    port: 22
    targetPort: 22
    nodePort: 30022        # git clone git@... 走这个端口
```

#### 部署前环境准备
单节点集群无需考虑调度路径问题，直接在节点上创建两个存储目录：
```bash
mkdir -p /data/postgresql /data/gitlab
```
#### 部署及验证
按依赖顺序依次应用，每一步都等 Pod Ready 再进行下一个：
```bash
kubectl apply -f gitlab-redis.yaml
kubectl get pods -w          # redis Ready

kubectl apply -f gitlab-postgresql.yaml
kubectl get pods -w          # postgresql Running + Ready

kubectl apply -f gitlab.yaml
kubectl get pods -w          # GitLab 初始化较慢（拉镜像+初始化数据库），耐心等待
```

> 关键点：GitLab 首次启动要初始化数据库、迁移表结构，**Pod 长时间处于非 Ready 属正常现象**，不要误判为故障而反复重建。

#### 访问配置与验证
服务暴露的端口映射关系：
| 协议 | 容器端口 | NodePort | 用途                       |
| ---- | -------- | -------- | -------------------------- |
| HTTP | 80       | 1180     | 浏览器访问 Web 界面        |
| SSH  | 22       | 30022    | git clone/push（SSH 协议） |
未配置域名解析前，可先用 `节点IP:1180` 临时访问，账号 `root` 登录验证部署成功。
#### 为什么需要域名解析
登录后创建一个 `test` 项目，进入项目页查看 Clone 地址：
```
git@git.k8s.local:root/test.git      ← SSH 地址里带的是域名
http://git.k8s.local:1180/root/test.git
```
这个域名来自 GitLab 配置里的 `GITLAB_HOST=git.k8s.local`。开发人员会直接拷贝这些地址拉取/推送代码——手动把域名替换成节点 IP 虽然可行，但每人每次都改太繁琐。正确做法是给 `git.k8s.local` 添加域名解析，指向 K8s 节点 IP，让所有开发人员"拿来即用"。
#### 域名解析配置
目标：让 `git.k8s.local` 解析到节点 IP（如 `172.16.10.
```

**4. 安装并验证**：

```bash
helm install harbor . -n harbor --create-namespace
kubectl get pods -w -n harbor
```

等待所有 Pod Ready 后，浏览器访问 `externalURL`（`http://172.16.10.16:30002`），用 `admin` + `harborAdminPassword` 登录即部署成功。

> Pod 数量对比：internal 模式约 12 个 Pod（含内部 database/redis），external 模式约 10 个——复用中间件的效果直观可见。

#### 验证镜像推送

登录 Harbor UI 创建私有项目（如 `myproject`），在节点上测试：

```bash
docker login 172.16.10.16:30002
docker tag nginx 172.16.10.16:30002/myproject/nginx:v1
docker push 172.16.10.16:30002/myproject/nginx:v1    # 推送
docker pull 172.16.10.16:30002/myproject/nginx:v1    # 拉回验证
```

> 常见坑：HTTP 模式的 Harbor 会被 docker 拒绝，报 `http: server gave HTTP response to HTTPS client`——需在各节点 docker 配置 `insecure-registries` 加上 Harbor 地址后重启 docker。
16`），配合 NodePort 即可访问 GitLab。需要处理**两处解析**：
```
Jenkins（集群内）  → CoreDNS 负责解析（K8s 内部 DNS）
开发机（集群外）    → 本机 hosts 文件负责解析
```
**1. 配置 CoreDNS（集群内生效）**
编辑 CoreDNS 的 ConfigMap，用 `hosts` 插件添加解析记录：
```bash
kubectl -n kube-system edit configmap coredns
```
在 `Corefile` 中添加：
```yaml
data:
  Corefile: |
    .:53 {
        hosts {                     # ← 新增 hosts 插件
          172.16.10.16 git.k8s.local
          fallthrough
        }
        errors
        health
        ...
    }
```
> 为什么解析到节点 IP 而不是 Pod IP：Pod IP 会随重建变化，而节点 IP + NodePort 是稳定入口——和之前"Service 稳定地址"的思路一致。
**2. 重启 CoreDNS 使配置生效**
ConfigMap 挂载的文件更新后，CoreDNS **不会自动重新加载**，需重启 Pod。用 scale 降到 0 再恢复触发重建：
```bash
kubectl -n kube-system scale deployment coredns --replicas=0
kubectl -n kube-system scale deployment coredns --replicas=2
kubectl -n kube-system get pods      # 确认新 Pod Running
```
**3. 集群内验证**
创建一个常驻测试 Pod，进容器 ping 验证：
```yaml
# test-gitlab.yaml
apiVersion: v1
kind: Pod
metadata:
  name: test-gitlab
spec:
  containers:
  - name: centos
    image: centos:7
    command: ["tail", "-f", "/dev/null"]   # 保持运行，方便 exec 进入
```
```bash
kubectl apply -f test-gitlab.yaml
kubectl exec -it test-gitlab -- ping git.k8s.local
# 能解析出 172.16.10.16 → 集群内（Jenkins）可通过域名访问 GitLab
```
**4. 集群外开发机配置（hosts 文件）**
集群外的机器收不到 CoreDNS 的解析，需在各自 hosts 文件中添加相同记录：
Linux 开发机：
```bash
echo "172.16.10.16 git.k8s.local" >> /etc/hosts
ping git.k8s.local    # 验证
```
Windows 宿主机：以**管理员身份**编辑 `C:\Windows\System32\drivers\etc\hosts`，添加同样一行（非管理员会保存失败）。
**最终效果**：宿主机、开发机、集群内 Jenkins 均可通过 `git.k8s.local` 直接访问 GitLab，clone 地址复制即用，无需记忆节点 IP。
> 实践提示：hosts/CoreDNS 方案适合学习和固定几台机器的场景。机器多了应搭建统一 DNS（或用真实域名 + 云 DNS），否则每来一台新机器都要手动加 hosts。生产环境建议用真实域名（如 git.example.com）+ 正式 DNS 记录。
> 安全提示：文中账号密码均为实验环境演示值。真实环境的凭证应通过 Secret 管理，切勿写入文档或提交到仓库。

### 部署harbor
#### 第一步：存储准备（NFS Provider + StorageClass）
Harbor Chart 的持久化依赖 StorageClass 动态供给，不再手写 hostPath PV——需先搭 NFS 存储并部署 Provider。
**1. 搭建 NFS 服务**（单节点集群，直接装在节点上）：
```bash
# 安装并配置共享目录
apt install -y nfs-utils
mkdir -p /data/nfs/harbor
# /etc/exports 中暴露共享目录
/data/nfs/harbor 172.16.10.16/24(rw,no_root_squash)
# 启动并验证
systemctl enable --now nfs
```
> 多节点集群需在**所有可能挂载的节点**上装 nfs-utils，否则无法挂载；单节点可省。
**2. 部署 NFS Provider 并创建 StorageClass**：
```bash
kubectl create namespace harbor
kubectl apply -f nfs-provider.yaml   
kubectl apply -f harbor-storage-class.yaml
kubectl get sc     # 确认 StorageClass 创建成功
```
两个 YAML 的关键关联：
- Provider 的环境变量 `PROVISIONER_NAME=example.com/nfs`
- StorageClass 的 `provisioner: example.com/nfs`
**两者必须严格一致**，StorageClass 才知道找哪个 Provider 自动建卷。
##### NFS Provisioner
前面的 NFS 只是"有一个共享目录"，而 K8s 里的 PVC 要求**动态供给**：每建一个 PVC，就自动在 NFS 上切出一块空间、生成一个 PV 并绑定上去。负责干这件事的就是 NFS Provisioner（`nfs-subdir-external-provisioner`）——它像一个常驻的"库管员"，监听 StorageClass 声明的卷申请，收到就自动建卷。
两个文件各司其职：`nfs-provider.yaml` 部署"库管员"本身，`harbor-storage-class.yaml` 定义"申请规则"，两者靠一个标识名（provisioner）对接。
**`nfs-provider.yaml` 里主要包含什么**
这个文件一次把 Provisioner 跑起来所需的东西全建出来，分三类：
1. **RBAC（权限）**
   - `ServiceAccount`：Provisioner Pod 在集群里的身份。
   - `ClusterRole` + `ClusterRoleBinding`：PV 是**集群级**资源，需要集群级权限来创建/删除 PV、监听 PVC。
   - `Role` + `RoleBinding`：命名空间内的锁权限，多副本时靠它做 leader 选举，保证同一时刻只有一个实例真正建卷。
2. **Deployment（真正干活的容器）**，关键参数：
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: nfs-client-provisioner
  namespace: harbor
spec:
  replicas: 1                       # 多副本也能跑，靠 leader 选举择一
  template:
    spec:
      serviceAccountName: nfs-client-provisioner   # 绑定上面的 RBAC 身份
      containers:
      - name: nfs-client-provisioner
        image: registry.k8s.io/sig-storage/nfs-subdir-external-provisioner:v4.0.2
        env:
        - name: PROVISIONER_NAME
          value: example.com/nfs        # ★ 标识符，必须与 StorageClass 的 provisioner 严格一致
        - name: NFS_SERVER
          value: 172.16.10.16           # NFS 服务器地址
        - name: NFS_PATH
          value: /data/nfs/harbor       # NFS 共享导出路径
        volumeMounts:
        - name: nfs-client-root
          mountPath: /persistentvolumes # 容器内也要挂上 NFS，才能在其上建目录
      volumes:
      - name: nfs-client-root
        nfs:
          server: 172.16.10.16          # 与 NFS_SERVER 一致
          path: /data/nfs/harbor        # 与 NFS_PATH 一致
```
> 核心就三个环境变量：**`PROVISIONER_NAME`** 决定"我是谁"（供 StorageClass 点名），**`NFS_SERVER` / `NFS_PATH`** 决定"在哪个 NFS 共享上干活"。
**`harbor-storage-class.yaml` 里主要包含什么**
```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: harbor-storage-class        # ★ PVC / values.yaml 通过这个名字引用
provisioner: example.com/nfs        # ★ 点名由哪个 Provisioner 建卷，须与 PROVISIONER_NAME 一致
reclaimPolicy: Delete               # 删除 PVC 后 PV 的处置方式
allowVolumeExpansion: true          # 允许后续在线扩容
mountOptions:
  - nfsvers=4.1                     # 挂载参数：锁死 NFS 协议版本，避免兼容问题
parameters:
  archiveOnDelete: "true"           # ★ 删 PVC 时把目录改名归档（archived-xxx），不真删数据
```
**工作机制（以 Harbor 申请 registry 存储为例）**
Harbor 的 `values.yaml` 里写了 `registry.storageClass: harbor-storage-class`、`size: 5Gi`，Helm 据此渲染出一个 PVC。接下来的流程：
1. **提交申请**：PVC 带上了 `storageClassName: harbor-storage-class`。
2. **派单**：K8s 内置控制器不处理这个 StorageClass，转交给注册了 `example.com/nfs` 的 Provisioner。
3. **建目录**：Provisioner 监听到 PVC，在 NFS 共享里创建子目录 `/data/nfs/harbor/harbor-registry-pvc-<随机串>`。
4. **建卷绑定**：生成一个指向该子目录的 NFS 类型 PV，并把它与 PVC 绑定（`Bound`）。
5. **挂载**：Kubelet 拉起 registry 容器（Harbor 里存储镜像的组件）时，沿引用链 `volumeMount(/storage) → volumes → PVC → PV → NFS 子目录` 完成挂载，volumes 里的 `persistentVolumeClaim.claimName` 指向 PVC，PVC 又 Bound 到记录了 NFS server/path 的 PV。容器内对 `/storage` 的读写最终落在 NFS 服务器的实际目录上。
6. **写入**：registry 以为自己在写本地盘，实际数据全在 NFS 上，全程无人工建 PV。
验证：
```bash
kubectl get pvc -n harbor     # STATUS 应为 Bound
kubectl get pv                # 出现自动生成的 PV
ls /data/nfs/harbor           # NFS 上多出 harbor-xxx-pvc-xxx 目录
```
> 目录命名规律是 `<namespace>-<pvc名>-<pv名>`，一眼就能看出是哪个命名空间、哪个 PVC 生成的，方便排查。

#### 第二步：Helm 安装 Harbor
harbor所需要的组件很多，一个个创建yaml太麻烦了，用helm一键部署即可,value.yaml里面是一份配置清单，helm chart根据这个部署  
**1. 安装 Helm 并拉取 Chart**：
...
**2. 修改 values.yaml**（四处关键配置）：
...
**3. 复用外部 PostgreSQL（这个数据库只存元数据） 和 Redis**（节省资源，不重复部署中间件）：
values.yaml 中将 `database.type` 和 `redis.type` 从 `internal` 改为 `external`：
```yaml
database:
  type: external
  external:
    host: postgresql.default.svc.cluster.local   # Service 的 FQDN
    port: "5432"
    username: egg
    password: egg@777
    coreDatabase: registry
    notaryServerDatabase: notary_server
    notarySignerDatabase: notary_signer

redis:
  type: external
  external:
    addr: redis.default.svc.cluster.local:6379
```
> 注意 host 写的是**完整域名（FQDN）**而非短名：Harbor 部署在 `harbor` 命名空间，跨命名空间访问 `default` 里的 Service 必须带命名空间后缀（同命名空间才可用短名）。
外部数据库需预先建好用户和库——登进 PostgreSQL 容器执行：
```sql
CREATE USER egg WITH PASSWORD 'egg@777';
CREATE DATABASE registry OWNER egg;
CREATE DATABASE notary_server OWNER egg;
CREATE DATABASE notary_signer OWNER egg;
GRANT ALL PRIVILEGES ON DATABASE registry TO egg;
GRANT ALL PRIVILEGES ON DATABASE notary_server TO egg;
GRANT ALL PRIVILEGES ON DATABASE notary_signer TO egg;
```
> 因为daemon只跟 HTTPS 的镜像仓库通信，所以需要在每台机器的/etc/docker/daemon.json声明harbor是安全可通信的。


## 打通整个流水线
### 设置gitlab的webhook
- 初次与jenkins通信时，报403错误，这是jenkins默认开启了对csrf（跨域请求攻击）的防御，需要重新设置jenkins-master.yaml关闭csrf。
- jenkins设置匿名用户可读写权限
- jenkins按照gitlab插件
### 在项目根目录编写Jenkinsfile
采用 Pipeline SCM 模式：Jenkins 任务里只保留 Git 地址等基础配置，流水线代码放在项目根目录的 `Jenkinsfile` 中（**文件名首字母必须大写**）。流水线代码和项目耦合度高、随项目一起变动，因此跟随项目做版本控制。注意**每个分支都必须有该文件**，否则 Webhook 触发构建时会因找不到文件而报错。
完整示例（对应测试、构建、镜像、发布四个阶段）：
```groovy
// 每次构建动态生成唯一 label：Jenkins 会按这个 label 在 K8s 里创建 Pod，
// 若多个任务并发构建都用固定名称，Pod Template 会互相覆盖/冲突，因此用 UUID 保证唯一
def label = "slave-${UUID.randomUUID().toString()}"

// podTemplate：声明这次构建需要什么样的"Slave Pod"
// cloud: 'kubernetes' 表示交给 K8s 插件按需拉起这个 Pod，构建结束自动销毁
podTemplate(label: label, cloud: 'kubernetes',
    // workspaceVolume：所有容器共享同一个 PVC 作为工作目录，kubernetes 插件会自动把它 挂进 Pod 里的每一个容器
    // 这是阶段间传递产物的关键——golang 编译的二进制，docker 容器才能直接取到
    workspaceVolume: persistentVolumeClaim('jenkins-pvc'),
    containers: [
        // jnlp 是 Jenkins 自动注入的容器，负责 Slave 与 Master 的通信，不用手动操作
        containerTemplate(name: 'jnlp', image: 'jenkins/inbound-agent:jdk11'),
        // command: 'cat' + ttyEnabled: true 让容器常驻运行不被回收，
        // 后续用 container('golang') 进入执行命令（否则容器跑完入口命令就退出了）
        containerTemplate(name: 'golang', image: 'golang:1.17', command: 'cat', ttyEnabled: true),
        // DinD 方式：挂载宿主机的 docker.sock，
        // 容器里的 docker 命令实际是发给宿主机 Daemon 执行的，无需在容器里装完整 Docker
        containerTemplate(name: 'docker', image: 'docker:latest', command: 'cat', ttyEnabled: true,
            volumes: [hostPathVolume(hostPath: '/var/run/docker.sock', mountPath: '/var/run/docker.sock')]),
        // 自定义 kubectl 镜像：版本必须与集群版本一致（默认 latest 会因版本不匹配报 API 错误）
        containerTemplate(name: 'kubectl', image: '172.16.10.16:30002/tools/my-kubectl:v1.0', command: 'cat', ttyEnabled: true)
]) {
    node(label) {   // 在刚才声明的 Pod 上执行后续流水线
        // checkout scm：按任务的 Git 配置拉代码。
        // 注意：必须在 checkout 之后才能取分支/commit，否则变量为空导致后续判断全部失效
        def my_repo = checkout scm
        def git_branch = my_repo.GIT_BRANCH                         // 当前分支，用于后面"分支即环境"的路由
        def image_tag = sh(script: 'git rev-parse --short HEAD', returnStdout: true).trim()
        // 镜像 tag 用 commit id：每次构建 tag 唯一，出问题可以精确回滚到任意历史版本
        // （用 latest 的话新旧镜像无法区分，这是典型的标签陷阱）
        def image = "172.16.10.16:30002/green_hat/go_test:${image_tag}"
        println "本次构建的分支是: ${git_branch}，镜像: ${image}"

        stage('代码测试') {
            container('golang') {   // 只在 golang 容器里执行，其他容器闲置等待
                sh 'echo "模拟单元测试..."'
            }
        }
        stage('程序构建') {
            container('golang') {
                sh '''
                  export GOPROXY=https://goproxy.cn   // 国内代理加速 go mod 拉包
                  export GOOS=linux GOARCH=amd64      // 交叉编译：目标环境是 K8s 节点上的 Linux amd64
                  go build -v -o egan_go .
                '''   // 编译产物落在共享 PVC 上，等下被镜像阶段直接 ADD 进去
            }
        }
        stage('创建镜像') {
            container('docker') {
                // 动态生成 Dockerfile：heredoc 内容必须顶格写，
                // 缩进会被一起写进文件导致 Dockerfile 语法错误
                sh '''cat << EOF > Dockerfile
FROM centos:7
USER root
ADD ./egan_go /opt/egan_go
RUN chmod +x /opt/egan_go
CMD ["/opt/egan_go"]
EOF'''
                // withCredentials：临时注入 Harbor 账号（存进 Jenkins 凭证库，不落日志、不进代码）
                withCredentials([usernamePassword(credentialsId: 'docker-os',
                        usernameVariable: 'DOCKER_USER', passwordVariable: 'DOCKER_PASS')]) {
                    sh "docker login -u ${DOCKER_USER} -p ${DOCKER_PASS} 172.16.10.16:30002"
                }
                sh "docker build -t ${image} . && docker push ${image}"   // 构建并推送到 Harbor
            }
        }
        stage('发布到K8S') {
            container('kubectl') {
                // 分支即环境：master → 生产（人工确认），develop → 测试（全自动）
                if (git_branch == 'origin/master') {
                    // 生产发布必须人工确认，input 会暂停流水线等人点按钮
                    input message: '是否发布到生产环境?', ok: '继续'
                    // kubeconfig 等同于密码，平时锁在 Jenkins 凭证库里；
                    // withCredentials 注入临时文件路径，用完即销毁，绝不进 Git、不落日志
                    withCredentials([file(variable: 'KUBECONFIG_FILE', credentialsId: 'kuber-config-prod')]) {
                        // kubectl 默认读 ~/.kube/config，把凭证文件拷过去它才知道
                        // API Server 在哪（clusters）、用什么身份（users）、有什么权限（RBAC）
                        sh 'mkdir -p ~/.kube && cp $KUBECONFIG_FILE ~/.kube/config'
                        //首次部署test pod(副本数、端口、探针、label、Service……)是由运维手动部署的。
                        sh "kubectl set image deployment test test_image=${image}"   // 通知集群换镜像，触发滚动更新
                    }
                } else if (git_branch == 'origin/develop') {
                    // 测试环境全自动发布，kubeconfig 用权限更小的测试集群凭证
                    withCredentials([file(variable: 'KUBECONFIG_FILE', credentialsId: 'kuber-config-test')]) {
                        sh 'mkdir -p ~/.kube && cp $KUBECONFIG_FILE ~/.kube/config'
                        sh "kubectl set image deployment test test_image=${image}"
                    }
                }
                // 回滚依赖"tag 用 commit id"：每个历史版本镜像都还在 Harbor 里，
                // rollout undo 让 Deployment 回退到上一个 ReplicaSet 的版本
                input message: '是否回滚?', ok: 'YES'
                sh 'kubectl rollout undo deployment test'
            }
        }
    }
}
```
### 总结流程
**① 提交与触发（GitLab → Jenkins）**
开发者把代码 push 到 GitLab。GitLab 的 Webhook 按预先配置的 URL，向 Jenkins 发一个 POST 请求，body 里带着仓库地址、分支、commit ID 等信息。Jenkins 的任务配置里勾选了 "Build when a change is pushed to GitLab"，收到请求即触发构建——注意每个分支都要带 Jenkinsfile，否则 Webhook 构建会失败。

**② 动态 Slave 创建（Master → K8s）**
Jenkins Master 读到 Jenkinsfile 开头的 `podTemplate` 声明，通过 kubernetes 插件向 K8s API Server 申请创建一个 Slave Pod：四个容器（jnlp 通信、golang 编译、docker 打镜像、kubectl 发布）用 UUID 生成的唯一 label ，共享一块 PVC 作为工作空间。Pod 就绪后 jnlp 容器反向连回 Master，接管构建任务。

**③ 构建阶段（各容器接力）**
- `checkout scm` 拉取代码（必须在最前，后面取分支/commit 才有值）；
- golang 容器跑测试、编译出 `egan_go` 二进制，落在共享 PVC 上；
- docker 容器把二进制 ADD 进动态生成的 Dockerfile，构建镜像并用 commit ID 打 tag，凭 Harbor 账号（凭证库注入）push 到镜像仓库——到这里"交付物"就绪。

**④ 发布阶段（kubectl 容器 → 集群）**
`withCredentials` 把对应环境的 kubeconfig 注入为临时文件，`cp` 到 kubectl 容器的 `~/.kube/config`。develop 分支自动执行；master 分支先 `input` 等人确认。`kubectl set image` 发 HTTPS 请求到 API Server，Deployment 控制器滚动更新：新 ReplicaSet 起新 Pod → 就绪探针通过 → 旧 Pod 缩容，服务全程不中断；发布后还有一次 `input` 询问，确认异常则 `rollout undo` 秒回上一版本。

**⑤ 收尾**
构建结束，Slave Pod 整体销毁——临时 kubeconfig、构建产物随 Pod 一起消失，只有镜像和 Git 记录长存，天然保证下次构建是干净环境。

### 关键点
1. **动态 Pod Template 解耦构建环境**：静态 Slave 要预装所有工具，灵活性差；这里在代码里声明 golang/docker/kubectl 四个容器，按需拉起、用完即销毁。
2. **阶段间数据靠共享存储传递**：所有容器共享 PVC（workspace），golang 编译出的 `egan_go` 直接被镜像阶段 ADD 进 Dockerfile。
3. **镜像 tag 用 commit id 而非 latest**：每次构建 tag 唯一，出问题可回滚到任意历史版本——这正是前面提到的 `latest` 标签陷阱的解法。
4. **分支即环境**：develop 自动发布测试环境，master 走 `input` 人工确认后发布生产。
5. **踩坑记录**：获取分支/commit 的代码必须放在 `checkout scm` 之后；Pod Template 里的 kubectl 版本要与集群版本一致


## 补充
### RBAC详解
前文 Jenkins 凭证里那两份 kubeconfig（`kuber-config-test` / `kuber-config-prod`），本质上就是两把「钥匙」——Jenkins 拿着它就能对 K8s 集群执行 `kubectl set image`。这把钥匙为什么有效、能干什么、不能干什么，由 RBAC 决定。
#### RBAC 是什么
K8s 的所有请求都经过 API Server，RBAC（基于角色的访问控制）是 API Server 的鉴权机制：**先确认你是谁（认证），再确认你能干什么（授权）**。kubeconfig 中的用户信息完成第一步，第二步就靠 RBAC 规则判断。
核心由四个对象组成，两两配对：
| 对象               | 作用范围   | 说明                                                    |
| ------------------ | ---------- | ------------------------------------------------------- |
| Role               | 命名空间内 | 定义一组权限，如「能对 default 下的 Deployment 做读写」 |
| ClusterRole        | 整个集群   | 定义集群级权限，或跨命名空间复用的权限模板              |
| RoleBinding        | 命名空间内 | 把 Role 授权给某个用户/组/ServiceAccount                |
| ClusterRoleBinding | 整个集群   | 把 ClusterRole 授权出去，作用域是全集群                 |
关键点：**Role/RoleBinding 只在所属命名空间生效**。前文 `kubectl set image deployment/test` 能成功，是因为 kubeconfig 对应的身份在目标命名空间里有 Deployment 的写权限。

#### 实战：给 Jenkins 流水线一个最小权限身份
生产实践里不应该把管理员 kubeconfig 塞进 Jenkins，正确做法是创建专用的 ServiceAccount，只授予操作 Deployment 的权限：
```yaml
# 1. 创建专用 ServiceAccount（Jenkins 的身份）
apiVersion: v1
kind: ServiceAccount
metadata:
  name: jenkins-deployer
  namespace: test
---
# 2. Role：只允许操作 Deployment 的发布动作（没有删除、没有看 Secret 的权限）
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: deployment-updater
  namespace: test
rules:
  - apiGroups: ["apps"]
    resources: ["deployments"]
    verbs: ["get", "list", "watch", "patch", "update"]
---
# 3. RoleBinding：把 Role 绑定给 jenkins-deployer
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: jenkins-deployer-binding         
  namespace: test
subjects:
  - kind: ServiceAccount
    name: jenkins-deployer
    namespace: test
roleRef:
  kind: Role
  name: deployment-updater
  apiGroup: rbac.authorization.k8s.io
```

再基于这个 ServiceAccount 的 token 生成 kubeconfig（只有拥有这个的机器可以调用`kubectl`这一客户端命令访问apiserver），存入 Jenkins 凭证——这就是前文 `kuber-config-test` 的来源。测试和生产各建一份，权限范围分别限定在各自的命名空间。

到这里，前文提到的两个「RBAC 授权点」就对上号了。集群里实际存在**两条并行的授权链路**，分别服务于构建和发布，各用各的身份、互不依赖：
```
链路一（构建）：Kubernetes 插件拉起 slave Pod
  Jenkins Master Pod 挂载的 ServiceAccount   ← 前文「如何让jenkins可以自主创建slave pod」提到的那个
  需要 pods 的 create/delete/exec 等权限（管 Pod 生命周期）

链路二（发布）：kubectl set image 更新 Deployment
  Jenkins 凭证里的 kubeconfig（kuber-config-test / prod）  ← 前文「凭据配置」
  ↓ 由上面的 jenkins-deployer ServiceAccount 签发
  只需要 deployments 的 get/patch/update 权限（管发布）
```
为什么要分成两个身份，而不是一个 ServiceAccount 全包？这正是 RBAC 最小权限原则的实际落地：链路一能 `exec` 进任意容器，一旦泄漏等于交出构建环境；链路二只能改目标命名空间的 Deployment，泄漏后攻击面有限。如果混用一个权限大而全的身份，两条链路的安全边界就都失效了——权限按「用途」切分，是共享集群里最基础的隔离手段，多团队共用集群时（各团队绑定各自命名空间的 Role）遵循的也是同一个思路。

### kubeconfig
kubeconfig 默认只有主节点有，位于 `~/.kube/config`（也可用 `KUBECONFIG` 环境变量或 `--kubeconfig` 参数指定）。kubeadm 初始化时实际生成的是 `/etc/kubernetes/admin.conf`，随后自动复制一份到 `~/.kube/config`——因为 kubectl 默认只读这个路径，两份内容相同
```yaml
#admin.conf(主节点的kubeconfig)，运维人员自己电脑上只要有这一份配置就能用kubectl随意操作集群
apiVersion: v1
kind: Config
clusters:                                        # 连谁：API Server 地址 + CA 证书
- name: kubernetes
  cluster:
    server: https://172.16.10.11:6443            # 主节点 IP:6443，拿到别的机器要改成「那边能访问到的」地址
    certificate-authority-data: LS0tLS1CRUdJTi...  # CA 公钥证书(base64)，用于校验 apiserver 身份
users:                                           # 我是谁：客户端证书 + 私钥（认证信息在这里）
- name: kubernetes-admin
  user:
    client-certificate-data: LS0tLS1CRUdJTi...   # 用户证书，CN=kubernetes-admin(用户名)、O=system:masters(超级管理员组)
    client-key-data: LS0tLS1CRUdJTi...           # 私钥，与上面的证书配对，每次请求做 TLS 双向认证
contexts:                                        # 配对：把「哪个集群」和「哪个用户」组合到一起
- name: kubernetes-admin@kubernetes
  context:
    cluster: kubernetes
    user: kubernetes-admin
current-context: kubernetes-admin@kubernetes     # 当前生效的组合
```
**在个人电脑上操作集群**只需要两样东西：网络可达的 API Server 地址 + 一份合法的 kubeconfig。把管理员发给你的 kubeconfig 存到 `~/.kube/config`，无论人在哪，`kubectl` 都能直接操作集群。

 **集群内**（Pod 容器里）：不需要 kubeconfig。每个 Pod 启动时都会自动挂载 ServiceAccount 的 token（`/var/run/secrets/kubernetes.io/serviceaccount/token`）并注入 `KUBERNETES_SERVICE_HOST` 环境变量指向集群内部 API Server，客户端拿这些现成信息即可完成认证。注意「不需要 kubeconfig」只省掉了认证环节，**能不能创建 Pod 仍由 RBAC 决定**——默认 ServiceAccount 没有任何权限，请求会被 API Server 以 403 拒绝，必须像上文那样给ServiceAccount绑定 Role/ClusterRole 才行。前文 Jenkins Master Pod 能自主创建 slave Pod，靠的正是「自动挂载的 token 认证 + 提前绑定好的 RBAC 授权」这条「集群内」通道。


## ArgoCD
### Jenkins的劣势
没有 ArgoCD 时，常见的 CD 流程是：Jenkins 这类 CI 工具在构建镜像后，直接调用 `kubectl apply` 或 `helm` 命令把 Kubernetes 配置文件**推送**到集群——也就是前文整条 Jenkins 流水线所采用的方式。回看前文的做法，就能发现这种方式有三个主要问题：
- **配置冗余**：需要在 Jenkins-master 上配置 kubectl、helm 以及集群凭证kubeconfig，50 个项目就要配 50 份，维护成本随项目数量线性增长。
- **凭证暴露**：前文强调过 kubeconfig 是等同于密码的凭证文件，只应放在凭证管理系统里；而推送模式恰恰要把集群的 kubeconfig 暴露给集群外部的工具，攻击面被拉到了 Jenkins 这一侧。
- **状态盲区**：前文流水线里 Jenkins 执行完 `kubectl set image` / `apply` 就结束，看不到集群里实际的部署状态，应用到底健不健康、Pod 有没有起来完全不知道。
本质上这是「推送型（push）」部署的固有缺陷——发布动作的发起方在集群之外，既要把凭证交给外部工具，又无法感知最终的真实运行状态。

### ArgoCD的优势
ArgoCD 的核心思路是把推送流程**反转为拉取流程（pull）**：把 ArgoCD 本身部署在集群内部，由它主动去监听 Git 仓库的变化，自动拉取 manifests 并应用到集群。好处有三：

**1. Git 成为集群状态的唯一可信源（GitOps）**
所有变更都通过 Git 提交完成，天然带有版本历史和审计追踪——谁、什么时候、改了什么，全在 commit 记录里，回滚也是一次 `git revert`。

**2. 持续比对 + 自愈（self-heal）**
ArgoCD 会持续比对「Git 里的期望状态」和「集群里的实际状态」，发现不一致就以 Git 为准强制同步（self-heal）。视频里演示了三种典型行为：
- 把 `deployment.yaml` 里的镜像版本从 `1.0` 改成 `1.2` → ArgoCD 自动触发滚动更新。
- 删掉或重命名某个资源 → 开启 prune（自动清理）后，集群里对应的旧资源会被同步删除。
- 手动 `kubectl edit` 改副本数 → 会被 ArgoCD 立刻覆盖回 Git 定义的状态。

**3. 配置与源码分离**
最佳实践是把「应用源代码」和「应用配置代码」（deployment、service、configmap 这些 Kubernetes manifest）放在**两个独立仓库**。这样改配置不会触发整个 CI 流水线去重新测试和构建镜像，职责清晰、互不影响。

### 部署ArgoCD
部署与配置上，ArgoCD 通过扩展 Kubernetes API 工作，引入了 `Application` 和 `AppProject` 两个 CRD（自定义资源定义）：
- `Application`：描述「一个应用要部署什么、从哪来、到哪去」——即 Git 仓库地址、目标集群、命名空间、同步路径。
- `AppProject`：对 Application 做分组与权限边界，限定这个 Project 允许使用哪些 Git 仓库、哪些目标集群、哪些命名空间。

一个最简 `application.yaml` 示例：
```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: my-app
  namespace: argocd
spec:
  project: default
  source:
    repoURL: https://github.com/your-org/your-config-repo.git
    path: manifests/overlays/dev      # 配置仓库里的 k8s manifests 路径
    targetRevision: HEAD
  destination:
    server: https://kubernetes.default.svc   # 目标集群（默认指向 ArgoCD 所在集群）
    namespace: my-app
  syncPolicy:
    automated:
      selfHeal: true     # 集群偏离 Git 时自动纠正
      prune: true        # 删除 Git 中已不存在的资源
```
注意 `syncPolicy.automated` 同时开启 `selfHeal` 和 `prune`，正好对应上面「自愈」和「自动清理」两种行为。

`AppProject` 的示例（限定某组应用只能用指定的仓库、集群和命名空间）：
```yaml
apiVersion: argoproj.io/v1alpha1
kind: AppProject
metadata:
  name: team-a
  namespace: argocd
spec:
  # 只允许引用这些 Git 仓库（防止有人把 Application 指到不明仓库）
  sourceRepos:
  - https://github.com/your-org/team-a-config.git
  # 只允许部署到这两处：本地集群的 dev / prod 命名空间
  destinations:
  - server: https://kubernetes.default.svc
    namespace: team-a-dev
  - server: https://kubernetes.default.svc
    namespace: team-a-prod
  # 只允许创建这些资源类型
  clusterResourceWhitelist: []
  namespaceResourceWhitelist:
  - group: apps
    kind: Deployment
  - group: ""
    kind: Service
```
之后把 Application 的 `spec.project: default` 改成 `team-a`，它就落在这个权限边界内——越界的 Application（比如想指向别的仓库或命名空间）会被 ArgoCD 直接拒绝。

**多集群 / 多环境**：多个 dev / staging / prod 环境建议用 **Kustomize overlays（分层配置）** 而不是多分支来区分。配置仓库的目录长这样：

```
config-repo/
└── manifests/
    ├── base/                # 公共部分：所有环境一样的定义
    │   ├── deployment.yaml
    │   ├── service.yaml
    │   └── kustomization.yaml
    └── overlays/            # 各环境只写"差异"
        ├── dev/
        │   └── kustomization.yaml
        └── prod/
            └── kustomization.yaml
```

`base` 里放完整的 Deployment/Service 定义；每个 overlay 只声明改了什么，比如 `overlays/prod/kustomization.yaml`：

```yaml
resources:
- ../../base          # 引用公共部分
patches:
- target:
    kind: Deployment
  patch: |
    - op: replace
      path: /spec/template/spec/containers/0/image
      value: 172.16.10.16:30002/green_hat/go_test:v2.0   # prod 用新版本
replicas:
- name: web
  count: 3              # prod 副本数 3，dev 不写就沿用 base 的 1
```

这样 dev 和 prod 的差异一目了然，公共改动只改 `base` 一处。ArgoCD 这边每种环境建一个 Application，只是 `source.path` 指向不同 overlay 目录：

```yaml
# dev 的 Application
source:
  path: manifests/overlays/dev
# prod 的 Application——其余内容相同，只换路径和 destination
source:
  path: manifests/overlays/prod
```
Git 分支保持干净（永远只有 main），避免为每个环境长期维护一条分支带来的合并负担。

**常见误解澄清**：ArgoCD 不会取代 Jenkins。它的定位是只接管 Kubernetes 的 **CD（持续部署）** 部分；CI 阶段（代码测试、构建镜像）仍然由 Jenkins 负责。两者分工：Jenkins 产出镜像 → ArgoCD 负责把对应镜像版本的 manifests 拉取并部署到集群。

**完整 demo 流程**（Minikube）：
1. 在 Minikube 上安装 ArgoCD（官方提供 `argocd` CLI，也可用 `kubectl apply -n argocd -f install.yaml` 一键拉起）。
2. 写好上面的 `application.yaml`，提交到 Git 配置仓库，再 `kubectl apply -f application.yaml` 应用到集群。
3. 之后修改 `deployment.yaml` 里的镜像版本并提交 Git，即可在 ArgoCD UI 实时看到 Pod 被创建、状态从 `Pending` → `Running` 变化的全过程。
### gitlab+Jenkins+ArgoCD完整流程
** CI 阶段（Jenkins，照旧）**
与纯 Jenkins 方案完全一致：git push 触发 Webhook，动态 Slave Pod 完成测试、`go build`、构建镜像并用 commit id 打 tag、push 到 Harbor。对集群的操作到此为止——**原来的"发布到K8S"阶段（kubectl 容器、kubeconfig 注入、`kubectl set image`）整段删除**，替换成下面的"更新配置仓库"阶段（这一步的代码仍然写在 Jenkinsfile 里，只是内容从"命令集群"换成了"提交 Git"）。

**发布动作 = 一次 Git 提交（关键转变）**
传统方案里"发布"是流水线直接命令集群；现在变成了**改配置仓库里的文件**。Jenkins 构建完顺手 clone 配置仓库，把 dev 环境的镜像 tag 改成新 commit id 并 push：

```bash
git clone https://gitlab.xxx/team-a/config-repo.git
sed -i "s|go_test:.*|go_test:${image_tag}|" manifests/overlays/dev/kustomization.yaml
git commit -m "dev: deploy ${image_tag}" && git push
```
这行 sed 改的就是前面 Kustomize 示例里 `overlays/dev` 的镜像版本。然后ArgoCD 会自动检测到变更，触发滚动更新。

**⑥~⑨ CD 阶段（ArgoCD，接管）**
ArgoCD 持续轮询（或接收 GitLab Webhook）配置仓库，发现新 commit 后：拉取 manifests 渲染成完整 yaml → 和集群实际状态做 diff → 发现集群落后于 Git → 自动 apply 触发滚动更新。整个过程在 ArgoCD UI 上能看到：新 Pod `Pending` → `Running`，旧 Pod 逐个终止，最终集群状态和 Git 完全一致（Synced）。

**GitLab 里多出来的配置仓库**，就是前面介绍过的那套结构，各部分职责：

```
config-repo/                        ← 新增的第二个 Git 仓库
├── application.yaml                # ArgoCD 的 CRD：声明"从哪读配置、部署到哪个集群哪个命名空间"
└── manifests/
    ├── base/                       # 公共 manifests：Deployment/Service 定义（所有环境共享），一般就是第一版的test pod（对应前文Jenkins流程里面的那个）
    ├── overlays/dev/               
    └── overlays/prod/             
```

- **`application.yaml`**：告诉 ArgoCD 盯哪个仓库、哪个路径、同步到哪——这是 Jenkins 方案里不存在的东西（那时"去哪发布"写死在 Jenkinsfile 的 kubectl 命令里）；
- **`base/` + `overlays/`**：集群的期望状态。传统方案里这份信息只存在于 etcd 和流水线命令里，现在显式进了 Git——**它既是部署配置，也是审计记录，还是回滚手段**（`git revert` 一次提交就等于回滚，ArgoCD 会把集群拉回旧状态）。

**两边仓库的最终分工**：应用代码仓库管"代码怎么变成镜像"（CI），配置仓库管"镜像以什么形态跑在集群里"（CD）——这也正是前文说的"应用源代码与配置代码分离存储"的最佳实践。