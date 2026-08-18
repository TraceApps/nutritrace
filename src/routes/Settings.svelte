<script>
  // Thin router shell. All 25 (26 counting About) section bodies live in
  // routes/settings/*.svelte and are dispatched to via svelte:component
  // when the URL is /settings/<slug>. The /settings index just renders
  // the section-toggle rows + group labels + profile hero + search bar.
  //
  // History note: this file used to be the ~4200-line monolith that
  // owned every section's state, template, and CSS inline. The extracted
  // per-section files are the source of truth now; this shell only
  // holds cross-section chrome (header, sticky search, drill-in nav,
  // deep-link scroll) and the shared CSS descendants need via :global.

  import { onMount, tick } from 'svelte';
  import { push, querystring } from 'svelte-spa-router';
  import { _ } from 'svelte-i18n';

  import { currentUser, userMgmtActive } from '../stores/auth.js';
  import { isNative, getServerUrl, resolveAssetUrl, apiUrl, getAuthToken } from '../lib/platform.js';
  import { bannerStyle, envLocks as envLocksStore } from '../stores/settings.js';

  // Per-section pages — one component per slug, dispatched by
  // SECTION_COMPONENTS below.
  import Appearance        from './settings/Appearance.svelte';
  import Regional          from './settings/Regional.svelte';
  import Diary             from './settings/Diary.svelte';
  import Water             from './settings/Water.svelte';
  import Foods             from './settings/Foods.svelte';
  import Goals             from './settings/Goals.svelte';
  import BodyStats         from './settings/BodyStats.svelte';
  import Statistics        from './settings/Statistics.svelte';
  import Nutrients         from './settings/Nutrients.svelte';
  import Categories        from './settings/Categories.svelte';
  import Muscles           from './settings/Muscles.svelte';
  import People            from './settings/People.svelte';
  import CustomUnits       from './settings/CustomUnits.svelte';
  import ConnectedServices from './settings/ConnectedServices.svelte';
  import Ai                from './settings/Ai.svelte';
  import Wellness          from './settings/Wellness.svelte';
  import ServerConnection  from './settings/ServerConnection.svelte';
  import Notifications     from './settings/Notifications.svelte';
  import Backup            from './settings/Backup.svelte';
  import ImportExport      from './settings/ImportExport.svelte';
  import Sharing           from './settings/Sharing.svelte';
  import Updates           from './settings/Updates.svelte';
  import HelpImprove       from './settings/HelpImprove.svelte';
  import Users             from './settings/Users.svelte';
  import Authentication    from './settings/Authentication.svelte';
  import Email             from './settings/Email.svelte';
  import ApiTokens         from './settings/ApiTokens.svelte';
  import About             from './settings/About.svelte';

  // ── Route param → current section ──────────────────────────────────────
  // svelte-spa-router route `/settings/:section` → params.section.
  // `/settings` (no param) → currentSection = null → index view.
  export let params = {};
  $: currentSection = params?.section || null;

  // ── Drill-in navigation ────────────────────────────────────────────────
  // Tapping a section row on the index routes to /settings/<slug>. If the
  // user has an active search query, forward it as ?q=<query> so the
  // sub-page can auto-scroll to the matching setting on land.
  function toggleSection(key) {
    if (currentSection === key) push('/settings');
    else {
      const q = settingsQuery ? `?q=${encodeURIComponent(settingsQuery)}` : '';
      push(`/settings/${key}${q}`);
    }
  }
  // Reverse the peel-in animation on tap: swap the back button + title
  // into their -out classes so the reversed CSS keyframe plays, then
  // navigate after the animation completes. Guards against double-tap
  // starting a second exit while the first is still playing.
  let _leaving = false;
  async function backToIndex() {
    if (_leaving) return;
    _leaving = true;
    // Match the -out animation duration below (240ms) so the button
    // finishes retreating into the title before /settings mounts.
    await new Promise(r => setTimeout(r, 240));
    push('/settings');
  }

  // ── Settings search (index only) ───────────────────────────────────────
  let settingsSearch = '';
  $: settingsQuery = settingsSearch.toLowerCase().trim();

  // Section metadata — slug → title i18n key + icon. Used by the sub-page
  // header to show the section name.
  const SECTION_META = {
    appearance:        { titleKey: 'settings.appearance.section',        icon: 'contrast' },
    regional:          { titleKey: 'settings.regional.section',          icon: 'public' },
    diary:             { titleKey: 'settings.diary.section',             icon: 'menu_book' },
    water:             { titleKey: 'settings.water.section',             icon: 'water_drop' },
    foods:             { titleKey: 'settings.foods.section',             icon: 'lunch_dining' },
    goals:             { titleKey: 'settings.goals.section',             icon: 'flag' },
    bodyStats:         { titleKey: 'settings.body_stats.section',        icon: 'straighten' },
    statistics:        { titleKey: 'settings.statistics.section',        icon: 'bar_chart' },
    nutrients:         { titleKey: 'settings.nutrients.section',         icon: 'science' },
    categories:        { titleKey: 'settings.categories.section',        icon: 'category' },
    muscles:           { titleKey: 'settings.muscles.section',           icon: 'fitness_center' },
    people:            { titleKey: 'settings.people.section',            icon: 'group' },
    customUnits:       { titleKey: 'settings_stats.custom_units',        icon: 'straighten' },
    connectedServices: { titleKey: 'settings.connected_services.section',icon: 'link' },
    ai:                { titleKey: 'settings.ai.section',                icon: 'bolt' },
    wellness:          { titleKey: 'settings.wellness.section',          icon: 'favorite' },
    serverConnection:  { titleKey: 'settings.server.section',            icon: 'cloud' },
    notifications:     { titleKey: 'settings.notifications.section',     icon: 'notifications' },
    backup:            { titleKey: 'settings.backup.section',            icon: 'archive' },
    importExport:      { titleKey: 'settings.importExport.section',      icon: 'import_export' },
    sharing:           { titleKey: 'settings.sharing.section',           icon: 'group' },
    updates:           { titleKey: 'settings.updates.section',           icon: 'system_update' },
    helpImprove:       { titleKey: 'settings.diagnostics.section',       icon: 'troubleshoot' },
    users:             { titleKey: 'settings.users.section',             icon: 'group' },
    authentication:    { titleKey: 'settings.authentication.section',    icon: 'shield_person' },
    email:             { titleKey: 'settings.email.section',             icon: 'mail' },
    apiTokens:         { titleKey: null,                                 icon: 'key' },
    about:             { titleKey: 'settings.about.section',             icon: 'info' },
  };

  // Slug → per-section component. Drives the <svelte:component> dispatch
  // in the sub-page view.
  const SECTION_COMPONENTS = {
    appearance:        Appearance,
    regional:          Regional,
    diary:             Diary,
    water:             Water,
    foods:             Foods,
    goals:             Goals,
    bodyStats:         BodyStats,
    statistics:        Statistics,
    nutrients:         Nutrients,
    categories:        Categories,
    muscles:           Muscles,
    people:            People,
    customUnits:       CustomUnits,
    connectedServices: ConnectedServices,
    ai:                Ai,
    wellness:          Wellness,
    serverConnection:  ServerConnection,
    notifications:     Notifications,
    backup:            Backup,
    importExport:      ImportExport,
    sharing:           Sharing,
    updates:           Updates,
    helpImprove:       HelpImprove,
    users:             Users,
    authentication:    Authentication,
    email:             Email,
    apiTokens:         ApiTokens,
    about:             About,
  };

  // Keyword index for the settings search bar. Adding new keywords here
  // (rather than in the extracted sections) keeps the search results
  // reachable even when the section body isn't mounted — the search
  // runs on the index, before drill-in.
  const SECTION_KEYWORDS = {
    serverConnection:  ['server','connection','sync','cloud','local','remote','connect','disconnect','url'],
    authentication:    ['authentication','auth','sso','single sign-on','single sign on','oidc','openid','authentik','keycloak','authelia','pocket id','auth0','google','password login','admin group'],
    appearance:        ['appearance','theme','dark','light','accent','color','navigation','sidebar','persistent','start page','animations','celebrations','reduce motion','banner','page banner'],
    regional:          ['regional','language','translation','date format','time format','locale','date','time','12h','24h','units','energy unit','weight unit','height','circumference','distance','temperature','imperial','metric'],
    diary:             ['diary','brands','timestamps','thumbnails','nutrients','nutrition units','macros','macro summary','prompt quantity','portion size','nutrition bar','goals progress','meal names','meals','activity','activity section','exercise','activity template','workout template','template','compendium','met','fasting','fast','intermittent fasting','if','16:8','omad','time restricted','unit metadata','unit conversion','unit conversions','nutrition basis','basis','serving units','serving sizes','density','g/ml','slice','bottle','cookie','milliliter','milliliters','mass','volume','oil','honey','warn','daily notes','notes','quick calories','quick cal','bolt','adjust calorie','calorie adjustment','earn back','wearable activity','activity policy'],
    foods:             ['foods','thumbnails','category','notes','yesterday meals','sort order','sort','barcode','scan','beep','flashlight','crop photos','search all','all sources','merged search','default source','default search','my foods','off','usda','mealie'],
    water:             ['water','display unit','daily goal','containers','bottle','cup','glass'],
    categories:        ['categories','food categories','tags','labels'],
    muscles:           ['muscles','muscle groups','tags','exercises','lifts','gym','workout','chest','back','legs'],
    people:            ['people','persons','lifters','partner','family','shared account','who','names'],
    customUnits:       ['units','custom units','unit dropdown','shot','scoop','stick','add unit'],
    nutrients:         ['nutrients','nutriments','custom nutrients','vitamins','minerals'],
    goals:             ['goals','calorie goal','dynamic calorie','adaptive','adaptive tdee','adaptive calorie','tdee','energy expenditure','burn','calories out','factor','lose','gain','maintain','activity','exercise','weight trend','macrofactor','learn','fixed'],
    bodyStats:         ['body stats','body','weight','measurements','stats','body fat','body water','hydration','muscle','bone'],
    statistics:        ['statistics','chart','y-axis','average','goal line','trend','stats','exercises','lifts'],
    connectedServices: ['food sources','connected services','usda','open food facts','mealie','recipe','search language','country','api key','credentials','username','password'],
    ai:                ['ai','trace','assistant','provider','model','custom model','model id','api key','artificial intelligence','chat','smart log','voice','quick log','goal insights','claude','openai','gemini','sonnet','opus','haiku','gpt','gemini 3','ollama','lm studio','deepseek','groq','openai compatible','oai-compat','base url'],
    notifications:     ['notifications','reminders','water reminder','meal reminder','weigh-in','weigh in','gotify','apprise','ntfy','push','alerts','wellness alerts','goal celebration','weekly summary','email summary'],
    wellness:          ['wellness','activity tracking','fitbit','withings','garmin','health connect','steps','sleep','heart rate','hrv','spo2','sync mode','sync range','connect','disconnect','connected devices','fitness tracker','body battery','stress','lifttrace','workout','calories burned','wearable'],
    sharing:           ['sharing','share','group','catalogue','catalog','visibility','private','members','food sharing'],
    backup:            ['backup','full backup','restore','zip','images','clear data','reset','defaults','clear settings','danger zone'],
    importExport:      ['import','export','import & export','json','csv','bulk import','foods bulk','myfitnesspal','mfp','loseit','lose it','cronometer','spreadsheet','migrate','migration','from another app','diary csv'],
    email:             ['email','smtp','mail','password reset','invites','notifications'],
    profile:           ['profile','my profile','account','name','nickname','birthday','dob','gender','sex','avatar','log out','logout','sign out','password','change password','biometric','fingerprint','face unlock','face id'],
    users:             ['users','user management','accounts','login','admin','register','invite','revoke','pending invite','session','session duration','password policy','strong password','strong passwords','require strong','zxcvbn'],
    apiTokens:         ['api','api tokens','token','federation','cooktrace','lifttrace','bearer','integration','integrations','external','third-party','third party'],
    helpImprove:       ['diagnostics','logs','verbose','calibration','export','bug','report','troubleshoot'],
    updates:           ['updates','update','upgrade','version','new version','changelog','release','releases','apk','install','download','check for updates','auto-check','channel','stable','dev','dev-latest','beta','github','server update','docker','compose','docker-compose'],
    about:             ['about','version','nutritrace'],
  };

  // Sub-page mode hides every non-matching row via subpage-view :global()
  // rules in the shell CSS, but keep the row-level guard too so the
  // index-mode search filter still works: on the index, only sections
  // whose keywords include the query show up.
  $: sectionVisible = (query, key) => {
    if (currentSection) return key === currentSection;
    if (!query) return true;
    return (SECTION_KEYWORDS[key] || []).some(kw => kw.includes(query));
  };

  // Admin group + Server Connection index row visibility. `isNativeLocal`
  // is native standalone (no server bound). Reactive on getServerUrl()
  // is unnecessary here — the value doesn't flip without a full reload
  // (setServerUrl reloads the page).
  $: isNativeLocal = isNative && !getServerUrl();

  // ── Deep-link search scroll ────────────────────────────────────────────
  // When the user searches on the main page then drills into a section,
  // the query travels along as ?q=<term>. On sub-page mount we scan the
  // rendered section body for the first row whose label OR description
  // text contains that term, scroll it into view, and briefly highlight
  // it. Turns "type 'dark' → tap Appearance" into a single-tap jump to
  // the Dark mode row.
  //
  // No per-setting index: we just walk the DOM. This works out of the
  // box for every setting whose visible label text matches the query,
  // and stays correct automatically as settings are added or renamed.
  $: _urlQuery = $querystring ? new URLSearchParams($querystring).get('q') : null;

  // Fire the scroll exactly once per (section, query) landing. Keyed
  // memo prevents a re-run loop when _scheduleDeepLinkScroll ends up
  // touching any store the reactive statement transitively depends on.
  let _lastDeepLinkKey = null;
  $: {
    const key = `${currentSection || ''}|${_urlQuery || ''}`;
    if (currentSection && _urlQuery && key !== _lastDeepLinkKey) {
      _lastDeepLinkKey = key;
      _scheduleDeepLinkScroll(_urlQuery);
    }
  }

  async function _scheduleDeepLinkScroll(q) {
    // Wait two ticks so the section body's mount + any transition has
    // laid out its final geometry before we measure/scroll.
    await tick();
    await new Promise(r => setTimeout(r, 60));
    const q_norm = q.toLowerCase().trim();
    if (!q_norm) return;
    const scope = document.querySelector('.subpage-view');
    if (!scope) return;
    const candidates = scope.querySelectorAll(
      '.setting-label, .setting-desc, .sub-label, .setting-row'
    );
    let hit = null;
    for (const el of candidates) {
      if ((el.textContent || '').toLowerCase().includes(q_norm)) { hit = el; break; }
    }
    if (!hit) return;
    // Climb to the enclosing .setting-row for the highlight anchor —
    // gives a nicer highlight box than lighting up just the label span.
    const row = hit.closest('.setting-row') || hit;
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    row.classList.add('deep-link-highlight');
    setTimeout(() => row.classList.remove('deep-link-highlight'), 2200);
  }

  // ── Env-lock one-shot fetch ────────────────────────────────────────────
  // The shell owns this fetch (was here before the extract); per-section
  // components read the envLocks store directly. Fire-and-forget — a
  // failed fetch just leaves the store at its default (all-false) shape,
  // and the sections behave as if nothing is env-locked.
  function _fetchOpts(extra = {}) {
    const h = { ...extra };
    if (isNative && getServerUrl()) {
      const t = getAuthToken();
      if (t) h['Authorization'] = `Bearer ${t}`;
    } else {
      const csrf = localStorage.getItem('nt:csrf');
      if (csrf) h['X-CSRF-Token'] = csrf;
    }
    return { credentials: 'include', headers: h };
  }

  onMount(() => {
    let mounted = true;
    (async () => {
      try {
        const res = await fetch(apiUrl('/api/app-config/env-locks'), _fetchOpts());
        if (res.ok && mounted) {
          const locks = await res.json();
          if (mounted) envLocksStore.set(locks);
        }
      } catch {}
    })();
    return () => { mounted = false; };
  });
