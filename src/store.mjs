import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { EventEmitter } from 'node:events';

export class Store extends EventEmitter {
  constructor(path = ':memory:') {
    super();
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(run TEXT NOT NULL REFERENCES runs(id), seq INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(run,seq));
      CREATE TABLE IF NOT EXISTS effects(run TEXT NOT NULL REFERENCES runs(id), n INTEGER NOT NULL, key TEXT, operation TEXT NOT NULL, tool TEXT NOT NULL, amount INTEGER NOT NULL, result TEXT NOT NULL, PRIMARY KEY(run,n), UNIQUE(run,key));
      CREATE TABLE IF NOT EXISTS checkpoints(run TEXT PRIMARY KEY REFERENCES runs(id), data TEXT NOT NULL);`);
  }
  create(run) { this.db.prepare('INSERT INTO runs VALUES(?,?)').run(run.id, JSON.stringify(run)); return run; }
  run(id) { const r = this.db.prepare('SELECT data FROM runs WHERE id=?').get(id); return r ? JSON.parse(r.data) : null; }
  list() { return this.db.prepare('SELECT data FROM runs ORDER BY rowid DESC LIMIT 100').all().map(r => JSON.parse(r.data)); }
  update(id, patch) {
    const run = this.run(id);
    if (!run) throw new Error('Run not found');
    Object.assign(run, patch);
    this.db.prepare('UPDATE runs SET data=? WHERE id=?').run(JSON.stringify(run), id);
    return run;
  }
  event(id, type, detail = {}) {
    const { n } = this.db.prepare('SELECT COALESCE(MAX(seq),0)+1 AS n FROM events WHERE run=?').get(id);
    const event = { seq: n, time: new Date().toISOString(), type, ...detail };
    this.db.prepare('INSERT INTO events VALUES(?,?,?)').run(id, n, JSON.stringify(event));
    this.emit('event', id, event);
    return event;
  }
  events(id, after = 0) { return this.db.prepare('SELECT data FROM events WHERE run=? AND seq>? ORDER BY seq').all(id, after).map(r => JSON.parse(r.data)); }
  effects(id) { return this.db.prepare('SELECT * FROM effects WHERE run=? ORDER BY n').all(id).map(({ result, ...r }) => ({ ...r, result: JSON.parse(result) })); }
  commit(id, { key, operation, tool, amount = 0 }) {
    this.db.exec('BEGIN IMMEDIATE');
    let result;
    let reused = false;
    try {
      const existing = key ? this.db.prepare('SELECT * FROM effects WHERE run=? AND key=?').get(id, key) : null;
      if (existing) {
        if (existing.operation !== operation || existing.tool !== tool || existing.amount !== amount) throw new Error('IDEMPOTENCY_CONFLICT');
        result = JSON.parse(existing.result);
        reused = true;
      } else {
        const { n } = this.db.prepare('SELECT COALESCE(MAX(n),0)+1 AS n FROM effects WHERE run=?').get(id);
        result = { effectId: `effect-${n}`, operation, tool, amount, status: 'committed' };
        this.db.prepare('INSERT INTO effects VALUES(?,?,?,?,?,?,?)').run(id, n, key || null, operation, tool, amount, JSON.stringify(result));
      }
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    // The ledger is authoritative; telemetry is deliberately outside its transaction.
    this.event(id, reused ? 'effect.deduplicated' : 'effect.committed', { operation, tool, effectId: result.effectId, amount });
    return result;
  }
  checkpoint(id) { const r = this.db.prepare('SELECT data FROM checkpoints WHERE run=?').get(id); return r ? JSON.parse(r.data) : { completed: [] }; }
  saveCheckpoint(id, data) { this.db.prepare('INSERT INTO checkpoints VALUES(?,?) ON CONFLICT(run) DO UPDATE SET data=excluded.data').run(id, JSON.stringify(data)); }
  close() { this.db.close(); }
}
