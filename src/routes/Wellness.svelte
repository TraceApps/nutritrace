<script>
  import { onMount, onDestroy, tick } from 'svelte';
  import { wellnessMetrics, wellnessSyncMode, wellnessSyncRange, distUnit, tempUnit, pageBanners, dateFormat, withingsSyncRange as withingsSyncRangeSetting, fitbitEnabled, withingsEnabled, garminEnabled, garminSyncRange as garminSyncRangeSetting, weightUnit, goals, goalCelebrations, disableAnimations } from '../stores/settings.js';
  import Chart from 'chart.js/auto';
  import WellnessBanner from '../components/banners/WellnessBanner.svelte';
  import { showSuccess, showError } from '../stores/toast.js';
  import { localDateStr } from '../lib/db.js';
  import { NtApi } from '../lib/api.js';
  import { isNative, getServerUrl } from '../lib/platform.js';
  import { portal } from '../lib/portal.js';
  import FitbitIcon from '../components/icons/FitbitIcon.svelte';
  import HealthConnectIcon from '../components/icons/HealthConnectIcon.svelte';
  import WithingsIcon from '../components/icons/WithingsIcon.svelte';
  import GarminIcon from '../components/icons/GarminIcon.svelte';

  // ── Metric definitions ─────────────────────────────────────────────────────
  // sources: which integrations can supply this metric. Used to hide metrics
  // when their only source integration is disabled.
  const ALL_METRICS = [
    // Movement — both Fitbit and Garmin
    { id: 'steps',            label: 'Steps',             unit: 'steps', group: 'movement', icon: 'directions_walk',       fmt: v => Math.round(v).toLocaleString(),  sources: ['fitbit','garmin'], desc: 'Total steps taken today.' },
    { id: 'distance_km',      label: 'Distance',          unit: '',      group: 'movement', icon: 'straighten',            fmt: null,                                  sources: ['fitbit','garmin'], desc: 'Total distance covered today.' },
    { id: 'floors',           label: 'Floors Climbed',    unit: 'floors',group: 'movement', icon: 'stairs',                fmt: v => Math.round(v),                   sources: ['fitbit','garmin'], desc: 'Floors climbed based on elevation gain detected by your device.' },
    { id: 'active_minutes',   label: 'Active Minutes',    unit: 'min',   group: 'movement', icon: 'timer',                 fmt: v => Math.round(v),                   sources: ['fitbit','garmin'], desc: 'Time spent at a moderate or higher activity level.' },
    { id: 'calories_out',     label: 'Calories Burned',   unit: 'kcal',  group: 'movement', icon: 'local_fire_department', fmt: v => Math.round(v).toLocaleString(),  sources: ['fitbit','garmin'], desc: 'Total calories burned including your resting metabolic rate.' },
    // Movement — Fitbit only
    { id: 'active_zone_minutes', label: 'Active Zone Min', unit: 'min',  group: 'movement', icon: 'local_fire_department', fmt: v => Math.round(v), sources: ['fitbit'], desc: 'Minutes spent in Fat Burn, Cardio, or Peak heart rate zones — counts double for Cardio and Peak.' },
    // Movement — Garmin only
    { id: 'moderate_intensity_min', label: 'Moderate Intensity', unit: 'min', group: 'movement', icon: 'directions_run', fmt: v => Math.round(v), sources: ['garmin'], desc: 'Time at moderate intensity (brisk walking, light cycling). WHO recommends 150–300 min/week.' },
    { id: 'vigorous_intensity_min', label: 'Vigorous Intensity', unit: 'min', group: 'movement', icon: 'sprint',         fmt: v => Math.round(v), sources: ['garmin'], desc: 'Time at high intensity (running, hard effort). Counts double toward weekly activity targets.' },
    // Sleep — both
    { id: 'sleep_duration_min', label: 'Sleep Duration', unit: '',     group: 'sleep', icon: 'bedtime',               fmt: null,               sources: ['fitbit','garmin'], desc: 'Total time asleep last night. Adults generally need 7–9 hours.' },
    { id: 'sleep_deep_min',     label: 'Deep Sleep',     unit: 'min',  group: 'sleep', icon: 'nights_stay',           fmt: v => Math.round(v), sources: ['fitbit','garmin'], desc: 'Deep (slow-wave) sleep — the most restorative stage. Critical for physical recovery and immune function.' },
    { id: 'sleep_light_min',    label: 'Light Sleep',    unit: 'min',  group: 'sleep', icon: 'cloud',                 fmt: v => Math.round(v), sources: ['fitbit','garmin'], desc: 'Light sleep is the transition between wakefulness and deeper stages. Makes up the majority of most sleep cycles.' },
    { id: 'sleep_rem_min',      label: 'REM Sleep',      unit: 'min',  group: 'sleep', icon: 'psychology',            fmt: v => Math.round(v), sources: ['fitbit','garmin'], desc: 'REM sleep supports memory consolidation, learning, and emotional regulation. Increases in later sleep cycles.' },
    { id: 'sleep_wake_min',     label: 'Awake',          unit: 'min',  group: 'sleep', icon: 'wb_twilight',           fmt: v => Math.round(v), sources: ['fitbit','garmin'], desc: 'Time spent awake or restless during the night. Brief awakenings are normal; frequent ones may signal poor sleep quality.' },
    // Sleep — Fitbit only
    { id: 'sleep_efficiency',   label: 'Sleep Efficiency', unit: '%',  group: 'sleep', icon: 'battery_charging_full', fmt: v => v.toFixed(0),  sources: ['fitbit'], desc: 'Percentage of time in bed actually spent asleep. Above 85% is generally considered good.' },
    // Sleep — Garmin (device-measured); Fitbit (estimated from stages + SpO2 + HRV)
    { id: 'sleep_score',        label: 'Sleep Score',    unit: '/100', group: 'sleep', icon: 'star',                  fmt: v => Math.round(v), sources: ['fitbit','garmin'], desc: 'Overall sleep quality score out of 100. Factors in duration, sleep stage balance, SpO2, and HRV.' },
    // Heart — both
    { id: 'resting_hr',        label: 'Resting Heart Rate', unit: 'bpm',  group: 'heart', icon: 'favorite',       fmt: v => Math.round(v), sources: ['fitbit','garmin'], desc: 'Heart rate when fully at rest. Lower is generally better — a downward trend over time reflects improving cardiovascular fitness.' },
    { id: 'spo2_avg',          label: 'SpO2',               unit: '%',    group: 'heart', icon: 'water_drop',     fmt: v => v.toFixed(1),  sources: ['fitbit','garmin'], desc: 'Blood oxygen saturation measured overnight. Healthy range is typically 95–100%. Dips below 90% may indicate sleep apnea.' },
    { id: 'respiratory_rate',  label: 'Respiratory Rate',   unit: 'brpm', group: 'heart', icon: 'air',            fmt: v => v.toFixed(1),  sources: ['fitbit','garmin'], desc: 'Average breaths per minute during sleep. Normal adult range is 12–20 breaths/min. Elevated values may signal illness or stress.' },
    { id: 'hrv_daily_rmssd',   label: 'HRV (RMSSD)',        unit: 'ms',   group: 'heart', icon: 'monitor_heart',  fmt: v => v.toFixed(1),  sources: ['fitbit','garmin'], desc: 'Heart rate variability — the variation between heartbeats. Higher values indicate better recovery and autonomic nervous system balance.' },
    // Heart — Fitbit only
    { id: 'skin_temp_variation', label: 'Skin Temp Var.', unit: '°F',   group: 'heart', icon: 'thermometer',    fmt: null, sources: ['fitbit'], desc: 'Nightly skin temperature variation from your personal baseline. Elevated readings can indicate illness or hormonal changes.' },
    { id: 'vo2_max',             label: 'Cardio Fitness',  unit: '',     group: 'heart', icon: 'fitness_center', fmt: v => v.toFixed(1),  sources: ['fitbit'], desc: 'Estimated VO₂ Max — the maximum oxygen your body can use during exercise. Fitbit shows this as a range (e.g. 39–43 mL/kg/min). A key indicator of long-term cardiovascular health.' },
    // Heart — Garmin only
    { id: 'max_hr',           label: 'Max Heart Rate',     unit: 'bpm',       group: 'heart', icon: 'favorite',       fmt: v => Math.round(v), sources: ['garmin'], desc: 'Highest heart rate recorded during the day. Useful for tracking workout intensity and your true max effort.' },
  ];

  // Returns true if at least one of this metric's source integrations is enabled
  function isSourceEnabled(m) {
    if (!m.sources) return true;
    // Health Connect provides data for fitbit/garmin metric types too
    if ($healthConnectEnabled) return true;
    return m.sources.some(s =>
      (s === 'fitbit'   && $fitbitEnabled)  ||
      (s === 'garmin'   && $garminEnabled)  ||
      (s === 'withings' && $withingsEnabled)
    );
  }

  function isVisible(metricId) {
    const vis = $wellnessMetrics;
    return vis == null || vis.includes(metricId);
  }

  function toggleMetric(id) {
    const all = [
      ...ALL_METRICS.map(m => m.id),
      'weight_kg','body_fat_pct','muscle_mass_kg','bone_mass_kg','body_water_pct','lean_mass_kg','fat_mass_kg','visceral_fat','visceral_fat_index','extracellular_water_kg','intracellular_water_kg',
      'vascular_age','metabolic_age','basal_metabolic_rate','nerve_health_score','eda_feet','pulse_wave_velocity','ecg_heart_rate','ecg_afib',
      'body_battery_high','body_battery_low','stress_avg',
      'segmental_analysis',
      'active_calories','avg_heart_rate','blood_pressure_systolic','blood_pressure_diastolic','body_temperature','sleep_awake_min','water_ml',
    ];
    const cur = $wellnessMetrics ?? all;
    if (cur.includes(id)) {
      wellnessMetrics.set(cur.filter(x => x !== id));
    } else {
      wellnessMetrics.set([...cur, id]);
    }
  }

  // ── Local-first data helper (native: read from SQLite, PWA: read from server)
  async function _getWellnessRange(source, from, to) {
    if (isNative) {
      try {
        const { dbGetWellnessGrouped } = await import('../lib/db-native.js');
        return await dbGetWellnessGrouped(from, to, source);
      } catch (e) {
        console.warn('[wellness] local range load failed:', e.message);
        return {};
      }
    }
    // PWA: fetch from server
    return NtApi.get(`/api/wellness/${source}/data?from=${from}&to=${to}`);
  }

  // ── State ──────────────────────────────────────────────────────────────────
  let activeTab   = 'movement';
  let dateStr     = localDateStr();
  let status      = null; // { connected, configured, fitbitUserId, expiresAt }
  let data        = {}; // { [metricId]: value }
  let syncing     = false;
  let lastSync    = null;
  let connecting  = false;
  let loadingData = true;

  // On native: tracks whether we have cached wellness data (show data even if server unreachable)
  let _hasLocalData = false;

  // Withings state
  let withingsStatus     = null;
  let withingsData       = {};
  let withingsSyncing    = false;
  let withingsLastSync   = null;
  let withingsConnecting = false;

  // Garmin state
  let garminStatus     = null;
  let garminData       = {};
  let garminSyncing    = false;
  let hcSyncing        = false;
  let garminConnecting = false;
  // ── Unit helpers ───────────────────────────────────────────────────────────
  $: du = $distUnit || 'km';

  function fmtDistance(km) {
    if (km == null) return null;
    if (du === 'mi') return { value: (km * 0.621371).toFixed(2), unit: 'mi' };
    return { value: km.toFixed(2), unit: 'km' };
  }

  function fmtSleep(min) {
    if (min == null) return null;
    const h = Math.floor(min / 60);
    const m = Math.round(min % 60);
    if (h === 0) return { value: `${m}`, unit: 'min' };
    if (m === 0) return { value: `${h}h`, unit: '' };
    return { value: `${h}h ${m}m`, unit: '' };
  }

  function fmtSleepStr(min) {
    const s = fmtSleep(min);
    if (!s) return '—';
    return s.unit ? `${s.value} ${s.unit}` : s.value;
  }

  const SLEEP_TIME_IDS = new Set(['sleep_duration_min','sleep_deep_min','sleep_light_min','sleep_rem_min','sleep_wake_min']);

  function fmtMetric(m, rawValue) {
    if (rawValue == null) return null;
    if (m.id === 'distance_km') {
      const d = fmtDistance(rawValue);
      return d ? { value: d.value, unit: d.unit } : null;
    }
    if (SLEEP_TIME_IDS.has(m.id)) {
      return fmtSleep(rawValue);
    }
    // Skin temp: convert based on tempUnit setting (stored as °C delta)
    if (m.id === 'skin_temp_variation') {
      const isFahr = $tempUnit !== 'C';
      const val = isFahr ? rawValue * 9 / 5 : rawValue;
      return { value: (val >= 0 ? '+' : '') + val.toFixed(2), unit: isFahr ? '°F' : '°C' };
    }
    // Cardio Fitness: prefer the range string (e.g. "39-43") when available
    if (m.id === 'vo2_max' && displayData.vo2_max_range) {
      return { value: displayData.vo2_max_range, unit: m.unit };
    }
    const val = m.fmt ? m.fmt(rawValue) : rawValue;
    return { value: String(val), unit: m.unit };
  }

  // ── Withings metric definitions ───────────────────────────────────────────
  const BODY_METRICS = [
    { id: 'weight_kg',     label: 'Weight',       unit: '', icon: 'monitor_weight',   fmt: null, desc: 'Current body weight from your scale.' },
    { id: 'body_fat_pct',  label: 'Body Fat',     unit: '%', icon: 'percent',          fmt: v => v.toFixed(1), desc: 'Percentage of total body weight that is fat tissue. Healthy ranges vary by age and sex.' },
    { id: 'muscle_mass_kg',label: 'Muscle Mass',  unit: '', icon: 'fitness_center',   fmt: null, desc: 'Total skeletal muscle mass. Higher values indicate better strength and metabolic health.' },
    { id: 'bone_mass_kg',  label: 'Bone Mass',    unit: '', icon: 'emergency',         fmt: v => v.toFixed(2), desc: 'Estimated bone mineral content. Stable values are normal; significant drops may warrant discussion with your doctor.' },
    { id: 'body_water_pct',label: 'Body Water',   unit: '', icon: 'water_drop',       fmt: null, desc: 'Total body water as a percentage of weight. Normal range is 45–65% depending on age and sex.' },
    { id: 'lean_mass_kg',            label: 'Lean Mass',            unit: '', icon: 'person',           fmt: null, desc: 'Everything except fat — includes muscle, bone, organs, and water.' },
    { id: 'fat_mass_kg',             label: 'Fat Mass',             unit: '', icon: 'scale',            fmt: null, desc: 'Total fat tissue weight. Tracking trends is more useful than individual readings.' },
    { id: 'visceral_fat',            label: 'Visceral Fat',         unit: '', icon: 'favorite_border',  fmt: v => v.toFixed(1), desc: 'Fat stored around internal organs. Higher levels are linked to increased metabolic and cardiovascular risk.' },
    { id: 'visceral_fat_index',      label: 'Visceral Fat Index',   unit: '', icon: 'favorite_border',  fmt: v => v.toFixed(1), desc: 'Indexed rating of visceral fat. Lower is better — a score under 13 is generally considered healthy.' },
    { id: 'extracellular_water_kg',  label: 'Extracellular Water',  unit: '', icon: 'water_drop',       fmt: null, desc: 'Water outside cells (blood, lymph, interstitial fluid). Elevated levels may indicate inflammation or fluid retention.' },
    { id: 'intracellular_water_kg',  label: 'Intracellular Water',  unit: '', icon: 'water_drop',       fmt: null, desc: 'Water inside cells. Reflects hydration at the cellular level — higher relative to extracellular is generally healthier.' },
  ];

  const BODY_SCORE_METRICS = [
    { id: 'vascular_age',       label: 'Vascular Age',     unit: 'yrs',  icon: 'cardiology',   fmt: v => Math.round(v), desc: 'Estimated age of your arteries based on pulse wave velocity. Lower than your actual age indicates healthier blood vessels.' },
    { id: 'metabolic_age',      label: 'Metabolic Age',    unit: 'yrs',  icon: 'trending_up',  fmt: v => Math.round(v), desc: 'Your body\'s metabolic efficiency compared to age norms. Lower than your actual age means your metabolism is performing well.' },
    { id: 'basal_metabolic_rate', label: 'Basal Metabolic Rate', unit: 'kcal/day', icon: 'local_fire_department', fmt: v => Math.round(v).toLocaleString(), desc: 'Calories your body burns at complete rest over 24 hours. Influenced by muscle mass, age, and body composition.' },
    { id: 'nerve_health_score', label: 'Nerve Health Score',  unit: '/100', icon: 'neurology',    fmt: v => Math.round(v), desc: 'Monthly nerve health score from your Withings scale. Calculated from daily EDA readings over the month. Above 50 = Normal, below 50 = Low. Final score confirmed at month-end.' },
    { id: 'eda_feet',           label: 'EDA (Daily)',        unit: 'µS',   icon: 'neurology',    fmt: v => v.toFixed(1), desc: 'Daily electrodermal activity reading from your Withings scale. Measures sweat gland nerve conductance in your feet. These daily readings feed into the monthly Nerve Health Score.' },
    { id: 'pulse_wave_velocity',label: 'Pulse Wave Vel.',  unit: 'm/s',  icon: 'show_chart',    fmt: v => v.toFixed(1), desc: 'Speed of blood pressure pulse along arteries. Lower values indicate more elastic, healthier blood vessels.' },
    { id: 'ecg_heart_rate',     label: 'Heart Rate',       unit: 'bpm',  icon: 'ecg_heart',     fmt: v => Math.round(v), desc: 'Heart rate measured during ECG recording on your scale. More accurate than optical wrist sensors.' },
    { id: 'ecg_afib',           label: 'AFib Detection',   unit: '',     icon: 'ecg',           fmt: v => v === 1 ? 'Detected' : 'Normal', desc: 'Atrial fibrillation screening from ECG recording. "Normal" means no irregular rhythm detected during this reading.' },
  ];

  function fmtWeight(kg) {
    if (kg == null) return null;
    if ($weightUnit === 'lb') return { value: (kg * 2.20462).toFixed(1), unit: 'lbs' };
    return { value: kg.toFixed(1), unit: 'kg' };
  }

  function fmtBodyMetric(m, raw) {
    if (raw == null) return null;
    if (m.id === 'weight_kg' || m.id === 'muscle_mass_kg' || m.id === 'lean_mass_kg' || m.id === 'fat_mass_kg' || m.id === 'bone_mass_kg' || m.id === 'extracellular_water_kg' || m.id === 'intracellular_water_kg') {
      return fmtWeight(raw);
    }
    if (m.id === 'body_water_pct') return { value: raw.toFixed(1), unit: '%' };
    if (m.fmt) return { value: m.fmt(raw), unit: m.unit };
    return { value: String(raw), unit: m.unit };
  }

  // ── Withings init / sync / connect / disconnect ────────────────────────────
  async function initWithings() {
    try {
      withingsStatus = await NtApi.get('/api/wellness/withings/status');
    } catch { withingsStatus = { connected: false, configured: false }; }

    if (withingsStatus.connected) {
      await loadWithingsData();
    }
  }

  async function loadWithingsData() {
    try {
      const result = await NtApi.get(`/api/wellness/withings/data?date=${dateStr}`);
      withingsData = {};
      for (const [, metrics] of Object.entries(result)) {
        for (const [key, { value }] of Object.entries(metrics)) {
          withingsData[key] = value;
        }
      }
    } catch { withingsData = {}; }
  }

  async function syncWithings(silent = false) {
    if (withingsSyncing) return;
    withingsSyncing = true;
    try {
      const range = $withingsSyncRangeSetting || 1;
      let from = dateStr, to = dateStr;
      if (!silent && range > 1) {
        const end = new Date(dateStr + 'T12:00:00');
        const start = new Date(end);
        start.setDate(start.getDate() - (range - 1));
        from = start.toLocaleDateString('sv-SE');
      }
      const result = await NtApi.post('/api/wellness/withings/sync', { from, to });
      await _pullWellnessToLocal();
      if (isNative) {
        await loadLocalWellnessData();
      } else {
        await loadWithingsData();
      }
      _checkWellnessGoals(data, withingsData);
      withingsLastSync = new Date();
      if (!silent) showSuccess(`Synced ${result.dates} day${result.dates === 1 ? '' : 's'} from Withings`);
    } catch(e) {
      if (!silent) {
        if (e.message?.includes('revoked') || e.message?.includes('Not connected') || e.status === 401) {
          showError('Withings disconnected — reconnect in Settings → Wellness');
          withingsStatus = { ...withingsStatus, connected: false };
        } else {
          showError('Withings sync failed: ' + e.message);
        }
      }
    }
    withingsSyncing = false;
  }

  async function connectWithings() {
    withingsConnecting = true;
    try {
      const { url } = await NtApi.get('/api/wellness/withings/authorize' + (isNative ? '?native=1' : ''));
      if (isNative) {
        const { openOAuth } = await import('../lib/oauth-native.js');
        await openOAuth(url);
      } else {
        window.location.href = url;
      }
    } catch(e) {
      showError(e.message || 'Could not start Withings authorization');
      withingsConnecting = false;
    }
  }

  async function disconnectWithings() {
    try {
      await NtApi.del('/api/wellness/withings/disconnect');
      withingsStatus = { ...withingsStatus, connected: false };
      withingsData = {};
      showSuccess('Disconnected from Withings');
    } catch(e) { showError(e.message); }
  }

  // ── Garmin ─────────────────────────────────────────────────────────────────
  // Garmin-specific metrics (supplements the shared ALL_METRICS)
  const GARMIN_METRICS = [
    { id: 'body_battery_high', label: 'Body Battery (Peak)', unit: '',    icon: 'battery_full',    fmt: v => Math.round(v), desc: 'Highest Body Battery level today (0–100). Charges during rest and sleep, drains during activity and stress.' },
    { id: 'body_battery_low',  label: 'Body Battery (Low)',  unit: '',    icon: 'battery_alert',   fmt: v => Math.round(v), desc: 'Lowest Body Battery level today. If it drops below 20, your body may need rest or recovery.' },
    { id: 'stress_avg',        label: 'Avg Stress',          unit: '/100',icon: 'sentiment_stressed', fmt: v => Math.round(v), desc: 'Average stress level from Garmin (0–100). Measured via heart rate variability throughout the day. Lower is calmer.' },
  ];

  async function initGarmin() {
    try {
      garminStatus = await NtApi.get('/api/wellness/garmin/status');
    } catch { garminStatus = { connected: false, configured: false }; }
    if (garminStatus.connected) await loadGarminData();
  }

  async function loadGarminData() {
    try {
      const result = await NtApi.get(`/api/wellness/garmin/data?date=${dateStr}`);
      garminData = result[dateStr] || {};
    } catch { garminData = {}; }
  }

  async function syncGarmin(silent = false) {
    if (garminSyncing) return;
    garminSyncing = true;
    try {
      const range = $garminSyncRangeSetting || 1;
      let from = dateStr, to = dateStr;
      if (!silent && range > 1) {
        const end = new Date(dateStr + 'T12:00:00');
        const start = new Date(end);
        start.setDate(start.getDate() - (range - 1));
        from = start.toLocaleDateString('sv-SE');
      }
      const result = await NtApi.post('/api/wellness/garmin/sync', { from, to });
      await _pullWellnessToLocal();
      if (isNative) {
        await loadLocalWellnessData();
      } else {
        await loadGarminData();
      }
      if (!silent) showSuccess(`Synced ${result.synced ?? 0} day${result.synced === 1 ? '' : 's'} from Garmin`);
    } catch(e) {
      if (!silent) {
        if (e.message?.includes('revoked') || e.message?.includes('Not connected') || e.status === 401) {
          showError('Garmin disconnected — reconnect in Settings → Wellness');
          garminStatus = { ...garminStatus, connected: false };
        } else {
          showError('Garmin sync failed: ' + e.message);
        }
      }
    }
    garminSyncing    = false;
    _insightsLoaded  = false;
    _readinessLoaded = false;
    _stressLoaded    = false;
  }

  async function connectGarmin() {
    garminConnecting = true;
    try {
      const { url } = await NtApi.get('/api/wellness/garmin/authorize' + (isNative ? '?native=1' : ''));
      if (isNative) {
        const { openOAuth } = await import('../lib/oauth-native.js');
        await openOAuth(url);
      } else {
        window.location.href = url;
      }
    } catch(e) {
      showError(e.message || 'Could not start Garmin authorization');
      garminConnecting = false;
    }
  }

  async function disconnectGarmin() {
    try {
      await NtApi.del('/api/wellness/garmin/disconnect');
      garminStatus = { ...garminStatus, connected: false };
      garminData = {};
      showSuccess('Disconnected from Garmin');
    } catch(e) { showError(e.message); }
  }

  // ── Workouts ────────────────────────────────────────────────────────────────
  let _workouts = [];
  let _workoutsLoaded = false;
  let _selectedWorkout = null;
  let _showWorkoutDetail = false;
  let _workoutGps = null;
  let _loadingGps = false;

  async function loadWorkouts() {
    if (!$workoutsEnabled) return;
    try {
      if (isNative) {
        const { dbGetWorkouts } = await import('../lib/db-native.js');
        _workouts = await dbGetWorkouts(dateStr, dateStr);
      } else {
        _workouts = await NtApi.get(`/api/wellness/fitbit/workouts?date=${dateStr}`);
      }
    } catch (e) {
      console.warn('[wellness] load workouts failed:', e.message);
      _workouts = [];
    }
    _workoutsLoaded = true;
    // If no workouts found and we haven't synced yet, trigger initial sync in background
    if (_workouts.length === 0 && !_workoutsSyncedOnce) {
      _workoutsSyncedOnce = true;
      console.log('[wellness] no workouts found, triggering initial sync');
      syncWorkouts();
    }
  }
  let _workoutsSyncedOnce = false;

  async function syncHealthConnectManual() {
    if (!$healthConnectEnabled || hcSyncing) return;
    hcSyncing = true;
    try {
      const { syncHealthConnect } = await import('../lib/health-connect.js');
      await syncHealthConnect(dateStr);
      if (isNative) await loadLocalWellnessData();
      console.log('[wellness] HC sync done, data keys:', Object.keys(data), '_hasLocalData:', _hasLocalData, 'displayData keys:', Object.keys(displayData));
      showSuccess('Health Connect synced');
    } catch (e) {
      showError('Health Connect sync failed: ' + (e.message || ''));
    }
    hcSyncing = false;
  }

  async function syncWorkouts() {
    if (!$workoutsEnabled) { console.log('[wellness] syncWorkouts skipped: not enabled'); return; }
    console.log('[wellness] syncWorkouts starting');
    try {
      const range = $wellnessSyncRange || 7;
      const end = new Date(dateStr + 'T12:00:00');
      const start = new Date(end);
      start.setDate(start.getDate() - (range - 1));
      await NtApi.post('/api/wellness/fitbit/workouts/sync', {
        from: start.toLocaleDateString('sv-SE'),
        to: dateStr,
      });
      await _pullWellnessToLocal();
      await loadWorkouts();
    } catch (e) {
      console.warn('[wellness] sync workouts failed:', e.message);
    }
  }

  function _openWorkout(w) {
    _selectedWorkout = w;
    _workoutGps = w.gps_data || null;
    _showWorkoutDetail = true;
    // Fetch GPS if has_gps but no cached data
    if (w.has_gps && !w.gps_data && w.source_id) {
      _loadGpsData(w);
    }
  }

  async function _loadGpsData(w) {
    _loadingGps = true;
    try {
      const result = await NtApi.post(`/api/wellness/fitbit/workouts/${w.source_id}/gps`);
      if (result.gps_data) {
        _workoutGps = result.gps_data;
        w.gps_data = result.gps_data;
      }
    } catch (e) {
      console.warn('[wellness] GPS fetch failed:', e.message);
    }
    _loadingGps = false;
  }

  function _workoutIcon(name) {
    const n = (name || '').toLowerCase();
    if (n.includes('run'))    return 'directions_run';
    if (n.includes('walk'))   return 'directions_walk';
    if (n.includes('hike'))   return 'hiking';
    if (n.includes('bike') || n.includes('cycl'))  return 'directions_bike';
    if (n.includes('swim'))   return 'pool';
    if (n.includes('yoga'))   return 'self_improvement';
    if (n.includes('weight') || n.includes('strength')) return 'fitness_center';
    if (n.includes('elliptical') || n.includes('cross')) return 'fitness_center';
    if (n.includes('tennis') || n.includes('basketball') || n.includes('soccer')) return 'sports_tennis';
    if (n.includes('dance'))  return 'nightlife';
    return 'exercise';
  }

  function _fmtDuration(ms) {
    if (!ms) return '0:00';
    const totalSec = Math.round(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    return `${m}:${String(s).padStart(2,'0')}`;
  }

  function _fmtWorkoutDist(km) {
    if (km == null) return '';
    const du = $distUnit || 'km';
    if (du === 'mi') return `${(km * 0.621371).toFixed(2)} mi`;
    return `${km.toFixed(2)} km`;
  }

  // ── Sleep Insights: Debt + Chronotype ─────────────────────────────────────
  let sleepInsightsRange = 14; // nights to look back for debt calculation
  let sleepDebt     = null;    // { debtMin, nights, goalMin } | null
  let chronotype    = null;    // { label, emoji, desc, midpointMin, nights } | { nights, needed } | null
  let _insightsLoaded = false;

  function _sleepMidpoint(startMin, endMin) {
    if (startMin == null || endMin == null) return null;
    // endMin may be less than startMin if sleep crosses midnight (e.g. start=22:30, end=06:45)
    const effectiveEnd = endMin < startMin ? endMin + 1440 : endMin;
    const mid = (startMin + effectiveEnd) / 2;
    return mid >= 1440 ? mid - 1440 : mid;
  }

  function _classifyChronotype(avgMidMin) {
    const h = avgMidMin / 60;
    if (h < 2.0) return { label: 'Early Bird',   emoji: '🌅', desc: 'You naturally wake early and feel most energized in the morning. Your body clock runs ahead of most — mornings are your prime time.' };
    if (h < 3.5) return { label: 'Morning Type',  emoji: '☀️', desc: 'You do your best work in the first half of the day and tend to wake up feeling refreshed. Most schedules suit you well.' };
    if (h < 5.0) return { label: 'Intermediate',  emoji: '⚖️', desc: 'Your body clock is well-aligned with typical schedules — you adapt easily between early mornings and late evenings.' };
    if (h < 6.5) return { label: 'Evening Type',  emoji: '🌆', desc: 'You come alive in the afternoon and evening. Mornings can be a challenge — your peak energy arrives later in the day.' };
    return        { label: 'Night Owl',           emoji: '🦉', desc: "Your body clock runs late. You're at your sharpest in the evening and may struggle with early alarms. Late nights feel natural." };
  }

  function fmtTimeMin(min) {
    if (min == null) return '—';
    const h    = Math.floor(min / 60) % 24;
    const m    = Math.round(min % 60);
    const ampm = h < 12 ? 'AM' : 'PM';
    const h12  = h === 0 ? 12 : h > 12 ? h - 12 : h;
    return `${h12}:${String(m).padStart(2,'0')} ${ampm}`;
  }

  async function loadSleepInsights() {
    const today   = new Date();
    const lookback = Math.max(sleepInsightsRange, 45); // 45d window: covers 30d debt + extra for chronotype
    const from    = new Date(today);
    from.setDate(from.getDate() - lookback + 1);
    const fromStr = from.toLocaleDateString('sv-SE');
    const toStr   = today.toLocaleDateString('sv-SE');

    let fitbitRows = {}, garminRows = {};
    if (isNative) {
      try { fitbitRows = await _getWellnessRange(null, fromStr, toStr); } catch {}
    } else {
      try { if ($fitbitEnabled)  fitbitRows  = await NtApi.get(`/api/wellness/fitbit/data?from=${fromStr}&to=${toStr}`); } catch {}
      try { if ($garminEnabled)  garminRows  = await NtApi.get(`/api/wellness/garmin/data?from=${fromStr}&to=${toStr}`); } catch {}
    }

    // Build merged per-date sleep records, most recent last
    const dates = [];
    const cur = new Date(fromStr + 'T12:00:00');
    while (cur <= today) {
      dates.push(cur.toLocaleDateString('sv-SE'));
      cur.setDate(cur.getDate() + 1);
    }
    const merged = dates.map(d => {
      const g = garminRows[d] || {}, f = fitbitRows[d] || {};
      return {
        sleep_duration_min: g.sleep_duration_min ?? f.sleep_duration_min ?? null,
        sleep_start_min:    g.sleep_start_min    ?? f.sleep_start_min    ?? null,
        sleep_end_min:      g.sleep_end_min      ?? f.sleep_end_min      ?? null,
      };
    });

    // Sleep Debt — last sleepInsightsRange nights
    const goalMin     = goals.get().sleep_duration_min?.min ?? 480;
    const debtNights  = merged.slice(-sleepInsightsRange);
    let   totalDebt   = 0, counted = 0;
    for (const n of debtNights) {
      if (n.sleep_duration_min != null) {
        totalDebt += Math.max(0, goalMin - n.sleep_duration_min);
        counted++;
      }
    }
    sleepDebt = counted > 0 ? { debtMin: Math.round(totalDebt), nights: counted, goalMin } : null;

    // Chronotype — average sleep midpoint across all available nights
    const midpoints = merged
      .map(n => _sleepMidpoint(n.sleep_start_min, n.sleep_end_min))
      .filter(v => v != null);
    if (midpoints.length >= 5) {
      const avg = midpoints.reduce((a, b) => a + b, 0) / midpoints.length;
      chronotype = { ..._classifyChronotype(avg), midpointMin: Math.round(avg), nights: midpoints.length };
    } else {
      chronotype = midpoints.length > 0 ? { label: null, nights: midpoints.length, needed: 5 } : null;
    }
    _insightsLoaded = true;
  }

  // ── Daily Readiness Score ─────────────────────────────────────────────────
  let readiness        = null;  // result obj | { data_days, needed } | null
  let _readinessLoaded = false;

  function _clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function _calcReadiness(todayHrv, todayRhr, todaySleepScore, todayCalories, history30d) {
    if (todayHrv == null) return null;

    const mean = arr => arr.reduce((a, b) => a + b, 0) / arr.length;

    // History-only HRV values for baseline (today excluded — including it is circular:
    // if today's HRV is low, it pulls the baseline down, making the ratio look better
    // than it is and inflating the score).
    const histHrvVals = history30d.map(d => d.hrv_daily_rmssd).filter(v => v != null);
    // Count today for the "do we have enough data?" threshold, but NOT in the mean.
    const totalHrvCount = histHrvVals.length + 1; // +1 = today
    if (totalHrvCount < 3) return { calibrating: true, data_days: histHrvVals.length, needed: 3 };
    if (histHrvVals.length < 2) return { calibrating: true, data_days: histHrvVals.length, needed: 3 };

    const hrvBaseline = mean(histHrvVals);
    const rhrVals     = [...history30d.map(d => d.resting_hr).filter(v => v != null), ...(todayRhr != null ? [todayRhr] : [])];
    const rhrBaseline = rhrVals.length >= 3 ? mean(rhrVals) : null;

    // HRV score (60% weight) — calibrated from ground-truth data.
    // Below-baseline penalty 250 — Fitbit penalizes even small HRV dips aggressively,
    // especially for low-HRV users where the ratio swings are small in absolute terms.
    const hrvRatio = todayHrv / hrvBaseline;
    // Square-root penalty curve — gentler on big HRV dips, steeper on small ones
    let hrv_score  = hrvRatio >= 1.0
      ? 65 + (hrvRatio - 1.0) * 100
      : 65 - Math.sqrt(1.0 - hrvRatio) * 55;
    hrv_score = _clamp(hrv_score, 0, 100);

    // RHR score (22% weight) — inverse: lower today is better. Neutral at 59.
    let rhr_score = 59; // neutral if no baseline
    if (rhrBaseline != null && todayRhr != null) {
      const rhrRatio = rhrBaseline / todayRhr;
      rhr_score = 59 + (rhrRatio - 1.0) * 110;
      rhr_score = _clamp(rhr_score, 0, 100);
    }

    // HRV × RHR interaction penalty — when both signals go wrong together
    let interaction_penalty = 0;
    if (hrvRatio < 1.0 && rhrBaseline != null && todayRhr != null && todayRhr > rhrBaseline) {
      interaction_penalty = (1.0 - hrvRatio) * (todayRhr - rhrBaseline) * 35;
      interaction_penalty = _clamp(interaction_penalty, 0, 10);
    }

    // Sleep score used for contribution (15% weight)
    const sleepBase = todaySleepScore != null ? todaySleepScore : 75;
    const sleep_cap = (todaySleepScore != null && todaySleepScore < 50) ? 65 : 100;

    // Activity penalty — only when today spikes above 7d rolling avg
    const calHistory7 = history30d.slice(-7).map(d => d.calories_out).filter(v => v != null);
    let activity_penalty = 0;
    if (calHistory7.length >= 3 && todayCalories != null) {
      const calMean    = mean(calHistory7);
      const spikeRatio = todayCalories / calMean;
      if (spikeRatio > 1.25) activity_penalty += (spikeRatio - 1.25) * 40;
      // Multi-day accumulation
      const daysAbove = history30d.slice(-3).filter(d => d.calories_out != null && d.calories_out > calMean * 1.1).length;
      activity_penalty += daysAbove * 3;
      activity_penalty = _clamp(activity_penalty, 0, 20);
    }

    let score = (0.58 * hrv_score) + (0.22 * rhr_score) + (0.12 * sleepBase) - activity_penalty - interaction_penalty;
    score     = Math.min(_clamp(Math.round(score), 1, 100), sleep_cap);

    const label = score >= 80 ? 'Optimal' : score >= 65 ? 'Good' : score >= 50 ? 'Fair' : score >= 35 ? 'Low' : 'Poor';
    const color = score >= 65 ? 'var(--accent)' : score >= 50 ? '#f59e0b' : '#ef4444';

    console.debug('[readiness]', JSON.stringify({
      inputs: { todayHrv, todayRhr, todaySleepScore, todayCalories, historyDays: history30d.length },
      baselines: { hrvBaseline: Math.round(hrvBaseline * 100) / 100, rhrBaseline: rhrBaseline != null ? Math.round(rhrBaseline * 10) / 10 : null },
      components: { hrvRatio: Math.round(hrvRatio * 1000) / 1000, hrv_score: Math.round(hrv_score * 10) / 10, rhr_score: Math.round(rhr_score * 10) / 10, sleepBase, activity_penalty: Math.round(activity_penalty * 10) / 10, interaction_penalty: Math.round(interaction_penalty * 10) / 10 },
      formula: `(0.58×${Math.round(hrv_score*10)/10}) + (0.22×${Math.round(rhr_score*10)/10}) + (0.12×${sleepBase}) - ${Math.round(activity_penalty*10)/10} - ${Math.round(interaction_penalty*10)/10} = ${score}`,
    }, null, 2));

    return {
      score, label, color,
      hrv_score:        Math.round(hrv_score),
      rhr_score:        Math.round(rhr_score),
      sleep_score_used: Math.round(sleepBase),
      activity_penalty:     Math.round(activity_penalty),
      interaction_penalty:  Math.round(interaction_penalty),
      hrv_baseline:         Math.round(hrvBaseline * 10) / 10,
      rhr_baseline:         rhrBaseline != null ? Math.round(rhrBaseline) : null,
      data_days:            totalHrvCount,
    };
  }

  async function recalculateScores() {
    try {
      const result = await NtApi.post('/api/wellness/fitbit/recalculate', {});
      showSuccess(`Recalculated: readiness=${result.readiness_score}, stress=${result.stress_score}`);
      // Reload data to pick up new scores
      _readinessLoaded = false;
      _stressLoaded = false;
      loadData();
    } catch (e) {
      showError('Recalculate failed: ' + (e.message || ''));
    }
  }

  async function loadReadiness() {
    _readinessLoaded = true;
    const today   = new Date();
    const from    = new Date(today);
    from.setDate(from.getDate() - 30);
    const fromStr = from.toLocaleDateString('sv-SE');
    const toStr   = today.toLocaleDateString('sv-SE');

    const dates = [];
    const cur   = new Date(fromStr + 'T12:00:00');
    while (cur <= today) { dates.push(cur.toLocaleDateString('sv-SE')); cur.setDate(cur.getDate() + 1); }

    let fitbitRows = {}, garminRows = {};
    try { if ($fitbitEnabled) fitbitRows = await NtApi.get(`/api/wellness/fitbit/data?from=${fromStr}&to=${toStr}`); } catch {}
    try { if ($garminEnabled) garminRows = await NtApi.get(`/api/wellness/garmin/data?from=${fromStr}&to=${toStr}`); } catch {}

    // History = all days EXCEPT today (today's values come from displayData)
    const history = dates.slice(0, -1).map(d => {
      const g = garminRows[d] || {}, f = fitbitRows[d] || {};
      return {
        hrv_daily_rmssd: g.hrv_daily_rmssd ?? f.hrv_daily_rmssd ?? null,
        resting_hr:      g.resting_hr      ?? f.resting_hr      ?? null,
        calories_out:    g.calories_out    ?? f.calories_out    ?? null,
      };
    });

    // Use yesterday's calories for the activity penalty — today's are still
    // accumulating and would misfire in the afternoon when the count gets high.
    // Readiness reflects recovery from past effort, not today's ongoing effort.
    const yesterdayCalories = history.length > 0
      ? (history[history.length - 1].calories_out ?? null)
      : null;

    // Past days: use server-stored snapshot (locked in at sync time).
    // Today: always calculate live so score updates as data arrives.
    // Always compute the breakdown for display
    readiness = _calcReadiness(
      displayData.hrv_daily_rmssd,
      displayData.resting_hr,
      displayData.sleep_score,
      yesterdayCalories,
      history
    );
    // If a stored (locked-in) score exists, use it as the displayed score
    if (displayData.readiness_score != null) {
      const s = Math.round(displayData.readiness_score);
      readiness = { ...readiness, score: s, stored: true };
      readiness.label = s >= 80 ? 'Optimal' : s >= 65 ? 'Good' : s >= 50 ? 'Fair' : s >= 35 ? 'Low' : 'Poor';
      readiness.color = s >= 65 ? 'var(--accent)' : s >= 50 ? '#f59e0b' : '#ef4444';
    }
  }

  $: { activeTab; if (activeTab === 'heart') _readinessLoaded = false; }
  $: if (activeTab === 'heart' && !_readinessLoaded) loadReadiness();

  // ── Stress Management Score ───────────────────────────────────────────────
  // Reverse-engineered from Fitbit's model using 6 ground-truth data points.
  // Key difference from readiness: sleep weighted more heavily, HRV gentler,
  // and exponential smoothing (0.65 × prev_computed + 0.35 × raw) which is
  // why the score moves slowly day-to-day. The smoothing chain is computed
  // over 30 days of history so no prior score storage is needed.
  let stressScore      = null;
  let _stressLoaded    = false;

  function _rawStressScore(hrv, rhr, sleepScore, hrvBaseline, rhrBaseline) {
    if (hrv == null) return null;
    // HRV component — symmetric, gentler than readiness (±120 per ratio unit vs ±220/80)
    const hrvRatio = hrv / hrvBaseline;
    let hrv_s = 75 + (hrvRatio - 1.0) * 120;
    hrv_s = _clamp(hrv_s, 0, 100);
    // RHR component — mild modifier
    let rhr_s = 75;
    if (rhrBaseline != null && rhr != null) {
      rhr_s = 75 + (rhrBaseline / rhr - 1.0) * 80;
      rhr_s = _clamp(rhr_s, 0, 100);
    }
    // Sleep component — stronger weight than readiness (35% vs 15%)
    const sleep_s = sleepScore != null ? sleepScore : 75;
    return (0.35 * hrv_s) + (0.40 * sleep_s) + (0.15 * rhr_s) + 4; // offset 4 — tuned with 11 days of data
  }

  function _calcStressScore(todayHrv, todayRhr, todaySleepScore, history30d) {
    if (todayHrv == null) return null;

    const mean = arr => arr.reduce((a, b) => a + b, 0) / arr.length;

    // Same separation as readiness: history-only baseline, today counted for threshold only.
    const histHrvVals  = history30d.map(d => d.hrv_daily_rmssd).filter(v => v != null);
    const totalHrvCount = histHrvVals.length + 1;
    if (totalHrvCount < 3 || histHrvVals.length < 2) return { calibrating: true, data_days: histHrvVals.length, needed: 3 };

    const hrvBaseline = mean(histHrvVals);
    const rhrVals     = [...history30d.map(d => d.resting_hr).filter(v => v != null), ...(todayRhr != null ? [todayRhr] : [])];
    const rhrBaseline = rhrVals.length >= 3 ? mean(rhrVals) : null;

    // Build smoothed score chain over history (oldest → newest)
    // Seed from first day with enough data — no stored scores needed.
    let smoothed = null;
    for (const d of history30d) {
      const raw = _rawStressScore(d.hrv_daily_rmssd, d.resting_hr, d.sleep_score, hrvBaseline, rhrBaseline);
      if (raw == null) continue;
      smoothed = smoothed == null ? raw : 0.50 * smoothed + 0.50 * raw;
    }

    // Today's score
    const todayRaw = _rawStressScore(todayHrv, todayRhr, todaySleepScore, hrvBaseline, rhrBaseline);
    if (todayRaw == null) return null;
    const score = Math.round(_clamp(
      smoothed != null ? 0.50 * smoothed + 0.50 * todayRaw : todayRaw,
      1, 100
    ));

    // Fitbit: higher = better managed (less stressed)
    const label = score >= 80 ? 'Well managed' : score >= 65 ? 'Balanced' : score >= 50 ? 'Moderate' : score >= 35 ? 'Elevated' : 'High';
    const color = score >= 65 ? 'var(--accent)' : score >= 50 ? '#f59e0b' : '#ef4444';

    console.debug('[stress]', JSON.stringify({
      inputs: { todayHrv, todayRhr, todaySleepScore, historyDays: history30d.length },
      baselines: { hrvBaseline: Math.round(hrvBaseline * 100) / 100, rhrBaseline: rhrBaseline != null ? Math.round(rhrBaseline * 10) / 10 : null },
      todayRaw: Math.round(todayRaw * 10) / 10,
      smoothedHistory: smoothed != null ? Math.round(smoothed * 10) / 10 : null,
      formula: smoothed != null ? `0.50×${Math.round(smoothed*10)/10} + 0.50×${Math.round(todayRaw*10)/10} = ${score}` : `raw=${Math.round(todayRaw*10)/10} → ${score}`,
    }, null, 2));

    return {
      score, label, color,
      hrv_baseline: Math.round(hrvBaseline * 10) / 10,
      rhr_baseline: rhrBaseline != null ? Math.round(rhrBaseline) : null,
      data_days:    totalHrvCount,
    };
  }

  async function loadStressScore() {
    _stressLoaded = true;
    const today = new Date();
    const from  = new Date(today);
    from.setDate(from.getDate() - 30);
    const fromStr = from.toLocaleDateString('sv-SE');
    const toStr   = today.toLocaleDateString('sv-SE');

    const dates = [];
    const cur   = new Date(fromStr + 'T12:00:00');
    while (cur <= today) { dates.push(cur.toLocaleDateString('sv-SE')); cur.setDate(cur.getDate() + 1); }

    let fitbitRows = {}, garminRows = {};
    try { if ($fitbitEnabled) fitbitRows = await NtApi.get(`/api/wellness/fitbit/data?from=${fromStr}&to=${toStr}`); } catch {}
    try { if ($garminEnabled) garminRows = await NtApi.get(`/api/wellness/garmin/data?from=${fromStr}&to=${toStr}`); } catch {}

    const history = dates.slice(0, -1).map(d => {
      const g = garminRows[d] || {}, f = fitbitRows[d] || {};
      return {
        hrv_daily_rmssd: g.hrv_daily_rmssd ?? f.hrv_daily_rmssd ?? null,
        resting_hr:      g.resting_hr      ?? f.resting_hr      ?? null,
        sleep_score:     g.sleep_score     ?? f.sleep_score     ?? null,
      };
    });

    stressScore = _calcStressScore(
      displayData.hrv_daily_rmssd,
      displayData.resting_hr,
      displayData.sleep_score,
      history
    );
    if (displayData.stress_score != null) {
      const s = Math.round(displayData.stress_score);
      stressScore = { ...stressScore, score: s, stored: true };
      stressScore.label = s >= 80 ? 'Excellent' : s >= 60 ? 'Good' : s >= 40 ? 'Fair' : 'Low';
      stressScore.color = s >= 60 ? 'var(--accent)' : s >= 40 ? '#f59e0b' : '#ef4444';
    }
  }

  $: { activeTab; if (activeTab === 'heart') _stressLoaded = false; }
  $: if (activeTab === 'heart' && !_stressLoaded) loadStressScore();

  // ── 7-day sparklines ───────────────────────────────────────────────────────
  let _sparklineData = {}; // { [metricId]: (number|null)[] } — 7 values, oldest first

  async function loadSparklines() {
    const today   = new Date();
    const from    = new Date(today);
    from.setDate(from.getDate() - 6);
    const fromStr = from.toLocaleDateString('sv-SE');
    const toStr   = today.toLocaleDateString('sv-SE');
    const dates   = [];
    const cur     = new Date(fromStr + 'T12:00:00');
    while (cur <= today) { dates.push(cur.toLocaleDateString('sv-SE')); cur.setDate(cur.getDate() + 1); }

    let fitbitRange = {}, garminRange = {};
    if (isNative) {
      try { fitbitRange = await _getWellnessRange(null, fromStr, toStr); } catch {}
    } else {
      try { if ($fitbitEnabled)  fitbitRange  = await NtApi.get(`/api/wellness/fitbit/data?from=${fromStr}&to=${toStr}`); } catch {}
      try { if ($garminEnabled)  garminRange  = await NtApi.get(`/api/wellness/garmin/data?from=${fromStr}&to=${toStr}`); } catch {}
    }

    const result = {};
    for (const m of ALL_METRICS) {
      result[m.id] = dates.map(d => garminRange[d]?.[m.id] ?? fitbitRange[d]?.[m.id] ?? null);
    }
    _sparklineData = result;
  }

  // Tiny SVG sparkline path from an array of values (nulls = gaps)
  function sparklinePath(vals, w = 56, h = 24) {
    const pts = vals.map((v, i) => v != null ? [i, v] : null).filter(Boolean);
    if (pts.length < 2) return '';
    const xMax   = vals.length - 1;
    const ys     = pts.map(p => p[1]);
    const yMin   = Math.min(...ys), yMax = Math.max(...ys);
    const yRange = yMax - yMin || 1;
    const toX    = i => (i / xMax) * w;
    const toY    = v => h - ((v - yMin) / yRange) * (h - 4) - 2;
    return pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${toX(p[0]).toFixed(1)},${toY(p[1]).toFixed(1)}`).join(' ');
  }

  // Mark insights stale when tab activates or range changes (so the next check loads them)
  $: { sleepInsightsRange; activeTab; if (activeTab === 'sleep') _insightsLoaded = false; }
  // Load whenever stale and on sleep tab (also fires after syncs set _insightsLoaded = false)
  $: if (activeTab === 'sleep' && !_insightsLoaded) loadSleepInsights();

  // ── Integration availability ───────────────────────────────────────────────
  import { healthConnectEnabled, workoutsEnabled } from '../stores/settings.js';
  $: fitbitAvailable   = $fitbitEnabled;
  $: withingsAvailable = $withingsEnabled;
  $: garminAvailable   = $garminEnabled;
  $: healthConnectAvailable = isNative && $healthConnectEnabled;
  $: anyAvailable      = fitbitAvailable || withingsAvailable || garminAvailable || healthConnectAvailable;

  // Sliding pill: ordered list of visible tabs + active index
  // Garmin contributes to movement/sleep/heart tabs alongside Fitbit
  $: _wlTabList = [
    ...(fitbitAvailable || garminAvailable || healthConnectAvailable ? ['movement', 'sleep', 'heart'] : []),
    ...(withingsAvailable ? ['body'] : []),
  ];
  $: _wlActiveIdx  = Math.max(0, _wlTabList.indexOf(activeTab));
  // Pill position: measure actual tab button positions for pixel-perfect alignment
  let _tabBarEl = null;
  let _wlPillWidth = '25%';
  let _wlPillLeft = '0px';
  function _updatePill() {
    if (!_tabBarEl) return;
    const buttons = _tabBarEl.querySelectorAll('.tab-btn');
    if (!buttons.length || _wlActiveIdx >= buttons.length) return;
    const btn = buttons[_wlActiveIdx];
    const barRect = _tabBarEl.getBoundingClientRect();
    _wlPillLeft = `${btn.offsetLeft}px`;
    _wlPillWidth = `${btn.offsetWidth}px`;
  }
  $: if (_wlActiveIdx >= 0 && _tabBarEl) { tick().then(_updatePill); }
  onMount(() => { tick().then(_updatePill); window.addEventListener('resize', _updatePill); });
  onDestroy(() => { window.removeEventListener('resize', _updatePill); });

  // Auto-correct activeTab when an integration's availability changes
  $: if (status !== null && withingsStatus !== null && garminStatus !== null) {
    const isActivityTab = activeTab === 'movement' || activeTab === 'sleep' || activeTab === 'heart';
    if (isActivityTab && !fitbitAvailable && !garminAvailable && !healthConnectAvailable) activeTab = withingsAvailable ? 'body' : 'movement';
    if (activeTab === 'body' && !withingsAvailable && !healthConnectAvailable) activeTab = (fitbitAvailable || garminAvailable || healthConnectAvailable) ? 'movement' : 'body';
  }

  // ── Date navigation ────────────────────────────────────────────────────────
  function prevDay() {
    const d = new Date(dateStr + 'T12:00:00');
    d.setDate(d.getDate() - 1);
    dateStr = d.toLocaleDateString('sv-SE');
    loadData();
  }
  function nextDay() {
    const d = new Date(dateStr + 'T12:00:00');
    d.setDate(d.getDate() + 1);
    dateStr = d.toLocaleDateString('sv-SE');
    loadData();
  }
  $: isToday = dateStr === localDateStr();

  function fmtDate(ds) {
    if (!ds) return '';
    const dt   = new Date(ds + 'T12:00:00');
    const today = localDateStr();
    const yest  = (() => { const d = new Date(Date.now() - 86400000); return localDateStr(d); })();
    if (ds === today) return 'Today';
    if (ds === yest)  return 'Yesterday';
    return dt.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  }

  function fmtDateSub(ds) {
    if (!ds) return '';
    const dt  = new Date(ds + 'T12:00:00');
    const fmt = $dateFormat || 'ISO';
    if (fmt === 'US') {
      const m  = String(dt.getMonth()+1).padStart(2,'0');
      const dy = String(dt.getDate()).padStart(2,'0');
      return m + '/' + dy + '/' + dt.getFullYear();
    } else if (fmt === 'EU') {
      const m  = String(dt.getMonth()+1).padStart(2,'0');
      const dy = String(dt.getDate()).padStart(2,'0');
      return dy + '/' + m + '/' + dt.getFullYear();
    }
    return ds;
  }

  // ── Calendar / date picker ─────────────────────────────────────────────────
  let showDatePicker  = false;
  let pickerDate      = '';
  let calYear         = new Date().getFullYear();
  let calMonth        = new Date().getMonth();
  let showYearPicker  = false;
  let showMonthPicker = false;
  let _sheetLock = false;
  let _sheetLockTimer;

  $: calFirstDay    = new Date(calYear, calMonth, 1).getDay();
  $: calDaysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
  $: calAtMax = (() => { const n = new Date(); return calYear > n.getFullYear() + 1 || (calYear === n.getFullYear() + 1 && calMonth > n.getMonth()); })();
  $: calMonthName   = new Date(calYear, calMonth, 1).toLocaleDateString(undefined, { month: 'long' });
  $: yearRange      = Array.from({length: 22}, (_, i) => (new Date().getFullYear() - 10) + i);
  const monthNames  = [
    {idx:0,short:'Jan'},{idx:1,short:'Feb'},{idx:2,short:'Mar'},
    {idx:3,short:'Apr'},{idx:4,short:'May'},{idx:5,short:'Jun'},
    {idx:6,short:'Jul'},{idx:7,short:'Aug'},{idx:8,short:'Sep'},
    {idx:9,short:'Oct'},{idx:10,short:'Nov'},{idx:11,short:'Dec'},
  ];

  function _lockAndOpen(setter) {
    clearTimeout(_sheetLockTimer);
    _sheetLock = true;
    setter();
    _sheetLockTimer = setTimeout(() => _sheetLock = false, 400);
  }

  function calPrevMonth() {
    showYearPicker = false; showMonthPicker = false;
    if (calMonth === 0) { calMonth = 11; calYear--; } else calMonth--;
  }
  function calNextMonth() {
    showYearPicker = false; showMonthPicker = false;
    if (calAtMax) return;
    if (calMonth === 11) { calMonth = 0; calYear++; } else calMonth++;
  }

  function openDatePicker() {
    const dt = new Date(dateStr + 'T12:00:00');
    calYear  = dt.getFullYear();
    calMonth = dt.getMonth();
    pickerDate = dateStr;
    _lockAndOpen(() => showDatePicker = true);
  }

  function goToDate() {
    let iso = null;
    if (pickerDate) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(pickerDate)) {
        iso = pickerDate;
      } else if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(pickerDate)) {
        const [m,d,y] = pickerDate.split('/');
        iso = y + '-' + m.padStart(2,'0') + '-' + d.padStart(2,'0');
      }
    }
    if (iso) {
      dateStr = iso;
      loadData();
      showDatePicker = false;
    } else if (!pickerDate) {
      showDatePicker = false;
    }
  }

  // ── Init ───────────────────────────────────────────────────────────────────
  async function init() {
    if (isNative) {
      // Native: load cached data IMMEDIATELY — don't wait for server status checks
      await loadLocalWellnessData();
      // Set defaults so template doesn't show loading spinner
      if (!status) status = { connected: false, configured: false };
      if (!withingsStatus) withingsStatus = { connected: false, configured: false };
      if (!garminStatus) garminStatus = { connected: false, configured: false };

      // Check server status in background — updates UI if connected
      _initServerStatus();
      return;
    }

    // PWA: sequential status checks then load
    try {
      status = await NtApi.get('/api/wellness/fitbit/status');
    } catch { status = { connected: false, configured: false }; }

    await initWithings();
    await initGarmin();

    if (status.connected || garminStatus?.connected) {
      await loadData(); // loadData already calls loadWorkouts()
      if ($wellnessSyncMode === 'auto' && isToday) {
        const key = `wl_wellness_lastSync_${dateStr}`;
        const last = localStorage.getItem(key);
        const cooldownMs = 15 * 60 * 1000;
        if (!last || Date.now() - Number(last) > cooldownMs) {
          if (status.connected)       { await sync(true); syncWorkouts(); }
          if (garminStatus?.connected) await syncGarmin(true);
        }
      }
    } else {
      loadingData = false;
    }
  }

  /** Native: check server status in background and auto-sync if connected */
  async function _initServerStatus() {
    try {
      status = await NtApi.get('/api/wellness/fitbit/status');
    } catch { status = { connected: false, configured: false }; }
    try {
      withingsStatus = await NtApi.get('/api/wellness/withings/status');
    } catch { withingsStatus = { connected: false, configured: false }; }
    try {
      garminStatus = await NtApi.get('/api/wellness/garmin/status');
    } catch { garminStatus = { connected: false, configured: false }; }

    // Auto-sync if connected and due
    const anyConnected = status.connected || garminStatus?.connected;
    if (anyConnected && $wellnessSyncMode === 'auto' && isToday) {
      const key = `wl_wellness_lastSync_${dateStr}`;
      const last = localStorage.getItem(key);
      const cooldownMs = 15 * 60 * 1000;
      if (!last || Date.now() - Number(last) > cooldownMs) {
        if (status.connected)       await sync(true);
        if (garminStatus?.connected) await syncGarmin(true);
      }
    }
  }

  /** Load wellness data from local SQLite (native only) — works offline */
  async function loadLocalWellnessData() {
    loadingData = true;
    try {
      const { dbGetWellnessGrouped } = await import('../lib/db-native.js');
      // Load each source separately so we can populate the right state vars
      const [fitbitData, garminLocal, withingsLocal, hcData] = await Promise.all([
        dbGetWellnessGrouped(dateStr, dateStr, 'fitbit'),
        dbGetWellnessGrouped(dateStr, dateStr, 'garmin'),
        dbGetWellnessGrouped(dateStr, dateStr, 'withings'),
        dbGetWellnessGrouped(dateStr, dateStr, 'health_connect'),
      ]);
      data = { ...(hcData[dateStr] || {}), ...(fitbitData[dateStr] || {}) };
      garminData = garminLocal[dateStr] || {};
      withingsData = withingsLocal[dateStr] || {};
      _hasLocalData = Object.keys(data).length > 0 || Object.keys(garminData).length > 0 || Object.keys(withingsData).length > 0;
    } catch (e) {
      console.warn('[wellness] local load failed:', e.message);
    }
    _checkWellnessGoals({ ...garminData, ...data }, withingsData);
    loadingData = false;
    if (activeTab === 'heart') { _readinessLoaded = false; _stressLoaded = false; }
    loadSparklines();
    loadWorkouts();
  }

  /** After a server-side wellness sync (Fitbit/Garmin/Withings), pull new data into local SQLite */
  async function _pullWellnessToLocal() {
    if (!isNative) return;
    try {
      const { fullSync } = await import('../lib/sync.js');
      await fullSync(true); // silent pull — gets new wellness_data rows into local SQLite
    } catch (e) {
      console.warn('[wellness] pull after sync failed:', e.message);
    }
  }

  async function loadData() {
    loadingData = true;
    // On native: load from local SQLite (includes all synced data)
    if (isNative) {
      await loadLocalWellnessData();
      return;
    }
    try {
      const byDate = await NtApi.get(`/api/wellness/fitbit/data?date=${dateStr}`);
      data = byDate[dateStr] || {};
    } catch { data = {}; }
    await loadWithingsData();
    await loadGarminData();
    _checkWellnessGoals({ ...garminData, ...data }, withingsData);
    loadingData = false;
    // Refresh readiness + stress if on heart tab (today's values just changed)
    if (activeTab === 'heart') { _readinessLoaded = false; _stressLoaded = false; }
    // Load sparklines in background (not awaited — don't block date display)
    loadSparklines();
    loadWorkouts();
  }

  async function sync(silent = false) {
    if (syncing) return;
    syncing = true;
    try {
      const range = $wellnessSyncRange || 1;
      let result;
      if (!silent && range > 1) {
        // Manual sync with range: fetch from (dateStr - range + 1) to dateStr
        const end   = new Date(dateStr + 'T12:00:00');
        const start = new Date(end);
        start.setDate(start.getDate() - (range - 1));
        const from = start.toLocaleDateString('sv-SE');
        result = await NtApi.post('/api/wellness/fitbit/sync', { from, to: dateStr });
        await _pullWellnessToLocal();
        await loadData(); // reload displayed date from DB after range sync
        lastSync = new Date();
        localStorage.setItem(`wl_wellness_lastSync_${dateStr}`, String(Date.now()));
        const msg = result.rateLimited
          ? `Synced ${result.synced} days (rate limited — try again later for the rest)`
          : `Synced ${result.synced} day${result.synced === 1 ? '' : 's'}`;
        showSuccess(msg);
      } else {
        // Auto-sync or 1-day range: single day
        result = await NtApi.post('/api/wellness/fitbit/sync', { date: dateStr });
        await _pullWellnessToLocal();
        if (isNative) {
          await loadData();
        } else {
          const newData = result.metrics || {};
          _checkWellnessGoals(newData, withingsData);
          data = newData;
        }
        lastSync = new Date();
        localStorage.setItem(`wl_wellness_lastSync_${dateStr}`, String(Date.now()));
        if (!silent) showSuccess('Synced');
      }
    } catch (e) {
      if (!silent) {
        if (e.message?.includes('revoked') || e.message?.includes('Not connected') || e.status === 401) {
          showError('Fitbit disconnected — reconnect in Settings → Wellness');
          status = { ...status, connected: false };
        } else {
          showError('Fitbit sync failed: ' + e.message);
        }
      }
    }
    syncing = false;
    syncWorkouts(); // fetch workout activity logs alongside metrics
    _insightsLoaded  = false;
    _readinessLoaded = false;
    _stressLoaded    = false;
  }

  async function connect() {
    connecting = true;
    try {
      const { url } = await NtApi.get('/api/wellness/fitbit/authorize' + (isNative ? '?native=1' : ''));
      if (isNative) {
        const { openOAuth } = await import('../lib/oauth-native.js');
        await openOAuth(url);
      } else {
        window.location.href = url;
      }
    } catch (e) {
      showError(e.message || 'Could not start Fitbit authorization');
      connecting = false;
    }
  }

  async function disconnect() {
    try {
      await NtApi.del('/api/wellness/fitbit/disconnect');
      status = { ...status, connected: false };
      data = {};
      showSuccess('Disconnected from Fitbit');
    } catch (e) { showError(e.message); }
  }

  onMount(() => {
    // Post-OAuth redirect: signal is in window.location.search (before the #)
    // so the router always lands on /wellness correctly regardless of query params
    const params = new URLSearchParams(window.location.search);
    if (params.get('fitbit') === 'connected') {
      history.replaceState({}, '', '/#/wellness');
      showSuccess('Fitbit connected!');
    } else if (params.get('fitbit') === 'error') {
      showError('Fitbit: ' + (params.get('msg') || 'Authorization failed'));
      history.replaceState({}, '', '/#/wellness');
    } else if (params.get('withings') === 'connected') {
      history.replaceState({}, '', '/#/wellness');
      showSuccess('Withings connected!');
    } else if (params.get('withings') === 'error') {
      showError('Withings: ' + (params.get('msg') || 'Authorization failed'));
      history.replaceState({}, '', '/#/wellness');
    } else if (params.get('garmin') === 'connected') {
      history.replaceState({}, '', '/#/wellness');
      showSuccess('Garmin connected!');
    } else if (params.get('garmin') === 'error') {
      showError('Garmin: ' + (params.get('msg') || 'Authorization failed'));
      history.replaceState({}, '', '/#/wellness');
    }
    init();

    // On native: reload wellness data when background sync completes
    if (isNative) {
      _syncCompleteHandler = () => {
        loadLocalWellnessData();
      };
      window.addEventListener('nt:sync-complete', _syncCompleteHandler);
    }
  });

  let _syncCompleteHandler = null;
  onDestroy(() => {
    if (_syncCompleteHandler) window.removeEventListener('nt:sync-complete', _syncCompleteHandler);
  });

  // ── Goal celebrations ─────────────────────────────────────────────────────
  let _celebratingMetrics = new Set();
  let _prevCombinedData = null;

  // Check all wellness metrics (fitbit + withings merged) against goals
  function _checkWellnessGoals(fitbitData, withingsData_) {
    if (!$goalCelebrations || $disableAnimations) return;
    // Merge sources into one flat map of id → value
    const combined = { ...fitbitData };
    for (const [key, val] of Object.entries(withingsData_)) {
      combined[key] = val; // withingsData values are already raw numbers
    }
    const g = goals.get();
    for (const id of Object.keys(g)) {
      const goal = g[id]?.min;
      if (!goal) continue;
      const prev = _prevCombinedData?.[id];
      const curr = combined[id];
      if (curr != null && curr >= goal && (prev == null || prev < goal)) {
        _celebratingMetrics = new Set([..._celebratingMetrics, id]);
        setTimeout(() => {
          _celebratingMetrics = new Set([..._celebratingMetrics].filter(x => x !== id));
        }, 1200);
      }
    }
    _prevCombinedData = { ...combined };
  }

  // ── Merged display data: only include data from enabled integrations ─────────
  $: displayData = (() => {
    const merged = {};
    if ($garminEnabled || (isNative && Object.keys(garminData).length)) {
      for (const [k, v] of Object.entries(garminData)) {
        if (v != null) merged[k] = v;
      }
    }
    if ($fitbitEnabled || (isNative && Object.keys(data).length)) {
      for (const [k, v] of Object.entries(data)) {
        if (v != null) {
          // Garmin sleep_score is device-measured; don't let Fitbit's estimate overwrite it
          if (k === 'sleep_score' && merged[k] != null) continue;
          merged[k] = v;
        }
      }
    }
    return merged;
  })();

  // ── Sleep stage breakdown ──────────────────────────────────────────────────
  $: sleepTotal = (displayData.sleep_deep_min || 0) + (displayData.sleep_light_min || 0) + (displayData.sleep_rem_min || 0) + (displayData.sleep_wake_min || 0);
  $: sleepStages = [
    { label: 'Deep',  key: 'sleep_deep_min',  color: '#6366f1' },
    { label: 'REM',   key: 'sleep_rem_min',   color: '#8b5cf6' },
    { label: 'Light', key: 'sleep_light_min', color: '#06b6d4' },
    { label: 'Awake', key: 'sleep_wake_min',  color: '#f59e0b' },
  ];
</script>

<div class="page-shell wl-shell">
  <!-- Header -->
  <header class="page-header" class:has-banner={$pageBanners}>
    {#if $pageBanners}<WellnessBanner />{/if}
    <h1>Wellness</h1>
  </header>

  <!-- Fixed sync buttons — portalled to body so position:fixed is viewport-relative -->
  <div class="wl-topbar-actions" use:portal>
    {#if $healthConnectEnabled && isNative}
      <button class="wl-sync-icon-btn" class:wl-syncing={hcSyncing}
        on:click={syncHealthConnectManual} disabled={hcSyncing}
        title="Sync Health Connect">
        {#if hcSyncing}
          <span class="material-symbols-rounded wl-spin-icon">sync</span>
        {:else}
          <span class="wl-brand-icon"><HealthConnectIcon /></span>
        {/if}
      </button>
    {/if}
    {#if status?.connected}
      <button class="wl-sync-icon-btn" class:wl-syncing={syncing}
        on:click={() => sync()} disabled={syncing}
        title="Sync Fitbit{status.fitbitUserId ? ' · ' + status.fitbitUserId : ''}">
        {#if syncing}
          <span class="material-symbols-rounded wl-spin-icon">sync</span>
        {:else}
          <span class="wl-brand-icon"><FitbitIcon /></span>
        {/if}
      </button>
    {/if}
    {#if garminStatus?.connected}
      <button class="wl-sync-icon-btn" class:wl-syncing={garminSyncing}
        on:click={() => syncGarmin()} disabled={garminSyncing}
        title="Sync Garmin{garminStatus.garminUserId ? ' · ' + garminStatus.garminUserId : ''}">
        {#if garminSyncing}
          <span class="material-symbols-rounded wl-spin-icon">sync</span>
        {:else}
          <span class="wl-brand-icon"><GarminIcon /></span>
        {/if}
      </button>
    {/if}
    {#if withingsStatus?.connected}
      <button class="wl-sync-icon-btn" class:wl-syncing={withingsSyncing}
        on:click={() => syncWithings()} disabled={withingsSyncing}
        title="Sync Withings{withingsStatus.withingsUserId ? ' · User ' + withingsStatus.withingsUserId : ''}">
        {#if withingsSyncing}
          <span class="material-symbols-rounded wl-spin-icon">sync</span>
        {:else}
          <span class="wl-brand-icon"><WithingsIcon /></span>
        {/if}
      </button>
    {/if}
  </div>

  <!-- Date navigation sub-bar — sticky below header, same pattern as Diary -->
  <div class="wl-date-bar" class:has-banner={$pageBanners}>
    <button class="btn-icon accent" on:click={prevDay} aria-label="Previous day" title="Previous day">
      <span class="material-symbols-rounded">chevron_left</span>
    </button>
    <button class="date-btn" on:click={openDatePicker} title="Jump to date">
      <span class="date-label">{fmtDate(dateStr)}</span>
      <span class="date-sub">{fmtDateSub(dateStr)}</span>
    </button>
    <button class="btn-icon accent" on:click={nextDay} disabled={isToday} aria-label="Next day" title="Next day">
      <span class="material-symbols-rounded">chevron_right</span>
    </button>
  </div>

  <div class="page-content wl-content">

    <!-- ── Loading ── -->
    {#if !status || !withingsStatus}
      <div class="wellness-loading">
        <span class="material-symbols-rounded spin">sync</span>
      </div>

    <!-- ── Nothing configured ── -->
    {:else if !anyAvailable}
      <div class="connect-card">
        <div class="connect-icon-wrap">
          <span class="material-symbols-rounded connect-icon">monitor_heart</span>
        </div>
        <h2 class="connect-title">No integrations enabled</h2>
        <p class="connect-desc">
          Enable Fitbit or Withings in <strong>Settings → Wellness</strong> to start syncing health data.
        </p>
        <div class="connect-chips">
          <span class="connect-chip"><span class="material-symbols-rounded">directions_walk</span> Activity</span>
          <span class="connect-chip"><span class="material-symbols-rounded">bedtime</span> Sleep</span>
          <span class="connect-chip"><span class="material-symbols-rounded">favorite</span> Heart</span>
          <span class="connect-chip"><span class="material-symbols-rounded">scale</span> Body</span>
        </div>
      </div>

    {:else}
      <!-- ── At least one integration configured — main UI ── -->

      <!-- Tab bar — only tabs for configured integrations -->
      <div class="tab-bar-wrap" class:has-banner={$pageBanners}>
      <div class="tab-bar" bind:this={_tabBarEl}>
        <div class="tab-pill" style="left:{_wlPillLeft};width:{_wlPillWidth}"></div>
        {#if fitbitAvailable || garminAvailable || healthConnectAvailable}
          <button class="tab-btn" class:active={activeTab === 'movement'} on:click={() => activeTab = 'movement'}>
            <span class="material-symbols-rounded tab-icon">directions_walk</span> Movement
          </button>
          <button class="tab-btn" class:active={activeTab === 'sleep'} on:click={() => activeTab = 'sleep'}>
            <span class="material-symbols-rounded tab-icon">bedtime</span> Sleep
          </button>
          <button class="tab-btn" class:active={activeTab === 'heart'} on:click={() => activeTab = 'heart'}>
            <span class="material-symbols-rounded tab-icon">favorite</span> Heart
          </button>
        {/if}
        {#if withingsAvailable || healthConnectAvailable}
          <button class="tab-btn" class:active={activeTab === 'body'} on:click={() => activeTab = 'body'}>
            <span class="material-symbols-rounded tab-icon">monitor_weight</span> Body
          </button>
        {/if}
      </div>
      </div>
      <div style="height:12px"></div>

      <!-- ── Fitbit tabs (Movement / Sleep / Heart) ── -->
      {#if activeTab === 'movement' || activeTab === 'sleep' || activeTab === 'heart'}

        {#if !status.connected && !garminStatus?.connected && !withingsStatus?.connected && !$healthConnectEnabled && !(isNative && _hasLocalData)}
          <!-- Fitbit configured but not yet connected -->
          {#if !status.configured}
            <div class="connect-card">
              <div class="connect-icon-wrap">
                <span class="material-symbols-rounded connect-icon">monitor_heart</span>
              </div>
              {#if isNative && !getServerUrl()}
                <h2 class="connect-title">No Device Connected</h2>
                <p class="connect-desc">
                  Connect to your NutriTrace server in <strong>Settings → Server Connection</strong> and link a wellness device to see your data here.
                </p>
              {:else}
                <h2 class="connect-title">No Device Connected</h2>
                <p class="connect-desc">
                  Connect a wellness device in <strong>Settings → Wellness</strong> to start tracking your health data.
                </p>
              {/if}
            </div>
          {:else}
            <div class="connect-card">
              <div class="connect-icon-wrap">
                <span class="material-symbols-rounded connect-icon">monitor_heart</span>
              </div>
              <h2 class="connect-title">Connect Fitbit</h2>
              <p class="connect-desc">
                Authorize NutriTrace to read your Fitbit data. You'll be redirected to
                Fitbit to approve access, then brought back here.
              </p>
              <div class="connect-chips">
                <span class="connect-chip"><span class="material-symbols-rounded">directions_walk</span> Steps &amp; Activity</span>
                <span class="connect-chip"><span class="material-symbols-rounded">bedtime</span> Sleep</span>
                <span class="connect-chip"><span class="material-symbols-rounded">favorite</span> Heart Rate &amp; HRV</span>
                <span class="connect-chip"><span class="material-symbols-rounded">water_drop</span> SpO2</span>
                <span class="connect-chip"><span class="material-symbols-rounded">air</span> Breathing Rate</span>
              </div>
              <button class="btn btn-primary connect-btn" on:click={connect} disabled={connecting}>
                {#if connecting}
                  <span class="material-symbols-rounded spin">sync</span> Connecting…
                {:else}
                  <span class="material-symbols-rounded">link</span> Connect Fitbit
                {/if}
              </button>
            </div>
          {/if}

        {:else}
          <!-- Fitbit connected — metric content -->

          <!-- ── Movement tab ── -->
          {#if activeTab === 'movement'}
            <div class="metric-grid">
              {#each ALL_METRICS.filter(m => m.group === 'movement' && isVisible(m.id) && isSourceEnabled(m)) as m}
                {@const fmt = fmtMetric(m, displayData[m.id])}
                {@const spark = sparklinePath(_sparklineData[m.id] ?? [])}
                <div class="metric-card" class:no-data={fmt == null && !loadingData} class:celebrating={_celebratingMetrics.has(m.id)} title={m.desc}>
                  <div class="metric-icon-wrap">
                    <span class="material-symbols-rounded metric-icon">{m.icon}</span>
                  </div>
                  <div class="metric-body">
                    <span class="metric-label">{m.label}</span>
                    {#if loadingData}
                      <span class="metric-value skeleton">—</span>
                    {:else if fmt}
                      <span class="metric-value">{fmt.value}<span class="metric-unit">{fmt.unit}</span></span>
                    {:else}
                      <span class="metric-value no-val">—</span>
                    {/if}
                  </div>
                  {#if spark}
                    <svg class="sparkline" viewBox="0 0 56 24" preserveAspectRatio="none">
                      <path d={spark} fill="none" stroke="var(--accent)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
                    </svg>
                  {/if}
                </div>
              {/each}
            </div>

            <!-- ── Workouts section (within Movement tab) ── -->
            {#if $workoutsEnabled && _workouts.length > 0}
              <div class="section-title" style="margin-top:20px">
                <span class="material-symbols-rounded" style="font-size:18px;vertical-align:middle;margin-right:4px">fitness_center</span>
                Today's Workouts
              </div>
              <div class="workout-list">
                {#each _workouts as w}
                  <button class="card workout-card" on:click={() => _openWorkout(w)}>
                    <div class="workout-icon-wrap">
                      <span class="material-symbols-rounded workout-icon">{_workoutIcon(w.activity_name)}</span>
                    </div>
                    <div class="workout-body">
                      <span class="workout-name">{w.activity_name}</span>
                      <span class="workout-meta">
                        {_fmtDuration(w.duration_ms)}
                        {#if w.distance_km != null} · {_fmtWorkoutDist(w.distance_km)}{/if}
                        {#if w.calories} · {w.calories.toLocaleString()} kcal{/if}
                      </span>
                      {#if w.avg_hr}
                        <span class="workout-hr">
                          <span class="material-symbols-rounded" style="font-size:14px;color:var(--error,#ef4444)">favorite</span>
                          {w.avg_hr} avg{#if w.max_hr} · {w.max_hr} peak{/if} bpm
                        </span>
                      {/if}
                    </div>
                    <div class="workout-trail">
                      {#if w.has_gps}
                        <span class="material-symbols-rounded" style="font-size:18px;color:var(--accent)" title="GPS route available">map</span>
                      {/if}
                      <span class="material-symbols-rounded" style="font-size:18px;color:var(--text-3)">chevron_right</span>
                    </div>
                  </button>
                {/each}
              </div>
            {:else if $workoutsEnabled && !loadingData && _workoutsLoaded}
              <!-- No workouts today — show subtle hint -->
            {/if}

          <!-- ── Sleep tab ── -->
          {:else if activeTab === 'sleep'}
            {#if !loadingData && data.sleep_duration_min != null}
              <div class="card sleep-stages-card">
                <div class="sleep-stages-header">
                  <span class="material-symbols-rounded" style="color:var(--accent)">bar_chart</span>
                  <span class="sleep-stages-title">Sleep Stages</span>
                  {#if displayData.sleep_duration_min != null}
                    {@const s = fmtSleep(displayData.sleep_duration_min)}
                    <span class="sleep-total">{s.value}</span>
                  {/if}
                </div>
                {#if sleepTotal > 0}
                  <div class="stage-bar">
                    {#each sleepStages as stage}
                      {@const pct = sleepTotal > 0 ? ((displayData[stage.key] || 0) / sleepTotal * 100) : 0}
                      {#if pct > 0}
                        <div class="stage-seg" style="width:{pct.toFixed(1)}%;background:{stage.color}" title="{stage.label}: {fmtSleepStr(displayData[stage.key])}"></div>
                      {/if}
                    {/each}
                  </div>
                  <!-- Legend: each label floats at its segment's midpoint -->
                  <div class="stage-legend-bar">
                    {#each sleepStages as stage}
                      {@const pct = sleepTotal > 0 ? ((displayData[stage.key] || 0) / sleepTotal * 100) : 0}
                      {#if pct >= 3}
                        <div class="stage-leg-seg" style="width:{pct.toFixed(1)}%">
                          <span class="stage-leg-label" style="color:{stage.color}">{stage.label}</span>
                          <span class="stage-leg-val">{fmtSleepStr(displayData[stage.key])}</span>
                        </div>
                      {/if}
                    {/each}
                  </div>
                {:else}
                  <p class="text-3 text-sm" style="padding:0 0 8px">No stage data available</p>
                {/if}
              </div>
            {/if}
            <div class="metric-grid">
              {#each ALL_METRICS.filter(m => m.group === 'sleep' && isVisible(m.id) && isSourceEnabled(m)) as m}
                {@const fmt = fmtMetric(m, displayData[m.id])}
                {@const spark = sparklinePath(_sparklineData[m.id] ?? [])}
                <div class="metric-card" class:no-data={fmt == null && !loadingData} class:celebrating={_celebratingMetrics.has(m.id)} title={m.desc}>
                  <div class="metric-icon-wrap">
                    <span class="material-symbols-rounded metric-icon">{m.icon}</span>
                  </div>
                  <div class="metric-body">
                    <span class="metric-label">{m.label}</span>
                    {#if loadingData}
                      <span class="metric-value skeleton">—</span>
                    {:else if fmt}
                      <span class="metric-value">{fmt.value}<span class="metric-unit">{fmt.unit}</span></span>
                    {:else}
                      <span class="metric-value no-val">—</span>
                    {/if}
                  </div>
                  {#if spark}
                    <svg class="sparkline" viewBox="0 0 56 24" preserveAspectRatio="none">
                      <path d={spark} fill="none" stroke="var(--accent)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
                    </svg>
                  {/if}
                </div>
              {/each}
            </div>

            <!-- Sleep Debt card -->
            {#if sleepDebt != null}
              <div class="card sleep-insight-card" style="margin-bottom:10px" title="Sleep Debt — the total sleep you've missed relative to your goal over the selected window. Calculated as a rolling total from today backwards — always reflects the most recent nights, not the date you're viewing."  >
                <div class="si-header">
                  <span class="material-symbols-rounded si-icon">battery_low</span>
                  <div class="si-title-wrap">
                    <span class="si-title">Sleep Debt</span>
                    <span class="si-sub">Last {sleepDebt.nights} nights</span>
                  </div>
                  <span class="si-value {sleepDebt.debtMin === 0 ? 'si-good' : sleepDebt.debtMin < 120 ? 'si-warn' : 'si-bad'}">
                    {sleepDebt.debtMin === 0 ? 'On track' : fmtSleepStr(sleepDebt.debtMin)}
                  </span>
                </div>
                {#if sleepDebt.debtMin > 0}
                  <p class="si-desc">
                    You're {fmtSleepStr(sleepDebt.debtMin)} short of your {fmtSleepStr(sleepDebt.goalMin)} sleep goal across the last {sleepDebt.nights} nights.
                    {#if sleepDebt.debtMin >= 120}Prioritize early bedtimes this week to recover.{:else}A consistent schedule should close the gap quickly.{/if}
                  </p>
                {:else}
                  <p class="si-desc">You're meeting your sleep goal. Keep it up!</p>
                {/if}
                <div class="si-range-chips">
                  {#each [7, 14, 30] as n}
                    <button class="chip" class:chip-active={sleepInsightsRange === n} on:click={() => sleepInsightsRange = n}>{n}d</button>
                  {/each}
                </div>
              </div>
            {/if}

            <!-- Chronotype card -->
            {#if chronotype != null}
              <div class="card sleep-insight-card" title="Chronotype — your natural sleep timing preference, derived from your average sleep midpoint over all available nights. This is a long-term trait that updates as more nights are synced — it always reflects your full history, not the specific date you're viewing."  >
                <div class="si-header">
                  <span class="si-emoji">{chronotype.emoji ?? '⏳'}</span>
                  <div class="si-title-wrap">
                    <span class="si-title">{chronotype.label ?? 'Building Profile…'}</span>
                    <span class="si-sub">
                      {#if chronotype.label}Avg sleep midpoint: {fmtTimeMin(chronotype.midpointMin)} · {chronotype.nights} nights
                      {:else}{chronotype.nights}/{chronotype.needed} nights collected{/if}
                    </span>
                  </div>
                </div>
                {#if chronotype.label}
                  <p class="si-desc">{chronotype.desc}</p>
                {:else}
                  <p class="si-desc">Syncing more nights will unlock your chronotype. Once {chronotype.needed} nights of sleep timing are available your profile will appear here.</p>
                {/if}
              </div>
            {/if}

          <!-- ── Heart tab ── -->
          {:else if activeTab === 'heart'}
            <div class="metric-grid">
              {#each ALL_METRICS.filter(m => m.group === 'heart' && isVisible(m.id) && isSourceEnabled(m)) as m}
                {@const fmt = fmtMetric(m, displayData[m.id])}
                {@const spark = sparklinePath(_sparklineData[m.id] ?? [])}
                <div class="metric-card" class:no-data={fmt == null && !loadingData} class:celebrating={_celebratingMetrics.has(m.id)} title={m.desc}>
                  <div class="metric-icon-wrap">
                    <span class="material-symbols-rounded metric-icon" style="color:#ef4444">{m.icon}</span>
                  </div>
                  <div class="metric-body">
                    <span class="metric-label">{m.label}</span>
                    {#if loadingData}
                      <span class="metric-value skeleton">—</span>
                    {:else if fmt}
                      <span class="metric-value">{fmt.value}<span class="metric-unit">{fmt.unit}</span></span>
                    {:else}
                      <span class="metric-value no-val">—</span>
                    {/if}
                  </div>
                  {#if spark}
                    <svg class="sparkline" viewBox="0 0 56 24" preserveAspectRatio="none">
                      <path d={spark} fill="none" stroke="var(--accent)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
                    </svg>
                  {/if}
                </div>
              {/each}
            </div>
            <!-- Garmin-specific: Body Battery + Stress -->
            {#if $garminEnabled && garminStatus?.connected && GARMIN_METRICS.filter(m => isVisible(m.id)).some(m => garminData[m.id] != null)}
              <div class="card" style="margin-top:12px;padding:16px">
                <div class="sleep-stages-header" style="margin-bottom:12px">
                  <span class="wl-brand-icon" style="font-size:16px;color:var(--accent)"><GarminIcon /></span>
                  <span class="sleep-stages-title">Garmin</span>
                </div>
                <div class="metric-grid">
                  {#each GARMIN_METRICS.filter(m => isVisible(m.id)) as m}
                    {@const raw = garminData[m.id]}
                    {#if raw != null}
                      <div class="metric-card" title={m.desc}>
                        <div class="metric-icon-wrap">
                          <span class="material-symbols-rounded metric-icon">{m.icon}</span>
                        </div>
                        <div class="metric-body">
                          <span class="metric-label">{m.label}</span>
                          <span class="metric-value">{m.fmt(raw)}<span class="metric-unit">{m.unit}</span></span>
                        </div>
                      </div>
                    {/if}
                  {/each}
                </div>
              </div>
            {/if}

            <!-- Daily Readiness card -->
            {#if readiness != null}
              <div class="card sleep-insight-card readiness-card" style="margin-top:10px" title="Daily Readiness — how recovered and prepared your body is for today, scored 1–100. Calculated from today's HRV and RHR compared to your 30-day personal baseline, plus last night's sleep score. Always reflects today's data — not the date you're viewing."  >
                {#if readiness.calibrating}
                  <div class="si-header">
                    <span class="material-symbols-rounded si-icon">battery_charging_full</span>
                    <div class="si-title-wrap">
                      <span class="si-title">Daily Readiness</span>
                      <span class="si-sub">Calibrating… {readiness.data_days}/{readiness.needed} nights with HRV data</span>
                    </div>
                  </div>
                  <p class="si-desc">Needs {readiness.needed} nights where your device recorded HRV during sleep. Fitbit only captures HRV on nights with a clean optical reading — wearing the device snugly helps.</p>
                {:else}
                  <div class="readiness-header">
                    <div class="readiness-header-left">
                      <span class="material-symbols-rounded si-icon">battery_charging_full</span>
                      <div class="si-title-wrap">
                        <span class="si-title">Daily Readiness</span>
                        <span class="si-sub">
                          HRV baseline {readiness.hrv_baseline} ms{readiness.rhr_baseline != null ? ` · RHR baseline ${readiness.rhr_baseline} bpm` : ''} · {readiness.data_days} days
                        </span>
                      </div>
                    </div>
                    <div class="readiness-score-wrap">
                      <span class="readiness-score" style="color:{readiness.color}">{readiness.score}</span>
                      <span class="readiness-label" style="color:{readiness.color}">{readiness.label}</span>
                    </div>
                  </div>
                  <div class="readiness-drivers">
                    <div class="readiness-driver">
                      <span class="rd-label">HRV</span>
                      <span class="rd-val" style="color:{readiness.hrv_score >= 65 ? 'var(--accent)' : readiness.hrv_score >= 50 ? '#f59e0b' : '#ef4444'}">{readiness.hrv_score}</span>
                    </div>
                    <div class="readiness-driver">
                      <span class="rd-label">Resting HR</span>
                      <span class="rd-val" style="color:{readiness.rhr_score >= 65 ? 'var(--accent)' : readiness.rhr_score >= 50 ? '#f59e0b' : '#ef4444'}">{readiness.rhr_score}</span>
                    </div>
                    <div class="readiness-driver">
                      <span class="rd-label">Sleep</span>
                      <span class="rd-val" style="color:{readiness.sleep_score_used >= 65 ? 'var(--accent)' : readiness.sleep_score_used >= 50 ? '#f59e0b' : '#ef4444'}">{readiness.sleep_score_used}</span>
                    </div>
                    <div class="readiness-driver">
                      <span class="rd-label">Penalties</span>
                      <span class="rd-val" class:rd-penalty={(readiness.activity_penalty + readiness.interaction_penalty) > 0}>
                        {(readiness.activity_penalty + readiness.interaction_penalty) > 0 ? `−${readiness.activity_penalty + readiness.interaction_penalty}` : '—'}
                      </span>
                    </div>
                  </div>
                  {#if readiness.data_days < 30}
                    <div class="si-calibration-note">
                      <span class="material-symbols-rounded" style="font-size:14px;vertical-align:middle">info</span>
                      Based on {readiness.data_days} days — accuracy improves as more data is collected.
                    </div>
                  {/if}
                  {#if readiness.stored}
                    <div class="score-debug-info">
                      <span class="material-symbols-rounded" style="font-size:14px;color:var(--text-3)">lock</span>
                      <span>Locked at sync · Calculated: {readiness.hrv_score != null ? Math.round((0.65 * readiness.hrv_score) + (0.20 * readiness.rhr_score) + (0.10 * (readiness.sleep_score_used || 75))) : '—'}</span>
                      <button class="btn-recalc" on:click={recalculateScores} title="Force recalculate">
                        <span class="material-symbols-rounded" style="font-size:16px">refresh</span>
                      </button>
                    </div>
                  {/if}
                {/if}
              </div>
            {/if}

            <!-- Stress Management Score card -->
            {#if stressScore != null}
              <div class="card sleep-insight-card readiness-card" style="margin-top:10px" title="Stress Management — how well your body is handling stress, scored 1–100. Calculated from HRV, RHR, and sleep quality relative to your 30-day baseline, with exponential smoothing so the score moves gradually over time. Always reflects today's data — not the date you're viewing."  >
                {#if stressScore.calibrating}
                  <div class="si-header">
                    <span class="material-symbols-rounded si-icon">self_improvement</span>
                    <div class="si-title-wrap">
                      <span class="si-title">Stress Management</span>
                      <span class="si-sub">Calibrating… {stressScore.data_days}/{stressScore.needed} nights with HRV data</span>
                    </div>
                  </div>
                  <p class="si-desc">Needs {stressScore.needed} nights where your device recorded HRV during sleep. Fitbit only captures HRV on nights with a clean optical reading — wearing the device snugly helps.</p>
                {:else}
                  <div class="readiness-header">
                    <div class="readiness-header-left">
                      <span class="material-symbols-rounded si-icon">self_improvement</span>
                      <div class="si-title-wrap">
                        <span class="si-title">Stress Management</span>
                        <span class="si-sub">
                          HRV baseline {stressScore.hrv_baseline} ms{stressScore.rhr_baseline != null ? ` · RHR baseline ${stressScore.rhr_baseline} bpm` : ''} · {stressScore.data_days} days
                        </span>
                      </div>
                    </div>
                    <div class="readiness-score-wrap">
                      <span class="readiness-score" style="color:{stressScore.color}">{stressScore.score}</span>
                      <span class="readiness-label" style="color:{stressScore.color}">{stressScore.label}</span>
                    </div>
                  </div>
                  <p class="si-desc" style="margin-top:6px;margin-bottom:0">Higher = nervous system is well balanced. Driven by HRV, sleep quality, and resting HR compared to your personal baselines. Moves gradually — reflects multi-day trends, not just today.</p>
                  {#if stressScore.data_days < 30}
                    <div class="si-calibration-note">
                      <span class="material-symbols-rounded" style="font-size:14px;vertical-align:middle">info</span>
                      Based on {stressScore.data_days} days — accuracy improves as more data is collected.
                    </div>
                  {/if}
                {/if}
              </div>
            {/if}
          {/if}

          <!-- Empty state for activity tabs -->
          {#if !loadingData && Object.keys(displayData).length === 0}
            <div class="empty-state">
              <span class="material-symbols-rounded" style="font-size:48px;opacity:0.18">monitor_heart</span>
              <p>No data for {isToday ? 'today' : fmtDate(dateStr)}.</p>
              <p class="text-3 text-sm">Tap <strong>Sync</strong> to pull the latest from your device.</p>
            </div>
          {/if}
        {/if}

      <!-- ── Body tab (Withings) ── -->
      {:else if activeTab === 'body'}
        {#if withingsStatus.connected || $healthConnectEnabled || (isNative && _hasLocalData)}
          <div class="metric-grid">
            {#each BODY_METRICS.filter(m => isVisible(m.id)) as m}
              {@const raw = withingsData[m.id] ?? data[m.id] ?? null}
              {@const formatted = fmtBodyMetric(m, raw)}
              <div class="metric-card" class:no-data={formatted == null && !loadingData} class:celebrating={_celebratingMetrics.has(m.id)} title={m.desc}>
                <div class="metric-icon-wrap">
                  <span class="material-symbols-rounded metric-icon">{m.icon}</span>
                </div>
                <div class="metric-body">
                  <span class="metric-label">{m.label}</span>
                  {#if loadingData}
                    <span class="metric-value skeleton">—</span>
                  {:else if formatted}
                    <span class="metric-value">{formatted.value}<span class="metric-unit">{formatted.unit}</span></span>
                  {:else}
                    <span class="metric-value no-val">—</span>
                  {/if}
                </div>
              </div>
            {/each}
          </div>

          {#if BODY_SCORE_METRICS.filter(m => isVisible(m.id)).some(m => (withingsData[m.id] ?? data[m.id]) != null)}
            <div class="card" style="margin-top:12px;padding:16px">
              <div class="sleep-stages-header" style="margin-bottom:12px">
                <span class="material-symbols-rounded" style="color:var(--accent)">biotech</span>
                <span class="sleep-stages-title">Body Scan Scores</span>
              </div>
              <div class="metric-grid">
                {#each BODY_SCORE_METRICS.filter(m => isVisible(m.id)) as m}
                  {@const raw = withingsData[m.id] ?? data[m.id] ?? null}
                  {#if raw != null}
                    <div class="metric-card" title={m.desc}>
                      <div class="metric-icon-wrap">
                        <span class="material-symbols-rounded metric-icon">{m.icon}</span>
                      </div>
                      <div class="metric-body">
                        <span class="metric-label">{m.label}</span>
                        <span class="metric-value">{m.fmt(raw)}<span class="metric-unit">{m.unit}</span></span>
                      </div>
                    </div>
                  {/if}
                {/each}
              </div>
            </div>
          {/if}

          <!-- Segmental analysis (Body Scan) -->
          {#if isVisible('segmental_analysis') && ['muscle_mass_torso_kg','muscle_mass_left_leg_kg','muscle_mass_left_arm_kg','muscle_mass_right_leg_kg','muscle_mass_right_arm_kg','lean_mass_torso_kg','lean_mass_left_leg_kg','lean_mass_left_arm_kg','lean_mass_right_leg_kg','lean_mass_right_arm_kg'].some(k => (withingsData[k] ?? data[k]) != null)}
            <div class="card" style="margin-top:12px;padding:16px">
              <div class="sleep-stages-header" style="margin-bottom:4px">
                <span class="material-symbols-rounded" style="color:var(--accent)">accessibility_new</span>
                <span class="sleep-stages-title">Segmental Analysis</span>
              </div>
              <p style="font-size:0.75rem;color:var(--text-3);margin:0 0 12px;line-height:1.4">
                <strong>Muscle</strong> = contractile muscle tissue. <strong>Lean</strong> = all non-fat tissue (muscle + bone + water). Lean is always higher than muscle. These values are absolute weights — percentages in device apps may use a different calculation.
              </p>
              <div class="segmental-table">
                <div class="seg-header">
                  <span></span>
                  <span>Muscle</span>
                  <span>Lean</span>
                </div>
                {#each [
                  { label: 'Left Arm',  muscle: 'muscle_mass_left_arm_kg',  lean: 'lean_mass_left_arm_kg'  },
                  { label: 'Right Arm', muscle: 'muscle_mass_right_arm_kg', lean: 'lean_mass_right_arm_kg' },
                  { label: 'Torso',     muscle: 'muscle_mass_torso_kg',     lean: 'lean_mass_torso_kg'     },
                  { label: 'Left Leg',  muscle: 'muscle_mass_left_leg_kg',  lean: 'lean_mass_left_leg_kg'  },
                  { label: 'Right Leg', muscle: 'muscle_mass_right_leg_kg', lean: 'lean_mass_right_leg_kg' },
                ] as seg}
                  {#if (withingsData[seg.muscle] ?? data[seg.muscle]) != null || (withingsData[seg.lean] ?? data[seg.lean]) != null}
                    {@const mKg = withingsData[seg.muscle] ?? data[seg.muscle]}
                    {@const lKg = withingsData[seg.lean] ?? data[seg.lean]}
                    <div class="seg-row">
                      <span class="seg-label">{seg.label}</span>
                      <span class="seg-val">{mKg != null ? fmtWeight(mKg).value + ' ' + fmtWeight(mKg).unit : '—'}</span>
                      <span class="seg-val">{lKg != null ? fmtWeight(lKg).value + ' ' + fmtWeight(lKg).unit : '—'}</span>
                    </div>
                  {/if}
                {/each}
              </div>
            </div>
          {/if}

          {#if !loadingData && Object.keys(withingsData).length === 0 && !BODY_METRICS.some(m => data[m.id] != null)}
            <div class="empty-state">
              <span class="material-symbols-rounded" style="font-size:48px;opacity:0.18">scale</span>
              <p>No body composition data for {isToday ? 'today' : fmtDate(dateStr)}.</p>
              <p class="text-3 text-sm">Sync your scale or fitness tracker to see body stats here.</p>
            </div>
          {/if}

        {:else if withingsStatus.configured}
          <div class="connect-card">
            <div class="connect-icon-wrap">
              <span class="material-symbols-rounded connect-icon">scale</span>
            </div>
            <h2 class="connect-title">Connect Withings</h2>
            <p class="connect-desc">
              Sync body composition from your Withings scale. Weight, body fat %, muscle mass, bone mass, and more — automatically filled into your diary.
            </p>
            <div class="connect-chips">
              <span class="connect-chip"><span class="material-symbols-rounded">monitor_weight</span> Weight</span>
              <span class="connect-chip"><span class="material-symbols-rounded">percent</span> Body Fat %</span>
              <span class="connect-chip"><span class="material-symbols-rounded">fitness_center</span> Muscle Mass</span>
              <span class="connect-chip"><span class="material-symbols-rounded">water_drop</span> Body Water</span>
              <span class="connect-chip"><span class="material-symbols-rounded">emergency</span> Bone Mass</span>
              <span class="connect-chip"><span class="material-symbols-rounded">ecg_heart</span> ECG &amp; AFib</span>
            </div>
            <button class="btn btn-primary connect-btn" on:click={connectWithings} disabled={withingsConnecting}>
              {#if withingsConnecting}
                <span class="material-symbols-rounded spin">sync</span> Connecting…
              {:else}
                <span class="material-symbols-rounded">link</span> Connect Withings
              {/if}
            </button>
          </div>
        {/if}

      {/if}

    {/if}

  </div>
</div>

<!-- Date picker calendar sheet -->
{#if showDatePicker}
  <div use:portal class="sheet-backdrop" role="dialog" aria-modal="true"
    on:click={() => { if (!_sheetLock) showDatePicker = false; }} on:keydown={() => {}}>
    <div class="bs-sheet dp-sheet" on:click|stopPropagation on:keydown={() => {}}>
      <div class="sheet-handle"></div>
      <div class="dp-nav">
        <button class="btn-icon dp-nav-btn" on:click={calPrevMonth} aria-label="Previous month">
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
        <button class="btn-icon dp-nav-btn" on:click={calNextMonth} disabled={calAtMax} aria-label="Next month">
          <span class="material-symbols-rounded">chevron_right</span>
        </button>
      </div>
      {#if showYearPicker}
        <div class="dp-year-grid">
          {#each yearRange as yr}
            <button class="dp-yr-btn" class:dp-yr-sel={yr === calYear}
              on:click={() => { calYear = yr; showYearPicker = false; }}>{yr}</button>
          {/each}
        </div>
      {:else if showMonthPicker}
        <div class="dp-month-grid">
          {#each monthNames as m}
            <button class="dp-mo-btn" class:dp-mo-sel={m.idx === calMonth}
              on:click={() => { calMonth = m.idx; showMonthPicker = false; }}>{m.short}</button>
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
            <button class="dp-day"
              class:dp-today={ds === localDateStr()}
              class:dp-sel={ds === dateStr}
              class:dp-future={ds > localDateStr()}
              on:click={() => { pickerDate = ds; goToDate(); }}>
              {day}
            </button>
          {/each}
        </div>
        <div class="dp-manual">
          <input class="input" type="text" bind:value={pickerDate}
            placeholder="YYYY-MM-DD" style="flex:1;font-size:14px;height:40px" />
          <button class="btn btn-primary" style="height:40px;padding:0 18px" on:click={goToDate}>Go</button>
        </div>
      {/if}
    </div>
  </div>
{/if}

<!-- ── Workout Detail Modal ── -->
{#if _showWorkoutDetail && _selectedWorkout}
  {@const w = _selectedWorkout}
  <div class="workout-overlay" on:click|self={() => _showWorkoutDetail = false} use:portal>
    <div class="workout-detail">
      <div class="workout-detail-header">
        <div style="display:flex;align-items:center;gap:8px">
          <span class="material-symbols-rounded" style="font-size:24px;color:var(--accent)">{_workoutIcon(w.activity_name)}</span>
          <div>
            <h3 style="margin:0;font-size:16px;font-weight:600">{w.activity_name}</h3>
            <span class="text-3 text-sm">
              {w.start_time ? new Date(w.start_time).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : dateStr}
            </span>
          </div>
        </div>
        <button class="workout-close" on:click={() => _showWorkoutDetail = false}>
          <span class="material-symbols-rounded">close</span>
        </button>
      </div>

      <!-- GPS Map -->
      {#if _loadingGps}
        <div class="workout-map-placeholder">
          <span class="material-symbols-rounded spin">sync</span>
          <span>Loading route…</span>
        </div>
      {:else if _workoutGps && _workoutGps.length > 1}
        <div class="workout-map" id="workout-map-container"></div>
        {#await import('https://unpkg.com/leaflet@1.9.4/dist/leaflet-src.esm.js') then L}
          {@const _ = (() => {
            // Render map after DOM is ready
            setTimeout(() => {
              const el = document.getElementById('workout-map-container');
              if (!el || el._leaflet_id) return;
              const pts = _workoutGps;
              const map = L.map(el, { zoomControl: false, attributionControl: false });
              L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);
              // Color route by heart rate if available
              const hasHr = pts.some(p => p.hr);
              if (hasHr) {
                // Draw segments colored by HR zone
                for (let i = 1; i < pts.length; i++) {
                  const hr = pts[i].hr || pts[i-1].hr || 100;
                  const color = hr > 170 ? '#ef4444' : hr > 150 ? '#f59e0b' : hr > 130 ? '#22c55e' : '#3b82f6';
                  L.polyline([[pts[i-1].lat, pts[i-1].lng], [pts[i].lat, pts[i].lng]], {
                    color, weight: 4, opacity: 0.85
                  }).addTo(map);
                }
              } else {
                L.polyline(pts.map(p => [p.lat, p.lng]), { color: 'var(--accent)', weight: 4 }).addTo(map);
              }
              // Start/end markers
              L.circleMarker([pts[0].lat, pts[0].lng], { radius: 6, color: '#22c55e', fillColor: '#22c55e', fillOpacity: 1 }).addTo(map).bindPopup('Start');
              L.circleMarker([pts[pts.length-1].lat, pts[pts.length-1].lng], { radius: 6, color: '#ef4444', fillColor: '#ef4444', fillOpacity: 1 }).addTo(map).bindPopup('Finish');
              map.fitBounds(pts.map(p => [p.lat, p.lng]), { padding: [20, 20] });
            }, 100);
          })()}
        {/await}
      {:else if w.has_gps}
        <div class="workout-map-placeholder">
          <span class="material-symbols-rounded">map</span>
          <span>No GPS data available</span>
        </div>
      {/if}

      <!-- Stats grid -->
      <div class="workout-stats-grid">
        <div class="workout-stat">
          <span class="workout-stat-val">{_fmtDuration(w.duration_ms)}</span>
          <span class="workout-stat-lbl">Duration</span>
        </div>
        {#if w.distance_km != null}
          <div class="workout-stat">
            <span class="workout-stat-val">{_fmtWorkoutDist(w.distance_km)}</span>
            <span class="workout-stat-lbl">Distance</span>
          </div>
        {/if}
        {#if w.calories}
          <div class="workout-stat">
            <span class="workout-stat-val">{w.calories.toLocaleString()}</span>
            <span class="workout-stat-lbl">kcal</span>
          </div>
        {/if}
        {#if w.steps}
          <div class="workout-stat">
            <span class="workout-stat-val">{w.steps.toLocaleString()}</span>
            <span class="workout-stat-lbl">Steps</span>
          </div>
        {/if}
        {#if w.avg_hr}
          <div class="workout-stat">
            <span class="workout-stat-val">{w.avg_hr}</span>
            <span class="workout-stat-lbl">Avg HR</span>
          </div>
        {/if}
        {#if w.max_hr}
          <div class="workout-stat">
            <span class="workout-stat-val">{w.max_hr}</span>
            <span class="workout-stat-lbl">Peak HR</span>
          </div>
        {/if}
      </div>

      {#if _workoutGps && _workoutGps.some(p => p.hr)}
        <div class="workout-hr-legend" style="margin-top:8px;display:flex;gap:12px;justify-content:center;font-size:11px;color:var(--text-3)">
          <span><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#3b82f6;margin-right:3px"></span>&lt;130</span>
          <span><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#22c55e;margin-right:3px"></span>130–150</span>
          <span><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#f59e0b;margin-right:3px"></span>150–170</span>
          <span><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#ef4444;margin-right:3px"></span>&gt;170</span>
        </div>
      {/if}
    </div>
  </div>
{/if}

<svelte:head>
  {#if _showWorkoutDetail}
    <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
  {/if}
</svelte:head>

<style>
  /*
    Override the global page-shell min-height: 100dvh.
    Wellness puts only the <header> inside page-shell (date bar + content are
    outside siblings), so the global min-height would balloon the shell to full
    viewport height and shove the date bar way off screen.
  */
  /* Shell: no forced min-height — avoids pushing fixed bottom nav off-screen on mobile.
     Sticky still works because header + date bar + content share the same scroll container. */
  .wl-shell {
    min-height: unset;
  }
  /* H1 height/alignment now lives in base.css .page-header h1 (uniform 40px). */
  /* Content area: explicit bottom padding since shell no longer provides it. */
  .wl-content {
    padding-bottom: calc(var(--nav-h) + var(--safe-bottom) + 16px);
  }

  /* Date sub-bar — same pattern as Diary */
  .wl-date-bar {
    position: sticky;
    top: calc(var(--page-top, var(--safe-top)) + 110px);
    z-index: 9;
    background: var(--glass-surface);
    backdrop-filter: blur(20px) saturate(180%);
    -webkit-backdrop-filter: blur(20px) saturate(180%);
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 8px var(--page-px);
  }
  .wl-date-bar.has-banner {
    top: calc(var(--page-top, var(--safe-top)) + 170px);
  }
  .date-btn {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1px;
    background: none;
    border: none;
    cursor: pointer;
  }
  .date-label { font-size: 17px; font-weight: 700; color: var(--accent); }
  .date-sub   { font-size: 12px; color: var(--text-3); }

  /* Loading spinner */
  .wellness-loading {
    display: flex;
    justify-content: center;
    padding: 64px;
    color: var(--text-3);
    font-size: 36px;
  }

  /* Connect card */
  .connect-card {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 32px 24px;
    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 16px;
    margin-top: 16px;
  }
  .connect-icon-wrap {
    width: 72px;
    height: 72px;
    border-radius: 50%;
    background: var(--accent-dim);
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .connect-icon {
    font-size: 36px;
    color: var(--accent);
  }
  .connect-title {
    font-size: 22px;
    font-weight: 700;
    color: var(--text-1);
    margin: 0;
  }
  .connect-desc {
    font-size: 14px;
    color: var(--text-2);
    max-width: 400px;
    line-height: 1.55;
    margin: 0;
  }
  .connect-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    justify-content: center;
  }
  .connect-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 5px 12px;
    border-radius: 99px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    font-size: 13px;
    color: var(--text-2);
  }
  .connect-chip .material-symbols-rounded { font-size: 16px; }
  .connect-btn {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 4px;
    min-width: 180px;
    justify-content: center;
  }

  /* Sync bar */
  .sync-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 14px;
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    margin-bottom: 4px;
  }
  .sync-info {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .sync-source-icon { font-size: 22px; color: var(--accent); }
  .sync-source-text { display: flex; flex-direction: column; gap: 1px; }
  .sync-source-label { font-size: 14px; font-weight: 600; color: var(--text-1); }
  .sync-time { font-size: 11px; color: var(--text-3); }
  .sync-actions { display: flex; align-items: center; gap: 8px; }

  /* Prominent sync button */
  .sync-btn {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 18px;
    background: var(--accent);
    color: var(--accent-text, #fff);
    border: none;
    border-radius: var(--radius-md);
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    transition: opacity var(--dur-fast), transform var(--dur-fast);
    -webkit-tap-highlight-color: transparent;
  }
  .sync-btn:hover:not(:disabled) { opacity: 0.88; }
  .sync-btn:active:not(:disabled) { transform: scale(0.96); }
  .sync-btn:disabled { opacity: 0.6; cursor: default; }
  .sync-btn-icon { font-size: 18px; }
  .sync-btn.syncing .sync-btn-icon {
    animation: wl-spin 0.8s linear infinite;
  }
  @keyframes wl-spin { to { transform: rotate(360deg); } }

  .text-danger { color: var(--text-3); }
  .text-danger:hover { color: var(--error, #f87171); }

  /* Fixed sync buttons — top-right, same row as hamburger */
  .wl-topbar-actions {
    position: fixed;
    top: calc(var(--safe-top) + 10px);
    right: 12px;
    z-index: 41;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .wl-sync-icon-btn {
    width: 40px;
    height: 40px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--radius-md);
    border: none;
    background: var(--accent-dim);
    color: var(--accent);
    cursor: pointer;
    font-size: 20px;
    transition: opacity var(--dur-fast), transform var(--dur-fast);
    -webkit-tap-highlight-color: transparent;
  }
  .wl-sync-icon-btn:hover:not(:disabled) { opacity: 0.8; }
  .wl-sync-icon-btn:active:not(:disabled) { transform: scale(0.9); }
  .wl-sync-icon-btn:disabled { opacity: 0.5; cursor: default; }
  .wl-brand-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
  }
  .wl-brand-icon :global(svg) {
    width: 100%;
    height: 100%;
  }
  .wl-spin-icon {
    font-size: 20px;
    animation: wl-spin 0.8s linear infinite;
  }
  /* Tabs */
  .tab-bar-wrap {
    position: sticky;
    top: calc(var(--page-top, var(--safe-top)) + 110px + 52px);
    z-index: 8;
    background: var(--glass-surface);
    backdrop-filter: blur(20px) saturate(180%);
    -webkit-backdrop-filter: blur(20px) saturate(180%);
    border-bottom: 1px solid var(--border);
    margin: -12px calc(-1 * var(--page-px, 16px)) 0;
    padding: 12px var(--page-px, 16px) 12px;
  }
  .tab-bar-wrap.has-banner {
    top: calc(var(--page-top, var(--safe-top)) + 170px + 52px);
  }
  .tab-bar {
    display: flex;
    padding: 4px;
    background: var(--surface-2);
    border-radius: var(--radius-md);
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
    position: relative;
  }
  .tab-bar::-webkit-scrollbar { display: none; }
  .tab-pill {
    position: absolute;
    top: 4px;
    bottom: 4px;
    border-radius: calc(var(--radius-md) - 2px);
    background: var(--surface-1);
    box-shadow: var(--shadow-sm);
    transition: left var(--dur-base, 220ms) var(--ease-inout, cubic-bezier(.4,0,.2,1));
    pointer-events: none;
    z-index: 0;
  }
  .tab-btn {
    flex: 1 0 auto;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 5px;
    padding: 8px 10px;
    border-radius: calc(var(--radius-md) - 2px);
    background: none;
    border: none;
    cursor: pointer;
    font-size: 13px;
    font-weight: 500;
    color: var(--text-3);
    transition: color var(--dur-fast);
    white-space: nowrap;
    position: relative;
    z-index: 1;
  }
  .tab-btn.active {
    color: var(--accent);
  }
  .tab-icon { font-size: 16px; }

  /* Metric grid */
  .metric-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    gap: 10px;
    margin-bottom: 12px;
  }
  .metric-card {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 16px 14px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    transition: opacity var(--dur-fast);
  }
  .metric-card.no-data { opacity: 0.5; }
  .metric-card.celebrating { animation: goal-pulse 1.2s ease-out; }
  @keyframes goal-pulse {
    0%   { filter: brightness(1); }
    30%  { filter: brightness(1.6) saturate(1.4); box-shadow: 0 0 12px var(--accent); }
    70%  { filter: brightness(1.3); }
    100% { filter: brightness(1); }
  }
  .metric-icon-wrap {
    width: 36px;
    height: 36px;
    border-radius: var(--radius-sm);
    background: var(--accent-dim);
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .metric-icon { font-size: 20px; color: var(--accent); }
  .metric-body {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .metric-label {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--text-3);
  }
  .metric-value {
    font-size: 22px;
    font-weight: 700;
    color: var(--text-1);
    line-height: 1.1;
  }
  .metric-unit {
    font-size: 12px;
    font-weight: 500;
    color: var(--text-3);
    margin-left: 3px;
  }
  .metric-value.no-val { color: var(--text-3); font-size: 18px; }
  .metric-value.skeleton { color: var(--surface-3); }

  /* Sleep stages card */
  .sleep-stages-card {
    padding: 16px;
    margin-bottom: 12px;
  }
  .sleep-stages-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 12px;
  }
  .sleep-stages-title {
    font-size: 14px;
    font-weight: 600;
    color: var(--text-1);
    flex: 1;
  }
  .sleep-total {
    font-size: 18px;
    font-weight: 700;
    color: var(--text-1);
  }
  .stage-bar {
    display: flex;
    height: 16px;
    border-radius: 8px;
    overflow: hidden;
    gap: 2px;
    margin-bottom: 10px;
    background: var(--surface-2);
  }
  .stage-seg {
    height: 100%;
    border-radius: 4px;
    min-width: 4px;
    transition: width var(--dur-base);
  }
  /* Sleep stage legend — proportional segments matching bar */
  .stage-legend-bar {
    display: flex;
    margin-top: 8px;
    overflow: hidden;
  }
  .stage-leg-seg {
    display: flex;
    flex-direction: column;
    align-items: center;
    min-width: 0;
    padding: 0 2px;
    overflow: hidden;
  }
  .stage-leg-label {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 100%;
  }
  .stage-leg-val {
    font-size: 12px;
    font-weight: 600;
    color: var(--text-1);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 100%;
  }

  /* Empty state */
  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    padding: 48px 24px;
    text-align: center;
    color: var(--text-2);
  }

  /* Spin animation */
  @keyframes spin { to { transform: rotate(360deg); } }
  .spin { animation: spin 1s linear infinite; }

  /* Chip styles */
  .chip {
    padding: 6px 14px;
    border-radius: 99px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    font-size: 13px;
    font-weight: 500;
    color: var(--text-2);
    cursor: pointer;
    transition: background var(--dur-fast), color var(--dur-fast), border-color var(--dur-fast);
  }
  .chip:hover { background: var(--surface-3); color: var(--text-1); }
  .chip-active {
    background: var(--accent-dim) !important;
    border-color: var(--accent) !important;
    color: var(--accent) !important;
    font-weight: 600;
  }

  /* Sparkline */
  .sparkline {
    width: 100%;
    height: 24px;
    display: block;
    opacity: 0.6;
    margin-top: 4px;
  }

  /* Sleep Insight cards (Debt + Chronotype) */
  .sleep-insight-card {
    padding: 14px 16px;
  }
  .si-header {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 8px;
  }
  .si-icon {
    font-size: 22px;
    color: var(--accent);
    flex-shrink: 0;
  }
  .si-emoji {
    font-size: 22px;
    line-height: 1;
    flex-shrink: 0;
  }
  .si-title-wrap {
    display: flex;
    flex-direction: column;
    gap: 1px;
    flex: 1;
  }
  .si-title {
    font-size: 14px;
    font-weight: 600;
    color: var(--text-1);
  }
  .si-sub {
    font-size: 11px;
    color: var(--text-3);
  }
  .si-value {
    font-size: 16px;
    font-weight: 700;
    flex-shrink: 0;
  }
  .si-good { color: var(--accent); }
  .si-warn { color: #f59e0b; }
  .si-bad  { color: #ef4444; }
  .si-desc {
    font-size: 13px;
    color: var(--text-2);
    line-height: 1.5;
    margin: 0 0 10px;
  }
  .si-calibration-note {
    font-size: 12px;
    color: var(--text-3);
    padding: 8px 12px;
    margin-top: 8px;
    background: var(--surface-2);
    border-radius: var(--radius-sm, 6px);
    line-height: 1.4;
  }
  .score-debug-info {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    color: var(--text-3);
    margin-top: 8px;
    padding: 6px 10px;
    background: var(--surface-2);
    border-radius: var(--radius-sm, 6px);
  }
  .btn-recalc {
    margin-left: auto;
    background: none;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm, 6px);
    cursor: pointer;
    color: var(--text-3);
    padding: 2px 6px;
    display: flex;
    align-items: center;
  }
  .btn-recalc:hover { color: var(--accent); border-color: var(--accent); }
  .si-range-chips {
    display: flex;
    gap: 6px;
  }

  /* Daily Readiness card */
  .readiness-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 12px;
  }
  .readiness-header-left {
    display: flex;
    align-items: center;
    gap: 10px;
    flex: 1;
    min-width: 0;
  }
  .readiness-score-wrap {
    display: flex;
    flex-direction: column;
    align-items: center;
    flex-shrink: 0;
  }
  .readiness-score {
    font-size: 38px;
    font-weight: 800;
    line-height: 1;
  }
  .readiness-label {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin-top: 1px;
  }
  .readiness-drivers {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 6px;
    background: var(--surface-2);
    border-radius: 8px;
    padding: 10px 8px;
  }
  .readiness-driver {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 3px;
  }
  .rd-label {
    font-size: 9px;
    color: var(--text-3);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    text-align: center;
  }
  .rd-val {
    font-size: 15px;
    font-weight: 700;
    color: var(--text-1);
  }
  .rd-penalty { color: #f59e0b; }

  @media (max-width: 400px) {
    .metric-grid { grid-template-columns: 1fr 1fr; }
  }

  /* ── Sheet backdrop + bottom sheet (must be defined here; Diary's are scoped there) ── */
  .sheet-backdrop {
    position: fixed; inset: 0; z-index: 200;
    background: rgba(0,0,0,0.5);
    display: flex; align-items: flex-end;
  }
  .sheet-handle { width: 36px; height: 4px; background: var(--border); border-radius: 2px; margin: 10px auto 0; }
  .bs-sheet {
    background: var(--surface-1);
    border-radius: var(--radius-xl) var(--radius-xl) 0 0;
    width: 100%; max-width: 600px; margin: 0 auto;
    padding-bottom: var(--safe-bottom);
  }

  /* ── Date picker calendar (mirrors Diary) ────────────────────────────────── */
  .dp-sheet { padding-bottom: 4px; }
  .dp-nav { display: flex; align-items: center; justify-content: space-between; padding: 12px 8px 8px; }
  .dp-nav-btn { color: var(--text-2); }
  .dp-nav-btn:disabled { opacity: 0.3; cursor: default; }
  .dp-month-year { display: flex; align-items: center; gap: 6px; }
  .dp-month-btn {
    font-size: 16px; font-weight: 700; color: var(--text-1);
    background: var(--surface-2); border: none; cursor: pointer;
    border-radius: var(--radius-sm); padding: 2px 8px;
    display: flex; align-items: center; transition: background var(--dur-fast);
  }
  .dp-month-btn:hover { background: var(--surface-3); }
  .dp-year-btn {
    font-size: 16px; font-weight: 700; color: var(--accent);
    background: var(--accent-dim); border: none; cursor: pointer;
    border-radius: var(--radius-sm); padding: 2px 8px;
    display: flex; align-items: center; transition: background var(--dur-fast);
  }
  .dp-year-btn:hover { background: color-mix(in srgb, var(--accent) 20%, transparent); }
  .dp-year-grid {
    display: grid; grid-template-columns: repeat(4, 1fr);
    gap: 4px; padding: 4px 8px 8px; max-height: 220px; overflow-y: auto;
  }
  .dp-yr-btn {
    padding: 8px 4px; font-size: 14px; font-weight: 500;
    border-radius: var(--radius-sm); background: none; border: none;
    cursor: pointer; color: var(--text-1); transition: background var(--dur-fast); text-align: center;
  }
  .dp-yr-btn:hover { background: var(--surface-2); }
  .dp-yr-btn.dp-yr-sel { background: var(--accent); color: #fff; font-weight: 700; }
  .dp-month-grid {
    display: grid; grid-template-columns: repeat(3, 1fr);
    gap: 4px; padding: 4px 8px 8px;
  }
  .dp-mo-btn {
    padding: 10px 4px; font-size: 14px; font-weight: 500;
    border-radius: var(--radius-sm); background: none; border: none;
    cursor: pointer; color: var(--text-1); transition: background var(--dur-fast); text-align: center;
  }
  .dp-mo-btn:hover { background: var(--surface-2); }
  .dp-mo-btn.dp-mo-sel { background: var(--accent); color: #fff; font-weight: 700; }
  .dp-grid {
    display: grid; grid-template-columns: repeat(7, 1fr);
    gap: 2px; padding: 0 8px 4px;
  }
  .dp-dh { text-align: center; font-size: 11px; font-weight: 600; color: var(--text-3); padding: 4px 0; }
  .dp-day {
    aspect-ratio: 1; display: flex; align-items: center; justify-content: center;
    font-size: 14px; border-radius: var(--radius-full);
    background: none; border: none; cursor: pointer;
    color: var(--text-1); transition: background var(--dur-fast);
    -webkit-tap-highlight-color: transparent;
  }
  .dp-day:hover:not(:disabled) { background: var(--surface-2); }
  .dp-day.dp-future { color: var(--text-3); }
  .dp-day.dp-future:hover { background: var(--surface-2); color: var(--text-2); }
  .dp-day.dp-today { color: var(--accent); font-weight: 700; }
  .dp-day.dp-sel { background: var(--accent) !important; color: #fff; font-weight: 600; }
  .dp-manual {
    display: flex; gap: 8px; padding: 8px 16px 16px; align-items: center;
    border-top: 1px solid var(--border); margin-top: 4px;
  }
  .segmental-table {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .seg-header {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    padding: 4px 8px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-3);
  }
  .seg-row {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    padding: 8px;
    border-radius: var(--radius-sm);
    background: var(--surface-2);
    font-size: 13px;
  }
  .seg-label {
    font-weight: 600;
    color: var(--text-2);
  }
  .seg-val {
    color: var(--text-1);
  }

  /* ── Workouts ── */
  .workout-list { display: flex; flex-direction: column; gap: 8px; }
  .workout-card {
    display: flex; align-items: center; gap: 12px; padding: 12px 14px;
    cursor: pointer; border: none; text-align: left; width: 100%;
    transition: transform 0.1s, box-shadow 0.1s;
  }
  .workout-card:active { transform: scale(0.98); }
  .workout-icon-wrap {
    width: 40px; height: 40px; border-radius: 10px;
    background: var(--accent-dim, rgba(100,200,180,0.15));
    display: flex; align-items: center; justify-content: center; flex-shrink: 0;
  }
  .workout-icon { font-size: 22px; color: var(--accent); }
  .workout-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .workout-name { font-size: 14px; font-weight: 600; color: var(--text-1); }
  .workout-meta { font-size: 12px; color: var(--text-3); }
  .workout-hr { font-size: 12px; color: var(--text-3); display: flex; align-items: center; gap: 3px; }
  .workout-trail { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }

  /* Workout detail modal */
  .workout-overlay {
    position: fixed; inset: 0; z-index: 9999;
    background: rgba(0,0,0,0.6); backdrop-filter: blur(4px);
    display: flex; align-items: center; justify-content: center;
    padding: 16px;
  }
  .workout-detail {
    background: var(--surface-1); border-radius: 16px;
    width: 100%; max-width: 520px; max-height: 90vh; overflow-y: auto;
    padding: 20px; box-shadow: 0 8px 32px rgba(0,0,0,0.3);
  }
  .workout-detail-header {
    display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 16px;
  }
  .workout-close {
    background: none; border: none; cursor: pointer; padding: 4px;
    color: var(--text-3); border-radius: 8px;
  }
  .workout-close:hover { background: var(--surface-2); }
  .workout-map {
    width: 100%; height: 280px; border-radius: 12px; overflow: hidden; margin-bottom: 16px;
    background: var(--surface-2);
  }
  .workout-map-placeholder {
    width: 100%; height: 140px; border-radius: 12px; margin-bottom: 16px;
    background: var(--surface-2); display: flex; align-items: center; justify-content: center;
    gap: 8px; color: var(--text-3); font-size: 14px;
  }
  .workout-stats-grid {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(80px, 1fr));
    gap: 12px; text-align: center;
  }
  .workout-stat {
    display: flex; flex-direction: column; gap: 2px;
    padding: 10px 4px; border-radius: 10px; background: var(--surface-2);
  }
  .workout-stat-val { font-size: 18px; font-weight: 700; color: var(--text-1); }
  .workout-stat-lbl { font-size: 11px; color: var(--text-3); text-transform: uppercase; letter-spacing: 0.5px; }

  @media (max-width: 400px) {
    .workout-stats-grid { grid-template-columns: repeat(3, 1fr); }
    .workout-map { height: 220px; }
    .workout-detail { padding: 14px; }
  }
</style>
