<script>
  import { onMount } from 'svelte';
  import { slide } from 'svelte/transition';
  import { _ } from 'svelte-i18n';
  import { push } from 'svelte-spa-router';
  import { DB, localDateStr } from '../lib/db.js';
  import { NtApi } from '../lib/api.js';
  import { portal } from '../lib/portal.js';
  import { goals, goalTemplates, energyUnit, weightUnit, heightUnit, lengthUnit, visibleNutriments, hiddenBodyStats, waterGoalMl, waterUnit, pageBanners, bannerStyle, wellnessEnabled, fitbitEnabled, garminEnabled, googleHealthEnabled, healthConnectEnabled, fitbitFamilyEnabled, calorieGoalMode, calorieGoalFactor } from '../stores/settings.js';
  import { NUTRIMENTS, Nutrition } from '../lib/nutrition.js';
  import { readBodyStat } from '../lib/body-stats-unit.js';
  import { decimalInput, parseDecimal } from '../lib/decimal-input.js';
  import { loadEntry } from '../stores/diary.js';
  import { showSuccess } from '../stores/toast.js';
  import MacroRing from '../components/diary/MacroRing.svelte';

  // Mirror settings/Goals.svelte: any wearable that reports calorie burn
  // unlocks Dynamic mode. Uses the shared derived fitbitFamilyEnabled so
  // adding a new source doesn't silently disable the button.
  $: _hasWearable = $fitbitFamilyEnabled || $garminEnabled;

  const BODY_STATS = [
    { id: 'weight',     label: 'Weight',     isBody: true },
    { id: 'neck',       label: 'Neck',       isBody: true },
    { id: 'waist',      label: 'Waist',      isBody: true },
    { id: 'hips',       label: 'Hips',       isBody: true },
    { id: 'chest',      label: 'Chest',      isBody: true },
    { id: 'thighs',     label: 'Thighs',     isBody: true },
    { id: 'biceps',     label: 'Biceps',     isBody: true },
    { id: 'calves',     label: 'Calves',     isBody: true },
    { id: 'body_fat',   label: 'Body Fat',   isBody: true, unit: '%' },
    { id: 'body_water', label: 'Body Water', isBody: true, unit: '%' },
  ];

  $: wUnit = $weightUnit || 'kg';
  $: hUnit = $heightUnit || 'cm';
  $: lUnit = $lengthUnit || 'in';
  $: bodyStatsWithUnit = BODY_STATS.map(s => ({
    ...s,
    unit: s.unit || (s.id === 'weight' ? wUnit : lUnit)
  }));

  // All nutrients filtered only by energy unit — used in Goals so you can set
  // goals for any nutrient regardless of diary visibility settings
  $: allNutrients = NUTRIMENTS.filter(n => {
    if (n.id === 'kilojoules' && ($energyUnit||'kcal') === 'kcal') return false;
    if (n.id === 'calories'   && ($energyUnit||'kcal') === 'kJ') return false;
    return true;
  });

  // Wellness goal fields (shown when wellness is enabled)
  const WELLNESS_GOALS = [
    // Fitbit — Movement
    { id: 'steps',              label: 'Daily Steps',       unit: 'steps', isWellness: true },
    { id: 'active_minutes',     label: 'Active Minutes',    unit: 'min',   isWellness: true },
    { id: 'floors',             label: 'Floors Climbed',    unit: 'floors',isWellness: true },
    { id: 'calories_out',       label: 'Calories Burned',   unit: 'kcal',  isWellness: true },
    // Fitbit — Sleep
    { id: 'sleep_duration_min', label: 'Sleep Duration',    unit: 'min',   isWellness: true },
    { id: 'sleep_efficiency',   label: 'Sleep Efficiency',  unit: '%',     isWellness: true },
    // Fitbit — Heart
    { id: 'hrv_daily_rmssd',    label: 'HRV (RMSSD)',       unit: 'ms',    isWellness: true },
    // Withings — Body
    { id: 'weight_kg',          label: 'Target Weight',     unit: 'kg',    isWellness: true },
    { id: 'body_fat_pct',       label: 'Target Body Fat',   unit: '%',     isWellness: true },
    { id: 'muscle_mass_kg',     label: 'Target Muscle Mass',unit: 'kg',    isWellness: true },
  ];

  // All fields for goal-setting: all body stats + all nutrients + wellness if enabled
  $: wellnessFields = $wellnessEnabled ? WELLNESS_GOALS : [];
  $: allFields = [...bodyStatsWithUnit, ...allNutrients, ...wellnessFields];
  // Your Goals: categorized
  $: configuredBodyStats = bodyStatsWithUnit.filter(s => $goals[s.id]);
  // Alias-aware lookup: after #146 the Kilojoules stat is a display alias
  // for Calories in kJ mode, so its storage key is 'calories'. Reading
  // $goals[s.id] raw for a kilojoules stat always misses the migrated goal.
  $: configuredNutrients = allNutrients.filter(s => $goals[_goalStorageId(s.id)]);
  // Your Goals tab strips P/C/F from Nutrients because they're
  // owned by the Macros card above — otherwise the same field
  // appears twice with the same value + separate edit tap. The
  // Macros card is the single source of truth for macro editing;
  // All Fields tab still lists them for completeness.
  $: yourGoalsNutrients = configuredNutrients.filter(s =>
    s.id !== 'proteins' && s.id !== 'carbohydrates' && s.id !== 'fat'
  );
  $: configuredWellness  = wellnessFields.filter(s => $goals[s.id]);
  $: hasAnyGoal = configuredBodyStats.length > 0 || configuredNutrients.length > 0 || configuredWellness.length > 0;

  let activeTab = 'yours'; // 'yours' | 'all' | 'templates'

  // ── Goal templates ─────────────────────────────────────────────────────────
  let showSaveSheet    = false;
  let templateName     = '';
  let showApplyConfirm = null; // template object pending apply

  function openSaveSheet() {
    templateName = '';
    showSaveSheet = true;
  }

  function saveTemplate() {
    const name = templateName.trim();
    if (!name) return;
    const goalCount = Object.keys($goals).filter(k => $goals[k]?.min != null || $goals[k]?.max != null).length
      + ($waterGoalMl > 0 ? 1 : 0);
    const tpl = {
      id:        Date.now(),
      name,
      createdAt: new Date().toISOString(),
      goals:     { ...$goals },
      waterGoalMl: $waterGoalMl,
      goalCount,
    };
    goalTemplates.update(list => [...list, tpl]);
    showSaveSheet = false;
    showSuccess($_('goals.toast.template_saved'));
  }

  // #146 storage migration. Called from both onMount (for legacy $goals on
  // page load) and applyTemplate (for legacy templates saved under the old
  // schema). Converts $goals.kilojoules to $goals.calories at the kcal
  // boundary and deletes the legacy key. If the legacy entry only carried
  // per-day values (no shared max/min), the days array is still migrated
  // instead of being silently discarded.
  function _migrateKilojoulesGoal(g) {
    if (!g || !g.kilojoules) return g;
    const next = { ...g };
    if (!next.calories && next.kilojoules) {
      const kj = next.kilojoules;
      const daysArr = Array.isArray(kj.days) ? kj.days : null;
      const hasDays = daysArr && daysArr.some(v => v != null && Number.isFinite(v) && v > 0);
      const shared = kj.max ?? kj.min;
      const hasShared = shared != null && Number.isFinite(shared) && shared > 0;
      if (hasShared || hasDays) {
        next.calories = {
          ...kj,
          max: kj.max != null ? kj.max / 4.184 : undefined,
          min: kj.min != null ? kj.min / 4.184 : undefined,
          days: daysArr ? daysArr.map(v => v != null ? v / 4.184 : null) : undefined,
        };
        Object.keys(next.calories).forEach(k => next.calories[k] === undefined && delete next.calories[k]);
      }
    }
    delete next.kilojoules;
    return next;
  }

  function applyTemplate(tpl) {
    goals.set(_migrateKilojoulesGoal({ ...tpl.goals }));
    if (tpl.waterGoalMl != null) waterGoalMl.set(tpl.waterGoalMl);
    showApplyConfirm = null;
    activeTab = 'yours';
    showSuccess($_('goals.toast.template_applied', { values: { name: tpl.name } }));
  }

  function deleteTemplate(id) {
    goalTemplates.update(list => list.filter(t => t.id !== id));
  }

  function formatDate(iso) {
    return new Date(iso).toLocaleDateString(undefined, { year:'numeric', month:'short', day:'numeric' });
  }
  let today = localDateStr();
  let todayTotals = {};
  let todayBodyStats = {};
  // Most-recent body-stat readings within the last 30 days, used as a
  // fallback when today's body_stats has no value for a given metric.
  // Shape: { [stat_id]: { value, date } }. Lets users who don't weigh /
  // measure every day still see their goal progress against their most
  // recent reading instead of "—". A subtle "as of <date>" subtext under
  // the value tells the user the number isn't from today. (Issue #46,
  // duplaja.) Only applies to body-stat goals (weight, body fat,
  // circumference measurements); nutrient + water + wellness goals reset
  // daily and intentionally don't fall back.
  let recentBodyStats = {};
  let todayWaterMl = 0;
  let todayWellness    = {}; // merged fitbit + garmin for today
  let _wellnessLoaded  = false;

  // Dynamic calorie goal support
  let _dynamicCaloriesOut = null;
  // Adaptive TDEE — server-computed from 35-day weight + intake trend
  let _adaptive = null; // { ready, daysAvailable, daysRequired, tdee, trendKgPerWeek, confidence, weightSource }
  let _adaptiveLoaded = false;
  let _showAdaptiveHelp = false;
  $: _fixedGoal = $goals.calories?.max ?? $goals.calories?.min ?? 2000;
  $: _effectiveCalGoal =
       ($calorieGoalMode === 'dynamic' && _dynamicCaloriesOut != null)
         ? Math.round(_dynamicCaloriesOut * $calorieGoalFactor)
       : ($calorieGoalMode === 'adaptive' && _adaptive?.ready && _adaptive.tdee != null)
         ? Math.round(_adaptive.tdee * $calorieGoalFactor)
       : _fixedGoal;

  // The Fitbit /data endpoint already merges Fitbit + Health Connect rows,
  // and Google Health Web API writes its rows tagged source='fitbit'. So
  // one call covers fitbit + google-health + health-connect; the shared
  // derived store ($fitbitFamilyEnabled) is the canonical gate.
  async function loadWellnessToday() {
    _wellnessLoaded = true;
    let fitbit = {}, garmin = {};
    try { if ($fitbitFamilyEnabled) { const r = await NtApi.get(`/api/wellness/fitbit/data?date=${today}`); fitbit = r[today] || {}; } } catch {}
    try { if ($garminEnabled) { const r = await NtApi.get(`/api/wellness/garmin/data?date=${today}`); garmin = r[today] || {}; } } catch {}
    todayWellness = { ...fitbit, ...garmin };
  }

  // Fire as soon as settings stores resolve true — avoids the first-load race
  // where onMount ran before settings loaded from server (both start false).
  $: if (($fitbitFamilyEnabled || $garminEnabled) && !_wellnessLoaded) loadWellnessToday();

  onMount(async () => {
    // #146 migration on page load. See _migrateKilojoulesGoal above.
    goals.update(_migrateKilojoulesGoal);

    // Load diary data first — don't block on server calls
    const entry = await NtApi.getDiaryDate(today).catch(() => null);
    if (entry) {
      todayBodyStats = entry.body_stats || entry.bodyStats || {};
      todayTotals = Nutrition.sum((entry.items || []).map(i => Nutrition.calculate(i)));
      todayWaterMl = (entry.water || []).reduce((s, l) => s + (l.amount || 0), 0);
    }
    // Body-stat fallback history (issue #46): for each body-stat metric,
    // find the most recent reading within the last 30 days. getTodayValue
    // uses this when today's row has no entry for the stat so progress
    // bars don't sit empty for users who weigh weekly. Older than 30 days
    // = no fallback (encourages re-measuring instead of showing a months-
    // old value as "current"). Single bulk fetch + linear scan; cheap.
    try {
      const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 30);
      const cutoffStr = localDateStr(cutoff);
      const all = await NtApi.getAllDiary().catch(() => []);
      const recent = (all || [])
        .filter(e => e?.date && e.date >= cutoffStr && e.date <= today)
        .sort((a, b) => b.date.localeCompare(a.date));   // newest first
      const found = {};
      for (const e of recent) {
        const bs = e.body_stats || e.bodyStats || {};
        for (const stat of BODY_STATS) {
          if (found[stat.id]) continue;
          const v = readBodyStat(bs, stat.id, $weightUnit, $lengthUnit);
          if (v != null) found[stat.id] = { value: v, date: e.date };
        }
      }
      recentBodyStats = found;
    } catch {}
    // Dynamic goal from server — non-blocking
    if ($calorieGoalMode === 'dynamic') {
      NtApi.get(`/api/wellness/calories-out?date=${today}`)
        .then(r => { _dynamicCaloriesOut = r.calories_out; })
        .catch(() => { _dynamicCaloriesOut = null; });
    }
    // Adaptive TDEE — fetch even when not the active mode so the readiness
    // card shows progress while a user is building up data toward enabling it.
    NtApi.get('/api/goals/adaptive-tdee')
      .then(r => { _adaptive = r; _adaptiveLoaded = true; })
      .catch(() => { _adaptive = null; _adaptiveLoaded = true; });
  });

  // ── Water goal helpers ────────────────────────────────────────────────────
  function mlToDisplay(ml, unit) {
    if (unit === 'oz') return +(ml / 29.5735).toFixed(1);
    if (unit === 'L')  return +(ml / 1000).toFixed(2);
    if (unit === 'G')  return +(ml / 3785.41).toFixed(3);
    return Math.round(ml);
  }
  function displayToMl(val, unit) {
    const n = parseDecimal(val) || 0;
    if (unit === 'oz') return Math.round(n * 29.5735);
    if (unit === 'L')  return Math.round(n * 1000);
    if (unit === 'G')  return Math.round(n * 3785.41);
    return Math.round(n);
  }

  let editWaterOpen = false;
  let editWaterVal = '';
  function openEditWater() {
    editWaterVal = String(mlToDisplay($waterGoalMl, $waterUnit));
    editWaterOpen = true;
  }
  function saveWaterGoal() {
    waterGoalMl.set(displayToMl(editWaterVal, $waterUnit));
    editWaterOpen = false;
    showSuccess($_('goals.toast.water_goal_saved'));
  }

  $: waterGoalDisplay = mlToDisplay($waterGoalMl, $waterUnit);
  $: waterTodayDisplay = mlToDisplay(todayWaterMl, $waterUnit);
  $: waterPct = $waterGoalMl > 0 ? Math.min(100, Math.round(todayWaterMl / $waterGoalMl * 100)) : 0;

  // ── Edit state ────────────────────────────────────────────────────────────
  let editOpen = false;
  let editStat = null;
  let editShared = true;
  let editIsMin = false;
  let editVal0 = '';
  let editDayVals = ['','','','','','',''];
  let editShowDiary  = true;
  let editShowStats  = true;
  let editIsPercent  = false;
  let editAutoAdjust = false;

  let _gLock = false;
  let _gLockTimer;
  // Kilojoules is a display-mode alias for calories, not a separately-
  // editable goal. Underlying storage is always $goals.calories in kcal;
  // the Kilojoules row reads/writes through that same key with a kJ
  // display conversion. Prevents the two goals from drifting after mode
  // switches or independent edits. #146.
  function _goalStorageId(statId) {
    return statId === 'kilojoules' ? 'calories' : statId;
  }

  /**
   * Map a goal-row stat to the Statistics page's metric id, so the
   * trending-icon affordance lands on the right chart. Nutrients and
   * body stats already share an id with Statistics; wellness ids need
   * the `wl_*` prefix Statistics uses. Returns null when there's no
   * matching Statistics metric (button gets suppressed).
   */
  const _WL_STATS_MAP = {
    steps:              'wl_steps',
    active_minutes:     'wl_active',
    sleep_duration_min: 'wl_sleep',
    resting_hr:         'wl_rhr',
    hrv_daily_rmssd:    'wl_hrv',
    spo2_avg:           'wl_spo2',
    muscle_mass_kg:     'wl_muscle',
  };
  const _STATS_BODY_STAT_IDS = new Set([
    'weight','neck','waist','hips','chest','thighs','biceps','calves','body_fat','body_water',
  ]);
  function _statsIdForGoal(stat) {
    if (!stat || !stat.id) return null;
    if (stat.isWellness) return _WL_STATS_MAP[stat.id] || null;
    if (_STATS_BODY_STAT_IDS.has(stat.id)) return stat.id;
    if (NUTRIMENTS.some(n => n.id === stat.id)) return stat.id;
    return null;
  }
  function _openStatsForGoal(stat) {
    const id = _statsIdForGoal(stat);
    if (id) push('#/statistics?metric=' + id + '&range=1M');
  }
  function openEdit(stat) {
    editStat = stat;
    const storageId = _goalStorageId(stat.id);
    const g = $goals[storageId];
    const kj = (stat.id === 'kilojoules') ||
               (stat.id === 'calories_out' && $energyUnit === 'kJ');
    const toDisp = (v) => kj && v != null && v !== '' ? Math.round(Nutrition.kcalToKj(parseFloat(v))) : v;
    if (g) {
      editShared  = g.sharedGoal !== false;
      editIsMin   = g.isMin || false;
      editShowDiary  = g.showInDiary  !== false;
      editShowStats  = g.showInStats  !== false;
      editIsPercent  = g.isPercent    || false;
      editAutoAdjust = g.autoAdjust   || false;
      if (editShared) {
        editVal0 = String(toDisp(g.max ?? g.min ?? ''));
      } else {
        editDayVals = g.days ? g.days.map(v => v != null ? String(toDisp(v)) : '') : ['','','','','','',''];
        editVal0 = String(editDayVals[0]);
      }
    } else {
      editShared  = true; editIsMin = false;
      editVal0 = ''; editDayVals = ['','','','','','',''];
      editShowDiary = true; editShowStats = true;
      editIsPercent = false; editAutoAdjust = false;
    }
    clearTimeout(_gLockTimer);
    _gLock = true;
    editOpen = true;
    _gLockTimer = setTimeout(() => _gLock = false, 400);
  }

  function saveGoal() {
    if (!editStat) return;
    const kj = (editStat.id === 'kilojoules') ||
               (editStat.id === 'calories_out' && $energyUnit === 'kJ');
    const toStore = (n) => kj && n != null ? n / 4.184 : n;
    const val = toStore(parseDecimal(editVal0) || null);
    const dayArr = editShared
      ? Array(7).fill(val)
      : editDayVals.map(v => toStore(parseDecimal(v) || null));

    const validDays = dayArr.filter(v => v != null && v > 0);
    const peakVal = validDays.length ? Math.max(...validDays) : null;

    const entry = {
      sharedGoal:  editShared,
      isMin:       editIsMin,
      isPercent:   editIsPercent,
      autoAdjust:  editAutoAdjust,
      showInDiary: editShowDiary,
      showInStats: editShowStats,
      days: dayArr
    };
    if (editIsMin) entry.min = editShared ? val : peakVal;
    else           entry.max = editShared ? val : peakVal;

    const storageId = _goalStorageId(editStat.id);
    goals.update(g => {
      const next = { ...g, [storageId]: entry };
      // Clear any legacy $goals.kilojoules on any kilojoules-labeled save;
      // storage now lives only under `calories`. #146 cleanup.
      if (editStat.id === 'kilojoules') delete next.kilojoules;
      return next;
    });
    editOpen = false;
    showSuccess($_('goals.toast.goal_saved'));
  }

  function deleteGoal() {
    if (!editStat) return;
    if (!confirm(`Remove goal for ${editStat.label || editStat.id}?`)) return;
    const storageId = _goalStorageId(editStat.id);
    goals.update(g => {
      const n = { ...g };
      delete n[storageId];
      if (editStat.id === 'kilojoules') delete n.kilojoules;
      return n;
    });
    editOpen = false;
  }

  const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

  const MACRO_DENSITY = { fat: 9, 'saturated-fat': 9, carbohydrates: 4, sugars: 4, proteins: 4 };
  function isPercentEligible(stat) {
    return stat && (stat.id in MACRO_DENSITY);
  }

  function getTodayValue(stat, totals, bodyStats, wellness, recent) {
    const t = totals    ?? todayTotals;
    const b = bodyStats ?? todayBodyStats;
    const w = wellness  ?? todayWellness;
    const r = recent    ?? recentBodyStats;
    if (stat.isWellness) return w[stat.id] ?? null;
    if (stat.isBody) {
      // Today's reading wins; otherwise fall back to the most recent
      // value within the last 30 days (issue #46). Returns null only
      // when no reading exists in that window.
      // `recent` is passed explicitly so Svelte 5's reactive tracker
      // re-evaluates the @const call sites when recentBodyStats updates
      // async after onMount. Reading it via closure only would leave the
      // initial "Your Goals" tab rendering with empty fallbacks until
      // the user switched tabs (issue #46 follow-up from duplaja).
      const todayVal = readBodyStat(b, stat.id, $weightUnit, $lengthUnit);
      if (todayVal != null) return todayVal;
      return r[stat.id]?.value ?? null;
    }
    return t[stat.id] ?? null;
  }

  /** Return a short "as of …" subtext when the displayed body-stat value
   *  came from the fallback (a previous day) rather than today, or '' when
   *  the value is today's (or no value exists). Used in the goal-row
   *  template below the value line so users know the number isn't from
   *  today. `recent` is passed in for the same reactive-tracking reason as
   *  getTodayValue above. */
  function getBodyStatStaleness(stat, recent) {
    if (!stat.isBody) return '';
    const todayVal = readBodyStat(todayBodyStats, stat.id, $weightUnit, $lengthUnit);
    if (todayVal != null) return '';
    const r = recent ?? recentBodyStats;
    const rec = r[stat.id];
    if (!rec) return '';
    // Format: "as of May 18" — concise, locale-aware.
    const dt = new Date(rec.date + 'T12:00:00');
    const label = dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    return `as of ${label}`;
  }

  // Row progress formatter — 'CUR / TGT UNIT' when there's a
   // current value, just 'TGT UNIT' when cur is null. Replaces
   // scattered '{cur ? … : "—"} / {tgt} {unit}' templates so a
   // missing value doesn't render a lonely dash that reads as
   // 'data missing' on the goal-setting page.
  function _fmtProgress(cur, tgt, unit) {
    const t = (tgt ?? 0).toLocaleString();
    const u = unit || '';
    if (cur == null) return u ? `${t} ${u}` : t;
    const c = (Math.round(cur * 10) / 10).toLocaleString();
    return u ? `${c} / ${t} ${u}` : `${c} / ${t}`;
  }

  function getTarget(stat) {
    const storageId = _goalStorageId(stat.id);
    const g = $goals[storageId];
    if (!g) return null;
    let raw;
    if (g.sharedGoal !== false) {
      raw = g.max ?? g.min ?? null;
    } else {
      const d = new Date().getDay();
      raw = (g.days && g.days[d] != null) ? g.days[d] : (g.max ?? g.min ?? null);
    }
    // Kilojoules row displays the calories goal converted to kJ. Underlying
    // storage is kcal; display is unit-transformed at the boundary. #146.
    // Integer rounding matches openEdit's toDisp so open-then-save without
    // editing is a no-op instead of drifting the stored kcal value each
    // pass (round(kj)→saved kcal→round back to same kj stabilizes).
    if (stat.id === 'kilojoules' && raw != null) {
      return Math.round(Nutrition.kcalToKj(raw));
    }
    if (raw == null || !g.isPercent) return raw;
    const density = MACRO_DENSITY[stat.id];
    if (!density) return raw;
    const calGoal = $goals.calories?.max ?? $goals.calories?.min ?? 2000;
    return Math.round(calGoal * raw / 100 / density);
  }

  // ── Desktop right-rail live preview ─────────────────────────────────────
  // Grams goals for macros (protein/carbs/fat) drive both the ring segments
  // and the stacked bar. Null when the goal isn't set — the preview then
  // renders an empty ring / warning that macros are incomplete.
  $: _proteinGoalG = $goals.proteins?.max      ?? $goals.proteins?.min      ?? null;
  $: _carbsGoalG   = $goals.carbohydrates?.max ?? $goals.carbohydrates?.min ?? null;
  $: _fatGoalG     = $goals.fat?.max           ?? $goals.fat?.min           ?? null;
  $: _macroKcalSum =
       (_proteinGoalG || 0) * 4 +
       (_carbsGoalG   || 0) * 4 +
       (_fatGoalG     || 0) * 9;
  $: _macroPct = _macroKcalSum > 0
       ? {
           p: Math.round((_proteinGoalG || 0) * 4 / _macroKcalSum * 100),
           c: Math.round((_carbsGoalG   || 0) * 4 / _macroKcalSum * 100),
           f: Math.round((_fatGoalG     || 0) * 9 / _macroKcalSum * 100),
         }
       : { p: 0, c: 0, f: 0 };

  $: _goalWarnings = (() => {
    const out = [];
    const kcal = _effectiveCalGoal;
    if (kcal && kcal < 1200) {
      out.push({ level: 'warn', msg: `Extreme calorie target (${kcal.toLocaleString()} kcal). Most guidelines suggest 1,200 kcal minimum.` });
    } else if (kcal && kcal > 5000) {
      out.push({ level: 'warn', msg: `Extreme calorie target (${kcal.toLocaleString()} kcal). Double-check this is intentional.` });
    }
    if (_macroKcalSum > 0 && kcal > 0) {
      const tol = kcal * 0.05;
      if (Math.abs(_macroKcalSum - kcal) > tol) {
        out.push({ level: 'info', msg: `Macros sum to ${Math.round(_macroKcalSum).toLocaleString()} kcal, calorie goal is ${kcal.toLocaleString()} kcal.` });
      }
    }
    if (_macroKcalSum <= 0) {
      out.push({ level: 'info', msg: 'Set protein / carbs / fat goals to see the macro breakdown.' });
    }
    // TODO: weight-loss rate warning once body-weight timeline is available.
    return out;
  })();

  // ── Macro preset chips (Balanced / Keto / High-Protein / Custom) ────────
  const MACRO_PRESETS = {
    balanced:       { p: 30, c: 40, f: 30 },
    keto:           { p: 25, c:  5, f: 70 },
    'high-protein': { p: 40, c: 30, f: 30 },
  };
  const MACRO_PRESET_LABELS = {
    balanced:       'Balanced',
    keto:           'Keto',
    'high-protein': 'High-Protein',
  };
  // Match the CURRENT P/C/F percentages against known presets so
  // the Macros card can show 'Currently: Balanced' / 'Currently:
  // Custom'. Tolerance ±2% per macro so tiny rounding drift
  // (grams → % → grams) doesn't kick the label to Custom.
  $: _currentPreset = (() => {
    if (!_macroPct.p && !_macroPct.c && !_macroPct.f) return null;
    for (const [key, ratio] of Object.entries(MACRO_PRESETS)) {
      if (Math.abs(_macroPct.p - ratio.p) <= 2 &&
          Math.abs(_macroPct.c - ratio.c) <= 2 &&
          Math.abs(_macroPct.f - ratio.f) <= 2) {
        return MACRO_PRESET_LABELS[key];
      }
    }
    return 'Custom';
  })();
  function applyMacroPreset(name) {
    const preset = MACRO_PRESETS[name];
    if (!preset) return;
    const kcal = $goals.calories?.max ?? $goals.calories?.min ?? 2000;
    const pG = Math.round(kcal * preset.p / 100 / 4);
    const cG = Math.round(kcal * preset.c / 100 / 4);
    const fG = Math.round(kcal * preset.f / 100 / 9);
    goals.update(g => ({
      ...g,
      proteins:      { sharedGoal: true, isMin: false, showInDiary: true, showInStats: true, ...(g.proteins      || {}), max: pG, min: undefined, days: Array(7).fill(pG) },
      carbohydrates: { sharedGoal: true, isMin: false, showInDiary: true, showInStats: true, ...(g.carbohydrates || {}), max: cG, min: undefined, days: Array(7).fill(cG) },
      fat:           { sharedGoal: true, isMin: false, showInDiary: true, showInStats: true, ...(g.fat           || {}), max: fG, min: undefined, days: Array(7).fill(fG) },
    }));
    showSuccess('Macros set');
  }

  // ── All-fields filter (desktop search input) ───────────────────────────
  let _allFieldsQuery = '';
  function _matchesQuery(stat) {
    const q = _allFieldsQuery.trim().toLowerCase();
    if (!q) return true;
    return ((stat.label || stat.id) + '').toLowerCase().includes(q);
  }

  // ── Reset-all-goals (rail button on desktop) ───────────────────────────
  function _resetAllGoals() {
    if (!confirm('Remove ALL goals? This clears every configured goal and cannot be undone.')) return;
    goals.set({});
    showSuccess('Goals cleared');
  }

  function getPct(stat, totals, bodyStats, wellness, recent) {
    const cur = getTodayValue(stat, totals, bodyStats, wellness, recent);
    const tgt = getTarget(stat);
    if (cur == null || tgt == null || tgt === 0) return 0;
    return Math.min(100, Math.round(cur / tgt * 100));
  }
