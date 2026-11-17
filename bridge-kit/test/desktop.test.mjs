import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Desktop } from '../src/desktop.mjs';

async function openTestPipe(t, family) {
 const pipe = `\\\\.\\pipe\\${family}-${randomUUID()}`;
 const server = createServer(socket => socket.end());
 await new Promise((resolve, reject) => {server.once('error', reject);server.listen(pipe, resolve);});
 t.after(() => new Promise(resolve => server.close(resolve)));
 return pipe;
}

test('旧配置失效时自动发现新版 Codex 桌面管道', {skip:process.platform!=='win32'}, async t => {
 const current = await openTestPipe(t, 'codex-app-tools');
 const d = new Desktop({serverPath:fileURLToPath(import.meta.url),pipePath:`\\\\.\\pipe\\codex-browser-use-${randomUUID()}`});
 const attempts = [];
 d.initialize = async pipe => {attempts.push(pipe);if(pipe!==current)throw new Error('Unavailable test endpoint');};
 await d.discover();
 assert.equal(d.config.pipePath,current);
 assert.ok(attempts.includes(current));
 assert.equal(attempts.length,new Set(attempts).size);
});

test('新版管道不可用时仍能连接旧版 Codex 桌面管道', {skip:process.platform!=='win32'}, async t => {
 const current = await openTestPipe(t, 'codex-app-tools');
 const legacy = await openTestPipe(t, 'codex-browser-use');
 const d = new Desktop({serverPath:fileURLToPath(import.meta.url)});
 const attempts = [];
 d.initialize = async pipe => {attempts.push(pipe);if(pipe!==legacy)throw new Error('Unavailable test endpoint');};
 await d.discover();
 assert.equal(d.config.pipePath,legacy);
 assert.ok(attempts.indexOf(current)>=0 && attempts.indexOf(current)<attempts.indexOf(legacy));
});

test('历史多轮读取失败时降级一轮并保留原请求范围',async()=>{
 const d=new Desktop({}),calls=[];
 d.rawCall=async(n,a)=>{calls.push({n,a});if(a.turnLimit>1)throw new Error('history failure');return {turns:[{id:'latest'}]};};
 const result=await d.call('read_thread',{threadId:'target',turnLimit:5,includeOutputs:true});
 assert.equal(result.turns[0].id,'latest');
 assert.deepEqual(calls.map(c=>c.a),[{threadId:'target',turnLimit:5,includeOutputs:true},{threadId:'target',turnLimit:1,includeOutputs:true}]);
});
test('写操作失败不自动重试，单轮也失败则向上报告',async()=>{
 const d=new Desktop({});let calls=0;
 d.rawCall=async()=>{calls++;throw new Error('failed');};
 await assert.rejects(d.call('send_message_to_thread',{threadId:'target'}),/failed/);assert.equal(calls,1);
 await assert.rejects(d.call('read_thread',{threadId:'target',turnLimit:5}),/failed/);assert.equal(calls,3);
});
