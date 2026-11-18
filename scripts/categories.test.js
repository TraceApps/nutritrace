/**
 * #332: a food kept one category and a meal or recipe none, though both
 * editors pick several; and taking a food's category away didn't stick
 * (the app sent null, which the server read as "unchanged"). Foods, meals
 * and recipes now keep the list (`categories`); foods also keep the first
 * as `category` for older apps, the public API, MCP and exports.
 *
 * Runs the real foods, meals, sync and public API routes on a temp database.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import test, { after } from 'node:test';
import { cleanCategories, storedCategories, foodCategoryFields } from '../src/lib/categories.js';
import { pushShape } from '../src/lib/offline-edits.js';

const temp = mkdtempSync(join(tmpdir(), 'nutritrace-categories-'));
process.env.DB_PATH = join(temp, 'test.db');
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'categories-test-only';

const { default: db } = await import('../server/db.js');
const { default: express } = await import('../server/node_modules/express/index.js');
const { default: foods } = await import('../server/routes/foods.js');
const { default: meals } = await import('../server/routes/meals.js');
const { default: sync } = await import('../server/routes/sync.js');
const { default: v1Foods } = await import('../server/routes/api/v1/foods.js');

db.prepare(`INSERT OR REPLACE INTO app_config (key, value) VALUES ('single_user_mode', '1')`).run();
const app = express();
app.use(express.json());
app.use('/api/foods', foods);
app.use('/api/meals', meals);
app.use('/api/sync', sync);
let apiUser = null;
app.use('/api/v1/foods', (req, _res, next) => { req.apiToken = { id: 1, user_id: apiUser, scopes: ['read:foods'] }; req.apiUser = { id: apiUser }; next(); }, v1Foods);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
after(async () => { await new Promise(r => server.close(r)); db.close(); rmSync(temp, { recursive: true, force: true }); });

const call = async (method, path, body) => {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const foodRow = id => db.prepare('SELECT category, categories FROM foods WHERE id = ?').get(id);
const mealRow = id => db.prepare('SELECT categories FROM meals WHERE id = ?').get(id);

test('the shared rules: a clean list, read from either column', () => {
  assert.deepEqual(cleanCategories([' Snacks ', 'Snacks', '', null, 'Dairy']), ['Snacks', 'Dairy']);
  assert.deepEqual(cleanCategories('Fruit'), ['Fruit']);
  assert.deepEqual(storedCategories({ categories: '["A","B"]', category: 'A' }), ['A', 'B']);
  assert.deepEqual(storedCategories({ categories: null, category: 'Old' }), ['Old'], 'a row from before has only category');
  assert.deepEqual(storedCategories({ categories: ['X'] }), ['X']);
  assert.deepEqual(foodCategoryFields({ categories: ['B', 'C'] }), { categories: ['B', 'C'], category: 'B' });
  assert.deepEqual(foodCategoryFields({ categories: [] }), { categories: [], category: null });
});

test('the app saves several categories on a food, and gets them all back', async () => {
  const made = await call('POST', '/api/foods', { name: 'Yogurt', categories: ['Dairy', 'Snacks'], category: 'Dairy' });
  assert.equal(made.status, 201);
  assert.deepEqual(made.body.categories, ['Dairy', 'Snacks']);
  assert.deepEqual(foodRow(made.body.id), { category: 'Dairy', categories: '["Dairy","Snacks"]' });
  const got = (await call('GET', '/api/foods')).body.find(f => f.id === made.body.id);
  assert.deepEqual(got.categories, ['Dairy', 'Snacks']);
});

test('taking every category away sticks (the reported bug)', async () => {
  const { body: f } = await call('POST', '/api/foods', { name: 'Bread', categories: ['Bakery'], category: 'Bakery' });
  // What the app sends with no category left: the empty list, and null.
  const put = await call('PUT', `/api/foods/${f.id}`, { name: 'Bread', categories: [], category: null, changed_fields: ['category', 'categories'] });
  assert.equal(put.status, 200);
  assert.deepEqual(put.body.categories, []);
  assert.deepEqual(foodRow(f.id), { category: null, categories: null });
});

test('an older app (one category) changes the first and keeps the rest', async () => {
  const { body: f } = await call('POST', '/api/foods', { name: 'Apple', categories: ['Fruit', 'Snacks'], category: 'Fruit' });
  await call('PUT', `/api/foods/${f.id}`, { name: 'Apple', category: 'Fruit', changed_fields: ['name', 'category'] });
  assert.deepEqual(storedCategories(foodRow(f.id)), ['Fruit', 'Snacks'], 'same first: kept as is');
  await call('PUT', `/api/foods/${f.id}`, { name: 'Apple', category: 'Produce', changed_fields: ['category'] });
  assert.deepEqual(foodRow(f.id), { category: 'Produce', categories: '["Produce","Snacks"]' });
  // A save that doesn't mention categories leaves them.
  await call('PUT', `/api/foods/${f.id}`, { favorite: true });
  assert.deepEqual(storedCategories(foodRow(f.id)), ['Produce', 'Snacks']);
  // One that says it changed something else leaves them too.
  await call('PUT', `/api/foods/${f.id}`, { name: 'Green Apple', categories: [], category: null, changed_fields: ['name'] });
  assert.deepEqual(storedCategories(foodRow(f.id)), ['Produce', 'Snacks']);
  // Cleared in an older app (it shows none left): none left.
  await call('PUT', `/api/foods/${f.id}`, { name: 'Apple', category: null });
  assert.deepEqual(foodRow(f.id), { category: null, categories: null });
});

test('re-importing a CookTrace pantry item keeps the categories picked here', async () => {
  const src = { source_app: 'cooktrace', source_external_id: 'pantry:7' };
  const { body: f } = await call('POST', '/api/foods', { name: 'Flour', ...src });
  await call('PUT', `/api/foods/${f.id}`, { name: 'Flour', categories: ['Baking', 'Staples'], category: 'Baking' });
  // What the app sends for an item with none: the empty list and null.
  const again = await call('POST', '/api/foods', { name: 'Flour', ...src, categories: [], category: null });
  assert.equal(again.body.id, f.id);
  assert.deepEqual(foodRow(f.id), { category: 'Baking', categories: '["Baking","Staples"]' });
  // One that brings categories sets them.
  await call('POST', '/api/foods', { name: 'Flour', ...src, categories: ['Pantry'], category: 'Pantry' });
  assert.deepEqual(storedCategories(foodRow(f.id)), ['Pantry']);
});

test("a phone's copy from before #332 doesn't count categories as changed, so a rename there keeps the web's", async () => {
  const { changesOf, baseOf } = await import('../src/lib/sync-base.js');
  const { SYNC_FIELDS } = await import('../src/lib/sync-fields.js');
  const row = { name: 'Nuts', category: 'Snacks', categories: ['Snacks'], nutrition: {} };
  const oldBase = JSON.parse(baseOf('foods', row));
  delete oldBase.categories; // kept before the field existed
  assert.deepEqual(changesOf('foods', { ...row, name: 'Mixed Nuts' }, JSON.stringify(oldBase)), ['name']);
  assert.deepEqual(changesOf('foods', { ...row, categories: ['Snacks', 'Keto'] }, baseOf('foods', row)), ['categories'], 'a new base sees a change of the list');
  const mealBase = JSON.parse(baseOf('meals', { name: 'Box', items: [] }));
  delete mealBase.categories;
  assert.deepEqual(changesOf('meals', { name: 'Box 2', items: [], categories: [] }, JSON.stringify(mealBase)), ['name']);
  assert.ok(SYNC_FIELDS.foods.includes('categories'));
  // And end to end: the web added Keto; the phone renames with its old copy.
  const { body: f } = await call('POST', '/api/foods', { name: 'Pecans', categories: ['Snacks', 'Keto'], category: 'Snacks' });
  const changed = changesOf('foods', { ...row, name: 'Pecan Halves' }, JSON.stringify(oldBase));
  await call('POST', '/api/sync/push', { foods: [{ client_id: 9, server_id: f.id, name: 'Pecan Halves', category: 'Snacks', categories: ['Snacks'], updated_at: new Date(Date.now() + 9000).toISOString(), changed_fields: changed }] });
  assert.deepEqual(storedCategories(foodRow(f.id)), ['Snacks', 'Keto']);
  assert.equal(db.prepare('SELECT name FROM foods WHERE id = ?').get(f.id).name, 'Pecan Halves');
});

test('a food from before has its single category as its list', async () => {
  const id = db.prepare(`INSERT INTO foods (name, category, updated_at) VALUES ('Old Cheese', 'Dairy', datetime('now'))`).run().lastInsertRowid;
  const got = (await call('GET', `/api/foods/${id}`)).body;
  assert.deepEqual(got.categories, ['Dairy']);
});

test('meals and recipes keep their categories now', async () => {
  const made = await call('POST', '/api/meals', { name: 'Lunch Box', items: [], categories: ['Work', 'Quick'] });
  assert.equal(made.status, 201);
  assert.deepEqual(made.body.categories, ['Work', 'Quick']);
  const recipe = await call('POST', '/api/meals', { name: 'Stew', items: [], is_recipe: 1, categories: ['Dinner'] });
  assert.deepEqual((await call('GET', '/api/meals?recipes=1')).body.find(m => m.id === recipe.body.id).categories, ['Dinner']);
  await call('PUT', `/api/meals/${made.body.id}`, { name: 'Lunch Box', items: [], categories: ['Quick'] });
  assert.deepEqual(storedCategories(mealRow(made.body.id)), ['Quick']);
  await call('PUT', `/api/meals/${made.body.id}`, { name: 'Lunch Box 2', items: [] });
  assert.deepEqual(storedCategories(mealRow(made.body.id)), ['Quick'], 'a save without them leaves them');
  await call('PUT', `/api/meals/${made.body.id}`, { name: 'Lunch Box 2', items: [], categories: [] });
  assert.equal(mealRow(made.body.id).categories, null);
});

test('sync: an older Android app pushing one category keeps the rest; this app pushes the list', async () => {
  const { body: f } = await call('POST', '/api/foods', { name: 'Nuts', categories: ['Snacks', 'Keto'], category: 'Snacks' });
  const later = new Date(Date.now() + 5000).toISOString();
  // Older app: renames, and sends the category it has (the first).
  let r = await call('POST', '/api/sync/push', { foods: [{ client_id: 1, server_id: f.id, name: 'Mixed Nuts', category: 'Snacks', updated_at: later, changed_fields: ['name'] }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(storedCategories(foodRow(f.id)), ['Snacks', 'Keto']);
  // Older app changes the category it sees.
  r = await call('POST', '/api/sync/push', { foods: [{ client_id: 1, server_id: f.id, name: 'Mixed Nuts', category: 'Treats', updated_at: new Date(Date.now() + 6000).toISOString(), changed_fields: ['category'] }] });
  assert.deepEqual(foodRow(f.id), { category: 'Treats', categories: '["Treats","Keto"]' });
  // This app sends the list.
  await call('POST', '/api/sync/push', { foods: [{ client_id: 1, server_id: f.id, name: 'Mixed Nuts', category: 'Keto', categories: ['Keto'], updated_at: new Date(Date.now() + 7000).toISOString(), changed_fields: ['category', 'categories'] }] });
  assert.deepEqual(foodRow(f.id), { category: 'Keto', categories: '["Keto"]' });
  // New rows from a push, and meals.
  r = await call('POST', '/api/sync/push', {
    foods: [{ client_id: 2, name: 'Oats', categories: ['Breakfast', 'Grains'], category: 'Breakfast', updated_at: later }],
    meals: [{ client_id: 3, name: 'Shake', items: [], categories: ['Gym'], updated_at: later }],
  });
  const newFood = r.body.foods.find(x => x.client_id === 2).server_id;
  const newMeal = r.body.meals.find(x => x.client_id === 3).server_id;
  assert.deepEqual(foodRow(newFood), { category: 'Breakfast', categories: '["Breakfast","Grains"]' });
  assert.deepEqual(storedCategories(mealRow(newMeal)), ['Gym']);
  // An older app's new food: its one category is the list.
  r = await call('POST', '/api/sync/push', { foods: [{ client_id: 4, name: 'Rice', category: 'Grains', updated_at: later }] });
  assert.deepEqual(foodRow(r.body.foods[0].server_id), { category: 'Grains', categories: '["Grains"]' });
  // The pull sends the list as a list.
  const pull = await call('GET', '/api/sync/pull?since=1970-01-01T00:00:00Z');
  assert.deepEqual(pull.body.foods.find(x => x.id === newFood).categories, ['Breakfast', 'Grains']);
  assert.deepEqual(pull.body.meals.find(x => x.id === newMeal).categories, ['Gym']);
});

test('an export imports with its categories, and one without any imports too', async () => {
  const { default: data } = await import('../server/routes/data.js');
  const app2 = express(); app2.use(express.json()); app2.use('/api/data', data);
  const s2 = app2.listen(0, '127.0.0.1'); await once(s2, 'listening');
  try {
    const r = await fetch(`http://127.0.0.1:${s2.address().port}/api/data/import`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        foodList: [{ name: 'Imp A', categories: ['One', 'Two'] }, { name: 'Imp B', category: 'Old' }, { name: 'Imp C' }],
        meals: [{ name: 'Imp Meal', categories: ['Gym'] }, { name: 'Imp Meal 2' }],
      }),
    });
    assert.equal(r.status, 200, await r.clone().text());
    const cat = n => storedCategories(db.prepare('SELECT category, categories FROM foods WHERE name = ?').get(n));
    assert.deepEqual(cat('Imp A'), ['One', 'Two']);
    assert.deepEqual(cat('Imp B'), ['Old']);
    assert.deepEqual(cat('Imp C'), []);
    assert.deepEqual(storedCategories(db.prepare("SELECT categories FROM meals WHERE name = 'Imp Meal'").get()), ['Gym']);
  } finally { s2.close(); }
});

test('the public API filters by any of a food\'s categories and lists them all', async () => {
  // The public API is per account (last here: an account turns user management on).
  apiUser = Number(db.prepare(`INSERT INTO users (username, password_hash, role) VALUES ('cats', 'x', 'admin')`).run().lastInsertRowid);
  const id = db.prepare(`INSERT INTO foods (user_id, name, category, categories, updated_at) VALUES (?, 'Hummus', 'Dips', '["Dips","Vegan"]', datetime('now'))`).run(apiUser).lastInsertRowid;
  db.prepare(`INSERT INTO foods (user_id, name, category, categories, updated_at) VALUES (?, 'Salsa', 'Dips', '["Dips"]', datetime('now'))`).run(apiUser);
  const r = await call('GET', '/api/v1/foods?category=Vegan');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const list = r.body.items || r.body.foods || r.body.data || [];
  assert.deepEqual(list.map(x => x.name), ['Hummus'], 'found by its second category, and only it');
  assert.equal(list[0].category, 'Dips');
  assert.deepEqual(list[0].categories, ['Dips', 'Vegan']);
  assert.deepEqual((await call('GET', '/api/v1/foods?category=Dips')).body.items.map(x => x.name).sort(), ['Hummus', 'Salsa']);
});

test('an offline edit in the browser pushes the list and its first', () => {
  assert.deepEqual(pushShape('foods', { name: 'X', categories: ['A', 'B'], imgUrl: '' }), { name: 'X', categories: ['A', 'B'], category: 'A', img_url: null });
  assert.deepEqual(pushShape('foods', { name: 'X', categories: [] }), { name: 'X', categories: [], category: null });
  assert.deepEqual(pushShape('meals', { name: 'M', categories: ['Gym'] }), { name: 'M', categories: ['Gym'] });
});
