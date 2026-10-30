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
import { freshCheck } from './two-step.js';
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

// How long a new token lasts: `expires_in_days` (1 to 3650), or none for
// no expiry. `expires_at` from an older page is taken when it is a time to
// come. Throws a plain error otherwise.
const MAX_TOKEN_DAYS = 3650;
function _expiresAt(body) {
  const sql = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
  const days = body?.expires_in_days;
  if (days != null && days !== '') {
    const n = Number(days);
    if (!Number.isInteger(n) || n < 1 || n > MAX_TOKEN_DAYS) throw new Error(`Expiry must be 1 to ${MAX_TOKEN_DAYS} days, or none.`);
    return sql(Date.now() + n * 24 * 3600 * 1000);
  }
  const at = body?.expires_at;
  if (at == null || at === '') return null;
  const ms = Date.parse(`${String(at).trim().replace(' ', 'T').replace(/Z$/, '')}Z`);
  if (!Number.isFinite(ms) || ms <= Date.now() || ms > Date.now() + MAX_TOKEN_DAYS * 24 * 3600 * 1000) throw new Error(`Expiry must be a time to come, within ${MAX_TOKEN_DAYS} days, or none.`);
  return sql(ms);
}

router.post('/', wrap((req, res) => {
  // A session alone can't make one (#222): the password, and the
  // two-step code when it's on; an account with no password, a sign-in in
  // the last 15 minutes (routes/two-step.js freshCheck, the same check as
  // linking a sign-in provider). Tokens made before this keep working.
  let expiresAt;
  try { expiresAt = _expiresAt(req.body); } catch (e) { return res.status(400).json({ error: e.message }); }
  if (!freshCheck(req, res, 'create an API token')) return;
  const { name, scopes } = req.body || {};
  try {
    const { row, raw } = createToken({
      userId: req.user.id,
      name,
      scopes,
      expiresAt,
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
