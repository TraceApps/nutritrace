/**
 * Upgrading a server from before goal history: its first start records the
 * baseline for the accounts that exist, using the columns it needs — which
 * that same start adds (user_settings.field_times). A start that runs the
 * baseline before the migrations leaves every existing account without
 * history until a second restart or a goal change.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));
let Database = null;
try { Database = createRequire(new URL('../server/package.json', import.meta.url))('better-sqlite3'); } catch { /* not built */ }
const skip = t => {
  if (!Database) {
    t.skip('better-sqlite3 is not built for this Node');
    return true;
  }
  return false;
};

test('a server from before goal history gets a baseline on its first start', (t) => {
  if (skip(t)) return;
  const dir = mkdtempSync(join(tmpdir(), 'nt-goal-upgrade-'));
  const path = join(dir, 'old.db');
  try {
    // The tables as they were before this feature: no goal_history, and no
    // field_times columns (the start adds them). The password column is
    // nullable so the users rebuild, a separate migration, doesn't run.
    const old = new Database(path);
    old.exec(`
      CREATE TABLE users (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        username      TEXT UNIQUE NOT NULL,
        password_hash TEXT
      );
      CREATE TABLE user_settings (
        user_id    INTEGER NOT NULL,
        key        TEXT NOT NULL,
        value      TEXT,
        updated_at TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (user_id, key)
      );
    `);
    const user = Number(old.prepare(
      `INSERT INTO users (username, password_hash) VALUES ('old', 'x')`
    ).run().lastInsertRowid);
    const set = (key, value) => old.prepare(
      `INSERT INTO user_settings (user_id, key, value) VALUES (?, ?, ?)`
    ).run(user, key, JSON.stringify(value));
    set('goals', { calories: { max: 2300, sharedGoal: true } });
    set('waterGoalMl', 2700);
    old.close();

    const todayBefore = new Date().toISOString().slice(0, 10);
    const started = spawnSync(process.execPath, ['--input-type=module', '-e', "await import('./server/db.js')"], {
      cwd: root, encoding: 'utf8',
      env: { ...process.env, DB_PATH: path, NODE_ENV: 'test', JWT_SECRET: 'goal-history-upgrade-only', LOG_LEVEL: 'error' },
    });
    assert.equal(started.status, 0, started.stderr || started.stdout);

    const db = new Database(path, { readonly: true });
    try {
      const columns = db.prepare('PRAGMA table_info(user_settings)').all().map(c => c.name);
      assert.ok(columns.includes('field_times'), 'this start added the column the baseline reads');

      const rows = db.prepare(
        'SELECT effective_date, snapshot, source FROM goal_history WHERE user_id = ?'
      ).all(user);
      assert.equal(rows.length, 1, 'the baseline was written by this start, not a later one');
      assert.equal(rows[0].source, 'migration_baseline');
      const snapshot = JSON.parse(rows[0].snapshot);
      assert.equal(snapshot.goals.calories.max, 2300);
      assert.equal(snapshot.water_goal_ml, 2700);

      const todayAfter = new Date().toISOString().slice(0, 10);
      assert.ok([todayBefore, todayAfter].includes(rows[0].effective_date),
        `dated the day of the start (got ${rows[0].effective_date})`);
    } finally { db.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
