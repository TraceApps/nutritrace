/**
 * /api/v1 — federation API for sister TraceApps and other authorized
 * integrations. Bearer-token auth, per-token rate limit, scope-gated
 * endpoints. See docs/federation.md for the wire contract.
 */
import { Router } from 'express';
import { bearerAuth } from '../../../middleware/bearer-auth.js';
import meRouter from './me.js';
import foodsRouter from './foods.js';
import workoutsRouter from './workouts.js';
import activityRouter from './activity.js';
import bodyMeasurementsRouter from './body-measurements.js';
import diaryRouter from './diary.js';
import goalsRouter from './goals.js';
import mealsRouter from './meals.js';

const router = Router();

// Every /api/v1 endpoint requires a valid Bearer token. Scope-gating is
// applied per-route inside each sub-router via requireScope().
router.use(bearerAuth);

router.use('/me', meRouter);
router.use('/foods', foodsRouter);
router.use('/workouts', workoutsRouter);
router.use('/activity', activityRouter);
router.use('/body-measurements', bodyMeasurementsRouter);
// diary/goals/meals are the general-purpose public API (a user's own
// scripts and automations), not a sister-app federation contract like
// the routers above. Each self-gates behind PUBLIC_API_ENABLED and
// reuses the mcp:read/mcp:write scopes MCP already defines.
router.use('/diary', diaryRouter);
router.use('/goals', goalsRouter);
router.use('/meals', mealsRouter);

export default router;
