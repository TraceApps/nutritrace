<script>
  import { push } from 'svelte-spa-router';
  import { _ } from 'svelte-i18n';
  import { fly, fade } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import { DB, localDateStr } from '../lib/db.js';
  import { Nutrition } from '../lib/nutrition.js';
  import { mealNames, energyUnit, goals, weightUnit, heightUnit, lengthUnit, distUnit, tempUnit, waterUnit, bulkSet } from '../stores/settings.js';
  import { currentUser, userMgmtActive, setupRequired, loadAuthState } from '../stores/auth.js';
  import { validatePassword, passwordStrength } from '../lib/validation.js';
  import { showError } from '../stores/toast.js';
  import { decimalInput, parseDecimal } from '../lib/decimal-input.js';
  import { isNative, getServerUrl, apiUrl } from '../lib/platform.js';
  import Toggle from '../components/settings/Toggle.svelte';
  import DateInput from '../components/ui/DateInput.svelte';

  // ── Wizard mode branching ────────────────────────────────────────────────
  // Three variants of the user-management step:
  //   1. Native local mode (Capacitor + no server URL): step is skipped entirely.
  //      Single-device, single-user, no auth — nothing to configure.
  //   2. PWA with no users yet on server: forces "Create Your Account". The user
  //      must register an admin before the rest of the wizard can run; cookie-
  //      based auth needs at least one user. No skip, no toggle.
  //   3. PWA with users already present: shows "Multi-User Support" toggle.
  //      Lets the user opt into multi-user mode (separate logins, password
  //      resets), or stay single-user.
  const _isNativeLocal       = isNative && !getServerUrl();
  const _isPwa               = !isNative;
  const _forceAccountCreation = _isPwa && $setupRequired;

  // Steps: usermgmt (optional on native, mandatory on PWA), welcome, units, ...
  // Native local mode: drops usermgmt (no auth needed) but inserts a single
  // 'name' step right after welcome so we can still personalize the UI
  // (Trace greetings, Sidebar header, etc.) without a full user account.
  // PWA single-user (user opts out of UM at the usermgmt step): same 'name'
  // step gets inserted so they can still set a display name. Multi-user
  // doesn't need it — the admin's full_name was captured on the usermgmt
  // step itself.
  const BASE_STEPS = ['welcome','units','gender','dob','height','weight','target','activity','integrations','notifications','summary'];
  $: ALL_STEPS = _isNativeLocal
    ? ['welcome', 'name', 'units','gender','dob','height','weight','target','activity','integrations','notifications','summary']
    : (enableUserMgmt
        ? ['usermgmt', ...BASE_STEPS]
        : ['usermgmt', 'welcome', 'name', 'units','gender','dob','height','weight','target','activity','integrations','notifications','summary']);

  let step = 0;
  let dir  = 1;

  // ── User management step ─────────────────────────────────────────────────
  // Auth-only fields — birthday and gender intentionally NOT collected here.
  // The dedicated `dob` and `gender` wizard steps later in the flow capture
  // those into USER_PREFS where they live with the rest of the profile.
  // Collecting them in two places previously created two sources of truth and
  // mismatched gender option lists (auth form had M/F/Non-binary/Prefer-not,
  // the dedicated step has only M/F because Mifflin-St Jeor is binary).
  let enableUserMgmt = _forceAccountCreation ? true : false;
  let adminUsername  = '';
  let adminPassword  = '';
  let adminConfirm   = '';
  let adminFullName  = '';
  let adminNickname  = '';
  let adminEmail     = '';
  let umError        = '';
  let umLoading      = false;

  // ── Name (native local mode only) ────────────────────────────────────────
  // Replaces the auth-only fields the user-management step would have asked
  // for in server mode. Stored as a `localUserName` setting and hydrated
  // back into the synthetic LOCAL_USER's full_name in auth.js so the rest
  // of the UI doesn't need to know about local vs server mode.
  let localName = '';

  // ── Unit system ───────────────────────────────────────────────────────────
  let unitSystem = ''; // 'metric' | 'imperial'

  // Australia and NZ default to kilojoules on food labels and in everyday use;
  // every other locale (incl. UK, Canada, EU) uses kcal. Pre-select kJ for
  // those two locales as a UX nicety; the user can still toggle it manually.
  function _localeDefaultEnergyUnit() {
    try {
      const lang = (navigator.language || '').toLowerCase();
      if (lang === 'en-au' || lang === 'en-nz' || lang.startsWith('en-au-') || lang.startsWith('en-nz-')) return 'kJ';
    } catch {}
    return 'kcal';
  }

  function applyUnitSystem(sys) {
    unitSystem = sys;
    const _energy = _localeDefaultEnergyUnit();
    if (sys === 'imperial') {
      weightUnit.set('lb');
      heightUnit.set('ft');
      lengthUnit.set('in');
      distUnit.set('mi');
      tempUnit.set('F');
      waterUnit.set('oz');
      energyUnit.set(_energy);
      weight = 155; targetW = 155;
      heightFt = 5; heightIn = 9;
    } else {
      weightUnit.set('kg');
      heightUnit.set('cm');
      lengthUnit.set('cm');
      distUnit.set('km');
      tempUnit.set('C');
      waterUnit.set('ml');
      energyUnit.set(_energy);
      weight = 70; targetW = 70;
      heightCm = 170;
    }
  }

  // ── Profile data ─────────────────────────────────────────────────────────
  let gender   = '';
  let dob      = (new Date().getFullYear() - 25) + '-01-01';
  let heightCm = 170;
  let heightFt = 5;
  let heightIn = 9;
  let weight   = 70;
  let targetW  = 70;
  let activity = '';

  // Auto-mirror weight → targetW until the user explicitly edits the target.
  // Maintenance (target = current) is the most common case, so default to it.
  // Once the user types in the target field, _targetTouched flips on and we
  // stop overwriting their value.
  let _targetTouched = false;
  $: if (!_targetTouched) targetW = weight;

  // ── Integrations step ─────────────────────────────────────────────────────
  let intOFFUser     = '';
  let intOFFPass     = '';
  let intUSDARKey    = '';
  let intMealieUrl   = '';
  let intMealieToken = '';
  let intAIProvider  = 'claude';
  let intAIKey       = '';

  // Which cards are collapsed/skipped
  let intSkipped = { off: false, usda: false, mealie: false, ai: false };
  let skipSetupConfirm = false; // confirmation modal for "I'll do this later"

  // ── Notifications step ────────────────────────────────────────────────────
  let notifEnabled   = false;
  let notifWater     = false;
  let notifMeals     = false;
  let notifGoals     = false;
  let notifWellness  = false;
  let intAILocked  = false;
  let intStatusLoaded = false;

  $: if (currentStepName === 'integrations' && !intStatusLoaded) {
    intStatusLoaded = true;
    if (!_isNativeLocal) {
      fetch(apiUrl('/api/app-config/env-locks'), { credentials: 'include' })
        .then(r => r.ok ? r.json() : {})
        .then(d => {
          intAILocked = d.ai === true;
          if (intAILocked) intSkipped = { ...intSkipped, ai: true };
        })
        .catch(() => {});
    }
  }

  // Computed TDEE / goal / water for summary step
  let tdee      = 0;
  let goalKcal  = 0;
  let waterGoal = 0; // ml

  const ACTIVITY_LEVELS = [
    { value: 'sedentary',   label: 'Sedentary',          desc: 'Little or no exercise' },
    { value: 'light',       label: 'Lightly Active',      desc: 'Light exercise 1–3 days/week' },
    { value: 'moderate',    label: 'Moderately Active',   desc: 'Moderate exercise 3–5 days/week' },
    { value: 'active',      label: 'Very Active',         desc: 'Hard exercise 6–7 days/week' },
    { value: 'very_active', label: 'Extremely Active',    desc: 'Very hard exercise & physical job' },
  ];

  $: wUnit = $weightUnit || 'kg';
  $: hUnit = $heightUnit || 'cm';

  function toKg(v) {
    // parseDecimal so a comma-locale user typing "70,5" doesn't turn into NaN
    // downstream. #160 follow-up: inputs are now type=text.
    const n = parseDecimal(v);
    if (!Number.isFinite(n)) return NaN;
    if (wUnit === 'lb') return n * 0.453592;
    if (wUnit === 'st') return n * 6.35029;
    return n;
  }

  function getHeightCm() {
    if (hUnit === 'cm') return parseDecimal(heightCm);
    const ft = parseDecimal(heightFt) || 0;
    const inches = parseDecimal(heightIn) || 0;
    return Math.round(ft * 30.48 + inches * 2.54);
  }

  function calcSummary() {
    const ageMs = Date.now() - new Date(dob).getTime();
    const age   = Math.floor(ageMs / (365.25 * 24 * 3600 * 1000));
    const wKg   = toKg(weight);
    const tWKg  = toKg(targetW);
    const hCm   = getHeightCm();
    tdee = Nutrition.calculateTDEE({
      gender: gender || 'male',
      age: Math.max(15, age),
      height_cm: hCm,
      weight_kg: wKg,
      activity: activity || 'sedentary'
    });
    if (tWKg < wKg * 0.99)      goalKcal = Math.round(tdee * 0.80);
    else if (tWKg > wKg * 1.01) goalKcal = Math.round(tdee * 1.20);
    else                         goalKcal = tdee;

    // Water goal: 35ml per kg body weight + activity adjustment
    const ACTIVITY_WATER = { sedentary: 0, light: 350, moderate: 500, active: 700, very_active: 1000 };
    const baseWater = wKg * 35;
    const actBonus  = ACTIVITY_WATER[activity] ?? 0;
    waterGoal = Math.round((baseWater + actBonus) / 50) * 50; // round to nearest 50ml
  }

  $: currentStepName = ALL_STEPS[step];

  // Validation per step
  $: canProceed = !(currentStepName === 'usermgmt' && enableUserMgmt && (!adminUsername.trim() || !adminPassword.trim() || adminPassword !== adminConfirm))
               && !(currentStepName === 'units'    && !unitSystem)
               && !(currentStepName === 'gender'   && !gender)
               && !(currentStepName === 'activity' && !activity);

  $: btnLabel = step === ALL_STEPS.length - 1 ? $_('wizard.nav.finish')
    : step === 0 ? $_('wizard.nav.get_started') : $_('wizard.nav.next');

  async function next() {
    if (currentStepName === 'usermgmt') {
      if (enableUserMgmt) {
        umError = '';
        if (!adminUsername.trim()) { umError = 'Username is required'; return; }
        const pwErr = validatePassword(adminPassword);
        if (pwErr) { umError = pwErr; return; }
        if (adminPassword !== adminConfirm) { umError = 'Passwords do not match'; return; }
        // Register the admin account
        umLoading = true;
        try {
          const res = await fetch(apiUrl('/api/auth/register'), {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              username:  adminUsername.trim(),
              password:  adminPassword,
              full_name: adminFullName.trim() || undefined,
              nickname:  adminNickname.trim() || undefined,
              email:     adminEmail.trim()    || undefined,
            }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) { umError = data.error || 'Registration failed'; umLoading = false; return; }
          localStorage.setItem('wl:userId', data.user.id);
          await loadAuthState();
        } catch(e) {
          umError = 'Could not connect to server';
          umLoading = false;
          return;
        }
        umLoading = false;
      }
      dir = 1; step++;
      return;
    }

    if (currentStepName === 'summary') { finish(); return; }
    if (step === ALL_STEPS.length - 1) { finish(); return; }

    // Validation
    if (currentStepName === 'gender'   && !gender)   return;
    if (currentStepName === 'activity' && !activity) return;

    if (currentStepName === 'integrations') {
      await _saveIntegrations();
    }
    if (currentStepName === 'notifications') {
      await _saveNotifications();
    }

    dir = 1;
    step++;
    if (ALL_STEPS[step] === 'summary') calcSummary();
  }

  function prev() {
    if (step === 0) return;
    dir = -1;
    step--;
  }

  function skip() {
    // Don't allow skip until account is created when forced
    if (_forceAccountCreation && !$userMgmtActive) return;
    bulkSet({ setupComplete: true, bannerStyle: 'gradient' });
    push('/');
  }

  async function _saveIntegrations() {
    const batch = {};
    // OFF: skip toggle drives the search-source on/off; credentials only persist
    // when provided (search works fine without them — they're upload-only).
    batch.offEnabled = !intSkipped.off;
    if (!intSkipped.off && (intOFFUser.trim() || intOFFPass.trim())) {
      batch.offUsername = intOFFUser.trim();
      batch.offPassword = intOFFPass.trim();
    }
    if (!intSkipped.usda && intUSDARKey.trim()) {
      batch.usdaApiKey = intUSDARKey.trim();
      batch.usdaEnabled = true;
    }
    if (!intSkipped.mealie && (intMealieUrl.trim() || intMealieToken.trim())) {
      batch.mealieBaseUrl = intMealieUrl.trim();
      batch.mealieApiToken = intMealieToken.trim();
      batch.mealieEnabled = true;
    }
    if (Object.keys(batch).length) await bulkSet(batch);

    // AI is admin-side: writes to app_config, not user_settings
    if (!intSkipped.ai && !intAILocked && intAIKey.trim()) {
      const _putConfig = (key, value) => {
        const headers = { 'Content-Type': 'application/json' };
        const csrf = localStorage.getItem('nt:csrf');
        if (csrf) headers['X-CSRF-Token'] = csrf;
        return fetch(apiUrl('/api/app-config'), {
          method: 'PUT', credentials: 'include', headers,
          body: JSON.stringify({ key, value }),
        }).catch(() => {});
      };
      await Promise.all([
        _putConfig('ai_api_key',  intAIKey.trim()),
        _putConfig('ai_provider', intAIProvider),
        _putConfig('ai_enabled',  'true'),
      ]);
    }
  }

  async function _saveNotifications() {
    if (!notifEnabled) return;

    // Request permission
    try {
      const { requestPermission } = await import('../lib/notifications.js');
      await requestPermission();
    } catch {}

    // Build batch of settings to save in one shot
    const batch = { notifLocalEnabled: true };
    if (notifWater)    batch.notifWaterReminders = true;
    if (notifMeals)    batch.notifMealReminders = true;
    if (notifGoals)    batch.notifGoalCelebrations = true;
    if (notifWellness) batch.notifWellnessAlerts = true;
    await bulkSet(batch);

    // Side-effect: schedule the actual reminders after settings are saved
    if (notifWater) {
      try {
        const { scheduleWaterReminders } = await import('../lib/notifications.js');
        await scheduleWaterReminders(120);
      } catch {}
    }
    if (notifMeals) {
      try {
        const { scheduleMealReminders } = await import('../lib/notifications.js');
        const names = DB.getSetting('mealNames', ['Breakfast','Lunch','Dinner','Snacks']);
        await scheduleMealReminders(['08:00','12:00','18:00','15:00'], names);
      } catch {}
    }
  }

  async function finish() {
    const wKg = toKg(weight);
    const tKg = toKg(targetW);
    const hCm = getHeightCm();

    // Set goals via the store (uses createSettingStore.set which goes through
    // the global listener — single push debounced). Goals is a complex merge
    // so it stays separate from the bulk batch.
    if (goalKcal) {
      const current = DB.getSetting('goals', {});
      goals.set({ ...current, calories: { max: goalKcal, sharedGoal: true, isMin: false, showInDiary: true, showInStats: true, days: Array(7).fill(goalKcal) } });
    }

    // Bulk-set everything else in one API call
    const batch = {
      gender: gender || 'male',
      dob,
      height_cm: hCm,
      weight_kg: wKg,
      target_weight: tKg,
      activity: activity || 'sedentary',
      tdee: tdee || 2000,
      setupComplete: true,
      // New users finishing onboarding get gradient banners as their
      // default first impression. Existing users (who never re-run the
      // wizard) keep whatever bannerStyle / legacy pageBanners they had
      // — the migration in settings.js handles that path.
      bannerStyle: 'gradient',
    };
    if (waterGoal) batch.waterGoalMl = waterGoal;
    // Save the localUserName setting whenever the 'name' step appeared in
    // the flow — covers both native standalone and PWA single-user. Multi-
    // user doesn't reach the 'name' step (full_name is on the user row).
    const _useLocalProfile = _isNativeLocal || (_isPwa && !enableUserMgmt);
    if (_useLocalProfile && localName.trim()) batch.localUserName = localName.trim();
    await bulkSet(batch);

    // Refresh the synthetic LOCAL_USER so Sidebar / Trace / etc. pick up the
    // new name without a page reload.
    if (_useLocalProfile && localName.trim()) {
      try { await loadAuthState(); } catch {}
    }

    // Celebration beat — swap the wizard step content for a small "All
    // Set" hero card with confetti before navigating home, so onboarding
    // ends with a real beat instead of just snapping to the diary. Skip
    // path goes straight to '/'; only Finish gets the celebration.
    // Honors prefers-reduced-motion (confetti hidden, icon static).
    // TraceApps parity port from LiftTrace's GA polish pass (LT 452a3ad).
    wizardDone = true;
    setTimeout(() => push('/'), 1800);
  }

  let wizardDone = false;
