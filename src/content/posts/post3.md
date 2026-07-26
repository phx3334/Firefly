---
title: ssh，scp基本原理及其常用命令和配置文件
published: 2026-07-26T20:24:21+08:00
description: '了解远程管理服务器的基本操作'
image: './images/a3.avif'
tags: [linux,计算机网络]
category: '计算机技术'
draft: false
lang: '中文'
---

## 1. 基本原理

### 1.1 ssh基本原理
ssh是加密的远程登录协议，所有数据加密传输。我们一般采用密钥方式进行ssh连接，这样更加安全且方便。
下面是ssh连接过程
#### 连接建立阶段（非对称加密）
客户端发起 TCP 连接到服务端 22 端口

双方协商加密算法，确定用哪种方式加密

服务端发送自己的主机公钥给客户端

客户端对比 ~/.ssh/known_hosts 中保存的指纹，确认服务端身份可信

双方通过 DH 密钥交换算法，各自计算出相同的会话密钥

此密钥只用于本次连接，用完即废

#### 身份认证阶段（非对称加密）
客户端声明用密钥方式登录

服务端在 ~/.ssh/authorized_keys 中查找对应的公钥

服务端生成随机数，用该公钥加密后发给客户端

客户端用自己的私钥解密随机数，签名后发回

服务端用公钥验证签名，一致则认证通过

#### 远程操作阶段（对称加密）
后续所有数据都用会话密钥对称加密传输

敲的命令、返回的结果、传输的文件，都走这条加密通道

对称加密速度快，CPU 开销小，连接保持高效


## 2. 常用命令

### 2.1 ssh常用命令
```bash
#指定服务器监听端口21333（默认22），远程连接192.168.1.100服务器上的user用户，并依次执行后面那三个命令
ssh -p 21333 user@192.168.1.100 "hostname;pwd;whoami"
#~/.ssh/id_rsa.pub为默认公钥路径，该命令将公钥自动追加到user用户的~/.ssh/authorized_keys文件中，以后 ssh 登录不需要密码
ssh-copy-id -i ~/.ssh/id_rsa.pub user@192.168.1.100
```
### 2.2 scp常用命令
```bash
# 上传单个文件
scp local.txt user@192.168.1.100:/tmp/
# 上传并改名
scp local.txt user@192.168.1.100:/tmp/newname.txt
# 上传整个目录
scp -r dir/ user@192.168.1.100:/tmp/
#-p参数保留文件元数据
scp -rp dir/ user@192.168.1.100:/tmp/
#将远程服务器的文件下载本地服务器的aa.txt里面
scp root@192.168.1.100:/etc/hosts ./aa.txt
#将hosta服务器的文件上传到hostb服务器的/path/目录下(不经过本地中转，逻辑上由ssh隧道支持)
scp root@host1:/path/file root@host2:/path/
```
### 2.3 配置文件
```bash
#记录你连接过的所有服务器主机名和公钥指纹。
~/.ssh/known_hosts
#该文件夹下有你的私钥文件（默认位置）
~/.ssh
```
