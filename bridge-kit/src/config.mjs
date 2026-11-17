import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
export const root=fileURLToPath(new URL('../',import.meta.url));
export const configPath=resolve(process.env.BRIDGE_CONFIG??join(root,'config.local.json'));
export function loadConfig(){return JSON.parse(readFileSync(configPath,'utf8').replace(/^\uFEFF/,''));}
export function readSecret(config) {
  const path=resolve(root,config.feishu.secretFile);
  if(!existsSync(path)) throw new Error('尚未配置飞书 App Secret，请运行配置向导');
  const env={...process.env,BRIDGE_SECRET_FILE:path}; delete env.PSModulePath;
  return execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',
    '$ErrorActionPreference="Stop"; $secret = (Get-Content -LiteralPath $env:BRIDGE_SECRET_FILE -Raw).Trim() | ConvertTo-SecureString; $credential = New-Object System.Management.Automation.PSCredential("bridge", $secret); [Console]::Write($credential.GetNetworkCredential().Password)'],
    {windowsHide:true,env,encoding:'utf8'}).trim();
}
export function latestServer(codexHome) {
  const base=join(codexHome,'plugins','cache','openai-bundled','codex-app-tools');
  const versions=readdirSync(base).sort((a,b)=>b.localeCompare(a,undefined,{numeric:true}));
  for(const v of versions){const p=join(base,v,'server.mjs');if(existsSync(p))return p;}
  throw new Error('未找到 Codex 桌面端内置任务插件');
}
