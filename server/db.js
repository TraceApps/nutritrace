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
    servings   INTEGER DEFAULT 1,
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

  -- Personal access tokens for the federation API (/api/v1/*).
  -- Token raw value is never stored; only the SHA-256 hash. See
  -- docs/federation.md for the auth contract.
  CREATE TABLE IF NOT EXISTS api_tokens (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    token_hash   TEXT NOT NULL UNIQUE,
    scopes       TEXT NOT NULL DEFAULT '[]',  -- JSON array of scope strings
    expires_at   TEXT,                         -- NULL = never expires
    last_used_at TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_api_tokens_user ON api_tokens(user_id);
  CREATE INDEX IF NOT EXISTS idx_api_tokens_hash ON api_tokens(token_hash);
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

  -- Google Health API tokens — successor to Fitbit Web API (Sept 2026 cutoff).
  -- Wider TEXT columns: Google access tokens are ~2KB (vs Fitbit's ~1KB).
  -- google_user_id stores the response from users.getIdentity for cross-ref.
  CREATE TABLE IF NOT EXISTS google_health_tokens (
    user_id        INTEGER PRIMARY KEY,
    access_token   TEXT NOT NULL,
    refresh_token  TEXT NOT NULL,
    expires_at     TEXT NOT NULL,
    google_user_id TEXT,
    fitbit_user_id TEXT  -- legacy Fitbit encodedId (from getIdentity), helps bridge old Fitbit data
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

  -- Manually-logged activity entries (issue #3 — Activity diary section)
  -- Sums per date offset the daily calorie goal per manualActivityPolicy.
  CREATE TABLE IF NOT EXISTS activity_log (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER REFERENCES users(id) ON DELETE CASCADE,
    date          TEXT NOT NULL,
    name          TEXT NOT NULL,
    kcal          INTEGER NOT NULL,
    duration_min  INTEGER,
    distance      TEXT,
    source        TEXT NOT NULL DEFAULT 'manual_form',
    created_at    TEXT DEFAULT (datetime('now')),
    updated_at    TEXT DEFAULT (datetime('now')),
    deleted_at    TEXT DEFAULT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_activity_user_date ON activity_log(user_id, date);
  CREATE INDEX IF NOT EXISTS idx_activity_updated   ON activity_log(updated_at);
  CREATE INDEX IF NOT EXISTS idx_activity_deleted   ON activity_log(deleted_at);

  -- Intermittent fasting tracker — opt-in via the Diary 'Show Fasting Tracker'
  -- setting. end_at IS NULL means an active fast. goal_hours stores the user's
  -- chosen target (16, 18, 20, 23 OMAD, or custom).
  CREATE TABLE IF NOT EXISTS fasts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
    start_at    TEXT NOT NULL,
    end_at      TEXT,
    goal_hours  REAL NOT NULL DEFAULT 16,
    notes       TEXT,
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now')),
    deleted_at  TEXT DEFAULT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_fasts_user_start ON fasts(user_id, start_at);
  CREATE INDEX IF NOT EXISTS idx_fasts_updated    ON fasts(updated_at);
  CREATE INDEX IF NOT EXISTS idx_fasts_active     ON fasts(user_id, end_at);

  -- OIDC providers — admin-managed list; client_secret encrypted via
  -- server/lib/token-crypto.js so a leaked DB doesn't hand out IdP creds.
  CREATE TABLE IF NOT EXISTS oidc_providers (
    id                            INTEGER PRIMARY KEY AUTOINCREMENT,
    issuer_url                    TEXT NOT NULL,
    client_id                     TEXT NOT NULL,
    client_secret                 TEXT,                                -- encrypted
    redirect_uris                 TEXT NOT NULL DEFAULT '[]',          -- JSON array
    scope                         TEXT NOT NULL DEFAULT 'openid profile email',
    token_endpoint_auth_method    TEXT NOT NULL DEFAULT 'client_secret_post',
    response_types                TEXT NOT NULL DEFAULT '["code"]',    -- JSON array
    id_token_signed_response_alg  TEXT NOT NULL DEFAULT 'RS256',
    userinfo_signed_response_alg  TEXT NOT NULL DEFAULT 'none',
    request_timeout_ms            INTEGER NOT NULL DEFAULT 30000,
    auto_register                 INTEGER NOT NULL DEFAULT 0, -- legacy, kept for migrations
    auto_link_verified_email      INTEGER NOT NULL DEFAULT 1, -- ON by default; safe (just trusts the IdP)
    auto_register_new_users       INTEGER NOT NULL DEFAULT 0, -- OFF by default; gates blanket onboarding
    admin_group_claim             TEXT,
    admin_group_value             TEXT,
    display_name                  TEXT,
    logo_url                      TEXT,
    is_active                     INTEGER NOT NULL DEFAULT 1,
    created_at                    TEXT DEFAULT (datetime('now')),
    updated_at                    TEXT DEFAULT (datetime('now'))
  );

  -- Per-user OIDC links — one row per (user, provider) link. Lets a single
  -- user authenticate via N IdPs without bloating the users table.
  CREATE TABLE IF NOT EXISTS user_oidc_links (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    oidc_provider_id  INTEGER NOT NULL REFERENCES oidc_providers(id) ON DELETE CASCADE,
    oidc_sub          TEXT NOT NULL,
    email_verified    INTEGER DEFAULT 0,
    last_login_at     TEXT,
    created_at        TEXT DEFAULT (datetime('now')),
    UNIQUE (oidc_provider_id, oidc_sub)
  );
  CREATE INDEX IF NOT EXISTS idx_user_oidc_links_user ON user_oidc_links(user_id);
`);

// The rebuild below SELECTs `email` from the old users table. Fresh installs
// create users without an email column (see CREATE TABLE IF NOT EXISTS above),
// so we must add it BEFORE the rebuild runs or the INSERT SELECT crashes with
// "no such column: email". The redundant ALTER further down is a no-op once
// this has fired.
if (!db.prepare(`PRAGMA table_info(users)`).all().some(r => r.name === 'email')) {
  db.exec(`ALTER TABLE users ADD COLUMN email TEXT`);
}

// Allow password_hash to be NULL for OIDC-only users (legacy schemas had NOT NULL).
// SQLite doesn't support ALTER COLUMN; we rebuild the table.
//
// CRITICAL: foreign_keys MUST be disabled around the rebuild. With FK
// enforcement ON, DROP TABLE on the parent will trigger cascade deletes on
// every child table that references users(id) ON DELETE CASCADE — which is
// user_settings, food_shares, meal_shares, ai_chat_history, activity_log,
// user_oidc_links, etc. — wiping user-scoped data. Following SQLite's
// recommended safe-rebuild recipe:
// https://www.sqlite.org/lang_altertable.html#otheralter
{
  const colInfo = db.prepare(`PRAGMA table_info(users)`).all();
  const pwCol = colInfo.find(c => c.name === 'password_hash');
  if (pwCol && pwCol.notnull) {
    db.pragma('foreign_keys = OFF');
    try {
      const rebuild = db.transaction(() => {
        db.exec(`
          CREATE TABLE users_new (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            username      TEXT UNIQUE NOT NULL,
            password_hash TEXT,
            full_name     TEXT,
            nickname      TEXT,
            birthday      TEXT,
            gender        TEXT,
            avatar_url    TEXT,
            role          TEXT NOT NULL DEFAULT 'user',
            email         TEXT,
            created_at    TEXT DEFAULT (datetime('now'))
          );
          INSERT INTO users_new SELECT id, username, password_hash, full_name, nickname, birthday, gender, avatar_url, role, email, created_at FROM users;
          DROP TABLE users;
          ALTER TABLE users_new RENAME TO users;
        `);
      });
      rebuild();
      // Sanity: with FKs back on, validate that no child table holds an
      // orphaned user_id. If anything's broken, surface it loudly rather
      // than silently corrupt the DB.
      const violations = db.prepare(`PRAGMA foreign_key_check`).all();
      if (violations.length) {
        console.error('[db] FK violations after users rebuild:', violations);
      }
    } finally {
      db.pragma('foreign_keys = ON');
    }
  }
}

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

// Heal any rows where updated_at slipped through as NULL — possibly via
// older POST /foods or POST /meals paths that didn't always set it.
// Reported by tellis82 in #13: meals with null updated_at vanish from
// the Android app because differential sync filters with `updated_at >= ?`
// and SQLite's NULL never satisfies that comparison. Idempotent — only
// rewrites NULL rows; existing non-null values are untouched.
db.exec(`UPDATE foods SET updated_at = COALESCE(created_at, datetime('now')) WHERE updated_at IS NULL`);
db.exec(`UPDATE meals SET updated_at = COALESCE(created_at, datetime('now')) WHERE updated_at IS NULL`);
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
if (!columnExists('meals', 'servings')) {
  // Recipe yields. Existing migrated rows stay NULL — the editor treats NULL
  // as "unset" (blank field, acts as 1 in math). New recipes saved after this
  // feature ships always write an explicit value (>=1). The CREATE TABLE
  // default of 1 still applies to fresh installs that INSERT without
  // specifying servings, which should never happen via the editor path.
  db.exec(`ALTER TABLE meals ADD COLUMN servings INTEGER`);
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

// ── Favorites + usage tracking (foods + meals) ─────────────────────────────
// `favorite` pins items to the top of the picker; `usage_count` and
// `last_used_at` drive the Most Used / Recently Used sort modes.
// Backfill from existing diary items so users land with sensible values
// instead of all-zeros (one-shot — only fires when the columns are added).
function _backfillUsage(table) {
  const rows = db.prepare(`SELECT id, items FROM diary`).all();
  const counts = new Map(); // id → { count, last_date }
  for (const r of rows) {
    let items = [];
    try { items = JSON.parse(r.items || '[]'); } catch {}
    if (!Array.isArray(items)) continue;
    for (const it of items) {
      // Diary items reference foods via `foodId` and meals via `mealId`.
      const id = table === 'foods' ? (it.foodId ?? it.food_id) : (it.mealId ?? it.meal_id);
      if (id == null) continue;
      const cur = counts.get(id) || { count: 0, last: '' };
      cur.count++;
      if (r.date > cur.last) cur.last = r.date;
      counts.set(id, cur);
    }
  }
  const upd = db.prepare(`UPDATE ${table} SET usage_count = ?, last_used_at = ? WHERE id = ?`);
  const tx = db.transaction(() => {
    for (const [id, { count, last }] of counts) upd.run(count, last || null, id);
  });
  tx();
  return counts.size;
}
let _favColumnsAdded = false;
if (!columnExists('foods', 'favorite')) {
  db.exec(`ALTER TABLE foods ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0`);
  _favColumnsAdded = true;
}
if (!columnExists('foods', 'usage_count')) {
  db.exec(`ALTER TABLE foods ADD COLUMN usage_count INTEGER NOT NULL DEFAULT 0`);
  _favColumnsAdded = true;
}
if (!columnExists('foods', 'last_used_at')) {
  db.exec(`ALTER TABLE foods ADD COLUMN last_used_at TEXT DEFAULT NULL`);
  _favColumnsAdded = true;
}
if (!columnExists('meals', 'favorite')) {
  db.exec(`ALTER TABLE meals ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0`);
  _favColumnsAdded = true;
}
if (!columnExists('meals', 'usage_count')) {
  db.exec(`ALTER TABLE meals ADD COLUMN usage_count INTEGER NOT NULL DEFAULT 0`);
  _favColumnsAdded = true;
}
if (!columnExists('meals', 'last_used_at')) {
  db.exec(`ALTER TABLE meals ADD COLUMN last_used_at TEXT DEFAULT NULL`);
  _favColumnsAdded = true;
}
if (_favColumnsAdded) {
  try {
    const n1 = _backfillUsage('foods');
    const n2 = _backfillUsage('meals');
    console.log(`[db] backfilled usage counters on ${n1} foods + ${n2} meals from existing diary items`);
  } catch (e) {
    console.warn('[db] usage backfill skipped:', e.message);
  }
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

// ── OIDC providers: split auto_register into auto_link_verified_email +
//    auto_register_new_users (rc.12). Existing rows keep their old behavior
//    by copying auto_register into both new columns.
{
  if (!columnExists('oidc_providers', 'auto_link_verified_email')) {
    db.exec(`ALTER TABLE oidc_providers ADD COLUMN auto_link_verified_email INTEGER NOT NULL DEFAULT 1`);
    db.exec(`UPDATE oidc_providers SET auto_link_verified_email = auto_register`);
  }
  if (!columnExists('oidc_providers', 'auto_register_new_users')) {
    db.exec(`ALTER TABLE oidc_providers ADD COLUMN auto_register_new_users INTEGER NOT NULL DEFAULT 0`);
    db.exec(`UPDATE oidc_providers SET auto_register_new_users = auto_register`);
  }
}

// ── Seed default app_config rows ───────────────────────────────────────────
// Idempotent — only inserts if missing. Surfaces sane defaults so admins can
// flip values via the UI without first knowing the row needs to exist.
{
  const seeds = [
    ['enable_email_password_login', '1'],   // OIDC + password coexist by default
  ];
  const ins = db.prepare(`INSERT OR IGNORE INTO app_config (key, value) VALUES (?, ?)`);
  for (const [k, v] of seeds) ins.run(k, v);
}

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

// ── Sodium ↔ salt backfill (one-time, idempotent) ──────────────────────────
// Foods and meals saved before the auto-derivation landed only have one of
// (sodium, salt) populated if the data source provided just one (e.g. OFF
// returns salt, USDA returns sodium). Run a one-time pass at startup that
// fills the missing field via the regulatory factor (sodium_mg = salt_g ×
// 400; salt_g = sodium_mg / 400) and stores the _derived flag so the food
// editor can render the calculator icon. Skips rows where both are present
// or both are missing. Safe to re-run — only touches rows that need it.
function _backfillSodiumSalt(table) {
  let changed = 0;
  try {
    const rows = db.prepare(`SELECT id, nutrition FROM ${table} WHERE nutrition IS NOT NULL AND nutrition != '{}' AND deleted_at IS NULL`).all();
    const update = db.prepare(`UPDATE ${table} SET nutrition = ? WHERE id = ?`);
    db.transaction(() => {
      for (const row of rows) {
        let nutrition;
        try { nutrition = JSON.parse(row.nutrition || '{}'); } catch { continue; }
        if (!nutrition || typeof nutrition !== 'object') continue;
        // Skip if already derived (idempotent)
        if (nutrition._derived && (nutrition._derived.sodium || nutrition._derived.salt)) continue;
        const hasSodium = nutrition.sodium != null && Number(nutrition.sodium) > 0;
        const hasSalt   = nutrition.salt   != null && Number(nutrition.salt)   > 0;
        if (hasSodium === hasSalt) continue; // both or neither — leave alone
        if (hasSodium && !hasSalt) {
          nutrition.salt = Math.round((Number(nutrition.sodium) / 400) * 1000) / 1000;
          nutrition._derived = { ...(nutrition._derived || {}), salt: true };
        } else if (hasSalt && !hasSodium) {
          nutrition.sodium = Math.round(Number(nutrition.salt) * 400 * 10) / 10;
          nutrition._derived = { ...(nutrition._derived || {}), sodium: true };
        }
        update.run(JSON.stringify(nutrition), row.id);
        changed++;
      }
    })();
  } catch (e) {
    console.warn(`[db] sodium/salt backfill on ${table} failed:`, e.message || e);
  }
  return changed;
}
try {
  const f = _backfillSodiumSalt('foods');
  const m = _backfillSodiumSalt('meals');
  if (f + m > 0) console.log(`[db] backfilled sodium/salt on ${f} foods + ${m} meals`);
} catch {}

export default db;
