import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture} from './helpers.mjs';
import {FeishuRuntime} from '../src/feishu-runtime.mjs';
import {taskCard} from '../src/feishu-cards.mjs';
import {hash} from '../src/util.mjs';

function setup(t){const f=fixture();f.config.feishu.appId='cli_test_primary';const requests=[];f.feishu.config={appId:'cli_test_primary'};f.feishu.ws.start=async()=>{};f.feishu.close=()=>{};const result=async payload=>{requests.push(payload);return {code:0,data:{message_id:'om_'+requests.length}};};f.feishu.client={im:{message:{create:result,reply:result,patch:result}},request:result};const base=Object.fromEntries(['reply','progress','finishProgress','reaction','clearReaction','attachments','deliverArtifact','topicContext'].map(k=>[k,f.feishu[k]]));const runtime=new FeishuRuntime({engine:f.engine,feishu:f.feishu,normalize:()=>null}).install();f.engine.feishuRuntime=runtime;t.after(()=>{runtime.close();f.close();});return {...f,runtime,requests,base};}
function callback(source,name,values={},operator='owner'){return {operator:{open_id:operator},token:randomUUID(),context:{open_message_id:source,open_chat_id:'chat-one'},action:{tag:'button',name,form_value:values}};}
async function form(f,type,options={}){const payload=f.runtime.form(type,'cli_test_primary',options);const button=payload.body.elements.find(e=>e.tag==='form').elements.find(e=>e.form_action_type==='submit');const id=await f.runtime.sendCard(f.runtime.destination('cli_test_primary','owner'),payload,'form-'+randomUUID());return {id,name:button.name,payload};}

