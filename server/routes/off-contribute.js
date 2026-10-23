/**
 * POST /api/off/contribute - share a product with Open Food Facts for the
 * signed-in person, with their own Open Food Facts login (#284).
 *
 * Multipart body: user_id, password, fields (JSON of the product fields),
 * and an optional image. The request goes to Open Food Facts only, never to
 * an address the caller names, and only the product fields in
 * lib/off-contribute.js pass. The password is never logged.
 *
 * OFF_SHARE_STAGING=1 sends to Open Food Facts' staging server instead
 * (world.openfoodfacts.net), for tests.
 */
import { Router } from 'express';
import multer from 'multer';
import { requireAuth } from '../middleware/auth.js';
import { makeRateLimiter } from '../middleware/rate-limit.js';
import { isLocalOffOnly } from '../lib/off-local.js';
import { detectImageTypeFromBuffer } from '../lib/image-magic.js';
import { shareWithOff, OffShareError, OFF_HOST, OFF_STAGING_HOST } from '../lib/off-contribute.js';
import { APP_VERSION } from './version-source.js';
import { logger } from '../logger.js';

const router = Router();
const limit = makeRateLimiter({ max: 20, windowMs: 60_000, label: 'off-contribute' });
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 10, fieldSize: 64 * 1024 },
});
// Open Food Facts asks every app to name itself (AppName/Version (contact)).
const USER_AGENT = `NutriTrace/${APP_VERSION} (https://github.com/TraceApps/nutritrace)`;

function readUpload(req, res, next) {
  upload.single('image')(req, res, (err) => {
    if (!err) return next();
    const tooBig = err.code === 'LIMIT_FILE_SIZE';
    res.status(tooBig ? 413 : 400).json({ error: tooBig ? 'That photo is larger than 10 MB.' : 'That request could not be read.' });
  });
}

router.post('/contribute', limit, requireAuth, readUpload, async (req, res) => {
  if (isLocalOffOnly()) {
    return res.status(403).json({ error: 'OFF contributions are disabled on this server (air-gap mode).', kind: 'off_local_only' });
  }
  let fields;
  try { fields = JSON.parse(req.body?.fields || '{}'); } catch { fields = null; }
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    return res.status(400).json({ error: 'That request could not be read.' });
  }
  // A file that isn't a picture is left out: the product still goes, and
  // the answer says the photo didn't.
  let image = null, photoRefused = false;
  if (req.file) {
    const type = detectImageTypeFromBuffer(req.file.buffer);
    if (type) image = new Blob([req.file.buffer], { type: `image/${type}` });
    else photoRefused = true;
  }
  try {
    const out = await shareWithOff({
      fetchImpl: fetch,
      host: process.env.OFF_SHARE_STAGING === '1' ? OFF_STAGING_HOST : OFF_HOST,
      userId: req.body.user_id,
      password: req.body.password,
      fields,
      image,
      userAgent: USER_AGENT,
    });
    if (photoRefused) out.photo = 'failed';
    if (out.photo === 'failed') logger.warn('[off-share] product sent, photo refused');
    res.json(out);
  } catch (e) {
    const err = e instanceof OffShareError ? e : new OffShareError('unreachable');
    logger.warn(`[off-share] ${err.kind}${err.detail ? `: ${err.detail}` : ''}`);
    res.status(err.kind === 'unreachable' ? 502 : 422).json({ error: err.message, kind: err.kind, detail: err.detail });
  }
});

export default router;
