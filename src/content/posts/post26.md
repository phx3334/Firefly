---
title: 日志审计和故障追踪
published: 2026-09-13T22:11:23+08:00
description: 掌握黄金四步法排查服务器故障
image: './images/a26.avif'
tags: [linux]
category: '计算机技术'
draft: false
lang: '中文'
---


## 黄金四步法

接到一台「不对劲」的服务器（慢、无响应、资源报警），不确定根因时，按固定顺序扫一遍，避免凭感觉乱猜。这四步的本质是**分层定位**：先内核 → 再系统服务 → 再资源负载 → 最后网络连接，故障无论藏在哪一层，都能被这一遍扫描直接命中或大幅缩小范围。

> 顺序不是教条，但建议固定下来形成肌肉记忆——故障排查最忌讳的就是东一下西一下。

### 第一步：dmesg —— 内核层有没有炸

内核环形缓冲区里的日志，硬件故障、OOM、驱动异常最先在这里现形：

```bash
dmesg -T                          # -T 带人类可读时间戳（必加）
dmesg -T | tail -50               # 看最近的
dmesg -T -l err,crit,alert,emerg  # 只看错误及以上级别
dmesg -T | grep -iE 'oom|kill'    # 重点：有没有进程被 OOM 杀掉
```

高频命中：
- **OOM killer**：`Out of memory: Killed process ...`——服务莫名消失的第一嫌疑人，内存不足时内核按 badness 评分杀进程，应用日志里往往什么都没有。
- **硬件/IO**：`I/O error`、`sd X: sector not found`（盘要挂了）、网卡链路 up/down。
- **TCP 连接队列溢出**：`TCP: request_sock_TCP: Possible SYN flooding`、`conntrack table full`（高并发机器的经典）。

### 第二步：journalctl —— 系统服务层挂了谁
内核之下看服务层：哪些服务崩了、在重启、报了什么错：

```bash
journalctl -p err -b                        # 本次开机以来的错误及以上
journalctl -u nginx -f                      # 跟踪可疑服务实时日志
journalctl --failed                         # / 或 systemctl list-units --failed
journalctl -b -1 -p err                     # 上次开机的错误（重启后追崩溃现场）
```

典型命中：服务反复 crash 循环（`Restart counter` 连续增长）、认证风暴（`sshd` 被爆破的海量 failed password）、磁盘写满导致服务写日志失败。

### 第三步：top / uptime —— 资源负载压在哪

确认内核和系统服务层面没直接报错后，看资源瓶颈在 CPU、内存还是 IO：

![top命令输出](./images/p3.avif)

```bash
uptime        # 1/5/15 分钟负载（经验：超过核数即饱和，且 15min > 5min > 1min 说明是慢性问题）
top           # 总览
```

top 首行 CPU 各列的缩写含义：

| 列 | 含义 |
| --- | --- |
| us | 用户态占用 CPU 百分比 |
| sy | 内核态占用 CPU 百分比 |
| ni | 改过优先级的用户进程 |
| id | 空闲 CPU 百分比 |
| wa | IO 等待占用 CPU 百分比 |
| hi / si | 硬中断 / 软中断占用 CPU 百分比 |

top 里按 `1` 看每核、`Shift+M` 按内存排、`Shift+P` 按 CPU 排。重点三个指标：
| 现象 | top 特征 | 下一跳 |
|------|---------|--------|
| CPU 高 | us 高=应用在算；sy 高=系统调用频繁（结合第一/四步找内核行为）；wa 高=等 IO | `iostat -x 1` 看哪个盘 |
| 内存高 | available 低、buff/cache 被挤掉；配合 dmesg 确认是否 OOM | `ps aux --sort=-rss \| head` |
| 负载高但 CPU 低 | load 高 us/sy 却不高 → 大量进程在 D 状态等 IO | `ps axo stat,cmd \| grep '^D'` |

#### 进程状态：R / S / D / T / Z / I

进程状态由内核记录，可通过 `ps -o stat,pid,cmd` 或 `/proc/<pid>/stat` 第 3 个字段查看：

| 状态 | 含义 | 能否被打断 | 典型场景 |
| --- | --- | --- | --- |
| R（Running） | 正在运行或在运行队列中等待 CPU | — | 正常计算任务 |
| S（Sleeping） | 可中断睡眠，等待某事件 | ✅ 可被信号唤醒 | 等 IO、等锁、sleep |
| D（Uninterruptible） | 不可中断睡眠，等 IO 完成 | ❌ kill -9 也没用 | 磁盘/NFS 读写卡住 |
| T（Stopped） | 停止 | 可继续 | Ctrl+Z（SIGTSTP） |
| Z（Zombie） | 僵尸：已退出但父进程没 wait 收尸 | — | 父进程没处理 SIGCHLD |
| I（Idle） | 内核空闲线程 | — | 不算入负载 |

**STAT 列是「主状态 + 修饰符」的复合**：`ps` 里的 STAT 用大写字母表示主状态（上表），后面可跟小写修饰符：

| 修饰符 | 含义 |
| --- | --- |
| s | 会话首领（由 `setsid()` 创建，脱离原会话） |
| l | 多线程 |
| + | 前台进程 |
| < | 高优先级（nice < 0） |
| N | 低优先级（nice > 0） |

所以 `Ss` = S（睡眠）+ s（会话首领）。**1 号进程在 `ps` 里几乎都是 `Ss`**——systemd、容器的 init 进程都一样，都由 `setsid` 脱离原会话成为会话首领。反过来，`ps axo stat,cmd | grep '^D'` 筛出来的就是卡在 IO 上的进程，第三步「load 高但 CPU 闲」时第一时间要抓的就是它们。

