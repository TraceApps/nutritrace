<script>
  import { _ } from 'svelte-i18n';
  import { APP_VERSION } from '../../lib/version.js';
  import { isNative, iconUrl } from '../../lib/platform.js';
</script>

<div class="section-body">
  <div class="card settings-card">
    <div class="about-hero">
      <img src={iconUrl('/icons/logo.png')} alt="NutriTrace" class="about-icon" />
      <div>
        <div class="about-name">NutriTrace</div>
        <div class="about-version text-3 text-sm">
          {APP_VERSION}
          <span class="platform-tag">{isNative ? 'Android' : 'PWA'}</span>
        </div>
      </div>
    </div>
    <div class="setting-divider"></div>
    <div class="about-desc">
      {$_('extracted.settings.trace_every_bite_personal_nutrition_tracker_nu_358')}
    </div>
    <div class="setting-divider"></div>
    <div class="about-row">
      <span class="material-symbols-rounded about-feat-icon">database</span>
      <span>{$_('extracted.settings.self_hosted_your_data_your_server_359')}</span>
    </div>
    <div class="setting-divider"></div>
    <div class="about-row">
      <span class="material-symbols-rounded about-feat-icon">phone_android</span>
      <span>{$_('extracted.settings.native_android_app_with_offline_support_plus_a_360')}</span>
    </div>
    <div class="setting-divider"></div>
    <div class="about-row">
      <span class="material-symbols-rounded about-feat-icon">lock</span>
      <span>{$_('extracted.settings.no_tracking_no_ads_no_third_party_analytics_361')}</span>
    </div>
    <div class="setting-divider"></div>
    <div class="about-row">
      <span class="material-symbols-rounded about-feat-icon">restaurant_menu</span>
      <span>{$_('settings_about.food_data_from')} <a href="https://world.openfoodfacts.org" target="_blank" rel="noopener" class="about-link">{$_('settings.connected_services.off.header')}</a> {$_('settings_about.food_data_license')}</span>
    </div>
    <div class="setting-divider"></div>
    <div class="about-row">
      <span class="material-symbols-rounded about-feat-icon">code</span>
      <span>{$_('settings_about.server_from')} <a href="https://github.com/traceapps/nutritrace" target="_blank" rel="noopener" class="about-link">{$_('settings_about.server_open_source')}</a> {$_('settings_about.server_license')}</span>
    </div>
    <div class="setting-divider"></div>
    <div class="about-row">
      <span class="material-symbols-rounded about-feat-icon">apps</span>
      <span>{$_('settings_about.family_line_prefix')}<a href="https://traceapps.github.io/docs/" target="_blank" rel="noopener" class="about-link">TraceApps</a>{$_('settings_about.family_line_suffix')}</span>
    </div>
    <div class="setting-divider"></div>
    <!-- Weblate credit line (Libre plan attribution). Passive callout —
         users who care about translations can follow through to help;
         everyone else just reads it as a credit. -->
    <div class="about-row">
      <span class="material-symbols-rounded about-feat-icon">translate</span>
      <span>{$_('settings_about.translations_from')} <a href="https://hosted.weblate.org/engage/nutritrace/" target="_blank" rel="noopener" class="about-link">Weblate</a></span>
    </div>
    <div class="setting-divider"></div>
    <div class="about-desc" style="font-size:11px;color:var(--text-3);line-height:1.5">
      <strong>{$_('extracted.settings.disclaimer_365')}</strong> {$_('extracted.settings.nutritrace_is_not_medical_health_or_nutrition_366')}
    </div>
  </div>
</div>

<style>
  .about-hero {
    display: flex; align-items: center; gap: 12px;
    padding: 8px 0;
  }
  .about-icon {
    width: 48px; height: 48px;
    border-radius: 10px;
  }
  .about-name { font-weight: 700; font-size: 16px; color: var(--text-1); }
  .about-version { display: flex; align-items: center; gap: 8px; margin-top: 2px; }
  .platform-tag {
    display: inline-flex; align-items: center;
    padding: 2px 8px; border-radius: 999px;
    background: var(--surface-2); color: var(--text-2);
    font-size: 11px; font-weight: 600;
  }
  .about-desc {
    font-size: 13px; color: var(--text-2);
    padding: 8px 0; line-height: 1.5;
  }
  .about-row {
    display: flex; align-items: center; gap: 10px;
    padding: 8px 0;
    font-size: 13px; color: var(--text-1);
  }
  .about-feat-icon {
    color: var(--accent); font-size: 20px; flex-shrink: 0;
  }
  .about-link { color: var(--accent); text-decoration: none; }
  .about-link:hover { text-decoration: underline; }
</style>
