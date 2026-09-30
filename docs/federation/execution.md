# 执行器终态与进程监督合同

本批提供三种输出解码器和可信本地进程监督原语，对应 T04.03–T04.06 的一部分。已通过真实 OS 子进程桩测试，并串通“单次启动许可 → 本机心跳 → 子进程 → 原生待审阅回执”。后续已接入 Claude/Codex/Zcode 的受限 MCP 启动配置与显式单次执行入口，见 [适配与回执合同](adapters.md)；三种真实模型的完整适配及队列入口仍未完成。

所有新增自动化验证均使用合成供应商事件与临时脚本。没有把桩响应记为模型调用，没有修改全局 MCP、登录或部署配置。

## 输出合同

core/execution/output.mjs 接收 UTF-8 NDJSON。Zcode 默认输入为已解包的 session event envelope，保持显式 sessionId/inputId 绑定；新增独立的 headless-stream 合同接收单次命令事件及最终摘要。实测 app-server 使用自身 NDJSON 帧，包含 jsonrpc 字段的标准 JSON-RPC 请求会被拒绝，不能直接传给事件解码器。单次启动适配已接入，真实订阅尚待验收，详见 [Zcode Windows 接入记录](zcode.md)。

| 运行时 | 成功的必要条件 | 失败处理 |
|---|---|---|
| Claude | 同一根 session 的 system/init；若指定 expectedModel 则实测模型一致；单个 result 的 subtype=success 且 is_error=false；非空 result；退出码0 | error subtype、is_error、串线、模型不符、重复终态均不能成功 |
| Codex | thread.started、turn.started、最终 agent_message 和 turn.completed；退出码0 | error、turn.failed、缺少消息/终态、重复 turn 或非零退出不能成功 |
| Zcode session-events | 显式绑定 sessionId 与 inputId；turn.started 与同一 turnId 的 turn.completed；resultType=success；非空 response；退出码0 | cancelled 单独分类；预算/轮数/工具次数/执行错误明确失败；默认 headless JSON 不作为完成证明 |
| Zcode headless-stream | 显式绑定提示 SHA256、providerId、modelId；从首次 turn.started 绑定 session/turn/trace；同一任务的模型请求元数据、成功终态及匹配的最终 result 摘要；退出码0 | 摘要不能独立证明成功；错模型、任务串线、缺少摘要、控制/后台任务、追加任务或不连续事件均失败 |

headless-stream 不支持 RPC 重放或多 turnResponses；默认 session-events 的最近事件重放行为保持。解码器核验观察到的模型身份，不能在模型请求发生前阻止供应商内部回退；启动配置仍须单独限制模型和工具。headless-stream 现支持 expectedTools，检查请求工具数和实际调用名称/ID；不将工具数量当作完整名称清单证明。expectedMcpServer 仍拒绝。

Claude 子 agent 消息不充当根结果。系统信息可以在终态后继续出现，但不接受第二个结果或新的正文。Codex JSONL 不报告此解码器可核实的实际模型字段，因此 expectedModel 不能替代后续启动配置与供应商元数据核验。Zcode session-events 顺序必须连续；仅允许最后一条完全相同的事件重放。后续 RPC transport 必须正确处理 subscribe/events 重叠、分页和序列缺口。

默认上限：stdout 32MiB、单行1MiB、100000事件、最终证据65536字符。非法 UTF-8、JSON、未知终态和超限均失败。诊断仅返回固定代码，不回显被拒绝的原文。stdout 保留已接收范围的摘要、计数和身份元数据，不保留完整原始文本；超出总字节上限的块不计入该摘要。默认供应商合同可忽略非终态的未知信息；Zcode headless-stream 拒绝未支持的协议事件类型。两者都不能由未知信息提供成功证明。

Claude/Codex 的 usage 只映射供应商明确提供的 input_tokens / output_tokens；缺失为 null，非法数值拒绝。缓存输入、费用和计费口径没有在这两个字段中重新估算。Zcode 当前安装版本把 turn usage 声明为 unknown，本批保持 null，待真实合同核验后再映射。所有解析回执的 real_model_call_confirmed 均为 false：解析合成流不证明发生了模型调用。

进程非零退出、信号、缺少终态、超时或取消可覆盖文本上的成功。终态、任务待审阅和验收通过是不同事实。

## 进程生命周期

core/execution/supervisor.mjs 接受可信调用者构造的绝对路径、固定 argv、cwd、显式环境、stdin 和文件摘要。它不接受 MCP 远程命令，不使用 shell，不选择后备模型，不恢复旧会话，不自动重试。调用者须先核验执行能力，并取得本次新提交的 dispatch 启动许可；此原语自身不是权限或预算边界。

Python 3.12 宿主 core/execution/process_host.py 用独立控制管道管理执行进程：

