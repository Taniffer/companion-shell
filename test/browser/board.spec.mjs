import {test,expect} from '@playwright/test';

test('existing robot setup keeps credentials out of chat and clears the secret after connecting',async({page})=>{
  const id='qa-binding-'+Date.now();
  const result=await page.request.post('/api/roles',{headers:{'X-Companion':'1'},data:{id,name:'连接验收伙伴',brief:'synthetic connection setup only'}});
  expect(result.ok()).toBeTruthy();
  await page.locator('[data-nav=partners]').click();
  const card=page.locator('.role-card').filter({hasText:'连接验收伙伴'});
  await card.getByText('飞书连接设置',{exact:true}).click();
  await page.waitForTimeout(3500);
  await expect(card.getByRole('button',{name:'连接已有机器人',exact:true})).toBeVisible();
  await card.getByRole('button',{name:'连接已有机器人',exact:true}).click();
  const secret='SYNTHETIC_BIND_SECRET_NOT_A_REAL_KEY';
  await page.getByLabel('应用编号（App ID）',{exact:true}).fill('cli_browserbinding');
  const field=page.getByLabel('应用密钥（App Secret）',{exact:true});
  await expect(field).toHaveAttribute('type','password');
  await field.fill(secret);
  let received=false;
  await page.route('**/api/roles/'+id+'/bind',async route=>{
    expect(route.request().postDataJSON()).toEqual({appId:'cli_browserbinding',secret});
    received=true;
    await route.fulfill({json:{roleId:id,status:'awaiting_binding'}});
  });
  await page.getByRole('button',{name:'连接机器人',exact:true}).click();
  await expect(page.locator('#dialog')).not.toBeVisible();
  expect(received).toBeTruthy();
  expect(await page.locator('body').innerText()).not.toContain(secret);
  await card.getByRole('button',{name:'连接已有机器人',exact:true}).click();
  await expect(page.getByLabel('应用密钥（App Secret）',{exact:true})).toHaveValue('');
  await expect(page.getByLabel('应用编号（App ID）',{exact:true})).toHaveValue('');
});
test.beforeEach(async({page})=>{await page.goto('/#key=companion-qa-local-only');await expect(page.getByRole('heading',{name:'所有任务',exact:true})).toBeVisible();});
test('default board, role filter and list use actual server counts',async({page})=>{const errors=[];page.on('pageerror',e=>errors.push(e.message));await expect(page.locator('.kanban-column')).toHaveCount(3);await page.screenshot({path:'test/.runtime/board-v2.png',fullPage:true});await expect(page.getByText('验证低换手选股假设',{exact:true})).toBeVisible();await expect(page.locator('.role-filter')).toHaveAttribute('open','');await page.locator('.role-nav[data-role=quant]').click();await expect(page.getByRole('heading',{name:'量化助理',exact:true})).toBeVisible();await expect(page.getByText('实现安卓悬浮记录入口',{exact:true})).toHaveCount(0);const total=await page.locator('.role-nav[data-role=all] small').textContent();expect(Number(total)).toBeGreaterThan(48);await page.locator('[data-action=board-view][data-view=list]').click();await expect(page.locator('.board-list')).toBeVisible();await page.screenshot({path:'test/.runtime/list-v2.png',fullPage:true});expect(errors).toEqual([]);});
test('loaded pages survive actual polling and navigation',async({page})=>{await expect(page.locator('.role-filter')).toHaveAttribute('open','');await page.locator('.role-nav[data-role=quant]').click();await page.locator('.unfinished [data-action=board-more]').click();await expect(page.locator('.unfinished .board-card')).toHaveCount(40);await page.waitForTimeout(7500);await expect(page.locator('.unfinished .board-card')).toHaveCount(40);await page.locator('[data-nav=tasks]').click();await expect(page.locator('.board-list')).toBeVisible();});
test('a secretary draft on an expert-owned task survives details and sending stays in that role',async({page})=>{await page.locator('.kanban').getByRole('link',{name:'安排一次周末出行',exact:true}).click();await page.getByRole('link',{name:'整理出行准备清单',exact:true}).click();await page.getByRole('button',{name:'请助理汇总',exact:true}).click();await expect(page).toHaveURL(/role=assistant/);const input=page.locator('#message-input');await input.fill('Keep this secretary draft');await page.getByRole('link',{name:'进展与成果',exact:true}).click();await page.getByRole('link',{name:/和.*聊/}).first().click();await expect(page.locator('#message-input')).toHaveValue('Keep this secretary draft');await page.getByRole('button',{name:/发送补充/}).click();await expect(page).toHaveURL(/role=assistant/);await expect(page.locator('#message-input')).toHaveValue('');});
test('capture does not create a task and selected materials open a real editor',async({page})=>{const initial=await page.request.get('/api/board').then(r=>r.json());await page.getByRole('button',{name:'＋ 记一下',exact:true}).click();await page.locator('#capture-text').fill('BROWSER_E2E_capture_only');await page.locator('#capture-form button[type=submit]').click();await page.locator('[data-nav=materials]').click();await expect(page.getByRole('heading',{name:'BROWSER_E2E_capture_only',exact:true})).toBeVisible();const current=await page.request.get('/api/board').then(r=>r.json());expect(current.counts.total).toBe(initial.counts.total);await page.locator('input[data-select-capture]').first().check();await page.getByRole('button',{name:/带给助理/}).click();await expect(page.locator('#role-message-form textarea')).toBeVisible();await expect(page.locator('#selected-summary')).toContainText('1 条资料');});
test('one approval creates one role even when the result is lost',async({page})=>{
  const box=page.locator('.staffing-card').filter({hasText:'验收阅读助理'});
  await expect(box).toBeVisible();
  let once=true;
  await page.route('**/api/role-proposals/*/approve',async route=>{
    if(once){once=false;await route.fetch();await route.abort('failed');}
    else await route.continue();
  });
  await box.getByRole('button',{name:'同意招募'}).click();
  await expect(box).toBeVisible();
  await box.getByRole('button',{name:'同意招募'}).click();
  await expect(box).toHaveCount(0);
  await expect(page.locator('#dialog')).not.toBeVisible();
  const {roles}=await page.request.get('/api/roles').then(r=>r.json());
  expect(roles.filter(r=>r.name==='验收阅读助理')).toHaveLength(1);
  expect(roles.find(r=>r.name==='验收阅读助理').appId).toBeUndefined();
});

