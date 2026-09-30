# 本机执行适配、一次性运行与回执恢复

本批接通 Claude 2.1.247 和 Codex 0.149.1 的显式本机启动配置、进程监管、一次性额度及持久化回执。入口为 dispatch execute，每次只处理一个已经领取的分派，不扫描队列。配置构造和输出解析均经过夹具测试；尚未用真实供应商完成该通道的模型任务。

当前支持明确的 capabilities: ["board-tools"] 或 ["workspace-files"]。后者通过受限 MCP 文件会话读写 UTF-8 源码并绑定 v2 启动记录；两种配置均关闭原生文件和命令工具，不自动升级为 shell 能力。详见 [文件会话与提交](workspace-files.md)。该配置不宣称实现 OS 文件隔离，也不满足完整 G04。Zcode 已补单次 stream-json 结果合同，见 [接入记录](zcode.md)；其订阅、实际工具策略及启动配置仍未接通，prepareAdapter 收到该运行时仍明确拒绝。

## 启动配置

core/execution/adapters.mjs 从已登记的角色读取具体模型、推理档位及身份工具集。固定原生程序、Node 桥接程序、MCP 凭据与生成配置均记录 SHA256，启动前重验。安装版本是可信本机登记输入，须由管理员用同一路径的 --version 事先核验；填写版本字符串本身不是程序身份验证。程序摘要变化后必须重新核验登记。

执行目录必须为空，位于治理仓、认证目录及本次私有运行目录之外；祖先含 .env 或 .mcp.json 时拒绝。认证配置不复制进运行目录。MCP 凭据须属于该节点代次与分派 principal，并放在本次私有目录；桥接代码来自同一治理仓，地址只接受带显式端口的 http://127.0.0.1/ 根地址。

生成配置使用排他新建，不覆盖已有文件；部分写入失败时仅删除本次已创建的配置。环境只继承所需的系统路径、代理及证书设置，剔除 API key、自定义 Node 注入及无关供应商环境。认证使用现有 CLI 认证目录，不切换到 API key。代理等环境内容不写进公开摘要，只记录整体哈希。

准备结果绑定当前进程，不能把序列化 JSON 当作新的启动许可。argv、提示、环境、解析选项、身份和文件摘要任一改变都会使准备结果失效。

| 运行时 | 显式配置 | 核验边界 |
|---|---|---|
| Claude | --tools ""；仅授权角色 MCP 工具；--strict-mcp-config；--setting-sources ""；禁用 hooks、插件同步、slash commands 和 Chrome；具体模型、effort、固定 session；stdin 提示；不持久化会话 | 初始化工具列表须与授权集完全一致，唯一 fleet MCP 须 connected；额外工具调用或子 agent 输出拒绝；仍需真实运行验证供应商是否遵守配置 |
| Codex | 忽略用户配置和规则；ephemeral；read-only sandbox；approval never；关闭 shell/unified exec、插件、hooks、apps、多 agent、目标和记忆功能；显式 fleet MCP 与 enabled_tools；stdin 提示 | JSONL 暂无等价的完整实际工具清单或实际模型字段核验；请求模型、启动策略与 MCP 请求审计分别保留，不能假定 JSONL 已证明全部实际权限 |

CLI 管理策略及本机文件权限仍可能影响运行；夹具测试不会证明真实登录、模型可用性或供应商内部权限配置已生效。现有两种 CLI 的配置/帮助核验与真实模型验收分别记录。

## CLI

先完成角色、任务、路由请求、provider 额度以及 dispatch prepare。准备阶段只保留额度，MCP 执行凭据尚不可用。治理树须干净、已提交、与该进程加载树和外部验收记录一致；execute 不写验收文件、不自动放行任务。

本机配置 JSON 的必填字段如下：

