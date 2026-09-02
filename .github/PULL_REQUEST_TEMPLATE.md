## What this changes, and why

<!-- The why at whatever length it takes — the history here is documentation.
     If an incident or ruling motivated this, name it. -->

## Checklist

- [ ] All harnesses green locally (the CONTRIBUTING list) — CI enforces both
      Linux and Windows, so a single-platform green is not done
- [ ] New behavior has an assertion that goes red without this change
- [ ] No `machine`-layer term from docs/GLOSSARY.md was renamed
      (or: this PR includes the migration story and says BREAKING)
- [ ] Scar comments on touched code either still hold or the PR shows,
      with a measurement, why they no longer do
- [ ] New value domains refuse unknown values (fail-closed)
- [ ] `git status` clean of runtime state (`.data/`, tokens, local fleet config)
