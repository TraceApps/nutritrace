import express from 'express';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import AdmZip from 'adm-zip';
import multer from 'multer';
import db from '../db.js';
import { logger } from '../logger.js';
import { seedSmtpFromEnv } from '../email.js';
import { seedAiFromEnv } from '../ai.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import {
  localizeImageForStorage,
  writeImageFileAtomically,
} from '../lib/image-localizer.js';
import { localizeInlineSnapshotImages } from '../lib/inline-images.js';

const router = express.Router();
router.use(requireAuth);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const UPLOADS_DIR = process.env.UPLOADS_PATH  || path.resolve(__dirname, '..', 'uploads');
// Default backups inside the uploads volume so they survive container restarts
const BACKUPS_DIR = process.env.BACKUPS_PATH  || path.join(UPLOADS_DIR, 'backups');

fs.mkdirSync(BACKUPS_DIR, { recursive: true });

// ── Schedule config (admin-global, stored in app_config) ──────────────────
//
// Values:
//   backup_schedule       — 'off' | 'daily' | 'weekly' | 'monthly'
//   backup_time           — 'HH:MM' (24h, local server time)
//   backup_retention      — integer >= 1 (number of archives to keep)
//   backup_last_auto_run  — ISO timestamp of last successful auto-backup
//   backup_last_auto_error— string, last error message (cleared on success)
//
// Env-lock: BACKUP_SCHEDULE / BACKUP_TIME / BACKUP_RETENTION env vars
// override the stored values and lock the UI inputs. Lets ops operators
// bake the policy into Docker Compose without touching the admin UI.
const SCHEDULES = new Set(['off', 'daily', 'weekly', 'monthly']);
const DEFAULT_SCHEDULE = 'off';
const DEFAULT_TIME = '03:00';
const DEFAULT_RETENTION = 7;

export function isBackupEnvLocked() {
  return !!(process.env.BACKUP_SCHEDULE
         || process.env.BACKUP_TIME
         || process.env.BACKUP_RETENTION);
}

function _cfg(key) {
  return db.prepare('SELECT value FROM app_config WHERE key = ?').get(key)?.value;
}
function _setCfg(key, value) {
  db.prepare('INSERT INTO app_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value == null ? '' : String(value));
}

export function getScheduleConfig() {
  const envSchedule  = process.env.BACKUP_SCHEDULE;
  const envTime      = process.env.BACKUP_TIME;
  const envRetention = process.env.BACKUP_RETENTION;
  const schedule = SCHEDULES.has(envSchedule) ? envSchedule
                 : SCHEDULES.has(_cfg('backup_schedule')) ? _cfg('backup_schedule')
                 : DEFAULT_SCHEDULE;
  const time     = (envTime && /^\d{1,2}:\d{2}$/.test(envTime)) ? envTime
                 : (_cfg('backup_time') && /^\d{1,2}:\d{2}$/.test(_cfg('backup_time'))) ? _cfg('backup_time')
                 : DEFAULT_TIME;
  const retention = Math.max(1, Math.min(99, parseInt(envRetention || _cfg('backup_retention') || DEFAULT_RETENTION, 10) || DEFAULT_RETENTION));
  return {
    schedule, time, retention,
    lastAutoRun:   _cfg('backup_last_auto_run')   || null,
    lastAutoError: _cfg('backup_last_auto_error') || null,
    envLocked:     isBackupEnvLocked(),
  };
}

export function setScheduleConfig({ schedule, time, retention }) {
  if (isBackupEnvLocked()) {
    const err = new Error('Backup schedule is locked by environment variable');
    err.code = 'ENV_LOCKED';
    throw err;
  }
  if (schedule != null) {
    if (!SCHEDULES.has(schedule)) throw new Error('schedule must be one of: off, daily, weekly, monthly');
    _setCfg('backup_schedule', schedule);
  }
  if (time != null) {
    if (!/^\d{1,2}:\d{2}$/.test(time)) throw new Error('time must be HH:MM');
    const [h, m] = time.split(':').map(n => parseInt(n, 10));
    if (h < 0 || h > 23 || m < 0 || m > 59) throw new Error('time out of range');
    _setCfg('backup_time', `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
  }
  if (retention != null) {
    const r = parseInt(retention, 10);
    if (!Number.isFinite(r) || r < 1 || r > 99) throw new Error('retention must be 1-99');
    _setCfg('backup_retention', String(r));
  }
  return getScheduleConfig();
}

/** Create a full ZIP backup on disk and return {filename, size, createdAt}.
 *  Shared by the POST /api/full-backup handler AND the scheduler's
 *  auto-backup path so both produce identical archives. */
export function createBackup() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename  = `nutritrace-backup-${timestamp}.zip`;
  const destPath  = path.join(BACKUPS_DIR, filename);
  const zip = new AdmZip();
  zip.addFile('database.json', Buffer.from(JSON.stringify(dumpDatabase(), null, 2), 'utf8'));
  if (fs.existsSync(UPLOADS_DIR)) {
    const addDir = (dir, zipPath) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        const zp   = zipPath ? `${zipPath}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (full === BACKUPS_DIR) continue;
          addDir(full, zp);
        } else {
          zip.addFile(`images/${zp}`, fs.readFileSync(full));
        }
      }
    };
    addDir(UPLOADS_DIR, '');
  }
  zip.writeZip(destPath);
  const stat = fs.statSync(destPath);
  return { filename, size: stat.size, createdAt: new Date().toISOString() };
}

