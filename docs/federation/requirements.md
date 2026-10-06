# AFK-FED-001：V1 需求落点与验收边界

对应计划 1.3、T00.01。此表落实原已确认需求，不增加功能范围，不签署 G00 或宣布实现验收通过。实现落点以 `df85ff2d95dda61f86a065f6ef303ff614585267` 核对；运行证据各自保留实际测量 SHA。

| 需求 | V1 约束与实现落点 | 现有测试入口 | 仍待的验收 |
|---|---|---|---|
| R01 | 两台实体 Windows 节点经私有 Tailscale 相连；[core/federation/gateway.mjs](../../core/federation/gateway.mjs)、[说明](peer-endpoints.md) | [tests/peer-endpointtest.mjs](../../tests/peer-endpointtest.mjs) | S03/S09：实体 A/B 健康互访、路径和访问矩阵仍待。 |
| R02 | 全局视图汇总授权节点、树与同步状态；[core/fleet-view.mjs](../../core/fleet-view.mjs)、[说明](fleet-view.md) | [tests/fleetviewtest.mjs](../../tests/fleetviewtest.mjs) | S08/S09：实体客户端与双机可见性仍待。 |
| R03 | 终端名仅显示/路由，所有权绑定稳定 node_id；[core/store.js](../../core/store.js)、[说明](identity.md) | [tests/identitytest.mjs](../../tests/identitytest.mjs) | S00/S02：真实设备登记单独验收，不能用同名推断同一节点。 |
| R04 | MCP 按角色分派，本机确定性调度执行；[core/mcp/tools.mjs](../../core/mcp/tools.mjs)、[说明](dispatch.md) | [tests/dispatchtest.mjs](../../tests/dispatchtest.mjs) | S04/S10：真实执行器链路和桌面接入仍待，已消费额度不重置。 |
| R05 | 每个终端保留自己的根与本地父子树；[core/task_tree.js](../../core/task_tree.js)、[说明](trees.md) | [tests/treetest.mjs](../../tests/treetest.mjs) | S06：跨端关联不把副本变成本机领取任务；真实树协作另验。 |
| R06 | 根之间通过授权委派和登记的关系连接；[core/federation/delegation.mjs](../../core/federation/delegation.mjs)、[说明](relations.md) | [tests/relationstest.mjs](../../tests/relationstest.mjs) | S06/S09：缺失回执、灾难恢复及真实跨节点闭环仍须按场景验收。 |
| R07 | 断线仅继续已领取工作，重连补发结果；[core/federation/sync-client.mjs](../../core/federation/sync-client.mjs)、[说明](sync.md) | [tests/synctest.mjs](../../tests/synctest.mjs) | S05/S09/S10：本机离线证据可复用；实体断线、恢复与持续观察尚未验收。 |
| R08 | 实现、CI、执行器与部署仅支持 Windows；[.github/workflows/ci.yml](../../.github/workflows/ci.yml)、[说明](operator-runbook.md) | [tests/supervisortest.mjs](../../tests/supervisortest.mjs) | 历史 Linux 结果不作为本次验收；Git for Windows 的 Bash 不等于 Linux 主机。 |
| R09 | 桌面聊天用受控 MCP 与 Markdown 了解任务；[core/context-handoff.mjs](../../core/context-handoff.mjs)、[说明](desktop-context.md) | [tests/desktopcontexttest.mjs](../../tests/desktopcontexttest.mjs) | S08：实际客户端接入单独核验；原生嵌入侧栏取决于客户端能力，不宣称已经实现。 |

## 离线合同

Tailscale 隧道中断时，继续已经取得有效执行许可的本机任务，保留日志、产物和待同步结果；不因远端离线自动转移所有权、重复派发或宣称远端已停止。新跨端关系及需对端确认的操作保持待确认。若供应商网络也不可用，只能保留任务并显示等待连接，不能保证模型继续生成。取消未获确认不计作远端已取消。

## 扩展项单列

以下不作为已交付的 V1 承诺：多写者任务数据库、自动接管失联终端、登记节点自动选主/高可用、公网面板、Linux 适配、任意桌面客户端原生侧栏嵌入。若需要这些扩展，应明确修改范围和相应验收合同。Windows 上原生进程隔离、授权边界、独立验收和已承诺的人工灾难恢复仍属于原计划，不能因单列扩展而省略。

## 本项验收资料

T00.01 的标准是每项需求有实现落点、明确离线仅继续已领取工作、扩展项单列。本文件提供这些材料；各功能是否已经通过实现/实机验收，由对应任务和阶段判定。[待审清单](gates/acceptance-readiness.json) 不等于通过回执。
