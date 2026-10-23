/**
 * /api/coaching: connecting a coach and a client, and the coach's read-only
 * view of a client.
 *
 * Every route under /clients/:clientId goes through requireCoachOf (the one
 * guard: an active pairing between this coach and this client). Later phases
 * add their client routes under the same prefix and get the guard with them.
 * No route returns a full user row: people are { id, name }.
 */
import { Router } from 'express';
import db from '../db.js';
import { wrap } from '../logger.js';
import { ownerOrOptIn } from '../lib/outbound-policy.js';
import { requireAdmin } from '../middleware/auth.js';
import {
  NOTE_MAX, canCoach, roleOf, person, coachingState, endPairing,
  requireAccount, requireCoachRole, requireCoachOf,
} from '../lib/coaching.js';
import { dayTargets } from '../../src/lib/goal-resolver.js';
import { Nutrition } from '../../src/lib/nutrition.js';
import { _bodyStatsWeightKg } from '../lib/adaptive-tdee.js';
import fs from 'fs';
import path from 'path';
import { linkBase } from '../lib/public-url.js';
import {
  canRead, canWrite, createMessage, deleteMessage, markRead, listMessages, messageOut,
  notifyMessage, notifyClientAnswer, notifyRequest, pairingById, photoPath, PHOTO_TYPES,
} from '../lib/coaching-messages.js';
import { UPLOAD_RESPONSE_HEADERS } from '../lib/upload-paths.js';
import { recommendTargets, recommendDayPlan, recommendMealItem, answerRecommendation, listForPairing, listForClient } from '../lib/coaching-recommendations.js';
import { computeAdaptiveTdee } from '../lib/adaptive-tdee.js';
import { TARGET_KEYS } from '../../src/lib/coach-targets.js';
import { ingredientFoodId } from '../../src/lib/coach-plans.js';

const router = Router();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const OVERVIEW_DAYS = 7;
const WEIGHT_DAYS = 90;
// A day is on target when its calories are within this share of the target.
const ON_TARGET = 0.1;

const _json = (s, fallback) => { try { return s == null ? fallback : JSON.parse(s); } catch { return fallback; } };

function _setting(userId, key, fallback = null) {
  const row = db.prepare(`SELECT value FROM user_settings WHERE user_id = ? AND key = ? AND deleted_at IS NULL`).get(userId, key);
  return row ? _json(row.value, fallback) : fallback;
}

/** YYYY-MM-DD, n days before `date` (calendar arithmetic, no time zone). */
function _shift(date, n) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** The coach's today, from the app (so a coach a time zone away sees their own day). */
function _today(req) {
  const t = String(req.query.today || '');
  return DATE_RE.test(t) ? t : new Date().toLocaleDateString('sv-SE');
}

/** Calories and the three macros for one day, the way the client's Diary resolves them. */
const _targetsFor = (goals, date) => dayTargets(goals, date);

function _dayTotals(items) {
  const t = Nutrition.sum((items || []).map(i => Nutrition.calculate(i)));
  const r = (v) => Math.round((Number(v) || 0) * 10) / 10;
  return { calories: r(t.calories), proteins: r(t.proteins), carbohydrates: r(t.carbohydrates), fat: r(t.fat) };
}

function _onTarget(day) {
  if (!day.logged || !(day.targets.calories > 0)) return null;
  return Math.abs(day.totals.calories - day.targets.calories) <= day.targets.calories * ON_TARGET;
}

/** The last `n` days ending today: what was eaten against the targets. */
function _recentDays(clientId, today, n = OVERVIEW_DAYS) {
  const goals = _setting(clientId, 'goals', {}) || {};
  const from = _shift(today, -(n - 1));
  const rows = new Map(db.prepare(`
    SELECT date, items FROM diary WHERE user_id = ? AND deleted_at IS NULL AND date BETWEEN ? AND ?
  `).all(clientId, from, today).map(r => [r.date, _json(r.items, [])]));
  const days = [];
  for (let i = n - 1; i >= 0; i--) {
    const date = _shift(today, -i);
    const items = rows.get(date) || [];
    const day = { date, logged: items.length > 0, totals: _dayTotals(items), targets: _targetsFor(goals, date) };
    day.on_target = _onTarget(day);
    days.push(day);
  }
  return days;
}

