/**
 * token-crypto.js — At-rest encryption for OAuth tokens.
 *
 * Wraps long-lived secrets (Fitbit/Withings/Garmin access + refresh tokens)
 * so a leaked database file or backup doesn't hand out wearable-API access.
 *
 * Format on disk: `enc:v1:<base64(iv)>:<base64(ciphertext+tag)>`
 *
 * Key derivation: HKDF-SHA256 from JWT_SECRET + a fixed app-level salt. Using
 * JWT_SECRET means rotating it invalidates both sessions AND token decryption
 * — operators should expect users to re-authorize their wearables after a
 * JWT_SECRET rotation. (For independent rotation, set TOKEN_ENC_KEY explicitly.)
 *
 * Migration: lazy. Existing plaintext tokens are read transparently and
 * re-written encrypted on the next refresh / sync.
 */
import crypto from 'crypto';
import { JWT_SECRET } from '../middleware/auth.js';

const PREFIX = 'enc:v1:';
const SALT   = 'nutritrace.token-crypto.v1';

let _key = null;
function _getKey() {
  if (_key) return _key;
  const source = process.env.TOKEN_ENC_KEY || JWT_SECRET;
  // hkdfSync returns ArrayBuffer in some Node versions — coerce to Buffer.
  const out = crypto.hkdfSync('sha256', Buffer.from(source, 'utf8'), Buffer.from(SALT, 'utf8'), Buffer.alloc(0), 32);
  _key = Buffer.isBuffer(out) ? out : Buffer.from(out);
  return _key;
}

/** Encrypt a plaintext string. Returns the ciphertext-with-prefix string. */
export function encrypt(plaintext) {
  if (plaintext == null) return plaintext;
  if (typeof plaintext !== 'string') plaintext = String(plaintext);
  if (plaintext.startsWith(PREFIX)) return plaintext; // already encrypted
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', _getKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + iv.toString('base64') + ':' + Buffer.concat([ct, tag]).toString('base64');
}

/**
 * Decrypt a value. Pass-through for non-encrypted strings (so plaintext-era
 * rows continue to work until they're re-saved).
 */
export function decrypt(value) {
  if (value == null || typeof value !== 'string') return value;
  if (!value.startsWith(PREFIX)) return value;
  try {
    const body = value.slice(PREFIX.length);
    const idx = body.indexOf(':');
    if (idx < 0) throw new Error('malformed ciphertext');
    const iv = Buffer.from(body.slice(0, idx), 'base64');
    const blob = Buffer.from(body.slice(idx + 1), 'base64');
    const ct = blob.subarray(0, blob.length - 16);
    const tag = blob.subarray(blob.length - 16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', _getKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch (e) {
    // If decryption fails (key rotated, corrupted row), surface null so the
    // caller treats it as "needs re-auth" rather than crashing.
    return null;
  }
}

