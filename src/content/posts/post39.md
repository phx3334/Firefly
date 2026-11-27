---
title: mysql
published: 2026-10-19T23:11:23+08:00
description: 深入 MySQL 底层原理与工程实践——索引、事务、锁、日志、集群与运维
image: './images/a39.avif'
tags: [数据库]
category: '计算机技术'
draft: false
lang: '中文'
---


MySQL 是绝大多数业务的主存储，"会用"和"用得住"差着一整套工程能力：索引怎么设计、事务怎么隔离、锁怎么排队、死锁怎么定位、单机到顶后怎么扩。本文只讲 MySQL——把每个机制的底层原理和生产实战一次讲清，所有结论都能从原理推出来。

## 选型定位 【够用】

按数据模型分三大类：

- **关系型**（MySQL）：二维表 + 外键 + SQL，核心承诺是 ACID——要么全成要么全败，断电不丢。订单、账务、用户资料的主存储。
- **NoSQL**：文档型（MongoDB，字段可变、免 DDL）、键值型（Redis，内存微秒级）、图数据库（Neo4j，多跳关系）。
- **时序库**（InfluxDB、Prometheus）：追加写 + 按时间范围扫，靠时间分区和高压缩比换吞吐。

选型的本质是拿业务的数据形状去匹配各家最擅长的部分。MySQL 的优势是生态成熟、运维人才多、中间件和云产品最全，是绝大多数团队的实际选择——本文只讲它。

## MySQL 架构总览 【必掌握】

MySQL 分两层，这条分界线决定了后面所有机制的位置：

- **Server 层**：连接器（握手、认证、权限）、分析器（词法语法）、优化器（成本估算选索引和 join 顺序）、执行器（按计划调引擎接口）。binlog 也在这层。
- **存储引擎层**：数据的存取、索引、事务、锁全部由引擎实现。引擎可插拔、表级指定（`ENGINE=InnoDB`），但生产上基本只有 InnoDB——它是唯一同时具备事务、行锁、MVCC、crash-safe 的通用引擎。

```sql
SHOW ENGINES\G
-- Support=DEFAULT 的就是当前默认引擎 InnoDB；行锁、MVCC、crash-safe 全部实现在这一层，
-- Server 层只负责解析和选路——所以"引擎可插拔"意味着换掉它（如 MyISAM），这些能力就都没了
```

分层带来灵活性，也带来历史包袱——比如 binlog 与 redo log 的两阶段提交，本质是两层各有一份日志要协调。

连接模型要记住一条：**MySQL 是每连接一线程**。`max_connections` 打满后新连接直接报 `too many connections`；空闲连接靠 `wait_timeout` 回收，应用侧必须用连接池。

## 数据怎么存：表空间与页 【够用】

开启 `innodb_file_per_table` 后每张表一个 `.ibd` 文件，内部按段 → 区 → 页三级组织：64 个连续的 16KB 页组成一个区，让 B+ 树相邻节点在磁盘上也尽量相邻，用顺序 IO 换掉随机 IO。

页（16KB）是整个体系的地基——磁盘管理、Buffer Pool 缓存、redo 记录、undo 记录全以页为单位。改一行数据，背后是整页的读写和日志。

```sql
SHOW VARIABLES LIKE 'innodb_page_size';        -- 16384 字节 = 16KB，编译期固定，运行时改不了
SHOW VARIABLES LIKE 'innodb_file_per_table';   -- ON：每张表一个独立 .ibd，装的就是按页组织的聚簇索引 B+ 树
```

## 索引：MySQL 性能的全部 【必掌握】

### B+ 树与聚簇索引

![InnoDB 聚簇索引（B+ 树）结构：索引层只存键与指针逐层路由，整行数据沉在叶子层，叶子间双向链表串联，橙色为查询 id=55 的路径](./images/mysql-btree.svg)

上一节说页是地基，可一张表有几千万个页，查询凭什么直达目标页？InnoDB 的答案是**索引**——把"全表扫描逐行找"变成"按键值直达"的目录，代价是额外占空间、每次写入都要同步维护。InnoDB 的索引统一用 B+ 树实现，只有两种节点：非叶子节点存"键 + 页号"负责路由，叶子节点用双向链表串联，**挂的是数据本身还是数据指针，取决于索引类型（见下）**。走到目标行经过 3 个节点、最多 3 次页 IO——而根节点和中间层是所有查询的必经之路，几乎永远在内存里，真正落到磁盘的通常只有叶子那一次。一个 16KB 页能装上千个键值，三层就能覆盖千万行。所谓"单表两千万行"的临界点，本质是树要长到第四层、IO 多一次，不是硬限制。

叶子上挂什么，InnoDB 的回答造就了**聚簇索引**：数据行直接物理存在主键 B+ 树的叶子里，按主键有序排列——**表就是这棵树，树就是这张表**。"聚簇"说的是数据的物理存储顺序由这个索引决定，即"索引即数据"；上一节的 `.ibd` 文件装的正是它。一个表只能有一种物理组织顺序，所以**聚簇索引有且只有一个**——InnoDB 里固定由主键担任（没有主键则选第一个非空唯一索引，都没有就隐式生成）。它带出三条工程结论：

- **主键用自增**。插入永远追加在最右侧叶子页，顺序写、页填满换新页；用 UUID 这类无序值，新行插进树中间，页满了触发页分裂，随机 IO 加空间碎片。自增主键的代价是可能存在并发插入热点，但相比随机写仍然是压倒性优势。
- **主键要短**。二级索引的叶子存的是主键值，主键越长，每个二级索引都跟着变胖。
- **不要用业务字段当主键**。业务键可能变更，而改主键等于重建整棵树。

**二级索引**（非聚簇索引）是给同一张表"额外多排的几份目录"：叶子只存索引列 + 主键值，不存整行——数据的物理顺序仍然只由聚簇索引说了算。命中后要拿主键回聚簇索引再查一次整行——这就是**回表**。回表是随机 IO，这是索引设计一切取舍的源头。

完整走一遍"加索引"这件事——效果和底层各是什么：

```sql
-- 场景：users 表 100 万行，name 列没索引
EXPLAIN SELECT * FROM users WHERE name = '张三';
-- type=ALL，rows≈1000000，key=NULL
-- 底层：从聚簇索引最左侧叶子页开始逐页横向遍历，100 万行 ≈ 几千次页 IO，全打在磁盘上

CREATE INDEX idx_name ON users(name);
-- 底层：InnoDB 扫全表收集 (name, 主键)、排序、自底向上建 B+ 树，写进独立索引页；
-- 100 万行约几秒，Online DDL 期间不阻塞读写，但这棵树从此要跟着每次写同步维护

EXPLAIN SELECT * FROM users WHERE name = '张三';
-- type=ref，rows≈10，key=idx_name
-- 底层：在 idx_name 的 B+ 树上三层路由（根/中间层常驻 Buffer Pool，通常只有 1 次磁盘 IO）
--      直达叶子拿到主键，再回聚簇索引取整行

-- 效果：扫描行数 100 万 → 10；代价：多一份索引存储 + 每次 INSERT/UPDATE/DELETE 都要维护这棵树
```

### 联合索引与最左前缀

先建索引，列序就是它的排序顺序：

```sql
CREATE INDEX idx_name_age_city ON users(name, age, city);
-- 等价于：先按 name 排，name 相同按 age 排，age 再相同按 city 排
```

最左前缀原则——必须从最左列开始**连续**匹配，中间断了就定位不了：

```sql
-- ✅ 能用索引定位（从左往右连续匹配）
SELECT * FROM users WHERE name = '张三';
SELECT * FROM users WHERE name = '张三' AND age = 20;
SELECT * FROM users WHERE name = '张三' AND age = 20 AND city = '北京';

-- ❌ 跳过最左列 name，索引完全用不上
SELECT * FROM users WHERE age = 20;

-- ⚠️ name 定位后断了：city 只能在索引里过滤，不能用来定位
SELECT * FROM users WHERE name = '张三' AND city = '北京';

-- ⚠️ 范围截断：age 是范围条件，city 无法再用于定位
SELECT * FROM users WHERE name = '张三' AND age > 20 AND city = '北京';
```

列序原则：**等值条件在前，范围条件在后，排序字段尽量跟上**。`SELECT * FROM users WHERE name = '张三' ORDER BY age` 配合 `(name, age)`，索引本身有序，排序整段省掉。

