import { Router } from 'express';
import db from '../db.js';
import { wrap } from '../logger.js';
import { requireAuth, userMgmtActive } from '../middleware/auth.js';
import { isServerOnlyKey } from '../lib/server-only-keys.js';
import { fetchChecked, serviceBase } from '../lib/ssrf-guard.js';
import { coachingSignature } from '../lib/coaching.js';
import { fillIfSetupAnswers } from '../lib/profile-fields.js';
import { clientSetting, readSettingRaw, settingToStore } from '../lib/secret-settings.js';
import { clientClock, editMs } from '../lib/sync-clock.js';
import { writeSetting } from '../lib/setting-merge.js';
import { GOAL_HISTORY_SETTING_KEYS, captureGoalSnapshot, isGoalHistoryDate, userToday } from '../lib/goal-history.js';

// Push services usually live on the home network, so that's allowed for
// every account; the address is still checked, and a redirect only
// followed on the same server.
const _sendPush = (url, init) => fetchChecked(url, init, { allowPrivate: true, maxRedirects: 3, sameOrigin: true });

// The service's own short error ("unauthorized"), never its raw reply.
async function _pushErrorMessage(resp) {
  const raw = await resp.text().catch(() => '');
  let message = '';
  try {
    const j = JSON.parse(raw);
    for (const v of [j?.errorDescription, j?.error?.message, j?.error, j?.message]) {
      if (typeof v === 'string' && v) { message = v; break; }
    }
  } catch {}
  return message ? `: ${message.slice(0, 100)}` : '';
}

const router = Router();
router.use(requireAuth);

// What's stored for a setting now (its JSON text), or null.
const _stored = (u, key) => db.prepare(
  'SELECT value FROM user_settings WHERE user_id = ? AND key = ? AND deleted_at IS NULL'
).get(u, key)?.value ?? null;

// The local calendar day a goal change takes effect from: the day the client
// made it (an offline save reaches the server later, but its targets are for
// the day it was made), else today in the person's own time zone.
function _effectiveDate(req) {
  const supplied = req.body?.effective_date;
  if (supplied != null) {
    if (!isGoalHistoryDate(supplied)) {
      const err = new Error('effective_date must be YYYY-MM-DD');
      err.status = 400;
      throw err;
    }
    return supplied;
  }
  return userToday(req.user.id);
}

// When the client made the change, on the server's clock (ms): its own
// clock set right by the offset the request reports, and never in the
// future. Absent (an older app, a detected zone) means now. The same
// instant decides which edit wins (lib/setting-merge.js) and which day's
// goals it is (lib/goal-history.js), for this request and its retries.
function _editTime(req) {
  const raw = req.body?.changed_at;
  if (raw == null) return null;
  const clock = clientClock(req.body?.client_now);
  const ms = editMs(raw, clock, Date.now(), {});
  return Number.isFinite(ms) ? ms : null;
}

// GET /api/settings — return all user settings (empty object in single-user mode)
// SECURITY: server-only keys (OAuth secrets, admin config) are filtered out.
router.get('/', wrap((req, res) => {
  if (!userMgmtActive() || !req.user) return res.json({});
  // Where this person stands in coaching, as a short fingerprint: the app
  // already refreshes settings, so a new coaching request or an ended
  // pairing shows up without another request or timer.
  res.set('X-NT-Coaching', coachingSignature(req.user.id));
  const rows = db.prepare('SELECT key, value FROM user_settings WHERE user_id = ? AND deleted_at IS NULL').all(req.user.id);
  const out = {};
  for (const { key, value } of rows) {
    if (isServerOnlyKey(key)) continue; // never expose admin keys to clients
    let v; try { v = JSON.parse(value); } catch { v = value; }
    // A secret only the server uses is said to be set, never sent (TraceApps/cooktrace#92).
    out[key] = clientSetting(key, v);
  }
  res.json(out);
}));

