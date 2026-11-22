---
title:  Ansible 和 Terraform 
published: 2026-09-24T23:11:23+08:00
description: 从 Ansible 配置管理到 Terraform 云资源编排，用一套实验项目串起 IaC 的造机器与配机器
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

### 核心概念与执行流程
```
   playbook
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
- **Inventory**：主机清单，默认是 `/etc/ansible/hosts`，项目里自己维护并在 `ansible.cfg` 指定。本文实战项目的清单由 Terraform 生成，骨架如下（真实文件含公网 IP，已 gitignore）：
```ini
[masters]                                  # 控制面组
k8s-master-1 ansible_host=公网IP private_ip=10.0.1.10
k8s-master-2 ansible_host=公网IP private_ip=10.0.1.11
k8s-master-3 ansible_host=公网IP private_ip=10.0.1.12

[workers]                                  # 工作节点组
k8s-worker-1 ansible_host=公网IP private_ip=10.0.1.20
k8s-worker-2 ansible_host=公网IP private_ip=10.0.1.21
k8s-worker-3 ansible_host=公网IP private_ip=10.0.1.22

[all:vars]                                 # 所有组共享的变量
ansible_user=root
ansible_python_interpreter=/usr/bin/python3
apiserver_endpoint=10.0.1.100:6443         # CLB 私网地址（实际值以 terraform output 为准）
```
- **Module（模块）**：一个模块干一件事（装包、拷文件、启服务）；
- **Task（任务）**：调用一次模块；**Play**：对一组主机执行的一组 task；**Playbook**：一个或多个 play 组成的 YAML 文件；
- **Facts**：自动采集的目标机信息，如 `ansible_os_family`、`ansible_default_ipv4.address`。

不想写 playbook、只想临时执行一条命令时用 **ad-hoc**：
```bash
ansible all -m ping                         # 测试所有机器连通性
ansible workers -m shell -a "free -h"       # 在 workers 组执行 shell 命令
ansible masters -m copy -a "src=a.conf dest=/etc/a.conf"     # -m 指定模块，-a 传模块参数
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
### 实战：用 Ansible 把一批云主机配成 K8s 集群
下面全部来自一个实习实验项目的真实文件：Terraform 造好 3 台 master + 3 台 worker 后，Ansible 接手"配机器"——节点初始化 → 装 containerd 和 K8s 二进制 → kubeadm 拉起集群 → 装平台组件（存储、证书、Harbor、ArgoCD……）。前文"Terraform 造机器、Ansible 配机器"的分工在这里串成一条流水线，连主机清单都是 Terraform 生成的，Ansible 只管照单干活。

**项目结构**
```
ansible/
├── ansible.cfg               # 项目级配置（优先级高于 /etc/ansible/ 全局配置）
├── inventory/
│   ├── hosts.ini             # 主机清单：terraform apply 生成，含真实 IP，已 gitignore
│   └── group_vars/
│       ├── all.yml           # 全集群变量：版本钉死、国内镜像源、组件开关
│       ├── masters.yml       # 控制面覆盖：containerd/kubelet 数据放系统盘
│       └── workers.yml       # 工作节点覆盖：数据放 80G 数据盘
├── playbooks/
│   ├── 00-preflight.yml          # 前置检查：inventory 是否生成、节点数够不够
│   ├── 01-provision-nodes.yml    # 所有节点：common + containerd + kubernetes
│   ├── 02-bootstrap-kubeadm.yml  # kubeadm init/join + 等节点 Ready
│   └── 03-install-bootstrap.yml  # 平台组件：存储/证书/Istio/Harbor/ArgoCD
└── roles/
    ├── common/            # 主机名、hosts、swap、内核参数、基础包、数据盘
    ├── containerd/        # 运行时安装 + 配置模板 + handler
    ├── kubernetes/        # kubelet/kubeadm/kubectl 装指定版本并 hold
    ├── kubeadm_master/    # kubeadm init / 其余 master join / Cilium / Helm
    ├── kubeadm_worker/    # worker kubeadm join
    └── bootstrap/         # 平台组件，按依赖顺序 include_tasks
```

**第 1 步：ansible.cfg**
```ini
[defaults]
inventory = inventory/hosts.ini   # 默认清单，省去每次 -i
roles_path = roles                # 角色搜索路径
host_key_checking = False         # 云主机重建后 SSH 指纹必变，关掉免得交互卡住
interpreter_python = auto_silent  # 自动选择远端 Python，不刷警告
pipelining = True                 # SSH 连接上流水执行，省掉每个任务重新建连、启动 Python 的开销——批量执行提速明显

[privilege_escalation]
become = True                     # 全局默认提权：装 K8s 组件处处要 root
become_method = sudo
become_user = root
```
装好 Ansible 后 `/etc/ansible/` 下有全局默认的 `ansible.cfg` 和 `hosts`；项目目录里的 `ansible.cfg` 优先级更高，从项目目录执行 ansible 命令时自动生效。

