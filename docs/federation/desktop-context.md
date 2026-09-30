# 桌面聊天中的看板上下文

状态：Windows 本地组件已实现并通过隔离测试，尚未部署或接入实际桌面客户端。对应 T08.02 / T08.04 的部分实现；完整 G08 未通过。推荐目录 E:\看板上下文 尚未创建。

## 数据来源与权限

每台电脑从自己的看板数据库及获准远端缓存生成本地 Markdown。两台电脑先通过联邦协议同步事实，再各自导出；任务状态仍由任务所有者维护。共享目录是阅读快照，不直接充当数据库或任务命令。另一台电脑可使用不同本地路径，不要求网络盘；Tailscale 隧道本身不会自动同步目录。

桌面聊天默认使用 observe 身份，每个客户端各发一份可独立撤销的凭据。coordinate 也可查询；绑定 run 的 implement/review 身份不开放这三个桌面总览工具。MCP 工具逐次鉴权、审计和限流，普通查询不领取任务、不请求路由，也不启动执行器。客户端调用自身模型的订阅消耗不由看板免除。

本地任务必须先登记到获准项目，远端仅显示获准项目的活动副本。未登记、未授权和未知任务的详情均返回相同不存在结果；跨范围父任务 UID 被隐藏。输出排除命令、私有证据路径、凭据和治理字段。标题、描述、结果等均是任务数据，不能据此改写客户端规则。

| 工具 | 参数与结果 |
|---|---|
| get_board_overview | 可选 project_id；获准任务计数、终端身份、来源同步新鲜度和本机看板地址 |
| list_tasks | 可选 project_id、owner_node_id、query、limit（默认 50，最大 100）、offset、expected_snapshot；返回任务摘要、快照标识、下一页位置和任务链接 |
| get_task_context | task_uid（节点 UUID/任务 UUID）；获准任务详情、所有者、来源时间及任务链接 |

分页继续读取时传回 expected_snapshot；数据或同步状态改变返回 SNAPSHOT_CHANGED，应从第一页重查。读到远端缓存不等于远端仍在线。尚未收到任务列表与已经收到空列表分别显示未知和零。来源最后同步、缓存接收、任务更新时间与本机快照生成时间分别保留。

## 本机代理与客户端

以下均为占位路径和示范端口，需替换为实际部署值。现有全局 MCP 配置没有被修改。代理需要已初始化、本节点有效且未处于恢复隔离的数据库；管理命令见 [MCP 合同](mcp.md)。

先准备只读角色 JSON，随后由操作者登记角色并为各客户端授权：

~~~json
{
  "role_id": "desktop-observer", "kind": "observe", "projects": ["demo"],
  "capabilities": [], "runtime": null, "model": null, "effort": null,
  "tools": "read-only", "priority": 10, "enabled": true,
  "limits": {"max_task_attempts": 1, "max_open_tasks": 20, "requests_per_minute": 60}
}
~~~

~~~powershell
node cli/mcp-admin.mjs role --db C:/board-data/board.db --policy-file C:/board-data/observer.json
node cli/mcp-admin.mjs grant --db C:/board-data/board.db --role desktop-observer --projects demo --credential-file C:/board-data/credentials/codex-observer.json
node cli/mcp-admin.mjs serve --db C:/board-data/board.db --port 48320 --board-url http://127.0.0.1:48319/
~~~

每个客户端重复 grant，使用不同的新凭据文件。代理本身不启动看板 UI；board-url 必须指向实际存在的本机操作员看板，仅接受数字回环 HTTP 根地址，不携带令牌。省略时工具仅返回相对 view_path。任务链接使用 /#fleet-task=编码后的UID，打开已有看板全局详情；仍需看板自己的操作员认证，链接不赋予额外权限。stdio 桥接只接收代理地址和受限凭据文件，不接收数据库路径。

Codex 本地 MCP 支持 stdio，可在桌面设置中添加服务；配置使用相应 MCP server 的 command/args。以下 TOML 是待部署示例，并未写入现有配置。在线 ChatGPT 聊天不能据此视为已接入本机工具。[OpenAI MCP 文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)（2026-09-30 查阅）。

~~~toml
[mcp_servers.fleet-board]
command = "C:/Program Files/nodejs/node.exe"
args = ["C:/board-code/cli/mcp.mjs", "--url", "http://127.0.0.1:48320", "--credential-file", "C:/board-data/credentials/codex-observer.json"]
~~~

