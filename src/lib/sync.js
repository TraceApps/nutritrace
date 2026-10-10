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
  dbGetPendingDiaryTombstones, dbMarkTombstonesSynced, dbApplyServerTombstones,
  dbLinkDiaryItems, dbApplyServerDeletions, dbGetCompletionOps, dbDeleteCompletionOp,
  dbApplyServerWinner, dbSetClockOffset, dbInstallId, createKeyOf,
} from './db-native.js';
import { localDataIsThisAccount, serverKeepsNotes, accountGeneration } from './local-account.js';
import { get, writable } from 'svelte/store';

/** Sync state — reactive store for UI */
export const syncState = writable({
  syncing: false,
  phase: '',     // 'pushing' | 'pulling' | 'images' | ''
  progress: '',  // human-readable progress text
  lastSync: null,
  error: null,
  online: true,
  connectionIssue: null,
  showErrorBanner: false,
});

let _syncing = false;

function _parseJson(val) {
  if (val == null) return null;
  if (typeof val !== 'string') return val;
  try { return JSON.parse(val); } catch { return val; }
}

// `token`: the session a push or pull started with. Read once per run, so
// signing out (or in as someone else) partway through never sends the rest
// of one account's rows with another account's session.
function _headers(token = getAuthToken()) {
  const h = { 'Content-Type': 'application/json' };
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
  try {
    const { forgetServerCookies } = await import('./local-account.js');
    await forgetServerCookies();
  } catch {}
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
let _lastOnlineAt = 0;
let _onlineCheckPromise = null;
const OFFLINE_RETRY_DELAY_MS = 15000;
const ONLINE_CHECK_CACHE_MS = 15000;

/** True while the health-check circuit breaker is suppressing redundant requests. */
export function isServerKnownUnavailable() {
  return !!_lastOfflineAt && Date.now() - _lastOfflineAt < OFFLINE_RETRY_DELAY_MS;
}

async function _networkSnapshot() {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return { connected: false, connectionType: 'none' };
  }
  try {
    const { Network } = await import('@capacitor/network');
    return await Network.getStatus();
  } catch {
    return {
      connected: typeof navigator === 'undefined' ? true : navigator.onLine !== false,
      connectionType: 'unknown',
    };
  }
}

function _serverHost() {
  try { return new URL(getServerUrl()).hostname; }
  catch { return getServerUrl() || 'server'; }
}

function _connectionIssue({ network, error = null, status = null }) {
  const noNetwork = !network?.connected || network?.connectionType === 'none';
  return {
    kind: noNetwork ? 'no_network' : status ? 'server_error' : 'server_unreachable',
    host: _serverHost(),
    connectionType: network?.connectionType || 'unknown',
    status,
    detail: error?.message || null,
    at: new Date().toISOString(),
  };
}

function _publishConnectionIssue(issue, showErrorBanner = false) {
  syncState.update(s => ({
    ...s,
    online: false,
    connectionIssue: issue,
    // Automatic checks update compact status only. Once explicitly requested,
    // detailed feedback remains until dismissal or a successful connection.
    ...(showErrorBanner ? { showErrorBanner: true } : {}),
  }));
}

async function _probeServer(showErrorBanner = false) {
  const _probeStartedAt = Date.now();
  try {
    const res = await fetch(apiUrl('/api/health'), {
      headers: _headers(),
      signal: AbortSignal.timeout(3000),
    });
    const online = res.ok;
    if (!online) {
      _lastOnlineAt = 0;
      _lastOfflineAt = Date.now();
      const network = await _networkSnapshot();
      const issue = _connectionIssue({ network, status: res.status });
      console.warn(`[sync] server health check failed: host=${issue.host} network=${issue.connectionType} status=${res.status}`);
      _publishConnectionIssue(issue, showErrorBanner);
    } else {
      _lastOfflineAt = 0;
      _lastOnlineAt = Date.now();
      syncState.update(s => ({ ...s, online: true, connectionIssue: null, showErrorBanner: false }));
    }
    return online;
  } catch (error) {
    _lastOnlineAt = 0;
    _lastOfflineAt = Date.now();
    const network = await _networkSnapshot();
    const issue = _connectionIssue({ network, error });
    // `name` is the field that tells these apart: a deadline we set reports
    // TimeoutError/"signal timed out", while a DNS, TLS or CORS failure reports
    // TypeError/"Failed to fetch" whatever the real cause. The elapsed time
    // separates a fast refusal from a request that hung until the OS killed it.
    console.warn(`[sync] server unreachable: host=${issue.host} network=${issue.connectionType} after=${Date.now() - _probeStartedAt}ms name=${error?.name || 'Error'} error=${error?.message || String(error)}`);
    _publishConnectionIssue(issue, showErrorBanner);
    return false;
  }
}

