---
title: k8s多用户和认证权限管理
published: 2026-10-20T20:11:23+08:00
description: 学习RBAC相关的资源定义和应用场景,以及k8s认证体系
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

这些需求翻译成 K8s 的语言就是：**给不同的主体（用户/组），在不同范围的资源（整个集群或某个 namespace）上，授予不同级别的操作权限（查看/创建/删除等）**。要落地需要两层机制配合：认证回答"你是谁"，RBAC 回答"你能干什么"。后面分四步展开：先讲认证体系——身份从哪来，再看 RBAC 资源定义——权限怎么表达，然后是用户凭证与 kubeconfig——凭证怎么装，最后串成完整的管理与实战。


## k8s认证体系

认证回答"你是谁"，授权（RBAC，下一章）回答"你能干什么"。一条请求进入 apiserver 的处理顺序是：**认证（确认用户名+组）→ 授权（RBAC 判定）→ 准入控制**（LimitRange 和 ResourceQuota 的校验就在这层）。本节展开讲认证层怎么把一个请求变成"某个用户/组"——产出的这些字符串，就是下一章 RBAC 里 User/Group 主体的来源。

两个前提：

- 多种认证方式可以同时启用，apiserver 挨个尝试，任何一个认出你就通过；全都认不出时，请求被当作匿名用户 `system:anonymous`，能不能干活再由 RBAC 决定
- 无论用哪种方式，认证层最终产出统一的"用户名 + 组"，正好对接 RBAC 的 User/Group 主体——认证体系可以随时换，RBAC 不用动

### X.509 客户端证书：CA 信任体系

证书认证的本质是一套信任链，把三个角色拆开看：

- **CA（证书颁发机构）**：本质就是"一对根密钥 + 一张自签名的 CA 证书"——谁持有这对密钥，谁就是 CA，它并不是什么神秘的第三方机构。CA 证书里的公钥只有一个用途：验证"由它签发的证书"是不是真的
- **签发流程**：用户生成私钥和 CSR（证书签名请求，里面带公钥和身份信息），CA 用根私钥在 CSR 上签名，产出用户证书。CA 全程不需要知道用户密码，它只负责"给身份背书"
- **验证流程**：apiserver 只配置一个 `--client-ca-file` 指向 CA 证书。收到请求时取出客户端证书，用 CA 公钥验签，通过就信任证书里的身份——所以新增用户不需要在 apiserver 上登记任何东西，签张证书就行

CA 在不同场景下长得不一样，但逻辑完全相同——它就是**信任的锚点**：

- **K8s 集群里**：CA 就是 kubeadm 初始化集群时自动生成的一对文件——/etc/kubernetes/pki/ 下的 ca.key（根私钥，最高机密，只留在控制平面）和 ca.crt（CA 证书）。集群内所有组件间的 TLS 证书（apiserver、etcd、kubelet 通信）和所有用户证书都由它签发，kube-controller-manager 里内置的 CSR 控制器也拿这对密钥自动给节点签证书
- **浏览器 / HTTPS 世界**：CA 是操作系统和浏览器出厂内置的那些根证书（DigiCert、Let's Encrypt 等）。访问 https 网站时，浏览器拿内置的 CA 公钥验证网站的证书——"全网公认的可信 CA"是提前刻在系统里的，所以你不用手动导入任何东西
- **企业内网**：通常是自建 CA（如 Windows AD CS），给内部系统签发证书，办公电脑统一导入企业根证书

无论哪种场景，本质都一样：**信任了 CA，就等于信任它签出的一切**。K8s 里 apiserver 信任了 ca.crt，就等于信任了所有由它签发的用户证书。

身份映射规则：证书的 **CN 字段 → 用户名，O 字段 → 组**，一个证书可以带多个 O。

生成一个用户证书的完整流程：

```bash
# 1. 生成用户私钥
openssl genrsa -out alice.key 2048

# 2. 生成 CSR：CN 是用户名，O 是组
openssl req -new -key alice.key -out alice.csr -subj "/CN=alice/O=dev-team"

# 3. 用集群 CA 签发（kubeadm 集群的 CA 在 /etc/kubernetes/pki/ 下）
openssl x509 -req -in alice.csr \
  -CA /etc/kubernetes/pki/ca.crt -CAkey /etc/kubernetes/pki/ca.key \
  -CAcreateserial -out alice.crt -days 365

# 4. 写入 kubeconfig（kubeconfig 的结构详见后面的凭证章）
kubectl config set-credentials alice \
  --client-certificate=alice.crt --client-key=alice.key \
  --kubeconfig=alice.kubeconfig
```

