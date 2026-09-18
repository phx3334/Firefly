---
title: 基于k8s的CICD流程
published: 2026-09-21T23:11:23+08:00
description: 学习如何基于k8s部署，使用gitlab,jenkins，harbor进行自动化的cicd
image: './images/a28.avif'
tags: [k8s]
category: '计算机技术'
draft: false
lang: '中文'
---


## 流程概览
- 用户从gitlab仓库拉取代码进行开发
- 开发完成后提交并推送给gitlab仓库进行合并。
- 合并后触发jenkins的webhook进行构建成一个镜像（按照你自己写的dockerfile文件），构建完成后推送到harbor仓库
- 最后推送这个镜像给k8s，k8s自动部署好这个镜像