function _lastLogged(clientId) {
  return db.prepare(`
    SELECT MAX(date) AS d FROM diary
     WHERE user_id = ? AND deleted_at IS NULL AND items IS NOT NULL AND items NOT IN ('', '[]')
  `).get(clientId)?.d || null;
}

function _summary(days) {
  const judged = days.filter(d => d.on_target != null);
  return { days: days.length, logged: days.filter(d => d.logged).length, judged: judged.length, on_target: judged.filter(d => d.on_target).length };
}

const _note = (v) => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s ? s.slice(0, NOTE_MAX) : null;
};

const _rank = (r) => (r.status === 'active' || r.status === 'pending' ? 0 : 1);

const _pairingRow = (id) => db.prepare('SELECT * FROM coach_clients WHERE id = ?').get(id);

// ── Your own place in coaching ──────────────────────────────────────────────
router.get('/state', requireAccount, wrap((req, res) => {
  res.json(coachingState(req.user.id));
}));

// ── The coach's side ────────────────────────────────────────────────────────
// Your clients: pending requests, active pairings, and requests declined or
// pairings the client ended in the last week, so the answer is seen.
router.get('/clients', requireCoachRole, wrap((req, res) => {
  const today = _today(req);
  const rows = db.prepare(`
    SELECT cc.id, cc.status, cc.requested_at, cc.responded_at, cc.ended_at, cc.ended_by,
           u.id AS client_id, u.full_name, u.username
      FROM coach_clients cc JOIN users u ON u.id = cc.client_id
     WHERE cc.coach_id = ?
       AND (cc.status IN ('pending', 'active')
         OR (cc.status = 'declined' AND cc.responded_at >= datetime('now', '-7 days'))
         OR (cc.status = 'ended' AND cc.ended_by IS NOT cc.coach_id AND cc.ended_at >= datetime('now', '-7 days')))
     ORDER BY CASE cc.status WHEN 'active' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,
              COALESCE(u.full_name, u.username) COLLATE NOCASE
  `).all(req.user.id);
  // One row per client: the open pairing, else the latest answer.
  const seen = new Set();
  const latest = [...rows].sort((a, b) => _rank(a) - _rank(b) || String(b.responded_at || b.ended_at || '').localeCompare(String(a.responded_at || a.ended_at || '')));
  const keep = new Set(latest.filter(r => !seen.has(r.client_id) && seen.add(r.client_id)).map(r => r.id));
  res.json(rows.filter(r => keep.has(r.id)).map(r => {
    const out = {
      id: r.id, status: r.status, client: person(r.client_id, r.full_name, r.username),
      requested_at: r.requested_at, responded_at: r.responded_at || null, ended_at: r.ended_at || null,
    };
    if (r.status === 'active') {
      out.unread = db.prepare(`SELECT COUNT(*) AS c FROM coach_messages WHERE pairing_id = ? AND sender_id != ? AND read_at IS NULL AND deleted_at IS NULL`).get(r.id, req.user.id).c;
      out.last_logged = _lastLogged(r.client_id);
      out.week = _summary(_recentDays(r.client_id, today));
    }
    return out;
  }));
}));

// The name list for a request: id and name only, like the sharing picker.
// People already coached by you (or asked) are left out; nothing says who
// has another coach.
router.get('/candidates', requireCoachRole, wrap((req, res) => {
  const rows = db.prepare(`
    SELECT id, full_name, username FROM users
     WHERE id != ?
       AND id NOT IN (SELECT client_id FROM coach_clients WHERE coach_id = ? AND status IN ('pending', 'active'))
     ORDER BY COALESCE(full_name, username) COLLATE NOCASE
  `).all(req.user.id, req.user.id);
  res.json(rows.map(u => person(u.id, u.full_name, u.username)));
}));

