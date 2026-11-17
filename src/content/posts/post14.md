---
title: Linux常见文件系统介绍
published: 2026-08-07T20:00:21+08:00
description: '从inode、超级块、分区三方面理解ext4与xfs'
image: './images/a14.avif'
tags: [linux,文件系统]
category: '计算机技术'
draft: false
lang: '中文'
---



## Linux 常见文件系统介绍

### inode（索引节点）
文件在磁盘上的"身份证"，存储文件的**元信息**（类型、权限、所有者、大小、时间戳、数据块位置），**不含文件名**。文件名存在于目录项中，由"文件名 → inode 号"映射。一个文件对应一个 inode，对文件的所有操作最终都落到 inode 上。  
#### ext4 的特点
- 格式化时**预分配 inode 表**（按"分区大小 / 比例"算出总数），默认每个 inode 256 字节
- 数据定位：**extent 树**（"起始块 + 长度"描述连续区，元数据更紧凑，若数据分散在不同块则可以用树来维护）。
- 支持**内联数据**：极小文件的数据块直接塞进 inode 体，节约时间。
- 隐患：inode 预分配用完，即使磁盘有空间也建不了新文件。
#### xfs 的特点
- inode **动态分配**，不集中预建表，而是分布在各**分配组**中，由 B+ 树管理，扩展性极强，几乎不会"inode 耗尽"。
- 同样用 B+ 树组织 extent，大文件寻址高效。
- 无预分配上限问题，更适合海量小文件场景。

### 硬链接与软链接（inode 的直接推论）
| | 硬链接 `ln a b` | 软链接 `ln -s a b` |
| --- | --- | --- |
| 本质 | 目录项新增一条"文件名 → 同一个 inode"的映射 | 新建一个**独立 inode**，内容存的是目标路径字符串 |
| inode | 与源文件**同一个** | **自己的** |
| 删除源文件 | 数据还在（inode 链接计数减到 0 才真正释放） | 变成悬空链接（dangling） |
| 跨文件系统 | 不行（inode 号只在单个文件系统内唯一） | 可以 |
| 指向目录 | 不允许（防止目录树成环） | 允许 |
| `ls -l` 大小 | 与源文件相同，链接数 +1 | 等于路径字符串长度 |

生产用途：硬链接做同分区去重备份（`rsync --link-dest`）、软链接做版本切换（`/opt/app → /opt/app-v1.2`）。

### 超级块（superblock）
文件系统的"总目录"，记录整个文件系统的**全局元信息**：总块数、总 inode 数、空闲块/inode 数、块大小、魔数（文件系统类型标识）、挂载状态、日志位置等。挂载（mount）时内核先读超级块以识别类型并构建内存中的 `super_block`；超级块损坏则文件系统无法挂载，故通常有多份冗余备份。
#### ext4 的特点
位于**块组 0**起始为主超级块，并在多个块组中有备份
#### xfs 的特点
- 位于 **块组 0** 开头为主超级块，其余每个块组各有备份。

### 分区（partition）
磁盘上划分出的连续块区间，一个分区格式化化为**一种文件系统**，拥有独立的一套超级块、inode 表、数据块。分区是容器，文件系统是内部组织方式；mount 的本质即把某分区的文件系统根嫁接到目录树节点。  
#### ext4 的特点
- 把分区切成多个**块组（block group）**，每组含自己的inode 位图，块位图、inode 表、数据块。
- 块组化让元数据靠近数据，减少寻道（因为当一个文件被修改时，ext4会尽量把它的各种信息写到该文件系统所在块组）；超级块与备份分布在块组 0 及若干块组。
- ext4可以支持分很多个区
#### xfs 的特点
- 把分区切成多个**分配组**，每组是自治的"子文件系统"，各自管理空间与 inode，可**并行分配/查找**，天然多核友好。
- 多分配组结构带来高并发优势，但代价是不支持缩容。
- xfs分区数量按磁盘大小定，通常和 CPU/核心数相关。

