import express from 'express';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import AdmZip from 'adm-zip';
import multer from 'multer';
import db from '../db.js';
import { seedSmtpFromEnv } from '../email.js';
import { seedAiFromEnv } from '../ai.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';

const router = express.Router();
router.use(requireAuth);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const UPLOADS_DIR = process.env.UPLOADS_PATH  || path.resolve(__dirname, '..', 'uploads');
// Default backups inside the uploads volume so they survive container restarts
const BACKUPS_DIR = process.env.BACKUPS_PATH  || path.join(UPLOADS_DIR, 'backups');

fs.mkdirSync(BACKUPS_DIR, { recursive: true });

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

    const insFood = db.prepare(`
      INSERT OR IGNORE INTO foods (id, user_id, name, brand, nutrition, portion, unit, img_url, notes, category, barcode, visibility, source_id, created_at, updated_at, deleted_at)
      VALUES (@id, @user_id, @name, @brand, @nutrition, @portion, @unit, @img_url, @notes, @category, @barcode, @visibility, @source_id, @created_at, @updated_at, @deleted_at)
    `);
    for (const f of data.foods || []) insFood.run({ visibility: 'private', source_id: null, updated_at: null, deleted_at: null, ...f });

    const insMeal = db.prepare(`
      INSERT OR IGNORE INTO meals (id, user_id, name, nutrition, items, img_url, notes, is_recipe, portion, unit, visibility, source_id, created_at, updated_at, deleted_at)
      VALUES (@id, @user_id, @name, @nutrition, @items, @img_url, @notes, @is_recipe, @portion, @unit, @visibility, @source_id, @created_at, @updated_at, @deleted_at)
    `);
    for (const m of data.meals || []) insMeal.run({ visibility: 'private', source_id: null, updated_at: null, deleted_at: null, ...m });

    const insFoodShare = db.prepare(`INSERT OR IGNORE INTO food_shares (food_id, user_id) VALUES (@food_id, @user_id)`);
    for (const fs of data.food_shares || []) insFoodShare.run(fs);

    const insMealShare = db.prepare(`INSERT OR IGNORE INTO meal_shares (meal_id, user_id) VALUES (@meal_id, @user_id)`);
    for (const ms of data.meal_shares || []) insMealShare.run(ms);

    const insDiary = db.prepare(`
      INSERT OR IGNORE INTO diary (id, user_id, date, items, body_stats, water, notes, updated_at, deleted_at)
      VALUES (@id, @user_id, @date, @items, @body_stats, @water, @notes, @updated_at, @deleted_at)
    `);
    for (const d of data.diary || []) insDiary.run({ notes: null, deleted_at: null, ...d });

    const insSettings = db.prepare(`
      INSERT OR IGNORE INTO user_settings (user_id, key, value, updated_at, deleted_at) VALUES (@user_id, @key, @value, @updated_at, @deleted_at)
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
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, data);
  }

  // Re-apply env-var config so lock flags always reflect the current environment,
  // regardless of what was in the backup (the backup may predate the lock flags).
  seedSmtpFromEnv();
  seedAiFromEnv();
}

function dumpDatabase() {
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
    wellness_data:    db.prepare('SELECT * FROM wellness_data').all(),
    workouts:         db.prepare('SELECT * FROM workouts').all(),
  };
}

// ── POST /api/full-backup  — create a new backup ───────────────────────────
router.post('/', requireAdmin, (req, res) => {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename  = `nutritrace-backup-${timestamp}.zip`;
    const destPath  = path.join(BACKUPS_DIR, filename);

    const zip = new AdmZip();

    // 1. Database dump as JSON
    const dbDump = JSON.stringify(dumpDatabase(), null, 2);
    zip.addFile('database.json', Buffer.from(dbDump, 'utf8'));

    // 2. Uploaded images (skip the backups sub-directory)
    if (fs.existsSync(UPLOADS_DIR)) {
      const addDir = (dir, zipPath) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          const zp   = zipPath ? `${zipPath}/${entry.name}` : entry.name;
          if (entry.isDirectory()) {
            if (full === BACKUPS_DIR) continue; // never include backup archives
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
    res.json({ filename, size: stat.size, createdAt: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
