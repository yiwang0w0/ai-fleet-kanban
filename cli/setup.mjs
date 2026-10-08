// `npm run setup` (= node cli/setup.mjs) — the newcomer's one command, and the command
// INSTALL.md has the operator's own AI run.
//
//   node cli/setup.mjs [--repo <dir>] [--codex] [--no-doctor]
//     --repo <dir>  where tasks run: an existing git work tree. Without it tasks run in this
//                   board's own folder — fine for a look around, not for real work.
//     --codex       also give Codex a line and unlock its seat. Unlocking a seat is the
//                   operator's decision: pass it only when they asked for Codex.
//     --no-doctor   skip ① (harness use only)
//   (Flags go to node directly: in PowerShell `npm run setup -- --codex` can lose its `--`
//    to npm.ps1, and npm then eats the flag.)
//
// Each step is idempotent and a PURE CREATE — never overwrites, carries no governance
// meaning — the same rule POST /api/setup/init-config and cli/init.mjs follow:
//   ① doctor — measure the machine. Red stops here: an environment that is not ready
//      is not something to configure around.
//   ② fleet.config.json — built for this machine by core/config-setup.mjs, if absent.
//   ③ core/verify_registry.json — from examples/verify_registry.example.json, if
//      absent. store.js validates a card's verify_cmd against this file, and a fresh
//      clone has none.
//   ④ say what is left: start the board, open the panel — both the AI's to run — and the
//      one step that is the operator's own: confirming the code version (the source gate),
//      a panel button that shows the version first and carries what you saw (confirm_tree).
import { copyFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { CODE_ROOT, CONFIG_FILE, applyConfigDefaults } from "../core/env.mjs";
import { buildConfig, checkRepo, detectCodex, lineNames, writeNewConfig } from "../core/config-setup.mjs";

const USAGE = "用法: node cli/setup.mjs [--repo <工作目录>] [--codex] [--no-doctor]";
const opts = { doctor: true, codex: false, repo: null };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--no-doctor") opts.doctor = false;
  else if (a === "--codex") opts.codex = true;
  else if (a === "--repo" && argv[i + 1] && !argv[i + 1].startsWith("--")) opts.repo = argv[++i];
  else if (a.startsWith("--repo=") && a.length > 7) opts.repo = a.slice(7);
  else { console.error(`不认识的参数: ${a}\n${USAGE}`); process.exit(2); }
}
// Same resolution store.js uses (BOARD_VERIFY_REGISTRY || core/verify_registry.json):
// setup must write where the store reads, or the file lands where nothing looks.
const REGISTRY = process.env.BOARD_VERIFY_REGISTRY || join(CODE_ROOT, "core", "verify_registry.json");
const say = (s = "") => console.log(s);

say("== setup ==");
// A wrong --repo must not leave half an install behind: check it before anything is written.
let repo = null;
if (opts.repo) {
  const r = checkRepo(opts.repo);
  if (r.error) { say(`⛔ --repo: ${r.error}`); process.exit(1); }
  repo = r.path;
}
if (opts.doctor) {
  say("① 体检(node cli/doctor.mjs)");
  // Doctor measures the deployment about to be written: with --repo and no config yet, the
  // work tree is that repo, not this folder (else it warns the tokens sit inside it).
  const env = repo && !existsSync(CONFIG_FILE) && !process.env.BOARD_REPO ? { ...process.env, BOARD_REPO: repo } : process.env;
  const r = spawnSync(process.execPath, [join(CODE_ROOT, "cli", "doctor.mjs")], { stdio: "inherit", env });
  if (r.status !== 0) {
    say();
    say("体检有红项 —— 先修再 setup(每一行红下面都写着修法)。环境没准备好,配置帮不上。");
    process.exit(r.status || 1);
  }
} else say("① 体检:跳过(--no-doctor)");

if (existsSync(CONFIG_FILE)) {
  say(`② fleet.config.json:已存在,不覆盖 —— ${CONFIG_FILE}`);
  if (repo || opts.codex)
    say("   --repo / --codex 只在新建配置时生效。要改现有配置:编辑这个文件(写法见 INSTALL.md「改配置」),再重启看板");
} else {
  const codex = opts.codex ? detectCodex() : null;
  const cfg = buildConfig(undefined, { codex, repo });
  writeNewConfig(CONFIG_FILE, cfg);
  say(`② fleet.config.json:已生成 —— ${CONFIG_FILE}`);
  say(`   执行线: ${lineNames(cfg)}` + (codex ? `(Codex = ${codex})` : ""));
  say(repo ? `   任务在 ${repo} 里执行`
           : "   ⚠ 没给 --repo:任务会在看板自己的目录里执行 —— 只适合先看看。正式用时把 repo 写进配置并重启看板");
  if (opts.codex && !codex)
    say("   ⚠ 没找到原生 codex 可执行文件,Codex 线没有生成 —— 装好 Codex 后按 INSTALL.md「改配置」补上 codex_cmd");
  else if (!opts.codex) {
    const found = detectCodex();
    if (found) say(`   这台电脑上还有 Codex(${found}),没有启用 —— 要让它也接活,按 INSTALL.md「改配置」加上`);
  }
}
if (existsSync(REGISTRY)) say(`③ verify_registry.json:已存在,不覆盖 —— ${REGISTRY}`);
else {
  copyFileSync(join(CODE_ROOT, "examples", "verify_registry.example.json"), REGISTRY);
  say(`③ verify_registry.json:已生成 —— ${REGISTRY}(从 examples/ 抄来)`);
}

applyConfigDefaults();               // the config exists now; read its port for the message
const port = process.env.BOARD_PORT || 47824;

say();
say("接下来(可以交给你的 AI):");
say("  1. npm run start:bg   在后台起板,关掉这个窗口也不停;停止用 npm run stop(想在当前窗口看日志:npm start)");
say(`  2. npm run open       打开面板 http://127.0.0.1:${port} —— 自动连上,这台电脑的浏览器会记住`);
say("最后一步得你本人来:面板首页会提示「确认当前版本」—— 看一眼版本号,点确认。");
say("  看板只运行你确认过的代码;以后每次更新看板代码都要再确认一次。命令行也行:python cli/board.py bless");
say();
say("改线、换工作目录:编辑 fleet.config.json,或者让你的 AI 改(INSTALL.md「改配置」)。");
say("玩脏了想重来:node cli/reset.mjs --yes(只清 .data/,不碰配置和仓库)。");
