<script>
  /**
   * Diary → week strip (Phase 6 desktop redesign).
   *
   * Renders the last 7 days as a compact row of clickable columns below
   * the date bar. Each column shows day-of-week, kcal total, and a mini
   * fill bar coloured by goal-hit ratio. Today's column is highlighted;
   * click any day to swap the visible diary via loadEntry. Hover a
   * past day for a snapshot popover (macros + water).
   *
   * Data path: one bulk NtApi.getAllDiary() call at mount, cached in a
   * Map keyed by date. Refetches when the parent's `refreshKey` prop
   * changes (i.e. after the user logs food and the diary store fires).
   *
   * Only rendered by Diary.svelte inside its ≥1280px right-of-datebar
   * slot — component itself doesn't gate on viewport size (parent does).
   */
  import { onMount } from 'svelte';
  import { fade } from 'svelte/transition';
  import { NtApi } from '../../lib/api.js';
  import { localDateStr } from '../../lib/db.js';
  import { Nutrition } from '../../lib/nutrition.js';
  import { disableAnimations, dateFormat } from '../../stores/settings.js';

  // Mirrors Diary.svelte's formatDateSub — respects the user's
  // Settings → Regional → Date Format preference (ISO / US / EU /
  // natural). Kept inline here because there's no shared date-format
  // helper in src/lib/ yet; if a third consumer shows up, extract.
  function _formatIsoForUser(iso, fmt) {
    if (!iso) return '';
    const dt = new Date(iso + 'T12:00:00');
    fmt = fmt || 'ISO';
    if (fmt === 'US') {
      const m  = String(dt.getMonth() + 1).padStart(2, '0');
      const dy = String(dt.getDate()).padStart(2, '0');
      return `${m}/${dy}/${dt.getFullYear()}`;
    }
    if (fmt === 'EU') {
      const m  = String(dt.getMonth() + 1).padStart(2, '0');
      const dy = String(dt.getDate()).padStart(2, '0');
      return `${dy}/${m}/${dt.getFullYear()}`;
    }
    if (fmt === 'natural') {
      return dt.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
    }
    return iso;   // ISO / fallback
  }

  export let currentDate     = localDateStr();
  export let calorieGoal     = 2000;               // base goal (fixed / adaptive result). Per-day dynamic + activity overrides layer on top.
  export let refreshKey      = 0;                  // bump to force reload from parent
  export let calorieGoalMode = 'fixed';            // 'fixed' | 'dynamic' | 'adaptive' — dynamic triggers per-day calories-out fetch
  export let calorieGoalFactor = 1;                // dynamic-mode multiplier applied to each day's calories_out
  export let adjustFromActivity = false;           // when true, add each day's own activity kcal to that day's goal (#180)
  export let activityPolicy  = 'wearable_wins';    // manual/wearable combination policy for per-day effective active kcal
  export let onSelectDate    = (_iso) => {};
  export let onDropMeal      = (_iso, _mealIdx) => {};   // Phase 7 drag-copy

  // Drag/drop state — highlight the day currently being hovered
  let dragOverIso = null;
  function _isMealDrag(e) {
    return e.dataTransfer?.types?.includes?.('application/x-nt-meal-idx');
  }
  function _onDayDragOver(e, iso) {
    if (!_isMealDrag(e) || iso === currentDate) return;   // block same-day self-drop
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    dragOverIso = iso;
  }
  function _onDayDragLeave(iso) {
    if (dragOverIso === iso) dragOverIso = null;
  }
  function _onDayDrop(e, iso) {
    if (!_isMealDrag(e)) return;
    e.preventDefault();
    const raw = e.dataTransfer.getData('application/x-nt-meal-idx');
    const mealIdx = parseInt(raw, 10);
    dragOverIso = null;
    if (Number.isFinite(mealIdx) && iso !== currentDate) {
      onDropMeal(iso, mealIdx);
    }
  }

  // Full weekday names — desktop has plenty of room. If a narrower
  // rail size is ever added, swap this to a short/abbreviated set.
  const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  let byDate = new Map();      // iso → { kcal, protein, carbs, fat, water_ml, items }
  let goalByDate = new Map();  // iso → per-day resolved calorie goal (base + dynamic + activity per day)
  let activeByDate = new Map();// iso → per-day effective active kcal (for popover)
  let loading = true;
  let hoveredIso = null;

  // Return the 7 iso dates of the calendar week containing anchorIso
  // (Sunday through Saturday). Extracted from the previous inline logic
  // because both the strip derivation AND _loadWeekAdjustments need it.
  function _weekIsos(anchorIso) {
    const anchor = anchorIso ? new Date(anchorIso + 'T12:00:00') : new Date();
    const sunday = new Date(anchor);
    sunday.setDate(anchor.getDate() - anchor.getDay());
    const out = [];
    for (let i = 0; i < 7; i++) {
      const dt = new Date(sunday);
      dt.setDate(sunday.getDate() + i);
      out.push(localDateStr(dt));
    }
    return out;
  }

  // Build the 7-day array — the CALENDAR WEEK containing the
  // currently-viewed date (Sunday through Saturday). Previously
  // this was always "last 6 days + today" which made the strip
  // stuck on the current real-world week even when the user
  // navigated back to a diary from weeks ago — disorienting
  // because the strip is supposed to anchor 'where am I in time'
  // relative to the diary I'm viewing, not to real-life today.
  $: today = localDateStr();
  $: strip = (() => {
    const isos = _weekIsos(currentDate);
    const out = [];
    for (const iso of isos) {
      const dt = new Date(iso + 'T12:00:00');
      const stats = byDate.get(iso);
      const kcal = stats?.kcal ?? 0;
      // Per-day goal: prefer the resolved goalByDate value (accounts
      // for dynamic TDEE + per-day activity adjustment). Falls back
      // to the base calorieGoal prop while adjustments are still in
      // flight, on any failed fetch, or when no adjustments apply.
      // #180: was previously the caller's adjusted goal, so every
      // day's bar shifted whenever the current day's activity did.
      const goal = goalByDate.get(iso) ?? calorieGoal;
      const pct = goal > 0 ? Math.min(100, Math.round((kcal / goal) * 100)) : 0;
      const active = activeByDate.get(iso) ?? 0;
      out.push({
        iso,
        dow: DOW[dt.getDay()],
        dnum: dt.getDate(),
        kcal,
        goal,
        pct,
        active,
        hasData: !!stats && kcal > 0,
        isToday: iso === today,
        isSelected: iso === currentDate,
        // Future dates carry no meaningful goal-hit color — grey
        // them out and skip the fill bar rendering downstream via
        // status === 'future' in the button markup.
        isFuture: iso > today,
        // Goal-hit status colour for the dot:
        //  - green:  ±10% of goal (on-track)
        //  - amber:  <90% (under-eaten)
        //  - red:    >110% (over-eaten)
        //  - grey:   no data
        status: iso > today ? 'future'
              : !stats || kcal === 0 ? 'none'
              : kcal > goal * 1.10 ? 'over'
              : kcal < goal * 0.90 ? 'under'
              : 'on',
        stats,
      });
    }
    return out;
  })();

  async function loadWeek() {
    loading = true;
    try {
      const all = await NtApi.getAllDiary().catch(() => []);
      // Previously filtered to a fixed 7-days-back cutoff, which
      // silently returned zeros when the strip anchored on any
      // historical week. Load every entry into the map now —
      // getAllDiary returns the same payload regardless, so this
      // is a cheaper filter (memory only) that lets any week the
      // user navigates to render with real numbers.
      const map = new Map();
      for (const entry of all || []) {
        if (!entry?.date) continue;
        const items = entry.items || [];
        const nutrArr = items.map(it => Nutrition.calculate(it));
        const totals = Nutrition.sum(nutrArr);
        const water = entry.water || [];
        const water_ml = water.reduce((s, l) => s + (Number(l.amount) || 0), 0);
        map.set(entry.date, {
          kcal: Math.round(totals.calories || 0),
          protein: Math.round(totals.proteins || 0),
          carbs: Math.round(totals.carbohydrates || 0),
          fat: Math.round(totals.fat || 0),
          water_ml,
          item_count: items.length,
        });
      }
      byDate = map;
    } finally {
      loading = false;
    }
  }

  // #180 — resolve per-day goals for the currently visible week.
  //
  // Two independent adjustments can layer onto the base goal:
  //   (a) dynamic-mode: goal for each day comes from that day's own
  //       calories_out reading (Fitbit / Health Connect / etc.) times
  //       the user's factor, not from a single scalar. Without this,
  //       navigating to a day with different TDEE shifts every bar.
  //   (b) adjustFromActivity: each day's own effective active kcal
  //       (manual + wearable, policy-resolved) tops up that day's
  //       goal. Without this, logging activity on today shifted the
  //       denominator for every visible day.
  //
  // Fetches run in parallel across the 7 dates; any per-day failure
  // silently falls back to the base calorieGoal for that day (the
  // strip derivation reads goalByDate.get(iso) ?? calorieGoal).
  // Adjustments are stored in local Maps, not merged into byDate,
  // so a subsequent refreshKey-driven loadWeek() doesn't wipe them.
  let _adjustmentsSeq = 0;
  async function _loadWeekAdjustments() {
    const needActive  = !!adjustFromActivity;
    const needDynamic = calorieGoalMode === 'dynamic';
    if (!needActive && !needDynamic) {
      goalByDate = new Map();
      activeByDate = new Map();
      return;
    }
    const mySeq = ++_adjustmentsSeq;
    const dates = _weekIsos(currentDate);
    let activitySums = dates.map(() => ({ effective: 0 }));
    let dynamicOuts  = dates.map(() => ({ calories_out: null }));
    try {
      const [as, dos] = await Promise.all([
        needActive
          ? Promise.all(dates.map(d => NtApi.getActivitySum(d, activityPolicy).catch(() => ({ effective: 0 }))))
          : Promise.resolve(activitySums),
        needDynamic
          ? Promise.all(dates.map(d => NtApi.get(`/api/wellness/calories-out?date=${d}`).catch(() => ({ calories_out: null }))))
          : Promise.resolve(dynamicOuts),
      ]);
      activitySums = as;
      dynamicOuts  = dos;
    } catch { /* swallow — every entry already has a safe default */ }
    // Late-arriving results from a previous week are ignored so a slow
    // fetch from the prior visible week can't clobber the newer one.
    if (mySeq !== _adjustmentsSeq) return;
    const newGoal = new Map();
    const newActive = new Map();
    for (let i = 0; i < dates.length; i++) {
      const iso = dates[i];
      const active = Math.max(0, Number(activitySums[i]?.effective) || 0);
      newActive.set(iso, active);
      let base = calorieGoal;
      if (needDynamic && dynamicOuts[i]?.calories_out != null) {
        base = Math.round(Number(dynamicOuts[i].calories_out) * (Number(calorieGoalFactor) || 1));
      }
      newGoal.set(iso, base + (needActive ? active : 0));
    }
    goalByDate = newGoal;
    activeByDate = newActive;
  }

  onMount(loadWeek);
  // Refresh whenever the parent bumps refreshKey (after a food log etc.)
  $: if (refreshKey >= 0) { /* reactive trigger */ loadWeek(); }
  // Re-resolve per-day goals when the visible week shifts, when the
  // parent bumps refreshKey (activity + food edits), or when any of
  // the mode / policy / toggle props change upstream. Cheap when
  // neither adjustment is active — the function early-returns.
  $: currentDate, refreshKey, adjustFromActivity, activityPolicy, calorieGoalMode, calorieGoalFactor, calorieGoal, _loadWeekAdjustments();
