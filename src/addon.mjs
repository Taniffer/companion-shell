import { fileURLToPath,pathToFileURL } from 'node:url';
import { dirname,resolve,join } from 'node:path';
import { mkdirSync,writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { Database } from './db.mjs';
import { Engine } from './engine.mjs';
import { attachBridge } from './bridge-hooks.mjs';
import {FeishuRuntime} from './feishu-runtime.mjs';
import { startServer,addresses } from './server.mjs';
import {startAgentSpool} from './agent-spool.mjs';

export async function startCompanion({bridge,desktop,store,feishu,config,log,root:bridgeRoot}){
  const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
  const options=config.companion??{},dataDir=resolve(options.dataDir??join(root,'data'));
  mkdirSync(dataDir,{recursive:true});
  writeFileSync(join(root,'companion.local.json'),JSON.stringify({bridgeRoot,dataDir},null,2),{mode:0o600});
  const db=new Database(join(dataDir,'companion.sqlite'));
  config.bridgeRoot=bridgeRoot;
  const readonlyDesktop=new desktop.constructor({...config.desktop});
  const engine=new Engine({db,bridge,store,desktop:readonlyDesktop,config,dataDir,root,log});
  const server=await startServer({engine,db,root,dataDir,uiPort:options.uiPort??47471,mobilePort:options.mobilePort??47472,mobileHost:options.mobileHost??'0.0.0.0',log});
  const agentSpool=startAgentSpool(engine,server.status.uiUrl);
  engine.phonePairing=choice=>{const items=addresses();const chosen=choice?items.find(a=>a.address===choice||a.name.toLowerCase().includes(choice.toLowerCase())):items.find(a=>!a.privateNetwork);if(choice&&!chosen)throw new Error('未找到指定网络地址');return server.createPairing(chosen?.address);};
  const routing=await import(pathToFileURL(join(bridgeRoot,'src','routing.mjs')).href);
  const feishuRuntime=new FeishuRuntime({engine,feishu,normalize:routing.normalize,log}).install();engine.feishuRuntime=feishuRuntime;
  const hooks=attachBridge({engine,bridge,store,desktop,feishu,normalize:routing.normalize,command:routing.command});
  engine.status=()=>({feishuConnected:feishu.ws.getConnectionStatus().state==='connected',ownerPaired:!!engine.owner(),active:store.jobs(['running','queued','dispatching','pendingThread','finishing']).length,uncertain:store.jobs(['uncertain']).length,desktopAdapter:'Codex Desktop',lastStatusAt:Date.now()});
  for(const row of store.db.prepare('SELECT value FROM jobs ORDER BY created DESC LIMIT 200').all()){
    try{const job=JSON.parse(row.value);if(job.threadId)engine.onJob(job);}catch(error){engine.safeLog('history_import_error',error);}
  }
  const timer=setInterval(()=>engine.completeChildren().catch(error=>engine.safeLog('child_recovery_error',error)),20000);timer.unref();
  log('companion_started',{uiPort:server.status.uiPort,mobilePort:server.status.mobilePort});
  log('companion_tray_config',{platform:process.platform,enabled:options.showTray!==false});
  if(process.platform==='win32'&&options.showTray!==false){const trayEnv={...process.env};delete trayEnv.PSModulePath;const powershell=join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');const tray=spawn(powershell,['-STA','-NoProfile','-ExecutionPolicy','Bypass','-File',join(root,'scripts','tray.ps1')],{windowsHide:true,stdio:['ignore','ignore','pipe'],env:trayEnv});log('companion_tray_launched',{pid:tray.pid});tray.stderr.on('data',data=>log('tray_start_error',{message:data.toString().slice(0,1200)}));tray.on('error',error=>log('tray_start_error',{message:error.message}));tray.on('exit',code=>log('companion_tray_exit',{code}));tray.unref();}
  return {engine,server,hooks,close:async()=>{clearInterval(timer);agentSpool.close();feishuRuntime.close();engine.close();await server.close();db.close();}};
}
