// Loop-layer harness. `node tests/looptest.mjs`
//
// selftest.mjs = DB layer / decisiontest.mjs = ruling layer. THIS one runs
// **worker_loop.py itself**. What it measures:
//   "a card that always fails climbs attempts 1→2→3, lands in waiting/decision,
//    and **the loop then claims the next card**"
//
// ⭐ It uses a STUB CLI. The real agent CLI is never called — it would cost money
//   and time, and "reliably produces no evidence" is hard to arrange with a real
//   model. The stub writes nothing and exits non-zero.
//   ⇒ From the loop's side that is "three attempts with no output" = the exact path.
//
// ⛔ Never touches a running board: temporary port + temporary BOARD_DATA_DIR, so
//   board and loop are both isolated. That isolation only holds because
//   worker_loop.py honours BOARD_DATA_DIR (otherwise the evidence dir and the token
//   file are fixed paths and the test would DELETE real evidence files).

import { spawn } from "node:child_process";
import {
  mkdtempSync, rmSync, readFileSync, writeFileSync, chmodSync, existsSync, mkdirSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const TMP = mkdtempSync(join(tmpdir(), "looptest-"));
const PORT = 48200 + Math.floor((Date.now() / 1000) % 60);
const BASE = `http://127.0.0.1:${PORT}`;
const PY = process.env.PYTHON || "python";
const WIN = process.platform === "win32";
const LINE = "alpha";                       // built-in config's first line

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? " — " + detail : ""}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── isolated board ──────────────────────────────────────────────────────────
const srv = spawn(process.execPath, [join(ROOT, "core", "server.mjs")], {
  env: { ...process.env, BOARD_PORT: String(PORT), BOARD_DATA_DIR: TMP,
         BOARD_DB: join(TMP, "t.db"),
         BOARD_ALLOW_UNPINNED: "1",   // isolated harness only: revision-gate escape
         // Pool sweep in ISOLATED form. Default is a 5h window + a real CLI recheck:
         //   the rate-limit stub in ⑥b marks the claude pool down, after which
         //   /api/claim answers 503 and later sections would go red for the wrong
         //   reason. Shrinking the window is NOT enough — the recheck actually spawns
         //   `worker_loop.py --probe-runtime --live`, i.e. the test would fire a real
         //   CLI. So use the injection the server documents for isolated harnesses.
         BOARD_POOL_TEST_MODE: "1", BOARD_POOL_TEST_PROBE: "ok",
         BOARD_POOL_HOLD_MS: "100", BOARD_POOL_RECONCILE_MS: "50" },
  stdio: ["ignore", "pipe", "pipe"],
});
let srvOut = "";
srv.stdout.on("data", (b) => srvOut += b);
srv.stderr.on("data", (b) => srvOut += b);
// ⚠ Without an 'error' listener, ENOENT & friends surface as an uncaught exception
//   that kills the process OUTSIDE the try/finally — so the "print the logs when it
//   breaks" block never runs. The harness goes silent exactly when it should speak.
srv.on("error", (e) => { srvOut += `\n[server spawn error] ${(e && e.message) || e}\n`; });

let TOKEN = "";
const api = async (method, path, body) => {
  const r = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", "X-Board-Token": TOKEN },
    body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
  });
  let j = null;
  try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
};
const getTask = async (id) => (await api("GET", `/api/tasks/${id}`)).body?.task;

/** Why the loop is not running at all (python missing from PATH / died early).
 *  null = it should be running. ⭐ Without this every wait spins to its timeout and
 *  then reports "did not claim" — a missing python looks like a loop defect. */
let loopDead = null;
const nope = (msg) => loopDead ? `⛔loop is not running — ${loopDead} (see loop output below)` : msg;

/** Wait until a condition holds. ⚠ Returns null instead of throwing when it never
 *  does — so callers can phrase "what did NOT happen" as the assertion. */
const until = async (fn, ms = 120000) => {
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try { v = await fn(); } catch {}
    if (v) return v;
    if (loopDead) return null;              // it will never come — do not spin to the cap
    if (Date.now() - t0 > ms) return null;
    await sleep(500);
  }
};

let loop = null;
let loopOut = "";
// ⭐ Remember that WE stopped it. Without this, an intentional kill is reported by the
//   exit watcher as "the loop quit on its own" and the diagnosis printed on red LIES.
let loopStopping = false;

/** ⭐ Measure "it was claimed" through traces that DO NOT DISAPPEAR.
 *  status === 'in_progress' is an INSTANT state — parking erases it. The stub dies
 *  immediately, so claim→fail→park can finish inside one poll interval (500ms). Then
 *  "never observed" gets reported as "never claimed" = the subject is healthy and only
 *  the instrument is red, with wording that says the opposite of what happened.
 *  ⚠ Measured on the origin deployment: claim→3 failures→park landed inside the SAME
 *    second; polling caught only a single attempts=2 flicker.
 *  Two traces survive:
 *    ① the loop's own line `领到 #<id>:` — printed unconditionally right after claim
 *    ② monotonic attempts — park never rewinds them
 *  ⭐ We want to prove it PASSED THROUGH, not to witness it mid-pass. */
const claimTrace = (id, t, log) => {
  // ":" bounds the id ⇒ `领到 #1:` does not match `领到 #12:`
  const logged = new RegExp(`领到 #${id}:`).test(log || "");
  const bumped = !!t && Number(t.attempts) >= 1;
  const live   = !!t && t.status === "in_progress";   // nice if seen. NOT relied upon
  return { claimed: logged || bumped || live, logged, bumped, live, t,
           via: [logged && "loop log 「领到 #」", bumped && `attempts=${t.attempts}`,
                 live && "status=in_progress"].filter(Boolean).join(" + ") };
};
const untilClaimed = (id, ms = 60000, getLog = () => loopOut) =>
  until(async () => {
    const c = claimTrace(id, await getTask(id), getLog());
    return c.claimed ? c : null;
  }, ms);

