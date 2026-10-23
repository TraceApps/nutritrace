/**
 * Coaching recommendations: a coach suggests, the client answers.
 *
 * Only Accepted changes anything, and that happens on the client's device
 * (their goals are their settings; the device applies the recommendation
 * and syncs it like any other change, so it also works offline). The server
 * keeps the recommendation and its answer: the history both sides see.
 *
 * Kinds: 'targets', 'day_plan' (one per date), and 'meal' / 'recipe' (Send
 * to Client: a copy of one of the coach's, which becomes the client's own
 * on Accept, made here so it reaches every device of theirs by sync).
 */
import crypto from 'crypto';
import db from '../db.js';
import { logger } from '../logger.js';
import { personName } from './coaching.js';
import { pushNotifyDefaultOn } from './push-notify.js';
import { cleanTargetsPayload } from '../../src/lib/coach-targets.js';
import { cleanPlanPayload, cleanPlanDates, loggedMeals, ingredientFoodId } from '../../src/lib/coach-plans.js';
import { Nutrition } from '../../src/lib/nutrition.js';
import { localizeImage } from './image-localizer.js';

export const NOTE_MAX = 500;
const _json = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
const _note = (v) => { const s = typeof v === 'string' ? v.trim() : ''; return s ? s.slice(0, NOTE_MAX) : null; };
const _name = (id) => personName(db.prepare('SELECT full_name, username FROM users WHERE id = ?').get(id)) || 'Someone';

function _bad(message, status = 400, code = null, params = null) { const e = new Error(message); e.status = status; if (code) e.code = code; if (params) e.params = params; return e; }

/** A recommendation as the app sees it (ids only, the payload parsed). */
export function recommendationOut(r) {
  if (!r) return null;
  return {
    id: r.id, pairing_id: r.pairing_id, coach_id: r.coach_id, client_id: r.client_id,
    kind: r.kind, date: r.date || null, payload: _json(r.payload, {}), note: r.note || null,
    status: r.status, response_note: r.response_note || null,
    created_at: r.created_at, responded_at: r.responded_at || null, updated_at: r.updated_at,
  };
}

const _row = (id) => db.prepare('SELECT * FROM coach_recommendations WHERE id = ?').get(id);

/**
 * The coach recommends targets to the client of this active pairing. A
 * pending target recommendation is replaced by the new one. The
 * recommendation also appears in the conversation.
 */
export function recommendTargets(pairing, coachId, body) {
  const { payload, error, code, params } = cleanTargetsPayload(body?.payload);
  if (error) throw _bad(error, 400, code, params);
  const note = _note(body?.note);
  const id = db.transaction(() => {
    db.prepare(`
      UPDATE coach_recommendations SET status = 'replaced', updated_at = datetime('now')
       WHERE pairing_id = ? AND kind = 'targets' AND status = 'pending'
    `).run(pairing.id);
    const rid = db.prepare(`
      INSERT INTO coach_recommendations (pairing_id, coach_id, client_id, kind, payload, note)
      VALUES (?, ?, ?, 'targets', ?, ?)
    `).run(pairing.id, coachId, pairing.client_id, JSON.stringify(payload), note).lastInsertRowid;
    db.prepare(`
      INSERT INTO coach_messages (uuid, pairing_id, sender_id, body, recommendation_id)
      VALUES (?, ?, ?, NULL, ?)
    `).run(crypto.randomUUID(), pairing.id, coachId, rid);
    return rid;
  })();
  _notifyClient(pairing, coachId);
  return recommendationOut(_row(id));
}

/**
 * The coach sends a day plan for one date, or the same plan for several
 * (Copy to Other Days). One plan per date: the plan standing on that date,
 * waiting or accepted, is replaced (what the client logged from it stays in
 * their Diary). Dates from yesterday (in any time zone, today somewhere) to
 * a year ahead. Each appears in the conversation; the client gets one
 * notification.
 */
