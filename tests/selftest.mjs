// Board-engine selftest. `node tests/selftest.mjs`
//
// Criteria are imported from store.js, never hand-written here a second time —
// a probe that carries a copy of its subject measures the copy, and a negative
// from it is the most dangerous kind.
//
// Every run uses an ISOLATED temp DB (via BOARD_DB); the production .data/board.db
// is never touched. The verify registry is a temp fixture too (BOARD_VERIFY_REGISTRY).

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TMP = mkdtempSync(join(tmpdir(), "boardtest-"));
process.env.BOARD_DATA_DIR = TMP;
process.env.BOARD_DB = join(TMP, "t.db");
// Align the default route with the explicit fixtures below (must be set BEFORE the
// store is required — it reads env at load).
process.env.BOARD_DEFAULT_ROUTE = "main";
// Self-contained registry fixture: one key, argv-array value (the store filters
// non-array values and "_"-prefixed keys).
writeFileSync(join(TMP, "verify_registry.json"),
  JSON.stringify({ selftest: ["node", "-e", "process.exit(0)"] }));
process.env.BOARD_VERIFY_REGISTRY = join(TMP, "verify_registry.json");

const require_ = createRequire(import.meta.url);
const store = require_("../core/store.js");

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? " — " + detail : ""}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`); }
};
const section = (n) => console.log(`\n[${n}]`);

const db = store.open();

// ───────────────────────────────────────────────────────────────
section("① concurrent claim never double-issues (cross-process, BEGIN IMMEDIATE)");
{
  // ⚠ An earlier version ran execFileSync in a for loop = children SEQUENTIAL. No
  //   contention ever happened, so removing BEGIN IMMEDIATE from claim still PASSED
  //   — a probe unable to detect the fault it exists for (a false-negative probe).
  //   This version: launch all N FIRST, then everyone waits for a shared wall-clock
  //   instant and claims at once.
  const child = join(TMP, "claimer.mjs");
  writeFileSync(child, `
import { createRequire } from "node:module";
const require_ = createRequire("${join(__dirname, "x.js").replaceAll(String.fromCharCode(92), "/")}");
const store = require_(process.argv[2]);
const startAt = Number(process.argv[3]);
const db = store.open();                 // DB-open cost stays OUT of the race (paid before the barrier)
// Everyone dives into BEGIN IMMEDIATE at the same instant, aligned by wall clock.
// ⚠ Spinning the whole wait burns CPU across 8-12 processes and the barrier ITSELF
//   scatters the arrivals it is meant to align. Sleep the bulk, spin the last ms.
const enter = Date.now();
const margin = startAt - enter;          // negative = started too late for the barrier
if (margin > 5) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, margin - 5);
while (Date.now() < startAt) {}
let v;
try {
  const got = store.claim(db, "engine", 30, { route: "main", line: "engine" });
  v = got ? String(got.id) : "null";
} catch (e) { v = "ERR:" + String(e.message).slice(0, 60); }
// ⭐ Report not only the result but WHETHER WE MADE THE BARRIER. Silent lateness
//   thins the race with nobody noticing — the same family as the original defect.
process.stdout.write(JSON.stringify({ v, margin, late: margin < 0 }));
`);

  const raceOnce = async (storePath, N = 8, scale = 1) => {
    // Absorb startup cost (N node processes on Windows = hundreds of ms) before the
    // simultaneous dive. Budget scales with N — running 12 mutant children on an
    // 8-child budget makes them late, thins the race, and "no double issue" becomes
    // "cannot detect". If it's still not enough the children DECLARE late=true, so
    // thinning is never silent.
    const startAt = Date.now() + (600 + N * 120) * scale;  // scale: re-run budget ramp
    const kids = Array.from({ length: N }, () =>
      new Promise((resolve) => {
        const pr = spawn(process.execPath, [child, storePath, String(startAt)],
                         { env: { ...process.env } });
        let out = "";
        pr.stdout.on("data", (b) => out += b);
        pr.on("close", () => {
          const s = out.trim();
          // Silently dropping broken output turns into "0 errors". Count unreadable
          // as ERR.
          try { resolve(JSON.parse(s)); }
          catch { resolve({ v: "ERR:unparsable<" + s.slice(0, 40) + ">", margin: -1, late: true }); }
        });
      }));
    return Promise.all(kids);                  // <- all launched first, THEN awaited = real concurrency
  };

  const STORE = join(__dirname, "..", "core", "store.js").replaceAll(String.fromCharCode(92), "/");
  // ⚠ Lateness is not judged in one shot (measured: a -52ms spawn jitter thinned a
  //   round). A thinned round = VOID (not an engine failure) → clean up the card,
  //   raise the budget, re-run. The guard itself never moves: 3 thinned rounds in a
  //   row still FAIL — a thin race never turns into a PASS.
  let id, results, attempt = 0;
  for (;;) {
    attempt++;
    id = store.add(db, { subject: "the only card #" + attempt, route: "main", line: "engine" });
    results = await raceOnce(STORE, 8, attempt);
    if (!results.some((r) => r.late) || attempt >= 3) break;
    console.log(`      [re-run] barrier missed by ${results.filter((r) => r.late).length} child(ren) -> round void, retrying at budget x${attempt + 1}`);
    const t0 = store.get(db, id);
    if (t0.status === "in_progress")
      store.report(db, { id, worker: t0.worker, outcome: "done", evidence: "thinned round (re-made)" });
    store.archive(db, { id, force: true });
  }
  const vs = results.map((r) => r.v);
  const winners = vs.filter((r) => r === String(id));
  ok("8 processes claim AT ONCE, the same card is issued exactly once", winners.length === 1,
     `winners ${winners.length}, results=[${vs.join(",")}]`);
  ok("everyone else gets null (not an error, not an exception)", vs.filter((r) => r === "null").length === 7,
     `null=${vs.filter((r) => r === "null").length} err=${vs.filter((r) => r.startsWith("ERR")).length}`);
  // ⭐ This probe's power rests on "was it really simultaneous". Without counting the
  //   late arrivals, a thinned race still PASSES — an instrument that does not
  //   report its own degradation.
  const lateN = results.filter((r) => r.late).length;
  ok("all 8 made the barrier (the race was not silently thinned)", lateN === 0,
     `late ${lateN} / min margin ${Math.min(...results.map((r) => r.margin))}ms / settled on round ${attempt}`);
  const after = store.get(db, id);
  ok("card lands in_progress with attempts=1 (not multiply counted)", after.status === "in_progress" && after.attempts === 1,
     `status=${after.status} attempts=${after.attempts}`);
  ok("heartbeat initialized at claim", after.heartbeat_at !== null);
  store.report(db, { id, worker: "engine", outcome: "done", evidence: "ok" });
  store.resolve(db, { id, verdict: "approve" });

  // ⭐ Mutation check: run the same race on a store with broken atomicity and verify
  //   the probe TURNS RED. A probe that doesn't may not call itself an atomicity
  //   probe.
  //
  //   ⚠ The first mutation (BEGIN IMMEDIATE -> DEFERRED) did NOT turn red: WAL +
  //     busy_timeout=5000 still serialize the writes, so IMMEDIATE alone is not the
  //     load-bearing wall in this environment (a measured fact). Hence the mutation
  //     goes one level deeper: remove the TRANSACTION entirely (BEGIN/COMMIT/
  //     ROLLBACK all no-ops), which lets other processes interleave between SELECT
  //     and UPDATE — double issue becomes possible.
  const src = readFileSync(join(__dirname, "..", "core", "store.js"), "utf8");

  const mkMutant = (name, fn) => {
    const f = join(TMP, name);
    const out = fn(src);
    if (out === src) return null;
    writeFileSync(f, out);
    return f.replaceAll(String.fromCharCode(92), "/");
  };
  const raceMutant = async (path, label) => {
    const mid = store.add(db, { subject: "mutation check " + label, route: "main", line: "engine" });
    const rr = await raceOnce(path, 12);
    const win = rr.filter((x) => x.v === String(mid)).length;
    const err = rr.filter((x) => x.v.startsWith("ERR")).length;
    const late = rr.filter((x) => x.late).length;
    const t = store.get(db, mid);
    if (t.status === "in_progress") store.report(db, { id: mid, worker: t.worker, outcome: "done", evidence: "x" });
    store.archive(db, { id: mid, force: true });
    return { win, err, late, rr };
  };

  const mDef = mkMutant("m_deferred.js", (x) =>
    x.replace('db.exec("BEGIN IMMEDIATE");', 'db.exec("BEGIN DEFERRED");'));
  const rDef = await raceMutant(mDef, "DEFERRED");
  // Recorded observation only — not a judgment (measured not to break here).
  console.log(`      [record] BEGIN DEFERRED: winners ${rDef.win} / errors ${rDef.err} / late ${rDef.late}` +
              `${rDef.win === 1 && rDef.err === 0 ? "  <- does not break (WAL+busy_timeout serialize)" : ""}`);

  // ⚠ All replaceAll. Plain `replace` hits only the first occurrence, and store.js
  //   has BEGIN IMMEDIATE in two places (claim / claimById) — a mutant claiming
  //   "transaction removed entirely" while half of it survives. Harmless today (the
  //   child only calls claim), but a mutant that is not what it says it is WILL
  //   deceive someone later.
  // ⚠ Removing the transaction is NECESSARY but not SUFFICIENT for the positive
  //   control: on a slow, serialized runner each child's SELECT→UPDATE completes
  //   inside one timeslice and the mutant never interleaves — measured on a
  //   private-mirror windows runner: 8 rounds of "1w/0err" and the probe honestly
  //   reported it could not measure (red on healthy code). A positive control
  //   that depends on scheduler luck is flaky BY CONSTRUCTION. So the mutant also
  //   HOLDS THE WINDOW OPEN: a 120ms spin between picking the card and stamping
  //   it, making the interleave certain on any runner. The spin exists only in
  //   the mutant — the real store is untouched, and the real-race section above
  //   still measures the genuine article.
  const SPIN_ANCHOR = 'if (!pick) { db.exec("COMMIT"); return null; }';
  ok("mutant window anchor present exactly once (rot check)",
     src.split(SPIN_ANCHOR).length === 2, `occurrences=${src.split(SPIN_ANCHOR).length - 1}`);
  const mNoTx = mkMutant("m_notx.js", (x) => x
    .replaceAll(SPIN_ANCHOR, SPIN_ANCHOR +
      '\n    { const _w0 = Date.now(); while (Date.now() - _w0 < 120) {} } // mutant-only: hold the select->update window open')
    .replaceAll('db.exec("BEGIN IMMEDIATE");', '/* no tx */')
    .replaceAll('db.exec("COMMIT");', '/* no commit */')
    .replaceAll('try { db.exec("ROLLBACK"); } catch {}', '/* no rollback */'));
  ok("mutant built (transaction removed entirely)", mNoTx !== null);
  // Races are inherently probabilistic; even without atomicity a round can end 1-0
  // by luck. A one-shot judgment makes THE PROBE unstable (measured: 42/1 and 43/0
  // alternating on identical code). So run up to K rounds; "broke at least once" =
  // detected. K raised 4 -> 8; we exit on detection, so healthy runs pay nothing
  // extra. The worst quality of failure is turning red on LUCK rather than a probe
  // defect.
  const K = 8;
  const rounds = [];
  let broke = false;
  for (let i = 0; i < K && !broke; i++) {
    const r = await raceMutant(mNoTx, `NO-TX#${i + 1}`);
    rounds.push(`${r.win}w/${r.err}err/${r.late}late`);
    // ⭐ The criterion is "DOUBLE ISSUE happened" = win > 1. Two things it must NOT
    //   be: win !== 1 (that counts win===0 — nobody got it — as "detected"), and
    //   win>1 && err===0. The error-free clause looked prudent but was wrong on both
    //   ends: winners are counted ONLY from successful claim reports, so an error in
    //   a THIRD process cannot mint a false winner — and on the slower CI runner the
    //   mutant's real double issues consistently arrived alongside one SQLITE_BUSY,
    //   so the probe rejected its own proof and went red on a healthy tree
    //   (measured: rounds showed "2w/1err" and the assertion still failed).
    if (r.win > 1) broke = true;
  }
  ok(`⭐ breaking atomicity double-issues the same card (within ${K} rounds)`, broke,
     `NO-TX mutant rounds: [${rounds.join(" ")}]${broke ? " <- double issue caught = detection ability proven" : " <- no double issue = this probe cannot measure atomicity"}`);
}

// ───────────────────────────────────────────────────────────────
section("② expired leases are reaped automatically");
{
  const id = store.add(db, { subject: "card that will expire", line: "engine" });
  store.claim(db, "engine", 30, { line: "engine" });
  // Push the lease into the past = simulate a worker dying mid-flight
  db.prepare("UPDATE tasks SET lease_until=? WHERE id=?").run(Date.now() - 1000, id);
  ok("in_progress before the reap", store.get(db, id).status === "in_progress");
  // ⭐ Recovery works WITHOUT anyone calling claim (if reaping lived only inside
  //   claim, the moment every worker dies the cards squat in in_progress forever —
  //   measured, it happened).
  const reaped = store.reapExpired(db);
  ok("the reaper alone returns it, no claim needed", reaped === 1 && store.get(db, id).status === "not_started",
     `reaped ${reaped} -> status=${store.get(db, id).status}`);
  ok("reaping clears worker and heartbeat (a corpse must not look alive)",
     store.get(db, id).worker === null && store.get(db, id).heartbeat_at === null);
  ok("cards within their lease are not reaped", store.reapExpired(db) === 0);

  const again = store.claim(db, "engine2", 30, { line: "engine" });
  ok("after the reap it is issued again normally", again && again.id === id,
     `re-claimed id=${again && again.id}`);
  ok("attempts accumulated to 2", store.get(db, id).attempts === 2);
  store.report(db, { id, worker: "engine2", outcome: "done", evidence: "ok" });
  store.resolve(db, { id, verdict: "approve" });
}

// ───────────────────────────────────────────────────────────────
section("③ lock_key mutual exclusion (claim skips + unique index backstop)");
{
  const a = store.add(db, { subject: "lockA-first", line: "engine", lockKey: "prod_db" });
  const b = store.add(db, { subject: "lockA-second", line: "engine", lockKey: "prod_db" });
  const c = store.add(db, { subject: "lockless card", line: "engine" });
  const first = store.claim(db, "engine", 30, { line: "engine" });
  ok("the lock-holding A is claimed first", first.id === a, `claimed id=${first.id}`);
  const second = store.claim(db, "engine2", 30, { line: "engine" });
  ok("with the lock held, B is skipped and lockless C is claimed (no error, no empty)", second && second.id === c,
     `claimed id=${second && second.id} (B=${b} should be skipped)`);
  ok("B is still not_started", store.get(db, b).status === "not_started");

  // Backstop: writing around claim must be rejected by the unique index
  let rejected = false, msg = "";
  try {
    db.prepare("UPDATE tasks SET status='in_progress', worker='sneaky' WHERE id=?").run(b);
  } catch (e) { rejected = true; msg = String(e.message).slice(0, 60); }
  ok("direct write bypassing claim is rejected by the unique index (DB guarantee, not discipline)", rejected, msg);

  for (const [id, w] of [[a, "engine"], [c, "engine2"]]) {
    store.report(db, { id, worker: w, outcome: "done", evidence: "ok" });
    store.resolve(db, { id, verdict: "approve" });
  }
  store.archive(db, { id: b });
}

