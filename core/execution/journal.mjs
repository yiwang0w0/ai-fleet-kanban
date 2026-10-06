import {createHmac,timingSafeEqual} from "node:crypto";
import {canonical} from "../federation/sync-store.mjs";
import {exact,fail} from "../mcp/policy.mjs";
import {processObservation} from "./receipts.mjs";

const FORMAT="ai-fleet-execution-journal/v2";
function launch(db,dispatchId){
 const row=db.prepare("SELECT launch_digest,launch_json,journal_key FROM broker_execution_records WHERE dispatch_id=?").get(dispatchId);
 if(!row?.journal_key||!/^[a-f0-9]{64}$/.test(row.journal_key))
  fail("JOURNAL_UNAUTHENTICATED","该启动没有可信的恢复回执密钥，不能导入文件回执");
 return row;
}
function signature(row,payload){return createHmac("sha256",Buffer.from(row.journal_key,"hex")).update(canonical(payload)).digest();}

/** Trusted local supervisor only; never exposed as an MCP/HTTP signing tool. */
export function executionJournal(db,{dispatchId,observation}){
 const row=launch(db,dispatchId);
 processObservation(observation,{launch:JSON.parse(row.launch_json),result:{status:observation?.status,evidence:observation?.evidence,usage:observation?.usage}});
 const payload={format:FORMAT,dispatch_id:dispatchId,launch_digest:row.launch_digest,observation};
 return {...payload,signature:signature(row,payload).toString("hex")};
}
export function verifyExecutionJournal(db,journal){
 if(journal?.format!==FORMAT||typeof journal.signature!=="string"||!/^[a-f0-9]{64}$/.test(journal.signature))
  fail("JOURNAL_UNAUTHENTICATED","执行回执缺少有效签名");
 exact(journal,["format","dispatch_id","launch_digest","observation","signature"],"execution_journal");
 const row=launch(db,journal.dispatch_id),{signature:supplied,...payload}=journal;
 if(journal.launch_digest!==row.launch_digest)fail("EXECUTION_MISMATCH","回执不属于该启动配置");
 if(!timingSafeEqual(signature(row,payload),Buffer.from(supplied,"hex")))fail("JOURNAL_UNAUTHENTICATED","执行回执签名不匹配");
 return journal.observation;
}
