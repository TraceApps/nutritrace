import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

import proxyRoutes  from './routes/proxy.js';
import authRoutes   from './routes/auth.js';
import dataRoutes   from './routes/data.js';
import foodsRoutes  from './routes/foods.js';
import mealsRoutes  from './routes/meals.js';
import diaryRoutes  from './routes/diary.js';
import activityRoutes from './routes/activity.js';
import uploadRoutes from './routes/upload.js';
import mealieRoutes    from './routes/mealie.js';
import settingsRoutes  from './routes/settings.js';
import appConfigRoutes  from './routes/app-config.js';
import aiRoutes         from './routes/ai.js';
import fullBackupRoutes from './routes/full-backup.js';
import fitbitRoutes     from './routes/fitbit.js';
import withingsRoutes   from './routes/withings.js';
import garminRoutes     from './routes/garmin.js';
import syncRoutes       from './routes/sync.js';
import oidcRoutes       from './routes/oidc.js';
import oidcAdminRoutes  from './routes/oidc-admin.js';
import nutritionImportRoutes from './routes/nutrition-import.js';
import { logger }   from './logger.js';
import { authenticate, userMgmtActive } from './middleware/auth.js';
import { csrfProtect } from './middleware/csrf.js';
import { makeRateLimiter } from './middleware/rate-limit.js';
import { seedSmtpFromEnv } from './email.js';
import { seedAiFromEnv } from './ai.js';
import { seedOidcFromEnv } from './lib/oidc-env.js';

// Initialise DB (runs schema)
import db from './db.js';

// Seed config from env vars if provided (env vars take priority over UI)
seedSmtpFromEnv();
seedAiFromEnv();
seedOidcFromEnv();

const app  = express();
const PORT = process.env.PORT || 3001;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Reverse-proxy / subpath support ───────────────────────────────────────
// BASE_URL lets users mount NutriTrace at a path other than root, e.g. for
// `https://example.com/nutritrace/` set BASE_URL=/nutritrace. Empty string
// (default) keeps current root-mounted behavior — no migration needed for
// existing installs.
const BASE_URL = (process.env.BASE_URL || '').replace(/\/$/, '');
if (BASE_URL && !BASE_URL.startsWith('/')) {
  console.error(`[server] BASE_URL must start with '/' — got: ${BASE_URL}`);
  process.exit(1);
}
// Everything route-related goes on this router; mounted at BASE_URL or '/'.
// Using a sub-router keeps `req.path` in middleware (e.g. csrf.js skip lists)
// relative to the mount point so existing path checks keep working.
const router = express.Router();

// Per-route JSON limits for endpoints that legitimately handle large payloads
// (full data export/import, full-history sync push). Registered BEFORE the
// global parser so they win — by the time the global parser runs, req.body
// is already populated and it short-circuits.
router.use('/api/data/import', express.json({ limit: '25mb' }));
router.use('/api/sync/push',   express.json({ limit: '25mb' }));
// Global cap: 1 MB. Prevents a single authed user from filling memory with
// repeated large requests. Anything above belongs on a per-route opt-in.
router.use(express.json({ limit: '1mb' }));
router.use(cookieParser());

// CORS — allow cross-origin requests from Android app (https://localhost) and same-origin
router.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    // Allow Capacitor WebView (https://localhost) and same-host origins
    const host = req.headers.host;
    const isCapacitor = origin === 'https://localhost' || origin === 'http://localhost';
    const isSameHost = host && origin.includes(host);
    if (isCapacitor || isSameHost) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-CSRF-Token');
      if (req.method === 'OPTIONS') return res.sendStatus(204);
    }
  }
  next();
});

// Serve uploaded images BEFORE auth — images are public (needed for Android WebView
// which can't send Authorization headers on <img src> requests)
const uploadsPath = process.env.UPLOADS_PATH || './uploads';
router.use('/uploads', express.static(uploadsPath, {
  setHeaders(res) { res.set('Cache-Control', 'public, max-age=3600'); }
}));

