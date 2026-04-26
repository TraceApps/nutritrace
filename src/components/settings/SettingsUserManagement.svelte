<script>
  import { slide } from 'svelte/transition';
  import Toggle from './Toggle.svelte';
  import { showSuccess, showError } from '../../stores/toast.js';
  import { DB } from '../../lib/db.js';
  import { NtApi } from '../../lib/api.js';
  import { currentUser, userMgmtActive, loadAuthState } from '../../stores/auth.js';
  import { isNative, getServerUrl, resolveAssetUrl, apiUrl, getAuthToken, setAuthToken } from '../../lib/platform.js';
  import { push } from 'svelte-spa-router';

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
  let showDisableUmDialog = false;

  // Enable user management from Settings
  let showEnableUm    = false;
  let enableAdminUser = '';
  let enableAdminPass = '';
  let enableShowPass = false;
  let enableAdminConf = '';
  let enableAdminName = '';
  let enableUmError   = '';
  let enableUmLoading = false;

  // Session duration (admin-only)
  let sessionHours = '720';
  let sessionSaved = false;

  // Invite
  let inviteEmail  = '';
  let inviteRole   = 'user';
  let inviteLoading = false;
  let inviteResult = null; // { inviteUrl, sent }

  export async function loadData() {
    if ($userMgmtActive) {
      await loadUsers();
      if ($currentUser?.role === 'admin') await loadSessionConfig();
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
    if (!enableAdminUser.trim()) { enableUmError = 'Username is required'; return; }
    if (enableAdminPass.length < 6) { enableUmError = 'Password must be at least 6 characters'; return; }
    if (enableAdminPass !== enableAdminConf) { enableUmError = 'Passwords do not match'; return; }
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
      if (!res.ok) { enableUmError = data.error || 'Registration failed'; enableUmLoading = false; return; }
      localStorage.setItem('wl:userId', data.user.id);
      await loadAuthState();
      showEnableUm = false;
      enableAdminUser = ''; enableAdminPass = ''; enableAdminConf = ''; enableAdminName = '';
      await loadUsers();
      showSuccess('User management enabled');
    } catch(e) { enableUmError = 'Could not connect to server'; }
    enableUmLoading = false;
  }

  async function loadUsers() {
    try {
      umUsers = await NtApi.get('/api/auth/users');
    } catch(e) { umError = e.message; }
  }

  async function addUser() {
    umError = '';
    if (!newUsername.trim() || !newPassword.trim()) { umError = 'Username and password required'; return; }
    umLoading = true;
    try {
      const res = await fetch(apiUrl('/api/auth/register'), {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: newUsername.trim(), password: newPassword, full_name: newFullName.trim() || undefined, role: newRole }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { umError = data.error || 'Failed to add user'; } else {
        newUsername = ''; newPassword = ''; newFullName = ''; newRole = 'user';
        showAddUser = false;
        await loadUsers();
        showSuccess('User added');
      }
    } catch(e) { umError = e.message; }
    umLoading = false;
  }

  async function deleteUser(id) {
    try {
      await NtApi.del(`/api/auth/users/${id}`);
      await loadUsers();
      showSuccess('User deleted');
    } catch(e) { showError(e.message); }
  }

  async function disableUserManagement() {
    try {
      await NtApi.del('/api/auth/management');
      localStorage.removeItem('wl:userId');
      await loadAuthState();
      showDisableUmDialog = false;
      showSuccess('User management disabled');
      await loadUsers();
    } catch(e) { showError(e.message); }
  }

  function logoutServer() {
    document.body.style.transition = 'opacity 0.3s';
    document.body.style.opacity = '0';
    localStorage.removeItem('wl:userId');
    localStorage.removeItem('nt:cachedUser');
    localStorage.removeItem('nt:cachedUserMgmt');
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
      <!-- Current user row -->
      <button class="setting-row setting-action" on:click={() => push('/profile')}>
        <span class="material-symbols-rounded si" style="color:var(--accent)">manage_accounts</span>
        <div>
          <span class="setting-label">My Profile</span>
          <div class="setting-desc">{$currentUser?.nickname || $currentUser?.full_name || $currentUser?.username || ''}</div>
        </div>
        <span class="material-symbols-rounded text-3" style="font-size:18px">chevron_right</span>
      </button>
      <div class="setting-divider"></div>

      <!-- User list (admin only) -->
      {#if $currentUser?.role === 'admin'}
        <div class="setting-row" style="flex-direction:column;align-items:flex-start;gap:8px;padding:12px 16px">
          <div style="display:flex;justify-content:space-between;align-items:center;width:100%">
            <span class="setting-label">Users</span>
            <button class="btn btn-secondary" style="height:30px;font-size:12px;padding:0 10px"
              on:click={() => { showAddUser = !showAddUser; umError = ''; }}>
              {showAddUser ? 'Cancel' : '+ Add User'}
            </button>
          </div>

          {#if showAddUser}
            <div class="um-add-form" transition:slide={{ duration: 160 }}>
              <div class="um-form-row">
                <input class="input" type="text" bind:value={newUsername} placeholder="Username *" autocomplete="off" />
                <div style="display:flex;gap:4px;align-items:center;flex:1">
                  {#if newShowPass}
                    <input class="input" style="flex:1" type="text" bind:value={newPassword} placeholder="Password *" autocomplete="new-password" />
                  {:else}
                    <input class="input" style="flex:1" type="password" bind:value={newPassword} placeholder="Password *" autocomplete="new-password" />
                  {/if}
                  <button class="btn-icon" on:click={() => newShowPass = !newShowPass} style="flex-shrink:0">
                    <span class="material-symbols-rounded" style="font-size:18px">{newShowPass ? 'visibility_off' : 'visibility'}</span>
                  </button>
                </div>
              </div>
              <div class="um-form-row">
                <input class="input" type="text" bind:value={newFullName} placeholder="Full name (optional)" />
                <select class="input" bind:value={newRole}>
                  <option value="user">User</option>
                  <option value="admin">Admin</option>
                </select>
              </div>
              {#if umError}<p class="um-error">{umError}</p>{/if}
              <button class="btn btn-primary" style="width:100%" on:click={addUser} disabled={umLoading}>
                {umLoading ? 'Adding...' : 'Create User'}
              </button>
            </div>
          {/if}

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
                  <div class="um-user-sub">@{u.username}{u.role === 'admin' ? ' · admin' : ''}</div>
                </div>
                {#if u.id !== $currentUser?.id}
                  <button class="btn btn-ghost um-del-btn" title="Delete user"
                    on:click={() => deleteUser(u.id)}>
                    <span class="material-symbols-rounded" style="font-size:18px;color:var(--danger)">person_remove</span>
                  </button>
                {/if}
              </div>
            {/each}
          </div>
        </div>
        <div class="setting-divider"></div>

        <!-- Invite user -->
        <div class="setting-row" style="flex-direction:column;align-items:flex-start;gap:8px;padding:12px 16px">
          <span class="setting-label">Invite user</span>
          <div class="um-form-row">
            <input class="input" type="email" bind:value={inviteEmail} placeholder="Email (optional)" />
            <select class="input" bind:value={inviteRole}>
              <option value="user">User</option>
              <option value="admin">Admin</option>
            </select>
          </div>
          <button class="btn btn-secondary" style="width:100%" on:click={createInvite} disabled={inviteLoading}>
            {inviteLoading ? 'Creating…' : 'Generate invite link'}
          </button>
          {#if inviteResult}
            <div class="invite-result" transition:slide={{ duration: 160 }}>
              {#if inviteResult.sent}
                <span class="material-symbols-rounded" style="color:var(--accent);font-size:18px">mark_email_read</span>
                <span style="font-size:13px">Invite sent to <strong>{inviteEmail || 'user'}</strong></span>
              {:else}
                <span style="font-size:13px;color:var(--text-2)">Share this link:</span>
                <div class="invite-link-row">
                  <input class="input" style="flex:1;font-size:12px" readonly value={inviteResult.inviteUrl} />
                  <button class="btn btn-secondary" style="height:36px;padding:0 12px;font-size:12px"
                    on:click={() => { navigator.clipboard?.writeText(inviteResult.inviteUrl); showSuccess('Copied!'); }}>
                    Copy
                  </button>
                </div>
              {/if}
            </div>
          {/if}
        </div>

        <div class="setting-divider"></div>
        <div class="setting-row">
          <div>
            <span class="setting-label">Session duration</span>
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
        <button class="setting-row setting-action danger" on:click={() => showDisableUmDialog = true}>
          <span class="material-symbols-rounded si" style="color:var(--danger)">no_accounts</span>
          <div>
            <span class="setting-label" style="color:var(--danger)">Disable user management</span>
            <div class="setting-desc">Removes all user accounts and returns to single-user mode</div>
          </div>
        </button>
      {/if}

      <div class="setting-divider"></div>
      <button class="setting-row setting-action" on:click={logoutServer}>
        <span class="material-symbols-rounded si" style="color:var(--text-3)">logout</span>
        <span class="setting-label">Sign out</span>
      </button>
    {:else}
      <button class="setting-row setting-action" on:click={() => { showEnableUm = !showEnableUm; enableUmError = ''; }}>
        <span class="material-symbols-rounded si" style="color:var(--accent)">group_add</span>
        <div>
          <span class="setting-label">Enable user management</span>
          <div class="setting-desc">Add multiple user accounts with separate data &amp; settings</div>
        </div>
        <span class="material-symbols-rounded text-3" style="font-size:18px">{showEnableUm ? 'expand_less' : 'expand_more'}</span>
      </button>

      {#if showEnableUm}
        <div class="section-body" style="padding:0 16px 16px" transition:slide={{ duration: 160 }}>
          <p class="um-section-label" style="margin-bottom:8px">Create admin account</p>
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

<!-- Disable user management dialog -->
{#if showDisableUmDialog}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div class="dialog-overlay" on:click|self={() => showDisableUmDialog = false}>
    <div class="dialog-box">
      <h3 class="dialog-title">Disable user management</h3>
      <p class="dialog-msg">This will remove all user accounts and their data cannot be recovered. The app will return to single-user mode.</p>
      <div class="dialog-actions">
        <button class="btn btn-ghost" on:click={() => showDisableUmDialog = false}>Cancel</button>
        <button class="btn btn-danger" on:click={disableUserManagement}>Disable &amp; delete all users</button>
      </div>
    </div>
  </div>
{/if}

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

  /* Inline dialog (for disable user management) */
  .dialog-overlay {
    position: fixed; inset: 0; z-index: 500;
    background: rgba(0,0,0,0.5);
    display: flex; align-items: center; justify-content: center;
    padding: 24px;
  }
  .dialog-box {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 24px;
    max-width: 380px;
    width: 100%;
  }
  .dialog-title { font-size: 17px; font-weight: 600; margin: 0 0 8px; color: var(--text-1); }
  .dialog-msg   { font-size: 13px; color: var(--text-3); margin: 0 0 20px; line-height: 1.5; }
  .dialog-actions { display: flex; gap: 10px; justify-content: flex-end; }
  .btn-danger { background: var(--danger, #ef4444); color: #fff; border: none; border-radius: var(--radius-md); padding: 8px 16px; font-size: 13px; font-weight: 600; cursor: pointer; }
</style>
