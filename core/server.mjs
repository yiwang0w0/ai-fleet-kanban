// Board HTTP layer — REST + SSE + static hosting. Zero dependencies
// (node:http / node:sqlite only).
//
// Start: node core/server.mjs
// Panel: http://127.0.0.1:47824
//
// ⚠ Binds 127.0.0.1 only. There is no authentication; binding 0.0.0.0 hands write
//   access to the task queue to the whole LAN. The check at the bottom REFUSES to
//   start on a non-loopback host — the warning is a gate, not a comment.

import http from "node:http";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { readFileSync, writeFileSync, existsSync, statSync, readdirSync, createReadStream, openSync, readSync, closeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);
const store = require_("./store.js");
const decision = require_("./decision_lib.js");
const decompose = require_("./decompose_lib.js");
const dgate = require_("../gates/deliverable_gate.js");

const CODE_ROOT = resolve(__dirname, "..");
const LOOPS_DIR = join(__dirname, "..", "loops");

// ── Fleet configuration ───────────────────────────────────────────────────────
// The fleet vocabulary (lines, routes, seats) is the OPERATOR's, not this file's.
// BOARD_CONFIG points at a JSON file; default <BOARD repo>/fleet.config.json — the
// config is the board operator's file and lives with the BOARD install, never in
// the work repo (v0.3: it used to follow BOARD_REPO, which sent a deployment
// looking for its config inside the WORK repo). A MISSING file falls back to
// built-in defaults; a PRESENT-BUT-BROKEN file refuses startup (an operator
// config error is deterministic — silently running on defaults would wear the
// operator's config as a costume).
//
// v0.3: the config is the single DEPLOYMENT source of truth too — optional keys
// `port` / `repo` / `gated_subtree` replace the env choreography that produced a
// whole class of measured incidents (a moved port whose clients knocked on the
// default; a second shell missing the gate env). Env vars still WIN when set;
// the config is the floor under them, written once, read by server and every
// client alike (core/env.mjs · core/board_env.py).
const CONFIG_FILE = process.env.BOARD_CONFIG || join(CODE_ROOT, "fleet.config.json");
const BUILTIN_CONFIG = {
  lines: [
    { id: "alpha", hint: "实装" },
    { id: "coord", hint: "协调/裁定/跑命令" },
  ],
  // Built-in single-seat roles ("review" only; reorg was retired by operator
  // ruling 2026-09-02 — long dead upstream, never shipped here) join SUPERVISED
  // here AND their loop scripts exist under loops/. Empty until those ship.
  roles: [],
  routes: [store.DEFAULT_ROUTE],
  max_parallel: 3,
  default_agent: { runtime: "claude", model: "claude-opus-5", effort: "high", window: false },
  // Seat declarations. A seat declares its own capabilities (models + effort
  // domains); the code branches on the DECLARATION, never on the seat id — a new
  // runtime is "add a seat + a worker-loop adapter", not an edit spree.
  runtimes: [
    { id: "claude", label: "Claude Code",
      models: [
        { id: "claude-opus-5",    label: "Opus 5" },
        { id: "claude-sonnet-5",  label: "Sonnet 5" },
        { id: "claude-haiku-4-5", label: "Haiku 4.5" },
      ],
      efforts: ["low", "medium", "high", "xhigh", "max"] },
    // Reference second seat (measured values from the origin deployment; treat as
    // an EXAMPLE, not an endorsement). Ships locked: release_env must be "1" at
    // runtime AND cmd_env must point at the CLI before it can save or start.
    { id: "codex", label: "Codex CLI",
      release_env: "BOARD_CODEX_RELEASED", cmd_env: "BOARD_CODEX_CMD",
      models: [
        { id: "gpt-5.6-sol",         label: "5.6-sol",  efforts: ["low", "medium", "high", "xhigh"] },
        { id: "gpt-5.3-codex-spark", label: "Spark",    efforts: ["xhigh"] },
      ],
      efforts: ["low", "medium", "high", "xhigh"] },
  ],
  decompose_models: [{ id: "claude-opus-5", label: "Opus 5" }],
  // Natural language for generated card text. Null = mirror the board's own language.
  language: null,
};
let CFG = BUILTIN_CONFIG;
if (existsSync(CONFIG_FILE)) {
  try {
    const raw = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
    CFG = { ...BUILTIN_CONFIG, ...raw };
    if (!Array.isArray(CFG.lines) || !CFG.lines.length) throw new Error("lines[] must be a non-empty array");
    if (!Array.isArray(CFG.routes) || !CFG.routes.length) throw new Error("routes[] must be a non-empty array");
    if (!Array.isArray(CFG.runtimes) || !CFG.runtimes.length) throw new Error("runtimes[] must be a non-empty array");
  } catch (e) {
    console.error(`拒绝启动:${CONFIG_FILE} 存在但不可用 —— ${e.message}`);
    process.exit(1);
  }
}
// Deployment keys (env > config > default). REPO_ROOT anchors the deliverable
// gate and the workers' cwd; the board's own code stays anchored at CODE_ROOT.
const REPO_ROOT = process.env.BOARD_REPO || (CFG.repo ? resolve(String(CFG.repo)) : CODE_ROOT);
const CFG_GATED_SUBTREE = process.env.BOARD_GATED_SUBTREE || (CFG.gated_subtree ? String(CFG.gated_subtree) : "");
// Migration hint: a config sitting where the OLD default looked (the work repo)
// is silently ignored now — say so once, loudly, instead of wearing defaults.
if (!process.env.BOARD_CONFIG && REPO_ROOT !== CODE_ROOT &&
    !existsSync(CONFIG_FILE) && existsSync(join(REPO_ROOT, "fleet.config.json")))
  console.error(`⚠ ${join(REPO_ROOT, "fleet.config.json")} 不再被读取 —— 配置属于看板安装,` +
                `请移到 ${CONFIG_FILE}(或用 BOARD_CONFIG 显式指定)`);

// ── Handoff targets (operator ruling 2026-09-01: hand-executed deliverables are
//    not necessarily SQL). The operator AUTHORIZES local directories as classified
//    destinations — fleet.config `handoff_targets`, or BOARD_HANDOFF_DIR which
//    synthesizes one default target (serial admission pattern, any file type).
//    Only declared directories are ever written; unknown target ids refuse.
const HANDOFF_TARGETS = decision.normalizeTargets(
  Array.isArray(CFG.handoff_targets) && CFG.handoff_targets.length
    ? CFG.handoff_targets
    : process.env.BOARD_HANDOFF_DIR
      ? [{ id: "default", label: "Handoff", dir: process.env.BOARD_HANDOFF_DIR }]
      : []);
if (Array.isArray(CFG.handoff_targets) && CFG.handoff_targets.length !== HANDOFF_TARGETS.length) {
  console.error("拒绝启动:handoff_targets 含不可用行(每行需要 id + dir,id 不可重复)");
  process.exit(1);
}
const DECISION_CTX = { repoRoot: REPO_ROOT, targets: HANDOFF_TARGETS };

// ── Deliverable-existence gate (kills "done yet never committed" at close time) ──
// It closes only on `approve` with an empty human note — the same criterion as
// store.resolve. ⭐ A hand-written copy of that criterion used to live here; it had
// ALREADY diverged (the copy judged the raw note, the store judged the synthesized
// one — the panel sends empty notes, so copy said "close" while store said "hand
// back", and the gate could 409 on a card that wasn't closing). The copy is gone:
// the destination is decided ONCE, in the resolve endpoint, from
// store.legacyDisposition / confirmDestination. Not "watched for divergence" —
// simply not held twice.
//
// Prefix wiring (INCIDENT-4 hardening): the path extractor needs the HOST repo's
// top-level names — hardcoded prefixes are blind on any other repo. Built once at
// startup from `git ls-tree -z HEAD` (⚠ -z is mandatory: plain ls-tree quotes
// non-ASCII paths and CJK files silently fall out).
// ⭐ Unmeasurable is NOT "no violations" — they are different states (flagged by
//   an outside review; also CONTRIBUTING rule 4: unknown values fall on the
//   refusing side). When the gate cannot see HEAD, closes REFUSE by default;
//   a deliberately git-less deployment says so explicitly with
//   BOARD_DELIVERABLE_GATE=off, and every close under "off" logs.
const GATE_OFF = process.env.BOARD_DELIVERABLE_GATE === "off";
let extractor = null;
try {
  const top = execFileSync("git", ["-C", REPO_ROOT, "ls-tree", "-z", "HEAD"],
                           { maxBuffer: 8 * 1024 * 1024 }).toString("utf8");
  const prefixes = dgate.topLevelPrefixes(top);
  if (prefixes.length) extractor = dgate.makeExtractor({ prefixes });
  else console.error("⚠ 交付物闸不可测:HEAD 没有顶层条目(空仓?)" +
    (GATE_OFF ? "—— 已显式关闭,结案不做入库核对" : "—— 结案将被拒绝(fail-closed);确属无 git 部署请显式 BOARD_DELIVERABLE_GATE=off"));
} catch (e) {
  console.error(`⚠ 交付物闸不可测:读不到宿主仓 HEAD(${e.message})` +
    (GATE_OFF ? "—— 已显式关闭,结案不做入库核对" : "—— 结案将被拒绝(fail-closed);确属无 git 部署请显式 BOARD_DELIVERABLE_GATE=off"));
}
let _headCache = { at: 0, set: null };
const headFiles = () => {
  if (_headCache.set && Date.now() - _headCache.at < 10000) return _headCache.set;
  let set = null;
  try {
    // ⚠ -z mandatory (same reason as above).
    const out = execFileSync("git", ["-C", REPO_ROOT, "ls-tree", "-r", "--name-only", "-z", "HEAD"],
                             { maxBuffer: 64 * 1024 * 1024 });
    set = new Set(out.toString("utf8").split("\0").filter(Boolean));
  } catch { set = null; }        // no git / not a repo → the gate is silently off (closures not blocked)
  _headCache = { at: Date.now(), set };
  return set;
};
// Return contract: string[] = measured violations (possibly none); null = the
// gate could not measure — the CALLER decides, and the default decision is
// refuse (409). GATE_OFF converts null to a logged pass.
const uncommittedOf = (t) => {
  if (!extractor) {
    if (!GATE_OFF) return null;
    console.log(`交付物闸显式关闭(BOARD_DELIVERABLE_GATE=off)—— #${t?.id} 结案未做入库核对`);
    return [];
  }
  const head = headFiles();
  if (!head || head.size === 0) {
    if (!GATE_OFF) return null;              // unmeasurable ≠ no violations
    console.log(`交付物闸显式关闭(BOARD_DELIVERABLE_GATE=off)—— #${t?.id} 结案未做入库核对(HEAD 不可读)`);
    return [];
  }
  // ⭐ Only the worker's delivered RESULT is read. description holds requirements,
  //   history and dependencies — probes from earlier investigations, other cards'
  //   in-flight files, reference specs all legitimately appear there. Mixing it in
  //   blocks closure on things THIS card never touched (measured). The gate's
  //   subject is "named in the delivery yet absent from HEAD" — not "mentioned
  //   anywhere".
  const text = String(t?.result || "");
  return extractor.uncommittedDeliverables(text, {
    inHead: (p) => head.has(p),
    onDisk: (p) => { try { return existsSync(join(REPO_ROOT, p)); } catch { return false; } },
  });
};
// ── The describe-don't-name blind spot (INCIDENT-4's second half) ─────────────
// Measured: an attempt's evidence described behavior in detail, named not one file,
// and rode 29 uncommitted lines through to done — silence was being rewarded.
/** Uncommitted files in the work tree, [{path, mtimeMs}]. ⚠ -z mandatory (plain
 *  porcelain quotes non-ASCII paths and drops them wholesale). */
const dirtyFiles = () => {
  let out;
  try {
    out = execFileSync("git", ["-C", REPO_ROOT, "status", "--porcelain", "-z"],
                       { maxBuffer: 64 * 1024 * 1024 }).toString("utf8");
  } catch { return null; }        // unmeasurable ⇒ null ⇒ callers pass
  const rows = [];
  for (const rec of out.split("\0")) {
    if (!rec) continue;
    // `XY <path>`. A rename's OLD name arrives as the next element; it is not
    // "something touched now", so it is not picked up — picking it up inflates the
    // result toward false positives (the #1 way gates get switched off).
    const m = /^(..) (.+)$/s.exec(rec);
    if (!m) continue;
    const p = m[2];
    let mt = NaN;
    try { mt = statSync(join(REPO_ROOT, p)).mtimeMs; } catch { continue; }  // deleted → out of scope
    rows.push({ path: p, mtimeMs: mt });
  }
  return rows;
};
/** This card's LAST work span {startMs,endMs}; an open span ends "now". */
const spanOf = (t) => {
  let a = [];
  try { a = JSON.parse(t?.work_spans || "[]"); } catch { return null; }
  const last = Array.isArray(a) ? a[a.length - 1] : null;
  if (!last || !last.s) return null;
  const s = Date.parse(last.s), e = last.e ? Date.parse(last.e) : Date.now();
  return Number.isFinite(s) ? { startMs: s, endMs: Number.isFinite(e) ? e : Date.now() } : null;
};
/** Uncommitted files touched inside this worker's span that the evidence never names.
 *  Same return contract as uncommittedOf: null = unmeasurable, caller refuses. */
const unnamedOf = (t) => {
  if (!extractor) return GATE_OFF ? [] : null;
  const dirty = dirtyFiles();
  if (!dirty) {
    if (!GATE_OFF) return null;              // unmeasurable ≠ no violations
    console.log(`交付物闸显式关闭(BOARD_DELIVERABLE_GATE=off)—— #${t?.id} 结案未做作业区间核对(git status 不可读)`);
    return [];
  }
  return extractor.unnamedTouched(dirty, extractor.extractPaths(String(t?.result || "")), spanOf(t));
};

// SQL repo paths resolve only inside the server. The browser-facing object carries
// file names, hashes and controlled download endpoints — never source paths.
const taskOut = (t) => t ? {
  ...t,
  decision_package: decision.publicDecisionPackage(t, DECISION_CTX),
  // ⭐ The panel's button captions come FROM the server-side criterion. If the panel
  //   computed its own, that would be a second copy of the formula — able to say
  //   "hold" on screen while actually handing back. Meaningless outside waiting, so
  //   not computed there (list loops hundreds of rows).
  confirm_destination: t.status === "waiting" ? store.confirmDestination(db, t) : null,
} : t;

const HOST = process.env.BOARD_HOST || "127.0.0.1";
const PORT = Number(process.env.BOARD_PORT || CFG.port || 47824);
const STARTED = Date.now();

const db = store.open();

// ── Worker supervision: one loop child process per line; the panel's switches
//    drive these.
// Single-seat roles (auto-review, re-orchestration). They join the supervised set
// but NOT LINES (= the claim routing/context unit): they claim no cards and hold no
// persistent session. Gated on config AND on their loop scripts existing.
const ROLES = (CFG.roles || []).filter((r) => ["review"].includes(r));

// ⭐ The line menu is BUILT from config (never copied into prose). A hand-copied
//   list once dropped one line in two places at once — the decomposition model
//   cannot pick a line missing from its menu, so the omission silently starved that
//   line. Add a line in config and the name shows up everywhere by construction.
//   The menu itself is built in decompose_lib.js (one definition, and the tested
//   one) — a second copy here is exactly how the two-places-one-fix rot starts.
//
// v0.4: the registry is REBUILDABLE, not frozen at boot. Every consumer reads
// these bindings at call time (badRoutable, the decompose menu, the reconciler,
// /api/workers), and per-line runtime state is lazy (settingsOf / slotsOf look
// up by name) — so adding a line is: persist to the config, rebuild, announce.
// No restart, no dropped SSE clients, no in-flight worker touched.
let LINES, SUPERVISED, LINE_HINT;
function rebuildLines() {
  LINES = CFG.lines.map((l) => String(l.id));
  SUPERVISED = [...LINES, ...ROLES];
  LINE_HINT = Object.fromEntries(CFG.lines.map((l) => [l.id, l.hint || ""]));
}
rebuildLines();

// Line ids are machine contracts: the same shape badLine's route regex admits,
// and renaming is deliberately NOT offered — cards reference the id, a rename
// would orphan them. Removal is not offered either (running slots, cards on the
// line); an unused line costs nothing.
const LINE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
/** Add a line: validate → persist to the config file (atomic) → rebuild → the
 *  caller announces. Throws store.err on refusal (unknown/duplicate/role/shape). */
