# 登记节点换代后的绑定人工退出

当旧登记节点已确认关系、但回执丢失时，本地仍可能是 prepared；备份恢复换代后，旧图返回 GRAPH_RECOVERY_REQUIRED。这个错误不证明原请求失败。普通重试保留 pending，也继续保护绑定所用拓扑。本机人工退出只解除这一条未确认绑定造成的拓扑阻塞，把相关任务交回人工处理。

## 前提与范围

此入口只供本机管理者使用，没有 MCP 工具或 peer 写入端点。先确认同一登记节点 UUID 的实际新 epoch，停止双方相关执行器及自动重启入口，并禁用旧登记节点。证据必须来自实际操作记录；网络超时、心跳过期、PID 不存在或换代错误本身都不能代替停止证据。不能确认这些事实时，继续保留挂起请求。

工具保存的是 operator_attested_not_machine_verified 人工声明。远端结果仍未知，不把关系伪装成已撤回、已停止或完成。已在本端 confirmed 的关系不能走此入口，需按 [取消协议](cancellation-closure.md) 处理。

只修改明确指定的本机数据库，不操作其他端点、不访问网络、不启停服务。若两端都卡住，分别核对各自计划；一端回执不替另一端裁定。其他 prepared 绑定仍然保护项目拓扑。

## 操作

以下路径均为占位示例，替换为本机私有目录的绝对路径。源代码需要已升级；运行前停止旧写入者。

1. 只读生成计划。新 epoch 是管理者已观察到的同一登记节点代次，不是工具自动发现或验证的结论。

~~~powershell
node cli/binding.mjs prepare-recovery --db "D:\private-board\board.db" --relation "<关系 UUID>" --registrar-epoch "<登记节点的新 epoch>" --plan-file "D:\private-board\binding-plan.json"
~~~

计划固定当前本机节点及 epoch、原绑定 epoch、登记节点旧/新 epoch、关系/图/任务、pending 请求列表，以及绑定、任务、运行、请求、消息、提交和本地拓扑的摘要。输出文件必须不存在。命令使用只读数据库连接，不安装迁移或生成审计写入。

2. 人工核对计划与停止证据，创建私有声明文件。以下八个身份/摘要字段从实际计划逐项核对后填入；四个布尔字段只有在对应事实成立时才改为 true，模板本身不能提交。

~~~json
{
  "format": "ai-fleet-binding-recovery-attestation/v1",
  "node_id": "<计划 node_id>",
  "node_epoch": "<计划 node_epoch>",
  "binding_epoch": "<计划 binding_epoch>",
  "relation_id": "<计划 relation_id>",
  "registrar_node_id": "<计划 registrar_node_id>",
  "retired_registrar_epoch": "<计划 retired_registrar_epoch>",
  "observed_registrar_epoch": "<计划 observed_registrar_epoch>",
  "plan_digest": "<明确核对的 plan_digest>",
  "old_registrar_disabled": false,
  "both_endpoint_workers_stopped": false,
  "remote_outcome_unknown": false,
  "no_automatic_release": false,
  "evidence_ref": "<实际停止与换代证据的私有位置>",
  "attested_at": "<实际确认时间，ISO 8601>"
}
~~~

3. 提交已核对摘要和声明：

~~~powershell
node cli/binding.mjs record-recovery --db "D:\private-board\board.db" --plan-file "D:\private-board\binding-plan.json" --plan-digest "<核对的 SHA256>" --attestation-file "D:\private-board\binding-attestation.json"
node cli/binding.mjs get-recovery --db "D:\private-board\board.db" --relation "<关系 UUID>"
~~~

记录时重新核对当前节点和全部状态摘要；旧计划、不同声明、本机仍在执行的任务和已确认绑定均拒绝。原子事务将 pending 请求记为本机专用 OPERATOR_ATTESTED_REGISTRAR_RETIRED，将本地绑定终结为 cancelled，同时设置任务人工闸、关闭放行，保存计划、声明、回执和任务/绑定事件。原有已确认请求、消息、登记回执和历史不删除。closed 保持 0，不生成取消或完成证明。完全相同的重试返回原回执，不重复写历史。

get-recovery 只读；get / list 的 recovery 字段也提供回执摘要，完整声明和证据位置留在本机数据库。人工退出后的迟到确认及来源就绪消息不能复活绑定。本机专用错误码不属于网络确定性拒绝清单，peer 返回它不会触发人工退出。

## 后续仍需处理

任务保持人工闸和未放行，退出不派发、不重试、不验收工作。接收端原始 accepted_unconfirmed 保护继续阻止执行，来源任务也需后续明确人工裁定。

本入口不恢复关系图、不更换拓扑绑定、不轮换凭据、不清除异常运行实例锁。回执明确 graph_recovered=false。若本机也曾恢复换代，可对本机同一 UUID 的旧 prepared 绑定生成新计划退出；旧 epoch 普通绑定 API 仍拒绝复用，本地拓扑仍可能报 TOPOLOGY_RECOVERY_REQUIRED。登记节点与来源同机时，填写的新登记 epoch 必须等于当前本机 epoch。

存储新增独立 binding_recovery_schema=1 和不可修改/删除的 binding_recoveries；现有 binding schema 仍为 4。部署前遵守 [迁移要求](migration-0.24.md)，不混用旧写入者。运行证据见 [binding-recovery-evidence.json](binding-recovery-evidence.json)。隔离测试不构成实体双机或阶段签收。


已有实际接受合同的未决关系，可在端点退出后按 [未决提议恢复](pending-relation-recovery.md) 将双方证据交给恢复后的原登记节点，再建立后继图。原退出回执仍是本地历史，不修改其中的 `graph_recovered=false`；后续图是否恢复由新的登记/图回执证明。
