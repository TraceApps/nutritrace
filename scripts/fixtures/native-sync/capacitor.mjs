// The app's files directory, kept beside the phone's database (a copy of
// the database alone is what a backup restore looks like: the install id
// file isn't in a backup). Directory listings stay empty.
import { mkdirSync, rmSync as _rm, existsSync } from 'node:fs';
import { dirname as _dirname, join as _join } from 'node:path';
const _filePath = (directory, path) => (process.env.PHONE_DB ? _join(process.env.PHONE_DB + '.files', String(directory || 'DATA'), String(path)) : null);
export const Filesystem = {
  readdir: async () => ({ files: [] }),
  stat: async ({ path, directory }) => { const f = _filePath(directory, path); if (!f || !existsSync(f)) throw new Error('File does not exist'); return { type: 'file' }; },
  readFile: async ({ path, directory }) => { const f = _filePath(directory, path); if (!f || !existsSync(f)) throw new Error('File does not exist'); return { data: readFileSync(f, 'utf8') }; },
  writeFile: async ({ path, directory, data }) => { const f = _filePath(directory, path); if (f) { mkdirSync(_dirname(f), { recursive: true }); writeFileSync(f, String(data ?? '')); } return { uri: 'file://' + (f || path) }; },
  mkdir: async () => ({}),
  deleteFile: async ({ path, directory }) => { const f = _filePath(directory, path); if (f) _rm(f, { force: true }); return {}; },
};
export const Directory = { Data: 'DATA', Cache: 'CACHE' };
export const Capacitor = { isNativePlatform: () => true, convertFileSrc: x => x, getPlatform: () => 'android' };
export const Network = { getStatus: async () => ({ connected: true, connectionType: 'wifi' }) };
// Android's cookie jar. Capacitor makes it the process's CookieHandler, so
// every native request (CapacitorHttp, and the Health Connect worker's
// HttpURLConnection) stores what a response sets and sends it to that host
// again, next to whatever Authorization header the request has. Kept in a
// file beside the phone's database, as the phone keeps it on disk. A Secure
// cookie is never stored from plain http, as Android's jar does. The
// WebView's fetch (global fetch here) doesn't send this cross-site cookie.
import { readFileSync, writeFileSync } from 'node:fs';
const jarFile = () => (process.env.PHONE_DB ? process.env.PHONE_DB + '.cookies.json' : null);
const hostOf = u => { try { return new URL(u).host; } catch { return ''; } };
function readJar() { try { return JSON.parse(readFileSync(jarFile(), 'utf8')); } catch { return {}; } }
function writeJar(j) { if (jarFile()) writeFileSync(jarFile(), JSON.stringify(j)); }
async function http(method, o) {
  const host = hostOf(o.url);
  const headers = { ...(o.headers || {}) };
  const kept = readJar()[host];
  if (kept && Object.keys(kept).length) headers.Cookie = Object.entries(kept).map(([k, v]) => `${k}=${v}`).join('; ');
  const body = o.data == null ? undefined : (typeof o.data === 'string' ? o.data : JSON.stringify(o.data));
  const r = await fetch(o.url, { method, headers, body });
  const jar = readJar();
  for (const c of r.headers.getSetCookie?.() || []) {
    const [pair, ...attrs] = c.split(';').map(x => x.trim());
    const i = pair.indexOf('=');
    const name = pair.slice(0, i), value = pair.slice(i + 1);
    const gone = !value || attrs.some(a => /^expires=thu, 01 jan 1970/i.test(a) || /^max-age=0$/i.test(a));
    // Capacitor stores it at the request's host and again at the app's own
    // address (CapacitorCookieManager.put).
    const at = [hostOf(globalThis.location?.origin)];
    if (!(attrs.some(a => /^secure$/i.test(a)) && o.url.startsWith('http:'))) at.push(host);
    for (const h of at) {
      jar[h] = jar[h] || {};
      if (gone) delete jar[h][name]; else jar[h][name] = value;
    }
  }
  writeJar(jar);
  const t = await r.text();
  let data = t;
  try { data = JSON.parse(t); } catch { /* text */ }
  return { status: r.status, data, headers: Object.fromEntries(r.headers) };
}
export const CapacitorHttp = {
  get: o => http('GET', o), post: o => http('POST', o), put: o => http('PUT', o),
  delete: o => http('DELETE', o), request: o => http(o.method || 'GET', o),
};
export const CapacitorCookies = {
  clearAllCookies: async () => { writeJar({}); },
  clearCookies: async ({ url }) => { const j = readJar(); delete j[hostOf(url)]; writeJar(j); },
  getCookies: async ({ url } = {}) => readJar()[hostOf(url)] || {},
  setCookie: async ({ url, key, value }) => { const j = readJar(); const h = hostOf(url); j[h] = { ...(j[h] || {}), [key]: value }; writeJar(j); },
  deleteCookie: async ({ url, key }) => { const j = readJar(); delete j[hostOf(url)]?.[key]; writeJar(j); },
  // Every host's cookies (a test's view of the whole jar).
  _all: async () => readJar(),
};
export const App = { addListener() {} };
export default {};
