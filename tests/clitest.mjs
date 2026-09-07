// clitest — the newcomer's path, measured: package.json, the node preflight predicate,
// `setup` (pure create, idempotent, never overwrites) and `reset` (fail-closed on every
// axis). Everything runs against temp files and a temp port; nothing here can reach a
// live board's data dir — reset is pointed at a temp BOARD_DATA_DIR and refuses when
// something listens on its (temp) port, which is exactly the property under test.
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { nodeTooOld } from "../core/env.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const TMP = mkdtempSync(join(tmpdir(), "clitest-"));
let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? " — " + detail : ""}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`); }
};
const run = (script, args = [], env = {}) => {
  const r = spawnSync(process.execPath, [join(ROOT, script), ...args],
    { encoding: "utf8", env: { ...process.env, ...env }, windowsHide: true, timeout: 120000 });
  return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
};
const NL = String.fromCharCode(10);

// ── ① package.json: zero deps, scripts point at files that exist ────────────
console.log(NL + "[① package.json]");
{
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  ok("no dependencies of any kind (zero-dependency is a deployment property)",
     !pkg.dependencies && !pkg.devDependencies && !pkg.peerDependencies);
  ok("engines.node is declared", typeof pkg.engines?.node === "string" && /22/.test(pkg.engines.node), pkg.engines?.node);
  ok("no \"type\":\"module\" (core/store.js is CommonJS; .mjs files are explicit)", pkg.type === undefined);
  const missing = [];
  for (const [name, cmd] of Object.entries(pkg.scripts || {}))
    for (const m of cmd.matchAll(/node\s+([^\s&|;]+)/g))
      if (!existsSync(join(ROOT, m[1]))) missing.push(`${name}: ${m[1]}`);
  ok("every `node <file>` in scripts names an existing file", missing.length === 0, missing.join(", "));
  ok("setup / start / reset / doctor / test all present",
     ["setup", "start", "reset", "doctor", "test"].every((k) => k in (pkg.scripts || {})));
}

// ── ② node preflight predicate ──────────────────────────────────────────────
console.log(NL + "[② nodeTooOld — the one failure a newcomer could not read]");
{
  ok("v20.0.0 is too old", nodeTooOld("v20.0.0") === true);
  ok("v22.4.9 is too old (node:sqlite arrived in 22.5)", nodeTooOld("v22.4.9") === true);
  ok("v22.5.0 is fine", nodeTooOld("v22.5.0") === false);
  ok("v24.16.0 is fine", nodeTooOld("v24.16.0") === false);
  ok("garbage does not block startup (availability check, not a safety gate)", nodeTooOld("weird") === false);
  ok("the running node passes its own check", nodeTooOld() === false, process.version);
}

// ── ③ setup: pure create, idempotent, never overwrites ─────────────────────
console.log(NL + "[③ setup]");
{
  const cfg = join(TMP, "fleet.config.json"), reg = join(TMP, "verify_registry.json");
  const env = { BOARD_CONFIG: cfg, BOARD_VERIFY_REGISTRY: reg };
  const r1 = run("cli/setup.mjs", ["--no-doctor"], env);
  ok("first run exits 0", r1.code === 0, r1.out.slice(-200));
  ok("creates fleet.config.json from the example", existsSync(cfg) &&
     readFileSync(cfg, "utf8") === readFileSync(join(ROOT, "examples", "fleet.config.json"), "utf8"));
  ok("creates verify_registry.json from the example (store validates verify_cmd against it)", existsSync(reg) &&
     readFileSync(reg, "utf8") === readFileSync(join(ROOT, "examples", "verify_registry.example.json"), "utf8"));
  ok("prints the two human steps: bless, then start", /bless/.test(r1.out) && /npm start/.test(r1.out));
  ok("says the doctor step was skipped, loudly", /--no-doctor/.test(r1.out));
  writeFileSync(cfg, '{"lines":[{"id":"mine"}]}');           // the operator edited it
  const r2 = run("cli/setup.mjs", ["--no-doctor"], env);
  ok("⭐second run exits 0 and does NOT overwrite the edited config", r2.code === 0 &&
     readFileSync(cfg, "utf8") === '{"lines":[{"id":"mine"}]}');
  ok("says 已存在,不覆盖 for both files", (r2.out.match(/已存在,不覆盖/g) || []).length === 2);
  const src = readFileSync(join(ROOT, "cli", "setup.mjs"), "utf8");
  ok("(structure) setup really spawns doctor when not skipped", /doctor\.mjs/.test(src) && /spawnSync/.test(src));
}

// ── ④ reset: fail-closed on every axis ──────────────────────────────────────
console.log(NL + "[④ reset]");
{
  const data = join(TMP, "data"); mkdirSync(join(data, "evidence"), { recursive: true });
  writeFileSync(join(data, "board.db"), "x"); writeFileSync(join(data, "board_token"), "t");
  writeFileSync(join(data, "evidence", "task-1-attempt-1.md"), "e");
  const port = 48300 + Math.floor(Math.random() * 100);
  const env = { BOARD_DATA_DIR: data, BOARD_PORT: String(port), BOARD_CONFIG: join(TMP, "none.json") };
  const dry = run("cli/reset.mjs", [], env);
  ok("⭐without --yes: lists and exits 2, deletes nothing", dry.code === 2 && existsSync(join(data, "board.db")) &&
     /board\.db/.test(dry.out) && /--yes/.test(dry.out), `code=${dry.code}`);
  const srv = createServer(); await new Promise((r) => srv.listen(port, "127.0.0.1", r));
  const busy = run("cli/reset.mjs", ["--yes"], env);
  ok("⭐with --yes but the board's port is answering: refuses, deletes nothing",
     busy.code === 1 && existsSync(join(data, "board.db")) && /先停板/.test(busy.out), `code=${busy.code}`);
  await new Promise((r) => srv.close(r));
  const root = run("cli/reset.mjs", ["--yes"], { ...env, BOARD_DATA_DIR: "/" });
  ok("a data dir that resolves to a root is refused", root.code === 1 && /不像一个看板的数据目录/.test(root.out));
  const wipe = run("cli/reset.mjs", ["--yes"], env);
  ok("⭐with --yes and nothing listening: empties the data dir", wipe.code === 0 && existsSync(data) && readdirSync(data).length === 0, wipe.out.slice(-120));
  ok("tells the operator to re-bless (accepted_rev is gone with the rest)", /bless/.test(wipe.out));
  const again = run("cli/reset.mjs", ["--yes"], env);
  ok("(idempotent) an empty dir is reported as already empty, exit 0", again.code === 0 && /已经是空的/.test(again.out));
}

try { rmSync(TMP, { recursive: true, force: true }); } catch {}
console.log(`${NL}${"─".repeat(56)}${NL}result: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
