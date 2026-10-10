/**
 * updates.js — server-side update-status endpoint.
 *
 * Admin-only. Reports the running server's APP_VERSION and the latest
 * release tagged on GitHub, so the PWA Settings page can show admins a
 * "your server is behind" banner with a copy-paste `docker-compose pull`
 * command. Result is cached in app_config for 24h to stay under the
 * unauthenticated GitHub API rate limit (60/hr per IP).
 *
 * Docker `:latest` deployments already auto-track new releases; this
 * banner tells the admin WHEN a `docker-compose pull` would actually
 * pick something up. Admins on pinned tags (`:1.0` / `:1`) can see when
 * a new patch is available too.
 */
import { Router } from 'express';
import db from '../db.js';
import { wrap } from '../logger.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { APP_VERSION } from './version-source.js';
import { updateCheckEnabled, setUpdateCheckEnabled, updateCheckAnswered, envLocksUpdateCheck } from '../lib/update-check.js';

const router = Router();

// Cache buckets keyed per channel so switching Stable/Dev doesn't
// return stale data from the other channel. Both TTLs are 24h.
const CACHE_KEYS = {
  stable: {
    latest:    'updates_server_latest',
    checkedAt: 'updates_server_checked_at',
    notesUrl:  'updates_server_notes_url',
    notes:     'updates_server_notes',
    publishedAt: 'updates_server_published_at',
  },
  dev: {
    latest:    'updates_server_latest_dev',
    checkedAt: 'updates_server_checked_at_dev',
    notesUrl:  'updates_server_notes_url_dev',
    notes:     'updates_server_notes_dev',
    publishedAt: 'updates_server_published_at_dev',
  },
};
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const GH_REPO_URL  = 'https://api.github.com/repos/TraceApps/nutritrace';
const DEV_TAG_RE   = /^v\d+\.\d+\.\d+-dev\.?\d+$/;
const UA = `TraceApps-NutriTrace-Server/${APP_VERSION}`;

