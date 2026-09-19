/**
 * img-url-migration.js — one-shot boot migration for #199.
 *
 * Foods and meals whose img_url column holds a base64 data URL get
 * localized to /uploads/ files on server startup, so the diary's
 * freshenItemImages hydrator (which was stamping data URLs onto every
 * referencing diary item) stops silently amplifying them into 50 MB
 * /api/diary payloads.
 *
 * Idempotent: guarded by an app_config flag so it runs at most once
 * per instance. Async because localizeImage does file IO; can't sit
 * inside db.js's synchronous migration block. Invoked from server
 * bootstrap after `app.listen` (see server/index.js).
 *
 * Design choices worth naming:
 *
 * - **Runs after listen, not during.** Server accepts traffic while
 *   the migration works. Existing installs with hundreds of data-URL
 *   rows don't delay boot. The freshenItemImages filter (added in the
 *   same fix) already keeps the payload clean during the window
 *   between listen and migration completion, so serving traffic is
 *   safe throughout.
 * - **Does NOT bump updated_at.** Same reasoning as the diary shrink
 *   migration in db.js: a mass updated_at bump would show every row
 *   as changed on the next Android sync/pull. Foods/meals dbUpsert
 *   guards pending edits, but skipping the bump avoids the risk
 *   entirely. Native clients pick up the /uploads/ path on the next
 *   natural edit (their PUT sends the local data URL, server
 *   re-localizes fresh via POST/PUT's own localizeImage path).
 * - **Per-row try/catch.** One malformed data URL (truncated,
 *   unknown mime type, disk full mid-write) can't abort the whole
 *   pass. Failures are counted and logged; the row stays as-is and
 *   the read-side filter keeps it out of the diary payload.
 */
import db from '../db.js';
import { logger } from '../logger.js';
import { localizeImage } from './image-localizer.js';

const FLAG_KEY = 'img_url_data_urls_migrated_v1';

let _promise = null;

export function migrateDataUrlImages() {
  if (_promise) return _promise;
  _promise = _run();
  return _promise;
}

async function _run() {
  try {
    const done = db.prepare(`SELECT value FROM app_config WHERE key = ?`).get(FLAG_KEY);
    if (done) return { skipped: true, reason: 'already-migrated' };

    const foods = db.prepare(
      `SELECT id, img_url FROM foods WHERE deleted_at IS NULL AND img_url LIKE 'data:%'`
    ).all();
    const meals = db.prepare(
      `SELECT id, img_url FROM meals WHERE deleted_at IS NULL AND img_url LIKE 'data:%'`
    ).all();

    if (foods.length === 0 && meals.length === 0) {
      db.prepare(`INSERT OR REPLACE INTO app_config (key, value) VALUES (?, ?)`)
        .run(FLAG_KEY, new Date().toISOString());
      return { skipped: true, reason: 'no-data-urls', migrated: 0 };
    }

    const foodUpdate = db.prepare(`UPDATE foods SET img_url = ? WHERE id = ?`);
    const mealUpdate = db.prepare(`UPDATE meals SET img_url = ? WHERE id = ?`);

    let migrated = 0, failed = 0;
    for (const r of foods) {
      try {
        const local = await localizeImage(r.img_url);
        if (local && !local.startsWith('data:')) {
          foodUpdate.run(local, r.id);
          migrated++;
        } else {
          failed++;
        }
      } catch (e) {
        failed++;
        logger.warn(`[img-url-migration] food id=${r.id} failed: ${e?.message || e}`);
      }
    }
    for (const r of meals) {
      try {
        const local = await localizeImage(r.img_url);
        if (local && !local.startsWith('data:')) {
          mealUpdate.run(local, r.id);
          migrated++;
        } else {
          failed++;
        }
      } catch (e) {
        failed++;
        logger.warn(`[img-url-migration] meal id=${r.id} failed: ${e?.message || e}`);
      }
    }

    // Only stamp the flag if EVERY row succeeded. A partial pass leaves
    // the flag off so the next boot retries the failures. That is safe
    // because localizeImage is idempotent (data URLs hash to the same
    // filename), and the already-migrated rows short-circuit via
    // freshenItemImages's data: filter regardless.
    if (failed === 0) {
      db.prepare(`INSERT OR REPLACE INTO app_config (key, value) VALUES (?, ?)`)
        .run(FLAG_KEY, new Date().toISOString());
    }

    logger.info(
      `[img-url-migration] localized ${migrated} data-URL image(s) to /uploads/` +
      (failed ? `, ${failed} failed (will retry on next boot)` : '')
    );
    return { migrated, failed };
  } catch (e) {
    logger.warn(`[img-url-migration] pass failed: ${e?.message || e}`);
    return { failed: true, error: e?.message || String(e) };
  }
}
