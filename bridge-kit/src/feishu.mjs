import * as lark from '@larksuiteoapi/node-sdk';
import { createHash } from 'node:crypto';
import { createWriteStream,createReadStream } from 'node:fs';
import { mkdir,stat,realpath } from 'node:fs/promises';
import { join,basename,extname,relative,isAbsolute,resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { root } from './config.mjs';
import { extractText, splitText } from './routing.mjs';
const sdkLogger={error(){},warn(){},info(){},debug(){},trace(){}};
const uuid = id => createHash('sha256').update(id).digest('hex').slice(0,32);
const check = r => {if(r.code && r.code!==0) throw new Error(`飞书 API ${r.code}: ${r.msg}`); return r.data??r;};
export class Feishu {
  constructor(config, secret) {
    this.config=config;
    // Apply a real transport timeout, including token acquisition and uploads.
    lark.defaultHttpInstance.defaults.timeout=30000;
    this.client=new lark.Client({appId:config.appId,appSecret:secret,loggerLevel:lark.LoggerLevel.error,logger:sdkLogger});
    this.ws=new lark.WSClient({appId:config.appId,appSecret:secret,loggerLevel:lark.LoggerLevel.error,logger:sdkLogger});
  }
  async identity() {
    const r=await this.client.request({method:'GET',url:'/open-apis/bot/v3/info'});
    if(r.code) throw new Error(`机器人信息读取失败 ${r.code}`);
    this.botId=r.bot?.open_id ?? r.data?.bot?.open_id;
    if(!this.botId) throw new Error('飞书没有返回机器人 open_id；请先启用机器人能力');
    return this.botId;
  }
  async start(handler) {
    await this.ws.start({eventDispatcher:new lark.EventDispatcher({logger:sdkLogger}).register({'im.message.receive_v1':event=>handler(event)})});
  }
  async reply(job, text, key) {
    let i=0;
    for(const part of splitText(text)) {
      check(await this.client.im.message.reply({path:{message_id:job.id},data:{msg_type:'text',content:JSON.stringify({text:part}),reply_in_thread:!!job.topicId,uuid:uuid(`${key}:${i++}`)}}));
    }
  }
  async reaction(job) {
    return check(await this.client.im.messageReaction.create({path:{message_id:job.id},data:{reaction_type:{emoji_type:'Typing'}}})).reaction_id;
  }
  async clearReaction(job) {
    if(job.reactionId) check(await this.client.im.messageReaction.delete({path:{message_id:job.id,reaction_id:job.reactionId}}));
  }
  async topicContext(job) {
    if(!job.topicId) return '';
    const collected=[]; let pageToken;
    // Read this topic only. Never query a group chat's history.
    for(let page=0;page<4;page++) {
      const data=check(await this.client.im.message.list({params:{container_id_type:'thread',container_id:job.topicId,page_size:50,sort_type:'ByCreateTimeDesc',...(pageToken?{page_token:pageToken}:{})}}));
      collected.push(...(data.items??[]).filter(m=>m.message_id!==job.id && m.sender?.id!==this.botId && Number(m.create_time)<=Number(job.message.create_time)));
      if(!data.has_more) break; pageToken=data.page_token;
    }
    return collected.sort((a,b)=>Number(a.create_time)-Number(b.create_time)).map(m=>`[${m.sender?.id??'成员'}] ${extractText(m)}`).join('\n').slice(-24000);
  }
  async progress(job, text) {
    const card={config:{wide_screen_mode:true},header:{title:{tag:'plain_text',content:'Codex · 运行中'},template:'blue'},elements:[{tag:'div',text:{tag:'plain_text',content:Array.from(text).slice(-1500).join('')}}]};
    if(job.progressId) check(await this.client.im.message.patch({path:{message_id:job.progressId},data:{content:JSON.stringify(card)}}));
    else job.progressId=check(await this.client.im.message.reply({path:{message_id:job.id},data:{msg_type:'interactive',content:JSON.stringify(card),reply_in_thread:!!job.topicId,uuid:uuid(`${job.id}:progress`)}})).message_id;
  }
  async finishProgress(job, status) {
    if(!job.progressId) return;
    check(await this.client.im.message.patch({path:{message_id:job.progressId},data:{content:JSON.stringify({header:{title:{tag:'plain_text',content:`Codex · ${status}`}},elements:[{tag:'div',text:{tag:'plain_text',content:status}}]})}}));
  }
  async attachments(job) {
    let body;try{body=JSON.parse(job.message.content);}catch{return [];}
    const resources=[];
    if(body.image_key)resources.push({key:body.image_key,type:'image',name:'image.png'});
    if(body.file_key)resources.push({key:body.file_key,type:'file',name:body.file_name??'attachment.bin'});
    const post=body.content?body:body.zh_cn??body.en_us;
    if(Array.isArray(post?.content))for(const row of post.content)for(const node of row)if(node.tag==='img'&&node.image_key)resources.push({key:node.image_key,type:'image',name:'image.png'});
    if(!resources.length)return [];
    const dir=join(root,'data','attachments',uuid(job.id));await mkdir(dir,{recursive:true});
    const paths=[];
    for(const [index,r] of resources.slice(0,10).entries()) {
      const name=basename(r.name).replace(/[^\p{L}\p{N}._-]/gu,'_').slice(0,100)||'attachment.bin';
      const path=join(dir,`${index}-${name}`);
      const data=await this.client.im.messageResource.get({path:{message_id:job.id,file_key:r.key},params:{type:r.type}});
      let size=0;const limit=new Transform({transform(chunk,encoding,cb){size+=chunk.length;cb(size>30*1024*1024?new Error('附件超过本地 30 MB 限制'):null,chunk);}});
      await pipeline(data.getReadableStream(),limit,createWriteStream(path),{signal:AbortSignal.timeout(60000)});paths.push(path);
    }
    return paths;
  }
  async deliverArtifact(job, path, key) {
    const actual=await realpath(path), base=await realpath(job.cwd);
    const rel=relative(base,actual);
    if(rel.startsWith('..')||isAbsolute(rel))throw new Error('产物不在当前任务目录内，未自动上传');
    const meta=await stat(actual);if(!meta.isFile()||meta.size>30*1024*1024)throw new Error('产物不是普通文件或超过 30 MB');
    const image=/\.(png|jpe?g|gif|webp)$/i.test(actual)&&meta.size<10*1024*1024;
    const uploaded=image?check(await this.client.im.image.create({data:{image_type:'message',image:createReadStream(actual)}})):check(await this.client.im.file.create({data:{file_type:'stream',file_name:basename(actual),file:createReadStream(actual)}}));
    const content=image?{image_key:uploaded.image_key}:{file_key:uploaded.file_key};
    check(await this.client.im.message.reply({path:{message_id:job.id},data:{msg_type:image?'image':'file',content:JSON.stringify(content),reply_in_thread:!!job.topicId,uuid:uuid(key)}}));
  }
  close(){this.ws.close({force:true});}
}
