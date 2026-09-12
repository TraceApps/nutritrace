/**
 * Behavioral tests for the outgoing webhook delivery mechanics: signing
 * and the actual HTTP send. server/lib/webhook-delivery.js deliberately
 * has no db.js import (server/lib/webhooks.js owns the DB-backed
 * subscription management and imports these two functions from it), so
 * this runs without a compiled better-sqlite3 native binding, unlike the
 * rest of the webhooks feature (dispatchWebhookEvent, the CRUD helpers),
 * which read/write the webhooks table and can only be verified against a
 * running dev server or in CI with the real binding. Ported from
 * LiftTrace's scripts/webhook-delivery.test.js.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHmac } from 'node:crypto';
import http from 'node:http';
import { signEnvelope, sendWebhookRequest } from '../server/lib/webhook-delivery.js';

function withServer(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}/`, close: () => new Promise(r => server.close(r)) });
    });
    server.on('error', reject);
  });
}

test('signEnvelope produces a JSON envelope with event/timestamp/data and a matching HMAC-SHA256 signature', () => {
  const { envelope, signature } = signEnvelope('my-secret', 'meal.logged', { date: '2026-09-12' });
  const parsed = JSON.parse(envelope);
  assert.equal(parsed.event, 'meal.logged');
  assert.deepEqual(parsed.data, { date: '2026-09-12' });
  assert.match(parsed.timestamp, /^\d{4}-\d{2}-\d{2}T/);

  const expected = createHmac('sha256', 'my-secret').update(envelope).digest('hex');
  assert.equal(signature, expected);
});

test('signEnvelope is deterministic for the same input at the same instant but signature changes with the secret', () => {
  const a = signEnvelope('secret-a', 'goal.achieved', { metric: 'calories' });
  const b = signEnvelope('secret-b', 'goal.achieved', { metric: 'calories' });
  // Envelopes may differ only in timestamp (millisecond-level), but the
  // signatures must differ given different secrets even if envelopes
  // happened to be byte-identical.
  assert.notEqual(a.signature, b.signature);
});

test('sendWebhookRequest POSTs the exact envelope with the signature and event/delivery headers', async () => {
  let received = null;
  const { url, close } = await withServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      received = {
        method: req.method,
        headers: {
          signature: req.headers['x-nutritrace-signature'],
          event: req.headers['x-nutritrace-event'],
          delivery: req.headers['x-nutritrace-delivery'],
          contentType: req.headers['content-type'],
        },
        body,
      };
      res.writeHead(200);
      res.end('ok');
    });
  });
  try {
    const { envelope, signature } = signEnvelope('shh', 'body_stat.logged', { date: '2026-09-12' });
    await sendWebhookRequest(url, envelope, signature, 'delivery-123', 'body_stat.logged');
    assert.equal(received.method, 'POST');
    assert.equal(received.headers.signature, `sha256=${signature}`);
    assert.equal(received.headers.event, 'body_stat.logged');
    assert.equal(received.headers.delivery, 'delivery-123');
    assert.equal(received.headers.contentType, 'application/json');
    assert.equal(received.body, envelope);
  } finally {
    await close();
  }
});

test('sendWebhookRequest throws on a non-2xx response, so the retry loop in _deliverWithRetry actually retries', async () => {
  const { url, close } = await withServer((req, res) => {
    res.writeHead(500);
    res.end('nope');
  });
  try {
    const { envelope, signature } = signEnvelope('shh', 'meal.logged', {});
    await assert.rejects(() => sendWebhookRequest(url, envelope, signature, 'd-1', 'meal.logged'), /500/);
  } finally {
    await close();
  }
});

test('sendWebhookRequest rejects when the receiver is unreachable (connection refused)', async () => {
  // Port 0 bound-and-closed pattern: get an ephemeral free port, then
  // never listen on it, guaranteeing ECONNREFUSED without relying on a
  // specific port being free ahead of time.
  const { url, close } = await withServer((req, res) => res.end());
  await close();
  const { envelope, signature } = signEnvelope('shh', 'water.logged', {});
  await assert.rejects(() => sendWebhookRequest(url, envelope, signature, 'd-2', 'water.logged'));
});

test('sendWebhookRequest does NOT follow a redirect (SSRF guard bypass regression check)', async () => {
  // A compromised or malicious endpoint could otherwise 3xx this
  // request to an internal address (169.254.169.254, localhost) after
  // assertSafeUrl already validated the original host. Node's fetch
  // with redirect:'manual' returns the real 3xx status with ok:false,
  // so this must reject rather than transparently following the hop.
  let redirectTargetHit = false;
  const { url: targetUrl, close: closeTarget } = await withServer((req, res) => {
    redirectTargetHit = true;
    res.writeHead(200);
    res.end('should never be reached');
  });
  const { url, close } = await withServer((req, res) => {
    res.writeHead(302, { Location: targetUrl });
    res.end();
  });
  try {
    const { envelope, signature } = signEnvelope('shh', 'meal.logged', {});
    await assert.rejects(() => sendWebhookRequest(url, envelope, signature, 'd-3', 'meal.logged'), /302/);
    assert.equal(redirectTargetHit, false, 'the redirect target should never have been fetched');
  } finally {
    await close();
    await closeTarget();
  }
});
