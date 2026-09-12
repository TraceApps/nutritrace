/**
 * /api/admin/webhooks, CRUD + test for outgoing webhooks.
 *
 * Mounted INSIDE the regular /api authentication (cookie/session auth),
 * same posture as /api/admin/api-tokens: this is for the Settings UI
 * to manage webhooks, not the delivery path itself (that's
 * dispatchWebhookEvent in server/lib/webhooks.js, called from
 * routes/diary.js).
 *
 * Restricted to admins; non-admins get 403. Single-user mode counts as
 * admin (requireAdmin already treats it that way, see middleware/auth.js).
 */
import { Router } from 'express';
import { wrap } from '../logger.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import {
  createWebhook, listWebhooks, updateWebhook, deleteWebhook, sendTestWebhook,
  KNOWN_WEBHOOK_EVENTS, WEBHOOK_EVENT_DESCRIPTIONS, WEBHOOKS_ENABLED,
} from '../lib/webhooks.js';

const router = Router();
router.use(requireAuth, requireAdmin);

// A webhook needs a real owner (webhooks.user_id is NOT NULL,
// referencing a real users row). Same refusal api-tokens.js uses for
// the same reason: single-user mode has zero rows in `users`.
router.use((req, res, next) => {
  if (!req.user) {
    return res.status(400).json({
      error: 'Webhooks require a signed-in account. Enable user management and sign in as an admin first.',
    });
  }
  next();
});

router.get('/', wrap((req, res) => {
  const webhooks = listWebhooks(req.user.id);
  res.json({
    webhooks,
    known_events: Array.from(KNOWN_WEBHOOK_EVENTS),
    event_descriptions: WEBHOOK_EVENT_DESCRIPTIONS,
    // Surface flag state so the UI can show admins whether a configured
    // webhook will actually fire on this server. Captured at boot
    // (env var); change needs a restart.
    webhooks_enabled: WEBHOOKS_ENABLED,
  });
}));

router.post('/', wrap(async (req, res) => {
  const { url, events, secret } = req.body || {};
  try {
    const { row, secret: raw } = await createWebhook({ userId: req.user.id, url, events, secret });
    // raw is the only place the plaintext secret appears (whether
    // generated here or supplied by the caller). Returned exactly once,
    // same one-time-reveal contract api-tokens.js uses for its raw
    // token value, so the receiving end can be configured to verify
    // signatures with it.
    res.status(201).json({ webhook: row, secret: raw });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

router.put('/:id', wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(404).json({ error: 'Not found' });
  const { url, events, enabled } = req.body || {};
  try {
    const row = await updateWebhook({ userId: req.user.id, id, url, events, enabled });
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json({ webhook: row });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

router.delete('/:id', wrap((req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(404).json({ error: 'Not found' });
  const ok = deleteWebhook({ userId: req.user.id, id });
  if (!ok) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
}));

router.post('/:id/test', wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(404).json({ error: 'Not found' });
  try {
    const result = await sendTestWebhook({ userId: req.user.id, id });
    res.json({ ok: result.last_delivery_status === 'success', ...result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

export default router;
