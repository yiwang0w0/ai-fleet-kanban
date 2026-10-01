# 0.24 Windows 升级与机器合同迁移

适用版本：`0.24.0`，目标发布线为 0.24。当前为未发布、未部署的开发分支；本文是升级操作合同，不能作为上线批准或真实双机验收回执。后续支持环境只有 Windows。源码起点为 0.23.1，旧版本的单机任务状态和本地数字编号保留。

## 升级前必须看见的变化

| 入口 | 新要求 | 旧请求的结果 |
|---|---|---|
| worker 令牌的 `POST /api/claim` | `worker_protocol_version: 2`，本次进程生成的小写 UUID v4 `agent_instance_id` | 缺失或格式不符在领取前返回 400 |
| heartbeat / attempt / report | 保留该次领取返回的原始 `task.run_id`，连同原 worker 提交 | 缺失或格式错误 400；已结束/被替换的 run 为 409 |
| worker 创建派生任务 | 父任务编号、原始 `parent_run_id`、worker | 父执行失效则拒绝创建 |
| 指定领取、编辑、裁定等八类任务控制请求 | 原先阅读到的 `expected_version` 正安全整数 | 缺失/格式错误 400；版本已变化 409 |
| 人工 CLI 控制命令 | `--version <show 中的 aggregate_version>` | CLI 不自动读取新版本替换旧意图 |
| 人工 CLI done / wait | `--run <原领取回执的 run_id>` | 不允许查找最新 run 后套用旧结果 |

八类 HTTP action 是 `claim / update / resolve / autoreview / pin / release / reopen / archive`，路径为 `POST /api/tasks/:id/:action`。CLI 的 `take / edit / approve / reject / reopen / release / hold / archive` 对应这些控制入口；编辑 JSON 可显式携带 `expected_version`。自动队列领取由服务端选择任务，不要求客户端预先获取某张卡的版本。其他目标分解/流水线命令不因这张表自动取得同一版本保护，详见 [versions.md](versions.md)。

`aggregate_version` 是单调比较标识，可以跳号；它不是时间戳。`run_id`、`agent_instance_id`、`node_id` 都不是认证秘密。收到 409 后应保留原输入、重新阅读任务并重新判断意图，创建一条新的命令；不能把返回的 current_version 或新 run_id 直接塞回旧请求循环重试。

## 操作顺序和确认点

1. **记录旧环境。** 保存实际代码提交、配置、数据库/证据路径、节点身份、正在运行的 worker/run、待裁定事项和自动启动设置。使用 Node 24 与 Python 3.12（当前 CI 配置）；Git for Windows 至少 2.45.0 并通过实际 `--no-lazy-fetch` 探测。可执行程序与模型登录另行核验，安装成功不等于真实调用通过。
2. **停写并安排在途任务。** 停止领取、worker、审阅循环、后台调度及其他数据库写入者；等待已领取任务按旧协议完成，或明确记录停止及未交付内容。确认旧进程停止后才切换数据库写入版本。隧道暂时断开时继续既有任务是日常离线合同，不等于可以在仍运行旧 worker 时升级协议。
3. **一致性备份并核验。** 使用 [backup.md](backup.md) 的 create/verify；备份必须在新目录，保留数据库、证据及校验结果。配置、凭据与部署登记另行安全备份，工具不会把它们打包。不要仅复制活动 SQLite 主文件，忽略 WAL 或外部证据。
4. **先在新目录演练。** 核验备份后用 `restore <备份目录> <新恢复目录> --upgrade-schema` 显式升级旧 schema。迁移失败保留 `.incomplete`；成功也保留 `board_restore_hold`。核对任务/事件、身份、证据与迁移回执，再按 [recovery.md](recovery.md) 的 prepare/activate 流程处理；不手工删隔离标志。演练副本不能与原节点同时冒充同一身份上线。
5. **统一切换客户端。** 升级 server、面板、`cli/board.py`、worker/review loops、sentries 及调用 HTTP 的脚本；重载浏览器并舍弃旧版本未提交草稿。源代码接受仍需核对实际树；不得写一个新 accepted_rev 来跳过审阅。混合版本共同写同一数据库不受支持。
6. **处理历史在途记录。** 迁移为缺少 run 的旧任务创建 imported 记录，不伪造已观测 agent 身份。旧进程不知道 imported ID，不能继续交付；确认停止后通过已登记线路的停止/回收流程处置；恢复激活流程会结束旧 run 并把任务保持未放行。未由线路管理的旧领取需确认进程已停、等待原租约回收并核对 run 已结束，再作新领取。CLI release 是放行标志，不是结束在途执行。不能把 imported ID 交给旧进程以恢复写入。
7. **单机验证后再接双机。** 先核对健康、任务读取、版本冲突及原 run 回执；再核对独立 peer 端点、双向项目授权和 epoch。每台终端使用自己的数据库，不能共享同一个 SQLite 文件。两台同名实体机用稳定 node_id 区分。任务所有者不随显示名变化或断线自动转移。
8. **模型与上线分别验收。** 本机桩、HTTP 回环与 CI 不能替代 Claude/Codex/Zcode 的真实任务或两台实体电脑断线重连验收。以项目计划各阶段的原始回执判定；当前完整阶段仍 0/12。只有明确上线授权和对应验证齐备后才改实际部署。

