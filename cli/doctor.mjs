// Preflight for a fresh clone: `node cli/doctor.mjs`
//
// Every check MEASURES (spawns, binds, requires) — none of them merely reads a
// version string and guesses. Exit 0 = a board started here would come up; every
// red line carries the fix. The cold-QUICKSTART acceptance run starts with this.
//
// ⚠ Read-only by design: doctor never writes config, never creates directories,
//   never touches a database. A preflight that "helpfully" mutates state turns
//   diagnosis into a second thing to diagnose.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, accessSync, constants } from "node:fs";
import { createServer } from "node:net";
import { join, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { applyConfigDefaults } from "../core/env.mjs";

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
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE t (x)");
  db.close();
  ok(`node:sqlite 可用(node ${process.version})`);
} catch (e) {
  no(`node:sqlite 不可用(node ${process.version})`,
     "需要 node >= 22.5(建议 24+)。nvm/官网安装后重试。");
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
  execFileSync("git", ["--version"], { stdio: "ignore", windowsHide: true, timeout: 15000 });
  try {
    execFileSync("git", ["-C", ROOT, "rev-parse", "HEAD"], { stdio: "ignore", windowsHide: true, timeout: 15000 });
    ok("git 可用,且本目录是一个 git 仓库(revision 闸有地可站)");
  } catch {
    wr("git 可用,但本目录不是 git 仓库", "revision 闸(accepted_rev)需要 git 历史;git init 或从 clone 运行");
  }
} catch {
  no("找不到 git", "revision 闸与 CI 都需要它。安装 git 后重试。");
}

// ── ④ the local agent CLI — who actually does the work ──────────────────────
// Same resolution the worker loop uses: host env wins, then PATH; a .cmd shim on
// Windows is refused by the BatBadBut gate, so probe for the native sibling.
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
       "要定制就从 examples/fleet.config.json 抄一份到仓库根,或让你的 Claude 替你写");
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

// ── ⑦ second seat (optional) — only judged if the host says it exists ───────
if (!process.env.BOARD_CODEX_CMD) {
  // Not a finding either way — but the native exe hides in a place PATH never
  // shows (a real deployment dug it out of %LOCALAPPDATA% by hand; the .cmd
  // shim PATH offers is exactly what the BatBadBut gate refuses). If we can
  // see it, say where it is.
  const guesses = [
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "OpenAI", "Codex", "bin", "codex.exe"),
    process.env.HOME && join(process.env.HOME, ".local", "bin", "codex"),
  ].filter(Boolean);
  const found = guesses.find((p) => { try { accessSync(p, constants.X_OK); return true; } catch { return false; } });
  if (found) ok(`发现原生 codex 可执行文件(${found})`, "要启用第二座席:BOARD_CODEX_CMD 指向它 + BOARD_CODEX_RELEASED=1");
}
if (process.env.BOARD_CODEX_CMD) {
  const p = process.env.BOARD_CODEX_CMD;
  if (!isAbsolute(p)) no("BOARD_CODEX_CMD 不是绝对路径", "第二座席的门会拒绝它");
  else if (!existsSync(p)) no(`BOARD_CODEX_CMD 指向的文件不存在: ${p}`, "修路径,或先不配置这个座席");
  else if (/\.(cmd|bat|ps1)$/i.test(p)) no("BOARD_CODEX_CMD 指向包装器脚本", "指向原生可执行文件(BatBadBut 门)");
  else ok(`第二座席 CLI 就位(${p})` + (process.env.BOARD_CODEX_RELEASED === "1" ? " 且已解禁" : ",未解禁(BOARD_CODEX_RELEASED=1 才领卡)"));
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
                    `${envPrefix}node core/server.mjs` +
                    (envPrefix ? "(PowerShell 用 $env: 形式设同名变量)" : "")));
process.exit(fail ? 1 : 0);
