# 来源 Git 合并及故障恢复（Windows）

来源端在 [独立检查](verification.md) 通过后，可将实际交付合并到本机明确批准的 Git 引用。执行端候选不能选择来源路径或引用；引用必须已存在并指向本机批准基线，而且由来源合并服务独占管理。允许小写 `refs/heads/…` 或 `refs/ai-fleet/integrations/…`，拒绝 HEAD、远端引用、符号引用和大小写别名。

本模块记录 `source_applied`，所有返回仍是 `accepted:false`。Git 已合并不等于业务任务通过；正向裁定、关系退役、父任务推进及 Windows 权限隔离仍是独立待完成项。

## 本机流程

本机配置 JSON 只含：`policyId`、`mappingId`、`ref`、`poolRoot`、`allowVerifiedContentMerge:true`、`exclusiveRefManagement:true`。新配置和运行使用新 UUID。poolRoot 是已存在的绝对目录，不能与来源仓库、Git common directory、治理代码或数据库重叠。仓库和 Git 程序沿用已批准 mapping，并固定来源目录的文件系统身份。

1. `node cli/integration.mjs policy --db <来源DB> --config <绝对配置JSON> --accepted-rev <治理树验收文件>` 登记本机合并许可。引用的初始创建、基础版本和保护策略由来源管理者明确选择，本命令不自动创建或猜测分支。
2. `prepare --db … --policy <UUID> --verification <验证UUID> --id <合并UUID> --accepted-rev …` 重新检查独立验证回执、当前任务/授权及实际输入，再持久化合并意图。在新的私有目录使用独立临时索引导入实际产物对象；不写来源索引或工作目录。
3. `apply --db … --id <合并UUID> --accepted-rev …` 先持久化单次启动，再在来源 DB 写事务中重查当前授权，执行 Git 旧值校验更新并记录实际观察。基线不一致、目标已被工作区占用或许可撤销即停止。
4. `get --db … --id …` 查看历史。后续消费者需用 `check --db … --id … --accepted-rev …` 重新核对当前任务/授权、实际合并对象及来源引用，不能直接把历史通过记录当作当前验收许可。
5. Git 可能已更新但 DB 回执未保存时，`reconcile --db … --id … --accepted-rev …` 只读取实际 Git 结果并结算原意图；它不再次更新引用。若实际引用仍在基线或指向其他内容，保留启动占用并报告未确认，不覆盖并发工作。
6. `abandon --db … --id … --reason …` 只适用于从未提交启动的准备。目录和对象保留，新意图可使用原验证回执而不重新调用模型。提交启动后，即使缺少回执，也不能放弃后自动重跑。
7. `revoke --db … --policy <UUID>` 撤销配置。已发生的 Git 更新不会自动反向回滚。恢复时若发现已合并但权限已过期，记录实际事实和失效原因，仍不能进入正向验收。

完整参数见 `node cli/integration.mjs --help`；CLI 固定以自身代码根执行治理源码闸，不修改现有 accepted_rev。

## 对象与提交证据

导入重新读取本机批准基线，校验真实包、Git 原始提交/父提交/tree/blob、净文件变化和完整内容摘要。固定 Git 禁止 hooks、网络协议、懒加载、外部 diff、checkout/过滤器，并以登记的 `GIT_DIR` / `GIT_COMMON_DIR` 固定对象库和引用位置，避免关联工作区 `.git` 指针变化将命令导向其他仓库；使用私有 `GIT_INDEX_FILE`，避免将来源已有暂存或未提交内容混入产物。

来源生成一个内容可复算的合并提交：tree 精确等于验证过的交付 tree，第一父提交是原始来源基线，第二父提交是实际交付提交。提交正文含合并 UUID、来源节点/epoch、任务 UID/版本、产物清单摘要、验证回执摘要和治理树。绝对本机路径不写入提交正文。

此合并提交同时标识一次来源更新的意图。Git 只 CAS 更新一个引用，不依赖“目标引用加标记引用”能在崩溃中一起出现。正常重放不重新合并；Git 已成功而 SQLite 事务回滚时，可根据实际引用是否精确指向该绑定提交恢复原回执。内容、父提交、验证摘要或源引用不符均不能当作成功。

实现使用 [git update-ref 的旧值检查](https://git-scm.com/docs/git-update-ref)，并通过 [worktree porcelain 输出](https://git-scm.com/docs/git-worktree) 检查来源引用的工作区占用。这些基础机制不等同于 Git 与 SQLite 之间存在一个共同原子事务，所以必须保留已消费意图并核对真实 Git 状态。

## 并发与当前边界

同一候选最多有一个未放弃的合并意图。任务/产物/验证及治理配置绑定不可修改；所有合并历史保留。Git 操作前检查工作区占用、符号引用和原始基线，成功后及回执使用时再次检查。来源更新的短事务会暂时串行化本机授权/任务写入；对象导入和完整文件核验在该写事务外执行。

`exclusiveRefManagement` 是当前管理合同：不要同时手工 checkout、添加占用此引用的 worktree 或用另一个未协调写者管理同一引用。检测到占用即拒绝继续；这些检查不是阻止任意管理员并发操作的 OS 锁。若无法满足独占管理，应使用独立的集成引用并通过另外的发布流程进入正在使用的分支。来源未提交文件、暂存区和其他工作区不由此命令清理、重置或覆盖。

独立检查当前仍属于可信主机执行，`filesystem_sandbox:false`。本地管理者选择固定检查和引用，不能把它当作恶意代码隔离或自动生产发布证明。实体两台 kanata、原生执行器、权限隔离、正向验收及受保护分支发布仍须按完整计划验证。