### 覆盖索引、索引下推与前缀索引

- **覆盖索引**：查询要的列全在索引里，不用回表。`CREATE INDEX idx_name_age ON users(name, age);` 之后，`SELECT name, age FROM users WHERE name = '张三'` 直接从索引返回，零回表。
- **索引下推（ICP，5.6+）**：建了 `(name, age)` 后查 `SELECT * FROM users WHERE name LIKE '张%' AND age = 20`——5.6 之前 name 模糊匹配命中后要逐行回表再过滤 age；有了 ICP，`age` 的判断下推到引擎层在索引里先过滤，回表次数大幅减少。
- **前缀索引**：长字符串（URL、邮箱）只索引前 N 个字符，省空间，但无法覆盖、也无法用于排序。`ALTER TABLE users ADD INDEX idx_email(email(10));`——N 的选择标准是"区分度不掉太多"，先跑 `SELECT COUNT(DISTINCT LEFT(email, N)) / COUNT(*) FROM users;`，接近全列区分度即可。
- **唯一索引 vs 普通索引**：查询性能几乎无差；差异在写入——普通索引的修改可以进 Change Buffer 延迟合并，唯一索引必须读页校验唯一性，反而更慢。业务能保证唯一就用唯一索引（数据正确性优先），只为查询加速就用普通索引。

### 索引失效：优化器为什么不用你的索引

常见六类，工程上高频踩：

1. **对索引列做函数/运算**：`WHERE DATE(create_time) = '2026-01-01'`、`WHERE id + 1 = 100`。改成范围查询 `WHERE create_time >= '2026-01-01' AND create_time < '2026-01-02'`。
2. **隐式类型转换**：`user_id` 是 varchar，传了数字 `WHERE user_id=123`，等于对列做 cast，索引失效。这是线上最隐蔽的一类。
3. **前导模糊**：`LIKE '%abc'` 用不了索引，`LIKE 'abc%'` 可以。
4. **不满足最左前缀**：见上一节。
5. **OR 连接的条件有一侧没索引**：整体退化为全表扫。
6. **优化器算出来不划算**：区分度太低的列（性别、状态），回表成本高于全表扫，优化器主动放弃索引。这不是"失效"，是成本判断——加索引也没用，该考虑覆盖索引或改查询。

还有一条常被忽略：**索引列参与排序时，联合索引的顺序决定能否免排序**。`WHERE name = '张三' ORDER BY age` 建 `(name, age)` 可免 filesort，建 `(age, name)` 不行。

最典型的一类（隐式类型转换）完整走一遍，看失效与修复的差别：

```sql
-- user_id 是 varchar，建了索引 idx_user_id
EXPLAIN SELECT * FROM orders WHERE user_id = 12345;
-- key=NULL，type=ALL：数字 12345 被隐式转成字符串比较，等于对每行做 CAST，
-- 索引里的排序按字符串排、比较时却先转类型——两边口径不一致，树查找无法进行

EXPLAIN SELECT * FROM orders WHERE user_id = '12345';   -- 加引号，类型对齐
-- key=idx_user_id，type=ref，rows≈1：直接在 B+ 树里按字符串 '12345' 定位

-- 底层：B+ 树查找依赖"比较规则与建树时一致"。函数、CAST、运算都会让
-- 比较规则偏离原始列的排序规则，树就退化成一张需要逐行验算的清单
```

### 用 EXPLAIN 验证索引

索引建没建对、SQL 有没有用上，不靠猜——`EXPLAIN` 是优化器的"执行计划预览"：**它不执行这条语句，只把优化器打算怎么查告诉你**——走哪个索引、预估扫多少行、要不要回表。用法是直接前置在语句前：

```sql
EXPLAIN SELECT name, age FROM users WHERE name = '张三' AND age = 20;
```

| type | possible_keys | key | rows | Extra |
| --- | --- | --- | --- | --- |
| ref | idx_name_age_city | idx_name_age_city | 10 | Using index |

读法就四点：`type` 是访问方式，`const > eq_ref > ref > range > index > ALL`，出现 `ALL` 就是全表扫；`key` 是实际用上的索引，`NULL` 说明没走；`rows` 是预估扫描行数，与实际差几个数量级就是统计信息失真；`Extra` 里 `Using index` 是覆盖索引（好），`Using index condition` 是索引下推，`Using filesort`、`Using temporary` 是要额外排序/临时表的坏味道。8.0.18+ 可用 `EXPLAIN ANALYZE`，它会真正执行并返回实际行数和耗时。

**索引不是越多越好**：每个索引都是独立的一份数据，写入时要同步维护，占空间、拖慢写入、干扰优化器。判断标准只有一条——**这条索引是否服务于确定的高频查询**。上线前用 `sys.schema_unused_indexes` 找从未被用过的索引，用 `sys.schema_redundant_indexes` 找冗余索引。

## 内存：Buffer Pool 与两个加速器 【必掌握】

**Buffer Pool** 以页为粒度缓存数据。读先查内存；写只改内存副本变成脏页，由后台线程按 checkpoint 节奏异步刷盘——只要 redo log 在，脏页丢了也能恢复。这是"写内存、慢刷盘"扛高并发的底气。

生产上两个必调项：

- **大小**：`innodb_buffer_pool_size` 默认 128M，必须调到实例内存的 50%~70%。命中率一跌，随机读直接穿透到磁盘，QPS 断崖。监控看 `Innodb_buffer_pool_read_requests` 与 `Innodb_buffer_pool_reads` 的比值。
- **容器边界**：K8s 里跑 MySQL，buffer pool 加上连接内存、排序缓冲必须小于容器 memory limit，否则刷脏高峰被 OOMKilled，表现是数据库莫名重启。这是云原生环境最常见的 MySQL 事故。

```sql
SHOW GLOBAL STATUS LIKE 'Innodb_buffer_pool_read%';
-- read_requests：向 Buffer Pool 发起的逻辑读次数（有多少次先问了内存）
-- reads：内存未命中、穿透到磁盘的物理读次数
-- 命中率 = 1 - reads / read_requests，跌破 99% 说明池太小，随机读开始打磁盘

SET GLOBAL innodb_buffer_pool_size = 17179869184;   -- 16GB，5.7+ 支持在线调整，无需重启
-- 底层：扩容的是 LRU 链表容量，新读入的页先进 old 区（防全表扫冲掉热点），命中率回升后 QPS 恢复
```

**淘汰算法**是改造过的 LRU：链表分 young / old 两段，新页先进 old 区，停留超过 `innodb_old_blocks_time` 后再次被访问才晋升 young。目的是防止一次全表扫描或备份任务把热点页全部冲刷出去。

两个加速器：

- **自适应哈希索引（AHI）**：引擎发现某些页被等值查询反复命中，自动建哈希索引，把树查找压成一次哈希定位。全程自动、无法人工干预，监控 `Innodb_ahi_*` 观察是否在工作。高并发等值查询场景收益明显，但也是 `innodb_buffer_pool_instances` 和并发争用的一个来源，出问题时可临时 `innodb_adaptive_hash_index=OFF` 验证。
- **Change Buffer**：普通二级索引的写入，如果目标索引页不在内存，不读磁盘、记账就返回，等页被读入或后台空闲时再 merge。**只对普通索引有效**（唯一索引要校验唯一性必须读页），这就是上一节"唯一索引写更慢"的原因。`innodb_change_buffer_max_size` 默认 25%，写多读少场景可调大。

两个加速器都有命令级的观察窗口：

```sql
-- Change Buffer 是否在工作：cb_reads 远大于 cb_misses 说明 merge 正常吸收写入
SHOW ENGINE INNODB STATUS\G        -- 看 INSERT BUFFER AND ADAPTIVE HASH INDEX 段

-- AHI 命中情况：ahit / ahwait 比值高才说明哈希在帮忙
SHOW GLOBAL STATUS LIKE 'Innodb_ahi%';

-- 极端验证：怀疑 AHI 争用拖慢写入，临时关掉对比压测
SET GLOBAL innodb_adaptive_hash_index = OFF;   -- 可在线开关，压完再开回 ON
```

底层共性：两者都是"用内存换磁盘"的自动优化——Change Buffer 换的是**写**（不读页就能记账），AHI 换的是**读**（哈希定位跳过树路由）。自动的东西出问题时，第一步都是关掉它做对照实验。

## 日志：undo、redo、binlog 与两阶段提交 【必掌握】

