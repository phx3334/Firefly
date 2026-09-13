---
title: 深入Nginx
published: 2026-09-11T20:11:23+08:00
description: 学习io多路复用技术以及进一步学习nginx机制
image: './images/a25.avif'
tags: [nginx]
category: '计算机技术'
draft: false
lang: '中文'
---
## io多路复用机制
### 定义
单个线程，通过内核提供的系统调用可以同时监听多个文件描述符fd,只要其中一个就绪，这个调用就返回，程序去处理就绪的io。  
### select和poll
这2种机制基本都是用户把所有需要监听的fd拷贝一份到内核，内核遍历所有fd,看哪些就绪，对就绪的fd进行一些处理，然后用户代码再遍历所有fd，找到就绪fd，进行处理。每次都是线性扫描，性能很差。
### epoll
#### 主要特点
- 高效性: 使用红黑树存储
- 适用fd : socket，字符设备（如/dev/random）、管道、timerfd和signalfd
- 事件驱动:基于注册事件返回对应事件就绪的文件描述符
#### 核心结构体
```c
typedef union epoll_data {
    void        *ptr;    // 用户数据指针
    int          fd;     // 文件描述符
    uint32_t     u32;    // 32位整数
    uint64_t     u64;    // 64位整数
} epoll_data_t;

struct epoll_event {
    uint32_t     events;      // epoll 事件类型
    epoll_data_t data;        // 用户数据
};
```
`events` 类型（按位标志，可用 `|` 组合）：  
- EPOLLIN：文件描述符可读。对 socket 而言：对端发来新数据、**监听 socket 上有新连接待 accept**、对端正常关闭（FIN 到达，read 返回 0，这个很容易漏判）。
- EPOLLOUT：文件描述符可写。发送缓冲区有空间就能写——所以 socket 刚建立时几乎总是可写的，一般**只在「写满后需要继续写」时才注册它**（见后文阶段四），否则会陷入 busy loop。
- EPOLLHUP：挂起。连接两端都关闭了（如对端 `close()` 后 RST 到达），无需注册也会自动上报，收到后直接关闭 fd，不要再读写。
- EPOLLERR：错误发生。如收到 RST、缓冲区溢出，同样无需注册自动上报，配合 `getsockopt(SO_ERROR)` 取出具体错误码。
一个实用的状态机视角：**IN/OUT 是「你请求的关注」，HUP/ERR 是「内核的强制通知」**。Nginx 的事件处理入口都会先检查 ERR/HUP 再处理 IN/OUT，避免对已死连接做无谓的读写。
#### epoll的三个系统调用
##### epoll_create

```c
int epfd = epoll_create1(0);
```
在内核中创建一个 epoll 实例，返回一个 epfd（本身也是一个 fd）。内核为它分配两个核心数据结构：

- **红黑树**：存放所有待监听的 fd，增删查都是 O(log n)，这就是 epoll 不怕海量连接的根本原因（对比 select 的 1024 上限和 poll 的 O(n) 遍历）。
- **就绪链表（rdllist）**：存放已经就绪的 fd，`epoll_wait` 只需要看这个链表有没有数据，无需遍历全量 fd。

SRE 视角：每个 epoll 实例占用少量内核内存，进程内创建一个即可长期复用，Nginx 每个 worker 循环里就持有一个 epoll 实例贯穿整个生命周期。

##### epoll_ctl

```c
epoll_ctl(epfd, EPOLL_CTL_ADD, fd, &event);  // ADD / MOD / DEL
```

把 fd 挂到红黑树上（ADD）、修改关注的事件（MOD）或移除（DEL）。注册时会在 fd 对应的 socket 上挂一个回调，当该 fd 上有事件发生（如网卡收到数据触发中断，内核协议栈处理完唤醒 socket），内核通过回调把这条 fd **追加到就绪链表**。

这是 epoll 与 select/poll 的本质区别：**事件的收集由内核在事件发生时主动完成（回调机制），而不是用户每次调用时全量轮询**。注册一次、受益多次，大部分场景下 fd 的注册发生在连接建立时，之后不再重复提交。

##### epoll_wait

```c
int n = epoll_wait(epfd, events, maxevents, timeout);
```

