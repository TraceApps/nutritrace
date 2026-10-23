/**
 * The first-run setup's birthday and gender reach the account (#269).
 * Setup stored them only as the 'dob' and 'gender' settings, while Profile,
 * the API and Trace read users.birthday and users.gender, so a person who set
 * up their server saw both fields empty. Real routes over a scratch
 * database; skipped where better-sqlite3 isn't built for this Node.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

let db = null, dir = null, server = null, base = null;
try {
  const req = createRequire(new URL('../server/package.json', import.meta.url));
  req('better-sqlite3');
  dir = mkdtempSync(join(tmpdir(), 'profile-setup-'));
  process.env.DB_PATH = join(dir, 'test.db');
  db = (await import('../server/db.js')).default;
  const express = req('express');
  const { default: settingsRoutes } = await import('../server/routes/settings.js');
  const { default: syncRoutes } = await import('../server/routes/sync.js');
  const { default: authRoutes } = await import('../server/routes/auth.js');
  const app = express();
  app.use(express.json());
  // what requireAuth leaves behind: the signed-in account, picked per request here
  app.use((r, _res, next) => { r.user = { id: Number(r.headers['x-user']), role: 'admin' }; next(); });
  app.use('/api/settings', settingsRoutes);
  app.use('/api/sync', syncRoutes);
  app.use('/api/auth', authRoutes);
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
} catch { /* better-sqlite3 not built for this Node: the cases skip */ }
test.after(() => { server?.close(); try { db?.close(); } catch {} if (dir) rmSync(dir, { recursive: true, force: true }); });

const user = (n, extra = {}) => Number(db.prepare('INSERT INTO users (username, password_hash, birthday, gender) VALUES (?, ?, ?, ?)')
  .run(n + Math.random(), 'x', extra.birthday ?? null, extra.gender ?? null).lastInsertRowid);
const setting = (u, key, value) => db.prepare(`INSERT INTO user_settings (user_id, key, value) VALUES (?, ?, ?)
  ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value`).run(u, key, JSON.stringify(value));
const account = (u) => db.prepare('SELECT birthday, gender FROM users WHERE id = ?').get(u);
const send = (u, method, path, body) => fetch(`${base}${path}`, {
  method, headers: { 'Content-Type': 'application/json', 'x-user': String(u) }, body: JSON.stringify(body),
}).then(r => r.json());

test('setup through the web: its answers land on the account', async (t) => {
  if (!db) return t.skip('better-sqlite3 is not built for this Node');
  const me = user('web');
  // What the wizard's finish sends.
  await send(me, 'PUT', '/api/settings/bulk', { settings: { gender: 'female', dob: '1990-04-02', height_cm: 170, setupComplete: true } });
  assert.deepEqual(account(me), { birthday: '1990-04-02', gender: 'Female' });
});

test('one setting at a time, and an app moving its local data over by sync push', async (t) => {
  if (!db) return t.skip('better-sqlite3 is not built for this Node');
  const one = user('one');
  await send(one, 'PUT', '/api/settings', { key: 'dob', value: '1979-12-31' });
  await send(one, 'PUT', '/api/settings', { key: 'gender', value: 'male' });
  assert.deepEqual(account(one), { birthday: '1979-12-31', gender: 'Male' });
  const phone = user('phone');
  await send(phone, 'POST', '/api/sync/push', { settings: [{ key: 'gender', value: 'female' }, { key: 'dob', value: '2001-01-01' }] });
  assert.deepEqual(account(phone), { birthday: '2001-01-01', gender: 'Female' });
});

test('what was set in Profile is never overwritten', async (t) => {
  if (!db) return t.skip('better-sqlite3 is not built for this Node');
  const me = user('kept', { birthday: '1985-06-15', gender: 'Non-binary' });
  await send(me, 'PUT', '/api/settings/bulk', { settings: { gender: 'female', dob: '2001-01-01' } });
  assert.deepEqual(account(me), { birthday: '1985-06-15', gender: 'Non-binary' });
  // Only the empty one is filled.
  const half = user('half', { gender: 'Prefer not to say' });
  await send(half, 'PUT', '/api/settings/bulk', { settings: { gender: 'male', dob: '1990-01-01' } });
  assert.deepEqual(account(half), { birthday: '1990-01-01', gender: 'Prefer not to say' });
});

test('other settings leave the account alone, and a date that is not one is not copied', async (t) => {
  if (!db) return t.skip('better-sqlite3 is not built for this Node');
  const me = user('other');
  setting(me, 'dob', 'sometime');
  await send(me, 'PUT', '/api/settings', { key: 'height_cm', value: 180 });
  assert.deepEqual(account(me), { birthday: null, gender: null });
  await send(me, 'PUT', '/api/settings', { key: 'gender', value: 'female' });
  assert.deepEqual(account(me), { birthday: null, gender: 'Female' });
});