export async function checkOnline(force = false, showErrorBanner = false) {
  // Reuse one in-flight probe so initial sync and the burst of debounced
  // settings writes do not all test the same unreachable server in parallel.
  if (!force && isServerKnownUnavailable()) return false;
  if (!force && _lastOnlineAt && Date.now() - _lastOnlineAt < ONLINE_CHECK_CACHE_MS) {
    return true;
  }
  if (!force && _onlineCheckPromise) return _onlineCheckPromise;
  if (force) return _probeServer(showErrorBanner);

  _onlineCheckPromise = _probeServer(showErrorBanner);
  try {
    return await _onlineCheckPromise;
  } finally {
    _onlineCheckPromise = null;
  }
}

// Day and meal completion marks, sent through the calls the app makes
// online, oldest first. The diary push leaves marks out on purpose, so a
// mark set or cleared offline used to be undone by the next pull. Every
// send goes through this one queue (the app's own taps included), one
// request at a time, so a mark and its undo can't arrive out of order or
// twice. A mark the server refuses outright (4xx) is dropped; anything
// else (offline, 5xx, 408, 429) stays for the next try.
let _opsFlush = null;
let _opsAgain = false;
export function flushCompletionOps({ token = getAuthToken(), signal = null, gen = accountGeneration() } = {}) {
  if (_opsFlush) { _opsAgain = true; return _opsFlush; }
  const run = _startRun(signal);
  _opsFlush = (async () => {
    try {
      let sent = false;
      do {
        _opsAgain = false;
        if (await _sendCompletionOps(token, run.signal, gen)) sent = true;
      } while (_opsAgain && gen === accountGeneration());
      return sent;
    } finally {
      _opsFlush = null;
    }
  })();
  _endRun(run, _opsFlush);
  return _opsFlush;
}
const _RETRY_STATUS = new Set([408, 425, 429]);
// One request's deadline, cut short too when `signal` aborts (sign-out).
function _deadline(signal, ms = 30000) {
  const t = AbortSignal.timeout(ms);
  if (!signal) return t;
  return typeof AbortSignal.any === 'function' ? AbortSignal.any([t, signal]) : signal;
}

async function _sendCompletionOps(token, signal, gen) {
  const live = () => gen === accountGeneration();
  if (!getServerUrl() || !token || !live()) return false;
  if (!(await localDataIsThisAccount(token))) return false;
  const ops = await dbGetCompletionOps();
  if (!ops.length) return false;
  for (const op of ops) {
    if (!live()) return true;
    const path = op.slot == null
      ? `/api/diary/${op.date}/completion`
      : `/api/diary/${op.date}/meal-completion`;
    // `at`: when the mark was made here, so an older one can't undo a
    // newer one made elsewhere (routes/diary.js).
    const when = op.at ? { at: op.at, client_now: new Date().toISOString() } : {};
    const body = op.slot == null
      ? { completed: !!op.completed, ...when }
      : { slot: Number(op.slot), completed: !!op.completed, ...when };
    const res = await fetch(apiUrl(path), {
      method: 'PUT',
      headers: _headers(token),
      body: JSON.stringify(body),
      signal: _deadline(signal),
    });
    if (res.status === 401) { await _handleSyncAuthError(); throw new Error('Push failed: 401'); }
    if (!res.ok && (res.status >= 500 || _RETRY_STATUS.has(res.status))) throw new Error(`Push failed: ${res.status}`);
    if (!live()) return true;
    await dbDeleteCompletionOp(op.id);
  }
  return true;
}

