/**
 * Helpers for image-bearing JSON snapshots (diary items, recipe ingredients).
 *
 * Canonical food/meal images belong in /uploads. Snapshot JSON may retain a
 * small /uploads/... reference, but must never retain the image bytes as a
 * data URL. These helpers recurse because split recipes can nest food items.
 */

const IMAGE_KEYS = new Set(['imgUrl', 'img_url']);

export function dataUrlDecodedBytes(value) {
  if (typeof value !== 'string') return 0;
  const match = /^data:image\/[a-zA-Z0-9.+-]+;base64,(.+)$/i.exec(value);
  if (!match) return 0;
  try {
    return Buffer.from(match[1], 'base64').length;
  } catch {
    return 0;
  }
}

export function stripInlineSnapshotImages(value) {
  let changed = false;

  function visit(node) {
    if (Array.isArray(node)) return node.map(visit);
    if (!node || typeof node !== 'object') return node;

    const out = {};
    for (const [key, item] of Object.entries(node)) {
      if (IMAGE_KEYS.has(key) && typeof item === 'string' && item.startsWith('data:image/')) {
        out[key] = '';
        changed = true;
      } else {
        out[key] = visit(item);
      }
    }
    return out;
  }

  const result = visit(value);
  return changed ? result : value;
}

export async function localizeInlineSnapshotImages(value, localize, onResult) {
  let changed = false;

  async function visit(node) {
    if (Array.isArray(node)) return Promise.all(node.map(visit));
    if (!node || typeof node !== 'object') return node;

    const entries = await Promise.all(Object.entries(node).map(async ([key, item]) => {
      if (IMAGE_KEYS.has(key) && typeof item === 'string' && item.startsWith('data:image/')) {
        const localized = await localize(item);
        if (typeof localized === 'string' && !localized.startsWith('data:')) {
          changed = true;
          onResult?.({
            key,
            source: item,
            localized,
            itemId: node.id ?? node.server_id ?? node.client_id ?? null,
            success: true,
          });
          return [key, localized];
        }
        onResult?.({
          key,
          source: item,
          localized: null,
          itemId: node.id ?? node.server_id ?? node.client_id ?? null,
          success: false,
        });
        return [key, item];
      }
      return [key, await visit(item)];
    }));
    return Object.fromEntries(entries);
  }

  const result = await visit(value);
  return { value: changed ? result : value, changed };
}
