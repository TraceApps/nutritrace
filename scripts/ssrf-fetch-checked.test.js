// fetchChecked(): the one way the server fetches an address a user chose.
// The same test in all four Trace apps, like server/lib/ssrf-guard.js.
import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import dns from 'node:dns/promises';
import { fetchChecked, serviceBase, isLinkLocalOrCloudMeta, isPrivateOrLoopback, isSameServer, readBody } from '../server/lib/ssrf-guard.js';

async function server(handler) {
  const s = http.createServer(handler);
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  return { port: s.address().port, close: () => s.close() };
}

test('connects only to the address it checked, never a second lookup', async () => {
  // The check sees 127.0.0.1 for a name the real resolver doesn't know.
  // Reaching the local server proves the connection used that answer
  // instead of resolving the name again (where an attacker's DNS could
  // answer differently).
  const s = await server((req, res) => { res.writeHead(200); res.end('pinned'); });
  const real = dns.lookup;
  dns.lookup = async (host, opts) => host === 'pinned.invalid'
    ? (opts?.all ? [{ address: '127.0.0.1', family: 4 }] : { address: '127.0.0.1', family: 4 })
    : real(host, opts);
  try {
    const res = await fetchChecked(`http://pinned.invalid:${s.port}/`, {}, { allowPrivate: true });
    assert.equal(await res.text(), 'pinned');
  } finally { dns.lookup = real; s.close(); }
});

test('refuses the home network unless allowed, and cloud metadata always', async () => {
  const s = await server((req, res) => { res.writeHead(200); res.end('inside'); });
  try {
    await assert.rejects(fetchChecked(`http://127.0.0.1:${s.port}/`, {}, { allowPrivateEnvHint: 'ALLOW_PRIVATE_TEST' }), /ALLOW_PRIVATE_TEST/);
    assert.equal(await (await fetchChecked(`http://127.0.0.1:${s.port}/`, {}, { allowPrivate: true })).text(), 'inside');
    await assert.rejects(fetchChecked('http://169.254.169.254/latest/meta-data/', {}, { allowPrivate: true }), /cloud-metadata/);
  } finally { s.close(); }
});

test('checks every redirect hop, and follows none unless asked', async () => {
  const inside = await server((req, res) => { res.writeHead(200); res.end('inside'); });
  const hop = await server((req, res) => {
    const to = req.url === '/meta' ? 'http://169.254.169.254/' : `http://127.0.0.1:${inside.port}/`;
    res.writeHead(302, { location: to }); res.end();
  });
  try {
    // No redirects asked for: the 3xx comes back as it is.
    assert.equal((await fetchChecked(`http://127.0.0.1:${hop.port}/`, {}, { allowPrivate: true })).status, 302);
    // Followed, each hop checked: allowed inside, cloud metadata never.
    const ok = await fetchChecked(`http://127.0.0.1:${hop.port}/`, {}, { allowPrivate: true, maxRedirects: 3 });
    assert.equal(await ok.text(), 'inside');
    await assert.rejects(fetchChecked(`http://127.0.0.1:${hop.port}/meta`, {}, { allowPrivate: true, maxRedirects: 3 }), /cloud-metadata/);
  } finally { hop.close(); inside.close(); }
});

test('stops after the redirect limit', async () => {
  let n = 0;
  const loop = await server((req, res) => { n++; res.writeHead(302, { location: `/again${n}` }); res.end(); });
  try {
    const res = await fetchChecked(`http://127.0.0.1:${loop.port}/`, {}, { allowPrivate: true, maxRedirects: 2 });
    assert.equal(res.status, 302);
    assert.equal(n, 3);
  } finally { loop.close(); }
});

