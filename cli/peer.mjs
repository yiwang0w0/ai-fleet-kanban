// Explicit local administration; no default deployment database and no model execution.
import { openPeerDatabase, issueCredential, revokePeer, listPeers } from "../core/federation/peers.mjs";
import { listenPeerServer } from "../core/federation/gateway.mjs";
const usage = [
  "用法: node cli/peer.mjs <command> --db <已初始化数据库绝对路径>",
  "  grant --peer <UUID> --epoch <UUID> --scopes peer:handshake,peer:health",
  "        --projects <项目ID,...> --credential-file <新文件绝对路径> [--version <旧凭据版本>]",
  "  revoke --peer <UUID> --version <当前凭据版本>",
  "  list",
  "  serve --port <端口> [--host 127.0.0.1|::1]",
  "grant 替换既有登记必须带 --version；替换会使旧凭据立即失效，也可显式重新授权已撤销节点。",
  "凭据只写新文件，不打印 token；不得把凭据文件提交到 Git。"
].join("\n");
const [command,...args] = process.argv.slice(2);
let db, serving = false;
try {
  if (!command || ["help","--help"].includes(command)) { console.log(usage); }
  else {
    const fields = {grant:["db","peer","epoch","scopes","projects","credential-file","version"],
      revoke:["db","peer","version"],list:["db"],serve:["db","port","host"]}[command];
    if (!fields) throw Error(usage);
    const opts = {};
    for (let i=0;i<args.length;i+=2) {
      const k=args[i].replace(/^--/,"");
      if (!args[i].startsWith("--") || !fields.includes(k) || Object.hasOwn(opts,k) || !args[i+1] || args[i+1].startsWith("--"))
        throw Error("参数缺失、重复或不支持\n"+usage);
      opts[k]=args[i+1];
    }
    if (!opts.db) throw Error("--db 不能为空；不会自动使用当前部署");
    const expectedVersion = opts.version === undefined ? undefined : (/^[1-9][0-9]*$/.test(opts.version) ? Number(opts.version) : NaN);
    db = openPeerDatabase(opts.db);
    let result;
    if (command === "grant") result = issueCredential(db,{peerNodeId:opts.peer,peerEpoch:opts.epoch,
      scopes:opts.scopes?.split(","),projects:opts.projects?.split(","),expectedVersion,credentialFile:opts["credential-file"]});
    if (command === "revoke") result = revokePeer(db,{peerNodeId:opts.peer,expectedVersion});
    if (command === "list") result = {peers:listPeers(db)};
    if (command === "serve") {
      if (opts.port === undefined || !/^[0-9]+$/.test(opts.port)) throw Error("serve 需要 --port <端口>");
      const server = await listenPeerServer(db,{host:opts.host || "127.0.0.1",port:Number(opts.port)});
      serving = true;
      result = {listening:server.address(),surface:"authenticated-peer-only",operator_ui:false};
      let closing = false;
      const stop=()=>{if(closing)return;closing=true;server.close(()=>{db.close();process.exitCode=0;});server.closeAllConnections();};
      process.once("SIGINT",stop);process.once("SIGTERM",stop);
    }
    if (result) console.log(JSON.stringify(result,null,2));
  }
} catch(e) { console.error((e.code ? e.code+": " : "")+e.message);process.exitCode=1; }
finally { if(db && !serving)db.close(); }
