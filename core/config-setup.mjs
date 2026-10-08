// The one way a fleet.config.json is born — `npm run setup`, `node cli/init.mjs` and the
// panel's 「生成配置文件」 all call buildConfig(). It starts from examples/fleet.config.json
// and swaps the example's lines (someone else's engine/design/coord/astra) for EXECUTOR
// lines: 「Claude」 always — doctor already requires that CLI — and 「Codex」 only when the
// operator asked for it (`--codex`) AND a native codex executable was found. A newcomer's
// first task then goes to an executor they recognise: picking a line is picking who works.
//
// Unlocking the codex seat stays a human act. The config keys `codex_cmd` /
// `codex_released` are the same switches as BOARD_CODEX_CMD / BOARD_CODEX_RELEASED
// (core/env.mjs backfills them, env still wins); setup writes them only on `--codex`,
// which INSTALL.md tells the operator's AI to pass only when the operator asked for Codex.
//
// Still a PURE CREATE: writeNewConfig uses flag "wx", so an existing config — the
// operator's — is never touched, whoever calls.
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { CODE_ROOT } from "./env.mjs";

const WIN = process.platform === "win32";
const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };
const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };

/** First `name + ext` on PATH. PATH is walked by hand for the reason doctor gives: `where`
 *  answers in the console codepage, and its first hit on npm installs is a bash shim. */
export function findOnPath(name, { env = process.env, exts = WIN ? [".exe", ".cmd", ".bat", ""] : [""] } = {}) {
  const dirs = String(env.PATH ?? env.Path ?? "").split(WIN ? ";" : ":");
  for (const ext of exts)
    for (const d of dirs) {
      if (!d) continue;
      const p = join(d, name + ext);
      if (isFile(p)) return p;
    }
  return null;
}

/** The claude CLI the worker loop would find (host env first, then PATH), or null. */
export function detectClaude(env = process.env) {
  return env.WORKER_CLAUDE_CLI || findOnPath("claude", { env });
}

// The native codex.exe inside an npm install, next to the codex.cmd shim PATH offers. The
// package layout has moved between releases, so search the @openai scope (bounded) instead
// of pinning one path.
function codexInNpm(shimDir) {
  const stack = [[join(shimDir, "node_modules", "@openai"), 0]];
  let seen = 0;
  while (stack.length) {
    const [dir, depth] = stack.pop();
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (++seen > 5000) return null;
      const p = join(dir, e.name);
      if (e.isFile() && e.name.toLowerCase() === "codex.exe") return p;
      if (e.isDirectory() && depth < 8) stack.push([p, depth + 1]);
    }
  }
  return null;
}

/** A codex executable the codex seat's gate (loops/codex_runtime.py) would accept — absolute,
 *  existing, never a .cmd/.bat/.ps1 wrapper, and on Windows a real .exe — or null. */
export function detectCodex(env = process.env) {
  const native = (p) => !!p && isAbsolute(p) && isFile(p) &&
    !/\.(cmd|bat|ps1)$/i.test(p) && (!WIN || /\.exe$/i.test(p));
  const cands = [env.BOARD_CODEX_CMD,
    env.LOCALAPPDATA && join(env.LOCALAPPDATA, "OpenAI", "Codex", "bin", "codex.exe"),
    !WIN && env.HOME && join(env.HOME, ".local", "bin", "codex"),
    findOnPath("codex", { env, exts: WIN ? [".exe"] : [""] })];
  const found = cands.find(native);
  if (found || !WIN) return found || null;
  const shim = findOnPath("codex", { env, exts: [".cmd", ""] });
  const inNpm = shim && codexInNpm(dirname(shim));
  return native(inNpm) ? inNpm : null;
}

/** `--repo`: where tasks run. Must be an existing git work tree — the deliverable gate reads
 *  its HEAD — and must neither be, sit inside, nor contain the board's own folder: the source
 *  gate watches that tree, so every commit there would hold every line until the next
 *  confirmation. Returns { path } or { error }. */
export function checkRepo(raw) {
  const path = resolve(String(raw));
  if (!isDir(path)) return { error: `工作目录不存在: ${path}` };
  const within = (child, parent) => { const r = relative(parent, child); return r === "" || (!r.startsWith("..") && !isAbsolute(r)); };
  if (within(path, CODE_ROOT) || within(CODE_ROOT, path))
    return { error: `${path} 是看板自己的目录(或包含它)—— 任务要在另一个项目里执行;把看板放在项目外面` };
  try {
    const inside = execFileSync("git", ["-C", path, "rev-parse", "--is-inside-work-tree"],
                                { encoding: "utf8", windowsHide: true, timeout: 15000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (inside !== "true") throw new Error("not a work tree");
  } catch {
    return { error: `${path} 不是 git 仓库 —— 交付闸要读它的提交记录。先在那里 git init 并提交一次,或换一个已有的 git 仓库` };
  }
  return { path };
}

export const EXAMPLE_CONFIG = join(CODE_ROOT, "examples", "fleet.config.json");

/** The config a fresh install gets. `codex` = the native path (only when the operator asked
 *  for Codex); `repo` = an absolute work-tree path already checked by checkRepo. */
export function buildConfig(example = JSON.parse(readFileSync(EXAMPLE_CONFIG, "utf8")), { codex = null, repo = null } = {}) {
  const cfg = structuredClone(example);
  cfg._setup = "由 npm run setup 按这台电脑上的 AI 执行器生成:一条线 = 一个执行器,派任务时选线就是选谁来做。" +
    "随时可改;port / repo / gated_subtree 改完重启看板生效,加线不用重启。";
  if (repo) cfg.repo = repo;
  // The Claude line is a plain line: it runs the default agent, so a model changed later in
  // the panel is just a setting, not a drift from a declared identity.
  cfg.lines = [{ id: "claude", label: "Claude", hint: "通用任务,由 Claude Code 执行" }];
  const seat = (cfg.runtimes || []).find((r) => r.id === "codex");
  if (codex && seat?.models?.length) {
    const model = seat.models[0], efforts = model.efforts || seat.efforts || [];
    cfg.lines.push({ id: "codex", label: "Codex", hint: "通用任务,由 Codex 执行",
                     role: { seat: { runtime: "codex", model: model.id, effort: efforts.includes("high") ? "high" : efforts[0] } } });
    cfg._codex = "codex_cmd / codex_released = BOARD_CODEX_CMD / BOARD_CODEX_RELEASED(环境变量优先)。" +
      "Codex 座席没有 Claude 座席那样的路径封锁,只靠提示词约束;不想让它接活,把 codex_released 改成 false 并重启看板。";
    cfg.codex_cmd = codex;
    cfg.codex_released = true;
  }
  // The example's handoff directories exist on one machine only — doctor fails on a
  // declared directory that is not there. Declaring one is the operator's act.
  delete cfg.handoff_targets;
  cfg._handoff = "要让看板往本地目录交文件(SQL、文档…),照 examples/fleet.config.json 的 handoff_targets 加,目录要先建好。";
  return cfg;
}

/** Create the config; refuses (EEXIST) instead of overwriting. */
export function writeNewConfig(file, cfg) {
  writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
}

/** Words for what a config runs: 「Claude、Codex」. */
export const lineNames = (cfg) => (cfg.lines || []).map((l) => l.label || l.id).join("、");