### ext4和xfs使用场景
综上，ext4文件系统兼容性好，中小负载稳，极端高并发元数据或超大单文件时，受全局协调瓶颈，上限不如 xfs。  
xfs的分区是并发架构，在高并发场景下表现好。

### 读取某一个文件内容的过程，例如 cat /usr/test.txt
根 inode (/) 的数据块
  → 找到 "usr" 对应的 inode 号 → 取出 usr 的 inode（它是个目录）
usr 的 inode 的数据块
  → 找到 "test.txt" 对应的 inode 号 → 取出 test.txt 的 inode（它是个普通文件）  
然后vfs读他的元信息，例如权限，大小，数据块位置。内核根据extent树算出这个文件占用了哪些数据块，向块设备发送读请求，把数据块内容读进页缓存（page cache）。VFS 把页缓存里的数据通过 read 系统调用返回给 cat，显示出来。
**vfs**: 虚拟文件系统，是 Linux 内核里的一层统一抽象层，让所有不同类型的文件系统（ext4、xfs、proc...）都能用同一套接口接入，用户态的程序不用关心底层到底是哪种。  

## 文件挂载
挂载（mount）= 当前目录树的挂载点重定向到另一个文件系统的根inode
- 挂载点目录原本若有文件，挂载期间看不见，被新文件系统遮住。
- 卸载（umount）后原内容恢复——数据没丢，只是被盖住了。
- 所以挂载点一般选空目录。
| 类型 | 例子 | 本质 |
| --- | --- | --- |
| 普通挂载 | `mount /dev/sdb1 /mnt` | 嫁接一个新文件系统根 |
| 伪文件系统 | `mount proc proc /proc` | 无块设备，内核动态生成（proc/sysfs/tmpfs） |
| 绑定挂载 MS_BIND | `mount --bind a b` | 不换文件系统，给同一 inode 再建一个路径入口（可目录可文件） |
| 联合挂载 overlay | `mount -t overlay overlay -o lowerdir=/l1:/l2,upperdir=/u,workdir=/w /merged` | 多层目录（只读 lower + 可读写 upper）叠加成统一视图，靠 CoW 和白障实现复用与隔离（Docker 用） |

