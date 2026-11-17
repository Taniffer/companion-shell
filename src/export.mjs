import { readFileSync } from 'node:fs';
import { basename,join } from 'node:path';
import { validFile } from './util.mjs';

const crcTable=Array.from({length:256},(_,n)=>{for(let i=0;i<8;i++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
function crc32(bytes){let n=0xffffffff;for(const b of bytes)n=crcTable[(n^b)&255]^(n>>>8);return(n^0xffffffff)>>>0;}
export function zip(entries){const parts=[],central=[];let offset=0;for(const [name,content]of entries){const filename=Buffer.from(name),data=Buffer.isBuffer(content)?content:Buffer.from(content),crc=crc32(data);const header=Buffer.alloc(30);header.writeUInt32LE(0x04034b50,0);header.writeUInt16LE(20,4);header.writeUInt16LE(0x800,6);header.writeUInt32LE(crc,14);header.writeUInt32LE(data.length,18);header.writeUInt32LE(data.length,22);header.writeUInt16LE(filename.length,26);parts.push(header,filename,data);const dir=Buffer.alloc(46);dir.writeUInt32LE(0x02014b50,0);dir.writeUInt16LE(20,4);dir.writeUInt16LE(20,6);dir.writeUInt16LE(0x800,8);dir.writeUInt32LE(crc,16);dir.writeUInt32LE(data.length,20);dir.writeUInt32LE(data.length,24);dir.writeUInt16LE(filename.length,28);dir.writeUInt32LE(offset,42);central.push(dir,filename);offset+=header.length+filename.length+data.length;}const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...parts,directory,end]);}
export function exportData(db,dataDir){
  const captures=db.sql.prepare('SELECT value FROM captures ORDER BY created').all().map(r=>JSON.parse(r.value)),tasks=db.sql.prepare('SELECT value FROM tasks ORDER BY updated').all().map(r=>JSON.parse(r.value)),entries=[];
  const exported=captures.map(c=>({...c,deviceId:undefined,attachments:c.attachments.map(a=>{const file=validFile(a.path,dataDir,8*1024*1024);const name=`materials/${c.id}/${basename(file.path)}`;entries.push([name,readFileSync(file.path)]);return {...a,path:name};})}));
  const artifacts=tasks.flatMap(task=>db.artifacts(task.id).map(artifact=>{
    try{const file=validFile(artifact.path,artifact.snapshot?join(dataDir,'artifacts',task.id):task.cwd);const path=`artifacts/${task.id}/${artifact.id}-${basename(artifact.name??file.name)}`;entries.push([path,readFileSync(file.path)]);return {...artifact,path};}
    catch{return {...artifact,path:undefined,unavailable:true};}
  }));
  const manifest={format:'companion-personal-data',version:2,roles:db.roles().map(({id,name,brief,status,generation,createdAt,retiredAt})=>({id,name,brief,status,generation,createdAt,retiredAt})),sessions:tasks.flatMap(t=>db.sessions(t.id)),handoffs:db.sql.prepare("SELECT value FROM kv WHERE key LIKE 'handoff:%' OR key LIKE 'retirement:%'").all().map(r=>JSON.parse(r.value)),exportedAt:new Date().toISOString(),note:'不导出本客户端登录密钥、设备令牌或电脑连接凭证。用户原文完整保留。包含已保存的可见消息，不含尚未读取的桌面历史或厂商内部状态。',captures:exported,tasks,artifacts,memories:db.get('memories',[]),skills:db.get('skills',[]),messages:tasks.flatMap(t=>db.messages(t.id,1000000))};
  entries.unshift(['companion.json',JSON.stringify(manifest,null,2)],['README.txt','个人资料包 v1\ncompanion.json 包含有范围的记忆、资料、事项和可见对话；materials 是实际附件；artifacts 是已交付的成果快照。\n不包含本客户端认证信息；用户原文不做脱敏。\n']);return zip(entries);
}
