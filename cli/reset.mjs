// `node cli/reset.mjs [--yes]` (= `npm run reset -- --yes`) — wipe THIS board's runtime
// state and start over. A newcomer who has made a mess needs a way back; without one
// the mess is kept out of fear, and the next demo runs on top of it.
//
// What goes: everything inside the data dir — board.db (+wal/shm), the three tokens,
// evidence/, usage_ledger.jsonl, worker_settings.json, pool state, accepted_rev.
// What never goes: the repo, fleet.config.json, verify_registry.json, anything outside
// the data dir (a BOARD_DB pointed elsewhere is named, not deleted).
//
// Fail-closed on every axis: without --yes it only lists (exit 2); it refuses while
// something answers on the board's port — the running server owns those files, stop
// it first; and it refuses a data dir that resolves to a filesystem root or a home
// directory, because BOARD_DATA_DIR is an env var and env vars get typo'd.
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve, parse } from "node:path";
import { homedir } from "node:os";
import { connect } from "node:net";
import { CODE_ROOT, applyConfigDefaults } from "../core/env.mjs";

applyConfigDefaults();
const yes = process.argv.includes("--yes");
// Same default store.js uses: BOARD_DATA_DIR || core/.data
const DATA = resolve(process.env.BOARD_DATA_DIR || join(CODE_ROOT, "core", ".data"));
const PORT = Number(process.env.BOARD_PORT || 47824);
const DB = process.env.BOARD_DB ? resolve(process.env.BOARD_DB) : null;

const segs = DATA.split(/[\\/]+/).filter(Boolean);
if (parse(DATA).root === DATA || DATA === resolve(homedir()) || segs.length < 2) {
  console.error(`拒绝:数据目录解析到 ${DATA} —— 这不像一个看板的数据目录(BOARD_DATA_DIR 设错了?)`);
  process.exit(1);
}

const listening = await new Promise((res) => {
  const s = connect({ host: "127.0.0.1", port: PORT });
  s.once("connect", () => { s.destroy(); res(true); });
  s.once("error", () => res(false));
  s.setTimeout(1500, () => { s.destroy(); res(false); });
});
if (listening) {
  console.error(`拒绝:127.0.0.1:${PORT} 上有东西在应答 —— 板还在跑,它持有这些文件。先停板(Ctrl+C)再 reset。`);
  process.exit(1);
}

const entries = existsSync(DATA) ? readdirSync(DATA) : [];
console.log(`数据目录: ${DATA}`);
if (!entries.length) { console.log("已经是空的 —— 没有可删的。"); process.exit(0); }
for (const e of entries) console.log(`  ${statSync(join(DATA, e)).isDirectory() ? "[dir] " : "      "}${e}`);
if (DB && !DB.toLowerCase().startsWith(DATA.toLowerCase()))
  console.log(`未触碰: BOARD_DB=${DB}(不在数据目录内;要删请手动)`);
if (!yes) {
  console.log("");
  console.log("只列不删。确认无误就加 --yes:  node cli/reset.mjs --yes    (npm: npm run reset -- --yes)");
  process.exit(2);
}
for (const e of entries) rmSync(join(DATA, e), { recursive: true, force: true });
console.log("");
console.log(`已清空 ${entries.length} 项。下一次起板会重新铸令牌;accepted_rev 也没了 —— 起线前要重新 bless(python cli/board.py bless)。`);