test('native form callbacks authenticate issuer and owner and durably dedupe before execution',async t=>{const f=setup(t),native=await form(f,'create_task');const unauthorized=f.runtime.callback('cli_test_primary',callback(native.id,native.name,{content:'bad'},'someone-else'));assert.equal(unauthorized.toast.type,'error');assert.equal(f.db.actions().length,0);const event=callback(native.id,native.name,{content:'real user request'});assert.equal(f.runtime.callback('cli_test_primary',event).toast.type,'success');f.runtime.callback('cli_test_primary',event);await f.runtime.flush();assert.equal(f.store.jobs(['queued']).length,1);const job=f.store.jobs(['queued'])[0];assert.equal(job.sourceMessageId,native.id);assert.notEqual(job.id,native.id);assert.equal(job.botAppId,'cli_test_primary');assert.equal(f.db.tasks().length,1);assert.equal(f.runtime.callback('cli_test_primary',callback(native.id,native.name,{content:'different request'})).toast.type,'error');});
test('task form rejects stale resource versions and does not enqueue another execution',async t=>{const f=setup(t),task=f.db.putTask({id:randomUUID(),title:'stable task',private:true,status:'idle'}),native=await form(f,'supplement',{task});f.db.patchTask(task.id,{actionVersion:task.actionVersion+1});const response=f.runtime.callback('cli_test_primary',callback(native.id,native.name,{content:'stale instruction'}));assert.equal(response.toast.type,'error');assert.match(response.toast.content,/更新/);assert.equal(f.store.jobs(['queued']).length,0);});
test('capture form saves a real capture and no task; only explicit processing enqueues work',async t=>{const f=setup(t);await f.runtime.execute({id:'start-capture',operator:'owner',appId:'cli_test_primary',dest:f.runtime.destination('cli_test_primary'),action:'capture',payload:{}});const draft=f.db.get('feishu-capture:cli_test_primary:owner'),native=await form(f,'capture',{draftId:draft.id});const response=f.runtime.callback('cli_test_primary',callback(native.id,native.name,{content:'saved research material',url:'https://example.com/research'}));assert.equal(response.toast.type,'success');await f.runtime.flush();assert.equal(f.db.captures().length,1);assert.equal(f.db.tasks().length,0);assert.equal(f.db.get('feishu-capture:cli_test_primary:owner'),null);const capture=f.db.captures()[0];await f.runtime.execute({id:'process-capture',operator:'owner',appId:'cli_test_primary',dest:f.runtime.destination('cli_test_primary'),action:'process_capture',payload:{captureId:capture.id}});assert.equal(f.db.tasks().length,1);assert.deepEqual(f.db.tasks()[0].captureIds,[capture.id]);});
test('crash after an enqueue is recovered without creating a second native request',async t=>{const f=setup(t),native=await form(f,'create_task');f.runtime.callback('cli_test_primary',callback(native.id,native.name,{content:'recover after crash'}));await f.runtime.flush();const action=f.db.actions(['done'])[0],jobCount=f.store.jobs(['queued']).length;f.db.putAction({...action,status:'running'});f.runtime.close();Object.assign(f.feishu,f.base);const recovered=new FeishuRuntime({engine:f.engine,feishu:f.feishu,normalize:()=>null}).install();t.after(()=>recovered.close());await recovered.flush();assert.equal(f.store.jobs(['queued']).length,jobCount);assert.equal(f.db.action(action.id).status,'done');});
test('role apps authenticate their own owner identities and never reuse the primary open_id',async t=>{const f=setup(t);f.engine.roles.patch('quant',{appId:'cli_quant',ownerOpenId:'quant-owner',status:'active'});const task=f.db.putTask({id:randomUUID(),title:'quant fact',role:'quant',private:true,status:'idle'});assert.throws(()=>f.runtime.select('cli_quant',{...task,role:'product'},'quant'),/其他角色/);f.runtime.select('cli_quant',task,'quant');assert.equal(f.runtime.current('cli_quant').taskId,task.id);assert.equal(f.runtime.owner('cli_test_primary'),'owner');assert.equal(f.runtime.owner('cli_quant'),'quant-owner');});
test('Card 2 task layout contains native callbacks and marks model completion as pending user confirmation',t=>{const f=setup(t),task=f.db.putTask({id:randomUUID(),title:'task title',private:true,status:'delivered'});const payload=taskCard(task,f.engine.roles);assert.equal(payload.schema,'2.0');assert.equal(payload.config.update_multi,true);assert.match(JSON.stringify(payload),/已有答复/);assert.match(JSON.stringify(payload),/确认完成/);assert.ok(payload.body.elements.length<=5);});
test('replaying a capture-open operation preserves the issued form and draft identity',async t=>{const f=setup(t),action={id:'open-before-crash',operator:'owner',appId:'cli_test_primary',dest:f.runtime.destination('cli_test_primary'),action:'capture',payload:{}};await f.runtime.execute(action);const first=f.db.get('feishu-capture:cli_test_primary:owner');await f.runtime.execute(action);const second=f.db.get('feishu-capture:cli_test_primary:owner');assert.equal(first.id,second.id);const forms=f.db.sql.prepare("SELECT value FROM kv WHERE key LIKE 'feishu-form:%'").all();assert.equal(forms.length,1);assert.equal(JSON.parse(forms[0].value).draftId,first.id);});
test('capture-save recovery finds committed data after its draft was already cleared',async t=>{const f=setup(t);await f.runtime.execute({id:'capture-start',operator:'owner',appId:'cli_test_primary',dest:f.runtime.destination('cli_test_primary'),action:'capture',payload:{}});const draft=f.db.get('feishu-capture:cli_test_primary:owner');const action={id:'saved-before-receipt',operator:'owner',appId:'cli_test_primary',dest:f.runtime.destination('cli_test_primary'),action:'form',payload:{type:'capture',draftId:draft.id,values:{content:'committed before crash'}}};await f.runtime.execute(action);assert.equal(f.db.get('feishu-capture:cli_test_primary:owner'),null);await f.runtime.execute(action);assert.equal(f.db.captures().length,1);assert.equal(f.db.tasks().length,0);});
test('expert summary is delivered by secretary app and keeps expert current conversation intact',async t=>{const f=setup(t);f.engine.roles.patch('quant',{appId:'cli_quant',ownerOpenId:'quant-owner',status:'active'});const task=f.db.putTask({id:randomUUID(),title:'one task',role:'quant',private:true,status:'idle'});f.runtime.select('cli_quant',task,'quant');await f.runtime.execute({id:'summary-from-expert',operator:'quant-owner',appId:'cli_quant',dest:f.runtime.destination('cli_quant','quant-owner','om_expert'),action:'summary',payload:{taskId:task.id}});const job=f.store.jobs(['queued'])[0];assert.equal(job.botAppId,'cli_test_primary');assert.equal(job.user,'owner');assert.equal(job.actorRole,'assistant');assert.equal(job.createNewMessage,true);assert.notEqual(job.sourceMessageId,'om_expert');assert.equal(f.runtime.current('cli_quant').actorRole,'quant');});

test('capture append recovery repairs a receipt lost after the draft transaction',async t=>{const f=setup(t),dest=f.runtime.destination('cli_test_primary');await f.runtime.execute({id:'open-append',operator:'owner',appId:'cli_test_primary',dest,action:'capture',payload:{}});const action={id:'append-crash',operator:'owner',appId:'cli_test_primary',dest,action:'capture_append',payload:{job:{id:'om_append',botAppId:'cli_test_primary',text:'IMPORTANT_CAPTURE_TEXT'}}};const queue=f.runtime.queueCard.bind(f.runtime);let first=true;f.runtime.queueCard=(...args)=>{if(first){first=false;throw new Error('injected crash before receipt');}return queue(...args);};await assert.rejects(()=>f.runtime.execute(action),/injected crash/);await f.runtime.execute(action);const outbox=f.store.db.prepare('SELECT value FROM outbox WHERE id=?').get('companion-card:'+action.id);assert.ok(outbox);assert.match(outbox.value,/IMPORTANT_CAPTURE_TEXT/);assert.equal(f.db.get('feishu-capture:cli_test_primary:owner').text,'IMPORTANT_CAPTURE_TEXT');});

