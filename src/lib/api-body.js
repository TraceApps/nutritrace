// Measurements sent through POST /api/v1/body-measurements (a scale bridge,
// Home Assistant, a script) are kept as wellness rows with source
// 'federation', which /api/wellness/fitbit/data returns with Fitbit's and
// Health Connect's. Screens that read a scale's weight, body fat or body
// water read them as one more device (#349, #350), once there are some.
import { writable } from 'svelte/store';

export const API_BODY_METRICS = ['weight_kg', 'body_fat_pct', 'body_water_pct', 'muscle_mass_kg', 'bone_mass_kg', 'lean_mass_kg'];

/** True once this account has measurements from the API. */
export const apiBodyData = writable(false);

/** True when a /data answer holds any body measurement. */
export function hasBodyRows(byDate) {
  for (const day of Object.values(byDate || {})) {
    if (day && API_BODY_METRICS.some(k => day[k] != null)) return true;
  }
  return false;
}

/**
 * The /api/wellness/fitbit/data path for a date or a range: every source
 * when Fitbit or Health Connect is on (they come with it), the API's alone
 * when only the API sends measurements, null when neither.
 */
export function bodyDataPath({ date, from, to }, fitbitFamily, apiBody) {
  if (!fitbitFamily && !apiBody) return null;
  const q = date ? `date=${date}` : `from=${from}&to=${to}`;
  return `/api/wellness/fitbit/data?${q}${fitbitFamily ? '' : '&sources=federation'}`;
}

function _ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Looks for measurements from the API, of any age. In the Android app the
 * phone's own database answers first (its sync brings them down), so it
 * works offline; otherwise, or when the phone has none yet, the server. A
 * failed look changes nothing.
 */
export async function refreshApiBodyData(api, { native = false, now = new Date(), localRead = null } = {}) {
  const from = '2000-01-01', to = _ymd(now);
  if (native || localRead) {
    try {
      const read = localRead || (await import('./db-native.js')).dbGetWellnessGrouped;
      if (hasBodyRows(await read(from, to, 'federation'))) { apiBodyData.set(true); return; }
    } catch { /* no local database: ask the server */ }
  }
  try {
    const rows = await api.get(`/api/wellness/fitbit/data?from=${from}&to=${to}&sources=federation`);
    apiBodyData.set(hasBodyRows(rows));
  } catch { /* offline or no server: keep what's known */ }
}
