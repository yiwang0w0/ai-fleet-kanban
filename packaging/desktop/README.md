# AI Fleet Windows 桌面接入包

这是看板 MCP 的客户端桥接包。需要已有本机代理和专属凭据，不会安装看板、复制数据库、修改网络、启动执行器或调用模型。所有工具权限由本机授权身份决定；用于聊天查看时，请为每个桌面端单独发放 observe 凭据。不要复制另一台电脑的节点数据库或令牌到本机。

## 构建与目录

在源码仓库根目录运行，父目录必须已存在，目标目录必须尚未创建：

    node cli/desktop-package.mjs --output C:/fleet-desktop

构建使用 Node.js 24 内置压缩与校验组件生成 ZIP，只打包随仓库提供的公开文件，不启动 PowerShell 压缩进程，不需要 npm install。归档条目按路径排序，时间固定为 2020-01-01；同一 Node 运行时与相同源码重复构建的摘要一致，跨运行时版本仍应核对收到的 RECEIPT.json。输出目录包含 ai-fleet-board.mcpb、bundle/ 和 RECEIPT.json。这个 README、preflight.ps1 与 cli/ 都位于 bundle/ 内；若只收到 .mcpb，它是 ZIP 格式，解包后直接在包含 manifest.json 的目录运行检查。归档未签名，SHA-256 用于核对传输完整性，不能单独证明发布者身份。

## 包含内容

- `ai-fleet-board.mcpb`：Claude Desktop 可安装的 ZIP 扩展包，无数字签名。
- `bundle/`：相同文件的展开目录，可供 Codex/Zcode 的 stdio 配置使用。
- `RECEIPT.json`：归档摘要。`bundle/FILES.json` 列出公开源文件的字节数与 SHA-256。
- `bundle/preflight.ps1`：只读检查 Windows Node、SQLite、Git、Tailscale；可选检查已配置的本机代理。
- `bundle/cli/desktop-check.mjs`：仅初始化、列工具并查询总览；输出身份、数量和检查结果，不输出令牌或任务正文。

需 Node.js 24 或更新版本。Git 2.45+ 是看板工作区要求；桥接本身不需要 Git、Python、数据库或模型 SDK。Node 程序选择的是可信的 node.exe，不是 Claude/Codex/Zcode 供应商程序。安装包通过固定文件清单生成，不包含工作目录中的 .data、登录配置或订阅信息。

## 第二台 Windows 先做只读检查

将这个包复制到第二台电脑，在展开后的 bundle 目录运行：

    powershell.exe -NoLogo -NoProfile -File .\preflight.ps1

也可指定已有程序，例如 -NodePath 'D:\tools\node.exe'。脚本遵守本机执行策略，不自动放宽策略或安装软件。报告会包含计算机名、Tailscale 稳定设备 ID 和在线状态，请保存在自己的验收目录，公开分享前检查内容。默认不输出 tailnet IP、DNS、用户列表或凭据。它不向其他节点发任务，不能单凭这个报告证明看板已连通。

准备完本机观察凭据和代理后再检查：

    node cli/desktop-check.mjs --url http://127.0.0.1:48320 --credential-file C:/board-data/credentials/desktop-observer.json

或者在 preflight.ps1 后同时添加 -BrokerUrl 与 -CredentialFile。ready 表示本机代理认证及三项桌面查询工具可用；actual_desktop_client_verified 仍为 false，需要在实际桌面聊天中验证。

## Claude Desktop

打开 ai-fleet-board.mcpb 安装，或在 Settings → Extensions → Advanced settings 中选择本地扩展包。填入可信 Node 24+ 程序、本机 MCP 代理回环地址和本客户端独有的凭据文件。MCP 代理端口与网页端口不同；不填 Tailscale 地址、网页 operator token 或供应商 API key。扩展包未签名，若组织策略不允许，保留包并由管理员按现有策略处理，不关闭保护。

完成后检查连接状态，并从新对话询问“请通过 fleet 看板查询当前终端和任务数量”。需要核对实际工具调用、节点身份和来源时间；扩展安装成功不等于任务已执行、另一台看板已同步或阶段已验收。

## Codex 本地桌面/CLI

在本地 MCP 设置中添加下面的 command/args，使用该电脑实际展开目录与自己的凭据文件。TOML 是合并示例，不要覆盖整个已有配置；在线 ChatGPT 不会自动读取此本地配置。

    [mcp_servers.fleet-board]
    command = "C:/Program Files/nodejs/node.exe"
    args = ["C:/fleet-desktop/bundle/cli/mcp.mjs", "--url", "http://127.0.0.1:48320", "--credential-file", "C:/board-data/credentials/codex-observer.json"]

## Zcode

在 MCP 服务设置选择所需作用域，填写相同 command/args，但换成 Zcode 的独立凭据文件。以下是原生配置片段，需合并到已有 mcp.servers，不能覆盖其他服务。

    {
      "mcp": {"servers": {"fleet-board": {
        "command": "C:/Program Files/nodejs/node.exe",
        "args": ["C:/fleet-desktop/bundle/cli/mcp.mjs", "--url", "http://127.0.0.1:48320", "--credential-file", "C:/board-data/credentials/zcode-observer.json"]
      }}}
    }

每个客户端启用/重载后，实际调用 get_board_overview、list_tasks、get_task_context，核对授权范围、所有者与缓存时间。未连通时应明确失败，不从旧聊天编造状态。当前包不嵌入原生侧栏；聊天可返回看板任务链接，与看板并排使用。Markdown 目录由看板 context export/watch 另外生成，不能把它当作模型配置。

## 依据与范围

格式依据 [MCPB manifest](https://github.com/modelcontextprotocol/mcpb/blob/main/MANIFEST.md) 0.3；客户端参考 [Claude Desktop 本地 MCP](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop)、[OpenAI MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)、[Zcode MCP](https://zcode.z.ai/cn/docs/mcp-services)，2026-09-30 核对。接入包与源代码采用 Apache-2.0 许可。

未在这个包中携带服务端、生成真实授权或更改全局设置。真实桌面安装、双机联调与模型任务必须分别保存实际结果，不能用包内协议检查替代。

## 聊天中继续查看历史

升级到提供 get_task_evidence 的本机代理后，重新连接客户端并检查 tools/list，即可按任务 UID 分页查询运行、产物和回执。stdio桥接动态读取工具清单，不需要加入其他权限或修改凭据文件。使用 page.next_cursor 和相同 limit 继续，收到 EVIDENCE_CHANGED 后从第一页重查；详见 [桌面上下文合同](../../docs/federation/desktop-context.md)。旧预检的 ready 只证明原三项基础查询，不作为新工具或实际客户端联调证明。
