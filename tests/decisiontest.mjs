// Pure-function regression for final-ruling attachments and handoff targets:
// writes only to the OS temp dir, never touches a production board.
//
// The decisionPanel DOM assertions arm themselves only when core/panel.html exists.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);
const D = require_("../core/decision_lib.js");
const root = mkdtempSync(join(tmpdir(), "decisiontest-"));
const handoffDir = join(root, "handoff");
const cfgDropDir = join(root, "cfgdrop");
const migrations = join(root, "migrations");                 // in the default apply-roots
const dryrunVerify = join(root, "tools", "dryrun_verify");   // companion territory
mkdirSync(handoffDir, { recursive: true }); mkdirSync(cfgDropDir, { recursive: true });
mkdirSync(migrations, { recursive: true }); mkdirSync(dryrunVerify, { recursive: true });
const source = join(migrations, "0998_test.sql");
writeFileSync(source, "select 1 as is_ok;\n", "utf8");

// Two authorized targets: a default any-extension one (serial admission pattern)
// and a cfg-only one — the generalization under test.
const TARGETS = D.normalizeTargets([
  { id: "default", label: "手交区", dir: handoffDir },
  { id: "cfgdrop", label: "配置投放区", dir: cfgDropDir, exts: ["cfg"] },
]);
const CTX = { repoRoot: root, targets: TARGETS };

const PANEL = join(__dirname, "..", "core", "panel.html");
const panelPresent = existsSync(PANEL);
let skipped = 0;
const skip = (name) => { skipped++; console.log("SKIP", name, "(core/panel.html not yet extracted)"); };

const renderDecisionPanel = panelPresent ? (() => {
  const sourceHtml = readFileSync(PANEL, "utf8");
  const start = sourceHtml.indexOf("function decisionPanel(");
  const end = sourceHtml.indexOf("\nfunction ago(", start);
  if (start < 0 || end < 0) throw new Error("decisionPanel not found in panel.html");
  const esc = (s) => String(s ?? "").replace(/[&<>\"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '\"': "&quot;" }[c]));
  return Function("decisionChoice", "esc", `${sourceHtml.slice(start, end)}\nreturn decisionPanel;`)(new Map(), esc);
})() : null;

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log("PASS", name); }
  else { fail++; console.log("FAIL", name, detail); }
};

