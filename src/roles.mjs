import {randomUUID} from 'node:crypto';
import {AppError,text,hash} from './util.mjs';
import {ACTIVE_JOBS} from './task-state.mjs';

export class RoleRegistry {
  constructor(engine,defaults){this.engine=engine;this.db=engine.db;for(const [id,definition]of Object.entries(defaults))if(!this.db.role(id))this.db.putRole({id,...definition,name:id==='assistant'?'伴随秘书':definition.name.replace('伙伴','助理'),status:id==='assistant'?'active':'available',createdAt:Date.now(),generation:1});}
  get(id){return this.db.role(id);}
  list(){return this.db.roles().map(({pairing,...r})=>({...r,paired:!!r.ownerOpenId,botConnected:this.engine.feishuRuntime?.connected(r.id)??false,connectionCheck:this.engine.feishuRuntime?.checkStatus(r.id)??null}));}
  create({id,name,brief}={}){name=text(name,40);brief=text(brief,3000);if(!name||!brief)throw new AppError(400,'请说明助理名字和职责');id=id??'role-'+randomUUID().slice(0,8);if(!/^[a-z][a-z0-9-]{1,50}$/.test(id)||id==='assistant')throw new AppError(400,'角色编号无效');if(this.get(id)&&this.get(id).status!=='available'&&this.get(id).name===name&&this.get(id).brief===brief)return this.get(id);if(this.get(id)&&this.get(id).status!=='available')throw new AppError(409,'这个角色已经存在');return this.db.putRole({...this.get(id),id,name,brief,status:'active',generation:(this.get(id)?.generation??0)+1,createdAt:this.get(id)?.createdAt??Date.now()});}
  proposals(){return this.db.get('role-proposals',[]);}
  propose(input,taskId){const kind=input.kind??'recruit',reason=text(input.reason,1000),name=text(input.name,40),brief=text(input.brief,3000),roleId=input.roleId;if(!['recruit','retire'].includes(kind)||!reason||(kind==='recruit'&&(!name||!brief))||(kind==='retire'&&(!this.get(roleId)||roleId==='assistant')))throw new AppError(400,'请说明具体职责、理由或需要交接的角色');const list=this.proposals(),id='proposal-'+hash(taskId+':'+(input.requestId??hash(JSON.stringify({kind,name,brief,roleId,reason})))).slice(0,20),existing=list.find(p=>p.id===id);if(existing)return existing;if(list.filter(p=>p.status==='pending').length>=8)throw new AppError(429,'请先处理已有的助理建议');const proposal={id,kind,name,brief,roleId,reason,taskId,status:'pending',createdAt:Date.now()};this.db.set('role-proposals',[...list,proposal].slice(-100));return proposal;}
  resolveProposal(id,status){const list=this.proposals(),p=list.find(p=>p.id===id);if(!p)throw new AppError(404,'找不到这条建议');p.status=status;p.resolvedAt=Date.now();this.db.set('role-proposals',list);return p;}
  activate(id){const r=this.get(id);if(!r||['retiring','retired'].includes(r.status))throw new AppError(409,'角色已停止接单，请找秘书');if(r.status==='available')this.db.putRole({...r,status:'active'});return r;}
  patch(id,patch){const r=this.get(id);if(!r)throw new AppError(404,'找不到这个角色');return this.db.putRole({...r,...patch,updatedAt:Date.now()});}
  async verifyIdle(task){
    const sessions=this.db.sessions(task.id);if(task.threadId&&!sessions.some(s=>s.threadId===task.threadId))sessions.push({threadId:task.threadId});
    if(!sessions.length&&['running','starting','syncing','waiting'].includes(task.status))throw new AppError(409,'尚无法确认当前执行已结束，请刷新或到 Codex 核实');
    for(const session of sessions){if(!session.threadId)continue;let snapshot;try{snapshot=await this.engine.read('read_thread',{threadId:session.threadId,turnLimit:1,includeOutputs:false,maxOutputCharsPerItem:0});}catch{throw new AppError(503,'暂时无法核实原会话状态，交接尚未执行');}const last=snapshot.turns?.at(-1);if(snapshot.thread?.status?.type==='active'||last?.status==='inProgress')throw new AppError(409,'原生会话仍在执行，请等本轮结束或到 Codex 处理');if(!snapshot.thread?.status&&!last?.status)throw new AppError(503,'原会话状态不完整，暂不交接');}
  }
  async handoff(taskId,roleId,{expectedVersion,actionId}={}){
    const task=this.db.resolveTask(taskId),role=this.get(roleId);if(!task||!role)throw new AppError(404,'找不到任务或负责人');if(actionId&&task.handoff?.actionId===actionId&&task.role===roleId)return task;this.activate(roleId);
    if(expectedVersion!==undefined&&(task.actionVersion??1)!==expectedVersion)throw new AppError(409,'这张卡片已更新，请获取最新状态');
    if(this.engine.store.jobs(ACTIVE_JOBS).some(j=>this.engine.taskForJob(j)?.id===task.id))throw new AppError(409,'当前仍有工作在执行或排队，请等本轮结束，或到 Codex 处理后再交接');
    await this.verifyIdle(task);if(['retiring','retired'].includes(this.get(roleId)?.status)||this.get(roleId)?.generation!==role.generation)throw new AppError(409,'接收角色状态已变化，请重新选择负责人');if((this.db.task(task.id)?.actionVersion??1)!==(task.actionVersion??1))throw new AppError(409,'核对期间任务已经变化，请重新核对交接');if(this.engine.store.jobs(ACTIVE_JOBS).some(j=>this.engine.taskForJob(j)?.id===task.id))throw new AppError(409,'核对期间收到了新工作，请等它结束后交接');
    const priorRole=task.role,paused=this.engine.store.jobs(['paused']).filter(j=>this.engine.taskForJob(j)?.id===task.id),version=(task.actionVersion??1)+1;
    const summary={id:randomUUID(),actionId,taskId:task.id,fromRole:priorRole,toRole:roleId,at:Date.now(),taskTitle:task.title,requirements:task.lastRequest??'',summary:task.summary??'',captureIds:task.captureIds??[],artifacts:this.db.artifacts(task.id).map(a=>a.id),generation:version};
    for(const job of this.engine.store.jobs(['done','paused']))if(this.engine.taskForJob(job)?.id===task.id){job.actorRole??=priorRole;job.ownerGeneration??=task.ownerGeneration??1;if(job.status==='paused'){job.status='done';job.outcome='已取消';job.companionSuperseded=true;}this.engine.store.save(job);}
    return this.db.transaction(()=>{if(task.threadId&&!this.db.session(task.id,priorRole))this.db.putSession({taskId:task.id,roleId:priorRole,threadId:task.threadId,generation:task.ownerGeneration??1});this.db.set('capability:'+task.id,null);const session=this.db.session(task.id,roleId);this.db.set(`handoff:${task.id}:${version}`,summary);this.db.message(task.id,{role:'system',text:`任务从${this.get(priorRole)?.name??priorRole}交给${role.name}。`,handoffId:summary.id});return this.db.patchTask(task.id,{role:roleId,status:paused.length?'paused':'idle',pendingHandoffGoal:paused.length?task.lastRequest:null,threadId:session?.threadId??null,scope:session?.threadId?'thread:'+session.threadId:undefined,ownerGeneration:version,actionVersion:version,handoff:summary,businessState:task.businessState==='completed'?'completed':'open'});});
  }
  retirement(id){const r=this.get(id);if(!r||id==='assistant')throw new AppError(400,'秘书需要继续负责你的工作');const tasks=this.db.tasksForRole(id),memories=this.db.get('memories',[]).filter(m=>m.roleId===id&&m.enabled!==false),artifacts=tasks.flatMap(t=>this.db.artifacts(t.id));const active=this.engine.store.jobs(ACTIVE_JOBS).filter(j=>tasks.some(t=>this.engine.taskForJob(j)?.id===t.id));return {role:r,tasks,memories,artifacts,active:active.map(j=>({id:j.id,status:j.status,taskId:j.companionTaskId})),version:r.generation??1};}
  async retire(id,{expectedVersion}={}){
    this.retiring??=new Set();if(this.retiring.has(id))throw new AppError(409,'正在交接这位助理，请稍候');
    const plan=this.retirement(id);if(plan.role.status==='retired')return {role:plan.role,tasks:[],memoryCount:0,artifactCount:0};
    if(plan.active.length)throw new AppError(409,'仍有在途工作，请等本轮结束或到 Codex 处理；资料尚未移除');
    if(expectedVersion!==undefined&&plan.version!==expectedVersion)throw new AppError(409,'交接清单已变化，请重新核对');
    this.retiring.add(id);const result=[];
    // Seal intake synchronously before the first native-state read. Retries resume any unfinished transfer.
    this.patch(id,{status:'retiring',retirementError:null});this.engine.feishuRuntime?.cancelProvision(id);
    this.db.set('retirement-pending:'+id,{version:plan.version,taskIds:plan.tasks.map(t=>t.id),startedAt:Date.now()});
    try{
      for(const task of plan.tasks)result.push(await this.handoff(task.id,'assistant'));
      this.db.transaction(()=>{
        const items=this.db.get('memories',[]),seen=new Set(items.filter(m=>m.roleId==='assistant').map(m=>hash(m.text)));
        for(const memory of items.filter(m=>m.roleId===id)){memory.originalRoleId??=id;memory.sourceRoleId??=id;memory.roleId='assistant';if(seen.has(hash(memory.text)))memory.enabled=false;else seen.add(hash(memory.text));}
        this.db.set('memories',items);this.db.set('skills',this.db.get('skills',[]).map(skill=>skill.roleId===id?{...skill,roleId:'assistant',sourceRoleId:skill.sourceRoleId??id}:skill));
        this.db.set(`retirement:${id}:${plan.version}`,{at:Date.now(),taskIds:result.map(t=>t.id),memoryIds:plan.memories.map(m=>m.id),artifactIds:plan.artifacts.map(a=>a.id)});
        this.db.set('retirement-pending:'+id,null);this.patch(id,{status:'retired',generation:plan.version+1,retiredAt:Date.now(),retirementError:null,platformStatus:plan.role.appId?'disable_pending':'not_bound'});
      });
      return {role:this.get(id),tasks:result,memoryCount:plan.memories.length,artifactCount:plan.artifacts.length};
    }catch(error){this.patch(id,{status:result.length?'retiring':plan.role.status,retirementError:'交接尚未完成，请核实后继续交接。'});throw error;}
    finally{this.retiring.delete(id);}
  }
}
