---
title: linux系统常见优化操作
published: 2026-07-27T19:21:21+08:00
description: '了解linux系统自带的优化操作以及在高并发场景下人工需要进行的优化'
image: './images/a5.avif'
tags: [linux]
category: '计算机技术'
draft: false
lang: '中文'
---

## 1.系统界面及apt源优化

### 1.1 系统界面优化
通过修改环境变量PS1可以让当前所处的文件路径完全显示  
在/etc/motd文件中的内容将会作为用户登录该服务器所展示的欢迎信息  

### 1.2 apt源优化
```bash
sudo cp /etc/apt/sources.list /etc/apt/sources.list.bak
# Codename: jammy（记下这个版本代号,假设是jammy）
lsb_release -a
#更换阿里云源
sudo tee /etc/apt/sources.list << EOF
deb https://mirrors.aliyun.com/ubuntu/ jammy main restricted universe multiverse
deb https://mirrors.aliyun.com/ubuntu/ jammy-updates main restricted universe multiverse
deb https://mirrors.aliyun.com/ubuntu/ jammy-security main restricted universe multiverse
deb https://mirrors.aliyun.com/ubuntu/ jammy-backports main restricted universe multiverse
EOF
#更新源到/var/lib/apt/lists/(apt upgrade是删除旧版本包，保留新版本)
sudo apt update
```


## 2.集群之间机器通信的优化

### 2.1 修改hosts文件
每台机器通过 `hostnamectl set-hostname 机器名`来描述该台服务器的意义  
通过修改hosts文件来实现机器之间通过主机名的=进行通信 
```bash
vi /etc/hosts
# 添加如下内容（ip,机器名 （机器名）...）
192.168.1.100 node1
192.168.1.101 node2
192.168.1.102 node3
```
### 2.2 安全机制关闭
为了避免各种因安全机制的原因导致集群之间的通信问题，我们需要关闭SElinux和防火墙  
当然对于完全关闭安全服务仅限于集群调通阶段。当整体调通之后，若有安全需求再视情况采取相关措施  
```bash
#临时关闭selinux
setenforce 0
#永久关闭selinux
vi /etc/selinux/config
#修改SELINUX=enforcing为SELINUX=disabled
#重启生效
reboot

#关闭防火墙，禁止开机自启
systemctl stop firewalld
systemctl disable firewalld
#清理内核残留规则
iptables -F
iptables -t nat -F
iptables -t raw -F
iptables -t mangle -F
```

### 2.3时间同步优化

集群主机通常位于内网，因为网速更快且稳定。我们一般会搭建时间服务器，  
所有机器向他看齐，该服务器再与公网时间机器看齐。

在`/etc/chrony/chrony.conf`配置文件通过server字段指定信任的时间机器地址，可指定多个，失败自动切换。  
配置文件里面再加上`allow 192.168.1.0/24`表示允许192.168.1.0/24网段的机器访问该时间服务器。  
`systemctl restart chrony`后`chronyc sources`显示时间源，带*号的是当前使用的。  


##进程数和文件描述符限制
```bash
#-S,-H参数分别为软限制和硬限制，硬限制才是真正的限制，软限制仅仅提到提示作用
# 查看当前系统的进程数限制
ulimit -u
# 查看当前系统的文件描述符限制
ulimit -n
# 修改当前系统的进程数限制
ulimit -u 65535
# 修改当前系统的文件描述符限制
ulimit -n 65535
```
上述的限制都只针对当前用户且是临时生效的。
`/etc/security/limits.conf`是用户级永久限制。  
创建或写入`/etc/sysctl.d/99-sysctl.conf`是系统级永久限制,-99代表最高优先级，会覆盖原本默认的内核参数（所有自定义内核配置都可以写到`/etc/sysctl.d/`下面）


## 3.网络连接优化
高并发场景下推荐采用长连接形式，连接时长可以自己配置覆盖默认时间以更好地进行资源回收。
大部分网页端场景可采取短连接

## 4.内存优化

### 4.1 核心概念
`OOM`: linux系统在内存及swap分区都耗尽的情况下，根据特定算法杀死正在运行的某些进程。
`buffer`: 用于优化写操作，将写操作暂存内存后一次性写入磁盘
`cache`: 用于优化读操作，根据特定规则缓存已经读取的文件内容
`available内存`=`free` - `buffer/cache中可用内存`
`cache组成`=`Page Cache`(缓存文件的具体内容)+`Slab`(缓存文件元数据)
`内存超配机制`:每一个进程申请的内存大小一般都是小于它实际用的内存大小，为了充分利用内存，操作系统会利用虚拟内存进行超配，进程以为自己有这么多内存空间。
`匿名内存`：进程申请的内存中，没有被写入磁盘的内存，比如进程申请的堆内存。

### 4.2 内存不足时的处理流程
`/proc/sys/vm/swappiness`中的数字假设为x，  
值越小，内核越倾向于回收文件缓存，尽量保留匿名内存不动。值越大，内核越倾向于把匿名内存换出到 swap。  
默认 60。0 表示尽量不 swap。  
100 表示文件缓存和匿名内存被同等对待，匿名内存更容易被 swap。   
数据库和 Redis 等场景通常设为 1 或 10，减少 swap 以保持性能。  


## 5. 其他优化
针对分布式存储等网络高吞吐场景，需使用万兆交换机和光纤网卡，调大MTU值，比如调到9000.    
物理服务器还可以配置双网卡，双电源，增加冗余性，确保高可用。