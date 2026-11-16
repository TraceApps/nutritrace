<script>
  import { _, locale } from 'svelte-i18n';
  import { tr } from '../../lib/i18n-label.js';
  import { DB } from '../../lib/db.js';
  import Toggle from '../../components/settings/Toggle.svelte';
  import { bodyStatsOrder, hiddenBodyStats } from '../../stores/settings.js';

  const BODY_STATS = [
    { id:'weight', label:'Weight' }, { id:'neck', label:'Neck' }, { id:'waist', label:'Waist' },
    { id:'hips', label:'Hips' }, { id:'chest', label:'Chest' }, { id:'thighs', label:'Thighs' },
    { id:'biceps', label:'Biceps' }, { id:'calves', label:'Calves' },
    { id:'body_fat', label:'Body Fat %' }, { id:'body_water', label:'Body Water %' },
  ];

  $: orderedBodyStats = (() => {
    const order = $bodyStatsOrder || [];
    if (!order.length) return BODY_STATS;
    const map = new Map(BODY_STATS.map(s => [s.id, s]));
    const sorted = order.map(id => map.get(id)).filter(Boolean);
    const rest   = BODY_STATS.filter(s => !order.includes(s.id));
    return [...sorted, ...rest];
  })();

  function isStatVisible(id) {
    const hidden = $hiddenBodyStats || [];
    return !hidden.includes(id);
  }
  function toggleStatVisible(id) {
    const hidden = DB.getSetting('hiddenBodyStats', []);
    if (hidden.includes(id)) {
      hiddenBodyStats.set(hidden.filter(h => h !== id));
    } else {
      hiddenBodyStats.set([...hidden, id]);
    }
  }

  // Drag-to-reorder for body stats
  let statDragFrom = null, statDragOver = null, statDragDelta = 0, statRowHeights = [];
  function onStatDragDown(e, i) {
    const list = e.currentTarget.closest('.drag-list');
    const rows = [...list.querySelectorAll('.drag-row')];
    statRowHeights = rows.map(r => r.getBoundingClientRect().height);
    statDragFrom = i; statDragOver = i; statDragDelta = 0;
    list.setPointerCapture(e.pointerId);
    list._dragStartY = e.clientY;
  }
  function onStatDragMove(e) {
    if (statDragFrom === null) return;
    statDragDelta = e.clientY - e.currentTarget._dragStartY;
    const rows = [...e.currentTarget.querySelectorAll('.drag-row')];
    const y = e.clientY;
    let best = statDragOver;
    for (let idx = 0; idx < rows.length; idx++) {
      if (idx === statDragFrom) continue;
      const r = rows[idx].getBoundingClientRect();
      if (y >= r.top && y <= r.bottom) { best = idx; break; }
    }
    statDragOver = best;
  }
  function onStatDragUp() {
    if (statDragFrom !== null && statDragOver !== null && statDragFrom !== statDragOver) {
      const order = ($bodyStatsOrder && $bodyStatsOrder.length)
        ? [...$bodyStatsOrder] : orderedBodyStats.map(s => s.id);
      const [removed] = order.splice(statDragFrom, 1);
      order.splice(statDragOver, 0, removed);
      bodyStatsOrder.set(order);
    }
    statDragFrom = null; statDragOver = null; statDragDelta = 0; statRowHeights = [];
  }

  // Compute translateY for a non-dragging row given current drag state.
  // Duplicated per extracted section — the shared helper lives in the
  // parent shell but each extracted file owns its own drag state.
  function dragShift(i, from, over, heights) {
    if (from === null || over === null || i === from || from === over) return 0;
    const h = heights[from] || 52;
    if (from < over && i > from && i <= over) return -h;
    if (from > over && i >= over && i < from) return h;
    return 0;
  }
</script>

<div class="section-body">
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div class="card settings-card drag-list"
    on:pointermove={onStatDragMove}
    on:pointerup={onStatDragUp}
    on:pointercancel={onStatDragUp}>
    {#each orderedBodyStats as stat, i}
      {#if i > 0}<div class="setting-divider"></div>{/if}
      <div class="setting-row drag-row"
        class:dragging={statDragFrom === i}
        class:drag-target={statDragFrom !== null && statDragFrom !== i && statDragOver === i}
        style={statDragFrom !== null
          ? statDragFrom === i
            ? `transform:scale(1.04) translateY(${statDragDelta}px);transition:box-shadow 200ms ease,opacity 200ms ease`
            : `transform:translateY(${dragShift(i,statDragFrom,statDragOver,statRowHeights)}px)`
          : ''}>
        <!-- svelte-ignore a11y-no-static-element-interactions -->
        <span class="drag-handle material-symbols-rounded" on:pointerdown={e => onStatDragDown(e, i)}>drag_indicator</span>
        <span class="setting-label">{tr('body_metrics', stat.id, stat.label, $locale)}</span>
        <Toggle checked={isStatVisible(stat.id)} on:change={() => toggleStatVisible(stat.id)} />
      </div>
    {/each}
  </div>
</div>
