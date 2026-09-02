# AI Fleet Kanban

**The acceptance-first kanban for mixed AI fleets.**

Every open-source agent board on the market solves the same problem: *how to make a fleet of coding agents run*. This one solves the opposite problem, distilled from three weeks of running a high-autonomy mixed fleet (Claude + Codex) against a production codebase: **how not to trust what they say they finished.**

- **Deliverable-existence gate** — evidence must name files, and the named files must exist in `HEAD`. Prose doesn't close cards.
- **Fail-closed source gate** — the fleet refuses to run its own unreviewed code. A dirty governance subtree stops line startup, loudly.
- **Adjudication authority chain** — a machine reviewer's note never constitutes human approval. Impersonating authority is a caught, named failure mode.
- **Human gate + handoff boundary** — cards awaiting a human decision never enqueue (zero attempts burn), and hand-applied deliverables land only in operator-authorized directories, with an execution receipt. Irreversible acts stay human.
- **Read-only probe runner** (standalone tool, not wired into the board) — production verification through a forced read-only, single-statement, self-checked channel. `Success. No rows returned` is not proof of an apply.
- **Per-attempt usage ledger** — every model call accounted, per card, per attempt.
- **The coordinator seat** — an LLM session sits in the ops chair: it diagnoses gate refusals, accepts and blesses deliveries, revives dead lines, and upgrades incidents into governance improvements. The system gets better *while being operated*.

Each gate exists because a real incident demanded it. The docs open with incident anatomies, not feature lists.

## Status

**v0.1.0.** Extracted, file by file and with a full sanitization audit, from the production deployment where these mechanisms were built and battle-tested. The board, the worker loop, the gates and all eight harnesses (500+ machine assertions) run here; CI is green on Linux and Windows; the full cycle — claim → deliver → **your** ruling — walks end to end on a fresh clone: [`docs/QUICKSTART.md`](docs/QUICKSTART.md).

This release ships the core board AND the governance gates together — a gateless launcher was never an option.

## Layout

```
core/      store (SQLite state machine + gates), server (REST+SSE), panel (single-file UI)
loops/     worker loop (reviewer loop ships post-v0.1, per ruling R1)
gates/     fail-closed source gate, deliverable-existence gate
probe/     read-only production probe runner (standalone tool)
cli/       board.py (the sanctioned entry; no raw curl) · doctor · init
watchers/  the two sentries (SSE event watch · board health watch)
tests/     six harnesses (two more run as python selftests) — 500+ machine assertions across all eight; the CI is the product's spine
docs/      QUICKSTART · OPERATE_WITH_CLAUDE · GLOSSARY (frozen vocabulary) · INCIDENTS (the scar manual)
examples/  fleet config · mock runtime adapter · demo seeds
.claude/   skills auto-discovered by YOUR Claude Code (add a line · context window · pool/quota) — guardrails over existing entries, never new code
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
