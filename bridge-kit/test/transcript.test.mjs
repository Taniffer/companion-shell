import test from 'node:test';
import assert from 'node:assert/strict';
import {assistantItems,TranscriptFallback} from '../src/transcript.mjs';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const line=x=>JSON.stringify(x)+'\n';
const message=(turn,phase,text)=>({type:'response_item',payload:{type:'message',role:'assistant',id:text,phase,internal_chat_message_metadata_passthrough:{turn_id:turn},content:[{type:'output_text',text}]}});
test('只取指定轮次的用户可见进度与最终回复，不带终端、工具和其他轮次',()=>{
 const log=[message('one','commentary','正在检查'),message('one','final_answer','文档好了'),message('two','final_answer','其他任务'),message('one','analysis','隐藏内容'),{type:'response_item',payload:{type:'function_call_output',output:'TERMINAL_CODE'}},{type:'response_item',payload:{type:'message',role:'user',phase:'commentary',content:[{type:'output_text',text:'USER'}]}}].map(line).join('');
 assert.deepEqual(assistantItems(log,'one').map(x=>x.text),['正在检查','文档好了']);
});
test('空正文恢复、UTF8附件链接保留、重复读取不重复追加、已有正文不覆盖',async t=>{
 const home=mkdtempSync(join(tmpdir(),'bridge-transcript-'));t.after(()=>rmSync(home,{recursive:true,force:true}));mkdirSync(join(home,'sessions'));
 const id='01a096aa-527e-77d0-8f22-70bab6ff4246';
 const text='[文档](C:/任务/完整版.md)';
 writeFileSync(join(home,'sessions',`rollout-${id}.jsonl`),line({type:'session_meta',payload:{id}})+line(message('one','final_answer',text))+'{partial');
 const f=new TranscriptFallback(home),s={turns:[{id:'one',items:[]},{id:'two',items:[{type:'agentMessage',text:'API正文'}]}]};
 await f.enrich(s,id);await f.enrich(s,id);assert.equal(s.turns[0].items.length,1);assert.equal(s.turns[0].items[0].text,text);assert.equal(s.turns[1].items[0].text,'API正文');
});
