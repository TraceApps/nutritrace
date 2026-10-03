import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import crypto from 'crypto';
import fs from 'fs';
import { safeUploadExtension } from '../lib/upload-paths.js';
import { requireAuth } from '../middleware/auth.js';
import { makeRateLimiter } from '../middleware/rate-limit.js';
import { detectImageType } from '../lib/image-magic.js';

const uploadLimit = makeRateLimiter({ max: 60, windowMs: 60_000, label: 'upload' });


const uploadsPath = process.env.UPLOADS_PATH || './uploads';
fs.mkdirSync(uploadsPath, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsPath),
  filename: (req, file, cb) => {
    const ext = safeUploadExtension(file.mimetype, file.originalname);
    cb(null, `${Date.now()}-${crypto.randomBytes(12).toString('hex')}${ext}`);
  },
});

// A refused or oversized file is the caller's mistake, not the server falling
// over, so it answers 415 or 413 instead of reaching the error handler as a 500.
function refusedType(message) {
  return Object.assign(new Error(message), { status: 415 });
}
function uploadError(err, next, maxMb) {
  if (err?.code === 'LIMIT_FILE_SIZE') {
    return next(Object.assign(new Error(`That file is larger than this server accepts (${maxMb} MB).`), { status: 413 }));
  }
  if (err?.name === 'MulterError' && !err.status) err.status = 400;
  return next(err);
}

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(refusedType('Images only'));
  },
});

const router = Router();
router.use(requireAuth);

router.post('/', uploadLimit, (req, res, next) => {
  upload.single('file')(req, res, async (err) => {
    if (err) return uploadError(err, next, 10);
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    // Magic-byte validation. The MIME-type fileFilter above is client-controlled
    // and trivially spoofable — actually inspect the bytes we just wrote.
    let detected = null;
    try {
      detected = await detectImageType(req.file.path);
    } catch (e) {
      // Fall through to the rejection branch below.
    }
    if (!detected) {
      try { fs.unlinkSync(req.file.path); } catch {}
      return res.status(400).json({
        error: 'File is not a supported image (JPEG, PNG, WebP, GIF, HEIC, AVIF, BMP).',
      });
    }
    res.json({ url: `/uploads/${req.file.filename}` });
  });
});

export default router;
