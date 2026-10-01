# 图与本地拓扑恢复

本入口解决原登记节点或成员恢复换代后，**已停止工作且未决关系已核对**的项目重新登记问题。旧图、成员、合同、请求、边和本地绑定保留；新图使用新 UUID、epoch 和递增 generation。旧图返回 GRAPH_RETIRED，当前查询只显示后继图。它不是自动选主，也不能把仍活动的合同搬到新图。

## 使用顺序

1. 停止该项目各终端的派发与工作，核对原图的未决请求和备份之后可能遗漏的确认。仍有活动关系或未确认提议时，prepare 列出 blockers，apply 拒绝。成员集合必须相同；本入口只更新明确核对的成员 epoch。
2. 在原登记节点准备计划，核对输出的 plan_digest、旧图、成员及 blockers。prepare 以只读方式打开数据库，不执行迁移。
3. 收集每个成员的停止及未决请求核对声明，提交明确摘要。声明是操作人证据，不是系统自动确认远程进程已经停止。恢复后继续使用原登记节点 UUID；不能借此更换登记节点。
4. 把生成的登记恢复回执作为私有文件交给各端点。端点分别准备及提交本地重新绑定计划。回执摘要仅验证文件完整性，不是数字签名；此步骤只能由本机操作人使用，没有 MCP 或 peer 写入入口。
5. 按 topology.md 的正常 prepare/send 流程，取得新登记节点的真实确认。重新绑定最初是 unregistered，完成发布才变为 ready；任务仍为 released=false、human_gate=true，需操作人检查后明确放行。新凭据应绑定登记节点当前 epoch 和端点地址。

~~~powershell
node cli/graph-recovery.mjs prepare-registrar --db <登记DB绝对路径> --project <项目> --members-file <成员JSON>
node cli/graph-recovery.mjs apply-registrar --db <登记DB绝对路径> --plan-file <计划JSON> --digest <plan_digest> --attestation-file <全员声明JSON>
node cli/graph-recovery.mjs prepare-topology --db <端点DB绝对路径> --project <项目> --receipt-file <登记恢复回执JSON>
node cli/graph-recovery.mjs apply-topology --db <端点DB绝对路径> --plan-file <端点计划JSON> --digest <plan_digest>
~~~

命令输出为 JSON；错误退出码为 1，不输出输入中的路径或声明内容。数据库必须是现存普通文件的绝对路径。成员 JSON 是 `[{"node_id":"UUID","node_epoch":"UUID"}]`，与原图相同节点集合。

声明格式：`format=ai-fleet-graph-recovery-attestation/v1`，顶层包含计划的 node_id、node_epoch、plan_digest，以及 `unrecorded_confirmations_reconciled=true`、evidence_ref、attested_at。member_confirmations 必须覆盖全部成员，各项包含 node_id、node_epoch、old_graph_id、old_graph_epoch、`old_work_stopped=true`、`pending_requests_reconciled=true`、evidence_ref、attested_at。引用为 8–2048 字符的单行证据位置，时间为可解析时间戳。不要为其他终端猜填确认。

apply 在独立事务中重新比较状态摘要；陈旧计划返回 PLAN_STALE。相同计划及声明可重放同一回执，不重复创建代次。回执写入失败回滚整个变更，包括任务暂停操作。旧身份和历史保留触发器未放松。

## 存储及边界

关系 schema 从 3 升至 4，拓扑从 1 升至 2。新增 relation_graph_generations、relation_graph_transitions 和 topology_binding_generations、topology_recoveries；基表保留原代次，当前视图选取后继代次。领取、项目准入、MCP、巡检和历史查询使用相应当前/全历史视图。升级前停止旧进程，保留备份；不要让旧代码写入新数据库，也不要降低 schema 数字来回滚。

端点有未决拓扑、开放绑定或活动任务时拒绝；结束的任务行也不能代替执行停止证明。检查复用已有执行记录，要求已知未启动、Windows Job 清空，或已有明确标记的人工失联结算；未托管运行仍阻断。登记端全员声明仍不能由这些本机检查替代。

本次不迁移活动合同，不覆盖结果未知的拓扑请求。它们需要先通过各自协议结算；无法结算的恢复协调仍为待办。没有自动重新领取、额度返还、真实模型调用或 Tailscale 配置变更。局部测试通过不代表实体双机验收，见 [专项证据](graph-recovery-evidence.json)。
