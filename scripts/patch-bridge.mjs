import { readFileSync,writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const fence=`// BEGIN COMPANION_LOCAL_FENCE
let companionRuntimeReady = false;
for (const method of ['reply','progress','reaction','clearReaction','finishProgress','topicContext','attachments','deliverArtifact']) {
  const original = feishu[method].bind(feishu);
  feishu[method] = async (job, ...args) => {
    if (job?.channel === 'local' || String(job?.id ?? '').startsWith('companion-')) throw new Error('Local companion delivery requires the companion runtime');
    return original(job, ...args);
  };
}
const companionOriginalCall = desktop.call.bind(desktop);
desktop.call = async (name, args = {}) => {
  if (!companionRuntimeReady && ['create_thread','send_message_to_thread'].includes(name) && String(args.prompt ?? '').startsWith('[飞书消息:companion-')) throw new Error('Local companion work is paused until its runtime is available');
  return companionOriginalCall(name, args);
};
// END COMPANION_LOCAL_FENCE`;
const addon=`// BEGIN COMPANION_MVP_ADDON
let companionAddon;
if (config.companion?.module) {
  try {
    const { pathToFileURL } = await import('node:url');
    const { startCompanion } = await import(pathToFileURL(config.companion.module).href);
    companionAddon = await startCompanion({bridge, desktop, store, feishu, config, log, root});
    companionRuntimeReady = true;
  } catch (error) { log('companion_start_error', {message:error.message}); }
}
// END COMPANION_MVP_ADDON`;
export function patchBridge(source,{enable=true}={}){
  const anchor=/^const bridge\s*=\s*new Bridge\([^\r\n]+\);\r?$/m;
  if(!anchor.test(source))throw new Error('The bridge entry has changed; no compatibility patch was applied');
  source=source.replace(/\r?\n?\/\/ BEGIN COMPANION_MVP_ADDON\r?\n[\s\S]*?\/\/ END COMPANION_MVP_ADDON\r?\n?/,'\n');
  if(!source.includes('// BEGIN COMPANION_LOCAL_FENCE'))source=source.replace(anchor,match=>fence+'\n'+match);
  if(enable)source=source.replace(anchor,match=>match+'\n'+addon+'\n');
  return source;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){const path=process.argv[2];if(!path)throw new Error('Expected the bridge entry path');const source=readFileSync(path,'utf8');writeFileSync(path,patchBridge(source,{enable:!process.argv.includes('--disable')}),'utf8');console.log('Bridge compatibility entry prepared.');}
