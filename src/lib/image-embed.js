/**
 * image-embed.js: a photo small enough to travel inside a row.
 *
 * With no connection there is nowhere to upload a file to, so a photo taken
 * offline rides along inside the row it belongs to, as a data URL, and the
 * server turns it back into a file when it arrives
 * (server/lib/image-localizer.js). A phone camera photo is several
 * megabytes, and base64 adds a third again on top, so it is scaled down and
 * re-encoded first: a photo on a recipe does not need to be 4000px wide.
 *
 * Two things the server is fussy about, so this is careful with both:
 *  - It only stores the formats it can recognise, so anything unusual (an
 *    iPhone's HEIC, say) is re-encoded here rather than sent as it came.
 *  - A drawing or a screenshot can have transparency, which JPEG cannot
 *    keep, so an image with any see-through pixel is written as a PNG.
 */

const MAX_DIM = 1600;
const QUALITY = 0.82;
// A photo travels inside an ordinary request, and a server will not read an
// endless one: this is the ceiling everything here works to. Well under what
// the servers accept, so a photo is never kept and then refused on arrival
// with "request entity too large", which is exactly what happened before
// this was enforced.
export const MAX_EMBEDDED_BYTES = 1_200_000;
// Steps to try, in order, before giving up: shrink, then shrink further,
// then lean on quality. A phone photo lands in the first or second.
const STEPS = [
  { dim: MAX_DIM, quality: QUALITY },
  { dim: 1200, quality: 0.78 },
  { dim: 900, quality: 0.72 },
  { dim: 700, quality: 0.65 },
];
// What the server will store as it stands.
const KNOWN = /^image\/(jpeg|png|webp|gif|avif)$/i;

const _readAsDataUrl = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result || ''));
  reader.onerror = () => reject(new Error('Could not read that photo.'));
  reader.readAsDataURL(file);
});

const _load = (dataUrl) => new Promise((resolve, reject) => {
  const img = new Image();
  img.onload = () => resolve(img);
  img.onerror = () => reject(new Error('Could not read that photo.'));
  img.src = dataUrl;
});

const _needsConnection = (message) => {
  const err = new Error(message);
  err.offline = true;
  return err;
};

/** Does any pixel see through? JPEG would paint those black. */
function _hasTransparency(ctx, w, h) {
  try {
    const { data } = ctx.getImageData(0, 0, w, h);
    // Every 40th pixel is plenty to notice a transparent background or a
    // drawing's edges, and keeps this quick on a big image.
    for (let i = 3; i < data.length; i += 160) if (data[i] < 255) return true;
    return false;
  } catch {
    // Reading pixels was refused: assume there is transparency to keep,
    // which is the safe way to be wrong.
    return true;
  }
}

/**
 * A file as a data URL the server will accept, scaled to something sensible.
 * Throws with a message worth showing if the photo cannot be kept.
 */
export async function embeddableDataUrl(file) {
  const original = await _readAsDataUrl(file);
  const declared = String(file?.type || original.slice(5, Math.max(5, original.indexOf(';'))) || '');

  let img;
  try {
    img = await _load(original);
  } catch {
    // A picture this browser cannot open. Embedding it would mean the server
    // quietly refusing it later, so say so now while it can be retaken.
    throw _needsConnection('That picture needs a connection. Try again once you are back online.');
  }

  const { naturalWidth: w, naturalHeight: h } = img;

  // An animated GIF cannot be redrawn without losing every frame but the
  // first, so it travels as it is or not at all.
  if (/^image\/gif$/i.test(declared)) {
    if (original.length > MAX_EMBEDDED_BYTES) {
      throw _needsConnection('That animation is too large to keep until you are back online.');
    }
    return original;
  }

  // Small enough already, and in a format the server stores? Keep it as it is.
  if (KNOWN.test(declared) && original.length <= MAX_EMBEDDED_BYTES
      && w && h && w <= MAX_DIM && h <= MAX_DIM) {
    return original;
  }

  let out = null;
  for (const step of STEPS) {
    const scale = w && h ? Math.min(1, step.dim / Math.max(w, h)) : 1;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round((w || step.dim) * scale));
    canvas.height = Math.max(1, Math.round((h || step.dim) * scale));
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    // A drawing keeps its transparency; a photograph does not need it.
    out = _hasTransparency(ctx, canvas.width, canvas.height)
      ? canvas.toDataURL('image/png')
      : canvas.toDataURL('image/jpeg', step.quality);
    if (out.length <= MAX_EMBEDDED_BYTES) return out;
  }

  throw _needsConnection('That picture is too large to keep until you are back online. Take it again once you have a connection.');
}

/** Is this an image kept in a row rather than a path to one? */
export const isEmbedded = (url) => typeof url === 'string' && url.startsWith('data:image/');
