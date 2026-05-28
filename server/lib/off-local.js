/**
 * server/lib/off-local.js — local Open Food Facts DuckDB lookups.
 *
 * Opt-in via the OFF_LOCAL_DB env var (filesystem path to a DuckDB file or
 * parquet file). When set, the OFF proxy in server/routes/proxy.js tries the
 * local mirror first for barcode + name-search requests; on a miss (or any
 * error) it falls back to the remote api.openfoodfacts.org unless
 * OFF_LOCAL_ONLY=1 is set (air-gapped mode).
 *
 * Designed so a self-hoster on an air-gapped network or in a strict-egress
 * environment can run NutriTrace's food-lookup features without ever calling
 * the public OFF API.
 *
 * Mirror refresh (issue #22 follow-up):
 *   - Initial pull: on startup, if OFF_LOCAL_DB points to a missing file the
 *     module kicks a background download of OFF_LOCAL_URL (defaults to
 *     https://challenges.openfoodfacts.org/products.duckdb). Lookups during
 *     the download fall through to the public API (unless OFF_LOCAL_ONLY).
 *   - Scheduled refresh: server-side scheduler reads the
 *     `off_local_refresh_interval` app_config row (off|daily|weekly|monthly,
 *     default weekly) and calls refreshNow() when the file's mtime exceeds
 *     the interval.
 *   - Manual refresh: POST /api/off-local/refresh from the Settings UI.
 *   - Atomic swap: download to `<path>.new`, validate it opens, close the
 *     read-only connection, mv over the old file, reopen. A failed mid-flight
 *     download never corrupts the running mirror.
 *
 * Schema assumed: the official OFF DuckDB build exposes a `products` table
 * with columns code, product_name, brands, categories_tags, image_url,
 * image_small_url, serving_size, serving_quantity, quantity, plus a nested
 * `nutriments` STRUCT containing fields like `energy-kcal_100g`,
 * `proteins_100g`, etc. We read defensively — missing columns produce nulls
 * rather than errors so the feature degrades gracefully if OFF rotates the
 * schema.
 *
 * Output shape mirrors the public OFF API responses byte-for-byte where it
 * matters to the client (status/product for /api/v0/product/<code>.json,
 * hits/page/page_size for /search). The client code in src/lib/api.js doesn't
 * know whether the data came from local or remote.
 */
import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import { logger } from '../logger.js';

// OFF removed their pre-built DuckDB snapshot from challenges.openfoodfacts.org
// some time before rc.38 shipped (the URL now 302s back to the main site,
// confirmed dead via curl + verified no replacement DuckDB endpoint exists at
// static.openfoodfacts.org or world.openfoodfacts.org). The maintained dump
// is now the Parquet file on Hugging Face; DuckDB can query it natively via
// read_parquet() so the lookup code below stays mostly the same — we just
// open an in-memory DB and create a view over the Parquet on first init
// when the local file ends in .parquet. Existing users with a real .duckdb
// file from before rc.39 continue to work unchanged (extension auto-detect).
const DEFAULT_DOWNLOAD_URL = 'https://huggingface.co/datasets/openfoodfacts/product-database/resolve/main/food.parquet?download=true';

let _conn = null;            // DuckDB connection — created lazily on first use
let _instance = null;        // DuckDB instance — kept so we can close + reopen on swap
let _initPromise = null;     // single-flight init guard
let _disabled = false;       // permanent kill switch after init failure
let _dbPath = null;          // resolved path for log messages
let _isParquet = false;      // true when the mirror is the HF Parquet shape;
                             // controls which SQL + which JS adapter run

// Refresh state — mirrored back to the client via /api/off-local/status.
// Single in-flight refresh at a time (mutex via _refreshPromise).
let _refreshState = 'idle';  // 'idle' | 'downloading' | 'failed'
let _refreshProgress = 0;    // 0..1
let _refreshBytesDone = 0;
let _refreshBytesTotal = 0;
let _refreshStartedAt = 0;
let _refreshLastOkAt = 0;    // ms epoch of last successful refresh (in-process)
let _refreshLastError = '';
let _refreshPromise = null;

