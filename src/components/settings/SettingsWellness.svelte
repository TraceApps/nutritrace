<script>
  import { onMount } from 'svelte';
  import { slide } from 'svelte/transition';
  import Toggle from './Toggle.svelte';
  import TimePicker from '../ui/TimePicker.svelte';
  import ConnectionStatus from './ConnectionStatus.svelte';
  import { showSuccess, showError } from '../../stores/toast.js';
  import {
    wellnessEnabled, fitbitEnabled, healthConnectEnabled, wellnessMetrics, workoutsEnabled,
    wellnessSyncRange,
    fitbitSyncMode, fitbitSyncInterval, fitbitSyncWindowStart, fitbitSyncWindowEnd,
    withingsSyncRange, withingsEnabled,
    withingsSyncMode, withingsSyncInterval, withingsSyncWindowStart, withingsSyncWindowEnd,
    garminEnabled, garminSyncRange,
    garminSyncMode, garminSyncInterval, garminSyncWindowStart, garminSyncWindowEnd,
    healthConnectSyncMode, healthConnectSyncInterval, healthConnectSyncWindowStart, healthConnectSyncWindowEnd,
  } from '../../stores/settings.js';
  import { DB } from '../../lib/db.js';
  import { NtApi } from '../../lib/api.js';
  import { currentUser, userMgmtActive } from '../../stores/auth.js';
  import { isNative, getServerUrl } from '../../lib/platform.js';
  const isNativeLocal = isNative && !getServerUrl();

  // ── Wellness state ──────────────────────────────────────────────────────────
  let wellnessEnabledVal   = DB.getSetting('wellnessEnabled',   false);
  let fitbitEnabledVal     = DB.getSetting('fitbitEnabled',     false);
  let withingsEnabledVal   = DB.getSetting('withingsEnabled',   false);
  let healthConnectEnabledVal = DB.getSetting('healthConnectEnabled', false);
  let workoutsEnabledVal     = DB.getSetting('workoutsEnabled',     false);
  let healthConnectAvailability = 'checking';
  let healthConnectPermissions = { read: [] };

  // Check Health Connect availability on mount
  if (isNative) {
    import('../../lib/health-connect.js').then(async ({ checkAvailability, getGrantedPermissions }) => {
      healthConnectAvailability = await checkAvailability();
      if (healthConnectAvailability === 'Available') {
        healthConnectPermissions = await getGrantedPermissions();
      }
    }).catch(() => { healthConnectAvailability = 'NotSupported'; });
  }

  // Auto-load config when component mounts (in case parent didn't call loadWellnessConfig)
  onMount(() => { loadWellnessConfig(); });

  // ── Wellness metric visibility (per integration, alphabetical by label) ──
  const FITBIT_METRICS = [
    { id: 'active_minutes',       label: 'Active Min'       },
    { id: 'active_zone_minutes',  label: 'Active Zone Min'  },
    { id: 'calories_out',         label: 'Calories'         },
    { id: 'sleep_deep_min',       label: 'Deep Sleep'       },
    { id: 'distance_km',          label: 'Distance'         },
    { id: 'floors',               label: 'Floors'           },
    { id: 'hrv_daily_rmssd',      label: 'HRV'              },
    { id: 'sleep_light_min',      label: 'Light Sleep'      },
    { id: 'sleep_rem_min',        label: 'REM Sleep'        },
    { id: 'respiratory_rate',     label: 'Resp. Rate'       },
    { id: 'resting_hr',           label: 'Resting HR'       },
    { id: 'sleep_duration_min',   label: 'Sleep Duration'   },
    { id: 'sleep_efficiency',     label: 'Sleep Efficiency' },
    { id: 'skin_temp_variation',  label: 'Skin Temp Var.'   },
    { id: 'sleep_score',          label: 'Sleep Score'      },
    { id: 'spo2_avg',             label: 'SpO2'             },
    { id: 'steps',                label: 'Steps'            },
    { id: 'vo2_max',              label: 'Cardio Fitness'   },
    { id: 'sleep_wake_min',       label: 'Wake Time'        },
  ];
  const GARMIN_METRICS = [
    { id: 'active_minutes',         label: 'Active Min'          },
    { id: 'body_battery_high',      label: 'Battery High'        },
    { id: 'body_battery_low',       label: 'Battery Low'         },
    { id: 'calories_out',           label: 'Calories'            },
    { id: 'sleep_deep_min',         label: 'Deep Sleep'          },
    { id: 'distance_km',            label: 'Distance'            },
    { id: 'floors',                 label: 'Floors'              },
    { id: 'hrv_daily_rmssd',        label: 'HRV'                 },
    { id: 'sleep_light_min',        label: 'Light Sleep'         },
    { id: 'max_hr',                 label: 'Max HR'              },
    { id: 'moderate_intensity_min', label: 'Moderate Intensity'  },
    { id: 'sleep_rem_min',          label: 'REM Sleep'           },
    { id: 'respiratory_rate',       label: 'Resp. Rate'          },
    { id: 'resting_hr',             label: 'Resting HR'          },
    { id: 'sleep_duration_min',     label: 'Sleep Duration'      },
    { id: 'sleep_score',            label: 'Sleep Score'         },
    { id: 'spo2_avg',               label: 'SpO2'                },
    { id: 'steps',                  label: 'Steps'               },
    { id: 'stress_avg',             label: 'Stress'              },
    { id: 'vigorous_intensity_min', label: 'Vigorous Intensity'  },
    { id: 'sleep_wake_min',         label: 'Wake Time'           },
  ];
  const WITHINGS_METRICS = [
    { id: 'ecg_afib',            label: 'AFib'               },
    { id: 'basal_metabolic_rate',     label: 'Basal Metabolic Rate' },
    { id: 'body_fat_pct',        label: 'Body Fat'           },
    { id: 'body_water_pct',      label: 'Body Water'         },
    { id: 'bone_mass_kg',        label: 'Bone Mass'          },
    { id: 'eda_feet',                 label: 'EDA Score'           },
    { id: 'ecg_heart_rate',           label: 'Heart Rate'          },
    { id: 'extracellular_water_kg',   label: 'Extracell. Water'    },
    { id: 'fat_mass_kg',              label: 'Fat Mass'            },
    { id: 'intracellular_water_kg',   label: 'Intracell. Water'    },
    { id: 'lean_mass_kg',             label: 'Lean Mass'           },
    { id: 'metabolic_age',            label: 'Metabolic Age'       },
    { id: 'muscle_mass_kg',           label: 'Muscle Mass'         },
    { id: 'nerve_health_score',       label: 'Nerve Health'        },
    { id: 'pulse_wave_velocity', label: 'Pulse Wave'         },
    { id: 'segmental_analysis',  label: 'Segmental Analysis' },
    { id: 'vascular_age',        label: 'Vascular Age'       },
    { id: 'visceral_fat',             label: 'Visceral Fat'        },
    { id: 'visceral_fat_index',       label: 'Visceral Fat Index'  },
    { id: 'weight_kg',                label: 'Weight'              },
  ];
  const HC_METRICS = [
    { id: 'active_calories',           label: 'Active Calories'     },
    { id: 'active_minutes',            label: 'Active Min'          },
    { id: 'avg_heart_rate',            label: 'Avg Heart Rate'      },
    { id: 'basal_metabolic_rate',      label: 'Basal Metabolic Rate'},
    { id: 'blood_pressure_systolic',   label: 'Blood Pressure (Sys)'},
    { id: 'blood_pressure_diastolic',  label: 'Blood Pressure (Dia)'},
    { id: 'body_fat_pct',             label: 'Body Fat'            },
    { id: 'body_temperature',          label: 'Body Temperature'    },
    { id: 'bone_mass_kg',             label: 'Bone Mass'           },
    { id: 'calories_out',             label: 'Calories'            },
    { id: 'distance_km',              label: 'Distance'            },
    { id: 'floors',                   label: 'Floors'              },
    { id: 'lean_mass_kg',             label: 'Lean Mass'           },
    { id: 'resting_hr',               label: 'Resting HR'          },
    { id: 'respiratory_rate',          label: 'Resp. Rate'          },
    { id: 'sleep_duration_min',        label: 'Sleep Duration'      },
    { id: 'sleep_deep_min',           label: 'Deep Sleep'          },
    { id: 'sleep_light_min',          label: 'Light Sleep'         },
    { id: 'sleep_rem_min',            label: 'REM Sleep'           },
    { id: 'sleep_awake_min',          label: 'Wake Time'           },
    { id: 'spo2_avg',                 label: 'SpO2'                },
    { id: 'steps',                    label: 'Steps'               },
    { id: 'vo2_max',                  label: 'Cardio Fitness'      },
    { id: 'water_ml',                 label: 'Hydration'           },
    { id: 'weight_kg',                label: 'Weight'              },
  ];

  function isWellnessMetricVisible(id) {
    const vis = $wellnessMetrics;
    return vis == null || vis.includes(id);
  }

  function toggleWellnessMetric(id) {
    const allIds = [...new Set([...FITBIT_METRICS, ...GARMIN_METRICS, ...WITHINGS_METRICS, ...HC_METRICS].map(m => m.id))];
    const cur = $wellnessMetrics ?? allIds;
    if (cur.includes(id)) {
      wellnessMetrics.set(cur.filter(x => x !== id));
    } else {
      wellnessMetrics.set([...cur, id]);
    }
  }

  let wellnessSyncRangeVal    = DB.getSetting('wellnessSyncRange',    7);

  // Per-device sync state — defaults to 'auto' mode + daily interval (1440 min)
  // when never set. Each device tracks its own values independently.
  const _defaultMode = 'auto';
  const _defaultInterval = 1440; // daily
  let fitbitSyncModeVal         = DB.getSetting('fitbitSyncMode',         _defaultMode);
  let fitbitSyncIntervalVal     = DB.getSetting('fitbitSyncInterval',     _defaultInterval);
  let fitbitSyncWindowStartVal  = DB.getSetting('fitbitSyncWindowStart',  '');
  let fitbitSyncWindowEndVal    = DB.getSetting('fitbitSyncWindowEnd',    '');
  let withingsSyncModeVal       = DB.getSetting('withingsSyncMode',       _defaultMode);
  let withingsSyncIntervalVal   = DB.getSetting('withingsSyncInterval',   _defaultInterval);
  let withingsSyncWindowStartVal= DB.getSetting('withingsSyncWindowStart','');
  let withingsSyncWindowEndVal  = DB.getSetting('withingsSyncWindowEnd',  '');
  let garminSyncModeVal         = DB.getSetting('garminSyncMode',         _defaultMode);
  let garminSyncIntervalVal     = DB.getSetting('garminSyncInterval',     _defaultInterval);
  let garminSyncWindowStartVal  = DB.getSetting('garminSyncWindowStart',  '');
  let garminSyncWindowEndVal    = DB.getSetting('garminSyncWindowEnd',    '');
  let hcSyncModeVal             = DB.getSetting('healthConnectSyncMode',         _defaultMode);
  let hcSyncIntervalVal         = DB.getSetting('healthConnectSyncInterval',     _defaultInterval);
  let hcSyncWindowStartVal      = DB.getSetting('healthConnectSyncWindowStart',  '');
  let hcSyncWindowEndVal        = DB.getSetting('healthConnectSyncWindowEnd',    '');

  const SYNC_INTERVALS = [
    { value: 30,   label: 'Every 30 min' },
    { value: 60,   label: 'Every hour' },
    { value: 120,  label: 'Every 2 hours' },
    { value: 180,  label: 'Every 3 hours' },
    { value: 360,  label: 'Every 6 hours' },
    { value: 720,  label: 'Every 12 hours' },
    { value: 1440, label: 'Once a day' },
  ];

  // Recommended range options shown first — safe for any device API
  const SYNC_RANGE_RECOMMENDED = [
    { value: 1,   label: '1 day'   },
    { value: 7,   label: '1 week'  },
    { value: 30,  label: '1 month' },
    { value: 90,  label: '3 months'},
  ];
  // Advanced range options — per device, since each API has different limits
  // Fitbit: 6m + 1y allowed (rate limited but workable)
  // Garmin: 6m only (API doesn't reliably deliver beyond ~6 months)
  // Withings: 6m + 1y allowed (most generous historical depth)
  const SYNC_RANGE_ADVANCED_FITBIT   = [ { value: 180, label: '6 months' }, { value: 365, label: '1 year' } ];
  const SYNC_RANGE_ADVANCED_GARMIN   = [ { value: 180, label: '6 months' } ];
  const SYNC_RANGE_ADVANCED_WITHINGS = [ { value: 180, label: '6 months' }, { value: 365, label: '1 year' } ];

  // All known options for "is this a known chip?" check (controls input-active highlight)
  const SYNC_RANGE_ALL_VALUES = new Set([1, 7, 30, 90, 180, 365]);

  // Custom number input max per device — soft cap, not enforced validation
  const CUSTOM_MAX_FITBIT   = 365;
  const CUSTOM_MAX_GARMIN   = 180;
  const CUSTOM_MAX_WITHINGS = 365;

  // ── Fitbit ──────────────────────────────────────────────────────────────────
  // Fitbit-card state vars. Credentials now hold a Google Cloud OAuth
  // client (the data is still Fitbit, just over the new Google Health
  // API pipe). State var names are kept for diff hygiene.
  let fitbitClientId     = '';
  let fitbitClientSecret = '';
  let fitbitRedirectUri  = '';
  let fitbitShowSecret   = false;
  let fitbitEditingCreds = false;
  let fitbitRedirectSuggested = '';
  let wellnessConfigLoaded = false;
  let fitbitConnectionStatus  = null;  // status from /api/wellness/google-health/status
  let legacyFitbitConnected   = false; // user has fitbit_tokens but no google_health_tokens — re-link prompt
  let disconnectingFitbit   = false;
  let connectingFitbit  = false;

  // ── Withings ────────────────────────────────────────────────────────────────
  let withingsClientId     = '';
  let withingsClientSecret = '';
  let withingsRedirectUri  = '';
  let withingsShowSecret   = false;
  let withingsEditingCreds = false;
  let withingsRedirectSuggested = '';
  let withingsSyncRangeVal = DB.getSetting('withingsSyncRange', 7);
  let withingsConnectionStatus = null;
  let disconnectingWithings = false;
  let connectingWithings = false;

  // ── Garmin ──────────────────────────────────────────────────────────────────
  let garminEnabledVal     = DB.getSetting('garminEnabled',   false);
  let garminSyncRangeVal   = DB.getSetting('garminSyncRange', 7);
  let garminConsumerKey    = '';
  let garminConsumerSecret = '';
  let garminRedirectUri    = '';
  let garminShowSecret     = false;
  let garminEditingCreds   = false;
  let garminRedirectSuggested = '';
  let garminConnectionStatus = null;
  let disconnectingGarmin    = false;
  let connectingGarmin       = false;

  // Format a timestamp as "X minutes/hours/days ago"
  function _timeAgo(isoStr) {
    if (!isoStr) return null;
    const diff = Date.now() - new Date(isoStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 2)   return 'just now';
    if (mins < 60)  return `${mins} minutes ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24)   return `${hrs} hour${hrs !== 1 ? 's' : ''} ago`;
    const days = Math.floor(hrs / 24);
    return `${days} day${days !== 1 ? 's' : ''} ago`;
  }

  export async function loadWellnessConfig() {
    if (wellnessConfigLoaded) return;
    wellnessConfigLoaded = true;
    // Fitbit redirect URI suggestion now points at the Google Health
    // callback (the new OAuth pipe). The data source label is still Fitbit.
    fitbitRedirectSuggested   = window.location.origin + '/api/wellness/google-health/callback';
    withingsRedirectSuggested = window.location.origin + '/api/wellness/withings/callback';
    garminRedirectSuggested   = window.location.origin + '/api/wellness/garmin/callback';
    // Load all configs in parallel.
    const isAdmin = $currentUser?.role === 'admin' || !$userMgmtActive;
    const [ghCfg, withingsCfg, garminCfg, appCfg] = await Promise.allSettled([
      NtApi.get('/api/wellness/google-health/config'),
      NtApi.get('/api/wellness/withings/config'),
      NtApi.get('/api/wellness/garmin/config'),
      isAdmin ? NtApi.get('/api/app-config') : Promise.resolve(null),
    ]);
    if (ghCfg.status === 'fulfilled' && ghCfg.value) {
      fitbitClientId    = ghCfg.value.client_id    || '';
      fitbitRedirectUri = ghCfg.value.redirect_uri || '';
    }
    if (withingsCfg.status === 'fulfilled' && withingsCfg.value) {
      withingsClientId    = withingsCfg.value.client_id    || '';
      withingsRedirectUri = withingsCfg.value.redirect_uri || '';
    }
    if (garminCfg.status === 'fulfilled' && garminCfg.value) {
      garminConsumerKey = garminCfg.value.consumer_key  || '';
      garminRedirectUri = garminCfg.value.redirect_uri  || '';
    }
    if (isAdmin && appCfg.status === 'fulfilled' && appCfg.value) {
      const cfg = appCfg.value;
      if (!fitbitClientId)       fitbitClientId       = cfg.google_health_client_id     || '';
      if (!fitbitClientSecret)   fitbitClientSecret   = cfg.google_health_client_secret || '';
      if (!fitbitRedirectUri)    fitbitRedirectUri    = cfg.google_health_redirect_uri  || '';
      if (!withingsClientId)     withingsClientId     = cfg.withings_client_id  || '';
      if (!withingsClientSecret) withingsClientSecret = cfg.withings_client_secret || '';
      if (!withingsRedirectUri)  withingsRedirectUri  = cfg.withings_redirect_uri  || '';
    }
    // Load connection status. fitbitConnectionStatus reflects the NEW path
    // (google-health). legacyFitbitConnected = true means the user still
    // has tokens from the old fitbit.com OAuth flow and should re-link.
    const [ghSt, legacyFitbitSt, withingsSt, garminSt] = await Promise.allSettled([
      NtApi.get('/api/wellness/google-health/status'),
      NtApi.get('/api/wellness/fitbit/status'),
      NtApi.get('/api/wellness/withings/status'),
      NtApi.get('/api/wellness/garmin/status'),
    ]);
    fitbitConnectionStatus   = ghSt.status === 'fulfilled' ? ghSt.value : { connected: false };
    legacyFitbitConnected    = (legacyFitbitSt.status === 'fulfilled' && legacyFitbitSt.value?.connected) === true
                                && !fitbitConnectionStatus.connected;
    withingsConnectionStatus = withingsSt.status === 'fulfilled' ? withingsSt.value : { connected: false };
    garminConnectionStatus   = garminSt.status   === 'fulfilled' ? garminSt.value   : { connected: false };
  }

  async function disconnectFitbitFromSettings() {
    disconnectingFitbit = true;
    try {
      // Disconnect both Google Health (new path) and legacy Fitbit Web API
      // (if still around). Either may not exist; ignore individual failures.
      await Promise.allSettled([
        NtApi.del('/api/wellness/google-health/disconnect'),
        NtApi.del('/api/wellness/fitbit/disconnect'),
      ]);
      fitbitConnectionStatus = { ...fitbitConnectionStatus, connected: false };
      legacyFitbitConnected = false;
      showSuccess('Disconnected from Fitbit');
    } catch(e) { showError(e.message); }
    disconnectingFitbit = false;
  }

  async function disconnectWithingsFromSettings() {
    disconnectingWithings = true;
    try {
      await NtApi.del('/api/wellness/withings/disconnect');
      withingsConnectionStatus = { ...withingsConnectionStatus, connected: false };
      showSuccess('Disconnected from Withings');
    } catch(e) { showError(e.message); }
    disconnectingWithings = false;
  }

  async function connectFitbitFromSettings() {
    // Connect now goes through the Google Health API (legacy dev.fitbit.com
    // OAuth doesn't accept new app registrations anymore — Sept 2026 cutoff
    // for the legacy API). The data source is still Fitbit, just a new pipe.
    connectingFitbit = true;
    try {
      const { url } = await NtApi.get('/api/wellness/google-health/authorize' + (isNative ? '?native=1' : ''));
      if (isNative) {
        const { openOAuth } = await import('../../lib/oauth-native.js');
        await openOAuth(url);
      } else {
        window.location.href = url;
      }
    } catch(e) {
      showError(e.message || 'Could not start Fitbit authorization');
      connectingFitbit = false;
    }
  }

  async function connectWithingsFromSettings() {
    connectingWithings = true;
    try {
      const { url } = await NtApi.get('/api/wellness/withings/authorize' + (isNative ? '?native=1' : ''));
      if (isNative) {
        const { openOAuth } = await import('../../lib/oauth-native.js');
        await openOAuth(url);
      } else {
        window.location.href = url;
      }
    } catch(e) {
      showError(e.message || 'Could not start Withings authorization');
      connectingWithings = false;
    }
  }

  async function saveFitbitConfig() {
    // Credentials are now Google Cloud OAuth client (new pipe to the same
    // Fitbit data). The fitbit* state var names are left as-is for diff
    // hygiene — they hold Google Cloud creds going forward.
    try {
      await NtApi.put('/api/wellness/google-health/config', {
        client_id:     fitbitClientId,
        client_secret: fitbitClientSecret || undefined,
        redirect_uri:  fitbitRedirectUri,
      });
      fitbitConnectionStatus = null;
      fitbitConnectionStatus = await NtApi.get('/api/wellness/google-health/status');
      fitbitEditingCreds = false;
      showSuccess('Fitbit credentials saved');
    } catch (e) { showError('Failed to save: ' + e.message); }
  }

  // ── Sync helpers — pull today's metrics from each provider ──────────────
  function _todayStr() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
  }

  let syncingFitbit = false;
  let lastSyncResult = null;  // { ok, count, date }
  async function syncFitbitNow() {
    syncingFitbit = true;
    lastSyncResult = null;
    try {
      const today = _todayStr();
      const r = await NtApi.post('/api/wellness/google-health/sync', { date: today });
      const dayResult = r?.results?.[today];
      if (dayResult?.ok) {
        lastSyncResult = { ok: true, count: dayResult.count, date: today };
        showSuccess(`Synced ${dayResult.count} metrics for ${today}`);
      } else {
        lastSyncResult = { ok: false, error: dayResult?.error || 'Unknown error' };
        showError(`Sync failed: ${lastSyncResult.error}`);
      }
    } catch (e) {
      lastSyncResult = { ok: false, error: e.message };
      showError('Sync failed: ' + e.message);
    }
    syncingFitbit = false;
  }

  let syncingWithings = false;
  async function syncWithingsNow() {
    syncingWithings = true;
    try {
      const today = _todayStr();
      const r = await NtApi.post('/api/wellness/withings/sync', { from: today, to: today });
      const count = r?.count ?? r?.results?.[today]?.count ?? 0;
      showSuccess(`Synced ${count} Withings metric${count === 1 ? '' : 's'} for ${today}`);
    } catch (e) {
      showError('Withings sync failed: ' + (e?.message || 'Unknown error'));
    }
    syncingWithings = false;
  }

  let syncingGarmin = false;
  async function syncGarminNow() {
    syncingGarmin = true;
    try {
      const today = _todayStr();
      const r = await NtApi.post('/api/wellness/garmin/sync', { from: today, to: today });
      const count = r?.count ?? r?.results?.[today]?.count ?? 0;
      showSuccess(`Synced ${count} Garmin metric${count === 1 ? '' : 's'} for ${today}`);
    } catch (e) {
      showError('Garmin sync failed: ' + (e?.message || 'Unknown error'));
    }
    syncingGarmin = false;
  }

  let syncingHc = false;
  async function syncHcNow() {
    syncingHc = true;
    try {
      const { syncHealthConnect } = await import('../../lib/health-connect.js');
      const today = _todayStr();
      const result = await syncHealthConnect(today);
      const count = result?.count ?? 0;
      showSuccess(`Synced ${count} Health Connect metric${count === 1 ? '' : 's'} for ${today}`);
    } catch (e) {
      showError('Health Connect sync failed: ' + (e?.message || 'Unknown error'));
    }
    syncingHc = false;
  }

  function copyRedirectUri() {
    navigator.clipboard.writeText(fitbitRedirectUri || fitbitRedirectSuggested).then(() => showSuccess('Copied'));
  }

  async function disconnectGarminFromSettings() {
    disconnectingGarmin = true;
    try {
      await NtApi.del('/api/wellness/garmin/disconnect');
      garminConnectionStatus = { ...garminConnectionStatus, connected: false };
      showSuccess('Disconnected from Garmin');
    } catch(e) { showError(e.message); }
    disconnectingGarmin = false;
  }

  async function connectGarminFromSettings() {
    connectingGarmin = true;
    try {
      const { url } = await NtApi.get('/api/wellness/garmin/authorize' + (isNative ? '?native=1' : ''));
      if (isNative) {
        const { openOAuth } = await import('../../lib/oauth-native.js');
        await openOAuth(url);
      } else {
        window.location.href = url;
      }
    } catch(e) {
      showError(e.message || 'Could not start Garmin authorization');
      connectingGarmin = false;
    }
  }

  async function saveGarminConfig() {
    try {
      await NtApi.put('/api/wellness/garmin/config', {
        consumer_key:    garminConsumerKey,
        consumer_secret: garminConsumerSecret || undefined,
        redirect_uri:    garminRedirectUri,
      });
      garminConnectionStatus = null;
      garminConnectionStatus = await NtApi.get('/api/wellness/garmin/status');
      garminEditingCreds = false;
      showSuccess('Garmin credentials saved');
    } catch(e) { showError('Failed to save: ' + e.message); }
  }

  function copyGarminRedirectUri() {
    navigator.clipboard.writeText(garminRedirectUri || garminRedirectSuggested).then(() => showSuccess('Copied'));
  }

  async function saveWithingsConfig() {
    try {
      await NtApi.put('/api/wellness/withings/config', {
        client_id:     withingsClientId,
        client_secret: withingsClientSecret || undefined,
        redirect_uri:  withingsRedirectUri,
      });
      withingsConnectionStatus = null;
      withingsConnectionStatus = await NtApi.get('/api/wellness/withings/status');
      withingsEditingCreds = false;
      showSuccess('Withings credentials saved');
    } catch (e) { showError('Failed to save: ' + e.message); }
  }

  function copyWithingsRedirectUri() {
    navigator.clipboard.writeText(withingsRedirectUri || withingsRedirectSuggested).then(() => showSuccess('Copied'));
  }
</script>

<div class="section-body" transition:slide={{ duration: 180 }}>

  <!-- Master toggle + sync mode -->
  <div class="card settings-card">
    <div class="setting-row">
      <div>
        <span class="setting-label">Activity Tracking</span>
        <div class="setting-desc">Adds a Wellness section for syncing fitness tracker and scale data.</div>
      </div>
      <Toggle checked={wellnessEnabledVal} on:change={e => { wellnessEnabledVal = e.detail; wellnessEnabled.set(e.detail); }} />
    </div>
    {#if wellnessEnabledVal}
      <div class="setting-divider"></div>
      <div class="setting-row">
        <div>
          <span class="setting-desc">Sync schedule is configured per device below.</span>
        </div>
      </div>
    {/if}
  </div>

  {#if wellnessEnabledVal}
    <!-- ── Fitbit ── -->
    <p class="sub-label" style="padding-top:16px">Fitbit</p>
    <div class="card settings-card">
      {#if !isNativeLocal && fitbitEnabledVal && fitbitConnectionStatus?.connected}
        <ConnectionStatus
          status="ok"
          okLabel="Linked"
          subtext={
            (fitbitConnectionStatus.fitbitUserId
              ? `Fitbit ID: ${fitbitConnectionStatus.fitbitUserId}`
              : 'Linked via Google Health')
            + (fitbitConnectionStatus.googleUserId ? ` · Google user: ${fitbitConnectionStatus.googleUserId}` : '')
          }
        >
          <svelte:fragment slot="action">
            <button class="status-retest" on:click={syncFitbitNow} disabled={syncingFitbit}>
              {syncingFitbit ? 'Syncing…' : 'Sync'}
            </button>
            <button class="status-retest status-danger" on:click={disconnectFitbitFromSettings} disabled={disconnectingFitbit}>
              {disconnectingFitbit ? 'Disconnecting…' : 'Disconnect'}
            </button>
          </svelte:fragment>
        </ConnectionStatus>
      {/if}
      {#if isNativeLocal}
        <div class="setting-row">
          <div>
            <span class="setting-label" style="opacity:0.5">Enable Fitbit</span>
            <div class="setting-desc">Requires a server connection for OAuth authentication. In local mode, use <strong>Health Connect</strong> below to read Fitbit data directly from your Android device.</div>
          </div>
        </div>
      {:else}
      <div class="setting-row">
        <div>
          <span class="setting-label">Enable Fitbit</span>
          <div class="setting-desc">Steps, activity, sleep stages, heart rate, HRV, SpO2</div>
        </div>
        <Toggle checked={fitbitEnabledVal} on:change={e => { fitbitEnabledVal = e.detail; fitbitEnabled.set(e.detail); }} />
      </div>
      {/if}

      {#if fitbitEnabledVal}
        <div class="setting-divider"></div>
        <div class="setting-row" style="align-items:flex-start;flex-direction:column;gap:8px">
          <div>
            <span class="setting-label">Sync Range</span>
            <div class="setting-desc">How far back the manual Sync button fetches. Auto-sync always covers today only.</div>
          </div>
          <div style="display:flex;flex-direction:column;gap:6px">
            <div class="chip-group">
              {#each SYNC_RANGE_RECOMMENDED as opt}
                <button class="chip" class:chip-active={wellnessSyncRangeVal === opt.value}
                  on:click={() => { wellnessSyncRangeVal = opt.value; wellnessSyncRange.set(opt.value); }}
                >{opt.label}</button>
              {/each}
            </div>
            <div class="chip-group">
              {#each SYNC_RANGE_ADVANCED_FITBIT as opt}
                <button class="chip" class:chip-active={wellnessSyncRangeVal === opt.value}
                  on:click={() => { wellnessSyncRangeVal = opt.value; wellnessSyncRange.set(opt.value); }}
                >{opt.label} ⚠</button>
              {/each}
              <div style="display:flex;align-items:center;gap:4px;margin-left:4px">
                <input class="input" type="number" min="1" max={CUSTOM_MAX_FITBIT} style="width:64px;height:32px;padding:0 8px;font-size:13px;text-align:center"
                  class:input-active={!SYNC_RANGE_ALL_VALUES.has(wellnessSyncRangeVal)}
                  value={wellnessSyncRangeVal}
                  on:change={e => { const v = Math.max(1, Math.min(CUSTOM_MAX_FITBIT, parseInt(e.target.value)||1)); wellnessSyncRangeVal = v; wellnessSyncRange.set(v); }}
                  placeholder="days" title="Custom number of days (max {CUSTOM_MAX_FITBIT})" />
                <span class="setting-desc" style="margin:0">days</span>
              </div>
            </div>
            <div class="setting-desc" style="font-size:11px;opacity:0.75">⚠ Long ranges may take several minutes and approach Fitbit API rate limits.</div>
          </div>
        </div>
        <div class="setting-divider"></div>
        <div class="setting-row">
          <span class="setting-label">Sync Mode</span>
          <div class="select-wrap" style="width:150px">
            <select class="select sel-sm" bind:value={fitbitSyncModeVal} on:change={e => fitbitSyncMode.set(e.target.value)}>
              <option value="auto">Auto (on open)</option>
              <option value="manual">Manual only</option>
              {#if !isNativeLocal}<option value="scheduled">Scheduled</option>{/if}
            </select>
          </div>
        </div>
        {#if fitbitSyncModeVal === 'scheduled'}
          <div class="setting-divider"></div>
          <div class="setting-row">
            <span class="setting-label">Interval</span>
            <div class="select-wrap" style="width:160px">
              <select class="select sel-sm" bind:value={fitbitSyncIntervalVal} on:change={e => fitbitSyncInterval.set(parseInt(e.target.value))}>
                {#each SYNC_INTERVALS as opt}<option value={opt.value}>{opt.label}</option>{/each}
              </select>
            </div>
          </div>
          <div class="setting-divider"></div>
          {#if fitbitSyncIntervalVal >= 1440}
            <div class="setting-row">
              <span class="setting-label">Sync At</span>
              <TimePicker value={fitbitSyncWindowStartVal || '14:00'} on:change={e => { fitbitSyncWindowStartVal = e.detail; fitbitSyncWindowStart.set(e.detail); fitbitSyncWindowEnd.set(null); }} />
            </div>
          {:else}
            <div class="setting-row" style="flex-direction:column;align-items:flex-start;gap:8px">
              <div>
                <span class="setting-label">Active Window</span>
                <div class="setting-desc">Only sync during these hours. Leave blank for all day.</div>
              </div>
              <div style="display:flex;gap:8px;align-items:center">
                <TimePicker value={fitbitSyncWindowStartVal} placeholder="Start" on:change={e => { fitbitSyncWindowStartVal = e.detail; fitbitSyncWindowStart.set(e.detail || null); }} />
                <span style="color:var(--text-3)">to</span>
                <TimePicker value={fitbitSyncWindowEndVal} placeholder="End" on:change={e => { fitbitSyncWindowEndVal = e.detail; fitbitSyncWindowEnd.set(e.detail || null); }} />
              </div>
            </div>
          {/if}
        {/if}
        <div class="setting-divider"></div>
        {#if legacyFitbitConnected}
          <!-- User is on the legacy dev.fitbit.com OAuth flow. Their tokens
               keep working until they expire OR the Sept 2026 cutoff,
               whichever comes first. Soft-prompt to re-link via the new
               Google Health pipe. -->
          <div class="setting-row" style="flex-direction:column;align-items:flex-start;gap:8px;background:var(--surface-2);padding:12px;border-radius:var(--radius-sm)">
            <div>
              <span class="setting-label">Re-link required by May 31, 2026</span>
              <div class="setting-desc" style="line-height:1.5">
                Fitbit data now flows through Google's new Health API.
                NutriTrace is removing the legacy Fitbit Web API code path
                on <strong>May 31, 2026</strong> (about four months before Google's
                own cutoff in September) to keep things current.
                Your existing connection still works until then, but
                re-link via Google Cloud now to avoid an interruption.
                No data is lost — your charts and history stay intact.
              </div>
            </div>
            <button class="btn btn-primary" style="height:32px;padding:0 12px;font-size:13px"
              on:click={() => { fitbitEditingCreds = true; fitbitConnectionStatus = { connected: false, configured: false }; }}>
              Re-link Fitbit
            </button>
          </div>
        {/if}
        {#if fitbitConnectionStatus === null}
          <div class="setting-row">
            <span class="setting-desc">Loading connection status…</span>
          </div>
        {:else if fitbitConnectionStatus.connected}
          {#if lastSyncResult}
            <div class="text-3 text-sm" style="padding:6px 12px;background:var(--surface-2);border-bottom:1px solid var(--border)">
              {#if lastSyncResult.ok}
                <span style="color:var(--macro-carbs)">✓ Synced {lastSyncResult.count} metrics for {lastSyncResult.date}</span>
              {:else}
                <span style="color:#FF7070">Sync error: {lastSyncResult.error}</span>
              {/if}
            </div>
          {/if}
        {:else if fitbitConnectionStatus.configured && !fitbitEditingCreds}
          <div class="setting-row">
            <div>
              <span class="setting-label">Not connected</span>
              <div class="setting-desc">Authorize NutriTrace to read your Fitbit data via Google Health.</div>
            </div>
            <div style="display:flex;gap:8px;align-items:center">
              <button class="btn btn-ghost" style="height:32px;padding:0 10px;font-size:13px" on:click={() => fitbitEditingCreds = true} title="Change API credentials">
                <span class="material-symbols-rounded" style="font-size:16px">edit</span>
              </button>
              <button class="btn btn-primary" style="height:32px;padding:0 12px;font-size:13px" on:click={connectFitbitFromSettings} disabled={connectingFitbit}>
                {connectingFitbit ? 'Connecting…' : 'Connect'}
              </button>
            </div>
          </div>
        {:else}
          <!-- No credentials yet — show inline setup form. As of late 2026
               Fitbit setup uses Google Cloud Console (dev.fitbit.com no
               longer accepts new app registrations). -->
          <div class="setting-row" style="flex-direction:column;align-items:flex-start;gap:12px">
            <div>
              <span class="setting-label">API Credentials</span>
              <div class="setting-desc" style="line-height:1.5">
                Fitbit setup now uses Google Cloud Console (legacy dev.fitbit.com no
                longer accepts new app registrations). Create an OAuth 2.0 client
                of type <strong>Web server</strong> and paste the Client ID + Secret here.
                <a href="https://developers.google.com/health/setup" target="_blank" rel="noopener" class="about-link">Setup guide →</a>
              </div>
            </div>
            <div style="width:100%;display:flex;flex-direction:column;gap:8px">
              <div class="form-group" style="margin:0">
                <label class="form-label">Client ID</label>
                <input class="input" type="text" autocomplete="off" placeholder="From Google Cloud Console → APIs & Services → Credentials"
                  bind:value={fitbitClientId} />
              </div>
              <div class="form-group" style="margin:0">
                <label class="form-label">Client Secret</label>
                <div style="display:flex;gap:6px">
                  {#if fitbitShowSecret}
                    <input class="input" type="text" autocomplete="new-password" placeholder="••••••••" bind:value={fitbitClientSecret} style="flex:1" />
                  {:else}
                    <input class="input" type="password" autocomplete="new-password" placeholder="••••••••" bind:value={fitbitClientSecret} style="flex:1" />
                  {/if}
                  <button class="btn-icon" on:click={() => fitbitShowSecret = !fitbitShowSecret} title={fitbitShowSecret ? 'Hide' : 'Show'}>
                    <span class="material-symbols-rounded">{fitbitShowSecret ? 'visibility_off' : 'visibility'}</span>
                  </button>
                </div>
              </div>
              <div class="form-group" style="margin:0">
                <label class="form-label">Redirect URI</label>
                <div class="setting-desc" style="margin-bottom:4px">Add this exact URI to your Google Cloud OAuth client's Authorized redirect URIs list</div>
                <div style="display:flex;gap:6px">
                  <input class="input" type="url" placeholder={fitbitRedirectSuggested} bind:value={fitbitRedirectUri} style="flex:1;font-size:12px" />
                  <button class="btn-icon" title="Use suggested" on:click={() => fitbitRedirectUri = fitbitRedirectSuggested}><span class="material-symbols-rounded">auto_awesome</span></button>
                  <button class="btn-icon" on:click={copyRedirectUri} title="Copy URI"><span class="material-symbols-rounded">content_copy</span></button>
                </div>
                <div class="setting-desc" style="font-size:11px;margin-top:2px">Format: <code style="font-size:11px">https://your-domain.com/api/wellness/google-health/callback</code></div>
              </div>
              <button class="btn btn-primary" style="align-self:flex-end" on:click={saveFitbitConfig}>{fitbitEditingCreds ? 'Save' : 'Save & Connect'}</button>
            </div>
          </div>
        {/if}
        <div class="setting-divider"></div>
        <div class="setting-row" style="align-items:flex-start;flex-direction:column;gap:8px">
          <span class="setting-label">Visible Metrics</span>
          <div class="chip-group" style="flex-wrap:wrap;gap:6px">
            {#each FITBIT_METRICS as m}
              <button class="chip" class:chip-active={$wellnessMetrics == null || $wellnessMetrics.includes(m.id)}
                on:click={() => toggleWellnessMetric(m.id)}>{m.label}</button>
            {/each}
          </div>
        </div>
        <div class="setting-divider"></div>
        <div class="setting-row">
          <div>
            <span class="setting-label">Workout History</span>
            <div class="setting-desc">Show recorded workouts with GPS route maps in the Movement tab. Requires a GPS-enabled device.</div>
          </div>
          <Toggle checked={workoutsEnabledVal} on:change={e => { workoutsEnabledVal = e.detail; workoutsEnabled.set(e.detail); }} />
        </div>
      {/if}
    </div>

    <!-- ── Garmin (Experimental) ── -->
    <p class="sub-label" style="padding-top:16px">
      Garmin
      <span class="labs-badge" style="background:linear-gradient(135deg,#6366f1,#8b5cf6)">Experimental</span>
    </p>
    <div class="card settings-card">
      {#if !isNativeLocal && garminEnabledVal && garminConnectionStatus?.connected}
        <ConnectionStatus
          status="ok"
          okLabel="Linked"
          subtext={
            (garminConnectionStatus.garminUserId || 'Garmin account linked')
            + (garminConnectionStatus.lastSyncedAt ? ` · Last synced ${_timeAgo(garminConnectionStatus.lastSyncedAt)}` : '')
          }
        >
          <svelte:fragment slot="action">
            <button class="status-retest" on:click={syncGarminNow} disabled={syncingGarmin}>
              {syncingGarmin ? 'Syncing…' : 'Sync'}
            </button>
            <button class="status-retest status-danger" on:click={disconnectGarminFromSettings} disabled={disconnectingGarmin}>
              {disconnectingGarmin ? 'Disconnecting…' : 'Disconnect'}
            </button>
          </svelte:fragment>
        </ConnectionStatus>
      {/if}
      {#if isNativeLocal}
        <div class="setting-row">
          <div>
            <span class="setting-label" style="opacity:0.5">Enable Garmin</span>
            <div class="setting-desc">Requires a server connection for OAuth authentication. In local mode, use <strong>Health Connect</strong> below to read Garmin data directly from your Android device.</div>
          </div>
        </div>
      {:else}
      <div class="setting-row">
        <div>
          <span class="setting-label">Enable Garmin</span>
          <div class="setting-desc">
            Steps, sleep, heart rate, HRV, SpO2, Body Battery, stress. Requires the <strong>Garmin Health API</strong> partnership.
            <a href="https://developer.garmin.com/gc-developer-program/health-api/" target="_blank" rel="noopener" class="about-link">Apply for access →</a>
          </div>
        </div>
        <Toggle checked={garminEnabledVal} on:change={e => { garminEnabledVal = e.detail; garminEnabled.set(e.detail); loadWellnessConfig(); }} />
      </div>
      {/if}

      {#if garminEnabledVal && !isNativeLocal}
        <div class="setting-divider"></div>
        <div class="setting-row" style="align-items:flex-start;flex-direction:column;gap:8px">
          <div>
            <span class="setting-label">Sync Range</span>
            <div class="setting-desc">How far back the manual Sync button fetches.</div>
          </div>
          <div style="display:flex;flex-direction:column;gap:6px">
            <div class="chip-group">
              {#each SYNC_RANGE_RECOMMENDED as opt}
                <button class="chip" class:chip-active={garminSyncRangeVal === opt.value}
                  on:click={() => { garminSyncRangeVal = opt.value; garminSyncRange.set(opt.value); }}
                >{opt.label}</button>
              {/each}
            </div>
            <div class="chip-group">
              {#each SYNC_RANGE_ADVANCED_GARMIN as opt}
                <button class="chip" class:chip-active={garminSyncRangeVal === opt.value}
                  on:click={() => { garminSyncRangeVal = opt.value; garminSyncRange.set(opt.value); }}
                >{opt.label} ⚠</button>
              {/each}
              <div style="display:flex;align-items:center;gap:4px;margin-left:4px">
                <input class="input" type="number" min="1" max={CUSTOM_MAX_GARMIN} style="width:64px;height:32px;padding:0 8px;font-size:13px;text-align:center"
                  class:input-active={!SYNC_RANGE_ALL_VALUES.has(garminSyncRangeVal)}
                  value={garminSyncRangeVal}
                  on:change={e => { const v = Math.max(1, Math.min(CUSTOM_MAX_GARMIN, parseInt(e.target.value)||1)); garminSyncRangeVal = v; garminSyncRange.set(v); }}
                  placeholder="days" title="Custom number of days (max {CUSTOM_MAX_GARMIN})" />
                <span class="setting-desc" style="margin:0">days</span>
              </div>
            </div>
            <div class="setting-desc" style="font-size:11px;opacity:0.75">⚠ Garmin's API caps reliable historical data near 6 months. Longer ranges may return incomplete results.</div>
          </div>
        </div>
        <div class="setting-divider"></div>
        <div class="setting-row">
          <span class="setting-label">Sync Mode</span>
          <div class="select-wrap" style="width:150px">
            <select class="select sel-sm" bind:value={garminSyncModeVal} on:change={e => garminSyncMode.set(e.target.value)}>
              <option value="auto">Auto (on open)</option>
              <option value="manual">Manual only</option>
              {#if !isNativeLocal}<option value="scheduled">Scheduled</option>{/if}
            </select>
          </div>
        </div>
        {#if garminSyncModeVal === 'scheduled'}
          <div class="setting-divider"></div>
          <div class="setting-row">
            <span class="setting-label">Interval</span>
            <div class="select-wrap" style="width:160px">
              <select class="select sel-sm" bind:value={garminSyncIntervalVal} on:change={e => garminSyncInterval.set(parseInt(e.target.value))}>
                {#each SYNC_INTERVALS as opt}<option value={opt.value}>{opt.label}</option>{/each}
              </select>
            </div>
          </div>
          <div class="setting-divider"></div>
          {#if garminSyncIntervalVal >= 1440}
            <div class="setting-row">
              <span class="setting-label">Sync At</span>
              <TimePicker value={garminSyncWindowStartVal || '14:00'} on:change={e => { garminSyncWindowStartVal = e.detail; garminSyncWindowStart.set(e.detail); garminSyncWindowEnd.set(null); }} />
            </div>
          {:else}
            <div class="setting-row" style="flex-direction:column;align-items:flex-start;gap:8px">
              <div>
                <span class="setting-label">Active Window</span>
                <div class="setting-desc">Only sync during these hours. Leave blank for all day.</div>
              </div>
              <div style="display:flex;gap:8px;align-items:center">
                <TimePicker value={garminSyncWindowStartVal} placeholder="Start" on:change={e => { garminSyncWindowStartVal = e.detail; garminSyncWindowStart.set(e.detail || null); }} />
                <span style="color:var(--text-3)">to</span>
                <TimePicker value={garminSyncWindowEndVal} placeholder="End" on:change={e => { garminSyncWindowEndVal = e.detail; garminSyncWindowEnd.set(e.detail || null); }} />
              </div>
            </div>
          {/if}
        {/if}
        <div class="setting-divider"></div>
        {#if garminConnectionStatus === null}
          <div class="setting-row">
            <span class="setting-desc">Loading connection status…</span>
          </div>
        {:else if garminConnectionStatus.connected}
          <!-- Connected state rendered as the top-of-card banner; nothing else here. -->
        {:else if garminConnectionStatus.configured && !garminEditingCreds}
          <div class="setting-row">
            <div>
              <span class="setting-label">Not connected</span>
              <div class="setting-desc">Authorize NutriTrace to read your Garmin data.</div>
            </div>
            <div style="display:flex;gap:8px;align-items:center">
              <button class="btn btn-ghost" style="height:32px;padding:0 10px;font-size:13px" on:click={() => garminEditingCreds = true} title="Change API credentials">
                <span class="material-symbols-rounded" style="font-size:16px">edit</span>
              </button>
              <button class="btn btn-primary" style="height:32px;padding:0 12px;font-size:13px" on:click={connectGarminFromSettings} disabled={connectingGarmin}>
                {connectingGarmin ? 'Connecting…' : 'Connect'}
              </button>
            </div>
          </div>
        {:else}
          <div class="setting-row" style="flex-direction:column;align-items:flex-start;gap:12px">
            <div>
              <span class="setting-label">API Credentials</span>
              <div class="setting-desc" style="line-height:1.4">
                OAuth 1.0a credentials from your approved Garmin Health API app. Redirect URI must match exactly.
                <a href="https://developer.garmin.com/gc-developer-program/health-api/" target="_blank" rel="noopener" class="about-link">Get API credentials →</a>
              </div>
            </div>
            <div style="width:100%;display:flex;flex-direction:column;gap:8px">
              <div class="form-group" style="margin:0">
                <label class="form-label">Consumer Key</label>
                <input class="input" type="text" autocomplete="off" placeholder="Your Garmin Consumer Key"
                  bind:value={garminConsumerKey} />
              </div>
              <div class="form-group" style="margin:0">
                <label class="form-label">Consumer Secret</label>
                <div style="display:flex;gap:6px">
                  {#if garminShowSecret}
                    <input class="input" type="text" autocomplete="new-password" placeholder="••••••••" bind:value={garminConsumerSecret} style="flex:1" />
                  {:else}
                    <input class="input" type="password" autocomplete="new-password" placeholder="••••••••" bind:value={garminConsumerSecret} style="flex:1" />
                  {/if}
                  <button class="btn-icon" on:click={() => garminShowSecret = !garminShowSecret} title={garminShowSecret ? 'Hide' : 'Show'}>
                    <span class="material-symbols-rounded">{garminShowSecret ? 'visibility_off' : 'visibility'}</span>
                  </button>
                </div>
              </div>
              <div class="form-group" style="margin:0">
                <label class="form-label">Redirect URI</label>
                <div class="setting-desc" style="margin-bottom:4px">Register this exact URI in your Garmin app settings</div>
                <div style="display:flex;gap:6px">
                  <input class="input" type="url" placeholder={garminRedirectSuggested} bind:value={garminRedirectUri} style="flex:1;font-size:12px" />
                  <button class="btn-icon" title="Use suggested" on:click={() => garminRedirectUri = garminRedirectSuggested}><span class="material-symbols-rounded">auto_awesome</span></button>
                  <button class="btn-icon" on:click={copyGarminRedirectUri} title="Copy URI"><span class="material-symbols-rounded">content_copy</span></button>
                </div>
                <div class="setting-desc" style="font-size:11px;margin-top:2px">Format: <code style="font-size:11px">https://your-domain.com/api/wellness/garmin/callback</code></div>
              </div>
              <button class="btn btn-primary" style="align-self:flex-end" on:click={saveGarminConfig}>{garminEditingCreds ? 'Save' : 'Save & Connect'}</button>
            </div>
          </div>
        {/if}
        <div class="setting-divider"></div>
        <div class="setting-row" style="align-items:flex-start;flex-direction:column;gap:8px">
          <span class="setting-label">Visible Metrics</span>
          <div class="chip-group" style="flex-wrap:wrap;gap:6px">
            {#each GARMIN_METRICS as m}
              <button class="chip" class:chip-active={$wellnessMetrics == null || $wellnessMetrics.includes(m.id)}
                on:click={() => toggleWellnessMetric(m.id)}>{m.label}</button>
            {/each}
          </div>
        </div>
      {/if}
    </div>

    <!-- ── Withings ── -->
    <p class="sub-label" style="padding-top:16px">Withings</p>
    <div class="card settings-card">
      {#if !isNativeLocal && withingsEnabledVal && withingsConnectionStatus?.connected}
        <ConnectionStatus
          status="ok"
          okLabel="Linked"
          subtext={
            (withingsConnectionStatus.withingsUserId ? `User ${withingsConnectionStatus.withingsUserId}` : 'Withings account linked')
            + (withingsConnectionStatus.lastSyncedAt ? ` · Last synced ${_timeAgo(withingsConnectionStatus.lastSyncedAt)}` : '')
          }
        >
          <svelte:fragment slot="action">
            <button class="status-retest" on:click={syncWithingsNow} disabled={syncingWithings}>
              {syncingWithings ? 'Syncing…' : 'Sync'}
            </button>
            <button class="status-retest status-danger" on:click={disconnectWithingsFromSettings} disabled={disconnectingWithings}>
              {disconnectingWithings ? 'Disconnecting…' : 'Disconnect'}
            </button>
          </svelte:fragment>
        </ConnectionStatus>
      {/if}
      {#if isNativeLocal}
        <div class="setting-row">
          <div>
            <span class="setting-label" style="opacity:0.5">Enable Withings</span>
            <div class="setting-desc">Requires a server connection for OAuth authentication. In local mode, use <strong>Health Connect</strong> below to read Withings data directly from your Android device.</div>
          </div>
        </div>
      {:else}
      <div class="setting-row">
        <div>
          <span class="setting-label">Enable Withings</span>
          <div class="setting-desc">
            Body composition from scales (weight, fat %, muscle, bone mass, and more).
            <a href="https://developer.withings.com/dashboard/" target="_blank" rel="noopener" class="about-link">Developer dashboard →</a>
          </div>
        </div>
        <Toggle checked={withingsEnabledVal} on:change={e => { withingsEnabledVal = e.detail; withingsEnabled.set(e.detail); }} />
      </div>
      {/if}

      {#if withingsEnabledVal && !isNativeLocal}
        <div class="setting-divider"></div>
        <div class="setting-row" style="align-items:flex-start;flex-direction:column;gap:8px">
          <div>
            <span class="setting-label">Sync Range</span>
            <div class="setting-desc">How far back the manual Sync button fetches.</div>
          </div>
          <div style="display:flex;flex-direction:column;gap:6px">
            <div class="chip-group">
              {#each SYNC_RANGE_RECOMMENDED as opt}
                <button class="chip" class:chip-active={withingsSyncRangeVal === opt.value}
                  on:click={() => { withingsSyncRangeVal = opt.value; withingsSyncRange.set(opt.value); }}
                >{opt.label}</button>
              {/each}
            </div>
            <div class="chip-group">
              {#each SYNC_RANGE_ADVANCED_WITHINGS as opt}
                <button class="chip" class:chip-active={withingsSyncRangeVal === opt.value}
                  on:click={() => { withingsSyncRangeVal = opt.value; withingsSyncRange.set(opt.value); }}
                >{opt.label} ⚠</button>
              {/each}
              <div style="display:flex;align-items:center;gap:4px;margin-left:4px">
                <input class="input" type="number" min="1" max={CUSTOM_MAX_WITHINGS} style="width:64px;height:32px;padding:0 8px;font-size:13px;text-align:center"
                  class:input-active={!SYNC_RANGE_ALL_VALUES.has(withingsSyncRangeVal)}
                  value={withingsSyncRangeVal}
                on:change={e => { const v = Math.max(1, Math.min(CUSTOM_MAX_WITHINGS, parseInt(e.target.value)||1)); withingsSyncRangeVal = v; withingsSyncRange.set(v); }}
                placeholder="days" title="Custom number of days (max {CUSTOM_MAX_WITHINGS})" />
              <span class="setting-desc" style="margin:0">days</span>
            </div>
            </div>
            <div class="setting-desc" style="font-size:11px;opacity:0.75">⚠ Long ranges may take several minutes and approach Withings API rate limits.</div>
          </div>
        </div>
        <div class="setting-divider"></div>
        <div class="setting-row">
          <span class="setting-label">Sync Mode</span>
          <div class="select-wrap" style="width:150px">
            <select class="select sel-sm" bind:value={withingsSyncModeVal} on:change={e => withingsSyncMode.set(e.target.value)}>
              <option value="auto">Auto (on open)</option>
              <option value="manual">Manual only</option>
              {#if !isNativeLocal}<option value="scheduled">Scheduled</option>{/if}
            </select>
          </div>
        </div>
        {#if withingsSyncModeVal === 'scheduled'}
          <div class="setting-divider"></div>
          <div class="setting-row">
            <span class="setting-label">Interval</span>
            <div class="select-wrap" style="width:160px">
              <select class="select sel-sm" bind:value={withingsSyncIntervalVal} on:change={e => withingsSyncInterval.set(parseInt(e.target.value))}>
                {#each SYNC_INTERVALS as opt}<option value={opt.value}>{opt.label}</option>{/each}
              </select>
            </div>
          </div>
          <div class="setting-divider"></div>
          {#if withingsSyncIntervalVal >= 1440}
            <div class="setting-row">
              <span class="setting-label">Sync At</span>
              <TimePicker value={withingsSyncWindowStartVal || '14:00'} on:change={e => { withingsSyncWindowStartVal = e.detail; withingsSyncWindowStart.set(e.detail); withingsSyncWindowEnd.set(null); }} />
            </div>
          {:else}
            <div class="setting-row" style="flex-direction:column;align-items:flex-start;gap:8px">
              <div>
                <span class="setting-label">Active Window</span>
                <div class="setting-desc">Only sync during these hours. Leave blank for all day.</div>
              </div>
              <div style="display:flex;gap:8px;align-items:center">
                <TimePicker value={withingsSyncWindowStartVal} placeholder="Start" on:change={e => { withingsSyncWindowStartVal = e.detail; withingsSyncWindowStart.set(e.detail || null); }} />
                <span style="color:var(--text-3)">to</span>
                <TimePicker value={withingsSyncWindowEndVal} placeholder="End" on:change={e => { withingsSyncWindowEndVal = e.detail; withingsSyncWindowEnd.set(e.detail || null); }} />
              </div>
            </div>
          {/if}
        {/if}
        <div class="setting-divider"></div>
        {#if withingsConnectionStatus === null}
          <div class="setting-row">
            <span class="setting-desc">Loading connection status…</span>
          </div>
        {:else if withingsConnectionStatus.connected}
          <!-- Connected state rendered as the top-of-card banner; nothing else here. -->
        {:else if withingsConnectionStatus.configured && !withingsEditingCreds}
          <div class="setting-row">
            <div>
              <span class="setting-label">Not connected</span>
              <div class="setting-desc">Authorize NutriTrace to read your Withings data.</div>
            </div>
            <div style="display:flex;gap:8px;align-items:center">
              <button class="btn btn-ghost" style="height:32px;padding:0 10px;font-size:13px" on:click={() => withingsEditingCreds = true} title="Change API credentials">
                <span class="material-symbols-rounded" style="font-size:16px">edit</span>
              </button>
              <button class="btn btn-primary" style="height:32px;padding:0 12px;font-size:13px" on:click={connectWithingsFromSettings} disabled={connectingWithings}>
                {connectingWithings ? 'Connecting…' : 'Connect'}
              </button>
            </div>
          </div>
        {:else}
          <!-- No credentials yet — show inline setup form -->
          <div class="setting-row" style="flex-direction:column;align-items:flex-start;gap:12px">
            <div>
              <span class="setting-label">API Credentials</span>
              <div class="setting-desc" style="line-height:1.4">
                Create a Withings developer account and a new application of type "Personal use" or "Public Cloud Partner". Then paste the Client ID + Secret here and add the redirect URI below to your app's authorized list.
                <a href="https://developer.withings.com/dashboard/" target="_blank" rel="noopener" class="about-link">Withings developer dashboard →</a>
              </div>
            </div>
            <div style="width:100%;display:flex;flex-direction:column;gap:8px">
              <div class="form-group" style="margin:0">
                <label class="form-label">Client ID</label>
                <input class="input" type="text" autocomplete="off" placeholder="e.g. abc123def456"
                  bind:value={withingsClientId} />
              </div>
              <div class="form-group" style="margin:0">
                <label class="form-label">Client Secret</label>
                <div style="display:flex;gap:6px">
                  {#if withingsShowSecret}
                    <input class="input" type="text" autocomplete="new-password" placeholder="••••••••" bind:value={withingsClientSecret} style="flex:1" />
                  {:else}
                    <input class="input" type="password" autocomplete="new-password" placeholder="••••••••" bind:value={withingsClientSecret} style="flex:1" />
                  {/if}
                  <button class="btn-icon" on:click={() => withingsShowSecret = !withingsShowSecret} title={withingsShowSecret ? 'Hide' : 'Show'}>
                    <span class="material-symbols-rounded">{withingsShowSecret ? 'visibility_off' : 'visibility'}</span>
                  </button>
                </div>
              </div>
              <div class="form-group" style="margin:0">
                <label class="form-label">Redirect URI</label>
                <div class="setting-desc" style="margin-bottom:4px">Add this exact URI to your Withings app's redirect URL list</div>
                <div style="display:flex;gap:6px">
                  <input class="input" type="url" placeholder={withingsRedirectSuggested} bind:value={withingsRedirectUri} style="flex:1;font-size:12px" />
                  <button class="btn-icon" title="Use suggested" on:click={() => withingsRedirectUri = withingsRedirectSuggested}><span class="material-symbols-rounded">auto_awesome</span></button>
                  <button class="btn-icon" on:click={copyWithingsRedirectUri} title="Copy URI"><span class="material-symbols-rounded">content_copy</span></button>
                </div>
                <div class="setting-desc" style="font-size:11px;margin-top:2px">Format: <code style="font-size:11px">https://your-domain.com/api/wellness/withings/callback</code></div>
              </div>
              <button class="btn btn-primary" style="align-self:flex-end" on:click={saveWithingsConfig}>{withingsEditingCreds ? 'Save' : 'Save & Connect'}</button>
            </div>
          </div>
        {/if}
        <div class="setting-divider"></div>
        <div class="setting-row" style="align-items:flex-start;flex-direction:column;gap:8px">
          <span class="setting-label">Visible Metrics</span>
          <div class="chip-group" style="flex-wrap:wrap;gap:6px">
            {#each WITHINGS_METRICS as m}
              <button class="chip" class:chip-active={$wellnessMetrics == null || $wellnessMetrics.includes(m.id)}
                on:click={() => toggleWellnessMetric(m.id)}>{m.label}</button>
            {/each}
          </div>
        </div>
      {/if}
    </div>

    <!-- Health Connect (Android only) -->
    {#if isNative}
      <p class="sub-label" style="padding-top:16px">
        Health Connect
      </p>
      <div class="card settings-card">
        {#if healthConnectEnabledVal && healthConnectAvailability === 'Available'}
          <ConnectionStatus
            status="ok"
            okLabel="Permission granted"
            subtext={`${healthConnectPermissions.read.length} data type${healthConnectPermissions.read.length === 1 ? '' : 's'} readable from Health Connect`}
          >
            <svelte:fragment slot="action">
              <button class="status-retest" on:click={syncHcNow} disabled={syncingHc}>
                {syncingHc ? 'Syncing…' : 'Sync'}
              </button>
            </svelte:fragment>
          </ConnectionStatus>
        {:else if healthConnectEnabledVal && healthConnectAvailability === 'NotInstalled'}
          <ConnectionStatus
            status="fail"
            error="Health Connect is not installed. Install it from the Play Store."
          />
        {/if}
        <div class="setting-row">
          <div>
            <span class="setting-label">Enable Health Connect</span>
            <div class="setting-desc">Read steps, heart rate, sleep, weight, and activity from Android Health Connect. Data from any connected wearable.</div>
          </div>
          <Toggle checked={healthConnectEnabledVal} on:change={async e => {
            const enabled = e.detail;
            if (enabled) {
              if (healthConnectAvailability !== 'Available') {
                showError(healthConnectAvailability === 'NotInstalled' ? 'Health Connect is not installed. Install it from the Play Store.' : 'Health Connect is not supported on this device.');
                return;
              }
              const { requestPermissions } = await import('../../lib/health-connect.js');
              const perms = await requestPermissions();
              if (perms.read.length === 0) {
                showError('Permissions not granted. Try opening Health Connect app → App permissions → NutriTrace and enable manually.');
                // Still enable the setting — user can grant manually later
              }
              healthConnectPermissions = perms;
              showSuccess(`Health Connect enabled (${perms.read.length} data types)`);
            }
            healthConnectEnabledVal = enabled;
            healthConnectEnabled.set(enabled);
          }} />
        </div>
        {#if healthConnectEnabledVal}
          {#if healthConnectAvailability !== 'Available' && healthConnectAvailability !== 'NotInstalled'}
            <div class="setting-divider"></div>
            <div class="setting-row">
              <div>
                <span class="setting-label">Status</span>
                <div class="setting-desc" style="color:var(--text-3)">Not supported on this device</div>
              </div>
            </div>
          {/if}
          <div class="setting-divider"></div>
          <div class="setting-row">
            <span class="setting-label">Sync Mode</span>
            <div class="select-wrap" style="width:150px">
              <select class="select sel-sm" bind:value={hcSyncModeVal} on:change={e => healthConnectSyncMode.set(e.target.value)}>
                <option value="auto">Auto (on open)</option>
                <option value="manual">Manual only</option>
                <option value="scheduled">Scheduled</option>
              </select>
            </div>
          </div>
          {#if hcSyncModeVal === 'scheduled'}
            <div class="setting-divider"></div>
            <div class="setting-row">
              <span class="setting-label">Interval</span>
              <div class="select-wrap" style="width:160px">
                <select class="select sel-sm" bind:value={hcSyncIntervalVal} on:change={e => healthConnectSyncInterval.set(parseInt(e.target.value))}>
                  {#each SYNC_INTERVALS as opt}<option value={opt.value}>{opt.label}</option>{/each}
                </select>
              </div>
            </div>
            <div class="setting-divider"></div>
            {#if hcSyncIntervalVal >= 1440}
              <div class="setting-row">
                <span class="setting-label">Sync At</span>
                <TimePicker value={hcSyncWindowStartVal || '14:00'} on:change={e => { hcSyncWindowStartVal = e.detail; healthConnectSyncWindowStart.set(e.detail); healthConnectSyncWindowEnd.set(null); }} />
              </div>
            {:else}
              <div class="setting-row" style="flex-direction:column;align-items:flex-start;gap:8px">
                <div>
                  <span class="setting-label">Active Window</span>
                  <div class="setting-desc">Only sync during these hours. Leave blank for all day.</div>
                </div>
                <div style="display:flex;gap:8px;align-items:center">
                  <TimePicker value={hcSyncWindowStartVal} placeholder="Start" on:change={e => { hcSyncWindowStartVal = e.detail; healthConnectSyncWindowStart.set(e.detail || null); }} />
                  <span style="color:var(--text-3)">to</span>
                  <TimePicker value={hcSyncWindowEndVal} placeholder="End" on:change={e => { hcSyncWindowEndVal = e.detail; healthConnectSyncWindowEnd.set(e.detail || null); }} />
                </div>
              </div>
            {/if}
          {/if}
          <div class="setting-divider"></div>
          <div class="setting-row" style="align-items:flex-start;flex-direction:column;gap:8px">
            <span class="setting-label">Visible Metrics</span>
            <div class="chip-group" style="flex-wrap:wrap;gap:6px">
              {#each HC_METRICS as m}
                <button class="chip" class:chip-active={$wellnessMetrics == null || $wellnessMetrics.includes(m.id)}
                  on:click={() => toggleWellnessMetric(m.id)}>{m.label}</button>
              {/each}
            </div>
          </div>
        {/if}
      </div>
    {/if}

    <!-- Global metric reset — sits at the very end of the wellness group so
         users understand it applies across all providers, not just the last
         one shown. -->
    <div style="display:flex;justify-content:flex-end;margin-top:8px">
      <button class="btn btn-secondary btn-sm" on:click={() => wellnessMetrics.set(null)}>
        Reset all visible metrics
      </button>
    </div>
  {/if}

</div>

<style>
  /* Mirror Settings.svelte scoped styles so cards look identical */
  .section-body { padding: 12px var(--page-px); display: flex; flex-direction: column; gap: 10px; }
  .settings-card {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  .setting-row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 13px 16px;
    min-height: 50px;
  }
  .setting-label { font-size: 14px; font-weight: 500; flex: 1; }
  .setting-desc  { font-size: 12px; color: var(--text-3); margin-top: 2px; font-weight: 400; }
  .setting-divider { height: 1px; background: var(--border); margin: 0 16px; }
  .sel-sm { height: 36px; font-size: 13px; }

  .sub-label {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-3);
    padding: 4px 2px 2px;
  }

  .form-group { display: flex; flex-direction: column; gap: 6px; }
  .form-label { font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-3); }

  .chip-group {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    max-width: 100%;
  }
  .chip {
    padding: 4px 12px;
    border-radius: 99px;
    border: 1.5px solid var(--border);
    background: transparent;
    color: var(--text-2);
    font-size: 13px;
    cursor: pointer;
    transition: border-color 0.15s, background 0.15s, color 0.15s;
  }
  .chip:hover { border-color: var(--accent); color: var(--text-1); }
  .chip-active {
    border-color: var(--accent);
    background: var(--accent-dim);
    color: var(--accent);
    font-weight: 600;
  }
  .input-active {
    border-color: var(--accent);
    background: var(--accent-dim);
    color: var(--accent);
    font-weight: 600;
  }

  .labs-badge {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    background: linear-gradient(135deg, #f59e0b, #ef4444);
    color: #fff;
    padding: 2px 6px;
    border-radius: 99px;
    margin-left: 6px;
    vertical-align: middle;
  }
</style>
