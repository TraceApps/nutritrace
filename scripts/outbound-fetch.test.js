// The server's outbound fetch (server/lib/proxy-agent.js). The same test in
// all four Trace apps. Each case runs in a child process: the crash it
// guards against can't be caught, and the module changes globals.
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';

const AGENT = JSON.stringify(new URL('../server/lib/proxy-agent.js', import.meta.url).href);

function run(code, env = {}) {
  const clean = { ...process.env };
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy']) delete clean[k];
  return spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 20000, env: { ...clean, ...env } });
}

test('a site that closes while the reply is still being read does not crash the server', () => {
  // Node's own fetch (undici 7 in Node 24) dies on an uncatchable
  // assert(!this.paused) here (TraceApps/cooktrace#96).
  const r = run(`
    import net from 'node:net';
    await import(${AGENT});
    const body = Buffer.alloc(64 * 1024, 0x61);
    const s = net.createServer(sock => sock.once('data', () => {
      sock.write('HTTP/1.1 200 OK\\r\\nContent-Length: ' + body.length + '\\r\\nConnection: close\\r\\n\\r\\n');
      sock.write(body);
      sock.end();
    }));
    await new Promise(r => s.listen(0, '127.0.0.1', r));
    const res = await fetch('http://127.0.0.1:' + s.address().port + '/');
    await new Promise(r => setTimeout(r, 300));
    console.log('read', (await res.arrayBuffer()).byteLength);
    s.close();`);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /read 65536/);
});

// An upload the way the server builds one (an Open Food Facts photo, a
// voice note to transcribe): a FormData with a file, sent with fetch.
// PROXY=1 makes the test server the forward proxy, set before the module
// loads as HTTP_PROXY is in the server's environment.
const UPLOAD = `
  import http from 'node:http';
  const seen = [];
  const s = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('latin1');
    req.on('data', c => body += c);
    req.on('end', () => { seen.push({ url: req.url, type: req.headers['content-type'] || '', body }); res.end('ok'); });
  });
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  const port = s.address().port;
  if (process.env.PROXY) process.env.HTTP_PROXY = 'http://127.0.0.1:' + port;
  await import(${AGENT});
  const fd = new FormData();
  fd.append('code', '123');
  fd.append('imgupload', new Blob([Buffer.from('JPEGDATA')], { type: 'image/jpeg' }), 'photo.jpg');
  const res = await fetch(process.env.PROXY ? 'http://upload.example/upload' : 'http://127.0.0.1:' + port + '/upload', { method: 'POST', body: fd });
  await res.text();
  console.log(JSON.stringify(seen));
  s.close();`;

function upload(env) {
  const r = run(UPLOAD, env);
  assert.equal(r.status, 0, r.stderr);
  const seen = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.equal(seen.length, 1);
  const [req] = seen;
  assert.match(req.type, /^multipart\/form-data; boundary=/);
  assert.match(req.body, /name="code"\r\n\r\n123\r\n/);
  assert.match(req.body, /filename="photo\.jpg"/);
  assert.match(req.body, /JPEGDATA/);
  return req;
}

test('an upload goes out as multipart, with its file', () => {
  assert.equal(upload({}).url, '/upload');
});

test('behind a forward proxy, requests go through it and uploads stay multipart', () => {
  // A request through a proxy arrives with the full address in its first
  // line. With undici 8's fetch and Node's FormData, an upload here went
  // out as the text "[object FormData]".
  assert.equal(upload({ PROXY: '1' }).url, 'http://upload.example/upload');
});
