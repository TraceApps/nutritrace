/**
 * updates.js — In-app update checker.
 *
 * Checks GitHub Releases for newer versions of the app. On Android
 * (Capacitor native) downloads the APK asset and hands off to the
 * system installer. On PWA, the service worker handles client updates
 * itself; this module only checks the SERVER-update axis for admin UI.
 *
 * User-Agent is set explicitly per Fathom's self-update gotcha
 * (feature_traceapps_in_app_updates + project_fathom_self_update):
 * GitHub API rejects unauthenticated fetch() without a UA in some
 * scenarios and rate-limits harshly on shared IPs otherwise.
 *
 * Cadence:
 * - Check on mount, throttled to once per 24h via localStorage.
 * - "Check now" always runs immediately.
 * - No push notifications, no background poll.
 *

 * Channels (both platforms; Android uses this to pick the APK asset, PWA
 * uses it to pick which GitHub release the server-update banner
 * compares against):
 * - stable — /releases/latest (last tagged stable release)
 * - dev    — newest numbered pre-release matching v<M>.<m>.<p>-dev.<n>.
 *            NOT the literal `dev-latest` tag: that tag_name is the
 *            string "dev-latest", which parses as no valid semver so
 *            the version-compare would return equal and never prompt.
 *            Instead we list /releases, filter to prerelease=true with
 *            a numbered -dev.N tag, and pick the newest.
 */
import { writable } from 'svelte/store';
import { APP_VERSION } from './version.js';
import { isNative } from './platform.js';
import { DB } from './db.js';

const GH_OWNER = 'TraceApps';
const GH_REPO  = 'nutritrace';
const APP_NAME = 'NutriTrace';
const CACHE_KEY_LAST_CHECK   = 'wl_updates_last_check';   // ISO string
const CACHE_KEY_LATEST       = 'wl_updates_latest';       // JSON blob
const CACHE_KEY_SKIP_VERSION = 'wl_updates_skip_version'; // version string user chose to skip
const CACHE_KEY_CHANNEL      = 'wl_updates_channel';      // 'stable' | 'dev'
const CACHE_KEY_AUTO_CHECK   = 'wl_updates_auto_check';   // '1' | '0'

// Cadence in HOURS the user can pick in Settings → Updates. 0 = manual
// only (turns off every auto-check path — mount, visibility change, and
// the once-per-24h refresh below). Anything else is the throttle
// between real GitHub API calls; a check attempted inside the window
// resolves from the cached blob instead of hitting the network.
function _throttleMs() {
  const hours = Number(DB.getSetting('updateCheckInterval', 4)) || 0;
  if (!hours || hours < 0) return Infinity;         // manual only
  return Math.max(1, hours) * 60 * 60 * 1000;
}

// Shared reactive store for "there is an update available that the
// user hasn't already dismissed". Drives the top banner AND the dot
// on the Settings nav icon so both surfaces stay in sync with a single
// source of truth. Also holds the latest release blob so callers can
// render the version number without re-checking.
export const updateAvailable = writable({ available: false, latest: null });

const UA = `TraceApps-${APP_NAME}/${APP_VERSION}`;

/**
 * Parse a semver-like tag into { base:[M,m,p], pre:[…] }.
 * `pre` is the pre-release identifier chain (semver §9): each hyphen-
 * separated segment after the base version, split into dot-separated
 * identifiers. Numeric identifiers become numbers so `dev.10 > dev.9`.
 * Returns null for unparseable input.
 *
 * Examples:
 *   v1.0.4          → { base:[1,0,4], pre:[] }
 *   v1.1.0-dev.1    → { base:[1,1,0], pre:['dev', 1] }
 *   v1.1.0-dev.10   → { base:[1,1,0], pre:['dev', 10] }
 *   v1.1.0-rc.2     → { base:[1,1,0], pre:['rc', 2] }
 */
