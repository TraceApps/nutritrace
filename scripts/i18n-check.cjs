#!/usr/bin/env node
/**
 * i18n-check — three checks over src/i18n/ and the code that uses it.
 *
 * Usage:  npm run i18n:check
 *
 * Errors (exit 1):
 *   1. Duplicate keys in en.json at any nesting depth. JSON.parse keeps the
 *      last occurrence and drops the earlier ones silently, so a repeated
 *      section makes whole blocks of copy vanish and render as raw keys. This
 *      check scans the raw text, because after parsing the evidence is gone.
 *   2. Keys referenced in code that don't resolve against en.json.
 *
 * Informational (exit 0):
 *   3. Missing / orphaned keys in other locale files. Translating is
 *      deliberately unhurried (see CONTRIBUTING), so a partial translation
 *      reports but does not fail the build.
 *
 * Reference scanning covers literal keys in `$_('...')` calls plus key-shaped
 * literals held in constants (e.g. Settings' SECTION_META titleKey), matched by
 * shape and by their first segment existing in en.json. A key that reaches $_()
 * some other way is not verified: that is a coverage gap, not a false pass.
 *
 * Stale-translation detection (English source changed but translation didn't)
 * is NOT possible from JSON alone. Convention: rename the key when meaning
 * changes; cosmetic-only edits are tolerated.
 */
const fs = require('fs');
const path = require('path');

const I18N_DIR = path.join(__dirname, '..', 'src', 'i18n');
const SOURCE_FILE = 'en.json';
const SRC_DIR = path.join(__dirname, '..', 'src');
const ROOT = path.join(__dirname, '..');

// Literals that look like i18n keys but are not. Keep the reason next to each.
const IGNORED_INDIRECT = new Set([
  // Property path inside a JSON schema for an AI function-calling tool
  // (src/lib/aiTools.js), not a translation key.
  'programs.id',
]);

