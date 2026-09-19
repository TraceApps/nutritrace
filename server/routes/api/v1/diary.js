/**
 * /api/v1/diary, general-purpose diary read/write for a user's own
 * scripts and automations, not a sister-app federation contract like
 * the other /api/v1 sub-routers.
 *
 * Reuses the exact same xCore() functions the matching MCP tools call
 * (server/lib/mcp/tools/*.js), so this file is not a fourth copy of the
 * diary query/write logic. Responses are the bare data object as JSON,
 * not MCP's toolResult envelope.
 *
 * Auth: bearer token via the same api_tokens table and mcp:read/mcp:write
 * scopes MCP already uses. One token then works for both MCP and REST
 * access; a scope describes what class of access it grants, not which
 * protocol carries it. Write routes additionally require
 * PUBLIC_API_WRITE_ENABLED=1 on the server, mirrors MCP's own
 * MCP_ENABLED/MCP_WRITE_ENABLED split.
 *
 * Base PUBLIC_API_ENABLED gate runs here rather than before the
 * existing global bearerAuth in index.js (unlike LiftTrace's
 * dedicated public-api.js, which mounts standalone), since the other
 * /api/v1 sub-routers already share that one global bearerAuth call
 * and this shouldn't disturb their existing wiring.
 */
import { Router } from 'express';
import { requireScope } from '../../../middleware/bearer-auth.js';
import { wrap } from '../../../logger.js';
import { listDiaryCore } from '../../../lib/mcp/tools/list-diary.js';
import { dailyTotalsCore } from '../../../lib/mcp/tools/daily-totals.js';
import { logFoodCore } from '../../../lib/mcp/tools/log-food.js';
import { logWaterCore } from '../../../lib/mcp/tools/log-water.js';
import { logMealCore } from '../../../lib/mcp/tools/log-meal.js';
import { logBodyStatCore } from '../../../lib/mcp/tools/log-body-stat.js';

const router = Router();

function _envFlag(v) {
  if (v === undefined || v === null) return false;
  const s = String(v).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

const ENABLED       = _envFlag(process.env.PUBLIC_API_ENABLED);
const WRITE_ENABLED = _envFlag(process.env.PUBLIC_API_WRITE_ENABLED);

router.use((req, res, next) => {
  if (!ENABLED) return res.status(404).json({ error: 'Public API not enabled on this server' });
  next();
});

function requireWriteEnabled(req, res, next) {
  if (!WRITE_ENABLED) return res.status(404).json({ error: 'Public API writes not enabled on this server' });
  next();
}

function core(fn) {
  return wrap((req, res) => {
    try {
      res.json(fn(req));
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });
}

router.get('/:date', requireScope('mcp:read'), core(req =>
  listDiaryCore(req.apiUser.id, { date: req.params.date })
));

router.get('/:date/totals', requireScope('mcp:read'), core(req =>
  dailyTotalsCore(req.apiUser.id, { date: req.params.date })
));

router.post('/:date/food', requireWriteEnabled, requireScope('mcp:write'), core(req =>
  logFoodCore(req.apiUser.id, { ...req.body, date: req.params.date })
));

router.post('/:date/water', requireWriteEnabled, requireScope('mcp:write'), core(req =>
  logWaterCore(req.apiUser.id, { ...req.body, date: req.params.date })
));

router.post('/:date/meal', requireWriteEnabled, requireScope('mcp:write'), core(req =>
  logMealCore(req.apiUser.id, { ...req.body, date: req.params.date })
));

router.put('/:date/body-stat', requireWriteEnabled, requireScope('mcp:write'), core(req =>
  logBodyStatCore(req.apiUser.id, { ...req.body, date: req.params.date })
));

export default router;