一个必须知道的细节：kubeadm 的 admin.conf 里证书是 `CN=kubernetes-admin, O=system:masters`——**system:masters 是 K8s 内置的超级用户组**，权限不受 RBAC 管理（删掉对应绑定也不影响）。谁拿到这张证书谁就是超级管理员，所以 admin.conf 要按密钥级别保管。

局限：签发、分发靠手工，证书到期没有自动轮换，也没有便捷的吊销机制（apiserver 对 CRL/OCSP 的支持很弱）。适合管理员这种小规模群体，不适合给每个开发都发一张。

### OIDC（对接企业统一登录）

大规模多用户场景的主流方案。先把三个名词捋清楚：

- **OIDC（OpenID Connect）**：在 OAuth 2.0 之上定义的一层身份协议。OAuth 2.0 解决"授权"，OIDC 补上了"你是谁"——登录成功后 IdP 会签发一个 id_token，里面带着用户身份
- **IdP（Identity Provider）**：身份提供方，即企业统一登录系统（Keycloak、Azure AD、Okta、各类 SSO），负责验证账号密码并签发 token
- **JWT**：id_token 的格式，三段式结构 `header.payload.signature`，payload 里是 claims（一组键值对：用户名、组、过期时间等），signature 由 IdP 私钥签名——任何篡改都会导致验签失败

完整登录链路：

```text
1. 用户触发登录，kubectl 的 oidc 插件跳转到 IdP 登录页
2. 用户输入账号密码，IdP 验证通过，签发 id_token（JWT）给 kubectl
3. kubectl 每次请求带上 Authorization: Bearer <id_token>
4. apiserver 验证：签名（用 IdP 公开的 JWKS 公钥）→ iss（签发方对不对）
   → aud（是不是签给本集群的）→ 是否过期
5. 验证通过，从 claim 里取出用户名和组，身份建立，交给 RBAC 判定
```

apiserver 侧的三件套配置：

- `--oidc-issuer-url`：IdP 的地址，对应 JWT 里的 iss，必须完全一致
- `--oidc-client-id`：校验 JWT 的 aud，确认这个 token 是签给"K8s 集群"这个应用，而不是签给别的系统的
- `--oidc-username-claim` / `--oidc-groups-claim`：从哪个 claim 取用户名（常用 email 或 sub）和组（常用 groups），取出来的值直接成为 RBAC 的 User/Group

一个生产绕不开的坑：id_token 有效期很短（几分钟到一小时），手动粘进 kubeconfig 很快就失效。正确姿势是 kubeconfig 的 user 段配 exec 插件（如 kubelogin），kubectl 执行时自动完成登录、拿 token、过期自动刷新——用户全程感知不到 token 的存在。

核心价值：用户生命周期完全交给企业身份系统——入职自动有号、离职自动失效，组信息直接对接 RBAC 的 Group 批量授权，第一章规划的"租户/团队/角色"场景，靠 OIDC + 内置角色（见下一章）就能规模化落地。云厂商托管集群（ACK/EKS/GKE）内置与本家 IAM 的对接，本质就是这条路。

### Webhook Token（委托外部认证）

认证逻辑外包：apiserver 收到 token 后不自己判断，而是组装一个 TokenReview 请求 POST 给配置好的外部认证服务，由外部服务返回"这是谁、属于哪些组"。

适合认证规则需要自定义的场景——比如公司有自建账号中心，认证要查内部数据库。公有云厂商把自家 IAM 接进托管集群，用的也是 webhook。

### ServiceAccount：集群内程序的身份

前面三种方式的凭证都在集群外部（证书文件、IdP、外部服务），面向的是"人"。但集群内部还有一大类调用方：Pod 里运行的程序。cert-manager 要读写 Secret 签证书，CI/CD 流水线要执行 kubectl 部署应用，监控组件要采集指标——它们调 API Server 时同样要过认证层。ServiceAccount（SA）就是给程序准备的账号，而且它是真实的 K8s 资源对象，kubectl 可以直接增删查（对比一下：人的用户名/组只是认证层产出的字符串，etcd 里没有对应对象）：

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: dev-user
  namespace: team-a
