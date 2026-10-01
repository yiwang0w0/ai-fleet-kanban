# 丢失执行回执的人工恢复

适用于已消费一次启动许可，但监管进程在可信观察落盘前退出，或已记录 `SUPERVISOR_ERROR` 且进程是否停止仍不明确的运行。`prepare-uncertain` 只读生成核对计划；`record-uncertain` 只接受本机操作者对确切运行作出的停止声明。不开放为 MCP 工具或 peer 写入接口。

## 先核对停止，再记录未知结果

操作者必须实际停止原监管进程、完整子进程树及仍在执行的供应商远端会话，保留核对依据。PID 不存在、租约过期、心跳变旧或任务行已结束，都不会自动变成停止证据。此命令不会代替操作者执行停机，也不会启动执行器。

```powershell
node cli/dispatch.mjs prepare-uncertain --db C:/board-data/board.db --dispatch <原dispatch UUID> --plan-file C:/board-private/uncertain-plan.json
```

计划绑定节点 UUID/epoch、dispatch、run、task、启动摘要、原观察/结果摘要、任务所见版本，以及运行/任务/凭据状态摘要。必须核对确切对象与输出的 `plan_digest`。计划文件不覆盖；准备过程以只读连接读取，不迁移或修改数据库。未消费许可应使用 `abandon`，已有可信停止观察应走正常结算；人工出口不会覆盖这种观察。

停止声明文件使用以下格式；将身份与摘要填为已核对计划中的值。四个布尔字段在草稿中保留 false，只有对应停止事实已经核对才改为 true；`evidence_ref` 填本机保留的证据引用，时间填实际声明时间。

```json
{
  "format": "ai-fleet-uncertain-execution-attestation/v1",
  "node_id": "<plan.node_id>",
  "node_epoch": "<plan.node_epoch>",
  "dispatch_id": "<plan.dispatch_id>",
  "run_id": "<plan.run_id>",
  "launch_digest": "<plan.launch_digest>",
  "plan_digest": "<plan.plan_digest>",
  "supervisor_stopped": false,
  "process_tree_stopped": false,
  "remote_session_stopped": false,
  "no_automatic_retry": false,
  "evidence_ref": "<可核对的本机证据引用>",
  "attested_at": "<实际ISO时间>"
}
```

```powershell
node cli/dispatch.mjs record-uncertain --db C:/board-data/board.db --plan-file C:/board-private/uncertain-plan.json --plan-digest <已明确核对的摘要> --attestation-file C:/board-private/uncertain-attestation.json
node cli/dispatch.mjs status --db C:/board-data/board.db --dispatch <同一dispatch UUID>
```

状态变化、节点退役/恢复隔离或 epoch 改变会拒绝旧计划。成功回执代码为 `OPERATOR_ATTESTED_LOST`，`process_stop_evidence` 明确为 `operator_attested_not_machine_verified`，结果仍未知，`accepted` 和 `real_model_call_confirmed` 为 false。人工声明不是 HMAC 监管日志，也不伪造 `job_empty`、成功结果、用量或退款。

## 数据与重放合同

任务仍属于原 run 时，在一个事务里结束活跃任务运行、置为等待人工处理、加人工闸并撤销放行，撤销该 run 的全部活跃 MCP principal，结束对应 assignment，写入恢复记录、dispatch 事件和 task_events。运行已经被新 run 替代时，仅保留旧运行决定；新任务状态和新运行凭据保持。任何一步落盘失败，整个事务回滚。

`broker_execution_resolutions` 只增不改不删，独立 schema 为 1；原 dispatch schema 仍为 3。计划和完整声明留在本机数据库，普通状态输出只给决定、身份和摘要，不输出完整声明的证据引用。原启动/观察/结果记录保持；尚无结果的 dispatch 仍显示 interrupted，并带独立 resolution。重复同一计划与声明返回同一回执，改变内容被拒。额度和任务尝试次数都不退回，没有新启动许可。

随后收到真实签名日志时，仍按既有校验留存观察；不会自动撤销人工闸、放行、重做或验收任务。人工决定本身也不被覆盖。

## 取消与下游传播

人工记录后须显式执行既有 `cancellation progress`，才能把它纳入停止证明；只读 `cancel-status` 仍不推进状态。只要本机或任何下游含人工停止声明，停止回执使用 schema_version 2，并带 `stop_evidence: includes_operator_attestation` 与本地 `operator_attested_runs`。上游即使本地计数为 0，也会保留来自下游的证据标记，不降级成纯机器证明。

来源记录、登记节点两端投票和本地取消结算保留该 v2 回执。向登记节点发送此类退役请求时，握手必须声明 `delegation-operator-stop-v1`；未支持时在提交前拒绝。旧停止回执 v1 继续适用机器/夹具路径，客户端不会自动降级；已记录停止回执不能被不同版本或内容替换。参与此恢复流程的端点及登记节点须使用一致的新代码。

调度器的自动停止判定仍只采信机器证明；人工声明不自动清除调度实例锁、不修改原实例终态，也不自动接管运行。异常实例/锁的人工恢复仍是单独的运维待办。本批解决的是未知 dispatch 的审计出口及取消结算阻塞，H4c 的换代绑定退出仍待完成。

[本机验证证据](uncertain-execution-evidence.json) 包括真实隔离进程在许可提交后退出、CLI 恢复、事务故障回滚、迟到签名日志、替代运行隔离，以及实际回环 HTTP / 多级取消结算。供应商模式记录均为合成数据，未调用真实模型；没有生产恢复、实体双机或阶段验收。
