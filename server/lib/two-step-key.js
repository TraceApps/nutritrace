/**
 * two-step-key.js: the key that locks two-step sign-in secrets (#222).
 *
 * Separate from the sign-in (JWT) secret, so changing that one never locks
 * anyone out of two-step sign-in, and a database file on its own never
 * gives away anyone's codes.
 *
 * Where the key comes from, first found wins:
 *   1. TWO_STEP_KEY (or TWO_STEP_KEY_FILE, read by docker-entrypoint.sh),
 *      for anyone who keeps secrets outside the data folder.
 *   2. two-step.key next to the database (DB_PATH's folder): made once, at
 *      random, the first time it's needed, readable by the server only. It
 *      lives on the same volume as the database, so it survives restarts
 *      and updates with nothing to set up.
 *
 * Secrets are AES-256-GCM, tied to their account (a secret copied onto
 * another account doesn't open), with a short id of the key that locked
 * them so a key that changed is told from a damaged secret. A secret that
 * can't be opened is never fatal: the person signs in with a recovery code
 * or has two-step sign-in reset (lib/two-step.js says how).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const PREFIX = 'ts:v1:';
const SALT = 'traceapps.two-step.v1';

let _cached = null; // { key, id } once found
let _warned = false;
export const MIN_ENV_KEY = 32;

export function keyFilePath() {
  const dbPath = process.env.DB_PATH || './nutritrace.db';
  return path.join(path.dirname(path.resolve(dbPath)), 'two-step.key');
}

function _derive(material) {
  const out = crypto.hkdfSync('sha256', Buffer.from(material, 'utf8'), Buffer.from(SALT, 'utf8'), Buffer.alloc(0), 32);
  const key = Buffer.isBuffer(out) ? out : Buffer.from(out);
  const id = crypto.createHash('sha256').update(key).digest('hex').slice(0, 8);
  return { key, id };
}

function _readFile(file) {
  try {
    const text = fs.readFileSync(file, 'utf8').trim();
    return text.length >= 32 ? text : null;
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

/**
 * The key, made when there's none yet. Throws (with code 'KEY_UNAVAILABLE')
 * when there's no key and none can be saved: a read-only data folder.
 */
export function getKey({ create = true } = {}) {
  if (_cached) return _cached;
  const env = process.env.TWO_STEP_KEY;
  if (env && env.trim()) {
    // Short enough to guess, a stolen database would give up its secrets:
    // refused (two-step sign-in can't be set up, and codes say why), never
    // used.
    if (env.trim().length < MIN_ENV_KEY) {
      if (!_warned) { _warned = true; console.error(`[two-step] TWO_STEP_KEY is shorter than ${MIN_ENV_KEY} characters, so it isn't used. Set a longer one (openssl rand -hex 32), or remove it to use the generated two-step.key.`); }
      throw Object.assign(new Error('TWO_STEP_KEY too short'), { code: 'KEY_UNAVAILABLE' });
    }
    _cached = { ..._derive(env.trim()), source: 'env' };
    return _cached;
  }
  const file = keyFilePath();
  let material;
  try {
    material = _readFile(file);
    if (!material && create) {
      const made = crypto.randomBytes(32).toString('hex');
      try {
        // 'wx': two servers starting at once can't both write one.
        fs.writeFileSync(file, made + '\n', { mode: 0o600, flag: 'wx' });
        material = made;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        material = _readFile(file);
      }
    }
  } catch (e) {
    throw Object.assign(new Error(`two-step sign-in key unavailable at ${file}: ${e.code || e.message}`), { code: 'KEY_UNAVAILABLE' });
  }
  if (!material) throw Object.assign(new Error('no two-step sign-in key yet'), { code: 'KEY_UNAVAILABLE' });
  _cached = { ..._derive(material), source: 'file' };
  return _cached;
}

/** Whether secrets can be locked and opened right now. */
export function keyAvailable() {
  try { getKey(); return true; } catch { return false; }
}

/** Lock a secret (bytes) for one account. */
export function sealSecret(secret, userId) {
  const { key, id } = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`user:${userId}`));
  const ct = Buffer.concat([cipher.update(secret), cipher.final()]);
  return `${PREFIX}${id}:${iv.toString('base64')}:${Buffer.concat([ct, cipher.getAuthTag()]).toString('base64')}`;
}

/**
 * Open a secret: { secret } or { problem } where problem is 'key_changed'
 * (locked with another key: TWO_STEP_KEY changed, or the key file was lost
 * or replaced, or a backup came from another server), 'no_key' (no key can
 * be read) or 'damaged'.
 */
export function openSecret(sealed, userId) {
  if (typeof sealed !== 'string' || !sealed.startsWith(PREFIX)) return { problem: 'damaged' };
  const [kid, ivB64, blobB64] = sealed.slice(PREFIX.length).split(':');
  let k;
  try { k = getKey({ create: false }); } catch { return { problem: 'no_key' }; }
  if (kid !== k.id) return { problem: 'key_changed' };
  try {
    const iv = Buffer.from(ivB64, 'base64');
    const blob = Buffer.from(blobB64, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', k.key, iv);
    decipher.setAAD(Buffer.from(`user:${userId}`));
    decipher.setAuthTag(blob.subarray(blob.length - 16));
    return { secret: Buffer.concat([decipher.update(blob.subarray(0, blob.length - 16)), decipher.final()]) };
  } catch {
    return { problem: 'damaged' };
  }
}

/** Tests only: forget the key read so far. */
export function _forgetKeyForTests() { _cached = null; }
