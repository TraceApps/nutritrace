/**
 * The local Open Food Facts mirror answers everyone through one DuckDB
 * connection, and a DuckDB connection runs one statement at a time. A search
 * ran its page and its count at once, and two people searching or scanning
 * together did the same, so a mirror search failed now and then with "Failed
 * to execute prepared statement" and the server quietly asked Open Food Facts
 * instead (or, air-gapped, answered nothing).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('many searches and lookups at once all get answers', async (t) => {
  let DuckDBInstance;
  try {
    ({ DuckDBInstance } = await import('../server/node_modules/@duckdb/node-api/lib/index.js'));
  } catch {
    t.skip('@duckdb/node-api is not installed here');
    return;
  }
  const dbFile = join(mkdtempSync(join(tmpdir(), 'off-conc-')), 'off.duckdb');
  const inst = await DuckDBInstance.create(dbFile);
  const conn = await inst.connect();
  await conn.run(`CREATE TABLE products (code VARCHAR, product_name VARCHAR, brands VARCHAR)`);
  await conn.run(`INSERT INTO products VALUES
    ('3017620422003', 'Nutella', 'Ferrero'),
    ('5705830010780', 'Kidney Bønner', 'Rema 1000'),
    ('0000000000017', 'Crème fraîche épaisse', 'Élle & Vire'),
    ('0000000000024', 'Peanut butter', 'Skippy')`);
  conn.closeSync();
  inst.closeSync();

  process.env.OFF_LOCAL_DB = dbFile;
  const off = await import('../server/lib/off-local.js');

  const asks = [];
  for (let i = 0; i < 15; i++) {
    asks.push(off.searchByName('nutella').then(r => ['search nutella', r?.count]));
    asks.push(off.searchByName('creme fraiche').then(r => ['search creme fraiche (accent retry)', r?.count]));
    asks.push(off.lookupByBarcode('5705830010780').then(r => ['lookup beans', r?.status]));
  }
  for (const [what, got] of await Promise.all(asks)) assert.equal(got, 1, what);
});