const CALL_RE = /\$?_\(\s*(['"])([^'"]+)\1/g;
const KEYISH_RE = /(['"])([a-z][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_]+)+)\1/g;

// Dotted string literals whose trailing segment matches one of these is a
// filename, not an i18n key — e.g. 'foods.json' in local-backup.js. Kept as
// a shape rule (not per-string ignore entries) so the check stays drop-in
// across NutriTrace / CookTrace, where 'settings.json' and friends live.
const FILE_EXT_TAIL = /\.(?:json|js|cjs|mjs|ts|tsx|jsx|svelte|css|scss|html|md|svg|png|jpe?g|webp|gif|ico|mp3|mp4|wav|ogg|woff2?|ttf|otf|yml|yaml|toml|txt|zip)$/i;

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

/** Duplicate keys, as dotted paths, found by walking the raw JSON text. */
function findDuplicateKeys(text) {
  const dups = [];
  let i = 0;
  const skipWs = () => { while (i < text.length && /\s/.test(text[i])) i++; };

  function readString() {
    i++;
    let s = '';
    while (i < text.length) {
      const c = text[i];
      if (c === '\\') {
        const n = text[i + 1];
        if (n === 'u') { s += String.fromCharCode(parseInt(text.slice(i + 2, i + 6), 16)); i += 6; }
        else { s += ({ n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' }[n] ?? n); i += 2; }
        continue;
      }
      if (c === '"') { i++; return s; }
      s += c; i++;
    }
    throw new Error('unterminated string');
  }

  function parseValue(p) {
    skipWs();
    const c = text[i];
    if (c === '{') return parseObject(p);
    if (c === '[') return parseArray(p);
    if (c === '"') { readString(); return; }
    while (i < text.length && !/[,\]}\s]/.test(text[i])) i++;
  }

  function parseObject(p) {
    i++;
    const seen = new Set();
    skipWs();
    if (text[i] === '}') { i++; return; }
    for (;;) {
      skipWs();
      if (text[i] !== '"') throw new Error(`expected key at ${i}`);
      const key = readString();
      const full = p ? `${p}.${key}` : key;
      if (seen.has(key)) dups.push(full);
      seen.add(key);
      skipWs();
      if (text[i] !== ':') throw new Error(`expected ':' at ${i}`);
      i++;
      parseValue(full);
      skipWs();
      if (text[i] === ',') { i++; continue; }
      if (text[i] === '}') { i++; return; }
      throw new Error(`unexpected ${text[i]} at ${i}`);
    }
  }

  function parseArray(p) {
    i++;
    skipWs();
    if (text[i] === ']') { i++; return; }
    let idx = 0;
    for (;;) {
      parseValue(`${p}[${idx++}]`);
      skipWs();
      if (text[i] === ',') { i++; continue; }
      if (text[i] === ']') { i++; return; }
      throw new Error(`unexpected ${text[i]} at ${i}`);
    }
  }

  skipWs();
  parseValue('');
  return dups;
}

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (/\.(svelte|js)$/.test(e.name)) out.push(p);
  }
  return out;
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (text[i] === '\n') line++;
  return line;
}

/**
 * Keys referenced from code. `direct` are $_('...') call arguments; `indirect`
 * are key-shaped literals whose first segment is a top-level en.json key, which
 * covers keys held in constants (e.g. Settings' SECTION_META titleKey).
 * Each entry is { key, file, line }; the first occurrence of a key wins.
 */
function collectKeyRefs(topLevelKeys, files = walk(SRC_DIR)) {
  const direct = new Map();
  const indirect = new Map();
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    for (const m of text.matchAll(CALL_RE)) {
      if (!direct.has(m[2])) direct.set(m[2], { key: m[2], file: rel, line: lineOf(text, m.index) });
    }
    for (const m of text.matchAll(KEYISH_RE)) {
      const key = m[2];
      if (direct.has(key) || indirect.has(key)) continue;
      if (IGNORED_INDIRECT.has(key)) continue;
      if (FILE_EXT_TAIL.test(key)) continue;
      if (!topLevelKeys.has(key.split('.')[0])) continue;
      indirect.set(key, { key, file: rel, line: lineOf(text, m.index) });
    }
  }
  return { direct, indirect };
}

function loadJson(file) {
  return JSON.parse(fs.readFileSync(path.join(I18N_DIR, file), 'utf8'));
}

function main() {
  const raw = fs.readFileSync(path.join(I18N_DIR, SOURCE_FILE), 'utf8');
  const errors = [];

  const dups = findDuplicateKeys(raw);
  const en = JSON.parse(raw);
  const enKeys = new Set(Object.keys(flatten(en)));
  const topLevel = new Set(Object.keys(en));

  console.log(`\ni18n status — source: ${SOURCE_FILE} (${enKeys.size} keys)\n`);

  if (dups.length) {
    errors.push(`${dups.length} duplicate key(s) in ${SOURCE_FILE}`);
    console.log(`  ✗ duplicate keys in ${SOURCE_FILE} — JSON.parse silently keeps the last one:`);
    for (const d of dups) console.log(`        ${d}`);
  } else {
    console.log(`  ✓ no duplicate keys in ${SOURCE_FILE}`);
  }

  const { direct, indirect } = collectKeyRefs(topLevel);
  const unresolved = [...direct.values(), ...indirect.values()].filter(r => !enKeys.has(r.key));
  if (unresolved.length) {
    errors.push(`${unresolved.length} code-referenced key(s) missing from ${SOURCE_FILE}`);
    console.log(`  ✗ keys referenced in code but absent from ${SOURCE_FILE}:`);
    for (const r of unresolved) console.log(`        ${r.key}  (${r.file}:${r.line})`);
  } else {
    console.log(`  ✓ all ${direct.size + indirect.size} code-referenced keys resolve `
                + `(${direct.size} via $_(), ${indirect.size} via constants)`);
  }

  const locales = fs.readdirSync(I18N_DIR).filter(f => f.endsWith('.json') && f !== SOURCE_FILE);
  if (locales.length === 0) {
    console.log('\n  No other locale files yet. Add fr.json / de.json / nl.json / etc. to src/i18n/.');
  } else {
    console.log('');
    for (const file of locales.sort()) {
      const langKeys = new Set(Object.keys(flatten(loadJson(file))));
      const missing = [...enKeys].filter(k => !langKeys.has(k));
      const orphaned = [...langKeys].filter(k => !enKeys.has(k));
      const translated = enKeys.size - missing.length;
      const pct = ((translated / enKeys.size) * 100).toFixed(0);
      const status = missing.length === 0 && orphaned.length === 0 ? '✓' : 'i';
      console.log(`  ${status} ${file.padEnd(10)} ${translated}/${enKeys.size}  ${pct.padStart(3)}%  ${missing.length} missing, ${orphaned.length} orphaned`);
      if (missing.length > 0 && missing.length <= 10) for (const k of missing) console.log(`        missing: ${k}`);
      else if (missing.length > 10) console.log(`        missing: ${missing.slice(0, 5).join(', ')} ... and ${missing.length - 5} more`);
      if (orphaned.length > 0 && orphaned.length <= 5) for (const k of orphaned) console.log(`       orphaned: ${k}`);
      else if (orphaned.length > 5) console.log(`       orphaned: ${orphaned.slice(0, 3).join(', ')} ... and ${orphaned.length - 3} more`);
    }
    console.log('\n  Incomplete translations are informational and do not fail this check.');
  }

  if (errors.length) {
    console.log(`\n  FAILED: ${errors.join('; ')}\n`);
    process.exit(1);
  }
  console.log('');
}

module.exports = { flatten, findDuplicateKeys, collectKeyRefs, IGNORED_INDIRECT, FILE_EXT_TAIL };

if (require.main === module) main();
