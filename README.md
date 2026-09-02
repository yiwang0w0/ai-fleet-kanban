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

## Status

**v0.2.2.** Extracted, file by file and with a full sanitization audit, from the production deployment where these mechanisms were built and battle-tested. The board, both loops, the gates and all nine harnesses (570+ machine assertions) run here; CI is green on Linux and Windows; the full cycle — claim → deliver → auto-review → **your** ruling — walks end to end on a fresh clone: [`docs/QUICKSTART.md`](docs/QUICKSTART.md).

v0.2's theme is **ruling authority made structural**, driven by a live incident (INCIDENT-12: an agent self-approved its own card): three capability tokens (operator / worker / reviewer), a closed `resolved_by` domain, and the auto-reviewer — per-card fresh sessions, verify-first, and a machine-evidence gate that turns "approve with zero machine output" into a human decision. The 0.1.x line added bundled operator skills, the worker-repo constraint template, a fail-closed deliverable gate, landed-bytes handoff receipts, and cold-walkthrough fixes.

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
examples/  fleet config · mock runtime adapter · demo seeds · worker-constraints template (the anti-overengineering scope gate)
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
