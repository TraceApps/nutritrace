/**
 * server/routes/oidc-admin.js — admin CRUD for OIDC providers.
 *
 * Mounted at /api/admin/oidc. All endpoints gated by requireAdmin.
 */
import { Router } from 'express';
import { Issuer } from 'openid-client';
import db from '../db.js';
import { wrap, logger } from '../logger.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import {
  listProviders, getProvider, adminProvider,
  encryptClientSecret, invalidateDiscovery,
  isPasswordLoginEnabled, setPasswordLoginEnabled,
} from '../lib/oidc.js';
import { isProviderEnvLocked, getEnvLockedProviderIds } from '../lib/oidc-env.js';

// Refuse mutation when the provider was defined via OIDC_PROVIDER_*_* env
// vars. The client (Settings UI) tags these rows with a lock badge so the
// admin can see why the form fields are read-only.
const ENV_LOCKED_MSG = 'This provider is configured via environment variables and cannot be edited from the UI.';

const router = Router();
router.use(requireAuth, requireAdmin);

const ALLOWED_AUTH_METHODS = new Set(['client_secret_post', 'client_secret_basic', 'none']);
const ALLOWED_RESPONSE_TYPES = new Set(['code']);

function _coerceProvider(body, existing) {
  const get = (k, def) => body[k] !== undefined ? body[k] : (existing ? existing[k] : def);

  const issuer_url = String(get('issuer_url', '')).trim();
  const client_id  = String(get('client_id',  '')).trim();
  if (!issuer_url || !client_id) {
    throw new Error('issuer_url and client_id are required');
  }

  const redirectUris = Array.isArray(body.redirect_uris)
    ? body.redirect_uris.map(s => String(s || '').trim()).filter(Boolean)
    : (existing ? JSON.parse(existing.redirect_uris || '[]') : []);
  if (!redirectUris.length) throw new Error('At least one redirect_uri is required');

  const responseTypes = Array.isArray(body.response_types)
    ? body.response_types.map(s => String(s).trim()).filter(t => ALLOWED_RESPONSE_TYPES.has(t))
    : (existing ? JSON.parse(existing.response_types || '["code"]') : ['code']);
  if (!responseTypes.length) responseTypes.push('code');

  const authMethod = ALLOWED_AUTH_METHODS.has(body.token_endpoint_auth_method)
    ? body.token_endpoint_auth_method
    : (existing ? existing.token_endpoint_auth_method : 'client_secret_post');

  const scope = String(get('scope', 'openid profile email')).trim() || 'openid profile email';

  return {
    issuer_url,
    client_id,
    redirect_uris: JSON.stringify(redirectUris),
    response_types: JSON.stringify(responseTypes),
    token_endpoint_auth_method: authMethod,
    scope,
    id_token_signed_response_alg: String(get('id_token_signed_response_alg', 'RS256')),
    userinfo_signed_response_alg: String(get('userinfo_signed_response_alg', 'none')),
    request_timeout_ms: Math.max(1000, Math.min(120000, Number(get('request_timeout_ms', 30000)) || 30000)),
    auto_link_verified_email: get('auto_link_verified_email', 1) ? 1 : 0,
    auto_register_new_users:  get('auto_register_new_users',  0) ? 1 : 0,
    admin_group_claim: get('admin_group_claim', '') ? String(get('admin_group_claim')).trim() : null,
    admin_group_value: get('admin_group_value', '') ? String(get('admin_group_value')).trim() : null,
    display_name: get('display_name', '') ? String(get('display_name')).trim().slice(0, 80) : null,
    logo_url: get('logo_url', '') ? String(get('logo_url')).trim().slice(0, 500) : null,
    is_active: get('is_active', 1) ? 1 : 0,
  };
}

router.get('/providers', wrap((req, res) => {
  res.json({
    providers: listProviders({ activeOnly: false })
      .map(adminProvider)
      .map(p => ({ ...p, env_locked: isProviderEnvLocked(p.id) })),
    enable_email_password_login: isPasswordLoginEnabled(),
    env_locked_provider_ids: getEnvLockedProviderIds(),
  });
}));

