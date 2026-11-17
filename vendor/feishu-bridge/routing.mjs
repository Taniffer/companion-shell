export function extractText(message) {
  let body; try { body = JSON.parse(message.content ?? message.body?.content ?? '{}'); } catch { return ''; }
  if (typeof body.text === 'string') return body.text;
  const post = body.content ? body : body.zh_cn ?? body.en_us;
  if (post?.content) return [post.title ?? '', ...post.content.map(row=>row.map(x=>x.text ?? (x.tag==='at' ? `@${x.user_name ?? ''}` : '')).join(''))].join('\n');
  return body.file_name ?? (message.message_type === 'image' ? '[图片]' : `[${message.message_type ?? '消息'}]`);
}
export function normalize(event, botId) {
  const m=event.message, user=event.sender?.sender_id?.open_id;
  if (!m?.message_id || !user || event.sender.sender_type !== 'user') return null;
  const mentioned=(m.mentions??[]).some(x=>x.id?.open_id===botId);
  let text=extractText(m);
  for(const mention of m.mentions??[]) text=text.split(mention.key).join(mention.id?.open_id===botId?'':`@${mention.name}`);
  const scope=m.thread_id ? `topic:${m.chat_id}:${m.thread_id}` : m.chat_type==='p2p' ? `dm:${user}` : `group:${m.chat_id}`;
  return {id:m.message_id,scope,user,chatId:m.chat_id,topicId:m.thread_id??null,private:m.chat_type==='p2p',mentioned,text:text.trim(),message:m,status:'queued',marker:`[飞书消息:${m.message_id}]`};
}
export function command(text) {
  const reset=text.match(/^(?:新开对话|\/new)(?:\s+([\s\S]*))?$/i);
  if(reset) return {type:'new',text:reset[1]?.trim()??''};
  const project=text.match(/^\/项目\s+([^\n]+)(?:\n([\s\S]*))?$/);
  if(project) return {type:'project',name:project[1].trim(),text:project[2]?.trim()??''};
  if(/^\/(状态|status)$/i.test(text)) return {type:'status'};
  if(/^\/(启用本群|禁用本群)$/.test(text)) return {type:text.includes('启用')?'enable':'disable'};
  return {type:'message',text};
}
export function matchProjects(text, projects, aliases={}) {
  const lower=text.toLowerCase();
  return projects.filter(p=>p.projectKind==='local' && p.hostId==='local').filter(p=>{
    const names=[p.label,...(aliases[p.projectId]??[])];
    return names.some(name=>name && lower.includes(name.toLowerCase()));
  });
}
export function targetFor(project) {
  return project ? {type:'project',projectId:project.projectId,environment:{type:project.isGitRepository?'worktree':'local'}} : {type:'projectless'};
}
export function splitText(text, limit=5000) {
  const chars=Array.from(text), chunks=[];
  for(let i=0;i<chars.length;i+=limit) chunks.push(chars.slice(i,i+limit).join(''));
  return chunks.length?chunks:[''];
}
export function redact(text, secrets=[]) {
  let s=String(text??'');
  for(const key of secrets.filter(x=>x?.length>5)) s=s.split(key).join('[已隐藏凭证]');
  return s.replace(/((?:api[_-]?key|app[_-]?secret|access[_-]?token|authorization|password)\s*[:=]\s*)([^\s,;]+)/gi,'$1[已隐藏]').replace(/Bearer\s+[\w.\-]+/gi,'Bearer [已隐藏]');
}
