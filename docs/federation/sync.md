# 任务投影同步与离线补发

这批实现的是授权任务的状态副本：每个节点只写自己拥有的任务，其他节点保存只读投影。支持按项目拉取、持久游标、重试退避和 ACK 丢失重放。同步进程独立于本机任务执行，离线不会触发远端重派。

状态投影会合并两次拉取之间的多次本地修改；它不是完整操作历史或审计事件复制。完整历史、委派、证据文件、跨端关系及全局 UI 属于后续实现。本功能在隔离分支与临时数据库中验证，尚未部署到真实终端。

## 身份、项目与字段

所有者使用持久 node_id。界面名称来自认证握手的 display_name，改名不改所有权。同名机器不会以名字合并。每个事件包含 origin_node_id、origin_epoch、project_id、seq 和全局 task_uid；序列域是“节点 + epoch + 项目”，按项目分流避免过滤其他项目后产生序号缺口。

现有任务默认不共享。维护者必须明确指定 task、project 和当前任务 version；共享命令在事务内检查版本。子任务也需要单独加入项目，不能因父任务共享而自动泄露。已登记任务不能静默换项目；跨项目迁移尚未提供。

投影允许 subject、description、acceptance、status、waiting_for、kind、parent_uid、line、run_id、attempts、max_attempts、released、result、verdict_note、归档与时间字段，以及 task_uid、owner_node_id、任务版本。父节点也已在同一项目共享时才返回 parent_uid。依赖边尚未复制。

evidence_path、verify_cmd、执行策略、文件内容和操作员令牌不在投影字段中。自由文本仍可能包含维护者写入的路径或敏感内容；共享范围必须以实际任务文本为准，不宣称自动脱敏。

撤回共享会发布 task.withdrawn 并隐藏当前副本，后续本机修改停止发布。已经发送或保留在 outbox 的历史不能追回；同项目新获准节点仍能重放历史。撤回不是数据擦除，保留期与清理协议尚未实现。

## 原子性与恢复顺序

1. 共享任务的业务版本改变时，SQL 触发器在同一业务事务内递增发布修订并写入持久 dirty 标记。业务失败一起回滚；进程退出不会丢掉已提交标记。
2. 拉取端点在写事务中读取最终已提交状态，生成不可变 outbox 事件并清除标记。连续修改可以合并成一次最新投影；不会发布 claim 中间状态。
3. 接收方先校验协议、已认证来源、epoch、项目、连续序号、任务归属、版本和摘要。inbox、replica、cursor 在一个事务中落盘。
4. 接收事务成功后才发送 ACK。ACK 绑定已向该对端提供的序号与事件摘要。响应丢失后按持久游标重新请求；空批次也可补 ACK。
5. 相同事件和内容不重复应用；同 ID 异内容、缺口、乱序、归属伪造、版本回退或流末尾回退均拒绝。隔离记录只存来源、项目、错误码和批次摘要，不存正文。时间戳只作展示，不决定新旧。
6. 网关或隧道断开时，任务领取、执行和本机结果仍按本地规则持续；副本保持最后观察值。重连后继续补发。远端 replica 存于独立表，无法被本机 store.claim 领取。

同步表由首次网关或 sync 命令事务化安装，不复制到 tasks 队列。新节点目前可从保留事件的 seq=0 回放；恢复 epoch 不匹配直接停止，拒绝默默清空游标。快照分页、保留期裁剪和恢复激活另行实现。

事件 aggregate_version 是发布修订，包括共享/撤回和父关系可见性的变化；payload.task.aggregate_version 是所有者本地的任务命令版本。两者不能互换，也不要求每次递增 1。

## HTTP 合同与限制

调用前需 hello 协商 task-projection-sync-v1。固定格式见 sync-batch.schema.json；除此以外，运行时还检查摘要、归属、版本、连续序列和授权等语义约束。

| 路径 | 请求 | 范围 | 响应 |
|---|---|---|---|
| POST /peer/v1/pull | project_id、after_seq、可选 limit | sync:pull + 指定项目 | protocol_version、来源、项目、游标、head_seq、pending_count、checkpoint、events |
| POST /peer/v1/ack | project_id、seq、event_digest | sync:ack + 指定项目 | acked_seq |

网关只监听回环地址，每次请求重新认证，读取正文后在事务内再次验证权限。握手/健康检查与凭据轮换见 peers.md。这里不接收远端发来的任务命令或事件上传。

