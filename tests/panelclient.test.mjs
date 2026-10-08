import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
const source=readFileSync(new URL('../core/panel-auth.js',import.meta.url),'utf8');
const KEY='ai-fleet-board-pairing-v1',TOKEN='synthetic-browser-pairing-credential';
async function until(fn){for(let i=0;i<200;i++){if(fn())return;await delay(5);}assert.fail('Client condition not observed');}
// remember: null = a page without the 「记住」 box; true/false = the box, ticked or not.
// stored = sessionStorage, local = localStorage; hash = the address bar's fragment.
function client({saved='',savedLocal='',handler=null,remember=false,hash=''}={}){
 const elements=new Map(),calls=[],stored=new Map(saved?[[KEY,saved]]:[]),local=new Map(savedLocal?[[KEY,savedLocal]]:[]),replaced=[];let reloads=0;
 for(const id of ['board-pair-form','board-pair-token','board-pair-note','board-pair','board-shell','board-logout',...(remember===null?[]:['board-pair-remember'])]){const e=new EventTarget();e.value='';e.textContent='';e.hidden=id==='board-shell';e.checked=remember===true;e.button={disabled:false};e.querySelector=()=>e.button;elements.set(id,e);}
 const raw=async(url,options)=>{const call={url:new URL(url,'http://127.0.0.1:43123/'),options};calls.push(call);if(handler)return handler(call);
  const token=new Headers(options.headers).get('X-Board-Token');return Response.json(token===TOKEN?{role:'operator'}:{error:'unauthorized'},{status:token===TOKEN?200:token==='worker-only'?403:401});};
 const storage=map=>({getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,String(v)),removeItem:k=>map.delete(k)});
 const location={href:'http://127.0.0.1:43123/'+hash,origin:'http://127.0.0.1:43123',pathname:'/',search:'',hash,reload(){reloads++;}},window={fetch:raw,addEventListener(){}};
 vm.runInNewContext(source,{window,location,history:{replaceState:(state,title,url)=>replaced.push(url)},document:{getElementById:id=>elements.get(id)},sessionStorage:storage(stored),localStorage:storage(local),URL,URLSearchParams,Headers,AbortSignal,AbortController,EventTarget,Event,MessageEvent,TextDecoder,setTimeout:(fn,ms)=>setTimeout(fn,Math.min(ms,10))});
 const submit=value=>{elements.get('board-pair-token').value=value;elements.get('board-pair-form').dispatchEvent(new Event('submit',{cancelable:true}));};
 return {window,elements,calls,stored,local,replaced,submit,reloads:()=>reloads};
}
// A board that trades the code '123456' once for TOKEN and confirms TOKEN as the operator.
function pairingBoard(){
 let used=false;
 return ({url,options})=>{
  if(url.pathname==='/api/pair'){const {code}=JSON.parse(options.body);const okay=code==='123456'&&!used;used=used||okay;return Response.json(okay?{token:TOKEN,role:'operator'}:{error:'配对码无效或已过期 —— 在看板电脑上重新运行 npm run open'},{status:okay?200:401});}
  const token=new Headers(options.headers).get('X-Board-Token');return Response.json(token===TOKEN?{role:'operator'}:{error:'unauthorized'},{status:token===TOKEN?200:401});
 };
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
test('a one-time code in the fragment pairs once, leaves the address bar and is remembered in this browser',async()=>{
 const f=client({remember:true,hash:'#pair=123456&fleet-task=abc',handler:pairingBoard()});
 assert.deepEqual(f.replaced,['/#fleet-task=abc'],'the code leaves the address bar before anything else reads it; other fragment keys stay');
 await f.window.boardSession.ready;
 const trade=f.calls.find(c=>c.url.pathname==='/api/pair');
 assert.equal(trade.options.method,'POST');assert.equal(trade.options.credentials,'omit');assert.equal(trade.options.redirect,'error');
 assert.deepEqual(JSON.parse(trade.options.body),{code:'123456'});assert.equal(trade.url.href.includes('123456'),false,'the code travels in the body, never a URL');
 assert.equal(f.elements.get('board-shell').hidden,false);assert.equal(f.local.get(KEY),TOKEN);assert.equal(f.stored.size,0);
 for(const value of [...f.local.values(),...f.stored.values()])assert.equal(value.includes('123456'),false);
 f.elements.get('board-logout').dispatchEvent(new Event('click'));assert.equal(f.local.size+f.stored.size,0,'退出连接 forgets this browser too');
 const revoke=f.calls.find(c=>c.url.pathname==='/api/pair/revoke');
 assert.ok(revoke,'退出连接 revokes the credential on the board');assert.equal(new Headers(revoke.options.headers).get('X-Board-Token'),TOKEN);
 assert.equal(revoke.options.keepalive,true,'the reload that follows must not cancel it');assert.equal(f.reloads(),1);
});
test('a board that is restarting is retried, never a reason to forget the remembered credential',async()=>{
 let failures=0;
 const f=client({remember:true,savedLocal:TOKEN,handler:({url,options})=>{
  if(url.pathname==='/api/auth'&&failures<3){failures++;if(failures===1)throw new TypeError('fetch failed');return Response.json({error:'restarting'},{status:failures===2?503:502});}
  return pairingBoard()({url,options});
 }});
 await f.window.boardSession.ready;
 assert.equal(failures,3);assert.equal(f.local.get(KEY),TOKEN,'kept through a network error and two 5xx answers');assert.equal(f.elements.get('board-shell').hidden,false);
 const refused=client({remember:true,savedLocal:'revoked-credential',handler:pairingBoard()});await until(()=>refused.local.size===0);
 assert.match(refused.elements.get('board-pair-note').textContent,/node cli\/open\.mjs/,'a refusal (401) drops it and says how to pair again');
});
test('a tab that is not remembered leaves the browser-wide credential of another pairing alone',async()=>{
 // The browser remembers credential A (another tab, box ticked); this tab holds B (box unticked).
 const A='a'.repeat(64),B='b'.repeat(64);
 const board=({options})=>{const t=new Headers(options.headers).get('X-Board-Token');return Response.json(t===A||t===B?{role:'operator'}:{error:'unauthorized'},{status:t===A||t===B?200:401});};
 const f=client({remember:true,saved:B,savedLocal:A,handler:board});await f.window.boardSession.ready;
 assert.equal(f.elements.get('board-pair-remember').checked,false,'this tab was not remembered');
 assert.equal(f.stored.get(KEY),B);assert.equal(f.local.get(KEY),A,'reloading this tab did not undo the other tab\'s choice');
});
test('the form takes a 6-digit code; with 「记住」 unticked the token stays in this tab only',async()=>{
 const f=client({remember:false,handler:pairingBoard()});f.submit(' 123456 ');await f.window.boardSession.ready;
 assert.equal(f.stored.get(KEY),TOKEN);assert.equal(f.local.size,0);assert.equal(f.calls[0].url.pathname,'/api/pair');
 const again=client({remember:true,handler:pairingBoard()});again.submit('000000');await until(()=>!again.elements.get('board-pair-form').button.disabled);
 assert.match(again.elements.get('board-pair-note').textContent,/npm run open/);assert.equal(again.elements.get('board-shell').hidden,true);assert.equal(again.local.size,0);
});
test('a remembered token restores this browser and the box follows where it was kept; a dead code falls back to it',async()=>{
 const kept=client({remember:false,savedLocal:TOKEN,handler:pairingBoard()});await kept.window.boardSession.ready;
 assert.equal(kept.elements.get('board-pair-remember').checked,true,'kept in this browser → the box says so');assert.equal(kept.local.get(KEY),TOKEN);
 const tab=client({remember:true,saved:TOKEN,handler:pairingBoard()});await tab.window.boardSession.ready;
 assert.equal(tab.elements.get('board-pair-remember').checked,false,'kept in this tab only → the box is unticked');assert.equal(tab.stored.get(KEY),TOKEN);assert.equal(tab.local.size,0);
 const used=client({remember:true,savedLocal:TOKEN,hash:'#pair=999999',handler:pairingBoard()});await used.window.boardSession.ready;
 assert.ok(used.calls.some(c=>c.url.pathname==='/api/pair'));assert.equal(used.elements.get('board-shell').hidden,false);assert.deepEqual(used.replaced,['/']);
 const lost=client({remember:true,hash:'#pair=999999',handler:pairingBoard()});await until(()=>/npm run open/.test(lost.elements.get('board-pair-note').textContent));
 assert.equal(lost.elements.get('board-shell').hidden,true);
 const junk=client({remember:true,hash:'#pair=12ab',handler:pairingBoard()});await delay(30);
 assert.deepEqual(junk.replaced,['/']);assert.equal(junk.calls.length,0,'a malformed code is dropped, never sent');
});
