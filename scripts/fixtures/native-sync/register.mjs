// Runs the app's own native modules (db-native.js, sync.js, api-cached.js,
// stores) in Node, as an Android phone in server mode: SQLite comes from
// better-sqlite3 behind a stand-in for the Capacitor plugin, the platform
// from env vars (NT_SERVER, NT_TOKEN, PHONE_DB). SKEW_MS shifts the
// phone's clock. Used by scripts/android-sync.test.js.
import { register } from 'node:module';
if (process.env.SKEW_MS) {
  const skew = Number(process.env.SKEW_MS), R = Date;
  globalThis.Date = class extends R {
    constructor(...a) { if (a.length) super(...a); else super(R.now() + skew); }
    static now() { return R.now() + skew; }
  };
}
const store = new Map();
globalThis.localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k), clear: () => store.clear(), key: i => [...store.keys()][i] ?? null,
  get length() { return store.size; },
};
const et = new EventTarget();
globalThis.window = globalThis;
globalThis.addEventListener = et.addEventListener.bind(et);
globalThis.removeEventListener = et.removeEventListener.bind(et);
globalThis.dispatchEvent = et.dispatchEvent.bind(et);
if (typeof globalThis.CustomEvent === 'undefined') {
  globalThis.CustomEvent = class extends Event { constructor(t, o = {}) { super(t, o); this.detail = o.detail; } };
}
globalThis.location = { origin: 'https://localhost', href: 'https://localhost/', pathname: '/', search: '', hash: '' };
globalThis.document = { addEventListener() {}, removeEventListener() {}, visibilityState: 'visible', documentElement: { classList: { add() {}, remove() {}, toggle() {} } } };
register('./hooks.mjs', import.meta.url);
