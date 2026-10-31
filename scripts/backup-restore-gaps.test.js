/**
 * What a full backup restore brings back, and what devices learn of it,
 * against the real server on a scratch database:
 *
 * - Items and water deleted from a day (diary_tombstones) are in the
 *   backup, so a device still holding one can't put it back after a
 *   restore; one deleted after the backup no longer takes away what the
 *   restore brought back.
 * - A day's note time and its completion marks' times
 *   (notes_updated_at, completion_marked_at, meal_marks_at), and the key a
 *   phone made each food, meal, activity and fast with (client_key).
 * - Devices get what was restored: diary days, settings, workouts and coach
 *   messages changed after the backup are sent again as restored, and
 *   foods, meals, days, activities, fasts and coach messages made after the
 *   backup are sent as deleted, so no device keeps them.
 * - Webhooks survive the restore.
 * - A backup from before these restores.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { createServer as netServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const serverRequire = createRequire(new URL('../server/package.json', import.meta.url));
let ready = false;
try { const D = serverRequire('better-sqlite3'); new D(':memory:').close(); ready = true; } catch { /* server packages missing: skip */ }
const skip = !ready && 'server packages missing';

const freePort = () => new Promise((res) => { const s = netServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanEnv = () => {
  const keep = ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'SystemRoot', 'NODE_OPTIONS'];
  return Object.fromEntries(keep.filter((k) => process.env[k] != null).map((k) => [k, process.env[k]]));
};
const PW = 'Str0ng-Pass-77!x';
const JWT_SECRET = 'restore-gaps-test-0123456789abcdef01234567';
const serverDir = fileURLToPath(new URL('../server/', import.meta.url));

function server() {
  const s = { tok: {}, ids: {} };
  s.dir = mkdtempSync(join(tmpdir(), 'nt-restore-gaps-'));
  s.env = () => ({ ...cleanEnv(), DB_PATH: join(s.dir, 'nt.db'), UPLOADS_PATH: join(s.dir, 'uploads'), BACKUPS_PATH: join(s.dir, 'backups'), JWT_SECRET, INSECURE_COOKIES: '1', NODE_ENV: 'test', LOG_LEVEL: 'error', UPDATE_CHECK: 'off' });
  s.boot = async () => {
    const port = await freePort();
    s.base = `http://127.0.0.1:${port}`;
    s.proc = spawn(process.execPath, ['index.js'], { cwd: serverDir, env: { ...s.env(), PORT: String(port) }, stdio: ['ignore', 'ignore', process.env.SRV_LOG ? 'inherit' : 'ignore'] });
    for (let i = 0; i < 300; i++) {
      try { if ((await fetch(s.base + '/api/auth/status')).ok) return; } catch { /* not up yet */ }
      await sleep(100);
    }
    throw new Error('server did not start');
  };
  s.stop = async () => { const p = s.proc; s.proc = null; if (p && p.exitCode == null && p.signalCode == null) await new Promise((r) => { p.once('exit', r); p.kill(); }); };
  s.call = async (who, method, path, body) => {
    const h = { 'Content-Type': 'application/json' };
    if (who) h.Authorization = `Bearer ${s.tok[who]}`;
    const r = await fetch(s.base + path, { method, headers: h, body: body == null ? undefined : JSON.stringify(body) });
    const t = await r.text(); let data; try { data = JSON.parse(t); } catch { data = t; }
    return { status: r.status, data };
  };
  s.ok = async (...a) => { const r = await s.call(...a); assert.ok(r.status < 300, `${a[1]} ${a[2]} -> ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`); return r.data; };
  s.db = () => new (serverRequire('better-sqlite3'))(join(s.dir, 'nt.db'));
  s.sql = (fn) => { const d = s.db(); try { return fn(d); } finally { d.close(); } };
  s.sign = (id, username, role) => serverRequire('jsonwebtoken').sign({ id, username, role }, JWT_SECRET, { expiresIn: '1h' });
  s.setup = async () => {
    await s.boot();
    await s.ok(null, 'POST', '/api/auth/register', { username: 'admin', password: PW, full_name: 'Ada Admin' });
    s.tok.admin = (await s.ok(null, 'POST', '/api/auth/login', { username: 'admin', password: PW })).token;
    const eater = (await s.ok('admin', 'POST', '/api/auth/register', { username: 'eater', password: PW, full_name: 'Eve Eater', role: 'user' })).user;
    const coach = (await s.ok('admin', 'POST', '/api/auth/register', { username: 'coach', password: PW, full_name: 'Cory Coach', role: 'coach' })).user;
    s.ids.eater = eater.id; s.ids.coach = coach.id;
    s.tok.eater = s.sign(eater.id, 'eater', eater.role);
    s.tok.coach = s.sign(coach.id, 'coach', coach.role);
  };
  s.backup = async () => (await s.ok('admin', 'POST', '/api/full-backup')).filename;
  s.restore = async (filename) => s.ok('admin', 'POST', `/api/full-backup/${encodeURIComponent(filename)}/restore`);
  s.uploadRestore = async (zipPath, edit = () => {}) => {
    const AdmZip = serverRequire('adm-zip');
    const zip = new AdmZip(zipPath);
    const data = JSON.parse(zip.readAsText('database.json'));
    edit(data);
    zip.updateFile('database.json', Buffer.from(JSON.stringify(data)));
    const form = new FormData();
    form.append('backup', new Blob([zip.toBuffer()], { type: 'application/zip' }), 'backup.zip');
    const r = await fetch(s.base + '/api/full-backup/upload-restore', { method: 'POST', headers: { Authorization: `Bearer ${s.tok.admin}` }, body: form });
    assert.ok(r.ok, await r.text());
  };
  s.close = async () => { await s.stop(); rmSync(s.dir, { recursive: true, force: true }); };
  return s;
}

const item = (uuid) => ({ uuid, name: `Food ${uuid}`, kcal: 100, qty: 1, meal: 0 });
const uuidsOn = (date) => S.sql((d) => JSON.parse(d.prepare('SELECT items FROM diary WHERE user_id = ? AND date = ?').get(S.ids.eater, date)?.items || '[]').map((i) => i.uuid));

let S;
test.before(async () => {
  if (!ready) return;
  S = server();
  await S.setup();
});
test.after(async () => { await S?.close(); });

test('items deleted from a day: kept by the backup, and one deleted after it no longer eats the restore', { skip }, async () => {
  const date = '2026-05-01';
  await S.ok('eater', 'PUT', `/api/diary/${date}`, { items: [item('i1'), item('i2'), item('i3')] });
  // i3 deleted before the backup, i2 after it.
  await S.ok('eater', 'PUT', `/api/diary/${date}`, { items: [item('i1'), item('i2')], deleted_uuids: { items: ['i3'] } });
  const filename = await S.backup();
  await S.ok('eater', 'PUT', `/api/diary/${date}`, { items: [item('i1')], deleted_uuids: { items: ['i2'] } });
  assert.deepEqual(uuidsOn(date), ['i1']);
  await S.restore(filename);
  assert.deepEqual(uuidsOn(date), ['i1', 'i2'], 'restored as backed up');
  // A device that pulled the restored day saves it: i2 stays.
  await S.ok('eater', 'PUT', `/api/diary/${date}`, { items: [item('i1'), item('i2')], notes: 'later' });
  assert.deepEqual(uuidsOn(date), ['i1', 'i2']);
  // A stale device still holding i3 can't put it back.
  await S.ok('eater', 'PUT', `/api/diary/${date}`, { items: [item('i1'), item('i2'), item('i3')] });
  assert.deepEqual(uuidsOn(date), ['i1', 'i2']);
});

test("a day's note and completion times, and the keys phones made rows with, come back", { skip }, async () => {
  const u = S.ids.eater;
  const before = S.sql((d) => {
    d.prepare(`INSERT INTO diary (user_id, date, items, notes, notes_updated_at, completed_at, completed_meals, completion_marked_at, meal_marks_at)
      VALUES (?, '2026-05-02', '[]', 'note', '2026-05-02 08:00:00', '2026-05-02T20:00:00Z', '[0,1]', '2026-05-02T20:00:00.000Z', '{"0":"2026-05-02T09:00:00.000Z"}')`).run(u);
    const ins = (sql) => d.prepare(sql).run(u).lastInsertRowid;
    ins(`INSERT INTO foods (user_id, name, client_key) VALUES (?, 'Keyed Food', 'ck-food')`);
    ins(`INSERT INTO meals (user_id, name, client_key) VALUES (?, 'Keyed Meal', 'ck-meal')`);
    ins(`INSERT INTO activity_log (user_id, date, name, kcal, client_key) VALUES (?, '2026-05-02', 'Walk', 100, 'ck-act')`);
    ins(`INSERT INTO fasts (user_id, start_at, client_key) VALUES (?, '2026-05-02T00:00:00Z', 'ck-fast')`);
    return {
      day: d.prepare(`SELECT notes_updated_at, completion_marked_at, meal_marks_at FROM diary WHERE user_id = ? AND date = '2026-05-02'`).get(u),
      keys: ['foods', 'meals', 'activity_log', 'fasts'].map((t) => d.prepare(`SELECT client_key FROM ${t} WHERE client_key LIKE 'ck-%'`).get()?.client_key),
    };
  });
  const filename = await S.backup();
  await S.restore(filename);
  const after = S.sql((d) => ({
    day: d.prepare(`SELECT notes_updated_at, completion_marked_at, meal_marks_at FROM diary WHERE user_id = ? AND date = '2026-05-02'`).get(u),
    keys: ['foods', 'meals', 'activity_log', 'fasts'].map((t) => d.prepare(`SELECT client_key FROM ${t} WHERE client_key LIKE 'ck-%'`).get()?.client_key),
  }));
  assert.deepEqual(after, before);
  assert.deepEqual(after.keys, ['ck-food', 'ck-meal', 'ck-act', 'ck-fast']);
});

function pairUp() {
  const { eater, coach } = S.ids;
  return S.sql((d) => {
    const existing = d.prepare(`SELECT id FROM coach_clients WHERE coach_id = ? AND client_id = ? AND status = 'active'`).get(coach, eater);
    if (existing) return existing.id;
    return d.prepare(`INSERT INTO coach_clients (coach_id, client_id, status, responded_at) VALUES (?, ?, 'active', datetime('now'))`).run(coach, eater).lastInsertRowid;
  });
}
const say = (pairing, sender, uuid, body) => S.sql((d) => d.prepare(
  `INSERT INTO coach_messages (uuid, pairing_id, sender_id, body) VALUES (?, ?, ?, ?)`,
).run(uuid, pairing, sender, body).lastInsertRowid);

test('devices get the restored rows, and rows made after the backup as deleted', { skip }, async () => {
  const { eater, coach } = S.ids;
  const date = '2026-05-03';
  const pairing = pairUp();
  await S.ok('eater', 'PUT', `/api/diary/${date}`, { items: [item('d1')] });
  say(pairing, coach, 'n-kept', 'Good week');
  say(pairing, eater, 'n-deleted', 'Thanks coach');
  S.sql((d) => {
    d.prepare(`INSERT INTO user_settings (user_id, key, value) VALUES (?, 'waterGoal', '2000')`).run(eater);
    d.prepare(`INSERT INTO workouts (user_id, source, source_id, date, activity_name, calories) VALUES (?, 'fitbit', 'w1', ?, 'Run', 300)`).run(eater, date);
  });
  await sleep(1100); // a phone's cursor is later than the backup's rows
  const filename = await S.backup();

  // After the backup: the day, a setting, a workout and a message changed;
  // one of each kind of row made.
  await S.ok('eater', 'PUT', `/api/diary/${date}`, { items: [item('d1'), item('d2')] });
  await S.ok('eater', 'DELETE', '/api/coaching/messages/n-deleted');
  say(pairing, coach, 'n-after', 'Sent after the backup');
  const made = S.sql((d) => {
    d.prepare(`UPDATE user_settings SET value = '3000', updated_at = datetime('now') WHERE user_id = ? AND key = 'waterGoal'`).run(eater);
    d.prepare(`UPDATE workouts SET calories = 999, updated_at = datetime('now') WHERE source_id = 'w1'`).run();
    const ins = (sql, ...a) => d.prepare(sql).run(eater, ...a).lastInsertRowid;
    return {
      foods: ins(`INSERT INTO foods (user_id, name) VALUES (?, 'After Food')`),
      meals: ins(`INSERT INTO meals (user_id, name) VALUES (?, 'After Meal')`),
      diary: ins(`INSERT INTO diary (user_id, date, items) VALUES (?, '2026-05-04', '[]')`),
      activity: ins(`INSERT INTO activity_log (user_id, date, name, kcal) VALUES (?, '2026-05-04', 'After Walk', 50)`),
      fasts: ins(`INSERT INTO fasts (user_id, start_at) VALUES (?, '2026-05-04T00:00:00Z')`),
    };
  });
  const pull = async (since) => S.ok('eater', 'GET', `/api/sync/pull?coaching=1${since ? `&since=${encodeURIComponent(since)}` : ''}`);
  const cursor = (await pull()).server_time;
  await sleep(1100);
  await S.restore(filename);
  const p = await pull(cursor);

  const day = p.diary.find((x) => x.date === date);
  assert.deepEqual(day?.items?.map((i) => i.uuid), ['d1'], 'the day is sent again as restored');
  assert.equal(p.settings.find((x) => x.key === 'waterGoal')?.value, '2000', 'the setting is sent again as restored');
  assert.equal(p.workouts.find((x) => x.source_id === 'w1')?.calories, 300, 'the workout is sent again as restored');
  const msgs = Object.fromEntries(p.coach_messages.map((m) => [m.uuid, m]));
  assert.equal(msgs['n-deleted']?.body, 'Thanks coach', 'the message deleted after the backup comes back');
  assert.ok(msgs['n-after']?.deleted_at, 'the message sent after the backup is sent as deleted');
  assert.equal(msgs['n-after'].body, null);
  for (const [t, id] of Object.entries(made)) {
    const rows = p[t].filter((r) => r.id === id);
    assert.ok(rows.length && rows.every((r) => r.deleted_at), `${t}: the row made after the backup is sent as deleted`);
  }
  // The server holds the backup.
  const table = { activity: 'activity_log' };
  for (const [t, id] of Object.entries(made)) {
    assert.equal(S.sql((d) => d.prepare(`SELECT COUNT(*) AS n FROM ${table[t] || t} WHERE id = ? AND deleted_at IS NULL`).get(id).n), 0, `${t}: not alive on the server`);
  }
});

test('a wearable workout deleted before the restore still reaches devices as gone', { skip }, async () => {
  const u = S.ids.eater;
  const cursor = (await S.ok('eater', 'GET', '/api/sync/pull')).server_time;
  await sleep(1100);
  const id = S.sql((d) => d.prepare(`INSERT INTO workouts (user_id, source, source_id, date, activity_name) VALUES (?, 'fitbit', 'w-short', '2026-05-09', 'Swim')`).run(u).lastInsertRowid);
  // Deleted (a wearable re-sync of the day), then a backup without it restored.
  S.sql((d) => d.prepare('DELETE FROM workouts WHERE id = ?').run(id));
  const filename = await S.backup();
  await S.restore(filename);
  const p = await S.ok('eater', 'GET', `/api/sync/pull?since=${encodeURIComponent(cursor)}`);
  assert.ok(p.deletions.workouts.includes(id), 'a device that had the workout drops it');
});

test('a food made after the backup and edited offline before the restore stays deleted', { skip }, async () => {
  const filename = await S.backup();
  const id = S.sql((d) => d.prepare(`INSERT INTO foods (user_id, name) VALUES (?, 'Offline Food')`).run(S.ids.eater).lastInsertRowid);
  const editedAt = new Date().toISOString();
  await sleep(1100);
  await S.restore(filename);
  // The phone pushes its edit of that food, made before the restore.
  await S.ok('eater', 'POST', '/api/sync/push', { foods: [{ client_id: 1, server_id: id, name: 'Offline Food 2', updated_at: editedAt, changed_fields: ['name'] }], client_now: new Date().toISOString() });
  assert.ok(S.sql((d) => d.prepare('SELECT deleted_at FROM foods WHERE id = ?').get(id)?.deleted_at), 'the restore is newer than the edit');
  assert.equal(S.sql((d) => d.prepare(`SELECT COUNT(*) AS n FROM foods WHERE name LIKE 'Offline Food%' AND deleted_at IS NULL`).get().n), 0, 'nor made again');
});

test("a day made after the backup comes back empty when it is saved to again, and a recipe can come in again", { skip }, async () => {
  const date = '2026-05-20';
  const filename = await S.backup();
  await S.ok('eater', 'PUT', `/api/diary/${date}`, { items: [item('late1'), item('late2')], notes: 'after the backup' });
  S.sql((d) => d.prepare(`INSERT INTO meals (user_id, name, source_app, source_external_id) VALUES (?, 'From CT', 'cooktrace', 'recipe:7')`).run(S.ids.eater));
  await S.restore(filename);
  // Logging one food on that date: only it, not what the restore took away.
  await S.ok('eater', 'PUT', `/api/diary/${date}`, { items: [item('new1')] });
  assert.deepEqual(uuidsOn(date), ['new1']);
  assert.equal(S.sql((d) => d.prepare('SELECT notes FROM diary WHERE user_id = ? AND date = ?').get(S.ids.eater, date).notes), null);
  // The same recipe imported again.
  S.sql((d) => d.prepare(`INSERT INTO meals (user_id, name, source_app, source_external_id) VALUES (?, 'From CT', 'cooktrace', 'recipe:7')`).run(S.ids.eater));
});

test('webhooks survive a restore', { skip }, async () => {
  S.sql((d) => d.prepare(`INSERT INTO webhooks (user_id, url, secret_encrypted, events, enabled) VALUES (?, 'https://example.com/hook', 'x', '["diary.logged"]', 1)`).run(S.ids.eater));
  const q = 'SELECT id, user_id, url, secret_encrypted, events, enabled FROM webhooks ORDER BY id';
  const before = S.sql((d) => d.prepare(q).all());
  const filename = await S.backup();
  await S.restore(filename);
  assert.deepEqual(S.sql((d) => d.prepare(q).all()), before);
});

test('a backup from before these columns restores', { skip }, async () => {
  const filename = await S.backup();
  let noted;
  await S.uploadRestore(join(S.dir, 'backups', filename), (data) => {
    delete data.diary_tombstones; delete data.webhooks;
    for (const r of data.diary) { delete r.notes_updated_at; delete r.completion_marked_at; delete r.meal_marks_at; }
    for (const t of ['foods', 'meals', 'activity_log', 'fasts']) for (const r of data[t]) delete r.client_key;
    noted = data.diary.find((r) => r.notes != null);
  });
  // A note from before its time was kept counts from the day's last change,
  // as at upgrade (db.js), not from the restore.
  assert.ok(noted);
  assert.equal(S.sql((d) => d.prepare('SELECT notes_updated_at FROM diary WHERE id = ?').get(noted.id).notes_updated_at), noted.updated_at);
});

// Every table is in the backup and every column comes back, so a column or
// table added later can't go missing from a restore without this failing.
// Left out on purpose: the server's write times that the pull reads
// (changed_at, and updated_at where the restore sets it to now), and
// short-lived, cache or server-kept tables. Wearable tokens are locked with
// this server's key (see dumpDatabase).
const NOT_BACKED_UP = new Set(['oauth_state', 'sync_deletions', 'password_reset_tokens', 'fitbit_tokens', 'garmin_tokens', 'google_health_tokens', 'withings_tokens', 'create_keys', 'user_email_changes', 'oidc_link_grants']);
const NOT_WRITTEN = {
  changed_at: ['foods', 'meals', 'activity_log', 'fasts'],
  session_version: ['users'],
};
test('every table is backed up and every column restored', { skip }, async () => {
  const src = readFileSync(new URL('../server/routes/full-backup.js', import.meta.url), 'utf8');
  const dump = src.slice(src.indexOf('function dumpDatabase'));
  const restore = src.slice(src.indexOf('function restoreFromZip'), src.indexOf('function dumpDatabase'));
  const written = {};
  for (const m of restore.matchAll(/INSERT(?:\s+OR\s+\w+)?\s+INTO\s+(\w+)\s*\(([^)]*)\)/g)) {
    for (const c of m[2].split(',').map((x) => x.trim()).filter(Boolean)) (written[m[1]] ||= new Set()).add(c);
  }
  const tables = S.sql((d) => d.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all().map((r) => r.name));
  for (const t of tables) {
    if (NOT_BACKED_UP.has(t)) continue;
    assert.match(dump, new RegExp(`\\b${t}:`), `${t} is in the backup`);
    assert.ok(written[t], `${t} is restored`);
    for (const { name } of S.sql((d) => d.prepare(`PRAGMA table_info(${t})`).all())) {
      if (NOT_WRITTEN[name]?.includes(t)) continue;
      assert.ok(written[t].has(name), `${t}.${name} is restored`);
    }
  }
});

