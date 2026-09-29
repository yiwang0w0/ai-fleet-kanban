import {serveStdio} from "../core/mcp/stdio.mjs";
const args=process.argv.slice(2),opts={};
try{
 for(let i=0;i<args.length;i+=2){const key=args[i].slice(2);if(!args[i].startsWith("--")||!["url","credential-file"].includes(key)||Object.hasOwn(opts,key)||!args[i+1])throw Error("需要 --url 与 --credential-file");opts[key]=args[i+1];}
 if(!opts.url||!opts["credential-file"])throw Error("node cli/mcp.mjs --url <回环代理根地址> --credential-file <受限凭据>");
 await serveStdio({url:opts.url,credentialFile:opts["credential-file"]});
}catch(e){console.error(e.code??"MCP_START_FAILED",e.message);process.exitCode=1;}
