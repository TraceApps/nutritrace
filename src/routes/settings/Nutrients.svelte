<script>
  import { _ } from 'svelte-i18n';
  import Toggle from '../../components/settings/Toggle.svelte';
  import Sheet from '../../components/ui/Sheet.svelte';
  import { DB } from '../../lib/db.js';
  import { NUTRIMENTS } from '../../lib/nutrition.js';
  import {
    visibleNutriments, nutrimentsOrder, customNutriments,
  } from '../../stores/settings.js';

  // ── Custom nutrients ─────────────────────────────────────────────────────
  let showNutrientSheet = false;
  let newNutrient = { id: '', label: '', unit: 'g' };

  function addCustomNutrient() {
    if (!newNutrient.label.trim()) return;
    const id = 'custom_' + newNutrient.label.toLowerCase().replace(/\s+/g,'_');
    const existing = DB.getSetting('customNutriments', []);
    if (!existing.find(n => n.id === id)) {
      customNutriments.set([...existing, { ...newNutrient, id }]);
    }
    newNutrient = { id:'', label:'', unit:'g' };
    showNutrientSheet = false;
  }
  function removeCustomNutrient(id) {
    const existing = DB.getSetting('customNutriments', []);
    customNutriments.set(existing.filter(n => n.id !== id));
  }

  // ── Nutrient ordering ───────────────────────────────────────────────────
  $: orderedNutriments = (() => {
    const order = $nutrimentsOrder || [];
    if (!order.length) return NUTRIMENTS;
    const map = new Map(NUTRIMENTS.map(n => [n.id, n]));
    const sorted = order.map(id => map.get(id)).filter(Boolean);
    const rest   = NUTRIMENTS.filter(n => !order.includes(n.id));
    return [...sorted, ...rest];
  })();

  // Drag-to-reorder for nutrients
  let nutDragFrom = null, nutDragOver = null, nutDragDelta = 0, nutRowHeights = [];
  function onNutDragDown(e, i) {
    const list = e.currentTarget.closest('.drag-list');
    const rows = [...list.querySelectorAll('.drag-row')];
    nutRowHeights = rows.map(r => r.getBoundingClientRect().height);
    nutDragFrom = i; nutDragOver = i; nutDragDelta = 0;
    list.setPointerCapture(e.pointerId);
    list._dragStartY = e.clientY;
  }
  function onNutDragMove(e) {
    if (nutDragFrom === null) return;
    nutDragDelta = e.clientY - e.currentTarget._dragStartY;
    const rows = [...e.currentTarget.querySelectorAll('.drag-row')];
    const y = e.clientY;
    let best = nutDragOver;
    for (let idx = 0; idx < rows.length; idx++) {
      if (idx === nutDragFrom) continue;
      const r = rows[idx].getBoundingClientRect();
      if (y >= r.top && y <= r.bottom) { best = idx; break; }
    }
    nutDragOver = best;
  }
  function onNutDragUp() {
    if (nutDragFrom !== null && nutDragOver !== null && nutDragFrom !== nutDragOver) {
      const order = ($nutrimentsOrder && $nutrimentsOrder.length)
        ? [...$nutrimentsOrder] : orderedNutriments.map(n => n.id);
      const [removed] = order.splice(nutDragFrom, 1);
      order.splice(nutDragOver, 0, removed);
      nutrimentsOrder.set(order);
    }
    nutDragFrom = null; nutDragOver = null; nutDragDelta = 0; nutRowHeights = [];
  }

  // ── Nutrient visibility ─────────────────────────────────────────────────
  function toggleNutrientVisible(id) {
    let vis = DB.getSetting('visibleNutriments', null);
    if (!vis) vis = NUTRIMENTS.filter(n => n.default).map(n => n.id);
    if (vis.includes(id)) {
      visibleNutriments.set(vis.filter(v => v !== id));
    } else {
      visibleNutriments.set([...vis, id]);
    }
  }
  function isNutrientVisible(id) {
    const vis = $visibleNutriments;
    if (!vis) return NUTRIMENTS.find(n => n.id === id)?.default ?? false;
    return vis.includes(id);
  }

  function dragShift(i, from, over, heights) {
    if (from === null || over === null || i === from || from === over) return 0;
    const h = heights[from] || 52;
    if (from < over && i > from && i <= over) return -h;
    if (from > over && i >= over && i < from) return h;
    return 0;
  }
