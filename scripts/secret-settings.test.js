/**
 * TraceApps/cooktrace#92: the secrets people keep in their settings, on a
 * real server. Every one is stored encrypted; the ones only the server uses
 * (the ntfy and Gotify tokens) are never sent back, only said to be set, and
 * saving that placeholder (from the page, the bulk save or a phone's sync)
 * leaves the secret as it is. The server still sends with the real token, and
 * a secret saved in the clear before is encrypted when the server starts.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { createServer as httpServer } from 'node:http';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import test from 'node:test';

const root = new URL('../', import.meta.url);
let Database = null;
try {
  Database = createRequire(new URL('../server/package.json', import.meta.url))('better-sqlite3');
  new Database(':memory:').close();
} catch { Database = null; }
const skip = Database ? false : 'needs the server dependencies, built for this Node';

const SET = '••••••••';
const PW = 'Str0ng-Pass-88!y';

const freePort = () => new Promise((res, rej) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
  s.on('error', rej);
});

async function boot(dir, port) {
  const proc = spawn(process.execPath, ['index.js'], {
    cwd: new URL('server/', root),
    env: { ...process.env, PORT: String(port), DB_PATH: join(dir, 'app.db'), UPLOADS_PATH: join(dir, 'uploads'),
      JWT_SECRET: 'nt-secret-settings-test-0123456789abcdef0123', INSECURE_COOKIES: '1', NODE_ENV: 'test' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let errors = '';
  proc.stderr.on('data', d => { errors += d; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    try { await fetch(base + '/api/auth/me'); break; } catch { await new Promise(r => setTimeout(r, 100)); }
    if (i > 150) { proc.kill('SIGKILL'); throw new Error('server did not start: ' + errors.slice(-500)); }
  }
  const stop = () => new Promise(r => {
    if (proc.exitCode != null || proc.signalCode != null) return r();
    proc.once('exit', r); proc.kill('SIGKILL');
  });
  return { base, stop };
}

// A NutriTrace and an ntfy that say which token they were sent.
function services() {
  const seen = [];
  return new Promise(res => {
    const s = httpServer((req, r) => {
      seen.push({ url: req.url, auth: req.headers.authorization || null });
      if (req.url === '/api/auth/me') {
        const ok = req.headers.authorization === 'Bearer nt-token-123';
        r.writeHead(ok ? 200 : 401, { 'Content-Type': 'application/json' });
        r.end(JSON.stringify(ok ? { user: { username: 'pat' } } : { error: 'no' }));
        return;
      }
      r.writeHead(200, { 'Content-Type': 'application/json' }); r.end('{}');
    });
    s.listen(0, '127.0.0.1', () => res({ base: `http://127.0.0.1:${s.address().port}`, seen, close: () => s.close() }));
  });
}

test('secrets in settings: encrypted, server-only ones never sent back, placeholder keeps them', { skip, timeout: 120000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nt-secrets-'));
  const port = await freePort();
  const svc = await services();
  let srv = await boot(dir, port);
  try {
    const call = async (method, path, body, tok) => {
      const r = await fetch(srv.base + path, { method, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
      const t = await r.text();
      if (r.status >= 400) throw new Error(`${method} ${path} ${r.status} ${t.slice(0, 200)}`);
      return t ? JSON.parse(t) : null;
    };
    await call('POST', '/api/auth/register', { username: 'cook', password: PW });
    const tok = (await call('POST', '/api/auth/login', { username: 'cook', password: PW })).token;
    const as = (method, path, body) => call(method, path, body, tok);
    const stored = key => {
      const db = new Database(join(dir, 'app.db'), { readonly: true });
      try { return db.prepare('SELECT value FROM user_settings WHERE key = ?').get(key)?.value ?? null; } finally { db.close(); }
    };

    // Saved: the server-only token is said to be set; the AI key, which the
    // browser calls the provider with, comes back. Both stored encrypted.
    await as('PUT', '/api/settings', { key: 'ntfyUrl', value: svc.base });
    await as('PUT', '/api/settings', { key: 'ntfyTopic', value: 'kitchen' });
    await as('PUT', '/api/settings', { key: 'ntfyToken', value: 'tk_ntfy' });
    await as('PUT', '/api/settings', { key: 'aiApiKey', value: 'sk-test-456' });
    await as('PUT', '/api/settings', { key: 'cooktraceApiToken', value: 'ct-pat-1' });
    await as('PUT', '/api/settings', { key: 'aiModel', value: 'some-model' });
    let got = await as('GET', '/api/settings');
    assert.equal(got.ntfyToken, SET, 'never sent back');
    assert.equal(got.aiApiKey, 'sk-test-456', 'the app still has the key it uses itself');
    assert.equal(got.cooktraceApiToken, 'ct-pat-1');
    assert.equal(got.aiModel, 'some-model', 'other settings as they were');
    for (const [key, plain] of [['ntfyToken', 'tk_ntfy'], ['aiApiKey', 'sk-test-456'], ['cooktraceApiToken', 'ct-pat-1']]) {
      const v = stored(key);
      assert.match(JSON.parse(v), /^enc:v1:/, `${key} stored encrypted`);
      assert.ok(!v.includes(plain), `${key} not in the clear`);
    }
    assert.equal(stored('aiModel'), '"some-model"', 'not a secret: stored as before');

    // The placeholder sent back changes nothing; the same key again is no change.
    const before = stored('ntfyToken');
    await as('PUT', '/api/settings', { key: 'ntfyToken', value: SET });
    assert.equal(stored('ntfyToken'), before);
    const aiBefore = stored('aiApiKey');
    await as('PUT', '/api/settings', { key: 'aiApiKey', value: 'sk-test-456' });
    assert.equal(stored('aiApiKey'), aiBefore, 'same key, same stored value');
    // Something already encrypted is never taken from an app: else anyone
    // with an account could have the server read out a leaked backup.
    const sealedOther = JSON.parse(stored('ntfyToken'));
    await as('PUT', '/api/settings', { key: 'aiApiKey', value: sealedOther });
    assert.equal(stored('aiApiKey'), aiBefore, 'a sealed value sent in is refused');
    assert.equal((await as('GET', '/api/settings')).aiApiKey, 'sk-test-456');

    // The server sends with the real token.
    await as('POST', '/api/settings/push-test', { service: 'ntfy' });
    assert.deepEqual(svc.seen.at(-1), { url: '/kitchen', auth: 'Bearer tk_ntfy' });

    // The bulk save: a placeholder for one never saved stores nothing secret.
    await as('PUT', '/api/settings/bulk', { settings: { gotifyToken: SET } });
    got = await as('GET', '/api/settings');
    assert.ok(got.gotifyToken === undefined || got.gotifyToken === '', 'nothing saved for Gotify');

    // A phone's sync: pulled, the server-only token is the placeholder and
    // the AI key is the key; pushed back unchanged, nothing changes; a new
    // token pushed is stored encrypted.
    const pull = await as('GET', '/api/sync/pull?since=1970-01-01T00:00:00Z');
    const pulled = Object.fromEntries(pull.settings.map(s => [s.key, JSON.parse(s.value)]));
    assert.equal(pulled.ntfyToken, SET);
    assert.equal(pulled.aiApiKey, 'sk-test-456');
    const now = new Date().toISOString();
    await as('POST', '/api/sync/push', { client_now: now, settings: [
      { key: 'ntfyToken', value: SET, updated_at: now },
      { key: 'gotifyToken', value: 'gt-789', updated_at: now },
    ] });
    assert.equal(stored('ntfyToken'), before, 'the placeholder pushed back leaves the token');
    assert.match(JSON.parse(stored('gotifyToken')), /^enc:v1:/);
    assert.equal((await as('GET', '/api/settings')).gotifyToken, SET);

    // Cleared: an empty token is no token.
    await as('PUT', '/api/settings', { key: 'ntfyToken', value: '' });
    assert.equal(stored('ntfyToken'), '""');
    assert.equal((await as('GET', '/api/settings')).ntfyToken, '');

    // Saved in the clear before this: encrypted when the server starts, and
    // still the same key to the app and the server.
    await srv.stop();
    const db = new Database(join(dir, 'app.db'));
    db.prepare(`UPDATE user_settings SET value = ? WHERE key = 'gotifyToken'`).run(JSON.stringify('gt-plain'));
    db.prepare(`UPDATE user_settings SET value = ? WHERE key = 'aiApiKey'`).run(JSON.stringify('sk-old-plain'));
    db.close();
    srv = await boot(dir, port);
    for (let i = 0; i < 50 && !String(stored('aiApiKey')).includes('enc:v1:'); i++) await new Promise(r => setTimeout(r, 100));
    assert.match(JSON.parse(stored('gotifyToken')), /^enc:v1:/, 'sealed at start');
    assert.match(JSON.parse(stored('aiApiKey')), /^enc:v1:/, 'sealed at start');
    assert.equal((await as('GET', '/api/settings')).aiApiKey, 'sk-old-plain');
  } finally {
    svc.close();
    await srv.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a backup restore, the server readers and the phone sync all go through the secret rules', () => {
  const read = p => readFileSync(new URL(`../server/${p}`, import.meta.url), 'utf8');
  assert.match(read('routes/full-backup.js'), /sealStoredSecrets\(db\)/, 'a restored backup is sealed');
  assert.match(read('index.js'), /sealStoredSecrets\(db\)/, 'sealed at start');
  for (const f of ['lib/push-notify.js', 'lib/scheduler.js', 'lib/external-foods.js', 'routes/settings.js']) {
    const src = read(f);
    assert.match(src, /readSettingRaw\(key, /, `${f} reads secrets in the clear through readSettingRaw`);
    assert.doesNotMatch(src, /JSON\.parse\((row|r)\.value\)/, `${f} has no reader that skips it`);
  }
  const sync = read('routes/sync.js');
  assert.match(sync, /clientSettingRaw\(s\.key, s\.value\)/, 'the pull');
  assert.match(sync, /settingToStore\(s\.key, s\.value/, 'the push');
});

// The same file in every Trace app (CookTrace, NutriTrace, LiftTrace,
// NoteTrace); each app's keys are its own (secret-setting-keys.js).
test('secret-settings.js matches the hash every Trace app pins', () => {
  const src = readFileSync(new URL('../server/lib/secret-settings.js', import.meta.url));
  assert.equal(createHash('sha256').update(src).digest('hex'), 'b9186d99e01bcef9c7fc18e396db77756c6b36f0bec28d8ac00b8122728cb5b8');
});
