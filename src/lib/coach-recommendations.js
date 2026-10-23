/**
 * coach-recommendations.js: what a coach recommended to this person, on
 * this device, and their answer.
 *
 * Accepting targets changes the person's own goals here (the Goals settings,
 * which sync like any edit, so it works with no connection): first their
 * goals as they are now are saved as a template, "Before coach change,
 * <date>", then only the recommended values are written. Undo applies that
 * template. The answer itself waits on the device and goes to the server
 * when it can (the coach sees Accepted or Declined).
 *
 * Kept on the device: the browser's offline database and the Android app's
 * SQLite, like the conversation.
 */
import { get } from 'svelte/store';
import { isNative } from './platform.js';
import { NtApi } from './api.js';
import { goals as goalsStore, goalTemplates, calorieGoalMode, waterGoalMl } from '../stores/settings.js';
import { applyTargets, beforeTemplate, matchesTemplate, TARGET_KEYS } from './coach-targets.js';

async function _store() {
  if (isNative) {
    const n = await import('./db-native.js');
    return {
      available: async () => true,
      settle: (row) => n.dbSettleCoachRecommendation(row),
      list: () => n.dbCoachRecommendations(),
      upsert: (rows) => n.dbUpsertCoachRecommendations(rows),
      keep: (ids) => n.dbKeepCoachRecommendations(ids),
      answer: (id, status, note) => n.dbAnswerCoachRecommendation(id, status, note),
      pending: () => n.dbPendingCoachAnswers(),
    };
  }
  const { coachStore: s } = await import('./offline-api.js');
  const all = async () => (await s.all('coach_recommendations')) || [];
  return {
    available: () => s.available(),
    settle: (row) => s.put('coach_recommendations', [{ ...row, sync_status: 'synced' }]),
    list: async () => (await all()).filter(r => !r.deleted_at)
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || b.id - a.id),
    upsert: async (rows) => {
      const mine = new Map((await all()).map(r => [r.id, r]));
      const put = rows.filter(r => r?.id != null && !(mine.get(r.id)?.sync_status === 'pending' && r.status === 'pending'))
        .map(r => ({ ...r, sync_status: 'synced' }));
      if (put.length) await s.put('coach_recommendations', put);
    },
    keep: async (ids) => {
      const keep = new Set((ids || []).map(Number));
      const gone = (await all()).filter(r => !keep.has(r.id) && r.sync_status !== 'pending').map(r => r.id);
      if (gone.length) await s.del('coach_recommendations', gone);
    },
    answer: async (id, status, note) => {
      const r = (await all()).find(x => x.id === id);
      if (r) await s.put('coach_recommendations', [{ ...r, status, response_note: note || null, responded_at: new Date().toISOString(), sync_status: 'pending' }]);
    },
    pending: async () => (await all()).filter(r => r.sync_status === 'pending').map(r => ({ id: r.id, status: r.status, response_note: r.response_note })),
  };
}

/** What this device holds, newest first. */
export async function loadRecommendations() {
  return (await _store()).list();
}

/** Ask the server for this person's recommendations (they're in coaching). */
export async function refreshRecommendations() {
  const rows = await NtApi.get('/api/coaching/recommendations');
  const store = await _store();
  // Nowhere to keep them (the browser's database blocked): show the server's.
  if (!(await store.available())) return rows || [];
  await store.upsert(rows || []);
  await store.keep((rows || []).map(r => r.id));
  return store.list();
}

/** The server's row for one, as it is (refused answers, ones gone). */
export async function settleRecommendation(row) {
  const store = await _store();
  const local = (await store.list()).find(r => r.id === row.id) || {};
  await store.settle({ ...local, ...row });
}

/** Recommendations that came with the Android sync. */
export async function storeSyncedRecommendations(rows) {
  if (rows?.length) await (await _store()).upsert(rows);
}

let _flushing = null;
/**
 * Send answers made on this device. One the server can no longer take
 * (replaced or withdrawn meanwhile, or gone with its coach) takes the
 * server's word for its status, and an Accept it refused is put back
 * (the goals return to the template) if nothing changed them since.
 */
export function flushAnswers() {
  if (_flushing) return _flushing;
  _flushing = (async () => {
    const store = await _store();
    let sent = 0, offline = false;
    const refused = [];
    for (const a of await store.pending()) {
      try {
        const row = await NtApi.post(`/api/coaching/recommendations/${a.id}/answer`, { status: a.status, response_note: a.response_note || undefined });
        await store.upsert([row]);
        sent++;
      } catch (e) {
        const status = Number(e?.status) || 0;
        if (e?.offline || !status || status >= 500) { offline = true; break; }
        // Refused for good: what it is now (or gone), and undo a refused Accept.
        let now = null;
        try {
          const all = await NtApi.get('/api/coaching/recommendations') || [];
          now = all.find(r => r.id === a.id) || null;
          // What replaced it comes too.
          await store.upsert(all.filter(r => r.id !== a.id));
        } catch { offline = true; break; }
        const settled = now || { ...(await store.list()).find(r => r.id === a.id), status: 'withdrawn' };
        await store.settle(settled);
        refused.push(a.id);
        if (a.status === 'accepted') revertRefusedAccept(settled);
        sent++;
      }
    }
    if (sent && typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('nt:coach-recommendations'));
    if (sent) _refreshCounts();
    return { sent, offline, refused };
  })().finally(() => { _flushing = null; });
  return _flushing;
}

/** An answer marks its message read on the server: the dot and counts follow. */
function _refreshCounts() {
  import('../stores/coaching.js').then(m => m.refreshCoaching()).catch(() => {});
}

