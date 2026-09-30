# 受控领取、调用预算与启动许可

对应 T04.02 / T04.06 的调度存储部分。MCP 协调工具的路由请求现在可以由本地管理命令转换为真实 task_runs 记录和受限运行凭据。启动许可和终态回执接口供后续执行器监督进程使用；当前 CLI 支持 Claude/Codex/Zcode 单次 execute 与终态 reconcile（见 adapters.md）；持续队列入口见 scheduler.md。

这不是完整执行器验收。固定程序参数、供应商输出解析、进程树终止、工作区隔离和真实调用仍在后续批次。所有本批测试使用临时数据库、Git 夹具和 stdio 桩进程；真实三模型仍各 0/1。

## 状态与计数

| 分派阶段 | 任务与权限 | 预算 |
|---|---|---|
| prepared | 原生领取已提交；运行凭据已生成，但不能调用执行身份 MCP 工具 | 保留一个名额；used 不变 |
| launch_committed | 一次性启动许可已提交；运行身份 MCP 权限生效；尚不证明进程或模型已启动 | used 加一，保留名额移除 |
| settled | 已记录观察到的执行终态；成功仍待审阅，失败/超时/取消待决策 | 不自动退款 |
| interrupted | 原 run 被结束、回收或替换；待核对执行进程状态/迟到结果 | 未启动的保留可释放；已消费许可仍计数 |
| abandoned | 操作者明确放弃尚未消费许可的运行，任务待决策、运行凭据撤销 | 只释放未启动保留 |

used 是已提交启动许可的次数，不是 token 数、美元费用或已证实的模型成功数。进程启动失败、许可提交后进程崩溃、响应丢失等都不能自动退回名额。未确认实际调用时 real_model_call_confirmed 保持 false；不把未知用量写成零。

一次性许可只能由可信本地监督进程调用 authorizeLaunch 获取。该函数只在自己持有的事务提交后返回 launch_permit=true；重复调用、另一进程重试、重连数据库都拒绝再次发放。普通 status 查询永远返回 launch_permit=false。未来监督进程只能凭本次新取得的许可启动一次，不能根据数据库中的 launch_committed 状态补启动。

## 领取前检查

prepareDispatch 在同一写事务内检查：

1. 节点有效、未退役、未处于恢复隔离。
2. 治理代码是已验收且当前进程加载的 Git 树；整个治理目录干净。治理闸不采用未验收环境变量豁免。
3. 路由记录是 waiting_executor，任务 owner_node_id 和所见 aggregate_version 仍匹配。
4. 原协调凭据仍有效、版本与项目权限仍匹配。
5. 角色仍启用、版本/摘要/完整策略一致，重新执行确定性选择仍选中该角色。身份线和 mcp 路由必须匹配。
6. 预算属于当前节点代次、运行时、项目和执行类别，且 used + prepared 保留数小于上限。
7. 原生尝试数未达到任务 max_attempts 与角色上限中的较小者。该调度通道不扩大到既有生命周期倍数。
8. 原生 claimById 的放行、依赖、人工闸、祖先放行、任务锁、根并发上限、未完成子任务和无进展限制全部通过。

原生 claimById 增加外层 SAVEPOINT 支持，原有独立调用仍自行提交。领取、run、角色/源代码/父上下文快照、运行身份、预算保留及路由状态一起提交。新凭据文件必须独占创建且位于治理仓之外；提交失败尝试移除该新文件，不覆盖已有文件。

prepare 的事务不允许嵌套在调用者未提交的事务里，避免先返回有效文件路径、随后外层却回滚。进程在文件写入后、数据库提交前崩溃时，可能留下无效的孤立文件；数据库没有对应授权，重试不得覆盖它，操作者需核对后清理。

治理目录之外并不等于操作系统不可访问；文件 ACL 与工作目录隔离尚未验收。

## 启动前重验

authorizeLaunch 再检查节点代次、源代码树、任务/run/版本、租约、放行、人工闸、依赖、祖先、子任务、任务锁、父任务上下文、角色选择、协调授权、运行凭据和预算版本。父任务文本摘要也参与本通道的无进展指纹，父上下文改变不能被当作同一次旧输入。

