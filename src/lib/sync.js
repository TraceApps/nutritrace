/**
 * sync.js — Differential sync engine for the Android app.
 *
 * Pushes local pending changes to the server, then pulls server changes.
 * Push first → pull second (so server has client's latest before responding).
 *
 * Uses server_time from pull response as last_sync_at (avoids clock skew).
 */

import { getServerUrl, getAuthToken, loadImageMap, apiUrl } from './platform.js';

// Verbose sync logs are gated on dev OR opt-in verbose mode
// (Settings → Diagnostics → Verbose diagnostic logging).
const _dlog = import.meta.env.DEV
  ? console.log
  : (...a) => { try { if (localStorage.getItem('nt:verboseLogging') === '1') console.log(...a); } catch {} };
import {
  dbGetPendingChanges, dbMarkSynced, dbMarkWellnessSynced, dbSetServerId,
  dbGetSyncMeta, dbSetSyncMeta,
  dbUpsertFromServer, dbUpsertDiaryFromServer, dbUpsertWellnessFromServer,
  dbPurgeSoftDeleted,
  dbGetPendingSettings, dbMarkSettingsSynced, dbUpsertSettingFromServer,
  dbUpsertWorkoutFromServer, dbUpsertActivityFromServer,
  dbGetPendingWorkouts, dbSetWorkoutServerId,
} from './db-native.js';
import { stripInlineDiaryImages } from './diary-payload.js';
import { writable } from 'svelte/store';

/** Sync state — reactive store for UI */
export const syncState = writable({
  syncing: false,
  phase: '',     // 'pushing' | 'pulling' | 'images' | ''
  progress: '',  // human-readable progress text
  lastSync: null,
  error: null,
  online: true,
});

let _syncing = false;

function _parseJson(val) {
  if (val == null) return null;
  if (typeof val !== 'string') return val;
  try { return JSON.parse(val); } catch { return val; }
}

function _headers() {
  const h = { 'Content-Type': 'application/json' };
  const token = getAuthToken();
  if (token) h['Authorization'] = `Bearer ${token}`;
  return h;
}

/**
 * Handle a 401 from any sync endpoint by clearing local auth state and
 * forcing App.svelte's reactive gate to send the user to Login.
 *
 * Without this, an expired JWT (default session is 720 hours / 30 days,
 * see server/middleware/auth.js#signToken) or a rotated server-side
 * JWT_SECRET would have sync print "Push/Pull failed: 401" forever on
 * every retry — the token stays in localStorage but is no longer
 * accepted, and nothing in the sync loop ever notices the loop is
 * unwinnable. Reported by user 2026-06-09.
 *
 * Mirrors the 401 handling already present in
 * stores/auth.js#_refreshAuthFromServer for the /api/auth/me endpoint.
 */
async function _handleSyncAuthError() {
  console.warn('[sync] received 401 — clearing local auth so the user can re-sign-in');
  try {
    const { setAuthToken } = await import('./platform.js');
    setAuthToken(null);
  } catch {}
  try { localStorage.removeItem('wl:userId'); } catch {}
  try { localStorage.removeItem('nt:cachedUser'); } catch {}
  try { localStorage.removeItem('nt:csrf'); } catch {}
  // Also wipe the biometric-saved JWT. It's a SEPARATE localStorage key
  // (nt:biometric:token) that survives the regular auth-token clear,
  // and Login.svelte#biometricLogin retrieves it then setAuthToken's it
  // back into the regular slot. If we don't wipe it on 401, the user
  // taps biometric → it fires correctly → restores the stale JWT →
  // /me 401s silently → bounce back to Login. Looks like "biometric
  // does nothing." Reported 2026-06-09.
  try {
    const { clearSavedToken } = await import('./biometric.js');
    await clearSavedToken();
  } catch {}
  try {
    const { currentUser } = await import('../stores/auth.js');
    currentUser.set(null);
  } catch {}
}

function _baseUrl() {
  // Returns empty string for PWA (so apiUrl() in callers picks up basePath
  // via the standard helper) or the server URL for native server-connected
  // mode. Callers wrap their path through apiUrl() for consistency.
  return getServerUrl() || '';
}

