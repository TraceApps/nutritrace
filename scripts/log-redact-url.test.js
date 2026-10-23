/**
 * The server log never shows a secret from an outbound address.
 *
 * The proxy logged the full upstream URL when an answer was not 2xx, so a
 * USDA error put the person's api_key in the server log. Every log line
 * below is run with addresses that carry a key, a token, a password and a
 * user:password@ part; none of them may reach the line. The request itself
 * still goes to the address unchanged.
 */
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { redactUrl } from '../server/lib/redact-url.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const SECRET_URL = 'https://me:SECRETPW@api.nal.usda.gov/fdc/v1/foods/search?query=popcorn&api_key=SECRETKEY&token=SECRETTOK';

test('redactUrl hides keys, tokens, passwords and user info, and keeps the rest', () => {
  const r = redactUrl(SECRET_URL);
  assert.doesNotMatch(r, /SECRET|me:/);
  assert.match(r, /^https:\/\/\*\*\*@api\.nal\.usda\.gov\/fdc\/v1\/foods\/search\?/);
  assert.match(r, /query=popcorn/);
  assert.match(r, /api_key=\*\*\*/);
  for (const p of ['key', 'apiKey', 'access_token', 'password', 'client_secret', 'sig', 'X-Amz-Signature', 'auth']) {
    assert.doesNotMatch(redactUrl(`https://h.example/x?${p}=SECRET&q=1`), /SECRET/, p);
  }
  // Not a whole URL: still hidden.
  assert.equal(redactUrl('/api/x?token=SECRET&page=2'), '/api/x?token=***&page=2');
  assert.equal(redactUrl('ftp//a:SECRET@host'), 'ftp//***@host');
  assert.equal(redactUrl(undefined), '');
  // Nothing secret: unchanged.
  const plain = 'https://world.openfoodfacts.org/api/v2/product/123.json?fields=a,b';
  assert.equal(redactUrl(plain), plain);
});

test('redactUrl never changes the address it is given', () => {
  const s = SECRET_URL;
  redactUrl(s);
  assert.equal(s, SECRET_URL);
});

// Every single-line logger call in these files, run with a secret-carrying
// address for every value named like one (url, img_url, base, ...).
const FILES = ['../server/routes/proxy.js', '../server/routes/cooktrace.js', '../server/lib/image-localizer.js', '../server/lib/off-local.js']
  .filter(f => existsSync(new URL(f, import.meta.url)));

function loggedText(args) {
  const known = {
    redactUrl,
    getDownloadUrl: () => SECRET_URL,
    response: { status: 500, headers: { get: () => '' } },
    e: { message: 'boom' },
    req: { user: { id: 1 }, body: { path: '/api/pantry?token=SECRETTOK' } },
    buffer: { length: 1 },
    fs: { statSync: () => ({ size: 1 }) },
  };
  const scope = new Proxy({}, {
    has: (_t, k) => typeof k === 'string' && !(k in globalThis),
    get: (_t, k) => (k === Symbol.unscopables ? undefined
      : k in known ? known[k]
      : /url|base|href|target|endpoint/i.test(k) ? SECRET_URL : 'x'),
  });
  // eslint-disable-next-line no-new-func
  return new Function('scope', `with (scope) { return [${args}]; }`)(scope).map(String).join(' ');
}

test('no log line in the proxies prints a secret from an address', () => {
  let lines = 0;
  for (const f of FILES) {
    for (const m of read(f).matchAll(/logger\.(?:error|warn|info|debug)\((.*)\);\s*$/gm)) {
      const text = loggedText(m[1]);
      assert.doesNotMatch(text, /SECRET/, `${f}: ${m[0].trim()}\n  logs: ${text}`);
      lines++;
    }
  }
  assert.ok(lines > 0);
});

test('the proxy still requests the address as given, key and all', () => {
  const src = read('../server/routes/proxy.js');
  assert.match(src, /await fetchChecked\(url, \{/);
  assert.match(src, /logger\.warn\(`\[proxy\] upstream \$\{response\.status\} for \$\{redactUrl\(url\)\}`\);/);
});

test('the forward proxy address in the startup log hides its password', () => {
  const mod = fileURLToPath(new URL('../server/lib/proxy-agent.js', import.meta.url));
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(mod)});`], {
    env: { PATH: process.env.PATH, HTTP_PROXY: 'http://me:SECRETPW@127.0.0.1:3128', HTTPS_PROXY: 'http://me:SECRETPW@127.0.0.1:3128' },
    encoding: 'utf8', timeout: 20000,
  });
  const out = r.stdout + r.stderr;
  assert.match(out, /forward-proxy env vars detected/, out);
  assert.doesNotMatch(out, /SECRETPW/, out);
  assert.match(out, /http:\/\/\*\*\*@127\.0\.0\.1:3128/);
});
