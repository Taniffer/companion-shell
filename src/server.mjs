import http from 'node:http';
import https from 'node:https';
import { readFileSync,writeFileSync,existsSync,mkdirSync,createReadStream } from 'node:fs';
import { join,extname,basename } from 'node:path';
import { networkInterfaces } from 'node:os';
import { randomUUID } from 'node:crypto';
import { AppError,hash,equal,token,text,validFile,publicError } from './util.mjs';
import { certificate } from './certificate.mjs';
import { Captures } from './captures.mjs';
import { exportData } from './export.mjs';
import {taskBucket,taskLabel} from './task-state.mjs';
import {taskMemories,recentWork} from './task-context.mjs';
import {findTasks,taskIntent} from './task-search.mjs';

const VERSION=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')).version;

const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.ico':'image/x-icon','.png':'image/png','.jpg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.json':'application/json','.svg':'image/svg+xml'};
function body(req,limit=24*1024*1024){return new Promise((resolve,reject)=>{let size=0,chunks=[];req.on('data',chunk=>{size+=chunk.length;if(size>limit){reject(new AppError(413,'内容过大'));req.destroy();}else chunks.push(chunk);});req.on('end',()=>{try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}'));}catch{reject(new AppError(400,'请求内容格式不正确'));}});req.on('error',reject);});}
function send(res,value,status=200){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));}
export function addresses(){const result=[];for(const [name,items]of Object.entries(networkInterfaces())){if(/mihomo|clash|cfw|vbox|vmware|wsl/i.test(name))continue;for(const item of items??[])if(item.family==='IPv4'&&!item.internal&&!item.address.startsWith('169.254.')&&!item.address.startsWith('198.18.'))result.push({name,address:item.address,privateNetwork:/tailscale/i.test(name)});}return result;}
export async function startServer({engine,db,root,dataDir,uiPort=47471,mobilePort=47472,mobileHost='0.0.0.0',log=()=>{},tls}){
  mkdirSync(dataDir,{recursive:true});const keyPath=join(dataDir,'admin.key');if(!existsSync(keyPath))writeFileSync(keyPath,token(),{mode:0o600});const adminKey=readFileSync(keyPath,'utf8').trim();
  const sessions=new Map(),attempts=new Map();const captures=new Captures(db,dataDir);engine.captures=captures;
  const uiOrigin=()=>`http://127.0.0.1:${local.address().port}`;
  const auth=(req)=>{const bearer=req.headers.authorization?.replace(/^Bearer /,'');if(bearer&&equal(bearer,adminKey))return true;const cookie=req.headers.cookie?.match(/(?:^|;\s*)companion_session=([^;]+)/)?.[1];const until=sessions.get(cookie);if(!until||until<Date.now())return false;return true;};
  const checkOrigin=req=>{if(req.headers.origin&&req.headers.origin!==uiOrigin())throw new AppError(403,'请从本机工作台操作');};
  const markSession=res=>{const id=token();sessions.set(id,Date.now()+7*86400000);if(sessions.size>100)sessions.delete(sessions.keys().next().value);res.setHeader('Set-Cookie',`companion_session=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800`);};
  const createPairing=address=>{address=address??addresses().find(a=>!a.privateNetwork)?.address??'127.0.0.1';if(!addresses().some(a=>a.address===address)&&address!=='127.0.0.1')throw new AppError(400,'请选择这台电脑现有的网络地址');const ticket=token(),expires=Date.now()+10*60000;db.set('pairing',{hash:hash(ticket),expires});const params=new URLSearchParams({v:'1',url:`https://${address}:${mobile.address().port}`,pin:tlsInfo.pin,ticket});return {code:`companion://pair?${params}`,expires,address};};
  const privateHandler=async(req,res)=>{
    try{
      if(!['127.0.0.1','localhost'].includes((req.headers.host??'').split(':')[0]))throw new AppError(403,'工作台只接受本机地址');
      const url=new URL(req.url,uiOrigin()),path=url.pathname;
      if(req.method==='POST'&&path==='/api/session'){checkOrigin(req);if(!equal(req.headers.authorization?.replace(/^Bearer /,''),adminKey))throw new AppError(401,'请从启动入口重新打开工作台');markSession(res);send(res,{ok:true});return;}
      if(path==='/api/health'){send(res,{ok:true,service:'companion-workbench',version:VERSION});return;}
      if(path.startsWith('/api/agent/')){
        checkOrigin(req);
        const credential=req.headers.authorization?.replace(/^Bearer /,'')??'',actorId=credential.split('.')[0];
        const actor=db.task(actorId),actorRole=credential.split('.').length>=3?credential.split('.')[1]:actor?.role,stored=db.get(`capability:${actorId}`+(credential.split('.').length>=3?':'+actorRole:''));
        if(!actor||!stored||!equal(hash(credential),stored)||db.get(`capability:${actorId}`+(credential.split('.').length>=3?':'+actorRole:'')+':generation')!==(actor.ownerGeneration??1))throw new AppError(401,'本次事项的工作凭证无效');
        const roleStatus=engine.roles.get(actorRole)?.status;
        const inFlight=()=>engine.store.jobs(['dispatching','pendingThread','running','finishing']).some(j=>j.actorRole===actorRole&&j.companionTaskId===actor.id);
        if(!roleStatus||roleStatus==='retired'||(roleStatus==='retiring'&&!inFlight())||(actorRole!=='assistant'&&actorRole!==actor.role&&!inFlight()))throw new AppError(401,'本次事项的工作凭证无效');
        const canPlanStaffing=actorRole==='assistant'&&!actor.parentId&&actor.private===true;
        if(path==='/api/agent/context'&&req.method==='GET'){
          const query=url.searchParams.get('q')??'';
          const terms=query.trim().toLowerCase().split(/\s+/).filter(Boolean).slice(0,12);
          const selected=(actor.parentId||actorRole!=='assistant')?engine.captureIdsFor(actor,actorRole).map(id=>db.capture(id)).filter(c=>c&&terms.every(term=>`${c.text??''} ${c.title??''} ${c.url??''}`.toLowerCase().includes(term))).map(({contentHash,...c})=>c):db.captures(query,20);
          send(res,{captures:actor.private===true?selected:[],memories:taskMemories(db,actor,actorRole,query)});return;
        }
        if(path==='/api/agent/state'&&req.method==='POST'){const input=await body(req,10000);if(!['open','waiting_user'].includes(input.businessState))throw new AppError(400,'工作接口只可标记等待补充或继续推进；完成由用户确认');const effectKey=input.requestId?'agent-state:'+actor.id+':'+input.requestId:null,prior=effectKey?db.get(effectKey):null;if(prior){send(res,prior);return;}const result=db.transaction(()=>{const task=db.patchTask(actor.id,{businessState:input.businessState,waitingReason:text(input.reason,1000),actionVersion:(actor.actionVersion??1)+1}),result={taskId:task.id,businessState:task.businessState};if(effectKey)db.set(effectKey,result);return result;});engine.feishuRuntime?.taskChanged(actor.id);send(res,result);return;}
        if(path==='/api/agent/roles'&&req.method==='GET'){
          if(!canPlanStaffing)throw new AppError(403,'长期分工由个人助理安排');
          const roles=db.roles().map(({id,name,brief,status})=>({id,name,brief:brief.slice(0,350),status}));
          const proposals=engine.roles.proposals().slice(-8).map(({id,kind,name,roleId,status,resultRoleId})=>({id,kind,name,roleId,status,resultRoleId}));
          send(res,{roles,proposals,recentWork:recentWork(db,actor.id)});return;
        }
        if(path==='/api/agent/roles/propose'&&req.method==='POST'){
          if(!canPlanStaffing)throw new AppError(403,'请由个人助理提出长期分工建议');
          const proposal=engine.roles.propose(await body(req,20000),actor.id);
          if(proposal.status==='pending')engine.feishuRuntime?.notifyProposal(proposal);
          send(res,{proposal,requiresUserDecision:proposal.status==='pending'});return;
        }
        const targetMatch=path.match(/^\/api\/agent\/tasks\/([0-9a-f-]+)$/i);
        if(targetMatch&&req.method==='GET'){
          const target=db.task(targetMatch[1]);
          if(!target||(target.id!==actor.id&&(actorRole!=='assistant'||target.parentId!==actor.id)))throw new AppError(403,'只能查看本次事项及其专业子事项');
          if(target.id===actor.id){
            const own=await engine.refreshTask(target.id,false,actorRole);
            send(res,{task:{id:own.id,title:own.title,role:actorRole,parentId:own.parentId,status:own.status,
              businessState:own.businessState,messages:own.messages,
              artifacts:actorRole==='assistant'?own.artifacts:db.artifacts(own.id),
              children:actorRole==='assistant'?own.children.map(({id,title,role,status})=>({id,title,role,status})):[]}
            });return;
          }
          const {id,title,role,status,summary,businessState}=target;
          send(res,{task:{id,title,role,status,summary,businessState,artifacts:db.artifacts(id)}});return;
        }
        if(path==='/api/agent/delegate'&&req.method==='POST'){
          if(actor.parentId||actorRole!=='assistant')throw new AppError(403,'专业子事项不再转包');
          const input=await body(req,100000);if(!engine.roles.get(input.role)||input.role==='assistant')throw new AppError(400,'请选择适合这件事的专业协作者');
          const captureIds=input.captureIds??[];
          const allowed=new Set(engine.captureIdsFor(actor,actorRole));
          if(!Array.isArray(captureIds)||captureIds.some(id=>!allowed.has(id)))throw new AppError(403,'只能分派这项任务已关联的资料');
          const task=engine.enqueue({goal:input.goal,title:input.title,role:input.role,parentId:actor.id,captureIds,requestId:`agent:${actor.id}:${input.requestId??randomUUID()}`});send(res,{task,asynchronous:true,next:'结束本轮后继续等专业结果，助理会自动整合。'},202);return;
        }
        throw new AppError(404,'找不到这项工作接口');
      }
      if(path.startsWith('/api/')){
        if(!auth(req))throw new AppError(401,'请从“启动伴随”重新打开工作台');
        checkOrigin(req);
        if(!['GET','HEAD'].includes(req.method)&&req.headers['x-companion']!=='1'&&!req.headers.authorization)throw new AppError(403,'缺少操作标记');
        if(req.method==='GET'&&path==='/api/overview'){
          let warning='';try{await engine.importThreads();}catch(error){warning='暂时未连上 Codex，仍可登记资料。';log('desktop_import_error',{message:error.message});}
          const bridgeStatus=engine.status?.()??{};send(res,{tasks:db.tasks(),captureCount:db.sql.prepare('SELECT count(*) AS n FROM captures').get().n,devices:db.devices(),warning,bridge:bridgeStatus,roles:engine.roles.list(),roleProposals:engine.roles.staffingCards(),addresses:addresses(),uiPort:local.address().port,mobilePort:mobile.address().port});return;
        }
        if(req.method==='GET'&&path==='/api/board'){
          const options={query:(url.searchParams.get('q')??'').slice(0,300),role:url.searchParams.get('role')??'all',includeImported:url.searchParams.get('includeChats')==='1',archived:url.searchParams.get('archived')==='1'};
          const rootOnly=url.searchParams.get('groupChildren')==='1'&&options.role==='all';
          const columns={};for(const bucket of ['running','unfinished','completed'])columns[bucket]=db.boardTasks({...options,rootOnly,bucket,limit:Math.min(1000,Math.max(20,Number(url.searchParams.get(bucket+'Limit'))||20)),offset:Math.max(0,Number(url.searchParams.get(bucket+'Offset'))||0)});
          send(res,{columns,allCounts:db.boardCounts({...options,role:'all',rootOnly}),counts:db.boardCounts({...options,rootOnly}),roles:engine.roles.list().map(r=>({...r,counts:db.boardCounts({...options,role:r.id})})),updatedAt:Date.now()});return;
        }
        if(req.method==='GET'&&path==='/api/roles'){send(res,{roles:engine.roles.list()});return;}
        if(req.method==='GET'&&path==='/api/task-find'){
          send(res,findTasks(db,url.searchParams.get('q'),{
            role:url.searchParams.get('role')??'all',includeImported:url.searchParams.get('includeChats')==='1'
          }));return;
        }
        if(req.method==='POST'&&path==='/api/roles'){
          const input=await body(req,10000);
          if(input.proposalId){
            if(engine.roles.proposal(input.proposalId).kind!=='recruit')throw new AppError(400,'这项安排不是招募');
            const proposal=engine.roles.decide(input.proposalId,'approve');
            send(res,{proposal,role:proposal.resultRoleId?engine.roles.get(proposal.resultRoleId):null},201);return;
          }
          send(res,{role:engine.roles.create(input)},201);return;
        }
        const proposalMatch=path.match(/^\/api\/role-proposals\/([a-z0-9-]+)\/(approve|dismiss)$/);
        if(proposalMatch&&req.method==='POST'){send(res,{proposal:engine.roles.decide(proposalMatch[1],proposalMatch[2])});return;}
        const qrRole=path.match(/^\/api\/roles\/([a-z][a-z0-9-]+)\/qr$/);if(qrRole&&req.method==='GET'){if(!engine.feishuRuntime)throw new AppError(503,'开通入口尚未准备');const png=await engine.feishuRuntime.qr(qrRole[1]);res.writeHead(200,{'Content-Type':'image/png','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(png);return;}
        const roleMatch=path.match(/^\/api\/roles\/([a-z][a-z0-9-]+)(?:\/(retirement|retire|provision|bind|disable|check|configure|confirm-disabled))?$/);
        if(roleMatch){const id=roleMatch[1],action=roleMatch[2];
          if(req.method==='POST'&&action==='check'){if(!engine.feishuRuntime)throw new AppError(503,'飞书连接尚未准备');send(res,engine.feishuRuntime.checkConnection(id),202);return;}
          if(req.method==='GET'&&action==='retirement'){const plan=engine.roles.retirement(id);const {pairing,...safeRole}=plan.role;send(res,{...plan,role:safeRole});return;}
          if(req.method==='POST'&&action==='retire'){const proposal=engine.roles.confirmRetirement(id,await body(req,10000));send(res,{proposal,role:engine.roles.get(id)},202);return;}
          if(req.method==='POST'&&action==='provision'){if(!engine.feishuRuntime)throw new AppError(503,'飞书开通入口尚未准备好');send(res,engine.feishuRuntime.provision(id),202);return;}
          if(req.method==='POST'&&action==='bind'){if(!engine.feishuRuntime)throw new AppError(503,'飞书入口尚未准备好');send(res,await engine.feishuRuntime.bindExisting(id,await body(req,10000)));return;}
          if(req.method==='POST'&&action==='configure'){if(!engine.feishuRuntime)throw new AppError(503,'飞书入口尚未准备好');send(res,await engine.feishuRuntime.configureRole(id));return;}
          if(req.method==='POST'&&action==='disable'){if(!engine.feishuRuntime)throw new AppError(503,'飞书入口尚未准备好');send(res,await engine.feishuRuntime.disableRole(id));return;}
          if(req.method==='POST'&&action==='confirm-disabled'){if(!engine.feishuRuntime)throw new AppError(503,'飞书入口尚未准备好');send(res,engine.feishuRuntime.confirmConsoleDisabled(id,await body(req,10000)));return;}
        }
        if(req.method==='GET'&&path==='/api/tasks'){try{await engine.importThreads();}catch{}send(res,db.listTasks({query:(url.searchParams.get('q')??'').slice(0,300),offset:Math.max(0,parseInt(url.searchParams.get('offset')??'0',10)||0),limit:60,archived:url.searchParams.get('archived')==='1',conversations:url.searchParams.get('chats')==='1'}));return;}
        if(req.method==='POST'&&path==='/api/history'){send(res,await engine.importHistory());return;}
        if(req.method==='POST'&&path==='/api/tasks'){
          const input=await body(req,100000);
          const intent=input.interpret===true&&(!input.role||input.role==='assistant')&&!input.captureIds?.length?taskIntent(input.goal):null;
          if(intent){
            const found=findTasks(db,intent.query,{limit:6});
            if((intent.mode==='continue'||intent.mode==='focus')&&found.uniqueTaskId){
              const task=intent.goal?engine.enqueue({...input,goal:intent.goal,taskId:found.uniqueTaskId,role:'assistant'}):db.task(found.uniqueTaskId);
              send(res,{task},intent.goal?202:200);return;
            }
            send(res,{search:{...intent,...found}});return;
          }
          send(res,{task:engine.enqueue(input)},202);return;
        }
        const taskMatch=path.match(/^\/api\/tasks\/([0-9a-f-]+)(?:\/(messages|pause|resume|archive|open|state|assign))?$/i);
        if(taskMatch?.[2]==='state'&&req.method==='POST'){send(res,{task:await engine.setTaskState(taskMatch[1],(await body(req,10000)).businessState)});return;}
        if(taskMatch?.[2]==='assign'&&req.method==='POST'){const input=await body(req,10000);send(res,{task:await engine.roles.handoff(taskMatch[1],input.roleId,{expectedVersion:input.expectedVersion})});return;}
        if(taskMatch?.[2]==='resume'&&req.method==='POST'){send(res,{task:engine.resume(taskMatch[1])});return;}
        if(taskMatch){const id=taskMatch[1],action=taskMatch[2];if(req.method==='GET'&&!action){send(res,{task:await engine.refreshTask(id,url.searchParams.has('refresh'),url.searchParams.get('role'))});return;}if(req.method==='POST'&&action==='messages'){send(res,{task:engine.enqueue({...await body(req,100000),taskId:id})},202);return;}if(req.method==='POST'&&action==='pause'){send(res,{task:await engine.pause(id)});return;}if(req.method==='POST'&&action==='archive'){const task=await engine.refreshTask(id,true);if(!task)throw new AppError(404,'找不到事项');if(['running','queued','starting','syncing','waiting_approval','waiting_input'].includes(task.status)||engine.store.jobs(['running','queued','dispatching','pendingThread','finishing','uncertain']).some(j=>engine.taskForJob(j)?.id===task.id))throw new AppError(409,'先处理或暂停正在进行的工作，再归档');send(res,{task:db.patchTask(id,{archived:!task.archived})});return;}if(req.method==='POST'&&action==='open'){const task=db.task(id);if(!task)throw new AppError(404,'找不到任务');const input=await body(req,5000);const session=input.role?db.session(task.id,input.role):null;const threadId=session?.threadId??(!input.role||input.role===task.role?task.threadId:null);if(!threadId)throw new AppError(409,'这位角色的桌面对话还在准备');await engine.openNative(threadId);send(res,{ok:true});return;}}
        if(path==='/api/captures'&&req.method==='GET'){send(res,{captures:db.captures(url.searchParams.get('q')??'',100)});return;}
        if(path==='/api/captures'&&req.method==='POST'){const input=await body(req);input.id??=randomUUID();send(res,captures.add(input));return;}
        const imageMatch=path.match(/^\/api\/captures\/([0-9a-f-]+)\/image\/(\d+)$/i);
        if(req.method==='GET'&&imageMatch){const capture=db.capture(imageMatch[1]),file=capture?.attachments[Number(imageMatch[2])];if(!file)throw new AppError(404,'找不到图片');const actual=validFile(file.path,captures.root,8*1024*1024);res.writeHead(200,{'Content-Type':file.mime,'Content-Length':actual.size,'Cache-Control':'private, max-age=300','X-Content-Type-Options':'nosniff'});createReadStream(actual.path).pipe(res);return;}
        if(path==='/api/pairing'&&req.method==='POST'){
          const input=await body(req,5000);const address=text(input.address??addresses().find(a=>!a.privateNetwork)?.address??'127.0.0.1',100);
          if(!addresses().some(a=>a.address===address)&&address!=='127.0.0.1')throw new AppError(400,'请选择这台电脑现有的网络地址');
          send(res,createPairing(address));return;
        }
        const deviceMatch=path.match(/^\/api\/devices\/([0-9a-f-]+)\/revoke$/i);if(deviceMatch&&req.method==='POST'){db.revokeDevice(deviceMatch[1]);send(res,{ok:true});return;}
        if(path==='/api/memories'&&req.method==='GET'){send(res,{memories:db.get('memories',[]),skills:db.get('skills',[])});return;}
        if(path==='/api/memories'&&req.method==='POST'){const value=await body(req,50000);const items=db.get('memories',[]);const entry={id:value.id??randomUUID(),text:text(value.text,3000),scope:['personal','project','task','role'].includes(value.scope)?value.scope:'personal',source:'用户在工作台明确登记',enabled:value.enabled!==false,updatedAt:Date.now()};if(!entry.text)throw new AppError(400,'记忆内容不能为空');if(entry.scope==='role'){if(!engine.roles.get(value.roleId))throw new AppError(400,'请选择记忆适用的角色');entry.roleId=value.roleId;}if(entry.scope==='task'){const target=db.resolveTask(value.taskId??'');if(!target)throw new AppError(400,'请选择这条记忆适用的具体事项');entry.taskId=target.id;}if(entry.scope==='project'){if(typeof value.projectId!=='string'||!value.projectId)throw new AppError(400,'请指定适用项目');entry.projectId=value.projectId;}const index=items.findIndex(i=>i.id===entry.id);if(index>=0)items[index]=entry;else items.push(entry);if(items.length>100)throw new AppError(400,'请先合并或停用重复记忆');db.set('memories',items);send(res,{memories:items});return;}
        if(path==='/api/apk'&&req.method==='GET'){const file=validFile(join(root,'dist','companion-capture-0.2.0.apk'),join(root,'dist'));res.writeHead(200,{'Content-Type':'application/vnd.android.package-archive','Content-Disposition':'attachment; filename="companion-capture-0.2.0.apk"','Content-Length':file.size,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});createReadStream(file.path).pipe(res);return;}
        if(path==='/api/export'&&req.method==='GET'){const bytes=exportData(db,dataDir);res.writeHead(200,{'Content-Type':'application/zip','Content-Disposition':'attachment; filename="companion-personal-data.zip"','Content-Length':bytes.length,'Cache-Control':'no-store'});res.end(bytes);return;}
        const artifactMatch=path.match(/^\/api\/artifacts\/([0-9a-f-]+)$/i);
        if(req.method==='GET'&&artifactMatch){const artifact=db.artifact(artifactMatch[1]);const task=artifact?db.task(artifact.taskId):null;if(!task?.cwd)throw new AppError(404,'找不到成果');const file=validFile(artifact.path,artifact.snapshot?join(dataDir,'artifacts',task.id):task.cwd);const preview=url.searchParams.has('preview');const ext=extname(file.path).toLowerCase();res.writeHead(200,{'Content-Type':preview?(MIME[ext]??'text/plain; charset=utf-8'):'application/octet-stream','Content-Disposition':`${preview?'inline':'attachment'}; filename*=UTF-8''${encodeURIComponent(artifact.name??file.name)}`,'Content-Length':file.size,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'"});createReadStream(file.path).pipe(res);return;}
        throw new AppError(404,'找不到这个操作');
      }
      if(!['GET','HEAD'].includes(req.method))throw new AppError(405,'不支持这个请求');
      const assets={'/':'index.html','/app.js':'app.js','/app.css':'app.css','/v2.css':'v2.css','/v3.css':'v3.css','/favicon.ico':'companion.ico'};const filename=assets[path];if(!filename)throw new AppError(404,'页面不存在');
      const bytes=readFileSync(join(root,'web',filename));res.writeHead(200,{'Content-Type':MIME[extname(filename)],'Content-Length':bytes.length,'Cache-Control':'no-cache','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"});res.end(req.method==='HEAD'?undefined:bytes);
    }catch(error){if(!res.headersSent)send(res,{error:publicError(error)},error.status??500);else res.destroy();if(!(error instanceof AppError))log('ui_error',{message:error.message});}
  };
  const tlsInfo=tls??await certificate(dataDir);
  const mobileHandler=async(req,res)=>{
    try{
      if(req.headers.origin)throw new AppError(403,'此入口只供已配对的记录应用使用');
      const path=new URL(req.url,'https://localhost').pathname;
      if(req.method==='GET'&&path==='/mobile/health'){send(res,{ok:true,service:'companion-capture',version:VERSION});return;}
      if(req.method==='POST'&&path==='/mobile/pair'){
        const ip=req.socket.remoteAddress??'unknown';const attempt=attempts.get(ip)??{count:0,until:Date.now()+60000};if(attempt.until<Date.now()){attempt.count=0;attempt.until=Date.now()+60000;}attempt.count++;attempts.set(ip,attempt);if(attempts.size>1000)attempts.delete(attempts.keys().next().value);if(attempt.count>10)throw new AppError(429,'尝试较多，请一分钟后再试');
        const input=await body(req,10000),pairing=db.get('pairing');if(!pairing||pairing.expires<Date.now()||!equal(hash(String(input.ticket??'')),pairing.hash))throw new AppError(401,'配对信息已失效，请在电脑重新生成');
        if(!/^[0-9a-f-]{36}$/i.test(input.deviceId??''))throw new AppError(400,'设备编号无效');
        const credential=`${input.deviceId}.${token()}`;db.transaction(()=>{db.putDevice({id:input.deviceId,name:text(input.deviceName??'Android',100),pairedAt:Date.now(),lastSeenAt:Date.now()},hash(credential));db.set('pairing',null);});send(res,{ok:true,deviceId:input.deviceId,token:credential});return;
      }
      if(req.method==='POST'&&path==='/mobile/captures'){
        const bearer=req.headers.authorization?.replace(/^Bearer /,'')??'';const id=bearer.split('.')[0],device=db.device(id);if(!device||!equal(hash(bearer),device.tokenHash))throw new AppError(401,'电脑连接已失效，请重新配对');
        const result=captures.add(await body(req),id);db.putDevice({...device,tokenHash:undefined,lastSeenAt:Date.now()},device.tokenHash);send(res,{ok:true,id:result.capture.id,duplicate:result.duplicate});return;
      }
      throw new AppError(404,'此入口只支持登记记录');
    }catch(error){if(!res.headersSent)send(res,{error:publicError(error)},error.status??500);else res.destroy();if(!(error instanceof AppError))log('mobile_error',{message:error.message});}
  };
  const local=http.createServer(privateHandler),mobile=https.createServer({key:tlsInfo.key,cert:tlsInfo.cert,minVersion:'TLSv1.2'},mobileHandler);
  for(const server of [local,mobile]){server.requestTimeout=30000;server.headersTimeout=15000;server.on('clientError',(_,socket)=>socket.destroy());}
  const listen=(server,port,host)=>new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve);});
  try{await listen(local,uiPort,'127.0.0.1');await listen(mobile,mobilePort,mobileHost);}catch(error){local.close();mobile.close();throw error;}
  const status={pid:process.pid,uiPort:local.address().port,mobilePort:mobile.address().port,uiUrl:uiOrigin(),startedAt:new Date().toISOString(),version:VERSION};
  writeFileSync(join(dataDir,'status.json'),JSON.stringify(status,null,2));
  return {local,mobile,status,adminKey,captures,pin:tlsInfo.pin,createPairing,close:async()=>{await Promise.all([new Promise(r=>local.close(r)),new Promise(r=>mobile.close(r))]);}};
}