test('redirects keep or drop the request body as fetch does', async () => {
  const seen = [];
  const s = await server((req, res) => {
    let raw = ''; req.on('data', c => raw += c); req.on('end', () => {
      seen.push(`${req.method} ${req.url} ${raw}`);
      if (req.url === '/307') { res.writeHead(307, { location: '/end' }); return res.end(); }
      if (req.url === '/302') { res.writeHead(302, { location: '/end' }); return res.end(); }
      res.writeHead(200); res.end('ok');
    });
  });
  try {
    const post = { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":1}' };
    await fetchChecked(`http://127.0.0.1:${s.port}/307`, post, { allowPrivate: true, maxRedirects: 3 });
    await fetchChecked(`http://127.0.0.1:${s.port}/302`, post, { allowPrivate: true, maxRedirects: 3 });
    assert.deepEqual(seen, ['POST /307 {"a":1}', 'POST /end {"a":1}', 'POST /302 {"a":1}', 'GET /end ']);
  } finally { s.close(); }
});

test('credentials stay with their origin on a redirect', async () => {
  const seen = [];
  const other = await server((req, res) => { seen.push(`other auth=${req.headers.authorization || '-'} token=${req.headers['x-emby-token'] || '-'}`); res.writeHead(200); res.end('other'); });
  const first = await server((req, res) => {
    seen.push(`first auth=${req.headers.authorization || '-'}`);
    // localhost vs 127.0.0.1: same machine, different origin.
    res.writeHead(307, { location: `http://localhost:${other.port}/` }); res.end();
  });
  try {
    const headers = { authorization: 'Bearer secret', 'x-emby-token': 'tok' };
    const res = await fetchChecked(`http://127.0.0.1:${first.port}/`, { headers }, { allowPrivate: true, maxRedirects: 3 });
    assert.equal(await res.text(), 'other');
    // Authorization dropped across origins; a custom header is the caller's to protect...
    assert.deepEqual(seen, ['first auth=Bearer secret', 'other auth=- token=tok']);
    // ...which sameOrigin does, by not following at all.
    const stopped = await fetchChecked(`http://127.0.0.1:${first.port}/`, { headers }, { allowPrivate: true, maxRedirects: 3, sameOrigin: true });
    assert.equal(stopped.status, 307);
    assert.equal(seen.length, 3);
  } finally { first.close(); other.close(); }
});

test('bracketed IPv6 addresses work when allowed', async () => {
  const s = http.createServer((req, res) => { res.writeHead(200); res.end('v6'); });
  await new Promise(r => s.listen(0, '::1', r));
  try {
    assert.equal(await (await fetchChecked(`http://[::1]:${s.address().port}/`, {}, { allowPrivate: true })).text(), 'v6');
    await assert.rejects(fetchChecked(`http://[::1]:${s.address().port}/`), /Private/);
  } finally { s.close(); }
});

test('every cloud metadata address is always refused', () => {
  for (const ip of ['169.254.169.254', '100.100.100.200', '168.63.129.16', 'fd00:ec2::254', '::ffff:169.254.169.254', '64:ff9b::a9fe:a9fe', '64:ff9b::169.254.169.254']) {
    assert.equal(isLinkLocalOrCloudMeta(ip), true, ip);
  }
  for (const ip of ['64:ff9b::7f00:1', '::ffff:10.0.0.1', '192.0.0.8', '224.0.0.1', '255.255.255.255', 'ff02::1']) {
    assert.equal(isPrivateOrLoopback(ip), true, ip);
  }
  assert.equal(isPrivateOrLoopback('64:ff9b::808:808'), false, 'NAT64 of a public address');
  // Fake-IP DNS (Clash, sing-box) answers every public name with 198.18.x.x.
  assert.equal(isPrivateOrLoopback('198.18.0.7'), false);
});

test('a service address keeps only its origin and path', () => {
  assert.equal(serviceBase('http://ntfy.lan:8080/'), 'http://ntfy.lan:8080');
  assert.equal(serviceBase('http://docker:2375/containers/json?x='), 'http://docker:2375/containers/json');
  assert.equal(serviceBase('https://jelly.example/jf#frag'), 'https://jelly.example/jf');
  assert.equal(serviceBase('ftp://x'), null);
  assert.equal(serviceBase('not a url'), null);
});

test('a redirect stays on the same server only for its origin or an https upgrade', () => {
  assert.equal(isSameServer('http://music.lan/rest/ping', 'http://music.lan/rest/x'), true);
  assert.equal(isSameServer('http://music.lan/rest/ping', 'https://music.lan/rest/ping'), true);
  assert.equal(isSameServer('http://music.lan:4533/', 'https://music.lan/'), false, 'a port changes the server');
  assert.equal(isSameServer('https://music.lan/', 'http://music.lan/'), false, 'never a downgrade');
  assert.equal(isSameServer('http://music.lan/', 'https://evil.example/'), false);
  assert.equal(isSameServer('http://127.0.0.1:1/', 'http://localhost:1/'), false);
});

test('control characters in an address are refused before parsing', async () => {
  // A tab, CR or LF would vanish in parsing and turn ".\t." into "..".
  for (const u of ['http://127.0.0.1/api/.\t./admin', 'http://127.0.0.1/a\nb', 'http://127.0.0.1/a\rb', 'http://127.0.0.1/\u0000'])
    await assert.rejects(fetchChecked(u, {}, { allowPrivate: true }), /Invalid URL/, JSON.stringify(u));
});

test('a reply body is read up to a cap', async () => {
  const s = await server((req, res) => { res.writeHead(200); res.end('x'.repeat(5000)); });
  try {
    assert.equal((await readBody(await fetchChecked(`http://127.0.0.1:${s.port}/`, {}, { allowPrivate: true }), 10000)).length, 5000);
    await assert.rejects(async () => readBody(await fetchChecked(`http://127.0.0.1:${s.port}/`, {}, { allowPrivate: true }), 1000), /too large/);
  } finally { s.close(); }
});