预算策略改变后，旧 prepared 记录不能悄悄使用新预算启动；应核对并放弃/重新安排。预算 used 单调增加，更新配置不能重置已使用次数，也不能降低至已消耗与保留次数之下。fixture 与 provider 名额互不替代。

新调度身份的 MCP 工具鉴权要求对应分派已经提交启动许可；单纯拿到 prepared 凭据不能开始回写、拆分或续租。

## 交付与迟到结果

finishDispatch 接收已观察的 success / failed / timeout / cancelled、证据文本和可选输入/输出 token 数。该函数不验证供应商输出协议，后续适配器必须先完成协议判断，不能仅按进程退出码宣称 success。成功证据不能为空；未知用量为 null。

- 当前 run 仍在执行：复用原生 report；success 进入 waiting/review，其他终态进入 waiting/decision，均不自动验收。
- 相同 run 已通过 MCP report_result 交付：保留原交付内容与等待种类，进程回执另存，不用最终 stdout 覆盖 agent 的正式交付。
- 任务已被其他 run 替换或状态改变：只保留迟到回执，不修改当前任务。
- 同一分派重复提交同一终态回执返回原结果；改变内容返回 RESULT_CONFLICT。
- 回执写入失败时，任务状态、run、工作时段、事件和终态记录一起回滚；重试不再消费启动许可。

fixture 由监督接口直接交付时会加上明确的无真实模型调用标记。所有分派回执都保留 execution_mode；stdio 桩自行交付的原文按其正式回执保存，不能据此视为真实模型证据。

任务 run 结束的数据库触发器同步结束路由记录，并标记未结清分派为 interrupted。这个状态不证明 OS 进程已终止，也不授权重新启动。它与离线继续执行并不冲突：离线任务应由本机监督进程维持本机心跳；真实监督进程尚待接入。

## 本地命令

需要 Node24。预算、领取和放弃属于可信本地管理操作，不作为远程 MCP 工具开放。所有路径为示例占位符，须替换成已批准部署路径。

预算 JSON 示例：

    {
      "quota_id": "11111111-1111-4111-8111-111111111111",
      "runtime": "claude",
      "execution_mode": "fixture",
      "projects": ["demo"],
      "limit_total": 1,
      "enabled": true
    }

quota_id 是操作者生成并持久保留的 UUID；重复建新预算不构成额度续期机制。provider 预算须对应实际用户授权，不能从 fixture 预算推定。

    node cli/dispatch.mjs quota --db C:/board-test/board.db --policy-file C:/board-test/quota.json
    node cli/dispatch.mjs quota-status --db C:/board-test/board.db --quota <quota_id>
    node cli/dispatch.mjs prepare --db C:/board-test/board.db --assignment <assignment_id> --quota <quota_id> --mode fixture --credential-file C:/board-private/run.json --accepted-rev C:/board-private/accepted_rev
    node cli/dispatch.mjs status --db C:/board-test/board.db --dispatch <dispatch_id>
    node cli/dispatch.mjs abandon --db C:/board-test/board.db --dispatch <dispatch_id> --reason "尚未启动，改为人工核对"

预算更新还需 --version <所见版本>。prepare 使用当前 CLI 所在治理仓，不能通过参数改用另一个已验收目录冒充；验收文件遵循现有治理代码审查流程，本命令不会生成或修改它。运行中的旧监督进程不能靠更新验收文件自动变成新代码。

MCP get_sync_status 在该项目授权范围内显示分派阶段和原因，不暴露凭据路径、令牌或治理目录。完整界面、批量操作和队列监督仍待实现。

## 证据

npm run test:dispatch 覆盖原生闸、版本/授权变化、源代码闸、预算保留和 CAS、两个独立进程争抢、嵌套事务拒绝、提交失败回滚、旧 run 回执、MCP 先交付、独立 stdio 进程、租约回收和本地管理 CLI。源文件摘要及完整回归/CI 结果见 dispatch-evidence.json。阶段 G04 仍未通过。

持续调度现已接通本机已授权 provider 请求、受限预算、私有启动目录及登记工作区，并保留一次性许可与进程停止证明。命令、停止及回执恢复流程见 [scheduler.md](scheduler.md)。这个接线不替代真实订阅、OS 隔离或 G04/G10 验收。
