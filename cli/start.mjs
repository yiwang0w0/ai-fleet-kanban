#!/usr/bin/env node
// `npm start` = `node cli/start.mjs`: run the board and bring it back when it asks.
//
// Why a wrapper at all (v0.18): the panel's 「更新到新代码」/「重启看板」 needs the board to
// come back on the same port after it exits. A process cannot cleanly restart itself on
// every platform — on Windows a non-detached child dies with its parent (libuv puts it in a
// kill-on-close job), and a detached one leaves the console, so Ctrl+C stops reaching it and
// its output has to go to a file. Under this wrapper the board simply exits with code 75
// (BOARD_SUPERVISED=1 makes it pick that mode) and is started again HERE, with the same
// stdio: the log stays in this terminal and Ctrl+C keeps working. Any other exit code is
// final and is passed through. pm2 / systemd users do not need this file — the board
// detects them and exits 75 for them directly (see RESTART_MODE in core/server.mjs).
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CODE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// BOARD_SERVER_SCRIPT is a test hook (a stub that exits 75 once); production is the board.
const SCRIPT = process.env.BOARD_SERVER_SCRIPT || join(CODE_ROOT, "core", "server.mjs");
const RESTART_CODE = 75;
let child = null;
let restarts = 0;
let stopping = false;

function launch(from) {
  child = spawn(process.execPath, [...process.execArgv, SCRIPT, ...process.argv.slice(2)], {
    stdio: "inherit", windowsHide: true,
    env: { ...process.env, BOARD_SUPERVISED: "1", ...(from ? { BOARD_RESTARTED_FROM: from } : {}) },
  });
  child.on("exit", (code, signal) => {
    if (stopping) process.exit(code ?? 0);
    if (code === RESTART_CODE) {
      restarts += 1;
      console.log(`[start] 看板请求重启(第 ${restarts} 次)—— 同一条命令、同一个终端,马上回来`);
      // The port is released by the exiting process; a short pause keeps the successor from
      // racing it. Successive requests are not throttled: each one was a human's button.
      setTimeout(() => launch("supervised"), 300);
      return;
    }
    if (signal) console.log(`[start] 看板被 ${signal} 结束`);
    process.exit(code ?? 1);
  });
  child.on("error", (e) => { console.error(`[start] 起不了看板: ${e.message}`); process.exit(1); });
}

// Ctrl+C / kill on the wrapper stops the board too — the wrapper never outlives it.
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => { stopping = true; try { child?.kill(sig); } catch {} });
}
launch(null);
