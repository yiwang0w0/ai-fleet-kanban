# 尚未准备的绑定提案：拒绝与保留

本流程处理接收端已经收到认证 proposal、但还没有准备本方绑定的提案。例如，来源引用的接收端结构修订已经过期，接收端需要拒绝旧提案后允许来源重新提出。拒绝是接收端的持久本地决定，不依赖来源或登记节点在线。

## 决定与约束

coordinate 身份或本机 CLI 提供 relation_id、审核过的 descriptor_digest 和固定原因码。可用原因：

| reason_code | 含义 |
| --- | --- |
| stale_topology | 提案引用的结构已过期 |
| contract_changed | 当前工作合同已改变 |
| duplicate | 不再需要的重复提案 |
| operator_declined | 协调者明确拒绝 |

只有尚无本方 delegation_bindings 行的提案可以拒绝。已有 prepared、confirmed 或 cancelled 绑定都不能被该操作覆盖；尤其未知审批结果不能借此解除保护。数据库写事务和触发器共同串行化拒绝与准备竞争，两者至多一个成功。

拒绝记录绑定原始摘要、原因及时间，与审计事件一起提交。相同决定重复调用返回原结果，不重复写入；不同摘要或原因返回冲突。历史提案、收件箱、决定和审计不可更新或删除。MCP 成功回执同事务保存，审计或回执落盘失败会整体回滚。

本地拒绝不需要当前来源授权，允许在来源被撤权、来源离线、当前任务文字或结构已变化后清理待办。恢复换代前的旧目标 epoch 提案保留为历史，不能由新 epoch 继续审批或拒绝；它们不占新 epoch 的待处理容量。

## 与来源协调

来源重发原 proposal 时，接收端先核对当前来源授权、实际接受记录和消息身份，然后返回 PROPOSAL_DECLINED。消息上传途中发生的本地拒绝也在上传结束后的事务内重新检查。

过去的 binding_message_received 只证明当时收到了消息，收件箱和来源发件箱内的历史 ACK 不会被重写。客户端将当前拒绝报告为 blocked / PROPOSAL_DECLINED。丢失该拒绝响应时仍可重试原消息；后续相同请求会再次得到当前拒绝。

来源须用自己的固定登记权限取得未确认关系的撤回回执，才可解除来源任务保护。接收端拒绝不直接修改来源绑定、取消已确认关系或终止模型。若登记已经确认，已有 RELATION_CONFIRMED 保护仍有效，应进入后续执行取消/关系退役流程。

希望继续使用同一份已接受合同的来源，在确认旧关系撤回后可用新的 relation_id 提出绑定；新提案重新核对双方版本与结构，接收方重新决定。旧提案和拒绝记录完整保留。

## 列表与容量

list_bindings 返回：

- bindings：最近的本方绑定记录。
- proposals：最近提案及当前本方状态、摘要、原因和 identity_current。
- pending_proposals：当前目标 epoch 中尚未准备且未拒绝的提案，按最早收到优先列出。
- pending_count：当前目标 epoch 中尚未准备或等待确认的提案总数。

最近历史与待办分别限量返回；大量新关闭记录不会遮住老的待办项。prepared 绑定仍占等待确认容量；declined、confirmed、cancelled 以及旧目标 epoch 不占。每项目同时最多 1,000 个等待提案。拒绝一个提案只释放一个活动槽位，不删除历史，也不降低历史审计完整性。

## CLI 与 MCP

~~~powershell
node cli/binding.mjs get-proposal --db <DB绝对路径> --relation <UUID>
node cli/binding.mjs decline --db <DB绝对路径> --relation <UUID> --digest <descriptor_digest> --reason stale_topology
node cli/binding.mjs list --db <DB绝对路径> --project demo
~~~

get_binding_proposal 对 coordinate 和 observe 开放；decline_binding_proposal 仅对 coordinate 开放，输入额外携带 request_id。两者都逐次校验项目范围；不能查到其他项目的提案。执行与审阅身份不获得该拒绝能力。

## 存储升级

binding_schema 从 1 升至 2，新增 binding_proposal_decisions 和两道互斥触发器，升级在一个事务完成。失败保留旧版本，不留下半次升级。版本 1 数据库仍可通过新版本只读列表查看；首次需要写入的管理命令或网关启动会迁移。

旧版本绑定管理命令因不支持 schema 2 而拒绝继续使用，避免把新的拒绝决定当作未处理提案。网络消息保持原有 schema_version=1；PROPOSAL_DECLINED 是明确的当前拒绝，旧客户端仍会按 HTTP 错误阻止该次投递，不据此放行。

## 验证与后续

测试覆盖 1,000 项队列满载与容量恢复、历史保留、原消息重试、实际 HTTP 上传中拒绝、授权边界、MCP 审计/响应回滚、schema 升级失败与重启、独立进程准备/拒绝竞争、实际备份恢复换代，以及撤回后新提案完成双端放行。准确结果见 proposal-evidence.json。

后台服务主动投递拒绝通知、定时查询/重试和全局 UI 尚未接入。本流程不替代执行取消、晚到结果处理、候选交付/证据及来源验收，也不代表真实多机测试通过。
