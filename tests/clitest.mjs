// clitest — the newcomer's path, measured: package.json, the node preflight predicate,
// `setup` (pure create, idempotent, never overwrites) and `reset` (fail-closed on every
// axis). Everything runs against temp files and a temp port; nothing here can reach a
// live board's data dir — reset is pointed at a temp BOARD_DATA_DIR and refuses when
// something listens on its (temp) port, which is exactly the property under test.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, appendFileSync } from "node:fs";
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
  ok("engines.node is declared", pkg.engines?.node === ">=24.0.0", pkg.engines?.node);
  ok("no \"type\":\"module\" (core/store.js is CommonJS; .mjs files are explicit)", pkg.type === undefined);
  const missingFiles = (scripts) => {
    const missing = [];
    for (const [name, cmd] of Object.entries(scripts)) {
      for (const match of cmd.matchAll(/\bnode\s+([^&|;]+)/g)) {
        const args = match[1].trim().split(/\s+/);
        const files = args[0] === "--test" ? args.slice(1) : args.slice(0, 1);
        for (const file of files) if (!existsSync(join(ROOT, file))) missing.push(`${name}: ${file}`);
      }
    }
    return missing;
  };
  const missing = missingFiles(pkg.scripts || {});
  ok("node --test checks every file and still detects a missing second target",
    JSON.stringify(missingFiles({probe:"node --test tests/clitest.mjs tests/absent-fixture-file.mjs"})) === JSON.stringify(["probe: tests/absent-fixture-file.mjs"]));
  ok("every `node <file>` in scripts names an existing file", missing.length === 0, missing.join(", "));
  ok("setup / start / reset / doctor / test all present",
     ["setup", "start", "reset", "doctor", "demo", "test"].every((k) => k in (pkg.scripts || {})));
}

// ── ② node preflight predicate ──────────────────────────────────────────────
console.log(NL + "[② nodeTooOld — the one failure a newcomer could not read]");
{
  ok("v20.0.0 is too old", nodeTooOld("v20.0.0") === true);
  ok("v22.4.9 is too old (node:sqlite arrived in 22.5)", nodeTooOld("v22.4.9") === true);
  ok("v22.5.0 is too old (no SQLite transaction state)", nodeTooOld("v22.5.0") === true);
  ok("v22.16.0 is outside the supported Node 24 floor", nodeTooOld("v22.16.0") === true);
  ok("v23.11.0 is too old", nodeTooOld("v23.11.0") === true);
  ok("v24.0.0 meets the supported floor", nodeTooOld("v24.0.0") === false);
  ok("v24.16.0 is fine", nodeTooOld("v24.16.0") === false);
  ok("garbage does not block startup (availability check, not a safety gate)", nodeTooOld("weird") === false);
  ok("the running node passes its own check", nodeTooOld() === false, process.version);
}

