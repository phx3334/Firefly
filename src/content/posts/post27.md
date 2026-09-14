---
title: vfs和挂载安全
published: 2026-09-13T23:11:23+08:00
description: 学习vfs和挂载安全的原理和实际应用
image: './images/a27.avif'
tags: [linux,文件系统]
category: '计算机技术'
draft: false
lang: '中文'
---

## VFS：一切皆文件的统一层

### 为什么需要 VFS

Linux 支持几十种文件系统（ext4/xfs/btrfs/NFS/procfs/tmpfs/fuse...），但应用只认识 `open/read/write/close`。VFS（Virtual File System）就是中间的抽象层：定义一套统一的接口，每种文件系统各自实现，应用无感切换。

```text
用户态 write (int fd, const void *buf, size_t count) → 系统调用 → VFS 分发
├── ext4/xfs      → 块设备（本地磁盘，掉电可丢，靠 journal 保证一致性）
├── NFS/CIFS      → 网络 RPC（另一台机器，网络抖动 = IO 卡死）
├── procfs        → 内核实时生成（/proc、/sys，读一次算一次，非真实文件）
├── tmpfs/devtmpfs → 内存（/dev/shm、/dev，重启即失）
├── overlayfs     → 分层合并（容器镜像的分层就是它）
└── fuse          → 用户态文件系统（s3fs、sshfs，慢但有想象力）
```
**如何通过fd写入磁盘分区的背后的文件系统**
关键：内核**从不判断**「这个 fd 是什么文件系统」，靠的是 open 时就绑定的函数指针表。
引用链：`fd` → 进程 fd 表取出 `struct file`（打开会话对象）→ 里面的 `f_op`（file_operations 函数指针表）→ **直接调用 `f_op->write_iter()`**。ext4 在注册时会把自己的实现函数填进这张表，所以 open("/data/a.log") 时内核沿 inode 找到 superblock，就把 ext4 的函数表塞进了 f_op——从此这个 fd 的每次 write 都自然落进 ext4 的代码，一跳到位，没有 if(ext4) 这种分支。
一句话：**fd 是凭据，f_op 是分发点，「是什么文件系统」在 open 那一刻就写死在指针里了**。这也是为什么换文件系统必须重新挂载并重新打开文件——旧 fd 的 f_op 还指向旧实现。


### VFS 三个核心对象
- **superblock**：整个文件系统的元数据（类型、块大小、总量/余量）——`df` 读的就是它。
- **inode**：一个文件的元数据（权限、大小、时间戳、数据块指针）。**文件名不属于 inode**，属于目录（目录本质是「文件名→inode 号」的映射表）。这就是硬链接的原理：多个文件名指向同一个 inode，删一个名字 link count 减一，减到 0 且无进程持有才真正释放。
- **dentry（目录项）**：文件名与 inode 的映射缓存，配合 dcache 加速路径解析（全路径查找就是一层层 dentry 查下去）。

### SRE 视角的三个经典现象
**1. df 和 du 对不上（已删除但未释放）**
文件被 rm 了，但进程还持有 fd → inode 没释放，df 看到的占用不降，du 却找不到文件：
```bash
lsof +L1                        # 列出 link count=0 但仍被打开的文件
truncate -s 0 /proc/<pid>/fd/4  # 或重启该进程释放
```
日志文件 rm 后磁盘不释放，几乎都是这个——日志轮转要配 `copytruncate` 或发 HUP 的根源。

**2. inode 耗尽**
`df -h` 没满但报 `No space left on device`：海量小文件把 inode 吃光了。
```bash
df -i                # 看 IUse%
df -i | grep -v 0    # 找快满的文件系统
# 定位哪个目录文件多（遍历慢，放低峰跑）：
find / -xdev -printf '%h\n' | sort | uniq -c | sort -rn | head
```

**3. 只读文件系统（emergency）**
盘上报 I/O error 后 ext4 会自动 remount 成 ro 自保：应用报 `Read-only file system` 但 `mount | grep <挂载点>` 看到的是 ro——不是谁改了配置，是磁盘出错了。处理顺序：`dmesg` 确认硬件错误 → 尽快迁移数据 → 检查 SMART（`smartctl -a /dev/sda`）。

## 挂载：把文件系统拼进目录树

### 挂载机制

