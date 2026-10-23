/**
 * Saving with a connection must not depend on this browser's own storage
 * (#269). Loads the real offline layer against a small stand-in for
 * IndexedDB, so the cases a browser rarely shows on demand can be staged:
 * storage that refuses to open, a queue holding a change the server keeps
 * refusing, and a store that breaks after the page loaded.
 */
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

// Scheduled flushes only run when a test asks for them.
mock.timers.enable({ apis: ['setTimeout'] });
// No other tab to talk to, and nothing left listening when the tests end.
globalThis.BroadcastChannel = undefined;
Object.defineProperty(globalThis, 'localStorage', { value: undefined, configurable: true, writable: true });

const setOnline = (on) => Object.defineProperty(globalThis, 'navigator', { value: { onLine: on }, configurable: true, writable: true });
setOnline(true);

class FakeRequest {
  constructor() { this.result = undefined; this.error = null; this.onsuccess = null; this.onerror = null; }
}
globalThis.IDBRequest = FakeRequest;

const later = (fn) => queueMicrotask(fn);
const clone = (v) => (v === undefined ? undefined : structuredClone(v));

/** Just enough IndexedDB for lib/offline-api.js, with switches to break it. */
function fakeIndexedDB() {
  const env = { dbs: new Map(), openThrows: false, broken: false, full: false };
  class Tx {
    constructor(db) {
      this.db = db; this.pending = 0; this.failed = null; this.finished = false;
      this.oncomplete = this.onerror = this.onabort = null;
      later(() => this.check());
    }
    objectStore(name) {
      const def = this.db.stores.get(name);
      if (!def) throw new DOMException(`No store ${name}`, 'NotFoundError');
      return new Store(def, this);
    }
    done() { this.pending--; this.check(); }
    check() {
      if (this.pending > 0 || this.finished) return;
      this.finished = true;
      later(() => {
        if (this.failed) { this.error = this.failed; this.onerror?.(); this.onabort?.(); } else this.oncomplete?.();
      });
    }
  }
  class Store {
    constructor(def, tx) { this.def = def; this.tx = tx; }
    req(fn, write) {
      const req = new FakeRequest();
      this.tx.pending++;
      later(() => {
        try {
          if (write && env.full) throw new DOMException('Quota exceeded', 'QuotaExceededError');
          req.result = fn();
          req.onsuccess?.({ target: req });
        } catch (e) {
          req.error = e; this.tx.failed = e; req.onerror?.({ target: req });
        }
        this.tx.done();
      });
      return req;
    }
    getAll() { return this.req(() => [...this.def.rows.values()].map(clone)); }
    get(key) { return this.req(() => clone(this.def.rows.get(key))); }
    add(value) {
      return this.req(() => {
        let key = this.def.keyPath ? value[this.def.keyPath] : undefined;
        if (key == null && this.def.autoIncrement) { key = ++this.def.seq; value = { ...value, [this.def.keyPath]: key }; }
        if (this.def.rows.has(key)) throw new DOMException('Key exists', 'ConstraintError');
        this.def.rows.set(key, clone(value));
        return key;
      }, true);
    }
    put(value, outOfLine) {
      return this.req(() => {
        const key = outOfLine ?? value[this.def.keyPath];
        this.def.rows.set(key, clone(value));
        return key;
      }, true);
    }
    delete(key) { return this.req(() => { this.def.rows.delete(key); }, true); }
    clear() { return this.req(() => { this.def.rows.clear(); }, true); }
  }
  class DB {
    constructor(name) { this.name = name; this.version = 0; this.stores = new Map(); }
    get objectStoreNames() { return { contains: (n) => this.stores.has(n) }; }
    createObjectStore(name, opts = {}) {
      this.stores.set(name, { keyPath: opts.keyPath, autoIncrement: !!opts.autoIncrement, rows: new Map(), seq: 0 });
    }
    transaction() {
      // What a dropped connection does: every new transaction throws.
      if (env.broken) throw new DOMException('The database connection is closing.', 'InvalidStateError');
      return new Tx(this);
    }
    close() {}
  }
  const idb = {
    open(name, version) {
      // What a browser refusing this site storage does.
      if (env.openThrows) throw new DOMException('The operation is insecure.', 'SecurityError');
      const req = new FakeRequest();
      later(() => {
        let db = env.dbs.get(name);
        if (!db) { db = new DB(name); env.dbs.set(name, db); }
        req.result = db;
        if (version && version > db.version) { db.version = version; req.onupgradeneeded?.(); }
        req.onsuccess?.();
      });
      return req;
    },
    deleteDatabase(name) { env.dbs.delete(name); },
  };
  /** A change already waiting when the page opens. */
  env.seed = (op) => {
    const name = 'nutritrace-offline-single';
    let db = env.dbs.get(name);
    if (!db) { db = new DB(name); env.dbs.set(name, db); db.createObjectStore('outbox', { keyPath: 'seq', autoIncrement: true }); }
    const out = db.stores.get('outbox');
    const seq = ++out.seq;
    out.rows.set(seq, { ...op, seq });
  };
  env.outbox = () => [...(env.dbs.get('nutritrace-offline-single')?.stores.get('outbox')?.rows.values() || [])];
  return { idb, env };
}

