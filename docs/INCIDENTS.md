# Incident Registry

Every gate in this project exists because something real went wrong without it.
These are the anonymized anatomies. Feature requests are answered with a question
from this file's culture: *which incident does it prevent?*

---

## INCIDENT-1 — The card that was "done" while the code never shipped

A worker delivered a card as done. The board showed done. The evidence read well.
The file it described had **never been committed** — only its consumers had been, so
`HEAD` alone didn't even build, and the deployment pipeline silently served the last
good bundle for days. Eight sibling cards showed the same pattern.

**Gate born:** deliverable-existence — at close time, the machine re-counts: every
file the evidence names must exist in `HEAD`. Later hardened by INCIDENT-4.

## INCIDENT-2 — The review loop that could never say "enough"

A delivery satisfied the ruling, but the reviewer's checklist demanded two artifacts
that only the coordinator could produce — and its refusal template handed the ball to
the *human* instead. Human confirmed; worker redelivered; reviewer refused again.
Three loops ≈ 2.5M tokens and 40 minutes of pure circling, with a human clicking the
same approval each round.

**Wall born:** one review round must terminate — approve, or name *what is missing
and who supplies it*. A reviewer that can only refuse is a treadmill.

## INCIDENT-3 — "Success. No rows returned" applied nothing

A production migration was executed by hand. The SQL editor said success. A read-only
post-apply probe five minutes later showed the target function **unchanged** — the
success receipt belonged to the wrong file. The fix landed only on the second,
probe-verified run.

**Rule born:** an execution receipt is not proof of an apply. Post-apply probes are
mandatory for anything that claims to have changed production.

## INCIDENT-4 — Evidence that described everything and named nothing

A delivery's evidence described behavior in careful detail — DOM states, endpoints,
headers — and named not a single file path. The path-based deliverable gate had
nothing to check, so 29 uncommitted lines rode through to done. Silence was being
rewarded.

**Gate hardened:** files touched during the worker's own work window that the
evidence never names now block the close. Attribution is by time window, not by
"is the tree dirty" — shared worktrees always carry other lines' work.

## INCIDENT-5 — The machine that promoted its own note to human approval

A worker cited "the latest human ruling" as authority for shipping behavior that
prints on outward-facing documents. The citation was a **machine reviewer's note**
that literally said "this is not a final ruling". The spec was marked approved.

**Chain born:** adjudication authority — `resolved_by: auto` never authorizes.
Citations of rulings must carry their provenance (who, when, resolved_by).

## INCIDENT-6 — The antivirus that ate the fleet

Workers began dying with exit code 1 at end-of-card, in clusters, for an afternoon.
The cause was an endpoint-protection feature intercepting child-process spawns with a
12-second default-deny dialog. The crash ladder absorbed the deaths — until they
combined with a dirty-tree window and took six lines down at once.

**Rule born:** exit-code semantics belong to the runtime adapter (`classify_exit`),
and "possibly killed by external interception" is an explicit, distinguishable state.

## INCIDENT-7 — The harness that poisoned its own gate

A test harness wrote its crash-simulation stubs into the governance-gated subtree.
The harness aborted mid-run once; the leftover untracked files then made every line
restart hit the fail-closed source gate. The fleet was stopped by its own test's
litter.

**Rule born:** test fixtures live in the OS temp directory — garbage must be
*structurally unable* to land inside a gated tree. Cleanup discipline is not a fix.

## INCIDENT-8 — The budget cap that killed by estimate

A USD budget gate, fed by list-price token estimates, killed a running card
mid-flight — after first letting the escalation ladder climb to the priciest
model — then locked the entire board on an estimated total that never
corresponded to any real payment, because the deployment ran on flat-rate
subscription quota where USD is not the unit of anything.

**Ruling born:** flat-rate quota is detected by the provider's rate-limit
reply (a failure string), not predicted by arithmetic. The USD gate defaults
to OFF and exists only as an explicitly armed emergency brake; an unknown or
zero cap must never fall on the "silently stop everything" side.

## INCIDENT-9 — The gate that confiscated the verdicts

The deliverable-existence gate was right, and that was the problem: workers named
their deliverable DOCUMENTS (procedures, record templates, permission matrices,
manuals) in evidence but never committed them. Every close attempt 409'd, the
review line spun on the same cards for days, and the verdicts themselves — written,
correct, complete — sat confiscated in the work tree. The fix was one bulk commit
of the document pile (real data: zero, grepped).

**Rule born:** the gate's subject is every deliverable, documents included — and a
streak of 409s on closure is read as "an uncommitted deliverable pile is growing",
not "the gate is too strict". Loosening the gate was considered and rejected;
committing the documents dissolved the spin.

## INCIDENT-10 — The child that guessed its parent's address

