/**
 * The runtime Docker image copies server/ to /app and only the src/lib files
 * named in the Dockerfile to /src/lib. A server import of any other src/lib
 * file resolves in the repo and in every test here, then fails in the
 * container with ERR_MODULE_NOT_FOUND and the server never starts.
 *
 * #236 moved the Sleep Quality walk into src/lib/sleep-quality.js for
 * Google Health to share, and this was the only thing standing between
 * that change and a server that would not boot.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dockerfile = readFileSync(join(root, 'Dockerfile'), 'utf8');

function* jsFiles(dir) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* jsFiles(p);
    else if (p.endsWith('.js') || p.endsWith('.mjs')) yield p;
  }
}

const IMPORT = /(?:from\s+|import\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g;

/** Every src/ file the server loads, following src/ files' own relative imports. */
function srcFilesReachedFromServer() {
  const found = new Map(); // src path -> first server file that pulled it in
  const queue = [];
  for (const file of jsFiles(join(root, 'server'))) {
    for (const [, spec] of readFileSync(file, 'utf8').matchAll(IMPORT)) {
      const target = resolve(dirname(file), spec);
      if (relative(root, target).startsWith('src/')) queue.push([target, relative(root, file)]);
    }
  }
  while (queue.length) {
    const [target, via] = queue.shift();
    const rel = relative(root, target);
    if (found.has(rel)) continue;
    found.set(rel, via);
    for (const [, spec] of readFileSync(target, 'utf8').matchAll(IMPORT)) {
      queue.push([resolve(dirname(target), spec), rel]);
    }
  }
  return found;
}

test('every src/ file the server imports is copied into the image at the same relative spot', () => {
  const reached = srcFilesReachedFromServer();
  assert.ok(reached.size > 0, 'the scan found the known server -> src imports');
  for (const [rel, via] of reached) {
    const line = `COPY ${rel} /${rel}`;
    assert.ok(dockerfile.includes(line), `${via} imports ${rel}, but the Dockerfile has no "${line}"`);
  }
});

test('the scan sees both known server -> src imports', () => {
  const reached = srcFilesReachedFromServer();
  assert.ok(reached.has('src/lib/nutrition.js'));
  assert.ok(reached.has('src/lib/sleep-quality.js'));
});
