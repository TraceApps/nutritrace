/**
 * Trace's chat history shows the newest messages, in the order they were
 * written.
 *
 * GET /api/ai/history returned the OLDEST 100 messages, so once an account
 * had more than 100, reopening Trace never showed the newest ones, on the
 * web or in the app. Picking the newest keeps a question and its answer
 * saved in the same second in the order they were written (id breaks ties).
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

// server/db.js opens DB_PATH when imported: a scratch database.
let db = null, dir = null, server = null, base = null;
try {
  const req = createRequire(new URL('../server/package.json', import.meta.url));
  req('better-sqlite3');
  dir = mkdtempSync(join(tmpdir(), 'ai-history-'));
  process.env.DB_PATH = join(dir, 'test.db');
  db = (await import('../server/db.js')).default;
  const express = req('express');
  const { default: aiRoutes } = await import('../server/routes/ai.js');
  const app = express();
  app.use(express.json());
  // what requireAuth leaves behind: the signed-in account, picked per request here
  app.use((r, _res, next) => { r.user = { id: Number(r.headers['x-user']), role: 'admin' }; next(); });
  app.use('/api/ai', aiRoutes);
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
} catch { /* better-sqlite3 not built for this Node: the cases skip */ }
test.after(() => { server?.close(); try { db?.close(); } catch {} if (dir) rmSync(dir, { recursive: true, force: true }); });

const user = (n) => Number(db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(n + Math.random(), 'x').lastInsertRowid);
const say = (u, role, content, at) => db.prepare('INSERT INTO ai_chat_history (user_id, role, content, created_at) VALUES (?, ?, ?, ?)').run(u, role, content, at);
const history = async (u) => (await fetch(`${base}/api/ai/history`, { headers: { 'x-user': String(u) } })).json();
const at = (s) => new Date(Date.UTC(2026, 9, 1, 8, 0, 0) + s * 1000).toISOString().replace('T', ' ').slice(0, 19);

test('history is the newest 100 messages, oldest first', async (t) => {
  if (!db) return t.skip('better-sqlite3 is not built for this Node');
  const me = user('me');
  for (let i = 1; i <= 150; i++) say(me, i % 2 ? 'user' : 'assistant', `message ${i}`, at(i));
  const rows = await history(me);
  assert.equal(rows.length, 100);
  assert.equal(rows[0].content, 'message 51');
  assert.equal(rows[99].content, 'message 150', 'the newest message is shown');
  assert.deepEqual(rows.map(r => r.content), Array.from({ length: 100 }, (_, i) => `message ${i + 51}`));
});

test('a question and its answer saved in the same second keep their order', async (t) => {
  if (!db) return t.skip('better-sqlite3 is not built for this Node');
  const me = user('me');
  for (let i = 0; i < 20; i++) {
    say(me, 'user', `question ${i}`, at(1000 + i));
    say(me, 'assistant', `answer ${i}`, at(1000 + i));
  }
  const rows = await history(me);
  assert.deepEqual(rows.map(r => r.content), Array.from({ length: 20 }, (_, i) => [`question ${i}`, `answer ${i}`]).flat());
});

test("another account's chat never shows", async (t) => {
  if (!db) return t.skip('better-sqlite3 is not built for this Node');
  const me = user('me'), other = user('other');
  say(me, 'user', 'mine', at(5000));
  say(other, 'user', 'theirs', at(5001));
  assert.deepEqual((await history(me)).map(r => r.content), ['mine']);
});
