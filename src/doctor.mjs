import { readFileSync,existsSync } from 'node:fs';
import { dirname,resolve,join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const configPath=join(root,'companion.local.json');
if(!existsSync(configPath)){console.log(JSON.stringify({installed:false,next:'运行 scripts/install.ps1'},null,2));process.exitCode=1;}
else{
  const config=JSON.parse(readFileSync(configPath,'utf8'));const statusPath=join(config.dataDir,'status.json');
  const report={installed:true,statusFile:existsSync(statusPath),running:false};
  if(report.statusFile){const status=JSON.parse(readFileSync(statusPath,'utf8'));report.uiPort=status.uiPort;report.mobilePort=status.mobilePort;try{const key=readFileSync(join(config.dataDir,'admin.key'),'utf8').trim();const response=await fetch(status.uiUrl+'/api/overview',{headers:{Authorization:'Bearer '+key},signal:AbortSignal.timeout(15000)});const info=await response.json();report.running=response.ok;report.feishu=info.bridge?.feishuConnected??false;report.ownerPaired=info.bridge?.ownerPaired??false;report.tasks=info.tasks?.length??0;report.captures=info.captureCount??0;report.warning=info.warning??'';}catch{report.running=false;}}
  console.log(JSON.stringify(report,null,2));if(!report.running)process.exitCode=1;
}
