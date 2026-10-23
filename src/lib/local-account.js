/**
 * local-account.js: whose data the phone's local database holds.
 *
 * Native server mode keeps a full copy of the account in SQLite, and one
 * phone can sign in to more than one account (or server). The copy is
 * tagged with the account it belongs to (sync_meta 'account', JSON: the
 * server's instance id "i", its address "s", the user id "u"), so that:
 *   - signing in as someone else never shows the previous account's foods,
 *     diary or settings: the copy is cleared and filled from the new
 *     account on the next sync;
 *   - the previous account's changes that never reached the server are
 *     never pushed under the new one. If there are any, the person signing
 *     in is asked first; saying no undoes the sign-in, and the changes go
 *     up the next time that account signs in here;
 *   - signing out and back in to the same account keeps everything,
 *     including changes still waiting.
 *
 * Same account means the same user id on the same server. The same user
 * id at the same address is always the same account (a restore can give
 * the server a new instance id). At another address, the server is known
 * by the random id it reports (/api/auth/status instance_id), so the same
 * server at a LAN IP and at its domain is one server; only two known,
 * different ids make it another one. A server too old to report one is
 * matched on the user id alone: an address change never discards data.
 * Limit: two such old servers at different addresses, with the same user
 * id on both, can't be told apart.
 *
 * Copies made before this tag existed, and copies in local mode (no
 * server, or after Disconnect), go to the first account that signs in, as
 * they always did. Connecting to a server from Settings decides for itself
 * (claimForServer), since the person chose there what happens to the data.
 */
import { writable, get } from 'svelte/store';
import { getServerUrl, getAuthToken, getNativeMode } from './platform.js';
import { dbGetSyncMeta, dbSetSyncMeta, dbCountUnsynced, dbClearUserData, dbKeepForNewServer } from './db-native.js';
import { resetUserState } from './user-state.js';

const META_KEY = 'account';

// Moves on every change of account (another one signing in, connecting to
// a server, going local, signing out). A sync started before it writes
// nothing after it (sync.js checks before every write).
let _generation = 0;
export const accountGeneration = () => _generation;
export function bumpAccountGeneration() { _generation++; }

// The phone's HTTP layer keeps the cookie a server set at sign-in and can
// send it with later requests, next to the Authorization header of
// whoever is signed in now. Every change of account (sign-in as someone
// else, Connect, Disconnect, sign-out, a lost session) forgets them, so a
// server that still read the cookie first can't answer as the previous
// account. Only NutriTrace's own cookies go, at every server address the
// phone knows (the one in use, the one its data came from, `urls`): a
// sign-in gate in front of the server (Cloudflare Access, Authelia) keeps
// its cookie, on that host or any other. Capacitor also keeps a copy of
// what a native request receives at the app's own address.
const SERVER_COOKIES = ['nt_token', 'nt_oidc_logout'];
export async function forgetServerCookies(...urls) {
  try {
    const { CapacitorCookies, Capacitor } = await import('@capacitor/core');
    if (!Capacitor?.isNativePlatform?.()) return;
    let tagged = null;
    try { tagged = (await _readOwner())?.s || null; } catch { /* no tag */ }
    const at = new Set();
    for (const u of [...urls, getServerUrl(), tagged, globalThis.location?.origin]) {
      try { if (u) at.add(new URL(u).origin + '/'); } catch { /* not an address */ }
    }
    for (const url of at) {
      for (const key of SERVER_COOKIES) {
        try { await CapacitorCookies.deleteCookie({ url, key }); } catch { /* none there */ }
      }
    }
  } catch { /* none kept */ }
}

function _server(url = getServerUrl()) {
  return String(url || '').trim().replace(/\/+$/, '').toLowerCase();
}

// The user id inside the session token (the server signs { id, ... }).
export function tokenUserId(token = getAuthToken()) {
  try {
    const part = String(token || '').split('.')[1];
    if (!part) return null;
    const json = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')));
    return json?.id ?? null;
  } catch {
    return null;
  }
}