function _parseSemver(tag) {
  if (!tag) return null;
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(tag);
  if (!m) return null;
  const base = [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
  const pre = m[4]
    ? m[4].split('.').map(s => /^\d+$/.test(s) ? parseInt(s, 10) : s)
    : [];
  return { base, pre };
}

/**
 * Compare two semver-like tags. Returns 1 if a > b, -1 if a < b, 0 if equal
 * or unparseable. Follows the semver §11 precedence rules for pre-release
 * identifiers: numeric identifiers have lower precedence than
 * non-numeric; longer identifier chains outrank shorter identical
 * prefixes; a version with a pre-release identifier is LOWER precedence
 * than the same base without one (so `1.1.0 > 1.1.0-dev.1`, matching
 * "final release beats any pre-release for that version").
 */
export function compareSemver(a, b) {
  const pa = _parseSemver(a);
  const pb = _parseSemver(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa.base[i] > pb.base[i]) return 1;
    if (pa.base[i] < pb.base[i]) return -1;
  }
  // Base versions equal → pre-release comparison.
  // Empty pre-release (final release) outranks any pre-release.
  if (pa.pre.length === 0 && pb.pre.length === 0) return 0;
  if (pa.pre.length === 0) return 1;
  if (pb.pre.length === 0) return -1;
  const n = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < n; i++) {
    const ai = pa.pre[i], bi = pb.pre[i];
    if (ai === undefined) return -1;
    if (bi === undefined) return 1;
    if (typeof ai === 'number' && typeof bi === 'number') {
      if (ai > bi) return 1;
      if (ai < bi) return -1;
      continue;
    }
    if (typeof ai === 'number') return -1;
    if (typeof bi === 'number') return 1;
    if (ai > bi) return 1;
    if (ai < bi) return -1;
  }
  return 0;
}

export function getChannel() {
  try {
    return localStorage.getItem(CACHE_KEY_CHANNEL) || 'stable';
  } catch { return 'stable'; }
}

export function setChannel(channel) {
  try { localStorage.setItem(CACHE_KEY_CHANNEL, channel); } catch {}
}

export function getAutoCheck() {
  try {
    const v = localStorage.getItem(CACHE_KEY_AUTO_CHECK);
    return v === null ? true : v === '1';
  } catch { return true; }
}

export function setAutoCheck(on) {
  try { localStorage.setItem(CACHE_KEY_AUTO_CHECK, on ? '1' : '0'); } catch {}
}

export function getLastChecked() {
  try {
    const v = localStorage.getItem(CACHE_KEY_LAST_CHECK);
    return v ? new Date(v) : null;
  } catch { return null; }
}

export function getSkippedVersion() {
  try { return localStorage.getItem(CACHE_KEY_SKIP_VERSION) || ''; }
  catch { return ''; }
}

export function skipVersion(v) {
  try { localStorage.setItem(CACHE_KEY_SKIP_VERSION, v); } catch {}
}

