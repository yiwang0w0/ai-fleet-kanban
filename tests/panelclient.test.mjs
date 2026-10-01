import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
const source=readFileSync(new URL('../core/panel-auth.js',import.meta.url),'utf8');
const KEY='ai-fleet-board-pairing-v1',TOKEN='synthetic-browser-pairing-credential';
async function until(fn){for(let i=0;i<200;i++){if(fn())return;await delay(5);}assert.fail('Client condition not observed');}
function client({saved='',handler=null}={}){
 const elements=new Map(),calls=[],stored=new Map(saved?[[KEY,saved]]:[]);let reloads=0;
 for(const id of ['board-pair-form','board-pair-token','board-pair-note','board-pair','board-shell','board-logout']){const e=new EventTarget();e.value='';e.textContent='';e.hidden=id==='board-shell';e.button={disabled:false};e.querySelector=()=>e.button;elements.set(id,e);}
 const raw=async(url,options)=>{const call={url:new URL(url,'http://127.0.0.1:43123/'),options};calls.push(call);if(handler)return handler(call);
  const token=new Headers(options.headers).get('X-Board-Token');return Response.json(token===TOKEN?{role:'operator'}:{error:'unauthorized'},{status:token===TOKEN?200:token==='worker-only'?403:401});};
 const location={href:'http://127.0.0.1:43123/',origin:'http://127.0.0.1:43123',reload(){reloads++;}},window={fetch:raw,addEventListener(){}};
 vm.runInNewContext(source,{window,location,document:{getElementById:id=>elements.get(id)},sessionStorage:{getItem:k=>stored.get(k),setItem:(k,v)=>stored.set(k,v),removeItem:k=>stored.delete(k)},URL,Headers,AbortSignal,AbortController,EventTarget,Event,MessageEvent,TextDecoder,setTimeout:(fn,ms)=>setTimeout(fn,Math.min(ms,10))});
 const submit=value=>{elements.get('board-pair-token').value=value;elements.get('board-pair-form').dispatchEvent(new Event('submit',{cancelable:true}));};
 return {window,elements,calls,stored,submit,reloads:()=>reloads};
}
test('pairing waits for explicit operator proof, keeps the token out of HTML globals and signs subsequent reads',async()=>{
 const f=client();assert.equal(f.calls.length,0);assert.equal(f.elements.get('board-shell').hidden,true);
 f.submit('worker-only');await until(()=>!f.elements.get('board-pair-form').button.disabled);assert.equal(f.stored.size,0);assert.match(f.elements.get('board-pair-note').textContent,/操作员/);
 f.submit(TOKEN);await f.window.boardSession.ready;assert.equal(f.elements.get('board-shell').hidden,false);assert.equal(f.elements.get('board-pair').hidden,true);assert.equal(f.elements.get('board-pair-token').value,'');assert.equal(f.stored.get(KEY),TOKEN);assert.equal(f.window.__BOARD_TOKEN,undefined);
 await f.window.boardSession.fetch('/api/tasks');const last=f.calls.at(-1);assert.equal(new Headers(last.options.headers).get('X-Board-Token'),TOKEN);assert.equal(last.options.redirect,'error');assert.equal(last.options.credentials,'omit');assert.equal(last.url.href.includes(TOKEN),false);
 f.elements.get('board-logout').dispatchEvent(new Event('click'));assert.equal(f.stored.size,0);assert.equal(f.elements.get('board-shell').hidden,true);assert.equal(f.reloads(),1);
});
test('restored tab revalidates credentials, refuses foreign destinations before sending and clears invalid authorization',async()=>{
 let rejected=false;const f=client({saved:TOKEN,handler:({url})=>Response.json(rejected?{error:'expired'}:{role:'operator'},{status:rejected?401:200})});await f.window.boardSession.ready;
 const before=f.calls.length;await assert.rejects(()=>f.window.boardSession.fetch('https://another.example/api/tasks'));await assert.rejects(()=>f.window.boardSession.fetch('//127.0.0.1:43124/api/tasks'));assert.equal(f.calls.length,before);
 rejected=true;const response=await f.window.boardSession.fetch('/api/tasks');assert.equal(response.status,401);assert.equal(f.stored.size,0);assert.equal(f.reloads(),1);await assert.rejects(()=>f.window.boardSession.fetch('/api/tasks'));assert.equal(f.calls.length,before+1);
 const stale=client({saved:'invalid'});await until(()=>stale.stored.size===0);assert.equal(stale.elements.get('board-shell').hidden,true);assert.equal(stale.reloads(),0);
});
test('authenticated event client reconnects and decodes split Unicode/multiline/unknown events without an event allowlist',async()=>{
 let connections=0;const f=client({saved:TOKEN,handler:({url,options})=>{
  if(url.pathname==='/api/auth')return Response.json({role:'operator'});
  assert.equal(new Headers(options.headers).get('X-Board-Token'),TOKEN);connections++;
  const bytes=new TextEncoder().encode(connections===1?': keepalive\n\n':'event: future.kind\r\ndata: 第一行\r\ndata: 第二行\r\n\r\n');
  return new Response(new ReadableStream({start(c){for(const b of bytes)c.enqueue(Uint8Array.of(b));c.close();}}),{headers:{'Content-Type':'text/event-stream'}});
 }});await f.window.boardSession.ready;const stream=f.window.boardSession.events('/api/events');let data=null,opened=0,errors=0;
 stream.onopen=()=>opened++;stream.onerror=()=>errors++;stream.addEventListener('future.kind',event=>{data=event.data;stream.close();});await until(()=>data!==null);
 assert.equal(data,'第一行\n第二行');assert.equal(connections,2);assert.equal(opened,2);assert.equal(errors,1);await delay(30);assert.equal(connections,2);
});
