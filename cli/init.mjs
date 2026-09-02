// `node cli/init.mjs` — copy the example fleet config to the repo root, once.
//
// Deliberately tiny: the DEFAULT setup path is conversational (tell your Claude
// what your work looks like and let it write the config — docs/OPERATE_WITH_CLAUDE.md).
// init exists for the person doing it by hand. It never overwrites: a config you
// edited is yours, and "init again" must not eat it.

import { copyFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const SRC = join(ROOT, "examples", "fleet.config.json");
const DST = join(ROOT, "fleet.config.json");

if (existsSync(DST)) {
  console.log("fleet.config.json 已存在 —— 不覆盖(你的编辑就是你的配置)。");
  console.log("要重来:先自己删掉它,再跑一次 init。");
  process.exit(1);
}
copyFileSync(SRC, DST);
console.log("已生成 fleet.config.json(从 examples/ 抄来,gitignored,不会进仓)。");
console.log("");
console.log("接下来:");
console.log("  1. 改 lines[](你的活分几条线)和 handoff_targets[](要收文件的本地目录)");
console.log("     —— 或者直接让你的 Claude 改:告诉它你的工作长什么样。");
console.log("  2. node cli/doctor.mjs   # 体检(会检查 handoff 目录是否真的存在)");
console.log("  3. node core/server.mjs  # 起板");
