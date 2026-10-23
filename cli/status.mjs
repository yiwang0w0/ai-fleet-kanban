// `node cli/status.mjs` (= npm run status) — one place to see whether the board on this machine is
// running, what needs attention and what to do next. The words are the home page's own
// (core/home-model.mjs): the same merged alerts, the same next steps. Read-only: it starts, stops
// and repairs nothing — when the board is down it says so, shows the end of its log and names the
// command that brings it back.
//   exit code: 0 running, nothing marked red · 2 running, something red · 1 not running
import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
import { boardUp, localBoard } from "../core/local-board.mjs";
import { loadHomeModel } from "../core/home-model.mjs";

// Returns its exit code instead of calling process.exit(): see cli/open.mjs (Node 24 on Windows
// aborts in libuv when exiting that way after requests to a running board).
process.exitCode = await main();

async function main() {
  const { url, dataDir, logFile, token } = localBoard();
  if (!(await boardUp(url))) return notRunning(url, dataDir, logFile);
  let key;
  try { key = token(); }
  catch (e) { console.log(`本机:电脑在线 · 看板服务正常(${url})`); console.error(`  读不到更多状态: ${e.message}`); return 2; }
  const read = async (path) => {
    const r = await fetch(url + path, { signal: AbortSignal.timeout(10000), headers: { "X-Board-Token": key } });
    const v = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(v.error || `读取失败(${r.status})`), { status: r.status });
    return v;
  };
  const [setup, workers, meta, fleet, health] = await Promise.allSettled(
    ["/api/setup", "/api/workers", "/api/meta", "/api/fleet?limit=1", "/api/fleet/health"].map(read));
  const ok = (r) => (r.status === "fulfilled" ? r.value : null), why = (r) => (r.status === "rejected" ? r.reason.message : null);
  // 服务在线不等于状态可读；必需读取失败不能被可选的健康提醒掩盖。
  const unreadable = [["配置", setup], ["执行器", workers], ["本机状态", meta]].filter(([, r]) => r.status === "rejected");
  if (unreadable.length) {
    console.log(`本机:电脑在线 · 看板服务有应答(${url})`);
    const denied = unreadable.some(([, r]) => [401, 403].includes(r.reason?.status));
    console.error(`  ${denied ? "操作员授权未通过" : "状态读取受阻"}：${unreadable.map(([label, r]) => label + "（" + why(r) + "）").join("、")}`);
    console.log(denied ? "下一步:核对启动命令、数据目录和操作员授权，再重试；不要重建或公开令牌。" : "下一步:查看数据目录里的 board.log，排除读取问题后重试。");
    return 2;
  }
  const M = loadHomeModel(), name = ok(meta)?.node?.display_name, version = ok(setup)?.version;
  const s = M.homeStatus({ localName: name, nodes: ok(fleet)?.nodes || null, fleetError: why(fleet),
                           health: ok(health), healthError: why(health), setup: ok(setup) });
  console.log(`本机「${M.homeName(name, "本机")}」:电脑在线 · 看板服务正常(${url}${version ? ",版本 " + version : ""})`);
  const lines = linesNow(ok(workers));
  if (lines) console.log(`  执行线:${lines}`);
  console.log(`  ${s.line}`);
  for (const a of s.alerts) console.log(`  ${a.tone === "bad" ? "✗" : "!"} ${a.where}:${a.what} —— 下一步:${a.next}`);
  return s.alerts.some((a) => a.tone === "bad") ? 2 : 0;
}

/** Each configured line once, by its label: running if any of its slots runs. */
function linesNow(w) {
  if (!w || !Array.isArray(w.lines) || !w.lines.length) return "";
  const labels = w.line_labels || {}, workers = Array.isArray(w.workers) ? w.workers : [];
  return w.lines.map((l) => (labels[l] || l) + " " + (workers.some((x) => x.line === l && x.running) ? "运行中" : "已停止")).join("、");
}

function notRunning(url, dataDir, logFile) {
  console.log(`本机:电脑在线 · 看板服务没有运行(${url} 没有应答)`);
  const tail = logTail(logFile, 8);
  if (tail.length) {
    console.log(`  后台运行的日志最后 ${tail.length} 行(${logFile}):`);
    for (const l of tail) console.log("    " + l);
  } else console.log(`  没有后台运行的日志(${logFile})`);
  console.log(`  已有的任务和结果都在 ${dataDir} 里,重新启动后照原样回来。`);
  console.log("下一步:node cli/start.mjs --background");
  return 1;
}

/** The last `n` non-empty lines of the log, reading only its end (the log keeps every run). The
 *  cut is by bytes, so a line split by it is dropped rather than shown half-decoded. */
function logTail(file, n) {
  if (!existsSync(file)) return [];
  let fd;
  try {
    fd = openSync(file, "r");
    const size = fstatSync(fd).size, len = Math.min(size, 64 * 1024), buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString("utf8").split(/\r?\n/);
    if (len < size) lines.shift();
    return lines.map((l) => l.trimEnd()).filter(Boolean).slice(-n);
  } catch { return []; }
  finally { if (fd !== undefined) closeSync(fd); }
}
