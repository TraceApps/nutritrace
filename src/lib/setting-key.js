/**
 * setting-key.js: where an account's settings live in this app's storage.
 *
 * `wl_u<id>_<key>` per account, and in the Android app connected to a
 * server, `wl_u<id>@<server>_<key>`: the same user id on another server
 * is another account, and must never see or save these values. With no
 * account (single-user mode) it's `wl_<key>`. The web app runs on its own
 * server's address, so its storage is already that server's alone.
 * No imports, so anything can read a setting without pulling in the
 * stores (notifications, the API layer, db.js).
 */
export function settingScope() {
  try {
    const srv = String(localStorage.getItem('nt:serverUrl') || '').trim().replace(/\/+$/, '').toLowerCase();
    if (!srv) return '';
    return '@' + srv.replace(/^https?:\/\//, '').replace(/[^a-z0-9.-]/g, '-');
  } catch {
    return '';
  }
}

export function settingPrefix(userId) {
  let id = userId;
  if (id === undefined) { try { id = localStorage.getItem('wl:userId'); } catch { id = null; } }
  return id ? `wl_u${id}${settingScope()}_` : 'wl_';
}

/** One time: settings kept before they carried the server move to the
 *  server this app is connected to now (the one they were made on). */
export function migrateSettingScope() {
  try {
    if (localStorage.getItem('nt:settings:scoped') === '1') return;
    const scope = settingScope();
    if (scope) {
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && /^wl_u\d+_/.test(k)) keys.push(k);
      }
      for (const k of keys) {
        const to = k.replace(/^(wl_u\d+)_/, `$1${scope}_`);
        if (localStorage.getItem(to) === null) localStorage.setItem(to, localStorage.getItem(k));
        localStorage.removeItem(k);
      }
    }
    localStorage.setItem('nt:settings:scoped', '1');
  } catch { /* storage unavailable */ }
}

/** The same account at another address of the same server: its settings
 *  move with it (lib/local-account.js). */
export function moveSettingScope(userId, fromServerUrl) {
  try {
    const from = String(fromServerUrl || '').trim().replace(/\/+$/, '').toLowerCase();
    const fromPrefix = `wl_u${userId}${from ? '@' + from.replace(/^https?:\/\//, '').replace(/[^a-z0-9.-]/g, '-') : ''}_`;
    const toPrefix = settingPrefix(String(userId));
    if (fromPrefix === toPrefix) return;
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(fromPrefix)) keys.push(k);
    }
    for (const k of keys) {
      const to = toPrefix + k.slice(fromPrefix.length);
      if (localStorage.getItem(to) === null) localStorage.setItem(to, localStorage.getItem(k));
      localStorage.removeItem(k);
    }
  } catch { /* storage unavailable */ }
}

// Before anything reads a setting.
migrateSettingScope();
