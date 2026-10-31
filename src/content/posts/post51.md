---
title: 修正6条n8n沙箱逃逸样本的标注
published: 2026-10-31T20:11:23+08:00
description: 第一次完成了一个被别人认可的PR 😊
image: './images/a51.avif'
tags: [开源经历]
category: '计算机技术'
draft: false
lang: '中文'
---




背景介绍请见[issue](https://github.com/Tencent/VulnGym/issues/6)   [PR](https://github.com/Tencent/VulnGym/pull/54)

## 前置知识
### VulnGym是什么

[VulnGym](https://github.com/Tencent/VulnGym) 是腾讯悟空安全团队开源的一个**评测基准(Benchmark)**,用途很单纯:考 AI。

考什么?考那些"白盒漏洞检测 Agent"——也就是让 AI 拿到一份真实开源项目的源码,看它能不能自己找出里面藏的安全漏洞。你可以把它理解成**AI 挖漏洞界的"高考卷"**。

为什么需要一张新考卷?因为以前的漏洞评测集太"粗"了:

- 有的只给一个函数或一段 diff,让 AI 判断有没有问题——太简单,真实项目里漏洞往往横跨好几个文件;
- 有的只给"有漏洞/没漏洞"的二分类标签——AI 答对了,但你不知道它是真找到了,还是蒙对的。

VulnGym 的思路是把考题做细。整个数据集包含 **184 条安全公告(Advisory)、408 个漏洞入口(entry)**,每条 entry 都绑定一个真实项目的**特定漏洞版本**(`repo_url` + `commit`,可以 checkout 出来复现)。

而每条 entry 的"标准答案"由三部分组成:

| 字段 | 相当于考卷里的 |
|---|---|
| `entry_point` | 攻击者从哪里进来(外部可达入口) |
| `critical_operation` | 真正出问题的是哪一行(核心缺陷位置) |
| `trace` | 从入口到缺陷点的完整路径(跨模块推理链) |

评测时,AI 提交它找到的"入口 + 缺陷点",脚本拿去和标准答案比对(路径严格相等、行号误差 ≤5 行),匹配上了才算命中。所以这套标注必须**精确到行**——这就是它和"有/无漏洞"标签的本质区别。

那么问题来了:**标准答案本身是谁写的?**

答案是:大部分由 LLM 批量自动生成,每条 entry 有个 `verify` 字段标记状态——`1` 表示人工审计过,`0` 表示还是自动标注、没人确认过。截至 v0.1.4,408 条里还有一小撮没审计完。

自动生成的答案,难免会有"看着通顺、其实标错位置"的情况——比如把一个静态黑名单的定义行,当成了真正执行安全检查的缺陷点。而我的任务(也就是上面那个 issue),就是人工复核其中 **6 条 n8n 相关的样本**,把它们标错的地方修正过来。

接下来就讲讲这 6 条样本里,我发现的问题和我修的过程。

### n8n静态分析
n8n 允许用户在工作流里写 Python 脚本，而这脚本会在服务器上执行。用户是不可信的——万一有人写 删除所有文件 呢？所以 n8n 必须在执行前先审查这段代码。但问题来了：代码还没跑，怎么知道它危不危险？不能先跑跑看(跑了他已经得手了)，只能“看代码本身”——这就是静态分析：不运行，只检查代码文本。  
人看代码看的是字面，程序要精确理解代码得先把它拆解成结构——这就是语法树(AST)。类比语文课分析句子：  
```text
句子:"小明 打 篮球"  →  主语:小明 | 谓语:打 | 宾语:篮球
代码: "f.__globals__"  →  访问属性:对象 f | 属性名:__globals__
```
ast.parse() 把代码变成一棵树，树上的每个节点代表一个语法成分(变量、函数调用、属性访问……)。

**“遍历”**就是从树根开始，把每个节点都走一遍、一个不漏。n8n 的检查器(visit_Attribute)专门盯一种节点：属性访问(凡是代码里出现 某对象.某属性 的地方)。   
每看到一个属性访问节点，检查器就做一件事：  
```text
拿到属性名 → 拿去 BLOCKED_ATTRIBUTES(黑名单)里查 → 在?记违规 : 不在?放行
```

### webhook CSP绕过
6 条样本里另一类漏洞是"webhook CSP 绕过"(CVE-2026-25051)。先把它是什么讲清楚。

n8n 的 webhook 支持自定义 HTTP 响应:工作流作者可以自己指定响应头(headers)和响应体——n8n 会替你把任意 HTML 吐给访问这个 URL 的人。这就有个风险:万一有人在工作流响应体里塞一段 `<script>` 呢?任何打开该 URL 的用户,都会在 **n8n 自己的域名下**执行这段脚本,轻则弹窗,重则以他的身份操作整个 n8n 实例。

n8n 的防御是:如果响应是 HTML,就自动追加一个 **CSP sandbox** 响应头。CSP(Content Security Policy)是浏览器强制执行的安全指令,`sandbox` 相当于给页面套个笼子——里面的脚本不许运行。这样就算响应体里有恶意代码,浏览器也不执行。

那"是不是 HTML"怎么判断?靠这个函数(`packages/core/src/html-sandbox.ts`):

```typescript
export const isHtmlRenderedContentType = (contentType: string) => {
    const contentTypeLower = contentType.toLowerCase();
    return (
        contentTypeLower.startsWith('text/html') ||
        contentTypeLower.startsWith('application/xhtml+xml')
    );
};
```

看出问题了吗?它做了 `toLowerCase()`,**没做 `trim()`**(去首尾空白)。我实测过:

```text
content-type 的值: " text/html"        ← 开头藏一个空格
n8n 的检查:  " text/html".startsWith('text/html') → False  → "不是HTML,笼子不加了"
浏览器:      按 HTTP 规范,头部值允许带空白,浏览器解析时自己会 trim
             → "这是 text/html" → 照常渲染 HTML、执行脚本
```

**同一个字符串,n8n 和浏览器给出了相反的判断**:n8n 认为"不是 HTML 所以不设防",浏览器认为"是 HTML 所以照渲染"。防线就这样穿了个洞——这类漏洞有个专门的名字:**差异解析(parser differential)**:安全决策依赖两个组件对同一输入的理解一致,一旦不一致,检查就成了摆设。

完整攻击链:攻击者只需要一个**能编辑工作流的普通账号**——建一个 webhook 工作流,响应头设成带空格的 `" text/html"`,响应体塞恶意脚本,然后保存。恶意配置存在服务器上,之后**每个**打开这个 webhook URL 的用户(比如管理员)都会中招——这就是"存储型 XSS"里"存储"二字的含义。脚本以访问者身份在 n8n 域名下运行,官方 advisory 给出的后果是:会话劫持、账户接管(CVSS 8.5,High)。

修复也朴素:判断前加个 `.trim()`。但记住这个模式——**防御的成立,取决于你的解析和对方的解析一致**。这个思路在后面 review 标注时还会用到。

### Sanitizer

后面两节会反复出现一个词:Sanitizer(消毒器/净化器)。先把它讲明白。

安全领域里,sanitizer 指一类专门"清洗"不可信输入的组件:把危险的部分处理掉,让剩下的内容可以安全使用。最直观的例子是 HTML 消毒——用户可以在评论区输入 HTML,但不能让他插 `<script>`,于是:

```js
function sanitizeHtml(userInput) {
  return userInput.replace(/<script.*?>.*?<\/script>/gi, '');  // 把脚本挖掉
}
```

输入是"脏"的,经过 sanitizer 消毒,输出就是"干净"的——和食品消毒、净水器是同一个隐喻。

n8n 表达式沙箱里的 `PrototypeSanitizer` 消毒的对象更进一步:不是字符串,而是**代码的语法树**。用户表达式里的属性访问可能摸到 `.constructor`、`__proto__` 这些 JS 逃逸的经典跳板,所以它在编译前把语法树改写,在每个属性访问点包上一层运行时检查:

```text
改写前: obj.name
改写后: obj[this.__sanitize('name')]    ← 每次取属性都要先过一道安检
```

到这里,前面几类漏洞里的防御角色可以对齐了——它们都是"防御方":

| 组件 | 出现在 | 干什么 | 类比 |
|---|---|---|---|
| `BLOCKED_ATTRIBUTES` | Python 沙箱 | 存危险名单 | 违禁品清单 |
| `visit_Attribute` + 黑名单比对 | Python 沙箱 | 执行拦截 | 安检员 |
| `isHtmlRenderedContentType` | webhook | 判断要不要给响应"套笼子" | 门口的限高杆 |
| `PrototypeSanitizer` | 表达式沙箱 | 改写语法树、插入检查 | 流水线的消毒工序 |

记住这个区分:**sanitizer 是"防的手",而 `critical_operation` 要找的是"伤的手"**。接下来审计标注时,最常见的错误恰恰就是把防的手当成了伤的手——马上就能看到活例子。

### 表达式沙箱逃逸

"表达式沙箱逃逸"(CVE-2026-1470)。它和 Python Code 节点那类是近亲,但舞台换到了 n8n 的**表达式引擎**。

n8n 节点参数支持写表达式,比如 `={{ $json.name.toUpperCase() }}`——以 `=` 开头的参数会被当成 **JavaScript 代码在服务器上求值**。用户写的"配置"实际上是"代码",所以 n8n 给它配了沙箱,而且比 Python 那边的黑名单更进一步:表达式先被解析成 AST,防御钩子(如 `PrototypeSanitizer`)在编译前**改写语法树**,在每个属性访问点自动插入 sanitizer（净化器） 调用,运行时逐个检查"这个属性危不危险"。

结果它还是被逃逸了,而且有两条路(同一个 CVE 的两个入口):

**路径一:覆盖盲区。** `PrototypeSanitizer` 靠一组 `visit_XXX` 处理器覆盖各种 JS 语法节点,但漏写了 `with` 语句的处理器。攻击者用 `with(...)` 把函数对象的 `.constructor` 悄悄注入词法作用域——AST 遍历根本没走到这条路上,检查形同虚设。

**路径二:防御被"冒名顶替"。** 沙箱把 sanitizer 函数挂在数据对象上,键名是个公开常量 `__sanitize`。改写后的表达式里,每个属性访问都会包上 `__sanitize(...)` 调用。但键名人人可见,攻击者就在表达式里**声明一个同名局部变量遮蔽它**——运行时解析到的是攻击者的版本,官方 sanitizer 根本没被调用。

两条路的终点是同一个地方:`evaluateExpression`——逃逸后的表达式在这里被宿主引擎真正求值,任意代码落地(RCE)。

**路径一是不是很眼熟?** 和 Python 沙箱那边"`getattr` 动态访问不被 `visit_Attribute` 覆盖"是同一类病:**检查器只盯着它认识的东西,攻击者走它不认识的**。

### vm引擎逃逸

(CVE-2026-25049)还是这个表达式引擎——它的问题多到自己又占了一个 advisory。挑两条最有意思的说。

**一条:辅助函数 `extend()` 变成了后门。** 引擎给表达式提供了 `extend(fnName, ...args)` 辅助函数,可以按名字调用扩展函数——但对 `fnName` **不做任何校验**。更妙的是,求值前有个正则守卫专门拦截表达式里的 `.constructor` 字面量(原型链逃逸的经典跳板):

```typescript
const constructorValidation = new RegExp(/\\.\s*constructor/gm);
if (parameterValue.match(constructorValidation)) { throw ... }
```

但攻击者把 `'constructor'` 作为**字符串实参**传给 `extend('constructor', ...)`——源码里压根不出现 `.constructor` 点访问语法,正则永不命中。下游把 `'constructor'` 解析成了宿主的 `Function` 构造函数,然后:

```typescript
return foundFunction.function.apply(input, args);   // ← 攻击者的代码字符串在这里被执行
```

注意这个守卫的教训:**正则查的是"字面",攻击走的是"值"**——你盯着代码长什么样,攻击者给你的是什么。

**另一条:过滤函数的"插座"没上锁。** 前面说的 `__sanitize` 机制,编译期插的过滤调用,运行时都指向一个槽位。在表达式模块里,这个槽位是用 `Object.defineProperty(..., { writable: false })` 上的锁;但在 VM 运行时的 `reset.ts:46`,却是普通赋值:

```typescript
globalThis.__data.__sanitize = __sanitize;   // ← 没设不可写,沙箱内可触达、可替换
```

沙箱里的表达式把这个槽位替换成"原样返回"的恒等函数,上游编译期插入的**全部**过滤调用瞬间集体失效。

### entries.jsonl格式

看懂了静态分析的原理,再回头看我要修的数据长什么样。

VulnGym 的数据放在 `data/` 目录下,其中 `entries.jsonl` 就是存"标准答案"的文件:**408 行,每行是一条完整的样本(一个漏洞入口)**。

所谓 JSONL(JSON Lines),就是"每行一个独立 JSON 对象"的文本格式:

```text
第 1 行:  {"entry_id":"entry-00001", "project":"n8n", ...}
第 2 行:  {"entry_id":"entry-00002", "project":"n8n", ...}
...
第 408 行: {"entry_id":"entry-00408", "project":"...", ...}
```

每行字段不少,但按用途可以分成四组:

| 分组 | 字段 | 作用 |
|---|---|---|
| 定位漏洞 | `repo_url` + `commit` | 指向某开源项目"带漏洞的那个版本"的源码树,可以 checkout 出来复现 |
| 描述漏洞 | `vuln_title` / `vuln_category_l1/l2` / `vuln_ids` | 这是个什么洞、CVE 编号是多少 |
| **标准答案** | `entry_point` / `critical_operation` / `trace` |也就是前面的三件套 |
| 质量标记 | `verify` | `1`=人工审计过;`0`=自动生成、还没人确认 |

而 `entry_point`、`critical_operation` 以及 `trace` 里的每一步,都是同一个"四件套"结构:

```json
{
  "file": "packages/@n8n/task-runner-python/src/constants.py",
  "line": 126,
  "code": "BLOCKED_ATTRIBUTES = {",
  "desc": "这个位置在漏洞链路中的作用说明……"
}
```

- `file` + `line`:定位到仓库里某个文件的第几行;
- `code`:那一行的**原文快照**(逐字不改),让人不用翻源码就能核对"你说的位置长这样";
- `desc`:用自然语言解释这个位置和漏洞的关系。

这套格式是纯为机器设计的:一行一条,程序 `for line in file` 就能逐条处理;字段还按字母序排列,方便版本之间 diff。代价是——**人读起来非常痛苦**,这就是下一节要解决的问题。

### 人类如何读entries.jsonl
动手之前还有个小障碍。`entries.jsonl` 是 JSONL 格式——**每条样本压成一行**,408 条挤在一个文件里,一条就有几千个字符。直接打开看?就是一坨没有换行的字符串。

所以我先写了个十几行的小脚本(`pp.py`),把目标 entry 从数据集里"捞"出来,展开成能读的多行 JSON。核心就一行:

```python
print(json.dumps(e, ensure_ascii=False, indent=2))
```

`indent=2` 把挤成一行的 JSON 展开成带缩进的树;`ensure_ascii=False` 让中文正常显示(否则全是 `\u4e00\u6837` 的转义码)。之后 `python pp.py entry-00176` 就能单独看这一条。

工具虽小,但后面每一步核对标注、比对源码,都靠它先把数据变成人能看的样子。


## 第一个例子:一条把"清单"当成"安检员"的标注

6 条里最有代表性的是 `entry-00176`——n8n 的 Python Code 节点沙箱逃逸(CVE-2026-27494)。简单说:n8n 允许用户在自动化流程里写 Python 脚本,为了防止脚本干坏事,n8n 在执行前会用"静态分析"检查代码,把危险操作拦下来。攻击者找到了一个漏网之鱼——访问一个叫 `__objclass__` 的属性,绕过了检查,最终在服务器上执行任意代码。

先看原始标注把"核心缺陷位置"(`critical_operation`)标在了哪:

```json
"critical_operation": {
  "code": "BLOCKED_ATTRIBUTES = {",
  "file": "packages/@n8n/task-runner-python/src/constants.py",
  "line": 126
}
```

看起来有模有样:文件对、行号对、代码也对。但拿到源码一看,`constants.py` 第 126 行是一个黑名单集合的**定义**——列出了一批"不许访问的属性名"。它就是个静态数据,自己不会执行任何检查。

你可能会问:漏洞不就是因为黑名单缺了 `__objclass__` 吗?标黑名单怎么就错了?这里要区分两件事:**漏洞的成因**和**漏洞发生的现场**。名单少个名字只是"原因";而程序运行时,那行定义只在启动时执行一次、造完名单就退场,之后**每一次**"拿属性名查名单、决定拦还是放"的动作,都发生在 `task_analyzer.py` 的那个 `if` 判断里——`__objclass__` 没被拦住,放行的正是那一行。`critical_operation` 要的是**事故现场**(核心缺陷位置),不是原因清单;就像事故报告要写"事故发生在哪",而不是"隐患来自哪本手册"。

### 我的修正步骤

**第一步:先理解漏洞在说什么。** 读 advisory 和标注,搞清楚触发条件:沙箱靠"遍历代码语法树 + 比对黑名单"来拦截危险属性访问,而 `__objclass__` 不在黑名单里,所以没被拦住。

**第二步:对每个字段问一个灵魂问题。** 标注里的每一行代码,都要问:"它自己会执行安全决策吗?" `BLOCKED_ATTRIBUTES = {` 显然不会——它只是数据。真正做决策的是**拿名字去黑名单里比对的那行代码**。

**第三步:checkout 到漏洞版本的源码,找真实施力点。** 用标注里的 `repo_url` + `commit` 拉出当时的代码,在 `task_analyzer.py` 里找到了它:

```python
def visit_Attribute(self, node: ast.Attribute) -> None:
    if node.attr in BLOCKED_ATTRIBUTES:   # ← 安检员在这里
        self._add_violation(...)
```

命中黑名单 → 记违规;不在 → 放行。漏洞的"绕过"就发生在这个判断没拦住 `__objclass__` 的时刻。**这才是核心缺陷位置。**

**第三步的幕后:这个文件是怎么找到的?**

说实话,这次找起来不算难——线索就在原标注自己身上:`trace` 的第 6 步已经把 `task_analyzer.py` 的 `visit_Attribute` 列进了链路,只是 `critical_operation` 没跟着走。生成标注的流水线显然"知道"真正的检查点在哪,却把"核心缺陷位置"的标签贴到了链路终点的数据定义上。

但值得多想一层:如果 JSON 里压根没给位置,该怎么独立找到它?三个办法,按性价比排序:

1. **全局搜关键词(最快)。** 名单是数据,数据被谁引用,谁就是执行点。在仓库里搜 `BLOCKED_ATTRIBUTES`:

   ```bash
   grep -rn "BLOCKED_ATTRIBUTES" --include="*.py"
   ```

一搜就能看到它被 `task_analyzer.py` import,并在 `visit_Attribute`、`visit_Subscript` 等好几处被比对——执行点全部现形。(不用 clone 整个仓库,GitHub 网页搜索或直接下载单个文件也行。)

2. **顺着目录和包名猜(成本最低)。** `packages/@n8n/task-runner-python`——包名直接写着"Python 任务运行器",静态检查八成在这一片。拿到陌生仓库先看目录结构,安全检查类代码通常集中在名字带 `security` / `sanitiz` / `validat` / `runner` 的模块里。

3. **从 entry_point 顺藤摸瓜(最扎实)。** 从标注的入口 `Code.node.ts:206` 开始读:拿到用户代码 `code` → 构造 `PythonTaskRunnerSandbox` → 提交任务 → Python 侧收到代码先 `validate()` → 顺着 validate 一路走到 analyzer。这条链,恰好就是 `trace` 应该画出来的样子。

三个办法背后是同一个思路:**名单(数据)是被动的,要找的是"谁在用它做决定"**——和第二步那个"灵魂问题"是同一件事,只是从"看一行代码"扩大到了"看整个仓库"。

**第四步:连带检查,别改出一个新错误。** 这里有个容易踩的坑:`critical_operation` 是 `code`/`desc`/`file`/`line` 四个字段捆在一起的整体。如果只把文件和行号改过去,`code` 里还是黑名单的代码快照,标注就自相矛盾了。所以四个字段要一起换:

```json
"critical_operation": {
  "code": "if node.attr in BLOCKED_ATTRIBUTES:",
  "desc": "visit_Attribute 对每个属性访问节点做黑名单比对,命中则拦截、未命中则放行。这是沙箱静态分析真正执行安全决策的位置。",
  "file": "packages/@n8n/task-runner-python/src/task_analyzer.py",
  "line": 66
}
```

## 剩下 5 条修正速览

00176 的病根——**把"和漏洞有关的东西"当成"缺陷发生的位置"**——在其他 5 条里换着花样出现。漏洞机制前面前置知识都讲过了,这里直接上结果:

| entry | 漏洞 | 原标注错在哪 | 修正后指向 |
|---|---|---|---|
| 00099 | 表达式沙箱逃逸 | critical 指向防御方 `PrototypeSanitizer` 的**定义**(`expression-sandboxing.ts:244`) | 真正的求值点 `evaluateExpression`(`expression-evaluator-proxy.ts:19-21`)——逃逸表达式在这里落地成 RCE（远程代码执行） |
| 00100 | 同一漏洞的另一入口(`__sanitize` 遮蔽路径) | critical 同样指向 sanitizer 定义(`:330-336`) | 同上,`evaluateExpression` |
| 00103 | webhook CSP 绕过 | entry_point 的 code 快照只有一个 `}` 收尾括号(`webhook-helpers.ts:615`),desc 却论证它是"污染链路的起始入口" | 真正接收外部 headers 的 `setResponseHeaders`(`webhook-request-handler.ts:146-154`) |
| 00511 | VM 引擎逃逸 | critical 指向"缺失的检查点"(原生回退分支,`extend.ts:79-85`) | 真正执行攻击者代码的 `.apply`(`extend.ts:132-135`) |
| 00512 | 同一漏洞的另一入口 | 位置 `reset.ts:46` 本身没错,只是 desc 不精确 | 位置不动,仅细化描述 |

三点观察:

1. **00099/00100 和 00176 是同一个病。** 防御方(sanitizer)的定义不是执行点——和"黑名单定义不是安检员"一模一样。这两条是同一 CVE 的两个入口,所以修法相同。
2. **00103 最能暴露自动标注的本性。** 它的 `code` 快照只有一个 `}` 收尾括号——非执行点,执行流只是"经过"它。但它的 desc 却一本正经地论证"分支到此结束,污染链路由此开始"。有意思的是这个论证还站不住:第 615 行时用户 headers 尚未被处理,真正进入漏洞链路要等到下游的 `setResponseHeaders`。
3. **00511:文件指对了,位置指错了。** 原标注把 critical 指在 `extend.ts` 的原生回退分支(79-85)——按名字找扩展函数、找不到就当"宿主原生函数"继续解析的那段代码。文件没错,这段代码也确实和缺陷直接相关:`'constructor'` 能一路畅通,就是因为这里"该设岗没设岗",原标注管它叫"缺失的检查点"。**错在语义**:这一行运行时只是解析并返回了一个函数引用,没有任何伤害发生在这里;攻击者的代码字符串真正被执行,是在后面 `foundFunction.function.apply(input, args)`(132-135)那一刻——那才是事故现场。**怎么解决的**:把 critical 从"缺失的检查点"挪到 `.apply` 那一行,原分支降级为 trace 里的根因说明;`code`/`desc` 同步换成 `.apply` 的快照和说明,四件套保持一致。

6 条修完回头看,病根能归成一句话:**"有关"不等于"现场"**。清单、防御方、括号、缺失的检查点——都和漏洞有关,但都不是危害真正发生的那一行。而评测基准拿这些标注当标准答案,标签贴错一个,一个 AI 的正确答案就会被判错——这就是为什么"人工审计"这一步省不掉。

## 这次开源经历对我的意义
首先不得不说的是，提交这次pr，ai帮助了我很多东西，毕竟我做这个工作的时候，是在今年七月份，那时候我才刚结束我的大一生涯，由于对自己的未来充满迷茫，这一年我自己东学学，西学学，学了很多东西，但是都只是学了些皮毛。我一直找不到我未来的职业方向，游戏开发？前端开发？后端开发？测试？还是当下热门的agent开发？这里面每一个方向在网上都是被劝退的，由于高考的失利，我并没有成为一名名校计算机的学生，我对自己也越发不自信，我不知道我应该做什么，好像做什么都比不过别人，我害怕竞争......   
这次开源经历不仅让我提升了我对于代码安全，规则审计的见解，更重要的是它让我重拾了信心，至少对于这个**中高难度issue**，我是做的最好的那位，并且参与这个issue的也不乏名校计算机相关专业的本科生和硕士生，我仅仅用的也只是当时codebuddy可以免费使用的混元四模型，其余大部分人用的都是当时最前沿的chatgpt和opus模型。   
所以，我非常感谢腾讯能够举办这样一次开源活动并且最终认可了我的成绩。也正因为这次活动，我也开始渐渐开始了解开源，在github上的一些我自己感兴趣的项目里面也提了一些issue和pr。    
关于我是如何与ai协作完成此次pr的，第一步也是最重要的一步当然就是了解这个项目到底是做什么的以及这个issue的需求，然后便是借助ai熟悉项目的`entries.jsonl`的格式以及对应的意图，根据这个让ai对各个仓库的代码进行检索，比对，发现标注问题。大致流程就是这样，听起来很简单，其实做起来也不难，不过重要的是我对于这个pr的提交质量的要求可能是比别人要高的，我会严格按照交付要求进行提交，测试、review等后续步骤在每一次的commit都不会被落下。总之，很神奇，我最后就是在这个**中高难度的issue**中获奖了。  
至于为什么间隔了这么久才写这篇文章，那是因为我本来打算等腾讯的奖品寄过来再写的，并且也认为我通过好几个月对于linux,云原生方面的学习，能够让我对这个经历有一个新的见解。但是腾讯的奖品来的太慢了，现在还没到，不想等了，所以干脆现在就写了。