// Proxy also before auth — used by Android WebView to load external images
// (DuckDuckGo, Walmart, etc. block direct WebView requests)
router.use('/api/proxy', proxyRoutes);

router.use(authenticate);   // attach req.user on every request
router.use(csrfProtect);   // CSRF protection for cookie-based sessions

// ── Request logging ────────────────────────────────────────────────────────
router.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms   = Date.now() - start;
    const lvl  = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    logger[lvl](`${req.method} ${req.path} → ${res.statusCode} (${ms}ms)`);
  });
  next();
});

// Prevent browser/proxy caching of all API responses
router.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

// Setup enforcement — block data APIs until the first user account is created.
// Only /api/auth/* is allowed so the client can check status + register the admin.
router.use('/api', (req, res, next) => {
  if (req.path.startsWith('/auth')) return next(); // allow auth routes (status, register, login)
  if (userMgmtActive()) return next();             // users exist — normal operation
  res.status(503).json({ error: 'Setup required', setup_required: true });
});

// API routes
// OIDC public routes mount BEFORE authRoutes so /api/auth/oidc/* never falls
// into authRoutes' 404 path. Both are exempt from the setup-required gate
// above (it allows anything under /auth) so OIDC can bootstrap a fresh
// install.
router.use('/api/auth/oidc', oidcRoutes);
router.use('/api/auth',   authRoutes);
// OIDC admin (provider CRUD) — gated by requireAuth + requireAdmin inside
// the router; setup-required gate blocks it until a user exists, which is
// the right ordering (no admin UI before the first user).
router.use('/api/admin/oidc', oidcAdminRoutes);
// proxy already registered before auth (line 64)
router.use('/api/data',   dataRoutes);
router.use('/api/foods',  foodsRoutes);
router.use('/api/meals',  mealsRoutes);
router.use('/api/diary',  diaryRoutes);
router.use('/api/activity', activityRoutes);
router.use('/api/nutrition-import', nutritionImportRoutes);
router.use('/api/upload', uploadRoutes);
router.use('/api/mealie',     mealieRoutes);
router.use('/api/settings',  settingsRoutes);
router.use('/api/app-config',  appConfigRoutes);
router.use('/api/ai',          aiRoutes);
router.use('/api/full-backup',        fullBackupRoutes);
// Per-IP rate limit on OAuth callbacks — these run unauthenticated and trigger
// expensive token-exchange round-trips with the OAuth provider.
const oauthCallbackLimit = makeRateLimiter({ max: 10, windowMs: 60_000, label: 'oauth-callback' });
router.use(['/api/wellness/fitbit/callback', '/api/wellness/withings/callback', '/api/wellness/garmin/callback'], oauthCallbackLimit);
router.use('/api/wellness/fitbit',   fitbitRoutes);
router.use('/api/wellness/withings', withingsRoutes);
router.use('/api/wellness/garmin',  garminRoutes);

// Cross-source calories_out lookup — for Dynamic Calorie Goal
// Returns yesterday's merged TDEE from fitbit/garmin/health_connect
router.get('/api/wellness/calories-out', (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const { date } = req.query;
  // date param = the diary date; we want the day before
  const base = date ? new Date(date + 'T12:00:00Z') : new Date();
  base.setUTCDate(base.getUTCDate() - 1);
  const yesterday = base.toISOString().slice(0, 10);
  // Priority: garmin > health_connect > fitbit (all provide true TDEE)
  const PRIORITY = ['garmin', 'health_connect', 'fitbit'];
  const rows = db.prepare(
    `SELECT source, value FROM wellness_data
     WHERE user_id=? AND date=? AND metric_type='calories_out'`
  ).all(userId, yesterday);
  let result = null;
  for (const src of PRIORITY) {
    const row = rows.find(r => r.source === src);
    if (row) { result = { calories_out: row.value, source: src, date: yesterday }; break; }
  }
  res.json(result || { calories_out: null, source: null, date: yesterday });
});
router.use('/api/sync',             syncRoutes);
router.get('/api/health', (req, res) => res.json({ ok: true }));

