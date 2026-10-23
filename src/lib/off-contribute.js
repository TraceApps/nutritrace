/**
 * off-contribute.js - share a product with Open Food Facts
 * (TraceApps/nutritrace#284).
 *
 * The same file sits in src/lib and server/lib of NutriTrace and CookTrace
 * (scripts/off-contribute.test.js keeps the copies identical). The server
 * uses it for the web app and the Android app with a server; the Android
 * app with no server uses it to reach Open Food Facts itself.
 *
 * Open Food Facts takes a product as a POST to /cgi/product_jqm2.pl with
 * the person's own user_id and password in the body
 * (openfoodfacts.github.io/openfoodfacts-server/api/tutorial-off-api/).
 * A wrong login answers an HTML page, not JSON, so every answer is read as
 * text and sorted into one plain error here, never a JSON parse error.
 */

export const OFF_HOST = 'https://world.openfoodfacts.org';
// Open Food Facts' staging server, for tests only. Its basic auth (off/off)
// is the published one that keeps search engines out, not a secret.
export const OFF_STAGING_HOST = 'https://world.openfoodfacts.net';
const STAGING_AUTH = 'Basic b2ZmOm9mZg==';

// The product fields the apps send. Anything else is dropped, so the server
// route can never be used to set other fields or reach other endpoints.
const FIELD = /^(code|lang|brands|nutrition_data_per|serving_size|countries|app_name|product_name_[a-z]{2}|nutriment_[a-z0-9-]{1,40})$/;
const MAX_FIELD = 500;

const MESSAGES = {
  no_account: 'Add your Open Food Facts account in Settings to share.',
  login: 'Open Food Facts did not accept that username or password.',
  refused: 'Open Food Facts did not accept the product.',
  unreachable: 'Open Food Facts could not be reached. Try again later.',
};

/** kind: no_account | login | refused | unreachable. detail: OFF's own words. */
export class OffShareError extends Error {
  constructor(kind, detail = '') {
    super(detail ? `${MESSAGES[kind] || MESSAGES.unreachable} (${detail})` : (MESSAGES[kind] || MESSAGES.unreachable));
    this.name = 'OffShareError';
    this.kind = MESSAGES[kind] ? kind : 'unreachable';
    this.detail = detail;
  }
}

/** The allowed product fields as strings. Throws when there is no barcode. */
export function cleanOffFields(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) {
    if (!FIELD.test(k) || v == null || typeof v === 'object') continue;
    const s = String(v).trim().slice(0, MAX_FIELD);
    if (s) out[k] = s;
  }
  if (!out.code) throw new OffShareError('refused', 'no barcode');
  return out;
}

/** Sort Open Food Facts' answer: { ok: true } or { kind, detail }. */
export function readOffAnswer(httpStatus, text) {
  let json = null;
  try { json = JSON.parse(text); } catch { /* an HTML page */ }
  if (json && typeof json === 'object') {
    if (json.status === 1 || json.status === 'status ok') return { ok: true };
    const detail = String(json.status_verbose || json.error || '').trim().slice(0, 200);
    if (/no user credentials|incorrect user name or password/i.test(detail)) return { kind: 'login', detail: '' };
    return { kind: 'refused', detail };
  }
  if (/incorrect user name or password/i.test(String(text || ''))) return { kind: 'login', detail: '' };
  return { kind: 'unreachable', detail: httpStatus ? `HTTP ${httpStatus}` : '' };
}

async function _send(fetchImpl, url, init, timeoutMs) {
  let res;
  try {
    const signal = typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined;
    res = await fetchImpl(url, { ...init, redirect: 'manual', signal });
  } catch {
    throw new OffShareError('unreachable');
  }
  let text = '';
  try { text = await res.text(); } catch { /* empty */ }
  return { status: res.status, text };
}

/**
 * Send a product, then its photo when there is one. Returns
 * { ok: true, photo: null | 'sent' | 'failed' }; a photo that fails does
 * not undo the product. Throws OffShareError.
 *
 * image: a Blob (browser) or Blob made from a Buffer (server), or null.
 * userAgent: set by the server only (a browser decides its own).
 */
export async function shareWithOff({ fetchImpl, host = OFF_HOST, userId, password, fields, image = null, userAgent = '', timeoutMs = 30000 }) {
  const user = String(userId || '').trim();
  if (!user || !password) throw new OffShareError('no_account');
  const clean = cleanOffFields(fields);
  const headers = {};
  if (userAgent) headers['User-Agent'] = userAgent;
  if (host === OFF_STAGING_HOST) headers.Authorization = STAGING_AUTH;

  const body = new URLSearchParams({ ...clean, user_id: user, password: String(password) });
  const answer = await _send(fetchImpl, host + '/cgi/product_jqm2.pl', {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  }, timeoutMs);
  const read = readOffAnswer(answer.status, answer.text);
  if (!read.ok) throw new OffShareError(read.kind, read.detail);

  let photo = null;
  if (image) {
    try {
      const imagefield = 'front_' + (/^[a-z]{2}$/.test(clean.lang || '') ? clean.lang : 'en');
      const fd = new FormData();
      fd.append('code', clean.code);
      fd.append('user_id', user);
      fd.append('password', String(password));
      fd.append('imagefield', imagefield);
      fd.append('imgupload_' + imagefield, image, 'front.jpg');
      const a = await _send(fetchImpl, host + '/cgi/product_image_upload.pl', { method: 'POST', headers, body: fd }, timeoutMs);
      photo = readOffAnswer(a.status, a.text).ok ? 'sent' : 'failed';
    } catch {
      photo = 'failed';
    }
  }
  return { ok: true, photo };
}
