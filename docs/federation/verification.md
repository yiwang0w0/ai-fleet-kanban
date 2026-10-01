# 来源节点独立检查（Windows）

本机管理者选定测试命令和仓库，验证器在新的独立 Git 副本中重建已接收产物，实际执行命令，并记录输入、输出、退出状态与 Windows Job 停止观察。执行端报告不能选择来源端命令，也不能提交“通过”代替这个过程。

独立检查结果为 `checks_passed`，所有返回保留 `accepted:false`。后续由 [来源合并](integration.md) 与 [双端结案](completion.md) 分别处理；本检查本身不计完整 S07 验收。

## 使用顺序

1. 按 [产物传输](artifact-transfer.md) 完成候选回传、本机接收许可、实际文件传输及 `artifact verify`。
2. 本机建立新的验证池目录，提供本机配置 JSON。使用 `node cli/verification.mjs profile --db <来源DB> --config <绝对配置路径> --accepted-rev <治理树验收文件>` 登记。
3. `prepare --db … --profile <UUID> --transfer <UUID> --id <验证UUID> --accepted-rev …` 保留运行编号后，独立复制已批准完整 Git 历史；无硬链接、无远端、无 checkout 过滤器；写入接收到的实际字节，重建并验证提交和完整树。
4. `run --db … --id <验证UUID> --accepted-rev …` 消费一次启动许可。进程中断、重复命令或 DB 重启均不退还许可。`get --db … --id …` 查看状态和证据。
5. 已有进程观察但 DB 写入失败时，`reconcile --db … --id … --accepted-rev …` 只结算保留的本机观察文件。缺失观察保持占用，不自动重复测试。部分准备目录原样保留，不自动覆盖。
6. `check --db … --id … --accepted-rev …` 重新验证历史通过回执当前仍有效。`get` 只展示历史，不作当前授权。任务或授权随后变更时，历史通过记录保留，但 `check` 拒绝使用。
7. `revoke --db … --profile <UUID>` 撤销本机配置。正在运行的检查在下一心跳请求停止，启动前及终态再次检查授权。配置/文件变化需要新的显式配置和运行编号。

参数全表见 `node cli/verification.mjs --help`。CLI 固定使用自身仓库作为治理代码根；不接受调用方提供的其他代码根，不修改已有 accepted_rev。

## 本机配置

JSON 只含 `profileId`、`mappingId`、`poolRoot`、`allowFullHistoryCopy:true` 和 `definition`。使用新 UUID；mapping 必须等于该候选的本机接收仓库。验证池不能与源仓库、治理代码、数据库或固定程序/测试文件重叠。

`definition` 字段：

| 字段 | 内容 |
|---|---|
| command / python | `{path,sha256}`；绝对、规范化的本机原生 `.exe` 路径和实际 SHA-256 |
| pins | 最多 15 个本机测试脚本或辅助文件的 `{path,sha256}`；测试脚本应在验证池外固定 |
| args | 管理者批准的固定参数数组；不插入远端报告、文件路径或运行参数 |
| env | 显式基本环境，仅 SystemRoot、WINDIR、TEMP、TMP、PATH、PYTHONUTF8、NO_COLOR、CI、LANG、LC_ALL；不继承其他父环境 |
| timeout_ms | 50–3,600,000 毫秒 |
| heartbeat_ms | 100–10,000 毫秒 |
| stdout_limit / stderr_limit | 每流 1–65,536 字节；超量或非法 UTF-8 失败 |
| isolation | 可选 Windows AppContainer 配置；见下节。明确请求后，创建、权限或令牌核验失败均拒绝，不回退为宿主执行 |

普通测试命令和模型执行协议分开。退出码 0 表示选定命令通过；业务覆盖取决于本机批准的测试本身。回执保留实际输出、字节数、摘要、退出码、监管宿主及程序摘要、Windows Job 清空结果。空输出可以是成功测试，但不会被标成模型调用或凭空产生测试用例数。

## 一致性与恢复

配置和历史记录不可更新/删除；撤销追加记录。准备、启动和结算绑定当前节点/epoch、来源任务完整行摘要及版本、候选/传输/清单摘要、原始基线、产物提交、固定命令配置和治理树。来源取消/退回、凭据撤销、任务变更或治理代码变化均使后续 `check` 拒绝历史成功声明。正在运行时心跳检查当前绑定；终态核对固定文件及原始输入字节、HEAD、index 与 Git 对象。