**第 2 步：inventory 与分层变量——差异只进变量，不进剧本**
清单由 Terraform 生成（`[masters]`/`[workers]` 分组，每台带公网 `ansible_host` 和内网 `private_ip`，`[all:vars]` 放 `apiserver_endpoint`）。剧本只写"所有节点都一样"的逻辑，节点/角色差异全部下沉到 `group_vars/`，按组名自动加载：
```yaml
# group_vars/all.yml —— 全集群共用。版本一律钉死，不给 latest 留机会
kubernetes_minor: "1.32"
kube_package_version: "1.32.13-1.1"
containerd_version: "1.7.29-1~ubuntu.22.04~jammy"
kubeadm_image_repository: "registry.aliyuncs.com/google_containers"   # 控制面镜像全走国内源

# 组件开关：各剧本按它决定装不装，命令行 -e 还能临时覆盖
install_cilium: true
install_storage: true
install_cert_manager: true
install_istio: true
install_harbor: true
install_argocd: true
```
```yaml
# group_vars/workers.yml —— 只有 worker 需要覆盖的差异：
# 40G 系统盘会被镜像撑爆，数据盘 /dev/vdb 挂到 /data，containerd/kubelet 存储挪过去
worker_data_disk_device: /dev/vdb
containerd_root: /data/containerd
kubelet_root_dir: /data/kubelet
```
同一个 `containerd_root` 变量，masters 上渲染成系统盘路径、workers 上渲染成数据盘路径——**剧本一份，角色/环境差异全在变量层**，这正是"环境剧本"思想的落地：清单里组名即环境，变量文件与组名一一对应，Ansible 自动加载。

**第 3 步：编号剧本按依赖顺序执行**
playbook 一多就要考虑编排，这个项目直接给剧本编号，**编号即执行顺序**（也可以用 `site.yml + import_playbook` 串，效果一样）：
```yaml
# playbooks/00-preflight.yml —— 不碰任何节点，先验证 inventory 是不是好的
- name: 集群前置检查
  hosts: localhost              # 只在控制端跑
  gather_facts: false
  any_errors_fatal: true        # 检查不过，整个流程直接终止
  tasks:
    - name: 检查分组是否存在
      assert:
        that:
          - groups['masters'] | length >= 3
          - groups['workers'] | length >= 1
        fail_msg: "inventory 为空或节点数不足，先执行 terraform apply"

    - name: 打印执行计划
      debug:
        msg:
          - "master：{{ groups['masters'] | join(', ') }}"
          - "worker：{{ groups['workers'] | join(', ') }}"
          - "下一步：ansible-playbook playbooks/01-provision-nodes.yml"
```
```yaml
# playbooks/01-provision-nodes.yml —— 所有节点统一初始化
- name: 节点初始化
  hosts: all
  become: true
  any_errors_fatal: true        # 一台失败就整体停，不留下半套配置的节点
  roles:
    - common                    # 依次执行 roles/common、roles/containerd、roles/kubernetes
    - containerd
    - kubernetes
```
```yaml
# playbooks/02-bootstrap-kubeadm.yml —— 三个 play 体现"按组编排"
- name: 控制面（kubeadm init / join + Cilium）
  hosts: masters
  become: true
  any_errors_fatal: true
  roles:
    - kubeadm_master

- name: 工作节点加入
  hosts: workers
  become: true
  any_errors_fatal: true
  roles:
    - kubeadm_worker

- name: 等待全部节点 Ready
  hosts: masters
  become: true
  any_errors_fatal: true
  tasks:
    - name: 等待节点 Ready（Cilium 装好后节点才会变 Ready）
      command: kubectl wait --for=condition=Ready nodes --all --timeout=900s
      when: inventory_hostname == groups['masters'][0]   # 只在第一台 master 上执行一次
      changed_when: false        # 只是查询状态，不算"变更"
```
```bash
# 03 装平台组件；组件开关可用 -e 临时覆盖（只想先验证控制面时关掉大组件）
ansible-playbook playbooks/03-install-bootstrap.yml -e install_istio=false -e install_harbor=false
```

### 角色：一个 role 管一件事
上面 01 里一行 `common`，背后是一个标准目录——任务、处理器、模板各归其位，剧本里只留一行引用：
```
roles/common/
├── tasks/main.yml        # 角色入口：主任务写在这里
├── handlers/main.yml     # 处理器：被 notify 才执行（如重启服务）
├── templates/            # .j2 模板，推送前经 Jinja2 渲染
├── files/                # 原样下发的静态文件
├── defaults/main.yml     # 角色默认变量（优先级最低，外部用 group_vars 同名覆盖即可，角色逻辑不用改）
└── meta/main.yml         # 角色依赖（整个骨架可用 ansible-galaxy init roles/common 生成）
```
社区通用角色/模块以 collection 分发，`ansible-galaxy collection install community.general` 即可复用。这个项目里最有代表性的几个角色：