export function isLocalOffEnabled() {
  return !!process.env.OFF_LOCAL_DB && !_disabled;
}

export function isLocalOffOnly() {
  return !!process.env.OFF_LOCAL_DB && !!process.env.OFF_LOCAL_ONLY && !_disabled;
}

export function getDbPath() {
  return process.env.OFF_LOCAL_DB || null;
}

export function getDownloadUrl() {
  return process.env.OFF_LOCAL_URL || DEFAULT_DOWNLOAD_URL;
}

/** Snapshot of mirror health for the Settings UI. Safe to expose to any
 *  authenticated user — values are not sensitive (file size + timestamps +
 *  refresh progress). */
export function getStatus() {
  const enabled = !!process.env.OFF_LOCAL_DB;
  const only    = !!process.env.OFF_LOCAL_ONLY;
  const p       = getDbPath();
  let size_bytes = null;
  let mtime_ms   = null;
  let age_days   = null;
  if (p) {
    try {
      const st = fs.statSync(p);
      size_bytes = st.size;
      mtime_ms   = st.mtimeMs;
      age_days   = (Date.now() - st.mtimeMs) / (24 * 60 * 60 * 1000);
    } catch { /* file not yet downloaded — leave null */ }
  }
  return {
    enabled,
    only,
    disabled: _disabled,
    db_path: p,
    download_url: getDownloadUrl(),
    size_bytes,
    mtime_ms,
    age_days,
    refresh: {
      state: _refreshState,
      progress: _refreshProgress,
      bytes_done: _refreshBytesDone,
      bytes_total: _refreshBytesTotal,
      started_at: _refreshStartedAt || null,
      last_ok_at: _refreshLastOkAt || null,
      last_error: _refreshLastError || '',
    },
  };
}

async function _init() {
  if (_conn) return _conn;
  if (_disabled) return null;
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    _dbPath = process.env.OFF_LOCAL_DB;
    if (!_dbPath) { _disabled = true; return null; }
    // If the file is missing we cannot open it. Don't disable — the initial
    // download (kicked from primeFromStartup) may still complete and call
    // reopenConnection() to swap us in.
    if (!fs.existsSync(_dbPath)) {
      logger.info(`[off-local] db not yet present at ${_dbPath}; waiting for download/refresh.`);
      _initPromise = null;        // allow re-init after the file appears
      return null;
    }
    try {
      // Dynamic import so the dep isn't loaded when the feature is off.
      const { DuckDBInstance } = await import('@duckdb/node-api');
      // Two supported file formats:
      //   *.parquet — open an IN-MEMORY DuckDB, expose the parquet file as a
      //               view named `products`. Required since OFF retired their
      //               native .duckdb snapshot; the maintained dump is parquet
      //               on Hugging Face. DuckDB does row-group pruning so per-
      //               barcode lookups are still <1s on the 7-8 GB file.
      //   *.duckdb  — open the file directly read-only. Legacy path for users
      //               who pointed OFF_LOCAL_DB at a pre-rc.39 .duckdb file.
      // Detect format by file CONTENT (magic bytes), not filename. Lets
      // users keep their old OFF_LOCAL_DB=/data/off.duckdb path even when
      // the downloaded file is actually Parquet, and vice versa.
      // Parquet files start (and end) with "PAR1"; DuckDB native files do
      // not. Any other content fails open in the catch below.
      _isParquet = _sniffParquet(_dbPath);
      if (_isParquet) {
        _instance = await DuckDBInstance.create(':memory:');
        _conn = await _instance.connect();
        const safePath = _dbPath.replace(/'/g, "''");
        await _conn.run(`CREATE OR REPLACE VIEW products AS SELECT * FROM read_parquet('${safePath}');`);
      } else {
        _instance = await DuckDBInstance.create(_dbPath, { access_mode: 'READ_ONLY' });
        _conn = await _instance.connect();
      }
      logger.info(`[off-local] ready — mirror at ${_dbPath} (${_isParquet ? 'parquet via in-memory view' : 'native duckdb'})${process.env.OFF_LOCAL_ONLY ? ' (air-gap mode, remote disabled)' : ''}`);
      return _conn;
    } catch (e) {
      _disabled = true;
      logger.warn(`[off-local] init failed (${e.message}); falling back to remote OFF API for this process. Fix OFF_LOCAL_DB or restart to retry.`);
      return null;
    }
  })();
  return _initPromise;
}

