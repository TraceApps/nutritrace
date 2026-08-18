/**
 * local-backup.js — full device-to-device backup as a single .zip file.
 *
 * Used when the user is on local-only mode (no server) and wants to migrate
 * from one device to another, OR when a server-connected user wants a
 * portable snapshot they can carry around.
 *
 * The bundle contains:
 *   - manifest.json     (version, exportedAt, counts)
 *   - foods.json        (all local foods)
 *   - meals.json        (all local meals + recipes, recipes have is_recipe=1)
 *   - diary.json        (all diary entries with body_stats and water)
 *   - wellness.json     (all wellness_data rows: fitbit, garmin, withings, health_connect)
 *   - workouts.json     (all workout entries)
 *   - activity.json     (manual activity entries from the Diary's Activity section)
 *   - settings.json     (all USER_PREFS — DEVICE_PREFS and SERVER_ADMIN are excluded)
 *   - images/<id>.jpg   (binary image files for each food/meal that has an imgUrl,
 *                       referenced from the JSON via "img:images/<id>.jpg")
 *
 * Restore reverses the process: extracts the ZIP, writes images back to the
 * Capacitor Filesystem (or keeps them as data: URLs on PWA), rewrites img_url
 * fields to point to the new file paths, then upserts everything into the
 * local database.
 */

import JSZip from 'jszip';
import { isNative } from './platform.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Read an image at any local URL and return its bytes + extension.
 * Handles: data: URLs, http(s):// URLs, file:// paths, blob: URLs.
 * Returns null if the image can't be loaded (network error, missing file, etc.)
 */
async function _loadImageBytes(imgUrl) {
  if (!imgUrl || typeof imgUrl !== 'string') return null;
  try {
    // data: URLs — decode the base64 portion directly
    if (imgUrl.startsWith('data:')) {
      const m = imgUrl.match(/^data:(image\/[a-z]+);base64,(.+)$/);
      if (!m) return null;
      const mime = m[1];
      const b64 = m[2];
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const ext = mime.split('/')[1] || 'jpg';
      return { bytes, ext };
    }
    // file:// on native — use Capacitor Filesystem
    if (isNative && imgUrl.startsWith('file://')) {
      try {
        const { Filesystem } = await import('@capacitor/filesystem');
        // Try to read as base64. The directory is encoded in the URI itself.
        const result = await Filesystem.readFile({ path: imgUrl });
        const b64 = result.data;
        if (typeof b64 !== 'string') return null;
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const ext = imgUrl.match(/\.([a-z0-9]+)(\?|$)/i)?.[1] || 'jpg';
        return { bytes, ext };
      } catch (e) {
        // Fall through to fetch() attempt
      }
    }
    // Everything else — try a regular fetch
    const r = await fetch(imgUrl);
    if (!r.ok) return null;
    const blob = await r.blob();
    const buf = await blob.arrayBuffer();
    const ext = (blob.type && blob.type.split('/')[1]) || imgUrl.match(/\.([a-z0-9]+)(\?|$)/i)?.[1] || 'jpg';
    return { bytes: new Uint8Array(buf), ext };
  } catch {
    return null;
  }
}

/** Build a deterministic image filename inside the ZIP for a food/meal record. */
function _imageFilename(prefix, id, ext) {
  return `images/${prefix}-${id}.${ext}`;
}

// ── Export ──────────────────────────────────────────────────────────────────

/**
 * Build a full local backup ZIP and return it as a Blob.
 * Images are ALWAYS embedded — backups must be self-contained for true
 * phone-to-phone transfer (matching the server-side full-backup behavior).
 *
 * @param {Object} opts
 * @param {(progress: number, label: string) => void} [opts.onProgress]
 * @returns {Promise<Blob>}
 */
