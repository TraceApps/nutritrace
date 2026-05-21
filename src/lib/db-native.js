/**
 * db-native.js — SQLite database layer for the Capacitor native app.
 *
 * Uses @capacitor-community/sqlite to provide a local SQLite database that
 * mirrors the NutriTrace server schema. All data in standalone mode lives here.
 *
 * The local user_id is always 1 (single-user standalone mode).
 */

import { CapacitorSQLite, SQLiteConnection } from '@capacitor-community/sqlite';

const LOCAL_USER_ID = 1;
const DB_NAME = 'nutritrace_local';
const DB_VERSION = 1;

const sqlite = new SQLiteConnection(CapacitorSQLite);
let _db = null;
let _initPromise = null;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS foods (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id    INTEGER,
    user_id      INTEGER DEFAULT 1,
    name         TEXT NOT NULL,
    brand        TEXT,
    nutrition    TEXT DEFAULT '{}',
    portion      REAL DEFAULT 100,
    unit         TEXT DEFAULT 'g',
    img_url      TEXT,
    notes        TEXT,
    category     TEXT,
    barcode      TEXT,
    visibility   TEXT NOT NULL DEFAULT 'private',
    source_id    INTEGER,
    favorite     INTEGER NOT NULL DEFAULT 0,
    usage_count  INTEGER NOT NULL DEFAULT 0,
    last_used_at TEXT DEFAULT NULL,
    created_at   TEXT DEFAULT (datetime('now')),
    updated_at   TEXT DEFAULT (datetime('now')),
    deleted_at   TEXT DEFAULT NULL,
    sync_status  TEXT DEFAULT 'synced'
  );

  CREATE TABLE IF NOT EXISTS meals (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id    INTEGER,
    user_id      INTEGER DEFAULT 1,
    name         TEXT NOT NULL,
    nutrition    TEXT DEFAULT '{}',
    items        TEXT DEFAULT '[]',
    img_url      TEXT,
    notes        TEXT,
    is_recipe    INTEGER DEFAULT 0,
    portion      REAL DEFAULT 100,
    unit         TEXT DEFAULT 'g',
    servings     INTEGER DEFAULT 1,
    visibility   TEXT NOT NULL DEFAULT 'private',
    source_id    INTEGER,
    favorite     INTEGER NOT NULL DEFAULT 0,
    usage_count  INTEGER NOT NULL DEFAULT 0,
    last_used_at TEXT DEFAULT NULL,
    created_at   TEXT DEFAULT (datetime('now')),
    updated_at   TEXT DEFAULT (datetime('now')),
    deleted_at   TEXT DEFAULT NULL,
    sync_status  TEXT DEFAULT 'synced'
  );

  CREATE TABLE IF NOT EXISTS diary (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id   INTEGER,
    user_id     INTEGER DEFAULT 1,
    date        TEXT NOT NULL,
    items       TEXT DEFAULT '[]',
    body_stats  TEXT DEFAULT '{}',
    water       TEXT DEFAULT '[]',
    notes       TEXT DEFAULT NULL,
    updated_at  TEXT DEFAULT (datetime('now')),
    deleted_at  TEXT DEFAULT NULL,
    sync_status TEXT DEFAULT 'synced',
    UNIQUE(date, user_id)
  );

  CREATE TABLE IF NOT EXISTS wellness_data (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER DEFAULT 1,
    date        TEXT NOT NULL,
    source      TEXT NOT NULL DEFAULT 'health_connect',
    metric_type TEXT NOT NULL,
    value       REAL,
    metadata    TEXT DEFAULT '{}',
    synced_at   TEXT DEFAULT (datetime('now')),
    sync_status TEXT DEFAULT 'pending',
    UNIQUE(user_id, date, source, metric_type)
  );

  CREATE TABLE IF NOT EXISTS workouts (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id       INTEGER,
    user_id         INTEGER DEFAULT 1,
    source          TEXT NOT NULL DEFAULT 'fitbit',
    source_id       TEXT NOT NULL,
    date            TEXT NOT NULL,
    activity_type   TEXT,
    activity_name   TEXT,
    start_time      TEXT,
    duration_ms     INTEGER,
    distance_km     REAL,
    calories        INTEGER,
    avg_hr          INTEGER,
    max_hr          INTEGER,
    steps           INTEGER,
    has_gps         INTEGER DEFAULT 0,
    gps_data        TEXT,
    synced_at       TEXT DEFAULT (datetime('now')),
    updated_at      TEXT DEFAULT (datetime('now')),
    UNIQUE(user_id, source, source_id)
  );

  CREATE INDEX IF NOT EXISTS idx_workouts_user_date ON workouts(user_id, date);

  CREATE TABLE IF NOT EXISTS user_settings (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER DEFAULT 1,
    key         TEXT NOT NULL,
    value       TEXT,
    updated_at  TEXT DEFAULT (datetime('now')),
    deleted_at  TEXT DEFAULT NULL,
    sync_status TEXT DEFAULT 'synced',
    UNIQUE(user_id, key)
  );

  CREATE TABLE IF NOT EXISTS sync_meta (
    key   TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS sync_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    synced_at   TEXT DEFAULT (datetime('now')),
    direction   TEXT NOT NULL,
    table_name  TEXT NOT NULL,
    record_id   INTEGER,
    status      TEXT NOT NULL DEFAULT 'ok',
    error       TEXT
  );

  CREATE TABLE IF NOT EXISTS activity_log (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id    INTEGER,
    user_id      INTEGER DEFAULT 1,
    date         TEXT NOT NULL,
    name         TEXT NOT NULL,
    kcal         INTEGER NOT NULL,
    duration_min INTEGER,
    distance     TEXT,
    source       TEXT NOT NULL DEFAULT 'manual_form',
    created_at   TEXT DEFAULT (datetime('now')),
    updated_at   TEXT DEFAULT (datetime('now')),
    deleted_at   TEXT DEFAULT NULL,
    sync_status  TEXT DEFAULT 'synced'
  );

  CREATE INDEX IF NOT EXISTS idx_activity_user_date ON activity_log(user_id, date);
  CREATE INDEX IF NOT EXISTS idx_activity_sync      ON activity_log(sync_status);

  -- Intermittent-fasting tracker. Mirrors the server schema; sync_status
  -- 'pending' rows queue for diff-sync push when connected to a server.
  CREATE TABLE IF NOT EXISTS fasts (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id    INTEGER,
    user_id      INTEGER DEFAULT 1,
    start_at     TEXT NOT NULL,
    end_at       TEXT,
    goal_hours   REAL NOT NULL DEFAULT 16,
    notes        TEXT,
    created_at   TEXT DEFAULT (datetime('now')),
    updated_at   TEXT DEFAULT (datetime('now')),
    deleted_at   TEXT DEFAULT NULL,
    sync_status  TEXT DEFAULT 'synced'
  );
  CREATE INDEX IF NOT EXISTS idx_fasts_user_start ON fasts(user_id, start_at);
  CREATE INDEX IF NOT EXISTS idx_fasts_active     ON fasts(user_id, end_at);
  CREATE INDEX IF NOT EXISTS idx_fasts_sync       ON fasts(sync_status);
  CREATE INDEX IF NOT EXISTS idx_fasts_server     ON fasts(server_id);

  CREATE INDEX IF NOT EXISTS idx_foods_user ON foods(user_id);
  CREATE INDEX IF NOT EXISTS idx_foods_server ON foods(server_id);
  CREATE INDEX IF NOT EXISTS idx_meals_user ON meals(user_id);
  CREATE INDEX IF NOT EXISTS idx_meals_server ON meals(server_id);
  CREATE INDEX IF NOT EXISTS idx_diary_user_date ON diary(user_id, date);
  CREATE INDEX IF NOT EXISTS idx_diary_server ON diary(server_id);
  CREATE INDEX IF NOT EXISTS idx_wellness_user_date ON wellness_data(user_id, date);
  CREATE INDEX IF NOT EXISTS idx_foods_sync ON foods(sync_status);
  CREATE INDEX IF NOT EXISTS idx_meals_sync ON meals(sync_status);
  CREATE INDEX IF NOT EXISTS idx_diary_sync ON diary(sync_status);
