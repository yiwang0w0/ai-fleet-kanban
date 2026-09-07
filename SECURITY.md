# Security Policy

## Reporting a vulnerability

Use **GitHub private vulnerability reporting** on this repository (Security →
Report a vulnerability). Please do not open a public issue for anything you
believe is exploitable. You can expect an acknowledgement within a week.

## What this system trusts, and what it refuses to

The threat model in one paragraph: the board supervises **agent processes that
write code**, so the dangerous inputs are not network packets — they are card
text, agent output, and the operator's own configuration. The standing defenses,
each born from a named incident (see `docs/INCIDENTS.md`):

- **Loopback only.** The server binds `127.0.0.1` and refuses to listen wider.
  There is no auth story for exposure beyond the machine; do not reverse-proxy
  the board onto a network. Writes require the `X-Board-Token` header.
- **Three credential classes** (v0.2, INCIDENT-12: an agent granted the board
  folder read the token and approved its own card). `board_token` = operator,
  full power; `worker_token` = execution face only (a worker compromised through
  card text cannot close, re-scope or re-parent anything); `review_token` =
  ruling face, and only as `resolved_by=auto`. All three live in the data
  directory (gitignored) — that directory is **operator territory**.
  **Measured 2026-09-07 with the real CLI (nine experiments, positive controls
  included):** a Claude worker in `-p` mode can `Read` any absolute path on the
  machine, inside or outside its working directory — so moving the data dir out
  of the repo is *not* a barrier by itself. What held, against relative reads,
  absolute reads and `Grep`, is the path-scoped deny rule the loops now pass:
  `--disallowedTools Read/Edit/Write/Glob/Grep(<data>/**)` and the same for the
  verify registry (v0.17.0). Same for the registry hole: a worker that could edit
  `verify_registry.json` could nominate any command for the loop to run — the
  Edit/Write deny closes it, measured. **The codex seat has no equivalent
  mechanism**; there the boundary is the prompt, which is discipline, not
  structure. On a shared machine run the fleet as its own OS user; `doctor` and
  the server both say which case a deployment is in.
- **Card text is never a command line.** The worker refuses `.bat/.cmd` CLIs
  (CVE-2024-24576, "BatBadBut": cmd.exe re-parses arguments, so a card body
  could become an executable command line). The gate judges by extension on
  every platform, and the test escape hatch (`WORKER_ALLOW_BATCH_CLI`) logs
  loudly when used.
- **Workers hold no execution rights.** No Bash tool, no push rights; card-named
  verification runs through a key registry (`verify_registry.json`) — cards
  carry **keys**, never command strings, so a worker that can write files still
  cannot nominate its own script for execution.
- **The fleet refuses to run unreviewed governance code.** The revision gate
  pins the gated tree's hash to an operator-blessed value and refuses startup
  from a dirty tree, with a dedicated exit code (3) so refusals are never
  retried as crashes.
- **Handoff is an allowlist.** Files a human must apply land only in directories
  the operator declared (`handoff_targets`); undeclared destinations are never
  written. Attachment sources are root-allowlisted the same way.
- **Secrets stay out of the tree.** Runtime state (`.data/`), tokens and local
  fleet config are gitignored; CI runs a full-history gitleaks scan on every
  push.

## What it deliberately does not defend against

- **Reads are unauthenticated.** Every `GET` answers without a token, by design:
  loopback means "this machine", and this machine is the operator's trust
  domain. The consequence is worth stating plainly — **any process running as
  any user on the machine can read card faces, evidence text and rulings**,
  including whatever an operator archives into evidence (the probe runner's
  output, for instance, can carry production rows). Do not paste production data
  into cards on a shared machine; keep a board that holds sensitive evidence on
  a single-user machine or behind OS-user isolation. The panel and the API are
  a work queue, not a data room. (This used to live only in a code comment.)
- **The machine-evidence gate is a heuristic over text — unless `verify_cmd` is set.**
  When a card names no verification key, the auto-reviewer's gate looks for signs
  of machine output in the evidence *text* (`rc=0`, `PASS 12`, tracebacks…). Text
  can be written to look like output. The only machine truth is the verification
  the **loop** runs itself (`verify_cmd`, a registry key); everything else the
  gate does is a downgrade-to-human heuristic, and it is documented as one. A
  card with an empty acceptance is escalated rather than approved (v0.16.1) —
  "no machine demanded" and "no acceptance written" are not the same thing.

If your report shows any of these claims to be false in practice, that is
exactly the kind of report we want.

## Supported versions

Pre-1.0: only the latest release line receives fixes.

## Panel accept / restart endpoints (v0.18)

`POST /api/setup/bless`, `POST /api/setup/restart` and `POST /api/upgrade/apply` are
operator-token writes (`guardWrite`; worker and review tokens are refused like any path
not on their lists). Accepting requires `confirm_tree` equal to the current
`HEAD:<gated_subtree>` tree — the panel sends the hash it displayed, so a tree that changed
between look and click is refused (409); there is no "accept whatever is on disk". The
restart endpoints refuse (409, `needs_force`) while cards are in flight unless `force` is
passed, and the panel passes it only after its confirm text named the count. Under `npm start`
(`cli/start.mjs`), pm2 or systemd the process exits 75 and its supervisor relaunches
it (`exit`); a bare process starts a detached successor from its own
`execArgv`/`argv`/`cwd`/`env`, logging to `<data>/board.log` (`respawn`). Accepting adds no capability beyond the operator token (that holder could already write
`accepted_rev`, a file in the data dir). Restarting is a new, bounded one: it stops the lines
and re-runs the board from the code on disk — the source gate covers lines, not the board
process, exactly as a manual restart does. What keeps a worker away from all of this is the
Claude seat's deny rules on the data dir (above).