/** Close the current DuckDB connection (if any) so a freshly-swapped file
 *  can be reopened with new data. Safe to call repeatedly. */
async function _closeConnection() {
  try {
    if (_conn) {
      try { _conn.closeSync?.(); } catch { /* older versions don't expose closeSync */ }
      try { _conn.disconnectSync?.(); } catch {}
    }
  } catch { /* swallow */ }
  try {
    if (_instance) {
      try { _instance.closeSync?.(); } catch {}
    }
  } catch {}
  _conn = null;
  _instance = null;
  _initPromise = null;
  _disabled = false;             // clear the kill switch — fresh file may work
}

/** Force the next lookup to re-open the DuckDB file. Called after an atomic
 *  swap so subsequent queries see the new data. */
export async function reopenConnection() {
  await _closeConnection();
  await _init();
}

/** Try to look up a single product by barcode. Returns the OFF API v0/v2
 *  response shape ({status, code, product}) or null if not found / error. */
export async function lookupByBarcode(code) {
  const conn = await _init();
  if (!conn) return null;
  const safeCode = String(code || '').trim();
  if (!safeCode) return null;
  try {
    let rows = (await conn.runAndReadAll(
      `SELECT * FROM products WHERE code = $1 LIMIT 1`,
      [safeCode]
    )).getRowObjects();

    // UPC-A → EAN-13 retry. OFF stores 12-digit UPC-A codes with a
    // leading zero (canonical EAN-13 form), so a caller passing the raw
    // 12-digit scan misses unless we retry padded. The PWA scanner path
    // already normalizes via Foods.svelte#handleScan; this is the
    // defensive layer covering any other caller — AI tools that look up
    // a product by user-typed code, manual barcode entry in the food
    // editor, sync-time validation, or third-party callers of the proxy.
    // Single retry, only when the original code is exactly 12 digits, so
    // we don't accidentally widen the search for other formats.
    if (!rows.length && /^\d{12}$/.test(safeCode)) {
      rows = (await conn.runAndReadAll(
        `SELECT * FROM products WHERE code = $1 LIMIT 1`,
        ['0' + safeCode]
      )).getRowObjects();
    }

    if (!rows.length) {
      return { status: 0, status_verbose: 'product not found', code: safeCode };
    }
    return {
      status: 1,
      status_verbose: 'product found',
      code: safeCode,
      product: _toOffProduct(rows[0]),
    };
  } catch (e) {
    logger.warn(`[off-local] barcode lookup failed for ${safeCode}: ${e.message}`);
    return null;
  }
}