### Undo Log：回滚与 MVCC 的底座

Undo 记录反向操作（"把 age 从 21 改回 20"），两个用途：事务回滚时改回去；支撑 MVCC——每行通过回滚指针串成版本链，快照读沿链找可见版本。purge 线程延迟清理不再被需要的旧版本。

**运维上最危险的是长事务**：只要事务不提交，它可能读到的旧版本就不能清理，undo 表空间无限膨胀。典型事故：报表功能在一个事务里嵌了半小时的慢查询，期间全库旧版本都无法回收，几百 GB 的盘几小时写满。处置顺序永远是先 kill 长事务止血，再谈清理。监控盯 `information_schema.innodb_trx` 的最长事务时长，不要等磁盘告警：

```sql
-- 按运行时长倒序，trx_started 最早的就是头号嫌疑人
SELECT trx_id, trx_state, TIMESTAMPDIFF(SECOND, trx_started, NOW()) AS duration_s,
       trx_query, trx_rows_modified
FROM information_schema.innodb_trx
ORDER BY trx_started;

-- 找到后：KILL <trx_mysql_thread_id>（innodb_trx 里没有线程 id 时用 SHOW PROCESSLIST 对 SQL）
-- 底层：kill 掉事务 = 强制回滚 → 版本链对新 ReadView 可见 → purge 立即恢复回收
```

### Redo Log：crash-safe 的核心

Redo 是物理日志，记"某页某偏移做了什么修改"。写入路径：修改数据 → Log Buffer（MySQL 内存）→ OS page cache → redo log 文件。它顺序写，速度是随机刷数据页的几十倍——这就是"日志先落盘、数据页慢慢刷"能成立的前提。

落盘深度由 `innodb_flush_log_at_trx_commit` 决定：

| 值 | 行为 | 丢数据风险 | 适用 |
| --- | --- | --- | --- |
| 1（默认） | 每次提交都 fsync 到磁盘 | 不丢 | 生产标准 |
| 2 | 写到 OS page cache 即返回 | 宕机丢约 1 秒 | 可容忍少量丢失的批量导入 |
| 0 | 留在 Log Buffer 即返回 | 进程崩溃就丢 | 几乎不用 |

redo log 是**环形写**的固定大小文件（`innodb_log_file_size` × `innodb_log_files_in_group`），写满要推进 checkpoint 才能继续。日志文件配太小，高写入时会被迫频繁刷脏页，出现"写入抖动"——这是很多"CPU 不忙但 TPS 上不去"的根因。

### Binlog：Server 层的逻辑日志

与 redo 的物理记法相对：redo 记"某页某字节改成什么"（给自己崩溃恢复用），binlog 记"哪行数据变成了什么"（给别人用）。默认 `ROW` 格式，记录变更前后镜像；`STATEMENT` 记录 SQL 原文（有不确定性，已基本弃用）；`MIXED` 混合。

三个关键参数：

- `sync_binlog=1`：每次提交 fsync binlog，配合 `innodb_flush_log_at_trx_commit=1` 才是真正的"双 1"配置，断电不丢。
- `binlog_format=ROW`：主从一致性的基础，也是 CDC 的前提。
- `binlog_expire_logs_seconds`：binlog 保留时长，**必须大于最长的从库断线恢复时间 + 备份周期**。

看一眼 binlog 里到底记了什么：

```bash
mysqlbinlog --base64-output=DECODE-ROWS -v mysql-bin.000123 | head -40
# -v 解码 ROW 格式的行事件；输出里能看到 @@server_id、gtid、
# ### UPDATE ### / ### INSERT ### 和每行的前后镜像（@1=5, @2='张三'...）
# 这就是 Canal/CDC 消费的原始数据，也是"binlog 记哪行变成了什么"的字面含义
```

两个用途：**主从复制**和 **CDC**。

```text
主库 dump 线程发出 binlog
   ↓
从库 IO 线程：原样接收，写成 relay log（不解码，只搬运）
   ↓
从库 SQL 线程：解析 relay log → 还原成行变更事件 → 执行
```

```text
MySQL 主库
  │ binlog dump（Canal 伪装成从库）
  ▼
Canal Server：二进制 binlog → 结构化行变更事件（表名、操作、前后镜像、位点）
  ▼
Kafka：变更消息进 topic
  ▼
下游：同步程序写 ES / 刷 Redis / 写其他库；Flink 做实时计算
```

### 两阶段提交：redo 与 binlog 的一致性

提交时：redo 进入 prepare → 写 binlog 并落盘 → redo 改为 commit。

崩溃恢复的裁决规则：redo 处于 prepare 且 binlog 完整 → 提交；binlog 不完整 → 回滚。如果没有两阶段提交，先写 redo 后写 binlog，崩溃时可能主库有新数据、binlog 没有，从库和备份就永远缺这一笔——主从数据分叉。

**运维推论**：`sync_binlog=0` 或 `innodb_flush_log_at_trx_commit=2` 的性能收益，换的是崩溃时的一致性风险。生产库没有理由不用双 1；如果确实要压测极限吞吐，也必须清楚自己在拿什么换。把一次提交完整拆开：

```sql
SET GLOBAL innodb_flush_log_at_trx_commit = 1;   -- redo 每次提交 fsync
SET GLOBAL sync_binlog = 1;                      -- binlog 每次提交 fsync —— 即"双 1"

START TRANSACTION;
UPDATE accounts SET balance = balance - 100 WHERE id = 1;
-- 底层：写 undo（反向"加回 100"）→ 改 Buffer Pool 里的页（页变脏）→ redo 追加进 Log Buffer
COMMIT;
-- 底层：redo prepare → binlog 写盘并 fsync → redo commit（两阶段提交）→ 此刻才返回成功
-- 所以提交只付两份顺序写的代价；.ibd 里的页仍是旧值，崩了靠 redo 重放，主从一致靠 binlog
```

## 事务与隔离级别 【必掌握】

### MVCC 怎么实现

InnoDB 的 MVCC 由三部分组成：

1. **隐藏字段**：每行有 `DB_TRX_ID`（最后修改它的事务 ID）、`DB_ROLL_PTR`（指向 undo 回滚段）。
2. **undo 版本链**：每次修改都把旧版本写进 undo，回滚指针串成链。
3. **ReadView**：快照读时生成，记录当前活跃事务 ID 列表（`m_ids`）、最小活跃 ID、下一个待分配 ID。沿版本链找第一个"对当前 ReadView 可见"的版本。

**RC 与 RR 的唯一区别就在 ReadView 的生成时机**：RC 每次快照读都新建 ReadView，所以能看到别人已提交的新数据（不可重复读）；RR 在事务第一次快照读时生成并复用，整个事务看到同一份快照（可重复读）。两个会话走一遍：

```sql
-- 会话 A（默认 RR）
START TRANSACTION;
SELECT balance FROM accounts WHERE id = 1;   -- 1000，此刻生成 ReadView
-- 会话 B：UPDATE accounts SET balance = 0 WHERE id = 1; COMMIT;
SELECT balance FROM accounts WHERE id = 1;   -- 仍 1000：复用旧 ReadView，沿 undo 版本链取对它可见的旧版本
COMMIT;

-- 会话 A 改成 RC 重跑（SET SESSION transaction_isolation='READ-COMMITTED'）：
-- 每次 SELECT 都新建 ReadView → 第二次读到 0 —— 不可重复读就这样产生
```

### 隔离级别与幻读

| 级别 | 脏读 | 不可重复读 | 幻读 |
| --- | --- | --- | --- |
| 读未提交 RU | 会 | 会 | 会 |
| 读已提交 RC | 不会 | 会 | 会 |
| 可重复读 RR（默认） | 不会 | 不会 | 快照读不会，当前读靠 Next-Key Lock 解决 |
| 串行化 | 不会 | 不会 | 不会 |

MySQL 默认可重复读有其历史原因（早年 binlog 按语句复制，要求两次读一致）。如今 ROW 复制下这个绑定已解除，很多公司把默认降到 RC——**RC 没有间隙锁，锁范围小、并发高、死锁概率低**，这是互联网业务的常见选择。代价是同一事务内两次读可能不一致，必须靠业务保证。

**当前读 vs 快照读**是理解锁的前提：普通 `SELECT` 是快照读，走 MVCC 不加锁；`SELECT ... FOR UPDATE`、`UPDATE`、`DELETE`、`INSERT` 是当前读，读最新版本并加锁。