// ───────────────────────────────────────────────────────────────
section("④ route / line never cross + released gate");
{
  const dcard = store.add(db, { subject: "design-line card", line: "design" });
  const l0card = store.add(db, { subject: "aux-route card", route: "aux", line: "engine" });
  const held = store.add(db, { subject: "unreleased card", line: "engine", released: 0 });

  const asEngine = store.claim(db, "engine", 30, { route: "main", line: "engine" });
  ok("engine cannot claim design's card / the aux route / the unreleased one", asEngine === null,
     `claimed=${asEngine === null ? "null" : asEngine.id}`);

  const asDesign = store.claim(db, "design", 30, { route: "main", line: "design" });
  ok("design claims its own card", asDesign && asDesign.id === dcard);

  store.setReleased(db, { id: held, released: 1 });
  const afterRelease = store.claim(db, "engine", 30, { route: "main", line: "engine" });
  ok("after release, engine claims it immediately", afterRelease && afterRelease.id === held);

  // waiting stops only its own chain: design's card goes waiting, engine's work
  // is untouched
  store.report(db, { id: dcard, worker: "design", outcome: "wait", evidence: "waiting on a ruling" });
  ok("the waiting breakdown lands on decision", store.get(db, dcard).waiting_for === "decision");
  const engineStillWorks = store.get(db, held).status === "in_progress";
  ok("another line's waiting does not affect what engine holds", engineStillWorks);

  // Dependency chains: a card with unfinished deps cannot be claimed
  const dep = store.add(db, { subject: "depends on the design card", line: "engine", blockedBy: [dcard] });
  store.report(db, { id: held, worker: "engine", outcome: "done", evidence: "ok" });
  store.resolve(db, { id: held, verdict: "approve" });
  const blocked = store.claim(db, "engine", 30, { line: "engine" });
  ok("while the dep is not done, the successor cannot be claimed (chain paused)", blocked === null,
     `claimed=${blocked === null ? "null" : blocked.id}`);
  store.resolve(db, { id: dcard, verdict: "approve" });
  const unblocked = store.claim(db, "engine", 30, { line: "engine" });
  ok("dep done -> successor claimable immediately (chain resumes)", unblocked && unblocked.id === dep);
  store.report(db, { id: dep, worker: "engine", outcome: "done", evidence: "ok" });
  store.resolve(db, { id: dep, verdict: "approve" });
}

// ───────────────────────────────────────────────────────────────
section("④bis claimById claims THE GIVEN id (never degrades to pick-a-card)");
{
  const a = store.add(db, { subject: "card at the head", line: "engine" });
  const target = store.add(db, { subject: "the targeted card", line: "engine" });
  const r = store.claimById(db, { id: target, worker: "engine" });
  ok("the requested id comes back (not the head card)", r.ok && r.task.id === target,
     `asked ${target} -> got ${r.ok ? r.task.id : "refused:" + r.why} (head is ${a})`);
  ok("the head card is untouched", store.get(db, a).status === "not_started");

  const dup = store.claimById(db, { id: target, worker: "engine2" });
  ok("an in_progress card is refused with the reason named", !dup.ok && /in_progress/.test(dup.why), dup.why);

  const held = store.add(db, { subject: "unreleased", line: "engine", released: 0 });
  const r2 = store.claimById(db, { id: held, worker: "engine" });
  ok("unreleased is refused, reason says so", !r2.ok && /未放行/.test(r2.why), r2.why);

  const g = store.add(db, { subject: "a goal", kind: "goal" });
  const r3 = store.claimById(db, { id: g, worker: "engine" });
  ok("goals are refused", !r3.ok && /目标/.test(r3.why), r3.why);

  const dep = store.add(db, { subject: "unfinished dep", line: "engine", blockedBy: [held] });
  const r4 = store.claimById(db, { id: dep, worker: "engine" });
  ok("unfinished deps are refused with the blocking card named", !r4.ok && r4.why.includes(String(held)), r4.why);

  const r5 = store.claimById(db, { id: 999999, worker: "engine" });
  ok("a nonexistent id is refused", !r5.ok && /不存在/.test(r5.why), r5.why);

  // releaseHeldBy: return what a killed line was holding, on the spot
  const freed = store.releaseHeldBy(db, "engine");
  ok("releaseHeldBy returns that line's in-flight cards", freed.includes(target) && store.get(db, target).status === "not_started",
     `returned=[${freed.join(",")}]`);
  ok("returning clears worker and heartbeat too", store.get(db, target).worker === null && store.get(db, target).heartbeat_at === null);
  ok("a line holding nothing is a no-op", store.releaseHeldBy(db, "nobody").length === 0);

  for (const id of [a, target, held, g, dep]) store.archive(db, { id });
}

// ───────────────────────────────────────────────────────────────
section("⑤ archived_count always present and equal to the real DB");
{
  const truth = Number(
    db.prepare("SELECT COUNT(*) n FROM tasks WHERE archived_at IS NOT NULL").get().n
  );
  const variants = [
    ["default", {}],
    ["archived=false", { archived: "false" }],
    ["archived=true", { archived: "true" }],
    ["archived=all", { archived: "all" }],
    ["with status filter", { status: "done" }],
    ["with line filter", { line: "engine" }],
    ["empty result set", { status: "in_progress", line: "nobody" }],
  ];
  let allHave = true, allMatch = true;
  for (const [name, q] of variants) {
    const r = store.list(db, q);
    if (!("archived_count" in r)) { allHave = false; console.log(`      missing archived_count: ${name}`); }
    else if (r.archived_count !== truth) { allMatch = false; console.log(`      mismatch: ${name} ${r.archived_count}!=${truth}`); }
  }
  ok("all 7 query shapes (incl. empty results) carry archived_count", allHave);
  ok("the value equals a direct DB count", allMatch, `archived in DB=${truth}`);
  const empty = store.list(db, { status: "in_progress", line: "nobody" });
  ok("even an empty result set does not impersonate the full set", empty.tasks.length === 0 && empty.archived_count === truth,
     `tasks=0 yet archived_count=${empty.archived_count}`);
}

// ───────────────────────────────────────────────────────────────
section("⑥ boundaries of the four-value state machine");
{
  ok("STATUS has exactly four values", store.STATUS.length === 4, store.STATUS.join("/"));
  ok("no blocked", !store.VALID_STATUS.has("blocked"));
  const id = store.add(db, { subject: "boundary card", line: "engine" });
  let threw = false;
  try { store.resolve(db, { id, verdict: "approve" }); } catch { threw = true; }
  ok("approving a not_started card is refused", threw);
  store.claim(db, "engine", 30, { line: "engine" });
  threw = false;
  try { store.report(db, { id, worker: "someone-else", outcome: "done" }); } catch { threw = true; }
  ok("a non-holder cannot deliver", threw);
  threw = false;
  try { store.report(db, { id, worker: "engine", outcome: "blocked" }); } catch { threw = true; }
  ok("outcome='blocked' is refused (that ending is abolished)", threw);
  store.report(db, { id, worker: "engine", outcome: "done", evidence: "x" });
  store.resolve(db, { id, verdict: "reject", note: "redo" });
  const back = store.get(db, id);
  ok("a bounce returns to not_started with worker cleared", back.status === "not_started" && back.worker === null);
  ok("a bounce does not clear attempts (retry counts are history)", back.attempts === 1);
}

// ───────────────────────────────────────────────────────────────
section("⑧ goals are never claimed by workers");
{
  const g = store.add(db, { subject: "goal: get the thing done", kind: "goal", line: "engine" });
  // Leftover cards from earlier sections may exist, so the criterion is not "claim
  // returns null" but "however often we claim, the goal NEVER comes out" (the
  // criterion must not depend on ambient state).
  const drained = [];
  for (let i = 0; i < 6; i++) {
    const c = store.claim(db, "engine", 30, { line: "engine" });
    if (!c) break;
    drained.push(c.id);
    store.report(db, { id: c.id, worker: "engine", outcome: "done", evidence: "draining" });
    store.resolve(db, { id: c.id, verdict: "approve" });
  }
  ok("a released goal never comes out however often we claim (kind='task' filter)", !drained.includes(g),
     `claimed=[${drained.join(",")}] / goal id=${g}`);
  ok("the goal stays not_started", store.get(db, g).status === "not_started");

  const c1 = store.add(db, { subject: "child 1", line: "engine", parentId: g });
  const c2 = store.add(db, { subject: "child 2", line: "engine", parentId: g });
  const gotChild = store.claim(db, "engine", 30, { line: "engine" });
  ok("child tasks claim normally", gotChild && gotChild.id === c1);

  const rel = store.relatedIds(db, c2);
  ok("seen from a child, related = parent + all siblings", rel.includes(g) && rel.includes(c1) && rel.includes(c2),
     `[${rel.join(",")}]`);
  const relG = store.relatedIds(db, g);
  ok("seen from the goal, related = itself + all children", relG.length === 3 && relG[0] === g, `[${relG.join(",")}]`);
  const lone = store.add(db, { subject: "parentless one-off", line: "engine" });
  ok("parentless = just itself", store.relatedIds(db, lone).join(",") === String(lone));

  ok("kind filter works", store.list(db, { kind: "goal" }).tasks.every((t) => t.kind === "goal"));
  let threw = false;
  try { store.add(db, { subject: "x", kind: "bogus" }); } catch { threw = true; }
  ok("unknown kind is refused", threw);

  store.report(db, { id: c1, worker: "engine", outcome: "done", evidence: "x" });
  store.resolve(db, { id: c1, verdict: "approve" });
  for (const id of [c2, lone, g]) store.archive(db, { id });
}

// ───────────────────────────────────────────────────────────────
section("⑨ children of a pinned goal are claimed first");
{
  const gA = store.add(db, { subject: "goal A (created first)", kind: "goal" });
  const gB = store.add(db, { subject: "goal B (created later)", kind: "goal" });
  const a1 = store.add(db, { subject: "A's child", line: "engine", parentId: gA });
  const b1 = store.add(db, { subject: "B's child", line: "engine", parentId: gB });
  const solo = store.add(db, { subject: "parentless one-off", line: "engine" });

  // No pin -> id order (A's child first)
  let got = store.claim(db, "engine", 30, { line: "engine" });
  ok("without a pin, id order as before", got.id === a1, `claimed ${got.id} (a1=${a1})`);
  store.report(db, { id: got.id, worker: "engine", outcome: "done", evidence: "x" });
  store.resolve(db, { id: got.id, verdict: "reject" });     // put it back to level the field

  store.setPinned(db, { id: gB, pinned: true });
  got = store.claim(db, "engine", 30, { line: "engine" });
  ok("with goal B pinned, B's child comes first despite the higher id", got.id === b1,
     `claimed ${got.id} (b1=${b1} / a1=${a1} / solo=${solo})`);
  store.report(db, { id: got.id, worker: "engine", outcome: "wait", evidence: "x" });

  const next = store.claim(db, "engine", 30, { line: "engine" });
  ok("when the pinned children run out, normal order resumes", next && next.id === a1, `claimed ${next && next.id}`);
  store.report(db, { id: next.id, worker: "engine", outcome: "wait", evidence: "x" });

  store.setPinned(db, { id: gB, pinned: false });
  ok("unpinning clears pinned_at", store.get(db, gB).pinned_at === null);

  let threw = false;
  try { store.setPinned(db, { id: solo, pinned: true }); } catch { threw = true; }
  ok("pinning a non-goal is refused", threw);

  for (const id of [gA, gB, a1, b1, solo]) store.archive(db, { id, force: true });
}

// ────────────────────────────────────────────────────────────────
// ⑩ The verify registry — cards can carry only a KEY (never a command string)
//
// If this breaks, a worker that can write files nominates a self-authored script and
// the loop executes it = execution-rights bypass. This measures whether "execution
// belongs to the coordinator alone" holds STRUCTURALLY.
console.log("\n[⑩ verification = registry keys only (no command strings)]");
{
  const reg = store.verifyRegistry();
  ok("the registry is readable and non-empty", Object.keys(reg).length > 0, Object.keys(reg).join(" / "));
  ok("values are argv arrays (not strings = no shell interpretation sneaks in)",
     Object.values(reg).every((v) => Array.isArray(v) && v.every((x) => typeof x === "string")));

  const key = Object.keys(reg)[0];
  ok("a registered key passes", store.assertVerify(key) === key, key);
  ok("unset means 'no verification' and is legal", store.assertVerify(null) === null && store.assertVerify("") === null);

  const bad = ["node tools/evil.mjs", "selftest; rm -rf /", "../../etc/passwd",
               "node -e require('child_process')", "selftest && curl evil.example"];
  const rejected = bad.filter((v) => {
    try { store.assertVerify(v); return false; } catch { return true; }
  });
  ok("⭐ command strings, injections and traversals are ALL refused (unknown falls to the refusal side)",
     rejected.length === bad.length, `${rejected.length}/${bad.length}`);

  // The same gate must sit ON THE ROAD: being able to call the validator directly
  // means nothing if add/update wave things through.
  let addBlocked = false;
  try { store.add(db, { subject: "x", verifyCmd: "node tools/evil.mjs" }); }
  catch { addBlocked = true; }
  ok("the creation path refuses too", addBlocked);

  const okId = store.add(db, { subject: "card with verification", verifyCmd: key });
  ok("a correct key lands on the card", store.get(db, okId).verify_cmd === key);

  let updBlocked = false;
  try { store.update(db, { id: okId, verifyCmd: "evil" }); } catch { updBlocked = true; }
  ok("the edit path refuses too", updBlocked);
  ok("after the refusal the card's value is intact", store.get(db, okId).verify_cmd === key);

  // If claim does not carry the key, the loop cannot know what to run
  store.setReleased(db, { id: okId, released: 1 });
  const got = store.claim(db, "engine", 30, { route: "main", line: null });
  ok("claim's return carries the key (the loop can receive it)",
     got && store.get(db, got.id).verify_cmd !== undefined);
}


// ────────────────────────────────────────────────────────────────
// ⑩bis An in-progress card refuses EVERY field — except a pure tail-append to
//   description, which is allowed because the worker snapshotted the card into its
//   prompt at claim time and never re-reads it. The refusal text has to be as wide as
//   the rule: while it named only "moving the line", callers who were not sending a
//   line read it as "then mine should pass" and retried the identical edit forever.
// ────────────────────────────────────────────────────────────────
section("⑩bis in-progress edit gate + description tail-append");
{
  /** Run and hand back the thrown error (null when nothing threw), so the assertion
   *  can state BOTH that it was refused and that nothing moved. */
  const grabErr = (fn) => { try { fn(); return null; } catch (e) { return e; } };
  const id = store.add(db, { subject: "在途追记试验", description: "认领时原文", line: "engine" });
  store.claimById(db, { id, worker: "engine@3" });

  const blocked = grabErr(() => store.update(db, { id, maxAttempts: 9 }));
  ok("⭐an in-progress edit is CONFLICT and the text says EVERY field, not just the line",
     blocked?.code === store.ERR.CONFLICT && /in_progress/.test(blocked.message) &&
     /不可 edit 任何字段/.test(blocked.message), blocked?.message || "it went through");
  ok("the refused edit moved no value", store.get(db, id).max_attempts === 3);

  const appended = "认领时原文\n—— 追记:人的裁定 ——";
  const r = store.update(db, { id, description: appended });
  ok("⭐only a pure tail-append passes while in progress",
     r.changed === 1 && store.get(db, id).description === appended);
  ok("the return states prompt = claim-time snapshot, invisible to THIS round's worker",
     /认领时快照/.test(r.notice || "") && /本轮 worker 不可见/.test(r.notice || ""),
     r.notice || "(no notice)");

  const mixed = grabErr(() => store.update(db, { id, description: appended + "x", line: "mail" }));
  ok("an append mixed with another field is refused whole (the exception is not a side door)",
     mixed?.code === store.ERR.CONFLICT && store.get(db, id).line === "engine" &&
     store.get(db, id).description === appended, mixed?.message || "it went through");

  const stale = grabErr(() => store.update(db, { id, description: "认领时原文\n别的追记" }));
  ok("an append computed from a STALE original is refused (a concurrent append is not eaten)",
     stale?.code === store.ERR.CONFLICT && store.get(db, id).description === appended,
     stale?.message || "it went through");

  const nonText = grabErr(() => store.update(db, { id, description: null }));
  ok("a non-string never counts as an append (no String(null) === \"null\" hole)",
     nonText?.code === store.ERR.CONFLICT && store.get(db, id).description === appended);

  // ⭐ Beyond the origin implementation, which decides "description only" from a
  //   hand-kept list of sibling fields: a key that is not on that list rides along.
  //   Deriving the check from the CALL makes an unknown key — new, misspelled or
  //   hostile — fall on the refusing side by construction.
  const unknown = grabErr(() => store.update(db, { id, description: appended + "y", someNewField: 1 }));
  ok("⭐an UNKNOWN key alongside the append is refused too (derived, not hand-listed)",
     unknown?.code === store.ERR.CONFLICT && store.get(db, id).description === appended,
     unknown?.message || "it went through");

  const idle = store.add(db, { subject: "未开始的卡", description: "原文", line: "engine" });
  const w = store.update(db, { id: idle, description: "完全重写", line: "mail" });
  ok("a card that is not in progress still takes arbitrary edits (the gate is scoped)",
     w.changed === 2 && store.get(db, idle).description === "完全重写" && !w.notice);

  // ⚠ Take this section's fixtures OUT of the claimable pool. Later sections claim by
  //   queue order ("give me the oldest card on this line"), so a leftover released card
  //   here is silently handed to a fixture down the file — measured: a later fixture
  //   asked for its own card and got this one, and the failure surfaced far from here.
  store.setReleased(db, { id: idle, released: 0 });
}


