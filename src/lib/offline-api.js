/**
 * offline-api.js: the browser's API layer, able to work without a connection.
 *
 * Online, every call goes to the server as before, and what comes back is kept
 * in IndexedDB (the mirror). When the server can't be reached, the diary, your
 * foods and your meals are read from the mirror, and a saved day goes into an
 * outbox and shows at once. Back online, the outbox goes up as one sync push,
 * so the server merges browser edits exactly as it merges the phone's.
 *
 * Anything that needs the server itself (Open Food Facts lookups, photo
 * uploads, wellness providers, Trace, admin) says it needs a connection.
 *
 * Deliberately not the Background Sync API: Safari doesn't have it, and iPhone
 * is the reason this exists (#211). The page flushes instead, on a backoff and
 * on the browser's own `online` event.
 *
 * Tabs share the outbox: a Web Lock keeps two tabs from sending it at once and
 * a BroadcastChannel tells the others when it changed.
 */
import { writable, get } from 'svelte/store';
import {
  applyDiaryOps, dayWithOps, buildDiaryPush, sentSeqs, pushError, isOfflineError, emptyDay,
  applyCatalogOps, buildCatalogPush, createdIds, remapIds, newTempId, isTempId,
  activeFastRow, fastList, newFastRow, fastWith, staleReadKeys,
} from './offline-edits.js';
// Loaded with everything else, never fetched on demand: a picture is kept
// exactly when there is no connection to fetch a separate file with, and a
// browser whose service worker has not taken the newest build yet would have
// no copy of it. This is what "Failed to fetch dynamically imported module"
// looked like from the outside.
import { embeddableDataUrl } from './image-embed.js';

const RETRY_MIN_MS = 3_000;
const RETRY_MAX_MS = 30_000;
let _retryMs = RETRY_MIN_MS;
const _backoff = () => { const ms = _retryMs; _retryMs = Math.min(RETRY_MAX_MS, _retryMs * 2); return ms; };
const _resetBackoff = () => { _retryMs = RETRY_MIN_MS; };

/** { online, pending, syncing, error } for the header badge and Settings. */
export const offlineState = writable({
  online: typeof navigator === 'undefined' ? true : navigator.onLine !== false,
  pending: 0,
  syncing: false,
  error: null,
});

// Reads answered from the mirror when the server can't be reached.
const MIRRORED_READS = new Set(['getDiaryDate', 'getAllDiary', 'getFoods', 'getFood', 'getMeals', 'getRecipes',
  'getActivity', 'getActivityRange', 'getActivitySum']);

// ── IndexedDB ────────────────────────────────────────────────────────
let _dbPromise = null;
// Whose queue this is. If the app ever cannot confirm who is signed in (what
// a reload with no connection looks like) and clears the id, the last one
// this browser saw still names the database, so the queue is never orphaned
// where nothing will read it. LiftTrace lost work exactly that way.
const _USER_KEY = 'nt:offline-user';
function _dbName() {
  let user = null;
  try {
    user = localStorage.getItem('wl:userId');
    if (user) localStorage.setItem(_USER_KEY, user);
    else user = localStorage.getItem(_USER_KEY);
  } catch { /* private mode */ }
  return `nutritrace-offline-${user || 'single'}`;
}
const _STORES = ['diary', 'foods', 'meals', 'recipes', 'activity', 'activity_sums', 'fasts', 'reads', 'outbox', 'meta'];

