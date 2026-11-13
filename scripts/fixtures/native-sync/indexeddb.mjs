// Enough of IndexedDB, in memory, for the browser's offline queue to run in
// Node (scripts/android-sync.test.js, NT_BROWSER=1). Only what
// src/lib/offline-api.js uses: open/upgrade, transactions by store name,
// put/add/get/getAll/delete/clear, and the request events.
const databases = new Map();

class FakeRequest {
  constructor() {
    this.result = undefined;
    this.error = null;
    this.onsuccess = null;
    this.onerror = null;
    this.onupgradeneeded = null;
    this.onblocked = null;
  }
}

class FakeStore {
  constructor(name, options = {}) {
    this.name = name;
    this.keyPath = options.keyPath ?? null;
    this.autoIncrement = !!options.autoIncrement;
    this.rows = new Map();
    this.nextKey = 1;
  }

  _key(value, given) {
    if (given !== undefined) return given;
    return this.keyPath ? value?.[this.keyPath] : undefined;
  }

  _done(result) {
    const req = new FakeRequest();
    req.result = result;
    // As a browser does: the handlers are attached after the call returns.
    setTimeout(() => { try { req.onsuccess?.({ target: req }); } catch { /* a test's handler */ } }, 0);
    return req;
  }

  put(value, given) {
    let key = this._key(value, given);
    if (key === undefined && this.autoIncrement) key = this.nextKey++;
    if (key === undefined) throw new Error('no key for the row');
    if (this.autoIncrement && typeof key === 'number') this.nextKey = Math.max(this.nextKey, key + 1);
    this.rows.set(key, value);
    return this._done(key);
  }

  add(value, given) {
    if (this.autoIncrement) {
      const key = this.nextKey++;
      const row = this.keyPath ? { ...value, [this.keyPath]: key } : value;
      this.rows.set(key, row);
      return this._done(key);
    }
    const key = this._key(value, given);
    if (this.rows.has(key)) throw new Error('already here');
    this.rows.set(key, value);
    return this._done(key);
  }

  get(key) { return this._done(this.rows.get(key)); }
  getAll() { return this._done([...this.rows.values()]); }
  delete(key) { this.rows.delete(key); return this._done(undefined); }
  clear() { this.rows.clear(); return this._done(undefined); }
}

class FakeDB {
  constructor(record, name) {
    this._record = record;
    this.name = name;
    this.objectStoreNames = { contains: store => record.stores.has(store) };
  }

  createObjectStore(name, options) {
    const store = new FakeStore(name, options);
    this._record.stores.set(name, store);
    return store;
  }

  transaction() {
    const record = this._record;
    const tx = {
      objectStore: name => record.stores.get(name),
      oncomplete: null,
      onerror: null,
      onabort: null,
    };
    // _tx() attaches handlers after calling the operations, as the app does.
    setTimeout(() => { try { tx.oncomplete?.({ target: tx }); } catch { /* a test's handler */ } }, 0);
    return tx;
  }

  close() {}
}

globalThis.IDBRequest = FakeRequest;
globalThis.indexedDB = {
  open(name, version = 1) {
    const req = new FakeRequest();
    setTimeout(() => {
      let record = databases.get(name);
      const fresh = !record;
      if (!record) {
        record = { version, stores: new Map() };
        databases.set(name, record);
      }
      const db = new FakeDB(record, name);
      if (fresh || version > record.version) {
        record.version = Math.max(record.version, version);
        req.result = db;
        req.onupgradeneeded?.({ target: req });
      }
      req.result = db;
      req.onsuccess?.({ target: req });
    }, 0);
    return req;
  },
  deleteDatabase(name) { databases.delete(name); },
};
