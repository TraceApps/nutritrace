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
  applyFoodOps, buildFoodsPush, createdFoodIds, remapFoodIds, newTempId, isTempId,
} from './offline-edits.js';

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
const MIRRORED_READS = new Set(['getDiaryDate', 'getAllDiary', 'getFoods', 'getFood', 'getMeals', 'getRecipes']);

// ── IndexedDB ────────────────────────────────────────────────────────
let _dbPromise = null;
function _dbName() {
  let user = null;
  try { user = localStorage.getItem('wl:userId'); } catch { /* private mode */ }
  return `nutritrace-offline-${user || 'single'}`;
}
function _db() {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  const name = _dbName();
  if (_dbPromise && _dbPromise.name === name) return _dbPromise;
  const p = new Promise((resolve) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('diary')) db.createObjectStore('diary', { keyPath: 'date' });
      if (!db.objectStoreNames.contains('foods')) db.createObjectStore('foods', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('meals')) db.createObjectStore('meals', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('recipes')) db.createObjectStore('recipes', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'seq', autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  p.name = name;
  _dbPromise = p;
  return p;
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
  _ops = null;
  await _loadOps();
  _publish();
  if (e.data.synced && typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('nt:offline-synced'));
  }
});

const _online = () => typeof navigator === 'undefined' || navigator.onLine !== false;

function _offlineError(message) {
  const err = new Error(message || 'This needs a connection.');
  err.offline = true;
  return err;
}

async function _queueDay(date, day) {
  const ops = await _loadOps();
  const op = { type: 'diary', date, day, at: Date.now() };
  const seq = await _tx('outbox', 'readwrite', s => s.add(op));
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

async function _queueFood(action, id, data) {
  const ops = await _loadOps();
  const op = { type: 'food', action, id: Number(id), data, at: Date.now() };
  const seq = await _tx('outbox', 'readwrite', s => s.add(op));
  if (seq == null) throw _offlineError();
  op.seq = seq;
  ops.push(op);
  if (action === 'delete') await _tx('foods', 'readwrite', s => s.delete(Number(id)));
  else await _remember('foods', applyFoodOps(await _all('foods'), [op]).get(Number(id)));
  _publish();
  _channel?.postMessage({ type: 'outbox' });
  _scheduleFlush(_online() ? 0 : _retryMs);
  return applyFoodOps(await _all('foods'), ops).get(Number(id)) || null;
}

// ── Sending ──────────────────────────────────────────────────────────
let _http = null;
let _retry = null;
let _flushing = null;

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
  if (!_online() || !_http) { _scheduleFlush(_backoff()); return false; }
  _publish({ syncing: true });

  // Foods go first and on their own: a food made offline has a temporary id,
  // and the diary entries logged from it have to point at the real one before
  // they go up.
  const foodOps = ops.filter(op => op.type === 'food');
  if (foodOps.length) {
    let foodResponse;
    try {
      foodResponse = await _http.post('/api/sync/push', buildFoodsPush(foodOps));
    } catch (err) {
      const offline = isOfflineError(err);
      _publish({ syncing: false, online: offline ? false : _online(), error: offline ? null : (err.message || 'failed') });
      _scheduleFlush(_backoff());
      return false;
    }
    const foodFailed = pushError(foodResponse);
    if (foodFailed) {
      _publish({ syncing: false, error: foodFailed, online: true });
      _scheduleFlush(_backoff());
      return false;
    }
    const map = createdFoodIds(foodResponse);
    if (Object.keys(map).length) {
      // The catalogue, the days already saved, and the diary still queued.
      const foods = await _all('foods');
      for (const f of foods) {
        if (isTempId(f.id) && map[Number(f.id)] != null) {
          await _tx('foods', 'readwrite', s => s.delete(Number(f.id)));
          await _remember('foods', { ...f, id: map[Number(f.id)] });
        }
      }
      for (const day of await _all('diary')) await _remember('diary', remapFoodIds(day, map));
      for (const op of ops) {
        if (op.type !== 'diary') continue;
        const fixed = remapFoodIds(op, map);
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
    response = await _http.post('/api/sync/push', buildDiaryPush(diaryOps, mirror));
  } catch (err) {
    const offline = isOfflineError(err);
    _publish({ syncing: false, online: offline ? false : _online(), error: offline ? null : (err.message || 'failed') });
    _scheduleFlush(_backoff());
    return false;
  }
  const failed = pushError(response);
  if (failed) {
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
  // Anything queued while this push was in flight goes next.
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
  await _tx('outbox', 'readwrite', s => s.clear());
  _ops = [];
  _publish({ syncing: false, error: null });
}

// ── The wrapper ──────────────────────────────────────────────────────
/**
 * Wrap the HTTP API so the diary keeps working without a connection.
 * Anything not named here is passed straight through.
 */
export function createOfflineApi(http) {
  _http = http;
  if (typeof window !== 'undefined' && !window.__ntOfflineWired) {
    window.__ntOfflineWired = true;
    window.addEventListener('online', () => { _resetBackoff(); _publish({ online: true }); _scheduleFlush(0); });
    window.addEventListener('offline', () => _publish({ online: false }));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') _scheduleFlush(0);
    });
    _loadOps().then(() => { _publish(); if (_ops.length) _scheduleFlush(0); });
  }

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
        await _remember('diary', days);
        return [...applyDiaryOps(days, await _loadOps()).values()];
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
      return _queueFood('create', newTempId(), data);
    },

    async updateFood(id, data) {
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
      return _queueFood('update', id, data);
    },

    async deleteFood(id) {
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
      await _queueFood('delete', id, null);
      return { ok: true };
    },

    async getFoods() {
      try {
        const foods = await http.getFoods();
        await _remember('foods', foods);
        const ops = await _loadOps();
        return ops.some(o => o.type === 'food') ? [...applyFoodOps(foods, ops).values()] : foods;
      } catch (err) {
        if (!isOfflineError(err)) throw err;
        _publish({ online: false });
        return [...applyFoodOps(await _all('foods'), await _loadOps()).values()];
      }
    },

    async getFood(id) {
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
        await _remember('meals', meals);
        return meals;
      } catch (err) {
        if (!isOfflineError(err)) throw err;
        _publish({ online: false });
        return _all('meals');
      }
    },

    // The Foods screen loads foods, meals and recipes together, so all three
    // have to answer offline or the whole screen shows an error.
    async getRecipes() {
      try {
        const recipes = await http.getRecipes();
        await _remember('recipes', recipes);
        return recipes;
      } catch (err) {
        if (!isOfflineError(err)) throw err;
        _publish({ online: false });
        return _all('recipes');
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
