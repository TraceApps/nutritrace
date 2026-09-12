/**
 * server/lib/webhook-delivery.js
 *
 * Pure delivery mechanics for outgoing webhooks: building the signed
 * envelope and sending it. Deliberately has NO db.js import
 * (server/lib/webhooks.js owns the DB-backed subscription management
 * and delivery-status bookkeeping, and imports these two functions from
 * here), so this file, and only this file, can be unit-tested directly
 * without a compiled better-sqlite3 native binding, which the rest of
 * the webhooks feature needs. Ported from LiftTrace's
 * server/lib/webhook-delivery.js.
 */
import { createHmac } from 'crypto';

const FETCH_TIMEOUT_MS = 10000;

/**
 * Build the signed envelope for one delivery. Pure (no DB, no network).
 */
export function signEnvelope(secret, event, data) {
  const envelope = JSON.stringify({ event, timestamp: new Date().toISOString(), data });
  const signature = createHmac('sha256', secret).update(envelope).digest('hex');
  return { envelope, signature };
}

/**
 * POST one already-signed envelope to `url`. Throws on a non-2xx
 * response, a network error, or the fetch timing out, callers decide
 * whether/how to retry.
 */
export async function sendWebhookRequest(url, envelope, signature, deliveryId, event) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      // Do not follow a redirect: a compromised or malicious endpoint
      // could 3xx this request to an internal address (169.254.169.254,
      // localhost) after assertSafeUrl already validated the original
      // host, bypassing the SSRF guard entirely. With redirect:'manual',
      // Node's fetch returns the real 3xx status and res.ok is false, so
      // the check below already treats it as a failure without a
      // separate status-range check.
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'X-NutriTrace-Signature': `sha256=${signature}`,
        'X-NutriTrace-Event': event,
        'X-NutriTrace-Delivery': deliveryId,
      },
      body: envelope,
    });
    if (!res.ok) throw new Error(`Upstream responded ${res.status}`);
  } finally {
    clearTimeout(timer);
  }
}
