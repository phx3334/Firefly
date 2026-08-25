---
title: 初步学习k8s
published: 2026-08-25T20:11:23+08:00
description: 认识k8s的结构，学习k8s的核心组件和使用 
image: './images/a20.avif'
tags: [k8s]
category: '计算机技术'
draft: false
lang: '中文'
---


## 定义
k8s是一个开源的容器编排平台，利用它可以非常方便，高效地管理多个容器。对比一下不用k8s的情况。
| 痛点 | k8s 的解法 |
| --- | --- |
| 容器挂了没人管 | **自愈**：自动重启失败的容器，替换不健康的节点 |
| 流量大了扛不住 | **自动伸缩**：根据 CPU/内存或自定义指标水平扩展 Pod 数量（HPA） |
| 部署新版本要停机 | **滚动更新**：逐个替换旧版本，随时可以回滚 |
| 服务之间怎么找到彼此 | **服务发现 + 负载均衡**：通过 Service/DNS 自动路由流量 |
| 配置和密钥散落各处 | **ConfigMap / Secret** 统一管理，随应用挂载 |
| 服务器资源浪费 | **调度器**把 Pod 合理分配到各节点，最大化资源利用率 |
| 多环境（测试/生产）不一致 | **声明式配置**（YAML 描述期望状态），集群自动收敛到该状态 |

## 结构
k8s属于主从模型（Master-Slave架构），构成k8s集群的物理主机分成两类角色，一类是master、另一类是Slave
### Master节点/主节点
master节点负责集群的调度、管理和运维，是k8s集群的总控中心，高可用集群建议部署至少3台
Master，master节点通过与Slave节点不间断通信来维持整个集群的健康状态，集群中各个资源的
状态信息存放于etcd中。若master节点不可用，则我们便无法管理k8s集群中的各种资源
Master上部署的组件有apiserver、scheduler、controller-manager等管理组件，此外通常还需要
部署etcd
### Slave节点/从节点/工作节点/worker节点：
Slave节点是集群中的运算工作负载节点，通常也被称为Worker Node节点，简称Node节点，
node节点上的kubelet组会持续将本机的状态汇报给master节点的apiserver然后存储在etcd中，
当某个Node宕机时，其上的工作负载会被Master控制自动转移到其他Node节点上去
Slave节点上部署有kubelet、kube-proxy、容器引擎等工作组件。

## 核心概念
### 名称空间
我们在部署完k8s集群后，该集群会管理一系列k8s相关的资源，例如控制器、pod、svc、ingress、
serviceAccount、psp、存储卷、configmap等，为了能够很好地将这些资源组织起来，k8s引入了
namespace。
namespace本质就是一个隔离的空间，用于将一组资源组织起来，并与其他名称空间相隔离，这么做的
好处很明显  
- 当很多人共用一套k8s集群时，可以用namespace将彼此使用的资源隔离开，互不干扰
- 一组资源被组织到一个namespace中后，更方便k8s进行统一性的管理配置，例如资源配额、访问控制等  
名称空间-----》多租户的资源隔离、还能结合k8s的资源配额管理限定不同租户能占用的资源（如cpu使
用量、内存使用量）
### POD
Pod是Kubernetes的最小工作单元。每个Pod包含一个或多个容器。
#### 为什么要有POD
```text
k8s是用来管理容器的，即底层跑应用程序的一定是容器，既然如此，那k8s直接管理容器就好了，为什么还要
搞出来一个POD的概念迷惑众生。
有两个原因
1、封装-》屏蔽底层不同的容器引擎
因为你创建出容器的引擎可能五花八门，导致创建出的容器可能也有所不同，k8s为了能够兼容这些不同的容
器，干脆在容器之上做了一层封装，这层封装的结果就是POD，即无论你是用什么引擎创建出的容器，k8s都会
将其扔进到一个POD里，POD是k8s自己的概念，基于PODk8s开发了很多管理功能，如此，k8s只需要管理自
己的POD即可，这体现的就是一种封装与解耦的思想
举个栗子：
你把容器想象成一条条鱼，不同的容器引擎会创建出不同的容器，这就好比是鱼有不同的品种
POD就好比是盛鱼的箱子，有了POD把鱼封装起来，外部在调用的时候就很容易统一标准了，外部看到的就是一
箱一箱的鱼，如果把k8s当成一个鱼贩子，那有POD的组织之后，鱼贩子的工作就变得简单统一，只需要管理
POD即可。
2、一个应用可能拆解成多个容器，想直接通过本地的IPC空间进行通信
容器的设计思想-》一个容器只启动一个前台进程，只负责干一件事
一个应用有很多事要做，那便需要创建多个容器，这多个容器不想通过网络进行通信，而是直接本地ipc通
信，那就需要放在一起，pod这种可以把多个容器放在一起然后共享一个网络空间的机制便应运而生
```
### 通信与资源共享
Pod中的所有容器使用同一个网络namespace，即相同的IP地址和Port空间。它们可以直接用
localhost通信。同样的，这些容器可以共享存储，当Kubernetes挂载volume到Pod，本质上是将
volume挂载到Pod中的每一个容器