/** The HTTP API, recording what reached the server. */
function fakeHttp() {
  const sent = [];
  const ok = (name, answer) => async (...args) => { sent.push([name, ...args]); return answer(...args); };
  return {
    sent,
    updateProfile: ok('updateProfile', (d) => ({ user: { id: 1, username: 'alex', role: 'admin', ...d } })),
    saveDiaryDate: ok('saveDiaryDate', (date, d) => ({ ...d, date, id: 9 })),
    getDiaryDate: ok('getDiaryDate', (date) => ({ date, items: [{ name: 'Oats' }], water: [], body_stats: {} })),
    createFood: ok('createFood', (d) => ({ ...d, id: 41 })),
    updateFood: ok('updateFood', (id, d) => ({ ...d, id })),
    deleteFood: ok('deleteFood', () => ({ ok: true })),
    createMeal: ok('createMeal', (d) => ({ ...d, id: 51 })),
    updateMeal: ok('updateMeal', (id, d) => ({ ...d, id })),
    deleteMeal: ok('deleteMeal', () => ({ ok: true })),
    createActivity: ok('createActivity', (d) => ({ ...d, id: 61 })),
    updateActivity: ok('updateActivity', (id, d) => ({ ...d, id })),
    deleteActivity: ok('deleteActivity', () => ({ ok: true })),
    // The queue's push: the server refuses the food with no name, every time.
    post: ok('post', (path, body) => (path === '/api/sync/push' ? { foods: { error: 'NOT NULL constraint failed: foods.name' } } : { id: 71, ...body })),
    patch: ok('patch', (path, body) => ({ id: 71, ...body })),
    del: ok('del', () => ({ ok: true })),
    get: ok('get', () => []),
  };
}

let loads = 0;
/** A fresh copy of the offline layer, as a newly opened page has. */
async function page({ seed = [], openThrows = false } = {}) {
  const { idb, env } = fakeIndexedDB();
  env.openThrows = openThrows;
  for (const op of seed) env.seed(op);
  globalThis.indexedDB = idb;
  const mod = await import(`../src/lib/offline-api.js?page=${++loads}`);
  const http = fakeHttp();
  const api = mod.createOfflineApi(http);
  return { mod, api, http, env };
}

const REFUSED = { type: 'catalog', table: 'foods', action: 'create', id: -1000001, data: { brand: 'no name' }, at: 1 };
const PROFILE = { full_name: 'Alex Doe', nickname: 'Lex', birthday: '1990-04-02', gender: 'Female', avatar_url: '', email: '' };

test('storage that refuses to open: a profile save still reaches the server', async () => {
  setOnline(true);
  const { api, http } = await page({ openThrows: true });
  const answer = await api.updateProfile(PROFILE);
  assert.equal(answer.user.nickname, 'Lex');
  assert.deepEqual(http.sent.map(s => s[0]), ['updateProfile']);
});

test('storage that refuses to open: the diary still loads and saves', async () => {
  setOnline(true);
  const { api, http } = await page({ openThrows: true });
  const day = await api.getDiaryDate('2026-10-14');
  assert.equal(day.items[0].name, 'Oats');
  await api.saveDiaryDate('2026-10-14', { items: [], water: [], body_stats: {} });
  assert.deepEqual(http.sent.map(s => s[0]), ['getDiaryDate', 'saveDiaryDate']);
});

