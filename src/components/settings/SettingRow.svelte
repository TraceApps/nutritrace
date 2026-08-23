<script>
  /**
   * Shared settings row primitive. Every sub-page currently
   * hand-writes the same <div class="setting-row"><div><span
   * class="setting-label">…</span><div class="setting-desc">…</div>
   * </div>…control…</div> markup. Extracting it here means one
   * place to tweak density, one place to add responsive tweaks,
   * one place to add automated tests.
   *
   * Usage:
   *   <SettingRow label="Show Brands" desc="Show the brand name below the food name">
   *     <Toggle bind:checked={$diaryShowBrands} />
   *   </SettingRow>
   *
   * The optional `divider` prop (default true) prepends the standard
   * hairline setting-divider so rows can be dropped one after
   * another inside a .card without extra bookkeeping. Set to false
   * on the FIRST row inside a card (no divider needed above it) or
   * when you want to lay rows out yourself.
   */
  export let label   = '';
  export let desc    = '';
  export let divider = true;
</script>

{#if divider}<div class="setting-divider"></div>{/if}
<div class="setting-row">
  <div class="sr-copy">
    <span class="setting-label">{label}</span>
    {#if desc}<div class="setting-desc">{desc}</div>{/if}
  </div>
  <div class="sr-control">
    <slot />
  </div>
</div>

<style>
  .sr-copy {
    min-width: 0;
    flex: 1;
  }
  .sr-control {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
  }
</style>
