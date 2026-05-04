/**
 * /api/admin/api-tokens — CRUD for federation API tokens.
 *
 * Mounted INSIDE the regular /api authentication (cookie/Bearer for
 * the user session), not the federation Bearer auth. This is for the
 * Settings UI to manage tokens, not for federation clients to use
 * tokens.
 *
 * Restricted to admins; non-admins get 403. (Single-user mode counts
 * as admin via the synthetic LOCAL_USER.)
 */
import { Router } from 'express';
import { wrap } from '../logger.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { createToken, listTokens, revokeToken, KNOWN_SCOPES } from '../lib/api-tokens.js';

const router = Router();
router.use(requireAuth, requireAdmin);

router.get('/', wrap((req, res) => {
  const tokens = listTokens(req.user.id);
  res.json({
    tokens,
    known_scopes: Array.from(KNOWN_SCOPES),
  });
}));

router.post('/', wrap((req, res) => {
  const { name, scopes, expires_at } = req.body || {};
  try {
    const { row, raw } = createToken({
      userId: req.user.id,
      name,
      scopes,
      expiresAt: expires_at || null,
    });
    // raw is the only place the plaintext token appears. Returned
    // exactly once — the client UI is responsible for displaying it
    // to the user with a "save this now, you won't see it again"
    // affordance.
    res.status(201).json({ token: row, raw });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

router.delete('/:id', wrap((req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(404).json({ error: 'Not found' });
  const ok = revokeToken({ userId: req.user.id, id });
  if (!ok) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
}));

export default router;
