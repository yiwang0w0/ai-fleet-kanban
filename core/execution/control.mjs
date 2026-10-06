import {createRequire} from "node:module";
const guard=createRequire(import.meta.url)("../cancellation_guard.js");
/** Durable local cancellation remains effective even after peer credentials change. */
export function watchDelegationCancellation(db,taskId,{signal=null,intervalMs=250}={}){
 if(!Number.isSafeInteger(intervalMs)||intervalMs<50||intervalMs>1000)throw Error("cancellation interval must be 50-1000 ms");
 const controller=new AbortController(),check=()=>{try{if(guard.held(db,taskId))controller.abort();}catch{controller.abort();}};
 check();const timer=setInterval(check,intervalMs);timer.unref();
 return {signal:signal?AbortSignal.any([signal,controller.signal]):controller.signal,close:()=>clearInterval(timer)};
}
