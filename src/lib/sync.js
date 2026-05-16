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
  dbGetPendingChanges, dbMarkSynced, dbSetServerId,
  dbGetSyncMeta, dbSetSyncMeta,
  dbUpsertFromServer, dbUpsertDiaryFromServer, dbUpsertWellnessFromServer,
  dbPurgeSoftDeleted,
  dbGetPendingSettings, dbMarkSettingsSynced, dbUpsertSettingFromServer,
  dbUpsertWorkoutFromServer, dbUpsertActivityFromServer,
} from './db-native.js';
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
  const hasPending = pending.foods.length || pending.meals.length || pending.diary.length || activity.length || fasts.length || wellness.length || pendingSettings.length;
  if (!hasPending) return false;

  _dlog(`[sync] pushing: ${pending.foods.length} foods, ${pending.meals.length} meals, ${pending.diary.length} diary, ${activity.length} activity, ${fasts.length} fasts, ${wellness.length} wellness, ${pendingSettings.length} settings`);

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
      items: d.items,
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

  // Mark all as synced
  await dbMarkSynced('foods', pending.foods.map(f => f.id));
  await dbMarkSynced('meals', pending.meals.map(m => m.id));
  await dbMarkSynced('diary', pending.diary.map(d => d.id));
  await dbMarkSynced('activity_log', activity.map(a => a.id));
  await dbMarkSynced('fasts', fasts.map(f => f.id));
  await dbMarkSynced('wellness_data', wellness.map(w => w.id));
  if (pendingSettings.length) await dbMarkSettingsSynced(pendingSettings.map(s => s.key));

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

  if (!res.ok) throw new Error(`Pull failed: ${res.status}`);
  const data = await res.json();

  // Apply foods
  for (const f of (data.foods || [])) {
    await dbUpsertFromServer('foods', f);
  }

  // Apply meals
  for (const m of (data.meals || [])) {
    await dbUpsertFromServer('meals', m);
  }

  // Apply diary
  for (const d of (data.diary || [])) {
    await dbUpsertDiaryFromServer(d);
  }

  // Apply wellness data (pull-only, server-generated)
  for (const w of (data.wellness || [])) {
    await dbUpsertWellnessFromServer(w);
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
    await dbUpsertSettingFromServer(s);
    if (!s.deleted_at) {
      const { DB } = await import('./db.js');
      const val = typeof s.value === 'string' ? _parseJson(s.value) : s.value;
      settingsMod._applySetting(s.key, val);
    }
  }

  // Apply workouts from server
  for (const w of (data.workouts || [])) {
    await dbUpsertWorkoutFromServer(w);
  }

  // Apply activity entries from server
  for (const a of (data.activity || [])) {
    await dbUpsertActivityFromServer(a);
  }

  // Apply fasts (intermittent-fasting tracker) from server
  const { dbUpsertFastFromServer } = await import('./db-native.js');
  for (const f of (data.fasts || [])) {
    await dbUpsertFastFromServer(f);
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
    syncState.update(s => ({ ...s, syncing: false, phase: '', progress: '', lastSync: now, online: true }));
    // Notify the app that sync completed — pages should refresh data
    window.dispatchEvent(new CustomEvent('nt:sync-complete'));
  } catch (e) {
    console.error('[sync] error:', e);
    syncState.update(s => ({ ...s, syncing: false, phase: '', progress: '', error: e.message }));
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
