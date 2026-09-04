// Pull-based task queue — storage and state machine.
//
// Why pull, not push: a push queue's lifetime is the few milliseconds of fan-out,
// so the panel can never show "what is waiting". Once persisted: tasks can be added
// at any time, a single card can be bounced and re-run, a human can jump the queue,
// and "waiting" becomes an observable, durable state.
//
// The state machine has exactly four values (ruling):
//   not_started -> in_progress -> waiting -> done
//   The breakdown of waiting lives in the waiting_for column (review/decision/dep/...).
//
//   There is NO "blocked" state. When a worker cannot produce, the correct behavior
//   is self-retry (the loop re-runs it with its previous output injected); only when
//   attempts are exhausted does it land in waiting/decision, stating what it waits for.
//   waiting stops only THAT task chain — cards not depending on it keep being claimed.
//
// To avoid inventing a fifth state, these three are COLUMNS, not states:
//   released (0 = coordinator staging, invisible to workers) / waiting_for / max_attempts
//
// Three design red lines (inherited from the first generation of this queue):
//   1. claim must be atomic across processes. BEGIN IMMEDIATE + busy_timeout.
//   2. Leases prevent loss. A dead worker must not pin a card in in_progress forever —
//      an expired lease returns it to not_started automatically.
//   3. Acceptance is part of the data. `acceptance` stores "how to judge whether this
//      got done" (ideally an executable command). What a machine can judge must not
//      be left to good intentions.
//
// Storage: node:sqlite (built into Node >= 22.5; zero dependencies). WAL mode lets
// the panel read concurrently.
//
// House rule on comments: NO line numbers. A written ":286" was measured to be ":295"
// one round later, and the very next queued card was already going to shift it again.
// Point by content (grep), never by coordinate.

const { DatabaseSync } = require("node:sqlite");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const DATA_DIR = process.env.BOARD_DATA_DIR || path.join(__dirname, ".data");
const DB_PATH = process.env.BOARD_DB || path.join(DATA_DIR, "board.db");
const DEFAULT_LEASE_MIN = 30;

// Route a card carries when none is given. Routes are fleet vocabulary (which kind
// of runtime may pick the card up); the value set is the host fleet's config, not ours.
const DEFAULT_ROUTE = process.env.BOARD_DEFAULT_ROUTE || "default";

// ── Error classification lives in a TYPE, never in prose (error-taxonomy ruling) ──
// ⚠ Old shape: the server's catch split 409/400 by PARTIAL PROSE MATCH on our own
//   error messages. Fix one character of wording and 409 silently degrades to 400 —
//   losing a race (a normal conflict) gets reported as a hard failure. The contract
//   was riding on prose. Worse, the existing check (`>= 400`) stayed green through
//   the degradation, so the contract rotted invisibly.
// ⇒ Classification lives in `error.code`; the server looks ONLY at the code.
//   Wording is for humans and is never a machine criterion.
//
// ── Four boxes. The boundary is WHOSE HANDS THE BALL IS IN (fourth-box ruling) ──
//   BAD_INPUT 400 = fix your request. However often you resend it unchanged, it fails.
//   CONFLICT  409 = the request is fine; it passes once the board changes. Wait or
//                   move to another card.
//   NOT_FOUND 404 = the thing you pointed at does not exist.
//   INTERNAL  500 = WE (or something we called) broke. Nothing the caller can fix.
// ⭐ Why the fourth box was needed: the code IS the caller's retry decision. With only
//   three boxes, internal failures (a child process dying, a file that can't be
//   written) fell into 400 — telling the caller "your request is bad, resending is
//   pointless" = reporting a recoverable failure as unrecoverable. A lie.
// ⚠ The extension of "internal" was also ruled here: upstream timeout / child-process
//   failure / unwritable file all go in the SAME box — the caller cannot tell them
//   apart, and even if it could, the reaction is identical (can't fix the request;
//   try later). ⛔ Do not split into 502/503/504: a distinction nobody consumes just
//   rots without anyone turning it red.
const ERR = { NOT_FOUND: "NOT_FOUND", CONFLICT: "CONFLICT", BAD_INPUT: "BAD_INPUT", INTERNAL: "INTERNAL" };

