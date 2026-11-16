/**
 * Draft persistence for the FoodEditor + MealEditor forms.
 *
 * Motivation (#157): Samsung's camera-mode lmkd policy kills the WebView
 * renderer while the OS camera activity is foreground; Chromium then
 * kills the host process; Android cold-starts NutriTrace and the editor
 * remounts with an empty form. All in-progress typing is lost because
 * it lived only in Svelte state.
 *
 * Storage split:
 *   - Text fields go to localStorage (~5 MB per-origin cap). Small,
 *     synchronous, easy to read at mount time.
 *   - The photo (imgUrl, usually a base64 data URL that can be several
 *     MB on modern camera output) goes to IndexedDB under a sibling
 *     key. Keeps localStorage from blowing its quota on the photo and
 *     losing the text fields as collateral.
 *
 * Design:
 *   - Every field mutation is mirrored (debounced) into localStorage
 *     under a per-editor draft key so it survives process death. Only
 *     the fields changed from what the editor opened with are kept, and
 *     nothing at all while nothing is changed: a pick from Mealie, Open
 *     Food Facts or USDA (or a food changed on another device) opens with
 *     its current values, and a draft brings back only your own edits on
 *     top of them (#327).
 *   - The photo is written to IndexedDB in the same tick, fire-and-forget.
 *   - On mount, an editor loads its draft, overlays it on top of the
 *     server-loaded (or empty) form, and asynchronously restores the
 *     photo from IndexedDB when it arrives.
 *   - Save clears both. A dedicated Discard control (surfaced in the
 *     editor's restored-draft banner) also clears both.
 *   - Draft keys are namespaced by editor and by target id (or 'new'
 *     for a brand-new entity) so an in-progress draft can never leak
 *     into an unrelated form.
 *
 * TTL is 4 hours: long enough for "start it now, come back after lunch"
 * yet short enough that a stale draft from days ago doesn't quietly
 * overwrite a fresh form.
 */

const TTL_MS = 4 * 60 * 60 * 1000; // 4 hours
// Drafts hold only changed fields since #327. Earlier ones held the whole
// form as first opened, so one of a picked or saved item could bring back
// values the source has changed since; those aren't brought back.
const DRAFT_V = 2;

const _plain = v => v != null && typeof v === 'object' && !Array.isArray(v);
const _same = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b);

/** The fields of `state` that differ from `base` (nested objects field by
 *  field, lists as a whole), or null when nothing differs. */
export function draftChanges(state, base) {
  if (!_plain(state)) return null;
  const b = _plain(base) ? base : {};
  const out = {};
  for (const k of Object.keys(state)) {
    const v = state[k];
    if (_plain(v) && _plain(b[k])) {
      const inner = draftChanges(v, b[k]);
      if (inner) out[k] = inner;
    } else if (!_same(v, b[k])) {
      out[k] = v;
    }
  }
  return Object.keys(out).length ? out : null;
}

/** A copy of what the editor opened with that later edits can't reach:
 *  the editors change some fields in place (a meal's ingredient amounts),
 *  which would also change a shallow copy and never count as edited. */
export function draftBase(v) {
  return v == null ? v : JSON.parse(JSON.stringify(v));
}

/** `base` with a draft's changed fields put back on top. */
export function applyDraft(base, changes) {
  const out = { ...(_plain(base) ? base : {}) };
  if (!_plain(changes)) return out;
  for (const [k, v] of Object.entries(changes)) {
    out[k] = _plain(v) && _plain(out[k]) ? applyDraft(out[k], v) : v;
  }
  return out;
}

function _now() { return Date.now(); }

/** Build a namespaced draft key. `kind` = 'food' | 'meal'. `id` = the
 *  edited row's id, or null / undefined for a new (create) draft.
 *  `prefill` = what the editor opened with: a pick from CookTrace, Mealie,
 *  Open Food Facts or USDA has no id yet, so it gets a key of its own from
 *  what identifies it. Without that every pick shared one key, and
 *  opening one showed the last one's draft (#260). */
export function draftKey(kind, id, prefill = null) {
  const p = `nt:${draftScope()}${kind}:draft:`;
  if (id != null && id !== '' && id !== 'undefined') return `${p}edit:${id}`;
  const pick = pickIdentity(prefill);
  if (pick) return `${p}pick:${pick}`;
  return `${p}new`;
}

/** Whose drafts: the account signed in (its user id, and the server's
 *  address in the Android app), as `u<id>@<server>:`, so another account
 *  on the same device never opens them and the same one gets them back
 *  after signing out and in. Empty with no account (single-user mode). */
