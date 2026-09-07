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
  directory (gitignored) — that directory is **operator territory**: grant a
  worker agent `BOARD_REPO` and nothing else, because filesystem access to the
  data dir hands over every token at once.
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