/** Build a classified Error. ⚠ EVERYTHING thrown from the store goes through here. */
function err(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/**
 * Mapping to HTTP status. **This is the only mapping table** (the server must not
 * grow a second one).
 *   NOT_FOUND → 404 / CONFLICT → 409 / BAD_INPUT → 400 / INTERNAL → 500
 * ⚠ Untyped errors (from outside the store, or a forgotten classification) fall to
 *   400 — but NOT silently: `typed:false` makes the caller announce it. A silent 400
 *   means "unclassified errors keep accumulating and nobody can notice" — which is
 *   exactly how the old implementation decayed.
 */
function httpStatusFor(e) {
  const c = e && e.code;
  if (c === ERR.NOT_FOUND) return { status: 404, typed: true };
  if (c === ERR.CONFLICT)  return { status: 409, typed: true };
  if (c === ERR.BAD_INPUT) return { status: 400, typed: true };
  if (c === ERR.INTERNAL)  return { status: 500, typed: true };
  // ⚠ Unique-constraint violations are the one thing arriving from OUTSIDE the store
  //   (the DB driver). Matching that string is NOT an exception to "never split on
  //   prose": it is the driver's fixed wording, not ours — our editing can't move it.
  if (/UNIQUE constraint/.test(String((e && e.message) || ""))) return { status: 409, typed: true };
  // ⚠ Even with INTERNAL available, the default for unclassified stays 400. Never
  //   tip unknowns toward 5xx — the cost of being wrong is asymmetric:
  //     wrong 400 → the caller gives up, the warning above fires, the card stops
  //                 ⇒ a human notices.
  //     wrong 500 → a caller with no intention of fixing anything hammers forever
  //                 ⇒ quota burns and nobody notices.
  //   5xx is only for errors that declared themselves. Fail toward the quiet side —
  //   same etiquette as fail-closed.
  return { status: 400, typed: false };
}

const STATUS = ["not_started", "in_progress", "waiting", "done"];
// review   = delivered, nobody has looked yet
// confirm  = auto-review looked and decided "a human must decide" (with options A/B/C)
// decision = the worker exhausted its own attempts and is asking for help
// dep      = waiting on a dependency
// rearm    = parked until unfinished children complete, then re-reviewed
// ⭐ Without splitting review from confirm, "untouched" and "waiting on YOU" wear
//   the same face.
const WAITING_FOR = ["review", "confirm", "decision", "dep", "rearm"];
const VALID_STATUS = new Set(STATUS);

// ⭐ The DESTINATION of a ruling is declared by the caller (disposition ruling).
//   The old criterion was a proxy on content — "did the human write a note?" — which
//   broke the day the server started synthesizing A/B/C ruling texts itself: the
//   synthesized note is always non-empty, so a card that went through options could
//   STRUCTURALLY never close (measured: one card ping-ponged to attempt 10).
const DISPOSITIONS = new Set(["close", "hand_back", "hold_for_review"]);
function assertDisposition(v) {
  if (v == null) return null;                       // undeclared ⇒ fall back to the legacy inference
  if (!DISPOSITIONS.has(String(v)))
    throw err(ERR.BAD_INPUT, `disposition 只接受 close/hand_back/hold_for_review —— 收到 ${JSON.stringify(v)}`);
  return String(v);
}
/** Destination for a card whose "the human executed this in production" receipt is
 *  confirmed. **This is the single criterion** (panel and server both import it).
 *  ⭐ Every uncertain branch goes to hand_back (= today's behavior = do not close,
 *    do not enter the machine queue). This function can only NARROW the new path,
 *    never widen it.
 *  · human_gate=1 … governance says "machines keep off". Ruled: do NOT hold — a held
 *    card keeps its gate, pendingReview (which filters human_gate=0) never sees it,
 *    and it stalls silently with nobody pushing. Dropping the gate to pass it to
 *    review would be a silent demotion of a governance mark. ⇒ same road as today
 *    (not_started; claim also filters human_gate=0, so it waits for a human).
 *  · unfinished children … claim has a parent gate (unfinishedKids), but
 *    pendingReview does NOT look at children. Holding would send a parent whose
 *    children haven't finished straight to review — and an approve with a green
 *    verify would cascade-close the siblings. ⇒ excluded here.
 *    ⚠ The scope of deferToRearm (waiting/confirm only) is NOT widened here — that
 *    scope is someone else's ruling, quoted, not owned. */
function confirmDestination(db, t) {
  if (Number(t.human_gate) !== 0) return "hand_back";
  const kid = db.prepare(`SELECT 1 FROM tasks WHERE parent_id=? AND archived_at IS NULL
                            AND status<>'done' LIMIT 1`).get(Number(t.id));
  if (kid) return "hand_back";
  return "hold_for_review";
}

/** Legacy criterion. **This one function is the canon** — the server used to carry a
 *  hand-written copy; that copy was deleted and the server imports this instead. */
function legacyDisposition({ verdict, note = "", resolvedBy = "human" }) {
  const said = String(note || "").trim();
  const handBack = resolvedBy === "human" && said.length > 0;
  return handBack ? "hand_back" : (verdict === "approve" ? "close" : "hand_back");
}

// Legacy statuses (earlier queue generations) -> the four values. Applied once by migrate().
const STATUS_REMAP = {
  todo: "not_started",
  backlog: "not_started",   // + released=0 (set during migrate, before status is overwritten)
  rejected: "not_started",  // dead value in the ancestor codebase (resolve never wrote it)
  in_review: "waiting",     // + waiting_for='review'
  blocked: "waiting",       // + waiting_for='decision'
  canceled: "done",
};

// Columns added on top of the original 13. ALTER TABLE ADD COLUMN must be idempotent,
// so existence is checked via PRAGMA first.
const ADDED_COLUMNS = [
  ["route", `TEXT NOT NULL DEFAULT '${DEFAULT_ROUTE.replace(/'/g, "''")}'`],
  ["line", "TEXT"],
  ["heartbeat_at", "INTEGER"],
  ["lock_key", "TEXT"],
  ["evidence_path", "TEXT"],
  ["archived_at", "TEXT"],
  ["needs_bash", "INTEGER NOT NULL DEFAULT 0"],
  ["released", "INTEGER NOT NULL DEFAULT 1"],
  ["waiting_for", "TEXT"],
  ["max_attempts", "INTEGER NOT NULL DEFAULT 3"],
  // ⭐ Budget-caliber ruling: SPLIT what the number means. `attempts` is the lifetime
  //   total (never decremented = audit history); `attempts_base` is the total AS OF
  //   the start of the current dispatch — claim re-stamps it on every claim.
  //   ⇒ attempts used this dispatch = attempts - attempts_base (row() exposes it as
  //   attempts_this_claim).
  //   Measured (board health audit): a bounced card came back as "4/3" and the
  //   loop's `attempt >= max_att` parked it after a single run — a number placed as
  //   "budget per dispatch" was actually a lifetime total. The fix is not deleting
  //   the column but adding ONE MORE and splitting the calibers.
  // ⛔ No judgment lives in this column. "Exhausted?" is said in exactly one place —
  //   the worker loop (single-judgment ruling).
  ["attempts_base", "INTEGER NOT NULL DEFAULT 0"],
  // goal = a top-level item written by a human. An LLM decomposes it into child
  // tasks, which enter not_started. ⭐ Still four states: goal is a KIND, not a
  // status — no fifth state.
  ["kind", "TEXT NOT NULL DEFAULT 'task'"],   // goal | task
  // Provenance column: on a line move, keep ONLY the immediately previous line
  // (full history is the audit trail's job; this is just the "← came from" anchor).
  // ⭐ NEVER admit it into claim criteria — two routable lines would split "who may
  //   claim" (ruling).
  ["prev_line", "TEXT"],
  ["pinned_at", "TEXT"],                      // goal pin time; its children get claim priority
  ["parent_id", "INTEGER"],                   // the goal (or card) this child belongs to
  ["resolved_by", "TEXT"],        // human / auto / cascade — how the done pile is sorted
  // ── Linked closure (ruling: "one path through means the rest are no longer needed").
  // ⭐ The real cause of card proliferation is not the spawn rate but the failure to
  //   HARVEST IMPLICATIONS: cards made unnecessary by one success are never closed,
  //   so they sit in the queue forever.
  // ⚠★ OR-ness exists ONLY by declaration. Ordinary derived siblings are AND — the
  //   spawn prompt demands "outside this card's acceptance / independently verifiable
  //   / different permissions and owner". Inferring "probably an alternative" from
  //   prose and closing it silently DISCARDS someone's separate work.
  //   `oneof_key` = key of a group under the same parent where any one passing
  //   suffices.
  ["oneof_key", "TEXT"],
  //   `proves_parent` = if this child passes, the parent's question is answered
  //   (parent closes with it).
  ["proves_parent", "INTEGER NOT NULL DEFAULT 0"],
  // ⭐ The PRECONDITION measurement for linked closure. "It was approved, so it must
  //   have passed" is inference, not measurement.
  //   null = not measured / 1 = verify exited 0 right before this ruling / 0 = red.
  ["verify_ok", "INTEGER"],
  ["verify_at", "TEXT"],
  ["auto_review_at", "TEXT"],     // when auto-review last looked; older than updated_at ⇒ re-review
  // The KEY of a registered verify (verify_registry.json), never a command string —
  // workers can write files, so a card that can carry a command can nominate a
  // self-authored script as its own judge.
  ["verify_cmd", "TEXT"],
  // ⭐ Verdict-caliber ruling: `verdict` is the RESULT (the approve of a closed card).
  //   Invariant: **verdict non-NULL ⟺ status='done'**. Hand-backs, reopens and goal
  //   reopens reset it to NULL. The old code wrote it unconditionally ⇒ cards bounced
  //   with an annotated approve ran around as "not_started yet verdict='approve'"
  //   (measured: 8 cards), lying to everything that reads verdict for "did it pass"
  //   (reports / review pre-filters / archive rules / future automation).
  ["verdict", "TEXT"],
  // ⭐ `last_verdict` is THIS ROUND's ruling = what a human/auto-review last pressed.
  //   Survives without closing. It is the only marker of "came back through a
  //   ruling", which the re-prompt carrier and the panel's "you wrote instructions ·
  //   continuing on original line" badge both need ⇒ the fix was renaming, not
  //   deleting. ⛔ Never use this column to judge "did it pass" — it is history,
  //   not outcome.
  ["last_verdict", "TEXT"],
  // True completion time. updated_at moves on post-hoc annotations (measured: done
  // cards kept stretching to "today" on the timeline).
  ["resolved_at", "TEXT"],
  // Work spans, verbatim [{w,s,e}...]: opened by claim, closed by report/release/reap.
  // Without it the timeline can only draw "lifetime", making serial workers look
  // parallel (measured).
  ["work_spans", "TEXT"],
  // Starting-rung prediction: light / standard / heavy — default standard.
  // ⚠ This is NOT a model name and NOT an effort setting. It only says WHICH RUNG OF
  //   THE LADDER TO START ON; the rung→(model,effort) table lives in the worker loop,
  //   in ONE place. Writing model/effort into the column would hand model-nomination
  //   power to whoever can write cards (= quota nomination rights move to card
  //   authors), and would duplicate the table so only one copy gets fixed.
  // The value-set gate is the server's badRoutable (the store does not know
  // LINES/ROUTES/WEIGHTS — layers are not crossed).
  // NOT NULL DEFAULT so existing cards land on 'standard' via ALTER's default ⇒ the
  // loop never needs a null branch for "card without the column".
  ["weight", "TEXT NOT NULL DEFAULT 'standard'"],
  // ⭐ Human-gated pre-filter (governance ruling): 1 = this card waits for a HUMAN
  //   decision; workers must not touch it — claim/claimById filter it out BEFORE
  //   claiming, so attempts never burn (old shape: claim first, discover it needs a
  //   human, burn a round, bounce). Unlocking is layered: a human ruling unlocks
  //   everything / an auto ruling unlocks only the detector lock (see
  //   human_gate_src). update humanGate opens/closes it explicitly.
  //   ⛔ Not a fifth state — the card stays not_started; it just doesn't enqueue.
  ["human_gate", "INTEGER NOT NULL DEFAULT 0"],
  // ⭐ Where the lock came from (layered-unlock ruling):
  //   'detect'   = add()'s literal sniff (the safety net) = a MACHINE's lock → an
  //                auto ruling may remove it
  //   'explicit' = explicitly set (humanGate:true / edit) = a DELIBERATE lock → only
  //                a human ruling removes it
  //   NULL = no lock. Authority is symmetric: who placed it decides who may remove
  //   it. The INCIDENT-5 wall (a machine promoting its own note to human authority)
  //   is only needed on the "machine removes a human's lock" path; making humans
  //   unlock machine locks too is excess rigidity.
  ["human_gate_src", "TEXT"],
  // ⭐ Actual-runtime stamp (badge ruling): self-reported by the loop at claim time;
  //   the panel swaps the route-family badge for the actual runner. ⛔ This is NOT
  //   routing — claim criteria never read it, and the card face cannot set it
  //   (update does not accept it). NULL = never claimed / legacy card → the panel
  //   falls back to the route family (fail-safe).
  ["last_runtime", "TEXT"],
  // Auto-review's structured ruling package. verdict_note keeps the readable
  // history; the UI no longer guesses A/B/C out of prose.
  ["decision_json", "TEXT"],
  // The option key the human finally chose, and the SQL archive listing. Both record
  // facts only; neither enters claim criteria.
  ["decision_choice", "TEXT"],
  ["decision_sql_archive", "TEXT"],
  // Record of an IRREVERSIBLE external action ("the human executed this in
  // production"). None of the four existing carriers survives one full cycle —
  // decision_choice / decision_sql_archive / verdict_note are overwritten by
  // markAutoReviewed, result by the next report. Harmless while cards always left
  // waiting; hold_for_review removes that protection, hence a dedicated column.
  ["decision_receipt", "TEXT"],
  // ⭐ No-progress brake (v0.11). `dispatch_fp` is the STATE FINGERPRINT recorded at
  //   the LAST claim. The next claim compares it against the fingerprint now: equal
  //   ⇒ nothing has changed since that dispatch, so the card is not handed out at
  //   all — no attempt burned, no lease taken, and above all NO MODEL CALL. The cost
  //   of a repeat used to be paid before anything could refuse it (`attempts` is
  //   incremented inside claim itself).
  //   ⭐ Recorded at CLAIM, not at report, and that is the load-bearing choice: it
  //   covers the bounce loop as well as the park loop. A worker that delivers, gets
  //   bounced with a note, re-runs and delivers the SAME thing, and is bounced with
  //   the SAME note, produces an identical fingerprint on the third claim — which is
  //   exactly the "reviewer asks, worker re-explains, forever" cycle. Recording at
  //   report would only ever have caught cards that failed.
  //   Stored as JSON of the components, not a bare hash, so the panel can say WHICH
  //   component changed when the card runs again ("why this may run now").
  ["dispatch_fp", "TEXT"],
  ["dispatch_fp_at", "TEXT"],
  // ⭐ What the LAST ruling actually said, verbatim and on its own. `verdict_note` is
  //   an append-only record carrying a timestamped header per entry, so its full text
  //   differs on every ruling even when the ruling says the identical thing — reading
  //   it as "did anyone say anything new?" always answers yes, and a brake built on
  //   that answer never engages. This column is the answer to that question.
  //   An empty ruling stores the empty string: "this time nobody said anything" is
  //   itself a fact, and must not read as "unchanged from last time".
  ["last_note", "TEXT"],
  // ⭐ Review-side twin of dispatch_fp (v0.11.2): WHICH deliverable the auto-reviewer
  //   last looked at. `auto_review_at < updated_at` answers "has the card moved since
  //   the review", which is not the same question — the note right above pendingReview
  //   records the consequence: fix one line on the card face and the whole pile
  //   marches back into re-review. Same deliverable + same acceptance + same machine
  //   result ⇒ the previous verdict stands, and no reviewer is paid to reach it again.
  ["review_fp", "TEXT"],
];

// ── Human-gate literal sniff (the safety net behind explicit humanGate) ──────────
// Cards whose SUBJECT marks them as "this is itself a request for a human decision".
// Configurable because the marker vocabulary belongs to the host fleet.
const HUMAN_GATE_DEFAULT = /裁定|商裁/;
let HUMAN_GATE_PATTERN = HUMAN_GATE_DEFAULT;
if (process.env.BOARD_HUMAN_GATE_PATTERN) {
  try { HUMAN_GATE_PATTERN = new RegExp(process.env.BOARD_HUMAN_GATE_PATTERN, "i"); }
  catch (e) {
    // Loud fallback — a silently dead pattern would un-gate every ruling card.
    console.error(`⚠ BOARD_HUMAN_GATE_PATTERN is not a usable regex (${e.message}) — ` +
                  `falling back to default /${HUMAN_GATE_DEFAULT.source}/i`);
  }
}

/**
 * Registry of verifications a card may nominate. **Written in exactly one place**
 * (store and loop read the same file) — write it twice and only one copy gets fixed,
 * after which "green" means different things to different readers.
 */
const VERIFY_REGISTRY_PATH =
  process.env.BOARD_VERIFY_REGISTRY || path.join(__dirname, "verify_registry.json");
function verifyRegistry() {
  try {
    const raw = JSON.parse(fs.readFileSync(VERIFY_REGISTRY_PATH, "utf8"));
    return Object.fromEntries(Object.entries(raw).filter(([k, v]) => !k.startsWith("_") && Array.isArray(v)));
  } catch { return {}; }
}

/** Unknown keys fall on the refusal side (this is a permission gate, so allowlist).
 *  Empty/unset is legal and means "no verification". */
function assertVerify(key) {
  if (key == null || key === "") return null;
  const reg = verifyRegistry();
  if (!Object.prototype.hasOwnProperty.call(reg, String(key)))
    throw err(ERR.BAD_INPUT, `verify_cmd='${key}' 不在登记簿里。可用的键: ${Object.keys(reg).join(" / ") || "(登记簿是空的)"}` +
                    ` —— 写 verify_registry.json 的键,不是命令字符串`);
  return String(key);
}

function open(readOnly = false) {
  if (!readOnly && !fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new DatabaseSync(DB_PATH, { readOnly });
  db.exec("PRAGMA busy_timeout=5000");
  if (!readOnly) {
    db.exec("PRAGMA journal_mode=WAL");
    migrate(db);
  }
  return db;
}

/** Idempotent. Runs on an empty DB and on an existing one; N runs, same end state. */
function migrate(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    acceptance TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'not_started',
    worker TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    lease_until INTEGER,
    result TEXT,
    verdict_note TEXT,
    blocked_by TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);

  const have = new Set(db.prepare("PRAGMA table_info(tasks)").all().map((r) => r.name));
  for (const [name, decl] of ADDED_COLUMNS) {
    if (have.has(name)) continue;
    db.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${decl}`);
    // ⭐ One-time catch-up, run ONLY in the same breath as adding the column. Left at
    //   the default 0, every existing card reads as "already used `attempts` in the
    //   current dispatch" — measured: a live 6/3 card sat in in_progress, so a plain
    //   migration would park it on the very next tick.
    if (name === "attempts_base") backfillAttemptsBase(db);
    if (name === "last_verdict") backfillVerdictCaliber(db);
  }

  // Status remap. Order matters: backlog -> released=0 must be set BEFORE status is
  // overwritten.
  db.prepare("UPDATE tasks SET released=0 WHERE status='backlog'").run();
  db.prepare("UPDATE tasks SET waiting_for='review' WHERE status='in_review'").run();
  db.prepare("UPDATE tasks SET waiting_for='decision' WHERE status='blocked'").run();
  for (const [from, to] of Object.entries(STATUS_REMAP)) {
    db.prepare("UPDATE tasks SET status=? WHERE status=?").run(to, from);
  }

  // lock_key mutual exclusion is a **DB guarantee**. The filter inside claim only
  // means "skip to the next candidate"; the last line of defense in a race is this
  // partial unique index (unbreakable even bypassing the application layer).
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ux_lock_inflight
             ON tasks(lock_key) WHERE lock_key IS NOT NULL AND status='in_progress'`);
  db.exec("CREATE INDEX IF NOT EXISTS ix_status_released ON tasks(status, released)");
  // ⭐ The lineage graph's SOURCE OF TRUTH. Append-only: the sole write path is
  //   appendEvent()'s INSERT — events are never corrected and never deleted.
  //   `detail` holds a SNAPSHOT of the moment (line / parent_id / status / kind /
  //   released), so moving a card to another line or re-hanging it later cannot
  //   rewrite what already happened. Reconstructing history from a card's CURRENT
  //   values is exactly the thing this retires: it makes the past reroute itself.
  db.exec(`CREATE TABLE IF NOT EXISTS task_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    task_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    actor TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '{}'
  )`);
  db.exec("CREATE INDEX IF NOT EXISTS ix_task_events_task_at ON task_events(task_id, at, id)");
  // v0.5 operator requests: a panel button pressed by the operator, addressed to
  // the coordinator seat. The row is the durable half of the loop (the SSE event
  // is the wake-up; the row is what the panel reads back), so "nobody answered"
  // is visible instead of silent — a request pending too long is an alarm.
  db.exec(`CREATE TABLE IF NOT EXISTS operator_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    params TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'pending',
    note TEXT,
    created_at TEXT NOT NULL,
    acked_at TEXT,
    done_at TEXT
  )`);
  // Unique (parent, normalized subject): even if a retry emits the same proposal
  // twice, the DATABASE blocks the duplicate (structure, not discipline).
  // Normalization = strip spaces (ASCII and full-width) + lowercase. While existing
  // data still holds duplicates the index cannot be built — say so LOUDLY and carry
  // on (the board needs cleaning first; the loop's first-strike dedup still works
  // without the index).
  try {
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ux_child_subject
             ON tasks(parent_id, lower(replace(replace(subject, ' ', ''), '　', '')))
             WHERE parent_id IS NOT NULL AND archived_at IS NULL`);
  } catch (e) {
    console.error("⚠ ux_child_subject unique index NOT built (duplicate child subjects in existing data?): " + e.message +
                  " — duplicate defense is temporarily only the loop's first-strike dedup; clean the dupes and restart to build it");
  }

  // ⭐ The DB-level BELT for the ancestor-release invariant (governance ruling). The
  //   main gate is in claim/claimById (application layer, refuses by name); this
  //   trigger is the last line that survives bypassing the application layer (same
  //   rank as ux_lock_inflight). Prefer a recursive CTE (unlimited ancestor depth);
  //   if this SQLite rejects WITH inside a trigger, fall back to a fixed depth of 12
  //   (measured deepest chain: 7 — 12 has slack). WHICH one was used is printed,
  //   never silent.
  //   ⚠ Only on UPDATE→in_progress: every creation path lands in not_started (add()
  //   is the single INSERT road), so the only write road into in_progress is the
  //   UPDATE in claim/claimById — an INSERT belt would have no subject.
  db.exec("DROP TRIGGER IF EXISTS trg_ancestor_release_gate");
  const gateTrigger = (cond) =>
    `CREATE TRIGGER trg_ancestor_release_gate
     BEFORE UPDATE OF status ON tasks
     WHEN NEW.status='in_progress' AND (${cond})
     BEGIN SELECT RAISE(ABORT, 'ancestor-release-gate: 祖先未放行,后代不可进入进行中'); END`;
  const cteCond = `EXISTS (
      WITH RECURSIVE anc(aid) AS (
        SELECT NEW.parent_id
        UNION ALL
        SELECT t.parent_id FROM tasks t JOIN anc ON t.id = anc.aid WHERE anc.aid IS NOT NULL
      ) SELECT 1 FROM tasks x JOIN anc ON x.id = anc.aid WHERE x.released = 0)`;
  const fixedCond = (depth) => {
    let sql = "0";
    for (let k = depth; k >= 1; k--) {
      const ref = k === 1 ? "NEW.parent_id" : `p${k - 1}.parent_id`;
      sql = `EXISTS(SELECT 1 FROM tasks p${k} WHERE p${k}.id=${ref} AND (p${k}.released=0 OR ${sql}))`;
    }
    return sql;
  };
  try { db.exec(gateTrigger(cteCond)); }
  catch (e) {
    db.exec(gateTrigger(fixedCond(12)));
    console.log("ancestor-release-gate: this SQLite rejects a CTE inside a trigger (" + e.message +
                ") — fell back to the fixed-depth-12 version (equivalent up to 12 levels)");
  }

  // An existing database cannot recover the bounces and line moves that happened
  // before this table existed. Lay down ONE snapshot at migration time and start
  // appending from there — never manufacture a past out of created_at / work_spans /
  // current values, which is precisely the fabrication this table exists to end.
  // Idempotent by "does this card have ANY event yet", so a card created after the
  // migration is never re-snapshotted.
  const known = new Set(db.prepare("SELECT DISTINCT task_id FROM task_events").all()
    .map((r) => Number(r.task_id)));
  for (const t of db.prepare(
    "SELECT id, line, parent_id, status, kind, released FROM tasks ORDER BY id").all()) {
    if (known.has(Number(t.id))) continue;
    appendEvent(db, {
      taskId: t.id, kind: "snapshot", actor: "migration",
      detail: eventState(t, { imported: true }),
    });
  }
}

/**
 * Catch-up for a DB that gained `attempts_base` after the fact. Called EXACTLY ONCE,
 * in the same breath as adding the column (by value alone, "the default 0" and "a
 * genuine first claim's 0" are indistinguishable, so it cannot be repaired
 * idempotently later).
 *  · in_progress = mid-dispatch right now. No record of where the dispatch started,
 *    so tip toward LENIENT (treat the current run as round 1 ⇒ base = attempts-1).
 *    Not knowing is no reason to kill a running card.
 *  · everything else = outside a dispatch ⇒ zero used this round is correct
 *    (base = attempts). The next claim re-stamps the anchor anyway; this value only
 *    serves the panel's display.
 * Exported so tests can fire it directly (reproducing it across migrate() is
 * impossible, so measure it by calling it).
 */
function backfillAttemptsBase(db) {
  const r = db.prepare(
    `UPDATE tasks SET attempts_base =
       CASE WHEN status='in_progress' THEN max(attempts - 1, 0) ELSE attempts END`).run();
  return Number(r.changes || 0);
}

/**
 * Cleanup for a DB that gained `last_verdict` after the fact. Called EXACTLY ONCE,
 * in the same breath as adding the column.
 *  ① What sits in `verdict` today is "the last thing pressed", so copy it to
 *     `last_verdict` verbatim — NOTHING in the history is discarded (the ruling
 *     asked for a SPLIT, not a deletion).
 *  ② NULL out `verdict` on unclosed cards = align to the invariant.
 *     Measured (board health audit): eight cards carried approve while sitting in
 *     not_started/waiting/in_progress, one more held reject in waiting. Fixing nine
 *     rows by hand would not reproduce on the next DB — so it lives in the
 *     migration instead.
 */
function backfillVerdictCaliber(db) {
  db.prepare("UPDATE tasks SET last_verdict = verdict WHERE verdict IS NOT NULL").run();
  const r = db.prepare("UPDATE tasks SET verdict = NULL WHERE status <> 'done'").run();
  return Number(r.changes || 0);
}

/**
 * ⭐ Budget calibers — never mix the two numbers (budget-caliber ruling).
 *  · Budget per dispatch = `max_attempts`. Refills to FULL on every claim (claim
 *    re-stamps attempts_base). Whether it is exhausted is judged in ONE place, the
 *    worker loop, using attempts - attempts_base.
 *  · Lifetime total = `attempts`. Never decremented, never deleted (audit history).
 *  · Lifetime ceiling = max_attempts × LIFETIME_DISPATCH_CAP. The LAST wall against
 *    auto-bounce → re-claim spinning forever. ⚠ Not the primary brake — the primary
 *    brake against idle spin is the loop's failure-fingerprint brake.
 *
 * ⚠ A competing same-day patch had plugged claim with `attempts < max_attempts`.
 *   Incompatible with the ruling: a bounced card would park on the spot at re-claim,
 *   and an annotated resolve's "+1 top-up" is exactly the "only one shot left"
 *   symptom the ruling names. The later, explicit ruling won; the old patch's
 *   protective intent survives as the lifetime ceiling. The number 4 is POLICY and
 *   belongs to the operator; change it here and nowhere else (it is deliberately
 *   not scattered).
 */
const LIFETIME_DISPATCH_CAP = 4;
const lifetimeCap = (t) => Number(t.max_attempts) * LIFETIME_DISPATCH_CAP;

// ⭐ WIP cap (governance ruling): max cards of ONE ROOT CHAIN in flight
//   (in_progress) at once. The panel folding the candidate pool only hides them —
//   it does not keep them out; a cap must be enforced at the claim site.
//   Root = walk parent_id to the top (no parent = itself). The number is policy;
//   env-tunable, default 2.
const WIP_PER_ROOT = Math.max(1, Number(process.env.BOARD_WIP_PER_ROOT || 2));

/** Walk parent_id to the chain root. ⚠ Depth cutoff 32: measured deepest chain is 7,
 *  32 is anti-cycle insurance (cycles are prevented by placeInChain; on hitting the
 *  ceiling return the current node, don't throw — an unwalkable chain simply counts
 *  under that root at the claim site). */
function rootOf(db, id) {
  let cur = Number(id), hops = 0;
  while (hops++ < 32) {
    const r = db.prepare("SELECT parent_id FROM tasks WHERE id=?").get(cur);
    if (!r || r.parent_id == null) return cur;
    cur = Number(r.parent_id);
  }
  return cur;
}

/** ⭐ THE single dependency judgment (dep-judgment consolidation). **Fail-closed.**
 *
 *  ⚠ Before the fix, three call sites each did `try { deps = JSON.parse(...) } catch {}`
 *    — one corrupt byte made deps=[] ⇒ "zero dependencies" ⇒ CLAIMABLE. Polarity
 *    inverted. "Parsed fine and was empty" and "failed to parse" are DIFFERENT
 *    things; only the former is a release branch.
 *
 *  Returns { ok, broken, pending }:
 *   · broken=true … unparsable / not an array / non-integer element ⇒ ok=false
 *     (refusal side, with a nameable reason)
 *   · pending … dependency ids not yet done. Empty ⇒ ok=true.
 *  ⚠ The definition of "done" is captured HERE, once (callers must not sweep the
 *  whole table for status='done' themselves). */
function depsSatisfied(db, t) {
  let deps;
  try { deps = JSON.parse(t.blocked_by); } catch { return { ok: false, broken: true, pending: [] }; }
  if (!Array.isArray(deps)) return { ok: false, broken: true, pending: [] };
  if (!deps.length) return { ok: true, broken: false, pending: [] };
  const ids = deps.map(Number).filter(Number.isInteger);
  if (ids.length !== deps.length) return { ok: false, broken: true, pending: [] };
  const done = new Set(db.prepare(
    `SELECT id FROM tasks WHERE status='done' AND id IN (${ids.map(() => "?").join(",")})`
  ).all(...ids).map((r) => Number(r.id)));
  const pending = ids.filter((d) => !done.has(d));
  return { ok: pending.length === 0, broken: false, pending };
}

/** ⭐ Validation on the WRITE path of dependency edges.
 *  Returns the canonical form for the DB (ascending, deduplicated, JSON string).
 *  Invalid input throws ⇒ the WHOLE update fails (no half-write). BOTH entrances —
 *  add and update — go through this one function; plugging only one is the classic
 *  hole.
 *
 *  ⚠ Cycle detection is DFS with a visited set, bounded by TABLE ROW COUNT. Do NOT
 *    copy the parent side's "32 hops": parents form a CHAIN (each node has at most
 *    one parent) so 32 hops = 32 levels, but blocked_by is a many-to-many GRAPH —
 *    cut at 32 and any transitive closure beyond 32 nodes gets legal usage refused
 *    outright (with no workaround), guaranteed to happen as the board grows. A row-
 *    count bound terminates and never falsely refuses. */
function normalizeDeps(db, selfId, raw) {
  if (!Array.isArray(raw)) throw err(ERR.BAD_INPUT, "blockedBy 必须是数组");
  const ids = [];
  for (const x of raw) {
    const n = Number(x);
    if (!Number.isInteger(n) || n <= 0) throw err(ERR.BAD_INPUT, `依赖 ${JSON.stringify(x)} 不是正整数卡号`);
    if (selfId != null && n === Number(selfId)) throw err(ERR.BAD_INPUT, `不能让 #${n} 依赖它自己`);
    const t = db.prepare("SELECT id, archived_at FROM tasks WHERE id=?").get(n);
    if (!t) throw err(ERR.NOT_FOUND, `依赖的 #${n} 不存在`);   // used to block silently forever ⇒ loud now
    if (t.archived_at) throw err(ERR.BAD_INPUT, `#${n} 已归档,不能作为依赖`);
    if (!ids.includes(n)) ids.push(n);
  }
  if (selfId != null && ids.length) {
    const seen = new Set(), stack = [...ids];
    const cap = db.prepare("SELECT COUNT(*) c FROM tasks").get().c + 1;
    let steps = 0;
    while (stack.length) {
      if (++steps > cap) throw err(ERR.BAD_INPUT, "依赖图遍历超出表行数 —— 拒绝(fail-closed)");
      const cur = Number(stack.pop());
      if (cur === Number(selfId))
        throw err(ERR.BAD_INPUT, `会形成循环:#${selfId} 已经在 #${ids.join("/#")} 的依赖链上,拒绝`);
      if (seen.has(cur)) continue;
      seen.add(cur);
      const r = db.prepare("SELECT blocked_by FROM tasks WHERE id=?").get(cur);
      // ⭐ "Could not finish checking" is NOT "safe" — same polarity as the parent-side
      //   fail-closed guard.
      try { for (const d of JSON.parse(r?.blocked_by || "[]")) stack.push(Number(d)); }
      catch { throw err(ERR.BAD_INPUT, `#${cur} 的 blocked_by 解析不出来 —— 无法证明无循环,拒绝`); }
    }
  }
  return JSON.stringify(ids.sort((a, b) => a - b));
}

/** Who is waiting on this card (read-only). At board scale (~150 cards) a plain full
 *  scan is fine — do not bet on SQLite's JSON1 compile option. ⚠ Corrupt values are
 *  RETURNED in `broken` (never skipped silently). */
function dependentsOf(db, id) {
  const target = Number(id), list = [], broken = [];
  for (const r of db.prepare(
    "SELECT id, subject, status, line, blocked_by FROM tasks WHERE archived_at IS NULL").all()) {
    let deps;
    try { deps = JSON.parse(r.blocked_by); } catch { broken.push(Number(r.id)); continue; }
    if (!Array.isArray(deps)) { broken.push(Number(r.id)); continue; }
    if (deps.map(Number).includes(target))
      list.push({ id: Number(r.id), subject: r.subject, status: r.status, line: r.line });
  }
  return { list, broken };
}

/** ⭐ Ancestor-release invariant (governance ruling): any unreleased ancestor ⇒ no
 *  descendant may be claimed. Returns the first unreleased ancestor's id; null when
 *  all released (or no ancestors).
 *  ⚠ Archived-or-not is deliberately NOT consulted: an unreleased ancestor blocks
 *    even when archived (unknown states fall on the refusal side) — to free the
 *    descendants, release the ancestor or re-hang the chain; "archive the parent to
 *    slip the gate" gets no road. */
function unreleasedAncestor(db, parentId) {
  let cur = parentId == null ? null : Number(parentId), hops = 0;
  while (cur != null && hops++ < 32) {
    const r = db.prepare("SELECT parent_id, released FROM tasks WHERE id=?").get(cur);
    if (!r) return null;
    if (!Number(r.released)) return cur;
    cur = r.parent_id == null ? null : Number(r.parent_id);
  }
  return null;
}

const now = () => new Date().toISOString();

/** An immutable event's `detail` must be a SNAPSHOT of that moment — the reader must
 *  never have to go back to `tasks` and guess what the past looked like.
 *  ⚠ The card's own `kind` is stored as `task_kind`: the event has a `kind` column of
 *  its own, and two different things under one name is how a reader gets it wrong. */
function eventState(t, extra = {}) {
  return {
    line: t.line == null ? null : String(t.line),
    parent_id: t.parent_id == null ? null : Number(t.parent_id),
    status: t.status == null ? null : String(t.status),
    task_kind: t.kind == null ? "task" : String(t.kind),
    released: t.released == null ? null : Boolean(t.released),
    ...extra,
  };
}

/** The ONLY write path into task_events. Append-only by construction: there is no
 *  update and no delete anywhere in this file, and the harness greps for that. */
function appendEvent(db, { taskId, kind, actor = "system", detail = {} }) {
  const r = db.prepare(
    "INSERT INTO task_events (at, task_id, kind, actor, detail) VALUES (?,?,?,?,?)"
  ).run(now(), Number(taskId), String(kind), String(actor || "system"), JSON.stringify(detail || {}));
  return Number(r.lastInsertRowid);
}

/** Ordered by the autoincrement id, NOT by `at`: several migrations inside one
 *  millisecond share a timestamp and would come back shuffled. */
function events(db, { taskId = null, after = 0, limit = 20000 } = {}) {
  const lim = Math.max(1, Math.min(50000, Number(limit) || 20000));
  const rows = taskId == null
    ? db.prepare("SELECT id, at, task_id, kind, actor, detail FROM task_events WHERE id>? ORDER BY id LIMIT ?")
        .all(Number(after) || 0, lim)
    : db.prepare("SELECT id, at, task_id, kind, actor, detail FROM task_events WHERE id>? AND task_id=? ORDER BY id LIMIT ?")
        .all(Number(after) || 0, Number(taskId), lim);
  return rows.map((r) => {
    let detail = {};
    try { detail = JSON.parse(r.detail || "{}"); } catch { detail = { broken: true }; }
    return { id: Number(r.id), at: r.at, task_id: Number(r.task_id),
             kind: r.kind, actor: r.actor, detail };
  });
}

/** Work spans: claim opens a span. If a span is still open (crash, re-claim), close
 *  it first. */
function spanOpen(db, id, worker) {
  const t = db.prepare("SELECT work_spans FROM tasks WHERE id=?").get(Number(id));
  let a = []; try { a = JSON.parse(t.work_spans || "[]"); } catch {}
  const last = a[a.length - 1];
  if (last && !last.e) last.e = now();
  a.push({ w: String(worker), s: now() });
  db.prepare("UPDATE tasks SET work_spans=? WHERE id=?").run(JSON.stringify(a), Number(id));
}
/** Work spans: close (no open span ⇒ no-op = idempotent). */
function spanClose(db, id) {
  const t = db.prepare("SELECT work_spans FROM tasks WHERE id=?").get(Number(id));
  let a = []; try { a = JSON.parse(t && t.work_spans || "[]"); } catch {}
  const last = a[a.length - 1];
  if (!last || last.e) return;
  last.e = now();
  db.prepare("UPDATE tasks SET work_spans=? WHERE id=?").run(JSON.stringify(a), Number(id));
}

/**
 * Chain-depth ruling ("goal → execution card → necessary follow-up, TWO layers max")
 * — **the single implementation point in the whole repo**.
 *
 * ⚠ Measured: the gate used to exist only at the worker loop's harvest site, seeing
 *   only cards the worker itself derived. CLI / panel / any other automation walked
 *   straight past it; the live board's chain depths reached 7, with 23 cards at
 *   depth ≥ 3. That no deep card had ever come in through the CLI was luck ("nobody
 *   thought of it"), not structure ⇒ the rule moved to the mandatory pass-through of
 *   all card creation: add().
 * ⭐ Never write it twice. The worker loop's own copy was deleted; it now just reads
 *   the POST result (with two copies, only one gets fixed, and "the loop blocks
 *   depth 3 but the CLI lets it through" comes back).
 */
const MAX_CHAIN_DEPTH = 2;          // goal(0) → execution card(1) → follow-up(2). No third layer.

/**
 * Hop count to the chain root, plus the root row. The root itself = 0.
 * ⚠ On hitting the 32-level cutoff, set `exhausted: true` and LET THE CALLER REFUSE —
 *   "could not finish checking" must not turn into "safe" (same ruling as the cycle
 *   guard on update).
 * ⚠ A parent id pointing at a vanished row (ghost parent) is treated as the root:
 *   legacy data can contain it, and throwing here would drag read-only callers down
 *   and freeze the whole board.
 */
function chainDepth(db, id) {
  const q = db.prepare("SELECT id, kind, parent_id, archived_at FROM tasks WHERE id=?");
  let cur = q.get(Number(id));
  if (!cur) return { depth: 0, root: null, exhausted: false };
  let depth = 0, guard = 0;
  while (cur.parent_id != null) {
    if (++guard > 32) return { depth, root: cur, exhausted: true };
    const p = q.get(Number(cur.parent_id));
    if (!p) break;
    cur = p; depth++;
  }
  return { depth, root: cur, exhausted: false };
}

/**
 * Decide where a new card goes. Returns the VALUES TO WRITE
 * ({ parentId, released, description, uplifted }). Judgment and write are separated
 * so the same rule can be fired from tests and audits alike.
 */
function placeInChain(db, { kind, parentId, released, description }) {
  // Goals are chain roots. Hanging a goal under anything breaks the board-wide
  // premise "root = goal" (family highlight, completion checks and orphan detection
  // all read it).
  if (kind === "goal" && parentId != null)
    throw err(ERR.BAD_INPUT, `目标卡必须是链根 —— 不能把 kind='goal' 挂到 #${parentId} 下面`);
  if (parentId == null) return { parentId: null, released, description, uplifted: null };

  const { depth: pdepth, root, exhausted } = chainDepth(db, parentId);
  if (exhausted)
    throw err(ERR.BAD_INPUT, `#${parentId} 的先祖链超过 32 层,无法判定链深 —— 拒绝(fail-closed)`);
  const newDepth = pdepth + 1;
  if (newDepth <= MAX_CHAIN_DEPTH)
    return { parentId, released, description, uplifted: null };

  // The uplift target is the chain-root goal. If the root is not a goal / is
  // archived, place it rootless (layer 1) — hanging it under an archived card would
  // hide it from the default view the moment it is born (same reason as the gate at
  // the top of add()).
  const toRoot = root && root.kind === "goal" && !root.archived_at ? Number(root.id) : null;
  const note = `⚠链深闸上浮卡: 原拟挂在 #${parentId} 之下(将成第 ${newDepth} 层)。` +
    `按裁定『目标→执行卡→必要后续 两层为限』,` +
    (toRoot ? `改挂到链根目标 #${toRoot} 直下` : `改为无父卡(链根)`) + `且**未放行**。`;
  return {
    parentId: toRoot, released: 0,
    description: note + "\n\n" + String(description || ""),
    uplifted: { from: Number(parentId), to: toRoot, wouldBeDepth: newDepth },
  };
}

/**
 * ⭐ Shell / inner split (the shape every mutation with an event uses): the shell owns
 * the transaction and the event, the inner keeps the business logic untouched. The row
 * change and its history entry commit TOGETHER or not at all — separately, an
 * interruption in between leaves "the state moved but the record never says so".
 */
function add(db, args) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const id = addInner(db, args);
    const t = db.prepare(
      "SELECT id, line, parent_id, status, kind, released FROM tasks WHERE id=?").get(id);
    appendEvent(db, {
      taskId: id, kind: "add", actor: args.actor || "system", detail: eventState(t),
    });
    db.exec("COMMIT");
    return id;
  } catch (e) { try { db.exec("ROLLBACK"); } catch {} throw e; }
}

