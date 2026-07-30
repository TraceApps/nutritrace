import assert from 'node:assert/strict';
import test from 'node:test';

import { formatBytes, formatTraceBody, requestLogPath } from '../server/middleware/request-logging.js';

test('formatBytes presents request and limit sizes readably', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1536), '1.5 KiB');
  assert.equal(formatBytes(5 * 1024 * 1024), '5.00 MiB');
  assert.equal(formatBytes(undefined), 'unknown');
});

test('formatTraceBody redacts credentials and summarizes inline images', () => {
  const body = {
    username: 'alice',
    password: 'do-not-log',
    nested: { api_key: 'also-secret' },
    items: [{ imgUrl: 'data:image/jpeg;base64,abcdef' }],
  };
  const output = formatTraceBody(body);

  assert.match(output, /"username":"alice"/);
  assert.doesNotMatch(output, /do-not-log|also-secret|base64,abcdef/);
  assert.match(output, /"password":"\[REDACTED\]"/);
  assert.match(output, /"imgUrl":"\[data URL: 29 bytes\]"/);
});

test('formatTraceBody redacts secret values in key/value setting payloads', () => {
  const output = formatTraceBody({ key: 'aiApiKey', value: 'do-not-log' });
  assert.doesNotMatch(output, /do-not-log/);
  assert.match(output, /"value":"\[REDACTED\]"/);
});

test('formatTraceBody truncates large serialized bodies', () => {
  const output = formatTraceBody({ notes: 'x'.repeat(200) }, 100);
  assert.ok(Buffer.byteLength(output) <= 100);
  assert.match(output, /truncated; serialized body 212 B/);
});

test('requestLogPath excludes sensitive query strings', () => {
  assert.equal(requestLogPath({
    baseUrl: '/nutritrace',
    path: '/api/auth/callback',
    originalUrl: '/nutritrace/api/auth/callback?code=secret',
  }), '/nutritrace/api/auth/callback');
});