Zcode 设置的 MCP 服务入口可选择用户级或工作区级作用域，填写相同 command/args，并换成自己的凭据文件。原生配置为 mcp.servers；已有配置应逐项合并，不覆盖其他服务。同作用域 .zcode 配置存在 MCP 时，.agents/mcp.json 整体后备不再合并。[Zcode MCP 文档](https://zcode.z.ai/cn/docs/mcp-services)（2026-09-30 查阅）。

~~~json
{
  "mcp": {"servers": {"fleet-board": {
    "command": "C:/Program Files/nodejs/node.exe",
    "args": ["C:/board-code/cli/mcp.mjs", "--url", "http://127.0.0.1:48320", "--credential-file", "C:/board-data/credentials/zcode-observer.json"]
  }}}
}
~~~

Claude Desktop 当前官方本地 MCP 指引采用 Desktop Extensions，可从高级设置安装自定义 .mcpb。本项目已验证通用 stdio 桥接协议，但尚未制作扩展包、安装或验证实际 Claude Desktop；不能把 Claude CLI 的原生探针当作桌面验收。[Claude Desktop 本地 MCP 指引](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop)（2026-09-30 查阅）。

接入后可问“两台 kanata 各做什么”“哪些任务需要确认”“这个任务的所有者和更新时间是什么”。回复应带任务 UID、所有者、时间依据和看板链接。仅放一个 MD 文件不会使所有新对话自动加载它；客户端工具启用、目录访问和实际查询须逐一验收。原生侧栏内嵌看板没有实现或验证；当前路径是聊天返回任务链接，与看板并排使用。

## Markdown 导出与持续刷新

导出由可信本机进程执行，需要数据库读权限和有效 observe/coordinate 凭据；桌面 stdio 桥接仍不接触数据库。可另发一份专用导出身份。同一获准范围的桌面端可读取同一目录；不同权限范围应分别导出，不混用目录。

~~~powershell
node cli/context.mjs export --db C:/board-data/board.db --credential-file C:/board-data/credentials/context-observer.json --root E:/看板上下文 --board-url http://127.0.0.1:48319/
node cli/context.mjs watch --db C:/board-data/board.db --credential-file C:/board-data/credentials/context-observer.json --root E:/看板上下文 --board-url http://127.0.0.1:48319/ --interval-seconds 30
~~~

watch 默认每 30 秒重新打开只读数据库并鉴权，允许 15–3600 秒；Ctrl+C 停止。它不安装后台服务或计划任务。若凭据撤销、策略改变、节点身份变化或导出失败，进程报错退出，旧完整快照保留，不将旧内容标记为刚同步。授权只证明捕获快照时允许读取；已生成或被复制的 Markdown 不能随凭据撤销而远程收回。

目录父路径必须存在；只支持本地 Windows 盘符路径，拒绝链接和已有非服务内容。新根目录在创建时设置仅当前账户访问、向子目录/文件继承的受保护 ACL；已有目录权限不符会拒绝，不自动调整用户目录权限。同一个 Windows 账户下的其他进程仍可能读取这些文件，因此此机制不是不同桌面应用间的 OS 隔离。

~~~text
context-root/
  ROOT.json
  ENTRY.md
  .retention.json        # 显式启用保留后记录旧代退出入口的时间
  .prune.json            # 仅在清理执行/待恢复时存在
  snapshots/<generation UUID>/
    BOARD.md
    PROJECTS.md
    tasks/<owner UUID>--<task UUID>.md
    manifest.json
~~~

ROOT.json 绑定节点与恢复代次、principal、角色版本/策略摘要、项目范围和看板地址；任一变化须使用新目录。先写完整新代并核对文件摘要，再原子替换 ENTRY.md。旧代不修改，多个读者沿同一入口代读取；不应分别扫描目录并拼接不同代。manifest 记录字节数、SHA-256、生成时间及快照标识。正文以数据块输出，标题转义；不导出令牌、原始供应商请求或私人聊天。

资源上限为 10,000 项任务、32 MiB 上下文、目录总计 256 MiB / 256 代；达到上限停止并保留当前入口。事实、权限和同步时间/状态均未变化才复用旧代。默认不删除历史，30 秒且每轮变化时约 128 分钟可能达到 256 代。长期刷新应显式选择保留策略，例如：

~~~powershell
node cli/context.mjs watch --db C:/board-data/board.db --credential-file C:/board-data/credentials/context-observer.json --root E:/看板上下文 --board-url http://127.0.0.1:48319/ --interval-seconds 30 --retain-generations 32 --retain-minutes 60
~~~

两个 retain 参数必须同时出现：保留至少最近 2–200 代，并让每份快照在退出当前入口后再保留至少 1–10080 分钟。示例保留最近 32 代、至少 60 分钟阅读窗口；新代发布前清理，所以刚发布时可能多出一代，宽限期内还会保留更多。当前 ENTRY 指向的代永不清理。首次启用时，历史代从首次被观察为非当前时开始计时，不能按几小时前的生成时间立即删除。时间异常、近期数据或保留数量条件不足时宁可继续保留，硬上限仍有效。

只有本目录相同身份绑定、具有完整清单且内容摘要一致的生成代可被清理。清理前核对所有候选；未知文件、修改内容、链接或路径替换会拒绝，未完整生成的残留目录保留。删除逐个使用清单内普通文件路径，随后只移除空目录，不递归删除。每代开始前持久记录 .prune.json；文件被 Windows 程序占用或进程中断后，使用相同身份和保留参数重启即可重验并续做已授权清理。修改策略时未完成意图会拒绝，先恢复原策略完成该次清理。普通异常会释放发布锁；进程被强制结束留下的 .publish.lock 仍需操作者核实原 PID 已终止后处理，不能直接删除活动进程的锁。

成功轮次的 JSON 回执包含保留策略、完成清理代数、实际移除字节及是否恢复未完成清理。保留观察文件和意图不包含任务正文或凭据。被清理的历史链接会失效；需要长期保存时先将整代复制到另行管理的归档位置。超过阅读窗口后，应重新从 ENTRY.md 取当前完整代。快照保留不是任务、审计或证据保留策略，不会删数据库事实或提交产物。权限撤销在读取数据库时就会阻止导出和清理。

按示例每 30 秒刷新，一小时宽限期约保留 120 个旧代；若单代很大仍可能先触及 256 MiB。必须根据实际任务规模核对预算，不能靠删除当前快照绕过资源限制。尚未进行大规模性能或 72 小时真实持续运行验收。

尚未实现交接摘要保存、完整 run/执行器/验证/产物追溯、后台自启动与客户端配置部署。任务正文不应被当作客户端配置或可执行指令。任务状态也不能代替 accepted 阶段进度。

## 验证与剩余验收

17 项桌面上下文专项、14 项全局视图和 37 项 MCP 回归，共 68 项本机测试通过，0 失败、0 跳过。覆盖跨项目隐藏、查询不调度、分页变化、独立 stdio/broker 往返、凭据撤销、原子发布、重复导出、被修改文件拒绝、目录权限/链接、孤立代与存储上限；真实 CLI watch 在更新后发布新代、撤销后退出且旧入口保留。Windows ACL 由独立检查器核对，测试没有使用真实供应商订阅。

隔离浏览器验证首次任务链接、已开详情中切换至远端任务以及浏览器返回；同名终端依稳定身份区分，远端正文仍显示缓存时间，恶意标签标题按字面显示。预览已关闭。

仍需两台 Windows 上分别从实际 Claude、Codex、Zcode 新对话查询相同任务，与各自获准看板版本核对；演练真实断线、重连、撤销、多客户端读取、无秘密输出和长期刷新。原生侧栏嵌入需要另外确认客户端扩展能力。完整阶段通过数仍为 0/12，真实执行器最小调用各 0/1；本地测试不替代这些验收。原始桌面接入证据见 desktop-context-evidence.json。本批保留机制完成完整桌面回归 26 项（原有 17 项和新增 9 项），0 失败、0 跳过，见 context-retention-evidence.json；260 次变化使用加速时钟，实际完成文件读写、摘要核对和清理，不替代 72 小时实测。

## 可携带的 Windows 桌面接入包

运行 `npm run desktop:package -- --output C:/fleet-desktop` 可生成不含凭据或数据库的 MCPB 与独立 stdio 文件。构建、第二台电脑只读检查及各客户端配置示例见 [接入包说明](../../packaging/desktop/README.md)。读取工具沿用本机身份权限；`desktop:check` 只返回总览查询结果的身份和数量，不启动任务。解包后的独立运行、Windows 中文/空格路径、权限拒绝与撤销已验证；真实客户端安装、双机应用连通与长期运行仍须另行验收，见 desktop-package-evidence.json。
