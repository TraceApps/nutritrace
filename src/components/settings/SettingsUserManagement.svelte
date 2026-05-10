<script>
  import { slide } from 'svelte/transition';
  import { _ } from 'svelte-i18n';
  import Toggle from './Toggle.svelte';
  import { showSuccess, showError } from '../../stores/toast.js';
  import { DB } from '../../lib/db.js';
  import { NtApi } from '../../lib/api.js';
  import { currentUser, userMgmtActive, loadAuthState } from '../../stores/auth.js';
  import { isNative, getServerUrl, resolveAssetUrl, apiUrl, getAuthToken, setAuthToken } from '../../lib/platform.js';
  import { push } from 'svelte-spa-router';
  import { validatePassword } from '../../lib/validation.js';
  import { confirmDialog } from '../../stores/confirmDialog.js';

  // ── User Management state ────────────────────────────────────────────────────
  let umUsers        = [];
  let umLoading      = false;
  let showAddUser    = false;
  let newUsername    = '';
  let newPassword    = '';
  let newShowPass    = false;
  let newFullName    = '';
  let newRole        = 'user';
  let umError        = '';
  // showDisableUmDialog removed — use confirmDialog() store instead

  // Enable User Management from Settings
  let showEnableUm    = false;
  let enableAdminUser = '';
  let enableAdminPass = '';
  let enableShowPass = false;
  let enableAdminConf = '';
  let enableAdminName = '';
  let enableUmError   = '';
  let enableUmLoading = false;

  // Session Duration (admin-only)
  let sessionHours = '720';
  let sessionSaved = false;

  // OIDC providers + password-login toggle live in SettingsAuth.svelte
  // (its own top-level Settings section).

  function _csrfHeaders(extra = {}) {
    const h = { 'Content-Type': 'application/json', ...extra };
    if (isNative && getServerUrl()) {
      const t = getAuthToken();
      if (t) h['Authorization'] = `Bearer ${t}`;
    } else {
      const csrf = localStorage.getItem('nt:csrf');
      if (csrf) h['X-CSRF-Token'] = csrf;
    }
    return h;
  }

  // Invite
  let inviteEmail  = '';
  let inviteRole   = 'user';
  let inviteLoading = false;
  let inviteResult = null; // { inviteUrl, sent }

  export async function loadData() {
    if ($userMgmtActive) {
      await loadUsers();
      if ($currentUser?.role === 'admin') {
        await loadSessionConfig();
      }
    }
  }

  async function loadSessionConfig() {
    try {
      const res = await fetch(apiUrl('/api/app-config'), { credentials: 'include' });
      if (!res.ok) return;
      const cfg = await res.json();
      sessionHours = cfg.session_hours ?? '720';
    } catch {}
  }

  async function saveSessionHours() {
    const h = {};
    if (isNative && getServerUrl()) {
      const t = getAuthToken();
      if (t) h['Authorization'] = `Bearer ${t}`;
    } else {
      const csrf = localStorage.getItem('nt:csrf');
      if (csrf) h['X-CSRF-Token'] = csrf;
    }
    await fetch(apiUrl('/api/app-config'), {
      method: 'PUT', credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...h },
      body: JSON.stringify({ key: 'session_hours', value: sessionHours }),
    }).catch(() => {});
    sessionSaved = true;
    setTimeout(() => sessionSaved = false, 2000);
  }

  async function enableUserManagement() {
    enableUmError = '';
    if (!enableAdminUser.trim()) { enableUmError = $_('settings.users.err_username_required'); return; }
    const pwErr = validatePassword(enableAdminPass);
    if (pwErr) { enableUmError = pwErr; return; }
    if (enableAdminPass !== enableAdminConf) { enableUmError = $_('settings.users.err_passwords_mismatch'); return; }
    enableUmLoading = true;
    try {
      const res = await fetch(apiUrl('/api/auth/register'), {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username:  enableAdminUser.trim(),
          password:  enableAdminPass,
          full_name: enableAdminName.trim() || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { enableUmError = data.error || $_('settings.users.err_registration_failed'); enableUmLoading = false; return; }
      // Migrate previously-anonymous settings (`wl_<key>`) to the new admin's
      // per-user prefix BEFORE flipping wl:userId, so the wizard-configured
      // mealNames/dob/gender/goals/etc. survive the mode switch instead of
      // looking blank to the freshly-created admin.
      try { DB.migrateSettingsPrefix(null, data.user.id); } catch {}
      localStorage.setItem('wl:userId', data.user.id);
      // Persist any localUser* profile fields onto the admin's users-row so
      // they don't get re-discovered as null on next loadAuthState.
      const profile = {
        full_name: DB.getSetting('localUserName',     null) || enableAdminName.trim() || undefined,
        nickname:  DB.getSetting('localUserNickname', null) || undefined,
        birthday:  DB.getSetting('dob',               null) || undefined,
        gender:    DB.getSetting('gender',            null) || undefined,
        avatar_url:DB.getSetting('localUserAvatar',   null) || undefined,
      };
      if (Object.values(profile).some(v => v != null)) {
        try {
          await fetch(apiUrl('/api/auth/profile'), {
            method: 'PUT', credentials: 'include',
            headers: _csrfHeaders(),
            body: JSON.stringify(profile),
          });
        } catch {}
      }
      await loadAuthState();
      showEnableUm = false;
      enableAdminUser = ''; enableAdminPass = ''; enableAdminConf = ''; enableAdminName = '';
      await loadUsers();
      showSuccess($_('settings.users.toast_um_enabled'));
    } catch(e) { enableUmError = $_('settings.users.err_could_not_reach_server'); }
    enableUmLoading = false;
  }

  async function loadUsers() {
    try {
      umUsers = await NtApi.get('/api/auth/users');
    } catch(e) { umError = e.message; }
  }

  async function addUser() {
    umError = '';
    if (!newUsername.trim() || !newPassword.trim()) { umError = $_('settings.users.err_username_password_required'); return; }
    umLoading = true;
    try {
      const res = await fetch(apiUrl('/api/auth/register'), {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: newUsername.trim(), password: newPassword, full_name: newFullName.trim() || undefined, role: newRole }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { umError = data.error || $_('settings.users.err_failed_to_add'); } else {
        newUsername = ''; newPassword = ''; newFullName = ''; newRole = 'user';
        showAddUser = false;
        await loadUsers();
        showSuccess($_('settings.users.toast_user_created'));
      }
    } catch(e) { umError = e.message; }
    umLoading = false;
  }

  async function changeUserRole(u, newRole) {
    if (newRole === u.role) return;
    const name = u.full_name || u.username;
    if (!await confirmDialog({
      title: $_(newRole === 'admin' ? 'settings.users.promote_title' : 'settings.users.demote_title', { values: { name } }),
      message: $_(newRole === 'admin' ? 'settings.users.promote_message' : 'settings.users.demote_message'),
      confirmText: $_(newRole === 'admin' ? 'settings.users.promote_confirm' : 'settings.users.demote_confirm'),
      dangerous: newRole !== 'admin',
    })) return;
    try {
      const res = await fetch(apiUrl(`/api/auth/users/${u.id}/role`), {
        method: 'PUT',
        credentials: 'include',
        headers: _csrfHeaders(),
        body: JSON.stringify({ role: newRole }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { showError(data?.error || $_('settings.users.err_could_not_change_role')); return; }
      showSuccess($_('settings.users.toast_role_changed', { values: { name, role: newRole } }));
      await loadUsers();
    } catch (e) { showError($_('settings.users.err_could_not_reach_server')); }
  }

  async function resetUserPassword(u) {
    const name = u.full_name || u.username;
    const pw = prompt($_('settings.users.reset_password_prompt', { values: { name } }));
    if (!pw) return;
    const pwErr = validatePassword(pw);
    if (pwErr) { showError(pwErr); return; }
    try {
      const res = await fetch(apiUrl(`/api/auth/users/${u.id}/password`), {
        method: 'PUT',
        credentials: 'include',
        headers: _csrfHeaders(),
        body: JSON.stringify({ new_password: pw }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { showError(data?.error || $_('settings.users.err_could_not_reset_password')); return; }
      showSuccess($_('settings.users.toast_password_reset'));
    } catch (e) { showError($_('settings.users.err_could_not_reach_server')); }
  }

  async function deleteUser(u) {
    const name = u.full_name || u.username;
    if (!await confirmDialog({
      title: $_('settings.users.delete_user_title', { values: { name } }),
      message: $_('settings.users.delete_user_message'),
      confirmText: $_('settings.users.delete'),
      dangerous: true,
    })) return;
    try {
      await NtApi.del(`/api/auth/users/${u.id}`);
      await loadUsers();
      showSuccess($_('settings.users.toast_user_deleted'));
    } catch(e) { showError(e.message); }
  }

  async function disableUserManagement() {
    if (!await confirmDialog({
      title: $_('settings.users.disable_um_title'),
      message: $_('settings.users.disable_um_message'),
      confirmText: $_('settings.users.disable_um_confirm'),
      dangerous: true,
    })) return;
    try {
      // Snapshot the current admin's profile + per-user settings BEFORE the
      // server wipes the users table — once disabled, we drop back to the
      // anonymous `wl_<key>` prefix and the synthetic LOCAL_USER. Without
      // this, the admin's name / dob / gender / mealNames / goals / etc.
      // would silently disappear with no recovery path.
      const u = $currentUser;
      const oldId = u?.id;
      if (u) {
        if (u.full_name)  DB.setSetting('localUserName',     u.full_name);
        if (u.nickname)   DB.setSetting('localUserNickname', u.nickname);
        if (u.birthday)   DB.setSetting('dob',               u.birthday);
        if (u.gender)     DB.setSetting('gender',            u.gender);
        if (u.avatar_url) DB.setSetting('localUserAvatar',   u.avatar_url);
      }
      await NtApi.del('/api/auth/management');
      // Move per-user settings back to the anonymous prefix so they're
      // visible after the prefix flip below.
      if (oldId != null) {
        try { DB.migrateSettingsPrefix(oldId, null); } catch {}
      }
      localStorage.removeItem('wl:userId');
      await loadAuthState();
      showSuccess($_('settings.users.toast_um_disabled'));
      await loadUsers();
    } catch(e) { showError(e.message); }
  }

  async function logoutServer() {
    document.body.style.transition = 'opacity 0.3s';
    document.body.style.opacity = '0';
    // Tell the server to clear the auth cookie — it's httpOnly so the
    // client can't drop it directly. Without this round-trip the page
    // reload below would silently re-authenticate and leave the user in.
    try {
      const csrf = localStorage.getItem('nt:csrf');
      const headers = {};
      if (isNative && getServerUrl()) {
        const t = getAuthToken();
        if (t) headers['Authorization'] = `Bearer ${t}`;
      } else if (csrf) {
        headers['X-CSRF-Token'] = csrf;
      }
      await fetch(apiUrl('/api/auth/logout'), {
        method: 'POST', credentials: 'include', headers,
      });
    } catch {}
    localStorage.removeItem('wl:userId');
    localStorage.removeItem('nt:cachedUser');
    localStorage.removeItem('nt:csrf');
    // Keep nt:cachedUserMgmt — user-management is a server-wide flag, not
    // a per-session one, so don't flicker the post-reload boot into wizard.
    if (isNative) setAuthToken(null);
    setTimeout(() => window.location.reload(), 300);
  }

  async function createInvite() {
    inviteLoading = true;
    inviteResult  = null;
    try {
      const res  = await fetch(apiUrl('/api/auth/invite'), {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: inviteEmail.trim() || undefined, role: inviteRole }),
      });
      const data = await res.json();
      if (!res.ok) { showError(data.error || 'Failed to create invite'); return; }
      inviteResult = data;
      inviteEmail  = '';
    } catch { showError('Could not create invite'); }
    inviteLoading = false;
  }
</script>

<div class="section-body" transition:slide={{ duration: 180 }}>
  <div class="card settings-card">
    {#if $userMgmtActive}
      <!-- User list (admin only) — your own profile lives in the dedicated
           "My Profile" Settings entry above this section. -->
      {#if $currentUser?.role === 'admin'}
        {#if umUsers.length > 1}
        <div class="setting-row" style="flex-direction:column;align-items:flex-start;gap:8px;padding:12px 16px">
          <span class="setting-label">{$_('settings.users.users_heading')}</span>

          <div class="um-user-list">
            {#each umUsers as u}
              <div class="um-user-row">
                <div class="um-user-avatar">
                  {#if u.avatar_url}
                    <img src={resolveAssetUrl(u.avatar_url)} alt={u.username} />
                  {:else}
                    <span class="material-symbols-rounded">person</span>
                  {/if}
                </div>
                <div class="um-user-info">
                  <div class="um-user-name">{u.nickname || u.full_name || u.username}</div>
                  <div class="um-user-sub">@{u.username}</div>
                  <div class="um-user-role">
                    {#if u.id === $currentUser?.id}
                      <span class="um-role-self">{u.role} {$_('settings.users.role_self_suffix')}</span>
                    {:else}
                      <select class="um-role-select" value={u.role}
                        on:change={e => changeUserRole(u, e.target.value)}>
                        <option value="user">user</option>
                        <option value="admin">admin</option>
                      </select>
                    {/if}
                  </div>
                </div>
                {#if u.id !== $currentUser?.id}
                  <button class="btn btn-ghost um-del-btn" title={$_('settings.users.reset_password')}
                    on:click={() => resetUserPassword(u)}>
                    <span class="material-symbols-rounded" style="font-size:18px;color:var(--text-3)">lock_reset</span>
                  </button>
                  <button class="btn btn-ghost um-del-btn" title={$_('settings.users.delete')}
                    on:click={() => deleteUser(u)}>
                    <span class="material-symbols-rounded" style="font-size:18px;color:var(--danger)">person_remove</span>
                  </button>
                {/if}
              </div>
            {/each}
          </div>
        </div>
        <div class="setting-divider"></div>
        {/if}

        <!-- Primary path: invite -->
        <div class="setting-row um-form-block">
          <div>
            <span class="setting-label">{$_('settings.users.invite_user')}</span>
            <div class="setting-desc" style="margin-top:2px">{$_('settings.users.invite_user_explainer')}</div>
          </div>
          <input class="input" type="email" bind:value={inviteEmail} placeholder={$_('settings.users.email_optional')} />
          <div class="um-role-pair">
            <label class="um-role-label" for="invite-role-sel">{$_('settings.users.role')}</label>
            <div class="um-role-select-wrap">
              <select id="invite-role-sel" class="um-role-styled-select" bind:value={inviteRole}>
                <option value="user">{$_('settings.users.role_user')}</option>
                <option value="admin">{$_('settings.users.role_admin')}</option>
              </select>
              <span class="material-symbols-rounded um-role-chev">expand_more</span>
            </div>
          </div>
          <button class="btn btn-primary" style="width:100%" on:click={createInvite} disabled={inviteLoading}>
            {inviteLoading ? $_('settings.users.creating') : (inviteEmail.trim() ? $_('settings.users.send_invite') : $_('settings.users.generate_link'))}
          </button>
          {#if inviteResult}
            <div class="invite-result" transition:slide={{ duration: 160 }}>
              {#if inviteResult.sent}
                <span class="material-symbols-rounded" style="color:var(--accent);font-size:18px">mark_email_read</span>
                <span style="font-size:13px">{$_('settings.users.invite_sent_to', { values: { email: inviteEmail || $_('settings.users.user_fallback') } })}</span>
              {:else}
                <span style="font-size:13px;color:var(--text-2)">{$_('settings.users.share_link_intro')}</span>
                <div class="invite-link-row">
                  <input class="input" style="flex:1;font-size:12px" readonly value={inviteResult.inviteUrl} />
                  <button class="btn btn-secondary" style="height:36px;padding:0 12px;font-size:12px"
                    on:click={() => { navigator.clipboard?.writeText(inviteResult.inviteUrl); showSuccess($_('settings.users.toast_link_copied')); }}>
                    {$_('settings.users.copy')}
                  </button>
                </div>
              {/if}
            </div>
          {/if}
        </div>

        <!-- Subtle divider separating the two add-user paths -->
        <div class="setting-divider"></div>

        <!-- Secondary path: add user manually (escape hatch for no-SMTP / offline setups) -->
        <button class="um-secondary-toggle" on:click={() => { showAddUser = !showAddUser; umError = ''; }}>
          <span class="material-symbols-rounded" style="font-size:14px">{showAddUser ? 'expand_less' : 'expand_more'}</span>
          {showAddUser ? $_('settings.users.add_user_hide') : $_('settings.users.add_user_show')}
        </button>
        {#if showAddUser}
          <div class="um-add-form um-form-block" transition:slide={{ duration: 160 }}>
            <input class="input" type="text" bind:value={newUsername} placeholder={$_('settings.users.username_required')} autocomplete="off" />
            <div class="um-pw-wrap">
              {#if newShowPass}
                <input class="input um-pw-input" type="text" bind:value={newPassword} placeholder={$_('settings.users.password_required')} autocomplete="new-password" />
              {:else}
                <input class="input um-pw-input" type="password" bind:value={newPassword} placeholder={$_('settings.users.password_required')} autocomplete="new-password" />
              {/if}
              <button class="um-pw-eye" type="button" on:click={() => newShowPass = !newShowPass} aria-label={newShowPass ? 'Hide' : 'Show'}>
                <span class="material-symbols-rounded">{newShowPass ? 'visibility_off' : 'visibility'}</span>
              </button>
            </div>
            <input class="input" type="text" bind:value={newFullName} placeholder={$_('settings.users.full_name')} />
            <div class="um-role-pair">
              <label class="um-role-label" for="add-role-sel">{$_('settings.users.role')}</label>
              <div class="um-role-select-wrap">
                <select id="add-role-sel" class="um-role-styled-select" bind:value={newRole}>
                  <option value="user">{$_('settings.users.role_user')}</option>
                  <option value="admin">{$_('settings.users.role_admin')}</option>
                </select>
                <span class="material-symbols-rounded um-role-chev">expand_more</span>
              </div>
            </div>
            {#if umError}<p class="um-error">{umError}</p>{/if}
            <button class="btn btn-secondary" style="width:100%" on:click={addUser} disabled={umLoading}>
              {umLoading ? $_('settings.users.creating') : $_('settings.users.create_directly')}
            </button>
          </div>
        {/if}


        <div class="setting-divider"></div>
        <div class="setting-row">
          <div>
            <span class="setting-label">Session Duration</span>
            <div class="setting-desc">How long users stay signed in. Applies to new logins.</div>
          </div>
          <div style="display:flex;align-items:center;gap:8px">
            <div class="select-wrap" style="width:130px">
              <select class="select sel-sm" bind:value={sessionHours}>
                <option value="0">Never expires</option>
                <option value="8">8 hours</option>
                <option value="24">1 day</option>
                <option value="168">7 days</option>
                <option value="720">30 days</option>
                <option value="2160">90 days</option>
                <option value="8760">1 year</option>
              </select>
            </div>
            <button class="btn btn-secondary" style="height:32px;font-size:12px;padding:0 12px;white-space:nowrap" on:click={saveSessionHours}>
              {#if sessionSaved}<span class="material-symbols-rounded" style="font-size:14px">check</span>{:else}Save{/if}
            </button>
          </div>
        </div>

        <div class="setting-divider"></div>
        <button class="setting-row setting-action danger" on:click={disableUserManagement}>
          <span class="material-symbols-rounded si" style="color:var(--danger)">no_accounts</span>
          <div>
            <span class="setting-label" style="color:var(--danger)">Disable User Management</span>
            <div class="setting-desc">Removes all user accounts and returns to single-user mode</div>
          </div>
        </button>
      {/if}

    {:else}
      <button class="setting-row setting-action" on:click={() => { showEnableUm = !showEnableUm; enableUmError = ''; }}>
        <span class="material-symbols-rounded si" style="color:var(--accent)">group_add</span>
        <div>
          <span class="setting-label">Enable User Management</span>
          <div class="setting-desc">Add multiple user accounts with separate data &amp; settings</div>
        </div>
        <span class="material-symbols-rounded text-3" style="font-size:18px">{showEnableUm ? 'expand_less' : 'expand_more'}</span>
      </button>

      {#if showEnableUm}
        <div class="section-body" style="padding:0 16px 16px" transition:slide={{ duration: 160 }}>
          <p class="um-section-label" style="margin-bottom:8px">Create admin account</p>
          <p class="text-3 text-sm" style="margin:0 0 12px;line-height:1.5">
            The first account is always admin. All existing food, meal, and diary data on this server will be assigned to it.
          </p>
          <div class="um-add-form">
            <div class="um-form-row">
              <input class="input" type="text" bind:value={enableAdminUser} placeholder="Username *" autocomplete="username" />
              <input class="input" type="text" bind:value={enableAdminName} placeholder="Full name (optional)" />
            </div>
            <div class="um-form-row">
              <div style="display:flex;gap:4px;align-items:center;flex:1">
                {#if enableShowPass}
                  <input class="input" style="flex:1" type="text" bind:value={enableAdminPass} placeholder="Password *" autocomplete="new-password" />
                {:else}
                  <input class="input" style="flex:1" type="password" bind:value={enableAdminPass} placeholder="Password *" autocomplete="new-password" />
                {/if}
                <button class="btn-icon" on:click={() => enableShowPass = !enableShowPass} style="flex-shrink:0">
                  <span class="material-symbols-rounded" style="font-size:18px">{enableShowPass ? 'visibility_off' : 'visibility'}</span>
                </button>
              </div>
              {#if enableShowPass}
                <input class="input" type="text" bind:value={enableAdminConf} placeholder="Confirm *" autocomplete="new-password" />
              {:else}
                <input class="input" type="password" bind:value={enableAdminConf} placeholder="Confirm *" autocomplete="new-password" />
              {/if}
            </div>
            {#if enableUmError}<p class="um-error">{enableUmError}</p>{/if}
            <button class="btn btn-primary" style="width:100%" on:click={enableUserManagement} disabled={enableUmLoading}>
              {enableUmLoading ? 'Enabling...' : 'Enable & Create Admin'}
            </button>
          </div>
        </div>
      {/if}
    {/if}
  </div>
</div>

<style>
  /* Mirror Settings.svelte scoped styles */
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

  .setting-action {
    width: 100%;
    background: none;
    border: none;
    cursor: pointer;
    text-align: left;
    color: var(--text-1);
  }
  .setting-action:hover { background: var(--surface-2); }
  .setting-action.danger:hover { background: rgba(239,68,68,0.06); }

  /* User management styles */
  .um-add-form { display: flex; flex-direction: column; gap: 8px; width: 100%; }
  .um-form-row { display: flex; gap: 8px; }
  .um-user-list { display: flex; flex-direction: column; gap: 6px; width: 100%; }
  .um-user-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px;
    border-radius: var(--radius-md);
    background: var(--surface-2);
  }
  .um-user-avatar {
    width: 36px; height: 36px;
    border-radius: 50%;
    background: var(--surface-3);
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0;
    overflow: hidden;
    font-size: 20px; color: var(--text-3);
  }
  .um-user-avatar img { width: 100%; height: 100%; object-fit: cover; }
  .um-user-info { flex: 1; min-width: 0; }
  .um-user-name { font-size: 14px; font-weight: 500; color: var(--text-1); }
  .um-user-sub  { font-size: 12px; color: var(--text-3); }
  .um-user-role { margin-top: 4px; }
  .um-role-self {
    font-size: 11px; font-weight: 600; color: var(--text-3);
    background: var(--surface-2); padding: 3px 8px; border-radius: var(--radius-sm);
    text-transform: capitalize;
  }
  .um-role-select {
    background: var(--surface-2); border: 1px solid var(--border);
    color: var(--text-1); font-size: 11px; font-family: inherit;
    border-radius: var(--radius-sm); padding: 3px 6px; height: 24px;
    outline: none; cursor: pointer;
  }
  .um-role-select:focus { border-color: var(--accent); }

  /* Secondary 'Add user manually' toggle — quieter than a button, leads
     into the escape-hatch direct-add form. */
  .um-secondary-toggle {
    display: flex; align-items: center; gap: 4px;
    width: 100%;
    background: none; border: none; cursor: pointer;
    padding: 10px 16px;
    color: var(--text-3); font-size: 12px; font-family: inherit;
    text-align: left;
    transition: color var(--dur-fast);
  }
  .um-secondary-toggle:hover { color: var(--text-2); }

  /* Vertically-stacked form block for invite + manual-add — clearer than
     the previous side-by-side compression that squished the password
     input next to the eye icon. */
  .um-form-block {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 10px;
    padding: 12px 16px;
  }

  /* Password input + visibility toggle, side-by-side with the eye icon
     pinned at the right. The previous flex-1-on-flex-1 nesting collapsed
     the input to a stub. */
  .um-pw-wrap {
    position: relative;
    display: flex;
    align-items: center;
  }
  .um-pw-input {
    flex: 1;
    width: 100%;
    padding-right: 38px;
  }
  .um-pw-eye {
    position: absolute;
    right: 6px;
    background: none;
    border: none;
    cursor: pointer;
    color: var(--text-3);
    padding: 4px;
    display: flex;
    align-items: center;
  }
  .um-pw-eye:hover { color: var(--text-1); }
  .um-pw-eye .material-symbols-rounded { font-size: 18px; }

  /* Role select with proper label + chevron — looks like a select instead
     of a flat input. */
  .um-role-pair {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .um-role-label {
    font-size: 13px;
    color: var(--text-2);
    flex-shrink: 0;
  }
  .um-role-select-wrap {
    position: relative;
    display: inline-flex;
    align-items: center;
  }
  .um-role-styled-select {
    appearance: none;
    -webkit-appearance: none;
    background: var(--surface-2);
    border: 1px solid var(--border);
    color: var(--text-1);
    font-size: 13px;
    font-family: inherit;
    border-radius: var(--radius-md);
    padding: 6px 28px 6px 10px;
    cursor: pointer;
  }
  .um-role-styled-select:focus {
    outline: none;
    border-color: var(--accent);
  }
  .um-role-chev {
    position: absolute;
    right: 6px;
    pointer-events: none;
    font-size: 18px;
    color: var(--text-3);
  }
  .um-del-btn   { padding: 4px 8px; }
  .um-error     { color: var(--danger); font-size: 13px; margin: 0; }
  .um-section-label { font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-3); }

  .invite-result {
    display: flex;
    flex-direction: column;
    gap: 6px;
    width: 100%;
    padding: 10px;
    background: var(--surface-2);
    border-radius: var(--radius-md);
  }
  .invite-link-row { display: flex; gap: 8px; }

</style>
