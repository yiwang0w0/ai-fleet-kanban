// `node cli/autostart.mjs [status|on|off|check]`：可选的 Windows 登录后后台启动。
// 复用本账户的一个任务计划程序任务，不提升权限；只有明确运行 on 才注册。
// status（默认）查看状态及上次结果；on / off 注册或移除；check 只校验、不注册。
import { autostartName, autostartTaskXML, taskScheduler } from "../core/autostart.mjs";
import { startupSID } from "../core/node-startup.mjs";

const ALREADY_EXISTS = -2147024713, NOT_FOUND = -2147024894;   // 0x800700B7, 0x80070002
process.exitCode = main();

function main() {
  const action = process.argv[2] || "status";
  if (!["status", "on", "off", "check"].includes(action)) { console.error("用法: node cli/autostart.mjs [status|on|off|check]"); return 1; }
  if (process.platform !== "win32") { console.error("登录后自动启动只支持 Windows。"); return 1; }
  const name = autostartName();
  let xml = "";
  if (action === "on" || action === "check") {
    try { xml = autostartTaskXML({ sid: startupSID() }); }
    catch (e) { console.error(`读不到当前用户: ${e.message}`); return 1; }
  }
  const r = taskScheduler(action, { name, xml });
  if (r.error) {
    if (action === "on" && r.hresult === ALREADY_EXISTS) { console.log(`已经是开启的(任务计划程序里的「${name}」)。`); return 0; }
    if (action === "off" && r.hresult === NOT_FOUND) { console.log("本来就没有开启。"); return 0; }
    console.error(`任务计划程序没有接受: ${r.error}`);
    return 1;
  }
  if (action === "check") { console.log("任务定义有效(只做了校验,没有注册)。开启: node cli/autostart.mjs on"); return 0; }
  if (action === "on") { console.log(`已开启:以后登录 Windows 30 秒后,看板会在后台启动(任务计划程序里的「${name}」)。关闭: node cli/autostart.mjs off`); return 0; }
  if (action === "off") { console.log("已关闭:登录后不再自动启动看板。正在运行的看板不受影响。"); return 0; }
  if (!r.registered) { console.log("登录后自动启动:未开启。开启: node cli/autostart.mjs on"); return 0; }
  if (!r.ours) { console.log(`任务计划程序里有一个同名任务「${name}」,但不是这个命令建的 —— 没有动它。`); return 1; }
  const ran = r.last_run && !r.last_run.startsWith("1899") ? `上次在 ${r.last_run.replace("T", " ")} 运行,${r.last_result === 0 ? "成功" : "退出码 0x" + (r.last_result >>> 0).toString(16)}` : "还没有运行过";
  console.log(`登录后自动启动:已开启${r.enabled ? "" : "(但任务被停用了:在任务计划程序里启用它,或者 off 再 on)"};${ran}。关闭: node cli/autostart.mjs off`);
  return 0;
}