</script>

<nav class="week-strip" aria-label="Week strip">
  {#each strip as day (day.iso)}
    <button
      class="ws-day"
      class:selected={day.isSelected}
      class:today={day.isToday}
      class:no-data={!day.hasData}
      class:is-future={day.isFuture}
      class:drag-over={dragOverIso === day.iso}
      on:click={() => onSelectDate(day.iso)}
      on:mouseenter={() => hoveredIso = day.iso}
      on:mouseleave={() => { if (hoveredIso === day.iso) hoveredIso = null; }}
      on:dragover={(e) => _onDayDragOver(e, day.iso)}
      on:dragleave={() => _onDayDragLeave(day.iso)}
      on:drop={(e) => _onDayDrop(e, day.iso)}
      title="Switch diary to {day.iso}"
    >
      <span class="ws-dow">{day.dow}</span>
      <span class="ws-dnum">{day.dnum}</span>
      <span class="ws-kcal">
        {#if day.hasData}{day.kcal.toLocaleString()}{:else}—{/if}
      </span>
      <span class="ws-bar-track">
        <span
          class="ws-bar-fill ws-status-{day.status}"
          style="width:{day.pct}%"
        ></span>
      </span>

      {#if hoveredIso === day.iso && day.stats}
        <div class="ws-popover" transition:fade|local={{ duration: $disableAnimations ? 0 : 120 }}>
          <div class="ws-pop-date">{_formatIsoForUser(day.iso, $dateFormat)}</div>
          <div class="ws-pop-kcal">
            <span class="ws-pop-num">{day.stats.kcal.toLocaleString()}</span>
            <span class="ws-pop-unit">kcal</span>
          </div>
          <div class="ws-pop-macros">
            <span class="ws-pop-macro p">{day.stats.protein}g P</span>
            <span class="ws-pop-macro c">{day.stats.carbs}g C</span>
            <span class="ws-pop-macro f">{day.stats.fat}g F</span>
          </div>
          {#if day.stats.water_ml > 0}
            <div class="ws-pop-water">💧 {(day.stats.water_ml / 1000).toFixed(2)} L</div>
          {/if}
          <div class="ws-pop-items">{day.stats.item_count} food{day.stats.item_count === 1 ? '' : 's'} logged</div>
        </div>
      {/if}
    </button>
  {/each}
</nav>

<style>
  .week-strip {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    gap: 4px;
    padding: 8px var(--page-px, 16px);
    background: var(--surface-1);
    border-bottom: 1px solid var(--border);
  }
  .ws-day {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    padding: 6px 4px;
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--radius-md);
    cursor: pointer;
    transition: background 140ms ease, border-color 140ms ease;
    color: var(--text-2);
    font-family: inherit;
  }
  .ws-day:hover {
    background: var(--surface-2);
  }
  .ws-day.selected {
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 12%, transparent);
    color: var(--text-1);
  }
  .ws-day.today .ws-dnum {
    color: var(--accent);
    font-weight: 800;
  }
  .ws-day.no-data { opacity: 0.6; }

  /* Drag-over highlight while a meal card is dragged from Diary */
  .ws-day.drag-over {
    background: color-mix(in srgb, var(--accent) 22%, transparent);
    border-color: var(--accent);
    outline: 2px dashed var(--accent);
    outline-offset: -2px;
    transform: translateY(-1px);
    transition: transform 100ms ease-out, background 100ms ease, border-color 100ms ease;
  }

  .ws-dow {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--text-3);
    white-space: nowrap;
  }
  .ws-dnum {
    font-size: 14px;
    font-weight: 700;
    line-height: 1;
    letter-spacing: -0.02em;
    color: var(--text-1);
  }
  .ws-kcal {
    font-size: 10px;
    color: var(--text-3);
    font-variant-numeric: tabular-nums;
    letter-spacing: -0.01em;
    min-height: 12px;
  }
  .ws-bar-track {
    display: block;
    width: 100%;
    height: 3px;
    background: var(--surface-3);
    border-radius: 999px;
    overflow: hidden;
    margin-top: 2px;
  }
  .ws-bar-fill {
    display: block;
    height: 100%;
    background: var(--text-3);
    border-radius: 999px;
    transition: width 260ms cubic-bezier(0.34, 1.2, 0.64, 1);
  }
  .ws-bar-fill.ws-status-on    { background: #34c47d; }
  .ws-bar-fill.ws-status-under { background: #e5b03e; }
  .ws-bar-fill.ws-status-over  { background: #e05a6e; }
  .ws-bar-fill.ws-status-none   { background: transparent; }
  .ws-bar-fill.ws-status-future { background: transparent; }
  .ws-day.is-future { opacity: 0.45; }

  /* Hover preview */
  .ws-popover {
    position: absolute;
    top: calc(100% + 6px);
    left: 50%;
    transform: translateX(-50%);
    z-index: 20;
    min-width: 160px;
    padding: 10px 12px;
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    box-shadow: 0 10px 30px -8px rgba(0,0,0,0.35);
    display: flex;
    flex-direction: column;
    gap: 4px;
    text-align: left;
    pointer-events: none;
    cursor: default;
  }
  .ws-pop-date {
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-3);
  }
  .ws-pop-kcal { display: flex; align-items: baseline; gap: 4px; }
  .ws-pop-num {
    font-size: 20px;
    font-weight: 700;
    letter-spacing: -0.02em;
    color: var(--text-1);
    font-variant-numeric: tabular-nums;
  }
  .ws-pop-unit { font-size: 11px; color: var(--text-3); }
  .ws-pop-macros {
    display: flex;
    gap: 8px;
    font-size: 11px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .ws-pop-macro.p { color: var(--macro-protein); }
  .ws-pop-macro.c { color: var(--macro-carbs); }
  .ws-pop-macro.f { color: var(--macro-fat); }
  .ws-pop-water { font-size: 11px; color: var(--water-blue, #2196F3); }
  .ws-pop-items { font-size: 10px; color: var(--text-3); margin-top: 2px; }
</style>
