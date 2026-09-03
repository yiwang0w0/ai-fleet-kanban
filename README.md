# AI Fleet Kanban

[![CI](https://github.com/yiwang0w0/ai-fleet-kanban/actions/workflows/ci.yml/badge.svg)](https://github.com/yiwang0w0/ai-fleet-kanban/actions/workflows/ci.yml)

**The acceptance-first kanban for mixed AI fleets.**

Most agent boards solve *how to make a fleet of coding agents run*. This one solves the opposite problem, distilled from weeks of running a high-autonomy mixed fleet (Claude + Codex) against a production codebase: **how not to trust what they say they finished.**

- **Deliverable-existence gate** — evidence must name files, and the named files must exist in `HEAD`. Prose doesn't close cards.
- **Fail-closed source gate** — the fleet refuses to run its own unreviewed code. A dirty governance subtree stops line startup, loudly.
- **Adjudication authority chain** — a machine reviewer's note never constitutes human approval, and since v0.2 that is structural: three capability tokens (operator / worker / reviewer) and a closed `resolved_by` domain. A worker cannot close, re-scope or approve anything — including its own card. Impersonating authority is a caught, named failure mode (INCIDENT-12 is the live specimen).
- **Auto-review that cannot rubber-stamp** — a per-card fresh-session reviewer (no Edit, no Bash) pre-runs the card's named verification, and a mechanical gate after the model means "approve with zero machine output" downgrades to a human decision instead of closing the card.
- **Human gate + handoff boundary** — cards awaiting a human decision never enqueue (zero attempts burn), and hand-applied deliverables land only in operator-authorized directories, with an execution receipt. Irreversible acts stay human.
- **Read-only probe runner** (standalone tool, not wired into the board) — production verification through a forced read-only, single-statement, self-checked channel. `Success. No rows returned` is not proof of an apply.
- **Per-attempt usage ledger** — every model call accounted, per card, per attempt.
- **The coordinator seat** — an LLM session sits in the ops chair: it diagnoses gate refusals, accepts and blesses deliveries, revives dead lines, and upgrades incidents into governance improvements. The system gets better *while being operated*.

Each gate exists because a real incident demanded it. The docs open with incident anatomies, not feature lists.

**Where this sits.** It drives the `claude` and `codex` command lines as ordinary
processes — one process per card, its own session, its own context window. It is
not built on the Claude Agent SDK and it is not Managed Agents; nothing here runs
inside another agent's session. That keeps the vocabulary honest: Claude Code's
own terms (`--effort`, `--permission-mode`, session ids) are used exactly as the
CLI defines them, and our words — line, seat, rung, coordinator seat — name only
the layer above it, which no CLI has an opinion about. A worker here is a separate
OS process, **not** a subagent. `docs/GLOSSARY.md` maps the two vocabularies, and
`node cli/doctor.mjs` checks the flags we pass against the CLI you actually have.

## Status

**v0.10.3.** Extracted, file by file and with a full sanitization audit, from the production deployment where these mechanisms were built and battle-tested. The board, both loops, the gates and all nine harnesses (620+ machine assertions) run here; CI is green on Linux and Windows; the full cycle — claim → deliver → auto-review → **your** ruling — walks end to end on a fresh clone: [`docs/QUICKSTART.md`](docs/QUICKSTART.md).

v0.10.1 aligns the vocabulary with Claude Code's own: every flag the loops pass is now checked by `doctor` against the real `claude --help` on your machine — the one contract no harness can test, since every harness drives a stub and a stub accepts a flag that was renamed last week. All eleven match today, and the check catches a rename (verified against a CLI that spells `--allowedTools` the other way). `docs/GLOSSARY.md` gains the mapping between the two vocabularies, including the terms that look official and are not: a worker here is a separate OS process, **not** a subagent. v0.10 adds a line-level circuit breaker, the one guard the per-card budget could not give: park a card, claim the next, burn that one too — when the cause is systemic (CLI gone, repo broken, verifier dead) the whole queue is spent learning one fact. Three cards in a row failing with the SAME fingerprint now stops the line with exit 3, so the supervisor does not restart it and the health sentry reports it as a line that wants to run and is not. The criterion is "failing the same way", not "failing" — the first cut used the latter and correctly tripped on a harness whose job is to manufacture varied failures. v0.9.1 puts a budget on the card face after measuring what was actually there: a card's description and acceptance were never truncated, so pasting a log into a card grew the prompt until it approached the 32767-character argv ceiling. They now truncate loudly, saying how much was cut and how to read the rest. `--prompt-preview` reports the sizes, and it is why the layered-prompt rewrite this measurement was meant to justify was dropped instead: a typical prompt is ~900 characters, half of it the discipline every card needs, so externalising it would have traded nothing for a rule that might go unread. v0.9 closes the gap that made front-end cards unfinishable: a worker has no execution right, so a UI change could only be described, and the machine-evidence gate rightly refused it — the card burned a round on "trust me". `examples/verify_page.mjs` is the missing channel: registered as a verification KEY, run by the LOOP (never by the worker), it drives whatever Chrome or Edge is already installed over CDP — zero dependencies, since Node 22 ships WebSocket — and asserts against the rendered page, waiting for async renders, with console errors and a screenshot as evidence. v0.8 makes **upgrading visible**: `git pull` changes files, not the three live things that keep running the old ones — the gate's accepted revision, the server process, and the sentries (which now report their own revision, so the board can tell). The panel measures all three and shows a banner listing only what is left, each step a command rather than a button, and the footer always names the revision actually running. v0.7.1 fixes a reported defect that made a `codex` review seat unable to produce any verdict at all — one object in the reviewer output schema listed an optional key outside `required`, which strict structured outputs refuse outright, before the model runs (INCIDENTS-13). v0.7 makes the sentries **worth leaving on**: an alarm is stated once, then backs off (1, 2, 4, 8… rounds, each repeat carrying how long and how many times), restates immediately when the state changes, and reports recovery — an alarm system with no all-clear cannot be trusted, and one that repeats itself every round trains its reader to mute it (measured: a deployment asked for exactly that). The full-stop criterion now reads `desired_running`, so lines you stopped on purpose are not a fault; a board with claimable cards and nothing started is one gentle "nobody pressed start", not an incident. v0.6 is the **setup guide**: open the panel and a six-step walkthrough tells you exactly what to do next — one button where a button is honest (creating the config), a copyable command where the act must be yours (blessing the source gate is *you* accepting this tree; a one-click accept would defeat the gate it belongs to), and one press to hand a step to your coordinator seat. Every step is measured on each request rather than stored, so the guide walks backward too: delete the config, edit code without re-blessing, stop the sentry, and it reopens at that step; what it cannot measure reads `unknown`, never `done`. v0.5 added **shortcut buttons to your coordinator seat**: a panel row (draft lines from my recent sessions · mount the sentries · install the worker-repo constraints · enable auto-review · brief me) that writes a durable request and wakes the seat through its SSE sentry; the seat acks and dones through `board.py`, the panel shows the loop closing — and a request nobody picks up within five minutes is rendered as an alarm, because silence is not health. v0.4 is **panel autonomy**: lines are added from the panel (or `board.py lines add`) with no restart — persisted to the config first, registry rebuilt in place; cards worked outside auto-pull are tagged 板外在跑 on their face (a coordinator hand-running cards was a measured deployment pattern); two-press buttons reserve their armed width at rest; and `pool.changed` broadcasts only on change (it used to fire every reconcile tick and drown the SSE sentry — a deployment's issue). v0.3's theme was **deployment truth in one file**: `fleet.config.json` gains optional `port` / `repo` / `gated_subtree` keys read by the server and every client alike (env vars still override), retiring the two-shell env choreography that produced a measured incident class; CI reds now surface their FAIL lines as public annotations (v0.3.1); the second QUICKSTART shell now needs zero exports, the browser tab title carries the waiting-card count, and the health sentry anchors the board's own tree on split deployments. v0.2 made ruling authority structural (three capability tokens, closed `resolved_by` domain, the auto-reviewer with its machine-evidence gate — INCIDENT-12 is the live specimen). The 0.1.x line added bundled operator skills, the worker-repo constraint template, a fail-closed deliverable gate, landed-bytes handoff receipts, and cold-walkthrough fixes.

This release ships the core board AND the governance gates together — a gateless launcher was never an option.

## Layout

```
core/      store (SQLite state machine + gates), server (REST+SSE), panel (single-file UI)
loops/     worker loop · auto-reviewer loop (fresh session per card, machine-evidence gate)
gates/     fail-closed source gate, deliverable-existence gate
probe/     read-only production probe runner (standalone tool)
cli/       board.py (the sanctioned entry; no raw curl) · doctor · init
watchers/  the two sentries (SSE event watch · board health watch)
tests/     seven harnesses (two more run as python selftests) — 570+ machine assertions across all nine; the CI is the product's spine
docs/      QUICKSTART · OPERATE_WITH_CLAUDE · GLOSSARY (frozen vocabulary) · INCIDENTS (the scar manual)
examples/  fleet config · verify registry · mock runtime adapter · demo seeds · page verifier (CDP, zero-dep) · worker-constraints template
.claude/   skills auto-discovered by YOUR Claude Code (coordinator seat · add/propose lines · context window · pool/quota) — guardrails over existing entries, never new code
```

## Try it

```
git clone https://github.com/yiwang0w0/ai-fleet-kanban && cd ai-fleet-kanban
node cli/doctor.mjs        # preflight: everything measured, every red line carries its fix
```

Then walk [`docs/QUICKSTART.md`](docs/QUICKSTART.md) — board up, demo seeded, a
mock adapter (zero tokens) or your real local CLI through the full cycle:
claim → deliver → **your** ruling. The conversational way to operate it lives in
[`docs/OPERATE_WITH_CLAUDE.md`](docs/OPERATE_WITH_CLAUDE.md).

## License

Apache-2.0. See `LICENSE` and `NOTICE`.

## A note on language

The docs you are reading are English; the RUNTIME speaks Chinese — panel labels,
doctor output, refusal texts. That is the deployment this was battle-tested in,
and honest wording beat rushed translation for v0.1. The machine contracts (JSON
keys, status values, env names, exit codes) are English and frozen
(`docs/GLOSSARY.md`, with the Chinese display terms glossed). i18n of the display
layer is on the roadmap; the English corpus for it already exists.
