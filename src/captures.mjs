import { mkdirSync,writeFileSync,unlinkSync,existsSync,readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppError,hash,imageMime,text } from './util.mjs';

export class Captures {
  constructor(db,dataDir){this.db=db;this.root=join(dataDir,'captures');mkdirSync(this.root,{recursive:true});}
  add(payload,deviceId='local'){
    if(!/^[0-9a-f-]{36}$/i.test(payload.id??''))throw new AppError(400,'记录编号无效');
    const body=text(payload.text??'',20000),source=text(payload.source??'manual',80);
    const attachments=payload.attachments??[];if(!Array.isArray(attachments)||attachments.length>3)throw new AppError(400,'一次最多登记 3 张图片');
    let total=0;const files=attachments.map((item,index)=>{
      if(typeof item.base64!=='string'||item.base64.length>12*1024*1024||!/^[A-Za-z0-9+/]*={0,2}$/.test(item.base64))throw new AppError(400,'图片数据无效');
      const bytes=Buffer.from(item.base64,'base64');total+=bytes.length;
      if(!bytes.length||bytes.length>8*1024*1024||total>16*1024*1024)throw new AppError(413,'单张图片最多 8 MB，一次最多 16 MB');
      const mime=imageMime(bytes);if(!mime)throw new AppError(415,'仅支持 PNG、JPEG、GIF 和 WebP 图片');
      return {bytes,mime,name:text(item.name??'image',120),hash:hash(bytes),index};
    });
    if(!body&&!files.length)throw new AppError(400,'登记内容不能为空');
    const contentHash=hash(JSON.stringify({body,source,files:files.map(f=>({hash:f.hash,name:f.name,mime:f.mime}))}));
    const existing=this.db.capture(payload.id);
    if(existing){if(existing.deviceId!==deviceId||existing.contentHash!==contentHash)throw new AppError(409,'这条记录的编号已经用于其他内容');return {capture:existing,duplicate:true};}
    const created=Number(payload.createdAt);const now=Date.now();
    const value={id:payload.id,deviceId,text:body,title:body.split('\n')[0].slice(0,90)||(files.length+' 张图片'),url:body.match(/https?:\/\/[^\s<>]+/i)?.[0]??'',source,createdAt:Number.isFinite(created)&&created>0&&created<now+86400000?created:now,receivedAt:now,coverage:body.match(/https?:\/\//)?'主动记录的文字／链接；未自动获取网页正文':'主动记录内容',attachments:[]};
    const dir=join(this.root,payload.id);mkdirSync(dir,{recursive:true});const written=[];
    try{
      for(const file of files){const ext={'image/png':'.png','image/jpeg':'.jpg','image/gif':'.gif','image/webp':'.webp'}[file.mime];const path=join(dir,`${file.index}-${file.hash.slice(0,12)}${ext}`);if(existsSync(path)){if(hash(readFileSync(path))!==file.hash)throw new AppError(409,'这条记录的暂存图片与原内容不一致');}else{writeFileSync(path,file.bytes,{flag:'wx',mode:0o600});written.push(path);}value.attachments.push({path,mime:file.mime,name:file.name,size:file.bytes.length,hash:file.hash});}
      this.db.putCapture(value,contentHash);return {capture:value,duplicate:false};
    }catch(error){for(const path of written)try{unlinkSync(path);}catch{}throw error;}
  }
}