**common——幂等的教科书**
改状态的任务全部带条件，重复执行不假报变更；只读探测一律 `changed_when: false`：
```yaml
- name: 关闭 swap（当前会话）
  command: swapoff -a
  when: ansible_swaptotal_mb | int > 0           # facts 判断机器上有没有 swap
  changed_when: ansible_swaptotal_mb | int > 0    # command 不会汇报改了什么，人工标注

- name: 注释 fstab 中的 swap 条目
  replace:
    path: /etc/fstab
    regexp: '^([^#].*\sswap\s.*)$'
    replace: '# \1'                              # 不持久化关闭，重启后 swap 复活，kubelet 起不来

- name: 写入 Kubernetes 需要的 sysctl
  copy:
    dest: /etc/sysctl.d/99-kubernetes.conf
    content: |
      net.bridge.bridge-nf-call-iptables = 1
      net.ipv4.ip_forward = 1
  register: k8s_sysctl_file                       # 记录本任务结果

- name: 应用 sysctl
  command: sysctl --system
  when: k8s_sysctl_file.changed                   # 配置文件真的变了才重新加载
  changed_when: true
```
数据盘挂载是生产高频场景（worker 的 40G 系统盘会被镜像撑爆，装任何东西之前必须先把 80G 数据盘挂到 `/data`），整个流程每一步都可重入：
```yaml
- name: 确认数据盘设备存在
  stat:
    path: "{{ worker_data_disk_device }}"
  register: worker_data_disk

- name: 数据盘不存在时直接失败
  assert:
    that:
      - worker_data_disk.stat.exists
    fail_msg: "{{ worker_data_disk_device }} 不存在：检查 terraform 的 data_disks 配置"

- name: 探测数据盘文件系统
  command: blkid -s TYPE -o value {{ worker_data_disk_device }}
  register: data_disk_fs
  changed_when: false        # 探测不是变更
  failed_when: false         # 没有文件系统时 blkid 以非 0 退出，这里不算失败

- name: 格式化数据盘（仅当没有文件系统时）
  command: mkfs.ext4 -F -L data {{ worker_data_disk_device }}
  when: data_disk_fs.rc != 0 # 第二次执行时已有文件系统，自动跳过

- name: 读取数据盘 UUID
  command: blkid -s UUID -o value {{ worker_data_disk_device }}
  register: data_disk_uuid
  changed_when: false

- name: 挂载到 /data 并写入 fstab
  mount:
    path: /data
    src: "UUID={{ data_disk_uuid.stdout | trim }}"   # 按 UUID 挂载，设备名漂移也不受影响
    fstype: ext4
    state: mounted         # 模块自己判断：已挂载就 ok 跳过
```

**containerd——handler：配置变了才重启**
```yaml
# roles/containerd/tasks/main.yml
- name: 渲染 containerd 配置
  template:
    src: config.toml.j2
    dest: /etc/containerd/config.toml
  notify: restart containerd          # 本任务结果为 changed 时，通知同名 handler

# roles/containerd/handlers/main.yml
- name: restart containerd
  systemd:
    name: containerd
    state: restarted
```
所有 task 跑完后才统一触发 handler——一批任务改了多处配置，服务只重启一次；配置没变则一次都不重启。

**kubernetes——版本治理**
```yaml
- name: 安装指定版本的 kubelet / kubeadm / kubectl
  apt:
    name:
      - "kubelet={{ kube_package_version }}"
      - "kubeadm={{ kube_package_version }}"
      - "kubectl={{ kube_package_version }}"
    state: present

- name: 锁定 Kubernetes 组件版本
  dpkg_selections:
    name: "{{ item }}"
    selection: hold            # 防 apt upgrade 漂移：kubelet 版本一旦高于 apiserver 小版本，节点直接起不来
  loop: [kubelet, kubeadm, kubectl]
```

**kubeadm_master / kubeadm_worker——跨主机传值**
集群引导要"第一台 master 生成凭证 → 其他节点拿来用"，但不同主机上的执行相互独立、内存不共享，靠 `set_fact` 写入主机事实、再用 `hostvars` 跨机读取：
```yaml
# roles/kubeadm_master/tasks/join_facts.yml（在第一台 master 上执行）
- name: 生成 bootstrap token
  command: kubeadm token create --ttl 4h    # 4 小时有效期的临时凭证
  register: join_token_raw
  changed_when: false

- name: 计算 CA 证书公钥哈希
  shell: |
    openssl x509 -pubkey -in /etc/kubernetes/pki/ca.crt \
      | openssl rsa -pubin -outform der 2>/dev/null \
      | sha256sum | awk '{print $1}'
  register: join_ca_hash_raw
  changed_when: false

- name: 记录 join 参数
  set_fact:                                 # 写入这台主机的事实，本次执行期间一直可用
    join_token: "{{ join_token_raw.stdout | trim }}"
    join_ca_hash: "{{ join_ca_hash_raw.stdout | trim }}"

# roles/kubeadm_worker/tasks/main.yml（在每台 worker 上执行）
- name: 加入集群
  command: >-
    kubeadm join {{ apiserver_endpoint }}
    --token {{ hostvars[groups['masters'][0]].join_token }}    # 跨主机读第一台 master 的事实
    --discovery-token-ca-cert-hash sha256:{{ hostvars[groups['masters'][0]].join_ca_hash }}
    --cri-socket unix:///run/containerd/containerd.sock
  args:
    creates: /etc/kubernetes/kubelet.conf    # 已加入过就跳过，重复执行不会重复 join
```
`kubeadm init/join` 这类一次性命令没有原生幂等，惯用手法是 `creates:`/`removes:` 指向执行后的产物文件；控制面角色还先 `stat` 判断 `/etc/kubernetes/admin.conf` 是否存在，区分"首次初始化"和"重复执行"。

