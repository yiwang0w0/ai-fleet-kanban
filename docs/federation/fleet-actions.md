# 全局面板跨端操作

本地操作员面板可以提交委派、接收/拒绝、取消请求、停止核对、候选回传与返工决定，并显示持久回执。请求保存、对端收到、执行停止和最终验收是不同事实。默认不启用写入口。

## 配置与权限

先按 peers.md、mcp.md 在同一节点数据库建立独立 coordinate 角色/凭据和对端授权。面板协调凭据不能绑定某次 run；只授予需要操作的项目。普通 operator 令牌仍是 HTTP 入口校验，后端再检查协调凭据、角色版本、项目和目标节点代次。worker/review 令牌、外站 Origin 均不能访问该入口。凭据、配置、数据库应放在已批准的私有运行目录，不放入共享 Markdown 目录或提交到仓库。

在本机私有目录创建 JSON 配置；以下 UUID、域名、路径都是示例，必须替换为实际登记值：

```json
{
  "format": "ai-fleet-actions/v1",
  "node_id": "11111111-1111-4111-8111-111111111111",
  "node_epoch": "22222222-2222-4222-8222-222222222222",
  "principal_file": "C:\\FleetRuntime\\private\\panel-coordinate.json",
  "peers": [{
    "node_id": "33333333-3333-4333-8333-333333333333",
    "node_epoch": "44444444-4444-4444-8444-444444444444",
    "projects": ["demo"],
    "url": "https://kanata-office.example-tailnet.ts.net",
    "credential_file": "C:\\FleetRuntime\\private\\office-peer.json"
  }]
}
```

将 BOARD_FLEET_ACTIONS_CONFIG 设为该文件的绝对路径，再使用已有的独立 BOARD_DB/BOARD_CONFIG 启动看板。没有设置该变量时，查询返回 enabled:false，写入返回 ACTIONS_NOT_CONFIGURED，不创建操作队列表。配置失效时不会绕过检查以其他身份启动操作。

只接受回环 HTTP 或 *.ts.net 的 HTTPS 根地址；握手仍核对固定 node_id/epoch。浏览器不能指定 URL、凭据路径、shell 或任意 MCP 工具。对端凭据需具有相应现有协议权限：

| 操作 | 对端 scopes |
|---|---|
| 委派发送/查询 | peer:handshake 与 delegation:offer / delegation:status |
| 取消发送/停止查询 | peer:handshake、delegation:offer、delegation:control |
| 候选回传/决定查询 | peer:handshake、delegation:result |

接收、拒绝、放行和停止核对先在本机保存。对方通过显式状态查询取得新回执。旧操作历史不会交给替换后的协调身份继续发送；恢复代次、权限变更后需要按现有恢复流程核对。

## 页面流程

从「全局视图」打开本机任务详情，选择已配置的目标终端，核对任务说明、验收条件和版本，再提交委派。对端在「待接收委派」核对原合同并接收或拒绝。接收只创建一张未放行任务，不启动执行器。来源点击「查询对端回执」后才能获知接收决定。

已经通过现有协议完成端点绑定、关系登记及双方就绪的任务，显示放行、请求取消或封存候选等适用操作。放行仍经过当前权限与版本检查；启动仍由现有调度器、角色与预算控制。取消收到后仍需真实停止证明，候选送达后仍需来源验证与验收。返工必须填写原因。

弹窗提交失败时保留同一请求编号与参数，可重试。版本或权限冲突不会自动换用新版本；关闭弹窗、刷新并重新核对。浏览器连点期间禁用提交。服务端还对同一协调身份、节点代次、任务版本、目标和合同的重复建委派去重，即使新标签产生了不同请求编号，也返回原委派。传输重试只发送原意向或原候选，不创建新的模型调用。

自动刷新保留操作分组的展开状态；当键盘焦点在操作区或确认弹窗内时暂缓周期刷新。刷新按钮仍可显式更新，页面保留读取时间。

## 请求与持久回执

GET /api/fleet/actions[?project=demo] 返回当前协调身份获准的本地协议记录与操作历史。POST /api/fleet/actions 接受严格四字段：

