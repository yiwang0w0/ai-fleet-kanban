# 委派端点绑定、双方就绪与受限放行（网络 schema v1，存储 schema v4）

本模块连接实际委派合同、已提交本地结构、关系登记确认和接收任务的放行。图回执仍只证明关系图；接收端还必须独立核对本机接受记录、本机工作合同和来源端的就绪通知。本批支持本机验证的 A→B→C 连续委派，不启动模型。

## 完整准备与放行顺序

1. 来源提出委派，接收方明确接受，来源取得接受回执。双方为同一项目完成本地图登记，接收任务仍未放行。
2. 来源选定唯一 relation_id 和完整关系描述，携带当前任务版本准备本方绑定。核对接受回执中的目标 UID、合同摘要、双方 node_id/epoch、项目、图身份和本方已提交修订。
3. 来源向固定登记节点审批该描述，并持久保存回执，然后向接收端发送同一描述的 proposal。消息在发送前持久化，不由接收端自行猜测另一份关系描述。
4. 接收端通过独立 delegation:binding 权限接收提案；本地 coordinate 核对当前任务版本、实际接受记录、完整公开工作字段及本方已提交结构后准备绑定。接收消息不自动替它作出这个决定。
5. 接收端通过自己的登记凭据审批，双方确认后登记节点产生 relation_confirmed 回执。双方各自通过固定登记节点接口取得、验证并保存该回执。
6. 来源确认本机绑定持久化后发送 source_ready。接收端只有同时拥有自己独立取得的相同登记回执，以及经过来源认证的 source_ready，才满足绑定授权条件。
7. 本机管理者或获准的 coordinate 使用带当前任务版本的 release_delegation 放行。后续执行仍经过原生任务、角色、源代码、预算、运行身份和执行器检查；放行工具不会启动模型。

~~~mermaid
sequenceDiagram
    participant A as 来源节点
    participant R as 关系登记节点
    participant B as 接收节点
    A->>A: 核对实际合同并持久绑定
    A->>R: 审批固定关系描述
    R-->>A: 待确认回执
    A->>B: 认证的 proposal
    B->>B: 协调身份核对并绑定实际任务
    B->>R: 独立审批
    R-->>B: 确认回执
    A->>R: 查询同一关系
    R-->>A: 确认回执
    A->>B: 来源本机已提交的 source_ready
    B->>B: 两份相同证明 + 当前授权 → 可显式放行
~~~

同一委派只能有一个活动绑定；同一任务每个方向最多一个活动绑定。接收任务可以继续向第三端委派，此时它的本机新执行仍暂停，避免同一工作在中间节点和下游同时被领取。

## 实际合同与本地约束

公开工作合同为 subject、description、acceptance、work_kind 和 capabilities。能力数组按集合顺序规范化，其余文本须完全相同；不会截断、合并或覆盖用户修改。来源 offer 中的历史 source_task_version 可以早于当前结构/遥测版本，但绑定必须重新携带当前 expected_version，并核对实际公开字段没有改变。

绑定工作本身已有活动运行、已完成或已归档时拒绝准备。来源本机准备后暂停该工作及其祖先的新领取和最终结案；已在运行的父任务仍可交付到等待状态。原生待审列表和自动目标结案也保留这道约束。接收任务取得双方证明前不能借释放按钮、直接 SQL 或另一条领取路径提前执行。

绑定期间工作正文、类型、路由及归档状态受保护；遥测、运行结果和不改变合同的其他字段按原规则处理。审批尚未在本机确认时，项目的新结构提交暂停，防止审批引用的本地图修订变化。确认后允许通过原有结构提交协议继续修改，登记节点仍核对包含跨端边的全图。

数据库写权限是本机信任边界；触发器和工具权限不防御能够直接删除触发器或伪造内部表的本机管理员。schema 初始化与替换旧执行保护在同一事务完成，重新迁移不会清空确认记录。

## 状态与历史事实

- prepared：本方实际任务已绑定，正在等待关系确认。
- confirmed：本方已独立保存确认回执；接收端仍需来源就绪及当前有效授权。
- cancelled：未确认申请已安全取消或取得登记节点撤回回执；保留全部历史。
- binding_authorized：接收端同时拥有两份匹配证明，来源当前凭据/项目/权限/代次有效。
- execution_authorized：还要求本方结构已提交，且自身没有继续向下游委派而暂停执行。这不代表已经放行或启动。
- dispatch_started：本批工具始终为 false。

原 delegation 接受回执的 state=accepted_unconfirmed、dispatch_ready=false 是不可变的历史决定，线上的旧回执格式不修改。本地 outgoingStatus/incomingStatus 和 MCP get_delegation 增加独立 binding 投影显示当前状态。不要仅凭旧接受回执判断最新执行条件。

## 权限、撤销与离线

peer 新增 POST /peer/v1/delegation/binding，正文上限 16 KiB，握手能力为 delegation-bindings-v1。凭据需要绑定来源节点/epoch，包含目标项目及 delegation:binding；实际处理同时核对既有 delegation:offer 授权。旧同步、旧委派读取或其他成员身份都不能发送就绪通知。

正文精确包含 schema_version、request_id、kind、relation、confirmation。proposal 的 confirmation 为 null；source_ready 携带来源已持久保存的关系确认。消息不包含任务正文、文件路径、命令或凭据。上传前认证，完成后在写事务中重新认证。相同消息 ID 内容改变会被拒绝，丢失响应可用原消息重试。

