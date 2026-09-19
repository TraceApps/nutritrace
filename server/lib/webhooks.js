/**
 * server/lib/webhooks.js
 *
 * Outgoing webhooks. When a subscribed event happens (a meal logged, a
 * body stat logged, water logged, a nutrition goal hit), fire a signed
 * HTTP POST to each of the user's enabled webhooks subscribed to that
 * event. Off by default (WEBHOOKS_ENABLED=1 to turn on). Ported from
 * LiftTrace's server/lib/webhooks.js.
 *
 * The shared secret is encrypted at rest via token-crypto.js's
 * AES-256-GCM, not hashed like api_tokens: unlike a bearer token the
 * server needs the plaintext back later to compute each delivery's HMAC.
 *
 * Delivery: 3 attempts total (t=0, +500ms, +2s), 10s fetch timeout per
 * attempt. No persistent delivery queue, a receiver down for longer
 * than about 2.5s misses that event permanently. Reasonable at the
 * self-hosted solo/small-family scale this app targets; revisit if it
 * becomes a real complaint. Every dispatch is fire-and-forget from the
 * caller's perspective (never awaited, always wrapped in a catch by the
 * caller) so a webhook failure can never delay or fail the user's
 * actual save.
 */
import { randomBytes, randomUUID } from 'crypto';
import db from '../db.js';
import { encrypt, decrypt } from './token-crypto.js';
import { assertSafeUrl } from './ssrf-guard.js';
import { signEnvelope, sendWebhookRequest } from './webhook-delivery.js';
import { logger } from '../logger.js';

const SECRET_BYTES = 32;
const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [500, 2000]; // between attempt 1-to-2 and 2-to-3

function _envFlag(v) {
  if (v === undefined || v === null) return false;
  const s = String(v).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

export const WEBHOOKS_ENABLED = _envFlag(process.env.WEBHOOKS_ENABLED);
const ALLOW_PRIVATE_WEBHOOK_URLS = _envFlag(process.env.ALLOW_PRIVATE_WEBHOOK_URLS);

/**
 * One-line human descriptions per event, surfaced to the Settings UI so
 * a user picking which events to subscribe to doesn't have to guess.
 * Kept next to KNOWN_WEBHOOK_EVENTS so the two stay in sync, mirrors
 * api-tokens.js's SCOPE_DESCRIPTIONS/KNOWN_SCOPES pairing.
 */
export const WEBHOOK_EVENT_DESCRIPTIONS = {
  'meal.logged':      'A food item is logged to the diary.',
  'water.logged':      'A water entry is logged to the diary.',
  'body_stat.logged':  'Any body-stat value (weight, body fat, a measurement) is logged or updated.',
  'goal.achieved':     'A daily nutrition goal (calories, a macro, or water) is reached or exceeded.',
};

export const KNOWN_WEBHOOK_EVENTS = new Set(Object.keys(WEBHOOK_EVENT_DESCRIPTIONS));

function _parseRow(row) {
  if (!row) return row;
  return { ...row, events: JSON.parse(row.events || '[]'), enabled: !!row.enabled };
}

/**
 * Create a webhook. `secret` is optional, a random one is generated if
 * omitted. Returns { row, secret } where `secret` is the only place the
 * plaintext ever appears in a response, same one-time-reveal contract
 * api-tokens.js's createToken uses for the raw token value.
 */
export async function createWebhook({ userId, url, events, secret }) {
  if (!userId) throw new Error('userId required');
  const trimmedUrl = String(url || '').trim();
  if (!trimmedUrl) throw new Error('url required');
  await assertSafeUrl(trimmedUrl, {
    allowPrivate: ALLOW_PRIVATE_WEBHOOK_URLS,
    allowPrivateEnvHint: 'ALLOW_PRIVATE_WEBHOOK_URLS',
  });

  const requested = Array.isArray(events) ? events : [];
  const validEvents = requested.filter(e => KNOWN_WEBHOOK_EVENTS.has(String(e)));
  if (validEvents.length === 0) throw new Error('At least one valid event required');

  const plainSecret = secret ? String(secret) : randomBytes(SECRET_BYTES).toString('base64url');

  const r = db.prepare(
    `INSERT INTO webhooks (user_id, url, secret_encrypted, events) VALUES (?, ?, ?, ?)`
  ).run(userId, trimmedUrl, encrypt(plainSecret), JSON.stringify(validEvents));

  const row = db.prepare(
    `SELECT id, user_id, url, events, enabled, last_delivery_at, last_delivery_status, last_delivery_error, created_at
       FROM webhooks WHERE id = ?`
  ).get(r.lastInsertRowid);
  return { row: _parseRow(row), secret: plainSecret };
}

/** List webhooks for a user. Never returns the encrypted secret. */
export function listWebhooks(userId) {
  return db.prepare(
    `SELECT id, user_id, url, events, enabled, last_delivery_at, last_delivery_status, last_delivery_error, created_at
       FROM webhooks WHERE user_id = ? ORDER BY created_at DESC`
  ).all(userId).map(_parseRow);
}

/** Update a webhook's url/events/enabled. Returns the updated row, or null if not found. */
export async function updateWebhook({ userId, id, url, events, enabled }) {
  const existing = db.prepare('SELECT * FROM webhooks WHERE id = ? AND user_id = ?').get(id, userId);
  if (!existing) return null;

  let nextUrl = existing.url;
  if (url != null) {
    nextUrl = String(url).trim();
    if (!nextUrl) throw new Error('url required');
    await assertSafeUrl(nextUrl, {
      allowPrivate: ALLOW_PRIVATE_WEBHOOK_URLS,
      allowPrivateEnvHint: 'ALLOW_PRIVATE_WEBHOOK_URLS',
    });
  }

  let nextEvents = JSON.parse(existing.events || '[]');
  if (events != null) {
    const requested = Array.isArray(events) ? events : [];
    nextEvents = requested.filter(e => KNOWN_WEBHOOK_EVENTS.has(String(e)));
    if (nextEvents.length === 0) throw new Error('At least one valid event required');
  }

  const nextEnabled = enabled != null ? (enabled ? 1 : 0) : existing.enabled;

  db.prepare(
    `UPDATE webhooks SET url = ?, events = ?, enabled = ? WHERE id = ?`
  ).run(nextUrl, JSON.stringify(nextEvents), nextEnabled, id);

  const row = db.prepare(
    `SELECT id, user_id, url, events, enabled, last_delivery_at, last_delivery_status, last_delivery_error, created_at
       FROM webhooks WHERE id = ?`
  ).get(id);
  return _parseRow(row);
}

/** Delete a webhook. Returns true if a row was removed. */
export function deleteWebhook({ userId, id }) {
  const r = db.prepare(`DELETE FROM webhooks WHERE id = ? AND user_id = ?`).run(id, userId);
  return r.changes > 0;
}

function _recordDelivery(id, status, error) {
  db.prepare(
    `UPDATE webhooks SET last_delivery_at = datetime('now'), last_delivery_status = ?, last_delivery_error = ? WHERE id = ?`
  ).run(status, error ? String(error).slice(0, 500) : null, id);
}

/**
 * Deliver one event to one webhook row, with retry. Re-validates the
 * target via assertSafeUrl immediately before sending, not just once at
 * creation time, since DNS can change between the two. Always resolves
 * (never throws) since this is called fire-and-forget; failure is
 * recorded on the row for the Settings UI to surface, not propagated to
 * the caller.
 */
async function _deliverWithRetry(row, event, data) {
  const deliveryId = randomUUID();
  let secret, envelope, signature;
  try {
    secret = decrypt(row.secret_encrypted);
    if (!secret) throw new Error('Could not decrypt webhook secret');
    ({ envelope, signature } = signEnvelope(secret, event, data));
  } catch (e) {
    logger.warn(`[webhooks] delivery ${deliveryId} to webhook ${row.id} rejected before sending: ${e.message}`);
    _recordDelivery(row.id, 'failed', e.message);
    return;
  }

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      // Re-validated on EVERY attempt, not just once before the loop:
      // an attacker who controls DNS for the webhook's hostname could
      // otherwise point it at a public IP for this check, then rebind
      // to an internal address before a later retry fires (up to ~2.5s
      // later), and the guard would never look again.
      await assertSafeUrl(row.url, {
        allowPrivate: ALLOW_PRIVATE_WEBHOOK_URLS,
        allowPrivateEnvHint: 'ALLOW_PRIVATE_WEBHOOK_URLS',
      });
      await sendWebhookRequest(row.url, envelope, signature, deliveryId, event);
      _recordDelivery(row.id, 'success', null);
      return;
    } catch (e) {
      const isLast = attempt === MAX_ATTEMPTS - 1;
      logger.warn(`[webhooks] delivery ${deliveryId} to webhook ${row.id} attempt ${attempt + 1}/${MAX_ATTEMPTS} failed: ${e.message}`);
      if (isLast) {
        _recordDelivery(row.id, 'failed', e.message);
        return;
      }
      await new Promise(r => setTimeout(r, RETRY_DELAYS_MS[attempt]));
    }
  }
}

