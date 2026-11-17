import{mkdirSync,readdirSync,readFileSync,writeFileSync,renameSync,existsSync,realpathSync}from'node:fs';
import{randomUUID}from'node:crypto';
import{join,resolve,sep}from'node:path';
import{validFile}from'./util.mjs';
const allowed=path=>/^\/api\/agent\/(context(?:\?[^\r\n]*)?|tasks\/[0-9a-f-]+|delegate|state|roles(?:\/propose)?)$/i.test(path);
// The model writes only in its current task workspace. The host serves these scoped requests.
export function startAgentSpool(engine,base){let running=false,closed=false;async function flush(){if(running||closed)return;running=true;try{
  const roots=new Map();for(const job of engine.store.jobs(['running','dispatching','pendingThread','finishing']))if(job.cwd&&job.companionTaskId&&job.actorRole){const key=resolve(job.cwd);const scopes=roots.get(key)??new Set();scopes.add(job.companionTaskId+'.'+job.actorRole);roots.set(key,scopes);}
  let remaining=12;for(const[cwd,scopes]of roots){const dir=join(cwd,'.companion','requests');if(!existsSync(dir))continue;const actualRoot=realpathSync(cwd);if(!realpathSync(dir).startsWith(actualRoot+sep))continue;
    for(const name of readdirSync(dir)){if(remaining<=0)break;if(!/^[0-9a-f-]{36}\.json$/i.test(name))continue;const responsePath=join(dir,name.replace('.json','.response.json'));if(existsSync(responsePath))continue;remaining--;let reply;
      try{const file=validFile(join(dir,name),actualRoot,150000),request=JSON.parse(readFileSync(file.path,'utf8')),scope=String(request.credential??'').split('.').slice(0,2).join('.');if(!scopes.has(scope)||!allowed(request.path)||!['GET','POST'].includes(request.method))throw Error('Invalid scoped request');
        const data=request.method==='POST'?{...request.data,requestId:request.data?.requestId??name.slice(0,-5)}:undefined;
        const response=await fetch(base+request.path,{method:request.method,headers:{Authorization:'Bearer '+request.credential,'X-Companion':'1','Content-Type':'application/json'},body:data?JSON.stringify(data):undefined,signal:AbortSignal.timeout(15000)});reply={ok:response.ok,status:response.status,value:await response.json()};
      }catch{reply={ok:false,status:503,value:{error:'本地工作交接尚未完成，请保留本次请求编号后重试。'}};}
      const temp=responsePath+'.'+randomUUID()+'.tmp';writeFileSync(temp,JSON.stringify(reply),{mode:0o600,flag:'wx'});renameSync(temp,responsePath);
    }
  }
}finally{running=false;}}
 const timer=setInterval(()=>flush().catch(e=>engine.safeLog('agent_spool_error',e)),700);timer.unref();return{flush,close(){closed=true;clearInterval(timer);}};}
