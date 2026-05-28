<script>
  import { onMount } from 'svelte';
  import { slide } from 'svelte/transition';
  import { _ } from 'svelte-i18n';
  import { DB, localDateStr } from '../lib/db.js';
  import { NtApi } from '../lib/api.js';
  import { portal } from '../lib/portal.js';
  import { goals, goalTemplates, energyUnit, weightUnit, heightUnit, lengthUnit, visibleNutriments, hiddenBodyStats, waterGoalMl, waterUnit, pageBanners, bannerStyle, wellnessEnabled, fitbitEnabled, garminEnabled, calorieGoalMode, calorieGoalFactor, healthConnectEnabled } from '../stores/settings.js';
  import GoalsBanner from '../components/banners/GoalsBanner.svelte';
  import { NUTRIMENTS, Nutrition } from '../lib/nutrition.js';
  import { readBodyStat } from '../lib/body-stats-unit.js';
  import { loadEntry } from '../stores/diary.js';
  import { showSuccess } from '../stores/toast.js';

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
  $: configuredNutrients = allNutrients.filter(s => $goals[s.id]);
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

  function applyTemplate(tpl) {
    goals.set({ ...tpl.goals });
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
  $: _hasDevice = $fitbitEnabled || $garminEnabled || $healthConnectEnabled;
  $: _fixedGoal = $goals.calories?.max ?? $goals.calories?.min ?? 2000;
  $: _effectiveCalGoal =
       ($calorieGoalMode === 'dynamic' && _dynamicCaloriesOut != null)
         ? Math.round(_dynamicCaloriesOut * $calorieGoalFactor)
       : ($calorieGoalMode === 'adaptive' && _adaptive?.ready && _adaptive.tdee != null)
         ? Math.round(_adaptive.tdee * $calorieGoalFactor)
       : _fixedGoal;

  async function loadWellnessToday() {
    _wellnessLoaded = true;
    let fitbit = {}, garmin = {};
    try { if ($fitbitEnabled) { const r = await NtApi.get(`/api/wellness/fitbit/data?date=${today}`); fitbit = r[today] || {}; } } catch {}
    try { if ($garminEnabled) { const r = await NtApi.get(`/api/wellness/garmin/data?date=${today}`); garmin = r[today] || {}; } } catch {}
    todayWellness = { ...fitbit, ...garmin };
  }

  // Fire as soon as settings stores resolve true — avoids the first-load race
  // where onMount ran before settings loaded from server (both start false).
  $: if (($fitbitEnabled || $garminEnabled) && !_wellnessLoaded) loadWellnessToday();

  onMount(async () => {
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
    const n = parseFloat(val) || 0;
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
  function openEdit(stat) {
    editStat = stat;
    const g = $goals[stat.id];
    const kj = stat.id === 'calories_out' && $energyUnit === 'kJ';
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
    const kj = editStat.id === 'calories_out' && $energyUnit === 'kJ';
    const toStore = (n) => kj && n != null ? n / 4.184 : n;
    const val = toStore(parseFloat(editVal0) || null);
    const dayArr = editShared
      ? Array(7).fill(val)
      : editDayVals.map(v => toStore(parseFloat(v) || null));

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

    goals.update(g => ({ ...g, [editStat.id]: entry }));
    editOpen = false;
    showSuccess($_('goals.toast.goal_saved'));
  }

  function deleteGoal() {
    if (!editStat) return;
    if (!confirm(`Remove goal for ${editStat.label || editStat.id}?`)) return;
    goals.update(g => { const n = {...g}; delete n[editStat.id]; return n; });
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

  function getTarget(stat) {
    const g = $goals[stat.id];
    if (!g) return null;
    let raw;
    if (g.sharedGoal !== false) {
      raw = g.max ?? g.min ?? null;
    } else {
      const d = new Date().getDay();
      raw = (g.days && g.days[d] != null) ? g.days[d] : (g.max ?? g.min ?? null);
    }
    if (raw == null || !g.isPercent) return raw;
    const density = MACRO_DENSITY[stat.id];
    if (!density) return raw;
    const calGoal = $goals.calories?.max ?? $goals.calories?.min ?? 2000;
    return Math.round(calGoal * raw / 100 / density);
  }

  function getPct(stat, totals, bodyStats, wellness, recent) {
    const cur = getTodayValue(stat, totals, bodyStats, wellness, recent);
    const tgt = getTarget(stat);
    if (cur == null || tgt == null || tgt === 0) return 0;
    return Math.min(100, Math.round(cur / tgt * 100));
  }
</script>

<div class="page-shell">
  <header class="page-header" class:has-banner={$pageBanners} class:banner-gradient={$bannerStyle === 'gradient'}>
    {#if $bannerStyle === 'animated'}<GoalsBanner />{/if}
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

    <!-- ── Adaptive TDEE readiness card (shown only when adaptive mode is on) ── -->
    {#if activeTab === 'yours' && $calorieGoalMode === 'adaptive' && _adaptiveLoaded}
      <div class="card adaptive-card">
        <div class="adaptive-header">
          <span class="material-symbols-rounded adaptive-icon">trending_up</span>
          <div style="flex:1;min-width:0">
            <div class="adaptive-title">Adaptive TDEE</div>
            {#if _adaptive?.ready}
              {@const _tdeeE = Nutrition.displayEnergy(_adaptive.tdee, $energyUnit)}
              <div class="adaptive-sub">
                Learned <strong>{_tdeeE.value.toLocaleString()} {_tdeeE.unit}/day</strong> · weight trend
                {_adaptive.trendKgPerWeek > 0 ? '+' : ''}{_adaptive.trendKgPerWeek} kg/week
              </div>
            {:else}
              <div class="adaptive-sub">
                Building up data: <strong>{_adaptive?.daysAvailable ?? 0} / {_adaptive?.daysRequired ?? 21}</strong> days with both weight + diary
              </div>
            {/if}
          </div>
          <button class="btn-icon" on:click={() => _showAdaptiveHelp = !_showAdaptiveHelp}
            aria-label="How it works" title="How it works">
            <span class="material-symbols-rounded">{_showAdaptiveHelp ? 'expand_less' : 'help_outline'}</span>
          </button>
        </div>
        {#if _adaptive?.ready}
          {@const _todayE = Nutrition.displayEnergy(_effectiveCalGoal, $energyUnit)}
          <div class="adaptive-stats">
            <div><span class="text-3 text-sm">Today's goal</span><br><strong>{_todayE.value.toLocaleString()} {_todayE.unit}</strong></div>
            <div><span class="text-3 text-sm">Confidence</span><br><strong>{Math.round((_adaptive.confidence || 0) * 100)}%</strong></div>
            <div><span class="text-3 text-sm">Weight source</span><br><strong style="text-transform:capitalize">{_adaptive.weightSource}</strong></div>
          </div>
        {:else}
          <div class="adaptive-progress-track">
            <div class="adaptive-progress-fill"
              style="width:{Math.min(100, ((_adaptive?.daysAvailable ?? 0) / (_adaptive?.daysRequired ?? 21)) * 100)}%"></div>
          </div>
          {@const _fixedE = Nutrition.displayEnergy(_fixedGoal, $energyUnit)}
          <p class="text-3 text-sm" style="margin:8px 0 0">
            Until ready, your fixed goal of {_fixedE.value.toLocaleString()} {_fixedE.unit} applies.
          </p>
        {/if}
        {#if _showAdaptiveHelp}
          <div class="adaptive-help" transition:slide={{ duration: 180 }}>
            <p><strong>How it works.</strong> Adaptive TDEE learns your true daily energy expenditure from your weight trend over the last 35 days, paired with how much you actually ate. The math:</p>
            <ol>
              <li>Smooth your weight series (linear regression over 35 days).</li>
              <li>Convert the trend into daily energy balance (1 kg of body mass ≈ 7,700 kcal).</li>
              <li>TDEE = average daily intake − that daily balance.</li>
            </ol>
            <p><strong>For best results:</strong></p>
            <ul>
              <li><strong>Weigh yourself frequently</strong> — daily is best, every other day is fine. Sparse weights are interpolated, but more measurements = tighter signal. A connected scale (Withings, Fitbit, Garmin, Health Connect) is automatic; manual body-stats entries also work.</li>
              <li><strong>Log your food consistently.</strong> Missing days are dropped from the calculation. The estimate gets noisy if you log half your days.</li>
              <li><strong>Don't switch goals mid-window.</strong> The 35-day rolling average converges over time. If you bounce between cuts and bulks weekly, the learned TDEE will lag.</li>
              <li><strong>Re-weigh in similar conditions</strong> — first thing in the morning, after using the bathroom, before food/drink. Day-to-day fluctuations are mostly water; the trend is what matters.</li>
            </ul>
            <p><strong>Caveats.</strong> Big changes in activity (started running, broke a leg) take ~2 weeks to fully reflect. Travel weeks with under-logged food can pull the estimate up. The learned TDEE is multiplied by your goal factor (Lose -20% / Maintain / Gain +20%) to get your actual daily target.</p>
          </div>
        {/if}
      </div>
    {/if}

    <!-- ── Your Goals tab ── -->
    {#if activeTab === 'yours'}
      {#if !hasAnyGoal}
        <div class="empty-state">
          <span class="material-symbols-rounded" style="font-size:48px;opacity:0.2">flag</span>
          <p>No goals set yet.</p>
          <p class="text-3 text-sm">Go to <strong>All Fields</strong> tab to add goals.</p>
        </div>
      {:else}
        {#if configuredBodyStats.length > 0}
          <p class="section-title">Body Stats</p>
          <div class="card">
            {#each configuredBodyStats as stat, i}
              {#if i > 0}<div class="divider"></div>{/if}
              <button class="goal-row" on:click={() => openEdit(stat)}>
                <div class="goal-info">
                  <span class="font-medium">{stat.label}</span>
                  {#if getTarget(stat) != null}
                    {@const pct = getPct(stat, todayTotals, todayBodyStats, todayWellness, recentBodyStats)}
                    {@const tgt = getTarget(stat)}
                    {@const cur = getTodayValue(stat, todayTotals, todayBodyStats, todayWellness, recentBodyStats)}
                    {@const isMin = $goals[stat.id]?.isMin}
                    {@const bad = cur != null && tgt != null && (isMin ? cur < tgt : cur > tgt)}
                    {@const stale = getBodyStatStaleness(stat, recentBodyStats)}
                    <div class="goal-progress-bar">
                      <div class="goal-progress-fill" class:over={bad} style="width:{pct}%"></div>
                    </div>
                    <span class="text-3 text-sm">
                      {cur != null ? (Math.round(cur*10)/10).toLocaleString() : '—'} / {tgt.toLocaleString()} {stat.unit || ''}
                      {#if isMin}<span style="opacity:0.6">(min)</span>{/if}
                      {#if stale}<span class="goal-stale" title="Most recent reading within the last 30 days, used until you log a new value">· {stale}</span>{/if}
                    </span>
                  {:else}
                    <span class="text-3 text-sm">Not set</span>
                  {/if}
                </div>
                <span class="material-symbols-rounded text-3" style="font-size:18px">chevron_right</span>
              </button>
            {/each}
          </div>
        {/if}

        {#if configuredNutrients.length > 0}
          <p class="section-title">Nutrients</p>
          <div class="card">
            {#each configuredNutrients as stat, i}
              {#if i > 0}<div class="divider"></div>{/if}
              <button class="goal-row" on:click={() => openEdit(stat)}>
                <div class="goal-info">
                  <span class="font-medium">{stat.label}{#if stat.id === 'calories' && $calorieGoalMode === 'dynamic' && _dynamicCaloriesOut != null} ⚡{:else if stat.id === 'calories' && $calorieGoalMode === 'adaptive' && _adaptive?.ready} 📈{/if}</span>
                  {#if getTarget(stat) != null}
                    {@const tgt = stat.id === 'calories' && ($calorieGoalMode === 'dynamic' || ($calorieGoalMode === 'adaptive' && _adaptive?.ready)) ? _effectiveCalGoal : getTarget(stat)}
                    {@const cur = getTodayValue(stat, todayTotals, todayBodyStats, todayWellness, recentBodyStats)}
                    {@const pct = tgt > 0 ? Math.min(100, Math.round((cur ?? 0) / tgt * 100)) : 0}
                    {@const isMin = $goals[stat.id]?.isMin}
                    {@const bad = cur != null && tgt != null && (isMin ? cur < tgt : cur > tgt)}
                    <div class="goal-progress-bar">
                      <div class="goal-progress-fill" class:over={bad} style="width:{pct}%"></div>
                    </div>
                    <span class="text-3 text-sm">
                      {cur != null ? (Math.round(cur*10)/10).toLocaleString() : '—'} / {tgt.toLocaleString()} {stat.unit || ''}
                      {#if isMin}<span style="opacity:0.6">(min)</span>{/if}
                    </span>
                  {:else}
                    <span class="text-3 text-sm">Not set</span>
                  {/if}
                </div>
                <span class="material-symbols-rounded text-3" style="font-size:18px">chevron_right</span>
              </button>
            {/each}
          </div>
        {/if}

      {/if}

      <!-- Water Goal — alphabetically before Wellness -->
      <p class="section-title">Water</p>
      <div class="card">
        <button class="goal-row" on:click={openEditWater}>
          <div class="goal-info">
            <span class="font-medium">Daily Water Goal</span>
            <div class="goal-progress-bar">
              <div class="goal-progress-fill" style="width:{waterPct}%"></div>
            </div>
            <span class="text-3 text-sm">{waterTodayDisplay.toLocaleString()} / {waterGoalDisplay.toLocaleString()} {$waterUnit}</span>
          </div>
          <span class="material-symbols-rounded text-3" style="font-size:18px">chevron_right</span>
        </button>
      </div>

      {#if configuredWellness.length > 0}
        <p class="section-title">Wellness</p>
        <div class="card">
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
                  <span class="text-3 text-sm">{cur != null ? (Math.round(cur*10)/10).toLocaleString() : '—'} / {tgt.toLocaleString()} {stat.unit}</span>
                {:else}
                  <span class="text-3 text-sm">Not set</span>
                {/if}
              </div>
              <span class="material-symbols-rounded text-3" style="font-size:18px">chevron_right</span>
            </button>
          {/each}
        </div>
      {/if}

    <!-- ── All Fields tab ── -->
    {:else if activeTab === 'all'}
      <p class="text-3 text-sm" style="padding:0 var(--page-px) 8px">Tap any field to set or edit its goal.</p>

      <!-- Body Stats -->
      <p class="section-title">Body Stats</p>
      <div class="card">
        {#each bodyStatsWithUnit as stat, i}
          {#if i > 0}<div class="divider"></div>{/if}
          <button class="goal-row" on:click={() => openEdit(stat)}>
            <div class="goal-info">
              <span class="font-medium">{stat.label}</span>
              {#if $goals[stat.id]}
                {@const pct = getPct(stat, todayTotals, todayBodyStats, todayWellness, recentBodyStats)}
                {@const tgt = getTarget(stat)}
                {@const cur = getTodayValue(stat, todayTotals, todayBodyStats, todayWellness, recentBodyStats)}
                {@const stale = getBodyStatStaleness(stat, recentBodyStats)}
                <div class="goal-progress-bar">
                  <div class="goal-progress-fill" style="width:{pct}%"></div>
                </div>
                <span class="text-3 text-sm">
                  {cur != null ? (Math.round(cur*10)/10).toLocaleString() : '—'} / {tgt.toLocaleString()} {stat.unit}
                  {#if stale}<span class="goal-stale" title="Most recent reading within the last 30 days, used until you log a new value">· {stale}</span>{/if}
                </span>
              {:else}
                <span class="text-3 text-sm" style="opacity:0.4">No goal</span>
              {/if}
            </div>
            <span class="material-symbols-rounded text-3" style="font-size:18px">chevron_right</span>
          </button>
        {/each}
      </div>

      <!-- Nutrients -->
      <p class="section-title">Nutrients</p>
      <div class="card">
        {#each allNutrients as stat, i}
          {#if i > 0}<div class="divider"></div>{/if}
          <button class="goal-row" on:click={() => openEdit(stat)}>
            <div class="goal-info">
              <span class="font-medium">{stat.label}</span>
              {#if $goals[stat.id]}
                {@const pct = getPct(stat, todayTotals, todayBodyStats, todayWellness, recentBodyStats)}
                {@const tgt = getTarget(stat)}
                {@const cur = getTodayValue(stat, todayTotals, todayBodyStats, todayWellness, recentBodyStats)}
                <div class="goal-progress-bar">
                  <div class="goal-progress-fill" style="width:{pct}%"></div>
                </div>
                <span class="text-3 text-sm">{cur != null ? (Math.round(cur*10)/10).toLocaleString() : '—'} / {tgt.toLocaleString()} {stat.unit}</span>
              {:else}
                <span class="text-3 text-sm" style="opacity:0.4">No goal</span>
              {/if}
            </div>
            <span class="material-symbols-rounded text-3" style="font-size:18px">chevron_right</span>
          </button>
        {/each}
      </div>

      <!-- Water -->
      <p class="section-title">Water</p>
      <div class="card">
        <button class="goal-row" on:click={openEditWater}>
          <div class="goal-info">
            <span class="font-medium">Daily Water Goal</span>
            <div class="goal-progress-bar">
              <div class="goal-progress-fill" style="width:{waterPct}%"></div>
            </div>
            <span class="text-3 text-sm">{waterTodayDisplay.toLocaleString()} / {waterGoalDisplay.toLocaleString()} {$waterUnit}</span>
          </div>
          <span class="material-symbols-rounded text-3" style="font-size:18px">chevron_right</span>
        </button>
      </div>

      <!-- Wellness (when enabled) -->
      {#if $wellnessEnabled}
        <p class="section-title">Wellness</p>
        <div class="card">
          {#each WELLNESS_GOALS as stat, i}
            {@const _kjMode = stat.id === 'calories_out' && $energyUnit === 'kJ'}
            {@const _statUnit = _kjMode ? 'kJ' : stat.unit}
            {#if i > 0}<div class="divider"></div>{/if}
            <button class="goal-row" on:click={() => openEdit(stat)}>
              <div class="goal-info">
                <span class="font-medium">{stat.label}</span>
                {#if $goals[stat.id]}
                  {@const pct = getPct(stat, todayTotals, todayBodyStats, todayWellness, recentBodyStats)}
                  {@const _tgtRaw = getTarget(stat)}
                  {@const _curRaw = getTodayValue(stat, todayTotals, todayBodyStats, todayWellness, recentBodyStats)}
                  {@const tgt = _kjMode && _tgtRaw != null ? Math.round(Nutrition.kcalToKj(_tgtRaw)) : _tgtRaw}
                  {@const cur = _kjMode && _curRaw != null ? Nutrition.kcalToKj(_curRaw) : _curRaw}
                  <div class="goal-progress-bar">
                    <div class="goal-progress-fill" style="width:{pct}%"></div>
                  </div>
                  <span class="text-3 text-sm">{cur != null ? (Math.round(cur*10)/10).toLocaleString() : '—'} / {tgt.toLocaleString()} {_statUnit}</span>
                {:else}
                  <span class="text-3 text-sm" style="opacity:0.4">No goal</span>
                {/if}
              </div>
              <span class="material-symbols-rounded text-3" style="font-size:18px">chevron_right</span>
            </button>
          {/each}
        </div>
      {/if}

    <!-- ── Templates tab ── -->
    {:else if activeTab === 'templates'}
      <div class="tpl-header">
        <p class="text-3 text-sm">Save your current goals as a named template to reuse later.</p>
        <button class="btn btn-primary tpl-save-btn" on:click={openSaveSheet}>
          <span class="material-symbols-rounded" style="font-size:18px">save</span>
          Save Current Goals
        </button>
      </div>

      {#if $goalTemplates.length === 0}
        <div class="empty-state">
          <span class="material-symbols-rounded" style="font-size:48px;opacity:0.2">bookmarks</span>
          <p>No templates yet.</p>
          <p class="text-3 text-sm">Save your current goals to create your first template.</p>
        </div>
      {:else}
        <div class="card">
          {#each $goalTemplates as tpl, i}
            {#if i > 0}<div class="divider"></div>{/if}
            <div class="tpl-row">
              <div class="tpl-info">
                <span class="font-medium">{tpl.name}</span>
                <span class="text-3 text-sm">{formatDate(tpl.createdAt)} · {tpl.goalCount || Object.keys(tpl.goals).filter(k => tpl.goals[k]?.min != null || tpl.goals[k]?.max != null).length + (tpl.waterGoalMl > 0 ? 1 : 0)} goals</span>
              </div>
              <div class="tpl-actions">
                <button class="btn btn-ghost tpl-btn" on:click={() => showApplyConfirm = tpl}>
                  Apply
                </button>
                <button class="btn-icon" style="color:var(--text-3)" on:click={() => deleteTemplate(tpl.id)} title="Delete template">
                  <span class="material-symbols-rounded" style="font-size:20px">delete</span>
                </button>
              </div>
            </div>
          {/each}
        </div>
      {/if}
    {/if}

    <div style="height:24px"></div>
  </div>
</div>

<!-- ── Goal editor sheet ── -->
{#if editOpen && editStat}
  {@const _editUnit = (editStat.id === 'calories_out' && $energyUnit === 'kJ') ? 'kJ' : editStat.unit}
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
          <p class="goal-section-label">Display</p>
          <div class="toggle-row">
            <label class="toggle-label">Show in Diary</label>
            <label class="toggle-switch">
              <input type="checkbox" bind:checked={editShowDiary} />
              <span class="toggle-track"></span>
            </label>
          </div>
          <div class="toggle-row">
            <label class="toggle-label">Show in Statistics</label>
            <label class="toggle-switch">
              <input type="checkbox" bind:checked={editShowStats} />
              <span class="toggle-track"></span>
            </label>
          </div>
        {/if}

        <!-- Goal behavior -->
        <p class="goal-section-label">Goal Behavior</p>
        <div class="toggle-row">
          <div class="toggle-label-wrap">
            <label class="toggle-label">Same goal every day</label>
            <span class="toggle-hint">{editShared ? 'One target for every day' : 'Different target per weekday'}</span>
          </div>
          <label class="toggle-switch">
            <input type="checkbox" bind:checked={editShared} />
            <span class="toggle-track"></span>
          </label>
        </div>
        <div class="toggle-row">
          <div class="toggle-label-wrap">
            <label class="toggle-label">Minimum Goal</label>
            <span class="toggle-hint">{editIsMin ? 'Must reach at least this value' : 'Must not exceed this value'}</span>
          </div>
          <label class="toggle-switch">
            <input type="checkbox" bind:checked={editIsMin} />
            <span class="toggle-track"></span>
          </label>
        </div>
        {#if isPercentEligible(editStat)}
          <div class="toggle-row">
            <div class="toggle-label-wrap">
              <label class="toggle-label">Goal as % of calories</label>
              <span class="toggle-hint">Target scales with your calorie goal</span>
            </div>
            <label class="toggle-switch">
              <input type="checkbox" bind:checked={editIsPercent} />
              <span class="toggle-track"></span>
            </label>
          </div>
        {/if}
        <div class="toggle-row">
          <div class="toggle-label-wrap">
            <label class="toggle-label">Auto-adjust to activity</label>
            <span class="toggle-hint">Adjusts based on calories burned from wearables</span>
          </div>
          <label class="toggle-switch">
            <input type="checkbox" bind:checked={editAutoAdjust} />
            <span class="toggle-track"></span>
          </label>
        </div>

        <div class="divider" style="margin:12px 0 8px"></div>

        <!-- Goal value(s) -->
        <p class="goal-section-label">Target{editShared ? '' : 's per day'}</p>
        {#if editShared}
          <label class="form-label">Value ({editIsPercent ? '% of calories' : (_editUnit || '')})</label>
          <input class="input" type="number" min="0" step="any"
            placeholder="0" bind:value={editVal0} />
        {:else}
          {#each DAYS as day, i}
            <label class="form-label">{day} ({editIsPercent ? '% of calories' : (_editUnit || '')})</label>
            <input class="input" type="number" min="0" step="any"
              placeholder="0" bind:value={editDayVals[i]} style="margin-bottom:8px" />
          {/each}
        {/if}
      </div>
      <div class="sheet-footer">
        {#if $goals[editStat?.id]}
          <button class="btn btn-danger w-full" style="margin-bottom:8px" on:click={deleteGoal}>
            Remove Goal
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
      <div class="sheet-header"><h3 class="sheet-title">Daily Water Goal</h3></div>
      <div class="sheet-body">
        <label class="form-label">Goal ({$waterUnit})</label>
        <input class="input" type="number" min="0" step="0.1" bind:value={editWaterVal}
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
      <div class="sheet-header"><h3 class="sheet-title">Save as Template</h3></div>
      <div class="sheet-body">
        <label class="form-label">Template Name</label>
        <input class="input" placeholder="e.g. Cut — Summer 2025" bind:value={templateName}
          on:keydown={e => e.key === 'Enter' && saveTemplate()} />
        <p class="text-3 text-sm" style="margin-top:4px">
          Saves a snapshot of all {Object.keys($goals).filter(k => $goals[k]?.min != null || $goals[k]?.max != null).length + ($waterGoalMl > 0 ? 1 : 0)} current goals.
        </p>
      </div>
      <div class="sheet-footer">
        <button class="btn btn-primary w-full" on:click={saveTemplate}
          disabled={!templateName.trim()}>Save Template</button>
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
      <div class="sheet-header"><h3 class="sheet-title">Apply Template</h3></div>
      <div class="sheet-body">
        <p>Apply <strong>{showApplyConfirm.name}</strong>?</p>
        <p class="text-3 text-sm">This will replace your current goals with the {showApplyConfirm.goalCount || Object.keys(showApplyConfirm.goals).filter(k => showApplyConfirm.goals[k]?.min != null || showApplyConfirm.goals[k]?.max != null).length + (showApplyConfirm.waterGoalMl > 0 ? 1 : 0)} goals saved in this template.</p>
      </div>
      <div class="sheet-footer" style="display:flex;flex-direction:column;gap:8px">
        <button class="btn btn-primary w-full" on:click={() => applyTemplate(showApplyConfirm)}>Apply</button>
        <button class="btn btn-ghost w-full" on:click={() => showApplyConfirm = null}>Cancel</button>
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
</style>
