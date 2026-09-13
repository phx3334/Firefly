---
title: 入门systemd
published: 2026-08-17T20:11:23+08:00
description: 学习systemd及其systemclt工具的使用 
image: './images/a18.avif'
tags: [linux]
category: '计算机技术'
draft: false
lang: '中文'
---


## 前置
### linux创建进程的过程
- fork()：完整复制调用进程（父进程）的地址空间、文件描述符、信号处理器等，产生一个几乎一模一样的子进程，随后父进程继续执行原代码，子进程从 fork() 返回处继续执行。
- execve()（或其他 exec 系列）：用新程序的可执行文件替换子进程的映像（代码段、数据段、堆栈全部换掉）。  
>基于 clone() 系统调用实现，fork/vfork/pthread_create（创建线程） 只是 clone 的不同配置（是否共享地址空间、文件描述符、信号等）。  

- 在linux系统中，线程其实是通过clone()加共享标识创造的“轻量线程”，线程与进程界限模糊，但依旧可以理解为进程是资源容器，线程是最小的资源调度单位。
- 在windos系统中进程和线程的作用和windos几乎一样，只是windos系统中，严格区分了进程和线程，他们底层是完全不同的2种结构体。


## systemd介绍
### 定义
systemd 是 Linux 的系统和服务管理器，是现代主流发行版的默认 init 系统。系统启动后运行在用户态的第一个进程（PID 1），是所有用户进程的祖先。  
init是“岗位”，systemd是“员工”。内核会根据/sbin/init、/etc/init等优先级查找第一个进程，/sbin/init软链接 /lib/systemd/systemd
### 创建过程
systemd 不是被 fork 出来的，而是内核"先复制、后换映像"变出来的，恰好用到了前置知识里的两个机制：  
- 复制：内核从 idle（编译期静态定义 init_task，非创建）（PID 0）复制出内核线程 kernel_init（PID 1）
- 换映像：kernel_init 执行 execve("/sbin/init")，程序映像替换成 systemd，PID 不变（仍为 1）
### unit 介绍
Unit 是 systemd 的资源管理抽象：systemd 不直接管「程序」，而是管「unit」——任何被 systemd 托管的对象都是一个 unit，对应一个配置文件。常见类型：
| 后缀 | 职责 | SRE 常见例子 |
|------|------|--------------|
| `.service` | 守护进程/服务 | nginx.service、kubelet.service |
| `.timer` | 定时触发（替代 cron） | 日志切割 |
| `.socket` | 按需激活（有连接才拉服务） | sshd.socket |
| `.mount` / `.automount` | 挂载点 | 数据盘、NFS |
| `.target` | 一组 unit 的聚合点（替代 SysV 运行级别） | multi-user.target、graphical.target |
| `.slice` | cgroup 层级分组（资源划分） | user.slice、system.slice |

文件查找路径（优先级从高到低）：`/etc/systemd/system`（管理员手写，优先级最高）→ `/run/systemd/system`（运行时生成）→ `/usr/lib/systemd/system`（软件包安装的默认版本）。改配置永远改 /etc，升级覆盖不了。改完必须 `daemon-reload`。

### service 详解

#### unit 文件结构

以一个生产级例子逐段讲：

```ini
[Unit]
Description=Nginx Web Server
After=network-online.target        # 启动顺序：等网络就绪（弱依赖用 Wants）
Wants=network-online.target

[Service]
Type=notify                        # 见下文 Type 详解
ExecStart=/usr/sbin/nginx -g "daemon off;"
ExecReload=/usr/sbin/nginx -s reload
Restart=on-failure
RestartSec=5
LimitNOFILE=65535                  # 等价于 ulimit -n，解决 fd 上限
MemoryMax=2G                       # cgroup 硬限制
CPUQuota=200%                      # 最多用 2 个核

[Install]
WantedBy=multi-user.target         # enable 时软链到哪个 target
```

三个段的责任边界：**[Unit] 描述依赖与启动顺序**（After/Wants/Requires），**[Service] 描述进程怎么跑、挂了怎么办**，**[Install] 描述 enable 的行为**。