test('binding a bot owner cannot erase an earlier menu or publishing failure',async t=>{const f=setup(t);f.engine.roles.patch('quant',{status:'active',appId:'cli_secondary',platformStatus:'binding',configurationStatus:'requires_console',provisionError:'SOURCE_REQUIRES_CONSOLE',pairing:{hash:hash('绑定 88888888'),expires:Date.now()+60000}});f.runtime.clients.set('cli_secondary',{botId:'secondary',close(){}});f.runtime.normalize=()=>({id:'om_bind',private:true,user:'secondary-owner',text:'绑定 88888888',chatId:'secondary-chat'});await f.runtime.receiveRole('quant',{});const role=f.engine.roles.get('quant');assert.equal(role.ownerOpenId,'secondary-owner');assert.equal(role.provisionError,'SOURCE_REQUIRES_CONSOLE');assert.equal(role.configurationStatus,'requires_console');assert.equal(role.platformStatus,'messaging_ready');});

test('a creation-source restriction is recorded once and prevents repeating unsupported V7 requests',async t=>{const f=setup(t);let calls=0;f.feishu.client.request=async()=>{calls++;return {code:210021,msg:'not created via developer platform'};};await assert.rejects(()=>f.runtime.configure(f.feishu,'assistant'));assert.equal(f.engine.roles.get('assistant').configurationStatus,'requires_console');await assert.rejects(()=>f.runtime.configure(f.feishu,'assistant'),/开发者后台/);assert.equal(calls,1);});

test('real provision completion rejects an app already assigned to another role before saving credentials or configuring it',async t=>{
  const f=setup(t);
  f.engine.roles.patch('product',{status:'active',registrationStartedAt:Date.now()});
  f.engine.roles.patch('quant',{status:'active',appId:'cli_alreadyowned'});
  let credentials=0,configurations=0;
  f.runtime.vault.put=()=>{credentials++;return 'unused';};
  f.runtime.configure=async()=>{configurations++;};
  const originalPrimary={...f.engine.roles.get('assistant')};
  for(const appId of [f.runtime.primaryApp,'cli_alreadyowned']){
    f.runtime.registerApp=async()=>({client_id:appId,client_secret:'synthetic-secret'});
    f.runtime.provision('product');
    await new Promise(resolve=>setImmediate(resolve));
    assert.match(f.engine.roles.get('product').provisionError,/已属于其他角色/);
    assert.equal(f.engine.roles.get('product').appId,undefined);
    assert.equal(f.runtime.controllers.size,0);
  }
  assert.equal(credentials,0);assert.equal(configurations,0);
  assert.deepEqual(f.engine.roles.get('assistant'),originalPrimary);
});

test('provision updates reject a different app and a concurrent role binding',async t=>{
  const f=setup(t);
  f.engine.roles.patch('quant',{status:'active',appId:'cli_expected'});
  let resolveRegistration;
  f.runtime.registerApp=()=>new Promise(resolve=>{resolveRegistration=resolve;});
  f.runtime.provision('quant');
  resolveRegistration({client_id:'cli_different',client_secret:'synthetic-secret'});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.engine.roles.get('quant').appId,'cli_expected');
  assert.match(f.engine.roles.get('quant').provisionError,/开通目标不同/);
  f.engine.roles.patch('product',{status:'active'});
  f.runtime.provision('product');
  f.engine.roles.patch('product',{appId:'cli_boundwhilewaiting'});
  resolveRegistration({client_id:'cli_newregistration',client_secret:'synthetic-secret'});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.engine.roles.get('product').appId,'cli_boundwhilewaiting');
  assert.match(f.engine.roles.get('product').provisionError,/开通目标不同/);
});

test('platform retirement preflights the actual management grant without disabling or disconnecting an app when absent',async t=>{
  const f=setup(t);f.engine.roles.patch('quant',{status:'retired',appId:'cli_quantretired'});
  let writes=0,closed=false;
  f.runtime.clients.set('cli_quantretired',{close(){closed=true;}});
  f.feishu.client.request=async request=>{
    if(request.method==='GET')return {code:0,data:{scopes:[{scope_name:'application:application:patch',grant_status:1},{scope_name:'admin:app.enable:write',grant_status:1,scope_type:'user'}]}};
    writes++;return {code:0,data:{}};
  };
  await assert.rejects(()=>f.runtime.disableRole('quant'),e=>e.code==='app_management_scope_required');
  const role=f.engine.roles.get('quant');
  assert.equal(writes,0);assert.equal(closed,false);
  assert.equal(role.platformStatus,'disable_pending');assert.ok(role.disableAttemptedAt);
  assert.match(role.provisionError,/平台停用尚未完成/);
});

