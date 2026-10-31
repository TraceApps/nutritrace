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
import { isValidTimeZone, processTimeZone } from '../lib/zoned-time.js';
import { effectiveTimeZone, nextBackupAt, backupFileStamp, newestFirst } from '../lib/backup-schedule.js';
// Makes the two-step sign-in tables a backup reads and restores (#222).
import { logAfterRestore as logTwoStepAfterRestore } from '../lib/two-step.js';
import { keepSessionVersions } from '../lib/session-version.js';

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
//   backup_time           : 'HH:MM' (24h, in backup_time_zone)
//   backup_time_zone      : IANA zone of the browser that set the time; '' = the server's (TZ, else UTC)
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
  // The zone the time is in: saved with it from the browser that set it
  // (TraceApps/notetrace#44); none (older installs, a schedule set by
  // environment) runs in the server's own zone, TZ or UTC. Environment-set
  // schedules follow TZ.
  const saved = isBackupEnvLocked() ? null : (_cfg('backup_time_zone') || null);
  const timeZone = isValidTimeZone(saved) ? saved : null;
  const lastAutoRun = _cfg('backup_last_auto_run') || null;
  const setAt = _cfg('backup_schedule_set_at') || null;
  return {
    schedule, time, retention,
    timeZone,
    runsIn:        effectiveTimeZone(timeZone),
    serverTimeZone: processTimeZone(),
    setAt,
    nextRunAt:     nextBackupAt({ schedule, time, timeZone, lastAutoRun, setAt }),
    lastAutoRun,
    lastAutoError: _cfg('backup_last_auto_error') || null,
    envLocked:     isBackupEnvLocked(),
  };
}

export function setScheduleConfig({ schedule, time, retention, timeZone }) {
  if (isBackupEnvLocked()) {
    const err = new Error('Backup schedule is locked by environment variable');
    err.code = 'ENV_LOCKED';
    throw err;
  }
  // Every field checked before any is saved: a bad one changes nothing.
  const writes = [];
  if (schedule != null) {
    if (!SCHEDULES.has(schedule)) throw new Error('schedule must be one of: off, daily, weekly, monthly');
    writes.push(['backup_schedule', schedule]);
  }
  if (time != null) {
    if (!/^\d{1,2}:\d{2}$/.test(time)) throw new Error('time must be HH:MM');
    const [h, m] = time.split(':').map(n => parseInt(n, 10));
    if (h < 0 || h > 23 || m < 0 || m > 59) throw new Error('time out of range');
    writes.push(['backup_time', `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`]);
  }
  if (retention != null) {
    const r = parseInt(retention, 10);
    if (!Number.isFinite(r) || r < 1 || r > 99) throw new Error('retention must be 1-99');
    writes.push(['backup_retention', String(r)]);
  }
  // An IANA zone such as "America/New_York"; '' goes back to the server's zone.
  if (timeZone !== undefined) {
    if (timeZone === null || timeZone === '') writes.push(['backup_time_zone', '']);
    else if (!isValidTimeZone(timeZone)) throw new Error('timeZone must be an IANA time zone, such as America/New_York');
    else writes.push(['backup_time_zone', timeZone]);
  }
  // When it was set, for a first run that comes at its time (backup-schedule.js).
  if (schedule != null || time != null || timeZone !== undefined) writes.push(['backup_schedule_set_at', new Date().toISOString()]);
  db.transaction(() => { for (const [k, v] of writes) _setCfg(k, v); })();
  return getScheduleConfig();
}

/** Create a full ZIP backup on disk and return {filename, size, createdAt}.
 *  Shared by the POST /api/full-backup handler AND the scheduler's
 *  auto-backup path so both produce identical archives. */
export function createBackup({ now = Date.now() } = {}) {
  // Named in the schedule's zone with its offset (TraceApps/notetrace#44).
  // Never overwrite: two backups in the same second get a number.
  const timestamp = backupFileStamp(getScheduleConfig().timeZone, now);
  let filename = `nutritrace-backup-${timestamp}.zip`;
  for (let n = 2; fs.existsSync(path.join(BACKUPS_DIR, filename)); n++) filename = `nutritrace-backup-${timestamp}-${n}.zip`;
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
  return { filename, size: stat.size, createdAt: new Date(now).toISOString() };
}

