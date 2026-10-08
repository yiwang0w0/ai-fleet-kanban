// `npm run stop` (= node cli/stop.mjs [--force]) — stop the board on this machine, the way
// Ctrl+C would: lines stop with their intent kept, so the next start brings them back.
// A card in flight would be interrupted (it returns to 「未开始」 and its line claims it
// again later), so that needs --force — the same question the panel's restart asks.
import { boardUp, localBoard, sleep } from "../core/local-board.mjs";

const force = process.argv.includes("--force");
const { url, token } = localBoard();
if (!(await boardUp(url))) { console.log(`看板没有在运行(${url})`); process.exit(0); }
let r;
try {
  r = await fetch(url + "/api/setup/stop", { method: "POST", signal: AbortSignal.timeout(10000),
    headers: { "X-Board-Token": token(), "Content-Type": "application/json" }, body: JSON.stringify({ force }) });
} catch (e) { console.error(`停不了: ${e.message}`); process.exit(1); }
const v = await r.json().catch(() => ({}));
if (r.status === 409 && v.needs_force) {
  console.log(`${v.error}\n确定要停:node cli/stop.mjs --force`);
  process.exit(1);
}
if (r.status !== 202) { console.error(`停不了(${r.status}): ${v.error || "看板没有接受停止请求"}`); process.exit(1); }
for (let waited = 0; waited < 20_000; waited += 300) {
  await sleep(300);
  if (!(await boardUp(url, 800))) { console.log("看板已停止。再起: npm run start:bg"); process.exit(0); }
}
console.error(`看板说在停,但 20 秒后 ${url} 还在应答 —— 看日志: ${localBoard().logFile}`);
process.exit(1);
