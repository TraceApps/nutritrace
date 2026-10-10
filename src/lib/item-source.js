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
