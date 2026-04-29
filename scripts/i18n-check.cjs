#!/usr/bin/env node
/**
 * i18n-check — compare each translation file in src/i18n/ against en.json
 * and report missing / orphaned keys.
 *
 * Usage:  npm run i18n:check
 *
 * "Missing" = key exists in en.json but not in <lang>.json — translator needs
 *             to add a translation. App will fall back to English at runtime.
 * "Orphaned" = key exists in <lang>.json but not in en.json — leftover from a
 *              renamed or removed source key. Harmless but worth cleaning up.
 *
 * Stale-translation detection (English source changed but translation didn't)
 * is NOT possible from JSON alone. Convention: rename the key when meaning
 * changes; cosmetic-only edits are tolerated.
 */
const fs = require('fs');
const path = require('path');

const I18N_DIR = path.join(__dirname, '..', 'src', 'i18n');
const SOURCE_FILE = 'en.json';

function flatten(obj, prefix = '') {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      Object.assign(out, flatten(v, key));
    } else {
      out[key] = v;
    }
  }
  return out;
}

function loadJson(file) {
  return JSON.parse(fs.readFileSync(path.join(I18N_DIR, file), 'utf8'));
}

const enFlat = flatten(loadJson(SOURCE_FILE));
const enKeys = new Set(Object.keys(enFlat));
const total = enKeys.size;

const allFiles = fs.readdirSync(I18N_DIR).filter(f => f.endsWith('.json') && f !== SOURCE_FILE);

console.log(`\ni18n status — source: ${SOURCE_FILE} (${total} keys)\n`);

if (allFiles.length === 0) {
  console.log('  No other locale files yet. Add fr.json / de.json / nl.json / etc. to src/i18n/.\n');
  process.exit(0);
}

let anyGap = false;
for (const file of allFiles.sort()) {
  const langFlat = flatten(loadJson(file));
  const langKeys = new Set(Object.keys(langFlat));
  const missing = [...enKeys].filter(k => !langKeys.has(k));
  const orphaned = [...langKeys].filter(k => !enKeys.has(k));
  const translated = total - missing.length;
  const pct = ((translated / total) * 100).toFixed(0);
  const status = missing.length === 0 && orphaned.length === 0 ? '✓' : '!';
  console.log(`  ${status} ${file.padEnd(10)} ${translated}/${total}  ${pct.padStart(3)}%  ${missing.length} missing, ${orphaned.length} orphaned`);
  if (missing.length || orphaned.length) anyGap = true;
  if (missing.length > 0 && missing.length <= 10) {
    for (const k of missing) console.log(`        missing: ${k}`);
  } else if (missing.length > 10) {
    console.log(`        missing: ${missing.slice(0, 5).join(', ')} ... and ${missing.length - 5} more`);
  }
  if (orphaned.length > 0 && orphaned.length <= 5) {
    for (const k of orphaned) console.log(`       orphaned: ${k}`);
  } else if (orphaned.length > 5) {
    console.log(`       orphaned: ${orphaned.slice(0, 3).join(', ')} ... and ${orphaned.length - 3} more`);
  }
}

console.log('');
process.exit(anyGap ? 1 : 0);
