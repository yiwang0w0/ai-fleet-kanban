// Trusted Windows launcher: prompt stays on stdin and out of the launch manifest.
// The provider itself only accepts --prompt; its child argv is local process data.
import {spawn} from "node:child_process";
import {readFileSync,realpathSync} from "node:fs";
import {createHash} from "node:crypto";
import {pinFile} from "./supervisor.mjs";
import {zcodeArguments} from "./zcode-profile.mjs";
const fail=()=>{throw Error("ZCODE_LAUNCH_REJECTED");};
try{
 if(process.platform!=="win32"||process.argv.length!==3)fail();
 const config=JSON.parse(readFileSync(process.argv[2],"utf8"));
 if(!config||Object.keys(config).sort().join(",")!=="bundle,cwd,node,prompt_sha256"||typeof config.prompt_sha256!=="string"||!/^[a-f0-9]{64}$/.test(config.prompt_sha256)||realpathSync(process.cwd())!==config.cwd)fail();
 for(const pin of [config.node,config.bundle]){if(!pin||Object.keys(pin).sort().join(",")!=="path,sha256")fail();const actual=pinFile(pin.path);if(actual.path!==pin.path||actual.sha256!==pin.sha256)fail();}
 if(realpathSync(process.execPath)!==config.node.path)fail();
 let chunks=[],size=0;
 for await(const chunk of process.stdin){size+=chunk.length;if(size>131072)fail();chunks.push(chunk);}
 const bytes=Buffer.concat(chunks),prompt=new TextDecoder("utf-8",{fatal:true}).decode(bytes);
 if(!prompt.trim()||prompt.includes("\0")||prompt.trimStart().startsWith("/")||prompt.length>12000||createHash("sha256").update(bytes).digest("hex")!==config.prompt_sha256)fail();
 const args=zcodeArguments(config.node.path,config.bundle.path,config.cwd,prompt);
 const child=spawn(config.node.path,args,{cwd:config.cwd,env:process.env,windowsHide:true,stdio:["ignore","inherit","inherit"]});
 const code=await new Promise((resolve,reject)=>{child.once("error",reject);child.once("close",(code,signal)=>resolve(signal||!Number.isSafeInteger(code)||code<0?1:code));});process.exitCode=code;
}catch{process.stderr.write("ZCODE_LAUNCH_REJECTED\n");process.exitCode=1;}
