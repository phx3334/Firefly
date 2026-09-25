---
title: Ansible和Terraform
published: 2026-09-24T23:11:23+08:00
description: 学习Ansible和Terraform的基本概念和使用方法
image: './images/a31.avif'
tags: [IaC]
category: '计算机技术'
draft: false
lang: '中文'
---

## IaC
**IaC（Infrastructure as Code，基础设施即代码）**：把服务器、网络、云资源等基础设施的定义写成代码文件来管理，而不是靠人在控制台上点鼠标或登机器敲命令。改配置 = 改代码，机器的状态由代码驱动到期望样子。
传统手工运维的痛点：环境搭一遍还行，搭五遍就开始不一致；出问题没人说得清"这台机器当初是怎么配的"；改动没有记录，误操作无法回退。IaC 针对性地解决这些：
- **代码化**：基础设施定义进 Git，有版本、有评审、可回滚；
- **声明式**：只描述"要什么"（期望状态），不写"怎么做"（操作步骤），由工具算出怎么达成；
- **幂等性**：同一份代码执行一遍和十遍结果一致，已满足的资源自动跳过；
- **可复制**：同一份代码 + 不同变量，就能渲染出测试、生产等各套一致的环境。
按管的对象分两类工具：
| 类型         | 管什么                                   | 代表      | 类比   |
| ------------ | ---------------------------------------- | --------- | ------ |
| 基础设施供给 | 云资产的"生死"：创建、变更、销毁         | Terraform | 造机器 |
| 配置管理     | 机器内部的"状态"：装软件、改配置、起服务 | Ansible   | 配机器 |
Terraform 用 HCL 描述云资源，Ansible 用 YAML 描述机器状态，两者互补，常串联在一条 CI/CD 流水线里——本文就按这个组合各学一遍。


## Ansible
### 是什么
Ansible 是 RedHat 出品的自动化工具，用 YAML 描述"目标机器应该长什么样"，核心特点：
- **无 Agent**：不需要在被控机器装客户端，主控机通过 SSH（Windows 走 WinRM）直接连过去执行；
- **Push 模式**：由控制端主动推送任务，不像 Agent（代理程序，运行在被监控机器上的后台程序） 模式那样等被控端拉取；
- **幂等性（Idempotency）**：同一脚本执行一遍和执行十遍结果相同，已满足要求的步骤自动跳过，这是它和"批量跑 shell 脚本"最大的区别；
- 原理上，Ansible 会把模块代码临时拷到目标机上执行（要求目标机有 Python），执行完即删。

### 应用场景
| 场景           | 典型用法                                                                  |
| -------------- | ------------------------------------------------------------------------- |
| 批量操作与巡检 | 临时对几百台机器查磁盘、查端口、看进程（ad-hoc 命令）                     |
| 配置管理       | 统一下发配置、装包、改内核参数，并可持续纠偏                              |
| 应用部署       | 虚拟机/裸机上的应用按批次滚动发布（K8s 上的应用已由 CI/CD + GitOps 接管） |
| 多机编排       | 编排 K8s 管不到的资产：数据库主备切换顺序、中间件扩容、跨机房操作         |
| 系统初始化     | 新机初始化（创建用户、SSH 加固、装监控 Agent）                            |
与 Terraform 的常见分工是：**Terraform 负责"造机器"（创建云主机、网络、负载均衡），Ansible 负责"配机器"（装软件、下发应用）**，两者经常串联在一条 CI/CD 流水线里。

### 安装后的核心目录
```
# 安装Ansible后的默认路径（除此还有/usr/bin里面的环境变量作为Ansible命令）
/etc/ansible/
├── ansible.cfg          # 全局主配置文件
└── hosts                # 全局默认 inventory（主机清单）

# 自己根据创建的路径
my-ansible/
├── ansible.cfg            # 项目级配置（优先级高于 /etc/ansible/ansible.cfg）
├── inventory/
│   ├── hosts.ini          # 主机清单（分环境可拆 prod.ini / test.ini）
│   ├── group_vars/        # 组变量
│   │   └── web.yml
│   └── host_vars/ 
        ├── web01.yml        # 单机变量
        ├── web02.yml        
├── roles/
│   ├── common/            # 角色一：系统初始化
│   │   ├── tasks/main.yml
│   │   ├── handlers/main.yml
│   │   └── templates/
│   └── nginx/             # 角色二：nginx 部署
│       ├── tasks/main.yml
│       ├── templates/nginx.conf.j2
│       └── defaults/main.yml
├── deploy.yml             # CICD
└── site.yml               # 总入口（串联多个 play）
```

