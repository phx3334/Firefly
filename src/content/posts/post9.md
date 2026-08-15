---
title: rpc原理和初步认识微服务
published: 2026-08-15T10:21:21+08:00
description: '掌握rpc技术的原理以及它在微服务中的应用'
image: './images/a9.avif'
tags: [计算机网络,微服务]
category: '计算机技术'
draft: false
lang: '中文'
---
 
## 前置
### 本地调用函数的过程
- 函数在编译阶段被编译成机器指令，有一个确定的入口地址。func() 在编译后就意为跳转到那个地址。  
- 执行 call func 指令，把返回地址（call 的下一条指令地址）压栈，然后 RIP 跳转到函数的入口地址  
- 进入 func 后执行序言：先把调用者（比如 main）的栈基址 rbp 压栈保存，再让 rbp 指向本函数栈帧的起点，最后把栈顶 rsp 向下偏移，为局部变量腾出空间  
- 寄存器从栈中取数据，交给cpu执行  
- 函数执行完：返回值放进 RAX 寄存器，然后还原 rsp、弹出 rbp 恢复调用者的栈帧，ret 弹出返回地址跳回调用者继续执行  
**补充** ：rbp（栈基址，是一个基准地址，这个基准地址通过偏移确定数据的位置）,rsp（栈顶指针）,rip（指令指针）等都是不同分工的寄存器  
### IDL(接口定义语言)
远程调用双方可能是不同语言（Java 服务调 Go 服务），没法直接传"对方语言的对象"。IDL 用一套与语言无关的语法，把函数名、参数、返回值描述清楚，双方各自生成自己的代码。
**流程**：
```text
用 IDL 写接口定义
   ↓ 各自生成代码
Java 端生成 Java 的客户端/服务端代码
Go 端生成 Go 的客户端/服务端代码
```
**具体例子**：以"Java 服务调用远程 Go 服务上的获取用户信息函数"为例——Java 端是**客户端（调用方）**，跑在服务器 A；Go 端是**服务端（被调方）**，跑在服务器 B。先写一份契约（`.proto` 文件）：
```protobuf
syntax = "proto3";       // 使用proto3语法，gRPC主流版本
package user;            // 包名，生成代码会以此做命名空间

// 定义gRPC服务，里面声明RPC函数
service UserService {
  // RPC方法：调用方传 GetUserReq，服务端返回 GetUserResp
  rpc GetUserById (GetUserReq) returns (GetUserResp);
}

// 请求消息：调用时传给服务端的数据结构
message GetUserReq {
  int64 user_id = 1;     // 1是字段编号，protobuf序列化用，不是变量顺序
}

// 响应消息：服务端返回给客户端的数据
message GetUserResp {
  int64  user_id   = 1;
  string user_name = 2;
  string email     = 3;
}
```
注意：这里只有"接口长什么样"，没有任何 Java/Go 的东西。然后双方各自用编译工具（`protoc`）生成代码：
```text
        ┌──────────────────────────────────────┐
        │        user.proto（唯一契约）          │
        └──────────────────┬───────────────────┘
                 protoc 编译
        ┌──────────────────┴───────────────────┐
        ▼                                      ▼
  Java 端（客户端/调用方）                  Go 端（服务端/被调方）
  生成：                                  生成：
  • UserServiceGrpc.java（客户端桩）        • user.pb.go（消息 struct）
  • GetUserReq.java / GetUserResp.java    • user_grpc.pb.go（服务接口，待实现）
```
生成的代码不是"翻译"，而是**对着契约各自实现一遍**：Java 端拿到的是 `GetUserReq` 这个类，Go 端拿到的是 `GetUserReq` 这个 struct，它们只是"长得像"，各自语言内部的东西互不感知。
之后双方各自对着自己的代码编程——Java 客户端调用（只认识 Java 的类）：
```java
// ManagedChannel：gRPC连接通道，代表到远端B机器的连接
ManagedChannel channel = ManagedChannelBuilder
    .forAddress("10.0.0.2", 8080)   // 指定Go服务端的IP和端口
    .usePlaintext()                 // 不开启TLS加密，生产环境不要用！仅测试
    .build();

// 阻塞Stub：同步调用桩，protoc根据proto自动生成
UserServiceGrpc.UserServiceBlockingStub stub =
    UserServiceGrpc.newBlockingStub(channel);

// 像本地方法一样调用，底层是网络RPC
GetUserResp resp = stub.getUserById(
    GetUserReq.newBuilder().setUserId(123L).build());
```
Go 服务端实现（只认识 Go 的 struct）：
```go
// Go 服务端（被调方），跑在服务器 B，监听 8080
t// 实现proto生成出来的服务接口
type userServer struct {
    userpb.UnimplementedUserServiceServer // gRPC要求嵌入，兼容接口升级
}

// 实现RPC方法 GetUserById，这是真正业务逻辑
func (s *userServer) GetUserById(
    ctx context.Context,          // gRPC上下文：携带超时、metadata、trace信息
    req *userpb.GetUserReq,       // 自动生成的请求结构体，来自proto
) (*userpb.GetUserResp, error) {
    // 业务逻辑：组装返回响应
    return &userpb.GetUserResp{
        UserId:   req.UserId,
        UserName: "张三",
        Email:    "zhangsan@example.com",
    }, nil
}
```
整个调用链条长这样：
```text
Java 客户端（服务器 A）                        Go 服务端（服务器 B）
┌────────────────────────┐       网络       ┌────────────────────────┐
│ stub.getUserById(123)  │                 │ func GetUserById()     │
│ ① 序列化成字节流        │ ────请求───────▶ │ ② 反序列化还原参数      │
│ ③ 等响应（客户端计时）   │ ◀───响应──────── │ ③ 执行函数返回结果      │
│ ④ 反序列化还原对象      │                 │ ④ 序列化成字节流发回     │
└────────────────────────┘                 └────────────────────────┘
```
注意两端执行的是**各自的代码**：Java 端执行的是 Java 生成的客户端桩，Go 端执行的是 Go 实现的函数体——"调用函数"这件事发生在服务器 B 上。

