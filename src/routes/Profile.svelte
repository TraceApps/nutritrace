<script>
  import { onMount } from 'svelte';
  import { pop } from 'svelte-spa-router';
  import { _ } from 'svelte-i18n';
  import { currentUser } from '../stores/auth.js';
  import { NtApi } from '../lib/api.js';
  import { apiUrl, isNative, getServerUrl, getAuthToken, resolveAssetUrl } from '../lib/platform.js';
  import { takePhoto } from '../lib/camera.js';
  import { localDateStr } from '../lib/db.js';
  import DateInput from '../components/ui/DateInput.svelte';

  function _headers(extra = {}) {
    const h = { 'Content-Type': 'application/json', ...extra };
    if (isNative && getServerUrl()) {
      const t = getAuthToken();
      if (t) h['Authorization'] = `Bearer ${t}`;
    }
    return h;
  }
  import { showSuccess, showError } from '../stores/toast.js';
  import { validatePassword, passwordStrength } from '../lib/validation.js';
  import { confirmDialog } from '../stores/confirmDialog.js';
  import { loadAuthState } from '../stores/auth.js';

  let deletingAccount = false;
  async function deleteMyAccount() {
    if (!await confirmDialog({
      title: $_('profile.delete_account_title'),
      message: $_('profile.delete_account_message'),
      confirmText: $_('profile.delete_account_confirm'),
      dangerous: true,
    })) return;
    deletingAccount = true;
    try {
      const res = await fetch(apiUrl('/api/auth/me'), { method: 'DELETE', credentials: 'include', headers: _headers() });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { showError(data?.error || $_('profile.errors.delete_account_failed')); deletingAccount = false; return; }
      localStorage.removeItem('wl:userId');
      await loadAuthState();
      showSuccess($_('profile.account_deleted'));
      pop();
    } catch (e) {
      showError($_('common.errors.cant_reach_server'));
      deletingAccount = false;
    }
  }

  $: pwScore = passwordStrength(new_password);

  const GENDERS = ['Male', 'Female', 'Non-binary', 'Prefer not to say'];

  let full_name  = '';
  let nickname   = '';
  let birthday   = '';
  let gender     = '';
  let avatar_url = '';
  let email      = '';
  let saving     = false;
  let fileInput;
  let uploading  = false;

  onMount(() => {
    const u = $currentUser;
    if (!u) { pop(); return; }
    full_name  = u.full_name  || '';
    nickname   = u.nickname   || '';
    birthday   = u.birthday   || '';
    gender     = u.gender     || '';
    avatar_url = u.avatar_url || '';
    email      = u.email      || '';
    loadOidc();
  });

  async function save() {
    saving = true;
    try {
      const res = await fetch(apiUrl('/api/auth/profile'), {
        method: 'PUT',
        credentials: 'include',
        headers: _headers(),
        body: JSON.stringify({ full_name, nickname, birthday, gender, avatar_url, email }),
      });
      const data = await res.json();
      if (!res.ok) { showError(data.error || $_('profile.errors.save_failed')); return; }
      currentUser.set(data.user);
      showSuccess($_('profile.saved'));
    } catch(e) {
      showError($_('profile.errors.save_failed'));
    } finally {
      saving = false;
    }
  }

  async function pickAvatar() {
    if (isNative) {
      try {
        const file = await takePhoto();
        if (!file) return;
        uploading = true;
        const url = await NtApi.uploadImage(file);
        avatar_url = url;
      } catch { showError($_('profile.errors.upload_failed')); }
      finally { uploading = false; }
      return;
    }
    fileInput?.click();
  }

  async function onFileChange(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    uploading = true;
    try {
      const url = await NtApi.uploadImage(file);
      avatar_url = url;
    } catch(e) {
      showError($_('profile.errors.upload_failed'));
    } finally {
      uploading = false;
    }
  }

  let changingPassword = false;
  let cur_password = '';
  let new_password = '';
  let new_password2 = '';
  let pwSaving = false;

  // OIDC: provider list + linked accounts for the current user
  let oidcProviders = [];
  let linkedProviders = [];
  let unlinking = null;
  async function loadOidc() {
    try {
      const r = await fetch(apiUrl('/api/auth/status'), { credentials: 'include', headers: _headers() });
      if (r.ok) {
        const data = await r.json();
        oidcProviders = (data?.oidc?.providers) || [];
      }
    } catch {}
    try {
      const r2 = await fetch(apiUrl('/api/auth/oidc/links'), { credentials: 'include', headers: _headers() });
      if (r2.ok) {
        const data = await r2.json();
        linkedProviders = data?.links || [];
      }
    } catch {}
  }
  function startLink(providerId) {
    const ret = encodeURIComponent('#/profile');
    window.location.href = apiUrl(`/api/auth/oidc/login/${providerId}?link=1&return=${ret}`);
  }
  async function unlink(linkId) {
    if (!confirm('Unlink this provider? You won\'t be able to sign in with it again until you re-link.')) return;
    unlinking = linkId;
    try {
      const csrf = localStorage.getItem('nt:csrf');
      const r = await fetch(apiUrl(`/api/auth/oidc/unlink/${linkId}`), {
        method: 'POST',
        credentials: 'include',
        headers: _headers(csrf ? { 'X-CSRF-Token': csrf } : {}),
      });
      const data = await r.json();
      if (!r.ok) { showError(data?.error || $_('common.errors.unlink_failed')); return; }
      linkedProviders = data.links || [];
      showSuccess($_('common.unlinked'));
    } catch (e) {
      showError($_('common.errors.cant_reach_server'));
    } finally { unlinking = null; }
  }
  $: linkedProviderIds = new Set(linkedProviders.map(l => l.oidc_provider_id));
  $: availableToLink = oidcProviders.filter(p => !linkedProviderIds.has(p.id));
  $: hasPassword = !!$currentUser?.has_password;
  $: canChangePassword = hasPassword;
  $: canSetPassword = !hasPassword;

  async function changePassword() {
    if (new_password !== new_password2) { showError($_('reset_password.errors.mismatch')); return; }
    const pwErr = validatePassword(new_password);
    if (pwErr) { showError(pwErr); return; }
    pwSaving = true;
    try {
      const body = hasPassword
        ? { current_password: cur_password, new_password }
        : { new_password };  // OIDC-only user setting their first password
      const res = await fetch(apiUrl('/api/auth/password'), {
        method: 'PUT',
        credentials: 'include',
        headers: _headers(),
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) { showError(data.error || $_('common.errors.failed')); return; }
      showSuccess($_('profile.password_changed'));
      changingPassword = false;
      cur_password = new_password = new_password2 = '';
    } catch(e) {
      showError($_('profile.errors.password_change_failed'));
    } finally {
      pwSaving = false;
    }
  }
</script>

<div class="page-wrap">
  <div class="page-header sticky-header">
    <button class="btn-icon" on:click={pop} title={$_('common.back')}>
      <span class="material-symbols-rounded">arrow_back</span>
    </button>
    <h2 class="page-title">{$_('profile.title')}</h2>
    <button class="btn btn-primary" on:click={save} disabled={saving}>
      {saving ? $_('common.saving') : $_('common.save')}
    </button>
  </div>

  <div class="profile-body">
    <!-- Avatar -->
    <div class="avatar-section">
      <button class="avatar-btn" on:click={pickAvatar} disabled={uploading} title={$_('profile.change_photo')}>
        {#if avatar_url}
          <img class="avatar-img" src={resolveAssetUrl(avatar_url)} alt="avatar" />
        {:else}
          <span class="material-symbols-rounded avatar-placeholder">person</span>
        {/if}
        <div class="avatar-overlay">
          <span class="material-symbols-rounded" style="font-size:20px">{uploading ? 'hourglass_empty' : 'photo_camera'}</span>
        </div>
      </button>
      <input bind:this={fileInput} type="file" accept="image/*" style="display:none" on:change={onFileChange} />
      <div class="avatar-meta">
        <span class="text-1" style="font-weight:600">{$currentUser?.nickname || $currentUser?.username || ''}</span>
        <span class="text-3 text-sm">@{$currentUser?.username || ''}</span>
      </div>
    </div>

    <!-- Profile fields -->
    <div class="card settings-card">
      <div class="editor-card-title">{$_('profile.personal_info')}</div>

      <div class="form-group">
        <label class="form-label">{$_('profile.full_name')}</label>
        <input class="input" type="text" placeholder={$_('profile.full_name_placeholder')} bind:value={full_name} />
      </div>
      <div class="form-group">
        <label class="form-label">{$_('forgot_password.email_label')}</label>
        <input class="input" type="email" autocomplete="email"
          placeholder={$_('profile.email_placeholder')} bind:value={email} />
      </div>
      <div class="form-group">
        <label class="form-label">{$_('profile.nickname')}</label>
        <input class="input" type="text" placeholder={$_('profile.nickname_placeholder')} bind:value={nickname} />
      </div>
      <div class="form-group">
        <label class="form-label">{$_('profile.birthday')}</label>
        <DateInput bind:value={birthday} max={localDateStr()} />
      </div>
      <div class="form-group">
        <label class="form-label">{$_('profile.gender')}</label>
        <div class="select-wrap">
          <select class="select" bind:value={gender}>
            <option value="">{$_('profile.gender_unset')}</option>
            {#each GENDERS as g}<option value={g}>{g}</option>{/each}
          </select>
        </div>
      </div>
    </div>

    {#if oidcProviders.length || linkedProviders.length}
      <div class="card settings-card">
        <div class="editor-card-title">{$_('profile.linked_accounts')}</div>
        {#if linkedProviders.length}
          <div class="oidc-link-list">
            {#each linkedProviders as l (l.id)}
              <div class="oidc-link-row">
                {#if l.logo_url}
                  <img src={resolveAssetUrl(l.logo_url)} alt="" class="oidc-link-logo" />
                {:else}
                  <span class="material-symbols-rounded oidc-link-icon">verified_user</span>
                {/if}
                <div class="oidc-link-info">
                  <span class="oidc-link-name">{l.display_name || 'OIDC'}</span>
                  {#if l.last_login_at}
                    <span class="oidc-link-meta text-3 text-sm">last sign-in {new Date(l.last_login_at).toLocaleDateString()}</span>
                  {/if}
                </div>
                <button class="btn btn-ghost btn-sm" on:click={() => unlink(l.id)} disabled={unlinking === l.id}>
                  {unlinking === l.id ? '…' : $_('profile.unlink')}
                </button>
              </div>
            {/each}
          </div>
        {:else}
          <p class="text-3 text-sm" style="margin:0 0 8px">{$_('profile.no_linked_accounts')}</p>
        {/if}
        {#if availableToLink.length}
          <div class="oidc-link-add">
            {#each availableToLink as p (p.id)}
              <button class="btn btn-secondary" on:click={() => startLink(p.id)}>
                {#if p.logo_url}
                  <img src={resolveAssetUrl(p.logo_url)} alt="" class="oidc-link-logo" />
                {:else}
                  <span class="material-symbols-rounded oidc-link-icon">add_link</span>
                {/if}
                <span>{$_('profile.link_with')} {p.display_name || 'SSO'}</span>
              </button>
            {/each}
          </div>
        {/if}
      </div>
    {/if}

    <!-- Change password -->
    <div class="card settings-card">
      <div class="editor-card-title">{$_('profile.security')}</div>
      {#if !changingPassword}
        <button class="btn btn-ghost w-full" on:click={() => changingPassword = true}>
          {hasPassword ? $_('profile.change_password') : $_('profile.set_password')}
        </button>
      {:else}
        {#if hasPassword}
          <div class="form-group">
            <label class="form-label">{$_('profile.current_password')}</label>
            <input class="input" type="password" bind:value={cur_password} />
          </div>
        {/if}
        <div class="form-group">
          <label class="form-label">{$_('reset_password.new_password')}</label>
          <input class="input" type="password" bind:value={new_password} placeholder={$_('reset_password.password_placeholder')} />
          {#if new_password}
            <div class="pw-strength" class:s-0={pwScore.score === 0} class:s-1={pwScore.score === 1} class:s-2={pwScore.score === 2} class:s-3={pwScore.score === 3} class:s-4={pwScore.score === 4}>
              <div class="pw-bar"><div class="pw-fill" style:width={`${(pwScore.score / 4) * 100}%`}></div></div>
              <span class="pw-label">{pwScore.label}</span>
            </div>
          {/if}
        </div>
        <div class="form-group">
          <label class="form-label">{$_('profile.confirm_new_password')}</label>
          <input class="input" type="password" bind:value={new_password2} />
          {#if new_password2 && new_password !== new_password2}
            <p class="pw-mismatch">{$_('reset_password.errors.mismatch')}</p>
          {/if}
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-ghost" style="flex:1" on:click={() => { changingPassword = false; cur_password=new_password=new_password2=''; }}>
            {$_('common.cancel')}
          </button>
          <button class="btn btn-primary" style="flex:1" on:click={changePassword} disabled={pwSaving}>
            {pwSaving ? $_('common.saving') : (hasPassword ? $_('profile.change_password') : $_('profile.set_password'))}
          </button>
        </div>
      {/if}
    </div>

    <!-- Danger zone: delete my account -->
    <div class="card settings-card danger-zone-card">
      <div class="editor-card-title" style="color:var(--danger)">{$_('profile.danger_zone')}</div>
      <p class="text-3 text-sm" style="margin:0;line-height:1.5">
        {$_('profile.delete_account_explainer')}
      </p>
      <button class="btn btn-secondary" style="color:var(--danger);border-color:color-mix(in srgb,var(--danger) 40%, transparent)"
        on:click={deleteMyAccount} disabled={deletingAccount}>
        <span class="material-symbols-rounded" style="font-size:16px;vertical-align:middle">delete_forever</span>
        {deletingAccount ? $_('profile.deleting') : $_('profile.delete_account')}
      </button>
    </div>
  </div>
</div>

<style>
  .page-wrap { display: flex; flex-direction: column; height: 100dvh; overflow: hidden; }
  .danger-zone-card { border-color: color-mix(in srgb, var(--danger) 25%, transparent) !important; }
  .profile-body { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 16px; }
  .avatar-section {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    padding: 16px 0;
  }
  .avatar-btn {
    position: relative;
    width: 96px; height: 96px;
    border-radius: 50%;
    border: none;
    background: var(--surface-2);
    cursor: pointer;
    overflow: hidden;
    display: flex; align-items: center; justify-content: center;
  }
  .avatar-img { width: 100%; height: 100%; object-fit: cover; }
  .avatar-placeholder { font-size: 48px; color: var(--text-3); }
  .avatar-overlay {
    position: absolute;
    inset: 0;
    background: rgba(0,0,0,0.45);
    display: flex; align-items: center; justify-content: center;
    color: #fff;
    opacity: 0;
    transition: opacity 0.15s;
  }
  .avatar-btn:hover .avatar-overlay { opacity: 1; }
  .avatar-meta { display: flex; flex-direction: column; align-items: center; gap: 2px; }
  .profile-body .settings-card { padding: 16px; display: flex; flex-direction: column; gap: 12px; }
  .profile-body .editor-card-title { font-size: 16px; font-weight: 600; margin: 0; }

  /* Password strength indicator — shared pattern */
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

  .oidc-link-list { display: flex; flex-direction: column; gap: 8px; margin-bottom: 8px; }
  .oidc-link-row {
    display: flex; align-items: center; gap: 10px;
    padding: 8px 10px; border: 1px solid var(--border); border-radius: var(--radius-md);
  }
  .oidc-link-logo { width: 22px; height: 22px; object-fit: contain; flex: 0 0 auto; }
  .oidc-link-icon { font-size: 22px; flex: 0 0 auto; color: var(--text-3); }
  .oidc-link-info { flex: 1; display: flex; flex-direction: column; min-width: 0; }
  .oidc-link-name { font-weight: 600; }
  .oidc-link-meta { font-size: 11px; }
  .oidc-link-add { display: flex; flex-direction: column; gap: 6px; margin-top: 6px; }
  .oidc-link-add .btn { display: flex; align-items: center; gap: 8px; justify-content: center; }
</style>