/** Check if the server is reachable */
let _lastOfflineAt = 0;
export async function checkOnline() {
  // If we went offline recently, skip the network check for 15s to avoid slow timeouts
  if (_lastOfflineAt && Date.now() - _lastOfflineAt < 15000) {
    return false;
  }
  try {
    const res = await fetch(apiUrl('/api/health'), {
      headers: _headers(),
      signal: AbortSignal.timeout(3000),
    });
    const online = res.ok;
    if (!online) _lastOfflineAt = Date.now();
    else _lastOfflineAt = 0;
    syncState.update(s => ({ ...s, online }));
    return online;
  } catch {
    _lastOfflineAt = Date.now();
    syncState.update(s => ({ ...s, online: false }));
    return false;
  }
}

/** Push local pending changes to the server. Returns true if anything was pushed. */
async function pushChanges() {
  const pending = await dbGetPendingChanges();
  const pendingSettings = await dbGetPendingSettings();
  const activity = pending.activity || [];
  const fasts    = pending.fasts || [];
  const wellness = pending.wellness || [];
  // Pending workouts: rows written locally (from Health Connect
  // ExerciseSession) that don't have a server_id yet. The rule is
  // `server_id IS NULL` — see dbGetPendingWorkouts. #91.
  const workouts = await dbGetPendingWorkouts();
  const hasPending = pending.foods.length || pending.meals.length || pending.diary.length || activity.length || fasts.length || wellness.length || workouts.length || pendingSettings.length;
  if (!hasPending) return false;

  _dlog(`[sync] pushing: ${pending.foods.length} foods, ${pending.meals.length} meals, ${pending.diary.length} diary, ${activity.length} activity, ${fasts.length} fasts, ${wellness.length} wellness, ${workouts.length} workouts, ${pendingSettings.length} settings`);

  // Build push payload with client_id and server_id
  const payload = {
    foods: pending.foods.map(f => ({
      client_id: f.id,
      server_id: f.server_id || null,
      name: f.name, brand: f.brand,
      nutrition: f.nutrition, portion: f.portion, unit: f.unit,
      img_url: f.img_url || f.imgUrl, notes: f.notes,
      category: (f.categories && f.categories[0]) || f.category,
      barcode: f.barcode,
      favorite: f.favorite || 0,
      usage_count: f.usage_count || 0,
      last_used_at: f.last_used_at || null,
      // Issues #69 + #70: OFF unit metadata round-trip. Null on rows that
      // pre-date the migration; server tolerates missing keys for clients
      // that haven't updated yet.
      nutrition_basis: f.nutrition_basis || null,
      alt_units: f.alt_units || null,
      density_g_ml: f.density_g_ml != null ? Number(f.density_g_ml) : null,
      updated_at: f.updated_at,
      deleted_at: f.deleted_at || null,
    })),
    meals: pending.meals.map(m => ({
      client_id: m.id,
      server_id: m.server_id || null,
      name: m.name, nutrition: m.nutrition, items: m.items,
      img_url: m.img_url || m.imgUrl, notes: m.notes,
      is_recipe: m.is_recipe,
      portion: m.portion, unit: m.unit,
      favorite: m.favorite || 0,
      usage_count: m.usage_count || 0,
      last_used_at: m.last_used_at || null,
      updated_at: m.updated_at,
      deleted_at: m.deleted_at || null,
    })),
    diary: pending.diary.map(d => ({
      client_id: d.id,
      server_id: d.server_id || null,
      date: d.date,
      // Native diary rows can still contain the base64 image copied from a
      // newly-created food. The food itself carries the canonical image; do
      // not replicate it into the diary snapshot or the sync request.
      items: stripInlineDiaryImages(d.items),
      body_stats: d.body_stats,
      water: d.water,
      updated_at: d.updated_at,
      deleted_at: d.deleted_at || null,
    })),
    activity: activity.map(a => ({
      client_id: a.id,
      server_id: a.server_id || null,
      date: a.date,
      name: a.name,
      kcal: a.kcal,
      duration_min: a.duration_min,
      distance: a.distance,
      source: a.source || 'manual_form',
      met: a.met ?? null,
      is_template: a.is_template ? 1 : 0,
      updated_at: a.updated_at,
      deleted_at: a.deleted_at || null,
    })),
    fasts: fasts.map(f => ({
      client_id: f.id,
      server_id: f.server_id || null,
      start_at: f.start_at,
      end_at: f.end_at || null,
      goal_hours: f.goal_hours,
      notes: f.notes || null,
      updated_at: f.updated_at,
      deleted_at: f.deleted_at || null,
    })),
    // Wellness rows from Health Connect (and any future native-only source).
    // Keyed by (date, source, metric_type) on the server, so no client_id
    // round-trip is needed — server just upserts on conflict.
    wellness: wellness.map(w => ({
      date: w.date,
      source: w.source,
      metric_type: w.metric_type,
      value: w.value,
      metadata: typeof w.metadata === 'string' ? w.metadata : JSON.stringify(w.metadata || {}),
    })),
    settings: pendingSettings.map(s => ({
      key: s.key,
      value: _parseJson(s.value),
      updated_at: s.updated_at,
      deleted_at: s.deleted_at || null,
    })),
    // Locally-authored workouts (Health Connect ExerciseSession). Server
    // upserts on (user_id, source, source_id); client_id is used only to
    // stitch the server_id back to the local row via the push result. #91.
    workouts: workouts.map(w => ({
      client_id: w.id,
      source: w.source,
      source_id: String(w.source_id),
      date: w.date,
      activity_type: w.activity_type || null,
      activity_name: w.activity_name || null,
      start_time: w.start_time || null,
      duration_ms: w.duration_ms ?? null,
      distance_km: w.distance_km ?? null,
      calories: w.calories ?? null,
      avg_hr: w.avg_hr ?? null,
      max_hr: w.max_hr ?? null,
      steps: w.steps ?? null,
      has_gps: w.has_gps ? 1 : 0,
    })),
  };

  _dlog(`[sync] push payload: ${payload.foods.length} foods, ${payload.meals.length} meals, ${payload.diary.length} diary, ${payload.activity.length} activity, ${payload.settings.length} settings`);

  const res = await fetch(apiUrl('/api/sync/push'), {
    method: 'POST',
    headers: _headers(),
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    console.error(`[sync] push failed: ${res.status} ${errText}`);
    if (res.status === 401) await _handleSyncAuthError();
    throw new Error(`Push failed: ${res.status}`);
  }
  const result = await res.json();
  _dlog(`[sync] push result: ${result.foods?.length || 0} foods, ${result.meals?.length || 0} meals, ${result.diary?.length || 0} diary`);

  // Update server_id mappings for newly created records
  for (const f of (result.foods || [])) {
    if (f.client_id && f.server_id) {
      await dbSetServerId('foods', f.client_id, f.server_id);
    }
  }
  for (const m of (result.meals || [])) {
    if (m.client_id && m.server_id) {
      await dbSetServerId('meals', m.client_id, m.server_id);
    }
  }
  for (const d of (result.diary || [])) {
    if (d.client_id && d.server_id) {
      await dbSetServerId('diary', d.client_id, d.server_id);
    }
  }
  for (const a of (result.activity || [])) {
    if (a.client_id && a.server_id) {
      await dbSetServerId('activity_log', a.client_id, a.server_id);
    }
  }
  for (const f of (result.fasts || [])) {
    if (f.client_id && f.server_id) {
      await dbSetServerId('fasts', f.client_id, f.server_id);
    }
  }
  // Workouts key on (source, source_id) not client_id: the server upserts
  // by that composite so the same row survives a re-push. We use client_id
  // only to lift the server_id back into the right local row.
  for (const w of (result.workouts || [])) {
    if (w.server_id) {
      const localRow = workouts.find(x => x.id === w.client_id);
      if (localRow) {
        await dbSetWorkoutServerId(localRow.source, localRow.source_id, w.server_id);
      }
    }
  }

  // Mark all as synced. Pass {id, updated_at} (or {key, updated_at} for
  // settings) so dbMarkSynced can detect rows that were edited again
  // during the push round-trip and leave them pending for the next sync.
  // Without this guard, mid-flight edits get silently demoted from
  // 'pending' to 'synced' and then overwritten by the subsequent pull.
  await dbMarkSynced('foods',        pending.foods.map(f => ({ id: f.id, updated_at: f.updated_at })));
  await dbMarkSynced('meals',        pending.meals.map(m => ({ id: m.id, updated_at: m.updated_at })));
  await dbMarkSynced('diary',        pending.diary.map(d => ({ id: d.id, updated_at: d.updated_at })));
  await dbMarkSynced('activity_log', activity.map(a => ({ id: a.id, updated_at: a.updated_at })));
  await dbMarkSynced('fasts',        fasts.map(f => ({ id: f.id, updated_at: f.updated_at })));
  // wellness_data has no updated_at column, so it can't go through
  // dbMarkSynced's id+updated_at gate — that path throws SQLITE_ERROR
  // and aborts the whole push loop before pullChanges runs. Use the
  // dedicated id-only helper. See dbMarkWellnessSynced doc + #89.
  await dbMarkWellnessSynced(wellness.map(w => w.id));
  if (pendingSettings.length) {
    await dbMarkSettingsSynced(pendingSettings.map(s => ({ key: s.key, updated_at: s.updated_at })));
  }

  // Purge soft-deleted records that have been confirmed pushed
  await dbPurgeSoftDeleted('foods');
  await dbPurgeSoftDeleted('meals');
  await dbPurgeSoftDeleted('diary');
  await dbPurgeSoftDeleted('activity_log');
  await dbPurgeSoftDeleted('fasts');

  _dlog('[sync] push complete');
  return true;
}

/** Pull server changes since last sync */
async function pullChanges() {
  const lastSync = await dbGetSyncMeta('last_sync_at') || '1970-01-01T00:00:00.000Z';

  _dlog(`[sync] pulling since ${lastSync}`);

  const res = await fetch(apiUrl(`/api/sync/pull?since=${encodeURIComponent(lastSync)}`), {
    headers: _headers(),
  });

  if (!res.ok) {
    if (res.status === 401) await _handleSyncAuthError();
    throw new Error(`Pull failed: ${res.status}`);
  }
  const data = await res.json();

  // Per-item try/catch so a single malformed server row can't abort the
  // whole pull loop. A stuck row will log a warning + a stable identifier
  // and continue; the rest of the pull still lands. Without this guard,
  // one bad row would silently block every downstream table (settings,
  // workouts, activity, fasts, chat) from ever reaching the phone,
  // reproducing the #89-style symptom on a different data trigger.
  const _pullErr = (kind, item, e) => console.warn(
    `[sync] pull skip ${kind}`, item?.id ?? item?.date ?? item?.key ?? '(no-id)',
    e?.message || String(e)
  );

  // Apply foods
  for (const f of (data.foods || [])) {
    try { await dbUpsertFromServer('foods', f); }
    catch (e) { _pullErr('foods', f, e); }
  }

  // Apply meals
  for (const m of (data.meals || [])) {
    try { await dbUpsertFromServer('meals', m); }
    catch (e) { _pullErr('meals', m, e); }
  }

  // Apply diary
  for (const d of (data.diary || [])) {
    try { await dbUpsertDiaryFromServer(d); }
    catch (e) { _pullErr('diary', d, e); }
  }

  // Apply wellness data (pull-only, server-generated)
  for (const w of (data.wellness || [])) {
    try { await dbUpsertWellnessFromServer(w); }
    catch (e) { _pullErr('wellness', w, e); }
  }

  // Apply settings from server → local SQLite + localStorage
  // Skip settings that have pending local changes or were recently changed locally
  const pulledSettings = data.settings || [];
  const localPendingKeys = new Set((await dbGetPendingSettings()).map(s => s.key));
  const settingsMod = await import('../stores/settings.js');
  for (const s of pulledSettings) {
    if (localPendingKeys.has(s.key) || settingsMod.isRecentlyChanged(s.key)) {
      _dlog(`[sync] skip pulled setting ${s.key} — local change takes priority`);
      continue;
    }
    try {
      await dbUpsertSettingFromServer(s);
      if (!s.deleted_at) {
        const { DB } = await import('./db.js');
        const val = typeof s.value === 'string' ? _parseJson(s.value) : s.value;
        settingsMod._applySetting(s.key, val);
      }
    } catch (e) { _pullErr('settings', s, e); }
  }

  // Apply workouts from server
  for (const w of (data.workouts || [])) {
    try { await dbUpsertWorkoutFromServer(w); }
    catch (e) { _pullErr('workouts', w, e); }
  }

  // Apply activity entries from server
  for (const a of (data.activity || [])) {
    try { await dbUpsertActivityFromServer(a); }
    catch (e) { _pullErr('activity', a, e); }
  }

  // Apply fasts (intermittent-fasting tracker) from server
  const { dbUpsertFastFromServer } = await import('./db-native.js');
  for (const f of (data.fasts || [])) {
    try { await dbUpsertFastFromServer(f); }
    catch (e) { _pullErr('fasts', f, e); }
  }

  // Chat history — pull only, notify the AI Assistant component via event
  const newChat = data.chat_history || [];
  if (newChat.length && typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('nt:chat-updated', { detail: { messages: newChat } }));
  }

  // Save server time as last_sync_at
  if (data.server_time) {
    await dbSetSyncMeta('last_sync_at', data.server_time);
  }

  const totalChanges = (data.foods?.length || 0) + (data.meals?.length || 0) + (data.diary?.length || 0) + (data.activity?.length || 0) + (data.wellness?.length || 0) + pulledSettings.length + (data.workouts?.length || 0) + newChat.length;
  _dlog(`[sync] pull complete: ${data.foods?.length || 0} foods, ${data.meals?.length || 0} meals, ${data.diary?.length || 0} diary, ${data.activity?.length || 0} activity, ${data.wellness?.length || 0} wellness, ${pulledSettings.length} settings, ${data.workouts?.length || 0} workouts, ${newChat.length} chat`);
  return totalChanges > 0;
}