test('a change the server keeps refusing does not hold up a profile save', async () => {
  setOnline(true);
  const { mod, api, http, env } = await page({ seed: [REFUSED] });
  assert.equal(await mod.pendingCount(), 1);
  const answer = await api.updateProfile(PROFILE);
  // Sent now, answered by the server, not queued behind the refusal.
  assert.deepEqual(http.sent.map(s => s[0]), ['updateProfile']);
  assert.ok(!answer.queued);
  assert.equal(answer.user.role, 'admin');
  // The refused change is still kept, for the person to see and sort out.
  assert.deepEqual(env.outbox().map(o => o.type), ['catalog']);
});

test('a refused change waiting and the store breaking: a profile save still reaches the server', async () => {
  setOnline(true);
  const { mod, api, http, env } = await page({ seed: [REFUSED] });
  assert.equal(await mod.pendingCount(), 1);
  env.broken = true;
  const answer = await api.updateProfile(PROFILE);
  assert.equal(answer.user.nickname, 'Lex');
  assert.deepEqual(http.sent.map(s => s[0]), ['updateProfile']);
});

test('a refused change waiting and the store breaking: every other save still reaches the server', async () => {
  const saves = {
    saveDiaryDate: (api) => api.saveDiaryDate('2026-10-14', { items: [], water: [], body_stats: {} }),
    createFood: (api) => api.createFood({ name: 'Rye' }),
    updateFood: (api) => api.updateFood(41, { name: 'Rye' }),
    deleteFood: (api) => api.deleteFood(41),
    createMeal: (api) => api.createMeal({ name: 'Lunch' }),
    updateMeal: (api) => api.updateMeal(51, { name: 'Lunch' }),
    deleteMeal: (api) => api.deleteMeal(51),
    createActivity: (api) => api.createActivity({ name: 'Walk', kcal: 120 }),
    updateActivity: (api) => api.updateActivity(61, { name: 'Walk', kcal: 130 }),
    deleteActivity: (api) => api.deleteActivity(61),
    'post /api/fasts/start': (api) => api.post('/api/fasts/start', { goal_hours: 16 }),
  };
  // A fast change waiting too, or a new fast goes straight up anyway.
  const FAST_WAITING = { type: 'catalog', table: 'fasts', action: 'delete', id: 5, data: null, at: 1 };
  for (const [name, save] of Object.entries(saves)) {
    setOnline(true);
    const { mod, api, http, env } = await page({ seed: [REFUSED, FAST_WAITING] });
    assert.equal(await mod.pendingCount(), 2, name);
    env.broken = true;
    await save(api);
    assert.equal(http.sent.length, 1, `${name} reached the server`);
    // What was waiting is still counted, not forgotten.
    assert.equal(await mod.pendingCount(), 2, `${name} keeps the waiting count`);
  }
});

test('a save tried directly is never sent a second time when it can\'t be kept either', async () => {
  // The first try timed out (the server may have it); the queue then fails.
  setOnline(true);
  const { mod, api, http, env } = await page();
  await mod.pendingCount();
  env.broken = true;
  http.createFood = async (d) => { http.sent.push(['createFood', d]); throw new Error('The operation was aborted due to timeout'); };
  await assert.rejects(api.createFood({ name: 'Rye' }), (err) => err.storage === true);
  assert.equal(http.sent.length, 1);
});

test('a day naming a food made offline waits for the queue, whatever happens to storage', async () => {
  setOnline(true);
  const { mod, api, http, env } = await page({ seed: [REFUSED] });
  await mod.pendingCount();
  env.broken = true;
  await assert.rejects(api.saveDiaryDate('2026-10-14', { items: [{ name: 'Rye', food_id: -1700000000000001 }], water: [], body_stats: {} }), (err) => err.storage === true);
  assert.equal(http.sent.length, 0);
});