// ────────────────────────────────────────────────────────────────
// ⑪ Human text hands the card back / ruling records never vanish / reopen
//
// Measured breakage: review produced A/B/C, the human wrote "A" and pressed approve;
// the card closed with nobody left to execute A, and "A" OVERWROTE the full A/B/C
// text. Ruling: anything a human wrote on — bounce or approve — goes back for
// continuation.
console.log("\n[⑪ human writing is an instruction — hand back, don't close]");
{
  const mkWaiting = (line) => {
    // humanGate:false is explicit — the word "ruling" in the subject trips ⑲'s
    // literal sniffer. This fixture is "an ordinary card that gets ruled on after
    // the worker worked", so no lock is correct.
    const id = store.add(db, { subject: "等待裁定的卡", line, humanGate: false });
    store.claim(db, line, 30, { route: "main", line });
    store.report(db, { id, worker: line, outcome: "done", evidence: "e" });
    return id;
  };

  // ① nothing written + approve -> done, as always
  const a = mkWaiting("engine");
  const ra = store.resolve(db, { id: a, verdict: "approve", note: "", resolvedBy: "human" });
  ok("nothing written + approve = done (as before)", ra.status === "done" && !ra.handed_back);

  // ② written + approve -> NOT done. not_started, ORIGINAL line kept
  const b = mkWaiting("engine");
  store.markAutoReviewed(db, { id: b, note: "## needs your confirmation\n### options\n**A. attach verify_cmd**\n**B. run by hand**\n**C. keep the status quo**" });
  const rb = store.resolve(db, { id: b, verdict: "approve", note: "A", resolvedBy: "human" });
  const tb = store.get(db, b);
  ok("⭐ written + approve does not close", rb.status === "not_started", `status=${rb.status}`);
  ok("⭐ stays on the original line (the original agent continues; routing to the coordinator was a measured double burn)",
     tb.line === "engine", `line=${tb.line}`);
  ok("what was pressed survives (the badge needs it)", tb.last_verdict === "approve", `last_verdict=${tb.last_verdict}`);
  ok("⭐ a handed-back card does not wear a 'passed' face (verdict is null)",
     tb.verdict === null, `verdict=${tb.verdict}`);
  ok("holder and lease are released", !tb.worker && !tb.lease_until && !tb.heartbeat_at);

  // ③ ⭐ the reviewer's A/B/C is not erased
  ok("⭐ the review's A/B/C survives (one human letter does not erase it)",
     /options/.test(tb.verdict_note) && /status quo/.test(tb.verdict_note));
  ok("the human's writing is in there too", /A/.test(tb.verdict_note.split("你的决定")[1] || ""));
  ok("who pressed what, when, is carved into the text",
     /你的决定/.test(tb.verdict_note) && /通过/.test(tb.verdict_note) && /回原线继续/.test(tb.verdict_note));

  // ④ written + reject behaves the same (bounce or approve — same road)
  const c = mkWaiting("design");
  const rc = store.resolve(db, { id: c, verdict: "reject", note: "cost out option B first", resolvedBy: "human" });
  ok("written + reject also stays on the original line", rc.status === "not_started" && store.get(db, c).line === "design");
  ok("recorded as a bounce", store.get(db, c).last_verdict === "reject");   // history goes to last_verdict
  ok("⭐ a written-on bounce also has verdict null (not closed)", store.get(db, c).verdict === null);

  // ⑤ auto-review notes are machine observations; they do not hand back
  const d = mkWaiting("mail");
  const rd = store.resolve(db, { id: d, verdict: "approve", note: "machine judgment: evidence sufficient", resolvedBy: "auto" });
  ok("an auto approve closes as before (only HUMAN writing is an instruction)",
     rd.status === "done" && store.get(db, d).line === "mail");
  ok("the record is still appended", /自动审阅/.test(store.get(db, d).verdict_note));

  // ⭐ Cleanup: after the hand-back ruling, b/c stay in not_started on their original
  //   lines. Left alone, later by-line claims (⑬ tests the claim path itself) would
  //   mis-grab them — close with archive.
  store.archive(db, { id: b });
  store.archive(db, { id: c });

  // reopen
  const e = mkWaiting("engine");
  store.resolve(db, { id: e, verdict: "approve", note: "", resolvedBy: "human" });
  ok("precondition: closed", store.get(db, e).status === "done");
  const ro = store.reopen(db, { id: e, line: "coord" });
  const te = store.get(db, e);
  ok("done -> reopen -> not_started", ro.changed === true && te.status === "not_started", `from=${ro.from}`);
  ok("a line can be assigned in the same breath", te.line === "coord");
  ok("attempts survive a reopen", te.attempts === 1);
  ok("ruling records survive too", te.verdict_note !== null);
  ok("⭐ a reopened card does not wear a 'passed' face (verdict nulled)", te.verdict === null);
  ok("the last ruling is still recorded after reopen", te.last_verdict === "approve", `last_verdict=${te.last_verdict}`);
  ok("already not_started = no-op (idempotent)", store.reopen(db, { id: e }).changed === false);

  const f = store.add(db, { subject: "in-flight card", line: "ux" });
  store.claim(db, "ux", 30, { route: "main", line: "ux" });
  let blocked = false;
  try { store.reopen(db, { id: f }); } catch { blocked = true; }
  ok("an in-flight card cannot be reopened (its delivery would be orphaned)", blocked);
}


// ────────────────────────────────────────────────────────────────
// ⑫ Parents whose derivations all completed return from human-wait to re-review
//
// Ruling: once derivations finish, re-review the parent against their results
// instead of waiting on the human forever. Measured: three cards sat in confirm
// with all children done.
console.log(String.fromCharCode(10) + "[⑫ derivations done -> parent auto-returns to review (rearmDone)]");
{
  const mkWaitingConfirm = (line) => {
    const id = store.add(db, { subject: "parent card", line });
    // ⚠ By-line claiming is forbidden here: ⑪'s cards remain not_started on their
    //   original lines and would be mis-grabbed — claim by id.
    store.claimById(db, { id, worker: line });
    store.report(db, { id, worker: line, outcome: "done", evidence: "e" });
    store.markAutoReviewed(db, { id, note: "A/B/C" });     // reviewed and passed to a human
    return id;
  };
  const finish = (id, line) => {
    store.claimById(db, { id, worker: line });
    store.report(db, { id, worker: line, outcome: "done", evidence: "child output" });
    store.resolve(db, { id, verdict: "approve", note: "", resolvedBy: "auto" });
  };

  const P = mkWaitingConfirm("engine");
  const k1 = store.add(db, { subject: "child 1", line: "engine", parentId: P });
  const k2 = store.add(db, { subject: "child 2", line: "engine", parentId: P });
  ok("precondition: parent is waiting/confirm", store.get(db, P).waiting_for === "confirm");

  finish(k1, "engine");
  ok("no rearm while one child remains", store.rearmDone(db).length === 0);

  finish(k2, "engine");
  const ra = store.rearmDone(db);
  const tp = store.get(db, P);
  ok("⭐ children complete -> parent returns to review", ra.includes(P) && tp.waiting_for === "review",
     `rearmed=${JSON.stringify(ra)} wf=${tp.waiting_for}`);
  ok("the review's seen-mark clears (lands on pendingReview)", tp.auto_review_at === null);
  ok("what happened is carved into the record", /子任务卡/.test(tp.verdict_note) && /自动送回重审/.test(tp.verdict_note));
  ok("pendingReview actually picks it up", store.pendingReview(db).some((x) => x.id === P));

  ok("⭐ the sweep is idempotent (no double rearm on round two)", store.rearmDone(db).length === 0);
  ok("the record does not grow either", (store.get(db, P).verdict_note.match(/自动送回重审/g) || []).length === 1);

  // After the review escalates again, it does not return until a NEWER child finishes
  store.markAutoReviewed(db, { id: P, note: "review says a human is still needed" });
  ok("after re-review (seen-mark newer than children) it does not return", store.rearmDone(db).length === 0);
  const k3 = store.add(db, { subject: "child 3 (added later)", line: "engine", parentId: P });
  ok("while an unfinished new child exists it does not return", store.rearmDone(db).length === 0);
  finish(k3, "engine");
  ok("⭐ once that child finishes it returns again", store.rearmDone(db).includes(P));

  // Things that must NOT be touched
  const noKids = mkWaitingConfirm("ux");
  ok("childless confirm cards are untouched", !store.rearmDone(db).includes(noKids));
  const neverSeen = store.add(db, { subject: "unreviewed parent", line: "ux" });
  store.claim(db, "ux", 30, { route: "main", line: "ux" });
  store.report(db, { id: neverSeen, worker: "ux", outcome: "done", evidence: "e" });
  const k4 = store.add(db, { subject: "child", parentId: neverSeen });
  store.claimById(db, { id: k4, worker: "ux" });
  store.report(db, { id: k4, worker: "ux", outcome: "done", evidence: "e" });
  store.resolve(db, { id: k4, verdict: "approve", note: "", resolvedBy: "auto" });
  ok("an unreviewed (still waiting/review) parent is untouched — it is already in the review queue", !store.rearmDone(db).includes(neverSeen));
}

// ────────────────────────────────────────────────────────────────
// ⑬ work_spans lifecycle — span and state share one transaction
//
// Measured concern: with span-close and state-update as separate writes, a crash in
// between leaves "in_progress but the span is closed" — a torn state. Sealed with
// the invariant: **in_progress ⟺ the last span is open** (after every transition).
console.log(String.fromCharCode(10) + "[⑬ work_spans lifecycle (invariant: in_progress ⟺ open span)]");
{
  const inv = (id) => {
    const t = store.get(db, id);
    const sp = t.work_spans, open = sp.length && !sp[sp.length - 1].e;
    return (t.status === "in_progress") === !!open;
  };
  // ⚠ Route isolation (same shape as ⑮): line=NULL legacy cards are "claimable by
  //   anyone" and pick-a-card would be intercepted.
  const a = store.add(db, { subject: "span card", line: "engine", route: "t13r" });
  store.claim(db, "engine", 30, { route: "t13r", line: "engine" });
  ok("① right after claim: open span, invariant holds", inv(a) && store.get(db, a).work_spans.length === 1);
  ok("  the span records its bearer", store.get(db, a).work_spans[0].w === "engine");

  store.report(db, { id: a, worker: "engine", outcome: "done", evidence: "e" });
  ok("② right after report: closed span, invariant holds", inv(a) && !!store.get(db, a).work_spans[0].e);

  store.resolve(db, { id: a, verdict: "reject", note: "", resolvedBy: "human" });
  store.claimById(db, { id: a, worker: "engine" });
  ok("  re-claim opens a second span", store.get(db, a).work_spans.length === 2 && inv(a));
  store.releaseHeldBy(db, "engine");
  ok("③ right after releaseHeldBy: invariant holds", inv(a));

  store.claimById(db, { id: a, worker: "engine" });
  db.prepare("UPDATE tasks SET lease_until=1 WHERE id=?").run(a);
  store.reapExpired(db);
  ok("④ right after reapExpired: invariant holds", inv(a));

  // The inline reap inside claim (another card's claim sweeping expired leases)
  // must not tear either
  store.claimById(db, { id: a, worker: "engine" });
  db.prepare("UPDATE tasks SET lease_until=1 WHERE id=?").run(a);
  const b = store.add(db, { subject: "span card 2", line: "engine", route: "t13r" });
  store.claim(db, "engine", 30, { route: "t13r", line: "engine" });
  ok("⑤ after claim's inline reap: the reaped card holds the invariant too", inv(a) && inv(b));

  // Crash-equivalent: an open span left behind -> the next claim's spanOpen closes
  // the stale one and opens fresh.
  // ⚠ The first version reused ⑤'s leftover card and the premise collapsed (claim
  //   takes the smallest id — a was claimed, b stayed spanless). Build a dedicated
  //   card.
  const c = store.add(db, { subject: "crash card", line: "engine" });
  store.claimById(db, { id: c, worker: "engine" });
  db.prepare("UPDATE tasks SET status='not_started', worker=NULL, lease_until=NULL WHERE id=?").run(c);
  store.claimById(db, { id: c, worker: "engine" });
  const spc = store.get(db, c).work_spans;
  ok("⑥ a stale open span self-heals on re-claim (close, then open)",
     spc.length === 2 && !!spc[0].e && !spc[1].e,
     JSON.stringify(spc.map((x) => ({ s: !!x.s, e: !!x.e }))));
}

// ────────────────────────────────────────────────────────────────
// ⑭ confirm cards holding unfinished children auto-retreat to rearm (deferToRearm)
//
// Ruling: the confirmation queue must not show cards whose children are still
// running. Complement pair with rearmDone (⑫): non-done child -> retreat / all
// children done -> send back to review.
console.log(String.fromCharCode(10) + "[⑭ confirm with unfinished children -> auto-moved to rearm (deferToRearm)]");
{
  const mk = (line) => { const id = store.add(db, { subject: "confirm-waiting parent", line });
    store.claimById(db, { id, worker: line });
    store.report(db, { id, worker: line, outcome: "done", evidence: "e" });
    store.markAutoReviewed(db, { id, note: "to the human" }); return id; };
  const fin = (id, line) => { store.claimById(db, { id, worker: line });
    store.report(db, { id, worker: line, outcome: "done", evidence: "e" });
    store.resolve(db, { id, verdict: "approve", note: "", resolvedBy: "auto" }); };

  const A = mk("engine");
  const c1 = store.add(db, { subject: "child done", line: "engine", parentId: A });
  const c2 = store.add(db, { subject: "child unfinished", line: "engine", parentId: A });
  fin(c1, "engine");
  const mv = store.deferToRearm(db);
  const ta = store.get(db, A);
  ok("⭐ confirm with an unfinished child -> rearm", mv.includes(A) && ta.waiting_for === "rearm",
     `moved=${JSON.stringify(mv)} wf=${ta.waiting_for}`);
  ok("what happened is carved into the record", /未完/.test(ta.verdict_note) && /转入等待重审/.test(ta.verdict_note));
  ok("not in the review queue (excluded from pendingReview)", !store.pendingReview(db).some((x) => x.id === A));
  ok("⭐ the sweep is idempotent (0 on round two)", store.deferToRearm(db).length === 0);
  ok("the record does not grow either", (store.get(db, A).verdict_note.match(/转入等待重审/g) || []).length === 1);

  fin(c2, "engine");
  const ra = store.rearmDone(db);
  const ta2 = store.get(db, A);
  ok("⭐ children complete -> rearmDone sends it back to review (the complement pair closes)",
     ra.includes(A) && ta2.waiting_for === "review" && ta2.auto_review_at === null,
     `wf=${ta2.waiting_for}`);

  // Outside the ruling — measure what it does NOT touch (never widen a ruling)
  const Bq = mk("ux");
  ok("childless confirm cards are untouched", !store.deferToRearm(db).includes(Bq) && store.get(db, Bq).waiting_for === "confirm");
  const C = mk("design");
  const c3 = store.add(db, { subject: "child all-done", line: "design", parentId: C });
  fin(c3, "design");
  ok("confirm with all children done is untouched (that is rearmDone's jurisdiction)", !store.deferToRearm(db).includes(C));
  const D = store.add(db, { subject: "pre-review parent", line: "mail" });
  store.claimById(db, { id: D, worker: "mail" });
  store.report(db, { id: D, worker: "mail", outcome: "done", evidence: "e" });
  store.add(db, { subject: "child unfinished", parentId: D });
  ok("waiting/review (unreviewed) is out of scope — the ruling covers confirm only",
     !store.deferToRearm(db).includes(D) && store.get(db, D).waiting_for === "review");
}

