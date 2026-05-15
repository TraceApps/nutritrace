/**
 * fasts.js — Intermittent fasting tracker endpoints.
 *
 *   GET    /api/fasts                  List recent fasts (latest 30 by default)
 *   GET    /api/fasts/active           Currently-running fast, or null
 *   POST   /api/fasts/start            Start a new fast (rejects if one is active)
 *   POST   /api/fasts/:id/end          End an active fast
 *   PATCH  /api/fasts/:id              Edit start_at / goal_hours / notes
 *   DELETE /api/fasts/:id              Soft-delete
 *
 * All fields are scoped by user_id (or null in single-user mode). Differential
 * sync picks up the `fasts` table via the standard updated_at engine —
 * no separate sync wiring needed.
 */

import { Router } from 'express';
import db from '../db.js';
import { wrap } from '../logger.js';
import { requireAuth, userMgmtActive } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

const uid = req => userMgmtActive() ? req.user.id : null;

function _parseGoal(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 168) return 16; // 168h = 7 days, hard upper bound
  return Math.round(n * 10) / 10;
}

function _row(r) {
  if (!r) return null;
  return {
    id: r.id,
    user_id: r.user_id,
    start_at: r.start_at,
    end_at: r.end_at,
    goal_hours: r.goal_hours,
    notes: r.notes,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

// ── List recent fasts ────────────────────────────────────────────────────────
router.get('/', wrap((req, res) => {
  const u = uid(req);
  const limit = Math.min(365, Math.max(1, parseInt(req.query.limit) || 30));
  const where = u != null ? 'user_id = ? AND deleted_at IS NULL' : 'deleted_at IS NULL';
  const params = u != null ? [u, limit] : [limit];
  const rows = db.prepare(
    `SELECT * FROM fasts WHERE ${where} ORDER BY start_at DESC LIMIT ?`
  ).all(...params);
  res.json(rows.map(_row));
}));

// ── Currently-active fast (end_at IS NULL) ───────────────────────────────────
router.get('/active', wrap((req, res) => {
  const u = uid(req);
  const where = u != null ? 'user_id = ? AND end_at IS NULL AND deleted_at IS NULL' : 'end_at IS NULL AND deleted_at IS NULL';
  const params = u != null ? [u] : [];
  const row = db.prepare(
    `SELECT * FROM fasts WHERE ${where} ORDER BY start_at DESC LIMIT 1`
  ).get(...params);
  res.json(_row(row));
}));

// ── Start a fast ─────────────────────────────────────────────────────────────
router.post('/start', wrap((req, res) => {
  const u = uid(req);
  // Block double-start — one active fast at a time
  const activeWhere = u != null ? 'user_id = ? AND end_at IS NULL AND deleted_at IS NULL' : 'end_at IS NULL AND deleted_at IS NULL';
  const activeParams = u != null ? [u] : [];
  const existing = db.prepare(`SELECT id FROM fasts WHERE ${activeWhere}`).get(...activeParams);
  if (existing) return res.status(409).json({ error: 'A fast is already in progress. End it before starting a new one.' });

  const goal_hours = _parseGoal(req.body?.goal_hours);
  // Allow a back-dated start (user forgot to start it on time). Cap at 24h ago.
  const startReq = req.body?.start_at;
  let start_at = new Date().toISOString();
  if (startReq) {
    const t = new Date(startReq);
    if (!isNaN(t.getTime()) && t.getTime() <= Date.now() && t.getTime() > Date.now() - 24 * 3600 * 1000) {
      start_at = t.toISOString();
    }
  }
  const result = db.prepare(
    `INSERT INTO fasts (user_id, start_at, goal_hours) VALUES (?, ?, ?)`
  ).run(u, start_at, goal_hours);
  const row = db.prepare('SELECT * FROM fasts WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(_row(row));
}));

// ── End the active fast ──────────────────────────────────────────────────────
router.post('/:id/end', wrap((req, res) => {
  const u = uid(req);
  const id = parseInt(req.params.id);
  const fast = db.prepare('SELECT * FROM fasts WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!fast) return res.status(404).json({ error: 'Fast not found' });
  if (u != null && fast.user_id !== u) return res.status(403).json({ error: 'Forbidden' });
  if (fast.end_at) return res.status(400).json({ error: 'Fast is already ended' });
  const end_at = new Date().toISOString();
  db.prepare(`UPDATE fasts SET end_at = ?, updated_at = datetime('now') WHERE id = ?`).run(end_at, id);
  res.json(_row(db.prepare('SELECT * FROM fasts WHERE id = ?').get(id)));
}));

// ── Edit (start time, goal, notes) ───────────────────────────────────────────
router.patch('/:id', wrap((req, res) => {
  const u = uid(req);
  const id = parseInt(req.params.id);
  const fast = db.prepare('SELECT * FROM fasts WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!fast) return res.status(404).json({ error: 'Fast not found' });
  if (u != null && fast.user_id !== u) return res.status(403).json({ error: 'Forbidden' });

  const updates = {};
  if (req.body?.start_at) {
    const t = new Date(req.body.start_at);
    if (!isNaN(t.getTime())) updates.start_at = t.toISOString();
  }
  if (req.body?.end_at !== undefined) {
    if (req.body.end_at === null) updates.end_at = null;
    else {
      const t = new Date(req.body.end_at);
      if (!isNaN(t.getTime())) updates.end_at = t.toISOString();
    }
  }
  if (req.body?.goal_hours != null) updates.goal_hours = _parseGoal(req.body.goal_hours);
  if (req.body?.notes !== undefined) updates.notes = String(req.body.notes || '').slice(0, 500) || null;

  if (Object.keys(updates).length === 0) return res.json(_row(fast));

  const fields = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  const values = Object.values(updates);
  db.prepare(`UPDATE fasts SET ${fields}, updated_at = datetime('now') WHERE id = ?`).run(...values, id);
  res.json(_row(db.prepare('SELECT * FROM fasts WHERE id = ?').get(id)));
}));

// ── Soft-delete ──────────────────────────────────────────────────────────────
router.delete('/:id', wrap((req, res) => {
  const u = uid(req);
  const id = parseInt(req.params.id);
  const fast = db.prepare('SELECT * FROM fasts WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!fast) return res.status(404).json({ error: 'Fast not found' });
  if (u != null && fast.user_id !== u) return res.status(403).json({ error: 'Forbidden' });
  db.prepare(`UPDATE fasts SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(id);
  res.json({ ok: true });
}));

export default router;
