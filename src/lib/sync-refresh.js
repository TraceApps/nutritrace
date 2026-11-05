/**
 * What a sync changed on this phone, and a page asking to hear of it.
 *
 * A page reads its lists from the phone's database when it opens, and again
 * only when told. A sync that brings a row in, changes one or takes one away
 * (a food deleted on the web) changes the database under a page that is open,
 * so sync.js ends every sync with 'nt:sync-complete' and says which kinds of
 * rows it touched (detail.kinds). A page calls onSynced with the kinds it
 * shows and reloads when one of them is touched.
 */

// A kind for every list the phone keeps from the server.
export const SYNC_KINDS = ['foods', 'meals', 'diary', 'activity', 'fasts', 'wellness', 'workouts', 'settings', 'chat', 'coaching'];

/**
 * The kinds a pull brought: `data` is the server's answer to /api/sync/pull,
 * `coachChanged` how many coaching rows came with it (they are stored apart).
 * Deleted rows travel in the same lists as the rest (deleted_at), so a delete
 * counts like any other change.
 */
export function pullKinds(data, coachChanged = 0) {
  const n = v => (Array.isArray(v) ? v.length : 0);
  const d = data || {};
  const del = d.deletions || {};
  const kinds = [];
  if (n(d.foods)) kinds.push('foods');
  if (n(d.meals)) kinds.push('meals');
  if (n(d.diary) || n(d.diary_tombstones)) kinds.push('diary');
  if (n(d.activity)) kinds.push('activity');
  if (n(d.fasts)) kinds.push('fasts');
  if (n(d.wellness) || n(del.wellness)) kinds.push('wellness');
  if (n(d.workouts) || n(del.workouts)) kinds.push('workouts');
  if (n(d.settings)) kinds.push('settings');
  if (n(d.chat_history)) kinds.push('chat');
  if (coachChanged) kinds.push('coaching');
  return kinds;
}

/**
 * Whether a 'nt:sync-complete' event touched any of `kinds`. An event that
 * doesn't say what it touched counts as touching everything.
 */
export function syncTouched(detail, kinds) {
  if (detail && detail.changed === false) return false;
  if (!detail || !Array.isArray(detail.kinds)) return true;
  return kinds.some(k => detail.kinds.includes(k));
}

/**
 * Calls `fn(detail)` after a sync that touched any of `kinds`. Returns the
 * function that stops listening (call it when the page goes).
 */
export function onSynced(kinds, fn) {
  if (typeof window === 'undefined') return () => {};
  const handler = (e) => { if (syncTouched(e?.detail, kinds)) fn(e?.detail); };
  window.addEventListener('nt:sync-complete', handler);
  return () => window.removeEventListener('nt:sync-complete', handler);
}

// ── An editor open on a row a sync changed ──────────────────────────────

const _same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * The fields of an editor's form changed since it opened: `now` and
 * `opened` are the form's values now and as it opened (or as it last took
 * a newer copy), in the same shape.
 */
export function touchedFields(now, opened) {
  return [...new Set([...Object.keys(now || {}), ...Object.keys(opened || {})])]
    .filter(k => !_same(now?.[k], opened?.[k]));
}

/**
 * An editor whose form is one object: `now` takes `fresh` (the newer copy,
 * as a form) in every field not changed since `opened`. Returns the form,
 * what it now counts as opened (a copy: a form's fields are changed in
 * place) and the fields kept.
 */
export function takeUntouched(now, opened, fresh) {
  const touched = touchedFields(now, opened);
  const form = {}, nextOpened = {};
  for (const k of new Set([...Object.keys(now || {}), ...Object.keys(fresh || {})])) {
    const keep = touched.includes(k);
    form[k] = keep ? now[k] : fresh?.[k];
    nextOpened[k] = keep ? opened?.[k] : fresh?.[k];
  }
  return { form, opened: JSON.parse(JSON.stringify(nextOpened)), touched };
}

/**
 * Calls `fn()` when the app comes back to the front: the page shown again
 * (back from the background, or another tab) or the window focused again.
 * For a view read from the server only, that no sync brings (a coach's
 * clients, a client's page, your coach, users). Only after it was away, so
 * coming back once reads once. Returns the function that stops listening.
 */
export function onComeBack(fn) {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => {};
  let away = false;
  const leave = () => { away = true; };
  const back = () => { if (away && document.visibilityState !== 'hidden') { away = false; fn(); } };
  const onVisibility = () => { if (document.visibilityState === 'hidden') leave(); else back(); };
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('blur', leave);
  window.addEventListener('focus', back);
  return () => {
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('blur', leave);
    window.removeEventListener('focus', back);
  };
}
