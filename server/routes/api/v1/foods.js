/**
 * /api/v1/foods — federation read endpoint for foods.
 *
 * GET /          list with optional q / category / limit / offset
 * GET /:id       single food by id
 *
 * Scope: read:foods. See docs/federation.md for the wire shape.
 */
import { Router } from 'express';
import db from '../../../db.js';
import { wrap } from '../../../logger.js';
import { requireScope } from '../../../middleware/bearer-auth.js';

const router = Router();

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 100;

router.get('/', requireScope('read:foods'), wrap((req, res) => {
  const userId = req.apiUser.id;
  const q = String(req.query.q || '').trim();
  const category = String(req.query.category || '').trim();
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(req.query.limit) || DEFAULT_LIMIT));
  const offset = Math.max(0, Number(req.query.offset) || 0);

  const conds = ['user_id = ?', 'deleted_at IS NULL'];
  const args = [userId];

  if (q) {
    conds.push('(name LIKE ? OR brand LIKE ?)');
    const like = `%${q}%`;
    args.push(like, like);
  }
  if (category) {
    conds.push('category = ?');
    args.push(category);
  }

  const where = conds.join(' AND ');

  const totalRow = db.prepare(`SELECT COUNT(*) AS c FROM foods WHERE ${where}`).get(...args);
  const rows = db.prepare(
    `SELECT * FROM foods WHERE ${where} ORDER BY name ASC LIMIT ? OFFSET ?`
  ).all(...args, limit, offset);

  res.json({
    items: rows.map(_toWire),
    total: totalRow.c,
    limit,
    offset,
  });
}));

router.get('/:id', requireScope('read:foods'), wrap((req, res) => {
  const userId = req.apiUser.id;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    return res.status(404).json({ error: 'Not found', code: 'not_found' });
  }
  const row = db.prepare(
    `SELECT * FROM foods WHERE id = ? AND user_id = ? AND deleted_at IS NULL`
  ).get(id, userId);
  if (!row) {
    return res.status(404).json({ error: 'Not found', code: 'not_found' });
  }
  res.json(_toWire(row));
}));

/**
 * Internal-row → wire-format mapper.
 *
 * IMPORTANT: this is the source of truth for what fields cross the
 * federation boundary. Adding a new internal column does NOT
 * automatically expose it — it has to be added here AND documented
 * in docs/federation.md. Same for removals: keep the wire field
 * present (with null if needed) until v2.
 */
function _toWire(row) {
  let nutrition = {};
  try { nutrition = JSON.parse(row.nutrition || '{}'); }
  catch { nutrition = {}; }
  // Strip internal-only metadata that may have leaked into the JSON
  // blob (e.g. _derived flags). External consumers don't need these.
  if (nutrition._derived !== undefined) delete nutrition._derived;

  return {
    id:         row.id,
    name:       row.name,
    brand:      row.brand || null,
    category:   row.category || null,
    barcode:    row.barcode || null,
    portion:    typeof row.portion === 'number' ? row.portion : 100,
    unit:       row.unit || 'g',
    img_url:    row.img_url || null,
    notes:      row.notes || null,
    nutrition,
    created_at: _isoUtc(row.created_at),
    updated_at: _isoUtc(row.updated_at) || _isoUtc(row.created_at),
  };
}

/** SQLite stores `datetime('now')` as `YYYY-MM-DD HH:MM:SS` UTC.
 *  Normalize to ISO-8601 UTC for the wire. */
function _isoUtc(s) {
  if (!s) return null;
  // Already ISO-ish? Pass through.
  if (s.includes('T')) return s.endsWith('Z') ? s : s + 'Z';
  // SQLite default format: YYYY-MM-DD HH:MM:SS
  return s.replace(' ', 'T') + 'Z';
}

export default router;
