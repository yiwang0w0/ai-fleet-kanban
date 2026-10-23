// 可选的 Windows 登录后启动：本账户登录 30 秒后，从当前看板目录执行 start --background。
// 不提升权限、不创建服务；已有看板应答时启动命令不再起第二实例，任务与结果保留。
// 沿用 node-startup 的本用户登录触发、交互令牌和最小权限约束。
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { CODE_ROOT } from "./env.mjs";

export const POWERSHELL = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
/** 每个看板目录使用独立任务名，避免不同克隆互相覆盖。 */
export const autostartName = (root = CODE_ROOT) => "AiFleetBoard-" + createHash("sha256").update(root.toLowerCase()).digest("hex").slice(0, 8);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]);
const literal = (s) => "'" + String(s).replace(/'/g, "''") + "'";   // PowerShell 单引号字面量，不展开变量

/** 固定的启动任务定义；PowerShell 只负责隐藏控制台窗口。 */
export function autostartTaskXML({ sid, node = process.execPath, root = CODE_ROOT, powershell = POWERSHELL }) {
  if (!/^S-1-5-\d+(?:-\d+)+$/.test(String(sid))) throw new Error("无法识别当前用户的 SID");
  const command = "& " + literal(node) + " " + literal(join(root, "cli", "start.mjs")) + " --background";
  const args = '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -Command "' + command + '"';
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.3" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
 <RegistrationInfo><Description>ai-fleet-board-autostart/v1 node cli/start.mjs --background</Description></RegistrationInfo>
 <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${esc(sid)}</UserId><Delay>PT30S</Delay></LogonTrigger></Triggers>
 <Principals><Principal id="User"><UserId>${esc(sid)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
 <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>false</StartWhenAvailable><RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable><AllowStartOnDemand>true</AllowStartOnDemand><Enabled>true</Enabled><Hidden>false</Hidden><ExecutionTimeLimit>PT5M</ExecutionTimeLimit><Priority>7</Priority></Settings>
 <Actions Context="User"><Exec><Command>${esc(powershell)}</Command><Arguments>${esc(args)}</Arguments><WorkingDirectory>${esc(root)}</WorkingDirectory></Exec></Actions>
</Task>
`;
}

// 沿用 node-startup.ps1 的任务计划程序 COM 接口；名称和定义通过环境变量传递，不拼进脚本。
const SCRIPTS = {
  status: "try{$t=$f.GetTask($env:AIFB_TASK)}catch{$t=$null};if($null -eq $t){$r=@{registered=$false}}else{$r=@{registered=$true;enabled=[bool]$t.Enabled;last_result=[int64]$t.LastTaskResult;last_run=$t.LastRunTime.ToString('s');ours=$t.Xml.Contains('ai-fleet-board-autostart/v1')}}",
  check: "$null=$f.RegisterTask($env:AIFB_TASK,$env:AIFB_XML,1,$null,$null,3,$null);$r=@{validated=$true;registered=$false}",
  on: "$null=$f.RegisterTask($env:AIFB_TASK,$env:AIFB_XML,2,$null,$null,3,$null);$r=@{registered=$true}",
  off: "$f.DeleteTask($env:AIFB_TASK,0);$r=@{removed=$true}",
};
/** 返回操作结果；任务计划程序拒绝时返回 error 与 hresult。 */
export function taskScheduler(action, { name = autostartName(), xml = "" } = {}) {
  if (!SCRIPTS[action]) throw new Error("未知的自启动作：" + action);
  const script = "$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);"
    + "try{$s=New-Object -ComObject Schedule.Service;$s.Connect();$f=$s.GetFolder('" + "\\" + "');" + SCRIPTS[action]
    + "}catch{$r=@{error=$_.Exception.Message;hresult=$_.Exception.HResult}};$r|ConvertTo-Json -Compress";
  const p = spawnSync(POWERSHELL, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", windowsHide: true, timeout: 60000, env: { ...process.env, AIFB_TASK: name, AIFB_XML: xml } });
  const line = String(p.stdout || "").trim().split(/\r?\n/).pop() || "";
  try { return JSON.parse(line); } catch { return { error: (p.stderr || p.error?.message || "PowerShell 没有回答").trim().slice(0, 300), hresult: null }; }
}
