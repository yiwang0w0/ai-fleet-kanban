# 候选结果回传与来源退回

此批实现 T06.05 的候选报告和返工链路。收到报告、执行端本机结案、来源最终验收是三个不同事实；当前没有远端通过验收的接口。来源任务和祖先的委派保护继续保持。

## 准备候选

接收端 coordinate 以固定 result_id、relation_id 和当前任务版本准备交付。关系须已确认，或已按原停止证明取消退役并仅保留历史交付；项目结构已提交。根任务必须 waiting 或 done，保留实际 run_id；本机子任务必须完成，子树都属于同一登记项目。根运行须由当前节点/epoch 的 broker 启动并结算，下游来源委派须完成后才能向上交付。

每个范围内的历史运行都要具有停止证明。共享核验器接受未启动并已放弃、明确标识的 fixture 终态，或实际观察的 not_started / Windows Job 清空。仅报告完成、租约到期、数据库状态或 POSIX group_signalled 不足以证明停止。根候选须有已启动许可和结果，不能用未运行任务造交付。

消息绑定完整原始合同、双方身份/epoch、交付轮次、任务版本、run/dispatch/agent/role/策略摘要、执行模式、模型/effort、结果摘要和范围证明摘要。报告与进程 evidence 各最多 128 KiB UTF-8，整个消息最多 384 KiB；范围最多 10000 卡、100000 条运行。此批传输文本报告和摘要，尚不传文件内容、补丁或完整验证证据。

同一关系只允许一个未裁定候选，每次返工须有新运行。旧运行即使更换交付 UUID 也不能再次包装。每项目当前 epoch、每侧最多 1000 个未裁定候选。取消后的最终清理及容量释放仍待完成，不删除历史回收空间。

准备与审计一起提交，并封存子树成员当前版本。禁止改卡、删除、新增子卡、改变相关父边或发起新下游委派；原生领取和审阅也检查封存。节点恢复仅通过同一事务内的私有许可执行隔离，不产生验收决定、不放行任务。旧 epoch 候选不能继续推进。

## 交付与返工

1. 执行端向原来源端发送已保存的候选。必须由来源签发反向凭据，具备 peer:handshake 和 delegation:result 及该项目授权；消息不能改变服务器地址或提供任意命令。
2. 来源在上传前和事务内重新核对当前授权、固定合同和连续轮次。原子保存报告与审计，返回 result_received。相同 ID/内容重发返回同一 ACK，内容改变则拒绝。不会为来源伪造 task_run，也不会把原任务设为完成。
3. 来源 coordinate 可以用固定 decision_id、当前来源任务版本及具体说明退回候选。决定和审计/MCP 回执原子保存；已有取消意向则不再发起返工。
4. 执行端轮询，保存匹配 ACK 与拒绝决定后，通过原生 resolve 原子返回返工队列。执行端此前本机 done 也能按此链路重新打开，原生审计保留原状态。任何回执或审计失败会回滚整次变更；不会直接启动 agent。
5. 如果来源先拒绝、执行端随后收到取消，再收到该拒绝，则只保存拒绝历史，不重新启动或放行工作。新运行结束后才可产生下一轮候选。

网络/存储失败、408、429、5xx 返回 retry_pending，授权或合同错误返回 blocked；使用同一交付 ID 重试。此批只有显式单次 send/poll，后台重试服务仍待完成。收到 ACK 不等于通过验收；取消后的晚到报告保留为待裁定历史。review_state=cancel_pending 表示该候选被取消流程隔离，不允许验收或返工；退役是否完成另看 get_cancellation.closure_phase。即便已有物理停止证明，也须通过 [取消结算](cancellation-closure.md) 关闭绑定。

execution_mode=provider 表示受控进程路径，不能单独证明真实供应商调用。real_model_call_confirmed 在此合同中固定 false，合成 Node 进程测试也保留该值。fixture 不计入真实供应商验收。

## CLI 与 MCP

~~~text
node cli/result.mjs prepare --db <执行端DB绝对路径> --relation <UUID> --id <交付UUID> --version <当前任务版本>
node cli/result.mjs send --db <执行端DB> --result <UUID> --url <来源节点地址> --credential <来源签发的反向凭据>
node cli/result.mjs reject --db <来源DB> --result <UUID> --decision <UUID> --version <来源任务版本> --note <返工说明>
node cli/result.mjs poll --db <执行端DB> --result <UUID> --url <来源节点地址> --credential <来源签发的反向凭据>
node cli/result.mjs get --db <DB> --result <UUID>
node cli/result.mjs list --db <DB> --project <项目>
~~~

命令要求显式数据库路径。send/poll 未解决时退出码 2，输入/状态错误退出码 1。get/list 只观察，列表最近最多 100 项并标识 identity_current。

| MCP 工具 | 身份 | 参数 |
| --- | --- | --- |
| get_result | coordinate、observe | result_id |
| list_results | coordinate、observe | project_id、limit |
| prepare_result | coordinate | request_id 作为交付 ID、relation_id、expected_version |
| reject_result | coordinate | request_id 作为决定 ID、result_id、expected_version、note |

MCP 每次核对项目范围，不向 agent 暴露 URL、凭据路径或供应商启动权限。执行/审阅身份不能自行签署来源决定。

## 验证与后续

本机完整主套件 1308 项通过，0 失败；18 项结果专项包含真实 SQLite、HTTP、独立 CLI/MCP/竞争进程、事务故障回滚、恢复激活和监督的合成进程。源码摘要和准确结果见 result-evidence.json；合成进程及回环节点不代替 Tailscale 实机和真实供应商验收。

后续仍须文件产物传输与本地安全落盘、仓库/基线和独立工作区、独立验证、来源授权验收、双方关系退役及父任务推进、后台投递和页面。当前成功报告保留 pending_evidence，不会自动完成业务闭环。完整 G06 和全部阶段均未据此宣布通过。
