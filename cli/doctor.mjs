// Preflight for a fresh clone: `node cli/doctor.mjs`
//
// Every check MEASURES (spawns, binds, requires) — none of them merely reads a
// version string and guesses. Exit 0 = a board started here would come up; every
// red line carries the fix. The cold-QUICKSTART acceptance run starts with this.
//
// ⚠ Read-only by design: doctor never writes config, never creates directories,
//   never touches a database. A preflight that "helpfully" mutates state turns
//   diagnosis into a second thing to diagnose.

import { execFileSync, execSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, accessSync, constants } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join, dirname, isAbsolute, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {inspectSeatCLI} from "../core/seat-cli-evidence.mjs";
import { MIN_GIT_VERSION, probeGitVersion } from "../core/git-version.mjs";
import { applyConfigDefaults, nodeTooOld } from "../core/env.mjs";
import { detectCodex } from "../core/config-setup.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

let pass = 0, warn = 0, fail = 0;
const ok = (name, detail = "") => { pass++; console.log(`  PASS  ${name}${detail ? " — " + detail : ""}`); };
const wr = (name, detail = "") => { warn++; console.log(`  WARN  ${name}${detail ? " — " + detail : ""}`); };
const no = (name, fix = "") => { fail++; console.log(`  FAIL  ${name}${fix ? "\n        修法: " + fix : ""}`); };

console.log("[AI Fleet Kanban · doctor]\n");

// fleet.config 的部署键(port/repo/gated_subtree)回填 env 缺省(v0.3)。记住
// 端口的来源 —— 收尾行照来源措辞,教操作者用他实际用的机制。
const HAD_PORT_ENV = !!process.env.BOARD_PORT;
const CFG0 = applyConfigDefaults();
const PORT_SRC = HAD_PORT_ENV ? "BOARD_PORT" : CFG0.port != null ? "fleet.config" : "默认";

// ── ① node:sqlite — the store's engine ──────────────────────────────────────
try {
  if (nodeTooOld()) throw new Error("Unsupported Node version");
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  try {
    if (db.isTransaction !== false) throw new Error("Missing SQLite transaction state");
    db.exec("BEGIN; CREATE TABLE t (x)");
    if (db.isTransaction !== true) throw new Error("SQLite transaction state did not advance");
    db.exec("ROLLBACK");
    if (db.isTransaction !== false) throw new Error("SQLite transaction state did not reset");
  } finally { db.close(); }
  ok(`node:sqlite 及事务状态接口可用(node ${process.version})`);
} catch (e) {
  no(`node:sqlite 不可用(node ${process.version})`,
     "需要 Node >= 24.0.0 及正常的 SQLite isTransaction 接口。安装 Node 24 LTS 后重试。");
}

// ── ② python — the loops' runtime ───────────────────────────────────────────
const pyCands = [process.env.BOARD_PYTHON, process.env.PYTHON, "python", "py", "python3"].filter(Boolean);
let PY = null;
for (const c of pyCands) {
  try {
    const v = execFileSync(c, ["-c", "import sys;print(sys.version_info[0],sys.version_info[1])"],
                           { encoding: "utf8", windowsHide: true, timeout: 15000 }).trim();
    const [maj, min] = v.split(" ").map(Number);
    if (maj > 3 || (maj === 3 && min >= 9)) { PY = c; ok(`python 可用(${c} = ${maj}.${min})`); }
    else { PY = c; wr(`python 版本偏老(${c} = ${maj}.${min})`, "建议 3.9+"); }
    break;
  } catch {}
}
if (!PY) no("找不到 python(试过: " + pyCands.join(" / ") + ")",
            "装 Python 3 或设 BOARD_PYTHON 指向解释器。worker 循环没有它起不来。");
// Windows pipes default to a legacy codepage; a single CJK char in a card
// subject can kill a piped harness/CLI with UnicodeEncodeError (measured in
// the cold walkthrough's environment notes). Warn, don't fail — the shipped
// entrypoints pin utf-8 themselves; this protects the operator's OWN pipes.
if (process.platform === "win32" && process.env.PYTHONUTF8 !== "1")
  wr("PYTHONUTF8 未设(Windows)", 'PowerShell 里 $env:PYTHONUTF8 = "1" —— 管道默认走旧码页,中文输出会被毁');

