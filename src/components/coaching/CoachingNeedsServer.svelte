<script>
  // Android with no server: coaching happens between two accounts on one
  // server, so say that, with the way to connect one, never an empty screen.
  import { _ } from 'svelte-i18n';
  import { push } from 'svelte-spa-router';
</script>

<div class="needs-server">
  <span class="material-symbols-rounded" aria-hidden="true">cloud_off</span>
  <h2>{$_('coaching.needs_server.title')}</h2>
  <p>{$_('coaching.needs_server.body')}</p>
  <button class="btn btn-primary" on:click={() => push('/settings/serverConnection')}>{$_('coaching.needs_server.connect')}</button>
</div>

<style>
  .needs-server { text-align: center; padding: 40px 16px; max-width: 420px; margin: 0 auto; }
  .needs-server .material-symbols-rounded { font-size: 44px; color: var(--text-3); }
  .needs-server h2 { font-size: 18px; margin: 12px 0 6px; }
  .needs-server p { color: var(--text-3); margin: 0 0 18px; line-height: 1.45; }
</style>
