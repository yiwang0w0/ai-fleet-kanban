# Windows 节点常驻入口

`cli/node-runtime.mjs watch` 在一个进程内管理 peer 网关、本机 MCP 代理、持续同步与可选队列调度器。每次启动生成独立实例 UUID；状态、停止请求和组件观察写入本机数据库。此入口不安装 Windows 服务或计划任务；显式登录启动部署工具见 [Windows 启动说明](node-startup.md)。UI 服务器和 Markdown 上下文导出仍使用各自入口。

## 配置与启动

需要已初始化的本机数据库、已验收且干净的源码 checkout，以及按既有流程签发的逐对端凭据。配置固定本机 UUID/epoch；同步另固定来源 UUID/epoch，加载时和每次拉取前核对凭据绑定。凭据只通过绝对路径引用，不把令牌写进此文件或日志。

以下只启用通信组件，`scheduler:null` 不领取任务或调用模型。替换所有占位符；没有同步对端时使用空数组。此示例不是任一实体节点 的已批准部署配置。

```json
{
  "format": "ai-fleet-node-runtime/v1",
  "node_id": "<本机 UUID>",
  "node_epoch": "<本机当前 epoch>",
  "peer": {"host": "127.0.0.1", "port": 47925},
  "mcp": {"port": 48320, "board_url": null},
  "sync": [{
    "project_id": "physical-pilot",
    "url": "https://<已核对的对端 DNS>.ts.net:47925",
    "credential_file": "C:/board-private/from-peer.json",
    "server_node_id": "<来源 UUID>",
    "server_epoch": "<来源当前 epoch>",
    "poll_ms": 5000
  }],
  "scheduler": null
}
```

peer 或 mcp 可为 null，但至少启用一个组件。peer 仅接受数字回环地址，MCP 固定监听 127.0.0.1；非零端口不能相同。端口0仅适合孤立测试，正式客户端需固定端口。同步最多32项，同一来源/项目不得重复，轮询1–30秒；连接沿用 sync 客户端的回环 HTTP 或私网 `.ts.net` HTTPS 限制、凭据校验和持久退避。

```powershell
node cli/node-runtime.mjs watch --db C:/board-data/board.db --config-file C:/board-private/node-runtime.json --accepted-rev C:/board-private/accepted_rev
node cli/node-runtime.mjs status --db C:/board-data/board.db
```

Tailscale Serve、访问策略、项目共享、角色与配对凭据仍按各自流程明确配置；此命令不会设置它们。只把 peer 端口作为对端入口。网络首次启用前仍需完整 G03 配置确认，见 [实体试点](windows-pilot.md)。已发送的 fea7378 试点包不包含本入口，不能直接替换试点来源或要求第二台改用开发分支。

如需执行任务，把 scheduler 改为 [调度说明](scheduler.md) 中完整 `ai-fleet-scheduler/v1` 配置对象。所有 profiles 的 mcp_url 必须等于本节点管理的固定 `http://127.0.0.1:<mcp.port>`。角色、程序摘要、订阅登录、源码许可、预算和任务放行仍由既有调度器逐项核对。**启用 scheduler 会在既有许可内启动真实执行器**；这不会增加用户已批准的调用次数，也不会自动生成预算。不要让独立 scheduler watch 与本入口争用同一数据库。

## 状态与停止

```powershell
node cli/node-runtime.mjs status --db C:/board-data/board.db --instance <节点常驻实例UUID>
node cli/node-runtime.mjs drain --db C:/board-data/board.db --instance <实例UUID> --version <当前revision> --request-id <本次请求UUID>
node cli/node-runtime.mjs cancel --db C:/board-data/board.db --instance <实例UUID> --version <最新revision> --request-id <另一请求UUID>
```

status 只读打开数据库，返回最近20个实例，指定 UUID 可查更早记录。节点常驻与调度器使用各自的实例 UUID 和控制表；组件 scheduler 的摘要指向实际调度实例。管理命令要求本机数据库访问权，不新增远程 HTTP、peer 或 MCP 控制权限。

- `requested` 只说明请求落盘；`observed_revision` 跟上 revision 才说明常驻进程已经观察。请求按实例、节点代次、所见版本和幂等请求号绑定；取消可升级，不能恢复领取或降级。
- 启动组件后、首次调度之前先观察已有控制请求，此后通常每秒观察一次。同步 Git/文件操作可能延迟事件循环，没有高负载下一秒停止保证。
- drain 停止新领取；等待在途执行期间 MCP、peer 和同步继续工作。执行器结束并核对停止记录后，停止同步，再关闭自身监听器。cancel 额外通过既有监管器取消在途 Windows Job；已消费额度不退回。
- 首次 Ctrl+C 请求 drain，再次 Ctrl+C 或 SIGTERM 请求 cancel。对端离线只使对应同步组件进入 error/backoff，重连后继续拉取，不因此终止已领取任务。
- stopped 需要组件收尾、正确的本实例锁、可持久保存的终态及零未确认执行。attention 或 ended_at 为空都不证明完整停止。executor_stop_confirmed 只对应记录时的执行停止观察；process_liveness 为 not_checked，心跳不证明 OS 进程当前存活或死亡。

同一数据库真实路径旁使用 `.<文件名>.fleet-node-runtime.lock`；第二实例被拒绝，不自动接管过期锁。部分启动失败只关闭自己已经打开的监听器。锁身份被替换时保留该文件，并保留未结束的实例记录，不写成功终态。强制终止、断电或终态写入失败需人工核对确切进程、Job 和证据后处理；不可按 node.exe 名称批量结束程序或仅因心跳过期删锁。

新增 `node_runtime_lifecycle_schema v1`、`node_runtime_instances`、`node_runtime_control_requests` 与 `node_runtime_components`，与 scheduler 表分开。状态摘要只保存组件名、端点/节点/项目身份、游标、原因代码及停止观察，不输出凭据、任务正文或供应商原始输出。仍需用 Windows 文件权限保护数据库、配置和凭据目录。

## 已验证范围

[本批证据](node-runtime-evidence.json) 记录真实回环双节点进程接线、双向同步、来源停机/重启后的自动追平、独立 CLI 的受限 MCP 查询、等待在途任务与实际 Job 取消。使用隔离临时数据库、空账号与合成执行器，没有真实模型调用。启动停止竞争和锁替换两条断言已在修复前实际失败，修复后通过。

登录启动工具已提供；实际安装/登录触发、Windows 登录前服务、UI/告警统一管理、控制历史保留、真实吞吐与72小时观察仍待完成。实体双机 Tailscale、桌面客户端与三家真实执行器仍按实际回执验收；本机34项去重测试不代替 G04/G05/G10/G11 或任何正式阶段签收。

## 异常实例的明确恢复入口

残留锁可通过 [只读计划与审计恢复](runtime-lock-recovery.md) 核对宿主进程和运行停止证明后处理；仅清理匹配原锁，不自动启动、重试、放行或退款。


健康哨现已覆盖节点实例、常驻锁和同步组件的持久观察，见 [节点巡检](health-watch.md)。该覆盖不把心跳或 PID 查询当作停止证明，也没有部署真实常驻哨。
