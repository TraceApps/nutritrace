<!--
  FastingInsights.svelte — quick stats card for the Statistics page.

  Pure CSS bars (no Chart.js dependency) so it stays light. Reads from the
  fasting store the same way the Diary widget does, but renders summary
  numbers + a 14-day mini chart of fasting hours.
-->
<script>
  import { onMount } from 'svelte';
  import { slide } from 'svelte/transition';
  import { activeFast, fastHistory, loadFasting, fastingStats, deleteFast } from '../../stores/fasting.js';
  import { confirmDialog } from '../../stores/confirmDialog.js';

  let _showHistory = false;

  onMount(() => { loadFasting(); });

  async function _removeFast(f) {
    const hrs = f.end_at ? ((new Date(f.end_at) - new Date(f.start_at)) / 3600000).toFixed(1) : '?';
    const day = new Date(f.start_at).toLocaleDateString();
    const ok = await confirmDialog({
      title: 'Remove this fast?',
      message: `${hrs}h fast on ${day} will be deleted from your history. This can't be undone.`,
      confirmText: 'Remove',
      dangerous: true,
    });
    if (!ok) return;
    await deleteFast(f.id);
  }

  function _fmtDayLabel(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  function _fmtDuration(start, end) {
    if (!start || !end) return '—';
    const h = (new Date(end) - new Date(start)) / 3600000;
    const wh = Math.floor(h);
    const m = Math.round((h - wh) * 60);
    return `${wh}h ${String(m).padStart(2, '0')}m`;
  }

  // Build the per-day bars from the last 14 days. End-time anchors the day
  // (you're "fasting on the day you broke the fast"). Active fast bar shows
  // current elapsed hours so the latest column reflects what's in progress.
  $: _days = (() => {
    const map = new Map();
    for (const f of $fastHistory) {
      if (!f.end_at) continue;
      const day = f.end_at.slice(0, 10);
      const hrs = (new Date(f.end_at).getTime() - new Date(f.start_at).getTime()) / 3600000;
      map.set(day, Math.max(map.get(day) || 0, hrs));
    }
    if ($activeFast) {
      const today = new Date().toISOString().slice(0, 10);
      const hrs = (Date.now() - new Date($activeFast.start_at).getTime()) / 3600000;
      map.set(today, Math.max(map.get(today) || 0, hrs));
    }
    const out = [];
    const today = new Date();
    for (let i = 13; i >= 0; i--) {
      const d = new Date(today);
      d.setUTCDate(d.getUTCDate() - i);
      const day = d.toISOString().slice(0, 10);
      out.push({ day, label: d.toLocaleDateString(undefined, { weekday: 'narrow' }), hours: map.get(day) || 0 });
    }
    return out;
  })();

  $: _stats = fastingStats($fastHistory, $activeFast);
  $: _maxHours = Math.max(16, ..._days.map(d => d.hours));
</script>

<div class="fasting-insights card">
  <div class="fi-header">
    <span class="material-symbols-rounded fi-icon">restaurant</span>
    <div class="fi-title">Fasting</div>
  </div>

  <div class="fi-stats">
    <div class="fi-stat">
      <div class="fi-stat-value">{_stats.avg_hours || 0}<span class="fi-stat-unit">h</span></div>
      <div class="fi-stat-label">Avg duration</div>
    </div>
    <div class="fi-stat">
      <div class="fi-stat-value">{_stats.longest_hours || 0}<span class="fi-stat-unit">h</span></div>
      <div class="fi-stat-label">Longest</div>
    </div>
    <div class="fi-stat">
      <div class="fi-stat-value">{_stats.current_streak}<span class="fi-stat-unit">d</span></div>
      <div class="fi-stat-label">Current streak</div>
    </div>
    <div class="fi-stat">
      <div class="fi-stat-value">{_stats.longest_streak}<span class="fi-stat-unit">d</span></div>
      <div class="fi-stat-label">Longest streak</div>
    </div>
  </div>

  <div class="fi-chart">
    {#each _days as d}
      <div class="fi-chart-col">
        <div class="fi-chart-bar-wrap">
          <div class="fi-chart-bar" style="height:{(d.hours / _maxHours * 100).toFixed(1)}%"
            title="{d.day} · {d.hours.toFixed(1)}h"></div>
        </div>
        <div class="fi-chart-label">{d.label}</div>
      </div>
    {/each}
  </div>
  <div class="fi-chart-caption">Last 14 days · {_stats.count} fast{_stats.count === 1 ? '' : 's'} logged</div>

  {#if $fastHistory && $fastHistory.length > 0}
    <button class="fi-history-toggle" type="button"
      on:click={() => _showHistory = !_showHistory}
      aria-expanded={_showHistory}>
      <span class="material-symbols-rounded" class:rot={_showHistory}>expand_more</span>
      {_showHistory ? 'Hide' : 'Show'} Recent Fasts
    </button>
    {#if _showHistory}
      <div class="fi-history" transition:slide={{ duration: 180 }}>
        {#each $fastHistory.filter(f => f.end_at).slice(0, 20) as f (f.id)}
          {@const goalMet = (new Date(f.end_at) - new Date(f.start_at)) / 3600000 >= (f.goal_hours || 16)}
          <div class="fi-history-row">
            <div class="fi-history-info">
              <span class="fi-history-day">{_fmtDayLabel(f.start_at)}</span>
              <span class="fi-history-dur">{_fmtDuration(f.start_at, f.end_at)}</span>
              <span class="fi-history-goal" class:met={goalMet}>
                Goal {f.goal_hours}h{goalMet ? ' ✓' : ''}
              </span>
            </div>
            <button class="btn-icon fi-history-del" on:click={() => _removeFast(f)}
              aria-label="Remove this fast" title="Remove this fast">
              <span class="material-symbols-rounded">close</span>
            </button>
          </div>
        {/each}
      </div>
    {/if}
  {/if}
</div>

<style>
  .fasting-insights {
    padding: 14px 16px;
    border-left: 3px solid #8b5cf6;
  }
  .fi-header { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
  .fi-icon { font-size: 22px; color: #8b5cf6; }
  .fi-title { font-size: 15px; font-weight: 600; color: var(--text-1); }

  .fi-stats {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 10px;
    margin-bottom: 16px;
  }
  .fi-stat {
    background: var(--surface-2);
    border-radius: var(--radius-md);
    padding: 10px 8px;
    text-align: center;
  }
  .fi-stat-value { font-size: 20px; font-weight: 700; color: var(--text-1); font-feature-settings: 'tnum'; }
  .fi-stat-unit  { font-size: 12px; font-weight: 500; color: var(--text-3); margin-left: 1px; }
  .fi-stat-label { font-size: 10px; color: var(--text-3); margin-top: 2px; text-transform: uppercase; letter-spacing: 0.04em; }

  .fi-chart {
    display: flex;
    gap: 4px;
    height: 80px;
    align-items: flex-end;
  }
  .fi-chart-col { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 4px; height: 100%; }
  .fi-chart-bar-wrap {
    flex: 1; width: 100%;
    display: flex; align-items: flex-end;
  }
  .fi-chart-bar {
    width: 100%;
    background: #8b5cf6;
    border-radius: 3px 3px 0 0;
    min-height: 2px;
    transition: height 300ms ease;
  }
  .fi-chart-label { font-size: 10px; color: var(--text-3); }

  .fi-chart-caption {
    font-size: 11px; color: var(--text-3); text-align: center; margin-top: 6px;
  }

  .fi-history-toggle {
    margin-top: 12px;
    background: none; border: none; padding: 8px 0;
    color: var(--text-3); font-size: 12px; font-weight: 500;
    cursor: pointer; display: flex; align-items: center; gap: 4px; width: 100%;
  }
  .fi-history-toggle .material-symbols-rounded {
    font-size: 16px; transition: transform 180ms ease;
  }
  .fi-history-toggle .rot { transform: rotate(180deg); }
  .fi-history {
    display: flex; flex-direction: column; gap: 4px;
    margin-top: 4px;
  }
  .fi-history-row {
    display: flex; align-items: center; gap: 8px;
    padding: 8px 10px; border-radius: var(--radius-sm);
    background: var(--surface-2);
  }
  .fi-history-info {
    flex: 1; min-width: 0;
    display: grid; grid-template-columns: 60px 1fr auto; gap: 10px;
    align-items: center; font-size: 13px;
  }
  .fi-history-day { color: var(--text-3); }
  .fi-history-dur { color: var(--text-1); font-weight: 600; font-feature-settings: 'tnum'; }
  .fi-history-goal { font-size: 11px; color: var(--text-3); }
  .fi-history-goal.met { color: #10b981; }
  .fi-history-del { padding: 4px; color: var(--text-3); }
  .fi-history-del:hover { color: var(--danger, #ef4444); }

  @media (max-width: 380px) {
    .fi-stats { grid-template-columns: repeat(2, 1fr); }
  }
</style>
