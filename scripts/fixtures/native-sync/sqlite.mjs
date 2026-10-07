// @capacitor-community/sqlite stand-in on better-sqlite3 (the server's
// copy). PHONE_DB is the file, so a later run is the same phone after an
// app restart. __bridgeRuns counts writes, each a trip across the native
// bridge on a phone.
import { createRequire } from 'node:module';
const Database = createRequire(new URL('../../../server/package.json', import.meta.url))('better-sqlite3');
const dbs = new Map();
const norm = p => (p || []).map(v => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));
function conn(name) {
  if (!dbs.has(name)) dbs.set(name, new Database(process.env.PHONE_DB ? `${process.env.PHONE_DB}-${name}.db` : ':memory:'));
  const db = dbs.get(name);
  return {
    async open() {}, async close() {},
    // As the Android plugin runs a script (UtilsSQLite.getStatementsArray +
    // Database.execute): split on ";\n" only, lines joined, "--" comments
    // dropped, and each piece handed to execSQL, which runs only its first
    // statement. Two statements on one line: the second silently never runs.
    async execute(sql) {
      const before = db.prepare('SELECT total_changes() AS n').get().n;
      for (const raw of String(sql).replace(/end;/g, 'END;').split(';\n')) {
        const piece = raw.split('\n').map(l => { const i = l.indexOf('--'); return (i > -1 ? l.slice(0, i) : l).trim(); }).filter(Boolean).join(' ');
        if (!piece) continue;
        const first = piece.includes(';') ? piece.slice(0, piece.indexOf(';')) : piece;
        if (first.trim()) db.exec(first);
      }
      return { changes: { changes: db.prepare('SELECT total_changes() AS n').get().n - before } };
    },
    async query(sql, params) { return { values: db.prepare(sql).all(...norm(params)) }; },
    // Each write waits a turn, as a trip across the native bridge does, so
    // other work (a sign-in, a timer) can run while a sync is writing.
    // BRIDGE_DELAY_MS makes each trip that slow (a long pull on a phone).
    async run(sql, params) { await new Promise(r => (process.env.BRIDGE_DELAY_MS ? setTimeout(r, Number(process.env.BRIDGE_DELAY_MS)) : setImmediate(r))); globalThis.__bridgeRuns = (globalThis.__bridgeRuns || 0) + 1; const r = db.prepare(sql).run(...norm(params)); return { changes: { changes: Number(r.changes), lastId: Number(r.lastInsertRowid) } }; },
  };
}
export const CapacitorSQLite = { clearEncryptionSecret: async () => {} };
export class SQLiteConnection {
  async checkConnectionsConsistency() { return { result: false }; }
  async isConnection() { return { result: false }; }
  async closeConnection() {}
  async closeAllConnections() {}
  async deleteDatabase() {}
  async retrieveConnection(n) { return conn(n); }
  async createConnection(n) { return conn(n); }
}