```json
{
  "action_id": "55555555-5555-4555-8555-555555555555",
  "project_id": "demo",
  "command": "poll_delegation",
  "arguments": {"id": "66666666-6666-4666-8666-666666666666"}
}
```

本地命令复用 MCP 参数与授权：create_delegation、decide_delegation、request_cancellation、progress_cancellation、prepare_result、reject_result、release_delegation；request_id 由后端使用 action_id 注入，浏览器不得提供。传输命令 resend/poll_delegation、resend/poll_cancellation、resend/poll_result 只接受固定对象 id。

| 回执 state | 含义 |
|---|---|
| pending | 本机事务已保存，等待发送 |
| applied | 本机决定已保存；不表示对端已经知道 |
| acknowledged | 已核验对端协议回执；具体业务状态另列 |
| retry_pending | 可重试的网络/存储故障，保留同一消息 |
| blocked | 权限、身份或协议等错误，停止自动发送并保留错误代码 |

底层本地变更、MCP 幂等回执与操作队列同事务提交；嵌套事务用 SAVEPOINT，失败不遗留半份意向，不回滚调用者其他工作。未提交事务不能启动网络发送。

每轮至多处理 16 项，使用数据库条件更新保留 30 秒尝试期限；同一进程的并发 tick 合并。每次网络请求前重新核验原协调授权，握手中撤销也不能继续发送变更。网络超时沿用既有客户端的有界超时，失败退避最长 30 秒。正常退出取消连接；重启后原消息可继续，不重启已消费的执行任务。

操作意向字段不可更新。总历史上限 10,000 条，达到后拒绝新请求；尚无自动清理命令。每类列表合计最多 100 条，截断有标记，可按项目缩小范围；目前没有历史翻页。响应只含选定业务字段和固定错误代码，不含对端 URL、本机凭据路径、令牌或供应商原始错误。

## 当前验证与未完成项

本机测试覆盖实际 HTTP 传输/服务端权限、不同点击编号的重复委派、丢失 ACK、离线退避、重启重发、停机取消网络、事务回滚、身份替换、途中撤销、取消停止证明及候选返工；模拟执行记录明确标为 fixture，没有真实模型调用。

实际浏览器在两个临时本机看板完成发起 → 接收 → 来源查询，目标只有一张未放行任务，两端 run 数均为 0；HTML 片段保持文字。验证了键盘入口、自动刷新修复及 390 像素视窗下的操作按钮布局。

已接入来源合并和双端结案（见下文）；尚需历史翻页、队列保留运维、真实 Tailscale 双机和桌面客户端验收。T08.03 记为部分实现，不以本机两个实例替代两台实体电脑，也不通过 G08。


## 面板绑定与就绪流程

节点部署时仍需显式创建项目关系图、登记双方稳定身份和代次，并将各本机项目绑定到同一个固定登记节点（见 [bindings.md](bindings.md) 和 [topology.md](topology.md)）。面板不能修改登记节点地址、成员、凭据或任务所有权。

1. 接收方接受委派，来源查询到接收回执后，两端在「项目结构登记」提交当前任务树。已登记项目新增任务后也可以重新提交当前结构；存在未确认操作时只能恢复或取消原操作。
2. 来源点击「刷新登记状态」，经认证握手读取固定登记节点的双方结构修订。页面显示观察时间；缓存只是准备材料，不能代替登记审批或执行许可。
3. 来源在「发出的委派」核对合同、目标任务和双方修订，点击「准备绑定并提交本方确认」。服务端从实际接收回执和登记观察生成关系，浏览器只提交该预览的摘要；任务版本或观察内容变化会拒绝旧预览。
4. 来源取得本方审批回执后点击「发送绑定提案」。接收端在「待确认绑定」独立核对本机任务、原关系和合同，可以拒绝，或「接受绑定并提交本方确认」。
5. 来源「查询双方确认」取得登记节点的最终回执后，再「发送来源就绪证明」。接收端取得匹配证明、满足当前权限与本地结构条件后，才启用「放行本机任务」。放行与真实启动分别记录。
6. 未确认的绑定可以撤回；若先前审批结果未知，必须恢复原审批请求。已确认关系不能用撤回代替执行取消，仍走停止证明协议。

