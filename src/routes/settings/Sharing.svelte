<script>
  import { onMount } from 'svelte';
  import { _ } from 'svelte-i18n';
  import Toggle from '../../components/settings/Toggle.svelte';
  import { NtApi } from '../../lib/api.js';
  import { isNative, getServerUrl, apiUrl, getAuthToken } from '../../lib/platform.js';
  import { showSuccess, showError } from '../../stores/toast.js';
  import { currentUser, userMgmtActive } from '../../stores/auth.js';

  // Native-standalone = Capacitor on-device with no linked server (nothing to
  // share with). Same rule the parent shell derives.
  $: isNativeLocal = isNative && !getServerUrl();

  // Same shape as parent's _fetchOpts helper — CSRF for PWA / Bearer for native.
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

  let adminSharingEnabled = false;

  async function loadSharingConfig() {
    try {
      const cfg = await NtApi.getSharingStatus().catch(() => ({}));
      adminSharingEnabled = cfg.sharing_enabled === true;
      // Pre-fill the bulk form from the last-applied per-category state so
      // users don't see 'Private' on every revisit when they actually saved
      // something different.
      if (cfg.bulk) {
        bulkVisFoods    = cfg.bulk.foods?.visibility    || 'private';
        bulkVisMeals    = cfg.bulk.meals?.visibility    || 'private';
        bulkVisRecipes  = cfg.bulk.recipes?.visibility  || 'private';
        bulkUsersFoods   = Array.isArray(cfg.bulk.foods?.user_ids)    ? cfg.bulk.foods.user_ids    : [];
        bulkUsersMeals   = Array.isArray(cfg.bulk.meals?.user_ids)    ? cfg.bulk.meals.user_ids    : [];
        bulkUsersRecipes = Array.isArray(cfg.bulk.recipes?.user_ids)  ? cfg.bulk.recipes.user_ids  : [];
      } else {
        console.warn('[bulk-share] server returned no `bulk` field on /api/app-config/sharing — server probably needs to redeploy');
      }
    } catch (e) {
      console.warn('[bulk-share] loadSharingConfig failed', e);
    }
  }

  async function _saveBulkState() {
    // Persist last-applied state via app-config so the form pre-fills correctly
    // next time (and across devices, since it's server-stored). Routes through
    // _fetchOpts() so CSRF (PWA) / Bearer (native) headers are attached —
    // otherwise PUT /api/app-config silently 403s and the state never persists.
    const _put = async (key, value) => {
      const res = await fetch(apiUrl('/api/app-config'), {
        method: 'PUT',
        ..._fetchOpts({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ key, value }),
      }).catch(() => null);
      if (!res || !res.ok) console.warn('[bulk-share] failed to persist', key, res?.status);
    };
    await Promise.all([
      _put('bulk_vis_foods',   bulkVisFoods),
      _put('bulk_vis_meals',   bulkVisMeals),
      _put('bulk_vis_recipes', bulkVisRecipes),
      _put('bulk_users_foods',   JSON.stringify(bulkVisFoods   === 'specific' ? bulkUsersFoods   : [])),
      _put('bulk_users_meals',   JSON.stringify(bulkVisMeals   === 'specific' ? bulkUsersMeals   : [])),
      _put('bulk_users_recipes', JSON.stringify(bulkVisRecipes === 'specific' ? bulkUsersRecipes : [])),
    ]);
  }

  async function saveAdminSharingEnabled(val) {
    adminSharingEnabled = val;
    await fetch(apiUrl('/api/app-config'), {
      method: 'PUT',
      ..._fetchOpts({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ key: 'sharing_enabled', value: val ? 'true' : 'false' }),
    }).catch(() => {});
  }

  // Per-category bulk-share state. Each category has its own visibility +
  // (when 'specific') its own list of selected user ids. Three explicit rows
  // beat one ambiguous multi-select.
  let bulkVisFoods = 'private';
  let bulkVisMeals = 'private';
  let bulkVisRecipes = 'private';
  let bulkUsersFoods = [];
  let bulkUsersMeals = [];
  let bulkUsersRecipes = [];
  let bulkApplying = false;
  let bulkUsers = [];
  let bulkUsersLoaded = false;

  async function loadBulkUsers() {
    if (bulkUsersLoaded) return;
    try { bulkUsers = await NtApi.getUsersList(); bulkUsersLoaded = true; } catch {}
  }

  function toggleBulkUserFor(category, id) {
    const list = category === 'foods' ? bulkUsersFoods : category === 'meals' ? bulkUsersMeals : bulkUsersRecipes;
    const next = list.includes(id) ? list.filter(u => u !== id) : [...list, id];
    if (category === 'foods')   bulkUsersFoods   = next;
    if (category === 'meals')   bulkUsersMeals   = next;
    if (category === 'recipes') bulkUsersRecipes = next;
  }

  // Trigger user-list load when any category flips to 'specific'.
  $: if (bulkVisFoods === 'specific' || bulkVisMeals === 'specific' || bulkVisRecipes === 'specific') loadBulkUsers();

  async function applyBulkShareCategory(category, visibility, user_ids) {
    return NtApi.post('/api/foods/bulk-share', {
      visibility,
      targets: [category],
      user_ids: visibility === 'specific' ? user_ids : [],
    });
  }

  async function applyBulkShare() {
    bulkApplying = true;
    try {
      // Apply each category independently so unticked categories aren't touched
      // and each gets its own visibility.
      await Promise.all([
        applyBulkShareCategory('foods',   bulkVisFoods,   bulkUsersFoods),
        applyBulkShareCategory('meals',   bulkVisMeals,   bulkUsersMeals),
        applyBulkShareCategory('recipes', bulkVisRecipes, bulkUsersRecipes),
      ]);
      // Persist for next time — the form should remember its last state.
      await _saveBulkState();
      showSuccess('Sharing updated');
    } catch(e) { showError('Could not apply: ' + e.message); }
    bulkApplying = false;
  }

  // Replaces the parent's `$: if (openSections.sharing) loadSharingConfig()`.
  // Drill-in means the sub-page mount IS the open event.
  onMount(() => { loadSharingConfig(); });
