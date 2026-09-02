# QUICKSTART — a full cycle on a fresh clone

The goal of this page is ONE complete loop: a card gets claimed by an agent,
delivered with evidence, and closed by **your** ruling. First with a mock adapter
(zero tokens), then with your real local CLI. Every step is a command you can
paste; nothing here asks you to trust prose.

## 0 · What you need

- **node ≥ 22.5** (24+ recommended — the store runs on `node:sqlite`)
- **python 3** (the worker loop)
- **git** (the revision gate anchors on it)
- optional but the point: **a local agent CLI** (e.g. Claude Code) for the real run
- Windows PowerShell users: set `$env:PYTHONUTF8 = "1"` in each shell — pipes
  default to a legacy codepage and the harnesses print CJK

```
node cli/doctor.mjs
```

Doctor measures — requires the sqlite module, spawns the interpreter, binds the
port — and every red line carries its fix. Green or warn = proceed.

## 1 · (optional) name your fleet

Skip this and you get two built-in lines (`alpha`, `coord`). To define your own
lines and handoff directories:

```
node cli/init.mjs        # copies examples/fleet.config.json to the repo root
```

Edit `lines[]` and `handoff_targets[]` — or skip the editor entirely and tell
your Claude what your work looks like (see `docs/OPERATE_WITH_CLAUDE.md`).
The config is gitignored; it names YOUR directories and stays on your machine.

## 2 · Bless what you're about to run

The fleet **refuses to run unreviewed governance code** — that is the fail-closed
source gate, and on a standalone clone the governance code is the whole tree.
Blessing = recording "this exact tree is what I accept":

```bash
# bash / CI
export BOARD_GATED_SUBTREE=.
mkdir -p core/.data
git rev-parse "HEAD:" > core/.data/accepted_rev
```

```powershell
# PowerShell
$env:BOARD_GATED_SUBTREE = "."
New-Item -ItemType Directory -Force core\.data | Out-Null
git rev-parse "HEAD:" | Out-File -Encoding ascii core\.data\accepted_rev
```

Two things follow, both deliberate: **any local edit to tracked files stops line
startup** (exit 3, with the reason printed — that is the gate working, not a
crash), and after you commit a change you re-bless with the same one-liner.
Set `BOARD_GATED_SUBTREE` in the same shell that starts the server — worker
lines inherit it from there.

## 3 · Board up

```
node core/server.mjs
```

Open http://127.0.0.1:47824 — the panel is for your eyes; agents use the API.

**If doctor warned that 47824 is taken** (another board, or anything else):
pick a port and give it to BOTH sides — `BOARD_PORT` moves the server, and every
client command in this guide then needs the same value (they honour `BOARD_PORT`
too, or set `BOARD_URL=http://127.0.0.1:<port>` once). Moving only the server
sends your commands to whatever answers on the OLD port — on a shared machine
that can be somebody else's live board.

## 4 · Seed the demo and run the mock cycle (zero tokens)

In a second shell — and a NEW shell knows nothing your first shell exported, so
the gate env comes along (skipping it is a guaranteed refusal, exit 3):

```bash
export BOARD_GATED_SUBTREE=.        # the new shell needs it too
node examples/seed_demo.mjs
WORKER_CLI_ARGV='["python","examples/mock_worker_cli.py"]' \
  python loops/worker_loop.py --as alpha --once
```

```powershell
$env:BOARD_GATED_SUBTREE = "."      # the new shell needs it too
$env:PYTHONUTF8 = "1"               # Windows pipes default to a legacy codepage
node examples\seed_demo.mjs
$env:WORKER_CLI_ARGV = '["python","examples/mock_worker_cli.py"]'
python loops\worker_loop.py --as alpha --once
```

(The line name `alpha` is the built-in default; if you installed a config in
step 1, use YOUR first line — the seed prints the exact commands. If you moved
the board's port in step 3, these shells need the same `BOARD_PORT` too.)

The seed plants one goal and three cards (and refuses a board that already has
cards — demo data never mixes into real work). The `--once` run claims card #2,
the mock adapter writes evidence, the loop delivers it, and the card lands in
**等待中/待验收** on the panel.

## 5 · Rule on it — this part is yours

On the panel, open the waiting card and approve it **with an empty note**: it
closes (`done`). Ruling buttons are **two-press**: the first press arms (color
and caption change), the second press within ~4 seconds fires — wait longer and
it quietly disarms. No confirm() dialogs by design; a button that "did nothing"
was an armed button that timed out. The distinction that matters, worth trying once deliberately:

- **empty note + approve** = a clean pass → the card closes;
- **anything written + approve or reject** = an instruction → the card goes BACK
  to its line carrying your words, and the next claim reads them verbatim.
  A written-on card is never silently closed — someone must act on what you said.

Also try the third card: it is **human-gated**. No worker can ever claim it and
no attempts burn on it — governance stays with you, structurally.

## 6 · The real thing

Same cycle, your actual CLI (doctor already told you if it's resolvable):

```
python loops/worker_loop.py --as alpha --once
```

Or start supervised lines from the panel (自动拉取 row — start/stop per line,
model/effort per slot) and let the loop claim continuously. For unattended runs
add `--until 2026-01-01T23:00` or set `BOARD_UNTIL` on the server.

## 7 · Hand the whole thing to your Claude

The intended operating mode is conversational: your Claude runs the board, mounts
the two sentries (`watchers/`), defines lines by talking with you, and claims
cards itself. Four moves, one page: `docs/OPERATE_WITH_CLAUDE.md`.

## Kick the tires

The README's "500+ machine assertions" are not a brochure number — run them:

```
node tests/selftest.mjs && node tests/servertest.mjs && node tests/looptest.mjs
node tests/decisiontest.mjs && node tests/gatetest.mjs && node tests/decomposetest.mjs
python gates/gates_lib.py && python loops/worker_loop.py --codex-selftest
```

Each spins up its own isolated board on a temp port with a temp data dir — they
never touch a live board.

## When something refuses

- **exit 3 at line start** = a gate said no, on purpose, with the reason printed
  above the exit. Dirty tree → commit or revert, then re-bless. Wrong CLI shape
  (.cmd shim) → point `WORKER_CLAUDE_CLI` at the native executable.
- **结案被拦 (409 on close)** = the evidence names a file that is not committed.
  Commit it — the card is empty for everyone else until you do.
- **doctor is red** — each line carries its fix; run it again until green.