/**
 * Disaster-recovery push: marks every locally-cached row as pending and
 * clears stale server_id refs (which are no longer valid if the server
 * lost rows), then runs a full sync. Re-creates everything on the server
 * from the device's local SQLite mirror.
 *
 * Native server-mode only. PWA has no local mirror; native standalone
 * has no server to push to.
 *
 * Returns { pushed: { foods, meals, diary, activity, settings } } counts
 * of rows that were marked pending (i.e. rows that should now be on the
 * server after the sync completes).
 */
export async function pushAllFromDevice() {
  if (typeof window === 'undefined') throw new Error('Browser only');
  const { isNative, getServerUrl } = await import('./platform.js');
  if (!isNative) throw new Error('This action only works in the native app.');
  if (!getServerUrl()) throw new Error('Connect to a server first.');
  const { getDb } = await import('./db-native.js');
  const db = await getDb();

  // Clear stale server_id refs (server may have lost rows; their old IDs
  // are meaningless) and mark every row pending. user_settings doesn't
  // carry server_id so just mark pending.
  await db.execute(`
    UPDATE foods         SET sync_status='pending', server_id=NULL WHERE deleted_at IS NULL;
    UPDATE meals         SET sync_status='pending', server_id=NULL WHERE deleted_at IS NULL;
    UPDATE diary         SET sync_status='pending', server_id=NULL WHERE deleted_at IS NULL;
    UPDATE activity_log  SET sync_status='pending', server_id=NULL WHERE deleted_at IS NULL;
    UPDATE user_settings SET sync_status='pending'                  WHERE deleted_at IS NULL;
  `);

  // Count what we just queued so the UI can confirm afterwards.
  const counts = {};
  for (const t of ['foods', 'meals', 'diary', 'activity_log', 'user_settings']) {
    const r = await db.query(`SELECT COUNT(*) AS n FROM ${t} WHERE sync_status='pending' AND deleted_at IS NULL`);
    counts[t] = r?.values?.[0]?.n || 0;
  }

  // Trigger a full sync — this pushes everything we just marked pending.
  // Run non-silent so the user sees the sync bar progressing.
  await fullSync(false);
  return { pushed: counts };
}

