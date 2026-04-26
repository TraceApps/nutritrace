<script>
  import { onMount } from 'svelte';
  import { pop } from 'svelte-spa-router';
  import { currentUser } from '../stores/auth.js';
  import { NtApi } from '../lib/api.js';
  import { apiUrl, isNative, getServerUrl, getAuthToken, resolveAssetUrl } from '../lib/platform.js';
  import { takePhoto } from '../lib/camera.js';

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
      if (!res.ok) { showError(data.error || 'Save failed'); return; }
      currentUser.set(data.user);
      showSuccess('Profile saved');
    } catch(e) {
      showError('Could not save profile');
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
      } catch { showError('Upload failed'); }
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
      showError('Upload failed');
    } finally {
      uploading = false;
    }
  }

  let changingPassword = false;
  let cur_password = '';
  let new_password = '';
  let new_password2 = '';
  let pwSaving = false;

  async function changePassword() {
    if (new_password !== new_password2) { showError('Passwords do not match'); return; }
    const pwErr = validatePassword(new_password);
    if (pwErr) { showError(pwErr); return; }
    pwSaving = true;
    try {
      const res = await fetch(apiUrl('/api/auth/password'), {
        method: 'PUT',
        credentials: 'include',
        headers: _headers(),
        body: JSON.stringify({ current_password: cur_password, new_password }),
      });
      const data = await res.json();
      if (!res.ok) { showError(data.error || 'Failed'); return; }
      showSuccess('Password changed');
      changingPassword = false;
      cur_password = new_password = new_password2 = '';
    } catch(e) {
      showError('Could not change password');
    } finally {
      pwSaving = false;
    }
  }
</script>

<div class="page-wrap">
  <div class="page-header sticky-header">
    <button class="btn-icon" on:click={pop} title="Back">
      <span class="material-symbols-rounded">arrow_back</span>
    </button>
    <h2 class="page-title">Profile</h2>
    <button class="btn btn-primary" on:click={save} disabled={saving}>
      {saving ? 'Saving…' : 'Save'}
    </button>
  </div>

  <div class="profile-body">
    <!-- Avatar -->
    <div class="avatar-section">
      <button class="avatar-btn" on:click={pickAvatar} disabled={uploading} title="Change photo">
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
      <div class="editor-card-title">Personal Info</div>

      <div class="form-group">
        <label class="form-label">Full Name</label>
        <input class="input" type="text" placeholder="Your full name" bind:value={full_name} />
      </div>
      <div class="form-group">
        <label class="form-label">Email address</label>
        <input class="input" type="email" autocomplete="email"
          placeholder="Used for password resets" bind:value={email} />
      </div>
      <div class="form-group">
        <label class="form-label">Nickname / Display Name</label>
        <input class="input" type="text" placeholder="What should we call you?" bind:value={nickname} />
      </div>
      <div class="form-group">
        <label class="form-label">Birthday</label>
        <input class="input" type="date" bind:value={birthday} />
      </div>
      <div class="form-group">
        <label class="form-label">Gender</label>
        <div class="select-wrap">
          <select class="select" bind:value={gender}>
            <option value="">Prefer not to say</option>
            {#each GENDERS as g}<option value={g}>{g}</option>{/each}
          </select>
        </div>
      </div>
    </div>

    <!-- Change password -->
    <div class="card settings-card">
      <div class="editor-card-title">Security</div>
      {#if !changingPassword}
        <button class="btn btn-ghost w-full" on:click={() => changingPassword = true}>
          Change Password
        </button>
      {:else}
        <div class="form-group">
          <label class="form-label">Current Password</label>
          <input class="input" type="password" bind:value={cur_password} />
        </div>
        <div class="form-group">
          <label class="form-label">New Password</label>
          <input class="input" type="password" bind:value={new_password} placeholder="8+ chars, upper, lower, number, symbol" />
          {#if new_password}
            <div class="pw-strength" class:s-0={pwScore.score === 0} class:s-1={pwScore.score === 1} class:s-2={pwScore.score === 2} class:s-3={pwScore.score === 3} class:s-4={pwScore.score === 4}>
              <div class="pw-bar"><div class="pw-fill" style:width={`${(pwScore.score / 4) * 100}%`}></div></div>
              <span class="pw-label">{pwScore.label}</span>
            </div>
          {/if}
        </div>
        <div class="form-group">
          <label class="form-label">Confirm New Password</label>
          <input class="input" type="password" bind:value={new_password2} />
          {#if new_password2 && new_password !== new_password2}
            <p class="pw-mismatch">Passwords don't match</p>
          {/if}
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-ghost" style="flex:1" on:click={() => { changingPassword = false; cur_password=new_password=new_password2=''; }}>
            Cancel
          </button>
          <button class="btn btn-primary" style="flex:1" on:click={changePassword} disabled={pwSaving}>
            {pwSaving ? 'Saving…' : 'Change Password'}
          </button>
        </div>
      {/if}
    </div>
  </div>
</div>

<style>
  .page-wrap { display: flex; flex-direction: column; height: 100dvh; overflow: hidden; }
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
</style>
