/**
 * server/lib/oidc-env.js
 *
 * Bootstrap OIDC providers from environment variables on server start.
 *
 * Convention:
 *   OIDC_PROVIDER_1_ISSUER       (required to define provider 1)
 *   OIDC_PROVIDER_1_CLIENT_ID    (required)
 *   OIDC_PROVIDER_1_CLIENT_SECRET (required for confidential clients)
 *   OIDC_PROVIDER_1_DISPLAY_NAME
 *   OIDC_PROVIDER_1_LOGO_URL
 *   OIDC_PROVIDER_1_SCOPE                  (default: 'openid profile email')
 *   OIDC_PROVIDER_1_REDIRECT_URIS          (comma-separated)
 *   OIDC_PROVIDER_1_TOKEN_AUTH_METHOD      (client_secret_post|client_secret_basic|none)
 *   OIDC_PROVIDER_1_ADMIN_GROUP_CLAIM
 *   OIDC_PROVIDER_1_ADMIN_GROUP_VALUE
 *   OIDC_PROVIDER_1_AUTO_LINK              (1|0, default 1)
 *   OIDC_PROVIDER_1_AUTO_REGISTER          (1|0, default 0)
 *   OIDC_PROVIDER_1_IS_ACTIVE              (1|0, default 1)
 *
 * Numbered prefix scales: OIDC_PROVIDER_2_*, OIDC_PROVIDER_3_*, etc.
 *
 * For the common single-provider case, `OIDC_*` (no number) is treated as
 * an alias for `OIDC_PROVIDER_1_*`. So:
 *
 *   OIDC_ISSUER=https://auth.example.com
 *   OIDC_CLIENT_ID=nutritrace
 *   OIDC_CLIENT_SECRET=...
 *
 * is equivalent to defining OIDC_PROVIDER_1_*.
 *
 * Identification: providers are matched on (issuer_url, client_id) as the
 * natural key — that pair uniquely identifies a registration with an IdP.
 * If the env defines a provider already in the DB (matching key), the row
 * is updated; otherwise inserted. The resulting provider row IDs are
 * tracked in an in-memory Set so admin-mutation endpoints can refuse
 * edits to env-defined providers.
 */
import db from '../db.js';
import { encryptClientSecret } from './oidc.js';
import { logger } from '../logger.js';

// In-memory set of provider row IDs that were defined by env vars.
// Populated at boot by seedOidcFromEnv(); read by admin endpoints.
const _envLockedIds = new Set();

export function isProviderEnvLocked(id) {
  return _envLockedIds.has(Number(id));
}

export function getEnvLockedProviderIds() {
  return Array.from(_envLockedIds);
}

// ── env-var helpers ────────────────────────────────────────────────────────

function _envGet(prefix, key, fallback = null) {
  // Try the numbered prefix first, fall back to the unnumbered alias for N=1.
  const numbered = process.env[`${prefix}${key}`];
  if (numbered != null && numbered !== '') return numbered;
  if (prefix === 'OIDC_PROVIDER_1_') {
    const unnumbered = process.env[`OIDC_${key}`];
    if (unnumbered != null && unnumbered !== '') return unnumbered;
  }
  return fallback;
}

function _envBool(prefix, key, fallback) {
  const v = _envGet(prefix, key);
  if (v == null) return fallback;
  return /^(1|true|yes|on)$/i.test(String(v).trim()) ? 1 : 0;
}

function _envCsv(prefix, key) {
  const v = _envGet(prefix, key);
  if (!v) return [];
  return String(v).split(',').map(s => s.trim()).filter(Boolean);
}

// ── Discover all defined provider prefixes ────────────────────────────────
//
// Walks process.env looking for `OIDC_PROVIDER_<N>_ISSUER` (the minimum
// required field) plus the unnumbered `OIDC_ISSUER` alias for N=1. Returns
// an array of prefixes ready to feed back into _envGet.
function _findDefinedPrefixes() {
  const prefixes = [];
  const seen = new Set();

  // Unnumbered alias = provider 1
  if (process.env.OIDC_ISSUER && process.env.OIDC_CLIENT_ID) {
    prefixes.push('OIDC_PROVIDER_1_');
    seen.add(1);
  }

  // Numbered prefixes
  const re = /^OIDC_PROVIDER_(\d+)_ISSUER$/;
  for (const key of Object.keys(process.env)) {
    const m = key.match(re);
    if (!m) continue;
    const n = Number(m[1]);
    if (seen.has(n)) continue; // already covered by alias
    if (process.env[key] && process.env[`OIDC_PROVIDER_${n}_CLIENT_ID`]) {
      prefixes.push(`OIDC_PROVIDER_${n}_`);
      seen.add(n);
    }
  }

  return prefixes;
}