/** Delete archives beyond the retention limit, keeping the N newest.
 *  Sorts by filename timestamp (which is in the name itself) rather than
 *  mtime so a `cp -p` or similar copy doesn't reshuffle the keep order.
 *  Returns the list of deleted filenames. */
export function pruneOldBackups(retention) {
  const keep = Math.max(1, Math.min(99, parseInt(retention, 10) || DEFAULT_RETENTION));
  const all = fs.readdirSync(BACKUPS_DIR)
    .filter(f => f.startsWith('nutritrace-backup-') && f.endsWith('.zip'))
    .sort()
    .reverse(); // newest first (timestamp filenames sort lex-correctly)
  const toDelete = all.slice(keep);
  for (const f of toDelete) {
    try { fs.unlinkSync(path.join(BACKUPS_DIR, f)); }
    catch (e) { logger.warn(`[backup] prune failed for ${f}: ${e.message}`); }
  }
  return toDelete;
}

/** Run a scheduled backup: create, prune, mark success/failure in
 *  app_config so the status banner can surface what happened. Called by
 *  scheduler.js when the schedule says it's due. */
export async function runScheduledBackup() {
  const cfg = getScheduleConfig();
  try {
    const result = createBackup();
    pruneOldBackups(cfg.retention);
    _setCfg('backup_last_auto_run', new Date().toISOString());
    _setCfg('backup_last_auto_error', '');
    logger.info(`[backup] scheduled backup ok: ${result.filename} (${(result.size / 1024 / 1024).toFixed(1)} MB), pruned to ${cfg.retention}`);
    // Best-effort failure notification via push-notify if configured.
    // Success is silent (no notification on every successful nightly run);
    // failures notify because they need attention. Comment kept inline in
    // case we ever want a "weekly success digest" opt-in.
    return result;
  } catch (e) {
    _setCfg('backup_last_auto_error', e.message || String(e));
    logger.warn(`[backup] scheduled backup failed: ${e.message}`);
    // Push failure to the first admin user's configured channel if any.
    // Backups are admin-global, so the natural recipient is whichever admin
    // owns the box. Silent fallback if no admin has push-notify configured.
    try {
      const adminRow = db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get();
      if (adminRow) {
        const { pushNotify } = await import('../lib/push-notify.js');
        await pushNotify(adminRow.id, 'notifBackupFailed',
          '🛟 NutriTrace backup failed',
          `Scheduled backup error: ${e.message || 'unknown'}`,
          7);
      }
    } catch {}
    throw e;
  }
}