### 核心概念与执行流程
```
   site.yml
   │
   ├─ 1. 读取 inventory（主机清单：哪些机器、属于哪个组、什么变量）
   ├─ 2. 按 play 找到目标主机，SSH 连通
   ├─ 3. gather_facts：收集目标机信息（系统版本、CPU、内存、IP……）
   ├─ 4. 逐个 task 执行模块，模块判断状态：
   │       已符合期望 → ok（跳过）
   │       不符合     → changed（修改）
   │       出错       → failed（默认立即停止该主机后续任务）
   └─ 5. 所有 task 跑完后，统一触发被 notify 的 handlers
```
几个基础概念：
- **Inventory**：主机清单，默认是 `/etc/ansible/hosts`，项目里一般自己维护 `inventory.ini`：
```ini
[web]
web01 ansible_host=10.0.0.11
web02 ansible_host=10.0.0.12

[db]
db01 ansible_host=10.0.1.11

[web:vars]
http_port=8080   #实际生产过程中这些应该写到group_vars/web.yml,yaml格式文件还支持嵌套
```
- **Module（模块）**：一个模块干一件事（装包、拷文件、启服务）；
- **Task（任务）**：调用一次模块；**Play**：对一组主机执行的一组 task；**Playbook**：一个或多个 play 组成的 YAML 文件；
- **Facts**：自动采集的目标机信息，如 `ansible_os_family`、`ansible_default_ipv4.address`。

不想写 playbook、只想临时执行一条命令时用 **ad-hoc**：
```bash
ansible all -m ping                         # 测试所有机器连通性
ansible web -m shell -a "free -h"           # 在 web 组执行 shell 命令
ansible web -m copy -a "src=a.conf dest=/etc/a.conf"     #-m指定要调用的模块,-a传给该模块的参数
```

### 常见模块
| 分类   | 模块                                | 作用                                                                                                                          |
| ------ | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 命令   | `command` / `shell` / `raw`         | 执行命令；command 不经过 shell（无管道、重定向），shell 经过 `/bin/sh`，raw 不依赖 Python（用于网络设备、未装 Python 的新机） |
| 包管理 | `yum`（dnf）/ `apt`                 | 安装、升级、删除软件包                                                                                                        |
| 服务   | `service` / `systemd`               | 启停、开机自启管理                                                                                                            |
| 文件   | `template`                          | 推送经 **Jinja2 渲染**后的配置文件                                                                                            |
| 系统   | `user` / `group` / `cron` / `mount` | 用户组、定时任务、挂载管理                                                                                                    |

注意：**`command`、`shell`、`raw` 不保证幂等**（重复执行同样的命令可能重复产生效果），能用专用模块就别用 shell，例如装包用 `yum` 而不是 `shell`。
### Ansible实践过程
- **控制机**（你自己登录的工作机）：用你的个人账号（如 `victor`）执行 ansible 命令；
- **被控机**：Ansible 通过 SSH 以**普通用户 `ops`** 登录，修改内核参数需要 root 权限时通过 `become` 提权 sudo 完成。
**第 1 步：控制机生成 SSH 密钥，并准备 ops 账号**

```bash
# 控制机上执行，已有密钥可跳过
ssh-keygen -t ed25519
```
首次还没有免密时，先用密码把 `ops` 账号和公钥铺到每台机器

```bash
# 逐台手工执行（仅首次；纳管后由 Ansible 接管）
ssh root@10.0.0.11 "useradd -m -s /bin/bash ops && \
  echo 'ops ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/ops && \
  mkdir -p /home/ops/.ssh && chmod 700 /home/ops/.ssh"
ssh-copy-id -i ~/.ssh/id_ed25519.pub ops@10.0.0.11
```
`sudoers.d/ops` 这行让 ops 用户 sudo 免密提权——Ansible 的 `become` 底层就是 sudo，免密才能自动化。

