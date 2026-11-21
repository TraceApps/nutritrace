/**
 * What a setting a person never chose starts as (cooktrace#93,
 * nutritrace#326): the default an admin set for the whole server, else what
 * the browser's or phone's locale suggests, else the app's own (US) default.
 * A person's own choice always wins, and nothing here is ever saved into
 * their settings, so a later change to the server's default reaches
 * everyone who hasn't chosen.
 *
 * Shared, byte for byte, by NutriTrace, LiftTrace, CookTrace and NoteTrace:
 * keys an app doesn't have are never asked for. No imports, so it loads in
 * tests and before the settings stores.
 */

// Regions that measure in pounds, miles and Fahrenheit day to day.
const IMPERIAL = new Set(['US', 'LR', 'MM']);
// Fahrenheit for the weather (and so for body temperature) beyond those.
const FAHRENHEIT = new Set([...IMPERIAL, 'BS', 'BZ', 'KY', 'PW', 'FM', 'MH', 'PR', 'GU', 'VI', 'AS', 'MP']);
// Miles on the road signs.
const MILES = new Set([...IMPERIAL, 'GB']);
// Height in feet and inches.
const FEET = new Set([...IMPERIAL, 'GB']);
// Food labels in kilojoules first.
const KILOJOULES = new Set(['AU', 'NZ']);

// Languages Open Food Facts search offers here. (Its search country has no
// locale rule: a country narrows every search to it, which nobody asked
// for by having a browser; only an admin's default sets one.)
const OFF_LANGUAGES = new Set(['en', 'fr', 'de', 'es', 'it', 'pt', 'nl', 'pl', 'ru', 'uk', 'ja', 'zh', 'ar', 'ko']);

/** The locale this device reports ('en-GB'), or null with none. */
export function deviceLocale() {
  try {
    if (typeof navigator !== 'undefined') return navigator.languages?.[0] || navigator.language || null;
  } catch { /* no navigator */ }
  return null;
}

/**
 * What a locale tag says: its region ('GB', guessed for a bare language
 * the way the browser would), language ('en'), the order it writes a date
 * in ('MDY', 'DMY' or 'YMD') and whether its clock is 12-hour.
 */
export function localeFacts(tag) {
  if (!tag || typeof tag !== 'string') return null;
  tag = tag.replace(/_/g, '-');
  let loc = null;
  try { loc = new Intl.Locale(tag); } catch { /* not a tag, or an engine without Intl.Locale */ }
  // Without Intl.Locale (Android WebViews before Chrome 74): the tag's own
  // parts, 'en-GB' or 'en_GB'.
  const parts = /^([a-z]{2,3})(?:[-_][A-Za-z]{4})?(?:[-_]([A-Za-z]{2}|\d{3}))?(?:[-_]|$)/i.exec(tag);
  if (!loc && !parts) return null;
  let region = loc ? loc.region || null : (parts[2] && !/^\d/.test(parts[2]) ? parts[2] : null);
  if (!region && loc) { try { region = loc.maximize().region || null; } catch { /* old engine */ } }
  let order = null, hour12 = null;
  try {
    const seq = new Intl.DateTimeFormat(tag, { year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(new Date(2001, 10, 22)).map(p => p.type).filter(t => t === 'year' || t === 'month' || t === 'day');
    order = seq.map(t => t[0].toUpperCase()).join('');
  } catch { /* no Intl dates */ }
  try {
    const hc = new Intl.DateTimeFormat(tag, { hour: 'numeric' }).resolvedOptions().hourCycle;
    if (hc) hour12 = hc === 'h11' || hc === 'h12';
  } catch { /* no Intl dates */ }
  return { region: region ? region.toUpperCase() : null, language: (loc ? loc.language : parts[1].toLowerCase()) || null, order, hour12 };
}

/**
 * What the locale suggests for a setting, or undefined when it says
 * nothing (no region, or a key with no rule: language has its own, in
 * each app's i18n).
 */
export function localeDefault(key, tag = deviceLocale()) {
  const f = localeFacts(tag);
  if (!f) return undefined;
  const r = f.region;
  switch (key) {
    case 'measurementSystem': return r ? (IMPERIAL.has(r) ? 'imperial' : 'metric') : undefined;
    case 'energyUnit':        return r ? (KILOJOULES.has(r) ? 'kJ' : 'kcal') : undefined;
    case 'weightUnit':        return r ? (IMPERIAL.has(r) ? 'lb' : 'kg') : undefined;
    case 'heightUnit':        return r ? (FEET.has(r) ? 'ft' : 'cm') : undefined;
    case 'lengthUnit':        return r ? (IMPERIAL.has(r) ? 'in' : 'cm') : undefined;
    case 'distUnit':          return r ? (MILES.has(r) ? 'mi' : 'km') : undefined;
    case 'tempUnit':          return r ? (FAHRENHEIT.has(r) ? 'F' : 'C') : undefined;
    case 'dateFormat':        return f.order === 'MDY' ? 'US' : f.order === 'YMD' ? 'ISO' : f.order === 'DMY' ? 'EU' : undefined;
    case 'timeFormat':        return f.hour12 == null ? undefined : (f.hour12 ? '12h' : '24h');
    case 'offSearchLanguage': return f.language && OFF_LANGUAGES.has(f.language) ? f.language : (f.language ? 'en' : undefined);
    default:                  return undefined;
  }
}

// ── The server's defaults, as this device last saw them ─────────────────
// Kept so they hold offline and before the server answers. `scope` is the
// server they came from (the Android app can switch servers).
const CACHE_KEY = 'trace_instance_defaults';
let _mem = null;

function _read() {
  if (_mem) return _mem;
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(CACHE_KEY) : null;
    _mem = raw ? JSON.parse(raw) : { scope: null, values: {} };
  } catch { _mem = { scope: null, values: {} }; }
  if (!_mem || typeof _mem !== 'object' || typeof _mem.values !== 'object' || !_mem.values) _mem = { scope: null, values: {} };
  return _mem;
}

/** The server's defaults this device holds for `scope` (key to value). */
export function instanceDefaults(scope = '') {
  const c = _read();
  return (c.scope ?? '') === (scope ?? '') ? c.values : {};
}

/**
 * Keep the server's defaults (`values`: key to value) for `scope`. Returns
 * true when they differ from what was held, for the caller to refresh what
 * shows them.
 */
export function rememberInstanceDefaults(values, scope = '') {
  const clean = {};
  for (const [k, v] of Object.entries(values && typeof values === 'object' ? values : {})) {
    if (typeof v === 'string' && v) clean[k] = v;
  }
  const before = JSON.stringify(instanceDefaults(scope));
  _mem = { scope: scope ?? '', values: clean };
  try { if (typeof localStorage !== 'undefined') localStorage.setItem(CACHE_KEY, JSON.stringify(_mem)); } catch { /* full or private */ }
  return before !== JSON.stringify(clean);
}

/**
 * What a setting nobody chose shows: the server's default when it's one
 * this app offers (`allowed`, when given), else the locale's, else
 * `fallback` (or `fallback()`, for an app's own locale rule).
 */
export function regionalDefault(key, fallback, { scope = '', allowed = null, tag } = {}) {
  const ok = v => v !== undefined && v !== null && v !== '' && (!allowed || allowed.includes(v));
  const server = instanceDefaults(scope)[key];
  if (ok(server)) return server;
  const local = localeDefault(key, tag === undefined ? deviceLocale() : tag);
  if (ok(local)) return local;
  return typeof fallback === 'function' ? fallback() : fallback;
}