// Multer: stream to disk (temp dir) so large ZIPs don't OOM the container.
// 512 MB cap is generous for a full backup (DB + photos) but bounds disk-fill
// abuse from repeated half-finished uploads. Override with BACKUP_UPLOAD_MAX_MB
// if you legitimately need a larger limit.
const _backupMaxMb = parseInt(process.env.BACKUP_UPLOAD_MAX_MB || '512');
const upload = multer({
  storage: multer.diskStorage({ destination: (req, file, cb) => cb(null, os.tmpdir()) }),
  limits: { fileSize: _backupMaxMb * 1024 * 1024 },
});

async function localizeRestoreSnapshot(raw, context) {
  if (!raw || (typeof raw === 'string' && !raw.includes('data:image/'))) return raw;
  const wasSerialized = typeof raw === 'string';
  const value = wasSerialized ? JSON.parse(raw) : raw;
  const localized = await localizeInlineSnapshotImages(
    value,
    source => localizeImageForStorage(source, context)
  );
  return wasSerialized ? JSON.stringify(localized.value) : localized.value;
}

async function restoreFromZip(zip) {
  const data = JSON.parse(zip.readAsText('database.json'));

  // Normalize before the destructive restore transaction. A failed inline
  // image therefore aborts the restore without replacing the current DB.
  data.foods = await Promise.all((data.foods || []).map(async food => ({
    ...food,
    img_url: food.img_url
      ? await localizeImageForStorage(food.img_url, `restored food image id=${food.id ?? 'unknown'}`)
      : null,
  })));
  data.meals = await Promise.all((data.meals || []).map(async meal => ({
    ...meal,
    img_url: meal.img_url
      ? await localizeImageForStorage(meal.img_url, `restored meal image id=${meal.id ?? 'unknown'}`)
      : null,
    items: await localizeRestoreSnapshot(meal.items, `restored meal snapshot id=${meal.id ?? 'unknown'}`),
  })));
  data.diary = await Promise.all((data.diary || []).map(async entry => ({
    ...entry,
    items: await localizeRestoreSnapshot(entry.items, `restored diary snapshot id=${entry.id ?? entry.date ?? 'unknown'}`),
  })));

  db.transaction(() => {
    db.prepare('DELETE FROM password_reset_tokens').run();
    db.prepare('DELETE FROM invite_tokens').run();
    db.prepare('DELETE FROM food_shares').run();
    db.prepare('DELETE FROM meal_shares').run();
    db.prepare('DELETE FROM user_settings').run();
    db.prepare('DELETE FROM app_config').run();
    db.prepare('DELETE FROM diary').run();
    db.prepare('DELETE FROM foods').run();
    db.prepare('DELETE FROM meals').run();
    db.prepare('DELETE FROM users').run();

    const insUser = db.prepare(`
      INSERT OR IGNORE INTO users (id, username, password_hash, full_name, nickname, email, birthday, gender, avatar_url, role, created_at)
      VALUES (@id, @username, @password_hash, @full_name, @nickname, @email, @birthday, @gender, @avatar_url, @role, @created_at)
    `);
    for (const u of data.users || []) insUser.run(u);

    // COALESCE updated_at to NOW: backups from before the column existed
    // (or rows missing it) would otherwise restore with NULL, which the
    // Android delta sync silently skips. Forcing NOW means restored rows
    // become visible to the next pull (#39 followup).
    // rc.50 OFF metadata columns (nutrition_basis, alt_units, density_g_ml)
    // must be listed explicitly — better-sqlite3 silently ignores extra named
    // parameters, so a SELECT * dump plus a partial INSERT column list would
    // round-trip these values as NULL, silently losing every user's serving
    // units (slice / cookie / bottle) + per-ml-vs-per-g basis + density.
    const insFood = db.prepare(`
      INSERT OR IGNORE INTO foods (id, user_id, name, brand, nutrition, portion, unit, img_url, notes, category, barcode, visibility, source_id, favorite, usage_count, last_used_at, nutrition_basis, alt_units, density_g_ml, created_at, updated_at, deleted_at)
      VALUES (@id, @user_id, @name, @brand, @nutrition, @portion, @unit, @img_url, @notes, @category, @barcode, @visibility, @source_id, @favorite, @usage_count, @last_used_at, @nutrition_basis, @alt_units, @density_g_ml, @created_at, COALESCE(@updated_at, datetime('now')), @deleted_at)
    `);
    for (const f of data.foods || []) insFood.run({ visibility: 'private', source_id: null, favorite: 0, usage_count: 0, last_used_at: null, nutrition_basis: null, alt_units: null, density_g_ml: null, updated_at: null, deleted_at: null, ...f });

    const insMeal = db.prepare(`
      INSERT OR IGNORE INTO meals (id, user_id, name, nutrition, items, img_url, notes, is_recipe, portion, unit, servings, visibility, source_id, favorite, usage_count, last_used_at, created_at, updated_at, deleted_at)
      VALUES (@id, @user_id, @name, @nutrition, @items, @img_url, @notes, @is_recipe, @portion, @unit, @servings, @visibility, @source_id, @favorite, @usage_count, @last_used_at, @created_at, COALESCE(@updated_at, datetime('now')), @deleted_at)
    `);
    for (const m of data.meals || []) insMeal.run({ visibility: 'private', source_id: null, favorite: 0, usage_count: 0, last_used_at: null, updated_at: null, deleted_at: null, servings: null, ...m });

    const insFoodShare = db.prepare(`INSERT OR IGNORE INTO food_shares (food_id, user_id) VALUES (@food_id, @user_id)`);
    for (const fs of data.food_shares || []) insFoodShare.run(fs);

    const insMealShare = db.prepare(`INSERT OR IGNORE INTO meal_shares (meal_id, user_id) VALUES (@meal_id, @user_id)`);
    for (const ms of data.meal_shares || []) insMealShare.run(ms);

    // COALESCE updated_at to NOW so pre-#39 rows without the column don't
    // restore as NULL — same rule as foods/meals. NULL updated_at is silently
    // skipped by the Android delta sync's `WHERE updated_at >= ?` filter.
    const insDiary = db.prepare(`
      INSERT OR IGNORE INTO diary (id, user_id, date, items, body_stats, water, notes, updated_at, deleted_at)
      VALUES (@id, @user_id, @date, @items, @body_stats, @water, @notes, COALESCE(@updated_at, datetime('now')), @deleted_at)
    `);
    for (const d of data.diary || []) insDiary.run({ notes: null, updated_at: null, deleted_at: null, ...d });

    const insSettings = db.prepare(`
      INSERT OR IGNORE INTO user_settings (user_id, key, value, updated_at, deleted_at) VALUES (@user_id, @key, @value, COALESCE(@updated_at, datetime('now')), @deleted_at)
    `);
    for (const s of data.user_settings || []) insSettings.run({ updated_at: null, deleted_at: null, ...s });

    const insConfig = db.prepare(`
      INSERT OR REPLACE INTO app_config (key, value) VALUES (@key, @value)
    `);
    for (const c of data.app_config || []) insConfig.run(c);

    db.prepare('DELETE FROM ai_chat_history').run();
    const insChat = db.prepare(`
      INSERT OR IGNORE INTO ai_chat_history (id, user_id, role, content, created_at)
      VALUES (@id, @user_id, @role, @content, @created_at)
    `);
    for (const m of data.ai_chat_history || []) insChat.run(m);

    db.prepare('DELETE FROM wellness_data').run();
    const insWellness = db.prepare(`
      INSERT OR IGNORE INTO wellness_data (id, user_id, date, source, metric_type, value, metadata, synced_at, device_model)
      VALUES (@id, @user_id, @date, @source, @metric_type, @value, @metadata, @synced_at, @device_model)
    `);
    for (const w of data.wellness_data || []) insWellness.run(w);

    db.prepare('DELETE FROM workouts').run();
    const insWorkout = db.prepare(`
      INSERT OR IGNORE INTO workouts (id, user_id, source, source_id, date, activity_type, activity_name, start_time, duration_ms, distance_km, calories, avg_hr, max_hr, steps, has_gps, gps_data, synced_at, updated_at)
      VALUES (@id, @user_id, @source, @source_id, @date, @activity_type, @activity_name, @start_time, @duration_ms, @distance_km, @calories, @avg_hr, @max_hr, @steps, @has_gps, @gps_data, @synced_at, @updated_at)
    `);
    for (const w of data.workouts || []) insWorkout.run(w);

    db.prepare('DELETE FROM activity_log').run();
    const insActivity = db.prepare(`
      INSERT OR IGNORE INTO activity_log (id, user_id, date, name, kcal, duration_min, distance, source, met, is_template, created_at, updated_at, deleted_at)
      VALUES (@id, @user_id, @date, @name, @kcal, @duration_min, @distance, @source, @met, @is_template, @created_at, @updated_at, @deleted_at)
    `);
    for (const a of data.activity_log || []) insActivity.run({ met: null, is_template: 0, deleted_at: null, ...a });

    // Intermittent fasting log
    db.prepare('DELETE FROM fasts').run();
    const insFast = db.prepare(`
      INSERT OR IGNORE INTO fasts (id, user_id, start_at, end_at, goal_hours, notes, created_at, updated_at, deleted_at)
      VALUES (@id, @user_id, @start_at, @end_at, @goal_hours, @notes, @created_at, @updated_at, @deleted_at)
    `);
    for (const f of data.fasts || []) insFast.run({ end_at: null, notes: null, deleted_at: null, ...f });

    // OIDC providers — admin config; client_secret is encrypted with the
    // deploy's JWT_SECRET, so cross-deploy restores will need the secret
    // re-entered from the admin UI.
    db.prepare('DELETE FROM oidc_providers').run();
    const insOidcProvider = db.prepare(`
      INSERT OR IGNORE INTO oidc_providers (
        id, issuer_url, client_id, client_secret, redirect_uris, scope,
        token_endpoint_auth_method, response_types,
        id_token_signed_response_alg, userinfo_signed_response_alg, request_timeout_ms,
        auto_register, auto_link_verified_email, auto_register_new_users,
        admin_group_claim, admin_group_value,
        display_name, logo_url, is_active, created_at, updated_at
      ) VALUES (
        @id, @issuer_url, @client_id, @client_secret, @redirect_uris, @scope,
        @token_endpoint_auth_method, @response_types,
        @id_token_signed_response_alg, @userinfo_signed_response_alg, @request_timeout_ms,
        @auto_register, @auto_link_verified_email, @auto_register_new_users,
        @admin_group_claim, @admin_group_value,
        @display_name, @logo_url, @is_active, @created_at, @updated_at
      )
    `);
    for (const p of data.oidc_providers || []) insOidcProvider.run({
      auto_register: 0, auto_link_verified_email: 1, auto_register_new_users: 0, ...p,
    });

    db.prepare('DELETE FROM user_oidc_links').run();
    const insOidcLink = db.prepare(`
      INSERT OR IGNORE INTO user_oidc_links (id, user_id, oidc_provider_id, oidc_sub, email_verified, last_login_at, created_at)
      VALUES (@id, @user_id, @oidc_provider_id, @oidc_sub, @email_verified, @last_login_at, @created_at)
    `);
    for (const l of data.user_oidc_links || []) insOidcLink.run({ email_verified: 0, last_login_at: null, ...l });

    // Federation API tokens — token_hash is opaque SHA-256, users can't
    // regenerate the same token. Preserving these across restore keeps
    // configured federated peers connected.
    db.prepare('DELETE FROM api_tokens').run();
    const insApiToken = db.prepare(`
      INSERT OR IGNORE INTO api_tokens (id, user_id, name, token_hash, scopes, expires_at, last_used_at, created_at)
      VALUES (@id, @user_id, @name, @token_hash, @scopes, @expires_at, @last_used_at, @created_at)
    `);
    for (const t of data.api_tokens || []) insApiToken.run({ expires_at: null, last_used_at: null, ...t });

    // Outstanding invite tokens so pending invites don't 404 after restore.
    db.prepare('DELETE FROM invite_tokens').run();
    const insInvite = db.prepare(`
      INSERT OR IGNORE INTO invite_tokens (token, email, role, created_by, expires_at, used)
      VALUES (@token, @email, @role, @created_by, @expires_at, @used)
    `);
    for (const i of data.invite_tokens || []) insInvite.run({ email: null, role: 'user', created_by: null, used: 0, ...i });
  })();

  // Restore images — guard against zip-slip and zip-bomb attacks
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  const uploadsResolved = path.resolve(UPLOADS_DIR);
  const MAX_ENTRIES = 10_000;
  const MAX_BYTES   = 5 * 1024 * 1024 * 1024; // 5 GB total uncompressed
  let extracted = 0;
  let totalBytes = 0;
  for (const entry of zip.getEntries()) {
    if (!entry.entryName.startsWith('images/') || entry.isDirectory) continue;
    if (++extracted > MAX_ENTRIES) throw new Error(`Backup contains too many image entries (>${MAX_ENTRIES})`);
    const rel  = entry.entryName.slice('images/'.length);
    // Reject any path that escapes UPLOADS_DIR via .. or absolute path components.
    if (!rel || rel.includes('..') || path.isAbsolute(rel)) {
      throw new Error(`Refusing unsafe path in backup: ${entry.entryName}`);
    }
    const dest = path.resolve(UPLOADS_DIR, rel);
    if (!dest.startsWith(uploadsResolved + path.sep)) {
      throw new Error(`Refusing path traversal in backup: ${entry.entryName}`);
    }
    const data = entry.getData();
    totalBytes += data.length;
    if (totalBytes > MAX_BYTES) throw new Error(`Backup uncompressed size exceeds ${MAX_BYTES} bytes (zip-bomb defense)`);
    writeImageFileAtomically(dest, data);
  }

  // Re-apply env-var config so lock flags always reflect the current environment,
  // regardless of what was in the backup (the backup may predate the lock flags).
  seedSmtpFromEnv();
  seedAiFromEnv();
}

