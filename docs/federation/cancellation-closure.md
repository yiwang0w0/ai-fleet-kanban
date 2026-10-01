# 取消后的关系退役与本地结算

停止证明落盘后，来源仍不能直接重新领取任务。H4a 的闭环是：两端向固定登记节点确认同一取消请求和停止证明，登记节点保留历史边并把它移出活动图；各端再显式消费该回执。来源绑定关闭，任务保持未放行；执行端取消范围永久保留，不能因结算、重启或旧就绪消息重放恢复运行。取消没有业务验收、依赖完成或模型启动的含义。

## 状态与操作

原 `state=pending/received/stopped` 表示取消送达及停止情况，终态停止回执保持不变。`get` 和 MCP `get_cancellation` 另返回 `closure_phase`：

| closure_phase | 已证明的事实 | 下一步 |
|---|---|---|
| awaiting_stop | 尚未取得停止证明 | 接收端 progress，来源 send/poll |
| stopped | 本端已有匹配停止证明 | 两端分别向登记节点 retire |
| voting | 已有本端持久登记请求，双端登记尚未确认 | 用相同待定请求重试，或 retire-poll |
| retired | 已保存匹配的双端登记回执 | 本端以当前任务版本 settle |
| settled | 本地绑定、任务暂停和结算回执已原子提交 | 来源按正常权限重新判断是否放行；执行端保持取消 |

`retired` 只表示本端已保存登记回执，不推定另一端已完成本地结算。迟到响应和重复命令沿用原 ID、固定内容；有未知远端结果时不另建请求。图版本冲突是明确拒绝，可重新读图再提交新请求；其他未知结果保留原请求。登记节点不可达时保留绑定，不另设替代登记节点。

## 执行顺序

先按 [取消协议](cancellation.md) 完成 request、send、接收端 progress 和来源 poll。若取消范围含下游委派，先自底向上取得停止证明，再自底向上完成关系退役及本地结算；未结算的下游绑定会阻止上游执行端投票。

每个端点运行一次以下命令。地址及凭据来自可信本机配置，指向绑定中固定的登记节点，不能取自任务正文：

```text
node cli/cancellation.mjs retire --db <端点DB绝对路径> --relation <关系UUID> --url <登记节点地址> --credential <登记凭据文件>
node cli/cancellation.mjs retire-poll --db <端点DB绝对路径> --relation <关系UUID> --url <登记节点地址> --credential <登记凭据文件>
node cli/cancellation.mjs get --db <端点DB绝对路径> --relation <关系UUID>
node cli/cancellation.mjs settle --db <端点DB绝对路径> --relation <关系UUID> --version <当前任务版本>
```

登记节点与来源同机时，该端点的 retire/retire-poll 省略 url 和 credential，直接使用已登记的本机成员身份；另一端仍通过认证 HTTP。无须第三台电脑。retire 返回 waiting_peer 时退出码为 2；只有取得回执才进入 retired。网络、存储失败、阻断或图版本拒绝也返回 2，不能把退出成功或一次送达等同完整结案。

settle 必须使用当前任务版本，陈旧版本不自动替换。成功回执保留原 expected_task_version，重试原版本得到同一结算；不把旧结算重新作用于后来的任务状态。来源若原先 released=true，会在结算事务内设为 false；不改变任务所有权、业务状态或验收结果，不自动推进父任务。之后正常显式放行可再次领取来源工作或建立新的委派。执行端与其取消成员继续不可领取。

MCP `settle_cancellation` 只对同项目 coordinate 开放，参数为 request_id、relation_id、expected_version；业务修改与持久工具响应同事务。observe 可读取，执行/审阅角色不能结算。网络 retire 仍由可信 CLI/服务负责，MCP 不接收任意 URL 或凭据路径。失败审计和限流记录按 MCP 原合同保留，不与失败业务变更一起回滚。

## 证明及权限

新能力为 `delegation-cancellation-closure-v1`。新客户端在握手后才投递，旧登记节点未声明该能力时拒绝。POST /peer/v1/relations/cancel 需要现有 `relations:complete` 生命周期退役权限及项目范围，正文上限 32 KiB，内部取消合同上限 16 KiB；仍需 `peer:handshake` 和 `relations:read`。

合同包含原取消请求、完整关系及不可变停止回执。登记节点核对已确认历史边、双端 node_id/epoch、当前授权和凭据版本，只有双方对同一摘要投票才退役。已撤销或旧凭据版本的投票不计入；换代不能复用旧证明。正常完成提案和取消退役提案在登记节点互斥，本地完成意向也不能转成取消，不会把取消伪装为成功验收。

历史 relation_edges 保留，新增 relation_cancellations 标明从活动图排除的依据。本地 binding_cancellations 绑定登记回执，关闭时 state=cancelled、closed=1；正常完成仍为 completed，查询与看板关系展示区分两者。结算失败时任务暂停、绑定关闭、事件及成功响应整体回滚。封存候选与文件不会被结算删除；满足原候选合同的迟到报告仍可按原 ID/轮次保留，不能因此恢复执行、要求返工或自动验收。

## 升级和验证范围

关系存储升至 schema 3，绑定存储升至 schema 4；取消停止存储仍为 schema 1，退役请求/回执/结算使用独立 cancellation_closure_schema 1。按 [0.24 迁移说明](migration-0.24.md) 停止旧写入者后升级，不混用新旧写入代码。读取历史关系的看板兼容关系 schema 2/3、绑定 schema 3/4；旧节点可继续其既有协议，但不参与新的取消退役。

本地 CLI、HTTP、故障注入及两节点实例证据见 [H4a 验证记录](cancellation-closure-evidence.json)。这些测试不是两台实体 Windows 电脑的验收。自动投递、取消交付物的长期保留/清理、未知进程的人工停止核验及实体联调仍按原计划推进；不删除隔离标记或补写停止证明。