## 虚拟文件系统（伪文件系统）
`/proc`、`/sys`、`/dev` 这些目录，在 `lsblk` 里找不到任何对应的分区，`df -h` 却把它们列出来。它们就是**虚拟文件系统**：没有块设备、没有磁盘上的超级块和 inode 表，整棵目录树是内核在内存里现造的。
### 为什么能"虚拟"：VFS 只要求接口，不要求磁盘
VFS 注册一个文件系统时，只要求实现几组回调（`lookup`、`read`/`write`、`readdir`、`stat`），**从不检查数据是不是来自磁盘**。所以内核可以注册一个"假"文件系统：inode 在内存里现造，`read()` 时不发块设备请求，而是**直接调用一段内核函数，把内核结构体里的字段拼成字符串返回**。
判断标准一句话：**内容不是"存"出来的，是"算"出来的**。`cat /proc/meminfo` 每次读都是内核现场统计，磁盘上没有任何一个块存着这个文件。
```text
用户态  cat /proc/meminfo
          ↓ read() 系统调用
VFS 层（统一的 inode / dentry / file 接口）
   ├── ext4 / xfs              → 查 extent / B+ 树，向块设备发读请求
   ├── proc / sysfs / cgroup2  → 不发 IO，直接读内核结构体现算
   └── fuse.sshfs 等           → 打包成 FUSE 请求丢给 /dev/fuse，由用户态进程处理
```
一眼认出来的办法：
```bash
findmnt -t proc,sysfs,devtmpfs,tmpfs,cgroup2,fuse   # 列出所有虚拟文件系统
df -h /proc /sys                                    # Size 为 0（tmpfs 则是内存大小）
stat -f /proc                                       # Type: procfs
lsblk                                               # 永远找不到 /proc 对应的"盘"
```
### 常见的虚拟文件系统
| 挂载点 | 类型 | 谁生成 | 实际是什么 |
| --- | --- | --- | --- |
| `/proc` | procfs | 内核 | 进程与内核运行状态的视图 |
| `/proc/sys` | procfs | 内核 | sysctl 参数，**可写**（写 = 改内核行为） |
| `/sys` | sysfs | 内核 | 设备 / 驱动 / 内核对象（kobject）的结构化模型 |
| `/sys/fs/cgroup` | cgroup2 | 内核 | cgroup v2 的控制接口（`memory.max` 就是一个普通属性文件） |
| `/dev` | devtmpfs | 内核 | 设备节点目录，设备注册时自动生成 |
| `/dev/fuse` | 字符设备 `10:229` | FUSE 内核模块 | **不是文件系统**，是内核与用户态文件系统进程之间的请求队列 |
| `/dev/shm`、`/run` | tmpfs | 内核 | 有真实 inode 的文件系统，只是数据只落在内存 / swap |
| `/sys/kernel/debug` | debugfs | 内核 | 内核调试接口 |
| `/sys/kernel/tracing` | tracefs | 内核 | ftrace 的开关与 trace 输出 |
| `/sys/kernel/security` | securityfs | 内核 | LSM 接口（AppArmor / SELinux） |
| `/sys/fs/bpf` | bpf | 内核 | pinned eBPF 对象 |
#### /proc：进程和内核状态的窗口
```bash
ls /proc/<pid>/           # 一个进程一个目录，内容来自 task_struct、mm_struct
cat /proc/<pid>/status    # 状态、内存、线程数
cat /proc/<pid>/stat      # 第 14/15 字段是 utime/stime，CPU 使用率就从这儿算
ls -l /proc/<pid>/fd      # 进程打开的所有文件，都是指向真实 inode 的符号链接
ls -l /proc/<pid>/root    # 进程眼中的根目录——容器里这个链接就指向 overlay 的 merged
ls /proc/<pid>/ns         # 该进程所属的各命名空间
```
- 为什么虚拟：进程随时生灭，`/proc/meminfo` 每次读都是现场统计，磁盘上不可能预先存一份"当前内存用量"。
- 可写的那部分就是 sysctl：`echo 1 > /proc/sys/net/ipv4/ip_forward` 等价 `sysctl -w net.ipv4.ip_forward=1`；容器里改的是自己 net ns 的副本，宿主机不受影响。
- 生产坑：`/proc/cpuinfo`、`/proc/stat`、`/proc/meminfo` **不跟随 PID / CPU namespace**，容器里 `top` 看到的是宿主机 CPU——这就是容器 CPU 使用率要单独算的原因。
#### /sys：设备与内核对象的结构化模型
sysfs 把内核内部的对象树（kobject）直接导出成目录，**一个属性文件对应一个内核变量**：读 = 调驱动的 `show()`，写 = 调 `store()`。
```bash
cat /sys/class/net/eth0/address         # MAC 地址
cat /sys/block/sda/queue/scheduler      # IO 调度器，可写切换
echo 1 > /sys/block/sdb/device/delete   # 热拔盘（生产换盘的标准动作）
cat /sys/fs/cgroup/memory.max           # cgroup 的限制，本质也是 sysfs 属性
```
- 和 proc 的分工：proc 是"进程 + 历史杂项"，sysfs 是"设备 / 驱动的结构化模型"，路径稳定、按 class / bus / device 组织；新接口现在基本都往 sysfs（或 `/sys/fs/` 下的专用文件系统）放。
#### /dev/fuse：一个字符设备，不是文件系统
`/dev` 目录本身是 devtmpfs（设备注册时内核自动建节点），但**里面的节点是设备，不是文件**。`ls -l /dev/fuse` 看到 `c 10, 229`：主 / 次设备号是驱动注册表里的索引，`open/read/write` 它等于调 FUSE 内核模块的回调，而不是读磁盘。
它干的事是把"实现一个文件系统"从内核搬到用户态：
```bash
# 用户态进程先 open("/dev/fuse") 拿到 fd，再用这个 fd 把自己注册成某路径的文件系统实现
mount -t fuse-overlayfs fuse-overlayfs /merged -o lowerdir=...,upperdir=...,workdir=...
```
之后所有对 `/merged` 的 IO 都由内核打包成 FUSE 请求，经 `/dev/fuse` 队列交给那个用户态进程处理——sshfs、s3fs、fuse-overlayfs（rootless 容器）能存在，靠的就是这套机制。
#### tmpfs：不算"纯虚拟"，但也没落盘
tmpfs 有真正的 inode 和数据页，只是页只存在内存（可换出到 swap），`df -h` 的大小约等于可用内存，重启即失。`/run`、`/dev/shm` 都是它。
- 生产坑：容器 `/dev/shm` 默认只有 64MB，Chromium、Python 多进程共享内存之类的程序会莫名崩溃，需要 `--shm-size` 调大。

