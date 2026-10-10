/**
 * Every surface you cannot move has a rule that moves it off the
 * crease.
 *
 * A diary, a chart or a photo is free to cross a fold: it can be scrolled or
 * panned. A dialog, a sheet, a picker or the Trace panel cannot, so each one is
 * named here, and a new one gets noticed when it is added rather than when
 * someone unfolds a phone.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const css = readFileSync(new URL('../src/styles/fold.css', import.meta.url), 'utf8');

test('the book rules cover every fixed surface', () => {
  for (const sel of ['.dialog-backdrop', '.sheet-backdrop', '.as-backdrop', '.tp-backdrop', '.ai-panel']) {
    assert.match(css, new RegExp(`html\\.fold-book [^{]*\\${sel}`), `book: ${sel}`);
  }
});

test('the tabletop rules cover every fixed surface', () => {
  for (const sel of ['.dialog-backdrop', '.tp-backdrop', '.sheet-panel', '.as-panel', '.ai-panel']) {
    assert.match(css, new RegExp(`html\\.fold-tabletop [^{]*\\${sel}`), `tabletop: ${sel}`);
  }
});

test('the rules name classes this app actually has', () => {
  // A rule written against another Trace app's class names would be silently
  // dead here, which is the one failure a stylesheet never reports.
  const used = [...css.matchAll(/html\.fold-(?:book|tabletop) ([^{]+)\{/g)]
    .flatMap(m => m[1].split(',').map(x => x.trim()))
    .flatMap(sel => sel.match(/\.[a-z-]+/g) || []);
  const src = ['src/components', 'src/routes', 'src/styles']
    .map(d => new URL(`../${d}/`, import.meta.url).pathname);
  for (const sel of new Set(used)) {
    const hits = execSync(`grep -rl "${sel.slice(1)}" ${src.join(' ')} || true`, { encoding: 'utf8' }).trim();
    assert.ok(hits, `${sel} is not used anywhere in this app`);
  }
});

test('the rules read the crease rather than guessing where it is', () => {
  assert.doesNotMatch(css, /50vw|50dvw/);
  assert.match(css, /var\(--fold-start\)/);
  assert.match(css, /var\(--fold-end\)/);
});

test('Settings splits at the crease, and measures where the page starts', () => {
  const settings = readFileSync(new URL('../src/routes/Settings.svelte', import.meta.url), 'utf8');
  assert.match(settings, /foldRailW >= 200/);
  assert.match(settings, /paneW - foldRailW >= 320/);
  assert.match(settings, /\.settings-two-pane\.fold-snap/);
  assert.match(settings, /getBoundingClientRect\(\)/);
  // The store is read in the instance script; a reactive statement in the
  // module block does not compile at all.
  const instance = settings.slice(settings.indexOf('<script>'));
  assert.ok(instance.includes('$fold'), 'the fold is read where components can read it');
});