function addInner(db, {
  subject, description = "", acceptance = "", blockedBy = [],
  route = DEFAULT_ROUTE, line = null, lockKey = null, needsBash = 0,
  released = 1, maxAttempts = 3, evidencePath = null,
  kind = "task", parentId = null, verifyCmd = null, weight = "standard",
  oneofKey = null, provesParent = false, humanGate = null,
}) {
  if (!["goal", "task"].includes(kind)) throw err(ERR.BAD_INPUT, "kind 必须是 goal 或 task");
  if (!subject || !String(subject).trim()) throw err(ERR.BAD_INPUT, "subject 不能为空");
  // Ruling-type cards default to human_gate=1 at creation. The real law is "the card
  // author gates explicitly"; this literal sniff is only the safety net (subjects
  // are a weak carrier and implementation cards mentioning rulings do trip it — but
  // the costs are asymmetric: a false positive costs one humanGate:false or one
  // edit, a false negative replays INCIDENT-5's authority fabrication, so we tip
  // toward over-gating). Explicit input always wins; ⭐ unknown values (the string
  // "true", etc.) fall on the REFUSAL side = gated (safety-gate polarity).
  const hg = humanGate == null
    ? (HUMAN_GATE_PATTERN.test(String(subject)) ? 1 : 0)
    : (humanGate === false || humanGate === 0 ? 0 : 1);
  // Parent validation at creation (the update path had it; this one didn't — a ghost
  // parent makes the lineage tag and family highlight lie from birth). A brand-new
  // card cannot be its own ancestor, so no cycle check is needed here.
  // Status codes follow the error-taxonomy contract: missing=NOT_FOUND /
  // archived=BAD_INPUT.
  if (parentId != null) {
    const pt = db.prepare("SELECT archived_at FROM tasks WHERE id=?").get(Number(parentId));
    if (!pt) throw err(ERR.NOT_FOUND, `父卡 ${parentId} 不存在`);
    if (pt.archived_at) throw err(ERR.BAD_INPUT, `#${parentId} 已归档,不能把新卡挂到它下面`);
  }
  // Chain depth is ruled HERE. Every creation path (worker loop / CLI / panel / any
  // future automation) goes through add(), so placing the rule here cannot regress
  // to "plugged one entrance". ⭐ Uplift, not refusal, is the ruling itself — the
  // discovery is kept, the queue is not hijacked.
  ({ parentId, released, description } = placeInChain(db, { kind, parentId, released, description }));
  const vk = assertVerify(verifyCmd);
  const r = db.prepare(
    `INSERT INTO tasks (subject, description, acceptance, blocked_by, created_at, updated_at,
                        route, line, lock_key, needs_bash, released, max_attempts, evidence_path,
                        kind, parent_id, verify_cmd, weight, oneof_key, proves_parent,
                        human_gate, human_gate_src)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(String(subject), String(description), String(acceptance),
        // Dep edges go through the SAME single validator as update (plugging only
        // one entrance is the classic hole — goal decomposition pours model-emitted
        // deps straight in here). selfId=null: the row doesn't exist yet, so
        // self-reference/cycles are impossible by construction.
        normalizeDeps(db, null, blockedBy), now(), now(),
        // ⚠ `String(route)` alone would turn `route: null` into the STRING "null"
        //   (destructuring defaults only apply to undefined ⇒ null never falls to
        //   the default). ⇒ same expression as the update side, so the two entrances
        //   cannot diverge. The value-set gate itself is the server's badRoutable
        //   (the store does not know LINES/ROUTES).
        String(route || DEFAULT_ROUTE), line ? String(line) : null, lockKey ? String(lockKey) : null,
        needsBash ? 1 : 0, released ? 1 : 0, Number(maxAttempts),
        evidencePath ? String(evidencePath) : null,
        String(kind), parentId == null ? null : Number(parentId), vk,
        // Same expression as route (`String(weight)` would let weight:null enter as
        // the string "null", never reaching NOT NULL DEFAULT — same trap shape).
        // Value-set gate is server-side.
        String(weight || "standard"),
        // Linked-closure declarations (default = "not declared" = no linkage).
        // ⭐ The default is the safe side.
        oneofKey ? String(oneofKey) : null, provesParent ? 1 : 0,
        // The lock and its source (sniffed = machine lock / explicit = deliberate
        // lock). Unknown values landed on explicit = human-only unlock.
        hg, hg ? (humanGate == null ? "detect" : "explicit") : null);
  return Number(r.lastInsertRowid);
}

/**
 * Atomic claim. Expired-lease reap + dependency check + route filter + lock
 * avoidance + race, all inside one write transaction.
 * Without route/line filtering, one line's worker grabs another line's cards —
 * adding columns without touching claim is not enough.
 */
/**
 * ⭐ STATE FINGERPRINT — the answer to "would this dispatch see anything new?"
 *
 * The board's existing brakes all act AFTER a model has been paid for: the lifetime
 * ceiling counts dispatches, the loop's failure-fingerprint breaker needs failures to
 * compare. Neither asks the cheaper question first. A bounced card returns to
 * not_started with a full budget (claim re-stamps the anchor), so an empty-handed
 * bounce buys another full run at the same card, in the same world, for the same
 * conclusion.
 *
 * Components are hashed SEPARATELY and assembled through JSON.stringify — never
 * joined with a separator, since any separator that can occur inside a description
 * is not a separator. Each is 16 hex chars: enough to make collision irrelevant here
 * (a collision costs one skipped dispatch, not a wrong answer) and small enough to
 * store per card.
 *
 *   card    the face a worker is asked to act on
 *   deps    the state of what it waits on — a dependency finishing IS new information
 *   ruling  everything a human or reviewer said back; an annotated bounce releases
 *           the brake, an empty-handed one does not. This is the component that
 *           makes the whole mechanism fair.
 *   tree    the repository the work lands in (caller-supplied: store stays pure)
 *   fail    how the last attempt failed, as reported by the loop
 *   extra   deployment-supplied (fleet.config `fingerprint_extra_cmd`) — the hook a
 *           private deployment uses for facts this repo has no business knowing
 *
 * ⚠ `attempts`, heartbeat, lease and timestamps are deliberately ABSENT. They change
 *   on every dispatch, which would make every fingerprint unique and the brake a
 *   no-op that still looks installed.
 */
const fpHash = (...parts) =>
  crypto.createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 16);

function stateFingerprint(db, t, opts = {}) {
  const deps = (() => {
    let ids = [];
    try { ids = JSON.parse(t.blocked_by || "[]"); } catch { ids = []; }
    if (!Array.isArray(ids) || !ids.length) return fpHash(null);
    const rows = ids.map((id) =>
      db.prepare("SELECT id, status, verdict FROM tasks WHERE id=?").get(Number(id)) || { id, status: "?", verdict: null });
    return fpHash(rows.map((r) => [r.id, r.status, r.verdict]));
  })();
  return {
    card: fpHash(t.subject, t.description, t.acceptance, t.verify_cmd, t.max_attempts,
                 t.human_gate, t.blocked_by, t.oneof_key, t.proves_parent),
    deps,
    // ⚠ `last_note`, NOT `verdict_note`: the latter is append-only with a timestamped
    //   header per entry, so it differs on every ruling even when the ruling is
    //   word-for-word the same — a brake reading it would never engage. (Measured:
    //   the first cut of this gate read verdict_note and held nothing.)
    // ⚠ The rule for what belongs in this component: **what the worker actually
    //   receives**. Checked against build_prompt — the prompt carries the ruling's
    //   tail and nothing else from the ruling side. So `result` is out (a worker
    //   never sees the previous delivery text) and so is `last_verdict` (it changes
    //   the prompt only through the note, which is already here). Including them
    //   made an empty-handed bounce look like new information, costing one wasted
    //   dispatch before the brake could engage.
    //   `|| null` folds "" into "never ruled": an empty ruling and no ruling produce
    //   the identical prompt, so they must produce the identical fingerprint.
    ruling: fpHash(t.last_note || null, t.decision_json, t.decision_choice,
                   t.decision_receipt),
    tree: fpHash(opts.treeRev ?? null),
    fail: fpHash(opts.failFp ?? null),
    extra: fpHash(opts.extra ?? null),
  };
}

/**
 * ⭐ REVIEW FINGERPRINT — "is this the same deliverable I already judged?"
 * Deliberately NOT the state fingerprint: a reviewer judges the delivery against the
 * acceptance criteria and the machine result, and nothing else on the card matters
 * to that judgment. `verify_at` is excluded for the same reason timestamps are
 * excluded from the dispatch fingerprint — it moves on every run and would make
 * every fingerprint unique.
 */
const reviewFingerprint = (t) =>
  fpHash(t.result, t.acceptance, t.verify_cmd,
         t.verify_ok == null ? null : Number(t.verify_ok));

/** Which components differ — this is what the panel shows as "why it may run now". */
function fpDiff(a, b) {
  if (!a || !b) return [];
  return ["card", "deps", "ruling", "tree", "fail", "extra"].filter((k) => a[k] !== b[k]);
}

/**
 * The brake itself. Returns null to let the card through, or the reason to hold it.
 * ⚠ Polarity: a card with NO recorded dispatch always passes, and an unparseable
 *   record passes too. This gate protects a budget, not a correctness invariant —
 *   an unreadable record must not strand a card forever. (The gates that protect
 *   correctness — source, deliverable, human — fail CLOSED; this one deliberately
 *   does not, for the same reason the v0.10 circuit breaker does not.)
 */
function noProgressHold(db, t, opts = {}) {
  if (!t.dispatch_fp) return null;
  let prev = null;
  try { prev = JSON.parse(t.dispatch_fp); } catch { return null; }
  if (!prev || typeof prev !== "object") return null;
  // ⭐ Re-read the RAW row. Callers hand this function two different shapes — claim
  //   passes a `SELECT *` row, the server passes a row() projection where blocked_by
  //   has already become a deps array and flags have changed type. Fingerprinting a
  //   projection produces a different hash for the identical card, so the panel said
  //   "not held" about a card the queue was refusing (measured). The fingerprint is
  //   defined over the stored row, so read the stored row.
  const raw = db.prepare("SELECT * FROM tasks WHERE id=?").get(Number(t.id)) || t;
  const cur = stateFingerprint(db, raw, opts);
  const changed = fpDiff(prev, cur);
  return changed.length ? null : { since: t.dispatch_fp_at || null, fp: cur };
}

/**
 * Which cards on this route/line the brake is currently holding. Used to answer an
 * empty claim with a REASON.
 * ⚠ House rule, already settled for the pool gate: "503 must not wear the same face
 *   as 204 — a starving fleet whose log says 'nothing to claim' gets no one asking
 *   why". A brake that silently empties the queue is the same failure: the line
 *   looks idle, the board looks quiet, and nothing says the queue is full of cards
 *   nobody will be paid to look at again.
 * Only rows that have been dispatched before are examined; on a board where the
 * brake has never fired this walks nothing.
 */
function heldByNoProgress(db, { route, line }, opts = {}) {
  const rows = db.prepare(
    `SELECT * FROM tasks WHERE status='not_started' AND released=1 AND archived_at IS NULL
       AND kind='task' AND dispatch_fp IS NOT NULL AND route=? AND (line IS NULL OR line=?)`
  ).all(String(route ?? DEFAULT_ROUTE), String(line ?? ""));
  return rows.filter((t) => noProgressHold(db, t, opts)).map((t) => Number(t.id));
}

function claim(db, worker, leaseMin = DEFAULT_LEASE_MIN, opts = {}) {
  if (!worker) throw err(ERR.BAD_INPUT, "worker 不能为空");
  const route = opts.route || DEFAULT_ROUTE;
  const line = opts.line || String(worker);
  db.exec("BEGIN IMMEDIATE");
  try {
    // Reap dead workers' cards (heartbeat cleared too, so the panel can't misread
    // them as alive). Span close happens inside the same transaction.
    for (const x of db.prepare(
      "SELECT id FROM tasks WHERE status='in_progress' AND lease_until IS NOT NULL AND lease_until < ?"
    ).all(Date.now())) spanClose(db, x.id);
    // ⭐ Calls the shared reaper instead of repeating its UPDATE: a second copy would
    //   have to grow the history entry a second time, and only one copy ever gets it.
    reapExpiredInner(db);

    // ⛔ The old full-table `SELECT id FROM tasks WHERE status='done'` is gone:
    //   depsSatisfied pulls only the dependency ids via IN (cheaper, and the
    //   definition of "done" stays in one place).
    const heldLocks = new Set(
      db.prepare("SELECT lock_key FROM tasks WHERE status='in_progress' AND lock_key IS NOT NULL")
        .all().map((r) => r.lock_key)
    );

    // ⭐ Parent gate (ruling: a card whose children are unfinished must not enter
    //   in_progress): measured, a parent with 0/2 children done was claimed and
    //   idle-burned to attempt 4/3. When all children are done, rearmDone carries
    //   the parent to waiting — the road where a worker grabs the parent first is
    //   closed STRUCTURALLY (not by remembering to fill in blockedBy). The
    //   condition matches deferToRearm: "has a child with status<>'done'"
    //   (narrowing to not_started/in_progress would let waiting children slip the
    //   gap).
    const unfinishedKids = new Set(
      db.prepare(`SELECT DISTINCT parent_id FROM tasks
                   WHERE parent_id IS NOT NULL AND archived_at IS NULL AND status<>'done'`)
        .all().map((r) => Number(r.parent_id))
    );

    // ⭐ Children of a pinned goal come out first. When a human says "push THIS
    //   stream now", workers should pick from it — this is the single place where
    //   order obeys human intent. Multiple pins: newest first. Unpinned: id order,
    //   as before.
    // Pinning applies to the WHOLE lineage: with only direct parents consulted, on
    // measured 7-deep chains the pinned goal's grandchildren get no priority and
    // "run this stream first" is a lie.
    const cands0 = db.prepare(
      `SELECT t.* FROM tasks t
        WHERE t.status='not_started' AND t.released=1 AND t.archived_at IS NULL
          AND t.kind='task'
          AND t.attempts < t.max_attempts * ${LIFETIME_DISPATCH_CAP}   -- ⭐ lifetime ceiling (budget-caliber ruling)
          -- Old shape ("attempts < max_attempts") applied the per-dispatch budget to
          -- the lifetime total: a bounced card never came out again (or parked after
          -- one shot). The per-dispatch budget refills via the anchor re-stamp in
          -- the UPDATE below, so all that belongs here is the lifetime ceiling
          -- (rationale and the number live at LIFETIME_DISPATCH_CAP).
          AND t.human_gate=0   -- ⭐ human-gated pre-filter: cards waiting on a human never enqueue, attempts never burn
          AND t.route=? AND (t.line IS NULL OR t.line=?)
        ORDER BY t.id`
    ).all(String(route), String(line));

    // ⭐ WIP cap: in-flight count per root chain (all lines combined); count once,
    //   then look up per candidate.
    const wipByRoot = new Map();
    for (const r of db.prepare("SELECT id FROM tasks WHERE status='in_progress'").all()) {
      const rt = rootOf(db, r.id);
      wipByRoot.set(rt, (wipByRoot.get(rt) || 0) + 1);
    }

    const cands = cands0
      .map((t) => ({ ...t, pin: pinnedAncestor(db, t.parent_id) }))
      .sort((a, b) => (a.pin == null) - (b.pin == null)
                   || String(b.pin || "").localeCompare(String(a.pin || ""))
                   || a.id - b.id);

    const pick = cands.find((t) => {
      if (t.lock_key && heldLocks.has(t.lock_key)) return false;  // lock held -> skip to next candidate
      if (unfinishedKids.has(Number(t.id))) return false;         // parent gate: children unfinished
      if (unreleasedAncestor(db, t.parent_id) != null) return false;  // ⭐ ancestor-release invariant
      if ((wipByRoot.get(rootOf(db, t.id)) || 0) >= WIP_PER_ROOT) return false;  // ⭐ WIP cap
      // ⭐ No-progress brake: nothing about this card has changed since the dispatch
      //   that produced nothing. Skipping here is what makes it free — one line
      //   further down, `attempts` has already been spent.
      if (noProgressHold(db, t, opts)) return false;
      return depsSatisfied(db, t).ok;   // broken blocked_by falls on the REFUSAL side
    });
    if (!pick) { db.exec("COMMIT"); return null; }

    // ⭐ A claim = a new dispatch = a new budget. The anchor (attempts_base) is
    //   re-stamped HERE.
    //   ⚠ SQLite evaluates every SET right-hand side against the PRE-update row ⇒
    //     `attempts_base=attempts` stores the value BEFORE the +1. So right after a
    //     claim, this dispatch has used 1 (claim counts as round one). Reordering
    //     the two assignments would not change meaning; `attempts+1` is written
    //     first to show the reader the before/after.
    // ⭐ Fingerprint of the world THIS dispatch is going out into, computed from the
    //   pre-update row. The next claim compares against it; identical means this
    //   dispatch would see exactly what the last one saw.
    const curFp = stateFingerprint(db, pick, opts);
    const dfp = JSON.stringify(curFp);
    // ⭐ WHY this dispatch was allowed, recorded at the moment it is allowed. A brake
    //   that silently lets things through is as hard to trust as one that silently
    //   holds them: the operator needs to see "this ran because the ruling changed",
    //   not just that it ran. Empty list = first dispatch, nothing to compare.
    const fpChanged = (() => {
      if (!pick.dispatch_fp) return [];
      try { return fpDiff(JSON.parse(pick.dispatch_fp), curFp); } catch { return []; }
    })();
    db.prepare(
      `UPDATE tasks SET status='in_progress', worker=?, lease_until=?, heartbeat_at=?,
                        attempts=attempts+1, attempts_base=attempts, waiting_for=NULL,
                        dispatch_fp=?, dispatch_fp_at=?,
                        last_runtime=COALESCE(?, last_runtime), updated_at=? WHERE id=?`
    ).run(String(worker), Date.now() + leaseMin * 60000, Date.now(), dfp, now(),
          opts.runtime ? String(opts.runtime) : null, now(), pick.id);
    spanOpen(db, pick.id, worker);
    {
      const claimed = db.prepare(
        "SELECT id, line, parent_id, status, kind, released FROM tasks WHERE id=?").get(pick.id);
      appendEvent(db, {
        taskId: pick.id, kind: "claim", actor: worker,
        detail: eventState(claimed, {
          // A line-less card is claimed BY a line; record which one actually took it,
          // or the history shows a card that belonged to nobody being worked on.
          line: claimed.line == null ? String(line) : String(claimed.line),
          runtime: opts.runtime ? String(opts.runtime) : null,
          // Which fingerprint components differ from the previous dispatch. Absent on
          // a first dispatch — "nothing to compare" and "nothing changed" must not
          // read alike, and one of them can never happen (a claim with nothing
          // changed is exactly what the brake refuses).
          ...(pick.dispatch_fp ? { fp_changed: fpChanged } : {}),
        }),
      });
    }
    db.exec("COMMIT");
    // ⚠ If pick-a-card and claim-by-id return DIFFERENT shapes, callers must learn a
    //   reading per endpoint (measured: only /api/claim lacked `status`, and a check
    //   reported "never entered in_progress"). Same name, same shape; going through
    //   row() means new columns ride along automatically.
    return { ...get(db, Number(pick.id)), lease_minutes: leaseMin };
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch {}
    throw e;
  }
}

/**
 * Return lease-expired cards to not_started. A function of its own so it can run
 * INDEPENDENTLY of claim.
 * ⚠ Reaping only inside claim means "while nobody comes for work, cards stay
 *   in_progress forever". Recovery must not depend on someone happening to ask
 *   (measured: a card whose worker was killed squatted in in_progress for 21
 *   minutes with no road back).
 */
function reapExpired(db) {
  db.exec("BEGIN IMMEDIATE");
  let n = 0;
  try {
    for (const x of db.prepare(
      "SELECT id FROM tasks WHERE status='in_progress' AND lease_until IS NOT NULL AND lease_until < ?"
    ).all(Date.now())) spanClose(db, x.id);
    n = reapExpiredInner(db);
    db.exec("COMMIT");
  } catch (e) { try { db.exec("ROLLBACK"); } catch {} throw e; }
  return n;
}
function reapExpiredInner(db) {
  // Read the victims BEFORE the update: the event has to carry who was holding the
  // card, and after the UPDATE that name is gone.
  const doomed = db.prepare(
    `SELECT id, line, parent_id, status, kind, released, worker FROM tasks
      WHERE status='in_progress' AND lease_until IS NOT NULL AND lease_until < ?`).all(Date.now());
  // ⭐ The dispatch fingerprint is CLEARED here. A reaped card never reported back,
  //   so "the last dispatch saw this same world and concluded nothing new" is not a
  //   claim we can make about it — the last dispatch may have died before reading
  //   anything. A crash is grounds for another go; a considered no-progress return
  //   is not.
  const r = db.prepare(
    `UPDATE tasks SET status='not_started', worker=NULL, lease_until=NULL, heartbeat_at=NULL,
                      dispatch_fp=NULL, dispatch_fp_at=NULL, updated_at=?
      WHERE status='in_progress' AND lease_until IS NOT NULL AND lease_until < ?`
  ).run(now(), Date.now());
  for (const t of doomed) {
    appendEvent(db, {
      taskId: t.id, kind: "reap", actor: "lease-reaper",
      detail: eventState({ ...t, status: "not_started" }, {
        from_status: "in_progress", previous_worker: t.worker || null,
      }),
    });
  }
  return Number(r.changes || 0);
}

/**
 * Claim a SPECIFIC id. claim() picks "the next card that should go out" and ignores
 * ids — a by-id name over pick-a-card behavior makes callers occupy a different card
 * without noticing (measured: meant to take one card, occupied another, dirtied
 * three live cards).
 * Passes ALL the same gates as claim. On refusal, it names WHAT blocked it —
 * a bare "couldn't take it" hides whether it was release, deps, or a lock.
 */
function claimById(db, { id, worker, leaseMin = DEFAULT_LEASE_MIN, runtime = null,
                         force = false, treeRev = null, extra = null }) {
  if (!worker) throw err(ERR.BAD_INPUT, "worker 不能为空");
  db.exec("BEGIN IMMEDIATE");
  try {
    const t = db.prepare("SELECT * FROM tasks WHERE id=?").get(Number(id));
    // ⭐ Refusal reasons carry a TYPE too. claimById declines via return value, not
    //   throw, so without a code here the server could only blanket-409 (it did:
    //   claiming a missing id was the one 409 while GET gave 404 and other write
    //   endpoints 400).
    const no = (why, code = ERR.CONFLICT) => { db.exec("COMMIT"); return { ok: false, why, code }; };
    if (!t) return no(`任务 ${id} 不存在`, ERR.NOT_FOUND);
    if (t.kind === "goal") return no(`#${id} 是目标,目标不能被认领`);
    if (t.archived_at) return no(`#${id} 已归档`);
    if (t.status !== "not_started") return no(`#${id} 现在是 ${t.status}(持有者 ${t.worker || "-"}),不是未开始`);
    if (!Number(t.released)) return no(`#${id} 未放行`);
    // Same judgment as claim. Broken ⇒ refuse WITH the reason (never treat as
    // zero-dependency).
    const ds = depsSatisfied(db, t);
    if (ds.broken)
      return no(`#${id} 的 blocked_by 在库里解析不出来 —— 拒绝领取(不当作零依赖)`, ERR.BAD_INPUT);
    if (!ds.ok) return no(`#${id} 依赖未完成: #${ds.pending.join(" #")}`);
    if (t.lock_key) {
      const held = db.prepare(
        "SELECT id FROM tasks WHERE status='in_progress' AND lock_key=? AND id<>?"
      ).get(t.lock_key, Number(id));
      if (held) return no(`#${id} 的锁 ${t.lock_key} 正被 #${held.id} 占用`);
    }
    // ⭐ Lifetime ceiling (same criterion as claim's SQL gate). Refuse by name.
    if (Number(t.attempts) >= lifetimeCap(t))
      return no(`#${id} 生涯尝试上限已尽(累计 ${t.attempts} 次 ≥ ${lifetimeCap(t)} = ` +
                `max_attempts ${t.max_attempts} × 派发轮数上限 ${LIFETIME_DISPATCH_CAP})—— ` +
                `本轮预算不是问题(每次认领都回满),是这张卡已经烧掉太多轮: ` +
                `需人工拆分卡、补齐前提或编辑卡提高上限`);
    // Parent gate (same ruling). Not even by name — refuse and say why.
    const kids = db.prepare(
      `SELECT id FROM tasks WHERE parent_id=? AND archived_at IS NULL AND status<>'done'`
    ).all(Number(id)).map((x) => Number(x.id));
    if (kids.length)
      return no(`#${id} 有未完成子任务: #${kids.join(" #")} —— 子任务全部完成后再认领`);
    // ⭐ Human-gated pre-filter: a card waiting on a human is refused even by name —
    //   its attempts must not burn at all.
    if (Number(t.human_gate))
      return no(`#${id} 是 human-gated(待人工裁定)—— 人裁定后自动开闸,或 update humanGate=0 显式开`);
    // ⭐ Ancestor-release invariant: an unreleased ancestor blocks all descendants.
    const ua = unreleasedAncestor(db, t.parent_id);
    if (ua != null)
      return no(`#${id} 的祖先 #${ua} 未放行 —— 先放行祖先(release ${ua})或改挂链`);
    // ⭐ WIP cap: when the root chain is at the cap, no queue-jumping even by name.
    const rt = rootOf(db, Number(id));
    const wip = db.prepare("SELECT id FROM tasks WHERE status='in_progress'").all()
      .map((r) => Number(r.id)).filter((rid) => rootOf(db, rid) === rt);
    if (wip.length >= WIP_PER_ROOT)
      return no(`根 #${rt} 的在途卡已达 WIP 上限 ${WIP_PER_ROOT}(在途: #${wip.join(" #")})—— 等在途结清再领`);
    // ⭐ No-progress brake, by name and with the way out. `force` is the deliberate
    //   override — a human saying "run it anyway", which IS a reason, unlike a timer
    //   firing. It is a parameter and not a silent exception because a door that
    //   quietly skips the gate is the gate's failure mode.
    const npOpts = { treeRev, extra };
    const hold = force ? null : noProgressHold(db, t, npOpts);
    if (hold)
      return no(`#${id} 自上次派发(${hold.since || "?"})以来状态没有变化 —— 拒绝重复调用模型。` +
                `要让它再跑,给它新的输入(补充卡面/写裁定意见/推进依赖/更新工作树),` +
                `或显式强制(force)`);
    // Anchor re-stamp in the SAME shape as claim (so the calibers cannot split
    // between the two doors; SQLite right-hand sides are evaluated on the
    // pre-update row — details at claim's identical UPDATE).
    const curFp = stateFingerprint(db, t, npOpts);
    const dfp = JSON.stringify(curFp);
    const fpChanged = (() => {
      if (!t.dispatch_fp) return [];
      try { return fpDiff(JSON.parse(t.dispatch_fp), curFp); } catch { return []; }
    })();
    db.prepare(
      `UPDATE tasks SET status='in_progress', worker=?, lease_until=?, heartbeat_at=?,
                        attempts=attempts+1, attempts_base=attempts, waiting_for=NULL,
                        dispatch_fp=?, dispatch_fp_at=?,
                        last_runtime=COALESCE(?, last_runtime), updated_at=? WHERE id=?`
    ).run(String(worker), Date.now() + leaseMin * 60000, Date.now(), dfp, now(),
          runtime ? String(runtime) : null, now(), Number(id));
    spanOpen(db, Number(id), worker);
    {
      const claimed = db.prepare(
        "SELECT id, line, parent_id, status, kind, released FROM tasks WHERE id=?").get(Number(id));
      appendEvent(db, {
        taskId: Number(id), kind: "claim", actor: worker,
        detail: eventState(claimed, {
          line: claimed.line == null ? String(worker) : String(claimed.line),
          runtime: runtime ? String(runtime) : null,
          // Same record as the queue door, plus the one thing only this door can
          // say: that a person overrode the brake. "Ran anyway, on purpose" has to
          // be distinguishable in the history from "ran because something changed".
          ...(t.dispatch_fp ? { fp_changed: fpChanged, ...(force ? { forced: true } : {}) } : {}),
        }),
      });
    }
    db.exec("COMMIT");
    return { ok: true, task: get(db, Number(id)) };
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch {}
    throw e;
  }
}

