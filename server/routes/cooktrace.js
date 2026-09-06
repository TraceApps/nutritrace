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
import { wrap, logger } from '../logger.js';
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
 */
router.post('/proxy', async (req, res) => {
  const rid = Math.random().toString(36).slice(2, 8);
  try {
    logger.info(`[cooktrace-proxy ${rid}] start user=${req.user?.id ?? 'null'} path=${req.body?.path}`);
    const { baseUrl, token, path, method } = req.body || {};
    if (!baseUrl || !token || !path) {
      return res.status(400).json({ error: 'baseUrl, token and path required' });
    }

    const requestedBase = _normalizeUrl(baseUrl);
    if (userMgmtActive()) {
      const allowedBase = _getStoredBase(req.user?.id);
      if (!allowedBase) {
        logger.warn(`[cooktrace-proxy ${rid}] no cooktraceBaseUrl saved for user ${req.user?.id}`);
        return res.status(400).json({ error: 'No CookTrace URL configured. Set it in Settings > Connected Services first.' });
      }
      if (allowedBase !== requestedBase) {
        logger.warn(`[cooktrace-proxy ${rid}] baseUrl mismatch saved=${allowedBase} requested=${requestedBase}`);
        return res.status(403).json({ error: 'CookTrace URL must match the one saved in Settings.' });
      }
    }

    const url = requestedBase + path;
    logger.info(`[cooktrace-proxy ${rid}] fetching ${url}`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);

    let response;
    try {
      response = await fetch(url, {
        method: (method || 'GET').toUpperCase(),
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
        signal: controller.signal,
      });
    } catch (fetchErr) {
      clearTimeout(timer);
      logger.warn(`[cooktrace-proxy ${rid}] fetch failed: ${fetchErr.message}`);
      return res.status(503).json({ error: `Fetch failed: ${fetchErr.message}` });
    }
    clearTimeout(timer);

    logger.info(`[cooktrace-proxy ${rid}] response status=${response.status} ct=${response.headers.get('content-type')}`);

    const rawText = await response.text().catch(() => '');
    if (!response.ok) {
      logger.warn(`[cooktrace-proxy ${rid}] upstream ${response.status}: ${rawText.slice(0, 200)}`);
      return res.status(response.status).json({
        error: `CookTrace returned ${response.status}`,
        detail: rawText.slice(0, 400) || undefined,
      });
    }

    let body;
    try {
      body = JSON.parse(rawText);
    } catch (parseErr) {
      logger.warn(`[cooktrace-proxy ${rid}] non-JSON body: ${parseErr.message} first120=${rawText.slice(0, 120)}`);
      return res.status(502).json({ error: 'CookTrace returned non-JSON response', detail: rawText.slice(0, 200) });
    }
    logger.info(`[cooktrace-proxy ${rid}] ok, body keys=${Object.keys(body || {}).join(',')}`);
    return res.json(body);
  } catch (e) {
    logger.error(`[cooktrace-proxy ${rid}] unhandled ${e?.stack || e?.message || e}`);
    return res.status(500).json({ error: `Proxy crashed: ${e?.message || e}` });
  }
});

export default router;
