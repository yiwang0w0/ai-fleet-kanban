# 登记节点换代后的未决提议恢复

双方已经接受委派、但关系确认仍挂起时，仅退出本机绑定还不够：恢复后的登记数据库可能仍保留 `relation_proposals`，阻断后继图。本入口把已有端点退出、接收方明确拒绝及执行停止证据接到登记侧，记录独立的人工恢复决定。它不伪造普通 `relation_withdrawn` 回执，远端旧结果仍为未知。

## 操作顺序

1. 按原恢复规程停用旧登记身份、停止相关工作，核对同一登记节点的新 epoch。已有 prepared 绑定的两端分别走 [绑定人工退出](binding-recovery.md)，保留各自计划、声明和回执。此工具不代做端点退出。
2. 接收端尚未准备绑定但已收到提议时，通过 `node cli/binding.mjs decline --db <本机DB> --relation <关系UUID> --digest <descriptor_digest> --reason operator_declined` 明确拒绝。若提议从未送达，仍需有本机原始委派接受记录和同一目标任务；不能凭一个外来描述创建接受事实。恢复前旧 epoch 的未准备提议不再可执行，但原记录保留。
3. 两端分别从实际数据库只读导出证据。任务必须未放行且未结束；原合同、接受回执、目标 UID、绑定/提议必须一致。项目中仍有活动或缺少停止证明的运行时拒绝。已有确认、来源就绪、结果或结案记录时不能走未决提议恢复。

~~~powershell
node cli/pending-relation-recovery.mjs endpoint-evidence --db <端点DB绝对路径> --relation-file <原关系描述JSON> --registrar-epoch <已观察的新epoch>
~~~

把双方输出保存为私有 JSON 数组。来源必须有当前本机代次的持久退出记录；接收方可为已经退出、明确拒绝且未准备，或从未收到绑定提议。输出只读，不为对方签发回执，不查询网络，也不更改任务。

4. 在恢复后的原登记节点准备并核对计划：

~~~powershell
node cli/pending-relation-recovery.mjs prepare-registrar --db <登记DB绝对路径> --relation <关系UUID> --evidence-file <双方证据数组JSON>
node cli/pending-relation-recovery.mjs record-registrar --db <登记DB绝对路径> --plan-file <计划JSON> --digest <plan_digest> --attestation-file <核对声明JSON>
node cli/pending-relation-recovery.mjs status --db <登记DB绝对路径> --relation <关系UUID>
~~~

声明使用 `format=ai-fleet-pending-relation-recovery-attestation/v1`，包含计划的 `node_id`、`node_epoch`、`plan_digest`，以及 `old_registrar_disabled=true`、`both_endpoint_records_reviewed=true`、`remote_outcome_unknown=true`、`no_automatic_release=true`、实际 `evidence_ref` 和 `attested_at`。证据位置为 8–2048 字符单行文本。只有根据真实证据核对后才能填写这些确认；不要代填离线设备的情况。

5. 再按 [图恢复](graph-recovery.md) 收集全员声明、建立后继图，各端重新绑定并发布本地结构。记录此提议的恢复决定不会自动建立新图、轮换凭据、取消其他合同或放行任务。来源可以在重新登记及人工放行后继续；接收方的旧 accepted_unconfirmed 工作不会因此取得执行权。

## 保留与校验

登记记录必须来自同一原图、同一合同及两个不同端点。登记节点本机也是端点时，准备和提交都重新读取本机数据，不能用陈旧导出文件代替。登记已有 relation_edges 确认或其他完成/取消承诺时拒绝；即使两端都丢失了确认回复，也不会按未决提议结束这条已知确认关系。来源本地确认时改走已确认合同流程。

新记录存于 `pending_relation_recovery_schema=1` / `relation_recovery_withdrawals`，只追加、不可修改或删除。旧 proposal、审批、请求、关系边、接受合同和端点退出历史保留。独立事务重新核对计划摘要；不同声明、状态变化或审计失败不会移除 pending blocker。完全相同的请求可重放同一回执。

证据摘要只说明文件完整性，不是远程签名或远程存活/停止证明。导出的时间和本地状态摘要供操作人核对，远端文件过期后应重新导出；工具不能自动检测另一台机器在导出之后的变化。图恢复仍需要每个当前成员的实际停止及未决请求核对声明。没有新增 MCP 或 peer 写接口。

本入口覆盖原登记节点换代、已有真实接受合同的未决提议。仅成员换代但登记节点未换代、封存完成合同、缺少对方接受/停止/退出证据的提议仍不能套用。真实双机、桌面/供应商和长期运行另行验收。本机证据见 [专项测试](pending-relation-recovery-evidence.json)；测试中的两节点布局使用同一 Windows 主机的隔离数据库。
