<script>
  // Share to OFF with no Open Food Facts login, or a wrong one: ask for it
  // right here, in the food editor, and share once it's saved (#284). The
  // values are the same settings as Settings > Food Sources.
  import { createEventDispatcher } from 'svelte';
  import { _ } from 'svelte-i18n';
  import { offUsername, offPassword } from '../../stores/settings.js';

  const dispatch = createEventDispatcher();
  let user = $offUsername || '';
  let pass = $offPassword || '';
  $: ready = !!user.trim() && !!pass;

  function save() {
    if (!ready) return;
    offUsername.set(user.trim());
    offPassword.set(pass);
    dispatch('saved');
  }
</script>

<!-- A div, not a form: the editor around it may sit inside one. -->
<div class="off-account-inline">
  <p class="off-account-msg">
    <span class="material-symbols-rounded" aria-hidden="true">info</span>
    <span>{$_('food_editor.off_share.need_account')}
      <a href="https://world.openfoodfacts.org/cgi/user.pl" target="_blank" rel="noopener">{$_('settings.connected_services.off.account_create_link')}</a>
    </span>
  </p>
  <input class="input" type="text" autocomplete="username" aria-label={$_('settings.connected_services.off.account_username')}
    placeholder={$_('settings.connected_services.off.username_placeholder')} bind:value={user} />
  <input class="input" type="password" autocomplete="current-password" aria-label={$_('settings.connected_services.off.account_password')}
    placeholder={$_('settings.connected_services.off.password_placeholder')} bind:value={pass}
    on:keydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } }} />
  <button type="button" class="btn btn-primary btn-sm" disabled={!ready} on:click={save}>{$_('food_editor.off_share.save_and_share')}</button>
</div>

<style>
  .off-account-inline {
    display: flex; flex-direction: column; gap: 8px;
    margin-top: 8px; padding: 10px 12px;
    border: 1px solid var(--border); border-radius: 10px;
  }
  .off-account-msg { display: flex; gap: 6px; margin: 0; font-size: 13px; line-height: 1.4; color: var(--text-2); }
  .off-account-msg .material-symbols-rounded { font-size: 16px; }
  .off-account-msg a { color: var(--accent); }
  .off-account-inline button { align-self: flex-start; }
</style>
