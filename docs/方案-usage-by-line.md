# 方案:账本按线汇总(usage-by-line)

> 2026-09-29 · 状态:草案(commit 即冻结;目标卡引用本文件的路径与提交)。
> 这是身份分配方案(`docs/方案-身份分配.md`)P3 测量的**前置设施**:P3 要按阶段记 token,而阶段 = 线
> (方案评审线 / 实现线 / 审阅座席),账本今天只按卡汇总。改动小、可机器验收,适合作为流水线的第一个真实目标。

## 1. 现状

- worker 每次尝试往 `<data>/usage_ledger.jsonl` 追加一行:`ts · card · attempt · worker · model · effort · sid · calls · in · cc · cr · out · note`
  (`loops/worker_loop.py` 的 `acct_attempt`);codex 座席与审阅座席经 `codex_runtime.append_usage` 写同一文件,`worker` 字段分别是槽名(`engine` / `engine@2`)和 `reviewer`。
- `GET /api/usage`(`core/server.mjs`)把账本按**卡**折成 `{cards: {<id>: {...累计}}}`,面板卡面的 tok 徽章读它。
- 没有任何地方按**线**或按**座席**汇总;`pool-quota` skill 只能报「哪张卡烧得多」。

## 2. 改什么(三处,不改机器名)

1. `GET /api/usage` 的响应增加两个键(**新增,不改既有 `cards`**):
   - `by_line`:`{<line>: {calls, in, cc, cr, out, cards: <张数>}}`。线 = `worker` 字段去掉 `@<slot>` 后缀;`reviewer` 归为 `review`;识别不了的 `worker` 归为 `"?"`(不丢行,不静默)。
   - `by_model`:`{<model>: {calls, in, cc, cr, out}}`。
2. `cards[<id>]` 每项增加 `line`(最后一行的线;同一张卡换过线时以最后一次为准 —— 与 `prev_line` 只留最近一跳的立场一致)。
3. `docs/GLOSSARY.md` 增加 `by_line` / `by_model` 条目(machine,additive);`.claude/skills/pool-quota/SKILL.md` 的读取示例改成也打印 `by_line`。

面板不改(P3 用 API 读;面板显示是另一张卡的事)。

## 3. 验收(`done_when`,只写机器可判的)

- `node tests/servertest.mjs` 退出码 0,输出含新增断言的 PASS 行:往临时账本写三行(`engine`、`engine@2`、`reviewer`,两种 model),`GET /api/usage` 的 `by_line.engine.calls == 2`、`by_line.review.calls == 1`、`by_model` 两个键、`cards[<id>].line == "engine"`;一行 `worker` 为空字符串时归入 `"?"`。
- `GET /api/usage` 对**空账本**仍返回 `cards: {}` 且 `by_line: {}`、`by_model: {}`(不因新键而 500)。
- `docs/GLOSSARY.md` 能 grep 到 `by_line`。
- `git diff --stat` 只涉及 `core/server.mjs`、`tests/servertest.mjs`、`docs/GLOSSARY.md`、`.claude/skills/pool-quota/SKILL.md`;不动 `loops/`(账本行的形不变)。

## 4. 不做

- 不改账本行的字段(`worker` 保持原样;线是**推导**的,不是新列 —— 旧账本一行不改也能汇总)。
- 不做美元换算(INCIDENT-8:订阅池部署里美元不是任何东西的单位)。
- 不加面板图表。