function _db() {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  const name = _dbName();
  if (_dbPromise && _dbPromise.name === name) return _dbPromise;
  // The first reads of a page happen before the app knows who is signed in,
  // so they are filed under the anonymous name. Once the id turns up, bring
  // what was kept with it rather than leaving it in a database nothing reads.
  const leaving = _dbPromise?.name && _dbPromise.name !== name ? _dbPromise.name : null;
  const p = new Promise((resolve) => {
    const req = indexedDB.open(name, 4);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('diary')) db.createObjectStore('diary', { keyPath: 'date' });
      if (!db.objectStoreNames.contains('foods')) db.createObjectStore('foods', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('meals')) db.createObjectStore('meals', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('recipes')) db.createObjectStore('recipes', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('activity')) db.createObjectStore('activity', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('fasts')) db.createObjectStore('fasts', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('activity_sums')) db.createObjectStore('activity_sums', { keyPath: 'date' });
      if (!db.objectStoreNames.contains('reads')) db.createObjectStore('reads', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'seq', autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  p.name = name;
  _dbPromise = p;
  if (leaving) p.then(db => _absorb(leaving, db));
  return p;
}

/** Move everything from an old database into this one, then drop it. */
async function _absorb(oldName, db) {
  if (!db) return;
  const old = await new Promise((resolve) => {
    const req = indexedDB.open(oldName);
    req.onsuccess = () => resolve(req.result);
    req.onerror = req.onblocked = () => resolve(null);
  });
  if (!old) return;
  for (const store of _STORES) {
    if (!old.objectStoreNames.contains(store) || !db.objectStoreNames.contains(store)) continue;
    const rows = await new Promise((resolve) => {
      try {
        const q = old.transaction(store, 'readonly').objectStore(store).getAll();
        q.onsuccess = () => resolve(q.result || []);
        q.onerror = () => resolve([]);
      } catch { resolve([]); }
    });
    if (!rows.length) continue;
    await new Promise((resolve) => {
      try {
        const tx = db.transaction(store, 'readwrite');
        const s = tx.objectStore(store);
        // The outbox is keyed by a running number, so queued work is re-added
        // and given a new one rather than landing on top of something.
        for (const row of rows) { if (store === 'outbox') { const { seq, ...rest } = row; s.add(rest); } else s.put(row); }
        tx.oncomplete = tx.onerror = tx.onabort = () => resolve();
      } catch { resolve(); }
    });
  }
  old.close();
  try { indexedDB.deleteDatabase(oldName); } catch { /* another tab has it open */ }
  _ops = null;
  await _loadOps();
  _publish();
  if (_ops.length) _scheduleFlush(0);
}
// Every read and write is wrapped: a blocked, full or private-mode database
// resolves to null instead of throwing, and the app falls back to the server.
function _tx(store, mode, fn) {
  return _db().then(db => new Promise((resolve) => {
    if (!db) return resolve(null);
    let out;
    try {
      const tx = db.transaction(store, mode);
      out = fn(tx.objectStore(store));
      tx.oncomplete = () => resolve(out instanceof IDBRequest ? out.result : out);
      tx.onerror = tx.onabort = () => resolve(null);
    } catch { resolve(null); }
  }));
}
const _all = (store) => _tx(store, 'readonly', s => s.getAll()).then(r => r || []);

async function _remember(store, rows) {
  const list = (Array.isArray(rows) ? rows : [rows]).filter(r => r && (r.id != null || r.date));
  if (!list.length) return;
  await _tx(store, 'readwrite', s => { for (const r of list) s.put(r); });
}

/**
 * The mirror IS what the server just sent, not what it sent plus whatever it
 * used to send. Adding rows without ever dropping them meant something
 * deleted on another device lived on here: gone online, back again the moment
 * the connection dropped. `keep` decides which rows a partial answer leaves
 * alone (a day's activity only speaks for that day).
 */
async function _replace(store, rows, keep = () => false) {
  const list = (Array.isArray(rows) ? rows : [rows]).filter(r => r && (r.id != null || r.date));
  await _tx(store, 'readwrite', (s) => {
    const req = s.getAll();
    req.onsuccess = () => {
      const fresh = new Set(list.map(r => String(r.id ?? r.date)));
      for (const old of req.result || []) {
        const id = String(old.id ?? old.date);
        // Rows still waiting to go up are not the server's to forget.
        if (fresh.has(id) || isTempId(old.id) || keep(old)) continue;
        s.delete(old.id ?? old.date);
      }
      for (const r of list) s.put(r);
    };
  });
}

// ── Outbox ───────────────────────────────────────────────────────────
let _ops = null;
async function _loadOps() {
  if (!_ops) _ops = await _all('outbox');
  return _ops;
}
function _publish(extra = {}) {
  offlineState.update(s => ({ ...s, pending: _ops?.length || 0, ...extra }));
}
const _channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('nutritrace-offline') : null;
_channel?.addEventListener('message', async (e) => {
  if (e.data?.type !== 'outbox') return;
  if (e.data.ids) _swapped = { ..._swapped, ...e.data.ids };
  _ops = null;
  await _loadOps();
  _publish();
  if (e.data.synced && typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('nt:offline-synced'));
  }
});

const _online = () => typeof navigator === 'undefined' || navigator.onLine !== false;

/**
 * What each temporary id became. A screen already open goes on showing the
 * id a row was created with offline, so a change made right after the queue
 * goes up would otherwise be queued against an id the server never had, and
 * arrive as a second copy. Tabs share the map along with the outbox.
 */
let _swapped = {};
const _realId = (id) => (id != null && _swapped[Number(id)] != null ? _swapped[Number(id)] : id);
// Kept on disk as well as in memory, so a screen reopened later still knows
// what a row created offline became. NoteTrace has always done this.
async function _loadSwapped() {
  const kept = await _tx('meta', 'readonly', s => s.get('idMap'));
  if (kept) _swapped = { ...kept, ..._swapped };
  return _swapped;
}
const _fixFastPath = (path) =>
  String(path).replace(/^\/api\/fasts\/(-?\d+)/, (_all, id) => `/api/fasts/${_realId(id)}`);

function _offlineError(message) {
  const err = new Error(message || 'This needs a connection.');
  err.offline = true;
  return err;
}

// How many provider readings to keep. A season of wellness days is plenty,
// and a database that never fills is what keeps the outbox writable: a full
// one would refuse what you log, which matters far more than a copy of
// something you can read again later.
const KEEP_READS = 300;
let _sinceTrim = 0;

async function _rememberRead(key, body) {
  await _tx('reads', 'readwrite', s => s.put({ key, body, at: Date.now() }));
  if (++_sinceTrim >= 25) {
    _sinceTrim = 0;
    const stale = staleReadKeys(await _all('reads'), KEEP_READS);
    if (stale.length) await _tx('reads', 'readwrite', s => { for (const key of stale) s.delete(key); });
  }
}

/**
 * Add to the outbox, making room if the database is full: what you have
 * logged matters more than a copy of something you can read again.
 */
async function _addOp(op) {
  let seq = await _tx('outbox', 'readwrite', s => s.add(op));
  if (seq == null) {
    await _tx('reads', 'readwrite', s => s.clear());
    await _tx('activity_sums', 'readwrite', s => s.clear());
    seq = await _tx('outbox', 'readwrite', s => s.add(op));
  }
  return seq;
}

async function _queueDay(date, day) {
  const ops = await _loadOps();
  const op = { type: 'diary', date, day, at: Date.now() };
  const seq = await _addOp(op);
  // No database to queue into (private mode, no space): say so rather than
  // pretending the day was saved.
  if (seq == null) throw _offlineError();
  op.seq = seq;
  ops.push(op);
  _publish();
  _channel?.postMessage({ type: 'outbox' });
  _scheduleFlush(_online() ? 0 : _retryMs);
  return dayWithOps(await _all('diary'), ops, date);
}

// store: which mirror the row lives in ('foods', 'meals', 'recipes').
// table: which side of the sync push carries it ('foods' or 'meals'); the
// server keeps recipes in the meals table with a flag.
async function _queueCatalog(store, table, action, id, data) {
  const ops = await _loadOps();
  const op = { type: 'catalog', table, action, id: Number(id), data, at: Date.now() };
  const seq = await _addOp(op);
  if (seq == null) throw _offlineError();
  op.seq = seq;
  ops.push(op);
  if (action === 'delete') await _tx(store, 'readwrite', s => s.delete(Number(id)));
  else await _remember(store, applyCatalogOps(await _all(store), [op], table).get(Number(id)));
  _publish();
  _channel?.postMessage({ type: 'outbox' });
  _scheduleFlush(_online() ? 0 : _retryMs);
  return applyCatalogOps(await _all(store), ops, table).get(Number(id)) || null;
}

/**
 * A setting changed with no connection. Settings do not go through the API
 * wrapper (the settings store pushes them itself), so the store calls this
 * when its own push fails. Keyed by name: the last value wins.
 */
/**
 * A write that isn't part of the sync push: your own profile, for instance.
 * It is kept as the request the app tried to make and repeated as-is when
 * the connection returns, before anything else goes up.
 */
async function _queueRequest(kind, key, method, path, body) {
  const ops = await _loadOps();
  const op = { type: 'request', kind, key, method, path, body, at: Date.now() };
  const seq = await _addOp(op);
  if (seq == null) throw _offlineError();
  op.seq = seq;
  ops.push(op);
  _publish();
  _channel?.postMessage({ type: 'outbox' });
  _scheduleFlush(_online() ? 0 : _retryMs);
  return op;
}

export async function queueSetting(key, value) {
  const ops = await _loadOps();
  const op = { type: 'setting', key, data: value, at: Date.now() };
  const seq = await _addOp(op);
  if (seq == null) return false;
  op.seq = seq;
  ops.push(op);
  _publish();
  _channel?.postMessage({ type: 'outbox' });
  _scheduleFlush(_online() ? 0 : _retryMs);
  return true;
}

// ── Sending ──────────────────────────────────────────────────────────
let _http = null;
let _retry = null;
let _flushing = null;

/**
 * Send the push. The API wrapper is only built the first time a screen calls
 * the API, and settings can be changed before that (Settings is reachable
 * straight from a link), so fall back to a plain request rather than sitting
 * on the queue forever.
 */
async function _send(method, path, body) {
  if (_http) {
    const verb = { PUT: 'put', POST: 'post', PATCH: 'patch', DELETE: 'del' }[method] || 'post';
    return verb === 'del' ? _http.del(path) : _http[verb](path, body);
  }
  const res = await fetch(path, {
    method,
    credentials: 'include',
    headers: _headers(),
    body: body == null ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`API error ${res.status}`);
  return res.json();
}

/**
 * The headers a write needs when it goes out without the API layer (nothing
 * on screen has built it yet). The server refuses a cookie-authenticated
 * write with no CSRF token, so leaving it out means the queue can never go
 * up: it would retry forever behind a red cloud.
 */
function _headers() {
  const headers = { 'Content-Type': 'application/json' };
  try {
    const csrf = localStorage.getItem('nt:csrf');
    if (csrf) headers['X-CSRF-Token'] = csrf;
  } catch { /* private mode */ }
  return headers;
}

async function _post(path, body) {
  if (_http) return _http.post(path, body);
  const res = await fetch(path, {
    method: 'POST',
    credentials: 'include',
    headers: _headers(),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`API error ${res.status}`);
  return res.json();
}

function _scheduleFlush(ms = 0) {
  clearTimeout(_retry);
  _retry = setTimeout(() => { flushOutbox(); }, ms);
}

/** Send what's waiting. Resolves true when the outbox is empty afterwards. */
export function flushOutbox() {
  if (_flushing) return _flushing;
  _flushing = (async () => {
    try {
      const run = () => _flushOnce();
      if (typeof navigator !== 'undefined' && navigator.locks?.request) {
        return await navigator.locks.request('nutritrace-offline-flush', run);
      }
      return await run();
    } finally {
      _flushing = null;
    }
  })();
  return _flushing;
}

async function _flushOnce() {
  _ops = null;
  const ops = await _loadOps();
  if (!ops.length) { _publish({ syncing: false, error: null, online: _online() }); return true; }
  if (!_online()) { _scheduleFlush(_backoff()); return false; }
  _publish({ syncing: true });

  // Plain requests first: they are what they say they are, and nothing else
  // in the queue depends on them. One per thing, so a profile saved three
  // times offline goes up once.
  const requests = [...new Map(ops.filter(op => op.type === 'request').map(op => [op.key, op])).values()];
  if (requests.length) {
    for (const op of requests) {
      try {
        await _send(op.method, op.path, op.body);
      } catch (err) {
        const offline = isOfflineError(err);
        _publish({ syncing: false, online: offline ? false : _online(), error: offline ? null : (err.message || 'failed') });
        if (!offline) console.error(`[offline] your server refused ${op.kind}: ${err.message}`);
        _scheduleFlush(_backoff());
        return false;
      }
    }
    const sent = new Set(ops.filter(op => op.type === 'request').map(op => op.seq));
    await _tx('outbox', 'readwrite', s => { for (const seq of sent) s.delete(seq); });
    _ops = ops.filter(op => !sent.has(op.seq));
  }

  // Foods go first and on their own: a food made offline has a temporary id,
  // and the diary entries logged from it have to point at the real one before
  // they go up.
  const foodOps = ops.filter(op => op.type === 'catalog' || op.type === 'setting');
  if (foodOps.length) {
    let foodResponse;
    try {
      foodResponse = await _post('/api/sync/push', buildCatalogPush(foodOps));
    } catch (err) {
      const offline = isOfflineError(err);
      _publish({ syncing: false, online: offline ? false : _online(), error: offline ? null : (err.message || 'failed') });
      _scheduleFlush(_backoff());
      return false;
    }
    const foodFailed = pushError(foodResponse);
    if (foodFailed) {
      // Your server answered and said no. Keep the work, and make sure the
      // person who logged it hears about it: a red cloud on its own tells
      // nobody why. Also into the log behind Settings, Diagnostics.
      console.error(`[offline] your server refused what was waiting: ${foodFailed}`);
      _publish({ syncing: false, error: foodFailed, online: true });
      _scheduleFlush(_backoff());
      return false;
    }
    const map = createdIds(foodResponse);
    if (Object.keys(map).length) {
      _swapped = { ..._swapped, ...map };
      await _tx('meta', 'readwrite', s => s.put(_swapped, 'idMap'));
      _channel?.postMessage({ type: 'outbox', ids: map });
      // The catalogue, the days already saved, and the diary still queued.
      for (const store of ['foods', 'meals', 'recipes', 'activity', 'fasts']) {
        for (const row of await _all(store)) {
          if (isTempId(row.id) && map[Number(row.id)] != null) {
            await _tx(store, 'readwrite', s => s.delete(Number(row.id)));
            await _remember(store, { ...row, id: map[Number(row.id)] });
          }
        }
      }
      for (const day of await _all('diary')) await _remember('diary', remapIds(day, map));
      for (const op of ops) {
        if (op.type !== 'diary') continue;
        const fixed = remapIds(op, map);
        await _tx('outbox', 'readwrite', s => s.put(fixed));
        Object.assign(op, fixed);
      }
    }
    const foodSeqs = new Set(foodOps.map(op => op.seq));
    await _tx('outbox', 'readwrite', s => { for (const seq of foodSeqs) s.delete(seq); });
    _ops = ops.filter(op => !foodSeqs.has(op.seq));
  }

  const diaryOps = (_ops || ops).filter(op => op.type === 'diary');
  if (!diaryOps.length) {
    _resetBackoff();
    _publish({ syncing: false, error: null, online: true });
    _channel?.postMessage({ type: 'outbox', synced: true });
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('nt:offline-synced'));
    return true;
  }
  const mirror = await _all('diary');
  let response;
  try {
    response = await _post('/api/sync/push', buildDiaryPush(diaryOps, mirror));
  } catch (err) {
    const offline = isOfflineError(err);
    _publish({ syncing: false, online: offline ? false : _online(), error: offline ? null : (err.message || 'failed') });
    _scheduleFlush(_backoff());
    return false;
  }
  const failed = pushError(response);
  if (failed) {
    console.error(`[offline] your server refused what was waiting: ${failed}`);
    _publish({ syncing: false, error: failed, online: true });
    _scheduleFlush(_backoff());
    return false;
  }
  const done = new Set(sentSeqs(diaryOps));
  await _tx('outbox', 'readwrite', s => { for (const seq of done) s.delete(seq); });
  _ops = ops.filter(op => !done.has(op.seq));
  _resetBackoff();
  _publish({ syncing: false, error: null, online: true });
  _channel?.postMessage({ type: 'outbox', synced: true });
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('nt:offline-synced'));
  // Anything logged while this push was in flight is in the database but not
  // in the copy this run started from, and a flush asked for while one is
  // running is answered with the running one. Read it back and go again, or
  // that work waits for something else to happen to notice it.
  _ops = null;
  await _loadOps();
  _publish();
  if (_ops.length) _scheduleFlush(0);
  return !_ops.length;
}

/** How many days are waiting to go up. */
export async function pendingCount() {
  return (await _loadOps()).length;
}

/** Clear the mirror and the queue, e.g. on sign-out. */
export async function clearOffline() {
  await _tx('diary', 'readwrite', s => s.clear());
  await _tx('foods', 'readwrite', s => s.clear());
  await _tx('meals', 'readwrite', s => s.clear());
  await _tx('recipes', 'readwrite', s => s.clear());
  await _tx('activity', 'readwrite', s => s.clear());
  await _tx('fasts', 'readwrite', s => s.clear());
  await _tx('reads', 'readwrite', s => s.clear());
  await _tx('activity_sums', 'readwrite', s => s.clear());
  await _tx('outbox', 'readwrite', s => s.clear());
  _ops = [];
  _swapped = {};
  _dbPromise = null;
  try { localStorage.removeItem(_USER_KEY); } catch { /* private mode */ }
  _publish({ syncing: false, error: null });
}

// ── The wrapper ──────────────────────────────────────────────────────
/**
 * Wrap the HTTP API so the diary keeps working without a connection.
 * Anything not named here is passed straight through.
 */
function _wire() {
  if (typeof window !== 'undefined' && !window.__ntOfflineWired) {
    window.__ntOfflineWired = true;
    window.addEventListener('online', () => { _resetBackoff(); _publish({ online: true }); _scheduleFlush(0); });
    window.addEventListener('offline', () => _publish({ online: false }));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') _scheduleFlush(0);
    });
    _loadSwapped().catch(() => {});
    _loadOps().then(() => { _publish(); if (_ops.length) _scheduleFlush(0); });
  }
}
// Wired as soon as anything imports this, so a queue left from last time is
// sent even if the first thing the user opens never calls the API.
_wire();

