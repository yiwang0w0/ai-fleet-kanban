# 独立节点网关与凭据协议

本批实现可单独启动的 peer 网关、本地凭据登记/替换/撤销，以及协议握手。网关默认不随看板启动，只接受显式数据库和回环监听地址。它不提供 UI、任务读取、任务写入、文件下载或模型调用；同步与委派接口将在后续批次接入。

## 两层入口

现有 core/server.mjs 继续作为本机操作员界面；本批没有修改或暴露该服务。cli/peer.mjs serve 使用独立端口，只接受对端凭据。每次 GET/POST 均认证，错误回复不包含数据库路径、令牌或堆栈。

远端部署时应由 Tailscale 的私网 HTTPS 入口代理这个独立回环端口，并限制设备访问范围。Serve 提供 tailnet 内共享服务；具体语法、设备访问规则和证书必须在真实端点配置时核对：[Tailscale Serve 文档](https://tailscale.com/docs/reference/tailscale-cli/serve)。本批未运行 tailscale serve、未改 tailnet 规则、未开放远端端口，仍需 G03 端点与访问矩阵验收。

## 身份与凭据

每个接收节点独立签发一份用于访问自己的随机凭据，绑定 peer_node_id、peer_epoch、scopes、projects 和 credential_version。双向连接需要两份独立登记。凭据持有者只能使用其绑定身份，不能凭显示名、IP、转发头或请求体 owner 字段冒充其他节点。UUID 是标识，不是秘密。

凭据包含随机 key_id 和 32 字节随机秘密，数据库只存完整 token 的 SHA-256 摘要。请求使用 Authorization: Bearer <token>，不接受 URL 查询参数或 X-Board-Token。摘要比较使用 Node timingSafeEqual；完整认证流程不宣称无时序差异。[Node 24 crypto 文档](https://nodejs.org/docs/latest-v24.x/api/crypto.html)。

原文 token 只写入指定的新文件，使用排他创建和 POSIX 0600 文件模式；CLI 输出不含 token。凭据文件需要通过可信渠道交给对应终端，不能提交到 Git、粘贴到任务或放入模型上下文。Windows 文件隔离仍取决于目录 ACL，0600 不是已经完成 Windows 多用户隔离的证明。

本机维护者有数据库和凭据管理权。完整身份库与秘密被复制后，应用不能仅凭同一秘密区分两台物理机器；本批拒绝把本机 UUID 登记为对端，并阻止备份/恢复隔离副本启动，但不宣称已完成所有克隆检测或真实 Tailscale 设备绑定。

## 本地命令

所有命令必须显式指定已初始化看板数据库的绝对路径，没有部署目录默认值。数据库须已具有 node_id 和 sync_epoch。首次命令会事务化安装 federation_schema、federation_peers、federation_auth_events，不改任务队列。

~~~text
node cli/peer.mjs grant --db <board.db绝对路径> --peer <对端node_id> --epoch <对端sync_epoch> --scopes peer:handshake,peer:health --projects demo --credential-file <新凭据文件绝对路径>
node cli/peer.mjs list --db <board.db绝对路径>
node cli/peer.mjs serve --db <board.db绝对路径> --port 47825
node cli/peer.mjs revoke --db <board.db绝对路径> --peer <对端node_id> --version 1
~~~

替换凭据、改变作用域或重新授权已撤销节点：再次 grant，并携带 list 中的 --version 与新的凭据文件名。替换会递增版本，旧凭据立即失效；不能覆盖已有文件。revoke 同样要求当前版本，递增版本并清除秘密摘要。未登记节点不接受旧版本参数，既有节点不接受省略或过期版本。所有授权变更留下不含秘密的审计记录。

文件先排他写入并 fsync，再提交数据库事务；事务失败时回滚记录并删除本次新建文件。崩溃发生在提交前时，文件可能存在但未获授权；发生在提交后而文件不可恢复时，可用当前版本重新签发。这里不承诺跨文件系统和 SQLite 的统一原子提交。

不完整目录、带 board_restore_hold 的备份/恢复数据库、未知存储版本或不存在的数据库都拒绝网关启动。运行期间每次认证也检查恢复隔离标志。恢复激活时的 epoch、凭据轮换和同步游标重建仍未实现，不能解除隔离后直接复用旧凭据。

## HTTP 合同

| 路径 | 方法 | 所需作用域 | 返回 |
|---|---|---|---|
| /peer/v1/hello | POST | peer:handshake | 协商版本、本机公开身份、调用者获准范围 |
| /peer/v1/health | GET | peer:health | ok、协议版本与本机 node_id |

其他路径即使有有效凭据也返回 404。未知/缺失/已撤销的凭据返回 401；权限不足或身份/epoch 不匹配返回 403；版本竞争、恢复隔离返回 409；协议或必需能力不兼容返回 426；未知字段/格式错误返回 400；超限正文返回 413；不支持的正文类型/压缩返回 415；正文超时返回 408。未分类内部错误返回不含细节的 500。

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

JSON 语法合同见 peer-hello.schema.json；实际协商还验证 max >= min、版本交集、授权身份与 epoch、必需能力，以及 extensions 序列化后不超过 2 KiB。当前只支持协议 1、上述两项能力，不支持任何必需扩展。顶层及 protocol 对象的未知字段拒绝；可选扩展只能放 extensions 并被忽略，不得用它暗示权限或改变执行语义。

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

每个请求重新查数据库，不按 TCP 连接缓存授权。握手在开始读正文前验证一次，正文读完后又在 BEGIN IMMEDIATE 事务内认证并检查范围；期间的撤销或轮换不能被慢速上传绕过。事务先被接纳的请求可能先于撤销返回；已经返回的数据无法追回。当前没有流式任务或文件接口，不存在可长期保持的已认证数据流。

正文最多 8 KiB，包括没有 Content-Length 的分块正文；读取上限 5 秒。HTTP 头上限 8 KiB，连接空闲上限 10 秒，每连接最多 100 个请求。重复 Authorization、压缩正文、无效 UTF-8 和带 Origin 的浏览器请求均拒绝。超限与超时返回后关闭连接；不把客户端提供的转发头当作身份。[Node 24 HTTP 文档](https://nodejs.org/docs/latest-v24.x/api/http.html)。

## 已验证与尚未完成

19 项测试使用临时数据库、真实本机 HTTP 连接和独立网关进程，覆盖登记原子性、凭据替换/撤销、版本冲突、同连接重鉴权、上传中撤销、权限拒绝、身份冒充、兼容矩阵、请求限额、恢复隔离和不泄露 UI/任务/秘密。没有调用模型，没有改动部署数据库或真实网络配置。

projects 当前只是获准项目范围的持久记录，尚无任务数据端点来完成项目数据隔离验收。未实现节点主动连接、事件复制、ACK、离线重放、委派、跨端关系、证据传输或远端用户 UI。真实双机/三机访问矩阵、设备凭据分发及撤销传播仍需后续验收。S02/S03 全阶段尚未通过。