接收端按来源凭据版本记录就绪授权。撤销、撤权、轮换或退役代次会阻止新领取；轮换后需由当前来源凭据重发同一不可变 source_ready，留下新的授权版本。已经领取的运行仍可续租并保存候选交付，不会因隧道失联或来源凭据撤销丢弃结果。最终接纳与来源推进属于后续验收协议。

真实备份恢复激活后旧绑定不能复用新 epoch。节点、图或合同发生恢复冲突时保留历史并返回恢复错误，不自动转主、换图或重建授权。

## 重试与撤回

审批与撤回在网络调用前持久保存 request_id 和精确正文。未知结果必须先恢复原动作；不能从超时推定失败，再用不同动作消除保护。明确的版本/循环等拒绝发生在登记请求历史去重之后，才可记录 rejected 并以新请求核对当前图。

从未成功提交审批、所有尝试均明确拒绝且没有发出提案的来源绑定，可以离线取消。其余未确认绑定须取得登记节点的撤回回执。接收端即使撤销了来源授权，仍可使用自己的登记权限撤回未确认申请。

如果另一端的确认先于撤回完成，撤回明确返回 RELATION_CONFIRMED；本机保留绑定并允许查询恢复确认回执，不虚报取消成功。已确认关系不能使用该撤回流程取消。实际执行取消及停止证明见 [取消](cancellation.md)，已确认关系的取消退役和来源解锁见 [取消结算](cancellation-closure.md)。撤回未确认申请与取消已确认工作是不同流程。

网络、存储或响应丢失返回 retry_pending；身份/合同错误为 blocked。尚未准备的接收提案可按 [提案拒绝与保留](proposal-decisions.md) 显式关闭，来源仍须取得登记撤回回执。单次 CLI/客户端不包含后台重试调度。消息、审批、任务放行、事件和 MCP 成功回执均有事务测试；失败不能留下半次放行。

## CLI

所有命令要求明确的已初始化 DB 绝对路径，不会默认使用运行部署。打开时可初始化所需元数据。关系文件沿用 relation.schema.json，最大 8 KiB。

~~~powershell
node cli/binding.mjs prepare --db <DB> --relation-file <JSON> --version <当前任务版本>
node cli/binding.mjs approve --db <DB> --relation <UUID> --url <登记节点地址> --credential <登记凭据>
node cli/binding.mjs send --db <来源DB> --relation <UUID> --kind proposal --url <接收节点地址> --credential <接收端所签发凭据>
node cli/binding.mjs poll --db <DB> --relation <UUID> --url <登记节点地址> --credential <登记凭据>
node cli/binding.mjs send --db <来源DB> --relation <UUID> --kind source_ready --url <接收节点地址> --credential <接收端所签发凭据>
node cli/binding.mjs release --db <接收DB> --relation <UUID> --version <当前任务版本>
node cli/binding.mjs list --db <DB> --project demo
node cli/binding.mjs get --db <DB> --relation <UUID>
node cli/binding.mjs cancel --db <DB> --relation <UUID> --url <登记节点地址> --credential <登记凭据>
~~~

目标节点与地址、凭据文件由本机管理者选择，不能来自远端消息或任务文本。登记节点同时作为本方时使用同一真实登记实现，不建立伪造自认证凭据。源代码、真实执行器、费用和设备授权不因这些命令改变。

## MCP

| 工具 | 身份 | 输入与效果 |
| --- | --- | --- |
| list_bindings | coordinate、observe | project_id、limit（1–100），查看本项目绑定及认证提案 |
| get_binding_proposal | coordinate、observe | relation_id，读取提案摘要与当前决定 |
| decline_binding_proposal | coordinate | request_id、relation_id、expected_descriptor_digest、reason_code，拒绝尚未准备的提案 |
| get_binding | coordinate、observe | relation_id，读取当前本方绑定条件 |
| prepare_binding | coordinate | request_id、relation、expected_version，核对并持久绑定，不发起网络调用 |
| release_delegation | coordinate | request_id、relation_id、expected_version，只放行满足条件的本机接收任务 |

MCP 对项目和身份逐次核对，执行/审阅身份不能冒充协调者审批或放行。放行和原生 task_events、binding_events、成功工具回执一起提交；请求重试返回原始回执。get_sync_status 同时提供绑定摘要。网络投递由可信本机 CLI/服务负责，没有向 agent 开放任意凭据路径或 URL。

## 验收范围

见 binding-evidence.json。测试使用实际临时 SQLite、loopback HTTP、独立 OS 进程、真实 CLI 和备份恢复激活；三个节点实例的测试不代表三台物理设备。

本地候选、完成验收及取消结算各有独立协议和测试；完整 S06/G06 仍需自动投递、真实执行器和 Tailscale 多机闭环。实际调用与签收状态以 PROGRESS 的最新记录为准，完整阶段验收仍 0/12。

已确认绑定的执行取消见 [取消与停止证明](cancellation.md)。停止回执保持原绑定和来源保护，直到双端登记退役并在本端显式结算；来源保持未放行，执行端永久取消范围继续禁止重启。

候选报告和来源退回链路见 [候选结果与返工](results.md)。收到报告不解除来源绑定；正向验收通过 [完成协议](completion.md) 处理，取消结算不冒用成功完成回执。


登记节点已换代、原请求结果仍未知时，见 [本机绑定人工退出](binding-recovery.md)。该入口要求明确停止声明并保留任务人工闸；不会把网络错误当作撤回证明，也不负责重建关系图。
