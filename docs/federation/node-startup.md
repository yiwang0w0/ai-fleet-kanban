# Windows 登录后启动部署工具

此工具把 [节点常驻入口](node-runtime.md) 配成当前 Windows 用户登录后的计划任务，适用于使用该用户桌面订阅登录的节点。它不保存 Windows 密码、不提升为管理员、不改 Tailscale，也不新增模型预算。首次安装保持禁用，启用和立即运行分别显式执行。

采用 InteractiveToken，因此需要该用户已登录；它不是登录前运行的系统服务。微软分别说明了 [交互登录条件](https://learn.microsoft.com/en-us/windows/win32/taskschd/principal-logontype) 和 [任务 XML 验证/创建标志](https://learn.microsoft.com/en-us/windows/win32/taskschd/taskfolder-registertask)。未登录运行的服务账户、桌面订阅兼容性及实体重启仍需单独完成部署验收。

## 生成可核对的启动包

先固定独立且已验收的干净 checkout、本机数据库、节点配置及 accepted_rev。保持该 checkout 路径及文件不变；开发仓继续提交不能替代固定部署来源。准备命令只读打开数据库，不注册任务、不打开监听器、不调用执行器。

```powershell
node cli/node-startup.mjs prepare --db C:/board-data/board.db --config-file C:/board-private/node-runtime.json --accepted-rev C:/board-private/accepted_rev --output C:/board-private/startup-v1
```

输出新的受保护目录，含 STARTUP.json 和 task.xml。STARTUP.json 固定本机 UUID/epoch、当前用户 SID、数据库真实路径、源码树、Node/PowerShell/启动脚本/配置/验收文件的路径和摘要，并声明 scheduler 是否启用。任务名称包含节点 UUID 和启动包 UUID。已有目录不覆盖；启动包与治理仓分离，不接受路径中的环境变量展开符 `%`、引号或控制字符。

Windows 8.3 短路径和长路径会先通过原生 realpath 统一，源码、程序和文件固定路径与 PowerShell 的脚本路径保持一致；新启动目录的现有父目录也先规范化，不能用短路径把启动包放进治理源码。相同内容的另一份启动脚本仍被拒绝。旧包若因短路径固定值不一致被拒，须从核对后的固定来源生成新包；工具不会改写旧包或任务。详见 [短路径修复证据](startup-path-evidence.json)。

输出 manifest_sha256 是下列命令必须明确提供的摘要。操作者须核对 STARTUP.json、task.xml 的实际范围，尤其用户、来源、数据库、端口、同步项目及 scheduler_enabled。摘要绑定所核对文件，不是数字签名，也不代替 G03/G10 授权。凭据不复制到包中，仅通过既有配置引用；私有路径和 SID 也不应提交到公共仓库。

```powershell
node cli/node-startup.mjs check --bundle C:/board-private/startup-v1 --digest <核对的manifest_sha256>
powershell.exe -NoLogo -NoProfile -File C:/fixed-source/packaging/windows/node-startup.ps1 -Action Validate -Bundle C:/board-private/startup-v1 -Digest <核对的manifest_sha256>
```

Validate 调用 Windows Task Scheduler 的 TASK_VALIDATE_ONLY，仅验证 XML，不注册任务。成功不证明实际登录触发、安装权限、供应商登录或联网已通过。检查节点配置及运行时文件后，实际启动还会再次通过已有源码、角色、预算和执行许可门禁；配置内 scheduler 非 null 时会按已有授权调用执行器。

## 安装与启用

以下是具体部署范围确认后执行的操作，不是普通预检。本开发批次没有在两台实体机 上执行安装/启用。

```powershell
$startupScript='C:/fixed-source/packaging/windows/node-startup.ps1'
$startupBundle='C:/board-private/startup-v1'
$startupDigest='<核对的manifest_sha256>'
& $startupScript -Action Install -Bundle $startupBundle -Digest $startupDigest
& $startupScript -Action Status -Bundle $startupBundle -Digest $startupDigest
& $startupScript -Action Enable -Bundle $startupBundle -Digest $startupDigest
# 需要立即启动时再执行；否则等待该用户下次登录。
& $startupScript -Action Start -Bundle $startupBundle -Digest $startupDigest
```

Install 仅使用 TASK_CREATE，遇到同名任务拒绝覆盖。生成定义没有注册时触发器且 Enabled=false；Enable 只启用登录触发，Start 才请求立即启动。每次管理先比对 Windows 规范化的完整任务定义，只容许 Enabled 不同；额外动作、触发器、身份或参数变化均拒绝管理，不能借名称操作其他任务。

任务在登录后延迟10秒，使用当前用户普通权限，隐藏 PowerShell 与 Node 窗口。采用 IgnoreNew，禁止任务计划程序硬结束；不要求网络在线、不因电池切换结束，也不设置失败自动重启。ExecutionTimeLimit=PT0S 避免 [默认72小时运行上限](https://learn.microsoft.com/en-us/windows/win32/taskschd/tasksettings-executiontimelimit)。节点自己的数据库锁仍负责拒绝第二实例；这些设置不提供故障自动接管。未经正常 drain 的断电、重启或注销可能留下旧锁和未确认执行，下次登录会拒绝启动，须先核对原进程与运行回执后恢复；本批没有自动清锁或自动重派。

启动时再次核对当前用户、源码树、文件摘要和节点 epoch。Windows 或 Node 升级导致固定程序变化时，旧包拒绝运行；应停止原实例、核对升级并生成新包，不能修改旧摘要来伪装原批准。旧 checkout 应保留到旧任务停用和移除完成。状态检查不等于进程存活证明，LastTaskResult 也不等于任务执行或模型验收。

## 停止与移除

先禁用后续登录触发，再使用节点实例控制请求停止当前工作：

```powershell
& $startupScript -Action Disable -Bundle $startupBundle -Digest $startupDigest
node cli/node-runtime.mjs status --db C:/board-data/board.db
node cli/node-runtime.mjs drain --db C:/board-data/board.db --instance <节点常驻实例UUID> --version <当前revision> --request-id <新的UUID>
# 需要取消在途任务时使用 cancel，仍要求最新revision和新的请求UUID。
node cli/node-runtime.mjs status --db C:/board-data/board.db --instance <同一实例UUID>
& $startupScript -Action Status -Bundle $startupBundle -Digest $startupDigest
& $startupScript -Action Remove -Bundle $startupBundle -Digest $startupDigest
```

Disable 不结束正在运行的实例。drain/cancel 及停止证据的含义见节点常驻说明；不能把请求落盘当作已经停止。Remove 只允许定义仍一致、已禁用且 Task Scheduler 无运行实例的确切任务，不删除数据库、日志、凭据或启动包，不声称任何孤立进程已经停止。此工具不调用 Stop-ScheduledTask、taskkill 或按进程名结束程序。

配置变化后，inspect 和计划任务 Status/Disable/Remove 仍可核对原任务；check、Install、Enable、Start、Run 会拒绝变化的运行输入。如果固定启动脚本/Node 本身已被替换，管理工具也会拒绝继续执行，需要通过 Windows 任务计划程序核对原完整定义并禁用确切任务，保留原运行证据，不恢复整个任务库。

## 日志及验证边界

每次 Run 在私有启动目录创建独立 run-UUID.jsonl，保存节点事件和原因代码，不输出原始任务正文或订阅令牌。单文件约1 MiB 后写入 log_limit 并停止补充事件；完整运行状态仍在数据库。日志不自动删除，每次启动会增加一个文件，目录总容量与保留策略仍待实现。日志写入失败会请求停止新领取；已有任务按节点 drain 路径收尾。

[验证证据](node-startup-evidence.json) 区分真实与模拟：Windows COM 对定义进行真实只读验证，隐藏 PowerShell/Node 启动、MCP 鉴权、第二实例拒绝及 drain 为实际隔离进程测试；安装、Enable/Start/Disable/Remove 使用内存注册表验证命令分支，不代表 Windows 真实任务已安装。没有在本次测试中注册或启用系统计划任务。实体登录/重启、原生执行器、Tailscale 断线和72小时观察仍待验收。

已发送的第二台试点包保持 fea7378，不包含此入口。首次部署仍先完成实际节点回执、固定来源与具体 G03 配置，不要求第二台用开发分支替换试点。


启动测试的短时数据库写锁回归见 [启动控制连接证据](startup-control-evidence.json)。测试观察与清理使用和实际控制 CLI 相同的连接策略；观察连接异常时，清理通过独立连接向隔离实例提交停止请求并等待进程关闭。这个测试修复不代表一般数据库争用、异常常驻锁恢复或实体登录验收已经完成。
