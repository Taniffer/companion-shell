import {taskLabel} from './task-state.mjs';
const plain=content=>({tag:'plain_text',content:String(content??'').slice(0,400)});
export const escapeCard=value=>String(value??'').replace(/[&<>*_\[\]~]/g,c=>'&#'+c.charCodeAt(0)+';');
const md=(content,caption=false)=>({tag:'markdown',content,text_size:caption?'notation':'normal'});
const block=(elements,background='grey-50')=>({tag:'column_set',flex_mode:'none',background_style:background,columns:[{tag:'column',width:'weighted',weight:1,padding:'12px',vertical_spacing:'8px',elements}]});
const row=buttons=>({tag:'column_set',flex_mode:'none',horizontal_spacing:'8px',columns:buttons.map(b=>({tag:'column',width:'weighted',weight:1,elements:[b]}))});
export const callbackButton=(name,action,value={},primary=false)=>({tag:'button',text:plain(name),type:primary?'primary_filled':'default',width:'fill',behaviors:[{type:'callback',value:{action,...value}}]});
export const linkButton=(name,url,primary=true)=>({tag:'button',text:plain(name),type:primary?'primary_filled':'default',width:'fill',behaviors:[{type:'open_url',default_url:url}]});
export function card(title,elements,{subtitle='',template='turquoise',icon='todo_colorful'}={}){return {schema:'2.0',config:{update_multi:true,width_mode:'default',enable_forward:false,summary:{content:title}},header:{title:plain(title),subtitle:plain(subtitle),template,icon:{tag:'standard_icon',token:icon}},body:{padding:'12px 12px 20px 12px',vertical_spacing:'12px',elements}};}
export function taskCard(task,roles,progressText=null){const value={taskId:task.id,version:task.actionVersion??1};return card('任务进展',[
  block([md('**'+escapeCard(task.title)+'**'),md(escapeCard(taskLabel(task))+' · '+escapeCard(roles.get(task.role)?.name??'助理'),true)],task.businessState==='completed'?'green-50':'turquoise-50'),
  block([md(escapeCard((progressText??task.summary??task.lastRequest??'目标已保留，随时接着推进。').slice(-900))),md('最近更新：'+new Date(task.updatedAt??Date.now()).toLocaleString('zh-CN',{timeZone:'Asia/Hong_Kong',hour12:false}),true)]),
  row([callbackButton(task.businessState==='waiting_user'?'补充信息':'继续这件事','continue_task',value,true),
    callbackButton(task.businessState==='completed'?'重新打开':'确认完成',task.businessState==='completed'?'reopen':'complete',value)])
]);}
export function listCard({tasks,counts,roles,role='all',bucket='unfinished',offset=0,total,hasMore}){const filters={role,bucket,offset};return card('我的任务',[
  row([['running','运行中'],['unfinished','未完成'],['completed','已完成']].map(([id,label])=>callbackButton(label+' '+counts[id],'list',{role,bucket:id,offset:0},id===bucket))),
  ...tasks.map(t=>block([md('**'+escapeCard(t.title)+'**'),md(escapeCard(roles.find(r=>r.id===t.role)?.name??'助理')+' · '+escapeCard(taskLabel(t)),true),callbackButton('查看详情','task',{taskId:t.id})])),
  row([...(offset>0?[callbackButton('上一页','list',{...filters,offset:Math.max(0,offset-2)})]:[]),callbackButton('刷新','list',filters),...(hasMore?[callbackButton('下一页','list',{...filters,offset:offset+2})]:[])])
],{subtitle:`${total} 项 · 第 ${total?offset+1:0}–${Math.min(total,offset+tasks.length)} 项`});}
export function formCard(type,token,{task,role,roles,initialText=''}={}){let title,fields,caption,submit;
  if(type==='capture'){title='记一下';caption='先保存资料，需要时再交给助理。';submit='保存';fields=[{tag:'input',name:'content',label:plain('内容'),input_type:'multiline_text',rows:4,required:true,max_length:1000,default_value:initialText},{tag:'input',name:'url',label:plain('链接（选填）'),max_length:1000}];}
  else if(type==='supplement'){title='补充任务要求';caption=task.title;submit='提交并继续';fields=[{tag:'input',name:'content',label:plain('需要补充或修改什么'),input_type:'multiline_text',rows:4,required:true,max_length:1000}];}
  else if(type==='create_task'){title='交代一件事';caption='助理直接处理，必要时再安排专业工作。';submit='交给助理';fields=[{tag:'input',name:'content',label:plain('想推进的目标'),input_type:'multiline_text',rows:4,required:true,max_length:1000}];}
  else if(type==='assign'){title='交接负责人';caption=task.title;submit='确认交接';fields=[{tag:'select_static',name:'roleId',placeholder:plain('交给谁'),required:true,options:roles.filter(r=>r.status==='active').map(r=>({text:plain(r.name),value:r.id}))}];}
  else{title='招募一位助理';caption='说明名字和职责，助手负责开通与交接。';submit='确认招募';fields=[{tag:'input',name:'name',label:plain('名字'),required:true,max_length:40,default_value:role?.name??''},{tag:'input',name:'brief',label:plain('职责'),required:true,input_type:'multiline_text',rows:3,max_length:1000,default_value:role?.brief??''}];}
  return card(title,[block([md('**'+escapeCard(caption)+'**')],'turquoise-50'),{tag:'form',name:'form_'+token,elements:[...fields,{tag:'button',name:'submit_'+token,text:plain(submit),type:'primary_filled',width:'fill',form_action_type:'submit'}]}],{icon:type==='capture'?'file-form_colorful':'todo_colorful'});
}
export function receiptCard(title,message,buttons=[]){return card(title,[block([md('**'+escapeCard(message)+'**')],'turquoise-50'),...(buttons.length?[row(buttons)]:[md('内容已保留，可以随时从固定入口继续。',true)])]);}
export function staffingCard(proposal){
  const adding=proposal.kind==='recruit',title=(adding?'招募 ':'并回 ')+proposal.name;
  const status={approved:'已确认。助理会等当前工作结束，接回任务并处理飞书入口。',
    accepted:adding?'已加入协作。助理负责派活。':'工作已并回助理，原任务与成果保留。',dismissed:'已保留原来的分工。'}[proposal.status];
  const scope=adding?proposal.brief:`${proposal.openTasks??0} 项在办任务由助理接回，记忆和成果保留。`;
  return card(title,[
    block([md(escapeCard(proposal.reason.slice(0,280))),md(escapeCard((scope??'').slice(0,400)),true)],'turquoise-50'),
    ...(proposal.firstGoal?[md('先接手：'+escapeCard(proposal.firstGoal.slice(0,170)),true)]:[]),
    ...(status?[md(status,true)]:[row([
      callbackButton(adding?'同意招募':'同意并回','staffing_decision',{proposalId:proposal.id,decision:'approve'},true),
      callbackButton('先不用','staffing_decision',{proposalId:proposal.id,decision:'dismiss'})
    ])])
  ],{subtitle:status?'决定已记录':'待你确认'});
}
export function foundTasksCard(query,tasks){
  return card('找到的任务',[
    md(escapeCard(query.slice(0,100)),true),
    ...tasks.map(t=>block([
      md('**'+escapeCard(t.title)+'**'),
      md(escapeCard(t.label+(t.archived?' · 已归档':''))+' · '+new Date(t.updatedAt).toLocaleDateString('zh-CN',{timeZone:'Asia/Hong_Kong'}),true),
      ...(t.summary?[md(escapeCard(t.summary))]:[]),
      row([callbackButton('继续这件事','continue_task',{taskId:t.id},true),callbackButton('查看进展','task',{taskId:t.id})]),
      ...(t.artifact?[callbackButton('取成果 · '+t.artifact.name,'send_artifact',{taskId:t.id,artifactId:t.artifact.id})]:[])
    ])),
    ...(!tasks.length?[md('没找到匹配任务。可以用任务名、时间或成果文件名再找一次。')]:[])
  ]);
}
export function teamCard(roles,{offset=0,manage=false}={}){const active=roles.filter(r=>['active','retiring'].includes(r.status)&&r.id!=='assistant'),page=active.slice(offset,offset+2);return card(manage?'助理管理与交接':'你的助理',[
  block([md('**助理负责理解你、执行和汇报。**'),md('长期专业需求才招人；临时工作由助理安排。',true)],'turquoise-50'),
  ...page.map(r=>block([md('**'+escapeCard(r.name)+'**'),md(escapeCard(r.brief.slice(0,140)),true),row([callbackButton('和她聊','role',{roleId:r.id}),callbackButton('交接给助理','retire_plan',{roleId:r.id})])])),
  ...(!page.length?[md('目前由助理直接负责，需要时再招募助理。')]:[]),
  ...(active.length>2?[row([...(offset>0?[callbackButton('上一页','manage_roles',{offset:Math.max(0,offset-2)})]:[]),...(offset+2<active.length?[callbackButton('下一页','manage_roles',{offset:offset+2})]:[])])]:[])
]);}
export function retireCard(plan){const unfinished=plan.tasks.filter(t=>t.businessState!=='completed');return card('并回助理前，核对这份清单',[
  block([md('**'+escapeCard(plan.role.name)+' · 工作交接**'),md(`${unfinished.length} 项未完成任务 · ${plan.memories.length} 条记忆 · ${plan.artifacts.length} 份成果`,true)],'turquoise-50'),
  block([md(unfinished.slice(0,4).map(t=>'• '+escapeCard(t.title)).join('\n')||'没有未完成任务。'),md('任务与资料保留原有出处，专业知识按需取用。',true)]),
  row([callbackButton(plan.active.length?'仍有在途工作，请稍后核对':'并回助理并移除角色','retire',{roleId:plan.role.id,version:plan.version},true),callbackButton('暂时保留','team')])
],{subtitle:plan.active.length?'等待当前执行结束后再交接':'内部交接完成后，再核验平台停用'});}
