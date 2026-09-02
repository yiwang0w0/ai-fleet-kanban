---
name: Bug report
about: Something behaved differently from what the code or docs promise
labels: bug
---

## What happened, and what did you expect

<!-- One paragraph each. If a gate refused something, quote the refusal text —
     refusals name their reason and their fix by design, so the exact wording
     matters. -->

## Machine evidence

<!-- Paste, don't paraphrase: -->

- `node cli/doctor.mjs` output:
- Which harnesses pass on your machine (see CONTRIBUTING for the list):
- Server startup lines (the board announces its config and gates):
- OS + node + python versions:

## Reproduction

<!-- Ideally against a THROWAWAY board: temp BOARD_DATA_DIR + spare BOARD_PORT,
     the way every harness does it. Steps against your live board are fine to
     describe, but don't paste its card contents unless you've checked them. -->