```

SA 有两个默认行为，理解它们就理解了 SA 的日常形态：

- **每个 namespace 自动有一个 default SA**。创建 Pod 时不指定 serviceAccountName，就用所在 namespace 的 default。default 没有绑定任何角色，所以 Pod 默认调 API 全是 403——"程序默认无权限、要干活先 RBAC 绑定"说的就是它
- **Pod 自动挂载 SA token**。Pod 启动时 kubelet 调 TokenRequest API 现签一个 token，通过 projected volume 挂载到 /var/run/secrets/kubernetes.io/serviceaccount/，自带过期时间并由 kubelet 定期轮换。程序读这个文件就拿到凭证，请求头带上 Authorization: Bearer \<token\>，认证层把它解析成 system:serviceaccount:\<ns\>:\<sa名\> 格式的用户名

token 的获取方式经历过一次变化。老版本（1.24 之前）创建 SA 时控制器自动生成一个同名 Secret，token 长期存在 Secret 里且永不过期；新版本不再自动生成，token 改为按需签发：`kubectl create token dev-user -n team-a` 直接输出一个带过期时间的 token，适合临时调试；要长期持有，就显式创建 type 为 kubernetes.io/service-account-token 的 Secret，并用注解关联 SA：

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: dev-user-token            # 名字随意，不要求与 SA 同名
  namespace: team-a               # 必须和 SA 在同一个 namespace
  annotations:
    kubernetes.io/service-account.name: dev-user   # 用注解指向要关联的 SA
type: kubernetes.io/service-account-token         # type 固定是这个
```

data 里什么都不用写——apply 后 token 控制器检测到这个 type + 注解，会自动往 Secret 里填充 token、ca.crt、namespace 三个字段：

```bash
kubectl get secret dev-user-token -n team-a -o jsonpath='{.data.token}' | base64 -d
```

注意两点：必须先有 SA 再建这个 Secret（注解指向不存在的 SA 时不会被填充）；这种手动创建的 token 和老版本自动生成的一样长期有效，删掉 Secret 重建就换了新 token，天然多了一个轮换凭证的手段。

顺带一个常见疑问：**SA 的 spec.secrets 字段还在吗？** 在，字段没有删，只是不再自动回填——新建 SA 的这个字段是空的（老版本能看到自动生成的 Secret 名字躺在里面）。它的真实作用是"把列出的 Secret 随使用该 SA 的 Pod 自动挂载"，和 token 的获取已经无关：新版 Pod 的 SA token 走 kubelet 现签那条路，全程不经过 spec.secrets，所以手动创建的 token Secret 不需要、也不会自动出现在这个字段里。

至于人能不能用 SA：可以拿它的 token 生成一份 kubeconfig 临时用（实验环境最省事，凭证章会演示），但生产多用户场景人的主流凭证还是证书和 OIDC——人的生命周期管理（入职/离职/换组）不该靠删建 SA 来做。

### 认证方式怎么选

| 方式           | 身份怎么来                    | 适用场景                      |
| -------------- | ----------------------------- | ----------------------------- |
| X.509 证书     | CA 签发证书，CN=用户名、O=组  | 管理员、小规模                |
| ServiceAccount | K8s 原生对象 + 自动挂载 token | 集群内程序（Pod）             |
| OIDC           | 企业 SSO 签发 JWT             | 多用户生产环境主流方案        |
| Webhook        | 外部认证服务裁决              | 对接企业自有账号系统 / 云 IAM |

四种方式的本质区别是**身份生命周期归谁管**：证书的签发、到期、吊销全靠管理员手工维护，规模一大就崩；OIDC 把它交给企业 IdP——入职自动有号、离职自动失效、换组自动生效，人不用碰集群；SA 的生命周期跟集群资源走，随程序部署创建、随程序下线删除；Webhook 则是认证规则完全自定义。落到多用户管理上就是一条选型路径：管理员等小规模群体用证书；开发、测试、运维等全员走 OIDC 对接企业统一登录；Pod 里的程序用 SA；开头规划的"租户/团队/角色"分组直接在 IdP 里维护好，RBAC 只管把角色绑给对应的组。

kubectl 侧这些凭证统一放在 kubeconfig（~/.kube/config）里：client-certificate 字段对应证书方式，token 字段对应 token / SA 方式。post20 讲的"kubectl 读 ~/.kube/config 拿凭证访问 apiserver"，拿的就是这些东西。


