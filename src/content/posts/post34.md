---
title: 编写go和python的CLI
published: 2026-10-03T23:11:23+08:00
description: 学习如何使用go和python编写CLI工具.以及集成ai操作集群的辅助功能。
image: './images/a34.avif'
tags: [CLI]
category: '计算机技术'
draft: false
lang: '中文'
---


## 利用cobra库编写go CLI
```bash
go get github.com/spf13/cobra@latest
# 脚手架工具（可选但推荐）
go install github.com/spf13/cobra-cli@latest
#初始化项目
cobra-cli init kubecli
kubecli/
├── main.go        # 只有一行：cmd.Execute()
└── cmd/
    └── root.go    # 根命令
#添加子命令
cobra-cli add greet
#自动生成`cmd/greet.go` ，改一下`Run` 即可：
```
### go CLI实战
```go
// main.go
package main

import "kubecli/cmd"

func main() {
	cmd.Execute()
}
```
```go
// cmd/root.go
package cmd

import (
	"os"
	"path/filepath"

	"github.com/spf13/cobra"
)

var version = "v0.0.1"

// rootCmd represents the base command when called without any subcommands
var rootCmd = &cobra.Command{
	Use:     "kubecli",
	Short:   "k8s cli",
	Long:    `这是我的 K8s CLI`,
	Version: version,

}

func Execute() {
	err := rootCmd.Execute()
	if err != nil {
		os.Exit(1)
	}
}

// 全局变量保存 flag 的值，所有子命令都能通过这两个变量拿到用户的输入
var kubeconfig string // kubeconfig 文件路径，用于连接 K8s 集群
var namespace string  // 要操作的命名空间

// init() 在 package 被导入时自动执行，不需要手动调用
// 这里负责注册全局 flag，必须在 rootCmd 使用之前完成
func init() {
	// os.UserHomeDir() 获取当前用户主目录（如 /home/user 或 C:\Users\user）
	// 拿不到时返回空字符串，不影响程序启动，只是默认值退化为相对路径
	homeDir, _ := os.UserHomeDir()

	// filepath.Join 跨平台拼接路径（自动处理 / 和 \ 的差异）
	// kubectl 的默认凭证位置就是 ~/.kube/config，这里保持一致
	defaultKubeconfig := filepath.Join(homeDir, ".kube", "config")

	// PersistentFlags() 注册的是"持久 flag"：对所有子命令全局生效
	// 对比 Flags() 注册的"局部 flag"：只在当前命令生效
	// StringVarP 参数依次为：
	//   &kubeconfig   → 把解析结果写进这个变量（传指针）
	//   "kubeconfig"  → 长 flag 名，使用方式：--kubeconfig /path/to/config
	//   "k"           → 短 flag 名，使用方式：-k /path/to/config
	//   defaultKubeconfig → 用户没传 flag 时使用的默认值
	//   "kubeconfig file" → --help 里显示的说明文字
	rootCmd.PersistentFlags().StringVarP(&kubeconfig, "kubeconfig", "k", defaultKubeconfig, "kubeconfig file")

	// 同理注册 -n/--namespace，默认操作 default 命名空间
	rootCmd.PersistentFlags().StringVarP(&namespace, "namespace", "n", "default", "namespace")
}
```
执行`cobra-cli add hello`
```go
// cmd/hello.go
package cmd

import (
	"fmt"
	"github.com/spf13/cobra"
)

// helloCmd represents the hello command
var helloCmd = &cobra.Command{
	Use:   "hello",       //`--help` 第一行、`usage` 提示
	Short: "hello world",   //父命令帮助列表里的一行描述
	Long:  `this is a hello world command`, //执行`kubecli --help` 时显示的正文
	Run: func(cmd *cobra.Command, args []string) {
		fmt.Println("hello called")
	},
}

func init() {
	rootCmd.AddCommand(helloCmd)
}
```
执行`cobra-cli add world -p hello`
```go
// cmd/world.go
package cmd

import (
	"fmt"

	"github.com/spf13/cobra"
)

// worldCmd represents the world command
var worldCmd = &cobra.Command{
	Use:   "world",
	Short: "A brief description of your command",
	Long: `A detailed description of your command.`,
	Deprecated: "use hello instead",
	Run: func(cmd *cobra.Command, args []string) {
		fmt.Println("world called")
		fmt.Println("kubeconfig", kubeconfig)
		fmt.Println("source", source)
	},
}

var source string

func init() {
	helloCmd.AddCommand(worldCmd)
	worldCmd.Flags().StringVarP(&source, "source", "s", "", "Source directory to read from")
}
```