function _getCfg(key) {
  const row = db.prepare('SELECT value FROM app_config WHERE key = ?').get(key);
  return row?.value || null;
}
function _setCfg(key, value) {
  db.prepare('INSERT INTO app_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}

async function _fetchLatest(channel) {
  const headers = { 'Accept': 'application/vnd.github+json', 'User-Agent': UA };
  let data;
  if (channel === 'dev') {
    // List recent releases, filter to numbered -dev.N pre-releases,
    // then SORT by semver descending. GH's /releases endpoint doesn't
    // guarantee semver order — `dev.10` typically sorts after `dev.2`
    // in the default list, so picking `[0]` returns the wrong newest.
    // Skips the `dev-latest` floating tag whose tag_name is the string
    // literal (not a semver), which would defeat version-compare.
    const res = await fetch(`${GH_REPO_URL}/releases?per_page=30`, { headers });
    if (!res.ok) throw new Error(`GitHub API ${res.status}`);
    const list = await res.json();
    const devReleases = list
      .filter(r => r.prerelease && DEV_TAG_RE.test(r.tag_name || ''))
      .sort((a, b) => _semverCompare(b.tag_name, a.tag_name));
    if (devReleases.length === 0) return { tag: '', notesUrl: '', notes: '', publishedAt: '' };
    data = devReleases[0];
  } else {
    const res = await fetch(`${GH_REPO_URL}/releases/latest`, { headers });
    if (!res.ok) throw new Error(`GitHub API ${res.status}`);
    data = await res.json();
  }
  return {
    tag:         data.tag_name    || '',
    notesUrl:    data.html_url    || '',
    notes:       data.body        || '',
    publishedAt: data.published_at || '',
  };
}

/**
 * GET /api/updates/server-status?channel=stable|dev
 * Admin-only. Returns:
 *   { current, latest, channel, available, notes_url, checked_at }
 * Cached 24h per channel; falls back to cached value if GH is unreachable.
 * Channel maps to a GH release: stable = /releases/latest,
 * dev = newest numbered -dev.N pre-release.
 */
router.get('/server-status', requireAuth, requireAdmin, wrap(async (req, res) => {
  // Accept 'beta' as a legacy alias for 'dev' so older clients still
  // get sensible answers during the rename transition.
  const raw = req.query.channel;
  const channel = (raw === 'dev' || raw === 'beta') ? 'dev' : 'stable';
  // Manual "Check Now" in the PWA panel passes force=1 to bypass the
  // 24h server-side cache. Without this, a `latest` value cached before
  // a new -dev.N was published would keep showing as "you're up to date"
  // for the rest of the 24h window even after `dev-latest` moved.
  const force = req.query.force === '1' || req.query.force === 'true';

  // Off until someone says yes (the setup wizard asks), and UPDATE_CHECK=off
  // keeps it off for good. Nothing is fetched from GitHub in that case.
  if (!updateCheckEnabled()) {
    return res.json({ disabled: true, envLocked: envLocksUpdateCheck(), answered: updateCheckAnswered(), current: APP_VERSION });
  }
  const keys = CACHE_KEYS[channel];

  const now          = Date.now();
  const checkedAtRaw = _getCfg(keys.checkedAt);
  const checkedAtMs  = checkedAtRaw ? Date.parse(checkedAtRaw) : 0;
  const cached       = _getCfg(keys.latest);
  const cachedUrl    = _getCfg(keys.notesUrl);
  const cachedNotes  = _getCfg(keys.notes);
  const cachedPub    = _getCfg(keys.publishedAt);

  let latest      = cached;
  let notesUrl    = cachedUrl   || '';
  let notes       = cachedNotes || '';
  let publishedAt = cachedPub   || '';
  let checkedAt   = checkedAtRaw;

  if (force || !cached || now - checkedAtMs > CACHE_TTL_MS) {
    try {
      const fresh = await _fetchLatest(channel);
      latest      = fresh.tag;
      notesUrl    = fresh.notesUrl;
      notes       = fresh.notes;
      publishedAt = fresh.publishedAt;
      checkedAt   = new Date().toISOString();
      _setCfg(keys.latest,      latest);
      _setCfg(keys.notesUrl,    notesUrl);
      _setCfg(keys.notes,       notes);
      _setCfg(keys.publishedAt, publishedAt);
      _setCfg(keys.checkedAt,   checkedAt);
    } catch (e) {
      // Serve stale cache on failure.
      if (!cached) return res.status(503).json({ error: 'GitHub API unreachable and no cached version.' });
    }
  }

  const available = !!(latest && APP_VERSION && APP_VERSION !== 'unknown' && _semverGt(latest, APP_VERSION));
  res.json({
    current:      APP_VERSION,
    latest,
    channel,
    available,
    notes,
    notes_url:    notesUrl,
    published_at: publishedAt,
    checked_at:   checkedAt,
  });
}));

// Semver §11 precedence with pre-release identifier support so a
// Beta channel user on `v1.1.0-dev.5` doesn't get pinged that
// `v1.1.0-dev.1` is newer. Mirrors the client-side compareSemver in
// src/lib/updates.js — keep in sync if you change one, change both.
function _parseSemver(tag) {
  if (!tag) return null;
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(tag);
  if (!m) return null;
  const base = [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
  const pre  = m[4]
    ? m[4].split('.').map(s => /^\d+$/.test(s) ? parseInt(s, 10) : s)
    : [];
  return { base, pre };
}

function _semverCompare(a, b) {
  const pa = _parseSemver(a);
  const pb = _parseSemver(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa.base[i] > pb.base[i]) return 1;
    if (pa.base[i] < pb.base[i]) return -1;
  }
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

function _semverGt(a, b) {
  const pa = _parseSemver(a);
  const pb = _parseSemver(b);
  if (!pa || !pb) return false;
  for (let i = 0; i < 3; i++) {
    if (pa.base[i] > pb.base[i]) return true;
    if (pa.base[i] < pb.base[i]) return false;
  }
  // Base equal → empty pre-release (final release) beats any pre-release.
  if (pa.pre.length === 0 && pb.pre.length === 0) return false;
  if (pa.pre.length === 0) return true;
  if (pb.pre.length === 0) return false;
  const n = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < n; i++) {
    const ai = pa.pre[i], bi = pb.pre[i];
    if (ai === undefined) return false;
    if (bi === undefined) return true;
    if (typeof ai === 'number' && typeof bi === 'number') {
      if (ai > bi) return true;
      if (ai < bi) return false;
      continue;
    }
    if (typeof ai === 'number') return false;
    if (typeof bi === 'number') return true;
    if (ai > bi) return true;
    if (ai < bi) return false;
  }
  return false;
}

/**
 * The instance's answer to "may this ask GitHub about new releases?".
 * The setup wizard writes it, Settings, Updates changes it, and
 * UPDATE_CHECK=off in the environment overrides both.
 */
router.get('/config', requireAuth, requireAdmin, wrap(async (req, res) => {
  res.json({ enabled: updateCheckEnabled(), answered: updateCheckAnswered(), envLocked: envLocksUpdateCheck() });
}));

router.put('/config', requireAuth, requireAdmin, wrap(async (req, res) => {
  if (envLocksUpdateCheck()) return res.status(409).json({ error: 'Update checks are turned off by UPDATE_CHECK in the environment' });
  const on = req.body?.enabled === true || req.body?.enabled === 1 || req.body?.enabled === '1';
  setUpdateCheckEnabled(on);
  res.json({ enabled: on, answered: true, envLocked: false });
}));

export default router;
