// Isolated browser QA only: no model, Feishu, or personal database is used.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture } from './helpers.mjs';
import { startServer } from '../src/server.mjs';

const f=fixture();
writeFileSync(join(f.dataDir,'admin.key'),'companion-qa-local-only');
f.engine.status=()=>({feishuConnected:false,ownerPaired:true,active:0,verificationFixture:true});
const parent=f.db.putTask({id:randomUUID(),threadId:randomUUID(),title:'安排一次周末出行',role:'assistant',private:true,status:'delivered',source:'desktop',cwd:f.dataDir,lastRequest:'整理周末露营的准备事项',summary:'准备事项已经整理，可以继续补充。',createdAt:Date.now()});
const child=f.db.putTask({id:randomUUID(),threadId:randomUUID(),parentId:parent.id,title:'整理出行准备清单',role:'life',private:true,status:'delivered',source:'desktop',cwd:f.dataDir,lastRequest:'整理出行准备清单',createdAt:Date.now()});
f.engine.roles.patch('life',{status:'active'});
f.engine.roles.propose({kind:'recruit',name:'验收阅读助理',brief:'整理测试阅读资料',reason:'多个阅读任务反复使用相同的整理方式'},parent.id);
for(let i=0;i<47;i++)f.db.putTask({id:randomUUID(),title:'分页样本 '+String(i).padStart(2,'0'),role:'quant',private:true,status:'delivered',businessState:i===0?'completed':'open',updatedAt:1000+i,source:'fixture'},{touch:false});
f.db.putTask({id:randomUUID(),title:'验证低换手选股假设',role:'quant',private:true,status:'running',summary:'正在校验历史样本。',source:'fixture'});
f.db.putTask({id:randomUUID(),title:'实现安卓悬浮记录入口',role:'product',private:true,status:'running',summary:'正在完善记录面板。',source:'fixture'});
f.db.putTask({id:randomUUID(),title:'待你补充的日期',role:'life',private:true,status:'idle',businessState:'waiting_user',source:'fixture'});
for(const task of [parent,child])f.desktop.snapshots.set(task.threadId,{thread:{id:task.threadId,status:{type:'idle'},cwd:f.dataDir},turns:[{id:'turn-'+task.id,status:'completed',items:[{id:'u-'+task.id,type:'userMessage',content:[{type:'text',text:task.lastRequest}]},{id:'f-'+task.id,type:'agentMessage',phase:'final',text:task.role==='life'?'已整理交通、餐饮和装备清单。':'准备事项已经整理，可以继续补充。'}]}]});
const html=join(f.dataDir,'出行准备.html');writeFileSync(html,'<!doctype html><meta charset="utf-8"><h1>出行准备</h1><p>交通、餐饮与装备。</p>');f.engine.artifact(parent.id,html);
f.engine.captures.add({id:randomUUID(),text:'周末想去露营 https://example.com/camp',source:'android-share',attachments:[]},'qa-phone');
f.db.set('memories',[{id:randomUUID(),text:'出行尽量轻装。',scope:'personal',enabled:false,source:'测试登记',updatedAt:Date.now()}]);
f.engine.roles.start();
const server=await startServer({engine:f.engine,db:f.db,root:f.engine.root,dataDir:f.dataDir,uiPort:19119,mobilePort:0,mobileHost:'127.0.0.1'});
console.log('Isolated browser QA ready at http://127.0.0.1:19119');
let closing=false;
async function close(){if(closing)return;closing=true;await f.engine.roles.close();await server.close();f.close();process.exit(0);}
process.on('SIGINT',close);process.on('SIGTERM',close);