### 丢失更新：最常咬人的问题

两个事务同时读同一行、各自计算、后写覆盖先写。完整现场：

```sql
-- 会话 A：START TRANSACTION; SELECT balance FROM accounts WHERE id = 1;  -- 读到 1000
-- 会话 B：START TRANSACTION; SELECT balance FROM accounts WHERE id = 1;  -- 也读到 1000
-- 会话 A：UPDATE accounts SET balance = 900 WHERE id = 1; COMMIT;        -- 扣款 100 成功
-- 会话 B：UPDATE accounts SET balance = 900 WHERE id = 1; COMMIT;        -- 覆盖掉 A 的扣款——丢失更新
```

解法三选一，能原子就原子：

- **悲观锁**：`SELECT ... FOR UPDATE` 先把行锁住，事务结束才释放。
- **乐观锁**：加版本号 `UPDATE ... SET v=v+1, version=version+1 WHERE id=? AND version=?`，影响行数为 0 就重试。
- **原子更新**：`UPDATE ... SET balance = balance - 100 WHERE id=? AND balance >= 100`，把"读改写"压成一条语句，由数据库串行化。底层：InnoDB 对这行加 X 锁后原地计算，后到的更新只能排队——覆盖问题在引擎内部就解决了，不给应用犯错的机会。能原子就优先原子，最简单也最可靠。

凡是代码里"先查出来、改字段、再存回去"的写法，都该过一遍这个问题。

## 锁：行锁、间隙锁与 DDL 【必掌握】

### 全局锁、表锁、MDL

- **全局锁** `FLUSH TABLES WITH READ LOCK`（FTWRL）：整库只读，逻辑备份的旧方案，现在用 XtraBackup 不需要。
- **表锁**：`LOCK TABLES ... READ/WRITE`，MyISAM 时代的产物，InnoDB 下基本不用。
- **MDL（元数据锁）**：MySQL 5.5+ 自动加，**每个 DML 操作都会给表加 MDL 读锁，DDL 要加 MDL 写锁**。坑在这里：一个长事务没提交，它持有的 MDL 读锁就一直不放，后面的 DDL 排队等写锁，而 DDL 后面的所有查询又排在 DDL 后面——**一条 DDL 堵死整张表**。这是线上最典型的"改表导致全站卡死"。完整复现：

```sql
-- 会话 A（忘了提交的长事务）
START TRANSACTION;
SELECT * FROM orders WHERE user_id = 1;   -- 拿到 orders 的 MDL 读锁，不提交就一直持有

-- 会话 B（DBA 改表）
ALTER TABLE orders ADD COLUMN remark VARCHAR(255);
-- 要 MDL 写锁 → 卡住等 A；同时 B 之后的所有 SELECT 也要 MDL 读锁 → 全排在 B 后面

-- 会话 C（业务查询，无辜被堵）
SELECT * FROM orders WHERE order_id = 100;   -- 卡住：排在 B 的写锁后面

-- 排查：谁在堵 DDL
SELECT * FROM information_schema.metadata_lock_waits;   -- 8.0：谁在等谁的 MDL
SHOW PROCESSLIST;   -- 状态列显示 "Waiting for table metadata lock" 的全是受害者
-- 处置：找到会话 A 的线程，KILL 之，DDL 立刻继续，后面排队的全部放行
```

MDL 不释放是"按事务"的：**只要 A 不提交或不回滚，锁就一直在**——所以问题的根子永远是长事务，DDL 只是撞上来的那个。

### 行锁的三种形态

InnoDB 行锁挂在**索引**上，锁的是"通过索引找到的记录"：

- **Record Lock**：锁单条索引记录，`WHERE id=5` 走唯一索引时就是它。
- **Gap Lock**：锁索引记录之间的间隙，防止插入，只在 RR 下生效。
- **Next-Key Lock**：Record + 前面的 Gap，左开右闭区间，RR 下范围查询的默认形态。

结论：**WHERE 没走索引时，引擎只能边扫边锁，扫过多少锁多少，并发下约等于锁全表**。"UPDATE 必须走索引"不是性能洁癖，是锁粒度问题——这是生产上锁等待暴增最常见的原因。

RC 隔离级别下除唯一性检查和外键外不加 Gap Lock，所以 RC 的锁范围小得多。

行锁到底锁什么，一组对比看清楚（同一张 `users`，100 万行）：

```sql
-- 场景一：WHERE 走主键——只锁一行
-- 会话 A：BEGIN; UPDATE users SET age = 30 WHERE id = 5;
-- 会话 B：UPDATE users SET age = 31 WHERE id = 6;   -- 秒回，锁的是 id=5 这一条索引记录

-- 场景二：WHERE 不走索引——边扫边锁，约等于锁全表
-- 会话 A：BEGIN; UPDATE users SET age = 30 WHERE name = '张三';   -- name 无索引
-- 会话 B：UPDATE users SET age = 31 WHERE id = 6;   -- 卡住！A 扫全表时把 B也要改的行锁了

-- 观察锁的最小单位（8.0）
SELECT * FROM performance_schema.data_locks;
-- object_name=users, index_name=PRIMARY, record=... → 锁挂在索引记录上，不是"行"这个抽象概念
```

底层一句话：**InnoDB 没有"行锁"，只有"索引记录锁"**——UPDATE 走 `id=5` 就锁主键树里那条记录；不走索引就没法定位，只能把扫过的每条记录都锁上。

### 死锁一：交叉更新（AB-BA）

最经典的一类。两个事务按相反顺序更新两行：

```text
事务 A: UPDATE accounts SET ... WHERE id=1;   -- 持有 id=1 的行锁
事务 B: UPDATE accounts SET ... WHERE id=2;   -- 持有 id=2 的行锁
事务 A: UPDATE accounts SET ... WHERE id=2;   -- 等 B
事务 B: UPDATE accounts SET ... WHERE id=1;   -- 等 A → 成环，死锁
```

InnoDB 检测到环后立刻回滚代价小的一方，报 `Deadlock found when trying to get lock`。生产上的典型场景：**批量转账/批处理任务没有约定加锁顺序**，并发跑两个批次就死锁。

解法：

- **约定全局加锁顺序**：批量操作按主键从小到大处理，从源头消灭环。这是最有效的办法。
- **拆小事务**：大事务持有锁时间长，更容易撞上。
- **应用侧重试**：死锁是正常现象，捕获错误码 1213 后重试（带随机退避），不要当成 bug 上报。
- 必要时降 RC 减少间隙锁参与。

### 死锁二：间隙锁 / 插入意向锁冲突

RR 隔离级别下，`UPDATE ... WHERE age=25`（age 无索引或非唯一索引）会锁住整个范围甚至全表间隙。两个事务各自持有一个间隙锁，然后都想插入同一个间隙：

```text
事务 A: SELECT * FROM t WHERE age BETWEEN 20 AND 30 FOR UPDATE;  -- 锁住间隙
事务 B: SELECT * FROM t WHERE age BETWEEN 20 AND 30 FOR UPDATE;  -- 也拿到间隙锁（间隙锁之间不互斥）
事务 A: INSERT INTO t(age) VALUES(25);  -- 插入意向锁，等 B 的间隙锁
事务 B: INSERT INTO t(age) VALUES(26);  -- 插入意向锁，等 A 的间隙锁 → 死锁
```

另一条高频路径是**唯一键冲突**：并发 `INSERT ... ON DUPLICATE KEY UPDATE` 或 `INSERT IGNORE` 同一批唯一键，先拿 S 锁再升级 X 锁，互相等待。还有 `REPLACE INTO` 在唯一索引冲突时的锁升级。

解法：

- **能用 RC 就用 RC**：没有间隙锁，第二类死锁基本消失。
- **避免无索引条件的大范围 UPDATE**：这是间隙锁死锁的温床。
- 唯一键冲突场景：改为"先查后插 + 捕获唯一键异常重试"，或串行化同一业务键的写入。
- 监控 `Innodb_deadlocks`，定期拉 `SHOW ENGINE INNODB STATUS` 的 `LATEST DETECTED DEADLOCK` 段分析。

### 死锁的检测与取舍

