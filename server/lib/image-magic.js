/**
 * image-magic.js — Identify image files by their byte signature.
 *
 * Don't trust the client-supplied MIME type or the filename extension —
 * either can be set arbitrarily and used to upload non-images. Magic-byte
 * checks read the actual file header.
 *
 * Supported formats: JPEG, PNG, GIF (87a/89a), WebP, BMP, HEIC/HEIF, AVIF.
 * Returns the detected format name, or null if the file isn't a recognized
 * image.
 *
 * SVG is intentionally NOT supported — it's a script-execution risk and
 * NutriTrace only ever needs raster food/avatar photos.
 */
import fs from 'fs/promises';

/** Detect image format from the first 32 bytes of a file. Returns format name or null. */
export async function detectImageType(filePath) {
  const fd = await fs.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(32);
    const { bytesRead } = await fd.read(buf, 0, 32, 0);
    return _identify(buf, bytesRead);
  } finally {
    await fd.close();
  }
}

/** Same check against an in-memory buffer (e.g. multer.memoryStorage). */
export function detectImageTypeFromBuffer(buf) {
  return _identify(buf, buf.length);
}

function _identify(buf, len) {
  if (len < 12) return null;

  // JPEG: FF D8 FF
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'jpeg';

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47 &&
      buf[4] === 0x0D && buf[5] === 0x0A && buf[6] === 0x1A && buf[7] === 0x0A) return 'png';

  // GIF: 47 49 46 38 (37|39) 61   → "GIF87a" or "GIF89a"
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38 &&
      (buf[4] === 0x37 || buf[4] === 0x39) && buf[5] === 0x61) return 'gif';

  // BMP: 42 4D ("BM")
  if (buf[0] === 0x42 && buf[1] === 0x4D) return 'bmp';

  // WebP: "RIFF????WEBP"
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'webp';

  // HEIC/HEIF/AVIF: "ftyp" box at offset 4, then a 4-byte brand at offset 8.
  // Common brands seen in the wild for image content:
  //   heic, heix, hevc, hevx — HEIC
  //   mif1, msf1            — generic HEIF still / sequence
  //   avif, avis            — AVIF still / sequence
  if (buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) {
    const brand = buf.toString('ascii', 8, 12);
    if (brand === 'avif' || brand === 'avis') return 'avif';
    if (['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(brand)) return 'heic';
  }

  return null;
}
