<script>
  import { onMount, onDestroy, tick } from 'svelte';
  import { fly, fade } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import { _ } from 'svelte-i18n';
  import TraceFace from './TraceFace.svelte';
  import { NtApi }     from '../../lib/api.js';
  import { DB, localDateStr } from '../../lib/db.js';
  import { Nutrition, NUTRIMENTS } from '../../lib/nutrition.js';
  // Comma-joined list of every NT-tracked nutriment ID — inlined into the
  // system prompt so the AI knows the full key universe at a glance and
  // doesn't default to "just the four macros".
  const NUTRIMENT_ID_LIST = NUTRIMENTS.map(n => n.id).join(', ');
  import NutritionFactsBox from '../ui/NutritionFactsBox.svelte';
  import { readBodyStat, LENGTH_KEYS } from '../../lib/body-stats-unit.js';
  import { callAI, callAIProxy, TOOLS, setToolHandler } from '../../lib/aiChat.js';
  import { aiEnabled, aiEffectivelyEnabled, envLocks, aiKeyVerified, aiAssistantName, aiApiKey, aiProvider, aiModel, aiBaseUrl, goals, mealNames, energyUnit, dateFormat, timeFormat, tempUnit, quickLogEnabled, aiGoalInsights, healthConnectEnabled, smartLogVoiceLang } from '../../stores/settings.js';

  // Resolve the configured voice-input language. Shared with SmartLogModal:
  // 'auto' (default) means use device locale; explicit BCP-47 tags override.
  // See settings.js#smartLogVoiceLang for why device locale alone isn't enough.
  function _resolveVoiceLang() {
    const v = smartLogVoiceLang.get();
    if (v && v !== 'auto') return v;
    return navigator.language || 'en-US';
  }
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

  // Photo-log review card state. When the AI calls propose_quick_calories,
  // its sanitized payload lands here and the chat renders an FDA-style
  // Nutrition Facts card below the most recent assistant message with
  // Add to Diary / Discard actions. The user explicitly commits the write;
  // the AI never auto-logs from a photo. Set to null when no proposal is
  // pending or after the user has taken an action.
  // Pending propose_quick_calories review card. Replaced wholesale each
  // time the tool fires; user commits via the card's Add to Diary button.
  let _pendingProposal = null;     // { name, meal, date, serving_grams, serving_size, nutrition }
  let _proposalCommitted = false;
  let _proposalCommittedKcal = 0;
  // Pending propose_food review card. Same shape rules — replaces any
  // prior pending food card. Commit path is one of:
  //   _commitFoodCatalogOnly  — create food row, no diary write
  //   _commitFoodAndLog       — create food row AND log it to diary
  let _pendingFoodProposal = null; // { name, brand, portion, unit, nutrition, meal_hint }
  let _foodProposalCommitted = false;
  let _foodProposalCommittedKind = '';   // 'catalog' | 'logged'
  let _foodProposalCommittedMealIdx = 0;
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
            if (rawBs.body_fat   != null && rawBs.body_fat   !== '') bodyStats.body_fat_pct   = Number(rawBs.body_fat);
            if (rawBs.body_water != null && rawBs.body_water !== '') bodyStats.body_water_pct = Number(rawBs.body_water);
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
          const ALLOWED_AI_SOURCES = new Set(['ai_estimated', 'user_stated', 'compendium', 'manual_form']);
          const source = ALLOWED_AI_SOURCES.has(args?.source) ? args.source : 'manual_form';
          // #77: AI can now attach MET when it maps the activity to a canonical
          // compendium entry, and can save templates when the user asks.
          const metVal = (args?.met != null && Number.isFinite(Number(args.met)))
            ? Math.max(0, Math.min(25, Number(args.met))) : null;
          const isTemplate = !!args?.is_template;
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
              met: metVal,
              is_template: isTemplate,
            });
            return { ok: true, date, name, kcal, source, met: metVal, is_template: isTemplate };
          } catch (e) {
            return { error: 'Failed to save activity: ' + (e?.message || String(e)) };
          }
        }
        case 'log_food': {
          // Issue #79: AI Assistant adds Quick Calories to wrong meal instead
          // of creating a real food entry. Before this tool, the AI's only
          // direct-write option was log_quick_calories (kcal-only) — so
          // "add an apple to snacks" landed as a Quick Calories row with no
          // macros, and any mealNames customization silently mismatched the
          // hardcoded snack=3 default. log_food fixes both: real food + full
          // nutrition, meal index validated against the user's actual
          // mealNames, returned meal_name in the response so the AI cannot
          // hallucinate a wrong meal in its confirmation.
          const foodQuery = String(args?.food || '').trim();
          if (!foodQuery) return { error: 'food name is required.' };
          const mealIdxRaw = args?.meal;
          if (mealIdxRaw == null) return { error: 'meal index is required. Match the user\'s named meal to the YOUR MEALS list in the system prompt.' };
          const mNames = mealNames.get() || ['Breakfast','Lunch','Dinner','Snacks'];
          const mealIdx = Math.max(0, Math.min(mNames.length - 1, Math.round(Number(mealIdxRaw))));
          if (!Number.isFinite(Number(mealIdxRaw))) return { error: 'meal must be a numeric index.' };
          const mealName = mNames[mealIdx] || `Meal ${mealIdx + 1}`;
          const quantity = (() => {
            const q = Number(args?.quantity);
            return Number.isFinite(q) && q > 0 ? q : 1;
          })();
          const portionOverride = (() => {
            const p = Number(args?.portion);
            return Number.isFinite(p) && p > 0 ? p : null;
          })();
          const unitOverride = typeof args?.unit === 'string' && args.unit.trim() ? args.unit.trim() : null;
          const date = (typeof args?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(args.date)) ? args.date : localDateStr();

          // Tier 1: local catalog. Exact name (case-insensitive) wins; if no
          // exact, do a substring + brand-bias fuzzy match. The Foods.svelte
          // fuzzy matcher uses edit distance but we want stricter behavior
          // for AI-driven logging — fewer false positives matter more than
          // typo tolerance, because the AI restates the user's word verbatim.
          const _norm = s => String(s || '').toLowerCase().trim();
          const qNorm = _norm(foodQuery);
          let localFoods = [];
          try { localFoods = await NtApi.getFoods(); } catch {}
          const exactLocal = (localFoods || []).filter(f => _norm(f.name) === qNorm);
          if (exactLocal.length === 1) {
            // Single exact local hit — use it.
            const food = exactLocal[0];
            try {
              const item = {
                ...food,
                portion: portionOverride ?? food.portion ?? 100,
                unit:    unitOverride    ?? food.unit    ?? 'g',
                quantity,
              };
              const { addDiaryItem } = await import('../../stores/diary.js');
              await addDiaryItem(item, mealIdx, date);
              const kcal = Math.round(((food.nutrition?.calories || 0) * (item.portion / (food.portion || 100))) * quantity);
              return { ok: true, date, meal: mealIdx, meal_name: mealName, food_name: food.name, portion: item.portion, unit: item.unit, quantity, kcal, source: 'local' };
            } catch (e) {
              return { error: 'Failed to log food: ' + (e?.message || String(e)) };
            }
          }
          // Multiple exact local matches — return them so the AI can ask
          // the user which one (e.g. two "Apple" rows from different brands).
          if (exactLocal.length > 1) {
            return {
              candidates: exactLocal.slice(0, 5).map(f => ({
                name: f.name,
                brand: f.brand || '',
                portion: f.portion || 100,
                unit: f.unit || 'g',
                source: 'local',
              })),
              hint: `${exactLocal.length} local foods match "${foodQuery}" exactly. Ask the user which one (by brand or saved portion).`,
            };
          }
          // Substring local matches (no exact). Returned as candidates so
          // the AI can present them — we don't auto-pick because substring
          // matches are noisier than the AI's verbatim user-word.
          const substringLocal = (localFoods || []).filter(f => _norm(f.name).includes(qNorm));
          if (substringLocal.length > 0 && substringLocal.length <= 5) {
            return {
              candidates: substringLocal.map(f => ({
                name: f.name,
                brand: f.brand || '',
                portion: f.portion || 100,
                unit: f.unit || 'g',
                source: 'local',
              })),
              hint: `Found ${substringLocal.length} local food(s) containing "${foodQuery}". Ask the user which one (or none) before calling log_food again with the chosen name.`,
            };
          }
          // Tier 2: Open Food Facts (uses local mirror if admin enabled it).
          let offHits = [];
          try {
            const { API } = await import('../../lib/api.js');
            offHits = await API.searchByName(foodQuery, 1);
          } catch {}
          if (Array.isArray(offHits) && offHits.length > 0) {
            // Exact name match in OFF results — auto-pick and create in catalog.
            const exactOff = offHits.find(h => _norm(h.name) === qNorm);
            const pickedOff = exactOff || (offHits.length === 1 ? offHits[0] : null);
            if (pickedOff) {
              try {
                // Create in local catalog so future asks hit local tier and
                // the food row exists for the diary item to reference.
                const saved = await NtApi.createFood({ ...pickedOff, created_at: new Date().toISOString() });
                const item = {
                  ...saved,
                  portion: portionOverride ?? saved.portion ?? 100,
                  unit:    unitOverride    ?? saved.unit    ?? 'g',
                  quantity,
                };
                const { addDiaryItem } = await import('../../stores/diary.js');
                await addDiaryItem(item, mealIdx, date);
                const kcal = Math.round(((saved.nutrition?.calories || 0) * (item.portion / (saved.portion || 100))) * quantity);
                return { ok: true, date, meal: mealIdx, meal_name: mealName, food_name: saved.name, portion: item.portion, unit: item.unit, quantity, kcal, source: 'off' };
              } catch (e) {
                return { error: 'Failed to log food after OFF lookup: ' + (e?.message || String(e)) };
              }
            }
            // Multiple OFF hits, none exact — return top candidates for the
            // user to disambiguate.
            return {
              candidates: offHits.slice(0, 5).map(h => ({
                name: h.name,
                brand: h.brand || '',
                portion: h.portion || 100,
                unit: h.unit || 'g',
                source: 'off',
              })),
              hint: `Found ${offHits.length} Open Food Facts matches for "${foodQuery}". None is an exact name match — ask the user which one fits, then call log_food again with that exact name.`,
            };
          }
          // Tier 3: nothing matched. Tell the user how to add it.
          return {
            no_match: true,
            suggestion: `No local food and no Open Food Facts match for "${foodQuery}". The user should add it via the Foods tab — either scan a barcode or tap "+" to enter it manually — then ask again.`,
          };
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
        case 'propose_quick_calories': {
          // Does NOT write to the diary — returns a structured payload
          // the client renders as an editable Nutrition Facts card.
          // Same permission gate as log_quick_calories so the AI can't
          // dangle a "review" card for a user who has Quick Calories
          // off; tell it to fix Settings first.
          const enabled = DB.getSetting('showQuickCalories', true);
          if (!enabled) {
            return { error: 'Quick Calories logging is disabled. The user must turn on Settings → Diary → Show Quick Calories Button before you can propose a quick entry.' };
          }
          const nutrition = (args?.nutrition && typeof args.nutrition === 'object') ? args.nutrition : null;
          if (!nutrition || !Number.isFinite(Number(nutrition.calories)) || Number(nutrition.calories) <= 0) {
            return { error: 'nutrition.calories must be a positive number.' };
          }
          const mealIdx = args?.meal != null ? Math.max(0, Math.min(3, Math.round(Number(args.meal)))) : 3;
          const name = typeof args?.name === 'string' ? args.name.trim().slice(0, 60) : 'Estimated meal';
          const date = (typeof args?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(args.date)) ? args.date : localDateStr();
          const servingSize  = typeof args?.serving_size === 'string' ? args.serving_size.trim().slice(0, 80) : '';
          const sgRaw = Number(args?.serving_grams);
          const servingGrams = Number.isFinite(sgRaw) && sgRaw > 0 ? Math.round(sgRaw) : null;
          // Sanitize the nutrition payload: keep only numeric, non-negative
          // values keyed by known nutriment IDs. Strips garbage / hallucinated
          // keys so the rendered card stays clean.
          const knownIds = new Set(NUTRIMENTS.map(n => n.id));
          const clean = {};
          for (const [k, v] of Object.entries(nutrition)) {
            if (!knownIds.has(k)) continue;
            const n = Number(v);
            if (Number.isFinite(n) && n >= 0) clean[k] = Math.round(n * 10) / 10;
          }
          const payload = {
            name, meal: mealIdx, date,
            serving_grams: servingGrams,
            serving_size:  servingSize,
            nutrition: clean,
          };
          _pendingProposal = payload;
          _proposalCommitted = false;
          _proposalCommittedKcal = 0;
          // Clear any in-flight food proposal — two cards stacked in one
          // turn would be confusing.
          _pendingFoodProposal = null;
          return { ok: true, kind: 'quick_calories_proposal', ...payload };
        }
        case 'propose_food': {
          // Does NOT create a food, does NOT log to diary. Surfaces a
          // review card with three exits: Discard / Save to Catalog /
          // Save & Log to Diary. The card lets the user pick the meal at
          // commit time if they choose the log path.
          const nutrition = (args?.nutrition && typeof args.nutrition === 'object') ? args.nutrition : null;
          if (!nutrition || !Number.isFinite(Number(nutrition.calories)) || Number(nutrition.calories) <= 0) {
            return { error: 'nutrition.calories must be a positive number.' };
          }
          const name  = typeof args?.name === 'string' ? args.name.trim().slice(0, 60) : '';
          if (!name) return { error: 'name is required and must be a non-empty string.' };
          const brand = typeof args?.brand === 'string' ? args.brand.trim().slice(0, 60) : '';
          const portionRaw = Number(args?.portion);
          const portion = Number.isFinite(portionRaw) && portionRaw > 0 ? Math.round(portionRaw) : 100;
          const unit  = (typeof args?.unit === 'string' && args.unit.trim()) ? args.unit.trim().slice(0, 16) : 'g';
          const mealHint = args?.meal_hint != null ? Math.max(0, Math.min(3, Math.round(Number(args.meal_hint)))) : 3;
          const notes    = typeof args?.notes === 'string' ? args.notes.trim().slice(0, 120) : '';
          const knownIds = new Set(NUTRIMENTS.map(n => n.id));
          const clean = {};
          for (const [k, v] of Object.entries(nutrition)) {
            if (!knownIds.has(k)) continue;
            const n = Number(v);
            if (Number.isFinite(n) && n >= 0) clean[k] = Math.round(n * 10) / 10;
          }
          const payload = { name, brand, portion, unit, nutrition: clean, meal_hint: mealHint, notes };
          _pendingFoodProposal = payload;
          _foodProposalCommitted = false;
          _foodProposalCommittedKind = '';
          _foodProposalCommittedMealIdx = mealHint;
          _pendingProposal = null;
          return { ok: true, kind: 'food_proposal', ...payload };
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
          language: _resolveVoiceLang(),
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
        showError($_('common.errors.voice_unsupported'));
        return;
      }
      try {
        const rec = new SR();
        rec.continuous = false;
        rec.interimResults = false;
        rec.lang = _resolveVoiceLang();
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
        showError($_('common.errors.cant_start_mic') + ': ' + e.message);
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

    // Issue #79: meal-name mapping injected into the prompt so the AI can
    // reliably translate "snacks", "lunch", etc. into the user's actual
    // meal indices. Previously the system prompt hardcoded
    // "snack/snacks=3", which silently mis-routed for users who had
    // reordered or renamed their meals — the AI would pass meal=3
    // thinking it was Snacks, but their index 3 might be Dinner. Listing
    // the actual mapping eliminates the ambiguity.
    const mealNamesText = mNames
      .map((n, i) => `  ${i} = ${n}`)
      .join('\n');

    return { today, userName, profileText, diaryText, goalsText, statsText, wellnessText, waterText, streakText, mealNamesText,
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

YOUR MEALS (the user's meal slots, by position — pass these indices to any tool with a \`meal\` parameter):
${ctx.mealNamesText}

When the user names a meal ("lunch", "snacks", "second breakfast", anything they call it), find the matching entry in YOUR MEALS above and pass its index number. NEVER hardcode 0=breakfast / 1=lunch / 2=dinner / 3=snacks — that's only correct for the default meal layout, and users can rename or reorder meals. If the user's phrasing doesn't clearly map to one of YOUR MEALS, ASK them which meal they mean.

LOGGING A REAL FOOD — When the user wants to add a NAMED food to their diary ("add an apple to snacks", "log Greek yogurt for breakfast", "add 200g of chicken to dinner", "two slices of bread for lunch", "I had a Chobani yogurt"), use log_food. This is the PRIMARY food-logging path and stores full nutrition (protein, carbs, fat, fiber, sodium, vitamins, etc.). Rules:
- Pass the food name as the user said it. log_food searches the user's local catalog first, then Open Food Facts.
- Pass the meal index per YOUR MEALS above.
- For "1 apple", "a banana" — just pass food + meal; portion defaults to the food's stored serving size.
- For "200g of X" — pass portion=200, unit="g". For "two apples" — pass quantity=2 (and leave portion/unit as defaults).
- If the tool returns \`candidates\`, present the names back to the user and ask which one; then call log_food again with the chosen name as the \`food\` field.
- If the tool returns \`no_match\`, tell the user to add it via the Foods tab (barcode scan or manual entry) and then try again.
- DO NOT use log_quick_calories when the user names a food. Quick Calories is ONLY for kcal-number asks.
- When the tool returns ok:true, confirm using the \`meal_name\` and \`food_name\` from the tool result — do not assume the meal name from the index you passed. This is how you avoid telling the user "I added X to snacks" when it actually went to a different meal.

LOGGING QUICK CALORIES — When the user gives a kcal number WITH NO FOOD NAME ("log 200 calories for lunch", "punch in 1200 kJ for dinner", "add 350 quick calories"), use log_quick_calories. This is the Fitbit-style quick-add path; no food row is created. Rules:
- If the user gave kJ, convert to kcal yourself: kcal = kj / 4.184. Pass the kcal number.
- Pass the meal index per YOUR MEALS above.
- Optional name field: if the user said "for office snack" or similar, pass that as name (max 60 chars).
- If the user named a food ("apple", "banana", "chicken breast"), use log_food NOT log_quick_calories.
- Tool refuses kcal=0 and refuses if the user has disabled Quick Calories in Settings — relay any error message verbatim.

PHOTO MEAL HANDLING — When the user attaches a MEAL PHOTO, never write to the diary directly. The user's intent decides which of these four paths you take:

1. INFO ONLY ("what is this?", "how many calories in this?", "is this healthy?", "tell me about this"): do NOT call any propose_* or log_* tool. Just describe what you see and give a brief nutrition estimate in plain text. The user is asking a question, not logging anything.

2. QUICK CALORIES PROPOSAL ("log this", "add this as quick calories", "throw this in for lunch", "just kcal it"): call propose_quick_calories. This surfaces an editable card. The food does NOT get saved as a reusable food row, just a kcal+macros diary entry for that day.

3. FOOD CATALOG PROPOSAL ("save this as a food", "add to my foods", "remember this for later", "create a food entry"): call propose_food. The card has a "Save to Foods" button. No diary write unless the user picks "Save & Add to Diary" on the same card.

4. FOOD + DIARY ("add this as a food entry to lunch", "save this and log it", "log this as a real food, not quick calories"): also call propose_food. The user picks the meal on the card and taps "Save & Add to Diary".

CRITICAL RULES for propose_quick_calories and propose_food:
- These tools DO NOT WRITE anything. They only surface a review card.
- When the tool returns ok:true, that means THE CARD WAS SHOWN, not "the food was logged". NEVER say things like "I've added X to your diary" or "Logged X to lunch" or "Saved X to your catalog" — the user has NOT yet confirmed.
- After calling, say something like "Here's my estimate — review and tap Add to Diary" (quick) or "Here's my estimate — pick Save to Foods or Save & Add to Diary" (food). Don't repeat the numbers in chat; the card shows them.

NUTRITION HONESTY RULES (applies to BOTH propose tools):
- The nutrition numbers you pass MUST be internally consistent with the serving you claim. If you say "350 kcal per 250 g of Chicken Pot Pie", those 350 kcal must actually correspond to ~250 g of that specific food based on real nutrition data — NOT a plausible-sounding number you invented to fill the schema.
- If you genuinely don't have a reliable basis (the food is unrecognizable, lighting is bad, the portion is impossible to gauge), DO NOT GUESS. Say so explicitly: "I can't reliably estimate this from the photo — what is it, and roughly how much (in grams or a familiar measure)?" The user prefers an honest "I don't know" over a fabricated 400 kcal that's actually 700.
- Always estimate serving_grams (for quick) or portion+unit (for food) from the photo whenever possible. "Per serving" is meaningless without a weight; without it the user has nothing to sanity-check against.

NUTRITION COVERAGE — populate the full profile:
- The nutrition object is keyed by NutriTrace nutriment IDs. The complete list of supported keys is: ${NUTRIMENT_ID_LIST}.
- You are EXPECTED to estimate every key the food contains in a non-trivial amount, not just the four headline macros. A typical entry should include fiber, sugars, sodium, saturated-fat, and cholesterol whenever the food has them; common foods should also carry calcium, iron, potassium, and any prominent vitamins.
- The honesty rule still applies — every value must be a real estimate grounded in the food's typical profile, scaled to the portion. Don't fabricate to look thorough. But DO take the time to think through what's actually in the food rather than stopping at calories/protein/carbs/fat.
- Omit a key only when the value would genuinely round to ~0 (e.g. cholesterol in a salad) or you have no reasonable basis to estimate it.`
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
    // Clear any COMMITTED-state proposal indicators when the user sends
    // a new message. The "Logged X kcal to Lunch" / "Saved to Foods"
    // indicators were sticking around past the turn that committed them,
    // so subsequent messages still rendered them under the card slot
    // and read as "the card keeps coming back" to the user. Leaving the
    // pending-but-uncommitted state alone so a user who's mid-review
    // can't lose their unconfirmed card by sending an aside.
    if (_proposalCommitted)     { _pendingProposal = null;     _proposalCommitted = false; _proposalCommittedKcal = 0; }
    if (_foodProposalCommitted) { _pendingFoodProposal = null; _foodProposalCommitted = false; _foodProposalCommittedKind = ''; }
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
      // If image attached, modify the last user message to include it.
      // Env-locked path uses the proxy's OpenAI-shape wire format
      // regardless of the underlying provider — the server translates to
      // Claude / Gemini at the boundary.
      if (image) {
        const lastIdx = apiMessages.length - 1;
        // Env-locked deployments always speak OpenAI wire shape over the
        // proxy (the server normalises for Claude/Gemini). `oai-compat`
        // endpoints (e.g. LiteLLM in front of Bedrock) also want OpenAI
        // shape natively, regardless of env-lock. #114.
        const imgProvider = (aiEnvLocked || provider === 'oai-compat') ? 'openai' : provider;
        apiMessages[lastIdx] = _buildImageMessage(imgProvider, content || 'What is this?', image);
      }
      const onToolCall = (toolName) => { _toolStatus = `Fetching ${toolName.replace(/_/g, ' ')}…`; };
      // Photo turn: REMOVE the silent-write tool (log_quick_calories) so
      // the photo path is forced through propose_quick_calories /
      // propose_food, which both surface a review card. Mini-class
      // models (gpt-4o-mini and friends) cannot be trusted to honor
      // "use propose_X instead of log_X" prose in the system prompt
      // when the user's verb matches a write tool's purpose.
      //
      // Text-only turn: REMOVE the propose_* tools so a mini model that
      // saw a previous propose_* call in chat history doesn't re-call
      // them on a follow-up text question ("kept showing me the
      // nutrition card" — the propose card kept re-rendering because
      // the chat history primed the model to keep calling propose_*).
      // Stripping the tools from the schema is bulletproof; the model
      // physically cannot call a tool that isn't in the schema this
      // round.
      const toolsForRound = image
        ? TOOLS.filter(t => t.name !== 'log_quick_calories')
        : TOOLS.filter(t => t.name !== 'propose_quick_calories'
                         && t.name !== 'propose_food');
      const reply = aiEnvLocked
        ? await callAIProxy({ messages: apiMessages, systemPrompt, tools: toolsForRound, onToolCall })
        : await callAI({ provider, apiKey: key, model, baseUrl, messages: apiMessages, systemPrompt, tools: toolsForRound, onToolCall });
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
    } else if (provider === 'openai' || provider === 'oai-compat') {
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
    // Clear ANY pending review card so a cleared chat doesn't strand a
    // proposal floating with no context above it. Covers both flows:
    // propose_quick_calories (_pendingProposal) AND propose_food
    // (_pendingFoodProposal). Earlier version only cleared the quick
    // one, leaving the food card visible after Clear.
    _pendingProposal = null;
    _proposalCommitted = false;
    _proposalCommittedKcal = 0;
    _pendingFoodProposal = null;
    _foodProposalCommitted = false;
    _foodProposalCommittedKind = '';
    _foodProposalCommittedMealIdx = 0;
  }

  function quickAsk(q) { input = q; send(); }

  /** User reviewed the AI's photo-log estimate and tapped Discard. Clears
   *  the card from the chat without writing to the diary. */
  function _discardProposal() {
    _pendingProposal = null;
    _proposalCommitted = false;
    _proposalCommittedKcal = 0;
  }

  /** User reviewed the AI's photo-log estimate and tapped Add to Diary.
   *  Commits via the existing addQuickCalories store helper (same path the
   *  log_quick_calories tool uses) and transitions the card to a small
   *  "Logged X kcal to <meal>" confirmation row. The meal selected on the
   *  card (which may differ from the AI's guess) is what's used. */
  async function _commitProposal() {
    if (!_pendingProposal) return;
    const p = _pendingProposal;
    const kcal = Math.max(0, Math.round(Number(p.nutrition?.calories) || 0));
    if (!kcal) {
      showError('Cannot log: estimated calories is 0.');
      return;
    }
    const optMacro = v => {
      if (v == null) return undefined;
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? n : undefined;
    };
    try {
      const { addQuickCalories } = await import('../../stores/diary.js');
      await addQuickCalories({
        kcal,
        name: p.name,
        meal: p.meal,
        date: p.date,
        proteins:      optMacro(p.nutrition?.proteins),
        carbohydrates: optMacro(p.nutrition?.carbohydrates),
        fat:           optMacro(p.nutrition?.fat),
      });
      _proposalCommittedKcal = kcal;
      _proposalCommitted = true;
    } catch (e) {
      showError($_('common.errors.save_failed') + ': ' + (e?.message || String(e)));
    }
  }

  // ── propose_food review card commit handlers ─────────────────────────────
  // Three exits from the food review card:
  //   _discardFoodProposal     — drop without writing anywhere
  //   _commitFoodCatalogOnly   — POST /api/foods, no diary touch
  //   _commitFoodAndLog        — POST /api/foods, then addDiaryItem at the
  //                              meal the user picked on the card

  function _discardFoodProposal() {
    _pendingFoodProposal = null;
    _foodProposalCommitted = false;
    _foodProposalCommittedKind = '';
  }

  /** Save the proposed food to /api/foods only. No diary write. */
  async function _commitFoodCatalogOnly() {
    if (!_pendingFoodProposal) return;
    try {
      await _saveProposedFood();
      _foodProposalCommittedKind = 'catalog';
      _foodProposalCommitted = true;
    } catch (e) {
      showError($_('common.errors.save_failed') + ': ' + (e?.message || String(e)));
    }
  }

  /** Save the proposed food AND log a portion of it to the user's diary
   *  at the meal they picked on the card. Two steps because diary items
   *  need an existing food row (the diary item references the food). */
  async function _commitFoodAndLog() {
    if (!_pendingFoodProposal) return;
    try {
      const food = await _saveProposedFood();
      const p    = _pendingFoodProposal;
      const { addDiaryItem } = await import('../../stores/diary.js');
      // Log one full portion (the nutrition values are per-portion as
      // saved on the food row, so portion=1 here means "one serving").
      await addDiaryItem({
        ...food,
        portion: p.portion,
        unit:    p.unit,
      }, _foodProposalCommittedMealIdx, localDateStr());
      _foodProposalCommittedKind = 'logged';
      _foodProposalCommitted = true;
    } catch (e) {
      showError($_('common.errors.save_failed') + ': ' + (e?.message || String(e)));
    }
  }

  /** Shared step: POST the proposed food to /api/foods. Returns the
   *  server's response so the caller can chain a diary write off it.
   *  notes goes into the food's notes column; gets surfaced in the
   *  diary when "Show item notes" is enabled. */
  async function _saveProposedFood() {
    const p = _pendingFoodProposal;
    return NtApi.createFood({
      name:      p.name,
      brand:     p.brand || null,
      portion:   p.portion,
      unit:      p.unit,
      nutrition: p.nutrition,
      notes:     p.notes || null,
      visibility: 'private',
    });
  }
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

          <!-- Photo-log review card. Renders below the most recent
               assistant message when propose_quick_calories has fired
               but the user hasn't committed or discarded yet. Card
               itself is the shared NutritionFactsBox (CookTrace parity);
               action footer + post-commit confirmation are local.
               Meal picker lets the user override the AI's meal guess
               before tapping Add to Diary. -->
          {#if _pendingProposal}
            <div class="ai-msg">
              <div class="ai-msg-avatar">
                <TraceFace size={24} />
              </div>
              <div class="ai-msg-body" style="width:100%">
                {#if !_proposalCommitted}
                  <div class="proposal-header">
                    <div class="proposal-name">{_pendingProposal.name}</div>
                    {#if _pendingProposal.serving_grams || _pendingProposal.serving_size}
                      <div class="proposal-serving">
                        {#if _pendingProposal.serving_grams}
                          ~{_pendingProposal.serving_grams} g{#if _pendingProposal.serving_size} ({_pendingProposal.serving_size}){/if}
                        {:else}
                          {_pendingProposal.serving_size}
                        {/if}
                      </div>
                    {/if}
                  </div>
                  <NutritionFactsBox
                    nutrition={_pendingProposal.nutrition}
                    servingDescription={_pendingProposal.serving_grams ? `${_pendingProposal.serving_grams} g${_pendingProposal.serving_size ? ' (' + _pendingProposal.serving_size + ')' : ''}` : (_pendingProposal.serving_size || 'per serving')}
                    forceShowAll={true} />
                  <div class="proposal-meal-picker">
                    <label>
                      Meal
                      <select bind:value={_pendingProposal.meal}>
                        {#each (mealNames.get() || ['Breakfast','Lunch','Dinner','Snacks']) as mn, mi}
                          <option value={mi}>{mn}</option>
                        {/each}
                      </select>
                    </label>
                  </div>
                  <div class="proposal-actions">
                    <button class="btn btn-secondary btn-sm" on:click={_discardProposal}>
                      Discard
                    </button>
                    <button class="btn btn-primary btn-sm" on:click={_commitProposal}>
                      <span class="material-symbols-rounded" style="font-size:16px">add</span>
                      Add to Diary
                    </button>
                  </div>
                {:else}
                  <div class="proposal-committed">
                    <span class="material-symbols-rounded" style="font-size:18px;color:var(--accent)">check_circle</span>
                    Logged {_proposalCommittedKcal} kcal to {(mealNames.get() || ['Breakfast','Lunch','Dinner','Snacks'])[_pendingProposal.meal] || 'meal'}
                  </div>
                {/if}
              </div>
            </div>
          {/if}

          <!-- propose_food review card. Two commit paths (Save to
               Catalog vs Save & Log to Diary); meal picker is only
               relevant for the log path. -->
          {#if _pendingFoodProposal}
            <div class="ai-msg">
              <div class="ai-msg-avatar">
                <TraceFace size={24} />
              </div>
              <div class="ai-msg-body" style="width:100%">
                {#if !_foodProposalCommitted}
                  <div class="proposal-header">
                    <div class="proposal-name">
                      {_pendingFoodProposal.name}{#if _pendingFoodProposal.brand} <span class="proposal-brand">— {_pendingFoodProposal.brand}</span>{/if}
                    </div>
                    <div class="proposal-serving">
                      Per {_pendingFoodProposal.portion} {_pendingFoodProposal.unit}
                    </div>
                  </div>
                  <NutritionFactsBox
                    nutrition={_pendingFoodProposal.nutrition}
                    servingDescription={`${_pendingFoodProposal.portion} ${_pendingFoodProposal.unit}`}
                    forceShowAll={true} />
                  <div class="proposal-meal-picker">
                    <label>
                      If logging, meal:
                      <select bind:value={_foodProposalCommittedMealIdx}>
                        {#each (mealNames.get() || ['Breakfast','Lunch','Dinner','Snacks']) as mn, mi}
                          <option value={mi}>{mn}</option>
                        {/each}
                      </select>
                    </label>
                  </div>
                  <div class="proposal-actions proposal-actions-wide">
                    <button class="btn btn-secondary btn-sm" on:click={_discardFoodProposal}>
                      Discard
                    </button>
                    <button class="btn btn-secondary btn-sm" on:click={_commitFoodCatalogOnly}>
                      <span class="material-symbols-rounded" style="font-size:16px">bookmark_add</span>
                      Save to Foods
                    </button>
                    <button class="btn btn-primary btn-sm" on:click={_commitFoodAndLog}>
                      <span class="material-symbols-rounded" style="font-size:16px">add</span>
                      Save & Add to Diary
                    </button>
                  </div>
                {:else}
                  <div class="proposal-committed">
                    <span class="material-symbols-rounded" style="font-size:18px;color:var(--accent)">check_circle</span>
                    {#if _foodProposalCommittedKind === 'logged'}
                      Saved {_pendingFoodProposal.name} to your foods + logged to {(mealNames.get() || ['Breakfast','Lunch','Dinner','Snacks'])[_foodProposalCommittedMealIdx] || 'meal'}
                    {:else}
                      Saved {_pendingFoodProposal.name} to your food catalog
                    {/if}
                  </div>
                {/if}
              </div>
            </div>
          {/if}
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

  /* Photo-log review card — wraps the NutritionFactsBox with a small
     header (AI-estimated name + serving description) and an action
     footer (Discard / Add to Diary). Card itself stays FDA-style black
     on white so it reads as the official label even in dark mode. */
  .proposal-header {
    display: flex; flex-direction: column;
    gap: 2px;
    margin-bottom: 8px;
  }
  .proposal-name {
    font-size: 14px; font-weight: 600;
    color: var(--text-1);
  }
  .proposal-serving {
    font-size: 12px; color: var(--text-3);
  }
  .proposal-actions {
    display: flex; gap: 8px;
    margin-top: 12px;
    justify-content: flex-end;
  }
  /* propose_food has three buttons — let them wrap on narrow viewports. */
  .proposal-actions-wide { flex-wrap: wrap; }
  .proposal-actions .btn {
    display: inline-flex; align-items: center; gap: 4px;
  }
  .proposal-brand {
    font-weight: 400; color: var(--text-3); font-size: 12px;
  }
  /* Meal selector that lets the user override the AI's meal guess
     before the food is logged. */
  .proposal-meal-picker {
    margin-top: 10px;
    display: flex; align-items: center;
  }
  .proposal-meal-picker label {
    display: inline-flex; align-items: center; gap: 8px;
    font-size: 13px; color: var(--text-2);
  }
  .proposal-meal-picker select {
    background: var(--surface-2); color: var(--text-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 4px 8px;
    font-size: 13px;
  }
  .proposal-committed {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 10px 14px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    font-size: 13px; color: var(--text-2);
  }
</style>
