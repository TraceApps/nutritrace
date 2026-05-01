/**
 * Shared helpers for third-party nutrition CSV imports.
 *
 * Canonical row shape returned by every adapter (one item per logged food):
 *   {
 *     date:         'YYYY-MM-DD',
 *     time:         'HH:MM' | null,
 *     mealIndex:    0..N (mapped to user's mealNames; default 0=B,1=L,2=D,3=S),
 *     mealLabel:    string (raw label from source — kept for unmapped diagnostics),
 *     name:         string,
 *     brand:        string | null,
 *     quantity:     number (number of servings; defaults to 1),
 *     portion:      string | null (e.g. "100 g", "1 cup"),
 *     nutrition:    { calories?, fat?, carbohydrates?, proteins?, fiber?, sugars?,
 *                     sodium?, 'saturated-fat'?, ... } per-serving values,
 *     notes:        string | null,
 *     sourceRow:    number (1-based row number in the source file, for debugging),
 *   }
 *
 * Adapters must return an array of these. The route layer is responsible for
 * mapping `mealIndex` against the user's `mealNames` setting and writing the
 * final NutriTrace diary item shape.
 */

// ── CSV parsing ──────────────────────────────────────────────────────────

/** Quoted-safe CSV line splitter. Handles "a,b"" c",d style escapes. */
export function splitCsvLine(line, delim) {
  const out = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuote) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQuote = false;
      else cur += c;
    } else {
      if (c === '"') inQuote = true;
      else if (c === delim) { out.push(cur); cur = ''; }
      else cur += c;
    }
  }
  out.push(cur);
  return out.map(s => s.trim());
}

/**
 * Detect the field delimiter by counting candidates on the header line.
 * Picks whichever produces the most fields (≥2) among `,`, `;`, `\t`.
 * Falls back to `,`.
 */
export function detectDelimiter(headerLine) {
  const candidates = [',', ';', '\t'];
  let best = ',';
  let bestCount = 1;
  for (const d of candidates) {
    const count = splitCsvLine(headerLine, d).length;
    if (count > bestCount) { best = d; bestCount = count; }
  }
  return best;
}

/**
 * Parse CSV text with auto-detected delimiter. Header row required.
 * Returns { header (lowercased trimmed), rows: array of objects keyed by header }.
 * Strips UTF-8 BOM if present.
 */
export function parseCsv(text) {
  // Strip BOM
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const lines = text.replace(/\r\n?/g, '\n').split('\n').filter(l => l.trim().length > 0);
  if (lines.length === 0) return { header: [], rows: [], delim: ',' };
  const delim = detectDelimiter(lines[0]);
  const headerRaw = splitCsvLine(lines[0], delim);
  const header = headerRaw.map(h => h.toLowerCase().trim());
  const rows = lines.slice(1).map((line, idx) => {
    const cols = splitCsvLine(line, delim);
    const row = { _rowNum: idx + 2 }; // 1-based, +1 for header
    for (let i = 0; i < header.length; i++) row[header[i]] = cols[i] ?? '';
    return row;
  });
  return { header, rows, delim };
}

/**
 * Look up a value from a row by trying multiple header synonyms (case-insensitive).
 * Returns the first non-empty match, or '' if none.
 */
export function getField(row, ...synonyms) {
  for (const s of synonyms) {
    const k = s.toLowerCase();
    const v = row[k];
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

// ── Date parsing ─────────────────────────────────────────────────────────

/**
 * Parse a date string into 'YYYY-MM-DD'. Accepts:
 *   - 2026-04-30 (ISO)
 *   - 4/30/2026 (US M/D/YYYY)
 *   - 30/4/2026 (EU D/M/YYYY)
 *   - 04-30-2026, 30-04-2026, 2026/04/30
 * `localeHint` ('us' | 'eu' | 'auto') disambiguates ambiguous slash-dates;
 * default 'auto' assumes US unless day clearly > 12.
 * Returns null on failure.
 */
export function parseDate(s, localeHint = 'auto') {
  if (!s) return null;
  s = String(s).trim();

  // ISO: 2026-04-30 or 2026/04/30
  let m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (m) {
    const [, y, mo, d] = m;
    return _fmt(y, mo, d);
  }

  // M/D/YYYY or D/M/YYYY (also accepts dash)
  m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})/);
  if (m) {
    let [, a, b, y] = m;
    if (y.length === 2) y = (Number(y) > 50 ? '19' : '20') + y;
    const aN = Number(a), bN = Number(b);
    let mo, d;
    if (localeHint === 'us')      { mo = aN; d = bN; }
    else if (localeHint === 'eu') { mo = bN; d = aN; }
    else {
      // auto: if first > 12 it's clearly D/M; if second > 12 it's clearly M/D;
      // otherwise default to US M/D.
      if (aN > 12)      { mo = bN; d = aN; }
      else if (bN > 12) { mo = aN; d = bN; }
      else              { mo = aN; d = bN; }
    }
    return _fmt(y, mo, d);
  }

  return null;
}

function _fmt(y, mo, d) {
  const Y = String(y).padStart(4, '0');
  const M = String(mo).padStart(2, '0');
  const D = String(d).padStart(2, '0');
  // sanity check
  if (Number(M) < 1 || Number(M) > 12 || Number(D) < 1 || Number(D) > 31) return null;
  return `${Y}-${M}-${D}`;
}

