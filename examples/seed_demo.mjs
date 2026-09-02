// Seed a fresh board with a small demo chain: one goal, three cards, one of them
// human-gated. `node examples/seed_demo.mjs` against a RUNNING board.
//
// Refuses a board that already has cards: demo data mixed into a live board is
// noise nobody asked for, and "run the demo" must never mutate real work.

import { readFileSync } from "node:fs";

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { applyConfigDefaults } from "../core/env.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
applyConfigDefaults();   // fleet.config 的 port 等回填 env 缺省(env 已设者优先)
// Everything lives in main() so a refusal is a RETURN, not a process.exit():
// on Windows, exiting (or throwing) while fetch keep-alive sockets are live dies
// of 0xC0000409 AFTER printing — right words, lying exit code (measured, twice).
// A return lets the runtime drain naturally; the code below is the verdict.
async function main() {
// ⚠ BOARD_PORT is honoured too: the preflight tells you to set it on a port
//   clash, and a client that ignores it goes knocking on the DEFAULT port —
//   which on a shared machine can be somebody else's live board (measured: a
//   blind install test aimed this seed at a production board; only the
//   empty-board guard stopped it).
const BASE = process.env.BOARD_URL
  || (process.env.BOARD_PORT ? `http://127.0.0.1:${process.env.BOARD_PORT}` : "http://127.0.0.1:47824");
const DATA = process.env.BOARD_DATA_DIR || join(ROOT, "core", ".data");

let TOKEN = "";
try { TOKEN = readFileSync(join(DATA, "board_token"), "utf8").trim(); }
catch {
  console.error(`读不到令牌(${join(DATA, "board_token")})—— 板起来了吗?先 node core/server.mjs`);
  return 1;
}
const api = async (m, p, b) => {
  const r = await fetch(BASE + p, { method: m,
    headers: { "Content-Type": "application/json", "X-Board-Token": TOKEN },
    body: m === "GET" ? undefined : JSON.stringify(b ?? {}) });
  let j = null; try { j = await r.json(); } catch {}
  if (r.status >= 400) { console.error(`${m} ${p} → ${r.status}`, JSON.stringify(j)); throw new Error("api " + r.status); }
  return j;
};

// The demo speaks the BOARD's own vocabulary: the first configured line, whatever
// it is. Hardcoding a line name broke the moment step 1's example config (with
// its own line ids) was installed — the seed 400'd on a name the board never had.
const LINE = ((await api("GET", "/api/workers")).lines || [])[0];
if (!LINE) { console.error("看板没有配置任何线 —— fleet.config.json 的 lines[] 是空的?"); return 1; }

const existing = await api("GET", "/api/tasks?archived=false");
if ((existing.tasks || []).length) {
  console.error(`看板上已有 ${existing.tasks.length} 张卡 —— 演示数据只种入空板(不与真实工作混放)。`);
  console.error(`要重新演示:换一个 BOARD_DATA_DIR 另起一块新板。`);
  return 1;
}

const goal = (await api("POST", "/api/tasks", {
  subject: "演示目标:完整跑通一次流程",
  kind: "goal", line: LINE,
  description: "这是演示数据(examples/seed_demo.mjs)。三张卡走完:认领 → 交付 → 待验收 → 人工裁定。",
  humanGate: false,
})).task.id;

const a = (await api("POST", "/api/tasks", {
  subject: "写一份 hello 证据",
  line: LINE, parentId: goal, humanGate: false,
  description: "任何 worker 领到这张卡,把证据写进循环指定的文件即算交付。",
  acceptance: "证据文件存在且非空。",
})).task.id;

const b = (await api("POST", "/api/tasks", {
  subject: "再写一份,试试链",
  line: LINE, parentId: goal, humanGate: false,
  description: "第二张卡。提示词中的同链一览会包含 #" + a + "。",
  acceptance: "证据文件存在且非空。",
})).task.id;

const c = (await api("POST", "/api/tasks", {
  subject: "需要人裁定的卡(演示 human gate)",
  line: LINE, parentId: goal, humanGate: true,
  description: "这张卡被 human_gate 锁定:worker 无法认领,也不消耗 attempts。请在面板上解锁或直接裁定 —— 裁量权保留在人工侧。",
})).task.id;

console.log(`已种下演示链:目标 #${goal},卡 #${a} #${b}(可领)、#${c}(human-gated,worker 领不到)。`);
console.log("");
console.log("接下来,任选一条路看它跑:");
console.log("  · 面板:打开 " + BASE + " —— 三张卡都在「未开始」");
console.log("  · mock 流程(不消耗 token):");
// ⚠ The printed commands must carry the ADDRESS when it is not the default —
//   the blind test copied these against a moved board and knocked on 47824 again.
const envPrefix = process.env.BOARD_URL ? `BOARD_URL=${BASE} ` :
  process.env.BOARD_PORT ? `BOARD_PORT=${process.env.BOARD_PORT} ` : "";
console.log('      ' + envPrefix + 'WORKER_CLI_ARGV=\'["python","examples/mock_worker_cli.py"]\' \\');
console.log("      python loops/worker_loop.py --as " + LINE + " --once");
console.log("  · 真实 CLI 流程:" + envPrefix + "python loops/worker_loop.py --as " + LINE + " --once");
console.log("交付后卡会落在「等待中/待验收」—— 在面板上裁定后,本次流程即完成。");
  return 0;
}

process.exitCode = await main().catch((e) => { console.error(String(e && e.message || e)); return 1; });