新生成的普通文件可以留作检查输出，但不进入接收产物或未来待合并提交。链接、硬链接、特殊文件、原始输入变更、HEAD/index 改动均使检查失败。准备失败和启动后缺少观察都保留现场；不会自动创建其他编号绕过这些记录。

`ready` → `launch_committed` → `settled` 表示一次实际命令尝试；`preparing` 表示副本未完成。DB 结算失败前先把观察写入私有运行目录并 fsync。重启恢复时重新检查当前任务/授权/输入；已过期的原成功观察只能结算为失败。

## 隔离边界和后续验收

独立 Git 副本隔离源仓库对象和输入，Windows Job 管理进程生命周期。未指定 isolation 的旧配置仍以宿主账户执行，只允许已审查的可信测试，回执保持 filesystem_sandbox:false，不能作为恶意代码隔离或 G07 完成证明。

需要隔离的来源检查必须注册一个新 profile，显式加入：

~~~json
"isolation": {
  "kind": "windows-appcontainer",
  "network": "none",
  "memory_limit_bytes": 268435456,
  "process_limit": 4
}
~~~

内存范围为 64 MiB–2 GiB，进程数为 1–64，都是整个 Job 的限制；原有超时、心跳和输出上限继续生效。进程在挂起状态加入 Job，并核验实际 AppContainer SID 和零 capability 后才恢复。此配置只用于普通来源检查，模型监管入口明确拒绝，未为 Claude/Codex/Zcode 宣称同等隔离。

每次运行创建新的 Windows AppContainer profile，不加入网络 capability，也不设置 loopback exemption。只给本次验证仓库读写权限；命令和固定辅助文件复制到私有暂存区，重新核对字节摘要并仅授予该 profile 读/执行权限。原路径及祖先 ACL 不修改；完整参数值与已固定文件路径相同时替换为副本路径，其他参数保持原样。固定文件副本保留盘符下的相对目录层级，不改写脚本正文中的硬编码路径。所有非系统依赖必须包含在固定文件清单中；无法读取的依赖失败，不临时扩大宿主权限。复制总量上限 512 MiB。

Node 模块测试应在批准的 args 中明确加入 --preserve-symlinks 和 --preserve-symlinks-main，避免模块解析需要探查未授权祖先目录。本机 24.16.0 已实测；未携带这些参数时出现根目录 lstat EPERM，属于配置失败，不会给磁盘根目录放权。工作目录在启动前拒绝 reparse point 和文件硬链接。生成的用户目录、临时目录及 PATH 只指向本次暂存区和 Windows 系统目录；不把现有 CLI 登录目录复制进沙箱。

通过回执要求：命令通过、原始输入仍一致、Job 清空、实际令牌核验成功、profile 与暂存区均清理成功，且这些观察与固定 isolation 配置相符。filesystem_sandbox:true 只描述本次实际进程的 AppContainer 边界，不表示任务已验收；缺观察、配置不匹配或清理不完整不能得到 checks_passed:true。崩溃恢复保留原一次启动许可，不重复执行或退回未隔离模式。

正常结束保留验证仓库及生成证据，不清除其文件；仓库可能保留已删除 profile 的专属 SID ACE，不能复用该 profile 名称。异常杀死监管宿主时可能保留 ai-fleet-check- 前缀 profile 或 ai-fleet-sandbox- 暂存区；须先核对该次运行与进程停止再清理，不能批量删除未知 profile 或目录。删除 profile 并不等于删除用户账号。

AppContainer 仍能访问 Windows 明确授予应用容器的公共系统资源；宿主管理员、其他具有本机账户权限的进程以及管理员配置属于可信边界。本机负向测试证明受保护的目录外文件及来源数据库不可读取/改写，不能外推为每个现存宿主文件均不可读。网络测试使用前后可正常连接的本机监听端口，未访问外部服务。

工作目录核对的 50,000 条目 / 512 MiB 是事后检查上限，并非磁盘配额。磁盘容量限制、真实验证配置/依赖、模型适配器 OS 隔离以及两台实体机演练仍需完成。没有改动生产 profile、accepted_rev 或真实任务，也未调用模型。

实现依据：[微软 AppContainer 启动与令牌边界](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer)，[Node 模块路径参数](https://nodejs.org/download/release/v25.9.0/docs/api/cli.html#--preserve-symlinks-main)。行为结论以本项目 Windows 实测为准，详见 windows-appcontainer-evidence.json。

已配置的操作员面板也可准备、启动和恢复原验证，见 [文件交付与独立检查](fleet-actions.md#文件交付与来源独立检查)。测试程序仍须由本机 CLI 预先登记，面板只选择固定配置。
