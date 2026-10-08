// `node cli/init.mjs` — write fleet.config.json to the repo root, once.
//
// Deliberately tiny: the DEFAULT path is `npm run setup` (or telling your AI to install —
// INSTALL.md). init exists for the person doing it by hand. It writes what setup writes
// without flags — the example config with one Claude line (core/config-setup.mjs) — and it
// never overwrites: a config you edited is yours, and "init again" must not eat it.

import { existsSync } from "node:fs";
import { CONFIG_FILE } from "../core/env.mjs";
import { buildConfig, writeNewConfig } from "../core/config-setup.mjs";

if (existsSync(CONFIG_FILE)) {
  console.log("fleet.config.json 已存在 —— 不覆盖(你的编辑就是你的配置)。");
  console.log("要重来:先自己删掉它,再跑一次 init。");
  process.exit(1);
}
writeNewConfig(CONFIG_FILE, buildConfig());
console.log(`已生成 ${CONFIG_FILE}(执行线: Claude;gitignored,不会进仓)。`);
console.log("");
console.log("接下来:");
console.log("  1. 改 repo(任务在哪个 git 仓库里执行)和 lines[](谁来干活)");
console.log("     —— 或者直接让你的 AI 改:写法见 INSTALL.md「改配置」。");
console.log("  2. node cli/doctor.mjs   # 体检");
console.log("  3. npm start               # 起板(= node cli/start.mjs,面板按「更新」时原地重起)");