</script>

<div class="section-body">

  <!-- Group: Visible Nutrients -->
  <p class="settings-group-heading">Visible Nutrients</p>
  <p class="settings-group-sub">Drag to reorder. Toggle off any nutrient you don't want shown in the diary and food editor.</p>
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div class="card settings-card drag-list"
    on:pointermove={onNutDragMove}
    on:pointerup={onNutDragUp}
    on:pointercancel={onNutDragUp}>
    {#each orderedNutriments as n, i}
      {#if i > 0}<div class="setting-divider"></div>{/if}
      <div class="setting-row drag-row"
        class:dragging={nutDragFrom === i}
        class:drag-target={nutDragFrom !== null && nutDragFrom !== i && nutDragOver === i}
        style={nutDragFrom !== null
          ? nutDragFrom === i
            ? `transform:scale(1.04) translateY(${nutDragDelta}px);transition:box-shadow 200ms ease,opacity 200ms ease`
            : `transform:translateY(${dragShift(i,nutDragFrom,nutDragOver,nutRowHeights)}px)`
          : ''}>
        <!-- svelte-ignore a11y-no-static-element-interactions -->
        <span class="drag-handle material-symbols-rounded" on:pointerdown={e => onNutDragDown(e, i)}>drag_indicator</span>
        <span class="setting-label">{n.label} <span class="text-3 text-sm">({n.unit})</span></span>
        <Toggle checked={isNutrientVisible(n.id)} on:change={() => toggleNutrientVisible(n.id)} />
      </div>
    {/each}
  </div>

  <!-- Group: Custom Nutrients -->
  <p class="settings-group-heading">{$_('settings_stats.custom_nutrients')}</p>
  <p class="settings-group-sub">Track nutrients not covered by the built-in list (e.g. Omega-3).</p>
  <div class="card settings-card">
    {#each ($customNutriments || []) as cn, i}
      {#if i > 0}<div class="setting-divider"></div>{/if}
      <div class="setting-row">
        <span class="setting-label">{cn.label} ({cn.unit})</span>
        <button class="btn-icon" style="width:32px;height:32px;color:var(--danger)"
          on:click={() => removeCustomNutrient(cn.id)} title="Remove nutrient">
          <span class="material-symbols-rounded" style="font-size:18px">delete</span>
        </button>
      </div>
    {/each}
    {#if ($customNutriments || []).length === 0}
      <div class="setting-row"><span class="text-3 text-sm">{$_('settings_stats.no_custom_nutrients')}</span></div>
      <div class="setting-divider"></div>
    {/if}
    <div style="padding:8px 16px 14px">
      <button class="btn btn-secondary" style="height:36px;font-size:13px"
        on:click={() => showNutrientSheet = true}>
        <span class="material-symbols-rounded" style="font-size:18px">add</span>
        Add custom nutrient
      </button>
    </div>
  </div>
</div>

<!-- Custom nutrient sheet -->
<Sheet bind:open={showNutrientSheet} title="Add Custom Nutrient">
  <div style="display:flex;flex-direction:column;gap:16px;padding-top:8px">
    <div class="form-group">
      <label class="form-label" for="cn-label">{$_('settings_custom_nutrient.name')}</label>
      <input id="cn-label" class="input" placeholder="e.g. Omega-3" bind:value={newNutrient.label} />
    </div>
    <div class="form-group">
      <label class="form-label" for="cn-unit">Unit</label>
      <div class="select-wrap">
        <select id="cn-unit" class="select" bind:value={newNutrient.unit}>
          <option value="g">g</option>
          <option value="mg">mg</option>
          <option value="mcg">mcg</option>
          <option value="IU">IU</option>
          <option value="kcal">kcal</option>
          <option value="kJ">kJ</option>
          <option value="%">%</option>
        </select>
      </div>
    </div>
    <button class="btn btn-primary w-full" on:click={addCustomNutrient}>{$_('settings_custom_nutrient.add')}</button>
  </div>
</Sheet>
