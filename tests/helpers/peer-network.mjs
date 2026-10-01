// Test-only host configuration: choose the listening origin before issuing credentials.
// Product credential checks are never disabled or patched; no credential file is rewritten.
import {execFileSync} from 'node:child_process';
import {issueCredential as issueBoundCredential,localIdentity} from '../../core/federation/peers.mjs';
import {listenPeerServer as listenBoundPeerServer} from '../../core/federation/gateway.mjs';
const origins=new Map();
export function fixtureEndpoint(db){
 const key=localIdentity(db).node_id;if(!origins.has(key)){
  const code="import net from 'node:net';const s=net.createServer();s.on('error',()=>process.exit(1));s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close();});";
  const port=Number(execFileSync(process.execPath,['--input-type=module','-e',code],{encoding:'utf8',windowsHide:true,timeout:5000,stdio:['ignore','pipe','pipe']}));
  if(!Number.isInteger(port)||port<1||port>65535)throw Error('fixture port allocation failed');origins.set(key,'http://127.0.0.1:'+port);
 }
 return origins.get(key);
}
export function issueCredential(db,args){return issueBoundCredential(db,{serverEndpoint:fixtureEndpoint(db),...args});}
export function listenPeerServer(db,options={}){const port=Number(new URL(fixtureEndpoint(db)).port);return listenBoundPeerServer(db,{...options,port:options.port||port});}