export function recommendDayPlan(pairing, coachId, body) {
  const { payload, error, code, params } = cleanPlanPayload(body?.payload);
  if (error) throw _bad(error, 400, code, params);
  const { dates, error: dateError, code: dateCode, params: dateParams } = cleanPlanDates(body);
  if (dateError) throw _bad(dateError, 400, dateCode, dateParams);
  const { lo, hi } = db.prepare(`SELECT date('now', '-1 day') AS lo, date('now', '+366 day') AS hi`).get();
  if (dates.some(d => d < lo || d > hi)) throw _bad('A plan is for today or a later day.', 400, 'plan_date_range');
  const note = _note(body?.note);
  const ids = db.transaction(() => dates.map(date => {
    db.prepare(`
      UPDATE coach_recommendations SET status = 'replaced', updated_at = datetime('now')
       WHERE pairing_id = ? AND kind = 'day_plan' AND date = ? AND status IN ('pending', 'accepted')
    `).run(pairing.id, date);
    const rid = db.prepare(`
      INSERT INTO coach_recommendations (pairing_id, coach_id, client_id, kind, date, payload, note)
      VALUES (?, ?, ?, 'day_plan', ?, ?, ?)
    `).run(pairing.id, coachId, pairing.client_id, date, JSON.stringify(payload), note).lastInsertRowid;
    db.prepare(`
      INSERT INTO coach_messages (uuid, pairing_id, sender_id, body, recommendation_id)
      VALUES (?, ?, ?, NULL, ?)
    `).run(crypto.randomUUID(), pairing.id, coachId, rid);
    return rid;
  }))();
  _notifyClient(pairing, coachId);
  return ids.map(id => recommendationOut(_row(id)));
}

// What a sent meal or recipe keeps of each ingredient: what it is and how
// much, never whose catalog or sharing it came from, nor the coach's own
// notes on their food.
const _INGREDIENT_KEEP = ['name', 'brand', 'portion', 'unit', 'quantity', 'nutrition', 'barcode', 'is_recipe', 'nutrition_basis', 'alt_units', 'density_g_ml'];
const _num = (v, d = null) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : d);

/**
 * Send to Client: the coach sends one of their own meals or recipes. The
 * recommendation holds a full copy (works with sharing off, and later edits
 * of the coach's never change what was sent); the client gets their own copy
 * on Accept.
 */
const _LOCAL_IMG = /^\/uploads\/[\w.-]+$/;
const _SOURCE_ORIGIN_KEY = new Map([['cooktrace', 'cooktraceBaseUrl'], ['mealie', 'mealieBaseUrl']]);
// The app waits 15 s for an answer: the picture gets at most 5 of them.
const _SEND_IMAGE_TIMEOUT_MS = 5000;

/**
 * The picture a sent meal carries: its own upload, or an image it links to
 * elsewhere (an import from CookTrace or Mealie) downloaded first through
 * the server's image download (the address checks, images only, the size
 * limit), as saving a meal with that link does. None if that fails.
 */
