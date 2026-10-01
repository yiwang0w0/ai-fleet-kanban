# 异常退出后的实例锁恢复

节点宿主或调度器异常退出时保留锁，后续启动拒绝接管。现在可在本机生成只读恢复计划，再按明确摘要提交恢复决定；原任务、运行、额度、配置及停止证据保持原样。完成后仍须由操作者显式启动服务。

## 使用步骤

先用 `node-runtime status` 或 `scheduler status` 确认实例 UUID。以下只处理指定数据库旁、属于该实例的锁；不会扫描目录或批量清理。

```powershell
node cli/runtime-lock.mjs prepare --db C:/board-data/board.db --kind node-runtime --instance <实例UUID>
```

将 JSON 保存到本机私有目录，核对 `host_pid`、`host_process_state`、`blockers`、`proofs`、原锁身份及 `plan_digest`。需要处理独立调度锁时，将 kind 改为 scheduler。嵌入调度器的宿主崩溃可能同时留下两种锁；每种锁须分别核对计划，不因另一种已恢复而自动解除。

```powershell
node cli/runtime-lock.mjs apply --db C:/board-data/board.db --plan-file C:/board-private/lock-plan.json --digest <已核对plan_digest>
```

prepare 只读打开数据库，不安装表、不改锁或生命周期。apply 在独立写事务内重新核对节点代次、实例状态、原锁摘要及运行证明，然后保留不可变回执，将尚未结束的旧实例记录为 `attention / RUNTIME_LOCK_RECOVERED`。这不是一次正常运行完成，也不验收任务。

事务提交后，复用 Windows 原生文件辅助程序，在不共享的同一文件句柄上核对摘要并清理匹配的锁。新实例、替换文件、不可访问文件保留。清理失败时回执仍有效，用**同一份**计划重放，只重试原锁清理；不会再次结算任务。apply 退出码 0 表示原锁已删除或不存在，2 表示决定已记录但清理未完成，1 表示计划或恢复条件不满足。结果中 receipt 是持久决定，cleanup 是本次文件操作观察。

## 放行条件与限制

- PID 探测只使用信号 0，不终止进程；Node 将其定义为进程存在性检查，参见 [Node 文档](https://nodejs.org/docs/latest-v24.x/api/process.html#processkillpid-signal)。只有 ESRCH 才视为不存在。活 PID（包括被其他进程复用）、权限不足或其他未知错误均阻止清理；不凭旧心跳推断停止。
- 节点当前代次的登记运行须已结束，并具备既有 `never_launched`、合成终态、Windows Job 清空/未启动观察，或先前已登记的人工未知运行恢复证明。在途、缺失或不匹配证明均阻止恢复。本机未登记的活动运行同样阻止；已结束的历史旧循环不被此入口重新鉴定。
- 人工证明仍明确标为 `operator_attested_not_machine_verified`，不会被包装成机器停止观察。未登记的外部子进程不在本工具的证明范围内；恢复证明来自节点运行合同，并非整机所有进程的停止保证。
- 原锁必须是普通单链接文件且匹配所选实例、节点和 epoch；不支持清空、损坏、无登记实例或恢复前旧 epoch 的锁。此类情况保留现场，经单独的身份/备份恢复规程处理。
- 计划对状态变化敏感。`PLAN_STALE` 要重新核对；`LOCK_RECOVERY_CHANGED` 要核查替换后的实例。已消费的启动许可、预算和任务所有权均不重置，恢复不会自动重试模型。

首次 apply 增加独立 `runtime_lock_recovery_schema=1` 与只增不改的 `runtime_lock_recoveries`；不修改已有生命周期或任务存储版本。备份保留该记录；节点换代后旧计划拒绝重放。旧程序不会理解新回执，不得用降级代码绕过原锁与运行核对。

## 验证

Windows 五项专项通过：真实节点子进程在启动后直接退出、只读计划、可审计解锁与显式重启、活 PID/未知运行阻断、文件替换与旧计划拒绝、事务失败保留、调度锁 CLI、回执保留约束及清理失败幂等重试。早期四项因缺少恢复入口失败，随后通过；修改断言的复测不重复计数。[本批证据](runtime-lock-recovery-evidence.json)另记录 CI145 夹具顺序修复一项，本批共六个不同用例。

测试只使用临时数据库、合成运行与本机回环服务，没有调用真实模型或处理生产锁；这不替代实体双机、服务重启演练或 G 回执签收。
