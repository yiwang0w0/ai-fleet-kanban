# Zcode Windows 接入记录

已接通 Zcode 0.16.9 的单次启动适配、角色 MCP、进程监管和一次性调度回执。安装 bundle 的 SHA256 为 fad4c35c4c36ec210d8a06d3fa0e77de23c8545e2eb6ff90aea1eb38d1e6275f，公开供应商配置为 schema 1 / revision 30。实际安装包已与本机假模型接口及 MCP 服务完成一次工具往返；现有订阅登录和真实模型任务尚未验收。

## 启动合同

运行配置使用现有 dispatch execute 入口。installation.runtime 为 zcode、version 为 0.16.9；program 是固定 Node 原生程序，另需 bundle 和 builtin_config 两个 {path,sha256}。auth_home 指向常规登录目录 .zcode/v2；不读取、复制或解密令牌。安装版本及文件摘要由本机操作者核验，版本字符串本身不能证明程序身份。

角色模型明确为 GLM-5.3 或 GLM-5.3-Flash，effort 为 low、high 或 max。这两个具体模型的公开规则覆盖了通用 disabled/enabled 规则，不能按通用规则映射。生成配置只保留 account:bigmodel-individual-coding-plan、一个模型和一个 reasoningLevel 值，个人模型/供应商列表为空，从注册表范围限制默认模型回退。只接受中国版订阅账号类型和公开官方端点，拒绝 API key、额外认证字段或端点覆盖。

用户 HOME、USERPROFILE、AppData、临时目录、CLI 配置、存储及会话 DB 均在本次新建私有目录。ZCODE_DATA_BASE_DIR 单独指向现有常规账号仓的根；该路径的真实登录兼容性仍待最小真实任务验证。执行目录须为空，祖先含 .env、.mcp.json、zcode.json 或 .zcode/config.json 时拒绝。生成文件排他新建，失败时只清理本次新建内容。

CLI 显式使用 --mode plan --output-format stream-json，并按已检查的完整原生工具注册表传入 --disallowed-tools，包含文件、命令、浏览器、子 agent 和 workflow 工具。禁用插件、skills、hooks、memory、compact 和 rewind，仅配置 fleet MCP。模型任务不能选择程序路径、配置或额外服务器。

本机假接口观察到的工具列表只有指定的 mcp__fleet__ping；Zcode 实际调用了该工具，并在第二次本机请求中带回结果。该工具被标记 readOnlyHint=false / destructiveHint=false，证明 plan 模式允许此类 MCP 操作；角色权限由看板 broker 的实际授权和工具过滤决定，不能把 plan 名称当成只读屏障。先前 build 模式探测即使配置 allowedTools 仍拒绝该工具，因此不以 allowedTools 单独声称权限已生效。

## Windows 启动与停止

可信 zcode-launch.mjs 从 stdin 读取提示，在启动安装 bundle 前再次检查 Node、bundle、cwd 和提示摘要。禁止 slash 命令，提示最多 12000 个 UTF-16 单元，并检查保守的 Windows 参数总长预算。完整提示不写入启动摘要；供应商仅提供 --prompt 入口，因此提示仍会出现在其本机子进程 argv 中。启动使用固定程序和参数，不经过 shell。

准备配置、公开配置、bundle、启动器及配置模块摘要随一次性许可绑定。篡改在许可消费前拒绝；许可提交后的启动失败、非零退出、超时和取消均占用额度，不自动重试。原始网络事件可能含请求头，不发布原始日志；回执只保存规定字段和摘要。

Windows Job 管理启动器、供应商及普通后代。测试覆盖配置/提示篡改时不创建供应商子进程，Unicode 和引号传递，供应商退出码传播，以及取消时三层进程全部停止。Job 确认 job_empty 只证明该 Job 内的进程清理，不提供文件或网络权限隔离。

## 输出合同

headless-stream 必须提供 expectedPromptSha256、expectedProvider 和 expectedModel；不能与 RPC session/input 绑定混用。安装包会在 turn.started 前发 session.titleUpdated，解码器记录其身份，再与正式任务开始核对；标题事件不能提供任务成功证据。任务提示、session、turn、trace、连续序号和唯一 eventId 均受检查。

成功需要同一任务的模型请求元数据、明确 resultType=success、非空 response、身份和正文匹配的最终 type=result 摘要及退出码 0。摘要 eventCount 不等同于整个 observer 回调数。控制/后台任务、steer、第二任务、缺少摘要、错模型、未知事件、重放和跳号拒绝。

expectedTools 可绑定 fleet 工具集：模型请求的工具数必须匹配，每次 scheduled 调用必须在允许列表内，后续工具事件必须引用已观察到的同一调用。数量匹配本身不证明请求里的完整工具名称；请求前约束来自固定注册表和本机 MCP 授权。expectedMcpServer 不适用于此协议。usage 尚无完整真实映射，保留 null；解析回执 real_model_call_confirmed=false，不充当实际调用或计费证明。

## 验证记录

- 自动回归：输出 38、适配 24、Windows 进程监管 21、调度/回执 40，共 123 项通过，0 失败、0 跳过。14 项为本批新增。完整最终提交回归交由 Windows CI。
- 实际 Zcode 0.16.9 + 新启动器：空账号仓、本机回环假 Anthropic SSE 接口和 stdio MCP，2 次本机请求、1 次工具调用、32 条事件、子进程退出 0，Windows Job 清空。既无真实模型请求，也未复用现有凭据。生产配置仍只允许官方端点，假端点仅存在于私有探测脚本。
- 完整 prepareAdapter → executePreparedDispatch → Windows 子进程 → 持久回执和额度链使用合成供应商验证，覆盖成功、失败、篡改拒绝和不可重启。不能将它写成真实供应商的完整调度验收。
- 上一批准确提交 1a4ed45 的 Windows CI 已通过 1441 项主测试、90 项附加检查及 gitleaks；历史证据保留在 zcode-headless-evidence.json。当前证据见 zcode-evidence.json。

先前 app-server 空会话及无账号 /model 启动失败的记录仍保留。app-server 账号由桌面宿主提供，普通 --prompt 使用 standalone 常规登录仓。/model 在带账号时会走模型创建，不能作为零调用预检；app-server 请求 plan 后曾观察到 build，也不作为本次 headless 权限依据。

当前真实调用 Claude/Codex/Zcode 均为 0/1，完整阶段验收 0/12。剩余为真实订阅兼容、授权模型任务、Windows 权限隔离及两台实体机的完整联调；后续仅支持 Windows。

产品说明见 [账号与模型配置](https://zcode.z.ai/cn/docs/configuration) 和 [MCP 服务](https://zcode.z.ai/cn/docs/mcp-services)。具体 CLI 行为以固定安装包和上述本机测量为依据。