// ── Boot-time seeder ───────────────────────────────────────────────────────

export function seedOidcFromEnv() {
  _envLockedIds.clear();

  const prefixes = _findDefinedPrefixes();
  if (!prefixes.length) return;

  const findExisting = db.prepare(
    `SELECT id FROM oidc_providers WHERE issuer_url = ? AND client_id = ?`
  );
  const insert = db.prepare(
    `INSERT INTO oidc_providers (
       issuer_url, client_id, client_secret, redirect_uris, scope,
       token_endpoint_auth_method, response_types,
       id_token_signed_response_alg, userinfo_signed_response_alg, request_timeout_ms,
       auto_link_verified_email, auto_register_new_users,
       admin_group_claim, admin_group_value,
       display_name, logo_url, is_active
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const update = db.prepare(
    `UPDATE oidc_providers SET
       issuer_url = ?, client_id = ?, client_secret = ?, redirect_uris = ?, scope = ?,
       token_endpoint_auth_method = ?,
       auto_link_verified_email = ?, auto_register_new_users = ?,
       admin_group_claim = ?, admin_group_value = ?,
       display_name = ?, logo_url = ?, is_active = ?,
       updated_at = datetime('now')
     WHERE id = ?`
  );

  let count = 0;
  for (const prefix of prefixes) {
    const issuer = String(_envGet(prefix, 'ISSUER', '')).trim();
    const clientId = String(_envGet(prefix, 'CLIENT_ID', '')).trim();
    const clientSecret = _envGet(prefix, 'CLIENT_SECRET', '');
    const displayName = _envGet(prefix, 'DISPLAY_NAME', null);
    const logoUrl = _envGet(prefix, 'LOGO_URL', null);
    const scope = String(_envGet(prefix, 'SCOPE', 'openid profile email')).trim() || 'openid profile email';
    const tokenAuthMethod = String(_envGet(prefix, 'TOKEN_AUTH_METHOD', 'client_secret_post')).trim();
    const adminGroupClaim = _envGet(prefix, 'ADMIN_GROUP_CLAIM', null);
    const adminGroupValue = _envGet(prefix, 'ADMIN_GROUP_VALUE', null);
    const autoLink = _envBool(prefix, 'AUTO_LINK', 1);
    const autoRegister = _envBool(prefix, 'AUTO_REGISTER', 0);
    const isActive = _envBool(prefix, 'IS_ACTIVE', 1);
    const redirectUris = _envCsv(prefix, 'REDIRECT_URIS');

    if (!issuer || !clientId) {
      logger.warn(`[oidc-env] ${prefix} missing ISSUER or CLIENT_ID — skipping`);
      continue;
    }

    const encSecret = clientSecret ? encryptClientSecret(clientSecret) : null;
    const redirectJson = JSON.stringify(redirectUris);
    const responseTypesJson = JSON.stringify(['code']);

    const existing = findExisting.get(issuer, clientId);
    let id;
    if (existing) {
      update.run(
        issuer, clientId, encSecret, redirectJson, scope,
        tokenAuthMethod,
        autoLink, autoRegister,
        adminGroupClaim, adminGroupValue,
        displayName, logoUrl, isActive,
        existing.id
      );
      id = existing.id;
    } else {
      const r = insert.run(
        issuer, clientId, encSecret, redirectJson, scope,
        tokenAuthMethod, responseTypesJson,
        'RS256', 'none', 30000,
        autoLink, autoRegister,
        adminGroupClaim, adminGroupValue,
        displayName, logoUrl, isActive
      );
      id = r.lastInsertRowid;
    }
    _envLockedIds.add(Number(id));
    count++;
  }

  if (count) {
    logger.info(`[oidc-env] Loaded ${count} OIDC provider${count === 1 ? '' : 's'} from environment (IDs: ${getEnvLockedProviderIds().join(', ')})`);
  }
}
