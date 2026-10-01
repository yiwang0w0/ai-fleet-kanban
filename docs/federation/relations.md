# 项目关系登记合同（部分实现，schema v1）

每个协作项目显式指定一个登记节点和 1–32 个参与节点的 node_id/epoch。登记节点可以同时是任务所有者，也可以只登记关系。终端名不用于身份、授权或图主键。每项目在该登记库只绑定一个 graph_id/graph_epoch；不自动更换成员、代次、登记节点或选主。

这批实现验证**申报的关系图**，并保存双方确认。本地任务结构变更已通过 topology.md 所述的交集提交协议与远端申报绑定；双方端点绑定与受限放行见 bindings.md。因此所有关系状态的 dispatch_ready 均为 false，原 accepted_unconfirmed 任务仍受数据库执行闸保护。不能以登记通过作为整套全局防环或 G06 的验收结论。

## 图、版本与防环

每个任务顶点为 owner_node_id/task_uuid。本地图只含 task_uid、parent_uid、blocked_by，申报者只能提交自己的顶点；全部本地父/依赖端点必须同时在申报中。规范 JSON 见 topology.schema.json。正文不包含标题、描述、工作命令、证据路径或模型凭据。

所有边表达“起点等待终点”：

- 本地父任务 → 子任务；
- 本地任务 → blocked_by 中的前置任务；
- 委派来源任务 → 接收方任务。

登记按 SQLite BEGIN IMMEDIATE 串行处理。新增/替换本地图以及确认跨端边都核对 expected_version，然后对当前全部本地图和已确认跨端边运行迭代拓扑排序。重复的同一对端点只算一条等待边；自环、局部父子/依赖混合环、跨端组合环均拒绝。允许不同任务之间 A→B 与 B→A 独立协作，不按终端根粗略拒绝所有双向连接。

图版本从 1 开始；成功发布本地图、首次确认跨端边各增加 1。首次本地图 revision=1，之后严格加 1。更新本地图不能删除已确认端点或引入新环。任务 UID 的项目/所有者首次登记后不可迁移，即使它已从当前快照移除。

单图最多 10000 个顶点、100000 条唯一等待边/已确认关系；单快照规范 JSON 最多 4 MiB。每项目最多 1000 条未确认且未撤回的申请。历史请求、审批、事件、已确认边与绑定保留且不可直接修改/删除；容量清理与已确认关系撤销未实现。

## 双方确认及过期申请

relation.schema.json 的 delegation_id 对应既有工作合同；relation_id 是本次确认申请的 UUID，两者不同。申请绑定项目图身份、双方身份/epoch、双方 task_uid、本地图修订和完整 offer_digest。

双方分别通过自己的 relations:approve 凭据确认同一描述。首方确认只建立待确认记录；只有双方目前有效的授权都存在才加边。凭据必须属于该项目当前成员；参与节点即使有审批权限，也不能替其他端点审批。每次操作都重新核对数据库中的凭据版本、状态、权限、项目与退役 epoch。审批后、另一方确认前发生撤销、轮换或撤权，会使旧审批失效。恢复权限后需要新的 request_id 再确认。

relation_confirmed 回执含图版本/摘要、完整关系描述及双方 node_id/epoch/credential_version。同一 delegation_id 全库最多一条已确认关系。来源合同和接收决定的本地真实性还须由后续本机绑定协议核验；登记节点当前只验证双方所申报的数据。

如果等待期间本地图 revision 已更新，旧申请不能继续确认。任意一方可撤回**未确认申请**；保留原记录，新建 relation_id 后按新修订再次取得双方确认。withdraw 不取消工作合同、不删除已确认边，也不终止任务。图已确认后不能借该接口撤回。

成功请求按 graph_id、调用节点/epoch、request_id 保存回执；同一 ID/内容重试返回原回执，换操作/内容则 REQUEST_CONFLICT。原回执是历史事实，可能早于当前图版本、撤回或授权变化；状态接口用于读取当前申请状态，已有确认的状态仍返回其历史确认回执。它不是新的执行授权。

