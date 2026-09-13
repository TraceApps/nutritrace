/**
 * server/lib/upload-paths.js
 *
 * Guards for the files served out of UPLOADS_PATH.
 *
 * Deliberately has NO db.js import, so the path logic below can be unit
 * tested directly without a compiled better-sqlite3 native binding.
 */
import path from 'path';

const uploadsPath = process.env.UPLOADS_PATH || './uploads';

/**
 * Subdirectories under UPLOADS_PATH whose contents must never be served by
 * the static handler.
 *
 * backups: BACKUPS_PATH defaults to a directory INSIDE UPLOADS_PATH, and
 * /uploads is mounted ahead of the auth middleware so an Android WebView
 * <img> can load images without an Authorization header. That made every
 * full-backup archive downloadable by anyone who could reach the server and
 * guess the filename, even though every /api/full-backup route is
 * admin-only. The archive holds the whole database dump, so this was
 * strictly more than the admin API itself would hand over.
 */
const PRIVATE_SUBDIRS = ['backups'];

/**
 * True when a request path under the /uploads mount would land inside a
 * private subdirectory.
 *
 * Works on the RESOLVED path, not the URL text, because those two disagree
 * in ways an attacker controls. express.static percent-decodes before
 * looking up the file, while a router.use('/uploads/backups') prefix
 * matches the raw path, so `/uploads/%62ackups/x.zip`,
 * `/uploads/back%75ps/x.zip` and `/uploads//backups/x.zip` all slip past a
 * prefix guard and are then happily served. Decoding once (which is what
 * serve-static does) and resolving collapses every one of those to the same
 * absolute path.
 *
 * @param {string} reqPath path below the mount, e.g. '/backups/a.zip'
 */
export function isPrivateUploadPath(reqPath) {
  if (typeof reqPath !== 'string') return true;
  let decoded;
  try {
    decoded = decodeURIComponent(reqPath);
  } catch {
    // Malformed encoding: serve-static will reject it too, but refuse here
    // rather than guess at what it was meant to say.
    return true;
  }
  if (decoded.includes('\0')) return true;
  const root = path.resolve(uploadsPath);
  const abs = path.resolve(root, '.' + (decoded.startsWith('/') ? decoded : '/' + decoded));
  // Compared case-insensitively because the filesystem may be: on APFS or
  // NTFS a request for /BACKUPS/x.zip resolves to the same file, and a
  // case-sensitive guard would wave it through to express.static.
  const lower = abs.toLowerCase();
  return PRIVATE_SUBDIRS.some((sub) => {
    const dir = path.join(root, sub).toLowerCase();
    return lower === dir || lower.startsWith(dir + path.sep);
  });
}
