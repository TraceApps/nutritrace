/**
 * item-source.js: which food, meal or recipe a diary item was logged from.
 *
 * Items carry two ids. food_server_id is the server's id of the source row.
 * id is whatever the logging device used: the server's id on the web, the
 * phone's own row id in the Android app. food_server_id null (the key there,
 * the value null) means the item was logged on a phone before its source
 * reached the server, so its id is that phone's own and means nothing
 * anywhere else. The phone fills food_server_id in once the source syncs.
 * Items from before food_server_id existed have no key, and keep their old
 * reading: id is the server's on the web, the phone's own on a phone.
 *
 * Returns { serverId } or { localId, unsent } (a row of this device's own
 * database), or null when the item names no row this device can find.
 */
export function itemSourceRef(item, { native = false } = {}) {
  if (!item || typeof item !== 'object') return null;
  const fsid = item.food_server_id;
  if (typeof fsid === 'number') return { serverId: fsid };
  if (typeof item.id !== 'number') return null;
  if (fsid === null) return native ? { localId: item.id, unsent: true } : null;
  return native ? { localId: item.id, unsent: false } : { serverId: item.id };
}

const _norm = s => String(s || '').trim().toLowerCase();

/**
 * Whether the food an item's id names is the food the item came from,
 * before its units and barcode are lent to the item (#277): the same name
 * (trimmed, any case), or, renamed since, a food that was there when the
 * item was logged (made at or before its addedAt). An id out of date (from
 * another server, after Connect > Upload or Push all, whose food never
 * came along) names a food made later, or one of another name. Twin of
 * server/lib/diary-helpers.js itemFoodMatches.
 */
export function itemFoodMatches(food, item) {
  if (!food || !item) return false;
  if (_norm(food.name) === _norm(item.name)) return true;
  // Linked again (relinkItems, dbLinkDiaryItems) to a food renamed since:
  // the food's name then, kept on the item.
  if (item.food_name && _norm(food.name) === _norm(item.food_name)) return true;
  const logged = Date.parse(item.addedAt || '');
  const s = String(food.created_at || '');
  const made = s ? Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s.replace(' ', 'T') : `${s.replace(' ', 'T')}Z`) : NaN;
  return Number.isFinite(logged) && Number.isFinite(made) && made <= logged;
}

/**
 * The photo of the food, meal or recipe a diary item (or a meal's
 * ingredient) came from, out of the catalogue this device has loaded
 * (Foods: Yesterday's Meals and a meal's items), found the way the diary
 * finds it (server/lib/diary-helpers.js freshenItemImages, db-native.js
 * _freshenItemImages): a recipe among meals and recipes, anything else
 * among foods; by its source's id with the same name first, then by name
 * and brand (foods only), then by name, the newest of several. Names are
 * trimmed and compared case-insensitively, and only rows with a photo
 * count. Falls back to the
 * item's own imgUrl.
 * catalogue: { foods, meals } (meals with the recipes); native: the rows
 * are the Android app's (their server id in server_id); mine: the
 * phone's install ids (db-native.js dbOwnInstallIds).
 */
export function catalogImgFor(item, { foods = [], meals = [] } = {}, { native = false, mine = null } = {}) {
  if (!item || typeof item !== 'object') return '';
  // A browser's rows carry the server's id as id; the phone's, as server_id.
  const serverIdOf = f => ('server_id' in f ? f.server_id : f.id);
  // Newest first, so of several of one name the newest one's photo shows,
  // as in the diary (#277): the highest server id, and a row not on the
  // server yet (a phone's, or one made offline in the browser, with a
  // negative id) newer still.
  const sid = f => { const v = serverIdOf(f); return typeof v === 'number' && v > 0 ? v : null; };
  const pool = (item.is_recipe ? meals : foods).filter(f => f && f.imgUrl).sort((a, b) => {
    const x = sid(a), y = sid(b);
    if ((x == null) !== (y == null)) return x == null ? -1 : 1;
    if (x != null && x !== y) return y - x;
    return Math.abs(Number(b.id) || 0) - Math.abs(Number(a.id) || 0);
  });
  const name = _norm(item.name), brand = _norm(item.brand);
  const ref = itemSourceRef(item, { native });
  let m = null;
  if (ref?.serverId != null) m = pool.find(f => serverIdOf(f) === ref.serverId && _norm(f.name) === name);
  // The phone's own id: an item logged before its row went up names only
  // a row still waiting to go up, and only on the phone that logged it
  // (`mine`, this database's install ids, when known).
  else if (ref?.localId != null && !(ref.unsent && item.food_device && !mine?.has(item.food_device))) {
    m = pool.find(f => f.id === ref.localId && _norm(f.name) === name && (!ref.unsent || f.server_id == null));
  }
  if (!m && name) {
    if (!item.is_recipe) m = pool.find(f => _norm(f.name) === name && _norm(f.brand) === brand);
    if (!m) m = pool.find(f => _norm(f.name) === name);
  }
  return m?.imgUrl || item.imgUrl || '';
}

