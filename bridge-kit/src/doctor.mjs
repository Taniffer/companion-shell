import { readFile } from 'node:fs/promises';
import { Desktop } from './desktop.mjs';
const config = JSON.parse((await readFile(new URL('../config.local.json', import.meta.url), 'utf8')).replace(/^\uFEFF/,''));
const desktop = new Desktop(config.desktop);
try {
  const projects = await desktop.call('list_projects');
  console.log(JSON.stringify({desktop:'connected',projects:projects.projects?.map(p=>({id:p.projectId,name:p.label,kind:p.projectKind})),tools:desktop.catalog.map(t=>t.name)},null,2));
} finally { desktop.close(); }
