/**
 * Defaults for everyone on this server (cooktrace#93, nutritrace#326):
 * language, units, date and time, and food search, for anyone who hasn't
 * chosen their own. An admin sets them in Settings > Users; an environment
 * variable (regional-options.js names each) sets one and locks it there.
 *
 * Nothing is written into anyone's settings: the app reads these as the
 * fallback for a setting a person never chose (src/lib/regional-defaults.js),
 * so a later change reaches everyone who still hasn't.
 *
 * Shared, byte for byte, by the four Trace apps; regional-options.js is
 * each app's own list.
 */
import db from '../db.js';
import { logger } from '../logger.js';
import { REGIONAL_OPTIONS } from './regional-options.js';

const CONFIG_KEY = 'instance_defaults';

const _has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

// A value as the app stores it, matched without regard to case
// ('kj' is 'kJ'), or null when the app doesn't offer it. A language with a
// region ('en-GB', 'fr_CA') is its language.
function _canonical(key, raw) {
  const opt = _has(REGIONAL_OPTIONS, key) ? REGIONAL_OPTIONS[key] : null;
  if (!opt || raw == null) return null;
  const s = String(raw).trim().toLowerCase();
  if (!s) return null;
  const hit = opt.values.find(v => v.toLowerCase() === s);
  if (hit || key !== 'language') return hit ?? null;
  // 'zh_Hans' is 'zh-Hans'; 'en-GB' is 'en'; 'zh' is the one 'zh-…' offered.
  const dashed = s.replace(/_/g, '-');
  const base = dashed.split('-')[0];
  return opt.values.find(v => v.toLowerCase() === dashed)
    ?? opt.values.find(v => v.toLowerCase() === base)
    ?? (opt.values.filter(v => v.toLowerCase().split('-')[0] === base).length === 1
      ? opt.values.find(v => v.toLowerCase().split('-')[0] === base) : null);
}

// Read once at start: the environment doesn't change while the server runs.
const _env = {};
for (const [key, opt] of Object.entries(REGIONAL_OPTIONS)) {
  const raw = process.env[opt.env];
  if (raw === undefined || String(raw).trim() === '') continue;
  const v = _canonical(key, raw);
  if (v) _env[key] = v;
  else logger.warn(`[defaults] ${opt.env}=${JSON.stringify(raw)} isn't one of: ${opt.values.join(', ')}. Ignored.`);
}

function _stored() {
  try {
    const row = db.prepare('SELECT value FROM app_config WHERE key = ?').get(CONFIG_KEY);
    const obj = row?.value ? JSON.parse(row.value) : {};
    const out = {};
    for (const [k, v] of Object.entries(obj && typeof obj === 'object' ? obj : {})) {
      const c = _canonical(k, v);
      if (c) out[k] = c;
    }
    return out;
  } catch { return {}; }
}

/**
 * { values, locked }: the default for each setting that has one (the
 * environment's over the admin's), and the keys the environment holds.
 */
export function getInstanceDefaults() {
  return { values: { ..._stored(), ..._env }, locked: Object.keys(_env) };
}

/**
 * What the server uses for someone who never chose `key` (an email, a
 * push message, an agent's tool): the default for everyone, else
 * `fallback`. The server can't see a browser, so the locale plays no part.
 */
export function defaultFor(key, fallback) {
  return getInstanceDefaults().values[key] ?? fallback;
}

/**
 * Change the admin's defaults: `patch` maps a key to a value, or to null to
 * take its default away. Throws { status, message } for a key the
 * environment holds (409) or a value the app doesn't offer (400); nothing
 * is saved then.
 */
export function setInstanceDefaults(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw Object.assign(new Error('Send the defaults as an object.'), { status: 400 });
  }
  const next = _stored();
  for (const [key, raw] of Object.entries(patch)) {
    const opt = _has(REGIONAL_OPTIONS, key) ? REGIONAL_OPTIONS[key] : null;
    if (!opt) throw Object.assign(new Error(`${key} has no default to set.`), { status: 400 });
    if (_has(_env, key)) throw Object.assign(new Error(`${opt.env} sets this default in the server's environment.`), { status: 409 });
    if (raw === null || raw === '') { delete next[key]; continue; }
    const v = _canonical(key, raw);
    if (!v) throw Object.assign(new Error(`${JSON.stringify(raw)} isn't a ${key} this app offers.`), { status: 400 });
    next[key] = v;
  }
  db.prepare('INSERT INTO app_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(CONFIG_KEY, JSON.stringify(next));
  return getInstanceDefaults();
}
