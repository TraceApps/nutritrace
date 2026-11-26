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
import {
  GOAL_HISTORY_FIELDS,
  GOAL_HISTORY_FIELD_OF_SETTING,
  GOAL_HISTORY_SETTING_KEYS,
  boundGoalDate,
  captureGoalSnapshot,
  currentGoalSnapshot,
  isGoalHistoryDate,
} from '../lib/goal-history.js';
import { writeSetting } from '../lib/setting-merge.js';

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

// When the client made the change, on the server's clock (ms): its own
// clock set right by the offset the request reports, and never in the
// future. Absent (an older app, a detected zone) means now. This is the
// instant that decides which edit wins (lib/setting-merge.js), and it
// belongs to the request and to its retries.
function _editTime(req) {
  const raw = req.body?.changed_at;
  if (raw == null) return null;
  const clock = clientClock(req.body?.client_now);
  const ms = editMs(raw, clock, Date.now(), {});
  return Number.isFinite(ms) ? ms : null;
}

// The local calendar day a goal change takes effect from: the day the client
// made it (an offline save reaches the server later, but its targets are for
// the day it was made), kept within a day of the corrected edit time
// (goal-history.js boundGoalDate). An invalid date is refused; one further
// out is filed under the edit's own day.
function _effectiveDate(req, editAt) {
  const supplied = req.body?.effective_date;
  if (supplied != null && !isGoalHistoryDate(supplied)) {
    const err = new Error('effective_date must be YYYY-MM-DD');
    err.status = 400;
    throw err;
  }
  return boundGoalDate(req.user.id, supplied ?? null, editAt ?? Date.now());
}

/**
 * The configuration a goal save put in effect: the settings as they are,
 * with the keys this save changed set to the values it sent (and their
 * time). A save that loses to a newer edit still records its own value for
 * its own day; the fields it did not change come from the day's own
 * history, not from the live settings.
 */
function _saveSnapshot(userId, changed, at) {
  const snapshot = currentGoalSnapshot(userId);
  const fieldTimes = {};
  for (const [key, value] of Object.entries(changed)) {
    const field = GOAL_HISTORY_FIELD_OF_SETTING[key];
    if (!field) continue;
    snapshot[field] = value;
    fieldTimes[field] = new Date(at).toISOString();
  }
  return { snapshot, fieldTimes };
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
  // A save made at one moment and delivered later meets the newer edit and
  // loses; the newer one stays (lib/setting-merge.js). A goal setting also
  // records the day's configuration, in the same transaction. The day is
  // built from the value this save sent, so a save that loses to a newer
  // edit still says what it changed for its own day.
  const goalChange = GOAL_HISTORY_SETTING_KEYS.has(key);
  const at = _editTime(req) ?? Date.now();
  const effectiveDate = goalChange ? _effectiveDate(req, at) : null;
  db.transaction(() => {
    writeSetting(db, req.user.id, key, { value: stored }, at);
    if (effectiveDate) {
      const { snapshot, fieldTimes } = _saveSnapshot(req.user.id, { [key]: value }, at);
      captureGoalSnapshot(req.user.id, {
        effectiveDate, changedAt: new Date(at).toISOString(), source: 'settings', snapshot, fieldTimes,
      });
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
  // One request, one moment: every key of the batch is edited at the same
  // time, so a change from another device between two keys of it can't
  // split the batch. One request, one snapshot: a goal template's targets
  // and its water goal are applied together, so a reader never sees half a
  // template.
  const goalChanges = Object.fromEntries(
    Object.entries(settings).filter(([key]) => GOAL_HISTORY_SETTING_KEYS.has(key) && !isServerOnlyKey(key))
  );
  const goalChange = Object.keys(goalChanges).length > 0;
  const at = _editTime(req) ?? Date.now();
  const effectiveDate = goalChange ? _effectiveDate(req, at) : null;
  db.transaction(() => {
    for (const [key, value] of Object.entries(settings)) {
      if (isServerOnlyKey(key)) { skipped++; continue; }
      const stored = settingToStore(key, value, _stored(req.user.id, key));
      if (stored === undefined) { skipped++; continue; }
      writeSetting(db, req.user.id, key, { value: stored }, at);
      written++;
    }
    if (goalChange) {
      const { snapshot, fieldTimes } = _saveSnapshot(req.user.id, goalChanges, at);
      captureGoalSnapshot(req.user.id, {
        effectiveDate, changedAt: new Date(at).toISOString(), source: 'settings_bulk', snapshot, fieldTimes,
      });
    }
    // Setup's birthday and gender belong on the account too (#269).
    fillIfSetupAnswers(db, req.user.id, Object.keys(settings).filter(k => !isServerOnlyKey(k)));
  })();
  res.json({ ok: true, written, skipped });
}));

// DELETE /api/settings — clear all settings for the current user
router.delete('/', wrap((req, res) => {
  if (userMgmtActive() && req.user) {
    // A reset clears every setting at the moment it was made, not when it
    // arrived: a phone's newer edit still brings its setting back. Today
    // becomes a day whose targets are the defaults, explicitly: the days
    // before keep the targets they had.
    const at = _editTime(req) ?? Date.now();
    const effectiveDate = _effectiveDate(req, at);
    db.transaction(() => {
      const rows = db.prepare('SELECT key FROM user_settings WHERE user_id = ?').all(req.user.id);
      for (const { key } of rows) writeSetting(db, req.user.id, key, { deleted: true }, at);
      // The reset's own day records the defaults at the reset's moment, not
      // the newer live value that may have won a setting: a later edit for
      // that day wins on its own time, and an edit for another day stays
      // there.
      const stamp = new Date(at).toISOString();
      const fieldTimes = {};
      for (const field of GOAL_HISTORY_FIELDS) fieldTimes[field] = stamp;
      captureGoalSnapshot(req.user.id, {
        effectiveDate, changedAt: stamp, source: 'settings_reset', snapshot: {}, fieldTimes,
      });
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
