<script>
  import { onMount, onDestroy } from 'svelte';
  import { slide } from 'svelte/transition';
  import { _ } from 'svelte-i18n';
  import { portal } from '../lib/portal.js';
  import { dragScroll } from '../lib/drag-scroll.js';
  import Chart from 'chart.js/auto';
  import { DB, localDateStr } from '../lib/db.js';
  import { NtApi } from '../lib/api.js';
  import { NUTRIMENTS, Nutrition } from '../lib/nutrition.js';
  import { readBodyStat } from '../lib/body-stats-unit.js';
  import { goals, energyUnit, weightUnit, lengthUnit, statsChartType, statsYZero,
           statsAvgLine, statsGoalLine, statsTrendLine, statsIncludeToday, statsShowEmptyDays,
           hiddenBodyStats, dateFormat, pageBanners, bannerStyle,
           fitbitEnabled, garminEnabled, withingsEnabled, healthConnectEnabled, wellnessMetrics,
           calorieGoalMode,
           fastingEnabled } from '../stores/settings.js';
  import FastingInsights from '../components/diary/FastingInsights.svelte';
  import { isNative } from '../lib/platform.js';
  import StatsBanner from '../components/banners/StatsBanner.svelte';
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
  // Default energy metric matches the user's chosen energy unit so AU/NZ
  // users see kJ out of the box instead of having to switch every time.
  let metric = ($energyUnit === 'kJ') ? 'kilojoules' : 'calories';
  let data   = [];    // [{ date, val }]
  let loading = false;
  let summary = null; // { avg, min, max, total, daysWithData }
  let _loadVer = 0;   // cancel stale concurrent loadData calls

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

  // Wellness metrics — shown only when relevant integration is enabled
  $: _hasWellness = $fitbitEnabled || $garminEnabled || $healthConnectEnabled;
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
    ...(($withingsEnabled || $healthConnectEnabled) && _wlVisible('muscle_mass_kg') ? [
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
  $: METRICS = [
    ...NUTRIMENTS.filter(n => n.default),
    ...BODY_STATS.filter(s => !($hiddenBodyStats||[]).includes(s.value)),
    ...(_waterShowInStats ? [{ value: 'water', label: 'Water', unit: _waterUnit }] : []),
    ...WELLNESS_METRICS,
  ];

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
      ((metric === 'weight' || metric === 'body_fat') && ($withingsEnabled || $healthConnectEnabled)) ||
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
        try { if ($fitbitEnabled)  fitbitData  = await NtApi.get(`/api/wellness/fitbit/data?from=${fromStr}&to=${toStr}`); } catch {}
        try { if ($garminEnabled)  garminData  = await NtApi.get(`/api/wellness/garmin/data?from=${fromStr}&to=${toStr}`); } catch {}
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
        let withingsData = {}, hcData = {};
        try { if ($withingsEnabled) withingsData = await NtApi.get(`/api/wellness/withings/data?from=${fromStr}&to=${toStr}`); } catch {}
        if ($healthConnectEnabled && isNative) {
          try {
            const { dbGetWellnessGrouped } = await import('../lib/db-native.js');
            hcData = await dbGetWellnessGrouped(fromStr, toStr, 'health_connect');
          } catch {}
        }
        rows = dates.map(d => {
          const raw = withingsData[d]?.[wlMeta.apiField]?.value ?? hcData[d]?.[wlMeta.apiField] ?? null;
          const val = raw != null && wlMeta.isWeight && $weightUnit === 'lb' ? raw * 2.20462 : raw;
          return { date: d, val };
        });
      }

    } else {
      // Load from diary; body comp metrics also check device data (Withings, Health Connect)
      let withingsData = {}, hcBodyData = {};
      if (isBodyDevice) {
        try { if ($withingsEnabled) withingsData = await NtApi.get(`/api/wellness/withings/data?from=${fromStr}&to=${toStr}`); } catch {}
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
          // Device-first: Withings wins, then HC, then diary fallback
          const apiField = metric === 'weight'     ? 'weight_kg'
                         : metric === 'body_water' ? 'body_water_pct'
                                                   : 'body_fat_pct';
          const raw = withingsData[date]?.[apiField]?.value ?? hcBodyData[date]?.[apiField] ?? null;
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

    // Goal line — always type 'line' even in bar chart mode
    if ($statsGoalLine) {
      const g = $goals && $goals[metric];
      let goalVal = g ? (g.max ?? g.min ?? null) : null;
      if (goalVal != null && g?.isPercent) {
        const density = {fat:9,'saturated-fat':9,carbohydrates:4,sugars:4,proteins:4}[metric];
        const calGoal = $goals.calories?.max ?? $goals.calories?.min ?? 2000;
        if (density) goalVal = Math.round(calGoal * goalVal / 100 / density);
      }
      if (goalVal != null && metric === 'calories' && $energyUnit === 'kJ') goalVal = Math.round(Nutrition.kcalToKj(goalVal));
      if (goalVal) {
        const isAdaptiveOrDynamic = metric === 'calories' && ($calorieGoalMode === 'dynamic' || $calorieGoalMode === 'adaptive');
        datasets.push({
          type: 'line',
          label: isAdaptiveOrDynamic ? 'Base Goal' : 'Goal',
          data: displayData.map(() => goalVal),
          borderColor: isDark ? 'rgba(129,140,248,0.8)' : 'rgba(99,102,241,0.8)',
          borderWidth: 1.5,
          borderDash: [4, 4],
          pointRadius: 0,
          fill: false,
          spanGaps: true,
        });
      }
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
        plugins: {
          legend: { display: datasets.length > 1, labels: { color: textColor, boxHeight: 2, usePointStyle: true } },
          tooltip: {
            displayColors: datasets.length > 1,
            callbacks: { label: ctx => `${ctx.dataset.label || ''}: ${ctx.parsed.y.toLocaleString()} ${getMetricUnit()}`.trim() }
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
            beginAtZero: $statsYZero,
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
  <header class="page-header" class:has-banner={$pageBanners} class:banner-gradient={$bannerStyle === 'gradient'}>
    {#if $bannerStyle === 'animated'}<StatsBanner />{/if}
    <h1>{$_('routes.statistics.title')}</h1>
  </header>

  <div class="stats-content">
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
          <button class="quick-chip" on:click={() => { const t = localDateStr(); const d = new Date(); d.setDate(d.getDate() - 6); customStart = localDateStr(d); customEnd = t; showCalFor = null; }}>Last 7d</button>
          <button class="quick-chip" on:click={() => { const t = localDateStr(); const d = new Date(); d.setDate(d.getDate() - 29); customStart = localDateStr(d); customEnd = t; showCalFor = null; }}>Last 30d</button>
          <button class="quick-chip" on:click={() => { const t = localDateStr(); const d = new Date(); d.setDate(d.getDate() - 89); customStart = localDateStr(d); customEnd = t; showCalFor = null; }}>Last 90d</button>
          <button class="quick-chip" on:click={() => { const t = new Date(); customStart = `${t.getFullYear()}-${String(t.getMonth()+1).padStart(2,'0')}-01`; customEnd = localDateStr(); showCalFor = null; }}>This Month</button>
          <button class="quick-chip" on:click={() => { const t = new Date(); t.setMonth(t.getMonth() - 1); const start = `${t.getFullYear()}-${String(t.getMonth()+1).padStart(2,'0')}-01`; const end = new Date(t.getFullYear(), t.getMonth() + 1, 0); customStart = start; customEnd = localDateStr(end); showCalFor = null; }}>Last Month</button>
          <button class="quick-chip" on:click={() => { const y = new Date().getFullYear(); customStart = `${y}-01-01`; customEnd = localDateStr(); showCalFor = null; }}>YTD</button>
        </div>
        <div class="custom-range-row">
          <button class="date-range-btn" class:active={showCalFor === 'start'} on:click={() => openCal('start')}>
            <span class="material-symbols-rounded drb-icon">calendar_today</span>
            <div class="drb-text">
              <span class="drb-label">From</span>
              <span class="drb-val">{fmtDate(customStart)}</span>
            </div>
          </button>
          <span class="drb-arrow">→</span>
          <button class="date-range-btn" class:active={showCalFor === 'end'} on:click={() => openCal('end')}>
            <span class="material-symbols-rounded drb-icon">calendar_today</span>
            <div class="drb-text">
              <span class="drb-label">To</span>
              <span class="drb-val">{fmtDate(customEnd)}</span>
            </div>
          </button>
        </div>
      </div>
    {/if}

    <!-- Summary stats (above chart) -->
    {#if summary}
      <div class="summary-card card">
        <div class="summary-grid">
          <div class="summary-item">
            <span class="summary-val">{summary.avg.toLocaleString()}</span>
            <span class="summary-unit">{_metricUnit}</span>
            <span class="summary-lbl">Average</span>
          </div>
          <div class="summary-item">
            <span class="summary-val">{summary.min.toLocaleString()}</span>
            <span class="summary-unit">{_metricUnit}</span>
            <span class="summary-lbl">Min</span>
          </div>
          <div class="summary-item">
            <span class="summary-val">{summary.max.toLocaleString()}</span>
            <span class="summary-unit">{_metricUnit}</span>
            <span class="summary-lbl">Max</span>
          </div>
          <div class="summary-item">
            <span class="summary-val">{summary.daysWithData.toLocaleString()}</span>
            <span class="summary-unit">days</span>
            <span class="summary-lbl">Logged</span>
          </div>
        </div>
      </div>
    {/if}

    <!-- Chart -->
    <div class="chart-card card">
      {#if loading}
        <div class="chart-loading">
          <span class="material-symbols-rounded spin">refresh</span>
        </div>
      {:else if data.length === 0}
        <div class="chart-loading" style="background:transparent">
          <div style="text-align:center;opacity:0.45;padding:8px 24px">
            <span class="material-symbols-rounded" style="font-size:36px">show_chart</span>
            <div class="text-2 text-sm" style="margin-top:6px;font-weight:600">No data for this period</div>
            <div class="text-3 text-sm" style="margin-top:4px;line-height:1.45">
              {#if metric === 'calories' || metric === 'proteins' || metric === 'carbohydrates' || metric === 'fat'}
                Log food in your diary to see trends here
              {:else if metric.startsWith('wl_')}
                Connect a fitness tracker in Settings → Wellness
              {:else}
                No entries found — try a different date range
              {/if}
            </div>
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
        <div class="section-title">History</div>
        <div class="timeline-list card">
          {#each [...data].reverse() as row}
            {#if Number.isFinite(row.val)}
              <div class="timeline-row">
                <span class="timeline-date">
                  {(() => {
                    const dt = new Date(row.date + 'T12:00:00');
                    const fmt = $dateFormat || 'ISO';
                    if (fmt === 'US') { const m=String(dt.getMonth()+1).padStart(2,'0'),d=String(dt.getDate()).padStart(2,'0'); return m+'/'+d+'/'+dt.getFullYear(); }
                    if (fmt === 'EU') { const m=String(dt.getMonth()+1).padStart(2,'0'),d=String(dt.getDate()).padStart(2,'0'); return d+'/'+m+'/'+dt.getFullYear(); }
                    if (fmt === 'natural') return dt.toLocaleDateString(undefined,{day:'numeric',month:'short',year:'numeric'});
                    return row.date;
                  })()}
                </span>
                <span class="timeline-val accent-text">{row.val.toLocaleString()} {_metricUnit}</span>
              </div>
            {/if}
          {/each}
        </div>
      </div>
    {/if}

    {#if $fastingEnabled}
      <FastingInsights />
    {/if}

    <div style="height:16px"></div>
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

  :global(.spin) { animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