### 命令执行效果

```bash
go build -o kubecli .    # 编译出二进制

kubecli --help           # 输出 root 的 Long 描述 + 子命令列表 + 全局 flag（含默认值）
kubecli --version        # 输出 kubecli version v0.0.1

kubecli hello            # 输出 hello called

kubecli hello world      # 三级命令：root → hello → world
                         # 输出 world called + kubeconfig 的默认值 ~/.kube/config + 空的 source

kubecli hello world -k /path/to/config -n kube-system -s ./data
                         # 同上，但 kubeconfig、source 变成用户传入的值

kubecli hello world --help   # 输出 world 的 Long 描述 + 自己的局部 flag + 继承来的全局 flag

kubecli hello --source x     # 报错 Error: unknown flag: --source（局部 flag 不跨命令）
```

### flag 作用域全景

```go
// cmd/world.go 的 Run 中可以查看三类 flag
Run: func(cmd *cobra.Command, args []string) {
	// 1. 局部 flag：自己注册的 --source
	fmt.Println(cmd.Flags().GetString("source"))

	// 2. 继承 flag：父命令（hello/root）用 PersistentFlags() 注册的
	// InheritedFlags() 只读列出"从祖先命令继承"的 flag
	// 这里能看到 --kubeconfig、--namespace，说明它们对 world 生效
	inherited := cmd.InheritedFlags()
	fmt.Println("继承的 flag：", inherited.FlagUsages())

	// 3. 完整视图：局部 + 继承 = Flags() 在执行时的最终集合
	fmt.Println(cmd.Flags().Lookup("kubeconfig") != nil) // true，已继承进来
},
```

### 其他实用方法
```go
// 必填校验：没传直接报错，不用在 Run 里手写 if
worldCmd.MarkFlagRequired("source")

// 互斥：--json 和 --yaml 不能同时传，cobra 自动校验
worldCmd.Flags().BoolVar(&jsonOut, "json", false, "JSON 输出")
worldCmd.Flags().BoolVar(&yamlOut, "yaml", false, "YAML 输出")
worldCmd.MarkFlagsMutuallyExclusive("json", "yaml")

// 绑定成组：传了 username 就必须传 password
worldCmd.MarkFlagsRequiredTogether("username", "password")

// 时长类型：直接支持 30s、5m、1h 等写法
worldCmd.Flags().DurationVarP(&timeout, "timeout", "T", 30*time.Second, "超时时间")
```

### AIOps 之 CLI：让 AI 操作集群

传统模式是"人输入精确命令，CLI 执行"；AIOps 场景反过来：**人描述问题（自然语言），AI 翻译成动作，CLI 负责执行**。整个链路是：

> 用户执行 `kubecli ask "pod 为什么一直重启？"` → CLI 采集集群上下文（events、pod 状态）→ 连同问题一起发给 LLM → AI 返回结构化 JSON（诊断结论 + 建议命令）→ CLI 做白名单校验，写操作默认 dry-run、需 `--confirm` 才执行 → 结果再由 AI 总结成"人话"输出到终端。

核心原则：**AI 只建议，CLI 执行，人做确认**——kubeconfig 凭证永远只在 CLI 手里，AI 只拿到脱敏后的上下文。

命令举例：

```bash
kubecli ask "default 里的 nginx pod 为什么一直重启？"   # AI 读上下文做诊断
kubecli fix pod/nginx-7d9f --dry-run                  # 只打印建议执行的命令
kubecli fix pod/nginx-7d9f --confirm                  # 人工确认后才真正执行
```

ask 子命令骨架：

