/**
 * exercises.js — strength-tracking library + daily logs.
 *
 *   GET    /api/exercises                 List (includes last log)
 *   POST   /api/exercises                 Create
 *   GET    /api/exercises/logs            All logs in a date range
 *   GET    /api/exercises/:id             One exercise
 *   PUT    /api/exercises/:id             Update
 *   DELETE /api/exercises/:id             Soft-delete
 *   GET    /api/exercises/:id/logs        Logs for one exercise
 *   PUT    /api/exercises/:id/logs/:date  Upsert that day's log (body.person)
 *   DELETE /api/exercises/:id/logs/:date  Soft-delete (?person=)
 *
 * Differential sync picks up both tables via updated_at.
 */

import { Router } from 'express';
import db from '../db.js';
import { wrap } from '../logger.js';
import { requireAuth, userMgmtActive } from '../middleware/auth.js';
import { localizeImage, isExternalUrl } from '../lib/image-localizer.js';
import { parsePeople, serializePeople, normalizePerson } from '../lib/exercise-people.js';

const router = Router();
router.use(requireAuth);

const uid = req => userMgmtActive() ? req.user.id : null;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function userClause(u, col = 'user_id') {
  return u != null ? `${col} = ?` : `${col} IS NULL`;
}

function parseExercise(row) {
  if (!row) return null;
  return {
    id: row.id,
    user_id: row.user_id,
    name: row.name,
    img_url: row.img_url,
    notes: row.notes,
    muscle: row.muscle,
    people: parsePeople(row.people),
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_date: row.last_date || null,
    last_weight: row.last_weight != null ? row.last_weight : null,
    last_weight_unit: row.last_weight_unit || null,
    last_difficulty: row.last_difficulty != null ? row.last_difficulty : null,
    last_person: row.last_person || '',
  };
}

function parseLog(row) {
  if (!row) return null;
  return {
    id: row.id,
    user_id: row.user_id,
    exercise_id: row.exercise_id,
    date: row.date,
    person: row.person || '',
    weight: row.weight,
    weight_unit: row.weight_unit,
    difficulty: row.difficulty,
    notes: row.notes,
    updated_at: row.updated_at,
  };
}

function ownExercise(id, u) {
  const row = db.prepare('SELECT * FROM exercises WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!row) return null;
  if (u != null && row.user_id !== u) return false;
  return row;
}

function parseDifficulty(raw) {
  if (raw == null || raw === '') return null;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1 || n > 5) return null;
  return n;
}