阻塞（或带 timeout）等待，**只返回就绪链表里的 fd 及其事件**，复杂度 O(就绪数) 而非 O(总连接数)。这就是所谓的「活连接才付出代价」：10 万条连接里只有 1000 条活跃，每次 wait 也只处理这 1000 条。

Nginx 的 worker 主循环本质上就是：`epoll_wait` → 遍历就绪事件 → 分发给对应模块（读请求/写响应/accept 新连接）→ 再次 `epoll_wait`。

#### 水平触发和边缘触发

这是 epoll 最核心、也最容易踩坑的概念，直接决定了 Nginx 为什么要配合非阻塞 IO 使用。

##### 水平触发（LT，Level-Triggered）——默认模式

只要**接收缓冲区里还有数据没读完**，每次调用 `epoll_wait` 都会持续返回 EPOLLIN。可以把它理解为电平信号：信号保持高电平，就一直上报。

- 优点：编程简单、不容易丢事件。一次没读完没关系，下次还会提醒你。
- 缺点：如果应用处理慢、数据一直不读完，同一个 fd 会在每次 wait 中反复出现，**浪费 CPU 且可能饿死同链表里的其他连接**。

##### 边缘触发（ET，Edge-Triggered）——`EPOLLET`

只在 fd 状态**发生变化**（从无数据到有数据，即空闲→就绪的「跳变沿」）时上报**一次**。即使缓冲区里还有大量数据没读完，内核也不会再次提醒。

- 优点：同一个 fd 只唤醒一次，减少 `epoll_wait` 的重复唤醒，高并发下降低 CPU 和上下文切换开销，这是 Nginx、Redis 等高性能服务选择 ET 的原因。
- 代价与铁律：**必须一次性把数据读干净**。标准做法是把 fd 设为非阻塞，循环 read 直到返回 `EAGAIN`/`EWOULDBLOCK`（缓冲区暂时无数据）为止。写同理，写不下去了（EAGAIN）就重新注册回 epoll，等可写事件再继续。

##### SRE 视角的对比总结

| 维度 | LT | ET |
|------|-----|-----|
| 上报时机 | 只要就绪就上报 | 仅状态跳变时上报一次 |
| 读取要求 | 可分多次读 | 必须循环读至 EAGAIN |
| fd 类型 | 阻塞/非阻塞均可 | 必须非阻塞（否则死循环读风险） |
| 唤醒次数/开销 | 高 | 低 |
| 编程复杂度 | 低 | 高（漏读事件 = 连接卡死） |
| 典型使用者 | 大多数库的默认模式 | Nginx、Redis、Netty |

运维排障提示：如果线上出现「连接established但迟迟无响应、CPU 空转或连接堆积」，在 ET 模型下首先要怀疑事件没有一次读/写干净，导致状态机卡在中间——这也是压测时 Nginx worker 连接数达到上限（worker_connections 报错）后行为异常的经典原因之一。

#### 一次网络请求事件的全流程

以「客户端向 Nginx 发起一次 HTTP GET 请求」为例，从网卡中断一路追踪到用户态处理，串起三次握手、epoll 内部机制和用户态代码的协作。

##### 阶段一：三次握手与连接就绪（内核态）

1. 客户端发送 `SYN` 包 → 网卡收到后通过 **DMA** 将帧写入内核内存的 RingBuffer，随后发出**硬中断**通知 CPU。
2. CPU 执行硬中断处理程序，做最少量的工作（把数据挂到软中断队列、触发 NAPI 轮询），立刻返回；后续重活交给**软中断（NET_RX）**处理——这是 Linux 为避免中断风暴的设计：**上半部快进快出，下半部慢慢消化**。
3. 软中断中，内核协议栈解析 IP/TCP 头，校验通过后进入 TCP 层：监听 socket 处于 `SYN_RECV` 状态，将连接放入**半连接队列**，回发 `SYN-ACK`。
4. 客户端回 `ACK`，内核校验后连接进入**全连接队列（accept queue）**，TCP 状态置为 `ESTABLISHED`。
5. **关键点**：TCP 层通过 socket 注册的回调（`sk->sk_data_ready` 链路）触发 epoll 的回调，把**监听 fd 挂到 epoll 的就绪链表**上——注意此时数据还没被任何用户程序「看到」，监听 fd 已经就绪。

