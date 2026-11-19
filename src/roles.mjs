import {randomUUID} from 'node:crypto';
import {AppError,text,hash} from './util.mjs';
import {ACTIVE_JOBS} from './task-state.mjs';

export class RoleRegistry {
  constructor(engine,defaults){
    this.engine=engine;
    this.db=engine.db;
    for(const [id,definition] of Object.entries(defaults)){
      if(!this.db.role(id))this.db.putRole({id,...definition,status:id==='assistant'?'active':'available',createdAt:Date.now(),generation:1});
    }
    const assistant=this.get('assistant');
    if(assistant)this.db.putRole({...assistant,...defaults.assistant});
    this.recoverLegacyRetirements();
  }
  recoverLegacyRetirements(){
    for(const role of this.db.roles()){
      if(role.id==='assistant'||role.status!=='retiring'||role.retirementProposalId)continue;
      const previous=this.db.get('retirement-pending:'+role.id);
      if(!previous)continue;
      this.db.transaction(()=>{
        let proposal=this.proposals().find(p=>p.kind==='retire'&&p.roleId===role.id&&p.status==='pending');
        if(!proposal){
          proposal={id:'proposal-'+hash('recovered:'+role.id+':'+previous.version).slice(0,20),kind:'retire',
            name:role.name,roleId:role.id,reason:'继续此前已确认的工作交接。',createdAt:previous.startedAt,status:'pending'};
          this.db.set('role-proposals',[...this.proposals(),proposal]);
        }
        this.updateProposal(proposal.id,{status:'approved',resultRoleId:role.id,roleGeneration:role.generation,
          resolvedAt:previous.startedAt,operation:'waiting_for_work'});
        this.patch(role.id,{retirementApprovedAt:previous.startedAt??Date.now(),retirementProposalId:proposal.id});
      });
    }
  }
  get(id){return this.db.role(id);}
  list(){return this.db.roles().map(({pairing,...r})=>({...r,paired:!!r.ownerOpenId,botConnected:this.engine.feishuRuntime?.connected(r.id)??false,connectionCheck:this.engine.feishuRuntime?.checkStatus(r.id)??null}));}
  create({id,name,brief}={}){name=text(name,40);brief=text(brief,3000);if(!name||!brief)throw new AppError(400,'请说明助理名字和职责');id=id??'role-'+randomUUID().slice(0,8);if(!/^[a-z][a-z0-9-]{1,50}$/.test(id)||id==='assistant')throw new AppError(400,'角色编号无效');if(this.get(id)&&this.get(id).status!=='available'&&this.get(id).name===name&&this.get(id).brief===brief)return this.get(id);if(this.get(id)&&this.get(id).status!=='available')throw new AppError(409,'这个角色已经存在');return this.db.putRole({...this.get(id),id,name,brief,status:'active',generation:(this.get(id)?.generation??0)+1,createdAt:this.get(id)?.createdAt??Date.now()});}
  proposals(){return this.db.get('role-proposals',[]);}
  staffingCards(){
    return this.proposals().filter(p=>['pending','approved'].includes(p.status)).map(p=>{
      const task=p.taskId?this.db.task(p.taskId):null;
      const role=p.roleId?this.get(p.roleId):null;
      const openTasks=role?this.db.tasksForRole(role.id).filter(t=>!t.archived&&t.businessState!=='completed').length:0;
      return {...p,name:p.name||role?.name,taskTitle:task?.title,openTasks};
    });
  }
  proposal(id){
    const proposal=this.proposals().find(item=>item.id===id);
    if(!proposal)throw new AppError(404,'找不到这项确认');
    return proposal;
  }
  updateProposal(id,patch){
    const saved=this.proposal(id);
    const next={...saved,...patch};
    this.db.set('role-proposals',this.proposals().map(item=>item.id===id?next:item));
    return next;
  }
  propose(input,taskId,{ownerRequested=false}={}){
    const kind=input.kind??'recruit',reason=text(input.reason,1000);
    const role=kind==='retire'?this.get(input.roleId):null;
    const name=role?.name??text(input.name??'',40),brief=text(input.brief??'',3000);
    const firstGoal=text(input.firstGoal??'',3000);
    const source=taskId?this.db.task(taskId):null;
    if(!reason||!['recruit','retire'].includes(kind)||(kind==='recruit'&&(!name||!brief))||
      (kind==='retire'&&(!role||role.id==='assistant'))||
      (firstGoal&&(kind!=='recruit'||!source||source.private!==true||source.parentId||source.archived)))throw new AppError(400,'请说明具体职责、理由或需要交接的角色');
    const list=this.proposals();
    const key=input.requestId===undefined?hash(JSON.stringify({kind,name,brief,roleId:role?.id,reason,firstGoal})):text(input.requestId,160);
    const id='proposal-'+hash((taskId??'owner')+':'+key).slice(0,20);
    const existing=list.find(p=>p.id===id);
    if(existing)return existing;
    const sameChange=list.find(p=>p.kind===kind&&(kind==='retire'?p.roleId===role.id:p.name.toLowerCase()===name.toLowerCase())&&
      (['pending','approved'].includes(p.status)||(!ownerRequested&&p.status==='dismissed'&&Date.now()-(p.resolvedAt??p.createdAt)<14*86400000)));
    if(sameChange)return sameChange;
    if(kind==='retire'&&role.status!=='active')throw new AppError(409,'只能调整正在协作的长期角色');
    if(kind==='recruit'&&this.db.roles().some(r=>['active','retiring'].includes(r.status)&&r.name.toLowerCase()===name.toLowerCase()))throw new AppError(409,'已经有同名的长期角色，可以直接分工');
    if(!ownerRequested&&list.filter(p=>p.status==='pending').length>=3)throw new AppError(409,'已有待确认的人员安排，先使用现有分工推进');
    const proposal={id,kind,name,brief,roleId:role?.id,roleGeneration:role?.generation,reason,taskId,
      firstGoal:firstGoal||undefined,taskVersion:source?.actionVersion,status:'pending',createdAt:Date.now()};
    const unsettled=list.filter(p=>['pending','approved'].includes(p.status)||p.firstWork==='queued');
    const history=list.filter(p=>!unsettled.includes(p)).slice(-96);
    this.db.set('role-proposals',[...history,...unsettled,proposal]);
    return proposal;
  }
  decide(id,decision){
    if(!['approve','dismiss'].includes(decision))throw new AppError(400,'请选择是否同意这项安排');
    const resolved=this.db.transaction(()=>{
      const p=this.proposal(id);
      if(p.status!=='pending'){
        if((decision==='approve'&&['approved','accepted'].includes(p.status))||(decision==='dismiss'&&p.status==='dismissed'))return p;
        throw new AppError(409,'这项安排已经作出决定');
      }
      if(decision==='dismiss')return this.updateProposal(id,{status:'dismissed',resolvedAt:Date.now()});
      if(p.kind==='recruit'){
        const role=this.create({id:'role-'+p.id.slice(-12),name:p.name,brief:p.brief});
        return this.updateProposal(id,{status:'accepted',resultRoleId:role.id,resolvedAt:Date.now(),firstWork:p.firstGoal?'queued':undefined});
      }
      const role=this.get(p.roleId);
      if(!role||role.id==='assistant'||role.status!=='active'||(p.roleGeneration!==undefined&&p.roleGeneration!==role.generation))throw new AppError(409,'协作角色已经变化，请查看当前安排');
      this.patch(role.id,{status:'retiring',retirementApprovedAt:Date.now(),retirementError:null,retirementProposalId:p.id});
      return this.updateProposal(id,{status:'approved',resultRoleId:role.id,resolvedAt:Date.now(),operation:'waiting_for_work'});
    });
    if(resolved.kind==='retire'&&resolved.status==='approved')this.engine.feishuRuntime?.cancelProvision(resolved.roleId);
    this.staffingChanged(resolved);
    this.wake();
    return resolved;
  }
  confirmRetirement(roleId,{expectedVersion,requestId}={}){
    const role=this.get(roleId);
    if(!role||roleId==='assistant')throw new AppError(400,'请选择要并回的长期角色');
    if(role.retirementProposalId)return this.decide(role.retirementProposalId,'approve');
    if(expectedVersion!==undefined&&role.generation!==expectedVersion)throw new AppError(409,'角色状态已经变化，请查看当前安排');
    const pending=this.proposals().find(p=>p.kind==='retire'&&p.roleId===roleId&&p.status==='pending');
    const proposal=pending??this.propose({kind:'retire',roleId,reason:'你要求把这位协作者的工作并回助理。',requestId:requestId??randomUUID()},null,{ownerRequested:true});
    return this.decide(proposal.id,'approve');
  }
  usable(id){
    const role=this.get(id);
    if(!role||['retiring','retired'].includes(role.status))throw new AppError(409,'角色已停止接单，请找助理');
    return role;
  }
  canFinish(job){
    const role=this.get(job.actorRole??job.role??'assistant');
    if(!role||role.status==='retired')return false;
    // Intake is closed at approval. Previously queued or running work can finish.
    return role.status!=='retiring'||Boolean(role.retirementApprovedAt);
  }
  wake(){
    if(!this.background||this.engine.closed)return;
    setImmediate(()=>this.finishApprovals().catch(error=>this.engine.safeLog('staffing_recovery',error)));
  }
  staffingChanged(proposal){
    try{this.engine.feishuRuntime?.staffingChanged(proposal);}
    catch(error){this.engine.safeLog('staffing_card_update',error);}
  }
  start(){
    this.background=true;
    this.timer=setInterval(()=>this.wake(),3000);
    this.timer.unref();
    this.wake();
  }
  close(){this.background=false;clearInterval(this.timer);return this.finishing;}
  async finishApprovals(){
    if(this.finishing)return this.finishing;
    this.finishing=this.applyApproved();
    try{await this.finishing;}finally{this.finishing=null;}
  }
  async applyApproved(){
    for(const p of this.proposals().filter(p=>p.status==='approved'||p.firstWork==='queued')){
      if(this.engine.closed)return;
      if((p.nextAttemptAt??0)>Date.now())continue;
      if(p.firstWork==='queued'){
        const task=this.db.task(p.taskId);
        const requestId='staffing:'+p.id+':first';
        if(this.db.request(requestId)){
          this.updateProposal(p.id,{firstWork:'assigned'});
        }else if(!task||task.private!==true||task.archived||task.businessState==='completed'||task.actionVersion!==p.taskVersion||this.get(p.resultRoleId)?.status!=='active'){
          this.updateProposal(p.id,{firstWork:'skipped'});
        }else{
          try{
            this.engine.enqueue({parentId:task.id,role:p.resultRoleId,goal:p.firstGoal,requestId});
            this.updateProposal(p.id,{firstWork:'assigned'});
          }catch(error){
            this.updateProposal(p.id,error.status===429?{nextAttemptAt:Date.now()+15000}:{firstWork:'skipped'});
          }
        }
        continue;
      }
      if(this.retirement(p.roleId).active.length)continue;
      try{
        await this.retire(p.roleId,{expectedVersion:p.roleGeneration});
        if(this.proposal(p.id).status==='approved')this.updateProposal(p.id,{status:'accepted',operation:'finished',finishedAt:Date.now()});
        this.staffingChanged(this.proposal(p.id));
      }catch(error){
        this.updateProposal(p.id,{operation:'waiting_for_handoff',nextAttemptAt:Date.now()+15000});
        this.engine.safeLog('role_handoff_waiting',error);
      }
    }
    for(const role of this.db.roles()){
      if(this.engine.closed)break;
      if(role.status!=='retired'||!role.retirementApprovedAt||role.platformStatus!=='disable_pending'||role.disableAttemptedAt||(role.disableRetryAt??0)>Date.now()||!this.engine.feishuRuntime)continue;
      try{await this.engine.feishuRuntime.disableRole(role.id);}catch(error){this.engine.feishuRuntime.safeError?.('role_disable_pending',error);}
    }
  }
  patch(id,patch){const r=this.get(id);if(!r)throw new AppError(404,'找不到这个角色');return this.db.putRole({...r,...patch,updatedAt:Date.now()});}
  async verifyIdle(task){
    const sessions=this.db.sessions(task.id).filter(s=>s.threadId);if(task.threadId&&!sessions.some(s=>s.threadId===task.threadId))sessions.push({threadId:task.threadId});
    if(!sessions.length&&['running','starting','syncing','waiting'].includes(task.status))throw new AppError(409,'尚无法确认当前执行已结束，请刷新或到 Codex 核实');
    for(const session of sessions){if(!session.threadId)continue;let snapshot;try{snapshot=await this.engine.read('read_thread',{threadId:session.threadId,turnLimit:1,includeOutputs:false,maxOutputCharsPerItem:0});}catch{throw new AppError(503,'暂时无法核实原会话状态，交接尚未执行');}const last=snapshot.turns?.at(-1);if(snapshot.thread?.status?.type==='active'||last?.status==='inProgress')throw new AppError(409,'原生会话仍在执行，请等本轮结束或到 Codex 处理');if(!snapshot.thread?.status&&!last?.status)throw new AppError(503,'原会话状态不完整，暂不交接');}
  }
  async handoff(taskId,roleId,{expectedVersion,actionId}={}){
    const task=this.db.resolveTask(taskId),role=this.get(roleId);if(!task||!role)throw new AppError(404,'找不到任务或负责人');if(actionId&&task.handoff?.actionId===actionId&&task.role===roleId)return task;this.usable(roleId);
    if(expectedVersion!==undefined&&(task.actionVersion??1)!==expectedVersion)throw new AppError(409,'这张卡片已更新，请获取最新状态');
    if(this.engine.store.jobs(ACTIVE_JOBS).some(j=>this.engine.taskForJob(j)?.id===task.id))throw new AppError(409,'当前仍有工作在执行或排队，请等本轮结束，或到 Codex 处理后再交接');
    await this.verifyIdle(task);if(['retiring','retired'].includes(this.get(roleId)?.status)||this.get(roleId)?.generation!==role.generation)throw new AppError(409,'接收角色状态已变化，请重新选择负责人');if((this.db.task(task.id)?.actionVersion??1)!==(task.actionVersion??1))throw new AppError(409,'核对期间任务已经变化，请重新核对交接');if(this.engine.store.jobs(ACTIVE_JOBS).some(j=>this.engine.taskForJob(j)?.id===task.id))throw new AppError(409,'核对期间收到了新工作，请等它结束后交接');
    const priorRole=task.role,paused=this.engine.store.jobs(['paused']).filter(j=>this.engine.taskForJob(j)?.id===task.id),version=(task.actionVersion??1)+1;
    const formerRole=this.get(priorRole),reply=roleId==='assistant'&&formerRole?.status==='retiring'?this.engine.feishuRuntime?.retirementReply(task,formerRole):null;
    const summary={id:randomUUID(),actionId,taskId:task.id,fromRole:priorRole,toRole:roleId,at:Date.now(),taskTitle:task.title,requirements:task.lastRequest??'',summary:task.summary??'',captureIds:task.captureIds??[],artifacts:this.db.artifacts(task.id).map(a=>a.id),generation:version};
    for(const job of this.engine.store.jobs(['done','paused']))if(this.engine.taskForJob(job)?.id===task.id){job.actorRole??=priorRole;job.ownerGeneration??=task.ownerGeneration??1;if(job.status==='paused'){job.status='done';job.outcome='已取消';job.companionSuperseded=true;}this.engine.store.save(job);}
    const changed=this.db.transaction(()=>{if(task.threadId&&!this.db.session(task.id,priorRole))this.db.putSession({taskId:task.id,roleId:priorRole,threadId:task.threadId,generation:task.ownerGeneration??1});if(reply){this.db.set(`retired-reply-origin:${priorRole}:${task.id}`,reply.previous);this.db.set('reply-origin:'+task.id,reply.next);}this.db.set('capability:'+task.id,null);const session=this.db.session(task.id,roleId);this.db.set(`handoff:${task.id}:${version}`,summary);this.db.message(task.id,{role:'system',text:`任务从${this.get(priorRole)?.name??priorRole}交给${role.name}。`,handoffId:summary.id});return this.db.patchTask(task.id,{role:roleId,status:paused.length?'paused':'idle',pendingHandoffGoal:paused.length?task.lastRequest:null,threadId:session?.threadId??null,scope:session?.threadId?'thread:'+session.threadId:undefined,ownerGeneration:version,actionVersion:version,handoff:summary,businessState:task.businessState==='completed'?'completed':'open'});});this.engine.feishuRuntime?.taskChanged(task.id);return changed;
  }
  retirement(id){const r=this.get(id);if(!r||id==='assistant')throw new AppError(400,'助理需要继续负责你的工作');const tasks=this.db.tasksForRole(id),memories=this.db.get('memories',[]).filter(m=>m.roleId===id&&m.enabled!==false),artifacts=tasks.flatMap(t=>this.db.artifacts(t.id));const taskIds=new Set(tasks.map(t=>t.id));const active=this.engine.store.jobs(ACTIVE_JOBS).filter(j=>j.actorRole===id||taskIds.has(this.engine.taskForJob(j)?.id));return {role:r,tasks,memories,artifacts,active:active.map(j=>({id:j.id,status:j.status,taskId:j.companionTaskId})),version:r.generation??1};}
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
        const items=this.db.get('memories',[]),seen=new Set(items.filter(m=>m.roleId==='assistant'&&m.enabled!==false).map(m=>hash(m.text)));
        for(const memory of items.filter(m=>m.roleId===id)){memory.originalRoleId??=id;memory.sourceRoleId??=id;memory.roleId='assistant';if(seen.has(hash(memory.text)))memory.enabled=false;else if(memory.enabled!==false)seen.add(hash(memory.text));}
        this.db.set('memories',items);this.db.set('skills',this.db.get('skills',[]).map(skill=>skill.roleId===id?{...skill,roleId:'assistant',sourceRoleId:skill.sourceRoleId??id}:skill));
        this.db.set(`retirement:${id}:${plan.version}`,{at:Date.now(),taskIds:result.map(t=>t.id),memoryIds:plan.memories.map(m=>m.id),artifactIds:plan.artifacts.map(a=>a.id)});
        for(const proposal of this.proposals().filter(p=>p.kind==='retire'&&p.roleId===id&&['approved','pending'].includes(p.status)))this.updateProposal(proposal.id,{status:'accepted',operation:'finished',finishedAt:Date.now()});
        this.db.set('retirement-pending:'+id,null);this.patch(id,{status:'retired',generation:plan.version+1,retiredAt:Date.now(),retirementError:null,platformStatus:plan.role.appId?'disable_pending':'not_bound'});
      });
      return {role:this.get(id),tasks:result,memoryCount:plan.memories.length,artifactCount:plan.artifacts.length};
    }catch(error){this.patch(id,{status:result.length?'retiring':plan.role.status,retirementError:'交接尚未完成，请核实后继续交接。'});throw error;}
    finally{this.retiring.delete(id);}
  }
}
