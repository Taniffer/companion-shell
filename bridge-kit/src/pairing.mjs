import { Store } from './store.mjs';
import { root } from './config.mjs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
const store=new Store(join(root,'data','bridge.sqlite'));
try {
 if(store.get('owner'))console.log('账号已配对。');
 else {
  let p=store.get('pairing');
  if(!p||p.expires<Date.now()){p={code:randomBytes(5).toString('hex'),expires:Date.now()+24*3600_000};store.set('pairing',p);}
  console.log(`在飞书机器人私聊中发送：配对 ${p.code}`);
 }
}finally{store.close();}
