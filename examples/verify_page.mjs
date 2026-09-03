// verify_page —— 让「页面确实变成了那样」成为机器产出。
//
//   node examples/verify_page.mjs --url http://127.0.0.1:47824 \
//        --expect "AI 舰队看板" --expect-js "document.querySelectorAll('.card').length > 0" \
//        --no-console-errors --screenshot shot.png
//
// **为什么需要它**:改前端的卡最难交付。worker 没有执行权,只能写「我改好了」,
// 于是机器产出闸如实拦下它 —— 卡在「零机器产出」上空转一轮。缺的不是纪律,
// 是一条**能产出机器证据的通道**。
//
// **它在体系里的位置**(别搞错):这是给**循环**跑的,不是给 worker 跑的。
// operator 把它登记进 core/verify_registry.json 成为一个**键**,卡上挂
// verify_cmd: <键>,由 worker_loop / reviewer_loop 代跑,输出并进证据。
// worker 拿不到它 —— 「验证不采信被验证方」的老规矩。
//
// **零依赖**:Node 22 内置 WebSocket,所以直接说 CDP(Chrome DevTools Protocol),
// 不装 playwright、不装任何库。用系统里已有的 Chrome/Edge。
//
// ⛔ **走过的弯路,留给下一个人**(全是实测):
//   · `chrome --dump-dom` 和 `--screenshot` 都在 load 事件后立刻取样。任何
//     **客户端渲染**的页面(这块板自己就是)那一刻数据还没回来,取到的是
//     `–` 的骨架 —— 断言会全红,而页面其实是好的。
//   · `--virtual-time-budget` 本该解决它,但对**带 SSE 的页面**在此 Chrome 上
//     一律吐**空**(同一条命令打 /health 正常、打面板为空)。SSE 永不静默。
//   · 反复重跑 `--dump-dom` 也没用:每次都是**新进程新页面**,重走同一个竞态。
//   ⇒ 只有「保持页面活着、轮询到条件成立」才对,那就必须是 CDP。
import { spawn, execFileSync } from "node:child_process";
import { existsSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";

const NL = String.fromCharCode(10);
const args = process.argv.slice(2);
const many = (flag) => args.reduce((a, v, i) => (v === flag ? [...a, args[i + 1]] : a), []);
const one = (flag, dflt = null) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : dflt);
const has = (flag) => args.includes(flag);

// ── Browser discovery: whatever Chromium is already on this machine ──────────
function findBrowser() {
  const env = process.env.BOARD_BROWSER;
  if (env) return existsSync(env) ? env : null;
  const cands = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
  ];
  for (const p of cands) if (existsSync(p)) return p;
  for (const n of ["google-chrome", "chromium", "chromium-browser"]) {
    try { return execFileSync("which", [n], { encoding: "utf8" }).trim() || null; } catch {}
  }
  return null;
}

// Only local addresses. This script gets registered as a key the LOOP can run;
// letting it fetch any URL would hand the fleet an outbound fetcher. Unknown
// falls on the refusing side — widening it has to be said out loud.
const LOCAL = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
export function isLocal(url) {
  const m = /^https?:\/\/(\[[^\]]+\]|[^/:]+)(:\d+)?(\/|$)/.exec(url || "");
  return !!m && LOCAL.has(m[1]);
}

/** Assertions run in the PAGE, against innerText — which excludes <script> and
 *  <style> bodies. Scanning raw DOM instead reports the source code: a first
 *  cut of this tool flagged NaN/undefined/Infinity on a perfectly good panel,
 *  all of them from its own inlined JS (measured). */
export function buildProbe({ expects = [], expectNots = [], expectRes = [], expectJs = [] }) {
  return `(() => {
    const t = document.body ? document.body.innerText : "";
    const out = [];
    ${JSON.stringify(expects)}.forEach((s) => out.push({ kind: "应出现", what: s, ok: t.includes(s) }));
    ${JSON.stringify(expectNots)}.forEach((s) => out.push({ kind: "不应出现", what: s, ok: !t.includes(s) }));
    ${JSON.stringify(expectRes)}.forEach((p) => {
      let ok = false, err = null;
      try { ok = new RegExp(p, "s").test(t); } catch (e) { err = String(e.message); }
      out.push({ kind: "应匹配", what: p, ok, err });
    });
    ${JSON.stringify(expectJs)}.forEach((src) => {
      let ok = false, err = null;
      try { ok = !!eval(src); } catch (e) { err = String(e.message); }
      out.push({ kind: "表达式为真", what: src, ok, err });
    });
    return JSON.stringify({ results: out, textLen: t.length });
  })()`;
}

