<script>
  import { onMount, onDestroy } from 'svelte';
  import { slide } from 'svelte/transition';
  import { _ } from 'svelte-i18n';
  import { push } from 'svelte-spa-router';
  import { portal } from '../lib/portal.js';
  import { dragScroll } from '../lib/drag-scroll.js';
  import Chart from 'chart.js/auto';
  import { DB, localDateStr } from '../lib/db.js';
  import { NtApi } from '../lib/api.js';
  import { currentDate } from '../stores/diary.js';
  import { NUTRIMENTS, Nutrition } from '../lib/nutrition.js';
  import { readBodyStat } from '../lib/body-stats-unit.js';
  import { goals, energyUnit, weightUnit, lengthUnit, statsChartType, statsYZero,
           statsAvgLine, statsGoalLine, statsTrendLine, statsIncludeToday, statsShowEmptyDays,
           statsMetricOrder, statsHiddenMetrics,
           hiddenBodyStats, dateFormat, pageBanners, bannerStyle,
           fitbitEnabled, garminEnabled, withingsEnabled, googleHealthEnabled, healthConnectEnabled, fitbitFamilyEnabled, wellnessMetrics,
           calorieGoalMode,
           fastingEnabled } from '../stores/settings.js';
  import FastingInsights from '../components/diary/FastingInsights.svelte';
  import { isNative } from '../lib/platform.js';
  let _waterShowInStats = DB.getSetting('waterShowInStats', true);
  let _waterUnit        = DB.getSetting('waterUnit', 'ml');
  // Reload when settings change
  if (typeof window !== 'undefined') {
    window.addEventListener('wl:setting', (e) => {
      const k = e.detail?.key;
      if (k === 'waterShowInStats' || k === 'waterUnit') {
        _waterShowInStats = DB.getSetting('waterShowInStats', true);
        _waterUnit        = DB.getSetting('waterUnit', 'ml');
      }
    });
  }

  let canvasEl;
  let chart = null;
  let range = '30';   // '7','14','30','90','180','365','all','custom'
  let customStart = '';
  let customEnd   = localDateStr(); // today
  // Default metric respects the user's Statistics category order (Settings →
  // Statistics → Categories drag-reorder), skipping hidden AND currently-
  // unavailable ones. Falls back to the energy metric (calories /
  // kilojoules by unit preference) when no valid ordered candidate exists.
  // Fixes #155 where calories was hardcoded as the default regardless of
  // the ordered list; the availability check also handles the corner
  // where a user had e.g. wl_steps first, then disconnected their wearable
  // — we skip it rather than paint an empty chart.
  function _isCurrentlyAvailable(key) {
    if (!key) return false;
    if (key.startsWith('wl_')) {
      const hasWellness = $fitbitFamilyEnabled || $garminEnabled;
      if (key === 'wl_muscle') return hasWellness || $withingsEnabled;
      return hasWellness;
    }
    if (key === 'water') return _waterShowInStats;
    // Body-stat keys can be individually hidden via Settings → Body.
    const isBody = ['weight','neck','waist','hips','chest','thighs','biceps','calves','body_fat','body_water'].includes(key);
    if (isBody) return !($hiddenBodyStats || []).includes(key);
    // Nutriments and anything else — always in the picker.
    return true;
  }
  function _initialMetric() {
    const order = Array.isArray($statsMetricOrder) ? $statsMetricOrder : [];
    const hidden = new Set(Array.isArray($statsHiddenMetrics) ? $statsHiddenMetrics : []);
    const first = order.find(k => k && !hidden.has(k) && _isCurrentlyAvailable(k));
    if (first) return first;
    return ($energyUnit === 'kJ') ? 'kilojoules' : 'calories';
  }
  let metric = _initialMetric();
  let data   = [];    // [{ date, val }]
  let loading = false;
  let summary = null; // { avg, min, max, total, daysWithData }
  let _loadVer = 0;   // cancel stale concurrent loadData calls
  // Desktop-only rail + timeline UI state. All gated by the same
  // :global(html:not(.force-mobile-layout)) block below in <style>, so
  // mobile behavior is untouched even if these vars change.
  let _railQuery = '';                          // #2 left-rail filter
  let _timelineExpandedMonths = new Set();      // #4 collapsible months
  let _compareMetric = '';                      // #5 compare mode (deferred)

  // Cumulative metrics accumulate throughout the day (calories, steps, water, etc.).
  // Excluded from charts by default until the day is complete to avoid trend distortion.
  // Point-in-time metrics (sleep score, weight, HRV, RHR) are not affected.
  function isCumulative(m) {
    if (!m) return false;
    if (NUTRIMENTS.some(n => n.id === m)) return true;
    if (m === 'water' || m === 'water_ml') return true;
    if (m === 'wl_steps' || m === 'wl_active') return true;
    return false;
  }

  // Wellness metrics — shown only when relevant integration is enabled.
  // The "fitbit family" (fitbit / google-health / health-connect) all flow
  // through the same /api/wellness/fitbit/data endpoint server-side; the
  // shared derived store lives in stores/settings.js so every consumer
  // stays in sync as new sources are added.
  $: _hasWellness = $fitbitFamilyEnabled || $garminEnabled;
  function _wlVisible(apiField) {
    return $wellnessMetrics == null || $wellnessMetrics.includes(apiField);
  }
  $: WELLNESS_METRICS = [
    ...(_hasWellness ? [
      ...(_wlVisible('steps')             ? [{ value: 'wl_steps',  label: 'Steps',        unit: 'steps', apiSource: 'fitgarm', apiField: 'steps' }] : []),
      ...(_wlVisible('active_minutes')    ? [{ value: 'wl_active', label: 'Active Min.',   unit: 'min',   apiSource: 'fitgarm', apiField: 'active_minutes' }] : []),
      ...(_wlVisible('sleep_duration_min')? [{ value: 'wl_sleep',  label: 'Sleep',         unit: 'hr',    apiSource: 'fitgarm', apiField: 'sleep_duration_min', fmtVal: v => Math.round(v / 6) / 10 }] : []),
      ...(_wlVisible('resting_hr')        ? [{ value: 'wl_rhr',    label: 'Resting HR',    unit: 'bpm',   apiSource: 'fitgarm', apiField: 'resting_hr' }] : []),
      ...(_wlVisible('hrv_daily_rmssd')   ? [{ value: 'wl_hrv',    label: 'HRV',           unit: 'ms',    apiSource: 'fitgarm', apiField: 'hrv_daily_rmssd' }] : []),
      ...(_wlVisible('spo2_avg')          ? [{ value: 'wl_spo2',   label: 'SpO2',          unit: '%',     apiSource: 'fitgarm', apiField: 'spo2_avg' }] : []),
    ] : []),
    ...(($withingsEnabled || $fitbitFamilyEnabled) && _wlVisible('muscle_mass_kg') ? [
      { value: 'wl_muscle', label: 'Muscle Mass',   unit: '',      apiSource: 'withings', apiField: 'muscle_mass_kg', isWeight: true },
    ] : []),
  ];

  // All available metrics = NUTRIMENTS + body stats + wellness
  $: BODY_STATS = [
    { value: 'weight',     label: 'Weight',     unit: $weightUnit || 'lb' },
    { value: 'neck',       label: 'Neck',       unit: $lengthUnit || 'in' },
    { value: 'waist',      label: 'Waist',      unit: $lengthUnit || 'in' },
    { value: 'hips',       label: 'Hips',       unit: $lengthUnit || 'in' },
    { value: 'chest',      label: 'Chest',      unit: $lengthUnit || 'in' },
    { value: 'thighs',     label: 'Thighs',     unit: $lengthUnit || 'in' },
    { value: 'biceps',     label: 'Biceps',     unit: $lengthUnit || 'in' },
    { value: 'calves',     label: 'Calves',     unit: $lengthUnit || 'in' },
    { value: 'body_fat',   label: 'Body Fat',   unit: '%'  },
    { value: 'body_water', label: 'Body Water', unit: '%'  },
  ];
  // Metric identifier: nutriments use `.id`, everything else uses `.value`.
  // Coalesce so the ordering + hide stores work with a single string key.
  function _metricKey(m) { return m?.value ?? m?.id; }
  $: _rawMetrics = [
    ...NUTRIMENTS.filter(n => n.default),
    ...BODY_STATS.filter(s => !($hiddenBodyStats||[]).includes(s.value)),
    ...(_waterShowInStats ? [{ value: 'water', label: 'Water', unit: _waterUnit }] : []),
    ...WELLNESS_METRICS,
  ];
  // Apply the user's Statistics-specific hide list, then reorder by the
  // user's saved order. Metrics not in the order array append at the end
  // so a new metric introduced later still surfaces without config.
  $: METRICS = (() => {
    const hidden = new Set($statsHiddenMetrics || []);
    const visible = _rawMetrics.filter(m => !hidden.has(_metricKey(m)));
    const order = $statsMetricOrder || [];
    if (!order.length) return visible;
    const byKey = new Map(visible.map(m => [_metricKey(m), m]));
    const sorted = order.map(k => byKey.get(k)).filter(Boolean);
    const rest = visible.filter(m => !order.includes(_metricKey(m)));
    return [...sorted, ...rest];
  })();
  // If the user hides the currently-selected metric, snap to the first
  // still-visible one so the chart doesn't render against a missing key.
  $: if (METRICS.length && !METRICS.find(x => x.value === metric || x.id === metric)) {
    metric = _metricKey(METRICS[0]);
  }

  // Metrics where the Y-axis should auto-fit to the data range regardless of
  // the global "Lock Y-Axis To Zero" toggle. For body measurements and resting
  // physiological vitals (weight, HRV, RHR, etc.), 0 is not a biologically
  // meaningful baseline and forcing the chart to start there crushes the
  // visible data range into a thin band at the top of the canvas, making
  // day-to-day variation invisible (#67, reported by duplaja). Counted /
  // consumed metrics (calories, nutrients, water, steps, active minutes) keep
  // respecting the toggle since 0 is a real value for those.
  const PHYSIOLOGICAL_METRICS = new Set([
    'weight', 'neck', 'waist', 'hips', 'chest', 'thighs', 'biceps', 'calves',
    'body_fat', 'body_water',
    'wl_sleep', 'wl_rhr', 'wl_hrv', 'wl_spo2', 'wl_muscle',
  ]);
  function isPhysiologicalMetric(id) {
    return PHYSIOLOGICAL_METRICS.has(id);
  }

  const RANGES = [
    { value: '7',   label: '1W'  },
    { value: '14',  label: '2W'  },
    { value: '30',  label: '1M'  },
    { value: '90',  label: '3M'  },
    { value: '180', label: '6M'  },
    { value: '365', label: '1Y'  },
    { value: 'all', label: 'All' },
  ];

  async function loadData() {
    const ver = ++_loadVer;
    loading = true;
    const now = new Date();
    let dates = [];
    let fromStr = '', toStr = localDateStr();

    const isWellness   = metric.startsWith('wl_');
    // Withings + Health Connect both report weight + body fat; Withings is
    // the only device that reports body water % (Health Connect's
    // "Hydration" data type is drink intake, not body composition), so
    // body_water is device-sourced only when Withings is connected.
    const isBodyDevice =
      ((metric === 'weight' || metric === 'body_fat') && ($withingsEnabled || $fitbitFamilyEnabled)) ||
      (metric === 'body_water' && $withingsEnabled);

    if (range === 'all' && (isWellness || isBodyDevice)) {
      // Wellness data doesn't come from diary — use last 365 days
      const n = 365;
      for (let i = n - 1; i >= 0; i--) {
        const d = new Date(now); d.setDate(d.getDate() - i);
        dates.push(localDateStr(d));
      }
      fromStr = dates[0]; toStr = dates[dates.length - 1];
    } else if (range === 'all') {
      const all = await NtApi.getAllDiary();
      dates = [...new Set(all.map(e => e.date))].sort();
      fromStr = dates[0] || toStr;
    } else if (range === 'custom') {
      if (!customStart || !customEnd) { loading = false; return; }
      const start = new Date(customStart + 'T12:00:00');
      const end   = new Date(customEnd   + 'T12:00:00');
      if (start > end) { loading = false; return; }
      const d = new Date(start);
      while (d <= end) { dates.push(localDateStr(d)); d.setDate(d.getDate() + 1); }
      fromStr = customStart; toStr = customEnd;
    } else {
      const n = parseInt(range);
      for (let i = n - 1; i >= 0; i--) {
        const d = new Date(now); d.setDate(d.getDate() - i);
        dates.push(localDateStr(d));
      }
      fromStr = dates[0]; toStr = dates[dates.length - 1];
    }

    const isBodyStat    = BODY_STATS.some(s => s.value === metric);
    const isWater       = metric === 'water';

    let rows = [];

    if (isWellness) {
      // Load from wellness API
      const wlMeta = WELLNESS_METRICS.find(m => m.value === metric);
      if (!wlMeta || ver !== _loadVer) { loading = false; return; }

      if (wlMeta.apiSource === 'fitgarm') {
        let fitbitData = {}, garminData = {}, hcData = {};
        // The fitbit /data endpoint already merges source IN ('fitbit',
        // 'health_connect') server-side, and Google Health Web API rows are
        // tagged source='fitbit', so one call covers fitbit + google-health
        // + health-connect for all server-mode users (browser + Android).
        try { if ($fitbitFamilyEnabled)  fitbitData  = await NtApi.get(`/api/wellness/fitbit/data?from=${fromStr}&to=${toStr}`); } catch {}
        try { if ($garminEnabled)        garminData  = await NtApi.get(`/api/wellness/garmin/data?from=${fromStr}&to=${toStr}`); } catch {}
        // Android local-only mode (no server): fall back to the local
        // SQLite where on-device Health Connect data is stored directly.
        if ($healthConnectEnabled && isNative) {
          try {
            const { dbGetWellnessGrouped } = await import('../lib/db-native.js');
            hcData = await dbGetWellnessGrouped(fromStr, toStr, 'health_connect');
          } catch {}
        }
        rows = dates.map(d => {
          let raw = garminData[d]?.[wlMeta.apiField] ?? fitbitData[d]?.[wlMeta.apiField] ?? hcData[d]?.[wlMeta.apiField] ?? null;
          if (raw != null && metric === 'calories_out' && $energyUnit === 'kJ') raw = Nutrition.kcalToKj(raw);
          const val = raw != null && wlMeta.fmtVal ? wlMeta.fmtVal(raw) : raw;
          return { date: d, val };
        });
      } else if (wlMeta.apiSource === 'withings') {
        let withingsData = {}, fitbitData = {}, hcData = {};
        try { if ($withingsEnabled) withingsData = await NtApi.get(`/api/wellness/withings/data?from=${fromStr}&to=${toStr}`); } catch {}
        // The fitbit /data endpoint surfaces HC body-comp metrics too
        // (weight, body_fat, muscle_mass) since it returns source IN
        // ('fitbit', 'health_connect') for every metric_type.
        try { if ($fitbitFamilyEnabled) fitbitData = await NtApi.get(`/api/wellness/fitbit/data?from=${fromStr}&to=${toStr}`); } catch {}
        if ($healthConnectEnabled && isNative) {
          try {
            const { dbGetWellnessGrouped } = await import('../lib/db-native.js');
            hcData = await dbGetWellnessGrouped(fromStr, toStr, 'health_connect');
          } catch {}
        }
        rows = dates.map(d => {
          const raw = withingsData[d]?.[wlMeta.apiField]?.value
            ?? fitbitData[d]?.[wlMeta.apiField]
            ?? hcData[d]?.[wlMeta.apiField]
            ?? null;
          const val = raw != null && wlMeta.isWeight && $weightUnit === 'lb' ? raw * 2.20462 : raw;
          return { date: d, val };
        });
      }

    } else {
      // Load from diary; body comp metrics also check device data (Withings,
      // Google Health, Health Connect). The fitbit /data endpoint covers HC
      // and Google Health server-side; local SQLite covers Android offline.
      let withingsData = {}, fitbitBodyData = {}, hcBodyData = {};
      if (isBodyDevice) {
        try { if ($withingsEnabled) withingsData = await NtApi.get(`/api/wellness/withings/data?from=${fromStr}&to=${toStr}`); } catch {}
        try { if ($fitbitFamilyEnabled) fitbitBodyData = await NtApi.get(`/api/wellness/fitbit/data?from=${fromStr}&to=${toStr}`); } catch {}
        if ($healthConnectEnabled && isNative) {
          try {
            const { dbGetWellnessGrouped } = await import('../lib/db-native.js');
            hcBodyData = await dbGetWellnessGrouped(fromStr, toStr, 'health_connect');
          } catch {}
        }
      }

      if (ver !== _loadVer) { loading = false; return; }
      const allEntries = await NtApi.getAllDiary();
      const entryMap = Object.fromEntries(allEntries.map(e => [e.date, e]));

      for (const date of dates) {
        if (ver !== _loadVer) { loading = false; return; }
        let val = null;

        if (isBodyDevice) {
          // Device-first priority: Withings → server-merged fitbit/HC/GH
          // (covers browser + Android server-mode) → local HC SQLite
          // (Android local-only) → diary fallback.
          const apiField = metric === 'weight'     ? 'weight_kg'
                         : metric === 'body_water' ? 'body_water_pct'
                                                   : 'body_fat_pct';
          const raw = withingsData[date]?.[apiField]?.value
            ?? fitbitBodyData[date]?.[apiField]
            ?? hcBodyData[date]?.[apiField]
            ?? null;
          if (raw != null) {
            val = metric === 'weight' && $weightUnit === 'lb' ? raw * 2.20462 : raw;
          } else {
            const entry = entryMap[date];
            const bs = entry?.body_stats || entry?.bodyStats || {};
            val = readBodyStat(bs, metric, $weightUnit, $lengthUnit);
          }
        } else {
          const entry = entryMap[date];
          if (entry) {
            if (isWater) {
              const total = (entry.water || []).reduce((s, l) => s + (l.amount || 0), 0);
              val = total > 0 ? total : null;
            } else if (isBodyStat) {
              const bs = entry.body_stats || entry.bodyStats || {};
              val = readBodyStat(bs, metric, $weightUnit, $lengthUnit);
            } else {
              // Distinguish "no food logged" (val = null) from "food logged
              // but this nutrient is 0 or absent" (val = 0). The second
              // case happens two ways:
              //   - all items have nutrient = 0 → totals[metric] === 0
              //   - no item carries the nutrient field at all (common for
              //     niche nutrients like added_sugars on plain foods)
              //     → totals[metric] === undefined
              // Both should count as a 0-g day in the chart + summary; only
              // a truly empty diary row should drop out of the days-logged
              // tally. Was: totals[metric] || null (collapsed 0 to null).
              // (Issue #45, duplaja.)
              const items = entry.items || [];
              if (items.length > 0) {
                const totals = Nutrition.sum(items.map(i => Nutrition.calculate(i)));
                let raw = totals[metric] ?? 0;
                if (metric === 'calories' && $energyUnit === 'kJ') raw = Nutrition.kcalToKj(raw);
                val = Math.round(raw * 10) / 10;
              }
              // else: entry row exists (e.g. water-only day) but no food
              // → val stays null so the day doesn't count toward nutrient
              // stats. Water stats have their own separate path above.
            }
          }
        }
        rows.push({ date, val });
      }
    }

    if (ver !== _loadVer) return; // stale — don't commit

    // Drop today from cumulative-metric charts by default — until end of day,
    // today's value misrepresents the trend (a partial day looks like a dip).
    // Point-in-time metrics (sleep_score, weight, HRV, RHR, etc.) are left
    // alone — those are "what was measured", not "what accumulated".
    if (isCumulative(metric) && !$statsIncludeToday) {
      const todayStr = localDateStr();
      rows = rows.filter(d => d.date !== todayStr);
    }
    data = rows;

    // Compute summary. Number.isFinite keeps 0 (a logged day with 0g of
    // the nutrient) but excludes null (no diary entry for the date), so
    // days where the user avoided this nutrient still count toward the
    // average + days-logged tally. (Issue #45, duplaja.)
    const withData = data.filter(d => Number.isFinite(d.val));
    if (withData.length) {
      const vals = withData.map(d => d.val);
      summary = {
        avg:          Math.round(vals.reduce((a,b)=>a+b,0) / vals.length * 10) / 10,
        min:          Math.round(Math.min(...vals) * 10) / 10,
        max:          Math.round(Math.max(...vals) * 10) / 10,
        total:        Math.round(vals.reduce((a,b)=>a+b,0) * 10) / 10,
        daysWithData: withData.length,
      };
    } else {
      summary = null;
    }

    loading = false;
    renderChart();
  }

  function linearRegression(pts) {
    const n = pts.length;
    if (n < 2) return null;
    const sumX = pts.reduce((s,p) => s + p.x, 0);
    const sumY = pts.reduce((s,p) => s + p.y, 0);
    const sumXY = pts.reduce((s,p) => s + p.x * p.y, 0);
    const sumX2 = pts.reduce((s,p) => s + p.x * p.x, 0);
    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    const intercept = (sumY - slope * sumX) / n;
    return pts.map(p => Math.round((slope * p.x + intercept) * 10) / 10);
  }

  function renderChart() {
    if (!canvasEl) return;
    if (chart) { chart.destroy(); chart = null; }

    const isDark      = document.documentElement.getAttribute('data-theme') !== 'light';
    const gridColor   = isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.07)';
    const textColor   = isDark ? 'rgba(240,242,248,0.55)' : 'rgba(13,15,20,0.55)';
    const accentColor = isDark ? '#4FFFB0' : '#00C47A';

    const isBar = $statsChartType === 'bar';
    // statsShowEmptyDays controls whether dates without a logged value stay
    // on the chart. Default ON keeps gaps visible (an empty day next to a
    // logged one is honest, collapsing them out makes a sparse week look
    // full). Same rule for both chart types: bar charts hide / show the
    // bar slot, line charts hide / show the gap. Toggle lives both inline
    // on the Statistics page and in Settings → Statistics.
    const displayData = $statsShowEmptyDays
      ? data
      : data.filter(d => Number.isFinite(d.val));
    const labels = displayData.map(d => {
      const dt = new Date(d.date + 'T12:00:00');
      return dt.toLocaleDateString(undefined, { month:'short', day:'numeric' });
    });
    const values = displayData.map(d => d.val);
    const datasets = [{
      label: getMetricLabel(),
      data: values,
      borderColor: accentColor,
      backgroundColor: isBar
        ? (isDark ? 'rgba(79,255,176,0.7)' : 'rgba(0,196,122,0.7)')
        : (isDark ? 'rgba(79,255,176,0.08)' : 'rgba(0,196,122,0.08)'),
      borderWidth: isBar ? 0 : 2.5,
      pointBackgroundColor: accentColor,
      pointRadius: displayData.length > 60 ? 0 : (isBar ? 0 : 3),
      pointHoverRadius: isBar ? 0 : 5,
      tension: 0.35,
      fill: !isBar,
      spanGaps: true,
    }];

    // Average line — always type 'line' even in bar chart mode
    if ($statsAvgLine && summary) {
      datasets.push({
        type: 'line',
        label: 'Average',
        data: displayData.map(() => summary.avg),
        borderColor: isDark ? 'rgba(255,193,7,0.7)' : 'rgba(217,119,6,0.7)',
        borderWidth: 1.5,
        borderDash: [6, 4],
        pointRadius: 0,
        fill: false,
        spanGaps: true,
      });
    }

    // Goal value — computed up-front whether or not the Goal line itself is
    // visible, so the y-axis auto-fit below can extend bounds to include it
    // (so weight charts read as "progress toward goal" rather than scatter
    // around current data when the goal is outside the range). #67 follow-up.
    let _goalVal = null;
    {
      const g = $goals && $goals[metric];
      _goalVal = g ? (g.max ?? g.min ?? null) : null;
      if (_goalVal != null && g?.isPercent) {
        const density = {fat:9,'saturated-fat':9,carbohydrates:4,sugars:4,proteins:4}[metric];
        const calGoal = $goals.calories?.max ?? $goals.calories?.min ?? 2000;
        if (density) _goalVal = Math.round(calGoal * _goalVal / 100 / density);
      }
      if (_goalVal != null && metric === 'calories' && $energyUnit === 'kJ') _goalVal = Math.round(Nutrition.kcalToKj(_goalVal));
    }

    // Goal line — always type 'line' even in bar chart mode
    if ($statsGoalLine && _goalVal) {
      const isAdaptiveOrDynamic = metric === 'calories' && ($calorieGoalMode === 'dynamic' || $calorieGoalMode === 'adaptive');
      datasets.push({
        type: 'line',
        label: isAdaptiveOrDynamic ? 'Base Goal' : 'Goal',
        data: displayData.map(() => _goalVal),
        borderColor: isDark ? 'rgba(129,140,248,0.8)' : 'rgba(99,102,241,0.8)',
        borderWidth: 1.5,
        borderDash: [4, 4],
        pointRadius: 0,
        fill: false,
        spanGaps: true,
      });
    }

    // Trend line — always type 'line' even in bar chart mode
    if ($statsTrendLine) {
      const pts = values
        .map((v, i) => v !== null && v > 0 ? { x: i, y: v } : null)
        .filter(Boolean);
      if (pts.length >= 2) {
        const trendVals = linearRegression(pts);
        const trendData = values.map((v, i) => {
          const found = pts.findIndex(p => p.x === i);
          return found >= 0 ? trendVals[found] : null;
        });
        datasets.push({
          type: 'line',
          label: 'Trend',
          data: trendData,
          borderColor: isDark ? 'rgba(251,146,60,0.8)' : 'rgba(234,88,12,0.8)',
          borderWidth: 2,
          borderDash: [2, 3],
          pointRadius: 0,
          fill: false,
          spanGaps: true,
        });
      }
    }

    chart = new Chart(canvasEl, {
      type: isBar ? 'bar' : 'line',
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        // Chart click drill-through (#3). Labels array is display-format
        // (Aug 9) so we can't parse an ISO date back out of it —
        // displayData in the enclosing closure still carries .date, so
        // we index into that directly and hand it to _drillIntoDate,
        // which routes wellness metrics to /wellness and everything else
        // to /diary on that day.
        onClick: (_evt, activeEls) => {
          if (!activeEls?.length) return;
          const idx = activeEls[0].index;
          const row = displayData[idx];
          if (row?.date) _drillIntoDate(row.date);
        },
        onHover: (evt, activeEls) => {
          const t = evt?.native?.target;
          if (t && t.style) t.style.cursor = activeEls?.length ? 'pointer' : 'default';
        },
        plugins: {
          legend: { display: datasets.length > 1, labels: { color: textColor, boxHeight: 2, usePointStyle: true } },
          tooltip: {
            displayColors: datasets.length > 1,
            callbacks: {
              // Returning an empty string suppresses the per-dataset line
              // in the tooltip; needed when a series has gaps (skipped
              // days on body-stat metrics where the user didn't weigh in,
              // or hovering past the start of the user's data window).
              // Without the null guard, .toLocaleString() throws and the
              // entire tooltip freezes mid-paint (#66, reported by
              // duplaja). The other datasets in the same hover (Average,
              // Goal, Trend) still render normally.
              label: ctx => {
                const y = ctx.parsed?.y;
                if (y == null) return '';
                return `${ctx.dataset.label || ''}: ${y.toLocaleString()} ${getMetricUnit()}`.trim();
              }
            }
          }
        },
        scales: {
          x: {
            grid: { color: gridColor },
            ticks: { color: textColor, maxRotation: 0, maxTicksLimit: 8 }
          },
          y: {
            grid: { color: gridColor },
            ticks: { color: textColor, callback: v => v.toLocaleString() },
            // Force smart-range (auto-fit to data) for body stats + resting
            // vitals where 0 isn't a meaningful baseline; respect the global
            // toggle for nutrients + counted metrics where 0 is valid. See
            // PHYSIOLOGICAL_METRICS above for the full list (#67).
            beginAtZero: $statsYZero && !isPhysiologicalMetric(metric),
            // On physiological metrics, extend the auto-fit range to include
            // the goal value when one is set, so progress toward goal stays
            // visible even when the goal is outside the actual data range
            // (#67 follow-up, requested by duplaja). suggestedMin/Max only
            // extend bounds, never shrink, so this is safe when data already
            // brackets the goal.
            ...(isPhysiologicalMetric(metric) && _goalVal != null ? {
              suggestedMin: _goalVal,
              suggestedMax: _goalVal,
            } : {}),
          }
        }
      }
    });
  }

  function getMetricLabel() {
    // NUTRIMENTS items expose `id` while body-stats / wellness items expose
    // `value` — match either. Without this, nutrient labels fell through to
    // the raw lowercase metric ID (e.g. "calories" instead of "Calories")
    // in the chart legend and tooltips.
    const m = METRICS.find(x => x.value === metric || x.id === metric);
    return m ? m.label : metric;
  }

  function getMetricUnit() {
    if (metric === 'water') return _waterUnit;
    if (metric === 'calories') return $energyUnit || 'kcal';
    const wl = WELLNESS_METRICS.find(x => x.value === metric);
    if (wl) {
      if (wl.isWeight) return $weightUnit === 'lb' ? 'lbs' : 'kg';
      if (metric === 'calories_out') return $energyUnit || 'kcal';
      return wl.unit;
    }
    const m = [...NUTRIMENTS, ...BODY_STATS].find(x => x.value === metric || x.id === metric);
    return m ? (m.unit || '') : '';
  }

  // Compute metric unit reactively (not via function call — avoids stale reads)
  $: _metricUnit = (() => {
    if (metric === 'water') return _waterUnit;
    if (metric === 'calories') return $energyUnit || 'kcal';
    const wl = WELLNESS_METRICS.find(x => x.value === metric);
    if (wl) {
      if (wl.isWeight) return $weightUnit === 'lb' ? 'lbs' : 'kg';
      if (metric === 'calories_out') return $energyUnit || 'kcal';
      return wl.unit;
    }
    const m = [...NUTRIMENTS, ...BODY_STATS].find(x => x.value === metric || x.id === metric);
    return m ? (m.unit || '') : '';
  })();

  // Desktop rail — partition the (already filtered + ordered) METRICS
  // array into semantic groups so the left rail can render category
  // headings instead of one flat pill scroller. Membership inferred from
  // source-array shape: NUTRIMENTS items carry `.id` (no `.value`), body
  // stats use `.value` present in BODY_STATS, water is the literal
  // 'water' key, wellness values are prefixed `wl_`.
  $: groupedMetrics = (() => {
    const bodyValues = new Set(BODY_STATS.map(s => s.value));
    const buckets = { nutrient: [], body: [], water: [], wellness: [] };
    for (const m of METRICS) {
      const key = _metricKey(m);
      let bucket;
      if (typeof key === 'string' && key.startsWith('wl_')) bucket = 'wellness';
      else if (key === 'water') bucket = 'water';
      else if (bodyValues.has(key)) bucket = 'body';
      else bucket = 'nutrient';
      buckets[bucket].push({ ...m, _key: key });
    }
    const groups = [];
    if (buckets.nutrient.length) groups.push({ label: 'Nutrition', metrics: buckets.nutrient });
    if (buckets.body.length)     groups.push({ label: 'Body',      metrics: buckets.body });
    if (buckets.water.length)    groups.push({ label: 'Water',     metrics: buckets.water });
    if (buckets.wellness.length) groups.push({ label: 'Wellness',  metrics: buckets.wellness });
    return groups;
  })();

  // Goal value + delta for the right-rail KPI stack. Mirrors the goal
  // computation inside renderChart() (lines ~436-446); kept reactive here
  // so the "vs goal" chip stays in sync with metric / energyUnit changes
  // without re-running the chart pipeline.
  $: _goalValReactive = (() => {
    const g = $goals && $goals[metric];
    let gv = g ? (g.max ?? g.min ?? null) : null;
    if (gv != null && g?.isPercent) {
      const density = {fat:9,'saturated-fat':9,carbohydrates:4,sugars:4,proteins:4}[metric];
      const calGoal = $goals.calories?.max ?? $goals.calories?.min ?? 2000;
      if (density) gv = Math.round(calGoal * gv / 100 / density);
    }
    if (gv != null && metric === 'calories' && $energyUnit === 'kJ') gv = Math.round(Nutrition.kcalToKj(gv));
    return gv;
  })();
  $: _goalIsMin = (() => {
    const g = $goals && $goals[metric];
    return !!(g && g.min != null && g.max == null);
  })();
  $: _goalDelta = (summary?.avg != null && _goalValReactive) ? Math.round((summary.avg - _goalValReactive) / _goalValReactive * 100) : null;

  // Group the timeline by month once the visible span crosses 60 days
  // — a flat list of 100+ rows scrolls forever. #4. Most-recent month
  // auto-expands on data change so the user still sees rows without a
  // click; older months collapse to header-only entries.
  $: _rangeIsLong = data.length > 60;
  $: _timelineMonths = (() => {
    if (!_rangeIsLong) return [];
    const map = new Map();
    for (const row of data) {
      if (!Number.isFinite(row.val)) continue;
      const key = row.date.slice(0, 7); // YYYY-MM
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(row);
    }
    const arr = [...map.entries()].map(([key, entries]) => {
      const dt = new Date(key + '-01T12:00:00');
      const label = dt.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
      return { key, label, count: entries.length, entries: entries.slice().reverse() };
    });
    arr.sort((a, b) => b.key.localeCompare(a.key));
    return arr;
  })();
  // Seed most-recent expanded when the month list changes and the
  // current expanded set no longer intersects (e.g. metric switched,
  // range moved, first load). Assigning a new Set triggers Svelte
  // reactivity — mutating in-place would not.
  $: if (_timelineMonths.length) {
    const stale = ![..._timelineExpandedMonths].some(k => _timelineMonths.find(m => m.key === k));
    if (stale) _timelineExpandedMonths = new Set([_timelineMonths[0].key]);
  }
  function _toggleMonth(key) {
    const s = new Set(_timelineExpandedMonths);
    if (s.has(key)) s.delete(key); else s.add(key);
    _timelineExpandedMonths = s;
  }

  // 7-vs-previous-7-day trend delta (#6). Hidden when the range holds
  // fewer than 14 logged days — otherwise the comparison is meaningless
  // (e.g. 3-day range shows a 100% "trend" off noise). Direction goodness
  // reuses the goal-direction convention: if the goal is a floor, up is
  // good; else lower is good; no goal → neutral.
  $: _trendDelta = (() => {
    if (data.length < 14) return null;
    const withVal = data.filter(d => Number.isFinite(d.val));
    if (withVal.length < 14) return null;
    const last7 = withVal.slice(-7);
    const prev7 = withVal.slice(-14, -7);
    if (!last7.length || !prev7.length) return null;
    const avg = arr => arr.reduce((s, r) => s + r.val, 0) / arr.length;
    const a = avg(last7), b = avg(prev7);
    if (b === 0) return null;
    return Math.round((a - b) / Math.abs(b) * 100);
  })();

  // Empty-state alternatives (#7). Best-guess list — we can't verify
  // "has data" without loading each series (a full extra pipeline pass
  // per metric). Keeping it to metrics the user has enabled makes the
  // suggestion honest for the vast majority of setups.
  $: _emptyAlternatives = (() => {
    if (data.length > 0) return [];
    const cands = ['calories', 'weight', 'wl_steps'];
    return cands
      .filter(c => c !== metric)
      .filter(c => METRICS.find(m => (m.value ?? m.id) === c))
      .slice(0, 3);
  })();
  function _altLabel(key) {
    const m = METRICS.find(x => (x.value ?? x.id) === key);
    return m ? m.label : key;
  }

  // CSV export (#8). Uses the same rows Chart.js is looking at, not
  // the raw pre-filter set, so what the user sees is what they get.
  function _exportCsv() {
    if (!data.length) return;
    const lines = ['Date,Value'];
    for (const row of data) {
      if (Number.isFinite(row.val)) lines.push(`${row.date},${row.val}`);
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${metric}-${range}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  // Deep-link support (#: ?metric=X&range=Y). Wellness/Diary/Goals
  // linking to Statistics for a specific metric+range lands here; if the
  // metric isn't currently visible the existing METRICS-snap reactive
  // (line ~120) resets it to the first visible metric on the next tick,
  // so an unknown key silently no-ops rather than throwing.
  onMount(() => {
    try {
      const hash = window.location.hash || '';
      const qi = hash.indexOf('?');
      if (qi < 0) return;
      const params = new URLSearchParams(hash.slice(qi + 1));
      const mp = params.get('metric');
      const rp = params.get('range');
      if (mp) metric = mp;
      if (rp && RANGES.some(r => r.value === rp)) range = rp;
    } catch {}
  });

  $: { metric; range; customStart; customEnd; $statsIncludeToday; $statsShowEmptyDays; $statsChartType; $statsYZero; $statsAvgLine; $statsGoalLine; $statsTrendLine;
       if (canvasEl) loadData(); }

  onDestroy(() => { if (chart) chart.destroy(); });

  // ── Custom range calendar ──────────────────────────────────────────────────
  let showCalFor   = null; // 'start' | 'end' | null
  let calYear      = new Date().getFullYear();
  let calMonth     = new Date().getMonth();
  let showYearPicker  = false;
  let showMonthPicker = false;

  $: calFirstDay    = new Date(calYear, calMonth, 1).getDay();
  $: calDaysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
  $: calMonthName   = new Date(calYear, calMonth, 1).toLocaleDateString(undefined, { month: 'long' });
  const _yearRange  = Array.from({ length: 22 }, (_, i) => new Date().getFullYear() - 10 + i);
  const _monthNames = [
    {idx:0,s:'Jan'},{idx:1,s:'Feb'},{idx:2,s:'Mar'},{idx:3,s:'Apr'},
    {idx:4,s:'May'},{idx:5,s:'Jun'},{idx:6,s:'Jul'},{idx:7,s:'Aug'},
    {idx:8,s:'Sep'},{idx:9,s:'Oct'},{idx:10,s:'Nov'},{idx:11,s:'Dec'},
  ];

  function _todayStr() { return localDateStr(); }

  // Tap-to-drill-into-day from History (#64). The current metric drives
  // the destination route — wellness metrics open the Wellness page on
  // that day, everything else (nutrients, water, body stats) opens the
  // Diary. Pairs with the Diary nutrient drill-down (#58) so a user can
  // see a Statistics spike, tap into that day, and inspect contributors
  // without juggling the calendar picker.
  //
  // Diary uses the currentDate store. Wellness owns its date as a local
  // var (no store), so the cross-route hand-off goes via sessionStorage
  // — same pattern Diary uses for nt:replaceItem to pass state through
  // a navigation. Wellness reads + clears the key on mount.
  function _drillIntoDate(date) {
    if (!date) return;
    if (metric.startsWith('wl_')) {
      sessionStorage.setItem('nt:wellnessTargetDate', date);
      push('/wellness');
    } else {
      currentDate.set(date);
      push('/');
    }
  }

  function fmtDate(iso) {
    if (!iso) return 'Pick date';
    return new Date(iso + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }
  function openCal(which) {
    showCalFor = which; showYearPicker = false; showMonthPicker = false;
    const d = which === 'start' ? customStart : customEnd;
    const dt = d ? new Date(d + 'T12:00:00') : new Date();
    calYear = dt.getFullYear(); calMonth = dt.getMonth();
  }
  function calPrevMonth() {
    showYearPicker = false; showMonthPicker = false;
    if (calMonth === 0) { calMonth = 11; calYear--; } else calMonth--;
  }
  function calNextMonth() {
    showYearPicker = false; showMonthPicker = false;
    if (calMonth === 11) { calMonth = 0; calYear++; } else calMonth++;
  }
  function isDayDisabled(ds) {
    if (showCalFor === 'start' && customEnd && ds > customEnd) return true;
    if (showCalFor === 'end'   && customStart && ds < customStart) return true;
    if (showCalFor === 'end'   && ds > _todayStr()) return true;
    return false;
  }
  function selectDay(ds) {
    if (isDayDisabled(ds)) return;
    if (showCalFor === 'start') customStart = ds;
    else customEnd = ds;
    showCalFor = null;
  }
</script>

<div class="page-shell">
  <header class="page-header" class:banner-gradient={$bannerStyle === 'gradient'} class:banner-animated={$bannerStyle === 'animated'}>
    <h1>{$_('routes.statistics.title')}</h1>
  </header>

  <div class="stats-body">
  <!-- Desktop left rail: grouped metric picker. Hidden on mobile; the
       horizontal metric-scroll below still owns metric selection there. -->
  <aside class="stats-left-rail">
    <div class="stats-rail-heading">Metrics</div>
    <input class="stats-rail-search" type="search" placeholder="Filter metrics…" bind:value={_railQuery} />
    {#each groupedMetrics as g}
      {@const _filtered = g.metrics.filter(m => !_railQuery || m.label.toLowerCase().includes(_railQuery.toLowerCase()))}
      {#if _filtered.length}
        <p class="stats-rail-group">{g.label}</p>
        {#each _filtered as m}
          <button class="stats-rail-metric" class:active={metric === m._key}
            on:click={() => metric = m._key}>
            {m.label}
          </button>
        {/each}
      {/if}
    {/each}
  </aside>
  <div class="stats-content stats-main">
    <!-- Metric selector (scrollable) -->
    <div class="metric-scroll" use:dragScroll>
      {#each METRICS as m}
        <button class="pill-btn" class:active={metric === (m.id || m.value)}
          on:click={() => metric = m.id || m.value}>
          {m.label}
        </button>
      {/each}
    </div>

    <!-- Range + chart-type row -->
    <div class="ctrl-row">
      <div class="range-pills" use:dragScroll>
        {#each RANGES as r}
          <button class="range-btn" class:active={range === r.value} on:click={() => range = r.value}>
            {r.label}
          </button>
        {/each}
        <button class="range-btn" class:active={range === 'custom'} on:click={() => range = 'custom'}>
          Custom
        </button>
      </div>
      <button class="chart-type-btn" title="Toggle chart type"
        on:click={() => statsChartType.set($statsChartType === 'bar' ? 'line' : 'bar')}>
        <span class="material-symbols-rounded" style="font-size:18px">
          {$statsChartType === 'bar' ? 'show_chart' : 'bar_chart'}
        </span>
      </button>
    </div>

    {#if range === 'custom'}
      <div transition:slide={{ duration: 160 }}>
        <!-- Quick-select shortcuts — saves drilling into the calendar -->
        <div class="custom-range-quick">
          <button class="quick-chip" on:click={() => { const t = localDateStr(); const d = new Date(); d.setDate(d.getDate() - 6); customStart = localDateStr(d); customEnd = t; showCalFor = null; }}>{$_('statistics_page.range.last_7d')}</button>
          <button class="quick-chip" on:click={() => { const t = localDateStr(); const d = new Date(); d.setDate(d.getDate() - 29); customStart = localDateStr(d); customEnd = t; showCalFor = null; }}>{$_('statistics_page.range.last_30d')}</button>
          <button class="quick-chip" on:click={() => { const t = localDateStr(); const d = new Date(); d.setDate(d.getDate() - 89); customStart = localDateStr(d); customEnd = t; showCalFor = null; }}>{$_('statistics_page.range.last_90d')}</button>
          <button class="quick-chip" on:click={() => { const t = new Date(); customStart = `${t.getFullYear()}-${String(t.getMonth()+1).padStart(2,'0')}-01`; customEnd = localDateStr(); showCalFor = null; }}>{$_('statistics_page.range.this_month')}</button>
          <button class="quick-chip" on:click={() => { const t = new Date(); t.setMonth(t.getMonth() - 1); const start = `${t.getFullYear()}-${String(t.getMonth()+1).padStart(2,'0')}-01`; const end = new Date(t.getFullYear(), t.getMonth() + 1, 0); customStart = start; customEnd = localDateStr(end); showCalFor = null; }}>{$_('statistics_page.range.last_month')}</button>
          <button class="quick-chip" on:click={() => { const y = new Date().getFullYear(); customStart = `${y}-01-01`; customEnd = localDateStr(); showCalFor = null; }}>{$_('statistics_page.range.ytd')}</button>
        </div>
        <div class="custom-range-row">
          <button class="date-range-btn" class:active={showCalFor === 'start'} on:click={() => openCal('start')}>
            <span class="material-symbols-rounded drb-icon">calendar_today</span>
            <div class="drb-text">
              <span class="drb-label">{$_('statistics_page.range.from')}</span>
              <span class="drb-val">{fmtDate(customStart)}</span>
            </div>
          </button>
          <span class="drb-arrow">→</span>
          <button class="date-range-btn" class:active={showCalFor === 'end'} on:click={() => openCal('end')}>
            <span class="material-symbols-rounded drb-icon">calendar_today</span>
            <div class="drb-text">
              <span class="drb-label">{$_('statistics_page.range.to')}</span>
              <span class="drb-val">{fmtDate(customEnd)}</span>
            </div>
          </button>
        </div>
      </div>
    {/if}

    <!-- Summary stats (above chart) — mobile owns this; desktop shows the
         same numbers in the right rail (.stats-rail-only) instead. -->
    {#if summary}
      <div class="stats-center-only">
      <div class="summary-card card">
        <div class="summary-grid">
          <div class="summary-item">
            <span class="summary-val">{summary.avg.toLocaleString()}</span>
            <span class="summary-unit">{_metricUnit}</span>
            <span class="summary-lbl">{$_('statistics_page.summary.average')}</span>
          </div>
          <div class="summary-item">
            <span class="summary-val">{summary.min.toLocaleString()}</span>
            <span class="summary-unit">{_metricUnit}</span>
            <span class="summary-lbl">{$_('statistics_page.summary.min')}</span>
          </div>
          <div class="summary-item">
            <span class="summary-val">{summary.max.toLocaleString()}</span>
            <span class="summary-unit">{_metricUnit}</span>
            <span class="summary-lbl">{$_('statistics_page.summary.max')}</span>
          </div>
          <div class="summary-item">
            <span class="summary-val">{summary.daysWithData.toLocaleString()}</span>
            <span class="summary-unit">{$_('statistics_page.summary.days_unit')}</span>
            <span class="summary-lbl">{$_('statistics_page.summary.logged')}</span>
          </div>
        </div>
      </div>
      </div>
    {/if}

    <!-- Chart -->
    <div class="chart-card card">
      {#if data.length > 0}
        <!-- CSV export lives on the chart itself so mobile and large-screen
             both get it. Was previously desktop-rail-only. -->
        <button class="chart-csv" type="button" on:click={_exportCsv}
          title="Export CSV" aria-label="Export CSV">
          <span class="material-symbols-rounded">download</span>
        </button>
      {/if}
      {#if loading}
        <div class="chart-loading">
          <span class="material-symbols-rounded spin">refresh</span>
        </div>
      {:else if data.length === 0}
        <div class="chart-loading" style="background:transparent">
          <div style="text-align:center;opacity:0.45;padding:8px 24px">
            <span class="material-symbols-rounded" style="font-size:36px">show_chart</span>
            <div class="text-2 text-sm" style="margin-top:6px;font-weight:600">{$_('statistics_page.empty.no_data')}</div>
            <div class="text-3 text-sm" style="margin-top:4px;line-height:1.45">
              {#if metric === 'calories' || metric === 'proteins' || metric === 'carbohydrates' || metric === 'fat'}
                {$_('statistics_page.empty.hint_food_metric')}
              {:else if metric.startsWith('wl_')}
                {$_('statistics_page.empty.hint_wellness')}
              {:else}
                {$_('statistics_page.empty.hint_other')}
              {/if}
            </div>
            {#if _emptyAlternatives.length}
              <!-- #7 Nudge toward metrics likely to have data instead of
                   leaving the user staring at an empty chart. Click swaps
                   the current metric — the loader re-runs via the metric
                   reactive at line ~647. -->
              <div class="stats-empty-alts text-3 text-sm">
                Try
                {#each _emptyAlternatives as alt, i}
                  <button class="stats-empty-alt-link" type="button" on:click={() => metric = alt}>{_altLabel(alt)}</button>{#if i < _emptyAlternatives.length - 2}, {:else if i === _emptyAlternatives.length - 2} or {/if}
                {/each}
                . You may have data there.
              </div>
            {/if}
          </div>
        </div>
      {/if}
      <div class="chart-wrap">
        <canvas bind:this={canvasEl}></canvas>
      </div>
    </div>

    <!-- Timeline list -->
    {#if data.length > 0}
      <div class="timeline-section">
        <div class="section-title">{$_('statistics_page.history_heading')}</div>
        <div class="timeline-list card">
          {#if _rangeIsLong}
            <!-- #4 Long-range view: month headers with collapsible bodies.
                 Most-recent month auto-expanded; older months click to open.
                 Falls back to the flat list for ≤60-day ranges (else branch). -->
            {#each _timelineMonths as m (m.key)}
              <button class="stats-tl-month" type="button"
                on:click={() => _toggleMonth(m.key)}
                aria-expanded={_timelineExpandedMonths.has(m.key)}>
                <span class="stats-tl-month-label">{m.label}</span>
                <span class="stats-tl-month-count">{m.count}</span>
                <span class="material-symbols-rounded stats-tl-chevron" class:open={_timelineExpandedMonths.has(m.key)}>expand_more</span>
              </button>
              {#if _timelineExpandedMonths.has(m.key)}
                {#each m.entries as row}
                  <div class="timeline-row">
                    <button class="timeline-date-link" type="button"
                      on:click={() => _drillIntoDate(row.date)}
                      title={metric.startsWith('wl_') ? 'Open this day in Wellness' : 'Open this day in Diary'}
                      aria-label={metric.startsWith('wl_') ? `Open Wellness for ${row.date}` : `Open Diary for ${row.date}`}>
                      {(() => {
                        const dt = new Date(row.date + 'T12:00:00');
                        const fmt = $dateFormat || 'ISO';
                        if (fmt === 'US') { const mm=String(dt.getMonth()+1).padStart(2,'0'),dd=String(dt.getDate()).padStart(2,'0'); return mm+'/'+dd+'/'+dt.getFullYear(); }
                        if (fmt === 'EU') { const mm=String(dt.getMonth()+1).padStart(2,'0'),dd=String(dt.getDate()).padStart(2,'0'); return dd+'/'+mm+'/'+dt.getFullYear(); }
                        if (fmt === 'natural') return dt.toLocaleDateString(undefined,{day:'numeric',month:'short',year:'numeric'});
                        return row.date;
                      })()}
                    </button>
                    <span class="timeline-val accent-text">{row.val.toLocaleString()} {_metricUnit}</span>
                  </div>
                {/each}
              {/if}
            {/each}
          {:else}
            {#each [...data].reverse() as row}
              {#if Number.isFinite(row.val)}
                <div class="timeline-row">
                  <button class="timeline-date-link" type="button"
                    on:click={() => _drillIntoDate(row.date)}
                    title={metric.startsWith('wl_') ? 'Open this day in Wellness' : 'Open this day in Diary'}
                    aria-label={metric.startsWith('wl_') ? `Open Wellness for ${row.date}` : `Open Diary for ${row.date}`}>
                    {(() => {
                      const dt = new Date(row.date + 'T12:00:00');
                      const fmt = $dateFormat || 'ISO';
                      if (fmt === 'US') { const m=String(dt.getMonth()+1).padStart(2,'0'),d=String(dt.getDate()).padStart(2,'0'); return m+'/'+d+'/'+dt.getFullYear(); }
                      if (fmt === 'EU') { const m=String(dt.getMonth()+1).padStart(2,'0'),d=String(dt.getDate()).padStart(2,'0'); return d+'/'+m+'/'+dt.getFullYear(); }
                      if (fmt === 'natural') return dt.toLocaleDateString(undefined,{day:'numeric',month:'short',year:'numeric'});
                      return row.date;
                    })()}
                  </button>
                  <span class="timeline-val accent-text">{row.val.toLocaleString()} {_metricUnit}</span>
                </div>
              {/if}
            {/each}
          {/if}
        </div>
      </div>
    {/if}

    {#if $fastingEnabled}
      <FastingInsights />
    {/if}

    <div style="height:16px"></div>
  </div>
  <!-- Desktop right rail: KPI stack + overlay toggles. Hidden on mobile. -->
  <aside class="stats-right-rail">
    <div class="stats-rail-heading">Summary</div>
    {#if summary}
      <div class="stats-rail-kpi">
        <span class="stats-rail-kpi-lbl">{$_('statistics_page.summary.average')}</span>
        <span class="stats-rail-kpi-val">
          {summary.avg.toLocaleString()}
          <span class="stats-rail-kpi-unit">{_metricUnit}</span>
          {#if _goalDelta != null}
            {@const good = _goalIsMin ? _goalDelta >= 0 : _goalDelta <= 0}
            <span class="stats-rail-delta" class:good class:bad={!good}>
              {_goalDelta > 0 ? '+' : ''}{_goalDelta}%
            </span>
          {/if}
        </span>
      </div>
      <div class="stats-rail-kpi">
        <span class="stats-rail-kpi-lbl">{$_('statistics_page.summary.min')}</span>
        <span class="stats-rail-kpi-val">{summary.min.toLocaleString()} <span class="stats-rail-kpi-unit">{_metricUnit}</span></span>
      </div>
      <div class="stats-rail-kpi">
        <span class="stats-rail-kpi-lbl">{$_('statistics_page.summary.max')}</span>
        <span class="stats-rail-kpi-val">{summary.max.toLocaleString()} <span class="stats-rail-kpi-unit">{_metricUnit}</span></span>
      </div>
      <div class="stats-rail-kpi">
        <span class="stats-rail-kpi-lbl">{$_('statistics_page.summary.logged')}</span>
        <span class="stats-rail-kpi-val">{summary.daysWithData.toLocaleString()} <span class="stats-rail-kpi-unit">{$_('statistics_page.summary.days_unit')}</span></span>
      </div>
      {#if _trendDelta != null}
        <!-- #6 7-vs-previous-7-day trend. Hidden for <14-day ranges.
             Direction goodness mirrors _goalDelta's convention: floor
             goals (goal.min only) → up is good; else lower is good. -->
        {@const _tGood = _goalValReactive == null ? null : (_goalIsMin ? _trendDelta >= 0 : _trendDelta <= 0)}
        <div class="stats-rail-kpi">
          <span class="stats-rail-kpi-lbl" title="Last 7-day average vs the previous 7 days. Deep trend analysis lives on the chart itself — this is the quick pulse.">Weekly trend</span>
          <span class="stats-rail-kpi-val">
            <span class="stats-rail-delta"
              class:good={_tGood === true}
              class:bad={_tGood === false}
              class:neutral={_tGood === null}>
              {_trendDelta > 0 ? '↑' : _trendDelta < 0 ? '↓' : '·'} {Math.abs(_trendDelta)}%
            </span>
          </span>
        </div>
      {/if}
    {:else}
      <p class="stats-rail-empty text-3 text-sm">{$_('statistics_page.empty.no_data')}</p>
    {/if}

    <div class="stats-rail-heading" style="margin-top:16px">Overlays</div>
    <label class="stats-rail-check">
      <input type="checkbox" checked={$statsAvgLine}
        on:change={(e) => statsAvgLine.set(e.currentTarget.checked)} />
      <span>Average</span>
    </label>
    <label class="stats-rail-check">
      <input type="checkbox" checked={$statsGoalLine}
        on:change={(e) => statsGoalLine.set(e.currentTarget.checked)} />
      <span>Goal</span>
    </label>
    <label class="stats-rail-check">
      <input type="checkbox" checked={$statsTrendLine}
        on:change={(e) => statsTrendLine.set(e.currentTarget.checked)} />
      <span>Trend</span>
    </label>
    <!-- TODO: compare mode (#5) — needs loader refactor to accept a
         metric argument (loadSeries(metricId) → { labels, values }).
         The current loadData() closes over the module-level `metric`
         var across ~200 lines of wellness/body/nutrient branches;
         extracting it cleanly is a bigger diff than this pass allows,
         so the compare select is deferred. -->
  </aside>
  </div>
</div>

<!-- Custom range calendar sheet -->
{#if showCalFor}
  <div use:portal class="stat-backdrop" role="dialog" aria-modal="true"
    on:click={() => showCalFor = null} on:keydown={() => {}}>
    <div class="stat-cal-sheet" on:click|stopPropagation on:keydown={() => {}}>
      <div class="sheet-handle"></div>
      <div class="cal-title">{showCalFor === 'start' ? 'From' : 'To'} date</div>
      <!-- Month / year nav -->
      <div class="dp-nav">
        <button class="btn-icon dp-nav-btn" on:click={calPrevMonth} aria-label="Previous month" title="Previous month">
          <span class="material-symbols-rounded">chevron_left</span>
        </button>
        <div class="dp-month-year">
          <button class="dp-month-btn" on:click={() => { showMonthPicker = !showMonthPicker; showYearPicker = false; }}>
            {calMonthName}<span class="material-symbols-rounded" style="font-size:14px;vertical-align:middle;margin-left:2px">{showMonthPicker ? 'expand_less' : 'expand_more'}</span>
          </button>
          <button class="dp-year-btn" on:click={() => { showYearPicker = !showYearPicker; showMonthPicker = false; }}>
            {calYear}<span class="material-symbols-rounded" style="font-size:14px;vertical-align:middle;margin-left:2px">{showYearPicker ? 'expand_less' : 'expand_more'}</span>
          </button>
        </div>
        <button class="btn-icon dp-nav-btn" on:click={calNextMonth} aria-label="Next month" title="Next month">
          <span class="material-symbols-rounded">chevron_right</span>
        </button>
      </div>
      {#if showYearPicker}
        <div class="dp-year-grid">
          {#each _yearRange as yr}
            <button class="dp-yr-btn" class:dp-yr-sel={yr === calYear}
              on:click={() => { calYear = yr; showYearPicker = false; }}>{yr}</button>
          {/each}
        </div>
      {:else if showMonthPicker}
        <div class="dp-month-grid">
          {#each _monthNames as m}
            <button class="dp-mo-btn" class:dp-mo-sel={m.idx === calMonth}
              on:click={() => { calMonth = m.idx; showMonthPicker = false; }}>{m.s}</button>
          {/each}
        </div>
      {:else}
        <div class="dp-grid">
          {#each ['Su','Mo','Tu','We','Th','Fr','Sa'] as dh}
            <div class="dp-dh">{dh}</div>
          {/each}
          {#each {length: calFirstDay} as _}<div></div>{/each}
          {#each {length: calDaysInMonth} as _, di}
            {@const day = di + 1}
            {@const ds = calYear + '-' + String(calMonth+1).padStart(2,'0') + '-' + String(day).padStart(2,'0')}
            {@const disabled = isDayDisabled(ds)}
            {@const isSelected = ds === (showCalFor === 'start' ? customStart : customEnd)}
            <button class="dp-day"
              class:dp-today={ds === _todayStr()}
              class:dp-sel={isSelected}
              disabled={disabled}
              on:click={() => selectDay(ds)}>
              {day}
            </button>
          {/each}
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>

  .stats-content {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 12px var(--page-px) 0;
  }

  .metric-scroll {
    display: flex;
    gap: 8px;
    overflow-x: auto;
    padding-bottom: 4px;
    scrollbar-width: none;
  }
  .metric-scroll::-webkit-scrollbar { display: none; }

  .ctrl-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .range-pills {
    display: flex;
    gap: 6px;
    overflow-x: auto;
    flex: 1;
    scrollbar-width: none;
  }
  .range-pills::-webkit-scrollbar { display: none; }

  .pill-btn, .range-btn {
    flex-shrink: 0;
    padding: 6px 13px;
    border-radius: var(--radius-full);
    font-size: 12px; font-weight: 600;
    background: var(--surface-2);
    border: 1px solid var(--border);
    color: var(--text-2);
    cursor: pointer;
    transition: all var(--dur-fast);
    white-space: nowrap;
  }
  .pill-btn.active, .range-btn.active {
    background: var(--accent-dim);
    color: var(--accent);
    border-color: transparent;
  }

  .chart-type-btn {
    flex-shrink: 0;
    width: 36px; height: 36px;
    border-radius: var(--radius-md);
    background: var(--surface-2);
    border: 1px solid var(--border);
    display: flex; align-items: center; justify-content: center;
    cursor: pointer;
    color: var(--text-2);
    transition: all var(--dur-fast);
  }
  .chart-type-btn:hover { background: var(--surface-3); color: var(--accent); }

  /* Custom range date buttons */
  .custom-range-quick {
    display: flex; flex-wrap: wrap; gap: 6px;
    margin: 8px 0;
  }
  .quick-chip {
    padding: 6px 12px; border-radius: var(--radius-full);
    background: var(--surface-2); border: 1px solid var(--border);
    color: var(--text-2); font-size: 12px; font-weight: 500;
    cursor: pointer; transition: background var(--dur-fast), color var(--dur-fast);
  }
  .quick-chip:hover { background: var(--surface-3); color: var(--text-1); }
  .custom-range-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .date-range-btn {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 12px;
    background: var(--surface-2);
    border: 1.5px solid var(--border);
    border-radius: var(--radius-md);
    cursor: pointer;
    text-align: left;
    transition: border-color var(--dur-fast), background var(--dur-fast);
    min-width: 0;
  }
  .date-range-btn.active, .date-range-btn:hover {
    border-color: var(--accent);
    background: var(--accent-dim);
  }
  .drb-icon { font-size: 18px; color: var(--accent); flex-shrink: 0; }
  .drb-text  { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
  .drb-label { font-size: 10px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-3); }
  .drb-val   { font-size: 13px; font-weight: 600; color: var(--text-1); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .drb-arrow { color: var(--text-3); font-size: 16px; flex-shrink: 0; }

  /* Calendar sheet */
  .stat-backdrop {
    position: fixed; inset: 0; z-index: 200;
    background: rgba(0,0,0,0.5);
    display: flex; align-items: flex-end;
  }
  .stat-cal-sheet {
    background: var(--surface-1);
    border-radius: var(--radius-xl) var(--radius-xl) 0 0;
    width: 100%; max-width: 480px; margin: 0 auto;
    padding-bottom: var(--safe-bottom);
  }
  .sheet-handle { width: 36px; height: 4px; background: var(--border); border-radius: 2px; margin: 10px auto 0; }
  .cal-title { font-size: 15px; font-weight: 700; color: var(--text-1); padding: 12px 16px 0; }
  .dp-nav { display: flex; align-items: center; justify-content: space-between; padding: 10px 8px 6px; }
  .dp-nav-btn { color: var(--text-2); }
  .dp-nav-btn:disabled { opacity: 0.3; cursor: default; }
  .dp-month-year { display: flex; align-items: center; gap: 6px; }
  .dp-month-btn {
    font-size: 15px; font-weight: 700; color: var(--text-1);
    background: var(--surface-2); border: none; cursor: pointer;
    border-radius: var(--radius-sm); padding: 2px 8px;
    display: flex; align-items: center; transition: background var(--dur-fast);
  }
  .dp-month-btn:hover { background: var(--surface-3); }
  .dp-year-btn {
    font-size: 15px; font-weight: 700; color: var(--accent);
    background: var(--accent-dim); border: none; cursor: pointer;
    border-radius: var(--radius-sm); padding: 2px 8px;
    display: flex; align-items: center; transition: background var(--dur-fast);
  }
  .dp-year-btn:hover { background: color-mix(in srgb, var(--accent) 20%, transparent); }
  .dp-year-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; padding: 4px 8px 12px; max-height: 200px; overflow-y: auto; }
  .dp-yr-btn { padding: 8px 4px; font-size: 14px; font-weight: 500; border-radius: var(--radius-sm); background: none; border: none; cursor: pointer; color: var(--text-1); transition: background var(--dur-fast); text-align: center; }
  .dp-yr-btn:hover { background: var(--surface-2); }
  .dp-yr-btn.dp-yr-sel { background: var(--accent); color: #fff; font-weight: 700; }
  .dp-month-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; padding: 4px 8px 12px; }
  .dp-mo-btn { padding: 10px 4px; font-size: 14px; font-weight: 500; border-radius: var(--radius-sm); background: none; border: none; cursor: pointer; color: var(--text-1); transition: background var(--dur-fast); text-align: center; }
  .dp-mo-btn:hover { background: var(--surface-2); }
  .dp-mo-btn.dp-mo-sel { background: var(--accent); color: #fff; font-weight: 700; }
  .dp-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px; padding: 0 8px 12px; }
  .dp-dh { text-align: center; font-size: 11px; font-weight: 600; color: var(--text-3); padding: 4px 0; }
  .dp-day {
    aspect-ratio: 1; display: flex; align-items: center; justify-content: center;
    font-size: 14px; border-radius: var(--radius-full);
    background: none; border: none; cursor: pointer;
    color: var(--text-1); transition: background var(--dur-fast);
    -webkit-tap-highlight-color: transparent;
  }
  .dp-day:hover:not(:disabled) { background: var(--surface-2); }
  .dp-day:disabled { color: var(--text-3); opacity: 0.3; cursor: default; }
  .dp-day.dp-today { color: var(--accent); font-weight: 700; }
  .dp-day.dp-sel   { background: var(--accent) !important; color: #fff; font-weight: 600; }

  .chart-card { padding: 16px; position: relative; }
  .chart-loading {
    position: absolute; inset: 0; z-index: 2;
    display: flex; align-items: center; justify-content: center;
    background: rgba(var(--surface-1-rgb, 18,20,26), 0.7);
  }
  .chart-wrap { height: 220px; position: relative; }

  /* Summary */
  .summary-card { padding: 16px 12px; }
  .summary-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; }
  .summary-item { display: flex; flex-direction: column; align-items: center; gap: 1px; }
  .summary-val  { font-size: 18px; font-weight: 800; color: var(--accent); letter-spacing: -0.02em; }
  .summary-unit { font-size: 10px; font-weight: 600; color: var(--accent); opacity: 0.6; }
  .summary-lbl  { font-size: 10px; color: var(--text-3); text-transform: uppercase; letter-spacing: .4px; margin-top: 2px; }

  /* Timeline */
  .section-title { font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: var(--text-3); margin-bottom: 6px; }
  .timeline-list { overflow: hidden; }
  .timeline-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 14px;
    border-bottom: 1px solid var(--border);
    font-size: 14px;
  }
  .timeline-row:last-child { border-bottom: none; }
  .timeline-date { color: var(--text-2); }
  .timeline-val  { font-weight: 600; color: var(--accent); }
  /* Tap-into-day link (#64). Styled as a subtle link so the affordance
     is discoverable without making the whole row feel clicky/footgun-y
     on mobile. The value column stays unstyled so scrolling past the
     list without intent doesn't accidentally trigger navigation. */
  .timeline-date-link {
    background: none;
    border: none;
    padding: 0;
    margin: 0;
    font: inherit;
    color: var(--text-2);
    cursor: pointer;
    text-align: left;
    border-radius: 4px;
    transition: color 120ms, background 120ms;
    -webkit-tap-highlight-color: transparent;
  }
  .timeline-date-link:hover,
  .timeline-date-link:focus-visible {
    color: var(--accent);
    text-decoration: underline;
    text-underline-offset: 3px;
    outline: none;
  }
  .timeline-date-link:focus-visible {
    background: color-mix(in srgb, var(--accent) 12%, transparent);
    padding: 2px 6px;
    margin: -2px -6px;
  }

  :global(.spin) { animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* ─── Desktop three-pane layout ─────────────────────────────────────────
     Mobile defaults keep the single-column stack; rails + duplicate KPIs
     hidden. Desktop grid + rail visibility gated inside a
     :global(html:not(.force-mobile-layout)) media query below so a user
     with "Force mobile layout" ON stays on the mobile presentation. */
  .stats-body { display: block; }
  .stats-left-rail,
  .stats-right-rail,
  .stats-rail-only { display: none; }
  .stats-center-only { display: block; }

  :global(html:not(.force-mobile-layout)) .stats-body { /* mobile placeholder */ }

  @media (min-width: 1280px) {
    :global(html:not(.force-mobile-layout)) .stats-body {
      display: grid;
      grid-template-columns: 240px minmax(0, 1fr) 320px;
      column-gap: 20px;
      align-items: start;
      padding: 12px var(--page-px, 16px);
    }
    :global(html:not(.force-mobile-layout)) .stats-content.stats-main {
      padding: 0;
    }
    :global(html:not(.force-mobile-layout)) .stats-left-rail,
    :global(html:not(.force-mobile-layout)) .stats-right-rail {
      display: block;
      position: sticky;
      top: calc(var(--page-top, var(--safe-top)) + 72px + var(--hamburger-row, 0px));
      align-self: start;
      background: var(--surface-1);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      padding: 12px;
    }
    /* #2 Rail becomes scrollable on desktop — long metric lists (all
       body stats + wellness enabled) overflow a 900px viewport otherwise.
       Same thin-scrollbar treatment as the Settings + Foods rails so
       the whole app reads as one system. */
    :global(html:not(.force-mobile-layout)) .stats-left-rail {
      max-height: calc(100vh - var(--page-top, var(--safe-top)) - 100px - var(--hamburger-row, 0px) - var(--nav-h, 0px) - var(--safe-bottom, 0px));
      overflow-y: auto;
      scrollbar-width: thin;
      scrollbar-color: var(--border) transparent;
    }
    :global(html:not(.force-mobile-layout)) .stats-left-rail::-webkit-scrollbar { width: 6px; }
    :global(html:not(.force-mobile-layout)) .stats-left-rail::-webkit-scrollbar-track { background: transparent; }
    :global(html:not(.force-mobile-layout)) .stats-left-rail::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
    :global(html:not(.force-mobile-layout)) .stats-left-rail::-webkit-scrollbar-thumb:hover { background: var(--text-3); }
    :global(html:not(.force-mobile-layout)) .stats-rail-only { display: block; }
    :global(html:not(.force-mobile-layout)) .stats-center-only { display: none; }
    /* Horizontal pill scroller replaced by the rail on desktop */
    :global(html:not(.force-mobile-layout)) .metric-scroll { display: none; }
    /* Chart grows to fill the vertical rhythm the rails set */
    :global(html:not(.force-mobile-layout)) .chart-wrap {
      height: clamp(300px, 45vh, 520px);
    }

    /* Calendar sheet becomes a centered popover on desktop instead of a
       bottom-sheet slide-up (Phase D). Backdrop centers its child; sheet
       drops the mobile-only bottom-flush border-radius. */
    :global(html:not(.force-mobile-layout)) .stat-backdrop {
      align-items: center;
      justify-content: center;
    }
    :global(html:not(.force-mobile-layout)) .stat-cal-sheet {
      border-radius: var(--radius-xl);
      max-height: 90vh;
      overflow-y: auto;
      padding-bottom: 8px;
    }
  }

  /* Left rail chrome — mimics the Settings rail's section-toggle look. */
  .stats-rail-heading {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-3);
    margin: 0 0 8px;
  }
  .stats-rail-group {
    font-size: 11px;
    font-weight: 600;
    color: var(--text-3);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    margin: 10px 0 4px;
    padding: 0 6px;
  }
  .stats-rail-metric {
    display: block;
    width: 100%;
    text-align: left;
    padding: 8px 10px;
    margin: 2px 0;
    border-radius: var(--radius-md);
    background: transparent;
    border: none;
    color: var(--text-2);
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: background var(--dur-fast), color var(--dur-fast);
  }
  .stats-rail-metric:hover {
    background: var(--surface-2);
    color: var(--text-1);
  }
  .stats-rail-metric.active {
    background: var(--accent-dim);
    color: var(--accent);
    font-weight: 600;
  }

  /* Right rail KPI stack */
  .stats-rail-kpi {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 8px 4px;
    border-bottom: 1px solid var(--border);
  }
  .stats-rail-kpi:last-of-type { border-bottom: none; }
  .stats-rail-kpi-lbl {
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-3);
  }
  .stats-rail-kpi-val {
    font-size: 18px;
    font-weight: 800;
    color: var(--accent);
    letter-spacing: -0.02em;
    display: flex;
    align-items: baseline;
    gap: 6px;
    flex-wrap: wrap;
  }
  .stats-rail-kpi-unit {
    font-size: 11px;
    font-weight: 600;
    color: var(--accent);
    opacity: 0.6;
  }
  .stats-rail-delta {
    font-size: 11px;
    font-weight: 700;
    padding: 2px 6px;
    border-radius: var(--radius-full);
    letter-spacing: 0;
  }
  .stats-rail-delta.good {
    background: color-mix(in srgb, #22c55e 22%, transparent);
    color: #16a34a;
  }
  .stats-rail-delta.bad {
    background: color-mix(in srgb, #ef4444 22%, transparent);
    color: #dc2626;
  }
  :global([data-theme="dark"]) .stats-rail-delta.good { color: #4ade80; }
  :global([data-theme="dark"]) .stats-rail-delta.bad  { color: #f87171; }
  .stats-rail-empty { margin: 4px 0 8px; }

  /* Overlay checkbox rows */
  .stats-rail-check {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 4px;
    font-size: 13px;
    color: var(--text-1);
    cursor: pointer;
    user-select: none;
  }
  .stats-rail-check input[type="checkbox"] {
    width: 16px;
    height: 16px;
    accent-color: var(--accent);
    cursor: pointer;
  }

  /* ── Phase-C polish additions (desktop-only, gated inline where needed) ── */
  /* #2 Rail filter input */
  .stats-rail-search {
    width: 100%;
    padding: 6px 10px;
    margin: 0 0 6px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    color: var(--text-1);
    font-size: 12px;
    font-family: inherit;
    box-sizing: border-box;
    transition: border-color var(--dur-fast), background var(--dur-fast);
  }
  .stats-rail-search:focus {
    outline: none;
    border-color: var(--accent);
    background: var(--surface-1);
  }
  .stats-rail-search::placeholder { color: var(--text-3); }

  /* #4 Timeline month header */
  .stats-tl-month {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 10px 14px;
    background: var(--surface-2);
    border: none;
    border-bottom: 1px solid var(--border);
    cursor: pointer;
    font: inherit;
    color: var(--text-1);
    text-align: left;
    transition: background var(--dur-fast);
  }
  .stats-tl-month:hover { background: var(--surface-3); }
  .stats-tl-month-label { flex: 1; font-weight: 600; font-size: 13px; }
  .stats-tl-month-count {
    font-size: 11px;
    font-weight: 700;
    color: var(--text-3);
    background: var(--surface-1);
    padding: 2px 8px;
    border-radius: var(--radius-full);
  }
  .stats-tl-chevron {
    font-size: 18px;
    color: var(--text-3);
    transition: transform var(--dur-fast);
  }
  .stats-tl-chevron.open { transform: rotate(180deg); }

  /* #7 Empty-state alternatives */
  .stats-empty-alts {
    margin-top: 10px;
    line-height: 1.6;
  }
  .stats-empty-alt-link {
    background: none;
    border: none;
    padding: 2px 4px;
    margin: 0 1px;
    font: inherit;
    font-weight: 600;
    color: var(--accent);
    cursor: pointer;
    border-radius: 4px;
    transition: background var(--dur-fast);
  }
  .stats-empty-alt-link:hover {
    background: color-mix(in srgb, var(--accent) 15%, transparent);
    text-decoration: underline;
  }

  /* #6 Neutral trend chip (goal-less metrics) */
  .stats-rail-delta.neutral {
    background: var(--surface-2);
    color: var(--text-2);
  }

  /* #8 CSV export button — sits in the chart-card corner on all viewports */
  .chart-csv {
    position: absolute;
    top: 10px;
    right: 10px;
    z-index: 2;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    padding: 0;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    color: var(--text-2);
    cursor: pointer;
    transition: background var(--dur-fast), color var(--dur-fast), border-color var(--dur-fast);
  }
  .chart-csv .material-symbols-rounded { font-size: 18px; }
  .chart-csv:hover,
  .chart-csv:focus-visible {
    background: var(--accent-dim);
    color: var(--accent);
    border-color: transparent;
    outline: none;
  }
</style>
