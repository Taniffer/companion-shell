import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export class Database {
  constructor(path) {
    mkdirSync(dirname(path),{recursive:true});
    this.sql=new DatabaseSync(path);
    this.sql.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=4000;
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY,thread_id TEXT UNIQUE,parent_id TEXT,value TEXT NOT NULL,updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS captures (id TEXT PRIMARY KEY,device_id TEXT NOT NULL,content_hash TEXT NOT NULL,value TEXT NOT NULL,created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY,task_id TEXT NOT NULL,value TEXT NOT NULL,created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY,task_id TEXT NOT NULL,path TEXT NOT NULL,value TEXT NOT NULL,UNIQUE(task_id,path));
      CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY,token_hash TEXT NOT NULL,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY,task_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS roles (id TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS task_sessions (task_id TEXT NOT NULL,role_id TEXT NOT NULL,thread_id TEXT UNIQUE,generation INTEGER NOT NULL DEFAULT 1,value TEXT NOT NULL,PRIMARY KEY(task_id,role_id));
      CREATE TABLE IF NOT EXISTS actions (id TEXT PRIMARY KEY,status TEXT NOT NULL,value TEXT NOT NULL,updated INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS tasks_updated ON tasks(updated DESC);
      CREATE INDEX IF NOT EXISTS messages_task ON messages(task_id,created);
      CREATE INDEX IF NOT EXISTS captures_created ON captures(created DESC);
    `);
  }
  get(key,fallback=null){const row=this.sql.prepare('SELECT value FROM kv WHERE key=?').get(key);return row?JSON.parse(row.value):fallback;}
  set(key,value){this.sql.prepare('INSERT INTO kv VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(value));return value;}
  task(id){for(let depth=0;depth<8;depth++){const next=this.get(`task-alias:${id}`);if(!next)break;id=next;}const row=this.sql.prepare('SELECT value FROM tasks WHERE id=?').get(id);return row?JSON.parse(row.value):null;}
  byThread(id){const row=this.sql.prepare('SELECT value FROM tasks WHERE thread_id=?').get(id)??this.sql.prepare('SELECT t.value FROM tasks t JOIN task_sessions s ON s.task_id=t.id WHERE s.thread_id=?').get(id);return row?JSON.parse(row.value):null;}
  session(taskId,roleId){const row=this.sql.prepare('SELECT value FROM task_sessions WHERE task_id=? AND role_id=?').get(taskId,roleId);return row?JSON.parse(row.value):null;}
  sessions(taskId){return this.sql.prepare('SELECT value FROM task_sessions WHERE task_id=?').all(taskId).map(r=>JSON.parse(r.value));}
  putSession(value){value={...this.session(value.taskId,value.roleId),...Object.fromEntries(Object.entries(value).filter(([,v])=>v!==undefined))};this.sql.prepare('INSERT INTO task_sessions VALUES(?,?,?,?,?) ON CONFLICT(task_id,role_id) DO UPDATE SET thread_id=excluded.thread_id,generation=excluded.generation,value=excluded.value').run(value.taskId,value.roleId,value.threadId??null,value.generation??1,JSON.stringify(value));return value;}
  role(id){const row=this.sql.prepare('SELECT value FROM roles WHERE id=?').get(id);return row?JSON.parse(row.value):null;}
  roles(){return this.sql.prepare('SELECT value FROM roles ORDER BY rowid').all().map(r=>JSON.parse(r.value));}
  putRole(value){this.sql.prepare('INSERT INTO roles VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(value.id,JSON.stringify(value));return value;}
  action(id){const row=this.sql.prepare('SELECT value FROM actions WHERE id=?').get(id);return row?JSON.parse(row.value):null;}
  putAction(value){value={...value,updatedAt:Date.now()};this.sql.prepare('INSERT INTO actions VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,value=excluded.value,updated=excluded.updated').run(value.id,value.status,JSON.stringify(value),value.updatedAt);return value;}
  actions(statuses=['pending']){return this.sql.prepare('SELECT value FROM actions WHERE status IN ('+statuses.map(()=>'?').join(',')+') ORDER BY updated').all(...statuses).map(r=>JSON.parse(r.value));}
  taskQuery({query='',role,bucket,archived=false,includeImported=true,conversations=false}={}){
    const bucketSql=`CASE WHEN json_extract(t.value,'$.businessState')='completed' THEN 'completed' WHEN json_extract(t.value,'$.businessState')='waiting_user' THEN 'unfinished' WHEN json_extract(t.value,'$.status') IN ('running','starting','syncing') THEN 'running' WHEN json_extract(t.value,'$.status')='waiting' AND EXISTS(SELECT 1 FROM tasks c WHERE c.parent_id=t.id AND json_extract(c.value,'$.status') IN ('running','starting','syncing')) THEN 'running' ELSE 'unfinished' END`;
    const clauses=["COALESCE(json_extract(t.value,'$.archived'),0)=?"],args=[archived?1:0];
    if(!includeImported)clauses.push("COALESCE(json_extract(t.value,'$.imported'),0)=0");
    if(conversations)clauses.push('t.thread_id IS NOT NULL');
    if(query){clauses.push("instr(lower(COALESCE(json_extract(t.value,'$.title'),'')||' '||COALESCE(json_extract(t.value,'$.summary'),'')),lower(?))>0");args.push(query);}
    if(role&&role!=='all'){clauses.push("json_extract(t.value,'$.role')=?");args.push(role);}
    if(bucket){clauses.push(`(${bucketSql})=?`);args.push(bucket);}
    return {where:clauses.join(' AND '),args,bucketSql};
  }
  boardCounts(options={}){const {where,args,bucketSql}=this.taskQuery({...options,bucket:null});const counts={running:0,unfinished:0,completed:0,total:0};for(const row of this.sql.prepare(`SELECT ${bucketSql} AS bucket,count(*) AS n FROM tasks t WHERE ${where} GROUP BY bucket`).all(...args)){counts[row.bucket]=row.n;counts.total+=row.n;}return counts;}
  boardTasks(options={}){const {where,args}=this.taskQuery(options),offset=Math.max(0,Number(options.offset)||0),limit=Math.min(1000,Math.max(1,Number(options.limit)||20));const total=this.sql.prepare('SELECT count(*) AS n FROM tasks t WHERE '+where).get(...args).n;const tasks=this.sql.prepare('SELECT t.value FROM tasks t WHERE '+where+' ORDER BY t.updated DESC LIMIT ? OFFSET ?').all(...args,limit,offset).map(r=>JSON.parse(r.value));return {tasks,total,nextOffset:offset+tasks.length,hasMore:offset+tasks.length<total};}
  resolveTask(id){const exact=this.task(id)??this.byThread(id);if(exact)return exact;const matches=this.tasks(500).filter(t=>t.id.startsWith(id));return matches.length===1?matches[0]:null;}
  tasks(limit=100){return this.sql.prepare('SELECT value FROM tasks ORDER BY updated DESC LIMIT ?').all(Math.min(500,limit)).map(r=>JSON.parse(r.value));}
  tasksForRole(roleId){return this.sql.prepare("SELECT value FROM tasks WHERE json_extract(value,'$.role')=? ORDER BY updated DESC").all(roleId).map(r=>JSON.parse(r.value));}
  listTasks({query='',offset=0,limit=60,archived=false,conversations=false}={}){const clauses=["COALESCE(json_extract(value,'$.archived'),0)=?"],args=[archived?1:0];if(conversations)clauses.push('thread_id IS NOT NULL');if(query){clauses.push("instr(lower(COALESCE(json_extract(value,'$.title'),'')||' '||COALESCE(json_extract(value,'$.summary'),'')),lower(?))>0");args.push(query);}const where=clauses.join(' AND '),total=this.sql.prepare('SELECT count(*) AS n FROM tasks WHERE '+where).get(...args).n;const tasks=this.sql.prepare('SELECT value FROM tasks WHERE '+where+' ORDER BY updated DESC LIMIT ? OFFSET ?').all(...args,Math.min(200,Math.max(1,limit)),Math.max(0,offset)).map(r=>JSON.parse(r.value));return {tasks,total,nextOffset:offset+tasks.length,hasMore:offset+tasks.length<total};}
  putTask(task,{touch=true}={}){
    task={role:'assistant',businessState:'open',actionVersion:1,ownerGeneration:1,...task,updatedAt:touch?Date.now():(task.updatedAt??Date.now())};
    const duplicate=task.threadId?this.byThread(task.threadId):null;
    if(duplicate&&duplicate.id!==task.id){
      const winner=duplicate.imported&&!task.imported?task:duplicate;
      const loser=winner.id===task.id?duplicate:task;
      this.transaction(()=>{
        for(const message of this.messages(loser.id,1000000)){this.sql.prepare('UPDATE messages SET task_id=?,value=? WHERE id=?').run(winner.id,JSON.stringify({...message,taskId:winner.id}),message.id);}
        for(const artifact of this.artifacts(loser.id)){this.sql.prepare('DELETE FROM artifacts WHERE id=?').run(artifact.id);this.addArtifact(winner.id,artifact.path,{...artifact,taskId:winner.id});}
        this.sql.prepare("UPDATE tasks SET parent_id=?,value=json_set(value,'$.parentId',?) WHERE parent_id=?").run(winner.id,winner.id,loser.id);
        this.sql.prepare('UPDATE requests SET task_id=? WHERE task_id=?').run(winner.id,loser.id);
        this.sql.prepare('DELETE FROM tasks WHERE id=?').run(loser.id);
        this.set(`task-alias:${loser.id}`,winner.id);
      });
      task={...duplicate,...task,id:winner.id,imported:winner.imported,captureIds:[...new Set([...(duplicate.captureIds??[]),...(task.captureIds??[])])]};
    }
    this.sql.prepare('INSERT INTO tasks VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET thread_id=excluded.thread_id,parent_id=excluded.parent_id,value=excluded.value,updated=excluded.updated').run(task.id,task.threadId??null,task.parentId??null,JSON.stringify(task),task.updatedAt);
    return task;
  }
  patchTask(id,patch,options){const prior=this.task(id);if(!prior)throw new Error('找不到这件事');return this.putTask({...prior,...patch},options);}
  capture(id){const row=this.sql.prepare('SELECT value,content_hash FROM captures WHERE id=?').get(id);return row?{...JSON.parse(row.value),contentHash:row.content_hash}:null;}
  captures(query='',limit=60){const terms=String(query).trim().split(/\s+/).filter(Boolean).slice(0,12);const condition=terms.map(()=>"instr(lower(COALESCE(json_extract(value,'$.text'),'')||' '||COALESCE(json_extract(value,'$.title'),'')||' '||COALESCE(json_extract(value,'$.url'),'')),lower(?))>0").join(' AND ');return this.sql.prepare(`SELECT value FROM captures ${condition?'WHERE '+condition:''} ORDER BY created DESC LIMIT ?`).all(...terms,Math.min(limit,200)).map(r=>JSON.parse(r.value));}
  putCapture(value,hash){return this.sql.prepare('INSERT OR IGNORE INTO captures VALUES (?,?,?,?,?)').run(value.id,value.deviceId,hash,JSON.stringify(value),value.createdAt).changes>0;}
  message(taskId,{id=randomUUID(),role='assistant',text='',channel='local',...extra}){
    const value={id,taskId,role,text,channel,createdAt:Date.now(),...extra};
    this.sql.prepare('INSERT OR IGNORE INTO messages VALUES (?,?,?,?)').run(id,taskId,JSON.stringify(value),value.createdAt);return value;
  }
  messages(taskId,limit=100){return this.sql.prepare('SELECT value FROM messages WHERE task_id=? ORDER BY created DESC,rowid DESC LIMIT ?').all(taskId,limit).reverse().map(r=>JSON.parse(r.value));}
  addArtifact(taskId,path,meta={}){const value={id:randomUUID(),taskId,path,...meta};this.sql.prepare('INSERT OR IGNORE INTO artifacts VALUES (?,?,?,?)').run(value.id,taskId,path,JSON.stringify(value));return this.artifacts(taskId).find(a=>a.path===path);}
  artifacts(taskId){return this.sql.prepare('SELECT value FROM artifacts WHERE task_id=?').all(taskId).map(r=>JSON.parse(r.value));}
  artifact(id){const r=this.sql.prepare('SELECT value FROM artifacts WHERE id=?').get(id);return r?JSON.parse(r.value):null;}
  device(id){const r=this.sql.prepare('SELECT value,token_hash FROM devices WHERE id=?').get(id);return r?{...JSON.parse(r.value),tokenHash:r.token_hash}:null;}
  devices(){return this.sql.prepare('SELECT value FROM devices').all().map(r=>JSON.parse(r.value));}
  putDevice(value,hash){this.sql.prepare('INSERT OR REPLACE INTO devices VALUES (?,?,?)').run(value.id,hash,JSON.stringify(value));}
  revokeDevice(id){this.sql.prepare('DELETE FROM devices WHERE id=?').run(id);}
  request(id){return this.sql.prepare('SELECT task_id FROM requests WHERE id=?').get(id)?.task_id;}
  saveRequest(id,taskId){this.sql.prepare('INSERT OR IGNORE INTO requests VALUES (?,?)').run(id,taskId);}
  transaction(fn){this.sql.exec('BEGIN IMMEDIATE');try{const value=fn();this.sql.exec('COMMIT');return value;}catch(error){this.sql.exec('ROLLBACK');throw error;}}
  close(){this.sql.close();}
}
