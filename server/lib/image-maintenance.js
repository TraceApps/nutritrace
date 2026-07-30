import crypto from 'crypto';
import fs from 'fs';

import db from '../db.js';
import { logger } from '../logger.js';
import { localizeImage } from './image-localizer.js';
import {
  dataUrlDecodedBytes,
  localizeInlineSnapshotImages,
} from './inline-images.js';

const LOCK_KEY = '_image_maintenance_lease';
const LOCK_MAX_MS = 4 * 60 * 60 * 1000;
db.pragma('busy_timeout = 30000');

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

function databaseBytes() {
  const dbPath = process.env.DB_PATH || './nutritrace.db';
  try {
    return fs.statSync(dbPath).size;
  } catch {
    return 0;
  }
}

function acquireLease() {
  const token = crypto.randomUUID();
  const now = Date.now();
  const value = JSON.stringify({ token, expiresAt: now + LOCK_MAX_MS });

  const transaction = db.transaction(() => {
    const row = db.prepare('SELECT value FROM app_config WHERE key = ?').get(LOCK_KEY);
    if (row?.value) {
      try {
        const existing = JSON.parse(row.value);
        if (Number(existing.expiresAt) > now) return false;
      } catch {
        // Invalid/stale lease value is safe to replace.
      }
    }
    db.prepare(
      `INSERT INTO app_config (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(LOCK_KEY, value);
    return true;
  });

  return transaction.immediate() ? { token, value } : null;
}

function releaseLease(lease) {
  if (!lease) return;
  db.prepare('DELETE FROM app_config WHERE key = ? AND value = ?').run(LOCK_KEY, lease.value);
}

async function localizeCanonicalRows(table, summary) {
  // Include soft-deleted rows deliberately. Their image reference is part of
  // the tombstone and may be needed for restore, deleted-item lookup, and
  // future reference-counted garbage collection.
  const rows = db.prepare(
    `SELECT id, img_url, deleted_at FROM ${table}
     WHERE img_url LIKE 'data:image/%' ORDER BY id`
  ).all();
  const update = db.prepare(
    `UPDATE ${table} SET img_url = ?, updated_at = datetime('now') WHERE id = ?`
  );

  for (const row of rows) {
    const decodedBytes = dataUrlDecodedBytes(row.img_url);
    const localized = await localizeImage(row.img_url);
    if (!localized || localized.startsWith('data:')) {
      summary.failures++;
      logger.warn(`[image-maintenance] failed ${table} id=${row.id} inline=${formatBytes(row.img_url.length)} decoded=${formatBytes(decodedBytes)}`);
      continue;
    }
    update.run(localized, row.id);
    summary.localized++;
    summary.inlineCharsRemoved += row.img_url.length;
    summary.decodedBytes += decodedBytes;
    logger.debug(
      `[image-maintenance] localized ${table} id=${row.id} deleted=${row.deleted_at ? 'yes' : 'no'} ` +
      `inline=${formatBytes(row.img_url.length)} decoded=${formatBytes(decodedBytes)} path=${localized}`
    );
  }
}

async function localizeSnapshotRows(table, summary) {
  const rows = db.prepare(
    `SELECT id, items FROM ${table} WHERE items LIKE '%data:image/%' ORDER BY id`
  ).all();
  const update = db.prepare(
    `UPDATE ${table} SET items = ?, updated_at = datetime('now') WHERE id = ?`
  );

  for (const row of rows) {
    let items;
    try {
      items = JSON.parse(row.items || '[]');
    } catch (err) {
      summary.failures++;
      logger.warn(`[image-maintenance] invalid ${table}.items JSON id=${row.id}: ${err.message}`);
      continue;
    }

    let rowImages = 0;
    let rowDecoded = 0;
    let rowFailures = 0;
    const migrated = await localizeInlineSnapshotImages(
      items,
      localizeImage,
      ({ source, localized, itemId, key, success }) => {
        const decodedBytes = dataUrlDecodedBytes(source);
        if (!success) {
          rowFailures++;
          summary.failures++;
          logger.warn(
            `[image-maintenance] failed snapshot table=${table} row_id=${row.id} ` +
            `item_id=${itemId ?? 'unknown'} key=${key} inline=${formatBytes(source.length)} ` +
            `decoded=${formatBytes(decodedBytes)}`
          );
          return;
        }
        rowImages += 1;
        rowDecoded += decodedBytes;
        logger.debug(
          `[image-maintenance] localized snapshot table=${table} row_id=${row.id} ` +
          `item_id=${itemId ?? 'unknown'} key=${key} inline=${formatBytes(source.length)} ` +
          `decoded=${formatBytes(decodedBytes)} path=${localized}`
        );
      }
    );
    if (!migrated.changed) {
      if (rowFailures === 0) {
        summary.failures++;
        logger.warn(`[image-maintenance] could not localize embedded images in ${table} id=${row.id}`);
      }
      continue;
    }

    const serialized = JSON.stringify(migrated.value);
    update.run(serialized, row.id);
    summary.snapshotRows++;
    summary.snapshotImages += rowImages;
    summary.inlineCharsRemoved += Math.max(0, row.items.length - serialized.length);
    summary.decodedBytes += rowDecoded;
    logger.debug(
      `[image-maintenance] localized snapshots ${table} id=${row.id} images=${rowImages} failures=${rowFailures} ` +
      `before=${formatBytes(row.items.length)} after=${formatBytes(serialized.length)} decoded=${formatBytes(rowDecoded)}`
    );
  }
}

export async function runImageMaintenance({ vacuum = true } = {}) {
  const lease = acquireLease();
  if (!lease) {
    logger.info('[image-maintenance] skipped: another maintenance process holds the lease');
    return { skipped: true };
  }

  const startedAt = Date.now();
  const beforeBytes = databaseBytes();
  const summary = {
    localized: 0,
    snapshotRows: 0,
    snapshotImages: 0,
    failures: 0,
    inlineCharsRemoved: 0,
    decodedBytes: 0,
  };
  logger.info(`[image-maintenance] start database=${formatBytes(beforeBytes)} vacuum=${vacuum ? 'yes' : 'no'}`);

  try {
    await localizeCanonicalRows('foods', summary);
    await localizeCanonicalRows('meals', summary);
    await localizeSnapshotRows('meals', summary);
    await localizeSnapshotRows('diary', summary);

    // VACUUM exclusively locks and rewrites the database. Only pay that cost
    // when this run actually removed inline data from SQLite.
    const shouldVacuum = vacuum && (summary.localized > 0 || summary.snapshotRows > 0);
    if (shouldVacuum) {
      logger.info('[image-maintenance] VACUUM start');
      db.pragma('wal_checkpoint(TRUNCATE)');
      db.exec('VACUUM');
      // In WAL mode VACUUM may leave the compacted database pages in the WAL
      // until the next checkpoint. Materialize and truncate them now so the
      // finish summary reports the actual compacted main-file size.
      db.pragma('wal_checkpoint(TRUNCATE)');
      logger.info('[image-maintenance] VACUUM finish');
    } else if (vacuum) {
      logger.info('[image-maintenance] VACUUM skipped: no inline images were localized');
    }

    const afterBytes = databaseBytes();
    logger.info(
      `[image-maintenance] finish localized=${summary.localized} snapshot_rows=${summary.snapshotRows} ` +
      `snapshot_images=${summary.snapshotImages} failures=${summary.failures} ` +
      `inline_removed=${formatBytes(summary.inlineCharsRemoved)} decoded=${formatBytes(summary.decodedBytes)} ` +
      `database_before=${formatBytes(beforeBytes)} database_after=${formatBytes(afterBytes)} ` +
      `duration_ms=${Date.now() - startedAt}`
    );
    return { ...summary, beforeBytes, afterBytes, vacuumed: shouldVacuum, skipped: false };
  } finally {
    releaseLease(lease);
  }
}
