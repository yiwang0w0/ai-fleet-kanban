// clitest — the newcomer's path, measured: package.json, the node preflight predicate,
// `setup` (pure create, idempotent, never overwrites) and `reset` (fail-closed on every
// axis). Everything runs against temp files and a temp port; nothing here can reach a
// live board's data dir — reset is pointed at a temp BOARD_DATA_DIR and refuses when
// something listens on its (temp) port, which is exactly the property under test.
import { spawn, spawnSync } from "node:child_process";
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
     ["setup", "start", "reset", "doctor", "demo", "test"].every((k) => k in (pkg.scripts || {})));
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

// ── ⑤ demo: gate first, then the whole zero-token cycle on a throwaway board ─
//    The blessed path uses BOARD_ALLOW_UNPINNED — the isolated-harness hatch every
//    other harness uses — and BOARD_TEST_SHUTDOWN_MS so the server it starts stops
//    itself: no tree-kill, nothing leaks. The unblessed path must refuse BEFORE any
//    board starts, with the gate's own words.
console.log(NL + "[⑤ demo]");
{
  const src = readFileSync(join(ROOT, "cli", "demo.mjs"), "utf8");
  ok("⭐(structure) demo never sets the gate hatch itself", !/ALLOW_UNPINNED\s*[:=]/.test(src) && /source_gate/.test(src));
  const listening = (port) => new Promise((res) => {
    const s = createServer(); s.once("error", () => res(true)); s.listen(port, "127.0.0.1", () => s.close(() => res(false)));
  });
  const data = join(TMP, "demo-data"); mkdirSync(data, { recursive: true });
  const port = 48450 + Math.floor(Math.random() * 40);
  const base = `http://127.0.0.1:${port}`;
  const env = { BOARD_DATA_DIR: data, BOARD_PORT: String(port), BOARD_URL: base, BOARD_CONFIG: join(TMP, "none.json"),
                BOARD_GATED_SUBTREE: ".", PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" };
  const g = run("cli/demo.mjs", [], env);
  ok("⭐未 bless → exit 3,是源码闸自己的话,并给出 bless 命令", g.code === 3 && /REFUSED/.test(g.out) && /board\.py bless/.test(g.out), `code=${g.code} ${g.out.slice(0, 120)}`);
  ok("未 bless 时什么都没起(端口仍空)", !(await listening(port)));

  const envB = { ...process.env, ...env, BOARD_ALLOW_UNPINNED: "1", BOARD_TEST_SHUTDOWN_MS: "30000",
                 BOARD_POOL_TEST_MODE: "1", BOARD_POOL_TEST_PROBE: "ok" };
  const child = spawn(process.execPath, [join(ROOT, "cli", "demo.mjs")], { env: envB, windowsHide: true });
  let out = ""; child.stdout.on("data", (b) => out += b); child.stderr.on("data", (b) => out += b);
  const deadline = Date.now() + 26000; let waitingCard = null;
  while (Date.now() < deadline && !waitingCard) {
    try {
      const j = await (await fetch(base + "/api/tasks?archived=false")).json();
      waitingCard = (j.tasks || []).find((t) => t.status === "waiting" && t.waiting_for === "review") || null;
    } catch {}
    if (!waitingCard) await new Promise((r) => setTimeout(r, 400));
  }
  ok("⭐bless 通过 → 起板、种子、mock 一轮:一张卡落在 等待中/待验收(零 token)", !!waitingCard, waitingCard ? `#${waitingCard.id}` : out.slice(-300));
  const exited = await new Promise((res) => { const t = setTimeout(() => res(null), 40000); child.on("exit", (c) => { clearTimeout(t); res(c); }); });
  ok("server 到点自停后 demo 也退出(没有留下孤儿进程)", exited !== null, `exit=${exited}`);
  ok("demo 的收尾把面板地址和等待裁定的卡告诉了人", /面板/.test(out) && /等待你裁定/.test(out) && /human-gated/.test(out), out.slice(-200));
  ok("(前提)确实是 mock 跑的:输出里有 worker 的一轮日志", /--once|第 1\/3 次尝试|等待中\/待验收/.test(out));
}

// ── ⑥ bless says what it accepts ────────────────────────────────────────────
//    The ritual is unchanged (one manual command, no button); what changed is that the
//    person now sees the previous tree, the new tree and the diff between them before
//    the hash is written. accepted_rev is a tree object, so two of them diff directly.
console.log(NL + "[⑥ bless 说清它接受的是什么]");
{
  const PY = process.env.PYTHON || process.env.BOARD_PYTHON || "python";
  const data = join(TMP, "bless-data"); mkdirSync(data, { recursive: true });
  const env = { ...process.env, BOARD_DATA_DIR: data, BOARD_GATED_SUBTREE: ".", PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" };
  const bless = () => { const r = spawnSync(PY, [join(ROOT, "cli", "board.py"), "bless"], { encoding: "utf8", env, windowsHide: true, cwd: ROOT, timeout: 60000 }); return { code: r.status, out: (r.stdout || "") + (r.stderr || "") }; };
  const head = spawnSync("git", ["rev-parse", "HEAD:"], { encoding: "utf8", cwd: ROOT }).stdout.trim();
  const b1 = bless();
  ok("首次 bless:写下 HEAD 的树,并说明是首次", b1.code === 0 && existsSync(join(data, "accepted_rev")) &&
     readFileSync(join(data, "accepted_rev"), "utf8").trim() === head && /首次接受/.test(b1.out) && b1.out.includes(head), b1.out.slice(0, 200));
  const b2 = bless();
  ok("再 bless 同一棵树:说明与上次一致", b2.code === 0 && /一致/.test(b2.out));
  // A different tree object that exists even in a shallow CI checkout: a subdirectory's tree.
  const older = spawnSync("git", ["rev-parse", "HEAD:docs"], { encoding: "utf8", cwd: ROOT }).stdout.trim();
  writeFileSync(join(data, "accepted_rev"), older + NL);
  const b3 = bless();
  ok("⭐上次接受的树不同:打出两棵树之间的 diff --stat(你在接受什么,不再是一个裸哈希)",
     b3.code === 0 && /你正在接受的变化/.test(b3.out) && /files? changed|insertion|deletion/.test(b3.out) && b3.out.includes(older), b3.out.slice(0, 300));
  ok("并且写下了新的树", readFileSync(join(data, "accepted_rev"), "utf8").trim() === head);
}

try { rmSync(TMP, { recursive: true, force: true }); } catch {}
console.log(`${NL}${"─".repeat(56)}${NL}result: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
