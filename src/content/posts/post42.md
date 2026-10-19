---
title: k8s多用户和权限管理
published: 2026-10-20T20:11:23+08:00
description: 学习RBAC相关的资源定义和应用场景
image: './images/a42.avif'
tags: [k8s]
category: '计算机技术'
draft: false
lang: '中文'
---



## 解决了什么问题

前面两章的配额（ResourceQuota/LimitRange）解决的是"namespace 能用多少资源"，但没有回答另一个问题：**谁能对这个 namespace 做什么操作**。默认情况下集群权限是一把抓的——要么拿到 admin 全权，要么什么都做不了，这显然满足不了真实的共享集群：

- 公有云/私有云平台上，每个公司或用户是一个租户，租户之间必须完全隔离
- 同一公司内部多个团队共享集群，既要协作又要有边界
- 同一团队内部，开发、测试、运维对集群的了解和职责完全不同，权限需求也不同

权限管理要回答的就是一句话："**谁（用户/组）能对哪些范围内的哪些资源执行什么操作**"。

**场景一：针对不同租户。** 租户在公有云（阿里云、腾讯云）或私有云平台中，就是创建账号的每个公司或用户。租户申请的空间/项目/环境，在 K8s 里对应不同的 namespace。权限原则很硬：租户对自己名下的所有 namespace 拥有完全访问权（租户 A 可访问自己的 A1、A2），但严格禁止跨租户访问（A 不能碰 B 的 B1）。云服务商靠这个保证不同企业客户的资源完全隔离——上一章多租户隔离里说过"硬隔离要配合 namespace 和 RBAC"，RBAC 就是那里缺的一环。

**场景二：针对不同团队。** 和租户模式的区别在于：同公司内部团队之间可能需要协作，不能一刀切地隔离。基本规则：团队对自己创建的 namespace 完全访问（团队 A 对 A1、A2）；协作项目上做差异化——主责团队保持完全访问（团队 B 对 B1），协作者受限访问（团队 A 对 B1 只能查看日志、执行命令）。典型场景就是跨团队联合开发，主责团队与协作团队的权限不一样。

**场景三：不同场景不同角色。** 同一个集群里，不同角色的权限差异更大：

- 开发人员：可访问开发/测试/生产所有环境，但只给基础操作——查看日志、debug；生产环境限制更严，比如禁止命令执行
- 测试人员：只允许进测试环境，且是只读权限，比如压测时监控资源指标
- 运维人员：熟悉 K8s，可以给近乎完全访问，危险操作（比如删生产 namespace）再单独限制

要点是根据技术能力和职责需求差异化授权，而不是按人头复制同一份权限。

**归纳一下规律。** 用户/组按三个维度创建：租户边界、团队划分、角色职能，且一个用户可以同时属于多个组（既是开发组又是 A 团队成员）。权限分配的特点是：单个用户/组可能对应多个 namespace 的不同权限，粒度既能粗到 namespace 级，也能细到"某个资源的某种操作"。实施路径：先规划清晰的租户/团队/角色矩阵，再用 RBAC 模型落地，最后定期审计权限分配的合理性。

这些需求翻译成 RBAC 的语言就是：**给不同的主体（用户/组），在不同范围的资源（整个集群或某个 namespace）上，授予不同级别的操作权限（查看/创建/删除等）**。K8s 用 RBAC 模型来承载这句话，下面看它的资源定义。


## 资源定义

RBAC 用四个资源对象回答上一节的"谁-范围-操作"：**Role / ClusterRole 定义"能做什么操作"（权限规则），RoleBinding / ClusterRoleBinding 定义"谁能做"（绑定主体）**。规则和绑定拆成两类对象，权限定义就能复用——一套规则可以绑给多个用户，一个用户也可以同时绑多套规则。

### Role 与 ClusterRole：定义权限规则

Role 是 namespace 级的权限规则，一条 rule 由三部分组成：

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: pod-reader
  namespace: team-a                   # Role 必须挂在某个 namespace 下
rules:
- apiGroups: [""]                     # "" 是核心 API 组（pods、services、configmaps 等）
  resources: ["pods", "pods/log"]     # pods/log 是子资源，对应 kubectl logs
  verbs: ["get", "list", "watch"]     # 允许的操作
