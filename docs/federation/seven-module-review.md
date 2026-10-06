# 七模块评审：固定 f10f268 的运行复核

评审代码：`f10f268c30358b8a2dcb58e72ac79c629fa15f5a`，版本 0.24.0，Windows。原报告的 0f6935e/83acc1b 不作为本轮运行基线。本轮开始时开发分支已到 d55046a（增加节点常驻与登录工具），另建干净 detached checkout 运行 f10f268；没有回退开发分支或部署目录。

**以下实验及未修复状态固定于 f10f268。** 后续 H2 修复见 [面板认证证据](panel-auth-evidence.json)，H4b 修复见 [取消只读查询证据](cancellation-status-evidence.json)，H4a 修复见 [取消结算证据](cancellation-closure-evidence.json)，H5a 修复见 [封存恢复证据](sealed-restore-evidence.json)，H4d 人工未知运行出口见 [恢复证据](uncertain-execution-evidence.json)，H4c 换代绑定人工退出见 [绑定恢复证据](binding-recovery-evidence.json)，H5b 跨过中间代次见 [恢复链证据](source-lineage-evidence.json)，H3a/M1 本机阻塞诊断见 [操作说明](progress-diagnostics.md)，H3b/H3c 跨模块只读清单见 [巡检说明](inspection.md)，其余 H3 冲突与健康观测见 [统一说明](conflicts.md) / [健康哨](health-watch.md)，H6a 完整请求与错误分类见 [执行器预检](executor-preflight.md)，H6b/c 无输出与 stderr 类别见 [运行观察](executor-observation.md)，H7 凭据生命周期见 [修复证据](mcp-lifecycle-evidence.json)，H8 见 [准入和写锁证据](peer-admission-evidence.json)，H9 见 [旧循环验证与证据边界](legacy-boundaries.md)，H10 部分实现及容量结论修正见 [工作区与容量](workspace-recovery-capacity.md)，H11 见 [固定 Git 与事务边界](source-git.md)，H12 见 [端点绑定](peer-endpoints.md)；不覆盖本页旧基线观测。 当前证据见 [seven-module-review-evidence.json](seven-module-review-evidence.json)。本页中的 H1–H12 属于 `seven-module`；先前 PR2 行内 B1–B3/H1–H7 的修复证据属于另一套编号。

## A 机实际状态与处置

2026-10-01 检查时，127.0.0.1:47824 的根页面与 /api/meta 均连接拒绝；未发现命令行匹配该看板的 Node 进程。Tailscale 仍在 47824 监听并转发到该不可达回环地址。可确认“看板当前不可用”，不能仅凭进程缺失认定此前 taskkill 是原因；没有以旧 PID 推断当前进程身份。

按用户本次明确指令，先核对目标确为 TCPForward 到 127.0.0.1:47824，再执行：

```powershell
tailscale.exe serve --bg --tcp=47824 off
```

复读 Serve 配置并与仅删除该项的预期配置比较一致；47824 不再有监听。没有使用全局 reset，其他项未改。撤销回执时间为 2026-10-01T07:10:36.581Z。原始前后配置保存在本机私有日志目录，公开证据只保留操作类型与比较结果。

本批实际改变了生产网络配置；没有重启旧看板、改生产数据库或启用 peer。旧的“保留 47824”试点备注由本次指令覆盖。移除转发只是收窄现实入口，H2 代码仍需修复。

## 本轮实验结果

两个可重复的独立工具执行了 **8 个缺陷观察**，使用临时数据库、合成任务和回环 HTTP。观察工具成功退出表示缺陷仍能复现，不是“修复测试通过”；没有真实模型调用，没有实体双机验收。

| 编号 | 固定基线上的证据 | 状态 / 限制 |
|---|---|---|
| H1 | 干净 checkout 与完整 SHA 核对；0.24.0；迁移文档、GLOSSARY、SECURITY、CONTRIBUTING、三个 G 草稿均在 Git 树中 | 基线对齐完成；T08.05 沿用已有实现记录，待独立签收 |
| H2 | 未认证 GET / 返回 200 且 HTML 含合成 operator token；/api/meta 暴露节点 ID，/api/tasks 可见私有合成任务 | 已复现；实际 Serve 入口已撤销，代码未修 |
| H3 / M1 | human_gate 父任务的子任务全部 done；rearmDone 不返回该父任务，仍 waiting_for=rearm，事件数不变 | 已复现这一组合；统一卡点诊断仍缺，未声称所有停滞场景重验 |
| H4a | 真正执行取消协议并记录停止回执后，双方 binding 仍 confirmed、closed=0，来源领取仍拒绝 | 已复现；未据此放松 SQL 守卫 |
| H4b | 实际 HTTP cancel-status 查询将 prepared dispatch 改为 abandoned，并返回 stopped | 已复现；查询入口存在写副作用，未启动模型 |
| H4c / H4d | 当前 runner 的 journal 写入已有 try/catch；缺失可信观察时仍无已验证人工出口 | H4d 仅部分解决；H4c 换代与 H4d 崩溃组合本轮未做完整运行实验 |
| H5a | 候选封存前设置本地 evidence_path，实际备份成功；恢复重定位路径触发 RESULT_PENDING | 已复现；.incomplete 保留、无成功回执、原证据保留；完成封存场景另待覆盖 |
| H5b | validateMarker 要求 retired_epoch 精确等于接收端旧 epoch | 代码仍有此约束；接收端跨过中间 epoch 的完整实验待补 |
| H6 | authorizeLaunch 在 superviseProcess 输入检查前；catch 统一为 SUPERVISOR_ERROR | 保留待修；输入放大、诊断和 idle 分类未在本轮新测，不笼统确认所有子点 |
| H7a | 实际 MCP CLI 读取缺失凭据时 stderr 含完整合成绝对路径 | 已复现；公开证据不保存原 stderr |
| H7b / H7c | MCP report_result 后 task_run 为 ended，principal 仍 active，get_task 仍成功 | H7b 已复现；H7c 文件回收未新测。修复需区分失效权限与合法结果重放，避免破坏幂等回执 |
| H8 | peer 路由仍将认证及处理放在 transaction 中；现有限流主要覆盖认证失败 | 保留；本轮没有真实饱和/锁延迟数据 |
| H9 | 沿用用户复核结论，待针对验证登记簿与 CLI 实际版本的实验 | 未将旧报告实验冒充本轮实测 |
| H10 | workspace 容量查询未按当前 epoch 过滤；artifact 总量累计受 256 MiB 上限约束 | 代码约束仍在；未重跑容量耗尽，禁止凭时间自动删除历史工作区 |
| H11 | source-gate 使用 PATH 上的 git 并继承环境 | 保留；固定 Git/锁延迟待处理。Git 版本不同本身不意味着相同 Git 对象哈希不可比较 |
| H12 | 凭据未绑定 server_endpoint；将合法凭据指向另一个受控回环 HTTP 端点，该端点在身份验证前已收到 Authorization | 已复现；后续 REMOTE_401 不能收回已发送的凭据。不是实际截获真实凭据 |

