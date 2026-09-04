---
title: 入门Nginx
published: 2026-09-3T20:11:23+08:00
description: 学习Nginx的基本原理和基础配置
image: './images/a24.avif'
tags: [nginx]
category: '计算机技术'
draft: false
lang: '中文'
---
Nginx入门介绍请访问https://www.yuque.com/wukong-zorrm/cql6cz/ld0pzi
## 入门部分补充
proxy-pass后面的ip或者域名的末尾如果加了/，那么传给后端的真实路由会丢弃location匹配到的host前缀  
### stream和http模块
stream模块是四层代理，http模块是七层代理。

二者都遵循 OSI，但工作层级不同，能力也不同：

| 维度 | stream（四层） | http（七层） |
|------|---------------|-------------|
| 可见内容 | IP+端口+字节流 | URL、Header、Cookie、Body |
| 是否解析协议 | 否（黑盒转发） | 是 |
| 能否改写内容 | 否 | 是（rewrite、加头、缓存） |
| TLS | 可透传不解密 | 通常终止解密 |
| 典型后端 | MySQL/Redis/SSH | 网站、API |

**为何要用四层**：① 流量非 HTTP（数据库、SSH、游戏协议），七层看不懂；② 不能/不想在 Nginx 终止 TLS，靠 `ssl_preread` 隔 TLS 看 SNI 透传；③ 低开销，只搬字节。

**何时用七层**：需按 URL/域名路由、缓存、压缩、鉴权、WAF、限流、改写 Header 等应用层逻辑时。

**同字段两模块差异**：
- `proxy_pass`：http 带 URI 语义、参与路径拼接（末尾 `/` 砍前缀）；stream 仅原样转发连接，无路径概念。
- `listen`：http 可带 `ssl`/`http2`；stream 常配 `ssl_preread on`。
- 超时：`proxy_*` 在 http 针对请求/响应，在 stream 针对整条连接生命周期。

**四层常见字段**：`ssl_preread on`（读 SNI/ALPN 配 `map` 分流）、`proxy_protocol on`（透传真实客户端 IP）、`proxy_timeout`（连接空闲超时）、`listen 53 udp`（代理 UDP）。

### SNI在https加密过程中的作用
HTTPS = HTTP 跑在 TLS 加密之上。一次 HTTPS 从明文到加密的完整过程：
1. **TCP 三次握手**：浏览器与服务器建立 TCP 连接（IP:443）。
2. **TLS ClientHello（明文）**：浏览器发 `ClientHello`，含支持的 TLS 版本、密码套件、**SNI（目标域名）**、随机数与密钥材料。此时连接未加密，SNI 为明文。
3. **服务器回 Certificate**：服务器按 SNI 选出对应域名的证书返回，并发送 `ServerHello`、服务端密钥材料。
4. **密钥协商**：双方交换材料算出对称密钥（如 ECDHE），后续数据用其加密。
5. **加密通信**：浏览器校验证书（域名与 SNI 一致、CA 可信）后，发送加密 HTTP 请求，服务器解密处理并返回加密响应。
**SNI 的作用**：出现在第 2 步，解决“鸡生蛋”问题——证书必须在加密前下发，但服务器要等握手后才看得到 HTTP 里的域名。SNI 让客户端在加密前声明目标域名，使**同一 IP+端口能托管多个 HTTPS 站点**（按域名发对应证书）。无 SNI 时一台服务器只能绑一张证书/一个域名。
**代价**：SNI 在握手初期为明文，中间人可见“你在连哪个域名”（看不到内容）；ECH 正将 SNI 也加密以弥补。

**ALPN 是什么**：ALPN（Application-Layer Protocol Negotiation）也是 TLS 握手扩展，客户端在 `ClientHello` 中带上支持的协议列表（如 `h2, http/1.1`），服务器选其一回传，握手结束即直接用该协议通信，省去额外升级往返。主要用于协商 HTTP/2 与 HTTP/1.1。与 SNI 区别：SNI 解决“访问哪个域名（选哪张证书）”，ALPN 解决“握手完用哪个协议”。七层 `http` 用 `listen 443 ssl http2;` 自动处理；四层 `stream` 可经 `ssl_preread` 读 `$ssl_preread_alpn_protocols` 按协议分流（单端口复用中按 ALPN 分流的依据）。

