<script>
  import { onMount } from 'svelte';
  import { slide } from 'svelte/transition';
  import Toggle from './Toggle.svelte';
  import TimePicker from '../ui/TimePicker.svelte';
  import { showSuccess, showError } from '../../stores/toast.js';
  import {
    wellnessEnabled, fitbitEnabled, healthConnectEnabled, wellnessMetrics, workoutsEnabled,
    wellnessSyncMode, wellnessSyncSchedule, wellnessSyncTime, wellnessSyncRange,
    withingsSyncRange, withingsEnabled,
    garminEnabled, garminSyncRange,
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

  let wellnessSyncModeVal     = DB.getSetting('wellnessSyncMode',     'auto');
  let wellnessSyncScheduleVal = DB.getSetting('wellnessSyncSchedule', 'daily');
  let wellnessSyncTimeVal     = DB.getSetting('wellnessSyncTime',     '14:00');
  let wellnessSyncRangeVal    = DB.getSetting('wellnessSyncRange',    7);

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
  let fitbitClientId     = '';
  let fitbitClientSecret = '';
  let fitbitRedirectUri  = '';
  let fitbitShowSecret   = false;
  let fitbitEditingCreds = false;
  let fitbitRedirectSuggested = '';
  let wellnessConfigLoaded = false;
  let fitbitConnectionStatus  = null;
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
    fitbitRedirectSuggested = window.location.origin + '/api/wellness/fitbit/callback';
    withingsRedirectSuggested = window.location.origin + '/api/wellness/withings/callback';
    garminRedirectSuggested = window.location.origin + '/api/wellness/garmin/callback';
    // Load all configs in parallel
    const isAdmin = $currentUser?.role === 'admin' || !$userMgmtActive;
    const [fitbitCfg, withingsCfg, garminCfg, appCfg] = await Promise.allSettled([
      NtApi.get('/api/wellness/fitbit/config'),
      NtApi.get('/api/wellness/withings/config'),
      NtApi.get('/api/wellness/garmin/config'),
      isAdmin ? NtApi.get('/api/app-config') : Promise.resolve(null),
    ]);
    if (fitbitCfg.status === 'fulfilled' && fitbitCfg.value) {
      fitbitClientId    = fitbitCfg.value.client_id    || '';
      fitbitRedirectUri = fitbitCfg.value.redirect_uri || '';
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
      if (!fitbitClientId)       fitbitClientId       = cfg.fitbit_client_id       || '';
      if (!fitbitClientSecret)   fitbitClientSecret   = cfg.fitbit_client_secret   || '';
      if (!fitbitRedirectUri)    fitbitRedirectUri    = cfg.fitbit_redirect_uri    || '';
      if (!withingsClientId)     withingsClientId     = cfg.withings_client_id     || '';
      if (!withingsClientSecret) withingsClientSecret = cfg.withings_client_secret || '';
      if (!withingsRedirectUri)  withingsRedirectUri  = cfg.withings_redirect_uri  || '';
    }
    // Load connection status for all users (in parallel)
    const [fitbitSt, withingsSt, garminSt] = await Promise.allSettled([
      NtApi.get('/api/wellness/fitbit/status'),
      NtApi.get('/api/wellness/withings/status'),
      NtApi.get('/api/wellness/garmin/status'),
    ]);
    fitbitConnectionStatus   = fitbitSt.status   === 'fulfilled' ? fitbitSt.value   : { connected: false };
    withingsConnectionStatus = withingsSt.status === 'fulfilled' ? withingsSt.value : { connected: false };
    garminConnectionStatus   = garminSt.status   === 'fulfilled' ? garminSt.value   : { connected: false };
  }

  async function disconnectFitbitFromSettings() {
    disconnectingFitbit = true;
    try {
      await NtApi.del('/api/wellness/fitbit/disconnect');
      fitbitConnectionStatus = { ...fitbitConnectionStatus, connected: false };
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
    connectingFitbit = true;
    try {
      const { url } = await NtApi.get('/api/wellness/fitbit/authorize' + (isNative ? '?native=1' : ''));
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
    try {
      await NtApi.put('/api/wellness/fitbit/config', {
        client_id:     fitbitClientId,
        client_secret: fitbitClientSecret || undefined,
        redirect_uri:  fitbitRedirectUri,
      });
      // Refresh status so Connect button reflects new config
      fitbitConnectionStatus = null;
      fitbitConnectionStatus = await NtApi.get('/api/wellness/fitbit/status');
      fitbitEditingCreds = false;
      showSuccess('Fitbit credentials saved');
    } catch (e) { showError('Failed to save: ' + e.message); }
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
          <span class="setting-label">Sync Mode</span>
          <div class="setting-desc">
            {#if wellnessSyncModeVal === 'auto'}Auto syncs when you open the Wellness page (15 min cooldown).
            {:else if wellnessSyncModeVal === 'manual'}Sync only when you tap the Sync button.
            {:else if wellnessSyncModeVal === 'scheduled'}Server syncs automatically on a schedule.
            {/if}
          </div>
        </div>
        <div class="select-wrap" style="width:150px">
          <select class="select sel-sm" bind:value={wellnessSyncModeVal} on:change={e => wellnessSyncMode.set(e.target.value)}>
            <option value="auto">Auto (on open)</option>
            <option value="manual">Manual only</option>
            {#if !isNativeLocal}<option value="scheduled">Scheduled</option>{/if}
          </select>
        </div>
      </div>
      {#if wellnessSyncModeVal === 'scheduled'}
        <div class="setting-divider"></div>
        <div class="setting-row">
          <span class="setting-label">Frequency</span>
          <div class="select-wrap" style="width:150px">
            <select class="select sel-sm" bind:value={wellnessSyncScheduleVal} on:change={e => wellnessSyncSchedule.set(e.target.value)}>
              <option value="every6h">Every 6 hours</option>
              <option value="every12h">Every 12 hours</option>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly (Sunday)</option>
            </select>
          </div>
        </div>
        <div class="setting-divider"></div>
        <div class="setting-row">
          <span class="setting-label">Time</span>
          <TimePicker value={wellnessSyncTimeVal} on:change={e => { wellnessSyncTimeVal = e.detail; wellnessSyncTime.set(e.detail); }} />
        </div>
      {/if}
    {/if}
  </div>

  {#if wellnessEnabledVal}
    <!-- ── Fitbit ── -->
    <p class="sub-label" style="padding-top:16px">Fitbit</p>
    <div class="card settings-card">
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
        {#if fitbitConnectionStatus === null}
          <div class="setting-row">
            <span class="setting-desc">Loading connection status…</span>
          </div>
        {:else if fitbitConnectionStatus.connected}
          <div class="setting-row">
            <div>
              <span class="setting-label">Connected</span>
              <div class="setting-desc">
                {fitbitConnectionStatus.fitbitUserId || 'Fitbit account linked'}
                {#if fitbitConnectionStatus.lastSyncedAt}
                  · Last synced {_timeAgo(fitbitConnectionStatus.lastSyncedAt)}
                {/if}
              </div>
            </div>
            <button class="btn btn-ghost" style="height:32px;padding:0 12px;font-size:13px;color:var(--error,#f87171);border-color:var(--error,#f87171)"
              on:click={disconnectFitbitFromSettings} disabled={disconnectingFitbit}>
              {disconnectingFitbit ? 'Disconnecting…' : 'Disconnect'}
            </button>
          </div>
        {:else if fitbitConnectionStatus.configured && !fitbitEditingCreds}
          <div class="setting-row">
            <div>
              <span class="setting-label">Not connected</span>
              <div class="setting-desc">Authorize NutriTrace to read your Fitbit data.</div>
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
          <!-- No credentials yet — show inline setup form -->
          <div class="setting-row" style="flex-direction:column;align-items:flex-start;gap:12px">
            <div>
              <span class="setting-label">API Credentials</span>
              <div class="setting-desc">From <strong>dev.fitbit.com</strong> — OAuth 2.0, Application Type: Personal</div>
            </div>
            <div style="width:100%;display:flex;flex-direction:column;gap:8px">
              <div class="form-group" style="margin:0">
                <label class="form-label">Client ID</label>
                <input class="input" type="text" autocomplete="off" placeholder="e.g. 23ABC123"
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
                <div class="setting-desc" style="margin-bottom:4px">Add this exact URI to your Fitbit app's Redirect URL list</div>
                <div style="display:flex;gap:6px">
                  <input class="input" type="url" placeholder={fitbitRedirectSuggested} bind:value={fitbitRedirectUri} style="flex:1;font-size:12px" />
                  <button class="btn-icon" on:click={copyRedirectUri} title="Copy URI"><span class="material-symbols-rounded">content_copy</span></button>
                </div>
                <div class="setting-desc" style="font-size:11px;margin-top:2px">Format: <code style="font-size:11px">https://your-domain.com/api/wellness/fitbit/callback</code></div>
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
          <div class="setting-desc">Steps, sleep, heart rate, HRV, SpO2, Body Battery, stress. Requires the <strong>Garmin Health API</strong> partnership (apply at developer.garmin.com).</div>
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
        {#if garminConnectionStatus === null}
          <div class="setting-row">
            <span class="setting-desc">Loading connection status…</span>
          </div>
        {:else if garminConnectionStatus.connected}
          <div class="setting-row">
            <div>
              <span class="setting-label">Connected</span>
              <div class="setting-desc">
                {garminConnectionStatus.garminUserId || 'Garmin account linked'}
                {#if garminConnectionStatus.lastSyncedAt}
                  · Last synced {_timeAgo(garminConnectionStatus.lastSyncedAt)}
                {/if}
              </div>
            </div>
            <button class="btn btn-ghost" style="height:32px;padding:0 12px;font-size:13px;color:var(--error,#f87171);border-color:var(--error,#f87171)"
              on:click={disconnectGarminFromSettings} disabled={disconnectingGarmin}>
              {disconnectingGarmin ? 'Disconnecting…' : 'Disconnect'}
            </button>
          </div>
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
              <div class="setting-desc">From <strong>developer.garmin.com/health-api</strong> — OAuth 1.0a, redirect URI must match exactly</div>
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
          <div class="setting-desc">Body composition from scales (weight, fat %, muscle, bone mass, and more)</div>
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
        {#if withingsConnectionStatus === null}
          <div class="setting-row">
            <span class="setting-desc">Loading connection status…</span>
          </div>
        {:else if withingsConnectionStatus.connected}
          <div class="setting-row">
            <div>
              <span class="setting-label">Connected</span>
              <div class="setting-desc">
                {withingsConnectionStatus.withingsUserId ? 'User ' + withingsConnectionStatus.withingsUserId : 'Withings account linked'}
                {#if withingsConnectionStatus.lastSyncedAt}
                  · Last synced {_timeAgo(withingsConnectionStatus.lastSyncedAt)}
                {/if}
              </div>
            </div>
            <button class="btn btn-ghost" style="height:32px;padding:0 12px;font-size:13px;color:var(--error,#f87171);border-color:var(--error,#f87171)"
              on:click={disconnectWithingsFromSettings} disabled={disconnectingWithings}>
              {disconnectingWithings ? 'Disconnecting…' : 'Disconnect'}
            </button>
          </div>
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
              <div class="setting-desc">From <strong>developer.withings.com</strong> — add the redirect URI below</div>
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

    <div style="display:flex;justify-content:flex-end;margin-top:4px">
      <button class="btn btn-sm" on:click={() => wellnessMetrics.set(null)}>Reset visible metrics</button>
    </div>

    <!-- Health Connect (Android only) -->
    {#if isNative}
      <p class="sub-label" style="padding-top:16px">
        Health Connect
        <span class="labs-badge" style="background:linear-gradient(135deg,#6366f1,#8b5cf6)">Experimental</span>
      </p>
      <div class="card settings-card">
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
          <div class="setting-divider"></div>
          <div class="setting-row" style="flex-direction:column;align-items:flex-start;gap:4px">
            <span class="setting-label" style="font-size:13px">Status</span>
            {#if healthConnectAvailability === 'Available'}
              <div class="setting-desc" style="color:var(--success, #22c55e)">
                <span class="material-symbols-rounded" style="font-size:16px;vertical-align:middle">check_circle</span>
                Available · {healthConnectPermissions.read.length} data types granted
              </div>
            {:else if healthConnectAvailability === 'NotInstalled'}
              <div class="setting-desc" style="color:var(--error, #ef4444)">Not installed — install Health Connect from the Play Store</div>
            {:else}
              <div class="setting-desc" style="color:var(--text-3)">Not supported on this device</div>
            {/if}
          </div>
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