- `innodb_deadlock_detect=ON`（默认）：实时检测环，立刻回滚一方，代价是每次加锁都要做环检测，高并发下 CPU 开销可观。
- 关掉检测后靠 `innodb_lock_wait_timeout`（默认 50 秒）兜底——不推荐，等于把死锁变成慢等待。
- 超高并发热点行场景（如秒杀扣库存），关检测 + 短超时是一种极端取舍，但更该做的是把热点行拆开（库存分段）或改用 Redis 预扣。

### 排查手段

```sql
-- 当前事务与锁等待
SELECT * FROM information_schema.innodb_trx ORDER BY trx_started;
SELECT * FROM performance_schema.data_locks;      -- 8.0
SELECT * FROM performance_schema.data_waits;      -- 8.0 谁等谁
SHOW ENGINE INNODB STATUS\G                       -- 最近一次死锁现场
```

`SHOW ENGINE INNODB STATUS` 只看 `LATEST DETECTED DEADLOCK` 段，里面逐行列出两个事务各自持有什么锁、在等什么锁：

```text
*** (1) TRANSACTION: ... UPDATE accounts WHERE id=2      ← A 正在等的语句
*** (1) WAITING FOR THIS LOCK TO BE GRANTED: RECORD LOCK ... id=2
*** (2) TRANSACTION: ... UPDATE accounts WHERE id=1      ← B 正在等的语句
*** (2) WE HOLDS: RECORD LOCK ... id=1
-- 读法：A 等 id=2、B 等 id=1，而两条锁都已互持 → 成环，谁被 rollback 看 (2) TRANSACTION ... rolled back
-- 拿到"哪两条 SQL、哪两行"就能直接去改代码里的加锁顺序
```

线上处置顺序：找到持锁最长的事务 → 确认是否可 kill → `KILL <thread_id>` 止血 → 再分析 SQL 和索引。

## 一个写请求的完整链路 【必掌握】

以 `UPDATE users SET age = 21 WHERE id = 5;` 串起所有机制：

1. **连接器**：从连接池复用，只做权限确认。
2. **Server 层**：分析器解析，优化器发现 id 是主键、走聚簇索引，执行器拿计划。
3. **定位页**：B+ 树上找到叶子页，在 Buffer Pool 直接用，不在则从 `.ibd` 读入。
4. **加锁**：对 id=5 的索引记录加 X 锁（当前读）。
5. **写内存**：页内 age 从 20 改为 21，页变脏；同时写 undo（反向"改回 20"）。
6. **写 redo**：记入 Log Buffer；提交时按 `innodb_flush_log_at_trx_commit` fsync 到 redo 文件。
7. **两阶段提交**：redo prepare → binlog 落盘 → redo commit，客户端收到成功。
8. **此刻磁盘**：只有 redo 和 binlog 是新的，`.ibd` 还是旧值，脏页留在内存。
9. **后台刷脏**：Page Cleaner 按 checkpoint 节奏写回 `.ibd`。
10. **分发**：dump 线程把 binlog 推给从库和 Canal。

看懂这条链，所有结论各就各位：提交快因为只顺序写两份日志；断电不丢因为 redo/binlog 已落盘；数据页敢慢刷因为 redo 兜底；长事务危险因为 undo 版本链和 MDL 都被拖住。

## 慢查询治理 【必掌握】

慢查询难防的根源：SQL 是逻辑描述，快不快取决于优化器估算出的执行路径，估算错了就慢。所以排查顺序不是"上来加索引"，而是**找出最贵的 → 看它为什么走错路 → 纠正原因**。

### 第一步：把慢 SQL 捞出来

```ini
slow_query_log = ON
long_query_time = 1                  # 超过 1 秒记录，按业务 SLA 定
log_queries_not_using_indexes = ON   # 记录未走索引的（小表也会刷屏，慎开）
log_slow_admin_statements = ON
```

大库必上 `pt-query-digest` 做聚合分析：按"总耗时 = 次数 × 单次耗时"排序，**先治总耗时最高的，而不是单次最慢的**——一条 0.5 秒执行 10 万次的 SQL，危害远大于一条 10 秒执行 1 次的。

```bash
pt-query-digest /var/lib/mysql/*.slow.log > report.txt
# 输出三个关键段：Profile（按总耗时排序的 Top 10）、Header（整体统计）、每条 SQL 的
# 频次/平均耗时/扫描行数。先看 Profile 第一名，那就是本周的治理目标
```

### 第二步：看执行计划

`EXPLAIN` 的概念和四列读法见索引一章的"用 EXPLAIN 验证索引"，这里只对号入座到四类慢因：

### 四类慢因与对应解法

| 慢因 | 表现 | 解法 |
| --- | --- | --- |
| 无路可走 | type=ALL，key=NULL | 建索引；检查索引失效（函数、隐式转换、前导模糊、OR） |
| 有路估错 | rows 估算与实际差几个数量级 | `ANALYZE TABLE` 刷新统计信息；检查是否索引选择性问题 |
| 内存不够 | 时快时慢，排序/临时表溢出磁盘 | 调 `sort_buffer_size`、`tmp_table_size`；优先改 SQL 去掉排序 |
| 深分页 | `LIMIT 100000, 20` 越翻越慢 | 游标翻页（记住上页最大 id）；或延迟关联 |

深分页的两种写法：

```sql
-- 差：扫 100020 行扔掉 100000 行
SELECT * FROM orders ORDER BY id LIMIT 100000, 20;

-- 好一：游标翻页，代价与页深无关
SELECT * FROM orders WHERE id > 100000 ORDER BY id LIMIT 20;

-- 好二：延迟关联，先在索引上分页再回表
SELECT o.* FROM orders o
JOIN (SELECT id FROM orders ORDER BY id LIMIT 100000, 20) t ON o.id = t.id;
```

### 统计信息与优化器

优化器靠统计信息（索引基数 `cardinality`、数据分布）估算成本。`innodb_stats_persistent=ON` 时统计信息持久化，但大表在大量增删后仍会失真，表现为"昨天还好好的 SQL 今天走了全表扫"。处置：`ANALYZE TABLE` 手动刷新，或调整 `innodb_stats_auto_recalc`。MySQL 8.0 支持直方图（`ANALYZE TABLE ... UPDATE HISTOGRAM ON col`），对数据倾斜的列（状态、城市）效果明显。

```sql
-- 看优化器眼里这张表的"印象"：rows 是估算行数，cardinality 是索引区分度
SHOW TABLE STATUS LIKE 'orders'\G
SELECT * FROM information_schema.STATISTICS WHERE table_name = 'orders';

-- 印象失真（刚灌了 500 万行还没触发自动重算）就手动刷新
ANALYZE TABLE orders;
-- 底层：重采样叶子页更新统计信息，秒级完成、不锁表；之后优化器重新算成本，
-- 原本被误判成"全表扫更便宜"的 SQL 会自己走回索引
```

## 集群模式与高可用 【必掌握】

单机 MySQL 三个天花板：**容量**（数据/索引超过单盘）、**写入吞吐**（单主 fsync 上限）、**可用性**（主机挂了就没了）。集群解决的顺序也是这个顺序——先高可用，再容量和吞吐。

### 异步主从：一切的基础

主库把 binlog 推给从库，从库重放。三个线程：主库 dump 线程、从库 IO 线程（写 relay log）、从库 SQL 线程（重放）。

**异步复制的本质缺陷**：主库提交即返回，不等从库确认。主库宕机瞬间，未传出的 binlog 直接丢失——这是 RPO > 0 的来源。

复制延迟的来源要能背出来：

- 大事务（一次删百万行）要整段重放完才可见；
- 从库 SQL 线程单线程重放（并行复制可解，见下）；
- 从库硬件弱于主库、或从库还在跑报表；
- 无主键表的 ROW 复制，从库重放要全表扫描，一条 UPDATE 能卡几小时；
- 网络抖动、大表 DDL。

**并行复制**：5.6 按库并行，5.7 基于组提交（`slave_parallel_type=LOGICAL_CLOCK`），8.0 基于 write set（`binlog_transaction_dependency_tracking=WRITESET`）——按"事务修改的行是否冲突"并行重放，冲突的才串行，是效果最好的一档。前提是主库 `binlog_format=ROW`、表有主键。

**复制格式与参数基线**：`binlog_format=ROW`、`binlog_row_image=FULL`（CDC 需要前镜像）、`gtid_mode=ON`（切换的基础，不再依赖 binlog 文件名+位点）、`log_slave_updates=ON`（级联复制和切换必需）。

一套最小可用的搭建与验证：