test('without user accounts: an item deleted after the backup no longer eats the restore, and a day is never there twice', { skip }, async () => {
  const S1 = server();
  try {
    await S1.boot();
    S1.sql((d) => d.prepare(`INSERT OR REPLACE INTO app_config (key, value) VALUES ('single_user_mode', '1')`).run());
    const date = '2026-06-01';
    const items = (u) => S1.sql((d) => JSON.parse(d.prepare('SELECT items FROM diary WHERE user_id IS NULL AND date = ? AND deleted_at IS NULL').get(u)?.items || '[]').map((i) => i.uuid));
    await S1.ok(null, 'PUT', `/api/diary/${date}`, { items: [item('s1'), item('s2')] });
    await S1.ok(null, 'PUT', '/api/diary/2026-06-02', { items: [item('t1')] });
    const filename = await S1.backup();
    // s2 deleted after the backup (its tombstone stays: no account to take it with).
    await S1.ok(null, 'PUT', `/api/diary/${date}`, { items: [item('s1')], deleted_uuids: { items: ['s2'] } });
    // The other day made again under a new id (as an import does).
    S1.sql((d) => {
      const r = d.prepare(`SELECT * FROM diary WHERE user_id IS NULL AND date = '2026-06-02'`).get();
      d.prepare('DELETE FROM diary WHERE id = ?').run(r.id);
      d.prepare(`INSERT INTO diary (user_id, date, items) VALUES (NULL, '2026-06-02', ?)`).run(r.items);
    });
    await S1.restore(filename);
    assert.deepEqual(items(date), ['s1', 's2']);
    await S1.ok(null, 'PUT', `/api/diary/${date}`, { items: [item('s1'), item('s2')], notes: 'later' });
    assert.deepEqual(items(date), ['s1', 's2'], 'the next save keeps what the restore brought back');
    assert.equal(S1.sql((d) => d.prepare(`SELECT COUNT(*) AS n FROM diary WHERE user_id IS NULL AND date = '2026-06-02'`).get().n), 1, 'one row for the day');
    assert.deepEqual(items('2026-06-02'), ['t1']);
    // A backup with accounts restored here: what this server held without
    // accounts isn't kept (it would be handed to one of them).
    S1.sql((d) => d.prepare(`INSERT INTO foods (user_id, name) VALUES (NULL, 'Solo Food')`).run());
    await S1.uploadRestore(join(S.dir, 'backups', await S.backup()));
    assert.equal(S1.sql((d) => d.prepare('SELECT COUNT(*) AS n FROM foods WHERE user_id IS NULL').get().n), 0);
    assert.equal(S1.sql((d) => d.prepare('SELECT COUNT(*) AS n FROM diary WHERE user_id IS NULL').get().n), 0);
  } finally { await S1.close(); }
});
