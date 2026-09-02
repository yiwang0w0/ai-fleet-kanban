// Deliverable-existence gate: makes "done" mean something verifiable at close time.
//
// Why it exists (INCIDENT-1): a card sat "done" on the board while the file its
// evidence described had never been committed — only its consumers had, so HEAD
// alone didn't build and the deploy pipeline silently served a stale bundle for
// days. People reading reports don't catch this; the machine re-counts at close.
//
// Why it was hardened (INCIDENT-4): evidence that *describes* behavior without
// naming a single file slips past any path-based check — silence was rewarded.
// `unnamedTouched` closes that: files modified inside the worker's own work
// window that the evidence never names also block the close.
//
// Design notes carried over from measured false positives (not invented):
//   * extension alternatives are ordered longest-first and must not be followed
//     by an alphanumeric — otherwise "Widget.tsx" truncates to a phantom
//     "Widget.ts" and reports a file that does not exist;
//   * prefix alternatives are ordered longest-first for the same reason
//     ("frontend/tools/x.mjs" must not half-match a shorter "tools/" prefix);
//   * callers listing the tree/status MUST use NUL-separated git output (-z):
//     plain porcelain quotes non-ASCII paths and silently drops them — repos
//     with CJK filenames lose every such file from the gate's view;
//   * paths that are neither on disk nor in HEAD are commands or typos in the
//     evidence text, not deliverables: only "on disk AND not in HEAD" reports.
//
// B3 (extraction change vs. origin): the origin hardcoded its own repo's
// directory table as PREFIX — on any other repo extraction is empty and the
// gate goes green while blind (the INCIDENT-4 mechanism, repo-wide). Here the
// prefix set is injected, normally generated from the host repo's top-level
// tree (`topLevelPrefixes`), and `assertCoverage` gives the loud warning when
// the configured layout matches nothing.
"use strict";

// Longest-first default extension set. `html` is present because its absence
// was a measured second hole in INCIDENT-4: the panel's own file was named by
// evidence and the gate could not see it.
const DEFAULT_EXTS = [
  "html", "tsx", "jsx", "json", "mjs", "cjs", "sql",
  "ts", "js", "py", "md", "yml", "yaml",
];

// Runtime state directories are correctly absent from git; never report them.
const DEFAULT_EXCLUDED = /(^|\/)\.data\//;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Parse `git ls-tree -z HEAD` (or `--name-only -z`) output into the set of
 * top-level directory prefixes. Pure string→array; the caller runs git.
 * NUL separation is load-bearing (see design notes above).
 */
function topLevelPrefixes(lsTreeZ) {
  const out = new Set();
  for (const rec of String(lsTreeZ || "").split("\0")) {
    if (!rec) continue;
    // Accept both `--name-only` records and full `<mode> <type> <oid>\t<path>`.
    const tab = rec.indexOf("\t");
    const p = tab >= 0 ? rec.slice(tab + 1) : rec;
    const slash = p.indexOf("/");
    if (slash > 0) out.add(p.slice(0, slash));
    else if (p && !p.includes("/")) out.add(p); // top-level entry (dir or file)
  }
  return [...out].sort((a, b) => b.length - a.length || a.localeCompare(b));
}

/**
 * Build an extractor bound to a host repo's layout.
 *   prefixes : string[]  top-level dirs the gate recognizes (longest first)
 *   exts     : string[]  file extensions (longest first); DEFAULT_EXTS if omitted
 *   excluded : RegExp    paths never reported; DEFAULT_EXCLUDED if omitted
 */