function parseWeight(raw) {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

async function localizeImg(img_url, existing) {
  if (img_url === undefined) return existing;
  if (!img_url) return null;
  return isExternalUrl(img_url) ? await localizeImage(img_url) : img_url;
}

// ── GET / ────────────────────────────────────────────────────────────────
router.get('/', wrap((req, res) => {
  const u = uid(req);
  const where = `e.deleted_at IS NULL AND ${userClause(u, 'e.user_id')}`;
  const params = u != null ? [u] : [];
  const rows = db.prepare(`
    SELECT e.*,
      l.date AS last_date, l.weight AS last_weight,
      l.weight_unit AS last_weight_unit, l.difficulty AS last_difficulty,
      l.person AS last_person
    FROM exercises e
    LEFT JOIN exercise_logs l ON l.id = (
      SELECT id FROM exercise_logs
      WHERE exercise_id = e.id AND deleted_at IS NULL
      ORDER BY date DESC LIMIT 1
    )
    WHERE ${where}
    ORDER BY e.name COLLATE NOCASE ASC
  `).all(...params);
  res.json(rows.map(parseExercise));
}));

// ── GET /logs  (all logs in range — must be before /:id) ─────────────────
router.get('/logs', wrap((req, res) => {
  const u = uid(req);
  const from = DATE_RE.test(req.query.from) ? req.query.from : '0000-01-01';
  const to   = DATE_RE.test(req.query.to)   ? req.query.to   : '9999-12-31';
  const where = `l.deleted_at IS NULL AND ${userClause(u, 'l.user_id')} AND l.date >= ? AND l.date <= ?`;
  const params = u != null ? [u, from, to] : [from, to];
  const rows = db.prepare(
    `SELECT l.* FROM exercise_logs l WHERE ${where} ORDER BY l.date ASC`
  ).all(...params);
  res.json(rows.map(parseLog));
}));

// ── POST / ───────────────────────────────────────────────────────────────
router.post('/', wrap(async (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name required' });
  const u = uid(req);
  const img = await localizeImg(req.body?.img_url, null);
  const people = serializePeople(req.body?.people);
  const result = db.prepare(
    `INSERT INTO exercises (user_id, name, img_url, notes, muscle, people, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
  ).run(
    u,
    name,
    img,
    req.body?.notes ? String(req.body.notes).slice(0, 2000) : null,
    req.body?.muscle ? String(req.body.muscle).slice(0, 80) : null,
    people
  );
  res.status(201).json(parseExercise(
    db.prepare('SELECT * FROM exercises WHERE id = ?').get(result.lastInsertRowid)
  ));
}));

// ── GET /:id/logs ────────────────────────────────────────────────────────
router.get('/:id/logs', wrap((req, res) => {
  const u = uid(req);
  const ex = ownExercise(req.params.id, u);
  if (ex == null) return res.status(404).json({ error: 'Not found' });
  if (ex === false) return res.status(403).json({ error: 'Forbidden' });
  const from = DATE_RE.test(req.query.from) ? req.query.from : '0000-01-01';
  const to   = DATE_RE.test(req.query.to)   ? req.query.to   : '9999-12-31';
  const rows = db.prepare(
    `SELECT * FROM exercise_logs
     WHERE exercise_id = ? AND deleted_at IS NULL AND date >= ? AND date <= ?
     ORDER BY date ASC`
  ).all(ex.id, from, to);
  res.json(rows.map(parseLog));
}));

// ── PUT /:id/logs/:date ──────────────────────────────────────────────────
router.put('/:id/logs/:date', wrap((req, res) => {
  const u = uid(req);
  const ex = ownExercise(req.params.id, u);
  if (ex == null) return res.status(404).json({ error: 'Not found' });
  if (ex === false) return res.status(403).json({ error: 'Forbidden' });
  const date = req.params.date;
  if (!DATE_RE.test(date)) return res.status(400).json({ error: 'Invalid date' });

  const weight = parseWeight(req.body?.weight);
  const difficulty = parseDifficulty(req.body?.difficulty);
  const person = normalizePerson(req.body?.person);
  const weight_unit = req.body?.weight_unit === 'lb' || req.body?.weight_unit === 'kg'
    ? req.body.weight_unit
    : (weight != null ? 'kg' : null);
  const notes = req.body?.notes != null ? String(req.body.notes).slice(0, 500) || null : null;

  if (weight == null && difficulty == null) {
    return res.status(400).json({ error: 'Weight or difficulty required' });
  }

  db.prepare(`
    INSERT INTO exercise_logs (user_id, exercise_id, date, person, weight, weight_unit, difficulty, notes, updated_at, deleted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), NULL)
    ON CONFLICT(exercise_id, date, person) DO UPDATE SET
      weight = excluded.weight,
      weight_unit = excluded.weight_unit,
      difficulty = excluded.difficulty,
      notes = excluded.notes,
      deleted_at = NULL,
      updated_at = datetime('now')
  `).run(u, ex.id, date, person, weight, weight_unit, difficulty, notes);

  const row = db.prepare(
    'SELECT * FROM exercise_logs WHERE exercise_id = ? AND date = ? AND person = ?'
  ).get(ex.id, date, person);
  res.json(parseLog(row));
}));

// ── DELETE /:id/logs/:date ───────────────────────────────────────────────
router.delete('/:id/logs/:date', wrap((req, res) => {
  const u = uid(req);
  const ex = ownExercise(req.params.id, u);
  if (ex == null) return res.status(404).json({ error: 'Not found' });
  if (ex === false) return res.status(403).json({ error: 'Forbidden' });
  const date = req.params.date;
  if (!DATE_RE.test(date)) return res.status(400).json({ error: 'Invalid date' });
  const person = normalizePerson(req.query?.person);
  db.prepare(
    `UPDATE exercise_logs SET deleted_at = datetime('now'), updated_at = datetime('now')
     WHERE exercise_id = ? AND date = ? AND person = ?`
  ).run(ex.id, date, person);
  res.json({ ok: true });
}));

// ── GET /:id ─────────────────────────────────────────────────────────────
router.get('/:id', wrap((req, res) => {
  const u = uid(req);
  const ex = ownExercise(req.params.id, u);
  if (ex == null) return res.status(404).json({ error: 'Not found' });
  if (ex === false) return res.status(403).json({ error: 'Forbidden' });
  res.json(parseExercise(ex));
}));

// ── PUT /:id ─────────────────────────────────────────────────────────────
router.put('/:id', wrap(async (req, res) => {
  const u = uid(req);
  const existing = ownExercise(req.params.id, u);
  if (existing == null) return res.status(404).json({ error: 'Not found' });
  if (existing === false) return res.status(403).json({ error: 'Forbidden' });
  const name = req.body?.name != null ? String(req.body.name).trim() : existing.name;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const img = await localizeImg(req.body?.img_url, existing.img_url);
  const notes = req.body?.notes === undefined
    ? existing.notes
    : (req.body.notes ? String(req.body.notes).slice(0, 2000) : null);
  const muscle = req.body?.muscle === undefined
    ? existing.muscle
    : (req.body.muscle ? String(req.body.muscle).slice(0, 80) : null);
  const people = req.body?.people === undefined
    ? existing.people
    : serializePeople(req.body.people);
  db.prepare(
    `UPDATE exercises SET name=?, img_url=?, notes=?, muscle=?, people=?, updated_at=datetime('now') WHERE id=?`
  ).run(name, img, notes, muscle, people, existing.id);
  res.json(parseExercise(db.prepare('SELECT * FROM exercises WHERE id = ?').get(existing.id)));
}));

// ── DELETE /:id ──────────────────────────────────────────────────────────
router.delete('/:id', wrap((req, res) => {
  const u = uid(req);
  const existing = ownExercise(req.params.id, u);
  if (existing == null) return res.status(404).json({ error: 'Not found' });
  if (existing === false) return res.status(403).json({ error: 'Forbidden' });
  db.prepare(`UPDATE exercises SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(existing.id);
  db.prepare(`UPDATE exercise_logs SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE exercise_id = ? AND deleted_at IS NULL`).run(existing.id);
  res.json({ ok: true });
}));

export default router;