try {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${BASE}/health`)).ok) break; } catch {}
    await sleep(250);
  }
  TOKEN = readFileSync(join(TMP, "board_token"), "utf8").trim();

  // ── stub CLI: writes nothing, exits non-zero ──────────────────────────────
  //   ⚠ Producing NO output is the point. If it wrote an evidence file the card
  //     would be done on attempt 1 and the retry path would never be entered.
  const stub = join(TMP, WIN ? "stub.cmd" : "stub.sh");
  // ⭐ The stub fails with a VARYING cause (alpha/beta/gamma in rotation). The
  //   fingerprint brake normalises digits, so what varies has to be WORDS. Dropping a
  //   `static.on` file switches it to a same-cause failure — §⑤ uses that to measure
  //   the brake itself.
  if (WIN) {
    writeFileSync(stub, "@echo off\r\n" +
      'if exist "%~dp0static.on" echo looptest-stub failure same-forever road 1>&2\r\n' +
      'if exist "%~dp0static.on" exit /b 3\r\n' +
      "set /a n=0\r\n" +
      'if exist "%~dp0cnt.txt" set /p n=<"%~dp0cnt.txt"\r\n' +
      "set /a n+=1\r\n" +
      '>"%~dp0cnt.txt" echo %n%\r\n' +
      "set /a m=n %% 3\r\n" +
      "set W=alpha\r\n" +
      "if %m%==1 set W=beta\r\n" +
      "if %m%==2 set W=gamma\r\n" +
      "echo looptest-stub failure %W% road 1>&2\r\n" +
      "exit /b 3\r\n", "utf8");
  } else {
    writeFileSync(stub, "#!/bin/sh\n" +
      'D="$(dirname "$0")"\n' +
      'if [ -f "$D/static.on" ]; then echo "looptest-stub failure same-forever road" 1>&2; exit 3; fi\n' +
      'n=0; [ -f "$D/cnt.txt" ] && n=$(cat "$D/cnt.txt")\n' +
      'n=$((n+1)); echo $n > "$D/cnt.txt"\n' +
      'case $((n % 3)) in 0) W=gamma;; 1) W=alpha;; 2) W=beta;; esac\n' +
      'echo "looptest-stub failure $W road" 1>&2\nexit 3\n', "utf8");
    chmodSync(stub, 0o755);
  }
  // POSIX has no .cmd, so the batch gate would not fire on stub.sh; the base argv
  // escape hatch is what lets a plain script be the CLI on either platform.
  const stubEnv = WIN ? { WORKER_CLAUDE_CLI: stub, WORKER_ALLOW_BATCH_CLI: "1" }
                      : { WORKER_CLAUDE_CLI: stub };

  console.log("[① place one card that always fails]");
  // ⭐ weight=light on purpose, for two reasons:
  //   ① proves the create-card entry accepts weight (start rung comes from the card)
  //   ② light starts at L1, so the three attempts are medium → high → max = all
  //     DIFFERENT rungs, making "did it escalate?" readable off a single card.
  const A = (await api("POST", "/api/tasks",
    { subject: "必ず失败する卡(looptest)", line: LINE, maxAttempts: 3, weight: "light",
      description: "桩不写证据,所以三次都交不了活。" })).body.task.id;
  ok("card created (attempts=0, not_started)", (await getTask(A)).attempts === 0, `#${A}`);
  ok("⭐create-card entry accepts weight (light survives onto the card)",
     (await getTask(A)).weight === "light", `weight=${(await getTask(A)).weight}`);

  /** Read "which rung attempt n of card X used" out of the loop log. ⭐ The anchor
   *  includes the EVIDENCE FILE NAME — several cards run, so `第 2/3 次尝试` alone
   *  grabs another card's line (the assertion silently starts measuring a neighbour). */
  const tierOf = (card, n, max) => {
    const m = loopOut.match(
      new RegExp(`第 ${n}/${max} 次尝试 \\[([^\\]]+)\\][^\\n]*task-${card}-attempt-${n}\\.md`));
    return m ? m[1] : null;
  };

  // ── start the loop, isolated ──────────────────────────────────────────────
  console.log("\n[② start worker_loop.py against the isolated board]");
  loop = spawn(PY, [join(ROOT, "loops", "worker_loop.py"), "--as", LINE, "--interval", "1"], {
    env: { ...process.env,
           BOARD_URL: BASE,
           BOARD_ALLOW_UNPINNED: "1",        // isolated harness only
           BOARD_DATA_DIR: TMP,              // ⭐ token AND evidence to the temp side
           ...stubEnv,
           // ⭐ The line-level circuit breaker is OFF for the resident loop, and the
           //   reason matters: this harness's job is to manufacture failures back to
           //   back (rate limits, exhausted attempts, refused gates), so the breaker
           //   fires — correctly — and takes the rest of the harness with it
           //   (measured: the resident loop exited 3 mid-run and every later section
           //   went red for want of a claimer). Turning it off HERE is isolation, not
           //   concealment: §⑬ runs its own loop with the breaker ON and proves the
           //   mechanism end to end.
           WORKER_PARK_STREAK_LIMIT: "0",
           WORKER_HEARTBEAT_SEC: "5",
           WORKER_LEASE_MIN: "5",
           // ⚠ The stub should die instantly, but there are ways for it NOT to
           //   (cmd.exe argument parsing can stall). At the default 3600 one stuck
           //   attempt outlives every wait below and turns into a WRONG red.
           WORKER_TIMEOUT_SEC: "20",
           // ⭐ Pin the slot config explicitly. Relying on defaults lets a stray
           //   WORKER_EFFORT in the caller's shell shift the ladder start silently
           //   (`...process.env` is spread first, so the parent's values come through).
           WORKER_MODEL: "claude-opus-5", WORKER_EFFORT: "high",
           // Policy env too: the cap is "how high we are willing to go", separate from
           //   the ladder mechanism. 99 = no policy cap; worker_loop clamps with
           //   min(cap, len(LADDER)-1), so this always measures up to the top rung.
           WORKER_LADDER_CAP: "99",
           WORKER_LADDER: "",                        // use the built-in / config ladder
           WORKER_SESSION: "", WORKER_FORK_FROM: "", // no persistent session for a stub
           PYTHONIOENCODING: "utf-8" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  loop.stdout.on("data", (b) => loopOut += b);
  loop.stderr.on("data", (b) => loopOut += b);
  // ⭐ The most likely stumble: `python` not on PATH (on Windows it can even hit the
  //   Store placeholder exe). env PYTHON points at the real one.
  loop.on("error", (e) => {
    loopDead = `${(e && e.code) || "spawn failed"}: ${PY} — point env PYTHON at the real interpreter`;
    loopOut += `\n[loop spawn error] ${(e && e.message) || e}\n`;
  });
  // The loop should run until killed. Quitting on its own is itself an anomaly.
  loop.on("exit", (code, sig) => {
    if (!loopStopping && loopDead === null && code !== 0)
      loopDead = `loop exited on its own (exit=${code}${sig ? " " + sig : ""})`;
  });

  const claimed = await untilClaimed(A, 60000);
  ok("loop claimed the card", !!claimed,
     claimed ? `via=${claimed.via} worker=${claimed.t.worker} attempts=${claimed.t.attempts}`
             : nope(`60s and not one trace of #${A} being claimed (neither log nor attempts)`
                    + ` — it was NEVER claimed. ⚠ Not a missed observation: traces survive`
                    + ` parking, so a fast finish would still be here`));

  // ⭐ Place the second card AFTER the first is claimed. Placing it earlier would put
  //   claim ORDER into the assertion — what we measure is "does it keep going after park".
  const B = (await api("POST", "/api/tasks",
    { subject: "接下来该被领的卡(looptest)", line: LINE })).body.task.id;

  console.log("\n[③ self-retry until exhausted → waiting/decision]");
  const parked = await until(async () => {
    const t = await getTask(A);
    return t && t.status === "waiting" ? t : null;
  }, 120000);
  ok("ends in waiting (no fifth state called blocked)", !!parked,
     parked ? `waiting_for=${parked.waiting_for}` : nope("120s and it never reached waiting"));

  if (parked) {
    // ⚠ When broken: the panel shows "attempt 1/3" while it is really on the third —
    //   a false picture is worse than none. Measure the DB value.
    ok("⭐attempts really reached 3 (1→2→3 persisted)", parked.attempts === 3,
       `attempts=${parked.attempts}`);
    ok("destination is decision, not review", parked.waiting_for === "decision",
       `waiting_for=${parked.waiting_for}`);
    // ⚠ When broken: waiting cards appear with no statement of what they wait for.
    //   waiting is a state that SUMMONS A HUMAN — a reasonless one just rings the bell.
    const why = String(parked.result || "");
    ok("⭐it says what it is waiting for", /自行尝试/.test(why) && /需要人看的是/.test(why),
       why.slice(0, 60).replace(/\n/g, " "));
    ok("previous output tails accumulate (material for trying another road)",
       /第 1 次/.test(why) && /第 3 次/.test(why), `tails ${(why.match(/第 \d 次/g) || []).join(",")}`);
  }

  // ⭐ 1→2→3 must also appear in the LIVE LOG. The DB keeps only the final value, so
  //   "jumped to 3 in one go" and "ran three times" are indistinguishable from it.
  ok("⭐log shows 第 1/3・第 2/3・第 3/3 (it really ran three times)",
     /第 1\/3 次/.test(loopOut) && /第 2\/3 次/.test(loopOut) && /第 3\/3 次/.test(loopOut),
     (loopOut.match(/第 \d\/\d 次尝试/g) || []).join(" "));

  // ── ③b escalation: the rung rises one step per attempt ON THE SAME CARD ─────
  //   Without this, a regression back to "strength statically pinned" is invisible to
  //   everyone — board and card look identical, only argv changes.
  {
    const lad = [1, 2, 3].map((n) => tierOf(A, n, 3));
    ok("⭐light card ladder = medium → high → max (one rung per retry)",
       lad[0] === "opus-5/medium" && lad[1] === "opus-5/high" && lad[2] === "opus-5/max",
       lad.map((x, i) => `#${i + 1}=${x}`).join(" "));
    // The start coming from weight, seen from another side: the log prints the rung number.
    // ⚠ The parentheses are HALF-WIDTH U+0028/U+0029 in the loop's f-string. Written bare
    //   in a regex they become a CAPTURE GROUP and never match the literal text — a
    //   permanent false red. Escape them.
    ok("  start derives from weight=light (log says 第 1/3 档)",
       /第 1\/3 次尝试 \[opus-5\/medium\]\(weight=light 第 1\/3 档\)/.test(loopOut),
       (loopOut.match(/weight=\w+ 第 \d\/\d 档/g) || []).slice(0, 3).join(" "));
  }

  console.log("\n[④ ⭐waiting stops THAT CHAIN, not this worker]");
  const next = await untilClaimed(B, 90000);
  // ⚠ When broken: the worker stops after parking one card. The panel merely looks
  //   "quiet" while that line is entirely dead — the slowest failure to notice.
  ok("⭐after park, the loop went for the next card", !!next,
     next ? `#${B} via=${next.via} worker=${next.t.worker}`
          : nope(`90s and no trace of #${B} being claimed — the line has stopped`));
  ok("the log says so too", /继续领下一张/.test(loopOut),
     (loopOut.match(/\(\w+\)继续领下一张/g) || []).join(" "));

  // ── ⑤ same-cause failure: fingerprint brake × "escalation is a new premise" ──
  console.log("\n[⑤ ⭐same-cause → fingerprint brake, and escalation counts as a new premise]");
  // ⭐ The brake fires on "same fingerprint twice **AND no rung left to climb**",
  //   because escalation itself is a new premise (not a third pass down one road, but
  //   "once more with a different brain").
  //   ⇒ TWO assertions are needed. With only one, removing the brake OR removing the
  //     escalation both stay green:
  //     branch A (card F here) rungs left → does NOT park, escalates and continues
  //     branch B (card H below) at top rung → DOES park (spinning still stops)
  //   ⚠ F is weight=light so that two non-top rungs precede the top one; with a
  //     three-rung ladder a standard start would reach the top on attempt 2 and
  //     branch A would have no room to be observed.
  writeFileSync(join(TMP, "static.on"), "1", "utf8");
  const F = (await api("POST", "/api/tasks",
    { subject: "同因失败卡(looptest)", line: LINE, maxAttempts: 3, released: 0, weight: "light",
      description: "桩转同因失败 —— 第 2 次同指纹但还有档可提 ⇒ 不刹车;第 3 次到顶档仍同指纹 ⇒ 刹车。"
    })).body.task.id;
  mkdirSync(join(TMP, "evidence"), { recursive: true });
  writeFileSync(join(TMP, "evidence", `spawn-${F}.json`),
    JSON.stringify({ tasks: [{ subject: "失败路径的提案(不该立卡)" }] }), "utf8");
  await api("POST", `/api/tasks/${F}/release`, { released: true });
  const parkedF = await until(async () => {
    const t = await getTask(F);
    return t && t.status === "waiting" ? t : null;
  }, 120000);
  ok("same-cause card ends in waiting", !!parkedF,
     parkedF ? `wf=${parkedF.waiting_for}` : nope("no park within 120s"));
  if (parkedF) {
    // ── branch A: same fingerprint but RUNGS REMAIN ⇒ attempt 2 does NOT park
    ok("⭐branch A: same fingerprint does not park while rungs remain (runs to #3)",
       parkedF.attempts === 3, `attempts=${parkedF.attempts} (2 = escalation is not working)`);
    ok("  ⭐that decision is in the log (never silently waved through)",
       /同指纹 2 次[^\n]*还有档可提[^\n]*不刹车[^\n]*下一次尝试提到 \[opus-5\/max\]/.test(loopOut),
       (loopOut.match(/同指纹 2 次[^\n]*/) || ["(none)"])[0].slice(0, 90));
    ok("  ⭐the rung really climbed (medium → high → max)",
       tierOf(F, 1, 3) === "opus-5/medium" && tierOf(F, 2, 3) === "opus-5/high"
         && tierOf(F, 3, 3) === "opus-5/max",
       [1, 2, 3].map((n) => `#${n}=${tierOf(F, n, 3)}`).join(" "));
    // ── branch B (half of it): top rung reached with the same fingerprint ⇒ brake
    ok("lands in decision, reason names brake / fingerprint / no rung left",
       parkedF.waiting_for === "decision" &&
       /失败指纹刹车/.test(String(parkedF.result || "")) && /fp=/.test(String(parkedF.result || "")) &&
       /无档可提/.test(String(parkedF.result || "")),
       String(parkedF.result || "").slice(0, 70).replace(/\n/g, " "));
    ok("  ⭐the rung trajectory stays on the card (escalation is auditable later)",
       /档位轨迹.*opus-5\/medium → opus-5\/high → opus-5\/max/.test(String(parkedF.result || "")),
       (String(parkedF.result || "").match(/档位轨迹[^\n]*/) || ["(none)"])[0].slice(0, 80));
    const relF = (await api("GET", `/api/tasks/${F}/related`)).body?.tasks || [];
    const kids = relF.filter((x) => x.parent_id === F);
    ok("⭐parent failed ⇒ its proposals are NOT turned into cards", kids.length === 0,
       `children=${kids.length}`);
    ok("the proposal is filed onto the card instead (findings are not lost)",
       /候选发现/.test(String(parkedF.result || "")));
    ok("the spawn file is consumed (a stale proposal cannot resurface on a later success)",
       !existsSync(join(TMP, "evidence", `spawn-${F}.json`)));
    // One ledger row per attempt (the stub has no transcript ⇒ zeros are still written:
    // "unreadable" is not "free", but at least "how many times it ran" must be countable).
    const ledger = join(TMP, "usage_ledger.jsonl");
    const rows = existsSync(ledger) ? readFileSync(ledger, "utf8").trim().split(/\r?\n/) : [];
    ok("⭐usage ledger exists with one row per attempt (card A → 3 rows)",
       rows.filter((l) => l.includes(`"card": ${A}`)).length === 3, `total rows=${rows.length}`);
    ok("the braked card also logged 3 rows (no brake on #2 ⇒ #3 burned one too)",
       rows.filter((l) => l.includes(`"card": ${F}`)).length === 3);
    // ⭐ model/effort columns = escalation is auditable after the log has rotated away.
    const parse = (card) => rows.filter((l) => l.includes(`"card": ${card}`))
                                .map((l) => { try { return JSON.parse(l); } catch { return {}; } });
    const rowsA = parse(A);
    ok("⭐ledger rows carry model AND effort (all rows)",
       rowsA.length === 3 && rowsA.every((r) => typeof r.model === "string" && typeof r.effort === "string"),
       JSON.stringify(rowsA.map((r) => [r.model, r.effort])));
    ok("⭐the escalation path is reconstructible from the ledger alone (medium → high → max)",
       rowsA.map((r) => r.effort).join(",") === "medium,high,max"
         && rowsA.every((r) => r.model === "claude-opus-5"),
       rowsA.map((r) => `${r.model}/${r.effort}`).join(" → "));
  }

  // ── ⑤b branch B: heavy start + same fingerprint at the top ⇒ brake fires EARLY ──
  //   F stops on attempt 3, which is also where exhaustion would stop it — that alone
  //   does not prove the brake is doing anything. A heavy card starts AT the top rung,
  //   so it must stop on attempt 2, BEFORE the max_attempts=3 limit ⇒ what stopped it
  //   was the brake, not exhaustion.
  console.log("\n[⑤b ⭐branch B: heavy start → top rung on #1 → brake on #2, before exhaustion]");
  const H = (await api("POST", "/api/tasks",
    { subject: "heavy 同因失败卡(looptest)", line: LINE, maxAttempts: 3, weight: "heavy",
      description: "起点=顶档。第 2 次同指纹 ⇒ 在到达上限 3 之前刹车。" })).body.task.id;
  const parkedH = await until(async () => {
    const t = await getTask(H);
    return t && t.status === "waiting" ? t : null;
  }, 120000);
  ok("heavy card also ends in waiting", !!parkedH,
     parkedH ? `wf=${parkedH.waiting_for}` : nope("no park within 120s"));
  if (parkedH) {
    ok("⭐heavy starts at the top rung (high from attempt 1)",
       tierOf(H, 1, 3) === "opus-5/max", `#1=${tierOf(H, 1, 3)}`);
    ok("⭐branch B: same fingerprint at the top ⇒ brake BEFORE the limit (attempts=2)",
       parkedH.attempts === 2, `attempts=${parkedH.attempts} max=3 — 3 means the brake is dead`);
    ok("  what stopped it was the brake, not exhaustion (the reason says so)",
       /失败指纹刹车/.test(String(parkedH.result || "")) &&
       /无档可提/.test(String(parkedH.result || "")) &&
       !/自行尝试 3 次都没能交付/.test(String(parkedH.result || "")),
       String(parkedH.result || "").slice(0, 80).replace(/\n/g, " "));
  }

  console.log("\n[⑥ ⭐batch-CLI entry gate — escape hatch is loud, gate refuses before claiming]");
  if (WIN) {
    ok("using the escape hatch is recorded in the loop log (never silently allowed)",
       /WORKER_ALLOW_BATCH_CLI=1/.test(loopOut),
       (loopOut.match(/⚠ WORKER_ALLOW_BATCH_CLI=1[^\n]{0,40}/) || ["(none)"])[0]);
  } else {
    console.log("  (skip on POSIX: the .cmd stub / escape hatch is Windows-specific)");
  }

  //   ⚠ Stop the main loop here. From now on single-shot `--once` loops run one at a
  //     time, so "which loop claimed what" stays unambiguous (parallel loops would
  //     make the negative controls untrustworthy).
  loopStopping = true;
  try { loop.kill(); } catch {}
  await sleep(1000);
  try { rmSync(join(TMP, "static.on"), { force: true }); } catch {}   // stub back to normal

  /** Run a throwaway loop for exactly one card. ⭐ env is spelled out EVERY time to cut
   *  the caller's shell out — a leftover WORKER_CLAUDE_CLI would silently falsify the
   *  negative controls. */
  const runLoopOnce = (extraEnv, ms = 90000, { once = true } = {}) => new Promise((resolve) => {
    let out = "", done = false, timer = null;
    // ⚠ It MUST always resolve. There are paths where only 'error' arrives (python not
    //   on PATH); waiting on 'exit' alone leaves the promise pending forever ⇒ the try
    //   never ends, finally never runs, and the harness hangs silently — the worst
    //   failure mode of all. Close it from all three sides.
    const fin = (code) => { if (done) return; done = true; clearTimeout(timer); resolve({ code, out }); };
    const p = spawn(PY, [join(ROOT, "loops", "worker_loop.py"), "--as", LINE,
                         "--interval", "1", ...(once ? ["--once"] : [])], {
      env: { ...process.env, BOARD_URL: BASE, BOARD_DATA_DIR: TMP,
             BOARD_ALLOW_UNPINNED: "1",
             WORKER_CLAUDE_CLI: "", WORKER_CLI_ARGV: "", WORKER_ALLOW_BATCH_CLI: "",
             WORKER_RUNTIME: "claude",
             WORKER_HEARTBEAT_SEC: "5", WORKER_LEASE_MIN: "5", WORKER_TIMEOUT_SEC: "20",
             WORKER_MODEL: "claude-opus-5", WORKER_EFFORT: "high",
             WORKER_LADDER_CAP: "99", WORKER_LADDER: "",
             WORKER_SESSION: "", WORKER_FORK_FROM: "", PYTHONIOENCODING: "utf-8", ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    p.stdout.on("data", (b) => (out += b));
    p.stderr.on("data", (b) => (out += b));
    p.on("error", (e) => { out += `\n[spawn error] ${(e && e.message) || e}\n`; fin(null); });
    p.on("close", (code) => fin(code));
    timer = setTimeout(() => { try { p.kill(); } catch {} fin(-1); }, ms);
  });

  // ── ⑥b ⭐rate limiting does NOT consume a rung ──────────────────────────────
  //   Being rate-limited is not "not strong enough", it is "could not run at all".
  //   Escalating here would climb the ladder on every refuel pause and burn the
  //   scarcest pool for the most pointless reason. ⇒ wait and re-fire the SAME rung.
  console.log("\n[⑥b ⭐rate-limit waits do not consume attempts or rungs]");
  {
    const rateStub = join(TMP, WIN ? "rate.cmd" : "rate.sh");
    if (WIN) {
      writeFileSync(rateStub, "@echo off\r\necho rate limit reached - try again later 1>&2\r\n" +
                              "exit /b 3\r\n", "utf8");
    } else {
      writeFileSync(rateStub, "#!/bin/sh\necho 'rate limit reached - try again later' 1>&2\nexit 3\n", "utf8");
      chmodSync(rateStub, 0o755);
    }
    const R = (await api("POST", "/api/tasks",
      { subject: "限流卡(looptest)", line: LINE, maxAttempts: 1,
        description: "桩自称限流 —— 尝试次数与档位都不该动。" })).body.task.id;
    const rr = await runLoopOnce({ WORKER_CLAUDE_CLI: rateStub,
                                   ...(WIN ? { WORKER_ALLOW_BATCH_CLI: "1" } : {}),
                                   WORKER_RATE_WAIT_SEC: "1", WORKER_RATE_MAX_WAITS: "2" }, 60000);
    const tR = await getTask(R);
    const tiers = rr.out.match(/第 1\/1 次尝试 \[([^\]]+)\]/g) || [];
    ok("⭐rate limiting does not consume an attempt (attempts stays 1)",
       tR?.attempts === 1, `attempts=${tR?.attempts} exit=${rr.code}`);
    ok("⭐fired three times on the SAME rung (initial + 2 waits) — not one step up",
       tiers.length === 3 && tiers.every((s) => s === "第 1/1 次尝试 [opus-5/high]"),
       tiers.join(" | ") || "(no rung lines printed)");
    // From the other side: the higher rung must never appear. One-sided, "it never ran
    // at all" would also be green.
    ok("  converse: max never appears in the output (no escalation happened)",
       !/opus-5\/max/.test(rr.out),
       (rr.out.match(/\[(?:opus|claude)[^\]]*\]/g) || ["(none)"]).join(" "));
    ok("  the wait and the held rung are both in the log",
       /不消耗尝试次数[^\n]*档位仍 \[opus-5\/high\]/.test(rr.out),
       (rr.out.match(/疑似限流[^\n]*/) || ["(none)"])[0].slice(0, 100));
    ok("  after the wait cap it parks as 额度耗尽 (never wearing the exhausted-attempts face)",
       tR?.status === "waiting" && /额度耗尽/.test(String(tR?.result || "")),
       `status=${tR?.status} ${String(tR?.result || "").slice(0, 40).replace(/\n/g, " ")}`);
  }

  // ⭐ Cleanup for ⑥b: having the stub CLAIM rate limiting marked the pool down on the
  //   board. poolDown ignores `until`, so only the sweep clears it — racing ahead would
  //   make later sections red with 503 "cannot claim". Wait it out.
  {
    const back = await until(async () => {
      const ps = (await api("GET", "/api/pools")).body?.pools;
      return ps && !ps.claude?.exhausted_at ? ps : null;
    }, 10000);
    if (!back)
      console.log("  ⚠ pool still not cleared after 10s — later sections may go red with"
                + " /api/claim 503; the cause is this section's report, not their assertions");
  }

  // ── ⑥c ⭐second runtime seat: same claim → heartbeat → evidence → report ─────
  //   The real second-seat CLI is never launched. A fake CLI in the temp dir receives
  //   the seat-shaped argv/stdin/JSONL/-o, so no outbound traffic and no credits are
  //   spent. Node itself acts as the "native exe"; BOARD_REPO points at the temp repo
  //   because Node reads the leading `exec` argument as a script path.
  console.log("\n[⑥c ⭐second seat: same protocol, end-to-end, without credits]");
  {
    const seatRepo = join(TMP, "codex-stub-repo");
    const seatHit = join(TMP, "codex-stub-hit.json");
    mkdirSync(seatRepo, { recursive: true });

    // The stub does not persist the prompt; it extracts only the hand-off path and
    // writes the evidence file. The hit file records argv structure, never card text.
    writeFileSync(join(seatRepo, "exec"), `
const { mkdirSync, writeFileSync } = require("node:fs");
const { dirname } = require("node:path");
const args = process.argv.slice(2);
const valueOf = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (s) => { prompt += s; });
process.stdin.on("end", () => {
  const lastPath = valueOf("-o");
  const evidencePath = (prompt.match(/【怎么交付】[^\\r\\n]*\\r?\\n  ([^\\r\\n]+)/) || [])[1];
  const effortArg = args.find((x) => x.startsWith("model_reasoning_effort=")) || "";
  const valid = Boolean(lastPath && evidencePath && args.includes("--json") &&
    args.includes("--approve-for-me") && args.at(-1) === "-");
  writeFileSync(process.env.CODEX_STUB_HIT, JSON.stringify({
    kind: "local-node-codex-stub", argv: args, model: valueOf("-m"),
    effort: effortArg.split("=")[1] || null, valid,
  }), "utf8");
  if (!valid) { console.error("codex stub argv/prompt mismatch"); process.exitCode = 9; return; }
  setTimeout(() => {
    mkdirSync(dirname(evidencePath), { recursive: true });
    writeFileSync(evidencePath, "codex-local-stub evidence: claim -> report\\n", "utf8");
    mkdirSync(dirname(lastPath), { recursive: true });
    writeFileSync(lastPath, "CODEX-STUB-FINAL", "utf8");
    console.log(JSON.stringify({ type: "thread.started", thread_id: "looptest-codex-stub" }));
    console.log(JSON.stringify({ type: "turn.started" }));
    console.log(JSON.stringify({
      type: "turn.completed",
      usage: { input_tokens: 101, cached_input_tokens: 23,
               cache_write_input_tokens: 7, output_tokens: 11 },
    }));
  }, 2500);
});
`, "utf8");

    // On Windows process.execPath IS node.exe. On POSIX put an .exe symlink to the same
    // binary in the temp dir — the gate's "native executable" contract is not relaxed,
    // only the test is made cross-platform.
    const seatCli = WIN ? process.execPath : join(seatRepo, "node-codex-stub.exe");
    if (!WIN) symlinkSync(process.execPath, seatCli);

    const C = (await api("POST", "/api/tasks", {
      subject: "第二座席桩の端到端卡(looptest)", line: LINE, maxAttempts: 1,
      description: "本地假 CLI 产出 evidence 与 JSONL,不呼叫任何外部服务。",
    })).body.task.id;
    const seatPromise = runLoopOnce({
      WORKER_RUNTIME: "codex", BOARD_CODEX_RELEASED: "1", BOARD_CODEX_CMD: seatCli,
      BOARD_REPO: seatRepo, WORKER_MODEL: "gpt-5.6-sol", WORKER_EFFORT: "xhigh",
      WORKER_HEARTBEAT_SEC: "1", WORKER_TIMEOUT_SEC: "20", CODEX_STUB_HIT: seatHit,
    }, 60000);
    const liveC = await until(async () => {
      const t = await getTask(C);
      return t?.status === "in_progress" && t?.heartbeat_at ? t : null;
    }, 15000);
    const cr = await seatPromise;
    const tC = await getTask(C);
    const hit = existsSync(seatHit) ? JSON.parse(readFileSync(seatHit, "utf8")) : null;
    const ledgerPath = join(TMP, "usage_ledger.jsonl");
    const ledgerRows = existsSync(ledgerPath)
      ? readFileSync(ledgerPath, "utf8").trim().split(/\r?\n/).filter(Boolean)
          .map((s) => { try { return JSON.parse(s); } catch { return {}; } })
      : [];
    const seatRows = ledgerRows.filter((r) => r.card === C);

    ok("⭐the stub launched local Node exactly once (no external service called)",
       hit?.kind === "local-node-codex-stub" && hit?.valid === true && seatRows.length === 1,
       `stub=${hit?.kind || "(no hit)"} ledger rows=${seatRows.length}`);
    ok("⭐the real argv path (--json / -o / stdin / workspace-write) reached the stub",
       hit?.argv?.includes("--json") && hit?.argv?.includes("-o") &&
         hit?.argv?.includes("--approve-for-me") && !hit?.argv?.includes("--sandbox") &&
         hit?.argv?.at(-1) === "-" && hit?.model === "gpt-5.6-sol" && hit?.effort === "xhigh",
       JSON.stringify(hit?.argv || []));
    ok("⭐the second seat claims through /api/claim and runtime=codex lands on the card",
       tC?.attempts >= 1 && tC?.last_runtime === "codex",
       `status=${tC?.status} attempts=${tC?.attempts} runtime=${tC?.last_runtime}`);
    ok("⭐heartbeat_at really advances while the seat's process blocks",
       !!liveC?.heartbeat_at, `heartbeat_at=${liveC?.heartbeat_at || "(none)"}`);
    ok("⭐JSONL terminal-state judgement (turn.completed + -o + rc=0) passes on the real path",
       cr.code === 0 && /codex 退出 rc=0/.test(cr.out),
       `loop exit=${cr.code} ${(cr.out.match(/codex 退出 rc=-?\d+/) || ["no verdict line"])[0]}`);
    ok("⭐the same /report collects the seat's evidence and hands off to review",
       tC?.status === "waiting" && tC?.waiting_for === "review" &&
         /codex-local-stub evidence/.test(String(tC?.result || "")),
       `status=${tC?.status} waiting_for=${tC?.waiting_for}`);
    ok("⭐attempts records exactly one claim",
       tC?.attempts === 1 && tC?.attempts_this_claim === 1,
       `attempts=${tC?.attempts} this_claim=${tC?.attempts_this_claim}`);
    ok("⭐all four usage columns are transcribed verbatim from the seat's JSONL",
       seatRows.length === 1 && seatRows[0].in === 101 && seatRows[0].cc === 7 &&
         seatRows[0].cr === 23 && seatRows[0].out === 11 &&
         seatRows[0].model === "gpt-5.6-sol" && seatRows[0].effort === "xhigh",
       JSON.stringify(seatRows));
    ok("⭐a second-seat card is booked at usd 0 (never charged to the main seat's budget)",
       (() => {
         const sp = join(TMP, "spend_ledger.jsonl");
         const rows = existsSync(sp) ? readFileSync(sp, "utf8").trim().split(/\r?\n/)
           .map((s) => { try { return JSON.parse(s); } catch { return {}; } }) : [];
         const r = rows.filter((x) => x.card === C);
         return r.length === 1 && r[0].usd === 0 && /另一个池/.test(String(r[0].note || ""));
       })(), "spend_ledger row for the seat card");
  }

  // ── ②bis ⭐a card that finishes FAST is not missed (no reliance on luck) ─────
  //   Rather than hoping the card outlives one 500ms poll, run a throwaway loop to
  //   completion and only THEN observe ⇒ in_progress is already gone = the condition
  //   under which the old instrument misses 100% of the time. The trace-based
  //   instrument must still be able to say "it was claimed".
  console.log("\n[②bis ⭐a fast card is not missed]");
  const Q = (await api("POST", "/api/tasks",
    { subject: "速攻で終わる卡(looptest)", line: LINE, maxAttempts: 1,
      description: "maxAttempts=1 + 即死桩 ⇒ claim→失败→park 一瞬结束。" })).body.task.id;
  const rq = await runLoopOnce(stubEnv);
  const tq = await getTask(Q);
  const cq = claimTrace(Q, tq, rq.out);
  ok("⭐still provably 'claimed' when observed after the fact (traces do not vanish)", cq.claimed,
     `via=${cq.via || "(no trace)"} observed status=${tq?.status} attempts=${tq?.attempts} exit=${rq.code}`);
  console.log(`  │ what the old status-polling instrument would see here: status=${tq?.status}`
            + " ⇒ in_progress already gone = old instrument red, wording 'still not_started'");

  // ── ②ter ⭐converse: when it genuinely was NOT claimed, red with matching wording ──
  console.log("\n[②ter ⭐not claimed ⇒ red, but for the right reason]");
  const N = (await api("POST", "/api/tasks",
    { subject: "未放行的卡(谁都领不到·looptest)", line: LINE, released: 0 })).body.task.id;
  const rn = await runLoopOnce(stubEnv, 45000);
  const tn = await getTask(N);
  const cn = claimTrace(N, tn, rn.out);
  ok("⭐'not claimed' is reported as not claimed (no false green)", !cn.claimed,
     `claimed=${cn.claimed} status=${tn?.status} attempts=${tn?.attempts}`);
  ok("the loop DID look and found nothing (missed ≠ never happened)",
     /无可领任务/.test(rn.out), (rn.out.match(/无可领任务[^\n]*/) || ["(none)"])[0]);

  // ── ⑥d entry gate: refuses BEFORE claiming, with exit code 3 (refusal ≠ crash) ──
  console.log("\n[⑥d ⭐entry gate: a batch CLI refuses startup before any card is claimed]");
  const gateCmd = join(TMP, "gate.cmd");
  writeFileSync(gateCmd, "@echo off\r\nexit /b 3\r\n", "utf8");   // must NEVER run
  const G = (await api("POST", "/api/tasks",
    { subject: "门关着时谁也领不到的卡", line: LINE })).body.task.id;
  const r3 = await runLoopOnce({ WORKER_CLAUDE_CLI: gateCmd }, 30000);
  // ⭐ A refusal announces itself with code 3, distinct from a crash. With code 2 the
  //   supervisor treats it as a crash and climbs a restart ladder forever until the
  //   environment is fixed (measured on the origin deployment: 457 rungs against ~50
  //   real work units in the same window). The code is gates_lib.EXIT_REFUSED.
  ok("⭐entry gate: a loop pointed at a .cmd refuses to start (exit 3 = refusal, not crash)",
     r3.code === 3, `exit=${r3.code}`);
  ok("the refusal text carries the reason and the escape hatch (a human can fix it)",
     /WORKER_ALLOW_BATCH_CLI/.test(r3.out) && /BatBadBut|CVE-2024-24576/.test(r3.out),
     (r3.out.split(/\r?\n/).find((l) => l.trim()) || "(no output)").slice(0, 60));
  const tg = await getTask(G);
  ok("the gate falls BEFORE claiming (not one card is run)", !!tg && tg.status === "not_started",
     `#${G} status=${tg?.status} attempts=${tg?.attempts}`);

  // ── ⑥e ⭐the mechanism itself, measured directly (Windows only) ──────────────
  //   This is the standing probe behind the gate. A security claim with no live probe
  //   rots: it keeps a gate that may no longer be needed, or keeps one that no longer
  //   works, and nobody can tell which. Assert the mechanism, not the belief:
  //     · while quoting still breaks → green ⇒ do NOT remove the gate
  //     · if Windows/python ever close it → RED ⇒ that is when to re-evaluate the gate
  //   ⚠ Zero side effects: the payload is `exit 7` only — no writes, deletes, or traffic.
  if (WIN) {
    console.log("\n[⑥e ⭐standing probe: is the .cmd quoting break still real?]");
    const probe = join(TMP, "batprobe.cmd");
    writeFileSync(probe, "@echo off\r\nexit /b 3\r\n", "utf8");
    // ⚠ Node refuses to spawn a .cmd directly (EINVAL) — itself evidence that .cmd is
    //   special-cased. What we want to measure is what CreateProcess does when cmd.exe
    //   is interposed, so let python (the loop's own runtime) fire it and read the code.
    const shot = (args) => new Promise((res) => {
      const code = "import subprocess,sys,json;a=json.loads(sys.argv[1]);" +
                   "sys.exit(subprocess.run(a,capture_output=True).returncode)";
      const q = spawn(PY, ["-c", code, JSON.stringify([probe, ...args])],
                      { stdio: ["ignore", "ignore", "ignore"] });
      q.on("close", (c) => res(c));
      q.on("error", () => res(null));
    });
    const rcSingle = await shot(["-p", "single-line prompt", "--effort", 'max" & exit 7']);
    const rcMulti  = await shot(["-p", "line one\nline two", "--effort", 'max" & exit 7']);
    ok("⭐mechanism: via .cmd the quoting breaks and what follows RUNS (single-line argv → rc=7)",
       rcSingle === 7, `rc=${rcSingle} — a 3 here means it got closed (re-evaluate the gate)`);
    ok("  same payload with a newline in the command line stops there (rc=3) = today's"
       + " multi-line prompt is an ACCIDENTAL mitigation, not a designed defence",
       rcMulti === 3, `rc=${rcMulti}`);

    // Negative control: the SAME payload down a non-.cmd executable. CreateProcess
    // starts it directly, no cmd.exe in between ⇒ the prompt stays one argv element.
    // (The real agent CLI is never used — what we measure is ".exe path or not".)
    const WHERE = join(process.env.SystemRoot || "C:\\Windows", "System32", "where.exe");
    if (existsSync(WHERE)) {
      // ⚠ Queue exclusivity: #G from ⑥d is still not_started and released, and it is
      //   OLDER than the card below — a throwaway loop would claim IT and this negative
      //   control would measure the wrong card (observed: attempts=0, "did not fire",
      //   green for the wrong reason is one keystroke away here). ⑥d's assertions are
      //   already made, so retire it from the queue first.
      await api("POST", `/api/tasks/${G}/release`, { released: false });
      const P2 = (await api("POST", "/api/tasks",
        { subject: "阴性对照 .exe 路径(looptest)", line: LINE, maxAttempts: 1,
          description: "同一 payload 走 .exe —— 不该发火。" })).body.task.id;
      const r2 = await runLoopOnce({ WORKER_CLAUDE_CLI: WHERE, WORKER_EFFORT: 'max" & exit 7' });
      const t2 = await getTask(P2);
      const ev2 = String(t2?.result || "");
      ok("⭐negative control: the same text does NOT fire down the .exe path (no rc=7)",
         !!t2 && t2.status === "waiting" && !/rc=7/.test(ev2),
         `status=${t2?.status} observed rc=${(ev2.match(/rc=-?\d+/g) || []).join(",") || "(none)"}`);
      ok("the default (.exe) side is not caught by the gate — the loop started and ran a card",
         !/WORKER_ALLOW_BATCH_CLI/.test(r2.out) && t2?.attempts === 1,
         `exit=${r2.code} attempts=${t2?.attempts}`);
    } else {
      console.log(`  (skip: ${WHERE} missing — the negative control did NOT run)`);
    }
  } else {
    console.log("\n  (skip ⑥e on POSIX: the cmd.exe quoting break is Windows-specific;"
              + " the gate itself is platform-independent and was measured in ⑥d)");
  }

  // ── ⑬ line-level circuit breaker ───────────────────────────────────────────
  // A card's budget is per card. ACROSS cards there was none: park one, claim the
  // next, burn that one too. When the cause is systemic (CLI gone, repo broken,
  // verifier dead, authorization expired) that spends the entire queue to learn a
  // single fact. Three in a row with nothing delivered ⇒ stop and fetch a human.
  // Measured end to end, because the whole value of this mechanism is that the
  // process ACTUALLY exits — an assertion on a counter would prove nothing.
  console.log("\n[⑬ 连续交不成 → 线级熔断(真的会退出)]");
  {
    for (let i = 0; i < 4; i++)
      await api("POST", "/api/tasks",
                { subject: `熔断用卡 ${i}(交不成)`, line: LINE, maxAttempts: 1 });
    // A stub that exits cleanly and writes NO evidence file: each card uses its one
    // attempt and parks. That is the systemic-failure shape without a real CLI.
    const silent = JSON.stringify([PY, "-c", "import sys; sys.exit(0)"]);
    const t0 = Date.now();
    const rb = await runLoopOnce({ WORKER_CLI_ARGV: silent, WORKER_PARK_STREAK_LIMIT: "3" },
                                 120000, { once: false });
    const secs = Math.round((Date.now() - t0) / 1000);
    ok("⑬ 连续没交成 → 进程自己退出(不是继续烧下一张)", rb.code !== null,
       `code=${rb.code} 用时 ${secs}s`);
    ok("⑬ ⭐退出码 3 = 既有的「被拒绝」族:server 不自动重启,健康哨随即报「想跑却没在跑」",
       rb.code === 3, `code=${rb.code}`);
    ok("⑬ 日志把它说成系统性故障的信号,并给出先查哪几件",
       /连续 \d+ 张卡都没能交付/.test(rb.out) && /doctor/.test(rb.out) && /human_gate/.test(rb.out),
       (rb.out.match(/连续 \d+ 张卡都没能交付[^\n]*/) || ["(没找到熔断行)"])[0].slice(0, 90));
    // The counter must be a STREAK, not a total: a delivery in between clears it.
    // Without this, a busy board would eventually trip the breaker on unrelated parks.
    ok("⑬ 熔断前确实连着处理了多张卡(不是第一张就退)",
       (rb.out.match(/领到 #/g) || []).length >= 3,
       `领到 ${(rb.out.match(/领到 #/g) || []).length} 张`);
  }

} catch (e) {
  console.error("the harness itself fell over:", e);
  fail++;
} finally {
  loopStopping = true;                    // cleanup kills must not read as "died on its own"
  try { loop && loop.kill(); } catch {}
  try { srv.kill(); } catch {}
  await sleep(400);
  // ★ Show what happened when it breaks. A harness that hides its logs is useless at
  //   the exact moment it goes red.
  if (fail) {
    if (loopDead) console.log("\n⛔ the red is probably not the harness: " + loopDead);
    console.log("\n──── loop output (last 2500 chars) ────\n" + loopOut.slice(-2500));
    console.log("\n──── board output (last 800 chars) ────\n" + srvOut.slice(-800));
  }
  try { rmSync(TMP, { recursive: true, force: true }); } catch {}
  console.log(`\n${"─".repeat(56)}\nresult: ${pass} PASS / ${fail} FAIL  (temp ${BASE} / ${TMP})`);
  void 0;
  process.exit(fail ? 1 : 0);
}
