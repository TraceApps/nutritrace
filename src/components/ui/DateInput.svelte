<!--
  DateInput — text input + calendar trigger button. Click the button to open
  the in-app DatePicker calendar in a sheet. Type directly to enter the date
  in the user's chosen format (YYYY-MM-DD, MM/DD/YYYY, or DD/MM/YYYY).

  Props:
    value (bindable) — selected date as 'YYYY-MM-DD'
    min              — earliest selectable date as 'YYYY-MM-DD' (optional)
    max              — latest selectable date as 'YYYY-MM-DD' (optional)
    placeholder      — input placeholder; defaults to format hint
-->
<script>
  import Sheet from './Sheet.svelte';
  import DatePicker from './DatePicker.svelte';
  import { dateFormat } from '../../stores/settings.js';

  export let value = '';
  export let min = '';
  export let max = '';
  export let placeholder = '';

  let showPicker = false;

  // Local text-input state mirrors `value` formatted for the user's locale.
  let textValue = '';
  $: textValue = _formatForDisplay(value);

  function _formatForDisplay(v) {
    if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return '';
    const fmt = $dateFormat || 'ISO';
    const [y, m, d] = v.split('-');
    if (fmt === 'US') return `${m}/${d}/${y}`;
    if (fmt === 'EU') return `${d}/${m}/${y}`;
    return v;
  }

  function _parseManual(s) {
    if (!s || !s.trim()) return '';
    const t = s.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
    if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(t)) {
      const fmt = $dateFormat || 'ISO';
      const parts = t.split('/');
      const y = parts[2];
      const [m, d] = fmt === 'EU' ? [parts[1], parts[0]] : [parts[0], parts[1]];
      return `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;
    }
    return null;
  }

  function applyText() {
    const iso = _parseManual(textValue);
    if (iso === '') {
      // User cleared the field — clear the underlying value
      value = '';
      return;
    }
    if (iso && (!max || iso <= max) && (!min || iso >= min)) {
      value = iso;
    } else {
      // Invalid or out of range — revert to current value's formatted view
      textValue = _formatForDisplay(value);
    }
  }

  function _placeholder() {
    if (placeholder) return placeholder;
    return $dateFormat === 'US' ? 'MM/DD/YYYY' : $dateFormat === 'EU' ? 'DD/MM/YYYY' : 'YYYY-MM-DD';
  }

  function onPickerSelect(e) {
    value = e.detail;
    showPicker = false;
  }

  // Masked input — strip non-digits, auto-insert separators at the right
  // positions for the user's chosen date format. Lets users type freely
  // (or paste) without being able to enter junk like letters or symbols.
  function onTextInput(e) {
    const fmt = $dateFormat || 'ISO';
    const raw = e.target.value.replace(/[^\d]/g, '').slice(0, 8);
    let formatted;
    if (fmt === 'ISO') {
      // YYYY-MM-DD
      formatted = raw.slice(0, 4);
      if (raw.length > 4) formatted += '-' + raw.slice(4, 6);
      if (raw.length > 6) formatted += '-' + raw.slice(6, 8);
    } else {
      // MM/DD/YYYY or DD/MM/YYYY
      formatted = raw.slice(0, 2);
      if (raw.length > 2) formatted += '/' + raw.slice(2, 4);
      if (raw.length > 4) formatted += '/' + raw.slice(4, 8);
    }
    textValue = formatted;
  }
</script>

<div class="date-input-wrap">
  <input class="input date-input-text" type="text"
    inputmode="numeric"
    bind:value={textValue}
    placeholder={_placeholder()}
    on:input={onTextInput}
    on:blur={applyText}
    on:keydown={e => { if (e.key === 'Enter') { e.preventDefault(); applyText(); e.target.blur(); } }} />
  <button type="button" class="btn-icon date-input-calendar"
    on:click={() => showPicker = true}
    aria-label="Open calendar">
    <span class="material-symbols-rounded">calendar_month</span>
  </button>
</div>

{#if showPicker}
  <Sheet bind:open={showPicker} title="Pick a date">
    <div class="date-input-sheet-body">
      <DatePicker bind:value {min} {max} on:select={onPickerSelect} />
    </div>
  </Sheet>
{/if}

<style>
  .date-input-wrap {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .date-input-text {
    flex: 1;
    min-width: 0;
  }
  .date-input-calendar {
    flex-shrink: 0;
    color: var(--accent);
  }
  .date-input-calendar:hover { background: var(--accent-dim); }
  .date-input-sheet-body {
    /* Sheet provides its own padding; constrain calendar width inside it */
    max-width: 360px;
    margin: 0 auto;
  }
</style>
