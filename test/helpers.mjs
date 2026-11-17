import { mkdirSync,mkdtempSync,rmSync } from 'node:fs';
import { dirname,join,resolve,sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Database } from '../src/db.mjs';
import { Engine } from '../src/engine.mjs';
import { Captures } from '../src/captures.mjs';
import { attachBridge } from '../src/bridge-hooks.mjs';
import { Bridge } from '../vendor/feishu-bridge/bridge.mjs';
import { Store } from '../vendor/feishu-bridge/store.mjs';
import { normalize,command } from '../vendor/feishu-bridge/routing.mjs';

export const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export class FakeDesktop{
  constructor(snapshots=new Map()){this.snapshots=snapshots;this.calls=[];this.closed=0;this.catalog=[{name:'navigate_to_codex_page',inputSchema:{properties:{threadId:{type:'string'}}}}];}
  async connect(){}
  async call(name,args={}){this.calls.push({name,args});if(name==='list_projects')return {projects:[{projectId:'project-x',label:'特定项目',hostId:'local',projectKind:'local',isGitRepository:true}]};if(name==='list_threads')return {threads:[...this.snapshots.entries()].map(([id,s])=>({id,kind:'codex',hostId:'local',title:'测试事项',status:s.thread.status.type==='active'?'active':'idle',cwd:s.thread.cwd,updatedAt:Date.now()/1000}))};if(name==='read_thread')return this.snapshots.get(args.threadId)??{thread:{status:{type:'idle'}},turns:[]};if(name==='create_thread'){const threadId=randomUUID();this.snapshots.set(threadId,{thread:{id:threadId,status:{type:'active'},cwd:root},turns:[{id:randomUUID(),status:'inProgress',startedAt:Date.now()/1000,items:[]}]});return {threadId,hostId:'local'};}if(name==='send_message_to_thread')return {threadId:args.threadId};if(name==='navigate_to_codex_page')return {ok:true};throw new Error('Unexpected call '+name);}
  close(){this.closed++;}
}
export function fixture(){
  const parent=join(root,'test','.runtime');mkdirSync(parent,{recursive:true});const dataDir=mkdtempSync(join(parent,'case-'));
  const db=new Database(join(dataDir,'companion.sqlite')),store=new Store(join(dataDir,'bridge.sqlite'));
  store.set('owner','owner');const desktop=new FakeDesktop(),readonly=new FakeDesktop(desktop.snapshots),calls=[];
  const feishu={botId:'bot',ws:{getConnectionStatus:()=>({state:'connected'})}};
  for(const name of ['reply','progress','reaction','clearReaction','finishProgress','topicContext','attachments','deliverArtifact'])feishu[name]=async(...args)=>{calls.push({name,args});return name==='attachments'?[]:name==='topicContext'?'':undefined;};
  const config={feishu:{ownerOpenId:'owner'},bridgeRoot:dataDir,maxConcurrent:2};
  const bridge=new Bridge({config,store,desktop,feishu,log:()=>{}});bridge.stopped=true;
  const engine=new Engine({db,store,bridge,desktop:readonly,config,dataDir,root,log:()=>{}});engine.captures=new Captures(db,dataDir);
  const hooks=attachBridge({engine,bridge,store,desktop,feishu,normalize,command});
  return {db,store,desktop,readonly,feishu,calls,config,bridge,engine,hooks,dataDir,close(){engine.close();bridge.stop();store.close();db.close();const actual=resolve(dataDir);if(!actual.startsWith(resolve(parent)+sep))throw new Error('Unsafe test cleanup');rmSync(actual,{recursive:true,force:true});}};
}
export function event(text,{id=randomUUID(),user='owner',chat='chat-one',privateChat=true,mentioned=true}={}){return {sender:{sender_id:{open_id:user},sender_type:'user'},message:{message_id:id,chat_id:chat,chat_type:privateChat?'p2p':'group',message_type:'text',create_time:String(Date.now()),content:JSON.stringify({text}),mentions:mentioned?[{id:{open_id:'bot'},key:'@bot',name:'bot'}]:[]}};}
export function jobById(store,id){const row=store.db.prepare('SELECT value FROM jobs WHERE id=?').get(id);return row?JSON.parse(row.value):null;}
