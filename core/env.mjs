// board env — fleet.config.json's deployment keys (port / repo / gated_subtree)
// wired ONCE for the JS clients (doctor, seed). Same mechanism as
// core/board_env.py: read the config, backfill process.env DEFAULTS — env vars
// already set are never touched (env always wins), so every existing env read
// downstream keeps working unchanged. This replaces the choreography of setting
// the same port in the server's shell AND every client's shell — the side that
// forgot used to knock on someone else's live board at the default port
// (measured in a blind install test).
//
// A broken config warns and yields {} here — the SERVER is where a broken
// config refuses startup; a client refusing too would turn one bad file into
// "even doctor cannot run".
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const CODE_ROOT = resolve(__dirname, "..");
export const CONFIG_FILE = process.env.BOARD_CONFIG || join(CODE_ROOT, "fleet.config.json");

export function loadConfig() {
  if (!existsSync(CONFIG_FILE)) return {};
  try { return JSON.parse(readFileSync(CONFIG_FILE, "utf8")); }
  catch (e) {
    console.error(`⚠ ${CONFIG_FILE} 读不了(${e.message})—— 忽略配置,按环境变量继续`);
    return {};
  }
}

const KEYS = [["port", "BOARD_PORT"], ["repo", "BOARD_REPO"], ["gated_subtree", "BOARD_GATED_SUBTREE"]];

/** Backfill process.env defaults from the config; returns the config object. */
export function applyConfigDefaults() {
  const cfg = loadConfig();
  for (const [ck, ek] of KEYS)
    if (cfg[ck] != null && !process.env[ek]) process.env[ek] = String(cfg[ck]);
  return cfg;
}
