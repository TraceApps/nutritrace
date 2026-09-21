/**
 * release-credits.mjs: the Co-authored-by trailers a release commit owes.
 *
 * People who report a bug or suggest a feature are thanked in the changelog,
 * and that thanks travels into main with the file. Commit credit does not:
 * a squash merge collects the trailers that already exist on the branch, so
 * unless a reporter's name was on a commit, they never appear as a
 * contributor at all. This reads the handles out of a release's changelog
 * section and prints the trailers that release commit should carry.
 *
 *   node scripts/release-credits.mjs 1.3.1
 *
 * Paste the output at the end of the squash commit message (after a blank
 * line). Resolving a handle needs the gh CLI; a handle it can't resolve is
 * printed as a comment so nobody is dropped silently.
 */
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const version = process.argv[2];
if (!version) {
  console.error('usage: node scripts/release-credits.mjs <version>');
  process.exit(1);
}

const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
const start = changelog.indexOf(`## [${version}]`);
if (start < 0) {
  console.error(`No section for ${version} in CHANGELOG.md`);
  process.exit(1);
}
const rest = changelog.slice(start + 1);
const end = rest.indexOf('\n## [');
const section = end < 0 ? rest : rest.slice(0, end);

// @handles, minus the ones that are not people to credit.
const SKIP = new Set(['thebigjoe1', 'dependabot', 'github-actions', 'weblate']);
const handles = [...new Set((section.match(/@[A-Za-z0-9][A-Za-z0-9-]{0,38}/g) || [])
  .map(h => h.slice(1))
  .filter(h => !SKIP.has(h.toLowerCase())))];

if (!handles.length) {
  console.log(`# ${version}: nobody outside the maintainer is credited in the changelog.`);
  process.exit(0);
}

for (const handle of handles) {
  try {
    const raw = execSync(`gh api users/${handle} --jq '[.id, .name // .login] | @tsv'`, { encoding: 'utf8' }).trim();
    const [id, name] = raw.split('\t');
    console.log(`Co-authored-by: ${name} <${id}+${handle}@users.noreply.github.com>`);
  } catch {
    console.log(`# could not resolve @${handle}: add their trailer by hand, or drop them if the handle is wrong`);
  }
}