test('numeric temporary platform failures remain retryable and only successful management disconnects the retired app',async t=>{
  const f=setup(t);f.engine.roles.patch('quant',{status:'retired',appId:'cli_quantretired'});
  let writes=0,closed=false;
  f.runtime.clients.set('cli_quantretired',{close(){closed=true;}});
  f.feishu.client.request=async request=>{
    if(request.method==='GET')return {code:0,data:{scopes:[{scope_name:'admin:app.enable:write',grant_status:1}]}};
    assert.equal(request.url,'/open-apis/application/v6/applications/cli_quantretired/management');
    assert.deepEqual(request.data,{enable:false});
    writes++;
    return writes===1?{code:99991400,msg:'synthetic rate limit'}:{code:0,data:{}};
  };
  await assert.rejects(()=>f.runtime.disableRole('quant'));
  const waiting=f.engine.roles.get('quant');
  assert.equal(waiting.disableAttemptedAt,null);assert.ok(waiting.disableRetryAt>Date.now());assert.equal(closed,false);
  await f.runtime.disableRole('quant');
  assert.equal(f.engine.roles.get('quant').platformStatus,'disabled');assert.equal(closed,true);
  assert.equal(f.runtime.clients.has('cli_test_primary'),true);
});

test('retirement moves only the former bot owner private reply destination and preserves session and origin audit',async t=>{
  const f=setup(t);f.engine.roles.patch('quant',{status:'active',appId:'cli_retiring',ownerOpenId:'old-owner'});
  const cases=[['owned',true,true,'old-owner','cli_retiring'],['group',false,false,'old-owner','cli_retiring'],['foreign-owner',true,true,'other','cli_retiring'],['foreign-app',true,true,'old-owner','cli_other']];
  for(const [id,personal,originPrivate,user,app]of cases){
    f.db.putTask({id,title:id,role:'quant',private:personal,status:'idle',threadId:'native-'+id});
    f.db.set('reply-origin:'+id,{id:'logical-'+id,botAppId:app,user,private:originPrivate,channel:'feishu',sourceMessageId:'old-source',chatId:'old-chat',topicId:'old-topic',progressId:'old-progress',patchMessageId:'old-patch',reactionId:'old-reaction'});
  }
  await f.engine.roles.retire('quant');
  const next=f.db.get('reply-origin:owned');
  assert.equal(next.botAppId,f.runtime.primaryApp);assert.equal(next.user,'owner');assert.equal(next.id,'logical-owned');assert.equal(next.createNewMessage,true);
  for(const key of ['sourceMessageId','chatId','topicId','progressId','patchMessageId','reactionId'])assert.ok(next[key]==null,key);
  assert.equal(f.db.get('retired-reply-origin:quant:owned').chatId,'old-chat');
  assert.equal(f.db.task('owned').role,'assistant');assert.equal(f.db.session('owned','quant').threadId,'native-owned');
  for(const [id]of cases.slice(1))assert.equal(f.db.get('reply-origin:'+id).sourceMessageId,'old-source');
  f.engine.enqueue({taskId:'owned',goal:'continue after retirement',requestId:'new-continuation'});
  const subscribers=f.db.get('subscribers:companion-'+hash('new-continuation').slice(0,32));
  assert.equal(subscribers.length,1);assert.equal(subscribers[0].botAppId,f.runtime.primaryApp);assert.equal(subscribers[0].user,'owner');
});

test('retirement with a private bot destination waits for a bound primary owner without partially moving the task',async t=>{
  const f=setup(t);f.config.feishu.ownerOpenId=null;f.store.set('owner',null);
  f.engine.roles.patch('quant',{status:'active',appId:'cli_retiring',ownerOpenId:'old-owner'});
  f.db.putTask({id:'unbound',role:'quant',private:true,status:'idle'});
  f.db.set('reply-origin:unbound',{id:'logical',botAppId:'cli_retiring',user:'old-owner',private:true,channel:'feishu'});
  await assert.rejects(()=>f.engine.roles.retire('quant'),/先绑定助理/);
  assert.equal(f.db.task('unbound').role,'quant');assert.equal(f.db.get('reply-origin:unbound').botAppId,'cli_retiring');
});

test('platform stop waits for all unsent old bot deliveries including future retries',async t=>{
  const f=setup(t);f.engine.roles.patch('quant',{status:'retired',appId:'cli_waiting'});
  let closed=false;f.runtime.clients.set('cli_waiting',{close(){closed=true;}});
  f.store.emit('deferred-file',{job:{botAppId:'cli_waiting'},artifact:'synthetic.html',retryAt:Date.now()+300000});
  assert.equal(f.store.pending().length,0);
  await assert.rejects(()=>f.runtime.disableRole('quant'),e=>e.code==='outbox_pending');
  assert.equal(f.requests.length,0);assert.equal(closed,false);
  assert.throws(()=>f.runtime.confirmConsoleDisabled('quant',{appId:'cli_waiting',confirmed:true}),e=>e.code==='outbox_pending');
  assert.equal(closed,false);f.store.sent('deferred-file');
  f.db.set('subscribers:old-local-job',[{botAppId:'cli_waiting',user:'old-owner'}]);
  f.store.emit('local-before-relay',{job:{id:'old-local-job',channel:'local'},artifact:'synthetic.html',retryAt:Date.now()+300000});
  await assert.rejects(()=>f.runtime.disableRole('quant'),e=>e.code==='outbox_pending');
  assert.equal(closed,false);f.store.sent('local-before-relay');
  assert.equal(f.runtime.confirmConsoleDisabled('quant',{appId:'cli_waiting',confirmed:true}).status,'disabled_console_confirmed');
  assert.equal(closed,true);
});

