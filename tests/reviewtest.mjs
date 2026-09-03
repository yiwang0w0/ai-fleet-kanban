// reviewtest — the auto-reviewer measured END TO END: a real board, the real
// loops/reviewer_loop.py, a stub CLI whose verdict the harness controls.
//
// What it pins, and why each assertion exists:
//   §1 the server mints THREE distinct tokens (operator / worker / review) —
//      one token was one capability, and a live deployment's agent self-approved
//      its own card with it.
//   §2 approve + green card-named verify → done, resolved_by=auto, and
//      verify_ok=true reaches the store. ⭐ This is the origin dead-branch pin:
//      the origin loop never passed the green verify into resolve, so
//      cascade-close via review was permanently unarmed — an assertion on
//      verify_ok goes red if the plumbing regresses.
//   §3 machine-evidence gate: acceptance demands machine output, evidence is
//      prose-only, the MODEL says approve — the gate must downgrade to
//      escalate (waiting/confirm + decision package, never done).
//   §4 reject → the card goes back to its line (not_started), loud note.
//   §5 card-named verify is RED → mechanical bounce BEFORE the model burns:
//      the stub must not have been invoked at all.
//   §6 the worker token cannot resolve (403) — the ruling face is not the
//      execution face, measured from the outside.
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const PY = process.env.PYTHON || "python";
const NL = String.fromCharCode(10);

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? " — " + detail : ""}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function freePort() {
  for (let p = 48700 + Math.floor(Math.random() * 100); ; p++) {
    const okP = await new Promise((res) => {
      const s = createServer();
      s.once("error", () => res(false));
      s.listen(p, "127.0.0.1", () => s.close(() => res(true)));
    });
    if (okP) return p;
  }
}

const TMP = mkdtempSync(join(tmpdir(), "reviewtest-"));
const REGISTRY = join(TMP, "verify_registry.json");
writeFileSync(REGISTRY, JSON.stringify({
  "always-green": ["python", "-c", "import sys; sys.exit(0)"],
  "always-red":   ["python", "-c", "print('red evidence'); import sys; sys.exit(1)"],
}, null, 1), "utf8");

// Stub CLI: extracts the verdict-file path from the prompt, writes the verdict
// the harness put in REVIEW_STUB_JSON, and leaves an invocation marker.
const STUB = join(TMP, "review_stub.py");
writeFileSync(STUB, [
  "import sys, os, re, io, json",
  "argv = sys.argv",
  "prompt = argv[argv.index('-p') + 1]",
  "io.open(os.environ['REVIEW_STUB_MARK'], 'a', encoding='utf-8').write('invoked' + chr(10))",
  "m = re.search(r'\\u628a\\u5224\\u51b3\\u5199\\u8fdb\\u8fd9\\u4e2a\\u6587\\u4ef6[\\s\\S]*?\\n\\n\\s*(\\S+)', prompt)",
  "io.open(m.group(1), 'w', encoding='utf-8').write(os.environ['REVIEW_STUB_JSON'])",
  "print(json.dumps({'total_cost_usd': 0}))",
].join(NL), "utf8");
const MARK = join(TMP, "stub_invoked.log");

const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
let srv = null, out = "";
const boards = [];

const commonEnv = {
  ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8",
  BOARD_PORT: String(PORT), BOARD_URL: BASE, BOARD_DATA_DIR: TMP,
  BOARD_DB: join(TMP, "t.db"), BOARD_ALLOW_UNPINNED: "1",   // isolated harness only
  BOARD_VERIFY_REGISTRY: REGISTRY,
};

