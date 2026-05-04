/**
 * server/lib/api-tokens.js
 *
 * Personal access token management for the federation API (/api/v1/*).
 * Tokens are SHA-256 hashed at rest. Raw values are returned to the
 * caller exactly once at creation; lookup is hash-based.
 *
 * Token format: `nt_pat_<43 base64url chars>`. The `nt_pat_` prefix
 * makes leaked tokens recognizable in logs and credential scanners.
 *
 * See docs/federation.md for the wire contract.
 */
import { randomBytes, createHash } from 'crypto';
import db from '../db.js';

const TOKEN_PREFIX = 'nt_pat_';
const TOKEN_BYTES = 32;  // 256-bit secret

/** Known scopes. Reject token creation requests with anything not on this list.
 *  Phase 1 is read-only and ships only `read:foods`. Additional read scopes
 *  (`read:meals`, `read:diary`) and any write scopes will be added back
 *  alongside the endpoints they unlock — gating tokens on scopes the server
 *  can't actually serve is just confusing UI. */
export const KNOWN_SCOPES = new Set([
  'read:foods',
]);

function _hash(raw) {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

function _generateRaw() {
  // base64url is URL-safe and slightly shorter than hex
  const bytes = randomBytes(TOKEN_BYTES);
  const b64 = bytes.toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  return TOKEN_PREFIX + b64;
}

/**
 * Create a new token for a user.
 *
 * Returns { row, raw } where `raw` is the only place the plaintext
 * token ever exists. The caller is responsible for displaying it to
 * the user once and never logging it.
 */
export function createToken({ userId, name, scopes, expiresAt = null }) {
  if (!userId) throw new Error('userId required');
  const trimmedName = String(name || '').trim().slice(0, 80);
  if (!trimmedName) throw new Error('name required');

  // Validate scopes against known list. Drop unknowns silently rather
  // than throwing — forward-compatibility for clients that try to
  // request scopes from a future version.
  const requested = Array.isArray(scopes) ? scopes : [];
  const validScopes = requested.filter(s => KNOWN_SCOPES.has(String(s)));
  if (validScopes.length === 0) throw new Error('At least one valid scope required');

  const raw = _generateRaw();
  const hash = _hash(raw);
  const r = db.prepare(
    `INSERT INTO api_tokens (user_id, name, token_hash, scopes, expires_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(userId, trimmedName, hash, JSON.stringify(validScopes), expiresAt);

  const row = db.prepare(
    `SELECT id, user_id, name, scopes, expires_at, last_used_at, created_at
       FROM api_tokens WHERE id = ?`
  ).get(r.lastInsertRowid);
  return { row: _parseRow(row), raw };
}

/** List tokens for a user. Never returns the hash or raw value. */
export function listTokens(userId) {
  return db.prepare(
    `SELECT id, user_id, name, scopes, expires_at, last_used_at, created_at
       FROM api_tokens
      WHERE user_id = ?
      ORDER BY created_at DESC`
  ).all(userId).map(_parseRow);
}

/** Revoke a token. Returns true if a row was removed. */
export function revokeToken({ userId, id }) {
  const r = db.prepare(
    `DELETE FROM api_tokens WHERE id = ? AND user_id = ?`
  ).run(id, userId);
  return r.changes > 0;
}

/**
 * Look up a token by its raw value. Returns the joined { token, user }
 * row or null. Updates last_used_at on a successful match.
 */
export function lookupRawToken(raw) {
  if (!raw || typeof raw !== 'string' || !raw.startsWith(TOKEN_PREFIX)) return null;
  const hash = _hash(raw);
  const row = db.prepare(
    `SELECT t.id, t.user_id, t.name, t.scopes, t.expires_at, t.last_used_at, t.created_at,
            u.username, u.full_name, u.role
       FROM api_tokens t
       JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = ?`
  ).get(hash);
  if (!row) return null;

  // Expiry check
  if (row.expires_at) {
    const expiresMs = new Date(row.expires_at + 'Z').getTime();
    if (Number.isFinite(expiresMs) && expiresMs < Date.now()) return null;
  }

  // Touch last_used_at (best-effort; not in a transaction with the read)
  try {
    db.prepare(`UPDATE api_tokens SET last_used_at = datetime('now') WHERE id = ?`).run(row.id);
  } catch {}

  return {
    token: {
      id: row.id,
      user_id: row.user_id,
      name: row.name,
      scopes: _parseScopes(row.scopes),
      expires_at: row.expires_at,
      last_used_at: row.last_used_at,
      created_at: row.created_at,
    },
    user: {
      id: row.user_id,
      username: row.username,
      full_name: row.full_name,
      role: row.role,
    },
  };
}

function _parseRow(row) {
  if (!row) return null;
  return { ...row, scopes: _parseScopes(row.scopes) };
}

function _parseScopes(s) {
  try { const a = JSON.parse(s || '[]'); return Array.isArray(a) ? a : []; }
  catch { return []; }
}
