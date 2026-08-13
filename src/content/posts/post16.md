---
title: linux日志管理
published: 2026-08-13T23:11:23+08:00
description: 学会rsyslog和logrotate的使用方法以及配置文件的主要内容
image: './images/a16.avif'
tags: [计算机网络,linux]
category: '计算机技术'
draft: false
lang: '中文'
---

## rsyslog

**rsyslog** 是 Linux 上最主流的系统日志守护进程，负责**收集、过滤、写入（或转发）日志**。系统各组件（内核、服务、程序）把日志消息发给它，它按照规则决定"写到本地哪个文件 / 转发到哪里"。

### 日志等级（severity）
rsyslog 的规则核心是"**来源（facility）+ 等级（priority）**"，等级数字越小越严重（这里只展示三个）：
| 等级 | 数字 | 含义 |
|------|------|------|
| emerg | 0 | 系统不可用（panic） |
| info | 6 | 普通信息 |
| debug | 7 | 调试信息 |

常见来源 facility：`auth`/`authpriv`（认证）、`cron`（计划任务）、`daemon`（守护进程）、`kern`（内核）、`mail`（邮件）、`user`（用户程序）、`local0~local7`（自定义程序）。
### 主配置：/etc/rsyslog.conf
主配置分三大块：**模块配置、全局配置、规则配置**。

#### 模块配置（MODULES）
加载 rsyslog 的输入/功能模块，决定它能收什么日志：
```conf
# 了解即可

module(load="imuxsock")   # 接收本地系统日志（/dev/log）
module(load="imklog")     # 接收内核日志
# module(load="imudp")    # 开启后能接收远程 UDP 日志
# module(load="imtcp")    # 开启后能接收远程 TCP 日志
```

#### 全局配置（GLOBAL DIRECTIVES）
定义工作目录、输出模板、以及**引入分片配置**：
```conf
#了解即可

$WorkDirectory /var/spool/rsyslog            # 队列文件等临时文件存放目录
$ActionFileDefaultTemplate RSYSLOG_TraditionalFileFormat   # 默认输出格式
$IncludeConfig /etc/rsyslog.d/*.conf         # 引入分片配置（见下文）
```

#### 规则配置（RULES）
真正决定"日志写到哪"，格式为 `来源.等级  目的地`：
```conf
# 认证相关日志（含敏感信息）全部级别 → auth.log
auth,authpriv.*         /var/log/auth.log

# 所有来源的所有等级，排除 auth/authpriv/cron → syslog
*.*;auth,authpriv.none;cron.none  -/var/log/syslog

# cron 的日志单独一个文件
cron.*                  /var/log/cron.log

# 内核日志
kern.*                  -/var/log/kern.log
```
> 文件名前的 `-` 表示**异步写**（先写缓冲区，不阻塞），适合高频日志；注意进程崩溃时可能丢最后一部分日志。

### 日志转发配置
日志太多或要集中管理时，把本机日志转发到远程日志服务器：
```conf
# 转发到远程（@=UDP 不保证送达；@@=TCP 可靠）
*.*  @192.168.1.100:514        # UDP 转发
*.*  @@192.168.1.100:514       # TCP 转发

# 远程日志服务器端需要在模块配置中开启接收模块
module(load="imudp")
input(type="imudp" port="514")
```
> 默认是**明文传输**，建议只在可信内网使用；跨公网转发应走 TLS或 VPN。

### 分片配置机制：/etc/rsyslog.d/*.conf
主配置通过 `$IncludeConfig` 按**文件名字母序**合并加载 `/etc/rsyslog.d/` 下所有 `.conf`。作用是把规则**按应用/用途拆分**，避免都堆在主配置里，安装/卸载软件时增删文件即可，不用动核心。
> 注意：不是"分片优先级更高"，而是"按顺序执行，每条日志从第一条规则开始匹配"；同一条日志可以同时命中多条规则，写入多个文件。

举例解释规则：
```conf
# 按程序名分流：程序名是 sshd 的日志单独写一个文件    属性, 操作符, "值" 动作
:programname, isequal, "sshd"  /var/log/sshd.log

# 同时满足多条规则：auth 日志既写本地，又转发到远程日志服务器
authpriv.*                    /var/log/auth.log
authpriv.*                    @@192.168.1.100:514
```

生效与验证：
```bash
systemctl restart rsyslog   # 重载配置
tail -f /var/log/syslog     # 观察日志是否正常写入
```

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