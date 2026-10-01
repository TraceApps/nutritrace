import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const html = read('../index.html');
const vite = read('../vite.config.js');
const startTag = '<script data-base-path-fallback>';
const start = html.indexOf(startTag);
const end = html.indexOf('</script>', start);
const bootstrap = start < 0 || end < 0 ? undefined : html.slice(start + startTag.length, end);

function resolveRawShellConfig(scriptURL, existingConfig) {
  const window = {};
  if (existingConfig) window.__NT_CONFIG__ = existingConfig;
  runInNewContext(bootstrap, {
    URL,
    window,
    navigator: { serviceWorker: { controller: scriptURL ? { scriptURL } : null } },
  });
  return window.__NT_CONFIG__?.basePath;
}

test('the runtime config fallback is synchronous and precedes the app module', () => {
  assert.ok(bootstrap, 'index.html has a marked base-path bootstrap');
  assert.ok(html.indexOf('data-base-path-fallback') < html.indexOf('type="module"'));
});

test('a controlled raw app shell derives root and subpath from its active worker', () => {
  assert.equal(resolveRawShellConfig('https://example.test/sw.js'), '');
  assert.equal(resolveRawShellConfig('https://example.test/nutritrace/sw.js'), '/nutritrace');
  assert.equal(resolveRawShellConfig('https://example.test/apps/nutritrace/sw.js'), '/apps/nutritrace');
});

test('server-injected config wins and an uncontrolled page does not invent one', () => {
  const serverConfig = { basePath: '/server-configured' };
  assert.equal(resolveRawShellConfig('https://example.test/nutritrace/sw.js', serverConfig), serverConfig.basePath);
  assert.equal(resolveRawShellConfig(null), undefined);
});

test('the offline app shell and its bundled assets remain precached', () => {
  assert.ok(vite.includes("globPatterns: ['**/*.{js,mjs,css,html,woff2,woff,ttf,"));
  assert.ok(vite.includes("navigateFallback: 'index.html'"));
});