## RBAC 资源定义

认证层把请求换成了"用户名 + 组"，接下来回答第二个问题：这些身份能干什么。RBAC 用四个资源对象回答开头的"谁-范围-操作"：**Role / ClusterRole 定义"能做什么操作"（权限规则），RoleBinding / ClusterRoleBinding 定义"谁能做"（绑定主体）**。规则和绑定拆成两类对象，权限定义就能复用——一套规则可以绑给多个用户，一个用户也可以同时绑多套规则。

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
  name: alice                         # 集群外的用户，由认证层引入
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

| kind           | 说明                                                                    |
| -------------- | ----------------------------------------------------------------------- |
| User           | 集群外部用户，由认证层引入（客户端证书、OIDC 等），K8s 不存储 User 对象 |
| Group          | 用户组，给一组 User 批量授权                                            |
| ServiceAccount | 集群内部身份，给 Pod 里的程序用——认证章讲过它的默认行为和 token 机制    |

注意 roleRef 只能绑一个角色，用户需要多个角色的权限就建多个 Binding；另外引用 Role 时必须和 Binding 在同一个 namespace（引用 ClusterRole 不受此限）——这正是后面"跨 namespace 复用权限规则要靠 ClusterRole"的原因。

一个反直觉的关键点：**User 和 Group 都不是 K8s 资源**——etcd 里没有它们的对象，`kubectl get users` 这种命令不存在，它们只是认证层产出的字符串（证书的 CN/O 字段、OIDC 的 claims）。三个主体里只有 ServiceAccount 是真实资源对象，存在 etcd、可以增删查——这也是为什么 SA 有"创建 SA → 生成 Secret/token"这套资源化流程，而 User/Group 没有。

由此带来几个实际行为：

- **RBAC 授权的本质是字符串匹配**：Binding 的 subjects 里写 `name: alice`，和请求认证出来的用户名完全相等就命中，不存在"查询用户是否存在"的步骤
- **没有 `kubectl create user`**："创建用户"等于签一张证书或在 IdP 建账号；"删除用户"等于吊销凭证（证书作废、IdP 禁用、SA 删对象）
- **组不需要创建**：有没有组完全取决于认证方式给没给——证书写了 O 就有，OIDC 配了 groups claim 就有，没给就是空，此时按用户逐个绑 Binding 即可
- **建议让用户始终带组**：换岗/离职时把人移出组就行，按用户逐个删 Binding 很容易漏——一个用户可能在多个 namespace 里有七八条绑定
- **RBAC 是纯加法**：rules 里只有 allow 没有 deny，一个主体命中多条 Binding 时权限取并集——"除了删资源全都行"这种需求做不到，只能像实战章场景三那样从角色定义里做减法

### 四种组合，范围跟着绑定走

两个角色类型 × 两个绑定类型，常用的组合是三种：

| 角色        | 绑定               | 生效范围              | 典型场景                           |
| ----------- | ------------------ | --------------------- | ---------------------------------- |
| Role        | RoleBinding        | Role 所在的 namespace | 团队成员管自己的 namespace         |
| ClusterRole | ClusterRoleBinding | 整个集群              | 运维管理员、平台组件               |
| ClusterRole | RoleBinding        | 绑定所在的 namespace  | 同一套角色定义复用到多个 namespace |

最容易混淆的是第三种：**ClusterRole 本身不限定生效范围，范围由绑定它的对象决定**——被 ClusterRoleBinding 绑定就是全集群，被 RoleBinding 绑定就只在那个 namespace 里生效。这个设计让权限规则可以跨 namespace 复用：比如给所有 namespace 的成员发同一份 view 角色，只需写一个 ClusterRole，然后各 namespace 各建一个 RoleBinding。

### 集群自带的现成角色与绑定：内置角色和 system: 身份

前面都是"从零写 Role、建 Binding"，但真实集群里你接手时，这套机制早就被 K8s 自己用起来了——装集群时就自带两类现成品。

**内置 ClusterRole：四个开箱即用的权限规则。** 它们是标准的 ClusterRole 资源，只是由 K8s 预先创建，人类用户的大多数权限需求直接绑这四个就够了：

