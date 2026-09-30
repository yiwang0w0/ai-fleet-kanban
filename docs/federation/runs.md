# 执行实例与旧请求隔离

每次领取生成新的 `run_id`。同名 worker 再次领取同一张卡，必须使用新的领取回执；旧回执的结果、心跳、重试和派生任务请求都会被拒绝。四个任务状态及本地数字编号不变。

## 身份与历史

| 字段 | 含义 |
|---|---|
| task_uid / owner_node_id | 任务的全局标识与所有者，创建后不变 |
| executor_node_id | 本次执行所在节点；本批只有本机执行，跨节点派发尚未启用 |
| worker / role_id | 槽位名与角色标识，彼此独立 |
| runtime | 本次领取申报的运行时；不能证明实际调用了该运行时 |
| agent_instance_id | worker 进程启动时生成的小写 UUID v4；人工 CLI 可以没有 |
| run_id | 一次领取派发的 UUID；同一次派发中的重试不换 ID |
| first_attempt / last_attempt | 该次派发所覆盖的原有累计尝试编号 |
| policy_json / policy_sha256 | 领取时的角色、工具配置、章程哈希和任务限制快照 |

`task_runs` 保存历史，元数据和策略快照不可更新、不可删除；一个任务最多有一条 running 记录。任务离开执行状态、换 worker、归档或被回收时结束当前记录。新领取重新生成快照。任务中的 `run_id` 保留最近一次执行指针。

服务端根据自己的线路配置生成快照，不接受请求体指定策略。章程摘要在配置加载时计算；磁盘文件变化要重新加载配置后才进入新领取的快照，已有 run 保留原快照。配置读取失败不会替换已经加载的角色及摘要，领取事务不读取章程文件。快照明确记录 `enforcement: "unattested"`，不能据此宣称 OS、MCP 或模型工具权限已经验证。运行时与进程 UUID 目前也是声明；后续的节点认证、执行器探测和权限隔离需要另行验收。

## 协议版本 2

`GET /api/meta` 返回 `worker_protocol_version: 2`。持 worker 令牌调用 `POST /api/claim` 必须发送：

~~~json
{
  "worker": "alpha-1",
  "line": "alpha",
  "worker_protocol_version": 2,
  "agent_instance_id": "11111111-1111-4111-8111-111111111111"
}
~~~

进程 UUID 应由客户端在启动时随机生成，示例值不能用于真实进程。旧版 worker 请求在领取前返回 400，避免先消耗一次模型调用才发现无法回传。

领取响应的 `task.run_id` 必须由该次任务处理一直保留。以下接口都必须携带它，operator 令牌也不例外：

- `POST /api/tasks/:id/heartbeat`：worker、run_id、可选 lease_minutes。
- `POST /api/tasks/:id/attempt`：worker、run_id。
- `POST /api/tasks/:id/report`：worker、run_id、outcome、evidence。
- worker 创建子任务：`POST /api/tasks`，带 parentId（或 parent_id）、parent_run_id、worker。两个父编号同时传入且不同会返回 400。

缺失或格式错误返回 400；执行已结束、已换人或 ID 不是当前 run 返回 409；任务不存在返回 404。结果提交被拒绝时不写结果、状态和事件。心跳和重试的 SQL UPDATE 自身也带 run 条件，防止检查之后被另一进程重新领取。派生任务的父执行校验与插入放在同一个写事务内。

人工 CLI：

~~~text
python cli/board.py take 12 --as alpha --version <aggregate_version>
python cli/board.py done 12 --as alpha --run <领取输出中的 run_id> --file evidence.md
python cli/board.py wait 12 --as alpha --run <领取输出中的 run_id> --file reason.md
~~~

`GET /api/tasks/:id/runs` 可读取执行历史。不能为了让旧请求成功而重新 GET 卡片，再把最新 ID 填进旧结果。

## 升级与恢复

这是 worker 写入协议的有意破坏性变更。部署时先停止旧 worker 与其他数据库写入者、确认正在执行任务的处置并备份，然后同步升级服务端、worker 和人工 CLI。混合版本写同一数据库不受支持。本分支尚未部署，发布版本号与发布说明将在发布阶段统一处理。

迁移为没有 run_id 的历史在途任务创建 imported 记录，agent_instance_id 留空，不伪造已观测进程。重新迁移不重复创建。旧进程不知道 imported ID，不能继续交付；停旧进程后由 operator 按原有流程释放并重新领取。已有执行指针损坏或不匹配时拒绝启动，不自动认领为本机的新执行。

回滚需停新版进程、保存升级后的数据库，再按备份说明恢复迁移前数据库和匹配代码；不要把旧服务直接指向升级后的库。升级后产生的新记录必须先处理保留，不能用回滚静默丢弃。

## 验证范围与限制

`npm run test:runs` 使用隔离数据库和临时 HTTP 服务，包含同名重新领取、跨任务 ID、三种写入在读取后发生竞争、子任务入口、重试记账、策略不变、迁移与旧协议拒绝。完整主套件还运行模拟 worker，模型调用数为零。

run_id 是并发隔离标识，不是秘密凭据，不能防止有权读取当前 ID 的恶意客户端。现有 worker 令牌仍是共享执行权限；按 agent 绑定权限属于 S03/S04。旧请求被拒绝不代表旧模型进程已被终止，也不阻止它在共享目录写文件；进程回收、工作区隔离、证据绑定和迟到成果留存属于后续批次。尚未启用联邦同步、跨机租约或离线继续工作协议。