</script>

{#if $userMgmtActive && !isNativeLocal}
  <div class="section-body">
    {#if $currentUser?.role === 'admin'}
      <!-- Group: Admin -->
      <p class="settings-group-heading">{$_('settings_integrations.admin_section')}</p>
      <p class="settings-group-sub">Server-wide sharing switch. When off, group members can't share items with each other.</p>
      <div class="card settings-card">
        <div class="setting-row">
          <div>
            <span class="setting-label">{$_('settings_integrations.enable_sharing')}</span>
            <span class="setting-desc">Allow group members to share foods, meals, and recipes with each other</span>
          </div>
          <Toggle checked={adminSharingEnabled} on:change={e => saveAdminSharingEnabled(e.detail)} />
        </div>
      </div>
    {/if}
    {#if adminSharingEnabled}
    <!-- Group: Bulk Share -->
    <p class="settings-group-heading">{$_('settings_integrations.bulk_share')}</p>
    <p class="settings-group-sub">Set who can see your existing items. Each category has its own visibility, so changing one doesn't affect the others.</p>
    <div class="card settings-card" style="gap:0">
      {#each [
        { key: 'foods',   label: 'Foods'   },
        { key: 'meals',   label: 'Meals'   },
        { key: 'recipes', label: 'Recipes' },
      ] as cat, ci}
        {#if ci > 0}<div class="setting-divider"></div>{/if}
        {@const _vis    = cat.key === 'foods' ? bulkVisFoods   : cat.key === 'meals' ? bulkVisMeals   : bulkVisRecipes}
        {@const _users  = cat.key === 'foods' ? bulkUsersFoods : cat.key === 'meals' ? bulkUsersMeals : bulkUsersRecipes}
        <div class="setting-row">
          <span class="setting-label">{cat.label}</span>
          <div class="select-wrap" style="width:160px">
            <select class="select sel-sm"
              on:change={e => {
                const v = e.target.value;
                if (cat.key === 'foods')   bulkVisFoods   = v;
                if (cat.key === 'meals')   bulkVisMeals   = v;
                if (cat.key === 'recipes') bulkVisRecipes = v;
              }}
              value={_vis}>
              <option value="private">{$_('settings_integrations.vis_private')}</option>
              <option value="group">{$_('settings_integrations.vis_group')}</option>
              <option value="specific">{$_('settings_integrations.vis_specific')}</option>
            </select>
          </div>
        </div>
        {#if _vis === 'specific'}
          <div style="padding:0 16px 12px">
            <div class="setting-desc" style="margin-bottom:8px">Members who can see your {cat.label.toLowerCase()}:</div>
            <div style="display:flex;flex-wrap:wrap;gap:8px">
              {#each bulkUsers as u}
                <button class="chip" class:chip-active={_users.includes(u.id)}
                  on:click={() => toggleBulkUserFor(cat.key, u.id)}>
                  {#if _users.includes(u.id)}<span class="material-symbols-rounded" style="font-size:14px">check</span>{/if}
                  {u.name}
                </button>
              {/each}
              {#if !bulkUsersLoaded}<span class="setting-desc">Loading…</span>{/if}
            </div>
          </div>
        {/if}
      {/each}
      <div style="padding:8px 16px 12px">
        <button class="btn btn-secondary w-full" on:click={applyBulkShare} disabled={bulkApplying}>
          {bulkApplying ? 'Applying…' : 'Apply to Existing Items'}
        </button>
      </div>
    </div>
    {/if}
  </div>
{/if}