`;

// ── DB encryption (disabled in v0.39.23+) ─────────────────────────────────
//
// Native SQLite encryption via @capacitor-community/sqlite v8 had brittle
// secret-store semantics — calling setEncryptionSecret on subsequent launches
// produced "state not correct" / SQLITE_NOTADB failures that broke sync.
// Reverted to plain SQLite for now. Modern Android still encrypts the app
// data directory at the OS level, so the local DB is not in cleartext on a
// locked device. SQLCipher integration deferred to v1.1 with a different
// approach (likely Android Keystore + per-page encryption). See FUTURE.md.

async function _applySchema(db) {
  await db.execute(SCHEMA);
  // Migrations: add columns that may be missing from existing installs
  try {
    const info = await db.query(`PRAGMA table_info(diary)`);
    const cols = (info?.values || []).map(r => r.name);
    if (!cols.includes('notes')) {
      await db.execute(`ALTER TABLE diary ADD COLUMN notes TEXT DEFAULT NULL`);
    }
  } catch (e) {
    console.debug('[db-native] diary.notes migration skipped:', e?.message);
  }

  // Favorites + usage tracking — mirror of the server-side migration.
  // Ensures the native cache has the same shape so synced rows from the
  // server don't get rejected when we INSERT/UPDATE here.
  for (const tbl of ['foods', 'meals']) {
    try {
      const info = await db.query(`PRAGMA table_info(${tbl})`);
      const cols = (info?.values || []).map(r => r.name);
      if (!cols.includes('favorite')) {
        await db.execute(`ALTER TABLE ${tbl} ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0`);
      }
      if (!cols.includes('usage_count')) {
        await db.execute(`ALTER TABLE ${tbl} ADD COLUMN usage_count INTEGER NOT NULL DEFAULT 0`);
      }
      if (!cols.includes('last_used_at')) {
        await db.execute(`ALTER TABLE ${tbl} ADD COLUMN last_used_at TEXT DEFAULT NULL`);
      }
      if (tbl === 'meals' && !cols.includes('servings')) {
        // Migrated rows stay NULL so the editor can show a blank field for
        // legacy recipes (which still behave as 1 in math). New saves write
        // an explicit number via dbCreateMeal/dbUpdateMeal.
        await db.execute(`ALTER TABLE meals ADD COLUMN servings INTEGER`);
      }
    } catch (e) {
      console.debug(`[db-native] ${tbl} favorites/usage migration skipped:`, e?.message);
    }
  }

  // wellness_data.sync_status: tracks which Health Connect rows need to be
  // pushed up to the server. Pre-existing rows default to 'pending' so the
  // first sync after this migration backfills any Health Connect data the
  // user already had locally up to the server.
  try {
    const info = await db.query(`PRAGMA table_info(wellness_data)`);
    const cols = (info?.values || []).map(r => r.name);
    if (!cols.includes('sync_status')) {
      await db.execute(`ALTER TABLE wellness_data ADD COLUMN sync_status TEXT DEFAULT 'pending'`);
      await db.run(`UPDATE wellness_data SET sync_status = 'pending' WHERE sync_status IS NULL`);
    }
  } catch (e) {
    console.debug('[db-native] wellness_data.sync_status migration skipped:', e?.message);
  }

  // One-shot heal: clear `sync_status='pending'` on any row that was
  // already server-synced (has a server_id). An earlier version of
  // `dbBumpFoodUsage` / `dbBumpMealUsage` (pre-ee1e7b8) marked rows
  // pending on every diary add, which then blocked
  // `dbUpsertFromServer` from applying server-side image / nutrition
  // corrections (because the upsert refuses to overwrite locally-pending
  // rows). Now that bumps no longer mark rows pending, we need to free
  // the rows that got falsely stuck. Local-only rows (no server_id) keep
  // their pending state so they still push on the next sync.
  try {
    const fBefore = await db.query(`SELECT COUNT(*) AS n FROM foods WHERE sync_status = 'pending' AND server_id IS NOT NULL`);
    const mBefore = await db.query(`SELECT COUNT(*) AS n FROM meals WHERE sync_status = 'pending' AND server_id IS NOT NULL`);
    await db.run(`UPDATE foods SET sync_status = 'synced' WHERE sync_status = 'pending' AND server_id IS NOT NULL`);
    await db.run(`UPDATE meals SET sync_status = 'synced' WHERE sync_status = 'pending' AND server_id IS NOT NULL`);
    const fc = (fBefore?.values || [])[0]?.n ?? 0;
    const mc = (mBefore?.values || [])[0]?.n ?? 0;
    console.log(`[db-native] sync_status heal: cleared ${fc} foods + ${mc} meals from falsely-pending state`);
  } catch (e) {
    console.warn('[db-native] sync_status heal failed:', e?.message);
  }

  // Cleanup for the removed food_server_id diary heal: if the heal flag
  // is set ('done'), an earlier build of this app marked diary rows
  // sync_status='pending' with stale items[] when backfilling
  // food_server_id. Those rows would push back to the server on the
  // next sync and clobber any newer additions made on PWA / other
  // clients. Clear the pending state on synced diary rows ONCE.
  // Subsequent boots skip this so genuine offline diary edits still
  // push normally. Local-only rows (no server_id) are left pending so
  // they still push on first sync.
  try {
    const healFlag = await db.query(`SELECT value FROM sync_meta WHERE key = 'diary_food_server_id_v1'`);
    const healDone = (healFlag?.values || [])[0]?.value === 'done';
    const cleanupFlag = await db.query(`SELECT value FROM sync_meta WHERE key = 'diary_pending_cleanup_v1'`);
    const cleanupDone = (cleanupFlag?.values || [])[0]?.value === 'done';
    if (healDone && !cleanupDone) {
      const before = await db.query(`SELECT COUNT(*) AS n FROM diary WHERE sync_status = 'pending' AND server_id IS NOT NULL`);
      await db.run(`UPDATE diary SET sync_status = 'synced' WHERE sync_status = 'pending' AND server_id IS NOT NULL`);
      const dc = (before?.values || [])[0]?.n ?? 0;
      console.log(`[db-native] diary pending cleanup: cleared ${dc} rows left over from removed food_server_id heal`);
    }
    await db.run(
      `INSERT OR REPLACE INTO sync_meta (key, value) VALUES ('diary_pending_cleanup_v1', 'done')`
    );
  } catch (e) {
    console.warn('[db-native] diary pending cleanup failed:', e?.message);
  }

  // Sodium ↔ salt backfill: server-side backfill doesn't bump updated_at, so
  // differential sync never propagates the corrected nutrition to local cache.
  // Run the same idempotent pass against local rows so existing foods/meals
  // get the missing field filled via the regulatory factor.
  try {
    const f = await _backfillSodiumSalt(db, 'foods');
    const m = await _backfillSodiumSalt(db, 'meals');
    if (f + m > 0) console.log(`[db-native] backfilled sodium/salt on ${f} foods + ${m} meals`);
  } catch (e) {
    console.debug('[db-native] sodium/salt backfill skipped:', e?.message);
  }
}

// Mirror of server/db.js _backfillSodiumSalt. Fills the missing field via
// sodium_mg = salt_g × 400; salt_g = sodium_mg / 400, and sets _derived so the
// food editor renders the calculator icon. Skips rows that have both, neither,
// or are already marked derived. Does NOT bump updated_at — we don't want
// these locally-corrected rows to push back as edits during the next sync.
async function _backfillSodiumSalt(db, table) {
  let changed = 0;
  const r = await db.query(`SELECT id, nutrition FROM ${table} WHERE nutrition IS NOT NULL AND nutrition != '{}' AND deleted_at IS NULL`);
  const rows = r?.values || [];
  for (const row of rows) {
    let nutrition;
    try { nutrition = JSON.parse(row.nutrition || '{}'); } catch { continue; }
    if (!nutrition || typeof nutrition !== 'object') continue;
    if (nutrition._derived && (nutrition._derived.sodium || nutrition._derived.salt)) continue;
    const hasSodium = nutrition.sodium != null && Number(nutrition.sodium) > 0;
    const hasSalt   = nutrition.salt   != null && Number(nutrition.salt)   > 0;
    if (hasSodium === hasSalt) continue;
    if (hasSodium && !hasSalt) {
      nutrition.salt = Math.round((Number(nutrition.sodium) / 400) * 1000) / 1000;
      nutrition._derived = { ...(nutrition._derived || {}), salt: true };
    } else {
      nutrition.sodium = Math.round(Number(nutrition.salt) * 400 * 10) / 10;
      nutrition._derived = { ...(nutrition._derived || {}), sodium: true };
    }
    await db.run(`UPDATE ${table} SET nutrition = ? WHERE id = ?`, [JSON.stringify(nutrition), row.id]);
    changed++;
  }
  return changed;
}

async function _closeAny() {
  await sqlite.checkConnectionsConsistency().catch(() => {});
  try { await sqlite.closeConnection(DB_NAME, true);  } catch {}
  try { await sqlite.closeConnection(DB_NAME, false); } catch {}
}

async function _openUnencrypted() {
  await _closeAny();
  const db = await sqlite.createConnection(DB_NAME, false, 'no-encryption', DB_VERSION, false);
  await db.open();
  await _applySchema(db);
  return db;
}

async function _open() {
  console.log('[db-native] Opening SQLite database...');
  try {
    // Always clear any leftover encryption state from prior installs (v0.39.20–22)
    // — these are no-ops on devices that never ran those versions.
    try { await CapacitorSQLite.clearEncryptionSecret(); } catch {}
    localStorage.removeItem('nt:db_encrypted');
    localStorage.removeItem('nt:db_secret');
    localStorage.removeItem('nt:db_encryption_pending');

    // Try to open the existing DB. If it succeeds, we're done. If it fails
    // (most commonly SQLITE_NOTADB from a leftover encrypted file we can't
    // decrypt without the prior plugin's secret), wipe the file and recreate.
    try {
      const db = await _openUnencrypted();
      console.log('[db-native] SQLite ready');
      return db;
    } catch (firstErr) {
      console.warn('[db-native] First open failed — wiping and retrying:', firstErr?.message);
      await _closeAny();
      try { await sqlite.deleteDatabase(DB_NAME); } catch (e) {
        console.warn('[db-native] sqlite.deleteDatabase failed:', e?.message);
      }
      // Belt-and-suspenders: also try Capacitor Filesystem to hard-delete the
      // file in case the plugin's deleteDatabase silently no-op'd.
      try {
        const { Filesystem, Directory } = await import('@capacitor/filesystem');
        await Filesystem.deleteFile({
          path: `databases/${DB_NAME}SQLite.db`,
          directory: Directory.Data,
        });
      } catch {}
      const db = await _openUnencrypted();
      console.log('[db-native] SQLite ready (after wipe — server sync will repopulate)');
      return db;
    }
  } catch (e) {
    console.error('[db-native] Failed to open SQLite database:', e);
    throw e;
  }
}

export async function getDb() {
  if (_db) return _db;
  if (!_initPromise) _initPromise = _open().then(db => { _db = db; return db; });
  return _initPromise;
}

// ── Helpers ───────────────────────────────────────────────────────────────

function _row(result) {
  return result?.values?.[0] ?? null;
}

function _rows(result) {
  return result?.values ?? [];
}

function _now() {
  return new Date().toISOString();
}

// ── Foods ─────────────────────────────────────────────────────────────────

export async function dbGetFoods() {
  const db = await getDb();
  const r = await db.query(
    `SELECT * FROM foods WHERE user_id = ? AND visibility = 'private' AND deleted_at IS NULL ORDER BY created_at DESC`,
    [LOCAL_USER_ID]
  );
  return _rows(r).map(_parseFoodRow);
}

export async function dbGetFood(id) {
  const db = await getDb();
  const r = await db.query(`SELECT * FROM foods WHERE id = ? AND user_id = ?`, [id, LOCAL_USER_ID]);
  const row = _row(r);
  return row ? _parseFoodRow(row) : null;
}

export async function dbCreateFood(data) {
  const db = await getDb();
  const r = await db.run(
    `INSERT INTO foods (user_id, name, brand, nutrition, portion, unit, img_url, notes, category, barcode, updated_at, sync_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
    [
      LOCAL_USER_ID,
      data.name,
      data.brand || null,
      JSON.stringify(data.nutrition || {}),
      data.portion ?? 100,
      data.unit || 'g',
      data.img_url || data.imgUrl || null,
      data.notes || null,
      data.category || null,
      data.barcode || null,
      _now(),
    ]
  );
  return dbGetFood(r.changes?.lastId);
}

