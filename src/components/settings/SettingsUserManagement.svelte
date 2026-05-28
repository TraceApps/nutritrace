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
  import Dialog from '../ui/Dialog.svelte';

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

  // Password Policy (admin-only) — 'standard' | 'strong'
  let passwordPolicy = 'standard';
  let passwordPolicySaved = false;

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
  let pendingInvites = []; // { token, email, role, expires_at }
  async function loadPendingInvites() {
    try { pendingInvites = await NtApi.get('/api/auth/invites'); }
    catch { pendingInvites = []; }
  }
  async function revokeInvite(token) {
    if (!await confirmDialog({
      title: 'Revoke invite?',
      message: 'The link will stop working immediately. The recipient won\'t be able to use it after this.',
      confirmText: 'Revoke',
      dangerous: true,
    })) return;
    try {
      await NtApi.del(`/api/auth/invites/${token}`);
      await loadPendingInvites();
      showSuccess('Invite revoked');
    } catch (e) { showError(e.message || 'Could not revoke invite'); }
  }

  export async function loadData() {
    if ($userMgmtActive) {
      await loadUsers();
      if ($currentUser?.role === 'admin') {
        await loadSessionConfig();
        await loadPendingInvites();
      }
    }
  }

  async function loadSessionConfig() {
    try {
      // _csrfHeaders attaches Authorization: Bearer for native and
      // X-CSRF-Token for PWA — same call pattern as the rest of this file.
      // Without it the Android app silently 401s and falls through to the
      // 'standard' default, which made the strong-password toggle look like
      // it wasn't persisting (it was; we just couldn't read it back).
      const res = await fetch(apiUrl('/api/app-config'), {
        credentials: 'include',
        headers: _csrfHeaders(),
      });
      if (!res.ok) {
        console.warn('[user-mgmt] loadSessionConfig got', res.status);
        return;
      }
      const cfg = await res.json();
      sessionHours = cfg.session_hours ?? '720';
      passwordPolicy = cfg.password_policy || 'standard';
    } catch (e) {
      console.warn('[user-mgmt] loadSessionConfig threw', e);
    }
  }

  async function savePasswordPolicy(value) {
    const prev = passwordPolicy;
    passwordPolicy = value;
    try {
      const res = await fetch(apiUrl('/api/app-config'), {
        method: 'PUT', credentials: 'include',
        headers: _csrfHeaders(),
        body: JSON.stringify({ key: 'password_policy', value }),
      });
      if (!res.ok) {
        // Most likely cause: the server hasn't redeployed with
        // 'password_policy' in ALLOWED_KEYS yet (returns 400 'Unknown
        // config key'). Roll back the optimistic UI flip and surface
        // the reason so the failure isn't silent.
        const data = await res.json().catch(() => ({}));
        const msg = data.error || `Save failed (${res.status})`;
        console.warn('[password-policy] save rejected:', msg);
        showError(`Could not save password policy: ${msg}. Server may need to redeploy.`);
        passwordPolicy = prev;
        return;
      }
      // Confirm by reading back what the server stored — guards against
      // 'silent success' where the server returned 200 but the row didn't
      // actually persist for some reason.
      await loadSessionConfig();
      passwordPolicySaved = true;
      setTimeout(() => passwordPolicySaved = false, 2000);
    } catch (e) {
      console.warn('[password-policy] save threw:', e);
      showError(`Could not save password policy: ${e?.message || 'network error'}`);
      passwordPolicy = prev;
    }
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
        headers: _csrfHeaders(),
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

  // Type-username-to-confirm delete. Loads a per-user data-counts preview so
  // the admin sees exactly what cascades away before they wipe years of logs.
  let _delTarget = null;        // { id, username, full_name }
  let _delCounts = null;        // { foods, meals, recipes, diary_days, ... }
  let _delTyped  = '';
  let _delOpen   = false;
  let _delLoading = false;

  async function deleteUser(u) {
    _delTarget = u;
    _delCounts = null;
    _delTyped  = '';
    _delOpen   = true;
    try {
      const r = await NtApi.get(`/api/auth/users/${u.id}/data-counts`);
      if (_delOpen && _delTarget?.id === u.id) _delCounts = r;
    } catch (e) {
      _delCounts = { error: e.message };
    }
  }

  async function _confirmDeleteUser() {
    if (!_delTarget || _delTyped.trim() !== _delTarget.username) return;
    _delLoading = true;
    try {
      await NtApi.del(`/api/auth/users/${_delTarget.id}`);
      _delOpen = false;
      _delTarget = null;
      _delCounts = null;
      await loadUsers();
      showSuccess($_('settings.users.toast_user_deleted'));
    } catch (e) {
      showError(e.message || 'Could not delete user');
    }
    _delLoading = false;
  }

  function _cancelDeleteUser() {
    _delOpen = false;
    _delTarget = null;
    _delCounts = null;
    _delTyped = '';
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

  // Permissive email shape — server is the source of truth, this is just a
  // UI guard so 'asdf' can't be submitted as if it were an email address.
  $: _inviteEmailTrimmed = inviteEmail.trim();
  $: _inviteEmailValid   = !_inviteEmailTrimmed || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(_inviteEmailTrimmed);
  $: _inviteCanSubmit    = !inviteLoading && _inviteEmailValid;

  async function createInvite() {
    if (!_inviteEmailValid) {
      showError('Enter a valid email or leave blank to generate a shareable link');
      return;
    }
    inviteLoading = true;
    inviteResult  = null;
    try {
      const res  = await fetch(apiUrl('/api/auth/invite'), {
        method: 'POST', credentials: 'include',
        headers: _csrfHeaders(),
        body: JSON.stringify({ email: _inviteEmailTrimmed || undefined, role: inviteRole }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { showError(data.error || 'Failed to create invite'); return; }
      inviteResult = data;
      // Server reports sent: true only after nodemailer's SMTP handoff resolves
      // — that's the strongest delivery confirmation any app can make without
      // webhooks from the upstream provider. Same wording GitHub / Slack use.
      if (data.sent) showSuccess(`Invite emailed to ${_inviteEmailTrimmed}`);
      inviteEmail  = '';
      await loadPendingInvites();
    } catch {
      showError('Could not create invite');
    } finally {
      // Always release the loading state — was leaking on early-returns
      // (validation fails / non-OK response) so the button stayed stuck on
      // "Creating…" until the user navigated away and back.
      inviteLoading = false;
    }
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
          <input class="input" type="email" autocomplete="email" autocapitalize="off"
            class:invalid={_inviteEmailTrimmed && !_inviteEmailValid}
            bind:value={inviteEmail} placeholder={$_('settings.users.email_optional')} />
          {#if _inviteEmailTrimmed && !_inviteEmailValid}
            <p class="invite-hint">Enter a valid email address, or clear the field to generate a shareable link.</p>
          {/if}
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
          <button class="btn btn-primary" style="width:100%" on:click={createInvite} disabled={!_inviteCanSubmit}>
            {inviteLoading ? $_('settings.users.creating') : (_inviteEmailTrimmed ? $_('settings.users.send_invite') : $_('settings.users.generate_link'))}
          </button>
          {#if pendingInvites.length > 0}
            <div class="pending-invites" transition:slide={{ duration: 160 }}>
              <div class="pending-invites-label">Pending Invites</div>
              {#each pendingInvites as inv (inv.token)}
                <div class="pending-invite-row">
                  <div class="pending-invite-info">
                    <span class="pending-invite-email">{inv.email || 'Link-only (no email)'}</span>
                    <span class="pending-invite-meta">
                      {inv.role === 'admin' ? 'Admin' : 'User'} ·
                      expires {new Date(inv.expires_at).toLocaleDateString()}
                    </span>
                  </div>
                  <button class="btn-icon pending-invite-revoke" on:click={() => revokeInvite(inv.token)}
                    aria-label="Revoke invite" title="Revoke invite">
                    <span class="material-symbols-rounded">close</span>
                  </button>
                </div>
              {/each}
            </div>
          {/if}

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
            <span class="setting-label">Require Strong Passwords</span>
            <div class="setting-desc">Reject weak passwords (zxcvbn score below 3) on top of the standard 8-char + mixed-case + number + symbol rules. Affects new sign-ups, invites, and password changes. Existing passwords aren't re-checked.</div>
          </div>
          <Toggle checked={passwordPolicy === 'strong'} on:change={e => savePasswordPolicy(e.detail ? 'strong' : 'standard')} />
        </div>
        {#if passwordPolicySaved}
          <p class="setting-desc" style="padding:0 16px 8px;color:var(--accent)">Saved.</p>
        {/if}

        <div class="setting-divider"></div>
        <div class="setting-row">
          <div>
            <span class="setting-label">Session Duration</span>
            <div class="setting-desc">How long users stay signed in. Applies to new logins.</div>
          </div>
          <div class="select-wrap" style="width:130px">
            <select class="select sel-sm" bind:value={sessionHours} on:change={saveSessionHours}>
              <option value="0">Never expires</option>
              <option value="8">8 hours</option>
              <option value="24">1 day</option>
              <option value="168">7 days</option>
              <option value="720">30 days</option>
              <option value="2160">90 days</option>
              <option value="8760">1 year</option>
            </select>
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

<!-- Type-username-to-confirm delete-user dialog with cascade preview -->
<Dialog
  bind:open={_delOpen}
  title={_delTarget ? `Delete ${_delTarget.full_name || _delTarget.username}?` : 'Delete user?'}
  message=""
  confirmText={_delLoading ? 'Deleting…' : 'Delete Permanently'}
  cancelText="Cancel"
  dangerous={true}
  manualClose={true}
  confirmDisabled={!_delTarget || _delTyped.trim() !== _delTarget.username || _delLoading}
  on:cancel={_cancelDeleteUser}
  on:confirm={_confirmDeleteUser}>
  {#if _delTarget}
    <p class="del-intro">This will permanently delete the account and everything it owns. This cannot be undone.</p>
    {#if !_delCounts}
      <div class="del-counts-loading">Loading data preview…</div>
    {:else if _delCounts.error}
      <div class="del-error">Couldn't load data preview: {_delCounts.error}</div>
    {:else}
      <ul class="del-counts">
        {#if _delCounts.foods         > 0}<li><strong>{_delCounts.foods.toLocaleString()}</strong> {_delCounts.foods === 1 ? 'food' : 'foods'}</li>{/if}
        {#if _delCounts.meals         > 0}<li><strong>{_delCounts.meals.toLocaleString()}</strong> {_delCounts.meals === 1 ? 'meal' : 'meals'}</li>{/if}
        {#if _delCounts.recipes       > 0}<li><strong>{_delCounts.recipes.toLocaleString()}</strong> {_delCounts.recipes === 1 ? 'recipe' : 'recipes'}</li>{/if}
        {#if _delCounts.diary_days    > 0}<li><strong>{_delCounts.diary_days.toLocaleString()}</strong> diary {_delCounts.diary_days === 1 ? 'day' : 'days'}</li>{/if}
        {#if _delCounts.activities    > 0}<li><strong>{_delCounts.activities.toLocaleString()}</strong> manual {_delCounts.activities === 1 ? 'activity' : 'activities'}</li>{/if}
        {#if _delCounts.workouts      > 0}<li><strong>{_delCounts.workouts.toLocaleString()}</strong> {_delCounts.workouts === 1 ? 'workout' : 'workouts'}</li>{/if}
        {#if _delCounts.wellness_data > 0}<li><strong>{_delCounts.wellness_data.toLocaleString()}</strong> wellness data points</li>{/if}
        {#if !_delCounts.foods && !_delCounts.meals && !_delCounts.recipes && !_delCounts.diary_days && !_delCounts.activities && !_delCounts.workouts && !_delCounts.wellness_data}
          <li class="del-empty">No data attached to this account.</li>
        {/if}
      </ul>
    {/if}
    <label class="del-confirm-label" for="del-confirm-input">
      Type <code>{_delTarget.username}</code> to confirm:
    </label>
    <input id="del-confirm-input" class="input del-confirm-input" type="text"
      autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false"
      bind:value={_delTyped}
      placeholder={_delTarget.username}
      class:matched={_delTyped.trim() === _delTarget.username} />
    {#if _delTyped.trim() !== _delTarget.username}
      <p class="del-hint">Confirm button enables once the username matches exactly.</p>
    {/if}
  {/if}
</Dialog>

<style>
  /* Type-username-to-confirm delete dialog */
  :global(.dialog-box:has(.del-confirm-input)) { max-width: 420px; }
  .del-intro { font-size: 13px; color: var(--text-2); margin: 0 0 10px; line-height: 1.4; }
  .del-counts {
    list-style: none; padding: 10px 12px; margin: 0 0 12px;
    background: var(--surface-2); border-radius: var(--radius-md);
    font-size: 13px; line-height: 1.6;
  }
  .del-counts li { color: var(--text-2); }
  .del-counts li::before { content: '· '; color: var(--text-3); }
  .del-counts li strong { color: var(--text-1); font-weight: 600; }
  .del-empty::before { content: ''; }
  .del-empty { color: var(--text-3); font-style: italic; }
  .del-counts-loading { font-size: 13px; color: var(--text-3); padding: 10px 0; }
  .del-error { font-size: 12px; color: var(--danger); padding: 8px 0; }
  .del-confirm-label { display: block; font-size: 13px; color: var(--text-2); margin: 0 0 6px; }
  .del-confirm-label code {
    font-family: ui-monospace, monospace;
    background: var(--surface-2); padding: 1px 6px; border-radius: 4px;
    font-size: 12px; color: var(--text-1);
  }
  .del-confirm-input { width: 100%; margin-bottom: 8px; font-family: ui-monospace, monospace; }
  .del-confirm-input.matched { border-color: var(--accent); }
  .del-hint { font-size: 11px; color: var(--text-3); margin: 0 0 12px; }

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
  .sel-sm { height: 36px; font-size: 13px; width: auto; max-width: 100%; }

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
  .invite-hint { font-size: 11px; color: var(--danger, #ef4444); margin: -2px 0 4px; line-height: 1.4; }

  .pending-invites {
    display: flex; flex-direction: column; gap: 4px;
    padding: 8px 10px;
    background: var(--surface-2); border-radius: var(--radius-md);
    margin-top: 4px;
  }
  .pending-invites-label {
    font-size: 11px; font-weight: 700; letter-spacing: 0.06em;
    text-transform: uppercase; color: var(--text-3); padding: 4px 2px;
  }
  .pending-invite-row {
    display: flex; align-items: center; gap: 8px;
    padding: 6px 8px; border-radius: var(--radius-sm);
  }
  .pending-invite-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
  .pending-invite-email { font-size: 13px; font-weight: 500; color: var(--text-1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pending-invite-meta  { font-size: 11px; color: var(--text-3); }
  .pending-invite-revoke { padding: 4px; min-width: 0; color: var(--text-3); }
  .pending-invite-revoke:hover { color: var(--danger, #ef4444); }
  :global(.um-form-block .input.invalid) { border-color: var(--danger, #ef4444); }

</style>