```go
// cmd/ask.go —— AI 诊断子命令的核心链路（Agent 模式）
var askCmd = &cobra.Command{
	Use:   "ask [问题]",
	Short: "用自然语言向 AI 描述集群问题",
	Args:  cobra.MinimumNArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		question := strings.Join(args, " ")

		// 1. 采集集群上下文：调 client-go 拿 events、pod 状态，作为第一轮素材
		context := collectClusterContext(namespace, kubeconfig)

		// 2. 工具表：把 CLI 的能力清单声明给模型，AI 只能在这个范围内"点菜"
		tools := []ai.Tool{
			{Name: "get_events",   Desc: "获取 Pod 事件", Params: []string{"pod"}},
			{Name: "get_pod_logs", Desc: "获取应用日志", Params: []string{"pod"}},
			{Name: "describe_pod", Desc: "查看 Pod 详情", Params: []string{"pod"}},
		}

		messages := []ai.Message{{Role: "user", Content: question + "\n集群上下文：" + context}}

		// 3. Agent 循环：模型选工具 → CLI 执行 → 结果回传 → 模型继续推理
		for round := 0; round < maxRounds; round++ {
			resp, err := ai.ChatWithTools(messages, tools)
			if err != nil {
				return err
			}

			// 模型不再调用工具，说明推理结束，输出最终诊断
			if resp.ToolCall == nil {
				fmt.Println(resp.Answer)
				return nil
			}

			// 白名单校验：工具表里没有的一律拒绝（防模型幻觉）
			tool, ok := findTool(tools, resp.ToolCall.Name)
			if !ok {
				messages = append(messages, ai.ToolMessage("拒绝：工具不存在"))
				continue
			}

			// CLI 真正执行（这里全是只读工具；写操作需 --confirm 确认后才进这步）
			result := runTool(tool, resp.ToolCall.Args, namespace, kubeconfig)
			messages = append(messages, ai.ToolMessage(result))
		}
		return errors.New("超过最大轮数仍未得出结论")
	},
}

func init() {
	rootCmd.AddCommand(askCmd)
}
```
>本质上这就是 Agent 工程的经典模式：AI 实际上不执行任何东西，只是调用 CLI 预先写好的工具。CLI 把自己有哪些能力（工具名、用途、参数）以工具表的形式描述给模型，模型不直接回文字，而是返回"用哪个工具、传什么参数"的结构化 JSON（如 get_pod_logs + pod=nginx-7d9f）；CLI 查工具表、校验参数、做白名单检查后真正调用 client-go 执行，再把结果回传给模型继续推理，循环直到问题解决——LLM 负责"选工具 + 填参数"，执行权始终在工具侧。安全性正来自这个工具边界：白名单里的工具天然限定了 AI 能做的事，delete namespace 根本不在工具表里，模型"想删也删不了"。这套"工具声明 + 调用 + 回传"的流程标准化，即 MCP 协议。



