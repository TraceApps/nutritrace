/**
 * image-fit.js — downscale an image data URL to fit within a max dimension
 * while preserving aspect ratio. Does NOT crop. Used when the user has the
 * "Crop photos on upload" setting OFF and wants the picture saved as-is
 * (just resized to a server-friendly payload size).
 *
 * Why this exists:
 *   The server's JSON body limit is 1 MB. A modern phone photo as a
 *   base64 data URL can be 5–15 MB and would silently fail to save.
 *   Downscaling keeps payloads small while staying high-res enough for
 *   diary thumbnails and detail-card display.
 *
 * Quality-tuned for visual fidelity:
 *   - maxDim 1920 px on the longest edge — sharp on retina displays;
 *     base64 of a 1920×1440 JPEG at 0.92 quality is ~600–900 KB,
 *     comfortably inside the 1 MB JSON cap.
 *   - JPEG quality 0.92 — visually near-lossless for photos.
 *   - Canvas imageSmoothingQuality:'high' — browsers map this to
 *     bicubic/Lanczos, meaningfully sharper than the default bilinear
 *     when downscaling 4000+ px phone photos.
 *   - Already-small images (≤ maxDim on both edges) pass through
 *     untouched — no needless re-encode of small thumbnails.
 */

/**
 * @param {string} dataUrl — image as data: URL (any image type)
 * @param {number} [maxDim=1920] — max edge length in pixels
 * @param {number} [quality=0.92] — JPEG quality 0..1
 * @returns {Promise<string>} — JPEG data URL, fitted within the bounds
 */
export function fitImageDataUrl(dataUrl, maxDim = 1920, quality = 0.92) {
  return new Promise(resolve => {
    if (!dataUrl || typeof dataUrl !== 'string') return resolve(dataUrl);
    const img = new Image();
    img.onload = () => {
      const w = img.naturalWidth, h = img.naturalHeight;
      if (!w || !h) return resolve(dataUrl);
      // Already small enough — keep original (avoids needless re-encode).
      if (w <= maxDim && h <= maxDim) return resolve(dataUrl);
      const scale = Math.min(maxDim / w, maxDim / h);
      const nw = Math.round(w * scale);
      const nh = Math.round(h * scale);
      const canvas = document.createElement('canvas');
      canvas.width = nw;
      canvas.height = nh;
      const ctx = canvas.getContext('2d');
      // Higher-quality downscale than the default bilinear. Browsers map
      // "high" to bicubic/Lanczos — meaningfully sharper for typical 4×
      // downscales from a phone photo.
      if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(img, 0, 0, nw, nh);
      try {
        resolve(canvas.toDataURL('image/jpeg', quality));
      } catch (e) {
        // Some browsers throw on toDataURL for tainted canvas (cross-origin).
        // Fall back to the original.
        resolve(dataUrl);
      }
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}
