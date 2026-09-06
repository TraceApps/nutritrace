/**
 * /api/cooktrace: server-side proxy for a user's own CookTrace instance.
 *
 * Mirrors the Mealie proxy pattern (see mealie.js): the browser cannot
 * call the CookTrace bearer API directly (CORS + keeping the token off
 * the WebView), so the NT server forwards the request using the URL and
 * PAT saved in user_settings.
 *
 * SECURITY: baseUrl in the request must match the user's saved
 * cooktraceBaseUrl setting so an authed NT user cannot turn this into an
 * SSRF probe against arbitrary internal addresses. Single-user mode keeps
 * settings in client-side localStorage, so it trusts the request (same
 * posture as the Mealie proxy).
 */
import { Router } from 'express';
import { wrap } from '../logger.js';
import { requireAuth, userMgmtActive } from '../middleware/auth.js';
import db from '../db.js';

const router = Router();
router.use(requireAuth);

function _normalizeUrl(s) {
  if (!s) return '';
  let v = String(s);
  if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
  return v.replace(/\/$/, '');
}

function _getStoredBase(userId) {
  const row = userId == null
    ? db.prepare(`SELECT value FROM user_settings WHERE key = 'cooktraceBaseUrl' AND deleted_at IS NULL LIMIT 1`).get()
    : db.prepare(`SELECT value FROM user_settings WHERE user_id = ? AND key = 'cooktraceBaseUrl' AND deleted_at IS NULL`).get(userId);
  return _normalizeUrl(row?.value);
}

/**
 * POST /api/cooktrace/proxy
 * Body: { baseUrl, token, path, method? }
 * method defaults to GET; only GET is used today (read-only pull from CT).
 */
router.post('/proxy', wrap(async (req, res) => {
  const { baseUrl, token, path, method } = req.body || {};
  if (!baseUrl || !token || !path) {
    return res.status(400).json({ error: 'baseUrl, token and path required' });
  }

  const requestedBase = _normalizeUrl(baseUrl);
  if (userMgmtActive()) {
    const allowedBase = _getStoredBase(req.user?.id);
    if (!allowedBase) {
      return res.status(400).json({ error: 'No CookTrace URL configured. Set it in Settings > Connected Services first.' });
    }
    if (allowedBase !== requestedBase) {
      return res.status(403).json({ error: 'CookTrace URL must match the one saved in Settings.' });
    }
  }

  const url = requestedBase + path;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(url, {
      method: (method || 'GET').toUpperCase(),
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
    clearTimeout(timer);
    const ct = response.headers.get('content-type') || '';
    const bodyText = await response.text();
    if (!response.ok) {
      return res.status(response.status).json({
        error: `CookTrace returned ${response.status}`,
        detail: bodyText && bodyText.length < 400 ? bodyText : undefined,
      });
    }
    if (ct.includes('application/json')) {
      try { return res.json(JSON.parse(bodyText)); } catch { /* fall through */ }
    }
    res.type(ct || 'text/plain').send(bodyText);
  } catch (e) {
    clearTimeout(timer);
    res.status(503).json({ error: e.message });
  }
}));

export default router;
