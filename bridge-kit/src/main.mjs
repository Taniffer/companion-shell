import { createServer } from 'node:net';
import { appendFileSync,mkdirSync,writeFileSync,statSync,renameSync,existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { loadConfig,readSecret,root } from './config.mjs';
import { Desktop } from './desktop.mjs';
import { Feishu } from './feishu.mjs';
import { Store } from './store.mjs';
import { Bridge } from './bridge.mjs';
import { redact } from './routing.mjs';
const config=loadConfig();
// Local named-pipe lock: a second instance exits without connecting to Feishu.
const lock=createServer(socket=>socket.end()).listen(config.lockPipe??'\\\\.\\pipe\\codex-feishu-bridge-local');
lock.on('error',e=>{console.error('Bridge already running or lock unavailable:',e.code);process.exit(e.code==='EADDRINUSE'?42:1);});
await new Promise(resolve=>lock.once('listening',resolve));
mkdirSync(join(root,'logs'),{recursive:true});
const secret=readSecret(config), logPath=join(root,'logs','bridge.log');
function log(event,data={}) {
  if(existsSync(logPath)&&statSync(logPath).size>2_000_000)renameSync(logPath,logPath+'.1');
  appendFileSync(logPath,JSON.stringify({at:new Date().toISOString(),event,...JSON.parse(redact(JSON.stringify(data),[secret]))})+'\n');
}
const store=new Store(join(root,'data','bridge.sqlite'));
if(!store.get('owner',config.feishu.ownerOpenId)&&!store.get('pairing'))store.set('pairing',{code:randomBytes(5).toString('hex'),expires:Date.now()+24*3600_000});
const desktop=new Desktop(config.desktop),feishu=new Feishu(config.feishu,secret);
const bridge=new Bridge({config,store,desktop,feishu,log,secrets:[secret]});
const status=()=>writeFileSync(join(root,'data','status.json'),JSON.stringify({pid:process.pid,at:new Date().toISOString(),feishu:feishu.ws.getConnectionStatus(),ownerPaired:!!store.get('owner',config.feishu.ownerOpenId),active:store.jobs(['running','queued','finishing','pendingThread','dispatching']).length,uncertain:store.jobs(['uncertain']).length,retrying:store.jobs(['running','queued','dispatching','pendingThread']).filter(j=>j.failures>0).length,outboxPending:store.db.prepare('SELECT count(*) AS n FROM outbox WHERE sent=0').get().n,memoryMB:Math.round(process.memoryUsage().rss/1048576)}));
let timer;
function stop(signal){log('stopped',{signal});clearInterval(timer);bridge.stop();feishu.close();desktop.close();store.close();lock.close();process.exit(0);}
process.on('SIGTERM',()=>stop('SIGTERM'));process.on('SIGINT',()=>stop('SIGINT'));
process.on('uncaughtException',e=>{log('fatal',{message:e.message});process.exit(1);});
process.on('unhandledRejection',e=>{log('fatal',{message:String(e?.message??e)});process.exit(1);});
await feishu.identity();
await feishu.start(event=>bridge.receive(event));
log('started');status();timer=setInterval(status,30000);
await bridge.start();