// ────────────────────────────────────────────────────────────────
// ⑮ Parent gate (ruling): a card with unfinished children never enters in_progress
console.log(String.fromCharCode(10) + "[⑮ parent gate: unfinished children -> unclaimable]");
{
  // ⚠ Isolation uses a route (strict equality), not a line — line=NULL legacy cards
  //   are "claimable by anyone" and intercept (measured: by-line claiming grabbed a
  //   stranger's card instead of this section's child).
  const pa = store.add(db, { subject: "parent card", line: "t14", route: "t15r" });
  const ch = store.add(db, { subject: "child card", line: "t14", route: "t15r", parentId: pa });
  const got1 = store.claim(db, "t14", 30, { route: "t15r", line: "t14" });
  ok("① pick-a-card skips the parent and claims the child", got1 && got1.id === ch, `claimed #${got1 && got1.id}`);
  const r1 = store.claimById(db, { id: pa, worker: "t14" });
  ok("② claiming the parent by name is refused, children named", r1.ok === false && String(r1.why).includes("#" + ch), r1.why);
  store.report(db, { id: ch, worker: "t14", outcome: "done", evidence: "e" });
  store.resolve(db, { id: ch, verdict: "approve", note: "", resolvedBy: "human" });
  const r2 = store.claimById(db, { id: pa, worker: "t14" });
  ok("③ all children done -> parent claimable (the gate blocks only the unfinished)", r2.ok === true, r2.ok ? "" : r2.why);
  store.report(db, { id: pa, worker: "t14", outcome: "done", evidence: "e" });
  store.resolve(db, { id: pa, verdict: "approve", note: "", resolvedBy: "human" });
  store.archive(db, { id: pa }); store.archive(db, { id: ch });
}

// ────────────────────────────────────────────────────────────────
// ⑯ Provenance stamp prev_line (single routing + provenance, one assignment site)
console.log(String.fromCharCode(10) + "[⑯ provenance stamp prev_line]");
{
  const a = store.add(db, { subject: "provenance card", line: "design", route: "t16r" });
  store.update(db, { id: a, line: "ux" });
  ok("① update design->ux: prev_line=design", store.get(db, a).prev_line === "design");
  store.update(db, { id: a, line: "engine" });
  ok("② move again: overwritten with the immediately previous line (one hop only)", store.get(db, a).prev_line === "ux");
  store.update(db, { id: a, line: "engine" });
  ok("③ same-value write does not stamp", store.get(db, a).prev_line === "ux");
  store.update(db, { id: a, line: null });
  ok("④ line->null stamps (remembers it came from engine)",
     store.get(db, a).prev_line === "engine" && store.get(db, a).line == null);
  const b2 = store.add(db, { subject: "no-provenance card", route: "t16r" });
  store.update(db, { id: b2, line: "mail" });
  ok("⑤ null->line does not stamp (no provenance to keep)", store.get(db, b2).prev_line == null);
  const c2 = store.add(db, { subject: "reopen card", line: "sec", route: "t16r" });
  store.claimById(db, { id: c2, worker: "sec" });
  store.report(db, { id: c2, worker: "sec", outcome: "done", evidence: "e" });
  store.reopen(db, { id: c2, line: "mail" });
  ok("⑥ reopen with a line change sec->mail stamps", store.get(db, c2).prev_line === "sec" && store.get(db, c2).line === "mail");
  const r3 = store.update(db, { id: b2, prevLine: "sec" });
  ok("⑦ prevLine is not a writable update key (zero change at the store layer; the API layer 400s separately)",
     r3.changed === 0 && store.get(db, b2).prev_line == null);
  // Lexical proof: the assignment fragment is unique file-wide.
  // ⚠ The criterion was widened from "SET prev_line=" to EVERY assignment shape:
  //   the old one counted only standalone UPDATE statements, so a second site in
  //   fragment form (sets.push(...)) would sail through at 0.
  const srcStore = readFileSync(join(__dirname, "..", "core", "store.js"), "utf8");
  const nAssign = (srcStore.match(/prev_line\s*=/g) || []).length;
  ok("⑧ the stamp's assignment site is unique file-wide (grep proof)", nAssign === 1, `measured ${nAssign} site(s)`);
  // (The origin suite also lexically checked a re-orchestration loop's set_line /
  //  set_weight branches here; that loop is not part of this extraction — those
  //  checks return with it.)

  // ── ⑨b weight column (store level: default / accept / change) ────────────────
  {
    const w1 = store.add(db, { subject: "default-weight card", route: "t16w" });
    ok("⑨b-1 weight defaults to standard (unspecified cards go to the middle)", store.get(db, w1).weight === "standard",
       `weight=${store.get(db, w1).weight}`);
    const w2 = store.add(db, { subject: "heavy card", route: "t16w", weight: "heavy" });
    ok("⑨b-2 creation accepts a weight", store.get(db, w2).weight === "heavy");
    const rw = store.update(db, { id: w1, weight: "light" });
    ok("⑨b-3 update can change weight (and counts it in changed)",
       store.get(db, w1).weight === "light" && rw.changed === 1, `changed=${rw.changed}`);
    // ⚠ Existing caliber unbroken: an update without weight does not move weight.
    store.update(db, { id: w1, line: "engine" });
    ok("⑨b-4 an update without weight leaves weight alone", store.get(db, w1).weight === "light");
  }

  // ⭐ ⑩ Invariant (same shape as ⑬): right after every line-changing write,
  //   prev_line ∈ { the line before the write, the prev_line before the write }.
  //   The former = stamped / the latter = debounced. Anything else is a half-write
  //   or a mix-up. ⚠ Watching prev alone misses "the line never moved" half-writes
  //   ⇒ watch line AND provenance.
  const moveOK = (id, to) => {
    const b = store.get(db, id);
    store.update(db, { id, line: to });
    const a3 = store.get(db, id);
    return (a3.line ?? null) === (to ?? null)
        && ((a3.prev_line ?? null) === (b.line ?? null)
         || (a3.prev_line ?? null) === (b.prev_line ?? null));
  };
  const inv1 = store.add(db, { subject: "invariant card", line: "design", route: "t16r" });
  ok("⑩ invariant: no half-write on any step of design->ux->null->mail",
     moveOK(inv1, "ux") && moveOK(inv1, null) && moveOK(inv1, "mail"));
  ok("  ⭐ end state of A->null->B is prev_line=A (null->line does not stamp = the last real line survives)",
     store.get(db, inv1).prev_line === "ux" && store.get(db, inv1).line === "mail");

  // ⭐ ⑪ Injected interruption (EXECUTION-layer proof that line change and stamp are
  //   one statement): force the UPDATE containing the stamp to fail and observe that
  //   NEITHER moved. ⚠★ Not vacuous: under the old two-statement implementation the
  //   main UPDATE lands first and only the stamp fails ⇒ line==='ux' turns this RED.
  //   So this test can DISTINGUISH one-statement from two.
  const inj = store.add(db, { subject: "interruption card", line: "design", route: "t16r" });
  const realPrepare = db.prepare.bind(db);
  let hit = 0, threw = false;
  db.prepare = (sql) => {
    const st = realPrepare(sql);
    if (/UPDATE\s+tasks\s+SET/i.test(sql) && /prev_line\s*=/.test(sql)) {
      hit++;
      return { run: () => { throw new Error("injected interruption"); },
               get: (...x) => st.get(...x), all: (...x) => st.all(...x) };
    }
    return st;
  };
  try { store.update(db, { id: inj, line: "ux" }); }
  catch { threw = true; }
  finally { db.prepare = realPrepare; }   // ⚠ restore by assignment, not delete (safe even if the original sat on the prototype)
  const iv = store.get(db, inj);
  ok("⑪ ⭐ with an injected interruption NEITHER line NOR provenance moves (no half-write)",
     hit === 1 && threw && iv.line === "design" && iv.prev_line == null,
     `injected=${hit} threw=${threw} line=${iv.line} prev=${iv.prev_line}`);

  for (const x of [a, b2, c2, inv1, inj]) store.archive(db, { id: x });
}

// ────────────────────────────────────────────────────────────────
// ⑰ Completed goals must not be archived (ruling) — scope measured in BOTH directions
console.log(String.fromCharCode(10) + "[⑰ done-goal archive gate]");
{
  const g = store.add(db, { subject: "completed goal", kind: "goal" });
  db.prepare("UPDATE tasks SET status='done' WHERE id=?").run(g);
  let threw = null;
  try { store.archive(db, { id: g }); } catch (e) { threw = e; }
  ok("① archiving a done goal is refused, naming the ruling", !!threw && String(threw.message).includes("不准归档"),
     threw ? threw.message : "it archived!");
  ok("  the card is untouched", !store.get(db, g).archived_at);
  let forcedGoal = null;
  try { store.archive(db, { id: g, force: true }); } catch (e) { forcedGoal = e; }
  ok("  force does not bypass the done-goal prohibition",
     forcedGoal?.code === store.ERR.BAD_INPUT && !store.get(db, g).archived_at,
     forcedGoal ? forcedGoal.message : "force-archived!");
  const g2 = store.add(db, { subject: "unfinished goal", kind: "goal" });
  store.archive(db, { id: g2 });
  ok("② an un-done goal archives as usual (the ruling is not widened)", !!store.get(db, g2).archived_at);
  const tk = store.add(db, { subject: "done task", line: "t17", route: "t17r" });
  db.prepare("UPDATE tasks SET status='done' WHERE id=?").run(tk);
  store.archive(db, { id: tk });
  ok("③ a done TASK archives as usual (the ruling is not widened)", !!store.get(db, tk).archived_at);
  db.prepare("UPDATE tasks SET status='not_started' WHERE id=?").run(g);
  store.archive(db, { id: g });   // clean up
}

// ────────────────────────────────────────────────────────────────
// ⑱ archive status gate — waiting/in_progress refused, done/not_started normal,
//    force is explicit-only
console.log(String.fromCharCode(10) + "[⑱ archive status gate]");
{
  const mk = (subject) => store.add(db, { subject, line: "t224", route: "t224r" });
  const rejected = (id, status) => {
    let e = null;
    try { store.archive(db, { id }); } catch (x) { e = x; }
    ok(`archiving a ${status} card is refused with the reason`,
       !!e && e.code === store.ERR.CONFLICT && String(e.message).includes(status) &&
       String(e.message).includes("不能归档") && !store.get(db, id).archived_at,
       e ? e.message : "it archived!");
  };

  const inProgress = mk("gate: in_progress negative");
  store.claimById(db, { id: inProgress, worker: "t224" });
  rejected(inProgress, "in_progress");

  const waiting = mk("gate: waiting negative");
  store.claimById(db, { id: waiting, worker: "t224" });
  store.report(db, { id: waiting, worker: "t224", outcome: "wait", evidence: "status-gate negative" });
  rejected(waiting, "waiting");
  let stringForce = null;
  try { store.archive(db, { id: waiting, force: "true" }); } catch (e) { stringForce = e; }
  ok("the string force='true' is not an explicit force flag",
     stringForce?.code === store.ERR.CONFLICT && !store.get(db, waiting).archived_at,
     stringForce ? stringForce.message : "it archived!");

  const notStarted = mk("gate: not_started positive");
  store.archive(db, { id: notStarted });
  ok("not_started archives as usual", !!store.get(db, notStarted).archived_at);

  const done = mk("gate: done positive");
  store.claimById(db, { id: done, worker: "t224" });
  store.report(db, { id: done, worker: "t224", outcome: "done", evidence: "status-gate positive" });
  store.resolve(db, { id: done, verdict: "approve", note: "", resolvedBy: "human" });
  store.archive(db, { id: done });
  ok("done tasks archive as usual", !!store.get(db, done).archived_at);

  store.archive(db, { id: inProgress, force: true });
  store.archive(db, { id: waiting, force: true });
  ok("only explicit force=true can force-archive active cards",
     !!store.get(db, inProgress).archived_at && !!store.get(db, waiting).archived_at);
}

// ────────────────────────────────────────────────────────────────
// ⑲ Ruling cards' human_gate creation default + lock source (src) + layered unlock
console.log(String.fromCharCode(10) + "[⑲ ruling cards: human_gate default + layered unlock]");
{
  const g1 = store.add(db, { subject: "#t19 口径裁定: 建卡既定测试", line: "t19" });
  const r1 = store.get(db, g1);
  ok("'ruling' in the subject -> default human_gate=1, src=detect",
     Number(r1.human_gate) === 1 && r1.human_gate_src === "detect");
  try { store.claimById(db, { id: g1, worker: "t19w" }); } catch {}
  ok("even a detector lock guards the queue (a take does not reach in_progress)",
     store.get(db, g1).status === "not_started");

  const g2 = store.add(db, { subject: "商裁等待: 明示 false 胜过探测", humanGate: false, line: "t19" });
  ok("explicit humanGate:false -> no lock (explicit always wins)",
     Number(store.get(db, g2).human_gate) === 0 && store.get(db, g2).human_gate_src == null);

  const g3 = store.add(db, { subject: "普通实现卡(t19)", line: "t19" });
  ok("non-ruling cards stay 0 as before", Number(store.get(db, g3).human_gate) === 0);

  const g4 = store.add(db, { subject: "普通卡(t19 未知值)", humanGate: "yes", line: "t19" });
  const r4 = store.get(db, g4);
  ok("unknown values fall to the refusal side = locked, explicit (the side machines cannot unlock)",
     Number(r4.human_gate) === 1 && r4.human_gate_src === "explicit");

  // Layered unlock. waiting is forged directly — a gated card cannot REACH waiting
  // through the claim path, so this fabricates the real-world state "locked via
  // update after being claimed".
  const mkWaiting = (id) => db.prepare(
    "UPDATE tasks SET status='waiting', worker='t19w', waiting_for='review' WHERE id=?").run(id);
  mkWaiting(g1);
  store.resolve(db, { id: g1, verdict: "approve", note: "", resolvedBy: "auto" });
  const a1 = store.get(db, g1);
  ok("an auto ruling can remove a detect lock (the machine's own lock)", Number(a1.human_gate) === 0 && a1.human_gate_src == null);

  mkWaiting(g4);
  store.resolve(db, { id: g4, verdict: "approve", note: "", resolvedBy: "auto" });
  const a4 = store.get(db, g4);
  ok("an auto ruling cannot remove an explicit lock (the INCIDENT-5 wall)",
     Number(a4.human_gate) === 1 && a4.human_gate_src === "explicit");

  const g5 = store.add(db, { subject: "普通卡但明示锁", humanGate: true, line: "t19" });
  mkWaiting(g5);
  store.resolve(db, { id: g5, verdict: "approve", note: "", resolvedBy: "human" });
  const a5 = store.get(db, g5);
  ok("a human ruling removes explicit locks too (no dead-wait)",
     Number(a5.human_gate) === 0 && a5.human_gate_src == null);

  for (const id of [g1, g2, g3, g4, g5]) store.archive(db, { id, force: true });
}