## 核心组件简介
### 从节点上部署的组件
#### 容器引擎
负责具体后端容器运行时的软件，kubernetes支持多个容器运行环境：Docker，Containerd，CRI-O以
及任何实现kubernetes CRI（容器运行环境接口）。
#### kubelet
kubelet有以下功能
- Kubelet是Master节点安插在Node节点上的“眼线”，它会定时向API Server汇报自己Node
节点上运行的服务的状态
- kubelet会接收Master的指示来维护当前工作节点的Pod达到预期状态（比如运行什么容器、运
行的副本数量、网络或者存储、容器的存活和健康检测等容器整个生命周期都归kubelet管）
关于容器的创建：kubelet是通过CRI（container runtime interface）接口来调用容器引擎实现
的，具体见docker文章  
kubelet的GC机制会负责定期清理工作节点上的镜像以及退出的容器
#### kube-proxy组件与service资源
运行有kubelet的节点都会运行kube-proxy组件，kube-proxy负责管理service资源以实现pod的负载均
衡代理，至于service资源为何种物，详解如下
为了实现应用的高可用
- 传统情况，我们会将应用部署为多个副本，然后用一个负载均衡例如nginx来代理这些副本，并且要
监测副本的故障，故障副本要从代理中剔除。  
```text
                                  |------同一个应用的副本1
                                  |
人工维护------>负载均衡（例如nginx）--------同一个应用的副本2
                                  |
                                  |------同一个应用的副本3
```
- 而在k8s中，内置了service资源，你只需要按需创建service来代理你的pod即可，service与nginx代
理的作用一样
```text
                                           |------同一个应用的POD副本1
                                           |
kube-proxy自动维护------>负载均衡（service）--------同一个应用的POD副本2
                                           |
                                           |-------同一个应用的POD副本3
```
至于副本的故障检测、负载均衡代理目标端点的更新均有由k8s自动完成（kubelet检测pod状态汇报给
apiserver组件，然后kube-proxy可以获取pod的状态变化，自动完成sevice代理目标端点的上下线）  
**注意** ：kube-proxy为pod提供的是代理服务，而不是网络，pod的网络是kubelet调用网络插件实现的  