</script>

<div class="page-shell">
  <header class="page-header" class:banner-gradient={$bannerStyle === 'gradient'} class:banner-animated={$bannerStyle === 'animated'}>
    <h1>{$_('routes.goals.title')}</h1>
  </header>

  <!-- Tabs -->
  <div class="tab-bar">
    <button class="tab-btn" class:active={activeTab==='yours'} on:click={() => activeTab='yours'}>
      Your Goals
    </button>
    <button class="tab-btn" class:active={activeTab==='all'} on:click={() => activeTab='all'}>
      All Fields
    </button>
    <button class="tab-btn" class:active={activeTab==='templates'} on:click={() => activeTab='templates'}>
      Templates
    </button>
  </div>

  <div class="page-content">
  <!-- Desktop three-pane wrapper (≥1280px). On mobile / force-mobile-layout
       .goals-body is a plain block; the rails are display:none. -->
  <div class="goals-body">

    <!-- ─── LEFT RAIL (desktop only) ────────────────────────────────────── -->
    <aside class="goals-left-rail">
      <div class="goals-rail-heading">Navigate</div>
      <button class="goals-rail-nav" class:active={activeTab === 'yours'} on:click={() => activeTab = 'yours'}>
        <span class="material-symbols-rounded">flag</span>
        Your Goals
      </button>
      <button class="goals-rail-nav" class:active={activeTab === 'all'} on:click={() => activeTab = 'all'}>
        <span class="material-symbols-rounded">list</span>
        All Fields
      </button>
      <button class="goals-rail-nav" class:active={activeTab === 'templates'} on:click={() => activeTab = 'templates'}>
        <span class="material-symbols-rounded">bookmark</span>
        Templates
      </button>

      <div class="goals-rail-heading" style="margin-top:16px">{$_('settings_goals.calorie_goal_mode')}</div>
      <div class="seg-control goals-rail-seg" style="--seg-count:3;--seg-active:{$calorieGoalMode === 'fixed' ? 0 : $calorieGoalMode === 'dynamic' ? 1 : 2}">
        <button class="seg-opt" class:seg-active={$calorieGoalMode === 'fixed'}
          on:click={() => calorieGoalMode.set('fixed')}>{$_('settings_goals.mode_fixed')}</button>
        <button class="seg-opt" class:seg-active={$calorieGoalMode === 'dynamic'}
          disabled={!_hasWearable}
          title={!_hasWearable ? 'Connect a wearable in Wellness first' : ''}
          on:click={() => _hasWearable && calorieGoalMode.set('dynamic')}>{$_('settings_goals.mode_dynamic')}</button>
        <button class="seg-opt" class:seg-active={$calorieGoalMode === 'adaptive'}
          on:click={() => calorieGoalMode.set('adaptive')}>{$_('settings_goals.mode_adaptive')}</button>
      </div>
      {#if $calorieGoalMode === 'dynamic' || $calorieGoalMode === 'adaptive'}
        <div class="goals-rail-heading" style="margin-top:12px">{$_('settings_goals.goal_factor')}</div>
        <div class="seg-control goals-rail-seg" style="--seg-count:3;--seg-active:{$calorieGoalFactor === 0.8 ? 0 : $calorieGoalFactor === 1.2 ? 2 : 1}">
          <button class="seg-opt" class:seg-active={$calorieGoalFactor === 0.8} on:click={() => calorieGoalFactor.set(0.8)}>-20%</button>
          <button class="seg-opt" class:seg-active={$calorieGoalFactor === 1.0} on:click={() => calorieGoalFactor.set(1.0)}>{$_('settings_goals.factor_maintain')}</button>
          <button class="seg-opt" class:seg-active={$calorieGoalFactor === 1.2} on:click={() => calorieGoalFactor.set(1.2)}>+20%</button>
        </div>
      {/if}

      {#if $calorieGoalMode === 'adaptive' && _adaptiveLoaded}
        <div class="goals-rail-heading" style="margin-top:12px">Adaptive TDEE</div>
        <div class="goals-rail-adaptive">
          {#if _adaptive?.ready}
            {@const _tdeeE = Nutrition.displayEnergy(_adaptive.tdee, $energyUnit)}
            <div class="goals-rail-adaptive-line">
              <span class="text-3 text-sm">Learned TDEE</span>
              <strong>{_tdeeE.value.toLocaleString()} {_tdeeE.unit}</strong>
            </div>
            <div class="goals-rail-adaptive-line">
              <span class="text-3 text-sm">Confidence</span>
              <strong>{Math.round((_adaptive.confidence || 0) * 100)}%</strong>
            </div>
            <div class="goals-rail-adaptive-line">
              <span class="text-3 text-sm">Weight source</span>
              <strong style="text-transform:capitalize">{_adaptive.weightSource}</strong>
            </div>
          {:else}
            <div class="adaptive-progress-track" style="margin-top:0">
              <div class="adaptive-progress-fill"
                style="width:{Math.min(100, ((_adaptive?.daysAvailable ?? 0) / (_adaptive?.daysRequired ?? 21)) * 100)}%"></div>
            </div>
            <p class="text-3 text-sm" style="margin:6px 0 0">
              {_adaptive?.daysAvailable ?? 0} / {_adaptive?.daysRequired ?? 21} days
            </p>
          {/if}
        </div>
      {/if}

      <div class="goals-rail-actions">
        <button class="btn btn-secondary" on:click={openSaveSheet}>
          <span class="material-symbols-rounded" style="font-size:16px;vertical-align:-3px">save</span>
          {$_('goals_page.templates.save_button')}
        </button>
        <button class="btn btn-ghost" on:click={_resetAllGoals}>
          <span class="material-symbols-rounded" style="font-size:16px;vertical-align:-3px">restart_alt</span>
          Reset all
        </button>
      </div>
    </aside>

    <!-- ─── CENTER PANE ─────────────────────────────────────────────────── -->
    <div class="goals-main">

    <!-- ── Adaptive TDEE readiness card (shown only when adaptive mode is on) ── -->
    {#if activeTab === 'yours' && $calorieGoalMode === 'adaptive' && _adaptiveLoaded}
      <div class="card adaptive-card">
        <div class="adaptive-header">
          <span class="material-symbols-rounded adaptive-icon">trending_up</span>
          <div style="flex:1;min-width:0">
            <div class="adaptive-title">{$_('goals_page.adaptive.title')}</div>
            {#if _adaptive?.ready}
              {@const _tdeeE = Nutrition.displayEnergy(_adaptive.tdee, $energyUnit)}
              <div class="adaptive-sub">
                {@html $_('goals_page.adaptive.learned', { values: { value: _tdeeE.value.toLocaleString(), unit: _tdeeE.unit, trend: (_adaptive.trendKgPerWeek > 0 ? '+' : '') + _adaptive.trendKgPerWeek } })}
              </div>
            {:else}
              <div class="adaptive-sub">
                {@html $_('goals_page.adaptive.building', { values: { available: _adaptive?.daysAvailable ?? 0, required: _adaptive?.daysRequired ?? 21 } })}
              </div>
            {/if}
          </div>
          <button class="btn-icon" on:click={() => _showAdaptiveHelp = !_showAdaptiveHelp}
            aria-label={$_('goals_page.adaptive.help_button')} title={$_('goals_page.adaptive.help_button')}>
            <span class="material-symbols-rounded">{_showAdaptiveHelp ? 'expand_less' : 'help_outline'}</span>
          </button>
        </div>
        {#if _adaptive?.ready}
          {@const _todayE = Nutrition.displayEnergy(_effectiveCalGoal, $energyUnit)}
          <div class="adaptive-stats">
            <div><span class="text-3 text-sm">{$_('goals_page.adaptive.today_goal')}</span><br><strong>{_todayE.value.toLocaleString()} {_todayE.unit}</strong></div>
            <div><span class="text-3 text-sm">{$_('goals_page.adaptive.confidence')}</span><br><strong>{Math.round((_adaptive.confidence || 0) * 100)}%</strong></div>
            <div><span class="text-3 text-sm">{$_('goals_page.adaptive.weight_source')}</span><br><strong style="text-transform:capitalize">{_adaptive.weightSource}</strong></div>
          </div>
        {:else}
          <div class="adaptive-progress-track">
            <div class="adaptive-progress-fill"
              style="width:{Math.min(100, ((_adaptive?.daysAvailable ?? 0) / (_adaptive?.daysRequired ?? 21)) * 100)}%"></div>
          </div>
          {@const _fixedE = Nutrition.displayEnergy(_fixedGoal, $energyUnit)}
          <p class="text-3 text-sm" style="margin:8px 0 0">
            {$_('goals_page.adaptive.until_ready', { values: { value: _fixedE.value.toLocaleString(), unit: _fixedE.unit } })}
          </p>
        {/if}
        {#if _showAdaptiveHelp}
          <div class="adaptive-help" transition:slide={{ duration: 180 }}>
            <p><strong>{$_('goals_page.adaptive.help_headline')}</strong> {$_('goals_page.adaptive.help_intro')}</p>
            <ol>
              <li>{$_('goals_page.adaptive.help_step_1')}</li>
              <li>{$_('goals_page.adaptive.help_step_2')}</li>
              <li>{$_('goals_page.adaptive.help_step_3')}</li>
            </ol>
            <p><strong>{$_('goals_page.adaptive.help_best_intro')}</strong></p>
            <ul>
              <li>{@html $_('goals_page.adaptive.help_best_weigh')}</li>
              <li>{@html $_('goals_page.adaptive.help_best_log')}</li>
              <li>{@html $_('goals_page.adaptive.help_best_switch')}</li>
              <li>{@html $_('goals_page.adaptive.help_best_reweigh')}</li>
            </ul>
            <p>{@html $_('goals_page.adaptive.help_caveats')}</p>
          </div>
        {/if}
      </div>
    {/if}

    <!-- ── Your Goals tab ── -->
    {#if activeTab === 'yours'}

      <!-- Macros quick-set card. Presets fill P/C/F grams from calorie
           goal × ratio. Custom = whatever's currently stored. -->
      <div class="card goals-macro-card">
        <div class="goals-macro-head">
          <div>
            <div class="font-medium">Macros</div>
          </div>
        </div>
        <div class="goals-macro-grid">
          <button class="goals-macro-cell" on:click={() => openEdit({ id: 'proteins',      label: 'Protein', unit: 'g' })}>
            <span class="gm-lbl">Protein</span>
            <span class="gm-val">{_proteinGoalG ?? '—'}<span class="gm-u">g</span></span>
            <span class="gm-pct">{_macroPct.p}%</span>
          </button>
          <button class="goals-macro-cell" on:click={() => openEdit({ id: 'carbohydrates', label: 'Carbohydrates', unit: 'g' })}>
            <span class="gm-lbl">Carbs</span>
            <span class="gm-val">{_carbsGoalG ?? '—'}<span class="gm-u">g</span></span>
            <span class="gm-pct">{_macroPct.c}%</span>
          </button>
          <button class="goals-macro-cell" on:click={() => openEdit({ id: 'fat',           label: 'Fat', unit: 'g' })}>
            <span class="gm-lbl">Fat</span>
            <span class="gm-val">{_fatGoalG ?? '—'}<span class="gm-u">g</span></span>
            <span class="gm-pct">{_macroPct.f}%</span>
          </button>
        </div>
        <div class="goals-macro-presets">
          <button class="chip" class:chip-active={_currentPreset === 'Balanced'} on:click={() => applyMacroPreset('balanced')}>Balanced 30/40/30</button>
          <button class="chip" class:chip-active={_currentPreset === 'Keto'} on:click={() => applyMacroPreset('keto')}>Keto 25/5/70</button>
          <button class="chip" class:chip-active={_currentPreset === 'High-Protein'} on:click={() => applyMacroPreset('high-protein')}>High-Protein 40/30/30</button>
          {#if _currentPreset}
            <span class="goals-macro-current" title="Ratio matches this preset (±2% tolerance)">
              Currently: <strong>{_currentPreset}</strong>
            </span>
          {/if}
        </div>
      </div>

      {#if !hasAnyGoal}
        <div class="empty-state">
          <span class="material-symbols-rounded" style="font-size:48px;opacity:0.2">flag</span>
          <p>{$_('goals_page.empty.no_goals')}</p>
          <p class="text-3 text-sm">{@html $_('goals_page.empty.add_hint')}</p>
        </div>
      {:else}
        {#if configuredBodyStats.length > 0}
          <p class="section-title">{$_('goals_page.sections.body_stats')}</p>
          <div class="card goals-yours-card">
            {#each configuredBodyStats as stat, i}
              {#if i > 0}<div class="divider"></div>{/if}
              <button class="goal-row" on:click={() => openEdit(stat)}>
                <div class="goal-info">
                  <span class="font-medium">{stat.label}</span>
                  {#if getTarget(stat) != null}
                    {@const pct = getPct(stat, todayTotals, todayBodyStats, todayWellness, recentBodyStats)}
                    {@const tgt = getTarget(stat)}
                    {@const cur = getTodayValue(stat, todayTotals, todayBodyStats, todayWellness, recentBodyStats)}
                    {@const isMin = $goals[_goalStorageId(stat.id)]?.isMin}
                    {@const bad = cur != null && tgt != null && (isMin ? cur < tgt : cur > tgt)}
                    {@const stale = getBodyStatStaleness(stat, recentBodyStats)}
                    <div class="goal-progress-bar">
                      <div class="goal-progress-fill" class:over={bad} style="width:{pct}%"></div>
                    </div>
                    <span class="text-3 text-sm">
                      {_fmtProgress(cur, tgt, stat.unit || '')}
                      {#if isMin}<span style="opacity:0.6">{$_('goals_page.row.min')}</span>{/if}
                      {#if stale}<span class="goal-stale" title={$_('goals_page.row.stale_tip')}>· {stale}</span>{/if}
                    </span>
                  {:else}
                    <span class="text-3 text-sm">{$_('goals_page.row.not_set')}</span>
                  {/if}
                </div>
                {#if _statsIdForGoal(stat)}
                  <span class="goal-trend material-symbols-rounded" role="button" tabindex="0"
                    title="View trend" aria-label="View trend in Statistics"
                    on:click|stopPropagation={() => _openStatsForGoal(stat)}
                    on:keydown|stopPropagation={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); _openStatsForGoal(stat); } }}>trending_up</span>
                {/if}
                <span class="material-symbols-rounded text-3" style="font-size:18px">chevron_right</span>
              </button>
            {/each}
          </div>
        {/if}

        {#if yourGoalsNutrients.length > 0}
          <p class="section-title">{$_('goals_page.sections.nutrients')}</p>
          <div class="card goals-yours-card">
            {#each yourGoalsNutrients as stat, i}
              {#if i > 0}<div class="divider"></div>{/if}
              <button class="goal-row" on:click={() => openEdit(stat)}>
                <div class="goal-info">
                  <span class="font-medium">{stat.label}{#if (stat.id === 'calories' || stat.id === 'kilojoules') && $calorieGoalMode === 'dynamic' && _dynamicCaloriesOut != null} ⚡{:else if (stat.id === 'calories' || stat.id === 'kilojoules') && $calorieGoalMode === 'adaptive' && _adaptive?.ready} 📈{/if}</span>
                  {#if getTarget(stat) != null}
                    {@const _isEnergy = stat.id === 'calories' || stat.id === 'kilojoules'}
                    {@const _dynAdapt = _isEnergy && ($calorieGoalMode === 'dynamic' || ($calorieGoalMode === 'adaptive' && _adaptive?.ready))}
                    {@const tgt = _dynAdapt
                      ? (stat.id === 'kilojoules' ? Math.round(Nutrition.kcalToKj(_effectiveCalGoal)) : _effectiveCalGoal)
                      : getTarget(stat)}
                    {@const cur = getTodayValue(stat, todayTotals, todayBodyStats, todayWellness, recentBodyStats)}
                    {@const pct = tgt > 0 ? Math.min(100, Math.round((cur ?? 0) / tgt * 100)) : 0}
                    {@const isMin = $goals[_goalStorageId(stat.id)]?.isMin}
                    {@const bad = cur != null && tgt != null && (isMin ? cur < tgt : cur > tgt)}
                    <div class="goal-progress-bar">
                      <div class="goal-progress-fill" class:over={bad} style="width:{pct}%"></div>
                    </div>
                    <span class="text-3 text-sm">
                      {_fmtProgress(cur, tgt, stat.unit || '')}
                      {#if isMin}<span style="opacity:0.6">{$_('goals_page.row.min')}</span>{/if}
                    </span>
                  {:else}
                    <span class="text-3 text-sm">{$_('goals_page.row.not_set')}</span>
                  {/if}
                </div>
                {#if _statsIdForGoal(stat)}
                  <span class="goal-trend material-symbols-rounded" role="button" tabindex="0"
                    title="View trend" aria-label="View trend in Statistics"
                    on:click|stopPropagation={() => _openStatsForGoal(stat)}
                    on:keydown|stopPropagation={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); _openStatsForGoal(stat); } }}>trending_up</span>
                {/if}
                <span class="material-symbols-rounded text-3" style="font-size:18px">chevron_right</span>
              </button>
            {/each}
          </div>
        {/if}

      {/if}

      <!-- Water Goal — alphabetically before Wellness -->
      <p class="section-title">{$_('goals_page.sections.water')}</p>
      <div class="card goals-yours-card">
        <button class="goal-row" on:click={openEditWater}>
          <div class="goal-info">
            <span class="font-medium">{$_('goals_page.row.daily_water_goal')}</span>
            <div class="goal-progress-bar">
              <div class="goal-progress-fill" style="width:{waterPct}%"></div>
            </div>
            <span class="text-3 text-sm">{waterTodayDisplay.toLocaleString()} / {waterGoalDisplay.toLocaleString()} {$waterUnit}</span>
          </div>
          <span class="goal-trend material-symbols-rounded" role="button" tabindex="0"
            title="View trend" aria-label="View trend in Statistics"
            on:click|stopPropagation={() => push('#/statistics?metric=water&range=1M')}
            on:keydown|stopPropagation={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); push('#/statistics?metric=water&range=1M'); } }}>trending_up</span>
          <span class="material-symbols-rounded text-3" style="font-size:18px">chevron_right</span>
        </button>
      </div>

      {#if configuredWellness.length > 0}
        <p class="section-title">{$_('goals_page.sections.wellness')}</p>
        <div class="card goals-yours-card">
          {#each configuredWellness as stat, i}
            {#if i > 0}<div class="divider"></div>{/if}
            <button class="goal-row" on:click={() => openEdit(stat)}>
              <div class="goal-info">
                <span class="font-medium">{stat.label}</span>
                {#if getTarget(stat) != null}
                  {@const pct = getPct(stat, todayTotals, todayBodyStats, todayWellness, recentBodyStats)}
                  {@const tgt = getTarget(stat)}
                  {@const cur = getTodayValue(stat, todayTotals, todayBodyStats, todayWellness, recentBodyStats)}
                  <div class="goal-progress-bar">
                    <div class="goal-progress-fill" style="width:{pct}%"></div>
                  </div>
                  <span class="text-3 text-sm">{_fmtProgress(cur, tgt, stat.unit)}</span>
                {:else}
                  <span class="text-3 text-sm">{$_('goals_page.row.not_set')}</span>
                {/if}
              </div>
              {#if _statsIdForGoal(stat)}
                <span class="goal-trend material-symbols-rounded" role="button" tabindex="0"
                  title="View trend" aria-label="View trend in Statistics"
                  on:click|stopPropagation={() => _openStatsForGoal(stat)}
                  on:keydown|stopPropagation={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); _openStatsForGoal(stat); } }}>trending_up</span>
              {/if}
              <span class="material-symbols-rounded text-3" style="font-size:18px">chevron_right</span>
            </button>
          {/each}
        </div>
      {/if}

    <!-- ── All Fields tab ── -->
    {:else if activeTab === 'all'}
      <p class="text-3 text-sm" style="padding:0 var(--page-px) 8px">{$_('goals_page.all_fields.intro')}</p>

      <div class="goals-all-filter">
        <span class="material-symbols-rounded">search</span>
        <input type="search" placeholder="Filter nutrients…" bind:value={_allFieldsQuery} />
      </div>

      <!-- Body Stats -->
      <p class="section-title">{$_('goals_page.sections.body_stats')}</p>
      <div class="card goals-all-card">
        {#each bodyStatsWithUnit.filter(_matchesQuery) as stat, i}
          {#if i > 0}<div class="divider"></div>{/if}
          <button class="goal-row" class:goal-row-set={getTarget(stat) != null} on:click={() => openEdit(stat)}>
            <div class="goal-info">
              <span class="font-medium">{stat.label}</span>
              {#if $goals[_goalStorageId(stat.id)]}
                {@const pct = getPct(stat, todayTotals, todayBodyStats, todayWellness, recentBodyStats)}
                {@const tgt = getTarget(stat)}
                {@const cur = getTodayValue(stat, todayTotals, todayBodyStats, todayWellness, recentBodyStats)}
                {@const stale = getBodyStatStaleness(stat, recentBodyStats)}
                <div class="goal-progress-bar">
                  <div class="goal-progress-fill" style="width:{pct}%"></div>
                </div>
                <span class="text-3 text-sm">
                  {_fmtProgress(cur, tgt, stat.unit)}
                  {#if stale}<span class="goal-stale" title={$_('goals_page.row.stale_tip')}>· {stale}</span>{/if}
                </span>
              {:else}
                <span class="text-3 text-sm" style="opacity:0.4">{$_('goals_page.row.no_goal')}</span>
              {/if}
            </div>
            {#if _statsIdForGoal(stat)}
              <span class="goal-trend material-symbols-rounded" role="button" tabindex="0"
                title="View trend" aria-label="View trend in Statistics"
                on:click|stopPropagation={() => _openStatsForGoal(stat)}
                on:keydown|stopPropagation={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); _openStatsForGoal(stat); } }}>trending_up</span>
            {/if}
            <span class="material-symbols-rounded text-3" style="font-size:18px">chevron_right</span>
          </button>
        {/each}
      </div>

      <!-- Nutrients -->
      <p class="section-title">{$_('goals_page.sections.nutrients')}</p>
      <div class="card goals-all-card">
        {#each allNutrients.filter(_matchesQuery) as stat, i}
          {#if i > 0}<div class="divider"></div>{/if}
          <button class="goal-row" class:goal-row-set={getTarget(stat) != null} on:click={() => openEdit(stat)}>
            <div class="goal-info">
              <span class="font-medium">{stat.label}</span>
              {#if $goals[_goalStorageId(stat.id)]}
                {@const pct = getPct(stat, todayTotals, todayBodyStats, todayWellness, recentBodyStats)}
                {@const tgt = getTarget(stat)}
                {@const cur = getTodayValue(stat, todayTotals, todayBodyStats, todayWellness, recentBodyStats)}
                <div class="goal-progress-bar">
                  <div class="goal-progress-fill" style="width:{pct}%"></div>
                </div>
                <span class="text-3 text-sm">{_fmtProgress(cur, tgt, stat.unit)}</span>
              {:else}
                <span class="text-3 text-sm" style="opacity:0.4">{$_('goals_page.row.no_goal')}</span>
              {/if}
            </div>
            {#if _statsIdForGoal(stat)}
              <span class="goal-trend material-symbols-rounded" role="button" tabindex="0"
                title="View trend" aria-label="View trend in Statistics"
                on:click|stopPropagation={() => _openStatsForGoal(stat)}
                on:keydown|stopPropagation={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); _openStatsForGoal(stat); } }}>trending_up</span>
            {/if}
            <span class="material-symbols-rounded text-3" style="font-size:18px">chevron_right</span>
          </button>
        {/each}
      </div>

      <!-- Water -->
      <p class="section-title">{$_('goals_page.sections.water')}</p>
      <div class="card">
        <button class="goal-row" on:click={openEditWater}>
          <div class="goal-info">
            <span class="font-medium">{$_('goals_page.row.daily_water_goal')}</span>
            <div class="goal-progress-bar">
              <div class="goal-progress-fill" style="width:{waterPct}%"></div>
            </div>
            <span class="text-3 text-sm">{waterTodayDisplay.toLocaleString()} / {waterGoalDisplay.toLocaleString()} {$waterUnit}</span>
          </div>
          <span class="goal-trend material-symbols-rounded" role="button" tabindex="0"
            title="View trend" aria-label="View trend in Statistics"
            on:click|stopPropagation={() => push('#/statistics?metric=water&range=1M')}
            on:keydown|stopPropagation={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); push('#/statistics?metric=water&range=1M'); } }}>trending_up</span>
          <span class="material-symbols-rounded text-3" style="font-size:18px">chevron_right</span>
        </button>
      </div>

      <!-- Wellness (when enabled) -->
      {#if $wellnessEnabled}
        <p class="section-title">{$_('goals_page.sections.wellness')}</p>
        <div class="card goals-all-card">
          {#each WELLNESS_GOALS.filter(_matchesQuery) as stat, i}
            {@const _kjMode = stat.id === 'calories_out' && $energyUnit === 'kJ'}
            {@const _statUnit = _kjMode ? 'kJ' : stat.unit}
            {#if i > 0}<div class="divider"></div>{/if}
            <button class="goal-row" class:goal-row-set={getTarget(stat) != null} on:click={() => openEdit(stat)}>
              <div class="goal-info">
                <span class="font-medium">{stat.label}</span>
                {#if $goals[_goalStorageId(stat.id)]}
                  {@const pct = getPct(stat, todayTotals, todayBodyStats, todayWellness, recentBodyStats)}
                  {@const _tgtRaw = getTarget(stat)}
                  {@const _curRaw = getTodayValue(stat, todayTotals, todayBodyStats, todayWellness, recentBodyStats)}
                  {@const tgt = _kjMode && _tgtRaw != null ? Math.round(Nutrition.kcalToKj(_tgtRaw)) : _tgtRaw}
                  {@const cur = _kjMode && _curRaw != null ? Nutrition.kcalToKj(_curRaw) : _curRaw}
                  <div class="goal-progress-bar">
                    <div class="goal-progress-fill" style="width:{pct}%"></div>
                  </div>
                  <span class="text-3 text-sm">{_fmtProgress(cur, tgt, _statUnit)}</span>
                {:else}
                  <span class="text-3 text-sm" style="opacity:0.4">{$_('goals_page.row.no_goal')}</span>
                {/if}
              </div>
              {#if _statsIdForGoal(stat)}
                <span class="goal-trend material-symbols-rounded" role="button" tabindex="0"
                  title="View trend" aria-label="View trend in Statistics"
                  on:click|stopPropagation={() => _openStatsForGoal(stat)}
                  on:keydown|stopPropagation={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); _openStatsForGoal(stat); } }}>trending_up</span>
              {/if}
              <span class="material-symbols-rounded text-3" style="font-size:18px">chevron_right</span>
            </button>
          {/each}
        </div>
      {/if}

    <!-- ── Templates tab ── -->
    {:else if activeTab === 'templates'}
      <div class="tpl-header">
        <p class="text-3 text-sm">{$_('goals_page.templates.intro')}</p>
        <button class="btn btn-primary tpl-save-btn goals-desktop-hide" on:click={openSaveSheet}>
          <span class="material-symbols-rounded" style="font-size:18px">save</span>
          {$_('goals_page.templates.save_button')}
        </button>
      </div>

      {#if $goalTemplates.length === 0}
        <div class="empty-state">
          <span class="material-symbols-rounded" style="font-size:48px;opacity:0.2">bookmarks</span>
          <p>{$_('goals_page.empty.no_templates')}</p>
          <p class="text-3 text-sm">{$_('goals_page.empty.no_templates_hint')}</p>
        </div>
      {:else}
        <div class="card">
          {#each $goalTemplates as tpl, i}
            {#if i > 0}<div class="divider"></div>{/if}
            <!-- Template preview: calorie target + P/C/F chip row
                 so users know what they're applying BEFORE
                 hitting Apply. {@const}s must be direct children
                 of the {#each}, so they're hoisted here even
                 though they're only referenced deeper below. -->
            {@const _tKcal = tpl.goals?.calories?.max ?? tpl.goals?.calories?.min}
            {@const _tP    = tpl.goals?.proteins?.max ?? tpl.goals?.proteins?.min}
            {@const _tC    = tpl.goals?.carbohydrates?.max ?? tpl.goals?.carbohydrates?.min}
            {@const _tF    = tpl.goals?.fat?.max ?? tpl.goals?.fat?.min}
            <div class="tpl-row">
              <div class="tpl-info">
                <span class="font-medium">{tpl.name}</span>
                <span class="text-3 text-sm">{formatDate(tpl.createdAt)} · {$_('goals_page.templates.goals_count', { values: { count: tpl.goalCount || Object.keys(tpl.goals).filter(k => tpl.goals[k]?.min != null || tpl.goals[k]?.max != null).length + (tpl.waterGoalMl > 0 ? 1 : 0) } })}</span>
                {#if _tKcal || _tP || _tC || _tF}
                  <div class="tpl-preview-chips">
                    {#if _tKcal}<span class="tpl-chip">{_tKcal.toLocaleString()} kcal</span>{/if}
                    {#if _tP}<span class="tpl-chip tpl-chip-p">P {_tP}g</span>{/if}
                    {#if _tC}<span class="tpl-chip tpl-chip-c">C {_tC}g</span>{/if}
                    {#if _tF}<span class="tpl-chip tpl-chip-f">F {_tF}g</span>{/if}
                  </div>
                {/if}
              </div>
              <div class="tpl-actions">
                <button class="btn btn-ghost tpl-btn" on:click={() => showApplyConfirm = tpl}>
                  {$_('goals_page.templates.apply')}
                </button>
                <button class="btn-icon" style="color:var(--text-3)" on:click={() => deleteTemplate(tpl.id)} title={$_('goals_page.templates.delete_template')}>
                  <span class="material-symbols-rounded" style="font-size:20px">delete</span>
                </button>
              </div>
            </div>
          {/each}
        </div>
      {/if}
    {/if}

    <div style="height:24px"></div>
    </div><!-- /.goals-main -->

    <!-- ─── RIGHT RAIL — live preview (desktop only) ─────────────────────── -->
    <aside class="goals-right-rail">
      <div class="goals-rail-heading">Preview</div>

      <div class="goals-preview-ring">
        {#key `${_effectiveCalGoal}-${_proteinGoalG}-${_carbsGoalG}-${_fatGoalG}`}
          <MacroRing
            calories={_effectiveCalGoal}
            caloriesGoal={_effectiveCalGoal}
            protein={_proteinGoalG || 0}
            carbs={_carbsGoalG || 0}
            fat={_fatGoalG || 0}
            proteinGoal={_proteinGoalG}
            carbGoal={_carbsGoalG}
            fatGoal={_fatGoalG}
          />
        {/key}
      </div>

      <div class="goals-preview-macrobar" title="Macro split by kcal">
        {#if _macroKcalSum > 0}
          <div class="gp-seg gp-p" style="width:{_macroPct.p}%" title="Protein {_macroPct.p}%"></div>
          <div class="gp-seg gp-c" style="width:{_macroPct.c}%" title="Carbs {_macroPct.c}%"></div>
          <div class="gp-seg gp-f" style="width:{_macroPct.f}%" title="Fat {_macroPct.f}%"></div>
        {:else}
          <div class="gp-seg gp-empty" style="width:100%"></div>
        {/if}
      </div>
      <div class="goals-preview-sum">
        P {_proteinGoalG ?? '—'}g · C {_carbsGoalG ?? '—'}g · F {_fatGoalG ?? '—'}g
        {#if _macroKcalSum > 0}= {Math.round(_macroKcalSum).toLocaleString()} kcal{/if}
      </div>

      {#if _goalWarnings.length}
        <div class="goals-rail-heading" style="margin-top:14px">Notes</div>
        <div class="goals-preview-warnings">
          {#each _goalWarnings as w}
            <div class="gp-warn gp-warn-{w.level}">
              <span class="material-symbols-rounded">{w.level === 'warn' ? 'warning' : 'info'}</span>
              <span>{w.msg}</span>
            </div>
          {/each}
        </div>
      {/if}

      <!-- Phase D deferred: drawer sheet used on desktop until inline pane extraction is safer -->
    </aside>

  </div><!-- /.goals-body -->
  </div>
</div>

<!-- ── Goal editor sheet ── -->
{#if editOpen && editStat}
  {@const _rawUnit = (editStat.id === 'calories_out' && $energyUnit === 'kJ') ? 'kJ' : editStat.unit}
  <!-- #137: normalize µg (MICRO SIGN, U+00B5) to 'mcg' for display. The
       form-label uppercase transform case-maps µ → Μ (Greek Capital Mu),
       which fonts render identically to Latin 'M' so 'µg' reads as 'MG'
       and users think they need to enter milligrams. Default nutrients
       moved to 'mcg' in nutrition.js; this catches legacy custom
       nutrients still stored with 'µg' as their unit. -->
  {@const _editUnit = _rawUnit === 'µg' ? 'mcg' : _rawUnit}
  <div use:portal class="sheet-backdrop" role="dialog" aria-modal="true"
    on:click={() => { if (!_gLock) editOpen = false; }} on:keydown={() => {}}>
    <div class="sheet-panel" on:click|stopPropagation on:keydown={() => {}}>
      <div class="sheet-handle"></div>
      <div class="sheet-header">
        <h3 class="sheet-title">{editStat.label} {_editUnit ? '('+_editUnit+')' : ''}</h3>
      </div>
      <div class="sheet-body">

        <!-- Display options -->
        {#if !editStat?.isWellness}
          <p class="goal-section-label">{$_('goals_page.editor.display')}</p>
          <div class="toggle-row">
            <label class="toggle-label">{$_('goals_page.editor.show_in_diary')}</label>
            <label class="toggle-switch">
              <input type="checkbox" bind:checked={editShowDiary} />
              <span class="toggle-track"></span>
            </label>
          </div>
          <div class="toggle-row">
            <label class="toggle-label">{$_('goals_page.editor.show_in_statistics')}</label>
            <label class="toggle-switch">
              <input type="checkbox" bind:checked={editShowStats} />
              <span class="toggle-track"></span>
            </label>
          </div>
        {/if}

        <!-- Goal behavior -->
        <p class="goal-section-label">{$_('goals_page.editor.goal_behavior')}</p>
        <div class="toggle-row">
          <div class="toggle-label-wrap">
            <label class="toggle-label">{$_('goals_page.editor.same_every_day')}</label>
            <span class="toggle-hint">{editShared ? $_('goals_page.editor.one_target') : $_('goals_page.editor.per_weekday')}</span>
          </div>
          <label class="toggle-switch">
            <input type="checkbox" bind:checked={editShared} />
            <span class="toggle-track"></span>
          </label>
        </div>
        <div class="toggle-row">
          <div class="toggle-label-wrap">
            <label class="toggle-label">{$_('goals_page.editor.minimum_goal')}</label>
            <span class="toggle-hint">{editIsMin ? $_('goals_page.editor.min_hint_true') : $_('goals_page.editor.min_hint_false')}</span>
          </div>
          <label class="toggle-switch">
            <input type="checkbox" bind:checked={editIsMin} />
            <span class="toggle-track"></span>
          </label>
        </div>
        {#if isPercentEligible(editStat)}
          <div class="toggle-row">
            <div class="toggle-label-wrap">
              <label class="toggle-label">{$_('goals_page.editor.as_percent_calories')}</label>
              <span class="toggle-hint">{$_('goals_page.editor.as_percent_hint')}</span>
            </div>
            <label class="toggle-switch">
              <input type="checkbox" bind:checked={editIsPercent} />
              <span class="toggle-track"></span>
            </label>
          </div>
        {/if}
        <div class="toggle-row">
          <div class="toggle-label-wrap">
            <label class="toggle-label">{$_('goals_page.editor.auto_adjust')}</label>
            <span class="toggle-hint">{$_('goals_page.editor.auto_adjust_hint')}</span>
          </div>
          <label class="toggle-switch">
            <input type="checkbox" bind:checked={editAutoAdjust} />
            <span class="toggle-track"></span>
          </label>
        </div>

        <div class="divider" style="margin:12px 0 8px"></div>

        <!-- Goal value(s) -->
        <p class="goal-section-label">{editShared ? $_('goals_page.editor.target') : $_('goals_page.editor.targets_per_day')}</p>
        {#if editShared}
          <label class="form-label">{$_('goals_page.editor.value_label', { values: { unit: editIsPercent ? $_('goals_page.editor.value_percent_of_cal') : (_editUnit || '') } })}</label>
          <input class="input" type="text" inputmode="decimal" use:decimalInput
            placeholder="0" bind:value={editVal0} />
        {:else}
          {#each DAYS as day, i}
            <label class="form-label">{$_('goals_page.editor.value_label_day', { values: { day, unit: editIsPercent ? $_('goals_page.editor.value_percent_of_cal') : (_editUnit || '') } })}</label>
            <input class="input" type="text" inputmode="decimal" use:decimalInput
              placeholder="0" bind:value={editDayVals[i]} style="margin-bottom:8px" />
          {/each}
        {/if}
      </div>
      <div class="sheet-footer">
        {#if $goals[editStat?.id]}
          <button class="btn btn-danger w-full" style="margin-bottom:8px" on:click={deleteGoal}>
            {$_('goals_page.editor.remove_goal')}
          </button>
        {/if}
        <button class="btn btn-primary w-full" on:click={saveGoal}>{$_('goals.save_goal')}</button>
      </div>
    </div>
  </div>
{/if}

<!-- ── Water goal edit sheet ── -->
{#if editWaterOpen}
  <div use:portal class="sheet-backdrop" role="dialog" aria-modal="true"
    on:click={() => editWaterOpen = false} on:keydown={() => {}}>
    <div class="sheet-panel" on:click|stopPropagation on:keydown={() => {}}>
      <div class="sheet-handle"></div>
      <div class="sheet-header"><h3 class="sheet-title">{$_('goals_page.row.daily_water_goal')}</h3></div>
      <div class="sheet-body">
        <label class="form-label">{$_('goals_page.editor.water_sheet_label', { values: { unit: $waterUnit } })}</label>
        <input class="input" type="text" inputmode="decimal" use:decimalInput bind:value={editWaterVal}
          on:keydown={e => e.key === 'Enter' && saveWaterGoal()} />
        <button class="btn btn-primary w-full" style="margin-top:16px" on:click={saveWaterGoal}>{$_('common.save')}</button>
      </div>
    </div>
  </div>
{/if}

<!-- ── Save template sheet ── -->
{#if showSaveSheet}
  <div use:portal class="sheet-backdrop" role="dialog" aria-modal="true"
    on:click={() => showSaveSheet = false} on:keydown={() => {}}>
    <div class="sheet-panel" on:click|stopPropagation on:keydown={() => {}}>
      <div class="sheet-handle"></div>
      <div class="sheet-header"><h3 class="sheet-title">{$_('goals_page.templates.save_title')}</h3></div>
      <div class="sheet-body">
        <label class="form-label">{$_('goals_page.templates.template_name')}</label>
        <input class="input" placeholder={$_('goals_page.templates.template_placeholder')} bind:value={templateName}
          on:keydown={e => e.key === 'Enter' && saveTemplate()} />
        <p class="text-3 text-sm" style="margin-top:4px">
          {$_('goals_page.templates.snapshot_hint', { values: { count: Object.keys($goals).filter(k => $goals[k]?.min != null || $goals[k]?.max != null).length + ($waterGoalMl > 0 ? 1 : 0) } })}
        </p>
      </div>
      <div class="sheet-footer">
        <button class="btn btn-primary w-full" on:click={saveTemplate}
          disabled={!templateName.trim()}>{$_('goals_page.templates.save_template')}</button>
      </div>
    </div>
  </div>
{/if}

<!-- ── Apply confirm sheet ── -->
{#if showApplyConfirm}
  <div use:portal class="sheet-backdrop" role="dialog" aria-modal="true"
    on:click={() => showApplyConfirm = null} on:keydown={() => {}}>
    <div class="sheet-panel" on:click|stopPropagation on:keydown={() => {}}>
      <div class="sheet-handle"></div>
      <div class="sheet-header"><h3 class="sheet-title">{$_('goals_page.templates.apply_title')}</h3></div>
      <div class="sheet-body">
        <p>{@html $_('goals_page.templates.apply_confirm', { values: { name: showApplyConfirm.name } })}</p>
        <p class="text-3 text-sm">{$_('goals_page.templates.apply_desc', { values: { count: showApplyConfirm.goalCount || Object.keys(showApplyConfirm.goals).filter(k => showApplyConfirm.goals[k]?.min != null || showApplyConfirm.goals[k]?.max != null).length + (showApplyConfirm.waterGoalMl > 0 ? 1 : 0) } })}</p>
      </div>
      <div class="sheet-footer" style="display:flex;flex-direction:column;gap:8px">
        <button class="btn btn-primary w-full" on:click={() => applyTemplate(showApplyConfirm)}>{$_('goals_page.templates.apply')}</button>
        <button class="btn btn-ghost w-full" on:click={() => showApplyConfirm = null}>{$_('goals_page.templates.cancel')}</button>
      </div>
    </div>
  </div>
{/if}

<style>

  .tab-bar {
    display: flex; border-bottom: 1px solid var(--border);
    margin-top: 12px;
  }
  .tab-btn {
    flex: 1; padding: 10px 0; font-size: 14px; font-weight: 600;
    background: none; border: none; cursor: pointer;
    color: var(--text-3); border-bottom: 2px solid transparent;
    transition: color var(--dur-fast), border-color var(--dur-fast);
  }
  .tab-btn.active { color: var(--accent); border-bottom-color: var(--accent); }

  .card { border-left: 3px solid var(--accent); }

  .adaptive-card {
    padding: 14px 16px;
    margin-bottom: 12px;
    border-left-color: #6366f1;
  }
  .adaptive-header { display: flex; align-items: center; gap: 12px; }
  .adaptive-icon { font-size: 28px; color: #6366f1; flex-shrink: 0; }
  .adaptive-title { font-weight: 600; font-size: 15px; }
  .adaptive-sub { font-size: 13px; color: var(--text-3); margin-top: 2px; }
  .adaptive-stats {
    display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px;
    margin-top: 12px; font-size: 14px;
  }
  .adaptive-progress-track {
    height: 6px; border-radius: 3px; background: var(--surface-2);
    overflow: hidden; margin-top: 12px;
  }
  .adaptive-progress-fill {
    height: 100%; background: #6366f1; transition: width 300ms ease;
  }
  .adaptive-help {
    margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--border);
    font-size: 13px; line-height: 1.5; color: var(--text-2);
  }
  .adaptive-help p { margin: 0 0 8px; }
  .adaptive-help ol, .adaptive-help ul { margin: 0 0 8px; padding-left: 20px; }
  .adaptive-help li { margin-bottom: 4px; }

  .goal-row {
    display: flex; align-items: center; gap: 12px;
    padding: 12px 16px; width: 100%;
    background: none; border: none; cursor: pointer;
    text-align: left; color: var(--text-1);
    transition: background var(--dur-fast);
  }
  .goal-row:active { background: var(--surface-2); }
  .goal-row .material-symbols-rounded { color: var(--accent); }
  /* Rows in All Fields tab where the user has actually customized
     a value get a subtle accent-tinted left border so 'set vs not
     set' reads at a glance among the alphabetical dump. Only visible
     when the class is applied (Your Goals rows are all set by
     definition — no distinction there). */
  .goal-row.goal-row-set {
    border-left: 2px solid color-mix(in srgb, var(--accent) 60%, transparent);
  }
  .goal-info { flex: 1; display: flex; flex-direction: column; gap: 4px; }
  .divider { height: 1px; background: var(--border); margin: 0 16px; }

  .empty-state .material-symbols-rounded { color: var(--accent); opacity: 0.5; }

  .goal-progress-bar {
    height: 4px; background: var(--surface-3); border-radius: 2px;
    overflow: hidden; max-width: 200px;
  }
  .goal-progress-fill {
    height: 100%; background: var(--accent);
    border-radius: 2px;
    transition: width var(--dur-base) var(--ease-inout);
  }
  .goal-progress-fill.over { background: var(--red, #f44336); }
  /* Trend affordance in the goal-row rail — sits just before the
     chevron, subtle at rest, brightens on hover. stopPropagation on
     the click handler keeps the outer goal-row's openEdit from firing
     when the trend icon is tapped. */
  .goal-row .goal-trend {
    color: var(--text-3);
    opacity: 0.5;
    font-size: 18px;
    padding: 2px;
    border-radius: var(--radius-sm);
    cursor: pointer;
    transition: opacity 120ms ease, background 120ms ease, color 120ms ease;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .goal-row .goal-trend:hover,
  .goal-row .goal-trend:focus { opacity: 1; color: var(--text-1); background: var(--surface-2); outline: none; }
  /* Subtle staleness indicator next to a body-stat value (Weight, Body Fat,
     measurements) when the displayed reading is from a previous day, not
     today. Lives under the value line so users know the number is a
     fallback. Native tooltip on hover explains the 30-day window. */
  .goal-stale {
    color: var(--text-3);
    opacity: 0.7;
    font-style: italic;
    margin-left: 2px;
  }
  .empty-state {
    display: flex; flex-direction: column; align-items: center;
    gap: 8px; padding: 48px 16px; text-align: center;
  }

  /* Templates */
  .tpl-header {
    display: flex; flex-direction: column; gap: 8px;
    padding: 12px var(--page-px);
  }
  .tpl-save-btn { display: flex; align-items: center; gap: 6px; }
  .tpl-row {
    display: flex; align-items: center; gap: 12px;
    padding: 12px 16px;
  }
  .tpl-info { flex: 1; display: flex; flex-direction: column; gap: 3px; }
  .tpl-actions { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
  .tpl-btn { height: 32px; padding: 0 12px; font-size: 13px; color: var(--accent); }
  /* Template preview chips — small pill row under the name/meta
     so users see what they're applying before hitting Apply. */
  .tpl-preview-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-top: 4px;
  }
  .tpl-chip {
    display: inline-flex;
    align-items: center;
    padding: 2px 8px;
    border-radius: var(--radius-full);
    background: var(--surface-2);
    color: var(--text-2);
    font-size: 11px;
    font-weight: 600;
    border: 1px solid var(--border);
  }
  .tpl-chip-p { color: var(--macro-protein, #ec4899); border-color: color-mix(in srgb, var(--macro-protein, #ec4899) 40%, transparent); }
  .tpl-chip-c { color: var(--macro-carbs,   #22c55e); border-color: color-mix(in srgb, var(--macro-carbs,   #22c55e) 40%, transparent); }
  .tpl-chip-f { color: var(--macro-fat,     #f59e0b); border-color: color-mix(in srgb, var(--macro-fat,     #f59e0b) 40%, transparent); }

  /* Sheet */
  .sheet-backdrop {
    position: fixed; inset: 0; z-index: 200;
    background: rgba(0,0,0,0.5);
    display: flex; align-items: flex-end;
  }
  .sheet-panel {
    background: var(--surface-1);
    border-radius: var(--radius-xl) var(--radius-xl) 0 0;
    width: 100%; max-width: 600px; margin: 0 auto;
    max-height: 90dvh; display: flex; flex-direction: column;
    padding-bottom: var(--safe-bottom);
  }
  .sheet-handle {
    width: 36px; height: 4px; background: var(--border);
    border-radius: 2px; margin: 10px auto 0;
  }
  .sheet-header { padding: 12px 20px 4px; }
  .sheet-title  { font-size: 16px; font-weight: 700; }
  .sheet-body   { flex: 1; overflow-y: auto; padding: 8px 20px 0; display: flex; flex-direction: column; gap: 8px; }
  .sheet-footer { padding: 16px 20px; }

  /* Section labels */
  .goal-section-label {
    font-size: 11px; font-weight: 700;
    text-transform: uppercase; letter-spacing: 0.06em;
    color: var(--text-2, #999);
    margin: 10px 0 2px;
  }
  .goal-section-label:first-child { margin-top: 2px; }

  /* Toggle rows */
  .toggle-row {
    display: flex; align-items: center; justify-content: space-between;
    gap: 12px;
    padding: 6px 0;
  }
  .toggle-label-wrap {
    display: flex; flex-direction: column; gap: 2px;
    min-width: 0; flex: 1;
  }
  .toggle-hint {
    font-size: 12px; color: var(--text-2, #999);
    line-height: 1.3;
  }
  .toggle-label { font-size: 14px; }
  .toggle-switch { position: relative; display: inline-block; width: 44px; height: 24px; cursor: pointer; }
  .toggle-switch input { opacity: 0; width: 0; height: 0; }
  .toggle-track {
    position: absolute; inset: 0;
    background: var(--surface-3); border-radius: 12px;
    transition: background var(--dur-fast);
  }
  .toggle-track::after {
    content: ''; position: absolute;
    top: 3px; left: 3px;
    width: 18px; height: 18px;
    border-radius: 50%; background: white;
    transition: transform var(--dur-fast);
  }
  .toggle-switch input:checked ~ .toggle-track { background: var(--accent); }
  .toggle-switch input:checked ~ .toggle-track::after { transform: translateX(20px); }

  /* ────────────────────────────────────────────────────────────────────
     Desktop three-pane layout (Goals redesign)
     Default (mobile / force-mobile-layout): .goals-body is a plain block,
     rails hidden, center is unchanged. At ≥1280px on non-mobile builds
     the layout becomes a grid with sticky rails.
     ──────────────────────────────────────────────────────────────────── */
  .goals-body { display: block; }
  .goals-left-rail, .goals-right-rail { display: none; }

  .goals-rail-heading {
    font-size: 11px; font-weight: 700; letter-spacing: 0.8px;
    text-transform: uppercase; color: var(--text-3);
    padding: 2px 4px 8px;
  }

  /* Left rail nav buttons — full-width, icon + label. */
  .goals-rail-nav {
    display: flex; align-items: center; gap: 10px;
    width: 100%;
    padding: 8px 10px;
    margin-bottom: 2px;
    background: none; border: none; cursor: pointer;
    text-align: left;
    color: var(--text-2);
    font-size: 14px; font-weight: 500;
    border-radius: var(--radius-sm);
    transition: background 120ms ease, color 120ms ease;
  }
  .goals-rail-nav:hover { background: var(--surface-2); color: var(--text-1); }
  .goals-rail-nav.active {
    background: var(--accent-dim, color-mix(in srgb, var(--accent) 14%, transparent));
    color: var(--accent);
  }
  .goals-rail-nav .material-symbols-rounded {
    font-size: 18px; color: currentColor; flex-shrink: 0;
  }

  .goals-rail-seg { width: 100%; }
  /* Fallback copy of the shared .seg-control styles (defined :global() in
     Settings.svelte). Duplicated here because /goals can load without
     Settings ever mounting; without a local copy the rail's mode picker
     would render as three bare buttons. Kept in sync with Settings.svelte. */
  :global(.goals-rail-seg.seg-control) {
    position: relative;
    display: flex;
    background: var(--surface-2);
    border-radius: var(--radius-full);
    padding: 3px;
    gap: 2px;
  }
  :global(.goals-rail-seg.seg-control::before) {
    content: '';
    position: absolute;
    top: 3px;
    left: 3px;
    height: calc(100% - 6px);
    width: calc((100% - 6px - 2px * (var(--seg-count, 3) - 1)) / var(--seg-count, 3));
    background: var(--surface-1);
    border-radius: var(--radius-full);
    box-shadow: 0 1px 3px rgba(0,0,0,0.15);
    transform: translateX(calc(var(--seg-active, 0) * (100% + 2px)));
    transition: transform 220ms cubic-bezier(0.34, 1.56, 0.64, 1);
    pointer-events: none;
    z-index: 0;
  }
  :global(.goals-rail-seg .seg-opt) {
    position: relative;
    z-index: 1;
    flex: 1;
    padding: 6px 10px;
    font-size: 12px;
    font-weight: 500;
    color: var(--text-3);
    background: none;
    border: none;
    border-radius: var(--radius-full);
    cursor: pointer;
    white-space: nowrap;
    -webkit-tap-highlight-color: transparent;
    transition: color var(--dur-fast);
  }
  :global(.goals-rail-seg .seg-opt.seg-active) { color: var(--text-1); }
  :global(.goals-rail-seg .seg-opt:disabled) { opacity: 0.4; cursor: not-allowed; }
  .goals-rail-adaptive {
    display: flex; flex-direction: column; gap: 4px;
    padding: 8px 4px;
    background: var(--surface-2);
    border-radius: var(--radius-sm);
  }
  .goals-rail-adaptive-line {
    display: flex; justify-content: space-between; align-items: baseline;
    padding: 2px 6px;
    font-size: 13px;
  }

  .goals-rail-actions {
    display: flex; flex-direction: column; gap: 6px;
    margin-top: 16px;
    padding-top: 12px;
    border-top: 1px solid var(--border);
  }
  .goals-rail-actions .btn {
    width: 100%; justify-content: center;
  }

  /* ─── Right rail preview widgets ────────────────────────────────────── */
  .goals-preview-ring {
    display: flex; justify-content: center;
    padding: 4px 0 8px;
  }
  .goals-preview-macrobar {
    display: flex;
    height: 10px;
    border-radius: 5px;
    overflow: hidden;
    background: var(--surface-3);
    margin: 8px 0 4px;
  }
  .gp-seg { height: 100%; transition: width 300ms ease; }
  .gp-p { background: var(--macro-protein, #6366f1); }
  .gp-c { background: var(--macro-carbs,   #f59e0b); }
  .gp-f { background: var(--macro-fat,     #10b981); }
  .gp-empty { background: var(--surface-3); }
  .goals-preview-sum {
    font-size: 12px; color: var(--text-3);
    padding: 2px 2px 4px;
    font-variant-numeric: tabular-nums;
  }
  .goals-preview-warnings {
    display: flex; flex-direction: column; gap: 6px;
  }
  .gp-warn {
    display: flex; gap: 8px; align-items: flex-start;
    padding: 8px 10px;
    border-radius: var(--radius-sm);
    background: var(--surface-2);
    border: 1px solid var(--border);
    font-size: 12px; line-height: 1.35;
    color: var(--text-2);
  }
  .gp-warn .material-symbols-rounded { font-size: 16px; flex-shrink: 0; margin-top: 1px; }
  .gp-warn-warn { color: var(--red, #b91c1c); border-color: color-mix(in srgb, var(--red, #ef4444) 30%, var(--border)); }
  .gp-warn-warn .material-symbols-rounded { color: var(--red, #ef4444); }

  /* ─── Center: macros quick-set card ─────────────────────────────────── */
  .goals-macro-card {
    padding: 14px 16px;
    margin-bottom: 12px;
  }
  .goals-macro-head { margin-bottom: 10px; }
  .goals-macro-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 8px;
    margin-bottom: 10px;
  }
  .goals-macro-cell {
    display: flex; flex-direction: column; align-items: center; gap: 2px;
    padding: 10px 8px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    cursor: pointer;
    transition: background 120ms ease, border-color 120ms ease;
  }
  .goals-macro-cell:hover {
    background: var(--surface-3);
    border-color: color-mix(in srgb, var(--accent) 30%, var(--border));
  }
  .gm-lbl { font-size: 11px; color: var(--text-3); text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600; }
  .gm-val { font-size: 20px; font-weight: 700; color: var(--text-1); font-variant-numeric: tabular-nums; line-height: 1.1; }
  .gm-u   { font-size: 12px; font-weight: 500; color: var(--text-3); margin-left: 1px; }
  .gm-pct { font-size: 11px; color: var(--text-2); font-variant-numeric: tabular-nums; }
  .goals-macro-presets {
    display: flex; flex-wrap: wrap; gap: 6px;
  }
  .goals-macro-presets .chip {
    padding: 6px 10px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 999px;
    cursor: pointer;
    font-size: 12px; font-weight: 500;
    color: var(--text-2);
    transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
  }
  .goals-macro-presets .chip:hover {
    background: var(--accent-dim, color-mix(in srgb, var(--accent) 14%, transparent));
    color: var(--accent);
    border-color: color-mix(in srgb, var(--accent) 40%, var(--border));
  }
  /* Active preset — current P/C/F ratios match this one within
     ±2%. Same accent-dim treatment as hover but sticky. */
  .goals-macro-presets .chip.chip-active {
    background: var(--accent-dim, color-mix(in srgb, var(--accent) 14%, transparent));
    color: var(--accent);
    border-color: color-mix(in srgb, var(--accent) 60%, var(--border));
    font-weight: 600;
  }
  .goals-macro-current {
    display: inline-flex;
    align-items: center;
    font-size: 11px;
    color: var(--text-3);
    margin-left: 4px;
    white-space: nowrap;
  }
  .goals-macro-current strong {
    color: var(--text-2);
    font-weight: 600;
    margin-left: 3px;
  }

  /* ─── All-Fields filter input (desktop only; hidden on mobile) ─────── */
  .goals-all-filter {
    display: none; align-items: center; gap: 8px;
    padding: 8px 12px;
    margin: 0 var(--page-px) 12px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }
  .goals-all-filter .material-symbols-rounded {
    font-size: 18px; color: var(--text-3);
  }
  .goals-all-filter input {
    flex: 1; border: none; background: transparent; outline: none;
    color: var(--text-1); font-size: 14px;
  }

  /* ─── Desktop-only activation (≥1280px, non-force-mobile) ───────────── */
  @media (min-width: 1280px) {
    :global(html:not(.force-mobile-layout)) .goals-body {
      display: grid;
      grid-template-columns: 260px minmax(0, 1fr) 360px;
      column-gap: 20px;
      align-items: start;
    }
    :global(html:not(.force-mobile-layout)) .goals-left-rail,
    :global(html:not(.force-mobile-layout)) .goals-right-rail {
      display: block;
      position: sticky;
      /* Aligned with the top of .goals-main so the rail cards
         start at the SAME y as the first center card (Macros)
         on first paint. Goals has no sticky date bar or tab bar
         between the page-header and content, so sticky top is
         just page-header height + a little breathing room. */
      top: calc(var(--page-top, var(--safe-top)) + 72px + var(--hamburger-row, 0px));
      align-self: start;
      background: var(--surface-1);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      padding: 12px;
      /* NO max-height / overflow — same lesson as Wellness: the sticky
         rail un-sticks against .goals-body's bottom edge, so overflow
         content is reachable via normal page scroll rather than a hidden
         internal scrollbar. */
    }
    /* Old mobile tab bar collapses on desktop — rail nav replaces it. */
    :global(html:not(.force-mobile-layout)) .tab-bar { display: none; }
    /* Elements marked hidden-on-desktop (e.g. the inline Save Template
       button that the rail now owns). */
    :global(html:not(.force-mobile-layout)) .goals-desktop-hide { display: none !important; }
    /* Filter input is desktop-only (mobile keeps the plain list). */
    :global(html:not(.force-mobile-layout)) .goals-all-filter { display: flex; }

    /* All-Fields grid: multi-column card layout on wide viewports so
       long nutrient lists don't waste horizontal space. */
    :global(html:not(.force-mobile-layout)) .goals-all-card {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
      gap: 0;
      padding: 4px;
    }
    /* Your Goals cards get the same 2-col treatment on wider
       viewports (≥1440) so goal rows don't render as a tall single
       column with lots of whitespace to the right. At 1280-1439
       the middle column is too tight for 2-col, so single-col
       there (rely on auto-fill's own minimum). */
    @media (min-width: 1440px) {
      :global(html:not(.force-mobile-layout)) .goals-yours-card {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
        gap: 0;
        padding: 4px;
      }
      :global(html:not(.force-mobile-layout)) .goals-yours-card :global(.divider) {
        display: none;
      }
      :global(html:not(.force-mobile-layout)) .goals-yours-card :global(.goal-row) {
        border-bottom: 1px solid var(--border);
        padding: 12px 14px;
      }
    }
    :global(html:not(.force-mobile-layout)) .goals-all-card :global(.divider) {
      display: none;
    }
    :global(html:not(.force-mobile-layout)) .goals-all-card :global(.goal-row) {
      border-bottom: 1px solid var(--border);
      padding: 10px 12px;
    }
  }

</style>