### keepalive 与 HTTP/1.1 长连接
HTTP/1.1 默认启用持久连接（keep-alive）：同一 TCP 连接可顺序处理多个请求/响应，无需每次握手。Nginx 里“keepalive”有两层，容易混淆：
1. **客户端 ↔ Nginx**：由 HTTP/1.1 默认持久连接 + Nginx 的 `keepalive_timeout`（默认 75s）控制，浏览器自然复用。
2. **Nginx ↔ 后端（upstream）**：`upstream` 块的 `keepalive N;` 是到后端的连接池，缓存 N 条空闲连接复用，减少 TCP/TLS 握手开销。

关系：HTTP/1.1 持久连接是“协议能力”，`keepalive` 指令是“利用该能力的连接池”。但 Nginx 默认用 HTTP/1.0 代理后端（每次请求关连接），要真正复用后端连接必须：
```nginx
upstream backend {
    server 10.0.0.1:8080;
    keepalive 32;
}
location / {
    proxy_pass http://backend;
    proxy_http_version 1.1;         # 改用 HTTP/1.1（默认 1.0）
    proxy_set_header Connection ""; # 清掉 Connection 头，避免被关连接
}
```
客户端侧 `keepalive_timeout` 与 upstream `keepalive` 是两条独立连接，互不影响。

### 单端口复用
“一个端口扛多种流量”，常见做法：
1. **按 SNI 复用 443**：`stream` + `ssl_preread` 看客户端域名分流，后端各自持证书：
```nginx
stream {
    map $ssl_preread_server_name $backend {
        web.example.com 10.0.0.1:8443;
        ssh.example.com 10.0.0.1:22;
        default         10.0.0.1:8443;
    }
    server { listen 443; ssl_preread on; proxy_pass $backend; }
}
```
2. **按 ALPN 复用**：同一 443 靠 `ssl_preread_alpn_protocols` 区分 `h2`/`http/1.1`。
3. **按首字节嗅探**：`map` 正则匹配连接首字节判断 SSH/RDP/自定义协议再转发（类似 sslh）。
4. **按 Host 头复用（七层）**：一个 `listen 80/443` 下挂多个 `server_name`，靠 HTTP `Host` 分流多站点。
5. **HTTP/2 连接内多路复用**：单 TCP 连接并发多请求流，解决队头阻塞（复用连接内通道）。
总结：单端口复用 = 入口唯一、靠特征分流。四层靠 SNI/ALPN/首字节，七层靠 Host/location。

### 举例Nginx代理实际场景
场景：访问类似b站的视频网站

完整配置（前端 SPA + 后端 API + 弹幕 WebSocket + 媒资），占位路径/服务名均用中文注释说明其含义：

