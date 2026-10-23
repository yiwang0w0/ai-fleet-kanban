// `node cli/open.mjs` (= npm run open) — open the panel already connected.
// It asks the running board for a one-time pairing code (with the operator token from the
// data directory, like every local command) and opens <board>/#pair=<code>. The page trades
// the code once for a panel credential of its own — revocable, expiring after 30 days, never
// board_token — keeps it while 「记住」 stays ticked, and removes the code from the address
// bar. The link works once, for 10 minutes.
//   --print            print the link instead of opening a browser
//   --forget-browsers  revoke every browser's panel credential (each pairs again)
import { spawn } from "node:child_process";
import { boardUp, localBoard } from "../core/local-board.mjs";

// ⭐ No process.exit() once the board has answered: on Windows, Node 24 aborts in libuv
//   (Assertion failed … src\win\async.c) when it exits that way after two requests to a board
//   that is still running — the command printed its result, then reported a crash instead of 0
//   (measured 2026-10-14, Node v24.16.0: clitest ⑧ open/stop, 4 of 4). Setting exitCode lets
//   the process end by itself, as quickly.
process.exitCode = await main();

async function main() {
  const args = new Set(process.argv.slice(2));
  const { url, token } = localBoard();
  if (!(await boardUp(url))) { console.error(`看板没有在运行(${url})—— 先 node cli/start.mjs --background`); return 1; }
  const call = async (path, body) => {
    const r = await fetch(url + path, { method: "POST", signal: AbortSignal.timeout(10000),
      headers: { "X-Board-Token": token(), "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, v: await r.json().catch(() => ({})) };
  };
  if (args.has("--forget-browsers")) {
    try {
      const { status, v } = await call("/api/pair/revoke", { all: true });
      if (status !== 200) throw new Error(v.error || `看板返回 ${status}`);
      console.log(`已撤销 ${v.revoked} 个浏览器的连接;要再用面板:node cli/open.mjs`);
      return 0;
    } catch (e) { console.error(`撤销失败: ${e.message}`); return 1; }
  }
  let code;
  try {
    const { status, v } = await call("/api/pair/code", {});
    if (status !== 201 || !/^\d{6}$/.test(String(v.code))) throw new Error(v.error || `看板返回 ${status}`);
    code = v.code;
  } catch (e) { console.error(`拿不到配对码: ${e.message}`); return 1; }
  const link = `${url}/#pair=${code}`;
  if (args.has("--print")) { console.log(link); return 0; }
  // Only a plain http(s) address reaches the opener — nothing a shell or rundll32 could read
  // as more than one argument.
  const opened = /^https?:\/\/[A-Za-z0-9.:[\]-]+\/#pair=\d{6}$/.test(link) && openBrowser(link);
  console.log(opened ? "已在浏览器里打开面板。没打开的话,复制这个地址(10 分钟内有效,只能用一次):"
                     : "复制这个地址到浏览器(10 分钟内有效,只能用一次):");
  console.log(`  ${link}`);
  console.log(`或者打开 ${url} ,在连接页填配对码 ${code}。`);
  return 0;
}

function openBrowser(target) {
  const [cmd, cmdArgs] = process.platform === "win32" ? ["rundll32.exe", ["url.dll,FileProtocolHandler", target]]
    : process.platform === "darwin" ? ["open", [target]] : ["xdg-open", [target]];
  try { spawn(cmd, cmdArgs, { detached: true, stdio: "ignore", windowsHide: true }).on("error", () => {}).unref(); return true; }
  catch { return false; }
}
