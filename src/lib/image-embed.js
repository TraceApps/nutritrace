/**
 * image-embed.js: a photo small enough to travel inside a row.
 *
 * With no connection there is nowhere to upload a file to, so a photo taken
 * offline rides along inside the row it belongs to, as a data URL, and the
 * server turns it back into a file under /uploads/ when it arrives
 * (server/lib/image-localizer.js). A phone camera photo is several
 * megabytes, and base64 adds a third again on top, so it is scaled down and
 * re-encoded first: a cook's photo does not need to be 4000px wide.
 */

const MAX_DIM = 1600;
const QUALITY = 0.82;
// Well under the server's ceiling, so a photo is never taken and then
// refused on arrival.
export const MAX_EMBEDDED_BYTES = 8 * 1024 * 1024;

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

/**
 * A file as a data URL, scaled to something sensible. Throws with a message
 * worth showing if the result would still be too big to keep.
 */
export async function embeddableDataUrl(file) {
  const original = await _readAsDataUrl(file);
  let out = original;
  try {
    const img = await _load(original);
    const { naturalWidth: w, naturalHeight: h } = img;
    if (w && h && (w > MAX_DIM || h > MAX_DIM)) {
      const scale = Math.min(MAX_DIM / w, MAX_DIM / h);
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(w * scale);
      canvas.height = Math.round(h * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      out = canvas.toDataURL('image/jpeg', QUALITY);
    } else if (file.size > MAX_EMBEDDED_BYTES / 2) {
      // Small in pixels but heavy: re-encode rather than carry it as it is.
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0);
      out = canvas.toDataURL('image/jpeg', QUALITY);
    }
  } catch {
    // An image the browser cannot decode (a HEIC, say) goes as it came, and
    // the size check below is what protects the queue.
  }
  if (out.length > MAX_EMBEDDED_BYTES) {
    const err = new Error('That photo is too large to keep until you are back online. Take it again once you have a connection.');
    err.offline = true;
    throw err;
  }
  return out;
}

/** Is this an image kept in a row rather than a path to one? */
export const isEmbedded = (url) => typeof url === 'string' && url.startsWith('data:image/');
