---
title: linux内核
published: 2026-09-21T20:11:23+08:00
description: 
image: './images/a19.avif'
tags: [linux]
category: '计算机技术'
draft: false
lang: '中文'
---


## 一、进程与调度
**核心概念**
### 进程与线程
- **内核只有 task，不区分进程/线程**：它们的结构体是一样的，里面的PID字段就是每个task自己的ID，也就是线程id，tgid就是线程组ID，同一线程组的task里面的指针所指向的资源都是一样的。**所以说，进程只是一个逻辑上的集合，代表整个线程组，没有实体**（`top` 是按时进程汇总）
- **结构体层面**：`task_struct` 里挂着 `mm`（指向目前进程所拥有的虚拟空间地址）、`files`（fd 表）、`fs`（指向一个存放目前文件系统上下文，比如当前所在目录，的结构体）等。
- **fork和clone**: fork实际上就是克隆出一个只有一个线程的线程组（tgid等于pid）,克隆也采取`COW`，clone可以通过CLONE_THREAD 这个标志告诉内核：「新 task 加入调用者的线程组」。（除了这个标志，内核强制要求还需要其他标志，比如共享虚拟地址空间，信号处理表，fd表）
- **页内存转换相关**：地址空间由 `mm_struct` 里的页表（`pgd` 多级页表）把虚拟地址映射到物理页。**进程各有独立页表** → 进程切换要换页表基址，  
- **TLB （地址翻译缓存）被刷掉**，后续访问要重新走页表，开销大；**线程共享同一 `mm`** → 切换不换页表、TLB 不刷，开销小。这正是前面「切进程才切页表」的来由，也是线程比进程轻的核心原因。
### 上下文切换
CPU 从当前 task 换到下一个 task 时，要**保存旧 task 的寄存器、栈指针**，再**恢复新 task 的**——这套现场保存/恢复就是切换开销，每秒切换次数体现在 `vmstat` 的 `cs` 指标上。  
- **两种切换代价不同**：**线程切换**共享同一 `mm`，只换寄存器/栈，不换页表、不刷 TLB，很轻；**进程切换**要换页表基址并刷 TLB，代价明显更高  
- **什么时候会切换**：时间片用完被抢占、等锁/IO 阻塞、中断打断。频繁阻塞/唤醒或线程数过多 → 切换风暴，`cs` 飙升、CPU `sy` 涨、实际干活时间变少。
- **排障信号**：`vmstat 1` 看 `cs` 是否异常高，然后配合其他命令定位是不是锁竞争或过多线程在抢 CPU。

### 内核调度 
**内核调度**：决定「接下来哪个可运行 task 上 CPU、跑多久」的机制。每个 CPU 有自己的运行队列（rq），独立挑任务，互不干扰。
- **调度类（按优先级排）**：`stop` > `deadline` > `rt`（实时）> `cfs`（普通）> `idle`。高优先级类有可跑任务时，直接抢占低优先级。SRE 日常打交道的几乎都是 **CFS**。
- **CFS 怎么做到公平**：给每个任务记一个「虚拟运行时间」`vruntime`（实际跑得越久涨得越多），调度时总是挑 `vruntime` 最小（即跑得最少）的任务上 CPU，于是大家雨露均沾。`nice` 值通过权重调节 vruntime 增速：nice 越小权重越大、涨得越慢、拿到的 CPU 越多。
- **实时类（RT）要小心**：`SCHED_FIFO/RR` 任务优先级高于所有 CFS 任务，一旦可运行就抢占普通进程——一个失控的 RT 进程会把 CPU 占满、让普通服务饿死，是经典的「CPU 用满但业务卡」陷阱。
- **抢占时机**：当前任务时间片/vruntime 用尽、或有更高优先级任务就绪（新任务唤醒、中断/系统调用返回）时触发切换，切换本身的开销见上一节。
- **排障工具**：`top` 看 `PR`/`NI`（优先级与 nice）、`chrt` 查/设实时优先级、`taskset` 绑核、`cat /proc/<pid>/sched` 看该任务调度明细、`perf sched` 分析调度延迟。
- **CPU 亲和度（任务绑核）**：默认调度器可在任意核间迁移 task，亲和度是给这份自由加约束——限定某 task 只能跑在哪些核上。好处是让任务长期待在同一核，缓存/TLB 不被其他任务冲掉（呼应前面 TLB 一节）、避免跨 NUMA 访存、把延迟敏感服务绑到专属核。工具：`taskset -c 0,1 <cmd>` 设/查、`sched_setaffinity` 系统调用、cgroup `cpuset.cpus`；`/proc/<pid>/status` 的 `Cpus_allowed` 可看允许范围。注意绑太死反而会降低调度灵活性、引发核间负载不均。






## 二、内存管理
**核心概念**
`虚拟内存`：每进程独立地址空间，靠页表 + TLB 映射物理页，4KB 页 + 大页（THP）。  
`RSS / VSZ / PSS`：常驻、虚拟、按比例摊共享库后的实际占用。  
`page cache`：文件读写先过内存缓存，是「空闲内存就是浪费内存」的根源，可被回收。  
`匿名页 / swap`：堆栈等无文件 backing 的页，内存紧张时换出。  
`OOM Killer`：物理内存耗尽时按 oom_score 选进程杀，容器看 cgroup memory limit 触发。  
`回收 / 水位线`：direct reclaim、kswapd，水位低时进程被卡住同步回收，表现为延迟毛刺。  
**排障场景**
- 机器变慢但 free 还有 → 看 available 与 si/so，真凶是回收/换页。  
- 进程莫名被杀 → dmesg | grep -i oom。  
- THP 导致延迟抖动 → 数据库类应用常关 THP。  
**工具**：free -m、/proc/meminfo、/proc/<pid>/status、smem、sar -r。