SRE 排障关联：`ss -lnt` 的 `Recv-Q/Send-Q`（对监听 socket 就是全连接队列当前值/上限，对应 `somaxconn` 与 Nginx 的 `listen backlog`），Recv-Q 持续逼近 Send-Q 即溢出，意味着用户态 accept 太慢或突发流量过大。

##### 阶段二：epoll_wait 唤醒与 accept（内核→用户态）

6. Nginx worker 此前一直阻塞在 `epoll_wait` 上（或正在处理别的事件）。内核发现就绪链表非空，**唤醒**阻塞的 worker（从等待队列摘下，重新调度）。
7. `epoll_wait` 返回，就绪数组中携带监听 fd 和 `EPOLLIN`。worker 调用 `accept4()` 从全连接队列取出连接，内核新建一个**已连接 socket（conn_fd）**，四元组 `(src_ip, src_port, dst_ip, dst_port)` 唯一标识它。
8. worker 将 conn_fd 设为**非阻塞**，通过 `epoll_ctl(EPOLL_CTL_ADD)` 把它挂入红黑树并注册关注事件（Nginx 默认 LT，或配置 `accept_mutex` 控制只有一个 worker 抢 accept，避免惊群）。

**惊群问题**值得展开：多个 worker 同时阻塞在监听 fd 上，一个连接到来会唤醒所有 worker，但只有一个能 accept 成功，其余白白消耗一次上下文切换。Linux 后来的 `EPOLLEXCLUSIVE` 和 `SO_REUSEPORT`（每个 worker 独立监听，内核按四元组哈希分流）就是针对它的优化，Nginx 的 `reuseport` 指令即对应后者。

##### 阶段三：请求读取与内核缓冲区流转

9. 客户端发送 HTTP 请求报文 → 同样经过网卡 → DMA → 硬中断 → 软中断 → 协议栈，TCP 按序号重组、校验后，数据放入该 conn_fd 对应 socket 的**接收缓冲区（sk->sk_receive_queue）**。
10. 同样的回调链再次触发：conn_fd 被挂入就绪链表，worker 的 `epoll_wait` 返回 `EPOLLIN`。
11. worker 调用 `read()`：**数据从内核接收缓冲区拷贝到用户态 buffer**。ET 模式下循环 read 到 EAGAIN；LT 模式下读完即可，没读完下次还会提醒。
12. Nginx 解析 HTTP 请求行、头部、body，根据 `Host` + `URI` 匹配 server/location 块，走配置好的处理流程（静态文件、proxy_pass、fastcgi 等）。

##### 阶段四：响应写回与事件循环收尾

13. 若是静态文件且开启了 `sendfile`：数据**在内核中从页缓存直接流转到 socket 发送缓冲区**（配合网卡 SG-DMA 甚至零拷贝到网卡），不经过用户态，减少两次拷贝和两次上下文切换。
14. `write()` 将响应从用户态 buffer 写入**发送缓冲区**，内核协议栈分段、加 TCP 头，经软中断 → 网卡 DMA 发出。
15. 若发送缓冲区已满（对端接收窗口小、链路慢），`write()` 返回 EAGAIN，worker 在该 conn_fd 上注册 `EPOLLOUT`，等内核把积压数据发出去、缓冲区腾出空间后触发可写事件，**续写剩余部分**——Nginx 内部的 ngx_output_chain/ngx_writev 就是在这套事件驱动下分片发送的。
16. 响应发送完成，若 `keepalive` 开启，连接保留在红黑树中等待下一个请求；否则 worker `close(conn_fd)`，内核发起四次挥手（主动关闭方经历 `FIN_WAIT_1 → FIN_WAIT_2 → TIME_WAIT`）。`epoll_ctl(DEL)` 移除 fd。

##### 全流程时序速览

```text
网卡 ←DMA→ RingBuffer → 硬中断 → 软中断(NET_RX)
  → TCP协议栈(握手/重组) → socket接收缓冲区
  → epoll回调挂就绪链表 → 唤醒epoll_wait
  → 用户态: accept / read / 业务处理 / write
  → socket发送缓冲区 → 软中断(NET_TX) → 网卡发出
```

