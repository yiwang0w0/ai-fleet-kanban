# 本机 MCP 工具与角色代理（首批）

对应 AFK-FED-001 的 T04.01 / T04.02。当前实现可创建受限任务、请求身份路由、读取获准数据及回写已绑定运行实例；实际模型调度、操作系统隔离和完整 G04 验收仍待完成。三种模型的真实最小任务各 0/1，本说明不触发模型调用。

## 进程和信任边界

MCP 客户端启动 cli/mcp.mjs，使用 stdio 通信。该进程只接收回环代理地址和一个受限凭据文件，不接收数据库路径、operator token 或任意执行命令。它通过内部回环 HTTP 接口请求可信代理 cli/mcp-admin.mjs serve；只有代理及本地管理命令持有数据库权限。

内部 /local/v1/tools/list 与 /local/v1/tools/call 不是 MCP Streamable HTTP。代理仅允许 127.0.0.1 或 ::1；CLI 默认 127.0.0.1，端口必须显式指定。代理拒绝浏览器 Origin、重复 Authorization、未知接口/字段、压缩正文、非法 UTF-8 和超过 128 KiB 的请求。上传最长五秒；上传结束后在事务内重新鉴权。stdio 仅输出 JSON-RPC，诊断写 stderr。

stdio 到 broker 的请求使用独立的 Node HTTP Agent，并显式关闭代理配置，不使用全局 fetch、全局 HTTP Agent 或环境代理。仅接受数字回环根地址，不跟随重定向；保留 10 秒请求期限、1 MiB 响应上限、严格 UTF-8 和节点/epoch 核对。参见 [Node 24 的代理配置说明](https://nodejs.org/docs/latest-v24.x/api/http.html#built-in-proxy-support)。这些是传输控制，不提供 OS 网络隔离。

凭据绑定 node_id、node_epoch、principal_id、角色版本、项目集合；执行身份还绑定 agent_instance_id 和 run_id。代理不信任 clientInfo、工具参数或任务文本声明的身份。数据库只保存令牌 SHA-256；授权命令只输出非秘密身份信息，令牌写入新文件且不覆盖已有文件。 Windows 凭据与 peer 使用同一原生 CreateNew/受保护 DACL 写入器，先在句柄上核验当前账户独占授权，再写入秘密；保护不可用则回滚 principal 和审计。仅新发文件受此流程保护，不自动修改已有凭据。角色策略修改、凭据撤销、节点退役/恢复换代、任务重新领取都会使不再匹配的身份失效。

这是看板工具授权边界。同一个 OS 用户若仍可直接访问数据库、其他凭据或任意工作目录，可以绕过这层控制。tools=read-only 目前是工作区意图声明，不能据此声称文件系统已只读。Windows ACL、隔离用户/容器和执行器能力限制需要在 S04/S07 单独验收。

## 工具合同

工具输入均有 JSON Schema，拒绝未知字段。查询只能读取该凭据授权项目；执行身份只能操作凭据绑定的本地任务/run。任务输出去掉 verify_cmd、私有 evidence_path、治理字段和令牌。

| 工具 | 可调用身份 | 行为 |
|---|---|---|
| list_nodes | coordinate、observe | 本机身份与授权项目中已观察来源 |
| list_roles | 四类身份 | 授权项目中的角色能力、策略版本和声明运行时 |
| get_task | 四类身份 | 本机任务或只读远端投影；执行身份仅自己的任务 |
| get_board_overview / list_tasks / get_task_context | coordinate、observe | 获准桌面总览、分页检索与上下文；仅本地登记任务及获准远端缓存，含来源时间和任务链接 |
| get_sync_status | coordinate、observe | 项目游标、恢复/结构提交状态和最近 100 个路由请求 |
| create_task | coordinate | 创建本机未放行任务或目标；不自动共享 |
| split_task | coordinate、implement | 版本匹配的父任务下创建未放行子任务；执行身份父卡须仍在执行 |
| prepare_topology | coordinate | 准备授权项目的父/依赖修改；持久保存待提交状态，不发起网络请求 |
| request_assignment | coordinate | 按声明生成路由记录；不启动执行器 |
| create_delegation | coordinate | 固定本机任务合同并提出委派；不自动发送 |
| decide_delegation | coordinate | 接受/拒绝本项目接收意向；接受仍等待关系确认 |
| get_delegation | coordinate、observe | 读取获准项目的双端合同与回执 |
| list_bindings / get_binding | coordinate、observe | 查看授权项目的端点绑定和当前条件 |
| prepare_binding | coordinate | 核对实际接受合同和任务版本，准备本方绑定 |
| release_delegation | coordinate | 仅放行满足双方证明、当前授权与本地结构条件的接收任务；不启动模型 |
| heartbeat | implement、review | 对绑定 run 续租五分钟 |
| report_result | implement、review | done 进入待审阅；wait 进入待决策；两者均未验收 |

每个写工具要求 request_id UUID。相同凭据、相同 request_id 和相同参数的重试返回原有结果；改换工具或内容返回 REQUEST_CONFLICT。创建/回写、任务事件、项目登记、成功审计和去重回执在同一事务；提交失败全部回滚。原生 store.add/report 在外层事务中使用 SAVEPOINT，原有独立调用仍自行提交。

失败和重试也消耗调用次数；每个身份每分钟 1–300 次，保存在数据库中。角色限制项目当前未完成卡数 1–1000、创建卡最大尝试数 1–10。这些限制不构成模型 token/费用总预算，也没有启动模型。

子卡必须属于父卡项目。新 MCP 根采用 hierarchical，子卡继承模式，深度最多 32 条边；超限拒绝且不改挂。历史登记任务继续遵守 legacy 两层创建规则，需要上浮时 MCP 返回 CHAIN_LIMIT。模式不可静默转换；完整语义见 [本机多层任务树](trees.md)。相同父卡下规范化同名子卡返回 CONFLICT。绑定关系登记节点的项目使用 [本地结构提交](topology.md)：split_task 原子创建孤立未放行子任务并保存 placement_pending，只有匹配登记回执提交后才出现实际 parent_uid。执行身份仍可在自己的运行父任务上提出子任务，父任务最终完成等待结构提交；prepare_topology 只向 coordinate 开放。

尚未开放 delegate_task、request_cancel、get_evidence、最终验收、角色管理或 shell 工具；这些不能由客户端绕过输入合同调用。

## 确定性路由

任务项目、work_kind、required_capabilities 由创建时或本地 enroll 时登记，不能由后续 MCP 参数静默覆盖。候选角色必须启用、属于同一项目、身份种类匹配、包含全部所需能力；按 priority 升序、再按 ASCII role_id 升序选取。runtime/model/effort 从该角色声明复制到不可变请求快照，不从任务文本推断，也没有跨供应商后备。

request_assignment 要求当前 expected_version，且任务未开始、未归档、kind=task。输出状态：

- waiting_policy：没有满足能力和项目的启用身份；
- waiting_release：有匹配身份，但任务尚未放行；
- waiting_executor：已放行，等待受控执行器；
- dispatch_started 始终为 false，当前版本不自动领取或启动。

同一当前任务/角色策略返回同一有效请求；新任务或策略版本会取消旧等待请求并留下记录。后续真正领取仍必须重验任务版本、角色策略、放行、配额、源代码闸和实际执行器可用性。不能把 waiting_executor 当作已成功执行。

## 本地配置示例

使用 Node 24。以下路径为说明占位符，须替换为专用测试或已批准部署路径。不会编辑 Claude、Codex、Zcode 的现有全局配置。不要把代理、受限凭据或旧 operator UI 经 Tailscale Serve 公开。

最小协调角色文件 role.json：

    {
      "role_id": "coordinator",
      "kind": "coordinate",
      "projects": ["demo"],
      "capabilities": [],
      "runtime": null,
      "model": null,
      "effort": null,
      "tools": "write",
      "priority": 10,
      "enabled": true,
      "limits": {
        "max_task_attempts": 1,
        "max_open_tasks": 20,
        "requests_per_minute": 60
      }
    }

本地操作者显式登记角色、发凭据、启动代理：

    node cli/mcp-admin.mjs role --db C:/board-test/board.db --policy-file C:/board-test/role.json
    node cli/mcp-admin.mjs grant --db C:/board-test/board.db --role coordinator --projects demo --credential-file C:/board-test/credentials/coordinator.json
    node cli/mcp-admin.mjs serve --db C:/board-test/board.db --port 48320

数据库须是本节点有效、未隔离且未退役的看板数据库；路径必须绝对，凭据父目录需预先存在且限制其他身份访问。serve 不管理长期运行、自动启动或系统防火墙。

客户端 stdio 配置示意：

    {
      "mcpServers": {
        "fleet-board": {
          "command": "C:/Program Files/nodejs/node.exe",
          "args": [
            "C:/board-code/cli/mcp.mjs",
            "--url", "http://127.0.0.1:48320",
            "--credential-file", "C:/board-test/credentials/coordinator.json"
          ]
        }
      }
    }

更新角色需 --version <所见角色版本>，旧凭据随即失效。撤销使用 revoke --db <绝对路径> --principal <ID> --version <凭据版本>。已有任务登记使用 enroll --db <绝对路径> --task <数字ID> --project demo --work-kind implement --capabilities board-tools --version <当前任务版本>；父卡应先登记同项目，不能改变已有登记。

implement/review 角色必须声明 claude、codex 或 zcode 以及已核实的 model/effort；review 必须 tools=read-only。执行角色的 capabilities 必须且只能选择 ["board-tools"] 或 ["workspace-files"] 一个配置，与适配器共用支持集合；空数组、组合配置、code、shell-anything 等其他值在角色登记前返回 BAD_INPUT。workspace-files 已包含该角色所需的看板工具，无需再添加 board-tools。业务技能名称不构成工具授权。执行凭据 grant 还要求 --run <实际运行ID>。该 run 必须由可信调度器写入匹配的 broker_role_version / broker_role_digest 策略上下文。该上下文由受控 dispatch prepare 原子生成；其运行凭据必须等一次性启动许可提交后才能调用 MCP 工具。实际执行器监督与适配未完成；参见 [受控调度](dispatch.md)，不要手工伪造 run。

## MCP 协议与验证

stdio 实现版本协商、initialize / notifications/initialized、ping、tools/list、tools/call 和 EOF 退出；声明 tools 能力，无资源、采样或提示词能力。支持 2025-11-25 和 2025-06-18。未知工具、无效协议请求使用 JSON-RPC error；参数/权限/业务失败返回工具 isError；通知绝不执行任务写入。会话最多记录 10000 个唯一请求 ID，重连后的写入重试依靠持久化 request_id 去重。

规范依据为 [MCP 生命周期](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle)、[stdio 传输](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports) 和 [工具合同](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)。这是所实现的已检查版本，不声称是当前全部 MCP 功能或最新版本。

运行 npm run test:mcp。测试使用临时数据库、真实回环 HTTP、独立 stdio/管理 CLI 子进程和并发请求，不连接模型。覆盖角色版本/范围、撤销中途上传、旧 run、幂等与冲突、预算、同名/超深子卡、报告回滚、进程重试、恢复后凭据失效、中文分帧和输入边界。完整结果与源文件摘要见 mcp-evidence.json。

委派工具不提供节点凭据、任意 URL 或执行启动。接收决定受项目配额和幂等回执约束；具体状态与未确认执行保护见 [委派合同](delegation.md)。

端点绑定及放行的完整顺序、旧接受回执与当前条件的区分见 [双方端点绑定](bindings.md)。网络投递不向 agent 开放任意 URL 或凭据文件。

未准备绑定提案提供 get_binding_proposal（coordinate/observe）及 decline_binding_proposal（coordinate）。拒绝要求审核的精确摘要和固定原因码，与审计、MCP 回执同事务提交；不能代替来源登记撤回。list_bindings 将当前待办与最近历史分别返回。见 [提案拒绝与保留](proposal-decisions.md)。

已确认委派取消新增 get_cancellation / list_cancellations（coordinate、observe），request_cancellation / progress_cancellation（coordinate）。接收回执不等于停止证明，写入与审计和工具回执原子提交；恢复后的历史带 identity_current。完整合同与未决限制见 [取消与停止证明](cancellation.md)。

候选报告新增 get_result / list_results（coordinate、observe）及 prepare_result / reject_result（coordinate）。返工决定绑定来源当前版本和精确候选；执行端持久接收决定后才原子重开任务，工具不启动模型、不提供最终通过验收。见 [候选结果与返工](results.md)。

仓库元数据新增 get_repository(project_id, repo_id) / list_repositories(project_id, limit)，仅 coordinate / observe 可按项目读取已登记仓库、批准基线及当前代次标识。不会返回本机路径、Git 程序或文件内容，也不提供登记/批准入口。见 [仓库映射与内容读取](repositories.md)。

专用 workspace-files 执行身份新增 get_workspace / list_workspace_files / read_workspace_file；implement 且 tools=write 另有 edit_workspace_file / delete_workspace_file。版本和字节写入与 MCP 回执原子提交，不开放本机路径或 shell。详见 [文件会话合同](workspace-files.md)。


## 已存角色的升级检查

本机管理员可执行 `node cli/mcp-admin.mjs roles --db <绝对数据库路径>`，查看角色所见版本、摘要及 valid 标记。此命令不输出凭据；无效角色返回 POLICY_INVALID 诊断，不把未经验证的策略 JSON 当作有效策略展示。

授权、凭据认证及 dispatch prepare/launch 均重新验证已存策略的字段、能力、角色标识和摘要。未知旧能力（例如 code）不会自动转换为文件或 shell 权限，也不能因为此前已登记或已有凭据而继续执行。MCP list_roles 与候选选择只纳入有效角色，单个旧角色不会阻止其他合法角色被选中。

修复须由本机管理员核对权限后，准备符合当前合同的角色 JSON，并使用 `role --db <路径> --policy-file <JSON> --version <所见角色版本>` 显式更新。旧版本或省略版本会拒绝；成功更新使旧凭据和旧分派策略失效，需要重新核对及授权，不自动重启任务。能力不满足的新旧任务仍停在 waiting_policy；任务的 required_capabilities 是匹配需求，不能扩展角色工具范围。已有任务登记保持不可变，不对旧 code 需求自动赋予新权限。


审阅补充：输入 schema 明确检查 boolean，executable 只接受 true/false；字符串或数字不能在工具入口被宽松转换。运行身份查询或修改其他任务，与未知 task_uid 使用同一 NOT_FOUND / HTTP 404 正文，避免错误差异暴露任务存在性。角色无权使用某个工具仍返回 FORBIDDEN；该处理不承诺恒定时间响应。相关回归见 review-mcp-boundaries-evidence.json。

桌面查询、按身份绑定的 Markdown 版本导出及客户端接入示例见 [桌面聊天上下文](desktop-context.md)。serve 可选 --board-url <回环 HTTP 根地址>，仅用于生成无凭据的任务链接，不启动 UI，也不扩展其权限。
