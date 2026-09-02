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

Doctor reads `fleet.config.json` (and `BOARD_PORT`/`BOARD_URL`, which override
it), so after step 1 it probes the port you will actually use — its closing
line even tells you where the port came from.

## 1 · Install your config (recommended)

```
node cli/init.mjs        # copies examples/fleet.config.json to the BOARD repo root
```

The config is two things at once. It is your **fleet vocabulary** — edit
`lines[]` and `handoff_targets[]`, or skip the editor and tell your Claude what
your work looks like (`docs/OPERATE_WITH_CLAUDE.md`). And since v0.3 it is the
**deployment truth**: optional `port` / `repo` / `gated_subtree` keys that the
server AND every client read alike, so nothing below needs to be exported in
two shells. The example already carries `gated_subtree: "."`. The file is
gitignored; it names YOUR directories and stays on your machine.

(Skipping this step works too — you get two built-in lines, `alpha`/`coord`,
and the env-variable spellings shown below.)

## 2 · Bless what you're about to run

The fleet **refuses to run unreviewed governance code** — that is the fail-closed
source gate, and on a standalone clone the governance code is the whole tree.
Blessing = recording "this exact tree is what I accept". With the step-1 config
in place it is one command:

```
python cli/board.py bless
```

(No config? Same act, spelled by hand — and the gate subtree must then be
exported in EVERY shell that runs a loop:)

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

(That trailing colon in `"HEAD:"` is not a typo: it addresses HEAD's **tree
object** — the content snapshot — rather than the commit. That is exactly why
any local edit to tracked files changes the hash and stops line startup.)

Two things follow, both deliberate: **any local edit to tracked files stops line
startup** (exit 3, with the reason printed — that is the gate working, not a
crash), and after you commit a change you re-bless the same way.

## 3 · Board up

```
node core/server.mjs
```

Open http://127.0.0.1:47824 — the panel is for your eyes; agents use the API.
The tab title carries the waiting-card count, so a delivered card is visible
even from another tab.

**If doctor warned that 47824 is taken** (another board, or anything else):
write `"port": 48500` into `fleet.config.json` — the server and every client
read the same file, so one edit moves the whole deployment. (`BOARD_PORT` /
`BOARD_URL` env vars still override the config for one-off runs; if you use
them, every shell needs the same value — moving only the server sends your
commands to whatever answers on the OLD port, which on a shared machine can be
somebody else's live board.)

## 4 · Seed the demo and run the mock cycle (zero tokens)

In a second shell. With the step-1 config, the new shell needs **no exports** —
port and gate subtree come from the config:

```bash
node examples/seed_demo.mjs
WORKER_CLI_ARGV='["python","examples/mock_worker_cli.py"]' \
  python loops/worker_loop.py --as alpha --once
```

```powershell
$env:PYTHONUTF8 = "1"               # Windows pipes default to a legacy codepage
node examples\seed_demo.mjs
$env:WORKER_CLI_ARGV = '["python","examples/mock_worker_cli.py"]'
python loops\worker_loop.py --as alpha --once
```

(No config? Then this shell needs the same `BOARD_GATED_SUBTREE` — and
`BOARD_PORT` if you moved it — exported again: a NEW shell knows nothing your
first shell exported, and skipping the gate env is a guaranteed refusal, exit 3.
The line name `alpha` is the built-in default; if you named your own lines in
step 1, use YOUR first line — the seed prints the exact commands.)

The seed plants one goal and three cards (and refuses a board that already has
cards — demo data never mixes into real work). The `--once` run claims card #2,
the mock adapter writes evidence, the loop delivers it, and the card lands in
**等待中/待验收** on the panel.

## 5 · Rule on it — this part is yours

On the panel, find the waiting card — the note box and the ruling button are
right on the card face (no need to open anything; the「双击展开」affordance
expands the *evidence text*, not the ruling area). There is **one** ruling
button, and its caption tells you what it will do:

- note box **empty** → the button reads **结案** (close): pressing it is a clean
  pass and the card closes (`done`);
- **anything written** → the same button becomes **回原线继续** (back to its
  line): your words go BACK with the card as an instruction, and the next claim
  reads them verbatim. A written-on card is never silently closed — someone
  must act on what you said.

The button is **two-press**: the first press arms (color and caption change),
the second press within ~4 seconds fires — wait longer and it quietly disarms.
No confirm() dialogs by design; a button that "did nothing" was an armed button
that timed out.

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
node tests/selftest.mjs && node tests/servertest.mjs && node tests/looptest.mjs && node tests/reviewtest.mjs
node tests/decisiontest.mjs && node tests/gatetest.mjs && node tests/decomposetest.mjs
python gates/gates_lib.py && python loops/worker_loop.py --codex-selftest
```

Each spins up its own isolated board on a temp port with a temp data dir — they
never touch a live board.

## When something refuses

- **The server console is quiet by design** — after the startup lines, claims,
  deliveries and rulings print nothing there. The live view is the event
  stream: `python watchers/sse_watch.py` prints one line per board event
  (that's also the first sentry your Claude mounts in
  `docs/OPERATE_WITH_CLAUDE.md`).
- **`未配置 handoff 目标` at startup is normal for this walkthrough** — handoff
  targets only matter when a ruling carries files to hand-apply; nothing in
  this demo does. Configure `handoff_targets` (or `BOARD_HANDOFF_DIR`) when you
  get there.
- **exit 3 at line start** = a gate said no, on purpose, with the reason printed
  above the exit. Dirty tree → commit or revert, then re-bless. Wrong CLI shape
  (.cmd shim) → point `WORKER_CLAUDE_CLI` at the native executable.
- **结案被拦 (409 on close)** = the evidence names a file that is not committed.
  Commit it — the card is empty for everyone else until you do.
- **doctor is red** — each line carries its fix; run it again until green.
