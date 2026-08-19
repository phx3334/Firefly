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

- 在linux系统中，线程其实是通过clone()加共享标识创造的“轻量线程”，线程与进程界限模糊。  
- 在windos系统中线程是最小的资源调度单位，进程是资源容器。


## systemd介绍
### 定义
systemd 是 Linux 的系统和服务管理器，是现代主流发行版的默认 init 系统。系统启动后运行在用户态的第一个进程（PID 1），是所有用户进程的祖先。  
init是“岗位”，systemd是“员工”。内核会根据/sbin/init、/etc/init等优先级查找第一个进程，/sbin/init软链接 /lib/systemd/systemd
### 创建过程
systemd 不是被 fork 出来的，而是内核"先复制、后换映像"变出来的，恰好用到了前置知识里的两个机制：  
- 复制：内核从 idle（编译期静态定义 init_task，非创建）（PID 0）复制出内核线程 kernel_init（PID 1）
- 换映像：kernel_init 执行 execve("/sbin/init")，程序映像替换成 systemd，PID 不变（仍为 1）
### uint介绍