</script>

<div class="wizard-shell">
  {#if wizardDone}
    <!-- Celebration screen — brief beat between finishing the wizard and
         landing in the diary so onboarding has a moment of closure
         instead of just blinking to the home page. -->
    <div class="wizard-done">
      <div class="wizard-confetti" aria-hidden="true">
        {#each Array(14) as _, i}<span class="conf c{i % 7}" style:--i={i}></span>{/each}
      </div>
      <span class="material-symbols-rounded wizard-done-icon">emoji_events</span>
      <h2 class="wizard-done-title">You're All Set!</h2>
      <p class="wizard-done-sub">Welcome to NutriTrace. Loading your diary…</p>
    </div>
  {:else}
  <!-- Skip button -->
  <div class="wizard-topbar">
    {#if step > 0 && step < ALL_STEPS.length - 1 && !(_forceAccountCreation && !$userMgmtActive)}
      <button class="btn btn-ghost wizard-skip" on:click={() => skipSetupConfirm = true}>{$_('wizard.nav.skip')}</button>
    {:else}
      <div></div>
    {/if}
  </div>

  <!-- Progress dots -->
  <div class="progress-dots">
    {#each ALL_STEPS as _, i}
      <div class="dot" class:active={i <= step} class:current={i === step}></div>
    {/each}
  </div>

  {#key step}
    <div class="wizard-step"
      in:fly={{ x: dir * 40, duration: 260, easing: cubicOut, opacity: 0 }}
      out:fade={{ duration: 100 }}>

      <!-- ── User Management ── -->
      {#if currentStepName === 'usermgmt'}
        {#if _forceAccountCreation}
          <div class="step-hero compact">
            <span class="material-symbols-rounded hero-icon">person_add</span>
            <h1 class="step-title">{$_('wizard.usermgmt.create_account_title')}</h1>
            <p class="step-desc">{$_('wizard.usermgmt.create_account_desc')}</p>
          </div>
        {:else}
          <div class="step-hero compact">
            <span class="material-symbols-rounded hero-icon">group</span>
            <h1 class="step-title">{$_('wizard.usermgmt.multi_user_title')}</h1>
            <p class="step-desc">{$_('wizard.usermgmt.multi_user_desc')}</p>
          </div>

          <div class="toggle-row">
            <div>
              <div class="toggle-label">{$_('wizard.usermgmt.enable_toggle')}</div>
              <div class="toggle-hint">{$_('wizard.usermgmt.enable_toggle_hint')}</div>
            </div>
            <Toggle checked={enableUserMgmt} on:change={e => enableUserMgmt = e.detail} />
          </div>
        {/if}

        {#if enableUserMgmt}
          <div class="um-form" transition:fly={{ y: 10, duration: 200 }}>
            <p class="um-section-label">{$_('wizard.usermgmt.admin_section')}</p>

            <div class="form-row-2">
              <div class="form-group">
                <label class="form-label">{$_('wizard.usermgmt.username_label')}</label>
                <input class="input" type="text" bind:value={adminUsername} placeholder={$_('wizard.usermgmt.username_placeholder')} autocomplete="username" />
              </div>
              <div class="form-group">
                <label class="form-label">{$_('wizard.usermgmt.nickname_label')}</label>
                <input class="input" type="text" bind:value={adminNickname} placeholder={$_('wizard.usermgmt.nickname_placeholder')} />
              </div>
            </div>

            <div class="form-group">
              <label class="form-label">{$_('wizard.usermgmt.full_name_label')}</label>
              <input class="input" type="text" bind:value={adminFullName} placeholder={$_('wizard.usermgmt.full_name_placeholder')} />
            </div>

            <div class="form-group">
              <label class="form-label">{$_('wizard.usermgmt.email_label')}</label>
              <input class="input" type="email" bind:value={adminEmail}
                placeholder={$_('wizard.usermgmt.email_placeholder')} autocomplete="email" />
            </div>

            <div class="form-row-2">
              <div class="form-group">
                <label class="form-label">Password *</label>
                <input class="input" type="password" bind:value={adminPassword} autocomplete="new-password" passwordrules="minlength: 8; required: upper; required: lower; required: digit; required: special;" placeholder="8+ chars, upper, lower, number, symbol" />
                {#if adminPassword}
                  {@const pwScore = passwordStrength(adminPassword)}
                  <div class="pw-strength" class:s-0={pwScore.score === 0} class:s-1={pwScore.score === 1} class:s-2={pwScore.score === 2} class:s-3={pwScore.score === 3} class:s-4={pwScore.score === 4}>
                    <div class="pw-bar"><div class="pw-fill" style:width={`${(pwScore.score / 4) * 100}%`}></div></div>
                    <span class="pw-label">{pwScore.label}</span>
                  </div>
                {/if}
              </div>
              <div class="form-group">
                <label class="form-label">Confirm *</label>
                <input class="input" type="password" bind:value={adminConfirm} autocomplete="new-password" passwordrules="minlength: 8; required: upper; required: lower; required: digit; required: special;" />
                {#if adminConfirm && adminPassword !== adminConfirm}
                  <p class="pw-mismatch">Passwords don't match</p>
                {/if}
              </div>
            </div>

            {#if umError}
              <p class="um-error">{umError}</p>
            {/if}
          </div>
        {/if}

      <!-- ── Welcome ── -->
      {:else if currentStepName === 'welcome'}
        <div class="step-hero">
          <div class="logo-icon">🥗</div>
          <h1 class="step-title">{$_('wizard.welcome.title')}</h1>
          <p class="step-desc">{$_('wizard.welcome.desc')}</p>
          {#if !(_forceAccountCreation && !$userMgmtActive)}
            <button type="button" class="skip-setup-link" on:click={() => skipSetupConfirm = true}>
              I'll do this later
            </button>
          {/if}
        </div>

      <!-- ── Name (native local mode only) ── -->
      {:else if currentStepName === 'name'}
        <h2 class="step-title">{$_('wizard.name.title')}</h2>
        <p class="step-desc">{$_('wizard.name.desc')}</p>
        <div style="max-width:380px;margin:8px auto 0">
          <input
            class="input"
            type="text"
            placeholder={$_('wizard.name.placeholder')}
            bind:value={localName}
            autocomplete="given-name"
            style="width:100%;font-size:18px;padding:14px 16px;text-align:center" />
        </div>

      <!-- ── Units ── -->
      {:else if currentStepName === 'units'}
        <h2 class="step-title">{$_('wizard.units.title')}</h2>
        <p class="step-desc">{$_('wizard.units.desc')}</p>
        <div class="gender-cards">
          <button class="option-card" class:selected={unitSystem === 'metric'}
            on:click={() => applyUnitSystem('metric')}>
            <span class="material-symbols-rounded" style="font-size:48px">straighten</span>
            <span class="option-label">{$_('wizard.units.metric')}</span>
            <span class="option-sublabel">kg, cm, °C</span>
            {#if unitSystem === 'metric'}
              <span class="material-symbols-rounded check">check_circle</span>
            {/if}
          </button>
          <button class="option-card" class:selected={unitSystem === 'imperial'}
            on:click={() => applyUnitSystem('imperial')}>
            <span class="material-symbols-rounded" style="font-size:48px">scale</span>
            <span class="option-label">{$_('wizard.units.imperial')}</span>
            <span class="option-sublabel">lb, ft/in, °F</span>
            {#if unitSystem === 'imperial'}
              <span class="material-symbols-rounded check">check_circle</span>
            {/if}
          </button>
        </div>

      <!-- ── Gender ── -->
      {:else if currentStepName === 'gender'}
        <h2 class="step-title">{$_('wizard.gender.title')}</h2>
        <p class="step-desc">{$_('wizard.gender.desc')}</p>
        <div class="gender-cards">
          {#each [['male','man','Male'],['female','woman','Female']] as [val, icon, lbl]}
            <button class="option-card" class:selected={gender === val}
              on:click={() => gender = val}>
              <span class="material-symbols-rounded" style="font-size:48px">{icon}</span>
              <span class="option-label">{lbl}</span>
              {#if gender === val}
                <span class="material-symbols-rounded check">check_circle</span>
              {/if}
            </button>
          {/each}
        </div>

      <!-- ── Date of Birth ── -->
      {:else if currentStepName === 'dob'}
        <h2 class="step-title">{$_('wizard.dob.title')}</h2>
        <p class="step-desc">{$_('wizard.dob.desc')}</p>
        <div class="dob-input-wrap">
          <DateInput bind:value={dob} max={localDateStr()} />
        </div>

      <!-- ── Height ── -->
      {:else if currentStepName === 'height'}
        <h2 class="step-title">{$_('wizard.height.title')}</h2>
        <p class="step-desc">{$_('wizard.height.desc')}</p>
        <div style="margin-top:24px;display:flex;flex-direction:column;gap:12px">
          {#if hUnit === 'cm'}
            <label class="form-label">{$_('wizard.height.label_cm')}</label>
            <input class="input" type="text" inputmode="decimal" use:decimalInput bind:value={heightCm} style="font-size:16px" />
          {:else}
            <label class="form-label">{$_('wizard.height.label')}</label>
            <div style="display:flex;gap:10px">
              <div style="flex:1">
                <label class="form-label" style="font-size:11px">{$_('wizard.height.feet')}</label>
                <input class="input" type="text" inputmode="decimal" use:decimalInput bind:value={heightFt} style="font-size:16px" />
              </div>
              <div style="flex:1">
                <label class="form-label" style="font-size:11px">{$_('wizard.height.inches')}</label>
                <input class="input" type="text" inputmode="decimal" use:decimalInput bind:value={heightIn} style="font-size:16px" />
              </div>
            </div>
          {/if}
        </div>

      <!-- ── Current Weight ── -->
      {:else if currentStepName === 'weight'}
        <h2 class="step-title">{$_('wizard.weight.title')}</h2>
        <p class="step-desc">Your current body weight ({wUnit}).</p>
        <input class="input" type="text" inputmode="decimal" use:decimalInput
          bind:value={weight} style="margin-top:24px;font-size:16px" />

      <!-- ── Target Weight ── -->
      {:else if currentStepName === 'target'}
        <h2 class="step-title">{$_('wizard.target.title')}</h2>
        <p class="step-desc">Your goal weight ({wUnit}). Defaults to your current weight — change it if you're trying to lose or gain.</p>
        <input class="input" type="text" inputmode="decimal" use:decimalInput
          bind:value={targetW} on:input={() => _targetTouched = true}
          style="margin-top:24px;font-size:16px" />

      <!-- ── Activity Level ── -->
      {:else if currentStepName === 'activity'}
        <h2 class="step-title">{$_('wizard.activity.title')}</h2>
        <p class="step-desc">{$_('wizard.activity.desc')}</p>
        <div class="activity-list">
          {#each ACTIVITY_LEVELS as lvl}
            <button class="activity-card" class:selected={activity === lvl.value}
              on:click={() => activity = lvl.value}>
              <div class="activity-label" class:selected={activity === lvl.value}>{lvl.label}</div>
              <div class="activity-desc">{lvl.desc}</div>
              {#if activity === lvl.value}
                <span class="material-symbols-rounded check">check_circle</span>
              {/if}
            </button>
          {/each}
        </div>

      <!-- ── Integrations ── -->
      {:else if currentStepName === 'integrations'}
        <div class="step-hero compact">
          <span class="material-symbols-rounded hero-icon">extension</span>
          <h1 class="step-title">{$_('wizard.integrations.title')}</h1>
          <p class="step-desc">{$_('wizard.integrations.desc')}</p>
        </div>

        <div class="int-cards">

          <!-- Open Food Facts -->
          <div class="int-card" class:int-card-skipped={intSkipped.off}>
            <div class="int-card-head">
              <div class="int-card-icon">🥫</div>
              <div class="int-card-info">
                <div class="int-card-title">{$_('wizard.integrations_cards.off')}</div>
                <div class="int-card-sub">Search the global crowd-sourced food database. An account is only needed to upload edits.</div>
              </div>
              {#if intSkipped.off}
                <button class="int-restore-btn" on:click={() => intSkipped = {...intSkipped, off: false}}>{$_('wizard.integrations_cards.configure')}</button>
              {:else}
                <button class="int-skip-btn" on:click={() => intSkipped = {...intSkipped, off: true}}>{$_('wizard.integrations_cards.skip_this')}</button>
              {/if}
            </div>
            {#if !intSkipped.off}
              <div class="int-fields">
                <a href="https://world.openfoodfacts.org/cgi/user.pl" target="_blank" rel="noopener" class="about-link" style="font-size:13px">Create an OFF account →</a>
                <input class="input" type="text"     placeholder={$_('wizard_deep.off_user_ph')} bind:value={intOFFUser}  autocomplete="username" />
                <input class="input" type="password" placeholder={$_('wizard_deep.off_pass_ph')} bind:value={intOFFPass}  autocomplete="current-password" />
              </div>
            {/if}
          </div>

          <!-- USDA FoodData Central -->
          <div class="int-card" class:int-card-skipped={intSkipped.usda}>
            <div class="int-card-head">
              <div class="int-card-icon">🔬</div>
              <div class="int-card-info">
                <div class="int-card-title">{$_('wizard.integrations_cards.usda')}</div>
                <div class="int-card-sub">{$_('wizard_deep.usda_search')}</div>
              </div>
              {#if intSkipped.usda}
                <button class="int-restore-btn" on:click={() => intSkipped = {...intSkipped, usda: false}}>{$_('wizard.integrations_cards.configure')}</button>
              {:else}
                <button class="int-skip-btn" on:click={() => intSkipped = {...intSkipped, usda: true}}>{$_('wizard.integrations_cards.skip_this')}</button>
              {/if}
            </div>
            {#if !intSkipped.usda}
              <div class="int-fields">
                <a href="https://fdc.nal.usda.gov/api-key-signup" target="_blank" rel="noopener" class="about-link" style="font-size:13px">Get a free API key →</a>
                <input class="input" type="text" placeholder={$_('wizard_deep.usda_key_ph')} bind:value={intUSDARKey} />
              </div>
            {/if}
          </div>

          <!-- Mealie -->
          <div class="int-card" class:int-card-skipped={intSkipped.mealie}>
            <div class="int-card-head">
              <div class="int-card-icon">🍽️</div>
              <div class="int-card-info">
                <div class="int-card-title">{$_('wizard.integrations_cards.mealie')}</div>
                <div class="int-card-sub">Import recipes from your self-hosted Mealie instance</div>
              </div>
              {#if intSkipped.mealie}
                <button class="int-restore-btn" on:click={() => intSkipped = {...intSkipped, mealie: false}}>{$_('wizard.integrations_cards.configure')}</button>
              {:else}
                <button class="int-skip-btn" on:click={() => intSkipped = {...intSkipped, mealie: true}}>{$_('wizard.integrations_cards.skip_this')}</button>
              {/if}
            </div>
            {#if !intSkipped.mealie}
              <div class="int-fields">
                <input class="input" type="url"  placeholder={$_('wizard_deep.mealie_url_ph')} bind:value={intMealieUrl} />
                <input class="input" type="password" placeholder={$_('wizard_deep.mealie_token_ph')} bind:value={intMealieToken} autocomplete="off" />
              </div>
            {/if}
          </div>

          <!-- AI Assistant -->
          {#if intAILocked}
            <div class="int-card int-card-locked">
              <div class="int-card-head">
                <div class="int-card-icon">🤖</div>
                <div class="int-card-info">
                  <div class="int-card-title">{$_('wizard.integrations_cards.ai')}</div>
                  <div class="int-card-sub int-locked-label">{$_('wizard_deep.env_locked')}</div>
                </div>
                <span class="material-symbols-rounded int-lock-icon">lock</span>
              </div>
            </div>
          {:else}
            <div class="int-card" class:int-card-skipped={intSkipped.ai}>
              <div class="int-card-head">
                <div class="int-card-icon">🤖</div>
                <div class="int-card-info">
                  <div class="int-card-title">{$_('wizard.integrations_cards.ai')}</div>
                  <div class="int-card-sub">Trace, your AI nutrition assistant — bring your own API key</div>
                </div>
                {#if intSkipped.ai}
                  <button class="int-restore-btn" on:click={() => intSkipped = {...intSkipped, ai: false}}>{$_('wizard.integrations_cards.configure')}</button>
                {:else}
                  <button class="int-skip-btn" on:click={() => intSkipped = {...intSkipped, ai: true}}>{$_('wizard.integrations_cards.skip_this')}</button>
                {/if}
              </div>
              {#if !intSkipped.ai}
                <div class="int-fields">
                  <select class="input" bind:value={intAIProvider}>
                    <option value="claude">Anthropic (Claude)</option>
                    <option value="openai">OpenAI (ChatGPT)</option>
                    <option value="gemini">Google (Gemini)</option>
                  </select>
                  <input class="input" type="password" placeholder={$_('wizard_deep.api_key_ph')} bind:value={intAIKey} autocomplete="off" />
                </div>
              {/if}
            </div>
          {/if}

        </div>

        <!-- Integration summary: three states — Configured, Skipped, or Open
             but blank (in neither list). Don't label a card "Skipped" unless
             the user actually clicked Skip. OFF is a special case: search
             works without credentials, so just having the card open counts
             as configured (an account is upload-only). -->
        {@const _intCfg = [
          { k: 'off',    label: 'Open Food Facts', configured: !intSkipped.off,                                                              skipped: intSkipped.off    },
          { k: 'usda',   label: 'USDA',            configured: !intSkipped.usda   && !!intUSDARKey.trim(),                                   skipped: intSkipped.usda   },
          { k: 'mealie', label: 'Mealie',          configured: !intSkipped.mealie && !!(intMealieUrl.trim() && intMealieToken.trim()),       skipped: intSkipped.mealie },
          { k: 'ai',     label: 'AI Assistant',    configured: !intSkipped.ai     && (intAILocked || !!intAIKey.trim()),                     skipped: intSkipped.ai     },
        ]}
        {@const _configured = _intCfg.filter(x => x.configured).map(x => x.label)}
        {@const _skipped    = _intCfg.filter(x => x.skipped).map(x => x.label)}
        <div class="int-summary">
          {#if _configured.length > 0}
            <div class="int-summary-row">
              <span class="material-symbols-rounded" style="font-size:16px;color:var(--accent)">check_circle</span>
              <span>Configured: <strong>{_configured.join(', ')}</strong></span>
            </div>
          {/if}
          {#if _skipped.length > 0}
            <div class="int-summary-row int-summary-skip">
              <span class="material-symbols-rounded" style="font-size:16px">remove_circle</span>
              <span>Skipped: {_skipped.join(', ')}</span>
            </div>
          {/if}
          <div class="int-summary-hint">You can change these anytime in Settings.</div>
        </div>

      <!-- ── Notifications ── -->
      {:else if currentStepName === 'notifications'}
        <div class="step-hero compact">
          <span class="material-symbols-rounded hero-icon">notifications</span>
          <h1 class="step-title">{$_('wizard.notifications.title')}</h1>
          <p class="step-desc">{$_('wizard.notifications.desc')}</p>
        </div>

        <div class="int-cards">
          <div class="int-card" class:int-card-skipped={!notifEnabled}>
            <div class="int-card-head">
              <div class="int-card-icon">🔔</div>
              <div class="int-card-info">
                <div class="int-card-title">{$_('wizard_deep.enable_notifications')}</div>
                <div class="int-card-sub">Reminders, goal celebrations, and health alerts</div>
              </div>
              <Toggle checked={notifEnabled} on:change={e => notifEnabled = e.detail} />
            </div>
          </div>

          {#if notifEnabled}
            <div class="int-card">
              <div class="int-card-head">
                <div class="int-card-icon">💧</div>
                <div class="int-card-info">
                  <div class="int-card-title">{$_('wizard_deep.hydration_reminders')}</div>
                  <div class="int-card-sub">Periodic reminders to drink water (8am–10pm)</div>
                </div>
                <Toggle checked={notifWater} on:change={e => notifWater = e.detail} />
              </div>
            </div>

            <div class="int-card">
              <div class="int-card-head">
                <div class="int-card-icon">🍽️</div>
                <div class="int-card-info">
                  <div class="int-card-title">{$_('wizard_deep.meal_reminders')}</div>
                  <div class="int-card-sub">Daily reminders to log breakfast, lunch, and dinner</div>
                </div>
                <Toggle checked={notifMeals} on:change={e => notifMeals = e.detail} />
              </div>
            </div>

            <div class="int-card">
              <div class="int-card-head">
                <div class="int-card-icon">🎯</div>
                <div class="int-card-info">
                  <div class="int-card-title">{$_('wizard_deep.goal_celebrations')}</div>
                  <div class="int-card-sub">Celebrate when you hit your daily nutrition, water, or step goals</div>
                </div>
                <Toggle checked={notifGoals} on:change={e => notifGoals = e.detail} />
              </div>
            </div>

            <div class="int-card">
              <div class="int-card-head">
                <div class="int-card-icon">⚠️</div>
                <div class="int-card-info">
                  <div class="int-card-title">{$_('wizard_deep.wellness_alerts')}</div>
                  <div class="int-card-sub">Alerts when HRV drops, sleep declines, or heart rate spikes</div>
                </div>
                <Toggle checked={notifWellness} on:change={e => notifWellness = e.detail} />
              </div>
            </div>
          {/if}
        </div>

      <!-- ── Summary ── -->
      {:else if currentStepName === 'summary'}
        {@const _tdeeDisp = Nutrition.displayEnergy(tdee, $energyUnit)}
        {@const _goalDisp = Nutrition.displayEnergy(goalKcal, $energyUnit)}
        <h2 class="step-title">{$_('wizard.summary.title')}</h2>
        <p class="step-desc">{$_('wizard.summary.desc')}</p>
        {@const _goalFactor = goalKcal === tdee ? 1.0 : goalKcal < tdee ? 0.8 : 1.2}
        {@const _factorLabel = _goalFactor === 0.8 ? 'Lose −20%' : _goalFactor === 1.2 ? 'Gain +20%' : 'Maintain'}
        <div class="summary-card">
          <div class="tdee-row">
            <div class="tdee-label">{$_('wizard_deep.starting_tdee')}</div>
            <div class="tdee-value">{_tdeeDisp.value.toLocaleString()}</div>
            <div class="tdee-unit">{_tdeeDisp.unit} / day</div>
            <div class="tdee-help">Total Daily Energy Expenditure · Mifflin-St Jeor + activity level</div>
          </div>
          <hr style="border:none;border-top:1px solid var(--border);margin:16px 0" />
          <div class="summary-rows">
            <div class="summary-row">
              <span class="text-3">{$energyUnit === 'kJ' ? 'Energy goal' : 'Calorie goal'}<br><span style="font-size:11px;opacity:0.7">{_factorLabel} ({Math.round(_goalFactor * 100)}% of TDEE)</span></span>
              <strong>{_goalDisp.value.toLocaleString()} {_goalDisp.unit}/day</strong>
            </div>
            <div class="summary-row">
              <span class="text-3">{$_('wizard_deep.water_goal')}</span>
              <strong>{waterGoal >= 1000 ? (waterGoal / 1000).toFixed(1) + ' L' : waterGoal + ' ml'}/day</strong>
            </div>
            <div class="summary-row">
              <span class="text-3">{$_('wizard_deep.current_weight')}</span>
              <span>{weight} {wUnit}</span>
            </div>
            <div class="summary-row">
              <span class="text-3">{$_('wizard_deep.target_weight')}</span>
              <span>{targetW} {wUnit}</span>
            </div>
            <div class="summary-row">
              <span class="text-3">{$_('wizard_deep.activity_level')}</span>
              <span>{ACTIVITY_LEVELS.find(l=>l.value===activity)?.label || activity}</span>
            </div>
          </div>
          <p class="text-3" style="font-size:12px;margin-top:12px;text-align:center;line-height:1.5">
            {$_('wizard_deep.adjust_note')}
          </p>
        </div>
      {/if}

    </div>
  {/key}

  <!-- Nav buttons -->
  <div class="wizard-nav">
    {#if step > 0}
      <button class="btn btn-secondary" on:click={prev}>{$_('common.back')}</button>
    {:else}
      <div></div>
    {/if}
    <button class="btn btn-primary" on:click={next} disabled={!canProceed || umLoading}>
      {#if umLoading}
        <span class="material-symbols-rounded spin">autorenew</span>
      {:else}
        {btnLabel}
      {/if}
    </button>
  </div>
  {/if}
</div>

{#if skipSetupConfirm}
  <div class="skip-modal-backdrop" on:click|self={() => skipSetupConfirm = false}>
    <div class="skip-modal" on:click|stopPropagation>
      <h3 class="skip-modal-title">{$_('wizard.skip_modal.title')}</h3>
      <p class="skip-modal-desc">
        {@html $_('wizard.skip_modal.desc')}
      </p>
      <div class="skip-modal-actions">
        <button class="btn btn-secondary" on:click={() => skipSetupConfirm = false}>{$_('wizard.skip_modal.continue')}</button>
        <button class="btn btn-primary" on:click={() => { skipSetupConfirm = false; skip(); }}>{$_('wizard.skip_modal.skip_now')}</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .wizard-shell {
    min-height: 100dvh;
    display: flex;
    flex-direction: column;
    padding: calc(var(--safe-top) + 16px) var(--page-px) calc(var(--safe-bottom) + 24px);
    gap: 24px;
  }
  .wizard-topbar { display: flex; justify-content: flex-end; min-height: 32px; }
  .wizard-skip { font-size: 14px; color: var(--text-3); height: 32px; padding: 0 8px; }

  .progress-dots { display: flex; gap: 6px; justify-content: center; }
  .dot {
    width: 7px; height: 7px;
    border-radius: 50%;
    background: var(--surface-3);
    transition: all var(--dur-base) var(--ease-spring);
  }
  .dot.active  { background: var(--accent-dim); }
  .dot.current { background: var(--accent); width: 22px; border-radius: var(--radius-full); }

  .wizard-step { flex: 1; display: flex; flex-direction: column; gap: 20px; }

  .step-hero {
    flex: 1;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 20px; text-align: center; padding: 24px 0;
  }
  .step-hero.compact { flex: 0; padding: 8px 0 0; }
  .logo-icon { font-size: 72px; line-height: 1; }
  .hero-icon { font-size: 48px; color: var(--accent); }
  .step-title { font-size: 26px; font-weight: 700; letter-spacing: -0.02em; }
  .step-desc  { font-size: 16px; color: var(--text-2); line-height: 1.6; max-width: 320px; }

  .skip-setup-link {
    margin-top: 24px;
    background: none; border: none; cursor: pointer;
    color: var(--text-3); font-size: 14px; text-decoration: underline;
    padding: 8px 16px;
  }
  .skip-setup-link:hover { color: var(--text-2); }

  .skip-modal-backdrop {
    position: fixed; inset: 0; z-index: 1000;
    background: rgba(0,0,0,0.5); display: flex;
    align-items: center; justify-content: center;
    padding: 24px;
  }
  .skip-modal {
    background: var(--surface-1); border-radius: var(--radius-lg);
    padding: 24px; max-width: 360px; width: 100%;
    display: flex; flex-direction: column; gap: 12px;
  }
  .skip-modal-title { font-size: 18px; font-weight: 600; margin: 0; }
  .skip-modal-desc  { font-size: 14px; color: var(--text-2); line-height: 1.5; margin: 0; }
  .skip-modal-actions { display: flex; gap: 8px; margin-top: 8px; }
  .skip-modal-actions .btn { flex: 1; }

  /* User management toggle */
  .toggle-row {
    display: flex; align-items: center; justify-content: space-between;
    gap: 16px; padding: 14px 16px;
    background: var(--surface-1); border: 1px solid var(--border);
    border-radius: var(--radius-lg); cursor: pointer;
  }
  .toggle-label { font-size: 15px; font-weight: 600; }
  .toggle-hint  { font-size: 12px; color: var(--text-3); margin-top: 2px; }

  /* User mgmt form */
  .um-form { display: flex; flex-direction: column; gap: 12px; }
  .um-section-label {
    font-size: 12px; font-weight: 600; text-transform: uppercase;
    letter-spacing: 0.08em; color: var(--text-3); margin-bottom: -4px;
  }
  .form-row-2 { display: flex; gap: 10px; }
  .form-row-2 > .form-group { flex: 1; }
  .form-group { display: flex; flex-direction: column; gap: 4px; }
  .um-error {
    font-size: 13px; color: var(--error, #ff6b6b);
    background: rgba(255,107,107,0.1); border-radius: var(--radius-sm);
    padding: 8px 12px;
  }
  /* Password strength indicator */
  .pw-strength { display: flex; align-items: center; gap: 8px; margin-top: 6px; }
  .pw-bar { flex: 1; height: 4px; background: var(--surface-2); border-radius: var(--radius-full); overflow: hidden; }
  .pw-fill { height: 100%; border-radius: var(--radius-full); transition: width var(--dur-base), background var(--dur-fast); }
  .pw-strength.s-0 .pw-fill, .pw-strength.s-1 .pw-fill { background: var(--danger, #ef4444); }
  .pw-strength.s-2 .pw-fill { background: #f59e0b; }
  .pw-strength.s-3 .pw-fill { background: var(--accent); }
  .pw-strength.s-4 .pw-fill { background: var(--success, #22c55e); }
  .pw-label { font-size: 11px; font-weight: 600; color: var(--text-3); min-width: 64px; text-align: right; }
  .pw-strength.s-4 .pw-label { color: var(--success, #22c55e); }
  .pw-strength.s-0 .pw-label, .pw-strength.s-1 .pw-label { color: var(--danger, #ef4444); }
  .pw-mismatch { color: var(--danger, #ef4444); font-size: 11px; margin: 4px 0 0; }

  /* Gender cards */
  .gender-cards { display: flex; gap: 16px; margin-top: 16px; }
  .option-card {
    flex: 1;
    display: flex; flex-direction: column; align-items: center;
    gap: 8px; padding: 24px 16px;
    border-radius: var(--radius-lg);
    background: var(--surface-1); border: 2px solid var(--border);
    cursor: pointer; position: relative;
    transition: border-color var(--dur-fast), background var(--dur-fast);
    color: var(--text-1);
  }
  .option-card.selected { border-color: var(--accent); background: var(--accent-dim); }
  .option-label { font-size: 16px; font-weight: 600; }
  .option-sublabel { font-size: 13px; color: var(--text-3); }
  .check { position: absolute; right: 10px; top: 10px; color: var(--accent); font-size: 20px; }

  /* Activity list */
  .activity-list { display: flex; flex-direction: column; gap: 8px; }
  .activity-card {
    display: flex; flex-direction: column; align-items: flex-start;
    gap: 2px; padding: 12px 16px;
    border-radius: var(--radius-lg);
    background: var(--surface-1); border: 2px solid var(--border);
    cursor: pointer; position: relative; text-align: left;
    transition: border-color var(--dur-fast), background var(--dur-fast);
    color: var(--text-1);
  }
  .activity-card.selected { border-color: var(--accent); background: var(--accent-dim); }
  .activity-label { font-size: 15px; font-weight: 600; color: var(--text-1); }
  .activity-label.selected { color: var(--accent); }
  .activity-desc { font-size: 12px; color: var(--text-3); }

  /* Summary */
  .summary-card {
    background: var(--surface-1); border-radius: var(--radius-lg);
    padding: 20px; border: 1px solid var(--border);
    margin-top: 8px;
  }
  .tdee-row { text-align: center; }
  .tdee-label { font-size: 13px; color: var(--text-3); margin-bottom: 4px; }
  .tdee-value { font-size: 48px; font-weight: 700; color: var(--accent); line-height: 1; }
  .tdee-unit  { font-size: 14px; color: var(--text-3); margin-top: 4px; }
  .tdee-help  { font-size: 11px; color: var(--text-3); margin-top: 8px; opacity: 0.75; line-height: 1.4; }
  .summary-rows { display: flex; flex-direction: column; gap: 8px; }
  .summary-row { display: flex; justify-content: space-between; font-size: 14px; }

  .wizard-nav {
    display: flex; justify-content: space-between; gap: 12px;
  }
  .wizard-nav .btn { flex: 1; }

  /* Integrations step */
  .int-cards {
    display: flex; flex-direction: column; gap: 10px;
    overflow-y: auto; flex: 1;
  }
  .int-summary {
    margin-top: 12px; padding: 12px 14px;
    background: var(--surface-2); border-radius: var(--radius-md);
    display: flex; flex-direction: column; gap: 6px;
    font-size: 13px;
  }
  .int-summary-row {
    display: flex; align-items: center; gap: 8px;
    color: var(--text-1);
  }
  .int-summary-row.int-summary-skip { color: var(--text-3); }
  .int-summary-row.int-summary-skip .material-symbols-rounded { color: var(--text-3); }
  .int-summary-hint { font-size: 11px; color: var(--text-3); margin-top: 2px; }
  .int-card {
    background: var(--surface-1); border: 1.5px solid var(--border);
    border-radius: var(--radius-lg); overflow: hidden;
    transition: opacity var(--dur-fast), border-color var(--dur-fast);
  }
  .int-card-skipped { opacity: 0.55; }
  .int-card-locked  { border-color: var(--accent-dim); }
  .int-card-head {
    display: flex; align-items: center; gap: 12px;
    padding: 12px 14px;
  }
  .int-card-icon { font-size: 24px; line-height: 1; flex-shrink: 0; }
  .int-card-info { flex: 1; min-width: 0; }
  .int-card-title { font-size: 14px; font-weight: 600; }
  .int-card-sub   { font-size: 11px; color: var(--text-3); margin-top: 1px; }
  .int-locked-label { color: var(--accent); }
  .int-lock-icon  { font-size: 18px; color: var(--accent); flex-shrink: 0; }
  .int-skip-btn {
    font-size: 12px; color: var(--text-3); background: none; border: none;
    cursor: pointer; padding: 4px 8px; border-radius: var(--radius-sm);
    flex-shrink: 0;
  }
  .int-skip-btn:hover { color: var(--text-1); background: var(--surface-2); }
  .int-restore-btn {
    font-size: 12px; color: var(--accent); background: none; border: none;
    cursor: pointer; padding: 4px 8px; border-radius: var(--radius-sm);
    font-weight: 600; flex-shrink: 0;
  }
  .int-restore-btn:hover { background: var(--accent-dim); }
  .int-fields {
    display: flex; flex-direction: column; gap: 8px;
    padding: 0 14px 14px;
  }
  .int-fields .input { font-size: 14px; }

  @keyframes spin { to { transform: rotate(360deg); } }
  .spin { animation: spin 0.8s linear infinite; }

  .dob-input-wrap {
    margin: 24px auto 0;
    max-width: 360px;
  }

  /* Celebration screen shown briefly between finishing the wizard and
     landing in the diary. Ported byte-for-byte from LiftTrace's Wizard
     polish so the cross-app onboarding closure feels identical. */
  .wizard-done {
    position: relative;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 10px;
    padding: 48px 16px;
    text-align: center;
    overflow: hidden;
  }
  .wizard-done-icon {
    font-size: 72px;
    color: var(--accent);
    filter: drop-shadow(0 2px 14px color-mix(in srgb, var(--accent) 40%, transparent));
    animation: wizard-done-pop 0.5s var(--ease-out, cubic-bezier(0.34, 1.56, 0.64, 1)) both;
  }
  .wizard-done-title {
    font-size: 24px; font-weight: 800; margin: 0; color: var(--text-1);
    letter-spacing: -0.01em;
  }
  .wizard-done-sub { font-size: 14px; color: var(--text-3); margin: 0; }
  .wizard-confetti {
    position: absolute; inset: 0; pointer-events: none; overflow: hidden;
  }
  .wizard-confetti .conf {
    position: absolute; top: -8px; left: var(--x, 50%);
    width: 8px; height: 8px; border-radius: 2px;
    --x: calc(50% + (var(--i) - 7) * 22px);
    animation: wizard-conf-fall 1.6s ease-out var(--d, 0s) forwards;
    --d: calc(var(--i) * 60ms);
  }
  .wizard-confetti .c0 { background: var(--accent); }
  .wizard-confetti .c1 { background: color-mix(in srgb, var(--accent) 70%, white); }
  .wizard-confetti .c2 { background: #ffd166; }
  .wizard-confetti .c3 { background: #06d6a0; }
  .wizard-confetti .c4 { background: #ef476f; }
  .wizard-confetti .c5 { background: #118ab2; }
  .wizard-confetti .c6 { background: #f78c6b; }
  @keyframes wizard-done-pop {
    0%   { transform: scale(0.4); opacity: 0; }
    60%  { transform: scale(1.1); opacity: 1; }
    100% { transform: scale(1); opacity: 1; }
  }
  @keyframes wizard-conf-fall {
    0%   { transform: translate(0, -20px) rotate(0deg); opacity: 1; }
    100% { transform: translate(calc((var(--i) - 7) * 6px), 220px) rotate(540deg); opacity: 0; }
  }
  @media (prefers-reduced-motion: reduce) {
    .wizard-confetti { display: none; }
    .wizard-done-icon { animation: none; }
  }
</style>