export async function dbUpdateFood(id, data) {
  const db = await getDb();
  await db.run(
    `UPDATE foods SET name=?, brand=?, nutrition=?, portion=?, unit=?, img_url=?, notes=?, category=?, barcode=?, updated_at=?, sync_status='pending'
     WHERE id=? AND user_id=?`,
    [
      data.name,
      data.brand || null,
      JSON.stringify(data.nutrition || {}),
      data.portion ?? 100,
      data.unit || 'g',
      data.img_url || data.imgUrl || null,
      data.notes || null,
      data.category || null,
      data.barcode || null,
      _now(),
      id,
      LOCAL_USER_ID,
    ]
  );
  return dbGetFood(id);
}

export async function dbDeleteFood(id) {
  const db = await getDb();
  await db.run(`UPDATE foods SET deleted_at = datetime('now'), updated_at = datetime('now'), sync_status = 'pending' WHERE id = ? AND user_id = ?`, [id, LOCAL_USER_ID]);
}

// Bump usage counter on a food and lift last_used_at to the supplied date
// (or today if missing). Uses MAX so out-of-order syncs don't roll back the
// most-recent-use date. Mirror of server's POST /:id/used logic.
//
// IMPORTANT: does NOT touch updated_at or sync_status. The counter is a
// derived field; pushing the full row through differential sync would
// clobber server-authoritative columns (img_url, name, etc.) with whatever
// the local cache happened to have. The HTTP /:id/used endpoint handles
// the server-side bump independently. If the device is offline, the bump
// is local-only — acceptable trade-off for derived counter data.
export async function dbBumpFoodUsage(id, date) {
  const d = (date && /^\d{4}-\d{2}-\d{2}$/.test(date))
    ? date
    : new Date().toISOString().slice(0, 10);
  const db = await getDb();
  await db.run(
    `UPDATE foods SET usage_count = usage_count + 1, last_used_at = MAX(COALESCE(last_used_at, ''), ?) WHERE id = ?`,
    [d, id]
  );
}

