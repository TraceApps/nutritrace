/**
 * /api/v1/goals, read the user's macro/micronutrient/water goal targets.
 * Same xCore() the MCP get_goals tool calls. See diary.js in this same
 * directory for the full auth/flag contract this sub-router shares.
 */
import { Router } from 'express';
import { requireScope } from '../../../middleware/bearer-auth.js';
import { wrap } from '../../../logger.js';
import { getGoalsCore } from '../../../lib/mcp/tools/goals.js';

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

router.get('/', requireScope('mcp:read'), wrap((req, res) => {
  try {
    res.json(getGoalsCore(req.apiUser.id));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

export default router;