// ── ③ setup: pure create, idempotent, never overwrites ─────────────────────
console.log(NL + "[③ setup]");
{
  const cfg = join(TMP, "fleet.config.json"), reg = join(TMP, "verify_registry.json");
  // No codex anywhere this run could look first (the host's own install must not leak in).
  const nowhere = join(TMP, "nowhere"); mkdirSync(nowhere);
  const env = { BOARD_CONFIG: cfg, BOARD_VERIFY_REGISTRY: reg, BOARD_CODEX_CMD: "", LOCALAPPDATA: nowhere };
  const example = JSON.parse(readFileSync(join(ROOT, "examples", "fleet.config.json"), "utf8"));
  const r1 = run("cli/setup.mjs", ["--no-doctor"], env);
  ok("first run exits 0", r1.code === 0, r1.out.slice(-200));
  const made = existsSync(cfg) ? JSON.parse(readFileSync(cfg, "utf8")) : {};
  ok("⭐creates fleet.config.json from the example with ONE executor line: Claude (a plain line on the default agent)",
     JSON.stringify(made.lines) === JSON.stringify([{ id: "claude", label: "Claude", hint: "通用任务,由 Claude Code 执行" }]),
     JSON.stringify(made.lines));
  ok("keeps the example's seats, routes, default agent and the whole-tree gate; drops the example's handoff dirs; codex stays locked",
     JSON.stringify(made.runtimes) === JSON.stringify(example.runtimes) && JSON.stringify(made.routes) === JSON.stringify(example.routes) &&
     JSON.stringify(made.default_agent) === JSON.stringify(example.default_agent) && made.gated_subtree === "." &&
     !("handoff_targets" in made) && !("codex_cmd" in made) && !("codex_released" in made) && !("repo" in made) && typeof made._setup === "string");
  ok("creates verify_registry.json from the example (store validates verify_cmd against it)", existsSync(reg) &&
     readFileSync(reg, "utf8") === readFileSync(join(ROOT, "examples", "verify_registry.example.json"), "utf8"));
  ok("prints what is left as node commands (PowerShell's default policy refuses npm.ps1): start in the background, open, stop, and bless",
     /node cli\/start\.mjs --background/.test(r1.out) && /node cli\/open\.mjs/.test(r1.out) && /node cli\/stop\.mjs/.test(r1.out) &&
     /bless/.test(r1.out), r1.out.slice(-400));
  ok("⭐closing text: confirming the version is the operator's own panel button (CLI optional), no 「不做成按钮」",
     /确认当前版本/.test(r1.out) && /你本人/.test(r1.out) && !/不做成按钮/.test(r1.out));
  ok("names the executor lines and warns that without --repo tasks run in the board's own folder",
     /执行线: Claude/.test(r1.out) && /没给 --repo/.test(r1.out));
  ok("says the doctor step was skipped, loudly", /--no-doctor/.test(r1.out));
  writeFileSync(cfg, '{"lines":[{"id":"mine"}]}');           // the operator edited it
  const r2 = run("cli/setup.mjs", ["--no-doctor"], env);
  ok("⭐second run exits 0 and does NOT overwrite the edited config", r2.code === 0 &&
     readFileSync(cfg, "utf8") === '{"lines":[{"id":"mine"}]}');
  ok("says 已存在,不覆盖 for both files", (r2.out.match(/已存在,不覆盖/g) || []).length === 2);
  const src = readFileSync(join(ROOT, "cli", "setup.mjs"), "utf8");
  ok("(structure) setup really spawns doctor when not skipped", /doctor\.mjs/.test(src) && /spawnSync/.test(src));

  // --repo must name a git work tree; a wrong one stops BEFORE anything is written.
  const cfg2 = join(TMP, "fleet2.config.json"), reg2 = join(TMP, "verify2.json");
  const env2 = { ...env, BOARD_CONFIG: cfg2, BOARD_VERIFY_REGISTRY: reg2 };
  const plain = join(TMP, "not-a-repo"); mkdirSync(plain);
  const bad = run("cli/setup.mjs", ["--no-doctor", "--repo", plain], env2);
  ok("⭐--repo on a folder that is not a git repository: exit 1, says so, writes nothing",
     bad.code === 1 && /不是 git 仓库/.test(bad.out) && !existsSync(cfg2) && !existsSync(reg2), `code=${bad.code}`);
  const missing = run("cli/setup.mjs", ["--no-doctor", "--repo", join(TMP, "absent")], env2);
  ok("--repo on a missing folder: exit 1, writes nothing", missing.code === 1 && /不存在/.test(missing.out) && !existsSync(cfg2));
  ok("an unknown flag is refused with the usage line", run("cli/setup.mjs", ["--no-doctor", "--frobnicate"], env2).code === 2);
  const own = run("cli/setup.mjs", ["--no-doctor", "--repo", ROOT], env2);
  const inside = run("cli/setup.mjs", ["--no-doctor", "--repo", join(ROOT, "core")], env2);
  ok("⭐--repo on the board's own folder (or inside it): exit 1, writes nothing — its commits would hold every line",
     own.code === 1 && inside.code === 1 && /看板自己的目录/.test(own.out) && !existsSync(cfg2), `codes=${own.code}/${inside.code}`);
  // --repo + --codex: the work tree is recorded and Codex gets a line and an unlocked seat.
  const work = join(TMP, "work repo"); mkdirSync(work);
  spawnSync("git", ["init", "-q", work], { windowsHide: true });
  const codexExe = join(TMP, "codex-bin", "codex.exe"); mkdirSync(dirname(codexExe)); writeFileSync(codexExe, "");
  const r3 = run("cli/setup.mjs", ["--no-doctor", "--repo", work, "--codex"], { ...env2, BOARD_CODEX_CMD: codexExe });
  const made3 = existsSync(cfg2) ? JSON.parse(readFileSync(cfg2, "utf8")) : {};
  ok("⭐--repo + --codex: repo recorded; lines Claude + Codex (codex seat, its first model, high); codex_cmd + codex_released written",
     r3.code === 0 && made3.repo === work && made3.lines?.map((l) => l.id).join() === "claude,codex" &&
     JSON.stringify(made3.lines[1].role) === JSON.stringify({ seat: { runtime: "codex", model: example.runtimes.find((x) => x.id === "codex").models[0].id, effort: "high" } }) &&
     made3.codex_cmd === codexExe && made3.codex_released === true && /执行线: Claude、Codex/.test(r3.out),
     `code=${r3.code} ${r3.out.slice(-200)}`);
  const r4 = run("cli/setup.mjs", ["--no-doctor", "--codex"], { ...env2, BOARD_CODEX_CMD: codexExe });
  ok("--codex on an existing config changes nothing and says how to edit it instead",
     r4.code === 0 && JSON.stringify(JSON.parse(readFileSync(cfg2, "utf8"))) === JSON.stringify(made3) && /只在新建配置时生效/.test(r4.out));
}