| 内置角色      | 权限范围                                                        |
| ------------- | --------------------------------------------------------------- |
| cluster-admin | 全部权限，慎用                                                  |
| admin         | namespace 内所有资源的管理（含角色），不含配额和 namespace 本身 |
| edit          | namespace 内读写，不能查看/修改角色                             |
| view          | namespace 内只读（不含 Secret）                                 |

注意 view/edit 都刻意排除了 Secret 的读权限——防止"能看 Pod 的人顺手把数据库密码捞走"。

**system: 内置身份：集群自己的人和组。** 还有一批以 system: 为前缀的用户名/组，是集群组件和机制在用的保留身份

| 身份                                                                      | 是谁                                  |
| ------------------------------------------------------------------------- | ------------------------------------- |
| system:kube-scheduler / system:kube-controller-manager / system:apiserver | 控制平面组件访问 apiserver 用的用户名 |
| system:node:\<节点名\>                                                    | 每个 kubelet 的身份                   |
| system:serviceaccount:\<ns\>:\<sa名\>                                     | ServiceAccount 在认证层的用户名格式   |
| system:anonymous                                                          | 认证全部失败的请求                    |
| system:masters                                                            | 内置超级用户组，权限不受 RBAC 管理    |
| system:authenticated / system:unauthenticated                             | 认证层给所有请求自动打上的组          |
| system:serviceaccounts / system:nodes                                     | 全部 SA / 全部节点                    |

举例理解：内置的一条也叫cluster-admin的ClusterRoleBinding把cluster-admin角色绑给了system:masters(组身份字符串，来自管理员证书的 O 字段),如此一来，cluster-admin角色拥有了整个集群的权限。


## 用户凭证与 kubeconfig

身份、权限规则、token 机制都有了，最后一块拼图是客户端：kubectl 怎么知道"用哪个凭证连哪个集群"。这一章讲 kubeconfig——个人凭证怎么装进一份文件、一份文件怎么管多个集群，最后把前面所有对象放进一条请求的完整链路。

### 生成用户的 kubeconfig

kubeconfig 是 kubectl 的"身份证 + 通讯录"，决定你以什么身份连哪个集群。管理员自己的 ~/.kube/config 显然不能发给普通用户——每个用户应该有独立的 kubeconfig，里面只装自己的凭证。

凭证可以是证书（认证章 X.509 流程的第 4 步），也可以是 token（实验环境借 SA 的 token 最省事），四步命令拼出一份：

```bash
# 1. 集群信息：API Server 地址 + CA 证书
kubectl config set-cluster k8s \
  --server=https://10.0.0.1:6443 \
  --certificate-authority=ca.crt \
  --kubeconfig=dev-user.kubeconfig

# 2. 用户凭证：填入 SA token 或客户端证书
kubectl config set-credentials dev-user \
  --token=<token> \
  --kubeconfig=dev-user.kubeconfig

# 3. 上下文：把集群和用户关联起来
kubectl config set-context dev-user@k8s \
  --cluster=k8s --user=dev-user --namespace=team-a \
  --kubeconfig=dev-user.kubeconfig

# 4. 启用这份上下文
kubectl config use-context dev-user@k8s --kubeconfig=dev-user.kubeconfig
```

说明一下 `--kubeconfig=dev-user.kubeconfig`：它指定的是**输出文件**，不需要事先存在——kubectl config 发现文件不存在会自动创建，四条命令依次往里追加 clusters、users、contexts、current-context 四个部分，全部跑完才是一份完整的 kubeconfig。不带这个参数的话，这些命令会直接修改你默认的 ~/.kube/config，把管理员自己的配置污染掉。

换一个用户，就把这四条命令里的 dev-user、\<token\> 和输出文件名全部换成新用户的再跑一遍。多租户/多成员场景就靠这样批量生成：每人一份文件，凭证互不可见，再配合各自的 RoleBinding，权限隔离就完整了。

### kubeconfig 详解与多集群配置

打开 kubeconfig，核心是 clusters、users、contexts 三段：

```yaml
apiVersion: v1
kind: Config
clusters:                              # 集群连接信息
- cluster:
    certificate-authority-data: <CA证书 base64>
    server: https://10.0.0.1:6443
  name: prod-cluster
users:                                 # 用户认证信息
- user:
    token: <token，也可以是 client-certificate-data 证书>
  name: dev-user
contexts:                              # 集群与用户的映射关系
- context:
    cluster: prod-cluster
    user: dev-user
    namespace: team-a                  # 可选：默认 namespace，不配则用 default
  name: dev-user@prod-cluster
current-context: dev-user@prod-cluster # 当前生效的 context
```