/** Search by free-text against product_name + brands. */
export async function searchByName(query, { page = 1, pageSize = 20 } = {}) {
  const conn = await _init();
  if (!conn) return null;
  const q = String(query || '').trim();
  if (!q) return { hits: [], count: 0, page, page_size: pageSize };
  const pattern = `%${q.toLowerCase().replace(/[%_]/g, c => '\\' + c)}%`;
  const startPattern = `${q.toLowerCase().replace(/[%_]/g, c => '\\' + c)}%`;
  const offset = Math.max(0, (page - 1) * pageSize);
  try {
    // Two SQL shapes — Parquet's product_name is LIST<{lang,text}> so we
    // need list_filter to LIKE-match any localized entry; legacy DuckDB's
    // product_name is a single string so the simple LIKE works directly.
    const sql = _isParquet
      ? `SELECT *,
              CASE WHEN LEN(list_filter(product_name, x -> LOWER(x.text) LIKE $2 ESCAPE '\\')) > 0 THEN 0 ELSE 1 END AS _rank
           FROM products
          WHERE LEN(list_filter(product_name, x -> LOWER(x.text) LIKE $1 ESCAPE '\\')) > 0
             OR LOWER(brands) LIKE $1 ESCAPE '\\'
          ORDER BY _rank ASC
          LIMIT $3 OFFSET $4`
      : `SELECT *, CASE WHEN LOWER(product_name) LIKE $2 ESCAPE '\\' THEN 0 ELSE 1 END AS _rank
           FROM products
          WHERE LOWER(product_name) LIKE $1 ESCAPE '\\'
             OR LOWER(brands) LIKE $1 ESCAPE '\\'
          ORDER BY _rank ASC, LENGTH(COALESCE(product_name, '')) ASC
          LIMIT $3 OFFSET $4`;
    const reader = await conn.runAndReadAll(sql, [pattern, startPattern, pageSize, offset]);
    const rows = reader.getRowObjects();
    return {
      hits: rows.map(_toOffProduct),
      count: rows.length,
      page,
      page_size: pageSize,
    };
  } catch (e) {
    logger.warn(`[off-local] search failed for "${q}": ${e.message}`);
    return null;
  }
}

// ── Download / refresh ─────────────────────────────────────────────────────

/** Kick a refresh in the background. Returns the in-flight promise so callers
 *  can await it if they want; the route handler doesn't (returns immediately
 *  so the Settings UI can poll /status for progress). */
export function refreshNow({ source = 'manual' } = {}) {
  if (!process.env.OFF_LOCAL_DB) {
    return Promise.reject(new Error('OFF_LOCAL_DB is not set; nothing to refresh.'));
  }
  if (_refreshPromise) {
    logger.info(`[off-local] refresh requested (${source}) but one is already in progress; joining.`);
    return _refreshPromise;
  }
  _refreshPromise = _runRefresh(source).finally(() => { _refreshPromise = null; });
  return _refreshPromise;
}

