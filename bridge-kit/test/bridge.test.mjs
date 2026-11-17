import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { Bridge } from '../src/bridge.mjs';
import { normalize,command,targetFor,matchProjects } from '../src/routing.mjs';
import { Feishu } from '../src/feishu.mjs';
import * as lark from '@larksuiteoapi/node-sdk';
const event=(id,extra={})=>({sender:{sender_type:'user',sender_id:{open_id:'owner'}},message:{message_id:id,chat_id:'chat',chat_type:'group',content:JSON.stringify({text:'@bot 测试'}),message_type:'text',mentions:[{key:'@bot',id:{open_id:'bot'}}],...extra}});
test('飞书传输有实际超时限制',()=>{
 new Feishu({appId:'test'},'test');assert.equal(lark.defaultHttpInstance.defaults.timeout,30000);
});
test('异常会话退避重试，不阻塞其他会话并在恢复后继续',async t=>{
 const {bridge,desktop,store,sent}=fixture(t);const original=desktop.call;
 store.set('scope:group:chat',{threadId:'broken'});
 let offline=true;
 desktop.call=async(n,a)=>{if(offline&&(n==='read_thread'||n==='list_threads'))throw new Error('offline');return original(n,a);};
 bridge.receive(event('bad'));bridge.receive(event('good',{chat_id:'healthy'}));
 await bridge.tick();assert.equal(store.jobs(['running'])[0].id,'good');
 let bad=store.jobs(['queued'])[0];assert.equal(bad.failures,1);
 await bridge.tick();assert.equal(store.jobs(['queued'])[0].failures,1);
 for(let i=0;i<2;i++){bad=store.jobs(['queued'])[0];bad.retryAt=0;store.save(bad);await bridge.tick();}
 assert.equal(sent.filter(s=>s.text.includes('消息已保存')).length,1);
 offline=false;bad=store.jobs(['queued'])[0];bad.retryAt=0;store.save(bad);await bridge.tick();
 assert.ok(store.jobs(['running']).some(j=>j.id==='bad'));assert.ok(sent.some(s=>s.text.includes('连接已恢复')));
});
test('空闲旧任务先取回最终正文再释放',async t=>{
 const {bridge,desktop,store,sent}=fixture(t);bridge.receive(event('a'));await bridge.tick();
 const job=store.jobs(['running'])[0];job.dispatchAt=Date.now()-61000;store.save(job);
 desktop.call=async n=>n==='list_threads'?{threads:[{id:job.threadId,status:'idle'}]}:{turns:[{id:'final-turn',status:'completed',items:[{type:'userMessage',content:[{text:job.marker}]},{type:'agentMessage',id:'answer',phase:'final',text:'最终正文'}]}]};
 await bridge.tick();assert.equal(store.jobs(['done']).length,1);assert.equal(sent.filter(s=>s.text==='最终正文').length,1);
});
test('失败回传持久化退避，不占住后续回传窗口',async t=>{
 const {bridge,store,feishu,sent}=fixture(t);const reply=feishu.reply;
 feishu.reply=async(j,text,key)=>{if(text==='bad')throw new Error('offline');return reply(j,text,key);};
 for(let i=0;i<30;i++)store.emit(`bad-${i}`,{job:{id:`bad-${i}`},text:'bad'});
 store.emit('good',{job:{id:'good'},text:'good'});
 await bridge.flush();await bridge.flush();assert.equal(sent.filter(s=>s.text==='good').length,1);
 assert.equal(store.pending().length,0);
 const row=store.db.prepare("SELECT value FROM outbox WHERE id='bad-0'").get();assert.ok(JSON.parse(row.value).retryAt>Date.now());
});
test('创建会话长期无回执会释放队列且不重复创建',async t=>{
 const {bridge,store,desktop,calls,sent}=fixture(t);bridge.receive(event('a'));
 const job=store.jobs(['queued'])[0];job.status='pendingThread';job.dispatchAt=Date.now()-600001;store.save(job);
 await bridge.tick();assert.equal(store.jobs(['uncertain']).length,1);assert.ok(!calls.some(c=>c.name==='create_thread'));assert.ok(sent.some(s=>s.text.includes('超过 10 分钟')));
});
function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),'codex-feishu-test-')), store=new Store(join(dir,'test.sqlite'));
 const calls=[],sent=[];
 const desktop={call:async(name,args)=>{calls.push({name,args});if(name==='list_projects')return {projects:[]};if(name==='create_thread')return {threadId:'desktop-1',hostId:'local'};if(name==='read_thread')return {thread:{status:{type:'idle'}},turns:[]};return {};}};
 const feishu={botId:'bot',reply:async(j,text,key)=>sent.push({text,key}),reaction:async()=> 'reaction-1',clearReaction:async()=>{},progress:async()=>{},finishProgress:async()=>{},topicContext:async()=>{throw new Error('should not read group history');}};
 const bridge=new Bridge({config:{feishu:{ownerOpenId:'owner',allowedChatIds:['chat']}},store,desktop,feishu,log:()=>{}});bridge.wake=()=>{};
 t.after(()=>{bridge.stop();store.close();rmSync(dir,{recursive:true,force:true});});
 return {dir,store,calls,sent,desktop,feishu,bridge};
}
test('私聊每人独立，群内不同成员复用，话题独立',()=>{
 const a=normalize(event('a'), 'bot'); const b=event('b');b.sender.sender_id.open_id='member';
 assert.equal(a.scope,normalize(b,'bot').scope);
 assert.notEqual(a.scope,normalize(event('c',{thread_id:'topic'}),'bot').scope);
 const p=event('d',{chat_type:'p2p'}),q=event('e',{chat_type:'p2p'});q.sender.sender_id.open_id='other';
 assert.notEqual(normalize(p,'bot').scope,normalize(q,'bot').scope);
});
test('只识别真正 @机器人，不因 @其他人 或普通引用触发',t=>{
 const {bridge,store}=fixture(t);bridge.receive(event('a',{mentions:[]}));bridge.receive(event('b',{mentions:[{key:'@bot',id:{open_id:'someone'}}]}));assert.equal(store.jobs(['queued']).length,0);
});
test('已配对用户私聊无需 @，群聊和话题仍需 @',t=>{
 const {bridge,store}=fixture(t);
 bridge.receive(event('dm',{chat_type:'p2p',mentions:[]}));
 bridge.receive(event('group',{mentions:[]}));
 bridge.receive(event('topic',{thread_id:'topic',mentions:[]}));
 bridge.receive(event('dm-topic',{chat_type:'p2p',thread_id:'topic',mentions:[]}));
 const other=event('other',{chat_type:'p2p',mentions:[]});other.sender.sender_id.open_id='other';bridge.receive(other);
 assert.deepEqual(store.jobs(['queued']).map(j=>j.id),['dm']);
});

