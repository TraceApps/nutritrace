/**
 * coach-messages.js: a coaching conversation on this device.
 *
 * Messages are kept on the device (the browser's offline database, the
 * Android app's SQLite) so a conversation opens in a dead zone. A message
 * written here is kept first, with a uuid made here, and then sent; one
 * that can't go waits and goes later (here, or with the Android sync).
 * The server stores a uuid once, so a retry after a lost answer never makes
 * a second copy.
 *
 * A conversation is { pairingId, side: 'client' | 'coach', clientId }: the
 * client reaches theirs by the pairing, a coach by the client.
 */
import { isNative } from './platform.js';
import { NtApi } from './api.js';
import { forgetCoachPhotos } from './coach-photos.js';

export const MESSAGE_MAX = 4000;

export function conversationPath(conv) {
  return conv.side === 'coach'
    ? `/api/coaching/clients/${conv.clientId}/messages`
    : `/api/coaching/pairings/${conv.pairingId}/messages`;
}

const _sqlNow = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const _me = () => Number(localStorage.getItem('wl:userId')) || null;
export const newMessageId = () => (globalThis.crypto?.randomUUID?.()
  || `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`);

// ── Where the messages are kept ─────────────────────────────────────────────
async function _store() {
  if (isNative) {
    const n = await import('./db-native.js');
    return {
      available: async () => true,
      forget: (uuid) => n.dbForgetCoachMessage(uuid),
      list: (pid) => n.dbCoachMessages(pid),
      upsert: (rows) => n.dbUpsertCoachMessages(rows),
      queue: (row) => n.dbQueueCoachMessage(row),
      pending: () => n.dbPendingCoachMessages(),
      fail: (uuid, err) => n.dbFailCoachMessage(uuid, err),
      remove: (uuid) => n.dbDeleteCoachMessage(uuid),
      keep: (pids) => n.dbKeepCoachConversations(pids),
    };
  }
  const { coachStore: s } = await import('./offline-api.js');
  const all = async () => (await s.all('coach_messages')) || [];
  const byTime = (a, b) => String(a.created_at).localeCompare(String(b.created_at)) || String(a.uuid).localeCompare(String(b.uuid));
  return {
    available: () => s.available(),
    forget: (uuid) => s.del('coach_messages', [uuid]),
    list: async (pid) => (await all()).filter(m => m.pairing_id === Number(pid)).sort(byTime),
    upsert: async (rows) => {
      const mine = new Map((await all()).map(m => [m.uuid, m]));
      const put = rows.filter(r => r?.uuid && !(mine.get(r.uuid)?.sync_status === 'pending_delete' && !r.deleted_at))
        .map(r => ({ ...r, sync_status: 'synced', image_local: null, error: null }));
      if (put.length) await s.put('coach_messages', put);
    },
    queue: (row) => s.put('coach_messages', [row]),
    pending: async () => (await all()).filter(m => m.sync_status === 'pending' || m.sync_status === 'pending_delete').sort(byTime),
    fail: async (uuid, err) => {
      const m = (await all()).find(x => x.uuid === uuid);
      if (m) await s.put('coach_messages', [{ ...m, sync_status: 'failed', error: String(err || '') }]);
    },
    remove: async (uuid) => {
      const m = (await all()).find(x => x.uuid === uuid);
      if (!m) return;
      // Never could go: gone. Still going (perhaps already arrived): the delete
      // follows it, so an answer coming back can't bring it back.
      if (m.sync_status === 'failed') return s.del('coach_messages', [uuid]);
      await s.put('coach_messages', [{ ...m, body: null, image: null, image_local: null, deleted_at: _sqlNow(), sync_status: 'pending_delete' }]);
    },
    keep: async (pids) => {
      const keep = new Set((pids || []).map(Number));
      const gone = (await all()).filter(m => !keep.has(m.pairing_id));
      if (gone.length) await s.del('coach_messages', gone.map(m => m.uuid));
      return gone.map(m => m.image).filter(Boolean);
    },
  };
}

// ── Reading ─────────────────────────────────────────────────────────────────
/** What this device holds for a conversation, oldest first. */
export async function loadConversation(conv) {
  return (await _store()).list(conv.pairingId);
}

const _cursorKey = (conv) => `nt:coach-cursor:${_me() || ''}:${conv.pairingId}`;

/** Photos of messages deleted on the other side: their copies here go too. */
async function _forgetDeletedPhotos(store, rows) {
  const gone = rows.filter(r => r?.deleted_at);
  if (!gone.length) return;
  const byPairing = new Map();
  for (const r of gone) byPairing.set(r.pairing_id, null);
  const paths = [];
  for (const pid of byPairing.keys()) {
    for (const m of await store.list(pid)) if (m.image && gone.some(g => g.uuid === m.uuid)) paths.push(m.image);
  }
  if (paths.length) await forgetCoachPhotos(paths);
}

/**
 * Ask the server what changed since the last look, and keep it.
 * Returns { can_send, status } (or null when it can't be reached).
 */