## 三、文件系统与 I/O
**核心概念**
`VFS`：统一抽象层，ext4/xfs/procfs 都实现它，dcache/dentry 缓存路径解析。  
`struct file / inode / fd`：一次打开 = 一个 struct file（含 f_pos），inode 是磁盘元数据，fd 是进程私有表下标。  
`page cache 回写`：write 先进脏页，由 flusher 线程异步刷盘，dirty_ratio、dirty_background_ratio 控制节奏。  
`fsync / O_DIRECT`：fsync 强制落盘（数据库靠它保证持久性），O_DIRECT 绕过 page cache。  
`IO 调度器`：mq-deadline、bfq、none（NVMe 用 none）。  
**排障场景**
- 写延迟高 → iostat -x 看 await、%util，再看脏页堆积（/proc/vmstat 的 nr_dirty）。  
- 删大文件卡住 → 空间不立即释放 + 大量回写。  
- fsync 慢 → 磁盘或 RAID 缓存/电池策略。  
**工具**：iostat -xz 1、iotop、pidstat -d、/proc/vmstat、bpftrace 的 biolatency。

## 四、网络协议栈
**核心概念**
`socket 缓冲`：sk_buff 在各层流动，rmem/wmem、netdev_max_backlog。  
`TCP 状态机`：TIME_WAIT（2MSL）、CLOSE_WAIT（应用没 close，排查连接泄漏关键）。  
`conntrack`：有状态防火墙/NAT 的连接跟踪表，满了新连接直接失败。  
`中断与软中断`：网卡收包走硬中断→软中断 NET_RX，单核打满看 RPS/RFS 分散。  
`backlog 溢出`：半/全连接队列溢出（ss -lnt 的 Recv-Q/Send-Q、netstat -s 的 overflow）。  
**排障场景**
- 偶发超时 → 看重传、看 backlog 溢出。  
- 大量 TIME_WAIT → 短连接风暴，调 tcp_tw_reuse/长连接/端口范围。  
- 新连接失败 → conntrack 表满（nf_conntrack_count vs max）。  
**工具**：ss -s、ss -antp、netstat -s、sar -n DEV/ETCP、nstat、tcpdump、ip -s link。

## 五、系统调用与态切换
**核心概念**
`用户态/内核态`：read/write/epoll 触发陷入，切换有开销。  
`调用开销`：高频小调用会放大 CPU sy。  
`epoll`：高并发服务器基石，水平/边缘触发。  
**排障场景**
- sy 高 → perf top 看内核热点，strace -c 统计调用次数。  
- 上下文切换风暴 → 线程数过多或锁竞争。  
**工具**：strace、perf trace、/proc/<pid>/status 的 ctxt 计数。

## 六、中断与软中断
**核心概念**
`硬中断`：打断 CPU，越少越快，/proc/interrupts 看分布。  
`软中断/tasklet/workqueue`：把重活推到中断上下文外。  
`irqbalance / 亲和`：网卡中断绑核避免单核瓶颈。默认中断可由任意核处理，单核打满时就把指定中断（如网卡）绑到特定核：`/proc/irq/<n>/smp_affinity` 写核掩码（或 `irqbalance` 自动均衡、`RPS/RFS` 在软件层分散收包）。注意这是**中断**亲和度，和上一节「任务 CPU 亲和度」对象不同：前者绑的是中断，后者绑的是进程/线程。  
**排障场景**
- 单核 si 100% 其他空闲 → 网卡中断集中一核，调 RPS 或 irq affinity。  
**工具**：mpstat -P ALL 1（每核 %soft/%irq）、/proc/interrupts、/proc/softirqs。

## 七、cgroup 与 namespace（容器内核基础）
**核心概念**
`namespace`：隔离 PID/NET/MNT/UTS/IPC/USER，让容器看到独立系统。  
`cgroup v1/v2`：限制 CPU/内存/IO/PID，K8s requests/limits 落到 cgroup。  
**排障场景**
- 容器 CPU 限流、内存 OOM、PID 耗尽（fork 失败）都在 cgroup 层。  
- 容器里 top 看到宿主机 → namespace 未隔离 proc 或工具没读 cgroup。  
**工具**：/sys/fs/cgroup/...、/proc/<pid>/cgroup、crictl、kubectl top。

## 八、内核参数调优 sysctl
**核心概念**
`/proc/sys/...` 与 sysctl -w：网络、内存、句柄等运行时可调。  
关键项：net.core.somaxconn、tcp_max_tw_buckets、ip_local_port_range、vm.swappiness、vm.dirty_ratio、fs.file-max、nf_conntrack_max。  
**排障场景**：高并发机器几乎都要针对性调一批 sysctl，改完持久化到 /etc/sysctl.d/。  
**工具**：sysctl -a、sysctl -w、/etc/sysctl.conf。