test('the queue keeps its order when it can still be read', async () => {
  // A day waiting to go up: a later save of any day waits behind it, as
  // before. Only a queue that can't be kept or read lets a save past.
  setOnline(true);
  const waitingDay = { type: 'diary', date: '2026-10-13', day: { items: [], water: [], body_stats: {} }, at: 1 };
  const { mod, api, http } = await page({ seed: [waitingDay] });
  assert.equal(await mod.pendingCount(), 1);
  const shown = await api.saveDiaryDate('2026-10-14', { items: [{ name: 'Rye' }], water: [], body_stats: {} });
  assert.equal(http.sent.length, 0, 'nothing sent ahead of the waiting day');
  assert.equal(shown.items[0].name, 'Rye');
  assert.equal(await mod.pendingCount(), 2);
});

test('an earlier profile save still waiting goes, and the new one takes its place', async () => {
  setOnline(true);
  const older = { type: 'request', kind: 'your profile', key: 'profile', method: 'PUT', path: '/api/auth/profile', body: { ...PROFILE, nickname: 'Old' }, at: 1 };
  const { mod, api, http, env } = await page({ seed: [older, REFUSED] });
  assert.equal(await mod.pendingCount(), 2);
  await api.updateProfile(PROFILE);
  assert.deepEqual(http.sent.map(s => [s[0], s[1].nickname]), [['updateProfile', 'Lex']]);
  // Never sent after the new one: it is gone from the queue.
  assert.deepEqual(env.outbox().map(o => o.type), ['catalog']);
  assert.equal(await mod.pendingCount(), 1);
});

test('with no Web Locks (plain http), a flush asked for during the save waits for it', async () => {
  setOnline(true);
  const older = { type: 'request', kind: 'your profile', key: 'profile', method: 'PUT', path: '/api/auth/profile', body: { ...PROFILE, nickname: 'Old' }, at: 1 };
  const { mod, api, http, env } = await page({ seed: [older] });
  assert.equal(await mod.pendingCount(), 1);
  let land;
  http.updateProfile = (d) => { http.sent.push(['updateProfile', d]); return new Promise(r => { land = () => r({ user: { id: 1, ...d } }); }); };
  http.put = async (path, body) => { http.sent.push(['put', body]); return { user: body }; };
  const saving = api.updateProfile(PROFILE);
  for (let i = 0; i < 200 && !land; i++) await new Promise(r => setImmediate(r));
  assert.ok(land, 'the new save went to the server');
  // The backoff timer, the online event or the tab coming back would do this.
  const flushing = mod.flushOutbox();
  land();
  await saving;
  await flushing;
  assert.deepEqual(http.sent.map(s => [s[0], s[1].nickname]), [['updateProfile', 'Lex']], 'the older save is never sent');
  assert.deepEqual(env.outbox(), []);
});

test('no connection: a profile save is kept to send later, and answers in the route\'s shape', async () => {
  setOnline(false);
  const { mod, api, http, env } = await page();
  const answer = await api.updateProfile(PROFILE);
  assert.equal(http.sent.length, 0);
  assert.equal(answer.queued, true);
  assert.equal(answer.user.nickname, 'Lex');
  assert.equal(await mod.pendingCount(), 1);
  assert.deepEqual(env.outbox().map(o => o.key), ['profile']);
  setOnline(true);
});

test('no connection and nowhere to keep it: the error says storage, not offline', async () => {
  for (const breakIt of [(env) => { env.full = true; }, (env) => { env.broken = true; }]) {
    setOnline(false);
    const { mod, api, http, env } = await page();
    await mod.pendingCount();
    breakIt(env);
    await assert.rejects(api.updateProfile(PROFILE), (err) => err.storage === true && !err.offline);
    await assert.rejects(api.saveDiaryDate('2026-10-14', { items: [], water: [], body_stats: {} }), (err) => err.storage === true && !err.offline);
    await assert.rejects(api.createFood({ name: 'Rye' }), (err) => err.storage === true && !err.offline);
    assert.equal(http.sent.length, 0);
  }
  setOnline(true);
});

test('an upload goes to the server whenever there is a connection, queue or not', async () => {
  setOnline(true);
  const { mod, api, http } = await page({ seed: [REFUSED] });
  assert.equal(await mod.pendingCount(), 1);
  http.uploadImage = async (file) => { http.sent.push(['uploadImage', file]); return '/uploads/a.jpg'; };
  assert.equal(await api.uploadImage({ name: 'a.jpg' }), '/uploads/a.jpg');
});