```nginx
# ============ 后端服务集群（上游，可多实例做负载均衡） ============
# 这一段不对外，只是定义“后端是谁”，名字 api_servers 是自定义的组名
upstream api_servers {
    # 后端 API 服务实际监听的地址（内网 IP + 端口，可写多行扩实例）
    server 127.0.0.1:8080;
    server 127.0.0.1:8081;
    # keepalive：与后端保持的空闲连接数，复用 TCP 连接减少握手开销
    keepalive 32;
}

# 弹幕/推送用的 WebSocket 服务集群
upstream danmaku_servers {
    server 127.0.0.1:9090;
}

# ============ 80 端口：只负责把 HTTP 强行跳转到 HTTPS ============
server {
    listen 80;                                          # 监听明文 HTTP 端口
    server_name bilibili-like.com www.bilibili-like.com; # 匹配的域名
    return 301 https://$host$request_uri;               # 永久重定向到 https（保留原路径）
}

# ============ 443 端口：真正处理业务的主服务块 ============
server {
    listen 443 ssl;                                     # 对外唯一加密入口，Nginx 在此终止 TLS
    server_name bilibili-like.com www.bilibili-like.com;

    ssl_certificate     /etc/nginx/ssl/bilibili-like.com/fullchain.pem; # 证书链
    ssl_certificate_key /etc/nginx/ssl/bilibili-like.com/privkey.pem;   # 私钥
    ssl_protocols TLSv1.2 TLSv1.3;                      # 启用的 TLS 版本

    # ① 前端静态资源（SPA 构建产物）
    location / {
        root /var/www/bilibili-frontend/dist;           # 前端打包文件目录（Vue/React 的 dist）
        try_files $uri $uri/ /index.html;               # 找不到文件则 fallback 到 index.html（SPA 路由）
        expires 7d;                                     # 静态资源浏览器缓存 7 天
    }

    # ② 后端 API 代理
    location /api/ {
        proxy_pass http://api_servers;                  # 转发到后端集群（末尾无 / → 保留 /api/ 前缀）
        proxy_http_version 1.1;                         # 用 HTTP/1.1 才能配合 keepalive 复用
        proxy_set_header Host              $host;       # 透传域名
        proxy_set_header X-Real-IP         $remote_addr;                 # 透传客户端真实 IP
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;   # 透传代理链 IP
        proxy_set_header X-Forwarded-Proto $scheme;      # 告诉后端原始协议 http/https
    }

    # ③ 弹幕 WebSocket 代理
    location /ws/ {
        proxy_pass http://danmaku_servers;
        proxy_http_version 1.1;
        proxy_set_header Upgrade    $http_upgrade;      # 协议升级头
        proxy_set_header Connection "upgrade";          # 保持 WebSocket 长连
        proxy_read_timeout 3600s;                        # 弹幕长连调大超时
    }

    # ④ 视频/媒资代理
    location /video/ {
        proxy_pass http://127.0.0.1:8082;                # 媒资服务地址（可换对象存储/CDN 内网地址）
        proxy_set_header Host $host;
    }
}
```

**代理的关键过程（按顺序）**：
1. **域名解析与入口**：`bilibili-like.com` → DNS 解析到 Nginx 公网 IP，连到 `:443`。
2. **TLS 终结**：Nginx 用 `ssl_certificate` 完成握手（解密），客户端看到的是 Nginx 的证书。
3. **HTTP→HTTPS 收口**：用 `http://` 访问 `:80` 时 `return 301` 跳回 HTTPS。
4. **location 匹配分流**：按 URI 选块——`/`（静态）、`/api/`（后端）、`/ws/`（弹幕）、`/video/`（媒资）。
5. **静态资源直出**：前端文件 Nginx 从 `root` 直接读盘返回，`try_files` 保证 SPA 刷新不 404，`expires` 走缓存。
6. **API 反向代理**：`proxy_pass http://api_servers` 转发到后端集群；`upstream` 负载均衡；`keepalive` 复用连接；`proxy_set_header` 透传真实 IP/域名/协议。
7. **路径处理**：`proxy_pass` 末尾无 `/`，`/api/recommend` 到后端仍是 `/api/recommend`（前缀保留）。
8. **WebSocket 升级**：`/ws/` 带 `Upgrade: websocket`，Nginx 用 `Upgrade`/`Connection` 头升级长连并透传，`proxy_read_timeout` 防断。
9. **媒资流转发**：`/video/` 代理到媒资服务，Nginx 流式回传切片。
10. **响应原路返回**：后端/媒资响应经 Nginx 回浏览器，用户感知所有服务都是同一域名 `:443` 提供。

一句话：Nginx 是统一入口，靠 `server_name` 认域名、`location` 按路径分流、`proxy_pass`+`upstream` 把流量送给前端/API/弹幕/媒资，对外只暴露一个 `:443`。 