function addLine(idRaw, hintRaw) {
  const id = String(idRaw ?? "").trim();
  const hint = String(hintRaw ?? "").trim();
  if (!LINE_ID_RE.test(id))
    throw store.err(store.ERR.BAD_INPUT, `线名只允许小写字母/数字/-/_,1-32 位,且以字母或数字开头 —— 收到 ${JSON.stringify(id)}`);
  if (LINES.includes(id) || ROLES.includes(id) || ["review"].includes(id))
    throw store.err(store.ERR.CONFLICT, `线 ${id} 已存在(或与角色座席同名)`);
  if (hint.length > 80)
    throw store.err(store.ERR.BAD_INPUT, "hint 最多 80 字");
  // Persist FIRST: a line that exists in memory but not on disk would vanish on
  // the next restart with every card on it stranded on a name nobody claims.
  let onDisk = {};
  if (existsSync(CONFIG_FILE)) onDisk = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));   // broken = throws = refuse
  const lines = Array.isArray(onDisk.lines) && onDisk.lines.length
    ? onDisk.lines : BUILTIN_CONFIG.lines.map((l) => ({ ...l }));
  lines.push(hint ? { id, hint } : { id });
  const next = { ...onDisk, lines };
  const tmp = CONFIG_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", "utf8");
  renameSync(tmp, CONFIG_FILE);
  CFG = { ...CFG, lines };     // never mutate BUILTIN_CONFIG through the alias
  rebuildLines();
  return { id, hint };
}

const workers = new Map();   // slotKey -> { line, slot, proc, startedAt, route, log: [] }
// Parallel slots: slot 1's worker name = the line name itself (fully compatible
// with existing cards/leases/display). Slot 2+ = line@k.
const slotKey = (line, k) => k <= 1 ? line : `${line}@${k}`;
const slotsOf = (line) => { const out = [];
  for (const w of workers.values()) if (w.line === line) out.push(w);
  return out.sort((a, b) => a.slot - b.slot); };

// ⭐ The crash-backoff LADDER lives in a ledger keyed by slot identity (slotKey) —
//   not on the process container. Containers are rebuilt on every restart, so a
//   count kept there only survived if "whoever rebuilt writes it back"; with
//   parallel slots the restarter is whichever timer fires first (workerStart
//   rebuilds ALL missing slots — deliberately idempotent), so the other slot's
//   timer early-returns and nobody writes its count ⇒ slots ≥2 backed off at the
//   base forever: unattended nights restarted every 30s, each restart claiming a
//   card and waking a model — the backoff produced what it exists to prevent.
//   The fix: the count is written AT CRASH TIME against the slot identity,
//   independent of who restarts it.
// ⭐ A gate REFUSING to start is not a crash. Refusals are DETERMINISTIC — retrying
//   in an unchanged environment reproduces them letter for letter. Fed into the
//   backoff ladder, one line's ladder climbed to 457 restarts while the ledger
//   showed ~50 real work items in the same period (≈400 restarts died at the gate
//   producing nothing, and the panel only said "stopped, code=2"). Refusals carry a
//   dedicated exit code and the board STOPS WITH THE REASON instead of restarting.
//   ⚠ This number PAIRS with the python side (gates_lib.EXIT_REFUSED). Change one
//   alone and refusals silently degrade back to crash handling.
const REFUSED_EXIT = 3;
// ⭐ AN EXIT CODE IS NOT A STOP REASON. One code carries three meanings: a tree-kill
//   makes a human stop look like code 1, a board shutdown looks the same, and both
//   then look like a crash — which is the one meaning that triggers a restart. So the
//   SIDE THAT INITIATES a stop writes the reason down BEFORE killing anything, and
//   the exit handler only fills in what nobody claimed.
const STOP_REASON = Object.freeze({
  BY_USER: "stopped-by-user",
  WITH_BOARD: "stopped-with-board",
  CRASH: "crash",
  EXIT_NORMAL: "exit-normal",
});
const STOP_REASON_SET = new Set(Object.values(STOP_REASON));
const crashLadder = new Map();   // slotKey -> consecutive crashes (next delay = base * 2^(n-1))
// A maintenance boot revives nothing on its own. `everStarted` is what separates
// "intent from before this boot" (do not act on it) from "started during this
// session" (the reconciler may bring it back after a seat swap).
const NO_REVIVE = !!process.env.BOARD_NO_RESTORE;
const everStarted = new Set();
const noReviveSaid = new Set();   // say it once per line, not every reconcile tick
// A HUMAN touching start/stop resets the ladder — the ledger outlives containers,
// so the old "new container = no count" semantics must be kept explicitly.
// ⛔ Never call from the auto-restart path (exit → setTimeout → workerStart): it
//   would erase the ladder.
const resetLadder = (line) => { for (let k = 1; k <= MAX_PARALLEL; k++) crashLadder.delete(slotKey(line, k)); };

// Absolute deadline (resolved ONCE at server start; never reinterpreted).
//   · ISO form (2026-08-20T01:00, date given) = absolute. A PAST time STAYS past
//     (= already expired; rolling it forward would let a post-deadline restart run
//     until tomorrow — measured).
//   · HH:MM = human convenience: rolled once at startup to "the next such time",
//     absolute thereafter.
//   · Unparsable input is LOUDLY ignored (never silently dropped).
const BOARD_UNTIL_AT = (() => {
  const v = (process.env.BOARD_UNTIL || "").trim();
  if (!v) return null;
  if (v.includes("T")) {
    const t = Date.parse(v);
    if (Number.isNaN(t)) { console.error(`BOARD_UNTIL 解析不能: ${v} —— 忽略`); return null; }
    return t;
  }
  const m = v.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) { console.error(`BOARD_UNTIL 形不正(ISO 或 HH:MM): ${v} —— 忽略`); return null; }
  const d = new Date(); d.setHours(+m[1], +m[2], 0, 0);
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
  return d.getTime();
})();
const localIso = (ms) => { const d = new Date(ms), pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };

// Routing regexes check CHARACTER CLASS only; narrowing to known line names happens
// here. Unknown values fall to the refusal side (a permission gate, so allowlist —
// an unknown name passing through grows a ghost line in settings).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const badLine = (res, line, allowed) => allowed.includes(line) ? false
  : (json(res, 400, { error: `未知的线名: ${line}`, allowed }), true);
// ⭐ The value domain of the two DESTINATION columns (route / line). **One criterion,
//   one place.** Why strict: claim filters `route=? AND (line IS NULL OR line=?)` —
//   a stray value produces a card that sits in not_started FOREVER, claimable by
//   nobody, with no error anywhere. Not "broken" but "never starts", and the screen
//   looks perfectly normal.
// ⚠ There are THREE write roads (create / update / reopen). Writing the check at
//   each site is how one gets missed (measured: create and update carried two
//   copies of the same check while reopen sailed through). All three call THIS.
const ROUTES = CFG.routes.map(String);
if (!ROUTES.includes(store.DEFAULT_ROUTE)) {
  console.error(`拒绝启动:routes ${JSON.stringify(ROUTES)} 不含默认路由 ` +
    `"${store.DEFAULT_ROUTE}"(BOARD_DEFAULT_ROUTE)—— 用默认路由建的卡将永远无人可领`);
  process.exit(1);
}
// Ladder starting rungs. A card may say WHICH RUNG TO START ON, never a model name
// — model names on cards would hand quota allocation to whoever writes cards. The
// value gate sits in the SAME function as route/line: the three write roads already
// converge here; a separate function would split "which one do I call" for the next
// road added.
const WEIGHTS = ["light", "standard", "heavy"];
// ⚠ line and route treat null OPPOSITELY — aligning them breaks one or the other:
//   · `line: null` is LEGAL (no line = any line's worker may claim; schema allows NULL).
//   · `route: null` is INVALID: schema is NOT NULL DEFAULT — wanting the default
//     means OMITTING the key. Letting null through writes the string "null" (store
//     coerces) which never falls to the default ⇒ ghost card.
//   · `weight: null` sits on route's side (same schema shape, same judgment).
function badRoutable(res, b) {
  if (b.line !== undefined && b.line !== null && badLine(res, b.line, LINES)) return true;
  if (b.route !== undefined && !ROUTES.includes(b.route)) {
    json(res, 400, { error: `未知的路由: ${b.route}`, allowed: ROUTES });
    return true;
  }
  if (b.weight !== undefined && !WEIGHTS.includes(b.weight)) {
    json(res, 400, { error: `未知的强度权重: ${b.weight}`, allowed: WEIGHTS });
    return true;
  }
  return false;
}
// ⭐ Pick-a-card /api/claim carries NO badRoutable gate — ruled, with reasons:
//   ① a stray line there is already legal idiom (the filter is `line IS NULL OR
//     line=?`, so line:'drain' means "only give me line-less cards" — drain
//     procedures use exactly this);
//   ② the gate would catch only a SUBSET of the symptom: typo `design` for `alpha`
//     is inside the domain and looks identical to "that shelf is just empty" —
//     a gate that cannot tell the two apart leaves only false reassurance;
//   ③ what stands instead is MISS VISIBILITY: one 204 says nothing, but "how many
//     consecutive misses with the same filter, and what the filter was" does —
//     an empty shelf eventually refills and the counter resets; a typo never does.
// ⛔ On a hit the record is DELETED. Kept, it becomes a permanently red badge that
//   everyone learns to ignore = same as absent.
const claimMiss = new Map();   // worker → { n, since, at, route, line }
const MISS_MAX = 64;           // record cap (the while below drops the oldest)
function noteClaim(worker, opts, hit) {
  const w = String(worker || "");
  if (!w) return;                       // empty worker is refused by the store (400) — not recorded
  if (hit) { claimMiss.delete(w); return; }
  const prev = claimMiss.get(w);
  // ⚠ Defaults are written with the SAME expressions store.claim uses
  //   (`route || DEFAULT` / `line || worker`). A different expression would desync
  //   the record from the filter actually used — the "should match but 0 results"
  //   investigation gets harder, the same two-copies trap again.
  claimMiss.set(w, { n: (prev?.n || 0) + 1, since: prev?.since ?? Date.now(), at: Date.now(),
                     route: opts.route || store.DEFAULT_ROUTE, line: opts.line || w });
  // ⚠ Keys are caller-chosen strings — never unbounded. Overflow drops the OLDEST
  //   miss (what we show is "misses still happening"). ⛔ The just-written key is
  //   excluded from eviction — with equal timestamps, insertion order could evict it.
  while (claimMiss.size > MISS_MAX) {
    let old = null;
    for (const [k, v] of claimMiss) if (k !== w && (!old || v.at < old[1].at)) old = [k, v];
    if (!old) break;
    claimMiss.delete(old[0]);
  }
}
// Interpreter for the loops. Host config wins; otherwise probe once at boot —
// bare Ubuntu ships only `python3`, and guessing wrong used to surface as a
// spawn 'error' with no context instead of a plain sentence at startup.
const PY = process.env.BOARD_PYTHON || (() => {
  for (const c of ["python", "python3"]) {
    try { execFileSync(c, ["-c", "print(1)"], { stdio: "ignore", windowsHide: true }); return c; }
    catch {}
  }
  console.error("⚠ 找不到 python/python3 —— worker 线将无法启动(设 BOARD_PYTHON 指向解释器)");
  return "python";
})();
// ⭐ Crash-backoff BASE (default 30s; then ×2 per step, 15-minute cap is fixed).
//   Only tests shrink it (the 30s→60s ladder cannot be observed without real
//   waiting otherwise). ⛔ Never shrink in production: it directly scales how fast
//   a crash loop burns quota on unattended nights.
const CRASH_BACKOFF_MS = Math.max(1, Number(process.env.BOARD_CRASH_BACKOFF_MS) || 30_000);
const SETTINGS_FILE = join(store.DATA_DIR, "worker_settings.json");

// ── Per-card token usage, aggregated from the loop's ledger ──────────────────
// usage_ledger.jsonl is APPEND-ONLY (the loop writes one row per attempt), which
// makes incremental reading exact: remember the byte offset of the last COMPLETE
// line and fold only what's new. Re-reading the whole file on every panel refresh
// would grow linearly with fleet age for no reason.
const USAGE_FILE = join(store.DATA_DIR, "usage_ledger.jsonl");
let usageByCard = new Map();
let usageOffset = 0;
function refreshUsage() {
  let size;
  try { size = statSync(USAGE_FILE).size; } catch { return; }   // no ledger yet = no usage
  if (size < usageOffset) { usageByCard = new Map(); usageOffset = 0; }  // replaced/truncated → refold
  if (size === usageOffset) return;
  let buf;
  try {
    const fd = openSync(USAGE_FILE, "r");
    buf = Buffer.alloc(size - usageOffset);
    readSync(fd, buf, 0, buf.length, usageOffset);
    closeSync(fd);
  } catch { return; }
  const text = buf.toString("utf8");
  // ⚠ The writer may be mid-line right now. Fold only up to the last newline; the
  //   partial tail stays unconsumed and is re-read complete on the next pass.
  const NL10 = String.fromCharCode(10);
  const cut = text.lastIndexOf(NL10);
  if (cut < 0) return;
  usageOffset += Buffer.byteLength(text.slice(0, cut + 1), "utf8");
  for (const line of text.slice(0, cut).split(NL10)) {
    if (!line.trim()) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }    // a broken row is skipped, not fatal
    if (j.card == null) continue;                               // compact events carry no card
    const id = Number(j.card);
    const c = usageByCard.get(id) || { rows: 0, calls: 0, in: 0, cc: 0, cr: 0, out: 0 };
    c.rows++; c.calls += Number(j.calls) || 0;
    c.in += Number(j["in"]) || 0; c.cc += Number(j.cc) || 0;
    c.cr += Number(j.cr) || 0; c.out += Number(j.out) || 0;
    usageByCard.set(id, c);
  }
}
const MAX_PARALLEL = Math.max(1, Number(CFG.max_parallel) || 3);
const DEFAULT_AGENT = { ...CFG.default_agent };
const DEFAULT_SET = { agents: [{ ...DEFAULT_AGENT }], rev: 0 };
const DECOMPOSE_MODELS = CFG.decompose_models;
// Natural language for GENERATED content (decomposed cards today; other generators
// later). Empty = say nothing, and the generator mirrors the prompt's own language.
const LANGUAGE = String(CFG.language || "").trim();

// Seats. A seat may declare release_env (must be "1" to unlock) and cmd_env (host
// must point it at the CLI). Locked seats are visible but refuse save/start —
// visibility without permission is how permission stays a HUMAN act.
const seatUnlocked = (r) => !r.release_env || process.env[r.release_env] === "1";
const seatCmdOk = (r) => !r.cmd_env || !!process.env[r.cmd_env];
const RUNTIMES = CFG.runtimes.map((r) => ({
  ...r, disabled: !seatUnlocked(r),
  label: seatUnlocked(r) ? r.label : `${r.label}(未解禁)`,
}));
const RUNTIME_IDS = RUNTIMES.map((r) => r.id);
const EFFORTS = RUNTIMES[0]?.efforts || ["low", "medium", "high"];
const MODELS = RUNTIMES[0]?.models || [];

// ── Subscription-pool state. "Exhausted" is detected by the API's rate-limit
//    FAILURE, never predicted by dollar/token arithmetic (INCIDENT-8).
const POOL_IDS = RUNTIME_IDS;
const POOL_HOLD_MS = Math.max(100, Number(process.env.BOARD_POOL_HOLD_MS) || 5 * 60 * 60 * 1000);
const POOL_RECONCILE_MS = Math.max(50, Number(process.env.BOARD_POOL_RECONCILE_MS) || 5000);
const POOL_FILE = join(store.DATA_DIR, "pool_state.json");
const POOL_STOP_FILE = join(store.DATA_DIR, "pool_global_stop.json");
const { writeFileSync: wfs, renameSync, unlinkSync } = require_("node:fs");
const emptyPools = () => Object.fromEntries(POOL_IDS.map((p) => [p, { exhausted_at: null, until: null }]));
const validPoolEntry = (v) => {
  const a = Date.parse(v?.exhausted_at || ""), u = Date.parse(v?.until || "");
  return Number.isFinite(a) && Number.isFinite(u) && u > a
    ? { exhausted_at: new Date(a).toISOString(), until: new Date(u).toISOString() }
    : { exhausted_at: null, until: null };
};
let poolState = emptyPools();
try {
  const raw = JSON.parse(readFileSync(POOL_FILE, "utf8"));
  for (const p of POOL_IDS) poolState[p] = validPoolEntry(raw?.[p]);
} catch { /* first run / broken file: start empty; next save restores the shape */ }
const poolDown = (p) => !!poolState[p]?.exhausted_at; // even past `until`, down until a probe succeeds
const bothPoolsDown = () => POOL_IDS.every(poolDown);
function savePools() {
  const tmp = POOL_FILE + ".tmp";
  wfs(tmp, JSON.stringify(poolState, null, 1), "utf8");
  renameSync(tmp, POOL_FILE);
}
function markPoolDown(runtime, observedAt = Date.now()) {
  const at = Number(observedAt);
  const now = Date.now();
  // A badly skewed loop clock must not extend the hold window into the future.
  const safeAt = Number.isFinite(at) && Math.abs(at - now) <= 5 * 60 * 1000 ? at : now;
  poolState[runtime] = { exhausted_at: new Date(safeAt).toISOString(),
                         until: new Date(safeAt + POOL_HOLD_MS).toISOString() };
  savePools();
  return poolState[runtime];
}
function clearPool(runtime) {
  poolState[runtime] = { exhausted_at: null, until: null };
  savePools();
}
function updateGlobalStopMarker(reason = "pool-state-change") {
  if (bothPoolsDown()) {
    const next = Math.min(...POOL_IDS.map((p) => Date.parse(poolState[p].until)));
    const body = { active: true, reason: "all pools exhausted",
                   observed_at: new Date().toISOString(), next_recheck_at: new Date(next).toISOString(),
                   trigger: reason };
    const tmp = POOL_STOP_FILE + ".tmp";
    wfs(tmp, JSON.stringify(body, null, 1), "utf8"); renameSync(tmp, POOL_STOP_FILE);
  } else {
    try { unlinkSync(POOL_STOP_FILE); } catch (e) { if (e?.code !== "ENOENT") throw e; }
  }
}

