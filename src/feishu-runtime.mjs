import * as lark from '@larksuiteoapi/node-sdk';
import QRCode from 'qrcode';
import {randomUUID} from 'node:crypto';
import {readFileSync,createReadStream} from 'node:fs';
import {join} from 'node:path';
import {AppError,hash,text,validFile,imageMime} from './util.mjs';
import {Vault} from './vault.mjs';
import {taskCard,listCard,formCard,teamCard,staffingCard,foundTasksCard,receiptCard,callbackButton,linkButton} from './feishu-cards.mjs';
import {findTasks,taskIntent} from './task-search.mjs';

const check=r=>{if(r.code&&r.code!==0){const error=new Error('飞书操作尚未完成（'+r.code+'）');error.code=r.code;throw error;}return r.data??r;};
const uuid=value=>hash(value).slice(0,32);
const sdkLogger={error(){},warn(){},info(){},debug(){},trace(){}};
export class FeishuRuntime{
  constructor({engine,feishu,normalize,log=()=>{}}){Object.assign(this,{engine,primary:feishu,normalize,log});this.db=engine.db;this.store=engine.store;this.clients=new Map();this.originals=new Map();this.controllers=new Map();this.vault=new Vault(join(engine.dataDir,'secrets'));this.primaryApp=engine.config.feishu.appId;this.clients.set(this.primaryApp,feishu);this.remember(feishu);this.flushRunning=false;this.dirty=new Map();this.closed=false;}
  quietClient(client){for(const target of [client.client,client.ws])if(target?.logger){if(target.logger.logger)target.logger.logger=sdkLogger;else target.logger=sdkLogger;}}
  remember(client){this.quietClient(client);const methods={};for(const name of ['reply','progress','finishProgress','reaction','clearReaction','attachments','deliverArtifact','topicContext'])methods[name]=client[name].bind(client);this.originals.set(client,methods);}
  roleForApp(appId){return appId===this.primaryApp?this.engine.roles.get('assistant'):this.db.roles().find(r=>r.appId===appId);}
  appForRole(roleId){return roleId==='assistant'?this.primaryApp:this.engine.roles.get(roleId)?.appId;}
  owner(appId){return appId===this.primaryApp?this.engine.owner():this.roleForApp(appId)?.ownerOpenId;}
  connected(roleId){const app=this.appForRole(roleId),client=this.clients.get(app);try{return client?.ws.getConnectionStatus().state==='connected';}catch{return false;}}
  client(job){const app=job.botAppId??this.primaryApp,client=this.clients.get(app);if(!client)throw new AppError(503,'原机器人连接尚未恢复，回信已保留');return client;}
  wire(job){return job.createNewMessage?{...job,id:job.progressId??null,sourceMessageId:job.progressId??null}:job.sourceMessageId?{...job,id:job.sourceMessageId}:job;}
  install(){
    for(const role of this.db.roles())if(role.registrationUrl)this.engine.roles.patch(role.id,{registrationUrl:null,registrationMessage:'上次确认流程已中断，请重新开通以核实平台结果。'});
    for(const name of ['reply','progress','finishProgress','reaction','clearReaction','attachments','deliverArtifact','topicContext'])this.primary[name]=async(job,...args)=>{
      const client=this.client(job),original=this.originals.get(client)[name],wire=this.wire(job);
      if(name==='reply'){
        if(job.cardPayload)return this.sendCard(job,job.cardPayload,args[1]);
        if(!wire.id)return this.sendText(job,args[0],args[1]);
      }
      if(name==='deliverArtifact'&&job.createNewMessage&&!wire.id)return this.deliverNew(job,args[0],args[1]);
      if(name==='progress'&&job.private&&job.companionTaskId){const task=this.db.task(job.companionTaskId);if(task){const payload=taskCard(task,this.engine.roles,args[0]);const id=await this.sendCard({...job,patchMessageId:job.progressId},payload,job.id+':progress');job.progressId=id;return;}}
      if(name==='finishProgress'&&job.private&&job.progressId&&job.companionTaskId){const task=this.db.task(job.companionTaskId);if(task)return this.sendCard({...job,patchMessageId:job.progressId},taskCard(task,this.engine.roles),job.id+':finish');}
      if(['reaction','clearReaction'].includes(name)&&(job.sourceMessageId||job.createNewMessage))return;
      return original(wire,...args);
    };
    this.primary.start=handler=>this.startClient(this.primary,this.primaryApp,event=>handler(event));
    this.engine.roles.patch('assistant',{appId:this.primaryApp,ownerOpenId:this.engine.owner(),platformStatus:this.engine.roles.get('assistant')?.platformStatus??'messaging_ready'});
    this.timer=setInterval(()=>{this.flush().catch(e=>this.safeError('action_flush',e));this.flushDirty().catch(e=>this.safeError('card_update',e));},1500);this.timer.unref();
    for(const action of this.db.actions(['running']))this.db.putAction({...action,status:'pending'});
    for(const role of this.db.roles())if(role.id!=='assistant'&&role.appId&&role.secretRef)this.connectRole(role.id).catch(e=>this.engine.roles.patch(role.id,{provisionError:'飞书连接待恢复（'+(e.code??'network')+'）'}));
    return this;
  }
  safeError(event,error){this.log(event,{code:error.code??error.status??'unknown'});}
  async startClient(client,appId,handler){const dispatcher=new lark.EventDispatcher({loggerLevel:lark.LoggerLevel.error,logger:sdkLogger}).register({
    'im.message.receive_v1':event=>handler(event),
    'application.bot.menu_v6':event=>this.menu(appId,event),
    'card.action.trigger':event=>this.callback(appId,event)
  });await client.ws.start({eventDispatcher:dispatcher});}
  destination(appId,owner=this.owner(appId),sourceMessageId=null,chatId=null){return {botAppId:appId,id:sourceMessageId,sourceMessageId,chatId,user:owner,private:true,channel:'feishu',companionUtility:true};}
  async sendText(job,body,key){const wire=this.wire(job),client=this.client(job),data={msg_type:'text',content:JSON.stringify({text:String(body)}),uuid:uuid(key??randomUUID())};const result=wire.id?await client.client.im.message.reply({path:{message_id:wire.id},data:{...data,reply_in_thread:!!job.topicId}}):await client.client.im.message.create({params:{receive_id_type:job.chatId?'chat_id':'open_id'},data:{...data,receive_id:job.chatId??job.user}});return check(result).message_id;}
  async deliverNew(job,path,key){const file=validFile(path,job.cwd,30*1024*1024),client=this.client(job),image=/\.(png|jpe?g|gif|webp)$/i.test(file.path)&&file.size<10*1024*1024;const uploaded=image?check(await client.client.im.image.create({data:{image_type:'message',image:createReadStream(file.path)}})):check(await client.client.im.file.create({data:{file_type:'stream',file_name:file.name,file:createReadStream(file.path)}}));check(await client.client.im.message.create({params:{receive_id_type:job.chatId?'chat_id':'open_id'},data:{receive_id:job.chatId??job.user,msg_type:image?'image':'file',content:JSON.stringify(image?{image_key:uploaded.image_key}:{file_key:uploaded.file_key}),uuid:uuid(key)}}));}
  async sendCard(job,payload,key){const client=this.client(job),parent=this.wire(job).id;let messageId=job.patchMessageId;
    if(job.staffingProposalId)payload=staffingCard(this.staffingView(job.staffingProposalId));
    if(messageId){check(await client.client.im.message.patch({path:{message_id:messageId},data:{content:JSON.stringify(payload)}}));const issued=this.db.get('feishu-card:'+messageId);if(issued)this.db.set('feishu-card:'+messageId,{...issued,patchedAt:Date.now(),contentHash:hash(JSON.stringify(payload))});return messageId;}
    const data={msg_type:'interactive',content:JSON.stringify(payload),uuid:uuid(key??randomUUID())};const result=parent?await client.client.im.message.reply({path:{message_id:parent},data:{...data,reply_in_thread:!!job.topicId}}):await client.client.im.message.create({params:{receive_id_type:job.chatId?'chat_id':'open_id'},data:{...data,receive_id:job.chatId??job.user}});messageId=check(result).message_id;if(!messageId)throw new Error('飞书没有返回消息编号');
    this.db.set('feishu-card:'+messageId,{messageId,appId:job.botAppId??this.primaryApp,owner:job.user??this.owner(job.botAppId??this.primaryApp),chatId:job.chatId,taskId:job.companionTaskId??null,createdAt:Date.now(),checkId:job.companionCheckId??null,proposalId:job.staffingProposalId??null,searchTaskIds:job.searchTaskIds});if(job.companionCheckId)this.db.set('feishu-check:'+job.companionCheckId,{status:'sent',messageId,sentAt:Date.now()});return messageId;
  }
  queueCard(dest,payload,key=randomUUID()){this.store.emit('companion-card:'+key,{job:{...dest,companionUtility:true,cardPayload:payload},text:'interactive'});this.engine.bridge.wake();}
  queueText(dest,body,key=randomUUID()){this.store.emit('companion-note:'+key,{job:{...dest,companionUtility:true},text:body});this.engine.bridge.wake();}
  checkStatus(roleId){const id=this.db.get('feishu-check-role:'+roleId);return id?this.db.get('feishu-check:'+id):null;}
  checkConnection(roleId){const app=this.appForRole(roleId),owner=this.owner(app);if(!app||!owner)throw new AppError(409,'请先完成机器人开通与用户绑定');const id=randomUUID();this.db.set('feishu-check-role:'+roleId,id);this.db.set('feishu-check:'+id,{status:'pending',createdAt:Date.now()});this.queueCard({...this.destination(app,owner),companionCheckId:id},receiptCard('伴随连接验证','这是一张真实飞书卡片。点下面任一入口，工作台就能确认你的操作已返回。',[callbackButton('我的任务','list',{},true),callbackButton('记一下','capture'),callbackButton('助理','team')]),'connection-check:'+id);return {id,status:'pending'};}
  staffingView(id){
    const p=this.engine.roles.proposal(id);
    return this.engine.roles.staffingCards().find(item=>item.id===id)??{...p,name:p.name||this.engine.roles.get(p.roleId)?.name};
  }
  notifyProposal(p,dest=this.destination(this.primaryApp),key='proposal:'+p.id){
    if(!dest.user||p.status!=='pending')return;
    this.queueCard({...dest,staffingProposalId:p.id},staffingCard(this.staffingView(p.id)),key);
  }
  staffingChanged(p){
    const issued=this.db.sql.prepare("SELECT value FROM kv WHERE key LIKE 'feishu-card:%' AND json_extract(value,'$.proposalId')=?").all(p.id);
    for(const row of issued){
      const card=JSON.parse(row.value);
      if(card.appId!==this.primaryApp||card.owner!==this.owner(this.primaryApp))continue;
      const dest=this.destination(card.appId,card.owner,null,card.chatId);
      this.queueCard({...dest,patchMessageId:card.messageId,staffingProposalId:p.id},staffingCard(this.staffingView(p.id)),`staffing:${p.id}:${p.status}:${card.messageId}`);
    }
  }
  filters(app){return this.db.get('feishu-filters:'+app,{role:app===this.primaryApp?'all':this.roleForApp(app)?.id,bucket:'unfinished',offset:0});}
  list(app,filters={}){const value={...this.filters(app),...filters},role=this.roleForApp(app);if(role?.id!=='assistant')value.role=role.id;const options={role:value.role,includeImported:false,rootOnly:value.role==='all',privateOnly:true};const result=this.db.boardTasks({...options,bucket:value.bucket,offset:value.offset,limit:2});this.db.set('feishu-filters:'+app,value);return listCard({...result,...value,counts:this.db.boardCounts(options),roles:this.engine.roles.list()});}
  current(app){
    const current=this.db.get('feishu-current:'+app+':'+this.owner(app));
    const task=current?this.db.task(current.taskId):null;
    const role=this.roleForApp(app)?.id;
    if(!task||task.private!==true||(role!=='assistant'&&task.role!==role))return null;
    const candidate=current.actorRole??role;
    const actorRole=role==='assistant'&&(candidate!==task.role||['retiring','retired'].includes(this.engine.roles.get(candidate)?.status))?'assistant':candidate;
    return {...current,actorRole,task};
  }
  select(app,task,actorRole=this.roleForApp(app)?.id){if(!this.owner(app))throw new AppError(409,'这只机器人尚未绑定用户，请先完成绑定');if(actorRole!=='assistant'&&task.role!==actorRole)throw new AppError(403,'这项任务已由其他角色接手，请找助理');this.db.set('feishu-current:'+app+':'+this.owner(app),{taskId:task.id,actorRole,at:Date.now()});}
  form(type,app,options={}){const token=options.formToken??randomUUID().replaceAll('-','');if(!this.db.get('feishu-form:'+token))this.db.set('feishu-form:'+token,{type,appId:app,owner:this.owner(app),taskId:options.task?.id,version:options.task?.actionVersion??null,roleId:options.role?.id,proposalId:options.proposalId,draftId:options.draftId,expires:Date.now()+14*86400000});return formCard(type,token,{...options,roles:this.engine.roles.list()});}
  menu(app,data){const e=data.event??data,operator=e.operator?.operator_id?.open_id??e.operator?.open_id;if(!this.owner(app)||operator!==this.owner(app))return;this.engine.roles.patch(this.roleForApp(app).id,{menuStatus:'verified'});const key=e.event_key;const action=key==='capture'?'capture':key==='team'?'team':key==='new_task'?'new_task':key==='current'?'current':key==='secretary'?'secretary':'list';this.persist({id:'menu:'+app+':'+(data.event_id??data.header?.event_id??hash(JSON.stringify(e))),appId:app,operator,action,payload:{},dest:this.destination(app,operator),status:'pending'});}
  callback(app,data){try{const e=data.event??data,operator=e.operator?.open_id??e.operator?.operator_id?.open_id;if(!this.owner(app)||operator!==this.owner(app))throw new AppError(403,'当前用户没有操作这个个人助理的权限');
    const source=e.context?.open_message_id??e.message_id,chat=e.context?.open_chat_id??e.chat_id,issued=this.db.get('feishu-card:'+source);if(!issued||issued.appId!==app||issued.owner!==operator||issued.createdAt<Date.now()-14*86400000)throw new AppError(409,'卡片已失效，请从菜单获取最新卡片');
    let payload=e.action?.value??{},action=payload.action,form=null;if(typeof payload==='string')payload=JSON.parse(payload);action=payload.action;
    if(e.action?.name?.startsWith('submit_')){const token=e.action.name.slice(7);form=this.db.get('feishu-form:'+token);if(!form||form.appId!==app||form.owner!==operator||form.expires<Date.now())throw new AppError(409,'表单已失效，请重新打开');action='form';payload={...form,formToken:token,values:e.action.form_value??{}};}
    if(!action)throw new AppError(400,'没有识别到这项操作');
    if(action==='staffing_decision'&&(app!==this.primaryApp||!payload.proposalId||issued.proposalId!==payload.proposalId||!['approve','dismiss'].includes(payload.decision)))throw new AppError(403,'请从原确认卡操作');
    this.engine.roles.patch(this.roleForApp(app).id,{callbackStatus:'verified'});
    if(e.action?.option)payload.option=e.action.option;
    const mutation=['complete','reopen','retire'].includes(action);const id=form?'form:'+payload.formToken:mutation?`mutation:${app}:${payload.taskId??payload.roleId}:${payload.version}:${action}`:'event:'+app+':'+(data.event_id??data.header?.event_id??e.token??hash(JSON.stringify(e)));
    const fingerprint=hash(JSON.stringify({action,payload})),prior=this.db.action(id);if(prior){if(prior.fingerprint!==fingerprint)throw new AppError(409,'这份表单已经提交，请打开新表单');if(prior.status==='failed'){this.db.putAction({...prior,status:'pending',error:null});setImmediate(()=>this.flush().catch(e=>this.safeError('action_retry',e)));}return {toast:{type:'success',content:prior.status==='done'?'已处理，请查看最新状态':'已收到，正在处理'}};}
    if(action==='continue_task'){
      const task=payload.taskId?this.db.task(payload.taskId):null;
      const role=this.roleForApp(app)?.id;
      if(!role||!task||task.private!==true||(issued.taskId!==task.id&&!issued.searchTaskIds?.includes(task.id)))throw new AppError(409,'请从对应任务卡接续');
      this.db.transaction(()=>{
        this.select(app,task,role);
        this.db.putAction({id,appId:app,operator,action,payload,fingerprint,status:'done',result:{taskId:task.id}});
      });
      return {toast:{type:'success',content:'已接回原任务，直接发补充即可'}};
    }
    if(['complete','reopen'].includes(action)||form?.taskId){const task=this.db.task(payload.taskId);if(!task||task.private===false)throw new AppError(404,'找不到这项个人任务');if((task.actionVersion??1)!==payload.version)throw new AppError(409,'任务已更新，请先查看最新状态');}
    this.persist({id,appId:app,operator,action,payload,fingerprint,dest:this.destination(app,operator,source,chat),status:'pending',createdAt:Date.now()});if(issued.checkId)this.db.set('feishu-check:'+issued.checkId,{...this.db.get('feishu-check:'+issued.checkId),status:'verified',callbackAt:Date.now()});return {toast:{type:'success',content:'已收到，正在安排'}};
  }catch(error){return {toast:{type:'error',content:error instanceof AppError?error.message:'这次操作尚未提交，请稍后再试'}};}}
  persist(action){if(!this.db.action(action.id))this.db.putAction(action);setImmediate(()=>this.flush().catch(e=>this.safeError('action_flush',e)));return action;}
  async flush(){if(this.flushRunning||this.closed)return;this.flushRunning=true;try{for(const saved of this.db.actions(['pending']).slice(0,10)){let action=this.db.putAction({...saved,status:'running'});try{const receipt=await this.execute(action);action=this.db.putAction({...action,status:'done',result:receipt??null});}catch(error){this.db.putAction({...action,status:'failed',error:error instanceof AppError?error.message:'暂未完成（'+(error.code??'network')+'），请稍后重试'});this.queueCard(action.dest,receiptCard('这一步还没完成',error instanceof AppError?error.message:'连接或平台操作尚未完成，请稍后重试',[callbackButton('获取最新任务','list')]),action.id+':failure');this.safeError('action_failed',error);}}}finally{this.flushRunning=false;}}
  async execute(a){const {action,payload:p,appId:app,dest}=a,role=this.roleForApp(app)?.id??'assistant';if(a.operator!==this.owner(app))throw new AppError(403,'机器人用户绑定已变化，请重新操作');
    const task=p.taskId?this.db.task(p.taskId):null;if(task&&(task.private===false||(role!=='assistant'&&task.role!==role)))throw new AppError(403,'这项任务不在当前角色的工作范围');
    if(action==='list'||action==='filter_role'){const filters=action==='filter_role'?{role:p.option,offset:0}:p;this.queueCard(dest,this.list(app,filters),a.id);return;}
    if(action==='task'){if(!task)throw new AppError(404,'找不到任务');this.queueCard({...dest,companionTaskId:task.id},taskCard(task,this.engine.roles),a.id);return;}
    if(action==='find_task'){
      const found=findTasks(this.db,p.query,{role:role==='assistant'?'all':role,privateOnly:true,includeImported:role==='assistant',limit:2});
      if(found.uniqueTaskId&&p.mode==='continue')return this.enqueueAction(a,found.uniqueTaskId,p.goal,role);
      if(found.uniqueTaskId&&p.mode==='focus'){
        const selected=this.db.task(found.uniqueTaskId);
        this.select(app,selected,role);
        this.queueCard({...dest,companionTaskId:selected.id},taskCard(selected,this.engine.roles),a.id);return {taskId:selected.id};
      }
      this.queueCard({...dest,searchTaskIds:found.tasks.map(task=>task.id)},foundTasksCard(p.query,found.tasks),a.id);return;
    }
    if(action==='send_artifact'){
      const artifact=this.db.artifact(p.artifactId);
      const ownerTask=artifact?this.db.task(artifact.taskId):null;
      if(!task||!ownerTask||ownerTask.private!==true||(ownerTask.id!==task.id&&(role!=='assistant'||ownerTask.parentId!==task.id)))throw new AppError(404,'找不到这份任务成果');
      const cwd=artifact.snapshot?join(this.engine.dataDir,'artifacts',ownerTask.id):ownerTask.cwd;
      if(!cwd)throw new AppError(409,'成果的来源目录尚未确认');
      validFile(artifact.path,cwd);
      this.store.emit('companion-find-artifact:'+a.id,{job:{...dest,createNewMessage:true,cwd,companionUtility:true},artifact:artifact.path});
      this.engine.bridge.wake();return {artifactId:artifact.id};
    }
    if(action==='current'){const selected=this.current(app);this.queueCard(dest,selected?taskCard(selected.task,this.engine.roles):this.list(app),a.id);return;}
    if(action==='capture'){const prior=this.db.get('feishu-capture:'+app+':'+a.operator),effect=this.db.get('capture-start:'+a.id),h=hash(a.id);const draft=effect??(prior?.expires>Date.now()?prior:{id:`${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`,text:'',attachments:[],version:1,expires:Date.now()+30*60000});this.db.transaction(()=>{this.db.set('capture-start:'+a.id,draft);this.db.set('feishu-capture:'+app+':'+a.operator,draft);});this.queueCard(dest,this.form('capture',app,{draftId:draft.id,initialText:draft.text,formToken:hash('capture-form:'+a.id).slice(0,32)}),a.id);return;}
    if(action==='capture_cancel'){this.db.set('feishu-capture:'+app+':'+a.operator,null);this.queueCard(dest,receiptCard('已退出记录模式','已退出本次记录，没有创建任务；已保存的资料仍然保留。'),a.id);return;}
    if(action==='team'||action==='manage_roles'){this.queueCard(dest,teamCard(this.engine.roles.list(),{offset:p.offset??0,manage:action==='manage_roles'}),a.id);return;}
    if(action==='staffing_decision'||action==='dismiss_proposal'){
      if(role!=='assistant')throw new AppError(403,'请找助理');
      const proposal=this.engine.roles.decide(p.proposalId,action==='dismiss_proposal'?'dismiss':p.decision);
      return {proposalId:proposal.id,status:proposal.status,roleId:proposal.resultRoleId};
    }
    if(action==='review_proposal'){
      if(role!=='assistant')throw new AppError(403,'请找助理');
      const proposal=this.staffingView(p.proposalId);
      this.queueCard({...dest,staffingProposalId:proposal.id},staffingCard(proposal),a.id);return;
    }
    if(action==='recruit')return this.enqueueSecretaryAction(a,null,'请看看我最近交代的工作是否持续需要一位专业协作者。按实际需要安排，只有长期成员变化需要我确认。');
    if(action==='new_task'){this.queueCard(dest,this.form('create_task',app),a.id);return;}
    if(action==='supplement'){if(!task)throw new AppError(404,'找不到任务');this.queueCard(dest,this.form('supplement',app,{task}),a.id);return;}
    if(action==='continue_task'){
      if(!task)throw new AppError(404,'找不到任务');
      this.select(app,task,role);
      this.queueCard(dest,receiptCard('已接回原任务',task.title+'。接下来直接发补充。',[callbackButton('查看进展','task',{taskId:task.id},true)]),a.id);
      return {taskId:task.id};
    }
    if(action==='focus'||action==='role'||action==='secretary'){
      const targetRole=action==='secretary'?'assistant':p.roleId??task?.role,targetApp=this.appForRole(targetRole);if(!targetApp||!this.owner(targetApp))throw new AppError(409,'专业角色的独立飞书入口尚未完成开通与绑定，请在电脑“协作与飞书”继续');
      const target=task??this.db.tasksForRole(targetRole).find(t=>!t.archived);if(target)this.select(targetApp,target,targetRole);const url='https://applink.feishu.cn/client/bot/open?appId='+targetApp;this.queueCard(dest,receiptCard('已准备好继续',target?'已定位：'+target.title:'直接在独立机器人会话交代一件事。',[linkButton('打开'+this.engine.roles.get(targetRole).name+'会话',url)]),a.id);return;
    }
    if(action==='summary'){if(!task)throw new AppError(404,'找不到任务');this.select(this.primaryApp,task,'assistant');return this.enqueueSecretaryAction(a,task.id,'请根据这项任务已经取得的结果、资料和限制，给我一份简短汇总；不要重新执行已经完成的专业工作。');}
    if(action==='complete'||action==='reopen'){if(!task)throw new AppError(404,'找不到任务');if((task.actionVersion??1)!==p.version&&task.lastStateAction!==a.id)throw new AppError(409,'任务已更新，请取最新状态');const next=await this.engine.setTaskState(task.id,action==='complete'?'completed':'open',{actionId:a.id});this.queueCard({...dest,companionTaskId:task.id},taskCard(next,this.engine.roles),a.id);return {taskId:task.id};}
    if(action==='retire_plan'||action==='retire'){
      if(role!=='assistant')throw new AppError(403,'请找助理办理交接');
      if(action==='retire'){
        const proposal=this.engine.roles.confirmRetirement(p.roleId,{expectedVersion:p.version,requestId:a.id});
        this.queueCard(dest,staffingCard(this.staffingView(proposal.id)),a.id);return {roleId:proposal.roleId};
      }
      const proposal=this.engine.roles.propose({kind:'retire',roleId:p.roleId,reason:'你要求把这位协作者的工作并回助理。',requestId:a.id},null,{ownerRequested:true});
      this.notifyProposal(proposal,dest,a.id);return {proposalId:proposal.id};
    }
    if(action==='form'){
      const values=p.values??{};
      if(p.type==='capture'){
        const content=text(values.content??'',1000);
        const alreadySaved=this.db.capture(p.draftId);if(alreadySaved){this.queueCard(dest,receiptCard('已保存到资料','仅登记资料，还没有创建任务。',[callbackButton('交给助理处理','process_capture',{captureId:alreadySaved.id},true),callbackButton('再记一条','capture')]),a.id);return {captureId:alreadySaved.id};}const draft=this.db.get('feishu-capture:'+app+':'+a.operator);if(!draft||draft.id!==p.draftId)throw new AppError(409,'记录模式已结束，请重新点记一下');if(!content.trim()&&!draft.attachments.length)throw new AppError(400,'请写一点内容或发送一张图片');const attachments=draft.attachments.map(path=>{const file=validFile(path,join(this.engine.config.bridgeRoot,'data','attachments'),8*1024*1024),bytes=readFileSync(file.path),mime=imageMime(bytes);if(!mime)throw new AppError(415,'暂只支持 PNG/JPEG/GIF/WebP 图片');return {name:file.name,mime,base64:bytes.toString('base64')};});
        const saved=this.engine.captures.add({id:draft.id,text:[content,values.url].filter(Boolean).join('\n'),source:'feishu',attachments},'feishu-owner');this.db.set('feishu-capture:'+app+':'+a.operator,null);this.queueCard(dest,receiptCard('已保存到资料','仅登记资料，还没有创建任务。',[callbackButton('交给助理处理','process_capture',{captureId:saved.capture.id},true),callbackButton('再记一条','capture')]),a.id);return {captureId:saved.capture.id};
      }
      if(p.type==='recruit'){
        if(role!=='assistant')throw new AppError(403,'请由助理安排招募');
        if(p.proposalId){
          if(this.engine.roles.proposal(p.proposalId).kind!=='recruit')throw new AppError(400,'这项安排不是招募');
          const proposal=this.engine.roles.decide(p.proposalId,'approve');
          this.queueCard(dest,staffingCard(this.staffingView(proposal.id)),a.id);return {roleId:proposal.resultRoleId};
        }
        const newRole=this.engine.roles.create({id:'role-'+hash(a.id).slice(0,12),name:values.name,brief:values.brief});
        this.queueCard(dest,receiptCard('已加入协作',newRole.name+'的工作由助理安排。'),a.id);return {roleId:newRole.id};
      }
      if(p.type==='assign'){const next=await this.engine.roles.handoff(p.taskId,values.roleId,{expectedVersion:p.version,actionId:a.id});this.queueCard(dest,taskCard(next,this.engine.roles),a.id);return {taskId:next.id};}
      const content=text(values.content??'',1000);
      if(!content)throw new AppError(400,'请先写一句要推进的事');return this.enqueueAction(a,p.taskId??null,content,role);
    }
    if(action==='process_capture'){const capture=this.db.capture(p.captureId);if(!capture)throw new AppError(404,'找不到这条资料');return this.enqueueSecretaryAction(a,null,'请帮我整理这条已登记资料，提炼要点和以后如何找回；没有明确行动要求时不要额外派活。',[capture.id]);}
    if(action==='capture_append'){
      const key='feishu-capture:'+app+':'+a.operator;let draft=this.db.get('capture-append-effect:'+a.id);
      if(!draft){draft=this.db.get(key);if(!draft||draft.expires<Date.now())throw new AppError(409,'记录模式已结束，请重新记一下');const wire=this.wire(p.job),client=this.client(p.job),paths=await this.originals.get(client).attachments(wire);if(draft.attachments.length+paths.length>3)throw new AppError(400,'每次最多登记三张图片');draft.attachments.push(...paths);draft.text=[draft.text,p.job.text].filter(Boolean).join('\n').slice(0,1000);draft.version++;this.db.transaction(()=>{this.db.set(key,draft);this.db.set('capture-message:'+p.job.id,true);this.db.set('capture-append-effect:'+a.id,draft);});}
      this.queueCard(dest,this.form('capture',app,{draftId:draft.id,initialText:draft.text,formToken:hash('capture-append:'+a.id).slice(0,32)}),a.id);return;
    }
    throw new AppError(400,'这项操作暂不可用，请获取最新入口');
  }
  enqueueSecretaryAction(a,taskId,goal,captureIds=[]){const owner=this.owner(this.primaryApp);if(!owner)throw new AppError(409,'助理尚未绑定用户');const redirected=a.appId===this.primaryApp?a:{...a,appId:this.primaryApp,operator:owner,dest:{...this.destination(this.primaryApp,owner),createNewMessage:true}};return this.enqueueAction(redirected,taskId,goal,'assistant',captureIds);}
  enqueueAction(a,taskId,goal,role,captureIds=[]){const prior=this.db.request(a.id);const priorJob=this.store.db.prepare('SELECT value FROM jobs WHERE id=?').get(a.id);if(prior||priorJob)return {taskId:prior??JSON.parse(priorJob.value).companionTaskId};const job={...a.dest,id:a.id,sourceMessageId:a.dest.sourceMessageId,companionUtility:false,scope:'feishu:'+a.appId+':'+a.operator,mentioned:false,message:{message_type:'text',content:JSON.stringify({text:goal}),create_time:String(Date.now())}};const task=this.engine.enqueue({taskId,goal,role,captureIds,requestId:a.id,replyJob:job});this.select(a.appId,task,role);return {taskId:task.id};}
  async handleMessage(event,job){if(!job.private||job.topicId||job.user!==this.engine.owner())return false;return this.handleOwned(this.primaryApp,job);}
  handleOwned(app,job){const role=this.roleForApp(app);if(!role)return false;job.botAppId=app;const dest={...this.destination(app,job.user,job.id,job.chatId),companionTaskId:job.companionTaskId};const input=job.text.trim();
    const commands={'我的任务':'list','任务':'list','/任务':'list','任务看板':'list','助理':'new_task','我的助理':'team','记一下':'capture','/记':'capture','新任务':'new_task','招募助理':'recruit','当前任务':'current','找助理':'secretary','找秘书':'secretary'};
    if(commands[input]){this.persist({id:'message-command:'+job.id,appId:app,operator:job.user,action:commands[input],payload:{},dest,status:'pending'});return true;}
    const retire=input.match(/^解雇\s+(.+)$/);if(retire&&role.id==='assistant'){const target=this.db.roles().find(r=>r.name===retire[1]||r.id===retire[1]);if(target){this.persist({id:'retire-plan:'+job.id,appId:app,operator:job.user,action:'retire_plan',payload:{roleId:target.id},dest,status:'pending'});return true;}}
    const draft=this.db.get('feishu-capture:'+app+':'+job.user);if(draft&&draft.expires>Date.now()){if(input==='取消记录'||input==='取消'){this.persist({id:'capture-cancel:'+job.id,appId:app,operator:job.user,action:'capture_cancel',payload:{},dest,status:'pending'});}else this.persist({id:'capture-append:'+job.id,appId:app,operator:job.user,action:'capture_append',payload:{job},dest,status:'pending'});return true;}
    const intent=taskIntent(input);
    if(intent){
      this.persist({id:'task-find:'+job.id,appId:app,operator:job.user,action:'find_task',payload:intent,dest,status:'pending'});
      return true;
    }
    const newGoal=input.match(/^(?:交代一件事|新任务|换件事)[：:\s]+([\s\S]+)$/)?.[1]?.trim();
    if(newGoal){
      const task=this.engine.enqueue({goal:newGoal,role:role.id,requestId:job.id,replyJob:job});
      this.select(app,task,role.id);
      return true;
    }
    if(input.startsWith('/')||/^新开对话(?:\s|$)/.test(input))return false;
    const current=this.current(app);
    const task=this.engine.enqueue({goal:input,taskId:current?.taskId,role:current?.actorRole??role.id,requestId:job.id,replyJob:job});this.select(app,task,current?.actorRole??role.id);return true;
  }
  async receiveRole(roleId,event){const role=this.engine.roles.get(roleId),client=this.clients.get(role.appId),job=this.normalize(event,client.botId);if(!job||!job.private||job.topicId)return;job.botAppId=role.appId;
    if(!role.ownerOpenId){if(role.pairing?.expires>Date.now()&&hash(job.text.trim())===role.pairing.hash){this.engine.roles.patch(roleId,{ownerOpenId:job.user,pairCode:null,pairing:null,boundAt:Date.now(),platformStatus:role.platformStatus==='binding'?'messaging_ready':role.platformStatus});this.queueCard(this.destination(role.appId,job.user,job.id,job.chatId),receiptCard('已绑定你的独立助理','可以直接交代任务，也能随时回到助理。',[callbackButton('我的任务','list')]),'role-bound:'+job.id);}return;}
    if(job.user!==role.ownerOpenId)return;
    if(['retiring','retired'].includes(role.status)){this.queueCard(this.destination(role.appId,job.user,job.id,job.chatId),receiptCard(role.status==='retired'?'工作已并回助理':'助理正在接回工作','原任务与资料保留。',[linkButton('回到助理','https://applink.feishu.cn/client/bot/open?appId='+this.primaryApp)]),'retired-message:'+job.id);return;}
    if(!this.handleOwned(role.appId,job)){const task=this.engine.enqueue({goal:job.text,role:role.id,requestId:job.id,replyJob:job});this.select(role.appId,task,role.id);}
  }
  taskChanged(taskId,job){if(job?.private&&job.channel!=='local'&&job.user===this.owner(job.botAppId??this.primaryApp)&&!job.companionSuperseded){try{const task=this.db.task(taskId),saved=this.db.get('feishu-current:'+(job.botAppId??this.primaryApp)+':'+job.user);if(task&&(!saved||(job.scopeIntentAt??0)>=(saved.at??0)))this.select(job.botAppId??this.primaryApp,task,job.actorRole??task.role);}catch{}}
    this.dirty.set(taskId,Date.now());}
  async flushDirty(){for(const [taskId,time]of this.dirty){if(Date.now()-time<500)continue;this.dirty.delete(taskId);const task=this.db.task(taskId);if(!task)continue;const rows=this.db.sql.prepare("SELECT key,value FROM kv WHERE key LIKE 'feishu-card:%'").all();for(const row of rows){const issued=JSON.parse(row.value);if((this.roleForApp(issued.appId)?.id!=='assistant'&&this.roleForApp(issued.appId)?.id!==task.role)||issued.taskId!==taskId||issued.createdAt<Date.now()-13*86400000||!this.clients.has(issued.appId))continue;try{await this.sendCard({...this.destination(issued.appId,issued.owner),patchMessageId:issued.messageId},taskCard(task,this.engine.roles),'refresh:'+issued.messageId);}catch(error){this.safeError('card_refresh_failed',error);}}}}
  provision(roleId){const role=this.engine.roles.get(roleId);if(!role||['retired','retiring'].includes(role.status))throw new AppError(404,'找不到活动角色');if(role.configurationStatus==='requires_console')throw new AppError(409,'这只应用的创建渠道不支持自动配置，请在开放平台完成配置或绑定后台创建的应用；现有资料会保留。');if(this.controllers.has(roleId))return {roleId,status:'awaiting_confirmation'};const controller=new AbortController();this.controllers.set(roleId,controller);this.engine.roles.patch(roleId,{registrationMessage:role.registrationStartedAt&&!role.appId?'上次开通结果待核实，可选择已有应用继续':'正在准备飞书确认页面',registrationStartedAt:role.registrationStartedAt??Date.now(),provisionError:null});
    lark.registerApp({source:'companion',...(role.appId?{appId:role.appId}:{createOnly:!role.registrationStartedAt}),signal:controller.signal,appPreset:{name:role.name,desc:role.brief.slice(0,200)},addons:{scopes:{tenant:['im:message:send_as_bot','im:message.p2p_msg:readonly','im:message:readonly','im:resource','application:application:patch']},events:{items:{tenant:['im.message.receive_v1','application.bot.menu_v6']}},callbacks:{items:['card.action.trigger']}},onQRCodeReady:info=>this.engine.roles.patch(roleId,{registrationUrl:info.url,registrationExpires:Date.now()+info.expireIn*1000,registrationMessage:'请用飞书扫码或打开链接确认开通'}),onStatusChange:()=>{}}).then(async result=>{
      if(roleId==='assistant'){this.engine.roles.patch(roleId,{registrationUrl:null,registrationMessage:'增量配置已确认，正在核验连接',provisionError:null});try{await this.configure(this.primary,roleId);}catch(error){this.engine.roles.patch(roleId,{provisionError:'请在开放平台检查菜单、长连接与卡片回调，随后发布生效（'+(error.code??'configuration')+'）'});}return;}
      const appId=result.client_id;if(!/^cli_[a-zA-Z0-9]+$/.test(appId??'')||!result.client_secret)throw new Error('应用创建结果不完整');const secretRef=this.vault.put(appId,result.client_secret);const current=this.engine.roles.get(roleId);if(['retired','retiring'].includes(current?.status)){this.engine.roles.patch(roleId,{appId,secretRef,registrationUrl:null,registrationMessage:'角色已交接，新建平台入口待核验停用。',platformStatus:'disable_pending'});if(current.status==='retired')this.disableRole(roleId).catch(()=>{});return;}const pairCode=randomUUID().slice(0,8);this.engine.roles.patch(roleId,{appId,secretRef,registrationCompletedAt:Date.now(),registrationUrl:null,registrationMessage:null,pairCode,pairing:{hash:hash('绑定 '+pairCode),expires:Date.now()+24*3600000},platformStatus:'binding',launchLink:'https://applink.feishu.cn/client/bot/open?appId='+appId});await this.connectRole(roleId);const client=this.clients.get(appId);try{await this.configure(client,roleId);}catch(error){this.engine.roles.patch(roleId,{provisionError:'应用已创建；部分配置或发布需在开放平台核验（'+(error.code??'configuration')+'）'});}
    }).catch(error=>{if(['retired','retiring'].includes(this.engine.roles.get(roleId)?.status)){this.engine.roles.patch(roleId,{registrationUrl:null,registrationMessage:'角色已交接，开通流程已停止。'});return;}this.engine.roles.patch(roleId,{registrationUrl:null,provisionError:error.code==='access_denied'?'这次开通未确认，可以稍后继续。':'开通尚未完成，可重试（'+(error.code??'network')+'）'});this.safeError('provision_failed',error);}).finally(()=>this.controllers.delete(roleId));return {roleId,status:'preparing'};
  }
  async qr(roleId){const role=this.engine.roles.get(roleId);if(!role?.registrationUrl||role.registrationExpires<Date.now())throw new AppError(404,'确认链接已过期，请重新开通');return QRCode.toBuffer(role.registrationUrl,{type:'png',width:330,margin:2,errorCorrectionLevel:'M'});}
  cancelProvision(roleId){this.controllers.get(roleId)?.abort();}
  async configure(client,roleId){const role=this.engine.roles.get(roleId),appId=role.appId;if(role.configurationStatus==='requires_console')throw new AppError(409,'该应用需要开发者后台配置，不再自动重试');try{
    const menus=roleId==='assistant'?[['list','我的任务'],['capture','记一下'],['new_task','交代一件事']]:[['current','当前任务'],['list','我的任务'],['secretary','找助理']];
    check(await client.client.request({method:'PATCH',url:'/open-apis/application/v7/applications/'+appId+'/ability',data:{bot:{enable:true,bot_menu_enable:true,bot_menu_display_strategy:1,bot_menus:menus.map(([event_key,default_name],i)=>({menu_id:'companion_'+event_key,default_name,sort:i+1,menu_content_type:2,event_key}))}}}));this.engine.roles.patch(roleId,{menuStatus:'configured'});
    check(await client.client.request({method:'PATCH',url:'/open-apis/application/v7/applications/'+appId+'/config',data:{event:{subscription_type:'websocket',add_events:['im.message.receive_v1','application.bot.menu_v6']},callback:{callback_type:'websocket',add_callbacks:['card.action.trigger']}}}));this.engine.roles.patch(roleId,{callbackStatus:'configured'});
    const result=check(await client.client.request({method:'POST',url:'/open-apis/application/v7/applications/'+appId+'/publish',data:{remark:'伴随个人助理：启用机器人消息、菜单与交互卡片。',changelog:'配置长连接消息接收、原生卡片交互与角色入口。',mobile_default_ability:'bot',pc_default_ability:'bot'}}));this.engine.roles.patch(roleId,{configurationStatus:'submitted',platformStatus:'publish_submitted',versionId:result.version_id??null,registrationMessage:'已提交发布，等待平台生效和真实收发核验',provisionError:null});return result;
  }catch(error){error.code=error.response?.data?.code??error.code;const unsupported=[210021,210015,210043,210035,210001].includes(Number(error.code));this.engine.roles.patch(roleId,{configurationStatus:unsupported?'requires_console':'incomplete',provisionError:unsupported?'这只应用的创建渠道不支持自动配置，请在开发者后台完成菜单、回调和发布，或绑定后台创建的应用。':'飞书配置尚未生效，请确认应用配置权限与发布状态（'+(error.code??'network')+'）'});throw error;}}
  async connectRole(roleId){const role=this.engine.roles.get(roleId);if(!role?.appId||!role.secretRef)return;if(this.clients.has(role.appId))return;const client=new this.primary.constructor({appId:role.appId},this.vault.get(role.secretRef));this.quietClient(client);await client.identity();this.remember(client);this.clients.set(role.appId,client);try{await this.startClient(client,role.appId,event=>this.receiveRole(roleId,event));}catch(error){this.clients.delete(role.appId);client.close();throw error;}}
  async bindExisting(roleId,input){if(['retired','retiring'].includes(this.engine.roles.get(roleId)?.status))throw new AppError(409,'角色已停止接单，不能重新绑定');const appId=text(input.appId,100),secret=text(input.secret,200);if(!/^cli_[a-zA-Z0-9]+$/.test(appId)||!secret)throw new AppError(400,'请提供完整的应用信息');if([...this.db.roles()].some(r=>r.appId===appId&&r.id!==roleId))throw new AppError(409,'这只机器人已属于其他角色');if(this.clients.has(appId)&&appId!==this.primaryApp){this.clients.get(appId).close();this.clients.delete(appId);}const secretRef=this.vault.put(appId,secret),pairCode=randomUUID().slice(0,8);this.engine.roles.patch(roleId,{appId,secretRef,ownerOpenId:null,pairCode,pairing:{hash:hash('绑定 '+pairCode),expires:Date.now()+24*3600000},launchLink:'https://applink.feishu.cn/client/bot/open?appId='+appId,platformStatus:'binding'});await this.connectRole(roleId);return {roleId,status:'awaiting_binding'};}
  async disableRole(roleId){
    const role=this.engine.roles.get(roleId);
    if(!role?.appId)return {ok:true,status:'not_bound'};
    if(role.id==='assistant'||role.appId===this.primaryApp||role.status!=='retired')throw new AppError(409,'先完成独立角色的工作交接');
    if(role.platformStatus==='disabled')return {ok:true,status:'disabled'};
    try{
      check(await this.primary.client.request({method:'PUT',url:'/open-apis/application/v6/applications/'+role.appId+'/management',data:{enable:false}}));
      this.clients.get(role.appId)?.close();this.clients.delete(role.appId);
      this.engine.roles.patch(roleId,{platformStatus:'disabled',disableAttemptedAt:Date.now(),disableRetryAt:null,provisionError:null});
      return {ok:true,status:'disabled'};
    }catch(error){
      const code=error.response?.data?.code??error.code;
      const permission=Number.isInteger(Number(code))||[401,403].includes(error.response?.status);
      this.engine.roles.patch(roleId,{platformStatus:'disable_pending',disableAttemptedAt:permission?Date.now():null,
        disableRetryAt:permission?null:Date.now()+60000,
        provisionError:permission?'工作已接回，飞书停用需要应用管理权限。':'工作已接回，飞书连接恢复后会再试停用。'});
      throw error;
    }
  }
  close(){this.closed=true;clearInterval(this.timer);for(const controller of this.controllers.values())controller.abort();for(const [app,client]of this.clients)if(app!==this.primaryApp)client.close();}
}
