<script>
  import { slide } from 'svelte/transition';
  import Toggle from './Toggle.svelte';
  import TimePicker from '../ui/TimePicker.svelte';
  import ConnectionStatus from './ConnectionStatus.svelte';
  import { showSuccess, showError } from '../../stores/toast.js';
  import { DB } from '../../lib/db.js';
  import { scheduleSave } from '../../stores/settings.js';

  function set(key, value) { DB.setSetting(key, value); scheduleSave(key, value); }

  // ── Notifications state ──────────────────────────────────────────────────────
  let _notifWater    = DB.getSetting('notifWaterReminders',  false);
  let _notifWaterInt = DB.getSetting('notifWaterInterval',   120);
  let _notifMeals    = DB.getSetting('notifMealReminders',   false);
  let _notifMealTimes = DB.getSetting('notifMealTimes', ['08:00','12:00','18:00']);
  function _defaultMealTime(i) { return ['08:00','12:00','18:00','15:00','10:00','20:00'][i] || '12:00'; }
  let _notifGoals    = DB.getSetting('notifGoalCelebrations', false);
  let _notifSteps    = DB.getSetting('notifStepGoal',        false);
  let _notifWeighIn  = DB.getSetting('notifWeighIn',         false);
  let _notifWeighInTime = DB.getSetting('notifWeighInTime',  '07:00');
  let _notifBedtime         = DB.getSetting('notifBedtime',         false);
  let _notifBedtimeTime     = DB.getSetting('notifBedtimeTime',     '22:30');
  let _notifBedtimeWindDown    = DB.getSetting('notifBedtimeWindDown',    false);
  let _notifBedtimeWindDownMin = DB.getSetting('notifBedtimeWindDownMin', 30);
  let _notifBedtimeSmart    = DB.getSetting('notifBedtimeSmart',    true);
  let _notifWeekly      = DB.getSetting('notifWeeklySummary',  false);
  let _weeklySummaryDay  = DB.getSetting('weeklySummaryDay',   0);
  let _weeklySummaryTime = DB.getSetting('weeklySummaryTime',  '09:00');
  let _notifWellness = DB.getSetting('notifWellnessAlerts',  false);
  let _notifWorkouts = DB.getSetting('notifWorkoutSummary',  false);
  let _notifSync     = DB.getSetting('notifSyncFailures',    false);
  let _notifLocal    = DB.getSetting('notifLocalEnabled',     true);
  let _notifPushService = DB.getSetting('notifPushService', 'none');
  let _gotifyUrl     = DB.getSetting('gotifyUrl',            '');
  let _gotifyToken   = DB.getSetting('gotifyToken',          '');
  let _appriseUrl    = DB.getSetting('appriseUrl',  '');
  let _appriseTag    = DB.getSetting('appriseTag',  '');
  let _ntfyUrl       = DB.getSetting('ntfyUrl',     'https://ntfy.sh');
  let _ntfyTopic     = DB.getSetting('ntfyTopic',   '');
  let _ntfyToken     = DB.getSetting('ntfyToken',   '');
  let _ntfyShowToken = false;
  let _gotifyTesting = false;
  let _gotifyShowToken = false;
  // Result of the most recent push test — drives the banner state. null until
  // a test runs; cleared when the user switches providers so a stale 'ok' or
  // 'fail' pill doesn't carry over to a different service.
  let _pushTestResult = null; // null | 'ok' | 'fail'

  $: _anyNotifEnabled = _notifLocal || _notifPushService !== 'none';

  // Push service status banner. Stays "Configured" as soon as required
  // fields are filled — push services (Gotify/ntfy/Apprise) are stateless
  // HTTP, there's no persistent connection to claim. Test sends a real
  // notification; success/failure surfaces via toast. Failed test flips
  // to the danger pill with the error inline.
  $: _pushConfigured = _notifPushService === 'gotify'  ? !!(_gotifyUrl && _gotifyToken)
                     : _notifPushService === 'ntfy'    ? !!(_ntfyUrl && _ntfyTopic)
                     : _notifPushService === 'apprise' ? !!_appriseUrl
                     : false;
  $: _pushBannerStatus = _gotifyTesting
    ? 'testing'
    : _pushTestResult === 'fail'
      ? 'fail'
      : (_pushConfigured ? 'ok' : '');
  $: _pushBannerDisabled = _gotifyTesting || !_pushConfigured;
  $: _pushProviderLabel  = _notifPushService === 'gotify'  ? 'Gotify'
                         : _notifPushService === 'ntfy'    ? 'ntfy'
                         : _notifPushService === 'apprise' ? 'Apprise'
                         : '';
  // Clear stale test result when switching providers so the banner doesn't
  // carry over a "Last Test Sent" pill from a different service.
  let _lastPushProvider = _notifPushService;
  $: if (_notifPushService !== _lastPushProvider) {
    _lastPushProvider = _notifPushService;
    _pushTestResult = null;
  }

  async function _requestNotifPermission() {
    try {
      const { requestPermission } = await import('../../lib/notifications.js');
      await requestPermission();
    } catch {}
  }

  async function _scheduleWater() {
    if (_notifWater) {
      const { requestPermission, scheduleWaterReminders } = await import('../../lib/notifications.js');
      await requestPermission();
      await scheduleWaterReminders(_notifWaterInt);
    } else {
      const { cancelWaterReminders } = await import('../../lib/notifications.js');
      await cancelWaterReminders();
    }
  }

  async function _scheduleMeals() {
    if (_notifMeals) {
      const { requestPermission, scheduleMealReminders } = await import('../../lib/notifications.js');
      await requestPermission();
      const names = DB.getSetting('mealNames', ['Breakfast','Lunch','Dinner','Snacks']);
      const times = DB.getSetting('notifMealTimes', ['08:00','12:00','18:00']);
      await scheduleMealReminders(times, names);
    } else {
      const { cancelMealReminders } = await import('../../lib/notifications.js');
      await cancelMealReminders();
    }
  }

  async function _scheduleWeighIn() {
    if (_notifWeighIn) {
      const { requestPermission, scheduleWeighInReminder } = await import('../../lib/notifications.js');
      await requestPermission();
      await scheduleWeighInReminder(_notifWeighInTime);
    } else {
      const { cancelWeighInReminder } = await import('../../lib/notifications.js');
      await cancelWeighInReminder();
    }
  }

  async function _testPush() {
    _gotifyTesting = true;
    _pushTestResult = null;
    // Save all current values before testing so the push helper reads what's
    // on screen, not what was last persisted.
    set('gotifyUrl', _gotifyUrl); set('gotifyToken', _gotifyToken);
    set('ntfyUrl', _ntfyUrl); set('ntfyTopic', _ntfyTopic); set('ntfyToken', _ntfyToken);
    set('appriseUrl', _appriseUrl); set('appriseTag', _appriseTag);
    try {
      const { sendPush } = await import('../../lib/notifications.js');
      await sendPush(_notifPushService, 'NutriTrace', 'Test notification, push service connected', 5);
      _pushTestResult = 'ok';
      showSuccess('Test sent, check your device');
    } catch (e) {
      _pushTestResult = 'fail';
      showError(`Test failed: ${e.message || 'unknown error'}`);
    }
    _gotifyTesting = false;
  }
