/**
 * image-cache.js — Download and cache server images to local device storage.
 *
 * During sync, scans all cached foods/meals/diary for server image URLs,
 * downloads them, saves to Capacitor Filesystem, and stores a mapping
 * so resolveAssetUrl() can return the local path when offline.
 */

import { Filesystem, Directory } from '@capacitor/filesystem';
import { Capacitor } from '@capacitor/core';
import { getServerUrl, getAuthToken } from './platform.js';

const CACHE_DIR = 'image_cache';

/**
 * Download a single image from the server and cache it locally.
 * Returns the local file URI, or null on failure.
 */
async function _downloadImage(serverUrl) {
  if (!serverUrl || !serverUrl.startsWith('http')) return null;

  // Extract filename from URL
  const urlPath = new URL(serverUrl).pathname;
  const filename = urlPath.split('/').pop();
  if (!filename) return null;

  // Check if already cached
  try {
    const existing = await Filesystem.stat({
      path: `${CACHE_DIR}/${filename}`,
      directory: Directory.Data,
    });
    if (existing.uri) return Capacitor.convertFileSrc(existing.uri);
  } catch {
    // Not cached yet — download
  }

  try {
    // Use CapacitorHttp to bypass CORS (fetch() is blocked by WebView CORS policy)
    const { CapacitorHttp } = await import('@capacitor/core');
    const response = await CapacitorHttp.get({
      url: serverUrl,
      responseType: 'blob',
    });
    if (response.status < 200 || response.status >= 300) return null;

    // CapacitorHttp returns base64 data for blob responseType
    const base64 = response.data;
    if (!base64) return null;

    await Filesystem.writeFile({
      path: `${CACHE_DIR}/${filename}`,
      data: base64,
      directory: Directory.Data,
      recursive: true,
    });

    const { uri } = await Filesystem.getUri({
      path: `${CACHE_DIR}/${filename}`,
      directory: Directory.Data,
    });

    // Convert file:// URI to Capacitor's WebView-safe URL
    return Capacitor.convertFileSrc(uri);
  } catch (e) {
    console.warn('[image-cache] Failed to download:', serverUrl, e.message);
    return null;
  }
}

/**
 * Build the image mapping table: server URL → local URI.
 * Stored in sync_meta as JSON so resolveAssetUrl can use it.
 */
async function _loadImageMap() {
  try {
    const { getDb } = await import('./db-native.js');
    const db = await getDb();
    const r = await db.query(`SELECT value FROM sync_meta WHERE key = 'image_map'`, []);
    const row = r?.values?.[0];
    if (row?.value) return JSON.parse(row.value);
  } catch {}
  return {};
}

async function _saveImageMap(map) {
  try {
    const { getDb } = await import('./db-native.js');
    const db = await getDb();
    await db.run(
      `INSERT INTO sync_meta (key, value) VALUES ('image_map', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [JSON.stringify(map)]
    );
  } catch {}
}

/**
 * Scan server data for image URLs and download them to the device.
 * Fetches food/meal/diary lists from the SERVER (not local DB) to ensure
 * we have the complete set of images before going offline.
 * Calls onProgress(downloaded, total) for UI updates.
 */
export async function cacheAllImages(onProgress) {
  const serverUrl = getServerUrl();
  if (!serverUrl) return { total: 0, downloaded: 0, failed: 0 };

  const imageMap = await _loadImageMap();
  const token = getAuthToken();
  const headers = token ? { 'Authorization': `Bearer ${token}` } : {};

  // Fetch image URLs from server
  const urlPairs = []; // [{ relative, full }]

  function addUrl(imgUrl) {
    if (!imgUrl) return;
    // Skip Capacitor cached paths and data URIs
    if (imgUrl.includes('_capacitor_file_') || imgUrl.startsWith('data:') || imgUrl.startsWith('file:')) return;
    try {
      const rel = imgUrl.startsWith('http') ? new URL(imgUrl).pathname : imgUrl;
      const full = imgUrl.startsWith('http') ? imgUrl : serverUrl + imgUrl;
      urlPairs.push({ relative: rel, full });
    } catch {
      // Invalid URL — skip
    }
  }

  // User avatar
  try {
    const cachedUser = localStorage.getItem('nt:cachedUser');
    if (cachedUser) {
      const user = JSON.parse(cachedUser);
      if (user.avatar_url) addUrl(user.avatar_url);
    }
  } catch {}

  try {
    const foods = await fetch(`${serverUrl}/api/foods`, { headers }).then(r => r.json());
    for (const f of foods) addUrl(f.img_url);
  } catch {}

  try {
    const meals = await fetch(`${serverUrl}/api/meals`, { headers }).then(r => r.json());
    for (const m of meals) addUrl(m.img_url);
  } catch {}

  try {
    const diary = await fetch(`${serverUrl}/api/diary`, { headers }).then(r => r.json());
    for (const d of diary) {
      const items = typeof d.items === 'string' ? JSON.parse(d.items) : (d.items || []);
      for (const item of items) addUrl(item.imgUrl || item.img_url);
    }
  } catch {}

  // Deduplicate and filter out already-cached
  const seen = new Set();
  const toDownload = urlPairs.filter(p => {
    if (seen.has(p.full)) return false;
    seen.add(p.full);
    return !imageMap[p.relative] && !imageMap[p.full];
  });
  const total = toDownload.length;
  let downloaded = 0;
  let failed = 0;

  if (onProgress) onProgress(0, total);

  for (const pair of toDownload) {
    const localUri = await _downloadImage(pair.full);
    if (localUri) {
      // Store both relative and full URL as keys so lookup works in any mode
      imageMap[pair.relative] = localUri;
      imageMap[pair.full] = localUri;
      downloaded++;
    } else {
      failed++;
    }
    if (onProgress) onProgress(downloaded + failed, total);
  }

  // Save updated map
  await _saveImageMap(imageMap);

  console.log(`[image-cache] Done: ${downloaded} downloaded, ${failed} failed, ${Object.keys(imageMap).length} total cached`);
  return { total, downloaded, failed };
}

/**
 * Resolve a server image URL to a local cached URI if available.
 * Used by resolveAssetUrl() in platform.js.
 */
let _cachedMap = null;
export async function resolveFromCache(serverUrl) {
  if (!_cachedMap) _cachedMap = await _loadImageMap();
  return _cachedMap[serverUrl] || null;
}

