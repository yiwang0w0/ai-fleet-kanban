#!/usr/bin/env node
// sentrytest — the SSE sentry re-runs itself ONCE when the board says it is stale, and it lets
// go of its old connection FIRST (self-audit v0.18.0 P1-1: while the child ran, the parent's
// old-rev connection stayed open and the banner kept saying 「有通知进程还在跑旧代码」). A stub
// SSE server stands in for the board: it tells any sentry whose rev is not NEWREV that it is
// stale, and records when each connection opened and closed. Dead port, no board touched.
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NL = "\n";
let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PY = process.env.PYTHON || process.env.BOARD_PYTHON || (process.platform === "win32" ? "python" : "python3");
const NEWREV = "n3wrev";
const conns = [];   // { as, rev, opened, closed }

const srv = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname !== "/api/events") { res.writeHead(404); res.end(); return; }
  const c = { as: url.searchParams.get("as"), rev: url.searchParams.get("rev") || "", opened: Date.now(), closed: null };
  conns.push(c);
  res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.write("retry: 2000\n\n");
  // Same shape the board sends (core/server.mjs, sentry registration).
  if (c.rev && c.rev !== NEWREV)
    res.write(`event: change\ndata: ${JSON.stringify({ type: "sentry.stale", your_rev: c.rev, board_rev: NEWREV })}\n\n`);
  const ka = setInterval(() => { try { res.write(": ka\n\n"); } catch {} }, 1000);
  req.on("close", () => { clearInterval(ka); c.closed = Date.now(); });
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const PORT = srv.address().port;
console.log(`[sentrytest] stub board on 127.0.0.1:${PORT}  python=${PY}`);

const env = { ...process.env, BOARD_URL: `http://127.0.0.1:${PORT}`, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" };
delete env.SSE_WATCH_REEXECED;   // a fresh sentry, never re-run
let out = "";
const child = spawn(PY, [join(ROOT, "watchers", "sse_watch.py")],
  { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" });
child.stdout.on("data", (b) => (out += b));
child.stderr.on("data", (b) => (out += b));
const killTree = () => {
  if (child.exitCode != null) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
  else { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
};

try {
  console.log(NL + "[① 旧连接先关,再以新代码重跑一次]");
  const t0 = Date.now();
  while (conns.length < 2 && Date.now() - t0 < 20000) await sleep(150);
  await sleep(1500);   // let the child print its second-mismatch warning
  ok("哨接上桩板并自报身份与版本(?as=sentry&rev=…)", conns[0]?.as === "sentry" && !!conns[0]?.rev,
     `as=${conns[0]?.as} rev=${conns[0]?.rev}`);
  ok("⭐被告知 stale 后:第一条连接关闭 早于 第二条建立(旧哨不再挂在板上)",
     conns.length >= 2 && conns[0].closed != null && conns[0].closed <= conns[1].opened,
     `closed@${conns[0]?.closed} opened2@${conns[1]?.opened}`);
  ok("重跑的进程带着 SSE_WATCH_REEXECED 回来,再被说 stale 只警告、不再重跑(连接停在 2 条)",
     conns.length === 2 && /重跑过一次/.test(out) && /↻/.test(out),
     `conns=${conns.length} out=${out.replace(/\s+/g, " ").slice(0, 160)}`);
  ok("父进程留守等子进程(pid 不变,Monitor 不会看到它退出)", child.exitCode == null, `exitCode=${child.exitCode}`);
  ok("旧连接确实是主动断开的,不是被桩板关的(桩板从不关流)", conns[0]?.closed != null, "");
} catch (e) {
  console.error("harness itself fell over:", e); fail++;
} finally {
  killTree();
  srv.close();
}
console.log(`${NL}${"─".repeat(56)}${NL}result: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
