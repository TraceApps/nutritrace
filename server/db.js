import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const dbPath = process.env.DB_PATH || './nutritrace.db';
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Core tables ────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    full_name     TEXT,
    nickname      TEXT,
    birthday      TEXT,
    gender        TEXT,
    avatar_url    TEXT,
    role          TEXT NOT NULL DEFAULT 'user',
    created_at    TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS foods (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    brand      TEXT,
    nutrition  TEXT DEFAULT '{}',
    portion    REAL DEFAULT 100,
    unit       TEXT DEFAULT 'g',
    img_url    TEXT,
    notes      TEXT,
    category   TEXT,
    barcode    TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS meals (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    nutrition  TEXT DEFAULT '{}',
    items      TEXT DEFAULT '[]',
    img_url    TEXT,
    notes      TEXT,
    is_recipe  INTEGER DEFAULT 0,
    portion    REAL DEFAULT 100,
    unit       TEXT DEFAULT 'g',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS diary (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
    date       TEXT NOT NULL,
    items      TEXT DEFAULT '[]',
    body_stats TEXT DEFAULT '{}',
    water      TEXT DEFAULT '[]',
    notes      TEXT DEFAULT NULL,
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(date, user_id)
  );

  CREATE TABLE IF NOT EXISTS user_settings (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key        TEXT NOT NULL,
    value      TEXT,
    updated_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, key)
  );

  CREATE TABLE IF NOT EXISTS app_config (
    key   TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS password_reset_tokens (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    used       INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS invite_tokens (
    token      TEXT PRIMARY KEY,
    email      TEXT,
    role       TEXT NOT NULL DEFAULT 'user',
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    expires_at TEXT NOT NULL,
    used       INTEGER DEFAULT 0
  );
`);

// ── Wellness tables ────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS wellness_data (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER,
    date        TEXT NOT NULL,
    source      TEXT NOT NULL DEFAULT 'fitbit',
    metric_type TEXT NOT NULL,
    value       REAL,
    metadata    TEXT DEFAULT '{}',
    synced_at   TEXT DEFAULT (datetime('now')),
    UNIQUE(user_id, date, source, metric_type)
  );

  -- user_id = NULL in single-user mode; INTEGER PRIMARY KEY allows any value incl. 0
  CREATE TABLE IF NOT EXISTS fitbit_tokens (
    user_id        INTEGER PRIMARY KEY,
    access_token   TEXT NOT NULL,
    refresh_token  TEXT NOT NULL,
    expires_at     TEXT NOT NULL,
    fitbit_user_id TEXT
  );

  CREATE TABLE IF NOT EXISTS withings_tokens (
    user_id          INTEGER PRIMARY KEY,
    access_token     TEXT NOT NULL,
    refresh_token    TEXT NOT NULL,
    expires_at       TEXT NOT NULL,
    withings_user_id TEXT
  );

  -- OAuth 1.0a tokens (no expiry — revoke by deleting)
  CREATE TABLE IF NOT EXISTS garmin_tokens (
    user_id        INTEGER PRIMARY KEY,
    access_token   TEXT NOT NULL,
    access_secret  TEXT NOT NULL,
    garmin_user_id TEXT
  );

  CREATE TABLE IF NOT EXISTS ai_chat_history (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
    role       TEXT NOT NULL,
    content    TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_ai_chat_history_user ON ai_chat_history(user_id, created_at);

  CREATE INDEX IF NOT EXISTS idx_foods_user ON foods(user_id);
  CREATE INDEX IF NOT EXISTS idx_meals_user ON meals(user_id);
  CREATE INDEX IF NOT EXISTS idx_diary_user_date ON diary(user_id, date);
  CREATE INDEX IF NOT EXISTS idx_wellness_user_date ON wellness_data(user_id, date);

  -- OAuth PKCE state store — persisted so server restarts during auth flow don't break it
  CREATE TABLE IF NOT EXISTS oauth_state (
    state       TEXT PRIMARY KEY,
    user_id     INTEGER,
    provider    TEXT NOT NULL,
    data        TEXT NOT NULL DEFAULT '{}',
    expires_at  TEXT NOT NULL
  );

  -- Food sharing: specific user grants (used when visibility = 'specific')
  CREATE TABLE IF NOT EXISTS food_shares (
    food_id  INTEGER NOT NULL REFERENCES foods(id) ON DELETE CASCADE,
    user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (food_id, user_id)
  );

  -- Meal/recipe sharing: specific user grants
  CREATE TABLE IF NOT EXISTS meal_shares (
    meal_id  INTEGER NOT NULL REFERENCES meals(id) ON DELETE CASCADE,
    user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (meal_id, user_id)
  );

  -- Workout activity logs (from Fitbit / Garmin)
  CREATE TABLE IF NOT EXISTS workouts (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER,
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
`);

// ── Migrations ─────────────────────────────────────────────────────────────
function columnExists(table, col) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(r => r.name === col);
}

// Rebuild users table if it was created by an older incomplete schema
if (!columnExists('users', 'username')) {
  db.exec(`
    DROP TABLE IF EXISTS users;
    CREATE TABLE users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      full_name     TEXT,
      nickname      TEXT,
      birthday      TEXT,
      gender        TEXT,
      avatar_url    TEXT,
      role          TEXT NOT NULL DEFAULT 'user',
      created_at    TEXT DEFAULT (datetime('now'))
    );
  `);
}

if (!columnExists('users', 'email')) {
  db.exec(`ALTER TABLE users ADD COLUMN email TEXT`);
}

if (!columnExists('foods', 'user_id')) {
  db.exec(`ALTER TABLE foods ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE`);
}
if (!columnExists('meals', 'user_id')) {
  db.exec(`ALTER TABLE meals ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE`);
}

// diary needs a rebuild to get the composite UNIQUE(date, user_id)
if (!columnExists('wellness_data', 'device_model')) {
  db.exec(`ALTER TABLE wellness_data ADD COLUMN device_model TEXT DEFAULT NULL`);
}

if (!columnExists('diary', 'user_id')) {
  db.exec(`
    ALTER TABLE diary ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;

    CREATE TABLE diary_new (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
      date       TEXT NOT NULL,
      items      TEXT DEFAULT '[]',
      body_stats TEXT DEFAULT '{}',
      water      TEXT DEFAULT '[]',
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(date, user_id)
    );
    INSERT INTO diary_new (id, user_id, date, items, body_stats, water, updated_at)
      SELECT id, user_id, date, items, body_stats, water, updated_at FROM diary;
    DROP TABLE diary;
    ALTER TABLE diary_new RENAME TO diary;
  `);
}

// ── Sharing migrations ──────────────────────────────────────────────────────
if (!columnExists('foods', 'visibility')) {
  db.exec(`ALTER TABLE foods ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private'`);
}
if (!columnExists('foods', 'source_id')) {
  db.exec(`ALTER TABLE foods ADD COLUMN source_id INTEGER`);
}
if (!columnExists('meals', 'visibility')) {
  db.exec(`ALTER TABLE meals ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private'`);
}
if (!columnExists('meals', 'source_id')) {
  db.exec(`ALTER TABLE meals ADD COLUMN source_id INTEGER`);
}

// ── Sync migrations (Phase 2) ──────────────────────────────────────────────
// Add updated_at to tables that lack it (needed for differential sync)
if (!columnExists('foods', 'updated_at')) {
  db.exec(`ALTER TABLE foods ADD COLUMN updated_at TEXT`);
  db.exec(`UPDATE foods SET updated_at = COALESCE(created_at, datetime('now'))`);
}
if (!columnExists('meals', 'updated_at')) {
  db.exec(`ALTER TABLE meals ADD COLUMN updated_at TEXT`);
  db.exec(`UPDATE meals SET updated_at = COALESCE(created_at, datetime('now'))`);
}
if (!columnExists('user_settings', 'updated_at')) {
  db.exec(`ALTER TABLE user_settings ADD COLUMN updated_at TEXT`);
  db.exec(`UPDATE user_settings SET updated_at = datetime('now')`);
}

// Soft deletes — deleted_at column on all syncable tables
if (!columnExists('foods', 'deleted_at')) {
  db.exec(`ALTER TABLE foods ADD COLUMN deleted_at TEXT DEFAULT NULL`);
}
if (!columnExists('meals', 'deleted_at')) {
  db.exec(`ALTER TABLE meals ADD COLUMN deleted_at TEXT DEFAULT NULL`);
}
if (!columnExists('diary', 'deleted_at')) {
  db.exec(`ALTER TABLE diary ADD COLUMN deleted_at TEXT DEFAULT NULL`);
}
if (!columnExists('diary', 'notes')) {
  db.exec(`ALTER TABLE diary ADD COLUMN notes TEXT DEFAULT NULL`);
}
if (!columnExists('user_settings', 'deleted_at')) {
  db.exec(`ALTER TABLE user_settings ADD COLUMN deleted_at TEXT DEFAULT NULL`);
}

// Indexes for sync queries
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_foods_updated ON foods(updated_at);
  CREATE INDEX IF NOT EXISTS idx_meals_updated ON meals(updated_at);
  CREATE INDEX IF NOT EXISTS idx_diary_updated ON diary(updated_at);
  CREATE INDEX IF NOT EXISTS idx_foods_deleted ON foods(deleted_at);
  CREATE INDEX IF NOT EXISTS idx_meals_deleted ON meals(deleted_at);
  CREATE INDEX IF NOT EXISTS idx_diary_deleted ON diary(deleted_at);
`);

// ── Defunct setting key cleanup ──────────────────────────────────────────────
// Drop orphan rows for keys that no longer have any code reading them.
// Safe to delete on every startup — idempotent.
const DEFUNCT_KEYS = [
  'notifGotifyEnabled', // replaced by notifPushService dropdown in v0.32.0
];
for (const key of DEFUNCT_KEYS) {
  try {
    const r = db.prepare('DELETE FROM user_settings WHERE key = ?').run(key);
    if (r.changes > 0) console.log(`[db] cleaned ${r.changes} defunct ${key} row(s)`);
  } catch {}
}

export default db;
