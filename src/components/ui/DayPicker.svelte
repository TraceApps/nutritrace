<!--
  DayPicker (#267, #283): which diary day something goes to. Three quick
  chips (Yesterday, Today, Tomorrow) and the date field with its calendar.
  The chips and the field are one value: picking a date that is one of
  those days lights its chip, any other date lights none.

  Used wherever a day is chosen for diary items: the Copy sheet, Move (one
  item or a selection) and Add to Diary on the Foods page, so it looks and
  works the same everywhere.

  Props:
    value (bindable): the day as 'YYYY-MM-DD'
    disabled: while the action is running
-->
<script>
  import { onMount } from 'svelte';
  import { _ } from 'svelte-i18n';
  import DateInput from './DateInput.svelte';
  import { todayIso, shiftDay } from '../../lib/day-label.js';

  export let value = '';
  export let disabled = false;

  // Read when the picker opens (it is created with its sheet), and again on
  // focus, so a sheet left open past midnight still means the right days.
  let today = todayIso();
  onMount(() => {
    const refresh = () => { today = todayIso(); };
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  });

  $: chips = [
    { day: shiftDay(today, -1), label: $_('diary.day_complete.status.yesterday') },
    { day: today,               label: $_('diary.day_complete.status.today') },
    { day: shiftDay(today, 1),  label: $_('diary.day_picker.tomorrow') },
  ];
</script>

<div class="day-picker" role="group" aria-label={$_('diary.day_picker.label')}>
  <div class="dp-chips">
    {#each chips as c (c.day)}
      <button type="button" class="dp-chip" class:on={value === c.day} aria-pressed={value === c.day}
        {disabled} on:click={() => value = c.day}>{c.label}</button>
    {/each}
  </div>
  <div class="dp-date">
    <DateInput bind:value pickerLayer={130} ariaLabel={$_('diary.day_picker.date')} />
  </div>
</div>

<style>
  .day-picker {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }
  .dp-chips {
    display: flex;
    flex: 1 1 260px;
    gap: 4px;
    padding: 3px;
    border-radius: var(--radius-full);
    background: var(--surface-2);
    border: 1px solid var(--border);
  }
  .dp-chip {
    flex: 1 1 0;
    min-width: 0;
    min-height: 36px;
    padding: 6px 10px;
    border: 1px solid transparent;
    border-radius: var(--radius-full);
    background: transparent;
    color: var(--text-2);
    font-size: 14px;
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    cursor: pointer;
    transition: background var(--dur-fast), color var(--dur-fast);
  }
  .dp-chip:hover:not(:disabled):not(.on) { color: var(--text-1); background: var(--surface-3); }
  .dp-chip.on {
    background: var(--accent-dim);
    border-color: var(--accent);
    color: var(--accent);
  }
  .dp-chip:disabled { opacity: 0.5; cursor: default; }
  .dp-chip:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .dp-date { flex: 1 1 180px; min-width: 0; }
</style>