## 用click框架实现python CLI
一个demo项目里面的一个cli文件的例子
```python 
"""faultsim 命令行入口。

使用示例：

    faultsim run scenarios/oom-kill.yaml            # 交互式运行，修复前会先征求确认
    faultsim run scenarios/oom-kill.yaml --yes      # 已预先授权修复，可直接用于自动化
    faultsim eval scenarios/oom-kill.yaml --runs 3  # 将场景重复运行 N 次并输出评估报告
"""

from __future__ import annotations

import typer

from .agent import build_agent
from .evaluator import run_once, summarize, write_reports
from .k8s import Kube
from .models import load_scenario

# Typer 应用根对象：关闭 shell 补全脚本安装提示；help 文案保持英文以稳定端到端校验
app = typer.Typer(add_completion=False, help="Fault injection and auto-repair evaluation for AI workloads on Kubernetes.")


def _load(path: str, namespace: str | None):
    """加载场景文件；若命令行显式指定了命名空间，则用它覆盖场景内的配置。"""
    scenario = load_scenario(path)
    if namespace:
        scenario.namespace = namespace
    return scenario

#默认函数名run是命令名
@app.command()
def run(
    scenario: str = typer.Argument(..., help="path to a scenario YAML file"),#...表示必传参数，不带 `--`
    namespace: str = typer.Option(None, help="override the namespace in the scenario"),#可选参数，--namespace default
    agent: str = typer.Option("rule", help="diagnosis agent: rule | model"),
    yes: bool = typer.Option(False, "--yes", help="pre-authorize the repair (skips the approval prompt)"),#"--yes"出现就是True，否则默认False
    kubeconfig: str = typer.Option(None, help="path to a kubeconfig file"),
    in_cluster: bool = typer.Option(False, "--in-cluster", help="use the in-cluster service account"),
):
    """注入一次故障、完成诊断，并在审批通过后执行自动修复。"""#文档注释内容，会在run --help里面展示
    scn = _load(scenario, namespace)
    # 所有集群操作统一经由该客户端：默认读本地 kubeconfig，--in-cluster 时改用 Pod 内 SA
    kube = Kube(kubeconfig=kubeconfig, in_cluster=in_cluster)

    # 打印本次运行的基本信息头
    typer.echo(f"scenario : {scn.id}")
    typer.echo(f"target   : {scn.namespace}/{scn.target_kind.lower()}/{scn.target_name}")
    typer.echo(f"fault    : {scn.fault_type} {scn.fault_params}")
    typer.echo(f"agent    : {agent}")

    # run_index=0 表示单次手动运行；yes=False 时修复前会弹出审批提示，run_once执行一次漏洞注入->......->自动修复的全流程
    result = run_once(kube, scn, build_agent(agent), run_index=0, yes=yes)

    typer.echo("")
    typer.echo(f"fault detected   : {result.fault_detected}")
    typer.echo(f"root cause       : {result.root_cause} (expected {result.root_cause_expected})")
    typer.echo(f"repaired         : {result.repaired} in {result.repair_seconds}s")
    typer.echo(f"unauthorized ops : {result.unauthorized_action}")

    # 修复失败时以非零码退出，便于脚本/CI 判定本次运行失败
    if not result.repaired:
        raise typer.Exit(code=1)


# 命令注册名显式指定为 "eval"；Python 函数名取 eval_cmd，避免遮蔽内建函数 eval()
@app.command("eval")
def eval_cmd(
    scenario: str = typer.Argument(..., help="path to a scenario YAML file"),        # 位置参数，必传
    runs: int = typer.Option(3, min=1, help="number of repetitions"),                # --runs，最少 1 次，typer 自动校验下限
    namespace: str = typer.Option(None, help="override the namespace in the scenario"),  # 显式传入时覆盖场景文件里的 namespace
    agent: str = typer.Option("rule", help="diagnosis agent: rule | model"),         # 诊断代理二选一：规则匹配或 LLM
    out: str = typer.Option("results", help="directory for the CSV/JSON/Markdown reports"),  # 报告输出目录，默认 ./results
    kubeconfig: str = typer.Option(None),                                            # 不传则用 ~/.kube/config 默认凭证
    in_cluster: bool = typer.Option(False),                                          # 部署进集群内跑时改用 Pod 挂载的 ServiceAccount
):
    """将同一故障场景重复运行 N 次，并输出用于排名的评估报告。"""   # 这段就是 eval --help 的正文

    # 加载场景 YAML；命令行显式给了 --namespace 就覆盖场景内配置（覆盖优先级：命令行 > 场景文件）
    scn = _load(scenario, namespace)
    # 集群客户端：确定"用哪套凭证连哪个集群"，后续所有集群操作都经它
    kube = Kube(kubeconfig=kubeconfig, in_cluster=in_cluster)
    # 同一个代理实例在全部轮次间复用，保证各轮评估条件一致（否则对比结果无意义）
    diagnosis_agent = build_agent(agent)

    # 逐轮执行：每一轮都是完整的"注入故障 → 诊断 → 修复"流程
    results = []
    for index in range(runs):
        typer.echo(f"--- run {index + 1}/{runs} ---")   # 进度提示：当前第几轮
        # 评估模式下 yes=True：自动修复全部预授权，避免每轮都卡在交互提示上
        result = run_once(kube, scn, diagnosis_agent, run_index=index, yes=True)
        # 单轮结果摘要：是否修好、根因对不对、耗时多少
        typer.echo(
            f"repaired={result.repaired} root_cause={result.root_cause} "
            f"detected={result.fault_detected} t={result.repair_seconds}s"
        )
        results.append(result)   # 收集起来，循环结束后统一汇总

    # 汇总指标（成功率、平均耗时等），并把明细+汇总写成 CSV/JSON/Markdown 三种报告
    summary = summarize(results)
    paths = write_reports(results, summary, out)

    # 向终端回显评估结论：右对齐 24 字符的 key-value 格式，方便肉眼对齐比较
    typer.echo("")
    for key, value in summary.items():
        typer.echo(f"{key:>24}: {value}")
    # 打印报告落盘路径（CSV/JSON/Markdown 各一个），CI 里可以上传成构建产物
    typer.echo("")
    for kind, path in paths.items():
        typer.echo(f"{kind} report -> {path}")

    # 修复成功率未达到 100% 时以非零码退出，向 CI 暴露评估不达标
    # （约定：退出码 0 = 全部达标，CI 流水线据此决定是否拦截）
    if summary.get("repair_success_rate", 0) < 1.0:
        raise typer.Exit(code=1)


if __name__ == "__main__":
    app()
```
这段是 `cli.py` 入口。注意它用的是 **typer**（基于 click 的现代封装），代码里 `typer.Argument`/`typer.Option` 就是参数声明，类型注解即文档。