export async function refreshConversation(conv) {
  const store = await _store();
  const usable = await store.available();
  // The cursor only counts while this device holds the conversation it
  // followed (signed out and back in, the copy is empty: start over).
  let since = null;
  try { since = localStorage.getItem(_cursorKey(conv)); } catch { /* private mode */ }
  if (since && (!usable || !(await store.list(conv.pairingId)).length)) since = null;
  const path = conversationPath(conv) + (since ? `?since=${encodeURIComponent(since)}` : '');
  const r = await NtApi.get(path);
  await _forgetDeletedPhotos(store, r.messages || []);
  await store.upsert(r.messages || []);
  try { if (r.server_time && usable) localStorage.setItem(_cursorKey(conv), r.server_time); } catch { /* private mode */ }
  return { can_send: !!r.can_send, status: r.status };
}

/** The other person's messages, read now (needs the server; skipped offline). */
export async function markConversationRead(conv) {
  try { await NtApi.post(`${conversationPath(conv)}/read`, {}); return true; } catch { return false; }
}

// ── Writing ─────────────────────────────────────────────────────────────────
/** Keep a new message here, then send it (or leave it waiting). */
export async function sendMessage(conv, { body = '', image = null } = {}) {
  const text = String(body || '').replace(/\s+$/, '');
  if (text.length > MESSAGE_MAX) throw new Error('too long');
  const now = _sqlNow();
  const row = {
    uuid: newMessageId(),
    pairing_id: Number(conv.pairingId),
    sender_id: _me(),
    body: text.trim() ? text : null,
    image: null,
    image_local: image || null,
    post_path: conversationPath(conv),
    read_at: null,
    created_at: now,
    updated_at: now,
    deleted_at: null,
    error: null,
    sync_status: 'pending',
  };
  const store = await _store();
  // Nowhere to keep it (the browser's database blocked by another tab, or
  // private mode): send it straight away, and say so if that fails.
  if (!(await store.available())) {
    const sent = await NtApi.post(row.post_path, { uuid: row.uuid, body: row.body, image: row.image_local || undefined });
    return { ...sent, offline: false };
  }
  await store.queue(row);
  const r = await flushCoachMessages().catch(() => ({ offline: true }));
  return { ...row, offline: !!r?.offline };
}

/** Delete your own message ("Message deleted"); a delete made offline waits. */
export async function deleteOwnMessage(m) {
  await (await _store()).remove(m.uuid);
  if (m.image) forgetCoachPhotos([m.image]).catch(() => {});
  await flushCoachMessages().catch(() => {});
}

let _flushing = null;
/** Send everything waiting, oldest first. Stops at the first sign of no
 *  connection; a message the server refuses (the conversation closed) is
 *  kept and marked instead of retried forever. Returns { sent, offline }. */
export function flushCoachMessages() {
  if (_flushing) return _flushing;
  _flushing = (async () => {
    const store = await _store();
    let sent = 0, offline = false;
    for (const m of await store.pending()) {
      try {
        if (m.sync_status === 'pending_delete') {
          let row = null;
          try { row = await NtApi.del(`/api/coaching/messages/${encodeURIComponent(m.uuid)}`); }
          catch (e) {
            // Never reached the server (deleted while waiting): nothing to undo there.
            if (e?.status === 404 || /not found/i.test(String(e?.message))) { await store.forget(m.uuid); sent++; continue; }
            throw e;
          }
          await store.upsert([row]);
        } else {
          const row = await NtApi.post(m.post_path, { uuid: m.uuid, body: m.body, image: m.image_local || undefined });
          await store.upsert([row]);
        }
        sent++;
      } catch (e) {
        // No connection, or the server is having a moment (5xx, a restart
        // behind a proxy): it waits and goes later.
        const status = Number(e?.status) || 0;
        if (e?.offline || status >= 500 || !status || /fetch|network|timeout|abort/i.test(String(e?.message))) {
          if (status >= 400 && status < 500) { await store.fail(m.uuid, e.message); continue; }
          offline = true; break;
        }
        // Refused for good (the conversation closed): kept here, marked.
        await store.fail(m.uuid, e.message);
      }
    }
    if (sent && typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('nt:coach-messages'));
    return { sent, offline };
  })().finally(() => { _flushing = null; });
  return _flushing;
}

/** Waiting messages on this device (for the sync badge and sign-out). */
export async function pendingCoachMessages() {
  return (await _store()).pending();
}

/** Keep only conversations this account may still read; drop the rest and
 *  their photo copies (a coach whose client left loses the conversation). */
export async function keepConversations(pairingIds) {
  const photos = await (await _store()).keep(pairingIds);
  if (photos.length) await forgetCoachPhotos(photos);
}

/** Messages that came with the Android sync. */
export async function storeSyncedMessages(rows) {
  if (!rows?.length) return;
  const store = await _store();
  await _forgetDeletedPhotos(store, rows);
  await store.upsert(rows);
}