## 人工命令示例

以下 ID、版本和 run 都只是说明，先读取并核对实际任务。编辑文件必须为 UTF-8 JSON；例如移线文件内容为 `{"line":"alpha"}`。版本 7 只适用于刚核对的第 7 版任务：

```powershell
python cli/board.py show 12
python cli/board.py edit 12 --version 7 --file move-line.json
```

指定领取之前再次 show、核对任务及其实际版本；下例假设这次看到版本 8。交付保存 take 输出中的原始 run_id，不从后来的 show 查询替换：

```text
python cli/board.py take 12 --as alpha --version 8
python cli/board.py done 12 --as alpha --run <take 返回的原 run_id> --file evidence.md
python cli/board.py wait 12 --as alpha --run <take 返回的原 run_id> --file reason.md
```

done 与 wait 是两个备选结局，不是顺序执行步骤。done 进入待审阅，不等于人工验收。对 `in_progress` 任务，版本匹配时只允许追加 description；不能借编辑移线或修改其他字段，追加内容也不会改变已领取 worker 的输入快照。

## 凭据、角色和网络

旧 `board_token / worker_token / review_token` 属于本机单机 HTTP；peer bearer 属于独立节点网关；broker principal 属于本地角色 MCP，不能互换。peer 网关与 MCP broker 是不同回环端口，只有 peer 端口计划由 Tailscale 私网 HTTPS 代理。本机 UI 和 MCP broker 不直接暴露给网络。凭据更换、角色更新及节点 epoch 恢复必须按各自所见版本显式操作。

线路 `fleet.config.json: lines[].role.kind` 仍只有 implement/review；broker 策略 `broker_roles.policy_json.kind` 是 coordinate/implement/review/observe。它们是不同对象的字段域，不自动转换。broker 的执行能力配置只能使用 board-tools 或 workspace-files，执行角色恰选一种；旧未知策略会拒绝认证或启动，管理员通过 `mcp-admin roles` 查看原版本并显式修复，不把旧标签静默升级成权限。

## 恢复与回滚

旧服务不能直接写新 schema。回滚前先停新版全部写入者，保留升级后的库、证据及配置，核对新增任务/结果如何保留，再恢复迁移前备份与匹配的旧代码。不得用覆盖备份来静默丢弃升级后工作。恢复副本入网还需显式激活、epoch/凭据轮换和对端接纳，见 [source-recovery.md](source-recovery.md)；回滚代码不代表可以重用旧凭据或重新启动已消费的模型许可。

## 验收回执

| 确认点 | 必须保留的证据 |
|---|---|
| 停写 | 旧进程及自动启动停止的实际观察、在途任务处置 |
| 备份/演练 | verify 成功、摘要/计数核对、原备份不变、恢复隔离与显式激活回执 |
| 协议升级 | 旧 worker 领取拒绝；当前协议领取成功；旧版本控制及旧 run 回写拒绝；正常回写成功 |
| 数据与权限 | 原任务/历史/归属保留；同名终端身份不同；项目范围和撤销有效 |
| 双机/模型 | 实体断线继续、重连一致；实际供应商/调用数/模型/终态/用量；未知值保留未知 |
| 发布 | 准确提交的 Windows CI 和秘密扫描、完成的阶段验收及上线授权 |

源码、数据库各组件 schema、worker 协议、peer 协议和 package 版本是不同合同，不要求数字相同。逐项定义见 [GLOSSARY](../GLOSSARY.md#federation-contracts-024-development)，详细 run 行为见 [runs.md](runs.md)。