async function _runRefresh(source) {
  const dbPath = process.env.OFF_LOCAL_DB;
  const url    = getDownloadUrl();
  const newPath = `${dbPath}.new`;

  _refreshState = 'downloading';
  _refreshProgress = 0;
  _refreshBytesDone = 0;
  _refreshBytesTotal = 0;
  _refreshStartedAt = Date.now();
  _refreshLastError = '';
  logger.info(`[off-local] refresh started (${source}) — downloading ${url} → ${newPath}`);

  try {
    // Ensure the parent directory exists so a first-time pull on a fresh
    // volume mount works without manual mkdir.
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    // Clean up any stale .new from a previous failed run.
    try { fs.unlinkSync(newPath); } catch {}

    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const lenHeader = res.headers.get('content-length');
    _refreshBytesTotal = lenHeader ? parseInt(lenHeader, 10) : 0;

    // Stream to disk with progress accounting. We tap the body stream so we
    // never have to buffer the full ~4GB in memory.
    const writeStream = fs.createWriteStream(newPath);
    const progressTap = new (await import('stream')).Transform({
      transform(chunk, _enc, cb) {
        _refreshBytesDone += chunk.length;
        if (_refreshBytesTotal > 0) {
          _refreshProgress = Math.min(1, _refreshBytesDone / _refreshBytesTotal);
        }
        cb(null, chunk);
      },
    });
    // Node 18+ fetch returns a web ReadableStream; Readable.fromWeb adapts it
    // for stream/promises.pipeline.
    const { Readable } = await import('stream');
    const nodeReadable = Readable.fromWeb(res.body);
    await pipeline(nodeReadable, progressTap, writeStream);

    // Validate the new file opens before swapping. If OFF / Hugging Face
    // served a partial or corrupt response, abort the swap so we keep
    // serving the old mirror. Same magic-byte detection as _init() — we
    // don't trust the path's extension so a user who keeps the old
    // /data/off.duckdb path but downloads Parquet content still gets
    // validated correctly.
    const { DuckDBInstance } = await import('@duckdb/node-api');
    const isParquet = _sniffParquet(newPath);
    let testInstance = null;
    let testConn = null;
    try {
      if (isParquet) {
        testInstance = await DuckDBInstance.create(':memory:');
        testConn = await testInstance.connect();
        const safePath = newPath.replace(/'/g, "''");
        await testConn.run(`CREATE VIEW products AS SELECT * FROM read_parquet('${safePath}');`);
      } else {
        testInstance = await DuckDBInstance.create(newPath, { access_mode: 'READ_ONLY' });
        testConn = await testInstance.connect();
      }
      const probe = await testConn.runAndReadAll('SELECT COUNT(*) AS n FROM products LIMIT 1');
      const rows = probe.getRowObjects();
      if (!rows.length) throw new Error('products table empty');
    } finally {
      try { testConn?.closeSync?.(); } catch {}
      try { testConn?.disconnectSync?.(); } catch {}
      try { testInstance?.closeSync?.(); } catch {}
    }

    // Close the running connection so we can move the file in place on
    // platforms (looking at you, Windows) that refuse renames over an
    // open file. On Linux a rename over an open file is fine, but reopening
    // is the cheaper way to pick up the new schema either way.
    await _closeConnection();

    // Atomic swap. rename() is atomic on the same filesystem on both Linux
    // and Windows (per POSIX + Win32 MoveFileEx with REPLACE_EXISTING).
    fs.renameSync(newPath, dbPath);

    // Reopen so subsequent lookups hit the fresh data.
    await _init();

    _refreshLastOkAt = Date.now();
    _refreshState = 'idle';
    _refreshProgress = 1;
    logger.info(`[off-local] refresh complete (${source}) — ${(fs.statSync(dbPath).size / 1e9).toFixed(2)} GB, took ${((Date.now() - _refreshStartedAt) / 1000).toFixed(0)}s`);
    return { ok: true, bytes: _refreshBytesDone };
  } catch (e) {
    _refreshState = 'failed';
    let msg = e.message || String(e);
    // Translate the most common self-host gotcha — a read-only bind mount —
    // into a clear pointer at the docker-compose fix. Otherwise users see a
    // bare EACCES/EROFS in the Settings banner and have to guess.
    if (/EACCES|EROFS|read-?only/i.test(msg)) {
      msg = `${msg} (the OFF mirror bind mount appears to be read-only; change ':ro' to writable in docker-compose.yml so refresh can write the new file)`;
    }
    _refreshLastError = msg;
    logger.warn(`[off-local] refresh failed (${source}): ${msg}`);
    // Clean up partial download so we don't leave junk on disk.
    try { fs.unlinkSync(newPath); } catch {}
    throw e;
  }
}

/** Called once at server startup. Kicks an initial download in the background
 *  if the feature is enabled and the file is missing. Never blocks startup. */
export function primeFromStartup() {
  if (!process.env.OFF_LOCAL_DB) return;
  const p = process.env.OFF_LOCAL_DB;
  if (!fs.existsSync(p)) {
    logger.info(`[off-local] initial download — ${p} not present, fetching ${getDownloadUrl()}`);
    refreshNow({ source: 'initial' }).catch(e => {
      logger.warn(`[off-local] initial download failed: ${e.message}`);
    });
  }
}

/** Read the first 4 bytes of a file and check the Parquet magic header
 *  ("PAR1"). Returns true for Parquet, false for anything else
 *  (including unreadable files — caller handles open errors separately).
 *  Used to dispatch to read_parquet() view vs native DuckDB open, so
 *  filename / extension doesn't have to match content. */
function _sniffParquet(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(4);
      const n = fs.readSync(fd, buf, 0, 4, 0);
      if (n < 4) return false;
      return buf.toString('ascii') === 'PAR1';
    } finally {
      try { fs.closeSync(fd); } catch {}
    }
  } catch {
    return false;
  }
}

