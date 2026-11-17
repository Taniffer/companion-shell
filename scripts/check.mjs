import { readdirSync } from 'node:fs';
import { join,dirname,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
let count=0;for(const directory of ['src','web','scripts'])for(const file of readdirSync(join(root,directory)))if(/\.(mjs|js)$/.test(file)){execFileSync(process.execPath,['--check',join(root,directory,file)],{windowsHide:true,stdio:'pipe'});count++;}console.log(`Syntax checked: ${count} modules`);
