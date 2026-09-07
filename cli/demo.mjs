// `node cli/demo.mjs` (= `npm run demo`) — the zero-token first cycle in one command:
// board up (or reuse the one already running) → seed the demo chain → run the mock
// worker once → say which card is now waiting for YOUR ruling. It is QUICKSTART §3–§4
// typed for you; nothing is skipped, every part is the same script a person would run.
//
// What it refuses, and why:
//   · an unblessed tree. The same source gate the loops run (gates_lib.source_gate) is
//     asked FIRST, so the refusal comes before anything starts and reads the same. There
//     is no demo flag that routes around it — accepting the tree is yours (v0.6 ruling),
//     and a "newcomer mode" that skips a gate teaches the wrong first lesson.
//   · a board that already has cards. seed_demo refuses those (demo data never mixes
//     into real work), and this command then STOPS rather than point a mock worker at
//     real cards. Start over with `npm run reset -- --yes` (board stopped) if you mean it.
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { connect } from "node:net";
import { CODE_ROOT, applyConfigDefaults } from "../core/env.mjs";

const cfg = applyConfigDefaults();
const PORT = Number(process.env.BOARD_PORT || 47824);
const BASE = process.env.BOARD_URL || `http://127.0.0.1:${PORT}`;
const DATA = process.env.BOARD_DATA_DIR || join(CODE_ROOT, "core", ".data");
// The gate guards the GOVERNANCE code — this board's own tree — never the work repo.
const SUBTREE = process.env.BOARD_GATED_SUBTREE || (cfg.gated_subtree ? String(cfg.gated_subtree) : "");
const PY = process.env.BOARD_PYTHON || process.env.PYTHON || "python";
const pyEnv = { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1", BOARD_DATA_DIR: DATA, BOARD_URL: BASE };
const say = (s = "") => console.log(s);

// ── ① the source gate, first, in its own words ──────────────────────────────
{
  const code = [
    "import sys",
    `sys.path.insert(0, ${JSON.stringify(join(CODE_ROOT, "gates"))})`,
    "import gates_lib",
    `r = gates_lib.source_gate(${JSON.stringify(CODE_ROOT)}, ${JSON.stringify(DATA)}, ${JSON.stringify(SUBTREE)} or None, log=lambda *a, **k: None)`,
    "print('OK' if r is None else r)",
  ].join("; ");
  const g = spawnSync(PY, ["-c", code], { encoding: "utf8", env: pyEnv, windowsHide: true, timeout: 60000 });
  if (g.error || g.status !== 0) {
    say(`跑不了 python(${PY}):${(g.error && g.error.message) || (g.stderr || "").trim()}`);
    say("设 BOARD_PYTHON 指向解释器;node cli/doctor.mjs 会告诉你它找到了谁。");
    process.exit(1);
  }
  const verdict = (g.stdout || "").trim();
  if (verdict !== "OK") {
    say(verdict);
    say();
    say("演示走的是同一道源码闸 —— 先接受这棵树:   python cli/board.py bless");
    say("(没有绕闸的演示模式:接受代码是人的动作。)");
    process.exit(3);
  }
}

// ── ② a board: reuse the one answering, or start one ────────────────────────
const listening = () => new Promise((res) => {
  const s = connect({ host: "127.0.0.1", port: PORT });
  s.once("connect", () => { s.destroy(); res(true); });
  s.once("error", () => res(false));
  s.setTimeout(1500, () => { s.destroy(); res(false); });
});
const alive = async () => { try { return (await fetch(BASE + "/api/meta")).ok; } catch { return false; } };
let srv = null;
if (await listening()) {
  say(`② 复用已经在 ${BASE} 应答的板`);
} else {
  say(`② 起板  node core/server.mjs  → ${BASE}`);
  srv = spawn(process.execPath, [join(CODE_ROOT, "core", "server.mjs")], { stdio: ["ignore", "inherit", "inherit"], env: process.env, windowsHide: true });
  const t0 = Date.now();
  while (!(await alive())) {
    if (srv.exitCode != null) { say("板没起来(见上方输出)。"); process.exit(1); }
    if (Date.now() - t0 > 20000) { say("等了 20 秒板还没应答 —— 放弃。"); srv.kill(); process.exit(1); }
    await new Promise((r) => setTimeout(r, 300));
  }
}
const bail = (code) => { if (srv) srv.kill(); process.exit(code); };

// ── ③ seed — refuses a non-empty board, and so do we ────────────────────────
say("③ 种演示链  node examples/seed_demo.mjs");
const seed = spawnSync(process.execPath, [join(CODE_ROOT, "examples", "seed_demo.mjs")], { stdio: "inherit", env: process.env, windowsHide: true });
if (seed.status !== 0) {
  say();
  say("演示只在空板上跑 —— 板上已有卡,不会拿 mock worker 去碰真实工作。");
  say("确实想重来:先停板,再  npm run reset -- --yes");
  bail(1);
}

// ── ④ one mock cycle, zero tokens ───────────────────────────────────────────
let line = null;
try { line = ((await (await fetch(BASE + "/api/workers")).json()).lines || [])[0] || null; } catch {}
if (!line) { say("看板没有配置任何线。"); bail(1); }
say(`④ mock worker 领一张、交一张  python loops/worker_loop.py --as ${line} --once`);
const mock = spawnSync(PY, [join(CODE_ROOT, "loops", "worker_loop.py"), "--as", line, "--once"], {
  stdio: "inherit", windowsHide: true, cwd: CODE_ROOT,
  env: { ...pyEnv, WORKER_CLI_ARGV: JSON.stringify([PY, join(CODE_ROOT, "examples", "mock_worker_cli.py")]) },
});
if (mock.status !== 0) { say(`mock 轮退出码 ${mock.status} —— 上面是它自己的话(exit 3 = 闸拒绝,不是崩溃)。`); bail(mock.status || 1); }

// ── ⑤ where you come in ─────────────────────────────────────────────────────
let waiting = [];
try { waiting = ((await (await fetch(BASE + "/api/tasks?archived=false")).json()).tasks || []).filter((t) => t.status === "waiting"); } catch {}
say();
say("完整的一轮到这里为止是机器的;下一步是你的:");
say(`  面板  ${BASE}`);
if (waiting.length) say(`  等待你裁定的卡:${waiting.map((t) => `#${t.id}(${t.waiting_for})`).join(" ")} —— 卡面上就是裁定按钮`);
say("  human-gated 的那张 worker 领不到,也不消耗 attempts —— 那是给你留的。");
if (srv) {
  say();
  say("板继续跑着(Ctrl+C 停)。");
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { srv.kill(); process.exit(0); });
  srv.on("exit", (c) => process.exit(c || 0));
}