本轮覆盖六个高优主题中的上述具体子点；不宣称“剩余 11 条全部运行复核通过”。其他子点继续按原证据等级保留，后续修复时针对性补红绿断言。

## 回归结果与失败口径

固定 f10f268 执行 peer、sync、snapshot、epoch recovery、MCP、server 六个 Node 套件：外层 135 项，134 通过、1 失败。server 内部 195 断言全过，已经包含在一个外层测试中，不能再加总。

失败为 `expired snapshots are refused and old peers without the capability continue using increments`，收到 error 而非 synced。原用例单独重跑 1/1 通过；一次未复现不足以证明原因，保留首轮失败，不标整组全绿，也不通过盲目重复整套掩盖它。

六个 Python 自测命令中五个退出 0。prompt selftest 为 56 PASS / 1 FAIL：断言拒绝任意绝对规则字符串中的 `.data`，而本轮 checkout 的父路径就含 `.data`。原函数生成 58 条规则，去掉 checkout 前缀后没有 `.data` 规则，也没有覆盖整个 core 的规则。已用原函数定位路径敏感误报，但未改冻结源代码或把原失败改写为通过。

首轮新复现工具因 fixture 未传 BOARD_DEFAULT_ROUTE=main 而被服务正确拒绝；修正工具路由并使用实际 board_token 文件接口后，5 个观察成功。取消/恢复工具另外得到 3 个观察。该夹具设置失败与上述原有测试失败分开记录。

复跑命令（`$frozen` 为干净、已核对 SHA 的 f10f268 checkout；输出使用尚不存在的本机私有文件）：

```powershell
node tests/seven-module-baseline-probes.mjs --code-root $frozen --revision f10f268c30358b8a2dcb58e72ac79c629fa15f5a --output $newProbeReceipt
node tests/seven-module-result-probes.mjs --code-root $frozen --revision f10f268c30358b8a2dcb58e72ac79c629fa15f5a --output $newResultReceipt
# 以下在 $frozen 内运行；使用本机已核验的 Python，避免写字节码。
node --test tests/peertest.mjs tests/synctest.mjs tests/snapshottest.mjs tests/epochrecoverytest.mjs tests/mcptest.mjs tests/servertest.mjs
node --test --test-name-pattern 'expired snapshots' tests/snapshottest.mjs
python gates/gates_lib.py
python loops/worker_loop.py --codex-selftest
python loops/worker_loop.py --prompt-selftest
python loops/reviewer_loop.py --digest-selftest
python watchers/board_health_watch.py --selftest
python probe/run_probe.py --policy-selftest
```

这些复现工具不加入正常 CI：它们断言旧缺陷存在，修复后相应断言应失效；修复验收必须另外使用预期正确行为的回归断言。

## 回执与下一步

G01/G02/G05 的 code_sha 重钉 f10f268，证据绑定本轮 manifest 摘要。旧 dfcbc73 的行内评审正常/负向对照保留在 historical_test_evidence，未冒充当前结果。三份仍 pending、accepted_task_ids 为空；正式验收 **0/72、0/12**。T01.05/T08.05 待非实现者签收，T01.05 的签收还须覆盖本次发现的恢复组合。

下一批按依赖收敛工作，不添加新的常驻功能：

1. H2：移除匿名页面中的令牌、保护敏感读取，并提供明确的本机认证入口。验收匿名页面/任务/节点信息均不泄密、正常授权界面可用；不以监听 loopback 代替认证。
2. H4/H5：取消状态读取与推进分离；验证双方停止后提供明确的取消闭合，保留历史及来源重新执行的授权边界。恢复需允许经过校验的路径重定位同时保留候选封存，失败原子回滚，不能删触发器绕过。
3. H3/H7/H12：为已复现卡点提供明确原因与可审计出口；收紧运行结束后的 MCP 权限并保留幂等回执；凭据发送前校验发行时绑定端点，不能只在第一次成功之后记端点。
4. H4c/H4d/H5b 与 H6–H11：在对应修复进入时完成缺失运行实验，每个修复提供旧行为会失败的断言，再跑受影响测试。尚未解决这些入网阻碍前，不启用真实 peer。

B 机此前用户提供的预检只确认 Node/SQLite/Git 与当时 Tailscale 互见，未验证实际桌面 MCP 或双机业务。B 初始化回执和 G03 具体启用方案继续沿用已有待办，不要求重复预检，也不挪用新的模型额度。
