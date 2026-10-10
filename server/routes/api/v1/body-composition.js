/**
 * /api/v1/body-composition — persisted body-composition observations from
 * wellness_data. Uses the same core as the MCP get_body_composition tool.
 */
import { Router } from 'express';
import { requireScope } from '../../../middleware/bearer-auth.js';
import { wrap } from '../../../logger.js';
import { getBodyCompositionCore } from '../../../lib/mcp/tools/get-body-composition.js';

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
    const result = getBodyCompositionCore(req.apiUser.id, {
      start: req.query.start,
      end: req.query.end,
      source: req.query.source,
    });
    if (result.error) return res.status(400).json({ error: result.error });
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

export default router;
