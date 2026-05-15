<!--
  FastingWidget.svelte — Diary's top-of-page intermittent-fasting tracker.

  States:
    - Idle      — no active fast. Last-fast hint + preset/custom picker + Start.
    - Active    — running fast with elapsed + progress + target end. Tap the
                  start time to edit (forgot to start on time).
    - Reached   — same layout as Active with green styling.

  Custom presets: user can save up to 3 named custom goal hours via the
  Custom mode's "Save as preset" action. Saved presets appear as chips and
  long-press deletes them.

  Mounted only when settings.fastingEnabled is true (parent gates).
-->
<script>
  import { onMount } from 'svelte';
  import { slide } from 'svelte/transition';
  import { activeFast, fastHistory, elapsedMs, loadFasting, startFast, endFast, checkScheduleAndStart } from '../../stores/fasting.js';
  import { onDestroy } from 'svelte';
  import { fastingDefaultHours, fastingNotifyOnGoal, fastingCustomPresets, dateFormat } from '../../stores/settings.js';
  import { NtApi } from '../../lib/api.js';
  import { showSuccess, showError } from '../../stores/toast.js';
  import { confirmDialog } from '../../stores/confirmDialog.js';
  import DateInput from '../ui/DateInput.svelte';
  import TimePicker from '../ui/TimePicker.svelte';

  const BUILTIN_PRESETS = [
    { label: '14:10', hours: 14 },
    { label: '16:8',  hours: 16 },
    { label: '18:6',  hours: 18 },
    { label: '20:4',  hours: 20 },
    { label: 'OMAD',  hours: 23 },
  ];

  let _selectedHours = 16;
  let _showCustom = false;
  let _customHours = '';
  let _customName = '';

  let _editingStart = false;
  let _editStartDate = ''; // YYYY-MM-DD (DateInput)
  let _editStartTime = ''; // HH:MM (TimePicker, 24h)
  // Today's ISO date used to cap the DateInput so you can't pick a future day.
  $: _todayIso = (() => { const d = new Date(); const pad = n => String(n).padStart(2,'0'); return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; })();

  $: _selectedHours = $fastingDefaultHours || 16;

  onMount(async () => {
    await loadFasting();
    // Recurring schedule — fire on Diary mount + on tab return
    await checkScheduleAndStart();
    const onVis = () => { if (document.visibilityState === 'visible') checkScheduleAndStart(); };
    document.addEventListener('visibilitychange', onVis);
    onDestroy(() => document.removeEventListener('visibilitychange', onVis));
  });

  $: _active = $activeFast;
  $: _goalMs    = _active ? (_active.goal_hours || 16) * 3600 * 1000 : 0;
  $: _progress  = _active ? Math.min(1, $elapsedMs / _goalMs) : 0;
  $: _reached   = _active && $elapsedMs >= _goalMs;
  $: _targetEnd = _active ? new Date(new Date(_active.start_at).getTime() + _goalMs) : null;
  $: _startedAt = _active ? new Date(_active.start_at) : null;

  // Last completed fast — drives the "Last fast: 14h 23m, 2h ago" hint on idle.
  $: _lastFast = (() => {
    const completed = ($fastHistory || []).filter(f => f.end_at);
    if (!completed.length) return null;
    completed.sort((a, b) => new Date(b.end_at) - new Date(a.end_at));
    return completed[0];
  })();
  $: _lastFastDuration = _lastFast
    ? ((new Date(_lastFast.end_at) - new Date(_lastFast.start_at)) / 3600000)
    : 0;
  $: _lastFastAgo = _lastFast ? _fmtAgo(Date.now() - new Date(_lastFast.end_at).getTime()) : '';

  // Goal-reached push fires once per fast.
  let _notifiedFor = null;
  $: if (_reached && _active && _notifiedFor !== _active.id && $fastingNotifyOnGoal) {
    _notifiedFor = _active.id;
    _fireReachedNotification();
  }
  async function _fireReachedNotification() {
    try {
      const { notify } = await import('../../lib/notifications.js');
      const hours = ((_active.goal_hours) || 16).toFixed(1);
      await notify('fastingNotifyOnGoal', 'Fast goal reached', `You've hit your ${hours}h fast goal.`, 5);
    } catch {}
  }

  function _fmtElapsed(ms) {
    if (ms <= 0) return '0h 0m';
    const totalMin = Math.floor(ms / 60000);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return `${h}h ${m}m`;
  }

  function _fmtTime(d) {
    if (!d) return '';
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  // Format a date for the active-fast meta line. Disambiguates when the
  // target end (or back-dated start) is on a different calendar day —
  // overnight 16:8 fasts started in the evening end the next day, and just
  // showing "Target 12:59 PM" is ambiguous about which day.
  //   Same day      → "12:59 PM"
  //   Yesterday     → "Yesterday 8:30 PM"
  //   Tomorrow      → "Tomorrow 12:59 PM"
  //   Further out   → "May 14, 12:59 PM"  (date format honors user's setting)
  function _fmtDateTime(d) {
    if (!d) return '';
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const target = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const diffDays = Math.round((target - today) / 86400000);
    const time = _fmtTime(d);
    if (diffDays === 0) return time;
    if (diffDays === 1) return `Tomorrow ${time}`;
    if (diffDays === -1) return `Yesterday ${time}`;
    // Beyond ±1 day, render the date in the user's chosen format.
    const fmt = $dateFormat || 'natural';
    const m  = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const y  = d.getFullYear();
    let datePart;
    if (fmt === 'US')   datePart = `${m}/${day}/${y}`;
    else if (fmt === 'EU')  datePart = `${day}/${m}/${y}`;
    else if (fmt === 'ISO') datePart = `${y}-${m}-${day}`;
    else datePart = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    return `${datePart}, ${time}`;
  }

  function _fmtAgo(ms) {
    const min = Math.floor(ms / 60000);
    if (min < 60) return min <= 1 ? 'just now' : `${min}m ago`;
    const h = Math.floor(min / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    return d === 1 ? 'yesterday' : `${d}d ago`;
  }

  async function _onStart() {
    const hrs = _showCustom ? Number(_customHours) : _selectedHours;
    if (!Number.isFinite(hrs) || hrs <= 0) {
      showError('Enter a goal between 1 and 168 hours.');
      return;
    }
    fastingDefaultHours.set(hrs);
    await startFast(hrs);
    _showCustom = false;
    _customName = '';
  }

  async function _onEnd() {
    const ok = await confirmDialog({
      title: 'End your fast?',
      message: `You've been fasting for ${_fmtElapsed($elapsedMs)}.`,
      confirmText: 'End Fast',
    });
    if (!ok) return;
    await endFast();
  }

  function _saveCustomPreset() {
    const hrs = Number(_customHours);
    if (!Number.isFinite(hrs) || hrs <= 0 || hrs > 168) {
      showError('Enter a valid goal between 1 and 168 hours.');
      return;
    }
    const name = (_customName || `${hrs}h`).trim().slice(0, 20);
    const next = [...($fastingCustomPresets || []), { name, hours: hrs }].slice(-3);
    fastingCustomPresets.set(next);
    _customName = '';
    showSuccess(`Saved "${name}" as a preset`);
  }

  async function _removeCustomPreset(idx) {
    const next = ($fastingCustomPresets || []).filter((_, i) => i !== idx);
    fastingCustomPresets.set(next);
  }

  function _openEditStart() {
    if (!_active) return;
    const d = new Date(_active.start_at);
    const pad = n => String(n).padStart(2, '0');
    _editStartDate = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    _editStartTime = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    _editingStart = true;
  }

  async function _saveEditStart() {
    if (!_active || !_editStartDate || !_editStartTime) return;
    // Compose a local Date from the date + time strings then send as ISO UTC.
    const [yy, mm, dd] = _editStartDate.split('-').map(n => parseInt(n));
    const [hh, mi]     = _editStartTime.split(':').map(n => parseInt(n));
    const newStart = new Date(yy, mm - 1, dd, hh, mi, 0, 0);
    if (isNaN(newStart.getTime())) { showError('Invalid date/time'); return; }
    if (newStart.getTime() > Date.now()) { showError('Start time can\'t be in the future'); return; }
    if (newStart.getTime() < Date.now() - 7 * 24 * 3600 * 1000) {
      showError('Start time too far in the past (max 7 days ago)'); return;
    }
    try {
      await NtApi.patch(`/api/fasts/${_active.id}`, { start_at: newStart.toISOString() });
      await loadFasting();
      _editingStart = false;
      showSuccess('Start time updated');
    } catch (e) { showError(e?.message || 'Could not update'); }
  }
</script>

<div class="fasting-card" class:active={_active} class:reached={_reached}>
  {#if !_active}
    <!-- Idle state -->
    <div class="fast-idle">
      <span class="material-symbols-rounded fast-icon">restaurant</span>
      <div class="fast-idle-main">
        <div class="fast-idle-title">Start Fasting</div>
        {#if _lastFast}
          <div class="fast-last-hint">
            Last fast: <strong>{_lastFastDuration.toFixed(1)}h</strong> · ended {_lastFastAgo}
          </div>
        {/if}
        <div class="fast-idle-presets">
          {#each BUILTIN_PRESETS as p}
            <button class="fast-preset" class:active={!_showCustom && _selectedHours === p.hours}
              on:click={() => { _showCustom = false; _selectedHours = p.hours; }}>
              {p.label}
            </button>
          {/each}
          {#each ($fastingCustomPresets || []) as p, i}
            <button class="fast-preset custom-preset"
              class:active={!_showCustom && _selectedHours === p.hours}
              on:click={() => { _showCustom = false; _selectedHours = p.hours; }}
              on:contextmenu|preventDefault={async () => {
                if (await confirmDialog({ title: `Remove "${p.name}"?`, confirmText: 'Remove', dangerous: true })) {
                  _removeCustomPreset(i);
                }
              }}
              title="Long-press to remove">
              {p.name}
            </button>
          {/each}
          <button class="fast-preset" class:active={_showCustom}
            on:click={() => { _showCustom = true; if (!_customHours) _customHours = String(_selectedHours); }}>
            Custom
          </button>
        </div>
        {#if _showCustom}
          <div class="fast-custom" transition:slide={{ duration: 140 }}>
            <input class="input" type="number" min="1" max="168" step="0.5" bind:value={_customHours}
              placeholder="Hours" />
            <span class="fast-custom-suffix">hours</span>
            {#if ($fastingCustomPresets || []).length < 3}
              <input class="input fast-custom-name" type="text" maxlength="20"
                placeholder="Name (optional)" bind:value={_customName} />
              <button class="btn-icon fast-custom-save" on:click={_saveCustomPreset}
                title="Save as preset" aria-label="Save as preset">
                <span class="material-symbols-rounded">bookmark_add</span>
              </button>
            {/if}
          </div>
        {/if}
      </div>
      <button class="btn btn-primary fast-start-btn" on:click={_onStart}>Start</button>
    </div>
  {:else}
    <!-- Active / Reached state -->
    <div class="fast-active">
      <div class="fast-active-row">
        <span class="material-symbols-rounded fast-icon">{_reached ? 'check_circle' : 'timer'}</span>
        <div class="fast-active-main">
          <div class="fast-active-title">
            {_reached ? 'Goal Reached' : 'Fasting'} · <strong>{_fmtElapsed($elapsedMs)}</strong>
          </div>
          <div class="fast-active-meta">
            <button class="fast-edit-start" on:click={_openEditStart}
              title="Edit start time" aria-label="Edit start time">
              Started: {_fmtDateTime(_startedAt)}
              <span class="material-symbols-rounded">edit</span>
            </button>
            · Goal: {_active.goal_hours}h · Target: {_fmtDateTime(_targetEnd)}
          </div>
        </div>
        <button class="btn btn-secondary fast-end-btn" on:click={_onEnd}>End Fast</button>
      </div>
      <div class="fast-progress-track">
        <div class="fast-progress-fill" style="width:{(_progress * 100).toFixed(2)}%"></div>
      </div>
      {#if _editingStart}
        <div class="fast-edit-row" transition:slide={{ duration: 140 }}>
          <div class="fast-edit-fields">
            <DateInput bind:value={_editStartDate} max={_todayIso} />
            <TimePicker bind:value={_editStartTime} />
          </div>
          <div class="fast-edit-actions">
            <button class="btn btn-secondary" on:click={() => _editingStart = false}>Cancel</button>
            <button class="btn btn-primary" on:click={_saveEditStart}>Save</button>
          </div>
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .fasting-card {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    border-left: 3px solid #8b5cf6;
    padding: 12px 14px;
    margin: 0 var(--page-px) 12px;
  }
  .fasting-card.active   { border-left-color: #f59e0b; }
  .fasting-card.reached  { border-left-color: #10b981; }

  .fast-idle { display: flex; align-items: center; gap: 12px; }
  .fast-icon { font-size: 28px; color: var(--accent); flex-shrink: 0; }
  .fasting-card.active   .fast-icon { color: #f59e0b; }
  .fasting-card.reached  .fast-icon { color: #10b981; }
  .fast-idle-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
  .fast-idle-title { font-size: 14px; font-weight: 600; color: var(--text-1); }
  .fast-last-hint { font-size: 11px; color: var(--text-3); }
  .fast-last-hint strong { color: var(--text-2); font-feature-settings: 'tnum'; }

  .fast-idle-presets { display: flex; gap: 4px; flex-wrap: wrap; }
  .fast-preset {
    padding: 4px 10px; font-size: 12px; font-weight: 500;
    background: var(--surface-2); border: 1px solid var(--border);
    border-radius: 99px; color: var(--text-2); cursor: pointer;
  }
  .fast-preset.active {
    background: color-mix(in srgb, #8b5cf6 18%, transparent);
    border-color: #8b5cf6; color: #8b5cf6; font-weight: 600;
  }
  .custom-preset { font-style: italic; }
  .custom-preset.active { font-style: normal; }

  .fast-custom { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .fast-custom .input { width: 90px; height: 32px; font-size: 13px; }
  .fast-custom-name { width: 130px !important; }
  .fast-custom-suffix { font-size: 12px; color: var(--text-3); }
  .fast-custom-save { padding: 4px; color: var(--accent); }
  .fast-start-btn { height: 36px; padding: 0 16px; font-size: 13px; flex-shrink: 0; }

  .fast-active { display: flex; flex-direction: column; gap: 10px; }
  .fast-active-row { display: flex; align-items: center; gap: 12px; }
  .fast-active-main { flex: 1; min-width: 0; }
  .fast-active-title { font-size: 14px; color: var(--text-1); }
  .fast-active-title strong { color: var(--text-1); font-feature-settings: 'tnum'; }
  .fast-active-meta { font-size: 12px; color: var(--text-3); margin-top: 2px; display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
  .fast-edit-start {
    background: none; border: none; padding: 0; cursor: pointer;
    color: var(--text-3); font-size: 12px;
    display: inline-flex; align-items: center; gap: 2px;
    text-decoration: underline; text-decoration-style: dotted; text-underline-offset: 2px;
  }
  .fast-edit-start:hover { color: var(--accent); }
  .fast-edit-start .material-symbols-rounded { font-size: 12px; }

  .fast-edit-row {
    display: flex; flex-direction: column; gap: 8px;
    padding: 8px 0;
  }
  .fast-edit-fields { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .fast-edit-actions { display: flex; gap: 6px; justify-content: flex-end; }
  .fast-edit-row .btn { height: 36px; font-size: 12px; padding: 0 14px; }

  .fast-end-btn { height: 32px; padding: 0 12px; font-size: 12px; flex-shrink: 0; }

  .fast-progress-track {
    height: 6px; background: var(--surface-2); border-radius: 3px; overflow: hidden;
  }
  .fast-progress-fill {
    height: 100%;
    background: linear-gradient(90deg, #f59e0b, #f59e0b);
    transition: width 800ms linear;
  }
  .fasting-card.reached .fast-progress-fill { background: #10b981; }
</style>
