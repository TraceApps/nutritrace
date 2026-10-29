/**
 * totp.js: one-time codes for two-step sign-in (#222), on Node's crypto
 * alone. HOTP is RFC 4226, TOTP is RFC 6238 (30-second steps from the Unix
 * epoch, 6 digits, HMAC-SHA1: what every authenticator app reads from an
 * otpauth:// link). scripts/two-step-totp.test.js checks both RFCs' own
 * test vectors.
 *
 * No database, no settings: the same file serves every Trace app.
 */
import crypto from 'node:crypto';

export const STEP_SECONDS = 30;
export const DIGITS = 6;

// ── Base32 (RFC 4648, no padding), how authenticator apps take the key ────
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/** Bytes from base32, or null when it isn't base32. Spaces, dashes and case are ignored. */
export function base32Decode(text) {
  const clean = String(text || '').toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '');
  if (!clean || /[^A-Z2-7]/.test(clean)) return null;
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new random key: 20 bytes, the size RFC 4226 recommends for SHA-1. */
export function newSecret() {
  return crypto.randomBytes(20);
}

// ── HOTP (RFC 4226 section 5) ─────────────────────────────────────────────
export function hotp(key, counter, { digits = DIGITS, algorithm = 'sha1' } = {}) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac(algorithm, key).update(msg).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[offset] & 0x7f) << 24)
    | (mac[offset + 1] << 16)
    | (mac[offset + 2] << 8)
    | mac[offset + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

// ── TOTP (RFC 6238 section 4) ─────────────────────────────────────────────
export function timeStep(nowMs = Date.now(), step = STEP_SECONDS) {
  return Math.floor(nowMs / 1000 / step);
}

export function totp(key, nowMs = Date.now(), { step = STEP_SECONDS, digits = DIGITS, algorithm = 'sha1' } = {}) {
  return hotp(key, timeStep(nowMs, step), { digits, algorithm });
}

/** Digits only, from what was typed ("123 456" and "123-456" both count). */
export function cleanCode(code) {
  return String(code ?? '').replace(/[\s-]/g, '');
}

/**
 * The time step a code matches, or null. One step either side of now is
 * accepted (a phone's clock a little off, a code typed as it changes). A
 * step at or before `lastStep` never matches: a code that was used, or an
 * older one, can't be used again. Every candidate is compared, in constant
 * time, whatever matches first.
 */
export function verifyTotp(key, code, { nowMs = Date.now(), window = 1, lastStep = -Infinity, step = STEP_SECONDS, digits = DIGITS } = {}) {
  const given = cleanCode(code);
  if (given.length !== digits || /\D/.test(given)) return null;
  const now = timeStep(nowMs, step);
  const want = Buffer.from(given);
  let found = null;
  for (let s = now - window; s <= now + window; s++) {
    const same = crypto.timingSafeEqual(Buffer.from(hotp(key, s, { digits })), want);
    if (same && s > lastStep && found == null) found = s;
  }
  return found;
}

/** The otpauth:// link an authenticator app reads from the QR code. */
export function otpauthUri({ issuer, account, secret }) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: String(DIGITS), period: String(STEP_SECONDS) });
  return `otpauth://totp/${label}?${params}`;
}