**bootstrap——include_tasks 编排平台组件**
组件之间有硬依赖顺序（命名空间 → 存储 → cert-manager → Istio → Harbor → ArgoCD），主任务文件只做调度：
```yaml
# roles/bootstrap/tasks/main.yml（节选）
- name: 校验 terraform 生成的 inventory 变量
  assert:
    that:
      - apiserver_endpoint is defined
      - groups['masters'] | length > 0
    fail_msg: "缺少变量或分组：先执行 terraform apply 生成 inventory"

- name: 安装 local-path 动态存储
  include_tasks: storage.yml
  when: install_storage | bool        # all.yml 的组件开关，-e install_storage=false 可跳过

- name: 安装 cert-manager 与内部 CA 证书链
  include_tasks: cert_manager.yml
  when: install_cert_manager | bool

- name: 安装 ArgoCD 并交给它接管
  include_tasks: argocd.yml           # 最后装：引导层自己不由 GitOps 管
  when: install_argocd | bool
```
其中占位符检查是纯生产经验：manifest 里残留 `REPLACE_WITH_SERVER_IP` 时，Harbor 证书 SAN 非法、路由全 404，而且**不报错、静默失败**——所以先 `grep` 扫一遍，`assert` 强制为 0 才继续：
```yaml
- name: 查找未替换的 REPLACE_WITH_SERVER_IP
  shell: grep -rl "REPLACE_WITH_SERVER_IP" {{ ansible_workdir }}/check || true
  register: placeholder_hits
  changed_when: false

- name: 占位符必须全部替换
  assert:
    that:
      - placeholder_hits.stdout == ""
    fail_msg: "以下文件仍含占位符：{{ placeholder_hits.stdout }}"
```

### 幂等是怎么炼成的
前面散落的幂等手法收拢成一张表——这是 Ansible 与"批量跑 shell 脚本"的本质区别：
| 手段 | 适用场景 | 项目中的例子 |
| ---- | -------- | ------------ |
| 专用模块自带状态判断 | 装包/文件/挂载/服务 | `apt` state: present、`mount` state: mounted、`systemd` state: started |
| `creates` / `removes` | 一次性 command | `kubeadm init/join` 指向产物文件，执行过就跳过 |
| `stat` + `when` | 先探测再动手 | 已有 `/usr/local/bin/helm` 就跳过下载安装 |
| `register` + `when` | 上一步结果触发下一步 | sysctl 配置变了才执行 `sysctl --system` |
| `changed_when: false` | 只读查询别报变更 | `kubectl get`、`blkid`、`helm repo update` |
| `changed_when: true/条件` | command 改了状态但自己不会说 | `swapoff -a`、`kubectl apply`（输出含 created） |
| `handler` + `notify` | 变更才做的收尾动作 | 配置模板变了才 `restart containerd` |
| `assert` | 前置条件不满足立即失败 | 占位符必须替换完、数据盘必须存在 |

### templates/ 与 copy：下发改不改内容
两个目录都是往目标机下发文件，区别在于**下发改不改内容**：
| 目录/写法 | 模块 | 下发方式 |
| --------- | ---- | -------- |
| `templates/` | `template` | 推送前先用 Jinja2 渲染 `{{ }}` 变量再写入 |
| `files/` 或 `copy` 的 `content:` | `copy` | 原样搬运，一个字节都不改 |

判断口诀：**内容里有变量或循环 → template，纯固定文本 → copy**。真实项目里的典型 template：
```jinja2
# roles/containerd/templates/config.toml.j2 —— 同一份配置，masters 与 workers 渲染出不同存储路径
root = "{{ containerd_root }}"
sandbox_image = "{{ sandbox_image }}"
SystemdCgroup = true
```
```jinja2
# roles/kubeadm_master/templates/kubeadm-init.yaml.j2 —— 循环渲染每台 master 的证书 SAN
apiServer:
  certSANs:
    - "{{ apiserver_endpoint.split(':')[0] }}"
{% for h in groups['masters'] %}
    - "{{ hostvars[h]['private_ip'] }}"
    - "{{ hostvars[h]['ansible_host'] }}"
{% endfor %}
```
固定文本（sysctl 配置、apt 源、sudo 规则）直接用 `copy` 的 `content:` 内联，连 files/ 目录都不用建。放错的后果：静态文件放 templates/ 不会报错（只是渲染了个寂寞），但含变量的文件走 copy 会把 `{{ }}` 原样写进目标机配置，服务直接起不来。

### 执行与验证
```bash
# 控制机项目目录内执行（inventory 已在 ansible.cfg 指定，不用 -i）
ansible-playbook playbooks/00-preflight.yml         # 先跑前置检查，打印执行计划
ansible-playbook playbooks/01-provision-nodes.yml   # 节点初始化
ansible-playbook playbooks/02-bootstrap-kubeadm.yml # 拉起集群
ansible-playbook playbooks/03-install-bootstrap.yml # 平台组件

kubectl get nodes -o wide                           # 全部 Ready 才算成功
```

### Ansible 在 CMDB 上的应用
**CMDB（配置管理数据库）**记录企业全部 IT 资产：每台机器的 IP、配置、业务归属、负责人、环境、机房。Ansible 与 CMDB 打通后，自动化从"手工列机器清单"升级为"资产数据驱动"，数据流双向：
```
CMDB ──① 动态拉取清单/分组──▶ Ansible 执行变更
CMDB ◀──② 回传 facts 盘点─── Ansible（每台机器的真实硬件/系统信息）
```
**① CMDB 作为动态 Inventory（CMDB → Ansible）**：机器频繁增删，静态 inventory 必然过时。写一个动态清单脚本调 CMDB API、按业务线/环境/机房自动生成分组即可——脚本只需实现两个入参：`--list`（输出全部主机与分组的 JSON）和 `--host <主机名>`（输出单台主机变量，简单场景可返回空 JSON）。之后直接以 CMDB 的实时数据执行：
```bash
ansible -i cmdb-inventory.py web -m ping
ansible-playbook -i cmdb-inventory.py deploy.yml -l web    # -l 限定只跑某组
```
**新机器入库后无需改任何 Ansible 文件**。典型场景：对"支付业务 + 生产环境 + 香港机房"这组机器统一下发安全基线、批量重启、灰度发布。

