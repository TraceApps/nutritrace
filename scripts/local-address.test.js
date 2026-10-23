/**
 * #194: plain http:// from the Android app only to a server on the person's
 * own network. The rule lives in src/lib/local-address.js, and a Kotlin copy
 * (LocalAddress.kt) guards the background Health Connect worker.
 *
 * Node cannot run the Kotlin, so the two copies are held to one table,
 * scripts/fixtures/local-address-cases.json, in two halves: the JS runs it
 * here, the Kotlin runs it in a JUnit test generated from it
 * (`./gradlew :app:testDebugUnitTest`), and this file checks that the
 * generated test hasn't drifted from the table.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classifyServerAddress, addressOrigin, isLocalHostname } from '../src/lib/local-address.js';
import { render, OUT, kstr } from './gen-local-address-kotlin-test.mjs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const { cases } = JSON.parse(read('./fixtures/local-address-cases.json'));

test('every case in the table gets its expected answer from the JS rule', () => {
  const wrong = cases
    .map(c => ({ ...c, got: classifyServerAddress(c.url) }))
    .filter(c => c.got !== c.expect)
    .map(c => `${JSON.stringify(c.url)} (${c.note}): expected ${c.expect}, got ${c.got}`);
  assert.deepEqual(wrong, []);
});

test('the table covers every address class, allowed and refused', () => {
  const notes = new Set(cases.map(c => c.note));
  for (const n of [
    'private IPv4 10/8', 'private IPv4 172.16/12', 'private IPv4 192.168/16',
    'Tailscale/CGNAT 100.64/10', 'loopback 127/8', 'link-local 169.254/16',
    'IPv6 loopback, unique local, link-local', 'bare one-word name', 'local suffixes',
    'look-alikes: a private address or local suffix inside a public name',
    'IPv4-mapped and IPv4-compatible IPv6 are refused',
    'decimal, hex and octal IPv4 the URL parser normalizes', 'numeric forms of public IPv4',
    'userinfo tricks: the host is after the @', 'trailing dots on addresses', 'ports',
  ]) assert.ok(notes.has(n), `missing: ${n}`);
  for (const kind of ['https', 'local', 'public', 'invalid']) {
    assert.ok(cases.some(c => c.expect === kind), `no ${kind} case`);
  }
  // The look-alikes the issue's design names, by name.
  const expectOf = url => cases.find(c => c.url === url)?.expect;
  assert.equal(expectOf('http://192.168.1.1.example.com'), 'public');
  assert.equal(expectOf('http://10.0.0.1.nip.io'), 'public');
  assert.equal(expectOf('http://192.168.1.5@evil.com'), 'public');
  assert.equal(expectOf('http://[::ffff:192.168.1.5]'), 'public');
  assert.equal(expectOf('http://3232235777'), 'local');
  assert.equal(expectOf('http://0xC0A80101'), 'local');
  assert.equal(expectOf('http://0300.0250.1.1'), 'local');
  assert.equal(expectOf('http://010.0.0.1'), 'public', '010 is octal 8, so this is 8.0.0.1');
  assert.equal(expectOf('http://nas.local.'), 'local');
  assert.equal(expectOf('http://NAS.LOCAL'), 'local');
  assert.equal(expectOf('http://192.168.1.5:3001@evil.com'), 'public');
});

test('every case reads the host the table expects; Kotlin refuses only non-ASCII hosts', () => {
  for (const c of cases) {
    let host = null;
    try { const u = new URL(c.url); if (u.protocol === 'http:' || u.protocol === 'https:') host = u.hostname; } catch {}
    assert.equal(host, c.host, c.url);
    if (c.kotlin) {
      assert.equal(c.kotlin, 'invalid', c.url);
      assert.match(decodeURIComponent(c.url), /[^\x00-\x7f]/, `${c.url}: only a non-ASCII host gets a Kotlin override`);
    }
  }
  assert.ok(cases.filter(c => c.kotlin).length >= 5);
});

test('https:// is never touched, whatever the host', () => {
  for (const u of ['https://example.com', 'https://203.0.113.10', 'https://192.168.1.5@evil.com']) {
    assert.equal(classifyServerAddress(u), 'https');
  }
});

test('the origin is the one the URL parser connects to', () => {
  assert.equal(addressOrigin('http://192.168.1.5:3001/nutritrace'), 'http://192.168.1.5:3001');
  assert.equal(addressOrigin('HTTP://NAS.Local:80/'), 'http://nas.local');
  assert.equal(addressOrigin('http://3232235777'), 'http://192.168.1.1');
  assert.equal(addressOrigin('http://192.168.1.5@evil.com'), 'http://evil.com');
  assert.equal(addressOrigin('ftp://192.168.1.5'), null);
  assert.equal(addressOrigin('not a url'), null);
});

test('isLocalHostname takes hosts as the URL parser leaves them', () => {
  assert.equal(isLocalHostname('192.168.1.5'), true);
  assert.equal(isLocalHostname('[fd00::1]'), true);
  assert.equal(isLocalHostname('[::ffff:c0a8:105]'), false);
  assert.equal(isLocalHostname(''), false);
  assert.equal(isLocalHostname('nutritrace'), true);
  assert.equal(isLocalHostname('nutritrace.'), false);
});

test('the rule file stands alone, so other apps can take it as is', () => {
  const src = read('../src/lib/local-address.js');
  assert.doesNotMatch(src, /^\s*import\s/m, 'no imports');
  assert.doesNotMatch(src, /NutriTrace|nt:/, 'nothing app-specific');
});

test('the Kotlin fixture test is generated from the current table', () => {
  assert.equal(readFileSync(OUT, 'utf8'), render(),
    'fixtures changed: run `node scripts/gen-local-address-kotlin-test.mjs` and commit the result');
});

test('every case reaches the Kotlin test, with the same expected answer', () => {
  const kt = readFileSync(OUT, 'utf8');
  for (const c of cases) {
    const host = c.kotlin || c.host === null ? 'null' : kstr(c.host);
    assert.ok(kt.includes(`Triple(${kstr(c.url)}, ${kstr(c.kotlin || c.expect)}, ${host}),`), c.url);
  }
});

test('the Kotlin copy keeps the same ranges and suffixes', () => {
  const kt = read('../android/app/src/main/java/com/nutritrace/app/LocalAddress.kt');
  assert.match(kt, /listOf\("\.local", "\.home\.arpa", "\.internal", "\.lan"\)/);
  for (const r of [/x == 10/, /x == 172 && y in 16\.\.31/, /x == 192 && y == 168/, /x == 100 && y in 64\.\.127/, /x == 127/, /x == 169 && y == 254/,
    /\(p\[0\] and 0xfe00\) == 0xfc00/, /\(p\[0\] and 0xffc0\) == 0xfe80/]) assert.match(kt, r);
  const js = read('../src/lib/local-address.js');
  assert.match(js, /const LOCAL_SUFFIXES = \['\.local', '\.home\.arpa', '\.internal', '\.lan'\];/);
});