router.post('/requests', requireCoachRole, wrap((req, res) => {
  const clientId = Number(req.body?.client_id);
  if (!Number.isInteger(clientId) || clientId === req.user.id) return res.status(400).json({ error: 'Choose someone to coach.', code: 'choose_someone' });
  const client = db.prepare('SELECT id, full_name, username FROM users WHERE id = ?').get(clientId);
  if (!client) return res.status(400).json({ error: 'Choose someone to coach.', code: 'choose_someone' });
  const name = person(client.id, client.full_name, client.username).name;
  // Only this coach's own pairings decide the answer: whether the person has
  // another coach or other requests is never said.
  const own = db.prepare(`SELECT status FROM coach_clients WHERE coach_id = ? AND client_id = ? AND status IN ('pending', 'active')`).get(req.user.id, clientId);
  if (own?.status === 'active') return res.status(409).json({ error: `${name} is already your client.`, code: 'already_client', params: { name } });
  if (own?.status === 'pending') return res.status(409).json({ error: `You already asked ${name}.`, code: 'already_asked', params: { name } });
  let id;
  try {
    id = db.prepare(`INSERT INTO coach_clients (coach_id, client_id, status, note) VALUES (?, ?, 'pending', ?)`)
      .run(req.user.id, clientId, _note(req.body?.note)).lastInsertRowid;
  } catch (e) {
    if (/UNIQUE/i.test(String(e?.message))) return res.status(409).json({ error: `You already asked ${name}.`, code: 'already_asked', params: { name } });
    throw e;
  }
  const row = _pairingRow(id);
  notifyRequest(req.user.id, clientId);
  res.json({ id: row.id, status: row.status, client: person(client.id, client.full_name, client.username), requested_at: row.requested_at });
}));

// ── The client's answer ─────────────────────────────────────────────────────
function _answer(status) {
  return wrap((req, res) => {
    const row = _pairingRow(Number(req.params.id));
    if (!row || row.client_id !== req.user.id) return res.status(404).json({ error: 'Request not found', code: 'request_not_found' });
    if (row.status !== 'pending') return res.status(409).json({ error: 'This request was already answered.', code: 'request_answered' });
    if (status === 'active' && !canCoach(roleOf(row.coach_id))) {
      endPairing(row.id, null);
      return res.status(409).json({ error: 'This person no longer coaches.', code: 'no_longer_coaches' });
    }
    // One coach at a time: leave the one you have before accepting another.
    const LEAVE_FIRST = 'Leave your coach before you accept another.';
    if (status === 'active' && db.prepare(`SELECT 1 FROM coach_clients WHERE client_id = ? AND status = 'active'`).get(req.user.id)) {
      return res.status(409).json({ error: LEAVE_FIRST, code: 'leave_first' });
    }
    let changed = 0;
    try {
      changed = db.prepare(`UPDATE coach_clients SET status = ?, responded_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND status = 'pending'`)
        .run(status, row.id).changes;
    } catch (e) {
      if (/UNIQUE/i.test(String(e?.message))) return res.status(409).json({ error: LEAVE_FIRST, code: 'leave_first' });
      throw e;
    }
    if (changed) notifyClientAnswer(row, status === 'active' ? 'accepted' : 'declined');
    res.json(coachingState(req.user.id));
  });
}
router.post('/pairings/:id/accept', requireAccount, _answer('active'));
router.post('/pairings/:id/decline', requireAccount, _answer('declined'));

// Ending: the client (Leave Coach), the coach (End Coaching, or taking back a
// request) or an admin (from Users).
router.post('/pairings/:id/end', requireAccount, wrap((req, res) => {
  const row = _pairingRow(Number(req.params.id));
  const me = req.user.id;
  const mine = row && (row.coach_id === me || row.client_id === me);
  if (!row || (!mine && roleOf(me) !== 'admin')) return res.status(404).json({ error: 'Pairing not found', code: 'pairing_not_found' });
  if (!endPairing(row.id, me)) return res.status(409).json({ error: 'This coaching has already ended.', code: 'already_ended' });
  if (row.status === 'active' && me === row.client_id) notifyClientAnswer(row, 'left');
  res.json(coachingState(me));
}));