**关键点**：
- 双方都不知道对方语言：Java 端不知道"对方是 Go"，Go 端也不知道"来的是 Java"，各自只对着自己生成的代码编程
- 中间传输的是**统一的二进制**（Protobuf 序列化），不是任何一方的对象——这就是语言无关的根基，也呼应前面说的"字段编号是线上身份"
- `.proto` 文件是唯一契约，改契约要重新生成代码、重新发布，这也是后面"兼容性"话题的伏笔


## 为什么要有rpc
在微服务架构中，我们经常需要跨服务器调用函数，这个过程就引入了几个需要解决的问题（后续解决方案并不会给出所有，因为我认为有些没必要在这里写出来）
- **网络传输**：定协议，格式
- **序列化和反序列化**：因为网络指认字节流，函数名，参数和返回值这些必须先序列化成字节，远程服务器收到后再反序列化还原。
- **寻址与服务发现**：本地调用不需要知道函数在哪，远程调用必须知道目标服务的 IP + 端口。服务一多、实例一扩容/宕机，还得靠注册中心动态发现。
- **网络不可靠**： 本地调用不会丢包、不会超时，网络会。所以必须处理超时、重试，还要考虑幂等性——重试可能导致函数被执行多次。
- **故障处理**： 被调用的服务器可能宕机、过载。需要容错、降级、熔断，而本地调用没有这个问题。


###  网络传输方案
应用层采用http2协议（优势详情见“http发展”这篇文章）， HTTP/2 走 80/443 端口，能穿过大部分防火墙和负载均衡器；裸 TCP 自定义协议容易被中间设备挡。
### 序列化和反序列化
采用Protobuf序列化。二进制编码、体积小、解析快（对比 JSON 体积大、要逐字符扫描）；
### 寻址与服务发现
微服务引入**注册中心**，用"服务注册与发现"动态解决寻址。
**流程**：
```text
① 服务启动
   ──注册──▶ 注册中心（把自己 IP:端口 上报）
② 客户端要调用
   ──查询──▶ 注册中心：GetUser 在哪？
   ◀─返回── 实例列表 [10.0.0.1:8080, 10.0.0.2:8080, ...]
③ 客户端从列表里挑一个（负载均衡）
   ──调用──▶ 10.0.0.2:8080
④ 实例宕机/下线
   ──心跳超时──▶ 注册中心自动摘除该地址
```
### 处理函数调用的响应超时
客户端会将一个时间限制加入head里面，例如timeout: 3s,然后客户端本地会启动一个计时器，超时就直接放弃这次调用，服务端那边也会根据自己本地目前时间来计算这个超时时间戳，到点自动放弃执行。
