# 独立节点网关与凭据协议

当前开发分支提供独立 peer 网关、本地凭据管理和协议握手，并已接入授权投影、快照、委派/关系/绑定、取消/结果、产物接收和双端结案。网关不随看板自动启动，只接受显式数据库与回环监听地址。它不提供本机 UI、任意文件下载或直接模型执行；实际阶段状态见 [PROGRESS](PROGRESS.md)。

## 两层入口

现有 core/server.mjs 继续作为本机操作员界面；本批没有修改或暴露该服务。cli/peer.mjs serve 使用独立端口，只接受对端凭据。每次 GET/POST 均认证，错误回复不包含数据库路径、令牌或堆栈。

远端部署时应由 Tailscale 的私网 HTTPS 入口代理这个独立回环端口，并限制设备访问范围。Serve 提供 tailnet 内共享服务；具体语法、设备访问规则和证书必须在真实端点配置时核对：[Tailscale Serve 文档](https://tailscale.com/docs/reference/tailscale-cli/serve)。本批未运行 tailscale serve、未改 tailnet 规则、未开放远端端口，仍需 G03 端点与访问矩阵验收。

## 身份与凭据

每个接收节点独立签发一份用于访问自己的随机凭据；format 2 在签发时固定 server_endpoint，客户端发送任何请求前核对地址，详见 [端点绑定与升级](peer-endpoints.md)。凭据还绑定 peer_node_id、peer_epoch、scopes、projects 和 credential_version。双向连接需要两份独立登记。凭据持有者只能使用其绑定身份，不能凭显示名、IP、转发头或请求体 owner 字段冒充其他节点。UUID 是标识，不是秘密。

凭据包含随机 key_id 和 32 字节随机秘密，数据库只存完整 token 的 SHA-256 摘要。请求使用 Authorization: Bearer <token>，不接受 URL 查询参数或 X-Board-Token。摘要比较使用 Node timingSafeEqual；完整认证流程不宣称无时序差异。[Node 24 crypto 文档](https://nodejs.org/docs/latest-v24.x/api/crypto.html)。

原文 token 只写入指定的新文件；Windows 原生 CreateNew 在创建时同时设置受保护 DACL，仅允许当前签发账户 FullControl，禁用父目录权限继承。随后在未共享的文件句柄上核验 ACL，再写入并刷新 token。使用系统自带 Windows PowerShell/.NET 的固定程序与静态脚本，路径和内容经 stdin 传递，不进入命令行或错误输出；不通过 PATH 查找程序，不使用 ExecutionPolicy Bypass。CLI 输出不含 token，碰撞不覆盖旧文件，创建/权限核验失败则回滚授权。

凭据输出要求本地盘符路径及支持 Windows ACL 的文件系统；拒绝 UNC、备用数据流及设备名。父目录须预先存在且由操作者控制。脚本被系统策略禁用、超时或中断时不能降级为普通文件写入；异常中断可能留下权限受限但未授权的文件，需本机核查，不自动覆盖。复制给对端时须重新核对接收端账户与 ACL，不能提交 Git、粘贴任务或放入模型上下文。已有凭据文件不被这次更新自动改写。

此 DACL 不隔离同一 Windows 账户内的 agent，也不限制管理员接管或已授权账户再复制凭据；数据库、目录和执行器隔离仍需 S04/S07 验收。原生接口依据见 [FileStream 安全描述符构造](https://learn.microsoft.com/en-us/dotnet/api/system.io.filestream.-ctor?view=netframework-4.8.1)。

本机维护者有数据库和凭据管理权。完整身份库与秘密被复制后，应用不能仅凭同一秘密区分两台物理机器；本批拒绝把本机 UUID 登记为对端，并阻止备份/恢复隔离副本启动，但不宣称已完成所有克隆检测或真实 Tailscale 设备绑定。

## 本地命令

所有命令必须显式指定已初始化看板数据库的绝对路径，没有部署目录默认值。数据库须已具有 node_id 和 sync_epoch。首次命令会事务化安装 federation_schema、federation_peers、federation_auth_events，不改任务队列。

~~~text
node cli/peer.mjs grant --db <board.db绝对路径> --peer <对端node_id> --epoch <对端sync_epoch> --scopes peer:handshake,peer:health --projects demo --endpoint <签发节点对外根地址> --credential-file <新凭据文件绝对路径>
node cli/peer.mjs list --db <board.db绝对路径>
node cli/peer.mjs serve --db <board.db绝对路径> --port 47825
node cli/peer.mjs revoke --db <board.db绝对路径> --peer <对端node_id> --version 1
~~~

替换凭据、改变作用域或重新授权已撤销节点：再次 grant，并携带 list 中的 --version 与新的凭据文件名。替换会递增版本，旧凭据立即失效；不能覆盖已有文件。revoke 同样要求当前版本，递增版本并清除秘密摘要。未登记节点不接受旧版本参数，既有节点不接受省略或过期版本。所有授权变更留下不含秘密的审计记录。

文件先排他写入并 fsync，再提交数据库事务；事务失败时回滚记录并删除本次新建文件。崩溃发生在提交前时，文件可能存在但未获授权；发生在提交后而文件不可恢复时，可用当前版本重新签发。这里不承诺跨文件系统和 SQLite 的统一原子提交。

不完整目录、带 board_restore_hold 的备份/恢复数据库、未知存储版本或不存在的数据库都拒绝网关启动。运行期间每次认证也检查恢复隔离标志。恢复激活及对端 epoch 接纳已分别实现，见 [recovery.md](recovery.md) / [source-recovery.md](source-recovery.md)；它们要求明确计划和停机证据，不能手工解除隔离后复用旧凭据。

## HTTP 合同

以下 23 个路径来自当前 gateway.mjs；表中归组使用斜线分隔 action，不代表通配路由。所有请求先认证，涉及项目的操作还要核对项目/合同范围。正文为原始 JSON 字节上限。

| 路径（/peer/v1/ 后缀） | 方法 | scope | 正文上限 |
|---|---|---|---|
| hello | POST | peer:handshake | 8 KiB |
| health | GET | peer:health | 无正文 |
| pull | POST | sync:pull | 8 KiB |
| ack | POST | sync:ack | 8 KiB |
| snapshot/start、snapshot/page | POST | sync:pull | 各 8 KiB |
| delegation/offer | POST | delegation:offer | 128 KiB |
| delegation/status | POST | delegation:status | 8 KiB |
| delegation/complete | POST | delegation:complete | 32 KiB |
| delegation/result、delegation/result-status | POST | delegation:result | 384 KiB / 8 KiB |
| artifact/offer、artifact/chunk | POST | artifact:write | 272 KiB / 96 KiB |
| artifact/seal、artifact/status | POST | artifact:write | 各 8 KiB |
| delegation/cancel、delegation/cancel-status | POST | delegation:control | 各 16 KiB |
| delegation/binding | POST | delegation:binding | 16 KiB |
| relations/publish | POST | relations:publish | 4 MiB + 4 KiB |
| relations/approve、relations/withdraw | POST | relations:approve | 各 8 KiB |
| relations/status | POST | relations:read | 8 KiB |
| relations/complete | POST | relations:complete | 32 KiB |

其他路径即使有有效凭据也返回 404。未知/缺失/已撤销的凭据在阈值内返回 401，重复失败返回 429 与 Retry-After（下文）；权限不足或身份/epoch 不匹配返回 403；版本竞争、恢复隔离返回 409；协议或必需能力不兼容返回 426；未知字段/格式错误返回 400；超限正文返回 413；不支持的正文类型/压缩返回 415；正文超时返回 408。未分类内部错误返回不含细节的 500。

握手示例（UUID 使用实际绑定值）：

~~~json
{
  "node_id": "11111111-1111-4111-8111-111111111111",
  "sync_epoch": "22222222-2222-4222-8222-222222222222",
  "protocol": {"min": 1, "max": 1},
  "required_capabilities": ["node-identity-v1", "peer-health-v1"],
  "required_extensions": [],
  "extensions": {}
}
~~~

JSON 语法合同见 peer-hello.schema.json；实际协商还验证 max >= min、版本交集、授权身份与 epoch、必需能力，以及 extensions 序列化后不超过 2 KiB。当前支持协议 1 和 12 项能力：node-identity-v1、peer-health-v1、task-projection-sync-v1、task-snapshot-v1、source-epoch-recovery-v1、delegation-intents-v1、project-relations-v1、delegation-bindings-v1、delegation-cancellation-v1、delegation-results-v1、artifact-transfer-v1、delegation-completion-v1。15 个 scope 是上表的不同 scope 值，完整闭域源为 core/federation/protocol.mjs；能力协商不授予 scope。不支持任何必需扩展。顶层及 protocol 对象的未知字段拒绝；可选扩展只能放 extensions 并被忽略，不得用它暗示权限或改变执行语义。

| 对端声明 | 当前结果 |
|---|---|
| min=1,max=1，必需能力已支持 | 协商为 1 |
| min=1,max=2，必需能力已支持 | 协商为 1 |
| min=2,max=2 | 426，无公共版本 |
| 未知 required_capabilities / required_extensions | 426 |
| 未知普通字段 / 缺失必要字段 | 400 |
| 有界的可选 extensions | 忽略扩展，基础能力保持原语义 |

board_node.protocol_version 是本地身份格式；握手的协议范围是独立通信合同，两者恰好当前都是 1，不能据此假定未来必须同步升级。

## 撤销与请求边界

每个请求重新查数据库，不按 TCP 连接缓存授权。握手在开始读正文前验证一次，正文读完后又在 BEGIN IMMEDIATE 事务内认证并检查范围；期间的撤销或轮换不能被慢速上传绕过。事务先被接纳的请求可能先于撤销返回；已经返回的数据无法追回。产物以独立有界 chunk 请求传输，每个 chunk 重新认证；没有可长期复用的已认证流。

正文按上表路由限制，包括没有 Content-Length 的分块正文；读取上限 5 秒。HTTP 头上限 8 KiB，连接空闲上限 10 秒，每连接最多 100 个请求。重复 Authorization、压缩正文、无效 UTF-8 和带 Origin 的浏览器请求均拒绝。超限与超时返回后关闭连接；不把客户端提供的转发头当作身份。[Node 24 HTTP 文档](https://nodejs.org/docs/latest-v24.x/api/http.html)。

## 首批验证记录（历史）

19 项测试使用临时数据库、真实本机 HTTP 连接和独立网关进程，覆盖登记原子性、凭据替换/撤销、版本冲突、同连接重鉴权、上传中撤销、权限拒绝、身份冒充、兼容矩阵、请求限额、恢复隔离和不泄露 UI/任务/秘密。没有调用模型，没有改动部署数据库或真实网络配置。

第六批已实现项目范围内的投影读取、主动拉取、ACK 与离线补发；第七批接入授权快照、断点续传和显式压缩，见 sync.md / snapshots.md。后续已实现委派、跨端关系及证据传输合同；全局用户 UI 和完整后台运行仍待完成。真实双机/三机访问矩阵、设备凭据分发及撤销传播仍需后续验收。S02/S03 全阶段尚未通过。

恢复来源额外声明 source-epoch-recovery-v1 能力；已激活恢复的来源在 hello.extensions.source_recovery 给出最小标记。接收端代次接纳及反向旧凭据撤销见 source-recovery.md。

委派意向新增 delegation:offer / delegation:status 项目权限与独立接口，旧同步凭据不自动获得写入能力。接受仍不放行执行，参见 [委派合同](delegation.md)。


## 鉴权失败汇总与退避

Tailscale Serve 代理后，应用看到的回环连接不代表远端设备可信。设备 ACL/私网 HTTPS 限制可达性，独立 bearer、epoch、scope 和项目合同限制操作。转发头、显示名、IP 不作为身份。只代理 peer 网关，不代理本机 UI 或 MCP broker。

鉴权失败的进程内窗口为 10 秒：同一声明 key ID 前 5 次和全局前 100 次失败可返回 401，超出任一阈值返回 429 / AUTH_RATE_LIMITED，附 Retry-After 秒数并关闭连接。格式错误/缺失 key 归为一个桶；最多跟踪 64 个标签，其余归到 overflow 桶。未知 UUID 即使看起来规范也仅是未认证声明。

合法凭据先认证，不因别人伪造相同公开 key ID 而被失败桶封锁；权限不足的已认证 403 不计入这组匿名计数。随机改 key 不能绕开全局失败阈值。每个失败请求仍进行一次有界凭据检查，这不是网络流量防护或已授权对端的完整配额；多进程与重启不共享内存窗口。

失败计数以 5 秒周期批量写入独立 federation_auth_failures 表，正常关闭也刷出待写计数。保留最多 512 条聚合记录，24 小时外记录在启动/后续刷出时清理，查询不显示过期记录。只有规范的声明 key ID、类别、次数、受限次数与首末时间（Unix 毫秒），不存 token、秘密片段、URL、正文或转发头；overflow 保留总数但不保留每个新标签。硬终止可能丢失尚未刷出的计数；审计写失败保留有界内存计数，后续无效请求返回 503 / AUTH_AUDIT_UNAVAILABLE，下一轮成功刷出后恢复。正常凭据不因此获得额外权限，也不会被误当作失败凭据。

本机操作员查询已持久化摘要（不会刷新另一个进程的内存计数）：

~~~text
node cli/peer.mjs auth-failures --db <数据库绝对路径> --limit 100
~~~

limit 为 1–512。这是本机管理命令，没有新增网络查询接口。鉴权失败表是独立 schema 1，未知版本拒绝启动。当前验证与限制见 review-auth-evidence.json；此保护不代替实际 tailnet ACL、Windows 文件 ACL 或实体双机验收。


## 已认证请求与写锁

每个 gateway 进程对同一 peer_node_id 最多接纳一个在途请求，从认证通过覆盖正文上传直到响应 finish/close。重叠请求返回 429 / PEER_BUSY、Retry-After: 1，并关闭连接；其他已授权节点仍独立接纳。凭据轮换不会绕开此限制。此限制不替代网络限流，不跨 gateway 进程共享。

hello、health、恢复链和委派/结果/取消/产物/关系的状态读取使用一致的 deferred 读事务，不预占 WAL 写锁。上传后仍重新验证凭据、节点代次和所需权限。pull 会物化事件及记录投递进度，ACK 和业务写入仍需要写事务。快照采用下述分段流程，末页仍须持久记录 offered_seq 后才成功响应。

定向锁竞争及正常同步证据见 [网关准入证据](peer-admission-evidence.json)。这是同机真实双 SQLite 连接和回环 HTTP 实验，不代表实体双机吞吐或 72 小时验收。
