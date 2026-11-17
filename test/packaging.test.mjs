import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { patchBridge } from '../scripts/patch-bridge.mjs';

test('bridge patch is repeatable and disabling retains a local delivery fence',async()=>{
  const source='const bridge = new Bridge({});\n';
  const enabled=patchBridge(source),repeated=patchBridge(enabled);
  assert.equal((repeated.match(/BEGIN COMPANION_LOCAL_FENCE/g)??[]).length,1);
  assert.equal((repeated.match(/BEGIN COMPANION_MVP_ADDON/g)??[]).length,1);
  const disabled=patchBridge(repeated,{enable:false});
  assert.ok(!disabled.includes('BEGIN COMPANION_MVP_ADDON'));
  assert.ok(disabled.includes('BEGIN COMPANION_LOCAL_FENCE'));
  const names=['reply','progress','reaction','clearReaction','finishProgress','topicContext','attachments','deliverArtifact'];
  let networkCalls=0,desktopCalls=0;
  const feishu=Object.fromEntries(names.map(name=>[name,async()=>{networkCalls++;}]));
  const desktop={call:async()=>{desktopCalls++;return {ok:true};}};
  await runInNewContext(`(async()=>{${disabled}})()`,{feishu,desktop,Bridge:class{}});
  for(const name of names)await assert.rejects(()=>feishu[name]({channel:'local',id:'companion-local'}),/requires the companion runtime/);
  await feishu.reply({id:'feishu-real',channel:'feishu'},'normal');
  await assert.rejects(()=>desktop.call('create_thread',{prompt:'[飞书消息:companion-local] private'}),/paused/);
  await desktop.call('read_thread',{threadId:'read-only'});
  assert.equal(networkCalls,1);assert.equal(desktopCalls,1);
  assert.throws(()=>patchBridge('const incompatible = true;'),/entry has changed/);
});
