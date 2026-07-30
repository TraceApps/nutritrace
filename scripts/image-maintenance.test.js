import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('image maintenance localizes canonical and nested snapshot images idempotently', async t => {
  const serverRequire = createRequire(new URL('../server/package.json', import.meta.url));
  try {
    serverRequire.resolve('better-sqlite3');
  } catch {
    t.skip('server dependencies are not installed');
    return;
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nutritrace-image-maintenance-'));
  const dbPath = path.join(tempDir, 'nutritrace.db');
  const uploadsPath = path.join(tempDir, 'uploads');
  process.env.DB_PATH = dbPath;
  process.env.UPLOADS_PATH = uploadsPath;
  process.env.LOG_LEVEL = 'error';

  // A minimal magic-byte-valid PNG is sufficient for localization tests.
  const png = Buffer.alloc(128);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
  const dataUrl = `data:image/png;base64,${png.toString('base64')}`;

  const { runImageMaintenance } = await import('../server/lib/image-maintenance.js');
  const { localizeImageForStorage } = await import('../server/lib/image-localizer.js');
  const { default: db } = await import('../server/db.js');

  try {
    await assert.rejects(
      localizeImageForStorage('data:image/png;base64,AAAA', 'test image'),
      err => err?.status === 422 && /inline image localization failed/.test(err.message)
    );
    await assert.rejects(
      localizeImageForStorage('DATA:image/png;base64,AAAA', 'test image'),
      err => err?.status === 422
    );

    // Simulate a final image file truncated by an older direct-write version.
    // Localization must verify and atomically repair it rather than trusting
    // the filename alone.
    const hash = crypto.createHash('sha256').update(png).digest('hex').slice(0, 24);
    const expectedFilename = `image-${hash}.png`;
    fs.mkdirSync(uploadsPath, { recursive: true });
    fs.writeFileSync(path.join(uploadsPath, expectedFilename), png.subarray(0, 16));

    const food = db.prepare(
      `INSERT INTO foods (name, img_url, updated_at, deleted_at)
       VALUES (?, ?, datetime('now'), datetime('now'))`
    ).run('Maintenance test food', dataUrl);
    db.prepare(
      `INSERT INTO diary (date, items, updated_at)
       VALUES ('2099-01-01', ?, datetime('now'))`
    ).run(JSON.stringify([{
      id: food.lastInsertRowid,
      imgUrl: dataUrl,
      _splitItems: [{ id: 2, img_url: dataUrl }],
    }]));

    const first = await runImageMaintenance({ vacuum: true });
    assert.equal(first.localized, 1);
    assert.equal(first.snapshotRows, 1);
    assert.equal(first.snapshotImages, 2);
    assert.equal(first.failures, 0);
    assert.equal(first.vacuumed, true);

    const foodRow = db.prepare('SELECT img_url, deleted_at FROM foods WHERE id = ?').get(food.lastInsertRowid);
    const diaryRow = db.prepare(`SELECT items FROM diary WHERE date = '2099-01-01'`).get();
    const items = JSON.parse(diaryRow.items);
    assert.match(foodRow.img_url, /^\/uploads\/image-[0-9a-f]{24}\.png$/);
    assert.ok(foodRow.deleted_at, 'soft-deleted food remains a tombstone');
    assert.equal(items[0].imgUrl, foodRow.img_url);
    assert.equal(items[0]._splitItems[0].img_url, foodRow.img_url);
    assert.equal(path.basename(foodRow.img_url), expectedFilename);
    assert.deepEqual(fs.readFileSync(path.join(uploadsPath, expectedFilename)), png);
    assert.deepEqual(fs.readdirSync(uploadsPath), [expectedFilename]);

    const second = await runImageMaintenance({ vacuum: true });
    assert.equal(second.localized, 0);
    assert.equal(second.snapshotRows, 0);
    assert.equal(second.failures, 0);
    assert.equal(second.vacuumed, false);
    assert.deepEqual(fs.readdirSync(uploadsPath), [expectedFilename]);
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
