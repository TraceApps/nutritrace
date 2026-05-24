/**
 * routes/off-local.js — admin/status surface for the local OFF mirror.
 *
 * GET  /status   — any authed user (Settings UI polls while panel is open)
 * POST /refresh  — admin only (kicks a background refresh, returns immediately)
 * PUT  /schedule — admin only (set off|daily|weekly|monthly)
 *
 * All endpoints no-op gracefully when OFF_LOCAL_DB is unset: /status returns
 * `{ enabled: false }` so the client just hides the UI; /refresh + /schedule
 * return 409 so an admin who hits them via curl gets a clear error.
 */
import { Router } from 'express';
import { wrap } from '../logger.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { getStatus, refreshNow, isLocalOffEnabled } from '../lib/off-local.js';
import { getInterval, setInterval as setRefreshInterval } from '../lib/off-local-scheduler.js';

const router = Router();

router.get('/status', requireAuth, wrap((req, res) => {
  const status = getStatus();
  status.refresh_interval = getInterval();
  res.json(status);
}));

router.post('/refresh', requireAuth, requireAdmin, wrap((req, res) => {
  if (!isLocalOffEnabled()) {
    return res.status(409).json({ error: 'OFF_LOCAL_DB is not set; nothing to refresh.' });
  }
  // Fire-and-forget — UI polls /status for progress.
  refreshNow({ source: 'manual' }).catch(() => { /* logged in lib */ });
  res.json({ ok: true });
}));

router.put('/schedule', requireAuth, requireAdmin, wrap((req, res) => {
  const { interval } = req.body || {};
  try {
    const v = setRefreshInterval(interval);
    res.json({ ok: true, interval: v });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

export default router;