export async function dbCopyFood(id) {
  const original = await dbGetFood(id);
  if (!original) throw new Error('Food not found');
  const { id: _id, created_at: _ca, ...rest } = original;
  return dbCreateFood({ ...rest, name: original.name + ' (copy)' });
}

function _parseFoodRow(row) {
  return {
    ...row,
    nutrition: _parseJson(row.nutrition, {}),
    imgUrl: row.img_url || '',
    categories: row.category ? [row.category] : [],
  };
}

// ── Meals ─────────────────────────────────────────────────────────────────

export async function dbGetMeals(recipesOnly = false) {
  const db = await getDb();
  const r = await db.query(
    `SELECT * FROM meals WHERE user_id = ? AND is_recipe = ? AND deleted_at IS NULL ORDER BY created_at DESC`,
    [LOCAL_USER_ID, recipesOnly ? 1 : 0]
  );
  return _rows(r).map(_parseMealRow);
}

export async function dbGetMeal(id) {
  const db = await getDb();
  const r = await db.query(`SELECT * FROM meals WHERE id = ? AND user_id = ?`, [id, LOCAL_USER_ID]);
  const row = _row(r);
  return row ? _parseMealRow(row) : null;
}

export async function dbCreateMeal(data) {
  const db = await getDb();
  const r = await db.run(
    `INSERT INTO meals (user_id, name, nutrition, items, img_url, notes, is_recipe, portion, unit, servings, updated_at, sync_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
    [
      LOCAL_USER_ID,
      data.name,
      JSON.stringify(data.nutrition || {}),
      JSON.stringify(data.items || []),
      data.img_url || data.imgUrl || null,
      data.notes || null,
      data.is_recipe ? 1 : 0,
      data.portion ?? 100,
      data.unit || 'g',
      data.servings != null ? Math.max(1, parseInt(data.servings) || 1) : null,
      _now(),
    ]
  );
  return dbGetMeal(r.changes?.lastId);
}

export async function dbUpdateMeal(id, data) {
  const db = await getDb();
  await db.run(
    `UPDATE meals SET name=?, nutrition=?, items=?, img_url=?, notes=?, is_recipe=?, portion=?, unit=?, servings=?, updated_at=?, sync_status='pending'
     WHERE id=? AND user_id=?`,
    [
      data.name,
      JSON.stringify(data.nutrition || {}),
      JSON.stringify(data.items || []),
      data.img_url || data.imgUrl || null,
      data.notes || null,
      data.is_recipe ? 1 : 0,
      data.portion ?? 100,
      data.unit || 'g',
      data.servings != null ? Math.max(1, parseInt(data.servings) || 1) : null,
      _now(),
      id,
      LOCAL_USER_ID,
    ]
  );
  return dbGetMeal(id);
}

export async function dbDeleteMeal(id) {
  const db = await getDb();
  await db.run(`UPDATE meals SET deleted_at = datetime('now'), updated_at = datetime('now'), sync_status = 'pending' WHERE id = ? AND user_id = ?`, [id, LOCAL_USER_ID]);
}

// Mirror of dbBumpFoodUsage but on the meals table. Same rule:
// no updated_at / sync_status changes — keep this strictly local so the
// next differential push doesn't clobber server-authoritative columns.
export async function dbBumpMealUsage(id, date) {
  const d = (date && /^\d{4}-\d{2}-\d{2}$/.test(date))
    ? date
    : new Date().toISOString().slice(0, 10);
  const db = await getDb();
  await db.run(
    `UPDATE meals SET usage_count = usage_count + 1, last_used_at = MAX(COALESCE(last_used_at, ''), ?) WHERE id = ?`,
    [d, id]
  );
}

export async function dbCopyMeal(id) {
  const original = await dbGetMeal(id);
  if (!original) throw new Error('Meal not found');
  const { id: _id, created_at: _ca, ...rest } = original;
  return dbCreateMeal({ ...rest, name: original.name + ' (copy)' });
}

function _parseMealRow(row) {
  return {
    ...row,
    nutrition: _parseJson(row.nutrition, {}),
    items:     _parseJson(row.items, []),
    imgUrl: row.img_url || '',
  };
}

// ── Diary ─────────────────────────────────────────────────────────────────

// Mirror of server-side freshenItemImages (server/lib/diary-helpers.js).
//
// IMPORTANT: this LIVE-RESOLVES every diary item's imgUrl from the local
// foods + meals tables on every diary read — it does NOT trust the
// snapshot stored on the diary item. See server/lib/diary-helpers.js for
// the full reasoning. Do not revert.
//
// Routing: items with is_recipe truthy resolve against meals only,
// everything else resolves against foods only. Within each pool, lookup
// order is id+name → name+brand (foods only) → name only → ''.
const _norm = s => String(s || '').trim().toLowerCase();
async function _freshenItemImages(items) {
  if (!Array.isArray(items) || !items.length) return items;
  try {
    const db = await getDb();
    const fr = await db.query(
      `SELECT id, name, brand, img_url FROM foods WHERE deleted_at IS NULL AND img_url IS NOT NULL AND img_url != '' ORDER BY id ASC`
    );
    const mr = await db.query(
      `SELECT id, name, img_url FROM meals WHERE deleted_at IS NULL AND img_url IS NOT NULL AND img_url != '' ORDER BY id ASC`
    );
    const foods = _rows(fr);
    const meals = _rows(mr);
    const foodByIdName = new Map();
    const foodByNameBrand = new Map();
    const foodByName = new Map();
    for (const r of foods) {
      foodByIdName.set(`${r.id}|${_norm(r.name)}`, r.img_url);
      foodByNameBrand.set(`${_norm(r.name)}|${_norm(r.brand)}`, r.img_url);
      if (!foodByName.has(_norm(r.name))) foodByName.set(_norm(r.name), r.img_url);
    }
    const mealByIdName = new Map();
    const mealByName = new Map();
    for (const r of meals) {
      mealByIdName.set(`${r.id}|${_norm(r.name)}`, r.img_url);
      if (!mealByName.has(_norm(r.name))) mealByName.set(_norm(r.name), r.img_url);
    }
    return items.map(it => {
      const name = _norm(it.name);
      const brand = _norm(it.brand);
      const idKey = `${it.id}|${name}`;
      let live;
      if (it.is_recipe) {
        live = mealByIdName.get(idKey) || mealByName.get(name) || '';
      } else {
        live = foodByIdName.get(idKey)
          || foodByNameBrand.get(`${name}|${brand}`)
          || foodByName.get(name)
          || '';
      }
      return { ...it, imgUrl: live };
    });
  } catch {
    return items;
  }
}

export async function dbGetDiaryDate(date) {
  const db = await getDb();
  const r = await db.query(
    `SELECT * FROM diary WHERE date = ? AND user_id = ?`,
    [date, LOCAL_USER_ID]
  );
  const row = _row(r);
  if (!row) return null;
  const items = await _freshenItemImages(_parseJson(row.items, []));
  return {
    ...row,
    items,
    body_stats: _parseJson(row.body_stats, {}),
    water:      _parseJson(row.water, []),
    notes:      row.notes || '',
  };
}

export async function dbSaveDiaryDate(date, data) {
  const db = await getDb();
  const items      = JSON.stringify(data.items || []);
  const body_stats = JSON.stringify(data.body_stats || {});
  const water      = JSON.stringify(data.water || []);
  const notes      = (typeof data.notes === 'string' && data.notes.trim()) ? data.notes : null;
  await db.run(
    `INSERT INTO diary (user_id, date, items, body_stats, water, notes, updated_at, sync_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
     ON CONFLICT(date, user_id) DO UPDATE SET
       items=excluded.items, body_stats=excluded.body_stats, water=excluded.water,
       notes=excluded.notes, updated_at=excluded.updated_at, sync_status='pending'`,
    [LOCAL_USER_ID, date, items, body_stats, water, notes, _now()]
  );
  return dbGetDiaryDate(date);
}

export async function dbGetAllDiary() {
  const db = await getDb();
  const r = await db.query(
    `SELECT * FROM diary WHERE user_id = ? ORDER BY date DESC`,
    [LOCAL_USER_ID]
  );
  const rawRows = _rows(r);
  // Freshen item images per-row in parallel. Each call is a single SELECT
  // against the local foods table; in practice the rows for a typical user
  // (≤90 days) finish in a few ms.
  return Promise.all(rawRows.map(async row => ({
    ...row,
    items:      await _freshenItemImages(_parseJson(row.items, [])),
    body_stats: _parseJson(row.body_stats, {}),
    water:      _parseJson(row.water, []),
    notes:      row.notes || '',
  })));
}

// ── Wellness data ─────────────────────────────────────────────────────────

export async function dbGetWellness(startDate, endDate, source = null) {
  const db = await getDb();
  let sql = `SELECT * FROM wellness_data WHERE user_id = ? AND date >= ? AND date <= ?`;
  const params = [LOCAL_USER_ID, startDate, endDate];
  if (source) { sql += ` AND source = ?`; params.push(source); }
  const r = await db.query(sql, params);
  return _rows(r).map(row => ({ ...row, metadata: _parseJson(row.metadata, {}) }));
}

export async function dbUpsertWellness(date, source, metric_type, value, metadata = {}) {
  const db = await getDb();
  // CRITICAL: ON CONFLICT must reset sync_status to 'pending' so updated
  // values get re-pushed to the server. Without this, a re-read from Health
  // Connect (e.g. steps went 500 -> 1382 later in the day) would update the
  // local value but leave sync_status='synced' from the prior push, so
  // dbGetPendingChanges would skip the row and the server stays stale.
  await db.run(
    `INSERT INTO wellness_data (user_id, date, source, metric_type, value, metadata)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, date, source, metric_type) DO UPDATE SET
       value=excluded.value, metadata=excluded.metadata,
       synced_at=datetime('now'), sync_status='pending'`,
    [LOCAL_USER_ID, date, source, metric_type, value, JSON.stringify(metadata)]
  );
}

// ── Sync helpers ─────────────────────────────────────────────────────────

export async function dbGetPendingChanges() {
  const db = await getDb();
  const [foods, meals, diary, activity, fasts, wellness] = await Promise.all([
    db.query(`SELECT * FROM foods WHERE sync_status = 'pending' AND user_id = ?`, [LOCAL_USER_ID]),
    db.query(`SELECT * FROM meals WHERE sync_status = 'pending' AND user_id = ?`, [LOCAL_USER_ID]),
    db.query(`SELECT * FROM diary WHERE sync_status = 'pending' AND user_id = ?`, [LOCAL_USER_ID]),
    db.query(`SELECT * FROM activity_log WHERE sync_status = 'pending' AND user_id = ?`, [LOCAL_USER_ID]),
    db.query(`SELECT * FROM fasts WHERE sync_status = 'pending' AND user_id = ?`, [LOCAL_USER_ID]),
    // Health Connect (and any other native-only wellness source) needs to be
    // pushed up to the server so the web app + other clients can render it.
    // Server-sourced rows (Fitbit/Garmin/Withings) come back from pull with
    // sync_status='synced' and are excluded here.
    db.query(`SELECT * FROM wellness_data WHERE sync_status = 'pending' AND user_id = ?`, [LOCAL_USER_ID]),
  ]);
  return {
    foods: _rows(foods).map(_parseFoodRow),
    meals: _rows(meals).map(_parseMealRow),
    diary: _rows(diary).map(row => ({
      ...row,
      items:      _parseJson(row.items, []),
      body_stats: _parseJson(row.body_stats, {}),
      water:      _parseJson(row.water, []),
      notes:      row.notes || '',
    })),
    activity: _rows(activity),
    fasts: _rows(fasts),
    wellness: _rows(wellness).map(row => ({
      ...row,
      metadata: _parseJson(row.metadata, {}),
    })),
  };
}

export async function dbMarkSynced(table, ids) {
  if (!ids.length) return;
  const db = await getDb();
  const placeholders = ids.map(() => '?').join(',');
  await db.run(
    `UPDATE ${table} SET sync_status = 'synced' WHERE id IN (${placeholders})`,
    ids
  );
}

// ── Sync meta ─────────────────────────────────────────────────────────────

export async function dbGetSyncMeta(key) {
  const db = await getDb();
  const r = await db.query(`SELECT value FROM sync_meta WHERE key = ?`, [key]);
  const row = _row(r);
  return row?.value || null;
}

export async function dbSetSyncMeta(key, value) {
  const db = await getDb();
  await db.run(
    `INSERT INTO sync_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, value]
  );
}

