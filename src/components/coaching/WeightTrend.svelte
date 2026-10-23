<script>
  // A client's weigh-ins over the last 90 days: one line, the latest value
  // and the change, with a tooltip on each weigh-in. Values stay in text ink.
  import { _ } from 'svelte-i18n';
  import { formatDay, weightIn } from '../../lib/coaching-view.js';

  export let weights = [];   // [{ date, kg }]
  export let unit = 'kg';
  export let dateFormat = 'US';

  const W = 320, H = 96, PAD = 8;
  let hover = null;

  $: pts = (weights || []).map(w => ({ date: w.date, v: weightIn(w.kg, unit) }));
  $: t0 = pts.length ? Date.parse(pts[0].date) : 0;
  $: t1 = pts.length ? Date.parse(pts.at(-1).date) : 1;
  $: lo = pts.length ? Math.min(...pts.map(p => p.v)) : 0;
  $: hi = pts.length ? Math.max(...pts.map(p => p.v)) : 1;
  $: span = Math.max(hi - lo, 0.5);
  $: xy = pts.map(p => ({
    ...p,
    x: PAD + (t1 > t0 ? (Date.parse(p.date) - t0) / (t1 - t0) : 0.5) * (W - PAD * 2),
    y: PAD + (1 - (p.v - lo) / span) * (H - PAD * 2),
  }));
  $: path = xy.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  $: latest = pts.at(-1);
  $: change = pts.length > 1 ? Math.round((pts.at(-1).v - pts[0].v) * 10) / 10 : null;
</script>

{#if pts.length === 0}
  <p class="wt-empty">{$_('coaching.overview.no_weights')}</p>
{:else}
  <div class="wt-head">
    <span class="wt-value">{latest.v} {unit}</span>
    {#if change != null}
      <span class="wt-change">{$_('coaching.overview.weight_change', { values: { change: (change > 0 ? '+' : '') + change, unit, date: formatDay(pts[0].date, dateFormat) } })}</span>
    {/if}
  </div>
  {#if pts.length > 1}
    <div class="wt-chart">
      <svg viewBox="0 0 {W} {H}" preserveAspectRatio="none" role="img"
        aria-label={$_('coaching.overview.weight_aria', { values: { count: pts.length } })}>
        <path d={path} fill="none" stroke="var(--accent)" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round" />
        {#each xy as p}
          <!-- svelte-ignore a11y-no-static-element-interactions -->
          <rect x={p.x - 6} y="0" width="12" height={H} fill="transparent"
            on:mouseenter={() => hover = p} on:mouseleave={() => hover = null}
            on:touchstart|passive={() => hover = p} />
        {/each}
        {#if hover}
          <line x1={hover.x} x2={hover.x} y1="0" y2={H} stroke="var(--border-strong)" stroke-width="1" vector-effect="non-scaling-stroke" />
        {/if}
      </svg>
      {#if hover}
        <div class="wt-tip" style="left:{(hover.x / W) * 100}%">{formatDay(hover.date, dateFormat)} · {hover.v} {unit}</div>
      {/if}
    </div>
  {/if}
{/if}

<style>
  .wt-empty { color: var(--text-3); font-size: 13px; margin: 0; }
  .wt-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
  .wt-value { font-size: 20px; font-weight: 700; color: var(--text-1); }
  .wt-change { font-size: 13px; color: var(--text-3); }
  .wt-chart { position: relative; margin-top: 8px; }
  .wt-chart svg { display: block; width: 100%; height: 96px; }
  .wt-tip {
    position: absolute; top: -6px; transform: translate(-50%, -100%);
    background: var(--surface-3); color: var(--text-1); font-size: 12px;
    padding: 4px 8px; border-radius: var(--radius-sm); white-space: nowrap; pointer-events: none;
    box-shadow: var(--shadow-sm);
  }
</style>