```

- apiGroups：API 组，`""` 是核心组；apps 组里是 Deployment、StatefulSet 这类
- resources：资源名，可以写子资源（pods/log、pods/exec——后者对应 kubectl exec 进容器）
- verbs：操作动词，常用的有 get/list/watch（读）、create/update/patch（写）、delete/deletecollection（删）

ClusterRole 结构和 Role 完全一样，区别是不属于任何 namespace，管的是集群级资源：

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: node-reader                   # 没有 namespace 字段
rules:
- apiGroups: [""]
  resources: ["nodes"]
  verbs: ["get", "list", "watch"]
```

### RoleBinding 与 ClusterRoleBinding：绑定主体

角色只是"权限说明书"，没人拿着它就什么都不是。Binding 负责把说明书交给具体的人：

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: alice-read-pods
  namespace: team-a
subjects:
- kind: User
  name: alice                         # 集群外的用户，由证书/OIDC 等认证方式引入
  apiGroup: rbac.authorization.k8s.io
- kind: ServiceAccount
  name: jenkins                       # 集群内的"用户"，给 Pod 里的程序用
  namespace: jenkins
roleRef:                              # 绑定哪个角色，只能填一个
  kind: Role                          # 也可以填 ClusterRole
  name: pod-reader
  apiGroup: rbac.authorization.k8s.io
```

主体（subjects）有三种：

| kind           | 说明                                                                          |
| -------------- | ----------------------------------------------------------------------------- |
| User           | 集群外部用户，由认证层引入（客户端证书、OIDC 等），K8s 不存储 User 对象       |
| Group          | 用户组，给一组 User 批量授权                                                  |
| ServiceAccount | 集群内部身份，给 Pod 里的程序用——Jenkins 流水线里 Pod 操作 K8s API 用的就是它 |

注意 roleRef 只能绑一个角色，用户需要多个角色的权限就建多个 Binding。

### 四种组合，范围跟着绑定走

两个角色类型 × 两个绑定类型，常用的组合是三种：

| 角色        | 绑定               | 生效范围              | 典型场景                           |
| ----------- | ------------------ | --------------------- | ---------------------------------- |
| Role        | RoleBinding        | Role 所在的 namespace | 团队成员管自己的 namespace         |
| ClusterRole | ClusterRoleBinding | 整个集群              | 运维管理员、平台组件               |
| ClusterRole | RoleBinding        | 绑定所在的 namespace  | 同一套角色定义复用到多个 namespace |

最容易混淆的是第三种：**ClusterRole 本身不限定生效范围，范围由绑定它的对象决定**——被 ClusterRoleBinding 绑定就是全集群，被 RoleBinding 绑定就只在那个 namespace 里生效。这个设计让权限规则可以跨 namespace 复用：比如给所有 namespace 的成员发同一份 view 角色，只需写一个 ClusterRole，然后各 namespace 各建一个 RoleBinding。

### 实战：给测试人员只读权限

需求：用户 alice 在 test 命名空间只能看资源，不能改。

```bash
# 1. 创建只读角色
kubectl create role viewer --verb=get,list,watch --resource=pods,services,deployments -n test

# 2. 绑给 alice
kubectl create rolebinding alice-view --role=viewer --user=alice -n test

# 3. 验证权限，--as 模拟指定用户的身份
kubectl auth can-i get pods -n test --as alice     # yes
kubectl auth can-i delete pods -n test --as alice  # no
```

生产中大多数时候不用自己写 rules——K8s 内置了四个开箱即用的 ClusterRole：

| 内置角色      | 权限范围                                                        |
| ------------- | --------------------------------------------------------------- |
| cluster-admin | 全部权限，慎用                                                  |
| admin         | namespace 内所有资源的管理（含角色），不含配额和 namespace 本身 |
| edit          | namespace 内读写，不能查看/修改角色                             |
| view          | namespace 内只读                                                |

按上一节的场景对号入座：测试人员绑 view，开发人员绑 edit，运维绑 admin——几条 RoleBinding 就能落地。全集群级别的授权（比如运维组）用 ClusterRoleBinding 同理：

```bash
kubectl create clusterrolebinding ops-admin --clusterrole=admin --group=ops-team
```