// Update server_id after push
export async function dbSetServerId(table, localId, serverId) {
  const db = await getDb();
  await db.run(`UPDATE ${table} SET server_id = ? WHERE id = ?`, [serverId, localId]);
}

// Hard-delete soft-deleted records that have been confirmed pushed to server
export async function dbPurgeSoftDeleted(table) {
  const db = await getDb();
  await db.run(`DELETE FROM ${table} WHERE deleted_at IS NOT NULL AND sync_status = 'synced'`);
}

// Upsert a record from server pull (by server_id)
export async function dbUpsertFromServer(table, serverRecord) {
  const db = await getDb();
  const { id: serverId, deleted_at, ...data } = serverRecord;

  if (deleted_at) {
    // Server soft-deleted — hard delete locally
    await db.run(`DELETE FROM ${table} WHERE server_id = ?`, [serverId]);
    return;
  }

  // Check if we have this server record locally
  const existing = await db.query(`SELECT id, sync_status FROM ${table} WHERE server_id = ?`, [serverId]);
  const local = _row(existing);

  if (local) {
    // Don't overwrite local pending changes (client wins during active editing)
    if (local.sync_status === 'pending') return;

    // usage_count + last_used_at use MAX semantics to mirror the server's
    // /api/sync/push merge. Without this, server-side bumps never propagate
    // into local sort keys, and "Most Used" / "Recently Used" on Android
    // rank by stale local-only counters.
    if (table === 'foods') {
      await db.run(
        `UPDATE foods SET name=?, brand=?, nutrition=?, portion=?, unit=?, img_url=?, notes=?, category=?, barcode=?, favorite=?, usage_count=MAX(usage_count, ?), last_used_at=MAX(COALESCE(last_used_at, ''), COALESCE(?, '')), updated_at=?, sync_status='synced' WHERE server_id=?`,
        [data.name, data.brand, typeof data.nutrition === 'string' ? data.nutrition : JSON.stringify(data.nutrition || {}),
         data.portion ?? 100, data.unit || 'g', data.img_url, data.notes, data.category, data.barcode,
         data.favorite ? 1 : 0, data.usage_count || 0, data.last_used_at || null,
         data.updated_at, serverId]
      );
    } else if (table === 'meals') {
      await db.run(
        `UPDATE meals SET name=?, nutrition=?, items=?, img_url=?, notes=?, is_recipe=?, portion=?, unit=?, servings=?, favorite=?, usage_count=MAX(usage_count, ?), last_used_at=MAX(COALESCE(last_used_at, ''), COALESCE(?, '')), updated_at=?, sync_status='synced' WHERE server_id=?`,
        [data.name, typeof data.nutrition === 'string' ? data.nutrition : JSON.stringify(data.nutrition || {}),
         typeof data.items === 'string' ? data.items : JSON.stringify(data.items || []),
         data.img_url, data.notes, data.is_recipe ? 1 : 0, data.portion ?? 100, data.unit || 'g',
         data.servings != null ? Math.max(1, parseInt(data.servings) || 1) : null,
         data.favorite ? 1 : 0, data.usage_count || 0, data.last_used_at || null,
         data.updated_at, serverId]
      );
    }
  } else {
    // New from server — insert locally
    if (table === 'foods') {
      await db.run(
        `INSERT INTO foods (server_id, user_id, name, brand, nutrition, portion, unit, img_url, notes, category, barcode, favorite, usage_count, last_used_at, updated_at, sync_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced')`,
        [serverId, LOCAL_USER_ID, data.name, data.brand, typeof data.nutrition === 'string' ? data.nutrition : JSON.stringify(data.nutrition || {}),
         data.portion ?? 100, data.unit || 'g', data.img_url, data.notes, data.category, data.barcode,
         data.favorite ? 1 : 0, data.usage_count || 0, data.last_used_at || null, data.updated_at]
      );
    } else if (table === 'meals') {
      await db.run(
        `INSERT INTO meals (server_id, user_id, name, nutrition, items, img_url, notes, is_recipe, portion, unit, servings, favorite, usage_count, last_used_at, updated_at, sync_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced')`,
        [serverId, LOCAL_USER_ID, data.name, typeof data.nutrition === 'string' ? data.nutrition : JSON.stringify(data.nutrition || {}),
         typeof data.items === 'string' ? data.items : JSON.stringify(data.items || []),
         data.img_url, data.notes, data.is_recipe ? 1 : 0, data.portion ?? 100, data.unit || 'g',
         data.servings != null ? Math.max(1, parseInt(data.servings) || 1) : null,
         data.favorite ? 1 : 0, data.usage_count || 0, data.last_used_at || null, data.updated_at]
      );
    }
  }
}

