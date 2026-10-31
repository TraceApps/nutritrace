/**
 * Lookups that ignore a deleted row, on a real server (server/index.js,
 * scratch database), with accounts on:
 *
 *   - A meal or recipe saved with a source (source_app, source_external_id:
 *     a recipe pulled from CookTrace, a coach's meal) lets go of the place a
 *     deleted one holds in the unique index, as a deleted food does, so the
 *     same recipe can come in again. It used to fail with a 500.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));
const serverRequire = createRequire(new URL('../server/package.json', import.meta.url));
let ready = false;
try { serverRequire('better-sqlite3'); ready = true; } catch { /* not built for this Node */ }
const skip = t => { if (!ready) { t.skip('better-sqlite3 is not built for this Node'); return true; } return false; };

const dir = ready ? mkdtempSync(join(tmpdir(), 'nt-deleted-lookups-')) : null;
const JWT_SECRET = 'deleted-lookups-test-secret-0123456789abcdef';
const PW = 'Str0ng-Pass-77!x';
let server = null, base = null, sqlite = null;
const tok = {};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(res => { const s = createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });

async function call(who, method, path, body) {
  const r = await fetch(base + path, {
    method, headers: { 'Content-Type': 'application/json', ...(who ? { Authorization: `Bearer ${tok[who]}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: r.status, data };
}
async function ok(...a) {
  const r = await call(...a);
  if (r.status >= 300) throw new Error(`${a[1]} ${a[2]} ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
  return r.data;
}
const row = (table, id) => sqlite.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);

test.before(async () => {
  if (!ready) return;
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['index.js'], {
    cwd: join(root, 'server'), stdio: 'ignore',
    env: { ...process.env, PORT: String(port), DB_PATH: join(dir, 'server.db'), UPLOADS_PATH: join(dir, 'uploads'), JWT_SECRET, INSECURE_COOKIES: '1', NODE_ENV: 'test', LOG_LEVEL: 'error', UPDATE_CHECK: 'off' },
  });
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(base + '/api/auth/status')).ok) break; } catch {}
    await sleep(100);
  }
  await fetch(base + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'ada', password: PW }) });
  tok.ada = (await (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'ada', password: PW }) })).json()).token;
  const jwt = serverRequire('jsonwebtoken');
  for (const name of ['ben']) {
    const { user } = await ok('ada', 'POST', '/api/auth/register', { username: name, password: PW, role: 'user' });
    tok[name] = jwt.sign({ id: user.id, username: name, role: 'user', csrf: 'x' }, JWT_SECRET, { expiresIn: '1h' });
  }
  const Database = serverRequire('better-sqlite3');
  sqlite = new Database(join(dir, 'server.db'));
});
test.after(() => {
  try { sqlite?.close(); } catch {}
  try { server?.kill(); } catch {}
  if (dir) rmSync(dir, { recursive: true, force: true });
});

for (const [kind, path, table] of [['meal', '/api/meals', 'meals'], ['recipe', '/api/meals', 'meals'], ['food', '/api/foods', 'foods']]) {
  const body = (n, extra = {}) => ({ name: n, nutrition: { calories: 100 }, items: [], portion: 100, unit: 'g', ...(kind === 'recipe' ? { is_recipe: 1 } : {}), source_app: 'cooktrace', source_external_id: `${kind}:1`, ...extra });

  test(`${kind}: saved again from the source of one that was deleted, it is made new and the deleted one lets go of the source`, async (t) => {
    if (skip(t)) return;
    const first = await call('ada', 'POST', path, body('Source Once'));
    assert.equal(first.status, 201);
    // A re-import while it is there updates it in place, as before.
    const same = await call('ada', 'POST', path, body('Source Once Renamed'));
    assert.deepEqual([same.status, same.data.id, same.data.name], [200, first.data.id, 'Source Once Renamed']);
    await ok('ada', 'DELETE', `${path}/${first.data.id}`);
    const second = await call('ada', 'POST', path, body('Source Twice'));
    assert.equal(second.status, 201, JSON.stringify(second.data));
    assert.notEqual(second.data.id, first.data.id);
    assert.equal(second.data.source_external_id, `${kind}:1`);
    assert.equal(row(table, second.data.id).deleted_at, null);
    // The deleted one is still deleted, and no longer holds the source.
    const old = row(table, first.data.id);
    assert.ok(old.deleted_at);
    assert.deepEqual([old.source_app, old.source_external_id], [null, null]);
    // The next re-import finds the live one.
    assert.deepEqual((await call('ada', 'POST', path, body('Source Thrice'))).data.id, second.data.id);
    // Another account's same source is its own.
    const other = await call('ben', 'POST', path, body('Ben Source'));
    assert.equal(other.status, 201);
    assert.notEqual(other.data.id, second.data.id);
  });
}
