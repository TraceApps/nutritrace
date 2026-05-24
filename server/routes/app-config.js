import { Router } from 'express';
import db from '../db.js';
import { wrap } from '../logger.js';
import { requireAuth, requireAdmin, userMgmtActive } from '../middleware/auth.js';
import { testSmtp, isSmtpEnvLocked } from '../email.js';
import { isAiEnvLocked } from '../ai.js';

const router = Router();

const ALLOWED_KEYS = new Set([
  'smtp_host', 'smtp_port', 'smtp_secure', 'smtp_user', 'smtp_pass', 'smtp_from',
  'ai_enabled', 'ai_provider', 'ai_api_key', 'ai_model',
  'session_hours',
  'fitbit_client_id', 'fitbit_client_secret', 'fitbit_redirect_uri',
  'withings_client_id', 'withings_client_secret', 'withings_redirect_uri',
  'sharing_enabled', 'default_food_visibility',
  // Per-category bulk-share state (persists what the admin last applied so
  // the form pre-fills correctly). Visibility values: private | group | specific.
  // The user-list keys are JSON-encoded arrays of user ids (used when
  // visibility=specific).
  'bulk_vis_foods', 'bulk_vis_meals', 'bulk_vis_recipes',
  'bulk_users_foods', 'bulk_users_meals', 'bulk_users_recipes',
  'password_policy',
]);

// ── GET /api/app-config/env-locks — which sections are locked by env vars ──
// Any authenticated user can read this (needed to disable UI fields)
router.get('/env-locks', requireAuth, wrap(async (req, res) => {
  // Lazy import — oidc-env is only meaningful when OIDC is configured.
  const { getEnvLockedProviderIds } = await import('../lib/oidc-env.js');
  // Surface ai_enabled too when the AI section is env-locked. Without it
  // the client can disable the toggle but has no way to know whether the
  // env operator wanted AI ON or OFF — the toggle just sticks at the
  // per-user setting, which is OFF by default. Fixes #36.
  const aiLocked = isAiEnvLocked();
  let ai_enabled = false;
  if (aiLocked) {
    const row = db.prepare(`SELECT value FROM app_config WHERE key = 'ai_enabled'`).get();
    ai_enabled = row?.value === 'true';
  }
  // off_local: signals to the Android client that the server has a local
  // OFF mirror configured (OFF_LOCAL_DB set). The native client uses this
  // to decide whether to route OFF lookups through the server proxy
  // (respects the mirror) vs CapacitorHttp direct (legacy default). Without
  // this signal Android would bypass the mirror entirely. The Settings UI
  // also reads it to show a "Local mirror active" status row in the OFF
  // section. off_local_only surfaces the air-gap policy so the UI can
  // call it out separately. See server/lib/off-local.js. Issue #22.
  const off_local = !!process.env.OFF_LOCAL_DB;
  const off_local_only = off_local && !!process.env.OFF_LOCAL_ONLY;
  res.json({
    smtp: isSmtpEnvLocked(),
    ai: aiLocked,
    ai_enabled,
    off_local,
    off_local_only,
    oidc_provider_ids: getEnvLockedProviderIds(),
  });
}));

