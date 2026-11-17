import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
const path=join(process.argv[2]??'','data','bridge.sqlite');
if(!existsSync(path)){console.error('Bridge database is unavailable; detach check stopped.');process.exitCode=2;}
else{const db=new DatabaseSync(path,{readOnly:true});try{const local="(json_extract(value,'$.channel')='local' OR id LIKE 'companion-%')";const localPendingJobs=db.prepare(`SELECT count(*) AS n FROM jobs WHERE ${local} AND status IN ('queued','dispatching','pendingThread','running','finishing')`).get().n;const localPendingOutbox=db.prepare("SELECT count(*) AS n FROM outbox WHERE sent=0 AND (json_extract(value,'$.job.channel')='local' OR json_extract(value,'$.job.id') LIKE 'companion-%')").get().n;console.log(JSON.stringify({localPendingJobs,localPendingOutbox}));if(localPendingJobs||localPendingOutbox)process.exitCode=2;}finally{db.close();}}