本机同时担任登记节点时调用同一登记协议和真实本机身份，不需要伪造一个自连接凭据。远程登记节点仍须存在于固定 peers 配置，所需 scopes 为 peer:handshake 加 relations:read、relations:publish、relations:approve；来源向接收端发送绑定消息还需 delegation:offer、delegation:binding。

新增面板命令：

| command | arguments | 结果 |
|---|---|---|
| publish_topology | expected_revision | 准备当前结构并持久排队提交；不接受手写 edits |
| refresh_registration | id 为项目名 | 保存经过身份核对的登记观察 |
| propose_binding | delegation_id、review_digest | 从已核对预览准备来源绑定并排队审批 |
| accept_binding_proposal | relation_id、descriptor_digest、expected_version | 接受实际收到的同一提案并排队审批 |
| decline_binding_proposal | 现有 MCP 参数 | 本机拒绝，来源仍须撤回 |
| resend_topology / cancel_topology | id 为结构操作 ID | 恢复原提交或按现有协议取消 |
| approve_binding / poll_binding / withdraw_binding / cancel_binding | id 为关系 ID | 恢复审批、查询或撤回 |
| send_binding_proposal / send_source_ready | id 为关系 ID | 发送原提案或来源就绪证明 |

这些命令继续使用同一操作 ID、事务、授权快照及持久队列。登记观察只保留有限的身份、代次、版本和结构摘要字段；对端附加字段不写入缓存。登记节点拒绝过期结构时保留失败回执和未确认绑定，不自动更新用户核对的关系。

绑定专项验证见 [fleet-binding-actions-evidence.json](fleet-binding-actions-evidence.json)。文件交付与独立检查见下文；完整结构编辑器、历史翻页和队列保留运维，以及真实 Tailscale 两机验收仍待完成。

## 文件交付与来源独立检查

在已有操作配置中可选增加 delivery。省略时保留前述委派与绑定功能；增加后，服务启动及实际处理均须通过与 verification CLI 相同的治理源码检查。approval_file 只从可信本机配置读取，源码根固定为正在运行的看板仓库；浏览器不能选择源码、验收文件、测试程序或本机路径。

~~~json
{
  "approval_file": "C:/FleetRuntime/private/accepted_rev",
  "receivers": [{
    "project_id": "demo",
    "mapping_id": "77777777-7777-4777-8777-777777777777",
    "base_commit": "0123456789abcdef0123456789abcdef01234567",
    "allow_full_baseline_read": true
  }],
  "verification_profiles": ["88888888-8888-4888-8888-888888888888"]
}
~~~

这是 delivery 字段的内容，需要合并到既有配置。仓库映射、精确基线及验证 profile 应先通过本机 CLI 登记；每个映射至多配置一个本次接收基线。完整基线读取须在配置和面板确认中明确授权。验证 profile 固定测试程序、脚本摘要、环境、时限与独立副本位置，参见 [verification.md](verification.md)。profiles 只开放指定 UUID，仍须匹配当前项目、节点代次、接收仓库和有效授权。文件发送端的反向 peer 凭据还需 peer:handshake、delegation:result、artifact:write。

操作流程：

1. 执行端从候选点击「准备实际文件包」，捕获已封存工作区的真实 Git/文件内容；来源端选择已配置的仓库及基线，明确「授权接收文件」。
2. 执行端在「文件与独立检查」发送或续传原包。队列每次最多发送 64 个分块；断线、丢 ACK、重启继续同一传输，更多分块自动续做。
3. 来源端收齐后明确点击「核验接收内容」，对照本机批准基线检查实际文件、Git 对象和完整目录。内容核验不运行测试。
4. 来源端选择匹配仓库的固定 profile，准备独立输入副本，再单独点击「执行本机独立检查」。准备与启动是两个可核对的动作。
5. 已消费启动许可的检查只恢复已有观察；回执缺失时保持受阻，不重复执行。操作历史中可以明确「恢复原交付操作」，复用原意图、参数和权限版本。配置或任务已变化时，原请求仍拒绝。
6. 检查通过显示「检查通过 · 详见合并与验收回执」。继续使用下方的来源合并与双端结案流程。

新增严格参数：

