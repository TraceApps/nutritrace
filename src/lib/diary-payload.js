/**
 * Diary items are snapshots of foods/meals, but inline images must not be part
 * of that snapshot. A single base64 photo can be repeated for every occurrence
 * of a food and make the full-row diary PUT exceed its body limit. The server
 * resolves the current food/meal image when reading the diary, so dropping only
 * inline data URLs does not affect display or the canonical image upload.
 */
export function stripInlineDiaryImages(items) {
  if (!Array.isArray(items)) return items;
  let changed = false;
  const result = items.map(item => {
    if (item && typeof item.imgUrl === 'string' && item.imgUrl.startsWith('data:')) {
      changed = true;
      return { ...item, imgUrl: '' };
    }
    return item;
  });
  return changed ? result : items;
}
