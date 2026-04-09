import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'path';
import { fileURLToPath } from 'url';

import proxyRoutes  from './routes/proxy.js';
import authRoutes   from './routes/auth.js';
import dataRoutes   from './routes/data.js';
import foodsRoutes  from './routes/foods.js';
import mealsRoutes  from './routes/meals.js';
import diaryRoutes  from './routes/diary.js';
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
import { logger }   from './logger.js';
import { authenticate } from './middleware/auth.js';
import { csrfProtect } from './middleware/csrf.js';
import { seedSmtpFromEnv } from './email.js';
import { seedAiFromEnv } from './ai.js';

// Initialise DB (runs schema)
import db from './db.js';

// Seed config from env vars if provided (env vars take priority over UI)
seedSmtpFromEnv();
seedAiFromEnv();

const app  = express();
const PORT = process.env.PORT || 3001;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

app.use(express.json({ limit: '50mb' }));
app.use(cookieParser());

// CORS — allow cross-origin requests from Android app (https://localhost) and same-origin
app.use((req, res, next) => {
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
app.use('/uploads', express.static(uploadsPath, {
  setHeaders(res) { res.set('Cache-Control', 'public, max-age=3600'); }
}));

// Proxy also before auth — used by Android WebView to load external images
// (DuckDuckGo, Walmart, etc. block direct WebView requests)
app.use('/api/proxy', proxyRoutes);

app.use(authenticate);   // attach req.user on every request
app.use(csrfProtect);   // CSRF protection for cookie-based sessions

// ── Request logging ────────────────────────────────────────────────────────
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms   = Date.now() - start;
    const lvl  = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    logger[lvl](`${req.method} ${req.path} → ${res.statusCode} (${ms}ms)`);
  });
  next();
});

// Prevent browser/proxy caching of all API responses
app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

// API routes
app.use('/api/auth',   authRoutes);
// proxy already registered before auth (line 64)
app.use('/api/data',   dataRoutes);
app.use('/api/foods',  foodsRoutes);
app.use('/api/meals',  mealsRoutes);
app.use('/api/diary',  diaryRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/mealie',     mealieRoutes);
app.use('/api/settings',  settingsRoutes);
app.use('/api/app-config',  appConfigRoutes);
app.use('/api/ai',          aiRoutes);
app.use('/api/full-backup',        fullBackupRoutes);
app.use('/api/wellness/fitbit',   fitbitRoutes);
app.use('/api/wellness/withings', withingsRoutes);
app.use('/api/wellness/garmin',  garminRoutes);
app.use('/api/sync',             syncRoutes);
app.get('/api/health', (req, res) => res.json({ ok: true }));

// Serve Svelte frontend (production build)
// Content-hashed assets (in /assets/) are safe to cache forever — new deploy = new filename
// index.html uses no-cache (not no-store) so the browser always revalidates with the server
// before using any cached copy — this fixes soft-reload serving stale HTML
app.use(express.static(path.join(__dirname, 'dist'), {
  setHeaders(res, filePath) {
    if (filePath.includes('/assets/')) {
      res.set('Cache-Control', 'public, max-age=31536000, immutable');
    } else {
      res.set('Cache-Control', 'no-cache');
    }
  }
}));

// SPA fallback — index.html, always revalidated
app.get('*', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

// ── Global error handler ───────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
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
