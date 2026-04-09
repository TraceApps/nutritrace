import { Router } from 'express';
import db from '../db.js';
import { wrap } from '../logger.js';
import { requireAuth, userMgmtActive } from '../middleware/auth.js';
import { isServerOnlyKey } from '../lib/server-only-keys.js';

const router = Router();
router.use(requireAuth);

// GET /api/settings — return all user settings (empty object in single-user mode)
// SECURITY: server-only keys (OAuth secrets, admin config) are filtered out.
router.get('/', wrap((req, res) => {
  if (!userMgmtActive() || !req.user) return res.json({});
  const rows = db.prepare('SELECT key, value FROM user_settings WHERE user_id = ? AND deleted_at IS NULL').all(req.user.id);
  const out = {};
  for (const { key, value } of rows) {
    if (isServerOnlyKey(key)) continue; // never expose admin keys to clients
    try { out[key] = JSON.parse(value); } catch { out[key] = value; }
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
  db.prepare(`INSERT INTO user_settings (user_id, key, value, updated_at) VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = datetime('now'), deleted_at = NULL`)
    .run(req.user.id, key, JSON.stringify(value));
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
  const upsert = db.prepare(
    `INSERT INTO user_settings (user_id, key, value, updated_at) VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = datetime('now'), deleted_at = NULL`
  );
  let written = 0, skipped = 0;
  db.transaction(() => {
    for (const [key, value] of Object.entries(settings)) {
      if (isServerOnlyKey(key)) { skipped++; continue; }
      upsert.run(req.user.id, key, JSON.stringify(value));
      written++;
    }
  })();
  res.json({ ok: true, written, skipped });
}));

// DELETE /api/settings — clear all settings for the current user
router.delete('/', wrap((req, res) => {
  if (userMgmtActive() && req.user) {
    db.prepare(`UPDATE user_settings SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE user_id = ?`).run(req.user.id);
  }
  res.json({ ok: true });
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
    return r?.value ? JSON.parse(r.value) : '';
  }

  try {
    let resp;
    if (svc === 'gotify') {
      const url = req.body.url || _s('gotifyUrl');
      const token = req.body.token || _s('gotifyToken');
      if (!url || !token) return res.status(400).json({ error: 'Gotify URL and token required' });
      resp = await fetch(`${url.replace(/\/+$/, '')}/message?token=${encodeURIComponent(token)}`, {
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
      resp = await fetch(`${url.replace(/\/+$/, '')}/${encodeURIComponent(topic)}`, {
        method: 'POST', headers, body: message || 'Test notification — connected!',
      });
    } else if (svc === 'apprise') {
      const url = _s('appriseUrl');
      const tag = _s('appriseTag');
      if (!url) return res.status(400).json({ error: 'Apprise URL required' });
      const body = { title: title || 'NutriTrace', body: message || 'Test notification — connected!', type: 'info' };
      if (tag) body.tag = tag;
      resp = await fetch(`${url.replace(/\/+$/, '')}/notify`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
    } else {
      return res.status(400).json({ error: `Unknown service: ${svc}` });
    }

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      return res.status(resp.status).json({ error: `${svc} ${resp.status}: ${body.slice(0, 100)}` });
    }
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