// ── The conversation ────────────────────────────────────────────────────────
// The same three handlers for both sides: the client reaches them by
// /pairings/:id/messages (readable after coaching ends), the coach by
// /clients/:clientId/messages behind the coach guard (active only).
function _listMessages(p, req, res) {
  const since = typeof req.query.since === 'string' && /^\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?$/.test(req.query.since) ? req.query.since : null;
  const serverTime = new Date().toISOString();
  res.json({ pairing_id: p.id, status: p.status, can_send: canWrite(p, req.user.id), messages: listMessages(p.id, since), server_time: serverTime });
}
function _sendMessage(p, req, res) {
  let out;
  try { out = createMessage(p, req.user.id, req.body || {}); }
  catch (e) { return res.status(e.status || 500).json({ error: e.message, code: e.code, params: e.params }); }
  if (out.created) notifyMessage(p, out.row, linkBase(req));
  res.json(messageOut(out.row));
}
function _readMessages(p, req, res) {
  res.json({ marked: markRead(p.id, req.user.id) });
}

function _clientPairing(req, res, { write = false } = {}) {
  const p = pairingById(Number(req.params.id));
  if (!p || p.client_id !== req.user.id || !(write ? canWrite(p, req.user.id) : canRead(p, req.user.id))) {
    res.status(404).json({ error: 'Conversation not found', code: 'conversation_not_found' });
    return null;
  }
  return p;
}
router.get('/pairings/:id/messages', requireAccount, wrap((req, res) => {
  const p = _clientPairing(req, res); if (p) _listMessages(p, req, res);
}));
router.post('/pairings/:id/messages', requireAccount, wrap((req, res) => {
  const p = _clientPairing(req, res, { write: true }); if (p) _sendMessage(p, req, res);
}));
router.post('/pairings/:id/messages/read', requireAccount, wrap((req, res) => {
  const p = _clientPairing(req, res); if (p) _readMessages(p, req, res);
}));

// ── Recommendations, the client's side ──────────────────────────────────────
// Everything recommended to you (pending first is the app's job), and your
// answer. Accepting changes nothing here: the app applies it to your goals
// on your device (it works offline) and they sync as usual.
router.get('/recommendations', requireAccount, wrap((req, res) => {
  res.json(listForClient(req.user.id));
}));
router.post('/recommendations/:id/answer', requireAccount, wrap((req, res) => {
  try { res.json(answerRecommendation(req.params.id, req.user.id, req.body || {})); }
  catch (e) { res.status(e.status || 500).json({ error: e.message, code: e.code, params: e.params, ...(e.row ? { recommendation: e.row } : {}) }); }
}));

// Delete your own message, from either side ("Message deleted").
router.delete('/messages/:uuid', requireAccount, wrap((req, res) => {
  try { res.json(messageOut(deleteMessage(String(req.params.uuid), req.user.id))); }
  catch (e) { res.status(e.status || 500).json({ error: e.message, code: e.code, params: e.params }); }
}));

// A photo from a conversation: only to the two people in it (the coach only
// while coaching), and never once its message is deleted.
router.get('/photos/:name', requireAccount, wrap((req, res) => {
  const file = photoPath(req.params.name);
  const m = file && db.prepare('SELECT pairing_id FROM coach_messages WHERE image_url = ? AND deleted_at IS NULL').get(req.params.name);
  if (!m || !canRead(pairingById(m.pairing_id), req.user.id) || !fs.existsSync(file)) return res.status(404).json({ error: 'Not found', code: 'not_found' });
  // sendFile, not a bare stream: a file deleted between the check and the
  // read (its message deleted at that moment) answers 404 instead of an
  // unhandled stream error taking the server down.
  res.sendFile(path.resolve(file), {
    headers: { ...UPLOAD_RESPONSE_HEADERS, 'Cache-Control': 'private, no-store', 'Content-Type': PHOTO_TYPES[req.params.name.split('.').pop()] || 'application/octet-stream' },
  }, (err) => { if (err && !res.headersSent) res.status(404).json({ error: 'Not found', code: 'not_found' }); });
}));

