import { Router } from 'express';
import { wrap } from '../logger.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

/**
 * POST /api/mealie/proxy
 * Body: { baseUrl, token, path }
 * Server-side proxy for Mealie API calls — avoids CORS from the browser.
 */
router.post('/proxy', wrap(async (req, res) => {
  const { baseUrl, token, path } = req.body;
  if (!baseUrl || !token || !path) {
    return res.status(400).json({ error: 'baseUrl, token and path required' });
  }

  const url = baseUrl.replace(/\/$/, '') + path;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!response.ok) {
      return res.status(response.status).json({ error: `Mealie returned ${response.status}` });
    }
    res.json(await response.json());
  } catch(e) {
    clearTimeout(timer);
    res.status(503).json({ error: e.message });
  }
}));

export default router;
