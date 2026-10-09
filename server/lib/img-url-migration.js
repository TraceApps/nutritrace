/** Repair legacy embedded food/recipe photos on each startup.
 * The old one-shot flag missed later recipe edits and imports. Only data URLs
 * are scanned; ordinary upload paths and external URLs are never re-downloaded.
 * Deleted rows are skipped: nobody sees their photo, and converting it would
 * send them to every phone again for nothing.
 */
import db from '../db.js';
import { logger } from '../logger.js';
import { localizeImage } from './image-localizer.js';

let pending;
export function migrateDataUrlImages() {
  if (!pending) pending = run().finally(() => { pending = null; });
  return pending;
}

async function run() {
  let migrated = 0, failed = 0;
  for (const table of ['foods', 'meals']) {
    const rows = db.prepare(`SELECT id, img_url FROM ${table} WHERE deleted_at IS NULL AND img_url LIKE 'data:%'`).all();
    // changed_at triggers make the corrected URL visible to Android pulls.
    // Preserve updated_at (the edit time) and never overwrite a concurrent edit.
    const update = db.prepare(`UPDATE ${table} SET img_url = ? WHERE id = ? AND img_url = ?`);
    for (const row of rows) {
      try {
        const image = await localizeImage(row.img_url);
        if (!image || /^data:/i.test(image)) throw new Error('Image conversion failed');
        migrated += update.run(image, row.id, row.img_url).changes;
      } catch {
        failed++;
        logger.warn(`[img-url-migration] ${table} id=${row.id}: could not store image; will retry next startup`);
      }
    }
  }
  if (migrated || failed) logger.info(`[img-url-migration] localized ${migrated} image(s), ${failed} failed`);
  return { migrated, failed };
}
