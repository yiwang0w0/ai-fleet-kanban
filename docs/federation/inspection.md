# 本机待处理事项巡检

在开发源码目录运行，显式提供已初始化数据库的绝对路径：

    node cli/federation.mjs stuck --db C:/Fleet/node-A/data/board.db --project physical-pilot
    node cli/dispatch.mjs stale --db C:/Fleet/node-A/data/board.db --project physical-pilot

命令使用只读、query_only 连接，不迁移数据库、不连接远端、不调用模型，也不推进取消或完成。未配置的模块显示 not_configured；不兼容版本、缺表或损坏记录明确报错。没有默认生产数据库路径。

退出码：0 表示所选范围没有这些待处理记录；2 表示有待处理记录，JSON 仍正常输出；1 表示参数、版本或读取错误。空清单不是执行许可、停机证明或验收通过。stale 仅指 prepared/interrupted 尚未结清，不按时间长短判定进程故障；launch_committed 单独存在不在此范围。

## 联邦清单

| category | 纳入条件 | next_action / 处理入口 |
|---|---|---|
| binding_attempt | approve 或 withdraw 请求 pending | resume_binding_submit / resume_binding_withdraw：在 binding.mjs get 核对原关系，再恢复 approve / withdraw；保留原 request_id |
| topology_attempt | 拓扑登记请求 pending | resume_topology_submit：topology.mjs operation 查看 related_id，然后按已核对的登记端点 send |
| completion_attempt | 完成登记请求 pending | resume_completion_submit：completion.mjs get 查看 related_id，恢复 register approve / poll |
| completion_ready | 双端就绪，尚无本机登记退役/结算记录 | review_and_submit_completion：核对 record_id 的完成计划，使用 completion.mjs register |
| cancellation_received | 来源只记到 received，尚未转换为 stopped | progress_target_then_poll_source：接收端 cancellation.mjs progress，再由来源 poll；received 不证明执行器停止 |
| delegation_unbound | accepted_unconfirmed 且当前绑定授权不成立 | review_endpoint_binding：核对双端绑定、来源就绪消息和当前凭据；不自动 release |

已取消或已完成的终态绑定不再作为待绑定目标列出。同一完成流程可能同时出现 ready 和 pending 请求，两条分别说明就绪状态和在途操作，不是两个业务任务。目标绑定授权复用现有 guard；查看清单不会发放授权。

record_id 是该行请求/完成/取消/委派 UUID；related_id 分别是关系、拓扑操作或完成 UUID，适用于上表对应模块。task_id 仅在该状态明确记录本机任务时提供。输出不附带合同、提示词、凭据、原始回执或错误正文。

## 执行清单

dispatch stale 返回未有结果的 prepared / interrupted 记录，record_id 是 dispatch UUID，related_id 是 run UUID。prepared 提示 review_prepared_dispatch：用 dispatch.mjs status 核对后，按原流程执行或显式 abandon。interrupted 提示 reconcile_or_attest_stopped：有真实执行 journal 时 reconcile；确实无法取得观察时，按 [未知执行恢复](uncertain-execution.md) 核对停止事实后使用人工出口。

已有摘要校验通过的人工恢复回执会从此清单移除，但其任务人工闸、预算消耗和原历史保持。回执损坏不会当作已解决。清单不检测操作系统进程，不退款、不重启、不删除记录。

## 范围与分页

--project 限制项目；省略时查看本机已记录的全部项目。--limit 为 1–100，默认 100。next_cursor 不为空时，使用相同项目和 limit，将它传入 --cursor 取得下一页。清单在同一读事务内生成，游标固定节点/代次、范围和记录快照；期间记录变化返回 SNAPSHOT_CHANGED，应从第一页重新读取。当前时间变化不会单独使游标失效。

每次最多检查 10000 条候选记录，超过明确返回 INSPECTION_LIMIT，可按项目缩小范围；不会把部分结果说成完整清单。total 是该快照的事项数，不是未完成任务数。损坏且无法确定项目的孤立记录仍会报错，不随项目过滤被隐藏。

旧代次记录保留，identity_current=false，动作统一为 review_epoch_recovery；本命令不激活恢复副本。recorded_at 无效或在当前时钟之后时，age_ms=null、clock_unknown=true，不从时钟异常推断超时。结果始终注明 state_changes=false、process_liveness=not_checked、remote_state=not_queried。

CLI 错误为固定 code 和简短说明，不透出本机文件路径或输入正文。文件系统权限、身份恢复封存和退役检查仍由现有控制入口执行。程序内复用读函数时，不提交或回滚调用者已有事务。

## 验证和边界

[验证证据](inspection-evidence.json)记录 Windows 下的先红后绿、真实协议状态转换、CLI 只读摘要、分页和损坏拒绝。历史容量与旧代次边界使用合成存储夹具；不据此声称实体双机验收。去重 18 项有通过记录，非一次 29 项测试。

本批接通 H3b/H3c；H3a 的版本/运行 CAS/远端冲突统一解释，以及 H3d 健康哨报警仍待完成。本机任务卡的原因展示见 [阻塞诊断](progress-diagnostics.md)。