```sql
-- 主库：开 GTID、建复制账号
SET GLOBAL gtid_mode = ON;
CREATE USER 'repl'@'%' IDENTIFIED BY 'StrongPass123';
GRANT REPLICATION SLAVE ON *.* TO 'repl'@'%';

-- 从库：指向主库（8.0 语法，SOURCE_* 取代了 MASTER_*）
CHANGE REPLICATION SOURCE TO
  SOURCE_HOST = '10.0.0.11', SOURCE_USER = 'repl', SOURCE_PASSWORD = 'StrongPass123',
  SOURCE_AUTO_POSITION = 1;    -- GTID 自动找位点，不再手工记 mysql-bin.000003:154
START REPLICA;

-- 验证：两个 Running 都是 Yes 才算通，延迟看 Seconds_Behind_Source
SHOW REPLICA STATUS\G
```

底层对应开头那张三线程图：`SOURCE_AUTO_POSITION=1` 让从库把自己已执行的 GTID 集合报给主库，主库 dump 线程从差集开始发——断线重连、切换主库都靠这个机制，不再依赖"文件名+偏移量"这种易错的人工记法。

### 半同步复制：把 RPO 压到 0

`rpl_semi_sync_master_enabled` 打开后，主库提交事务要等至少一个从库确认收到 binlog 才返回。两种模式：

- `AFTER_COMMIT`（5.7 默认）：主库先提交，等确认。主库故障时客户端已收到成功的写可能丢失。
- `AFTER_SYNC`（8.0 推荐）：主库先等确认再提交，**无损复制**，RPO=0。

代价：从库全部失联时，主库在 `rpl_semi_sync_master_timeout`（默认 10 秒）后**降级为异步**继续写——可用性优先，这是半同步的隐藏妥协。严格无损要配合 `rpl_semi_sync_master_wait_for_slave_count=1` 并接受写阻塞。

开关与验证：

```sql
-- 主库（8.0 插件名从 master 改叫 source）
INSTALL PLUGIN rpl_semi_sync_master SONAME 'semisync_master.so';
SET GLOBAL rpl_semi_sync_master_enabled = 1;
SET GLOBAL rpl_semi_sync_master_timeout = 3000;   -- 从库 3 秒没确认就降级，别用默认 10 秒

-- 验证是否真在等从库：Rpl_semi_sync_master_tx_yes 应随提交增长
SHOW STATUS LIKE 'Rpl_semi_sync_master%';
```

底层：提交路径从"写完 binlog 就返回"变成"写完 binlog → 等某个从库回 ACK → 才返回"，多出来的一段就是网络 RTT——这就是写延迟上升的全部原因，也是 RPO=0 的全部成本。

### MGR：MySQL 原生组复制

MySQL 5.7.17 引入的官方高可用方案，基于 Paxos 变体（XCom）：

- 3 或 5 个节点组成组，**多数派可用**，少数派分区自动停止写入（防脑裂）。
- 事务在组内认证（certify）后广播，多数派确认即提交——**强一致**，RPO=0。
- 支持单主模式（默认，一个 PRIMARY 多个 SECONDARY）和多主模式（冲突检测，写冲突会回滚）。
- 内建故障检测与自动选主，不需要外部仲裁组件。
- InnoDB Cluster = MGR + MySQL Shell（部署管理）+ MySQL Router（读写路由）。

代价：**写放大**——每个事务要发到所有节点认证；网络延迟直接计入提交延迟，跨可用区部署时比单机慢一个量级；节点数建议 3/5，2 节点没有容错意义。

```sql
-- 8.0 上把三台机器组成一个组（单主模式），逐台执行
SET PERSIST group_replication_group_name = '3e6c9...-uuid';
SET PERSIST group_replication_local_address = '10.0.0.11:33061';   -- 专用组通信端口，不是 SQL 端口
SET PERSIST group_replication_group_seeds = '10.0.0.11:33061,10.0.0.12:33061,10.0.0.13:33061';
START GROUP_REPLICATION;

-- 验证：MemberState 必须是 ONLINE，PRIMARY 只有一个
SELECT * FROM performance_schema.replication_group_members;
```

底层：所有写先在组内广播、拿到多数派（2/3）投票才返回——所以**任一节点宕机不丢已提交事务（RPO=0）**，但也意味着提交延迟 = 最慢的那次网络往返，这就是写放大的来源。

### PXC / Galera：同步多主

Percona XtraDB Cluster 基于 Galera，也是同步复制、多数派提交：

- 写可以在任意节点发起（多主），适合读多写少、需要就近写的场景。
- 认证在提交时做，冲突的事务直接失败（报 deadlock），应用必须能重试。
- 代价与 MGR 类似：写放大、对网络敏感、大事务会拖慢整个集群（流控 `flow_control` 频繁触发）。
- DDL 是"全节点同步执行"，大表改结构风险高。

### 选型对比

| 方案 | 一致性 / RPO | 自动切换 | 写性能 | 复杂度 | 适用 |
| --- | --- | --- | --- | --- | --- |
| 异步主从 | 弱，RPO>0 | 需 Orchestrator/MHA | 最高 | 低 | 大多数业务默认，能接受秒级丢失 |
| 半同步 | 强（AFTER_SYNC） | 需外部组件 | 中 | 中 | 金融、账务 |
| MGR | 强，RPO=0 | 内建 | 中低（写放大） | 中高 | 需要官方高可用、单主多从 |
| PXC | 强，RPO=0 | 内建 | 低（多主冲突回滚） | 高 | 多主写入、中小集群 |

**生产落点**：绝大多数业务用"异步主从 + Orchestrator 自动切换"就够；有 RPO=0 诉求上 MGR 或半同步；PXC 适合特定多主场景，但运维复杂度高，新项目一般优先 MGR。

### 切换与脑裂：比选型更重要的是纪律

自动切换的危险不在"提升从库"，而在两个裁决：**旧主真的死了吗**（网络分区下它可能还活着）和**什么时候切**（切早了误伤，切错了脑裂）。

脑裂后果：旧主和新主同时接受写入，数据永久分叉且无法自动合并。所以所有方案的守则都一样——**先确认旧主下线（关机/断网/fencing），再提升新主**。MGR 靠多数派投票天然防脑裂；传统主从靠 Orchestrator 的共识 + 外部 fencing。

应用侧配套：**永远只连 VIP / Service / Proxy，不写死实例地址**。切换换的是入口指向，应用无感——这一条是所有自动切换能落地的前提。

### K8s 上跑 MySQL

- **载体只能是 StatefulSet**：稳定网络标识、独立 PVC、有序启停。Deployment 的 Pod 是无名可替换的，对数据库意味着卷和身份对不上。
- **生产上高可用用 Operator**：Oracle MySQL Operator、Percona Operator for MySQL（PXC 或 PS + Orchestrator）、Vitess Operator。Operator 托管部署、备份、failover、扩缩容，手搓的价值是出事时你知道 Operator 在替你做什么。
- **存储必须块存储**（云盘 / Ceph RBD），不能 NFS——fsync 语义不可靠，断电可能丢已提交事务。
- **资源账**：buffer pool + 连接内存 < memory limit，request=limit 站进 Guaranteed 等级，避免节点压力时被驱逐。
- **升级节奏人工控制**：先重启从库、切换、最后重启旧主，绝不交给滚动更新自动编排。
- **探针宁松勿紧**：大库 crash recovery 可能几分钟，激进的 liveness 会反复杀进程导致永远起不来；readiness 只管流量。

## 分库分表 【必掌握】

### 先问：真的需要拆吗

拆分的代价是分布式事务、跨库 join、跨分片分页、扩容迁移、运维复杂度全面上升。所以顺序永远是：**索引优化 → 读写分离 → 冷热归档 → 分区表 → 才轮到分库分表**。

触发信号（按优先级）：

- 单表数据量超过几千万且持续增长，索引深度增加、DDL 无法承受；
- 单库磁盘或连接数到顶；
- 写入 QPS 超过单主 fsync 能力（通常几千 TPS 量级，视硬件和事务大小）；
- 业务天然可按用户/租户切分。

分区表（Partitioning）是中间选项：逻辑一张表、物理多个文件，适合按时间归档的场景，但跨分区查询和全局唯一索引受限，不能替代分库分表。