</script>

<div class="page-shell">
  <!-- Header + search bar share one sticky container so the search row
       stays flush with the header in BOTH compact and banner-on modes.
       The brittle `top: calc(... + 62px + hamburger-row)` pattern bred
       a 2px gap when the compact header was shorter than the offset
       assumed. Pinning them together as one unit removes the whole
       class of header-height vs sub-bar-top mismatch bugs. -->
  <div class="settings-sticky-top">
    <header class="page-header" class:banner-gradient={$bannerStyle === 'gradient'} class:banner-animated={$bannerStyle === 'animated'}>
      {#if currentSection}
        <!-- Sub-page header: back arrow + current section title. Replaces
             the default title so the user always knows where they are and
             how to get out. Back always goes to /settings (never uses
             history.back so a bookmark or link-share into a sub-page
             behaves the same as an internal drill-in).

             Back button + title use fly + fade so drilling in / out
             animates instead of the arrow just popping into existence
             between the hamburger and the title. -->
        <!-- Back button "peels out" from the left edge of the section
             title: starts at width 0 hidden behind the title, expands
             to its full 40px while sliding left + fading in. Uses a
             CSS keyframe (runs on-mount) rather than a Svelte transition
             because svelte-spa-router treats /settings and
             /settings/:section as different routes and unmounts the
             whole component between them — Svelte transitions can't
             span that boundary. -->
        <button class="settings-back"
                class:back-peel-in={!_leaving}
                class:back-peel-out={_leaving}
                on:click={backToIndex}
                aria-label={$_('common.back')}>
          <span class="material-symbols-rounded">arrow_back</span>
        </button>
        <h1 class:title-slide-in={!_leaving}
            class:title-slide-out={_leaving}>
          {SECTION_META[currentSection]?.titleKey ? $_(SECTION_META[currentSection].titleKey) : currentSection}
        </h1>
      {:else}
        <h1>{$_('routes.settings.title')}</h1>
      {/if}
    </header>

    {#if !currentSection}
      <div class="settings-search-bar">
        <span class="material-symbols-rounded settings-search-icon">search</span>
        <input class="settings-search-input" type="search" placeholder={$_('settings_main_deep.search_ph')}
          bind:value={settingsSearch} />
        {#if settingsSearch}
          <button class="settings-search-clear btn-icon" on:click={() => settingsSearch = ''} title="Clear search">
            <span class="material-symbols-rounded" style="font-size:18px">close</span>
          </button>
        {/if}
      </div>
    {/if}
  </div>

  <div class="page-content settings-content" class:subpage-view={!!currentSection}>

    {#if currentSection}
      <!-- Sub-page: dispatch to the section component. Every extracted
           file owns its own inner layout (some wrap in .section-body,
           some render straight into a .card settings-card). -->
      <svelte:component this={SECTION_COMPONENTS[currentSection]} />
    {:else}
      <!-- Index: profile hero + section-toggle rows grouped by
           settings-group-label. Tapping a row navigates to its
           sub-page; the accordion pattern is retired. -->

      <!-- ── Profile hero — identity card at the top of Settings.
           Avatar + name (nickname → full name → "My Profile" fallback) +
           optional admin pill. Click → /profile. Hidden during search
           when no profile keyword matches so it doesn't dilute results. -->
      {#if sectionVisible(settingsQuery, 'profile')}
      {@const _u = $currentUser || {}}
      {@const _nick = (_u.nickname || '').trim()}
      {@const _full = (_u.full_name || '').trim()}
      {@const _displayName = _nick || (_full && _full !== 'Local User' ? _full : '') || $_('settings.profile_hero.label_fallback')}
      {@const _hasName = _displayName !== $_('settings.profile_hero.label_fallback')}
      {@const _initial = (_displayName[0] || '?').toUpperCase()}
      <button class="profile-hero" on:click={() => push('/profile')}>
        <div class="profile-hero-avatar">
          {#if _u.avatar_url}
            <img src={resolveAssetUrl(_u.avatar_url)} alt="" />
          {:else if _hasName}
            <span class="profile-hero-initial">{_initial}</span>
          {:else}
            <span class="material-symbols-rounded">person</span>
          {/if}
        </div>
        <div class="profile-hero-info">
          <span class="profile-hero-name">{_displayName}</span>
          {#if _hasName && _u.role === 'admin' && $userMgmtActive}
            <span class="profile-hero-role">{$_('common.admin')}</span>
          {:else if !_hasName}
            <span class="profile-hero-sub">{$_('settings.profile_hero.subtitle_empty')}</span>
          {/if}
        </div>
        <span class="material-symbols-rounded profile-hero-chev">chevron_right</span>
      </button>
      {/if}

      <p class="settings-group-label">{$_('settings_main.group_display')}</p>
      <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'appearance')} on:click={() => toggleSection('appearance')}>
        <span class="material-symbols-rounded si">contrast</span>
        <span>{$_('settings.appearance.section')}</span>
        <span class="material-symbols-rounded chevron">expand_more</span>
      </button>
      <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'regional')} on:click={() => toggleSection('regional')}>
        <span class="material-symbols-rounded si">language</span>
        <span>{$_('settings.regional.section')}</span>
        <span class="material-symbols-rounded chevron">expand_more</span>
      </button>
      <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'diary')} on:click={() => toggleSection('diary')}>
        <span class="material-symbols-rounded si">book</span>
        <span>{$_('settings.diary.section')}</span>
        <span class="material-symbols-rounded chevron">expand_more</span>
      </button>
      <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'water')} on:click={() => toggleSection('water')}>
        <span class="material-symbols-rounded si">water_drop</span>
        <span>{$_('settings.water.section')}</span>
        <span class="material-symbols-rounded chevron">expand_more</span>
      </button>
      <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'foods')} on:click={() => toggleSection('foods')}>
        <span class="material-symbols-rounded si">restaurant</span>
        <span>{$_('settings.foods.section')}</span>
        <span class="material-symbols-rounded chevron">expand_more</span>
      </button>

      <p class="settings-group-label">Data &amp; Tracking</p>
      <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'goals')} on:click={() => toggleSection('goals')}>
        <span class="material-symbols-rounded si">flag</span>
        <span>{$_('settings.goals.section')}</span>
        <span class="material-symbols-rounded chevron">expand_more</span>
      </button>
      <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'bodyStats')} on:click={() => toggleSection('bodyStats')}>
        <span class="material-symbols-rounded si">straighten</span>
        <span>{$_('settings.body_stats.section')}</span>
        <span class="material-symbols-rounded chevron">expand_more</span>
      </button>
      <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'statistics')} on:click={() => toggleSection('statistics')}>
        <span class="material-symbols-rounded si">bar_chart</span>
        <span>{$_('settings.statistics.section')}</span>
        <span class="material-symbols-rounded chevron">expand_more</span>
      </button>
      <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'nutrients')} on:click={() => toggleSection('nutrients')}>
        <span class="material-symbols-rounded si">science</span>
        <span>{$_('settings.nutrients.section')}</span>
        <span class="material-symbols-rounded chevron">expand_more</span>
      </button>
      <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'categories')} on:click={() => toggleSection('categories')}>
        <span class="material-symbols-rounded si">category</span>
        <span>{$_('settings.categories.section')}</span>
        <span class="material-symbols-rounded chevron">expand_more</span>
      </button>
      <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'muscles')} on:click={() => toggleSection('muscles')}>
        <span class="material-symbols-rounded si">fitness_center</span>
        <span>{$_('settings.muscles.section')}</span>
        <span class="material-symbols-rounded chevron">expand_more</span>
      </button>
      <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'people')} on:click={() => toggleSection('people')}>
        <span class="material-symbols-rounded si">group</span>
        <span>{$_('settings.people.section')}</span>
        <span class="material-symbols-rounded chevron">expand_more</span>
      </button>
      <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'customUnits')} on:click={() => toggleSection('customUnits')}>
        <span class="material-symbols-rounded si">straighten</span>
        <span>{$_('settings_stats.custom_units')}</span>
        <span class="material-symbols-rounded chevron">expand_more</span>
      </button>

      <p class="settings-group-label">{$_('settings_integrations.group')}</p>
      <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'connectedServices')} on:click={() => toggleSection('connectedServices')}>
        <span class="material-symbols-rounded si">link</span>
        <span>{$_('settings.connected_services.section')}</span>
        <span class="material-symbols-rounded chevron">expand_more</span>
      </button>
      <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'ai')} on:click={() => toggleSection('ai')}>
        <span class="material-symbols-rounded si">bolt</span>
        <span>{$_('settings.ai.section')}</span>
        <span class="material-symbols-rounded chevron">expand_more</span>
      </button>
      <button class="section-toggle wellness-toggle" class:hidden={!sectionVisible(settingsQuery, 'wellness')} on:click={() => toggleSection('wellness')}>
        <span class="material-symbols-rounded si">favorite</span>
        <span>{$_('settings.wellness.section')}</span>
        <span class="material-symbols-rounded chevron">expand_more</span>
      </button>

      <p class="settings-group-label">App</p>

      <!-- ── Server Connection (native only — manages connection to a remote
           NutriTrace server). PWA users have no "server connection" concept;
           their Log Out lives in My Profile. -->
      {#if isNative}
        <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'serverConnection')} on:click={() => toggleSection('serverConnection')}>
          <span class="material-symbols-rounded si">cloud_sync</span>
          <span>{$_('settings.server.section')}</span>
          <span class="material-symbols-rounded chevron">expand_more</span>
        </button>
      {/if}

      <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'notifications')} on:click={() => toggleSection('notifications')}>
        <span class="material-symbols-rounded si">notifications</span>
        <span>{$_('settings.notifications.section')}</span>
        <span class="material-symbols-rounded chevron">expand_more</span>
      </button>
      <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'backup')} on:click={() => toggleSection('backup')}>
        <span class="material-symbols-rounded si">backup</span>
        <span>{$_('settings.backup.section')}</span>
        <span class="material-symbols-rounded chevron">expand_more</span>
      </button>
      <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'importExport')} on:click={() => toggleSection('importExport')}>
        <span class="material-symbols-rounded si">import_export</span>
        <span>{$_('settings.importExport.section')}</span>
        <span class="material-symbols-rounded chevron">expand_more</span>
      </button>

      <!-- Sharing (per-user; hidden in native local mode — no one to share with) -->
      {#if $userMgmtActive && !isNativeLocal}
        <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'sharing')} on:click={() => toggleSection('sharing')}>
          <span class="material-symbols-rounded si">group</span>
          <span>{$_('settings.sharing.section')}</span>
          <span class="material-symbols-rounded chevron">expand_more</span>
        </button>
      {/if}

      <!-- Updates — in-app version check + APK install (Android) + admin server-update banner (PWA).
           Sits in the App section (not Admin) so non-admin members on
           multi-user instances can still reach their per-device update
           controls. Canonical position across TraceApps: right before
           Diagnostics. -->
      <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'updates')} on:click={() => toggleSection('updates')}>
        <span class="material-symbols-rounded si">system_update</span>
        <span>{$_('settings.updates.section')}</span>
        <span class="material-symbols-rounded chevron">expand_more</span>
      </button>
      <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'helpImprove')} on:click={() => toggleSection('helpImprove')}>
        <span class="material-symbols-rounded si">troubleshoot</span>
        <span>{$_('settings.diagnostics.section')}</span>
        <span class="material-symbols-rounded chevron">expand_more</span>
      </button>

      <!-- ── Admin group (server-side users / auth / SMTP — only meaningful
           when there's a real server with user management to administer).
           Shown when: not native standalone AND (single-user → Users
           on-ramp visible to the synthetic admin, or multi-user admin
           viewer). Hidden entirely for non-admin members on multi-user. -->
      {#if !isNativeLocal && (!$userMgmtActive || $currentUser?.role === 'admin')}
        <p class="settings-group-label">{$_('settings_admin_group')}</p>

        <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'users')} on:click={() => toggleSection('users')}>
          <span class="material-symbols-rounded si">group</span>
          <span>{$_('settings.users.section')}</span>
          <span class="material-symbols-rounded chevron">expand_more</span>
        </button>

        {#if $userMgmtActive && $currentUser?.role === 'admin'}
          <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'authentication')} on:click={() => toggleSection('authentication')}>
            <span class="material-symbols-rounded si">vpn_key</span>
            <span>{$_('settings.authentication.section')}</span>
            <span class="material-symbols-rounded chevron">expand_more</span>
          </button>
        {/if}

        {#if $currentUser?.role === 'admin'}
          <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'email')} on:click={() => toggleSection('email')}>
            <span class="material-symbols-rounded si">mail</span>
            <span>{$_('settings.email.section')}</span>
            <span class="material-symbols-rounded chevron">expand_more</span>
          </button>
        {/if}

        <!-- API Tokens — no env var gate anymore (was NT_FEATURES_API=1,
             removed in rc.42). Visible in both multi-user mode (real admin
             user) and single-user mode (the synthetic local user is admin
             by definition). -->
        {#if $currentUser?.role === 'admin'}
          <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'apiTokens')} on:click={() => toggleSection('apiTokens')}>
            <span class="material-symbols-rounded si">key</span>
            <span>API Tokens</span>
            <span class="material-symbols-rounded chevron">expand_more</span>
          </button>
        {/if}
      {/if}

      <!-- About — standalone footer item, no group label. Always last. -->
      <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'about')} on:click={() => toggleSection('about')}>
        <span class="material-symbols-rounded si">info</span>
        <span>{$_('settings.about.section')}</span>
        <span class="material-symbols-rounded chevron">expand_more</span>
      </button>

      <div style="height:24px"></div>
    {/if}
  </div>

