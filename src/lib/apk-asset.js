/**
 * apk-asset.js: which file in a release is this phone's app.
 *
 * A release carries the watch build alongside the phone one, and both are
 * signed with the same key under the same package id, which is what lets the
 * Wear data layer pair them. That also means the watch build will install
 * straight over the phone app, replacing it with one that cannot run on a
 * phone. Taking "the first .apk" in a release therefore depends on the order
 * GitHub happens to list assets in, which is upload order and no promise at
 * all.
 *
 * The names are the only thing telling them apart, so the name is what this
 * reads.
 */

/** Does this file name say it is the watch build? */
export function isWatchApk(name) {
  if (!name) return false;
  const stem = String(name).replace(/\.apk$/i, '');
  return /(^|[^a-z0-9])(wear|watch)([^a-z0-9]|$)/i.test(stem);
}

/**
 * The phone's APK from a release's assets, or null when there isn't one.
 *
 * Never falls back to the watch build, even when it is the only file there:
 * offering it would install the wrong app over this one. No update at all is
 * the better answer.
 */
export function pickApkAsset(assets) {
  const apks = (assets || []).filter(
    a => a && typeof a.name === 'string' && a.name.toLowerCase().endsWith('.apk'),
  );
  return apks.find(a => !isWatchApk(a.name)) || null;
}
