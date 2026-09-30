import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
// Read-only connection receipt. Never requests assignment or calls a provider.
import {createBridge} from '../core/mcp/stdio.mjs';
import {loadPrincipalCredential} from '../core/mcp/credential.mjs';
const expected=['get_board_overview','list_tasks','get_task_context'];
export async function checkDesktopConnection({url,credentialFile}){
 const credential=loadPrincipalCredential(credentialFile),bridge=createBridge({url,credentialFile});
 const initialized=await bridge({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'fleet-desktop-preflight',version:'1.0.0'}}});
 if(initialized.error)throw Object.assign(Error('本机代理初始化失败'),{code:'BROKER_UNAVAILABLE'});
 await bridge({jsonrpc:'2.0',method:'notifications/initialized'});
 const listed=await bridge({jsonrpc:'2.0',id:2,method:'tools/list'});if(listed.error)throw Object.assign(Error('本机工具列表不可用'),{code:'BROKER_UNAVAILABLE'});
 const names=listed.result.tools.map(t=>t.name);if(!expected.every(n=>names.includes(n)))throw Object.assign(Error('此身份未提供全部桌面查询工具'),{code:'DESKTOP_SCOPE_REQUIRED'});
 const overview=await bridge({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'get_board_overview',arguments:{}}});if(overview.error||overview.result.isError)throw Object.assign(Error('看板总览查询失败'),{code:'BOARD_QUERY_FAILED'});
 const data=overview.result.structuredContent;
 return {format:'ai-fleet-desktop-check/v1',checked_at:new Date().toISOString(),status:'ready',node_id:credential.node_id,node_epoch:credential.node_epoch,principal_id:credential.principal_id,protocol_version:initialized.result.protocolVersion,tools:expected,available_tool_count:names.length,task_count:Number.isSafeInteger(data.total_matching)?data.total_matching:null,source_node_count:Array.isArray(data.nodes)?data.nodes.length:null,actual_desktop_client_verified:false,real_model_called:false};
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 try{const args=process.argv.slice(2),o={};for(let i=0;i<args.length;i+=2){const k=args[i].slice(2);if(!args[i].startsWith('--')||!['url','credential-file'].includes(k)||Object.hasOwn(o,k)||!args[i+1]||args[i+1].startsWith('--'))throw Error('需要 --url <回环代理根地址> --credential-file <受限凭据>');o[k]=args[i+1];}if(!o.url||!o['credential-file'])throw Error('需要 --url 与 --credential-file');console.log(JSON.stringify(await checkDesktopConnection({url:o.url,credentialFile:o['credential-file']})));}
 catch(e){console.error(JSON.stringify({status:'failed',code:e.code??'BAD_INPUT',message:e.code?'本机看板连接或权限检查未通过':'需要 --url <回环代理根地址> --credential-file <受限凭据>',real_model_called:false}));process.exitCode=1;}
}
