<script>
  // Why signing in won't stick, shown on the login page and the setup wizard.
  // reason: 'http' (plain-HTTP page, HTTPS-only cookie) or 'dropped' (signed
  // in, but the browser did not keep the cookie for another reason).
  import { _ } from 'svelte-i18n';
  import { COOKIE_HELP_URLS } from '../../lib/cookie-check.js';
  export let reason = 'http';
</script>

<div class="cookie-warning" role="alert">
  <span class="material-symbols-rounded cw-icon" aria-hidden="true">warning</span>
  <div class="cw-text">
    <p class="cw-title">{$_(`login.cookie_warning.${reason}_title`)}</p>
    <p>{$_(`login.cookie_warning.${reason}_body`)}</p>
    <a href={COOKIE_HELP_URLS[reason] || COOKIE_HELP_URLS.http} target="_blank" rel="noopener noreferrer">{$_('login.cookie_warning.fix_link')}</a>
  </div>
</div>

<style>
  .cookie-warning {
    display: flex;
    gap: 10px;
    align-items: flex-start;
    padding: 12px 14px;
    margin-bottom: 16px;
    border-radius: var(--radius-md);
    border: 1px solid color-mix(in srgb, var(--warning, #f59e0b) 45%, transparent);
    background: color-mix(in srgb, var(--warning, #f59e0b) 10%, var(--surface-2));
    font-size: 13px;
    line-height: 1.45;
    color: var(--text-1);
    text-align: left;
  }
  .cw-icon { font-size: 20px; color: var(--warning, #f59e0b); flex: none; margin-top: 1px; }
  .cw-text { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
  .cw-text p { margin: 0; }
  .cw-title { font-weight: 600; font-size: 14px; }
  .cw-text a { color: var(--accent, #4fffb0); font-weight: 600; align-self: flex-start; }
</style>
