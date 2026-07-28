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
#实时跟踪新内容（日志监控）
tail -f /var/log/nginx/access.log
#分页查看
less a.txt
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
#不会新建子 Shell，直接在当前 Shell 里执行。因此，脚本里所有操作都会立刻影响你当前的 Shell 环境。
source a.sh
#新建一个子 Shell 来执行脚本。脚本里定义的环境变量、切换的目录，在脚本执行完后不会影响你当前的 Shell。
./a.sh
#修改默认创建文件的权限为666
umask 666
#特殊文件权限
#SUID	4	以文件所有者身份执行	无意义
#SGID	2	以文件所属组身份执行	新建文件继承父目录的组
#Sticky	1	无意义	               只有文件所有者和 root 能删除文件

#过滤字符,-i不区分大小写，-v反向选择,-r递归搜索过滤，-E匹配正则
grep
#以:为分隔符，打印a.txt第8行第一列,NF为当前行的列数量。，$0所有列，规则还有例如/error/匹配包含 "error" 的行，$1 ~ /^192/	第 1 列以 "192" 开头，$1 !~ /root/	第 1 列不包含 "root"。默认分隔符是空格。
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
# 默认升序
sort file.txt
# 降序
sort -r file.txt
# ⚠️ 只能去重相邻的重复行，一般先 sort
# 去重
sort file.txt | uniq
# 去重 + 统计次数
sort file.txt | uniq -c
#执行目录下具有执行权限的脚本
run-parts /etc/cron.hourly
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
# 每秒刷新，共5次，查看系统整体性能：CPU、内存、I/O、进程。
vmstat 1 5         
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
### 1.6 shell脚本相关的命令操作
```bash
# 查看当前用户的环境变量
env
#查看当前用户的所有变量
set
#"$PATH"是弱引用,会直接判定为PATH这个变量的值,'$PATH'是强引用，直接判定为$PATH。`cat a.txt`可以直接解析出命令所展示的内容。

#仅仅让a变为全局变量，就是该终端的所有子shell进程也可以使用该变量。
export a
```
### 1.7文件下载
```bash
# 查看网页
curl https://example.com
# 下载文件（保持原名）
curl -O https://example.com/file.tar.gz
# 下载并改名
curl -o myfile.tar.gz https://example.com/file.tar.gz
# 下载文件
wget https://example.com/file.tar.gz
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
### 2.3系统及个人用户配置文件
```bash
#登录 Shell (系统级)为所有用户设置环境变量、公共程序路径（PATH）。通常还会调用 profile.d 里的脚本。
/etc/profile
#登录 Shell (用户级)为你自己设置环境变量、个人程序路径。一般不写别名。
~/.profile
#所有用户	交互式 Shell 的全局配置文件	非登录交互式 Shell 直接执行；登录交互式 Shell 被 /etc/profile 间接调用
/etc/bashrc
#仅当前用户	交互式 Shell 的配置文件	非登录交互式 Shell 直接执行；登录交互式 Shell 被 ~/.profile 间接调用
~/.bashrc
#进程打开的文件描述符
/proc/PID/fd/
```
### 2.4apt源相关配置文件
```bash
# 告诉 APT 去哪找软件
/etc/apt/sources.list
# 附加源配置目录，用来存放第三方软件源，和主配置文件 sources.list 一起生效。
/etc/apt/sources.list.d/
# 包名、版本、依赖、下载路径、校验和（apt update就是从sources.list和sources.list.d里面更新各种元数据到lists里面）
/var/lib/apt/lists/
#下载的 .deb 安装包(可以通过apt clean删除)
/var/cache/apt/archives/	

sources.list           → 配置仓库地址
       ↓ apt update
/var/lib/apt/lists/    → 下载索引（知道有什么包、依赖、下载路径）
       ↓ apt install
/var/cache/apt/archives/ → 下载 .deb 包 → 安装

#apt install 过程
#① 读 /var/lib/apt/lists/ 中的索引
#② 找到目标包，解析 Depends 字段，递归构建依赖树
#③ 对比 /var/lib/dpkg/status（已安装列表）
#④ 展示要安装/升级的包，等待确认
#⑤ 检查 /var/cache/apt/archives/ 是否已有 .deb
#    有且校验通过 → 跳过下载
#    没有或损坏 → 从仓库下载
#⑥ 下载 .deb 到 /var/cache/apt/archives/
#⑦ 调用 dpkg 解包 → 执行脚本 → 更新数据库
```
### 2.5网络相关配置文件
```bash
#临时全局路由转发（所有网卡）
echo 1 > /proc/sys/net/ipv4/ip_forward
#只开启 eth1 的转发
echo 1 > /proc/sys/net/ipv4/conf/eth1/forwarding
```