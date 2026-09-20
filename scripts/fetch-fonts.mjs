/**
 * Download a Google Fonts family as local files, one per script subset, and
 * emit @font-face blocks that keep Google's unicode-range split so a browser
 * still fetches only the scripts a page needs.
 *
 * Usage: node fetch-fonts.mjs <public/fonts dir> <slug> "<css2 query>"
 *   node fetch-fonts.mjs ../../nutritrace/public/fonts inter "family=Inter:wght@300..700"
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const [dir, slug, query] = process.argv.slice(2);
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const css = await (await fetch(`https://fonts.googleapis.com/css2?${query}&display=swap`, { headers: { 'User-Agent': UA } })).text();
if (!css.includes('@font-face')) throw new Error(`no @font-face for ${query}: ${css.slice(0, 200)}`);

mkdirSync(dir, { recursive: true });
const blocks = [];
// Each block is preceded by a /* subset */ comment.
const parts = css.split('/*').slice(1);
for (const part of parts) {
  const subset = part.slice(0, part.indexOf('*/')).trim();
  const body = part.slice(part.indexOf('*/') + 2);
  const url = (body.match(/src: url\(([^)]+)\)/) || [])[1];
  if (!url) continue;
  const family = (body.match(/font-family: '([^']+)'/) || [])[1];
  const style = (body.match(/font-style: ([^;]+);/) || [])[1] || 'normal';
  const weight = (body.match(/font-weight: ([^;]+);/) || [])[1] || '400';
  const range = (body.match(/unicode-range: ([^;]+);/) || [])[1];
  const file = `${slug}-${subset}.woff2`;
  const bytes = Buffer.from(await (await fetch(url, { headers: { 'User-Agent': UA } })).arrayBuffer());
  writeFileSync(join(dir, file), bytes);
  blocks.push([
    `/* ${family}: ${subset} */`,
    '@font-face {',
    `  font-family: '${family}';`,
    `  font-style: ${style};`,
    `  font-weight: ${weight};`,
    '  font-display: swap;',
    `  src: url(./${file}) format('woff2');`,
    range ? `  unicode-range: ${range};` : null,
    '}',
  ].filter(Boolean).join('\n'));
  console.log(`  ${file.padEnd(28)} ${(bytes.length / 1024).toFixed(0)} KB`);
}
writeFileSync(join(dir, `${slug}.generated.css`), blocks.join('\n\n') + '\n');
console.log(`  -> ${slug}.generated.css (${blocks.length} subsets)`);