**第 2 步：项目文件**
```ini
# inventory/hosts.ini
[app]
app01 ansible_host=10.0.0.11
app02 ansible_host=10.0.0.12
app03 ansible_host=10.0.0.13
```

```yaml
# group_vars/app.yml 
# SSH 连接配置，这些变量名都是关键字，剧本任务会隐式引用他们
ansible_user: ops              # SSH 登录被控机用的用户
ansible_port: 22
ansible_become: true           # 执行任务时提权
ansible_become_method: sudo
ansible_become_user: root      # 提权成 root（改内核参数必须）

# 内核参数
sysctl_params:
  fs.file-max: 1048576                  # 系统级最大文件句柄
  net.ipv4.tcp_tw_reuse: 1

nofile_limit: 655350                    # 单进程文件描述符（ulimit -n）
```

```yaml
# kernel-tune.yml —— 主剧本
---
- name: 初始化并调优内核参数
  hosts: app
  gather_facts: true        # 开头先采集目标机信息（facts 变量）；纯固定参数的剧本可写 false 省去采集耗时

  tasks:
    # ① 确认 ops 用户存在（幂等，已存在则 ok 跳过）
    - name: 确保运维账号存在
      user:
        name: ops
        shell: /bin/bash
        state: present

    # ② 下发 sudo 免密规则
    - name: 配置 sudo 免密
      copy:
        content: "ops ALL=(ALL) NOPASSWD: ALL"       #要写的内容
        dest: /etc/sudoers.d/ops                  #写入路径
        mode: "0440"                   #规定要加前缀0，文件权限440
        validate: "visudo -cf %s"      # 写入前校验语法，防止写坏 sudoers

    # ③ 内核参数：sysctl 模块改完立即生效且写入 /etc/sysctl.d/ 持久化
    - name: 调优内核参数
      ansible.posix.sysctl:
        name: "{{ item.key }}"
        value: "{{ item.value }}"
        sysctl_set: true
        reload: true
        sysctl_file: /etc/sysctl.d/99-app-tuning.conf
      loop: "{{ sysctl_params | dict2items }}"       #dict2items将 fs.file-max: 1048576，net.ipv4.tcp_tw_reuse: 1转化成列表，对应上文item.key,loop循环执行这个任务，根据列表的键值对

    # ④ 文件描述符上限：pam_limits 模块写 /etc/security/limits.d/
    - name: 提升 ops 用户文件描述符上限
      community.general.pam_limits:
        domain: ops
        limit_item: nofile
        limit_type: "{{ item }}"       # soft 和 hard 各设一条
        value: "{{ nofile_limit }}"
      loop: [soft, hard]

    # ⑤ systemd 服务若以 ops 运行，还需在 unit 里设 LimitNOFILE（limits.d 对 systemd 服务不生效）
    - name: systemd 服务级 nofile 示例
      copy:
        content: |
          [Service]
          LimitNOFILE={{ nofile_limit }}
        dest: /etc/systemd/system/myapp.service.d/limits.conf
      notify: daemon reload     #当task的执行结果是changed,根据name通知handler

  handlers:
    - name: daemon reload       
      systemd:
        daemon_reload: true      #内核重新加载配置
```

**第 3 步：执行与验证**
```bash
# 控制机项目目录内执行（inventory 已在 ansible.cfg 指定则不用 -i）
ansible all -m ping                     # 验证 SSH 连通 + 提权可用，全部 pong 才继续
ansible-playbook kernel-tune.yml        # 真正执行

# 上目标机人工抽查
ssh ops@10.0.0.11
sysctl fs.file-max                                         # 应输出 1048576
su - ops -c "ulimit -n"                                    # 应输出 655350
cat /etc/sysctl.d/99-app-tuning.conf                       # 确认已持久化
```
**注意点**：
`ulimit`（limits.d）只对**通过 PAM 登录的会话**生效，systemd 拉起的服务要单独写 `LimitNOFILE`（上面第⑤步），这是最容易踩的坑；