function dumpDatabase() {
  // ── Coverage audit (2026-07) ─────────────────────────────────────────────
  // Every user-content table in server/db.js is included below. Deliberate
  // exclusions and their rationale:
  //   fitbit_tokens, google_health_tokens, withings_tokens, garmin_tokens
  //     — OAuth access/refresh tokens encrypted at rest with the deploy's
  //       JWT_SECRET (see server/lib/token-crypto.js). A restore into a
  //       different deploy cannot decrypt them, and re-linking the wearable
  //       from Settings is a one-tap flow. TODO(review): if we ever want
  //       cross-deploy wearable continuity, revisit this — the trade-off is
  //       shipping the token-crypto key alongside the archive (or moving to
  //       a passphrase-derived key at backup time).
  //   password_reset_tokens
  //     — 30-min-lived; capturing them adds security surface without value.
  //       The restore path explicitly DELETEs any stale rows.
  //   oauth_state
  //     — Ephemeral PKCE state, expires within minutes; never worth carrying.
  //
  // DEVICE_PREFS handling: DEVICE_PREFS keys (see src/stores/settings.js)
  // are client-only and NEVER written to server user_settings, so dumping
  // user_settings correctly captures only sync-across-devices USER_PREFS.
  // A restore therefore leaves the restoring device's local UI prefs
  // (appearance, navStyle, biometricLoginEnabled, etc.) intact by design.
  // TODO(review): if a future migration ever persists any DEVICE_PREFS key
  // server-side, revisit this and add an opt-out on the restore path so
  // per-device settings don't cross devices.
  return {
    users:            db.prepare('SELECT * FROM users').all(),
    foods:            db.prepare('SELECT * FROM foods').all(),
    meals:            db.prepare('SELECT * FROM meals').all(),
    food_shares:      db.prepare('SELECT * FROM food_shares').all(),
    meal_shares:      db.prepare('SELECT * FROM meal_shares').all(),
    diary:            db.prepare('SELECT * FROM diary').all(),
    user_settings:    db.prepare('SELECT * FROM user_settings').all(),
    app_config:       db.prepare('SELECT * FROM app_config').all(),
    ai_chat_history:  db.prepare('SELECT * FROM ai_chat_history').all(),
    // wellness_data holds BOTH raw wearable metrics AND Trace-computed
    // readiness / resilience score rows (metric_type = 'readiness_score',
    // 'resilience_score'), so past scores survive a full-backup restore.
    wellness_data:    db.prepare('SELECT * FROM wellness_data').all(),
    workouts:         db.prepare('SELECT * FROM workouts').all(),
    activity_log:     db.prepare('SELECT * FROM activity_log').all(),
    fasts:            db.prepare('SELECT * FROM fasts').all(),
    oidc_providers:   db.prepare('SELECT * FROM oidc_providers').all(),
    user_oidc_links:  db.prepare('SELECT * FROM user_oidc_links').all(),
    // Federation API tokens — stored as SHA-256 hashes, so a user can't
    // regenerate the same token after a restore. Capturing them lets every
    // configured federated peer keep working after a restore.
    api_tokens:       db.prepare('SELECT * FROM api_tokens').all(),
    // Outstanding invite tokens so pending invites survive a restore.
    invite_tokens:    db.prepare('SELECT * FROM invite_tokens').all(),
  };
}