// Saved settings stay untouched; only the SPAWN maps a seat onto the other pool.
function failoverAgent(ag, runtime) {
  const seat = seatOf(runtime);
  if (!seat || !seat.models?.length) return null;
  const model = seat.models[0].id;
  const dom = effortsFor(runtime, model);
  // ⭐ Failover preserves WORKING STRENGTH: keep the effort when the target seat
  //   declares it; otherwise take the seat's HIGHEST declared tier (domains are
  //   declared low→high, so the last entry is the top). The earlier draft fell
  //   back to "high", silently DOWNGRADING a max slot on every pool switch — a
  //   policy nobody chose, visible only in the ledger weeks later.
  const effort = dom.includes(ag.effort) ? ag.effort : dom[dom.length - 1];
  return { ...ag, runtime, model, effort };
}
function effectiveAgents(line, st = settingsOf(line)) {
  if (bothPoolsDown()) return null;
  // Roles are single-seat but share the same runtime branches as ordinary lines:
  // only agents[0] is taken; failover, model mapping and gates run the same road.
  const single = ROLES.includes(line);
  const src = single ? [st.agents[0]] : st.agents;
  const mapOne = (ag) => {
    const rt = ag.runtime || RUNTIME_IDS[0];
    if (!poolDown(rt)) return ag;
    const other = POOL_IDS.find((p) => p !== rt && !poolDown(p));
    if (!other) return null;
    const seat = seatOf(other);
    if (!seat || seat.disabled || !seatCmdOk(seat)) return null;
    return failoverAgent(ag, other);
  };
  const mapped = src.map(mapOne);
  return mapped.every(Boolean) ? mapped : null;
}
/** Seats and their model/effort domains. ⭐ THE single resolver — the save gate, the
 *  probe and the panel all go through it (write the domain twice and the UI offers
 *  a forbidden rung the day only one copy is fixed). */
const seatOf = (rt) => RUNTIMES.find((r) => r.id === (rt || RUNTIME_IDS[0]));
const effortsFor = (rt, modelId) => {
  const seat = seatOf(rt);
  if (!seat) return EFFORTS;
  const m = (seat.models || []).find((x) => x.id === modelId);
  return (m && m.efforts) || seat.efforts || EFFORTS;
};

// ───────── Line lineage: inheriting memory from a desktop conversation ─────────
// A worker's session is born from randomUUID = a newcomer who knows NOTHING. Each
// line can be forked ONCE (--fork-session) from a designated desktop conversation:
// the original stays untouched, the live context fits the window, and resume across
// project dirs is measured to work.
// ⚠ Conversation ids are PERSONAL. In source they enter git and leave with a push
//   (measured on the origin). They live in .data/ (gitignored); the template is
//   examples/lineage.example.json. Absent = no inheritance, board runs fine.
const LINEAGE_FILE = join(store.DATA_DIR, "lineage.json");
let LINEAGE = {};
try {
  const raw = JSON.parse(readFileSync(LINEAGE_FILE, "utf8"));
  for (const [k, v] of Object.entries(raw))
    if (!k.startsWith("_") && v && v.session) LINEAGE[k] = v;
} catch { /* fine to be absent; the startup log says so */ }
const CLAUDE_CLI = process.env.WORKER_CLAUDE_CLI || "claude";
const PROJECTS = join(homedir(), ".claude", "projects");
let settings = {};
try { settings = JSON.parse(readFileSync(SETTINGS_FILE, "utf8")); } catch {}
// One-time migration: legacy {model,effort,window,parallel,runtime} → agents[]
// (parallel copies). Legacy keys are DELETED and written back — kept, they are
// "the same fact in two places" and will drift.
const agentOf = (src) => ({
  runtime: src?.runtime || DEFAULT_AGENT.runtime, model: src?.model || DEFAULT_AGENT.model,
  effort: src?.effort || DEFAULT_AGENT.effort, window: !!src?.window });
{
  let migrated = false;
  for (const [ln, e] of Object.entries(settings)) {
    if (!e || typeof e !== "object" || Array.isArray(e.agents)) continue;
    const n = Math.max(1, Math.min(MAX_PARALLEL, Number(e.parallel) || 1));
    e.agents = Array.from({ length: n }, () => agentOf(e));
    for (const k of ["model", "effort", "window", "parallel", "runtime"]) delete e[k];
    migrated = true;
    console.log(`worker_settings: ${ln} 旧形 → agents[${n}] 迁移`);
  }
  if (migrated) writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 1), "utf8");
}
const settingsOf = (line) => {
  const raw = { ...DEFAULT_SET, ...(settings[line] || {}) };
  raw.agents = (Array.isArray(raw.agents) && raw.agents.length ? raw.agents : [DEFAULT_AGENT]).map(agentOf);
  return raw;
};

/** The line's persistent session id; minted and persisted on first use. */
function sessionOf(line) {
  if (!settings[line]?.session_id) {
    settings[line] = { ...settingsOf(line), session_id: randomUUID() };
    writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 1), "utf8");
  }
  return settings[line].session_id;
}

/** Whether the line has been forked from its desktop conversation yet. */
function lineageOf(line) {
  const L = LINEAGE[line];
  if (!L) return null;
  return { ...L, forked: !!settings[line]?.forked_from };
}
function markForked(line, newSessionId) {
  settings[line] = { ...settingsOf(line), session_id: newSessionId,
                     forked_from: LINEAGE[line]?.session || null,
                     forked_at: new Date().toISOString() };
  writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 1), "utf8");
  emit("worker.changed", { line });
  return settings[line];
}

/** Find the transcript file. Scanning beats composing the slug (slugs rot). */
function transcriptOf(sid) {
  try {
    for (const d of readdirSync(PROJECTS)) {
      const p = join(PROJECTS, d, sid + ".jsonl");
      if (existsSync(p)) return p;
    }
  } catch {}
  return null;
}

/**
 * The line's real context size.
 * ⭐ The gauge is the LAST assistant turn's usage (input + cache_creation +
 *   cache_read) — what actually entered the model that turn. File bytes are only a
 *   rough hint.
 */
function contextOf(line) {
  // ⚠ A listing read must not MINT a session (sessionOf allocates when absent).
  //   Lines without persistent sessions would grow ghost ids — peek only.
  const sid = settings[line]?.session_id || null;
  if (!sid) return { line, session_id: null, transcript: null, exists: false, no_session: true,
                     bytes: 0, messages: 0, tokens: null, last_compact: null, compactions: 0 };
  const path = transcriptOf(sid);
  const out = { line, session_id: sid, transcript: path, exists: !!path,
                bytes: 0, messages: 0, tokens: null, last_compact: null, compactions: 0 };
  if (!path) return out;
  out.bytes = statSync(path).size;
  let lastUsage = null;
  for (const ln of readFileSync(path, "utf8").split(String.fromCharCode(10))) {
    if (!ln.trim()) continue;
    let d; try { d = JSON.parse(ln); } catch { continue; }
    out.messages++;
    const u = d.message?.usage;
    if (u) lastUsage = u;
    // ⭐ Crossing a compaction boundary RESETS the gauge. Usage before the boundary
    //   is the PRE-compaction context, not the current one (reading it once
    //   produced the lie "compacted yet grew").
    if (d.subtype === "compact_boundary" || d.compactMetadata) lastUsage = null;
    if (d.compactMetadata) {
      out.compactions++;
      out.last_compact = {
        trigger: d.compactMetadata.trigger,
        pre: d.compactMetadata.preTokens, post: d.compactMetadata.postTokens,
        dropped: d.compactMetadata.cumulativeDroppedTokens,
        at: d.timestamp || null,
      };
    }
  }
  if (lastUsage) out.tokens = (lastUsage.input_tokens || 0)
    + (lastUsage.cache_creation_input_tokens || 0) + (lastUsage.cache_read_input_tokens || 0);
  else if (out.last_compact) out.tokens = out.last_compact.post;   // right after compaction = no next turn yet
  return out;
}

const runCli = (args, timeout = 600000) => new Promise((resolve) => {
  execFile(CLAUDE_CLI, args, { timeout, maxBuffer: 8 << 20, windowsHide: true,
                               env: { ...process.env, PYTHONIOENCODING: "utf-8" } },
    (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout: stdout || "", stderr: stderr || "" }));
});

/**
 * Decompose a goal into child tasks.
 * The LLM only WRITES A JSON FILE — the server creates the cards. Letting the
 * decomposer hit the board API makes failure and partial application inseparable.
 */
async function decomposeGoal(goalId, model) {
  const g = store.get(db, goalId);
  // Missing-id checks are classified too — untyped, this would fall to 400 and
  // punch a hole in the "missing ids are 404" ruling (found by grep once).
  if (!g) throw store.err(store.ERR.NOT_FOUND, `目标 ${goalId} 不存在`);
  if (g.kind !== "goal") throw store.err(store.ERR.BAD_INPUT, `#${goalId} 不是目标`);
  const outDir = join(store.DATA_DIR, "decompose");
  const out = join(outDir, `goal-${goalId}.json`);
  try { require_("node:fs").mkdirSync(outDir, { recursive: true }); } catch {}
  try { require_("node:fs").unlinkSync(out); } catch {}

  // ⭐ The prompt is assembled in decompose_lib.js so it can be MEASURED. Built here
  //   it was unreachable by any harness: this module listens on import, and neither a
  //   .cmd stub (Node refuses to spawn one) nor a Node stub (it rejects the unknown
  //   flags before any preload) can observe the arguments. See that file's header.
  const prompt = decompose.buildDecomposePrompt({
    goal: g,
    prev: g.parent_id != null ? store.get(db, g.parent_id) : null,
    outPath: out, lines: LINES, hints: LINE_HINT, language: LANGUAGE,
  });

  const r = await runCli(["-p", prompt, "--model", model || DECOMPOSE_MODELS[0].id,
                          "--effort", "high", "--permission-mode", "acceptEdits",
                          "--allowedTools", "Read", "Glob", "Grep", "Write",
                          "--add-dir", REPO_ROOT,
                          "--add-dir", __dirname]);
  let raw;
  // The three failures below are OUR internal failures (child would not start /
  // did not honor the contract). The request is fine, so a 400 would tell the
  // caller "resending is pointless" — a lie ⇒ INTERNAL 500.
  try { raw = readFileSync(out, "utf8"); }
  catch { throw store.err(store.ERR.INTERNAL, `拆解没写出结果文件(rc=${r.code})。尾部:${(r.stdout + r.stderr).slice(-400)}`); }
  const mm = raw.match(/\{[\s\S]*\}/);
  let d; try { d = JSON.parse(mm ? mm[0] : raw); }
  catch (e) { throw store.err(store.ERR.INTERNAL, `拆解结果不是合法 JSON:${e.message}`); }
  const list = Array.isArray(d.tasks) ? d.tasks : [];
  // ⚠ "Zero children" is internal too: the prompt says "emit exactly 1 if it will
  //   not split", so an empty array means the upstream ignored instructions — not
  //   that the goal was badly written (≠ BAD_INPUT).
  if (!list.length) throw store.err(store.ERR.INTERNAL, "拆解结果里没有子任务");

  // Create in order; `after` indices translate to already-created ids.
  const made = [];
  // ⭐ This is a WRITE ROAD with no HTTP counterpart to 400 at — the line values come
  //   from a MODEL's output. Out-of-domain lines fall to null (= no line): the
  //   reversible failure. A stray value stored raw would never match claim's filter
  //   and rot silently in not_started — the exact pathology the domain gate exists
  //   for. ⚠ Three-state preserved: "model said unsure" (null) and "model emitted an
  //   out-of-domain name" (typo) are DIFFERENT things — the latter is recorded on
  //   the card face and counted in the response (never silently converted).
  const demoted = [];
  list.forEach((t, i) => {
    const deps = (t.after || []).map((n) => made[Number(n) - 1]).filter((x) => x != null);
    const want = t.line && t.line !== "null" ? String(t.line) : null;
    const line = (want === null || LINES.includes(want)) ? want : null;
    let description = String(t.description || "");
    if (want !== null && line === null) {
      demoted.push({ n: i + 1, subject: String(t.subject || "(无题)"), line: want });
      description += String.fromCharCode(10, 10) +
        `⚠拆解时给的线名「${want}」不在可选表内(${LINES.join("/")}),已落为「不指定线」` +
        "——谁都能领,但没人被点名。请人工确认该派给哪条线。";
    }
    made[i] = store.add(db, {
      subject: String(t.subject || "(无题)"), description,
      acceptance: String(t.acceptance || ""), line,
      needsBash: !!t.needs_bash, blockedBy: deps, kind: "task", parentId: goalId,
      // The release valve moved to worker start/stop (ruling): decomposed children
      // are claimable from birth; "not yet" is expressed by not starting that
      // line's worker.
      released: 1,
    });
  });
  emit("goal.decomposed", { id: goalId, made });
  // demoted = children whose line name was dropped (empty = normal): the one
  // machine-readable mouth for "the model misspelled a line" — the card face has it
  // too, but that is for humans.
  return { goal: goalId, model: model || DECOMPOSE_MODELS[0].id, made, count: made.length,
           demoted };
}

/**
 * One-click context tidy = two steps:
 *  ① the conversation writes its OWN handover memo (it knows best what to keep)
 *  ② `/compact <memo>` flows into the same conversation.
 * Both pass headless (measured: compact_boundary lands in the transcript).
 */
