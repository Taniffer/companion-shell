import {taskLabel} from './task-state.mjs';
import {snippet} from './task-context.mjs';

const day=86400000;
const dayWords={今天:0,昨天:1,前天:2};
const past=/今天|昨天|前天|本周|这周|上周|上个月|上次|之前|最近|刚才|历史|归档|那(?:个|次|份|件|项)|任务/;
const segmenter=new Intl.Segmenter('zh-CN',{granularity:'word'});
const normalize=value=>String(value??'').normalize('NFKC').toLowerCase().trim();

export function taskIntent(input){
  const value=String(input??'').trim();
  const explicit=value.match(/^\/(找任务|切换)\s+(.+)$/s);
  if(explicit)return {query:explicit[2].trim(),mode:explicit[1]==='切换'?'focus':'find'};
  const continueTask=value.match(/^(?:请)?(?:帮我)?(?:继续|接着)\s*([^，,：:\n]+)[，,：:]\s*([\s\S]+)$/);
  if(continueTask&&/^(?:这(?:个|件|项)|本次|当前(?:的)?)(?:任务|事)?$/.test(continueTask[1].trim()))return null;
  if(continueTask&&past.test(continueTask[1]))return {query:continueTask[1].trim(),goal:continueTask[2].trim(),mode:'continue'};
  const find=value.match(/^(?:请)?(?:帮我)?(?:找回|找一下|找下|找|查一下|看看)\s*(.+)$/);
  return find&&past.test(find[1])?{query:find[1].trim(),mode:'find'}:null;
}

function dateRange(query,now){
  const start=new Date(now);
  start.setHours(0,0,0,0);
  const dateWord=query.match(/今天|昨天|前天/)?.[0];
  if(dateWord){
    start.setDate(start.getDate()-dayWords[dateWord]);
    const end=new Date(start);
    end.setDate(end.getDate()+1);
    return [+start,+end];
  }
  if(/上周|本周|这周/.test(query)){
    start.setDate(start.getDate()-((start.getDay()+6)%7)-(/上周/.test(query)?7:0));
    const end=new Date(start);
    end.setDate(end.getDate()+7);
    return [+start,+end];
  }
  if(query.includes('上个月')){
    start.setDate(1);
    const end=+start;
    start.setMonth(start.getMonth()-1);
    return [+start,end];
  }
  return query.includes('最近')?[now-7*day,now+1]:null;
}

export function findTasks(db,query,{role='all',privateOnly=false,includeImported=true,limit=10,now=Date.now()}={}){
  const original=normalize(query).slice(0,300);
  if(!original)return {tasks:[],uniqueTaskId:null};
  const range=dateRange(original,now);
  const phrase=original.replace(/^(?:请)?(?:帮我)?(?:找任务|找回|找一下|找下|找|查一下|看看|继续|接着)/,'')
    .replace(/今天|昨天|前天|本周|这周|上周|上个月|上次|之前|最近|刚才|历史|归档|那(?:个|次|份|件|项)|这(?:个|次|份|件|项)|\s*的?任务\s*$|[？?。！!]/g,' ')
    .replace(/\s+/g,' ').trim();
  const words=[...new Set([...segmenter.segment(phrase)].filter(part=>part.isWordLike)
    .map(part=>part.segment).filter(word=>word.length>1||/\d/.test(word)))].slice(0,10);
  const terms=[...new Set([phrase,...words].filter(Boolean))];
  if(!terms.length&&!range)return {tasks:[],uniqueTaskId:null};
  const clauses=[],params=[];
  if(role==='all')clauses.push('t.parent_id IS NULL');
  else{clauses.push("json_extract(t.value,'$.role')=?");params.push(role);}
  if(privateOnly)clauses.push("json_extract(t.value,'$.private')=1");
  if(!includeImported)clauses.push("COALESCE(json_extract(t.value,'$.imported'),0)=0");
  if(range){
    clauses.push("(t.updated>=? AND t.updated<? OR json_extract(t.value,'$.createdAt')>=? AND json_extract(t.value,'$.createdAt')<?)");
    params.push(...range,...range);
  }
  const columns=`SELECT t.value,t.id,lower(COALESCE(json_extract(t.value,'$.title'),'')) AS title,
    lower(COALESCE(json_extract(t.value,'$.lastUserRequest'),json_extract(t.value,'$.lastRequest'),'')) AS request,
    lower(COALESCE(json_extract(t.value,'$.summary'),'')) AS summary,
    lower(COALESCE((SELECT group_concat(json_extract(a.value,'$.name'),' ') FROM artifacts a WHERE a.task_id=t.id OR a.task_id IN (SELECT id FROM tasks WHERE parent_id=t.id)),'')) AS files,
    t.updated FROM tasks t${clauses.length?' WHERE '+clauses.join(' AND '):''}`;
  const haystack="id||' '||title||' '||request||' '||summary||' '||files";
  const scoring=terms.length?`CASE WHEN title=? OR id=? OR substr(id,1,length(?))=? THEN 100
    WHEN instr(title,?)>0 THEN 40 WHEN instr(files,?)>0 THEN 35 ELSE 0 END+`+
    terms.map(()=>`CASE WHEN instr(title,?)>0 THEN 9 WHEN instr(files,?)>0 THEN 7 WHEN instr(${haystack},?)>0 THEN 3 ELSE 0 END`).join('+'):'1';
  const scores=terms.length?[phrase,phrase,phrase,phrase,phrase,phrase,...terms.flatMap(term=>[term,term,term])]:[];
  const rows=db.sql.prepare(`WITH candidates AS (${columns}), ranked AS (
    SELECT value,updated,${scoring} AS relevance FROM candidates
    ) SELECT value,relevance FROM ranked WHERE relevance>0 ORDER BY relevance DESC,updated DESC LIMIT ?`
  ).all(...params,...scores,Math.max(2,Math.min(20,limit)));
  const tasks=rows.slice(0,limit).map(({value})=>{
    const t=JSON.parse(value);
    const artifacts=[...db.artifacts(t.id),...db.children(t.id).flatMap(child=>db.artifacts(child.id))];
    const relevant=artifacts.find(a=>phrase&&normalize(a.name).includes(phrase))??artifacts.at(-1);
    return {id:t.id,title:t.title,role:t.role,updatedAt:t.updatedAt,archived:!!t.archived,label:taskLabel(t),
      summary:snippet(t.summary??t.lastRequest,180),artifact:relevant?{id:relevant.id,name:relevant.name}:null};
  });
  const decisive=rows.length===1||rows[0]?.relevance>=100&&rows[1]?.relevance<100;
  return {tasks,uniqueTaskId:decisive?tasks[0]?.id??null:null};
}