**② Ansible 采集事实回填 CMDB（Ansible → CMDB）**：CMDB 里手工填的 CPU/内存/磁盘数据很快就会和真实情况不一致，让 Ansible 定期跑 `setup` 模块（gather_facts）采集，再用 `uri` 模块 POST 回去：
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
配合 cron/流水线定期执行，CMDB 就从"人工维护的表格"变成**自动盘点、持续准确**的资产库，还能基于这些数据做合规巡检（找出内核版本过低、磁盘使用率超阈值的机器）——本质上是"**CMDB 管机器的身份信息，Ansible 管机器的实际状态，两者互相校验**"。

### Ansible 在云原生时代的主要应用
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
### 为什么用 Terraform 管云资产
传统方式在云控制台"点点点"创建资源，量少时还行，规模一大问题就暴露：资源怎么来的没人说得清、测试和生产配置对不上、离职同事留下的资源无人敢动。Terraform 把云资源写成代码来管，核心优越性：
- **声明式 + 幂等**：只描述"要什么"（一个 VPC、一台 4C8G 主机），不写操作步骤；重复执行结果一致，已符合的资源自动跳过——与 Ansible 的幂等思想同源，只是作用对象从"机器内部"换成了"云平台"；
- **执行计划可预览**：`terraform plan` 先做预演，清楚列出本次变更将**创建（+）、修改（~）、销毁（-）**哪些资源，人工确认后才真正应用（`apply`）；
- **状态文件（state）跟踪真实资产**：state 记录"代码里的资源 ↔ 云上真实资源"的映射，plan 时会与实际比对——有人绕过代码直接在控制台改了安全组规则（漂移，drift），下次 plan 立刻暴露；
- **依赖自动编排**：资源间用引用表达依赖，Terraform 自动排序执行（先建 VPC → 子网 → 主机），几百个资源的创建顺序不用人操心；
- **资产代码化进 Git**：资源定义有版本、有评审、有审计，谁改了什么一查便知；出问题回滚代码再 apply 即可；
- **多云统一工作流**：通过 provider 插件对接阿里云、腾讯云、AWS 等，一套 `init / plan / apply` 流程管所有云，不用各家控制台各学一套。

### 项目结构

和 `ansible/` 平级放一个 `terraform/`，按职责拆文件（Terraform 会把目录下所有 `.tf` 当成同一份配置，拆文件只为可读）：

```
project-infra/
├── terraform/
│   ├── versions.tf        # terraform/provider 版本钉死 + backend 占位
│   ├── variables.tf       # 规格即变量：节点数、机型、盘大小、来源 CIDR
│   ├── terraform.tfvars   # 每套环境自己的值（含真实 IP，已 gitignore；仓库放 .example）
│   ├── main.tf            # provider、locals（固定私网 IP）、data 查询
│   ├── network.tf         # VPC、交换机、安全组与规则
│   ├── instances.tf       # 密钥对 + master/worker 实例
│   ├── slb.tf             # 私网 CLB + 6443 监听 + 后端组
│   ├── inventory.tf       # 渲染出 ../ansible/inventory/hosts.ini
│   ├── outputs.tf         # 公网/私网 IP、apiserver_endpoint
│   └── templates/
│       └── inventory.tpl  # Ansible 主机清单模板
└── ansible/               # 前文的剧本目录
```

关键认知：**Terraform 的产物不只是云主机，还包括 Ansible 的输入**——主机清单和 controlPlaneEndpoint 都由它生成。

### 第 1 步：versions.tf —— 版本钉死，state 不进 Git

```hcl
terraform {
  required_version = ">= 1.6.0"

  required_providers {
    alicloud = {
      source  = "aliyun/alicloud"
      version = "1.294.0"
    }
    local = {                      # local_file / local_sensitive_file 用
      source  = "hashicorp/local"
      version = "2.5.2"
    }
  }

  # 本地 state 只适合单人实验。团队协作必须换远端后端，先建 bucket 再打开：
  # backend "oss" {
  #   bucket = "micro-bl-tfstate"
  #   key    = "k8s/terraform.tfstate"
  #   region = "cn-hangzhou"
  # }
}
```

- provider 版本钉死，`.terraform.lock.hcl` 一起提交——保证任何机器 `init` 出来的插件版本与校验和完全一致；
- **state 绝不能进 Git**：它记录全部资源属性（可能含密码、密钥），多人同时 apply 还会互相覆盖。本地实验用 `.gitignore` 排除 `*.tfstate*`，团队直接上 OSS backend（要配 TableStore 才能加锁，否则仍可能并发写）；
- 远端 backend 的另一层价值：CI 和本地共用同一份 state，不会出现"我本机 plan 是空的、云上资源却存在"。

### 第 2 步：variables.tf —— 规格全在变量层

```hcl
variable "master_count" {
  type    = number
  default = 3

  validation {                     # etcd 要奇数，且至少 3 台才有高可用
    condition     = var.master_count % 2 == 1 && var.master_count >= 3
    error_message = "master_count 必须是 >= 3 的奇数。"
  }
}

variable "worker_instance_type" {
  type    = string
  default = "ecs.c7.2xlarge"       # 8C16G
}

variable "worker_data_disk_size" {
  type    = number
  default = 80                     # GiB：容器运行时 + 本地 PV
}

variable "ssh_cidr" {
  type = string

  validation {                     # 必填且不允许留空，防止误开全网
    condition     = length(trimspace(var.ssh_cidr)) > 0
    error_message = "必须提供 ssh_cidr（例如 1.2.3.4/32）。"
  }
}
```