/** Return the cached latest-release blob if within throttle window, else null. */
function _getCachedLatest() {
  try {
    const last = localStorage.getItem(CACHE_KEY_LAST_CHECK);
    if (!last) return null;
    if (Date.now() - new Date(last).getTime() > _throttleMs()) return null;
    const raw = localStorage.getItem(CACHE_KEY_LATEST);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

/** Refresh the shared reactive store from the latest cached blob +
 *  current skip-version. Idempotent, safe to call any time. */
export function refreshUpdateAvailableStore() {
  try {
    const raw = localStorage.getItem(CACHE_KEY_LATEST);
    const latest = raw ? JSON.parse(raw) : null;
    const skipped = getSkippedVersion();
    const available = !!(latest && isUpdateAvailable(latest) && skipped !== latest.version);
    updateAvailable.set({ available, latest: available ? latest : null });
  } catch {
    updateAvailable.set({ available: false, latest: null });
  }
}

/** Mark a version as skipped/dismissed. Clears both the banner and
 *  the Settings-nav dot in one call by refreshing the shared store. */
export function dismissForVersion(version) {
  if (version) skipVersion(version);
  refreshUpdateAvailableStore();
}

/**
 * Fetch the latest release from GitHub for the current channel.
 * Returns { version, notes, notesUrl, publishedAt, apkAsset } or null on failure.
 * apkAsset is { name, url, size } or null if no APK attached.
 *
 * When `force` is false and a valid cached result exists (within 24h),
 * returns the cached result without hitting the network.
 */
export async function checkForUpdate({ force = false } = {}) {
  if (!force) {
    const cached = _getCachedLatest();
    if (cached) return cached;
  }
  const channel = getChannel();
  const headers = {
    'Accept':     'application/vnd.github+json',
    'User-Agent': UA,
  };
  try {
    let data;
    if (channel === 'dev' || channel === 'beta') {
      // Beta is the legacy alias for Dev; kept accepted so older cached
      // values still resolve. List up to 30 recent releases, filter to
      // numbered -dev.N pre-releases, then SORT by semver descending —
      // GH's /releases endpoint doesn't guarantee semver order (dev.10
      // sorts after dev.2 in GH's default ordering, so `list[0]` picks
      // dev.9 even when dev.10 exists). Ignoring the `dev-latest`
      // floating tag itself (its tag_name is the string literal, not
      // a semver).
      const listRes = await fetch(
        `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/releases?per_page=30`,
        { headers },
      );
      if (!listRes.ok) throw new Error(`GitHub API ${listRes.status}`);
      const list = await listRes.json();
      // Accept both the legacy dotted format (v1.1.0-dev.14) and the
      // new no-dot format (v1.1.0-dev16). The switch was made mid-v1.1
      // for semver compliance (numeric identifiers can't have leading
      // zeros, so `dev.09` is invalid semver but `dev09` parses fine
      // as a single non-numeric identifier). Both parse cleanly and
      // compare correctly via compareSemver's pre-release chain rules.
      const devTag = /^v\d+\.\d+\.\d+-dev\.?\d+$/;
      const devReleases = list
        .filter(r => r.prerelease && devTag.test(r.tag_name || ''))
        .sort((a, b) => compareSemver(b.tag_name, a.tag_name));
      if (devReleases.length === 0) {
        return null;
      }
      data = devReleases[0];
    } else {
      const res = await fetch(
        `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/releases/latest`,
        { headers },
      );
      if (!res.ok) throw new Error(`GitHub API ${res.status}`);
      data = await res.json();
    }
    const apkAsset = (data.assets || []).find(a =>
      a.name && a.name.toLowerCase().endsWith('.apk')
    );
    const result = {
      version:     data.tag_name || data.name || '',
      name:        data.name || '',
      notes:       data.body || '',
      notesUrl:    data.html_url || '',
      publishedAt: data.published_at || '',
      apkAsset:    apkAsset ? {
        name: apkAsset.name,
        url:  apkAsset.browser_download_url,
        size: apkAsset.size,
      } : null,
    };
    try {
      localStorage.setItem(CACHE_KEY_LAST_CHECK, new Date().toISOString());
      localStorage.setItem(CACHE_KEY_LATEST, JSON.stringify(result));
    } catch {}
    // Keep the shared store in sync so the banner + Settings-nav dot
    // update automatically whenever a check runs (mount, visibility
    // change, "Check now" button, or the throttled 4h auto-check).
    refreshUpdateAvailableStore();
    return result;
  } catch (e) {
    console.warn('[updates] check failed:', e?.message || e);
    return null;
  }
}

/** True when `latest.version` is strictly greater than the running APP_VERSION. */
export function isUpdateAvailable(latest) {
  if (!latest || !latest.version) return false;
  return compareSemver(latest.version, APP_VERSION) > 0;
}

/**
 * Extract the semver from an APK filename our downloader writes.
 * Names follow `nutritrace-<version>.apk` — same shape as GH release
 * assets. Anything else returns null (safer than guessing).
 */
function _apkVersionFromName(name) {
  if (!name || !name.toLowerCase().endsWith('.apk')) return null;
  const m = /-v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\.apk$/i.exec(name);
  return m ? `v${m[1]}` : null;
}

/**
 * Return the current state of Directory.Data/updates/ so the Settings
 * panel can show users what's cached. Native-only; PWA returns null.
 * Result: { files: [{name, size, version}], totalBytes }.
 * Silent-on-error: any FS problem yields an empty result rather than
 * throwing, since this is purely diagnostic UX.
 */
export async function getUpdateCacheInfo() {
  if (!isNative) return null;
  try {
    const { Filesystem, Directory } = await import('@capacitor/filesystem');
    let listing;
    try {
      listing = await Filesystem.readdir({ path: 'updates', directory: Directory.Data });
    } catch { return { files: [], totalBytes: 0 }; }
    const raw = listing?.files || [];
    const files = raw
      .map(f => {
        const name = typeof f === 'string' ? f : f?.name;
        if (!name) return null;
        const size = typeof f === 'object' ? Number(f.size || 0) : 0;
        return { name, size, version: _apkVersionFromName(name) || '' };
      })
      .filter(Boolean);
    const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
    return { files, totalBytes };
  } catch {
    return { files: [], totalBytes: 0 };
  }
}

/**
 * Manually wipe everything under Directory.Data/updates/. Exposed to
 * the Settings panel as a "Clear Now" button so users can reclaim
 * space without waiting for the next boot cleanup pass. Native-only.
 */
export async function clearUpdateCache() {
  if (!isNative) return;
  try {
    const { Filesystem, Directory } = await import('@capacitor/filesystem');
    const listing = await Filesystem.readdir({ path: 'updates', directory: Directory.Data }).catch(() => null);
    for (const f of (listing?.files || [])) {
      const name = typeof f === 'string' ? f : f?.name;
      if (name) {
        try {
          await Filesystem.deleteFile({ path: `updates/${name}`, directory: Directory.Data });
        } catch { /* keep going */ }
      }
    }
  } catch { /* best-effort */ }
}

/** Format a byte count into a compact human-readable string. */
export function formatBytes(n) {
  if (!n || n < 0) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * Wipe stale APKs from Directory.Data/updates/. Called at app boot AND
 * before each fresh download. Two invariants:
 *   - After a successful in-app update, the APK that triggered the
 *     install is no longer needed. The system installer already replaced
 *     the app; on next boot the running APP_VERSION is that APK's
 *     version, so any file whose parsed version is ≤ APP_VERSION is
 *     stale and gets deleted.
 *   - `alsoOlderThanDays` sweeps orphans from downloads that never got
 *     installed (user cancelled the system dialog, etc.).
 *
 * Runs silently — filesystem errors are swallowed since this is
 * best-effort housekeeping, not a critical path.
 */
export async function cleanUpdateCache({ alsoOlderThanDays = 7 } = {}) {
  if (!isNative) return;
  try {
    const { Filesystem, Directory } = await import('@capacitor/filesystem');
    let listing;
    try {
      listing = await Filesystem.readdir({ path: 'updates', directory: Directory.Data });
    } catch { return; /* updates/ doesn't exist yet — nothing to clean */ }
    const files = listing?.files || [];
    const cutoffMs = Date.now() - (alsoOlderThanDays * 24 * 60 * 60 * 1000);
    for (const f of files) {
      const name = typeof f === 'string' ? f : f?.name;
      if (!name || !name.toLowerCase().endsWith('.apk')) continue;
      const fileVer = _apkVersionFromName(name);
      const mtimeMs = typeof f === 'object' ? (f.mtime || f.ctime || 0) : 0;
      const isStaleByVersion = fileVer && compareSemver(fileVer, APP_VERSION) <= 0;
      const isStaleByAge     = mtimeMs > 0 && mtimeMs < cutoffMs;
      if (isStaleByVersion || isStaleByAge) {
        try {
          await Filesystem.deleteFile({ path: `updates/${name}`, directory: Directory.Data });
        } catch { /* keep going */ }
      }
    }
  } catch { /* best-effort — never let cleanup crash the app */ }
}

/**
 * Download the APK to app storage and hand off to the Android system
 * installer. Android/Capacitor-only. Progress callback receives 0-100.
 * Throws on non-native platforms or download failure.
 *
 * Uses Capacitor's native Filesystem.downloadFile (Java/Kotlin download
 * on the Android side) instead of `fetch` + `blob`. Two reasons the
 * WebView-fetch path was wrong for this workload:
 *   1. GitHub Releases asset URLs (github.com/.../releases/download/...)
 *      return a 302 to `objects.githubusercontent.com`. The WebView's
 *      cross-origin fetch rules reject that redirect chain in some
 *      Chromium versions, showing "failed to fetch" instantly.
 *   2. Buffering a 57 MB APK as a Blob and then base64-encoding for
 *      Filesystem.writeFile roughly triples memory during the write.
 *      Native download streams straight to disk.
 */
export async function downloadAndInstallApk(latest, onProgress) {
  if (!isNative) throw new Error('APK install only available in the Android app');
  if (!latest?.apkAsset) throw new Error('No APK asset in this release');
  const { Filesystem, Directory } = await import('@capacitor/filesystem');

  const path = `updates/${latest.apkAsset.name}`;

  // Filesystem.downloadFile accepts { recursive: true } but that flag
  // doesn't reliably create the parent directory on Capacitor 8's
  // Android side — the underlying openFileOutput call throws ENOENT
  // when updates/ doesn't already exist. Ensure it up-front.
  try {
    await Filesystem.mkdir({ path: 'updates', directory: Directory.Data, recursive: true });
  } catch (e) {
    // ok if it already exists — plugin throws "Directory exists" in that case.
    if (!/exist/i.test(e?.message || '')) throw e;
  }

  // Delete any existing APK files in updates/ before writing the new
  // one. Prior downloads (successful or cancelled) leave ~57 MB files
  // sitting around; without this, /data/user/0/.../files/updates/
  // grows unbounded over time. Version-based cleanup at app boot
  // (cleanUpdateCache) catches whatever we don't delete here.
  try {
    const existing = await Filesystem.readdir({ path: 'updates', directory: Directory.Data });
    for (const f of (existing?.files || [])) {
      const name = typeof f === 'string' ? f : f?.name;
      if (name && name.toLowerCase().endsWith('.apk')) {
        try {
          await Filesystem.deleteFile({ path: `updates/${name}`, directory: Directory.Data });
        } catch { /* ignore */ }
      }
    }
  } catch { /* updates/ might not exist yet */ }

  // Wire native progress events (Capacitor Filesystem 5.0+). Silently
  // no-ops on older builds — fall back to a fake 0 → 100 flip on
  // completion so the UI doesn't just hang without feedback.
  let progressHandle = null;
  try {
    progressHandle = await Filesystem.addListener('progress', ev => {
      if (!ev || !ev.bytes || !ev.contentLength || !onProgress) return;
      onProgress(Math.min(99, Math.floor(ev.bytes / ev.contentLength * 100)));
    });
  } catch { /* older Filesystem — no progress events */ }

  try {
    await Filesystem.downloadFile({
      url: latest.apkAsset.url,
      path,
      directory: Directory.Data,
      recursive: true,
      progress: true,
      // Explicit UA so GitHub is happy with anonymous asset pulls.
      headers: { 'User-Agent': UA },
    });
  } catch (e) {
    throw new Error(e?.message || 'Download failed');
  } finally {
    if (progressHandle && typeof progressHandle.remove === 'function') {
      try { await progressHandle.remove(); } catch {}
    }
  }

  if (onProgress) onProgress(100);
  const { uri } = await Filesystem.getUri({ path, directory: Directory.Data });

  // Hand off to system installer. @capacitor-community/file-opener wraps
  // Android's Intent.ACTION_VIEW + FileProvider dance, resolving the
  // file:// URI to a content:// URI via the app's FileProvider (declared
  // in AndroidManifest.xml with authority ${applicationId}.fileprovider
  // and file-paths pointing at files-path updates/). The system routes
  // application/vnd.android.package-archive to the package installer,
  // which prompts the user for install approval.
  const { FileOpener } = await import('@capacitor-community/file-opener');
  try {
    await FileOpener.open({
      filePath: uri,
      contentType: 'application/vnd.android.package-archive',
    });
  } catch (e) {
    throw new Error(`Could not open installer: ${e?.message || e}`);
  }
}

/** Format an ISO date for the "Last checked: X ago" label. */
export function formatAgo(dateOrIso) {
  if (!dateOrIso) return '';
  const d = dateOrIso instanceof Date ? dateOrIso : new Date(dateOrIso);
  const s = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  return `${days}d ago`;
}

/**
 * Fetch server-update status (PWA + admin only path). Passes the user's
 * current channel to the server so a Dev-channel PWA admin sees
 * whether the running server is behind the latest -dev.N release
 * (not the stable one). Server caches per-channel for 24h; pass
 * force=true to bypass that cache (used by the manual "Check Now"
 * button so a newly-published -dev.N is picked up immediately).
 *
 * Returns { current, latest, channel, available, notes_url, checked_at }
 * or null on failure / non-admin / native app (not applicable).
 */
export async function checkServerUpdate({ force = false } = {}) {
  if (isNative) return null; // Server-update banner is PWA-only.
  try {
    const { apiUrl } = await import('./platform.js');
    const channel = (getChannel() === 'dev' || getChannel() === 'beta') ? 'dev' : 'stable';
    const qs = `?channel=${channel}${force ? '&force=1' : ''}`;
    const res = await fetch(apiUrl(`/api/updates/server-status${qs}`), {
      credentials: 'include',
    });
    if (res.status === 403) return null; // Non-admin — no banner.
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}