function makeExtractor({ prefixes, exts = DEFAULT_EXTS, excluded = DEFAULT_EXCLUDED } = {}) {
  if (!Array.isArray(prefixes) || prefixes.length === 0) {
    throw new Error("deliverable_gate: prefixes[] is required — generate via topLevelPrefixes(git ls-tree -z)");
  }
  const prefixAlt = [...prefixes].sort((a, b) => b.length - a.length)
    .map(escapeRe).join("|");
  const extAlt = [...exts].sort((a, b) => b.length - a.length).join("|");
  // Path body: word chars plus both separators, . _ - and CJK/kana — repos with
  // non-ASCII documentation names are first-class, and Windows-style backslash
  // paths in evidence normalize instead of vanishing.
  const body = "[A-Za-z0-9_./\\\\\\u3040-\\u30ff\\u4e00-\\u9fff-]+?";
  const pathSrc =
    "(?:^|[\\s`(\\[\"'*,;:])((?:" + prefixAlt + ")[/\\\\]" + body + "\\.(?:" + extAlt + "))(?![A-Za-z0-9])";

  /** Harvest repo-path-looking strings from evidence text. Pure. */
  function extractPaths(text) {
    const out = [];
    const seen = new Set();
    const re = new RegExp(pathSrc, "g");
    let m;
    while ((m = re.exec(String(text || "")))) {
      // Backslash → slash; char-code form survives transcription of the source.
      const p = m[1].split(String.fromCharCode(92)).join("/");
      if (excluded.test(p) || seen.has(p)) continue;
      seen.add(p);
      out.push(p);
    }
    return out;
  }

  /**
   * Named-but-uncommitted deliverables. Judgments are injected — no git or fs
   * here, so the whole gate is unit-testable:
   *   inHead(p) : path exists in the HEAD tree
   *   onDisk(p) : path exists in the working tree
   * Reports only "on disk AND not in HEAD".
   */
  function uncommittedDeliverables(text, { inHead, onDisk }) {
    return extractPaths(text).filter((p) => onDisk(p) && !inHead(p));
  }

  /**
   * INCIDENT-4's inverse: touched-but-unnamed. Pure.
   *
   * Attribution is by TIME, not by "is the tree dirty": shared worktrees always
   * carry other lines' in-flight work, and blocking on any dirt would make every
   * card unclosable — the classic road to the gate being switched off entirely.
   *
   * @param dirty [{ path, mtimeMs }]  uncommitted files (caller collected with -z)
   * @param named string[]             paths the evidence names (extractPaths output)
   * @param span  { startMs, endMs }   this worker's work window; null/invalid ⇒ measure nothing
   * @returns paths modified inside the window that the evidence never names (sorted)
   */
  function unnamedTouched(dirty, named, span) {
    const s = Number(span && span.startMs), e = Number(span && span.endMs);
    // Unmeasurable is NOT a violation — same polarity as the named-path check.
    if (!Number.isFinite(s) || !Number.isFinite(e) || e < s) return [];
    const namedSet = new Set((named || []).map((p) => String(p)));
    return (dirty || [])
      .filter((f) => f && typeof f.path === "string")
      .filter((f) => !excluded.test(f.path))
      .filter((f) => !namedSet.has(f.path)) // named ⇒ the other check's jurisdiction
      .filter((f) => Number.isFinite(Number(f.mtimeMs)) &&
                     Number(f.mtimeMs) >= s && Number(f.mtimeMs) <= e)
      .map((f) => f.path)
      .sort();
  }

  return { extractPaths, uncommittedDeliverables, unnamedTouched, pathSrc };
}

/**
 * B3 precondition assertion — the loud warning that prevents "green while blind".
 * Feed it evidence samples that OUGHT to contain repo paths (e.g. recent closed
 * cards' evidence). If nothing extracts across all samples, the configured
 * layout does not cover this repo and the gate would pass everything.
 * Returns { covered, sampled, warning } — caller decides where to shout.
 */
function assertCoverage(extractor, sampleTexts) {
  const samples = (sampleTexts || []).filter((t) => typeof t === "string" && t.trim());
  const hits = samples.reduce((n, t) => n + extractor.extractPaths(t).length, 0);
  const covered = samples.length === 0 ? null : hits > 0;
  return {
    covered,
    sampled: samples.length,
    warning: covered === false
      ? "deliverable_gate: 0 paths extracted across all evidence samples — this repo's layout is not covered; the gate would green-light everything. Regenerate prefixes from `git ls-tree -z HEAD`."
      : null,
  };
}

module.exports = { makeExtractor, topLevelPrefixes, assertCoverage, DEFAULT_EXTS, DEFAULT_EXCLUDED };