- 校验在 `plan` 之前就把错误规格拦下来，比 apply 到一半失败强；
- **安全组来源网段是变量**，代码里不出现写死的 `0.0.0.0/0`；`ssh_cidr` 只填运维机公网 IP/32；
- 真正敏感的值不要给 `default`，用 `TF_VAR_xxx` 环境变量或密钥管理注入，而不是写进 `terraform.tfvars` 后提交。

### 第 3 步：main.tf —— 固定私网 IP，可用区按规格筛选

```hcl
provider "alicloud" {
  region = var.region
}

locals {
  name_prefix = "micro-bl"
  az          = var.availability_zone != "" ? var.availability_zone : data.alicloud_zones.this.zones[0].id

  # 固定私网 IP：kubeadm 证书 SAN、etcd peer 地址都写死了 IP，
  # 实例重建后 IP 一漂移，整个集群就得重装
  master_private_ips = [for i in range(var.master_count) : cidrhost(var.vswitch_cidr, 10 + i)]
  worker_private_ips = [for i in range(var.worker_count) : cidrhost(var.vswitch_cidr, 20 + i)]

  common_tags = merge(var.tags, { managed-by = "terraform" })
}

# 可用区不是随手选的：要求该区同时支持 worker 规格、ESSD 和交换机
data "alicloud_zones" "this" {
  available_instance_type     = var.worker_instance_type
  available_disk_category     = "cloud_essd"
  available_resource_creation = "VSwitch"
}

data "alicloud_images" "ubuntu" {
  owners      = "system"
  name_regex  = var.image_name_regex    # ^ubuntu_22
  most_recent = true
}
```

两个值得抄走的细节：

- **IP 由代码分配**：`cidrhost("10.0.1.0/24", 10)` 得到 `10.0.1.10`，master 从 .10 起、worker 从 .20 起。实例销毁重建后私网 IP 不变，Ansible 里写死的 `private_ip`、kubeadm 的 `advertiseAddress` 都不会烂；
- **可用区选型交给 data 查询**：把"必须支持这个规格和 ESSD"作为过滤条件交给云 API，避免代码没问题、apply 时却报"该可用区库存不足"。

### 第 4 步：network.tf —— 网络与安全组

```hcl
resource "alicloud_vpc" "this" {
  vpc_name   = "${local.name_prefix}-vpc"
  cidr_block = var.vpc_cidr            # 10.0.0.0/16
  tags       = local.common_tags
}

resource "alicloud_vswitch" "this" {
  vpc_id     = alicloud_vpc.this.id    # 引用即依赖：VPC 一定先建
  cidr_block = var.vswitch_cidr        # 10.0.1.0/24
  zone_id    = local.az
}

resource "alicloud_security_group" "this" {
  security_group_name = "${local.name_prefix}-k8s"
  vpc_id              = alicloud_vpc.this.id
  tags                = local.common_tags
}

# VPC 内全通：etcd 2379/2380、kubelet 10250、Cilium VXLAN、NodePort 互访全靠它
resource "alicloud_security_group_rule" "internal_all" {
  type              = "ingress"
  ip_protocol       = "all"
  port_range        = "-1/-1"
  security_group_id = alicloud_security_group.this.id
  cidr_ip           = var.vpc_cidr
}

# 外部只开 SSH 与 apiserver，来源都收敛到运维机 IP
resource "alicloud_security_group_rule" "ssh" {
  type              = "ingress"
  ip_protocol       = "tcp"
  port_range        = "22/22"
  security_group_id = alicloud_security_group.this.id
  cidr_ip           = var.ssh_cidr
}

resource "alicloud_security_group_rule" "apiserver" {
  type              = "ingress"
  ip_protocol       = "tcp"
  port_range        = "6443/6443"
  security_group_id = alicloud_security_group.this.id
  cidr_ip           = var.ssh_cidr
}

# CLB 健康检查的源地址固定是 100.64.0.0/10（阿里云保留段，不在 VPC 网段内）。
# 少了这条：CLB 后端永远"异常"，kubeadm init 卡在等待 controlPlaneEndpoint
resource "alicloud_security_group_rule" "clb_health_check" {
  type              = "ingress"
  ip_protocol       = "tcp"
  port_range        = "6443/6443"
  security_group_id = alicloud_security_group.this.id
  cidr_ip           = "100.64.0.0/10"
}

# 外部入口只保留真正要用浏览器访问的 NodePort，内部组件走 port-forward
locals {
  node_ports = toset([
    "30003", # Harbor HTTPS
    "30080", # Istio ingressgateway
    "30082", # ArgoCD
    "30300", # Grafana
    "30900", # MinIO API
  ])
}

resource "alicloud_security_group_rule" "nodeports" {
  for_each = local.node_ports

  type              = "ingress"
  ip_protocol       = "tcp"
  port_range        = "${each.value}/${each.value}"
  security_group_id = alicloud_security_group.this.id
  cidr_ip           = var.node_port_cidr
}
```

- 规则一条一个资源：plan 里改哪条显示哪条，不会整组覆盖；
- `for_each = toset(...)` 按端口集合展开，也是 **for_each 相对 count 的核心优势**——count 按下标管理，删中间一个会让后面全部重建。

### 第 5 步：instances.tf —— 造机器