Linux 的目录树是一棵**全局唯一的树**，挂载 = 把一个文件系统的根嫁接到某个目录（挂载点）上。VFS 里用 vfsmount 结构维护这棵嫁接关系，路径解析时遇到挂载点就切换到新文件系统。

```bash
mount /dev/sdb1 /data                    # 手动挂载，重启失效
mount -o ro,noexec /dev/sdb1 /data       # 只读+禁执行
umount /data                             # 若文件目前还被其他进程使用，则 lsof +f -- /data 找是那些进程
lsblk -f                                 # 盘/分区/文件系统/UUID 全景
```

### 挂载选项（安全的核心）
mount 选项是文件系统层最实用的安全控制面，按场景给最小权限：
| 选项 | 作用 | 典型场景 |
|------|------|---------|
| `ro` | 只读 | 归档盘、审计日志盘 |
| `noexec` | 禁止执行二进制 | /tmp、上传目录（防 webshell 落地执行） |
| `nosuid` | 忽略 SUID 位 | /tmp、数据盘（防提权，SUID 木马经典位） |
| `nodev` | 挂载点下的设备文件不被当作真设备，内核拒绝通过它们访问硬件 | 所有非系统分区。防 `mknod` 造设备文件直摸磁盘（如指向根分区的块设备后 dd 泄露数据） |
生产基线建议：数据盘至少 `nosuid,nodev`；上传类目录加 `noexec`；

#### nosuid,nodev应用场景举例：攻击者怎么利用它们
**攻击链一：SUID 提权（nosuid 防的）**——攻击者拿到往 /data 写文件的权限后，把 root 的 shell 复制进去并打上 SUID 位；再用本地提权漏洞或 root 的定时任务/误操作把该文件属主改成 root。之后任何低权限用户执行它都会临时变成 root，攻击者就多了一个随时可用的提权后门。若 /data 挂了 nosuid，SUID 位在挂载点内被内核忽略，后门永远哑火。

**攻击链二：伪造设备文件直读磁盘（nodev 防的）**——攻击者在可写分区用 mknod 造一个指向根分区（如 sda2）的块设备文件，再让有权限的进程直接读它，就能绕过文件系统权限体系、以原始扇区方式偷走整块盘的数据（含 shadow、数据库文件）。若 /data 挂了 nodev，内核不把该文件当设备，打开直接报错，这条路被封死。

两条链的共同模式是「往可写分区放一个坏文件，等它被当真」——所以低信任写入区一律 nosuid,nodev。
### 常见坑
- **挂载点非空遮盖**：先往 /data 写了数据再挂载 → 挂上后原数据被「遮住」，误以为丢数据；卸载后重现。规矩：挂载点保持空目录。
- **umount busy**：进程 cwd 在里面、或持有 fd。`lsof +f -- /data` 排查；容器环境还可能是挂载传播（见下）。
- **df 容量 OK 但写不进**：看 inode（`df -i`）、看是否 ro
## /etc/fstab 与启动挂载安全

### 六字段与写法
```conf
# 设备                挂载点     类型   选项                              dump fsck
UUID=3a2f...-         /data     ext4   defaults,nosuid,nodev     0     2
nfs1:/share   (网络文件系统)        /mnt/nfs  nfs4   defaults,_netdev,nofail  0     0
tmpfs  (虚拟文件系统)               /tmp      tmpfs  rw,nosuid,nodev,noexec,size=2G    0     0
```
- **必须用 UUID**（`blkid` 查）：/dev/sdb 的盘位会漂移（热插拔、内核枚举顺序变化），UUID 是文件系统的身份而不是槽位。/dev/mapper/ 也比裸盘名稳。
- `_netdev`：网络文件系统必加，等网络就绪再挂；`nofail`：挂不上就跳过，不阻塞启动。
- dump/fsck 位：一般 0 0；根分区 fsck 给 1，本地盘 2，网络盘必须 0。

## 进阶：bind mount、namespace 与容器

### bind mount
把**目录**（而非整块设备）挂到另一个路径，源和目标是同一份数据：

```bash
mount --bind /var/log /mnt/logview     # /mnt/logview 就是 /var/log 的另一扇门
mount --bind -o ro /var/log /mnt/logview   # 只读版本：给巡检/审计用，原路径可写
```
SRE 用途：给 chroot/jail 补 /proc /dev；审计场景把日志目录 ro 挂给采集器——**同一份数据在不同路径有不同权限**，这是 VFS 层独有的能力。

