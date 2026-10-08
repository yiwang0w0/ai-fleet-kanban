// board env — fleet.config.json's deployment keys (port / repo / gated_subtree, plus the
// codex seat's codex_cmd / codex_released) wired ONCE for the JS clients (doctor, seed). Same mechanism as
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
// The codex seat's two switches (written by `npm run setup -- --codex`). The server reads its
// config itself and backfills only these; the clients get them with the deployment keys.
export const SEAT_KEYS = [["codex_cmd", "BOARD_CODEX_CMD"], ["codex_released", "BOARD_CODEX_RELEASED"]];

/** Backfill unset env vars from config keys: true → "1", false/null → left unset.
 *  Returns the env names it set (a process that hands its env on can drop them). */
export function backfillEnv(cfg, keys = [...KEYS, ...SEAT_KEYS]) {
  const set = [];
  for (const [ck, ek] of keys) {
    const v = cfg?.[ck];
    if (v == null || v === false || process.env[ek]) continue;
    process.env[ek] = v === true ? "1" : String(v);
    set.push(ek);
  }
  return set;
}

/** Backfill process.env defaults from the config; returns the config object. */
export function applyConfigDefaults() {
  const cfg = loadConfig();
  backfillEnv(cfg);
  return cfg;
}

/** Node 24 is the supported floor, including SQLite transaction introspection. The server asks this BEFORE
 *  loading the store, so a newcomer reads one sentence instead of a module-resolution
 *  trace. Unparseable input answers false: this is an availability check, not a safety
 *  gate, and a gate that refuses on garbage would block a machine we cannot diagnose. */
export function nodeTooOld(version = process.version) {
  const [maj, min] = String(version).replace(/^v/, "").split(".").map(Number);
  if (!Number.isFinite(maj) || !Number.isFinite(min)) return false;
  return maj < 24;
}