/** Return every in-flight card a line holds to not_started. Called right after
 *  killing a worker — no reason to make the board wait 30 minutes for a lease to
 *  expire when the kill was OUR OWN act. */
function releaseHeldBy(db, worker) {
  const rows = db.prepare(
    "SELECT id, line, parent_id, status, kind, released FROM tasks WHERE status='in_progress' AND worker=?"
  ).all(String(worker));
  if (!rows.length) return [];
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const r of rows) spanClose(db, r.id);
    db.prepare(
      // dispatch_fp cleared for the same reason as the reaper: a card handed back
      // without a report never produced the judgment the brake would be honoring.
      `UPDATE tasks SET status='not_started', worker=NULL, lease_until=NULL, heartbeat_at=NULL,
                        dispatch_fp=NULL, dispatch_fp_at=NULL, updated_at=?
        WHERE status='in_progress' AND worker=?`
    ).run(now(), String(worker));
    // ⚠ Same `release` kind as a hold/release of the RELEASED flag; the two are told
    //   apart by detail.action / detail.from_status. Splitting them into two kinds
    //   would fork every reader, so the disambiguation lives in the detail.
    for (const t of rows) appendEvent(db, {
      taskId: t.id, kind: "release", actor: worker,
      detail: eventState({ ...t, status: "not_started" }, {
        action: "release_held", from_status: "in_progress",
      }),
    });
    db.exec("COMMIT");
  } catch (e) { try { db.exec("ROLLBACK"); } catch {} throw e; }
  return rows.map((r) => Number(r.id));
}

