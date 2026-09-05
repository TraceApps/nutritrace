/**
 * /api/admin/api-tokens — CRUD for federation API tokens.
 *
 * Mounted INSIDE the regular /api authentication (cookie/Bearer for
 * the user session), not the federation Bearer auth. This is for the
 * Settings UI to manage tokens, not for federation clients to use
 * tokens.
 *
 * Restricted to admins; non-admins get 403. requireAuth/requireAdmin
 * both pass single-user-mode requests through unconditionally (there's
 * no meaningful non-admin in that mode) — but single-user mode has
 * zero rows in `users`, so req.user is null there, not a synthetic
 * "LOCAL_USER". A token needs a real owner (api_tokens.user_id is NOT
 * NULL), so the guard below refuses cleanly instead of crashing on
 * req.user.id when this is hit without a real signed-in admin.
 */
import { Router } from 'express';
import { wrap } from '../logger.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { createToken, listTokens, revokeToken, KNOWN_SCOPES, SCOPE_DESCRIPTIONS } from '../lib/api-tokens.js';

const router = Router();
router.use(requireAuth, requireAdmin);

router.use((req, res, next) => {
  if (!req.user) {
    return res.status(400).json({
      error: 'API tokens require a signed-in account. Enable user management and sign in as an admin first.',
    });
  }
  next();
});

function _envFlag(v) {
  if (v === undefined || v === null) return false;
  const s = String(v).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

router.get('/', wrap((req, res) => {
  const tokens = listTokens(req.user.id);
  res.json({
    tokens,
    known_scopes: Array.from(KNOWN_SCOPES),
    scope_descriptions: SCOPE_DESCRIPTIONS,
    // Surface MCP flag state so the UI can show admins whether a token
    // holding mcp:write / mcp:destroy will actually work on this server.
    // Flags are captured at boot (env vars); change needs a restart.
    mcp_state: {
      enabled: _envFlag(process.env.MCP_ENABLED),
      write:   _envFlag(process.env.MCP_WRITE_ENABLED),
      destroy: _envFlag(process.env.MCP_DESTROY_ENABLED),
    },
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
