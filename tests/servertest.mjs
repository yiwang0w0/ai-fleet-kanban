// Supervisor-layer harness: WHY a line stopped, and who is allowed to restart it.
// `node tests/servertest.mjs`
//
// selftest = DB layer / looptest = the loop itself / decisiontest & decomposetest =
// pure libraries. THIS one runs the real server and watches it supervise child
// processes. Today it covers the stop-reason contract; later endpoint sections join
// the same file.
//
// ⭐ Stub children, not the production loop. Since a gate refusal exits 3 and is
//   deliberately NOT restarted, the backoff ladder cannot be measured with the real
//   loop at all — measuring it needs a child that dies UNEXPECTEDLY. The stub is
//   injected by copying server.mjs into the OS temp dir with ONE substitution (the
//   loop script path) and rewriting import.meta.url back to the real file, so every
//   relative require still resolves to the real modules. Production files are never
//   touched.
// ⛔ Stubs live in the OS temp dir, never inside the repo: an aborted run would
//   otherwise leave untracked files inside the revision-gated subtree, and the gate
//   would then refuse to start the whole fleet. Litter must be structurally unable to
//   land in the gated area.

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const SERVER = join(ROOT, "core", "server.mjs");
const STUBS = mkdtempSync(join(tmpdir(), "servertest-stubs-"));
const LINE = "alpha";
const NL = String.fromCharCode(10);

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? " — " + detail : ""}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The interpreter the SERVER will use for children. Resolved here so a red result
 *  can say "python was not found" instead of blaming the supervisor. */
const PYTHON = (() => {
  for (const c of [process.env.BOARD_PYTHON, process.env.PYTHON, "python", "py", "python3"].filter(Boolean)) {
    try { execFileSync(c, ["-c", "print(1)"], { stdio: "ignore" }); return c; } catch {}
  }
  return null;
})();

// ── stub children ───────────────────────────────────────────────────────────
const CRASHER = join(STUBS, "crasher.py");
const NORMAL = join(STUBS, "normal.py");
const SLEEPER = join(STUBS, "sleeper.py");
writeFileSync(CRASHER, "import sys" + NL + "sys.exit(1)" + NL, "utf8");
writeFileSync(NORMAL, "import sys" + NL + "sys.exit(0)" + NL, "utf8");
writeFileSync(SLEEPER, "import time" + NL + "time.sleep(60)" + NL, "utf8");

const SRC = readFileSync(SERVER, "utf8");
// The single substitution point. If startSlot's argv is ever reshaped, this split
// yields one part and every stub board becomes the REAL loop — which would look like
// a mysterious hang, so assert the anchor instead of trusting it.
const ANCHOR = '[loopScriptOf(line), "--as", line,';
const parts = SRC.split(ANCHOR);
if (parts.length !== 2) {
  console.log(`  FAIL  stub anchor not found in core/server.mjs (${parts.length - 1} matches) — ` +
              "startSlot's argv changed shape; update ANCHOR in this file");
  process.exit(1);
}
const stubServerFor = (py) => {
  const src = parts.join(`[${JSON.stringify(py)}, "--as", line,`)
    .replaceAll("import.meta.url", JSON.stringify(pathToFileURL(SERVER).href));
  const p = join(STUBS, `server-${py.replace(/[^a-z]/gi, "")}.mjs`);
  writeFileSync(p, src, "utf8");
  return p;
};

