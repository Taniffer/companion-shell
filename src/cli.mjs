import { readFileSync,mkdirSync,writeFileSync,existsSync,realpathSync,unlinkSync } from 'node:fs';
import { dirname,join,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const config=JSON.parse(readFileSync(join(root,'companion.local.json'),'utf8').replace(/^\uFEFF/,''));
const argv=process.argv.slice(2),command=argv.shift(),options={};for(let i=0;i<argv.length;i+=2){if(!argv[i].startsWith('--')||argv[i+1]===undefined)throw new Error('工作接口参数不完整');options[argv[i].slice(2)]=argv[i+1];}
try{
  const actionId=options['request-id']??randomUUID();const taskId=options.task??options.parent;if(!/^[0-9a-f-]{36}$/i.test(taskId??''))throw new Error('请指定 --task 或 --parent 本次事项编号');
  const status=JSON.parse(readFileSync(join(config.dataDir,'status.json'),'utf8'));
  const capability=JSON.parse(readFileSync(join(config.dataDir,'capabilities',taskId+(options['actor-role']?'.'+options['actor-role']:'')+'.json'),'utf8'));
  let path,method='GET',body;
  if(command==='captures')path='/api/agent/context?q='+encodeURIComponent(options.query??'');
  else if(command==='task'){if(!/^[0-9a-f-]{36}$/i.test(options.id??taskId))throw new Error('事项编号无效');path='/api/agent/tasks/'+(options.id??taskId);}
  else if(command==='delegate'){path='/api/agent/delegate';method='POST';body=JSON.stringify({goal:options.goal,role:options.role,title:options.title,captureIds:options.captures?options.captures.split(','):undefined,requestId:actionId});}
  else if(command==='roles')path='/api/agent/roles';
  else if(command==='propose'){path='/api/agent/roles/propose';method='POST';body=JSON.stringify({kind:options.kind??'recruit',name:options.name,brief:options.brief,roleId:options.role,reason:options.reason,firstGoal:options['first-goal'],requestId:actionId});}
  else if(command==='state'){path='/api/agent/state';method='POST';body=JSON.stringify({businessState:options.value,reason:options.reason,requestId:actionId});}
  else throw new Error('支持 captures、task、delegate、roles、propose、state。');
  if(options.transport==='http'){
    const response=await fetch(status.uiUrl+path,{method,headers:{Authorization:'Bearer '+capability.token,'Content-Type':'application/json','X-Companion':'1'},body,signal:AbortSignal.timeout(45000)});
    const result=await response.json();if(!response.ok)throw new Error(result.error??'操作没有完成');console.log(JSON.stringify(result,null,2));
  }else{
    const cwd=realpathSync(process.cwd()),dir=join(cwd,'.companion','requests');mkdirSync(dir,{recursive:true});if(!realpathSync(dir).startsWith(cwd+'\\')&&!realpathSync(dir).startsWith(cwd+'/'))throw new Error('工作目录中的交接文件夹无效');
    const ignore=join(cwd,'.companion','.gitignore');if(!existsSync(ignore))writeFileSync(ignore,'*\n');
    const id=actionId;if(!/^[0-9a-f-]{36}$/i.test(id))throw new Error('文件工作接口的 request-id 需要 UUID');const file=join(dir,id+'.json'),responsePath=join(dir,id+'.response.json');const request={credential:capability.token,path,method,data:body?JSON.parse(body):undefined};
    if(existsSync(file)){if(readFileSync(file,'utf8')!==JSON.stringify(request))throw new Error('同一工作编号已用于其他内容');}else writeFileSync(file,JSON.stringify(request),{mode:0o600,flag:'wx'});
    if(options['request-id']&&existsSync(responsePath)){const prior=JSON.parse(readFileSync(responsePath,'utf8'));if(!prior.ok&&prior.status>=500)unlinkSync(responsePath);}
    const deadline=Date.now()+25000;while(!existsSync(responsePath)&&Date.now()<deadline)await new Promise(r=>setTimeout(r,250));if(!existsSync(responsePath))throw new Error('本机助理尚未接回，保留 --request-id '+id+' 重试同一次工作');const response=JSON.parse(readFileSync(responsePath,'utf8'));if(!response.ok)throw new Error(response.value?.error??'本次工作没有完成');console.log(JSON.stringify(response.value,null,2));
  }
}catch(error){console.error(JSON.stringify({ok:false,error:error.message}));process.exitCode=1;}
