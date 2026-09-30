# Windows 持续队列调度

本机协调身份调用 request_assignment 后，scheduler 按已批准的项目/角色配置持续消费 waiting_executor 请求，复用 prepareDispatch → prepareAdapter → executePreparedDispatch。它不创建调用预算、不放行任务、不修改角色或治理验收记录。每次许可只消费一次；任务成功仍进入待审阅，不自动验收。

## 本机配置

使用已经验收且干净的治理 checkout；运行中代码树变化会停止下一轮领取。角色、provider 预算、本机 MCP 代理及订阅登录需按各自管理命令预先准备。workspace-files 角色还需要已登记仓库、批准基线和获准复制完整历史的工作区池；调度器只在这些既有授权内生成本次工作区和 MCP 文件会话。

配置文件格式如下，所有占位符须替换为该电脑的实测值。每个项目/角色只能出现一次；不同角色可以使用 Claude、Codex 或 Zcode。单次超时 1 秒到 1 小时；并发 1–16；轮询 1–60 秒。provider 预算即使剩余很多，也不得超过用户实际允许的调用范围。

~~~json
{
  "format": "ai-fleet-scheduler/v1",
  "node_id": "<本机稳定 UUID>",
  "node_epoch": "<本机当前代次 UUID>",
  "root": "C:/board-private/scheduler",
  "max_active": 1,
  "poll_ms": 5000,
  "profiles": [{
    "project_id": "demo",
    "role_id": "implement-claude",
    "quota_id": "<既有 provider 预算 UUID>",
    "installation": {
      "runtime": "claude",
      "version": "2.1.284",
      "program": {"path": "C:/trusted/claude.exe", "sha256": "<实测 SHA-256>"},
      "auth_home": "C:/trusted/claude-subscription-home"
    },
    "python": {"path": "C:/trusted/python.exe", "sha256": "<实测 SHA-256>"},
    "node": {"path": "C:/Program Files/nodejs/node.exe", "sha256": "<实测 SHA-256>"},
    "mcp_url": "http://127.0.0.1:48320",
    "timeout_ms": 60000,
    "workspace": null
  }]
}
~~~

版本合同见 adapters.md；Zcode installation 另须固定 bundle 和 builtin_config 的路径/摘要，并使用原生 .zcode/v2 订阅目录。不要把 API key 或令牌放进这个文件。程序摘要可以使用 Get-FileHash 核对，不能用任意摘要代替。调度根必须在治理仓、订阅认证目录之外；新目录创建时保护为当前 Windows 账户独占，已有宽松目录会拒绝。

workspace-files 的 workspace 填入以下结构；代码启动目录仍是独立空白 scratch，仓库内容通过受控 MCP 文件会话访问：

~~~json
{"pool_id":"<已登记池 UUID>","base_commit":"<已批准的固定 Git 提交>","write_paths":["src/","docs/"]}
~~~

## 启动与停止

下面的 once 和 watch **会使用 provider 额度启动实际执行器**。仅为已授权任务配置真实程序；它们不是只读检查。此项目的真实联调上限仍为三种执行器各一次，不得因为增加常驻入口而重置或扩大额度。

~~~powershell
node cli/scheduler.mjs once --db C:/board-data/board.db --config-file C:/board-private/scheduler.json --accepted-rev C:/board-private/accepted_rev
node cli/scheduler.mjs watch --db C:/board-data/board.db --config-file C:/board-private/scheduler.json --accepted-rev C:/board-private/accepted_rev
~~~

once 执行一轮有界扫描并等待该批在途任务；watch 继续轮询并接收后续 MCP 请求。每页最多扫描 32 个请求，以创建时间和 UUID 排序，游标继续下一页，避免未配置或受阻请求一直占住第一页。每次真实领取仍经过现有原生门禁、父子关系、角色/协调身份、任务版本、预算与源码检查。未放行/缺策略的请求不会自动升级；任务或角色变更后，需要协调方发出对应当前版本的新请求。

并发计数包括本节点尚未明确结束的 provider 运行，不只计本轮内存中的 Promise；已经结束任务行但缺少进程停止证明的运行仍占位置。普通领取失败保留未启动状态，后续条件满足可再检查；同一原因重复日志受抑制。已经领取后、启动前的配置错误会明确放弃未启动分派，撤销凭据、释放未用名额并转入待决策，保留文件，不自动重试。启动许可提交后，无论失败还是状态不明都保留已消费次数。

首次 Ctrl+C 停止新领取并等待在途执行结束；再次 Ctrl+C 或 SIGTERM 通过现有监管器取消在途执行并记录停止观察。取消不退回已消费额度。正常退出释放同一数据库的调度锁；关闭数据库之前会等待本轮全部监督任务结束。

调度器只使用本机 MCP 地址，任务续租由既有 runner 负责，不以 Tailscale 在线与否决定是否结束已领取任务。真实断线和重连验收仍待两台电脑实测，不能从这个实现推定通过。

## 中断与回执恢复

数据库真实路径旁有 .<数据库文件名>.fleet-scheduler.lock，包含进程 ID 和锁身份；同一数据库从不同调度根启动仍被拒绝。强制退出留下的锁不会仅因时间到期被抢占。必须先核对记录中的原进程与执行器状态；处理旧锁属于本机操作恢复步骤，不应删除活动锁来开启第二个调度器。

每个请求在受保护根目录中保留 INTENT.json、独立 scratch 与 private。私有目录中已有的文件、孤立凭据或变更的绑定不被覆盖；没有递归清理或自动删除执行证据。根身份记录消失时停止，不悄悄初始化新根。配置、节点代次或根绑定变化需要使用新目录并核对遗留运行，不能借新目录重发旧许可。

结算失败但实际执行终态已保存为 execution-observation.json 时，可在停止 watch 后运行：

~~~powershell
node cli/scheduler.mjs reconcile --db C:/board-data/board.db --config-file C:/board-private/scheduler.json --accepted-rev C:/board-private/accepted_rev --assignment <原分派请求 UUID>
~~~

该命令核对节点、目录绑定和现有签名回执，只补交终态，不启动模型；重复提交相同回执保持同一结果。没有有效终态回执时保留待核对状态。仍为 prepared 的旧运行可按 dispatch.md 的 abandon 命令明确放弃，再由任务决策流程决定是否用新 run 重做。调度器不自动退回、接管或恢复旧启动许可。

日志是 JSON Lines，含节点、请求、任务和运行身份以及原因代码；不输出任务正文、订阅凭据或供应商原始输出。结算和模型进程观察仍存于既有数据库及本次运行目录，供后续追溯。

## 验证范围与后续

本机测试使用空账号和无网络的合成 Zcode 程序，在真实 Windows Job 中执行，不使用用户订阅。覆盖持续接收后续请求、并发与额度、授权撤销、源码变化、实际 CLI、优雅停止、实际进程取消、结算失败后只补交一次回执，以及自动准备登记 Git 工作区与文件会话。测试成功不代表三家原生模型已联调。

当前以有界批次运行，一批全部结束后再补下一批；源码/工作区准备含同步文件与 Git 操作，大规模任务的吞吐和心跳延迟尚未验收。没有安装 Windows 服务或设置开机启动，也未实施运行证据自动清理、完整 OS 权限隔离、每日预算窗口与模型用量限额。后续仍需完整界面操作、跨节点同步服务接线、实际三执行器和双机断线闭环、72 小时及运维验收。正式阶段完成数保持 0/12。
