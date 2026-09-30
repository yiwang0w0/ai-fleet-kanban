# Contributing

This project has one unusual property worth knowing before you start: **it was
built by running it** — the mechanisms exist because incidents demanded them,
and the code comments carry those reasons. Contributions are welcome; the bar
they clear is the same one the codebase already holds itself to.

## The ground rules

1. **Machine assertions over prose.** A change to behavior comes with a harness
   assertion that goes red without it. "I tested it manually" does not survive
   the next contributor. `npm test` is the authoritative list of the 40 Node
   harnesses. Windows CI also runs four Python selftests and one Node page
   verifier selftest:

   ```powershell
   $env:PYTHONUTF8 = "1"
   npm test
   python gates/gates_lib.py
   python loops/worker_loop.py --codex-selftest
   python loops/worker_loop.py --prompt-selftest
   python watchers/board_health_watch.py --selftest
   node examples/verify_page.mjs --selftest
   ```

   **Windows regression and secret scanning are both blocking.** Future work,
   deployment and acceptance target Windows only. Older Linux measurements
   remain historical evidence, not current release requirements. CI uses Node
   24 and Python 3.12; local command examples assume PowerShell. A local pass
   is not evidence that the exact pushed commit passed CI.

2. **The GLOSSARY is frozen.** `docs/GLOSSARY.md`: renaming any `machine`-layer
   term (wire values, JSON keys, env names, exit codes, event kinds) is a
   breaking change and needs a migration story, not just a rename. Display
   wordings may evolve, but each keeps its referent. Status/waiting labels have
   one source in `core/store.js`, exposed by `/api/meta`; neither panel nor CLI
   should add another copy. Qualify a term by its owning object: line roles and
   broker policies are different domains, as the glossary records.

3. **Comments carry the WHY, and the why is usually a scar.** When you touch
   code whose comment cites a measured failure, the comment is load-bearing:
   either the reason still holds (keep it), or you can show it no longer does
   (say so in the PR, with the measurement). Deleting a scar comment because it
   is long is how the scar gets re-earned.

4. **Gates fail closed, and unknown values fall on the refusing side.** If your
   change adds a value domain, the unknown case refuses — never passes. If you
   find yourself adding a warning comment instead of a structural check, stop:
   the codebase's rule is *structure over discipline*.

5. **No silent degradation.** A feature that cannot work in some configuration
   says so loudly (startup line, refusal text) rather than half-working. Escape
   hatches exist for tests only, and every use logs.

## Practical notes

- **Dev loop:** `node cli/doctor.mjs` first; the harnesses need no running
  board (each spins up its own on a temp port with a temp data dir — never
  point tests at a live board).
- **Line endings:** the index is LF everywhere (`.gitattributes` pins it).
- **Language:** user-facing display strings are Chinese; machine contracts and
  code comments in `core/`/`tests/` are English; the Python loops' comments are
  Chinese. Match the file you are in.
- **Runtime state never enters the tree:** `.data/`, tokens, local fleet
  config are gitignored. If `git status` shows them, something is wrong.
- **Commits:** explain the why at whatever length it takes; the history here is
  documentation. Reference the incident/ruling when there is one.

## Releasing (maintainer ritual)

Every substantive change that lands on `main` ships as a **versioned release**:
the README `Status` line moves to the new version, and an annotated tag
`vX.Y.Z` lands on the same commit — no untagged feature pushes. While 0.x:
patch = fixes, docs, bundled skills; minor = new features, or **any**
machine-contract change (see the GLOSSARY rule above — those also need the
migration story). The tag and the README must never disagree about what
version you are looking at.

The current `0.24.0-dev.1` identifies an unreleased development branch. Do not
create a release tag merely to satisfy a version check. Before an authorized
0.24.0 release, align package/README/tag on the release commit, finish the
[Windows migration checklist](docs/federation/migration-0.24.md), and attach
that commit's required CI and acceptance evidence. The prerelease identifier
does not claim that physical fleet/provider validation or deployment is done.

## Scope guidance

Good first contributions: additional runtime adapters (the seat contract is
`WORKER_CLI_ARGV` + the declaration table in `fleet.config.json`), harness
coverage for gaps named in the issue tracker, and panel affordances
that read existing API fields. Things that need a design conversation first:
anything touching the gates, the state machine's four statuses, or the
task_events schema (append-only is a contract, not a style).
