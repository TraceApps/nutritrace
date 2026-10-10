/**
 * Search folding, client and server.
 *
 * Food names carry accents: Plátano, Café, Limón, Jalapeño, Crème fraîche.
 * Nobody types the accent on a phone, so every search folds both sides
 * before comparing. The helpers live in two places because the runtime image
 * ships server/ and dist/ only, so the first test pins the copies together.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { foldText, stripAccents, includesFolded, coversFolded } from '../src/lib/search-text.js';
import { foldText as serverFoldText } from '../server/lib/search-text.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

// The engine the server runs, better-sqlite3, built for the Node in CI and
// the image; Node's own SQLite where that binary doesn't match the local Node
// (node:sqlite is missing from Node 20).
async function openDb() {
  try {
    const Database = createRequire(new URL('../server/package.json', import.meta.url))('better-sqlite3');
    return new Database(':memory:');
  } catch {}
  try {
    const { DatabaseSync } = await import('node:sqlite');
    return new DatabaseSync(':memory:');
  } catch {}
  return null;
}

const SAMPLES = [
  'Plátano', 'Café', 'Limón', 'Jalapeño', 'Azúcar', 'Jamón', 'Maíz',
  'Itambé', 'Crème fraîche', 'Gruyère', 'Straße', 'Ølsuppe', 'Łosoś',
  'Þorramatur', 'Æbleskiver', 'Whole milk', 'OAT', '', null, undefined, 42,
];

test('the client and server copies fold identically', () => {
  for (const s of SAMPLES) assert.equal(serverFoldText(s), foldText(s), `differs for ${String(s)}`);
});

test('folding drops accents and leaves plain text alone', () => {
  assert.equal(foldText('Plátano'), 'platano');
  assert.equal(foldText('Crème fraîche'), 'creme fraiche');
  assert.equal(foldText('Whole Milk'), 'whole milk');
  // Letters with no combining mark to strip, so NFD alone cannot fold them.
  assert.equal(foldText('Straße'), 'strasse');
  assert.equal(foldText('Ølsuppe'), 'olsuppe');
  assert.equal(foldText('Æbleskiver'), 'aebleskiver');
});

test('stripAccents leaves those letters alone, the way SQL engines do', () => {
  // DuckDB's strip_accents() drops combining marks and nothing else, so a
  // needle for that engine has to be folded the same partial way.
  assert.equal(stripAccents('Straße'), 'straße');
  assert.equal(stripAccents('Łosoś'), 'łosos');
  assert.equal(stripAccents('Crème fraîche'), 'creme fraiche');
});

test('folding is idempotent and never throws on junk', () => {
  for (const s of SAMPLES) assert.equal(foldText(foldText(s)), foldText(s));
  assert.equal(foldText(null), '');
});

test('includesFolded matches either side accented, and an empty query matches', () => {
  assert.ok(includesFolded('Plátano maduro', 'platano'));
  assert.ok(includesFolded('Platano maduro', 'plátano'));
  assert.ok(includesFolded('Café con leche', 'CAFE'));
  assert.ok(includesFolded('anything', ''));
  assert.ok(!includesFolded('Plátano', 'apple'));
});

test('coversFolded takes the tokens in any order', () => {
  assert.ok(coversFolded('Whole milk Itambé', 'itambe milk'));
  assert.ok(!coversFolded('Whole milk', 'milk oat'));
});

test('the SQL fold() function makes LIKE accent-insensitive', async (t) => {
  const db = await openDb();
  if (!db) return t.skip('no SQLite engine loads under this Node');
  db.function('fold', { deterministic: true }, (s) => serverFoldText(s));
  db.exec('CREATE TABLE foods (name TEXT, brand TEXT)');
  const ins = db.prepare('INSERT INTO foods VALUES (?, ?)');
  ins.run('Plátano', null);
  ins.run('Leite', 'Itambé');
  ins.run('Whole milk', null);
  const find = (q) => db.prepare(
    `SELECT name FROM foods WHERE fold(name) LIKE ? OR fold(brand) LIKE ?`
  ).all(`%${serverFoldText(q)}%`, `%${serverFoldText(q)}%`).map(r => r.name);
  assert.deepEqual(find('platano'), ['Plátano']);
  assert.deepEqual(find('plátano'), ['Plátano']);
  assert.deepEqual(find('itambe'), ['Leite']);
  assert.deepEqual(find('milk'), ['Whole milk']);
  assert.deepEqual(find('zzz'), []);
});

test('the server search queries all go through fold()', () => {
  const sites = [
    ['../server/routes/api/v1/foods.js', /\(fold\(name\) LIKE \? OR fold\(brand\) LIKE \?\)/],
    ['../server/lib/mcp/tools/search-foods.js', /fold\(name\) LIKE \? ESCAPE/],
    ['../server/lib/mcp/tools/search-meals.js', /fold\(name\) LIKE \? ESCAPE/],
  ];
  for (const [p, re] of sites) assert.match(read(p), re, p);
  assert.match(read('../server/db.js'), /db\.function\('fold'/);
});

test('no search box compares raw lowercase text any more', () => {
  const swept = [
    '../src/lib/db.js',
    '../src/lib/activity-picker.js',
    '../src/lib/quick-log.js',
    '../src/components/diary/AddActivitySheet.svelte',
    '../src/components/ui/UnitPicker.svelte',
    '../src/components/ai/Trace.svelte',
    '../src/routes/MealEditor.svelte',
    '../src/routes/Statistics.svelte',
    '../src/routes/Goals.svelte',
    '../src/routes/Settings.svelte',
  ];
  for (const p of swept) {
    const src = read(p);
    assert.doesNotMatch(src, /\.toLowerCase\(\)\.includes\(/, `${p} still compares unfolded text`);
    assert.match(src, /foldText\(/, `${p} should use the shared fold`);
  }
});

test('the local OFF mirror retries a search with accents stripped', async (t) => {
  let DuckDBInstance;
  try {
    ({ DuckDBInstance } = await import('../server/node_modules/@duckdb/node-api/lib/index.js'));
  } catch {
    t.skip('@duckdb/node-api is not installed here');
    return;
  }
  // A native .duckdb file, which is the shape off-local opens read-only.
  const dbFile = join(mkdtempSync(join(tmpdir(), 'off-fold-')), 'off.duckdb');
  const inst = await DuckDBInstance.create(dbFile);
  const conn = await inst.connect();
  await conn.run(`CREATE TABLE products (code VARCHAR, product_name VARCHAR, brands VARCHAR)`);
  await conn.run(`INSERT INTO products VALUES
    ('1', 'Crème fraîche épaisse', 'Élle & Vire'),
    ('2', 'Peanut butter', 'Skippy')`);
  conn.closeSync();
  inst.closeSync();

  process.env.OFF_LOCAL_DB = dbFile;
  const off = await import('../server/lib/off-local.js');

  const plain = await off.searchByName('peanut');
  assert.equal(plain.count, 1, 'a query with no accents in play still works');
  assert.equal(plain.hits[0].product_name, 'Peanut butter');

  const folded = await off.searchByName('creme fraiche');
  assert.equal(folded.count, 1, 'the accented product is found without the accents');
  assert.equal(folded.hits[0].product_name, 'Crème fraîche épaisse');

  const brand = await off.searchByName('elle');
  assert.equal(brand.count, 1, 'brands fold too');

  const miss = await off.searchByName('zzzznothing');
  assert.equal(miss.count, 0, 'a genuine miss is still a miss after the retry');
});