// What the server reports about itself (/api/auth/status): its instance
// id, and the sync version it speaks (sync_version; 1 for servers before
// it existed). Asked once per address per app run, and kept (sync_meta)
// for when it can't be reached.
const _instances = new Map(); // address -> instance id
const _versions = new Map();  // address -> sync version
async function _serverInfo(serverUrl = getServerUrl(), { tries = 1 } = {}) {
  const url = _server(serverUrl);
  if (!url) return { i: null, v: 1 };
  if (_instances.has(url) && _versions.has(url)) return { i: _instances.get(url), v: _versions.get(url) };
  for (let n = 0; n < tries; n++) {
    if (n) await new Promise(r => setTimeout(r, 1000));
    const got = await _askServer(serverUrl, url);
    if (got) return got;
  }
  const v = Number(await dbGetSyncMeta(`syncver@${url}`));
  return { i: (await dbGetSyncMeta(`instance@${url}`)) || null, v: Number.isInteger(v) && v > 0 ? v : 1 };
}
// One /api/auth/status: { i, v }, or null when it couldn't be reached.
async function _askServer(serverUrl, url) {
  try {
    const res = await fetch(`${String(serverUrl).trim().replace(/\/+$/, '')}/api/auth/status`, {
      credentials: 'include', signal: AbortSignal.timeout(4000),
    });
    if (res.ok) {
      const body = await res.json().catch(() => ({}));
      const i = typeof body?.instance_id === 'string' && body.instance_id ? body.instance_id : null;
      const v = Number.isInteger(body?.sync_version) ? body.sync_version : 1;
      if (i) await dbSetSyncMeta(`instance@${url}`, i);
      await dbSetSyncMeta(`syncver@${url}`, String(v));
      _instances.set(url, i);
      _versions.set(url, v);
      return { i, v };
    }
  } catch { /* not reached */ }
  return null;
}
export async function serverInstanceId(serverUrl = getServerUrl(), opts = undefined) {
  return (await _serverInfo(serverUrl, opts)).i;
}
/** Whether this server keeps a day's note when a save leaves it out and
 *  lets the newer note win (sync_version 2). Servers before it clear the
 *  note on such a save, so the app sends its note every time, as it did.
 *  Unknown (never reached) counts as not. */
export async function serverKeepsNotes(serverUrl = getServerUrl()) {
  return (await _serverInfo(serverUrl)).v >= 2;
}

// The instance id last seen at this address, without asking the server.
async function _knownInstance(serverUrl = getServerUrl()) {
  const url = _server(serverUrl);
  if (!url) return null;
  if (_instances.has(url)) return _instances.get(url);
  return (await dbGetSyncMeta(`instance@${url}`)) || null;
}