const _templateName = (t, date) => t('coaching.targets.template_name', { values: { date } });
const _accepting = new Set();

/** The goals and mode Accept wrote for this recommendation (from its template). */
function _applied(rec, tpl) {
  return applyTargets(tpl.goals, tpl.calorieGoalMode, rec.payload);
}

/**
 * An Accept the server refused (replaced or withdrawn meanwhile): the
 * goals go back, if they are still what Accept wrote. Returns true if so.
 */
export function revertRefusedAccept(rec) {
  const tpl = templateFor(rec);
  if (!tpl || rec?.status === 'accepted') return false;
  const was = _applied(rec, tpl);
  if (!matchesTemplate({ goals: was.goals, calorieGoalMode: was.mode }, get(goalsStore), get(calorieGoalMode))) return false;
  return undoTargets(rec);
}

/**
 * Accept targets. With a connection the answer goes first and the goals
 * change only once the server took it (a recommendation replaced
 * meanwhile changes nothing). With none, the goals change here and the
 * answer waits. Either way, the goals as they were are saved first as a
 * template ("Before coach change, <date>") for Undo.
 * Returns { applied, offline, refused }.
 */
export async function acceptTargets(rec, { note = '', t, date = new Date().toLocaleDateString() } = {}) {
  if (_accepting.has(rec.id) || templateFor(rec)) return { applied: false, offline: false, refused: false };
  _accepting.add(rec.id);
  try {
    const store = await _store();
    let offline = false;
    try {
      const row = await NtApi.post(`/api/coaching/recommendations/${rec.id}/answer`, { status: 'accepted', response_note: note || undefined });
      await store.upsert([row]);
      _refreshCounts();
    } catch (e) {
      const status = Number(e?.status) || 0;
      if (!(e?.offline || !status || status >= 500)) {
        // Refused: nothing changes; the card shows what it is now.
        // (and a newer one, if that's what replaced it).
        try { await refreshRecommendations(); } catch { /* shown on the next look */ }
        if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('nt:coach-recommendations'));
        return { applied: false, offline: false, refused: true };
      }
      offline = true;
    }
    const current = get(goalsStore) || {};
    const mode = get(calorieGoalMode) || 'fixed';
    const tpl = beforeTemplate({ goals: current, mode, waterGoalMl: get(waterGoalMl), name: _templateName(t, date), recommendationId: rec.id });
    goalTemplates.update(list => [...(list || []), tpl]);
    const next = applyTargets(current, mode, rec.payload);
    goalsStore.set(next.goals);
    if (next.mode !== mode) calorieGoalMode.set(next.mode);
    if (offline) {
      if (await store.available()) await store.answer(rec.id, 'accepted', note);
      else throw new Error('no store');
    }
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('nt:coach-recommendations'));
    return { applied: true, offline, refused: false };
  } finally { _accepting.delete(rec.id); }
}

/**
 * An answer that changes nothing else on the device: it is kept here and
 * sent when it can (one the server refuses shows what it is now).
 */
async function _answer(rec, status, note) {
  const store = await _store();
  const changed = () => { if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('nt:coach-recommendations')); };
  if (!(await store.available())) {
    try {
      await NtApi.post(`/api/coaching/recommendations/${rec.id}/answer`, { status, response_note: note || undefined });
    } catch (e) {
      const code = Number(e?.status) || 0;
      if (code === 409 || code === 404) { changed(); return { offline: false, refused: true }; }
      throw e;
    }
    _refreshCounts();
    changed();
    return { offline: false, refused: false };
  }
  await store.answer(rec.id, status, note);
  changed();
  const r = await flushAnswers().catch(() => ({ offline: true }));
  return { offline: !!r?.offline, refused: !!r?.refused?.includes(rec.id) };
}

/** Decline (with an optional note). Nothing else changes. */
export function declineTargets(rec, { note = '' } = {}) {
  return _answer(rec, 'declined', note);
}

/**
 * Accept or decline a day plan. Accepting changes nothing by itself: the
 * plan's card then offers Log This and Log All, with or without a connection.
 */
export function answerPlan(rec, status, { note = '' } = {}) {
  return _answer(rec, status, note);
}

/** The template Accept saved for this recommendation, if it's still there. */
export function templateFor(rec) {
  return (get(goalTemplates) || []).find(x => x.coachRecommendationId === rec?.id) || null;
}

/**
 * Undo: the targets Accept changed (and the calorie mode) go back to the
 * template it saved, exactly; any other goal changed since stays as it is.
 * The template stays in Goals, Templates.
 */
export function undoTargets(rec) {
  const tpl = templateFor(rec);
  if (!tpl) return false;
  const before = JSON.parse(JSON.stringify(tpl.goals || {}));
  const next = { ...(get(goalsStore) || {}) };
  for (const key of TARGET_KEYS) {
    if (!rec.payload?.goals?.[key]) continue;
    if (before[key] === undefined) delete next[key]; else next[key] = before[key];
  }
  goalsStore.set(next);
  if (tpl.calorieGoalMode) calorieGoalMode.set(tpl.calorieGoalMode);
  return true;
}

/** Whether Undo has been done (the changed targets and mode are the template's). */
export function isUndone(rec, goals, mode) {
  const tpl = templateFor(rec);
  if (!tpl) return false;
  const pick = (g) => Object.fromEntries(TARGET_KEYS.filter(k => rec.payload?.goals?.[k] && g?.[k] !== undefined).map(k => [k, g[k]]));
  return matchesTemplate({ goals: pick(tpl.goals), calorieGoalMode: tpl.calorieGoalMode }, pick(goals), mode);
}