- Node 侧核验 Python、程序和附属文件摘要；Python 在原生创建前再次核验程序及附属文件。程序须使用绝对路径；Windows 只接受原生 .exe 入口。
- 提示内容经 stdin 传入；环境由可信调用者明确给出。宿主收到的路径、提示和环境不会出现在通用错误诊断中。
- stdout/stderr 由宿主包装为有界 base64 帧，与自身状态分开；stderr 默认限制1MiB，仅返回字节数与上限内前缀摘要。宿主诊断不转发给任务证据。
- 本地 heartbeat 回调独立于 Tailscale。回调失败或明确返回 false 时停止运行；外部网络断开本身不触发重分配。回调需有自己的有界完成时间，真实调度器仍待接入。
- 超时、AbortSignal、输出超限或控制连接丢失触发终止。宿主无响应时有限等待后终止宿主，回执标记传输/清理不确定，不声称成功。

### Windows

使用 CreateProcessW 暂停创建主线程，加入无 breakaway 标志的 Job Object 后才 ResumeThread。创建时的句柄白名单只允许子进程自己的 stdin/stdout/stderr；治理控制管道和 Job 句柄不继承。

Job 设置 KILL_ON_JOB_CLOSE。停止或主进程退出后终止 Job，查询 ActiveProcesses=0，再回传 job_empty。已实测普通子进程在取消、主进程正常退出和宿主被终止时停止。Job 管理失败时拒绝启动或返回失败，不降级成不受管理的执行。

Job 是生命周期管理能力，不是文件权限沙箱。通过其他服务代为创建的进程不一定属于该 Job；Microsoft 文档明确列出 Win32_Process.Create 的例外。此实现不能据此宣称恶意程序完全受隔离，或只读 agent 已无法修改治理文件。

### 平台范围

2026-09-30 起仅支持 Windows 实现、CI、部署和验收。仓库中已有 POSIX 分支和历史测试记录保留为历史，不承诺 Linux 支持，也不安排后续 POSIX 隔离工作。

## 与调度的衔接

新增集成测试使用真实临时数据库、原生 claim、单次许可、独立 Node 桩进程和本机 heartbeat；将观察到的 status/evidence/usage 交给 finishDispatch。结果进入 waiting/review、额度消耗一次、重复 launch 拒绝。进程元数据由 supervisor 返回，完整元数据的原子持久化、Claude/Codex 显式单次执行及恢复补交现已接入，详见 adapters.md；真实供应商最小任务尚未执行。Zcode 完整一次性调度链也已通过合成供应商验证，实际安装包与本机假模型/MCP 的测量见 zcode.md。

当前 CLI 提供受限角色配置的 execute 与只补交终态的 reconcile，不接受远程任意程序。调用者不能根据已存在的 launch_committed 记录补启动；失败或不确定的启动仍占用已消费额度。

## 验证与来源

- npm run test:output：三种供应商终态、中文逐字节分帧、身份/序列错误、非法输入和资源限额。
- npm run test:supervisor：固定程序/二次摘要、stdin/环境、超时/取消、父连接断开、普通后代清理、Windows宿主崩溃以及心跳失败。
- npm run test:dispatch：保留原调度测试，并增加真实 OS 子进程到任务回执的桩联调。

供应商接口依据：Claude 官方 [程序调用文档](https://code.claude.com/docs/en/headless)，Codex 官方 [非交互 JSONL 示例](https://learn.chatgpt.com/docs/non-interactive-mode)。本机版本核验为 Claude2.1.247、Codex0.149.1；版本与帮助检查不证明模型可用。

Zcode 依据安装包内 0.16.9 的 zcode.cjs 静态协议 schema（SHA256 fad4c35c4c36ec210d8a06d3fa0e77de23c8545e2eb6ff90aea1eb38d1e6275f）。session/create 支持 model、thoughtLevel、mcpServers、toolAllowlist/toolDenylist 等字段；这些字段的最终生效范围、插件/用户配置合并及实际会话核验仍未完成，不能只凭字段名宣称隔离成立。

Windows 生命周期依据 Microsoft [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)、[AssignProcessToJobObject](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-assignprocesstojobobject) 与 [Extended Limit Information](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_extended_limit_information)。

本批不通过完整 G04。三个真实模型仍各0/1；真实配置生效、模型可用性、Zcode 授权及启动工具策略、Windows 文件隔离及独立验收是剩余工作。

## Windows 执行边界（PR #2 审阅修复）

供应商执行、普通命令监管及 Python 宿主入口均在非 Windows 环境提前拒绝（WINDOWS_REQUIRED）；执行入口在消费启动许可之前检查。已移除 Python 的 POSIX 进程组启动实现，Windows Job 为唯一启动与停止证明路径。测试在 Windows 子进程中替换平台标识，验证拒绝发生在配置读取和进程启动之前；这不构成 Linux 支持或 Linux 实机测试。