### 主节点部署的组件
#### etcd分布式数据库
Etcd是用go语言开发的一个分布式的k/V存储系统，etcd相当于整个k8s集群的记事本/存储中心，k8s集
群的所有状态都记录在etcd数据库集群中。
ETCD核心使用了RAFT分布式一致性算法，因此通常部署奇数个  
```text
了解raft协议：
一个分布式系统，是由多个节点/实例组成一个整体对外提供服务的，而实际运行过程中，经常会因为各种不可
用因素引发某个节点或实例不可用，进而引发整个集群节点的状态不一致，导致整个集群不可用。
我们需要解决问题的就是：在某个节点故障时，整个集群各个节点的状态能重新一致，从而继续对外提供服
务，raft算法就是用来实现这一点的
为了以容错方式达成一致，我们肯定不可能要求所有服务器100%都达成一致状态，只要超过半数的大多数服务
器达成一致就可以了，假设有N台服务器，N/2+1就超过半数，代表大多数了，这就是raft算法的核心原理
```
**注意** ：：etcd数据库对数据量大小是有限制的，这会影响到集群规模的扩大，node节点增多，相应的master节点
也要增多，master节点上其他组件都不是限制集群规模
的要素，etcd的性能决定了集群可以扩到多大
#### apiserver
k8s所有的状态信息都存放在etcd集群中，而etcd只能被apiserver操作，所以k8s所有其他组件运行时都
只能去访问apiserver才能间接地访问到etcd数据库，因此apiserver是整个K8S集群入口、是k8s所有模
块之间相互通信和数据交互的中心、相当于整个k8s的大脑/大总管/中央枢纽
#### kube-scheduler
实际环境中会有多台机器用于跑容器，如何从中选取最合适的那一台，这就用到了k8s的组件：kube-
scheduler
sheduler会经历预选（选择出符合条件的）与优先（选出资源最优的）两个阶段来选出合适的一个node
节点，然后该node节点上的kubelet会收到请求来调用容器引擎创建pod
#### kube-controller-manager
##### 什么是控制器controller
在K8S集群中，几乎每种特定资源都有特定的Controller控制器负责维护管理。
我们以POD这种资源为例，POD启动后，k8s需要对齐进行自动化管理，例如故障监控与自愈，这都需
要有专门的程序负责维护，这个程序就是k8s的控制器，控制器有内置的、后续你也可以自定义，内置的
控制器种类有deployment、statefulset，daemonset、cronjob等，不同的控制器的有不同的特性，这
是我们后续介绍的一个重点。
##### 什么是控制器的管理器controller-manager
为了把诸多种类的Controller聚合起来进行统一管理、抽取冗余实现降低Controller的实现复杂度，k8s
中诞生了一个contoler-manager的组件，即控制器管理器，它是K8S集群里所有资源对象的自动化控
制中心、是K8S集群中处理常规任务的后台线程。
Controller Manager的负责把所有的Controller聚合起来，一方面可以提供基础设施降低Controller的实
现复杂度，另外一方面就是负责启动和维持Controller的正常运行，监听api-server的事件,然后对不同的
Controller分发事件通知。
控制器管理器与控制器的关系如下：
```text
controller-manager------>多种控制器（deployment、statefulset、cronjob等）------>POD
```
controller-manager负责监视着每一个控制器（控制器通过API Sever监控整个集群的状态），如果控制
器不健康无法工作，那么controller-manager会及时发现并执行自动化修复流程来确保控制器的健康，
使得集群处于预期的工作状态，由于Master有多个，所以controller-manager具有冗余性。  
##### 常见控制器（了解）
k8s中有几十种Controller，这里简单罗列一些Controller
| 控制器 | 作用 |
|--------|------|
| **Node Controller**（节点控制器） | 负责在节点出现故障时进行通知和响应 |
| **Replication Controller**（副本控制器） | 负责为系统中的每个副本控制器对象维护正确数量的 Pod |
| **Endpoints Controller**（端点控制器） | 一个 Pod 的 IP+Port 对应一个 Endpoint 资源。K8s 将多个副本的 Endpoint 加入 Service 管理，这与配置 Nginx 是同样的道理；不同的是，Pod 的下线、重启等引起的 IP 地址变化（即 Endpoint 变化），都会被 K8s 监听到，然后动态更新到 Service 中，负责控制这件事的就是 Endpoint 控制器 |
| **Service Account & Token Controllers**（服务账户和令牌控制器） | 为新的命名空间创建默认账户和 API 访问令牌 |
| **ResourceQuota Controller**（资源配额控制器） | 确保指定的资源对象在任何时候都不会超量占用系统物理资源 |
| **Namespace Controller**（命名空间控制器） | 管理 Namespace 的生命周期 |
| **Service Controller**（服务控制器） | 属于 K8s 集群与外部的云平台之间的一个接口控制器 |
**控制器进程**都只存在于主节点
#### 客户端工具
kubctl这个客户端程序的调用操作都是过kube-apiserver提供的HTTP Restful API接口进行。


