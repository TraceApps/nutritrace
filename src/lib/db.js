/**
 * db.js - IndexedDB abstraction layer for NutriTrace
 */
const DB = (() => {
  const DB_NAME = 'nutritrace';
  const DB_VERSION = 2;
  let _db = null;

  let _initPromise = null;
  const STORES = {
    foodList: {
      keyPath: 'id',
      autoIncrement: true,
      indexes: [
        { name: 'dateTime', keyPath: 'dateTime', unique: false },
        { name: 'barcode', keyPath: 'barcode', unique: false },
        { name: 'name', keyPath: 'name', unique: false },
        { name: 'brand', keyPath: 'brand', unique: false },
        { name: 'categories', keyPath: 'categories', unique: false, multiEntry: true }
      ]
    },
    diary: {
      keyPath: 'id',
      autoIncrement: true,
      indexes: [
        { name: 'dateTime', keyPath: 'dateTime', unique: false },
        { name: 'date', keyPath: 'date', unique: false }
      ]
    },
    meals: {
      keyPath: 'id',
      autoIncrement: true,
      indexes: [
        { name: 'dateTime', keyPath: 'dateTime', unique: false },
        { name: 'name', keyPath: 'name', unique: false },
        { name: 'categories', keyPath: 'categories', unique: false, multiEntry: true }
      ]
    },
    recipes: {
      keyPath: 'id',
      autoIncrement: true,
      indexes: [
        { name: 'dateTime', keyPath: 'dateTime', unique: false },
        { name: 'name', keyPath: 'name', unique: false },
        { name: 'categories', keyPath: 'categories', unique: false, multiEntry: true }
      ]
    }
  };

  function _open() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        const txn = event.target.transaction;
        for (const [storeName, config] of Object.entries(STORES)) {
          if (!db.objectStoreNames.contains(storeName)) {
            // Fresh install: create store + all indexes
            const store = db.createObjectStore(storeName, {
              keyPath: config.keyPath,
              autoIncrement: config.autoIncrement
            });
            for (const idx of config.indexes) {
              store.createIndex(idx.name, idx.keyPath, {
                unique: idx.unique,
                multiEntry: idx.multiEntry || false
              });
            }
          } else {
            // Migration: add any indexes that are missing from existing store
            const store = txn.objectStore(storeName);
            for (const idx of config.indexes) {
              if (!store.indexNames.contains(idx.name)) {
                store.createIndex(idx.name, idx.keyPath, {
                  unique: idx.unique,
                  multiEntry: idx.multiEntry || false
                });
              }
            }
          }
        }
      };
      request.onsuccess = (event) => { _db = event.target.result; resolve(_db); };
      request.onerror = (event) => reject(event.target.error);
    });
  }

  function _getStore(storeName, mode) {
    return _db.transaction(storeName, mode || 'readonly').objectStore(storeName);
  }

  function _p(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  return {
    async init() {
      if (_db) return _db;
      if (!_initPromise) _initPromise = _open();
      return _initPromise;
    },
    add(store, item) {
      item.dateTime = item.dateTime || new Date().toISOString();
      return _p(_getStore(store, 'readwrite').add(item));
    },
    put(store, item) {
      return _p(_getStore(store, 'readwrite').put(item));
    },
    get(store, id) {
      return _p(_getStore(store).get(id));
    },
    getAll(store) {
      return _p(_getStore(store).getAll());
    },
    getByIndex(store, indexName, value) {
      return _p(_getStore(store).index(indexName).getAll(value));
    },
    getByIndexRange(store, indexName, lower, upper) {
      const range = IDBKeyRange.bound(lower, upper);
      return _p(_getStore(store).index(indexName).getAll(range));
    },
    delete(store, id) {
      return _p(_getStore(store, 'readwrite').delete(id));
    },
    clear(store) {
      return _p(_getStore(store, 'readwrite').clear());
    },
    count(store) {
      return _p(_getStore(store).count());
    },
    _settingKey(key) {
      const userId = localStorage.getItem('wl:userId');
      return userId ? `wl_u${userId}_${key}` : `wl_${key}`;
    },
    getSetting(key, def) {
      const raw = localStorage.getItem(this._settingKey(key));
      if (raw === null) return (def !== undefined ? def : null);
      try { return JSON.parse(raw); } catch(e) { return raw; }
    },
    setSetting(key, value, force = false) {
      const fullKey = this._settingKey(key);
      const next = JSON.stringify(value);
      // Early-exit if unchanged — prevents listener floods on mount and avoids
      // double-firing the server push from store.set() + global wl:setting listener.
      // `force=true` skips the early-exit and always dispatches the event;
      // needed by loadServerSettings after a logout+re-login because per-user-
      // scoped localStorage entries survive the logout, so a server-sourced
      // reload would silently no-op even though the in-memory stores re-
      // initialized with defaults during the post-logout reload.
      const prev = localStorage.getItem(fullKey);
      if (!force && prev === next) return;
      localStorage.setItem(fullKey, next);
      window.dispatchEvent(new CustomEvent('wl:setting', { detail: { key } }));
    },
    getAllSettings() {
      const prefix = this._settingKey('').replace(/[^_]*$/, ''); // e.g. 'wl_u3_' or 'wl_'
      const s = {};
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(prefix)) {
          const bare = k.slice(prefix.length);
          try { s[bare] = JSON.parse(localStorage.getItem(k)); }
          catch(e) { s[bare] = localStorage.getItem(k); }
        }
      }
      return s;
    },
    removeSetting(key) {
      localStorage.removeItem(this._settingKey(key));
    },
    /** Move every setting from one user-prefix to another. Used by the
     *  enable/disable user-management flows so wizard-configured settings
     *  (mealNames, dob, gender, goals, etc.) follow the user across the
     *  prefix change instead of getting orphaned. Pass `null` for the
     *  anonymous prefix (`wl_<key>`). Existing target keys are NOT
     *  overwritten — the new owner's choices win on collision. */
    migrateSettingsPrefix(fromUserId, toUserId) {
      const fromPrefix = fromUserId == null ? 'wl_' : `wl_u${fromUserId}_`;
      const toPrefix   = toUserId   == null ? 'wl_' : `wl_u${toUserId}_`;
      if (fromPrefix === toPrefix) return 0;
      let moved = 0;
      const orphans = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k || !k.startsWith(fromPrefix)) continue;
        // Exclude longer-prefixed keys like `wl_u12_*` from the bare `wl_` scan.
        if (fromPrefix === 'wl_' && /^wl_u\d+_/.test(k)) continue;
        orphans.push(k);
      }
      for (const fromKey of orphans) {
        const bare = fromKey.slice(fromPrefix.length);
        const toKey = toPrefix + bare;
        if (localStorage.getItem(toKey) === null) {
          localStorage.setItem(toKey, localStorage.getItem(fromKey));
          moved++;
        }
        localStorage.removeItem(fromKey);
      }
      return moved;
    },
    async searchFoods(query) {
      const all = await this.getAll('foodList');
      const q = query.toLowerCase();
      return all.filter(f =>
        (f.name && f.name.toLowerCase().includes(q)) ||
        (f.brand && f.brand.toLowerCase().includes(q))
      );
    },
    async getDiaryForDate(dateStr) {
      return this.getDate(dateStr);
    },
    /** Get diary entry for a specific date — uses the 'date' index for reliability */
    async getDate(dateStr) {
      // Try index-based lookup first (fast, avoids Safari cold-start getAll() timing bug)
      try {
        const results = await this.getByIndex('diary', 'date', dateStr);
        if (results && results.length > 0) return results[0];
      } catch(e) {
        console.warn('[DB] date index lookup failed (index may not exist yet):', e.message);
      }
      // Fallback: full scan with a small delay
      await new Promise(r => setTimeout(r, 80));
      const all = await this.getAll('diary');
      // Match by date field OR by dateTime prefix (handles legacy V1 entries without a date field)
      const found = all.find(e =>
        e.date === dateStr ||
        (!e.date && e.dateTime && e.dateTime.startsWith(dateStr))
      ) || null;
      // Auto-repair: if found via dateTime but missing date field, persist it
      if (found && !found.date) {
        console.log('[DB] repairing legacy entry: adding date field', dateStr, 'to id', found.id);
        const repaired = { ...found, date: dateStr };
        await this.put('diary', repaired).catch(() => {});
        return repaired;
      }
      return found;
    },
    /** Upsert a diary entry for a specific date */
    async saveDate(dateStr, entry) {
      const existing = await this.getDate(dateStr);
      if (existing && existing.id != null) {
        return this.put('diary', { ...entry, id: existing.id, date: dateStr });
      }
      return this.put('diary', { ...entry, date: dateStr });
    },
    async getDiaryRange(startDate, endDate) {
      const all = await this.getAll('diary');
      return all.filter(e => e.date >= startDate && e.date <= endDate);
    },
    /** Return all diary date keys (YYYY-MM-DD) that have entries */
    async getAllDates() {
      const all = await this.getAll('diary');
      return all.map(e => e.date).filter(k => /^\d{4}-\d{2}-\d{2}$/.test(String(k)));
    },
    /** Export all IndexedDB data + localStorage settings as one JSON blob */
    async exportAll() {
      const [foodList, diary, meals, recipes] = await Promise.all([
        this.getAll('foodList'),
        this.getAll('diary'),
        this.getAll('meals'),
        this.getAll('recipes'),
      ]);
      return { foodList, diary, meals, recipes, settings: this.getAllSettings(), exportedAt: new Date().toISOString() };
    },
    /** Restore from a JSON blob produced by exportAll() */
    async importAll(data) {
      for (const storeName of ['foodList', 'diary', 'meals', 'recipes']) {
        if (data[storeName] && Array.isArray(data[storeName])) {
          await this.clear(storeName);
          for (const item of data[storeName]) {
            await this.put(storeName, item);
          }
        }
      }
      if (data.settings && typeof data.settings === 'object') {
        for (const [key, value] of Object.entries(data.settings)) {
          this.setSetting(key, value);
        }
      }
    },
    /** Wipe all IndexedDB stores and localStorage settings */
    async clearAll() {
      await Promise.all([
        this.clear('foodList'),
        this.clear('diary'),
        this.clear('meals'),
        this.clear('recipes'),
      ]);
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith('wl_')) keys.push(k);
      }
      keys.forEach(k => localStorage.removeItem(k));
    }
  };
})();

export { DB };

/**
 * Returns today's date as YYYY-MM-DD in the user's LOCAL timezone.
 * Unlike new Date().toISOString().slice(0,10) which uses UTC and gives
 * tomorrow's date for US timezones after ~7-8 pm local time.
 */
export function localDateStr(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
