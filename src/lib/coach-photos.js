/**
 * coach-photos.js: photos from a coaching conversation.
 *
 * They are private (the server hands them only to the two people in the
 * conversation), so an <img> can't point at them directly: the Android app
 * can't put its sign-in on an image request. Each one is fetched with the
 * sign-in, kept in this account's Cache Storage for a dead zone, and shown
 * from a blob URL. The copies go on sign-out and when a coach loses the
 * conversation.
 */
import { isNative, apiUrl, getAuthToken, getServerUrl } from './platform.js';

const PREFIX = 'nt-coach-photos-';
const _urls = new Map(); // path -> object URL, for this page's life

function _cacheName() {
  let uid = '';
  try { uid = localStorage.getItem('wl:userId') || ''; } catch { /* private mode */ }
  return PREFIX + uid;
}

async function _cache() {
  try { return typeof caches !== 'undefined' ? await caches.open(_cacheName()) : null; } catch { return null; }
}

/** A blob URL for a conversation photo (`/api/coaching/photos/<name>`), or
 *  null when it can't be had (no connection and no copy kept). */
export async function coachPhotoUrl(path) {
  if (!path) return null;
  if (path.startsWith('data:')) return path; // written here, not sent yet
  if (_urls.has(path)) return _urls.get(path);
  const cache = await _cache();
  let res = cache ? await cache.match(path).catch(() => null) : null;
  if (!res) {
    try {
      const headers = {};
      if (isNative && getServerUrl()) { const t = getAuthToken(); if (t) headers.Authorization = `Bearer ${t}`; }
      const r = await fetch(apiUrl(path), { headers, credentials: 'include', cache: 'no-store' });
      if (!r.ok) return null;
      const blob = await r.blob();
      res = new Response(blob, { headers: { 'Content-Type': r.headers.get('content-type') || blob.type } });
      if (cache) await cache.put(path, res.clone()).catch(() => {});
    } catch { return null; }
  }
  const url = URL.createObjectURL(await res.blob());
  _urls.set(path, url);
  return url;
}

/** Drop kept copies (a deleted message, a conversation this account lost). */
export async function forgetCoachPhotos(paths = []) {
  const cache = await _cache();
  for (const p of paths) {
    if (!p) continue;
    const u = _urls.get(p);
    if (u) { try { URL.revokeObjectURL(u); } catch { /* fine */ } _urls.delete(p); }
    if (cache) await cache.delete(p).catch(() => {});
  }
}

/** Every account's copies on this device (sign-out). */
export async function clearCoachPhotos() {
  for (const u of _urls.values()) { try { URL.revokeObjectURL(u); } catch { /* fine */ } }
  _urls.clear();
  try {
    if (typeof caches === 'undefined') return;
    for (const k of await caches.keys()) if (k.startsWith(PREFIX)) await caches.delete(k);
  } catch { /* no Cache Storage */ }
}
