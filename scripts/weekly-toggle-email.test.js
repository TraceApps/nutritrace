/**
 * The Weekly Summary toggle shows for someone who can get it by email.
 *
 * Settings > Notifications showed Weekly Summary only with on-device
 * notifications or a push service on, so someone with neither could not
 * turn it on, though the server now emails it to them. The server tells a
 * signed-in person whether it sends email (/api/auth/me features.email; never
 * anyone signed out), and the toggle shows when a push service is chosen or
 * email can reach them, with a hint naming the channel(s).
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as netServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const serverRequire = createRequire(new URL('../server/package.json', import.meta.url));
let ready = false;
try { serverRequire('better-sqlite3'); ready = true; } catch { /* server packages missing: skip */ }
const freePort = () => new Promise((res) => { const s = netServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanEnv = () => {
  const keep = ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'SystemRoot', 'NODE_OPTIONS'];
  return Object.fromEntries(keep.filter((k) => process.env[k] != null).map((k) => [k, process.env[k]]));
};
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

async function meWith(smtp) {
  const dir = mkdtempSync(join(tmpdir(), 'nt-weekly-toggle-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const proc = spawn(process.execPath, ['index.js'], {
    cwd: fileURLToPath(new URL('../server/', import.meta.url)),
    env: { ...cleanEnv(), PORT: String(port), DB_PATH: join(dir, 'nt.db'), UPLOADS_PATH: join(dir, 'uploads'), BACKUPS_PATH: join(dir, 'backups'), JWT_SECRET: 'weekly-toggle-test-0123456789abcdef0123', INSECURE_COOKIES: '1', NODE_ENV: 'test', LOG_LEVEL: 'error', UPDATE_CHECK: 'off', ...(smtp ? { SMTP_HOST: '127.0.0.1', SMTP_PORT: '2525', SMTP_FROM: 'nt@example.com' } : {}) },
    stdio: 'ignore',
  });
  try {
    for (let i = 0; i < 300; i++) {
      try { if ((await fetch(base + '/api/auth/status')).ok) break; } catch { /* not up yet */ }
      await sleep(100);
    }
    const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const signedOut = await (await fetch(base + '/api/auth/me')).json();
    await post('/api/auth/register', { username: 'pat', password: 'Str0ng-Pass-77!x', email: 'pat@example.com' });
    const { token } = await (await post('/api/auth/login', { username: 'pat', password: 'Str0ng-Pass-77!x' })).json();
    const signedIn = await (await fetch(base + '/api/auth/me', { headers: { Authorization: 'Bearer ' + token } })).json();
    return { signedOut, signedIn };
  } finally { proc.kill(); rmSync(dir, { recursive: true, force: true }); }
}

test('a signed-in person learns whether the server sends email; nobody signed out does', { skip: !ready && 'server packages missing' }, async () => {
  const on = await meWith(true);
  assert.equal(on.signedIn.features.email, true);
  assert.equal(on.signedIn.user.email, 'pat@example.com');
  assert.equal('email' in (on.signedOut.features || {}), false, 'never told to anyone signed out');
  const off = await meWith(false);
  assert.equal(off.signedIn.features.email, false);
});

test('the toggle shows for a push service or email, with a hint naming the channel', () => {
  const s = read('../src/components/settings/SettingsNotifications.svelte');
  assert.match(s, /\$: _weeklyByEmail = !!\$serverFeatures\?\.email && !!\$currentUser\?\.email;/);
  assert.match(s, /\{#if _anyNotifEnabled \|\| _weeklyByEmail\}\s*<p class="settings-group-heading">\{\$_\('settings_notifications\.sections\.alerts_summaries'\)\}/);
  // The weekly row sits outside the push-only rows of that card.
  const card = s.slice(s.indexOf("{#if _anyNotifEnabled || _weeklyByEmail}"));
  const weekly = card.indexOf("settings_notifications.alerts.weekly')");
  const lastPushOnly = card.lastIndexOf('{/if}', weekly);
  assert.ok(card.lastIndexOf('{#if _anyNotifEnabled}', weekly) < lastPushOnly, 'the rows before Weekly Summary close their push-only block first');
  const en = JSON.parse(read('../src/i18n/en.json')).settings_notifications.alerts;
  assert.match(en.weekly_desc, /push notification and email$/);
  assert.match(en.weekly_desc_push, /by push notification$/);
  assert.match(en.weekly_desc_email, /by email$/);
  assert.match(en.weekly_desc_none, /Push Service/);
  const auth = read('../src/stores/auth.js');
  assert.match(auth, /localStorage\.setItem\('nt:serverFeatures'/, 'kept for use with no connection');
});
