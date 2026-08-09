import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  captureRequestTraceBody,
  formatBytes,
  formatTraceBody,
  formatTraceRequestBody,
  parseTraceBodyLimit,
  parseTracePaths,
  recordParserBodyError,
  requestBodySizeDetails,
  requestLogging,
  requestLogPath,
} from '../server/middleware/request-logging.js';
import { isLevelEnabled, logger, validateLogLevel } from '../server/logger.js';
import { isNutriTraceApiUrl } from '../src/lib/request-id-fetch.js';

function mockRequest({
  method = 'PUT',
  path = '/api/diary/2026-08-09',
  headers = {},
  body = { notes: 'hello' },
} = {}) {
  const req = new EventEmitter();
  Object.assign(req, {
    method,
    baseUrl: '',
    path,
    body,
    get: name => headers[String(name).toLowerCase()],
  });
  return req;
}

function mockResponse(statusCode = 200) {
  const res = new EventEmitter();
  Object.assign(res, {
    statusCode,
    headersSent: false,
    writableFinished: false,
    headers: {},
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
  });
  return res;
}

test('formatBytes presents observed sizes readably', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1536), '1.5 KiB');
  assert.equal(formatBytes(5 * 1024 * 1024), '5.00 MiB');
  assert.equal(formatBytes(undefined), 'unknown');
});

test('bounded trace formatting redacts settings, credentials, URLs, and inline images', () => {
  const body = {
    username: 'alice',
    password: 'do-not-log',
    nested: { api_key: 'also-secret', callback: 'https://user:pass@example.test/hook?token=x' },
    settings: [{ key: 'appriseUrl', value: 'discord://webhook-id/webhook-secret' }],
    items: [{ imgUrl: 'data:image/jpeg;base64,abcdef' }],
  };
  const output = formatTraceBody(body);

  assert.match(output, /"username":"alice"/);
  assert.doesNotMatch(output, /do-not-log|also-secret|user:pass|token=x|webhook-secret|base64,abcdef/);
  assert.match(output, /"password":"\[REDACTED\]"/);
  assert.match(output, /"value":"\[REDACTED\]"/);
  assert.match(output, /"callback":"\[URL: https:\/\/example\.test\]"/);
  assert.match(output, /"imgUrl":"\[data URL: 29 bytes\]"/);
});

test('bounded trace formatting stops traversing large arrays', () => {
  const values = Array.from({ length: 101 }, (_, i) => ({ i }));
  Object.defineProperty(values, 100, { get() { throw new Error('traversed past item budget'); } });
  const output = formatTraceBody({ values });
  assert.match(output, /1 more items/);
});

test('formatTraceBody truncates UTF-8 output within the configured byte cap', () => {
  const output = formatTraceBody({ notes: '🥦'.repeat(100) }, 100);
  assert.ok(Buffer.byteLength(output) <= 100);
  assert.doesNotMatch(output, /�/);
  assert.match(output, /truncated/);
  assert.equal(Buffer.byteLength(formatTraceBody({ notes: 'long value' }, 5)), 5);
});

test('sync trace includes bounded row contents while retaining sensitive-field redaction', () => {
  const req = {
    path: '/api/sync/push',
    body: {
      foods: [{ name: 'private food', notes: 'private note' }],
      diary: [{ date: '2026-08-09', notes: 'private diary note' }],
      settings: [{ key: 'appriseUrl', value: 'discord://secret' }],
      wellness: [{ value: 123 }],
    },
  };
  const output = formatTraceRequestBody(req);
  assert.match(output, /private food/);
  assert.match(output, /private note/);
  assert.match(output, /private diary note/);
  assert.match(output, /"wellness":\[\{"value":123\}\]/);
  assert.match(output, /"key":"appriseUrl","value":"\[REDACTED\]"/);
  assert.doesNotMatch(output, /discord:\/\/secret/);
});

