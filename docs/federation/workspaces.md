# 本机任务工作区合同

状态：S07 / T07.02 本地部分实现。工作区可准备实际文件、绑定已领取运行，并通过专用 MCP 文件会话生成真实交付提交；跨端产物交付、合并和业务验收尚未完成。部署和全局 MCP 不受这些管理命令影响。

## 本机授权与身份

先登记 `repository` 映射及批准基线，再登记独立工作区池。池配置包括固定 `pool_id`、`mapping_id`、已存在绝对目录 `root` 和必须为 `true` 的 `allow_full_history_copy`。完整副本会包含本机仓库已有历史中的全部对象，包括产物读取范围以外的历史内容；这项权限独立于 `allowed_paths`，只能由本机管理者设置。

池不能与任务源仓库、其 Git 对象目录或其他历史池互相包含。创建具体工作区时另检查与治理仓分离。池路径按原生路径和设备/目录标识固定；相同请求可重放，不能更换路径。恢复换代后旧登记失效，新登记不能覆盖旧池，须使用新的独立目录。没有远端、MCP 或任务文字指定本机目录的入口。

每个实际 dispatch/run 最多一个工作区。准备输入必须对应当前代次、仍为 `prepared` 的原生运行、领取时任务版本和相同项目。绑定保存 task UID、版本、run、agent、仓库映射、完整批准基线与树、声明写入路径及摘要，不能事后替换。工作区 ID 相同且参数相同的请求返回既有状态，不覆盖文件或重新执行准备。

## 文件准备

1. 先提交数据库 `provisioning` 预留与审计，再排他创建 `<池>/<workspace UUID>`。现有目录导致失败，不覆盖内容。
2. 固定 Git 程序及其 SHA-256，以清理后的环境执行本机 `clone --local --no-hardlinks --no-checkout`，使用空模板。源对象目录和副本拒绝符号链接、特殊文件、alternates / http-alternates；副本对象不允许硬链接。副本删除 origin，具有独立 `.git`，不共享工作树对象目录。
3. 直接读取副本中的固定 commit/tree/blob 并核对 Git 内容地址。验证可移植路径、大小写前缀、普通文件模式和 LFS 指针后，以排他文件写入原始字节，保留执行位。使用 `read-tree` 和 `update-ref --no-deref HEAD` 建立索引和 detached HEAD，不调用 checkout、smudge、换行转换或工作树钩子。
4. 核对源/副本身份和基线树，复核落盘文件长度和 SHA-256，提交 `ready`、初始内容清单与审计。原始基线提交 ID 保持不变；源目录未提交和未跟踪文件不会进入副本。

对象复制预检上限为 512 MiB、50000 条目；实际基线最多 4096 文件、单文件 8 MiB、总计 256 MiB、展开路径 10000 项，路径及对象解析沿用仓库读取规则。基线文件内容先批量核对大小，再按 128 个文件/16 MiB 分批读取并验证对象哈希；重复对象仍按每条文件计入总量。完整基线中的不支持项会明确拒绝，不按产物 allowlist 静默跳过。对象读取受 30 秒期限约束，准备 Git 操作总期限 120 秒，单命令最多 60 秒。变化中的源目录可能在复制后检查时被拒；这些检查不是操作系统磁盘配额。超过限制时保留部分目录。

文件系统写入面向可信本机管理进程在执行器启动前准备目录。目录标识和普通文件检查不构成对恶意本机进程的原子文件系统隔离，也不限制未来代码执行器读取其他目录。

## 冲突、启动与保留

`write_paths` 必须位于仓库产物允许范围。`conflicts` 列出同池处于 `provisioning` 或 `ready` 的其他工作区与当前声明的交集，包括目录前缀及大小写。两个任务修改各自副本互不覆盖；这不表示对源仓的合并安全，也不是执行器文件权限边界。声明遗漏或越界修改仍需交付和合并时独立检查。

工作区登记后，API 和 SQL 启动约束均拒绝该运行消费 board-only 许可，错误码为 `WORKSPACE_ADAPTER_REQUIRED`。专用 workspace-files 合同须先准备文件会话并把原始内容与运行身份纳入启动回执；提交启动后 `executor_bound=true`。执行器仍在空目录启动，通过 MCP 读写 SQLite 中的受限文件内容，不声称 agent 在物理 checkout 中执行命令。准备工作区本身不会启动执行器或消费真实模型额度。详见 [文件会话](workspace-files.md)。

准备错误转为 `failed` 并保留已经写入的文件。数据库提交故障仍可能留下 `provisioning` 和部分目录；重放只返回状态，不自动续拷、覆盖或重建。此类崩溃准备需要后续专门恢复流程。该运行不可换 ID 再创建另一目录，需明确终止原运行后重新安排。

`retain` 对 `ready` 或 `failed` 工作区核对实际运行停止证明，再原子记录保留原因、证明及审计；保留记录不可逆改回 ready。未启动运行通过 `abandonPrepared` 结束并获得 `never_launched` 证明；已经启动的运行须通过已结算的监管证明，具体强度见停止证明合同。保留不会删除、重置或移动任何文件，未提交和未跟踪修改均保持。操作故障回滚数据库，重放返回既有记录。它不声称未知第三方进程已经停止，也不等同产物交付或物理磁盘回收。

## CLI

```text
node cli/workspace.mjs register-pool --db <DB绝对路径> --config-file <池JSON绝对路径>
node cli/workspace.mjs create --db <DB> --config-file <工作区JSON绝对路径>
node cli/workspace.mjs get --db <DB> --workspace <UUID>
node cli/workspace.mjs conflicts --db <DB> --workspace <UUID>
node cli/workspace.mjs directory --db <DB> --workspace <UUID>
node cli/workspace.mjs retain --db <DB> --workspace <UUID> --reason <原因>
```

创建配置字段：`workspace_id`, `pool_id`, `dispatch_id`, `base_commit`, `write_paths`。元数据查询不返回本机路径；显式本机 `directory` 命令返回复核目录身份后的路径。所有操作要求显式数据库，不探测或改变实际部署。

## 剩余验收

文件执行配置已经把实际空目录 cwd、文件会话和初始内容摘要纳入启动回执，并生成绑定实际运行的 Git 提交。仍需真实供应商权限验证、Zcode、受限传输和独立复核、原基线 CAS 合并、崩溃准备恢复、保留目录管理和两台 kanata 实体闭环。不能因本地隔离测试通过而宣布 G07 完成。
