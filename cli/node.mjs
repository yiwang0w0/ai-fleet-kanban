// Local administrative identity command; never contacts peers or starts workers.
import { createRequire } from "node:module";
import { applyConfigDefaults } from "../core/env.mjs";

applyConfigDefaults();
const require = createRequire(import.meta.url);
const store = require("../core/store.js");
const [command, ...args] = process.argv.slice(2);
const usage = "用法: node cli/node.mjs init | show | rename <终端名>";
if (!["init", "show", "rename"].includes(command) ||
    (command === "rename" ? args.length !== 1 : args.length !== 0)) {
  console.error(usage);
  process.exitCode = 2;
} else {
  let db;
  try {
    // show never initializes or migrates a database.
    db = store.open(command === "show");
    const node = command === "rename" ? store.renameNode(db, args[0]) : store.localNode(db);
    console.log(JSON.stringify(node, null, 2));
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  } finally { db?.close(); }
}