/** Start a board (real or stub-child) on its own port + data dir. */
// ⚠ Ports are PROBED, not assumed. A fixed sequence went red on the CI runner:
//   some unrelated service held one port in the range and the board died of
//   EADDRINUSE while the harness kept phoning a corpse (measured, ubuntu lane).
//   Binding first is the only honest availability check.
let portSeq = 48400;
async function freePort() {
  for (;;) {
    const p = portSeq++;
    const ok = await new Promise((res) => {
      const s2 = createServer();
      s2.once("error", () => res(false));
      s2.listen(p, "127.0.0.1", () => s2.close(() => res(true)));
    });
    if (ok) return p;
  }
}
async function board({ script = SERVER, env = {}, dataDir = null, files = {} } = {}) {
  const PORT = await freePort();
  const BASE = `http://127.0.0.1:${PORT}`;
  const DATA = dataDir || mkdtempSync(join(tmpdir(), "servertest-data-"));
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(DATA, { recursive: true });
    writeFileSync(join(DATA, name), JSON.stringify(body, null, 1), "utf8");
  }
  let out = "";
  const proc = spawn(process.execPath, [script], {
    env: { ...process.env, BOARD_PORT: String(PORT), BOARD_DATA_DIR: DATA,
           BOARD_DB: join(DATA, "t.db"), BOARD_ALLOW_UNPINNED: "1",
           BOARD_POOL_TEST_MODE: "1", BOARD_POOL_TEST_PROBE: "ok",
           ...(PYTHON ? { BOARD_PYTHON: PYTHON } : {}),
           PYTHONIOENCODING: "utf-8", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", (b) => (out += b));
  proc.stderr.on("data", (b) => (out += b));
  proc.on("error", (e) => (out += `\n[server spawn error] ${e.message}\n`));
  let TOKEN = "";
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${BASE}/health`)).ok) break; } catch {}
    await sleep(250);
  }
  try { TOKEN = readFileSync(join(DATA, "board_token"), "utf8").trim(); } catch {}
  const api = async (m, p, b) => {
    const r = await fetch(BASE + p, { method: m,
      headers: { "Content-Type": "application/json", "X-Board-Token": TOKEN },
      body: m === "GET" ? undefined : JSON.stringify(b ?? {}) });
    let j = null; try { j = await r.json(); } catch {}
    return { status: r.status, body: j };
  };
  const worker = async (line) =>
    ((await api("GET", "/api/workers")).body?.workers || []).find((w) => w.line === line);
  /** Wait for a worker-shaped condition; null when it never holds (callers phrase the
   *  assertion as "what did not happen"). */
  const until = async (line, fn, ms = 30000) => {
    const t0 = Date.now();
    for (;;) {
      let w = null; try { w = await worker(line); } catch {}
      try { if (w && fn(w)) return w; } catch {}
      if (Date.now() - t0 > ms) return null;
      await sleep(300);
    }
  };
  return { PORT, BASE, DATA, proc, api, worker, until,
           out: () => out, kill: () => { try { proc.kill(); } catch {} },
           dead: () => new Promise((r) => { if (proc.exitCode != null) return r(proc.exitCode); proc.on("exit", r); }) };
}

const boards = [];
const mk = async (opts) => { const b = await board(opts); boards.push(b); return b; };

try {
  console.log(`[python] ${PYTHON || "(not found)"}`);
  if (!PYTHON) throw new Error("no python interpreter found — set env PYTHON or BOARD_PYTHON");

  // ══ §A a human stop is not a crash ═══════════════════════════════════════
  console.log(NL + "[§A 用户停止 —— 记为 stopped-by-user,不排退避]");
  {
    const B = await mk({ script: stubServerFor(SLEEPER), env: { BOARD_CRASH_BACKOFF_MS: "300" } });
    await B.api("POST", `/api/workers/${LINE}/start`);
    const up = await B.until(LINE, (w) => w.running, 20000);
    ok("A0 前提: 槽起来了(桩子在 sleep,不会自己退出)", !!up, `running=${up?.running}`);
    const stopped = await B.api("POST", `/api/workers/${LINE}/stop`);
    ok("A1 ⭐停止端点回结构化原因 stopped-by-user + ISO 时刻",
       stopped.body?.stop_reason?.reason === "stopped-by-user" &&
       Number.isFinite(Date.parse(stopped.body?.stop_reason?.at || "")),
       JSON.stringify(stopped.body?.stop_reason || null));
    ok("A2 停止文案是人话,不是 code=N",
       /^用户停止 · /.test(stopped.body?.stop_text || ""), stopped.body?.stop_text || "(none)");
    // ⭐ The kill really killed a TREE, on THIS platform. On POSIX this is the
    //   assertion that finally hears kill(-pid): before the child was spawned
    //   detached, that call threw ESRCH on every stop and no assertion listened —
    //   the suite was green while the POSIX tree-kill had never worked once.
    ok("A2b ⭐树杀真的杀到了(tree_killed>=1 —— POSIX 上这曾恒为 0 而无人听)",
       Number(stopped.body?.tree_killed) >= 1, `tree_killed=${stopped.body?.tree_killed}`);
    const after = await B.until(LINE, (w) => !w.running, 15000);
    ok("A3 ⭐树杀返回非零码,但**不判 crash**(判据是记下的原因,不是退出码)",
       after?.stop_reason?.reason === "stopped-by-user" && !/crash\(code=/.test(B.out()),
       `stop_reason=${after?.stop_reason?.reason} 日志里的 crash 行=${(B.out().match(/crash\(code=\d+\)/g) || []).length}`);
    ok("A4 人停之后意图也落下(不会自动复活)", after?.desired_running === false,
       `desired_running=${after?.desired_running}`);
    await sleep(1200);   // 退避基数 300ms —— 真要复活,这段时间足够
    const still = await B.worker(LINE);
    ok("A5 等过一个退避周期后仍然停着", !still?.running, `running=${still?.running}`);
  }

  // ══ §B an unexpected death IS a crash, and only that climbs the ladder ════
  console.log(NL + "[§B 真崩溃 —— 记为 crash,退避阶梯只认它]");
  {
    const B = await mk({ script: stubServerFor(CRASHER), env: { BOARD_CRASH_BACKOFF_MS: "400" } });
    await B.api("POST", `/api/workers/${LINE}/start`);
    const w = await B.until(LINE, (x) => x.stop_reason?.reason === "crash", 20000);
    ok("B1 ⭐无人预告的非零退出记为 crash + 时刻", !!w && w.stop_reason.reason === "crash",
       JSON.stringify(w?.stop_reason || null));
    ok("B2 文案带退出码,与人停/正常结束分得开",
       /^崩溃 code=1 · /.test(w?.stop_text || ""), w?.stop_text || "(none)");
    ok("B3 ⭐crash 才排退避,且日志说明第几次",
       /crash\(code=1\)/.test(B.out()) && /后第 1 次自动重启/.test(B.out()),
       (B.out().match(/crash\(code=\d+\)[^\n]*/) || ["(no crash line)"])[0].slice(0, 60));
    // The ladder must actually re-spawn, not merely log about it.
    const again = await B.until(LINE, (x) => /自动重启\(第 \d+ 次\)/.test((x.last_log || []).join(" ")), 20000);
    ok("B4 ⭐真的重启了(不是只在日志里说要重启)",
       !!again, (again?.last_log || []).filter((l) => /自动重启/.test(l)).join(" | ") || "(never restarted)");
  }

  // ══ §C a gate refusal has its own road ═══════════════════════════════════
  console.log(NL + "[§C 门拒绝 —— 专用退出码 3,不是 crash,也不回退到旧原因]");
  {
    // A seat that is not in the runtime table makes the REAL loop refuse at the gate.
    // ⭐ The board is seeded with an OLD user stop on disk: a refusal must NOT display
    //   it. "No reason recorded" and "the previous reason" are different facts.
    // ⚠ The trigger has to be env the server does NOT overwrite: WORKER_RUNTIME is set
    //   from the agent's seat inside slotEnv, so passing it here never reaches the
    //   child. WORKER_CLAUDE_CLI does pass through, and a .cmd is refused by the
    //   batch-CLI gate on every platform (the criterion is the extension, by design).
    const B2 = await mk({
      env: { BOARD_CRASH_BACKOFF_MS: "300", WORKER_CLAUDE_CLI: join(STUBS, "nope.cmd"),
             WORKER_ALLOW_BATCH_CLI: "" },
      files: { "worker_settings.json": { [LINE]: {
        agents: [{ runtime: "claude", model: "claude-opus-5", effort: "high", window: false }],
        rev: 0,
        last_stop: { reason: "stopped-by-user", at: "2026-01-01T00:00:00.000Z" },
      } } },
    });
    await B2.api("POST", `/api/workers/${LINE}/start`);
    const w = await B2.until(LINE, (x) => !x.running && x.exit_code != null, 25000);
    ok("C1 ⭐门拒绝用专用码 3 落下(不是 crash 的 1/2)", w?.exit_code === 3, `exit_code=${w?.exit_code}`);
    ok("C2 ⭐拒绝不排退避、不自动重启",
       !/crash\(code=/.test(B2.out()) && /拒绝启动\(exit 3\)/.test(B2.out()),
       (B2.out().match(/拒绝启动[^\n]*/) || ["(no refusal line)"])[0].slice(0, 60));
    ok("C3 拒绝时意图也落下(面板上不留『想跑却跑不起来』的线)",
       w?.desired_running === false, `desired_running=${w?.desired_running}`);
    ok("C4 ⭐本次拒绝不回退显示磁盘上那条旧的用户停止",
       w?.stop_reason == null && /启动被拒绝 code=3/.test(w?.stop_text || ""),
       `stop_reason=${JSON.stringify(w?.stop_reason)} text=${w?.stop_text}`);
  }

  // ══ §D a maintenance exit 0 is not a crash either ════════════════════════
  console.log(NL + "[§D 正常结束 —— exit 0 记为 exit-normal,不复活]");
  {
    const B = await mk({ script: stubServerFor(NORMAL), env: { BOARD_CRASH_BACKOFF_MS: "300" } });
    await B.api("POST", `/api/workers/${LINE}/start`);
    const w = await B.until(LINE, (x) => x.stop_reason?.reason === "exit-normal", 20000);
    ok("D1 ⭐exit 0 记为 exit-normal + 时刻", !!w, JSON.stringify(w?.stop_reason || null));
    ok("D2 文案与 crash 分得开", /^正常结束 · /.test(w?.stop_text || ""), w?.stop_text || "(none)");
    await sleep(1500);
    ok("D3 ⭐正常结束不排退避也不自动复活",
       !/crash\(code=/.test(B.out()) && !/自动重启/.test(B.out()),
       (B.out().match(/crash\(code=\d+\)|自动重启/g) || ["(none)"]).join(" "));
  }

  // ══ §E stopping WITH the board ═══════════════════════════════════════════
  //   The regression this pins: a stop that keeps the restart intent (board shutdown,
  //   seat swap) tree-kills its children, and a supervisor that reads the exit code
  //   books a crash — on this port, measured, before the reason became the criterion.
  console.log(NL + "[§E 随看板停止 —— 不是 crash,且跨看板重启仍说得清]");
  {
    // Windows delivers an external SIGTERM as TerminateProcess, so the signal handler
    // never runs and this path could not be measured from outside at all. The board is
    // told to take ITSELF down after a delay, walking the very same function.
    const C = await mk({ script: stubServerFor(SLEEPER),
                         env: { BOARD_CRASH_BACKOFF_MS: "300", BOARD_TEST_SHUTDOWN_MS: "4000" } });
    await C.api("POST", `/api/workers/${LINE}/start`);
    const up = await C.until(LINE, (w) => w.running, 20000);
    ok("E0 前提: 槽在跑(停板要有东西可道连)", !!up, `running=${up?.running}`);
    const code = await C.dead();
    ok("E1 板自身按停板路径退出(退出码 0)", code === 0, `exit=${code}`);
    ok("E2 ⭐停板道连时说明了是随板停止,而不是崩溃",
       /退出\(test-timer\)/.test(C.out()) && !/crash\(code=/.test(C.out()),
       (C.out().match(/退出\(test-timer\)[^\n]*|crash\(code=\d+\)/g) || ["(none)"]).join(" | "));
    // Now a fresh board on the same data dir: no container exists, so the persisted
    // reason is the only way this fact survives.
    // ⚠ keepIntent leaves desired_running true, so a plain restart REVIVES the line and
    //   reports the fresh container's (empty) reason — measuring the wrong thing. The
    //   persisted reason is what has to survive, so skip the revival here.
    const D = await mk({ script: stubServerFor(SLEEPER), dataDir: C.DATA,
                         env: { BOARD_NO_RESTORE: "1" } });
    const w = await D.worker(LINE);
    const onDisk = (() => {
      try { return readFileSync(join(C.DATA, "worker_settings.json"), "utf8").replace(/\s+/g, " "); }
      catch (e) { return "(settings file unreadable: " + e.message + ")"; }
    })();
    ok("E3 ⭐看板重启后仍能说出上次是随板停止(持久化的 last_stop)",
       w?.stop_reason?.reason === "stopped-with-board" && /^随看板停止 · /.test(w?.stop_text || ""),
       `${JSON.stringify(w?.stop_reason)} ${w?.stop_text} | running=${w?.running} ` +
       `desired=${w?.desired_running} slots=${(w?.slots || []).length} | 盘上: ${onDisk.slice(0, 160)}` +
       ` | D启动尾: ${D.out().split(/\r?\n/).filter(Boolean).slice(-3).join(" / ")}`);
    ok("E4 last_stop 不随 settings 一起外泄(结构化字段之外不留第二份)",
       w && w.settings && !("last_stop" in w.settings),
       `settings keys=${Object.keys(w?.settings || {}).join(",")}`);
    // ⭐ The reason E3 could read a persisted value at all: the maintenance boot must
    //   leave the line DOWN. Measured before the fix — the boot said "reviving nothing"
    //   and the pool reconciler started the same line ~5s later, so the flag was true
    //   only for the first instant. A guard on one entry point is not a guard.
    ok("E5 ⭐维护重启下,池调度器也不代替人复活线(闸不能只守一个入口)",
       w?.running === false && w?.desired_running === true &&
       /不代替人把它拉起来/.test(D.out()),
       `running=${w?.running} desired=${w?.desired_running} | ` +
       (D.out().match(/池调度: [^\n]*/) || ["(no reconciler line)"])[0].slice(0, 70));
  }

  // ══ §F settings save: CAS + seat-declaration domains ═════════════════════
  //   agents[] is written read-modify-write from more than one screen. Without
  //   compare-and-swap, last-write-wins silently reverts someone's fix and nobody
  //   sees it until the next start. And every value is judged by the SEAT'S OWN
  //   declaration — the global tables would let a codex slot save a claude model
  //   and die with a 400 only at start time.
  console.log(NL + "[§F 设置保存 —— CAS 与座席宣言值域]");
  {
    const B = await mk({});
    const AG = (over = {}) => [{ runtime: "claude", model: "claude-opus-5", effort: "high", window: false, ...over }];

    const noRev = await B.api("POST", `/api/workers/${LINE}/settings`, { agents: AG() });
    ok("F1 保存缺 rev → 400(体永远不对,不是冲突)",
       noRev.status === 400 && /必须带 rev/.test(noRev.body?.error || ""),
       `HTTP ${noRev.status} ${String(noRev.body?.error || "").slice(0, 40)}`);

    const w0 = await B.worker(LINE);
    const rev0 = Number(w0?.settings?.rev || 0);
    const okSave = await B.api("POST", `/api/workers/${LINE}/settings`, { agents: AG(), rev: rev0 });
    ok("F2 带对 rev → 200,rev 前进一格",
       okSave.status === 200 && Number(okSave.body?.settings?.rev) === rev0 + 1,
       `rev ${rev0} → ${okSave.body?.settings?.rev}`);

    const staleRev = await B.api("POST", `/api/workers/${LINE}/settings`, { agents: AG(), rev: rev0 });
    ok("F3 ⭐旧 rev 再提交 → 409(两处面板互相覆盖的那条路,被结构堵死)",
       staleRev.status === 409 && /重新读取/.test(staleRev.body?.error || ""),
       `HTTP ${staleRev.status}`);

    const legacy = await B.api("POST", `/api/workers/${LINE}/settings`, { model: "claude-opus-5", rev: rev0 + 1 });
    ok("F4 legacy 键按名拒(不是静默忽略成 200 无操作)",
       legacy.status === 400 && /已迁入 agents/.test(legacy.body?.error || ""),
       `HTTP ${legacy.status}`);

    const badRt = await B.api("POST", `/api/workers/${LINE}/settings`,
                              { agents: AG({ runtime: "nosuch" }), rev: rev0 + 1 });
    ok("F5 未知运行时 → 400(未知值落拒绝侧)",
       badRt.status === 400 && /未知运行时/.test(badRt.body?.error || ""), `HTTP ${badRt.status}`);

    const badModel = await B.api("POST", `/api/workers/${LINE}/settings`,
                                 { agents: AG({ model: "gpt-5.6-sol" }), rev: rev0 + 1 });
    ok("F6 ⭐座席宣言判模型:claude 席存不进 codex 的模型",
       badModel.status === 400 && /没有模型/.test(badModel.body?.error || ""), `HTTP ${badModel.status}`);

    const badEffort = await B.api("POST", `/api/workers/${LINE}/settings`,
                                  { agents: AG({ effort: "ultra" }), rev: rev0 + 1 });
    ok("F7 effort 出席位值域 → 400,错误里列出合法域",
       badEffort.status === 400 && /强度必须是/.test(badEffort.body?.error || ""), `HTTP ${badEffort.status}`);

    const locked = await B.api("POST", `/api/workers/${LINE}/settings`,
                               { agents: AG({ runtime: "codex", model: "gpt-5.6-sol", effort: "high" }), rev: rev0 + 1 });
    ok("F8 ⭐锁席拒存(解禁是人的另一个动作,4xx 不是 409)",
       locked.status === 400 && /未获解禁/.test(locked.body?.error || ""), `HTTP ${locked.status}`);

    const tooMany = await B.api("POST", `/api/workers/${LINE}/settings`,
                                { agents: [...AG(), ...AG(), ...AG(), ...AG()], rev: rev0 + 1 });
    ok("F9 并行超上限 → 400", tooMany.status === 400 && /并行上限/.test(tooMany.body?.error || ""),
       `HTTP ${tooMany.status}`);

    const after = await B.worker(LINE);
    ok("F10 被拒的保存一个都没落盘(rev 仍是成功那次的值)",
       Number(after?.settings?.rev) === rev0 + 1, `rev=${after?.settings?.rev}`);
  }

  // ══ §G spawn argv contract (BOARD_SPAWN_ECHO) ════════════════════════════
  //   The deadline bug's lesson: what the child ACTUALLY receives is only
  //   assertable by reading the assembled argv/env — the producer and a filter
  //   diverged once, args silently became [], and 253 green tests never noticed
  //   because none of them read the child's argv.
  console.log(NL + "[§G spawn argv 合同(BOARD_SPAWN_ECHO)]");
  {
    const B = await mk({ env: { BOARD_SPAWN_ECHO: "1", BOARD_UNTIL: "2099-01-01T12:00" } });
    const r0 = await B.worker(LINE);
    const rev0 = Number(r0?.settings?.rev || 0);
    await B.api("POST", `/api/workers/${LINE}/settings`, {
      agents: [{ runtime: "claude", model: "claude-opus-5", effort: "high", window: false },
               { runtime: "claude", model: "claude-sonnet-5", effort: "medium", window: false }],
      rev: rev0 });
    const st = await B.api("POST", `/api/workers/${LINE}/start`, {});
    ok("G0 前提: echo 模式下 start 200(不真 spawn)", st.status === 200, `HTTP ${st.status}`);
    const w = await B.worker(LINE);
    const echoes = (w?.slots || []).map((s2) => s2.tail).join(NL);
    ok("G1 ⭐--until 真的到达每个子进程的 argv(绝对时刻形)",
       /--until/.test(echoes) && /2099-01-01/.test(echoes),
       (echoes.match(/--until[^,\]]*[^\]]*/) || ["(no until)"])[0].slice(0, 60));
    ok("G2 ⭐槽 2 带 --worker(身份与线分离);槽 1 不带",
       new RegExp(`--worker","${LINE}@2`).test(echoes) &&
       !new RegExp(`--worker","${LINE}"`).test(echoes),
       `slots=${(w?.slots || []).length}`);
    ok("G3 ⭐每槽拿到自己的 model/effort(slot-cfg 逐槽可辨)",
       /claude-opus-5/.test(echoes) && /claude-sonnet-5/.test(echoes) &&
       /"slot":1/.test(echoes.replace(/\s/g, "")) && /"slot":2/.test(echoes.replace(/\s/g, "")),
       "");
    ok("G4 ⭐持续会话是槽 1 的私产(WORKER_SESSION 只出现在槽 1 的 env 键表)",
       (() => {
         const s1 = (w?.slots || []).find((x) => x.slot === 1)?.tail || "";
         const s2 = (w?.slots || []).find((x) => x.slot === 2)?.tail || "";
         return /WORKER_SESSION/.test(s1) && !/WORKER_SESSION/.test(s2);
       })(), "");
  }

  // ══ §H an expired window refuses NEW starts ══════════════════════════════
  //   Measured before the fix: start returned 200 and the slot came up with NO
  //   --until — a deadline, once passed, silently became "no deadline ever". The
  //   crash-restart path checked expiry; the start path did not (a guard on one
  //   entry point is not a guard).
  console.log(NL + "[§H 过期窗拒绝新起线]");
  {
    const B = await mk({ env: { BOARD_SPAWN_ECHO: "1", BOARD_UNTIL: "2020-01-01T00:00" } });
    const st = await B.api("POST", `/api/workers/${LINE}/start`, {});
    ok("H1 ⭐过期窗下 start → 409,文案带截止时刻与出路",
       st.status === 409 && /看板窗已过/.test(st.body?.error || "") && /BOARD_UNTIL/.test(st.body?.error || ""),
       `HTTP ${st.status} ${String(st.body?.error || "").slice(0, 60)}`);
    const w = await B.worker(LINE);
    ok("H2 一个槽都没起(拒绝发生在 spawn 之前)", (w?.slots || []).length === 0,
       `slots=${(w?.slots || []).length}`);
    // Converse: a FUTURE window still starts (the gate must not overshoot).
    const C = await mk({ env: { BOARD_SPAWN_ECHO: "1", BOARD_UNTIL: "2099-01-01T00:00" } });
    const st2 = await C.api("POST", `/api/workers/${LINE}/start`, {});
    ok("H3 反向: 未过期的窗照常起线(闸不越界)", st2.status === 200, `HTTP ${st2.status}`);
  }

  // ══ §I subscription-pool failover scheduling ═════════════════════════════
  //   The only cross-lifecycle automatic scheduler in the system, and until now
  //   its only "coverage" was a harness politely waiting for it to calm down.
  //   Injected clocks + injected probe (the documented isolated-harness hooks);
  //   observation goes through spawn-echo so no real CLI ever runs.
  console.log(NL + "[§I 订阅池失效调度(注入时钟/probe + spawn-echo 观测)]");
  {
    const B = await mk({ env: { BOARD_SPAWN_ECHO: "1", BOARD_CODEX_RELEASED: "1",
                                BOARD_CODEX_CMD: process.execPath,   // any real executable satisfies cmd_env
                                BOARD_POOL_HOLD_MS: "700", BOARD_POOL_RECONCILE_MS: "50",
                                BOARD_POOL_TEST_MODE: "1", BOARD_POOL_TEST_PROBE: "fail" } });
    // Configure a MAX slot, then start the line (echo mode).
    const w0 = await B.worker(LINE);
    await B.api("POST", `/api/workers/${LINE}/settings`,
                { agents: [{ runtime: "claude", model: "claude-opus-5", effort: "max", window: false }],
                  rev: Number(w0?.settings?.rev || 0) });
    await B.api("POST", `/api/workers/${LINE}/start`, {});

    const rep = await B.api("POST", "/api/pools/exhausted",
                            { runtime: "claude", exhausted_at: new Date().toISOString(),
                              until: "2099-01-01T00:00:00.000Z" });
    const pools = (await B.api("GET", "/api/pools")).body?.pools;
    ok("I1 ⭐失效上报 200,且 until 由 SERVER 按保持窗自算(不采信调用方的 2099)",
       rep.status === 200 && pools?.claude?.exhausted_at &&
       Date.parse(pools.claude.until) < Date.now() + 60_000,
       `until=${pools?.claude?.until}`);

    // The reconciler (50ms ticks) should swap the line onto the other seat.
    const swapped = await B.until(LINE, (w) =>
      (w.slots || []).some((s2) => /gpt-5\.6-sol/.test(s2.tail || "")), 15000);
    ok("I2 ⭐整线倒到另一座席(spawn-echo 里出现对方座席的模型)", !!swapped,
       ((swapped?.slots || [])[0]?.tail || "(no echo)").slice(0, 80));
    ok("I3 ⭐失效池切换保持工作强度:max 收敛到目标座席的最高档 xhigh,不再静默降到 high",
       (swapped?.slots || []).some((s2) => /"effort":"xhigh"/.test((s2.tail || "").replace(/\s/g, ""))),
       ((swapped?.slots || [])[0]?.tail?.match(/effort[^,]*/) || ["(none)"])[0]);
    ok("I4 原配置档不被改写(failover 是映射不是覆写;settings 里仍是 max)",
       (await B.worker(LINE))?.settings?.agents?.[0]?.effort === "max",
       `saved effort=${(await B.worker(LINE))?.settings?.agents?.[0]?.effort}`);
    // ⚠ The `pool_failover` boolean judges RUNNING slots only, and echo containers
    //   have no process — so in echo mode that flag is structurally unobservable.
    //   The same fact has another carrier: the API's per-slot runtime diverging from
    //   the SAVED agent's runtime is precisely what the flag summarizes.
    const wf = await B.worker(LINE);
    ok("I5 API 面能看见倒座席(slots[].runtime=codex 而保存的 agents[0] 仍是 claude)",
       (wf?.slots || [])[0]?.runtime === "codex" && wf?.settings?.agents?.[0]?.runtime === "claude",
       `slot rt=${(wf?.slots || [])[0]?.runtime} saved rt=${wf?.settings?.agents?.[0]?.runtime}`);

    // Both pools down = global stop: starts 409, claims 503, marker on disk.
    await B.api("POST", "/api/pools/exhausted",
                { runtime: "codex", exhausted_at: new Date().toISOString(),
                  until: new Date(Date.now() + 700).toISOString() });
    const stBoth = await B.api("POST", `/api/workers/coord/start`, {});
    ok("I6 ⭐双池皆满 → 起线 409(不是静默不动)", stBoth.status === 409, `HTTP ${stBoth.status}`);
    const cl = await B.api("POST", "/api/claim", { worker: "alpha", line: LINE, route: "default" });
    ok("I7 ⭐双池皆满 → /api/claim 503(与队列空的 204 分脸)", cl.status === 503, `HTTP ${cl.status}`);

    // Probe flips to ok → the reconciler clears both pools and the line comes home.
    // (The injection hook reads env at call time; a fresh board with probe=ok on the
    //  SAME data dir is the honest way to flip it.)
    B.kill();
    await sleep(300);
    const C2 = await mk({ dataDir: B.DATA,
                          env: { BOARD_SPAWN_ECHO: "1", BOARD_CODEX_RELEASED: "1",
                                 BOARD_CODEX_CMD: process.execPath,
                                 BOARD_POOL_HOLD_MS: "700", BOARD_POOL_RECONCILE_MS: "50",
                                 BOARD_POOL_TEST_MODE: "1", BOARD_POOL_TEST_PROBE: "ok" } });
    const cleared = await (async () => {
      const t0 = Date.now();
      for (;;) {
        const ps = (await C2.api("GET", "/api/pools")).body?.pools;
        if (ps && !ps.claude?.exhausted_at && !ps.codex?.exhausted_at) return ps;
        if (Date.now() - t0 > 15000) return null;
        await sleep(200);
      }
    })();
    ok("I8 ⭐到点复查成功 → 两池解禁(状态穿过看板重启仍被巡检收拾)", !!cleared,
       JSON.stringify(cleared || (await C2.api("GET", "/api/pools")).body?.pools).slice(0, 100));
  }

  // ══ §J /api/context reads without minting ════════════════════════════════
  //   A "list the lines" endpoint that MINTS session ids on read is the kind of
  //   fault that surfaces weeks later as a compact failure on a conversation
  //   nobody ever had. Reading must never create.
  console.log(NL + "[§J /api/context 只读不铸造 session]");
  {
    const B = await mk({ env: { BOARD_SPAWN_ECHO: "1" } });
    const c1 = (await B.api("GET", "/api/context")).body?.lines || [];
    const c2 = (await B.api("GET", "/api/context")).body?.lines || [];
    ok("J1 ⭐读两次,谁都没长出 session(读不是铸造)",
       c1.every((x) => !x.session_id && x.no_session) && c2.every((x) => !x.session_id),
       JSON.stringify(c1.map((x) => [x.line, !!x.no_session])));
    const onDisk = (() => {
      try { return readFileSync(join(B.DATA, "worker_settings.json"), "utf8"); } catch { return ""; }
    })();
    ok("J2 盘上也没有 session_id(持久化是铸造的证人)", !/session_id/.test(onDisk),
       onDisk.replace(/\s+/g, " ").slice(0, 80));
    // Positive control: starting the line DOES mint (slot 1's private session) —
    // and thanks to slotEnv running before the echo branch, echo mode is enough.
    await B.api("POST", `/api/workers/${LINE}/start`, {});
    const after = (() => {
      try { return readFileSync(join(B.DATA, "worker_settings.json"), "utf8"); } catch { return ""; }
    })();
    ok("J3 ⭐起线才铸造(阳性对照:J1 的 null 不是恒真)", /session_id/.test(after), "");
    const ctx = (await B.api("GET", "/api/context")).body?.lines || [];
    ok("J4 铸造之后 context 如实反映,且未起的线仍是 no_session",
       ctx.some((x) => x.line === LINE && !x.no_session) &&
       ctx.some((x) => x.line === "coord" && x.no_session),
       JSON.stringify(ctx.map((x) => [x.line, !!x.no_session])));
    const cp = await B.api("POST", "/api/context/coord/compact", { note: "x" });
    ok("J5 对无会话的线 compact 点名拒绝,拒绝本身也不铸造",
       cp.status >= 400 && !/session_id.*coord|coord.*session_id/.test(
         (() => { try { return readFileSync(join(B.DATA, "worker_settings.json"), "utf8").replace(/\s+/g, ""); } catch { return ""; } })()),
       `HTTP ${cp.status}`);
  }

  // ══ §K stopping a line reclaims leases across ALL slot names ═════════════
  //   Shrinking parallel leaves orphan slot names holding leases; a stop that
  //   reclaims only the current slots strands those cards for 30 minutes. And
  //   the reclaim must not cross lines — one line's stop returning another
  //   line's in-flight cards would be a quiet theft.
  console.log(NL + "[§K 停线回收 1..上限 的租约,不跨线]");
  {
    const B = await mk({ script: stubServerFor(SLEEPER), env: { BOARD_CRASH_BACKOFF_MS: "60000" } });
    const ids = [];
    for (const [subj, line] of [["K甲", LINE], ["K乙", LINE], ["K丙", LINE], ["K丁", "coord"]])
      ids.push((await B.api("POST", "/api/tasks", { subject: subj, line, humanGate: false })).body.task.id);
    const claims = [];
    for (const w of [LINE, `${LINE}@2`, `${LINE}@3`, "coord"]) {
      const line = w.startsWith("coord") ? "coord" : LINE;
      claims.push((await B.api("POST", "/api/claim",
        { worker: w, line, route: "default", lease_minutes: 30 })).body?.task?.id);
    }
    ok("K0 前提: 四张卡在四个不同 worker 名下(含缩并行会留下的 @3)",
       claims.every(Boolean) && new Set(claims).size === 4, `claims=${claims.join(",")}`);

    const stopped = await B.api("POST", `/api/workers/${LINE}/stop`, {});
    const rel = stopped.body?.released || [];
    ok("K1 ⭐停线回收全部 1..上限 槽名的在途(缩并行孤儿 @3 也回来)",
       rel.length === 3 && [claims[0], claims[1], claims[2]].every((c) => rel.includes(c)),
       `released=${rel.join(",")}`);
    ok("K2 ⭐不跨线:coord 的在途一张都不被动", !rel.includes(claims[3]), `coord 卡 #${claims[3]}`);
    // DB is the witness, not the endpoint's self-report.
    const t3 = (await B.api("GET", `/api/tasks/${claims[2]}`)).body?.task;
    const tc = (await B.api("GET", `/api/tasks/${claims[3]}`)).body?.task;
    ok("K3 DB 复核:回收的卡回 not_started 且 worker 清空",
       t3?.status === "not_started" && !t3?.worker, `status=${t3?.status}`);
    ok("K4 DB 复核:coord 的卡仍 in_progress 在 coord 手里",
       tc?.status === "in_progress" && tc?.worker === "coord", `status=${tc?.status} worker=${tc?.worker}`);

    // A line with NO process: stop is a request for a STATE — already there =
    // success, and the tail sweep must still run (a throw here once skipped it).
    const idleCard = (await B.api("POST", "/api/tasks",
      { subject: "K戊", line: "coord", humanGate: false })).body.task.id;
    await B.api("POST", "/api/claim", { worker: "coord@2", line: "coord", route: "default", lease_minutes: 30 });
    const stop2 = await B.api("POST", "/api/workers/coord/stop", {});
    ok("K5 ⭐对没进程的线 stop = 200 + already_idle(幂等,不是 409 谎报失败)",
       stop2.status === 200 && stop2.body?.already_idle === true, `HTTP ${stop2.status}`);
    ok("K6 ⭐already_idle 分支的租约清扫照样跑(在途被收回,throw 飞不掉它)",
       (stop2.body?.released || []).length >= 1 &&
       (await B.api("GET", `/api/tasks/${idleCard}`)).body?.task?.status === "not_started",
       `released=${(stop2.body?.released || []).join(",")}`);
  }

  // ══ §L the backoff ladder doubles, per slot, in parallel ═════════════════
  //   The degenerate shape this pins out: one slot's timer fires first and
  //   rebuilds ALL missing slots, so the other slot's own restart never runs —
  //   if the count were written at restart time, the losing slot would stay at
  //   rung 1 forever and hammer the base delay all night. The port writes the
  //   count at CRASH time (the comment says why); this is the machine check.
  console.log(NL + "[§L 并行槽各爬各的梯子,退避真的倍化]");
  {
    const B = await mk({ script: stubServerFor(CRASHER), env: { BOARD_CRASH_BACKOFF_MS: "1000" } });
    const w0 = await B.worker(LINE);
    await B.api("POST", `/api/workers/${LINE}/settings`, {
      agents: [{ runtime: "claude", model: "claude-opus-5", effort: "high", window: false },
               { runtime: "claude", model: "claude-opus-5", effort: "medium", window: false }],
      rev: Number(w0?.settings?.rev || 0) });
    await B.api("POST", `/api/workers/${LINE}/start`, {});
    // Wait until BOTH slots have logged their SECOND crash (i.e. each restarted
    // once and crashed again — the count survived the restart).
    const both = await (async () => {
      const t0 = Date.now();
      const seen = () => {
        const o = B.out();
        const seq = (key) => (o.match(new RegExp(`${key} crash\\(code=1\\)—— (\\d+)s 后第 (\\d+) 次`, "g")) || [])
          .map((m2) => { const p2 = m2.match(/(\d+)s 后第 (\d+) 次/); return { delay: Number(p2[1]), n: Number(p2[2]) }; });
        return { s1: seq(`${LINE}(?!@)`), s2: seq(`${LINE}@2`) };
      };
      for (;;) {
        const { s1, s2 } = seen();
        if (s1.some((x) => x.n >= 2) && s2.some((x) => x.n >= 2)) return seen();
        if (Date.now() - t0 > 30000) return seen();
        await sleep(300);
      }
    })();
    ok("L1 ⭐两个槽都爬到了第 2 次(计数写在 crash 时,重启被谁代劳都不丢)",
       both.s1.some((x) => x.n >= 2) && both.s2.some((x) => x.n >= 2),
       `slot1=${JSON.stringify(both.s1)} slot2=${JSON.stringify(both.s2)}`);
    const d = (seq, n) => seq.find((x) => x.n === n)?.delay;
    ok("L2 ⭐退避真的倍化(第 1 次≈1s → 第 2 次≈2s),两槽各自独立",
       d(both.s1, 1) === 1 && d(both.s1, 2) === 2 && d(both.s2, 1) === 1 && d(both.s2, 2) === 2,
       `slot1: ${d(both.s1, 1)}s→${d(both.s1, 2)}s | slot2: ${d(both.s2, 1)}s→${d(both.s2, 2)}s`);
    await B.api("POST", `/api/workers/${LINE}/stop`, {});
    await sleep(2600);   // longer than the pending 2s backoff — a revived slot would log
    const tail = B.out().split(NL).slice(-8).join(NL);
    ok("L3 人停之后梯子折叠,到点的退避不再复活任何槽",
       !/自动重启\(第/.test(tail) || /用户停止/.test(B.out()),
       tail.slice(-120).replace(/\n/g, " | "));
  }

  // ══ §M per-card token usage — aggregated from the append-only ledger ═════
  //   The loop already writes one row per attempt; this pins the server's fold:
  //   per-card sums, incremental reads (offset, not re-read), broken rows skipped,
  //   card-less rows (compact events) ignored, and a REPLACED file refolded.
  console.log(NL + "[§M 卡面 token 用量(增量聚合 usage_ledger)]");
  {
    const B = await mk({});
    const LEDGER = join(B.DATA, "usage_ledger.jsonl");
    const row = (card, extra = {}) => JSON.stringify({
      ts: "2026-09-02T00:00:00", card, attempt: 1, worker: LINE,
      model: "claude-opus-5", effort: "high", sid: "test",
      calls: 1, in: 1000, cc: 50, cr: 200000, out: 300, note: null, ...extra }) + NL;
    writeFileSync(LEDGER, row(1) + row(1, { in: 500, out: 100 }) + row(2)
      + JSON.stringify({ ts: "t", event: "compact", worker: LINE, before: 9 }) + NL
      + "{broken json" + NL, "utf8");
    const u1 = (await B.api("GET", "/api/usage")).body?.cards || {};
    ok("M1 ⭐同卡多行求和(#1 = 两次尝试合计)",
       u1["1"]?.in === 1500 && u1["1"]?.out === 400 && u1["1"]?.rows === 2 && u1["1"]?.cr === 400000,
       JSON.stringify(u1["1"]));
    ok("M2 各卡独立(#2 单行)", u1["2"]?.in === 1000 && u1["2"]?.rows === 1, JSON.stringify(u1["2"]));
    ok("M3 无卡行(compact 事件)与坏行都跳过,不污染也不致命",
       Object.keys(u1).length === 2, `cards=${Object.keys(u1).join(",")}`);

    // Incremental: append one more row; the fold must pick up ONLY the delta.
    writeFileSync(LEDGER, readFileSync(LEDGER, "utf8") + row(2, { in: 9000 }), "utf8");
    const u2 = (await B.api("GET", "/api/usage")).body?.cards || {};
    ok("M4 ⭐追加一行后增量生效(#2 累加,#1 不动)",
       u2["2"]?.in === 10000 && u2["2"]?.rows === 2 && u2["1"]?.in === 1500, JSON.stringify(u2["2"]));

    // A partial trailing line (writer mid-append) must NOT be folded — and must be
    // folded exactly once when it completes.
    const partial = JSON.stringify({ card: 3, calls: 1, in: 7777, cc: 0, cr: 0, out: 1 });
    writeFileSync(LEDGER, readFileSync(LEDGER, "utf8") + partial.slice(0, 20), "utf8");
    const u3 = (await B.api("GET", "/api/usage")).body?.cards || {};
    ok("M5 ⭐写到一半的行不入账(等它完整)", !u3["3"], JSON.stringify(u3["3"] || null));
    writeFileSync(LEDGER, readFileSync(LEDGER, "utf8") + partial.slice(20) + NL, "utf8");
    const u4 = (await B.api("GET", "/api/usage")).body?.cards || {};
    ok("M6 ⭐补完后恰好入账一次(不重复折叠前半段)",
       u4["3"]?.in === 7777 && u4["3"]?.rows === 1, JSON.stringify(u4["3"]));

    // A truncated/replaced ledger refolds from scratch instead of double counting.
    writeFileSync(LEDGER, row(9), "utf8");
    const u5 = (await B.api("GET", "/api/usage")).body?.cards || {};
    ok("M7 文件被替换(变短)→ 重新折叠,不叠旧账",
       u5["9"]?.in === 1000 && !u5["1"], JSON.stringify(Object.keys(u5)));

    // The panel actually consumes it (source-shape pin, same style as B3b).
    const panelSrc = readFileSync(join(ROOT, "core", "panel.html"), "utf8");
    ok("M8 面板真的消费这个端点并渲染 tok 徽章",
       /\/api\/usage/.test(panelSrc) && /class="tok"/.test(panelSrc) && /fmtTok/.test(panelSrc), "");
  }

  // ══ §N deliverable gate fails CLOSED when unmeasurable ═══════════════════════
  // Outside review P1: HEAD unreadable used to return an empty violation list —
  // "unmeasurable" and "no violations" were the same state, so every git hiccup
  // was a free close. Now: refuse by default; BOARD_DELIVERABLE_GATE=off is the
  // explicit, logged opt-out; allow_uncommitted:true stays the per-card human
  // override.
  {
    console.log(NL + "[§N 交付物闸不可测 = 拒绝结案(fail-closed)]");
    const NONGIT = mkdtempSync(join(tmpdir(), "servertest-nongit-"));
    const flowToWaiting = async (B) => {
      const id = (await B.api("POST", "/api/tasks", { subject: "n-case", line: LINE, humanGate: false })).body.task.id;
      await B.api("POST", "/api/claim", { worker: "alpha", line: LINE, route: "default" });
      await B.api("POST", `/api/tasks/${id}/report`, { worker: "alpha", outcome: "done", evidence: "纯文字证据,不点名任何文件" });
      return id;
    };

    const B = await mk({ env: { BOARD_REPO: NONGIT } });
    ok("N1 启动就响亮声明 fail-closed(不可测≠已禁用)",
       /交付物闸不可测/.test(B.out()) && /结案将被拒绝/.test(B.out()), B.out().split(NL).find((l) => /交付物闸/.test(l)) || "(no line)");
    const idA = await flowToWaiting(B);
    const rA = await B.api("POST", `/api/tasks/${idA}/resolve`, { verdict: "approve", note: "", resolved_by: "human" });
    ok("N2 ⭐闸不可测 → 结案 409,且拒绝文案把三条出路都写明",
       rA.status === 409 && /不可测不等于没有违规/.test(rA.body?.error || "") &&
       /BOARD_DELIVERABLE_GATE=off/.test(rA.body?.error || "") && /allow_uncommitted/.test(rA.body?.error || ""),
       `HTTP ${rA.status} ${(rA.body?.error || "").slice(0, 80)}`);
    const rB = await B.api("POST", `/api/tasks/${idA}/resolve`,
                           { verdict: "approve", note: "", resolved_by: "human", allow_uncommitted: true });
    ok("N3 同一张卡 allow_uncommitted:true = 人工担责通道仍然打开",
       rB.status === 200 && rB.body?.task?.status === "done", `HTTP ${rB.status}`);
    B.kill();

    const C = await mk({ env: { BOARD_REPO: NONGIT, BOARD_DELIVERABLE_GATE: "off" } });
    const idC = await flowToWaiting(C);
    const rC = await C.api("POST", `/api/tasks/${idC}/resolve`, { verdict: "approve", note: "", resolved_by: "human" });
    ok("N4 显式 off = 结案放行,且每次结案都留下记录(escape hatches log)",
       rC.status === 200 && /BOARD_DELIVERABLE_GATE=off/.test(C.out()) && new RegExp(`#${idC} 结案未做入库核对`).test(C.out()),
       `HTTP ${rC.status}`);
    C.kill();
    try { rmSync(NONGIT, { recursive: true, force: true }); } catch {}
  }

} catch (e) {
  console.error("harness itself fell over:", e);
  fail++;
} finally {
  for (const b of boards) {
    try { b.kill(); } catch {}
  }
  await sleep(500);
  if (fail) for (const b of boards) console.log(`\n──── board :${b.PORT} output ────\n` + b.out().slice(-1200));
  for (const b of boards) { try { rmSync(b.DATA, { recursive: true, force: true }); } catch {} }
  try { rmSync(STUBS, { recursive: true, force: true }); } catch {}
  console.log(`${NL}${"─".repeat(56)}${NL}result: ${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
}
