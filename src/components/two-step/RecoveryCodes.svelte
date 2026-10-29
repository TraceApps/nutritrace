<script>
  // Recovery codes, shown once (#222): each signs in once when the phone
  // with the authenticator app is lost. Copy or save them, then go on.
  import { createEventDispatcher } from 'svelte';
  import { _ } from 'svelte-i18n';
  import { isNative, getServerUrl } from '../../lib/platform.js';
  import { copyText } from '../../lib/clipboard.js';
  import { recoveryCodesText } from '../../lib/two-step.js';
  import { showError, showSuccess } from '../../stores/toast.js';

  export let codes = [];
  export let account = '';

  const dispatch = createEventDispatcher();
  const server = () => (isNative ? getServerUrl() : (typeof location !== 'undefined' ? location.origin : '')) || '';
  $: text = recoveryCodesText(codes, { account, server: server() });

  async function copy() {
    try { await copyText(text); showSuccess($_('two_step.codes.copied')); }
    catch { showError($_('two_step.errors.copy_failed')); }
  }

  function download() {
    const url = URL.createObjectURL(new Blob([text + '\n'], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `nutritrace-recovery-codes${account ? `-${account}` : ''}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
</script>

<div class="rc">
  <div class="rc-head">
    <span class="material-symbols-rounded" aria-hidden="true">key</span>
    <strong>{$_('two_step.codes.title')}</strong>
  </div>
  <p class="rc-text">{$_('two_step.codes.explain')}</p>
  <ul class="rc-list" aria-label={$_('two_step.codes.title')}>
    {#each codes as c}<li><code>{c}</code></li>{/each}
  </ul>
  <div class="rc-actions">
    <button class="btn btn-secondary" type="button" on:click={copy}>
      <span class="material-symbols-rounded" aria-hidden="true">content_copy</span>{$_('two_step.codes.copy')}
    </button>
    {#if !isNative}
      <button class="btn btn-secondary" type="button" on:click={download}>
        <span class="material-symbols-rounded" aria-hidden="true">download</span>{$_('two_step.codes.download')}
      </button>
    {/if}
  </div>
  <button class="btn btn-primary w-full" type="button" on:click={() => dispatch('done')}>{$_('two_step.codes.saved')}</button>
</div>

<style>
  .rc { display: flex; flex-direction: column; gap: 12px; }
  .rc-head { display: flex; align-items: center; gap: 8px; font-size: 15px; color: var(--text-1); }
  .rc-head .material-symbols-rounded { color: var(--accent); font-size: 22px; }
  .rc-text { margin: 0; font-size: 13px; line-height: 1.5; color: var(--text-2); }
  .rc-list {
    list-style: none; margin: 0; padding: 12px;
    display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 170px), 1fr)); gap: 6px 16px;
    background: var(--surface-2); border: 1px solid var(--border); border-radius: 8px;
  }
  .rc-list code {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 14px;
    color: var(--text-1); letter-spacing: 0.03em; user-select: all; -webkit-user-select: all;
  }
  .rc-actions { display: flex; gap: 8px; flex-wrap: wrap; }
  .rc-actions .btn { flex: 1 1 auto; display: inline-flex; align-items: center; justify-content: center; gap: 6px; }
  .rc-actions .material-symbols-rounded { font-size: 18px; }
</style>