贯穿始终的主线只有两条：**数据面**走 DMA → 内核缓冲区 → 用户态（或 sendfile 直通）；**控制面**走中断 → 协议栈 → epoll 回调 → 唤醒用户线程。Nginx 单机扛几十万并发连接的本质，就是控制面只让「真正有事件的连接」唤醒 worker，数据面能不拷贝就不拷贝（sendfile），用户线程能不阻塞就不阻塞（全程非阻塞 + 事件驱动）。

##### SRE 视角的内核参数速查

| 现象 | 相关参数/指标 | 常用命令 |
|------|--------------|----------|
| 握手丢包、连接建立慢 | `somaxconn`、Nginx `listen backlog`、`net.ipv4.tcp_max_syn_backlog`、`syncookies` | `ss -lnt`（看 Recv-Q 是否逼近 Send-Q，逼近即全连接队列溢出）；`ss -lnt`（看 Recv-Q 是否逼近上限）；`sysctl net.core.somaxconn` |
| accept 跟不上突发 | 全连接队列溢出计数（`ss -lnt` 的 Recv-Q）、worker 数与 `accept_mutex`/`reuseport` | `ss -lnt state listening`（Recv-Q ≈ Send-Q 即溢出）；`ps -eo pid,psr,cmd \| grep nginx`（看 worker 分布） |
| 大量 TIME_WAIT 占端口 | 连接复用（upstream keepalive）、`tcp_tw_reuse`、端口范围 `ip_local_port_range` | `ss -s`（总览各状态连接数）；`ss -ant state time-wait \| wc -l`；`sysctl net.ipv4.ip_local_port_range` |
| 事件处理 CPU 高 | `epoll_wait` 频率、ET vs LT 选择、惊群唤醒开销 | `top -H -p $(pgrep -d, nginx)`（定位热点 worker/线程）；`pidstat -t -p <pid> 1`（上下文切换）；`perf top -p <pid>`（火焰图看热点函数） |
| 发送慢/内存堆积 | 发送缓冲区 `tcp_wmem`、Nginx `sendfile`/`tcp_nopush`、对端接收窗口 | `ss -ntm state established '( dport = :443 )'`（看 skmem 发送缓冲区积压）；`cat /proc/net/snmp \| grep Tcp`；`strace -c -p <pid>`（看 write/sendfile 返回 EAGAIN 频率） |


## Nginx事件驱动模型

### Master-Worker 进程模型

Nginx 采用经典的 Master-Worker 多进程架构：

- **Master 进程**：不处理任何业务请求，只做「管理」——读取并校验配置、绑定监听端口、fork 出 worker、维护 worker 生命周期（心跳监控、崩溃后自动拉起）、接收 SIGHUP 等信号实现平滑重载/平滑升级。
- **Worker 进程**：真正干活的角色，每个 worker 是**单线程事件循环**，内部持有一个 epoll 实例，处理数千条连接。worker 数量通常等于 CPU 核数（`worker_processes auto`），配合 CPU 亲和性（`worker_cpu_affinity`）绑定核，避免跨核调度带来的缓存失效。

这种模型的取舍很明确：**用多进程隔离故障与内存空间，用单线程事件循环避免多线程的锁竞争与上下文切换**。一个 worker 崩溃不会影响其他 worker，Master 秒级拉起新 worker，连接只是短暂抖动；而单线程内没有线程安全问题，不需要给每个连接加锁。

SRE 视角：这也解释了为什么 `worker_rlimit_nofile` 必须调大（每个 worker 的 fd 上限 = 每连接至少 1 个 fd），以及为什么 Nginx 进程本身内存占用极低——连接的元数据是预分配的固定大小结构，而不是动态堆分配。

### 事件循环与事件分发

Worker 的主循环（ngx_process_events_and_timers）本质是一个固定框架：

```text
1. epoll_wait(超时 = 最近一个定时器的时间)
2. 遍历就绪事件，放入事件队列
3. 处理事件: 读事件 → 解析请求；写事件 → 发送响应
4. 处理定时器: 连接空闲超时、上游超时、日志 flush 等
5. 回到 1
```
几个关键设计：