// ── Row → API shape ────────────────────────────────────────────────────────
// Two schemas supported, dispatched on row.product_name's runtime shape:
//
//   HF Parquet (rc.39+ default):
//     product_name:  LIST<{lang: string, text: string}>     (localized)
//     generic_name:  LIST<{lang, text}>                     (fallback)
//     brands:        string
//     brands_tags:   LIST<string>
//     categories:    string
//     categories_tags: LIST<string>
//     serving_size, serving_quantity, quantity: string
//     nutriments:    LIST<{name, value, 100g, serving, unit, prepared_*}>
//     images:        LIST<{key, imgid, rev, sizes:{100,200,400,full},...}>
//     lang:          string  (product's primary language)
//
//   Legacy native DuckDB (pre-rc.39 .duckdb files OFF used to publish):
//     product_name:  string
//     brands:        string
//     image_url, image_small_url, image_front_url: string
//     nutriments:    STRUCT keyed by `${nutrient}_100g` etc., OR fields
//                    flattened as top-level columns
//
// The branching is on Array.isArray(row.product_name) — Parquet returns an
// array, legacy returns a string. Both paths produce the same OFF-API
// response shape so callers (proxy.js, the client) don't need to know
// which file format was used.

function _toOffProduct(row) {
  // Normalize LIST<STRUCT> columns up front: DuckDB Node API can return
  // LIST values as either a real Array (typical) or a list-like object
  // (iterable but not Array.isArray) depending on version. The previous
  // Array.isArray check missed the latter case and dropped through to the
  // legacy branch, which then leaked the raw list object out as
  // product_name and broke the client's .trim() call (issue #22 followup
  // from @duplaja). Coerce to a real Array here so both branches see the
  // shape they expect.
  const _asArray = v => Array.isArray(v)
    ? v
    : (v != null && typeof v !== 'string' && typeof v[Symbol.iterator] === 'function')
      ? Array.from(v)
      : null;
  const pnList = _asArray(row.product_name);
  if (pnList) {
    // Parquet shape: product_name is LIST<{lang, text}>
    const name = _extractLocalized(pnList) || _extractLocalized(_asArray(row.generic_name));
    return {
      code: row.code,
      product_name: typeof name === 'string' ? name : '',
      brands: row.brands || '',
      brands_tags: row.brands_tags || [],
      categories: row.categories || '',
      categories_tags: row.categories_tags || [],
      ..._buildImageUrls(row.images, row.code, row.lang || 'en'),
      serving_size: row.serving_size || '',
      serving_quantity: row.serving_quantity != null ? String(row.serving_quantity) : '',
      quantity: row.quantity || '',
      nutriments: _unfoldNutrimentsList(row.nutriments),
    };
  }
  // Legacy native DuckDB shape (product_name is a plain string column)
  const nutriments = _flattenNutrimentsStruct(row.nutriments) || _pickNutrimentColumns(row);
  return {
    code: row.code,
    product_name: typeof row.product_name === 'string' ? row.product_name : '',
    brands: row.brands || '',
    brands_tags: row.brands_tags || [],
    categories: row.categories || '',
    categories_tags: row.categories_tags || [],
    image_url: row.image_url || '',
    image_small_url: row.image_small_url || row.image_url || '',
    image_front_url: row.image_front_url || row.image_url || '',
    serving_size: row.serving_size || '',
    serving_quantity: row.serving_quantity != null ? String(row.serving_quantity) : '',
    quantity: row.quantity || '',
    nutriments,
  };
}

/** Pull the best-fit text from an OFF localized field
 *  (`product_name`, `generic_name`, `ingredients_text`, etc.).
 *  Preference order: requested lang → 'main' (OFF's canonical entry) →
 *  first entry with non-empty text. Returns '' if nothing usable.
 *  preferLang defaults to 'en'; could later read from the user's offSearchLanguage setting. */