// ── Admin: see and end pairings ─────────────────────────────────────────────
router.get('/admin/pairings', requireAccount, requireAdmin, wrap((req, res) => {
  // The token's role can be older than an admin's change; ask the database.
  if (roleOf(req.user.id) !== 'admin') return res.status(403).json({ error: 'Admin only', code: 'admin_only' });
  const rows = db.prepare(`
    SELECT cc.id, cc.status, cc.requested_at, cc.responded_at,
           c.id AS coach_id, c.full_name AS coach_full, c.username AS coach_user,
           k.id AS client_id, k.full_name AS client_full, k.username AS client_user
      FROM coach_clients cc
      JOIN users c ON c.id = cc.coach_id
      JOIN users k ON k.id = cc.client_id
     WHERE cc.status IN ('pending', 'active')
     ORDER BY cc.status, COALESCE(c.full_name, c.username) COLLATE NOCASE
  `).all();
  res.json(rows.map(r => ({
    id: r.id, status: r.status, requested_at: r.requested_at, responded_at: r.responded_at || null,
    coach: person(r.coach_id, r.coach_full, r.coach_user),
    client: person(r.client_id, r.client_full, r.client_user),
  })));
}));

// ── A client, as their coach sees them ──────────────────────────────────────
// The guard runs for every route below this line that starts /clients/:clientId.
router.use('/clients/:clientId', requireCoachOf);

router.get('/clients/:clientId/messages', wrap((req, res) => _listMessages(req.pairing, req, res)));
router.post('/clients/:clientId/messages', wrap((req, res) => _sendMessage(req.pairing, req, res)));
router.post('/clients/:clientId/messages/read', wrap((req, res) => _readMessages(req.pairing, req, res)));

// Targets: what the client has now (the editor starts there, with their
// adaptive TDEE beside it), what the coach recommended, and recommending.
router.get('/clients/:clientId/targets', wrap((req, res) => {
  const clientId = req.pairing.client_id;
  const goals = _setting(clientId, 'goals', {}) || {};
  let adaptive = null;
  try {
    const a = computeAdaptiveTdee(clientId);
    adaptive = { ready: !!a.ready, tdee: a.tdee ?? null, days_available: a.daysAvailable, days_required: a.daysRequired, confidence: a.confidence ?? null, trend_kg_per_week: a.trendKgPerWeek ?? null };
  } catch { /* not enough data */ }
  res.json({
    goals: Object.fromEntries(TARGET_KEYS.filter(k => goals[k]).map(k => [k, goals[k]])),
    calorie_mode: _setting(clientId, 'calorieGoalMode', 'fixed') || 'fixed',
    calorie_factor: _setting(clientId, 'calorieGoalFactor', 1) ?? 1,
    adaptive,
  });
}));
router.get('/clients/:clientId/recommendations', wrap((req, res) => {
  res.json(listForPairing(req.pairing.id));
}));
router.post('/clients/:clientId/recommendations', wrap(async (req, res) => {
  const kind = req.body?.kind || 'targets';
  if (!['targets', 'day_plan', 'meal', 'recipe'].includes(kind)) return res.status(400).json({ error: 'Targets, day plans, meals and recipes can be recommended.', code: 'kind_unknown' });
  try {
    // A day plan answers with every plan made (one per date).
    res.json(kind === 'day_plan' ? recommendDayPlan(req.pairing, req.user.id, req.body || {})
      : kind === 'meal' || kind === 'recipe' ? await recommendMealItem(req.pairing, req.user.id, req.body || {}, { allowPrivateImages: ownerOrOptIn(req, 'ALLOW_PRIVATE_IMAGE_URLS') })
      : recommendTargets(req.pairing, req.user.id, req.body || {}));
  } catch (e) { res.status(e.status || 500).json({ error: e.message, code: e.code, params: e.params }); }
}));

