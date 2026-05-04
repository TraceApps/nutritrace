/**
 * GET /api/v1/me — identity check for the authenticated token.
 *
 * Always available regardless of token scopes. Useful for clients to
 * verify the token is valid + discover which user it belongs to.
 */
import { Router } from 'express';
import { wrap } from '../../../logger.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const router = Router();

// Read app version once at startup. Pulled from the root package.json
// so /me always reflects the app's user-facing version, not the
// stale server/package.json one.
let _appVersion = 'unknown';
try {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(readFileSync(join(__dirname, '../../../../package.json'), 'utf8'));
  _appVersion = pkg.version || 'unknown';
} catch {}

router.get('/', wrap((req, res) => {
  // Compose instance URL from the request. Honors X-Forwarded-* when
  // behind a reverse proxy (Express trust-proxy must be configured
  // for it to be accurate, which it is in production setups).
  const proto = req.protocol;
  const host = req.get('host') || '';
  const basePath = process.env.BASE_URL || '';
  const instanceUrl = `${proto}://${host}${basePath}`;

  res.json({
    user: {
      id: req.apiUser.id,
      username: req.apiUser.username,
      full_name: req.apiUser.full_name,
      role: req.apiUser.role,
    },
    instance: {
      url: instanceUrl,
      version: _appVersion,
    },
    scopes: req.apiToken.scopes,
  });
}));

export default router;