// ── ③b the codex switches reach the clients through the config (env still wins) ─
console.log(NL + "[③b codex_cmd / codex_released → env]");
{
  const cfg = join(TMP, "seat.config.json");
  writeFileSync(cfg, JSON.stringify({ lines: [{ id: "a" }], codex_cmd: "C:/x/codex.exe", codex_released: true }));
  const probe = 'import("./core/env.mjs").then(m=>{m.applyConfigDefaults();console.log(JSON.stringify([process.env.BOARD_CODEX_CMD,process.env.BOARD_CODEX_RELEASED]))})';
  const read = (env) => JSON.parse(spawnSync(process.execPath, ["-e", probe], { cwd: ROOT, encoding: "utf8", windowsHide: true,
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("BOARD_CODEX"))), BOARD_CONFIG: cfg, ...env } }).stdout.trim());
  ok("config true → BOARD_CODEX_RELEASED=1, codex_cmd → BOARD_CODEX_CMD", JSON.stringify(read({})) === JSON.stringify(["C:/x/codex.exe", "1"]));
  ok("env set → env wins", JSON.stringify(read({ BOARD_CODEX_CMD: "D:/y.exe", BOARD_CODEX_RELEASED: "0" })) === JSON.stringify(["D:/y.exe", "0"]));
  writeFileSync(cfg, JSON.stringify({ lines: [{ id: "a" }], codex_released: false }));
  ok("config false → left unset (the seat stays locked)", JSON.stringify(read({})) === "[null,null]");
  // A board that respawns itself (no wrapper) must not hand what it only BACKFILLED to its
  // successor as env — env wins, and an edited config would be ignored after the restart.
  const filled = spawnSync(process.execPath, ["-e", 'import("./core/env.mjs").then(m=>{process.env.BOARD_CODEX_CMD="pre-set";console.log(JSON.stringify(m.backfillEnv({codex_cmd:"x",codex_released:true},m.SEAT_KEYS)))})'],
    { cwd: ROOT, encoding: "utf8", windowsHide: true, env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("BOARD_CODEX"))) }).stdout.trim();
  ok("backfillEnv names exactly the env vars it set (not ones already set)", filled === '["BOARD_CODEX_RELEASED"]', filled);
  const srv = readFileSync(join(ROOT, "core", "server.mjs"), "utf8");
  ok("(structure) the respawned successor's env drops the backfilled keys",
     /const BACKFILLED = backfillEnv\(CFG, SEAT_KEYS\)/.test(srv) && /for \(const k of BACKFILLED\) delete env\[k\];/.test(srv));
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
  const childExit = new Promise((resolve) => child.once("exit", (code, signal) => resolve({code, signal})));
  let out = ""; child.stdout.on("data", (b) => out += b); child.stderr.on("data", (b) => out += b);
  const deadline = Date.now() + 26000; let waitingCard = null;
  while (Date.now() < deadline && !waitingCard) {
    try {
      const j = await (await fetch(base + "/api/tasks?archived=false", {headers:{"X-Board-Token":readFileSync(join(data,"board_token"),"utf8").trim()}})).json();
      waitingCard = (j.tasks || []).find((t) => t.status === "waiting" && t.waiting_for === "review") || null;
    } catch {}
    if (!waitingCard) await new Promise((r) => setTimeout(r, 400));
  }
  ok("⭐bless 通过 → 起板、种子、mock 一轮:一张卡落在 等待中/待验收(零 token)", !!waitingCard, waitingCard ? `#${waitingCard.id}` : out.slice(-300));
  let exitTimer;
  const exited = await Promise.race([childExit, new Promise((res) => { exitTimer = setTimeout(() => res(null), 40000); })]);
  clearTimeout(exitTimer);
  ok("server 到点自停后 demo 正常退出且端口关闭", exited?.code === 0 && exited?.signal === null && !(await listening(port)), `exit=${JSON.stringify(exited)}`);
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