- clusters：API Server 地址 + CA 证书
- users：token 或证书等认证信息
- contexts：把某个 cluster 和某个 user 组合起来起个名字，namespace 字段决定这条 context 下 kubectl 默认操作哪个命名空间

**多集群单文件管理**：一个 kubeconfig 可以装多个集群——把 clusters、users 里对应的配置块各复制一份，改掉名称、server 地址和凭证即可。注意名称必须唯一，建议用 `<环境>-cluster` 和 `<角色>-user` 的格式（如 prod-cluster、dev-user），context 命名用 `用户@集群`，一眼能看出"谁在哪"。

管理建议：生产环境用独立配置文件（--kubeconfig 或 KUBECONFIG 环境变量指定），开发测试环境可以多集群塞一个文件；执行重要操作前先 current-context 确认自己在哪个集群——删错集群是比删错资源更贵的事故。

### 串起前面的概念
Role、User、Group、SA、kubeconfig、token/证书——这些东西每章都出现过，现在把它们放进一条命令的完整生命周期里，看各自站在哪个位置。以"开发者 alice 敲下 `kubectl get/create pods -n team-a`"为例：
```text
kubectl get/create pods -n team-a
        │
        ▼
① kubeconfig（客户端侧：连哪、我是谁）
   current-context 选中一条 context
     → cluster 段：连哪个 apiserver
     → user 段：取出凭证（token 或证书）
        │  请求头带上 Authorization: Bearer <token> / 客户端证书
        ▼ 
② 认证层（apiserver：凭证换身份）
   校验凭证（证书验签 / OIDC JWT 验签 / SA token 校验）
   产出：用户名 alice + 组 dev-team
   （User/Group 不是资源，只是这一步产出的字符串）
        │
        ▼
③ 授权层 RBAC（字符串匹配）
   alice 或 dev-team 出现在某条 Binding 的 subjects 里？
     → 沿 roleRef 找到 Role/ClusterRole
     → 查 rules：pods + get/create 在不在 resources/verbs 里？
   任一条 Binding 命中 → 放行；全不命中 → 403
        │
        ├── 读请求（get/list/watch）：到这就结束了
        │     从 apiserver 缓存/etcd 读出数据，原路返回给 kubectl
        │     ——没有准入控制，更不会写 etcd
        │
        └── 写请求（create/update/delete）：还要再走两步
              准入控制（LimitRange/ResourceQuota 校验）
              → 写入 etcd → 控制器看到变化，开始调谐
```

对照这条链路，每个对象的角色就清晰了：

| 对象                             | 在链路中的位置                            | 是 K8s 资源吗                     |
| -------------------------------- | ----------------------------------------- | --------------------------------- |
| kubeconfig                       | ① 客户端侧的"身份证+通讯录"               | 否，本地文件                      |
| token / 证书                     | ①② 之间的凭证，装在 kubeconfig 的 user 段 | 否（SA token 存在 Secret 资源里） |
| User / Group                     | ② 的产出、③ 的匹配对象                    | 否，纯字符串                      |
| Role / ClusterRole               | ③ 里的权限规则（verbs+resources）         | 是                                |
| RoleBinding / ClusterRoleBinding | ③ 里把主体和规则牵线的对象                | 是                                |
| ServiceAccount                   | 集群内程序的"账号"，token 的签发主体      | 是                                |
一句话总结：**凭证装在 kubeconfig 里，认证层把凭证换成 User/Group 字符串，RBAC 拿字符串去匹配 Binding 牵出来的 Role 规则**——五类对象各司其职，缺一环请求就走不通。


## RBAC 管理与实战

前面解决了"身份从哪来、权限怎么定义、凭证怎么装"，这一章解决"日常怎么管"：用 kubectl 直接操作 RBAC 资源、复用内置角色，再把所有东西串成开头提到的真实场景。

### 使用 kubectl 管理 RBAC 资源

四种 RBAC 资源都有对应的命令式创建方式，日常管理不必每次写 yaml：

