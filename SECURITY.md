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
  the board onto a network. Writes require the `X-Board-Token` header, whose
  token lives in the data directory (`board_token`, gitignored).
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

If your report shows any of these claims to be false in practice, that is
exactly the kind of report we want.

## Supported versions

Pre-1.0: only the latest release line receives fixes.