| command | arguments |
|---|---|
| register_artifact_target | result_id、mapping_id；基线取固定本机配置 |
| prepare_artifact | result_id；传输编号由原 action_id 固定 |
| send_artifact / verify_artifact | id 为传输 UUID |
| prepare_verification | transfer_id、profile_id；验证编号由原 action_id 固定 |
| run_verification / reconcile_verification | id 为验证 UUID |
| resume_delivery | id 为当前协调身份的一条受阻交付操作 UUID |

耗时文件读取、独立副本准备和测试均在操作意向提交后执行，不在 HTTP 入站写事务内执行；队列先保存冻结的候选摘要、任务版本和配置摘要。实际文件回执落盘事务内再次检查原协调权限。测试启动和心跳继续验证权限与治理源码；撤销后停止进程并保存真实失败观察。不同点击编号的同内容文件包/验证准备返回原操作，避免另建编号掩盖中断。

本地文件/检查操作成功后的队列 state 为 applied；这仅说明本机该步骤已有记录。检查通过由 checks_passed 单列，不计入任务或阶段验收。目录显示受限元数据、固定程序/检查文件名及摘要，不输出本机绝对路径、凭据、原始测试正文。每类目标、传输和检查至多 100 项，截断会提示。

独立副本与 Windows Job 仍不是操作系统文件/网络沙箱；本机管理者应只登记可信的固定检查。真实双机、客户端安装、模型调用、OS 隔离和长期运行仍按原计划分别验收。

文件交付与检查的最终本机测试、浏览器证据及限制见 [fleet-delivery-actions-evidence.json](fleet-delivery-actions-evidence.json)。


## 来源合并、明确验收与双端结案

本机管理者先用 integration CLI 登记允许的来源仓库、独占引用和临时对象目录；然后在 delivery 配置增加 integration_policies，值为允许从面板使用的策略 UUID 数组。执行端也要显式配置该字段，可以是空数组。省略此字段时不启用新的合并/结案入口，原有文件交付与检查保持可用。浏览器不能登记策略、选择来源引用或填写本机路径。

~~~json
"integration_policies": ["99999999-9999-4999-8999-999999999999"]
~~~

1. 来源独立检查通过后，选择已批准的合并策略，点击「准备合并」。此步骤导入并固定 Git 内容，尚不更新来源引用。
2. 核对来源引用、原基线和交付提交后，点击「确认合并到来源引用」。只在引用仍等于冻结基线时更新一次；合并回执写入中断后，「核对已有合并结果」只检查原提交，不再次更新引用。
3. 合并成功后可复核当前来源提交，再填写说明并「确认候选验收」。所见来源任务版本、独立验证回执、来源合并提交和任务范围被绑定并冻结。含模拟执行的候选使用单独标明的「确认模拟候选验收」，说明中明确其不属于真实模型或阶段验收。
4. 来源发送原验收决定，取得执行端就绪回执。两端各自「提交本端结案确认」；任一端尚未确认时显示等待。来源可「查询双端结案」取得登记证明。
5. 收到双端登记证明后，各端「完成本端结案」。本端任务与关系按原协议一起关闭，父任务只重新进入审阅；单端回执不冒充另一端已经结案。

| command | arguments |
|---|---|
| prepare_integration | verification_id、policy_id |
| apply_integration / reconcile_integration / check_integration | id 为合并 UUID |
| prepare_completion | integration_id、expected_version、note、allow_fixture（严格 boolean） |
| send_completion | id 为完成 UUID |
| register_completion / poll_completion | id 为完成 UUID |
| settle_completion | id 为完成 UUID |

合并及验收准备均保存原 action_id 作为实体编号；重复相同意图不生成第二份。来源已更新但回执中断时保留一次性启动记录。发送与登记使用已有 completion 协议，反向凭据需 delegation:complete，登记节点凭据需 relations:read、relations:complete，二者都需 peer:handshake。登记节点可与本机来源共址。

新操作沿用原队列、版本/配置摘要、角色及项目权限。异步远端回执在本机事务中再次验证原协调授权；本机结案和合并恢复也在写入时重验。恢复原操作不替换操作者、验收说明或原候选。检查通过、来源已合并、验收意图已保存、双方登记完成及本端结案分别展示。