/**
 * The phone's foods, meals and recipes are going up to a server as new
 * rows (Connect > Upload or Merge, Push all from this device), so the
 * server ids they had stop naming them. This points each diary item whose
 * source is one of them at it again: by its new server id where that is
 * known, otherwise as an item logged before its row went up (the phone's
 * own id, food_server_id null, food_device this install), which the sync
 * links once the row has gone up (db-native.js dbLinkDiaryItems).
 *
 * An item names one of the rows by its server id (food_server_id against
 * the server id the row has had until now), or by the phone's own id: one
 * logged on this phone before its row went up (food_device one of this
 * database's install ids), or an untagged or older item of the same name.
 * An item of another phone's, or whose source isn't one of the rows, is
 * left as it is. Running it again gives the same items.
 *
 * rows: { foods, meals }, each [{ id, server_id, name }], the phone's rows
 *   going up, with the server ids they have had until now.
 * newIds: { foods, meals }, each a Map or [[phone id, new server id]].
 * install: this install's id. mine: this database's install ids (a Set).
 * Returns { items, changed }.
 */
/**
 * The updatedAt a diary item gets when it's relinked to its food (#277):
 * one millisecond after the time it had (updatedAt, else addedAt). The
 * server's merge (server/lib/diary-merge.js) keeps whichever copy of an
 * item has the later time, as text, so the relinked copy wins over an
 * older copy of the day another device sends again, with the old id, and
 * still loses to a real edit made since anywhere else. An item with no
 * time at all gets the earliest one there is.
 */
export function relinkedAt(item) {
  const was = String(item?.updatedAt || item?.addedAt || '');
  const t = Date.parse(was);
  if (!Number.isFinite(t)) return was ? `${was}1` : '1970-01-01T00:00:00.001Z';
  const next = new Date(t + 1).toISOString();
  return next > was ? next : `${was}1`;
}

// The phone's rows going up, by the server id they've had and by their id
// here, and the new server ids known so far (relinkItems, relinkIngredients).
function _pools(rows, newIds) {
  const pools = {};
  for (const t of ['foods', 'meals']) {
    const byServer = new Map(), byId = new Map();
    for (const r of rows[t] || []) {
      if (!r || typeof r.id !== 'number') continue;
      byId.set(r.id, r);
      if (typeof r.server_id === 'number') byServer.set(r.server_id, r);
    }
    pools[t] = { byServer, byId, next: new Map(newIds[t] || []) };
  }
  return pools;
}

