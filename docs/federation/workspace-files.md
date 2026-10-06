# 受限 MCP 文件会话与运行交付提交

状态：T07.02 / T07.03 本地部分实现，未通过 G07。Claude/Codex 已有文件会话启动配置及进程夹具证据；真实供应商执行、Zcode、跨端传输与来源验收仍需完成。所有实际文件证据与模型调用证据分别记录。

## 执行方式

本机管理者先创建绑定实际 task/run/dispatch 的独立工作区，再用 `prepare-files` 导入批准基线中允许读取的实际 Git 字节。会话描述固定原基线、完整基线清单摘要、节点代次、身份和读写路径。SQLite 中的 BLOB 是本次 MCP 编辑的内容；独立仓库中的初始 checkout 保持原样。

角色明确声明 `capabilities: ["workspace-files"]`。`dispatch execute` 从当前数据库读取该分派的文件会话描述，不接受任务文字传入另一目录或会话。启动记录升级为 `ai-fleet-process/v2`，包含 `workspace_id`、`descriptor_digest`、`base_commit`、`baseline_digest` 和 `access: "mcp-files-v1"`；合同为 `ai-fleet-adapter/workspace-files-v1`。任务版本、源代码审批、角色、额度、初始字节、物理基线和描述必须仍然匹配。执行回执、工作区启动绑定、一次性额度消费在同一事务，SQL 也阻止没有绑定的启动。

Claude/Codex 仍从独立空目录启动，通过唯一 fleet MCP 访问本次文件。原生命令入口受限；Codex 关闭 view_image，但部分模型仍暴露 apply_patch，由只读 sandbox 拒绝写入，具体实测及 Claude 未完成核验边界见适配器合同。角色的 read-only 限制在文件工具层执行。这个合同不提供 shell、测试命令、操作系统文件沙箱或跨端任意路径访问，也不声称第三方 CLI 的权限已经通过真实模型验收。启动参数、配置、凭据和程序摘要沿用 [适配器合同](adapters.md)。

## 文件工具

全部工具要求实际运行凭据、相同 task UID、当前项目/角色版本以及仍在进行且未取消的运行。coordinate/observe 不获得文件工具；implement/review 只有声明 workspace-files 才有读取工具。写入仅允许 implement 且 tools=write。结束任务、替换运行、撤销身份、取消或恢复换代后拒绝新读取和写入。

| 工具 | 输入和结果 |
|---|---|
| get_workspace | 返回当前 revision、文件数量/字节量、读写范围和容量；不返回本机路径 |
| list_workspace_files | expected_revision、after_path、limit（1–100）；返回文件版本/摘要/模式及删除标记，分页期间发生编辑则要求重新开始 |
| read_workspace_file | path、expected_version、offset、limit；读取 UTF-8 文本片段，返回 next_offset/eof；长度以字节计并保持字符边界 |
| edit_workspace_file | request_id、path、expected_version、offset、delete_bytes、content、executable；新文件 version=0，修改成功递增版本 |
| delete_workspace_file | request_id、path、expected_version；保存删除标记，保留原基线摘要与版本，重建须使用删除后的版本 |

每次写入核对原字节 SHA-256、精确版本和声明范围。文件及目录名拒绝路径穿越、保留名、大小写和文件/目录前缀碰撞；历史删除名也参与检查。UTF-8 字节切片要求字符边界。文件 BLOB、版本、会话 revision、文件事件、MCP 审计和幂等回执原子提交，任一失败全部回滚；同一请求只能产生一次编辑。事件保存版本/摘要，不保存全部历史文件内容，不能据此宣称具备任意版本撤销。

| 边界 | 限制 |
|---|---|
| 单文件 | 8 MiB |
| 每次插入/读取片段 | 64 KiB，读取最小 limit=4 |
| 可访问基线和当前总内容 | 32 MiB |
| 会话历史文件名 | 4096 |
| 每次运行修改次数 | 512 |
| 累计写入量 | 64 MiB；每次计入修改后的完整文件长度，连续编辑大文件会更早达到限制 |
| 单次交付净变化 | 256 文件、32 MiB |