// The client's foods, meals and recipes, for the day plan builder: what each
// is, never who else can see it. Their meal names come with the diary day.
router.get('/clients/:clientId/catalog', wrap((req, res) => {
  const clientId = req.pairing.client_id;
  const food = (f) => ({ id: f.id, name: f.name, brand: f.brand || null, portion: f.portion, unit: f.unit, nutrition: _json(f.nutrition, {}) || {}, barcode: f.barcode || null });
  const foods = db.prepare(`SELECT id, name, brand, portion, unit, nutrition, barcode FROM foods WHERE user_id = ? AND deleted_at IS NULL ORDER BY name COLLATE NOCASE LIMIT 5000`).all(clientId).map(food);
  const meals = db.prepare(`SELECT id, name, portion, unit, nutrition, items, is_recipe FROM meals WHERE user_id = ? AND deleted_at IS NULL ORDER BY name COLLATE NOCASE LIMIT 5000`).all(clientId);
  const ingredient = (it) => ({ id: ingredientFoodId(it) ?? null, name: it?.name || '', brand: it?.brand || null, portion: it?.portion ?? null, unit: it?.unit || null, quantity: it?.quantity ?? 1, nutrition: it?.nutrition || {}, barcode: it?.barcode || null });
  res.json({
    foods,
    meals: meals.filter(m => !m.is_recipe).map(m => ({ id: m.id, name: m.name, items: (_json(m.items, []) || []).map(ingredient) })),
    recipes: meals.filter(m => m.is_recipe).map(m => ({ id: m.id, name: m.name, brand: null, portion: m.portion, unit: m.unit, nutrition: _json(m.nutrition, {}) || {} })),
  });
}));

router.get('/clients/:clientId/overview', wrap((req, res) => {
  const clientId = req.pairing.client_id;
  const today = _today(req);
  const u = db.prepare('SELECT id, full_name, username FROM users WHERE id = ?').get(clientId);
  const days = _recentDays(clientId, today);
  const from = _shift(today, -(WEIGHT_DAYS - 1));
  const weights = db.prepare(`
    SELECT date, body_stats FROM diary WHERE user_id = ? AND deleted_at IS NULL AND date BETWEEN ? AND ? ORDER BY date
  `).all(clientId, from, today)
    .map(r => ({ date: r.date, kg: _bodyStatsWeightKg(r.body_stats) }))
    .filter(w => w.kg != null)
    .map(w => ({ date: w.date, kg: Math.round(w.kg * 100) / 100 }));
  res.json({
    client: person(u.id, u.full_name, u.username),
    since: req.pairing.responded_at,
    today,
    calorie_mode: _setting(clientId, 'calorieGoalMode', 'fixed') || 'fixed',
    meal_names: _setting(clientId, 'mealNames', null),
    last_logged: _lastLogged(clientId),
    days,
    week: _summary(days),
    weights,
  });
}));

router.get('/clients/:clientId/diary/:date', wrap((req, res) => {
  const clientId = req.pairing.client_id;
  const date = String(req.params.date);
  if (!DATE_RE.test(date)) return res.status(400).json({ error: 'Invalid date', code: 'invalid_date' });
  const row = db.prepare(`SELECT items, water, notes, body_stats FROM diary WHERE user_id = ? AND date = ? AND deleted_at IS NULL`).get(clientId, date);
  const items = _json(row?.items, []) || [];
  const goals = _setting(clientId, 'goals', {}) || {};
  res.json({
    date,
    meal_names: _setting(clientId, 'mealNames', null),
    items: items.map(it => {
      const n = Nutrition.calculate(it) || {};
      return {
        name: it.name || '', brand: it.brand || null,
        portion: it.portion ?? null, unit: it.unit || null, quantity: it.quantity ?? null,
        meal: Number.isInteger(it.meal) ? it.meal : Number(it.meal) || 0,
        calories: Math.round(Number(n.calories) || 0),
        proteins: Math.round((Number(n.proteins) || 0) * 10) / 10,
        carbohydrates: Math.round((Number(n.carbohydrates) || 0) * 10) / 10,
        fat: Math.round((Number(n.fat) || 0) * 10) / 10,
      };
    }),
    totals: _dayTotals(items),
    targets: _targetsFor(goals, date),
    water_ml: (_json(row?.water, []) || []).reduce((s, l) => s + (Number(l?.amount) || 0), 0),
    weight_kg: row ? _bodyStatsWeightKg(row.body_stats) : null,
    notes: row?.notes || null,
  });
}));

export default router;
