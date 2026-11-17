import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
export class Store {
  constructor(path) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, scope TEXT NOT NULL, status TEXT NOT NULL, value TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, value TEXT NOT NULL, sent INTEGER NOT NULL DEFAULT 0);
    `);
  }
  get(key, fallback = null) { const row = this.db.prepare('SELECT value FROM kv WHERE key=?').get(key); return row ? JSON.parse(row.value) : fallback; }
  set(key, value) { this.db.prepare('INSERT OR REPLACE INTO kv VALUES (?,?)').run(key, JSON.stringify(value)); }
  insert(job) { return this.db.prepare('INSERT OR IGNORE INTO jobs VALUES (?,?,?,?,?)').run(job.id,job.scope,job.status,JSON.stringify(job),Date.now()).changes > 0; }
  save(job) { this.db.prepare('UPDATE jobs SET status=?,value=? WHERE id=?').run(job.status,JSON.stringify(job),job.id); }
  jobs(statuses) { const qs=statuses.map(()=>'?').join(','); return this.db.prepare(`SELECT value FROM jobs WHERE status IN (${qs}) ORDER BY created`).all(...statuses).map(r=>JSON.parse(r.value)); }
  emit(id, value) { this.db.prepare('INSERT OR IGNORE INTO outbox (id,value) VALUES (?,?)').run(id,JSON.stringify(value)); }
  pending() { return this.db.prepare("SELECT * FROM outbox WHERE sent=0 AND COALESCE(json_extract(value,'$.retryAt'),0)<=? ORDER BY rowid LIMIT 30").all(Date.now()).map(r=>({...r,value:JSON.parse(r.value)})); }
  retryOut(out) {
    out.value.failures=(out.value.failures??0)+1;
    out.value.retryAt=Date.now()+Math.min(300000,3000*2**Math.min(out.value.failures-1,7));
    this.db.prepare('UPDATE outbox SET value=? WHERE id=?').run(JSON.stringify(out.value),out.id);
  }
  sent(id) { this.db.prepare('UPDATE outbox SET sent=1 WHERE id=?').run(id); }
  close() { this.db.close(); }
}
