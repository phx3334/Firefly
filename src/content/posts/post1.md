---
title: linux基础命令和常见配置文件
published: 2026-07-24T20:11:23+08:00
description: '快速掌握常见的linux命令以及常用文件位置'
image: './images/a1.avif'
tags: [linux]
category: '计算机技术'
draft: false
lang: '中文'
---

## 1. 常用命令

### 1.1 查看文件
```bash
# 查看当前目录未隐藏的文件
ls
# 查看当前目录所有文件
ls -a
# 显示文件的详细信息，包括权限、所有者、大小、修改时间等
ls -l
#查看文件内容
cat a.txt
#过滤字符,-i不区分大小写，-v反向选择,-r递归搜索过滤，-E匹配正则
grep
#以:为分隔符，打印a.txt第8行第一列,NF为当前行的列数量。，$0所有列，规则还有例如/error/匹配包含 "error" 的行，$1 ~ /^192/	第 1 列以 "192" 开头，$1 !~ /root/	第 1 列不包含 "root"
awk -F: 'NR==8{print $1}' a.txt
# 将每行的第一个 old 替换为 new
sed 's/old/new/' file.txt
# 将每行所有 old 替换为 new
sed 's/old/new/g' file.txt
# 删除包含 error 的行
sed '/error/d' file.txt
# 只打印第 5 行
sed -n '5p' file.txt
# 直接修改文件（备份原文件）
sed -i.bak 's/old/new/g' file.txt
```
### 1.2 文件操作
```bash
# 创建文件
touch a.txt
# 创建目录
mkdir -p a/b/c
# 删除文件
rm a.txt
# 删除目录
rm -r a
# 复制文件
cp a.txt b.txt
#复制目录
cp -r a b
# 移动文件
mv a.txt b.txt
# 重命名文件
mv a.txt a1.txt
#编辑文件,dd删除整行，yy复制整行，p粘贴,u撤销，ctrl+r重做,:e!恢复文件
vim a.txt
# 修改文件权限
chmod (权限) (-R 递归处理) (文件)
# 解压.tar.gz文件到当前目录,-xJvf解压.tar.xz
tar -xzvf web.tar.gz
# 将 blog 目录打包成单个 .tar 文件（无压缩）
tar -cvf blog.tar blog/
# 创建 .tar.gz 压缩包（打包 + gzip 压缩）
tar -czvf blog.tar.gz blog/
# 创建 .tar.xz 压缩包（打包 + xz 压缩，体积更小）
tar -cJvf blog.tar.xz blog/
# 将 large.iso 分割成 100MB 的片，使用 3 位数字后缀,生成 large-part-000, large-part-001, large-part-002 ...
split -b 100M -d -a 3 large.iso large-part-
# 合并分割后的文件
cat large-part-* > large.iso
# 计算文件md5值,若2次相等说明文件正常合并。
md5sum before.iso
md5sum after.iso
# 创建软链接
ln -s a.txt a1.txt
# 创建硬链接
ln a.txt a2.txt
```
### 1.3 用户和组管理
```bash
# 显示当前用户的id和组信息
id
# 显示指定用户的 ID 信息
id user
# 切换用户
su -user
# 查看当前用户名
whoami
#创建用户及其家目录
adduser -m /home/user user
# 删除用户及其家目录
userdel -r user
# 修改用户密码
passwd user
# 修改用户主组
usermod -g group user
# 修改用户家目录
usermod -d /home/user user
#创建组
groupadd group
# 删除组
groupdel group
# 修改组名
groupmod -n group1 group
# 添加用户到属组
usermod -aG group user
# 从属组中删除用户
gpasswd -d 用户名 组名
# 退出用户
exit
```
### 1.4 网络管理
```bash
# 查看所有网络接口信息（包括未激活的）
ifconfig -a
# 查看特定接口（如 ens33）
ifconfig ens33
# 查看路由表（推荐使用 -n 显示数字地址）
route -n
#-net指定目标为网络地址 gw指定网关IP2.2.2.2  dev指定出口网卡
route add -net 3.3.3.0/24 gw 2.2.2.2 dev ens33
#一般直接指定default0.0.0.0代表所有网络地址
route add default gw 2.2.2.2 dev ens33
# 删除路由
route del -net 3.3.3.0/24 dev ens33
# 禁用网卡（ens33和启用网卡（ens33）,重新加载配置文件
ifdown ens33
ifup ens33
# 查看所有网络设备的状态
nmcli device status
# 查看所有网络连接（包括未激活的）
nmcli connection show
# 查看当前活动的连接
nmcli connection show --active
# 查看连接
nmcli con show
#查看ens33具体连接的配置信息
nmcli con show ens33
# 修改为 DHCP
nmcli con mod ens33 ipv4.method auto
# 修改为static
nmcli con mod ens33 ipv4.method manual
# 修改ip
nmcli con mod ens33 ipv4.addresses 192.168.1.100/24
# 修改网关
nmcli con mod ens33 ipv4.gateway 192.168.1.1
# 修改 DNS
nmcli con mod ens33 ipv4.dns "8.8.8.8 114.114.114.114"
# 查看所有网卡ip地址
ip addr
# 查看网卡 ens33 的 IP 地址、MAC 等配置信息
ip addr show ens33
# 给网卡 ens33 临时添加一个 IPv4 地址（/24 表示子网掩码 255.255.255.0）
ip addr add 192.168.1.100/24 dev ens33
# 删除网卡 ens33 上指定的 IP 地址（参数与 add 完全一致）
ip addr del 192.168.1.100/24 dev ens33
# 查看当前系统的路由表（含默认网关、目标网段、出口设备）
ip route
# 添加一条静态路由：访问 3.3.3.0/24 网段时，经由网关 2.2.2.2 从 ens33 发出
ip route add 3.3.3.0/24 via 2.2.2.2 dev ens33
# 删除上面添加的静态路由（参数与 add 完全一致）
ip route del 3.3.3.0/24 via 2.2.2.2 dev ens33
# 查看所有网络接口的统计信息（-s 显示收发数据包、错误、丢包等统计）
ip -s link
#具有ping功能的同时可以返回1.1.1.1的网卡的mac地址
arping 1.1.1.1
```
### 1.5 系统管理
```bash
#实时综合监控（CPU、内存、进程. 点击d设置刷新间隔，点击1展示每个cpu信息，q退出
top
#显示查看磁盘分区空间使用情况，-i显示inode使用情况，-h人类易读模式
df
#查看内存和交换分区使用情况（人类可读）
free -h
#查看块设备分区结构
lsblk
# 磁盘初始化为物理卷
pvcreate /dev/sdb     
# 创建卷组 vg_data                     
vgcreate vg_data /dev/sdb  
# 建数据逻辑卷（按需改大小）                
lvcreate -L 10G -n lv_data vg_data       
# 建交换逻辑卷 
lvcreate -L 2G  -n lv_swap vg_data  
# 数据卷格式化为 ext4     
mkfs.ext4 /dev/vg_data/lv_data    
# 交换卷格式化为 swap        
mkswap /dev/vg_data/lv_swap    
# 挂载数据卷          
mount /dev/vg_data/lv_data /mnt/data       
# 启用交换卷
swapon /dev/vg_data/lv_swap         
#增加指定大小（如增加 50G）
lvextend -L +50G /dev/vg_data/lv_data
# ext4 文件系统
resize2fs /dev/vg_data/lv_data
#创建分区（以 /dev/sdb 为例）
fdisk /dev/sdb
# 格式化为 ext4
mkfs.ext4 /dev/sdb1
# 挂载
mount /dev/sdb1 /mnt/data
```
## 2. 常见配置文件

### 2.1 用户和组管理配置文件
```bash
# 用户配置文件
/etc/passwd
# 组配置文件
/etc/group
# 用户密码配置文件
/etc/shadow
# 组密码配置文件
/etc/gshadow
# 用户和组的命令权限配置文件
/etc/sudoers
```
### 2.2 挂载配置文件
```bash
#挂载配置文件，永久挂载。
/etc/fstab
```