### 入口剧本和环境剧本
playbook 一多就要考虑组织方式，常见的两个维度是"按流程编排"和"按环境区分"。
**入口剧本**：自己不写 task，只负责把各个功能剧本按顺序串起来，一条命令跑完整套流程：
```yaml
# site.yml —— 新机初始化总入口
---
- import_playbook: kernel-tune.yml    # 1. 先调内核参数
- import_playbook: init-user.yml      # 2. 建账号、SSH 加固
- import_playbook: deploy-nginx.yml   # 3. 最后装应用
```
`ansible-playbook site.yml` 一条命令走完三步；单个功能剧本（如 kernel-tune.yml）也依然可以单独执行，两层互不干扰。
**环境剧本**：同一套操作要在测试/生产上执行时，剧本只有一份，环境差异全部收敛到 `group_vars/`——清单里用组名区分环境，变量文件与组名一一对应，Ansible 自动加载对应组的变量。

### 剧本重用与解耦
前文的 kernel-tune.yml 已经是独立的功能剧本，site.yml 负责编排。但随着功能继续增多——调内核、装 nginx、下发应用……每个剧本里的 task、handler、模板、变量都平铺在同一个 yml 里，文件会越来越长。Role（角色）就是 Ansible 的拆分方案：**按"一个角色管一件事"，把这些东西收进一个标准目录**，剧本里只留一行引用。
一键生成标准骨架：
```bash
ansible-galaxy init roles/nginx       # 目录名是约定，Ansible 自动识别
```
```
roles/nginx/
├── tasks/main.yml        # 角色入口，主要任务搬到这里
├── handlers/main.yml     # 处理器（如 restart nginx）
├── templates/            # .j2 模板
├── files/                # 原样下发的文件
├── vars/main.yml         # 角色内部变量（优先级高）
├── defaults/main.yml     # 默认变量（优先级最低，方便外部覆盖）
└── meta/main.yml         # 角色依赖，如依赖 common 角色
```
```yaml
# site.yml —— 总入口：功能剧本全部改造成 role 后，编排只需列角色名
---
- name: 新机初始化
  hosts: all
  roles:
    - common                # roles/common：系统初始化（含 kernel-tune 的任务）

- name: 部署 nginx
  hosts: web
  roles:
    - role: nginx
      vars:
        http_port: 8080     # 按需覆盖 roles/nginx/defaults/main.yml 里的默认值
```

- `defaults` 里的变量故意设成最低优先级，使用方在 `inventory/group_vars/` 里同名覆盖即可，**角色逻辑不用改就能适配各环境**——这正是上一节"环境差异不进剧本、只进变量"思路在角色层面的延续；
- 前文的 kernel-tune.yml 就可以改造成一个角色：tasks 搬进 `tasks/main.yml`，`nofile_limit` 等可调参数挪到 `defaults/main.yml`，site.yml 用 roles 引用，数据、逻辑、编排三层各归其位；
- 通用角色不必自己写，以 collection 形式分发，如 `ansible-galaxy collection install community.general`；
- 拆分后的典型项目结构：`inventory/`（分环境清单+变量）+ `roles/`（可复用角色）+ `site.yml`（总入口），团队协作时各管各的角色，互不冲突。

