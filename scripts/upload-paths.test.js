/**
 * Guards for the private-subdirectory check on the /uploads static mount.
 *
 * BACKUPS_PATH defaults to a directory inside UPLOADS_PATH, and /uploads is
 * served before the auth middleware so an Android WebView <img> can load
 * images without an Authorization header. Without this guard the whole
 * database dump was downloadable by anyone who could reach the server.
 *
 * The obvious implementation, a prefix route on '/uploads/backups', is
 * wrong, and the vectors below are why: express.static percent-decodes a
 * path before opening the file while a router prefix matches the raw path,
 * so the two disagree on exactly the inputs an attacker chooses.
 *
 * Imports lib/upload-paths.js, which has no db.js dependency, so this runs
 * for real rather than skipping for want of a native binding.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'uploads-'));
process.env.UPLOADS_PATH = tmpRoot;

let mod = null;
try {
  mod = await import('../server/lib/upload-paths.js');
} catch (e) {
  console.log(`[upload-paths] skipping: ${e.message.split('\n')[0]}`);
}

test('blocks every known static-serve bypass for the backups directory', { skip: !mod }, () => {
  const { isPrivateUploadPath } = mod;
  const vectors = [
    '/backups/x.zip',
    '/backups//x.zip',
    '//backups/x.zip',          // leaks against a prefix route
    '/%62ackups/x.zip',         // leaks against a prefix route
    '/back%75ps/x.zip',         // leaks against a prefix route
    '/BACKUPS/x.zip',           // case-insensitive filesystems
    '/./backups/x.zip',
    '/other/../backups/x.zip',
    '/other/%2e%2e/backups/x.zip',
    '/backups',                 // the directory itself
  ];
  for (const v of vectors) {
    assert.equal(isPrivateUploadPath(v), true, `should block ${v}`);
  }
});

test('leaves genuinely public assets alone', { skip: !mod }, () => {
  const { isPrivateUploadPath } = mod;
  // A sibling whose name merely starts with the private one must not be
  // caught: prefix matching on the string would swallow it.
  for (const v of ['/avatar.jpg', '/recipes/photo.jpg', '/backups-old/note.txt']) {
    assert.equal(isPrivateUploadPath(v), false, `should serve ${v}`);
  }
});

test('fails closed on garbage input', { skip: !mod }, () => {
  const { isPrivateUploadPath } = mod;
  assert.equal(isPrivateUploadPath('/%E0%A4%A'), true, 'malformed encoding must not fall through');
  assert.equal(isPrivateUploadPath(null), true);
  assert.equal(isPrivateUploadPath(undefined), true);
});

test('the guard runs before express.static, or it never fires', { skip: !mod }, () => {
  const src = fs.readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
  const guard = src.indexOf('isPrivateUploadPath(req.path)');
  const statik = src.indexOf("router.use('/uploads', express.static");
  assert.ok(guard > -1, 'the guard must be wired into the uploads mount');
  assert.ok(guard < statik, 'the guard must be registered before the static handler');
  // Specifically NOT a prefix route, which is bypassable.
  assert.doesNotMatch(src, /router\.use\('\/uploads\/backups'/);
});
