import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { formatBytes, formatTraceBody, requestLogging, requestLogPath } from '../server/middleware/request-logging.js';
import { isLevelEnabled, logger } from '../server/logger.js';

test('formatBytes presents request and limit sizes readably', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1536), '1.5 KiB');
  assert.equal(formatBytes(5 * 1024 * 1024), '5.00 MiB');
  assert.equal(formatBytes(undefined), 'unknown');
});

test('formatTraceBody recursively redacts credentials and summarizes inline images', () => {
  const body = {
    username: 'alice',
    password: 'do-not-log',
    nested: { api_key: 'also-secret', csrfToken: 'csrf-secret' },
    items: [{ imgUrl: 'data:image/jpeg;base64,abcdef' }],
  };
  const output = formatTraceBody(body);

  assert.match(output, /"username":"alice"/);
  assert.doesNotMatch(output, /do-not-log|also-secret|csrf-secret|base64,abcdef/);
  assert.match(output, /"password":"\[REDACTED\]"/);
  assert.match(output, /"imgUrl":"\[data URL: 29 bytes\]"/);
});

test('formatTraceBody redacts secret values in key/value setting payloads', () => {
  const output = formatTraceBody({ key: 'aiApiKey', value: 'do-not-log' });
  assert.doesNotMatch(output, /do-not-log/);
  assert.match(output, /"value":"\[REDACTED\]"/);
});

test('formatTraceBody truncates large UTF-8 bodies within the configured byte cap', () => {
  const output = formatTraceBody({ notes: '🥦'.repeat(100) }, 100);
  assert.ok(Buffer.byteLength(output) <= 100);
  assert.doesNotMatch(output, /�/);
  assert.match(output, /truncated; serialized body/);
  assert.equal(Buffer.byteLength(formatTraceBody({ notes: 'long value' }, 5)), 5);
});

test('requestLogPath excludes sensitive query strings', () => {
  assert.equal(requestLogPath({
    baseUrl: '/nutritrace',
    path: '/api/auth/callback',
    originalUrl: '/nutritrace/api/auth/callback?code=secret',
  }), '/nutritrace/api/auth/callback');
});

test('trace is enabled only at trace level and invalid levels fall back to info', () => {
  assert.equal(isLevelEnabled('trace', 'trace'), true);
  assert.equal(isLevelEnabled('trace', 'debug'), false);
  assert.equal(isLevelEnabled('debug', 'TRACE'), true);
  assert.equal(isLevelEnabled('info', 'not-a-level'), true);
  assert.equal(isLevelEnabled('debug', 'not-a-level'), false);
});

test('requestLogging reports observed body bytes without retaining raw chunks', () => {
  const req = new EventEmitter();
  Object.assign(req, {
    method: 'PUT',
    baseUrl: '',
    path: '/api/diary/2026-08-09',
    body: { notes: 'hello' },
    get: () => undefined,
  });
  const res = new EventEmitter();
  res.statusCode = 200;

  const originalInfo = logger.info;
  const lines = [];
  logger.info = line => lines.push(line);
  try {
    let nextCalled = false;
    requestLogging(req, res, () => { nextCalled = true; });
    req.emit('data', Buffer.from('12345'));
    res.emit('finish');
    assert.equal(nextCalled, true);
    assert.match(lines[0], /^PUT \/api\/diary\/2026-08-09 → 200 \(\d+ms, body 5 B\)$/);
  } finally {
    logger.info = originalInfo;
  }
});

test('server registers request logging before parsers and handles oversized bodies as structured 413s', () => {
  const source = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
  assert.ok(source.indexOf('router.use(requestLogging)') < source.indexOf("express.json({ limit: '25mb' })"));
  assert.match(source, /err\.type === 'entity\.too\.large'/);
  assert.match(source, /status\(413\)\.json\([\s\S]*size_bytes:[\s\S]*limit_bytes:/);
});
