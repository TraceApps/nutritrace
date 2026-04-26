<script>
  import { createEventDispatcher } from 'svelte';
  export let checked = false;
  export let disabled = false;
  const dispatch = createEventDispatcher();

  function toggle() {
    if (disabled) return;
    checked = !checked;
    dispatch('change', checked);
  }
</script>

<button
  class="toggle"
  class:checked
  class:disabled
  role="switch"
  aria-checked={checked}
  aria-disabled={disabled}
  on:click={toggle}
  type="button"
>
  <span class="thumb"></span>
</button>

<style>
  .toggle {
    position: relative;
    width: 48px;
    height: 28px;
    border-radius: var(--radius-full);
    background: var(--surface-3);
    border: 1px solid var(--border-strong);
    cursor: pointer;
    transition: background var(--dur-base) var(--ease-out),
                border-color var(--dur-base) var(--ease-out),
                box-shadow var(--dur-base) var(--ease-out);
    flex-shrink: 0;
    padding: 0;
  }
  .toggle.checked {
    background: linear-gradient(90deg, var(--accent), var(--accent-2));
    border-color: transparent;
    box-shadow: 0 0 0 3px var(--accent-dim);
  }
  .thumb {
    position: absolute;
    top: 3px;
    left: 3px;
    width: 20px;
    height: 20px;
    border-radius: var(--radius-full);
    background: var(--text-3);
    transition: transform var(--dur-base) var(--ease-spring),
                background var(--dur-base) var(--ease-out);
    box-shadow: var(--shadow-sm);
  }
  .checked .thumb {
    transform: translateX(20px);
    background: var(--accent-text);
  }
  .disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
</style>