```bash
# 创建角色（namespace 级 / 集群级）
kubectl create role viewer --verb=get,list,watch --resource=pods -n team-a
kubectl create clusterrole node-reader --verb=get,list,watch --resource=nodes

# 绑定，--user / --group / --serviceaccount 对应三种主体
kubectl create rolebinding alice-view --role=viewer --user=alice -n team-a
kubectl create rolebinding dev-team-view --clusterrole=view --group=dev-team -n team-a
# 集群级绑定：全集群生效（如运维组）
kubectl create clusterrolebinding ops-admin --clusterrole=admin --group=ops-team

# 查看与排查
kubectl get role,rolebinding -n team-a
kubectl describe rolebinding alice-view -n team-a   # 能看到绑了谁、绑了什么角色

# 验证权限：--as 模拟指定用户身份，排障利器
kubectl auth can-i get pods -n team-a --as alice
```

内置的四个 ClusterRole（view/edit/admin/cluster-admin）在资源定义一章已经介绍过，日常授权直接拿来用，不必自己写 rules。

### 实战：集群通用权限管理与多用户管理

把 SA、kubeconfig、内置角色串起来，过一遍开头提到的几个典型场景。前提：用户身份经认证体系（证书/OIDC/token）进来，各自的 kubeconfig 已生成。

**场景一：测试人员只读测试环境。** 最简单的一条绑定：

```bash
kubectl create rolebinding tester-view --clusterrole=view --user=tester -n test
```

**场景二：生产环境只能查看程序日志。** view 范围太宽（能看所有资源），生产排障往往要求"只能看日志，其他一概不能动"，用自定义 Role 做最小授权：

```bash
kubectl create role log-reader --verb=get,list,watch --resource=pods,pods/log -n prod
kubectl create rolebinding oncall-logs --role=log-reader --group=oncall -n prod
```

只有 pods 和 pods/log 的读权限，看日志、定位问题够用，别的都碰不了。

**场景三：开发人员修改部分资源。** edit 能改 namespace 里所有资源，如果只允许开发改 Deployment（Service、ConfigMap 不许动），就在 verbs 和 resources 上做减法：

```yaml
rules:
- apiGroups: ["apps"]
  resources: ["deployments"]
  verbs: ["get", "list", "watch", "create", "update", "patch"]
```

写进 Role 再 RoleBinding 绑给开发组即可。

**场景四：多租户受限管理员。** 租户管理员要能在自己的 namespace 里建资源、管权限，但绝不能碰集群级对象——内置 admin 正好是"namespace 级管理员"：

```bash
kubectl create rolebinding tenant-a-admin --clusterrole=admin --user=tenant-a-admin -n tenant-a
```

RoleBinding 把 admin 的能力圈死在 tenant-a 内：租户管理员在里面想建什么建什么，想建 ClusterRole 或访问别人的 namespace 都会被 RBAC 拒绝。这就是"多租户受限管理员"的标准落地。

**场景五：应用程序操作集群。** CI/CD 流水线要部署应用、监控组件要采集指标，程序的身份是 SA：

```bash
# 给 ci 命名空间下的 jenkins SA 绑 edit，允许它在 prod 部署应用
kubectl create rolebinding jenkins-deploy --clusterrole=edit \
  --serviceaccount=ci:jenkins -n prod

# 验证 SA 权限，主体写法：system:serviceaccount:<ns>:<sa名>
kubectl auth can-i create deployments -n prod --as system:serviceaccount:ci:jenkins
```

流水线 Pod 侧要指定用哪个 SA（不写就是 default）：

```yaml
spec:
  serviceAccountName: jenkins   # 对应上面绑定的 ci:jenkins
```

为什么必须绑：流水线 Pod 不指定 serviceAccountName 就用 default，而 default 没绑任何角色，程序调 API 全是 403——认证章说的"程序默认无权限、要干活先绑定"就在这里落地。绑定之后，Pod 挂载的 token 认证出 system:serviceaccount:ci:jenkins，字符串匹配命中 subjects 里的 SA 条目，kubectl apply 才能跑通。给程序授权和给人授权用的是同一套 Role + Binding，差别只在主体填 ServiceAccount 还是 User/Group。

五个场景合起来就是 RBAC 日常工作的全部套路：**先用最小权限定义角色（内置或自定义），再用 Binding 圈定主体和范围**。人的身份靠认证体系换来的用户名+组，程序的身份靠 SA，授权逻辑完全一致。