async function compactLine(line, note) {
  const sid = sessionOf(line);
  // The line exists (badLine passed) but has no conversation yet = the BOARD STATE
  // refuses ⇒ CONFLICT (it passes once the line has run).
  if (!transcriptOf(sid)) throw store.err(store.ERR.CONFLICT, `${line} 还没有会话记录,没什么可整理的`);
  const before = contextOf(line);
  let memo = (note || "").trim();
  if (!memo) {
    const ask = await runCli(["-p",
      "接下来要对你自己这个会话做 /compact。请只输出一段【压缩指示】,告诉压缩程序哪些必须保留:" +
      "正在做的任务与其编号、已确认的事实与实测数字、踩过的坑与结论、未完成的下一步、" +
      "以及任何再问一遍代价很大的东西。不要复述全部历史,不要寒暄,不要用代码块,300 字以内。",
      "--resume", sid, "--model", settingsOf(line).agents[0].model, "--effort", "low"]);
    memo = (ask.stdout || "").trim().slice(0, 1200);
  }
  if (!memo) memo = "保留当前任务、已确认的事实与数字、未完成的下一步。";
  const r = await runCli(["-p", "/compact " + memo, "--resume", sid,
                          "--model", settingsOf(line).agents[0].model]);
  const after = contextOf(line);
  const did = after.compactions > before.compactions;
  // ⭐ The reported numbers come from the transcript's compactMetadata (pre/post).
  //   Our own gauge reads only the LAST turn and would pick up the memo-writing turn
  //   added just before compaction — it once produced "compacted yet grew".
  return { line, memo, cli_code: r.code, compactions: after.compactions, compacted: did,
           before: did ? after.last_compact.pre : before.tokens,
           after: did ? after.last_compact.post : after.tokens,
           dropped: did ? after.last_compact.dropped : 0,
           note: did ? "已压缩" :
                 "CLI 返回了,但转录里没有新的 compact 记录 —— 请看 memo 是否被当成普通提问" };
}
function setSettings(line, patch) {
  const cur = settingsOf(line);
  const next = { ...cur };
  // Settings accept agents[] (per-slot) only. Legacy keys are refused BY NAME —
  // silently ignoring them creates "200 yet zero columns changed" no-op accidents.
  // All refusals here are BAD_INPUT (same body, same result, forever).
  for (const k of ["model", "effort", "window", "parallel", "runtime"])
    if (patch[k] !== undefined)
      throw store.err(store.ERR.BAD_INPUT, `${k} 已迁入 agents[] —— 请整体提交 agents(旧档已自动迁移)`);
  if (patch.agents !== undefined) {
    if (!Array.isArray(patch.agents) || !patch.agents.length)
      throw store.err(store.ERR.BAD_INPUT, "agents 必须是非空数组");
    const single = ROLES.includes(line);
    if (patch.agents.length > (single ? 1 : MAX_PARALLEL))
      throw store.err(store.ERR.BAD_INPUT,
                      single ? `${line} 职务单线 —— 只能单槽`
                             : `并行上限 ${MAX_PARALLEL}(全线共享额度)`);
    // ⭐ CAS: agents[] can ONLY be written compare-and-swap. The panel does
    //   read-modify-write and the board is touched from more than one screen —
    //   without rev, last-write-wins silently reverts someone's fix and nobody sees
    //   it until the next start. ⚠ Compare and write complete INSIDE this
    //   synchronous block (an await between them un-CASes the CAS).
    //   · rev mismatch = CONFLICT (409): re-read and the same edit passes.
    //   · rev missing  = BAD_INPUT (400): the body is wrong, forever.
    const curRev = Number(cur.rev || 0);
    if (patch.rev === undefined)
      throw store.err(store.ERR.BAD_INPUT,
        `保存必须带 rev(当前 ${curRev})—— 先读取再提交,避免两处面板互相覆盖`);
    if (Number(patch.rev) !== curRev)
      throw store.err(store.ERR.CONFLICT,
        `设置已被他处改动(你基于 rev ${patch.rev},现在是 ${curRev})—— 重新读取后再保存`);
    next.agents = patch.agents.map((a, i) => {
      const rt = seatOf(a?.runtime);
      if (!rt) throw store.err(store.ERR.BAD_INPUT, `Agent${i + 1}: 未知运行时 ${a?.runtime}`);
      // ⚠ A locked seat refuses with BAD_INPUT: unlocking is a separate human act;
      //   resending later does not pass ⇒ the caller may give up (4xx, not 409).
      if (rt.disabled) throw store.err(store.ERR.BAD_INPUT,
        `Agent${i + 1}: ${rt.label} —— 未获解禁(${rt.release_env} 闸),保存拒绝`);
      // ⭐ Models AND rungs are judged by the SEAT's declaration (judging by the
      //   global tables would let a codex slot save a claude model and die with a
      //   400 only at start).
      if (!(rt.models || []).some((m) => m.id === a?.model))
        throw store.err(store.ERR.BAD_INPUT, `Agent${i + 1}: ${rt.label} 没有模型 ${a?.model}`);
      const dom = effortsFor(a?.runtime, a?.model);
      if (!dom.includes(a?.effort))
        throw store.err(store.ERR.BAD_INPUT,
          `Agent${i + 1}: ${a?.model} 的强度必须是 ${dom.join("/")}(座席宣言值域)`);
      return { runtime: a.runtime || RUNTIME_IDS[0], model: a.model, effort: a.effort, window: !!a.window };
    });
    next.rev = curRev + 1;
  }
  settings[line] = next;
  writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 1), "utf8");
  emit("worker.changed", { line });
  return next;
}

/** "Wanted running" is a SETTING, not the presence of a process. Without it, every
 *  dev restart silently halts the processing chain (measured twice). */
function setDesired(line, on) {
  settings[line] = { ...settingsOf(line), desired_running: !!on };
  writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 1), "utf8");
}

/**
 * Write down WHY a line stopped. The initiator calls this BEFORE the tree kill; the
 * exit handler only fills in unexplained exits. `last_stop` survives a board restart
 * (that is the only way "stopped with the board" can still be told afterwards), while
 * the per-slot copy keeps parallel slots from being judged separately by exit code
 * during one stop of the line.
 * Unknown values throw: a reason nobody defined must not reach the ledger.
 */
function recordStop(line, reason, targets = []) {
  if (!STOP_REASON_SET.has(reason)) throw new Error(`未知 stop_reason: ${reason}`);
  const event = { reason, at: new Date().toISOString() };
  for (const w of targets) w.stopReason = event;
  settings[line] = { ...settingsOf(line), last_stop: event };
  try { writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 1), "utf8"); }
  catch (e) { console.error(`${line} stop_reason 无法持久化:`, e.message); }
  return event;
}

/** A stored reason is only usable if BOTH parts survive — an unparseable timestamp or
 *  an unknown reason reads as "no reason", never as a guess. */
const validStop = (v) => v && STOP_REASON_SET.has(v.reason) && Number.isFinite(Date.parse(v.at || ""))
  ? { reason: v.reason, at: new Date(Date.parse(v.at)).toISOString() } : null;

/** The one place a reason becomes words. The panel renders this string and maps
 *  nothing itself — two mapping tables would drift. */
function stopText(stop, exitCode) {
  const s = validStop(stop);
  if (!s) return exitCode === REFUSED_EXIT ? `启动被拒绝 code=${REFUSED_EXIT}`
                                           : (exitCode == null ? "" : `已停止 code=${exitCode}`);
  const at = s.at.replace("T", " ").replace(/\.\d{3}Z$/, "Z");
  if (s.reason === STOP_REASON.BY_USER) return `用户停止 · ${at}`;
  if (s.reason === STOP_REASON.WITH_BOARD) return `随看板停止 · ${at}`;
  if (s.reason === STOP_REASON.EXIT_NORMAL) return `正常结束 · ${at}`;
  return `崩溃${exitCode == null ? "" : ` code=${exitCode}`} · ${at}`;
}

const loopScriptOf = (line) =>
  line === "review" ? join(LOOPS_DIR, "reviewer_loop.py")
  : join(LOOPS_DIR, "worker_loop.py");

function workerStart(line, route = store.DEFAULT_ROUTE, agentsOverride = null) {
  // ⭐ An EXPIRED window refuses new starts. Measured before this check: with
  //   BOARD_UNTIL in the past, start returned 200 and the slot came up with NO
  //   --until at all — the operator's deadline, once passed, silently became "no
  //   deadline ever". The crash-restart path already checked expiry; a guard on
  //   one entry point is not a guard (INCIDENT-11's shape, again).
  if (BOARD_UNTIL_AT && Date.now() >= BOARD_UNTIL_AT)
    throw store.err(store.ERR.CONFLICT,
      `看板窗已过(BOARD_UNTIL=${localIso(BOARD_UNTIL_AT)})—— 不再起新线。` +
      `要继续:换个 BOARD_UNTIL 重启看板,或不设截止`);
  everStarted.add(line);          // this boot has acted on the line (see NO_REVIVE)
  const st = settingsOf(line);
  const isReview = line === "review";
  // The loop script must exist (an incomplete install can lack loops/). Spawning a
  // missing file exits 2 and CLIMBS THE CRASH LADDER — refuse by name instead.
  const script = loopScriptOf(line);
  if (!existsSync(script))
    throw store.err(store.ERR.INTERNAL,
      `${line}: loop 脚本缺失(${script})—— loops/ 组件未安装,无从启动`);
  // Parallel applies to worker lines only (roles are single-seat). Settings are
  // read at start — changing them mid-run does not add/remove slots ("stop then
  // start to apply" is the standing contract).
  const agents = agentsOverride || effectiveAgents(line, st);
  if (!agents) throw store.err(store.ERR.CONFLICT,
    `${line} 当前没有可执行座席(池失效或该线无对应 runtime 分支)—— 保留运行意图,等待池复查`);
  const want = agents.length;
  const missing = [];
  for (let k = 1; k <= want; k++) if (!workers.get(slotKey(line, k))?.proc) missing.push(k);
  // Start/stop refusals are CONFLICT: the request is right; today's BOARD says no —
  // the same request passes once the board changes.
  if (!missing.length) throw store.err(store.ERR.CONFLICT, `${line} 已经在跑了(${want} 槽全在)`);
  // The unattended-night deadline. ⭐ Passed down as an ABSOLUTE local timestamp.
  //   ⚠ Prior art: the ISO was GENERATED above while an old HH:MM regex FILTERED it
  //   here → args=[] → the deadline silently dropped, and 253 self-tests stayed
  //   green because none of them read the child's argv. Lesson: fix the producer,
  //   then COUNT THE CONSUMERS. Now the only check is "is there a resolved
  //   absolute deadline"; no regex remains.
  const untilArgs = (BOARD_UNTIL_AT && Date.now() < BOARD_UNTIL_AT)
    ? ["--until", localIso(BOARD_UNTIL_AT)] : [];
  // Seat prerequisites are checked AT THE START REQUEST, by name (a missing CLI
  // path would exit 2 and climb the ladder loudly-but-illegibly). ⚠ The worker-side
  // gate STAYS — start roads that bypass this function (manual runs, tests) must
  // hit the same criterion; that duplication IS the defense.
  for (const k of missing) {
    const ag0 = agents[k - 1];
    const seat = seatOf(ag0.runtime);
    if (seat?.cmd_env && !process.env[seat.cmd_env])
      throw store.err(store.ERR.BAD_INPUT,
        `Agent${k} 是 ${seat.id} 槽,但宿主没有配置 ${seat.cmd_env}(必填绝对路径)—— 拒绝启动`);
    // window=true opens a cmd.exe console — a Windows-only affordance. On POSIX it
    // would spawn a literal "cmd" (ENOENT) and, pre-error-handler, took the board
    // down with it. Refuse by name instead of failing mysteriously.
    if (ag0.window && process.platform !== "win32")
      throw store.err(store.ERR.BAD_INPUT,
        `Agent${k} 配置了 window=true(打开控制台窗口),这只在 Windows 上可用 —— 拒绝启动`);
  }
  for (const k of missing) startSlot(line, k, route, agents[k - 1], untilArgs, isReview);
  setDesired(line, true);
  return workerInfo(line);
}

/** The environment the child ACTUALLY receives. ⭐ THE single assembly point — the
 *  runtime probe calls the same function. A probe assembling its own env copy
 *  cannot detect "passes on the desktop, dies under server start" (it would be
 *  measuring the room next door). */
function slotEnv(line, k, ag, isReview) {
  const lg = lineageOf(line);
  return { ...process.env, PYTHONIOENCODING: "utf-8",
           // ⭐ Tell the child WHERE THIS BOARD IS. A child must never guess its
           //   parent's address: the loop's BOARD_URL default is the standard port, so
           //   a board on any other port used to spawn workers that talked to whatever
           //   was listening on the default one. Measured during extraction: a smoke
           //   board on a spare port spawned a slot that went knocking on the machine's
           //   REAL board (refused only because the data dir's token did not match).
           //   The port is known here; passing it removes the guess.
           BOARD_URL: `http://127.0.0.1:${PORT}`,
           // Same principle for the gate env and the work repo: the server KNOWS
           // the resolved values — pass them so a supervised child never depends
           // on the shell it happened to inherit (a second shell missing
           // BOARD_GATED_SUBTREE was a measured cold-walkthrough trap).
           ...(CFG_GATED_SUBTREE ? { BOARD_GATED_SUBTREE: CFG_GATED_SUBTREE } : {}),
           BOARD_REPO: REPO_ROOT,
           WORKER_MODEL: ag.model, WORKER_EFFORT: ag.effort,
           WORKER_RUNTIME: ag.runtime || RUNTIME_IDS[0],
           REVIEWER_MODEL: ag.model, REVIEWER_EFFORT: ag.effort,
           ...(isReview ? {} : k === 1 ? {
             WORKER_SESSION: sessionOf(line),
             // Not yet forked → the first run forks from the desktop conversation
             ...(lg && !lg.forked ? { WORKER_FORK_FROM: lg.session } : {}),
             ...(lg ? { WORKER_ANCHOR: lg.anchor } : {}),
           } : {
             // Extra slots (2+) run a FRESH session per card. The persistent
             // session is slot 1's private property — two processes resuming the
             // same session corrupt the transcript. Only the anchor is passed.
             ...(lg ? { WORKER_ANCHOR: lg.anchor } : {}),
           }) };
}

