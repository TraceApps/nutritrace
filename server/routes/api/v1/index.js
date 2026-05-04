/**
 * /api/v1 — federation API for sister TraceApps and other authorized
 * integrations. Bearer-token auth, per-token rate limit, scope-gated
 * endpoints. See docs/federation.md for the wire contract.
 */
import { Router } from 'express';
import { bearerAuth } from '../../../middleware/bearer-auth.js';
import meRouter from './me.js';
import foodsRouter from './foods.js';

const router = Router();

// Every /api/v1 endpoint requires a valid Bearer token. Scope-gating is
// applied per-route inside each sub-router via requireScope().
router.use(bearerAuth);

router.use('/me', meRouter);
router.use('/foods', foodsRouter);

export default router;