~~~json
{
  "installation": {
    "runtime": "claude",
    "version": "2.1.247",
    "program": {"path": "<固定原生程序绝对路径>", "sha256": "<核验后的64位摘要>"},
    "auth_home": "<现有CLI认证目录绝对路径>"
  },
  "python": {"path": "<Python 3.12绝对路径>", "sha256": "<64位摘要>"},
  "node": {"path": "<Node原生程序绝对路径>", "sha256": "<64位摘要>"},
  "workspace": "<独立空执行目录绝对路径>",
  "private_directory": "<本次独立私有目录绝对路径>",
  "mcp_url": "http://127.0.0.1:43111/",
  "credential_file": "<prepare创建的凭据绝对路径>",
  "timeout_ms": 60000
}
~~~

这些值由本机操作者核验提供，远程 MCP 工具不能传入 shell、程序路径或该配置。模板中的占位值不可执行。Codex 改为对应 runtime、版本、程序及认证目录；模型和 effort 始终取该分派的角色策略，配置文件不能覆盖。

~~~text
node cli/dispatch.mjs execute --db <数据库> --dispatch <分派ID> --config-file <配置JSON> --prompt-file <UTF-8提示文件> --accepted-rev <治理树验收文件>
node cli/dispatch.mjs reconcile --db <数据库> --journal-file <execution-observation.json>
~~~

execute 只接受 provider 额度。取消、配置篡改、Python 摘要不符或已存在回执会在领取启动许可前拒绝，不扣调用额度。许可提交后立即持久化 used+1；进程启动失败、超时、取消和不确定启动都不退额度，重启进程也不能获得第二次许可。

本机心跳核对运行、角色版本及凭据撤销状态。Tailscale 断开不直接终止本机执行。MCP 已正式交付后保留其证据，进程收尾回执不覆盖它。

## 持久化与恢复

调度 schema 从 1 升至 2。升级前备份并停止旧调度进程；本次没有迁移运行部署。新增 broker_execution_records 保存不可修改的启动摘要及仅能写入一次的终态观察。

启动摘要、身份检查、额度消耗和许可在同一事务内提交。摘要绑定模型、effort、run/principal/agent 身份、程序与 Python 摘要、配置/环境/提示摘要和资源上限，不保存 API key、原始环境或提示正文。

终态观察保留已解析证据、用量、供应商 session/turn/model、协议诊断、输出摘要与计数、退出码、进程清理状态和程序/Python/宿主摘要。原始 stdout/stderr 不入审计。观察结果、任务报告及分派结算一起提交；观察存储或任务报告任一失败，整个事务回滚。

监管结束后先排他写入并 fsync 私有 execution-observation.json，再提交数据库结算。若数据库提交失败，reconcile 验证 dispatch 与启动摘要后重复补交同一终态；它不能启动任何进程。若宿主在形成完整回执前崩溃，或磁盘写入失败，状态保持已消费但结果未知，需要后续核对，不自动再跑。该日志不是跨节点传输协议。

相同回执可重复读取/补交，改变进程观察则拒绝。旧运行结果保留在历史中，不改写替代运行。所有自动回执仍为 accepted: false、real_model_call_confirmed: false；模型调用和业务验收需要独立证据。

## 验证与剩余工作

本机测试覆盖固定配置、秘密环境过滤、工具范围、篡改、路径混用、配置写入回滚、许可/观察原子性、重连补交、预算不重用与历史不可变。端到端 runner 测试故意让 Node 接收不支持的 Claude 参数并退出，验证真实 OS 进程失败路径；它没有启动 Claude、Codex 或其他模型进程。

剩余工作包括真实两种 CLI 的 MCP 初始化与最小任务、Zcode 中国版订阅登录与固定模型/工具启动配置、Windows 文件权限隔离、后台调度和独立阶段验收。三种真实调用额度仍各 0/1。

接口依据为本机固定版本帮助与实现，另参考 Claude 官方 [CLI reference](https://code.claude.com/docs/en/cli-reference)、[Settings reference](https://code.claude.com/docs/en/settings-reference) 及 Codex 官方 [Configuration reference](https://developers.openai.com/codex/config-reference/)。官方文档会变化；升级后不能沿用未核验的版本登记。
结算成功同时撤销该 run 的临时 MCP 凭据；结算事务失败时撤销也回滚。已结束执行器不能继续用旧身份读取、拆分或交付任务。恢复补交使用本机受控日志，不依赖被撤销的 agent 凭据。