```hcl
resource "alicloud_key_pair" "this" {
  key_pair_name = var.key_pair_name
  public_key    = var.ssh_public_key      # 公钥不敏感，私钥只留在运维机
}

resource "alicloud_instance" "master" {
  count = var.master_count

  instance_name        = "${local.name_prefix}-master-${count.index + 1}"
  host_name            = "k8s-master-${count.index + 1}"
  image_id             = data.alicloud_images.ubuntu.images[0].id
  instance_type        = var.master_instance_type      # ecs.c7.large，2C4G
  vswitch_id           = alicloud_vswitch.this.id
  security_groups      = [alicloud_security_group.this.id]
  private_ip           = local.master_private_ips[count.index]
  key_name             = alicloud_key_pair.this.key_pair_name
  instance_charge_type = "PostPaid"

  internet_charge_type       = "PayByTraffic"          # 带宽上限只封顶，按流量计费
  internet_max_bandwidth_out = var.internet_max_bandwidth_out

  system_disk_category = "cloud_essd"
  system_disk_size     = var.master_system_disk_size
}

resource "alicloud_instance" "worker" {
  count = var.worker_count

  instance_name        = "${local.name_prefix}-worker-${count.index + 1}"
  host_name            = "k8s-worker-${count.index + 1}"
  image_id             = data.alicloud_images.ubuntu.images[0].id
  instance_type        = var.worker_instance_type      # ecs.c7.2xlarge，8C16G
  vswitch_id           = alicloud_vswitch.this.id
  security_groups      = [alicloud_security_group.this.id]
  private_ip           = local.worker_private_ips[count.index]
  key_name             = alicloud_key_pair.this.key_pair_name
  instance_charge_type = "PostPaid"

  internet_charge_type       = "PayByTraffic"
  internet_max_bandwidth_out = var.internet_max_bandwidth_out

  system_disk_category = "cloud_essd"
  system_disk_size     = var.worker_system_disk_size

  data_disks {
    name                 = "${local.name_prefix}-data-${count.index + 1}"
    size                 = var.worker_data_disk_size  # 80G：containerd/kubelet 数据 + 本地 PV
    category             = "cloud_essd"
    encrypted            = true
    delete_with_instance = true
  }
}
```

- master 不给数据盘：etcd 与 apiserver 的写入落在 ESSD 系统盘就够，少一块盘少一个挂载点要管；
- worker 单独挂数据盘，但 **Terraform 只负责"把盘挂到机器上"，格式化和挂载点是 Ansible 的活**（前文 `/data` 那段）——边界清楚，两边不重复干对方的活；
- 同构实例用 `count`（`alicloud_instance.master[0]`），有稳定标识的资源用 `for_each`；实例本来就该整体重建，count 没问题。

### 第 6 步：slb.tf —— 控制面统一入口

```hcl
locals {
  apiserver_endpoint = "${alicloud_slb_load_balancer.apiserver.address}:6443"
}

resource "alicloud_slb_load_balancer" "apiserver" {
  load_balancer_name = "${local.name_prefix}-apiserver"
  address_type       = "intranet"        # 私网：kubeadm 只走内网
  vswitch_id         = alicloud_vswitch.this.id
  load_balancer_spec = "slb.s1.small"
  payment_type       = "PayAsYouGo"
}

resource "alicloud_slb_listener" "apiserver" {
  load_balancer_id          = alicloud_slb_load_balancer.apiserver.id
  protocol                  = "tcp"
  frontend_port             = 6443
  backend_port              = 6443
  bandwidth                 = -1          # 私网不限速
  health_check              = "on"
  health_check_type         = "tcp"
  health_check_connect_port = 6443
  health_check_interval     = 5
  health_check_timeout      = 3
}

resource "alicloud_slb_backend_server" "apiserver" {
  load_balancer_id = alicloud_slb_load_balancer.apiserver.id

  dynamic "backend_servers" {
    for_each = alicloud_instance.master[*].id    # 三台 master 全进后端
    content {
      server_id = backend_servers.value
      weight    = 100
    }
  }
}
```

为什么用托管 CLB 而不是 keepalived + VIP：不用自己维护 VIP 漂移和健康检查，**kubeadm 的 controlPlaneEndpoint 指向它**——worker join、本机 kubectl、以后 master 扩容都只认这一个地址。代价是多一份 SLB 费用，以及那条最容易忘的健康检查放行规则。

### 第 7 步：inventory.tf —— 把机器交给 Ansible

```hcl
resource "local_file" "ansible_inventory" {
  filename = "${path.module}/../ansible/inventory/hosts.ini"

  content = templatefile("${path.module}/templates/inventory.tpl", {
    masters = [for i, ip in alicloud_instance.master[*].public_ip : {
      name       = "k8s-master-${i + 1}"
      public_ip  = ip
      private_ip = local.master_private_ips[i]
    }]
    workers = [for i, ip in alicloud_instance.worker[*].public_ip : {
      name       = "k8s-worker-${i + 1}"
      public_ip  = ip
      private_ip = local.worker_private_ips[i]
    }]
    apiserver_endpoint = local.apiserver_endpoint
  })
}
```

模板就是前文 Ansible 直接消费的清单：

```text
[masters]
%{ for m in masters ~}
${m.name} ansible_host=${m.public_ip} private_ip=${m.private_ip}
%{ endfor ~}

[workers]
%{ for w in workers ~}
${w.name} ansible_host=${w.public_ip} private_ip=${w.private_ip}
%{ endfor ~}

[all:vars]
ansible_user=root
ansible_python_interpreter=/usr/bin/python3
apiserver_endpoint=${apiserver_endpoint}
```

