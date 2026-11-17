import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { join,dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const size=48,raw=Buffer.alloc(size*(size*4+1));
for(let y=0;y<size;y++)for(let x=0;x<size;x++){let color=[40,91,68,255];if(x>=13&&x<35&&y>=10&&y<38)color=[246,249,241,255];if(x>=18&&x<30&&((y>=17&&y<19)||(y>=23&&y<25)||(y>=29&&y<31)))color=[40,91,68,255];const at=y*(size*4+1)+1+x*4;for(let i=0;i<4;i++)raw[at+i]=color[i];}
function crc(bytes){let n=0xffffffff;for(const b of bytes){n^=b;for(let i=0;i<8;i++)n=n&1?0xedb88320^(n>>>1):n>>>1;}return(n^0xffffffff)>>>0;}
function chunk(type,data){const name=Buffer.from(type),len=Buffer.alloc(4),sum=Buffer.alloc(4);len.writeUInt32BE(data.length);sum.writeUInt32BE(crc(Buffer.concat([name,data])));return Buffer.concat([len,name,data,sum]);}
const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(size,0);ihdr.writeUInt32BE(size,4);ihdr[8]=8;ihdr[9]=6;
const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
const header=Buffer.alloc(22);header.writeUInt16LE(1,2);header.writeUInt16LE(1,4);header[6]=size;header[7]=size;header.writeUInt16LE(1,10);header.writeUInt16LE(32,12);header.writeUInt32LE(png.length,14);header.writeUInt32LE(22,18);
writeFileSync(join(dirname(fileURLToPath(import.meta.url)),'..','web','companion.ico'),Buffer.concat([header,png]));