#### Type=：systemd 怎么判断「服务启动成功了」

这是 service 最容易配置错、也最能体现理解深度的字段：

- `simple`（默认）：ExecStart 一 fork 出来 systemd 就算它启动成功。**陷阱**：程序若启动慢（比如初始化要 30 秒），systemd 早把状态报为 active，后续依赖它的服务可能连不上——典型的「假 active」。
- `forking`：程序自己 fork 到后台（传统 SysV daemon 行为），systemd 等父进程退出才算成功。需要配 `PIDFile=`。
- `notify`：程序主动调 `sd_notify("READY=1")` 通知 systemd 才算成功。**最可靠**，nginx（编译了 systemd 支持）、etcd 都支持。
- `oneshot`：跑一次就退出（配合 RemainAfterExit=yes），适合脚本类任务。
- `exec`：类似 simple，但要求 execve 真正成功才算启动。

SRE 经验：现代服务尽量 `notify` 或 `exec`；`simple` + 启动慢的服务要配 `ExecStartPost=` 探活脚本兜底，否则滚动发布时流量会提前切过来。

#### Restart=：崩溃自愈策略

| 值 | 何时重启 |
|-----|---------|
| no（默认） | 永不（SRE 基本不用） |
| always | 任何退出都重启，含 clean exit |
| on-failure | 非零退出码、被信号杀、超时才重启 |
| on-abnormal | 仅被信号杀/超时，正常退出不重启 |

配套 `RestartSec=5`（重启间隔，防疯狂重启刷 CPU）和 `StartLimitIntervalSec`/`StartLimitBurst`（如 60 秒内崩 5 次就进入 failed 不再拉起，防止故障风暴）。

#### 依赖关系：Wants vs Requires vs After

- `Wants=`：弱依赖，被依赖的启动失败不影响自己（最常用）。
- `Requires=`：强依赖，对方挂了自己也停。
- `After=`：只管**顺序**，不管依赖；`Wants` + `After` 组合 = 「希望它先启动，且等它先启动」。只写 Wants 不写 After 是并行的，谁先谁后看调度。

#### 启用与操作命令

```bash
systemctl daemon-reload            # 改了 unit 文件后必须执行
systemctl start/stop/restart nginx
systemctl reload nginx             # 平滑重载（要求服务定义了 ExecReload）
systemctl enable nginx             # 开机自启（创建软链）
systemctl enable --now nginx       # 自启 + 立即启动，一条命令
systemctl status nginx             # 状态 + 最近日志（排障第一步）
systemctl cat nginx                # 看实际生效的完整 unit（含 drop-in）
systemctl edit nginx               # 改 drop-in（见下）
systemctl list-units --failed      # 巡检：列出所有失败服务
```

#### 应用场景

1. **标准守护进程**：上面的 nginx 例子，重点在 Type、Restart、资源限制。
2. **开机脚本（oneshot）**：内核参数、数据盘格式化、容器启动前的准备：
   ```ini
   [Service]
   Type=oneshot
   RemainAfterExit=yes
   ExecStart=/opt/scripts/init-disk.sh
   ```
3. **drop-in 覆盖（改官方服务不碰原文件）**：`systemctl edit nginx` 生成 `/etc/systemd/system/nginx.service.d/override.conf`，只写要覆盖的字段，包升级不丢。改 kubelet 的 `ExecStart` 参数就是标准做法（drop-in 追加启动参数）。
4. **用户级服务**：`systemctl --user`（配合 `loginctl enable-linger` 让用户服务不登录也能跑），适合跑非 root 服务。
5. **服务调试**：起不来时三板斧——`systemctl status`（看退出码/信号）→ `journalctl -u nginx -n 100`（看日志）→ `systemd-analyze verify /etc/systemd/system/nginx.service`（语法与依赖检查）。

### journald

journald 是 systemd 的日志组件，接管所有 unit 的 stdout/stderr、syslog 和内核日志，默认存二进制格式（`/run/log/journal` 临时 / `/var/log/journal` 持久化）。

两个 SRE 必知的配置点（`/etc/systemd/journald.conf`）：