router.post('/providers', wrap((req, res) => {
  const fields = _coerceProvider(req.body, null);
  const encSecret = encryptClientSecret(req.body.client_secret);
  const r = db.prepare(
    `INSERT INTO oidc_providers (
       issuer_url, client_id, client_secret, redirect_uris, scope,
       token_endpoint_auth_method, response_types,
       id_token_signed_response_alg, userinfo_signed_response_alg, request_timeout_ms,
       auto_link_verified_email, auto_register_new_users,
       admin_group_claim, admin_group_value,
       display_name, logo_url, is_active
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    fields.issuer_url, fields.client_id, encSecret,
    fields.redirect_uris, fields.scope,
    fields.token_endpoint_auth_method, fields.response_types,
    fields.id_token_signed_response_alg, fields.userinfo_signed_response_alg, fields.request_timeout_ms,
    fields.auto_link_verified_email, fields.auto_register_new_users,
    fields.admin_group_claim, fields.admin_group_value,
    fields.display_name, fields.logo_url, fields.is_active
  );
  // The admin form uses ":providerId" as a placeholder when creating, since
  // the real ID isn't known until INSERT. Substitute it now so the saved
  // redirect URI is immediately usable without an extra Edit step.
  const newId = r.lastInsertRowid;
  try {
    const stored = JSON.parse(fields.redirect_uris);
    const fixed  = stored.map(u => typeof u === 'string' ? u.replace(/:providerId/g, String(newId)) : u);
    if (JSON.stringify(fixed) !== fields.redirect_uris) {
      db.prepare(`UPDATE oidc_providers SET redirect_uris = ? WHERE id = ?`).run(JSON.stringify(fixed), newId);
    }
  } catch {}
  invalidateDiscovery(newId);
  const created = getProvider(newId);
  logger.info(`[oidc-admin] created provider ${created.id} (${created.display_name || created.issuer_url})`);
  res.status(201).json(adminProvider(created));
}));

router.put('/providers/:id', wrap((req, res) => {
  const id = Number(req.params.id);
  if (isProviderEnvLocked(id)) return res.status(403).json({ error: ENV_LOCKED_MSG });
  const existing = getProvider(id);
  if (!existing) return res.status(404).json({ error: 'Provider not found' });
  const fields = _coerceProvider(req.body, existing);
  // client_secret: only update when caller explicitly passes a non-empty
  // string — unset/empty keeps the existing encrypted value.
  let secretClause = '';
  let secretArg = null;
  if (typeof req.body.client_secret === 'string' && req.body.client_secret.length > 0) {
    secretClause = ', client_secret = ?';
    secretArg = encryptClientSecret(req.body.client_secret);
  } else if (req.body.client_secret === null) {
    secretClause = ', client_secret = NULL';
  }

  const sql = `UPDATE oidc_providers SET
    issuer_url = ?, client_id = ?,
    redirect_uris = ?, scope = ?,
    token_endpoint_auth_method = ?, response_types = ?,
    id_token_signed_response_alg = ?, userinfo_signed_response_alg = ?, request_timeout_ms = ?,
    auto_link_verified_email = ?, auto_register_new_users = ?,
    admin_group_claim = ?, admin_group_value = ?,
    display_name = ?, logo_url = ?, is_active = ?,
    updated_at = datetime('now')
    ${secretClause}
    WHERE id = ?`;
  const args = [
    fields.issuer_url, fields.client_id,
    fields.redirect_uris, fields.scope,
    fields.token_endpoint_auth_method, fields.response_types,
    fields.id_token_signed_response_alg, fields.userinfo_signed_response_alg, fields.request_timeout_ms,
    fields.auto_link_verified_email, fields.auto_register_new_users,
    fields.admin_group_claim, fields.admin_group_value,
    fields.display_name, fields.logo_url, fields.is_active,
  ];
  if (secretArg !== null) args.push(secretArg);
  args.push(id);
  db.prepare(sql).run(...args);
  invalidateDiscovery(id);
  const updated = getProvider(id);
  res.json(adminProvider(updated));
}));

router.delete('/providers/:id', wrap((req, res) => {
  const id = Number(req.params.id);
  if (isProviderEnvLocked(id)) return res.status(403).json({ error: ENV_LOCKED_MSG });
  const r = db.prepare(`DELETE FROM oidc_providers WHERE id = ?`).run(id);
  invalidateDiscovery(id);
  if (r.changes === 0) return res.status(404).json({ error: 'Provider not found' });
  res.json({ ok: true });
}));

/**
 * POST /api/admin/oidc/providers/:id/test
 * Run discovery and report metadata. Lets admins verify config before
 * inviting users.
 */
router.post('/providers/:id/test', wrap(async (req, res) => {
  const provider = getProvider(req.params.id);
  if (!provider) return res.status(404).json({ error: 'Provider not found' });
  try {
    const issuer = await Issuer.discover(provider.issuer_url);
    const md = issuer.metadata || {};
    res.json({
      ok: true,
      issuer: md.issuer,
      authorization_endpoint: md.authorization_endpoint,
      token_endpoint: md.token_endpoint,
      userinfo_endpoint: md.userinfo_endpoint,
      end_session_endpoint: md.end_session_endpoint,
      jwks_uri: md.jwks_uri,
      scopes_supported: md.scopes_supported,
      response_types_supported: md.response_types_supported,
      id_token_signing_alg_values_supported: md.id_token_signing_alg_values_supported,
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: e?.message || 'Discovery failed' });
  }
}));

router.put('/password-login', wrap((req, res) => {
  const v = req.body && (req.body.enabled === true || req.body.enabled === 1 || req.body.enabled === '1');
  setPasswordLoginEnabled(!!v);
  res.json({ enable_email_password_login: !!v });
}));

export default router;