// ── ③ git — the revision gate's ground ──────────────────────────────────────
try {
  const gitVersion = probeGitVersion("git");
  try {
    execFileSync("git", ["-C", ROOT, "rev-parse", "HEAD"], { stdio: "ignore", windowsHide: true, timeout: 15000 });
    ok("Git " + gitVersion + " 可用（最低 " + MIN_GIT_VERSION + "），且本目录是 git 仓库");
  } catch {
    wr("git 可用,但本目录不是 git 仓库", "revision 闸(accepted_rev)需要 git 历史;git init 或从 clone 运行");
  }
} catch (e) {
  no((e.code || "GIT_UNAVAILABLE") + ": " + e.message, "安装 Git for Windows >= " + MIN_GIT_VERSION + " 后重试；联邦产物读取需要 --no-lazy-fetch。");
}

// ── ④ the local agent CLI — who actually does the work ──────────────────────
// Same resolution the worker loop uses: host env wins, then PATH; a .cmd shim on
// Windows is refused by the BatBadBut gate, so probe for the native sibling.
// CLI_PATH / CLI_IS_SHIM are read again by ⑤b — resolve the CLI once, here.
let CLI_PATH = null, CLI_IS_SHIM = false;
{
  const envCli = process.env.WORKER_CLAUDE_CLI;
  // PATH is walked by hand rather than via `where`: its output arrives in the
  // console codepage (CJK profile paths come back mojibake, unusable as paths),
  // and its FIRST line on npm installs is an extension-less bash shim that
  // CreateProcess cannot start — doctor's first run called that one "ready",
  // a false green. Preference order mirrors what can actually be spawned.
  const which = (name) => {
    const dirs = String(process.env.PATH || "").split(process.platform === "win32" ? ";" : ":");
    const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
    for (const ext of exts)
      for (const d of dirs) {
        if (!d) continue;
        const p = join(d, name + ext);
        if (existsSync(p)) return p;
      }
    return null;
  };
  const isBatch = (p) => /\.(cmd|bat)$/i.test(p || "");
  // An extension-less file on Windows is a bash shim — as unusable as a .cmd.
  const isShim = (p) => process.platform === "win32" && (isBatch(p) || !/\.exe$/i.test(p || ""));
  const target = envCli || which("claude");
  CLI_PATH = target; CLI_IS_SHIM = !!target && isShim(target);
  if (!target) {
    no("找不到 claude CLI(WORKER_CLAUDE_CLI 未设,PATH 上也没有)",
       "装 Claude Code,或设 WORKER_CLAUDE_CLI 指向原生可执行文件。没有它,卡可以建、不能被干。");
  } else if (isShim(target)) {
    // The gate will refuse a shim at start time — say so NOW, with the fix.
    const native = join(dirname(target), "node_modules", "@anthropic-ai", "claude-code", "bin",
                        "claude" + (process.platform === "win32" ? ".exe" : ""));
    if (existsSync(native))
      wr(`claude 解析到 npm 包装器(${target})`,
         `worker 会自动改用旁边的原生文件: ${native}`);
    else
      no(`claude 解析到包装器(${target}),且旁边没有原生可执行文件`,
         "设 WORKER_CLAUDE_CLI 指向原生 claude 可执行文件(不是 npm 的 shim)。");
  } else {
    ok(`claude CLI 就位(${target})`);
  }
}

