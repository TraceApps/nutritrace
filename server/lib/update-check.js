/**
 * update-check.js: whether this instance may ask GitHub about new releases.
 *
 * The check is off on a fresh install and the setup wizard asks for it, so
 * nothing leaves the instance until someone says yes. An instance that was
 * already running keeps whatever it was doing: the migration below writes
 * the old behaviour (on) the first time this version starts against an
 * existing database, so an update never silently stops telling an admin
 * about a release that fixes a security problem.
 *
 * UPDATE_CHECK=off in the environment turns it off for good and takes
 * precedence over the setting, for instances that must make no outbound
 * requests at all.
 */
import db from '../db.js';
import { logger } from '../logger.js';

const KEY = 'update_check_enabled';

function _get(key) {
  return db.prepare('SELECT value FROM app_config WHERE key = ?').get(key)?.value ?? null;
}
function _set(key, value) {
  db.prepare('INSERT INTO app_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}

/** True when the environment forbids update checks outright. */
export function envLocksUpdateCheck() {
  return /^(0|off|false|no)$/i.test(String(process.env.UPDATE_CHECK || '').trim());
}

/** True when this instance may ask GitHub. */
export function updateCheckEnabled() {
  if (envLocksUpdateCheck()) return false;
  return _get(KEY) === '1';
}

/** Record the admin's answer (the wizard, or Settings, Updates). */
export function setUpdateCheckEnabled(on) {
  _set(KEY, on ? '1' : '0');
}

/** Whether the question has been answered at all. */
export function updateCheckAnswered() {
  return _get(KEY) !== null;
}

/**
 * First start on this version: an instance that already has accounts (or is
 * deliberately in single-user mode) was checking before, so it keeps
 * checking. A fresh database is left unanswered for the wizard to ask.
 */
export function initUpdateCheckSetting() {
  if (_get(KEY) !== null) return;
  let existing = false;
  try {
    existing = db.prepare('SELECT 1 FROM users LIMIT 1').get() !== undefined
      || _get('single_user_mode') === '1';
  } catch { /* no users table yet: a fresh database */ }
  _set(KEY, existing ? '1' : '0');
  logger.info(`[updates] update check ${existing ? 'stays on for this existing instance' : 'starts off; setup will ask'}`);
}
