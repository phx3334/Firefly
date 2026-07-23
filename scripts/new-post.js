/* 新建一篇文章 markdown。
 *
 * published 通过 scripts/time-utils.ts 生成：
 * - 统一使用站点时区（默认 Asia/Shanghai / 北京时间）
 * - 冻结在创建那一刻
 * - 写成带时区偏移的 ISO 字符串（如 2026-07-24T02:21:00+08:00），
 *   这样 z.date() 解析出来是正确的绝对时刻，显示不会错一天。
 *
 * 用法: pnpm new-post -- <文件名>
 */
import fs from "fs";
import path from "path";
import { nowIsoString } from "./time-utils.ts";

const args = process.argv.slice(2);

if (args.length === 0) {
	console.error(`Error: No filename argument provided
Usage: pnpm new-post -- <filename>`);
	process.exit(1);
}

let fileName = args[0];

const fileExtensionRegex = /\.(md|mdx)$/i;
if (!fileExtensionRegex.test(fileName)) {
	fileName += ".md";
}

const targetDir = "./src/content/posts/";
const fullPath = path.join(targetDir, fileName);

if (fs.existsSync(fullPath)) {
	console.error(`Error: File ${fullPath} already exists `);
	process.exit(1);
}

const dirPath = path.dirname(fullPath);
if (!fs.existsSync(dirPath)) {
	fs.mkdirSync(dirPath, { recursive: true });
}

const content = `---
title: ${args[0]}
published: ${nowIsoString()}
description: ''
image: ''
tags: []
category: ''
draft: false
lang: ''
---
`;

fs.writeFileSync(path.join(targetDir, fileName), content);

console.log(`Post ${fullPath} created`);
