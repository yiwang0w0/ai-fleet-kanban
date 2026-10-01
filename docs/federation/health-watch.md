# 联邦健康哨

watchers/board_health_watch.py 通过已认证的 GET /api/fleet/health 增加本机联邦检查。接口只接受操作员身份和既有允许来源。它读取数据库、数据库旁的规范化调度/节点常驻锁及锁记录 PID 的可见性，不写状态、不访问对端、不启动模型、不删除锁。

按既有 BOARD_URL、BOARD_DATA_DIR 配置运行：

    python watchers/board_health_watch.py
    python watchers/board_health_watch.py --once

--once 一轮后退出：1 表示存在需处理问题，0 表示本轮没有问题（仍可能有提示）。持续模式沿用默认 600 秒间隔。本批未在真实终端部署此哨。

| 观测 | 触发条件 | 含义 |
|---|---|---|
| broker | prepared 创建超过 5 分钟，或 interrupted 未结清 | 前者为提示，后者为问题；用 dispatch stale 核对。已校验的人工恢复回执不重复报未处理 |
| 持久投递 | fleet_operator_actions 的 blocked；或创建超过 30 分钟仍为 retry_pending | blocked 为问题，retry_pending 为提示；对端可能正常离线，保留原操作等待重连 |
| scheduler | attention、超过 60 秒的心跳、遗留锁或锁/实例不一致 | 核对实例与停止证据；PID 不可见只表示当前未观察到，PID 存在也不能证明进程身份或执行器停止 |

投递年龄从原操作创建计算，不是连续失败时间。未持久化的单次客户端 delivery_state 不由健康哨虚构；协议待处理状态另用 [只读巡检](inspection.md)。单独的 launch_committed 不被当成故障，离线期间继续执行不会因此被重派。

锁文件与数据库注册存在先后，新的不匹配锁留出 60 秒观察窗口。不可读锁、进程不可见或已记录 attention 仍明确显示。数据库与文件系统不是同一事务，不一致需要核对；本工具始终不提供执行器停止确认。异常锁可使用 [明确恢复入口](runtime-lock-recovery.md)，仍需先核对停止证明。

## 去重与错误

新问题和提示复用 AlarmThrottle：同一指纹按第 1、2、4、8…轮退避，身份集合或类别变化立即报告，消失后报告解除。指纹不含读取时间、等待时长或重试次数。

接口失败、未知响应版本、缺失模块覆盖或未知问题码形成“联邦体检不可读”，不会误报恢复。服务端只返回固定错误说明；Python 只使用本地允许列表中的文案，不输出服务器原始文本、私有路径或凭据。

未配置模块显示 not_configured，不迁移或启用。旧代次提示恢复核对；未来或不可解析时间显示 CLOCK_UNKNOWN，不判超时。每次最多扫描 10000 条候选，超过明确失败；每类最多附三个示例 UUID，不输出原始合同、传输 URL 或回执正文。

[验证证据](health-conflicts-evidence.json)包含真实临时 HTTP 看板到 Python 哨的链路、丢 ACK/授权撤销、已确认退出的调度子进程与保留锁，以及只读字节校验。未据本机夹具声称实体双机或 72 小时观察验收。


## 节点常驻覆盖（健康响应 v2）

健康响应升级为 ai-fleet-health/v2，modules 固定包含 broker、delivery、scheduler、node_runtime。服务和 Python 健康哨应一同升级；旧格式或缺失 node_runtime 覆盖被当作“体检不可读”，不能清除节点告警。不改变数据库 schema，也不启动组件。

节点常驻使用自己的实例表、控制表和 `.fleet-node-runtime.lock`。attention、超过 60 秒的心跳、缺失/不可读/不匹配/进程不可见的锁，按节点实例单独报告。新的锁不匹配同样留 60 秒启动窗口。正常结束的实例不因旧组件状态反复报警；有 attention 的结束实例仍需核对。PID 存在不证明身份，PID 不可见不证明所有执行器停止。

同步 error/backoff 为提示，pending 为待处理批次提示；无远端查询，不据此判定对端已死或自动重派。当本机心跳仍新鲜而同步观察超过 60 秒未更新时，报告 NODE_SYNC_OBSERVATION_STALE。未来/不可解析时间只报 CLOCK_UNKNOWN，不把未知时间当作新鲜心跳。处于 run/running 的节点出现 stopped 同步组件时报告问题；未结实例心跳陈旧且没有组件记录时报告缺失。

新增信号使用既有去重和解除机制。同一代码按实例计数，多个同步项目会合并到该实例；输出不含项目名、原始 error_code、凭据或 summary 正文。查看具体来源时使用 node-runtime status 的本机管理入口。锁文件和数据库不在同一事务，观察存在时间差。

[节点巡检证据](node-health-evidence.json) 覆盖新增反例、真实临时常驻进程、认证 HTTP 到 Python 健康哨，以及时钟偏移、只读和解除去重。磁盘/预算/供应商认证有效期的完整监控与实机部署演练仍须补齐；本次不宣称 T11.02 或任何正式阶段通过。
