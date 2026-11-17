import { readFileSync,existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve,dirname,join } from 'node:path';
import { spawn } from 'node:child_process';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const path=join(root,'companion.local.json');
if(!existsSync(path)){console.error('请先运行 scripts/install.ps1，将伴随工作台接入现有飞书桥接。');process.exitCode=1;}
else{
  const settings=JSON.parse(readFileSync(path,'utf8'));
  const status=JSON.parse(readFileSync(join(settings.dataDir,'status.json'),'utf8'));
  const adminKey=readFileSync(join(settings.dataDir,'admin.key'),'utf8').trim();
  const health=await fetch(status.uiUrl+'/api/health',{signal:AbortSignal.timeout(5000)}).then(r=>r.json()).catch(()=>null);
  if(!health?.ok||health.service!=='companion-workbench'){console.error('工作台尚未启动，请运行“启动伴随.cmd”。');process.exitCode=1;}
  else{const url=status.uiUrl+'/#key='+encodeURIComponent(adminKey),launchEnv={...process.env,COMPANION_OPEN_URL:url};delete launchEnv.PSModulePath;const powershell=join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');try{await new Promise((resolve,reject)=>{const child=spawn(powershell,['-NoProfile','-NonInteractive','-Command','Start-Process -FilePath $env:COMPANION_OPEN_URL'],{windowsHide:true,stdio:'ignore',env:launchEnv});child.on('error',()=>reject(new Error('打开失败')));child.on('exit',code=>code===0?resolve():reject(new Error('打开失败')));});console.log('已打开本机伴随工作台。');}catch{console.error('工作台正在运行，但浏览器未打开。请重新运行“启动伴随.cmd”。');process.exitCode=1;}}
}