#### load average 和 CPU 利用率不是一回事

**平均负载（load average）**：1/5/15 分钟「活跃任务数」的平均（R + D），Linux 特地把不可中断状态也算进去（为了暴露 IO 阻塞）。
**CPU 利用率**：CPU 在统计周期内真正干活的时间占比（us+sy 等），0~100%（N 核上限 100%×N）。

| 对比维度 | 平均负载 | CPU 利用率 |
| --- | --- | --- |
| 统计对象 | 任务数（排队的有几个） | CPU 忙不忙（时间占比） |
| 单位 | 个数（可以是小数/几十） | 百分比 |
| 数据源 | 运行队列长度 + D 状态数 | /proc/stat 的累计时间差值 |
| 类比 | 餐厅排队人数 | 厨房开火率 |

**经典判断组合**：

| 现象 | 结论 |
| --- | --- |
| load 高 + CPU 忙（us/sy 高） | CPU 瓶颈，扩容/优化 |
| load 高 + CPU 闲（id 高）+ wa 高 | 磁盘 IO 瓶颈（D 状态在等真实 IO，iowait 能看到） |
| load 高 + CPU 闲（id 高）+ wa 低 | 卡在不可中断状态（NFS 失联/内核锁），最麻烦 |
| load 低 + CPU 高 | 任务少但都在跑，正常 |

**load 和核数的关系**：

- 经验上：load ≈ 核数 表示「刚好用满」（8 核 load 8），大于核数说明有排队
- 但要小心：D 状态进程会让 load 虚高——8 核机器 load 20 但 CPU 全闲，很可能是 IO 卡死而不是真忙
- 判断负载健康要用 `top`/`uptime` 结合 CPU%、D 进程数一起看，单看 load 会误判

> 一句话：**load 数的是「排队的任务」，CPU% 量的是「干活的忙碌度」**，两者独立采样，所以才会出现「load 20、CPU 全闲」这种既真实又最容易误判的组合。

#### CPU 使用率怎么算：系统级 / 进程级 / 容器级

- **系统级**：`/proc/stat` 里每个 CPU 的累计 jiffies，两次采样相减除以时间窗，就是 top 首行的 us/sy/wa——它天然是**整机口径**。
- **进程级**：`/proc/<pid>/stat` 的第 14、15 个字段分别是 `utime`（用户态）和 `stime`（内核态），单位是 clock tick（USER_HZ，通常 100，即 1 tick = 10ms）。t 秒内该进程的 CPU 使用比 = `((u2-u1)+(s2-s1)) / (USER_HZ × t)`，100% 表示用满一颗核，200% 表示用满两颗（线程池类进程常见）。
- **容器级**：容器里执行 `top` **看不到容器自己的数据**——`/proc/stat` 是全局的，PID namespace 隔离不了它，读到的是宿主机累计值。要看容器整体，用 `docker stats`（数据源是 cgroup 的 `cpu.stat`），k8s 里用 `kubectl top pod`。

```bash
docker stats --no-stream <容器名>   # CPU% 一列即容器整体使用率，数据源来自 cgroup
cat /proc/19838/stat               # 单进程：第 14/15 字段即 utime、stime
```

所以「容器里 top 显示 CPU 打满、`docker stats` 只有 5%」不是矛盾——前者是宿主机口径，后者才是这个 cgroup 的口径。


### 第四步：ss -antlp —— 网络连接是否异常

最后看连接层：连接数、状态分布、谁占着端口：

```bash
ss -antlp                          # 全量：a=含监听 t=TCP n=数字解析 l=监听 p=进程（要 root）
ss -ant | awk '{print $1}' | sort | uniq -c | sort -rn   # 各状态连接数分布
ss -ant state established | wc -l  # 活跃连接总数
ss -tnp state established '( dport = :6379 )'            # 按对端端口过滤
```

状态分布能直接定性故障：
- **大量 TIME_WAIT**：本机作为客户端频繁短连接（如每次请求都新建 upstream 连接），压 Nginx/upstream keepalive 或 `tcp_tw_reuse`。
- **大量 CLOSE_WAIT**：**对端关了你没关**——代码里 fd 泄漏/忘了 close，是应用 bug 的铁证（和 TIME_WAIT 完全不同：TIME_WAIT 是正常挥手状态，CLOSE_WAIT 是你欠着没关）。
- **SYN-RECV 堆积**：被 SYN flood 或 accept 太慢，回到第一步看 dmesg 有没有 SYN flooding 日志。
- `-p` 能确认端口和进程对得上：端口被陌生进程占用、监听 0.0.0.0 却该只听 127.0.0.1 这类配置问题一眼现形。

### 四步合起来怎么用
以「服务偶发 502」为例走一遍：
1. `dmesg -T -l err` → 无 OOM，排除内核杀进程；
2. `journalctl -u nginx -p err --since "2h ago"` → `connect() failed (110: Connection timed out) while connecting to upstream`；
3. `top` → wa 很高，`ps axo stat,cmd | grep '^D'` → 后端应用进程在等 IO；
4. `ss -ant | ...` → 到后端端口（如 8080）的 ESTAB 连接堆积。

结论链：磁盘慢 → 后端处理慢 → accept/响应跟不上 → 连接堆积 → 超时 502。四步扫完，根因从「偶发 502」收敛到「后端磁盘 IO 瓶颈」，下一步换盘或优化 IO 即可。
**心法**：四步法是「扫描器」不是「终点」——它的价值在于 5 分钟内系统性地过一遍所有层，把「不知从何下手」变成「有一个明确的下一跳」，剩下的交给各层的深度工具（iostat、pidstat、strace、perf…）。