export async function exportLocalBackup(opts = {}) {
  const onProgress = opts.onProgress || (() => {});

  onProgress(0, 'Reading data…');

  // Pull everything from local DB. Use the unified API so PWA + native
  // both work — NtApi auto-routes to native SQLite or server depending on mode.
  const { NtApi } = await import('./api.js');
  const { DB }     = await import('./db.js');

  let foods = [], meals = [], recipes = [], diary = [], wellness = [], workouts = [], activity = [], fasts = [], exercises = [], exerciseLogs = [];

  try { foods    = await NtApi.getFoods()    || []; } catch {}
  try { meals    = await NtApi.getMeals()    || []; } catch {}
  try { recipes  = await NtApi.getRecipes()  || []; } catch {}
  try { diary    = await NtApi.getAllDiary() || []; } catch {}
  // Activity — manual exercise calorie entries (server-only path)
  try { activity = await NtApi.getActivityRange('1900-01-01', '2999-12-31') || []; } catch {}
  // Intermittent fasting log — completed + active fasts
  try { fasts    = await NtApi.get('/api/fasts?limit=10000') || []; } catch {}
  try { exercises = await NtApi.getExercises() || []; } catch {}
  try { exerciseLogs = await NtApi.getAllExerciseLogs('0000-01-01', '9999-12-31') || []; } catch {}

  // Wellness + workouts are native-only (PWA reads from server endpoints not unified API)
  if (isNative) {
    try {
      const { dbGetWellnessGrouped, dbGetWorkouts, dbGetWellnessByDate } = await import('./db-native.js');
      const grouped = await dbGetWellnessGrouped('1900-01-01', '2999-12-31');
      // Flatten { date: { metric: value } } back to row form. Include `source`
      // + `metadata` so a restore preserves which wearable produced each row
      // (fitbit vs garmin vs google_health) and Sleep Quality sub-metrics.
      // Without these the restore would default every row to 'health_connect'
      // and drop the stage-breakdown / workout-detail metadata JSON.
      wellness = [];
      for (const date of Object.keys(grouped || {})) {
        try {
          const rows = await dbGetWellnessByDate(date) || [];
          for (const r of rows) {
            wellness.push({
              date: r.date,
              metric_type: r.metric_type,
              value: r.value,
              source: r.source || 'health_connect',
              metadata: r.metadata || null,
            });
          }
        } catch {}
      }
      try { workouts = await dbGetWorkouts('1900-01-01', '2999-12-31') || []; } catch {}
    } catch {}
  }

  // Settings — only USER_PREFS, never DEVICE_PREFS or admin keys
  const allSettings = DB.getAllSettings();
  let userPrefSet = null;
  try {
    const mod = await import('../stores/settings.js');
    userPrefSet = mod.USER_PREFS;
  } catch {}
  const settings = {};
  for (const [k, v] of Object.entries(allSettings || {})) {
    if (!userPrefSet || userPrefSet.has(k)) settings[k] = v;
  }

  onProgress(15, 'Packing data…');

  const zip = new JSZip();
  const manifest = {
    version: 1,
    exportedAt: new Date().toISOString(),
    appVersion: (await import('./version.js').then(m => m.APP_VERSION).catch(() => 'unknown')),
    counts: {
      foods: foods.length,
      meals: meals.length,
      recipes: recipes.length,
      diary: diary.length,
      wellness: wellness.length,
      workouts: workouts.length,
      activity: activity.length,
      fasts: fasts.length,
      exercises: exercises.length,
      exercise_logs: exerciseLogs.length,
      settings: Object.keys(settings).length,
    },
    includesImages: true,
  };
  zip.file('manifest.json', JSON.stringify(manifest, null, 2));

  // ── Embed images (always — backups are self-contained) ──────────────────
  // Walk foods + meals + recipes, load each imgUrl, embed in zip,
  // rewrite the JSON's imgUrl to a relative "images/..." path so the
  // restore process can find them.
  {
    const totalItems = foods.length + meals.length + recipes.length + exercises.length;
    let processed = 0;

    async function embedItem(item, prefix) {
      processed++;
      if (processed % 10 === 0) {
        onProgress(15 + (processed / totalItems) * 60, `Packing images (${processed}/${totalItems})…`);
      }
      const url = item.imgUrl || item.img_url;
      if (!url) return item;
      const loaded = await _loadImageBytes(url);
      if (!loaded) return { ...item, imgUrl: '', img_url: '' };
      const filename = _imageFilename(prefix, item.id || item.client_id || processed, loaded.ext);
      zip.file(filename, loaded.bytes);
      return { ...item, imgUrl: filename, img_url: filename };
    }

    foods   = await Promise.all(foods.map(f   => embedItem(f, 'food')));
    meals   = await Promise.all(meals.map(m   => embedItem(m, 'meal')));
    recipes = await Promise.all(recipes.map(r => embedItem(r, 'recipe')));
    exercises = await Promise.all(exercises.map(e => embedItem(e, 'exercise')));
  }

  onProgress(80, 'Writing JSON…');

  zip.file('foods.json',    JSON.stringify(foods,    null, 2));
  zip.file('meals.json',    JSON.stringify(meals,    null, 2));
  zip.file('recipes.json',  JSON.stringify(recipes,  null, 2));
  zip.file('diary.json',    JSON.stringify(diary,    null, 2));
  zip.file('wellness.json', JSON.stringify(wellness, null, 2));
  zip.file('workouts.json', JSON.stringify(workouts, null, 2));
  zip.file('activity.json', JSON.stringify(activity, null, 2));
  zip.file('fasts.json',    JSON.stringify(fasts,    null, 2));
  zip.file('exercises.json', JSON.stringify(exercises, null, 2));
  zip.file('exercise_logs.json', JSON.stringify(exerciseLogs, null, 2));
  zip.file('settings.json', JSON.stringify(settings, null, 2));

  onProgress(90, 'Compressing…');

  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });

  onProgress(100, 'Done');
  return blob;
}