/** Heartbeat = liveness report + lease renewal. Without it the panel cannot tell
 *  "working" from "dead but lease not yet expired". */
function heartbeat(db, { id, worker, leaseMin = DEFAULT_LEASE_MIN }) {
  const t = db.prepare("SELECT * FROM tasks WHERE id=?").get(Number(id));
  if (!t) throw err(ERR.NOT_FOUND, `任务 ${id} 不存在`);
  if (t.status !== "in_progress") throw err(ERR.CONFLICT, `任务 ${id} 状态是 ${t.status},不是 in_progress`);
  if (t.worker !== String(worker)) throw err(ERR.CONFLICT, `任务 ${id} 的持有者是 ${t.worker},不是 ${worker}`);
  // ⭐ Leases only move FORWARD. Default parameters only kick in on `undefined`, so a
  //   raw `lease_minutes: 0` (or negative, or NaN) passing through would set
  //   `lease_until = now` — and the next reaper sweep takes the card away from a
  //   LIVE, HEARTBEATING worker. A call meant to extend life would kill the card.
  //   ⚠ The claim path had `|| DEFAULT` server-side while heartbeat passed raw =
  //   two policies for the same field.
  const mins = Number(leaseMin) > 0 ? Number(leaseMin) : DEFAULT_LEASE_MIN;
  // ⚠ Take the time ONCE. The old version called Date.now() separately for write and
  //   return, so the returned heartbeat_at differed from the DB by a few ms — an API
  //   returning something other than what it wrote.
  const ts = Date.now();
  db.prepare("UPDATE tasks SET heartbeat_at=?, lease_until=?, updated_at=? WHERE id=?")
    .run(ts, ts + mins * 60000, now(), Number(id));
  // ⭐ Return the card itself. Of the five write endpoints this was the only
  //   projection, with neither `status` nor `lease_until` ⇒ callers had to re-GET
  //   to learn "did it extend, until when".
  //   ⚠ The existing `id` / `heartbeat_at` keys STAY (adding breaks nobody). The
  //     worker loop's heartbeat thread looks only at the status code, so removing
  //     the projection would be needless risk. (No line numbers here — a written
  //     one had already rotted; find it with `grep -n "/heartbeat" loops/worker_loop.py`.)
  return { id: Number(id), heartbeat_at: ts, task: get(db, Number(id)) };
}

/**
 * Deliver. **There is no "blocked" ending** (four-value state machine).
 *   outcome='done' -> waiting/review   (awaiting acceptance)
 *   outcome='wait' -> waiting/decision (own attempts exhausted; the reason goes in
 *                                       evidence)
 */
function report(db, { id, worker, outcome, evidence = "" }) {
  if (!["done", "wait"].includes(outcome)) throw err(ERR.BAD_INPUT, "outcome 必须是 done 或 wait");
  const t = db.prepare("SELECT * FROM tasks WHERE id=?").get(Number(id));
  if (!t) throw err(ERR.NOT_FOUND, `任务 ${id} 不存在`);
  if (t.status !== "in_progress") throw err(ERR.CONFLICT, `任务 ${id} 状态是 ${t.status},不是 in_progress,不能交付`);
  if (t.worker !== String(worker)) throw err(ERR.CONFLICT, `任务 ${id} 的持有者是 ${t.worker},不是 ${worker}`);
  // ⭐ Span close and state transition share ONE transaction (measured concern: split
  //   in two, a crash in between leaves "in_progress but span closed" — a torn state).
  const waitingFor = outcome === "done" ? "review" : "decision";
  db.exec("BEGIN IMMEDIATE");
  try {
    spanClose(db, Number(id));
    db.prepare(
      `UPDATE tasks SET status='waiting', waiting_for=?, result=?, lease_until=NULL, updated_at=? WHERE id=?`
    ).run(waitingFor, String(evidence), now(), Number(id));
    appendEvent(db, {
      taskId: Number(id), kind: "report", actor: worker,
      detail: eventState({ ...t, status: "waiting" }, {
        outcome: String(outcome), waiting_for: waitingFor,
      }),
    });
    db.exec("COMMIT");
  } catch (e) { try { db.exec("ROLLBACK"); } catch {} throw e; }
  return { id: Number(id), status: "waiting", waiting_for: waitingFor };
}

/**
 * Linked closure (ruling: "one path through, no extra ceremony"). Closes the cards
 * a success makes unnecessary:
 *   ① siblings under the same parent sharing `oneof_key` = alternatives ⇒ close
 *   ② a child with `proves_parent` passed ⇒ the parent closes with it
 * ⭐ The trigger is MACHINE GREEN ONLY (verify_ok=1). approve never triggers —
 *   measured: the real meaning of approve is "nobody objected", the weakest possible
 *   grounds for closing someone else's card.
 * ⚠ **in_progress is NEVER touched.** Closing a running card from the side leaves
 *   its worker's output with nowhere to land — a silent loss. Mark it loudly and let
 *   the ruling close it after the worker returns.
 * ⚠ Linkage is ONE step (up to the parent), never further. A chain with no way to
 *   stop propagation turns one mistaken declaration into a board-wipe (same reason
 *   the derivation gate stops at two layers).
 */
function cascadeClose(db, t, proofNote) {
  const out = { closed: [], parent: null, deferred: [] };
  const closeOne = (row, why) => {
    if (row.status === "in_progress") {
      // Running: leave the state alone, stamp ONLY a mark. The point is loudness
      // (not silent disappearance).
      db.prepare(`UPDATE tasks SET verdict_note=?, updated_at=? WHERE id=?`)
        .run([String(row.verdict_note || "").trim(),
              `—— 联动提示(${now()})——`, why + "(本卡正在进行中,不动它 —— 收工后由裁定关闭)"]
             .filter(Boolean).join("\n\n"), now(), row.id);
      out.deferred.push(row.id);
      return;
    }
    db.prepare(
      `UPDATE tasks SET status='done', verdict='approve', last_verdict='approve',
                        resolved_by='cascade', resolved_at=?, waiting_for=NULL, worker=NULL,
                        lease_until=NULL, heartbeat_at=NULL, verdict_note=?, updated_at=? WHERE id=?`
    ).run(now(), [String(row.verdict_note || "").trim(),
                  `—— 联动结案(${now()})——`, why].filter(Boolean).join("\n\n"), now(), row.id);
    out.closed.push(row.id);
  };

  // ① The alternatives group (same parent, same key). parent null on both sides
  //   counts as "same parent".
  if (t.oneof_key) {
    const sibs = db.prepare(
      `SELECT * FROM tasks WHERE oneof_key=? AND id<>? AND archived_at IS NULL
         AND status<>'done'
         AND ((parent_id IS NULL AND ? IS NULL) OR parent_id=?)`
    ).all(String(t.oneof_key), Number(t.id),
          t.parent_id == null ? null : Number(t.parent_id),
          t.parent_id == null ? -1 : Number(t.parent_id));
    for (const sb of sibs)
      closeOne(sb, `#${t.id} 走通了同一组备选(oneof=${t.oneof_key}),本卡不必再做。${proofNote}`);
  }

  // ② Parent linkage (only when the child DECLARED it answers the parent's question)
  if (Number(t.proves_parent) === 1 && t.parent_id != null) {
    const par = db.prepare("SELECT * FROM tasks WHERE id=?").get(Number(t.parent_id));
    if (par && !par.archived_at && par.status !== "done") {
      closeOne(par, `子卡 #${t.id} 的验证通过,即回答了本卡的问题(proves_parent)。${proofNote}`);
      out.parent = par.id;
    }
  }
  return out;
}

/**
 * Upper-level ruling. The destination has THREE roads:
 *   human wrote nothing + approve -> done
 *   human wrote nothing + reject  -> not_started (back to its original line)
 *   ⭐ human wrote ANYTHING (approve or reject) -> not_started, ORIGINAL line kept.
 *      Human text is an INSTRUCTION, not an opinion; close the card and nobody is
 *      left to execute it (measured: choosing option A and pressing "approve"
 *      closed the card and left A hanging in the air).
 *      ⭐ Destination is the original line, not the coordinator: the original worker
 *      holds the context; routing to the coordinator forces a full context rebuild
 *      = double burn (usage audit: three cards re-ran in the coordinator seat 3-4
 *      times each).
 * Auto-review notes (resolvedBy='auto') are machine observations, not instructions.
 * attempts was already counted at claim; not touched here. Ruling records are
 * APPENDED, never overwritten.
 */
function resolve(db, args) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const before = db.prepare(
      "SELECT id, line, parent_id, status, kind, released FROM tasks WHERE id=?").get(Number(args.id));
    const out = resolveInner(db, args);
    const t = db.prepare(
      "SELECT id, line, parent_id, status, kind, released FROM tasks WHERE id=?").get(Number(args.id));
    appendEvent(db, {
      taskId: args.id, kind: "resolve", actor: args.resolvedBy || "human",
      detail: eventState(t, {
        from_status: before ? before.status : null,
        verdict: String(args.verdict),
        disposition: out.status === "done" ? "close"
          : out.status === "waiting" ? "hold_for_review" : "hand_back",
      }),
    });
    // A linked closure is a state transition caused by this ruling too — each closed
    // card gets its OWN history entry, or its close has no record on its own timeline.
    for (const cid of out.cascade?.closed || []) {
      const ct = db.prepare(
        "SELECT id, line, parent_id, status, kind, released FROM tasks WHERE id=?").get(Number(cid));
      appendEvent(db, {
        taskId: cid, kind: "resolve", actor: "cascade",
        detail: eventState(ct, { from_status: null, verdict: "approve", cause_task_id: Number(args.id) }),
      });
    }
    db.exec("COMMIT");
    return out;
  } catch (e) { try { db.exec("ROLLBACK"); } catch {} throw e; }
}