// ── GET /api/app-config/sharing — sharing status + per-category counts (any auth user) ───
router.get('/sharing', requireAuth, wrap((req, res) => {
  const row = db.prepare('SELECT value FROM app_config WHERE key = ?').get('sharing_enabled');
  const enabled = row?.value === 'true';
  if (!enabled) return res.json({ sharing_enabled: false, foods: 0, meals: 0, recipes: 0 });

  const u = userMgmtActive() ? req.user.id : null;
  if (u == null) return res.json({ sharing_enabled: true, foods: 0, meals: 0, recipes: 0 });

  // Count items from OTHER users visible to this user
  const countVisible = (table, shareTable, shareCol, extraWhere = '') => {
    const groupCount = db.prepare(`SELECT COUNT(*) as c FROM ${table} t WHERE t.user_id != ? AND t.visibility = 'group' ${extraWhere}`).get(u).c;
    const specificCount = db.prepare(
      `SELECT COUNT(*) as c FROM ${table} t JOIN ${shareTable} s ON s.${shareCol} = t.id WHERE t.user_id != ? AND t.visibility = 'specific' AND s.user_id = ? ${extraWhere}`
    ).get(u, u).c;
    return groupCount + specificCount;
  };

  // Pre-fill state for the admin-only Bulk Share form. Safe to expose to any
  // authenticated user — these values aren't sensitive (just admin's last
  // visibility choice) and the form only renders for admins anyway.
  const cfgRow = key => db.prepare('SELECT value FROM app_config WHERE key = ?').get(key)?.value || null;
  const parseUserIds = v => { try { return JSON.parse(v) || []; } catch { return []; } };

  res.json({
    sharing_enabled: true,
    foods:   countVisible('foods', 'food_shares', 'food_id'),
    meals:   countVisible('meals', 'meal_shares', 'meal_id', 'AND t.is_recipe = 0'),
    recipes: countVisible('meals', 'meal_shares', 'meal_id', 'AND t.is_recipe = 1'),
    bulk: {
      foods:   { visibility: cfgRow('bulk_vis_foods')   || 'private', user_ids: parseUserIds(cfgRow('bulk_users_foods'))   },
      meals:   { visibility: cfgRow('bulk_vis_meals')   || 'private', user_ids: parseUserIds(cfgRow('bulk_users_meals'))   },
      recipes: { visibility: cfgRow('bulk_vis_recipes') || 'private', user_ids: parseUserIds(cfgRow('bulk_users_recipes')) },
    },
  });
}));

// ── GET /api/app-config — return all config (passwords redacted) ───────────
router.get('/', requireAuth, requireAdmin, wrap((req, res) => {
  const rows = db.prepare('SELECT key, value FROM app_config').all();
  const out = {};
  for (const { key, value } of rows) {
    const redacted = key === 'smtp_pass' || key === 'ai_api_key' || key === 'fitbit_client_secret' || key === 'withings_client_secret';
    out[key] = redacted ? (value ? '••••••••' : '') : (value || '');
  }
  res.json(out);
}));

// ── PUT /api/app-config — upsert one key ──────────────────────────────────
router.put('/', requireAuth, requireAdmin, wrap((req, res) => {
  const { key, value } = req.body;
  if (!ALLOWED_KEYS.has(key)) return res.status(400).json({ error: 'Unknown config key' });
  // Block writes to env-locked sections
  if (key.startsWith('smtp_') && isSmtpEnvLocked()) return res.status(403).json({ error: 'SMTP is configured via environment variables and cannot be changed here.' });
  if (key.startsWith('ai_')   && isAiEnvLocked())   return res.status(403).json({ error: 'AI is configured via environment variables and cannot be changed here.' });
  // Don't overwrite secrets with the redaction placeholder
  if ((key === 'smtp_pass' || key === 'ai_api_key' || key === 'fitbit_client_secret' || key === 'withings_client_secret') && value === '••••••••') return res.json({ ok: true });
  db.prepare('INSERT INTO app_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value || null);

  // When disabling sharing, reset ALL items to private and clear share grants
  if (key === 'sharing_enabled' && value !== 'true') {
    db.transaction(() => {
      db.prepare(`UPDATE foods SET visibility = 'private' WHERE visibility != 'private'`).run();
      db.prepare(`UPDATE meals SET visibility = 'private' WHERE visibility != 'private'`).run();
      db.prepare(`DELETE FROM food_shares`).run();
      db.prepare(`DELETE FROM meal_shares`).run();
    })();
  }

  res.json({ ok: true });
}));

// ── POST /api/app-config/test-email — verify SMTP connection ─────────────
router.post('/test-email', requireAuth, requireAdmin, wrap(async (req, res) => {
  await testSmtp();
  res.json({ ok: true });
}));

export default router;
