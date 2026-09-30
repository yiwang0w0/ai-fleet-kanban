# GLOSSARY — machine terms frozen since v0.1 (operator ruling R2, 2026-09-02)

The freeze rule: **renaming any `machine` term below is a breaking change** from
v0.1 on — these are wire values, JSON keys, table/column names, env names and exit
codes that other people's configs, scripts and stored databases will depend on.
`display` wordings (Chinese UI strings) may evolve, but each must keep the same
referent — never reuse a listed word for a different concept.

The original entries describe their named release. Additive contracts for the
unreleased 0.24 development line are recorded below with owning objects and
implementation links; they do not rename the frozen originals. Status/waiting
labels have one source since v0.14.1. Migration is documented in
[federation/migration-0.24.md](federation/migration-0.24.md).

## Status machine

| term | layer | meaning |
|---|---|---|
| `not_started` / `in_progress` / `waiting` / `done` | machine | the four task statuses — there is no fifth; "blocked" is not a status |
| 未开始 / 进行中 / 等待中 / 已完成 | display | their Chinese labels — **one copy**, `STATUS_LABEL` in `core/store.js`, served on `GET /api/meta`; the panel columns and `cli/board.py` read it from there and keep none (v0.14.1; before that, two hand-written copies) |
| `waiting_for` = `review` / `confirm` / `decision` / `dep` / `rearm` | machine | why a card waits: delivered–unreviewed / options need a human / worker exhausted attempts / dependency / parked until children finish |
| 待验收 / 待确认 / 待裁定 / 待依赖 / 等待重审 | display | their labels — **one copy**, `WF_LABEL` in `core/store.js`, served on `GET /api/meta` (v0.14.1) |
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
| setup step `key` = `board` / `config` / `lines` / `bless` (v0.18 dropped `sentry` / `cycle`; the payload carries `sentries` as a count; a done step may carry `drift:true` + an action; an `api` action may carry `confirm` (text the panel asks first) and `body`); `state` = `done` / `todo` / `blocked` / `unknown` | machine | v0.6 setup guide (`GET /api/setup`). Every state is MEASURED per request, never stored — the guide walks backward as readily as forward. `unknown` (could not measure) is never folded into `done` |
| `?as=sentry` on `/api/events` | machine | an SSE client declaring itself a sentry, so "is the coordinator seat listening" is measurable. A panel tab is not a sentry; an unmarked client does not count as one |
| `line_labels` / `line_accept` on `GET /api/workers` and `POST /api/config/lines` (`{id, hint?, label?, accept?}`) | machine | v0.21: id → display name / id → `human`\|`auto`. Ids remain the contract; labels are display only |
| `lines[].role` = `{kind, tools, charter?, seat?}` · `kind` = `implement` / `review` · `tools` = `write` / `read-only` · `line_roles` / `impl_lines` on `GET /api/workers` and `POST /api/config/lines` (`{…, role?}`) · `role` / `seat_drift` per worker | machine | v0.22 line identity. Closed domains (unknown refuses: 400 on the API, startup refusal from the config). `charter` = a `.md` relative to the **board** repo, inside the gated subtree (the source gate pins it). `seat` = first-start `agents[0]`; `seat_drift` = the effective seat differs from it. `impl_lines` = the lines the decomposer may name; a review line named by the model demotes to null like a typo |
| `WORKER_ROLE_KIND` / `WORKER_TOOL_PROFILE` / `WORKER_CHARTER` | machine | v0.22: the identity, handed to the slot by `slotEnv` (absent = `implement` / `write` / none — a plain line is byte-identical to v0.21). The loop refuses (exit 3) an out-of-domain value, a missing charter, or a charter outside the gated subtree |
| `review.anti_affinity` = `runtime` (fleet config) · `?runtime=` + `held[]` / `anti_affinity` / `reviewer_runtime` on `GET /api/review/pending` · `review_hold` = `same_family` on a card · `review_lines` / `review_anti_affinity` on `GET /api/workers` · `REVIEWER_ANTI_AFFINITY` | machine | v0.23 auto-review anti-affinity: the reviewer never judges a delivery made by its own runtime family (`last_runtime`); such cards are listed as `held`, never dropped, and stay in 待验收 for a human or another family. Closed domain (only `runtime`; anything else refuses startup). Unknown author (no `last_runtime`) is never held |
| `POST /api/goals/:id/pipeline` `{line?}` → 201 `{goal, line, task}` · `POST /api/goals/:id/decompose` `{model?, force?}` → 409 `{needs_force, pending_review[], hint}` · `add` event actor `decompose(forced)` | machine | v0.23 pipeline: the plan-review card (one child on a review-kind line; 409 while one is still open, 409 when no review line exists, 400 for a non-review line) and the decompose gate (refuses while a review child is not done; `force` passes and the children's history says so) |
| 待异族审阅 · 起评审卡 · 强制拆解 | display | `review_hold=same_family` badge · the goal card's pipeline button · the decompose gate's confirm |
| 实现 / 评审 · 只读 · 章程 · ⚠偏离身份座席 | display | the identity words on the rig, the add-line form and the startup line — `implement` / `review` · `read-only` · `charter` · `seat_drift` |
| panel verbs 通过 / 打回 (delivery) · 同意 / 否决 (question, `waiting_for=decision`) | display | v0.21 operator ruling: the button names the human act; the API verdicts stay `approve` / `reject`. 「结案」 left the operator's path (it survives only as the ledger term 联动结案) |
| `POST /api/setup/bless` `{confirm_tree}` · `POST /api/setup/restart` `{force?}` · `POST /api/upgrade/apply` `{confirm_tree, force?}` | machine | v0.18 panel buttons (operator token). `confirm_tree` = the tree hash the human was shown; a mismatch with `HEAD:<gated_subtree>` is 409 — what you saw is what you accept. restart/apply refuse with 409 `{in_progress, needs_force, hint}` while cards are in flight unless `force`; 202 body = `{restarting, mode, from, to, lines:{stop,resume}, log_path, accepted}` |
| `board.restarting` · `code.accepted` · `sentry.stale` | machine | v0.18 SSE events: the board is about to restart (the panel holds and reloads when the new revision answers) · the gate's record moved (`tree`, `prev`, `by`) · sent on connect to a sentry whose `rev` differs from the board's (a v0.18+ `sse_watch.py` re-runs itself once on it) |
| `BOARD_RESTART_MODE` = `exit` / `respawn`; `BOARD_SUPERVISED`; `BOARD_RESTARTED_FROM` | machine | how the board comes back after a panel restart: `exit` = code 75 for whoever started it — `npm start` (`cli/start.mjs`, which sets `BOARD_SUPERVISED=1` and relaunches in the same terminal), pm2 (`pm_id`), systemd (`INVOCATION_ID`); `respawn` (bare `node core/server.mjs`) = the running process starts a DETACHED successor (a non-detached child dies with its parent on Windows) logging to `<data>/board.log`. The successor sees `BOARD_RESTARTED_FROM` and retries the port briefly. `SSE_WATCH_REEXECED` / `BOARD_HEALTH_REEXECED` are the sentries' own once-only markers |
| `attempts` / `attempts_base` / `attempts_this_claim` / `max_attempts` | machine | lifetime total / anchor re-stamped at claim / this dispatch / per-dispatch budget |
| `lock_key` / `oneof_key` (备选组) / `proves_parent` (验证父卡) / `blocked_by` | machine | mutual exclusion / any-one-passes group / child's pass closes parent / dependency ids |
| `verify_cmd` | machine | a verify-registry **key**, never a command string |
| `prev_line` | machine | provenance: the immediately previous line; never a claim criterion |
| `dispatch_fp` / `dispatch_fp_at` | machine | v0.11 no-progress brake: the state fingerprint recorded at the LAST claim, as JSON of six components (`card` `deps` `ruling` `tree` `fail` `extra`), and when. The next claim recomputes and compares — identical means this dispatch would see the world the last one already saw, so the card is not handed out. Recorded at claim (not at report), which is what makes it cover the bounce loop as well as the park loop. Cleared by reap / release / reopen — a dispatch that never reported back made no judgment worth honoring |
| `review_fp` | machine | v0.11.2 review-side twin: which deliverable the auto-reviewer last judged, as a hash of delivery text + acceptance + machine result. `pendingReview` skips a card whose deliverable fingerprint is unchanged — `auto_review_at < updated_at` answers "has the card moved", not "is there anything new to judge". Cleared by any path that deliberately sends a card back (a ruling into the review queue, children finishing); a card never reviewed always passes. ⚠ A hand-back to `not_started` does NOT clear it: if the worker then delivers a byte-identical result, the auto-reviewer stays out and the card sits in 待验收 for a human. That is deliberate — re-judging an identical deliverable reaches the identical verdict — and the card is visible the whole time, not lost |
| `last_note` | machine | what the last ruling said, verbatim and alone. `verdict_note` is append-only with a timestamped header per entry, so its full text differs on every ruling even when the ruling repeats itself word for word — a brake reading it never engages |
| `no_progress` (API field) | machine | non-null when the brake is currently holding a card: `{since, fp}`. Computed by the same function claim uses; the panel never decides this for itself |
| `force` (claim-by-id parameter) | machine | the operator override — "run it anyway" is a reason, unlike a timer firing. Honored only for the operator token, and recorded in the history as `forced:true` so it is distinguishable from "ran because something changed" |
| `expect_updated_at` (autoreview body) | machine | v0.16.0: the `updated_at` the reviewer saw when it fetched the card. `markAutoReviewed` refuses (409) when the card is no longer a reviewable waiting card, or when this value is given and no longer matches — a late verdict never overwrites a human ruling or lands on a re-delivery. Absent = status gate only (old reviewers keep working) |
| `MAX_LEASE_MIN` = 1440 | machine | v0.16.0 lease cap; `lease_minutes` is clamped to a finite positive number ≤ this (Infinity used to make a card unreclaimable) |
| `fp_changed` (claim event detail) | machine | which fingerprint components differ from the previous dispatch = **why this run was allowed**. Absent on a first dispatch: "nothing to compare" and "nothing changed" must not read alike |

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
| error codes `NOT_FOUND` `CONFLICT` `BAD_INPUT` `INTERNAL` → 404/409/400/500 | machine | the original board error taxonomy; unclassified falls to 400 `typed:false`. Peer/broker protocols have additional typed errors (see their qualified contracts below) |

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

`fingerprint_extra_cmd` (optional; an **argv array** (no shell, v0.16.1) or a command string (shell; warns once at startup) whose first stdout line joins the
no-progress fingerprint — the hook a deployment uses for state this repo has no
concept of, e.g. a script checksum or a target environment. Failure is reported and
the component reads as absent, never as "nothing ever changes") ·
`lines[]{id,hint,label?,accept?,role?}` (`label` = display name, `accept` = `human` default / `auto` = deliveries complete on report through the same close gates; v0.21; `role` = the line identity `{kind,tools,charter?,seat?}`, v0.22 — see the status table) · `roles[]` (`review` only — reorg retired by ruling 2026-09-02, before the freeze bound it; joins only when its loop script
exists) · `routes[]` · `max_parallel` · `default_agent{runtime,model,effort,window}` ·
`runtimes[]` (seat declarations `{id,label,models,efforts,release_env,cmd_env}` —
code branches on the declaration, never the seat id) · `decompose_models[]` ·
`ladder[{model,effort}]` (precedence: env `WORKER_LADDER` > config > built-in) ·
`language` (generated-card text; null = mirror) · `handoff_targets[]`. All machine.

## Env contract

Operator-facing: `BOARD_DATA_DIR` `BOARD_DB` `BOARD_HOST` `BOARD_PORT` `BOARD_URL`
`BOARD_REPO` `BOARD_CONFIG` `BOARD_DEFAULT_ROUTE` `BOARD_HANDOFF_DIR` `BOARD_UNTIL`
`BOARD_NO_RESTORE` `BOARD_RESTART_MODE` `BOARD_SUPERVISED` `BOARD_PYTHON` `BOARD_CRASH_BACKOFF_MS` `BOARD_REAP_MS`
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
`WORKER_RATE_MAX_WAITS` `WORKER_MAX_BUDGET_USD` `WORKER_VERIFY_SEC`
`WORKER_ROLE_KIND` `WORKER_TOOL_PROFILE` `WORKER_CHARTER` `WORKER_CHARTER_MAX_CHARS`.

Test-only escape hatches (never production defaults): `BOARD_ALLOW_UNPINNED`
`WORKER_ALLOW_BATCH_CLI` `WORKER_CLI_ARGV` `BOARD_POOL_TEST_MODE`
`BOARD_POOL_TEST_PROBE` `BOARD_SPAWN_ECHO` `BOARD_TEST_SHUTDOWN_MS`
`BOARD_CLAUDE_PROJECTS` (points the transcript lookup away from the operator's real
`~/.claude/projects`; a harness must never plant files there).

## Operations vocabulary (display; the concepts behind the Chinese UI)

线 line (claim-routing unit) · 卡/任务卡 card · 目标 goal · 链/任务链 chain ·
放行 release (未放行 = held) · 认领/领卡 claim · 交付 deliver · 裁定 ruling ·
打回 bounce · 结案 close (无需后续 · 结案 = final close) · 派生 spawn/derive ·
上浮 uplift (over-deep card re-hung under the chain root, unreleased) ·
联动结案/联动关闭 linked closure · 心跳 heartbeat · 租约 lease · 座席 seat ·
阶梯/档位 ladder/rung · 手交区 handoff target · 两哨 the two sentries(UI 对操作者说「通知进程」;机器名 sentry 不变)
(sse_watch + board_health_watch) · 正史 the immutable record (task_events).

Note: 收起 in the panel means **fold/collapse a UI section**, not "hold a card" —
holding displays as 未放行 / 收进协调待机区. Do not reuse 收起 for holds.

## 中文正名表 (display-wording normalization — executed 2026-09-07, v0.13.0)

One concept, one Chinese word. Machine values, JSON keys, event kinds and env names are
untouched (the freeze rule above); this pins the DISPLAY / prose layer. Counts are what
`grep` found on this tree at v0.12.1 across `core/ loops/ cli/ watchers/ examples/` —
**lines, tests excluded**. (The draft this was built from counted one file,
`loops/worker_loop.py`, and labelled the numbers repo-wide; those are superseded.)
After v0.13.0 every banned variant below greps to zero in those directories.

### A. 一词多译 → 正名

| 概念 | 正名 | 弃用变体(v0.12.1 实测) | 备注 |
|---|---|---|---|
| 上下文压缩 (`compact`) | **压缩** | 折叠(源 17 行,其中 2 行是运行期日志)· 整理(18 行,其中 `panel.html` 6 行是按钮 / alert 文案 —— 曝光最高的一组)· 「已压缩」1 处 | 三译都曾用户可见。`/compact` 作命令名时保留英文 |
| 卡 (`card`) | **卡 #N** | 任务 N(`store.js` 21 行报错 · `server.mjs` 2 行 · worker 提示词 1 行 · 「无可领任务」3 行 · `board.py` 1 行) | 任务卡 / 任务链 / 子任务卡 是合法复合词,不动 |
| 起跑档 (`weight`) | **起跑档(weight)** | 强度权重(`server.mjs` 1 行) | ⚠ **强度 = effort**(CLI 的 `--effort`;面板 / 座席文案一律「强度」,保留)。**档位 = rung**(一格 = model × effort)。三者不互借 |
| 转人工 (`escalate` verdict) | **转人工(escalate)** | 散文里裸写 escalate | 首次出现带英文原词;落点状态显示仍是 待确认(冻结) |
| 回收 (`reap`) | **回收(至未开始)** | 收回(`server.mjs` 6 行 · `panel.html` 1 行 · worker 3 行 · `store.js` 2 行) | 租约 reaper 与 `releaseHeldBy` 是同一迁移,共用同一动词 |
| 回流三路 | **打回** = reject·bounce(冻结)· **退回原线** = hand_back(按钮 回原线继续 已冻结)· **送回重审** = rearm | 回投(`worker_loop.py` 5 行) | 三个动词对三条路径,不互借。⚠「退回」另有「降级回退」义(`decision_lib.js` / `worker_loop.py` 的 fallback 句)—— 那些不是回流,不动 |
| 冷却窗 (pool hold window) | **冷却窗** | 保持窗(`server.mjs` 1 行) | `POOL_HOLD_MS` 机器名不动 |
| 显式 (`loud`) | **显式**(报错 / 记录 / 失败) | 中文句子里夹 loud(worker 8 行 · verify / context / codex 各 1 行) | 英文注释里的 loud 不动 |
| UI 收起 | **收起**(冻结) | 折叠(`panel.html` 2 行:点击折叠 / 点组行折叠) | 与 compact 旧译「折叠」视觉相撞,一并消除 |
| 归并(fold-reduce) | **归并** | 折叠(worker 3 行:异常折叠 / 路径折叠 / 折叠到那边;`servertest` 2 个测试名) | 与 compact 无关的第三个「折叠」义 |
| 复位(backoff ladder reset) | **复位** | 梯子已折叠(`server.mjs` 1 行) | 第四个「折叠」义;崩溃退避梯归零 |

### B. 日语残留 → 中文

| 现状(v0.12.1 实测) | 正名 |
|---|---|
| `loops/reviewer_loop.py` 67 行日语注释 / docstring(含 を・が・の・で・ない・為 等接续词;26 行含 審 / 機械 / 此処 / 其の) | 逐行改写为简体中文;同文件 機械 / 机械、審阅 / 审阅 两种字体归一。**其中 2 行是运行期日志**(`締切=無し` / `を過ぎた`),优先级最高 |
| 締切(3 行) | 截止 |
| 素起 / 素的 / 素通(worker 4 行 · reviewer 2 行) | 裸起 / 原样 / 直通 |
| 一枚(1 行) | 一张 |
| ・ U+30FB(`worker_loop.py` 24 行) | 、 U+3001。⚠ `worker_loop.py` 里 `re.sub(r"[…·・…]")` 的字符类同时收 · 与 ・ 是有意的归一化范围,**不动** |
| 座席 | **保留**(已冻结;中文可用) |

Detection rule used: any hiragana / katakana letter (`[ぁ-ゖァ-ー]`) is Japanese — Chinese
never uses them — plus the Japanese-only kanji forms above. That regex is what proved
zero residue, not a list of particles (the particle list missed a line; the class did not).

### C. 保留不译(在中文句子里就用英文)

worker · fork · resume · bless · compact(作命令 / 参数名)· SSE · CLI · HEAD · WAL ·
argv · token(仅 header / env 名;概念用 **令牌**)· prompt(仅 argv 里那段;概念用
**提示词**)· escalate(作机器判决值)。

### D. 相近而不许互借

- **验收**(acceptance,标准)≠ **验证**(verify,机器执行)≠ **核对**(审阅的 checked)
- **审阅**(自动审阅)≠ **重审**(子卡齐后送回)≠ **复核**(confirm 执行后的人工复查)
- **放行**(release 一张卡)≠ **解禁**(codex 座席的 `release_env`)≠ **开闸**(人工闸解除)
- **回收**(reap)≠ **归档**(archive)
- **起跑档**(weight)≠ **档位**(rung)≠ **强度**(effort)≠ **轮**(派发轮)≠ **次**(attempt)
- **静默**(silently)为正名;**沉默截断**是固定术语(`reviewer_loop.py` 注明「沉默截断曾是实害」),不并入
- 指纹家族:**状态指纹** `dispatch_fp` · **交付指纹** `review_fp` · **失败指纹**(loop 侧)

### E. 标点与语域

- 简体为准;引号统一「」;枚举用 、;· 仅存于冻结文案(无需后续 · 结案)和英文段。
- 中文句子用全角标点;代码、值、路径保持半角。
- 用户可见文案(报错、日志、自动生成的卡面文本)写完整句;比喻只活在注释里。
- 英文词不夹进中文句子 —— 查 B、C 两表。

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
-p/--print  --model  --effort  --permission-mode  --allowedTools  --disallowedTools
--add-dir  --output-format  --resume  --session-id  --fork-session  --max-budget-usd
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
| **worker** | a separate OS process running `claude -p` once per card, with its own session, reporting only through the board's HTTP API | **not** a *subagent* — a subagent is started by the Task tool from inside a session and reports back into it. Our workers are started by a supervisor, never by another agent; they cannot see or address each other, and a card is their entire scope |
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

1. Status and waiting_for labels were **deliberate dual copies** (panel + CLI) until
   v0.14.1; they now have one copy in `core/store.js`, served on `GET /api/meta`.
   A surface that wants them reads the endpoint — do not write a table again.
2. The `release` event kind is one kind with `detail.action` as the load-bearing
   discriminator — the action values are part of the freeze.
3. The `decision_sql_*` column names are historic; they stay frozen as-is even
   though their content is generalized beyond SQL.

面板视觉(颜色/字号/间距/圆角/焦点规则)的单一来源是 [`style-guide.md`](style-guide.md);CSS 只引用 token,不散写数值。

## Federation contracts (0.24 development)

These are implemented machine terms in `0.24.0-dev.1`, not physical fleet or
provider acceptance claims. The [migration guide](federation/migration-0.24.md)
covers intentional incompatibilities. Component schema numbers, package version,
worker protocol, peer protocol and MCP protocol versions are independent.

### Role domains: qualify the containing object

| qualified term | allowed values / meaning | source |
|---|---|---|
| `fleet.config.json: lines[].role.kind` | `implement` / `review`; legacy line identity, still the original closed domain | `core/server.mjs` line-role validation |
| `fleet.config.json: lines[].role.tools` | `write` / `read-only`; legacy loop tool profile | `core/server.mjs`, `loops/worker_loop.py` |
| `broker_roles.policy_json.kind` (role registration JSON `kind`) | `coordinate` / `implement` / `review` / `observe`; local MCP broker policy, not a line-role extension | `core/mcp/policy.mjs: ROLE_KINDS` |
| broker policy `role_id / projects / enabled / priority / limits` | registered role identity, project allowlist, availability, deterministic selection priority and local limits | [MCP](federation/mcp.md) |
| broker policy `runtime / model / effort` | execution roles declare `claude` / `codex` / `zcode` and explicit model/effort; non-execution roles use null | `rolePolicy` |
| broker policy `tools` | `read-only` / `write`; review/observe must be read-only; not an OS ACL proof | `rolePolicy` |
| broker policy `capabilities` | supported profiles `board-tools` / `workspace-files`; implement/review selects exactly one, never an arbitrary skill or shell permission | `EXECUTION_CAPABILITIES`, [adapters](federation/adapters.md) |
| broker `version / policy_digest` | stored policy version and canonical digest; registration updates require the observed version and invalidate old principals/dispatches | `getRole / putRole` |

Both objects serialize a key named `kind`. They are separate qualified domains;
there is no automatic conversion, union, or privilege upgrade between them.
Unknown or damaged stored broker policies fail validation; local `mcp-admin roles`
reports the version for an explicit administrator repair.

### Identity, task versions and runs

| machine term | meaning / boundary | source |
|---|---|---|
| `board_node.node_id`, `display_name`, `sync_epoch` | stable node UUID, renameable display label, durable recovery generation; same display names do not merge identities | [identity](federation/identity.md), [recovery](federation/recovery.md) |
| `BOARD_NODE_NAME` | first-initialization display name only; later env changes do not rename stored identity | `core/store.js` |
| `task_uid` | `<node_id>/<task_uuid>`; global task identity; existing local numeric `id` remains local | `core/store.js` |
| `owner_node_id` | immutable owner of the local task; not inferred from current hostname, worker or connection | `core/store.js` |
| `aggregate_version` / HTTP `expected_version` / CLI `--version` | stored semantic task version / the caller's observed version; stale control writes refuse, values may jump | [versions](federation/versions.md) |
| `worker_protocol_version` | board worker write protocol, currently 2; worker-token claim requires it | [runs](federation/runs.md) |
| `agent_instance_id` | per-process lowercase UUID v4 required for worker-token claims; not proof of a trusted process | `core/store.js: UUID_RE` |
| `run_id`, `task_runs` | one claim's execution identity and immutable identity/policy history; attempts within that claim retain the run | [runs](federation/runs.md) |
| `parent_run_id` | worker-created child must bind to its original active parent execution | `core/server.mjs` |
| `executor_node_id / worker / role_id / runtime` on a run | execution-node identity, worker slot, role and declared runtime; distinct from owner | `core/store.js` |
| run `policy_json / policy_sha256` | claim-time policy snapshot and digest; legacy `enforcement: unattested` is not an isolation attestation | [runs](federation/runs.md) |
| `tree_mode` | `legacy` / `hierarchical`; existing two-level creation or explicit multi-level tree, no silent conversion | [trees](federation/trees.md), `core/task_tree.js` |
| `parent_uid` | global parent reference in shared projections/topology; separate from legacy local numeric parent ID | [topology](federation/topology.md) |
| `board_restore_hold`, `.incomplete` | quarantined backup/restore or unfinished filesystem work; migration success does not authorize activation | [backup](federation/backup.md) |

### Peer authentication, replication and recovery

| machine term | meaning / boundary | source |
|---|---|---|
| `peer_node_id / peer_epoch / credential_version` | credential-bound caller identity, generation and local grant version | [peers](federation/peers.md), `core/federation/peers.mjs` |
| peer `scopes / projects`, `Authorization: Bearer` | receiver-issued scoped access; separate from `X-Board-Token`; IP/name/forwarding headers never identify a peer | `core/federation/protocol.mjs: SCOPES` |
| hello `protocol.min / protocol.max / required_capabilities / required_extensions / extensions` | negotiated peer wire compatibility; optional extension data does not grant permissions | `core/federation/protocol.mjs: PROTOCOL / CAPABILITIES` |
| `origin_node_id / origin_epoch / project_id / seq` | stream identity and sequence, scoped by node + generation + project | [sync](federation/sync.md) |
| `event_id` | idempotent incoming event identity within its source node/epoch; another source cannot reserve it globally | `federation_inbox`, sync schema 4 |
| `federation_outbox / federation_deliveries` | durable outgoing projections and per-peer delivery/ACK state | `core/federation/sync-store.mjs` |
| `federation_inbox / federation_cursors / federation_replicas` | received events, durable progress and read-only remote tasks; never the local claim queue | `core/federation/sync-store.mjs` |
| replica `read_only / source_epoch / source_seq / received_at / last_sync_at` | provenance and last observed state, not a claim that the source is currently online | [sync](federation/sync.md) |
| `federation_quarantine` | rejected/inconsistent incoming data retained for diagnosis, not silently applied | `core/federation/sync-store.mjs` |
| `snapshot_id`, `federation_snapshots / federation_snapshot_staging` | frozen authorized projection and resumable staged replacement | [snapshots](federation/snapshots.md) |
| `federation_retention.floor_seq` | oldest available incremental history boundary; older receivers need approved snapshot recovery | [snapshots](federation/snapshots.md) |
| source epoch recovery | explicit reviewed cutover to a new generation, not a lower-sequence overwrite or automatic ownership transfer | [source-recovery](federation/source-recovery.md) |

Current peer protocol is 1. Supported capability values are `node-identity-v1`,
`peer-health-v1`, `task-projection-sync-v1`, `task-snapshot-v1`,
`source-epoch-recovery-v1`, `delegation-intents-v1`, `project-relations-v1`,
`delegation-bindings-v1`, `delegation-cancellation-v1`, `delegation-results-v1`,
`artifact-transfer-v1`, `delegation-completion-v1`. Required unknown values
refuse; supported capability names do not grant their corresponding scopes.

### MCP dispatch and execution

| machine term | meaning / boundary | source |
|---|---|---|
| `principal_id / node_epoch / role_version` | local broker credential principal, issuing node generation and frozen policy version | `core/mcp/policy.mjs` |
| principal `agent_instance_id / run_id` | execution credential is bound to one task execution, not just a role name | [MCP](federation/mcp.md) |
| MCP `request_id` | mutation UUID; same principal/id/tool/arguments returns the original receipt, changed content conflicts | `broker_requests` |
| `assignment_id` | deterministic route request; `waiting_executor` means selected but not launched | `broker_assignments` |
| `dispatch_id` | local prepared execution binding task, route, role, source code and quota | [dispatch](federation/dispatch.md) |
| dispatch `phase` | `prepared / launch_committed / settled / interrupted / abandoned`; status alone never authorizes another process launch | `core/execution/dispatch.mjs` |
| `quota_id / execution_mode / used` | local launch allowance; a committed launch consumes one even if process startup fails; not token or dollar usage | [dispatch](federation/dispatch.md) |
| `launch_permit` | returned only to the transaction that newly consumes the one-use launch permission; ordinary status returns false | `authorizeLaunch` |
| `launch_digest / observation_digest` | bound startup intent and verified terminal observation; neither substitutes for human acceptance | `broker_execution_records` |
| journal version 2 / dispatch schema 3 | per-launch local HMAC authenticates recovery observations; same-user access to its DB key remains a trust boundary | `core/execution/dispatch.mjs` |
| `real_model_call_confirmed` | reserved confirmation field currently returned as false; local process success does not confirm a real model call; unknown usage remains unknown | [execution](federation/execution.md) |

### Delegation, artifacts and completion

| machine term | meaning / boundary | source |
|---|---|---|
| `delegation_id`, outgoing/incoming intents | bilateral fixed task contract; recipient creates its own owned execution task, not a writeable copy of the source card | [delegation](federation/delegation.md) |
| `relation_graphs / relation_edges / relation_proposals / relation_approvals` | project registrar's versioned cross-node task graph and endpoint approvals | [relations](federation/relations.md) |
| `placement_pending` | local parent/dependency change awaiting matching registrar commitment | [topology](federation/topology.md) |
| `relation_id`, `delegation_bindings` | source/target endpoints tied to the accepted delegation and registrar relation | [bindings](federation/bindings.md) |
| cancellation request / stop receipt | durable intent to stop versus observed termination; receipt delivery alone does not prove a process stopped | [cancellation](federation/cancellation.md) |
| result candidate / rejection / rework | sealed delivery and source response; candidate arrival is not acceptance | [results](federation/results.md) |
| `repo_id / mapping_id / base_commit / object_format` | authorized local repository mapping and approved immutable Git baseline; SHA-1/SHA-256 IDs retain their format | [repositories](federation/repositories.md) |
| `pool_id / allow_full_history_copy` | independently registered task repository pool with explicit permission to copy full history | [workspaces](federation/workspaces.md) |
| `workspace_id / dispatch_id / write_paths` | one independent task checkout bound to one dispatch and approved path prefixes | `task_workspaces` |
| `workspace_sessions.workspace_id / revision` and file versions/digests | broker-mediated file access tied to a run; stale edits refuse | [workspace-files](federation/workspace-files.md) |
| artifact manifest / Git package / chunk / seal | content-addressed transfer, complete Git tree validation, resumable chunks and explicit final verification | [artifact-transfer](federation/artifact-transfer.md) |
| verification workspace / check receipt | independent source-side checks against bound candidate bytes, not a worker's self-reported pass | [verification](federation/verification.md) |
| integration / ref CAS | source update requires the recorded old Git ref and verified target commit | [integration](federation/integration.md) |
| completion contract / readiness / settlement | source acceptance, target readiness and registrar confirmation agree before local closing and parent re-review | [completion](federation/completion.md) |

Each linked contract names its own errors and bounds. Peer/broker errors such as
`UNAUTHENTICATED`, `FORBIDDEN`, `SCHEMA_INCOMPATIBLE`, `POLICY_INVALID` and
`REQUEST_CONFLICT` extend those surfaces; they do not make UUIDs into secrets or
turn failure into automatic retries. Full phase and real-provider evidence
remains in [PROGRESS](federation/PROGRESS.md).


### Peer failure accounting

`federation_auth_failure_schema` version 1 and `federation_auth_failures` are separate from credential grant/revoke events. Each bounded aggregate contains `key_id` (untrusted claimed UUID or null), `category` (`claimed_key / missing_or_malformed / overflow`), `failures`, `limited`, `first_at` and `last_at` (Unix milliseconds). HTTP `AUTH_RATE_LIMITED` is 429 with `Retry-After`; `AUTH_AUDIT_UNAVAILABLE` is 503 after a failed audit flush. Neither identifies an authenticated peer. Rate windows are local to a gateway process; retention and crash limits are defined in [peers.md](federation/peers.md).
