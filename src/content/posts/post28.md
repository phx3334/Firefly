---
title: 基于k8s的CICD流程
published: 2026-09-21T23:11:23+08:00
description: 学习如何基于k8s部署，使用gitlab,jenkins，harbor进行自动化的cicd
image: './images/a28.avif'
tags: [k8s,自动化]
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
- 给Jenkins Pod 挂一个 ServiceAccount，并用 RBAC 授权，这样api server才认可
- 按照jenkins里面创建从节点的配置生成符合k8s创建pod的yaml文件格式
- 创建从节点pod
#### 动态slave pod实战


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
5. **挂载**：Kubelet 拉起 registry 容器(Harbor里面的一个Pod,存储镜像的)时，把该 PV 挂到容器的挂载路径（如 `/storage`）。
6. **写入**：registry 直接往这个目录写镜像数据，全程无人工建 PV。
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
// 每次构建生成唯一 label，避免多任务并发时 Pod Template 名称冲突
def label = "slave-${UUID.randomUUID().toString()}"

podTemplate(label: label, cloud: 'kubernetes', workspaceVolume: persistentVolumeClaim('jenkins-pvc'), containers: [
    containerTemplate(name: 'jnlp', image: 'jenkins/inbound-agent:jdk11'),        // 与 Master 通信（自动注入）
    containerTemplate(name: 'golang', image: 'golang:1.17', command: 'cat', ttyEnabled: true),
    containerTemplate(name: 'docker', image: 'docker:latest', command: 'cat', ttyEnabled: true,
        volumes: [hostPathVolume(hostPath: '/var/run/docker.sock', mountPath: '/var/run/docker.sock')]),  // DinD：借用宿主机 Docker Daemon
    containerTemplate(name: 'kubectl', image: '172.16.10.16:30002/tools/my-kubectl:v1.0', command: 'cat', ttyEnabled: true)
]) {
    node(label) {
        def my_repo = checkout scm                                  // 拉代码（必须先 checkout，才能取到分支/commit）
        def git_branch = my_repo.GIT_BRANCH                         // 当前分支
        def image_tag = sh(script: 'git rev-parse --short HEAD', returnStdout: true).trim()
        def image = "172.16.10.16:30002/green_hat/go_test:${image_tag}"   // 用 commit id 做 tag，保证唯一、可回滚
        println "本次构建的分支是: ${git_branch}，镜像: ${image}"

        stage('代码测试') {
            container('golang') {
                sh 'echo "模拟单元测试..."'
            }
        }
        stage('程序构建') {
            container('golang') {
                sh '''
                  export GOPROXY=https://goproxy.cn
                  export GOOS=linux GOARCH=amd64
                  go build -v -o egan_go .
                '''
            }
        }
        stage('创建镜像') {
            container('docker') {
                // 动态生成 Dockerfile，注意内容必须顶格写，避免缩进污染
                sh '''cat << EOF > Dockerfile
FROM centos:7
USER root
ADD ./egan_go /opt/egan_go
RUN chmod +x /opt/egan_go
CMD ["/opt/egan_go"]
EOF'''
                withCredentials([usernamePassword(credentialsId: 'docker-os',
                        usernameVariable: 'DOCKER_USER', passwordVariable: 'DOCKER_PASS')]) {
                    sh "docker login -u ${DOCKER_USER} -p ${DOCKER_PASS} 172.16.10.16:30002"
                }
                sh "docker build -t ${image} . && docker push ${image}"
            }
        }
        stage('发布到K8S') {
            container('kubectl') {
                if (git_branch == 'origin/master') {
                    // 生产环境：人工确认后才发布
                    input message: '是否发布到生产环境?', ok: '继续'
                    withCredentials([file(variable: 'KUBECONFIG_FILE', credentialsId: 'kuber-config-prod')]) {
                        sh 'mkdir -p ~/.kube && cp $KUBECONFIG_FILE ~/.kube/config'
                        sh "kubectl set image deployment/test test=${image}"
                    }
                } else if (git_branch == 'origin/develop') {
                    // 测试环境：全自动发布
                    withCredentials([file(variable: 'KUBECONFIG_FILE', credentialsId: 'kuber-config-test')]) {
                        sh 'mkdir -p ~/.kube && cp $KUBECONFIG_FILE ~/.kube/config'
                        sh "kubectl set image deployment/test test=${image}"
                    }
                }
                // 回滚：发布后询问，YES 则回退到上一版本
                input message: '是否回滚?', ok: 'YES'
                sh 'kubectl rollout undo deployment/test'
            }
        }
    }
}
```

### 凭据配置（系统管理 → 管理凭证）
- **Harbor 账号**：类型 `Username with password`，ID 为 `docker-os`。所有项目的 docker login 都引用它，改密码只需改一处。
- **K8s 测试/生产 kubeconfig**：类型 `Secret file`，ID 分别为 `kuber-config-test` / `kuber-config-prod`。`withCredentials` 的 `file()` 变量拿到的是**临时文件路径**（不是内容），需 `cp` 到 `~/.kube/config` 后 kubectl 才能使用。

### 关键点
1. **动态 Pod Template 解耦构建环境**：静态 Slave 要预装所有工具，灵活性差；这里在代码里声明 golang/docker/kubectl 四个容器，按需拉起、用完即销毁。
2. **阶段间数据靠共享存储传递**：所有容器共享 PVC（workspace），golang 编译出的 `egan_go` 直接被镜像阶段 ADD 进 Dockerfile。
3. **镜像 tag 用 commit id 而非 latest**：每次构建 tag 唯一，出问题可回滚到任意历史版本——这正是前面提到的 `latest` 标签陷阱的解法。
4. **分支即环境**：develop 自动发布测试环境，master 走 `input` 人工确认后发布生产。
5. **踩坑记录**：获取分支/commit 的代码必须放在 `checkout scm` 之后；Pod Template 里的 kubectl 版本要与集群版本一致