test('console stop attestations require a retired distinct app and explicitly distinguish manual evidence from API confirmation',t=>{
  const f=setup(t);f.engine.roles.patch('quant',{status:'active',appId:'cli_manual'});
  assert.throws(()=>f.runtime.confirmConsoleDisabled('assistant',{appId:f.runtime.primaryApp,confirmed:true}),/先完成/);
  assert.throws(()=>f.runtime.confirmConsoleDisabled('quant',{appId:'cli_manual',confirmed:true}),/先完成/);
  f.engine.roles.patch('quant',{status:'retired'});
  assert.throws(()=>f.runtime.confirmConsoleDisabled('quant',{appId:'cli_wrong',confirmed:true}),/同一应用/);
  assert.throws(()=>f.runtime.confirmConsoleDisabled('quant',{appId:'cli_manual'}),/同一应用/);
  f.runtime.confirmConsoleDisabled('quant',{appId:'cli_manual',confirmed:true});
  const role=f.engine.roles.get('quant');assert.equal(role.platformStatus,'disabled_console_confirmed');assert.equal(role.platformVerifiedVia,'console_confirmation');assert.ok(role.platformConfirmedAt);
  assert.equal(f.runtime.clients.has(f.runtime.primaryApp),true);assert.equal(f.requests.length,0);
});

test('accepted actions drain before stopping and new retired-bot callbacks or shutdown messages cannot add a late delivery',async t=>{
  const f=setup(t);f.engine.roles.patch('quant',{status:'retired',appId:'cli_stopping',ownerOpenId:'old-owner'});
  f.runtime.clients.set('cli_stopping',{botId:'bot-old',close(){}});
  f.db.putAction({id:'already-accepted',appId:'cli_stopping',status:'running'});
  await assert.rejects(()=>f.runtime.disableRole('quant'),e=>e.code==='outbox_pending');
  f.db.putAction({id:'already-accepted',appId:'cli_stopping',status:'done'});
  let grantScopes,completeStop;
  f.feishu.client.request=async request=>request.method==='GET'?new Promise(resolve=>{grantScopes=resolve;}):new Promise(resolve=>{completeStop=resolve;});
  const stopping=f.runtime.disableRole('quant');await new Promise(resolve=>setImmediate(resolve));
  await assert.rejects(()=>f.runtime.disableRole('quant'),/正在停用/);
  assert.throws(()=>f.runtime.confirmConsoleDisabled('quant',{appId:'cli_stopping',confirmed:true}),/正在停用/);
  grantScopes({code:0,data:{scopes:[{scope_name:'admin:app.enable:write',grant_status:1}]}});await new Promise(resolve=>setImmediate(resolve));
  const before=f.store.db.prepare('SELECT COUNT(*) AS n FROM outbox').get().n;
  f.runtime.normalize=()=>({id:'late-message',private:true,user:'old-owner',text:'hello'});
  await f.runtime.receiveRole('quant',{});
  f.runtime.menu('cli_stopping',{operator:{open_id:'old-owner'},event_key:'list'});
  assert.equal(f.runtime.callback('cli_stopping',callback('old-card','list',{},'old-owner')).toast.type,'error');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM outbox').get().n,before);assert.equal(f.db.actions(['pending','running']).length,0);
  completeStop({code:0,data:{}});await stopping;
  assert.equal(f.engine.roles.get('quant').platformStatus,'disabled');
  await f.runtime.receiveRole('quant',{});
});

test('a connected independent app can be configured directly while retired and conflicting apps cannot',async t=>{
  const f=setup(t),client={synthetic:true,close(){}};
  f.engine.roles.patch('quant',{status:'active',appId:'cli_independent'});
  f.runtime.clients.set('cli_independent',client);
  f.runtime.connectRole=async()=>{};
  let calls=0;
  f.runtime.configure=async(actual,roleId)=>{assert.equal(actual,client);assert.equal(roleId,'quant');calls++;return {submitted:true};};
  await f.runtime.configureRole('quant');assert.equal(calls,1);
  f.engine.roles.patch('quant',{status:'retired'});
  await assert.rejects(()=>f.runtime.configureRole('quant'),/活动角色/);
  f.engine.roles.patch('product',{status:'active',appId:f.runtime.primaryApp});
  await assert.rejects(()=>f.runtime.configureRole('product'),e=>e.code==='application_conflict');
  assert.equal(calls,1);
});