test('a delayed old response cannot close a newer capture draft',async({page})=>{await page.getByRole('button',{name:'＋ 交代一件事',exact:true}).click();await page.locator('#role-message-form textarea').fill('Old slow request');let release,started;const gate=new Promise(r=>release=r),seen=new Promise(r=>started=r);await page.route('**/api/tasks',async route=>{if(route.request().method()==='POST'){const response=await route.fetch();started();await gate;await route.fulfill({response});}else await route.continue();});await page.locator('#role-message-form [type=submit]').click();await seen;await page.locator('#role-message-form [data-action=close-dialog]').click();await page.getByRole('button',{name:'＋ 记一下',exact:true}).click();await page.locator('#capture-text').fill('New unsent draft');release();await expect(page.locator('#capture-text')).toHaveValue('New unsent draft');await page.waitForTimeout(300);await expect(page.locator('#dialog')).toBeVisible();await expect(page.locator('#capture-text')).toHaveValue('New unsent draft');});

test('a delayed manual platform-stop record cannot close a newer capture draft',async({page})=>{
  await page.route('**/api/overview',async route=>{
    const response=await route.fetch(),value=await response.json();
    value.roles.push({id:'qa-retired-ui',name:'后台停用验收伙伴',brief:'synthetic platform-stop UI test',status:'retired',appId:'cli_browserdisabled',platformStatus:'disable_pending'});
    await route.fulfill({json:value});
  });
  await page.goto('/#partners');
  const card=page.locator('.role-card').filter({hasText:'后台停用验收伙伴'});
  await card.getByRole('button',{name:'登记后台停用结果',exact:true}).click();
  await expect(page.getByRole('dialog')).toContainText('不代表接口已经验证');
  await page.getByRole('checkbox',{name:'我已核对这只应用在飞书后台显示已停用'}).check();
  let release,started;const gate=new Promise(r=>release=r),seen=new Promise(r=>started=r);
  await page.route('**/api/roles/qa-retired-ui/confirm-disabled',async route=>{
    expect(route.request().postDataJSON()).toEqual({appId:'cli_browserdisabled',confirmed:true});started();await gate;
    await route.fulfill({json:{ok:true,status:'disabled_console_confirmed'}});
  });
  await page.getByRole('button',{name:'记录停用结果',exact:true}).click();await seen;
  await page.getByRole('button',{name:'取消',exact:true}).click();
  await page.getByRole('button',{name:'＋ 记一下',exact:true}).click();
  await page.locator('#capture-text').fill('Keep this new capture after manual record');release();
  await expect(page.getByText('已保存后台核验记录。',{exact:true})).toBeVisible();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.locator('#capture-text')).toHaveValue('Keep this new capture after manual record');
});

test('editing a role memory preserves its role boundary',async({page})=>{const {memories}=await page.request.post('/api/memories',{headers:{'X-Companion':'1'},data:{text:'ROLE_MEMORY_QA',scope:'role',roleId:'quant'}}).then(r=>r.json());await page.goto('/#memory');if(!await page.locator('[data-action=edit-memory]').count())await page.goto('/#memories');const item=page.locator('.memory-card').filter({hasText:'ROLE_MEMORY_QA'});await expect(item).toContainText('仅量化助理');await item.locator('[data-action=edit-memory]').click();await page.locator('#memory-form textarea').fill('ROLE_MEMORY_QA_EDITED');await page.locator('#memory-form [type=submit]').click();const result=await page.request.get('/api/memories').then(r=>r.json());const saved=result.memories.find(x=>x.text==='ROLE_MEMORY_QA_EDITED');expect(saved.scope).toBe('role');expect(saved.roleId).toBe('quant');});

test('search by result file and continue opens the same task without a role picker',async({page})=>{
  const initial=await page.request.get('/api/board').then(r=>r.json());
  const task=initial.columns.unfinished.tasks.find(t=>t.title==='安排一次周末出行');
  await page.getByRole('searchbox',{name:'搜索任务'}).fill('出行准备.html');
  await page.getByRole('button',{name:'找任务',exact:true}).click();
  await expect(page.getByRole('heading',{name:'找到的任务'})).toBeVisible();
  const found=page.locator('.task-search-results .list-row').filter({hasText:task.title});
  await expect(found).toBeVisible();
  await found.getByRole('button',{name:'看成果'}).click();
  await expect(page.frameLocator('iframe[title=成果预览]').getByRole('heading',{name:'出行准备'})).toBeVisible();
  await page.getByRole('button',{name:'关闭',exact:true}).click();
  await found.getByRole('button',{name:'继续这件事'}).click();
  await expect(page).toHaveURL(new RegExp('/'+task.id+'\\?role=assistant$'));
  await expect(page.locator('#message-input')).toBeVisible();
});
