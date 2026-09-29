// No in-place restore, no service startup, no credential export.
import { join } from "node:path";
import { CODE_ROOT, applyConfigDefaults } from "../core/env.mjs";
import { createBackup, verifyBackup, restoreBackup } from "../core/backup.mjs";
applyConfigDefaults();
const [command, ...args] = process.argv.slice(2);
const usage = "用法: node cli/backup.mjs create <新目录> | verify <备份目录> | restore <备份目录> <新目录>";
const data = process.env.BOARD_DATA_DIR || join(CODE_ROOT, "core", ".data");
try {
  let result;
  if (command === "create" && args.length === 1)
    result = createBackup({dbPath:process.env.BOARD_DB || join(data,"board.db"),
      evidenceDir:join(data,"evidence"),destination:args[0]});
  else if (command === "verify" && args.length === 1) result = verifyBackup(args[0]);
  else if (command === "restore" && args.length === 2)
    result = restoreBackup({backupDirectory:args[0],destination:args[1]});
  else { console.error(usage); process.exitCode=2; }
  if (result) console.log(JSON.stringify(result,null,2));
} catch (e) { console.error(e.message); process.exitCode=1; }