function resolveInner(db, { id, verdict, note = "", resolvedBy = "human", verifyOk = undefined,
                       selectedOption = null, sqlArchive = null,
                       disposition = null, sqlReceipt = null }) {
  if (!["approve", "reject"].includes(verdict)) throw err(ERR.BAD_INPUT, "verdict 必须是 approve 或 reject");
  const t = db.prepare("SELECT * FROM tasks WHERE id=?").get(Number(id));
  if (!t) throw err(ERR.NOT_FOUND, `任务 ${id} 不存在`);
  if (t.status !== "waiting") throw err(ERR.CONFLICT, `任务 ${id} 状态是 ${t.status},没有待裁定的产出`);
  const said = String(note || "").trim();

  // ⭐ If the caller declares a disposition, that wins; undeclared falls back to the
  //   legacy criterion verbatim (existing callers — CLI, reviewer, panel, all
  //   harnesses — pass none, so their destinations are letter-for-letter unchanged).
  const disp = assertDisposition(disposition) || legacyDisposition({ verdict, note, resolvedBy });
  //   ⚠ handBack is derived from disp, not deleted — the merged text and the
  //     handed_back return field use it. Restoring it as an independent computation
  //     would let the record print the LIE "continuing on original line" on a card
  //     that never went back.
  const handBack = disp === "hand_back";
  const next = disp === "close" ? "done" : disp === "hand_back" ? "not_started" : "waiting";

  // Ruling records are NEVER overwritten. One human letter erasing the reviewer's
  // A/B/C means nobody can later know what "A" was (measured: it got erased).
  // Append.
  const merged = said
    ? [String(t.verdict_note || "").trim(),
       `—— ${resolvedBy === "human" ? "你的决定" : "自动审阅"}(${now()} · ` +
       `${verdict === "approve" ? "通过" : "打回"}` +
       `${disp === "hand_back" ? " · 回原线继续" : disp === "hold_for_review" ? " · 留在等待中交审阅" : ""})——`,
       said].filter(Boolean).join("\n\n")
    : String(t.verdict_note || "");

  // ⭐ The two columns say DIFFERENT things (verdict-caliber ruling).
  //   `verdict`      = the closing result. A non-closing ruling (hand-back/bounce)
  //                    RESETS it to NULL — left written, "not_started yet approved"
  //                    cards appear (measured: 8).
  //   `last_verdict` = what was pressed this round. Survives without closing.
  //   ⚠ next==='done' is true only for "approve AND the human wrote nothing". An
  //     annotated approve is a hand-back, not a result — "the last vote is not the
  //     outcome" is this one line.
  const closingVerdict = next === "done" ? String(verdict) : null;
  // ⭐ Written as ONE blob (not split into columns): split, you can construct the
  //   torn state "this round's outcome + last round's receipt". The `files` keys
  //   arrive VERBATIM from decision_lib.archiveOptionFiles ({name, sha256, status, target}) —
  //   no hand-rolled aliases.
  const receiptJson = sqlReceipt == null ? null : JSON.stringify(sqlReceipt);
  db.prepare(
    `UPDATE tasks SET status=?, verdict_note=?, last_note=?, verdict=?, last_verdict=?,
                      -- hold_for_review = "enter the review queue carrying the human ruling".
                      -- 'review' is an existing value (in the WAITING_FOR allowlist;
                      -- rearmDone uses the same combination) ⇒ no new state invented.
                      waiting_for=CASE WHEN ?='waiting' THEN 'review' ELSE NULL END,
                      -- ⭐ Set NULL (do not compare timestamps): pendingReview picks up
                      --   auto_review_at IS NULL unconditionally, whereas comparing two
                      --   timestamps minted near the same now() silently skips the
                      --   rounds where they come out equal.
                      auto_review_at=CASE WHEN ?='waiting' THEN NULL ELSE auto_review_at END,
                      -- Same pairing as rearmDone: a ruling that puts the card back
                      -- into the review queue must also drop the dedup mark, or the
                      -- filter silently cancels the send-back.
                      review_fp=CASE WHEN ?='waiting' THEN NULL ELSE review_fp END,
                      resolved_by=?,
                      decision_choice=?, decision_sql_archive=?,
                      decision_receipt=CASE WHEN ? IS NULL THEN decision_receipt ELSE ? END,
                      resolved_at=CASE WHEN ?='done' THEN ? ELSE resolved_at END,
                      worker=CASE WHEN ?='not_started' THEN NULL ELSE worker END,
                      -- Layered unlock: a human ruling removes every lock; an auto
                      -- ruling removes only the machine's own lock (src='detect').
                      human_gate=CASE WHEN ?='human' THEN 0
                                      WHEN ?='auto' AND human_gate_src='detect' THEN 0
                                      ELSE human_gate END,
                      human_gate_src=CASE WHEN ?='human' THEN NULL
                                          WHEN ?='auto' AND human_gate_src='detect' THEN NULL
                                          ELSE human_gate_src END,
                      lease_until=NULL, heartbeat_at=NULL, updated_at=? WHERE id=?`
  ).run(next, merged, said, closingVerdict, String(verdict),
        // three `next` in a row: waiting_for CASE, auto_review_at CASE, review_fp CASE
        next, next, next, String(resolvedBy),
        selectedOption == null ? null : String(selectedOption),
        sqlArchive == null ? null : JSON.stringify(sqlArchive),
        receiptJson, receiptJson,
        next, now(),
        next,
        String(resolvedBy), String(resolvedBy),
        String(resolvedBy), String(resolvedBy),
        now(), Number(id));
  // ⭐ Layered human_gate unlock (ruling: "auto review should not be absolutely barred
  //   from opening for a human" — the old law was human-only): a human ruling
  //   removes all locks / an auto ruling removes only src='detect' (the literal
  //   sniff = the machine's lock). 'explicit' (deliberately placed) stays
  //   human-only — the INCIDENT-5 wall is only needed on that one branch. A card a
  //   human already ruled on must not keep its gate, or workers wait forever for a
  //   decision that was already given.
  // ⭐ max_attempts is NOT touched here.
  //   The competing patch topped it up on annotated resolve
  //   (`max_attempts=MAX(max_attempts, attempts+1)`) — ① that IS the "bounced cards
  //   get exactly one more shot" symptom; ② the ceiling inflates chasing the
  //   lifetime total (a 6/3 card next gets max=7) — the budget dragged around by
  //   the data. Now the claim re-stamp refills the budget to full on every
  //   re-claim; the top-up concept is simply unnecessary.
  //   ⚠ attempts is not touched either — lifetime totals never decrease.
  // ⭐ MEASURE the linkage precondition: record only when the ruler declares "I ran
  //   the verify just now and it was green", and only then link. No declaration ⇒
  //   stays null ⇒ no linkage (safe default).
  if (verifyOk !== undefined && verifyOk !== null)
    db.prepare("UPDATE tasks SET verify_ok=?, verify_at=?, updated_at=? WHERE id=?")
      .run(verifyOk ? 1 : 0, now(), now(), Number(id));

  // ⭐ Consumption: once any non-hold ruling passes, that receipt is no longer input
  //   for the next review. ⚠ NOT deleted (records stay) — only consumed_at is
  //   stamped; the fact that something was executed in production cannot be erased.
  //   Polarity: over-consuming ⇒ the gate misses fires ⇒ today's behavior; under-
  //   consuming ⇒ the gate over-fires and drops an approve to reject ⇒ hand-back.
  //   BOTH directions land on "no wrongful closure".
  if (disp !== "hold_for_review") {
    const cur = db.prepare("SELECT decision_receipt FROM tasks WHERE id=?").get(Number(id));
    let dr = null;
    try { dr = cur && cur.decision_receipt ? JSON.parse(cur.decision_receipt) : null; } catch { dr = null; }
    if (dr && !dr.consumed_at) {
      dr.consumed_at = now();
      db.prepare("UPDATE tasks SET decision_receipt=? WHERE id=?")
        .run(JSON.stringify(dr), Number(id));
    }
  }

  let cascade = null;
  if (next === "done" && verifyOk === true) {
    const fresh = db.prepare("SELECT * FROM tasks WHERE id=?").get(Number(id));
    cascade = cascadeClose(db, fresh,
      `依据: 本卡的机器验证(${fresh.verify_cmd || "verify"})通过,裁定者=${resolvedBy}。`);
    if (!cascade.closed.length && !cascade.parent && !cascade.deferred.length) cascade = null;
  }
  return { id: Number(id), status: next, resolved_by: String(resolvedBy),
           verdict: String(verdict), handed_back: handBack,
           ...(cascade ? { cascade } : {}) };
}

/**
 * Self-retry number n. The loop re-runs the worker WITHOUT releasing the card, so
 * attempts never passes through claim and must be bumped here explicitly — otherwise
 * the panel shows "attempt 1/3" forever while reality is on round 3 (a false picture
 * is worse than none).
 * Returns the bumped count and the cap; the LOOP decides whether another try is
 * allowed.
 *
 * ⭐ Single-judgment ruling — the cap is judged in ONE place, the loop. This function
 *   returns numbers and never judges. (It used to also return
 *   `exhausted: n >= max_attempts`; option B, dropping it, won:)
 *
 *   ① The value was UNCONSUMABLE as shipped. The loop compares "the run that just
 *      FINISHED was round n"; `exhausted` was computed right after the bump — the
 *      round that has NOT yet run. Off by one: wired in naively, max=3 runs twice
 *      and parks, while the DB says attempts=3. The only thing left standing is the
 *      LIE "tried three times" (the lost round is invisible to everyone).
 *   ② The imagined benefit ("raising the cap mid-run takes effect instantly") was a
 *      road that cannot occur: update() refuses in_progress cards with CONFLICT
 *      (see the status check at the top of update in this file). You cannot change
 *      a running card's max_attempts from the board. ⇒ no reason to hold it twice.
 *
 *   max_attempts stays in the return. It is DATA, not judgment — the loop uses it
 *   for its next comparison (if the DB side moves through some path, the loop
 *   follows one round later).
 *   ⛔ Do not add judgments back here (exhausted / can_retry / done...). Nobody
 *      consumes them today so no red would ever show — until someone wires one in
 *      and ① happens.
 */
function bumpAttempt(db, { id, worker }) {
  const t = db.prepare("SELECT * FROM tasks WHERE id=?").get(Number(id));
  if (!t) throw err(ERR.NOT_FOUND, `任务 ${id} 不存在`);
  if (t.status !== "in_progress") throw err(ERR.CONFLICT, `任务 ${id} 状态是 ${t.status},不是 in_progress`);
  if (t.worker !== String(worker)) throw err(ERR.CONFLICT, `任务 ${id} 的持有者是 ${t.worker},不是 ${worker}`);
  db.prepare("UPDATE tasks SET attempts=attempts+1, updated_at=? WHERE id=?").run(now(), Number(id));
  const n = Number(t.attempts) + 1;
  // The anchor (attempts_base) does NOT move — this is round 2 or 3 of the SAME
  // dispatch. Return both calibers; the loop's budget judgment reads
  // attempts_this_claim. ⛔ No "exhausted" here (reasons ①② above; judgment lives in
  // the loop).
  return { id: Number(id), attempts: n, max_attempts: Number(t.max_attempts),
           attempts_base: Number(t.attempts_base || 0),
           attempts_this_claim: n - Number(t.attempts_base || 0) };
}

/**
 * Record that auto-review "looked but does not decide". Without this mark the same
 * card gets judged every cycle, burning money.
 * auto_review_at < updated_at ⇒ review AGAIN — if the card moved, the evidence
 * changed too.
 */
function markAutoReviewed(db, { id, note = "", decisionPackage = null }) {
  const t = db.prepare("SELECT * FROM tasks WHERE id=?").get(Number(id));
  if (!t) throw err(ERR.NOT_FOUND, `任务 ${id} 不存在`);
  // What was looked at and passed to a human moves to "confirm" — distinguishable
  // from untouched.
  db.prepare(`UPDATE tasks
                 SET auto_review_at=?, review_fp=?, verdict_note=?, waiting_for='confirm',
                     decision_json=?, decision_choice=NULL, decision_sql_archive=NULL
               WHERE id=?`)
    .run(now(), reviewFingerprint(t), String(note || t.verdict_note || ""),
         decisionPackage == null ? null : JSON.stringify(decisionPackage), Number(id));
  // ⭐ Consume here too: the A/B/C PACKAGE is being replaced, so an "executed" receipt
  //   against the old package is not input for the next review (same logic as
  //   NULLing decision_choice / decision_sql_archive). ⚠ The record itself stays —
  //   a production execution cannot be unhappened.
  let dr0 = null;
  try { dr0 = t.decision_receipt ? JSON.parse(t.decision_receipt) : null; } catch { dr0 = null; }
  if (dr0 && !dr0.consumed_at) {
    dr0.consumed_at = now();
    db.prepare("UPDATE tasks SET decision_receipt=? WHERE id=?").run(JSON.stringify(dr0), Number(id));
  }
  return { id: Number(id), auto_review_at: now() };
}

/**
 * ⭐ Auto-retreat: waiting/confirm cards holding unfinished children leave the human
 * confirmation queue for "rearm" (ruling). When all children are done, rearmDone
 * (below) sends them back to review — the two are complements, both conditioned on
 * "has a child with status<>'done'" (narrowing to not_started/in_progress drops
 * cards with WAITING children into the crack between the two rules).
 * Scope = waiting/**confirm** only. Does NOT extend to review/decision/dep (the
 * ruling's letter).
 */
function deferToRearm(db) {
  const NLJ = String.fromCharCode(10);
  const rows = db.prepare(
    `SELECT p.id FROM tasks p
      WHERE p.status='waiting' AND p.waiting_for='confirm' AND p.archived_at IS NULL
        AND EXISTS (SELECT 1 FROM tasks c WHERE c.parent_id=p.id
                      AND c.archived_at IS NULL AND c.status<>'done')`).all();
  const moved = [];
  for (const r of rows) {
    const kids = db.prepare(
      "SELECT id FROM tasks WHERE parent_id=? AND archived_at IS NULL AND status<>'done'")
      .all(Number(r.id)).map((x) => Number(x.id));
    // The condition is folded INTO the UPDATE (a child completing between SELECT and
    // UPDATE tips toward "don't retreat"; if they complete right after the retreat,
    // rearmDone sends it back next cycle = self-healing).
    const ch = db.prepare(
      `UPDATE tasks SET waiting_for='rearm',
                        verdict_note=COALESCE(verdict_note,'') || ?, updated_at=?
        WHERE id=? AND status='waiting' AND waiting_for='confirm'
          AND EXISTS (SELECT 1 FROM tasks c WHERE c.parent_id=tasks.id
                        AND c.archived_at IS NULL AND c.status<>'done')`
    ).run(NLJ + NLJ + "—— 子任务卡 #" + kids.join(" #") +
          " 未完 → 自动转入等待重审(子卡齐了会自动送回重审,人不用在确认队列里等它)——",
          now(), Number(r.id));
    if (ch.changes) moved.push(Number(r.id));
  }
  return moved;
}

/** Walk the parent chain upward looking for a PINNED goal. A pinned goal = "run this
 *  stream first"; consulting only the direct parent leaves deep descendants
 *  (measured chains reach 7) without priority — pinning in name only. */
function pinnedAncestor(db, parentId) {
  let cur = parentId, g = 0;
  while (cur != null && g++ < 32) {
    const r = db.prepare("SELECT parent_id, kind, pinned_at FROM tasks WHERE id=?").get(cur);
    if (!r) return null;
    if (r.kind === "goal" && r.pinned_at) return r.pinned_at;
    cur = r.parent_id;
  }
  return null;
}

/**
 * ⭐ Goal auto-completion / auto-reopen (ruling: "a finished goal must land in done,
 * with an explanatory record and results"). Goals never pass through claim/report,
 * so nobody sets them done — a goal whose descendants all finished used to squat in
 * the goal column (measured: one sat at 1/1 complete).
 *
 * Complete: ≥1 descendant and ALL done → status=done + machine-written completion
 * record into result.
 * Reopen: an auto-completed goal grows a non-done descendant (bounce / reopen /
 * newly hung) → back to not_started, with the reopen appended to the record. A
 * closed face with moving insides is the worst state.
 * Scope: resolved_by='auto' only (= it only reopens what it closed itself).
 */