try {
  const pkg = { summary: "test ruling", recommend: "A", options: [
    { key: "A", title: "apply the file", detail: "do it", cost: "risk", kind: "apply",
      files: [{ path: "migrations/0998_test.sql", label: "main file", role: "apply", archive_name: "0998_test.sql" }] },
    { key: "B", title: "observe", detail: "wait", cost: "time", kind: "none", files: [] },
    { key: "C", title: "do nothing", detail: "stop", cost: "status quo", kind: "none", files: [] },
  ]};
  const task = { id: 7, verdict_note: "", decision_package: pkg };
  const pub = D.publicDecisionPackage(task, CTX);
  ok("attachment available; public object leaks no source path but names the target",
     pub.options[0].ready && !Object.hasOwn(pub.options[0].files[0], "path") &&
     pub.options[0].files[0].target === "default" && pub.options[0].files[0].target_label === "手交区");
  const first = D.archiveOptionFiles(task, "A", CTX);
  ok("first confirmation copies under the original serial, tagged with its target",
     first[0].status === "copied" && first[0].target === "default" &&
     readFileSync(join(handoffDir, "0998_test.sql"), "utf8") === readFileSync(source, "utf8"));
  const second = D.archiveOptionFiles(task, "A", CTX);
  ok("same name + same hash is idempotent", second[0].status === "already_present");
  writeFileSync(source, "select 2 as is_ok;\n", "utf8");
  let conflict = ""; try { D.archiveOptionFiles(task, "A", CTX); } catch (e) { conflict = e.message; }
  ok("same name + different content is a hard conflict; the handoff copy is not overwritten",
     /同名异内容/.test(conflict) &&
     /select 1/.test(readFileSync(join(handoffDir, "0998_test.sql"), "utf8")), conflict);
  const badTask = { id: 8, decision_package: { ...pkg, options: [
    { ...pkg.options[0], files: [{ ...pkg.options[0].files[0], archive_name: "no-seq.sql" }] },
    ...pkg.options.slice(1)] } };
  let numbered = ""; try { D.archiveOptionFiles(badTask, "A", CTX); } catch (e) { numbered = e.message; }
  ok("a name outside the target's admission pattern refuses to archive", /准入名形/.test(numbered), numbered);
  const firstSource = join(migrations, "0997_first.sql");
  const secondSource = join(migrations, "0996_second.sql");
  writeFileSync(firstSource, "select 97 as first_ok;\n", "utf8");
  writeFileSync(secondSource, "select 96 as second_ok;\n", "utf8");
  writeFileSync(join(handoffDir, "0996_second.sql"), "select -96 as conflict;\n", "utf8");
  const multiTask = { id: 9, decision_package: { ...pkg, options: [
    { ...pkg.options[0], files: [
      { path: "migrations/0997_first.sql", label: "first file", role: "apply", archive_name: "0997_first.sql" },
      { path: "migrations/0996_second.sql", label: "second file", role: "companion", target: "default", archive_name: "0996_second.sql" },
    ] }, ...pkg.options.slice(1)] } };
  let multiConflict = "";
  try { D.archiveOptionFiles(multiTask, "A", CTX); } catch (e) { multiConflict = e.message; }
  ok("multi-file: whole-plan pre-check first — a later conflict keeps EARLIER files off the disk too",
     /同名异内容/.test(multiConflict) &&
     !existsSync(join(handoffDir, "0997_first.sql")), multiConflict);

  // ── Generalization: a non-SQL file to a cfg-only target ──────────────────────
  writeFileSync(join(migrations, "0995_app.cfg"), "key=value\n", "utf8");
  const cfgTask = { id: 10, decision_package: { ...pkg, options: [
    { ...pkg.options[0], files: [
      { path: "migrations/0995_app.cfg", label: "app config", role: "apply", target: "cfgdrop", archive_name: "0995_app.cfg" },
    ] }, ...pkg.options.slice(1)] } };
  const cfgPlan = D.archiveOptionFiles(cfgTask, "A", CTX);
  ok("⭐ a .cfg file archives into its authorized cfg target (deliverables are not SQL-shaped)",
     cfgPlan[0].status === "copied" && cfgPlan[0].target === "cfgdrop" &&
     existsSync(join(cfgDropDir, "0995_app.cfg")));
  const wrongExt = { id: 11, decision_package: { ...pkg, options: [
    { ...pkg.options[0], files: [
      { path: "migrations/0997_first.sql", label: "x", role: "apply", target: "cfgdrop", archive_name: "0997_first.sql" },
    ] }, ...pkg.options.slice(1)] } };
  let extErr = ""; try { D.archiveOptionFiles(wrongExt, "A", CTX); } catch (e) { extErr = e.message; }
  ok("⭐ a file outside the target's extension allowlist refuses (per-target exts gate)",
     /只接受 \.cfg/.test(extErr), extErr);
  const unknownTgt = { id: 12, decision_package: { ...pkg, options: [
    { ...pkg.options[0], files: [
      { path: "migrations/0997_first.sql", label: "x", role: "apply", target: "nosuch", archive_name: "0997_first.sql" },
    ] }, ...pkg.options.slice(1)] } };
  let tgtErr = ""; try { D.archiveOptionFiles(unknownTgt, "A", CTX); } catch (e) { tgtErr = e.message; }
  ok("⭐ an unknown target id refuses and names the declared ones (allowlist polarity)",
     /未知的 handoff 目标 "nosuch"/.test(tgtErr) && /default\/cfgdrop/.test(tgtErr), tgtErr);
  let noTgtErr = "";
  try { D.archiveOptionFiles(task, "A", { repoRoot: root, targets: [] }); } catch (e) { noTgtErr = e.message; }
  ok("⭐ zero configured targets = loud refusal (never a silent default directory)",
     /没有配置任何 handoff 目标/.test(noTgtErr), noTgtErr);
  // Legacy wire values normalize
  const legacyPkg = D.normalizeDecisionPackage({ options: [
    { key: "A", title: "t", kind: "sql_apply",
      sql_files: [{ path: "migrations/0998_test.sql", role: "apply" }] }] });
  ok("legacy kind sql_apply / key sql_files normalize to apply / files",
     legacyPkg.options[0].kind === "apply" && legacyPkg.options[0].files.length === 1);

  // Trap replay (measured): the apply body is ABSENT while a verification fragment
  // exists. The fragment stays viewable — but never becomes the only download.
  const fragment = join(dryrunVerify, "0119.sql");
  writeFileSync(fragment, "@@FRAGMENT@@\n", "utf8");
  const trapTask = { id: 82, decision_package: { ...pkg, options: [
    { ...pkg.options[0], files: [
      { path: "migrations/0119_supplier_failclosed.sql", label: "main file",
        role: "apply", archive_name: "0119_supplier_failclosed.sql" },
      { path: "tools/dryrun_verify/0119.sql", label: "verification fragment",
        role: "companion", archive_name: "0119.sql" },
    ] }, ...pkg.options.slice(1)] } };
  const trapPub = D.publicDecisionPackage(trapTask, CTX);
  const trapFiles = trapPub.options[0].files;
  ok("trap replay: main unavailable + fragment available => the option is still NOT ready",
     trapFiles[0].available === false && trapFiles[1].available === true && trapPub.options[0].ready === false);
  ok("the companion's public object has a view entrance only, no executable download entrance",
     trapFiles[1].executable === false && !!trapFiles[1].view_url && !Object.hasOwn(trapFiles[1], "download_url"));
  if (panelPresent) {
    const trapHtml = renderDecisionPanel({ ...trapTask, decision_package: trapPub });
    ok("DOM: the fragment shows its directory and 'non-executable · view only', and the page has no lone fragment download button",
       trapHtml.includes("tools/dryrun_verify/") && trapHtml.includes("非执行用 · 仅供查阅") &&
       trapHtml.includes('data-handoff-action="reference"') && !trapHtml.includes('data-handoff-action="download"') &&
       !/\sdownload="/.test(trapHtml), trapHtml);
  } else skip("DOM: fragment shows dir + view-only, no lone download button");

  const companionOnlyTask = { id: 83, decision_package: { ...pkg, options: [
    { ...pkg.options[0], files: [
      { path: "tools/dryrun_verify/0119.sql", label: "verification fragment",
        role: "companion", archive_name: "0119.sql" },
    ] }, ...pkg.options.slice(1)] } };
  const companionOnlyPub = D.publicDecisionPackage(companionOnlyTask, CTX);
  let companionOnlyError = "";
  try { D.archiveOptionFiles(companionOnlyTask, "A", CTX); }
  catch (e) { companionOnlyError = e.message; }
  ok("a companion-only apply option cannot impersonate an executable option",
     companionOnlyPub.options[0].ready === false && /非执行用 companion/.test(companionOnlyError), companionOnlyError);

  writeFileSync(join(migrations, "0119_supplier_failclosed.sql"), "select 119 as apply_ok;\n", "utf8");
  const positivePub = D.publicDecisionPackage(trapTask, CTX);
  ok("positive control: with the main file available the option is ready with an executable download",
     positivePub.options[0].ready === true && positivePub.options[0].files[0].executable === true &&
     !!positivePub.options[0].files[0].download_url);
  if (panelPresent) {
    const positiveHtml = renderDecisionPanel({ ...trapTask, decision_package: positivePub });
    ok("DOM positive control: exactly one executable download button, carrying the target label",
       (positiveHtml.match(/data-handoff-action="download"/g) || []).length === 1 &&
       (positiveHtml.match(/\sdownload="/g) || []).length === 1 &&
       positiveHtml.includes("→手交区"), positiveHtml.slice(0, 400));
  } else skip("DOM positive control: exactly one executable download button");

  // Negatives for the source-side gates.
  const outside = join(root, "src"); mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "0995_evil.sql"), "select 0;\n", "utf8");
  let outsideErr = "";
  try { D.resolveAttachment({ path: "src/0995_evil.sql" }, CTX); }
  catch (e) { outsideErr = e.message; }
  ok("an existing file OUTSIDE the allowed roots is refused (allowlist gate)",
     /不在允许目录内/.test(outsideErr), outsideErr);
  const dataDir = join(migrations, ".data"); mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, "0994_sneak.sql"), "select 0;\n", "utf8");
  let denyErr = "";
  try { D.resolveAttachment({ path: "migrations/.data/0994_sneak.sql" }, CTX); }
  catch (e) { denyErr = e.message; }
  ok("a .data/ path INSIDE an allowed root is refused (protected-directory deny)",
     /受保护目录/.test(denyErr), denyErr);

  const legacy = D.legacyDecisionPackage(
    "## 需要你确认\n旧卡摘要\n### 方案\n**A. 继续** ← **推荐**\n- 做什么: 交回\n- 代价: 一轮\n\n**B. 等待**\n- 做什么: 不动\n- 代价: 时间\n\n**C. 结案**\n- 做什么: 关闭\n- 代价: 风险");
  ok("a legacy markdown card still converts into readable A/B/C", legacy?.options.length === 3 && legacy.recommend === "A");
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log(`result: ${pass} PASS / ${fail} FAIL / ${skipped} SKIP${skipped ? " (panel pending)" : ""}`);
process.exit(fail ? 1 : 0);