/**
 * Detect whether dates in a sample of rows look like US (M/D) or EU (D/M).
 * Returns 'us', 'eu', or 'auto' (when ambiguous). Used by adapters to pin
 * a locale before parsing the full file.
 */
export function detectDateLocale(samples) {
  let usVotes = 0, euVotes = 0;
  for (const s of samples.slice(0, 50)) {
    if (!s) continue;
    const m = String(s).match(/^(\d{1,2})[-/](\d{1,2})[-/]\d{2,4}/);
    if (!m) continue;
    const a = Number(m[1]), b = Number(m[2]);
    if (a > 12) euVotes++;
    else if (b > 12) usVotes++;
  }
  if (usVotes > euVotes && euVotes === 0) return 'us';
  if (euVotes > usVotes && usVotes === 0) return 'eu';
  return 'auto';
}

// ── Meal mapping ─────────────────────────────────────────────────────────

/**
 * Map a free-text meal label to the user's mealNames index.
 *
 * Strategy:
 *   1. Normalize input + each user-name (lowercase, strip plurals s, trim)
 *   2. Exact match
 *   3. Default-name aliases (breakfast→0, lunch→1, dinner|supper→2, snack|other→3)
 *   4. Substring match against mealNames
 *   5. Fallback: index 3 (Snack/last bucket) — caller can decide otherwise
 *
 * Returns { index, matched: boolean }.
 */
export function mapMeal(rawLabel, userMealNames) {
  const raw = String(rawLabel || '').trim();
  if (!raw) return { index: 3, matched: false };
  const norm = _normMeal(raw);
  const names = (Array.isArray(userMealNames) && userMealNames.length)
    ? userMealNames : ['Breakfast', 'Lunch', 'Dinner', 'Snacks'];

  // 1. Exact (case-insensitive)
  for (let i = 0; i < names.length; i++) {
    if (_normMeal(names[i]) === norm) return { index: i, matched: true };
  }

  // 2. Aliases against the canonical default ordering
  const aliasIndex = _aliasMealIndex(norm);
  if (aliasIndex != null) {
    // Map alias to user's name slot if it exists
    if (aliasIndex < names.length) return { index: aliasIndex, matched: true };
    // Otherwise fall back to last user-defined slot
    return { index: names.length - 1, matched: true };
  }

  // 3. Substring (e.g. "pre-workout snack" matches "Snacks")
  for (let i = 0; i < names.length; i++) {
    if (norm.includes(_normMeal(names[i])) || _normMeal(names[i]).includes(norm)) {
      return { index: i, matched: true };
    }
  }

  // 4. Fallback — last bucket (typically "Snacks")
  return { index: names.length - 1, matched: false };
}

function _normMeal(s) {
  return String(s || '').toLowerCase().trim().replace(/s$/, '');
}

function _aliasMealIndex(norm) {
  if (norm === 'breakfast' || norm === 'bf' || norm === 'morning') return 0;
  if (norm === 'lunch' || norm === 'midday') return 1;
  if (norm === 'dinner' || norm === 'supper' || norm === 'evening') return 2;
  if (norm === 'snack' || norm === 'other' || norm === 'pre-workout' || norm === 'post-workout') return 3;
  return null;
}

// ── Number parsing ───────────────────────────────────────────────────────

/**
 * Parse a numeric value tolerating European decimal commas and embedded units.
 * "1,5" → 1.5; "100 g" → 100; "1.5 cups" → 1.5; "" → null.
 */
export function parseNumber(s) {
  if (s == null || s === '') return null;
  if (typeof s === 'number') return Number.isFinite(s) ? s : null;
  const str = String(s).trim();
  if (!str) return null;
  // Handle "1,5" but NOT "1,500" (thousands separator). If there's exactly one
  // comma and no period, treat comma as decimal.
  let normalized = str;
  if (normalized.includes(',') && !normalized.includes('.')) {
    const commas = normalized.split(',').length - 1;
    if (commas === 1 && /^\d+,\d+/.test(normalized)) {
      normalized = normalized.replace(',', '.');
    }
  }
  const m = normalized.match(/^[+-]?(\d+(?:\.\d+)?|\.\d+)/);
  if (!m) return null;
  const n = parseFloat(m[0]);
  return Number.isFinite(n) ? n : null;
}

/**
 * Split an "Amount" cell like "100 g", "1 cup", "1.5 medium" into
 * { quantity, unit }. Returns { quantity: null, unit: rawAmount } when unparseable.
 */
export function splitAmount(s) {
  const str = String(s || '').trim();
  if (!str) return { quantity: 1, unit: null };
  const m = str.match(/^([+-]?\d+(?:[.,]\d+)?)\s*(.*)$/);
  if (!m) return { quantity: 1, unit: str || null };
  const q = parseNumber(m[1]);
  const unit = m[2].trim() || null;
  return { quantity: q == null ? 1 : q, unit };
}

// ── Energy unit normalization ────────────────────────────────────────────

const KCAL_PER_KJ = 1 / 4.184;

/** Convert kJ to kcal (rounded to 1 decimal). NutriTrace stores calories in kcal. */
export function kJtoKcal(kj) {
  const n = parseNumber(kj);
  return n == null ? null : Math.round(n * KCAL_PER_KJ * 10) / 10;
}