export function draftScope() {
  try {
    const uid = localStorage.getItem('wl:userId');
    if (!uid) return '';
    const srv = String(localStorage.getItem('nt:serverUrl') || '').trim().replace(/\/+$/, '').toLowerCase();
    // No ':' inside a scope (a port), so keys stay easy to tell apart.
    return `u${uid}${srv ? `@${srv.replace(/^https?:\/\//, '').replace(/:/g, '_')}` : ''}:`;
  } catch {
    return '';
  }
}

// Draft keys of any account (and the unscoped ones from before).
const _DRAFT_KEY = /^nt:(u[^:]*:)?(food|meal):draft:/;
const _UNSCOPED = /^nt:(food|meal):draft:/;

/** Drafts made before they were kept per account belong to whoever was
 *  signed in then: the account still signed in when the app starts after
 *  the update. They move to its scope; with nobody signed in they go.
 *  Runs once. */
export function migrateUnscopedDrafts() {
  if (typeof localStorage === 'undefined') return;
  try {
    if (localStorage.getItem('nt:drafts:scoped') === '1') return;
    const scope = draftScope();
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && _UNSCOPED.test(k)) keys.push(k);
    }
    for (const k of keys) {
      if (!scope) { clearDraft(k); continue; }
      const to = k.replace(/^nt:/, `nt:${scope}`);
      try { localStorage.setItem(to, localStorage.getItem(k)); } catch { /* full: drop it */ }
      localStorage.removeItem(k);
      _idbGet(_idbImgKey(k)).then(img => (img ? _idbPut(_idbImgKey(to), img) : null)).then(() => _idbDelete(_idbImgKey(k)));
    }
    localStorage.setItem('nt:drafts:scoped', '1');
  } catch { /* storage unavailable */ }
}

/** What identifies a prefilled item that has no id yet, or null. A scan
 *  of an unknown barcode (a prefill with nothing but the barcode) stays on
 *  the blank-item draft, so after the app is killed mid-entry (#157: the
 *  label photo) "Add food" still brings the typing back. */
export function pickIdentity(p) {
  if (!p || typeof p !== 'object') return null;
  if (p.source_app && p.source_external_id) return `${p.source_app}:${p.source_external_id}`;
  if (p._mealieSlug) return `mealie:${p._mealieSlug}`;
  if (!String(p.name || '').trim()) return null;
  if (p.barcode) return `barcode:${p.barcode}`;
  // Any other prefill with a name: its name and brand, so a different
  // item never picks up this one's draft.
  const name = String(p.name || '').trim().toLowerCase();
  if (name) return `name:${name}|${String(p.brand || '').trim().toLowerCase()}`;
  return null;
}

// ── IndexedDB (photo) helpers ─────────────────────────────────────────
//
// Kept in one lazily-opened DB so the open cost is paid at most once
// per session. All ops are best-effort: any failure resolves quietly
// so a broken IDB layer (private-mode Safari, quota, storage evicted)
// can't cost the user their text draft.

const IDB_NAME = 'nt-editor-drafts';
const IDB_STORE = 'imgs';
const IDB_VERSION = 1;

let _idbPromise = null;
function _openIdb() {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  if (_idbPromise) return _idbPromise;
  _idbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(IDB_NAME, IDB_VERSION);
      req.onupgradeneeded = () => {
        try { req.result.createObjectStore(IDB_STORE); } catch { /* exists */ }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => { _idbPromise = null; resolve(null); };
      req.onblocked = () => resolve(null);
    } catch { _idbPromise = null; resolve(null); }
  });
  return _idbPromise;
}

function _idbImgKey(key) { return `${key}::img`; }

function _idbPut(key, value) {
  return _openIdb().then((db) => {
    if (!db) return;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror    = () => resolve();
        tx.onabort    = () => resolve();
      } catch { resolve(); }
    });
  }).catch(() => {});
}

function _idbGet(key) {
  return _openIdb().then((db) => {
    if (!db) return null;
    return new Promise((resolve) => {
      try {
        const req = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(key);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror   = () => resolve(null);
      } catch { resolve(null); }
    });
  }).catch(() => null);
}

function _idbDelete(key) {
  return _openIdb().then((db) => {
    if (!db) return;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror    = () => resolve();
        tx.onabort    = () => resolve();
      } catch { resolve(); }
    });
  }).catch(() => {});
}

/** Persist just the photo half of a draft to IndexedDB. Fire-and-forget;
 *  the returned promise is only useful in tests. */
export function saveDraftImg(key, dataUrl) {
  if (!key || !dataUrl) return Promise.resolve();
  return _idbPut(_idbImgKey(key), { at: _now(), dataUrl });
}

