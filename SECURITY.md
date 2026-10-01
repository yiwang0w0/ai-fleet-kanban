# Security Policy

## Reporting a vulnerability

Use **GitHub private vulnerability reporting** on this repository (Security →
Report a vulnerability). Please do not open a public issue for anything you
believe is exploitable. You can expect an acknowledgement within a week.

## What this system trusts, and what it refuses to

The board supervises **agent processes that write code**. Untrusted inputs include
card text, agent output, configuration, network requests and transferred Git
objects. The 0.24 development branch adds separately authenticated peer and MCP
surfaces described below. The original single-node defenses follow, each born
from a named incident (see `docs/INCIDENTS.md`):

- **Local board UI/API only.** `core/server.mjs` binds `127.0.0.1` and refuses
  to listen wider. Do not reverse-proxy this UI/API onto the tailnet or public
  network. Its writes require `X-Board-Token`; its reads retain the local trust
  boundary described below. The separate peer gateway is the only planned
  tailnet-facing surface.
- **Three credential classes** (v0.2, INCIDENT-12: an agent granted the board
  folder read the token and approved its own card). `board_token` = operator,
  full power; `worker_token` = execution face only (a worker compromised through
  card text cannot close, re-scope or re-parent anything); `review_token` =
  ruling face, and only as `resolved_by=auto`. All three live in the data
  directory (gitignored) — that directory is **operator territory**.
  **Measured 2026-09-07 with the real CLI on Windows (nine experiments, positive
  controls included):** a Claude worker in `-p` mode can `Read` any absolute path
  on the machine, inside or outside its working directory — so moving the data
  dir out of the repo is *not* a barrier by itself. What held, against relative
  reads, absolute reads and `Grep`, is the path-scoped deny rule the loops pass
  (`--disallowedTools`, v0.17.0). Same for the registry hole: a worker that could
  edit `verify_registry.json` could nominate any command for the loop to run — the
  Edit deny closes it, measured.
  **Historical measurement, not a supported deployment target: 2026-09-28 on Linux (Claude Code 2.1.283, 20 controlled calls):**
  the v0.17.0 spelling was inert on POSIX. A rule path with a single leading slash
  is *project-root-relative* to the CLI; only `//abs/path` is absolute — so
  `Read(/home/…/.data/**)` matched nothing and Read/Edit/Write/Grep all went
  through, while the same rules spelled `//…` all held. Two more facts from the
  same run shaped the fix (v0.21.2): `Write(path)` and `Glob(path)` rules are not
  matched at all (the CLI says so; `Edit` covers every file-writing tool and
  `Read` every file-reading tool), and a whole-directory `Read(//<data>/**)` deny
  also refuses the model's *writes* into that directory — which would have blocked
  the evidence file the worker must produce. The rules are therefore per file:
  `Read`+`Edit` on each protected name (`PROTECTED` in `loops/verify_lib.py`:
  tokens, `board.db*`, `accepted_rev`, settings, ledgers, probe outputs…) plus the
  registry, leaving `<data>/evidence`, `<data>/review` and `<data>/decompose`
  writable; `--prompt-selftest` scans the source for every file name written
  under the data dir and goes red on one that is in neither list. `doctor`
  checks the spelling this deployment would emit; the semantics can only be
  measured with a live model call, and the Windows drive-letter form was not
  re-measured in that run. **The legacy Codex loop has no equivalent path-deny mechanism**; there
  the boundary is the prompt, which is discipline, not structure. On a shared
  machine run the fleet as its own OS user; `doctor` and the server both say
  which case a deployment is in.
- **Card text is never a command line.** The worker refuses `.bat/.cmd` CLIs
  (CVE-2024-24576, "BatBadBut": cmd.exe re-parses arguments, so a card body
  could become an executable command line). The gate judges by extension on
  every platform, and the test escape hatch (`WORKER_ALLOW_BATCH_CLI`) logs
  loudly when used.
- **Legacy loop tool profile.** The intended profile exposes no Bash or push tool; card-named
  verification runs through a key registry (`verify_registry.json`) — cards
  carry **keys**, never command strings, so a worker that can write files still
  cannot nominate its own script for execution through that registry. This
  statement is about exposed tools, not an OS restriction on the process.
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

