/**
 * secret-settings.js: the secrets people keep in their own settings
 * (TraceApps/cooktrace#92). Shared by every Trace app; the keys are each
 * app's own (secret-setting-keys.js).
 *
 * Every secret is stored encrypted (token-crypto.js, TOKEN_ENC_KEY), so the
 * database, a backup or an export never holds it in the clear. One only the
 * server uses (a federation token, an ntfy or Gotify token) is never sent
 * back: the app is told it's set (SECRET_SET), and saving that leaves the
 * secret as it is. One the browser or phone uses itself (an AI key it calls
 * the provider with) still goes to the signed-in account's own app.
 *
 * Values here are the parsed setting (what JSON.parse of the column gives);
 * the *Raw helpers take and give the column's JSON text.
 */
import { encrypt, decrypt } from './token-crypto.js';
import { WRITE_ONLY_SETTINGS, ENCRYPTED_SETTINGS } from './secret-setting-keys.js';

/** What the app is sent for a server-only secret that's set. */
export const SECRET_SET = '••••••••';
const PREFIX = 'enc:v1:';

export const isSecretSetting = key => WRITE_ONLY_SETTINGS.has(key) || ENCRYPTED_SETTINGS.has(key);
export const isWriteOnlySetting = key => WRITE_ONLY_SETTINGS.has(key);
const _sealed = v => typeof v === 'string' && v.startsWith(PREFIX);

function _parse(raw) {
  if (raw == null) return raw;
  try { return JSON.parse(raw); } catch { return raw; }
}

/** A stored value as the server uses it: the secret in the clear ('' when it can't be read). */
export function revealSetting(key, value) {
  if (!isSecretSetting(key) || !_sealed(value)) return value;
  return decrypt(value) ?? '';
}

/** The column's text, parsed and revealed. */
export const readSettingRaw = (key, raw) => revealSetting(key, _parse(raw));

/** What the account's app is sent for a stored value. */
export function clientSetting(key, value) {
  if (!isSecretSetting(key)) return value;
  const plain = revealSetting(key, value);
  if (WRITE_ONLY_SETTINGS.has(key)) return plain == null || plain === '' ? plain : SECRET_SET;
  return plain;
}

/** clientSetting on the column's text, giving JSON text (a phone's pull). */
export function clientSettingRaw(key, raw) {
  if (!isSecretSetting(key) || raw == null) return raw;
  return JSON.stringify(clientSetting(key, _parse(raw)));
}

/**
 * The column text to store for a value the app sent, or undefined to leave
 * the stored one be (the SECRET_SET placeholder sent back, or a value that's
 * already encrypted, which no app is ever sent). existingRaw: the
 * text stored now, kept when the secret hasn't changed, so a save of the
 * same value isn't a change.
 */
export function settingToStore(key, value, existingRaw) {
  if (!isSecretSetting(key)) return JSON.stringify(value);
  if (value === SECRET_SET) return existingRaw == null ? JSON.stringify('') : undefined;
  // Never something already encrypted: only the server makes those, and
  // taking one would have the server read out whatever it holds.
  if (_sealed(value)) return undefined;
  if (typeof value === 'number') value = String(value);
  if (typeof value !== 'string' || !value) return JSON.stringify(value);
  if (existingRaw != null && readSettingRaw(key, existingRaw) === value) return existingRaw;
  return JSON.stringify(encrypt(value));
}

/** settingToStore for a value given as JSON text (a phone's push). */
export const settingToStoreRaw = (key, raw, existingRaw) =>
  isSecretSetting(key) ? settingToStore(key, _parse(raw), existingRaw) : raw;

/**
 * Encrypt the secrets still stored in the clear: from before this, or
 * brought back by a restored backup. Returns how many.
 */
export function sealStoredSecrets(db) {
  const keys = [...WRITE_ONLY_SETTINGS, ...ENCRYPTED_SETTINGS];
  if (!keys.length) return 0;
  const rows = db.prepare(
    `SELECT user_id, key, value FROM user_settings WHERE key IN (${keys.map(() => '?').join(',')})`
  ).all(...keys);
  const upd = db.prepare('UPDATE user_settings SET value = ? WHERE user_id IS ? AND key = ?');
  let n = 0;
  db.transaction(() => {
    for (const r of rows) {
      let v = _parse(r.value);
      if (typeof v === 'number') v = String(v);
      if (typeof v !== 'string' || !v || _sealed(v)) continue;
      upd.run(JSON.stringify(encrypt(v)), r.user_id, r.key);
      n++;
    }
  })();
  return n;
}