- **事件与模块解耦**：epoll 只是事件「采集器」，Nginx 抽象出 ngx_event_layer（epoll/kqueue/select 等 10 余种实现按平台编译期选择），上层 HTTP 模块只关心「这个连接的读事件发生了」，不关心底层是哪个多路复用实现。所以同一段代码在 Linux 上跑 epoll、FreeBSD 上跑 kqueue，行为一致。
- **epoll_data 复用技巧**：注册时通过 `epoll_data.ptr` 直接挂 connection 结构体指针，事件返回时零查找拿到连接上下文——不需要像 select 那样拿 fd 反查数组，这是 O(1) 的。
- **定时器红黑树**：所有超时任务（如 `keepalive_timeout` 到期回收连接）挂在定时器红黑树上，epoll_wait 的 timeout 参数取最近超时时间，保证既不空转也不延误。

### 异步非阻塞与状态机

Nginx 对连接的处理不是「读完→处理→写完」的串行思维，而是**状态机驱动**：一个请求的生命周期被拆成 READ_REQUEST → PROCESS → WRITE_RESPONSE 等阶段，每个阶段可能只完成一小片（比如 read 只读到半个 HTTP 头），剩余工作挂起，等下一次事件到来再从断点继续。

这正是处理慢客户端（弱网、移动端）的关键：一个拖慢 100 秒的请求只是占住一条连接的事件状态，**不占用 CPU**；

代价是编程模型复杂：任何阻塞调用（比如 worker 里调了一个同步 DNS 解析）都会卡住整个 worker 的所有连接。所以 Nginx 里连 DNS 都必须是异步 resolver，所有文件读都用线程池（`aio threads`）卸载。

## Nginx内存管理机制

### 为什么不用 malloc 而要自建内存池

请求级别的内存分配极其频繁（解析一个 HTTP 头部就要分配几十次），而一条请求的生命周期是明确的：**请求结束，所有相关内存一次性释放**。基于这个特征，Nginx 自建了 ngx_pool：
- 分配只需移动指针（近似 O(1)），不逐块 free；
- **统一销毁**：请求/连接结束时调用 `ngx_destroy_pool` 一次释放整片内存，杜绝内存泄漏（忘了 free 也没关系，池销毁时全收）。
代价是「只大不小」：池内小对象无法单独归还，所以**长生命周期的大对象**（如 upstream 配置）不会放池里，避免内存膨胀。

### 三层内存结构

| 层级 | 池 | 生命周期 | 典型内容 |
|------|-----|---------|---------|
| 全局 | master 启动时分配 | 整个进程生命周期 | 配置结构体、模块数组 |
| 连接 | connection 的 pool | 一条 TCP 连接 | 连接元数据、keepalive 累积的少量残留 |
| 请求 | request 的 pool | 一次 HTTP 请求 | 解析后的头部、URI、响应 header/buffer |

请求池挂在连接池下，请求结束先销毁请求池，连接 keepalive 复用；连接关闭再销毁连接池。**层级化 + 统一销毁**是 Nginx 内存管理的核心思想，这也是它作为反向代理能长期稳定运行、极少内存泄漏的结构性原因——绝大多数分配都跟着请求走，请求一结束全部回收。

### 大块与小块的分配策略
- 小块（< 页大小）：直接在池内分配。池按链表串起多个内存块，当前块放不下就新申请一块（通常 2 倍扩容）挂到链表尾。
- 大块：直接走 `malloc`/`mmap` 单独分配，只在池里挂个引用（`ngx_pool_large_t` 链表），销毁时统一释放。避免小池被一个 10MB 的响应体撑爆。

### 内存相关的运维指标与排障

| 现象 | 排查方向 | 常用命令 |
|------|---------|----------|
| worker RSS 缓慢增长不回落 | 有模块把长生命周期对象挂到了请求池（第三方模块常见 bug），用 valgrind/Jemalloc 分析 | `ps -o pid,rss,vsz,cmd -C nginx`（对比各 worker RSS 是否均匀增长）；`pmap -x <pid> \| tail -1`；`strace -e trace=brk,mmap,munmap -p <pid>`（看分配是否只增不减） |
| 大量小文件响应内存占用高 | `proxy_buffering`/`output_buffers` 配置，或未开 sendfile 导致数据绕行用户态 | `nginx -T \| grep -E 'sendfile\|buffering'`；`strace -e trace=sendfile,read,write -p <pid> -c`（确认是否走 sendfile）；`free -h && cat /proc/meminfo \| grep -i page` |
| 连接数暴涨后内存陡增 | 每个 connection 固定开销 × 连接数（预分配模型），对照 `worker_connections` 与 `worker_rlimit_nofile` | `ss -ant state established \| wc -l`（实际连接数）；`nginx -T \| grep -E 'worker_connections\|worker_rlimit_nofile'`；`cat /proc/<pid>/limits \| grep open`（当前 fd 上限） |