## POD创建流程
- 客户端执行kubectl命令，默认读取固定路径~/.kube/config的配置，该配置里记录着你的访问凭证
（本质就是账号密码），还有API Server的ip+port，即kubeclt命令一旦执行就会去配置文件中拿到凭
证，然后去指定的地址访问API Server
- 访问API Server前，先经过Auth模块进行身份认证
- 请求打到API Server，API Server存取Etcd数据库集群（只有API Server可以访问etcd）
- contoller-manager从apiserver获取到创建pod的事件，然后contoller-manager作为控制器的管理
者，会调用具体的控制器从API server获取到kubectl提交过来的关于pod状态的变更、例如副本数增加
一个，然后生成一个创建pod的事件
- scheduler从apiserver获取到创建pod的事件，根据一些预定条件以及整个集群的资源状态选出合适
创建pod的物理节点
- 某个物理node上的kubelet从apiserver获取到了创建pod的任务，会调用容器引擎创建出容器放入
POD中，创建过程中kubelet会调用网络插件为容器创建好网络    
**注意** 1-6流程中并没有提到kube-proxy组件，没错，如果你只是创建pod的话，其实
kube-proxy并不会工作。你需要知道pod只是k8s集群管理的诸多资源中的一种，除了pod外还有很多其
他资源，比如service资源。只有在你用kubectl命令提交创建service资源的时候，kube-proxy组件才会
工作-帮你创建出service资源用于代理pod，此时，外部访问者就可以通过internet->防火墙->kube proxy访问到你的容器


## List-watch机制
在Kubernetes中，list和watch是两种主要的API操作、是一种异步消息处理机制，它们用于让客户端获
取和观察资源的状态。
```text
1、List操作：
List操作是一次性的操作，用于获取集群中某种类型资源的当前状态列表。
例如，你可以列出所有的Pods，或者只列出某个namespace的Pods。
这个操作返回的资源每一项都包括一个resourceVersion字段，表示资源的版本。
2、Watch操作：
Watch操作：Watch操作用于订阅资源的更新事件。客户端在执行watch操作时，可以通过
resourceVersion参数指定开始监听的资源版本，从而避免漏掉在List和Watch操作之间发生的更新。
```
k8s中各组件间协同都采用list-watch机制进行通信。  
这种机制可以确保客户端获取到最新的资源状态，且避免了频繁的轮询造成的开销。  
大致流程如下： 
```text
1、客户端首先执行一次list操作来初始化资源状态
2、然后通过watch操作来持续接收后续的更新
与简单的短轮询相比，这种机制可以更有效地获取资源状态的更新，并减少了网络流量和API服务器的负载。
```
- 首先在controller-manager/scheduler/kubelet启动的时候都会去watch自己关注的资源。
controller-manager对api-server发起ReplicaSet的watch
scheduler发起对Pod desNode=""的watch
kubelet发起对pod destNode="myNode"的watch。
- 用户kubectl创建一个ReplicaSet请求调用Api-server，Api-server将创建replicaSet存储到etcd
中,Api-server同时也获取到创建replicaset的created事件
- controller-manager此刻watch到replicaset创建时间后通过pod模版进行pod创建并持久化到etcd中
- scheduler watch到创建的pod创建事件通过预选和优选策略为pod选定运行的node，并更新pod的
nodeName字段
- 之后kubelet watch到在自己上需要运行pod，调用cri/cni/csi创建pod。
###  List-watch是如何实现的
List的实现比较容易理解其本质就是一简单的列表操作（采用的是短连接），那么Watch是如何实现的
呢? Watch是如何通过HTTP长连接接收apiserver发来的资源变更事件呢?
秘诀就是Chunked transfer. encoding(分块传输编码)，它首次出现在HTTP/1.1。  
```text
相比于http1.0协议的短链接，HTTP/1.1默认所有请求都保持长链接，或称之为持久链接，以便同一个客户
端反复请求需要重复多次建立链接所带来的访问效率低的问题
而持久链接需要服务器在开始发送消息体前先发送Content-Length消息头字段，但是对于动态生成的内容来
说，在内容创建完之前是不可知的，也就是说对于一些很耗时的动态操作，服务器需要等到所有操作完成后，
才能发送数据，显然这样的效率不高。更好的处理方法是，产生一块数据，就发送一块，采用流模式来取代缓
存模式，这就是HTTP/1.1的chunked分块传输。
HTTP/1.1使用分块传输编码，数据会被分解成一系列数据块，并以一个或多个块发送，每一个数据块带上本块长度，最后一个块显示0长度，代表一次响应结束。
```
当客户端调用watch API时, apiserver在response的HTTP Header中设置Transfer Encoding的值为
chunked,表示采用分块传输编码,客户端收到该信息后,便和服务端保持该链接（长连接），并等待下一
个数据块,即资源的事件信息，直到客户主动断链。  
**controller-manager负责启动和维持Controller的正常运行，watch监听api-server,然后对不同的Controller分发事件通知**：
- Controller manager与api-server的通信主要通过两种方式: List和Watch；controller首先通过list
全量获取到关注的资源，存储到本队缓存中，之后通过最新的resourceversion来对资源进行
watch，获取资源的add/update/delete的事件。
- client-go：实现统一管理每种Controller的List和Watch，将收到的event事件放到缓存中，异步分
发给每个Controller的注册的eventHandler。后期通过事件的类型，回调用户注册进来的
eventHandler进行对应事件类型的业务逻辑处理
- List是短连接实现，用于获取该资源的所有object
- Watch是长连接实现，用于监听在List中获取的资源的变化
- api-server检测到资源产生变更时，会主动通知到Controller manager (利用分块传输编码)。
用curl模拟watch:  
```bash
#终端1，在本地机器起一个HTTP 代理，把你本机的请求自动带上集群认证信息，转发给 kube-apiserver，用自己处理认证和证书
$kubectl proxy
#终端2，list出defaullt名称空间下的pods
$curl"127.0.0.1:8001/api/v1/namespaces/default/pods"
#终端2：watch default 下的 Pod 变化
$curl"127.0.0.1:8001/api/v1/namespaces/default/pods?watch=true"
#终端3：创建
$kubectlrunnginx--image=nginx
```

