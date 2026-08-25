---
title: 了解防火墙机制
published: 2026-07-28T14:21:21+08:00
description: '大致了解防火墙的作用，底层原理，实际使用方式'
image: './images/a8.avif'
tags: [计算机网络,计算机安全]
category: '计算机技术'
draft: false
lang: '中文'
---

## 防火墙的定位
防火墙本质是一道「访问控制」屏障，工作在网络边界或主机边界，依据预设规则对流量做**过滤、转发、NAT**。按工作层次可分为：  
`1`包过滤（网络层 / 传输层）：基于源 / 目的 IP、端口、协议判断放行或丢弃，Linux 的 netfilter/iptables/nftables 及其前端工具 ufw 主要做这一层。    
`2`状态检测：跟踪连接状态，只放行属于已建立合法连接的数据包，而非孤立地看每个包。    
`3`应用层代理 / WAF：理解应用协议内容（如 HTTP、SQL），做更细的语义级防护。  
核心作用：隔离内外网、收敛暴露面、阻断非法访问、审计与告警。实际部署中，它通常和网络中的**软件防火墙（主机侧）**与**硬件防火墙（边界设备）**分层配合。

## ufw 简单操作
ufw 是 Ubuntu 上 iptables（老版）/nftables 的「前端」：用 allow/deny 的简单命令把规则管理变简单，底层生成 iptables 语法规则，再通过 iptables-nft 兼容层交给 nftables 执行。常用命令如下：
```bash
# 启动并设为开机自启
sudo systemctl enable --now ufw

# 开启防火墙（⚠️ 先放行 SSH 再 enable，避免把自己锁在外面）
sudo ufw allow ssh
sudo ufw enable

# 查看状态
sudo ufw status                    # 状态 + 规则列表
sudo ufw status verbose            # 详细模式（含默认策略）
sudo ufw status numbered           # 带编号显示，便于按编号删除规则

# 放行服务（ufw 支持常见服务名）
sudo ufw allow http
sudo ufw allow https

# 放行端口
sudo ufw allow 8080/tcp
sudo ufw allow 53/udp

# 移除 / 查询
sudo ufw delete allow http         # 移除放行 http
sudo ufw status | grep 8080        # 查询 8080 是否放行

# 默认策略（ufw 没有 zone，用默认策略表达整体信任等级）
sudo ufw default deny incoming
sudo ufw default allow outgoing
# ufw 规则即时生效、默认永久保存，无需 reload
```
### 默认策略 + 规则列表的设计
**ufw 没有 zone，核心是「默认策略（default policy）+ 规则列表」**：用默认策略定义整体信任等级，再用一条条 allow/deny 规则放行具体端口。模型比 firewalld 的 zone 更简单直观。
| ufw 概念 | 含义 | 典型用途 |
| --- | --- | --- |
| `default deny incoming` | 入站默认拒绝 | 服务器：默认不开放，只放行显式声明的端口 |
| `default allow outgoing` | 出站默认放行 | 服务器：主动对外访问不受限 |
| `allow 服务/端口` | 放行具体业务 | 如 `allow 8080/tcp`、`allow http` |
**service＝「端口 + 协议」的命名**：ufw 直接支持 `/etc/services` 里的服务名，如 `http`=80/tcp、`https`=443/tcp、`ssh`=22/tcp，用名字代替裸端口，语义清晰、可复用；自定义端口直接写数字即可。
一句话：**默认策略决定「整体信不信任」，allow/deny 规则决定「具体放行谁」**，把规则从"面向数据包"升级为"面向业务"，易读也易维护。
**举例**：一台 Web 服务器，内网网卡 `eth1`（全放行），公网网卡 `eth0`（只开 Web 服务）：
```bash
sudo ufw default deny incoming                   # 整体默认拒绝入站
sudo ufw allow in on eth1                        # 内网网卡：信任度高，全放行
sudo ufw allow in on eth0 to any port http       # 公网网卡：只放行 80
sudo ufw allow in on eth0 to any port https      # 公网网卡：只放行 443
sudo ufw enable
```
效果：内网访问不受限；公网仅放行 80/443，其余一律丢弃。


