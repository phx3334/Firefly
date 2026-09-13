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

### 确认内核和系统服务层面没直接报错后，看资源瓶颈在 CPU、内存还是 IO：

```bash
uptime        # 1/5/15 分钟负载（经验：超过核数即饱和，且 15min > 5min > 1min 说明是慢性问题）
top           # 总览
```

top 里按 `1` 看每核、`Shift+M` 按内存排、`Shift+P` 按 CPU 排。重点三个指标：
| 现象 | top 特征 | 下一跳 |
|------|---------|--------|
| CPU 高 | us 高=应用在算；sy 高=系统调用频繁（结合第一/四步找内核行为）；wa 高=等 IO | `iostat -x 1` 看哪个盘 |
| 内存高 | available 低、buff/cache 被挤掉；配合 dmesg 确认是否 OOM | `ps aux --sort=-rss \| head` |
| 负载高但 CPU 低 | load 高 us/sy 却不高 → 大量进程在 D 状态等 IO | `ps axo stat,cmd \| grep '^D'` |

> load 高不一定是 CPU 忙，**不可中断睡眠（D 状态，通常是磁盘 IO/ NFS 卡死）的进程也算进 load**——这是「负载高但 top 里 CPU 空闲」的谜底。

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
