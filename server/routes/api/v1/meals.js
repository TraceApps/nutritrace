/**
 * /api/v1/meals, search/list/get the user's saved meals catalog. Same
 * xCore() functions the matching MCP tools call. See diary.js in this
 * same directory for the full auth/flag contract this sub-router shares.
 */
import { Router } from 'express';
import { requireScope } from '../../../middleware/bearer-auth.js';
import { wrap } from '../../../logger.js';
import { searchMealsCore } from '../../../lib/mcp/tools/search-meals.js';
import { recentMealsCore } from '../../../lib/mcp/tools/recent-meals.js';
import { getMealDetailsCore } from '../../../lib/mcp/tools/get-meal-details.js';

const router = Router();

function _envFlag(v) {
  if (v === undefined || v === null) return false;
  const s = String(v).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

const ENABLED = _envFlag(process.env.PUBLIC_API_ENABLED);

router.use((req, res, next) => {
  if (!ENABLED) return res.status(404).json({ error: 'Public API not enabled on this server' });
  next();
});

function core(fn) {
  return wrap((req, res) => {
    try {
      res.json(fn(req));
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });
}

router.get('/search', requireScope('mcp:read'), core(req =>
  searchMealsCore(req.apiUser.id, {
    query: req.query.query,
    limit: req.query.limit,
    include_recipes: req.query.include_recipes === 'true',
  })
));

router.get('/recent', requireScope('mcp:read'), core(req =>
  recentMealsCore(req.apiUser.id, {
    limit: req.query.limit,
    include_recipes: req.query.include_recipes === 'true',
  })
));

router.get('/:id', requireScope('mcp:read'), core(req =>
  getMealDetailsCore(req.apiUser.id, { meal_id: Number(req.params.id) })
));

export default router;
