---
title: linux日志管理
published: 2026-08-13T23:11:23+08:00
description: 学会rsyslog和logrotate的使用方法以及配置文件的主要内容
image: './images/a16.avif'
tags: [linux]
category: '计算机技术'
draft: false
lang: '中文'
---

## rsyslog
**rsyslog** 是 Linux 上主流的系统日志守护进程，负责收集、过滤、写入（或转发）日志。规则核心是「**来源（facility）+ 等级（priority）**」：等级数字越小越严重（emerg=0 最严重，debug=7 最轻），常见来源有 `auth`（认证）、`cron`、`daemon`、`kern`（内核）、`local0~local7`（自定义程序）。
配置结构：`/etc/rsyslog.conf` 主配置分三块——模块（决定收什么日志，如 imuxsock 收本地、imudp/imtcp 收远程）、全局（工作目录、引入分片）、规则（决定日志写到哪）。日常基本只关心规则和 `/etc/rsyslog.d/` 分片目录：

```conf
# /etc/rsyslog.conf 规则段：格式 = 来源.等级  目的地
auth,authpriv.*         /var/log/auth.log        # 认证日志 → auth.log
*.*;auth,authpriv.none  -/var/log/syslog         # 其余 → syslog（- 表示异步写，高频日志用）
```
转发到远程日志服务器：`*.* @@192.168.1.100:514`（@=UDP 不保证送达，@@=TCP 可靠；默认明文，跨公网需 TLS）。
验证：`systemctl restart rsyslog` 后 `tail -f /var/log/syslog` 观察写入。  

## logrotate
**logrotate** 负责**日志轮转**：日志会无限增长，不处理迟早撑爆磁盘。它的工作是定期把日志文件**改名归档 → 压缩 → 按策略清理旧文件**，并通知服务重新打开日志文件。
### 主配置：/etc/logrotate.conf
主配置写**全局默认策略**，各服务如无特殊配置就按这个来：
```conf
# 全局默认：每周轮转一次，保留 4 份，轮转后新建空文件
weekly
rotate 4
create
dateext        # 归档文件用日期命名（如 auth.log-20260813）
# 引入分片配置目录（核心），优先级更高
include /etc/logrotate.d

# 也可以在主配置里单独写特殊文件（局部覆盖全局）
/var/log/wtmp {
    monthly
    create 0664 root utmp
    minsize 1M
    rotate 1
}
```
### 分片配置：/etc/logrotate.d/*（以 ssh 为例）
每个软件/服务在 `/etc/logrotate.d/` 下一个文件，文件名随意（如 `ssh`、`nginx`），**针对具体日志文件的选项会覆盖主配置的全局默认值**。
SSH 的日志是通过 rsyslog 的 `authpriv` 规则写到 `/var/log/auth.log` 的，所以给 SSH 轮转就是轮转 auth.log：
```conf
# /etc/logrotate.d/ssh
# 若 auth.log 已用 chattr +a 加锁，则需要 prerotate 解锁、postrotate 重新加锁
/var/log/auth.log {
    weekly                 # 每周轮转（覆盖全局默认）
    rotate 4               # 保留 4 份归档
    create 0640 syslog adm # 轮转后新建空日志文件
    prerotate              # 轮转前执行：解开 +a 锁，否则无法 rename
        chattr -a /var/log/auth.log
    endscript
    postrotate             # 轮转完成后执行：重新加锁 + 发 HUP 重开日志（见下方 HUP）
        chattr +a /var/log/auth.log
        #通知通知 rsyslog 重新打开日志文件（相当于 kill -HUP rsyslog）
        /usr/lib/rsyslog/rsyslog-rotate
        #kill -HUP $(cat /var/run/sshd.pid)直接发信号给对应进程让其停止对旧日志文件的写入
    endscript
}
```
### SIGHUP（HUP）信号
轮转时旧文件被 `rename` 成归档文件，但**正在写日志的进程还持有旧文件的句柄**，不处理的话新日志会继续写进旧文件，轮转就白做了。解决方法是轮转后向服务发 **SIGHUP（HUP）**，让它**关闭并重新打开日志文件**。  
HUP信号对于不同的进程有不同的含义，例如它也有重新加载配置文件的含义，而有些进程也不认识该信号
### 手动验证
```bash
logrotate -f /etc/logrotate.d/ssh  # 强制执行一次轮转
```
**核心心法**：rsyslog 管"日志**写到哪**"，logrotate 管"日志**怎么清**"——前者用好规则分流，后者配好保留策略并记得 `postrotate` 发 HUP，日志管理就不会出大问题。

