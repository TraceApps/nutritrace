<!--
  PasswordStrengthMeter — debounced zxcvbn strength bar with feedback.

  Props:
    password    string — current password value
    userInputs  string[] — extra strings to bias against (username, email, name)
    minScore    0..4 — server policy threshold; renders a "below required strength"
                  hint if the score is below minScore. Default 0 (informational only).

  Lazy-loads zxcvbn dictionaries the first time it sees a non-empty password,
  so the bundle hit only happens when a user actually starts typing a password.
-->
<script>
  import { estimate, STRENGTH_LABELS, STRENGTH_COLORS } from '../../lib/password-strength.js';

  export let password = '';
  export let userInputs = [];
  export let minScore = 0;

  let _result = null;
  let _debounceTimer = null;

  $: _evaluate(password, userInputs);

  function _evaluate(pw, inputs) {
    clearTimeout(_debounceTimer);
    if (!pw) { _result = null; return; }
    // Debounce ~120ms so we don't run zxcvbn on every keystroke.
    _debounceTimer = setTimeout(async () => {
      const captured = pw;
      const r = await estimate(pw, inputs);
      // Discard stale results from older keystrokes
      if (captured === password) _result = r;
    }, 120);
  }

  $: _score    = _result?.score ?? 0;
  $: _label    = password ? STRENGTH_LABELS[_score] : '';
  $: _color    = STRENGTH_COLORS[_score];
  $: _belowMin = password && _score < minScore;
  $: _warning  = _result?.feedback?.warning || '';
  $: _suggest  = _result?.feedback?.suggestions || [];
</script>

{#if password}
  <div class="strength-wrap">
    <div class="strength-track" aria-hidden="true">
      {#each Array(4) as _, i}
        <div class="strength-bar" style="background:{i < _score ? _color : 'var(--surface-2)'}"></div>
      {/each}
    </div>
    <div class="strength-row">
      <span class="strength-label" style="color:{_color}">{_label}</span>
      {#if _belowMin}
        <span class="strength-min">· below required strength</span>
      {/if}
    </div>
    {#if _warning || _suggest.length > 0}
      <div class="strength-feedback">
        {#if _warning}<div class="strength-warn">{_warning}</div>{/if}
        {#each _suggest as s}<div class="strength-tip">{s}</div>{/each}
      </div>
    {/if}
  </div>
{/if}

<style>
  .strength-wrap { margin-top: 6px; display: flex; flex-direction: column; gap: 4px; }
  .strength-track { display: flex; gap: 3px; height: 4px; }
  .strength-bar { flex: 1; border-radius: 2px; transition: background 200ms ease; }
  .strength-row { display: flex; align-items: center; gap: 6px; font-size: 11px; }
  .strength-label { font-weight: 600; }
  .strength-min { color: var(--danger, #ef4444); font-size: 11px; }
  .strength-feedback { font-size: 11px; color: var(--text-3); line-height: 1.4; }
  .strength-warn { color: var(--text-2); }
  .strength-tip::before { content: '· '; }
</style>