function completeGoals(db) {
  const NLJ = String.fromCharCode(10);
  const changed = [];
  // ⭐ Archive-is-not-completion fix: `AND archived_at IS NULL` was REMOVED from the
  //   descendant enumeration. Archived children used to vanish from the completion
  //   check ⇒ archive one unfinished child and ① the goal auto-completes if the rest
  //   are done, ② it also vanishes from the reopen sweep so the goal never reopens.
  //   Nobody did it on purpose, but "archiving = a back door to completion" stood
  //   open (measured). ⛔ Do not put `archived_at IS NULL` back here — the back door
  //   returns with it.
  //   ⭐ Archiving means "no longer wanted", not "finished". So an archived
  //     UNFINISHED child BLOCKS completion (fail-closed). To move on: mark the child
  //     done, or detach it from the parent — both leave an explicit human trace.
  //     No silent road stays open.
  const kids_of = db.prepare("SELECT id FROM tasks WHERE parent_id=?");
  const subtree = (gid) => {
    // ⚠ seen: now that archived cards are walked too, a parent-child cycle would spin
    //   longer. Cycles should be impossible — but the board freezing when one exists
    //   anyway is not a price worth paying.
    const out = [], seen = new Set([Number(gid)]), stack = [Number(gid)];
    while (stack.length) {
      for (const r of kids_of.all(stack.pop())) {
        const id = Number(r.id);
        if (seen.has(id)) continue;
        seen.add(id); out.push(id); stack.push(id);
      }
    }
    return out;
  };
  const rowOf = db.prepare(
    "SELECT id, subject, status, resolved_by, updated_at, archived_at FROM tasks WHERE id=?");
  /** ⭐ Caliber-drift catch: card ids the completion definition NAMES that are not in
   *  the subtree. Measured: one goal's completion definition named a card whose
   *  parent was a different goal ⇒ the subtree check never saw it.
   *  ⚠ NOT used as a judgment — it also catches mere references ("same shape as
   *  #N"), so using it to block would keep goals open forever. It is LISTED in the
   *  completion record for human eyes only. */
  const namedOutside = (gid, ids) => {
    const t = db.prepare("SELECT description, acceptance FROM tasks WHERE id=?").get(gid);
    const txt = String((t && t.description) || "") + " " + String((t && t.acceptance) || "");
    const inTree = new Set(ids.map(Number)), seen = new Set(), out = [];
    for (const m of txt.matchAll(/#(\d+)/g)) {
      const id = Number(m[1]);
      if (id === Number(gid) || inTree.has(id) || seen.has(id)) continue;
      seen.add(id);
      const r = db.prepare("SELECT id, subject, status FROM tasks WHERE id=?").get(id);
      if (r) out.push(r);
    }
    return out.sort((a, b) => Number(a.id) - Number(b.id));
  };
  for (const g of db.prepare(
      "SELECT id FROM tasks WHERE kind='goal' AND status<>'done' AND archived_at IS NULL").all()) {
    const ids = subtree(g.id);
    // Zero children = NO GROUNDS for completion (not "all complete"). `every` is
    // vacuously true on an empty array; without this line a childless goal silently
    // goes done. ⛔ Do not delete.
    if (!ids.length) continue;
    const rows = ids.map((i) => rowOf.get(i));
    if (!rows.every((r) => r.status === "done")) continue;
    const nArch = rows.filter((r) => r.archived_at).length;
    const digest = rows.sort((a, b) => a.id - b.id).map((r) =>
      "#" + r.id + " " + String(r.subject).slice(0, 46) + " · " +
      (r.resolved_by === "auto" ? "自动通过" : r.resolved_by === "human" ? "手动通过" : (r.resolved_by || "-")) +
      " · " + String(r.updated_at).slice(0, 16) +
      (r.archived_at ? " · 已归档(完成后)" : "")).join(NLJ);
    const outside = namedOutside(g.id, ids);
    const outTxt = outside.length ? NLJ + NLJ +
      "⚠ 完成定义里点名、但**不在本目标子树**的卡(口径不一致 —— 本记录不代表它们已完成):" + NLJ +
      outside.map((o) => "#" + o.id + " [" + o.status + "] " + String(o.subject).slice(0, 46)).join(NLJ) : "";
    const record = "—— 目标完成记录(看板自动生成)——" + NLJ +
      "全部 " + rows.length + " 张子任务卡已完成" +
      (nArch ? "(其中 " + nArch + " 张已归档,且归档时已是完成态)" : "") + "。" + NLJ + NLJ +
      digest + outTxt + NLJ + NLJ +
      "各卡的证据与裁定记录在其卡面双击可看;本记录是机械汇总,不代替各卡验收。";
    db.prepare("UPDATE tasks SET status='done', resolved_by='auto', waiting_for=NULL, " +
               "resolved_at=?, result=?, updated_at=? WHERE id=?").run(now(), record, now(), g.id);
    changed.push(Number(g.id));
  }
  for (const g of db.prepare(
      "SELECT id, result FROM tasks WHERE kind='goal' AND status='done' AND resolved_by='auto' AND archived_at IS NULL").all()) {
    // ⭐ This subtree also includes archived cards ⇒ "archive the unfinished child to
    //   keep the goal closed" stops working.
    const open = subtree(g.id).map((i) => rowOf.get(i)).filter((r) => r.status !== "done");
    if (!open.length) continue;
    // Goal reopen is also a "back into the flow" road ⇒ drop verdict (same invariant
    // as reopen).
    db.prepare("UPDATE tasks SET status='not_started', resolved_by=NULL, verdict=NULL, result=?, updated_at=? WHERE id=?")
      .run(String(g.result || "") + NLJ + NLJ +
           "—— 目标重开(自动): " +
           open.map((r) => "#" + r.id + (r.archived_at ? "(已归档·未完成)" : "")).join(" ") +
           " 回到了未开始 ——", now(), g.id);
    changed.push(-Number(g.id));
  }
  return changed;
}

/**
 * ⭐ Send parents whose derivations ALL completed back from human-wait to re-review
 * automatically (ruling: "once derivations finish, re-review the parent against
 * their results instead of waiting on me forever").
 * pendingReview only sees auto_review_at < updated_at, and a child completing does
 * NOT move the parent's updated_at — measured: three cards sat in confirm with all
 * children done.
 *
 * Sweep condition (all must hold):
 *   · parent waiting (not archived), reviewed at least once (auto_review_at set —
 *     unreviewed ones are already in the review queue; leave them)
 *   · ≥1 non-archived child, all done
 *   · the newest child's updated_at is NEWER than the parent's review time
 *     (= children finished after the review)
 * Rearm = waiting_for back to review, auto_review_at cleared. Idempotent: after
 * rearming, auto_review_at is NULL so next cycle the condition fails. If review
 * escalates again, auto_review_at advances, and only a child finishing after THAT
 * brings it back once more.
 * A periodic sweep, not a hook on resolve: one road, and anything a crash missed is
 * picked up next cycle.
 */
function rearmDone(db) {
  const rows = db.prepare(
    `SELECT p.id FROM tasks p
      WHERE p.status='waiting' AND p.archived_at IS NULL
        AND p.auto_review_at IS NOT NULL
        AND EXISTS (SELECT 1 FROM tasks c WHERE c.parent_id=p.id AND c.archived_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM tasks c WHERE c.parent_id=p.id
                          AND c.archived_at IS NULL AND c.status<>'done')
        AND p.auto_review_at < (SELECT MAX(c.updated_at) FROM tasks c
                                  WHERE c.parent_id=p.id AND c.archived_at IS NULL)`).all();
  for (const r of rows) {
    const kids = db.prepare(
      "SELECT id FROM tasks WHERE parent_id=? AND archived_at IS NULL").all(r.id).map((x) => Number(x.id));
    db.prepare(
      // review_fp cleared alongside auto_review_at: the children finishing IS the new
      // information, even though the parent's own deliverable text did not change.
      // Every path that deliberately sends a card back for review has to clear both,
      // or the dedup filter quietly undoes the send-back.
      `UPDATE tasks SET waiting_for='review', auto_review_at=NULL, review_fp=NULL,
                        verdict_note=COALESCE(verdict_note,'') || ?, updated_at=? WHERE id=?`
    ).run(`${"\n\n"}—— 子任务卡 #${kids.join(" #")} 已全部完成 → 自动送回重审(不再等待人工)——`,
          now(), Number(r.id));
  }
  return rows.map((r) => Number(r.id));
}

/** Waiting cards auto-review has not seen yet (or that moved after it looked). */
function pendingReview(db) {
  // Children of pinned goals get reviewed first — same priority as claim. "Push this
  // stream now" must apply to acceptance too, or the pinned stream jams in the
  // review queue and stalls anyway.
  return db.prepare(
    `SELECT t.* FROM tasks t
      WHERE t.status='waiting' AND t.archived_at IS NULL
        AND COALESCE(t.waiting_for,'') <> 'rearm'
        -- ⭐ Human-gated applies to REVIEW too (a measured open hole). Plugging only
        --   claim is not enough: fix one line on the card face and updated_at moves,
        --   auto_review_at < updated_at holds again, and the whole human-wait pile
        --   marches back into re-review. Pointing a model at a card whose answer is
        --   known to be "wait for the human" is pure quota incineration. Once the
        --   human rules, resolve drops human_gate to 0 and it returns naturally.
        AND COALESCE(t.human_gate,0)=0
        AND (t.auto_review_at IS NULL OR t.auto_review_at < t.updated_at)
      ORDER BY t.id`
  ).all()
   // ⭐ Second criterion (v0.11.2): the SQL above answers "has the card moved since
   //   the review", which is not "is there anything new to review". The deliverable
   //   fingerprint answers the second one. Same delivery, same acceptance, same
   //   machine result ⇒ the verdict already reached still applies, so no reviewer is
   //   paid to reach it again. The note above this query records what the loose
   //   criterion cost: one edited line marched the whole pile back into re-review.
   //   ⚠ A card never reviewed (review_fp NULL) always passes — this filter narrows
   //   an existing queue, it must never be the reason a card is never looked at.
   .filter((t) => !t.review_fp || t.review_fp !== reviewFingerprint(t))
   .map((t) => ({ ...t, pin: pinnedAncestor(db, t.parent_id) }))
   .sort((a, b) => (a.pin == null) - (b.pin == null)
                || String(b.pin || "").localeCompare(String(a.pin || ""))
                || a.id - b.id)
   .map(row);
}

/** Provenance stamp — **the single assignment site for prev_line in the whole repo**
 *  (grep-provable). Called only by write paths that actually change line:
 *  update / reopen (line reassignment goes through /update = same mandatory pass).
 *  ⚠ Writing it at each site is the "someone forgets one" trap shape.
 *
 *  ⭐ This function used to fire its own UPDATE — a SECOND write, separate from the
 *    line change, with an interruption window between the two: "stamp landed but the
 *    line never moved" (and the reverse) were constructible torn states.
 *    ⇒ It no longer touches the DB. It returns a FRAGMENT the caller mixes into its
 *      own UPDATE. One statement means SQLite's per-statement atomicity IS the
 *      no-half-write guarantee — nothing weaker than wrapping in a transaction, and
 *      no reliance on rollback correctness.
 *  ⛔ Never touch the DB from here. The moment you do, the "second write" is back.
 *    The injected-interruption selftest enforces this at the execution layer (the
 *    gate is a test, not a comment).
 *
 *  Debounce: same value → no stamp / null→line → no stamp (no provenance to keep) /
 *  line→null and line→other-line → stamp. Re-changes overwrite = only the last hop
 *  is kept. The value is a copy of a line that already passed badRoutable, so
 *  unknown values are structurally impossible (the value set is guarded at the
 *  source gate).
 *  @returns {null | {set: string, arg: string}} null = no stamp */
function prevLineStamp(oldLine, newLine) {
  const o = oldLine ?? null, n = newLine ?? null;
  if (o === n || o == null) return null;
  return { set: "prev_line=?", arg: String(o) };
}

/** Card edit: line/route/caps/lock/permissions reassignment. Status NEVER moves here
 *  (state transitions are report/resolve's sole responsibility). */
function update(db, args) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const before = db.prepare(
      "SELECT id, line, parent_id, status, kind, released FROM tasks WHERE id=?").get(Number(args.id));
    const out = updateInner(db, args);
    const after = db.prepare(
      "SELECT id, line, parent_id, status, kind, released FROM tasks WHERE id=?").get(Number(args.id));
    const actor = args.actor || "system";
    // Only the two edits that MOVE THE CARD IN THE GRAPH are history: a line move and
    // a re-hang are exactly what the lineage view would otherwise reconstruct from
    // current values and get wrong. Text edits do not relocate anything.
    if ((before?.line ?? null) !== (after?.line ?? null)) {
      appendEvent(db, {
        taskId: args.id, kind: "set_line", actor,
        detail: eventState(after, { from: before?.line ?? null, to: after?.line ?? null }),
      });
    }
    if ((before?.parent_id ?? null) !== (after?.parent_id ?? null)) {
      appendEvent(db, {
        taskId: args.id, kind: "set_parent", actor,
        detail: eventState(after, {
          from: before?.parent_id == null ? null : Number(before.parent_id),
          to: after?.parent_id == null ? null : Number(after.parent_id),
        }),
      });
    }
    db.exec("COMMIT");
    return out;
  } catch (e) { try { db.exec("ROLLBACK"); } catch {} throw e; }
}

function updateInner(db, fields) {
  const { id, line, route, maxAttempts, lockKey, needsBash, verifyCmd,
          subject, description, acceptance, parentId, weight, humanGate,
          oneofKey, provesParent, blockedBy } = fields;
  const t = db.prepare("SELECT * FROM tasks WHERE id=?").get(Number(id));
  if (!t) throw err(ERR.NOT_FOUND, `任务 ${id} 不存在`);
  // An in-progress card refuses edits to EVERY field, with exactly one exception: a
  // pure tail-append to `description`.
  //   · The old refusal text named only "moving the line", so callers who were not
  //     sending a line read it as "then mine should pass" and retried the identical
  //     edit forever. The text has to be as wide as the rule.
  //   · The append is allowed because the worker snapshots the card into its prompt
  //     AT CLAIM TIME and never re-reads it while running: appending moves no state,
  //     no holder and no loop decision. The price is that THIS round's worker cannot
  //     see it — which the API must say out loud rather than let the writer assume.
  // ⭐ "Only description was sent" is derived from the CALL, not from a hand-kept list
  //   of sibling fields. Origin enumerates its 14 siblings by hand; the day someone
  //   adds an editable field and forgets that array, "description + the new field"
  //   smuggles an edit into a running card. Deriving it means an unknown key — new,
  //   misspelled, or hostile — falls on the refusing side by construction.
  const NOT_A_FIELD = new Set(["id", "actor"]);   // routing/attribution, not card content
  const oldDescription = String(t.description || "");
  const descriptionOnly = description !== undefined &&
    Object.keys(fields).every((k) => k === "description" || NOT_A_FIELD.has(k)
                                    || fields[k] === undefined);
  // Strictly longer AND prefixed by the current text: re-sending the same text is not
  // an append, and an append computed from a STALE copy would silently eat whatever
  // was appended in between.
  const liveDescriptionAppend = t.status === "in_progress" && descriptionOnly &&
    typeof description === "string" &&
    description.length > oldDescription.length &&
    description.startsWith(oldDescription);
  if (t.status === "in_progress" && !liveDescriptionAppend)
    throw err(ERR.CONFLICT, `任务 ${id} 是 in_progress(持有者 ${t.worker}),不可 edit 任何字段;` +
      `唯一例外是保留 description 原文并在末尾追记。worker prompt 在认领时已快照,本轮 worker 看不到追记`);
  const sets = [], args = [];
  // Dependency edges are writable. Invalid input throws ⇒ the whole update fails and
  // blocked_by keeps its original value (no half-write). `changed` counts itself via
  // sets length.
  if (blockedBy !== undefined) {
    sets.push("blocked_by=?"); args.push(normalizeDeps(db, Number(id), blockedBy));
  }
  // Card text is editable too. If a wrong acceptance line could only be fixed by
  // "archive and rebuild", the history (attempts, derivations, rulings) would be
  // severed and nobody could trace what happened.
  if (subject !== undefined){
    if (!String(subject).trim()) throw err(ERR.BAD_INPUT, "subject 不能为空");
    sets.push("subject=?"); args.push(String(subject));
  }
  if (description !== undefined){ sets.push("description=?"); args.push(String(description)); }
  if (acceptance !== undefined){  sets.push("acceptance=?");  args.push(String(acceptance)); }
  if (line !== undefined)        { sets.push("line=?");         args.push(line ? String(line) : null); }
  if (route !== undefined)       { sets.push("route=?");        args.push(String(route || DEFAULT_ROUTE)); }
  if (maxAttempts !== undefined) { sets.push("max_attempts=?"); args.push(Number(maxAttempts)); }
  if (lockKey !== undefined)     { sets.push("lock_key=?");     args.push(lockKey ? String(lockKey) : null); }
  if (needsBash !== undefined)   { sets.push("needs_bash=?");   args.push(needsBash ? 1 : 0); }
  if (verifyCmd !== undefined)   { sets.push("verify_cmd=?");   args.push(assertVerify(verifyCmd)); }
  // Linked-closure declarations usually arrive AFTER the fact (you decompose, then
  // notice "either of these two suffices").
  // ⚠ Empty string means revoke (null) — "" as a group key would put everything in
  //   one group.
  if (oneofKey !== undefined)    { sets.push("oneof_key=?");    args.push(oneofKey ? String(oneofKey) : null); }
  if (provesParent !== undefined){ sets.push("proves_parent=?");args.push(provesParent ? 1 : 0); }
  // Ladder starting rung. Everyone who changes it — card author / coordinator /
  // review / re-orchestration — passes through HERE (set_weight goes via /update,
  // same mandatory pass as set_line). Same expression as add().
  if (weight !== undefined)      { sets.push("weight=?");       args.push(String(weight || "standard")); }
  // ⭐ Human gate: explicit open/close. truthy→1, falsy→0 (unknown values do not land
  //   in between).
  if (humanGate !== undefined)   { sets.push("human_gate=?");   args.push(humanGate ? 1 : 0);
                                   // Via edit is always EXPLICIT (a deliberate lock).
                                   // Removing it clears the source too.
                                   sets.push("human_gate_src=?"); args.push(humanGate ? "explicit" : null); }
  // Re-parenting: hang an orphan under a goal / let re-orchestration regroup a
  // family.
  // ⚠ A measured decay: this block was added after the error-taxonomy ruling with
  //   five bare `throw new Error` ⇒ all 400. Worst: "parent N does not exist" was
  //   404 in add() — the same judgment under two codes, the very shape the taxonomy
  //   had eliminated. ⇒ typed now, same mapping as add() (missing=NOT_FOUND /
  //   archived=BAD_INPUT).
  if (parentId !== undefined) {
    if (parentId === null) { sets.push("parent_id=?"); args.push(null); }
    else {
      const pid = Number(parentId);
      if (pid === Number(id)) throw err(ERR.BAD_INPUT, "不能把卡挂到它自己下面");
      const tgt = db.prepare("SELECT id, archived_at FROM tasks WHERE id=?").get(pid);
      if (!tgt) throw err(ERR.NOT_FOUND, `父卡 ${pid} 不存在`);
      // Never hang under an archived card — the whole family drops out of the
      // default view; the card silently disappears.
      if (tgt.archived_at) throw err(ERR.BAD_INPUT, `#${pid} 已归档,不能把卡挂到它下面`);
      // Cycle guard. ⚠ Past 32 levels: NOT "stop searching and allow" but REFUSE
      //   (fail-closed). "Could not finish checking" is not "safe" (ruling).
      let cur = pid, g = 0, cycled = false, exhausted = true;
      while (cur != null) {
        if (++g > 32) { exhausted = false; break; }
        const r = db.prepare("SELECT parent_id FROM tasks WHERE id=?").get(cur);
        if (r && Number(r.parent_id) === Number(id)) { cycled = true; break; }
        cur = r ? r.parent_id : null;
      }
      if (cycled) throw err(ERR.BAD_INPUT, `会形成循环(#${cur} 的先祖里有 #${id}),拒绝`);
      // The fail-closed refusal is also BAD_INPUT (not 500): nothing of OURS is
      // broken; the request "point at that parent" just cannot be honored — point at
      // another parent and it passes ⇒ the ball is in the caller's hands.
      if (!exhausted) throw err(ERR.BAD_INPUT, `先祖链超过 32 层,无法证明无循环 —— 拒绝(fail-closed)`);
      sets.push("parent_id=?"); args.push(pid);
    }
  }
  if (!sets.length) return { id: Number(id), changed: 0 };
  // ★ The "columns changed" count is FIXED here. The provenance stamp and updated_at
  //   are not caller-specified columns, so they do not count — counting them would
  //   bump `changed` by 1 only on line moves, silently shifting the caliber for
  //   existing callers (and the selftest).
  const changed = sets.length;
  // ⭐ The provenance stamp is MIXED INTO the same UPDATE (a separate statement opens
  //   an interruption window). ⚠ Order of pushes = order of args: it must go BEFORE
  //   updated_at and id.
  const stamp = line !== undefined ? prevLineStamp(t.line, line ? String(line) : null) : null;
  if (stamp) { sets.push(stamp.set); args.push(stamp.arg); }
  sets.push("updated_at=?"); args.push(now(), Number(id));
  db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id=?`).run(...args);
  // The append succeeded, and the writer must be told the thing they cannot observe:
  // the running worker is holding a snapshot and will not see this text.
  return { id: Number(id), changed,
           ...(liveDescriptionAppend
             ? { notice: "description 已追记;worker prompt 是认领时快照,本轮 worker 不可见,下次认领才会读到" }
             : {}) };
}

/** Pin a goal. Its child tasks come out of claim first. Unpin with pinned=false. */
function setPinned(db, { id, pinned }) {
  const t = db.prepare("SELECT kind FROM tasks WHERE id=?").get(Number(id));
  if (!t) throw err(ERR.NOT_FOUND, `任务 ${id} 不存在`);
  if (t.kind !== "goal") throw err(ERR.BAD_INPUT, `#${id} 不是目标,只有目标能置顶`);
  db.prepare("UPDATE tasks SET pinned_at=?, updated_at=? WHERE id=?")
    .run(pinned ? now() : null, now(), Number(id));
  return { id: Number(id), pinned_at: pinned ? now() : null };
}

/** Release / hold (the old "backlog"). What moves is a COLUMN, not a status — no
 *  fifth state. */
function setReleased(db, { id, released, actor = "human" }) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const before = db.prepare(
      "SELECT id, line, parent_id, status, kind, released FROM tasks WHERE id=?").get(Number(id));
    if (!before) throw err(ERR.NOT_FOUND, `任务 ${id} 不存在`);
    const value = released ? 1 : 0;
    db.prepare("UPDATE tasks SET released=?, updated_at=? WHERE id=?").run(value, now(), Number(id));
    // ⚠ Shares the `release` kind with returning an in-flight card; told apart by
    //   detail.action (see releaseHeldBy).
    appendEvent(db, {
      taskId: id, kind: "release", actor,
      detail: eventState({ ...before, released: value }, {
        action: value ? "release" : "hold", from: Boolean(before.released), to: Boolean(value),
      }),
    });
    db.exec("COMMIT");
    return { id: Number(id), released: value };
  } catch (e) { try { db.exec("ROLLBACK"); } catch {} throw e; }
}

/** Return a card to not_started. Works from done too — "closed, but a follow-up is
 *  needed after all" happens routinely. Attempts and ruling records are NEVER
 *  erased (history; a redo does not unhappen it). */