/** Push local pending changes to the server. Returns true if anything was pushed. */
async function pushChanges({ token = getAuthToken(), signal = null, gen = accountGeneration() } = {}) {
  // False once another account's sign-in has begun (lib/local-account.js
  // accountGeneration): nothing more is written for this push after that.
  const live = () => gen === accountGeneration();
  // Another account's data still on the phone (a sign-in that hasn't been
  // through prepareLocalAccount yet) never goes up under this one.
  if (!(await localDataIsThisAccount(token))) return false;
  // Completion marks first, on their own: a mark the server can't take
  // right now stays queued and doesn't hold up the rest.
  let opsPushed = false;
  try { opsPushed = await flushCompletionOps({ token, signal, gen }); }
  catch (e) {
    if (String(e?.message).includes('401')) throw e;
    console.warn('[sync] completion marks wait for the next sync:', e?.message || e);
  }
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
  // Option C: pending per-uuid deletions must ride along with the diary
  // rows in the same push so the server's merge treats them as explicit
  // tombstones. Load once, index by date, consume below.
  const _pendingDiaryTombstones = await dbGetPendingDiaryTombstones();
  const _hasPendingTombstones = Object.keys(_pendingDiaryTombstones).length > 0;

  if (!hasPending && !_hasPendingTombstones) return opsPushed;

  _dlog(`[sync] pushing: ${pending.foods.length} foods, ${pending.meals.length} meals, ${pending.diary.length} diary, ${activity.length} activity, ${fasts.length} fasts, ${wellness.length} wellness, ${workouts.length} workouts, ${pendingSettings.length} settings, tombstones=${Object.keys(_pendingDiaryTombstones).length}`);

  const keepsNotes = await serverKeepsNotes().catch(() => false);
  // A row the server hasn't seen goes with a stable key (this install, its
  // own id here and when it was made), so a retry or a lost answer never
  // makes it twice (db-native.js createKeyOf).
  const install = await dbInstallId();
  const createKey = (table, r) => (r.server_id ? undefined : createKeyOf(install, table, r));
  // Build push payload with client_id and server_id
  const payload = {
    foods: pending.foods.map(f => ({
      client_id: f.id,
      server_id: f.server_id || null,
      client_key: createKey('foods', f),
      name: f.name, brand: f.brand,
      nutrition: f.nutrition, portion: f.portion, unit: f.unit,
      img_url: f.img_url || f.imgUrl, notes: f.notes,
      category: (f.categories && f.categories[0]) || f.category,
      barcode: f.barcode,
      // Where a food came from (CookTrace's pantry): sent back as it is,
      // or the push wiped it.
      source_app: f.source_app || null,
      source_external_id: f.source_external_id || null,
      source_url: f.source_url || null,
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
      client_key: createKey('meals', m),
      name: m.name, nutrition: m.nutrition, items: m.items,
      img_url: m.img_url || m.imgUrl, notes: m.notes,
      is_recipe: m.is_recipe,
      portion: m.portion, unit: m.unit,
      servings: m.servings ?? null,
      favorite: m.favorite || 0,
      usage_count: m.usage_count || 0,
      last_used_at: m.last_used_at || null,
      updated_at: m.updated_at,
      deleted_at: m.deleted_at || null,
    })),
    diary: (() => {
      // Include every pending diary row plus any date that has only
      // pending tombstones and no other change (so the merge server-side
      // still gets the deleted_uuids). For tombstone-only dates we send
      // the row's current shape so the server merge is a no-op except
      // for applying the tombstones.
      const pendingDates = new Set(pending.diary.map(d => d.date));
      const tombstoneOnlyDates = Object.keys(_pendingDiaryTombstones)
        .filter(date => !pendingDates.has(date));
      const rows = pending.diary.map(d => ({
        client_id: d.id,
        server_id: d.server_id || null,
        date: d.date,
        items: d.items,
        body_stats: d.body_stats,
        water: d.water,
        // The day's note, only when it was edited here, with when: the
        // newer note wins on the server, a cleared one included. A note
        // this phone only pulled stays out, so its time (already on the
        // server's clock) is never set against this phone's clock again.
        // A server before sync_version 2 clears a note a push leaves out,
        // so it always gets the note here.
        ...((d.notes_dirty || !keepsNotes) ? { notes: d.notes || '', notes_updated_at: d.notes_updated_at || null } : {}),
        deleted_uuids: _pendingDiaryTombstones[d.date] || { items: [], water: [] },
        updated_at: d.updated_at,
        deleted_at: d.deleted_at || null,
      }));
      // Synthetic tombstone-only rows. We look them up from local DB
      // via dbGetDiaryDate later if needed; for now the client_id/server_id
      // resolution on the server side matches on (user_id, date) so we
      // only need the date + the deletions to make the merge fire.
      for (const date of tombstoneOnlyDates) {
        rows.push({
          client_id: null,
          server_id: null,
          date,
          items: [],
          body_stats: {},
          water: [],
          deleted_uuids: _pendingDiaryTombstones[date],
          updated_at: new Date().toISOString(),
          deleted_at: null,
        });
      }
      return rows;
    })(),
    activity: activity.map(a => ({
      client_id: a.id,
      server_id: a.server_id || null,
      client_key: createKey('activity_log', a),
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
      client_key: createKey('fasts', f),
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

  _dlog(`[sync] push payload: ${payload.foods.length} foods, ${payload.meals.length} meals, ${payload.diary.length} diary, ${payload.activity.length} activity, ${payload.fasts.length} fasts, ${payload.wellness.length} wellness, ${payload.workouts.length} workouts, ${payload.settings.length} settings`);

  // 30s ceiling. Without a signal, a wedged connection (proxy timeout,
  // dropped TCP, server GC pause) stalls the whole sync loop for the OS
  // TCP-retry window — verbose-log repros showed 10-19 minute holds that
  // blocked every subsequent pull-to-refresh because _syncing stays true
  // for the entire hang. 30s is generous enough for a full-library push
  // over a slow link and short enough that a genuinely dead connection
  // fails visibly.
  // This phone's clock right now: the server sets it against its own, so
  // a phone running slow or fast doesn't lose (or win) edits on time.
  payload.client_now = new Date().toISOString();
  if (!live()) return false;
  const sentAt = Date.now();
  const res = await fetch(apiUrl('/api/sync/push'), {
    method: 'POST',
    headers: _headers(token),
    body: JSON.stringify(payload),
    signal: _deadline(signal),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    console.error(`[sync] push failed: ${res.status} ${errText}`);
    if (res.status === 401) await _handleSyncAuthError();
    throw new Error(`Push failed: ${res.status}`);
  }
  const result = await res.json();
  _learnClock(result.server_time, sentAt, 'push');
  // Another account's sign-in finished while this was out and the phone's
  // copy is theirs now: these ids and marks belong to rows that are gone.
  if (!live() || !(await localDataIsThisAccount(token))) return true;
  _dlog(`[sync] push result: ${result.foods?.length || 0} foods, ${result.meals?.length || 0} meals, ${result.diary?.length || 0} diary`);

  // Update server_id mappings for newly created records
  // Diary items logged before their food or meal went up carry this
  // phone's id; they get the server's now (dbLinkDiaryItems, every push,
  // so one missed is linked next time).
  const created = [];
  const wasNew = (rows, id) => rows.some(r => r.id === id && !r.server_id);
  for (const f of (result.foods || [])) {
    if (f.client_id && f.server_id) {
      if (!live()) return true;
      await dbSetServerId('foods', f.client_id, f.server_id);
      if (wasNew(pending.foods, f.client_id)) created.push({ table: 'foods', localId: f.client_id, serverId: f.server_id });
    }
  }
  for (const m of (result.meals || [])) {
    if (m.client_id && m.server_id) {
      if (!live()) return true;
      await dbSetServerId('meals', m.client_id, m.server_id);
      if (wasNew(pending.meals, m.client_id)) created.push({ table: 'meals', localId: m.client_id, serverId: m.server_id });
    }
  }
  try { if (live()) await dbLinkDiaryItems(created, live); }
  catch (e) { console.warn('[sync] linking diary items waits for the next push:', e?.message || e); }
  for (const d of (result.diary || [])) {
    if (d.client_id && d.server_id) {
      if (!live()) return true;
      await dbSetServerId('diary', d.client_id, d.server_id);
    }
  }
  for (const a of (result.activity || [])) {
    if (a.client_id && a.server_id) {
      if (!live()) return true;
      await dbSetServerId('activity_log', a.client_id, a.server_id);
    }
  }
  for (const f of (result.fasts || [])) {
    if (f.client_id && f.server_id) {
      if (!live()) return true;
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
        if (!live()) return true;
        await dbSetWorkoutServerId(localRow.source, localRow.source_id, w.server_id);
      }
    }
  }

  // Mark all as synced. Pass {id, updated_at} (or {key, updated_at} for
  // settings) so dbMarkSynced can detect rows that were edited again
  // during the push round-trip and leave them pending for the next sync.
  // Without this guard, mid-flight edits get silently demoted from
  // 'pending' to 'synced' and then overwritten by the subsequent pull.
  await dbMarkSynced('foods',        pending.foods.map(f => ({ id: f.id, updated_at: f.updated_at })), live);
  await dbMarkSynced('meals',        pending.meals.map(m => ({ id: m.id, updated_at: m.updated_at })), live);
  await dbMarkSynced('diary',        pending.diary.map(d => ({ id: d.id, updated_at: d.updated_at })), live);
  // Option C: mark all pending tombstones we just pushed as synced so
  // they don't get resent on the next push cycle.
  {
    const triples = [];
    for (const [date, kinds] of Object.entries(_pendingDiaryTombstones)) {
      for (const uuid of (kinds.items || [])) triples.push({ date, kind: 'item',  uuid });
      for (const uuid of (kinds.water || [])) triples.push({ date, kind: 'water', uuid });
    }
    if (triples.length) await dbMarkTombstonesSynced(triples, live);
  }
  await dbMarkSynced('activity_log', activity.map(a => ({ id: a.id, updated_at: a.updated_at })), live);
  await dbMarkSynced('fasts',        fasts.map(f => ({ id: f.id, updated_at: f.updated_at })), live);
  // wellness_data has no updated_at column, so it can't go through
  // dbMarkSynced's id+updated_at gate — that path throws SQLITE_ERROR
  // and aborts the whole push loop before pullChanges runs. Use the
  // dedicated id-only helper. See dbMarkWellnessSynced doc + #89.
  await dbMarkWellnessSynced(wellness.map(w => w.id), live);
  if (pendingSettings.length) {
    await dbMarkSettingsSynced(pendingSettings.map(s => ({ key: s.key, updated_at: s.updated_at })), live);
  }

  // Purge soft-deleted records that have been confirmed pushed
  if (live()) await dbPurgeSoftDeleted('foods');
  if (live()) await dbPurgeSoftDeleted('meals');
  if (live()) await dbPurgeSoftDeleted('diary');
  if (live()) await dbPurgeSoftDeleted('activity_log');
  if (live()) await dbPurgeSoftDeleted('fasts');

  // Rows whose pushed edit was older than the server's: the server sent
  // its copy back, and this phone takes it (older servers send none).
  for (const [name, table] of [['foods', 'foods'], ['meals', 'meals'], ['activity', 'activity_log'], ['fasts', 'fasts']]) {
    for (const r of (result[name] || [])) {
      if (r && r.row) {
        try { if (live()) await dbApplyServerWinner(table, r.row); }
        catch (e) { console.warn(`[sync] keeping the server's ${name} row failed:`, e?.message || e); }
      }
    }
  }

  _dlog('[sync] push complete');
  return true;
}

/** Pull server changes since last sync */
// The server's clock against this phone's, from a reply's clock (stamped
// as the answer went out, set against the middle of the request): edits
// made from now on are stamped on the server's clock (db-native.js
// _editNow). The quickest round trip is the most exact, and a push's
// small answer beats a pull's big one. A sample is replaced by a better
// one, by any after 5 minutes, and at once when this phone's clock has
// moved (the offset changed by over a minute).
let _clockSample = null; // { rtt, kind, at, offset }
/** Whether sample `s` should replace `cur` (both { rtt, kind, at, offset }). */
export function betterClockSample(cur, s) {
  return !cur
    || Math.abs(s.offset - cur.offset) > 60_000
    || Math.abs(s.at - cur.at) > 5 * 60_000
    || s.rtt < cur.rtt
    || (s.kind === 'push' && cur.kind === 'pull' && s.rtt <= cur.rtt * 2);
}
function _learnClock(serverTime, sentAt, kind) {
  const t = Date.parse(serverTime);
  if (!Number.isFinite(t)) return;
  const now = Date.now();
  const sample = { rtt: Math.max(0, now - sentAt), kind, at: now, offset: t - (sentAt + now) / 2 };
  if (!betterClockSample(_clockSample, sample)) return;
  _clockSample = sample;
  dbSetClockOffset(sample.offset).catch(() => {});
}

async function pullChanges({ signal = null, gen = accountGeneration() } = {}) {
  const token = getAuthToken();
  // False once another account's sign-in has begun: checked before every
  // write below (lib/local-account.js accountGeneration).
  const live = () => gen === accountGeneration();
  if (!live() || !(await localDataIsThisAccount(token))) return false;
  const lastSync = await dbGetSyncMeta('last_sync_at') || '1970-01-01T00:00:00.000Z';

  _dlog(`[sync] pulling since ${lastSync}`);

  // 30s ceiling — same reasoning as the push above. Initial pull for a
  // large library over slow network still fits comfortably; anything
  // beyond 30s is a wedged connection, not a legitimate transfer.
  const sentAt = Date.now();
  const res = await fetch(apiUrl(`/api/sync/pull?since=${encodeURIComponent(lastSync)}`), {
    headers: _headers(token),
    signal: _deadline(signal),
  });

  if (!res.ok) {
    if (res.status === 401) await _handleSyncAuthError();
    throw new Error(`Pull failed: ${res.status}`);
  }
  const data = await res.json();
  _learnClock(data.clock_time, sentAt, 'pull');
  // The copy may change hands while this runs (another account signed in):
  // checked before each kind of row is written, and before the cursor.
  const mine = () => localDataIsThisAccount(token);
  if (!(await mine())) return false;
  // And every 50 rows within a kind, so a long pull stops soon after.
  let _written = 0;
  const stillMine = async () => live() && (++_written % 50 === 0 ? mine() : true);

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
    if (!(await stillMine())) return false;
    try { await dbUpsertFromServer('foods', f); }
    catch (e) { _pullErr('foods', f, e); }
  }

  if (!(await mine())) return false;
  // Apply meals
  for (const m of (data.meals || [])) {
    if (!(await stillMine())) return false;
    try { await dbUpsertFromServer('meals', m); }
    catch (e) { _pullErr('meals', m, e); }
  }

  if (!(await mine())) return false;
  // Apply diary
  for (const d of (data.diary || [])) {
    if (!(await stillMine())) return false;
    try { await dbUpsertDiaryFromServer(d); }
    catch (e) { _pullErr('diary', d, e); }
  }

  if (!(await mine())) return false;
  // Option C: apply any per-item deletion tombstones the server has
  // accumulated since our last pull. This drops the corresponding
  // items/water entries from the local diary row and inserts a
  // synced-status tombstone so a stale local write can't resurrect
  // them.
  if (Array.isArray(data.diary_tombstones) && data.diary_tombstones.length) {
    try { await dbApplyServerTombstones(data.diary_tombstones, live); }
    catch (e) { _pullErr('diary_tombstones', { count: data.diary_tombstones.length }, e); }
  }

  if (!(await mine())) return false;
  // Apply wellness data (pull-only, server-generated)
  for (const w of (data.wellness || [])) {
    if (!(await stillMine())) return false;
    try { await dbUpsertWellnessFromServer(w); }
    catch (e) { _pullErr('wellness', w, e); }
  }

  if (!(await mine())) return false;
  // Apply settings from server → local SQLite + localStorage
  // Skip settings that have pending local changes or were recently changed locally
  const pulledSettings = data.settings || [];
  const localPendingKeys = new Set((await dbGetPendingSettings()).map(s => s.key));
  const settingsMod = await import('../stores/settings.js');
  for (const s of pulledSettings) {
    if (!(await stillMine())) return false;
    if (localPendingKeys.has(s.key) || settingsMod.isRecentlyChanged(s.key)) {
      _dlog(`[sync] skip pulled setting ${s.key} — local change takes priority`);
      continue;
    }
    try {
      await dbUpsertSettingFromServer(s);
      if (!s.deleted_at && live()) {
        const { DB } = await import('./db.js');
        const val = typeof s.value === 'string' ? _parseJson(s.value) : s.value;
        settingsMod._applySetting(s.key, val);
      }
    } catch (e) { _pullErr('settings', s, e); }
  }

  if (!(await mine())) return false;
  // Apply workouts from server
  for (const w of (data.workouts || [])) {
    if (!(await stillMine())) return false;
    try { await dbUpsertWorkoutFromServer(w); }
    catch (e) { _pullErr('workouts', w, e); }
  }

  if (!(await mine())) return false;
  // Apply activity entries from server
  for (const a of (data.activity || [])) {
    if (!(await stillMine())) return false;
    try { await dbUpsertActivityFromServer(a); }
    catch (e) { _pullErr('activity', a, e); }
  }

  if (!(await mine())) return false;
  // Wellness values and workouts the server removed outright (Clear all
  // data, a wearable re-sync, duplicate clean-up). Older servers send none.
  if (data.deletions) {
    try { await dbApplyServerDeletions(data.deletions, live); }
    catch (e) { _pullErr('deletions', {}, e); }
  }

  if (!(await mine())) return false;
  // Apply fasts (intermittent-fasting tracker) from server
  const { dbUpsertFastFromServer } = await import('./db-native.js');
  for (const f of (data.fasts || [])) {
    if (!(await stillMine())) return false;
    try { await dbUpsertFastFromServer(f); }
    catch (e) { _pullErr('fasts', f, e); }
  }

  // Chat history — pull only, notify the AI Assistant component via event
  const newChat = data.chat_history || [];
  if (newChat.length && typeof window !== 'undefined' && live()) {
    window.dispatchEvent(new CustomEvent('nt:chat-updated', { detail: { messages: newChat } }));
  }

  if (!(await mine())) return false;
  // Save server time as last_sync_at
  if (data.server_time && live()) {
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

  // Trigger a user-requested full sync — this pushes everything we just
  // marked pending and may surface detailed failure feedback.
  await fullSync(false, false, true);
  return { pushed: counts };
}

/** Full sync — push then pull then cache images
 * @param {boolean} silent - If true, don't show sync bar unless there are actual changes
 * @param {boolean} forceCheck - Ignore cached connectivity and probe now
 * @param {boolean} showFailureBanner - Surface failure details requested by the user
 */
// What's running now (full syncs, scheduled pushes, the sign-out push, the
// completion queue), so a change of account can stop it: every run's
// requests are aborted, and the account's copy changes hands only once
// they have all ended (stopSync). Each run also stops writing as soon as
// the account generation moves (lib/local-account.js).
const _runs = new Set(); // { ctl, signal, promise }
function _startRun(outer = null) {
  const ctl = new AbortController();
  const signal = outer && typeof AbortSignal.any === 'function' ? AbortSignal.any([ctl.signal, outer]) : ctl.signal;
  const run = { ctl, signal, promise: null };
  _runs.add(run);
  return run;
}
function _endRun(run, promise) {
  run.promise = promise;
  Promise.resolve(promise).catch(() => {}).finally(() => _runs.delete(run));
}
export async function stopSync() {
  clearTimeout(_pushTimeout);
  const running = [..._runs];
  for (const r of running) r.ctl.abort();
  await Promise.allSettled(running.map(r => r.promise).filter(Boolean));
}

export function fullSync(silent = false, forceCheck = false, showFailureBanner = false) {
  if (_syncing) return Promise.resolve({ ok: false, reason: 'busy' });
  if (!getAuthToken()) return Promise.resolve({ ok: false, reason: 'not_authenticated' });
  const run = _startRun();
  const promise = _fullSync(silent, forceCheck, showFailureBanner, run.signal, accountGeneration());
  _endRun(run, promise);
  return promise;
}

async function _fullSync(silent, forceCheck, showFailureBanner, signal, gen) {
  _syncing = true;
  // Keep every sync consumer (including Settings) aware of background syncs.
  // Silent controls progress copy, not whether a sync is actually in flight.
  syncState.update(s => ({
    ...s,
    syncing: true,
    error: null,
    ...(silent ? {} : { phase: 'pushing', progress: 'Pushing local changes…' }),
  }));

  try {
    const online = await checkOnline(forceCheck, showFailureBanner);
    if (!online) {
      syncState.update(s => ({ ...s, syncing: false, phase: '', progress: '' }));
      _syncing = false;
      return { ok: false, reason: 'offline', issue: get(syncState).connectionIssue };
    }

    // The phone still holds another account's data (a sign-in the app
    // hasn't finished checking): nothing is read, sent or fetched until
    // App.svelte has run prepareLocalAccount.
    if (!(await localDataIsThisAccount())) {
      syncState.update(s => ({ ...s, syncing: false, phase: '', progress: '' }));
      _syncing = false;
      return { ok: false, reason: 'other_account' };
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
    const pushed = await pushChanges({ signal, gen });

    if (!silent) syncState.update(s => ({ ...s, phase: 'pulling', progress: 'Downloading data…' }));
    const pulled = await pullChanges({ signal, gen });


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
    syncState.update(s => ({
      ...s,
      syncing: false,
      phase: '',
      progress: '',
      lastSync: now,
      online: true,
      connectionIssue: null,
      showErrorBanner: false,
      error: null,
    }));
    // Notify the app that sync completed — pages should refresh data
    window.dispatchEvent(new CustomEvent('nt:sync-complete'));
    return { ok: true };
  } catch (e) {
    // Log e.message + e.code + e.stack so future issue reports don't come
    // back with just `Error` from the Capacitor SQLite bridge — the plugin
    // strips useful details before propagating, and 'Error' alone in a bug
    // report is unactionable. #89 spent a full audit pass narrowing down
    // exactly which push step was throwing because we didn't have a message.
    const phase = get(syncState)?.phase || '';
    console.error('[sync] error:', e?.message || String(e), '| code:', e?.code || '(none)', '| phase:', phase, '|', e?.stack || '');
    syncState.update(s => ({
      ...s,
      syncing: false,
      phase: '',
      progress: '',
      error: e.message || 'Sync failed (see console)',
      ...(showFailureBanner ? { showErrorBanner: true } : {}),
    }));
    // Notify on sync failure
    try {
      const { notify } = await import('./notifications.js');
      await notify('notifSyncFailures', 'Sync Failed', e.message || 'Could not sync with server');
    } catch {}
    return { ok: false, reason: 'error', error: e?.message || null };
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
  _pushTimeout = setTimeout(() => {
    if (_syncing) return;
    const r = _startRun();
    const gen = accountGeneration();
    _endRun(r, (async () => {
      try {
        const online = await checkOnline();
        if (online) await pushChanges({ signal: r.signal, gen });
      } catch (e) {
        console.error('[sync] scheduled push failed:', e);
      }
    })());
  }, 3000);
}

/**
 * Signing out: send what's waiting while this account's session still
 * works. Push only (no pull, images or Health Connect), and never longer
 * than `timeoutMs`: sign-out goes ahead regardless, and anything left stays
 * for this account (lib/local-account.js keeps it from going up under
 * anyone else). The push carries this session's token throughout, and is
 * cut off (aborted) when the time is up.
 */
export function pushBeforeSignOut(timeoutMs = 4000) {
  const token = getAuthToken();
  if (!getServerUrl() || !token || _syncing) return Promise.resolve(false);
  clearTimeout(_pushTimeout);
  _syncing = true;
  const r = _startRun();
  const gen = accountGeneration();
  const run = (async () => {
    try {
      if (!(await checkOnline(true))) return false;
      return await pushChanges({ token, signal: r.signal, gen });
    } catch (e) {
      console.warn('[sync] push before sign-out failed:', e?.message || e);
      return false;
    } finally {
      _syncing = false;
    }
  })();
  _endRun(r, run);
  let timer;
  const timeout = new Promise(resolve => { timer = setTimeout(() => { r.ctl.abort(); resolve(false); }, timeoutMs); });
  return Promise.race([run, timeout]).finally(() => clearTimeout(timer));
}