// ────────────────────────────────────────────────────────────────
// ⑯b (parent + normalized subject) unique index — duplicate children blocked by
//     the DATABASE
console.log(String.fromCharCode(10) + "[⑯b duplicate children blocked by the DB unique index]");
{
  const P0 = store.add(db, { subject: "unique-index parent", line: "engine" });
  store.add(db, { subject: "dup proposal A", line: "engine", parentId: P0 });
  let dup = false;
  // Same characters, different spacing — one uses a full-width space, exercising
  // BOTH strip branches of the normalization.
  try { store.add(db, { subject: "dup　proposalA", line: "engine", parentId: P0 }); }
  catch (e) { dup = /UNIQUE/i.test(String((e && e.message) || e)); }
  ok("⭐ same parent + same normalized subject (spacing-only diff): the second is refused by the database", dup);
  const free = store.add(db, { subject: "dup proposal A", line: "engine" });
  ok("a parentless same-name card is unaffected (the partial index covers only parented ones)", !!free);
}

// ────────────────────────────────────────────────────────────────
// ⑰b Lifetime budget gate — ⚠ the caliber was later re-ruled: the budget is PER
//    DISPATCH (refills at claim), the total is audit, the lifetime ceiling is
//    max × LIFETIME_DISPATCH_CAP. What survives of the earlier patch is only "an
//    explicit continuation road exists / nothing continues forever". The body of
//    the assertions is ⑱b below; the OLD assertions (the +1 top-up, reopen still
//    refused) were removed BECAUSE THE RULE CHANGED — not to keep things green,
//    as ⑱b tightens the same road from the other side.
console.log(String.fromCharCode(10) + "[⑰b continuation is explicit-only: at the lifetime ceiling nothing moves until a human does]");
{
  const L = store.add(db, { subject: "budget card", line: "mail", maxAttempts: 1 });
  for (let i = 0; i < store.LIFETIME_DISPATCH_CAP; i++) {       // burn 1 shot x cap rounds
    store.claimById(db, { id: L, worker: "mail" });
    store.report(db, { id: L, worker: "mail", outcome: "wait", evidence: "e" });
    store.resolve(db, { id: L, verdict: "reject", note: "", resolvedBy: "auto" });
  }
  const r1 = store.claimById(db, { id: L, worker: "mail" });
  ok("⭐ at the lifetime ceiling even a by-name claim is refused with the reason",
     r1.ok === false && /生涯尝试上限/.test(r1.why || ""), r1.why || "(it passed!)");
  store.reopen(db, { id: L });                                   // manual reopen (the total is never erased)
  const r2 = store.claimById(db, { id: L, worker: "mail" });
  ok("reopen alone does not lift the ceiling (stop without erasing the numbers)",
     r2.ok === false && /生涯尝试上限/.test(r2.why || ""), r2.why || "(it passed!)");
  store.update(db, { id: L, maxAttempts: 2 });                   // edit = the explicit continuation road
  const r3 = store.claimById(db, { id: L, worker: "mail" });
  ok("raising the cap via edit = explicit continuation, claim passes", r3.ok !== false, r3.why || "ok");
  const tL = store.get(db, L);
  ok("⭐ an annotated resolve no longer touches the cap (the budget refills at claim; top-ups are obsolete)",
     tL.max_attempts === 2, `max=${tL.max_attempts} (3 would mean the top-up survived)`);
}

