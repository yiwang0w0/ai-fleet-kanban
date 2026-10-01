// Observes a local seat CLI without running a model. Historical measurements are not portable.
import {execFileSync} from "node:child_process";
import {createHash} from "node:crypto";
import {readFileSync,realpathSync,statSync} from "node:fs";
import {isAbsolute,dirname} from "node:path";
export const SEAT_CLI_MEASUREMENTS=Object.freeze([
 Object.freeze({id:"historical-claude-deny-2026-09-28",platform:"linux",version:"2.1.283",sha256:null})
]);
export function assessSeatCLI(observation,measurements=SEAT_CLI_MEASUREMENTS){
 const match=measurements.find(m=>m.platform===observation.platform&&m.version===observation.version&&typeof m.sha256==="string"&&/^[a-f0-9]{64}$/.test(m.sha256)&&m.sha256===observation.sha256);
 return match?{status:"matched",measurement_id:match.id}:{status:"unmeasured",measurement_id:null};
}
export function inspectSeatCLI(file){
 if(typeof file!=="string"||!isAbsolute(file)||process.platform==="win32"&&!/\.exe$/i.test(file))throw Error("CLI_IDENTITY_UNAVAILABLE");
 let path,bytes,version;
 try{
  path=realpathSync.native(file);const st=statSync(path);
  if(!st.isFile()||st.size>512*1024*1024)throw Error();
  bytes=readFileSync(path);
  const raw=execFileSync(path,["--version"],{cwd:dirname(path),encoding:"utf8",windowsHide:true,timeout:10000,maxBuffer:16384,stdio:["ignore","pipe","pipe"]}).trim();
  const m=/^v?(\d+\.\d+\.\d+)(?:\s+\(Claude Code\))?$/.exec(raw);if(!m)throw Error();
  version=m[1];
  const after=statSync(path);if(after.size!==st.size||after.mtimeMs!==st.mtimeMs||after.ino!==st.ino)throw Error();
 }catch{throw Error("CLI_IDENTITY_UNAVAILABLE");}
 const observation={format:"ai-fleet-seat-cli-observation/v1",platform:process.platform,path,version,sha256:createHash("sha256").update(bytes).digest("hex")};
 return {...observation,measurement:assessSeatCLI(observation)};
}
