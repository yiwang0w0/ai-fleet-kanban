# 登记节点换代后的已停止合同协调

登记节点备份恢复会更换 epoch。旧图的活动合同不能直接搬到新图；即使两端已经停止，旧取消协议也不能把新登记进程当作旧代次继续确认。本入口把**已经在两端保存同一取消及停止回执**的合同明确退役，再走既有图恢复流程。

本机管理者分别核对端点、登记节点和端点结算三个计划。所有写入需要计划摘要及操作人声明；没有 peer/MCP 写入入口，不自动选择登记节点、放行、重派、返还额度或验收结果。原图边、合同、任务、结果、停止证明和审计保留。

## 适用条件

- 同一登记节点 UUID 已实际恢复到新 epoch，原登记进程及其重新启动入口已禁用。
- 两端都保存同一个 `cancel_stopped` 回执。执行端本机还必须保留原停止证明；当前任务和全部运行再次检查，ended 行本身不算进程停止。
- 下游绑定先从叶子向上结算。未封闭的下游、活动/失联未结算运行继续阻断。
- 待裁定结果先由任务所有者决定；恢复不会丢弃候选。已固定完成意图、未确认关系和未决拓扑请求仍需各自恢复流程，此入口不把它们改成取消。

支持登记节点独立部署，也支持来源端兼任登记节点。当前实现针对登记节点换代；仅成员换代、登记节点未换代的协调不在此入口内。

## 操作顺序

所有文件放在本机私有目录；下列 `<...>` 必须替换为实际值。prepare 和 status 以只读方式打开现存数据库，不安装迁移。各步骤的 JSON 输出单独保存，不能为离线设备猜填确认。

1. 原取消协议先完成两端的停止回执收集；保留原结果和停止证据。参见 [取消结算](cancellation-closure.md)。若备份遗失所需记录，本入口明确拒绝，不把“查不到”当作未执行。
2. 在每个端点准备并记录本机确认，分别保存输出回执：

~~~powershell
node cli/contract-recovery.mjs prepare-endpoint --db <本机DB绝对路径> --relation <关系UUID> --registrar-epoch <实测新登记epoch>
node cli/contract-recovery.mjs record-endpoint --db <本机DB绝对路径> --plan-file <端点计划JSON> --digest <plan_digest> --attestation-file <本机声明JSON>
~~~

3. 在恢复后的登记节点，将两个不同端点的实际回执组成 JSON 数组，核对原图边、双方合同、确认摘要及停止证明一致，然后记录退役：

~~~powershell
node cli/contract-recovery.mjs prepare-registrar --db <登记DB绝对路径> --relation <关系UUID> --receipts-file <双方回执数组JSON>
node cli/contract-recovery.mjs record-registrar --db <登记DB绝对路径> --plan-file <登记计划JSON> --digest <plan_digest> --attestation-file <登记声明JSON>
~~~

4. 把登记退役回执交给两端，分别明确结算：

~~~powershell
node cli/contract-recovery.mjs prepare-settlement --db <本机DB绝对路径> --relation <关系UUID> --receipt-file <登记退役回执JSON>
node cli/contract-recovery.mjs record-settlement --db <本机DB绝对路径> --plan-file <结算计划JSON> --digest <plan_digest> --attestation-file <本机声明JSON>
node cli/contract-recovery.mjs status --db <本机DB绝对路径> --relation <关系UUID>
~~~

5. 按 [图恢复](graph-recovery.md) 收集全员声明、建立后继图、重新绑定并发布拓扑。任务仍未放行且有人工闸。来源所有者可在核对后明确选择后续工作；原执行端取消范围不能再次领取。

相同计划及相同声明可幂等重放，取回原回执。更新了任务/合同/停止记录时，旧计划返回 PLAN_STALE；不能改摘要绕过重新准备。写入失败回滚任务控制、绑定关闭及审计，不返回半成功。

## 声明与证据含义

每个 record 命令需要如下声明。模板布尔值不能直接用于提交；只有实际确认后才填写 true。端点步骤核对本机记录，登记步骤核对两个端点原始回执，结算步骤核对登记回执确实包含本机持久确认。

~~~json
{
  "format": "ai-fleet-contract-recovery-attestation/v1",
  "node_id": "<当前计划 node_id>",
  "node_epoch": "<当前计划 node_epoch>",
  "plan_digest": "<明确核对的摘要>",
  "old_registrar_disabled": false,
  "endpoint_records_reviewed": false,
  "no_automatic_release": false,
  "evidence_ref": "<实际停用与核对证据的私有引用>",
  "attested_at": "<实际确认时间 ISO 8601>"
}
~~~

文件摘要证明完整性，不是数字签名或远程进程存活探测。登记回执明确 `authority=operator_reviewed_endpoint_receipts`，端点结算明确 `operator_reviewed_recovery_settlement`；所有回执 `accepted=false`、`automatic_release=false`。只读绑定/取消详情和 status 显示 `recovered_cancelled`，不冒充普通 peer 协议的停止认证。

## 存储、升级及验证

新增 `contract_recovery_schema=1` 与三个不可更新/删除的表：端点确认、登记退役、端点结算。原关系边和绑定身份不改写。端点关闭继续要求既有 `binding_cancellations` 记录和原 close guard；这里记录具有明确恢复格式的取消退役文件，不伪造普通网络回执。既有触发器没有删除或放松，完成与取消仍互斥。

升级前停写、备份并核对 [0.24.0 迁移说明](migration-0.24.md)。不要混用旧写入者或通过降低 schema 数字回退；新记录的回退采用已核验备份和隔离恢复。升级前准备的图恢复计划需重新准备，因为状态摘要现在包含已记录的恢复退役。

[本机证据](contract-recovery-evidence.json)覆盖实际 SQLite 备份/换代、独立及同机登记形态、缺少/替换一端确认、陈旧计划、停止前拒绝、写入回滚和 CLI。没有实体双机、真实模型或生产迁移。封存完成合同、仅成员换代与未知拓扑结果的协调仍未完成；阶段与独立签收保持 pending。