## 生产运维：扩容、缩容与常见故障
### 扩容与缩容：xfs 只能扩，ext4 可扩可缩
云盘扩容后必须**先扩分区、再扩文件系统**，两步缺一不可：
```bash
lsblk                          # 先看清分区和文件系统现状
growpart /dev/vda 1            # 1. 扩分区（云主机标准做法，不用 fdisk 重排）
# 2. 扩文件系统，按类型二选一：
xfs_growfs /data               # xfs：挂载状态下直接扩，只能扩、不能缩
resize2fs /dev/vda1            # ext4：可在线扩；缩容必须先 umount + e2fsck
```
- `df -h` 没变化时先回头查第 1 步：分区没扩，文件系统再扩也白搭。
- LVM 场景多两步：`pvresize /dev/vda1` → `lvextend -l +100%FREE /dev/vg/lv`，最后才扩文件系统。
- xfs 没有 `xfs_shrink`，不支持缩容是硬限制——选型时要想清楚"以后要不要缩"。

### 磁盘满了，du 加起来却对不上 df
生产最经典的一类工单，两个原因覆盖 90% 场景。
**原因 1：inode 耗尽**（ext4 预分配用完，磁盘还有空间但建不了文件）
```bash
df -i /data                            # IUse% 100% 就是它
find /data -xdev -type f | wc -l       # 定位哪个目录文件数爆炸（小文件、会话、缓存）
```
**原因 2：文件已删除，但进程还开着 fd**
`rm` 只删目录项，进程持有 fd 时数据块不会释放：`du` 看不见（已经没目录项），`df` 却仍算被占用。
```bash
lsof +L1                               # 找 link count 为 0 的已删除文件
lsof | grep deleted                    # 同上，直接看文件名和 PID
# 处理：重启或 reload 对应进程；能截断的大日志可用 : > /proc/<pid>/fd/<fd>
```
- 容器场景补充：容器里 `df -h /` 看到的是**宿主机底层文件系统**的容量（overlay 报的是底层盘的数），所以 `/var/lib/docker` 被写满时，容器内会表现为"什么都没写却 100%"。

### 文件系统变成只读
现象：`touch` 报 `Read-only file system`，业务全部写失败。这不是权限问题，是**文件系统自己切了只读保护数据**。
```bash
dmesg -T | grep -iE 'ext4|xfs|I/O error|remount'   # 找第一现场：IO 错误或元数据损坏
mount | grep ' /data '                             # 看是否挂成了 ro
```
- ext4 默认 `errors=remount-ro`：检测到元数据错误或底层 IO 失败就自动转只读；xfs 更激进，可能直接 shutdown（`dmesg` 里 `XFS (vdb): Filesystem has been shut down`）。
- 根因通常在下面：云盘抖动/掉盘、宿主机内核问题、RAID/存储链路故障。**先查 `dmesg` 和云厂商事件，别急着 `mount -o remount,rw`**——带着故障强行读写会让损坏扩大。
- 修复姿势：umount → `fsck -y /dev/vdb1`（ext4）/ `xfs_repair /dev/vdb1`（xfs；必要时 `xfs_repair -L` 清日志，会丢未落盘数据）→ 重新挂载；生产上先打快照再修。

