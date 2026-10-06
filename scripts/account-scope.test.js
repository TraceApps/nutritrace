/**
 * One account's foods, meals, activities and fasts stay its own.
 *
 * The Android sync push wrote whatever row a pushed id named, so a phone
 * could overwrite or delete another account's food, meal, activity or fast
 * (or an account signed in after another on the same phone could). And a
 * diary item filled in its category, barcode, units and photo from any
 * account's food. Verified end to end against a running server with the
 * app's own sync code; these pin the rules on the real schema and keep the
 * code wired to them.
 */
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

// server/db.js opens DB_PATH when imported: a scratch database.
let helpers = null, db = null, dir = null;
try {
  createRequire(new URL('../server/package.json', import.meta.url))('better-sqlite3');
  dir = mkdtempSync(join(tmpdir(), 'nt-account-scope-'));
  process.env.DB_PATH = join(dir, 'test.db');
  db = (await import('../server/db.js')).default;
  helpers = await import('../server/lib/diary-helpers.js');
} catch { /* better-sqlite3 not built for this Node: the schema tests skip */ }
test.after(() => { try { db?.close(); } catch {} if (dir) rmSync(dir, { recursive: true, force: true }); });

function seed() {
  const user = n => Number(db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(n + Math.random(), 'x').lastInsertRowid);
  const me = user('me'), other = user('other');
  const food = (u, name, extra = {}) => Number(db.prepare(
    `INSERT INTO foods (user_id, name, category, barcode, img_url, visibility) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(u, name, extra.category ?? null, extra.barcode ?? null, extra.img_url ?? null, extra.visibility ?? 'private').lastInsertRowid);
  return {
    me, other,
    theirs: food(other, 'Secret', { category: 'Their Category', barcode: 'THEIRS', img_url: '/uploads/theirs.jpg' }),
    shared: food(other, 'Shared Bread', { category: 'Bakery', img_url: '/uploads/bread.jpg', visibility: 'group' }),
    mine: food(me, 'Oats', { category: 'Grains', img_url: '/uploads/oats.jpg' }),
    theirBanana: food(other, 'Banana Zz', { img_url: '/uploads/their-banana.jpg' }),
  };
}

test("a diary item doesn't take another account's food details", (t) => {
  if (!helpers) return t.skip('better-sqlite3 is not built for this Node');
  const s = seed();
  const [item] = helpers.hydrateItems([{ id: s.theirs, name: 'Mine, not theirs' }], s.me);
  assert.equal(item.category, undefined);
  assert.equal(item.barcode, undefined);
  const [own] = helpers.hydrateItems([{ food_server_id: s.mine, name: 'Oats' }], s.me);
  assert.equal(own.category, 'Grains', 'its own food still fills it in');
  const [shared] = helpers.hydrateItems([{ food_server_id: s.shared, name: 'Shared Bread' }], s.me);
  assert.equal(shared.category, 'Bakery', 'a food shared with the group does too');
});

test("a diary item doesn't take another account's photo by name", (t) => {
  if (!helpers) return t.skip('better-sqlite3 is not built for this Node');
  const s = seed();
  const [banana] = helpers.freshenItemImages([{ id: 99999, name: 'Banana Zz' }], s.me);
  assert.equal(banana.imgUrl, '');
  const [oats] = helpers.freshenItemImages([{ id: s.mine, name: 'Oats' }], s.me);
  assert.equal(oats.imgUrl, '/uploads/oats.jpg');
});

test('with user management off, everything is read as before', (t) => {
  if (!helpers) return t.skip('better-sqlite3 is not built for this Node');
  const s = seed();
  const [item] = helpers.hydrateItems([{ id: s.theirs, name: 'x' }], null);
  assert.equal(item.category, 'Their Category');
});

test('the diary routes pass the diary owner to both helpers', () => {
  assert.match(read('../server/routes/diary.js'), /freshenItemImages\(hydrateItems\(fixCachedPaths\(items\), row\.user_id \?\? null\), row\.user_id \?\? null\)/);
  assert.match(read('../server/routes/sync.js'), /freshenItemImages\(hydrateItems\(parsed\.items, row\.user_id \?\? null\), row\.user_id \?\? null\)/);
});

test('the sync push only changes rows the account owns', () => {
  const sync = read('../server/routes/sync.js');
  for (const table of ['foods', 'meals', 'activity_log', 'fasts']) {
    assert.match(sync, new RegExp(`SELECT updated_at, user_id FROM ${table} WHERE id = \\?`), `${table} reads its owner`);
  }
  assert.equal((sync.match(/if \(_ownsRow\(existing, u\) && norm\(/g) || []).length, 4);
  assert.match(sync, /function _ownsRow\(row, u\) \{\s*return u == null \|\| row\.user_id === u;/);
});

test('the ingredients of a meal shared with you fill in its items', (t) => {
  if (!helpers) return t.skip('better-sqlite3 is not built for this Node');
  const s = seed();
  const meal = Number(db.prepare(`INSERT INTO meals (user_id, name, items, visibility) VALUES (?, 'Their Bowl', ?, 'group')`)
    .run(s.other, JSON.stringify([{ id: s.theirs, food_server_id: s.theirs, name: 'Secret' }])).lastInsertRowid);
  const [item] = helpers.hydrateItems([{ food_server_id: s.theirs, name: 'Secret' }], s.me);
  assert.equal(item.category, 'Their Category', 'GET /api/meals/:id already hands these over');
  db.prepare(`UPDATE meals SET visibility = 'private' WHERE id = ?`).run(meal);
  const [after] = helpers.hydrateItems([{ food_server_id: s.theirs, name: 'Secret' }], s.me);
  assert.equal(after.category, undefined, 'not once the meal is private again');
});

test("your own food's photo wins a name match", (t) => {
  if (!helpers) return t.skip('better-sqlite3 is not built for this Node');
  const s = seed();
  const name = 'Pear ' + Math.random();
  db.prepare(`INSERT INTO foods (user_id, name, img_url, visibility) VALUES (?, ?, '/uploads/their-pear.jpg', 'group')`).run(s.other, name);
  db.prepare(`INSERT INTO foods (user_id, name, img_url) VALUES (?, ?, '/uploads/my-pear.jpg')`).run(s.me, name);
  const [pear] = helpers.freshenItemImages([{ id: 999999, name }], s.me);
  assert.equal(pear.imgUrl, '/uploads/my-pear.jpg');
});
