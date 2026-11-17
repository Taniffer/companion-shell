import { createHash, timingSafeEqual, randomBytes } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { relative,isAbsolute,basename } from 'node:path';

export const hash=value=>createHash('sha256').update(value).digest('hex');
export const token=()=>randomBytes(32).toString('base64url');
export const stableUUID=value=>{const h=hash(value);return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`;};
export function equal(a,b){const x=Buffer.from(String(a??'')),y=Buffer.from(String(b??''));return x.length===y.length&&timingSafeEqual(x,y);}
export class AppError extends Error{constructor(status,message){super(message);this.status=status;}}
export function text(value,max=20000){if(typeof value!=='string'||value.length>max)throw new AppError(400,'文字格式不正确或超过长度限制');return value.trim();}
export function within(path,base){const actual=realpathSync(path),root=realpathSync(base);const rel=relative(root,actual);if(rel==='..'||rel.startsWith('..\\')||rel.startsWith('../')||isAbsolute(rel))throw new AppError(403,'文件不在当前事项允许的目录中');return actual;}
export function validFile(path,base,max=30*1024*1024){const actual=within(path,base),s=statSync(actual);if(!s.isFile()||s.size>max)throw new AppError(400,'文件不是普通文件或超过大小限制');return {path:actual,size:s.size,name:basename(actual)};}
export function imageMime(data){if(data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return'image/png';if(data[0]===255&&data[1]===216&&data[2]===255)return'image/jpeg';if(data.subarray(0,6).toString()==='GIF87a'||data.subarray(0,6).toString()==='GIF89a')return'image/gif';if(data.subarray(0,4).toString()==='RIFF'&&data.subarray(8,12).toString()==='WEBP')return'image/webp';return null;}
export const publicError=e=>e instanceof AppError?e.message:'操作暂未完成，请查看连接状态后重试。';
export function cleanUserPrompt(value){let s=String(value??'');const marker='本次用户请求：\n';if(s.includes(marker))s=s.split(marker).slice(1).join(marker);s=s.split('\n<companion_context>')[0];return s.replace(/^\[飞书消息:[^\]]+\]\s*/,'').trim();}
export function chronologicalSnapshot(snapshot){const turns=[...(snapshot.turns??[])];if(snapshot.page?.order==='newest_first')turns.reverse();else if(turns.length>1&&turns.every(t=>Number(t.startedAt)>0))turns.sort((a,b)=>Number(a.startedAt)-Number(b.startedAt));return {...snapshot,turns,...(snapshot.page?{page:{...snapshot.page,order:'oldest_first'}}:{})};}
export function publicMessages(snapshot){const messages=[];for(const turn of chronologicalSnapshot(snapshot).turns){const started=Number(turn.startedAt)||0,createdAt=started?(started<1e12?started*1000:started):undefined;for(const item of turn.items??[]){if(item.type==='agentMessage'&&['commentary','final','final_answer',undefined].includes(item.phase)){if(item.text)messages.push({id:item.id??`${turn.id}:${messages.length}`,role:'assistant',text:item.text,phase:item.phase??'final',turnId:turn.id,createdAt});}else if(item.type==='userMessage'){const body=(item.content??[]).filter(c=>c.type==='text'||c.type==='inputText').map(c=>c.text??'').join('\n');if(body)messages.push({id:item.id??`${turn.id}:user`,role:'user',text:cleanUserPrompt(body),turnId:turn.id,createdAt,requestJobId:body.match(/^\[飞书消息:([^\]]+)\]/)?.[1]});}}}return messages;}
export function listingThreads(listing){const all=[...(listing.pinnedThreads??[]),...(listing.threads??[])];for(const section of listing.sections??[])all.push(...section.threads??[]);return [...new Map(all.filter(t=>t.kind!=='chatgpt'&&t.hostId!=='cloud').map(t=>[t.id??t.threadId,t])).values()];}
