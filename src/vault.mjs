import {mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';
import {spawnSync} from 'node:child_process';
export class Vault{
  constructor(root){this.root=root;mkdirSync(root,{recursive:true,mode:0o700});}
  path(id){if(!/^[a-zA-Z0-9_-]{2,100}$/.test(id))throw new Error('凭证标识无效');return join(this.root,id+'.dpapi');}
  transform(value,decrypt=false){if(process.platform==='win32'){const command=decrypt?'$raw=[Console]::In.ReadToEnd().Trim();$sec=ConvertTo-SecureString $raw;$cred=New-Object System.Management.Automation.PSCredential("companion",$sec);[Console]::Write($cred.GetNetworkCredential().Password)':'$raw=[Console]::In.ReadToEnd();$sec=ConvertTo-SecureString -String $raw -AsPlainText -Force;[Console]::Write((ConvertFrom-SecureString $sec))';const env={...process.env};delete env.PSModulePath;const r=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{input:value,encoding:'utf8',windowsHide:true,env,timeout:20000});if(r.status!==0)throw new Error('Windows 凭证保护尚未完成');return r.stdout.trim();}
    const keyPath=join(this.root,'local.key');if(!existsSync(keyPath))writeFileSync(keyPath,randomBytes(32),{mode:0o600});const key=readFileSync(keyPath);if(decrypt){const data=Buffer.from(value,'base64'),cipher=createDecipheriv('aes-256-gcm',key,data.subarray(0,12));cipher.setAuthTag(data.subarray(12,28));return Buffer.concat([cipher.update(data.subarray(28)),cipher.final()]).toString('utf8');}const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv),data=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),data]).toString('base64');}
  put(id,value){writeFileSync(this.path(id),this.transform(value),{mode:0o600});return id;}
  get(id){return this.transform(readFileSync(this.path(id),'utf8'),true);}
}