// ⑦ `npm start` = cli/start.mjs (v0.18): the board exits 75 when the panel asks for a
//    restart and the wrapper relaunches it in place — same terminal, same stdio. Measured
//    against a stub that exits 75 on its first boot only; any other code passes through.
console.log(NL + "[⑦ start.mjs 守护:exit 75 原地重起,其他码透传]");
{
  const stub = join(TMP, "stub-server.mjs");
  writeFileSync(stub, [
    'console.log(`boot supervised=${process.env.BOARD_SUPERVISED} from=${process.env.BOARD_RESTARTED_FROM || "-"}`);',
    'if (!process.env.BOARD_RESTARTED_FROM) process.exit(75);',
    'console.log("second boot ok"); process.exit(0);',
  ].join(NL));
  const run = (script) => spawnSync(process.execPath, [join(ROOT, "cli", "start.mjs")],
    { encoding: "utf8", env: { ...process.env, BOARD_SERVER_SCRIPT: script }, windowsHide: true, timeout: 30000 });
  const r = run(stub);
  ok("⭐子进程 exit 75 → 守护在原地重起它一次(带 BOARD_SUPERVISED=1 / BOARD_RESTARTED_FROM),最终码 0",
     r.status === 0 && /boot supervised=1 from=-/.test(r.stdout) && /看板请求重启/.test(r.stdout) &&
     /boot supervised=1 from=supervised/.test(r.stdout) && /second boot ok/.test(r.stdout),
     `status=${r.status} out=${(r.stdout || "").replace(/\s+/g, " ").slice(0, 160)}`);
  const stub3 = join(TMP, "stub-exit3.mjs");
  writeFileSync(stub3, 'console.log("boot once"); process.exit(3);');
  const r3 = run(stub3);
  ok("其他退出码(闸门拒启的 3)透传,不重起", r3.status === 3 && !/看板请求重启/.test(r3.stdout) &&
     (r3.stdout.match(/boot once/g) || []).length === 1, `status=${r3.status}`);
  // ⭐ v0.19: a board that asks to be restarted every time it comes up must not loop forever.
  const stub75 = join(TMP, "stub-always75.mjs");
  writeFileSync(stub75, 'console.log("boot"); process.exit(75);');
  const r75 = run(stub75);
  ok("⭐子进程每次都 exit 75 → 60 秒内超过 5 次就放弃(exit 1,说明原因),不无限重起",
     r75.status === 1 && /不再重起/.test(r75.stdout + r75.stderr) && (r75.stdout.match(/boot/g) || []).length <= 7,
     `status=${r75.status} boots=${(r75.stdout.match(/boot/g) || []).length}`);
  ok("守护把 BOARD_RESTART_MODE 钉成 exit(用户 env 里的 respawn 不会和守护打架)",
     /BOARD_RESTART_MODE: "exit"/.test(readFileSync(join(ROOT, "cli", "start.mjs"), "utf8")), "");
}

