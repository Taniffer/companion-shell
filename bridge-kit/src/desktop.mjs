import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { readdirSync, existsSync } from 'node:fs';
import { latestServer } from './config.mjs';
import { TranscriptFallback } from './transcript.mjs';

// Use the desktop's bundled MCP adapter; do not start an independent Codex CLI.
export class Desktop {
  constructor(config) { this.config = config; this.nextId = 1; this.pending = new Map(); }
  async connect() {
    if (this.ready) return this.ready;
    this.ready = this.discover().catch(e => { this.ready = null; throw e; });
    return this.ready;
  }
  async discover() {
    if(this.config.codexHome)this.config.serverPath=latestServer(this.config.codexHome);
    if(!existsSync(this.config.serverPath))throw new Error('桌面端任务插件不存在，请重新运行配置');
    const candidates=[process.env.CODEX_APP_TOOLS_PIPE_PATH];
    if(process.platform==='win32') {
      try {
        // New desktops expose a dedicated app-tools pipe; keep browser-use for older builds.
        const pipes=readdirSync('\\\\.\\pipe\\').filter(x=>/^codex-(?:app-tools|browser-use)-[0-9a-f-]+$/i.test(x));
        pipes.sort((a,b)=>Number(b.startsWith('codex-app-tools-'))-Number(a.startsWith('codex-app-tools-')));
        candidates.push(...pipes.map(x=>'\\\\.\\pipe\\'+x));
      }catch{}
    }
    candidates.push(this.config.pipePath);
    for(const pipe of [...new Set(candidates.filter(Boolean))]) {
      try {await this.initialize(pipe);this.config.pipePath=pipe;return;}
      catch {const child=this.child;this.child=null;child?.kill();for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error('连接探测结束'));}this.pending.clear();}
    }
    throw new Error('未找到可用的 Codex 桌面任务通道，请打开并登录 Codex 桌面端');
  }
  async initialize(pipePath) {
    const child = spawn(process.execPath, [this.config.serverPath], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CODEX_APP_TOOLS_PIPE_PATH: pipePath }
    });
    this.child = child;
    child.stderr.on('data', () => {}); // MCP diagnostics may contain private task data.
    child.on('error', e => {if(this.child===child)this.disconnect(e);});
    child.on('exit', () => {if(this.child===child)this.disconnect(new Error('Codex 桌面任务通道已断开'));});
    createInterface({ input: child.stdout }).on('line', line => {
      let msg; try { msg = JSON.parse(line); } catch { return; }
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id); clearTimeout(pending.timer);
      msg.error ? pending.reject(new Error(msg.error.message)) : pending.resolve(msg.result);
    });
    await this.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'feishu-desktop-bridge', version: '0.1.0' } },4000);
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
    const catalog = await this.request('tools/list', {},4000);
    this.catalog = catalog.tools;
    for (const name of ['list_projects', 'create_thread', 'send_message_to_thread', 'read_thread']) {
      if (!catalog.tools.some(t => t.name === name)) throw new Error(`桌面版本缺少接口 ${name}`);
    }
  }
  request(method, params, timeout = 90000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} 超时；写操作不可自动重试`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
    });
  }
  async call(name, args = {}) {
    try {return await this.rawCall(name,args);}
    catch(error) {
      // Some desktop histories fail to deserialize when older turns are included.
      // Only read requests may be retried with a smaller page; never repeat writes.
      if(name!=='read_thread'||!(args.turnLimit>1))throw error;
      return this.rawCall(name,{...args,turnLimit:1});
    }
  }
  async rawCall(name, args = {}) {
    clearTimeout(this.idleTimer);
    await this.connect();
    let result;
    try {result = await this.request('tools/call', {name,arguments:args,_meta:{
      'openai/threadId': this.config.controllerThreadId,
      'openai/toolCallId': `feishu-${randomUUID()}`,
      'openai/turnId': `feishu-${randomUUID()}`
    }});}catch(e){this.close();throw e;}
    this.idleTimer=setTimeout(()=>this.close(),120000);this.idleTimer.unref();
    const text = result.content?.filter(c => c.type === 'text').map(c => c.text).join('\n') ?? '';
    if (result.isError) {if(/pipe|ENOENT|ECONN|disconnect|closed/i.test(text))this.close();throw new Error(text);}
    let parsed;try {parsed=JSON.parse(text);}catch{return {text};}
    if(name==='read_thread') {
      this.transcript??=new TranscriptFallback(this.config.codexHome);
      return this.transcript.enrich(parsed,args.threadId);
    }
    return parsed;
  }
  disconnect(error) {
    this.ready = null;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
  }
  close() {clearTimeout(this.idleTimer);this.child?.stdin.end();this.child?.kill();this.ready=null;}
}
