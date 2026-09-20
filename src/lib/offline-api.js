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
const MIRRORED_READS = new Set(['getDiaryDate', 'getAllDiary', 'getFoods', 'getFood', 'getMeals', 'getRecipes',
  'getActivity', 'getActivityRange', 'getActivitySum']);

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
      if (!db.objectStoreNames.contains('activity')) db.createObjectStore('activity', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('activity_sums')) db.createObjectStore('activity_sums', { keyPath: 'date' });
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

// store: which mirror the row lives in ('foods', 'meals', 'recipes').
// table: which side of the sync push carries it ('foods' or 'meals'); the
// server keeps recipes in the meals table with a flag.
async function _queueCatalog(store, table, action, id, data) {
  const ops = await _loadOps();
  const op = { type: 'catalog', table, action, id: Number(id), data, at: Date.now() };
  const seq = await _tx('outbox', 'readwrite', s => s.add(op));
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
  const foodOps = ops.filter(op => op.type === 'catalog');
  if (foodOps.length) {
    let foodResponse;
    try {
      foodResponse = await _http.post('/api/sync/push', buildCatalogPush(foodOps));
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
    const map = createdIds(foodResponse);
    if (Object.keys(map).length) {
      // The catalogue, the days already saved, and the diary still queued.
      for (const store of ['foods', 'meals', 'recipes', 'activity']) {
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
  await _tx('activity', 'readwrite', s => s.clear());
  await _tx('activity_sums', 'readwrite', s => s.clear());
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
      return _queueCatalog('foods', 'foods', 'create', newTempId(), data);
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
      return _queueCatalog('foods', 'foods', 'update', id, data);
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
        await _remember('activity', (rows || []).map(r => ({ ...r, date })));
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
        await _remember('foods', foods);
        const ops = await _loadOps();
        return ops.some(o => o.type === 'catalog') ? [...applyCatalogOps(foods, ops, 'foods').values()] : foods;
      } catch (err) {
        if (!isOfflineError(err)) throw err;
        _publish({ online: false });
        return [...applyCatalogOps(await _all('foods'), await _loadOps(), 'foods').values()];
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
        const ops = await _loadOps();
        return ops.some(o => o.type === 'catalog') ? [...applyCatalogOps(meals, ops, 'meals').values()] : meals;
      } catch (err) {
        if (!isOfflineError(err)) throw err;
        _publish({ online: false });
        // Recipes are kept apart in the mirror, so only meals come back here.
        return [...applyCatalogOps(await _all('meals'), await _loadOps(), 'meals').values()].filter(m => !m.is_recipe);
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