function startSlot(line, k, route, ag, untilArgs, isReview) {
  const key = slotKey(line, k);
  const args = isReview
    ? [loopScriptOf(line), "--interval", "300", ...untilArgs]
    : [loopScriptOf(line), "--as", line,
       ...(k > 1 ? ["--worker", key] : []),
       "--route", route, "--interval", "60", ...untilArgs];
  const env = slotEnv(line, k, ag, isReview);
  // ⭐ The KEY NAMES of the WORKER_*/REVIEWER_* env the child actually receives
  //   (values withheld — WORKER_SESSION is a real conversation id and slot tails go
  //   out over HTTP). Without this, "slot 2 gets no WORKER_SESSION" never appears
  //   in argv and becomes an unobservable property — and unobservable contracts get
  //   silently deleted by the next rewrite.
  // ⚠ Read from `env` ITSELF, not the assembled diff: a WORKER_SESSION inherited
  //   from the parent process is the same one to the child — listing only the diff
  //   would make "not passed" a lie.
  const envKeys = Object.keys(env).filter((n) => /^(WORKER|REVIEWER|REORG)_/.test(n)).sort();
  // Test hook: BOARD_SPAWN_ECHO=1 skips the spawn and logs the assembled argv.
  //   The deadline bug (producer/filter divergence) is detectable only by reading
  //   what actually reaches the child — the harness reads this echo and asserts
  //   --until/--worker existence (deleting them turns it red = detection ability).
  if (process.env.BOARD_SPAWN_ECHO) {
    // Slot config echoed too — "did each slot really get its own model/effort" is
    // only assertable from here (env does not show in argv).
    workers.set(key, { line, slot: k, echo: true, proc: null, startedAt: Date.now(), route,
                       settings: ag, log: ["[spawn-echo] " + JSON.stringify([PY, ...args]) +
                                           " [slot-cfg] " + JSON.stringify({ slot: k, ...ag }) +
                                           " [slot-env] " + JSON.stringify(envKeys)] });
    emit("worker.changed", { line, running: false });
    return;
  }
  // window=true opens a real console (when the human wants to watch). stdout then
  // does not flow here, so the panel's log tail stays empty.
  // ⭐ On POSIX the child gets ITS OWN PROCESS GROUP (detached). Without it, the
  //   stop path's kill(-pid) targets a group that does not exist and ALWAYS throws
  //   ESRCH — the POSIX tree-kill had plausibly never worked, and CI stayed green
  //   only because the test stubs are single processes. Windows keeps the default:
  //   the tree is walked by taskkill /T, no group needed.
  const proc = ag.window
    ? spawn("cmd", ["/c", "start", `worker:${key}`, "cmd", "/k", PY, ...args],
            { cwd: __dirname, env, windowsVerbatimArguments: false })
    : spawn(PY, args, { cwd: __dirname, env, detached: process.platform !== "win32" });
  const w = { line, slot: k, proc, startedAt: Date.now(), route, log: [], settings: ag, detached: ag.window };
  // ⚠ Without this handler a spawn failure (interpreter missing, ENOENT) is an
  //   unhandled 'error' event and KILLS THE WHOLE BOARD — the supervisor dying of
  //   one child's absence. Record it like any other unexplained stop.
  proc.on("error", (e) => {
    w.log.push(`[spawn 失败: ${e.message}]`);
    if (w.proc) { w.proc = null; w.exitedAt = Date.now(); w.exitCode = -1; }
    if (!validStop(w.stopReason)) recordStop(line, STOP_REASON.CRASH, [w]);
    console.error(`${key} spawn 失败:`, e.message);
    emit("worker.changed", { line, running: false });
  });
  const push = (b) => {
    for (const ln of String(b).split(/\r?\n/)) if (ln.trim()) w.log.push(ln.trim());
    if (w.log.length > 60) w.log.splice(0, w.log.length - 60);
    emit("worker.log", { line });
  };
  proc.stdout.on("data", push);
  proc.stderr.on("data", push);
  proc.on("exit", (code) => {
    w.log.push(`[进程退出 code=${code}]`);
    w.proc = null; w.exitedAt = Date.now(); w.exitCode = code;
    // If the initiator already put a reason down, the OS's code=1 must not overwrite it
    // with "crash". Only an unexplained exit is classified here; refusals keep their
    // own road below and are deliberately left without a recorded reason.
    let stop = validStop(w.stopReason);
    if (!stop && code !== REFUSED_EXIT)
      stop = recordStop(line, code === 0 ? STOP_REASON.EXIT_NORMAL : STOP_REASON.CRASH, [w]);
    // A loop dying does not kill the model CLI it spawned — an orphaned model keeps
    // writing files with nobody reading its output. Sweep the tree, return the cards.
    if (process.platform === "win32")
      spawn("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { windowsHide: true });
    else try { process.kill(-proc.pid, "SIGKILL"); } catch {}   // group kill; gone already = fine
    try {
      // ⭐ Reclaim by the SLOT's worker name — reclaiming by line name would return
      //   OTHER slots' in-flight cards too.
      const freed = store.releaseHeldBy(db, key);
      if (freed.length) {
        w.log.push(`[在途 ${freed.join(",")} 收回未开始]`);
        emit("task.reaped", { count: freed.length });
      }
    } catch (e) { console.error(`${key} 退出后的返还失败:`, e.message); }

    // ⭐ A GATE REFUSAL is not a crash — no backoff, no restart. Refusal criteria
    //   are deterministic (dirty tree / unaccepted revision / unknown runtime /
    //   missing CLI...): the same environment dies at the same spot every time.
    //   Standing still until a human fixes it IS correct. ⛔ The gate itself is
    //   never loosened — only the aftermath was wrong.
    //   ⭐ Intent (desired_running) drops too: kept, the panel shows a line that
    //   "wants to run but won't", and people press start repeatedly without
    //   reading the reason.
    if (code === REFUSED_EXIT) {
      setDesired(line, false);
      resetLadder(line);
      w.log.push("[⛔ 门拒绝启动(exit 3)—— **不自动重启**。" +
                 "修好上方给出的理由后再按『启动』(梯子已折叠)]");
      console.log(`${key} 拒绝启动(exit ${code})—— 不自动重启;理由见 log 尾`);
      emit("worker.changed", { line, running: false });
      return;
    }

    // ⭐ A crash (exit≠0) auto-restarts with backoff. Measured: one uncaught
    //   exception silently stopped two lines for 5.5 hours — desired_running was
    //   true and nobody restarted them.
    //   · exit 0 (deadline / --once) does not restart · human stops don't either
    //   · past the deadline: no · surplus slots after shrinking parallel: no
    //   · backoff 30s → 1m → 2m → 4m → 8m → cap 15m; a run alive >10min resets.
    const stillWanted = () => {
      const cur = settingsOf(line);
      const eff = effectiveAgents(line, cur);
      return cur.desired_running && !!eff && k <= eff.length;
    };
    // ⭐ The criterion is the RECORDED REASON, not the exit code. Measured on this
    //   port before the change: a pool failover stops the line with the intent kept,
    //   the tree kill returns non-zero, and the line was booked as a crash — the ladder
    //   climbed on an orderly, intentional stop.
    if (stop?.reason === STOP_REASON.CRASH && stillWanted() && !shuttingDown &&
        !(BOARD_UNTIL_AT && Date.now() >= BOARD_UNTIL_AT)) {
      const lived = Date.now() - w.startedAt;
      // ⭐ The rung is FIXED HERE, in the ledger, at crash time (independent of
      //   restart success or of who restarts).
      const n = (lived > 600_000 ? 0 : (crashLadder.get(key) || 0)) + 1;
      crashLadder.set(key, n);
      const delay = Math.min(900_000, CRASH_BACKOFF_MS * 2 ** (n - 1));
      w.log.push(`[判定为 crash —— ${Math.round(delay / 1000)} 秒后第 ${n} 次自动重启]`);
      console.log(`${key} crash(code=${code})—— ${Math.round(delay / 1000)}s 后第 ${n} 次自动重启`);
      setTimeout(() => {
        if (!stillWanted() || workers.get(key)?.proc || shuttingDown) return;
        if (BOARD_UNTIL_AT && Date.now() >= BOARD_UNTIL_AT) return;
        try {
          workerStart(line, w.route);       // rebuild only the missing slots (idempotent — keep this property)
          // ⛔ Do not write the count here: the early return above (another slot's
          //   timer already rebuilt this one) can skip this line, creating "a slot
          //   nobody counts for". The log is the witness of an ACTUAL rebuild.
          workers.get(key)?.log.push(`[自动重启(第 ${n} 次)]`);
        } catch (e) { console.error(`${key} 自动重启失败:`, e.message); }
      }, delay).unref?.();
    }
    emit("worker.changed", { line, running: false });
  });
  workers.set(key, w);
  emit("worker.changed", { line, running: true });
}

async function workerStop(line, { keepIntent = false,
                                  reason = keepIntent ? STOP_REASON.WITH_BOARD : STOP_REASON.BY_USER } = {}) {
  if (!keepIntent) setDesired(line, false);   // a human stop stays stopped across restarts
  const lineSlots = slotsOf(line);
  const slots = lineSlots.filter((w) => w.proc || w.echo);
  // ⭐ Booked BEFORE the tree kill — this ORDER is the mechanism, not a preference: a
  //   kill returns non-zero, and whoever reads the code afterwards would call it a
  //   crash. Written across the line's whole slot set, so a line that was backing off
  //   from an earlier crash does not keep showing that crash after being stopped.
  const stop = recordStop(line, reason, lineSlots);
  if (!slots.length) {
    // ⭐ This used to THROW 409 — but setDesired had already run, so the screen said
    //   "operation failed" while the stop had actually taken effect = a lie people
    //   kept re-pressing (measured: "I can't stop it" — every stop had worked and
    //   every one reported failure). ⭐⭐ Worse, the throw skipped the tail of this
    //   function: resetLadder never ran (stopping a crash-backing line kept its
    //   ladder) and releaseHeldBy never ran (a dead slot's in-flight cards stayed
    //   attached to a stopped line). Stop is a request for a STATE; already there =
    //   success. Idempotent.
    resetLadder(line);
    const idle = [];
    for (let k = 1; k <= MAX_PARALLEL; k++) idle.push(...store.releaseHeldBy(db, slotKey(line, k)));
    if (idle.length) {
      console.log(`${line} 停止(进程本就不在): 在途 ${idle.join(",")} 已收回未开始`);
      emit("task.reaped", { count: idle.length });
    }
    emit("worker.changed", { line, running: false });
    return { line, stopping: false, already_idle: true, intent_cleared: !keepIntent,
             tree_killed: 0, released: idle,
             stop_reason: stop, stop_text: stopText(stop, null),
             note: keepIntent ? "进程本就不在(内部调用·重启意图保留)"
                              : "进程本就不在 —— 自动重启的意图已清除,不会再起来" };
  }
  // ⭐ proc.kill() kills ONE process. The model CLI under the loop survives losing
  //   its parent and keeps editing files (measured). "Stop" that does not stop is a
  //   lie, so the whole TREE goes down.
  // ⭐⭐ Order matters: firing taskkill and immediately proc.kill() lets the parent
  //   die before taskkill walks the tree — grandchildren re-parent and escape /T
  //   (measured: 3/3 orphans that way, 0/3 when awaited). An orphan = an unattended
  //   model rewriting the repo. "Actually dead" outranks "fast".
  let treeKilled = 0;
  for (const w of slots) {
    if (!w.proc) { workers.delete(slotKey(line, w.slot)); continue; }   // spawn-echo leftovers
    const pid = w.proc.pid;
    try {
      if (process.platform === "win32") {
        await new Promise((r) => {
          const t = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
          t.on("exit", r); t.on("error", r);
          setTimeout(r, 8000);        // do not wait forever for taskkill either
        });
        treeKilled++;
      } else { process.kill(-pid, "SIGKILL"); treeKilled++; }
    } catch (e) { console.error(`树杀失败(${slotKey(line, w.slot)} pid=${pid}):`, e.message); }
    try { if (w.proc && !w.proc.killed) w.proc.kill(); } catch {}
  }
  // We know we killed them — no reason to wait 30 minutes for leases. ⭐ Reclaim
  // under EVERY slot name up to the cap: leases of old slots left over after
  // shrinking parallel get swept here too.
  const freed = [];
  resetLadder(line);                    // human stop ⇒ next start begins at the base
  for (let k = 1; k <= MAX_PARALLEL; k++) freed.push(...store.releaseHeldBy(db, slotKey(line, k)));
  if (freed.length) { console.log(`${line} 停止: 在途 ${freed.join(",")} 已收回未开始`); emit("task.reaped", { count: freed.length }); }
  return { line, stopping: true, tree_killed: treeKilled, released: freed,
           stop_reason: stop, stop_text: stopText(stop, null) };
}

async function probePool(runtime) {
  // Result injection only under explicit test mode; production always makes the
  // minimal real call.
  if (process.env.BOARD_POOL_TEST_MODE === "1" && process.env.BOARD_POOL_TEST_PROBE)
    return { ok: process.env.BOARD_POOL_TEST_PROBE === "ok", detail: "injected-test-probe" };
  const loop = join(LOOPS_DIR, "worker_loop.py");
  if (!existsSync(loop))
    return { ok: false, code: -1, detail: "loops/worker_loop.py 未安装 —— 无法探测池" };
  const ag = runtime === RUNTIME_IDS[0] ? DEFAULT_AGENT
    : (failoverAgent(DEFAULT_AGENT, runtime) || DEFAULT_AGENT);
  const args = [loop, "--probe-runtime", "--live", "--as", LINES[0]];
  return await new Promise((resolve) => {
    execFile(PY, args, { env: slotEnv(LINES[0], 1, ag, false), cwd: __dirname,
                         encoding: "utf8", timeout: 660_000, maxBuffer: 4 << 20 },
      (e, so, se) => resolve({ ok: !e, code: e ? (typeof e.code === "number" ? e.code : 1) : 0,
                               detail: ((so || "") + (se || "")).slice(-1200) }));
  });
}

let poolReconciling = null;
function schedulePoolReconcile(reason) {
  setTimeout(() => { void reconcilePools(reason); }, 0).unref?.();
}
async function reconcilePools(reason = "timer") {
  if (poolReconciling) return poolReconciling;
  poolReconciling = (async () => {
    const now = Date.now();
    // ⭐ Snapshot what a pass can change. The pass used to emit pool.changed
    //   UNCONDITIONALLY at its end — on the timer that is one broadcast every
    //   reconcile tick with nothing changed, and the SSE sentry prints a line
    //   per event (a deployment filed it: "pool.changed every 5 seconds drowns
    //   the sentry"). "changed" now means changed: pools or live slots differ
    //   from the snapshot, or the pass was explicitly requested (non-timer).
    const poolSnap = () => JSON.stringify({ pools: poolState,
      live: [...workers.entries()].filter(([, w]) => w.proc || w.echo).map(([k]) => k).sort() });
    const before = poolSnap();
    // `until` is not "assume fine after this" — it is the time of the next MINIMAL
    // PROBE. Success unlocks; failure pushes to the next hold window.
    for (const p of POOL_IDS) {
      if (!poolDown(p) || Date.parse(poolState[p].until) > now) continue;
      const pr = await probePool(p);
      if (pr.ok) { clearPool(p); console.log(`池复查 ${p}: 成功 → 解禁`); }
      else { markPoolDown(p, Date.now()); console.error(`池复查 ${p}: 失败 → 下个保持窗再查: ${redact(pr.detail)}`); }
    }
    updateGlobalStopMarker(reason);

    for (const line of SUPERVISED) {
      const st = settingsOf(line);
      if (!st.desired_running) continue;
      const plan = effectiveAgents(line, st);
      const active = slotsOf(line).filter((w) => w.proc || w.echo);
      const same = !!plan && active.length === plan.length && active.every((w, i) => {
        const a = plan[i], b = w.settings || {};
        return ["runtime", "model", "effort", "window"].every((k) => (a[k] ?? DEFAULT_AGENT[k]) === (b[k] ?? DEFAULT_AGENT[k]));
      });
      if (same) continue;
      // ⭐ A maintenance boot (BOARD_NO_RESTORE) must not be undone from here. The boot
      //   path skips reviving last night's intent — but this reconciler runs on a timer
      //   and would start the very same lines seconds later, because "wants to run and
      //   has no slots" is exactly what it exists to fix. Measured: a board booted with
      //   the flag printed "reviving nothing" and then started the line 5s later.
      //   ⚠ The condition is NOT the flag alone: once a line has been started in THIS
      //   process (a human pressed start, or a normal boot restored it), the reconciler
      //   must still be able to bring it back after a seat swap. What the flag forbids
      //   is reviving intent that predates this boot.
      if (!active.length && NO_REVIVE && !everStarted.has(line)) {
        if (!noReviveSaid.has(line)) {
          noReviveSaid.add(line);
          console.log(`池调度: ${line} 想跑但本次是维护重启(BOARD_NO_RESTORE)—— 不代替人把它拉起来`);
        }
        continue;
      }
      const route = active[0]?.route || store.DEFAULT_ROUTE;
      if (active.length) {
        // A seat swap is an orderly stop, not a crash — say so, or the tree kill's
        // non-zero code books a crash and the backoff ladder climbs on a healthy line.
        try { await workerStop(line, { keepIntent: true, reason: STOP_REASON.WITH_BOARD }); }
        catch (e) { console.error(`池调度停止 ${line} 失败:`, e.message); continue; }
        const deadline = Date.now() + 10_000;
        while (slotsOf(line).some((w) => w.proc) && Date.now() < deadline)
          await new Promise((r) => setTimeout(r, 50));
      }
      if (!plan) {
        console.log(`池调度: ${line} 停止(无可执行座席;运行意图保留)`);
        continue;
      }
      try {
        workerStart(line, route, plan);
        console.log(`池调度: ${line} → ${plan.map((a) => a.runtime).join("/")}`);
      } catch (e) { console.error(`池调度启动 ${line} 失败:`, e.message); }
    }
    if (reason !== "timer" || poolSnap() !== before)
      emit("pool.changed", { reason, pools: poolState, global_stop: bothPoolsDown() });
  })().finally(() => { poolReconciling = null; });
  return poolReconciling;
}

function workerInfo(line) {
  const st = settingsOf(line);
  // `last_stop` is stripped here too: it is a PERSISTENCE key, not a settings key.
  // Left in, it would ride out inside `settings` alongside the structured
  // stop_reason below — two copies of the same fact, one of them stale.
  const { session_id, forked_from, last_stop, ...safeSet } = st;   // withheld from the wire
  const slots = slotsOf(line);
  const w = workers.get(line);                          // slot 1 (compatibility lead)
  const lg = LINEAGE[line];
  const runningSlots = slots.filter((s2) => s2.proc);
  // "Running on stale settings" is stated from the REAL DIFF (it used to display
  // whenever running, sticking after stop→start = a false alarm). Compared: the
  // settings snapshotted at start vs saved settings, process-relevant keys only;
  // a parallel-count mismatch counts as stale too.
  const KEYS = ["model", "effort", "window", "runtime"];
  const eff = effectiveAgents(line, st);
  const wantNow = eff?.length || 0;
  // Staleness compares SLOT AGAINST SLOT (changing only slot 2's model is caught).
  const stale = runningSlots.some((s2) => {
      const curAg = eff?.[(s2.slot || 1) - 1];
      return !curAg || KEYS.some((k2) => (s2.settings?.[k2] ?? DEFAULT_AGENT[k2]) !== (curAg[k2] ?? DEFAULT_AGENT[k2]));
    }) || (runningSlots.length > 0 && runningSlots.length !== wantNow);
  const mainStop = w ? validStop(w.stopReason) : validStop(last_stop);
  return {
    line, running: runningSlots.length > 0, pid: w?.proc?.pid ?? null,
    desired_running: !!st.desired_running,
    started_at: w?.startedAt ?? null, route: w?.route ?? store.DEFAULT_ROUTE,
    // ⚠ session_id / forked_from are REAL conversation ids; the panel never used
    //   them (grep = 0), so they are not returned. What is worth returning is the
    //   boolean "inherited or not".
    settings: safeSet, has_session: !!st.session_id, detached: !!w?.detached,
    pool_blocked: !eff, pool_failover: runningSlots.some((s2) =>
      (s2.settings?.runtime || RUNTIME_IDS[0]) !== (st.agents[(s2.slot || 1) - 1]?.runtime || RUNTIME_IDS[0])),
    stale_settings: stale,
    // ⭐ While a container for this run exists, only ITS reason counts; the persisted
    //   last_stop is read only when there is no container (after a board restart —
    //   which is the case "stopped with the board" exists to survive). Reading the
    //   persisted one too eagerly makes a start REFUSAL display the previous user stop.
    stop_reason: mainStop, stop_text: stopText(mainStop, w?.exitCode ?? null),
    slots: slots.map((s2) => {
      const slotStop = validStop(s2.stopReason);
      return { slot: s2.slot, worker: slotKey(line, s2.slot),
        running: !!s2.proc, pid: s2.proc?.pid ?? null, started_at: s2.startedAt,
        exit_code: s2.proc ? null : (s2.exitCode ?? null),
        runtime: s2.settings?.runtime || RUNTIME_IDS[0],
        stop_reason: slotStop, stop_text: stopText(slotStop, s2.exitCode ?? null),
        tail: s2.log?.length ? s2.log[s2.log.length - 1] : "" };
    }),
    lineage: lg ? { configured: true, forked: !!st.forked_from, anchor: lg.anchor,
                    forked_at: st.forked_at || null } : null,
    exit_code: w?.proc ? null : (w?.exitCode ?? null),
    last_log: w?.log?.slice(-6) ?? [],
  };
}

// ── SSE: push on change only. Countdown/heartbeat freshness is computed client-
//    side; no per-second broadcasting.
const clients = new Set();
// ⚠ Receivers must NOT hand-maintain an event-type list — a type added later
//   silently stops arriving (measured: the server emitted 16 kinds, the panel
//   subscribed to 8; verdicts, lease reclaims, pins and reopens never arrived, and
//   the 15s fallback poll made it look merely "slow"). The frame is ONE kind
//   (`change`), the type rides in the data — new types arrive by construction.
//   Worker stdout is high-frequency, so it gets its own frame (`log`) for
//   receiver-side throttling.
function emit(type, data = {}) {
  const wire = String(type).endsWith(".log") ? "log" : "change";
  const payload = `event: ${wire}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  for (const res of clients) { try { res.write(payload); } catch {} }
}

const json = (res, code, body) => {
  const s = JSON.stringify(body);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(s);
};
const readBody = (req) => new Promise((resolve, reject) => {
  let b = "";
  req.on("data", (c) => { b += c; if (b.length > 1e6) req.destroy(); });
  // Broken JSON is the CALLER's to fix ⇒ it declares BAD_INPUT. Left as a bare
  // SyntaxError it falls to the untyped-400 fallback, and every mis-send rings the
  // [unclassified] alarm with the same face as a real gap — normalized alarms stop
  // being read.
  req.on("end", () => { try { resolve(b ? JSON.parse(b) : {}); }
    catch (e) { reject(store.err(store.ERR.BAD_INPUT, `request body is not valid JSON: ${e.message}`)); } });
  // ⚠ Transport failures (disconnects) stay untyped — they are not about the
  //   caller's request; if the fallback ever reports one, THAT is when to think.
  req.on("error", reject);
});

/**
 * The status code is decided in ONE place — and the DECLARATION rides with it.
 * ⚠ The mapping table lives in store.httpStatusFor, but every additional CALLER of
 *   the mapping is a chance to drop `typed` and silently return 400. Measured: the
 *   claim refusal (claimById returns {ok:false, code} without throwing) bypassed
 *   the catch, called the mapping directly, and unclassified errors there raised no
 *   alarm — the "silent 400" the taxonomy had eliminated, back through a non-throw
 *   road. ⛔ Never call store.httpStatusFor() directly for `.status`; go through here.
 * @param {*} e the error (or a {code, message} refusal)
 * @param {string} where attached to the report so console readers can locate the road
 */
function statusFor(e, where) {
  const { status, typed } = store.httpStatusFor(e);
  const msg = String((e && (e.message || e.why)) || e || "");
  const at = where ? ` @${where}` : "";
  // ⚠ Untyped errors fall to 400 but NOT silently — silence is how "unclassified
  //   keeps accumulating" stays invisible.
  if (!typed) console.warn(`[未分类错误] 已按 400 返回(无分类)${at}: ${msg.slice(0, 160)}`);
  // ⭐ Internal failures (5xx) always reach the console too. Typing them silences
  //   the untyped warning ⇒ without this line, classifying an error would make a
  //   visible failure QUIETER — worse than the starting point.
  if (status >= 500) console.error(`[内部失败] 已按 ${status} 返回${at}: ${msg.slice(0, 300)}`);
  return status;
}


// ───────────────────────── The local write-endpoint gate ─────────────────────
// The board binds loopback only, but "loopback = safe" does not hold against OTHER
// processes on the same machine. A token lives in .data/; the server injects it
// into the page. Browser-origin attacks cannot read it, so they fail.
// (An adversary who can already execute code on this machine wins regardless —
//  that is outside this threat model. The target is "pages from other origins" and
//  "random local scripts without the token".)
const TOKEN_FILE = join(store.DATA_DIR, "board_token");
// ⭐ Three tokens, three capability classes (v0.2, after a live incident: an
//   interactive agent granted the board FOLDER read board_token and self-approved
//   its own card with resolved_by:'codex'). One token was one capability —
//   "worker" and "ruler" were the same word. Now:
//     board_token  = operator, full power (panel injection, board.py, humans)
//     worker_token = the EXECUTION face only: claim / report / heartbeat /
//                    attempt / derived-card create / own-line compact / forked /
//                    pool report. A worker loop compromised through card text
//                    can no longer close or re-scope anything.
//     review_token = the RULING face of the auto-reviewer: resolve with
//                    resolved_by=auto, autoreview, pool report. It cannot claim,
//                    cannot edit, and cannot impersonate a human ruling.
//   Endpoints not on a token's list refuse (unknown falls on the refusing side).
const mintToken = (file) => {
  let t = "";
  try { t = readFileSync(file, "utf8").trim(); } catch {}
  if (!t) { t = randomUUID().replace(/-/g, ""); writeFileSync(file, t, "utf8"); }
  return t;
};
const BOARD_TOKEN = mintToken(TOKEN_FILE);
const WORKER_TOKEN = mintToken(join(store.DATA_DIR, "worker_token"));
const REVIEW_TOKEN = mintToken(join(store.DATA_DIR, "review_token"));

const WORKER_WRITES = (p) =>
  p === "/api/claim" || p === "/api/tasks" || p === "/api/pools/exhausted" ||
  /^\/api\/tasks\/\d+\/(?:report|heartbeat|attempt)$/.test(p) ||
  /^\/api\/context\/[a-z0-9_-]+\/compact$/.test(p) ||
  /^\/api\/workers\/[a-z0-9_-]+\/forked$/.test(p);
const REVIEW_WRITES = (p) =>
  p === "/api/pools/exhausted" ||
  /^\/api\/tasks\/\d+\/(?:resolve|autoreview)$/.test(p);
// Requests with a foreign Origin are refused; no Origin (curl / CLI) is judged by
// token. ⚠ BOARD_EXTRA_ORIGINS (comma-separated) widens this — the moment a
// non-loopback origin is added, the write boundary is no longer "this machine":
// any host on that network that can GET the page can read the token. Add entries
// only with that understood.
const ALLOWED_ORIGINS = new Set([
  `http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`, `http://[::1]:${PORT}`,
  ...(process.env.BOARD_EXTRA_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean),
]);

