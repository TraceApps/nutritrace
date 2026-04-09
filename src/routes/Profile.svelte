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
    if (new_password.length < 8) { showError('Password must be at least 8 characters'); return; }
    if (!/[a-z]/.test(new_password) || !/[A-Z]/.test(new_password) || !/[0-9]/.test(new_password) || !/[^a-zA-Z0-9]/.test(new_password)) {
      showError('Password needs uppercase, lowercase, number, and special character'); return;
    }
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
          <input class="input" type="password" bind:value={new_password} />
        </div>
        <div class="form-group">
          <label class="form-label">Confirm New Password</label>
          <input class="input" type="password" bind:value={new_password2} />
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
</style>