async function _sentImage(meal, coachId, { allowPrivate = false } = {}) {
  const url = typeof meal.img_url === 'string' ? meal.img_url.trim() : '';
  if (!url) return null;
  if (_LOCAL_IMG.test(url)) return url;
  if (!/^https?:\/\//i.test(url)) return null;
  const key = _SOURCE_ORIGIN_KEY.get(meal.source_app);
  const saved = key ? db.prepare(`SELECT value FROM user_settings WHERE user_id = ? AND key = ? AND deleted_at IS NULL`).get(coachId, key) : null;
  const origin = (saved?.value || '').replace(/^"|"$/g, '');
  const local = await localizeImage(url, { trustedOrigins: origin ? [origin] : [], allowPrivate, timeoutMs: _SEND_IMAGE_TIMEOUT_MS });
  if (typeof local !== 'string' || !_LOCAL_IMG.test(local)) return null;
  // The coach's meal keeps the downloaded picture, as saving it would (so
  // the next send doesn't download it again).
  db.prepare(`UPDATE meals SET img_url = ?, updated_at = datetime('now') WHERE id = ? AND img_url = ?`).run(local, meal.id, meal.img_url);
  return local;
}

export async function recommendMealItem(pairing, coachId, body, { allowPrivateImages = false } = {}) {
  const meal = db.prepare('SELECT * FROM meals WHERE id = ? AND user_id = ? AND deleted_at IS NULL').get(Number(body?.meal_id), coachId);
  if (!meal) throw _bad('Choose one of your own meals or recipes.', 404, 'own_meal_only');
  const img = await _sentImage(meal, coachId, { allowPrivate: allowPrivateImages });
  // Its kind is the saved one's (an unsaved switch in the editor doesn't count).
  const kind = meal.is_recipe ? 'recipe' : 'meal';
  const items = (_json(meal.items, []) || []).filter(it => it && typeof it === 'object').slice(0, 200).map(it => {
    const out = Object.fromEntries(_INGREDIENT_KEEP.filter(k => it[k] !== undefined).map(k => [k, it[k]]));
    out.name = String(it.name || '').slice(0, 200);
    // An older item keeps its values flat, not in `nutrition`: gathered here.
    if (!out.nutrition || typeof out.nutrition !== 'object') out.nutrition = Nutrition.calculate({ ...it, quantity: 1 });
    const fid = it.is_recipe ? null : Number(ingredientFoodId(it));
    if (Number.isInteger(fid) && fid > 0) out.source = { kind: 'coach_food', id: fid };
    return out;
  });
  const payload = {
    meal: {
      id: meal.id, name: meal.name, is_recipe: !!meal.is_recipe,
      portion: _num(meal.portion, 100), unit: meal.unit || 'g', servings: _num(meal.servings),
      nutrition: _json(meal.nutrition, {}) || {}, notes: meal.notes || null,
      img_url: img,
      items,
    },
  };
  const note = _note(body?.note);
  const id = db.transaction(() => {
    // Still coaching after the picture's download (the client may have left meanwhile).
    if (db.prepare(`SELECT status FROM coach_clients WHERE id = ?`).get(pairing.id)?.status !== 'active') throw _bad('Client not found', 404, 'client_not_found');
    const rid = db.prepare(`
      INSERT INTO coach_recommendations (pairing_id, coach_id, client_id, kind, payload, note)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(pairing.id, coachId, pairing.client_id, kind, JSON.stringify(payload), note).lastInsertRowid;
    db.prepare(`
      INSERT INTO coach_messages (uuid, pairing_id, sender_id, body, recommendation_id)
      VALUES (?, ?, ?, NULL, ?)
    `).run(crypto.randomUUID(), pairing.id, coachId, rid);
    return rid;
  })();
  _notifyClient(pairing, coachId);
  return recommendationOut(_row(id));
}

/**
 * The client's own copy of a sent meal or recipe, made on Accept: a new meal
 * each time, remembering where it came from (source 'coach',
 * 'meal:<id>:<recommendation>'; not `source_id`, which Save a Copy of a
 * shared item looks for, so From Others works as before), and each
 * ingredient's food copied into their foods unless they have it (their own,
 * one with its barcode, or the copy made before: source 'coach', 'food:<id>'),
 * so it logs, splits and edits as their own with sharing off.
 */
function _copyMealItem(r) {
  const m = _json(r.payload, {})?.meal;
  if (!m || !m.name) return null;
  const u = r.client_id;
  const findSource = db.prepare(`SELECT * FROM foods WHERE user_id = ? AND source_app = 'coach' AND source_external_id = ? AND deleted_at IS NULL`);
  const findBarcode = db.prepare(`SELECT * FROM foods WHERE user_id = ? AND barcode = ? AND deleted_at IS NULL LIMIT 1`);
  // The client's own food (one they shared with their coach).
  const findOwn = db.prepare(`SELECT * FROM foods WHERE id = ? AND user_id = ? AND deleted_at IS NULL`);
  const letGo = db.prepare(`UPDATE foods SET source_app = NULL, source_external_id = NULL WHERE user_id = ? AND source_app = 'coach' AND source_external_id = ? AND deleted_at IS NOT NULL`);
  const insFood = db.prepare(`
    INSERT INTO foods (user_id, name, brand, nutrition, portion, unit, barcode, notes, nutrition_basis, alt_units, density_g_ml, visibility, source_app, source_external_id, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'private', 'coach', ?, datetime('now'))
  `);
  const items = (m.items || []).map(it => {
    const { source, ...snap } = it;
    if (source?.kind !== 'coach_food') return snap;
    const ext = `food:${source.id}`;
    let food = findOwn.get(source.id, u) || findSource.get(u, ext) || (snap.barcode ? findBarcode.get(u, String(snap.barcode)) : null);
    if (!food) {
      letGo.run(u, ext);
      const id = insFood.run(u, snap.name, snap.brand || null, JSON.stringify(snap.nutrition || {}), _num(snap.portion, 100), snap.unit || 'g',
        snap.barcode || null, snap.notes || null, snap.nutrition_basis || null,
        snap.alt_units == null ? null : (typeof snap.alt_units === 'string' ? snap.alt_units : JSON.stringify(snap.alt_units)),
        _num(snap.density_g_ml), ext).lastInsertRowid;
      food = { id };
    }
    return { ...snap, id: food.id, food_server_id: food.id };
  });
  return db.prepare(`
    INSERT INTO meals (user_id, name, nutrition, items, img_url, notes, is_recipe, portion, unit, servings, visibility, source_app, source_external_id, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'private', 'coach', ?, datetime('now'))
  `).run(u, m.name, JSON.stringify(m.nutrition || {}), JSON.stringify(items), m.img_url || null, m.notes || null,
    m.is_recipe ? 1 : 0, _num(m.portion, 100), m.unit || 'g', _num(m.servings), `meal:${m.id}:${r.id}`).lastInsertRowid;
}

/**
 * The client's answer: accepted or declined, with an optional note. Only a
 * pending recommendation of an active pairing can be answered; otherwise a
 * 409 carries its status now (replaced, withdrawn, already answered).
 */
export function answerRecommendation(id, clientId, { status, response_note } = {}) {
  const r = _row(Number(id));
  if (!r || r.client_id !== clientId) throw _bad('Recommendation not found', 404, 'recommendation_not_found');
  if (!['accepted', 'declined'].includes(status)) throw _bad('The answer must be accepted or declined.', 400, 'answer_invalid');
  if (r.status !== 'pending') {
    const e = _bad(r.status === 'replaced' ? 'Replaced by a newer recommendation.' : r.status === 'withdrawn' ? 'This recommendation was withdrawn.' : 'This recommendation was already answered.', 409,
      r.status === 'replaced' ? 'rec_replaced' : r.status === 'withdrawn' ? 'rec_withdrawn' : 'rec_answered');
    e.row = recommendationOut(r);
    throw e;
  }
  // A sent meal or recipe becomes the client's own in the same step: answered
  // once, copied once.
  const changed = db.transaction(() => {
    const n = db.prepare(`
      UPDATE coach_recommendations SET status = ?, response_note = ?, responded_at = datetime('now'), updated_at = datetime('now')
       WHERE id = ? AND status = 'pending'
    `).run(status, _note(response_note), r.id).changes;
    if (n && status === 'accepted' && (r.kind === 'meal' || r.kind === 'recipe')) _copyMealItem(r);
    return n;
  })();
  const out = _row(r.id);
  // Answered (from Goals, the Diary or the conversation): its message is read.
  db.prepare(`UPDATE coach_messages SET read_at = datetime('now'), updated_at = datetime('now') WHERE recommendation_id = ? AND read_at IS NULL`).run(r.id);
  if (changed) _notifyCoach(out);
  return recommendationOut(out);
}

/**
 * What a coach recommended in this pairing. Accepted day plans say which of
 * their meals the client logged (from that day's diary, as the client's
 * card works it out).
 */
export function listForPairing(pairingId) {
  const rows = db.prepare('SELECT * FROM coach_recommendations WHERE pairing_id = ? AND deleted_at IS NULL ORDER BY created_at DESC, id DESC').all(pairingId).map(recommendationOut);
  const dayItems = db.prepare('SELECT items FROM diary WHERE user_id = ? AND date = ? AND deleted_at IS NULL');
  for (const r of rows) {
    if (r.kind !== 'day_plan' || r.status !== 'accepted') continue;
    r.logged_meals = [...loggedMeals(_json(dayItems.get(r.client_id, r.date)?.items, []), r)].sort((a, b) => a - b);
  }
  return rows;
}

/** Everything recommended to this client, in any of their pairings. */
export function listForClient(clientId) {
  return db.prepare(`
    SELECT r.* FROM coach_recommendations r JOIN coach_clients cc ON cc.id = r.pairing_id
     WHERE r.client_id = ? AND cc.status IN ('active', 'ended') AND r.deleted_at IS NULL
     ORDER BY r.created_at DESC, r.id DESC
  `).all(clientId).map(recommendationOut);
}

async function _notifyClient(pairing, coachId) {
  try {
    await pushNotifyDefaultOn(pairing.client_id, 'notifCoachRecommendation', 'Coaching', `${_name(coachId)} sent you a recommendation.`, 5);
  } catch (e) { logger.warn(`[coaching] recommendation notification failed: ${e?.message || e}`); }
}

async function _notifyCoach(r) {
  try {
    const who = _name(r.client_id);
    const what = r.kind === 'day_plan' ? `your day plan for ${r.date}`
      : r.kind === 'meal' || r.kind === 'recipe' ? `your ${r.kind}, ${_json(r.payload, {})?.meal?.name || ''}`.replace(/, $/, '')
      : 'your recommended targets';
    await pushNotifyDefaultOn(r.coach_id, 'notifClientAnswer', 'Coaching', `${who} ${r.status === 'accepted' ? 'accepted' : 'declined'} ${what}.`, 5);
  } catch (e) { logger.warn(`[coaching] answer notification failed: ${e?.message || e}`); }
}