// Upsert diary from server pull (keyed by date)
export async function dbUpsertDiaryFromServer(serverRecord) {
  const db = await getDb();
  const { id: serverId, deleted_at, date, items, body_stats, water, notes, updated_at } = serverRecord;

  if (deleted_at) {
    await db.run(`DELETE FROM diary WHERE server_id = ? OR date = ?`, [serverId, date]);
    return;
  }

  const existing = await db.query(`SELECT id, sync_status FROM diary WHERE date = ? AND user_id = ?`, [date, LOCAL_USER_ID]);
  const local = _row(existing);

  // If local has pending changes AND is newer than server, skip (local wins)
  // Otherwise server wins — update local
  if (local && local.sync_status === 'pending') {
    const localRow = await db.query(`SELECT updated_at FROM diary WHERE id = ?`, [local.id]);
    const localUpdated = _row(localRow)?.updated_at || '';
    const serverUpdated = (updated_at || '').replace('T', ' ').replace('Z', '').replace(/\.\d+$/, '');
    if (localUpdated > serverUpdated) return; // local is newer, keep it
  }

  await db.run(
    `INSERT INTO diary (server_id, user_id, date, items, body_stats, water, notes, updated_at, sync_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'synced')
     ON CONFLICT(date, user_id) DO UPDATE SET
       server_id=excluded.server_id, items=excluded.items, body_stats=excluded.body_stats,
       water=excluded.water, notes=excluded.notes, updated_at=excluded.updated_at, sync_status='synced'`,
    [serverId, LOCAL_USER_ID, date,
     typeof items === 'string' ? items : JSON.stringify(items || []),
     typeof body_stats === 'string' ? body_stats : JSON.stringify(body_stats || {}),
     typeof water === 'string' ? water : JSON.stringify(water || []),
     (typeof notes === 'string' && notes.trim()) ? notes : null,
     updated_at]
  );
}

// Upsert wellness data from server pull
export async function dbUpsertWellnessFromServer(record) {
  const db = await getDb();
  // sync_status='synced' on server-sourced rows is critical: without it the
  // pull writes a 'pending' row that gets pushed back to the server on the
  // next cycle, causing an infinite push-pull loop.
  await db.run(
    `INSERT INTO wellness_data (user_id, date, source, metric_type, value, metadata, synced_at, sync_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'synced')
     ON CONFLICT(user_id, date, source, metric_type) DO UPDATE SET
       value=excluded.value, metadata=excluded.metadata, synced_at=excluded.synced_at, sync_status='synced'`,
    [LOCAL_USER_ID, record.date, record.source, record.metric_type, record.value,
     typeof record.metadata === 'string' ? record.metadata : JSON.stringify(record.metadata || {}),
     record.synced_at]
  );
}

// ── Workouts ─────────────────────────────────────────────────────────

export async function dbGetWorkouts(from, to) {
  const db = await getDb();
  const r = await db.query(
    `SELECT * FROM workouts WHERE user_id = ? AND date >= ? AND date <= ? ORDER BY date DESC, start_time DESC`,
    [LOCAL_USER_ID, from, to]
  );
  return _rows(r).map(row => ({ ...row, gps_data: _parseJson(row.gps_data, null), has_gps: !!row.has_gps }));
}

export async function dbGetWorkout(id) {
  const db = await getDb();
  const r = await db.query(`SELECT * FROM workouts WHERE id = ? AND user_id = ?`, [id, LOCAL_USER_ID]);
  const row = _row(r);
  if (!row) return null;
  return { ...row, gps_data: _parseJson(row.gps_data, null), has_gps: !!row.has_gps };
}

