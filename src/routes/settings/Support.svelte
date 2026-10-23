<script>
  import { _ } from 'svelte-i18n';

  // Passive by design: this page is the only place the app asks for support.
  // No banners, popups, or reminders anywhere else. Money and free ways to
  // help share the page, so everyone who opens it has something to do.
  const HELP = [
    { icon: 'star',      key: 'star',      href: 'https://github.com/TraceApps/nutritrace' },
    { icon: 'bug_report', key: 'report_bug', href: 'https://github.com/TraceApps/nutritrace/issues/new/choose' },
    { icon: 'translate', key: 'translate', href: 'https://hosted.weblate.org/engage/nutritrace/' },
  ];
</script>

<div class="section-body">
  <div class="card settings-card">
    <div class="support-hero">
      <span class="material-symbols-rounded support-hero-icon">volunteer_activism</span>
      <p class="support-lead">{$_('settings_support.lead')}</p>
    </div>
    <div class="support-actions">
      <a href="https://ko-fi.com/traceapps" target="_blank" rel="noopener" class="btn btn-secondary support-btn">
        <span class="material-symbols-rounded">coffee</span> Ko-fi
      </a>
      <a href="https://github.com/sponsors/TraceApps?metadata_app=nutritrace&metadata_from=app" target="_blank" rel="noopener" class="btn btn-secondary support-btn">
        <span class="material-symbols-rounded">favorite</span> GitHub Sponsors
      </a>
    </div>
  </div>

  <div class="card settings-card">
    <div class="support-subhead">{$_('settings_support.other_ways')}</div>
    {#each HELP as h, i}
      {#if i > 0}<div class="setting-divider"></div>{/if}
      <a class="support-row" href={h.href} target="_blank" rel="noopener">
        <span class="material-symbols-rounded support-row-icon">{h.icon}</span>
        <span class="support-row-text">
          <span class="support-row-title">{$_(`settings_support.${h.key}`)}</span>
          <span class="support-row-desc">{$_(`settings_support.${h.key}_desc`)}</span>
        </span>
        <span class="material-symbols-rounded support-row-go">open_in_new</span>
      </a>
    {/each}
  </div>
</div>

<style>
  .support-hero {
    display: flex; align-items: flex-start; gap: 12px;
    padding: 16px 16px 4px;
  }
  .support-hero-icon {
    color: var(--accent); font-size: 28px; flex-shrink: 0;
  }
  .support-lead {
    margin: 0; font-size: 14px; line-height: 1.5; color: var(--text-1);
  }
  .support-actions {
    display: flex; flex-wrap: wrap; gap: 8px;
    padding: 12px 16px 16px 56px;
  }
  .support-btn {
    height: 38px; padding: 0 16px; gap: 6px; font-size: 13px;
  }
  .support-btn .material-symbols-rounded { font-size: 18px; }
  .support-subhead {
    font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase;
    color: var(--text-3); padding: 16px 16px 6px;
  }
  .support-row {
    display: flex; align-items: center; gap: 12px;
    padding: 12px 16px; color: var(--text-1); text-decoration: none;
  }
  .support-row:hover .support-row-title { color: var(--accent); }
  .support-row-icon { color: var(--accent); font-size: 22px; flex-shrink: 0; }
  .support-row-text { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0; }
  .support-row-title { font-size: 14px; font-weight: 600; }
  .support-row-desc { font-size: 12px; color: var(--text-3); line-height: 1.4; }
  .support-row-go { color: var(--text-3); font-size: 18px; flex-shrink: 0; }
</style>