test('去重跨数据库重开保持有效',t=>{
 const {bridge,store,dir}=fixture(t);bridge.receive(event('once'));bridge.receive(event('once'));assert.equal(store.jobs(['queued']).length,1);
 const second=new Store(join(dir,'test.sqlite'));assert.equal(second.insert(store.jobs(['queued'])[0]),false);second.close();
});
test('普通群聊不读上下文，任务通过桌面创建',async t=>{
 const {bridge,calls,store}=fixture(t);bridge.receive(event('a'));await bridge.tick();
 assert.equal(calls.filter(c=>c.name==='create_thread').length,1);assert.equal(store.get('scope:group:chat').threadId,'desktop-1');
 assert.equal(store.jobs(['running'])[0].reactionId,'reaction-1');
});
test('已有会话用 send_message_to_thread 续聊',async t=>{
 const {bridge,calls,store}=fixture(t);store.set('scope:group:chat',{threadId:'old'});bridge.receive(event('a'));await bridge.tick();
 assert.equal(calls.find(c=>c.name==='send_message_to_thread').args.threadId,'old');assert.equal(calls.some(c=>c.name==='create_thread'),false);
});
test('新开对话只替换当前 scope，旧会话不删除',async t=>{
 const {bridge,store,calls}=fixture(t);store.set('scope:group:chat',{threadId:'old'});store.set('scope:topic:chat:x',{threadId:'topic-old'});
 bridge.receive(event('a',{content:JSON.stringify({text:'@bot 新开对话'})}));await bridge.tick();
 assert.equal(store.get('scope:group:chat').threadId,'desktop-1');assert.equal(store.get('scope:topic:chat:x').threadId,'topic-old');assert.equal(calls.some(c=>c.name.includes('delete')),false);
});
test('任务投递超时不得重复执行',async t=>{
 const {bridge,desktop,store,calls}=fixture(t);const original=desktop.call;desktop.call=async(n,a)=>{if(n==='create_thread'){calls.push({name:n});throw new Error('timeout');}return original(n,a);};
 bridge.receive(event('a'));await bridge.tick();await bridge.tick();assert.equal(calls.filter(c=>c.name==='create_thread').length,1);assert.equal(store.jobs(['uncertain']).length,1);
});
test('未启用群的其他成员/其他人私聊不进入队列',t=>{
 const {bridge,store}=fixture(t);const g=event('a',{chat_id:'unauthorized'});g.sender.sender_id.open_id='other';bridge.receive(g);const e=event('b',{chat_type:'p2p'});e.sender.sender_id.open_id='other';bridge.receive(e);assert.equal(store.jobs(['queued']).length,0);
});
test('本人在未启用群和话题真实@可直接使用，不自动授权其他成员',t=>{
 const {bridge,store}=fixture(t);bridge.receive(event('g',{chat_id:'new'}));bridge.receive(event('t',{chat_id:'new',thread_id:'topic'}));bridge.receive(event('no-at',{chat_id:'new',mentions:[]}));
 assert.deepEqual(store.jobs(['queued']).map(j=>j.id),['g','t']);assert.equal(store.get('allowedChats'),null);
});
test('只有 owner 能启用群，群内其他人可使用',t=>{
 const {bridge,store}=fixture(t);const e=event('a',{chat_id:'newgroup',content:JSON.stringify({text:'@bot /启用本群'})});e.sender.sender_id.open_id='other';bridge.receive(e);assert.equal(store.get('allowedChats'),null);
 e.sender.sender_id.open_id='owner';bridge.receive(e);assert.ok(store.get('allowedChats').includes('newgroup'));
 const m=event('b',{chat_id:'newgroup'});m.sender.sender_id.open_id='other';bridge.receive(m);assert.equal(store.jobs(['queued']).length,1);
});
test('最终回复和表情清理失败可恢复，不重复投递任务',async t=>{
 const {bridge,desktop,feishu,store,sent}=fixture(t);bridge.receive(event('a'));await bridge.tick();let deletes=0;
 feishu.clearReaction=async()=>{if(++deletes===1)throw new Error('offline');};
 desktop.call=async()=>({turns:[{id:'turn',status:'completed',items:[{type:'userMessage',content:[{text:'[飞书消息:a]'}]},{type:'agentMessage',id:'final',phase:'final_answer',text:'完成'}]}]});
 await bridge.tick();assert.equal(store.jobs(['done']).length,1);assert.equal(sent.filter(x=>x.text==='完成').length,1);
});
test('项目仅来自桌面本地项目，Git 默认隔离 worktree',()=>{
 const p={projectId:'p',projectKind:'local',hostId:'local',label:'demo',isGitRepository:true};assert.equal(matchProjects('修改 demo',[p]).length,1);assert.equal(targetFor(p).environment.type,'worktree');assert.equal(targetFor(null).type,'projectless');
});
test('新开指令只匹配独立命令，不误判引用文本',()=>{assert.equal(command('不要新开对话').type,'message');assert.equal(command('新开对话 下一项任务').text,'下一项任务');});
test('桌面创建的首轮即使没有 userMessage 也能追踪完成',async t=>{
 const {bridge,desktop,store,sent}=fixture(t);bridge.receive(event('a'));await bridge.tick();
 desktop.call=async()=>({thread:{cwd:'C:/task'},turns:[{id:'desktop-turn',startedAt:Math.floor(Date.now()/1000),status:'completed',items:[{type:'functionCallOutput',name:'create_thread'},{type:'agentMessage',id:'final',phase:'final_answer',text:'桌面任务完成'}]}]});
 await bridge.tick();assert.equal(store.jobs(['done']).length,1);assert.equal(sent.filter(x=>x.text==='桌面任务完成').length,1);
});
test('话题只读取自己的话题上下文',async t=>{
 const {bridge,feishu,calls}=fixture(t);let readId;feishu.topicContext=async j=>{readId=j.topicId;return '话题资料';};
 bridge.receive(event('topic-msg',{thread_id:'omt_topic'}));await bridge.tick();assert.equal(readId,'omt_topic');assert.match(calls.find(c=>c.name==='create_thread').args.prompt,/<topic_context>/);
});
test('同范围串行，不同范围可以并行',async t=>{
 const {bridge,store,calls}=fixture(t);bridge.receive(event('a'));bridge.receive(event('b'));bridge.receive(event('c',{thread_id:'topic'}));await bridge.tick();
 assert.equal(calls.filter(c=>c.name==='create_thread').length,2);assert.equal(store.jobs(['queued']).length,1);
});