### 挂载传播（mount propagation）
挂载事件在 mount namespace 之间如何扩散，由传播类型决定：`shared`（双向同步，一边挂另一边看得见）、`private`（完全隔离）、`slave`（单向接收）。容器技术的根基之一：
- Docker/K8s 的 volume 挂载就是宿主机路径 bind mount 进容器 namespace；
- `umount busy` 的一种成因是某 namespace 里还挂着传播副本；
- 安全视角：容器挂宿主机敏感路径（/、/var/run/docker.sock、/proc）= 逃逸通道，同 post26 讲过的 docker.sock 原理，K8s 里对应 `hostPath` 类型的准入管控（PSA 禁止 hostPath 或限制到白名单前缀）。

### 容器内「df 不对」的真相
容器内 df/df -i 显示的是 **overlayfs 上层**的视图，容量是宿主机 rootfs 盘的配额视角。Pod 报 `No space left on device`，先分辨三种：
```bash
df -h          # 宿主机：根盘/数据盘谁满了
df -i          # inode：kubelet 目录海量小文件（容器日志/emptyDir 惯犯）
kubectl describe pod   # 事件里 ephemeral-storage 超限
```

## 速查：故障现象 → 工具映射
| 现象 | 命令 |
|------|------|
| 盘满但 du 找不到 | `lsof +L1`、`truncate -s 0 /proc/<pid>/fd/N` |
| No space left 但 df 有空间 | `df -i`、find 找小文件目录 |
| Read-only file system | `dmesg`、`smartctl -a`，先迁数据 |
| umount busy | `lsof +f -- <mnt>`、`fuser -vm <mnt>` |
| 挂载不生效/启动卡住 | `findmnt --verify`、`mount -a`、VNC 救援 `remount,rw` |
| 容器写盘失败 | 宿主机 `df -h` + `df -i` + `kubectl describe pod` |

**心法**：VFS 层的问题很少是「文件系统坏了」，绝大多数是**视角错位**——你以为在操作文件，其实在被挂载遮盖/被句柄拖住/被 namespace 隔离。排查时永远先问三个问题：这路径**当前挂在哪**（findmnt）、**被谁占用**（lsof）、**我在哪个 namespace**（容器 or 宿主机）。

## 补充
### 什么是struct file
**struct file 不是磁盘上的文件，而是内核内存里记录「一次打开行为」的会话对象**。
以 `int fd = open("/data/a.log", O_WRONLY)` 为例，struct file 的诞生过程：
```text
1. VFS 沿路径逐层查目录项缓存，找到 a.log 的目录项 → 拿到 inode
2. inode 指向的 superblock 说明：这文件在 ext4 上
3. 内核 kmalloc 一个 struct file，开始填表：
   - f_op       ← 填入 ext4 的函数指针表（分发能力在此定型）
   - f_mode     ← O_WRONLY（本次以写方式打开）
   - f_pos      ← 0（读写位置，从文件头开始）
   - f_inode    ← 指向 a.log 的 inode
   - f_count    ← 1（一个引用）
4. 把这个 struct file 的地址挂进进程 fd 表的第 3 格
5. 返回 fd=3 给应用
```
关键理解：**同一个文件可以有多个 struct file**。tail -f 和 grep 同时打开 a.log，各自得到一个 struct file，各自的 f_pos 独立推进（互不影响读到哪了）；但它们共享同一个 inode（文件本体只有一份）。O_APPEND 之所以能让多进程日志不互相覆盖，就是每次 write 前强制把各自的 f_pos 跳到 inode 记录的文件尾。
反过来，struct file 的消亡也严格对应引用计数：`close(fd)` 只是清空 fd 表的那一格，f_count 减 1；减到 0 才真正销毁 struct file。这就是「文件被 rm 但进程还持着 fd → 磁盘不释放」的底层机制——inode 释放要求「link count=0 **且** 没有任何 struct file 引用它」两个条件同时满足。
一句话：**inode 是文件本体，struct file 是打开文件的会话（f_op 定行为、f_pos 定位置），fd 是会话的入场券**。