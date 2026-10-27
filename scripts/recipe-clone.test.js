import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import test, { after } from 'node:test';

// #299: Clone on the web said "Cloned" and made nothing. The copy carried
// the original's sync key (or its CookTrace source id), so the server
// returned (or overwrote) the original instead of saving a new recipe.
const temp = mkdtempSync(join(tmpdir(), 'nutritrace-recipe-clone-'));
process.env.DB_PATH = join(temp, 'test.db');
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'recipe-clone-test-only';

const { default: db } = await import('../server/db.js');
const { default: express } = await import('../server/node_modules/express/index.js');
const { default: meals } = await import('../server/routes/meals.js');
const { cloneOf } = await import('../src/lib/clone-item.js');
const app = express();
app.use(express.json());
app.use('/api/meals', meals);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
after(async () => {
  await new Promise(resolve => server.close(resolve));
  db.close();
  rmSync(temp, { recursive: true, force: true });
});

async function call(method, path, body) {
  const res = await fetch(base + path, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

function seed(name, extra) {
  const cols = Object.keys(extra);
  return Number(db.prepare(
    `INSERT INTO meals (name, nutrition, items, is_recipe, ${cols.join(', ')})
     VALUES (?, '{"calories":300}', '[]', 1, ${cols.map(() => '?').join(', ')})`
  ).run(name, ...Object.values(extra)).lastInsertRowid);
}

async function cloneThroughWeb(id) {
  const original = (await call('GET', `/api/meals/${id}`)).body;
  return call('POST', '/api/meals', cloneOf(original, 'Copy of ' + original.name));
}

test('cloning a recipe that came from Android sync saves a new recipe', async () => {
  const id = seed('Synced Chili', { client_key: 'meals:install-1:7' });
  const { status, body } = await cloneThroughWeb(id);
  assert.equal(status, 201);
  assert.notEqual(body.id, id);
  assert.equal(body.name, 'Copy of Synced Chili');
  assert.equal(body.nutrition.calories, 300);
  assert.equal(db.prepare('SELECT name FROM meals WHERE id = ?').get(id).name, 'Synced Chili');
});

test('cloning a recipe imported from CookTrace leaves the original alone', async () => {
  const id = seed('Imported Stew', { source_app: 'cooktrace', source_external_id: '42', source_url: 'https://cooktrace.example/r/42' });
  const { status, body } = await cloneThroughWeb(id);
  assert.equal(status, 201);
  assert.notEqual(body.id, id);
  assert.equal(body.source_app, 'cooktrace');
  assert.equal(body.source_url, 'https://cooktrace.example/r/42');
  assert.equal(body.source_external_id, null);
  const original = db.prepare('SELECT name, source_external_id FROM meals WHERE id = ?').get(id);
  assert.deepEqual({ ...original }, { name: 'Imported Stew', source_external_id: '42' });
  // A later CookTrace re-import still updates the original, not the copy.
  const again = await call('POST', '/api/meals', { name: 'Imported Stew v2', is_recipe: true, source_app: 'cooktrace', source_external_id: '42' });
  assert.equal(again.body.id, id);
});

test('two clones of the same recipe are two recipes', async () => {
  const id = seed('Twice', { client_key: 'meals:install-1:9' });
  const a = await cloneThroughWeb(id);
  const b = await cloneThroughWeb(id);
  assert.notEqual(a.body.id, b.body.id);
});