function reopen(db, args) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const before = db.prepare(
      "SELECT id, line, parent_id, status, kind, released FROM tasks WHERE id=?").get(Number(args.id));
    const out = reopenInner(db, args);
    // A no-op reopen (already not_started) writes no history: nothing moved.
    if (out.changed) {
      const after = db.prepare(
        "SELECT id, line, parent_id, status, kind, released FROM tasks WHERE id=?").get(Number(args.id));
      appendEvent(db, {
        taskId: args.id, kind: "reopen", actor: args.actor || "human",
        detail: eventState(after, { from_status: before?.status ?? null }),
      });
    }
    db.exec("COMMIT");
    return out;
  } catch (e) { try { db.exec("ROLLBACK"); } catch {} throw e; }
}

function reopenInner(db, { id, line }) {
  const t = db.prepare("SELECT * FROM tasks WHERE id=?").get(Number(id));
  if (!t) throw err(ERR.NOT_FOUND, `任务 ${id} 不存在`);
  if (t.status === "in_progress")
    throw err(ERR.CONFLICT, `任务 ${id} 正在被 ${t.worker} 处理 —— 先停掉那条线,或等它交回来`);
  if (t.status === "not_started") return { id: Number(id), status: "not_started", changed: false };
  // ⭐ Same as update(): the provenance stamp is mixed into THIS one statement.
  //   ⚠ Argument order follows fragment position: the two CASE params → stamp (if
  //   any) → updated_at → id.
  const stamp = line ? prevLineStamp(t.line, String(line)) : null;
  db.prepare(
    // ⭐ Reopen = the card returns to the flow ⇒ the RESULT is voided (verdict=NULL).
    //   Without this, "reopen a done card → not_started with verdict='approve'"
    //   leaks the same invariant through a different door.
    //   ⚠ last_verdict STAYS — who pressed what to get here is history we keep.
    // ⭐ Reopen clears dispatch_fp: a human explicitly putting a card back into the
    //   flow IS the changed input. The no-progress brake must never make "reopen"
    //   silently do nothing — that would be the gate defeating the operator.
    `UPDATE tasks SET status='not_started', waiting_for=NULL, worker=NULL, verdict=NULL,
                      lease_until=NULL, heartbeat_at=NULL, dispatch_fp=NULL, dispatch_fp_at=NULL,
                      line=CASE WHEN ? IS NULL THEN line ELSE ? END,
                      ${stamp ? stamp.set + ", " : ""}updated_at=? WHERE id=?`
  ).run(line || null, line || null, ...(stamp ? [stamp.arg] : []), now(), Number(id));
  return { id: Number(id), status: "not_started", changed: true, from: t.status };
}

function archive(db, { id, restore = false, force = false }) {
  // ⭐ Ruling: "a completed goal must not be archived" — done goals stay on the board
  //   as the canon of what was achieved. Scope is the ruling's letter: **kind=goal
  //   AND status=done** only (done TASK cards archive as before; un-done goals are
  //   out of scope too — rulings are not widened uninvited). The re-orchestration
  //   loop had a similar guard from birth; the leak was the manual/API road, so the
  //   gate lives at the mandatory pass of every write path: here. Restore always
  //   passes (an un-restorable prohibition breeds accidents). Measured before the
  //   gate existed.
  const taskId = Number(id);
  const forced = force === true; // only an explicit boolean counts ("true" the string does not)
  const checkArchiveGuard = (t) => {
    if (t.kind === "goal" && t.status === "done")
      throw err(ERR.BAD_INPUT, `#${id} 是已完成的目标 —— 目标的已完成不准归档(裁定)`);
    if (!forced && ["waiting", "in_progress"].includes(t.status))
      throw err(ERR.CONFLICT,
        `#${id} 当前状态是 ${t.status},流程尚未完成,不能归档 —— 请先完成或打回,若确需强制归档请明确使用 force=true(CLI: --force)`);
  };

  if (!restore) {
    const t0 = db.prepare("SELECT kind, status FROM tasks WHERE id=?").get(taskId);
    if (!t0) throw err(ERR.NOT_FOUND, `任务 ${id} 不存在`);
    checkArchiveGuard(t0);
  }

  const stamp = now();
  // ⭐ Race gate: so a status change between SELECT and UPDATE cannot bury an active
  //   card, the UPDATE carries the gate itself. force lifts only the
  //   waiting/in_progress gate; the done-goal rule is never lifted.
  const r = restore
    ? db.prepare("UPDATE tasks SET archived_at=NULL, updated_at=? WHERE id=?").run(stamp, taskId)
    : db.prepare(`UPDATE tasks SET archived_at=?, updated_at=? WHERE id=?
                  AND NOT (kind='goal' AND status='done')
                  AND (?=1 OR status NOT IN ('waiting','in_progress'))`)
        .run(stamp, stamp, taskId, forced ? 1 : 0);
  if (!r.changes) {
    // Stopped by the UPDATE-side gate after a post-SELECT race: never misreport an
    // existing card as 404.
    const current = db.prepare("SELECT kind, status FROM tasks WHERE id=?").get(taskId);
    if (!current) throw err(ERR.NOT_FOUND, `任务 ${id} 不存在`);
    checkArchiveGuard(current);
    throw err(ERR.CONFLICT, `#${id} 的状态在归档期间发生变化,请刷新后重试`);
  }
  return { id: Number(id), archived: !restore };
}

function row(r) {
  // ⭐ The third site of the dep-judgment consolidation (**load-bearing**). row() is
  //   the ONLY data source for the panel's "deps #N" and the re-prompt's deps block.
  //   Making claim/claimById fail-closed while leaving this one silently `[]` builds
  //   the worst combination — "the card is stuck (unclaimable) while the board and
  //   the prompt keep saying no dependencies" = a stop that cannot state its reason.
  //   House rule is loud-fail ⇒ keep returning `[]` for the value, but SAY that it
  //   is broken alongside.
  const _deps = (() => {
    try {
      const d = JSON.parse(r.blocked_by);
      if (!Array.isArray(d)) return { list: [], broken: true };          // legal JSON that is not an array is broken too
      if (d.map(Number).filter(Number.isInteger).length !== d.length)
        return { list: [], broken: true };                              // non-integer element mixed in
      return { list: d, broken: false };
    } catch { return { list: [], broken: true }; }
  })();
  return {
    id: Number(r.id), subject: r.subject, description: r.description,
    status: r.status, waiting_for: r.waiting_for,
    worker: r.worker, line: r.line, prev_line: r.prev_line || null, route: r.route,
    // ⚠ row() is an explicit projection, not a spread — a new column does NOT ride
    //   along on its own. The server needs these two to answer "is the no-progress
    //   brake holding this card?" without a second query; leaving them out made that
    //   answer silently null while the queue was in fact refusing the card.
    dispatch_fp: r.dispatch_fp || null, dispatch_fp_at: r.dispatch_fp_at || null,
    last_note: r.last_note ?? null,
    attempts: Number(r.attempts), max_attempts: Number(r.max_attempts),
    // ⭐ Calibers not mixed: attempts = lifetime total (history, never decreases) /
    //   attempts_this_claim = used in THE CURRENT dispatch (budget judgments read
    //   this one). On an old DB without the column, base falls to 0 and the two are
    //   equal = old behavior exactly (nothing silently loosens).
    attempts_base: Number(r.attempts_base || 0),
    attempts_this_claim: Math.max(0, Number(r.attempts) - Number(r.attempts_base || 0)),
    // Even at moments when the column is absent (readOnly open before migrate),
    // fall to the default. ⚠ "Unreadable" must not fall to "light" — unknown goes to
    // the MIDDLE (neither stronger nor weaker).
    weight: r.weight || "standard",
    acceptance: r.acceptance, result: r.result, verdict_note: r.verdict_note,
    lock_key: r.lock_key, evidence_path: r.evidence_path,
    needs_bash: Number(r.needs_bash) === 1, released: Number(r.released) === 1,
    verify_cmd: r.verify_cmd || null,
    // verdict = result (only done cards non-NULL) / last_verdict = this round's
    // ruling (survives hand-backs).
    verdict: r.verdict || null,
    last_verdict: r.last_verdict || null,
    resolved_at: r.resolved_at || null,
    work_spans: (() => { try { return JSON.parse(r.work_spans || "[]"); } catch { return []; } })(),
    // Boolean shape matches needs_bash/released; old DB without the column → false
    // (no filtering).
    human_gate: Number(r.human_gate) === 1,
    // Lock source (layered-unlock criterion): 'detect' = the sniffer's machine lock /
    // 'explicit' = deliberate lock / null = no lock.
    human_gate_src: r.human_gate_src || null,
    // Actual runtime (badge): NULL = never claimed → panel falls back to the route
    // family.
    last_runtime: r.last_runtime || null,
    // ── Linked closure: the two declarations, plus the MACHINE RESULT that triggers
    //   linkage. ⚠ verify_ok is THREE-VALUED (null = not measured / true / false) —
    //   never collapse to boolean. Collapsed, "not measured" turns into "red", and
    //   "why didn't it link" becomes unreadable afterwards.
    oneof_key: r.oneof_key || null,
    proves_parent: Number(r.proves_parent) === 1,
    verify_ok: r.verify_ok == null ? null : Number(r.verify_ok) === 1,
    verify_at: r.verify_at || null,
    kind: r.kind || "task", parent_id: r.parent_id == null ? null : Number(r.parent_id),
    pinned_at: r.pinned_at || null,
    resolved_by: r.resolved_by, auto_review_at: r.auto_review_at,
    decision_package: (() => {
      try { return r.decision_json ? JSON.parse(r.decision_json) : null; } catch { return null; }
    })(),
    decision_choice: r.decision_choice || null,
    decision_sql_archive: (() => {
      try { return r.decision_sql_archive ? JSON.parse(r.decision_sql_archive) : null; } catch { return null; }
    })(),
    decision_receipt: (() => {
      try { return r.decision_receipt ? JSON.parse(r.decision_receipt) : null; } catch { return null; }
    })(),
    // ⭐ Derived value (not a column — a column would be a second source of truth to
    //   keep in sync). Broken JSON falls to false: the failure direction is "today's
    //   behavior" = no wrongful closure.
    //   ⚠ Making THIS one loud would let a single broken byte keep the whole board
    //   from opening. The trade-off is recorded here.
    confirm_pending: (() => {
      try {
        const d = r.decision_receipt ? JSON.parse(r.decision_receipt) : null;
        return !!(d && !d.consumed_at);
      } catch { return false; }
    })(),
    blocked_by: _deps.list, blocked_by_broken: _deps.broken,
    created_at: r.created_at, updated_at: r.updated_at,
    lease_until: r.lease_until ? Number(r.lease_until) : null,
    heartbeat_at: r.heartbeat_at ? Number(r.heartbeat_at) : null,
    archived_at: r.archived_at,
  };
}

/**
 * Listing. archived defaults to 'false'.
 * The response ALWAYS carries archived_count — the "default view impersonating the
 * full set" false negative is blocked at the DATA layer, not left to the CLI or
 * panel remembering to add a line (measured on a predecessor board).
 */
function list(db, { status = null, route = null, line = null, kind = null, archived = "false" } = {}) {
  const where = [];
  const args = [];
  if (archived === "false") where.push("archived_at IS NULL");
  else if (archived === "true") where.push("archived_at IS NOT NULL");
  if (status) { where.push("status=?"); args.push(String(status)); }
  if (route) { where.push("route=?"); args.push(String(route)); }
  if (line) { where.push("line=?"); args.push(String(line)); }
  if (kind) { where.push("kind=?"); args.push(String(kind)); }
  const sql = "SELECT * FROM tasks" + (where.length ? " WHERE " + where.join(" AND ") : "") + " ORDER BY id";
  const tasks = db.prepare(sql).all(...args).map(row);
  const archived_count = Number(
    db.prepare("SELECT COUNT(*) n FROM tasks WHERE archived_at IS NOT NULL").get().n
  );
  return { tasks, archived_count };
}

/**
 * The set of card ids "related to" one card.
 * For a goal: itself + all descendants. For a child: the parent + all siblings.
 * Parentless: itself. The panel uses this for pinning and outlines — "what is this
 * one part of" at a glance.
 */
function relatedIds(db, id) {
  const t = db.prepare("SELECT id, kind, parent_id FROM tasks WHERE id=?").get(Number(id));
  if (!t) return [];
  // Parent-child is not only goal→task but also **task→task** (an in-progress card
  // spawning its own children). So walk to the root first, then collect the root's
  // whole subtree — the same stream lights up together.
  let root = Number(t.id), guard = 0;
  for (;;) {
    const r = db.prepare("SELECT parent_id FROM tasks WHERE id=?").get(root);
    if (!r || r.parent_id == null || ++guard > 32) break;   // guard = cycle insurance
    root = Number(r.parent_id);
  }
  const out = new Set([root]);
  const stack = [root];
  while (stack.length) {
    for (const r of db.prepare("SELECT id FROM tasks WHERE parent_id=?").all(stack.pop())) {
      if (!out.has(Number(r.id))) { out.add(Number(r.id)); stack.push(Number(r.id)); }
    }
  }
  return [...out];
}

function get(db, id) {
  const r = db.prepare("SELECT * FROM tasks WHERE id=?").get(Number(id));
  return r ? row(r) : null;
}

function counts(db) {
  const out = { not_started: 0, in_progress: 0, waiting: 0, done: 0 };
  for (const r of db.prepare(
    "SELECT status, COUNT(*) n FROM tasks WHERE archived_at IS NULL GROUP BY status"
  ).all()) {
    if (r.status in out) out[r.status] = Number(r.n);
  }
  return out;
}

// ── Operator requests (v0.5) ─────────────────────────────────────────────────
// The kind domain is CLOSED (unknown falls on the refusing side): each kind is a
// deployment shortcut the coordinator-seat skill knows how to execute.
const REQUEST_KINDS = ["propose-lines", "mount-sentries", "install-worker-constraints",
                       "enable-review", "board-briefing"];
const REQUEST_STATUS = ["pending", "acked", "done"];
const rowReq = (r) => r ? { ...r, params: (() => { try { return JSON.parse(r.params || "{}"); } catch { return {}; } })() } : null;
function addRequest(db, { kind, params = {} } = {}) {
  const k = String(kind ?? "").trim();
  if (!REQUEST_KINDS.includes(k))
    throw err(ERR.BAD_INPUT, `未知的快捷指令 ${JSON.stringify(k)}(可用: ${REQUEST_KINDS.join(" / ")})`);
  const p = params && typeof params === "object" && !Array.isArray(params) ? params : {};
  const r = db.prepare("INSERT INTO operator_requests (kind, params, status, created_at) VALUES (?, ?, 'pending', ?)")
              .run(k, JSON.stringify(p), now());
  return getRequest(db, Number(r.lastInsertRowid));
}
function getRequest(db, id) {
  return rowReq(db.prepare("SELECT * FROM operator_requests WHERE id=?").get(Number(id)));
}
function listRequests(db, { open = false, limit = 50 } = {}) {
  const rows = open
    ? db.prepare("SELECT * FROM operator_requests WHERE status != 'done' ORDER BY id DESC LIMIT ?").all(limit)
    : db.prepare("SELECT * FROM operator_requests ORDER BY id DESC LIMIT ?").all(limit);
  return rows.map(rowReq);
}
function ackRequest(db, id) {
  const r = getRequest(db, id);
  if (!r) throw err(ERR.NOT_FOUND, `快捷指令 ${id} 不存在`);
  if (r.status !== "pending") throw err(ERR.CONFLICT, `快捷指令 ${id} 状态是 ${r.status},不能再 ack`);
  db.prepare("UPDATE operator_requests SET status='acked', acked_at=? WHERE id=?").run(now(), r.id);
  return getRequest(db, id);
}
function doneRequest(db, id, note = "") {
  const r = getRequest(db, id);
  if (!r) throw err(ERR.NOT_FOUND, `快捷指令 ${id} 不存在`);
  if (r.status === "done") throw err(ERR.CONFLICT, `快捷指令 ${id} 已经完成`);
  db.prepare("UPDATE operator_requests SET status='done', done_at=?, acked_at=COALESCE(acked_at, ?), note=? WHERE id=?")
    .run(now(), now(), String(note ?? "").slice(0, 2000), r.id);
  return getRequest(db, id);
}

module.exports = {
  open, migrate, add, claim, heartbeat, bumpAttempt, report, resolve, update, setReleased, archive,
  addRequest, getRequest, listRequests, ackRequest, doneRequest, REQUEST_KINDS, REQUEST_STATUS,
  markAutoReviewed, pendingReview, relatedIds, setPinned, reapExpired, claimById, releaseHeldBy,
  noProgressHold, stateFingerprint, fpDiff, heldByNoProgress,
  reopen, rearmDone, deferToRearm, completeGoals,
  list, get, counts, events, DB_PATH, DATA_DIR, STATUS, WAITING_FOR, VALID_STATUS, DEFAULT_LEASE_MIN,
  DEFAULT_ROUTE,
  verifyRegistry, assertVerify,
  // Ruling destinations. **The legacy criterion's canon is this one function**
  // (the server's hand-written copy is deleted).
  legacyDisposition, DISPOSITIONS, confirmDestination,
  // Chain depth: **judgment is these three only**. Counting depth anywhere else is a
  // second implementation the moment it is written.
  chainDepth, placeInChain, MAX_CHAIN_DEPTH,
  // Budget calibers: the lifetime-ceiling constant and the one-shot catch-up (tests
  // fire it directly).
  LIFETIME_DISPATCH_CAP, backfillAttemptsBase,
  WIP_PER_ROOT, rootOf, unreleasedAncestor, depsSatisfied, normalizeDeps, dependentsOf,
  // Verdict-caliber migration (one shot when the column is added; tests fire it
  // directly).
  backfillVerdictCaliber,
  // ★ The status-code table belongs to the store (the server must not grow a second
  //   one). `err` is exported too — the server has its own id-existence checks, and
  //   an unclassified spot there would punch a hole in the "one taxonomy" ruling.
  //   **One classifier, one constructor.** (When pointing at code in comments, look
  //   at the real thing first — a name written from memory turned out not to exist.)
  ERR, err, httpStatusFor,
};