### List-watch设计理念
一个异步消息的系统时，对消息机制有至少如下四点要求
#### 消息可靠性
首先消息必须是可靠的，list和watch一起保证了消息的可靠性,避免因消息丢失而造成状态不一致场景。
具体而言，
List API可以查询当前的资源及其对应的状态(即期望的状态)，客户端通过拿期望的状态和实际的状态进
行对比，纠正状态不一致的资源。
Watch API和apiserver保持-个长链接，接收资源的状态变更事件并做相应处理。
如果仅调用watch API,若某个时间点连接中断，就有可能导致消息丢失，所以需要通过list API解决消息
丢失的问题。
从另一个角度出发,我们可以认为list API获取全量数据，watch API获取增量数据。虽
然仅仅通过轮询list API,也能达到同步资源状态的效果，但是存在开销大，实时性不
足的问题。
#### 消息实时性
消息必须是实时的，list- watch机制下，每当apiserver的资源产生状态变更事件,都会将事件及时的推送
给客户端，从而保证了消息的实时性。
#### 消息顺序性
消息的顺序性也是非常重要的，在并发的场景下，客户端在短时间内可能会收到同一个资源的多个事件,
对于关注最终一致性的K8S来说，它需要知道哪个是最近发生的事件，并保证资源的最终状态如同最近
事件所表述的状态一样。
K8S在每个资源的事件中都带一个resourceVersion的标签,这个标签是递增的数字，所以当客户端并发
处理同一个资源的事件时，它就可以对比resourceVersion来保证最终的状态和最新的事件所期望的状
态保持一致。
#### 高性能
List-watch还具有高性能的特点，
虽然仅通过周期性调用List API也能达到资源最终一致性的效果，但是周期性频繁的轮询大大的增大了
开销，增加apiserver的压力。
而watch作为异步消息通知机制，复用一条长链接,保证实时性的同时也保证了性能。  


**更深层次剖析请看https://bbs.huaweicloud.com/blogs/334436**