test('binding replacement credentials clears verification from the previous app even when reconnecting is temporarily unavailable',async t=>{
  const f=setup(t);
  f.engine.roles.patch('quant',{status:'active',appId:'cli_oldconnection',configurationStatus:'requires_console',menuStatus:'configured',callbackStatus:'verified',provisionError:'old app error'});
  f.db.set('feishu-check-role:quant','old-check');f.db.set('feishu-check:old-check',{status:'verified'});
  f.runtime.vault.put=()=> 'synthetic-ref';
  f.runtime.connectRole=async()=>{throw new Error('synthetic network outage');};
  await assert.rejects(()=>f.runtime.bindExisting('quant',{appId:'cli_newconnection',secret:'synthetic-secret'}),/network outage/);
  const role=f.engine.roles.get('quant');
  assert.equal(role.appId,'cli_newconnection');assert.equal(role.configurationStatus,'incomplete');
  assert.equal(role.provisionError,null);assert.equal(role.menuStatus,null);assert.equal(role.callbackStatus,null);
  assert.equal(f.runtime.checkStatus('quant'),null);assert.equal(role.platformStatus,'binding');
});

test('menu parameters rejected by the platform do not block messaging configuration or falsely claim menus are ready',async t=>{
  const f=setup(t);f.engine.roles.patch('quant',{status:'active',appId:'cli_independent'});
  const calls=[];
  f.feishu.client.request=async request=>{
    calls.push(request);
    return request.data?.bot?.bot_menu_enable?{code:210011,msg:'synthetic invalid menu request'}:{code:0,data:{version_id:'synthetic-version'}};
  };
  await f.runtime.configure(f.feishu,'quant');
  const role=f.engine.roles.get('quant');
  assert.equal(role.menuStatus,'requires_console');assert.match(role.menuWarning,/未通过平台校验/);
  assert.equal(role.configurationStatus,'submitted');assert.equal(role.callbackStatus,'configured');
  assert.ok(calls.some(c=>c.data?.bot&&Object.keys(c.data.bot).length===1));
  assert.ok(calls.some(c=>c.url.endsWith('/config')));assert.ok(calls.some(c=>c.url.endsWith('/publish')));
  await f.runtime.configure(f.feishu,'quant');
  assert.equal(calls.filter(c=>c.data?.bot?.bot_menu_enable).length,1);
});

test('business completion and ownership changes refresh an existing secretary progress card',async t=>{const f=setup(t),task=f.db.putTask({id:randomUUID(),title:'state synchronization',private:true,status:'delivered'}),messageId=await f.runtime.sendCard({...f.runtime.destination('cli_test_primary'),companionTaskId:task.id},taskCard(task,f.engine.roles),'initial-state-card');await f.engine.setTaskState(task.id,'completed');f.runtime.dirty.set(task.id,Date.now()-1000);await f.runtime.flushDirty();let last=f.requests.at(-1);assert.equal(last.path.message_id,messageId);assert.match(last.data.content,/已完成/);await f.engine.roles.handoff(task.id,'life');f.runtime.dirty.set(task.id,Date.now()-1000);await f.runtime.flushDirty();last=f.requests.at(-1);assert.equal(last.path.message_id,messageId);assert.match(last.data.content,/生活助理/);assert.match(last.data.content,/已完成/);});

test('Feishu staffing approval is bound to the original card and idempotent with the workbench',async t=>{
  const f=setup(t);
  const task=f.db.putTask({id:randomUUID(),title:'ongoing reading',private:true,status:'idle'});
  const p=f.engine.roles.propose({name:'阅读协作者',brief:'整理长期阅读笔记',reason:'重复发生的资料整理'},task.id);
  const dest=f.runtime.destination('cli_test_primary');
  const source=await f.runtime.sendCard({...dest,staffingProposalId:p.id},null,'real-shape-decision');
  const issued=JSON.parse(f.requests.at(-1).data.content);
  assert.match(JSON.stringify(issued),/同意招募/);
  const confirm={operator:{open_id:'owner'},token:'owner-approval',context:{open_message_id:source,open_chat_id:'chat-one'},
    action:{value:{action:'staffing_decision',proposalId:p.id,decision:'approve'}}};
  const other=await f.runtime.sendCard(dest,taskCard(task,f.engine.roles),'unrelated');
  assert.equal(f.runtime.callback('cli_test_primary',{...confirm,context:{open_message_id:other}}).toast.type,'error');
  assert.equal(f.runtime.callback('cli_test_primary',{...confirm,operator:{open_id:'stranger'}}).toast.type,'error');
  const web=f.engine.roles.decide(p.id,'approve');
  assert.equal(f.runtime.callback('cli_test_primary',confirm).toast.type,'success');
  f.runtime.callback('cli_test_primary',confirm);
  await f.runtime.flush();
  const roles=f.db.roles().filter(r=>r.name==='阅读协作者');
  assert.equal(roles.length,1);
  assert.equal(roles[0].id,web.resultRoleId);
  assert.equal(roles[0].appId,undefined);
  const update=f.store.db.prepare("SELECT value FROM outbox WHERE id LIKE 'companion-card:staffing:%'").all();
  assert.equal(update.length,1);
  const patched=JSON.parse(update[0].value).job;
  assert.equal(patched.patchMessageId,source);
  await f.runtime.sendCard(patched,patched.cardPayload,'decision-update');
  assert.doesNotMatch(f.requests.at(-1).data.content,/同意招募/);
});