/** Full sync — push then pull then cache images
 * @param {boolean} silent - If true, don't show sync bar unless there are actual changes
 */
export async function fullSync(silent = false) {
  if (_syncing) return;
  if (!getAuthToken()) return;
  _syncing = true;
  if (!silent) {
    syncState.update(s => ({ ...s, syncing: true, error: null, phase: 'pushing', progress: 'Pushing local changes…' }));
  }

  try {
    const online = await checkOnline();
    if (!online) {
      syncState.update(s => ({ ...s, syncing: false, phase: '' }));
      _syncing = false;
      return;
    }

    // Read Health Connect data (if enabled) before push so it's included
    try {
      const { DB } = await import('./db.js');
      if (DB.getSetting('healthConnectEnabled', false)) {
        if (!silent) syncState.update(s => ({ ...s, phase: 'health', progress: 'Reading Health Connect…' }));
        const { syncHealthConnect } = await import('./health-connect.js');
        const today = new Date().toLocaleDateString('sv-SE');
        await syncHealthConnect(today);
      }
    } catch (e) {
      console.warn('[sync] Health Connect read failed:', e.message);
    }

    if (!silent) syncState.update(s => ({ ...s, phase: 'pushing', progress: 'Pushing local changes…' }));
    const pushed = await pushChanges();

    if (!silent) syncState.update(s => ({ ...s, phase: 'pulling', progress: 'Downloading data…' }));
    const pulled = await pullChanges();


    const hadChanges = pushed || pulled;

    // Show sync bar for silent syncs only if there were actual changes
    if (silent && hadChanges) {
      syncState.update(s => ({ ...s, syncing: true, progress: 'Synced changes' }));
    }

    // Cache images for offline use (only if changes or non-silent)
    if (!silent || hadChanges) {
      syncState.update(s => ({ ...s, phase: 'images', progress: 'Caching images…' }));
      try {
        const { cacheAllImages } = await import('./image-cache.js');
        await cacheAllImages((done, total) => {
          if (total > 0) {
            syncState.update(s => ({ ...s, progress: `Caching images… ${done}/${total}` }));
          }
        });
        await loadImageMap();
      } catch (e) {
        console.warn('[sync] Image caching failed:', e.message);
      }
    }

    // Check wellness goals after sync (steps, sleep, etc.)
    try {
      const { dbGetWellnessByDate } = await import('./db-native.js');
      const today = new Date().toLocaleDateString('sv-SE');
      const todayData = await dbGetWellnessByDate(today);
      const metrics = todayData[today] || {};
      const { checkStepGoal, checkGoals } = await import('./notifications.js');
      const { DB } = await import('./db.js');
      const goals = DB.getSetting('goals', {});

      // Step goal
      const stepGoal = goals.steps?.min || goals.steps?.max;
      if (metrics.steps && stepGoal) await checkStepGoal(metrics.steps, stepGoal);

      // All wellness goals (sleep, active minutes, distance, etc.)
      // Steps excluded — already handled by checkStepGoal above
      const wellnessValues = {};
      if (metrics.sleep_duration_min) wellnessValues.sleep_duration_min = metrics.sleep_duration_min;
      if (metrics.active_minutes) wellnessValues.active_minutes = metrics.active_minutes;
      if (metrics.distance_km) wellnessValues.distance_km = metrics.distance_km;
      if (metrics.calories_out) wellnessValues.calories_out = metrics.calories_out;
      if (Object.keys(wellnessValues).length) await checkGoals(goals, wellnessValues);
    } catch {}

    const now = new Date().toISOString();
    // Clear `error` explicitly. Without this an old sync failure (e.g. the
    // 401 that just triggered a forced re-login) sticks in syncState even
    // after a clean sync succeeded, so the UI keeps showing "Sync error"
    // and "not connected" indicators forever. Reported by user 2026-06-09
    // after the biometric expired-stash fix landed them back on Login,
    // they re-signed in, sync succeeded, but the error banner stayed.
    syncState.update(s => ({ ...s, syncing: false, phase: '', progress: '', lastSync: now, online: true, error: null }));
    // Notify the app that sync completed — pages should refresh data
    window.dispatchEvent(new CustomEvent('nt:sync-complete'));
  } catch (e) {
    // Log e.message + e.code + e.stack so future issue reports don't come
    // back with just `Error` from the Capacitor SQLite bridge — the plugin
    // strips useful details before propagating, and 'Error' alone in a bug
    // report is unactionable. #89 spent a full audit pass narrowing down
    // exactly which push step was throwing because we didn't have a message.
    const { get } = await import('svelte/store');
    const phase = get(syncState)?.phase || '';
    console.error('[sync] error:', e?.message || String(e), '| code:', e?.code || '(none)', '| phase:', phase, '|', e?.stack || '');
    syncState.update(s => ({ ...s, syncing: false, phase: '', progress: '', error: e.message || 'Sync failed (see console)' }));
    // Notify on sync failure
    try {
      const { notify } = await import('./notifications.js');
      await notify('notifSyncFailures', 'Sync Failed', e.message || 'Could not sync with server');
    } catch {}
  } finally {
    _syncing = false;
  }
}

/** Start network monitoring — auto-sync when coming back online */
export function startNetworkMonitor() {
  // Listen for browser online/offline events
  window.addEventListener('online', () => {
    _dlog('[sync] Network online detected');
    fullSync();
  });
  window.addEventListener('offline', () => {
    _dlog('[sync] Network offline detected');
    syncState.update(s => ({ ...s, online: false }));
  });

  // Periodic health check every 30 seconds (window online/offline is unreliable on Android)
  setInterval(async () => {
    if (_syncing) return;
    const wasOnline = await new Promise(resolve => {
      syncState.subscribe(s => resolve(s.online))();
    });
    const nowOnline = await checkOnline();
    if (nowOnline && !wasOnline) {
      _dlog('[sync] Server reachable again — syncing');
      fullSync();
    }
  }, 30000);
}

/** Quick push — debounced, for after local writes */
let _pushTimeout = null;
export function schedulePush() {
  clearTimeout(_pushTimeout);
  _pushTimeout = setTimeout(async () => {
    if (_syncing) return;
    try {
      const online = await checkOnline();
      if (online) await pushChanges();
    } catch (e) {
      console.error('[sync] scheduled push failed:', e);
    }
  }, 3000);
}
