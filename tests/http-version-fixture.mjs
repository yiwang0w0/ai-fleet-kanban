// Legacy behavior fixtures acquire a version before issuing a command.
// Dedicated versiontest uses raw HTTP and exercises missing and stale versions.
export async function fixtureVersion(base,token,method,path,body){
  const match=path.match(/^\/api\/tasks\/(\d+)\/(claim|resolve|autoreview|update|pin|release|reopen|archive)$/);
  if(method!=="POST" || !match || Object.hasOwn(body || {},"expected_version")) return body;
  const r=await fetch(base+"/api/tasks/"+match[1],{headers:{"X-Board-Token":token}});
  const t=await r.json().catch(()=>({}));
  return {...body,expected_version:t.task?.aggregate_version ?? 1};
}