```sql
-- 按月分区的订单表：一张逻辑表，12 个 .ibd 分区文件
CREATE TABLE orders (
  id BIGINT UNSIGNED NOT NULL,
  create_time DATETIME NOT NULL,
  PRIMARY KEY (id, create_time)          -- 分区键必须进主键（全局唯一要靠它）
) PARTITION BY RANGE (TO_DAYS(create_time)) (
  PARTITION p202610 VALUES LESS THAN (TO_DAYS('2026-11-01')),
  PARTITION p202611 VALUES LESS THAN (TO_DAYS('2026-12-01')),
  PARTITION pmax     VALUES LESS THAN MAXVALUE
);

-- 好处一：分区裁剪——EXPLAIN 里 Partitions 列只命中 p202611，直接跳过其他分区文件
EXPLAIN SELECT * FROM orders WHERE create_time >= '2026-11-01' AND create_time < '2026-12-01';
-- 好处二：归档即换分区——DETACH/ADD PARTITION 秒级完成，不扫表
ALTER TABLE orders DROP PARTITION p202610;   -- 底层：直接删 .ibd 文件，不走 DDL 重建
```

代价与边界：没有分区的列上查询照样全表扫；`ALTER TABLE ... ADD PARTITION` 对已是 RANGE 的表很快，但跨分区的唯一索引必须包含分区键。

### 垂直拆分与水平拆分

- **垂直拆库**：按业务域拆（用户库、订单库、商品库），本质是微服务化的数据侧配套，降低单库压力、隔离故障。
- **垂直拆表**：把大字段（text、blob）、低频字段拆到扩展表，让主表行更短、单页装更多行、buffer pool 效率更高。这个收益常被低估。
- **水平拆表**：按行拆，同一张表的数据分散到多个库/表。这是通常说的"分库分表"。

水平拆分的路由方式：

| 方式 | 规则 | 优点 | 缺点 |
| --- | --- | --- | --- |
| Range | 按 id 区间或时间 | 范围查询友好、扩容简单（加新段） | 热点集中在新段 |
| Hash 取模 | `id % N` | 数据均匀 | 扩容需全量迁移（N 变化） |
| 一致性哈希 | 哈希环 | 扩容只迁移部分数据 | 实现复杂、可能不均 |
| 双倍扩容 | 2N 分片 | 迁移量可控（一半数据） | 需提前规划 |

工程上最常见的是 **hash 取模 + 成倍扩容**，或**按用户 ID 哈希 + 提前预留足够分片**（如 1024 个逻辑分片映射到少量物理库，扩容只改映射）。

### 分片键：最重要的设计决策

- **必须让高频查询带上分片键**，否则请求要广播到所有分片再聚合——这是分库分表后最大的性能陷阱。
- 订单表按 `user_id` 分片，则"用户查订单"高效，但"商家查订单"要另建一份按 `merchant_id` 分片的冗余表（异构索引表），靠 binlog 同步。
- 分片键要分布均匀，不能选状态、地区这类倾斜字段。
- 上线后修改分片键的代价接近重建，务必先想清楚。

分片键的影响用一对查询看（订单表按 `user_id` 分 16 片，中间件 ShardingSphere-JDBC）：

```sql
-- ✅ 带分片键：user_id % 16 = 5，只路由到 shard_5，一次索引查询
SELECT * FROM orders WHERE user_id = 10086 AND create_time > '2026-11-01';

-- ❌ 不带分片键：广播 16 个分片 → 每片各查 200 条 → 中间件归并排序取前 20 条
SELECT * FROM orders WHERE merchant_id = 88 ORDER BY create_time DESC LIMIT 20;
-- 底层代价：16 倍 IO + 16 倍网络传输 + 中间件内存归并；分片数涨到 64 就是 64 倍
-- 所以商家查订单必须另建一张按 merchant_id 分片的冗余表，靠 binlog 同步
```

### 分布式 ID

自增主键在分库分表下失效（各库各自自增会冲突）。方案：

- **雪花算法（Snowflake）**：时间戳 + 机器 ID + 序列号，趋势递增、本地生成、性能高。坑在**时钟回拨**，要对机器 ID 做分配管理。
- **号段模式**（美团 Leaf、滴滴 TinyID）：数据库批量发号段，应用内存分配，性能好且不依赖时钟。
- **UUID**：绝对不要用作 InnoDB 主键——无序导致页分裂，前面讲过。

雪花 ID 拿到手能直接解出来（64 位有符号整数）：

```text
snowflake_id = 1 位符号 + 41 位毫秒时间戳 + 10 位机器 ID + 12 位序列号

例：id = 2236492348108109824
  → 时间戳 = (id >> 22) + 自定义纪元 ≈ 2026-11-27 10:15:32.108
  → 机器   = (id >> 12) & 0x3FF = 7     ← 分配给 7 号节点，出问题能定位到机器
  → 序列   = id & 0xFFF = 982            ← 同一毫秒内第 982 个 ID
```

趋势递增所以能当主键（追加写、少页分裂），但**不能当业务上可排序的时间**——时钟回拨的机器会发出"过去"的 ID。

### 跨分片的问题与解法

- **分页**：`LIMIT offset, n` 需要每个分片取 offset+n 条再归并，深分页不可行。解法是限制查询必须带分片键，或做"二次查询法"，或干脆禁用跨分片深分页。
- **聚合**：`COUNT/SUM/GROUP BY` 要下发到各分片再汇总，尽量在中间件层做掉，或走离线数仓。
- **join**：禁止跨库 join。解法是字段冗余（订单表冗余用户名）、异构索引表、或应用层组装。
- **分布式事务**：本地事务失效。强一致用 Seata AT/TCC（性能代价大），最终一致用**本地消息表 + 定时补偿**或 **RocketMQ 事务消息**——互联网业务的主流选择是最终一致，不是强一致。
- **全局唯一约束**：各分片的唯一索引只管自己，全局唯一要靠独立发号器或唯一性校验表。

### 中间件与落地

- **ShardingSphere-JDBC**：客户端模式，jar 包嵌入应用，无额外网络跳转，性能最好；缺点是绑定语言（Java）、升级要改应用。
- **ShardingSphere-Proxy**：独立代理，兼容 MySQL 协议，多语言可用；多一跳网络，代理层要自己做高可用。
- **Vitess**：YouTube 出品，K8s 原生，适合超大规模集群，运维复杂度高。
- **MyCat**：老一代代理，社区已不活跃，新项目不建议。

分库分表上线后，DDL 变成高危操作——要在每个分片执行、要保证一致。常用 gh-ost / pt-online-schema-change 做在线变更，配合统一的分片变更平台。

## 连接池与容量 【必掌握】

**为什么必须池化**：MySQL 每连接一线程，握手、认证、权限加载都是真实开销；连接数无节制增长会吃光内存和线程调度能力。池的本质是"少量真实连接 + 应用侧复用"。

**池不是越大越好**。总账 = 连接数 × 每连接内存，`max_connections` 打满时新连接直接报错。经验公式：

```text
连接数 ≈ CPU 核数 × 2 + 磁盘数
```

一个 8 核库配 20~30 个应用连接往往比配 200 个吞吐更高——连接多了，锁竞争和上下文切换反而拖慢。

**三个必须对齐的参数**：

- 应用池的 `maxLifetime` 要小于服务端 `wait_timeout`，否则拿到的是服务端已断开的死连接，报 `Communications link failure`。
- 池的 `minimumIdle` 不要太低，避免流量突增时大量新建连接。
- 服务端 `max_connections` 永远留余量给监控、备份和 DBA 登录——连接真打满时，你连诊断用的客户端都进不去。

**连接打满的排查**：

```sql
SHOW PROCESSLIST;   -- 看每条连接在干嘛：Sleep=空闲占坑，Query=正在执行，Locked=等锁
SELECT * FROM performance_schema.threads WHERE TYPE='FOREGROUND';
SELECT COUNT(*) FROM information_schema.processlist GROUP BY user, command;
```

典型现场与命令解读：

```text
mysql> SELECT count(*) FROM information_schema.processlist WHERE command='Sleep';
+----------+
| count(*) |
+----------+
|      198 |          ← 200 个连接里 198 条 Sleep：连接池配大了，不是查询慢
+----------+

mysql> SHOW PROCESSLIST;
| id | user | db   | command | time | state  | info |
| 21 | app  | shop | Query   | 302  | Sending data | SELECT ... WHERE age=25 |  ← 单条慢查询占了 5 分钟
```