// PUT /api/settings — upsert one setting
// SECURITY: rejects writes to server-only keys (OAuth secrets etc.).
router.put('/', wrap((req, res) => {
  if (!userMgmtActive() || !req.user) return res.json({ ok: true });
  const { key, value } = req.body;
  if (!key) return res.status(400).json({ error: 'key required' });
  if (isServerOnlyKey(key)) return res.status(403).json({ error: 'forbidden key' });
  // A secret is stored encrypted; the placeholder sent back for one leaves it be.
  const stored = settingToStore(key, value, _stored(req.user.id, key));
  if (stored === undefined) return res.json({ ok: true });
  // A goal setting also records the day's configuration, in the same
  // transaction: history can never hold targets the settings don't.
  const goalChange = GOAL_HISTORY_SETTING_KEYS.has(key);
  const effectiveDate = goalChange ? _effectiveDate(req) : null;
  // A late save meets a newer edit the way a phone's push does: it keeps the
  // newer one, and the day's history is built from what the settings then
  // say (lib/setting-merge.js), so current and historical goals agree.
  const at = _editTime(req) ?? Date.now();
  db.transaction(() => {
    writeSetting(db, req.user.id, key, { value: stored }, at);
    if (effectiveDate) {
      captureGoalSnapshot(req.user.id, { effectiveDate, changedAt: new Date(at).toISOString(), source: 'settings' });
    }
  })();
  // Setup's birthday and gender belong on the account too (#269).
  fillIfSetupAnswers(db, req.user.id, [key]);
  res.json({ ok: true });
}));

// PUT /api/settings/bulk — upsert many settings in a single request.
// Used by onboarding flows (Wizard) that set 10-20 keys at once. Avoids
// firing a separate API call for each key. Same security filter applies.
// Body: { settings: { key1: value1, key2: value2, ... } }
router.put('/bulk', wrap((req, res) => {
  if (!userMgmtActive() || !req.user) return res.json({ ok: true });
  const { settings } = req.body;
  if (!settings || typeof settings !== 'object') {
    return res.status(400).json({ error: 'settings object required' });
  }
  let written = 0, skipped = 0;
  let goalChange = false;
  // One request, one snapshot: a goal template's targets and its water goal
  // are applied together, so a reader never sees half a template.
  const goalChangeAtRequest = Object.keys(settings).some(key => GOAL_HISTORY_SETTING_KEYS.has(key) && !isServerOnlyKey(key));
  const effectiveDate = goalChangeAtRequest ? _effectiveDate(req) : null;
  // One request, one moment: every key of the batch is edited at the same
  // time, and the day's snapshot is that batch (never half of it).
  const at = _editTime(req) ?? Date.now();
  db.transaction(() => {
    for (const [key, value] of Object.entries(settings)) {
      if (isServerOnlyKey(key)) { skipped++; continue; }
      const stored = settingToStore(key, value, _stored(req.user.id, key));
      if (stored === undefined) { skipped++; continue; }
      writeSetting(db, req.user.id, key, { value: stored }, at);
      written++;
      if (GOAL_HISTORY_SETTING_KEYS.has(key)) goalChange = true;
    }
    if (goalChange) {
      captureGoalSnapshot(req.user.id, { effectiveDate, changedAt: new Date(at).toISOString(), source: 'settings_bulk' });
    }
    // Setup's birthday and gender belong on the account too (#269).
    fillIfSetupAnswers(db, req.user.id, Object.keys(settings).filter(k => !isServerOnlyKey(k)));
  })();
  res.json({ ok: true, written, skipped });
}));

// DELETE /api/settings — clear all settings for the current user
router.delete('/', wrap((req, res) => {
  if (userMgmtActive() && req.user) {
    // Today becomes a day whose targets are the defaults, explicitly: the
    // days before keep the targets they had. Each setting is deleted at the
    // moment the reset was made (not when it arrived), so a phone's newer
    // edit still brings its setting back, and the day's history agrees.
    const effectiveDate = _effectiveDate(req);
    const at = _editTime(req) ?? Date.now();
    db.transaction(() => {
      const rows = db.prepare('SELECT key FROM user_settings WHERE user_id = ?').all(req.user.id);
      for (const { key } of rows) {
        writeSetting(db, req.user.id, key, { deleted: true }, at, { restamp: true });
      }
      captureGoalSnapshot(req.user.id, { effectiveDate, changedAt: new Date(at).toISOString(), source: 'settings_reset' });
    })();
  }
  res.json({ ok: true });
}));