- **持久化默认是关的**：很多发行版默认只有 /run（内存盘），**重启日志全丢**。`mkdir -p /var/log/journal && systemctl restart systemd-journald` 开启持久化——排障时才发现昨夜的崩溃日志没了，是最常见的翻车现场。
- **磁盘配额**：`SystemMaxUse=2G` 之类限制上限，防止日志写满盘（journald 自身会轮转，但没配额的应用日志不会）。

常用查询（二进制不能直接 cat，必须走 journalctl）：

```bash
journalctl -u nginx                       # 单个服务
journalctl -u nginx -f                    # 实时跟踪（等价 tail -f）
journalctl -u nginx --since "1h ago"      # 时间范围
journalctl -u nginx -p err                # 按优先级过滤
journalctl -b -1                          # 上一次开机的日志（重启前崩溃排查利器）
journalctl --disk-usage                   # 当前占用
journalctl --vacuum-size=1G               # 手动清理
```

**journald vs rsyslog**：journald 负责收集和本地结构化存储，rsyslog 负责转发到远端。云原生实践中日志通常由 fluent-bit/loki 等采集器读容器日志，journald 主要看系统服务和宿主机层故障——分层看日志的意识很重要：应用问题看容器日志，节点问题看 journalctl。

### systemd 与 cgroup：原生的资源管控

systemd 是整个系统 cgroup 树的**唯一管理入口**（`/sys/fs/cgroup` 由它组织），每个 service 天生一个 cgroup，这就是 `systemctl status` 能直接显示服务 CPU/内存占用的原因。

默认层级：

```text
-.slice（根）
├── system.slice        ← 所有系统服务
│   └── nginx.service   ← 每个服务一组 cgroup，全进程一网打尽
├── user.slice          ← 用户会话
└── machine.slice       ← 容器（docker/k8s 默认挂在这下面）
```

**关键设计：按 cgroup 管进程而非按 PID 管**。传统 init 只记录服务的主 PID，fork 出来的子进程就管不着了；systemd 杀服务直接对整个 cgroup 发信号（`KillMode=control-group` 默认值），杜绝「主进程杀了、worker 残留」的僵尸问题。Nginx 用 `KillMode=mixed` 就是这个原理的应用。

在 unit 里直接写资源限制（就是在写 cgroup 参数）：

```ini
CPUQuota=200%          # cpu.max：最多 2 核
MemoryMax=2G           # memory.max：超了触发 OOM kill（区别于 MemoryHigh 软限流）
TasksMax=4096          # pids.max：防 fork 炸弹
IOWeight=100           # 磁盘 IO 权重
```

**云原生衔接**：K8s/Docker 的 cgroup 树默认就挂在 systemd 的 machine.slice/system.slice 下（`--cgroup-driver=systemd` 就是让 kubelet 把容器的 cgroup 交给 systemd 管理，而不是自己建树）。kubelet 的 resources.limits 内存落地后就是容器 cgroup 的 memory.max——你在 Deployment 里写的 limit，最终就是 systemd 帮你在文件系统里写的同一个文件。理解了这一层，节点上「Pod 被 OOMEvicted」和「服务被 systemd OOMKill」就统一起来了：都是 cgroup memory.max 的行为，只是挂在不同的父节点下。

顺带的节点级排查命令：

```bash
systemd-cgtop                    # 按 cgroup 实时看资源占用（比 top 多了分组视角）
systemd-cgls                     # 树状展示 cgroup 归属
systemctl status nginx           # status 里直接有 CGroup 展开的进程列表
cat /sys/fs/cgroup/system.slice/nginx.service/memory.max   # 实际生效的限值
```

### 补充：timer 替代 cron
简单场景下 timer 是 cron 的现代替代，优势是日志进 journal、失败可重跑、依赖 After 可控：
```ini
# backup.timer
[Timer]
OnCalendar=*-*-* 02:00:00
Persistent=true          # 错过的任务开机后补跑（cron 做不到）

[Install]
WantedBy=timers.target
```
`systemctl list-timers` 巡检所有定时任务。SRE 建议：系统级周期任务逐步迁到 timer，配合 `Persistent=true` 解决「停机窗口错过备份」的经典问题。