test('automatic artifact relays dedupe within the same user request and keep later explicit deliveries',async t=>{
  const f=setup(t);
  const {writeFileSync,readFileSync}=await import('node:fs');
  const {join}=await import('node:path');
  const task=f.db.putTask({id:randomUUID(),private:true,cwd:f.dataDir,title:'same result'});
  const file=join(f.dataDir,'result.html');
  writeFileSync(file,'<p>ONE_IMMUTABLE_RESULT</p>');
  const dest={...f.runtime.destination('cli_test_primary','owner','om_origin','chat-one'),
    companionTaskId:task.id,companionDeliveryId:'one-user-request',companionUtility:false,cwd:f.dataDir};
  await Promise.all([
    f.feishu.deliverArtifact({...dest,id:'job-one'},file,'outbox-one'),
    f.feishu.deliverArtifact({...dest,id:'job-two'},file,'outbox-two')
  ]);
  let deliveries=f.calls.filter(c=>c.name==='deliverArtifact');
  assert.equal(deliveries.length,1);
  assert.equal(readFileSync(deliveries[0].args[1],'utf8'),'<p>ONE_IMMUTABLE_RESULT</p>');
  assert.notEqual(deliveries[0].args[1],file);
  await f.feishu.deliverArtifact({...dest,id:'job-three'},file,'outbox-three');
  assert.equal(f.calls.filter(c=>c.name==='deliverArtifact').length,1);
  await f.feishu.deliverArtifact({...dest,id:'later',companionDeliveryId:'later-user-request'},file,'later-outbox');
  assert.equal(f.calls.filter(c=>c.name==='deliverArtifact').length,2);
  writeFileSync(file,'<p>NEW_RESULT_VERSION</p>');
  await f.feishu.deliverArtifact(dest,file,'new-version-outbox');
  assert.equal(f.calls.filter(c=>c.name==='deliverArtifact').length,3);
  await f.feishu.deliverArtifact({...dest,companionUtility:true},file,'manual-resend-outbox');
  assert.equal(f.calls.filter(c=>c.name==='deliverArtifact').length,4);
});

test('artifact retry keeps its persisted bytes and delivery key after a lost receipt and source deletion',async t=>{
  const f=setup(t);
  const {writeFileSync,readFileSync,unlinkSync}=await import('node:fs');
  const {join}=await import('node:path');
  const task=f.db.putTask({id:randomUUID(),private:true,cwd:f.dataDir,title:'retry result'});
  const file=join(f.dataDir,'retry.html');
  writeFileSync(file,'VERSION_ONE');
  const job={...f.runtime.destination('cli_test_primary','owner','om_origin','chat-one'),id:'one-job',
    companionTaskId:task.id,companionDeliveryId:'one-user-request',companionUtility:false,cwd:f.dataDir};
  const attempts=[];
  const send=async(wire,snapshot,key)=>{attempts.push({bytes:readFileSync(snapshot,'utf8'),key});if(attempts.length===1)throw new Error('lost receipt');};
  await assert.rejects(()=>f.runtime.deliverUnique(job,file,send,'one-outbox'),/lost receipt/);
  writeFileSync(file,'VERSION_TWO');
  unlinkSync(file);
  f.runtime.close();
  const restarted=new FeishuRuntime({engine:f.engine,feishu:f.feishu,normalize:()=>null});
  t.after(()=>restarted.close());
  await restarted.deliverUnique(job,file,send,'one-outbox');
  await restarted.deliverUnique(job,file,send,'one-outbox');
  assert.equal(attempts.length,2);
  assert.deepEqual(attempts.map(a=>a.bytes),['VERSION_ONE','VERSION_ONE']);
  assert.equal(attempts[0].key,attempts[1].key);
});

test('a partial staged artifact is repaired before first delivery and is never sent on retry',async t=>{
  const f=setup(t);
  const {mkdirSync,writeFileSync,readFileSync}=await import('node:fs');
  const {join}=await import('node:path');
  const task=f.db.putTask({id:randomUUID(),private:true,cwd:f.dataDir,title:'staged result'});
  const file=join(f.dataDir,'staged.html'),bytes='COMPLETE_VERSION';
  const directory=join(f.dataDir,'artifacts',task.id,'delivery',hash(bytes)),snapshot=join(directory,'staged.html');
  mkdirSync(directory,{recursive:true});writeFileSync(snapshot,'PARTIAL');writeFileSync(file,bytes);
  const job={...f.runtime.destination('cli_test_primary','owner','om_origin','chat-one'),id:'staged-job',
    companionTaskId:task.id,companionDeliveryId:'one-user-request',companionUtility:false,cwd:f.dataDir};
  let attempts=0;
  const send=async(wire,path)=>{attempts++;assert.equal(readFileSync(path,'utf8'),bytes);throw new Error('offline');};
  await assert.rejects(()=>f.runtime.deliverUnique(job,file,send,'staged-outbox'),/offline/);
  writeFileSync(snapshot,'PARTIAL_AGAIN');
  await assert.rejects(()=>f.runtime.deliverUnique(job,file,send,'staged-outbox'),/成果快照暂不可用/);
  assert.equal(attempts,1);
});