async function _readOwner() {
  const raw = await dbGetSyncMeta(META_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
const _unowned = owner => !owner || owner.local || owner.u == null;
async function _current(userId, serverUrl = getServerUrl()) {
  return { i: await serverInstanceId(serverUrl), s: _server(serverUrl), u: userId };
}
async function _setOwner(cur) {
  await dbSetSyncMeta(META_KEY, JSON.stringify(cur));
}
// The same account at a new address of its server: its settings, kept
// per server (lib/setting-key.js), come along.
async function _retag(owner, tag) {
  if (owner && !_unowned(owner) && owner.s && tag.s && owner.s !== tag.s) {
    try { (await import('./setting-key.js')).moveSettingScope(tag.u, owner.s); } catch {}
  }
  await _setOwner(tag);
}

/**
 * Whether a copy tagged `owner` is user `userId`'s on this server:
 * { same, tag }, `tag` being the tag to write when it should change
 * (claimed, or the same server at a new address). Only asks the server
 * for its id when the address differs.
 */
export async function matchOwner(owner, userId, serverUrl = getServerUrl(), created = null, { tries = 1 } = {}) {
  const s = _server(serverUrl);
  const c = created || null;
  if (_unowned(owner)) return { same: true, tag: { i: await _knownInstance(serverUrl), s, u: userId, c } };
  if (String(owner.u) !== String(userId)) return { same: false };
  // The same id on a server rebuilt with a fresh database is someone
  // else: the account was made at another time (a restore keeps it).
  if (owner.c && c && owner.c !== c) return { same: false };
  const fill = !owner.c && c;
  if (owner.s === s) return { same: true, ...(fill ? { tag: { ...owner, c } } : {}) };
  // Another address: only the servers' own ids can tell. User ids repeat
  // across servers (the first admin is 1 on every one), so without both
  // ids it can't be decided here: the person is asked (`ambiguous`).
  const i = await serverInstanceId(serverUrl, { tries });
  const tag = { i: i || owner.i || null, s, u: userId, c: owner.c || c };
  if (!owner.i || !i) return { same: false, ambiguous: true, tag };
  if (owner.i !== i) return { same: false };
  return { same: true, tag };
}
// Kept for the tests' reading of the rule.
export function sameAccount(owner, cur) {
  if (_unowned(owner)) return true;
  if (String(owner.u) !== String(cur.u)) return false;
  if (owner.s === cur.s) return true;
  return !(owner.i && cur.i && owner.i !== cur.i);
}

/**
 * Sync gate: false only when the local data is known to be another
 * account's than the one whose token the request carries (`token`, the
 * one a push or pull started with). A copy with no owner yet is claimed
 * for it. A token with no user id in it (single-user servers) doesn't
 * block. Online, it also fills in the server's id on the tag.
 */
export async function localDataIsThisAccount(token = getAuthToken()) {
  const id = tokenUserId(token);
  if (id == null) return true;
  const owner = await _readOwner();
  const m = await matchOwner(owner, id);
  if (!m.same) return false;
  if (m.tag) await _retag(owner, { ...m.tag, c: m.tag.c ?? owner?.c ?? null });
  else if (!owner.i) {
    const i = await serverInstanceId();
    if (i) await _setOwner({ ...owner, i });
  }
  return true;
}

/** Local mode (Disconnect, or chose local at setup): the data is this
 *  phone's own now, and goes to whichever account it's connected to next. */
export async function setLocalOwner() {
  resetAccountGate();
  await _syncIdle();
  await dbSetSyncMeta(META_KEY, JSON.stringify({ local: true }));
}

/**
 * Connecting to a server from Settings, after the person chose what
 * happens to the phone's data. `clear` (Download) empties the copy, so it
 * fills from that account. `uploaded` (Upload or Merge, lib/migrate.js)
 * drops only the rows that went up whole; the rest is kept and goes up
 * with the next sync. Either way it's that account's now, so signing in
 * afterwards neither asks nor clears.
 */
export async function claimForServer(serverUrl, userId, { clear = false, uploaded = null, created = null } = {}) {
  resetAccountGate();
  await _syncIdle(serverUrl);
  await resetUserState();
  if (clear) await dbClearUserData();
  else await dbKeepForNewServer(uploaded || {});
  await _setOwner({ ...(await _current(userId, serverUrl)), c: created });
}

// A sync still running carries the session it started with and writes
// into the copy until it ends. The account generation moves first, so it
// writes nothing more; its requests are aborted, and the copy changes
// hands only once it has actually stopped.
async function _syncIdle(...addresses) {
  _generation++;
  try {
    const { stopSync } = await import('./sync.js');
    await stopSync();
  } catch { /* nothing running */ }
  await forgetServerCookies(...addresses);
}

async function _askSameServer() {
  const { confirmDialog } = await import('../stores/confirmDialog.js');
  const { _ } = await import('svelte-i18n');
  const say = get(_);
  return confirmDialog({
    title: say('sync.same_server_title'),
    message: say('sync.same_server'),
    confirmText: say('sync.same_server_yes'),
    cancelText: say('sync.same_server_no'),
  });
}

async function _askToDiscard(count) {
  const { confirmDialog } = await import('../stores/confirmDialog.js');
  const { _ } = await import('svelte-i18n');
  const say = get(_);
  return confirmDialog({
    title: say('sync.switch_account_waiting_title'),
    message: say('sync.switch_account_waiting', { values: { count } }),
    confirmText: say('sync.switch_account_anyway'),
    dangerous: true,
  });
}

/**
 * Make the copy this account's. Returns false when the person chose to
 * keep the previous account's unsent changes: the caller then undoes the
 * sign-in. `confirm(count)` replaces the dialog (tests).
 */
export async function prepareLocalAccount(user, { confirm = _askToDiscard, sameServer = _askSameServer } = {}) {
  if (!user || user.id == null) return true;
  const owner = await _readOwner();
  // A server that didn't answer is asked again before anyone is asked.
  const m = await matchOwner(owner, user.id, getServerUrl(), user.created_at || null, { tries: 3 });
  if (m.same || (m.ambiguous && await sameServer())) {
    if (m.tag) await _retag(owner, m.tag);
    return true;
  }
  await _syncIdle();
  const waiting = await dbCountUnsynced();
  if (waiting > 0 && !(await confirm(waiting))) return false;
  await resetUserState();
  await dbClearUserData();
  await _setOwner({ i: await _knownInstance(), s: _server(), u: user.id, c: user.created_at || null });
  return true;
}

// ── The gate App.svelte shows the app behind ─────────────────────────────
// One check at a time, and one per account: asking again for the account
// being checked (Svelte re-running its reactive block, a refreshed user
// object) gets the same answer, never a second dialog. A check that ends
// in signing out stays the running one until the sign-out has finished.
// state: 'idle' | 'checking' | 'ready' | 'signing_out' | 'error'
export const accountGate = writable({ state: 'idle', key: null, error: null });
let _running = null; // { key, promise }
const _gateKey = userId => `${_server()}#${userId}`;

export function resetAccountGate() {
  if (!_running) accountGate.set({ state: 'idle', key: null, error: null });
}

export function ensureLocalAccount(user, { confirm, signOut, sameServer } = {}) {
  if (!user || user.id == null) return Promise.resolve(true);
  const key = _gateKey(user.id);
  const now = get(accountGate);
  if (now.state === 'ready' && now.key === key && !_running) return Promise.resolve(true);
  if (_running?.key === key) return _running.promise;
  const before = _running?.promise || Promise.resolve();
  const promise = before.catch(() => {}).then(() => _check(user, key, { confirm, signOut, sameServer }));
  const run = { key, promise };
  _running = run;
  promise.finally(() => { if (_running === run) _running = null; });
  return promise;
}

async function _check(user, key, { confirm, signOut, sameServer }) {
  accountGate.set({ state: 'checking', key, error: null });
  let ok;
  try {
    ok = await prepareLocalAccount(user, { ...(confirm ? { confirm } : {}), ...(sameServer ? { sameServer } : {}) });
  } catch (e) {
    // Not knowing whose data this is: show nothing of it, say so, and
    // offer to try again or sign out.
    accountGate.set({ state: 'error', key, error: e?.message || String(e) });
    return false;
  }
  if (!ok) {
    accountGate.set({ state: 'signing_out', key, error: null });
    try { await signOut?.(); } catch { /* the sign-in is undone either way */ }
    accountGate.set({ state: 'idle', key: null, error: null });
    return false;
  }
  accountGate.set({ state: 'ready', key, error: null });
  return true;
}

/** Whether the app may show the data for this user now. */
export function accountReadyFor(gate, userId) {
  return gate?.state === 'ready' && gate.key === _gateKey(userId);
}

// Whether the phone's copy is the signed-in account's yet. Until the gate
// has checked, it may still hold the previous account's data, including
// settings it never sent: the new account's settings wait to be written
// into it (stores/settings.js), so they're neither counted as the previous
// account's nor written over its unsent ones. Local mode has one owner.
export function localCopyIsCurrent(userId = Number(localStorage.getItem('wl:userId'))) {
  if (getNativeMode() !== 'server') return true;
  return accountReadyFor(get(accountGate), userId);
}
/** Resolves true once the copy is this account's, false if that takes longer than `ms`. */
export function whenLocalCopyIsCurrent(userId = Number(localStorage.getItem('wl:userId')), ms = 60_000) {
  if (localCopyIsCurrent(userId)) return Promise.resolve(true);
  return new Promise(resolve => {
    let unsub = null, done = false;
    const end = ok => { if (done) return; done = true; clearTimeout(timer); queueMicrotask(() => unsub?.()); resolve(ok); };
    const timer = setTimeout(() => end(false), ms);
    unsub = accountGate.subscribe(g => { if (accountReadyFor(g, userId)) end(true); });
  });
}
