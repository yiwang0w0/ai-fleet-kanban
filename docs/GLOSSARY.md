# GLOSSARY — frozen at v0.1 (operator ruling R2, 2026-09-02)

The freeze rule: **renaming any `machine` term below is a breaking change** from
v0.1 on — these are wire values, JSON keys, table/column names, env names and exit
codes that other people's configs, scripts and stored databases will depend on.
`display` wordings (Chinese UI strings) may evolve, but each must keep the same
referent — never reuse a listed word for a different concept.

Every entry was grep-verified against the code at freeze time; nothing here is
aspirational. Where a term is deliberately maintained in TWO places (noted below),
a change must land in both or the harnesses go red.

## Status machine

| term | layer | meaning |
|---|---|---|
| `not_started` / `in_progress` / `waiting` / `done` | machine | the four task statuses — there is no fifth; "blocked" is not a status |
| 未开始 / 进行中 / 等待中 / 已完成 | display | their Chinese labels (panel columns + CLI; **dual copy**: `core/panel.html` and `cli/board.py`) |
| `waiting_for` = `review` / `confirm` / `decision` / `dep` / `rearm` | machine | why a card waits: delivered–unreviewed / options need a human / worker exhausted attempts / dependency / parked until children finish |
| 待验收 / 待确认 / 待裁定 / 待依赖 / 等待重审 | display | their labels (**dual copy**: `WF_LABEL` in panel, `WF` in board.py) |
| `kind` = `goal` / `task` | machine | card kind; a goal is a human-written chain root that gets decomposed — it is a kind, not a status |
| `weight` = `light` / `standard` / `heavy` | machine | starting-rung prediction only; a card never carries a model name |
| `released` (1/0) | machine | 0 = coordinator staging, invisible to workers (未放行) |
| `human_gate` (1/0), `human_gate_src` = `detect` / `explicit` | machine | waits for a human decision; src records whether the lock was sniffed or deliberate |
| `outcome` = `done` / `wait` | machine | report()'s two endings → waiting/review resp. waiting/decision |
| `verdict` = `approve` / `reject` | machine | ruling values; invariant: verdict non-NULL ⟺ status = done |
| 通过 / 打回 / 结案 | display | approve / bounce / close — 打回 appears in ruling *records* (verdict notes), not as a button label: the waiting card's single button reads 结案 or 回原线继续 depending on the note box |
| `disposition` = `close` / `hand_back` / `hold_for_review` | machine | caller-declared destination of a ruling |
| `resolved_by` = `human` / `auto` / `cascade` | machine | who ruled. **Caller domain is closed** (v0.2): the API accepts only `human` (operator token) / `auto` (review token); `cascade` is store-internal; anything else is 400 — identity on a ruling is never the caller's word |
| `board_token` / `worker_token` / `review_token` | machine | the three credential classes (v0.2): operator = full; worker = execution face (claim/report/heartbeat/derived create/compact/forked/pool); review = ruling face, `auto` only. Files live in the board data dir — operator territory |
| operator request `kind` = `propose-lines` / `mount-sentries` / `install-worker-constraints` / `enable-review` / `board-briefing`; `status` = `pending` / `acked` / `done` | machine | v0.5 panel shortcut buttons addressed to the coordinator seat (`/api/requests`, SSE `request.created/ack/done`). Closed kind domain — unknown refuses. Pending ≥ 5 min is shown as an alarm on the panel (silence is not health) |
| setup step `key` = `board` / `config` / `lines` / `bless` / `sentry` / `cycle`; `state` = `done` / `todo` / `blocked` / `unknown` | machine | v0.6 setup guide (`GET /api/setup`). Every state is MEASURED per request, never stored — the guide walks backward as readily as forward. `unknown` (could not measure) is never folded into `done` |
| `?as=sentry` on `/api/events` | machine | an SSE client declaring itself a sentry, so "is the coordinator seat listening" is measurable. A panel tab is not a sentry; an unmarked client does not count as one |
| `attempts` / `attempts_base` / `attempts_this_claim` / `max_attempts` | machine | lifetime total / anchor re-stamped at claim / this dispatch / per-dispatch budget |
| `lock_key` / `oneof_key` (备选组) / `proves_parent` (验证父卡) / `blocked_by` | machine | mutual exclusion / any-one-passes group / child's pass closes parent / dependency ids |
| `verify_cmd` | machine | a verify-registry **key**, never a command string |
| `prev_line` | machine | provenance: the immediately previous line; never a claim criterion |

## Immutable history (`task_events`)

| term | layer | meaning |
|---|---|---|
| `task_events` | machine | append-only table; `appendEvent` is the only write path; ordered by autoincrement id |
| kinds: `snapshot` `add` `claim` `reap` `release` `report` `resolve` `set_line` `set_parent` `reopen` | machine | the ten event kinds |
| `release` + `detail.action` = `release_held` / `release` / `hold` | machine | one shared kind, disambiguated by `action` (in-flight card returned vs released-flag toggle) — freezing covers the action values |
| `detail.task_kind` | machine | the card's own kind inside an event snapshot (the event's `kind` column names the event) |