// ⑧ `npm run start:bg` / `npm run open` / `npm run stop` — the commands INSTALL.md has the
//    operator's AI run. Measured against a stub board (BOARD_SERVER_SCRIPT) that answers
//    /health, hands out a pairing code and stops on request, both only with the operator token
//    from the data dir; the real endpoints are measured in panelauth.test.mjs.
console.log(NL + "[⑧ start:bg / open / stop]");
{
  const data = join(TMP, "bg-data"); mkdirSync(data);
  writeFileSync(join(data, "board_token"), "stub-operator-token");
  const port = await new Promise((r) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
  const stub = join(TMP, "stub-board.mjs");
  writeFileSync(stub, [
    'import http from "node:http"; import { readFileSync, existsSync } from "node:fs"; import { join } from "node:path";',
    'const D = process.env.BOARD_DATA_DIR, T = readFileSync(join(D, "board_token"), "utf8").trim();',
    'console.log(`stub boot supervised=${process.env.BOARD_SUPERVISED}`);',
    'const send = (res, code, v) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(v)); };',
    'http.createServer((req, res) => { let b = ""; req.on("data", (c) => b += c); req.on("end", () => {',
    '  if (req.url === "/health") return send(res, 200, { status: "ok" });',
    '  if (req.headers["x-board-token"] !== T) return send(res, 401, { error: "token" });',
    '  if (req.method === "POST" && req.url === "/api/pair/code") return send(res, 201, { code: "123456" });',
    '  if (req.method === "POST" && req.url === "/api/pair/revoke") return send(res, 200, { revoked: JSON.parse(b || "{}").all === true ? 2 : 0 });',
    '  if (req.method === "POST" && req.url === "/api/setup/stop") {',
    '    if (existsSync(join(D, "inflight")) && !JSON.parse(b || "{}").force) return send(res, 409, { error: "有 1 张卡正在跑", needs_force: true, in_progress: 1 });',
    '    send(res, 202, { stopping: true }); setTimeout(() => process.exit(0), 50); return; }',
    '  send(res, 404, {}); }); }).listen(Number(process.env.BOARD_PORT), "127.0.0.1");',
  ].join(NL));
  const env = { ...process.env, BOARD_SERVER_SCRIPT: stub, BOARD_PORT: String(port), BOARD_DATA_DIR: data,
                BOARD_CONFIG: join(TMP, "none.json"), BOARD_URL: "" };
  const cli = (script, args = [], extra = {}) => {
    const r = spawnSync(process.execPath, [join(ROOT, "cli", script), ...args],
      { encoding: "utf8", env: { ...env, ...extra }, windowsHide: true, timeout: 90000 });
    return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
  };
  const up = async () => { try { return (await fetch(`http://127.0.0.1:${port}/health`)).ok; } catch { return false; } };
  const bg = cli("start.mjs", ["--background"]);
  ok("⭐start --background returns once /health answers, names the address and the log, and the board keeps running",
     bg.code === 0 && bg.out.includes(`http://127.0.0.1:${port}`) && /board\.log/.test(bg.out) && await up(), bg.out.slice(-200));
  ok("the background board runs under the same wrapper (BOARD_SUPERVISED=1), its output in <data>/board.log",
     /stub boot supervised=1/.test(readFileSync(join(data, "board.log"), "utf8")));
  const again = cli("start.mjs", ["--background"]);
  ok("a second start:bg sees the running board and starts nothing", again.code === 0 && /已经在运行/.test(again.out) &&
     (readFileSync(join(data, "board.log"), "utf8").match(/stub boot/g) || []).length === 1);
  const link = cli("open.mjs", ["--print"]);
  ok("⭐open --print: asks the board for a one-time code with the operator token and prints <board>/#pair=<code>",
     link.code === 0 && link.out.trim() === `http://127.0.0.1:${port}/#pair=123456`, link.out.trim());
  const forgot = cli("open.mjs", ["--forget-browsers"]);
  ok("open --forget-browsers revokes every browser's panel credential with the operator token",
     forgot.code === 0 && /已撤销 2 个浏览器/.test(forgot.out), forgot.out.trim());
  ok("open with a wrong token stops with the board's refusal (no link)",
     (() => { const d2 = join(TMP, "bg-data-2"); mkdirSync(d2); writeFileSync(join(d2, "board_token"), "wrong");
              const r = cli("open.mjs", ["--print"], { BOARD_DATA_DIR: d2 }); return r.code === 1 && !/#pair=/.test(r.out); })());
  writeFileSync(join(data, "inflight"), "");
  const held = cli("stop.mjs");
  ok("⭐stop with a card in flight: refuses, says how to force it, the board keeps running",
     held.code === 1 && /--force/.test(held.out) && await up(), held.out.slice(-160));
  const stopped = cli("stop.mjs", ["--force"]);
  ok("⭐stop --force: the board stops and the command waits until it no longer answers",
     stopped.code === 0 && /已停止/.test(stopped.out) && !(await up()), stopped.out.slice(-160));
  ok("stop with nothing running says so and exits 0", (() => { const r = cli("stop.mjs"); return r.code === 0 && /没有在运行/.test(r.out); })());
  // The log already holds earlier runs in Chinese (3 bytes a character): the tail is cut by
  // bytes, then decoded — cutting the decoded text at a byte offset lost this run's lines.
  appendFileSync(join(data, "board.log"), "看板已启动,端口与数据目录都正常。\n".repeat(40));
  const dead = join(TMP, "stub-dies.mjs");
  writeFileSync(dead, 'console.log("端口已被占用,看板起不来"); process.exit(3);');
  const failed = cli("start.mjs", ["--background"], { BOARD_SERVER_SCRIPT: dead });
  ok("⭐a board that dies on boot: start:bg exits 1 and prints that run's log lines (not earlier runs', not none)",
     failed.code === 1 && /退出码 3/.test(failed.out) && /端口已被占用,看板起不来/.test(failed.out) && !/端口与数据目录都正常/.test(failed.out),
     failed.out.slice(-200));
}

try { rmSync(TMP, { recursive: true, force: true }); } catch {}
console.log(`${NL}${"─".repeat(56)}${NL}result: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