// ── POST /api/full-backup  — create a new backup (manual button) ──────────
router.post('/', requireAdmin, (req, res) => {
  try {
    const result = createBackup();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/full-backup/schedule  — read auto-backup config + status ─────
router.get('/schedule', requireAdmin, (req, res) => {
  try {
    res.json(getScheduleConfig());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/full-backup/schedule  — write auto-backup config ─────────────
router.put('/schedule', requireAdmin, (req, res) => {
  try {
    const result = setScheduleConfig(req.body || {});
    res.json(result);
  } catch (err) {
    const status = err.code === 'ENV_LOCKED' ? 409 : 400;
    res.status(status).json({ error: err.message });
  }
});

// ── GET /api/full-backup  — list backups ───────────────────────────────────
router.get('/', requireAdmin, (req, res) => {
  try {
    const files = fs.readdirSync(BACKUPS_DIR)
      .filter(f => f.endsWith('.zip'))
      .map(f => {
        const stat = fs.statSync(path.join(BACKUPS_DIR, f));
        return { filename: f, size: stat.size, createdAt: stat.mtime.toISOString() };
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    res.json(files);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/full-backup/:name/download ───────────────────────────────────
router.get('/:name/download', requireAdmin, (req, res) => {
  const filename = path.basename(req.params.name); // prevent path traversal
  // Only serve files that look like backups — the BACKUPS_DIR is under
  // UPLOADS_DIR, so without this guard an admin could grab arbitrary uploaded
  // images by name.
  if (!filename.toLowerCase().endsWith('.zip')) {
    return res.status(404).json({ error: 'Not found' });
  }
  const filePath = path.join(BACKUPS_DIR, filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
  res.download(filePath, filename);
});

// ── DELETE /api/full-backup/:name ─────────────────────────────────────────
router.delete('/:name', requireAdmin, (req, res) => {
  const filename = path.basename(req.params.name);
  if (!filename.toLowerCase().endsWith('.zip')) {
    return res.status(404).json({ error: 'Not found' });
  }
  const filePath = path.join(BACKUPS_DIR, filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
  fs.unlinkSync(filePath);
  res.json({ ok: true });
});

// ── POST /api/full-backup/:name/restore — restore from a server-side backup ─
router.post('/:name/restore', requireAdmin, async (req, res) => {
  const filename = path.basename(req.params.name);
  const filePath = path.join(BACKUPS_DIR, filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
  try {
    await restoreFromZip(new AdmZip(filePath));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/full-backup/upload-restore — upload a ZIP and restore from it ─
router.post('/upload-restore', requireAdmin, upload.single('backup'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    await restoreFromZip(new AdmZip(req.file.path));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    // Clean up temp file
    try { fs.unlinkSync(req.file.path); } catch {}
  }
});

export default router;