## Stop / exit contract

| term | layer | meaning |
|---|---|---|
| `stop_reason` = `stopped-by-user` / `stopped-with-board` / `crash` / `exit-normal` | machine | recorded by the stop's INITIATOR before the tree kill; only `crash` triggers backoff restart |
| 用户停止 / 随看板停止 / 崩溃 code=N / 正常结束 / 启动被拒绝 code=3 | display | `stopText` wordings (single mapping site in the server; the panel maps nothing) |
| exit code `3` (`REFUSED_EXIT` js / `EXIT_REFUSED` py) | machine | a gate refusal — deterministic, never restarted, **paired across the two languages**: change one alone and refusals silently degrade to crashes |
| error codes `NOT_FOUND` `CONFLICT` `BAD_INPUT` `INTERNAL` → 404/409/400/500 | machine | the whole error taxonomy; unclassified falls to 400 `typed:false` |

## Handoff / ruling package

| term | layer | meaning |
|---|---|---|
| option `kind` = `none` / `apply` (legacy `no_sql` / `sql_apply` normalized) | machine | whether a human must take files away and apply them |
| file `role` = `apply` / `rollback` / `companion` | machine | executable (downloadable) vs view-only attachment |
| `files` (legacy wire alias `sql_files`) | machine | option attachment list |
| handoff target `{id, label, dir, exts, name_pattern}` | machine | operator-authorized destination (allowlist polarity: undeclared dirs are never written) |
| `decision_action` = `continue` / `request_completion` / `confirm_executed` | machine | the human's action on a confirm card |
| `executed` / `outcome`(`success`/`failure`) / `receipt` | machine | execution-confirmation fields |
| `decision_json` / `decision_choice` / `decision_sql_archive` / `decision_receipt` | machine | DB columns; the `_sql_` names are **historic and frozen as-is** — content is generalized |
| 手交区 / 执行回执 | display | handoff-target idiom / the receipt |

## Fleet config (`fleet.config.json`)

`lines[]{id,hint}` · `roles[]` (`review` only — reorg retired by ruling 2026-09-02, before the freeze bound it; joins only when its loop script
exists) · `routes[]` · `max_parallel` · `default_agent{runtime,model,effort,window}` ·
`runtimes[]` (seat declarations `{id,label,models,efforts,release_env,cmd_env}` —
code branches on the declaration, never the seat id) · `decompose_models[]` ·
`ladder[{model,effort}]` (precedence: env `WORKER_LADDER` > config > built-in) ·
`language` (generated-card text; null = mirror) · `handoff_targets[]`. All machine.

## Env contract

Operator-facing: `BOARD_DATA_DIR` `BOARD_DB` `BOARD_HOST` `BOARD_PORT` `BOARD_URL`
`BOARD_REPO` `BOARD_CONFIG` `BOARD_DEFAULT_ROUTE` `BOARD_HANDOFF_DIR` `BOARD_UNTIL`
`BOARD_NO_RESTORE` `BOARD_PYTHON` `BOARD_CRASH_BACKOFF_MS` `BOARD_REAP_MS`
`BOARD_POOL_HOLD_MS` `BOARD_POOL_RECONCILE_MS` `BOARD_EXTRA_ORIGINS`
`BOARD_HUMAN_GATE_PATTERN` `BOARD_VERIFY_REGISTRY` `BOARD_WIP_PER_ROOT`
`BOARD_CLI_RUNTIME` `BOARD_CODEX_RELEASED` `BOARD_CODEX_CMD`
`BOARD_ATTACHMENT_ROOTS` `BOARD_ATTACHMENT_APPLY_ROOTS` `BOARD_ATTACHMENT_EXTS`
`BOARD_GATED_SUBTREE` `BOARD_GLOBAL_BUDGET_USD` `BOARD_BASELINE_DOCS`
`BOARD_CONTEXT_MANIFEST` `BOARD_BASELINE_MAX_CHARS` `BOARD_WATCH_INTERVAL`
`BOARD_WATCH_IGNORE_LINES` `BOARD_PROBE_DIRS` `BOARD_PROBE_CHECK_TABLE`
`BOARD_TARGET_REPO` `WORKER_MODEL` `WORKER_EFFORT` `WORKER_RUNTIME`
`WORKER_SESSION` `WORKER_FORK_FROM` `WORKER_ANCHOR` `WORKER_CLAUDE_CLI`
`WORKER_LADDER` `WORKER_LADDER_CAP` `WORKER_HEARTBEAT_SEC` `WORKER_LEASE_MIN`
`WORKER_TIMEOUT_SEC` `WORKER_CTX_COMPACT` `WORKER_CTX_HARD` `WORKER_RATE_WAIT_SEC`
`WORKER_RATE_MAX_WAITS` `WORKER_MAX_BUDGET_USD` `WORKER_VERIFY_SEC`.

