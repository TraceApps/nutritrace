/**
 * A save into a diary day deleted here: PUT /api/diary/:date
 * (routes/diary.js) and a phone's push of the day (routes/sync.js) bring
 * it back the same way, from an empty day, with only what was made after
 * the delete.
 */
import { parseUtc, editMs } from './sync-clock.js';
import { editRevives } from './field-sync.js';

// A save into a day deleted here brings the day back (it is made now:
// lib/field-sync.js editRevives), but only with what was made after the
// delete. An entry the deleted day didn't hold is new and comes back,
// whatever its time says (a clock running slow, one logged in the second
// of the delete). One it held comes back only when changed since (its own
// updatedAt, else addedAt). The rest (the deleted day's own, as a form
// opened before the delete still holds them) stay deleted, tombstoned so
// an older push of the day from a phone can't put them back. Returns
// { kept, gone: uuids }.
export function sinceDelete(deletedRow, field, entries, clock, now) {
  let had = [];
  try { had = JSON.parse(deletedRow[field] || '[]'); } catch { /* none */ }
  const hadList = Array.isArray(had) ? had : [];
  const hadUuids = new Set(hadList.map(e => e?.uuid).filter(Boolean));
  // An entry stored without a uuid (an MCP or REST write) comes back from
  // a client without one too: its twin by addedAt and name, as the merge
  // matches them (lib/diary-merge.js).
  const twin = e => (typeof e?.addedAt === 'string' && e.addedAt ? `${e.addedAt}\u0000${e.name ?? ''}\u0000${e.type ?? ''}` : null);
  const hadTwins = new Set(hadList.filter(e => e && !e.uuid).map(twin).filter(Boolean));
  const held = e => (e.uuid ? hadUuids.has(e.uuid) : hadTwins.has(twin(e)));
  const kept = [], gone = new Set(hadUuids);
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || typeof e !== 'object') continue;
    const t = e.updatedAt || e.addedAt;
    const at = typeof t === 'string' ? editMs(t, clock, now) : NaN;
    const after = !held(e) || (Number.isFinite(at) && editRevives({ existing: deletedRow, at }));
    if (after) { kept.push(e); if (e.uuid) gone.delete(e.uuid); }
    else if (typeof e.uuid === 'string' && e.uuid) gone.add(e.uuid);
  }
  for (const e of kept) if (e.uuid) gone.delete(e.uuid);
  return { kept, gone: [...gone] };
}

/**
 * The day a save into the deleted day `loaded` merges into: empty, its
 * measurements and note gone at the delete's time, so an older edit of
 * them sent later loses. `sent`: { items, water, body_stats, changed (the
 * measurements it says it changed), notes, notesAt }. A measurement or
 * note sent as the deleted day had it is an older copy (the web saves the
 * whole day it shows), not a change made now: it stays deleted unless the
 * save says it changed it (`changed`, a later `notesAt`). Returns { row,
 * items, water ({ kept, gone }), body_stats, notes } to merge.
 */
export function fromEmptyDay(loaded, sent, clock, now) {
  const goneTimes = () => {
    let t = {}, stats = {};
    try { t = JSON.parse(loaded.field_times || '{}') || {}; } catch { /* none */ }
    try { stats = JSON.parse(loaded.body_stats || '{}') || {}; } catch { /* none */ }
    const ms = parseUtc(loaded.deleted_at);
    if (!Number.isFinite(ms)) return loaded.field_times ?? null;
    const at = new Date(ms).toISOString();
    for (const k of Object.keys(stats)) t[`body_stats.${k}`] = at;
    return JSON.stringify(t);
  };
  const row = { ...loaded, items: '[]', water: '[]', body_stats: '{}', notes: null, notes_updated_at: loaded.deleted_at, field_times: goneTimes() };
  let body_stats = sent.body_stats, notes = sent.notes;
  let was = {};
  try { was = JSON.parse(loaded.body_stats || '{}') || {}; } catch { /* none */ }
  if (body_stats && typeof body_stats === 'object' && !Array.isArray(body_stats)) {
    body_stats = Object.fromEntries(Object.entries(body_stats).filter(([k, v]) => !(k in was && String(was[k]) === String(v) && !(sent.changed || []).includes(k))));
  }
  const noteAt = editMs(sent.notesAt, clock, now);
  if (typeof notes === 'string' && notes === loaded.notes && !(Number.isFinite(noteAt) && editRevives({ existing: loaded, at: noteAt }))) notes = null;
  return {
    row, body_stats, notes,
    items: sinceDelete(loaded, 'items', sent.items, clock, now),
    water: sinceDelete(loaded, 'water', sent.water, clock, now),
  };
}

export function parseSlotArray(raw) {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.filter(n => Number.isInteger(n) && n >= 0 && n <= 31);
  } catch { return []; }
}

// The deleted day's completion marks stay deleted, taken away at the
// delete's time, so an older mark sent later loses. A mark made after the
// delete (the completion routes take a deleted day too) stays, with its
// own time. `sent`: the marks a push of the day carries ({ completed_at,
// completed_meals, clock, now }): its day mark stays when made after the
// delete (completed_at is when it was made), and a meal mark the deleted
// day didn't hold is new and stays, as a new item does. Run once the day
// is written back.
export function dropMarksBeforeDelete(db, loaded, sent = null) {
  const at = loaded.deleted_at, delMs = parseUtc(at);
  const madeBefore = t => !Number.isFinite(parseUtc(t)) || !Number.isFinite(delMs) || parseUtc(t) <= delMs;
  const dayGone = !!loaded.completed_at && madeBefore(loaded.completion_marked_at);
  let completedAt = dayGone ? null : (loaded.completed_at ?? null);
  let marks = {};
  try { marks = JSON.parse(loaded.meal_marks_at || '{}') || {}; } catch { /* none */ }
  const held = parseSlotArray(loaded.completed_meals);
  const keep = [];
  for (const sl of held) {
    if (madeBefore(marks[sl])) marks[sl] = at; else keep.push(sl);
  }
  if (sent) {
    const t = typeof sent.completed_at === 'string' ? editMs(sent.completed_at, sent.clock, sent.now) : NaN;
    // Not over an unmark made after it (completion_marked_at, meal_marks_at).
    const unmarkedAfter = (when, ms) => Number.isFinite(parseUtc(when)) && parseUtc(when) >= ms;
    if (!completedAt && Number.isFinite(t) && editRevives({ existing: loaded, at: t }) && !unmarkedAfter(loaded.completion_marked_at, t)) completedAt = sent.completed_at;
    const slots = Array.isArray(sent.completed_meals) ? sent.completed_meals.filter(n => Number.isInteger(n) && n >= 0 && n <= 31) : [];
    for (const sl of slots) if (!held.includes(sl) && !keep.includes(sl) && !unmarkedAfter(marks[sl], delMs)) keep.push(sl);
    keep.sort((a, b) => a - b);
  }
  db.prepare(`UPDATE diary SET completed_at = ?, completed_meals = ?, completion_marked_at = ?, meal_marks_at = ? WHERE id = ?`)
    .run(completedAt, keep.length ? JSON.stringify(keep) : null,
      dayGone ? at : (loaded.completion_marked_at ?? null), Object.keys(marks).length ? JSON.stringify(marks) : null, loaded.id);
}