/** Load the photo half of a draft, if it exists and is fresh. Async so
 *  the caller can `await` it after the synchronous text load. */
export function loadDraftImg(key, { maxAgeMs = TTL_MS } = {}) {
  if (!key) return Promise.resolve(null);
  return _idbGet(_idbImgKey(key)).then((rec) => {
    if (!rec || !rec.dataUrl) return null;
    if (rec.at && _now() - rec.at > maxAgeMs) {
      _idbDelete(_idbImgKey(key));
      return null;
    }
    return rec.dataUrl;
  });
}

/** Delete just the photo half of a draft. */
export function clearDraftImg(key) {
  if (!key) return Promise.resolve();
  return _idbDelete(_idbImgKey(key));
}

// ── Text (localStorage) helpers ───────────────────────────────────────

/** Persist `state` under `key`. imgUrl is siphoned into IndexedDB so
 *  the text half fits comfortably in localStorage's per-origin cap. */
export function saveDraft(key, state) {
  if (!key || typeof localStorage === 'undefined') return;
  const src = (state && typeof state === 'object') ? state : {};
  // Split: any base64 photo (FoodEditor persists `imgUrl`, MealEditor
  // bundles `photoPreviewUrl`) is siphoned into IDB, everything else
  // goes to localStorage. Always call one of save/clear on the photo
  // side so a deleted photo doesn't linger in IDB after removal.
  const { imgUrl, photoPreviewUrl, ...textState } = src;
  const _img = imgUrl || photoPreviewUrl;
  if (_img) saveDraftImg(key, _img);
  else      clearDraftImg(key);
  const payload = { at: _now(), v: DRAFT_V, state: textState };
  try {
    localStorage.setItem(key, JSON.stringify(payload));
  } catch { /* over quota even without the image; drop this write */ }
}

/** Load the text half of a draft if fresh (within `maxAgeMs`). Expired
 *  drafts are removed. Returns the text state (imgUrl not included) or
 *  null. Photo restore is a separate `loadDraftImg` call. */
export function loadDraft(key, { maxAgeMs = TTL_MS } = {}) {
  if (!key || typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    // An earlier draft of a picked or saved item may be just the values it
    // opened with (#327); one of a blank new item can only be typing.
    const stale = parsed && parsed.v !== DRAFT_V && !/:draft:new$/.test(key);
    if (!parsed || typeof parsed !== 'object' || !parsed.at || !parsed.state || stale) {
      localStorage.removeItem(key);
      clearDraftImg(key);
      return null;
    }
    if (_now() - parsed.at > maxAgeMs) {
      localStorage.removeItem(key);
      clearDraftImg(key);
      return null;
    }
    return parsed.state;
  } catch {
    return null;
  }
}

/** Remove the draft at `key` (both text and photo). */
export function clearDraft(key) {
  if (!key) return;
  if (typeof localStorage !== 'undefined') {
    try { localStorage.removeItem(key); } catch { /* noop */ }
  }
  clearDraftImg(key);
}

/** Debounced setter factory. Returns a fn that, when called with a
 *  state object (and what the editor opened with), persists it after
 *  `delayMs` of quiet. Consecutive
 *  calls collapse into a single write, which is what the reactive
 *  `$: persist(food)` pattern needs (Svelte reactivity fires on
 *  every keystroke). Exposes `.cancel()` so a Discard action can
 *  drop any pending write instead of racing it back into storage. */
export function makeDebouncedPersist(key, delayMs = 400, { keep = [] } = {}) {
  let timer = null;
  /** `base`: what the editor opened with. Only the fields changed from it
   *  are kept (plus `keep`, which says what the draft is for), and with
   *  nothing changed the draft goes (#327). */
  const persist = function (state, base) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      if (base === undefined) { saveDraft(key, state); return; }
      const changes = draftChanges(state, base);
      if (!changes) { clearDraft(key); return; }
      for (const k of keep) if (state?.[k] != null && state[k] !== '') changes[k] = state[k];
      saveDraft(key, changes);
    }, delayMs);
  };
  persist.cancel = function () {
    if (timer) { clearTimeout(timer); timer = null; }
  };
  return persist;
}

/** Remove expired drafts (text and photo). Every item opened keeps its
 *  own draft, so they're swept here rather than left to pile up. Also
 *  drops the key every CookTrace recipe used to share (#260). */
export function sweepDrafts() {
  if (typeof localStorage === 'undefined') return;
  try {
    clearDraft('nt:meal:draft:edit:undefined');
    migrateUnscopedDrafts();
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && _DRAFT_KEY.test(k)) keys.push(k);
    }
    for (const k of keys) loadDraft(k);
  } catch { /* storage unavailable: nothing to sweep */ }
}