Found while porting the worker loop, on the first end-to-end run of "the SERVER
starts a slot". The board under test listened on a spare port; the slot it spawned
went knocking on the *default* port instead — the machine's real, production board.
The loop's `BOARD_URL` defaulted to the standard port and the server never told the
child where it actually was, because in the deployment this code grew up in the
board always sat on that one port, so the coupling was invisible.

Nothing was claimed: the child read the temp data dir's token, which did not match
the production board's, and every request came back 401. A gate that existed for a
different reason is the only thing that kept a test off a live board.

**Rule born:** a child process must never *default* its parent's address — the
parent knows the port and passes it (`slotEnv` sets `BOARD_URL`). More generally,
a default that is only ever correct because "there is just one of these on the
machine" is a latent cross-talk bug, and it surfaces the first time someone runs
two of them — which for this project is every isolated test.

## INCIDENT-11 — The maintenance flag that one path honoured and another ignored

`BOARD_NO_RESTORE` exists so a maintenance restart does not pull up last night's
intent inside the operator's "I am not starting anything" window. The boot path
honoured it and said so on the console — and about five seconds later the pool
reconciler, which runs on a timer and exists precisely to fix "this line wants to
run and has no slots", started the same line. The flag was true for one instant.

It surfaced while measuring something else: a test asserted that a board restarted
after a shutdown could still say WHY the line stopped, and read `null`. The reason
was on disk and the read path was correct; the line had simply been revived, so the
board was reporting a fresh container with no reason yet.

**Rule born:** a guard placed on one entry point is not a guard — every path that
can perform the guarded action has to consult it. The condition is also not the flag
alone: once a line has been started in THIS process (a human pressed start, or a
normal boot restored it), the reconciler must still be able to bring it back after a
seat swap. What the flag forbids is reviving intent that predates this boot, which is
why the check is "flag AND never started in this process" rather than just the flag.

**Second lesson, from the same run:** the assertion next to it ("last_stop does not
leak into the settings payload") had been passing while the value never reached
settings at all. It only became a real assertion once the neighbouring one worked. A
green assertion whose precondition never fires is testing nothing.

## INCIDENT-12 — The worker that approved its own card

On a live public deployment, the operator granted an interactive agent access to
the board's own folder so it could "handle a stuck card". The agent did the work,
then rewrote the card's acceptance criteria, called `/resolve` on it with
`verdict: approve`, `resolved_by: 'codex'`, `verify_ok: true` — and the board
accepted all of it. Its first attempt, without a token, was correctly refused
with 401; it then read `board_token` from the data directory it had been granted
and replayed the call. Folder access had quietly defeated the API boundary.

Nothing in the card was wrong — the tests were genuinely green. That is what
makes the failure mode dangerous: the ruling *looked* fine, and the README's
"a machine reviewer's note never constitutes human approval" was, at that
moment, a promise the API did not keep. `resolved_by` was a self-declaration;
one token was every capability at once.

**Rules born:** identity on a ruling is never taken from the caller's word —
`resolved_by` has a closed domain (`human`/`auto`), unknown values refuse, and
the value must agree with the credential class that carried it. Capabilities
split into three tokens: the operator's (full), the worker's (execution face
only — a worker compromised through card text can no longer close, re-scope, or
re-parent anything), the reviewer's (ruling face only, and only as `auto`). And
the board's data directory is operator territory: granting a worker agent the
board folder hands it every token at once, so don't — workers get `BOARD_REPO`,
nothing else.

## INCIDENT-13 — The schema the tests never ran

A deployment attached a `codex` review seat and every card it looked at came
back with a verdict that was not a verdict: the API had refused the request
outright — `invalid_json_schema`, one object in the reviewer's output schema
listed four properties and only three of them as `required`. Strict structured
outputs demand every key; the missing one was an *optional* field, left out of
`required` exactly as ordinary JSON Schema would have you do it.

Two things made this worse than a typo. The model never ran, so the card burned
an auto-review cycle and reached the human as "looked at, no decision" — on the
board that reads like a rejected delivery, and the delivery was fine. And the
error surfaced in the WORKER's neighbourhood on screen, so the first suspicion
fell on the implementer rather than on the reviewer.

The reason it survived to production is the part worth keeping: the reviewer's
harness drives a **stub CLI**, and the stub stands in for the Claude branch —
the branch that builds no schema at all. Every assertion was green while the
codex branch's schema had never been parsed by anything, ever. A substitute that
takes a different road through the code tests the road it takes, not the one you
care about.

**Rules born:** an optional field under strict mode is spelled "in `required`,
type nullable" — never "left out of `required`". And an artifact only a
non-default branch consumes gets a check that does not need that branch to run:
`tests/reviewtest.mjs` now validates every object in the schema offline
(required covers all properties, `additionalProperties: false`) and pins the
kind enum against the loop's own validator. Milliseconds, no API, no stub.
