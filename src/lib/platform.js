/**
 * platform.js — Runtime detection for Capacitor native vs web browser.
 *
 * All platform-specific branching in the app goes through this module.
 * Uses @capacitor/core for reliable detection (not window.Capacitor directly).
 */

import { Capacitor } from '@capacitor/core';

/**
 * True when running inside the Capacitor native shell (Android / iOS).
 * False in the browser (PWA, desktop).
 */
export const isNative = Capacitor.isNativePlatform();

/**
 * True when running on Android specifically.
 */
export const isAndroid = isNative && Capacitor.getPlatform() === 'android';

/**
 * True when running on iOS specifically.
 */
export const isIos = isNative && Capacitor.getPlatform() === 'ios';

/**
 * Native setup mode: 'local' | 'server' | null (not yet chosen).
 * Set during the Android onboarding wizard.
 */
export function getNativeMode() {
  if (!isNative) return null;
  return localStorage.getItem('nt:nativeMode') || null;
}

export function setNativeMode(mode) {
  if (mode) {
    localStorage.setItem('nt:nativeMode', mode);
  } else {
    localStorage.removeItem('nt:nativeMode');
  }
}

/**
 * The server URL to use for sync.
 * In web mode: always same-origin (relative URLs).
 * In native mode: read from localStorage, or null (standalone / offline-first).
 */
export function getServerUrl() {
  if (!isNative) return ''; // relative URLs — same origin
  return localStorage.getItem('nt:serverUrl') || null;
}

/**
 * Save the server URL for native sync mode.
 * Pass null to revert to standalone (offline-only) mode.
 */
export function setServerUrl(url) {
  if (url) {
    const clean = url.replace(/\/$/, '');
    localStorage.setItem('nt:serverUrl', clean);
    // Keep a copy for image cache lookups even after disconnecting
    localStorage.setItem('nt:lastServerUrl', clean);
  } else {
    localStorage.removeItem('nt:serverUrl');
    // Don't remove lastServerUrl — needed for cached image resolution
  }
}

/**
 * True when in native mode AND a server URL has been configured.
 * In this mode NtApi routes calls to the remote server + queues sync.
 */
export function isServerConnected() {
  return isNative && !!getServerUrl();
}

/**
 * True when running native but setup hasn't been completed yet.
 */
export function needsNativeSetup() {
  return isNative && !getNativeMode();
}

/** Store the JWT token for native server mode (used in Authorization header) */
export function setAuthToken(token) {
  if (token) localStorage.setItem('nt:authToken', token);
  else localStorage.removeItem('nt:authToken');
}

export function getAuthToken() {
  return localStorage.getItem('nt:authToken') || null;
}

/**
 * In-memory image cache map: server URL → local file URI.
 * Populated during sync by loadImageMap(). Used by resolveAssetUrl() synchronously.
 */
let _imageMap = {};

/** Load the image map from local DB into memory (call once on sync init) */
export async function loadImageMap() {
  if (!isNative) return;
  try {
    const { getDb } = await import('./db-native.js');
    const db = await getDb();
    const r = await db.query(`SELECT value FROM sync_meta WHERE key = 'image_map'`, []);
    const row = r?.values?.[0];
    if (row?.value) _imageMap = JSON.parse(row.value);
  } catch {}
}

/** Update the in-memory image map (called after image cache downloads) */
export function setImageMap(map) {
  _imageMap = map || {};
}

/**
 * Resolve a relative URL (e.g. /uploads/photo.jpg) to an absolute URL
 * when in native server mode. Checks local image cache first for offline support.
 * On web, returns the path unchanged.
 */
export function resolveAssetUrl(path) {
  if (!path) return path;
  if (path.startsWith('data:') || path.startsWith('file:') || path.startsWith('https://localhost')) return path;
  if (isNative) {
    // Always check local image cache first (fastest, works offline + disconnected)
    if (_imageMap[path]) return _imageMap[path];
    const url = getServerUrl() || localStorage.getItem('nt:lastServerUrl') || '';
    if (url) {
      const fullUrl = path.startsWith('http') ? path : url + path;
      if (_imageMap[fullUrl]) return _imageMap[fullUrl];
    }
    // External URLs (not on our server): proxy through server to avoid WebView blocking
    if (path.startsWith('http') && url) {
      const serverHost = new URL(url).host;
      if (!path.includes(serverHost)) {
        return url + '/api/proxy?url=' + encodeURIComponent(path);
      }
    }
    // Server-hosted images
    if (url && !path.startsWith('http')) return url + path;
    if (path.startsWith('http')) return path;
  }
  return path;
}

/**
 * Prefix an API path with the server URL when in native server-connected mode.
 * In web mode or native local mode, returns the path unchanged (relative URL).
 */
export function apiUrl(path) {
  if (isNative) {
    const url = getServerUrl();
    if (url) return url + path;
  }
  return path;
}