test('进度卡片失败不阻塞最终回复、完成和下一条消息，且不转发命令',async t=>{
 const {bridge,desktop,feishu,store,sent,calls}=fixture(t);
 bridge.receive(event('a'));await bridge.tick();
 let progress='';feishu.progress=async(j,text)=>{progress=text;throw new Error('HTTP 400');};
 feishu.finishProgress=async()=>{throw new Error('HTTP 400');};
 const original=desktop.call;
 desktop.call=async(n,a)=>n==='read_thread'?{thread:{status:{type:'idle'}},turns:[{id:'turn',status:'completed',items:[{type:'userMessage',content:[{text:'[飞书消息:a]'}]},{type:'commandExecution',command:'SECRET_COMMAND',output:{text:'RAW_OUTPUT'}},{type:'agentMessage',id:'p',phase:'commentary',text:'正在检查'},{type:'agentMessage',id:'final',phase:'final_answer',text:'完成'}]}]}:original(n,a);
 bridge.receive(event('b'));await bridge.tick();
 assert.equal(store.jobs(['done']).length,1);
 assert.equal(store.jobs(['running'])[0].id,'b');
 assert.equal(sent.filter(x=>x.text==='完成').length,1);
 assert.equal(progress,'正在检查');
 assert.equal(calls.filter(c=>c.name==='send_message_to_thread').length,1);
});

