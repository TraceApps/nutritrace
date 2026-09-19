/**
 * Sheets and dialogs must stay below the status bar. The Android app draws
 * under it, so a panel capped only at a share of the screen (90vh, or
 * 100vh - 32px) can reach up under it once its content fills the cap,
 * which happens as soon as the keyboard shortens the screen (NutriTrace
 * #228: Body Stats' title and close button ended up under the status bar).
 * Every overlay panel's height cap has to take --safe-top into account.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = new URL('../src/', import.meta.url).pathname;
const walk = (d) => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
const esc = (c) => c.replace(/-/g, '\\-');
// The base rule for a class in a component's <style> (the first one, before any media query).
const baseRule = (css, cls) => (css.match(new RegExp(`(?:^|[\\s,}])\\.${esc(cls)}(?![\\w-])[^{}]*\\{([^}]*)\\}`)) || [])[1] || '';
// A tag ends at the first '>' outside {...}.
const tagEnd = (s, i) => { let d = 0; for (let j = i; j < s.length; j++) { if (s[j] === '{') d++; else if (s[j] === '}') d--; else if (s[j] === '>' && d === 0) return j + 1; } return s.length; };

function overlayPanels() {
  const found = [];
  for (const f of walk(SRC).filter((x) => x.endsWith('.svelte'))) {
    const s = readFileSync(f, 'utf8');
    const st = s.lastIndexOf('<style'); if (st < 0) continue;
    const css = s.slice(st); const markup = s.slice(0, st); const from = markup.lastIndexOf('</script>');
    for (const m of markup.slice(from).matchAll(/<(div|aside)\b/g)) {
      const i = from + m.index; const e = tagEnd(markup, i);
      const cls = (markup.slice(i, e).match(/class="([^"]*)"/) || [])[1] || '';
      const backdrop = cls.split(/\s+/).find((c) => /(^|-)(backdrop|overlay|scrim)$/.test(c));
      if (!backdrop || !/position:\s*fixed/.test(baseRule(css, backdrop))) continue;
      const child = markup.slice(e).match(/^\s*(?:<!--[\s\S]*?-->\s*)*<(?:div|form|section|aside)\b[^>]*class="([^"]+)"/);
      if (!child) continue;
      const panel = child[1].split(/\s+/)[0];
      const cap = (baseRule(css, panel).match(/max-height:\s*([^;]+);/) || [])[1];
      found.push({ where: `${f.split('/src/')[1]} .${panel}`, cap });
    }
  }
  return found;
}

test('every capped sheet or dialog keeps clear of the status bar', () => {
  const panels = overlayPanels();
  assert.ok(panels.some((p) => p.where.endsWith('ui/Sheet.svelte .sheet-panel')), 'found the shared Sheet');
  const unsafe = panels.filter((p) => p.cap && /vh/.test(p.cap) && !/safe-top/.test(p.cap)).map((p) => `${p.where}: ${p.cap}`);
  assert.deepEqual(unsafe, []);
});

test('the shared Sheet stays below the status bar', () => {
  const css = readFileSync(join(SRC, 'components/ui/Sheet.svelte'), 'utf8');
  assert.match(baseRule(css.slice(css.lastIndexOf('<style')), 'sheet-panel'), /max-height: min\(90dvh, calc\(100dvh - var\(--safe-top\) - 8px\)\);/);
});