// ── ⑤ fleet.config.json — absent is fine, broken is not ─────────────────────
{
  const cfgPath = process.env.BOARD_CONFIG || join(ROOT, "fleet.config.json");
  if (!existsSync(cfgPath)) {
    ok("fleet.config.json 不存在 —— 用内置缺省(线=alpha/coord)。这不是错误",
       "npm run setup 会按这台电脑上的执行器生成一份(INSTALL.md)");
  } else {
    try {
      const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
      const bad = [];
      if (!Array.isArray(cfg.lines) || !cfg.lines.length) bad.push("lines[] 必须是非空数组");
      if (!Array.isArray(cfg.routes) || !cfg.routes.length) bad.push("routes[] 必须是非空数组");
      if (!Array.isArray(cfg.runtimes) || !cfg.runtimes.length) bad.push("runtimes[] 必须是非空数组");
      if (bad.length) no(`fleet.config.json 结构不完整(${cfgPath})`, bad.join(";") + " —— server 会拒绝启动(坏档不静默降级)");
      else ok(`fleet.config.json 有效(${cfg.lines.map((l) => l.id).join("/")})`);
      // Handoff targets: authorization means the directory must really be there.
      for (const t of cfg.handoff_targets || []) {
        if (!t.dir || !isAbsolute(String(t.dir))) { no(`handoff 目标 ${t.id}: dir 必须是绝对路径`, "改 fleet.config.json"); continue; }
        if (!existsSync(t.dir)) no(`handoff 目标 ${t.id} 的目录不存在: ${t.dir}`,
                                   "先建目录 —— 授权指向一个不存在的地方,落靶时才炸不如现在就说");
        else {
          try { accessSync(t.dir, constants.W_OK); ok(`handoff 目标 ${t.id} 可写(${t.dir})`); }
          catch { no(`handoff 目标 ${t.id} 的目录不可写: ${t.dir}`, "检查权限"); }
        }
      }
    } catch (e) {
      no(`fleet.config.json 不是合法 JSON(${cfgPath})`, e.message + " —— server 会拒绝启动");
    }
  }
}

// ── ⑥ the port — bind it for real, then let go ──────────────────────────────
await new Promise((resolve) => {
  const port = Number(process.env.BOARD_PORT || 47824);
  const srv = createServer();
  srv.once("error", (e) => {
    if (e.code === "EADDRINUSE")
      wr(`端口 ${port} 已被占用`, "可能已有一块看板在运行(不是错误);要并行第二块:server 和所有客户端命令都带同一个 BOARD_PORT(或统一设 BOARD_URL)——只搬 server 不搬客户端,命令会发到旧端口的那块看板");
    else no(`端口 ${port} 绑不上(${e.code})`, "检查防火墙/权限,或换 BOARD_PORT");
    resolve();
  });
  srv.listen(port, "127.0.0.1", () => {
    srv.close(() => { ok(`端口 ${port} 可用(来源: ${PORT_SRC})`); resolve(); });
  });
});

