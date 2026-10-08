// The board on this machine, as the operator's own commands see it (`npm run start:bg`,
// `npm run open`, `npm run stop`): its address — BOARD_URL, else the configured port on
// 127.0.0.1 — and the operator token in its data directory, read the way cli/board.py
// reads it. These commands run where the board runs; none of them sends the token anywhere
// but that address.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CODE_ROOT, loadConfig } from "./env.mjs";

// Reads the config without backfilling process.env: `start:bg` hands its env to the board,
// and a backfilled BOARD_PORT would outrank a port edited in the config later.
export function localBoard() {
  const port = Number(process.env.BOARD_PORT || loadConfig().port || 47824);
  const url = String(process.env.BOARD_URL || `http://127.0.0.1:${port}`).replace(/\/+$/, "");
  const dataDir = process.env.BOARD_DATA_DIR || join(CODE_ROOT, "core", ".data");
  const tokenFile = join(dataDir, "board_token");
  return { url, port, dataDir, logFile: join(dataDir, "board.log"),
           token: () => {
             try { return readFileSync(tokenFile, "utf8").trim(); }
             catch (e) { throw new Error(`读不到操作员令牌 ${tokenFile}(${e.code || e.message})—— 数据目录不对的话,设 BOARD_DATA_DIR 指向它`); }
           } };
}

/** Is a board answering at `url`? Its /health is anonymous and says {status:"ok"}. */
export async function boardUp(url, ms = 1500) {
  try {
    const r = await fetch(url + "/health", { signal: AbortSignal.timeout(ms), cache: "no-store" });
    return r.ok && (await r.json())?.status === "ok";
  } catch { return false; }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
