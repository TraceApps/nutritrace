/**
 * Recover the original image URL from the Android offline-cache map.
 *
 * The cache renames files to a hash, so their local basename has no useful
 * relationship to the original server filename. The map is the source of
 * truth: it stores original URL -> local URI entries.
 */
export function originalUrlForCachedImage(localUrl, imageMap) {
  if (!localUrl || !imageMap || typeof imageMap !== 'object') return null;

  const originals = Object.entries(imageMap)
    .filter(([, cachedUrl]) => cachedUrl === localUrl)
    .map(([original]) => original);
  if (originals.length === 0) return null;

  // Server uploads are stored under both relative and absolute keys. Prefer
  // the portable relative form that works on the PWA and every other device.
  const relativeUpload = originals.find(url => url.startsWith('/uploads/'));
  if (relativeUpload) return relativeUpload;

  const absoluteUpload = originals.find(url => {
    if (!/^https?:\/\//i.test(url)) return false;
    try { return new URL(url).pathname.includes('/uploads/'); } catch { return false; }
  });
  if (absoluteUpload) {
    const pathname = new URL(absoluteUpload).pathname;
    return pathname.slice(pathname.indexOf('/uploads/'));
  }

  // External images are also stored under a pathname-only key and their full
  // URL. The full URL retains the host and is therefore the useful one.
  const fullUrl = originals.find(url => /^https?:\/\//i.test(url));
  const original = fullUrl || originals[0];

  // A cached server proxy URL represents its inner external URL.
  if (original.includes('/api/proxy?url=')) {
    try {
      return new URL(original, 'https://cache.invalid').searchParams.get('url') || original;
    } catch {}
  }
  return original;
}