Test-only escape hatches (never production defaults): `BOARD_ALLOW_UNPINNED`
`WORKER_ALLOW_BATCH_CLI` `WORKER_CLI_ARGV` `BOARD_POOL_TEST_MODE`
`BOARD_POOL_TEST_PROBE` `BOARD_SPAWN_ECHO` `BOARD_TEST_SHUTDOWN_MS`.

## Operations vocabulary (display; the concepts behind the Chinese UI)

线 line (claim-routing unit) · 卡/任务卡 card · 目标 goal · 链/任务链 chain ·
放行 release (未放行 = held) · 认领/领卡 claim · 交付 deliver · 裁定 ruling ·
打回 bounce · 结案 close (无需后续 · 结案 = final close) · 派生 spawn/derive ·
上浮 uplift (over-deep card re-hung under the chain root, unreleased) ·
联动结案/联动关闭 linked closure · 心跳 heartbeat · 租约 lease · 座席 seat ·
阶梯/档位 ladder/rung · 手交区 handoff target · 两哨 the two sentries
(sse_watch + board_health_watch) · 正史 the immutable record (task_events).

Note: 收起 in the panel means **fold/collapse a UI section**, not "hold a card" —
holding displays as 未放行 / 收进协调待机区. Do not reuse 收起 for holds.

## Alignment with Claude Code's own vocabulary

This project sits **on top of the `claude` command line**, and nowhere else. It is
not built on the Claude Agent SDK, and it is not Managed Agents: it starts CLI
processes, reads their JSON, and stores the result. That means Claude's own terms
apply verbatim to one narrow surface — the argv — and **do not** apply to the
layer above it, where our own words live. Confusing the two is the mistake this
section exists to prevent.

### Terms we take verbatim from the CLI

Every flag below is passed by `loops/worker_loop.py` or `loops/reviewer_loop.py`,
spelled as `claude --help` spells it. Values likewise: `--effort` takes
`low` / `medium` / `high` / `xhigh` / `max` (exactly the five rungs a seat may declare),
`--permission-mode` takes `acceptEdits` (the only mode we pass), `--output-format`
takes `json` for the reviewer. `--model` receives a full model id, not an alias.

```
-p/--print  --model  --effort  --permission-mode  --allowedTools  --add-dir
--output-format  --resume  --session-id  --fork-session  --max-budget-usd
```

The loops pass `-p`, the short form; `--allowedTools` is the camelCase spelling
the CLI lists first (`--allowed-tools` is its documented alias). Doctor asserts
the exact spelling the loops send, not the one that reads better.

**This list is measured, not remembered.** `node cli/doctor.mjs` runs the real
`claude --help` and reports any flag the installed CLI no longer knows — the one
check no harness can perform, because every harness drives a stub and a stub
accepts anything, including a flag that was renamed last week.

### Terms that look official but are ours

| our term | what it is here | the official term it is NOT |
|---|---|---|
| **worker** | a separate OS process running `claude --print` once per card, with its own session, reporting only through the board's HTTP API | **not** a *subagent* — a subagent is started by the Task tool from inside a session and reports back into it. Our workers are started by a supervisor, never by another agent; they cannot see or address each other, and a card is their entire scope |
| **座席 seat** | a deployment-level declaration `{runtime, model, effort, window}` describing *what to start*, resolved before any process exists | **not** an *agent definition* (`--agents`, `.claude/agents/*.md`) — that names a role inside a running session; a seat names a way to start one |
| **线 line** | a resident loop that claims cards on a route, one card at a time, restarted by the supervisor | no official counterpart; the closest CLI idea is "a shell that keeps invoking claude", which is what it is |
| **协调席 coordinator seat** | the human-attended session that rules on deliveries and operates the board | no official counterpart; it is a *seat* in our sense, occupied interactively |
| **档位 rung** | a `(model, effort)` pair on the escalation ladder | `--effort` is only one of its two axes; a rung also names the model |
| **skill** | `.claude/skills/*` read by *your* Claude Code | this one **is** the official mechanism, used as documented — no divergence |
| **session** | `--session-id` / `--resume` / `--fork-session` as the CLI defines them | also official, used as documented |

The asymmetry is deliberate: where Claude Code already has a word for something,
we use its word and its spelling. Our own words exist only for things above the
CLI — process supervision, routing, rulings — which the CLI has no opinion about.

## Freeze caveats

1. Status and waiting_for labels are **deliberate dual copies** (panel + CLI);
   change both or the wording drifts between surfaces.
2. The `release` event kind is one kind with `detail.action` as the load-bearing
   discriminator — the action values are part of the freeze.
3. The `decision_sql_*` column names are historic; they stay frozen as-is even
   though their content is generalized beyond SQL.
