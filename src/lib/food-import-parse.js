/**
 * Parsers for the Bulk Food Import flow.
 *
 * parseJson and parseCsv both return the same shape:
 *   { valid: [foodObject, ...], errors: [{ row, message, raw }, ...] }
 *
 * Dedup-by-barcode is NOT done here — it requires the user's existing
 * barcode list and runs at commit time in the modal.
 *
 * Each foodObject is shaped to match what POST /api/data/import expects:
 *   { name, brand, barcode, portion, unit, category, nutrition: { ... } }
 */
import { NUTRIMENTS } from './nutrition.js';
import { FIXED_COLUMNS } from './food-import-template.js';

const NUTRIENT_IDS = new Set(NUTRIMENTS.map(n => n.id));

function _coerceNumber(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function _normalizeFood(raw, rowNum) {
  const name = (raw.name || '').toString().trim();
  if (!name) return { ok: false, error: { row: rowNum, message: 'Missing required field: name', raw } };

  const calories = _coerceNumber(raw.nutrition?.calories ?? raw.calories);
  if (calories == null) return { ok: false, error: { row: rowNum, message: 'Missing or invalid calories', raw } };

  const nutrition = { calories };
  for (const n of NUTRIMENTS) {
    if (n.id === 'calories') continue;
    const v = _coerceNumber(raw.nutrition?.[n.id] ?? raw[n.id]);
    if (v != null) nutrition[n.id] = v;
  }

  const portion = _coerceNumber(raw.portion);
  const food = {
    name,
    brand: (raw.brand || '').toString().trim() || null,
    barcode: (raw.barcode || '').toString().trim() || null,
    portion: portion != null ? portion : 100,
    unit: (raw.unit || '').toString().trim() || 'g',
    category: (raw.category || '').toString().trim() || null,
    nutrition,
  };
  return { ok: true, food };
}

export function parseJson(text) {
  const out = { valid: [], errors: [] };
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    out.errors.push({ row: 0, message: `Invalid JSON: ${e.message}`, raw: null });
    return out;
  }
  const foods = Array.isArray(data) ? data : Array.isArray(data?.foods) ? data.foods : null;
  if (!foods) {
    out.errors.push({ row: 0, message: 'Expected an array of foods or { foods: [...] }', raw: data });
    return out;
  }
  foods.forEach((raw, i) => {
    if (!raw || typeof raw !== 'object') {
      out.errors.push({ row: i + 1, message: 'Row is not an object', raw });
      return;
    }
    const r = _normalizeFood(raw, i + 1);
    if (r.ok) out.valid.push(r.food);
    else out.errors.push(r.error);
  });
  return out;
}

// Tiny CSV row tokenizer that respects double-quoted fields with escaped quotes ("")
function _splitCsvRow(line) {
  const cells = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') { inQuotes = false; }
      else { cur += ch; }
    } else {
      if (ch === ',') { cells.push(cur); cur = ''; }
      else if (ch === '"') { inQuotes = true; }
      else { cur += ch; }
    }
  }
  cells.push(cur);
  return cells;
}

function _splitCsvLines(text) {
  // Strip a UTF-8 BOM if present (Excel exports often include one)
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const lines = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (inQuotes && text[i + 1] === '"') { cur += '""'; i++; }
      else { inQuotes = !inQuotes; cur += ch; }
    } else if ((ch === '\n' || ch === '\r') && !inQuotes) {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      if (cur.length || lines.length === 0) lines.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.length) lines.push(cur);
  return lines.filter(l => l.trim().length > 0);
}

export function parseCsv(text) {
  const out = { valid: [], errors: [] };
  const lines = _splitCsvLines(text);
  if (lines.length < 2) {
    out.errors.push({ row: 0, message: 'CSV must have a header row plus at least one data row', raw: null });
    return out;
  }
  const headers = _splitCsvRow(lines[0]).map(h => h.trim());
  const hasName = headers.includes('name');
  const hasCalories = headers.includes('calories');
  if (!hasName || !hasCalories) {
    out.errors.push({ row: 0, message: `CSV header must include "name" and "calories" (got: ${headers.join(', ')})`, raw: headers });
    return out;
  }
  for (let i = 1; i < lines.length; i++) {
    const cells = _splitCsvRow(lines[i]);
    const raw = {};
    const nutrition = {};
    headers.forEach((h, idx) => {
      const val = cells[idx] ?? '';
      if (FIXED_COLUMNS.includes(h)) raw[h] = val;
      else if (NUTRIENT_IDS.has(h)) nutrition[h] = val;
      // unknown columns are ignored (no warning — keeps tolerant)
    });
    raw.nutrition = nutrition;
    const r = _normalizeFood(raw, i + 1);
    if (r.ok) out.valid.push(r.food);
    else out.errors.push(r.error);
  }
  return out;
}
