/**
 * /api/nutrition-import — preview + commit endpoints for nutrition CSV
 * imports from MyFitnessPal, LoseIt, Cronometer, and raw spreadsheets.
 *
 * Two-step flow mirrors the LiftTrace workout-import route:
 *   POST /preview  → parses, returns counts + sample rows + duplicate-date list
 *   POST /commit   → re-parses and writes diary rows under skip/replace policy
 *
 * Note: parser robustness depends on each app's export format being stable.
 * If a vendor changes their export shape, the matching adapter needs a tweak.
 */
import { Router } from 'express';
import multer from 'multer';
import AdmZip from 'adm-zip';
import db from '../db.js';
import { wrap, logger } from '../logger.js';
import { requireAuth, userMgmtActive } from '../middleware/auth.js';
import { mapMeal } from '../lib/nutrition-import/common.js';
import { parseSpreadsheet } from '../lib/nutrition-import/spreadsheet.js';
import { parseCronometer }  from '../lib/nutrition-import/cronometer.js';
import { parseLoseit }      from '../lib/nutrition-import/loseit.js';
import { parseMfp, pickMealCsv } from '../lib/nutrition-import/mfp.js';

const router = Router();
router.use(requireAuth);

const uid = req => userMgmtActive() ? req.user.id : null;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB — multi-year nutrition logs fit comfortably
});

const SUPPORTED_SOURCES = ['spreadsheet', 'cronometer', 'loseit', 'mfp'];

// ── Adapter dispatch ─────────────────────────────────────────────────────

/**
 * Extract CSV text from the upload. MFP uploads can be a ZIP from the
 * email-delivered Premium export, in which case we pick the meal-nutrition
 * CSV out of it. Other adapters expect plain CSV text.
 */
function _extractText(source, file) {
  const filename = (file.originalname || '').toLowerCase();
  const isZip = filename.endsWith('.zip') ||
    (file.buffer.length > 4 && file.buffer[0] === 0x50 && file.buffer[1] === 0x4B);

  if (source === 'mfp' && isZip) {
    let zip;
    try { zip = new AdmZip(file.buffer); }
    catch (e) { throw new Error(`Could not read ZIP: ${e.message}`); }
    const entries = zip.getEntries().filter(e => !e.isDirectory).map(e => e.entryName);
    const target = pickMealCsv(entries);
    if (!target) {
      throw new Error('No meal-nutrition CSV found in the ZIP — expected a file named "Nutritional Information.csv" or "Meal Level Nutrition Details.csv"');
    }
    return zip.getEntry(target).getData().toString('utf8');
  }
  if (isZip) {
    throw new Error('ZIP uploads are only supported for MyFitnessPal — please extract the CSV first');
  }
  return file.buffer.toString('utf8');
}

function _parse(source, text) {
  if (source === 'spreadsheet') return parseSpreadsheet(text);
  if (source === 'cronometer')  return parseCronometer(text);
  if (source === 'loseit')      return parseLoseit(text);
  if (source === 'mfp')         return parseMfp(text);
  throw new Error(`Unsupported source: ${source}`);
}

// ── User settings helpers ────────────────────────────────────────────────

function _getUserMealNames(userId) {
  if (userId == null) {
    const row = db.prepare("SELECT value FROM user_settings WHERE user_id IS NULL AND key = 'mealNames'").get();
    return _decodeMealNames(row);
  }
  const row = db.prepare("SELECT value FROM user_settings WHERE user_id = ? AND key = 'mealNames'").get(userId);
  return _decodeMealNames(row);
}

function _decodeMealNames(row) {
  if (!row) return ['Breakfast', 'Lunch', 'Dinner', 'Snacks'];
  try {
    const v = JSON.parse(row.value);
    if (Array.isArray(v) && v.length > 0) return v;
  } catch {}
  return ['Breakfast', 'Lunch', 'Dinner', 'Snacks'];
}

// ── Diary item conversion ────────────────────────────────────────────────

/**
 * Convert a parsed canonical row into the NutriTrace diary item shape.
 * Matches what addDiaryItem() in src/stores/diary.js produces.
 */
function _toDiaryItem(canonical, mealNames) {
  const meal = mapMeal(canonical.mealLabel, mealNames);
  return {
    name:       canonical.name,
    brand:      canonical.brand || undefined,
    meal:       meal.index,
    quantity:   canonical.quantity ?? 1,
    portion:    canonical.portion ?? undefined,
    unit:       canonical.unit || undefined,
    nutrition:  canonical.nutrition,
    notes:      canonical.notes || undefined,
    addedAt:    _addedAt(canonical),
    source:     'imported',
  };
}

function _addedAt(c) {
  // Build a sensible ISO timestamp from date + optional time. Doesn't have to
  // be exact — diary list ordering uses addedAt for in-day stability.
  const date = c.date;
  const time = c.time || '12:00';
  return `${date}T${time}:00`;
}

// ── POST /api/nutrition-import/preview ───────────────────────────────────