try {
  srv = spawn(process.execPath, [join(ROOT, "core", "server.mjs")], {
    env: commonEnv, stdio: ["ignore", "pipe", "pipe"] });
  srv.stdout.on("data", (b) => (out += b));
  srv.stderr.on("data", (b) => (out += b));
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${BASE}/health`)).ok) break; } catch {}
    await sleep(250);
  }

  const tok = (f) => { try { return readFileSync(join(TMP, f), "utf8").trim(); } catch { return ""; } };
  const OP = tok("board_token"), WK = tok("worker_token"), RV = tok("review_token");
  const api = (m, p, b, t = OP) => fetch(BASE + p, { method: m,
    headers: { "Content-Type": "application/json", "X-Board-Token": t },
    body: m === "GET" ? undefined : JSON.stringify(b ?? {}) })
    .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

  console.log(NL + "[§1 三令牌铸造]");
  ok("R1 三个令牌文件都在且互不相同",
     OP && WK && RV && OP !== WK && OP !== RV && WK !== RV,
     `op=${OP.slice(0, 6)}… wk=${WK.slice(0, 6)}… rv=${RV.slice(0, 6)}…`);

  /** create -> claim -> report(done) — the card lands in waiting/review. */
  const toWaiting = async ({ subject, acceptance, evidence, verify }) => {
    const c = await api("POST", "/api/tasks", { subject, line: "alpha", humanGate: false,
      ...(acceptance ? { acceptance } : {}),
      ...(verify ? { verifyCmd: verify } : {}) });   // camelCase — store.add's field name
    const id = c.body.task.id;
    if (c.status >= 400) console.log("  (create failed:", c.status, JSON.stringify(c.body), ")");
    await api("POST", "/api/claim", { worker: "alpha", line: "alpha", route: "default" }, WK);
    await api("POST", `/api/tasks/${id}/report`, { worker: "alpha", outcome: "done", evidence }, WK);
    return id;
  };

  const runReviewer = (verdict) => {
    try { rmSync(MARK, { force: true }); } catch {}
    const r = spawnSync(PY, [join(ROOT, "loops", "reviewer_loop.py"), "--once", "--interval", "1"], {
      env: { ...commonEnv,
             REVIEWER_CLI_ARGV: JSON.stringify(["python", STUB]),
             REVIEW_STUB_JSON: JSON.stringify(verdict),
             REVIEW_STUB_MARK: MARK,
             REVIEWER_PARALLEL: "1", REVIEWER_LIMIT: "6" },
      encoding: "utf8", timeout: 120000 });
    return (r.stdout || "") + (r.stderr || "");
  };

  console.log(NL + "[§2 approve×绿验证 → done · resolved_by=auto · verify_ok 真的落库]");
  const idA = await toWaiting({
    subject: "r-approve", verify: "always-green",
    acceptance: "① 跑 selftest 全绿",
    evidence: "已完成。" });
  const logA = runReviewer({ verdict: "approve", reason: "证据成立", checked: ["Read x → y"],
                             summary: "", options: [], recommend: "" });
  const tA = (await api("GET", `/api/tasks/${idA}`)).body.task;
  ok("R2 卡结案且 resolved_by=auto(审阅线用 review_token 裁定成功)",
     tA.status === "done" && tA.resolved_by === "auto", `${tA.status}/${tA.resolved_by}`);
  ok("R3 ⭐绿验证随判决落库:verify_ok === true(origin 死分支修正的钉子)",
     tA.verify_ok === true, `verify_ok=${JSON.stringify(tA.verify_ok)}`);
  ok("R4 stub 被调用过(判决确实出自模型路径)", existsSync(MARK), logA.slice(-200));

  console.log(NL + "[§3 机器产出闸:验收要机器、证据纯散文、模型说 approve → 机械降 escalate]");
  const idB = await toWaiting({
    subject: "r-gate",
    acceptance: "① 跑 servertest 并贴出 PASS 计数 ② 文案更新",
    evidence: "我做完了,一切正常。" });
  runReviewer({ verdict: "approve", reason: "看起来没问题", checked: [],
                summary: "", options: [], recommend: "" });
  const tB = (await api("GET", `/api/tasks/${idB}`)).body.task;
  ok("R5 卡没有结案 —— 停在 waiting/confirm 等人",
     tB.status === "waiting" && tB.waiting_for === "confirm", `${tB.status}/${tB.waiting_for}`);
  ok("R6 裁定包来自 auto-review 且推荐 A(三方案齐)",
     tB.decision_package?.source === "auto-review" &&
     tB.decision_package?.recommend === "A" &&
     (tB.decision_package?.options || []).length === 3,
     JSON.stringify({ src: tB.decision_package?.source, rec: tB.decision_package?.recommend }));

  console.log(NL + "[§4 reject → 打回原线]");
  const idC = await toWaiting({ subject: "r-reject", evidence: "试了但没做完。" });
  runReviewer({ verdict: "reject", reason: "缺 X,重做时先补 Y", checked: [],
                summary: "", options: [], recommend: "" });
  const tC = (await api("GET", `/api/tasks/${idC}`)).body.task;
  ok("R7 卡回到 not_started(带指示,不是结案)", tC.status === "not_started", tC.status);

  console.log(NL + "[§5 卡指名验证为红 → 机械打回,模型一次都不烧]");
  const idD = await toWaiting({
    subject: "r-mech", verify: "always-red", evidence: "自称全绿。PASS 99" });
  const logD = runReviewer({ verdict: "approve", reason: "(不该被问到)", checked: [],
                             summary: "", options: [], recommend: "" });
  const tD = (await api("GET", `/api/tasks/${idD}`)).body.task;
  ok("R8 红验证 → 机械打回(not_started)", tD.status === "not_started", tD.status);
  ok("R9 ⭐stub 未被调用(先验后审:红了不烧模型)", !existsSync(MARK), logD.slice(-160));

  console.log(NL + "[§5b codex 审阅的输出 schema 必须过 strict 校验(不跑模型也能判)]");
  {
    // ⭐ This whole class of bug is invisible to the harness above: the stub CLI
    //   exercises the CLAUDE branch, which builds no schema, so the codex branch's
    //   schema was never executed by anything until a live deployment attached a
    //   codex review seat — and the API refused the request BEFORE the model ran,
    //   which on the board looked like the worker had failed (INCIDENTS-13).
    //   Strict structured outputs require, for every object: required lists EVERY
    //   property, and additionalProperties is false. That is machine-checkable
    //   here, offline, in milliseconds.
    const schemaPath = join(ROOT, "loops", "codex_review_schema.json");
    const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
    const faults = [];
    (function walk(node, path){
      if (Array.isArray(node)) return node.forEach((v, i) => walk(v, `${path}[${i}]`));
      if (!node || typeof node !== "object") return;
      if (node.type === "object" || node.properties){
        const props = Object.keys(node.properties || {});
        const req = node.required || [];
        const missing = props.filter((p) => !req.includes(p));
        const stray = req.filter((r) => !props.includes(r));
        if (missing.length) faults.push(`${path}: required 少了 ${missing.join(",")}`);
        if (stray.length) faults.push(`${path}: required 里有 properties 没有的键 ${stray.join(",")}`);
        if (node.additionalProperties !== false) faults.push(`${path}: additionalProperties 必须是 false`);
      }
      for (const [k, v] of Object.entries(node)) walk(v, `${path}.${k}`);
    })(schema, "$");
    ok("R12 ⭐schema 每个对象都合 strict:required 覆盖全部属性 · additionalProperties=false",
       faults.length === 0, faults.join(" | ") || "(全部合规)");
    // ⚠ This file is sent to the API verbatim — it is NOT one of our own configs.
    //   No `_comment` keys, no notes: an unknown keyword risks the same
    //   "refused before the model runs" failure, invisible without a live call.
    //   (Caught while fixing INCIDENT-13: the fix's own explanatory key was
    //   about to ship inside the schema.) Explanations belong in the harness,
    //   the loop's comments and INCIDENTS.md — never in the wire payload.
    const ALLOWED = new Set(["$schema", "type", "properties", "required",
                             "additionalProperties", "items", "enum", "description"]);
    const strays = [];
    (function walkKeys(node, path){
      if (Array.isArray(node)) return node.forEach((v, i) => walkKeys(v, `${path}[${i}]`));
      if (!node || typeof node !== "object") return;
      const inProps = /\.properties$/.test(path);   // property NAMES are free-form
      for (const [k, v] of Object.entries(node)){
        if (!inProps && !ALLOWED.has(k)) strays.push(`${path}.${k}`);
        walkKeys(v, `${path}.${k}`);
      }
    })(schema, "$");
    ok("R12b ⭐schema 里没有自造关键字(这份文件原样发给 API,注释请写在别处)",
       strays.length === 0, strays.join(" | ") || "(只有标准关键字)");
    // An optional field must be spelled "required + nullable" — the fix that got
    // us here. Pin the shape so nobody re-optionalises it by dropping it again.
    const fileItem = schema.properties.options.items.properties.files.items;
    ok("R13 可选字段的写法是「留在 required + 类型可为 null」,不是「从 required 里拿掉」",
       fileItem.required.includes("archive_name") &&
       Array.isArray(fileItem.properties.archive_name.type) &&
       fileItem.properties.archive_name.type.includes("null"),
       JSON.stringify(fileItem.properties.archive_name));
    // Cross-file contract: the kinds the schema lets the model emit must be the
    // kinds the loop's own validator accepts. Two places, one meaning.
    const src = readFileSync(join(ROOT, "loops", "reviewer_loop.py"), "utf8");
    const m = src.match(/kind not in \(([^)]*)\)/);
    const accepted = m ? [...m[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]).sort() : null;
    const declared = [...(schema.properties.options.items.properties.kind.enum || [])].sort();
    ok("R14 schema 允许的 kind 与 reviewer_loop 校验器接受的 kind 是同一组(跨文件契约)",
       !!accepted && JSON.stringify(accepted) === JSON.stringify(declared),
       `schema=${JSON.stringify(declared)} loop=${JSON.stringify(accepted)}`);
  }

  console.log(NL + "[§6 令牌分权的外测面]");
  const idE = await toWaiting({ subject: "r-authz", evidence: "test" });
  const rw = await api("POST", `/api/tasks/${idE}/resolve`,
                       { verdict: "approve", note: "", resolved_by: "auto" }, WK);
  ok("R10 ⭐worker 令牌 resolve → 403(执行面拿不到裁定面)", rw.status === 403, `HTTP ${rw.status}`);
  const rv2 = await api("POST", `/api/tasks/${idE}/resolve`,
                        { verdict: "approve", note: "", resolved_by: "human" }, RV);
  ok("R11 review 令牌冒充 human → 400(机器审阅不得冒充人)", rv2.status === 400, `HTTP ${rv2.status}`);

} catch (e) {
  console.error("harness itself fell over:", e);
  fail++;
} finally {
  try { srv?.kill(); } catch {}
  await sleep(400);
  if (fail) console.log(`${NL}──── server output tail ────${NL}` + out.slice(-1500));
  try { rmSync(TMP, { recursive: true, force: true }); } catch {}
  console.log(`${NL}${"─".repeat(56)}${NL}result: ${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
}