HTTP 网关请求 JSON 另有 128 KiB 边界，MCP 响应另有 512 KiB 边界；含大量转义字符时可能先触及网关边界。读取二进制文件会被拒绝；此配置面向 UTF-8 源码。容量检查不是操作系统磁盘配额。

## 从会话生成实际提交

`commit` 只接受已结算并具备可信停止证明的本次运行；provider 模式的未知清理结果不能通过，fixture 证明明确标识。报告已结束但进程未结算时仍不能生成提交。提交可保存失败或取消运行的实际输出，不能据此将其改报成功。

本机受信代码用独立 Git index 从原始基线构建新树，对会话净变化执行固定的 hash-object/update-index/write-tree/commit-tree；新增和删除文件、原始字节及执行位进入真实 Git 对象。固定父提交、运行标识、会话摘要、revision 和完成时间使故障后重建获得同一提交 ID。不执行 checkout、过滤器、hook、签名或网络获取，不改物理 checkout、HEAD、其真实 index 或未跟踪文件。

随后重新读取 commit/tree/blob 实际内容，复核完整目录与“原基线加声明净变化”一致，保存本地 `refs/fleet/workspaces/<UUID>` 和不可变交付清单。清单绑定 node/epoch、task、run、dispatch、agent、仓库、基线、新 commit/tree、文件内容 SHA-256、启动/进程结果摘要和停止证明。Git 对象与 SQLite 无法跨系统原子提交；数据库故障时保留对象和引用，重放只补记同一结果，遇到引用冲突拒绝覆盖。本次 commit-* 临时目录在 Git 生成的成功与失败路径均清理，且在交付清单落库前完成清理；只删除该次新建目录中已知的 index / index.lock，再移除空目录，不递归扫描或清除旧目录。路径/目录身份改变、未知内容或删除失败时返回 WORKSPACE_COMMIT_CLEANUP_FAILED，保留现场与已生成对象/引用，不写交付清单；原有操作异常保留为 cause。断电或进程强制终止仍可能遗留临时目录，需本机核查，不能据此自动删除任意 commit-*。

`manifest` 会从仓库重读完整交付目录和交付文件字节并核对摘要，然后只输出元数据。内部 `captureWorkspaceCommit` 返回实际字节供后续传输接入。`accepted=false`、`transferred=false`；当前候选报告协议尚未携带该文件交付。未完成远端安全落盘、断点续传、独立测试、来源 CAS 合并、正向验收或关系退役。

## 管理命令与迁移

```text
node cli/workspace.mjs prepare-files --db <DB绝对路径> --workspace <UUID>
node cli/workspace.mjs commit --db <DB绝对路径> --workspace <UUID>
node cli/workspace.mjs manifest --db <DB绝对路径> --workspace <UUID>
```

工作区 schema 1 显式升级为 2，保留原池、工作区、内容清单及事件。迁移失败回滚全部 schema 变化；未知版本拒绝。旧版本查询先拒绝，需要通过工作区管理初始化迁移。已有 v1 board-only 运行不能被追加绑定成文件执行。备份保留 SQLite 文件内容、启动绑定与交付记录；恢复换代后的旧会话仍不可继续使用，物理仓库需要单独保留，不包含在数据库备份内。

本机测试包含真实临时 Git/SQLite、回环 MCP、受监管 Node 合成进程实际编辑、实际提交文件在另一临时目录加载运行、独立进程竞争、启动与写入回滚、journal 恢复、CLI、数据库重开和恢复换代。Node 故意接收供应商选项并退出的 runner 测试仅证明失败路径与 v2 回执，不是真实 Claude/Codex/Zcode 调用。准确范围和计数见 [测试证据](workspace-files-evidence.json)。