export async function dbUpsertWorkoutFromServer(record) {
  const db = await getDb();
  const { id: serverId, deleted_at, gps_data, ...data } = record;

  if (deleted_at) {
    await db.run(`DELETE FROM workouts WHERE server_id = ?`, [serverId]);
    return;
  }

  await db.run(
    `INSERT INTO workouts (server_id, user_id, source, source_id, date, activity_type, activity_name, start_time, duration_ms, distance_km, calories, avg_hr, max_hr, steps, has_gps, gps_data, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, source, source_id) DO UPDATE SET
       server_id=excluded.server_id, activity_type=excluded.activity_type, activity_name=excluded.activity_name,
       start_time=excluded.start_time, duration_ms=excluded.duration_ms, distance_km=excluded.distance_km,
       calories=excluded.calories, avg_hr=excluded.avg_hr, max_hr=excluded.max_hr, steps=excluded.steps,
       has_gps=excluded.has_gps, gps_data=COALESCE(excluded.gps_data, workouts.gps_data), updated_at=excluded.updated_at`,
    [serverId, LOCAL_USER_ID, data.source, data.source_id, data.date, data.activity_type, data.activity_name,
     data.start_time, data.duration_ms, data.distance_km, data.calories, data.avg_hr, data.max_hr, data.steps,
     data.has_gps ? 1 : 0, gps_data ? (typeof gps_data === 'string' ? gps_data : JSON.stringify(gps_data)) : null,
     data.updated_at]
  );
}

/**
 * Get wellness data grouped by date, matching server API shape:
 * { [date]: { [metric_type]: value } }
 * @param {string} from - start date (YYYY-MM-DD)
 * @param {string} to - end date (YYYY-MM-DD)
 * @param {string|null} source - filter by source (e.g. 'fitbit', 'garmin', 'health_connect'), null = all
 */
export async function dbGetWellnessGrouped(from, to, source = null) {
  const db = await getDb();
  let sql = `SELECT date, metric_type, value FROM wellness_data WHERE user_id = ? AND date >= ? AND date <= ?`;
  const params = [LOCAL_USER_ID, from, to];
  if (source) { sql += ` AND source = ?`; params.push(source); }
  sql += ` ORDER BY date`;
  const r = await db.query(sql, params);
  const byDate = {};
  for (const row of _rows(r)) {
    byDate[row.date] ??= {};
    byDate[row.date][row.metric_type] = row.value;
  }
  return byDate;
}

/**
 * Get wellness data for a single date, matching server API shape:
 * { [date]: { [metric_type]: value } }
 */
export async function dbGetWellnessByDate(date, source = null) {
  return dbGetWellnessGrouped(date, date, source);
}

// ── Settings sync ────────────────────────────────────────────────────

export async function dbGetPendingSettings() {
  const db = await getDb();
  const r = await db.query(
    `SELECT * FROM user_settings WHERE sync_status = 'pending' AND user_id = ?`,
    [LOCAL_USER_ID]
  );
  return _rows(r);
}

export async function dbMarkSettingsSynced(keys) {
  if (!keys.length) return;
  const db = await getDb();
  for (const key of keys) {
    await db.run(
      `UPDATE user_settings SET sync_status = 'synced' WHERE key = ? AND user_id = ?`,
      [key, LOCAL_USER_ID]
    );
  }
}

export async function dbUpsertSetting(key, value) {
  const db = await getDb();
  await db.run(
    `INSERT INTO user_settings (user_id, key, value, updated_at, sync_status)
     VALUES (?, ?, ?, ?, 'pending')
     ON CONFLICT(user_id, key) DO UPDATE SET
       value=excluded.value, updated_at=excluded.updated_at, sync_status='pending'`,
    [LOCAL_USER_ID, key, JSON.stringify(value), _now()]
  );
}

export async function dbUpsertSettingFromServer(record) {
  const db = await getDb();
  const { key, value, updated_at, deleted_at } = record;

  if (deleted_at) {
    await db.run(
      `DELETE FROM user_settings WHERE key = ? AND user_id = ?`,
      [key, LOCAL_USER_ID]
    );
    return;
  }

  // Don't overwrite pending local changes
  const existing = await db.query(
    `SELECT sync_status FROM user_settings WHERE key = ? AND user_id = ?`,
    [key, LOCAL_USER_ID]
  );
  const local = _row(existing);
  if (local && local.sync_status === 'pending') return;

  await db.run(
    `INSERT INTO user_settings (user_id, key, value, updated_at, sync_status)
     VALUES (?, ?, ?, ?, 'synced')
     ON CONFLICT(user_id, key) DO UPDATE SET
       value=excluded.value, updated_at=excluded.updated_at, sync_status='synced'`,
    [LOCAL_USER_ID, key, typeof value === 'string' ? value : JSON.stringify(value), updated_at]
  );
}

// Apply a server-pushed activity_log row to the local mirror.
export async function dbUpsertActivityFromServer(record) {
  const db = await getDb();
  const { id: serverId, deleted_at } = record;
  if (deleted_at) {
    await db.run(`DELETE FROM activity_log WHERE server_id = ?`, [serverId]);
    return;
  }
  // Match by server_id; if absent (first-pull), insert new
  const existing = await db.query(`SELECT id FROM activity_log WHERE server_id = ? AND user_id = ?`, [serverId, LOCAL_USER_ID]);
  const row = _row(existing);
  if (row) {
    await db.run(
      `UPDATE activity_log SET date=?, name=?, kcal=?, duration_min=?, distance=?, source=?, updated_at=?, sync_status='synced'
        WHERE id=?`,
      [record.date, record.name, record.kcal, record.duration_min, record.distance, record.source, record.updated_at, row.id]
    );
  } else {
    await db.run(
      `INSERT INTO activity_log (server_id, user_id, date, name, kcal, duration_min, distance, source, created_at, updated_at, sync_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced')`,
      [serverId, LOCAL_USER_ID, record.date, record.name, record.kcal,
       record.duration_min, record.distance, record.source,
       record.created_at || record.updated_at, record.updated_at]
    );
  }
}

// ── Activity (manual exercise calorie offset) ─────────────────────────────

export async function dbGetActivity(date) {
  const db = await getDb();
  const r = await db.query(
    `SELECT * FROM activity_log
      WHERE user_id = ? AND date = ? AND deleted_at IS NULL
      ORDER BY id ASC`,
    [LOCAL_USER_ID, date]
  );
  return r?.values || [];
}

export async function dbGetActivityRange(from, to) {
  const db = await getDb();
  const r = await db.query(
    `SELECT * FROM activity_log
      WHERE user_id = ? AND date BETWEEN ? AND ? AND deleted_at IS NULL
      ORDER BY date ASC, id ASC`,
    [LOCAL_USER_ID, from, to]
  );
  return r?.values || [];
}

// Read wearable active_calories from local wellness_data (Health Connect on native).
// Highest single-source value to avoid double-counting when multiple sources exist.
export async function dbWearableActiveCalories(date) {
  const db = await getDb();
  const r = await db.query(
    `SELECT MAX(value) AS v FROM wellness_data
      WHERE user_id = ? AND date = ? AND metric_type = 'active_calories'`,
    [LOCAL_USER_ID, date]
  );
  const row = _row(r);
  return row?.v != null ? Math.max(0, Math.round(row.v)) : 0;
}

export async function dbSumActivity(date) {
  const db = await getDb();
  const r = await db.query(
    `SELECT COALESCE(SUM(kcal), 0) AS s FROM activity_log
      WHERE user_id = ? AND date = ? AND deleted_at IS NULL`,
    [LOCAL_USER_ID, date]
  );
  const row = _row(r);
  return Math.max(0, Math.round(row?.s || 0));
}