// ── ⑤b CLI contract — the flags this board actually passes ──────────────────
// The loops drive the CLI through a fixed argv. Every harness runs against a STUB,
// and a stub accepts anything — so a renamed or dropped flag is invisible to all
// 600+ assertions and shows up only as a live worker that will not start. Here we
// ask the real CLI what it takes and compare. Names are quoted from `--help`, not
// from memory.
{
  // "-p, --print" is checked as one help fragment: the loops pass the SHORT form,
  // so asserting only "--print" would test a spelling we never use.
  const CLI_FLAGS = ["-p, --print", "--model", "--effort", "--permission-mode", "--disallowedTools",
                     "--allowedTools", "--add-dir", "--output-format",
                     "--resume", "--session-id", "--fork-session", "--max-budget-usd"];
  const CLI_CHOICES = { "--effort": ["low", "medium", "high", "xhigh", "max"],
                        "--permission-mode": ["acceptEdits"],
                        "--output-format": ["json"] };
  if (!CLI_PATH) {
    wr("跳过 CLI 参数契约检查(没找到 claude)", "装了 CLI 再跑一次 doctor —— 参数对不上时 worker 起不来,而所有 harness 都用桩,看不出这件事");
  } else {
    try {
      // A shim is refused for WORK (argument mangling, swallowed exit codes) but is
      // fine for reading `--help`: no arguments to mangle, and we want the text, not
      // the exit code. Windows cannot spawn .cmd/.bat or an extension-less bash shim
      // directly since Node 20 — those need a shell.
      // ⭐ The shim path is INTERPOLATED into that shell string, so a path carrying
      //   `"` closes the quoting and `%VAR%` expands inside cmd's double quotes
      //   (both demonstrated externally, audit 2026-10-05). The shim path comes from
      //   WORKER_CLAUDE_CLI or a PATH walk for fixed names — an operator-controlled
      //   value, so refuse the two shell-active characters instead of escaping them:
      //   a diagnostic command never needs them.
      if (CLI_IS_SHIM && /["%]/.test(CLI_PATH))
        no(`CLI 路径含 shell 活动字符(引号或 %): ${CLI_PATH}`,
           "换一个不含 \" 和 % 的 claude 入口路径(WORKER_CLAUDE_CLI),doctor 才能安全地经 shell 读它的 --help");
      else {
      const help = CLI_IS_SHIM
        ? execSync(`"${CLI_PATH}" --help`, { encoding: "utf8", windowsHide: true, timeout: 30000 })
        : execFileSync(CLI_PATH, ["--help"], { encoding: "utf8", windowsHide: true, timeout: 30000 });
      const missing = CLI_FLAGS.filter((f) => !help.includes(f));
      if (missing.length)
        no(`CLI 不认识这些参数: ${missing.join(" ")}`,
           "这个 CLI 版本与本板驱动它的方式不匹配 —— worker 会起不来。升级看板,或把 CLI 降回兼容版本");
      else ok(`CLI 参数契约吻合(${CLI_FLAGS.length} 个)`);
      for (const [flag, want] of Object.entries(CLI_CHOICES)) {
        const bad = want.filter((v) => !help.includes(v));
        if (bad.length)
          wr(`${flag} 的取值 ${bad.join("/")} 没出现在 --help 里`,
             "可能是 CLI 改了值域;fleet.config 里配了它的槽会在启动时才报错");
      }
      }
    } catch (e) {
      wr(`CLI --help 跑不起来(${String(e.message).slice(0, 50)})`, "参数契约这一项没测成 —— 不是通过,是没测");
    }
  }
}

// Record actual native CLI version and bytes; help compatibility is not a deny-rule measurement.
{
  let native=CLI_PATH;
  if(CLI_IS_SHIM&&native){
    const sibling=join(dirname(native),"node_modules","@anthropic-ai","claude-code","bin","claude.exe");
    native=existsSync(sibling)?sibling:null;
  }
  if(native){
    try{
      const observation=inspectSeatCLI(resolve(native));
      console.log("  seat-cli-evidence: "+JSON.stringify(observation));
      if(observation.measurement.status==="matched")ok("座席 CLI 与同平台已测量版本及摘要一致");
      else wr("座席 CLI 权限语义尚无同平台、同版本、同摘要的实测记录","版本/摘要已列出；历史 Linux 测量不能证明此 Windows 文件的 deny 规则有效");
    }catch{wr("座席 CLI 版本或摘要未能核实","未执行模型；此项不能作为权限语义验收");}
  }else wr("没有可核实的原生座席 CLI","不把包装器或缺失文件视为已测量执行器");
}

// ── ⑤c the trust boundary: are the tokens and the registry inside the worker's reach? ─
// Measured 2026-09-07 with the real CLI (Windows): a Claude worker in -p mode can Read any
// absolute path on the machine, so moving .data out of the repo is not a barrier by itself;
// the loops pass path-scoped --disallowedTools rules instead. Measured again 2026-09-28
// (Linux, Claude Code 2.1.283): the rule's path must be spelled `//abs` — a single leading
// slash is project-root-relative and matches nothing, which is how v0.17.0's rules were
// inert on POSIX. The codex seat has no equivalent — there the boundary is prose.
{
  const REPO_ROOT = resolve(process.env.BOARD_REPO || ROOT);
  const DATA = resolve(process.env.BOARD_DATA_DIR || join(ROOT, "core", ".data"));
  const REG = resolve(process.env.BOARD_VERIFY_REGISTRY || join(ROOT, "core", "verify_registry.json"));
  const inside = (p) => { const r = relative(REPO_ROOT, p); return r !== "" && !r.startsWith("..") && !isAbsolute(r); };
  const exposed = [DATA, REG].filter(inside);
  if (exposed.length)
    wr(`令牌目录 / 登记簿在工作仓之内(${exposed.map((x) => relative(REPO_ROOT, x)).join(", ")})`,
       "Claude 座席靠 --disallowedTools 路径规则封住(下一项核对它的写法);codex 座席只有提示词纪律。若要跑 codex 座席,把 BOARD_DATA_DIR 与 BOARD_VERIFY_REGISTRY 指到工作仓之外,或让舰队用独立的 OS 用户跑");
  else ok("令牌目录与登记簿都在工作仓之外(Claude 座席另有 deny 规则兜底)");
  // ⑤d the SPELLING of those rules, as this deployment would actually emit them. Every
  // harness drives a stub and a stub enforces nothing; doctor cannot measure semantics
  // either (that takes a live model call), but it can refuse the one shape that is known
  // to be inert: a POSIX absolute path without the `//` prefix, or a Write/Glob/Grep rule
  // (the CLI says those are not matched by file permission checks).
  if (PY) {
    try {
      const out = execFileSync(PY, [join(ROOT, "loops", "verify_lib.py"), "--print-deny-rules"],
                               { encoding: "utf8", windowsHide: true, timeout: 15000,
                                 env: { ...process.env, BOARD_DATA_DIR: DATA, PYTHONIOENCODING: "utf-8" } });
      const rules = out.split(/\r?\n/).filter(Boolean);
      const badTool = rules.filter((r) => !/^(Read|Edit)\(/.test(r));
      const badPath = rules.filter((r) => {
        const p = r.replace(/^\w+\(/, "");
        return process.platform === "win32" ? !/^[A-Za-z]:\//.test(p) : !p.startsWith("//");
      });
      if (!rules.length) no("deny 规则为空", "verify_lib.cli_deny_rules 没有产出 —— Claude 座席对令牌目录不设防");
      else if (badTool.length || badPath.length)
        no(`deny 规则写法不对(${badTool.length} 条非 Read/Edit,${badPath.length} 条路径不是绝对形)`,
           `例: ${(badTool[0] || badPath[0]).slice(0, 80)} —— 这种写法 CLI 不匹配,规则等于没有(2026-09-28 实测)`);
      else ok(`deny 规则写法正确(${rules.length} 条,Read/Edit,${process.platform === "win32" ? "盘符" : "//"} 绝对路径)`);
    } catch (e) {
      wr(`deny 规则没读到(${String(e.message).slice(0, 60)})`, "这一项没测成 —— 不是通过,是没测");
    }
  }
}

// ── ⑤e the family pairing (v0.23). Measured evidence (docs/方案-身份分配.md §1.3): Claude
//    reviewing Codex raised the pass rate 71.6→89.7; Codex reviewing Claude LOWERED it
//    91.4→82.8. So a codex auto-review seat over claude implement lines is the one pairing
//    known to cost accuracy. Warn, never refuse — the operator may know better.
{
  try {
    const DATA = resolve(process.env.BOARD_DATA_DIR || join(ROOT, "core", ".data"));
    let ws = {}; try { ws = JSON.parse(readFileSync(join(DATA, "worker_settings.json"), "utf8")); } catch {}
    const defRt = CFG0.default_agent?.runtime || "claude";
    const rtOf = (line, role) => ws[line]?.agents?.[0]?.runtime || role?.seat?.runtime || defRt;
    const lines = Array.isArray(CFG0.lines) ? CFG0.lines : [];
    const hasReview = (CFG0.roles || []).includes("review");
    const reviewRt = ws.review?.agents?.[0]?.runtime || defRt;
    const implLines = lines.filter((l) => (l.role?.kind || "implement") === "implement");
    const impl = implLines.map((l) => `${l.id}=${rtOf(l.id, l.role)}`);
    if (hasReview && reviewRt === "codex" && implLines.some((l) => rtOf(l.id, l.role) === "claude"))
      wr(`自动审阅座席是 codex,而实现线在 claude(${impl.join(", ")})`,
         "实测这是唯一会降准确率的配对(Codex 审 Claude:91.4→82.8;Claude 审 Codex:71.6→89.7)。把另一家族放到方案评审线(lines[].role.kind=review),代码阶段的审阅座席留 Claude");
    else if (hasReview) ok(`审阅配对:审阅=${reviewRt},实现线 ${impl.join(", ") || "(无)"}`);
    const anti = CFG0.review?.anti_affinity;
    if (anti != null && anti !== "" && anti !== false && anti !== "runtime")
      no(`review.anti_affinity 只接受 "runtime"(收到 ${JSON.stringify(anti)})`, "server 会拒绝启动");
    else if (anti === "runtime" && hasReview && implLines.length && implLines.every((l) => rtOf(l.id, l.role) === reviewRt))
      wr(`反亲和已开,但所有实现线都和审阅座席同家族(${reviewRt})`,
         "每一张交付都会被留给人 —— 要么把实现线换家族,要么关掉 review.anti_affinity");
  } catch (e) { wr(`配对检查没跑成(${String(e.message).slice(0, 60)})`, "不是通过,是没测"); }
}

// ── ⑥b browser (optional) — only front-end verification needs it ────────────
// Not a failure when absent: most fleets never verify a page. But when a card
// DOES touch the UI, this is the difference between machine evidence and "I
// changed it, trust me" — so say whether it is available before someone needs it.
{
  const cands = [process.env.BOARD_BROWSER,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].filter(Boolean);
  const found = cands.find((p) => existsSync(p));
  if (found) ok(`浏览器可用(${found.split(/[\\/]/).pop()})`, "前端卡可以用 examples/verify_page.mjs 产出机器证据");
  else wr("没找到 Chrome/Edge", "只影响前端页面验证(examples/verify_page.mjs);其余功能不需要它。装一个,或设 BOARD_BROWSER");
}

// ── ⑦ second seat (optional) — only judged if the host says it exists ───────
if (!process.env.BOARD_CODEX_CMD) {
  // Not a finding either way — but the native exe hides in a place PATH never
  // shows (a real deployment dug it out of %LOCALAPPDATA% by hand; the .cmd
  // shim PATH offers is exactly what the BatBadBut gate refuses). If we can
  // see it, say where it is — the same search `npm run setup -- --codex` uses.
  const found = detectCodex();
  if (found) ok(`发现原生 codex 可执行文件(${found})`,
                "要让 Codex 也接活:fleet.config.json 写 codex_cmd 指向它、codex_released: true,再加一条 codex 线(INSTALL.md「改配置」)");
}
if (process.env.BOARD_CODEX_CMD) {
  const p = process.env.BOARD_CODEX_CMD;
  if (!isAbsolute(p)) no("BOARD_CODEX_CMD 不是绝对路径", "第二座席的门会拒绝它");
  else if (!existsSync(p)) no(`BOARD_CODEX_CMD 指向的文件不存在: ${p}`, "修路径,或先不配置这个座席");
  else if (/\.(cmd|bat|ps1)$/i.test(p)) no("BOARD_CODEX_CMD 指向包装器脚本", "指向原生可执行文件(BatBadBut 门)");
  else ok(`第二座席 CLI 就位(${p})` + (process.env.BOARD_CODEX_RELEASED === "1" ? " 且已解禁" : ",未解禁(BOARD_CODEX_RELEASED=1 才领卡)"));
}

// ── ⑧ where the model traffic goes ───────────────────────────────────────────
// Everything a worker sends — your code, the card text, the model's answers — goes to the host
// its CLI is pointed at. A third-party relay (中转站) receives and can keep all of it, the same
// way the provider does under its own terms. Read from where the CLIs read it: the environment,
// Claude Code's settings (user, and the work repo the workers run in), Codex's config.toml.
// Only host names are printed — never a key, never a full URL. Informational: never a FAIL.
{
  const OFFICIAL = [/(^|\.)anthropic\.com$/, /(^|\.)openai\.com$/, /\.openai\.azure\.com$/, /(^|\.)bigmodel\.cn$/,
                    /(^|\.)z\.ai$/, /(^|\.)deepseek\.com$/, /(^|\.)moonshot\.(cn|ai)$/, /\.amazonaws\.com$/, /\.googleapis\.com$/];
  const KEYS = ["ANTHROPIC_BASE_URL", "ANTHROPIC_BEDROCK_BASE_URL", "ANTHROPIC_VERTEX_BASE_URL", "OPENAI_BASE_URL"];
  const HOME = process.env.USERPROFILE || process.env.HOME || homedir();
  const REPO = resolve(process.env.BOARD_REPO || ROOT);
  const seen = [];   // [where, name, url]
  const scan = (where, env) => { for (const k of KEYS) if (typeof env?.[k] === "string" && env[k].trim()) seen.push([where, k, env[k].trim()]); };
  scan("环境变量", process.env);
  for (const f of [join(HOME, ".claude", "settings.json"), join(REPO, ".claude", "settings.json"), join(REPO, ".claude", "settings.local.json")]) {
    try { scan(f, JSON.parse(readFileSync(f, "utf8")).env); } catch {}
  }
  const codexToml = join(process.env.CODEX_HOME || join(HOME, ".codex"), "config.toml");
  try { for (const m of readFileSync(codexToml, "utf8").matchAll(/^\s*base_url\s*=\s*["']([^"']+)["']/gm)) seen.push([codexToml, "base_url", m[1]]); } catch {}
  for (const [where, k, url] of seen) {
    let host = "";
    try { host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, ""); } catch {}
    if (!host) wr(`${k} 不是合法地址(${where})`, "CLI 会连不上模型;改成完整的 https:// 地址或删掉");
    else if (["localhost", "127.0.0.1", "::1"].includes(host))
      ok(`模型请求经本机代理 ${host}(${k},${where})`, "本机代理看得到全部内容 —— 确认它是你自己装的");
    else if (OFFICIAL.some((re) => re.test(host))) ok(`模型请求发往官方服务 ${host}(${k},${where})`);
    else wr(`模型请求经第三方转发 ${host}(${k},${where})`,
            "你的代码、任务内容和模型的回答都会经过它,它能留存全部内容 —— 改用官方服务,或确认这是你信任的服务");
  }
  if (!seen.length) ok("模型请求走各 CLI 的默认官方地址(没有设置转发地址)");
}

console.log(`\n${"─".repeat(56)}`);
// ⚠ The closing command must CARRY the address when it came from THIS SHELL's
//   env — pasting the bare command elsewhere would start the server back on the
//   default port (measured in a cold-machine walkthrough). A port from
//   fleet.config needs NO prefix: the server reads the same file itself —
//   that is the whole point of the config being the deployment truth (v0.3).
const envPrefix = process.env.BOARD_URL ? `BOARD_URL=${process.env.BOARD_URL} ` :
  HAD_PORT_ENV ? `BOARD_PORT=${process.env.BOARD_PORT} ` : "";
console.log(`result: ${pass} PASS / ${warn} WARN / ${fail} FAIL` +
            (fail ? "\n⛔ 有 FAIL —— 修完再起板(每条 FAIL 下面都写了修法)"
                  : (warn ? "\n可以起板(WARN 不拦路,但建议看一眼): "
                          : "\n一切就绪: ") +
                    `${envPrefix}node cli/start.mjs --background(后台;停止用 node cli/stop.mjs),或 ${envPrefix}node cli/start.mjs(在这个窗口里跑,面板按「更新」时原地重起)` +
                    (envPrefix ? "(PowerShell 用 $env: 形式设同名变量)" : "")));
process.exit(fail ? 1 : 0);
