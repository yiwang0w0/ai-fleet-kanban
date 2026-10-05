# 阶段回执草稿

2026-10-05 恢复后的首个必选 CI 全绿候选为 `864feec033f4be38c929ae2d29cf683fb266516d`（0.24.0）。[CI #149](https://github.com/yiwang0w0/ai-fleet-kanban/actions/runs/37258132393) 的 Windows harness 与 gitleaks 均成功，逐步结果、时间与源码摘要见 [候选证据](../acceptance-candidate-evidence.json)。

[G00](G00.draft.json)、[G01](G01.draft.json)、[G02](G02.draft.json)、[G05](G05.draft.json) 已绑定这个候选，仍为 `pending`，`accepted_task_ids` 为空。CI 全绿没有替代角色审阅、设备配置绑定和操作者裁定。正式验收仍 **0/72 项、0/12 阶段**。

G00 根据操作者转述重建，未取得最初附件。已记录用户“沿用”原有每种执行器一次最小任务的授权，已消费调用不重置、不退款、不自动重试；持续运行预算及其余未确认决策仍待冻结。

原 f10f268 的 [G01](history/f10f268/G01.draft.json)、[G02](history/f10f268/G02.draft.json)、[G05](history/f10f268/G05.draft.json) 按原字节保存在 history，包含其初次失败及更早 dfcbc73 的行内评审证据。新草稿不改写旧实验来源，也不沿用旧报告的“尚未修复”作为当前结论。

T01.05 与 T08.05 的 [独立签收材料](independent-review.md) 已列出验收条件、测试位置及尚需填写的结论；两项均待非实现者实际签收。

G05 有本机真实计时 30 分钟离线、容量故障和授权投影对照证据。后续 a936951 的三节点分区实验属于独立本地补充，不计入 CI #149；所有这些证据均不替代实体双机 Tailscale 断线、重连和投影哈希验收。


2026-10-05 验收材料对齐：补 [九项可交独立审阅清单](acceptance-ready.md)、[逐条断言与摘要](acceptance-readiness.json) 和 [G00 实际缺项](G00-readiness.md)。六项原 planned/in_progress 状态已按现有材料纠正为 implemented_pending_acceptance；这不是独立结论或正式签收。旧候选、回执和历史结果原样保留。

2026-10-05 基线补充：T00.05 新增固定 864feec 的隔离源码、配置与组件 schema 观察，[待审清单](acceptance-ready.md) 现为十项。仅执行一次新基线初始化；实体 A、旧回执和正式签收状态不变。

2026-10-05 交付条件核对：T06.04/T06.05/T07.05 原标准已有固定候选断言及 CI #149 成功证据，详见 [逐条说明](delivery-readiness.md)。待独立验收增至十三项；保留旧 verification_history，实体复现与正式门禁不变，没有新增运行测试。

2026-10-05 同步条件核对：T05.02/T05.03/T05.05 的原条件已对应固定候选和成功 CI 的实际断言，[逐条说明](sync-readiness.md) 同时保留 T05.01 两阶段 outbox、真实隧道及阶段验收限制。现为十六项已实现待独立验收；未新增运行测试、正式签收或调用授权。
