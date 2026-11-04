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

## 微服务
```go
// video.proto
yntax = "proto3";

// 视频服务契约：拆服务后由 video-svc 提供，供 user/interaction 服务读取视频信息与统计。
package video;

//后续video_grpc.pb.go和video.pb.go文件会根据video.proto生成的路径
//video.pb.go只负责 `message`：结构体、编码解码、marshal/unmarshal。和 gRPC 无关，单纯 protobuf 序列化代码。
//video_grpc.pb.go:- `VideoServiceServer` 接口（你在 video-svc 里要实现这个接口）`VideoServiceClient`（user /interaction 服务拿来调用的客户端）每个 `rpc` 方法的包装
option go_package = "fake_tiktok/api/pb";

service VideoService {
  rpc GetVideo(GetVideoReq) returns (VideoBrief);
  rpc GetVideos(GetVideosReq) returns (GetVideosResp);
  rpc ListUserVideos(ListUserVideosReq) returns (VideoListResp);
  rpc GetUserStats(GetUserStatsReq) returns (UserStats);
  rpc IsVideoOwner(IsVideoOwnerReq) returns (BoolResp);
}

message GetVideoReq {
  uint64 video_id = 1;
}

message GetVideosReq {
  repeated uint64 video_ids = 1;
}

message VideoBrief {
  uint64 id = 1;
  string author_id = 2;
  string title = 3;
  string status = 4;
  string cover_url = 5;
  string play_url = 6;
  double duration = 7;
  int64 play_count = 8;
  int64 like_count = 9;
  int64 comment_count = 10;
  int64 created_at_unix = 11;
  string description = 13;
}

message GetVideosResp {
  repeated VideoBrief videos = 1;
}

message ListUserVideosReq {
  string user_id = 1;
  int32 page = 2;
  int32 page_size = 3;
}

message VideoListResp {
  repeated VideoBrief videos = 1;
  int64 total = 2;
}

message GetUserStatsReq {
  string user_id = 1;
}

message UserStats {
  int64 video_count = 1;
  int64 total_play_count = 2;
  int64 total_like_count = 3;
}

message IsVideoOwnerReq {
  uint64 video_id = 1;
  string user_id = 2;
}

message BoolResp {
  bool ok = 1;
}
```

### Java 客户端调用 video 服务的例子
上面的 proto 由 Go 实现为 video-svc，现在看 Java 侧（比如 user-svc）怎么调它。关键前提：**Java 的代码也由同一个 video.proto 生成**（protoc 加 Java 插件），方法签名天然一致：
``` java
// ① 建立连接：基于 HTTP/2 的长连接 channel，地址来自注册中心
ManagedChannel channel = ManagedChannelBuilder
        .forAddress("10.0.0.2", 9002)
        .usePlaintext()                // 生产环境换 TLS
        .build();

// ② 拿到 proto 生成的客户端 stub：方法名、参数、返回值和 proto 里定义的一一对应
VideoServiceGrpc.VideoServiceBlockingStub stub = VideoServiceGrpc.newBlockingStub(channel);

// ③ 构造请求消息（builder 是 protobuf 生成类的标准写法）
GetVideoReq req = GetVideoReq.newBuilder()
        .setVideoId(12345L)
        .build();

// ④ 发起远程调用——写法和调本地方法没区别，序列化、网络传输、反序列化全被 stub 屏蔽
VideoBrief video = stub.getVideo(req);
System.out.println(video.getTitle());
```
Go 侧同样零对接成本：它实现的就是 `video_grpc.pb.go` 生成的 `VideoServiceServer` 接口，收到请求后执行自己写的 `GetVideo` 本地函数。
### 为什么不同语言写的微服务也能通信
因为双方在三个层面约定了**与语言无关的标准**——语言只影响"生成什么代码"，不影响"线上跑什么字节"：
- **接口契约（proto IDL）**：同一个 .proto 文件，Java 侧 protoc 生成 stub，Go 侧生成 Server 接口。相当于同一份合同的两种语言译本，方法名、字段、含义完全对齐。
- **序列化格式（Protobuf wire format）**：字节流怎么编码由 proto 规定（字段编号 + wire type + 值），和语言无关。Java 编码出的 `video_id = 1` 是"字段编号1 + varint值"，Go 按编号1就能解出同一个值——**网络上传输的是字节，不是任何语言的对象**。
- **传输协议（HTTP/2）**：所有主流语言都有标准实现，帧格式一致，保证字节从一端完整到达另一端。

类比：两国通信不靠"说同一种语言"，靠"约定同一套密码本（Protobuf）+ 同一套信封格式（HTTP/2）+ 同一份业务合同（proto）"。字节流本身没有语言属性——这就是 Java user-svc 能直接调 Go video-svc 的根本原因，也是微服务允许各团队自由选语言栈的前提。
### 一次完整调用的流程（含序列化/反序列化）
```text
Java user-svc                                      Go video-svc（gRPC server 监听 :9002）
─────────────                                      ─────────────────────────────────────
① 建立连接
   ── TCP 握手 + HTTP/2 握手（gRPC channel 长连接）──────────────────────────────▶

② 业务代码 stub.getVideo(req)
③ 序列化：Java GetVideoReq 对象 ──Protobuf编码──▶ 二进制字节流
   ── HTTP/2 DATA 帧发送 ─────────────────────────────────────────────────────▶
                                                       ④ 反序列化：字节流 ──Protobuf解码──▶ Go 结构体 GetVideoReq
                                                       ⑤ 调用本地函数 VideoService.GetVideo()
                                                          （查 DB，组装 VideoBrief）
                                                       ⑥ 序列化：Go VideoBrief 结构体 ──Protobuf编码──▶ 字节流
   ◀────────────────────────── HTTP/2 DATA 帧（响应）───────────────────────────
⑦ 反序列化：字节流 ──Protobuf解码──▶ Java VideoBrief 对象
⑧ stub.getVideo() 返回，业务代码拿到结果
```
序列化/反序列化是**成对镜像**的：发送端 ③ 编码出的格式，接收端 ④ 按同一格式解码；⑥ ⑦ 同理。③ 到 ⑥ 之间（跨网络那段）流动的永远是语言无关的二进制字节流。
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