test('trace configuration has strict byte parsing and explicit path semantics', () => {
  assert.equal(parseTraceBodyLimit(undefined), 32768);
  assert.equal(parseTraceBodyLimit('4096'), 4096);
  assert.throws(() => parseTraceBodyLimit('32kb'), /positive integer/);
  assert.throws(() => parseTraceBodyLimit('0'), /positive integer/);

  assert.deepEqual(parseTracePaths(undefined), ['/api/diary', '/api/sync/push']);
  assert.deepEqual(parseTracePaths(''), []);
  assert.deepEqual(parseTracePaths('none'), []);
  assert.deepEqual(parseTracePaths('/api/diary,/api/foods'), ['/api/diary', '/api/foods']);
  assert.deepEqual(parseTracePaths('*'), ['*']);
  assert.throws(() => parseTracePaths('api/diary'), /must start/);
});

test('requestLogPath excludes sensitive query strings', () => {
  assert.equal(requestLogPath({
    baseUrl: '/nutritrace',
    path: '/api/auth/callback',
    originalUrl: '/nutritrace/api/auth/callback?code=secret',
  }), '/nutritrace/api/auth/callback');
});

test('invalid log levels fail validation instead of silently falling back', () => {
  assert.equal(validateLogLevel('TRACE'), 'trace');
  assert.equal(isLevelEnabled('trace', 'trace'), true);
  assert.equal(isLevelEnabled('trace', 'debug'), false);
  assert.throws(() => validateLogLevel('trcae'), /Invalid LOG_LEVEL/);
  assert.throws(() => isLevelEnabled('info', 'not-a-level'), /Invalid LOG_LEVEL/);
});

test('phase 1 keeps declared and observed sizes separate and reuses valid request IDs', () => {
  const req = mockRequest({ headers: { 'content-length': '999999', 'x-request-id': 'app-request-123' } });
  const res = mockResponse();
  const originalInfo = logger.info;
  const lines = [];
  logger.info = line => lines.push(line);
  try {
    requestLogging(req, res, () => {});
    req.emit('data', Buffer.from('12345'));
    res.writableFinished = true;
    res.headersSent = true;
    res.emit('finish');

    assert.equal(req.requestId, 'app-request-123');
    assert.equal(res.headers['x-request-id'], 'app-request-123');
    assert.match(lines[0], /request_id=app-request-123/);
    assert.match(lines[0], /wire_bytes_received=5/);
    assert.match(lines[0], /declared_bytes=999999/);
  } finally {
    logger.info = originalInfo;
  }
});

test('invalid Content-Length is never treated as an observed size', () => {
  const req = mockRequest({ headers: { 'content-length': '10GB' } });
  const res = mockResponse();
  const originalInfo = logger.info;
  const lines = [];
  logger.info = line => lines.push(line);
  try {
    requestLogging(req, res, () => {});
    res.writableFinished = true;
    res.emit('finish');
    assert.doesNotMatch(lines[0], /declared_bytes=/);
    assert.match(lines[0], /wire_bytes_received=0/);
  } finally {
    logger.info = originalInfo;
  }
});

test('parser byte counts and limits remain separate from declared and wire sizes', () => {
  const req = mockRequest({ headers: { 'content-length': '9000' } });
  const res = mockResponse(413);
  const originalWarn = logger.warn;
  logger.warn = () => {};
  try {
    requestLogging(req, res, () => {});
    req.emit('data', Buffer.alloc(1200));
    recordParserBodyError(req, { received: 2048, limit: 1024, length: 9000 });
    assert.deepEqual(requestBodySizeDetails(req), {
      declaredBytes: 9000,
      wireBytesReceived: 1200,
      parserBytesReceived: 2048,
      limitBytes: 1024,
    });
  } finally {
    logger.warn = originalWarn;
  }
});