这是两个工具唯一的接口：apply 一结束，`hosts.ini` 里就是真实公网 IP、内网 IP 和控制面地址，Ansible 直接起跑，不用人手抄 IP；实例重建、IP 变化，重新 apply 清单自动同步。清单含公网 IP，属于环境信息，跟 state 一起 gitignore。

`outputs.tf` 把需要给人或 CI 看的值暴露出来：

```hcl
output "apiserver_endpoint" {
  value = local.apiserver_endpoint
}

output "ssh_hint" {
  value = "ssh -i <你的私钥> root@${alicloud_instance.master[0].public_ip}"
}
```

### 执行
在 `terraform/` 目录下：

```bash
terraform init        # 下载 alicloud/local provider，生成 .terraform.lock.hcl
terraform fmt         # 统一格式，提交前必跑
terraform validate    # 语法与类型检查，不访问云 API
terraform plan        # 预演：+ 创建、~ 修改、- 销毁
terraform apply       # 确认后真正调阿里云 API，同时生成 hosts.ini

terraform output apiserver_endpoint
terraform output ssh_hint
```

plan 输出要会读：`+` 新建、`~` 原地修改、`-/+` 销毁重建（force new）。**看到 `-/+` 落在实例上必须先停下来确认**——改实例规格、可用区或镜像都可能触发重建。

### apply 时底层发生了什么

```
terraform apply
│
├─ 0. init 已完成：provider 插件在 .terraform/，版本锁在 .terraform.lock.hcl
│
├─ 1. 读 terraform.tfvars → 填变量 → 构建依赖图（DAG）
│
├─ 2. data 只读查询（不创建任何资源）
│      alicloud_zones：筛出支持 worker 规格 + ESSD + 交换机的可用区
│      alicloud_images：取最新的 ubuntu_22 镜像 ID
│
├─ 3. 网络层：靠引用关系天然串行
│      VPC → 交换机（引用 vpc_id、zone_id）
│      → 安全组 → 安全组规则（引用 security_group_id）
│
├─ 4. 实例层
│      密钥对 → master×3 / worker×3
│      （引用 vswitch_id、security_groups、key_name）
│      master 固定私网 IP .10/.11/.12，worker 从 .20 起
│
├─ 5. 负载均衡层
│      CLB（引用 vswitch_id）→ 6443 监听 → 后端组（引用 master[*].id）
│
└─ 6. 收尾
       inventory.tf 读 master/worker 的 public_ip，渲染 hosts.ini 到 ../ansible/
       所有资源 ID 写入 terraform.tfstate
```

**文件顺序没有意义**：Terraform 把目录下所有 `.tf` 当成同一份配置，执行顺序完全由依赖图决定，无依赖的资源并行创建。拆文件只是为了人读。

### 几个关键机制

- **引用即依赖**：写下 `vswitch_id = alicloud_vswitch.this.id` 的同时就声明了"交换机先建"，不需要手工 `depends_on`；`depends_on` 只在没有数据引用、但有隐藏顺序要求时补；
- **data 与 resource**：`data` 查现成的（可用区、镜像），`resource` 建新的（VPC、实例）；两者写法几乎一样，但 data 不进 state 的托管资源清单，也不会被 destroy；
- **output 是工具间的接口**：`apiserver_endpoint` 既喂给 `inventory.tpl`，也能被 CI 用 `terraform output -raw` 取走做后续判断；
- **`No changes` 是有意义的输出**：plan 显示无变化，说明代码与云上一致；反过来显示一堆 `~`，说明有人手动改过（漂移），以代码为准 apply 回去即可；
- **多环境**：每套环境一份 `terraform.tfvars` + 独立 state（分目录或 workspace），共用同一套 `.tf`；别在同一份 state 上用 `-var-file` 手工切换，容易把生产改炸。

### 销毁

```bash
terraform destroy     # 逆拓扑序：后端组 → CLB → 实例 → 安全组 → 交换机 → VPC
```

- 顺序由 DAG 反向自动决定，不用手删；
- `delete_with_instance = true` 的数据盘会跟实例一起删——实验环境方便，**生产先确认盘里没数据**；
- state 丢了等于代码和云上资产失联：资源还在，Terraform 不认识，只能 `terraform import` 一个个捞回来。所以 state 要么在远端 backend，要么本地备份。

### 衔接 Ansible

到这里"造机器"结束，产物三样：**运行中的 3 master + 3 worker、一个私网 CLB 的 6443 入口、一份自动生成的 `hosts.ini`**。进 `ansible/` 依次跑 00~03，`apiserver_endpoint` 直接来自 Terraform 的输出，kubeadm 的 controlPlaneEndpoint 与证书 SAN 天然对得上。

**Terraform 声明"有哪些机器、网络怎么通"，Ansible 声明"机器里装什么、服务怎么起"；前者产出后者的清单，后者消费前者的网络。**

## 小结

- **分工**：云 API 能创建/销毁的归 Terraform，需要 SSH 进去改的归 Ansible；一个管资源生命周期，一个管机器内部状态；
- **底线**：幂等——重复执行不出错、不重复产生副作用，所以 Ansible 里能用专用模块就别用 `shell`；
- **心态**：工具会变，边界也会移——今天 Ansible 退到 K8s 之外，明天可能还要再退一步；守住**声明期望状态 + 版本化 + 可预演 + 可回滚**，换什么工具都能快速上手。
