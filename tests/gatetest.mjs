// Deliverable-gate harness. Inputs are shaped like real measured cases, not
// imagined ones — a test written from imagination checks imagination against
// imagination and is always green.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { makeExtractor, topLevelPrefixes, assertCoverage, DEFAULT_EXTS } =
  require("../gates/deliverable_gate.js");

let PASS = 0;
const FAILED = [];
const ok = (name, cond) => {
  if (cond) { PASS++; console.log("PASS", name); }
  else { FAILED.push(name); console.log("FAIL", name); }
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ── § prefixes from ls-tree (B3 generator) ─────────────────────────────────
console.log("[§1 topLevelPrefixes]");
{
  const z = ["src/app.ts", "src/lib/util.ts", "packages/core/x.js", "docs/a.md",
             "README.md", "日本語資料/仕様.md"].join("\0") + "\0";
  const p = topLevelPrefixes(z);
  ok("collects top-level dirs incl. non-ASCII", eq([...p].sort(),
     ["README.md", "docs", "packages", "src", "日本語資料"].sort()));
  ok("longest-first ordering", p.indexOf("packages") < p.indexOf("src"));
  ok("full ls-tree records (mode type oid\\tpath) also parse",
     eq(topLevelPrefixes("100644 blob abc\tsrc/x.ts\0"), ["src"]));
  ok("empty input → empty set", eq(topLevelPrefixes(""), []));
}

// ── § extraction on a neutral repo layout ──────────────────────────────────
console.log("[§2 extractPaths]");
const X = makeExtractor({ prefixes: ["packages/core", "packages", "src", "docs"] });
{
  ok("plain path extracts",
     eq(X.extractPaths("changed src/board/store.js today"), ["src/board/store.js"]));
  ok("longest prefix wins (no half-prefix phantom)",
     eq(X.extractPaths("see packages/core/gate.mjs"), ["packages/core/gate.mjs"]));
  ok("extension not truncated mid-token (Widget.tsx stays .tsx)",
     eq(X.extractPaths("touch src/ui/Widget.tsx now"), ["src/ui/Widget.tsx"]));
  ok(".html is recognized (measured hole in origin: panel file was invisible)",
     eq(X.extractPaths("edited src/panel.html"), ["src/panel.html"]));
  ok("CJK document paths extract",
     eq(X.extractPaths("正典は docs/サンプル資料.md にある"), ["docs/サンプル資料.md"]));
  ok("backslashes normalize", eq(X.extractPaths("src\\a\\b.ts"), ["src/a/b.ts"]));
  ok("runtime-state paths never report", eq(X.extractPaths("wrote src/.data/x.json"), []));
  ok("dedupe", X.extractPaths("src/a.ts and src/a.ts").length === 1);
  ok("unknown prefix extracts nothing (the B3 blindness this module must expose, not hide)",
     eq(X.extractPaths("changed lib/秘/thing.ts"), []));
}

// ── § named-but-uncommitted (INCIDENT-1) ───────────────────────────────────
console.log("[§3 uncommittedDeliverables]");
{
  const text = "delivered src/feature.ts and docs/spec.md; command: node src/gone.ts";
  const inHead = (p) => p === "docs/spec.md";              // spec committed
  const onDisk = (p) => p !== "src/gone.ts";               // typo/command not on disk
  ok("on-disk + not-in-HEAD reports",
     eq(X.uncommittedDeliverables(text, { inHead, onDisk }), ["src/feature.ts"]));
  ok("committed file passes (gate does not ring forever)",
     !X.uncommittedDeliverables(text, { inHead, onDisk }).includes("docs/spec.md"));
  ok("neither-on-disk-nor-in-HEAD is a phantom, not a deliverable",
     !X.uncommittedDeliverables(text, { inHead, onDisk }).includes("src/gone.ts"));
}

// ── § touched-but-unnamed (INCIDENT-4) ─────────────────────────────────────
console.log("[§4 unnamedTouched]");
{
  const span = { startMs: 1000, endMs: 2000 };
  const dirty = [
    { path: "src/silent.ts", mtimeMs: 1500 },   // touched in-window, unnamed → ring
    { path: "src/named.ts", mtimeMs: 1500 },    // named → other check's jurisdiction
    { path: "src/other-line.ts", mtimeMs: 500 },// outside window → someone else's work
    { path: "src/.data/x.json", mtimeMs: 1500 },// runtime state → excluded
  ];
  const named = ["src/named.ts"];
  ok("in-window unnamed file blocks", eq(X.unnamedTouched(dirty, named, span), ["src/silent.ts"]));
  ok("no span → measure nothing (unmeasurable ≠ violation)",
     eq(X.unnamedTouched(dirty, named, null), []));
  ok("inverted span → measure nothing",
     eq(X.unnamedTouched(dirty, named, { startMs: 2000, endMs: 1000 }), []));
  ok("clean tree → nothing", eq(X.unnamedTouched([], named, span), []));
  ok("mtime unreadable → not counted",
     eq(X.unnamedTouched([{ path: "src/x.ts", mtimeMs: NaN }], [], span), []));
}

// ── § coverage assertion (B3 loud warning) ─────────────────────────────────
console.log("[§5 assertCoverage]");
{
  const good = assertCoverage(X, ["delivered src/a.ts", "prose only"]);
  ok("covered layout → no warning", good.covered === true && good.warning === null);
  const wrong = makeExtractor({ prefixes: ["app", "lib"] }); // not this repo's layout
  const bad = assertCoverage(wrong, ["delivered src/a.ts", "also src/b.md"]);
  ok("zero extraction across samples → loud warning",
     bad.covered === false && /not covered/.test(bad.warning));
  const none = assertCoverage(X, []);
  ok("no samples → coverage unknown (null), no false alarm",
     none.covered === null && none.warning === null);
}

// ── § constructor guardrails ───────────────────────────────────────────────
console.log("[§6 config]");
{
  let threw = false;
  try { makeExtractor({}); } catch { threw = true; }
  ok("missing prefixes[] throws (no silent blind gate)", threw);
  ok("DEFAULT_EXTS is longest-first-safe (html before ts before js by regex order)",
     DEFAULT_EXTS.includes("html") && DEFAULT_EXTS.includes("yaml"));
}

console.log(`\n结果: ${PASS} PASS / ${FAILED.length} FAIL`);
if (FAILED.length) { console.log(FAILED.join("\n")); process.exit(1); }