/** Trim absolute paths / usernames / upstream hosts while keeping enough to
 *  diagnose. */
function redact(text) {
  if (text == null) return text;
  return String(text)
    .replace(/[A-Za-z]:[\\/](?:[^\s"'`]*[\\/])?/g, (m) => {
      const parts = m.split(/[\\/]/).filter(Boolean);
      return parts.length <= 2 ? m : `…/${parts.slice(-2).join("/")}/`;
    })
    .replace(/\/(?:home|Users)\/[^\s/"']+/gi, "~");
}

/** Authenticate a write. Returns the caller's ROLE ("operator"/"worker"/"review")
 *  or null after refusing. The role check lives HERE, at the single choke point —
 *  per-endpoint "remember to add it" forgets exactly one. */
function guardWrite(req, res, p) {
  const origin = req.headers.origin;
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    json(res, 403, { error: "跨来源的写请求被拒绝", origin });
    return null;
  }
  const tok = req.headers["x-board-token"];
  const role = tok === BOARD_TOKEN ? "operator"
             : tok === WORKER_TOKEN ? "worker"
             : tok === REVIEW_TOKEN ? "review" : null;
  if (!role) {
    // ⚠ Echoing TOKEN_FILE raw would hand an unauthenticated caller an absolute
    //   path with the username in it. "Remember to redact at echo time" fails at
    //   exactly one site — this one, once.
    json(res, 401, { error: "缺少或错误的 X-Board-Token",
                     hint: `令牌在 ${redact(TOKEN_FILE)};页面由服务端注入,CLI 自行读取` });
    return null;
  }
  const allowed = role === "operator" || (role === "worker" ? WORKER_WRITES(p) : REVIEW_WRITES(p));
  if (!allowed) {
    json(res, 403, { error: `${role} 令牌无权执行此操作 —— 裁定/编辑/治理动作只属于 operator 令牌(board_token)`,
                     role, path: p });
    return null;
  }
  return role;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  const m = req.method;

  try {
    // Reads pass; EVERY write goes through the gate here. Per-endpoint "remember to
    // add it" forgets exactly one.
    let boardRole = "operator";
    if (m !== "GET" && m !== "HEAD") {
      boardRole = guardWrite(req, res, p);
      if (!boardRole) return;
    }

    // ── static
    if (m === "GET" && ["/", "/panel.html"].includes(p)) {
      let html = String(await readFile(join(__dirname, "panel.html")));
      // Inject the token so the page's fetches can carry it; the page is only
      // readable same-origin.
      html = html.replace("<script>",
        `<script>window.__BOARD_TOKEN=${JSON.stringify(BOARD_TOKEN)};</script>\n<script>`);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(html);
    }
    if (m === "GET" && p === "/health") return json(res, 200, { status: "ok", port: PORT });

    // ── SSE
    if (m === "GET" && p === "/api/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write("retry: 2000\n\n");
      clients.add(res);
      const ka = setInterval(() => { try { res.write(": ka\n\n"); } catch {} }, 25000);
      req.on("close", () => { clearInterval(ka); clients.delete(res); });
      return;
    }

    // ── The immutable task history. ⚠ Two endpoints, deliberately not one:
    //    /api/events is the SSE nudge ("something changed"), this is the RECORD.
    //    Mixing them would put a growing history into a push channel that exists to
    //    stay tiny.
    if (m === "GET" && p === "/api/task-events") {
      const taskIdRaw = url.searchParams.get("task_id");
      const afterRaw = url.searchParams.get("after");
      const limitRaw = url.searchParams.get("limit");
      const taskId = taskIdRaw == null ? null : Number(taskIdRaw);
      const after = afterRaw == null ? 0 : Number(afterRaw);
      const limit = limitRaw == null ? 20000 : Number(limitRaw);
      if (taskIdRaw != null && (!Number.isInteger(taskId) || taskId <= 0))
        return json(res, 400, { error: "task_id 必须是正整数" });
      if (!Number.isInteger(after) || after < 0)
        return json(res, 400, { error: "after 必须是非负整数" });
      if (!Number.isInteger(limit) || limit < 1 || limit > 50000)
        return json(res, 400, { error: "limit 必须是 1..50000" });
      const evs = store.events(db, { taskId, after, limit });
      // `last_id` is the cursor for the next page; echoing `after` when the page is
      // empty is what lets a caller detect "no progress" instead of looping forever.
      return json(res, 200, { events: evs, last_id: evs.length ? evs[evs.length - 1].id : after });
    }

    // ── Per-card token usage (panel card faces). Read-only aggregation.
    if (m === "GET" && p === "/api/usage") {
      refreshUsage();
      return json(res, 200, { cards: Object.fromEntries(usageByCard) });
    }

    // ── meta (the panel's bottom status line)
    if (m === "GET" && p === "/api/meta") {
      return json(res, 200, {
        counts: store.counts(db),
        archived_count: store.list(db, { archived: "all" }).tasks.filter((t) => t.archived_at).length,
        uptime_sec: Math.floor((Date.now() - STARTED) / 1000),
        server_now: Date.now(),
      });
    }

    // ── listing. archived must be explicit; archived_count always rides
    //    (guaranteed inside store.list).
    if (m === "GET" && p === "/api/tasks") {
      const q = {
        kind: url.searchParams.get("kind"),
        status: url.searchParams.get("status"),
        route: url.searchParams.get("route"),
        line: url.searchParams.get("line"),
        archived: url.searchParams.get("archived") || "false",
      };
      if (!["true", "false", "all"].includes(q.archived))
        return json(res, 400, { error: "archived 必须是 true/false/all" });
      if (q.status && !store.VALID_STATUS.has(q.status))
        return json(res, 400, { error: `status 必须是 ${store.STATUS.join("/")}` });
      const r = store.list(db, q);
      // ⭐ The panel's claimable/frozen segmentation must share claim's criteria —
      //   numbers written twice rot once (the frozen segment rotted when the
      //   lifetime cap changed shape).
      return json(res, 200, { ...r, tasks: r.tasks.map(taskOut), server_now: Date.now(),
        caps: { lifetime_dispatch: store.LIFETIME_DISPATCH_CAP, wip_per_root: store.WIP_PER_ROOT } });
    }

    if (m === "POST" && p === "/api/tasks") {
      const b = await readBody(req);
      // Worker-token creation is for DERIVED cards only (the out-of-scope-work
      // channel): a parent is mandatory. A worker minting root goals would be a
      // worker re-scoping the board.
      if (boardRole === "worker" && b.parentId == null && b.parent_id == null)
        return json(res, 403, { error: "worker 令牌只能创建派生卡(必须带 parentId)—— 立根目标是 operator 的动作" });
      if (badRoutable(res, b)) return;   // creation entrance for route/line domains (ONE criterion)
      const id = store.add(db, b);
      emit("task.created", { id });
      return json(res, 201, { task: taskOut(store.get(db, id)) });
    }

    // ── goals
    if (m === "POST" && p === "/api/goals") {
      const b = await readBody(req);
      // ⚠ This road spreads the whole body into store.add — route/line used to sail
      //   through here while POST /api/tasks had the gate (two mouths of the same
      //   store.add treated differently).
      if (badRoutable(res, b)) return;
      const id = store.add(db, { ...b, kind: "goal", released: 0 });
      emit("task.created", { id });
      return json(res, 201, { task: taskOut(store.get(db, id)) });
    }
    const mg = p.match(/^\/api\/goals\/(\d+)\/decompose$/);
    if (mg && m === "POST") {
      const b = await readBody(req);
      return json(res, 200, await decomposeGoal(Number(mg[1]), b.model));
    }
    const mr = p.match(/^\/api\/tasks\/(\d+)\/related$/);
    if (mr && m === "GET") {
      // ids alone serve only callers who hold the full board (the panel). Loops do
      // not, so rows are returned too (ids stay for the panel).
      const ids = store.relatedIds(db, Number(mr[1]));
      return json(res, 200, { ids, tasks: ids.map((i) => taskOut(store.get(db, i))).filter(Boolean) });
    }

    // ── context management
    if (m === "GET" && p === "/api/context")
      return json(res, 200, { lines: SUPERVISED.map(contextOf) });
    const mc = p.match(/^\/api\/context\/([a-z0-9_-]+)\/compact$/);
    if (mc && m === "POST") {
      if (badLine(res, mc[1], SUPERVISED)) return;
      // Lines without a persistent session (review = fresh per judgment) have
      // nothing to fold — do not mint a ghost session.
      if (!settings[mc[1]]?.session_id)
        return json(res, 400, { error: `${mc[1]} 没有持续会话可整理` });
      const b = await readBody(req);
      const r = await compactLine(mc[1], b.note);
      emit("context.compacted", { line: mc[1] });
      return json(res, 200, r);
    }

    // Auto-review targets (waiting, unreviewed or moved-since-review)
    if (m === "GET" && p === "/api/review/pending")
      return json(res, 200, { tasks: store.pendingReview(db) });

    // Pool rate-limit reporting. `until` is recomputed from the server's own hold
    // constant — the caller's value is never authoritative. The response returns
    // before scheduling, so a self-stopping loop and this HTTP call cannot deadlock.
    if (m === "GET" && p === "/api/pools")
      return json(res, 200, { pools: poolState, global_stop: bothPoolsDown(),
                              marker: bothPoolsDown() ? "pool_global_stop.json" : null });
    if (m === "POST" && p === "/api/pools/exhausted") {
      const b = await readBody(req);
      if (!POOL_IDS.includes(b.runtime))
        return json(res, 400, { error: `runtime 必须是 ${POOL_IDS.join("/")}` });
      const observed = Date.parse(b.exhausted_at || "");
      const entry = markPoolDown(b.runtime, observed);
      updateGlobalStopMarker(`reported:${b.runtime}`);
      schedulePoolReconcile(`reported:${b.runtime}`);
      return json(res, 200, { marked: true, runtime: b.runtime, entry,
                              pools: poolState, global_stop: bothPoolsDown() });
    }

    const mf = p.match(/^\/api\/workers\/([a-z0-9_-]+)\/forked$/);
    if (mf && m === "POST") {
      const b = await readBody(req);
      // review never forks (no inertia by design) — worker lines only.
      if (badLine(res, mf[1], LINES)) return;
      // session_id goes into settings and later into glob + --resume; unshaped, a
      // single `*` turns transcript scanning into all-files.
      if (!UUID_RE.test(String(b.session_id || "")))
        return json(res, 400, { error: "session_id 必须是 UUID", got: String(b.session_id || "").slice(0, 40) });
      return json(res, 200, { settings: markForked(mf[1], b.session_id) });
    }
    // ── v0.4: add a line without a restart (operator token only — the worker and
    //    review allowlists do not carry this path, so they 403 by construction).
    if (m === "POST" && p === "/api/config/lines") {
      const b = await readBody(req);
      const added = addLine(b.id, b.hint);
      emit("config.lines", { line: added.id });
      console.log(`线已加入: ${added.id}${added.hint ? "(" + added.hint + ")" : ""} —— 已写入 ${CONFIG_FILE},无需重启`);
      return json(res, 201, { line: added, lines: LINES, line_hints: LINE_HINT });
    }
    if (m === "GET" && p === "/api/workers")
      return json(res, 200, { workers: SUPERVISED.map(workerInfo), lines: LINES,
                              line_hints: LINE_HINT, routes: ROUTES,
                              models: MODELS, efforts: EFFORTS, weights: WEIGHTS,
                              max_parallel: MAX_PARALLEL, runtimes: RUNTIMES,
                              decompose_models: DECOMPOSE_MODELS,
                              // Handoff targets as id/label/rules ONLY — their
                              // directories never go over the wire.
                              handoff_targets: HANDOFF_TARGETS.map((t) => ({
                                id: t.id, label: t.label, exts: t.exts,
                                name_pattern: t.namePattern.source })),
                              pools: poolState, global_stop: bothPoolsDown(),
                              // ⭐ Emitted as a SIBLING of the supervision table (not
                              //   merged into workerInfo): merged, it only shows on
                              //   SUPERVISED rows — and the one thing worth showing,
                              //   an unknown name firing blind, would be the row
                              //   that vanishes.
                              claim_misses: [...claimMiss.entries()]
                                .map(([worker, v]) => ({ worker, ...v }))
                                .sort((a, b) => b.n - a.n) });
    // Runtime REALITY CHECK. ⭐ Measured with the same env the server really spawns
    //   with (slotEnv shared). Passing from a desktop shell means nothing if the
    //   child's env/cwd/PATH differ. ⚠ Probes fire even on LOCKED seats (read-only,
    //   claims nothing, writes nothing to the board): evidence must be producible
    //   BEFORE release, or it's chicken-and-egg.
    const mpr = p.match(/^\/api\/workers\/([a-z0-9_-]+)\/probe-runtime$/);
    if (mpr && m === "POST") {
      if (badLine(res, mpr[1], SUPERVISED)) return;
      const b = await readBody(req);
      const loop = join(LOOPS_DIR, "worker_loop.py");
      if (!existsSync(loop))
        return json(res, 500, { error: "loops/worker_loop.py 未安装 —— 无从探测" });
      const st0 = settingsOf(mpr[1]);
      const ag = { ...(st0.agents[0] || DEFAULT_AGENT),
                   ...(b.runtime ? { runtime: b.runtime } : {}),
                   ...(b.model ? { model: b.model } : {}),
                   ...(b.effort ? { effort: b.effort } : {}) };
      const seat = seatOf(ag.runtime);
      if (!seat) return json(res, 400, { error: `未知运行时 ${ag.runtime}` });
      if (!(seat.models || []).some((x) => x.id === ag.model))
        return json(res, 400, { error: `${seat.label} 没有模型 ${ag.model}` });
      const dom = effortsFor(ag.runtime, ag.model);
      if (!dom.includes(ag.effort))
        return json(res, 400, { error: `${ag.model} 的强度必须是 ${dom.join("/")}` });
      const args = [loop, "--probe-runtime", "--as", mpr[1],
                    ...(b.live ? ["--live"] : [])];
      const out = await new Promise((resolve) => {
        execFile(PY, args, { env: slotEnv(mpr[1], 1, ag, false), cwd: __dirname,
                             encoding: "utf8", timeout: Number(b.timeout_ms) || 300_000,
                             maxBuffer: 4 << 20 },
          (e, so, se) => resolve({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0,
                                   out: String(so || ""), err: String(se || "").slice(-2000) }));
      });
      return json(res, 200, { line: mpr[1], agent: ag, live: !!b.live,
                              ok: out.code === 0, ...out });
    }
    const ms = p.match(/^\/api\/workers\/([a-z0-9_-]+)\/settings$/);
    if (ms && m === "POST") {
      if (badLine(res, ms[1], SUPERVISED)) return;
      const b = await readBody(req);
      const next = setSettings(ms[1], b);
      const info = workerInfo(ms[1]);
      return json(res, 200, { line: ms[1], settings: next,
        note: !info.running ? "已保存"
            : info.stale_settings ? "已保存,但当前进程还在用旧设置 —— 停止再启动才生效"
            : "已保存(与运行中的进程一致)" });
    }
    const mw = p.match(/^\/api\/workers\/([a-z0-9_-]+)\/(start|stop)$/);
    if (mw && m === "POST") {
      if (badLine(res, mw[1], SUPERVISED)) return;
      const b = await readBody(req);
      let r;
      // HUMAN start/stop resets the ladder (auto-restarts do not).
      //   ⚠ Reset only on SUCCESS — a start bounced with "already running" must not
      //   fold the running slots' ladder, or repeated pressing disables the backoff.
      if (mw[2] === "start") {
        // A mistyped route 400s HERE — passed through, claim's route filter makes
        // the line run forever with "nothing claimable": silent starvation with no
        // stateable reason.
        if (b.route !== undefined && !ROUTES.includes(b.route))
          throw store.err(store.ERR.BAD_INPUT,
            `route 只接受 ${ROUTES.join("/")} —— 收到 ${JSON.stringify(b.route)}`);
        r = workerStart(mw[1], b.route || store.DEFAULT_ROUTE); resetLadder(mw[1]);
      }
      else r = await workerStop(mw[1]);   // stop resets inside workerStop (one place, internal calls included)
      return json(res, 200, r);
    }

    // Pick-a-card claim (no id) — this is what the worker loop hits.
    // Empty queue = 204, not an error: the worker should sleep, not retry.
    if (m === "POST" && p === "/api/claim") {
      const b = await readBody(req);
      // All pools down = global stop. During a single-pool switchover race, no new
      // card goes to a process of the exhausted runtime either.
      if (bothPoolsDown() || (POOL_IDS.includes(b.runtime) && poolDown(b.runtime)))
        return json(res, 503, { error: bothPoolsDown() ? "全部池额度耗尽 —— 全局停止领卡"
                                                    : `${b.runtime} 池额度耗尽 —— 等 server 切换座席`,
                                pools: poolState });
      // ⛔ NO badRoutable here (ruled; reasons at claimMiss above — the harness
      //   watches that stray values do NOT 400).
      // ⭐ Badge stamping: runtime is PURIFIED (outside the allowlist = "not passed"
      //   = no stamp; never 400, never a claim criterion).
      const rt = RUNTIME_IDS.includes(b.runtime) ? b.runtime : null;
      const got = store.claim(db, b.worker, b.lease_minutes || store.DEFAULT_LEASE_MIN,
                              { route: b.route, line: b.line, runtime: rt });
      noteClaim(b.worker, { route: b.route, line: b.line }, !!got);
      if (!got) { res.writeHead(204); return res.end(); }
      emit("task.claimed", { id: got.id, worker: b.worker });
      return json(res, 200, { task: got });
    }

    // Ruling attachments are sourced only from the structured package, and every
    // download/view re-runs the allowed-roots/real-file/link guards.
    const msql = p.match(/^\/api\/tasks\/(\d+)\/decision-attachment\/([A-Za-z0-9_-]+)\/(\d+)$/);
    if (msql && m === "GET") {
      const t = store.get(db, Number(msql[1]));
      if (!t) return json(res, 404, { error: "任务不存在" });
      try {
        const src = decision.decisionAttachmentSource(t, msql[2], Number(msql[3]), DECISION_CTX);
        const encoded = encodeURIComponent(src.name).replaceAll("'", "%27");
        const executable = src.role === "apply" || src.role === "rollback";
        res.writeHead(200, {
          "Content-Type": executable ? "application/octet-stream" : "text/plain; charset=utf-8",
          "Content-Length": src.bytes,
          // companions are viewable as body text only; the direct endpoint must not
          // re-wrap them as executable attachments.
          "Content-Disposition": `${executable ? "attachment" : "inline"}; filename="attachment"; filename*=UTF-8''${encoded}`,
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "no-store",
        });
        return createReadStream(src.path).pipe(res);
      } catch (e) {
        return json(res, 404, { error: String(e.message || e) });
      }
    }

    const mt = p.match(/^\/api\/tasks\/(\d+)(?:\/(claim|heartbeat|attempt|report|resolve|update|autoreview|pin|release|archive|reopen))?$/);
    if (mt) {
      const id = Number(mt[1]);
      const action = mt[2];

      if (m === "GET" && !action) {
        const t = store.get(db, id);
        return t ? json(res, 200, { task: taskOut(t) }) : json(res, 404, { error: "不存在" });
      }
      if (m !== "POST") return json(res, 405, { error: "方法不允许" });
      const b = await readBody(req);

      if (action === "claim") {
        // ⭐ This endpoint claims THE GIVEN id (it used to call pick-a-card and
        //   occupy a different card). Refusals come back with the reason named.
        const r = store.claimById(db, { id, worker: b.worker,
                                        leaseMin: b.lease_minutes || store.DEFAULT_LEASE_MIN,
                                        // badge purification: same allowlist and same never-400 policy as /api/claim
                                        runtime: RUNTIME_IDS.includes(b.runtime) ? b.runtime : null });
        // Refusal codes come from the store's typing. This is the one code-deciding
        // site that does NOT pass the catch (claimById returns instead of throwing)
        // — hence it goes through statusFor, so unclassified refusals still raise
        // the alarm.
        if (!r.ok) return json(res, statusFor({ code: r.code, message: r.why }, "claim"), { error: r.why, id });
        emit("task.claimed", { id, worker: b.worker });
        return json(res, 200, { task: r.task });
      }
      if (action === "heartbeat") {
        const r = store.heartbeat(db, { id, worker: b.worker, leaseMin: b.lease_minutes });
        return json(res, 200, r);       // no SSE for heartbeats: freshness is client-side
      }
      if (action === "report") {
        const r = store.report(db, { id, worker: b.worker, outcome: b.outcome, evidence: b.evidence });
        emit("task.reported", r);
        return json(res, 200, { task: store.get(db, id) });
      }
      if (action === "resolve") {
        // verify_ok is the RULER's declaration (ran the verify just now, was it
        // green) — the store links only when true; undeclared = no linkage.
        const t = store.get(db, id);
        if (!t) throw store.err(store.ERR.NOT_FOUND, `任务 ${id} 不存在`);
        // The handoff archive is an external side effect BEFORE the state change:
        // validate everything store.resolve would refuse FIRST, or "ruling failed"
        // can still have copied SQL = half-application.
        if (!["approve", "reject"].includes(b.verdict))
          throw store.err(store.ERR.BAD_INPUT, "verdict 必须是 approve 或 reject");
        // ⭐ resolved_by caller domain (v0.2, incident pin): human / auto only —
        //   'cascade' is store-internal bookkeeping; anything else is a caller
        //   MINTING an authority (measured on a live deployment: an interactive
        //   agent resolved its own card with resolved_by:'codex' and the board
        //   accepted it). Role × value must also agree: the review token rules
        //   only as auto; the operator token rules only as human.
        const rb = b.resolved_by == null ? "human" : String(b.resolved_by);
        if (!["human", "auto"].includes(rb))
          throw store.err(store.ERR.BAD_INPUT,
            `resolved_by 只接受 human / auto(cascade 由系统内部记账)—— 收到 ${JSON.stringify(rb)}。` +
            `裁定身份不是自我声明:worker 令牌不能 resolve,review 令牌只能以 auto 裁定`);
        if (boardRole === "review" && rb !== "auto")
          throw store.err(store.ERR.BAD_INPUT, "review 令牌只能以 resolved_by=auto 裁定(机器审阅不得冒充人的裁定)");
        if (boardRole === "operator" && rb === "auto")
          throw store.err(store.ERR.BAD_INPUT,
            "operator 令牌不能以 resolved_by=auto 裁定 —— auto 专属审阅线(review_token);人的裁定写 human");
        if (t.status !== "waiting")
          throw store.err(store.ERR.CONFLICT, `任务 ${id} 状态是 ${t.status},没有待裁定的产出`);
        // ⭐ Re-entry gate: hold_for_review KEEPS the card in waiting, so the
        //   one-shot protection above stops working — resending the same POST would
        //   re-run archiveOptionFiles, overwrite the receipt and wake the reviewer
        //   again. Plugged by SERVER STATE (plugging it in the panel's render
        //   condition would dress discipline as structure). ⚠ The key is the new
        //   column's confirm_pending — keying on the old pair (waiting_for==review
        //   && decision_choice) would wrongly bounce cards carrying a previous
        //   round's leftover choice.
        if (b.selected_option != null && t.confirm_pending === true)
          throw store.err(store.ERR.CONFLICT,
            "本卡的执行确认已经提交,正在等待复核(v0.1 由人在面板完成)—— 不能重复确认。" +
            "要改判请用「无需后续 · 结案」,或等审阅出结果。");

        // ══ ① pure validation phase (ZERO side effects) ═══════════════════════
        let archive = null;
        const said = String(b.note || "").trim();
        let resolveNote = said;
        let plan = null;
        if (b.selected_option != null) {
          if ((b.resolved_by || "human") !== "human")
            throw store.err(store.ERR.BAD_INPUT, "A/B/C 最终选择只接受人的裁定");
          const pkg = decision.normalizeDecisionPackage(t?.decision_package, t?.verdict_note);
          const opt = pkg?.options.find((x) => x.key === String(b.selected_option).toUpperCase());
          if (!opt) throw store.err(store.ERR.BAD_INPUT, `选择的方案 ${b.selected_option} 不存在`);
          const publicOpt = decision.publicDecisionPackage(t, DECISION_CTX)
            ?.options.find((x) => x.key === opt.key);
          // Field names generalized with the handoff ruling: executed / outcome /
          // receipt (an option's files can be anything a human applies by hand —
          // SQL, configs, uploads...).
          const fallbackAction = opt.kind === "apply" && b.executed === true
            ? "confirm_executed" : opt.kind === "none" ? "continue" : "";
          const decisionAction = String(b.decision_action || fallbackAction).trim();
          if (!new Set(["continue", "request_completion", "confirm_executed"]).has(decisionAction))
            throw store.err(store.ERR.BAD_INPUT, "decision_action 必须是 continue / request_completion / confirm_executed");
          let receipt = "", outcome = "";
          if (decisionAction === "request_completion") {
            if (opt.kind !== "apply" || publicOpt?.ready !== false)
              throw store.err(store.ERR.BAD_INPUT, "只有文件尚未补齐的方案才能交回 Agent 补齐");
          } else if (opt.kind === "apply") {
            if (decisionAction !== "confirm_executed" || b.executed !== true)
              throw store.err(store.ERR.BAD_INPUT, "该方案含需人手应用的文件;未执行时只能交回 Agent 补齐,不能确认已执行");
            if (!publicOpt?.ready)
              throw store.err(store.ERR.BAD_INPUT, "该方案的文件尚未补齐,不能确认已执行;请选择交回 Agent 补齐");
            receipt = String(b.receipt || "").trim();
            if (!receipt)
              throw store.err(store.ERR.BAD_INPUT, "确认已执行时必须填写执行回执");
            if (receipt.length > 4000)
              throw store.err(store.ERR.BAD_INPUT, "执行回执不能超过 4000 字");
            outcome = String(b.outcome || "").trim().toLowerCase();
            if (!new Set(["success", "failure"]).has(outcome))
              throw store.err(store.ERR.BAD_INPUT, "确认已执行时必须明确 outcome=success 或 failure");
          } else {
            if (decisionAction !== "continue")
              throw store.err(store.ERR.BAD_INPUT, "不含文件的方案只能使用 continue");
          }
          plan = { opt, publicOpt, decisionAction, receipt, outcome };
        }

        // ══ ② the destination is decided in THIS ONE PLACE ════════════════════
        //   ⚠ The deliverable gate used to judge the RAW b.note while the store
        //     judged the synthesized note built later — two criteria, already
        //     diverged. The judgment moved BEFORE the side effects and uses the
        //     same single function as the store.
        const disp =
          // ⚠ Key names copied EXPLICITLY: the body uses snake_case resolved_by;
          //   legacyDisposition destructures camelCase resolvedBy — passed raw, it
          //   falls to the default "human" and an auto approve turns into a
          //   hand-back (caught red once). Importing the same function removes the
          //   divergence only when the INPUTS are the same too.
          b.selected_option == null
            ? store.legacyDisposition({ verdict: b.verdict, note: b.note,
                                        resolvedBy: b.resolved_by || "human" })
          : (plan.decisionAction === "confirm_executed" && plan.outcome === "success")
              ? store.confirmDestination(db, t)
              : "hand_back";

        // ══ ③ deliverable-existence gate — measured ONLY when closing ═════════
        //   Real story: a card closed without it; only the consumers were
        //   committed and HEAD's build was broken for four days.
        //   ⚠ Only UNCOMMITTED counts. Paths absent from disk too (command-line
        //     fragments, typos) are not reported — false positives blocking
        //     closure get the gate itself switched off.
        if (disp === "close" && b.allow_uncommitted !== true) {
          const left = uncommittedOf(t);
          // null = the gate could not measure. Refusing here is the point:
          // "unmeasurable ⇒ pass" would make every git hiccup a free close.
          if (left === null)
            throw store.err(store.ERR.CONFLICT,
              `结案被拦: 交付物闸不可测(读不到宿主仓 HEAD/git)—— 不可测不等于没有违规。` +
              `\n  修复 git 环境后重试;确属无 git 部署,用 BOARD_DELIVERABLE_GATE=off 显式关闸(每次结案都会记录);` +
              `\n  或对这一张卡人工担责:resolve 带 allow_uncommitted:true 并在裁定里写明理由。`);
          if (left.length)
            throw store.err(store.ERR.CONFLICT,
              `结案被拦: 证据里点名的 ${left.length} 个交付物在工作树里存在,但**没有入库**(HEAD 里找不到)` +
              ` —— 先 commit 再结案,否则这张卡对别人是空的。` +
              `\n  ${left.join("\n  ")}` +
              `\n  ⚠若这些路径确实不该入库(例如实数据文件),在 resolve 时带 allow_uncommitted:true 并在裁定里写明理由。`);
          // The reverse blind spot: "touched but never named". Attribution is by
          // TIME (work_spans) — on a shared work tree, "is the tree dirty" cannot
          // attribute.
          const unnamed = unnamedOf(t);
          if (unnamed === null)
            throw store.err(store.ERR.CONFLICT,
              `结案被拦: 交付物闸不可测(读不到 git status)—— 不可测不等于没有违规。` +
              `\n  修复 git 环境后重试;或 resolve 带 allow_uncommitted:true 人工担责并写明理由。`);
          if (unnamed.length)
            throw store.err(store.ERR.CONFLICT,
              `结案被拦: 本卡作业区间内有 ${unnamed.length} 个文件被改动却**未入库、且证据里一个都没点名**` +
              ` —— 纯文字描述不算交付。先 commit(或在证据里点名并说明为何不入库)再结案。` +
              `\n  ${unnamed.join("\n  ")}` +
              `\n  ⚠若这些改动不属于本卡(共享工作树上别的线在途),在 resolve 时带 allow_uncommitted:true 并写明归属。`);
        }

        // ══ ④ side effects (from here on, no refusals are written) ════════════
        let receiptBlock = null;
        if (plan) {
          const { opt, decisionAction, receipt, outcome } = plan;
          const extra = said ? `\n补充指示:${said}` : "";
          if (decisionAction === "request_completion") {
            resolveNote = `采用方案 ${opt.key} 的方向:${opt.title}。卡内文件尚未补齐;` +
              `请原 Agent 补齐完整、可下载、符合 handoff 目标准入名形的文件后重新送审。` + extra;
          } else if (opt.kind === "apply") {
            try {
              archive = decision.archiveOptionFiles(t, opt.key, DECISION_CTX);
            } catch (e) {
              const msg = String(e.message || e);
              throw store.err(msg.includes("同名异内容") ? store.ERR.CONFLICT : store.ERR.BAD_INPUT, msg);
            }
            resolveNote = outcome === "failure"
              ? `采用方案 ${opt.key}:${opt.title}。用户已实际尝试应用,但执行失败;` +
                `本次不视为已应用,禁止沿成功路径继续。请原 Agent 根据下面的原始回执修正文件;` +
                `不要覆盖已归档的失败版本,修正版使用下一个序号并重新送审。` +
                `\n\n—— 执行回执(失败 · 用户填写)——\n${receipt}` + extra
              : `采用方案 ${opt.key}:${opt.title}。文件已由用户应用成功;` +
                (disp === "hold_for_review"
                  ? `**本卡不交回原 Agent** —— 留在等待中,复核通过后方可结案(v0.1 复核由人在面板完成)。`
                  : `请按该方案继续并根据下面的回执完成验证。`) +
                `\n\n—— 执行回执(成功 · 用户填写)——\n${receipt}` + extra;
            // ⭐ The receipt survives as ONE block. The four existing carriers do
            //   not live through a cycle (markAutoReviewed erases, the next report
            //   overwrites) — and a silently vanished "was applied to production"
            //   is the doorway to a re-run.
            receiptBlock = { option: opt.key, outcome, receipt, said,
                             files: archive || [], at: new Date().toISOString(), consumed_at: null };
          } else {
            resolveNote = `采用方案 ${opt.key}:${opt.title}。请按该方案继续。` + extra;
          }
        }

        // ══ ⑤ landing ═════════════════════════════════════════════════════════
        const r = store.resolve(db, { id, verdict: b.verdict, note: resolveNote,
                                     resolvedBy: b.resolved_by || "human",
                                     verifyOk: b.verify_ok,
                                     selectedOption: b.selected_option,
                                     sqlArchive: archive,
                                     disposition: disp, sqlReceipt: receiptBlock });
        emit("task.resolved", r);
        return json(res, 200, { task: taskOut(store.get(db, id)) });
      }
      if (action === "attempt") {
        // Self-retry round n: the card stays in_progress (not released); only
        // attempts advances.
        const r = store.bumpAttempt(db, { id, worker: b.worker });
        emit("task.attempt", r);
        return json(res, 200, r);
      }
      if (action === "autoreview") {
        const r = store.markAutoReviewed(db, { id, note: b.note,
                                               decisionPackage: b.decision_package });
        emit("task.autoreviewed", r);
        return json(res, 200, r);
      }
      if (action === "update") {
        // prev_line is the provenance column stamped by line moves — direct writes
        // are refused (the single-assignment invariant, guarded API-side too).
        if (b.prev_line !== undefined || b.prevLine !== undefined)
          return json(res, 400, { error: "prev_line 是来历列,由移线自动盖章 —— 不可直写" });
        // Domain gate at the single mandatory pass (the store does not know
        // LINES/ROUTES — layers do not cross).
        if (badRoutable(res, b)) return;
        const r = store.update(db, { ...b, id });
        emit("task.updated", { id });
        return json(res, 200, { task: store.get(db, id), ...r });
      }
      if (action === "pin") {
        const r = store.setPinned(db, { id, pinned: b.pinned !== false });
        emit("task.pinned", r);
        return json(res, 200, { task: store.get(db, id) });
      }
      if (action === "release") {
        const r = store.setReleased(db, { id, released: b.released !== false });
        emit("task.released", r);
        return json(res, 200, { task: store.get(db, id) });
      }
      if (action === "reopen") {
        // ⚠ This road used to sail through (store.reopen writes the given line
        //   verbatim) — gating only create and update still allowed ghost cards
        //   from here.
        if (badRoutable(res, b)) return;
        const r = store.reopen(db, { id, line: b.line });
        emit("task.reopened", r);
        return json(res, 200, { task: store.get(db, id), ...r });
      }
      if (action === "archive") {
        const r = store.archive(db, {
          id,
          restore: b.restore === true,
          force: b.force === true,
        });
        emit("task.archived", r);
        return json(res, 200, { task: store.get(db, id) });
      }
    }

    return json(res, 404, { error: "没有这个端点" });
  } catch (e) {
    const msg = String(e?.message || e);
    // Codes split by the TYPE the store attached (never by prose matching — a
    // one-character wording fix once degraded 409 to 400 with every check still
    // green). The mapping table is store.httpStatusFor, ONE place; the mapping AND
    // the declaration are unified in statusFor() above — calling the raw mapping
    // here would recreate "this road silently 400s".
    return json(res, statusFor(e, "兜底"), { error: msg });
  }
});

// No authentication exists. Exposed on 0.0.0.0, anyone on the LAN can rewrite
// cards and drive the workers. Not a "be careful" thing — a non-loopback host
// REFUSES to start. The admonition is a gate.
if (!["127.0.0.1", "::1", "localhost"].includes(HOST)) {
  console.error(`拒绝启动:BOARD_HOST=${HOST} 不是回环地址。`);
  console.error("这个服务没有任何鉴权 —— 绑到非回环地址等于把任务队列的写权限交给整个网络。");
  console.error("确实要这么做的话,请先给写端点加上鉴权,再改这里的判断。");
  process.exit(1);
}

// Lease reaping never depends on claim traffic: even with every worker dead, the
// board converges to a correct state.
const REAP_MS = Number(process.env.BOARD_REAP_MS || 30000);
setInterval(() => {
  try {
    const n = store.reapExpired(db);
    if (n) { console.log(`租约到期 ${n} 件 收回未开始`); emit("task.reaped", { count: n }); }
    // Complement pair — always swept in THIS order.
    const dr = store.deferToRearm(db);
    if (dr.length) { console.log(`子任务卡未齐 → 转入等待重审: #${dr.join(" #")}`); emit("task.deferred", { ids: dr }); }
    const ra = store.rearmDone(db);
    if (ra.length) { console.log(`子任务卡齐全 → 送回重审: #${ra.join(" #")}`); emit("task.rearmed", { ids: ra }); }
    const gc = store.completeGoals(db);
    if (gc.length) {
      const done = gc.filter((x) => x > 0), reop = gc.filter((x) => x < 0).map((x) => -x);
      if (done.length) console.log(`目标完成: #${done.join(" #")}`);
      if (reop.length) console.log(`目标重开(子任务卡有未完): #${reop.join(" #")}`);
      emit("goal.completed", { ids: gc });
    }
  } catch (e) { console.error("回收失败:", e.message); }
}, REAP_MS).unref?.();

// Pool patrol. Hold window and cadence are injectable for isolated tests;
// production defaults 5h / 5s.
try { savePools(); updateGlobalStopMarker("server-start"); }
catch (e) { console.error("池全局停止标记初始化失败:", e.message); }
setInterval(() => { void reconcilePools("timer"); }, POOL_RECONCILE_MS).unref?.();

server.listen(PORT, HOST, () => {
  console.log(`看板 http://${HOST}:${PORT}  DB=${store.DB_PATH}`);
  console.log(`状态四值: ${store.STATUS.join(" / ")}`);
  console.log(`配置: ${existsSync(CONFIG_FILE) ? CONFIG_FILE : "(内置缺省)"}  线=${LINES.join(",")}  路由=${ROUTES.join(",")}`
    // A knob that silently does nothing is worse than no knob: say it out loud when set.
    + (LANGUAGE ? `  生成语言=${LANGUAGE}` : ""));
  console.log(HANDOFF_TARGETS.length
    ? `handoff 目标: ${HANDOFF_TARGETS.map((t) => `${t.id}→${t.dir}`).join("  ")}`
    : "未配置 handoff 目标 —— apply 方案归档将拒绝(声明 handoff_targets 或 BOARD_HANDOFF_DIR)");

  // ── Startup recovery inventory. After a machine dies, the first question is
  //    "what is left hanging" — answered NOW, not after the first 30s sweep
  //    (resuming work without noticing the crash is the dangerous part).
  try {
    const c = store.counts(db);
    const inflight = store.list(db, { status: "in_progress" }).tasks;
    const reaped = store.reapExpired(db);
    const still = store.list(db, { status: "in_progress" }).tasks;
    console.log(`盘点: 未开始 ${c.not_started} / 进行中 ${inflight.length} / 等待中 ${c.waiting} / 已完成 ${c.done}`);
    if (reaped) {
      console.log(`  ⚠ 租约已过期的 ${reaped} 件收回未开始(worker 在上次运行中失联):`);
      for (const t of inflight.filter((t) => !still.some((s) => s.id === t.id)))
        console.log(`     #${t.id} [${t.worker}] ${t.subject.slice(0, 46)}`);
    }
    if (still.length) {
      console.log(`  租约仍在有效期内的 ${still.length} 件保持进行中(可能是别处还活着的 worker):`);
      for (const t of still) {
        const left = Math.round(((t.lease_until || 0) - Date.now()) / 1000);
        console.log(`     #${t.id} [${t.worker}] 租约还剩 ${left}s — ${t.subject.slice(0, 40)}`);
      }
      console.log("     若机器刚重启过,这些 worker 其实已经死了,等租约到期会自动收回。");
    }
    // Undelivered evidence files = "produced, then died before reporting". Kept and
    // announced, never deleted.
    const evDir = join(store.DATA_DIR, "evidence");
    const orphanEv = existsSync(evDir) ? readdirSync(evDir).filter((f) => f.startsWith("task-")) : [];
    if (orphanEv.length)
      console.log(`  未交回的证据文件 ${orphanEv.length} 个还在 .data/evidence/(上次可能产出后没来得及报告)`);
    const dr = store.deferToRearm(db);
    if (dr.length) console.log(`  子任务卡未齐、却排在确认队列的父卡 → 转入等待重审: #${dr.join(" #")}`);
    const ra = store.rearmDone(db);
    if (ra.length) console.log(`  子任务卡已齐、仍在等待人工的父卡 → 送回重审: #${ra.join(" #")}`);
    const gc = store.completeGoals(db);
    if (gc.length) console.log(`  目标状态收敛: ${gc.map((x) => x > 0 ? "#" + x + " 完成" : "#" + (-x) + " 重开").join(" ")}`);
  } catch (e) { console.error("启动盘点失败:", e.message); }

  // ── Intent restoration. Returning cards without returning lines silently halts
  //    the processing chain on every dev restart (measured; hours unnoticed).
  //    ⚠ The goal is "never silently stopped" — NOT restoring also states its reason.
  const cfgLineage = Object.keys(LINEAGE);
  console.log(cfgLineage.length
    ? `记忆继承的配置: ${cfgLineage.join(" ")}(未继承的线在初次启动时 fork)`
    : `无记忆继承配置 —— 各线以全新身份开始(参见 examples/lineage.example.json)`);

  // A maintenance restart (reloading new code) must not revive anything — measured:
  // the deadline exit deliberately keeps intent, and a code-reload restart picked
  // up LAST NIGHT's intent and pulled every line up inside the operator's "I am not
  // starting anything" window. The flag skips revival only; intent is kept for the
  // next normal start.
  if (process.env.BOARD_NO_RESTORE) {
    console.log("BOARD_NO_RESTORE=1 —— 维护重启,不复活任何线(意图保留)");
  } else {
  const want = SUPERVISED.filter((l) => settingsOf(l).desired_running);
  if (!want.length) console.log("自动拉取: 停止中(上次是手动停的,或还没启动过)");
  else {
    console.log(`恢复自动拉取: ${want.join(" ")}`);
    for (const l of want) {
      try { workerStart(l); console.log(`  ${l} 启动`); }
      catch (e) { console.error(`  ${l} 恢复失败: ${e.message}`); }
    }
  }
  }
  schedulePoolReconcile("server-start");
});

// Taking the board down takes its workers with it — left behind, unattended models
// keep running.
let shuttingDown = false;
async function stopWithBoard(trigger) {
  if (shuttingDown) return;
  shuttingDown = true;
  const live = SUPERVISED.filter((l) => slotsOf(l).some((w) => w.proc));
  if (live.length) {
    console.log(`退出(${trigger}): 正在停止 worker ${live.join(" ")}(意图保留)…`);
    // keepIntent — a board restart should come back as it was; this is not a human stop.
    for (const l of live) {
      try { await workerStop(l, { keepIntent: true, reason: STOP_REASON.WITH_BOARD }); } catch {}
    }
  }
  process.exit(0);
}
// ⭐ A named function, not a body inlined in the handler, because an external SIGTERM
//   on Windows is TerminateProcess: the handler below never runs, so this path could
//   not be measured at all. Tests trigger the same path from inside the process.
const testShutdownMs = Number(process.env.BOARD_TEST_SHUTDOWN_MS || 0);
if (testShutdownMs > 0) setTimeout(() => { void stopWithBoard("test-timer"); }, testShutdownMs).unref?.();
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => { void stopWithBoard(sig); });
}
