import { Router } from 'express';
import db from '../db.js';
import { wrap } from '../logger.js';
import { requireAuth, userMgmtActive } from '../middleware/auth.js';
import { sumManualActivity, wearableActiveCalories, effectiveActiveCalories } from '../lib/active-calories.js';

const router = Router();
router.use(requireAuth);

const uid = req => userMgmtActive() ? req.user.id : null;

const ALLOWED_SOURCES = new Set(['manual_form', 'ai_estimated', 'user_stated']);

function sanitize(body) {
  const name = String(body?.name || '').trim().slice(0, 80);
  const kcal = Math.max(0, Math.round(Number(body?.kcal) || 0));
  const duration_min = body?.duration_min != null ? Math.max(0, Math.round(Number(body.duration_min))) : null;
  const distance = body?.distance != null ? String(body.distance).trim().slice(0, 40) || null : null;
  const source = ALLOWED_SOURCES.has(body?.source) ? body.source : 'manual_form';
  return { name, kcal, duration_min, distance, source };
}

// List entries for a date
router.get('/:date', wrap((req, res) => {
  const u = uid(req);
  const rows = u == null
    ? db.prepare(`SELECT * FROM activity_log WHERE user_id IS NULL AND date = ? AND deleted_at IS NULL ORDER BY id ASC`).all(req.params.date)
    : db.prepare(`SELECT * FROM activity_log WHERE user_id = ? AND date = ? AND deleted_at IS NULL ORDER BY id ASC`).all(u, req.params.date);
  res.json(rows);
}));

// Sum + effective-calories breakdown for a date.
// Used by Diary header to show "X kcal earned today" and by AI tools.
router.get('/sum/:date', wrap((req, res) => {
  const u = uid(req);
  const policy = String(req.query.policy || 'wearable_wins');
  res.json({
    date: req.params.date,
    manual: sumManualActivity(u, req.params.date),
    wearable: wearableActiveCalories(u, req.params.date),
    effective: effectiveActiveCalories(u, req.params.date, policy),
    policy,
  });
}));

// Range query for stats / Trace context
router.get('/', wrap((req, res) => {
  const u = uid(req);
  const from = String(req.query.from || '');
  const to   = String(req.query.to   || '');
  if (!from || !to) return res.status(400).json({ error: 'from and to required (YYYY-MM-DD)' });
  const rows = u == null
    ? db.prepare(`SELECT * FROM activity_log WHERE user_id IS NULL AND date BETWEEN ? AND ? AND deleted_at IS NULL ORDER BY date ASC, id ASC`).all(from, to)
    : db.prepare(`SELECT * FROM activity_log WHERE user_id = ? AND date BETWEEN ? AND ? AND deleted_at IS NULL ORDER BY date ASC, id ASC`).all(u, from, to);
  res.json(rows);
}));

router.post('/', wrap((req, res) => {
  const { name, kcal, duration_min, distance, source } = sanitize(req.body);
  const date = String(req.body?.date || '').slice(0, 10);
  if (!name || !date) return res.status(400).json({ error: 'name and date required' });
  const u = uid(req);
  const r = db.prepare(`
    INSERT INTO activity_log (user_id, date, name, kcal, duration_min, distance, source, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `).run(u, date, name, kcal, duration_min, distance, source);
  const row = db.prepare(`SELECT * FROM activity_log WHERE id = ?`).get(r.lastInsertRowid);
  res.status(201).json(row);
}));

router.put('/:id', wrap((req, res) => {
  const u = uid(req);
  const id = Number(req.params.id);
  const existing = u == null
    ? db.prepare(`SELECT * FROM activity_log WHERE id = ? AND user_id IS NULL AND deleted_at IS NULL`).get(id)
    : db.prepare(`SELECT * FROM activity_log WHERE id = ? AND user_id = ? AND deleted_at IS NULL`).get(id, u);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const { name, kcal, duration_min, distance, source } = sanitize({ ...existing, ...req.body });
  db.prepare(`
    UPDATE activity_log SET name = ?, kcal = ?, duration_min = ?, distance = ?, source = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(name, kcal, duration_min, distance, source, id);
  res.json(db.prepare(`SELECT * FROM activity_log WHERE id = ?`).get(id));
}));

router.delete('/:id', wrap((req, res) => {
  const u = uid(req);
  const id = Number(req.params.id);
  const sql = u == null
    ? `UPDATE activity_log SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND user_id IS NULL AND deleted_at IS NULL`
    : `UPDATE activity_log SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND user_id = ? AND deleted_at IS NULL`;
  const r = u == null ? db.prepare(sql).run(id) : db.prepare(sql).run(id, u);
  if (r.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
}));

export default router;