## Federation and local broker boundaries (0.24 development)

| surface | caller and credential | exposure |
|---|---|---|
| original board UI / `/api/*` | local operator/worker/review token classes; original reads remain unauthenticated | loopback only; do not proxy |
| independent `/peer/v1/*` gateway | receiver-issued bearer bound to peer node, epoch, credential version, scope and project | explicit loopback port; only this port is intended for a Tailscale private HTTPS proxy |
| `/local/v1/tools/list` and `/local/v1/tools/call` broker | per-principal bearer bound to local node epoch, role version and projects; execution principal also bound to agent/run | loopback only; internal HTTP, not a public MCP transport |
| `cli/mcp.mjs` | desktop/agent MCP stdio bridge with a restricted credential file | JSON-RPC on stdio; diagnostics on stderr; no database path or operator token given to the bridge |

All peer and broker requests authenticate before lifecycle state is disclosed;
mutations recheck authorization under their transaction after body upload.
Revocation, credential rotation, changed role versions and incompatible epochs
refuse further requests. Peer protocol capability negotiation does not grant
scopes. Display names, IP addresses, forwarding headers, tool arguments and
`clientInfo` do not authenticate identities. Remote task projections stay in
separate tables and cannot enter the local claim queue.

The Tailscale deployment contract has two checks: private HTTPS plus device ACLs
restrict reachability, and application bearer/project checks restrict actions.
The gateway receives loopback connections from its proxy, so localhost is not
proof of a trusted remote peer. Do not expose this through a public tunnel or
proxy the original board API. Actual two-device routes, ACLs, certificates and
revocation propagation still require deployment acceptance; current local
loopback tests do not establish those facts. Anonymous failures now have bounded aggregation and 429/Retry-After responses
([peer contract](docs/federation/peers.md)); valid credentials are authenticated
before failure counters, so a forged public key ID cannot lock out its holder.
Counters are per process, persistence is periodic, and authentication checks
still run: this is not network-level flood protection. Long-term authorized
data retention remains a review item in [review-fixes](docs/federation/review-fixes.md).

Peer and broker secrets are written to explicitly chosen new credential files;
the database stores token hashes. Keep these files outside agent-readable work
repositories, Markdown context exports and Git. New peer and MCP credentials use
Windows CreateNew with a protected DACL allowing only the issuing account. The
writer verifies that DACL on its unshared handle before writing secret bytes,
then flushes the file. Unavailable native protection fails closed; existing
files are never overwritten or automatically re-permissioned. This requires
a local drive and an ACL-capable filesystem. Copies must have their receiving
account and permissions checked separately. An interrupted writer may leave a
protected, unissued file for local inspection. A same-user process with access
to the database, HMAC keys or other principals' files can bypass the application
boundary. Windows user/ACL containment and native CLI ambient configuration
remain incomplete acceptance work; fixed argv, MCP allowlists, process Job
termination and prompt rules do not supply a filesystem/network sandbox.

Application resource checks bound request bodies, timeouts, canonical JSON
depth and authorized tool rates. Artifact readers pin Git, verify object
addresses and paths, and limit files, batch bytes and total content. Those
checks do not imply unlimited hostile traffic or retained authorized data is
safe; receiver storage and authenticated abuse need independent limits.

Restored/cloned databases preserve identity until an explicit recovery flow
changes epoch; a copy is not a new physical device. Restore holds, credential
rotation and one-use launch permissions prevent silent resumption in supported
paths. A locally signed execution journal authenticates a recovery observation
against its stored key, not a physical stop or an uncompromised OS. Review the
[migration guide](docs/federation/migration-0.24.md), [peer contract](docs/federation/peers.md),
[broker contract](docs/federation/mcp.md), and [measured progress](docs/federation/PROGRESS.md)
before treating this development branch as a deployed fleet.

## What it deliberately does not defend against

- **Local board reads are unauthenticated.** The original board UI/API `GET`
  routes answer without a token, by design; this does not apply to peer or broker:
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

Pre-1.0: only the latest release line receives fixes. `0.24.0-dev.1` is an
unreleased development version; Windows is the only future supported runtime,
CI and deployment target. Historical Linux measurements above remain historical.

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