function _extractLocalized(list, preferLang = 'en') {
  if (!Array.isArray(list)) return '';
  const byLang = (l) => list.find(x => x && x.lang === l && x.text);
  return (byLang(preferLang)?.text)
      || (byLang('main')?.text)
      || (list.find(x => x && x.text)?.text)
      || '';
}

/** Unfold the HF Parquet nutriments list-of-objects into the flat
 *  `{name_100g, name_serving, name_value, name_unit}` shape the rest of
 *  NutriTrace expects (matches OFF's public API response shape).
 *  Skips elements with no name or no numeric value. */
function _unfoldNutrimentsList(list) {
  if (!Array.isArray(list)) return {};
  const out = {};
  const num = v => (typeof v === 'bigint' ? Number(v) : v);
  for (const n of list) {
    if (!n?.name) continue;
    if (n['100g']    != null) out[`${n.name}_100g`]    = num(n['100g']);
    if (n.serving    != null) out[`${n.name}_serving`] = num(n.serving);
    if (n.value      != null) out[`${n.name}_value`]   = num(n.value);
    if (n.unit       != null) out[`${n.name}_unit`]    = n.unit;
  }
  return out;
}

/** Legacy DuckDB nested-struct nutriments → flat object. */
function _flattenNutrimentsStruct(n) {
  if (!n || typeof n !== 'object' || Array.isArray(n)) return null;
  const out = {};
  for (const [k, v] of Object.entries(n)) {
    if (v != null) out[k] = typeof v === 'bigint' ? Number(v) : v;
  }
  return Object.keys(out).length ? out : null;
}

/** OFF stores images at a path derived from the barcode:
 *    barcodes >= 13 chars → split 3/3/3/rest (e.g. 5449000131805 → 544/900/013/1805)
 *    shorter barcodes     → used as-is
 *  Combined with the image element's {key, rev} this yields:
 *    https://images.openfoodfacts.org/images/products/<path>/<key>.<rev>.<size>.jpg
 *  where size is one of 100, 200, 400, full. */
function _offImagePath(code) {
  if (code == null) return '';
  const s = String(code);
  if (s.length < 13) return s;
  return `${s.slice(0,3)}/${s.slice(3,6)}/${s.slice(6,9)}/${s.slice(9)}`;
}

/** Pick the best front image from the HF Parquet `images` list and build
 *  the three URL variants the client expects (image_url, image_small_url,
 *  image_front_url). Preference: front_<lang> → front_main → front_<any
 *  lang> → bare 'front' → first numeric raw upload. */
function _buildImageUrls(images, code, lang = 'en') {
  const empty = { image_url: '', image_small_url: '', image_front_url: '' };
  if (!Array.isArray(images) || code == null) return empty;
  const path = _offImagePath(code);
  if (!path) return empty;
  const front = images.find(x => x?.key === `front_${lang}`)
             || images.find(x => x?.key === 'front_main')
             || images.find(x => x?.key && typeof x.key === 'string' && x.key.startsWith('front_'))
             || images.find(x => x?.key === 'front')
             || images.find(x => x?.key && /^\d+$/.test(String(x.key)));
  if (!front || front.rev == null || !front.key) return empty;
  const rev = typeof front.rev === 'bigint' ? Number(front.rev) : front.rev;
  const base = `https://images.openfoodfacts.org/images/products/${path}/${front.key}.${rev}`;
  return {
    image_url:       `${base}.400.jpg`,    // medium — used in lists, food picker
    image_small_url: `${base}.100.jpg`,    // thumb
    image_front_url: `${base}.full.jpg`,   // hi-res
  };
}

function _pickNutrimentColumns(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (v == null) continue;
    if (/_(100g|serving|value|unit)$/.test(k)) {
      out[k] = typeof v === 'bigint' ? Number(v) : v;
    }
  }
  return out;
}