/**
 * Fire `event` to every enabled webhook this user has subscribed to it.
 * Fire-and-forget: does not await delivery, callers should not await
 * this either (or if they do, only to know dispatch was scheduled, not
 * that delivery succeeded). No-op entirely when WEBHOOKS_ENABLED is off.
 */
export function dispatchWebhookEvent(userId, event, data) {
  if (!WEBHOOKS_ENABLED || userId == null) return;
  let rows;
  try {
    rows = db.prepare('SELECT * FROM webhooks WHERE user_id = ? AND enabled = 1').all(userId);
  } catch (e) {
    logger.error('[webhooks] failed to load subscriptions:', e?.message || e);
    return;
  }
  for (const row of rows) {
    let subscribed;
    try { subscribed = JSON.parse(row.events || '[]'); } catch { subscribed = []; }
    if (!subscribed.includes(event)) continue;
    _deliverWithRetry(row, event, data).catch(() => {});
  }
}

/**
 * Fire a synthetic test event through the real delivery path for one
 * specific webhook, awaited (unlike dispatchWebhookEvent) so the
 * Settings UI can show success/failure immediately rather than the
 * user waiting for a real diary save. Bypasses the enabled/subscribed-
 * events filtering, a user testing a webhook wants to know the URL and
 * secret actually work, regardless of whether the row is currently
 * enabled or which events it's subscribed to.
 */
export async function sendTestWebhook({ userId, id }) {
  const row = db.prepare('SELECT * FROM webhooks WHERE id = ? AND user_id = ?').get(id, userId);
  if (!row) throw new Error('Webhook not found');
  await _deliverWithRetry(row, 'test', { message: 'This is a test event from NutriTrace.' });
  const fresh = db.prepare('SELECT last_delivery_status, last_delivery_error FROM webhooks WHERE id = ?').get(id);
  return fresh;
}
