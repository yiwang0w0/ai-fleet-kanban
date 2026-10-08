// Local operator pairing. A credential never travels in HTML, query strings or fragments.
// A fragment may carry a one-time pairing code (`node cli/open.mjs`): this page takes it out of
// the address bar and trades it once, on its own origin, for a panel credential of its own —
// revocable and expiring, never board_token. 「记住」 keeps it in this browser (localStorage)
// instead of this tab; 退出连接 revokes it and clears both.
(()=>{
 const key='ai-fleet-board-pairing-v1',form=document.getElementById('board-pair-form'),input=document.getElementById('board-pair-token'),note=document.getElementById('board-pair-note'),pair=document.getElementById('board-pair'),shell=document.getElementById('board-shell'),keep=document.getElementById('board-pair-remember');
 const nativeFetch=window.fetch.bind(window),streams=new Set();let token='',paired=false,resolveReady;
 const ready=new Promise(resolve=>resolveReady=resolve);
 const stores=()=>{const out=[];try{out.push(sessionStorage);}catch{}try{out.push(localStorage);}catch{}return out;};
 // Ticked: this browser keeps it (and no tab copy). Unticked: this tab keeps it, and a copy in
 // this browser goes only if it is this same credential — another tab's choice stays.
 function remember(value){
  let session=null,local=null;try{session=sessionStorage;}catch{}try{local=localStorage;}catch{}
  const drop=(s,only)=>{try{if(s&&(only===undefined||s.getItem(key)===only))s.removeItem(key);}catch{}};
  if(!value){drop(session);drop(local);return;}
  if(keep?.checked&&local){try{local.setItem(key,value);}catch{}drop(session);}
  else{try{session?.setItem(key,value);}catch{}drop(local,value);}
 }
 // Where a token was kept is the person's earlier 「记住」 choice: the box follows it.
 function saved(){let session=null;try{session=sessionStorage;}catch{}
  for(const s of stores()){try{const v=s.getItem(key);if(v){if(keep)keep.checked=s!==session;return v;}}catch{}}return '';}
 // 退出连接 also revokes the credential on the board (keepalive: the reload must not cancel it).
 function forget(message,revoke=false){
  if(revoke&&token)try{nativeFetch('/api/pair/revoke',{method:'POST',headers:{'X-Board-Token':token,'Content-Type':'application/json'},body:'{}',credentials:'omit',cache:'no-store',redirect:'error',keepalive:true}).catch(()=>{});}catch{}
  token='';remember('');for(const stream of streams)stream.close();shell.hidden=true;pair.hidden=false;input.value='';note.textContent=message;if(paired)location.reload();
 }
 // A refusal (401/403) is final; anything else — the board restarting, a timeout — is `transient`.
 async function activate(value){
  value=value.trim();if(!value||value.length>4096)throw Error('请输入配对码或本机操作员令牌。');
  let response;
  try{response=await nativeFetch('/api/auth',{headers:{'X-Board-Token':value},credentials:'omit',cache:'no-store',redirect:'error',signal:AbortSignal.timeout(10000)});}
  catch{throw Object.assign(Error('暂时连不上看板。'),{transient:true});}
  if(response.status===401||response.status===403)throw Error(response.status===403?'需要操作员令牌，执行或审阅令牌不能打开管理面板。':'配对失败，请核对配对码或本机操作员令牌。');
  if(!response.ok)throw Object.assign(Error('看板暂时没有应答（'+response.status+'）。'),{transient:true});
  const result=await response.json();if(result.role!=='operator')throw Error('服务未确认操作员身份。');
  token=value;remember(token);input.value='';note.textContent='';pair.hidden=true;shell.hidden=false;paired=true;resolveReady();
 }
 // A remembered credential is dropped only when the board refuses it; a board that is
 // restarting or briefly unreachable is retried (about two minutes), not forgotten.
 async function restore(value){
  for(let attempt=1;;attempt++){
   try{await activate(value);return;}
   catch(e){
    if(!e.transient){remember('');throw Error('保存的授权已失效，请重新配对：在看板电脑上运行 node cli/open.mjs。');}
    if(attempt>=40)throw Error('连不上看板。确认它在运行（node cli/start.mjs --background），再刷新这一页。');
    note.textContent='看板暂时没有应答，正在重试…';await new Promise(r=>setTimeout(r,3000));
   }
  }
 }
 // A one-time code from `node cli/open.mjs`: trade it for a panel credential, then pair with it.
 async function redeem(code){
  const response=await nativeFetch('/api/pair',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code}),credentials:'omit',cache:'no-store',redirect:'error',signal:AbortSignal.timeout(10000)});
  const result=await response.json().catch(()=>({}));
  if(!response.ok||typeof result.token!=='string')throw Error(result.error||'配对码无效或已过期。在看板电脑上重新运行 node cli/open.mjs。');
  await activate(result.token);
 }
 const connect=value=>/^\s*\d{6}\s*$/.test(value)?redeem(value.trim()):activate(value);
 /** #pair=<code>, removed from the address bar (and so from history) before anything else reads it. */
 function fragmentCode(){
  const params=new URLSearchParams(String(location.hash||'').slice(1)),code=params.get('pair');
  if(code===null)return '';
  params.delete('pair');const rest=params.toString();
  try{history.replaceState(null,'',location.pathname+location.search+(rest?'#'+rest:''));}catch{}
  return /^\d{6}$/.test(code)?code:'';
 }
 async function authenticatedFetch(path,options={}){
  const url=new URL(path,location.href);
  if(url.origin!==location.origin||!url.pathname.startsWith('/api/')||url.username||url.password)throw Error('面板仅访问本来源的看板接口。');
  if(!token)throw Error('请先配对本机看板。');
  const headers=new Headers(options.headers);headers.set('X-Board-Token',token);
  const response=await nativeFetch(url.href,{...options,headers,credentials:'omit',cache:'no-store',redirect:'error'});
  if(response.status===401)forget('授权已失效，请重新配对。');
  return response;
 }
 // The board sends bounded ephemeral change/log nudges, not replayable records.
 // Fetch streams carry the header that native EventSource cannot attach.
 function events(path){
  const stream=new EventTarget();let closed=false,controller=null;streams.add(stream);
  stream.close=()=>{closed=true;controller?.abort();streams.delete(stream);};
  function notify(type,data){const event=data===undefined?new Event(type):new MessageEvent(type,{data});stream['on'+type]?.(event);stream.dispatchEvent(event);}
  (async()=>{while(!closed&&token){
   controller=new AbortController();let reader;
   try{
    const response=await authenticatedFetch(path,{headers:{Accept:'text/event-stream'},signal:controller.signal});
    if(!response.ok||!response.headers.get('content-type')?.startsWith('text/event-stream'))throw Error('事件连接失败');
    reader=response.body.getReader();const decoder=new TextDecoder();let pending='';notify('open');
    while(!closed){const {done,value}=await reader.read();if(done)break;pending+=decoder.decode(value,{stream:true});if(pending.length>1048576)throw Error('事件帧超限');
     let boundary;while((boundary=/\r?\n\r?\n/.exec(pending))){const frame=pending.slice(0,boundary.index);pending=pending.slice(boundary.index+boundary[0].length);let type='message',data=[];
      for(const line of frame.split(/\r?\n/)){if(line.startsWith('event:'))type=line.slice(6).replace(/^ /,'');else if(line.startsWith('data:'))data.push(line.slice(5).replace(/^ /,''));}
      if(data.length)notify(type,data.join('\n'));
     }
    }
   }catch{}finally{await reader?.cancel().catch(()=>{});}
   if(!closed&&token){notify('error');await new Promise(r=>setTimeout(r,2000));}
  }})();return stream;
 }
 form.addEventListener('submit',async event=>{event.preventDefault();const button=form.querySelector('button');button.disabled=true;note.textContent='正在核对…';try{await connect(input.value);}catch(e){note.textContent=e.message;}finally{button.disabled=false;}});
 document.getElementById('board-logout').addEventListener('click',()=>forget('已退出连接，这台电脑不再记住授权。',true));
 window.addEventListener('pagehide',()=>{for(const stream of streams)stream.close();});
 window.boardSession=Object.freeze({ready,fetch:authenticatedFetch,events});
 // A fresh code wins over a remembered credential (the person just asked for this browser to
 // be paired); a code that fails falls back to the remembered one before the form is shown.
 const code=fragmentCode(),stored=saved();
 if(code){note.textContent='正在用配对码连接…';redeem(code).catch(e=>stored?restore(stored).catch(()=>{note.textContent=e.message;}):(note.textContent=e.message));}
 else if(stored)restore(stored).catch(e=>{note.textContent=e.message;});
})();
