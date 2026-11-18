/**
 * Settings search index: what each Settings section shows, so the search box
 * finds a setting by any word of its label, description, buttons or options,
 * in the app's language and in English (src/lib/settings-search.js).
 *
 * Search used to match a hand-written keyword list only, and settings added
 * without keywords couldn't be found. This reads the section's own files:
 * each section's page under src/routes/settings (Profile for `profile`) and
 * the settings components it uses, following their imports. What the page
 * shows: translation keys used in the markup ($_('...')), plain text in it,
 * the text of label/title/placeholder/desc attributes, and the names in
 * option lists (const ..._OPTS = [...]).
 *
 *   node scripts/gen-settings-search.mjs          writes the index
 *   node scripts/gen-settings-search.mjs --check  fails when it's out of date
 *
 * scripts/settings-search.test.js runs the check, so a setting added without
 * regenerating fails the tests.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'src/lib/settings-search-index.json');
// Generic building blocks: they show what they're given, nothing of their own.
const GENERIC = new Set(['SettingRow.svelte', 'Toggle.svelte']);
const FOLLOW = ['src/routes/settings/', 'src/components/settings/', 'src/components/two-step/'];

/** Section keys, in Settings.svelte's order (SECTION_META, plus profile). */
export function sectionKeys() {
  const src = readFileSync(join(ROOT, 'src/routes/Settings.svelte'), 'utf8');
  const meta = src.slice(src.indexOf('const SECTION_META = {'));
  const body = meta.slice(0, meta.indexOf('\n  };'));
  const keys = [...body.matchAll(/^\s{4}(\w+):\s*\{/gm)].map(m => m[1]);
  return keys.includes('profile') ? keys : [...keys, 'profile'];
}

/** The page a section opens. */
export function sectionRoot(key) {
  if (key === 'profile') return 'src/routes/Profile.svelte';
  return `src/routes/settings/${key[0].toUpperCase()}${key.slice(1)}.svelte`;
}

/** A section's files: its page and the settings components it uses. */
export function sectionFiles(key) {
  const seen = new Set();
  const visit = rel => {
    if (seen.has(rel) || !existsSync(join(ROOT, rel))) return;
    seen.add(rel);
    const src = readFileSync(join(ROOT, rel), 'utf8');
    for (const m of src.matchAll(/import\s+\w+\s+from\s+['"]([^'"]+\.svelte)['"]/g)) {
      const to = relative(ROOT, resolve(ROOT, dirname(rel), m[1])).replace(/\\/g, '/');
      if (GENERIC.has(to.split('/').pop())) continue;
      if (FOLLOW.some(d => to.startsWith(d))) visit(to);
    }
  };
  visit(sectionRoot(key));
  return [...seen];
}

const _strip = (s, open, close) => s.replace(new RegExp(`<${open}[\\s\\S]*?<\\/${close}>`, 'g'), ' ');

/** What one file shows: { keys, text }. */
export function fileStrings(rel) {
  const src = readFileSync(join(ROOT, rel), 'utf8');
  const scripts = [...src.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');
  const markup = _strip(_strip(src, 'script', 'script'), 'style', 'style');
  const keys = new Set();
  const text = new Set();
  for (const m of markup.matchAll(/\$_\(\s*['"]([\w.-]+)['"]/g)) keys.add(m[1]);
  // tr('ns', 'key', 'English'): its English.
  for (const m of markup.matchAll(/\btr\(\s*['"][^'"]+['"]\s*,\s*['"][^'"]+['"]\s*,\s*'((?:[^'\\]|\\.)+)'/g)) text.add(m[1]);
  // Attributes a person reads.
  for (const m of markup.matchAll(/\b(?:label|title|placeholder|desc|description|aria-label)="([^"{}]+)"/g)) text.add(m[1]);
  // Plain text between tags, without {expressions}.
  // Icons (material symbols) are names, not text a person reads.
  let t = markup.replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(span|i)\b[^>]*material-symbols[^>]*>[\s\S]*?<\/\1>/g, ' ');
  for (let i = 0; i < 6; i++) t = t.replace(/\{[^{}]*\}/g, ' ');
  t = t.replace(/<[^>]*>/g, '\n');
  for (const line of t.split('\n')) {
    const s = line.replace(/&nbsp;|&amp;/g, ' ').replace(/\s+/g, ' ').trim();
    if (s.length >= 2 && /\p{L}/u.test(s)) text.add(s);
  }
  // Names in option lists the markup loops over (languages, countries).
  for (const m of scripts.matchAll(/const\s+\w*OPTS\w*\s*=\s*\[([\s\S]*?)\];/g)) {
    // Every quoted string in turn (a short one like '/' keeps the pairing), then the names.
    for (const q of m[1].matchAll(/'((?:[^'\\]|\\.)*)'/g)) if (q[1].length >= 3 && /\p{L}{3}/u.test(q[1])) text.add(q[1]);
  }
  // Lists of rows built in the script (body stats, chart metrics): their labels.
  _labels(scripts, keys, text);
  // And lists imported from the app's own modules (the nutrients).
  for (const m of scripts.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"](\.[^'"]+\.js)['"]/g)) {
    const file = resolve(ROOT, dirname(rel), m[2]);
    if (!existsSync(file)) continue;
    const mod = readFileSync(file, 'utf8');
    for (const name of m[1].split(',').map(x => x.trim().split(/\s+as\s+/)[0]).filter(Boolean)) {
      // `export const X = [` or `const X = [` exported later.
      const at = mod.search(new RegExp(`(?:export\\s+)?const\\s+${name}\\s*=\\s*\\[`));
      if (at < 0) continue;
      const end = mod.indexOf('\n];', at);
      if (end > at) _labels(mod.slice(at, end), keys, text);
    }
  }
  return { keys, text };
}

/** `label: '...'`, `labelKey: '...'` and `label: tr(ns, key, 'English')` in code. */
function _labels(code, keys, text) {
  for (const m of code.matchAll(/\blabel\s*:\s*'((?:[^'\\]|\\.){2,})'/g)) if (/\p{L}/u.test(m[1])) text.add(m[1]);
  for (const m of code.matchAll(/\blabelKey\s*:\s*'([\w.-]+)'/g)) keys.add(m[1]);
  for (const m of code.matchAll(/\blabel\s*:\s*tr\(\s*'[^']+'\s*,\s*'[^']+'\s*,\s*'((?:[^'\\]|\\.)+)'/g)) text.add(m[1]);
}

export function buildIndex() {
  const out = {};
  for (const key of sectionKeys()) {
    const keys = new Set(), text = new Set();
    for (const f of sectionFiles(key)) {
      const s = fileStrings(f);
      s.keys.forEach(k => keys.add(k));
      s.text.forEach(x => text.add(x));
    }
    out[key] = { keys: [...keys].sort(), text: [...text].sort() };
  }
  return out;
}

export const serialize = index => JSON.stringify(index, null, 1) + '\n';

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const next = serialize(buildIndex());
  if (process.argv.includes('--check')) {
    const now = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
    if (now !== next) { console.error('settings-search-index.json is out of date: run node scripts/gen-settings-search.mjs'); process.exit(1); }
    console.log('settings search index up to date');
  } else {
    writeFileSync(OUT, next);
    console.log(`wrote ${relative(ROOT, OUT)}`);
  }
}
