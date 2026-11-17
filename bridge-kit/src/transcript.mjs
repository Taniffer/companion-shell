import { readdir, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

// Only explicit assistant messages from the exact local thread/turn may be forwarded.
export function assistantItems(text, turnId) {
  const items=[]; let active;
  for(const line of text.split('\n')) {
    let row; try {row=JSON.parse(line);} catch {continue;}
    const p=row.payload??{};
    if(row.type==='event_msg' && p.type==='task_started') active=p.turn_id;
    if(row.type!=='response_item' || p.type!=='message' || p.role!=='assistant')continue;
    if((p.internal_chat_message_metadata_passthrough?.turn_id??active)!==turnId)continue;
    if(!['commentary','final','final_answer'].includes(p.phase))continue;
    const body=(p.content??[]).filter(c=>c.type==='output_text').map(c=>c.text).join('\n');
    if(body)items.push({type:'agentMessage',id:p.id??`local-${items.length}`,phase:p.phase,text:body});
  }
  return items;
}

export class TranscriptFallback {
  constructor(home){this.home=home;this.paths=new Map();this.cache=new Map();}
  async find(threadId) {
    if(!/^[0-9a-f-]{36}$/i.test(threadId)||!this.home)return;
    if(this.paths.has(threadId))return this.paths.get(threadId);
    const walk=async dir=>{
      for(const e of await readdir(dir,{withFileTypes:true})) {
        const path=join(dir,e.name);
        if(e.isDirectory()){const found=await walk(path);if(found)return found;}
        else if(e.name.endsWith(`-${threadId}.jsonl`))return path;
      }
    };
    const path=await walk(join(this.home,'sessions'));
    if(path)this.paths.set(threadId,path);return path;
  }
  async enrich(snapshot,threadId) {
    const empty=(snapshot.turns??[]).filter(t=>!(t.items??[]).some(i=>i.type==='agentMessage'));
    if(!empty.length)return snapshot;
    try {
      const path=await this.find(threadId);if(!path)return snapshot;
      const s=await stat(path);let cached=this.cache.get(threadId);
      const turnKey=empty.map(t=>t.id).join(',');
      if(!cached||cached.size!==s.size||cached.mtime!==s.mtimeMs||cached.turnKey!==turnKey){
        const wanted=new Set(empty.map(t=>t.id));const lines=[];let active,verified=false;
        for await(const line of createInterface({input:createReadStream(path,{encoding:'utf8'}),crlfDelay:Infinity})){
          let row;try{row=JSON.parse(line);}catch{continue;}
          const p=row.payload??{};
          if(row.type==='session_meta'){if(p.id!==threadId)return snapshot;verified=true;}
          if(row.type==='event_msg'&&p.type==='task_started')active=p.turn_id;
          if(row.type==='response_item'&&p.type==='message'&&p.role==='assistant'&&wanted.has(p.internal_chat_message_metadata_passthrough?.turn_id??active)){
            p.internal_chat_message_metadata_passthrough={turn_id:p.internal_chat_message_metadata_passthrough?.turn_id??active};lines.push(JSON.stringify(row));
          }
        }
        if(!verified)return snapshot;
        cached={size:s.size,mtime:s.mtimeMs,turnKey,text:lines.join('\n')};
        if(this.cache.size>=8)this.cache.delete(this.cache.keys().next().value);
        this.cache.set(threadId,cached);
      }
      for(const turn of empty)turn.items=[...(turn.items??[]),...assistantItems(cached.text,turn.id)];
    }catch{/* Temporary missing/partial transcript: preserve API snapshot. */}
    return snapshot;
  }
}
