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
 *     under a per-editor draft key so it survives process death.
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

function _now() { return Date.now(); }

/** Build a namespaced draft key. `kind` = 'food' | 'meal'. `id` = the
 *  edited row's id, or null / undefined for a new (create) draft. */
export function draftKey(kind, id) {
  if (id != null) return `nt:${kind}:draft:edit:${id}`;
  return `nt:${kind}:draft:new`;
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
  const payload = { at: _now(), state: textState };
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
    if (!parsed || typeof parsed !== 'object' || !parsed.at || !parsed.state) {
      localStorage.removeItem(key);
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
 *  state object, persists it after `delayMs` of quiet. Consecutive
 *  calls collapse into a single write, which is what the reactive
 *  `$: persist(food)` pattern needs (Svelte reactivity fires on
 *  every keystroke). Exposes `.cancel()` so a Discard action can
 *  drop any pending write instead of racing it back into storage. */
export function makeDebouncedPersist(key, delayMs = 400) {
  let timer = null;
  const persist = function (state) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => saveDraft(key, state), delayMs);
  };
  persist.cancel = function () {
    if (timer) { clearTimeout(timer); timer = null; }
  };
  return persist;
}