async function freePort() {
  for (let p = 9222 + Math.floor(Math.random() * 300); ; p++) {
    const ok = await new Promise((r) => {
      const s = createServer();
      s.once("error", () => r(false));
      s.listen(p, "127.0.0.1", () => s.close(() => r(true)));
    });
    if (ok) return p;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (has("--selftest")) return selftest();
  const url = one("--url");
  if (!url) { console.error("要 --url"); return 2; }
  if (!isLocal(url) && !has("--allow-any-host")) {
    console.error(`⛔ 只验证本机地址(收到 ${url})—— 要抓别处得显式 --allow-any-host,` +
                  "并想清楚这个键会被循环代跑");
    return 2;
  }
  const browser = findBrowser();
  if (!browser) {
    console.error("⛔ 找不到 Chrome/Edge —— 装一个,或用 BOARD_BROWSER 指向可执行文件。" +
                  "这不是「验证通过」,是验证跑不起来");
    return 2;
  }
  const checks = { expects: many("--expect"), expectNots: many("--expect-not"),
                   expectRes: many("--expect-re"), expectJs: many("--expect-js") };
  const wantConsoleClean = has("--no-console-errors");
  const total = checks.expects.length + checks.expectNots.length +
                checks.expectRes.length + checks.expectJs.length;
  if (!total && !wantConsoleClean) {
    console.error("⛔ 一条断言都没给 —— 「页面能打开」不算验证(那只是 200)");
    return 2;
  }

  const port = await freePort();
  const prof = mkdtempSync(join(tmpdir(), "verifypage-"));
  const proc = spawn(browser, ["--headless=new", "--disable-gpu", "--no-first-run",
                               "--no-default-browser-check", `--user-data-dir=${prof}`,
                               `--remote-debugging-port=${port}`, "--window-size=1400,1000", url],
                     { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  proc.stderr.on("data", (b) => (stderr += b));
  const cleanup = () => {
    try { proc.kill(); } catch {}
    try { rmSync(prof, { recursive: true, force: true }); } catch {}
  };

  try {
    // The page target's own websocket. Poll /json/list rather than parsing
    // stderr — the banner's wording is not a contract, the endpoint is.
    let wsUrl = null;
    for (let i = 0; i < 60 && !wsUrl; i++) {
      try {
        const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
        wsUrl = (list.find((t) => t.type === "page" && t.webSocketDebuggerUrl) || {}).webSocketDebuggerUrl;
      } catch {}
      if (!wsUrl) await sleep(250);
    }
    if (!wsUrl) {
      console.error(`⛔ 浏览器没起来(${Math.round(15)}s 内没拿到调试端点)。stderr 尾:${stderr.slice(-300)}`);
      return 1;
    }

    const ws = new WebSocket(wsUrl);          // Node 22 内置,零依赖
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("CDP 连不上")); });
    let id = 0;
    const pending = new Map();
    const consoleErrors = [];
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
      // Console errors and uncaught exceptions are the cheapest real
      // observability a page has; a green assertion on a page throwing in the
      // console is a half-truth.
      if (m.method === "Runtime.exceptionThrown")
        consoleErrors.push("未捕获异常: " + (m.params?.exceptionDetails?.exception?.description ||
                                           m.params?.exceptionDetails?.text || "?").slice(0, 200));
      if (m.method === "Runtime.consoleAPICalled" && m.params?.type === "error")
        consoleErrors.push("console.error: " + (m.params.args || [])
          .map((a) => a.value ?? a.description ?? a.type).join(" ").slice(0, 200));
    };
    const send = (method, params = {}) => new Promise((res) => {
      const mid = ++id;
      pending.set(mid, res);
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
    await send("Runtime.enable");
    await send("Page.enable");

    // Poll until the assertions hold. The page stays ALIVE across polls — that
    // is the whole difference from re-running --dump-dom, which re-runs the race.
    const waitMs = Number(one("--wait-ms", "10000"));
    const t0 = Date.now();
    let results = [], textLen = 0, polls = 0;
    for (;;) {
      polls++;
      const r = await send("Runtime.evaluate", { expression: buildProbe(checks), returnByValue: true });
      try {
        const v = JSON.parse(r.result?.result?.value || "{}");
        results = v.results || []; textLen = v.textLen || 0;
      } catch { results = []; }
      const allOk = results.every((x) => x.ok) && (!wantConsoleClean || consoleErrors.length === 0);
      if (allOk || Date.now() - t0 >= waitMs) break;
      await sleep(500);
    }

    const shot = one("--screenshot");
    if (shot) {
      const r = await send("Page.captureScreenshot", { format: "png" });
      if (r.result?.data) writeFileSync(shot, Buffer.from(r.result.data, "base64"));
    }

    const waited = Date.now() - t0;
    console.log(`—— 页面验证 ${url}(${browser.split(/[\\/]/).pop()} · CDP · 取样 ${polls} 次 · ${waited}ms)——`);
    for (const x of results)
      console.log(`  ${x.ok ? "PASS" : "FAIL"}  ${x.kind}: ${JSON.stringify(x.what)}` +
                  (x.err ? `  ← ${x.err}` : ""));
    if (wantConsoleClean)
      console.log(consoleErrors.length
        ? `  FAIL  控制台干净: ${consoleErrors.length} 条` + NL + consoleErrors.map((e) => "        " + e).join(NL)
        : "  PASS  控制台干净(无 console.error / 未捕获异常)");
    else if (consoleErrors.length)
      console.log(`  (提示: 控制台有 ${consoleErrors.length} 条错误,但没要求检查 —— 要拦就加 --no-console-errors)`);
    console.log(`  (可见文本 ${textLen} 字)`);
    if (shot && existsSync(shot)) console.log(`  截图: ${shot}`);
    const ok = results.length > 0 && results.every((x) => x.ok) &&
               (!wantConsoleClean || consoleErrors.length === 0);
    console.log("结果: " + (ok ? "通过" : "未通过"));
    return ok ? 0 : 1;
  } finally { cleanup(); }
}

function selftest() {
  let pass = 0, fail = 0;
  const ok = (n, c, d = "") => (c ? (pass++, console.log("PASS " + n)) : (fail++, console.log("FAIL " + n + " — " + d)));
  ok("本机地址放行", isLocal("http://127.0.0.1:47824/"));
  ok("localhost 放行", isLocal("http://localhost:48500"));
  ok("外部主机拒绝(未知落拒绝侧)", !isLocal("http://example.com/"));
  ok("伪装成本机的主机名也拒绝", !isLocal("http://127.0.0.1.evil.com/"));
  ok("非 http 协议拒绝", !isLocal("file:///etc/passwd"));
  // The probe is a pure string builder, so its logic is testable without a
  // browser: run it against a fake document in this process.
  const run = (text, checks) => {
    const doc = { body: { innerText: text } };
    return JSON.parse(new Function("document", "return " + buildProbe(checks))(doc));
  };
  ok("命中 → ok", run("AI 舰队看板", { expects: ["舰队"] }).results[0].ok);
  ok("没命中 → 不 ok", !run("AI 舰队看板", { expects: ["缺席"] }).results[0].ok);
  ok("不应出现而确实没有 → ok", run("干净", { expectNots: ["NaN"] }).results[0].ok);
  ok("不应出现却出现了 → 不 ok", !run("等了 NaNhNaNm 前", { expectNots: ["NaN"] }).results[0].ok);
  ok("正则命中 → ok", run("版本 de7efe1", { expectRes: ["版本 [0-9a-f]{7}"] }).results[0].ok);
  const bad = run("x", { expectRes: ["[unclosed"] }).results[0];
  ok("正则写错 → 不 ok 且带原因,不是崩掉", !bad.ok && !!bad.err, JSON.stringify(bad));
  ok("⭐innerText 不含 script/style,所以崩坏词不会被源码误报",
     run("正常页面文字", { expectNots: ["undefined", "Infinity"] }).results.every((r) => r.ok));
  const jsBad = run("x", { expectJs: ["document.nope.nope"] }).results[0];
  ok("表达式抛错 → 不 ok 且带原因", !jsBad.ok && !!jsBad.err);
  console.log(`${NL}result: ${pass} PASS / ${fail} FAIL`);
  return fail ? 1 : 0;
}

process.exitCode = await main().catch((e) => { console.error("verify_page 自身失败:", e.message); return 1; });
