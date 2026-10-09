import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

const temp = mkdtempSync(join(tmpdir(), 'nt-legacy-images-'));
process.env.DB_PATH = join(temp, 'test.db');
process.env.UPLOADS_PATH = join(temp, 'uploads');
process.env.LOG_LEVEL = 'error';
const { default: db } = await import('../server/db.js');
const { migrateDataUrlImages } = await import('../server/lib/img-url-migration.js');
after(() => { db.close(); rmSync(temp, { recursive: true, force: true }); });

test('legacy repair ignores the old flag, retries failures and advances the sync cursor', async () => {
  const bytes = Buffer.concat([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'), Buffer.alloc(64)]);
  const inline = `data:image/png;base64,${bytes.toString('base64')}`;
  db.prepare("INSERT OR REPLACE INTO app_config (key,value) VALUES ('img_url_data_urls_migrated_v1','done')").run();
  const id = db.prepare("INSERT INTO meals (name,img_url,is_recipe,updated_at) VALUES ('Legacy photo',?,1,'2000-01-01 00:00:00')").run(inline).lastInsertRowid;
  const bad = db.prepare("INSERT INTO foods (name,img_url) VALUES ('Broken legacy','data:image/png;base64,bad')").run().lastInsertRowid;
  db.prepare("UPDATE meals SET changed_at='2000-01-01 00:00:00' WHERE id=?").run(id);
  assert.deepEqual(await migrateDataUrlImages(), { migrated: 1, failed: 1 });
  const row = db.prepare('SELECT * FROM meals WHERE id=?').get(id);
  assert.match(row.img_url, /^\/uploads\//);
  assert.deepEqual(readFileSync(join(temp, row.img_url)), bytes);
  assert.equal(row.updated_at, '2000-01-01 00:00:00');
  assert.ok(row.changed_at > '2000-01-01 00:00:00');
  assert.deepEqual(await migrateDataUrlImages(), { migrated: 0, failed: 1 });
  assert.equal(db.prepare('SELECT img_url FROM meals WHERE id=?').get(id).img_url, row.img_url);
  db.prepare('UPDATE foods SET img_url=? WHERE id=?').run(inline, bad);
  assert.deepEqual(await migrateDataUrlImages(), { migrated: 1, failed: 0 });
  assert.deepEqual(await migrateDataUrlImages(), { migrated: 0, failed: 0 });
});