// Serve Svelte frontend (production build) — anything except index.html.
// Content-hashed assets (in /assets/) are safe to cache forever — new deploy =
// new filename. The index.html itself goes through the SPA fallback below so
// it can be templated with __NT_CONFIG__.
router.use(express.static(path.join(__dirname, 'dist'), {
  index: false,                  // skip index.html — handled by templated fallback
  setHeaders(res, filePath) {
    if (filePath.includes('/assets/')) {
      res.set('Cache-Control', 'public, max-age=31536000, immutable');
    } else {
      res.set('Cache-Control', 'no-cache');
    }
  }
}));

// Read the built index.html once at startup and inject __NT_CONFIG__ so the
// client knows its base path at runtime. Empty BASE_URL → empty basePath →
// behaviorally identical to a deploy without this feature.
const _indexHtmlPath = path.join(__dirname, 'dist', 'index.html');
let _indexHtmlTemplated = '';
try {
  const raw = fs.readFileSync(_indexHtmlPath, 'utf8');
  _indexHtmlTemplated = raw.replace(
    '</head>',
    `<script>window.__NT_CONFIG__ = { basePath: ${JSON.stringify(BASE_URL)} };</script></head>`
  );
} catch (e) {
  logger.warn(`[server] could not pre-template dist/index.html: ${e.message}`);
}

// SPA fallback — serves the templated index.html for any route under BASE_URL.
router.get('*', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  if (_indexHtmlTemplated) {
    res.set('Content-Type', 'text/html').send(_indexHtmlTemplated);
  } else {
    res.sendFile(_indexHtmlPath);
  }
});

// Mount the router at BASE_URL (or root if unset).
app.use(BASE_URL || '/', router);

// ── Global error handler ───────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
router.use((err, req, res, next) => {
  logger.error(`${req.method} ${req.path} — ${err.stack || err.message}`);
  if (!res.headersSent) {
    res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
  }
});

// ── Process-level safety nets ─────────────────────────────────────────────
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection:', reason instanceof Error ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception:', err.stack || err.message);
  process.exit(1);
});

app.listen(PORT, () => {
  logger.info(`NutriTrace running on port ${PORT}`);

  // Start the notification + sync scheduler
  import('./lib/scheduler.js').then(({ startScheduler }) => startScheduler()).catch(e => {
    logger.warn(`[scheduler] failed to start: ${e.message}`);
  });

  // One-time migration: download all external food/meal images to /uploads/
  (async () => {
    try {
      const { localizeImage, isExternalUrl } = await import('./lib/image-localizer.js');
      const foods = db.prepare(`SELECT id, img_url FROM foods WHERE img_url IS NOT NULL AND deleted_at IS NULL`).all();
      const meals = db.prepare(`SELECT id, img_url FROM meals WHERE img_url IS NOT NULL AND deleted_at IS NULL`).all();
      const external = [...foods.map(f => ({ ...f, table: 'foods' })), ...meals.map(m => ({ ...m, table: 'meals' }))]
        .filter(r => isExternalUrl(r.img_url));

      if (external.length > 0) {
        logger.info(`[image-localizer] Migrating ${external.length} external images to /uploads/...`);
        let migrated = 0;
        for (const r of external) {
          const localPath = await localizeImage(r.img_url);
          if (localPath !== r.img_url) {
            db.prepare(`UPDATE ${r.table} SET img_url = ?, updated_at = datetime('now') WHERE id = ?`).run(localPath, r.id);
            migrated++;
          }
        }
        logger.info(`[image-localizer] Migrated ${migrated}/${external.length} images`);
      }
    } catch (e) {
      logger.warn('[image-localizer] Migration error:', e.message);
    }
  })();
});