写入失败、循环和 CAS 冲突回滚当前事务中的全部变化，包括第二方审批、图版本、边、审计和请求回执。首方既有待确认记录保留，可查询或撤回。

## peer API

仅在原独立 loopback peer 网关上提供，不自动开放外部监听、Tailscale Serve 或浏览器 UI。需要独立凭据；旧同步权限不包含以下权限。上传前认证，正文接收完成后在事务内再次认证；浏览器 Origin、重复 Authorization、压缩、非法 UTF-8 和超限正文均被拒绝。

| POST 路径 | 权限 | 精确正文 |
| --- | --- | --- |
| /peer/v1/relations/publish | relations:publish | request_id, expected_version, snapshot |
| /peer/v1/relations/approve | relations:approve | request_id, expected_version, relation |
| /peer/v1/relations/withdraw | relations:approve | request_id, project_id, graph_id, graph_epoch, relation_id |
| /peer/v1/relations/status | relations:read | project_id, graph_id, graph_epoch, relation_id |

status 中 relation_id=null 返回图身份/版本、成员、各终端修订/摘要、图摘要及待确认数，不返回完整任务内容；指定 UUID 返回该申请状态。publish HTTP 上限为 4 MiB + 4096 字节，complete/cancel 为 32 KiB，其余接口为 8 KiB；所有对象拒绝未知字段。握手能力名为 project-relations-v1。

本机管理员可读取自己的登记图，即使本机不是成员；发布/审批仍须列为成员。远程身份不能冒充本机管理员。该本地管理边界依赖数据库文件权限，不防御已经拥有本机数据库写权限的攻击者。

## 本机 CLI 与预览

~~~powershell
node cli/relations.mjs create --db <登记节点DB绝对路径> --project demo --members-file <成员JSON绝对路径>
node cli/relations.mjs list --db <登记节点DB绝对路径>
node cli/relations.mjs status --db <登记节点DB绝对路径> --project demo --graph <UUID> --graph-epoch <UUID>
node cli/relations.mjs preview --db <所有者DB绝对路径> --project demo --graph <UUID> --graph-epoch <UUID> --revision 1
~~~

成员文件为 [{node_id,node_epoch}]，最多 16 KiB。每条命令都要求明确指定已初始化看板 DB，不会默认连接运行部署。CLI 打开时可初始化 peer/关系元数据 schema；preview 对任务本身只读，不冻结、不发布、不放行、不创建运行。它只选择显式 broker 项目登记的任务，包括归档任务，并要求父子/依赖全部已登记到同项目；发现跨项目或未共享端点时拒绝，不隐式共享。未初始化 broker 时返回 BROKER_NOT_INITIALIZED。

本地结构发布及受限 MCP 准备工具见 topology.md。双方 approve 的端点合同核验及受限放行见 bindings.md；后台调度仍未完成，登记回执本身仍非执行授权。

## 断线、恢复与验收边界

登记节点不可达时，不存在本地替代确认入口。本批没有轮询重试器，也没有对已领取任务或运行增加新的网络依赖。真实断网执行、重连与结果推进需在后续完整链路验收。

数据库重启保留请求和已确认关系。备份恢复副本先受 RESTORE_HOLD 保护，实际激活换代后旧图返回 GRAPH_RECOVERY_REQUIRED；list 仍可显示 identity_current=false。不能通过重建同项目图、伪造旧代次或自动选主跳过恢复核对。工作已停止且未决关系已核对时，可以使用 [图恢复](graph-recovery.md) 建立后继代次；活动合同和未知确认的恢复协调仍待完成。

验证覆盖独立进程相反边竞争、混合路径循环、无环双向协作、HTTP 丢失回执后重发、上传期间撤销、凭据轮换、过期申请撤回重提、事务故障、队列恢复、正文限额、本地隐私字段排除及实际备份激活。测试使用临时数据库、合成任务和回环网络，没有使用真实模型、生产数据或其他电脑。

取消退役见 [双端取消结算](cancellation-closure.md)：登记双方当前凭据对同一停止证明投票，保留历史边，活动图排除已取消关系；它与正常完成互斥。物理多机分区、自动投递和独立阶段验收仍未完成，执行层不能直接信任历史 relation_confirmed。