// POST /api/settings/claim-celebration — atomically claim a goal celebration for today
// Returns { fired: true } if this caller is the first to fire it, false if already fired.
// Prevents duplicate celebrations across multiple devices (phone + PWA).
router.post('/claim-celebration', wrap((req, res) => {
  const { key } = req.body;
  if (!key || typeof key !== 'string') return res.status(400).json({ error: 'key required' });
  // Validate format: lowercase + digits + underscore + hyphen, max 40 chars.
  // Covers all nutrient IDs (saturated-fat, vitamin-d) plus underscore-style keys
  // (cal_max, steps_hit). Prevents a misbehaving client from spamming arbitrary
  // keys into app_config.
  if (!/^[a-z_][a-z0-9_-]{0,39}$/.test(key)) return res.status(400).json({ error: 'invalid key format' });
  const userId = req.user?.id ?? 0;
  const today = new Date().toISOString().slice(0, 10);
  const dbKey = `_celeb_${userId}_${key}_${today}`;
  const row = db.prepare('SELECT value FROM app_config WHERE key = ?').get(dbKey);
  if (row?.value) return res.json({ fired: false });
  db.prepare('INSERT INTO app_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(dbKey, '1');
  res.json({ fired: true });
}));

// POST /api/settings/gotify-test — legacy alias
router.post('/gotify-test', wrap(async (req, res) => {
  req.body.service = 'gotify';
  return _pushTestHandler(req, res);
}));

// POST /api/settings/push-test — proxy a test notification to the user's push service
router.post('/push-test', wrap(async (req, res) => _pushTestHandler(req, res)));

async function _pushTestHandler(req, res) {
  if (!userMgmtActive() || !req.user) return res.status(401).json({ error: 'Not logged in' });
  const u = req.user.id;
  const { service, title, message, priority } = req.body;
  const svc = service || 'gotify';

  function _s(key) {
    const r = db.prepare('SELECT value FROM user_settings WHERE user_id=? AND key=?').get(u, key);
    return r?.value ? readSettingRaw(key, r.value) : '';
  }

  try {
    let resp;
    if (svc === 'gotify') {
      // SSRF guard: only ever proxy to the URL the user has saved. Body-supplied
      // url/token are intentionally ignored — the client always saves before
      // calling test, so saved values reflect what the user typed.
      const url = _s('gotifyUrl');
      const token = _s('gotifyToken');
      if (!url || !token) return res.status(400).json({ error: 'Gotify URL and token required — save settings first' });
      resp = await _sendPush(`${serviceBase(url) ?? url}/message?token=${encodeURIComponent(token)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title || 'NutriTrace', message: message || 'Test notification — connected!', priority: priority || 5 }),
      });
    } else if (svc === 'ntfy') {
      const url = _s('ntfyUrl') || 'https://ntfy.sh';
      const topic = _s('ntfyTopic');
      const token = _s('ntfyToken');
      if (!topic) return res.status(400).json({ error: 'ntfy topic required' });
      const headers = { 'Title': title || 'NutriTrace', 'Priority': String(Math.min(5, priority || 5)) };
      if (token) headers['Authorization'] = `Bearer ${token}`;
      resp = await _sendPush(`${serviceBase(url) ?? url}/${encodeURIComponent(topic)}`, {
        method: 'POST', headers, body: message || 'Test notification — connected!',
      });
    } else if (svc === 'apprise') {
      const url = _s('appriseUrl');
      const tag = _s('appriseTag');
      if (!url) return res.status(400).json({ error: 'Apprise URL required' });
      const body = { title: title || 'NutriTrace', body: message || 'Test notification — connected!', type: 'info' };
      if (tag) body.tag = tag;
      resp = await _sendPush(`${serviceBase(url) ?? url}/notify`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
    } else {
      return res.status(400).json({ error: `Unknown service: ${svc}` });
    }

    if (!resp.ok) {
      return res.status(resp.status).json({ error: `${svc} ${resp.status}${await _pushErrorMessage(resp)}` });
    }
    try { await resp.body?.cancel(); } catch {}
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: `${svc}: ${e.message}` });
  }
}

// POST /api/settings/force-sync — admin: trigger scheduled sync immediately
router.post('/force-sync', wrap(async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not logged in' });
  const { forceSync } = await import('../lib/scheduler.js');
  const result = await forceSync(req.user.id);
  res.json({ ok: true, ...result });
}));

export default router;
