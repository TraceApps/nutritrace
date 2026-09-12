/**
 * Unit tests for server/lib/ssrf-guard.js, the shared SSRF guard used by
 * outgoing webhooks. Pure functions plus one DNS lookup against
 * 'localhost' (resolved via the OS hosts file, no external network
 * needed), no db.js import, runs without a compiled better-sqlite3
 * native binding. Ported from LiftTrace's scripts/ssrf-guard.test.js.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { isLinkLocalOrCloudMeta, isPrivateOrLoopback, assertSafeUrl } from '../server/lib/ssrf-guard.js';

test('isLinkLocalOrCloudMeta blocks the cloud-metadata address and link-local ranges', () => {
  assert.equal(isLinkLocalOrCloudMeta('169.254.169.254'), true);
  assert.equal(isLinkLocalOrCloudMeta('169.254.0.1'), true);
  assert.equal(isLinkLocalOrCloudMeta('fe80::1'), true);
  assert.equal(isLinkLocalOrCloudMeta('::ffff:169.254.169.254'), true);
  assert.equal(isLinkLocalOrCloudMeta('8.8.8.8'), false);
});

test('isPrivateOrLoopback blocks loopback, RFC1918, and IPv6 ULA', () => {
  assert.equal(isPrivateOrLoopback('127.0.0.1'), true);
  assert.equal(isPrivateOrLoopback('10.0.0.5'), true);
  assert.equal(isPrivateOrLoopback('192.168.1.1'), true);
  assert.equal(isPrivateOrLoopback('172.16.0.1'), true);
  assert.equal(isPrivateOrLoopback('172.32.0.1'), false); // just outside the 172.16-31 range
  assert.equal(isPrivateOrLoopback('::1'), true);
  assert.equal(isPrivateOrLoopback('fc00::1'), true);
  assert.equal(isPrivateOrLoopback('8.8.8.8'), false);
});

test('assertSafeUrl rejects a non-http(s) protocol before any DNS lookup', async () => {
  await assert.rejects(() => assertSafeUrl('ftp://example.com'), /http and https/);
});

test('assertSafeUrl rejects an unparseable URL', async () => {
  await assert.rejects(() => assertSafeUrl('not a url'), /Invalid URL/);
});

test('assertSafeUrl blocks localhost by default, allows it with allowPrivate: true', async () => {
  await assert.rejects(() => assertSafeUrl('http://localhost:8080/'), /Private|loopback/);
  const parsed = await assertSafeUrl('http://localhost:8080/', { allowPrivate: true });
  assert.equal(parsed.hostname, 'localhost');
});

test('assertSafeUrl error message includes the caller-supplied env var hint', async () => {
  await assert.rejects(
    () => assertSafeUrl('http://localhost/', { allowPrivateEnvHint: 'ALLOW_PRIVATE_WEBHOOK_URLS' }),
    /ALLOW_PRIVATE_WEBHOOK_URLS/
  );
});