export function relinkItems(items, { rows = {}, newIds = {}, install = null, mine = new Set() } = {}) {
  if (!Array.isArray(items)) return { items, changed: false };
  const pools = _pools(rows, newIds);
  const sourceRow = it => {
    const p = pools[it.is_recipe ? 'meals' : 'foods'];
    const ref = itemSourceRef(it, { native: true });
    if (!ref) return null;
    if (ref.serverId != null) return p.byServer.get(ref.serverId) || null;
    if (it.food_device) return mine.has(it.food_device) ? p.byId.get(ref.localId) || null : null;
    // Untagged, or from before food_server_id: the id is this phone's own
    // or, for an older item logged in the browser, the server's. Only a
    // row of the same name is taken for it.
    const same = r => (r && _norm(r.name) === _norm(it.name) ? r : null);
    return same(p.byId.get(ref.localId)) || (ref.unsent ? null : same(p.byServer.get(ref.localId)));
  };
  let changed = false;
  const walk = (list, top = true) => {
    let hit = false;
    const out = list.map(it => {
      if (!it || typeof it !== 'object') return it;
      let next = it;
      const row = sourceRow(it);
      if (row) {
        const sid = pools[it.is_recipe ? 'meals' : 'foods'].next.get(row.id);
        if (sid != null) {
          if (it.food_server_id !== sid || 'food_device' in it) {
            const { food_device: _d, ...rest } = it;
            next = { ...rest, food_server_id: sid };
          }
        } else if (!(it.food_server_id === null && it.id === row.id && it.food_device === install)) {
          next = { ...it, id: row.id, food_server_id: null, food_device: install };
        }
        // Its food renamed since it was logged: keep the food's name, so
        // the food still lends it units and barcode (itemFoodMatches).
        if (next !== it && _norm(row.name) !== _norm(it.name)) next = { ...next, food_name: row.name };
      }
      if (Array.isArray(next._splitItems)) {
        const kids = walk(next._splitItems, false);
        if (kids !== next._splitItems) next = { ...next, _splitItems: kids };
      }
      if (next !== it) {
        hit = true;
        // A change the merge keeps (relinkedAt); the day merges by its
        // top-level items, a split recipe's with its parts.
        if (top) next = { ...next, updatedAt: relinkedAt(it) };
      }
      return next;
    });
    if (!hit) return list;
    changed = true;
    return out;
  };
  return { items: walk(items), changed };
}

/**
 * The same for a saved meal's or recipe's ingredients (meals.items), which
 * name their food (or recipe) in their own ways: a meal saved in the
 * browser keeps the server's id in `id`; one saved in the Android app keeps
 * the phone's own in `id` and the server's in `server_id` (null: not on the
 * server yet); one saved from the diary keeps the items as they were, with
 * food_server_id. An ingredient whose row is one of the phone's going up
 * gets the phone's shape: its id here and its new server id in server_id
 * (and food_server_id, where it has that), or, until the new id is known,
 * server_id null and this install as food_device, which the sync fills in
 * once the row has gone up (db-native.js dbLinkDiaryItems). Anything else
 * is left as it is. Running it again gives the same ingredients.
 * Options as relinkItems. Returns { items, changed }.
 */
export function relinkIngredients(items, { rows = {}, newIds = {}, install = null, mine = new Set() } = {}) {
  if (!Array.isArray(items)) return { items, changed: false };
  const pools = _pools(rows, newIds);
  const same = (r, ing) => (r && _norm(r.name) === _norm(ing.name) ? r : null);
  const sourceRow = ing => {
    const p = pools[ing.is_recipe ? 'meals' : 'foods'];
    if (typeof ing.food_server_id === 'number') return p.byServer.get(ing.food_server_id) || null;
    if ('server_id' in ing && typeof ing.server_id === 'number') return p.byServer.get(ing.server_id) || null;
    if (typeof ing.id !== 'number') return null;
    const unsent = ('server_id' in ing && ing.server_id == null) || ing.food_server_id === null;
    if (unsent) {
      // The phone's own id, before its row went up: this phone's, or of
      // the same name.
      if (ing.food_device) return mine.has(ing.food_device) ? p.byId.get(ing.id) || null : null;
      return same(p.byId.get(ing.id), ing);
    }
    // No server_id: the server's id (saved in the browser), or the phone's
    // (older ingredients): only a row of the same name is taken for it.
    return same(p.byServer.get(ing.id), ing) || same(p.byId.get(ing.id), ing);
  };
  let changed = false;
  const out = items.map(ing => {
    if (!ing || typeof ing !== 'object') return ing;
    const row = sourceRow(ing);
    if (!row) return ing;
    const sid = pools[ing.is_recipe ? 'meals' : 'foods'].next.get(row.id) ?? null;
    const { food_device: _d, ...rest } = ing;
    const next = { ...rest, id: row.id, server_id: sid };
    if ('food_server_id' in ing) next.food_server_id = sid;
    if (sid == null) next.food_device = install;
    const keys = new Set([...Object.keys(ing), ...Object.keys(next)]);
    for (const k of keys) if (ing[k] !== next[k]) { changed = true; return next; }
    return ing;
  });
  return { items: changed ? out : items, changed };
}
