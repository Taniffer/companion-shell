import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hash,stableUUID,validFile,imageMime,AppError,chronologicalSnapshot } from './util.mjs';
import { ROLES } from './engine.mjs';

export function attachBridge({engine,bridge,store,desktop,feishu,normalize,command}){
  const originals={};const context=new AsyncLocalStorage();
  const replace=(object,name,fn)=>{originals[name]??=object[name]?.bind(object);object[name]=fn(originals[name]);};
  function subscribe(parentId,job){const subscribers=engine.db.get(`subscribers:${parentId}`,[]);const index=subscribers.findIndex(s=>s.chatId===job.chatId&&(s.topicId??null)===(job.topicId??null));if(index>=0){if((subscribers[index].scopeIntentAt??0)>(job.scopeIntentAt??0))return;subscribers[index]={...job,channel:'feishu'};}else subscribers.push({...job,channel:'feishu'});engine.db.set(`subscribers:${parentId}`,subscribers.slice(-8));}
  function recoverSubscriptions(){const parents=new Map(originals.jobs(['running','pendingThread','dispatching','finishing']).filter(j=>j.channel==='local').map(j=>[j.id,j]));for(const job of originals.jobs(['done']))if(job.channel!=='local'&&job.outcome==='steered'&&parents.has(job.steeringParent))subscribe(job.steeringParent,job);}
  function notify(job){try{engine.onJob(job);const task=engine.taskForJob(job);if(task)engine.feishuRuntime?.taskChanged(task.id,job);}catch(error){engine.safeLog('job_mirror_error',error);}}
  const mirrorable=job=>!job.companionUtility&&!job.companionRelay&&!!store.db.prepare('SELECT id FROM jobs WHERE id=?').get(job.id);
  function scopeJob(job){
    job.originalScope??=job.scope;job.scopeIntentAt??=Number(job.message?.create_time)||Date.now();
    const kind=command(job.text).type;
    if(['new','project'].includes(kind)&&!job.newConversation){job.newConversation=true;job.companionTaskId=stableUUID('new-scope:'+job.id);job.scope=`companion:${job.companionTaskId}`;}
    if(job.newConversation){
      if(job.originalScope!==job.scope)store.set(`scope:${job.originalScope}`,{pendingScope:job.scope,companionTaskId:job.companionTaskId,explicit:true,intentAt:job.scopeIntentAt});
    }else if(kind!=='new'&&kind!=='project'){
      const binding=store.get(`scope:${job.originalScope}`);
      if(binding?.pendingScope){job.scope=binding.pendingScope;job.companionTaskId??=binding.companionTaskId;job.lockBinding=true;}
      else if(binding?.threadId){
        job.scope=`thread:${binding.threadId}`;job.lockBinding=job.lockBinding||binding.explicit===true;
        store.set(`scope:${job.scope}`,binding);
        job.companionTaskId??=engine.db.byThread(binding.threadId)?.id;
      }
    }
    const task=engine.ensureTask(job);job.companionTaskId=task.id;
    if(!job.internalCallback&&job.channel!=='local')engine.db.set(`reply-origin:${task.id}`,job);
    if(job.channel==='local'){const origin=engine.db.get(`reply-origin:${task.id}`);if(origin&&!job.internalCallback)engine.db.set(`subscribers:${job.id}`,[origin]);}
    if(job.channel==='local')for(const path of job.attachments??[])validFile(path,join(engine.dataDir,'captures'),8*1024*1024);
    return job;
  }
  replace(store,'insert',original=>job=>{if(store.db.prepare('SELECT id FROM jobs WHERE id=?').get(job.id))return false;scopeJob(job);const result=original(job);if(result)notify(job);return result;});
  replace(store,'save',original=>job=>{const result=store.db.prepare('UPDATE jobs SET status=?,scope=?,value=? WHERE id=?').run(job.status,job.scope,JSON.stringify(job),job.id);notify(job);return result;});
  replace(store,'jobs',original=>statuses=>{const jobs=original(statuses);if(statuses.length===1&&statuses[0]==='queued')jobs.sort((a,b)=>Number(!!b.parentId)-Number(!!a.parentId));return jobs;});
  replace(bridge,'bind',original=>job=>{
    if(job.threadId){
      const source=job.originalScope??job.scope,creationScope=job.scope;
      const prior=store.get(`scope:${source}`);
      job.scope=`thread:${job.threadId}`;
      original(job);
      const binding=store.get(`scope:${job.scope}`);
      if(creationScope.startsWith('companion:'))store.set(`scope:${creationScope}`,{...binding,explicit:true});
      if(!prior?.intentAt||prior.intentAt<=job.scopeIntentAt)store.set(`scope:${source}`,{...binding,explicit:job.lockBinding||job.channel==='local'||job.newConversation,intentAt:job.scopeIntentAt});
      for(const queued of originals.jobs(['queued']))if(queued.id!==job.id&&((queued.companionTaskId===job.companionTaskId&&(queued.actorRole??engine.db.task(queued.companionTaskId)?.role)===(job.actorRole??engine.db.task(job.companionTaskId)?.role))||queued.scope===creationScope)){queued.scope=job.scope;queued.lockBinding=true;originals.save(queued);}
      store.save(job);
    }else original(job);
  });
  replace(bridge,'dispatch',original=>job=>context.run(job,async()=>{
    const persisted=store.db.prepare('SELECT value FROM jobs WHERE id=?').get(job.id);if(persisted)Object.assign(job,JSON.parse(persisted.value));
    const task=engine.taskForJob(job);
    if(job.companionSuperseded||(job.ownerGeneration&&job.ownerGeneration!==(task?.ownerGeneration??1))||['retiring','retired'].includes(engine.roles.get(job.actorRole??task?.role)?.status)){job.status='done';job.outcome='已取消';job.companionSuperseded=true;originals.save(job);return;}
    const sessionThread=job.sessionThreadId??(job.actorRole&&job.actorRole!==task?.role?engine.db.session(task?.id,job.actorRole)?.threadId:task?.threadId);
    if(sessionThread&&!job.newConversation){job.scope=`thread:${sessionThread}`;job.lockBinding=true;originals.save(job);}
    const parent=originals.jobs(['running']).find(j=>j.scope===job.scope&&j.id!==job.id);
    if(parent&&command(job.text).type==='message'){await bridge.steer(job,parent);return;}
    if(originals.jobs(['dispatching','pendingThread','finishing']).some(j=>j.scope===job.scope&&j.id!==job.id))return;
    if(originals.jobs(['uncertain']).some(j=>j.scope===job.scope&&!j.threadId))return;
    return original(job);
  }));
  replace(bridge,'steer',original=>(job,parent)=>context.run(job,async()=>{
    const result=await original(job,parent);
    if(result&&job.channel!=='local'&&parent.channel==='local'){
      subscribe(parent.id,job);
    }
    return result;
  }));
  replace(desktop,'call',original=>async(name,args={})=>{
    const job=context.getStore();
    if(job&&name==='list_projects'&&job.lockBinding&&command(job.text).type==='message')return {projects:[]};
    if(job&&['create_thread','send_message_to_thread'].includes(name)){
      if(job.channel==='local')for(const path of job.attachments??[])validFile(path,join(engine.dataDir,'captures'),8*1024*1024);
      if(name==='create_thread'){
        const previous=engine.taskForJob(job);
        if(previous?.threadId&&!job.companionSessionCreation){
          const id=stableUUID('project-reset:'+job.id),scope=`companion:${id}`;
          engine.db.putTask({id,title:job.text.slice(0,56),role:previous.role,private:previous.private,project:job.project,source:job.channel==='local'?'desktop':'feishu',captureIds:[],createdAt:Date.now(),status:'starting'});
          engine.db.patchTask(previous.id,{status:previous.hasFinal?'delivered':'idle'},{touch:false});
          job.companionTaskId=id;job.scope=scope;job.newConversation=true;
          store.set(`scope:${job.originalScope}`,{pendingScope:scope,companionTaskId:id,explicit:true,intentAt:job.scopeIntentAt});
          for(const queued of originals.jobs(['queued']))if(queued.originalScope===job.originalScope&&queued.scopeIntentAt>=job.scopeIntentAt){queued.companionTaskId=id;queued.scope=scope;queued.lockBinding=true;originals.save(queued);}
          if(job.channel!=='local')engine.db.set(`reply-origin:${id}`,job);
          store.save(job);
        }
      }
      args={...args};if(job.channel==='local')args.prompt=args.prompt.replace('这是经本机飞书桥接转入的用户请求。','这是经本机伴随工作台转入的用户请求。').replace('进度和最终答复会自动回传当前飞书会话','进度和最终答复会自动保存到本机伴随工作台');if(!args.prompt.includes('<companion_context>'))args.prompt+=engine.context(job);
      if(job.channel==='local')args.prompt=args.prompt.replaceAll('本机飞书桥接','本机伴随工作台').replaceAll('当前飞书会话','当前事项').replaceAll('自动回传当前事项','自动回传工作台');
      if(name==='create_thread'&&job.companionTaskId){const task=engine.db.task(job.companionTaskId);args.title=`${engine.roles.get(job.actorRole??task?.role)?.name??'秘书'} · ${task?.title??job.title??'新事项'} · ${job.taskTag??''}`;}
      // Retain the source bridge's recovery tag, while using the existing project locally.
      if(args.target?.type==='project'&&args.target.environment?.type==='worktree'&&!job.explicitWorktree)args.target={...args.target,environment:{type:'local'}};
    }
    const raw=await original(name,args),result=name==='read_thread'?chronologicalSnapshot(raw):raw;if(name==='read_thread'){const flags=result.thread?.status?.activeFlags??[],attention=flags.includes('waitingOnApproval')?'approval':flags.includes('waitingOnUserInput')?'input':null;for(const tracked of originals.jobs(['running']))if(tracked.threadId===args.threadId&&tracked.nativeAttention!==attention){tracked.nativeAttention=attention;store.save(tracked);}}return result;
  });
  replace(bridge,'say',original=>(job,body,suffix)=>{
    if(suffix.startsWith('answer:')&&mirrorable(job))try{engine.recordReply(job,body,`${job.id}:${suffix}`);}catch(error){engine.safeLog('answer_mirror_error',error);}
    if(job.channel==='local'&&/^(answer:|terminal|uncertain)/.test(suffix)){
      const subscribers=engine.db.get(`subscribers:${job.id}`,[]);
      for(const subscriber of subscribers)store.emit(`companion-relay:${job.id}:${subscriber.id}:${suffix}`,{job:{...subscriber,channel:'feishu',companionRelay:true},text:body});
    }
    return original(job,body,suffix);
  });
  replace(feishu,'reply',original=>async(job,body,key)=>{
    if(job.channel==='local'){engine.recordReply(job,body,key);return;}
    const result=await original(job,body,key);if(mirrorable(job))try{engine.recordReply(job,body,key);}catch(error){engine.safeLog('reply_mirror_error',error);}return result;
  });
  replace(feishu,'progress',original=>async(job,body)=>{if(job.channel==='local'){engine.recordProgress(job,body);return;}const result=await original(job,body);if(mirrorable(job))try{engine.recordProgress(job,body);}catch(error){engine.safeLog('progress_mirror_error',error);}return result;});
  for(const name of ['reaction','clearReaction','finishProgress'])replace(feishu,name,original=>async(job,...args)=>job.channel==='local'?undefined:original(job,...args));
  replace(feishu,'topicContext',original=>async job=>job.channel==='local'?'':original(job));
  replace(feishu,'attachments',original=>async job=>{if(job.channel==='local'){for(const path of job.attachments??[])validFile(path,join(engine.dataDir,'captures'),8*1024*1024);return job.attachments??[];}return original(job);});
  replace(feishu,'deliverArtifact',original=>async(job,path,key)=>{if(job.channel==='local'){const task=engine.ensureTask(job);engine.artifact(task.id,path,job.cwd??task.cwd);for(const subscriber of engine.db.get(`subscribers:${job.id}`,[]))store.emit(`companion-relay-file:${job.id}:${subscriber.id}:${key}`,{job:{...subscriber,channel:'feishu',companionRelay:true,cwd:job.cwd??task.cwd},artifact:path});return;}const result=await original(job,path,key);if(!mirrorable(job))return result;try{const task=engine.ensureTask(job);engine.artifact(task.id,path,job.cwd??task.cwd);}catch(error){engine.safeLog('artifact_mirror_error',error);}return result;});

  const baseConcurrent=engine.config.maxConcurrent??2;
  Object.defineProperty(engine.config,'maxConcurrent',{configurable:true,get(){const waiting=new Set(originals.jobs(['running','pendingThread','dispatching']).filter(j=>engine.taskForJob(j)?.waitingChildren).map(j=>j.companionTaskId));return baseConcurrent+waiting.size;}});

  async function handle(event,original){
    const job=normalize(event,feishu.botId);if(!job)return original(event);
    if(engine.feishuRuntime&&await engine.feishuRuntime.handleMessage(event,job))return;
    const match=job.text.match(/^(\/记|记一下|\/资料|\/任务|\/切换|\/新任务|\/助手|\/量化|\/产品|\/生活|\/帮助|\/工作台|\/安装包|\/连接手机)(?:\s+([\s\S]*))?$/);
    if(!match)return original(event);
    const owner=engine.owner();
    if(!owner||job.user!==owner||!job.private||job.topicId)return;
    if(engine.db.get(`handled-command:${job.id}`))return;
    const action=match[1],argument=(match[2]??'').trim();
    const reply=body=>{store.emit(`companion-command:${job.id}`,{job:{...job,companionUtility:true},text:body});bridge.wake();};
    try{
      if(action==='/帮助'||action==='/工作台')reply('伴随助手已接入。\n/安装包：取得手机“记一下”APK\n/连接手机：取得一次性配对信息\n/记 内容：登记资料\n/资料 关键词：找资料\n/任务：查看近期事项\n/切换 事项编号或名称：继续同一桌面对话\n/新任务 目标：单独交办\n/助手、/量化、/产品、/生活：直接找伙伴\n电脑工作台可查看完整进展、资料和成果。');
      else if(action==='/安装包'){const path=join(engine.root,'dist','companion-capture-0.1.0.apk');validFile(path,join(engine.root,'dist'));store.emit(`companion-apk:${job.id}`,{job:{...job,companionUtility:true,cwd:join(engine.root,'dist')},artifact:path});bridge.wake();}
      else if(action==='/连接手机'){if(!engine.phonePairing)throw new AppError(503,'手机连接入口正在准备');const pair=engine.phonePairing(argument);reply(`在手机“记一下”的连接页粘贴这条信息：\n\n${pair.code}\n\n十分钟内有效，成功一次后失效。默认需要手机与电脑处于同一Wi-Fi；已使用Tailscale时可发送 /连接手机 Tailscale。`);}
      else if(action==='/记'||action==='记一下'){
        const paths=await originals.attachments(job),files=[];
        for(const path of paths){const file=validFile(path,join(engine.config.bridgeRoot,'data','attachments'),8*1024*1024);const bytes=readFileSync(file.path),mime=imageMime(bytes);if(!mime)throw new AppError(415,'目前登记支持文字、链接与 PNG/JPEG/GIF/WebP 图片');files.push({name:file.name,mime,base64:bytes.toString('base64')});}
        const h=hash(job.id),id=`${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`;
        engine.captures.add({id,text:argument,source:'feishu',createdAt:Number(job.message.create_time)||Date.now(),attachments:files},'feishu-owner');reply('已记下。需要时用 /资料 关键词 找回；登记不会自动派活。');
      }else if(action==='/资料'){
        const items=engine.db.captures(argument,12);reply(items.length?items.map(c=>`${c.title}\n${c.text.slice(0,400)}${c.attachments.length?'\n含 '+c.attachments.length+' 张图片':''}`).join('\n\n'):'还没有找到。电脑工作台和手机“记一下”都可以登记。');
      }else if(action==='/任务'){
        const tasks=engine.db.tasks(40).filter(t=>!t.archived&&t.private!==false).slice(0,12);reply(tasks.length?tasks.map(t=>`${t.id.slice(0,8)} · ${t.title}\n${t.status} · ${(t.summary??'').slice(0,100)}`).join('\n\n')+'\n\n用 /切换 编号或事项名称 接着说。':'还没有事项，直接交代一句，或用 /新任务 目标。');
      }else if(action==='/切换'){
        let task=engine.db.resolveTask(argument);if(!task){const matches=engine.db.tasks(500).filter(t=>t.title===argument&&t.private!==false);if(matches.length===1)task=matches[0];}
        if(!task||task.private===false)throw new AppError(404,'没有找到唯一的个人事项，请先用 /任务 看编号');
        if(!task.threadId)throw new AppError(409,'这件事的桌面对话还在准备，稍后再切换');
        const binding={threadId:task.threadId,project:task.project??null,hostId:task.hostId??'local',explicit:true,intentAt:Date.now()};store.set(`scope:${job.scope}`,binding);store.set(`scope:thread:${task.threadId}`,binding);reply(`已切到：${task.title}\n后续消息会继续这件事，在 Codex 桌面也能接着做。`);
      }else if(action==='/新任务'){
        if(!argument)throw new AppError(400,'请在 /新任务 后面写要交办的目标');engine.enqueue({goal:argument,requestId:job.id,replyJob:job});
      }else{
        const roles={'/助手':'assistant','/量化':'quant','/产品':'product','/生活':'life'},role=roles[action],oldId=engine.db.get(`role:${owner}:${role}`);const old=oldId?engine.db.task(oldId):null;
        if(old?.threadId&&!argument){const binding={threadId:old.threadId,project:old.project??null,hostId:old.hostId??'local',explicit:true,intentAt:Date.now()};store.set(`scope:${job.scope}`,binding);store.set(`scope:thread:${old.threadId}`,binding);reply(`已切到${ROLES[role].name}，直接接着说。`);}
        else {const task=engine.enqueue({goal:argument||'请简短确认已准备好，等待我的下一句。',role,taskId:old?.threadId?old.id:undefined,requestId:job.id,replyJob:job});engine.db.set(`role:${owner}:${role}`,task.id);}
      }
      engine.db.set(`handled-command:${job.id}`,true);
    }catch(error){reply(error instanceof AppError?error.message:'这次操作尚未完成，资料与原会话仍保留，请稍后再试。');engine.safeLog('command_error',error);}
  }
  replace(bridge,'receive',original=>event=>handle(event,original).catch(error=>engine.safeLog('receive_error',error)));
  recoverSubscriptions();
  return {context,originals,scopeJob,recoverSubscriptions};
}