`time` 列是关键：Sleep 很大 → 池开太多或泄漏；Query 的 time 很大 → 慢 SQL 占着连接。前者调池，后者治慢查询——**连接不够几乎从来不是连接数的问题**。

常见原因不是"连接不够"，而是慢查询占住连接不放、应用侧连接泄漏（忘了 close）、或事务未提交。

## 主从延迟与读写分离 【必掌握】

**为什么会有延迟**：复制是异步推送——主库提交成功就返回客户端，不等于从库已经收完并重放完。延迟来源是重放追不上写入：大事务、从库串行重放、网络抖动、从库硬件弱。

现场确认延迟在哪一环：

```sql
-- 主库：binlog 是否还在往外推（Position 一直在涨说明 IO 线程没断）
SHOW MASTER STATUS;

-- 从库：两个 Running + 秒数
SHOW REPLICA STATUS\G
-- Replica_IO_Running=Yes、Replica_SQL_Running=Yes 但 Seconds_Behind_Source 持续涨
--   → 不是断了，是 SQL 线程重放追不上，去主库查有没有大事务
-- Replica_IO_Running=No → 网络/账号问题，先修链路
```

**读写分离把延迟暴露给业务**：写完立刻读从库，可能读到旧值——"刚改完头像刷新还是旧的"这类工单多半是它。处理按场景分层：

- 能容忍旧值的（排行榜、列表页、历史查询）走从库；
- 不能容忍的（写后立刻读、支付结果、库存）强制走主库；
- 要彻底消除窗口用半同步（RPO=0），代价是写延迟上升。

工程实现上，**强制走主库**通常用注解或上下文标记（如 ShardingSphere 的 Hint），不要靠"延迟小于 X 秒就读从库"这类猜测——延迟是波动的，猜不准。

**一条边界必须记住**：复制不是备份。误删的数据会被原样同步到所有从库，恢复只能靠备份 + 日志回放。

## 备份与恢复 【必掌握】

### 四层备份，各管各的

| 层 | 手段 | 能恢复什么 | 代价 |
| --- | --- | --- | --- |
| 逻辑备份 | `mysqldump` | 单表、单库；可跨版本、可改结构 | 慢，大库小时级；恢复即重放 SQL |
| 物理备份 + 日志归档 | XtraBackup + binlog 归档 | **任意时间点（PITR）**、整实例 | 需持续归档，占对象存储 |
| 卷快照 | CSI VolumeSnapshot / 云盘快照 | 整卷，秒级，对业务影响小 | 一致性靠冻结，跨区受限 |
| K8s 资源 | Velero | 命名空间、工作负载、PVC、Secret | 不保证数据库内部一致性 |

分层用法：**日常误删靠 PITR，跨版本迁移用逻辑备份，卷级快速回滚用快照，集群灾难用 Velero**。四层不重叠，缺一层就有一种事故无解。

MySQL 侧的实操要点：

- `mysqldump --single-transaction` 用一致性快照，不锁表，但只对 InnoDB 有效；大库恢复是"重放 SQL"，慢到不可接受。
- **XtraBackup 是生产标准**：物理热备、不锁库、增量备份、支持流式传到对象存储。备份完要 `--prepare` 才能恢复。
- **PITR = 全量备份 + binlog 归档**：恢复到"误删前一秒"，靠 `mysqlbinlog --stop-datetime` 回放。binlog 保留时长必须覆盖备份周期。
- 从库备份可以减少主库压力，但要注意从库延迟导致的数据滞后。

一次完整的备份与"误删恢复"命令级示例：

```bash
# 1) 每天全量（走从库，主库零压力）
xtrabackup --backup --target-dir=/backup/full-$(date +%F) --host=slave1

# 2) 持续归档 binlog（保留 14 天，大于备份周期）
mysqlbinlog --read-from-remote-server --raw --stop-never repl@10.0.0.11 \
  --result-file=/backup/binlog/

# 3) 事故：14:05 误删了订单，恢复到 14:03:07（误删前一秒）
xtrabackup --prepare --target-dir=/backup/full-$(date -d yesterday +%F)
xtrabackup --copy-back --target-dir=/backup/full-$(date -d yesterday +%F)
mysqlbinlog --stop-datetime="2026-11-27 14:03:07" /backup/binlog/mysql-bin.000123 | mysql
```

`--prepare` 是 XtraBackup 特有的一步：备份拿到的是"当时各文件不一致的拷贝"，prepare 过程用 redo 把它推进到一致状态，才能 copy-back。缺了这步，恢复出来的库打不开。

### 几条不能省的纪律

- **备份必须演练**。没恢复过的备份等于没有备份——凭证过期、归档断档、备份文件是空壳，只有真恢复一次才暴露。至少季度一次，恢复到隔离环境验数据。
- **备份与数据分离**。不同盘、不同可用区、不同账号——集群级事故常常把存储一起带走。
- **复制不是备份**。一条 `DROP TABLE` 一秒内同步到所有从库。
- **必须答得出两个数**：RPO（最多丢多久数据，由归档频率决定）、RTO（恢复要多久，由备份方式和演练决定）。答不上，等于没有方案。

## 监控落地 【必掌握】

MySQL 走 exporter + Prometheus：

| | MySQL |
| --- | --- |
| exporter | `mysqld_exporter`（9104） |
| 采集方式 | `SHOW GLOBAL STATUS` / `VARIABLES` |
| 账号 | 只读监控账号 |

核心指标（每个都对应前文一种故障）：

```text
# 连接数水位：打满报 too many connections
mysql_global_status_threads_connected / mysql_global_variables_max_connections

# Buffer Pool 命中率：跌破 99% 说明随机读开始穿透磁盘
1 - mysql_global_status_innodb_buffer_pool_reads
  / mysql_global_status_innodb_buffer_pool_read_requests

# 主从延迟（版本不同前缀可能是 mysql_slave_status_ / mysql_replica_status_）
mysql_slave_status_seconds_behind_master

# 锁等待与死锁：突增说明有热点行或长事务
mysql_global_status_innodb_row_lock_waits
rate(mysql_global_status_innodb_deadlocks[5m])

# 长事务：undo 膨胀和 MDL 堵塞的源头，查 information_schema.innodb_trx
# 慢查询数：结合 slow_query_log 定位
```

告警排序按爆炸半径：**先接会让库停写的三条**——连接数打满、磁盘剩余天数、长事务堆积；**再接会让业务变慢的四条**——主从延迟、锁等待与死锁、Buffer Pool 命中率、慢查询数。阈值按自己的容量基线定，别抄网上的绝对值。

采集侧两个坑：exporter 自己也占一条连接，监控账号别配成超级用户；`information_schema` 的全表统计在大库上很贵，采集间隔别设太密。

## 一页纸总结 【必掌握】

- **架构**：Server 层 + InnoDB；数据在聚簇索引叶子里，二级索引要回表。
- **索引**：联合索引等值在前范围在后；覆盖索引免回表；函数/隐式转换/前导模糊会让索引失效；索引不是越多越好。
- **内存**：Buffer Pool 调到内存 50%~70% 且小于容器 limit；Change Buffer 只对普通索引有效。
- **日志**：undo 撑 MVCC 和回滚（长事务是噩梦）；redo 保 crash-safe（双 1 配置）；binlog 供复制和 CDC；两阶段提交保主从一致。
- **事务**：MVCC = 隐藏字段 + undo 版本链 + ReadView；RC 每次新建快照，RR 复用快照；RC 无间隙锁，并发更高。
- **锁**：行锁挂在索引上，没走索引约等于锁全表；MDL 会让 DDL 堵死全表。
- **死锁**：AB-BA 交叉更新靠固定加锁顺序；间隙锁/唯一键冲突靠 RC + 索引 + 重试；死锁是常态，应用必须有重试。
- **慢查询**：先按总耗时排序，再看执行计划，最后按四类慢因下药；`EXPLAIN ANALYZE` 看真实执行。
- **集群**：异步主从保可用、半同步保 RPO=0、MGR/PXC 强一致但有写放大；切换的核心是"先确认旧主死"，应用只连 VIP/Service。
- **分库分表**：先优化再拆；分片键决定一切；分布式 ID 用雪花/号段；跨分片 join 和分页要提前设计；最终一致靠消息表，不强求 2PC。
- **运维**：备份必演练、复制不是备份、监控按爆炸半径排序、K8s 上 StatefulSet + Operator + 块存储 + 资源账算平。
