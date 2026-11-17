export const EXECUTING = ['running','starting','syncing'];
export const ACTIVE_JOBS = ['queued','dispatching','pendingThread','running','finishing','uncertain'];
export function taskBucket(task, children=[]) {
  if(task.businessState==='completed')return 'completed';
  if(task.businessState==='waiting_user')return 'unfinished';
  if(EXECUTING.includes(task.status))return 'running';
  if(task.status==='waiting'&&children.some(c=>EXECUTING.includes(c.status)))return 'running';
  return 'unfinished';
}
export function taskLabel(task){
  if(task.businessState==='completed')return '已完成';
  if(task.businessState==='waiting_user')return '待你补充';
  return {waiting_approval:'待桌面确认',waiting_input:'待你补充',queued:'等待执行',starting:'正在准备',running:'正在处理',waiting:'等待专业结果',syncing:'正在同步答复',delivered:'已有答复 · 待确认',idle:'尚未完成',uncertain:'投递待核实',failed:'本轮失败',interrupted:'本轮已中断',paused:'安排已暂存'}[task.status]??'未完成';
}