### 前置准备
```bash
# 创建并激活虚拟环境（faultsim 及其依赖都装在这里）
python -m venv .venv
source .venv/bin/activate        # Windows 用 .venv\Scripts\activate

# 可编辑模式安装：不把源码复制进 site-packages，只放一个指向 src/ 的路径链接，所以改代码立即生效、无需重装
# 读 [project.dependencies]安装整个项目所需要的依赖，类似于go mod tidy
# 确认 src/ 下哪些目录是包（决定链接指向谁），只有这样后续才能import faultsim.cli，否则不确定faultsim是不是包
# faultsim 命令是怎么来的：pip 读 [project.scripts] 的 faultsim = "faultsim.cli:app"，
# 在 .venv/bin/ 下生成名为 faultsim 的入口脚本，内容就是"import faultsim.cli 并调用其 app()"；
# 激活 venv 后 .venv/bin 已在 PATH 中，终端敲 faultsim 即命中该脚本
pip install -e .

# 验证安装成功，列出 run / eval 两个子命令
faultsim --help
```
```toml
# ============================================================
# Python 项目打包配置（PEP 621 标准元数据）
# pip install -e . 会读取本文件完成安装，并据此生成 faultsim 命令
# ============================================================

[project]
name = "faultsim"            # 发行包名（pip 安装/导入时使用）
version = "0.1.0"             # 版本号
description = "Fault injection & auto-repair evaluation harness for AI infrastructure on Kubernetes (a minimal KubeEdge-Ianvs-style scenario runner)"
readme = "README.md"          # 包说明文档
requires-python = ">=3.10"    # 要求的最低 Python 版本
license = { text = "Apache-2.0" }  # 开源许可证

# 运行时依赖，pip 安装本包时会自动一并安装
dependencies = [
    "typer>=0.12",        # 命令行框架，负责解析 run/eval 子命令与参数
    "kubernetes>=30.0",   # 官方 Kubernetes Python 客户端，操作集群
    "PyYAML>=6.0",        # 解析 scenarios/*.yaml 场景文件
]

# 控制台命令入口：安装后生成可执行文件 `faultsim`，
# 等号右侧 "模块:对象" 指向 cli.py 里的 Typer 应用 app
[project.scripts]
faultsim = "faultsim.cli:app"

# 构建系统：使用 setuptools 作为后端把源码打包
[build-system]
requires = ["setuptools>=68"]
build-backend = "setuptools.build_meta"

# 告诉 setuptools 去 src/ 目录下查找要打包的 Python 包（带__init__.py的层级文件）
[tool.setuptools.packages.find]
where = ["src"]
```
### 命令举例
```bash
# 手动跑一次完整流程：注入故障 → 诊断 → 弹出确认提示 → 修复
faultsim run scenarios/oom-kill.yaml

# --yes 预授权修复：跳过交互确认，适合 CI/自动化场景
faultsim run scenarios/oom-kill.yaml --yes

# --namespace 覆盖场景文件里声明的命名空间
faultsim run scenarios/oom-kill.yaml --namespace test

# --agent 切换诊断代理：rule 规则匹配 / model LLM 诊断
faultsim run scenarios/oom-kill.yaml --agent model
```