router.post('/preview', upload.single('file'), wrap((req, res) => {
  const { source } = req.body || {};
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  if (!SUPPORTED_SOURCES.includes(source)) return res.status(400).json({ error: 'Unsupported source' });

  let text;
  try { text = _extractText(source, req.file); }
  catch (e) { return res.status(400).json({ error: e.message }); }

  let canonical;
  try { canonical = _parse(source, text); }
  catch (e) { return res.status(400).json({ error: `Parse failed: ${e.message}` }); }

  if (canonical.length === 0) return res.status(400).json({ error: 'No rows found in file' });

  const userId = uid(req);
  const mealNames = _getUserMealNames(userId);

  // Bucket per (date, mealIndex)
  const byDate = new Map();
  const unmappedLabels = new Map();
  for (const c of canonical) {
    if (!byDate.has(c.date)) byDate.set(c.date, 0);
    byDate.set(c.date, byDate.get(c.date) + 1);
    const m = mapMeal(c.mealLabel, mealNames);
    if (!m.matched && c.mealLabel) {
      unmappedLabels.set(c.mealLabel, (unmappedLabels.get(c.mealLabel) || 0) + 1);
    }
  }

  // Find existing diary entries that would collide
  const dates = [...byDate.keys()];
  const placeholders = dates.map(() => '?').join(',');
  let existingDates = new Set();
  if (dates.length > 0) {
    const rows = userId == null
      ? db.prepare(`SELECT date FROM diary WHERE user_id IS NULL AND deleted_at IS NULL AND date IN (${placeholders})`).all(...dates)
      : db.prepare(`SELECT date FROM diary WHERE user_id = ? AND deleted_at IS NULL AND date IN (${placeholders})`).all(userId, ...dates);
    existingDates = new Set(rows.map(r => r.date));
  }

  const sortedDates = dates.sort();
  res.json({
    source,
    items: canonical.length,
    days:  byDate.size,
    dateRange: { from: sortedDates[0], to: sortedDates[sortedDates.length - 1] },
    duplicateDates: [...existingDates],
    unmappedMealLabels: [...unmappedLabels.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([label, count]) => ({ label, count })),
    sample: canonical.slice(0, 8).map(c => ({
      date: c.date,
      meal: c.mealLabel,
      name: c.name,
      brand: c.brand,
      calories: c.nutrition.calories,
    })),
    mealNames,
  });
}));

// ── POST /api/nutrition-import/commit ────────────────────────────────────

router.post('/commit', upload.single('file'), wrap((req, res) => {
  const { source, onDuplicate } = req.body || {};
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  if (!SUPPORTED_SOURCES.includes(source)) return res.status(400).json({ error: 'Unsupported source' });

  // 'skip' (default), 'replace', or 'merge' (append items to existing day)
  const dupeMode = ['skip', 'replace', 'merge'].includes(onDuplicate) ? onDuplicate : 'skip';

  let text;
  try { text = _extractText(source, req.file); }
  catch (e) { return res.status(400).json({ error: e.message }); }

  let canonical;
  try { canonical = _parse(source, text); }
  catch (e) { return res.status(400).json({ error: `Parse failed: ${e.message}` }); }

  if (canonical.length === 0) return res.status(400).json({ error: 'No rows found in file' });

  const userId = uid(req);
  const mealNames = _getUserMealNames(userId);

  // Group items by date
  const byDate = new Map();
  for (const c of canonical) {
    const item = _toDiaryItem(c, mealNames);
    if (!byDate.has(c.date)) byDate.set(c.date, []);
    byDate.get(c.date).push(item);
  }

  let imported = 0, skipped = 0, replaced = 0, merged = 0;
  const errors = [];

  const tx = db.transaction(() => {
    for (const [date, items] of byDate.entries()) {
      const existing = userId == null
        ? db.prepare('SELECT * FROM diary WHERE date = ? AND user_id IS NULL AND deleted_at IS NULL').get(date)
        : db.prepare('SELECT * FROM diary WHERE date = ? AND user_id = ? AND deleted_at IS NULL').get(date, userId);

      let nextItems = items;
      if (existing) {
        if (dupeMode === 'skip') { skipped++; continue; }
        if (dupeMode === 'merge') {
          let prev = [];
          try { prev = JSON.parse(existing.items || '[]'); } catch {}
          nextItems = [...prev, ...items];
          merged++;
        } else {
          replaced++;
        }
      } else {
        imported++;
      }

      const itemsJson = JSON.stringify(nextItems);
      const bodyStats = existing ? (existing.body_stats || '{}') : '{}';
      const water     = existing ? (existing.water || '[]')      : '[]';
      const notes     = existing ? existing.notes : null;

      if (userId == null) {
        db.prepare(
          `INSERT INTO diary (date, items, body_stats, water, notes, updated_at)
           VALUES (?, ?, ?, ?, ?, datetime('now'))
           ON CONFLICT(date, user_id) DO UPDATE SET
             items=excluded.items, body_stats=excluded.body_stats,
             water=excluded.water, notes=excluded.notes,
             updated_at=excluded.updated_at,
             deleted_at=NULL`
        ).run(date, itemsJson, bodyStats, water, notes);
      } else {
        db.prepare(
          `INSERT INTO diary (user_id, date, items, body_stats, water, notes, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
           ON CONFLICT(date, user_id) DO UPDATE SET
             items=excluded.items, body_stats=excluded.body_stats,
             water=excluded.water, notes=excluded.notes,
             updated_at=excluded.updated_at,
             deleted_at=NULL`
        ).run(userId, date, itemsJson, bodyStats, water, notes);
      }
    }
  });

  try { tx(); }
  catch (e) {
    logger.error('[nutrition-import] commit failed:', e.message);
    return res.status(500).json({ error: `Import failed: ${e.message}` });
  }

  logger.info(`[nutrition-import] user=${userId} source=${source} mode=${dupeMode} imported=${imported} skipped=${skipped} replaced=${replaced} merged=${merged}`);
  res.json({ imported, skipped, replaced, merged, errors, totalItems: canonical.length });
}));

export default router;