test('aborted requests produce one incomplete warning and never trace a body', () => {
  const req = mockRequest();
  const res = mockResponse();
  const originalWarn = logger.warn;
  const originalTrace = logger.trace;
  const warnings = [];
  const traces = [];
  logger.warn = line => warnings.push(line);
  logger.trace = line => traces.push(line);
  try {
    requestLogging(req, res, () => {});
    req.emit('data', Buffer.from('partial'));
    req.emit('aborted');
    res.emit('close');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /→ incomplete/);
    assert.match(warnings[0], /outcome=aborted/);
    assert.match(warnings[0], /wire_bytes_received=7/);
    assert.equal(traces.length, 0);
  } finally {
    logger.warn = originalWarn;
    logger.trace = originalTrace;
  }
});

test('non-API/static requests bypass request logging', () => {
  const req = mockRequest({ path: '/uploads/photo.jpg', method: 'GET', body: undefined });
  const res = mockResponse();
  const originalInfo = logger.info;
  let logged = false;
  logger.info = () => { logged = true; };
  try {
    let nextCalled = false;
    requestLogging(req, res, () => { nextCalled = true; });
    res.emit('finish');
    assert.equal(nextCalled, true);
    assert.equal(logged, false);
    assert.equal(req.listenerCount('data'), 0);
  } finally {
    logger.info = originalInfo;
  }
});

test('phase 2 captures a body only after phase 1 and explicit trace opt-in', () => {
  const req = mockRequest();
  const res = mockResponse();
  const originalEnabled = logger.isEnabled;
  const oldBodies = process.env.TRACE_REQUEST_BODIES;
  const oldPaths = process.env.TRACE_REQUEST_PATHS;
  logger.isEnabled = () => true;
  process.env.TRACE_REQUEST_BODIES = '1';
  process.env.TRACE_REQUEST_PATHS = '/api/diary';
  try {
    requestLogging(req, res, () => {});
    captureRequestTraceBody(req, res, () => {});
    const originalTrace = logger.trace;
    const originalInfo = logger.info;
    const traces = [];
    logger.trace = line => traces.push(line);
    logger.info = () => {};
    try {
      res.writableFinished = true;
      res.emit('finish');
      assert.equal(traces.length, 1);
      assert.match(traces[0], /request_id=/);
      assert.match(traces[0], /"notes":"hello"/);
    } finally {
      logger.trace = originalTrace;
      logger.info = originalInfo;
    }
  } finally {
    logger.isEnabled = originalEnabled;
    if (oldBodies === undefined) delete process.env.TRACE_REQUEST_BODIES;
    else process.env.TRACE_REQUEST_BODIES = oldBodies;
    if (oldPaths === undefined) delete process.env.TRACE_REQUEST_PATHS;
    else process.env.TRACE_REQUEST_PATHS = oldPaths;
  }
});

test('client request-ID instrumentation targets only this NutriTrace API', () => {
  const page = 'https://app.nutritrace.local/diary';
  const server = 'https://food.example.test/nutritrace';
  assert.equal(isNutriTraceApiUrl('/api/health', page, ''), true);
  assert.equal(isNutriTraceApiUrl('https://food.example.test/nutritrace/api/sync/push', page, server), true);
  assert.equal(isNutriTraceApiUrl('https://world.openfoodfacts.org/api/v3/product/1', page, server), false);
  assert.equal(isNutriTraceApiUrl('/uploads/photo.jpg', page, server), false);
});

test('server wiring keeps phase 1 before parsers, phase 2 after auth, and returns structured 413s', () => {
  const source = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
  assert.ok(source.indexOf('router.use(requestLogging)') < source.indexOf("express.json({ limit: '25mb' })"));
  assert.ok(source.indexOf('router.use(captureRequestTraceBody)') > source.indexOf('router.use(csrfProtect)'));
  assert.match(source, /err\.type === 'entity\.too\.large'/);
  assert.match(source, /recordParserBodyError\(req, err\)/);
  assert.match(source, /status\(413\)\.json\([\s\S]*request_id:[\s\S]*declared_bytes:[\s\S]*limit_bytes:/);
  assert.match(source, /NutriTrace \$\{APP_VERSION\} running on port/);
});
