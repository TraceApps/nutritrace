/**
 * share-item.js: one food, meal or recipe's sharing, from its editor. The
 * same choice Bulk Share makes for a whole category (Private, Everyone,
 * Specific People), through the server's existing per-item routes
 * (PATCH /api/foods/:id/share, /api/meals/:id/share). Sharing lives on the
 * server, so it needs a connection, and the item must be there as it is:
 * on Android one with changes not sent yet waits for its sync (sharing it
 * first would make the server's copy newer and the phone's edit lose).
 */
import { NtApi } from './api.js';
import { isNative } from './platform.js';
import { isTempId } from './offline-edits.js';
import { serverIdOf } from './coach-plans.js';

export const SHARE_CHOICES = ['private', 'group', 'specific'];

const _err = (code) => Object.assign(new Error(code), { code });

/**
 * The item's id on the server, read fresh (an editor's copy can be an
 * older draft). Throws 'not_synced' while the server doesn't hold it as it is.
 */
export async function serverIdFor(kind, item) {
  if (isNative) {
    const row = kind === 'foods' ? await NtApi.getFood(item?.id) : await NtApi.getMeal(item?.id);
    if (!row || row.server_id == null || row.sync_status === 'pending') throw _err('not_synced');
    return row.server_id;
  }
  const sid = serverIdOf(item);
  if (sid == null || isTempId(sid)) throw _err('not_synced');
  return sid;
}

/** Whether sharing is on, who can see it now, and who it could go to. */
export async function loadShare(kind, item) {
  // Asked directly: a failure is a failure, not "sharing is off".
  const status = await NtApi.get('/api/app-config/sharing');
  if (status?.sharing_enabled !== true) return { off: true, status };
  const sid = await serverIdFor(kind, item);
  const [row, users] = await Promise.all([NtApi.get(`/api/${kind}/${sid}`), NtApi.get('/api/auth/users/list')]);
  return {
    status,
    visibility: SHARE_CHOICES.includes(row?.visibility) ? row.visibility : 'private',
    user_ids: Array.isArray(row?._specific_users) ? row._specific_users : [],
    users: Array.isArray(users) ? users : [],
  };
}

/** Set who can see it. */
export async function saveShare(kind, item, visibility, userIds) {
  const sid = await serverIdFor(kind, item);
  return NtApi.patch(`/api/${kind}/${sid}/share`, { visibility, user_ids: visibility === 'specific' ? userIds : [] });
}