## 补充
### fd和指针的关系

fd（文件描述符）本质是**进程打开文件表的下标**，用户态拿到的只是一个整数，真正干活的是内核里的对象。以 TCP 连接为例：
```c
int conn_fd = accept4(listen_fd, ...);   // 内核新建 socket 对象，返回整数编号
setsockopt(conn_fd, ...);                 // 用编号指回内核，操作那个 socket
write(conn_fd, buf, len);                 // 往那个 socket 的发送缓冲区写数据
close(conn_fd);                           // 让内核销毁那个 socket 对象
```
`conn_fd` 只是个 int，但每次系统调用都带上它，内核从进程的 fd 表查到对应的 `struct socket`/`struct sock`，后续操作全部落在那个内核对象上。**fd 是用户态对内核对象的「句柄」**——类比指针：两者都是「间接引用一个对象」的凭据，区别在于指针指向的是本进程地址空间里的内存（直接解引用，快但危险），fd 指向的是内核里的对象（必须经系统调用间接访问，受权限管控）。
这也解释了两个常见现象：
- **fd 泄漏**：`close()` 忘了调，内核对象就一直活着，`ss -antp` 里连接还在、`/proc/<pid>/fd` 里 fd 数持续上涨，直到撞上 `ulimit -n`。
- **epoll_data.ptr 的前提**：文中前面提到用 `epoll_data.ptr` 挂 connection 指针，是因为**用户态的 connection 结构体和内核 socket 是两套东西**：fd 用来跟内核打交道，ptr 用来在用户态零查找拿到自己的上下文，二者各司其职。

### docker.sock
先看它是什么：
```bash
$ ls -l /var/run/docker.sock
srw-rw---- 1 root docker 0 ... /var/run/docker.sock
```
注意第一个字符 **`s`**：ls -l 的类型标识符里，`-` 是普通文件、`d` 是目录、`l` 是软链接、**`p` 是命名管道（FIFO）**、**`s` 是 socket 文件**——即 Unix Domain Socket（UDS）。
**UDS 与 TCP socket 的同与异**：内核走的是同一套 socket 抽象（同样是 fd，同样 `socket()/bind()/listen()/accept()`），事件同样能挂 epoll；区别是 UDS 不经过 IP 协议栈和网卡，**以文件系统路径为「地址」**，仅限本机进程通信，少三四层封装，延迟更低、还能带上文件权限控制（上面那个 `srw-rw---- root docker` 就是准入门槛：只有 root 和 docker 组能连）。
Docker daemon 的 API 就是跑在这个 socket 上的：`docker ps`、`docker run` 等所有客户端命令，本质都是往 `/var/run/docker.sock` 发 HTTP（RFC 套壳在 UDS 上）。挂载进容器就是：
```bash
docker run -v /var/run/docker.sock:/var/run/docker.sock ...
```
**安全风险：容器逃逸**。容器内的进程一旦能访问这个 socket，就等于拿到了宿主机 Docker daemon 的完整控制权——daemon 是宿主机上的 root 进程，通过它起一个挂载宿主机根目录的特权容器，就能任意读写宿主机文件系统：
```bash
curl --unix-socket /var/run/docker.sock \
  -X POST 'http://localhost/v1.41/containers/create?name=escape' \
  -d '{"Image":"alpine","Cmd":["sh"], "Binds":["/:/host"]}'
curl --unix-socket /var/run/docker.sock -X POST .../containers/escape/start
# 容器内 cat /host/etc/shadow 即宿主机文件
```
这正是知名的逃逸手法（CVE-2019-5736、各类 CI/CD 挂 docker.sock 的审计项都源于此）。SRE 的实践准则：**生产容器绝不挂载 docker.sock**；确有需要（如 dind、监控 agent）时，改用 Proxy sidecar 做命令白名单、或用 rootless/podman 降权；巡检时用下面命令快速排查：
```bash
docker inspect $(docker ps -q) | grep -i docker.sock   # 谁挂了 sock
ls -l /var/run/docker.sock                              # 谁在 docker 组里
```