</script>

<div class="section-body" transition:slide={{ duration: 180 }}>

  <!-- Delivery setup -->
  <p class="sub-label">Delivery</p>
  <div class="card settings-card">
    <!-- Push service status banner — sits at the top of the Delivery card,
         above the first setting-row. Matches the established NutriTrace
         pattern used by USDA, Mealie, SMTP, AI Assistant, Wellness:
         ConnectionStatus is part of the same card as its config, not its
         own separate card. Renders only when a push provider is selected. -->
    {#if _notifPushService !== 'none'}
      <ConnectionStatus
        status={_pushBannerStatus}
        okLabel="Configured"
        connectedAs={_pushProviderLabel}
        error={_pushTestResult === 'fail' ? `${_pushProviderLabel} test failed, check the URL and credentials below` : ''}
        onRetest={_testPush}
        retestDisabled={_pushBannerDisabled}
        retestLabel="Send Test"
      />
    {/if}
    <div class="setting-row">
      <div>
        <span class="setting-label">Device Notifications</span>
        <div class="setting-desc">Alerts delivered directly to this device — native on Android, browser pop-ups on desktop/PWA</div>
      </div>
      <Toggle checked={_notifLocal} on:change={e => { _notifLocal = e.detail; set('notifLocalEnabled', e.detail); if (e.detail) _requestNotifPermission(); }} />
    </div>
    <div class="setting-divider"></div>
    <div class="setting-row">
      <div>
        <span class="setting-label">Push Service</span>
        <div class="setting-desc">Server-relayed alerts via Apprise, Gotify, or ntfy — useful for PWA users or Home Assistant</div>
      </div>
      <div class="select-wrap" style="width:130px">
        <select class="select sel-sm" value={_notifPushService} on:change={e => { _notifPushService = e.target.value; set('notifPushService', e.target.value); }}>
          <option value="none">None</option>
          <option value="apprise">Apprise</option>
          <option value="gotify">Gotify</option>
          <option value="ntfy">ntfy</option>
        </select>
      </div>
    </div>

    <!-- Apprise config -->
    {#if _notifPushService === 'apprise'}
      <div class="form-group" style="padding:10px 16px 4px">
        <label class="form-label">Apprise Server URL</label>
        <input class="input" placeholder="https://apprise.example.com" bind:value={_appriseUrl} on:blur={() => set('appriseUrl', _appriseUrl)} />
      </div>
      <div class="form-group" style="padding:8px 16px 14px">
        <label class="form-label">Tag (optional)</label>
        <input class="input" placeholder="e.g. nutritrace" bind:value={_appriseTag} on:blur={() => set('appriseTag', _appriseTag)} />
      </div>
    {/if}

    <!-- Gotify config -->
    {#if _notifPushService === 'gotify'}
      <div class="form-group" style="padding:10px 16px 4px">
        <label class="form-label">Gotify Server URL</label>
        <input class="input" placeholder="https://gotify.example.com" bind:value={_gotifyUrl} on:blur={() => set('gotifyUrl', _gotifyUrl)} />
      </div>
      <div class="form-group" style="padding:8px 16px 14px">
        <label class="form-label">App Token</label>
        <div style="display:flex;gap:8px;align-items:center">
          {#if _gotifyShowToken}
            <input class="input" style="flex:1" type="text" placeholder="Your Gotify app token" bind:value={_gotifyToken} on:blur={() => set('gotifyToken', _gotifyToken)} />
          {:else}
            <input class="input" style="flex:1" type="password" placeholder="Your Gotify app token" bind:value={_gotifyToken} on:blur={() => set('gotifyToken', _gotifyToken)} />
          {/if}
          <button class="btn-icon" on:click={() => _gotifyShowToken = !_gotifyShowToken} title={_gotifyShowToken ? 'Hide' : 'Show'}>
            <span class="material-symbols-rounded">{_gotifyShowToken ? 'visibility_off' : 'visibility'}</span>
          </button>
        </div>
      </div>
    {/if}

    <!-- ntfy config -->
    {#if _notifPushService === 'ntfy'}
      <div class="form-group" style="padding:10px 16px 4px">
        <label class="form-label">ntfy Server URL</label>
        <input class="input" placeholder="https://ntfy.sh" bind:value={_ntfyUrl} on:blur={() => set('ntfyUrl', _ntfyUrl)} />
      </div>
      <div class="form-group" style="padding:8px 16px 4px">
        <label class="form-label">Topic</label>
        <input class="input" placeholder="e.g. my-nutritrace" bind:value={_ntfyTopic} on:blur={() => set('ntfyTopic', _ntfyTopic)} />
      </div>
      <div class="form-group" style="padding:8px 16px 14px">
        <label class="form-label">Access Token (optional, for private topics)</label>
        <div style="display:flex;gap:8px;align-items:center">
          {#if _ntfyShowToken}
            <input class="input" style="flex:1" type="text" placeholder="Bearer token" bind:value={_ntfyToken} on:blur={() => set('ntfyToken', _ntfyToken)} />
          {:else}
            <input class="input" style="flex:1" type="password" placeholder="Bearer token" bind:value={_ntfyToken} on:blur={() => set('ntfyToken', _ntfyToken)} />
          {/if}
          <button class="btn-icon" on:click={() => _ntfyShowToken = !_ntfyShowToken} title={_ntfyShowToken ? 'Hide' : 'Show'}>
            <span class="material-symbols-rounded">{_ntfyShowToken ? 'visibility_off' : 'visibility'}</span>
          </button>
        </div>
      </div>
    {/if}
  </div>

  {#if _anyNotifEnabled}
    <!-- Notification types — all go through whichever delivery methods are enabled -->
    <p class="sub-label">Scheduled Reminders</p>
    <div class="card settings-card">
      <div class="setting-row">
        <div>
          <span class="setting-label">Water Reminders</span>
          <div class="setting-desc">Periodic reminders to stay hydrated (8am–10pm)</div>
        </div>
        <Toggle checked={_notifWater} on:change={e => { _notifWater = e.detail; set('notifWaterReminders', e.detail); _scheduleWater(); }} />
      </div>
      {#if _notifWater}
        <div class="setting-divider"></div>
        <div class="setting-row">
          <span class="setting-label">Interval</span>
          <div class="select-wrap" style="width:130px">
            <select class="select sel-sm" value={_notifWaterInt} on:change={e => { _notifWaterInt = Number(e.target.value); set('notifWaterInterval', _notifWaterInt); _scheduleWater(); }}>
              <option value={60}>Every 1 hour</option>
              <option value={90}>Every 1.5 hours</option>
              <option value={120}>Every 2 hours</option>
              <option value={180}>Every 3 hours</option>
            </select>
          </div>
        </div>
      {/if}
      <div class="setting-divider"></div>
      <div class="setting-row">
        <div>
          <span class="setting-label">Meal Log Reminders</span>
          <div class="setting-desc">Daily reminders to log your meals</div>
        </div>
        <Toggle checked={_notifMeals} on:change={e => { _notifMeals = e.detail; set('notifMealReminders', e.detail); _scheduleMeals(); }} />
      </div>
      {#if _notifMeals}
        {@const mealNames = DB.getSetting('mealNames', ['Breakfast','Lunch','Dinner','Snacks'])}
        {#each mealNames as name, i}
          <div class="setting-divider"></div>
          <div class="setting-row">
            <span class="setting-label">{name}</span>
            <TimePicker value={_notifMealTimes[i] || _defaultMealTime(i)} on:change={e => {
              while (_notifMealTimes.length <= i) _notifMealTimes.push(_defaultMealTime(_notifMealTimes.length));
              _notifMealTimes[i] = e.detail;
              _notifMealTimes = _notifMealTimes;
              set('notifMealTimes', _notifMealTimes);
              _scheduleMeals();
            }} />
          </div>
        {/each}
      {/if}
      <div class="setting-divider"></div>
      <div class="setting-row">
        <div>
          <span class="setting-label">Weigh-in Reminder</span>
          <div class="setting-desc">Morning reminder to step on the scale</div>
        </div>
        <Toggle checked={_notifWeighIn} on:change={e => { _notifWeighIn = e.detail; set('notifWeighIn', e.detail); _scheduleWeighIn(); }} />
      </div>
      {#if _notifWeighIn}
        <div class="setting-divider"></div>
        <div class="setting-row">
          <span class="setting-label">Time</span>
          <TimePicker value={_notifWeighInTime} on:change={e => { _notifWeighInTime = e.detail; set('notifWeighInTime', e.detail); _scheduleWeighIn(); }} />
        </div>
      {/if}
      <div class="setting-divider"></div>
      <div class="setting-row">
        <div>
          <span class="setting-label">Bedtime Reminder</span>
          <div class="setting-desc">Evening nudge to wind down for sleep</div>
        </div>
        <Toggle checked={_notifBedtime} on:change={e => { _notifBedtime = e.detail; set('notifBedtime', e.detail); }} />
      </div>
      {#if _notifBedtime}
       <div transition:slide={{ duration: 160 }}>
        <div class="setting-divider"></div>
        <div class="setting-row">
          <span class="setting-label">Bedtime</span>
          <TimePicker value={_notifBedtimeTime} on:change={e => { _notifBedtimeTime = e.detail; set('notifBedtimeTime', e.detail); }} />
        </div>
        <div class="setting-divider"></div>
        <div class="setting-row">
          <div>
            <span class="setting-label">Wind-down Reminder</span>
            <div class="setting-desc">Extra nudge before bedtime to start winding down</div>
          </div>
          <Toggle checked={_notifBedtimeWindDown} on:change={e => { _notifBedtimeWindDown = e.detail; set('notifBedtimeWindDown', e.detail); }} />
        </div>
        {#if _notifBedtimeWindDown}
          <div transition:slide={{ duration: 160 }}>
          <div class="setting-divider"></div>
          <div class="setting-row">
            <span class="setting-label">Minutes Before</span>
            <div class="select-wrap" style="width:120px">
              <select class="select sel-sm" bind:value={_notifBedtimeWindDownMin} on:change={e => set('notifBedtimeWindDownMin', parseInt(e.target.value))}>
                <option value={15}>15 min</option>
                <option value={30}>30 min</option>
                <option value={45}>45 min</option>
                <option value={60}>60 min</option>
                <option value={90}>90 min</option>
              </select>
            </div>
          </div>
          </div>
        {/if}
        <div class="setting-divider"></div>
        <div class="setting-row">
          <div>
            <span class="setting-label">Smart Message</span>
            <div class="setting-desc">Adjust the reminder based on last night's sleep (if tracked)</div>
          </div>
          <Toggle checked={_notifBedtimeSmart} on:change={e => { _notifBedtimeSmart = e.detail; set('notifBedtimeSmart', e.detail); }} />
        </div>
       </div>
      {/if}
    </div>

    <p class="sub-label">Alerts &amp; Summaries</p>
    <div class="card settings-card">
      <div class="setting-row">
        <div>
          <span class="setting-label">Goal Celebrations</span>
          <div class="setting-desc">Celebrates when you hit any daily goal — calories, protein, carbs, fat, water, steps, sleep, and more</div>
        </div>
        <Toggle checked={_notifGoals} on:change={e => { _notifGoals = e.detail; set('notifGoalCelebrations', e.detail); }} />
      </div>
      <div class="setting-divider"></div>
      <div class="setting-row">
        <div>
          <span class="setting-label">Step Goal Progress</span>
          <div class="setting-desc">Midday nudge if you're behind on your step goal</div>
        </div>
        <Toggle checked={_notifSteps} on:change={e => { _notifSteps = e.detail; set('notifStepGoal', e.detail); }} />
      </div>
      <div class="setting-divider"></div>
      <div class="setting-row">
        <div>
          <span class="setting-label">Wellness Alerts</span>
          <div class="setting-desc">Warns when HRV drops significantly, sleep quality declines, or resting heart rate spikes</div>
        </div>
        <Toggle checked={_notifWellness} on:change={e => { _notifWellness = e.detail; set('notifWellnessAlerts', e.detail); }} />
      </div>
      <div class="setting-divider"></div>
      <div class="setting-row">
        <div>
          <span class="setting-label">Workout Summaries</span>
          <div class="setting-desc">Recap after a workout syncs — duration, distance, calories burned</div>
        </div>
        <Toggle checked={_notifWorkouts} on:change={e => { _notifWorkouts = e.detail; set('notifWorkoutSummary', e.detail); }} />
      </div>
      <div class="setting-divider"></div>
      <div class="setting-row">
        <div>
          <span class="setting-label">Weekly Summary</span>
          <div class="setting-desc">Weekly digest with average calories, protein, steps, sleep, goal hit rate, and weight change — delivered by push notification and email (if configured)</div>
        </div>
        <Toggle checked={_notifWeekly} on:change={e => { _notifWeekly = e.detail; set('notifWeeklySummary', e.detail); }} />
      </div>
      {#if _notifWeekly}
        <div class="setting-divider"></div>
        <div class="setting-row">
          <span class="setting-label">Delivery Day</span>
          <div class="seg-control" style="--seg-count:7;--seg-active:{_weeklySummaryDay}">
            {#each ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'] as day, i}
              <button class="seg-opt" class:seg-active={_weeklySummaryDay === i}
                on:click={() => { _weeklySummaryDay = i; set('weeklySummaryDay', i); }}>
                {day}
              </button>
            {/each}
          </div>
        </div>
        <div class="setting-divider"></div>
        <div class="setting-row">
          <span class="setting-label">Delivery Time</span>
          <TimePicker value={_weeklySummaryTime} on:change={e => { _weeklySummaryTime = e.detail; set('weeklySummaryTime', e.detail); }} />
        </div>
      {/if}
      <div class="setting-divider"></div>
      <div class="setting-row">
        <div>
          <span class="setting-label">Sync Failures</span>
          <div class="setting-desc">Alert when Fitbit, Garmin, or Withings sync fails</div>
        </div>
        <Toggle checked={_notifSync} on:change={e => { _notifSync = e.detail; set('notifSyncFailures', e.detail); }} />
      </div>
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
  .sel-sm { height: 36px; font-size: 13px; width: auto; max-width: 100%; }

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

  .seg-control {
    position: relative;
    display: flex;
    border: 1.5px solid var(--border);
    border-radius: var(--radius-md);
    overflow: hidden;
  }
  /* Sliding active highlight — driven by --seg-active (index) + --seg-count (total). */
  .seg-control::before {
    content: '';
    position: absolute;
    top: 0; left: 0; bottom: 0;
    width: calc(100% / var(--seg-count, 7));
    background: var(--accent-dim);
    transform: translateX(calc(var(--seg-active, 0) * 100%));
    transition: transform 220ms cubic-bezier(0.34, 1.56, 0.64, 1);
    pointer-events: none;
    z-index: 0;
  }
  .seg-opt {
    position: relative;
    z-index: 1;
    flex: 1;
    padding: 6px 4px;
    background: transparent;
    border: none;
    border-left: 1px solid var(--border);
    color: var(--text-2);
    font-size: 12px;
    cursor: pointer;
    transition: color var(--dur-fast);
  }
  .seg-opt:first-child { border-left: none; }
  .seg-opt:hover { color: var(--text-1); }
  .seg-active { color: var(--accent); font-weight: 600; }
</style>
