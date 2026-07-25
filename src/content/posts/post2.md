---
title: 正则表达式和常见元字符
published: 2026-07-25T16:54:44+08:00
description: '这里介绍了常用的正则表达式和元字符使用规则'
image: './images/a2.avif'
tags: [linux]
category: '计算机技术'
draft: false
lang: '中文'
---

元字符的意义由解释它的解释器来决定。这里只讲bash shell解释器中一些常见元字符的意义。
## 1. 元字符

### 1.1 通配符
```bash
# *    匹配任意多个字符
ls *.txt
# ?    匹配单个字符
ls file?.txt
# []   匹配括号内任一字符
ls file[123].txt
# [a-z]  匹配范围任一内字符
ls file[a-z].txt
# [^abc] 匹配不在括号内的任一字符
ls file[^123].txt
# 生成 file1.txt ~ file5.txt 五个空文件
touch file{1..5}.txt
```
### 1.2引号与转义符
```bash
# 输出字面量 $HOME，不会解析为家目录路径
echo '$HOME'
# 输出当前实际的工作目录路径
echo "当前工作目录: $PWD"
# 输出带 * 的文件名，* 不会被当作通配符解析
echo "文件名为: file\*name"
```
### 1.3 输入输出重定向符
```bash
# 将 hello 写入 test.txt，原有内容被覆盖
echo "hello" > test.txt
# 将 world 追加到 test.txt 最后一行
echo "world" >> test.txt
# 统计 test.txt 的行数
wc -l < test.txt
# 访问不存在的文件，错误信息写入 error.log
ls no_such_file 2> error.log
# 命令的所有输出和错误都写入 output.log
ls a.txt &> output.log
```
### 1.4算术运算表达式
```bash
#(( )) 是 bash 专属整数算术运算专用语法，仅支持整数，不支持小数
# 1. 赋值运算
a=10
((a = a + 5))
echo $a
# 简写自增、自减
((a++))
((a--))
echo $a
# 复合赋值
((a += 10))
((a *= 2))
echo $a
# 四则、取余
b=((10 + 20) * 2 % 5)
echo $b

#[]为test命令简写，错误返回0，正确返回非0
[ -f a.txt ]  # 是否普通文件
[ -d /tmp ]   # 是否目录
[ "$a" = "$b" ]  # 字符串是否相等
[ "$a" != "123" ]  # 字符串是否不等
[ -n "$var" ]  # 字符串是否非空
num=10
[ "$num" -eq 10 ]  # 等于
[ "$num" -gt 5 ]   # 大于
[ "$num" -lt 20 ]  # 小于

# bc使用方法
# 保留2位小数做除法
echo "scale=2; 10 / 3" | bc
# 混合四则运算
echo "scale=3; (5.2 + 3.8) * 2 / 4" | bc
```
### 1.5位置 / 状态特殊符号
```bash
#$?上一条执行命令的退出返回码
ls /etc
echo $?  # 文件存在，输出0
ls /nonexistfile
echo $?  # 文件不存在，输出非0错误码

#解释：第 1、第 2、第 3... 第 10 个传入脚本的参数
#!/bin/bash
echo "第一个参数：$1"
echo "第二个参数：$2"
echo "第十个参数：${10}"

#传入脚本的参数个数
#!/bin/bash
echo "总共传入 $# 个参数"

#解释：当前运行的脚本文件名
echo "脚本名称：$0"

#解释：全部传入参数，每个参数独立分开，支持带空格参数
# 遍历所有参数
for param in "$@";do
  echo $param
done

#解释：当前脚本 / 终端 Shell 的进程 PID，常用于临时文件
echo $$
touch log_$$.txt

#解释：$!是最近一个后台运行（&）程序的 PID
sleep 20 &
echo $!
```


## 2. 正则表达式

### 2.1[[]] bash 变量正则匹配
```bash
# ^ 匹配字符串开头；$ 匹配字符串结尾；[0-9] 匹配任意数字；+ 前面字符出现1次及以上.^和$框住表示从头到尾
num="666888"
if [[ $num =~ ^[0-9]+$ ]];then
  echo "全数字"
fi
# [0-9] 任意数字（前面已解释，不再重复）
str="abc789"
if [[ $str =~ [0-9] ]];then
  echo "字符串包含数字"
fi
# {10} 前面字符精确匹配10次
phone="13512345678"
if [[ $phone =~ ^1[0-9]{10}$ ]];then
  echo "手机号格式正确"
fi
# [a-zA-Z] 匹配大小写字母；_ 匹配下划线；* 前面字符出现0次/多次
username="admin_001"
if [[ $username =~ ^[a-zA-Z][a-zA-Z0-9_]*$ ]];then
  echo "用户名合规"
fi
# \. 转义匹配小数点（. 单独使用代表任意字符）
decimal="99.99"
if [[ $decimal =~ ^[0-9]+\.[0-9]+$ ]];then
  echo "标准小数"
fi
```
### 2.2grep 文件检索正则
```bash
# ^ 匹配行首
grep "^root" /etc/passwd
# $ 匹配行尾
grep "/bin/bash$" /etc/passwd
# ^$ 匹配空行；-v 参数代表反向匹配（排除匹配内容）
grep -v "^$" test.txt
# | 正则或，匹配左右任意一个内容；-E 启用扩展正则（支持 | + ? 无需转义）
grep -E "root|ftp" /etc/passwd
# {2,} 前面字符最少匹配2次
grep -E "[0-9]{2,}" log.txt
# \. 转义小数点；{1,3} 字符匹配1~3次
grep -E "[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}" access.log
# [^0-9] ^在[]内代表取反，匹配非数字字符
grep "[^0-9]" demo.txt
```