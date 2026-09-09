// `node cli/setup.mjs` (= `npm run setup`) — the newcomer's one command.
//
// Four things, in order. Each is idempotent and each is a PURE CREATE — never
// overwrites, carries no governance meaning — the same rule POST /api/setup/init-config
// and cli/init.mjs follow:
//   ① doctor — measure the machine. Red stops here: an environment that is not ready
//      is not something to configure around. --no-doctor skips it (harness use only).
//   ② fleet.config.json — from examples/, if absent (what cli/init.mjs does by hand).
//   ③ core/verify_registry.json — from examples/verify_registry.example.json, if
//      absent. store.js validates a card's verify_cmd against this file, and a fresh
//      clone has none; the QUICKSTART used to leave that discovery to the first
//      refused card.
//   ④ say what is left and is YOURS: start, then accept the tree. Accepting is a human act —
//      since v0.18 a panel button that shows the diff and carries the tree you saw
//      (confirm_tree); the CLI stays as the alternative — so setup points there and stops.
import { copyFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { CODE_ROOT, CONFIG_FILE, applyConfigDefaults } from "../core/env.mjs";

const args = new Set(process.argv.slice(2));
// Same resolution store.js uses (BOARD_VERIFY_REGISTRY || core/verify_registry.json):
// setup must write where the store reads, or the file lands where nothing looks.
const REGISTRY = process.env.BOARD_VERIFY_REGISTRY || join(CODE_ROOT, "core", "verify_registry.json");
const say = (s = "") => console.log(s);

say("== setup ==");
if (!args.has("--no-doctor")) {
  say("① 体检(node cli/doctor.mjs)");
  const r = spawnSync(process.execPath, [join(CODE_ROOT, "cli", "doctor.mjs")], { stdio: "inherit", env: process.env });
  if (r.status !== 0) {
    say();
    say("体检有红项 —— 先修再 setup(每一行红下面都写着修法)。环境没准备好,配置帮不上。");
    process.exit(r.status || 1);
  }
} else say("① 体检:跳过(--no-doctor)");

const created = [];
const ensure = (label, src, dst) => {
  if (existsSync(dst)) { say(`${label}:已存在,不覆盖 —— ${dst}`); return; }
  copyFileSync(src, dst);
  created.push(dst);
  say(`${label}:已生成 —— ${dst}(从 examples/ 抄来)`);
};
ensure("② fleet.config.json", join(CODE_ROOT, "examples", "fleet.config.json"), CONFIG_FILE);
ensure("③ verify_registry.json", join(CODE_ROOT, "examples", "verify_registry.example.json"), REGISTRY);

applyConfigDefaults();               // the config exists now; read its port for the message
const port = process.env.BOARD_PORT || 47824;

say();
say("剩下两步是你的 —— 接受代码的人得是人,但不用敲命令:");
say(`  A. 起板         npm start          → http://127.0.0.1:${port}(端口取 fleet.config.json 的 port;没写就是 47824)`);
say("  B. 接受这棵树   打开面板,引导里按「接受当前代码」(会先列出版本和改动)。命令行也行:python cli/board.py bless");
say("     闸只放行你接受过的代码;以后每次 git pull 都要再接受一次 —— 面板横幅上有「更新到新代码」一键。");
say();
say(created.length
  ? "然后跟着面板顶部的上手引导走 —— 每一步都是实测的,做到哪一步就亮到哪一步。"
  : "配置都在。直接 bless、起板。");
say("改线 / 改收文件目录:编辑 fleet.config.json,或者让你的 Claude 改(docs/OPERATE_WITH_CLAUDE.md)。");
say("玩脏了想重来:npm run reset -- --yes(只清 .data/,不碰配置和仓库)。");
