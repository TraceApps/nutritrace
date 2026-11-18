/**
 * Settings search finds every setting (the search check after #332).
 *
 * Search matched a hand-written keyword list one keyword at a time, and 20
 * settings couldn't be found at all (Delete My Account, Daily Targets, the
 * nutrients, units, Calories Burned in Statistics, ...), with 147 more only
 * by one word. Sections are now searched by what they show
 * (scripts/gen-settings-search.mjs), and every word typed has to be there.
 *
 * - The index is up to date with the Settings files (regenerate it after
 *   adding a setting: node scripts/gen-settings-search.mjs).
 * - Every Settings file is part of a section's search.
 * - Every setting label is found by its full text, in its own section.
 * - What people type finds the right section.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { buildIndex, serialize, sectionKeys, sectionFiles, fileStrings } from './gen-settings-search.mjs';
import { sectionHaystacks, sectionMatches, queryWords } from '../src/lib/settings-search.js';

const read = p => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const en = JSON.parse(read('src/i18n/en.json'));
const t = k => k.split('.').reduce((o, p) => o?.[p], en) ?? k;
const settingsSrc = read('src/routes/Settings.svelte');
const block = settingsSrc.slice(settingsSrc.indexOf('const SECTION_KEYWORDS = {') + 'const SECTION_KEYWORDS = '.length);
const KEYWORDS = Function(`return (${block.slice(0, block.indexOf('\n  };') + 4)})`)();
const metaBlock = settingsSrc.slice(settingsSrc.indexOf('const SECTION_META = {') + 'const SECTION_META = '.length);
const META = Function(`return (${metaBlock.slice(0, metaBlock.indexOf('\n  };') + 4)})`)();
const INDEX = JSON.parse(read('src/lib/settings-search-index.json'));
const HAY = sectionHaystacks(INDEX, {
  keywords: KEYWORDS,
  titles: Object.fromEntries(Object.entries(META).map(([k, m]) => [k, t(m.titleKey)])),
  translate: t, english: t,
});
const found = q => Object.keys(HAY).filter(k => sectionMatches(q, HAY[k]));

test('the search index is up to date with the Settings files', () => {
  assert.equal(read('src/lib/settings-search-index.json'), serialize(buildIndex()),
    'run: node scripts/gen-settings-search.mjs');
});

test('every Settings file is searched as part of a section', () => {
  const reached = new Set(sectionKeys().flatMap(sectionFiles));
  const generic = new Set(['src/components/settings/SettingRow.svelte', 'src/components/settings/Toggle.svelte']);
  for (const dir of ['src/routes/settings', 'src/components/settings']) {
    for (const f of readdirSync(new URL(`../${dir}`, import.meta.url)).filter(f => f.endsWith('.svelte'))) {
      const rel = `${dir}/${f}`;
      if (generic.has(rel)) continue;
      assert.ok(reached.has(rel), `${rel} isn't reached from any section's page`);
    }
  }
  assert.ok(reached.has('src/components/two-step/TwoStepSettings.svelte'), 'two-step sign-in, in Profile');
  for (const key of sectionKeys()) assert.ok(INDEX[key], `no index for ${key}`);
});

test('every setting label is found by its full text, in its section', () => {
  const missed = [];
  for (const key of sectionKeys()) {
    for (const f of sectionFiles(key)) {
      const src = read(f).replace(/<(span|i)\b[^>]*material-symbols[^>]*>[\s\S]*?<\/\1>/g, ' ');
      // Labels and titles a person reads: <... class="...label|title..."> and <SettingRow label=...>.
      for (const m of src.matchAll(/class="[\w-]*(?:label|title)[\w-]*[^"]*"[^>]*>([\s\S]*?)<\/(?:span|div|label|p|h\d)>/g)) {
        const text = m[1].replace(/\{\$_\(\s*'([^']+)'[^)]*\)\}/g, (_, k) => t(k)).replace(/\{[^}]*\}/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        if (!text || !queryWords(text).length || text.length > 80) continue;
        if (!found(text).includes(key)) missed.push(`${key}: "${text}" (${f})`);
      }
    }
  }
  assert.deepEqual(missed, []);
});

test('what people type finds the right section', () => {
  const cases = {
    'delete my account': 'profile', delete: 'profile', 'daily targets': 'diary', targets: 'diary',
    protein: 'nutrients', sodium: 'nutrients', caffeine: 'nutrients', kj: 'regional', kilojoules: 'regional',
    kg: 'regional', lbs: 'regional', miles: 'regional', celsius: 'regional', 'calories burned': 'statistics',
    waist: 'bodyStats', neck: 'statistics', ukrainian: 'connectedServices', ukraine: 'connectedServices',
    german: 'regional', deutsch: 'regional', 'auto backup': 'backup', 'local mode': 'serverConnection',
    offline: 'serverConnection', bedtime: 'notifications', 'linked accounts': 'profile', category: 'categories',
    'dark mode': 'appearance', 'regional & units': 'regional', 'calorie goals': 'goals', 'ai assistant': 'ai',
    'backup & restore': 'backup', 'email (smtp)': 'email', 'import all recipes': 'connectedServices',
    'garmin personal api key': 'wellness', 'two step sign in': 'profile', '2fa': 'profile', 'search country': 'connectedServices',
    'sign out everywhere': 'profile', 'api tokens': 'apiTokens',
  };
  const wrong = Object.entries(cases).filter(([q, key]) => !found(q).includes(key)).map(([q, key]) => `${q} -> ${key} (found: ${found(q).join(', ') || 'nothing'})`);
  assert.deepEqual(wrong, []);
  assert.deepEqual(found('zzqx-nothing'), []);
  // Words match from their start: "fast" is Fasting, not every "breakfast".
  assert.ok(!sectionMatches('fast', ' breakfast '));
  assert.ok(sectionMatches('fast', ' fasting '));
});

test("a section's own words come from its files, with option names and labels built in code", () => {
  assert.ok(fileStrings('src/routes/settings/Nutrients.svelte').text.has('Protein'), 'the nutrients list, imported');
  assert.ok(fileStrings('src/routes/settings/BodyStats.svelte').text.has('Waist'));
  assert.ok(fileStrings('src/routes/settings/ConnectedServices.svelte').text.has('Ukrainian'), 'an option list');
  assert.ok(![...fileStrings('src/routes/settings/BodyStats.svelte').text].includes('drag_indicator'), 'icons are not text');
});

test('translation formats and code are not searchable words', () => {
  const hay = sectionHaystacks({ x: { keys: ['k'], text: [] } }, { translate: () => '{count, plural, one {# token} other {# tokens}}' });
  assert.ok(hay.x.includes(' tokens '));
  for (const w of ['plural', 'other', 'count']) assert.ok(!hay.x.includes(` ${w} `), w);
  const ph = sectionHaystacks({ x: { keys: ['k'], text: [] } }, { translate: () => 'Export failed: {error}' });
  assert.ok(!sectionMatches('error', ph.x), 'a placeholder name is not a word');
  assert.ok(sectionMatches('export', ph.x));
  const app = INDEX.appearance.text.join('|');
  assert.ok(!/value:|label:/.test(app), 'option lists are read string by string');
});