test('Profile and an older app writing "female" are kept the way Profile names it', async (t) => {
  if (!db) return t.skip('better-sqlite3 is not built for this Node');
  const me = user('older');
  await send(me, 'PUT', '/api/auth/profile', { full_name: 'A', gender: 'female', birthday: '1990-04-02' });
  assert.equal(account(me).gender, 'Female');
  await send(me, 'PUT', '/api/auth/profile', { full_name: 'A', gender: 'Something else', birthday: '1990-04-02' });
  assert.equal(account(me).gender, 'Something else', 'anything else is kept as written');
});

test('a profile save that leaves fields out keeps them; an empty one still clears', async (t) => {
  if (!db) return t.skip('better-sqlite3 is not built for this Node');
  const me = user('partial');
  db.prepare('UPDATE users SET full_name = ?, email = ?, nickname = ? WHERE id = ?').run('Alex Doe', 'alex@example.com', 'Lex', me);
  // What turning user accounts on sends: only what this device knew.
  await send(me, 'PUT', '/api/auth/profile', { full_name: 'Alex Doe', birthday: '1990-04-02', gender: 'female' });
  const row = () => db.prepare('SELECT full_name, nickname, email, birthday, gender FROM users WHERE id = ?').get(me);
  assert.deepEqual(row(), { full_name: 'Alex Doe', nickname: 'Lex', email: 'alex@example.com', birthday: '1990-04-02', gender: 'Female' });
  // What Profile sends: every field, an empty one meaning cleared.
  await send(me, 'PUT', '/api/auth/profile', { full_name: 'Alex Doe', nickname: '', email: '', birthday: '', gender: '', avatar_url: '' });
  assert.deepEqual(row(), { full_name: 'Alex Doe', nickname: null, email: null, birthday: null, gender: null });
});

test('accounts set up before this are repaired once at start, without touching what Profile set', async (t) => {
  if (!db) return t.skip('better-sqlite3 is not built for this Node');
  const setupOnly = user('before');
  setting(setupOnly, 'gender', 'female'); setting(setupOnly, 'dob', '1990-04-02');
  const profileSet = user('set', { birthday: '1985-06-15', gender: 'Male' });
  setting(profileSet, 'gender', 'female'); setting(profileSet, 'dob', '2001-01-01');
  const lower = user('lower', { gender: 'female' });
  const tombstoned = user('gone');
  setting(tombstoned, 'dob', '1990-04-02');
  db.prepare(`UPDATE user_settings SET deleted_at = datetime('now') WHERE user_id = ?`).run(tombstoned);
  // As a server from before the fix: not repaired yet.
  db.prepare(`DELETE FROM app_config WHERE key = 'profile_from_setup_v1'`).run();
  await import(`../server/db.js?restart=${Date.now()}`);
  assert.deepEqual(account(setupOnly), { birthday: '1990-04-02', gender: 'Female' });
  assert.deepEqual(account(profileSet), { birthday: '1985-06-15', gender: 'Male' });
  assert.deepEqual(account(lower), { birthday: null, gender: 'Female' });
  assert.deepEqual(account(tombstoned), { birthday: null, gender: null });
  assert.ok(db.prepare(`SELECT value FROM app_config WHERE key = 'profile_from_setup_v1'`).get(), 'marked done');
  // Once: a birthday cleared in Profile afterwards stays cleared at the next start.
  db.prepare('UPDATE users SET birthday = NULL WHERE id = ?').run(setupOnly);
  await import(`../server/db.js?restart=${Date.now() + 1}`);
  assert.equal(account(setupOnly).birthday, null);
});

test('Profile shows setup\'s "female" as Female, and the wizard shows it on the account at once', () => {
  const profile = readFileSync(new URL('../src/routes/Profile.svelte', import.meta.url), 'utf8');
  assert.match(profile, /gender {5}= _genderChoice\(DB\.getSetting\('gender', ''\)\);/);
  assert.match(profile, /gender {5}= _genderChoice\(u\.gender\);/);
  const wizard = readFileSync(new URL('../src/routes/Wizard.svelte', import.meta.url), 'utf8');
  assert.match(wizard, /birthday: u\.birthday \|\| dob \|\| null,/);
  assert.match(wizard, /gender: u\.gender \|\| \(gender === 'female' \? 'Female' : gender === 'male' \? 'Male' : null\),/);
  // The fallbacks the API and Trace keep for a setting with no account value.
  assert.match(readFileSync(new URL('../server/lib/mcp/tools/profile.js', import.meta.url), 'utf8'), /birthday: birthday \|\| _setting\(userId, 'dob'\)/);
});