</div>

<style>
  .settings-content { display: flex; flex-direction: column; gap: 0; }
  /* Settings-only override: reduce horizontal page padding on phone
     widths so cards get ~10-12px more breathing room per side without
     touching card internals. Rows, labels, drag-lists, and controls
     all benefit uniformly. Desktop/tablet widths (>= 768px) keep the
     default page padding — plenty of room already. */
  @media (max-width: 767px) {
    .settings-content { padding-left: 8px; padding-right: 8px; }
  }
  .hidden { display: none !important; }

  /* Sub-page view: hide the index-only chrome (section-toggle rows,
     group labels, profile hero) so only the current section's body
     renders under the back-arrow header. In router-shell mode these
     never render at all — only the dispatched section component does
     — but the :global guard is kept as a safety net for any extracted
     child that happens to render a .section-toggle etc. of its own. */
  .subpage-view :global(.section-toggle) { display: none; }
  .subpage-view :global(.settings-group-label) { display: none; }
  .subpage-view :global(.profile-hero) { display: none; }
  /* Kill the slide transition on land — the body is already visible
     the moment the sub-page mounts, an entry animation would just be
     a 180ms delay before the user can interact. */
  .subpage-view :global(.section-body) { animation: none !important; }

  /* Back arrow — icon-only button, sits before the section title in
     the sub-page header. */
  .settings-back {
    display: inline-flex; align-items: center; justify-content: center;
    width: 40px; height: 40px;
    margin-right: 8px;
    border: none; background: transparent; cursor: pointer;
    color: var(--text-1);
    border-radius: 50%;
    transition: background-color 120ms ease;
  }
  .settings-back:hover  { background: var(--surface-2); }
  .settings-back:active { background: var(--surface-3); }
  .settings-back .material-symbols-rounded { font-size: 24px; }

  /* Back button peel-in — the button appears to unfold from the left
     edge of the section title. Width interpolates from 0 to 40px so
     the title text slides right to make room, giving the visual of
     the arrow emerging from behind the title. Delayed slightly (80ms)
     so the title appears first, then the arrow reveals. Scale + opacity
     add polish. Overflow:hidden clips the icon during the width
     transition so it doesn't spill out prematurely. */
  .back-peel-in {
    overflow: hidden;
    transform-origin: left center;
    animation: back-peel 320ms cubic-bezier(0.34, 1.4, 0.64, 1) 80ms both;
  }
  @keyframes back-peel {
    from { width: 0;    margin-right: 0;  opacity: 0; transform: scale(0.4); }
    to   { width: 40px; margin-right: 8px; opacity: 1; transform: scale(1);   }
  }
  /* Reverse of back-peel: on tap, the arrow retreats back into the
     title (width collapses to 0, opacity fades, scales down). Faster
     than the entry (240ms vs 320ms) and easing-in so the motion feels
     decisive — you tapped, it's leaving. The backToIndex handler waits
     this duration before navigating so the animation completes. */
  .back-peel-out {
    overflow: hidden;
    transform-origin: left center;
    animation: back-peel-reverse 240ms cubic-bezier(0.4, 0, 0.6, 1) both;
  }
  @keyframes back-peel-reverse {
    from { width: 40px; margin-right: 8px; opacity: 1; transform: scale(1);   }
    to   { width: 0;    margin-right: 0;  opacity: 0; transform: scale(0.4); }
  }
  /* Title slides right slightly to make room for the appearing back
     button, so the two motions feel connected. Same delay so they
     happen together. */
  .title-slide-in {
    animation: title-slide 320ms cubic-bezier(0.34, 1.4, 0.64, 1) 80ms both;
  }
  @keyframes title-slide {
    from { opacity: 0; transform: translateX(-16px); }
    to   { opacity: 1; transform: translateX(0);      }
  }
  /* Reverse: on back tap, title slides back left as the arrow
     collapses. Same 240ms as .back-peel-out so both finish together. */
  .title-slide-out {
    animation: title-slide-back 240ms cubic-bezier(0.4, 0, 0.6, 1) both;
  }
  @keyframes title-slide-back {
    from { opacity: 1; transform: translateX(0);      }
    to   { opacity: 0; transform: translateX(-16px); }
  }

  /* Deep-link highlight — glows the target .setting-row for ~2s after
     a search-driven drill-in scrolls to it. Uses box-shadow (not
     border/outline) so it never nudges layout mid-scroll. Pulse
     ramps fast, decays gently — enough to catch the eye without
     turning into visual noise if the user is already reading. */
  :global(.setting-row.deep-link-highlight) {
    animation: deep-link-pulse 2s cubic-bezier(.2, .8, .2, 1) both;
    border-radius: 8px;
  }
  @keyframes deep-link-pulse {
    0%   { box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 0%,  transparent); background-color: transparent; }
    12%  { box-shadow: 0 0 0 6px color-mix(in srgb, var(--accent) 45%, transparent); background-color: color-mix(in srgb, var(--accent) 14%, transparent); }
    100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 0%,  transparent); background-color: transparent; }
  }

  /* Settings header + search bar pinned together. Single sticky-top wrapper
     is more reliable than two separate sticky elements with computed offsets.
     The nested .page-header switches to static so it doesn't double-stick
     inside this container. */
  .settings-sticky-top {
    position: sticky;
    top: 0;
    z-index: 20;
    background: var(--bg);
  }
  .settings-sticky-top :global(.page-header) {
    position: static;
  }
  .settings-search-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px var(--page-px, 16px) 12px;
    background: var(--glass-surface);
    backdrop-filter: blur(20px) saturate(180%);
    -webkit-backdrop-filter: blur(20px) saturate(180%);
    border-bottom: 1px solid var(--border);
  }
  .settings-search-icon { font-size: 20px; color: var(--text-3); flex-shrink: 0; }
  .settings-search-input {
    flex: 1;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-full);
    padding: 7px 14px;
    font-size: 15px;
    color: var(--text-1);
    outline: none;
  }
  .settings-search-input:focus { border-color: var(--accent); }
  .settings-search-clear { color: var(--text-3); }

  /* Profile hero — identity card at the top of Settings */
  .profile-hero {
    display: flex; align-items: center; gap: 14px;
    width: 100%;
    margin: 4px var(--page-px) 14px;
    padding: 14px 16px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg, 14px);
    color: var(--text-1);
    cursor: pointer;
    font-family: inherit; text-align: left;
    transition: background var(--dur-fast), transform var(--dur-fast);
    width: calc(100% - var(--page-px) * 2);
  }
  .profile-hero:hover  { background: var(--surface-3); }
  .profile-hero:active { transform: scale(0.99); }
  .profile-hero-avatar {
    width: 48px; height: 48px; border-radius: 50%;
    background: linear-gradient(135deg, var(--accent), var(--accent-2, var(--accent)));
    color: #fff;
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0; overflow: hidden;
  }
  .profile-hero-avatar img { width: 100%; height: 100%; object-fit: cover; }
  .profile-hero-avatar :global(.material-symbols-rounded) { font-size: 26px; }
  .profile-hero-initial { font-size: 20px; font-weight: 700; line-height: 1; }
  .profile-hero-info { flex: 1; display: flex; flex-direction: column; gap: 4px; min-width: 0; }
  .profile-hero-name {
    font-size: 17px; font-weight: 700; color: var(--text-1);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .profile-hero-role {
    align-self: flex-start;
    font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em;
    color: var(--accent); background: var(--accent-dim);
    padding: 2px 8px; border-radius: var(--radius-full, 999px);
  }
  .profile-hero-sub { font-size: 13px; color: var(--text-3); }
  .profile-hero-chev { color: var(--text-3); flex-shrink: 0; }

  /* Section toggle button */
  .section-toggle {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    padding: 14px var(--page-px);
    background: none;
    border: none;
    border-bottom: 1px solid var(--border);
    color: var(--text-1);
    font-size: 15px;
    font-weight: 600;
    cursor: pointer;
    text-align: left;
    transition: background var(--dur-fast);
  }
  .section-toggle:hover  { background: var(--surface-2); }
  .section-toggle:active { background: var(--surface-3); }
  .si {
    font-size: 18px;
    color: var(--accent);
    flex-shrink: 0;
    width: 30px; height: 30px;
    background: var(--accent-dim);
    border-radius: 8px;
    display: flex; align-items: center; justify-content: center;
  }
  .settings-group-label {
    padding: 20px var(--page-px) 4px;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-3);
  }

  /* Chevron: was a down-arrow that rotated 180deg to signal accordion-
     open state. Drill-in has no expanded state on the index — every
     section row navigates to its own sub-page — so the chevron now
     points right permanently (rotate -90deg turns the down-arrow into
     a right-arrow, the universal "drill in" signal). */
  .chevron { font-size: 20px; color: var(--text-3); margin-left: auto; transform: rotate(-90deg); }

  /* Shared section-body wrapper — extracted sections still use this
     class for their outer padding + gap layout, so styling stays
     here and reaches them via :global (Svelte scopes classes only
     when they're referenced in this component's markup; the class
     is referenced above under .subpage-view :global(.section-body),
     which is why the plain-selector rule below also has to be
     :global-scoped). */
  :global(.section-body) { padding: 12px var(--page-px); display: flex; flex-direction: column; gap: 10px; }

  /* ── Shared card + row primitives ────────────────────────────────────
     Every extracted section renders into a `.card.settings-card`
     containing `.setting-row`s. Style lives here so all descendants
     inherit via :global — extracting them into a separate stylesheet
     would double the class-count and complicate the scoping rules. */
  :global(.settings-card) {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  :global(.setting-row) {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 13px 16px;
    min-height: 50px;
  }
  /* Layout guard for the common .setting-row pattern. The text-block
     (a <div> or a bare <span class="setting-label">) grows and is allowed
     to shrink (min-width:0) so long labels wrap/truncate instead of
     bleeding into icons or controls beside it. Icons (.material-symbols-
     rounded) and right-side controls stay pinned via flex-shrink:0. The
     text-block can be in any position (some rows have leading icon + text
     + chevron; others have just text + Toggle), so we target it by tag/
     class instead of :first-child. :global() so sub-components inherit. */
  :global(.setting-row > *) { flex-shrink: 0; }
  :global(.setting-row > div), :global(.setting-row > span.setting-label) {
    flex: 1 1 0; min-width: 0;
  }
  /* Control-side wrappers (dropdowns, colour swatches, action buttons)
     must NOT grow — the rule above catches every direct <div>, which
     was expanding .select-wrap and floating dropdown pills in the
     middle of the row. Explicit opt-out keeps them at their intrinsic
     width so justify-content:space-between pins them to the right. */
  :global(.setting-row > .select-wrap),
  :global(.setting-row > .seg-group),
  :global(.setting-row > .env-lock-pill) {
    flex: 0 0 auto;
  }
  /* Reset for column-direction setting-rows. Children of a column-flex
     .setting-row should take their natural content height — the rule
     above gives them flex-basis:0 which collapses them down to the parent's
     min-height (50px) on the main axis (height) and lets their content
     overflow visibly. That overflow paints in the same space as the next
     sibling, visually overlapping it (nomad64 #33 — Cancel/Import row
     overlapping the dupe-option radios in Nutrition Import). Higher
     specificity than the rule above so it wins without !important. */
  :global(.setting-row[style*="flex-direction:column"] > div),
  :global(.setting-row[style*="flex-direction: column"] > div),
  :global(.setting-row[style*="flex-direction:column"] > span.setting-label),
  :global(.setting-row[style*="flex-direction: column"] > span.setting-label) {
    flex: 0 0 auto;
    min-width: auto;
  }
  :global(.setting-label), :global(.setting-desc) { word-break: break-word; overflow-wrap: anywhere; }

  /* Drag lists — four extracted sections (meal names, nutrients,
     body stats, statistics metrics) render draggable rows using
     this shared skeleton. Kept here so the layout is consistent
     without each section duplicating the CSS. */
  :global(.drag-list) { overflow: visible; }
  :global(.drag-row) {
    position: relative;
    will-change: transform;
    transition: transform 220ms cubic-bezier(0.34, 1.56, 0.64, 1), box-shadow 220ms ease, opacity 220ms ease;
  }
  :global(.drag-row.drag-target) {
    background: var(--accent-dim);
    border-radius: var(--radius-sm);
    transition: background 120ms ease;
  }
  :global(.drag-row.dragging) {
    opacity: 0.90;
    z-index: 20;
    border-radius: var(--radius-lg);
    background: var(--surface-2);
    box-shadow:
      0 28px 72px rgba(0,0,0,0.50),
      0 8px 24px rgba(0,0,0,0.30),
      0 0 0 1px rgba(255,255,255,0.08);
    backdrop-filter: blur(4px);
  }
  :global(.drag-handle) {
    font-size: 20px;
    color: var(--text-3);
    cursor: grab;
    flex-shrink: 0;
    user-select: none;
    touch-action: none;
    transition: color var(--dur-fast);
  }
  :global(.drag-handle:hover)  { color: var(--accent); }
  :global(.drag-handle:active) { cursor: grabbing; color: var(--accent); }

  :global(.setting-label) { font-size: 14px; font-weight: 500; flex: 1; }
  :global(.setting-desc)  { font-size: 12px; color: var(--text-3); margin-top: 2px; font-weight: 400; }
  :global(.setting-divider) { height: 1px; background: var(--border); margin: 0 16px; }

  :global(.sub-label) {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-3);
    padding: 4px 2px 2px;
  }
  /* Fill the .select-wrap so the CSS chevron (positioned 14px from the
     wrap's right edge) sits inside the visible pill instead of floating
     off to one side. Every .setting-row wrap has an explicit width
     (150px etc.) and .select-wrap opts out of flex-grow, so this
     doesn't blow the dropdown out to fill the whole row anymore. */
  :global(.sel-sm) { height: 36px; font-size: 13px; width: 100%; max-width: 100%; }

  :global(.form-group) { display: flex; flex-direction: column; gap: 6px; }
  :global(.form-label) { font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-3); }

  /* Chips — used by Categories, CustomUnits, and Sharing extracted
     sections. Two rules for `.chip` were present in the previous
     monolith (a plain surface-2 version and an outlined transparent
     version); the outlined variant wins as it was defined last and
     is the one every extracted section uses. */
  :global(.cat-chips-wrap) {
    display: flex; flex-wrap: wrap; gap: 8px;
    padding: 14px 16px 8px;
  }
  :global(.chip) {
    padding: 4px 12px;
    border-radius: 99px;
    border: 1.5px solid var(--border);
    background: transparent;
    color: var(--text-2);
    font-size: 13px;
    cursor: pointer;
    display: inline-flex; align-items: center; gap: 4px;
    transition: border-color 0.15s, background 0.15s, color 0.15s;
  }
  :global(.chip:hover) { border-color: var(--accent); color: var(--text-1); }
  :global(.chip-active) {
    border-color: var(--accent);
    background: var(--accent-dim);
    color: var(--accent);
    font-weight: 600;
  }
  :global(.chip-x) { background: none; border: none; cursor: pointer; display: flex; align-items: center; color: var(--text-3); padding: 0; }
  :global(.chip-x:hover) { color: var(--danger); }
  :global(.cat-add-row) { display: flex; gap: 8px; padding: 8px 16px 14px; }
  :global(.emoji-btn) {
    width: 54px; height: 40px; font-size: 20px; padding: 0;
    text-align: center; cursor: pointer; line-height: 1;
  }

  /* Env-lock banner — shown by SettingsTrace / SettingsEmail children
     when the corresponding admin panel is env-var pinned. Kept in the
     shell so descendant styling crosses the component boundary. */
  :global(.env-lock-banner) {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 14px;
    background: color-mix(in srgb, var(--accent) 10%, transparent);
    border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
    border-radius: var(--radius-md);
    font-size: 12px;
    color: var(--text-2);
    margin-bottom: 4px;
  }
  :global(.env-lock-banner .material-symbols-rounded) { font-size: 16px; color: var(--accent); flex-shrink: 0; }

  /* Segmented control — shared across Goals, Diary, Statistics
     extracted sections. Sliding pill is driven by --seg-active + --seg-count
     CSS custom properties the section sets inline. */
  :global(.seg-control) {
    position: relative;
    display: flex;
    background: var(--surface-2);
    border-radius: var(--radius-full);
    padding: 3px;
    gap: 2px;
  }
  /* Multi-select seg controls suppress the sliding pill — caller adds the
     `multi` class. Each .seg-active button shades its own background instead. */
  :global(.seg-control.multi::before) { display: none; }
  :global(.seg-control.multi .seg-opt.seg-active) {
    background: var(--surface-1);
    box-shadow: 0 1px 3px rgba(0,0,0,0.15);
  }
  :global(.seg-control::before) {
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
  :global(.seg-opt) {
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
  :global(.seg-opt.seg-active) {
    color: var(--text-1);
  }
  /* #147: differentiate disabled from just-inactive. Without this, a
     button gated by a feature (e.g. Calorie Goal Mode > Dynamic when no
     wearable is connected) looks identical to a not-currently-selected
     option, so users tap it expecting it to work. */
  :global(.seg-opt:disabled) {
    opacity: 0.4;
    cursor: not-allowed;
  }

  /* Spin — used by any child component that renders a rotating icon
     (sync buttons, in-flight test buttons, etc.). */
  @keyframes spin { to { transform: rotate(360deg); } }
  :global(.spin) { animation: spin 1s linear infinite; display: inline-block; }

  /* Legacy: labs badge is no longer used anywhere in the settings tree
     but the class name may still appear in translation strings; kept as
     a defensive style. */
  :global(.labs-badge) {
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