test('运行中追加消息直接引导，不另建任务，不重复投递',async t=>{
 const {bridge,desktop,store,calls,sent}=fixture(t);
 bridge.receive(event('a'));await bridge.tick();
 const original=desktop.call;
 desktop.call=async(n,a)=>n==='read_thread'?{thread:{status:{type:'active'}},turns:[]}:original(n,a);
 bridge.receive(event('b',{content:JSON.stringify({text:'@bot 改成24种宠物'})}));
 await bridge.tick();await bridge.tick();
 assert.equal(calls.filter(c=>c.name==='create_thread').length,1);
 const followups=calls.filter(c=>c.name==='send_message_to_thread');
 assert.equal(followups.length,1);assert.match(followups[0].args.prompt,/改成24种宠物/);
 assert.equal(store.jobs(['running']).length,1);
 assert.equal(store.jobs(['done'])[0].outcome,'steered');
 assert.ok(sent.some(s=>s.text.includes('补充到正在运行')));
});
test('新开对话形成顺序边界，后续消息不会引导旧任务',async t=>{
 const {bridge,desktop,store,calls}=fixture(t);bridge.receive(event('a'));await bridge.tick();
 const original=desktop.call;desktop.call=async(n,a)=>n==='read_thread'?{thread:{status:{type:'active'}},turns:[]}:original(n,a);
 bridge.receive(event('b',{content:JSON.stringify({text:'@bot 新开对话'})}));bridge.receive(event('c'));await bridge.tick();
 assert.equal(store.jobs(['queued']).length,2);assert.equal(calls.filter(c=>c.name==='send_message_to_thread').length,0);
});
test('引导发送超时不重复发送',async t=>{
 const {bridge,desktop,store,calls}=fixture(t);bridge.receive(event('a'));await bridge.tick();
 const original=desktop.call;desktop.call=async(n,a)=>{if(n==='read_thread')return{thread:{status:{type:'active'}},turns:[]};if(n==='send_message_to_thread'){calls.push({name:n,args:a});throw new Error('timeout');}return original(n,a);};
 bridge.receive(event('b'));await bridge.tick();await bridge.tick();
 assert.equal(store.jobs(['uncertain']).length,1);assert.equal(calls.filter(c=>c.name==='send_message_to_thread').length,1);
});