test('continue card selection replies with a toast and keeps the exact task without sending another card',async t=>{
  const f=setup(t);
  const task=f.db.putTask({id:randomUUID(),title:'已在飞书的任务',private:true,status:'idle'});
  const dest={...f.runtime.destination('cli_test_primary'),companionTaskId:task.id};
  const source=await f.runtime.sendCard(dest,taskCard(task,f.engine.roles),'continue-card');
  const event={operator:{open_id:'owner'},token:'continue-this',context:{open_message_id:source},
    action:{value:{action:'continue_task',taskId:task.id}}};
  assert.match(f.runtime.callback('cli_test_primary',event).toast.content,/直接发补充/);
  assert.equal(f.runtime.current('cli_test_primary').taskId,task.id);
  assert.equal(f.db.actions(['done']).length,1);
  assert.equal(f.store.db.prepare('SELECT count(*) AS count FROM outbox').get().count,0);
  const forged={...event,token:'different-target',action:{value:{action:'continue_task',taskId:randomUUID()}}};
  assert.equal(f.runtime.callback('cli_test_primary',forged).toast.type,'error');
});

test('after choosing a task, continue this task goes to that conversation rather than a historical search',async t=>{
  const f=setup(t);
  const task=f.db.putTask({id:randomUUID(),title:'chosen task',private:true,status:'idle',threadId:'native-chosen'});
  f.runtime.select('cli_test_primary',task,'assistant');
  for(const phrase of ['继续这个任务，补上结果','接着这件事：更新原来的 HTML','继续当前任务，保留391']){
    const id=randomUUID(),job={id,text:phrase,private:true,user:'owner',chatId:'chat-one',scope:'feishu:owner',message:{create_time:String(Date.now())}};
    assert.equal(f.runtime.handleOwned('cli_test_primary',job),true);
    const queued=JSON.parse(f.store.db.prepare('SELECT value FROM jobs WHERE id=?').get(id).value);
    assert.equal(queued.companionTaskId,task.id);
    assert.equal(queued.text,phrase);
  }
  assert.equal(f.db.tasks().length,1);
  assert.equal(f.db.actions().length,0);
});

test('an old Feishu recruit form uses the stored approval and an assign form needs no content field',async t=>{
  const f=setup(t);
  const task=f.db.putTask({id:randomUUID(),title:'老版任务',private:true,status:'idle'});
  const p=f.engine.roles.propose({name:'长期阅读',brief:'以原提案职责为准',reason:'持续整理阅读'},task.id);
  const old=await form(f,'recruit',{role:p,proposalId:p.id});
  const confirm=callback(old.id,old.name,{name:'不同名字',brief:'不同职责'});
  assert.equal(f.runtime.callback('cli_test_primary',confirm).toast.type,'success');
  await f.runtime.flush();
  const accepted=f.engine.roles.proposal(p.id);
  assert.equal(f.db.role(accepted.resultRoleId).name,p.name);
  assert.equal(f.db.role(accepted.resultRoleId).brief,p.brief);
  const assign=await form(f,'assign',{task});
  assert.equal(f.runtime.callback('cli_test_primary',callback(assign.id,assign.name,{roleId:accepted.resultRoleId})).toast.type,'success');
  await f.runtime.flush();
  assert.equal(f.db.task(task.id).role,accepted.resultRoleId);
});

test('personal Feishu lookup and direct continuation keep the archived task ID and avoid group results',async t=>{
  const f=setup(t);
  const userTask=f.db.putTask({id:randomUUID(),title:'旧低换手报告',status:'delivered',private:true,archived:true,createdAt:Date.now()});
  f.db.putTask({id:randomUUID(),title:'旧低换手报告',status:'delivered',private:false,createdAt:Date.now()});
  const job={id:'om_user_find',user:'owner',private:true,text:'找今天那个旧低换手报告',chatId:'chat-one'};
  assert.ok(f.runtime.handleOwned('cli_test_primary',job));
  await f.runtime.flush();
  const search=JSON.parse(f.store.db.prepare("SELECT value FROM outbox WHERE id=?").get('companion-card:task-find:om_user_find').value).job.cardPayload;
  assert.equal(JSON.stringify(search).split(userTask.id).length-1,2);
  assert.equal(f.store.jobs(['queued']).length,0);
  assert.ok(f.runtime.handleOwned('cli_test_primary',{...job,id:'om_user_continue',text:'继续今天那个旧低换手报告，增加交易成本说明'}));
  await f.runtime.flush();
  assert.equal(f.store.jobs(['queued'])[0].companionTaskId,userTask.id);
  assert.equal(f.db.task(userTask.id).archived,false);
  assert.equal(f.db.task(userTask.id).lastRequest,'增加交易成本说明');
});
