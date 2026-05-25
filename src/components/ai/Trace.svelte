<script>
  import { onMount, onDestroy, tick } from 'svelte';
  import { fly, fade } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import { _ } from 'svelte-i18n';
  import TraceFace from './TraceFace.svelte';
  import { NtApi }     from '../../lib/api.js';
  import { DB, localDateStr } from '../../lib/db.js';
  import { Nutrition } from '../../lib/nutrition.js';
  import { readBodyStat, LENGTH_KEYS } from '../../lib/body-stats-unit.js';
  import { callAI, callAIProxy, TOOLS, setToolHandler } from '../../lib/aiChat.js';
  import { aiEnabled, aiEffectivelyEnabled, envLocks, aiKeyVerified, aiAssistantName, aiApiKey, aiProvider, aiModel, aiBaseUrl, goals, mealNames, energyUnit, dateFormat, timeFormat, tempUnit, quickLogEnabled, aiGoalInsights, healthConnectEnabled } from '../../stores/settings.js';
  import { currentUser } from '../../stores/auth.js';
  import SmartLogModal from '../diary/SmartLogModal.svelte';
  import { showError } from '../../stores/toast.js';
  import { isNative, getServerUrl, getAuthToken, apiUrl } from '../../lib/platform.js';

  // ── State ──────────────────────────────────────────────────────────────────
  let panelOpen  = false;
  let messages   = [];   // { role, content, time, image? }
  let input      = '';
  let loading    = false;
  let messagesEl;
  let hasUnread  = false;
  let attachedImage = null; // { base64, mimeType, preview }
  let _toolStatus = ''; // shown while AI is calling tools
  let fileInput;
  let _cameraInput;
  let _showAttachMenu = false;
  let _hasCamera = false;

  // Check if device has a camera (PWA only)
  if (!isNative && navigator.mediaDevices?.enumerateDevices) {
    navigator.mediaDevices.enumerateDevices().then(devices => {
      _hasCamera = devices.some(d => d.kind === 'videoinput');
    }).catch(() => {});
  }

  // Whether AI config is locked via env vars (proxy mode). Derived from
  // the global envLocks store (populated by App.svelte's startup fetch
  // with the Bearer token attached). Local fetch was removed because it
  // didn't carry the auth header on native server mode and 401'd, leaving
  // aiEnvLocked=false and the chat trying to use an empty local API key.
  $: aiEnvLocked = !!$envLocks.ai;

  // Settings — refreshed each time panel opens
  let assistantName = 'Trace';
  let apiKey        = '';

  $: if (panelOpen) {
    hasUnread     = false;
    // Mark current message count as seen so remounts don't show false unread dot
    try { localStorage.setItem('nt:chatSeenCount', String(messages.length)); } catch {}
    assistantName = $aiAssistantName;
    apiKey        = $aiApiKey;
    tick().then(() => _scrollBottom(true));
  }

  onMount(async () => {
    // Load history from server; fall back to localStorage for offline / migration
    try {
      const rows = await NtApi.get('/api/ai/history');
      if (rows.length) {
        messages = rows.map(r => ({ role: r.role, content: r.content, time: _fmtCreatedAt(r.created_at) }));
        // Sync seen count so remounts don't show false unread dot
        const seenCount = parseInt(localStorage.getItem('nt:chatSeenCount') || '0');
        if (messages.length <= seenCount) hasUnread = false;
        localStorage.removeItem('wl:aiChatHistory'); // clear migrated local copy
      } else {
        const saved = localStorage.getItem('wl:aiChatHistory');
        if (saved) {
          const local = JSON.parse(saved);
          if (local.length) {
            // Migrate localStorage messages to server
            messages = local;
            for (const m of local) {
              await NtApi.post('/api/ai/history', { role: m.role, content: m.content }).catch(() => {});
            }
            localStorage.removeItem('wl:aiChatHistory');
          }
        }
      }
    } catch {
      try {
        const saved = localStorage.getItem('wl:aiChatHistory');
        if (saved) messages = JSON.parse(saved);
      } catch {}
    }
    // env-lock state is now derived from the global envLocks store via the
    // reactive declaration above. App.svelte populates that on startup
    // with the Bearer token attached, so it works on native server mode
    // too. No local fetch needed.

    // Unit conversion for tool results — convert before AI sees the data
    function _convertWellnessUnits(data) {
      const distUnit = DB.getSetting('distUnit', 'km');
      const weightUnit = DB.getSetting('weightUnit', 'lb');
      const tempUnit = DB.getSetting('tempUnit', 'F');
      const converted = {};
      for (const [date, metrics] of Object.entries(data)) {
        const m = { ...metrics };
        // Distance: km → mi
        if (m.distance_km != null && distUnit === 'mi') {
          m.distance_mi = Math.round(m.distance_km * 0.621371 * 100) / 100;
          delete m.distance_km;
        }
        // Weight: kg → lb
        if (m.weight_kg != null && weightUnit === 'lb') {
          m.weight_lb = Math.round(m.weight_kg * 2.20462 * 10) / 10;
          delete m.weight_kg;
        }
        if (m.muscle_mass_kg != null && weightUnit === 'lb') {
          m.muscle_mass_lb = Math.round(m.muscle_mass_kg * 2.20462 * 10) / 10;
          delete m.muscle_mass_kg;
        }
        if (m.bone_mass_kg != null && weightUnit === 'lb') {
          m.bone_mass_lb = Math.round(m.bone_mass_kg * 2.20462 * 100) / 100;
          delete m.bone_mass_kg;
        }
        if (m.lean_mass_kg != null && weightUnit === 'lb') {
          m.lean_mass_lb = Math.round(m.lean_mass_kg * 2.20462 * 10) / 10;
          delete m.lean_mass_kg;
        }
        if (m.fat_mass_kg != null && weightUnit === 'lb') {
          m.fat_mass_lb = Math.round(m.fat_mass_kg * 2.20462 * 10) / 10;
          delete m.fat_mass_kg;
        }
        // Skin temp: °C → °F
        if (m.skin_temp_variation != null && tempUnit === 'F') {
          m.skin_temp_variation = Math.round(m.skin_temp_variation * 9 / 5 * 100) / 100;
        }
        converted[date] = m;
      }
      return converted;
    }

    // Register tool handler for AI function calling
    setToolHandler(async (name, args) => {
      switch (name) {
        case 'get_wellness_data': {
          let raw;
          if (isNative) {
            try {
              const { dbGetWellnessGrouped } = await import('../../lib/db-native.js');
              raw = await dbGetWellnessGrouped(args.from, args.to, null);
            } catch { raw = {}; }
          }
          if (!raw) {
            const [fitbit, garmin] = await Promise.allSettled([
              NtApi.get(`/api/wellness/fitbit/data?from=${args.from}&to=${args.to}`),
              NtApi.get(`/api/wellness/garmin/data?from=${args.from}&to=${args.to}`),
            ]);
            const fb = fitbit.status === 'fulfilled' ? fitbit.value : {};
            const gm = garmin.status === 'fulfilled' ? garmin.value : {};
            raw = {};
            for (const [d, v] of Object.entries(gm)) raw[d] = { ...v };
            for (const [d, v] of Object.entries(fb)) raw[d] = { ...(raw[d] || {}), ...v };
          }
          // Convert units to user preferences before sending to AI
          return _convertWellnessUnits(raw);
        }
        case 'get_body_composition': {
          try {
            const data = await NtApi.get(`/api/wellness/withings/data?from=${args.from}&to=${args.to}`);
            return _convertWellnessUnits(data);
          } catch { return {}; }
        }
        case 'get_diary': {
          try {
            const entry = await NtApi.getDiaryDate(args.date);
            // Manual activity is its own table — fetch alongside the diary
            // row so the AI sees the full picture for the day, not just food.
            const activities = await NtApi.getActivity(args.date).catch(() => []);
            const hasItems = entry?.items?.length > 0;
            const notes = (entry?.notes || '').trim();
            const totals = hasItems ? Nutrition.sum(entry.items.map(i => Nutrition.calculate(i))) : {};
            const names = mealNames.get();
            const meals = {};
            if (hasItems) {
              for (const it of entry.items) {
                const mIdx = it.meal ?? 0;
                const mName = names[mIdx] || `Meal ${mIdx + 1}`;
                const row = {
                  name: it.name, portion: it.portion, unit: it.unit, quantity: it.quantity,
                  calories: Math.round((it.nutrition?.calories || 0) * (it.quantity || 1)),
                };
                if (it.brand) row.brand = it.brand;
                if (typeof it.notes === 'string' && it.notes.trim()) row.notes = it.notes.trim();
                (meals[mName] = meals[mName] || []).push(row);
              }
            }
            // Body-stats values are stored tagged with the unit at write
            // time. Convert into the user's current display unit + add the
            // unit hint so the AI doesn't misread "180" as kg/cm.
            const wu = DB.getSetting('weightUnit', 'lb');
            const lu = DB.getSetting('lengthUnit', 'in');
            const rawBs = entry?.body_stats || entry?.bodyStats || {};
            const bodyStats = {};
            if (rawBs.weight != null && rawBs.weight !== '') {
              bodyStats.weight = readBodyStat(rawBs, 'weight', wu, lu);
              bodyStats.weight_unit = wu;
            }
            if (rawBs.body_fat != null && rawBs.body_fat !== '') bodyStats.body_fat_pct = Number(rawBs.body_fat);
            for (const k of LENGTH_KEYS) {
              if (rawBs[k] != null && rawBs[k] !== '') bodyStats[k] = readBodyStat(rawBs, k, wu, lu);
            }
            if (LENGTH_KEYS.some(k => k in bodyStats)) bodyStats.length_unit = lu;
            const result = {
              date: args.date, meals,
              totals: hasItems ? { calories: Math.round(totals.calories || 0), protein: Math.round(totals.proteins || 0), carbs: Math.round(totals.carbohydrates || 0), fat: Math.round(totals.fat || 0) } : null,
              body_stats: bodyStats,
              water_ml: (entry?.water || []).reduce((s, l) => s + (l.amount || 0), 0),
            };
            if (notes) result.day_notes = notes;
            if (Array.isArray(activities) && activities.length) {
              result.activities = activities.map(a => ({
                name: a.name,
                kcal: a.kcal,
                duration_min: a.duration_min,
                distance: a.distance,
                source: a.source,
              }));
            }
            return result;
          } catch { return { date: args.date, error: 'Could not load diary' }; }
        }
        case 'get_meals': {
          try {
            const [rawMeals, rawRecipes] = await Promise.all([
              NtApi.getMeals().catch(() => []),
              NtApi.getRecipes().catch(() => []),
            ]);
            const shape = (m, kind) => {
              const items = (m.items || []).map(it => {
                const r = { name: it.name, portion: it.portion, unit: it.unit, quantity: it.quantity };
                if (it.brand) r.brand = it.brand;
                if (typeof it.notes === 'string' && it.notes.trim()) r.notes = it.notes.trim();
                return r;
              });
              const totals = Nutrition.sum(items.map(i => Nutrition.calculate(i)));
              const out = {
                id: m.id, name: m.name, kind,
                item_count: items.length,
                calories: Math.round(totals.calories || 0),
                protein_g: Math.round(totals.proteins || 0),
                carbs_g: Math.round(totals.carbohydrates || 0),
                fat_g: Math.round(totals.fat || 0),
                items,
              };
              if (typeof m.notes === 'string' && m.notes.trim()) out.notes = m.notes.trim();
              return out;
            };
            const q = (args.query || '').toLowerCase().trim();
            let list = [
              ...rawMeals.map(m => shape(m, 'meal')),
              ...rawRecipes.map(m => shape(m, 'recipe')),
            ];
            if (q) list = list.filter(m => m.name?.toLowerCase().includes(q));
            return { count: list.length, meals: list.slice(0, 50) };
          } catch { return { error: 'Could not load meals library' }; }
        }
        case 'get_workouts': {
          let workouts;
          if (isNative) {
            try {
              const { dbGetWorkouts } = await import('../../lib/db-native.js');
              workouts = await dbGetWorkouts(args.from, args.to);
            } catch {}
          }
          if (!workouts) {
            try { workouts = await NtApi.get(`/api/wellness/fitbit/workouts?from=${args.from}&to=${args.to}`); }
            catch { workouts = []; }
          }
          // Convert distance to user's preferred unit
          const distUnit = DB.getSetting('distUnit', 'km');
          if (distUnit === 'mi') {
            for (const w of workouts) {
              if (w.distance_km != null) {
                w.distance_mi = Math.round(w.distance_km * 0.621371 * 100) / 100;
                delete w.distance_km;
              }
            }
          }
          return workouts;
        }
        case 'get_goals': {
          const g = goals.get();
          return g || {};
        }
        case 'get_diary_averages': {
          try {
            // Cap at 3650 days (10 years) as a guardrail against the AI
            // hallucinating an absurd number; with the bulk-fetch path below
            // the cost is bounded by actual diary size regardless of the
            // `days` argument, so any realistic NT user is covered. Was 90
            // pre-rc.38 which silently truncated long-history users (issue #44:
            // user imported 700+ days from MyFitnessPal, get_diary_averages
            // for 180/365 was returning days_logged=90 because of this cap).
            const numDays = Math.min(Math.max(parseInt(args.days) || 28, 1), 3650);
            // Build the date window: the previous numDays days, excluding today.
            const dates = new Set();
            for (let i = numDays; i >= 1; i--) {
              const d = new Date(); d.setDate(d.getDate() - i);
              dates.add(d.toISOString().slice(0, 10));
            }
            // Single bulk fetch instead of N per-date round trips. The server
            // returns every diary row for this user; we filter client-side.
            // For a 365-day query this is ONE HTTP call instead of 365 —
            // critical on Android server-connected mode.
            const allEntries = await NtApi.getAllDiary().catch(() => []);
            const sums    = { calories: 0, proteins: 0, carbohydrates: 0, fat: 0, water_ml: 0 };
            let daysLogged = 0;
            let firstWeight = null, lastWeight = null;
            const matching = (allEntries || []).filter(e => dates.has(e.date)).sort((a, b) => a.date.localeCompare(b.date));
            for (const entry of matching) {
              if (entry?.items?.length) {
                daysLogged++;
                const tot = Nutrition.sum(entry.items.map(i => Nutrition.calculate(i)));
                sums.calories       += tot.calories       || 0;
                sums.proteins       += tot.proteins       || 0;
                sums.carbohydrates  += tot.carbohydrates  || 0;
                sums.fat            += tot.fat            || 0;
                sums.water_ml       += (entry.water || []).reduce((s, l) => s + (l.amount || 0), 0);
                const bs = entry.body_stats || entry.bodyStats || {};
                // Force conversion to kg so diff arithmetic is unit-stable
                // even when the user toggled their display unit mid-period.
                const w  = readBodyStat(bs, 'weight', 'kg', 'in');
                if (w != null) { if (firstWeight == null) firstWeight = { date: entry.date, value: w }; lastWeight = { date: entry.date, value: w }; }
              }
            }
            if (daysLogged === 0) return { error: 'No diary data found for this period.' };
            const avg = k => Math.round(sums[k] / daysLogged);
            const result = {
              period_days: numDays,
              days_logged: daysLogged,
              consistency_pct: Math.round(daysLogged / numDays * 100),
              averages: {
                calories: avg('calories'),
                protein_g: avg('proteins'),
                carbs_g: avg('carbohydrates'),
                fat_g: avg('fat'),
                water_ml: avg('water_ml'),
              },
            };
            if (firstWeight && lastWeight && firstWeight.date !== lastWeight.date) {
              const _wu = DB.getSetting('weightUnit', 'lb');
              const diff = lastWeight.value - firstWeight.value;
              result.weight_change = {
                from_date: firstWeight.date,
                to_date: lastWeight.date,
                change_kg: Math.round(diff * 100) / 100,
                change_lbs: Math.round(diff * 2.20462 * 100) / 100,
                direction: diff < -0.1 ? 'down' : diff > 0.1 ? 'up' : 'stable',
              };
            }
            return result;
          } catch { return { error: 'Could not compute diary averages.' }; }
        }
        case 'get_logging_streak': {
          // Streak walk: from today (or yesterday if today not yet logged)
          // backward, counting consecutive days with ANY meaningful diary
          // content (food items OR water OR body stats OR notes), stopping
          // at the first gap. "Logging" matches the user's mental model of
          // "I opened the diary and recorded something" — earlier versions
          // only counted food items, which under-counted users who logged
          // water/weight/notes on days they didn't eat-log.
          //
          // Open-ended by design — cost is bounded by actual streak length,
          // not by user input. Single bulk diary fetch + Set lookup so even
          // a multi-year streak runs in ms.
          //
          // Diary keys are LOCAL-date strings (per localDateStr / how the
          // diary stores entries). Walk uses local-date formatting so that
          // users in UTC+12 / UTC-12 timezones don't get a one-day skew that
          // breaks the streak after step 1.
          //
          // Uses _aiFetchAllDiary so Android server-connected bypasses the
          // possibly-stale local SQLite cache and gets authoritative server
          // data — same reasoning as get_diary_averages.
          try {
            const all = await _aiFetchAllDiary();
            const hasContent = e => (e?.items?.length > 0)
              || (e?.water?.length > 0)
              || (e?.body_stats && Object.keys(e.body_stats).length > 0)
              || (e?.bodyStats && Object.keys(e.bodyStats).length > 0)
              || (typeof e?.notes === 'string' && e.notes.trim().length > 0);
            const logged = new Set((all || []).filter(hasContent).map(e => e.date));
            const today = localDateStr();
            // Don't penalize an ongoing day: if today isn't logged yet, walk
            // from yesterday. This matches every streak UX users expect
            // (Duolingo, Snapchat, etc.).
            const todayLogged = logged.has(today);
            const cursor = new Date();              // now (local)
            cursor.setHours(12, 0, 0, 0);            // anchor at noon so DST shifts can't push us off-day
            if (!todayLogged) cursor.setDate(cursor.getDate() - 1);
            let streak = 0;
            let streakStart = null;
            let streakEnd = null;
            const SANITY_CAP = 100000;   // > 270 years; only here to defeat clock pathologies
            while (streak < SANITY_CAP) {
              const ds = localDateStr(cursor);
              if (!logged.has(ds)) break;
              if (streakEnd == null) streakEnd = ds;
              streakStart = ds;
              streak++;
              cursor.setDate(cursor.getDate() - 1);
            }
            return {
              streak_days: streak,
              streak_start: streakStart,    // null when streak_days === 0
              streak_end: streakEnd,        // null when streak_days === 0
              today_logged: todayLogged,
              // Diagnostic context so the AI can sanity-check its answer
              // against the user's mental model (and we can debug if the
              // number disagrees with the diary they're looking at).
              total_logged_days_in_history: logged.size,
              earliest_logged_date: [...logged].sort()[0] || null,
              latest_logged_date: [...logged].sort().slice(-1)[0] || null,
            };
          } catch (e) { return { error: 'Could not compute streak: ' + (e?.message || String(e)) }; }
        }
        case 'get_fasting_history': {
          try {
            const days = Math.min(365, Math.max(1, parseInt(args.days) || 30));
            const { fastingStats } = await import('../../stores/fasting.js');
            const history = await NtApi.get(`/api/fasts?limit=${days}`).catch(() => []);
            const active  = await NtApi.get('/api/fasts/active').catch(() => null);
            const stats   = fastingStats(history, active && active.id ? active : null);
            return {
              active_fast: active && active.id ? {
                start_at: active.start_at,
                goal_hours: active.goal_hours,
                elapsed_hours: Math.round((Date.now() - new Date(active.start_at).getTime()) / 360000) / 10,
              } : null,
              stats,
              history: history.map(f => ({
                start_at: f.start_at,
                end_at: f.end_at,
                duration_hours: f.end_at ? Math.round((new Date(f.end_at) - new Date(f.start_at)) / 360000) / 10 : null,
                goal_hours: f.goal_hours,
                met_goal: f.end_at ? (new Date(f.end_at) - new Date(f.start_at)) / 3600000 >= (f.goal_hours || 16) : null,
              })),
            };
          } catch { return { error: 'Could not load fasting history.' }; }
        }
        case 'get_adaptive_tdee': {
          try {
            const r = await NtApi.get('/api/goals/adaptive-tdee');
            return r || { ready: false };
          } catch { return { ready: false, error: 'Could not load adaptive TDEE.' }; }
        }
        case 'get_activity_log': {
          try {
            const from = args.from, to = args.to;
            if (!from || !to) return { error: 'from and to dates required' };
            const list = await NtApi.getActivityRange(from, to);
            return Array.isArray(list) ? list : [];
          } catch { return []; }
        }
        case 'add_activity_entry': {
          // Permission + capability gates
          const showActivity   = DB.getSetting('diaryShowActivity', false);
          const autoEstimate   = DB.getSetting('activityAutoEstimate', false);
          if (!showActivity) {
            return { error: 'Activity logging is disabled. The user must turn on Settings → Diary → Show activity section before you can log activity.' };
          }
          const name = String(args?.name || '').trim();
          if (!name) return { error: 'Activity name required.' };
          let kcal = args?.kcal != null ? Math.max(0, Math.round(Number(args.kcal))) : 0;
          const source = args?.source === 'ai_estimated' ? 'ai_estimated' : (args?.source === 'user_stated' ? 'user_stated' : 'manual_form');
          // If AI is trying to estimate without a number, gate on autoEstimate + profile
          if (!kcal && source === 'ai_estimated') {
            if (!autoEstimate) {
              return { error: 'Auto-estimation is off. Ask the user for a calorie number, or have them enable Settings → AI Assistant → Estimate activity calories.' };
            }
            const w = Number(DB.getSetting('weight_kg', 0));
            const h = Number(DB.getSetting('height_cm', 0));
            const dob = DB.getSetting('dob', '');
            const sex = DB.getSetting('gender', '');
            if (!w || !h || !dob || !sex) {
              return { error: 'Cannot estimate — missing body profile fields. Ask the user to fill in weight, height, date of birth, and sex on their profile, or supply a calorie number directly.' };
            }
            // Caller (the AI) is expected to compute kcal itself given duration_min and an
            // appropriate MET, then pass it back as kcal. We refuse to log a 0 here.
            return { error: 'Estimation needs a non-zero kcal value. Compute kcal from duration + MET × body weight and call again with kcal set.' };
          }
          if (!kcal) return { error: 'kcal must be a positive integer.' };
          const date = (typeof args?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(args.date)) ? args.date : localDateStr();
          try {
            const { addActivity } = await import('../../stores/activity.js');
            await addActivity({
              date, name, kcal,
              duration_min: args?.duration_min != null ? Math.max(0, Math.round(Number(args.duration_min))) : null,
              distance: typeof args?.distance === 'string' ? args.distance.trim().slice(0, 40) || null : null,
              source,
            });
            return { ok: true, date, name, kcal, source };
          } catch (e) {
            return { error: 'Failed to save activity: ' + (e?.message || String(e)) };
          }
        }
        case 'log_quick_calories': {
          // Permission gate — same shape as add_activity_entry: feature must
          // be on before the AI can log. Default is ON so this rarely trips
          // for normal users; explicit opt-out users get a clear error.
          const enabled = DB.getSetting('showQuickCalories', true);
          if (!enabled) {
            return { error: 'Quick Calories logging is disabled. The user must turn on Settings → Diary → Show Quick Calories Button before you can log a quick entry.' };
          }
          const kcal = args?.kcal != null ? Math.max(0, Math.round(Number(args.kcal))) : 0;
          if (!kcal) return { error: 'kcal must be a positive integer.' };
          const mealIdx = args?.meal != null ? Math.max(0, Math.min(3, Math.round(Number(args.meal)))) : 3;
          const name = typeof args?.name === 'string' ? args.name.trim().slice(0, 60) : '';
          const date = (typeof args?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(args.date)) ? args.date : localDateStr();
          // Optional macros from MFP-style asks. Only pass values that were
          // explicitly supplied; the store helper drops any non-positive
          // value so blank/zero stays blank in the diary item.
          const optMacro = v => {
            if (v == null) return undefined;
            const n = Number(v);
            return Number.isFinite(n) && n > 0 ? n : undefined;
          };
          const proteins      = optMacro(args?.protein_g);
          const carbohydrates = optMacro(args?.carbs_g);
          const fat           = optMacro(args?.fat_g);
          try {
            const { addQuickCalories } = await import('../../stores/diary.js');
            await addQuickCalories({ kcal, name, meal: mealIdx, date, proteins, carbohydrates, fat });
            return { ok: true, date, meal: mealIdx, kcal, name: name || 'Quick Calories', protein_g: proteins ?? null, carbs_g: carbohydrates ?? null, fat_g: fat ?? null };
          } catch (e) {
            return { error: 'Failed to log quick calories: ' + (e?.message || String(e)) };
          }
        }
        default:
          return { error: `Unknown tool: ${name}` };
      }
    });

    // ── Cross-device chat sync ──────────────────────────────────────────────
    // 1. nt:chat-updated — fired by native sync engine after pull, carries new rows
    // 2. nt:sync-complete — safety net; full refetch catches deletes or missed rows
    // 3. visibilitychange — PWA refetches when the tab regains focus
    window.addEventListener('nt:chat-updated',  _onChatUpdated);
    window.addEventListener('nt:sync-complete', _refetchChatHistory);
    document.addEventListener('visibilitychange', _onVisible);
  });

  onDestroy(() => {
    window.removeEventListener('nt:chat-updated',  _onChatUpdated);
    window.removeEventListener('nt:sync-complete', _refetchChatHistory);
    document.removeEventListener('visibilitychange', _onVisible);
  });

  // AI tools need the FULL diary table, not just the locally-cached subset.
  // On Android server-connected, NtApi.getAllDiary() reads only the local
  // SQLite mirror (populated by the differential sync, which uses
  // updated_at >= last_pull and omits historical rows that haven't been
  // touched recently). That made get_logging_streak return short streaks
  // and get_diary_averages report under-counted days_logged even after the
  // #44 cap raise. AI tools are one-shot, can afford a direct HTTP fetch.
  async function _aiFetchAllDiary() {
    if (isNative && getServerUrl()) {
      try {
        const token = getAuthToken();
        const res = await fetch(apiUrl('/api/diary'), {
          headers: token ? { 'Authorization': `Bearer ${token}` } : {},
          credentials: 'include',
        });
        if (res.ok) return await res.json();
      } catch {}
      // Fall through to local cache on network failure so the AI can still
      // answer offline, just with the possibly-stale cached set.
    }
    return await NtApi.getAllDiary().catch(() => []);
  }

  function _onVisible() {
    if (document.visibilityState === 'visible') _refetchChatHistory();
  }

  // Merge incoming rows from sync pull; dedupe by role+content+created_at
  function _onChatUpdated(e) {
    const rows = e.detail?.messages || [];
    if (!rows.length) return;
    const seen = new Set(messages.map(m => `${m.role}|${m.content}|${m.time}`));
    const toAdd = rows
      .map(r => ({ role: r.role, content: r.content, time: _fmtCreatedAt(r.created_at) }))
      .filter(m => !seen.has(`${m.role}|${m.content}|${m.time}`));
    if (!toAdd.length) return;
    messages = [...messages, ...toAdd];
    if (!panelOpen) hasUnread = true;
    tick().then(() => _scrollBottom(true));
  }

  async function _refetchChatHistory() {
    try {
      const rows = await NtApi.get('/api/ai/history');
      if (!Array.isArray(rows)) return;
      const next = rows.map(r => ({ role: r.role, content: r.content, time: _fmtCreatedAt(r.created_at) }));
      // Only update if the list actually changed (length or last message differs)
      const changed = next.length !== messages.length
        || (next.length && messages.length && next[next.length - 1].content !== messages[messages.length - 1].content);
      if (!changed) return;
      // Compare against persisted seen count — not in-memory messages.length
      // (which resets to 0 on component remount, causing false unread dots)
      const seenCount = parseInt(localStorage.getItem('nt:chatSeenCount') || '0');
      const hasNew = next.length > seenCount;
      messages = next;
      if (hasNew && !panelOpen) hasUnread = true;
      tick().then(() => _scrollBottom(true));
    } catch {}
  }

  function _fmtCreatedAt(iso) {
    if (!iso) return fmtTime();
    const d       = new Date(iso + 'Z');
    const timeStr = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: $timeFormat !== '24h' });
    // Compare date portion in local time
    const msgDate = d.toLocaleDateString('sv-SE'); // reliable YYYY-MM-DD in local tz
    if (msgDate === localDateStr()) return timeStr;
    // Older message — prefix with date in user's preferred format
    const fmt = dateFormat.get() || 'ISO';
    const mo  = String(d.getMonth() + 1).padStart(2, '0');
    const dy  = String(d.getDate()).padStart(2, '0');
    const y   = d.getFullYear();
    const dateLabel = fmt === 'US' ? `${mo}/${dy}` : fmt === 'EU' ? `${dy}/${mo}` : `${y}-${mo}-${dy}`;
    return `${dateLabel} · ${timeStr}`;
  }

  // ── Draggable FAB ──────────────────────────────────────────────────────────
  /** Saved position: { x, y } from top-left, or null → use CSS default (bottom-right) */
  function _clampFabPos(pos) {
    // Returns null for missing or unrecoverable positions (FAB falls back to CSS
    // default: bottom-right). Without this, a position saved at a wider viewport
    // could render off-screen on a smaller monitor and a hard refresh won't help.
    if (!pos || typeof window === 'undefined') return null;
    const maxX = window.innerWidth  - 64;
    const maxY = window.innerHeight - 64;
    if (maxX < 8 || maxY < 8) return null;
    return {
      x: Math.max(8, Math.min(maxX, pos.x)),
      y: Math.max(8, Math.min(maxY, pos.y)),
    };
  }
  let fabPos    = (() => {
    try {
      const saved = JSON.parse(localStorage.getItem('wl:aiFabPos') || 'null');
      const clamped = _clampFabPos(saved);
      if (clamped && saved && (clamped.x !== saved.x || clamped.y !== saved.y)) {
        localStorage.setItem('wl:aiFabPos', JSON.stringify(clamped));
      }
      return clamped;
    } catch { return null; }
  })();
  let hasDragged = false;

  $: fabStyle = fabPos
    ? `left:${fabPos.x}px; top:${fabPos.y}px; right:auto; bottom:auto;`
    : '';

  // ── Desktop panel positioning — follows the FAB ────────────────────────────
  // On desktop (>768px), the chat card pops up next to wherever the FAB sits.
  // Recomputed each time the panel opens or the window resizes.
  let panelStyle = '';
  let _isDesktop = false;
  function _updatePanelPos() {
    if (typeof window === 'undefined') return;
    // Re-clamp the FAB on resize — keeps it visible when the viewport shrinks
    // (window resize, monitor swap). Persist the clamped value so the next load
    // doesn't have to re-clamp from the same stale data.
    if (fabPos) {
      const clamped = _clampFabPos(fabPos);
      if (!clamped || clamped.x !== fabPos.x || clamped.y !== fabPos.y) {
        fabPos = clamped;
        try {
          if (clamped) localStorage.setItem('wl:aiFabPos', JSON.stringify(clamped));
          else localStorage.removeItem('wl:aiFabPos');
        } catch {}
      }
    }
    _isDesktop = window.innerWidth > 768;
    if (!_isDesktop || !panelOpen) { panelStyle = ''; return; }

    const cardW = 420;
    const cardH = Math.min(640, window.innerHeight * 0.8);
    const gap = 16;
    const margin = 16;
    const FAB_SIZE = 60;

    // FAB rect — derived from saved pos or the CSS default (bottom-right)
    const fabLeft = fabPos ? fabPos.x : window.innerWidth - 20 - FAB_SIZE;
    const fabTop  = fabPos ? fabPos.y : window.innerHeight - 96 - FAB_SIZE;
    const fabRight  = fabLeft + FAB_SIZE;
    const fabBottom = fabTop + FAB_SIZE;
    const fabCenterX = fabLeft + FAB_SIZE / 2;
    const fabCenterY = fabTop  + FAB_SIZE / 2;

    // Quadrant determines where the card grows from
    const onRight  = fabCenterX > window.innerWidth  / 2;
    const onBottom = fabCenterY > window.innerHeight / 2;

    // Card top-left
    let left = onRight ? (fabRight - cardW) : fabLeft;
    let top  = onBottom ? (fabTop - cardH - gap) : (fabBottom + gap);

    // Clamp inside viewport
    left = Math.max(margin, Math.min(window.innerWidth  - cardW - margin, left));
    top  = Math.max(margin, Math.min(window.innerHeight - cardH - margin, top));

    panelStyle = `left:${left}px; top:${top}px; right:auto; bottom:auto;`;
  }
  $: { panelOpen, fabPos; _updatePanelPos(); }
  if (typeof window !== 'undefined') {
    window.addEventListener('resize', _updatePanelPos);
  }

  // ── Hold-to-record (Smart Log via Trace FAB) ───────────────────────────────
  // Press the FAB and hold for 700ms → robot face morphs to mic, FAB turns
  // red, beep + haptic fire, native speech recognition starts. Release ends
  // recording and runs Smart Log. Move finger before 700ms → drag mode
  // (existing behavior). Slide finger > CANCEL_RADIUS_PX away from the FAB
  // while recording → cancel preview (FAB greys out). Release in cancel
  // preview = abort. Release on FAB = commit.
  let recordingMode = false;       // true while holding past threshold
  let cancelPreview = false;       // true if finger has slid off the button
  let recordingStartedAt = 0;
  const HOLD_THRESHOLD_MS = 700;   // bumped from 400 — well above natural hold-to-drag
  const CANCEL_RADIUS_PX = 100;    // slide further than this from FAB center to cancel
  let holdTimer = null;
  let _fabCenterX = 0;             // captured at pointerdown for cancel-preview math
  let _fabCenterY = 0;
  // Smart Log modal state — mounted globally from this component when a hold
  // recording produces parsed items. Lives here so the gesture works on every
  // page (not just Diary).
  let showSmartLog = false;
  let smartLogPreParsed = null;     // [{ item, candidates, best, source }, ...]
  let smartLogMeal = null;
  let smartLogText = '';

  async function _hapticBuzz(style = 'medium') {
    if (!isNative) return;
    try {
      const { Haptics, ImpactStyle } = await import('@capacitor/haptics');
      const map = { light: ImpactStyle.Light, medium: ImpactStyle.Medium, heavy: ImpactStyle.Heavy };
      await Haptics.impact({ style: map[style] || ImpactStyle.Medium });
    } catch {}
  }

  // ── Web Audio beep generator (gated by barcodeBeep setting) ───────────
  // Generates a short tone via the AudioContext API — no asset files needed.
  // Reuses the barcodeBeep setting since it's the same "audio confirmation"
  // category; users who muted barcode scans usually don't want voice beeps.
  let _audioCtx = null;
  function _beep(frequency, durationMs) {
    try {
      if (!DB.getSetting('barcodeBeep', true)) return;
      if (!_audioCtx) {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        _audioCtx = new Ctx();
      }
      const ctx = _audioCtx;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = frequency;
      osc.type = 'sine';
      // Quick attack/decay envelope to avoid clicks
      const now = ctx.currentTime;
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.18, now + 0.012);
      gain.gain.linearRampToValueAtTime(0, now + (durationMs / 1000));
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + (durationMs / 1000) + 0.02);
    } catch {}
  }

  // Track whether the user actually wants the transcript processed.
  // _stopRecording sets this to false on cancel; the speech result handlers
  // check it before running the parser.
  let _commitNextTranscript = false;

  async function _startRecording() {
    if (!$quickLogEnabled) return;
    recordingMode = true;
    cancelPreview = false;
    recordingStartedAt = Date.now();
    _commitNextTranscript = true;
    _hapticBuzz('medium');
    _beep(1000, 80); // start beep — high tone
    if (isNative) {
      try {
        const { SpeechRecognition } = await import('@capacitor-community/speech-recognition');
        const perm = await SpeechRecognition.checkPermissions();
        if (perm.speechRecognition !== 'granted') {
          const req = await SpeechRecognition.requestPermissions();
          if (req.speechRecognition !== 'granted') {
            recordingMode = false;
            showError('Microphone permission denied — Smart Log voice needs mic access');
            return;
          }
        }
        // Note: native plugin's start() is blocking until the user stops
        // speaking OR we call stop(). We don't await it here — we kick it off
        // and let the pointerup handler stop it and process the result.
        SpeechRecognition.start({
          language: navigator.language || 'en-US',
          maxResults: 1,
          partialResults: false,
          popup: false,
          prompt: 'Tell me what you ate',
        }).then(async (result) => {
          // Result returns when stop() is called OR speech ends naturally.
          // Skip processing if the user cancelled by sliding off the FAB.
          if (!_commitNextTranscript) return;
          const transcript = (result?.matches && result.matches[0]) || '';
          if (transcript) {
            await _processTranscript(transcript);
          } else {
            showError("Didn't catch that — try again");
          }
        }).catch((e) => {
          console.warn('[trace-hold] native voice failed:', e?.message);
          showError('Voice recognition failed: ' + (e?.message || 'unknown error'));
        });
      } catch (e) {
        console.warn('[trace-hold] plugin unavailable:', e?.message);
        recordingMode = false;
        showError('Voice plugin unavailable');
      }
    } else {
      // PWA: Web Speech API
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SR) {
        recordingMode = false;
        showError('Voice input not supported in this browser');
        return;
      }
      try {
        const rec = new SR();
        rec.continuous = false;
        rec.interimResults = false;
        rec.lang = navigator.language || 'en-US';
        rec.onresult = async (e) => {
          if (!_commitNextTranscript) return;
          const transcript = e.results[0]?.[0]?.transcript || '';
          if (transcript) {
            await _processTranscript(transcript);
          } else {
            showError("Didn't catch that — try again");
          }
        };
        rec.onerror = (e) => {
          console.warn('[trace-hold] web voice error:', e.error);
          if (_commitNextTranscript) showError('Voice error: ' + (e.error || 'unknown'));
        };
        rec.onend = () => {
          // Fired even on success — but if we never got a result and
          // commit was expected, surface the silent failure.
          if (_commitNextTranscript && !recordingMode) {
            // recordingMode is already false at this point if user released;
            // a separate flag would be needed to detect "no result fired"
            // — leaving this as a hook for future refinement.
          }
        };
        window.__traceHoldRec = rec;
        rec.start();
      } catch (e) {
        console.warn('[trace-hold] web speech start failed:', e.message);
        recordingMode = false;
        showError('Could not start mic: ' + e.message);
      }
    }
  }

  async function _stopRecording(commit) {
    if (!recordingMode) return;
    recordingMode = false;
    cancelPreview = false;
    // Removed the heldFor < 600ms cancel rule — it was hostile to fast
    // utterances ("eggs" said in 400ms got dropped). Cancel only if the
    // user explicitly slid off the FAB before releasing.
    if (!commit) {
      _commitNextTranscript = false;
    }
    _hapticBuzz('light');
    _beep(commit ? 600 : 350, 80); // end beep — lower for commit, lowest for cancel
    if (isNative) {
      try {
        const { SpeechRecognition } = await import('@capacitor-community/speech-recognition');
        await SpeechRecognition.stop();
      } catch {}
    } else if (window.__traceHoldRec) {
      try { commit ? window.__traceHoldRec.stop() : window.__traceHoldRec.abort(); } catch {}
      window.__traceHoldRec = null;
    }
  }

  async function _processTranscript(text) {
    if (!text || !text.trim()) {
      showError("Didn't catch that — try again");
      return;
    }
    smartLogText = text;
    try {
      const { parseInput, matchItems } = await import('../../lib/quick-log.js');
      const userMealNames = (await import('../../stores/settings.js')).mealNames;
      let names;
      userMealNames.subscribe(v => names = v)();
      const parsed = await parseInput(text, names || ['Breakfast','Lunch','Dinner','Snacks']);
      if (!parsed.items || parsed.items.length === 0) {
        console.warn('[trace-hold] no items parsed from:', text);
        showError(`Couldn't find any food in "${text}"`);
        return;
      }
      const matches = await matchItems(parsed.items);
      smartLogPreParsed = matches;
      smartLogMeal = parsed.meal;
      showSmartLog = true;
    } catch (e) {
      console.error('[trace-hold] parse failed:', e);
      showError('Smart Log parse failed: ' + (e.message || 'unknown error'));
    }
  }

  // ── Drag (existing behavior, plus hold detection + slide-off cancel) ──────
  function startDrag(e) {
    hasDragged = false;
    const startX   = e.clientX;
    const startY   = e.clientY;
    const baseX = fabPos ? fabPos.x : window.innerWidth  - 76;
    const baseY = fabPos ? fabPos.y : window.innerHeight - 160;

    // Capture FAB center for cancel-preview math (used when recording).
    // The current target is the .ai-fab div; getBoundingClientRect gives us
    // the live rect even if the FAB has moved via drag.
    const fabEl = e.currentTarget;
    if (fabEl && fabEl.getBoundingClientRect) {
      const r = fabEl.getBoundingClientRect();
      _fabCenterX = r.left + r.width / 2;
      _fabCenterY = r.top + r.height / 2;
    }

    // Start hold-to-record timer in parallel with drag detection.
    // Only if Smart Log is enabled — otherwise the FAB is tap-only + drag.
    if ($quickLogEnabled && $aiEffectivelyEnabled) {
      holdTimer = setTimeout(() => {
        // Threshold passed without significant movement → enter recording mode
        if (!hasDragged) {
          _startRecording();
        }
      }, HOLD_THRESHOLD_MS);
    }

    function move(ev) {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      // Only enter drag mode if the user moved BEFORE recording started.
      // Once recording is active, finger movement is for cancel-preview, not drag.
      if (!recordingMode && !hasDragged && (Math.abs(dx) > 6 || Math.abs(dy) > 6)) {
        hasDragged = true;
        // Cancel pending hold-to-record — user is dragging
        if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
      }
      if (hasDragged) {
        fabPos = {
          x: Math.max(8, Math.min(window.innerWidth  - 64, baseX + dx)),
          y: Math.max(8, Math.min(window.innerHeight - 64, baseY + dy)),
        };
        return;
      }
      // While recording, check distance from FAB center to detect cancel preview
      if (recordingMode) {
        const fdx = ev.clientX - _fabCenterX;
        const fdy = ev.clientY - _fabCenterY;
        const dist = Math.sqrt(fdx * fdx + fdy * fdy);
        const shouldCancel = dist > CANCEL_RADIUS_PX;
        if (shouldCancel !== cancelPreview) {
          cancelPreview = shouldCancel;
          if (shouldCancel) _hapticBuzz('light');
        }
      }
    }
    function up() {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup',   up);
      window.removeEventListener('pointercancel', cancel);
      if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
      if (hasDragged) {
        localStorage.setItem('wl:aiFabPos', JSON.stringify(fabPos));
      } else if (recordingMode) {
        // Commit unless the finger is currently in cancel-preview territory
        _stopRecording(!cancelPreview);
      }
    }
    function cancel() {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup',   up);
      window.removeEventListener('pointercancel', cancel);
      if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
      if (recordingMode) _stopRecording(false);
    }
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup',   up);
    window.addEventListener('pointercancel', cancel);
  }

  function handleFabClick() {
    // Tap = open chat panel. If a recording fired (hasDragged is false but
    // recordingMode was true at any point during this gesture), the panel
    // does NOT open — the click event still fires after pointerup but we
    // suppress it via recordingMode check at click time.
    if (hasDragged) return;
    if (recordingMode) return; // shouldn't happen — recordingMode is reset in _stopRecording
    panelOpen = !panelOpen;
  }

  // ── Chat ───────────────────────────────────────────────────────────────────
  async function buildContext() {
    const today  = localDateStr();
    const entry  = await NtApi.getDiaryDate(today).catch(() => null);
    const g      = goals.get();
    const mNames = mealNames.get();
    const eUnit  = energyUnit.get();
    // Prefer nickname → full_name. Skip the synthetic 'Local User' default
    // and the 'local' username so we don't tell the AI to greet someone by
    // a placeholder. Falls back to the localUserName setting (PWA single-
    // user / native standalone write to that key directly).
    const u       = $currentUser || {};
    const _nick   = (u.nickname || '').trim() || (DB.getSetting('localUserNickname', '') || '').trim();
    const _full   = (u.full_name || '').trim() || (DB.getSetting('localUserName', '') || '').trim();
    const _name   = (_full && _full !== 'Local User') ? _full : '';
    const userName = _nick || _name || '';

    // Profile fields the AI should always have at hand without a tool call.
    // Pull from $currentUser first (server-backed), fall back to settings
    // (single-user / standalone). Compute age from dob when present.
    const _dob    = u.birthday || DB.getSetting('dob', '') || '';
    const _gender = u.gender   || DB.getSetting('gender', '') || '';
    let _age = null;
    if (_dob) {
      const ms = Date.now() - new Date(_dob).getTime();
      const a  = Math.floor(ms / (365.25 * 24 * 3600 * 1000));
      if (a > 0 && a < 130) _age = a;
    }
    const _hCm = Number(DB.getSetting('height_cm',     null)) || null;
    const _wKg = Number(DB.getSetting('weight_kg',     null)) || null;
    const _tKg = Number(DB.getSetting('target_weight', null)) || null;
    const _act = DB.getSetting('activity', '') || '';
    const _wu = DB.getSetting('weightUnit', 'lb');
    const _hu = DB.getSetting('heightUnit', 'ft');
    const _fmtW = (kg) => kg == null ? null : (_wu === 'lb' ? `${(kg*2.20462).toFixed(1)} lb` : `${kg.toFixed(1)} kg`);
    const _fmtH = (cm) => {
      if (cm == null) return null;
      if (_hu === 'cm') return `${cm} cm`;
      const totalIn = cm / 2.54;
      const ft = Math.floor(totalIn / 12);
      const inches = Math.round(totalIn - ft * 12);
      return `${ft}'${inches}"`;
    };
    const profileBits = [];
    if (_full)              profileBits.push(`name: ${_full}`);
    if (_nick && _nick !== _full) profileBits.push(`nickname: ${_nick}`);
    if (_age != null)       profileBits.push(`age: ${_age}`);
    if (_dob)               profileBits.push(`dob: ${_dob}`);
    if (_gender)            profileBits.push(`gender: ${_gender}`);
    if (_fmtH(_hCm))        profileBits.push(`height: ${_fmtH(_hCm)}`);
    if (_fmtW(_wKg))        profileBits.push(`weight: ${_fmtW(_wKg)}`);
    if (_fmtW(_tKg))        profileBits.push(`target weight: ${_fmtW(_tKg)}`);
    if (_act)               profileBits.push(`activity level: ${_act}`);
    const profileText = profileBits.join(', ');

    let diaryText = 'No food logged today yet.';
    if (entry && entry.items?.length) {
      const tot  = Nutrition.sum(entry.items.map(i => Nutrition.calculate(i)));
      diaryText  = `Totals: ${Math.round(tot.calories||0)} ${eUnit}, `
                 + `${Math.round(tot.proteins||0)}g protein, `
                 + `${Math.round(tot.carbohydrates||0)}g carbs, `
                 + `${Math.round(tot.fat||0)}g fat.\n`;
      const byMeal = {};
      for (const it of entry.items) {
        const m = it.meal ?? 0;
        (byMeal[m] = byMeal[m] || []).push(it);
      }
      for (const [mIdx, items] of Object.entries(byMeal)) {
        const mName = mNames[Number(mIdx)] || `Meal ${Number(mIdx)+1}`;
        diaryText += `${mName}: ${items.map(i => `${i.name} (${i.portion||100}${i.unit||'g'})`).join(', ')}\n`;
      }
    }

    const calGoal  = g.calories?.max        ?? g.calories?.min;
    const proGoal  = g.proteins?.max        ?? g.proteins?.min;
    const carbGoal = g.carbohydrates?.max   ?? g.carbohydrates?.min;
    const fatGoal  = g.fat?.max             ?? g.fat?.min;
    let goalsText  = 'No goals set.';
    if (calGoal || proGoal || carbGoal || fatGoal) {
      goalsText = [
        calGoal  && `Calories: ${calGoal} ${eUnit}`,
        proGoal  && `Protein: ${proGoal}g`,
        carbGoal && `Carbs: ${carbGoal}g`,
        fatGoal  && `Fat: ${fatGoal}g`,
      ].filter(Boolean).join(', ');
    }

    let statsText = '';
    const bs = entry?.bodyStats || entry?.body_stats || {};
    const _wuStat = DB.getSetting('weightUnit', 'lb');
    const _luStat = DB.getSetting('lengthUnit', 'in');
    const bsParts = [];
    const _w = readBodyStat(bs, 'weight', _wuStat, _luStat);
    if (_w != null) bsParts.push(`Weight: ${_w} ${_wuStat}`);
    if (bs.body_fat) bsParts.push(`Body fat: ${bs.body_fat}%`);
    if (bsParts.length) statsText = bsParts.join(', ');

    // Water intake
    const waterMl   = (entry?.water || []).reduce((s, l) => s + (l.amount || 0), 0);
    const waterText  = waterMl > 0 ? `${(waterMl / 1000).toFixed(2)} L (${Math.round(waterMl)} ml)` : 'None logged';

    // Wellness data — Fitbit + Garmin + Withings, best-effort, silent on failure
    let wellnessText = '';
    try {
      const fitbitRes = await NtApi.get(`/api/wellness/fitbit/data?date=${today}`);
      const fd = fitbitRes[today];
      if (fd) {
        const parts = [];
        if (fd.steps != null)                parts.push(`Steps: ${Math.round(fd.steps).toLocaleString()}`);
        if (fd.active_minutes != null)        parts.push(`Active minutes: ${Math.round(fd.active_minutes)}`);
        if (fd.active_zone_minutes != null)   parts.push(`Active zone min: ${Math.round(fd.active_zone_minutes)}`);
        if (fd.calories_out != null)          parts.push(`Calories burned: ${Math.round(fd.calories_out)}`);
        if (fd.floors != null)                parts.push(`Floors: ${Math.round(fd.floors)}`);
        if (fd.distance_km != null) {
          const _du = DB.getSetting('distUnit', 'km');
          parts.push(`Distance: ${_du === 'mi' ? (fd.distance_km * 0.621371).toFixed(2) + ' mi' : fd.distance_km.toFixed(2) + ' km'}`);
        }
        if (fd.sleep_duration_min != null)    { const h = Math.floor(fd.sleep_duration_min/60); parts.push(`Sleep: ${h}h ${Math.round(fd.sleep_duration_min%60)}m`); }
        if (fd.sleep_efficiency != null)      parts.push(`Sleep efficiency: ${fd.sleep_efficiency.toFixed(0)}%`);
        if (fd.sleep_score != null)           parts.push(`Sleep score: ${Math.round(fd.sleep_score)}/100`);
        if (fd.resting_hr != null)            parts.push(`Resting HR: ${Math.round(fd.resting_hr)} bpm`);
        if (fd.hrv_daily_rmssd != null)       parts.push(`HRV: ${fd.hrv_daily_rmssd.toFixed(1)} ms`);
        if (fd.spo2_avg != null)              parts.push(`SpO2: ${fd.spo2_avg.toFixed(1)}%`);
        if (fd.respiratory_rate != null)      parts.push(`Respiratory rate: ${fd.respiratory_rate.toFixed(1)} brpm`);
        if (fd.vo2_max != null)               parts.push(`Cardio fitness (VO2 Max): ${fd.vo2_max.toFixed(1)} mL/kg/min`);
        if (fd.skin_temp_variation != null) {
          const isFahr = $tempUnit !== 'C';
          const tv = isFahr ? fd.skin_temp_variation * 9 / 5 : fd.skin_temp_variation;
          parts.push(`Skin temp variation: ${tv >= 0 ? '+' : ''}${tv.toFixed(2)}${isFahr ? '°F' : '°C'}`);
        }
        if (fd.sleep_deep_min != null)       parts.push(`Deep sleep: ${Math.round(fd.sleep_deep_min)} min`);
        if (fd.sleep_light_min != null)      parts.push(`Light sleep: ${Math.round(fd.sleep_light_min)} min`);
        if (fd.sleep_rem_min != null)        parts.push(`REM sleep: ${Math.round(fd.sleep_rem_min)} min`);
        if (fd.sleep_wake_min != null)       parts.push(`Awake: ${Math.round(fd.sleep_wake_min)} min`);
        if (fd.readiness_score != null)     parts.push(`Daily readiness: ${Math.round(fd.readiness_score)}/100`);
        if (fd.stress_score != null)        parts.push(`Stress management: ${Math.round(fd.stress_score)}/100`);
        if (parts.length) wellnessText += `Fitbit: ${parts.join(', ')}`;
      }
    } catch {}
    // Workouts today
    try {
      const workouts = await NtApi.get(`/api/wellness/fitbit/workouts?date=${today}`);
      if (workouts?.length) {
        const wParts = workouts.map(w => {
          let s = w.activity_name;
          const details = [];
          if (w.duration_ms) details.push(`${Math.round(w.duration_ms/60000)} min`);
          if (w.distance_km) {
            const _du = DB.getSetting('distUnit', 'km');
            details.push(`${_du === 'mi' ? (w.distance_km * 0.621371).toFixed(2) + ' mi' : w.distance_km.toFixed(2) + ' km'}`);
          }
          if (w.calories) {
            const _e = Nutrition.displayEnergy(w.calories, $energyUnit);
            details.push(`${_e.value} ${_e.unit}`);
          }
          if (w.avg_hr) details.push(`avg HR ${w.avg_hr} bpm`);
          if (w.max_hr) details.push(`max HR ${w.max_hr} bpm`);
          if (w.steps) details.push(`${w.steps.toLocaleString()} steps`);
          if (w.has_gps) details.push('GPS route recorded');
          if (details.length) s += ` (${details.join(', ')})`;
          return s;
        });
        wellnessText += (wellnessText ? '\n' : '') + `Workouts today: ${wParts.join('; ')}`;
      }
    } catch {}
    try {
      const garminRes = await NtApi.get(`/api/wellness/garmin/data?date=${today}`);
      const gd = garminRes[today];
      if (gd) {
        const parts = [];
        if (gd.steps != null)                parts.push(`Steps: ${Math.round(gd.steps).toLocaleString()}`);
        if (gd.active_minutes != null)        parts.push(`Active minutes: ${Math.round(gd.active_minutes)}`);
        if (gd.calories_out != null)          parts.push(`Calories burned: ${Math.round(gd.calories_out)}`);
        if (gd.distance_km != null) {
          const _du = DB.getSetting('distUnit', 'km');
          parts.push(`Distance: ${_du === 'mi' ? (gd.distance_km * 0.621371).toFixed(2) + ' mi' : gd.distance_km.toFixed(2) + ' km'}`);
        }
        if (gd.sleep_duration_min != null)    { const h = Math.floor(gd.sleep_duration_min/60); parts.push(`Sleep: ${h}h ${Math.round(gd.sleep_duration_min%60)}m`); }
        if (gd.sleep_score != null)           parts.push(`Sleep score: ${Math.round(gd.sleep_score)}/100`);
        if (gd.resting_hr != null)            parts.push(`Resting HR: ${Math.round(gd.resting_hr)} bpm`);
        if (gd.hrv_daily_rmssd != null)       parts.push(`HRV: ${gd.hrv_daily_rmssd.toFixed(1)} ms`);
        if (gd.spo2_avg != null)              parts.push(`SpO2: ${gd.spo2_avg.toFixed(1)}%`);
        if (gd.body_battery_high != null)     parts.push(`Body battery peak: ${Math.round(gd.body_battery_high)}`);
        if (gd.body_battery_low != null)      parts.push(`Body battery low: ${Math.round(gd.body_battery_low)}`);
        if (gd.stress_avg != null)            parts.push(`Avg stress: ${Math.round(gd.stress_avg)}/100`);
        if (gd.max_hr != null)                parts.push(`Max HR: ${Math.round(gd.max_hr)} bpm`);
        if (gd.moderate_intensity_min != null) parts.push(`Moderate intensity: ${Math.round(gd.moderate_intensity_min)} min`);
        if (gd.vigorous_intensity_min != null) parts.push(`Vigorous intensity: ${Math.round(gd.vigorous_intensity_min)} min`);
        if (gd.sleep_deep_min != null)        parts.push(`Deep sleep: ${Math.round(gd.sleep_deep_min)} min`);
        if (gd.sleep_rem_min != null)         parts.push(`REM sleep: ${Math.round(gd.sleep_rem_min)} min`);
        if (gd.respiratory_rate != null)      parts.push(`Respiratory rate: ${gd.respiratory_rate.toFixed(1)} brpm`);
        if (parts.length) wellnessText += (wellnessText ? '\n' : '') + `Garmin: ${parts.join(', ')}`;
      }
    } catch {}
    try {
      const withingsRes = await NtApi.get(`/api/wellness/withings/data?date=${today}`);
      const wd = withingsRes[today];
      if (wd) {
        const parts = [];
        const _wu = DB.getSetting('weightUnit', 'lb');
        const _wFmt = (kg) => _wu === 'lb' ? (kg * 2.20462).toFixed(1) + ' lbs' : kg.toFixed(1) + ' kg';
        if (wd.weight_kg?.value != null)      parts.push(`Weight: ${_wFmt(wd.weight_kg.value)}`);
        if (wd.body_fat_pct?.value != null)    parts.push(`Body fat: ${wd.body_fat_pct.value.toFixed(1)}%`);
        if (wd.muscle_mass_kg?.value != null)  parts.push(`Muscle mass: ${_wFmt(wd.muscle_mass_kg.value)}`);
        if (wd.bone_mass_kg?.value != null)    parts.push(`Bone mass: ${_wu === 'lb' ? (wd.bone_mass_kg.value * 2.20462).toFixed(2) + ' lbs' : wd.bone_mass_kg.value.toFixed(2) + ' kg'}`);
        if (wd.body_water_pct?.value != null)  parts.push(`Body water: ${wd.body_water_pct.value.toFixed(1)}%`);
        if (wd.visceral_fat?.value != null)    parts.push(`Visceral fat: ${wd.visceral_fat.value.toFixed(1)}`);
        if (wd.vascular_age?.value != null)    parts.push(`Vascular age: ${Math.round(wd.vascular_age.value)} yrs`);
        if (wd.metabolic_age?.value != null)   parts.push(`Metabolic age: ${Math.round(wd.metabolic_age.value)} yrs`);
        if (wd.lean_mass_kg?.value != null)   parts.push(`Lean mass: ${_wFmt(wd.lean_mass_kg.value)}`);
        if (wd.fat_mass_kg?.value != null)    parts.push(`Fat mass: ${_wFmt(wd.fat_mass_kg.value)}`);

        if (wd.basal_metabolic_rate?.value != null) {
          const _bmr = Nutrition.displayEnergy(wd.basal_metabolic_rate.value, $energyUnit);
          parts.push(`BMR: ${_bmr.value} ${_bmr.unit}/day`);
        }
        if (wd.nerve_health_score?.value != null) parts.push(`Nerve health: ${Math.round(wd.nerve_health_score.value)}`);
        if (wd.pulse_wave_velocity?.value != null) parts.push(`Pulse wave velocity: ${wd.pulse_wave_velocity.value.toFixed(1)} m/s`);
        if (wd.ecg_heart_rate?.value != null)  parts.push(`ECG HR: ${Math.round(wd.ecg_heart_rate.value)} bpm`);
        if (wd.ecg_afib?.value != null)        parts.push(`AFib: ${wd.ecg_afib.value === 1 ? 'Detected' : 'Normal'}`);
        if (parts.length) wellnessText += (wellnessText ? '\n' : '') + `Withings: ${parts.join(', ')}`;
      }
    } catch {}
    // Health Connect (Android local mode)
    try {
      if ($healthConnectEnabled && isNative) {
        const { dbGetWellnessByDate } = await import('../../lib/db-native.js');
        const hcData = await dbGetWellnessByDate(today, 'health_connect').catch(() => null);
        if (hcData && Object.keys(hcData).length) {
          const parts = [];
          const _du = DB.getSetting('distUnit', 'km');
          if (hcData.steps != null)          parts.push(`Steps: ${Math.round(hcData.steps).toLocaleString()}`);
          if (hcData.calories_out != null)   parts.push(`Calories burned: ${Math.round(hcData.calories_out)}`);
          if (hcData.active_calories != null) parts.push(`Active calories: ${Math.round(hcData.active_calories)}`);
          if (hcData.distance_km != null)    parts.push(`Distance: ${_du === 'mi' ? (hcData.distance_km * 0.621371).toFixed(2) + ' mi' : hcData.distance_km.toFixed(2) + ' km'}`);
          if (hcData.sleep_duration_min != null) { const h = Math.floor(hcData.sleep_duration_min/60); parts.push(`Sleep: ${h}h ${Math.round(hcData.sleep_duration_min%60)}m`); }
          if (hcData.resting_hr != null)     parts.push(`Resting HR: ${Math.round(hcData.resting_hr)} bpm`);
          if (hcData.avg_heart_rate != null) parts.push(`Avg HR: ${Math.round(hcData.avg_heart_rate)} bpm`);
          if (hcData.hrv_rmssd != null)      parts.push(`HRV: ${hcData.hrv_rmssd.toFixed(1)} ms`);
          if (hcData.weight_kg != null) {
            const _wu = DB.getSetting('weightUnit', 'lb');
            parts.push(`Weight: ${_wu === 'lb' ? (hcData.weight_kg * 2.20462).toFixed(1) + ' lbs' : hcData.weight_kg.toFixed(1) + ' kg'}`);
          }
          if (parts.length) wellnessText += (wellnessText ? '\n' : '') + `Health Connect: ${parts.join(', ')}`;
        }
      }
    } catch {}

    // Pre-compute logging streak so it's always in the AI's context.
    // mini-class models often skip the get_logging_streak tool and
    // hallucinate streaks; having the value already in the system prompt
    // bypasses tool-routing entirely. Uses the same broadened "any
    // diary content" definition as the tool.
    let streakText = '';
    try {
      const all = await _aiFetchAllDiary();
      const hasContent = e => (e?.items?.length > 0)
        || (e?.water?.length > 0)
        || (e?.body_stats && Object.keys(e.body_stats).length > 0)
        || (e?.bodyStats && Object.keys(e.bodyStats).length > 0)
        || (typeof e?.notes === 'string' && e.notes.trim().length > 0);
      const logged = new Set((all || []).filter(hasContent).map(e => e.date));
      const todayLogged = logged.has(today);
      const cursor = new Date();
      cursor.setHours(12, 0, 0, 0);
      if (!todayLogged) cursor.setDate(cursor.getDate() - 1);
      let s = 0, sStart = null;
      while (s < 100000) {
        const ds = localDateStr(cursor);
        if (!logged.has(ds)) break;
        sStart = ds;
        s++;
        cursor.setDate(cursor.getDate() - 1);
      }
      if (s > 0) streakText = `${s} consecutive days (since ${sStart}; today ${todayLogged ? 'logged' : 'not yet logged'})`;
      else streakText = `0 (no recent logging${todayLogged ? '' : '; today not yet logged'})`;
    } catch {}

    return { today, userName, profileText, diaryText, goalsText, statsText, wellnessText, waterText, streakText,
      weightUnit: DB.getSetting('weightUnit', 'lb'),
      distUnit: DB.getSetting('distUnit', 'km'),
      heightUnit: DB.getSetting('heightUnit', 'ft'),
      tempUnit: DB.getSetting('tempUnit', 'F'),
      energyUnit: DB.getSetting('energyUnit', 'kcal'),
    };
  }

  function buildSystemPrompt(ctx) {
    const name = $aiAssistantName;
    return `You are ${name}, a friendly and knowledgeable AI nutrition and fitness coach built into NutriTrace.

You have FULL ACCESS to the user's complete health data through tools. ALWAYS use tools to look up data — NEVER guess or make up numbers. Available data:
- **Food diary**: meals, items, portions, full nutrition, plus per-item notes (prep/serving info) and free-text "day notes" the user writes about how they felt, slept, cravings, etc. (any date) — use get_diary
- **Diary averages**: average daily intake over any period + logging consistency + weight trend — use get_diary_averages
- **Logging streak**: current consecutive-days food-logging streak (walks from today/yesterday back to the first gap) — use get_logging_streak. Do NOT inflate get_diary_averages with a huge days value to infer the streak; the streak tool is authoritative and cheaper.
- **Saved meals & recipes**: the user's library of reusable meals/recipes with items, notes, and totals — use get_meals (supports a name filter)
- **Wellness metrics**: steps, calories burned, distance, active minutes, sleep (duration, stages, score, efficiency), heart rate (resting HR, HRV, SpO2), respiratory rate, readiness score, stress score, skin temp, VO2 max — from Fitbit, Garmin, Health Connect (any date range) — use get_wellness_data
- **Body composition**: weight, body fat %, muscle mass, bone mass, body water, lean/fat mass, visceral fat, vascular age, metabolic age, BMR, nerve health, ECG — from Withings (any date range) — use get_body_composition
- **Workouts**: recorded exercises with duration, distance, calories, heart rate, steps, GPS (any date range) — use get_workouts
- **Nutrition goals**: calorie and macro targets — use get_goals

When the user asks about their data (steps, sleep, weight, food log, etc.) for ANY date or date range, USE THE APPROPRIATE TOOL to fetch the real data. Do not estimate or hallucinate numbers.

LOGGING STREAK — When the user asks about their food-logging streak in any phrasing ("how long have I been logging", "what's my streak", "when did I start logging", "first day I logged", "days in a row", "consecutive days"), you MUST call get_logging_streak FIRST and report the exact streak_days + streak_start values from its response. NEVER guess streak length or first-logged dates from context or memory. NEVER use get_diary_averages as a substitute. If the user pushes back ("that's wrong", "actually it's longer"), call get_logging_streak again and quote the streak_start + streak_days verbatim — do not adjust the number based on the user's claim, because the tool walks the actual diary table.

LOGGING ACTIVITY — When the user describes a workout, exercise, or physical activity ("I hiked 10 miles", "did 45 min of yoga", "burned 540 at the gym"), use add_activity_entry to log it. Rules:
- If the user provides a calorie number, trust it verbatim (source="user_stated").
- If the user does NOT provide a number, you may compute one from their body weight (use the TODAY'S SUMMARY context if available) × MET × duration / 200, then call add_activity_entry with kcal set and source="ai_estimated", and tell the user the estimate so they can correct it.
- Do not call add_activity_entry without a kcal value. The tool refuses kcal=0.
- The tool itself enforces user permission gates (Activity section toggle, auto-estimate toggle, body profile completeness) — if it returns an error, relay the explanation to the user verbatim and ask for what's missing.

LOGGING QUICK CALORIES — When the user wants to log just a calorie number without a real food ("log 200 calories for lunch", "punch in 1200 kJ for dinner", "add 350 quick calories"), use log_quick_calories. This is the Fitbit-style quick-add path; no food row is created. Rules:
- If the user gave kJ, convert to kcal yourself: kcal = kj / 4.184. Pass the kcal number.
- Map meal words to indices: breakfast=0, lunch=1, dinner=2, snack/snacks=3. If unclear, ask or default to snacks (3).
- Optional name field: if the user said "for office snack" or similar, pass that as name (max 60 chars).
- Tool refuses kcal=0 and refuses if the user has disabled Quick Calories in Settings — relay any error message verbatim.`
         + ($aiGoalInsights ? `

GOAL INSIGHTS MODE IS ENABLED. You have permission to proactively analyze the user's actual intake vs their goals and offer evidence-based suggestions. When relevant:
- Use get_diary_averages (28 days is a good default) + get_goals to compare actual vs target
- If intake consistently differs from goals by >10% for 2+ weeks, mention it and offer to suggest an adjustment
- Consider weight trends from get_body_composition or diary body stats when making calorie goal suggestions
- Be specific: "You've averaged 1,840 kcal over 28 days vs your 2,100 goal — that's a 260 kcal gap. Want me to suggest a revised goal?"
- Always ask before changing anything — never modify goals without explicit user confirmation
- Cover all dimensions: calories, protein, carbs, fat, water — not just calories` : ''
         ) + `

IMPORTANT — User's preferred units (ALWAYS use these when presenting data):
- Weight: ${ctx.weightUnit === 'lb' ? 'pounds (lbs)' : 'kilograms (kg)'}
- Distance: ${ctx.distUnit === 'mi' ? 'miles (mi)' : 'kilometers (km)'}
- Height/length: ${ctx.heightUnit === 'ft' ? 'feet/inches' : 'centimeters'}
- Temperature: ${ctx.tempUnit === 'F' ? 'Fahrenheit (°F)' : 'Celsius (°C)'}
- Energy: ${ctx.energyUnit === 'kJ' ? 'kilojoules (kJ)' : 'kilocalories (kcal)'}
Convert all values to these units before presenting. ONLY show the preferred unit — do NOT show both or include the original metric/imperial value.

Be warm, encouraging, and concise. Give practical, evidence-based advice. Use the data to personalize your responses.

Current date: ${ctx.today}

USER PROFILE (always-available context — these are facts about the user, not numbers to hallucinate around. When asked "what's my name / age / gender / how tall am I", answer directly from this block. Don't fetch a tool, don't say you don't know.):
${ctx.profileText || '(no profile data set yet — politely tell the user to fill it in via Settings → My Profile if they ask about their name, age, gender, height, or weight)'}
${ctx.userName ? `\nGreet them by name occasionally and reference it when celebrating progress — but don't overdo it (every other sentence is too much).\n` : ''}
TODAY'S SUMMARY (for quick reference — use tools for detailed or historical data):
${ctx.diaryText}
Goals: ${ctx.goalsText}
Water: ${ctx.waterText}
Diary logging streak: ${ctx.streakText || '(unknown)'}`
         + (ctx.statsText    ? `\nBody stats: ${ctx.statsText}` : '')
         + (ctx.wellnessText ? `\nWellness: ${ctx.wellnessText}` : '')
         + `\n\nFor any "what's my streak / how long have I been logging / when did I start logging" question, the answer is in the "Diary logging streak" line above — quote it directly, do not call any tool, do not estimate or guess.`;
  }

  function fmtTime() {
    return new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: $timeFormat !== '24h' });
  }

  async function send() {
    const content = input.trim();
    if (!content && !attachedImage) return;
    if (loading) return;

    const key      = $aiApiKey;
    const provider = aiProvider.get() || 'claude';
    const model    = aiModel.get()    || undefined;
    const baseUrl  = aiBaseUrl.get()  || undefined;

    // OpenAI-compatible endpoints (Ollama etc.) don't need an API key —
    // skip the key gate for that provider only.
    if (!aiEnvLocked && !key && provider !== 'oai-compat') {
      showError('Add your API key in Settings → AI Assistant'); return;
    }

    const image = attachedImage;
    const userMsg = { role: 'user', content: content || '(image)', time: fmtTime(), image: image?.preview };
    messages = [...messages, userMsg];
    input    = '';
    attachedImage = null;
    loading  = true;
    await tick();
    _scrollBottom();

    // Persist user message to server (best-effort)
    NtApi.post('/api/ai/history', { role: 'user', content: content || '(image attached)' }).catch(() => {});

    try {
      const ctx          = await buildContext();
      const systemPrompt = buildSystemPrompt(ctx);
      // Build API messages — include image in the last user message if present
      const apiMessages  = messages
        .map(m => ({ role: m.role, content: m.content }))
        .slice(-20);
      // If image attached, modify the last user message to include it
      if (image) {
        const lastIdx = apiMessages.length - 1;
        apiMessages[lastIdx] = _buildImageMessage(provider, content || 'What is this?', image);
      }
      const reply = aiEnvLocked
        ? await callAIProxy({ messages: apiMessages, systemPrompt })
        : await callAI({ provider, apiKey: key, model, baseUrl, messages: apiMessages, systemPrompt, tools: TOOLS,
            onToolCall: (toolName) => { _toolStatus = `Fetching ${toolName.replace(/_/g, ' ')}…`; },
          });
      messages = [...messages, { role: 'assistant', content: reply, time: fmtTime() }];
      // Persist assistant reply to server (best-effort)
      NtApi.post('/api/ai/history', { role: 'assistant', content: reply }).catch(() => {});
      if (!panelOpen) hasUnread = true;
    } catch (e) {
      showError(e.message || 'AI request failed');
    } finally {
      loading = false;
      _toolStatus = '';
      await tick();
      _scrollBottom();
    }
  }

  function _buildImageMessage(provider, text, image) {
    if (provider === 'claude') {
      return { role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.base64 } },
        { type: 'text', text },
      ]};
    } else if (provider === 'openai') {
      return { role: 'user', content: [
        { type: 'image_url', image_url: { url: `data:${image.mimeType};base64,${image.base64}` } },
        { type: 'text', text },
      ]};
    } else if (provider === 'gemini') {
      // Gemini handles images differently — pass through and let aiChat.js handle it
      return { role: 'user', content: text, _image: image };
    }
    return { role: 'user', content: text };
  }

  function _attachImage() {
    if (isNative) {
      import('@capacitor/camera').then(({ Camera, CameraResultType, CameraSource }) => {
        Camera.getPhoto({ quality: 80, resultType: CameraResultType.Base64, source: CameraSource.Prompt, width: 1024 })
          .then(photo => { attachedImage = { base64: photo.base64String, mimeType: `image/${photo.format || 'jpeg'}`, preview: `data:image/${photo.format || 'jpeg'};base64,${photo.base64String}` }; })
          .catch(() => {});
      });
    } else if (_hasCamera) {
      _showAttachMenu = !_showAttachMenu;
    } else {
      fileInput?.click();
    }
  }

  function _attachFromCamera() { _showAttachMenu = false; _cameraInput?.click(); }
  function _attachFromFile()   { _showAttachMenu = false; fileInput?.click(); }

  function _onFileSelected(e) {
    const file = e.target.files?.[0];
    if (!file || !file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      const base64 = dataUrl.split(',')[1];
      attachedImage = { base64, mimeType: file.type, preview: dataUrl };
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  }

  function _removeImage() { attachedImage = null; }

  function _scrollBottom(instant = false) {
    messagesEl?.scrollTo({ top: messagesEl.scrollHeight, behavior: instant ? 'instant' : 'smooth' });
  }

  function onKey(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  }

  function clearChat() {
    messages = [];
    localStorage.removeItem('wl:aiChatHistory');
    NtApi.del('/api/ai/history').catch(() => {});
  }

  function quickAsk(q) { input = q; send(); }
</script>

{#if $aiEffectivelyEnabled}
  <!-- ── Floating Action Button ─────────────────────────────────────────── -->
  <!-- FAB gated on $aiEffectivelyEnabled: the per-user $aiEnabled OR an
       operator-set AI_ENABLED=true env var that env-locked the section
       server-wide (issue #36). The Settings → AI Assistant card
       surfaces a connection-status banner (green/red/spinner) driven by
       $aiKeyVerified for users who want to verify the key is actually
       working, but the FAB doesn't hide on its own — that would break
       users upgrading from a previous release where verified didn't
       exist and their FAB was working fine. -->

  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div
    class="ai-fab"
    class:panel-open={panelOpen}
    class:has-unread={hasUnread}
    class:recording={recordingMode}
    class:cancel-preview={cancelPreview}
    style={fabStyle}
    on:pointerdown={startDrag}
    on:click={handleFabClick}
    on:keydown={e => e.key === 'Enter' && handleFabClick()}
    role="button"
    tabindex="0"
    aria-label={recordingMode ? (cancelPreview ? 'Release to cancel' : 'Recording — release to log') : 'Open AI coach (hold to dictate food)'}
    title={$quickLogEnabled ? 'Tap to chat · hold to log food by voice' : 'AI Assistant'}
  >
    {#if loading}
      <div class="fab-spinner"></div>
    {:else if panelOpen}
      <span class="material-symbols-rounded" style="font-size:26px">close</span>
    {:else if recordingMode}
      <span class="material-symbols-rounded fab-mic" style="font-size:30px">mic</span>
    {:else}
      <div class="fab-robot-wrap"><TraceFace size={42} /></div>
    {/if}
    {#if hasUnread && !panelOpen}
      <div class="fab-badge" transition:fade={{ duration: 120 }}></div>
    {/if}
  </div>

  <!-- Recording hint tooltip — centered above the FAB while recording.
       Uses transform: translateX(-50%) so the pill stays centered on the FAB
       regardless of how wide the text inside is. Position is based on the
       FAB's center x-coordinate (FAB width = 60px → center = pos.x + 30). -->
  {#if recordingMode}
    <div
      class="fab-record-hint"
      class:cancel={cancelPreview}
      style={fabPos ? `left:${fabPos.x + 30}px; top:${fabPos.y - 44}px; right:auto; transform:translateX(-50%);` : ''}
    >
      {#if cancelPreview}
        ✕ Release to cancel
      {:else}
        ● Listening… release to log
      {/if}
    </div>
  {/if}

  <!-- ── Panel Backdrop ─────────────────────────────────────────────────── -->
  {#if panelOpen}
    <!-- Backdrop only shown on mobile (CSS-gated) for fullscreen bottom-sheet feel.
         On desktop the panel sits over content like a companion widget. -->
    <!-- svelte-ignore a11y-no-static-element-interactions -->
    <div
      class="ai-backdrop"
      transition:fade={{ duration: 200 }}
      on:click={() => panelOpen = false}
      on:keydown={() => {}}
    ></div>

    <!-- ── Chat Panel ──────────────────────────────────────────────────── -->
    <aside
      class="ai-panel"
      style={panelStyle}
      transition:fly={{ y: 600, duration: 320, easing: cubicOut }}
      aria-label={$_('trace.panel_label')}
    >
      <!-- Drag handle (mobile only) -->
      <div class="ai-drag-handle" aria-hidden="true"></div>
      <!-- Header -->
      <div class="ai-header">
        <div class="ai-header-brand">
          <div class="ai-avatar">
            <TraceFace size={32} />
          </div>
          <div>
            <div class="ai-header-name">{assistantName}</div>
            <div class="ai-header-sub">Your AI Health & Nutrition Coach</div>
          </div>
        </div>
        <div class="ai-header-actions">
          <button class="btn-icon" on:click={clearChat} title={$_('trace.clear_conversation')}>
            <span class="material-symbols-rounded">delete_sweep</span>
          </button>
          <button class="btn-icon" on:click={() => panelOpen = false} title={$_('common.close')}>
            <span class="material-symbols-rounded">close</span>
          </button>
        </div>
      </div>

      <!-- Messages -->
      <div class="ai-messages" bind:this={messagesEl}>
        {#if !apiKey && !aiEnvLocked}
          <!-- Setup needed. Skipped when env-locked: the server proxy handles
               auth so no per-user API key is required. This was the rc.33
               #36 follow-up I missed — the chat send path correctly routed
               through callAIProxy when env-locked, but this template gate
               still required apiKey from $aiApiKey (per-user) and blocked
               the chat UI before the user could even type. -->
          <div class="ai-setup">
            <span class="material-symbols-rounded ai-setup-icon">key</span>
            <p class="ai-setup-title">API key required</p>
            <p class="ai-setup-desc">Add your AI provider key in <strong>Settings → AI Assistant</strong> to start chatting.</p>
            <p class="ai-setup-desc" style="margin-top:4px">Supports Anthropic Claude, OpenAI, and Google Gemini.</p>
            <a href="#/settings" class="btn btn-primary" style="margin-top:16px" on:click={() => panelOpen = false}>
              Open Settings
            </a>
          </div>

        {:else if messages.length === 0}
          <!-- Welcome screen -->
          <div class="ai-welcome">
            <div class="ai-welcome-avatar">
              <TraceFace size={48} />
            </div>
            <p class="ai-welcome-name">Hi, I'm {assistantName}!</p>
            <p class="ai-welcome-desc">Ask me anything — nutrition, sleep, activity, recovery, hydration, body composition. I have access to all your data from today.</p>
            <div class="ai-quick-chips">
              <button class="ai-chip" on:click={() => quickAsk("How am I doing today?")}>
                How am I doing today?
              </button>
              <button class="ai-chip" on:click={() => quickAsk("What should I eat for my next meal?")}>
                Meal suggestion
              </button>
              <button class="ai-chip" on:click={() => quickAsk("How was my sleep and recovery?")}>
                Sleep & recovery
              </button>
              <button class="ai-chip" on:click={() => quickAsk("Am I on track with my goals?")}>
                Goal progress
              </button>
            </div>
          </div>

        {:else}
          <!-- Message list -->
          <!-- Position-stable key: the prior (time+role+content[:10]) composite
               collided when two messages shared the same minute, role, and
               opening characters (e.g. an assistant tool-use round emitting
               two short replies). Svelte 5 throws each_key_duplicate on the
               collision and bricks the chat panel for the user (#40). Index
               is safe here because chat is strictly append-only — no reorders
               or interior insertions to worry about. -->
          {#each messages as msg, i (i + ':' + msg.role + ':' + msg.time)}
            <div class="ai-msg" class:user={msg.role === 'user'}>
              {#if msg.role === 'assistant'}
                <div class="ai-msg-avatar">
                  <TraceFace size={24} />
                </div>
              {/if}
              <div class="ai-msg-body">
                {#if msg.image}
                  <img src={msg.image} alt="Attached" class="ai-msg-image" />
                {/if}
                <div class="ai-bubble">{msg.content}</div>
                {#if msg.time}
                  <div class="ai-time">{msg.time}</div>
                {/if}
              </div>
            </div>
          {/each}
        {/if}

        <!-- Typing indicator -->
        {#if loading}
          <div class="ai-msg">
            <div class="ai-msg-avatar">
              <TraceFace size={24} />
            </div>
            <div class="ai-msg-body">
              <div class="ai-bubble ai-typing">
                {#if _toolStatus}
                  <span class="material-symbols-rounded" style="font-size:14px;animation:ai-bounce 1s infinite">search</span>
                  <span style="font-size:12px;color:var(--text-3)">{_toolStatus}</span>
                {:else}
                  <span class="ai-dot"></span>
                  <span class="ai-dot"></span>
                  <span class="ai-dot"></span>
                {/if}
              </div>
            </div>
          </div>
        {/if}
      </div>

      <!-- Input bar -->
      {#if attachedImage}
        <div class="ai-image-preview">
          <img src={attachedImage.preview} alt="Attached" />
          <button class="ai-image-remove" on:click={_removeImage}>
            <span class="material-symbols-rounded" style="font-size:16px">close</span>
          </button>
        </div>
      {/if}
      <div class="ai-input-bar">
        <div style="position:relative">
          <button class="ai-attach-btn" on:click={_attachImage} disabled={loading} title={$_('trace.attach_image')}>
            <span class="material-symbols-rounded">photo_camera</span>
          </button>
          {#if _showAttachMenu}
            <div class="ai-attach-menu">
              <button class="ai-attach-option" on:click={_attachFromCamera}>
                <span class="material-symbols-rounded" style="font-size:18px">photo_camera</span> Camera
              </button>
              <button class="ai-attach-option" on:click={_attachFromFile}>
                <span class="material-symbols-rounded" style="font-size:18px">photo_library</span> Gallery
              </button>
            </div>
          {/if}
        </div>
        <textarea
          class="ai-textarea"
          bind:value={input}
          placeholder={$_('trace.ask_placeholder')}
          on:keydown={onKey}
          rows="1"
          disabled={loading}
        ></textarea>
        <button class="ai-send-btn" on:click={send} disabled={loading || (!input.trim() && !attachedImage)}>
          <span class="material-symbols-rounded">send</span>
        </button>
      </div>
      <input type="file" accept="image/*" bind:this={fileInput} on:change={_onFileSelected} style="display:none" />
      <input type="file" accept="image/*" capture="environment" bind:this={_cameraInput} on:change={_onFileSelected} style="display:none" />
    </aside>
  {/if}

  <!-- ── Smart Log modal — global mount, opens after a hold-to-record gesture ── -->
  {#if showSmartLog && smartLogPreParsed}
    <SmartLogModal
      date={localDateStr()}
      defaultMealSlot={0}
      openMode="preParsed"
      preParsedMatches={smartLogPreParsed}
      preParsedMeal={smartLogMeal}
      preParsedSourceText={smartLogText}
      on:close={() => { showSmartLog = false; smartLogPreParsed = null; }}
      on:saved={() => { showSmartLog = false; smartLogPreParsed = null; }}
    />
  {/if}
{/if}

<style>
  /* ── Floating button ──────────────────────────────────────────────────── */
  .ai-fab {
    position: fixed;
    right: 20px;
    bottom: calc(var(--nav-h) + var(--safe-bottom, 0px) + 20px);
    width: 60px;
    height: 60px;
    border-radius: 50%;
    /* Glassmorphism with shifting gradient underneath — uses theme accents */
    background: linear-gradient(135deg, var(--accent), var(--accent-2), var(--accent), var(--accent-2), var(--accent));
    background-size: 300% 300%;
    color: var(--accent-text);
    border: 1px solid rgba(255,255,255,0.25);
    backdrop-filter: blur(12px) saturate(180%);
    -webkit-backdrop-filter: blur(12px) saturate(180%);
    cursor: pointer;
    z-index: 400;
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow:
      0 8px 32px rgba(0,0,0,0.35),
      inset 0 1px 0 rgba(255,255,255,0.35),
      inset 0 -2px 6px rgba(0,0,0,0.15);
    animation:
      gradient-shift 8s ease-in-out infinite,
      ring-pulse 2.6s ease-out infinite;
    transition: transform 0.18s ease, box-shadow 0.18s ease;
    touch-action: none;
    user-select: none;
    -webkit-user-select: none;
    overflow: visible;
  }
  /* Inner glass highlight overlay */
  .ai-fab::before {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: 50%;
    background: radial-gradient(circle at 30% 25%, rgba(255,255,255,0.45), rgba(255,255,255,0) 55%);
    pointer-events: none;
  }
  .ai-fab:hover {
    transform: scale(1.08);
    box-shadow:
      0 12px 36px rgba(0,0,0,0.45),
      inset 0 1px 0 rgba(255,255,255,0.4),
      0 0 0 8px var(--accent-dim);
  }
  .ai-fab:active    { transform: scale(0.94); }
  .ai-fab.panel-open {
    animation: gradient-shift 8s ease-in-out infinite;
  }
  /* Recording state — robot face morphs to mic icon. The FAB turns RED
     (universal "recording" color), gets a strong heartbeat ring, and
     scales up 8% so the user has unambiguous "live" feedback. */
  .ai-fab.recording {
    transform: scale(1.08);
    background: linear-gradient(135deg, #ef4444, #b91c1c, #ef4444, #dc2626, #ef4444);
    background-size: 300% 300%;
    border-color: rgba(255, 200, 200, 0.45);
    animation:
      gradient-shift 4s ease-in-out infinite,
      ring-pulse-record 1.1s ease-out infinite;
  }
  /* Cancel-preview state — finger has slid > CANCEL_RADIUS_PX from the FAB.
     Greys out so the user knows releasing now will abort instead of commit. */
  .ai-fab.recording.cancel-preview {
    background: linear-gradient(135deg, #6b7280, #374151);
    border-color: rgba(255, 255, 255, 0.18);
    animation: gradient-shift 4s ease-in-out infinite;
    transform: scale(1.0);
    opacity: 0.85;
  }
  .fab-mic {
    color: var(--accent-text);
    position: relative;
    z-index: 1;
    filter: drop-shadow(0 1px 3px rgba(0,0,0,0.4));
    animation: mic-pulse 0.9s ease-in-out infinite;
  }
  @keyframes mic-pulse {
    0%, 100% { transform: scale(1); }
    50%       { transform: scale(1.12); }
  }
  @keyframes ring-pulse-strong {
    0%   { box-shadow:
             0 8px 32px rgba(0,0,0,0.35),
             inset 0 1px 0 rgba(255,255,255,0.35),
             inset 0 -2px 6px rgba(0,0,0,0.15),
             0 0 0 0   color-mix(in srgb, var(--accent) 60%, transparent); }
    70%  { box-shadow:
             0 8px 32px rgba(0,0,0,0.35),
             inset 0 1px 0 rgba(255,255,255,0.35),
             inset 0 -2px 6px rgba(0,0,0,0.15),
             0 0 0 22px transparent; }
    100% { box-shadow:
             0 8px 32px rgba(0,0,0,0.35),
             inset 0 1px 0 rgba(255,255,255,0.35),
             inset 0 -2px 6px rgba(0,0,0,0.15),
             0 0 0 0 transparent; }
  }
  /* Red recording ring pulse — same heartbeat but red instead of accent */
  @keyframes ring-pulse-record {
    0%   { box-shadow:
             0 8px 32px rgba(0,0,0,0.4),
             inset 0 1px 0 rgba(255,255,255,0.35),
             inset 0 -2px 6px rgba(0,0,0,0.2),
             0 0 0 0 rgba(239, 68, 68, 0.55); }
    70%  { box-shadow:
             0 8px 32px rgba(0,0,0,0.4),
             inset 0 1px 0 rgba(255,255,255,0.35),
             inset 0 -2px 6px rgba(0,0,0,0.2),
             0 0 0 22px rgba(239, 68, 68, 0); }
    100% { box-shadow:
             0 8px 32px rgba(0,0,0,0.4),
             inset 0 1px 0 rgba(255,255,255,0.35),
             inset 0 -2px 6px rgba(0,0,0,0.2),
             0 0 0 0 rgba(239, 68, 68, 0); }
  }
  /* Recording hint tooltip — centered above the FAB during recording.
     Default position: FAB sits at right:20px width:60px so its center is at
     50px from the right edge. Pill uses right:50px + translateX(50%) so the
     pill's own center lines up with the FAB's center. When the user has
     dragged the FAB, the inline style overrides with absolute left + a
     translateX(-50%). Padding and line-height tuned so single-line text
     stays vertically centered without descender clipping. */
  .fab-record-hint {
    position: fixed;
    right: 50px;
    transform: translateX(50%);
    bottom: calc(var(--nav-h) + var(--safe-bottom, 0px) + 92px);
    padding: 8px 16px;
    border-radius: 16px;
    background: rgba(0, 0, 0, 0.82);
    backdrop-filter: blur(10px) saturate(180%);
    -webkit-backdrop-filter: blur(10px) saturate(180%);
    border: 1px solid rgba(255, 255, 255, 0.18);
    font-size: 13px;
    font-weight: 600;
    line-height: 1.2;
    color: #ffffff;
    z-index: 401;
    pointer-events: none;
    white-space: nowrap;
    text-align: center;
    box-shadow: 0 4px 18px rgba(0,0,0,0.45);
    animation: fab-hint-fade 0.18s ease-out;
  }
  .fab-record-hint.cancel {
    color: #fca5a5;
    border-color: rgba(252, 165, 165, 0.35);
  }
  @keyframes fab-hint-fade {
    from { opacity: 0; }
    to   { opacity: 1; }
  }

  @keyframes gradient-shift {
    0%, 100% { background-position: 0% 50%; }
    50%       { background-position: 100% 50%; }
  }
  /* Concentric ring pulse — heartbeat outward, color from theme */
  @keyframes ring-pulse {
    0%   { box-shadow:
             0 8px 32px rgba(0,0,0,0.35),
             inset 0 1px 0 rgba(255,255,255,0.35),
             inset 0 -2px 6px rgba(0,0,0,0.15),
             0 0 0 0 var(--accent-dim); }
    70%  { box-shadow:
             0 8px 32px rgba(0,0,0,0.35),
             inset 0 1px 0 rgba(255,255,255,0.35),
             inset 0 -2px 6px rgba(0,0,0,0.15),
             0 0 0 16px transparent; }
    100% { box-shadow:
             0 8px 32px rgba(0,0,0,0.35),
             inset 0 1px 0 rgba(255,255,255,0.35),
             inset 0 -2px 6px rgba(0,0,0,0.15),
             0 0 0 0 transparent; }
  }

  /* Robot face wrapper inside the FAB — sits above the gradient + glass overlay */
  .fab-robot-wrap {
    position: relative;
    z-index: 1;
    color: var(--accent-text);
    display: flex;
    align-items: center;
    justify-content: center;
  }

  /* Spinner when loading */
  .fab-spinner {
    width: 26px; height: 26px;
    border: 3px solid var(--accent-text);
    border-top-color: transparent;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* Unread badge dot */
  .fab-badge {
    position: absolute;
    top: 3px; right: 3px;
    width: 13px; height: 13px;
    border-radius: 50%;
    background: var(--danger);
    border: 2px solid var(--bg);
    animation: badge-pulse 2s ease-in-out infinite;
  }
  @keyframes badge-pulse {
    0%, 100% { transform: scale(1); }
    50%       { transform: scale(1.2); }
  }

  /* ── Backdrop ─────────────────────────────────────────────────────────── */
  /* Mobile: dimmed backdrop for full-attention bottom sheet feel.
     Desktop: hidden — chat is a companion widget over content. */
  .ai-backdrop {
    position: fixed; inset: 0;
    background: var(--overlay);
    backdrop-filter: var(--backdrop-blur);
    -webkit-backdrop-filter: var(--backdrop-blur);
    z-index: 440;
  }
  @media (min-width: 769px) {
    .ai-backdrop { display: none; }
  }

  /* ── Chat Panel — Mobile (bottom sheet) ────────────────────────────── */
  .ai-panel {
    position: fixed;
    left: 0; right: 0; bottom: 0;
    top: auto;
    width: 100%;
    height: 88vh;
    max-height: 88vh;
    background: var(--surface-1);
    border-top: 1px solid var(--border);
    border-radius: 20px 20px 0 0;
    z-index: 450;
    display: flex;
    flex-direction: column;
    box-shadow: 0 -8px 40px rgba(0,0,0,0.4);
    padding-bottom: var(--safe-bottom, 0px);
    overflow: hidden;
  }

  /* Drag handle indicator (mobile only) */
  .ai-drag-handle {
    width: 40px;
    height: 4px;
    border-radius: 2px;
    background: var(--text-3);
    opacity: 0.4;
    margin: 8px auto 4px;
    flex-shrink: 0;
  }

  /* ── Chat Panel — Desktop (floating card anchored bottom-right) ───── */
  @media (min-width: 769px) {
    .ai-panel {
      left: auto;
      right: 24px;
      bottom: calc(var(--nav-h, 0px) + var(--safe-bottom, 0px) + 96px);
      top: auto;
      width: 420px;
      height: min(640px, 80vh);
      max-height: 80vh;
      border: 1px solid var(--border);
      border-radius: 16px;
      box-shadow: 0 12px 48px rgba(0,0,0,0.45);
    }
    .ai-drag-handle { display: none; }
  }

  /* Header */
  .ai-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 16px;
    background: linear-gradient(135deg, var(--accent-dim), transparent);
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  .ai-header-brand { display: flex; align-items: center; gap: 12px; }
  .ai-avatar {
    width: 40px; height: 40px;
    border-radius: 50%;
    background: linear-gradient(135deg, var(--accent), var(--accent-2));
    display: flex; align-items: center; justify-content: center;
    color: var(--accent-text);
    flex-shrink: 0;
  }
  .ai-header-name { font-size: 15px; font-weight: 700; color: var(--text-1); }
  .ai-header-sub  { font-size: 11px; color: var(--text-3); margin-top: 1px; }
  .ai-header-actions { display: flex; gap: 4px; }

  /* Messages area */
  .ai-messages {
    flex: 1;
    overflow-y: auto;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    overscroll-behavior: contain;
  }

  /* Setup screen */
  .ai-setup {
    display: flex; flex-direction: column; align-items: center;
    text-align: center; padding: 40px 24px; gap: 8px;
    margin: auto 0;
  }
  .ai-setup-icon { font-size: 48px; color: var(--accent); opacity: 0.6; }
  .ai-setup-title { font-size: 17px; font-weight: 700; color: var(--text-1); margin-top: 4px; }
  .ai-setup-desc  { font-size: 13px; color: var(--text-3); line-height: 1.5; }

  /* Welcome screen */
  .ai-welcome {
    display: flex; flex-direction: column; align-items: center;
    text-align: center; padding: 32px 24px; gap: 10px;
    margin: auto 0;
  }
  .ai-welcome-avatar {
    width: 64px; height: 64px;
    border-radius: 50%;
    background: linear-gradient(135deg, var(--accent), var(--accent-2));
    display: flex; align-items: center; justify-content: center;
    color: var(--accent-text);
    margin-bottom: 4px;
  }
  .ai-welcome-name { font-size: 18px; font-weight: 700; color: var(--text-1); }
  .ai-welcome-desc { font-size: 13px; color: var(--text-2); line-height: 1.6; max-width: 280px; }
  .ai-quick-chips {
    display: flex; flex-wrap: wrap; gap: 8px;
    justify-content: center; margin-top: 8px;
  }
  .ai-chip {
    padding: 7px 14px;
    border-radius: var(--radius-full);
    border: 1px solid var(--border-strong);
    background: var(--surface-2);
    color: var(--text-2);
    font-size: 12px; font-weight: 500;
    cursor: pointer;
    transition: background var(--dur-fast), color var(--dur-fast), border-color var(--dur-fast);
  }
  .ai-chip:hover {
    background: var(--accent-dim);
    color: var(--accent);
    border-color: var(--accent);
  }

  /* Message bubbles */
  .ai-msg {
    display: flex;
    align-items: flex-end;
    gap: 8px;
    max-width: 100%;
  }
  .ai-msg.user {
    flex-direction: row-reverse;
  }
  .ai-msg-avatar {
    width: 32px; height: 32px;
    border-radius: 50%;
    background: var(--accent-dim);
    color: var(--accent);
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0;
  }
  .ai-msg-body {
    display: flex; flex-direction: column; gap: 3px;
    max-width: calc(100% - 40px);
  }
  .ai-msg.user .ai-msg-body { align-items: flex-end; }

  .ai-bubble {
    padding: 10px 14px;
    border-radius: 18px;
    font-size: 14px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
  }
  /* AI bubble */
  .ai-msg:not(.user) .ai-bubble {
    background: var(--surface-2);
    color: var(--text-1);
    border-bottom-left-radius: 6px;
  }
  /* User bubble */
  .ai-msg.user .ai-bubble {
    background: linear-gradient(135deg, var(--accent), var(--accent-2));
    color: var(--accent-text);
    border-bottom-right-radius: 6px;
  }

  .ai-time {
    font-size: 10px;
    color: var(--text-3);
    padding: 0 4px;
  }

  /* Typing dots */
  .ai-typing {
    display: flex; align-items: center; gap: 5px;
    padding: 12px 16px;
    min-width: 60px;
  }
  .ai-dot {
    width: 7px; height: 7px;
    border-radius: 50%;
    background: var(--text-3);
    animation: ai-bounce 1.4s ease-in-out infinite;
  }
  .ai-dot:nth-child(2) { animation-delay: 0.2s; }
  .ai-dot:nth-child(3) { animation-delay: 0.4s; }
  @keyframes ai-bounce {
    0%, 60%, 100% { transform: translateY(0);    opacity: 0.4; }
    30%            { transform: translateY(-6px); opacity: 1;   }
  }

  /* Input bar */
  .ai-input-bar {
    display: flex;
    align-items: flex-end;
    gap: 8px;
    padding: 12px 16px;
    border-top: 1px solid var(--border);
    background: var(--surface-1);
    flex-shrink: 0;
  }
  .ai-textarea {
    flex: 1;
    resize: none;
    background: var(--surface-2);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-lg);
    padding: 10px 14px;
    font-size: 14px;
    font-family: inherit;
    color: var(--text-1);
    line-height: 1.5;
    max-height: 120px;
    overflow-y: auto;
    transition: border-color var(--dur-fast);
  }
  .ai-textarea:focus {
    outline: none;
    border-color: var(--accent);
  }
  .ai-textarea::placeholder { color: var(--text-3); }

  .ai-send-btn {
    width: 40px; height: 40px;
    border-radius: 50%;
    background: linear-gradient(135deg, var(--accent), var(--accent-2));
    color: var(--accent-text);
    border: none;
    cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0;
    transition: transform var(--dur-fast), opacity var(--dur-fast);
  }
  .ai-send-btn:disabled { opacity: 0.4; cursor: default; }
  .ai-send-btn:not(:disabled):hover  { transform: scale(1.08); }
  .ai-send-btn:not(:disabled):active { transform: scale(0.94); }
  .ai-send-btn .material-symbols-rounded { font-size: 20px; }

  .ai-attach-btn {
    width: 40px; height: 40px;
    border-radius: 50%;
    background: none;
    color: var(--text-3);
    border: 1px solid var(--border);
    cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0;
    transition: color var(--dur-fast), border-color var(--dur-fast);
  }
  .ai-attach-btn:hover { color: var(--accent); border-color: var(--accent); }
  .ai-attach-btn:disabled { opacity: 0.4; cursor: default; }
  .ai-attach-btn .material-symbols-rounded { font-size: 20px; }

  .ai-attach-menu {
    position: absolute;
    bottom: 48px;
    left: 0;
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    box-shadow: 0 4px 16px rgba(0,0,0,0.2);
    overflow: hidden;
    z-index: 10;
    min-width: 140px;
  }
  .ai-attach-option {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 10px 14px;
    background: none;
    border: none;
    color: var(--text-1);
    font-size: 14px;
    cursor: pointer;
    text-align: left;
  }
  .ai-attach-option:hover { background: var(--surface-2); }
  .ai-attach-option + .ai-attach-option { border-top: 1px solid var(--border); }

  .ai-image-preview {
    position: relative;
    padding: 8px 16px 0;
    flex-shrink: 0;
  }
  .ai-image-preview img {
    max-height: 120px;
    max-width: 100%;
    border-radius: var(--radius-lg);
    object-fit: cover;
  }
  .ai-image-remove {
    position: absolute;
    top: 4px;
    right: 12px;
    width: 22px; height: 22px;
    border-radius: 50%;
    background: rgba(0,0,0,0.6);
    color: #fff;
    border: none;
    cursor: pointer;
    display: flex; align-items: center; justify-content: center;
  }

  .ai-msg-image {
    max-width: 200px;
    max-height: 150px;
    border-radius: var(--radius-lg);
    margin-bottom: 4px;
    object-fit: cover;
  }
</style>
