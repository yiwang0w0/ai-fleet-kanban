# 已确认委派的取消与停止证明

本批实现 T06.04 的本地部分闭环。来源持久保存取消意向，接收端冻结新启动，再以实际进程观察和下游回执确认停止。完整阶段仍需来源验收、关系退役、后台投递和实体 Tailscale 联调。证据见 [cancellation-evidence.json](cancellation-evidence.json)。

## 状态及边界

| 来源状态 | 已证明事实 | 尚不能据此断言 |
| --- | --- | --- |
| pending | 已保存固定取消 ID、合同、epoch、原因和来源任务版本 | 请求已送达，或者远端已停止 |
| received | 接收端已持久保存取消范围并阻止新领取、放行和启动 | 已启动的进程或下游任务均已停止 |
| stopped | 匹配本次请求的停止证明已落盘 | 业务结果已被来源验收、关系已退役、来源可重新运行 |

重复请求复用同一 ID 和内容，终态证明不可替换。失败、超时和丢失 ACK 保留已知状态；本地落盘失败重试读取同一远端证明。来源任务及祖先的原有绑定保护保持。取消不会自动完成任务、释放依赖、转移所有权或退还已经消费的启动许可。

委派合同以单张卡片为单位，不迁移来源既有本地子树。接收端取消范围包括接收任务及其本地子树、这些卡片下派的远端工作；不把来源未委派的其他本地卡片当作远端取消范围。现有父任务推进仍需满足全部本地子卡和远端验收条件。

## 冻结范围与事务

接收端逐次校验当前来源凭据、项目、固定节点/epoch、完整委派合同和 delegation:offer / delegation:control 权限。HTTP 上传完成后在写事务中重新鉴权。来源已确认而接收端的独立确认回执尚未落盘时，匹配的 prepared 端点也可接收取消，以避免未知确认结果妨碍停止。

范围是实际父子图，以及本项目尚未完成结构操作的 before / desired 图中接收根的后代并集。分别遍历每张图，避免混合不同版本的边。最多 10000 张卡，拒绝跨项目或未登记成员。取消成员永久保留；不能新增子卡、准备新下派或重新挂接冻结范围。先前已持久化的结构操作仍可恢复完成或撤回。

SQL 和原生查询共同阻止新领取、放行、启动和最终结案。启动许可与接收取消通过 SQLite 写事务串行化：许可先提交时保留已消费预算，必须等待实际停止；取消先提交时拒绝许可并不消费预算。dispatch 与取消模块无论按哪个顺序迁移，都安装数据库启动保护。

progress 在事务中处理未启动分派、下游取消意向和停止证明；MCP 响应也在外层同一事务提交。审计、原生任务状态、身份撤销或成功响应写入失败，全部回滚。

## 什么可以证明停止

- 从未消费启动许可的分派可变为 abandoned；包括本地任务已先结束、分派变为 interrupted 的情况。不会调用模型或消费额度。
- 已启动的 provider 分派必须保存与其固定启动配置匹配的完整进程观察。当前强停止证明支持未启动的 not_started，或者 Windows Job 已清空的 job_empty。
- POSIX 的 group_signalled 只证明已发停止信号，不能当作整个进程树已确认清空，保持 received 并列出 process_stop_unconfirmed。
- 任务报告、租约到期、SQL 中 run 已结束、网络失联及没有进程观察的历史运行，都不算物理停止。
- fixture 终态只算合成测试证明，receipt.fixture_runs 明确记录本机 fixture 次数。下游证明另以固定回执摘要记录；不能用本机计数为零推断整条链均为真实供应商调用。
- 下游来源绑定须取得匹配本机 epoch 的停止回执。尚未发送的准备可以直接关闭；结果未知的审批必须先恢复原请求，再确认登记节点撤回，不能只看离线或超时就跳过。

受监管运行每 250 ms 检查持久取消记录，通过现有 supervisor 终止本机进程树；数据库无法读取也触发停止。收到取消后即使来源凭据撤销，本机停止仍继续。runner 先保存观察日志再结算；日志恢复不重新启动模型。

取消之后到达的原运行结果保留为 cancelled_work_result_retained，进入等待裁定；先前 MCP 报告保持历史，最终 done 受数据库保护。此批尚未实现来源最终验收与取消裁定的统一排序，不能宣称整个业务生命周期已闭环。

## CLI 与受限 MCP

所有命令必须显式指定数据库绝对路径；凭据、节点地址由本机可信操作者配置，不来自任务正文。

~~~text
node cli/cancellation.mjs request --db <来源数据库> --relation <关系UUID> --id <取消UUID> --version <当前任务版本> --reason operator_cancelled
node cli/cancellation.mjs send --db <来源数据库> --relation <关系UUID> --url <接收节点地址> --credential <对端凭据文件>
node cli/cancellation.mjs progress --db <接收数据库> --relation <关系UUID>
node cli/cancellation.mjs poll --db <来源数据库> --relation <关系UUID> --url <接收节点地址> --credential <对端凭据文件>
node cli/cancellation.mjs get --db <数据库> --relation <关系UUID>
node cli/cancellation.mjs list --db <数据库> --project <项目>
~~~

request 原因为 operator_cancelled 或 deadline_exceeded；后者是显式业务决定，不代表已存在后台截止时间调度。upstream_cancelled 仅由本地下游级联生成。progress 的本地未决阻碍、send/poll 的重试或阻断返回退出码 2；其他错误为 1。成功发送接收 ACK 可以退出 0，但调用方仍须检查 stopped，不能仅凭退出码显示已取消。

MCP 的 get_cancellation、list_cancellations 对 coordinate / observe 开放，request_cancellation、progress_cancellation 仅 coordinate；逐次校验项目权限和写请求幂等。MCP 不提供任意 URL、凭据路径或模型启动。列表包含 identity_current；恢复换代前的历史可读但不能作为当前停止证明继续使用。

peer 协商能力 delegation-cancellation-v1，并使用 POST /peer/v1/delegation/cancel 与 cancel-status，正文上限 16 KiB。状态查询在鉴权后只返回已有接收或停止回执，不修改分派、任务、身份或取消证明。接收端须显式使用本地 progress / MCP progress_cancellation 推进，轮询不会代为推进；下游网络发送仍是独立步骤。

新客户端 poll 要求对端声明 delegation-cancellation-status-readonly-v1；旧节点缺少该能力时返回 REQUIRED_FEATURE_UNSUPPORTED，且不发送 cancel-status 请求，避免旧实现把查询当作写操作。升级接收端后可安全轮询。send 的接收确认和本地 progress 仍沿用原合同；poll 会在来源端保存已取得的回执，不声称来源数据库也只读。

## 尚需完成

自动投递/轮询、完整取消业务结案、登记关系退役、来源结果与证据验收、全局页面和物理双机演练未完成。未知或不受监管的旧进程保留待核验状态，不能通过补写停止标志绕过。恢复换代后原取消继续隔离；接收范围不会因重启、改名或旧记录删除而自动解锁。