## 补充
### 数据恢复原理
数据恢复能够在一定时间内找回"已删除"文件，根本原因在于：**磁盘上的数据从来不是被真正删除的，而是被覆盖。** 当你强制删除某个文件时，系统并没有把数据块里的 0/1 清零，而只是**切断了文件与对应数据块之间的联系**——也就是释放了 inode 对该数据块的指向。  
结合前文 inode 机制，具体过程如下：
- **删除的本质是"断链"**：删除操作（如 `rm`）只是移除目录项中的"文件名 → inode 号"映射，并把 inode 标记为空闲、将其 extent 指向的数据块归还给"空闲块位图"。数据块里的内容**原封不动地留在磁盘上**，直到被新文件写入覆盖。
- **联系未断之前数据可见，断链之后仍物理存在**：文件在目录树中"消失"≠ 数据消失。只要那些数据块还没被别的文件占用并改写，原始字节就一直躺在原地。
- **恢复的原理是"重建联系"**：数据恢复工具扫描磁盘，找到仍被数据块占用但已无目录项引用的"孤儿 inode / 游离数据块"，根据文件特征（文件头魔数、结构签名）识别其类型，重新建立"文件名 → inode → 数据块"的映射，从而使文件重新可见。
- **时间窗口由"覆盖"决定**：恢复的可行性完全取决于"被删除的数据块是否已被新数据覆盖"。删除后越早恢复、且磁盘写入越少，成功率越高；一旦数据块被新文件写入（覆盖），原内容便不可逆转地丢失——这也是为什么误删后第一件事是**停止向该分区写入**，而非继续操作。
一句话：**删除只是解除了文件到数据块的指针，数据本身要等被新内容覆盖才会真正消失；数据恢复，就是赶在覆盖发生前把这条联系重新接上。**  
### 磁盘分区表
分区表是写在磁盘最开头的"地图"，记录这块盘怎么分、分了几块。两种格式：
| 特性 | MBR | GPT |
| --- | --- | --- |
| 最大磁盘容量 | 2TB（受寻址位宽限制） | 18EB（几乎无上限） |
| 最大分区数 | 4 个主分区（超出需用扩展分区+逻辑分区，较麻烦） | 默认 128 个（可配置更多） |
| 冗余备份 | 分区表仅一份，损坏即全盘不可用 | 头尾各存一份分区表，可恢复 |
| 启动方式 | 传统 BIOS | 现代 UEFI |
| 完整性校验 | 无 | 有 CRC 校验，可检测损坏 |
> 结论：现代服务器、云主机、大于 2TB 的磁盘一律使用 GPT；MBR 仅用于老机器或小容量盘。
**CRC校验** ：发送方/写入方根据数据算出一个短校验值（CRC 值），接收方/读取方用同样算法再算一遍，比对不一致就说明数据坏了。（适用于GPT分区表，网络包等）
bios和UEFI都是写在主板芯片上的固件，是电脑通电后执行的第一个程序，负责：  
- 通电自检（POST）：检查 CPU、内存、显卡等基本硬件是否正常。
- 找到启动设备（硬盘/U盘）。
- 把控制权交给硬盘上的引导程序（bootloader），由它加载操作系统内核。
### linux启动过程
1. BIOS/UEFI    → 硬件自检,找引导设备
2. Bootloader   → GRUB 加载内核 + initramfs（初始内存文件系统吗，是 Linux 启动过程中,内核加载的一个临时小根文件系统（因为将磁盘挂载到根文件需要一些磁盘驱动，比如RAID,LVM，所以需要一个临时的根文件系统）,存放在内存里。）
3. 内核         → 初始化硬件,挂载真实根文件系统
4. systemd      → PID 1（用户态祖先进程）,并行启动各类服务
5. 登录界面     → 系统可用