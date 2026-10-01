// Local operator pairing. Never obtain credentials from HTML, query strings or fragments.
(()=>{
 const key='ai-fleet-board-pairing-v1',form=document.getElementById('board-pair-form'),input=document.getElementById('board-pair-token'),note=document.getElementById('board-pair-note'),pair=document.getElementById('board-pair'),shell=document.getElementById('board-shell');
 const nativeFetch=window.fetch.bind(window),streams=new Set();let token='',paired=false,resolveReady;
 const ready=new Promise(resolve=>resolveReady=resolve);
 function remember(value){try{if(value)sessionStorage.setItem(key,value);else sessionStorage.removeItem(key);}catch{}}
 function forget(message){token='';remember('');for(const stream of streams)stream.close();shell.hidden=true;pair.hidden=false;input.value='';note.textContent=message;if(paired)location.reload();}
 async function activate(value){
  value=value.trim();if(!value||value.length>4096)throw Error('请输入本机操作员令牌。');
  const response=await nativeFetch('/api/auth',{headers:{'X-Board-Token':value},credentials:'omit',cache:'no-store',redirect:'error',signal:AbortSignal.timeout(10000)});
  if(!response.ok)throw Error(response.status===403?'需要操作员令牌，执行或审阅令牌不能打开管理面板。':'配对失败，请核对本机操作员令牌。');
  const result=await response.json();if(result.role!=='operator')throw Error('服务未确认操作员身份。');
  token=value;remember(token);input.value='';note.textContent='';pair.hidden=true;shell.hidden=false;paired=true;resolveReady();
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
 form.addEventListener('submit',async event=>{event.preventDefault();const button=form.querySelector('button');button.disabled=true;note.textContent='正在核对…';try{await activate(input.value);}catch(e){note.textContent=e.message;}finally{button.disabled=false;}});
 document.getElementById('board-logout').addEventListener('click',()=>forget('已退出本标签页。'));
 window.addEventListener('pagehide',()=>{for(const stream of streams)stream.close();});
 window.boardSession=Object.freeze({ready,fetch:authenticatedFetch,events});
 let saved='';try{saved=sessionStorage.getItem(key)||'';}catch{}
 if(saved)activate(saved).catch(()=>{remember('');note.textContent='保存的授权暂不可用，请重新配对。';});
})();