## nftables
nftables 是 Linux 内核的新一代**包过滤框架**，统一替代旧的 iptables / ip6tables / arptables / ebtables 四套工具。ufw 的 allow/deny 意图最终就是翻译成 iptables/nftables 规则下发。  
核心概念只有三个：**表（table）**= 命名空间、**链（chain）**= 挂到钩子上的时机、**规则（rule）**= `条件 动作`。  
```bash
# 建表 → 建链挂到 input 钩子 → 加规则
nft add table inet filter
nft add chain inet filter input { type filter hook input priority 0;}
nft add rule inet filter input tcp dport 22 accept
#查看完整规则集，并不做DNS解析
nft -n list ruleset
```
### 与 netfilter 的关系
netfilter 是内核网络栈的**钩子框架**（五链检查点），nftables 是挂在其上的**规则引擎**（表达与执行规则）——它替代的是 iptables，不是 netfilter。  
```text
用户配置（ufw / nft 命令）
   ↓ 翻译
nftables 规则集（表 + 链 + 规则）
   ↓ 挂载
netfilter 钩子（五链） → 数据包经过时按规则处理
```
一句话：**netfilter 提供「在哪检查」，nftables 决定「检查什么、怎么处理」；五链属于 netfilter，nftables 用自己的表 / 链挂上去。**
**钩子** ：可以理解成内核网络栈里预埋的"挂钩点 / 检查站"——数据包经过这些点时，会被"挂住"停下来，让规则看一眼再放行。

## 四表五链（netfilter 包处理流程）
netfilter 框架在内核里提供五个固定钩子（五链）；「四表」是 iptables 对规则的组织方式（nftables 下改为自定义表，钩子不变）。**表**决定规则属于哪类处理（过滤 / NAT / 修改 / 跟踪），**链**决定「在哪个时机生效」。  
```mermaid
flowchart TD
    A[数据包进入网卡] --> B["PREROUTING 链<br/>(raw → mangle → nat)"]
    B --> C{路由判断<br/>目标是本机?}
    C -->|是| D["INPUT 链<br/>(mangle → filter)"]
    D --> E[本地进程]
    E --> F["OUTPUT 链<br/>(raw → mangle → nat → filter)"]
    C -->|否 / 转发| G["FORWARD 链<br/>(mangle → filter)"]
    F --> H["POSTROUTING 链<br/>(mangle → nat)"]
    G --> H
    H --> I[数据包发出网卡]
```
表与链的可挂载关系：
| 表（table） | 作用 | 可挂载的链 |
| --- | --- | --- |
| raw | 连接跟踪前处理（标记 NOTRACK） | PREROUTING、OUTPUT |
| mangle | 修改报文（TOS、TTL、MARK 等） | 全部五链 |
| nat | 地址转换（SNAT / DNAT） | PREROUTING、INPUT、OUTPUT、POSTROUTING |
| filter | 包过滤（最常用、默认表） | INPUT、FORWARD、OUTPUT |
五个链的含义：
`PREROUTING` 路由判断前；`INPUT` 发往本机；`FORWARD` 本机转发；`OUTPUT` 本机发出；`POSTROUTING` 路由判断后、发出前。
注：五链是内核事实，iptables / nftables 都挂在上面；nftables 只是把「四表」换成自定义表 + 优先级来挂链。


## 为什么一般很少手动加防火墙规则
实际生产里，业务服务器上**很少人去堆 iptables/ufw 规则**，核心原因是「代价」：  
`1`规则过多会严重拉低转发速率：软件防火墙是**逐条匹配**的，每个数据包都要从头遍历规则链。规则越膨胀，单包处理的 CPU 开销越大，单位时间能转发的包数（pps）明显下降，直接拖累业务吞吐。  
`2`复杂度骤升、难维护：规则一多，增删改查都容易出错，排障时很难看清到底哪条在生效，一旦配错还可能把自己挡在门外（连 SSH 都上不去）。    
`3`因此主机侧只留「最小必要规则」：通常只开放必要端口、限制管理来源 IP，保持链短而精，把匹配开销压到最低。  
`4`繁重的过滤交给硬件防火墙 / 云安全组：边界专用设备（Palo Alto、Fortinet、华为/思科，或云安全组 / ACL）用专用 ASIC 做线速转发与 DPI、IPS，规则再多也不消耗业务服务器 CPU，还能集中管理。  

一句话：**少写规则是为了保住转发性能、压住运维复杂度；重活交给有硬件加速的边界防火墙去干。**