// ───────────────────────────────────────────────────────────────
section("⑯c archived children are no longer invisible to goal completion");
{
  // The shortest LEGITIMATE road to done. ⛔ no direct UPDATE — carrying a copy of
  //   the state machine into the probe means measuring the room next door (the
  //   promise at the top of this file).
  const done = (id) => {
    store.claimById(db, { id, worker: "engine" });
    store.report(db, { id, worker: "engine", outcome: "wait", evidence: "e" });
    store.resolve(db, { id, verdict: "approve", note: "", resolvedBy: "human" });
  };
  const st = (id) => store.get(db, id).status;

  // (1) A childless goal must not auto-complete. `every` is VACUOUSLY TRUE on [].
  const g0 = store.add(db, { subject: "empty-subtree goal", kind: "goal" });
  store.completeGoals(db);
  ok("⭐ a childless goal does NOT auto-complete (the vacuous-truth hole is plugged)",
     st(g0) !== "done", `status=${st(g0)}`);

  // (2) All children archived, one of them unfinished -> the goal must not complete.
  const g1 = store.add(db, { subject: "all-children-archived goal", kind: "goal" });
  const k1 = store.add(db, { subject: "unfinished child", parentId: g1, line: "engine" });
  store.archive(db, { id: k1 });
  store.completeGoals(db);
  ok("⭐ children all archived (incl. unfinished) -> goal does NOT auto-complete",
     st(g1) !== "done", `status=${st(g1)}`);

  const g1b = store.add(db, { subject: "mixed goal (1 done + 1 archived-unfinished)", kind: "goal" });
  const kOk = store.add(db, { subject: "finished child", parentId: g1b, line: "engine" });
  const kBad = store.add(db, { subject: "child archived while unfinished", parentId: g1b, line: "engine" });
  done(kOk);
  store.archive(db, { id: kBad });
  store.completeGoals(db);
  ok("⭐ ★ the main case: archiving one unfinished child does NOT complete the goal (archive != done)",
     st(g1b) !== "done", `status=${st(g1b)}`);

  // (3) An auto-completed goal that gains an archived-unfinished child REOPENS.
  const g2 = store.add(db, { subject: "completed goal", kind: "goal" });
  const a = store.add(db, { subject: "child A", parentId: g2, line: "engine" });
  done(a);
  store.completeGoals(db);
  ok("precondition: a goal with all children done auto-completes (without this green, the reopen below is unmeasurable)",
     st(g2) === "done", `status=${st(g2)}`);
  const b = store.add(db, { subject: "child B (unfinished)", parentId: g2, line: "engine" });
  store.archive(db, { id: b });          // add and archive within one sweep: measure the archive road alone
  store.completeGoals(db);
  ok("⭐ archiving an unfinished child still REOPENS the goal (old: it vanished and never reopened)",
     st(g2) === "not_started", `status=${st(g2)}`);
  ok("the reopen record shows 'archived · unfinished' (why it opened is readable from the card alone)",
     /已归档·未完成/.test(String(store.get(db, g2).result || "")),
     String(store.get(db, g2).result || "").slice(-70));

  // (4) Cards the completion definition NAMES but that are outside the subtree get
  //     LISTED in the completion record.
  const g3 = store.add(db, { subject: "caliber-drift goal", kind: "goal",
                             description: "completion definition: blockers of #" + k1 + " cleared" });
  const c = store.add(db, { subject: "child C", parentId: g3, line: "engine" });
  done(c);
  store.completeGoals(db);
  const rec = String(store.get(db, g3).result || "");
  ok("⭐ the completion record lists 'named in the definition but outside the subtree' cards",
     st(g3) === "done" && rec.includes("#" + k1) && /不在本目标子树/.test(rec),
     rec.split(String.fromCharCode(10)).filter((l) => /不在本目标子树|^#/.test(l)).slice(-2).join(" | "));
}

// ── ⑰c chain-depth gate lives in add() — the single point all creation roads share ──
{
  console.log(`\n[⑰c chain-depth gate: judged at store.add(), shared by every creation path]`);

  // Goals are chain roots; hanging a goal under anything is refused.
  const G = store.add(db, { subject: "root goal", kind: "goal" });
  let eGoal = null;
  try { store.add(db, { subject: "child goal", kind: "goal", parentId: G }); }
  catch (e) { eGoal = e; }
  ok("⭐ hanging a goal under a goal is refused", !!eGoal, String(eGoal && eGoal.message));
  ok("the refusal is classified (BAD_INPUT=400, not a bare Error)",
     !!eGoal && eGoal.code === store.ERR.BAD_INPUT && store.httpStatusFor(eGoal).status === 400,
     `code=${eGoal && eGoal.code}`);

  // Up to two layers passes untouched — the gate bites only when DEEP (measuring
  // that it does not over-tighten).
  const L1 = store.add(db, { subject: "layer 1 (execution card)", parentId: G, line: "engine" });
  const L2 = store.add(db, { subject: "layer 2 (necessary follow-up)", parentId: L1, line: "engine" });
  ok("layers 1 and 2 pass as-is (parent and release untouched)",
     store.get(db, L1).parent_id === G && store.get(db, L2).parent_id === L1
     && store.get(db, L2).released === true,      // ⚠ row() maps released to a BOOLEAN
     `L2.parent=${store.get(db, L2).parent_id} released=${store.get(db, L2).released}`);
  ok("chainDepth counts from the root (root=0)",
     store.chainDepth(db, G).depth === 0 && store.chainDepth(db, L2).depth === 2,
     `G=${store.chainDepth(db, G).depth} L2=${store.chainDepth(db, L2).depth}`);

  // A card that would land on layer 3 is uplifted inside add() to directly under
  // the chain-root goal, unreleased.
  const L3 = store.add(db, { subject: "card that would be layer 3", parentId: L2,
                             line: "engine", description: "the body must survive as-is" });
  const r3 = store.get(db, L3);
  ok("⭐ the would-be layer-3 card is uplifted DIRECTLY UNDER the chain-root goal", r3.parent_id === G,
     `parent=${r3.parent_id} (expected ${G})`);
  ok("⭐ the uplifted card is UNRELEASED (the queue is not hijacked)", r3.released === false,
     `released=${r3.released}`);
  ok("the uplift leaves a trace on the card face (why the parent changed is readable)",
     /链深闸上浮卡/.test(String(r3.description)) && /两层为限/.test(String(r3.description))
     && String(r3.description).includes("the body must survive as-is"),
     String(r3.description).slice(0, 60));
  ok("the uplift's result is layer 1 (applying the rule still satisfies the rule)",
     store.chainDepth(db, L3).depth === 1, `depth=${store.chainDepth(db, L3).depth}`);

  // When the chain root is not a goal (a task-rooted chain), fall to rootless =
  // layer 1.
  const T0 = store.add(db, { subject: "task-rooted chain", line: "engine" });
  const T1 = store.add(db, { subject: "T1", parentId: T0, line: "engine" });
  const T2 = store.add(db, { subject: "T2", parentId: T1, line: "engine" });
  const T3 = store.add(db, { subject: "T3 (layer 3)", parentId: T2, line: "engine" });
  ok("with a non-goal root the uplift goes PARENTLESS (not stuffed under a task)",
     store.get(db, T3).parent_id === null && store.get(db, T3).released === false,
     `parent=${store.get(db, T3).parent_id}`);

  // ⭐ Fire the judge directly: it must "answer without writing" (audits and tests
  //   use the same rule).
  const p = store.placeInChain(db, { kind: "task", parentId: L2, released: 1, description: "x" });
  ok("⭐ placeInChain judges without writing (add and audits share one rule)",
     p.parentId === G && p.released === 0 && !!p.uplifted && p.uplifted.wouldBeDepth === 3,
     JSON.stringify(p.uplifted));
  ok("the limit is one constant (MAX_CHAIN_DEPTH)", store.MAX_CHAIN_DEPTH === 2,
     `MAX_CHAIN_DEPTH=${store.MAX_CHAIN_DEPTH}`);
}

// ────────────────────────────────────────────────────────────────
// ⑱b Budget calibers: per-dispatch = max_attempts (refills at claim) / lifetime =
//     attempts (never decreases)
// ⚠ This block sits LAST in its area: the migration test below re-stamps every
//   row's anchor (backfill is a "once, when the column landed" operation), so
//   blocks added after it would step on those anchors.
console.log(String.fromCharCode(10) + "[⑱b budget calibers: a bounce keeps the round budget full / the lifetime total stays]");
{
  const B = store.add(db, { subject: "caliber card", line: "mail", maxAttempts: 2 });
  const t0 = store.get(db, B);
  ok("a new card is lifetime 0 / round 0", t0.attempts === 0 && t0.attempts_this_claim === 0,
     `lifetime=${t0.attempts} round=${t0.attempts_this_claim}`);
  store.claimById(db, { id: B, worker: "mail" });
  const t1 = store.get(db, B);
  ok("the claim counts round one (lifetime 1 / round 1 / anchor 0)",
     t1.attempts === 1 && t1.attempts_this_claim === 1 && t1.attempts_base === 0,
     `lifetime=${t1.attempts} round=${t1.attempts_this_claim} anchor=${t1.attempts_base}`);
  const b2 = store.bumpAttempt(db, { id: B, worker: "mail" });
  ok("self-retry 2 exhausts the round budget (the loop parks here)",
     b2.attempts === 2 && b2.attempts_this_claim === 2 && b2.max_attempts === 2,
     JSON.stringify(b2));
  store.report(db, { id: B, worker: "mail", outcome: "wait", evidence: "e" });
  store.resolve(db, { id: B, verdict: "reject", note: "", resolvedBy: "auto" });
  const t2 = store.get(db, B);
  ok("⭐ a bounce does not erase the lifetime total", t2.attempts === 2, `lifetime=${t2.attempts}`);
  ok("⭐ a bounce does not inflate the cap (the +1 top-up is gone)",
     t2.max_attempts === 2, `max=${t2.max_attempts}`);
  const r = store.claimById(db, { id: B, worker: "mail" });
  ok("a bounced card can be claimed again", r.ok !== false, r.why || "ok");
  const t3 = store.get(db, B);
  ok("⭐ re-claim refills the round budget (1/2; the old code showed 3/2 = park on the spot)",
     t3.attempts_this_claim === 1 && t3.max_attempts === 2,
     `round=${t3.attempts_this_claim}/${t3.max_attempts} lifetime=${t3.attempts}`);
  ok("⭐ the lifetime total keeps walking on top (3)", t3.attempts === 3, `lifetime=${t3.attempts}`);
  ok("anchor = the total at the end of the previous round", t3.attempts_base === 2, `anchor=${t3.attempts_base}`);
}
{
  // Lifetime ceiling (the earlier patch's protective intent, caliber-corrected).
  // max=1, so one round = one shot.
  const C = store.add(db, { subject: "lifetime-ceiling card", line: "mail", maxAttempts: 1 });
  let roundsOk = 0;
  for (let i = 0; i < store.LIFETIME_DISPATCH_CAP; i++) {
    const r = store.claimById(db, { id: C, worker: "mail" });
    if (r.ok !== false) roundsOk++;
    store.report(db, { id: C, worker: "mail", outcome: "wait", evidence: "e" });
    store.resolve(db, { id: C, verdict: "reject", note: "", resolvedBy: "auto" });
  }
  ok(`bounce -> re-claim passes for ${store.LIFETIME_DISPATCH_CAP} rounds (full budget each)`,
     roundsOk === store.LIFETIME_DISPATCH_CAP, `rounds passed=${roundsOk}`);
  const rX = store.claimById(db, { id: C, worker: "mail" });
  ok("⭐ at the lifetime ceiling the claim is refused by name (no infinite dispatching)",
     rX.ok === false && /生涯尝试上限/.test(rX.why || ""), rX.why || "(it passed!)");
  const tC = store.get(db, C);
  ok("the lifetime total stays on the card (audit-readable)",
     tC.attempts === store.LIFETIME_DISPATCH_CAP * tC.max_attempts,
     `lifetime=${tC.attempts} ceiling=${store.LIFETIME_DISPATCH_CAP}x${tC.max_attempts}`);
  store.update(db, { id: C, maxAttempts: 2 });
  const rY = store.claimById(db, { id: C, worker: "mail" });
  ok("raising the cap via edit = the explicit continuation road (human hands required)", rY.ok !== false, rY.why || "ok");
}
{
  // Migration (the instant an existing DB gains the column): forge all-zero anchors
  // and fire the catch-up.
  const D = store.add(db, { subject: "migration card - in flight", line: "mail" });
  const E = store.add(db, { subject: "migration card - not started", line: "mail" });
  store.claimById(db, { id: D, worker: "mail" });
  store.bumpAttempt(db, { id: D, worker: "mail" });          // lifetime 2 / round 2
  db.prepare("UPDATE tasks SET attempts_base=0").run();      // = the shape right after ALTER
  store.backfillAttemptsBase(db);
  const tD = store.get(db, D), tE = store.get(db, E);
  ok("⭐ migration: in-flight cards tip lenient (round=1) — not parked on the migration tick",
     tD.attempts_this_claim === 1, `round=${tD.attempts_this_claim} lifetime=${tD.attempts}`);
  ok("migration: cards outside a dispatch get round=0", tE.attempts_this_claim === 0,
     `round=${tE.attempts_this_claim}`);
  ok("migration does not touch lifetime totals", tD.attempts === 2, `lifetime=${tD.attempts}`);
}

// ────────────────────────────────────────────────────────────────
// ⑲b verdict is the RESULT / last_verdict is this round's ruling. Sealed by invariant.
console.log(String.fromCharCode(10) + "[⑲b verdict = closing result (invariant: non-NULL ⟺ done)]");
{
  const mk = (line) => {                       // carry to waiting via the legitimate road
    const id = store.add(db, { subject: "vcal " + line + Math.random(), line });
    store.claimById(db, { id, worker: line });
    store.report(db, { id, worker: line, outcome: "wait", evidence: "e" });
    return id;
  };
  const a = mk("mail");
  store.resolve(db, { id: a, verdict: "approve", note: "", resolvedBy: "human" });
  const ta = store.get(db, a);
  ok("⭐ unannotated approve = closed, verdict rightly stays",
     ta.status === "done" && ta.verdict === "approve", `status=${ta.status} verdict=${ta.verdict}`);
  ok("closed cards keep the round ruling alongside", ta.last_verdict === "approve");

  const b = mk("mail");
  store.resolve(db, { id: b, verdict: "approve", note: "continue per A", resolvedBy: "human" });
  const tb2 = store.get(db, b);
  ok("⭐ annotated approve = hand-back, cannot be read as 'passed' (verdict=null)",
     tb2.status === "not_started" && tb2.verdict === null, `status=${tb2.status} verdict=${tb2.verdict}`);
  ok("⭐ yet what was pressed is not lost (last_verdict=approve)", tb2.last_verdict === "approve");

  // ⭐ Apply the invariant to the WHOLE BOARD — stronger against leaks than
  //   enumerating today's paths (a path added tomorrow trips this line).
  const bad = db.prepare(
    "SELECT id, status, verdict FROM tasks WHERE verdict IS NOT NULL AND status <> 'done'").all();
  ok("⭐ invariant: every card holding a verdict is done, no exceptions",
     bad.length === 0, bad.map((r) => `#${r.id}:${r.status}=${r.verdict}`).join(" ") || "0 cards");

  // Migration (the instant the column landed). Forge the measured dirty shape and
  // fire.
  db.prepare("UPDATE tasks SET verdict='approve', last_verdict=NULL WHERE id=?").run(b);
  const n = store.backfillVerdictCaliber(db);
  const tb3 = store.get(db, b);
  ok("⭐ migration: in-flight cards' verdict clears", tb3.verdict === null, `verdict=${tb3.verdict}`);
  ok("⭐ migration: copied to last_verdict before clearing (history kept)",
     tb3.last_verdict === "approve", `last_verdict=${tb3.last_verdict}`);
  ok("migration: closed cards untouched", store.get(db, a).verdict === "approve", `n=${n}`);
}

// ────────────────────────────────────────────────────────────────
// ⑱c Ancestor-release invariant: an unreleased ancestor blocks all descendants —
//     one shot at each of the three layers: pick-a-card / by-name / the DB trigger
//     belt behind the application layer.
//     ⚠ Isolation = a section-private route (r18): claim's SQL filters by route.
section("⑱c ancestor-release invariant: unreleased ancestors block all descendants (claim/by-name/trigger)");
{
  const G  = store.add(db, { subject: "gate: unreleased root goal", kind: "goal", released: 0, route: "r18" });
  const C1 = store.add(db, { subject: "gate: child",      parentId: G,  released: 1, route: "r18", line: "z18" });
  const C2 = store.add(db, { subject: "gate: grandchild", parentId: C1, released: 1, route: "r18", line: "z18" });
  ok("helper: unreleasedAncestor points from the grandchild layer to the unreleased root", store.unreleasedAncestor(db, C1) === G);
  const g1 = store.claim(db, "z18", 30, { route: "r18", line: "z18" });
  ok("⭐ pick-a-card issues NOTHING (all descendants blocked by the unreleased root)", g1 == null, g1 ? `mis-issued #${g1.id}` : "");
  const r1 = store.claimById(db, { id: C2, worker: "z18" });
  ok("⭐ by-name claim refused, unreleased ancestor named", r1.ok === false && new RegExp(`#${G} 未放行`).test(r1.why), r1.why);
  let trigMsg = "";
  try { db.prepare("UPDATE tasks SET status='in_progress' WHERE id=?").run(C2); }
  catch (e) { trigMsg = String(e.message || e); }
  ok("⭐ DB trigger belt: direct in_progress writes bypassing the app layer are RAISEd",
     /ancestor-release-gate/.test(trigMsg), trigMsg.slice(0, 60));
  ok("the blocked card burned zero attempts (pre-filter, not claim-then-bounce)",
     store.get(db, C2).attempts === 0 && store.get(db, C2).status === "not_started");
  store.setReleased(db, { id: G, released: true });
  const g2 = store.claim(db, "z18", 30, { route: "r18", line: "z18" });
  ok("after releasing the root it claims (the grandchild; the child is rightly held by the parent gate)", g2 && g2.id === C2, g2 ? `got=#${g2.id}` : "null");
}

// ────────────────────────────────────────────────────────────────
// ⑲c Per-root WIP cap: at WIP_PER_ROOT in-flight cards on one root chain, nobody
//     else gets in. The panel folding candidates is "can't see"; this gate is
//     "can't enter". Roots are independent.
section(`⑲c per-root WIP cap (current WIP_PER_ROOT=${store.WIP_PER_ROOT})`);
{
  const R = store.add(db, { subject: "WIP: root goal", kind: "goal", released: 1, route: "r19" });
  const kids = [];
  for (let i = 0; i < store.WIP_PER_ROOT + 2; i++)
    kids.push(store.add(db, { subject: `WIP: execution card ${i}`, parentId: R, released: 1, route: "r19", line: "z19" }));
  const claimed = [];
  for (let i = 0; i < store.WIP_PER_ROOT + 5; i++) {
    const g = store.claim(db, "z19", 30, { route: "r19", line: "z19" });
    if (!g) break;
    claimed.push(g.id);
  }
  ok(`⭐ pick-a-card admits exactly ${store.WIP_PER_ROOT} then seals (no card ${store.WIP_PER_ROOT + 1})`,
     claimed.length === store.WIP_PER_ROOT, `claimed=${claimed.join(",")}`);
  const rest = kids.find((k) => !claimed.includes(k));
  const rb = store.claimById(db, { id: rest, worker: "z19" });
  ok("⭐ no queue-jumping by name either; the refusal names root and in-flight", rb.ok === false && /WIP 上限/.test(rb.why), rb.why);
  const solo = store.add(db, { subject: "WIP: parentless loner", released: 1, route: "r19", line: "z19" });
  const gs = store.claim(db, "z19", 30, { route: "r19", line: "z19" });
  ok("roots are independent: another root (a loner = its own root) is unaffected", gs && gs.id === solo, gs ? `got=#${gs.id}` : "null");
  store.report(db, { id: claimed[0], worker: "z19", outcome: "done", evidence: "e" });
  const g3 = store.claim(db, "z19", 30, { route: "r19", line: "z19" });
  ok("one in-flight clears -> the seal yields one seat", g3 && kids.includes(g3.id), g3 ? `got=#${g3.id}` : "null");
}

// ────────────────────────────────────────────────────────────────
// ⑳ human-gated pre-filter: cards waiting on a human never enqueue and never burn
//    attempts; a HUMAN ruling auto-opens the gate; auto review does not open it for
//    them.
section("⑳ human-gated: pre-filter burns no attempts + human rulings auto-open");
{
  const H  = store.add(db, { subject: "HG: waiting-on-human card", released: 1, route: "r20", line: "z20" });
  const H2 = store.add(db, { subject: "HG: control card", released: 1, route: "r20", line: "z20" });
  store.update(db, { id: H, humanGate: 1 });
  const g1 = store.claim(db, "z20", 30, { route: "r20", line: "z20" });
  ok("⭐ pick-a-card skips the human-gated one and takes the control (the queue never jams on waiting-for-humans)", g1 && g1.id === H2, g1 ? `got=#${g1.id}` : "null");
  const r1 = store.claimById(db, { id: H, worker: "z20" });
  ok("⭐ by-name refused, stating human-gated", r1.ok === false && /human-gated/.test(r1.why), r1.why);
  ok("the filtered card has attempts=0 (not one burned)", store.get(db, H).attempts === 0);
  // Auto review does not open gates for humans: walk the control to waiting, gate
  // it, auto-rule — the gate stays.
  store.report(db, { id: H2, worker: "z20", outcome: "wait", evidence: "e" });
  store.update(db, { id: H2, humanGate: 1 });
  // ⭐ The gate applies to the REVIEW QUEUE as well. Plugging only claim is not
  //   enough: fix one line on the card face and updated_at moves, and the whole
  //   human-wait pile marches back into re-review — quota burned on cards whose
  //   answer is known to be "wait for the human".
  //   ⚠ Measure the positive control IN THE SAME STATE: measured elsewhere, "not in
  //     the queue" is the status's doing, not the gate's — hollow green (stepped on
  //     in the first version).
  ok("⭐ human-gated is excluded from pendingReview too (no quota burn)",
     store.get(db, H2).status === "waiting" && !store.pendingReview(db).some((x) => x.id === H2));
  store.update(db, { id: H2, humanGate: 0 });
  ok("(positive control) removing the gate returns the same card to the review queue",
     store.pendingReview(db).some((x) => x.id === H2));
  store.update(db, { id: H2, humanGate: 1 });
  store.resolve(db, { id: H2, verdict: "reject", note: "", resolvedBy: "auto" });
  ok("an auto ruling does not open the gate (human_gate stays)", store.get(db, H2).human_gate === true);
  // A human ruling auto-opens: run another round, ruled by a human
  const rH2 = store.claimById(db, { id: H2, worker: "z20" });
  ok("(mid-course control) gate on, by-name still refused", rH2.ok === false && /human-gated/.test(rH2.why));
  store.update(db, { id: H2, humanGate: 0 });
  store.claimById(db, { id: H2, worker: "z20" });
  store.report(db, { id: H2, worker: "z20", outcome: "wait", evidence: "e2" });
  store.update(db, { id: H2, humanGate: 1 });
  store.resolve(db, { id: H2, verdict: "reject", note: "continue per option A", resolvedBy: "human" });
  ok("⭐ a human ruling auto-opens the gate (no dead-wait for an already-given decision)",
     store.get(db, H2).human_gate === false);
  const r2 = store.claimById(db, { id: H2, worker: "z20" });
  ok("gate open -> by-name passes", r2.ok !== false, JSON.stringify(r2.ok));
}

// ────────────────────────────────────────────────────────────────
// ㉑ Actual-runtime stamp: self-reported at claim -> last_runtime; not passed = not
//    stamped (old behavior); ⛔ zero participation in claim criteria (display only).
section("㉑ last_runtime stamp: self-report at claim / no report = no change / by-name same shape");
{
  const A = store.add(db, { subject: "stamp: pick-a-card", released: 1, route: "r21", line: "z21" });
  const B = store.add(db, { subject: "stamp: by-name", released: 1, route: "r21", line: "z21" });
  const g = store.claim(db, "z21", 30, { route: "r21", line: "z21", runtime: "codex" });
  ok("⭐ pick-a-card stamps (codex)", g && g.id === A && g.last_runtime === "codex", JSON.stringify(g && g.last_runtime));
  const r = store.claimById(db, { id: B, worker: "z21", runtime: "claude" });
  ok("⭐ by-name stamps (claude)", r.ok !== false && r.task.last_runtime === "claude");
  store.report(db, { id: B, worker: "z21", outcome: "wait", evidence: "e" });
  store.resolve(db, { id: B, verdict: "reject", note: "", resolvedBy: "auto" });
  store.claimById(db, { id: B, worker: "z21" });   // no runtime passed
  ok("no report = no change (COALESCE keeps the old value; re-claim does not erase the last runner)",
     store.get(db, B).last_runtime === "claude");
  const C = store.add(db, { subject: "stamp: never claimed", released: 1, route: "r21x", line: "z21" });
  ok("never claimed = NULL (the panel falls back to the route family)", store.get(db, C).last_runtime === null);
}

// ────────────────────────────────────────────────────────────────
// ㉒ Linked closure (ruling: "one path through, no extra ceremony")
//   ⭐ The trigger is MACHINE GREEN (verify_ok=1). approve never triggers — measured,
//     approve's real meaning is "nobody objected"; closing someone else's card on
//     that is the weakest possible grounds.
//   ⭐ The NEGATIVE assertions are the body: assert "does not close" more often than
//     "closes".
console.log(String.fromCharCode(10) + "[㉒ linked closure: machine green links / no evidence, nobody else's card moves]");
{
  // Carry one card to waiting (rulings fire only from waiting)
  const toWaiting = (id, w = "engine") => {
    store.claimById(db, { id, worker: w });
    store.report(db, { id, worker: w, outcome: "done", evidence: "e" });
  };

  // ── The alternatives group: same parent, same key ─────────────────────────────
  const P = store.add(db, { subject: "parent: does this hypothesis hold", line: "engine" });
  const A = store.add(db, { subject: "path A", line: "engine", parentId: P,
                            oneofKey: "hyp-1", verifyCmd: "selftest" });
  const B = store.add(db, { subject: "path B", line: "engine", parentId: P, oneofKey: "hyp-1" });
  toWaiting(A);
  const rA = store.resolve(db, { id: A, verdict: "approve", note: "", resolvedBy: "auto",
                                 verifyOk: true });
  const tB = store.get(db, B);
  ok("⭐ same group: one passes (with machine green) -> the other closes automatically",
     tB.status === "done" && tB.resolved_by === "cascade", `${tB.status}/${tB.resolved_by}`);
  ok("the closing reason names the proving card (traceable)", /#\s*?/.test(String(tB.verdict_note)) &&
     String(tB.verdict_note).includes("#" + A), String(tB.verdict_note).slice(-80));
  ok("the linkage result returns to the caller (the loop can log it)",
     rA.cascade && rA.cascade.closed.includes(B), JSON.stringify(rA.cascade || null));

  // ── ⭐ Negative ①: no machine green -> NO closing (approve alone is not enough) ──
  const P2 = store.add(db, { subject: "parent 2", line: "engine" });
  const A2 = store.add(db, { subject: "path A2", line: "engine", parentId: P2, oneofKey: "hyp-2" });
  const B2 = store.add(db, { subject: "path B2", line: "engine", parentId: P2, oneofKey: "hyp-2" });
  toWaiting(A2);
  const rA2 = store.resolve(db, { id: A2, verdict: "approve", note: "", resolvedBy: "auto" });
  ok("⭐⭐ an approve with no machine evidence does NOT link (approve != acceptance)",
     store.get(db, B2).status === "not_started" && !rA2.cascade,
     `${store.get(db, B2).status} cascade=${JSON.stringify(rA2.cascade || null)}`);

  // ── ⭐ Negative ②: a red verify does not close ────────────────────────────────
  const P3 = store.add(db, { subject: "parent 3", line: "engine" });
  const A3 = store.add(db, { subject: "path A3", line: "engine", parentId: P3, oneofKey: "hyp-3" });
  const B3 = store.add(db, { subject: "path B3", line: "engine", parentId: P3, oneofKey: "hyp-3" });
  toWaiting(A3);
  store.resolve(db, { id: A3, verdict: "approve", note: "", resolvedBy: "auto", verifyOk: false });
  ok("⭐ no linkage on a red verification (verify_ok=false)", store.get(db, B3).status === "not_started");

  // ── ⭐ Negative ③: a bounce never links ──────────────────────────────────────
  const P4 = store.add(db, { subject: "parent 4", line: "engine" });
  const A4 = store.add(db, { subject: "path A4", line: "engine", parentId: P4, oneofKey: "hyp-4" });
  const B4 = store.add(db, { subject: "path B4", line: "engine", parentId: P4, oneofKey: "hyp-4" });
  toWaiting(A4);
  store.resolve(db, { id: A4, verdict: "reject", note: "", resolvedBy: "auto", verifyOk: true });
  ok("⭐ a reject does not link (a reject can carry a green verify too)", store.get(db, B4).status === "not_started");

  // ── ⭐ Negative ④: an annotated approve (= hand-back, not closed) does not link ─
  const P5 = store.add(db, { subject: "parent 5", line: "engine" });
  const A5 = store.add(db, { subject: "path A5", line: "engine", parentId: P5, oneofKey: "hyp-5" });
  const B5 = store.add(db, { subject: "path B5", line: "engine", parentId: P5, oneofKey: "hyp-5" });
  toWaiting(A5);
  store.resolve(db, { id: A5, verdict: "approve", note: "look at X again", resolvedBy: "human",
                      verifyOk: true });
  ok("⭐ an annotated approve (hand-back, unclosed) does not link", store.get(db, B5).status === "not_started");

  // ── ⭐ Negative ⑤: the same key under a different parent is a DIFFERENT group ──
  const P6 = store.add(db, { subject: "parent 6", line: "engine" });
  const P7 = store.add(db, { subject: "parent 7", line: "engine" });
  const A6 = store.add(db, { subject: "path A6", line: "engine", parentId: P6, oneofKey: "same" });
  const X7 = store.add(db, { subject: "someone else's X7", line: "engine", parentId: P7, oneofKey: "same" });
  toWaiting(A6);
  store.resolve(db, { id: A6, verdict: "approve", note: "", resolvedBy: "auto", verifyOk: true });
  ok("⭐ same oneof key, different parent -> no cross-closing (group scope = one parent)",
     store.get(db, X7).status === "not_started");

  // ── ⭐ Negative ⑥: a RUNNING sibling is not closed (mark only) ────────────────
  const P8 = store.add(db, { subject: "parent 8", line: "engine" });
  const A8 = store.add(db, { subject: "path A8", line: "engine", parentId: P8, oneofKey: "hyp-8" });
  const B8 = store.add(db, { subject: "path B8", line: "engine", parentId: P8, oneofKey: "hyp-8" });
  store.claimById(db, { id: B8, worker: "engine@2" });      // B8 is running
  toWaiting(A8);
  const r8 = store.resolve(db, { id: A8, verdict: "approve", note: "", resolvedBy: "auto",
                                 verifyOk: true });
  const t8 = store.get(db, B8);
  ok("⭐⭐ a running sibling's state is untouched (never silently discard its output)",
     t8.status === "in_progress" && t8.worker === "engine@2", `${t8.status}/${t8.worker}`);
  ok("but the MARK lands even while running (readable later - loud)",
     String(t8.verdict_note).includes("联动提示") && r8.cascade.deferred.includes(B8),
     JSON.stringify(r8.cascade));

  // ── Parent linkage: proves_parent ─────────────────────────────────────────────
  const Q = store.add(db, { subject: "parent: should this caliber change", line: "engine" });
  const C = store.add(db, { subject: "verification child", line: "engine", parentId: Q, provesParent: true,
                            verifyCmd: "selftest" });
  toWaiting(C);
  const rC = store.resolve(db, { id: C, verdict: "approve", note: "", resolvedBy: "auto",
                                 verifyOk: true });
  const tQ = store.get(db, Q);
  ok("⭐ a proves_parent child passing closes THE PARENT too (linked pass)",
     tQ.status === "done" && tQ.resolved_by === "cascade", `${tQ.status}/${tQ.resolved_by}`);
  ok("the parent's closing reason carries the child's number (who proved it)", String(tQ.verdict_note).includes("#" + C));
  ok("the linkage result carries parent", rC.cascade && rC.cascade.parent === Q, JSON.stringify(rC.cascade));

  // ── ⭐ Negative ⑦: an undeclared child does not close its parent ──────────────
  const Q2 = store.add(db, { subject: "parent 2b: a different question", line: "engine" });
  const D = store.add(db, { subject: "ordinary child", line: "engine", parentId: Q2 });
  toWaiting(D);
  store.resolve(db, { id: D, verdict: "approve", note: "", resolvedBy: "auto", verifyOk: true });
  ok("⭐⭐ an undeclared child does not close the parent (OR-ness exists only by declaration)",
     store.get(db, Q2).status !== "done", store.get(db, Q2).status);

  // ── ⭐ Negative ⑧: linkage is ONE step (no ripple to the grandparent) ─────────
  const G0 = store.add(db, { subject: "grandparent", line: "engine" });
  const P9 = store.add(db, { subject: "parent 9", line: "engine", parentId: G0, provesParent: true });
  const C9 = store.add(db, { subject: "child 9", line: "engine", parentId: P9, provesParent: true,
                             verifyCmd: "selftest" });
  toWaiting(C9);
  store.resolve(db, { id: C9, verdict: "approve", note: "", resolvedBy: "auto", verifyOk: true });
  ok("⭐ the parent closes (one step)", store.get(db, P9).status === "done");
  ok("⭐⭐ the grandparent does NOT close (never build a chain with no way to stop the ripple)",
     store.get(db, G0).status !== "done", store.get(db, G0).status);

  // ── The precondition on record: verify_ok/verify_at stay on the card ──────────
  const tA = store.get(db, A);
  ok("the machine result at ruling time stays on the card (auditable later)",
     Number(tA.verify_ok) === 1 && !!tA.verify_at, `verify_ok=${tA.verify_ok} at=${tA.verify_at}`);
  // Declarations can be attached later (noticing after decomposition is normal)
  const L1 = store.add(db, { subject: "late declaration", line: "engine" });
  store.update(db, { id: L1, oneofKey: "later", provesParent: true });
  const tL = store.get(db, L1);
  ok("declarations can be attached via edit", tL.oneof_key === "later" && Number(tL.proves_parent) === 1);
  store.update(db, { id: L1, oneofKey: "" });
  ok("empty string revokes the declaration (prevents '' grouping everything together)",
     store.get(db, L1).oneof_key === null, String(store.get(db, L1).oneof_key));
}

// ══════════════════════════════════════════════════════════════════
// §T1 The DESTINATION of a ruling is DECLARED by the caller (disposition ruling)
//   Pathology: the destination was inferred from "did the human write a note". The
//   day the server began synthesizing A/B/C ruling texts itself, that proxy broke —
//   synthesized notes are always non-empty, so cards that went through options
//   could STRUCTURALLY never close (measured: one ping-ponged to attempt 10).
// ══════════════════════════════════════════════════════════════════
{
  const NLt = String.fromCharCode(10);
  console.log(NLt + "[§T1 disposition — the caller names the destination]");
  // The skeleton of the success text the server actually synthesizes (whose
  // non-emptiness is exactly what broke the old criterion)
  const N = "采用方案 A:供应商 fail-closed。文件已由用户应用成功;请按该方案继续并根据下面的回执完成验证。"
          + NLt + NLt + "—— 执行回执(成功 · 用户填写)——" + NLt + "Success. No rows returned";

  // ⭐ Precondition assertion — without it, "stayed in waiting" is indistinguishable
  //   from "nothing happened at all".
  ok("T1a precondition: under the legacy criterion this ruling is a hand-back (hence could never close)",
     store.legacyDisposition({ verdict: "approve", note: N, resolvedBy: "human" }) === "hand_back",
     store.legacyDisposition({ verdict: "approve", note: N, resolvedBy: "human" }));

  // ⚠ claim() is pick-a-card (smallest satisfying id) — no guarantee OUR card comes.
  //   Claim by name, or a stranger's card gets grabbed and report CONFLICTs.
  const mkWaiting = (subject) => {
    const id = store.add(db, { subject, line: "engine" });
    const r = store.claimById(db, { id, worker: "engine", leaseMin: 30 });
    if (!r || r.ok === false) throw new Error("T1 fixture: cannot claim #" + id + " — " + JSON.stringify(r));
    store.report(db, { id, worker: "engine", outcome: "done", evidence: "e" });
    return id;
  };
  const A = mkWaiting("T1 card to be held");
  const before = store.get(db, A);
  store.resolve(db, { id: A, verdict: "approve", note: N, resolvedBy: "human",
                      disposition: "hold_for_review" });
  const a1 = store.get(db, A);
  ok("T1 ⭐ hold_for_review stays in waiting/review — neither closes nor hands back",
     a1.status === "waiting" && a1.waiting_for === "review" && a1.auto_review_at === null &&
     a1.verdict === null && a1.last_verdict === "approve",
     a1.status + "/" + a1.waiting_for + " auto_review_at=" + a1.auto_review_at + " verdict=" + a1.verdict);
  ok("T1 ⭐ attempts do not move by even 1 (corollary of not returning to not_started)",
     a1.attempts === before.attempts && a1.attempts_base === before.attempts_base,
     before.attempts + "/" + before.attempts_base + " -> " + a1.attempts + "/" + a1.attempts_base);

  // ── T1b unknown values refused + NO half-application ─────────────────────────
  const B = mkWaiting("T1b unknown-disposition card");
  const snap = store.get(db, B);
  let code = null;
  try { store.resolve(db, { id: B, verdict: "approve", note: "x", resolvedBy: "human",
                            disposition: "whatever" }); }
  catch (e) { code = e.code; }
  const b1 = store.get(db, B);
  ok("T1b ⭐ an unknown disposition is rejected as BAD_INPUT (unknown falls to the refusal side)",
     code === store.ERR.BAD_INPUT, String(code));
  ok("T1b ⭐ after the rejection the card is VERBATIM unchanged (no half-application)",
     b1.status === snap.status && b1.waiting_for === snap.waiting_for &&
     b1.last_verdict === snap.last_verdict && b1.updated_at === snap.updated_at,
     b1.status + "/" + b1.waiting_for + "/" + b1.last_verdict);
  store.resolve(db, { id: B, verdict: "approve", note: "x", resolvedBy: "human",
                      disposition: "hand_back" });
  ok("T1b (positive control) the legal value hand_back passes — this gate is not 'refuse everything'",
     store.get(db, B).status === "not_started", store.get(db, B).status);

  // ── T1c equivalence control: the difference comes from disposition, not note ──
  const C1 = mkWaiting("T1c declaring side"), C2 = mkWaiting("T1c non-declaring side");
  store.resolve(db, { id: C1, verdict: "approve", note: N, resolvedBy: "human",
                      disposition: "hold_for_review" });
  store.resolve(db, { id: C2, verdict: "approve", note: N, resolvedBy: "human" });
  const c1 = store.get(db, C1), c2 = store.get(db, C2);
  ok("T1c ⭐ the SAME note splits destinations (the difference's only source is disposition)",
     c1.status === "waiting" && c2.status === "not_started",
     "declared=" + c1.status + " / undeclared=" + c2.status);
  ok("T1c both carry the note verbatim in the record (neither side was empty)",
     String(c1.verdict_note).includes(N) && String(c2.verdict_note).includes(N));
  // ⭐ If the criterion surfaces only in `next`, the record prints a LIE.
  ok("T1c ⭐ the hold record says 'staying in waiting for review' and NOT 'continuing on original line'",
     String(c1.verdict_note).includes("留在等待中交审阅") &&
     !String(c1.verdict_note).includes("回原线继续"),
     String(c1.verdict_note).slice(-90));
  ok("T1c (control) the undeclared side says 'continuing on original line'",
     String(c2.verdict_note).includes("回原线继续"));

  // ── T2 the receipt column: measured proof the 4 existing carriers die within one
  //     cycle + the new column survives ──
  const D = mkWaiting("T2 receipt card");
  const RCPT = { option: "A", outcome: "success", receipt: "Success. No rows returned",
                 said: "", files: [{ name: "0119_x.sql", sha256: "a".repeat(64), status: "copied" }],
                 at: "2026-08-25T09:00:00.000Z", consumed_at: null };
  store.resolve(db, { id: D, verdict: "approve", note: N, resolvedBy: "human",
                      disposition: "hold_for_review", sqlReceipt: RCPT,
                      selectedOption: "A", sqlArchive: RCPT.files });
  const d1 = store.get(db, D);
  ok("T2 the receipt lands in the new column and confirm_pending raises",
     d1.decision_receipt?.receipt === RCPT.receipt && d1.confirm_pending === true,
     "receipt=" + JSON.stringify(d1.decision_receipt?.receipt) + " pending=" + d1.confirm_pending);
  ok("T2 the files' 3 keys are archiveOptionFiles' real shape (name/sha256/status)",
     d1.decision_receipt?.files?.[0]?.name === "0119_x.sql" &&
     !!d1.decision_receipt?.files?.[0]?.sha256 && !!d1.decision_receipt?.files?.[0]?.status,
     JSON.stringify(d1.decision_receipt?.files?.[0]));
  // ⭐ Precondition: measure that the existing carriers really do get erased (if
  //   they did not, the new column would be unnecessary)
  store.markAutoReviewed(db, { id: D, note: "review observations", decisionPackage: { options: [] } });
  const d2 = store.get(db, D);
  ok("T2 ⭐ precondition: markAutoReviewed ERASES decision_choice / decision_sql_archive",
     d2.decision_choice === null && d2.decision_sql_archive === null,
     "choice=" + d2.decision_choice + " archive=" + JSON.stringify(d2.decision_sql_archive));
  ok("T2 ⭐ effect: the receipt itself SURVIVES (a production execution cannot be unhappened)",
     d2.decision_receipt?.receipt === RCPT.receipt, JSON.stringify(d2.decision_receipt?.receipt));
  ok("T2 ⭐ but 'unconsumed' comes down (the package was replaced; confirmations of the old package are not next-round input)",
     d2.confirm_pending === false && !!d2.decision_receipt?.consumed_at,
     "pending=" + d2.confirm_pending + " consumed_at=" + d2.decision_receipt?.consumed_at);

  // ── T2c history cards are all NULL (no backfill => the new gate never fires by
  //     default) ──
  // ⚠ list() returns { tasks, archived_count }, not an array (checked against the
  //   real thing before writing).
  const hist = store.list(db, { archived: "all" }).tasks.filter((t) => t.id < D);
  ok("T2c ⭐ every existing card has confirm_pending=false (no backfill = the status quo untouched)",
     hist.length > 0 && hist.every((t) => t.confirm_pending === false),
     hist.length + " cards, pending=true on " + hist.filter((t) => t.confirm_pending).length);

  // ── T3d the destination predicate. EVERY uncertain branch = hand_back (= today's
  //     behavior = the non-closing side) ──
  //   Ruling: human_gate=1 cards are not held — holding keeps the gate and
  //   pendingReview (human_gate=0) never sees them = silent stall; dropping the
  //   gate to pass them is a silent demotion of a governance mark. Neither is taken.
  const G = mkWaiting("T3d human-only card");
  store.update(db, { id: G, humanGate: 1 });
  ok("T3d ⭐ human_gate=1 cards are not held (never silently demote a governance mark)",
     store.confirmDestination(db, store.get(db, G)) === "hand_back",
     store.confirmDestination(db, store.get(db, G)));

  const P = mkWaiting("T3d parent card");
  const K = store.add(db, { subject: "T3d unfinished child", line: "engine", parentId: P });
  ok("T3d ⭐ a parent with unfinished children is not held either (pendingReview does not look at children => exclude here)",
     store.confirmDestination(db, store.get(db, P)) === "hand_back",
     "child #" + K + " status=" + store.get(db, K).status);

  const Q = mkWaiting("T3d clean card");
  ok("T3d (positive control) a clean card IS held — this is not a constant hand_back function",
     store.confirmDestination(db, store.get(db, Q)) === "hold_for_review",
     store.confirmDestination(db, store.get(db, Q)));

}

// ───────────────────────────────────────────────────────────────
section("㉖ depsSatisfied — broken dependencies fall on the refusal side (fail-closed)");
{
  // ⚠ Broken blocked_by cannot be produced through add() (normalizeDeps rejects it —
  //   which is itself the write-path spec). The fault models POST-INGESTION
  //   corruption — written directly to the DB. That is fault injection, not a copy
  //   of the subject.
  const mk = (subject) => store.add(db, { subject, line: "engine", route: "main" });
  const corrupt = (id, val) =>
    db.prepare("UPDATE tasks SET blocked_by=? WHERE id=?").run(val, id);
  // ⚠ depsSatisfied's contract is the RAW DB ROW (blocked_by = JSON string). Feeding
  //   it store.get()'s cooked row (row() already parsed the array) stringifies the
  //   array -> JSON.parse fails -> EVERYTHING broken. The first version of this test
  //   did exactly that: the two healthy paths failed and exposed it (the three
  //   corrupt ones passed by luck — "cooked is also broken" — proving nothing).
  //   The real callers (claim/claimById) pass raw rows; raw() measures that contract.
  const raw = (id) => db.prepare("SELECT * FROM tasks WHERE id=?").get(id);

  const base = mk("㉖ dep target (unfinished)");
  const okEmpty = mk("㉖ empty deps");
  ok("㉖ empty array -> ok=true / broken=false",
     (() => { const r = store.depsSatisfied(db, raw(okEmpty)); return r.ok && !r.broken; })());

  const pend = store.add(db, { subject: "㉖ holder of an unfinished dep", line: "engine", blockedBy: [base] });
  {
    const r = store.depsSatisfied(db, raw(pend));
    ok("㉖ unfinished dep -> ok=false / pending names it", !r.ok && !r.broken && r.pending.includes(base),
       `pending=${JSON.stringify(r.pending)}`);
  }

  // ⭐ The polarity itself: one corrupt byte. The old code's catch{} made deps=[] ->
  //   "zero dependencies" = the CLAIMABLE side.
  for (const [name, val] of [["non-JSON", "{oops"], ["legal JSON non-array", "{}"], ["non-integer element", "[1.5]"]]) {
    const c = mk(`㉖ corrupt ${name}`);
    corrupt(c, val);
    const r = store.depsSatisfied(db, raw(c));
    ok(`㉖ ${name} -> broken=true / ok=false (never silently zero-dep)`, r.broken && !r.ok);
  }

  // ⭐ Mutation control (claim path, end to end): a corrupt card and a healthy card
  //   side by side; claim must grab ONLY the healthy one. If a mutation reverts
  //   fail-closed to fail-open, the lower-id corrupt card gets grabbed first and
  //   this assertion falls = the mutation is detected. Clear the field first (no
  //   stray cards).
  db.prepare("UPDATE tasks SET released=0 WHERE status='not_started'").run();
  const broken1 = mk("㉖ corrupt (claim target)");
  corrupt(broken1, "{oops");
  const clean1 = mk("㉖ healthy (claim target)");
  db.prepare("UPDATE tasks SET released=1 WHERE id IN (?,?)").run(broken1, clean1);
  const got = store.claim(db, "engine", 30, { line: "engine", route: "main" });
  ok("㉖ ⭐ claim skips the corrupt card and grabs the healthy one (mutation control: fail-open reversion falls here)",
     got && got.id === clean1, `got=${got ? got.id : "null"} (corrupt=#${broken1} healthy=#${clean1})`);

  {
    const r = store.claimById(db, { id: broken1, worker: "engine", leaseMin: 30 });
    ok("㉖ claimById(corrupt) -> refused, reason mentions parsing", !r.ok && /解析/.test(String(r.why)),
       String(r.why).slice(0, 60));
  }

  // The third site (load-bearing): row() keeps the value [] while ALSO saying broken
  {
    const t = store.get(db, broken1);
    ok("㉖ row(): blocked_by=[] while blocked_by_broken=true (no stop that cannot state its reason)",
       Array.isArray(t.blocked_by) && t.blocked_by.length === 0 && t.blocked_by_broken === true);
    const h = store.get(db, clean1);
    ok("㉖ (negative control) the healthy card has blocked_by_broken=false", h.blocked_by_broken === false);
  }

  // dependentsOf: corrupt rows are returned in broken (never silently skipped)
  {
    const r = store.dependentsOf(db, base);
    ok("㉖ dependentsOf lists dependents AND declares corrupt rows in broken",
       r.list.some((x) => x.id === pend) && r.broken.includes(broken1),
       `list=${r.list.map((x) => x.id)} broken=${r.broken}`);
  }
}

// ───────────────────────────────────────────────────────────────
section("㉗ normalizeDeps — write-path validation (no half-writes, cycles, no false refusal of legal graphs)");
{
  const mk = (subject) => store.add(db, { subject, line: "engine", route: "main" });
  const deps = (id) => JSON.parse(db.prepare("SELECT blocked_by FROM tasks WHERE id=?").get(id).blocked_by);
  const throws = (fn, re) => { try { fn(); return false; } catch (e) { return re ? re.test(String(e.message)) : true; } };

  const a = mk("㉗ A"), b = mk("㉗ B"), c = mk("㉗ C");

  const n1 = store.add(db, { subject: "㉗ unordered duplicates", line: "engine", blockedBy: [c, a, c, b] });
  ok("㉗ add: [C,A,C,B] stored ascending, deduplicated",
     JSON.stringify(deps(n1)) === JSON.stringify([a, b, c].sort((x, y) => x - y)), JSON.stringify(deps(n1)));
  store.update(db, { id: n1, blockedBy: [b, b, a] });
  ok("㉗ update normalizes identically (both entrances are one function)", JSON.stringify(deps(n1)) === JSON.stringify([a, b].sort((x, y) => x - y)));

  ok("㉗ non-array -> throw", throws(() => store.normalizeDeps(db, null, "x")));
  ok("㉗ non-positive integer -> throw", throws(() => store.normalizeDeps(db, null, [0])));
  ok("㉗ nonexistent id -> throw (no silent forever-block)", throws(() => store.normalizeDeps(db, null, [999999]), /不存在/));
  ok("㉗ self-dependency -> throw", throws(() => store.normalizeDeps(db, a, [a]), /自己/));
  {
    const z = mk("㉗ to-be-archived");
    store.archive(db, { id: z });
    ok("㉗ depending on an archived card -> throw", throws(() => store.normalizeDeps(db, null, [z]), /归档/));
  }

  store.update(db, { id: a, blockedBy: [b] });
  ok("㉗ ⭐ cycle B->A -> throw (A->B exists)", throws(() => store.update(db, { id: b, blockedBy: [a] }), /循环/));

  // ⭐ No half-writes: a failed update writes NOTHING else either (the whole
  //   statement falls).
  {
    const before = store.get(db, b).subject;
    throws(() => store.update(db, { id: b, subject: "㉗ must not be renamed", blockedBy: [a] }));
    ok("㉗ ⭐ the failed update did not write subject either (no half-write)", store.get(db, b).subject === before,
       store.get(db, b).subject);
  }

  // ⭐ No false refusal of legal shapes ("copy the parent's 32 hops" mutation
  //   control): a diamond and a 40-node chain.
  {
    const d = mk("㉗ diamond top");
    store.update(db, { id: a, blockedBy: [] });
    store.update(db, { id: b, blockedBy: [a] });
    store.update(db, { id: c, blockedBy: [a] });
    ok("㉗ a diamond (reconvergence) is not a cycle -> passes", !throws(() => store.update(db, { id: d, blockedBy: [b, c] })));
  }
  {
    let prev = mk("㉗ chain 0");
    let okAll = true;
    for (let i = 1; i <= 40; i++) {
      const cur = mk(`㉗ chain ${i}`);
      try { store.update(db, { id: cur, blockedBy: [prev] }); } catch { okAll = false; break; }
      prev = cur;
    }
    ok("㉗ ⭐ a 40-node chain passes (a cut-at-32 mutation falls here)", okAll);
  }

  // A broken edge mid-cycle-check -> "cannot prove" = the refusal side ("could not
  // finish checking" != "safe")
  {
    const p2 = mk("㉗ corrupt relay"), q2 = mk("㉗ tail");
    store.update(db, { id: q2, blockedBy: [p2] });
    db.prepare("UPDATE tasks SET blocked_by=? WHERE id=?").run("{oops", p2);
    ok("㉗ corruption on the path -> throw (when innocence cannot be proven, refuse)",
       throws(() => store.update(db, { id: mk("㉗ newcomer"), blockedBy: [q2] }), /解析|循环/));
  }
}


// ────────────────────────────────────────────────────────────────
// ㉘ Immutable task_events — every transition appends exactly one entry, and the
//   history never reroutes itself when a card is later moved or re-hung.
// ────────────────────────────────────────────────────────────────
section("㉘ immutable task_events");
{
  // ⚠ The parents are created BEFORE the card and the card is born under p1: hanging
  //   it afterwards would itself append a set_parent, and the sequence assertion below
  //   would be asserting the fixture rather than the mechanism.
  const p1 = store.add(db, { subject: "㉘ 旧父", line: "mail", humanGate: false });
  const p2 = store.add(db, { subject: "㉘ 新父", line: "mail", humanGate: false });
  const total0 = store.events(db).length;
  const id = store.add(db, { subject: "㉘ 正史试验", line: "design", parentId: p1, humanGate: false });
  ok("㉘ add appends exactly one add event",
     store.events(db).length === total0 + 1 &&
     store.events(db, { taskId: id }).filter((e) => e.kind === "add").length === 1);

  /** One transition -> exactly one event of the expected kind. Counting the TOTAL as
   *  well as the per-kind count catches "wrote two" and "wrote none but something
   *  else moved" separately. */
  const one = (label, kind, fn) => {
    const before = store.events(db, { taskId: id });
    const n = before.filter((e) => e.kind === kind).length;
    fn();
    const after = store.events(db, { taskId: id });
    ok(`㉘ ${label} appends exactly one ${kind} event`,
       after.length === before.length + 1 && after.filter((e) => e.kind === kind).length === n + 1,
       `${before.length}→${after.length}`);
  };

  one("claim", "claim", () => store.claimById(db, { id, worker: "design" }));
  one("report", "report", () => store.report(db, { id, worker: "design", outcome: "done", evidence: "e" }));
  one("bounce", "resolve", () => store.resolve(db, { id, verdict: "reject", note: "", resolvedBy: "human" }));
  one("re-claim", "claim", () => store.claimById(db, { id, worker: "design" }));
  one("report again", "report", () => store.report(db, { id, worker: "design", outcome: "done", evidence: "e2" }));
  one("close", "resolve", () => store.resolve(db, { id, verdict: "approve", note: "", resolvedBy: "human" }));
  one("reopen", "reopen", () => store.reopen(db, { id }));

  // The two edits that MOVE the card in the graph, and the point of the whole table:
  // the events already written must keep pointing where they pointed.
  const oldEvents = store.events(db, { taskId: id });
  one("line move", "set_line", () => store.update(db, { id, line: "mail", actor: "reorg" }));
  const moved = store.events(db, { taskId: id });
  ok("㉘ ⭐events from before the move still say design; only the new one says mail",
     oldEvents.every((e) => e.detail.line === "design") &&
     moved.at(-1).kind === "set_line" && moved.at(-1).detail.from === "design" &&
     moved.at(-1).detail.line === "mail");
  ok("㉘ the move rewrote no existing event (byte-for-byte)",
     JSON.stringify(moved.slice(0, -1)) === JSON.stringify(oldEvents));

  const oldParentEvents = store.events(db, { taskId: id }).filter((e) => e.detail.parent_id === p1);
  one("re-hang", "set_parent", () => store.update(db, { id, parentId: p2, actor: "reorg" }));
  const reparented = store.events(db, { taskId: id });
  ok("㉘ ⭐events from before the re-hang still point at the old parent",
     oldParentEvents.length > 0 && oldParentEvents.every((e) => e.detail.parent_id === p1) &&
     reparented.at(-1).detail.from === p1 && reparented.at(-1).detail.parent_id === p2);

  // A lease that expired is a transition nobody initiated — it still belongs in the record.
  one("claim a third time", "claim", () => store.claimById(db, { id, worker: "mail" }));
  db.prepare("UPDATE tasks SET lease_until=? WHERE id=?").run(Date.now() - 1000, id);
  one("lease reap", "reap", () => store.reapExpired(db));
  one("hold", "release", () => store.setReleased(db, { id, released: 0, actor: "human" }));

  const kinds = store.events(db, { taskId: id }).map((e) => e.kind);
  ok("㉘ ⭐the whole bounce → re-claim → move → re-hang → reap run is in order",
     JSON.stringify(kinds) === JSON.stringify([
       "add", "claim", "report", "resolve", "claim", "report", "resolve", "reopen",
       "set_line", "set_parent", "claim", "reap", "release",
     ]), kinds.join("→"));

  // Append-only is a property of the SOURCE, not of today's behaviour: one INSERT and
  // no UPDATE/DELETE anywhere. A future "just fix that one row" has to trip this.
  const src = readFileSync(join(__dirname, "..", "core", "store.js"), "utf8");
  ok("㉘ ⭐the only write path is a single INSERT — no UPDATE, no DELETE",
     (src.match(/INSERT INTO task_events/g) || []).length === 1 &&
     !/UPDATE\s+task_events|DELETE\s+FROM\s+task_events/i.test(src));

  // ⭐ The transaction is the whole point of the shell/inner split: if the event cannot
  //   be written, the state change must not survive either. Forced with a trigger,
  //   because no ordinary input makes the INSERT fail.
  db.exec("CREATE TRIGGER t97_fail_event BEFORE INSERT ON task_events BEGIN SELECT RAISE(ABORT,'t97'); END");
  let failed = false;
  try { store.update(db, { id, line: "engine" }); } catch { failed = true; }
  db.exec("DROP TRIGGER t97_fail_event");
  ok("㉘ ⭐a failed event append rolls the state change back with it",
     failed && store.get(db, id).line === "mail" &&
     store.events(db, { taskId: id }).at(-1).kind === "release",
     `failed=${failed} line=${store.get(db, id).line}`);

  // Fixtures out of the shared pool (see ⑩bis).
  for (const x of [id, p1, p2]) store.setReleased(db, { id: x, released: 0 });
}


console.log(`\n${"─".repeat(56)}\nresult: ${pass} PASS / ${fail} FAIL  (temp db ${process.env.BOARD_DB})`);
db.close?.();
try { rmSync(TMP, { recursive: true, force: true }); } catch {}
process.exit(fail ? 1 : 0);
