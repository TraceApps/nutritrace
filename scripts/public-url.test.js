/**
 * Emailed links go to an address an admin uses, never to whatever host a
 * request claims.
 *
 * A password reset for someone else's account, asked for with
 * X-Forwarded-Host set to your own domain, sent them a real reset email
 * whose link (token included) pointed at you; invites and "shared with you"
 * emails trusted the same header. server/lib/public-url.js now picks the
 * address. Verified against each app's server with a mail catcher: before,
 * the links pointed at the forged host; after, at the admin's address.
 */
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'public-url-')), 'test.db');
const { createPublicUrl, requestOrigin } = await import('../server/lib/public-url.js');
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

const mem = () => { const m = new Map(); return { get: (k) => m.get(k) ?? null, set: (k, v) => m.set(k, v), m }; };
const req = (host, { proto = 'http', browser = true, admin = false, xfh = true } = {}) => ({
  protocol: 'http',
  user: admin ? { role: 'admin' } : null,
  headers: { ...(xfh ? { 'x-forwarded-host': host, 'x-forwarded-proto': proto } : { host }), ...(browser ? { 'sec-fetch-site': 'same-origin' } : {}) },
});
const make = (env = {}, isAdmin = (r) => !!r?.user) => { const store = mem(); return { store, pu: createPublicUrl(store, { env, isAdmin }) }; };

test('a forged host gets the address an admin uses, not its own', () => {
  const { pu } = make();
  pu.remember(req('lift.example.com', { proto: 'https', admin: true }));
  assert.equal(pu.linkBase(req('attacker.example')), 'https://lift.example.com');
});

test('an address an admin also uses is kept for the person asking from it', () => {
  const { pu } = make();
  pu.remember(req('lift.lan:3002', { admin: true }));
  pu.remember(req('lift.example.com', { proto: 'https', admin: true }));
  assert.equal(pu.linkBase(req('lift.lan:3002')), 'http://lift.lan:3002');
  assert.equal(pu.linkBase(req('elsewhere.test')), 'https://lift.example.com', 'anything else gets the latest');
});

test('with no address known yet, only an admin request may use its own', () => {
  const { pu } = make();
  assert.equal(pu.linkBase(req('attacker.example')), '', 'no email for anyone else');
  assert.equal(pu.linkBase(req('lift.example.com', { admin: true })), 'http://lift.example.com');
  assert.equal(pu.linkBase(null), '', 'the scheduler has no request');
});

test('PUBLIC_URL wins, as given', () => {
  const { pu } = make({ PUBLIC_URL: 'https://example.com/lifttrace/' });
  pu.remember(req('lift.lan', { admin: true }));
  assert.equal(pu.linkBase(req('attacker.example')), 'https://example.com/lifttrace');
  assert.equal(pu.linkBase(null), 'https://example.com/lifttrace');
});

test('the BASE_URL subpath is part of a remembered address', () => {
  const was = process.env.BASE_URL; process.env.BASE_URL = '/lift/';
  try {
    const { pu } = make();
    pu.remember(req('lift.lan', { admin: true }));
    assert.equal(pu.linkBase(req('attacker.example')), 'http://lift.lan/lift');
  } finally { if (was === undefined) delete process.env.BASE_URL; else process.env.BASE_URL = was; }
});

test('only a browser or the app is remembered, and only a real host', () => {
  const { pu, store } = make();
  pu.remember(req('localhost:3002', { browser: false, admin: true }));
  assert.equal(store.get('known_origins'), null, 'a health check or script');
  pu.remember(req('evil"><img src=x>', { admin: true }));
  assert.equal(store.get('known_origins'), null, 'not a host');
  for (let i = 0; i < 15; i++) pu.remember(req(`h${i}.test`, { admin: true }));
  const known = JSON.parse(store.get('known_origins'));
  assert.equal(known.length, 10);
  assert.equal(known.at(-1), 'http://h14.test');
});

test('a list of forwarded hosts reads the first', () => {
  assert.equal(requestOrigin({ headers: { 'x-forwarded-host': 'a.test, b.test', 'x-forwarded-proto': 'https, http' } }), 'https://a.test');
  assert.equal(requestOrigin({ protocol: 'http', headers: { host: 'Lift.Example.COM' } }), 'http://lift.example.com');
});

test('the real store keeps what an admin used', async () => {
  const { rememberAdminOrigin, linkBase } = await import('../server/lib/public-url.js');
  // No accounts yet is single-user mode: the one operator is the admin, and
  // with no accounts there is no reset or share email to take over.
  assert.equal(linkBase(req('lift.lan')), 'http://lift.lan');
  rememberAdminOrigin(req('lift.example.com', { proto: 'https' }));
  assert.equal(linkBase(req('attacker.example')), 'https://lift.example.com');
});

test('reset, invite, test and sharing emails all take their address from it', () => {
  const auth = read('../server/routes/auth.js');
  assert.doesNotMatch(auth, /x-forwarded-host/);
  assert.equal(auth.match(/const baseUrl = linkBase\(req\);/g)?.length, 2, 'reset and invite');
  assert.match(auth, /if \(baseUrl\) await sendPasswordReset\(/, 'no reset email without a trusted address');
  assert.doesNotMatch(read('../server/routes/app-config.js'), /x-forwarded-host/);
  const index = read('../server/index.js');
  assert.match(index, /router\.use\(authenticate\);[^\n]*\n\/\/ Remember the address an admin uses[\s\S]{0,300}rememberAdminOrigin\(req\)/);
  for (const [file, guard] of APP_SHARES) {
    const src = read(`../server/routes/${file}`);
    assert.doesNotMatch(src.slice(0, src.length), /x-forwarded-host'\]\s+\|\| req\.headers\.host \|\| '';\n[^\n]*\n?[^\n]*viewUrl/, file);
    assert.match(src, guard, file);
  }
});

test('localhost is passed over for a real address when one is known', () => {
  const { pu } = make();
  pu.remember(req('lift.example.com', { proto: 'https', admin: true }));
  pu.remember(req('localhost:3002', { admin: true }));
  assert.equal(pu.linkBase(req('attacker.example')), 'https://lift.example.com');
  assert.equal(pu.linkBase(req('localhost:3002')), 'http://localhost:3002', 'still kept for whoever asks from it');
});

test('a host with an underscore, as Docker service names have, is a real host', () => {
  assert.equal(requestOrigin({ headers: { host: 'cook_app:3003' }, protocol: 'http' }), 'http://cook_app:3003');
});

test('a restore that rewrites the stored list is read straight away', () => {
  const { pu, store } = make();
  pu.remember(req('old.example', { admin: true }));
  store.set('known_origins', JSON.stringify(['https://restored.example']));
  assert.equal(pu.linkBase(req('attacker.example')), 'https://restored.example');
});

test('only a signed-in admin is remembered, never the zero-account window', () => {
  assert.match(read('../server/index.js'), /\n  if \(req\.user\?\.role === 'admin'\) rememberAdminOrigin\(req\);\n/);
});

test('an invite with no known address is refused, not sent with a broken link', () => {
  assert.match(read('../server/routes/auth.js'), /const baseUrl = linkBase\(req\);\n\s*if \(!baseUrl\) return res\.status\(500\)\.json\(\{ error: 'The app\\'s address is unknown\. Set PUBLIC_URL, then try again\.' \}\);\n\s*const inviteUrl = /);
});

const APP_SHARES = [['foods.js', /if \(!row\.email \|\| !base\) continue;/], ['meals.js', /if \(!row\.email \|\| !base\) continue;/]];
