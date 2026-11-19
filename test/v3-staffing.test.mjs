import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {ROLES} from '../src/engine.mjs';
import {RoleRegistry} from '../src/roles.mjs';
import {findTasks,taskIntent} from '../src/task-search.mjs';
import {fixture} from './helpers.mjs';

test('temporary work never adds a long-term team member, approval can assign an explicitly described first job once',async t=>{
  const f=fixture();
  t.after(()=>f.close());
  const root=f.db.putTask({id:randomUUID(),title:'整理阅读记录',private:true,status:'idle'});
  f.engine.enqueue({parentId:root.id,role:'life',goal:'一次性摘要',requestId:'short-assignment'});
  assert.equal(f.db.role('life').status,'available');
  const proposal=f.engine.roles.propose({kind:'recruit',name:'阅读协作者',brief:'整理重复出现的阅读任务',
    reason:'多件阅读整理都沿用同一结构',firstGoal:'把本次笔记整理成目录'},root.id);
  assert.equal(f.db.roles().filter(r=>r.status==='active').length,1);
  const first=f.engine.roles.decide(proposal.id,'approve');
  assert.equal(f.engine.roles.decide(proposal.id,'approve').resultRoleId,first.resultRoleId);
  assert.throws(()=>f.engine.roles.decide(proposal.id,'dismiss'),/已经作出决定/);
  const role=f.db.role(first.resultRoleId);
  assert.equal(role.status,'active');
  assert.equal(role.appId,undefined);
  await f.engine.roles.finishApprovals();
  await f.engine.roles.finishApprovals();
  assert.equal(f.db.children(root.id).filter(child=>child.role===role.id).length,1);
  assert.equal(f.engine.roles.proposal(proposal.id).firstWork,'assigned');
});

test('a confirmed retirement survives restart, lets accepted work finish and closes intake immediately',async t=>{
  const f=fixture();
  t.after(()=>f.close());
  const role=f.engine.roles.create({id:'reading',name:'阅读协作者',brief:'整理明确共享的材料'});
  const task=f.engine.enqueue({goal:'完成手上的活',role:role.id,requestId:'retirement-job'});
  const proposal=f.engine.roles.propose({kind:'retire',roleId:role.id,reason:'以后统一由助理整理'},task.id);
  const decision=f.engine.roles.decide(proposal.id,'approve');
  assert.equal(decision.status,'approved');
  assert.equal(f.db.role(role.id).status,'retiring');
  assert.throws(()=>f.engine.enqueue({goal:'不接受新的活',role:role.id,requestId:'late-job'}),/停止接单/);
  f.engine.roles=new RoleRegistry(f.engine,ROLES);
  await f.engine.roles.finishApprovals();
  assert.equal(f.db.role(role.id).status,'retiring');
  const job=f.store.jobs(['queued']).find(j=>j.companionTaskId===task.id);
  assert.ok(f.engine.roles.canFinish(job));
  f.store.save({...job,status:'done',hasFinal:true,outcome:'已完成'});
  f.db.set('memories',[{id:'historic',scope:'role',roleId:role.id,text:'限定专业范围'}]);
  await f.engine.roles.finishApprovals();
  assert.equal(f.engine.roles.proposal(proposal.id).status,'accepted');
  assert.equal(f.db.task(task.id).role,'assistant');
  assert.equal(f.db.role(role.id).status,'retired');
  assert.equal(f.db.get('memories')[0].sourceRoleId,role.id);
  assert.equal(f.db.get('memories')[0].scope,'role');
  assert.equal(f.engine.roles.decide(proposal.id,'approve').resultRoleId,role.id);
});

test('upgrade resumes a partial retirement approved by the old version without opening another decision',async t=>{
  const f=fixture();
  t.after(()=>f.close());
  const role=f.engine.roles.create({id:'legacy-role',name:'旧协作者',brief:'保留老工作'});
  const task=f.db.putTask({id:randomUUID(),role:role.id,title:'旧任务',private:true,status:'idle',archived:true});
  f.engine.roles.patch(role.id,{status:'retiring'});
  f.db.set('retirement-pending:'+role.id,{version:role.generation,startedAt:Date.now()-1000,taskIds:[task.id]});
  f.engine.roles=new RoleRegistry(f.engine,ROLES);
  assert.equal(f.engine.roles.staffingCards().filter(p=>p.status==='pending').length,0);
  await f.engine.roles.finishApprovals();
  assert.equal(f.db.role(role.id).status,'retired');
  assert.equal(f.db.task(task.id).role,'assistant');
  assert.equal(f.db.task(task.id).archived,true);
});

test('related work and scoped memory fit bounded valid JSON without leaking unrelated role or group content',t=>{
  const f=fixture();
  t.after(()=>f.close());
  const task=f.db.putTask({id:randomUUID(),private:true,title:'交代阅读整理',role:'assistant',status:'idle'});
  f.db.putTask({id:randomUUID(),private:true,title:'另一项阅读笔记',role:'assistant'});
  f.db.putTask({id:randomUUID(),private:false,title:'GROUP_SENTINEL'});
  f.db.putTask({id:randomUUID(),private:true,title:'IMPORTED_SENTINEL',imported:true});
  f.db.set('memories',[
    ...Array.from({length:20},(_,i)=>({id:'personal-'+i,scope:'personal',text:'长'.repeat(3000),updatedAt:i})),
    {id:'private',scope:'role',roleId:'quant',text:'EXPERT_CONTEXT_SENTINEL'},
    {id:'disabled',scope:'personal',text:'DISABLED_SENTINEL',enabled:false}
  ]);
  const input=f.engine.context({companionTaskId:task.id,text:'read',private:true,actorRole:'assistant'});
  const data=JSON.parse(input.split('以下 JSON 为有来源与范围的参考资料：\n').at(-1).split('\n</companion_context>')[0]);
  assert.ok(data.relatedWorkCandidates.some(t=>t.title==='另一项阅读笔记'));
  assert.equal(data.memories.length,3);
  assert.ok(data.memories.every(m=>m.text.length<=440));
  assert.doesNotMatch(input,/GROUP_SENTINEL|IMPORTED_SENTINEL|EXPERT_CONTEXT_SENTINEL|DISABLED_SENTINEL/);
});

test('task search finds an archived result by filename and excludes group tasks from personal Feishu search',t=>{
  const f=fixture();
  t.after(()=>f.close());
  const task=f.db.putTask({id:randomUUID(),private:true,title:'低换手实验',status:'delivered',archived:true,cwd:f.dataDir});
  f.db.putTask({id:randomUUID(),private:false,title:'低换手群组实验'});
  const path=join(f.dataDir,'低换手报告.html');
  writeFileSync(path,'<h1>报告</h1>');
  const artifact=f.engine.artifact(task.id,path);
  const result=findTasks(f.db,'找一下那个低换手报告.html',{privateOnly:true});
  assert.equal(result.uniqueTaskId,task.id);
  assert.equal(result.tasks[0].archived,true);
  assert.equal(result.tasks[0].artifact.id,artifact.id);
  const requested=taskIntent('继续今天那个低换手实验，加上成本假设');
  assert.equal(requested.goal,'加上成本假设');
  assert.equal(findTasks(f.db,requested.query,{privateOnly:true}).uniqueTaskId,task.id);
  assert.equal(taskIntent('帮我找广州周围的露营地'),null);
});
