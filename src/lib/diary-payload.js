/**
 * Diary items are snapshots of foods/meals, but inline images must not be part
 * of that snapshot. A single base64 photo can be repeated for every occurrence
 * of a food and make the full-row diary PUT exceed its body limit. The server
 * resolves the current food/meal image when reading the diary, so dropping only
 * inline data URLs does not affect display or the canonical image upload.
 */
export function stripInlineDiaryImages(items) {
  let changed = false;

  function visit(value) {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== 'object') return value;
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      if ((key === 'imgUrl' || key === 'img_url') &&
          typeof item === 'string' && item.startsWith('data:image/')) {
        result[key] = '';
        changed = true;
      } else {
        result[key] = visit(item);
      }
    }
    return result;
  }

  const result = visit(items);
  return changed ? result : items;
}