/**
 * Reads that are the server's to answer but are worth keeping a copy of, so
 * a day's wellness figures stay on screen with no connection instead of the
 * screen emptying. Anything that DOES something (authorising a provider,
 * changing its settings, asking it to sync) is not kept.
 */
const _KEEP_READS = [
  /^\/api\/wellness\/[\w-]+\/data(\?|$)/,
  /^\/api\/wellness\/[\w-]+\/workouts(\?|$)/,
  /^\/api\/wellness\/[\w-]+\/status$/,
  /^\/api\/wellness\/calories-out(\?|$)/,
  /^\/api\/wellness\/latest(\?|$)/,
];
const _keepsRead = (path) => _KEEP_READS.some(re => re.test(String(path)));

const _FASTS = /^\/api\/fasts(\/|\?|$)/;
const _isActivePath = (path) => String(path).split('?')[0] === '/api/fasts/active';
const _isFastOp = (op) => op?.type === 'catalog' && op.table === 'fasts';
function _fastLimit(path) {
  const q = String(path).includes('?') ? String(path).split('?')[1] : '';
  const n = parseInt(new URLSearchParams(q).get('limit'));
  return Number.isFinite(n) && n > 0 ? n : 60;
}

/** Nothing queued for the fasts table and the browser thinks it's online. */
async function _canReachServer() {
  return _online() && !(await _loadOps()).some(_isFastOp);
}

