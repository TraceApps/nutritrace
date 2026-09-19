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
      Trace Every Bite — Personal Nutrition Tracker. NutriTrace is a self-hosted nutrition,
      wellness, and fitness tracker built for privacy. Your data lives on your server, not
      in the cloud. Features food diary, wellness integrations (Fitbit, Garmin, Withings,
      Health Connect), AI assistant, workout GPS maps, goal tracking, and more.
    </div>
    <div class="setting-divider"></div>
    <div class="about-row">
      <span class="material-symbols-rounded about-feat-icon">database</span>
      <span>Self-hosted — your data, your server</span>
    </div>
    <div class="setting-divider"></div>
    <div class="about-row">
      <span class="material-symbols-rounded about-feat-icon">phone_android</span>
      <span>Native Android app with offline support, plus a PWA for any browser</span>
    </div>
    <div class="setting-divider"></div>
    <div class="about-row">
      <span class="material-symbols-rounded about-feat-icon">lock</span>
      <span>No tracking, no ads, no third-party analytics</span>
    </div>
    <div class="setting-divider"></div>
    <div class="about-row">
      <span class="material-symbols-rounded about-feat-icon">restaurant_menu</span>
      <span>{$_('settings_about.food_data_from')} <a href="https://world.openfoodfacts.org" target="_blank" rel="noopener" class="about-link">Open Food Facts</a> {$_('settings_about.food_data_license')}</span>
    </div>
    <div class="setting-divider"></div>
    <div class="about-row">
      <span class="material-symbols-rounded about-feat-icon">code</span>
      <span>{$_('settings_about.server_from')} <a href="https://github.com/traceapps/nutritrace" target="_blank" rel="noopener" class="about-link">{$_('settings_about.server_open_source')}</a> {$_('settings_about.server_license')}</span>
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
    <div class="about-row" style="flex-direction:column;align-items:flex-start;gap:8px">
      <div style="display:flex;align-items:center;gap:8px">
        <span class="material-symbols-rounded about-feat-icon">volunteer_activism</span>
        <span>{$_('settings_about.support_dev')}</span>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;padding-left:30px">
        <a href="https://ko-fi.com/traceapps" target="_blank" rel="noopener" class="btn btn-secondary" style="height:30px;font-size:12px;padding:0 12px">
          <span class="material-symbols-rounded" style="font-size:14px">coffee</span> Ko-fi
        </a>
      </div>
      <div class="setting-desc" style="padding-left:30px;font-size:11px">{$_('settings_about.support_note')}</div>
    </div>
    <div class="setting-divider"></div>
    <div class="about-desc" style="font-size:11px;color:var(--text-3);line-height:1.5">
      <strong>Disclaimer.</strong> NutriTrace is not medical, health, or nutrition-professional
      software. It does not provide medical advice, diagnosis, treatment, or personalized nutrition
      prescriptions. Food entries, calorie and macro tracking, Trace AI suggestions, Smart Log
      parsing, Scan Label output, Goal Insights, Adaptive TDEE recommendations, wellness scores
      (readiness, stress, sleep quality), and any analytical output are for informational and
      self-tracking purposes only. Nutrition decisions can interact with medical conditions
      (diabetes, eating disorders, food allergies, pregnancy, breastfeeding, pediatric needs,
      kidney or liver disease, metabolic disorders) in ways this app cannot assess. Consult a
      qualified healthcare professional, registered dietitian, or licensed nutritionist before
      starting a new eating plan, calorie target, or making significant dietary changes. Trace
      AI answers can be incorrect or incomplete; treat them as a starting point, not a substitute
      for human judgment or professional advice. Food nutrition data from Open Food Facts is
      community-curated and may contain inaccuracies. Use at your own risk.
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
