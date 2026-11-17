import { existsSync,mkdirSync,readFileSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { X509Certificate } from 'node:crypto';
import selfsigned from 'selfsigned';

export async function certificate(dataDir){
  const dir=join(dataDir,'tls');mkdirSync(dir,{recursive:true});
  const key=join(dir,'key.pem'),cert=join(dir,'cert.pem');
  if(!existsSync(key)||!existsSync(cert)){
    const generated=await selfsigned.generate([{name:'commonName',value:'Companion personal device'}],{keySize:2048,algorithm:'sha256',notBeforeDate:new Date(Date.now()-60000),notAfterDate:new Date(Date.now()+730*86400000),extensions:[{name:'basicConstraints',cA:false},{name:'keyUsage',digitalSignature:true,keyEncipherment:true},{name:'extKeyUsage',serverAuth:true},{name:'subjectAltName',altNames:[{type:2,value:'localhost'},{type:7,ip:'127.0.0.1'}]}]});
    writeFileSync(key,generated.private,{mode:0o600});writeFileSync(cert,generated.cert,{mode:0o600});
  }
  const pem=readFileSync(cert,'utf8');const parsed=new X509Certificate(pem);
  if(Date.parse(parsed.validTo)<=Date.now())throw new Error('手机连接证书已过期，请重新配对设备');
  return {key:readFileSync(key),cert:pem,pin:parsed.fingerprint256.replaceAll(':','').toLowerCase()};
}
