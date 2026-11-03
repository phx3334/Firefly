---
title: 云原生综合项目实践
published: 2026-11-11T20:11:23+08:00
description: 将大部分常用的云原生技术栈集为一体进行项目实践并记录实践中的一些细节
image: './images/a52.avif'
tags: [项目实践]
category: '计算机技术'
draft: false
lang: '中文'
---



## 草稿
vscode编译器会把helm下面的/templates目录下的文件识别为纯yaml文件，于是会报错。所以我们需要声明.vscode/settings.json文件，内容如下：
```json
{
  "files.associations": {
    "**/templates/*.yaml": "plaintext",
    "**/templates/*.tpl": "plaintext"
  }
}
```
将上述这些文件声明为纯文本，避免编译器报错。
 
