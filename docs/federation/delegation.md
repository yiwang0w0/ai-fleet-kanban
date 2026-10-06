# 跨终端委派意向与接收决定

对应 AFK-FED-001 T06.01，以及 T04.01 的协调工具扩展。本批提供双端持久记录、显式接受/拒绝、幂等投递和接收任务保护。关系登记与双方端点绑定现已接入，见 relations.md 和 bindings.md；执行取消及结果验收仍待实现，接受本身不表示获准执行。

## 状态与所有权

来源协调者为本机已登记项目任务提出委派，固定 delegation_id、来源 task_uid/版本、双方 node_id/epoch、项目和公开工作合同。合同只含 subject、description、acceptance、work_kind 与 capabilities；不复制执行命令、私有证据路径、密钥、worker 或 run。来源任务之后变化不改写已发出的合同；关系确认时仍需核对当前来源版本，不能直接把旧合同当作新的执行授权。

来源状态为 pending → received → accepted_unconfirmed 或 rejected。接收端收到意向后只落盘，不创建任务。接收方本地协调者接受时，任务创建、项目登记、决定及审计一起提交；生成的是接收节点拥有的新 task_uid，保留与来源的关联。拒绝不创建任务。来源的远端投影不进入本地领取队列。

接收任务使用 hierarchical、route=mcp，初始 released=false。数据库保护同时拒绝未经确认的放行、进入 in_progress、直接完成与删除；原生领取不会产生 run 或消耗任务尝试数。只有 bindings.md 定义的双方实际端点、独立图回执及来源就绪证明同时成立，才可显式放行。原接受回执的 dispatch_ready 仍始终为 false；本地查询增加独立 binding 投影，表示当前条件。

## 身份与重试

- delegation_id 是来源生成的 UUID，也是双端唯一委派标识。同 ID/相同合同重发返回当前接收状态；不同合同拒绝。接受/拒绝另带 decision_id 和所见接收版本，重复同一决定返回原回执，相反决定或过期版本不能覆盖。
- 接收回执绑定合同摘要、双方身份及 epoch、项目、决定版本和目标 task_uid。来源只接受合法的单调版本；旧 received 回执不能覆盖 accepted_unconfirmed；相同版本不同内容拒绝。
- 接收决定再次检查来源现有委派授权。撤销、移除项目或退役来源 epoch 后不能继续接受。备份恢复使用原有隔离/激活流程；旧委派可查看，但 identity_current=false，不能继续投递或作出决定。
- 每次 send/poll 最多进行一次握手和一次操作，没有后台队列或自动循环。ACK 丢失后使用原 delegation_id 重发；它不会另建任务。网络或存储故障返回 retry_pending，授权/合同拒绝返回 blocked，来源状态均不虚报成功。
- 来源与接收端分别限制每项目最多 1000 个未拒绝意向。达到上限仍可查询、重试已有意向和作出决定。历史记录不自动删除；后续生命周期与保留策略另行实现。

## Peer 接口

新增独立权限 delegation:offer 和 delegation:status，仍需显式项目范围；旧 sync:pull/sync:ack 凭据不获得写入能力。双方先协商 delegation-intents-v1 能力。接收入口继续仅监听回环，远端部署需已授权的 Tailscale HTTPS 入口；URL 由本机配置，不能取自任务正文或远端响应。

| 路径 | 请求 | 所需权限 | 结果 |
|---|---|---|---|
| POST /peer/v1/delegation/offer | {offer: 合同} | delegation:offer | received 或已有决定 |
| POST /peer/v1/delegation/status | {delegation_id, project_id} | delegation:status | 仅该来源自己的接收回执 |

上传前鉴权，上传结束后在事务内再次鉴权。接口不接受浏览器 Origin、重复认证头、压缩或非法 UTF-8；委派 offer 正文最多 128 KiB，状态与其他 peer 接口仍最多 8 KiB。说明与验收字段各最多 16384 字符，合同规范 JSON 最多 120 KiB，超限拒绝而不截断。JSON 合同见 delegation-offer.schema.json 和 delegation-receipt.schema.json；双方身份相等、摘要及字节数等关联检查由服务实现。

## MCP 与本地命令

coordinate 可调用 create_delegation 与 decide_delegation；coordinate/observe 可按项目读取 get_delegation。implement/review 执行身份不能接受委派。协调工具沿用角色配额、持久 request_id、事务回滚与审计。MCP 只生成或决定记录，不读取对端凭据、不连接任意 URL、不提供执行启动。

本地命令均要求已初始化、当前格式数据库的绝对路径，不使用当前部署的默认数据库：

~~~powershell
node cli/delegation.mjs propose --db <来源DB> --id <委派UUID> --task <本机task_uid> --version <任务版本> --target <目标node_id> --target-epoch <目标epoch>
node cli/delegation.mjs send --db <来源DB> --id <委派UUID> --url <显式节点根地址> --credential-file <本机凭据文件>
node cli/delegation.mjs get --db <接收DB> --direction incoming --id <委派UUID>
node cli/delegation.mjs decide --db <接收DB> --id <委派UUID> --decision-id <决定UUID> --version 1 --decision accept
node cli/delegation.mjs poll --db <来源DB> --id <委派UUID> --url <显式节点根地址> --credential-file <本机凭据文件>
node cli/delegation.mjs list --db <任一DB> --direction incoming --project <项目ID>
~~~

决定说明可用 --note-file 指定 UTF-8 文件（最多 512 字符）。send/poll 返回 retry_pending 或 blocked 时退出码为 2；其他错误为 1。list 默认最多 100 条，可显式提高到 1000。输出含供审查的合同与回执，不含凭据。

## 验证范围

npm run test:delegation 使用独立临时数据库、实际回环 HTTP、独立 CLI 和两个竞争进程。覆盖十次重复投递、丢失 ACK、断线重试、双方重开数据库、接受/拒绝竞争、事务故障注入、项目/身份/epoch 越权、字节及队列边界、实际备份恢复和未确认执行保护。

这不是物理多电脑验收，也没有启动任何模型。任务执行、全局依赖防环、取消 ACK、证据传输和跨端最终验收仍未完成。全局图必须同时处理本地父子/blocked_by 与跨端关系，不能只对跨端边做 DFS；关系登记不可用时新确认继续等待，已领取任务按原有离线规则运行。完整阶段验收仍为 0/12。
