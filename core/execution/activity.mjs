import {performance} from "node:perf_hooks";
export const DEFAULT_PROVIDER_IDLE_MS=300000;
const count=x=>Number.isSafeInteger(x)&&x>=0;
const timestamp=x=>x===null||typeof x==="string"&&Number.isFinite(Date.parse(x))&&new Date(x).toISOString()===x;

/** Event activity is transport observation, not evidence of useful model progress. */
export function createOutputActivity({idleTimeoutMs=null,monotonic=()=>performance.now(),wall=()=>new Date().toISOString()}={}){
 let start=null,lastEvent=null,startedAt=null,lastOutputAt=null,lastEventAt=null,stdout=0,stderr=0,events=0,idleObserved=null;
 const idle=now=>start===null?0:Math.max(0,Math.floor(now-(lastEvent??start)));
 return {
  start(){if(start!==null)return;start=monotonic();startedAt=wall();},
  output(stream,bytes,eventCount=events,valid=true){
   if(stream==="stdout")stdout+=bytes;else stderr+=bytes;
   if(bytes>0)lastOutputAt=wall();
   if(valid&&eventCount>events){lastEvent=monotonic();lastEventAt=wall();}
   events=eventCount;
  },
  expired(){return start!==null&&idleTimeoutMs!==null&&idle(monotonic())>=idleTimeoutMs;},
  markIdle(){idleObserved??=idle(monotonic());},
  snapshot(){
   const now=monotonic();
   return Object.freeze({format:"ai-fleet-output-activity/v1",idle_basis:"decoded_output_events",
    started_at:startedAt,last_output_at:lastOutputAt,last_event_at:lastEventAt,
    stdout_bytes:stdout,stderr_bytes:stderr,events,elapsed_ms:start===null?0:Math.max(0,Math.floor(now-start)),
    idle_ms:idle(now),idle_timeout_ms:idleTimeoutMs,idle_timeout_observed_ms:idleObserved});
  }
 };
}
export function isOutputActivity(value){
 if(!value||typeof value!=="object"||Array.isArray(value))return false;
 const keys=["format","idle_basis","started_at","last_output_at","last_event_at","stdout_bytes","stderr_bytes","events","elapsed_ms","idle_ms","idle_timeout_ms","idle_timeout_observed_ms"];
 if(Object.keys(value).length!==keys.length||keys.some(k=>!Object.hasOwn(value,k)))return false;
 if(value.format!=="ai-fleet-output-activity/v1"||value.idle_basis!=="decoded_output_events")return false;
 for(const k of ["started_at","last_output_at","last_event_at"])if(!timestamp(value[k]))return false;
 for(const k of ["stdout_bytes","stderr_bytes","events","elapsed_ms","idle_ms"])if(!count(value[k]))return false;
 if(value.idle_ms>value.elapsed_ms)return false;
 if(value.idle_timeout_ms!==null&&(!Number.isSafeInteger(value.idle_timeout_ms)||value.idle_timeout_ms<50||value.idle_timeout_ms>86400000))return false;
 if(value.idle_timeout_observed_ms!==null&&(!count(value.idle_timeout_observed_ms)||value.idle_timeout_ms===null||value.idle_timeout_observed_ms<value.idle_timeout_ms||value.idle_timeout_observed_ms>value.elapsed_ms))return false;
 if(value.started_at===null&&(value.elapsed_ms||value.idle_ms||value.stdout_bytes||value.stderr_bytes||value.events||value.last_output_at!==null||value.last_event_at!==null))return false;
 if(value.stdout_bytes+value.stderr_bytes===0?value.last_output_at!==null:value.last_output_at===null)return false;
 if(value.last_event_at!==null&&value.events===0)return false;
 return true;
}