test('桌面已在运行的绑定会话也接收引导并跟踪原回合',async t=>{
 const {bridge,desktop,store,calls}=fixture(t);store.set('scope:group:chat',{threadId:'old'});
 const original=desktop.call;desktop.call=async(n,a)=>n==='read_thread'?{thread:{status:{type:'active'}},turns:[{id:'active-turn',status:'inProgress'}]}:original(n,a);
 bridge.receive(event('a'));await bridge.tick();
 assert.equal(calls.filter(c=>c.name==='send_message_to_thread').length,1);
 assert.equal(store.jobs(['running'])[0].turnId,'active-turn');
});

test('已完成但正文为空时继续取回，不能谎报已完成或要求去桌面查看',async t=>{
 const {bridge,desktop,store,sent}=fixture(t);bridge.receive(event('a'));await bridge.tick();
 desktop.call=async()=>({turns:[{id:'turn',startedAt:Math.floor(Date.now()/1000),status:'completed',items:[]}]});
 await bridge.tick();assert.equal(store.jobs(['running']).length,1);assert.ok(!sent.some(x=>x.text.includes('查看详情')));
 desktop.call=async()=>({turns:[{id:'turn',status:'completed',items:[{type:'agentMessage',id:'final-recovered',phase:'final_answer',text:'已恢复的答复'}]}]});
 await bridge.tick();assert.equal(store.jobs(['done']).length,1);assert.equal(sent.filter(x=>x.text==='已恢复的答复').length,1);
});

test('桌面端已空闲的旧 running 任务会释放队列',async t=>{
 const {bridge,desktop,store,calls,sent}=fixture(t);
 bridge.receive(event('a'));await bridge.tick();
 const running=store.jobs(['running'])[0];running.threadId='old';running.dispatchAt=Date.now()-61000;store.save(running);store.set('scope:group:chat',{threadId:'old'});
 const original=desktop.call;desktop.call=async(n,a)=>{
  if(n==='list_threads')return {threads:[{id:'old',status:'idle'}],pinnedThreads:[]};
  if(n==='read_thread')throw new Error('read failed');
  return original(n,a);
 };
 bridge.receive(event('b'));await bridge.tick();await bridge.tick();
 assert.equal(store.jobs(['done']).some(j=>j.id==='a'),true);
 assert.equal(store.jobs(['running']).some(j=>j.id==='b'),true);
 assert.equal(calls.filter(c=>c.name==='send_message_to_thread').length,1);
 assert.ok(sent.some(s=>s.text.includes('已经结束')));
});
