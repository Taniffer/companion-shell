const DAY=86400000;

export function snippet(value,limit){
  return typeof value==='string'?value.trim().slice(0,limit):'';
}

export function taskMemories(db,task,actorRole,query=''){
  if(task.private!==true)return [];
  const pools={task:[],project:[],role:[],personal:[]};
  const target=text=>String(text??'').toLowerCase();
  const terms=target(query).trim().split(/\s+/).filter(Boolean).slice(0,8);
  for(const memory of db.get('memories',[])){
    if(memory.enabled===false||!Object.hasOwn(pools,memory.scope)||typeof memory.text!=='string')continue;
    const matches=!terms.length||terms.every(term=>target(memory.text).includes(term));
    if(!matches)continue;
    if(memory.scope==='task'&&(!memory.taskId||db.task(memory.taskId)?.id!==task.id))continue;
    if(memory.scope==='project'&&(!memory.projectId||memory.projectId!==task.project?.projectId))continue;
    if(memory.scope==='role'){
      if(memory.roleId!==actorRole)continue;
      if(memory.sourceRoleId&&memory.sourceRoleId!==task.handoff?.fromRole&&!terms.length)continue;
    }
    pools[memory.scope].push(memory);
  }
  return Object.values(pools).flatMap(pool=>pool.sort((a,b)=>(b.updatedAt??0)-(a.updatedAt??0)).slice(0,3))
    .map(({id,text,scope,source,sourceRoleId})=>({id,text:snippet(text,440),scope,source:snippet(source,90),sourceRoleId}));
}

export function recentWork(db,taskId){
  const rows=db.sql.prepare(`
    SELECT value FROM tasks
    WHERE parent_id IS NULL AND id<>? AND updated>=?
      AND json_extract(value,'$.private')=1
      AND COALESCE(json_extract(value,'$.imported'),0)=0
      AND COALESCE(json_extract(value,'$.archived'),0)=0
    ORDER BY updated DESC LIMIT 8
  `).all(taskId,Date.now()-28*DAY);
  return rows.map(row=>{
    const t=JSON.parse(row.value);
    return {id:t.id,title:snippet(t.title,72),role:t.role,createdAt:t.createdAt,
      request:snippet(t.lastUserRequest??t.title,130),businessState:t.businessState};
  });
}
