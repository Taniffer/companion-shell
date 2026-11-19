const main=document.querySelector('#main'),dialog=document.querySelector('#dialog'),dialogBody=document.querySelector('#dialog-body');
const state={overview:null,route:'home',id:null,renderedKey:'home:',navigationVersion:0,listResult:null,historyComplete:false,defaultRole:'assistant',showArchived:false,pairCode:'',pairAddress:'',pairExpires:0,searchInputs:{},task:null,captures:[],memories:[],selected:new Set(),query:'',drafts:{},pendingRequests:new Map(),staffingBusy:new Set(),loading:false,polling:false};
const labels={waiting_approval:'待桌面确认',waiting_input:'待你补充',queued:'已排队',starting:'正在准备',running:'正在处理',waiting:'专业工作进行中',syncing:'正在取回答复',delivered:'已交付',idle:'可以继续',uncertain:'需要核实投递',failed:'本轮未完成',interrupted:'已中断',paused:'已暂存'};
const roleNames={assistant:'助理',quant:'量化助理',product:'产品助理',life:'生活助理'};
const roleDescriptions={assistant:'理解你的偏好，直接处理日常问题，按需要协调专业工作。',quant:'梳理策略、数据和研究证据，把假设与验证结果说清楚。',product:'一起推进软件与产品，从需求到实现、检查和交付。',life:'整理生活资料、出行安排和准备事项，记住相关偏好。'};
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const short=(value,n=160)=>String(value??'').length>n?String(value).slice(0,n)+'…':String(value??'');
const date=value=>value?new Intl.DateTimeFormat('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(value)):'尚未更新';
const button=(name,action,primary=false,extra='')=>`<button type="button" class="${primary?'primary':''}" data-action="${action}" ${extra}>${name}</button>`;
const taskLink=(task,tab='task')=>`#${tab}/${task.id}`;
const badge=task=>`<span class="badge ${['uncertain','syncing'].includes(task.status)?'warn':['failed','interrupted'].includes(task.status)?'error':''}">${esc(businessLabel(task))}</span>`;
const source=task=>task.source==='feishu'?'飞书':task.imported?'Codex 桌面':'工作台';
let toastTimer;
function toast(message){const el=document.querySelector('#toast');el.textContent=message;el.hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.hidden=true,4200);}
async function legacyApi(path,{method='GET',data}={}){const response=await fetch(path,{method,credentials:'same-origin',headers:method==='GET'?{}:{'Content-Type':'application/json','X-Companion':'1'},body:data===undefined?undefined:JSON.stringify(data)});let value;try{value=await response.json();}catch{throw new Error('没有收到完整结果，请稍后重试');}if(!response.ok){if(response.status===401)throw new Error('请从电脑上的“启动伴随”入口重新打开工作台');throw new Error(value.error??'这次操作尚未完成');}return value;}
async function bootstrap(){const params=new URLSearchParams(location.hash.slice(1));const key=params.get('key');if(key){const response=await fetch('/api/session',{method:'POST',headers:{Authorization:'Bearer '+key,'X-Companion':'1'}});history.replaceState(null,'',location.pathname+'#home');if(!response.ok)throw new Error('启动链接已失效，请重新打开工作台');}await loadOverview();await route();}
function stash(){const field=document.querySelector('#message-input');if(field)state.drafts[state.renderedKey]=field.value;const role=document.querySelector('select[name=role]');if(role)state.defaultRole=role.value;}
function currentDraft(){return state.drafts[`${state.route}:${state.id??''}:${state.chatRole??''}`]??'';}
function inline(value){let output='',at=0;const expression=/\[([^\]]+)\]\(([^\s)]+)\)/g;for(const match of value.matchAll(expression)){output+=esc(value.slice(at,match.index));const href=match[2];output+=/^https?:\/\//i.test(href)?`<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(match[1])}</a>`:esc(match[1]);at=match.index+match[0].length;}output+=esc(value.slice(at));return output.replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>').replace(/`([^`]+)`/g,'<code>$1</code>');}
function prose(value){const lines=String(value??'').split('\n');let out='',code=null,list=false;for(const line of lines){if(line.startsWith('```')){if(list){out+='</ul>';list=false;}if(code!==null){out+='<pre><code>'+esc(code.join('\n'))+'</code></pre>';code=null;}else code=[];continue;}if(code!==null){code.push(line);continue;}if(/^\s*[-*]\s+/.test(line)){if(!list){out+='<ul>';list=true;}out+='<li>'+inline(line.replace(/^\s*[-*]\s+/,''))+'</li>';continue;}if(list){out+='</ul>';list=false;}if(/^#{1,4}\s/.test(line))out+='<h3>'+inline(line.replace(/^#+\s/,''))+'</h3>';else if(line.trim())out+='<p>'+inline(line)+'</p>';}if(list)out+='</ul>';if(code!==null)out+='<pre><code>'+esc(code.join('\n'))+'</code></pre>';return out;}
function composer({task=null}={}){
  const roleOptions=Object.entries(roleNames).map(([id,name])=>`<option value="${id}" ${state.defaultRole===id?'selected':''}>${name}</option>`).join('');
  const target=task?`发给${esc(roleNames[state.chatRole??task.role]??'助理')} · ${esc(task.title)}`:'想聊什么';
  const roleSelect=task?`<input type="hidden" name="role" value="${esc(state.chatRole??task.role)}">`:`<select name="role" aria-label="交流对象">${roleOptions}</select>`;
  return `<form id="message-form" class="composer"><label for="message-input">${target}</label><textarea id="message-input" name="goal" rows="3" placeholder="${task?'补充本次要求，或者接着聊……':'聊一句，或交代一件想推进的事……'}" maxlength="20000" required>${esc(currentDraft())}</textarea>${state.selected.size?`<div class="selected-materials">${state.selected.size} 条登记资料会随本次请求带上 ${button('清除','clear-selected')}</div>`:''}<div class="composer-footer"><div class="actions">${task?`<small>同一事项继续 · ${source(task)}</small>`:'<small>默认由助理处理，需要专业分工时由她安排。</small>'}${roleSelect}</div><button type="submit" class="primary">${task?'发送补充':'发送'} <span aria-hidden="true">↗</span></button></div></form>`;
}
function row(task){return `<div class="list-row"><div><div class="meta">${badge(task)}<span>${esc(roleNames[task.role]??'助理')} · ${source(task)}</span></div><h3><a href="${taskLink(task)}">${esc(task.title)}</a></h3><p class="excerpt">${esc(short(task.summary||task.lastRequest,160))}</p><p>${date(task.updatedAt)}</p></div><div class="actions"><a class="button" href="${taskLink(task)}">进展</a><a class="button" href="${taskLink(task,'chat')}">继续聊</a></div></div>`;}
function empty(message,sub=''){return `<div class="empty"><p>${message}</p>${sub?`<p><small>${sub}</small></p>`:''}</div>`;}
function legacyThings(chats=false){const all=state.listResult?.tasks??state.overview?.tasks??[];const query=state.query.toLowerCase();const tasks=all.filter(t=>(state.showArchived?!!t.archived:!t.archived)&&(!chats||t.threadId)&&(!query||(t.title+' '+(t.summary??'')).toLowerCase().includes(query)));return `<div class="page-head"><div><h1>${chats?'对话':'事情'}</h1><p>${chats?'从原来的交流继续，随时回到相关事项。':'按目标找到进度、下一步和交付。'}</p></div>${button('交代一件新事','new',true)}</div><form class="search-row" id="task-search"><input type="search" name="q" aria-label="查找事项或对话" placeholder="找一件事……" value="${esc(state.query)}"><button type="submit">查找</button>${button('刷新桌面列表','refresh-list')}${button(state.showArchived?'返回进行中':'已归档','show-archived')}</form><div class="list">${tasks.length?tasks.map(row).join(''):empty('还没有找到这件事。','也可以直接交代给助理。')}</div><div class="actions spaced">${state.listResult?.hasMore?button('加载更多事项','more-tasks'):''}${state.historyComplete?'<small>已接入当前可读的桌面历史</small>':button('载入更早的 Codex 对话','more-history')}</div><p class="subtitle spaced">这里汇总已接入的桌面对话与工作台事项，打开后读取实际进展。</p>`;}
function taskPage(chat=false){const task=state.task;if(!task)return '<div class="loading">正在找回当前进展……</div>';const children=task.children??[];const artifacts=task.artifacts??[];const progress=`<div class="progress-block"><h3>当前进展</h3><p>${esc(task.summary||'当前尚无新的公开进度。可以继续交代，或打开原桌面对话。')}</p><ol class="step-list"><li class="complete"><div>目标已保留<p class="muted">${esc(task.lastRequest||task.title)}</p></div></li><li class="${task.status==='delivered'?'complete':''}"><div>${esc(labels[task.status]??task.status)}<p class="muted">${task.lastObservedAt?'上次核实：'+date(task.lastObservedAt):'以实际桌面进展为准'}</p></div></li>${artifacts.length?'<li class="complete">已有 '+artifacts.length+' 份成果快照</li>':''}</ol></div>${children.length?`<section class="section"><div class="section-title"><h2>参与这件事的专业工作</h2></div><div class="list">${children.map(row).join('')}</div></section>`:''}${artifacts.length?`<section class="section"><div class="section-title"><h2>材料与成果</h2></div><div class="list">${artifacts.map(a=>`<div class="list-row"><div><h3>${esc(a.name)}</h3><p>${date(a.createdAt)} · 已保留快照</p></div><div class="actions">${button('查看','preview',false,`data-id="${a.id}"`)}<a class="button" href="/api/artifacts/${a.id}">下载</a></div></div>`).join('')}</div></section>`:''}`;const messages=task.messages??[];const conversation=`${messages.length?`<div class="chat">${messages.map(m=>`<article class="message ${m.role==='user'?'user':''}"><div class="speaker">${m.role==='user'?'你':esc(roleNames[m.actorRole??state.chatRole??task.role]??'助理')}${m.phase==='commentary'?' · 进度':''}</div><div class="prose">${prose(m.text)}</div></article>`).join('')}</div>`:empty('尚无可显示的公开消息。','桌面正在处理时，公开进度和答复会逐渐出现。')}<div class="spaced">${composer({task})}</div>`;return `<div class="page-head"><div><div class="meta">${task.parentId?`<a href="#task/${task.parentId}">← 回到总事项</a>`:`<a href="#home">← 助理首页</a>`}<span>${esc(roleNames[task.role]??'助理')}</span>${badge(task)}</div><h1 class="spaced">${esc(task.title)}</h1></div><div class="actions">${button('在 Codex 中打开','open-native',false,`data-id="${task.id}"`)}${button('刷新','refresh-task')}</div></div>${task.status==='waiting_approval'?`<div class="notice warn">Codex 正在等待你确认一项操作。 ${button('打开待确认对话','open-native',false,`data-id="${esc(task.id)}" data-role="${esc(task.attentionRole??task.role)}"`)}</div>`:''}${task.readError?`<div class="notice warn">${esc(task.readError)}</div>`:''}<div class="work-layout"><div class="work-main"><nav class="tabs" aria-label="事项页面"><a class="${chat?'':'active'}" href="#task/${task.id}?role=${encodeURIComponent(state.chatRole??task.role)}">进展与成果</a><a class="${chat?'active':''}" href="#chat/${task.id}?role=${encodeURIComponent(state.chatRole??task.role)}">和${esc(roleNames[state.chatRole??task.role]??'助理')}聊</a></nav>${staffingCards(task.id)}${chat?conversation:progress}</div><aside class="work-side"><section><h3>这次要做什么</h3><p>${esc(task.lastRequest||task.title)}</p><div class="meta spaced">来源：${source(task)}${task.private===false?' · 群／话题范围':''}</div></section><section><h3>继续处理</h3><div class="actions"><a class="button primary" href="#${chat?'task':'chat'}/${task.id}?role=${encodeURIComponent(state.chatRole??task.role)}">${chat?'查看同一事项进展':'继续交代'}</a></div>${task.parentId?`<div class="actions"><a href="#chat/${task.parentId}">交给助理继续协调</a></div>`:''}<div class="actions">${button(task.status==='paused'?'继续推进':'暂存安排',task.status==='paused'?'resume':'pause',false,`data-id="${task.id}"`)}${button(task.archived?'取消归档':'归档','archive',false,`data-id="${task.id}"`)}</div><div class="actions spaced">${button(task.businessState==='completed'?'重新打开':'标记完成',task.businessState==='completed'?'reopen-task':'complete-task',false,`data-id="${task.id}"`)}${button('请助理汇总','task-secretary')}</div><details class="task-controls"><summary>更多操作</summary>${button('交接负责人','assign-task')}</details></section>${children.length?`<section><h3>直接找专业伙伴</h3>${children.map(c=>`<p><a href="#chat/${c.id}">${esc(roleNames[c.role]??c.title)}</a> · ${esc(labels[c.status]??c.status)}</p>`).join('')}</section>`:''}</aside></div>`;}
function materials(){return `<div class="page-head"><div><h1>记下的资料</h1><p>保存不等于派活。需要时找回，带进同一件事。</p></div>${button('记一下','capture',true)}</div><form class="search-row" id="capture-search"><input type="search" name="q" value="${esc(state.query)}" placeholder="找回一个链接、一段话……" aria-label="搜索登记资料"><button type="submit">找回</button>${state.selected.size?button('带给助理（'+state.selected.size+'）','use-selected',true):''}</form>${state.captures.length?`<div class="capture-grid">${state.captures.map(c=>`<article class="capture-card"><label><input type="checkbox" data-select-capture="${c.id}" ${state.selected.has(c.id)?'checked':''}><h3>${esc(c.title)}</h3></label><p>${esc(c.text)}</p>${c.url&&/^https?:\/\//.test(c.url)?`<a href="${esc(c.url)}" target="_blank" rel="noopener noreferrer">打开原链接 ↗</a>`:''}${c.attachments.map((a,i)=>`<img loading="lazy" src="/api/captures/${c.id}/image/${i}" alt="登记的图片 ${i+1}">`).join('')}<div class="meta spaced">${date(c.createdAt)} · ${esc(c.source)}</div><small>${esc(c.coverage)}</small></article>`).join('')}</div>`:empty('还没有资料。','可以在电脑记一句，也可以安装 APK，从手机分享进来。')}`;}
function more(){const pages=[['记下的资料','materials','找回文字、链接与图片'],['关于我的理解','memory','查看、纠正和限定记忆的适用范围'],['协作与飞书','partners','查看协作人员和独立飞书入口'],['连接手机','connect','配对“记一下”APK，查看已连接设备'],['技能与经验','skills','保留可靠方法，按需要调用'],['数据与连接','settings','查看真实连接状态，导出个人积累']];return `<div class="page-head"><div><h1>更多</h1><p>需要的时候，再展开。</p></div></div><div class="more-grid">${pages.map(([label,route,detail])=>`<a href="#${route}" class="more-link"><h2>${label}</h2><p>${detail}</p></a>`).join('')}</div>`;}
function memories(){return `<div class="page-head"><div><h1>关于我的理解</h1><p>明确记下的偏好，可以修正，也可以只用于一件事。</p></div>${button('告诉助理一件偏好','new-memory',true)}</div>${state.memories.length?state.memories.map(m=>`<article class="memory-card"><div class="meta"><span class="badge">${m.enabled===false?'已停用':m.scope==='task'?'仅指定事项':m.scope==='project'?'仅指定项目':m.scope==='role'?'仅'+esc(roleNames[m.roleId]??m.roleId):'个人共同偏好'}</span><span>${esc(m.source)}</span></div><p>${esc(m.text)}</p><div class="actions">${button('修正','edit-memory',false,`data-id="${m.id}"`)}${button(m.enabled===false?'重新使用':'暂不使用','toggle-memory',false,`data-id="${m.id}"`)}</div></article>`).join(''):empty('可以从一句明确的偏好开始。','登记资料与长期记忆分开保留，不把看过的内容直接当成你的决定。')}`;}
function pairResult(){return state.pairCode?`<label for="pair-code">在手机“记一下”的连接页粘贴以下内容：</label><textarea id="pair-code" class="pair-code" readonly>${esc(state.pairCode)}</textarea><div class="actions spaced">${button('复制配对信息','copy-pair',true)}<small>${state.pairExpires>Date.now()?'十分钟内有效，成功一次后失效。':'这份配对信息已过期，请重新生成。'}</small></div>`:'';}
function connect(){const devices=state.overview?.devices??[],addresses=state.overview?.addresses??[];const selectedAddress=state.pairAddress||(addresses.find(a=>!a.privateNetwork)??addresses[0])?.address;return `<div class="page-head"><div><h1>连接手机</h1><p>安装独立“记一下”APK，先存手机，连接后送到电脑。</p></div></div><div class="narrow"><div class="actions spaced"><a class="button" href="/api/apk">下载 Android 安装包</a><small>也可在飞书私聊发送 /安装包，把文件直接收在手机上。</small></div><section class="progress-block"><h2>配对你的记录入口</h2><p class="subtitle">手机与电脑需要互相可达。同一 Wi-Fi 可选本地地址；已使用 Tailscale 的设备可选对应私网地址。</p><form id="pair-form" class="form-stack"><label>电脑地址<select name="address">${addresses.map(a=>`<option value="${esc(a.address)}" ${selectedAddress===a.address?'selected':''}>${esc(a.address)} · ${esc(a.name)}</option>`).join('')||'<option value="127.0.0.1">暂无可用网络地址</option>'}</select></label><div>${button('生成一次性配对信息','generate-pair',true)}</div></form><div id="pair-result" class="spaced">${pairResult()}</div></section><section class="section"><h2>已连接的设备</h2>${devices.length?devices.map(d=>`<div class="device-row"><div><h3>${esc(d.name)}</h3><small>上次同步 ${date(d.lastSeenAt)}</small></div>${button('断开设备','revoke-device',false,`data-id="${d.id}"`)}</div>`).join(''):empty('还没有设备配对。')}</section></div>`;}
function settings(){const info=state.overview??{};return `<div class="page-head"><div><h1>数据与连接</h1><p>个人积累留在自己的电脑，支持导出。</p></div></div><div class="narrow"><div class="list"><div class="list-row"><div><h3>Codex 桌面版</h3><p>${esc(info.warning||'使用真实桌面对话，保留原来的工具与配置。')}</p></div></div><div class="list-row"><div><h3>飞书</h3><p>${info.bridge?.feishuConnected?'已连接现有机器人':'连接状态待核实'} · ${info.bridge?.ownerPaired?'已绑定用户':'尚未绑定用户'}</p></div></div><div class="list-row"><div><h3>登记资料</h3><p>${info.captureCount??0} 条 · 不会因关闭页面而消失</p></div><a class="button" href="#materials">查看</a></div></div><section class="section"><h2>带走自己的积累</h2><p class="subtitle">包含本地登记资料、图片、记忆、已保存消息和成果版本。不包含登录密钥与设备令牌。</p><a class="button primary" href="/api/export">导出个人资料包</a></section><section class="section"><h2>飞书中的简短入口</h2><p class="subtitle">私聊使用 /记 内容、/资料 关键词、/任务、/新任务 目标。也可以直接说“找上周那个任务”或“继续昨天那件事，补充要求”。</p></section></div>`;}
function skills(){return `<div class="page-head"><div><h1>技能与经验</h1><p>继续使用 Codex 中已有的技能与工具。</p></div></div><div class="notice">当前由专业伙伴在原生桌面环境调用已有技能。首版保留任务证据与成果，不把每次成功自动写成长期规则。</div><a class="button" href="#partners">找专业伙伴</a>`;}
function render(force=false){if(dialog.open)return;const active=document.activeElement;if(!force&&active?.matches('input,textarea,select'))return;stash();const routes={home,tasks:()=>things(false),chats:()=>things(true),task:()=>taskPage(false),chat:()=>taskPage(true),materials,more,memory:memories,partners,connect,settings,skills};main.innerHTML=(routes[state.route]??home)();state.renderedKey=`${state.route}:${state.id??''}:${state.chatRole??''}`;document.querySelector('#page-label').textContent=({home:'任务看板',tasks:'任务列表',chats:'对话',task:'事情 / 进展',chat:'对话 / 继续',materials:'资料',more:'更多',memory:'关于我的理解',partners:'专业伙伴',connect:'连接手机',settings:'数据与连接',skills:'技能与经验'})[state.route]??'助理';const section=['task','tasks'].includes(state.route)?'tasks':['chat','chats'].includes(state.route)?'chats':['home','partners','materials'].includes(state.route)?state.route:'more';document.querySelectorAll('[data-nav]').forEach(a=>{if(a.dataset.nav===section)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');});const online=state.overview?.bridge?.feishuConnected;document.querySelector('#connection').innerHTML=`<span class="dot ${online?'online':''}"></span>${online?'飞书已连接':'飞书连接待核实'}`;}
async function legacyLoadList(append=false){
  const version=state.navigationVersion,routeName=state.route,query=state.query,archived=state.showArchived;
  const params=new URLSearchParams({q:query,offset:String(append?state.listResult?.nextOffset??0:0),archived:archived?'1':'0',chats:routeName==='chats'?'1':'0'});
  const value=await api('/api/tasks?'+params);
  if(version!==state.navigationVersion||query!==state.query||archived!==state.showArchived)return false;
  state.listResult=append?{...value,tasks:[...new Map([...(state.listResult?.tasks??[]),...value.tasks].map(task=>[task.id,task])).values()]}:value;
  return true;
}
async function route(){
  stash();if(dialog.open)dialog.close();
  const version=++state.navigationVersion;
  const [hashPath,hashQuery]=location.hash.slice(1).split('?');const [name,id]=hashPath.split('/');state.chatRole=new URLSearchParams(hashQuery??'').get('role');
  state.route=name||'home';if(state.route==='tasks')state.boardView='list';state.id=id??null;state.query=state.searchInputs[state.route]??'';
  const currentRoute=state.route,currentId=state.id;
  if(currentRoute==='home'){await loadBoard();}else if(['task','chat'].includes(currentRoute)&&currentId){
    state.task=null;main.innerHTML='<div class="loading">正在接回同一件事……</div>';
    const [result]=await Promise.all([api('/api/tasks/'+encodeURIComponent(currentId)),loadOverview()]);
    if(version!==state.navigationVersion)return;
    state.task=result.task;
  }else if(['tasks','chats'].includes(currentRoute)){
    if(!await loadList())return;
  }else if(currentRoute==='materials'){
    const result=await api('/api/captures?q='+encodeURIComponent(state.query));
    if(version!==state.navigationVersion)return;
    state.captures=result.captures;
  }else if(currentRoute==='memory'){
    const result=await api('/api/memories');
    if(version!==state.navigationVersion)return;
    state.memories=result.memories;
  }
  if(version===state.navigationVersion)render(true);
}
function openDialog(content){dialogBody.innerHTML=content;dialog.showModal();dialog.querySelector('textarea,input')?.focus();}
function captureDialog(){openDialog(`<h2>记一下</h2><p class="subtitle">先留住，不必分类，也不会自动派活。</p><form id="capture-form" class="form-stack"><label for="capture-text">内容<textarea id="capture-text" name="text" rows="6" maxlength="20000" placeholder="一段话、一个链接，或者眼前的想法……"></textarea></label><label>附上图片<input type="file" name="images" accept="image/png,image/jpeg,image/gif,image/webp" multiple></label><small>最多 3 张，单张 8 MB，总共 16 MB。</small><div class="actions end">${button('取消','close-dialog')}<button class="primary" type="submit">记下</button></div></form>`);}
function memoryDialog(id){const existing=state.memories.find(m=>m.id===id);const value=existing??{id:crypto.randomUUID(),text:'',scope:'personal',enabled:true};openDialog(`<h2>${existing?'修正理解':'告诉助理一件偏好'}</h2><p class="subtitle">明确适用范围，今后也能改。</p><form id="memory-form" data-id="${esc(value.id)}" class="form-stack"><input type="hidden" name="enabled" value="${value.enabled===false?'false':'true'}"><label>内容<textarea name="text" rows="4" maxlength="3000" required>${esc(value.text)}</textarea></label><label>适用范围<select name="scope"><option value="personal" ${value.scope==='personal'?'selected':''}>个人共同偏好</option><option value="task" ${value.scope==='task'?'selected':''}>只用于指定事项</option><option value="role" ${value.scope==='role'?'selected':''}>只用于指定角色</option><option value="project" ${value.scope==='project'?'selected':''}>只用于指定项目</option></select></label><label>指定角色<select name="roleId">${(state.overview.roles??[]).map(r=>`<option value="${r.id}" ${value.roleId===r.id?'selected':''}>${esc(r.name)}</option>`).join('')}</select></label><label>项目编号（仅项目记忆使用）<input name="projectId" value="${esc(value.projectId??'')}"></label><label>指定事项（仅此事项时选择）<select name="taskId"><option value="">请选择</option>${(state.overview?.tasks??[]).map(t=>`<option value="${t.id}" ${value.taskId===t.id?'selected':''}>${esc(t.title)}</option>`).join('')}</select></label><div class="actions end">${button('取消','close-dialog')}<button class="primary" type="submit">保存理解</button></div></form>`);}
async function fileBase64(file){return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=reject;reader.readAsDataURL(file);});}
async function submitMessage(form){
  const submit=form.querySelector('button[type=submit]');if(submit.disabled)return;submit.disabled=true;
  const values=new FormData(form),goal=String(values.get('goal')??'').trim();
  const origin={id:state.id,route:state.route,key:state.renderedKey,version:state.navigationVersion};
  const captureIds=[...state.selected],role=values.get('role')??'assistant';
  const key=JSON.stringify({goal,id:origin.id,role,captures:captureIds});
  let requestId=state.pendingRequests.get(key);if(!requestId){requestId=crypto.randomUUID();state.pendingRequests.set(key,requestId);}
  try{
    const endpoint=origin.id&&['task','chat'].includes(origin.route)?`/api/tasks/${origin.id}/messages`:'/api/tasks';
    const value=await api(endpoint,{method:'POST',data:{goal,role,captureIds,requestId}});
    state.pendingRequests.delete(key);
    const input=form.querySelector('#message-input');
    if(input.value.trim()===goal){state.drafts[origin.key]='';input.value='';}else state.drafts[origin.key]=input.value;
    for(const id of captureIds)state.selected.delete(id);
    toast('已交代，正在接到 Codex 桌面。');
    loadOverview().catch(()=>{});
    if(origin.version===state.navigationVersion){
      const nextHash='chat/'+value.task.id+'?role='+encodeURIComponent(role);if(location.hash==='#'+nextHash)await route();else location.hash=nextHash;
    }
  }finally{submit.disabled=false;}
}
document.addEventListener('submit',async event=>{const form=event.target;if(!(form instanceof HTMLFormElement))return;event.preventDefault();try{if(form.id==='message-form')await submitMessage(form);else if(form.id==='task-search'){state.query=new FormData(form).get('q')??'';if(await loadList())render(true);}else if(form.id==='capture-search'){state.query=new FormData(form).get('q')??'';state.captures=(await api('/api/captures?q='+encodeURIComponent(state.query))).captures;render();}else if(form.id==='capture-form'){const values=new FormData(form),files=[...form.querySelector('input[type=file]').files];if(files.length>3||files.some(f=>f.size>8*1024*1024)||files.reduce((n,f)=>n+f.size,0)>16*1024*1024)throw new Error('最多 3 张图片，单张 8 MB，总共 16 MB');const submit=form.querySelector('button[type=submit]');submit.disabled=true;try{const attachments=await Promise.all(files.map(async f=>({name:f.name,mime:f.type,base64:await fileBase64(f)})));const payload={text:values.get('text'),source:'windows',attachments};const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(payload)));const captureKey=Array.from(new Uint8Array(digest),v=>v.toString(16).padStart(2,'0')).join('');if(form.dataset.captureKey!==captureKey){form.dataset.captureKey=captureKey;form.dataset.captureId=crypto.randomUUID();form.dataset.createdAt=String(Date.now());}await api('/api/captures',{method:'POST',data:{...payload,id:form.dataset.captureId,createdAt:Number(form.dataset.createdAt)}});if(dialog.contains(form)&&dialog.open)dialog.close();toast('已记下。');await loadOverview();if(state.route==='materials')state.captures=(await api('/api/captures')).captures;render();}finally{submit.disabled=false;}}else if(form.id==='memory-form'){if(form.dataset.submitting==='1')return;form.dataset.submitting='1';const values=Object.fromEntries(new FormData(form));values.enabled=values.enabled!=='false';if(form.dataset.id)values.id=form.dataset.id;await api('/api/memories',{method:'POST',data:values});if(dialog.contains(form)&&dialog.open)dialog.close();state.memories=(await api('/api/memories')).memories;render();toast('理解已更新，后续相关工作会采用新范围。');}}catch(error){form.dataset.submitting='0';toast(error.message);}});
document.addEventListener('click',async event=>{const node=event.target.closest('[data-action]');if(!node)return;const action=node.dataset.action;try{if(action==='capture')captureDialog();else if(action==='connect')location.hash='connect';else if(action==='close-dialog')dialog.close();else if(action==='new'){roleMessageDialog('assistant');}else if(action==='clear-selected'){event.preventDefault();state.selected.clear();document.querySelector('#selected-summary')?.remove();stash();document.activeElement?.blur();render();}else if(action==='use-selected')roleMessageDialog('assistant');else if(action==='show-archived'){state.showArchived=!state.showArchived;if(await loadList())render(true);}else if(action==='resume'){const id=node.dataset.id,version=state.navigationVersion;const value=await api(`/api/tasks/${id}/resume`,{method:'POST',data:{}});if(version===state.navigationVersion&&state.id===id){state.task={...state.task,...value.task};render(true);}toast('已继续原来的安排。');}else if(action==='refresh-list'){await loadOverview();if(await loadList())render(true);toast('已刷新桌面对话。');}else if(action==='more-tasks'){if(await loadList(true))render(true);}else if(action==='more-history'){node.disabled=true;try{const value=await api('/api/history',{method:'POST',data:{}});state.historyComplete=value.complete;if(['tasks','chats'].includes(state.route)&&await loadList())render(true);toast(value.added?'已接入 '+value.added+' 条桌面对话。':value.complete?'当前可读的历史已接入。':'这一页已存在，可以继续载入。');}finally{node.disabled=false;}}else if(action==='refresh-task'){const id=state.id,version=state.navigationVersion;const value=await api(`/api/tasks/${id}?refresh=1`);if(version===state.navigationVersion&&id===state.id){state.task=value.task;render(true);}}else if(action==='open-native'){await api(`/api/tasks/${node.dataset.id}/open`,{method:'POST',data:{role:node.dataset.role??state.chatRole??state.task?.role}});toast('已在 Codex 中打开原对话。');}else if(action==='pause'){const id=node.dataset.id,version=state.navigationVersion;const value=await api(`/api/tasks/${id}/pause`,{method:'POST',data:{}});if(version===state.navigationVersion&&state.id===id){state.task={...state.task,...value.task};render(true);}toast('尚未执行的安排已暂存。');}else if(action==='archive'){const version=state.navigationVersion;await api(`/api/tasks/${node.dataset.id}/archive`,{method:'POST',data:{}});await loadOverview();if(version===state.navigationVersion)location.hash='tasks';}else if(action==='preview'){openDialog(`<h2>成果快照</h2><p class="subtitle">保留当时交付，后续修改可以回到原事项继续。</p><iframe class="artifact-frame" title="成果预览" sandbox="allow-scripts" src="/api/artifacts/${node.dataset.id}?preview=1"></iframe><div class="actions end spaced"><a class="button" href="/api/artifacts/${node.dataset.id}">下载</a>${button('关闭','close-dialog')}</div>`);}else if(action==='new-memory')memoryDialog();else if(action==='edit-memory')memoryDialog(node.dataset.id);else if(action==='toggle-memory'){const value=state.memories.find(m=>m.id===node.dataset.id);await api('/api/memories',{method:'POST',data:{...value,enabled:value.enabled===false}});state.memories=(await api('/api/memories')).memories;render();}else if(action==='generate-pair'){node.disabled=true;try{const address=document.querySelector('#pair-form select').value;state.pairAddress=address;const value=await api('/api/pairing',{method:'POST',data:{address}});state.pairCode=value.code;state.pairExpires=value.expires;if(state.route==='connect')document.querySelector('#pair-result').innerHTML=pairResult();}finally{node.disabled=false;}}else if(action==='copy-pair'){const field=document.querySelector('#pair-code');try{await navigator.clipboard.writeText(field.value);toast('配对信息已复制。');}catch{field.select();toast('已选中，按 Ctrl+C 复制。');}}else if(action==='revoke-device'){await api(`/api/devices/${node.dataset.id}/revoke`,{method:'POST',data:{}});await loadOverview();render();toast('设备已断开，原有记录保留。');}}catch(error){toast(error.message);}});
document.addEventListener('change',event=>{const id=event.target.dataset?.selectCapture;if(!id)return;if(event.target.checked)state.selected.add(id);else state.selected.delete(id);render(true);});
document.addEventListener('input',event=>{if(event.target.matches('input[type=search]'))state.searchInputs[state.route]=event.target.value;});
window.addEventListener('hashchange',()=>{
  const pending=route(),version=state.navigationVersion;
  pending.catch(error=>{
    if(version===state.navigationVersion&&!dialog.open)main.innerHTML=`<div class="notice warn">${esc(error.message)}</div>`;
  });
});
setInterval(async()=>{
  if(document.hidden||state.polling||dialog.open||document.activeElement?.matches('input,textarea,select'))return;
  state.polling=true;const version=state.navigationVersion,id=state.id,routeName=state.route;
  try{
    if(['task','chat'].includes(routeName)&&id){const [value]=await Promise.all([api('/api/tasks/'+id),loadOverview()]);if(version!==state.navigationVersion)return;state.task=value.task;}
    else if(['home','settings','connect'].includes(routeName))await loadOverview();
    else if(['tasks','chats'].includes(routeName)){if((state.listResult?.tasks.length??0)<=60)await loadList();}
    if(version===state.navigationVersion)render();
  }catch{}finally{state.polling=false;}
},7000);
bootstrap().catch(error=>{main.innerHTML=`<div class="page-head"><div><h1>伴随工作台</h1><p>${esc(error.message)}</p></div></div><p class="muted">从电脑上的“启动伴随.cmd”打开，可以自动接回本机工作台。</p>`;});

// V2: one task fact, independent role conversations and a full task board.
Object.assign(state,{overviewSeq:0,board:null,boardRole:'all',boardView:'board',boardQuery:'',boardSequence:0,includeChats:false,chatRole:null});
const buckets=[['running','运行中'],['unfinished','未完成'],['completed','已完成']];
function businessLabel(task){if(task.businessState==='completed')return '已完成';if(task.businessState==='waiting_user')return '待你补充';return task.status==='delivered'?'已交付':labels[task.status]??'未完成';}
async function api(path,options={}){if((!options.method||options.method==='GET')&&/^\/api\/tasks\/[0-9a-f-]+(?:\?|$)/i.test(path)&&state.chatRole)path+=(path.includes('?')?'&':'?')+'role='+encodeURIComponent(state.chatRole);return legacyApi(path,options);}
async function loadOverview(){
  const sequence=++state.overviewSeq;
  const overview=await api('/api/overview');
  if(sequence!==state.overviewSeq)return;
  state.overview=overview;
  for(const role of overview.roles??[]){roleNames[role.id]=role.name;roleDescriptions[role.id]=role.brief;}
  if(['home','tasks'].includes(state.route))await loadBoard();
}
async function loadBoard(appendBucket=null){
  const seq=++state.boardSequence,version=state.navigationVersion;
  const boardOptions=()=>JSON.stringify([state.boardRole,state.boardQuery,state.showArchived,state.includeChats,state.searchDesktop]);
  const signature=boardOptions();
  const params=new URLSearchParams({role:state.boardRole,archived:state.showArchived?'1':'0',includeChats:state.includeChats?'1':'0'});
  if(!appendBucket&&state.board){
    for(const [bucket,column] of Object.entries(state.board.columns))params.set(bucket+'Limit',String(Math.max(20,column.tasks.length)));
  }
  if(appendBucket)params.set(appendBucket+'Offset',String(state.board?.columns[appendBucket]?.nextOffset??0));
  const [result,search]=await Promise.all([
    api('/api/board?'+params),
    state.boardQuery?api('/api/task-find?'+new URLSearchParams({q:state.boardQuery,role:state.boardRole,includeChats:state.includeChats||state.searchDesktop?'1':'0'})):null
  ]);
  if(seq!==state.boardSequence||version!==state.navigationVersion||signature!==boardOptions())return false;
  if(appendBucket&&state.board){
    const next=result.columns[appendBucket];
    const tasks=[...new Map([...state.board.columns[appendBucket].tasks,...next.tasks].map(task=>[task.id,task])).values()];
    state.board={...result,columns:{...state.board.columns,[appendBucket]:{...next,tasks}}};
  }else state.board=result;
  state.taskSearch=search;
  renderRoleNav();
  return true;
}
async function loadList(append=false){if(state.route==='chats')return legacyLoadList(append);return loadBoard();}
function renderRoleNav(){
  const el=document.querySelector('#role-nav');
  const opened=el.querySelector('details')?.open??true;
  const roles=state.board?.roles??[];
  const entries=[{id:'all',name:'全部角色',counts:state.board?.allCounts??{}},
    ...roles.filter(r=>r.status!=='retired'&&(r.status==='active'||r.counts.total>0))];
  el.innerHTML=`<details class="role-filter" ${opened?'open':''}><summary>按角色查看</summary>
    ${entries.map(r=>`<button data-action="filter-role" data-role="${esc(r.id)}" class="role-nav ${state.boardRole===r.id?'selected':''}">
      <span><i class="role-dot ${esc(r.id)}"></i>${esc(r.name)}</span><small>${r.counts.total??0}</small></button>`).join('')}
  </details>`;
}
function card(task){const label=businessLabel(task);return `<article class="board-card"><div class="board-card-meta"><span><i class="role-dot ${esc(task.role)}"></i>${esc(roleNames[task.role]??'助理')}</span><span class="task-state ${task.businessState==='waiting_user'?'attention':''}">${esc(label)}</span></div><h3><a href="#task/${task.id}">${esc(task.title)}</a></h3><p class="excerpt">${esc(short(task.summary||task.lastRequest||'目标已保留，随时接着说。',130))}</p>${task.parentId?`<a class="parent-link" href="#task/${task.parentId}">↳ 关联总事项</a>`:''}<div class="board-card-bottom"><span>${date(task.updatedAt)}</span><a href="#chat/${task.id}?role=${encodeURIComponent(task.role)}">${task.businessState==='waiting_user'?'补充信息':'接着聊'} ↗</a></div></article>`;}
function boardPage(){const board=state.board;if(!board)return '<div class="loading">正在接回任务看板……</div>';const role=board.roles.find(r=>r.id===state.boardRole),name=role?.name??'所有任务',tasks=buckets.flatMap(([id])=>board.columns[id].tasks).sort((a,b)=>b.updatedAt-a.updatedAt);return `<div class="board-heading"><div><h1>${esc(name)}</h1>
  <p>${state.showArchived?'已归档的事仍能接着做。':'交代一件事，随时接着做。'}</p></div>
  ${button('＋ 交代一件事','create-task',true)}</div>
  ${state.overview?.warning?`<div class="notice warn">${esc(state.overview.warning)}</div>`:''}
  ${state.showArchived?'':staffingCards()}
  <form id="board-search" class="board-toolbar">
    <div class="board-search"><input name="q" type="search" aria-label="搜索任务" value="${esc(state.boardQuery)}" placeholder="找任务，例如上周那个回测"><button type="submit">找任务</button></div>
    <div class="view-switch">${button('看板','board-view',false,'data-view="board"')}${button('列表','board-view',false,'data-view="list"')}</div>
    <label class="include-chats"><input id="include-chats" type="checkbox" ${state.includeChats?'checked':''}>包含桌面对话</label>
    ${button('刷新','board-refresh')}
  </form>${state.boardQuery?taskSearchResults():state.boardView==='board'?`<div class="kanban">${buckets.map(([id,label])=>`<section class="kanban-column ${id}"><div class="column-heading"><h2><i></i>${label}<span>${board.counts[id]}</span></h2>${id==='unfinished'?'<small>含排队与等待补充</small>':''}</div><div class="column-cards">${board.columns[id].tasks.map(card).join('')||empty(id==='running'?'现在没有执行中的任务':id==='unfinished'?'没有待推进的事项':'已确认完成的任务会留在这里')}</div>${board.columns[id].hasMore?button('加载更多（'+board.columns[id].total+'）','board-more',false,`data-bucket="${id}"`):''}</section>`).join('')}</div>`:`<div class="board-list"><div class="board-list-head"><span>任务 / 最近进展</span><span>负责人</span><span>状态</span><span>最近更新</span></div>${tasks.map(task=>`<a href="#task/${task.id}" class="board-list-row"><span><b>${esc(task.title)}</b><small>${esc(short(task.summary||task.lastRequest,100))}</small></span><span><i class="role-dot ${esc(task.role)}"></i>${esc(roleNames[task.role])}</span><span>${esc(businessLabel(task))}</span><span>${date(task.updatedAt)}</span></a>`).join('')||empty('还没有任务。可以交代一句，或先记下资料。')}<div class="actions spaced">${buckets.filter(([id])=>board.columns[id].hasMore).map(([id,name])=>button('更多'+name,'board-more',false,`data-bucket="${id}"`)).join('')}</div></div>`}<div class="board-foot"><span>${state.boardQuery?'包含已归档任务':board.counts.total+' 项'}</span><div class="actions">${button(state.showArchived?'返回活动任务':'查看归档','board-archived')}<a href="#chats">查看全部 Codex 对话 ↗</a></div></div>`;}
function home(){return boardPage();}
function things(chats=false){return chats?legacyThings(true):boardPage();}
function partners(){
  const roles=(state.overview?.roles??[]).filter(r=>r.status!=='available');
  return `<div class="page-head"><div><h1>协作与飞书</h1><p>助理负责分工和交付。需要深入时，可以直接找参与者。</p></div></div>
    ${staffingCards()}
    <div class="role-grid">${roles.map(roleCard).join('')}</div>`;
}
function roleCard(role){
  const ref=`data-role="${esc(role.id)}"`;
  const status=role.status==='retiring'?'已确认 · 正在接回工作':role.status==='retired'?'工作已并回助理':
    role.paired&&role.botConnected?'飞书已连接':role.appId?'飞书入口待核验':'工作台可用';
  const running=role.status==='active';
  const platformAction=role.id==='assistant'?'核验飞书菜单与卡片':role.appId?'核验飞书入口':'开通飞书直聊';
  const registration=running&&role.registrationUrl?`<div class="registration"><p>${esc(role.registrationMessage??'请在飞书完成开通确认')}</p>
    <img alt="用飞书扫描确认开通" src="/api/roles/${esc(role.id)}/qr">
    <a class="button primary" href="${esc(role.registrationUrl)}" target="_blank" rel="noopener noreferrer">打开飞书确认页面</a></div>`:'';
  return `<article class="role-card ${role.status==='retired'?'retired':''}"><h2>${esc(role.name)}</h2>
    <p>${esc(short(role.brief,170))}</p><div class="role-status">${status}</div>${registration}
    ${role.pairCode&&running?`<p class="pair-hint">在这只机器人私聊发送 <code>绑定 ${esc(role.pairCode)}</code></p>`:''}
    <div class="actions">
      ${running?button('直接聊','role-chat',true,ref)+button(platformAction,'role-provision',false,ref):''}
      ${running&&role.id!=='assistant'?button('并回助理','role-retire',false,ref):''}
      ${running&&role.paired?button('发送连接测试卡','role-check',false,ref):''}
      ${role.status==='retired'&&role.platformStatus==='disable_pending'?button('重试飞书停用','role-disable',false,ref):''}
    </div>
    ${role.connectionCheck&&running?`<p class="role-status">${role.connectionCheck.status==='verified'?'飞书卡片点击已返回':role.connectionCheck.status==='sent'?'测试卡已发出，等待点击':'正在发送测试卡'}</p>`:''}
    ${role.provisionError?`<p class="notice warn">${esc(role.provisionError)}</p>`:''}
    ${role.launchLink&&running?`<a class="role-launch" href="${esc(role.launchLink)}" target="_blank" rel="noopener noreferrer">打开飞书会话 ↗</a>`:''}
    </article>`;
}
function staffingCards(taskId=null){
  const proposals=(state.overview?.roleProposals??[]).filter(p=>!taskId||p.taskId===taskId);
  if(!proposals.length)return '';
  return `<section class="staffing" aria-label="人员安排">
    ${proposals.map(p=>{
      const adding=p.kind==='recruit',pending=p.status==='pending';
      const detail=adding?p.brief:`${p.openTasks??0} 项在办任务由助理接回，记忆和成果保留。`;
      const ref=`data-id="${esc(p.id)}" ${state.staffingBusy.has(p.id)?'disabled':''}`;
      return `<article class="staffing-card"><div><div class="staffing-label">${pending?'待你确认':'已确认 · 助理正在接回'}</div>
        <h2>${adding?'招募':'并回'} ${esc(p.name??roleNames[p.roleId])}</h2>
        <p>${esc(short(p.reason,260))}</p><p class="staffing-detail">${esc(short(detail,300))}</p>
        ${p.firstGoal?`<p class="staffing-detail">先接手 ${esc(short(p.firstGoal,180))}</p>`:''}
        ${p.taskTitle&&!taskId?`<a href="#task/${esc(p.taskId)}">${esc(short(p.taskTitle,60))}</a>`:''}</div>
        ${pending?`<div class="actions">${button('先不用','staffing-dismiss',false,ref)}${button(adding?'同意招募':'同意并回','staffing-approve',true,ref)}</div>`:''}</article>`;
    }).join('')}
    </section>`;
}
function taskSearchResults(){
  const tasks=state.taskSearch?.tasks??[];
  const draft=state.searchDraft?.query===state.boardQuery&&state.searchDraft.goal;
  const list=tasks.map(task=>`<article class="list-row">
    <div><h3><a href="#task/${esc(task.id)}">${esc(task.title)}</a></h3>
      <div class="meta">${esc(task.label)} ${task.archived?' · 已归档':''} · ${date(task.updatedAt)}</div>
      ${task.summary?`<p>${esc(task.summary)}</p>`:''}
    </div>
    <div class="actions search-actions">${task.artifact?button('看成果','preview',false,`data-id="${esc(task.artifact.id)}"`):''}
      ${button('继续这件事','search-continue',true,`data-id="${esc(task.id)}"`)}</div>
  </article>`).join('');
  return `<section class="task-search-results"><div class="section-title"><h2>${draft?'选一项接着做':'找到的任务'}</h2>
    ${button('返回看板','clear-task-search')}</div>
    ${list?`<div class="list">${list}</div>`:empty('没找到匹配的任务。','试试标题、时间或成果文件名。')}</section>`;
}
function roleMessageDialog(role='assistant',taskId=null){state.defaultRole=role;openDialog(`<h2>${esc(roleNames[role]??'助理')}</h2><p class="subtitle">${taskId?'接着这项任务聊。':'说一句话，或交代一件想推进的事。'}</p>${state.selected.size?`<div id="selected-summary" class="notice">已带上 ${state.selected.size} 条资料 ${button('清除','clear-selected')}</div>`:''}<form id="role-message-form" data-task="${taskId??''}" data-role="${role}" class="form-stack"><textarea name="goal" rows="5" maxlength="20000" required placeholder="想让她帮你做什么…"></textarea><div class="actions end">${button('取消','close-dialog')}<button class="primary" type="submit">发送</button></div></form>`);}
document.addEventListener('click',async event=>{if(event.target.closest('[data-nav=home]'))state.boardView='board';const node=event.target.closest('[data-action]');if(!node)return;const action=node.dataset.action;try{
if(action==='filter-role'){state.boardRole=node.dataset.role;state.board=null;if(!['home','tasks'].includes(state.route)){location.hash='home';}else if(await loadBoard())render(true);}
else if(action==='board-view'){state.boardView=node.dataset.view;render(true);}
else if(action==='board-refresh'){await loadOverview();render(true);toast('已按真实状态刷新。');}
else if(action==='board-more'){node.disabled=true;try{if(await loadBoard(node.dataset.bucket))render(true);}finally{node.disabled=false;}}
else if(action==='board-archived'){state.showArchived=!state.showArchived;if(await loadBoard())render(true);}
else if(action==='create-task')roleMessageDialog('assistant');
else if(action==='talk-secretary')roleMessageDialog('assistant');
else if(action==='staffing-approve'||action==='staffing-dismiss'){
  node.disabled=true;
  const decision=action==='staffing-approve'?'approve':'dismiss',id=node.dataset.id;
  if(state.staffingBusy.has(id))return;
  state.staffingBusy.add(id);
  for(const control of node.closest('.staffing-card').querySelectorAll('button'))control.disabled=true;
  try{
    const {proposal}=await api('/api/role-proposals/'+node.dataset.id+'/'+decision,{method:'POST',data:{}});
    await loadOverview();
    render(true);
    toast(proposal.status==='dismissed'?'已保留现有分工。':proposal.kind==='recruit'?'已加入协作，助理负责后续安排。':'已确认，助理会自动接回工作。');
  }finally{
    state.staffingBusy.delete(id);
    document.querySelectorAll('[data-action^=staffing-]').forEach(control=>{if(control.dataset.id===id)control.disabled=false;});
  }
}
else if(action==='clear-task-search'){
  state.boardQuery='';state.searchDraft=null;state.searchDesktop=false;
  if(await loadBoard())render(true);
}
else if(action==='search-continue'){
  const taskId=node.dataset.id,role='assistant';
  if(state.searchDraft?.query===state.boardQuery){
    const key='chat:'+taskId+':'+role;
    state.drafts[key]=[state.drafts[key],state.searchDraft.goal].filter(Boolean).join('\n\n');
  }
  state.searchDraft=null;
  location.hash='chat/'+taskId+'?role='+role;
}
else if(action==='role-chat'){const role=node.dataset.role;const recent=(state.overview.tasks??[]).find(t=>t.role===role&&!t.archived);if(recent)location.hash='chat/'+recent.id+'?role='+encodeURIComponent(role);else roleMessageDialog(role);}
else if(action==='role-provision'){node.disabled=true;try{await api('/api/roles/'+node.dataset.role+'/provision',{method:'POST',data:{}});await loadOverview();render(true);toast('开通流程已准备；按卡片完成飞书确认。');}finally{node.disabled=false;}}
else if(action==='role-check'){await api('/api/roles/'+node.dataset.role+'/check',{method:'POST',data:{}});await loadOverview();render(true);toast('已安排发送；请到飞书点一下测试卡。');}
else if(action==='role-disable'){await api('/api/roles/'+node.dataset.role+'/disable',{method:'POST',data:{}});await loadOverview();render(true);toast('平台状态已核验。');}
else if(action==='role-retire'){
  const version=state.navigationVersion;
  const plan=await api('/api/roles/'+node.dataset.role+'/retirement');
  if(version!==state.navigationVersion||dialog.open)return;
  const count=plan.tasks.filter(task=>!task.archived&&task.businessState!=='completed').length;
  openDialog(`<h2>把 ${esc(plan.role.name)} 的工作并回助理？</h2>
    <p>${count} 项在办任务由助理接回，记忆与成果保留。</p>
    ${plan.active.length?'<p class="subtitle">手上的活完成后自动交接。</p>':''}
    <form id="retire-form" data-role="${esc(plan.role.id)}" data-version="${plan.version}">
      <div class="actions end">${button('先不用','close-dialog')}<button type="submit" class="primary">同意并回</button></div>
    </form>`);
}
else if(action==='complete-task'||action==='reopen-task'){
  const taskId=node.dataset.id,version=state.navigationVersion;
  const {task}=await api('/api/tasks/'+taskId+'/state',{method:'POST',data:{businessState:action==='complete-task'?'completed':'open'}});
  await loadOverview();
  if(version===state.navigationVersion&&state.id===taskId){
    state.task={...state.task,businessState:task.businessState,actionVersion:task.actionVersion};
    render();
  }
  toast(action==='complete-task'?'已标记完成。':'已重新打开同一项任务。');
}
else if(action==='task-secretary'){node.disabled=true;try{const taskId=state.id,version=state.navigationVersion;const result=await api('/api/tasks/'+taskId+'/messages',{method:'POST',data:{role:'assistant',goal:'请根据这项任务已有结果、资料和限制，简短汇总当前进展、待定事项和建议下一步；不要重复执行专业工作。',requestId:crypto.randomUUID()}});await loadOverview();if(version===state.navigationVersion&&!dialog.open)location.hash='chat/'+result.task.id+'?role=assistant';}finally{node.disabled=false;}}
else if(action==='assign-task'){const roleOptions=state.overview.roles.filter(r=>!['retired','available'].includes(r.status)).map(r=>`<option value="${r.id}" ${r.id===state.task.role?'selected':''}>${esc(r.name)}</option>`).join('');openDialog(`<h2>交给谁继续</h2><p class="subtitle">交接任务要求、相关资料与摘要，保留同一任务编号。正在执行时会先核实原会话。</p><form id="assign-form" data-task="${state.id}" data-version="${state.task.actionVersion??1}" class="form-stack"><select name="roleId">${roleOptions}</select><div class="actions end">${button('取消','close-dialog')}<button class="primary" type="submit">交接任务</button></div></form>`);}
}catch(error){toast(error.message);}});
document.addEventListener('submit',async event=>{const form=event.target;if(!['board-search','role-message-form','retire-form','assign-form'].includes(form.id))return;event.preventDefault();const submit=form.querySelector('[type=submit]');if(submit?.disabled)return;if(submit)submit.disabled=true;try{const data=Object.fromEntries(new FormData(form));
if(form.id==='board-search'){state.boardQuery=(data.q??'').trim();state.searchDraft=null;state.searchDesktop=false;if(await loadBoard())render(true);}
else if(form.id==='role-message-form'){
  const originVersion=state.navigationVersion;
  const endpoint=form.dataset.task?'/api/tasks/'+form.dataset.task+'/messages':'/api/tasks';
  const requestKey=JSON.stringify([data.goal,form.dataset.role,[...state.selected]]);
  if(form.dataset.requestKey!==requestKey){
    form.dataset.requestKey=requestKey;form.dataset.requestId=crypto.randomUUID();
  }
  const result=await api(endpoint,{method:'POST',data:{...data,role:form.dataset.role,
    requestId:form.dataset.requestId,captureIds:[...state.selected],interpret:!form.dataset.task}});
  const current=dialog.contains(form)&&dialog.open&&originVersion===state.navigationVersion;
  if(current){dialog.close();state.selected.clear();}
  if(current&&result.search){
    state.boardRole='all';state.boardQuery=result.search.query;state.searchDesktop=true;
    state.searchDraft=result.search.goal?{query:state.boardQuery,goal:result.search.goal}:null;
    if(state.route==='home'){if(await loadBoard())render(true);}else location.hash='home';
  }else if(current){
    location.hash='chat/'+result.task.id+'?role='+encodeURIComponent(form.dataset.role);
    toast('已接到这件事。');
  }
  loadOverview().then(()=>render()).catch(()=>{});
}
else if(form.id==='retire-form'){
  await api('/api/roles/'+form.dataset.role+'/retire',{method:'POST',data:{expectedVersion:Number(form.dataset.version)}});
  const current=dialog.contains(form)&&dialog.open;
  if(current)dialog.close();
  await loadOverview();
  if(current)render(true);
  toast('已确认，助理会自动接回工作。');
}
else if(form.id==='assign-form'){
  const version=state.navigationVersion;
  const result=await api('/api/tasks/'+form.dataset.task+'/assign',{method:'POST',data:{...data,expectedVersion:Number(form.dataset.version)}});
  await loadOverview();
  if(version===state.navigationVersion&&dialog.contains(form)&&dialog.open){
    dialog.close();location.hash='chat/'+result.task.id+'?role='+encodeURIComponent(result.task.role);
  }
  toast('任务已交接，原编号和资料保留。');
}
}catch(error){toast(error.message);}finally{if(submit)submit.disabled=false;}});
document.addEventListener('change',async event=>{if(event.target.id==='include-chats'){state.includeChats=event.target.checked;try{if(await loadBoard())render(true);}catch(error){toast(error.message)}}});
setInterval(async()=>{if(state.route!=='partners'||dialog.open||document.hidden)return;try{await loadOverview();render();}catch{}},3000);