// ── Import ──────────────────────────────────────────────────────────────────

/**
 * Restore a local backup ZIP into the device's local database.
 * Existing data is NOT cleared first — items are upserted.
 *
 * @param {Blob|File|ArrayBuffer} zipFile
 * @param {Object} opts
 * @param {(progress: number, label: string) => void} [opts.onProgress]
 * @returns {Promise<{counts: object}>}
 */
export async function importLocalBackup(zipFile, opts = {}) {
  const onProgress = opts.onProgress || (() => {});
  onProgress(0, 'Reading backup…');

  const buf = zipFile instanceof Blob ? await zipFile.arrayBuffer() : zipFile;
  const zip = await JSZip.loadAsync(buf);

  // ── Parse the JSON files ─────────────────────────────────────────────────
  async function readJson(name, def) {
    const f = zip.file(name);
    if (!f) return def;
    try { return JSON.parse(await f.async('string')); } catch { return def; }
  }

  const manifest = await readJson('manifest.json', { version: 1 });
  if (manifest.version !== 1) {
    throw new Error(`Unsupported backup version ${manifest.version}`);
  }

  let foods    = await readJson('foods.json', []);
  let meals    = await readJson('meals.json', []);
  let recipes  = await readJson('recipes.json', []);
  const diary    = await readJson('diary.json', []);
  const wellness = await readJson('wellness.json', []);
  const workouts = await readJson('workouts.json', []);
  const activity = await readJson('activity.json', []);
  const fasts    = await readJson('fasts.json', []);
  let exercises  = await readJson('exercises.json', []);
  const exerciseLogs = await readJson('exercise_logs.json', []);
  const settings = await readJson('settings.json', {});

  onProgress(20, 'Extracting images…');

  // ── Restore images ───────────────────────────────────────────────────────
  // For each item with imgUrl pointing to "images/...", extract the file from
  // the ZIP and either write it back to the device's filesystem (native) or
  // re-encode as a data: URL (PWA), then rewrite the imgUrl.
  async function restoreItemImage(item) {
    const path = item.imgUrl || item.img_url;
    if (!path || !path.startsWith('images/')) return item;
    const f = zip.file(path);
    if (!f) return { ...item, imgUrl: '', img_url: '' };
    try {
      if (isNative) {
        // Write to Capacitor Filesystem and store the resulting file:// URL
        const { Filesystem, Directory } = await import('@capacitor/filesystem');
        const b64 = await f.async('base64');
        const filename = path.split('/').pop();
        const writeRes = await Filesystem.writeFile({
          path: `nutritrace-images/${filename}`,
          data: b64,
          directory: Directory.Data,
          recursive: true,
        });
        return { ...item, imgUrl: writeRes.uri, img_url: writeRes.uri };
      } else {
        // PWA: encode as data: URL and let it ride
        const blob = await f.async('blob');
        const dataUrl = await new Promise((resolve) => {
          const r = new FileReader();
          r.onloadend = () => resolve(r.result);
          r.readAsDataURL(blob);
        });
        return { ...item, imgUrl: dataUrl, img_url: dataUrl };
      }
    } catch {
      return { ...item, imgUrl: '', img_url: '' };
    }
  }

  foods   = await Promise.all(foods.map(restoreItemImage));
  meals   = await Promise.all(meals.map(restoreItemImage));
  recipes = await Promise.all(recipes.map(restoreItemImage));
  exercises = await Promise.all(exercises.map(restoreItemImage));

  onProgress(50, 'Importing data…');

  // ── Write everything to the local DB ─────────────────────────────────────
  const { NtApi } = await import('./api.js');
  const { DB }     = await import('./db.js');

  const counts = { foods: 0, meals: 0, recipes: 0, diary: 0, wellness: 0, workouts: 0, activity: 0, fasts: 0, exercises: 0, exercise_logs: 0, settings: 0 };

  if (isNative) {
    try {
      const {
        dbCreateFood, dbCreateMeal, dbSaveDiaryDate, dbUpsertWellness,
        dbUpsertFromServer, dbUpsertWorkoutFromServer, dbUpsertActivityFromServer,
        dbStartFast, dbUpdateFast,
        dbCreateExercise, dbUpsertExerciseLog, dbUpsertExerciseFromServer, dbUpsertExerciseLogFromServer,
      } = await import('./db-native.js');
      // Foods / meals / recipes — prefer the *FromServer upsert path when the
      // export carries an `id` (or `server_id`). Falling back to dbCreateFood
      // for id-less exports keeps backward compat with old backups. The upsert
      // path also means a second restore on top of an existing DB doesn't
      // double up every row (previous behaviour created a new row each pass).
      for (const food of foods) {
        try {
          if (food.id != null || food.server_id != null) {
            await dbUpsertFromServer('foods', { ...food, id: food.id ?? food.server_id });
          } else {
            await dbCreateFood(food);
          }
          counts.foods++;
        } catch {}
      }
      for (const meal of meals) {
        try {
          if (meal.id != null || meal.server_id != null) {
            await dbUpsertFromServer('meals', { ...meal, id: meal.id ?? meal.server_id });
          } else {
            await dbCreateMeal(meal);
          }
          counts.meals++;
        } catch {}
      }
      for (const recipe of recipes) {
        try {
          if (recipe.id != null || recipe.server_id != null) {
            await dbUpsertFromServer('meals', { ...recipe, is_recipe: 1, id: recipe.id ?? recipe.server_id });
          } else {
            await dbCreateMeal({ ...recipe, is_recipe: 1 });
          }
          counts.recipes++;
        } catch {}
      }
      for (const entry of diary) {
        if (!entry.date) continue;
        try { await dbSaveDiaryDate(entry.date, entry); counts.diary++; } catch {}
      }
      for (const w of wellness) {
        if (!w.date || !w.metric_type) continue;
        try {
          await dbUpsertWellness(w.date, w.source || 'health_connect', w.metric_type, w.value, w.metadata || {});
          counts.wellness++;
        } catch {}
      }
      // Workouts — replay via server-shaped upsert so we survive a second
      // restore without doubling rows and so gps_data carries through.
      counts.workouts = 0;
      for (const w of workouts) {
        try {
          await dbUpsertWorkoutFromServer({ ...w, id: w.server_id ?? w.id });
          counts.workouts++;
        } catch {}
      }
      // Manual activity_log entries (rc.7) — same upsert-from-server pattern.
      counts.activity = 0;
      for (const a of activity) {
        try {
          await dbUpsertActivityFromServer({ ...a, id: a.server_id ?? a.id });
          counts.activity++;
        } catch {}
      }
      // Fasts — replay completed + active fasts. Use dbStartFast + dbUpdateFast
      // so the local sync_status pipeline applies correctly.
      for (const f of fasts) {
        if (!f.start_at) continue;
        try {
          const row = await dbStartFast({ goal_hours: f.goal_hours, start_at: f.start_at });
          if (f.end_at) await dbUpdateFast(row.id, { end_at: f.end_at });
          if (f.notes)  await dbUpdateFast(row.id, { notes: f.notes });
          counts.fasts++;
        } catch {}
      }
      for (const e of exercises) {
        try {
          if (e.id != null || e.server_id != null) {
            await dbUpsertExerciseFromServer({ ...e, id: e.id ?? e.server_id });
          } else {
            await dbCreateExercise(e);
          }
          counts.exercises++;
        } catch {}
      }
      for (const l of exerciseLogs) {
        try {
          if (l.id != null || l.server_id != null) {
            await dbUpsertExerciseLogFromServer({ ...l, id: l.id ?? l.server_id });
          } else if (l.exercise_id && l.date) {
            await dbUpsertExerciseLog(l.exercise_id, l.date, l);
          }
          counts.exercise_logs++;
        } catch {}
      }
    } catch (e) {
      console.warn('[backup] native import failed:', e.message);
    }
  } else {
    // PWA: server import endpoint
    try {
      await NtApi.post('/api/data/import', { foodList: foods, meals, recipes, diary, wellness, workouts, activity, fasts, exercises, exercise_logs: exerciseLogs });
      counts.foods    = foods.length;
      counts.meals    = meals.length;
      counts.recipes  = recipes.length;
      counts.diary    = diary.length;
      counts.wellness = wellness.length;
      counts.workouts = workouts.length;
      counts.activity = activity.length;
      counts.fasts    = fasts.length;
      counts.exercises = exercises.length;
      counts.exercise_logs = exerciseLogs.length;
    } catch {}
  }

  // Settings — go through the bulk-set helper so server gets a single push
  if (settings && typeof settings === 'object') {
    try {
      const { bulkSet } = await import('../stores/settings.js');
      await bulkSet(settings);
      counts.settings = Object.keys(settings).length;
    } catch {
      // Fallback: write each one directly
      for (const [k, v] of Object.entries(settings)) {
        try { DB.setSetting(k, v); counts.settings++; } catch {}
      }
    }
  }

  onProgress(100, 'Done');
  return { counts, manifest };
}