### templates/ 和 files/ 
两个目录都是往目标机下发文件的，区别在于**下发改不改内容**：
| 目录         | 模块       | 下发方式                                  |
| ------------ | ---------- | ----------------------------------------- |
| `templates/` | `template` | 推送前先用 Jinja2 渲染 `{{ }}` 变量再写入 |
| `files/`     | `copy`     | 原样搬运，一个字节都不改                  |
判断口诀：**内容里有变量 → templates/，没有变量 → files/**。
- 典型的 templates/ 场景——同一份配置在不同机器上渲染出不同结果：
```jinja2
# templates/nginx.conf.j2
worker_processes {{ ansible_processor_vcpus }};   # facts 变量：按本机 CPU 核数生成
listen {{ http_port }};                           # 角色变量：来自 defaults/main.yml
```
- 典型的 files/ 场景——SSL 证书、私钥、安装包、二进制脚本，这些文件对所有机器都一样，放进模板反而多此一举。
放错的后果：静态文件放 templates/ 不会报错（只是渲染了个寂寞），但含变量的文件放 files/ 会把 `{{ }}` 原样写进目标机配置，服务直接起不来。

### Ansible 在 CMDB 上的应用
**CMDB（配置管理数据库）**是记录企业全部 IT 资产的系统：每台机器的 IP、配置、归属业务、负责人、环境、机房等。Ansible 和 CMDB 结合后，自动化从"我手工列机器清单"升级为"以资产数据驱动"，数据流是双向的：

```
CMDB ──① 动态拉取清单/分组──▶ Ansible 执行变更
CMDB ◀──② 回传 facts 盘点─── Ansible（每台机器的真实硬件/系统信息）
```

**① CMDB 作为动态 Inventory（CMDB → Ansible）**

机器经常增删，静态 inventory 必然过时。可以写一个动态清单脚本（或插件）调用 CMDB 的 API，按业务线、环境、机房自动生成分组。脚本只需支持两个入参：`--list`（输出全部主机与分组）和 `--host <主机名>`（输出单台主机变量，简单场景可返回空 JSON）：

```python
#!/usr/bin/env python3
# cmdb-inventory.py：调用公司 CMDB API，输出 Ansible 要求的 JSON 结构
import json, sys, requests

data = requests.get("http://cmdb.internal/api/hosts").json()
inv = {"web": {"hosts": []}, "db": {"hosts": []}, "_meta": {"hostvars": {}}}

for h in data:
    inv[h["service"]]["hosts"].append(h["ip"])
    inv["_meta"]["hostvars"][h["ip"]] = {"owner": h["owner"], "idc": h["idc"]}

if len(sys.argv) == 2 and sys.argv[1] == "--list":
    print(json.dumps(inv))
elif len(sys.argv) == 3 and sys.argv[1] == "--host":
    print(json.dumps(inv["_meta"]["hostvars"].get(sys.argv[2], {})))
```

输出形如：

```json
{
  "web": { "hosts": ["10.0.0.11", "10.0.0.12"] },
  "db":  { "hosts": ["10.0.1.11"] }
}
```

之后直接以 CMDB 的实时数据为准执行操作，**新机器入库后无需改任何 Ansible 文件**：

```bash
ansible -i cmdb-inventory.py web -m ping
ansible-playbook -i cmdb-inventory.py deploy.yml -l web    # -l 限定只跑某组
```

典型场景：对"支付业务 + 生产环境 + 香港机房"这一组机器统一下发安全基线、批量重启、灰度发布。

**② Ansible 采集事实回填 CMDB（Ansible → CMDB）**
CMDB 里手工填的 CPU、内存、磁盘数据很快就和真实情况不一致。可以让 Ansible 定期跑 `setup` 模块（gather_facts）采集真实信息，再 POST 回 CMDB：

```yaml
- name: 采集资产信息并回写 CMDB
  hosts: all
  gather_facts: true
  tasks:
    - name: 上报 facts
      uri:
        url: http://cmdb.internal/api/hosts/{{ inventory_hostname }}
        method: PUT
        body_format: json
        body:
          cpu_cores: "{{ ansible_processor_vcpus }}"
          mem_mb: "{{ ansible_memtotal_mb }}"
          os: "{{ ansible_distribution }} {{ ansible_distribution_version }}"
          ip: "{{ ansible_default_ipv4.address }}"
```
配合 cron/流水线定期执行，CMDB 就从"人工维护的表格"变成**自动盘点、持续准确**的资产库。此外还能基于这些数据做合规巡检（找出内核版本过低、磁盘使用率超阈值的机器）并生成报告——本质上是"**CMDB 管机器的身份信息，Ansible 管机器的实际状态，两者互相校验**"。

### Ansible在云原生时代的主要应用
先说被"抢走"的部分——前文场景表里那句"K8s 上的应用已由 CI/CD + GitOps 接管"展开来看：
| 传统 Ansible 场景        | 云原生时代的接替者                         |
| ------------------------ | ------------------------------------------ |
| 应用部署、滚动发布       | 镜像交付 + K8s Deployment 原生滚动更新     |
| 多机编排应用版本         | GitOps（ArgoCD/Flux）：改 Git 即改集群状态 |
| 批量改配置、重启服务     | ConfigMap 挂载 + Operator 自动处理         |
| 加机器扩容、跑脚本扩实例 | HPA / Cluster Autoscaler 自动伸缩          |
| 巡检服务进程在不在       | Prometheus 探针 + 告警，秒级发现           |
核心原因：容器时代"机器上跑什么"变成了"集群里声明什么"，应用状态收敛到 K8s 的 API Server 一处，不再需要逐台 SSH 过去对账。
但 Ansible 并没有失业，只是**地盘从"机器上的一切"收缩为"K8s 管不到的那一层"**：
- **K8s 集群自身的搭建与节点维护**：装 containerd/kubelet、调内核参数、CNI 前置依赖——著名的 kubespray 就是一套纯 Ansible 剧本；
- **平台之外的有状态服务**：数据库主从、消息队列等大中间件大多仍跑在虚机/裸机上（或云厂商托管之外自维护），部署、主备切换、扩容仍是 Ansible 的战场；
- **进不了容器的东西**：GPU 驱动、node-exporter 等监控 Agent、本地磁盘与内核调优，天然属于节点层；
- **应急与批量止血**：全网打安全补丁、批量封 IP、紧急重启——GitOps 从改代码到生效要过完整流水线，事故现场等不起，Ansible 一条 ad-hoc 命令几十台机器立刻见效。
一句话总结：**GitOps 管"期望的应用状态"，K8s 管"集群内的一切"，Ansible 管"集群外面的物理世界"**——三者各管一段，更多是分工而非替代。


## Terraform
### 用Terraform管理云资产的优越性
传统方式在云控制台"点点点"创建资源，量少时还行，规模一大问题就暴露：资源怎么来的没人说得清、测试和生产配置对不上、离职同事留下的资源无人敢动。Terraform把云资源写成代码来管，核心优越性：
- **声明式 + 幂等**：只描述"要什么"（一个 VPC、一台 4C8G 主机），不写操作步骤；重复执行结果一致，已符合的资源自动跳过——与 Ansible 的幂等思想同源，只是作用对象从"机器内部"换成了"云平台"；
- **执行计划可预览**：`terraform plan` 先做预演，清楚列出本次变更将**创建（+）、修改（~）、销毁（-）**哪些资源，人工确认后才真正应用（`apply`）。
- **状态文件（state）跟踪真实资产**：state 记录"代码里的资源 ↔ 云上真实资源"的映射，plan 时会与实际比对——有人绕过代码直接在控制台改了安全组规则（漂移，drift），下次 plan 立刻暴露；
- **依赖自动编排**：资源间用引用表达依赖，Terraform 自动排序执行（先建 VPC → 子网 → 主机），几百个资源的创建顺序不用人操心；
- **资产代码化进 Git**：资源定义有版本、有评审、有审计，谁改了什么一查便知；出问题回滚代码再 apply 即可；
- **多云统一工作流**：通过 provider 插件对接阿里云、腾讯云、AWS 等，一套 `init / plan / apply` 流程管所有云，不用各家控制台各学一套。
### 从零拉起云服务实践
首先是开发环境下`dev/`
```hcl
# main.tf
module "cvm" {
  source     = "../modules/cvm"
  secret_id  = var.secret_id
  secret_key = var.secret_key
  password   = var.password
}

module "k3s" {
  source     = "../modules/k3s"
  public_ip  = module.cvm.public_ip
  private_ip = module.cvm.private_ip
}

resource "local_sensitive_file" "kubeconfig" {
  content  = module.k3s.kube_config
  filename = "${path.module}/config.yaml"
}


#variables.tf
variable "secret_id" {
  default = "Your Access ID"
}

variable "secret_key" {
  default = "Your Access Key"
}

variable "region" {
  default = "ap-hongkong"
}

variable "password" {
  default = "password123"
}
```

测试环境`test/`下
```hcl
# main.tf
module "cvm" {
  source     = "../modules/cvm"
  secret_id  = var.secret_id
  secret_key = var.secret_key
  password   = var.password
}

module "k3s" {
  source     = "../modules/k3s"
  public_ip  = module.cvm.public_ip
  private_ip = module.cvm.private_ip
}

resource "local_sensitive_file" "kubeconfig" {
  content  = module.k3s.kube_config
  filename = "${path.module}/config.yaml"
}


#variables.tf
variable "secret_id" {
  default = "Your Access ID"
}

variable "secret_key" {
  default = "Your Access Key"
}

variable "region" {
  default = "ap-hongkong"
}

variable "password" {
  default = "password123"
}
```
公共模块`modules/`下
```hcl
# /cvm/main.tf
# Configure the TencentCloud Provider
provider "tencentcloud" {
  region     = var.region
  secret_id  = var.secret_id
  secret_key = var.secret_key
}

# Get availability zones
data "tencentcloud_availability_zones_by_product" "default" {
  product = "cvm"
}

# Get availability images
data "tencentcloud_images" "default" {
  image_type = ["PUBLIC_IMAGE"]
  os_name    = "ubuntu"
}

# Get availability instance types
data "tencentcloud_instance_types" "default" {
  filter {
    name   = "instance-family"
    values = ["SA5"]
  }

  cpu_core_count = 2
  memory_size    = 4
  exclude_sold_out = true
}

# Create security group
resource "tencentcloud_security_group" "default" {
  name        = "tf-security-group"
  description = "make it accessible for both production and stage ports"
}

# Create security group rule allow ssh request
resource "tencentcloud_security_group_lite_rule" "default" {
  security_group_id = tencentcloud_security_group.default.id
  ingress = [
    "ACCEPT#0.0.0.0/0#22#TCP",
    "ACCEPT#0.0.0.0/0#6443#TCP",
  ]

  egress = [
    "ACCEPT#0.0.0.0/0#ALL#ALL"
  ]
}

# Create a web server
resource "tencentcloud_instance" "web" {
  depends_on                 = [tencentcloud_security_group_lite_rule.default]
  count                      = 1
  instance_name              = "web server"
  availability_zone          = data.tencentcloud_availability_zones_by_product.default.zones.0.name
  image_id                   = data.tencentcloud_images.default.images.0.image_id
  instance_type              = data.tencentcloud_instance_types.default.instance_types.0.instance_type
  system_disk_type           = "CLOUD_BSSD"
  system_disk_size           = 50
  allocate_public_ip         = true
  internet_max_bandwidth_out = 100
  instance_charge_type       = "SPOTPAID"
  orderly_security_groups    = [tencentcloud_security_group.default.id]
  password                   = var.password
}


# /cvm/output.tf
output "public_ip" {
  description = "vm public ip address"
  value       = tencentcloud_instance.web[0].public_ip
}

output "private_ip" {
  description = "vm private ip address"
  value       = tencentcloud_instance.web[0].private_ip
}


# /cvm/variables.tf
variable "secret_id" {
  default = "Your Access ID"
}

variable "secret_key" {
  default = "Your Access Key"
}

variable "region" {
  default = "ap-hongkong"
}

variable "password" {
  default = "password123"
}


# /cvm/version.tf
terraform {
  required_version = "> 0.13.0"
  required_providers {
    tencentcloud = {
      source  = "tencentcloudstack/tencentcloud"
      version = "1.81.5"
    }
  }
}
```
```hcl
# /k3s/main.tf
module "k3s" {
  source                   = "xunleii/k3s/module"
  k3s_version              = "v1.28.11+k3s2"
  generate_ca_certificates = true
  global_flags = [
    "--tls-san ${var.public_ip}",
    "--write-kubeconfig-mode 644",
    "--disable=traefik",
    "--kube-controller-manager-arg bind-address=0.0.0.0",
    "--kube-proxy-arg metrics-bind-address=0.0.0.0",
    "--kube-scheduler-arg bind-address=0.0.0.0"
  ]
  k3s_install_env_vars = {}

  servers = {
    "k3s" = {
      ip = var.private_ip
      connection = {
        timeout  = "60s"
        type     = "ssh"
        host     = var.public_ip
        password = var.password
        user     = "ubuntu"
      }
    }
  }
}


# /k3s/output.tf
output "kube_config" {
  value = module.k3s.kube_config
}

output "kubernetes" {
  value = module.k3s.kubernetes
}


# /k3s/variables.tf
variable "password" {
  default = "password123"
}

variable "public_ip" {}

variable "private_ip" {}
```
### 以dev环境拉起云服务举例
在dev目录下执行以下命令
```bash
#初始化（下载插件、模块）
terraform init
#检查代码有没有写错
terraform validate  
#预览：`+` 新建、`-` 销毁、`~` 修改
terraform plan   
#真正调用腾讯云 API 执行变更
terraform apply 
```
**底层拉起流程**
`dev/` 目录本身只是"总装车间"，真正的资源定义都在 `modules/` 里。以 `terraform apply` 为例，底层按下面顺序拉起整套云资产：

```
dev/main.tf（总入口，声明要用哪些模块）
│
├─ 0. terraform init
│      读 modules/cvm/version.tf 的 required_providers
│      → 下载 tencentcloud 1.81.5 插件到 .terraform/ 目录
│      → 从 registry 拉取远程模块 xunleii/k3s/module
│      → 生成 .terraform.lock.hcl 锁定版本
│
├─ 1. 构建依赖图（DAG），算出创建顺序
│      变量注入链：dev/variables.tf → module "cvm" 入参
│      → modules/cvm/variables.tf 接住 → 填进 provider "tencentcloud"
│      （带着 secret_id/key、region 初始化腾讯云 API 客户端）
│
├─ 2. modules/cvm：data 只读查询（不创建任何东西）
│      查可用区、Ubuntu 公共镜像 ID、SA5 2C4G 规格
│     
│
├─ 3. modules/cvm：创建安全组及规则
│      放行 22（SSH）、6443（k3s API Server）
│
├─ 4. modules/cvm：创建 CVM 主机
│      depends_on 保证安全组规则先生效
│      创建完输出 output：public_ip / private_ip
│
├─ 5. modules/k3s：拿 CVM 的 output 当自己的 input
│      通过 SSH（ubuntu@public_ip + password）登录新机器
│      执行 k3s v1.28.11+k3s2 安装脚本（global_flags 拼进安装命令）
│      装完输出 output：kube_config
│
└─ 6. dev/main.tf：local_sensitive_file
       把 module.k3s.kube_config 落盘为 dev/config.yaml
       之后 kubectl --kubeconfig config.yaml 即可直连集群（--tls-san 已放行公网 IP）

全程把"代码里的资源 ↔ 云上真实资源 ID"写入 dev/terraform.tfstate，下次 plan 以此比对
```
几个关键机制：
- **模块间不直接通信，全靠 output → input 传值**：CVM 的 `public_ip` 经 output 流到 `module "k3s"` 的 `public_ip` 入参，再由 `modules/k3s/variables.tf` 接住；凭证同理从 `dev/variables.tf` 一层层向下注入；
- **data 与 resource 的区别**：`data` 是"查现成的"（可用区、镜像、规格），`resource` 是"建新的"（安全组、CVM），两者在代码里几乎长得一样；
- **依赖顺序**：显式 `depends_on`（实例等安全组规则）+ 引用即依赖（k3s 引用 CVM 的 IP），Terraform 据此做拓扑排序，无依赖的资源会并行创建；
- **k3s 模块已踩进 Ansible 的领域**：provider 建好机器后，模块内部通过 SSH 连接执行远程命令装 k3s——这是"配置"而非"造机器"，放到 Terraform 里会让 apply 变慢、职责混杂，生产中更常见的做法是 Terraform 只造机器，装 k3s 交给 Ansible（即前文的分工原则）；
- **每个环境目录一份独立 state**：`dev/` 与 `test/` 结构相同、引用同一套 `modules/`，但各自目录下的 `terraform.tfstate` 互不干扰，环境差异收敛在各自的 `variables.tf` 里——新增环境就是再复制一个目录。
