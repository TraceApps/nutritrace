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
]);

// ── GET /api/app-config/env-locks — which sections are locked by env vars ──
// Any authenticated user can read this (needed to disable UI fields)
router.get('/env-locks', requireAuth, wrap((req, res) => {
  res.json({ smtp: isSmtpEnvLocked(), ai: isAiEnvLocked() });
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

  res.json({
    sharing_enabled: true,
    foods:   countVisible('foods', 'food_shares', 'food_id'),
    meals:   countVisible('meals', 'meal_shares', 'meal_id', 'AND t.is_recipe = 0'),
    recipes: countVisible('meals', 'meal_shares', 'meal_id', 'AND t.is_recipe = 1'),
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