/** Queue the whole fast as it stands after this change. */
async function _queueFast(id, change) {
  const merged = fastWith(await _all('fasts'), await _loadOps(), id, change);
  // A fast this browser has never seen can't be changed from here.
  if (!merged) throw _offlineError();
  return _queueCatalog('fasts', 'fasts', isTempId(id) ? 'create' : 'update', id, merged);
}

/**
 * A call this layer doesn't handle. Still the server's job; offline, say that
 * rather than letting a network error reach the screen.
 */
async function _through(http, name, path, args) {
  try {
    return await http[name](path, ...args);
  } catch (err) {
    if (!isOfflineError(err)) throw err;
    _publish({ online: false });
    throw _offlineError();
  }
}

export function createOfflineApi(http) {
  _http = http;
  _wire();

  const impl = {
    async getDiaryDate(date) {
      try {
        const day = await http.getDiaryDate(date);
        await _remember('diary', { ...day, date });
        const ops = await _loadOps();
        // A day still queued shows what's queued, not what the server last knew.
        return ops.some(o => o.date === date) ? dayWithOps([day], ops, date) : day;
      } catch (err) {
        if (!isOfflineError(err)) throw err;
        _publish({ online: false });
        return dayWithOps(await _all('diary'), await _loadOps(), date);
      }
    },

    async getAllDiary() {
      try {
        const days = await http.getAllDiary();
        const ops = await _loadOps();
        // A day removed elsewhere goes from the mirror too, unless this
        // browser still has something queued for it.
        await _replace('diary', days, old => ops.some(o => o.date === old.date));
        return [...applyDiaryOps(days, ops).values()];
      } catch (err) {
        if (!isOfflineError(err)) throw err;
        _publish({ online: false });
        return [...applyDiaryOps(await _all('diary'), await _loadOps()).values()];
      }
    },

    async saveDiaryDate(date, data) {
      const ops = await _loadOps();
      // Anything already waiting goes first, so days keep their order.
      if (_online() && !ops.length) {
        try {
          const saved = await http.saveDiaryDate(date, data);
          await _remember('diary', { ...saved, date });
          _publish({ online: true, error: null });
          return saved;
        } catch (err) {
          if (!isOfflineError(err)) throw err;
          _publish({ online: false });
        }
      }
      return _queueDay(date, data);
    },

    async createFood(data) {
      const ops = await _loadOps();
      if (_online() && !ops.length) {
        try {
          const food = await http.createFood(data);
          await _remember('foods', food);
          return food;
        } catch (err) {
          if (!isOfflineError(err)) throw err;
          _publish({ online: false });
        }
      }
      // A temporary id so the diary can log it straight away; it becomes the
      // server's id when the queue goes up.
      return _queueCatalog('foods', 'foods', 'create', newTempId(), data);
    },

    async updateFood(id, data) {
      id = _realId(id);
      const ops = await _loadOps();
      if (_online() && !ops.length && !isTempId(id)) {
        try {
          const food = await http.updateFood(id, data);
          await _remember('foods', food);
          return food;
        } catch (err) {
          if (!isOfflineError(err)) throw err;
          _publish({ online: false });
        }
      }
      return _queueCatalog('foods', 'foods', 'update', id, data);
    },

    async deleteFood(id) {
      id = _realId(id);
      const ops = await _loadOps();
      if (_online() && !ops.length && !isTempId(id)) {
        try {
          const r = await http.deleteFood(id);
          await _tx('foods', 'readwrite', s => s.delete(Number(id)));
          return r;
        } catch (err) {
          if (!isOfflineError(err)) throw err;
          _publish({ online: false });
        }
      }
      await _queueCatalog('foods', 'foods', 'delete', id, null);
      return { ok: true };
    },

    // Meals and recipes live in the same table on the server; a recipe is a
    // meal with is_recipe set, so both queue onto the meals side of the push.
    async createMeal(data) {
      const ops = await _loadOps();
      const store = data?.is_recipe ? 'recipes' : 'meals';
      if (_online() && !ops.length) {
        try {
          const meal = await http.createMeal(data);
          await _remember(store, meal);
          return meal;
        } catch (err) {
          if (!isOfflineError(err)) throw err;
          _publish({ online: false });
        }
      }
      return _queueCatalog(store, 'meals', 'create', newTempId(), data);
    },

    async updateMeal(id, data) {
      id = _realId(id);
      const ops = await _loadOps();
      const store = data?.is_recipe ? 'recipes' : 'meals';
      if (_online() && !ops.length && !isTempId(id)) {
        try {
          const meal = await http.updateMeal(id, data);
          await _remember(store, meal);
          return meal;
        } catch (err) {
          if (!isOfflineError(err)) throw err;
          _publish({ online: false });
        }
      }
      return _queueCatalog(store, 'meals', 'update', id, data);
    },

    async deleteMeal(id) {
      id = _realId(id);
      const ops = await _loadOps();
      if (_online() && !ops.length && !isTempId(id)) {
        try {
          const r = await http.deleteMeal(id);
          for (const store of ['meals', 'recipes']) await _tx(store, 'readwrite', s => s.delete(Number(id)));
          return r;
        } catch (err) {
          if (!isOfflineError(err)) throw err;
          _publish({ online: false });
        }
      }
      await _queueCatalog('meals', 'meals', 'delete', id, null);
      await _tx('recipes', 'readwrite', s => s.delete(Number(id)));
      return { ok: true };
    },

    // Manual workouts. The day's list and its summary are loaded together by
    // the activity store, so both answer offline or the list disappears.
    async getActivity(date) {
      try {
        const rows = await http.getActivity(date);
        // Only this day's rows: the answer says nothing about any other day.
        await _replace('activity', (rows || []).map(r => ({ ...r, date })), old => old.date !== date);
        return [...applyCatalogOps(rows || [], await _loadOps(), 'activity').values()].filter(r => !r.date || r.date === date);
      } catch (err) {
        if (!isOfflineError(err)) throw err;
        _publish({ online: false });
        const rows = (await _all('activity')).filter(r => r.date === date);
        return [...applyCatalogOps(rows, await _loadOps(), 'activity').values()].filter(r => !r.date || r.date === date);
      }
    },

    async getActivityRange(from, to) {
      try {
        const rows = await http.getActivityRange(from, to);
        await _remember('activity', rows);
        return rows;
      } catch (err) {
        if (!isOfflineError(err)) throw err;
        _publish({ online: false });
        const rows = (await _all('activity')).filter(r => r.date >= from && r.date <= to);
        return [...applyCatalogOps(rows, await _loadOps(), 'activity').values()];
      }
    },

    async getActivitySum(date, policy) {
      try {
        const sum = await http.getActivitySum(date, policy);
        await _remember('activity_sums', { ...sum, date });
        return sum;
      } catch (err) {
        if (!isOfflineError(err)) throw err;
        _publish({ online: false });
        // The wearable half comes from your provider, so offline it is
        // whatever was last known; the manual half is recomputed from the
        // entries held here, including any waiting to go up.
        const cached = (await _all('activity_sums')).find(s => s.date === date) || { manual: 0, wearable: 0, effective: 0, policy };
        const rows = [...applyCatalogOps((await _all('activity')).filter(r => r.date === date), await _loadOps(), 'activity').values()];
        const manual = rows.filter(r => !r.is_template).reduce((n, r) => n + (Number(r.kcal) || 0), 0);
        const wearable = Number(cached.wearable) || 0;
        const effective = (cached.policy || policy) === 'sum' ? manual + wearable : Math.max(manual, wearable);
        return { ...cached, manual, wearable, effective, policy: cached.policy || policy, _stale: true };
      }
    },

    async createActivity(data) {
      const ops = await _loadOps();
      if (_online() && !ops.length) {
        try {
          const row = await http.createActivity(data);
          await _remember('activity', row);
          return row;
        } catch (err) {
          if (!isOfflineError(err)) throw err;
          _publish({ online: false });
        }
      }
      return _queueCatalog('activity', 'activity', 'create', newTempId(), data);
    },

    async updateActivity(id, data) {
      id = _realId(id);
      const ops = await _loadOps();
      if (_online() && !ops.length && !isTempId(id)) {
        try {
          const row = await http.updateActivity(id, data);
          await _remember('activity', row);
          return row;
        } catch (err) {
          if (!isOfflineError(err)) throw err;
          _publish({ online: false });
        }
      }
      return _queueCatalog('activity', 'activity', 'update', id, data);
    },

    async deleteActivity(id) {
      id = _realId(id);
      const ops = await _loadOps();
      if (_online() && !ops.length && !isTempId(id)) {
        try {
          const r = await http.deleteActivity(id);
          await _tx('activity', 'readwrite', s => s.delete(Number(id)));
          return r;
        } catch (err) {
          if (!isOfflineError(err)) throw err;
          _publish({ online: false });
        }
      }
      await _queueCatalog('activity', 'activity', 'delete', id, null);
      return { ok: true };
    },

    async getFoods() {
      try {
        const foods = await http.getFoods();
        await _replace('foods', foods);
        const ops = await _loadOps();
        return ops.some(o => o.type === 'catalog') ? [...applyCatalogOps(foods, ops, 'foods').values()] : foods;
      } catch (err) {
        if (!isOfflineError(err)) throw err;
        _publish({ online: false });
        return [...applyCatalogOps(await _all('foods'), await _loadOps(), 'foods').values()];
      }
    },

    /**
     * A picture with no server to send it to. Rather than refusing, it is
     * scaled down and handed back as a data URL, so it travels inside
     * whatever row it belongs to (a profile, a food) and the server turns
     * it into a file when it arrives.
     */
    async uploadImage(file) {
      const ops = await _loadOps();
      if (_online() && !ops.length) {
        try {
          return await http.uploadImage(file);
        } catch (err) {
          if (!isOfflineError(err)) throw err;
          _publish({ online: false });
        }
      }
      return embeddableDataUrl(file);
    },

    /** Your own profile, including a picture chosen with no connection. */
    async updateProfile(data) {
      const ops = await _loadOps();
      if (_online() && !ops.length) {
        try {
          return await http.updateProfile(data);
        } catch (err) {
          if (!isOfflineError(err)) throw err;
          _publish({ online: false });
        }
      }
      await _queueRequest('your profile', 'profile', 'PUT', '/api/auth/profile', data);
      return { user: { ...data }, queued: true, offline: true };
    },

    async getFood(id) {
      id = _realId(id);
      try {
        const food = await http.getFood(id);
        await _remember('foods', food);
        return food;
      } catch (err) {
        if (!isOfflineError(err)) throw err;
        _publish({ online: false });
        const found = (await _all('foods')).find(f => String(f.id) === String(id));
        if (!found) throw _offlineError();
        return found;
      }
    },

    async getMeals() {
      try {
        const meals = await http.getMeals();
        await _replace('meals', meals);
        const ops = await _loadOps();
        return ops.some(o => o.type === 'catalog') ? [...applyCatalogOps(meals, ops, 'meals').values()] : meals;
      } catch (err) {
        if (!isOfflineError(err)) throw err;
        _publish({ online: false });
        // Recipes are kept apart in the mirror, so only meals come back here.
        return [...applyCatalogOps(await _all('meals'), await _loadOps(), 'meals').values()].filter(m => !m.is_recipe);
      }
    },

    // ── Intermittent fasting ─────────────────────────────────────────
    // The fasting widget talks to the server by path rather than through a
    // named method, so these four take the fasting paths and hand everything
    // else (wellness providers, admin, Trace) straight on.
    async get(path, ...rest) {
      if (!_FASTS.test(path)) {
        if (!_keepsRead(path)) return _through(http, 'get', path, rest);
        try {
          const answer = await http.get(path, ...rest);
          await _rememberRead(String(path), answer);
          return answer;
        } catch (err) {
          if (!isOfflineError(err)) throw err;
          _publish({ online: false });
          const kept = await _tx('reads', 'readonly', s => s.get(String(path)));
          // Nothing seen for this day yet: the screen says it needs a connection.
          if (!kept) throw _offlineError();
          return kept.body;
        }
      }
      const answer = async () => {
        const [rows, ops] = [await _all('fasts'), await _loadOps()];
        return _isActivePath(path) ? activeFastRow(rows, ops) : fastList(rows, ops, _fastLimit(path));
      };
      try {
        const served = await http.get(path, ...rest);
        await _remember('fasts', served || []);
        return (await _loadOps()).some(_isFastOp) ? answer() : served;
      } catch (err) {
        if (!isOfflineError(err)) throw err;
        _publish({ online: false });
        return answer();
      }
    },

    async post(path, body, ...rest) {
      if (!_FASTS.test(path)) return _through(http, 'post', path, [body, ...rest]);
      path = _fixFastPath(path);
      if (await _canReachServer()) {
        try {
          const row = await http.post(path, body, ...rest);
          await _remember('fasts', row);
          return row;
        } catch (err) {
          if (!isOfflineError(err)) throw err;
          _publish({ online: false });
        }
      }
      if (path === '/api/fasts/start') {
        // The server refuses a second fast while one is running; so does this,
        // or reconnecting would leave two of them open.
        if (activeFastRow(await _all('fasts'), await _loadOps())) {
          throw new Error('A fast is already in progress. End it before starting a new one.');
        }
        return _queueCatalog('fasts', 'fasts', 'create', newTempId(), newFastRow(body));
      }
      const ending = String(path).match(/^\/api\/fasts\/(-?\d+)\/end$/);
      if (ending) return _queueFast(ending[1], { end_at: new Date().toISOString() });
      throw _offlineError();
    },

    async patch(path, body, ...rest) {
      if (!_FASTS.test(path)) return _through(http, 'patch', path, [body, ...rest]);
      path = _fixFastPath(path);
      if (await _canReachServer()) {
        try {
          const row = await http.patch(path, body, ...rest);
          await _remember('fasts', row);
          return row;
        } catch (err) {
          if (!isOfflineError(err)) throw err;
          _publish({ online: false });
        }
      }
      const one = String(path).match(/^\/api\/fasts\/(-?\d+)$/);
      if (one) return _queueFast(one[1], body || {});
      throw _offlineError();
    },

    async del(path, ...rest) {
      if (!_FASTS.test(path)) return _through(http, 'del', path, rest);
      path = _fixFastPath(path);
      if (await _canReachServer()) {
        try {
          const r = await http.del(path, ...rest);
          const one = String(path).match(/^\/api\/fasts\/(-?\d+)$/);
          if (one) await _tx('fasts', 'readwrite', s => s.delete(Number(one[1])));
          return r;
        } catch (err) {
          if (!isOfflineError(err)) throw err;
          _publish({ online: false });
        }
      }
      const one = String(path).match(/^\/api\/fasts\/(-?\d+)$/);
      if (!one) throw _offlineError();
      await _queueCatalog('fasts', 'fasts', 'delete', one[1], null);
      return { ok: true };
    },

    // The Foods screen loads foods, meals and recipes together, so all three
    // have to answer offline or the whole screen shows an error.
    async getRecipes() {
      try {
        const recipes = await http.getRecipes();
        await _replace('recipes', recipes);
        return recipes;
      } catch (err) {
        if (!isOfflineError(err)) throw err;
        _publish({ online: false });
        return [...applyCatalogOps(await _all('recipes'), await _loadOps(), 'meals').values()].filter(m => m.is_recipe !== false);
      }
    },
  };

  return new Proxy({}, {
    get(_t, prop) {
      if (typeof prop === 'symbol' || prop === 'then' || prop === 'toJSON') return undefined;
      if (prop in impl) return impl[prop].bind(impl);
      const v = http[prop];
      if (typeof v !== 'function') return v;
      // Everything else still needs the server. Offline, say so plainly
      // instead of failing with a network error nobody can act on.
      return async (...args) => {
        try {
          return await v.apply(http, args);
        } catch (err) {
          if (isOfflineError(err) && !MIRRORED_READS.has(prop)) {
            _publish({ online: false });
            throw _offlineError();
          }
          throw err;
        }
      };
    },
  });
}