export async function dbCreateActivity(data) {
  const db = await getDb();
  const now = new Date().toISOString();
  await db.run(
    `INSERT INTO activity_log (user_id, date, name, kcal, duration_min, distance, source, created_at, updated_at, sync_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
    [
      LOCAL_USER_ID,
      data.date,
      String(data.name || '').slice(0, 80),
      Math.max(0, Math.round(Number(data.kcal) || 0)),
      data.duration_min != null ? Math.max(0, Math.round(Number(data.duration_min))) : null,
      data.distance != null ? String(data.distance).slice(0, 40) : null,
      data.source || 'manual_form',
      now,
      now,
    ]
  );
  const r = await db.query(`SELECT * FROM activity_log WHERE id = last_insert_rowid()`);
  return _row(r);
}

export async function dbUpdateActivity(id, data) {
  const db = await getDb();
  const existing = await db.query(`SELECT * FROM activity_log WHERE id = ? AND user_id = ?`, [id, LOCAL_USER_ID]);
  const row = _row(existing);
  if (!row) return null;
  const merged = { ...row, ...data };
  const now = new Date().toISOString();
  await db.run(
    `UPDATE activity_log
        SET name = ?, kcal = ?, duration_min = ?, distance = ?, source = ?, updated_at = ?, sync_status = 'pending'
      WHERE id = ?`,
    [
      String(merged.name || '').slice(0, 80),
      Math.max(0, Math.round(Number(merged.kcal) || 0)),
      merged.duration_min != null ? Math.max(0, Math.round(Number(merged.duration_min))) : null,
      merged.distance != null ? String(merged.distance).slice(0, 40) : null,
      merged.source || 'manual_form',
      now,
      id,
    ]
  );
  const r = await db.query(`SELECT * FROM activity_log WHERE id = ?`, [id]);
  return _row(r);
}

export async function dbDeleteActivity(id) {
  const db = await getDb();
  const now = new Date().toISOString();
  await db.run(
    `UPDATE activity_log SET deleted_at = ?, updated_at = ?, sync_status = 'pending' WHERE id = ? AND user_id = ?`,
    [now, now, id, LOCAL_USER_ID]
  );
}

export async function dbUpsertFastFromServer(record) {
  const db = await getDb();
  const { id: serverId, deleted_at } = record;
  if (deleted_at) {
    await db.run(`DELETE FROM fasts WHERE server_id = ?`, [serverId]);
    return;
  }
  const existing = await db.query(`SELECT id FROM fasts WHERE server_id = ? AND user_id = ?`, [serverId, LOCAL_USER_ID]);
  const row = _row(existing);
  if (row) {
    await db.run(
      `UPDATE fasts SET start_at=?, end_at=?, goal_hours=?, notes=?, updated_at=?, sync_status='synced' WHERE id=?`,
      [record.start_at, record.end_at || null, record.goal_hours, record.notes || null, record.updated_at, row.id]
    );
  } else {
    await db.run(
      `INSERT INTO fasts (server_id, user_id, start_at, end_at, goal_hours, notes, created_at, updated_at, sync_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'synced')`,
      [serverId, LOCAL_USER_ID, record.start_at, record.end_at || null,
       record.goal_hours, record.notes || null,
       record.created_at || record.updated_at, record.updated_at]
    );
  }
}

// ── Intermittent Fasting ─────────────────────────────────────────────────

function _fastRow(r) {
  if (!r) return null;
  return {
    id: r.id, server_id: r.server_id,
    user_id: r.user_id, start_at: r.start_at, end_at: r.end_at,
    goal_hours: r.goal_hours, notes: r.notes,
    created_at: r.created_at, updated_at: r.updated_at,
  };
}

export async function dbGetActiveFast() {
  const db = await getDb();
  const r = await db.query(
    `SELECT * FROM fasts WHERE user_id = ? AND end_at IS NULL AND deleted_at IS NULL ORDER BY start_at DESC LIMIT 1`,
    [LOCAL_USER_ID]
  );
  return _fastRow((r?.values || [])[0]);
}

export async function dbGetFasts(limit = 60) {
  const db = await getDb();
  const r = await db.query(
    `SELECT * FROM fasts WHERE user_id = ? AND deleted_at IS NULL ORDER BY start_at DESC LIMIT ?`,
    [LOCAL_USER_ID, limit]
  );
  return (r?.values || []).map(_fastRow);
}

export async function dbStartFast({ goal_hours = 16, start_at = null } = {}) {
  const db = await getDb();
  // Block double-start
  const active = await dbGetActiveFast();
  if (active) throw new Error('A fast is already in progress.');
  const sa = start_at || new Date().toISOString();
  const now = new Date().toISOString();
  const r = await db.run(
    `INSERT INTO fasts (user_id, start_at, goal_hours, created_at, updated_at, sync_status)
     VALUES (?, ?, ?, ?, ?, 'pending')`,
    [LOCAL_USER_ID, sa, Number(goal_hours) || 16, now, now]
  );
  const id = r?.changes?.lastId || (await db.query(`SELECT last_insert_rowid() as id`)).values?.[0]?.id;
  const row = await db.query(`SELECT * FROM fasts WHERE id = ?`, [id]);
  return _fastRow((row?.values || [])[0]);
}

export async function dbEndFast(id) {
  const db = await getDb();
  const now = new Date().toISOString();
  await db.run(
    `UPDATE fasts SET end_at = ?, updated_at = ?, sync_status = 'pending' WHERE id = ? AND user_id = ? AND end_at IS NULL`,
    [now, now, id, LOCAL_USER_ID]
  );
  const r = await db.query(`SELECT * FROM fasts WHERE id = ?`, [id]);
  return _fastRow((r?.values || [])[0]);
}

export async function dbUpdateFast(id, changes = {}) {
  const db = await getDb();
  const now = new Date().toISOString();
  const fields = [];
  const values = [];
  for (const k of ['start_at', 'end_at', 'goal_hours', 'notes']) {
    if (changes[k] !== undefined) { fields.push(`${k} = ?`); values.push(changes[k]); }
  }
  if (!fields.length) {
    const r = await db.query(`SELECT * FROM fasts WHERE id = ?`, [id]);
    return _fastRow((r?.values || [])[0]);
  }
  fields.push(`updated_at = ?`); values.push(now);
  fields.push(`sync_status = 'pending'`);
  values.push(id, LOCAL_USER_ID);
  await db.run(`UPDATE fasts SET ${fields.join(', ')} WHERE id = ? AND user_id = ?`, values);
  const r = await db.query(`SELECT * FROM fasts WHERE id = ?`, [id]);
  return _fastRow((r?.values || [])[0]);
}

export async function dbDeleteFast(id) {
  const db = await getDb();
  const now = new Date().toISOString();
  await db.run(
    `UPDATE fasts SET deleted_at = ?, updated_at = ?, sync_status = 'pending' WHERE id = ? AND user_id = ?`,
    [now, now, id, LOCAL_USER_ID]
  );
}

// ── Utilities ─────────────────────────────────────────────────────────────

function _parseJson(val, fallback) {
  if (val == null) return fallback;
  if (typeof val === 'object') return val;
  try { return JSON.parse(val); } catch { return fallback; }
}

export { LOCAL_USER_ID };