单事件最多 256 KiB，单响应最多 1 MiB，每批最多 25 条。超大任务保留待发送标记并返回 413，维护者需要缩减共享文本后重试。单轮客户端默认最多 10 批，内部参数允许 1–20 批；到上限仍有积压时返回 pending/has_more=true。一次请求最长 10 秒，失败间隔依次约 1、2、4、8、16、30 秒，后续最多 30 秒；重启继续使用持久退避记录。时钟倒退超过退避上限时重新尝试。

客户端只接受操作员显式指定的根地址：本机回环 HTTP，或 .ts.net 域名 HTTPS。禁止重定向、账号参数、路径和查询参数；不会使用任务文本或远端响应中的 URL。主机名限制不等于已验证物理设备，真实 Tailscale 规则、证书、端点和凭据分发仍需 G03 验收。

摘要使用 SHA-256：对象键排序后以紧凑 UTF-8 JSON 序列化，数组顺序保留。payload_digest 对 payload 计算；event_digest 对去掉 event_digest 的整个事件计算。摘要用于一致性验证，不是数字签名；来源可信度依赖固定端点、TLS 与凭据绑定。

## 本地操作与状态

使用已验证的 Node 24；运行时必须具有 SQLite DatabaseSync.isTransaction，缺少时在安装同步表前明确拒绝。仓库基础命令的旧引擎声明不代表新联邦功能已在所有旧 Node 版本上通过。

在 A 登记读取者 B，凭据只写新文件，再经可信方式交付 B：

~~~text
node cli/peer.mjs grant --db <A数据库绝对路径> --peer <B的node_id> --epoch <B的sync_epoch> --scopes peer:handshake,sync:pull,sync:ack --projects demo --credential-file <新凭据文件绝对路径>
node cli/sync.mjs share --db <A数据库绝对路径> --task 12 --project demo --version 7
node cli/peer.mjs serve --db <A数据库绝对路径> --port 47825
~~~

在 B 主动拉取 A。远端使用经验证的 Tailscale HTTPS 入口，下面回环地址仅适合本机联调：

~~~text
node cli/sync.mjs pull --db <B数据库绝对路径> --url http://127.0.0.1:47825 --credential-file <收到的凭据绝对路径> --project demo
node cli/sync.mjs watch --db <B数据库绝对路径> --url http://127.0.0.1:47825 --credential-file <收到的凭据绝对路径> --project demo
node cli/sync.mjs replicas --db <B数据库绝对路径> --project demo
node cli/sync.mjs status --db <B数据库绝对路径>
~~~

双向共享需 B 为 A 独立签发另一份凭据并配置反向 watch；不能共用同一份凭据。watch 每轮最多拉取默认批次，随后约 1 秒再检查；错误按退避等待。Ctrl+C 停止当前请求和循环。watch 不启动执行器。状态输出不含凭据秘密。

pull 的 synced 表示该次响应所观察到的流已追平；pending 表示还有数据，两者退出码为 0。error/backoff 的一次 pull 退出码为 1。watch 的鉴权/网络错误会按记录继续重试，修正配置后恢复。has_more 是最近成功拉取的积压状态，last_success_at 是最近成功交换时间，不能据此断言节点此刻在线。

replicas 返回 read_only、owner_name、source_epoch、source_seq、received_at、last_sync_at。status 返回待物化任务数、发送/确认游标、已接收游标、已认证来源、拉取尝试和隔离计数；离线来源仍显示最后状态。全局页面的离线标记与操作入口尚未接入。

撤回示例：

~~~text
node cli/sync.mjs withdraw --db <A数据库绝对路径> --task 12 --project demo --version 9
~~~

## 验证与后续

26 项同步测试覆盖事务/进程中断、分页、丢 ACK、重复、乱序、时间回退、项目隔离、所有者/epoch 伪造、撤回/重新共享、实际 HTTP 与 CLI、持续观察、断线结果补发、终端改名、积压状态和双向投影哈希一致。所有服务与凭据均是临时本机测试资源，没有模型调用。详见 sync-evidence.json。

S05 仍在实施：快照、保留期、恢复 epoch、完整审计/关系事件、性能与真实多机故障验收未完成。CLI 投影不代替最终全局看板，当前测试也不代替 G05/G09/G10/G11。