/** Delete archives beyond the retention limit, keeping the N newest.
 *  Newest first by when each was made, read from the name (local time
 *  with its offset since TraceApps/notetrace#44, UTC before), so a copy
 *  that lost its file dates (a plain `cp` without -p) still keeps the right
 *  ones; the file's date only for other names.
 *  Returns the list of deleted filenames. */
export function pruneOldBackups(retention) {
  const keep = Math.max(1, Math.min(99, parseInt(retention, 10) || DEFAULT_RETENTION));
  const all = newestFirst(fs.readdirSync(BACKUPS_DIR)
    .filter(f => f.startsWith('nutritrace-backup-') && f.endsWith('.zip'))
    .map(name => ({ name, mtime: (() => { try { return fs.statSync(path.join(BACKUPS_DIR, name)).mtimeMs; } catch { return 0; } })() })))
    .map(x => x.name);
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

function restoreFromZip(zip) {
  const data = JSON.parse(zip.readAsText('database.json'));

  // Signed-out sessions stay signed out (lib/session-version.js).
  keepSessionVersions(() => db.transaction(() => {
    // What devices may hold of the tables that say a row is gone only with
    // its deleted_at, read before the wipe (keepGone, below).
    const before = rowsBefore(data);
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
    // field_times: when each synced field last changed (lib/field-sync.js),
    // so a restored row's fields keep their own times (a backup from before
    // has none: the row counts from its own updated_at, as then).
    // client_key: the key the Android app made a row with (lib/create-keys.js),
    // so a create it sends again after the restore finds its row instead of
    // making a second one. changed_at, the pull's cursor, is the trigger's
    // (now), so every device pulls the restored rows.
    const insFood = db.prepare(`
      INSERT OR IGNORE INTO foods (id, user_id, name, brand, nutrition, portion, unit, img_url, notes, category, barcode, visibility, source_id, favorite, usage_count, last_used_at, nutrition_basis, alt_units, density_g_ml, source_app, source_external_id, source_url, created_at, updated_at, deleted_at, field_times, client_key)
      VALUES (@id, @user_id, @name, @brand, @nutrition, @portion, @unit, @img_url, @notes, @category, @barcode, @visibility, @source_id, @favorite, @usage_count, @last_used_at, @nutrition_basis, @alt_units, @density_g_ml, @source_app, @source_external_id, @source_url, @created_at, COALESCE(@updated_at, datetime('now')), @deleted_at, @field_times, @client_key)
    `);
    for (const f of data.foods || []) insFood.run({ visibility: 'private', source_id: null, favorite: 0, usage_count: 0, last_used_at: null, nutrition_basis: null, alt_units: null, density_g_ml: null, source_app: null, source_external_id: null, source_url: null, updated_at: null, deleted_at: null, field_times: null, client_key: null, ...f });

    // Federation source columns (source_app / source_external_id / source_url /
    // import_warnings, added for the CookTrace pull flow) are part of the
    // meals row now. Restoring without them silently drops the "From
    // CookTrace" badge and the deep-link back to the source on restore.
    const insMeal = db.prepare(`
      INSERT OR IGNORE INTO meals (id, user_id, name, nutrition, items, img_url, notes, is_recipe, portion, unit, servings, visibility, source_id, favorite, usage_count, last_used_at, source_app, source_external_id, source_url, import_warnings, created_at, updated_at, deleted_at, field_times, client_key)
      VALUES (@id, @user_id, @name, @nutrition, @items, @img_url, @notes, @is_recipe, @portion, @unit, @servings, @visibility, @source_id, @favorite, @usage_count, @last_used_at, @source_app, @source_external_id, @source_url, @import_warnings, @created_at, COALESCE(@updated_at, datetime('now')), @deleted_at, @field_times, @client_key)
    `);
    for (const m of data.meals || []) insMeal.run({
      visibility: 'private', source_id: null, favorite: 0, usage_count: 0, last_used_at: null,
      source_app: null, source_external_id: null, source_url: null, import_warnings: null,
      updated_at: null, deleted_at: null, servings: null, field_times: null, client_key: null, ...m,
    });

    const insFoodShare = db.prepare(`INSERT OR IGNORE INTO food_shares (food_id, user_id) VALUES (@food_id, @user_id)`);
    for (const fs of data.food_shares || []) insFoodShare.run(fs);

    const insMealShare = db.prepare(`INSERT OR IGNORE INTO meal_shares (meal_id, user_id) VALUES (@meal_id, @user_id)`);
    for (const ms of data.meal_shares || []) insMealShare.run(ms);

    // COALESCE updated_at to NOW so pre-#39 rows without the column don't
    // restore as NULL — same rule as foods/meals. NULL updated_at is silently
    // skipped by the Android delta sync's `WHERE updated_at >= ?` filter.
    // #207: completed_at + completed_meals ride along so day-completion
    // state survives a full-backup restore, with when each was set
    // (completion_marked_at, meal_marks_at) and when the note was edited
    // (notes_updated_at; from before it was kept, the day's last change, as
    // at upgrade), so an older edit queued on a phone doesn't win over them.
    // updated_at, the pull's cursor, is moved to now below (bumpCursors).
    const insDiary = db.prepare(`
      INSERT OR IGNORE INTO diary (id, user_id, date, items, body_stats, water, notes, notes_updated_at, completed_at, completed_meals, completion_marked_at, meal_marks_at, updated_at, deleted_at, field_times)
      VALUES (@id, @user_id, @date, @items, @body_stats, @water, @notes, COALESCE(@notes_updated_at, CASE WHEN @notes IS NOT NULL THEN @updated_at END), @completed_at, @completed_meals, @completion_marked_at, @meal_marks_at, COALESCE(@updated_at, datetime('now')), @deleted_at, @field_times)
    `);
    for (const d of data.diary || []) insDiary.run({
      notes: null, notes_updated_at: null, completed_at: null, completed_meals: null, completion_marked_at: null, meal_marks_at: null,
      updated_at: null, deleted_at: null, field_times: null, ...d,
    });

    // Items and water deleted from a day (diary_tombstones), so a device
    // still holding one can't put it back; see restoreTombstones.
    restoreTombstones(data.diary_tombstones);

    const insSettings = db.prepare(`
      INSERT OR IGNORE INTO user_settings (user_id, key, value, updated_at, deleted_at, field_times) VALUES (@user_id, @key, @value, COALESCE(@updated_at, datetime('now')), @deleted_at, @field_times)
    `);
    for (const s of data.user_settings || []) insSettings.run({ updated_at: null, deleted_at: null, field_times: null, ...s });

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
      INSERT OR IGNORE INTO activity_log (id, user_id, date, name, kcal, duration_min, distance, source, met, is_template, created_at, updated_at, deleted_at, field_times, client_key)
      VALUES (@id, @user_id, @date, @name, @kcal, @duration_min, @distance, @source, @met, @is_template, @created_at, @updated_at, @deleted_at, @field_times, @client_key)
    `);
    for (const a of data.activity_log || []) insActivity.run({ met: null, is_template: 0, deleted_at: null, field_times: null, client_key: null, ...a });

    // Intermittent fasting log
    db.prepare('DELETE FROM fasts').run();
    const insFast = db.prepare(`
      INSERT OR IGNORE INTO fasts (id, user_id, start_at, end_at, goal_hours, notes, created_at, updated_at, deleted_at, field_times, client_key)
      VALUES (@id, @user_id, @start_at, @end_at, @goal_hours, @notes, @created_at, @updated_at, @deleted_at, @field_times, @client_key)
    `);
    for (const f of data.fasts || []) insFast.run({ end_at: null, notes: null, deleted_at: null, field_times: null, client_key: null, ...f });

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

    // Two-step sign-in (#222): secrets as stored (locked with this server's
    // two-step key, so on another server they can't be opened and the
    // person signs in with a recovery code or has it reset) and the hashes
    // of recovery codes. A backup from before it has none: two-step sign-in
    // is off for everyone after restoring it. The users above cascaded the
    // old rows away; rows for an account the archive lacks are skipped.
    db.prepare('DELETE FROM user_two_step').run();
    db.prepare('DELETE FROM user_two_step_recovery').run();
    const restoredUsers = new Set(db.prepare('SELECT id FROM users').all().map(r => r.id));
    const insTwoStep = db.prepare(`
      INSERT OR IGNORE INTO user_two_step (user_id, secret_enc, enabled, last_step, created_at, enabled_at)
      VALUES (@user_id, @secret_enc, @enabled, @last_step, COALESCE(@created_at, datetime('now')), @enabled_at)
    `);
    for (const t of (data.user_two_step || []).filter(x => restoredUsers.has(x.user_id))) insTwoStep.run({
      enabled: 0, last_step: 0, created_at: null, enabled_at: null, ...t,
    });
    const insRecovery = db.prepare(`
      INSERT OR IGNORE INTO user_two_step_recovery (id, user_id, code_hash, used_at, created_at)
      VALUES (@id, @user_id, @code_hash, @used_at, COALESCE(@created_at, datetime('now')))
    `);
    for (const r of (data.user_two_step_recovery || []).filter(x => restoredUsers.has(x.user_id))) insRecovery.run({
      id: null, used_at: null, created_at: null, ...r,
    });

    // Outstanding invite tokens so pending invites don't 404 after restore.
    db.prepare('DELETE FROM invite_tokens').run();
    const insInvite = db.prepare(`
      INSERT OR IGNORE INTO invite_tokens (token, email, role, created_by, expires_at, used, coach_id)
      VALUES (@token, @email, @role, @created_by, @expires_at, @used, @coach_id)
    `);
    for (const i of data.invite_tokens || []) insInvite.run({ email: null, role: 'user', created_by: null, used: 0, coach_id: null, ...i });

    // Webhooks set up by hand, so a restore doesn't quietly stop them (the
    // secret is locked with this server's key: on a server with another
    // key a delivery fails until the webhook is made again, and Settings
    // says so). The users above cascaded the old ones away.
    db.prepare('DELETE FROM webhooks').run();
    const insHook = db.prepare(`
      INSERT OR IGNORE INTO webhooks (id, user_id, url, secret_encrypted, events, enabled, last_delivery_at, last_delivery_status, last_delivery_error, created_at)
      VALUES (@id, @user_id, @url, @secret_encrypted, @events, @enabled, @last_delivery_at, @last_delivery_status, @last_delivery_error, COALESCE(@created_at, datetime('now')))
    `);
    for (const w of (data.webhooks || []).filter(x => restoredUsers.has(x.user_id))) insHook.run({
      enabled: 1, last_delivery_at: null, last_delivery_status: null, last_delivery_error: null, created_at: null, ...w,
    });

    // Coaching pairings (1.5). A backup from before coaching has none. The
    // users above cascade these away first, so this only adds back what the
    // archive holds.
    db.prepare('DELETE FROM coach_clients').run();
    const insPairing = db.prepare(`
      INSERT OR IGNORE INTO coach_clients (id, coach_id, client_id, status, note, requested_at, responded_at, ended_at, ended_by, updated_at)
      VALUES (@id, @coach_id, @client_id, @status, @note, COALESCE(@requested_at, datetime('now')), @responded_at, @ended_at, @ended_by, COALESCE(@updated_at, datetime('now')))
    `);
    for (const c of data.coach_clients || []) insPairing.run({
      note: null, requested_at: null, responded_at: null, ended_at: null, ended_by: null, updated_at: null, ...c,
    });

    // Coaching recommendations (and their answers).
    db.prepare('DELETE FROM coach_recommendations').run();
    const recPairings = new Set(db.prepare('SELECT id FROM coach_clients').all().map(r => r.id));
    const insRec = db.prepare(`
      INSERT OR IGNORE INTO coach_recommendations (id, pairing_id, coach_id, client_id, kind, date, payload, note, status, response_note, created_at, responded_at, updated_at, deleted_at)
      VALUES (@id, @pairing_id, @coach_id, @client_id, @kind, @date, @payload, @note, @status, @response_note, COALESCE(@created_at, datetime('now')), @responded_at, COALESCE(@updated_at, datetime('now')), @deleted_at)
    `);
    for (const r of (data.coach_recommendations || []).filter(x => recPairings.has(x.pairing_id))) insRec.run({
      date: null, note: null, response_note: null, created_at: null, responded_at: null, updated_at: null, deleted_at: null, ...r,
    });

    // Coaching conversations; their photos come back with the other images
    // (images/coaching/ in the archive).
    db.prepare('DELETE FROM coach_messages').run();
    const insMessage = db.prepare(`
      INSERT OR IGNORE INTO coach_messages (id, uuid, pairing_id, sender_id, body, image_url, recommendation_id, read_at, created_at, updated_at, deleted_at)
      VALUES (@id, @uuid, @pairing_id, @sender_id, @body, @image_url, @recommendation_id, @read_at, COALESCE(@created_at, datetime('now')), COALESCE(@updated_at, datetime('now')), @deleted_at)
    `);
    // Only for pairings the archive has (a hand-edited archive could hold
    // messages without their pairing; they are skipped, not fatal).
    const pairingIds = new Set(db.prepare('SELECT id FROM coach_clients').all().map(r => r.id));
    for (const m of (data.coach_messages || []).filter(x => pairingIds.has(x.pairing_id))) insMessage.run({
      body: null, image_url: null, recommendation_id: null, read_at: null, created_at: null, updated_at: null, deleted_at: null, ...m,
    });

    // Rows a device may hold that the backup doesn't: kept as deleted, so
    // devices drop them. Then every restored row the pull picks by
    // updated_at is sent again.
    keepGone(before);
    bumpCursors();
  })(), data.users);

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
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, data);
  }

  // Re-apply env-var config so lock flags always reflect the current environment,
  // regardless of what was in the backup (the backup may predate the lock flags).
  seedSmtpFromEnv();
  seedAiFromEnv();
  logTwoStepAfterRestore();
}

// Tables whose rows a device pulls whole and that say a row is gone only by
// its deleted_at, with who has to be the same before and after the restore
// for a row to be theirs (an account: its id, username and when it was made).
const KEEP_GONE = ['foods', 'meals', 'diary', 'activity_log', 'fasts'];
// The rows of `t` the backup doesn't hold (by `key`), read one at a time so
// the rest never sits in memory beside the backup.
function _notIn(data, t, key = 'id') {
  const backed = new Set((Array.isArray(data?.[t]) ? data[t] : []).map(r => r?.[key]));
  const out = [];
  try { for (const r of db.prepare(`SELECT * FROM ${t}`).iterate()) if (!backed.has(r[key])) out.push(r); } catch { /* not in this build */ }
  return out;
}

function rowsBefore(data) {
  const out = Object.fromEntries(KEEP_GONE.map(t => [t, _notIn(data, t)]));
  out.users = new Map(db.prepare('SELECT id, username, created_at FROM users').all().map(u => [u.id, `${u.username}\n${u.created_at}`]));
  out.pairings = new Map(db.prepare('SELECT id, coach_id, client_id FROM coach_clients').all().map(p => [p.id, p]));
  out.coach_messages = _notIn(data, 'coach_messages', 'uuid');
  // Deletions devices are still to hear of (db.js sync_deletions): they
  // belong to an account, so the accounts' delete takes them.
  out.sync_deletions = db.prepare('SELECT * FROM sync_deletions').all();
  return out;
}

/**
 * A row a device may hold that the restore took away is put back deleted,
 * the way these tables say a row is gone, so every device that pulls it
 * drops its copy (a food made after the backup, a message sent since).
 * Only for the same people: an account (or a pairing) that is someone else
 * in the backup, or isn't in it, gets nothing of the other's. The delete
 * counts as made now (field_times), so an older edit queued on a phone
 * doesn't bring the row back. A day keeps nothing logged in it (a save to
 * that date merges with a deleted day too, and would bring it all back),
 * and a day the backup has (under any id) stays the backup's alone. A food
 * or meal lets go of where it came from (source_app, source_external_id),
 * as a deleted food does, so the same recipe or food can come in again. A
 * message keeps no text or photo, as when it is deleted; one whose id the
 * backup uses goes under a new one (devices know a message by its uuid).
 */
function keepGone(before) {
  const usersNow = new Map(db.prepare('SELECT id, username, created_at FROM users').all().map(u => [u.id, `${u.username}\n${u.created_at}`]));
  // A row with no account is the one user's of a server without accounts:
  // the same only when there were none before and are none now (restored
  // onto a server with accounts, it would be handed to one of them).
  const solo = before.users.size === 0 && usersNow.size === 0;
  const same = id => (id == null || id === 0 ? solo : usersNow.has(id) && usersNow.get(id) === before.users.get(id));
  const now = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;
  const emptyDay = { items: '[]', water: '[]', body_stats: '{}', notes: null, notes_updated_at: null, completed_at: null, completed_meals: null, completion_marked_at: null, meal_marks_at: null, field_times: '{}' };
  const sameDay = db.prepare('SELECT 1 FROM diary WHERE date = ? AND user_id IS ?');
  for (const t of KEEP_GONE) {
    const has = db.prepare(`SELECT 1 FROM ${t} WHERE id = ?`);
    const cols = db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name).filter(c => c !== 'deleted_at' && c !== 'field_times' && c !== 'changed_at');
    // When it was deleted (field_times deleted_at): now, or when it was if
    // it already was. A day's field_times hold its measurements only.
    const kept = `COALESCE(CASE WHEN json_valid(@field_times) AND @field_times != '{}' THEN @field_times END, json_object('_base', @updated_at))`;
    const times = t === 'diary' ? '@field_times'
      : `CASE WHEN @deleted_at IS NOT NULL THEN ${kept} ELSE json_set(${kept}, '$.deleted_at', ${now}) END`;
    const ins = db.prepare(`INSERT OR IGNORE INTO ${t} (${cols.join(', ')}, deleted_at, field_times)
      VALUES (${cols.map(c => '@' + c).join(', ')}, COALESCE(@deleted_at, datetime('now')), ${times})`);
    for (const r of before[t]) {
      if (has.get(r.id) || !same(r.user_id)) continue;
      if (t === 'diary' && sameDay.get(r.date, r.user_id ?? null)) continue;
      const row = { ...Object.fromEntries(cols.map(c => [c, null])), field_times: null, ...r, deleted_at: r.deleted_at ?? null };
      if (t === 'diary') Object.assign(row, emptyDay);
      if (t === 'foods' || t === 'meals') Object.assign(row, { source_app: null, source_external_id: null });
      ins.run(row);
    }
  }
  const pairsNow = new Map(db.prepare('SELECT id, coach_id, client_id FROM coach_clients').all().map(p => [p.id, p]));
  const samePairing = id => {
    const a = before.pairings.get(id), b = pairsNow.get(id);
    return !!(a && b && a.coach_id === b.coach_id && a.client_id === b.client_id && same(a.coach_id) && same(a.client_id));
  };
  const hasUuid = db.prepare('SELECT 1 FROM coach_messages WHERE uuid = ?');
  const insMessage = db.prepare(`INSERT OR IGNORE INTO coach_messages (id, uuid, pairing_id, sender_id, body, image_url, recommendation_id, read_at, created_at, updated_at, deleted_at)
    VALUES (CASE WHEN EXISTS (SELECT 1 FROM coach_messages WHERE id = @id) THEN NULL ELSE @id END, @uuid, @pairing_id, @sender_id, NULL, NULL, NULL, @read_at, @created_at, datetime('now'), COALESCE(@deleted_at, datetime('now')))`);
  for (const m of before.coach_messages) {
    if (!hasUuid.get(m.uuid) && samePairing(m.pairing_id) && same(m.sender_id)) insMessage.run(m);
  }
  // Wearable workouts and readings deleted before the restore that a device
  // may not have dropped yet, for the same people (the restore's own
  // deletes are newer and stay).
  const insGone = db.prepare(`INSERT OR IGNORE INTO sync_deletions (id, user_id, table_name, row_id, row_key, deleted_at) VALUES (@id, @user_id, @table_name, @row_id, @row_key, @deleted_at)`);
  for (const g of before.sync_deletions) if (same(g.user_id)) insGone.run(g);
}

/**
 * The tables the pull picks by updated_at (the server's time of the last
 * write to them) get now, so every device pulls the restored rows again:
 * a day, a setting, a wearable workout or a coach's message changed after
 * the backup goes back to how it was. Their other times stay as backed up
 * (field_times start from the backed-up updated_at). Foods, meals,
 * activities and fasts are picked by changed_at, which the insert set.
 */
function bumpCursors() {
  for (const t of ['diary', 'user_settings', 'workouts', 'coach_messages', 'coach_recommendations']) {
    db.prepare(`UPDATE ${t} SET updated_at = datetime('now')`).run();
  }
}

/**
 * Put back the backup's diary tombstones, then drop every tombstone that
 * names an item or water entry its day holds now: the merge
 * (lib/diary-merge.js) drops a tombstoned entry from the day on its next
 * save, so a deletion made after the backup would undo the restore.
 * `rows`: absent in a backup from before they were kept.
 */
function restoreTombstones(rows) {
  const users = new Set(db.prepare('SELECT id FROM users').all().map(r => r.id));
  const has = db.prepare('SELECT 1 FROM diary_tombstones WHERE user_id IS @user_id AND date = @date AND kind = @kind AND uuid = @uuid');
  const ins = db.prepare(`INSERT INTO diary_tombstones (user_id, date, kind, uuid, deleted_at) VALUES (@user_id, @date, @kind, @uuid, COALESCE(@deleted_at, datetime('now')))`);
  for (const t of Array.isArray(rows) ? rows : []) {
    if (!t || typeof t.date !== 'string' || typeof t.kind !== 'string' || typeof t.uuid !== 'string') continue;
    const row = { user_id: t.user_id ?? null, date: t.date, kind: t.kind, uuid: t.uuid, deleted_at: t.deleted_at || null };
    if (row.user_id != null && !users.has(row.user_id)) continue;
    if (!has.get(row)) ins.run(row);
  }
  const dayOf = db.prepare('SELECT items, water FROM diary WHERE user_id IS ? AND date = ?');
  const list = (v) => { try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } };
  const drop = db.prepare('DELETE FROM diary_tombstones WHERE rowid = ?');
  for (const t of db.prepare('SELECT rowid AS rid, * FROM diary_tombstones').all()) {
    const day = dayOf.get(t.user_id, t.date);
    if (!day) continue;
    const entries = t.kind === 'water' ? list(day.water) : t.kind === 'item' ? list(day.items) : [];
    if (entries.some(e => e?.uuid === t.uuid)) drop.run(t.rid);
  }
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
    // Webhooks set up by hand (the secret locked with this server's key).
    webhooks:         db.prepare('SELECT * FROM webhooks').all(),
    // Items and water deleted from a day, so a device still holding one
    // can't put it back after a restore.
    diary_tombstones: db.prepare('SELECT * FROM diary_tombstones').all(),
    // Coaching pairings: who coaches whom, and requests waiting for an answer.
    coach_clients:    db.prepare('SELECT * FROM coach_clients').all(),
    coach_messages:   db.prepare('SELECT * FROM coach_messages').all(),
    coach_recommendations: db.prepare('SELECT * FROM coach_recommendations').all(),
    // Two-step sign-in (#222): secrets stay locked with this server's
    // two-step key, which is never in the archive; recovery codes are hashes.
    user_two_step:    db.prepare('SELECT * FROM user_two_step').all(),
    user_two_step_recovery: db.prepare('SELECT * FROM user_two_step_recovery').all(),
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
router.post('/:name/restore', requireAdmin, (req, res) => {
  const filename = path.basename(req.params.name);
  const filePath = path.join(BACKUPS_DIR, filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
  try {
    restoreFromZip(new AdmZip(filePath));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/full-backup/upload-restore — upload a ZIP and restore from it ─
router.post('/upload-restore', requireAdmin, upload.single('backup'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    restoreFromZip(new AdmZip(req.file.path));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    // Clean up temp file
    try { fs.unlinkSync(req.file.path); } catch {}
  }
});

export default router;
