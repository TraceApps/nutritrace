<script>
  import { slide } from 'svelte/transition';
  import { _ } from 'svelte-i18n';
  import Toggle from './Toggle.svelte';
  import ConnectionStatus from './ConnectionStatus.svelte';
  import { showSuccess, showError } from '../../stores/toast.js';
  import {
    aiEnabled, aiProvider, aiApiKey, aiModel, aiBaseUrl, aiAssistantName,
    aiKeyVerified, quickLogEnabled, aiGoalInsights, smartLogVoiceLang,
    activityAutoEstimate, diaryShowActivity,
  } from '../../stores/settings.js';

  // Smart Log voice-input language options. 'auto' uses navigator.language
  // (device locale). Labels resolve reactively via $_ so translations
  // update when the app language changes.
  $: VOICE_LANGS = [
    { value: 'auto',  label: $_('settings_trace.voice_langs.auto')  },
    { value: 'en-US', label: $_('settings_trace.voice_langs.en_US') },
    { value: 'en-GB', label: $_('settings_trace.voice_langs.en_GB') },
    { value: 'it-IT', label: $_('settings_trace.voice_langs.it_IT') },
    { value: 'es-ES', label: $_('settings_trace.voice_langs.es_ES') },
    { value: 'es-MX', label: $_('settings_trace.voice_langs.es_MX') },
    { value: 'fr-FR', label: $_('settings_trace.voice_langs.fr_FR') },
    { value: 'de-DE', label: $_('settings_trace.voice_langs.de_DE') },
    { value: 'pt-BR', label: $_('settings_trace.voice_langs.pt_BR') },
    { value: 'pt-PT', label: $_('settings_trace.voice_langs.pt_PT') },
    { value: 'nl-NL', label: $_('settings_trace.voice_langs.nl_NL') },
    { value: 'pl-PL', label: $_('settings_trace.voice_langs.pl_PL') },
    { value: 'ru-RU', label: $_('settings_trace.voice_langs.ru_RU') },
    { value: 'sv-SE', label: $_('settings_trace.voice_langs.sv_SE') },
    { value: 'da-DK', label: $_('settings_trace.voice_langs.da_DK') },
    { value: 'nb-NO', label: $_('settings_trace.voice_langs.nb_NO') },
    { value: 'fi-FI', label: $_('settings_trace.voice_langs.fi_FI') },
    { value: 'cs-CZ', label: $_('settings_trace.voice_langs.cs_CZ') },
    { value: 'tr-TR', label: $_('settings_trace.voice_langs.tr_TR') },
    { value: 'ja-JP', label: $_('settings_trace.voice_langs.ja_JP') },
    { value: 'ko-KR', label: $_('settings_trace.voice_langs.ko_KR') },
    { value: 'zh-CN', label: $_('settings_trace.voice_langs.zh_CN') },
    { value: 'zh-TW', label: $_('settings_trace.voice_langs.zh_TW') },
    { value: 'hi-IN', label: $_('settings_trace.voice_langs.hi_IN') },
    { value: 'ar-SA', label: $_('settings_trace.voice_langs.ar_SA') },
  ];
  import { AI_PROVIDERS, AI_MODELS, AI_DEFAULT_MODELS, callAI, callAIProxy } from '../../lib/aiChat.js';
  import { DB } from '../../lib/db.js';
  import { scheduleSave } from '../../stores/settings.js';
  import { isNative, getServerUrl } from '../../lib/platform.js';

  export let envLocks = { ai: false, ai_enabled: false };

  function set(key, value) { DB.setSetting(key, value); scheduleSave(key, value); }

  // ── AI Assistant state ───────────────────────────────────────────────────────
  let aiEnabledVal       = DB.getSetting('aiEnabled',       false);
  let aiProviderVal      = DB.getSetting('aiProvider',      'claude');
  let aiApiKeyVal        = DB.getSetting('aiApiKey',        '');
  let aiModelVal         = DB.getSetting('aiModel',         '');
  let aiBaseUrlVal       = DB.getSetting('aiBaseUrl',       '');
  let aiAssistantNameVal = DB.getSetting('aiAssistantName', 'Trace');
  let quickLogEnabledVal = DB.getSetting('quickLogEnabled', false);
  let aiShowKey          = false;
  let testing            = false;
  let testError          = '';
  // When env-locked, the displayed state comes from the env-set value
  // (server's AI_ENABLED env var resolved on startup), not the per-user
  // setting. Without this, setting AI_ENABLED=true in compose left the
  // toggle stuck OFF because aiEnabled in user_settings was never flipped.
  // Issue #36.
  $: _displayedAiEnabled = envLocks.ai ? !!envLocks.ai_enabled : aiEnabledVal;
  // "Effectively connected" — green banner when the user has all the
  // required pieces in place, even if they haven't gone through Save
  // (covers users upgrading from a release before the verified flag
  // existed, whose AI was working fine and shouldn't suddenly look
  // disconnected). An explicit $aiKeyVerified=true overrides too.
  // The most recent test error trumps either path.
  // When env-locked, the operator has supplied every required field on
  // the server side (AI_PROVIDER + AI_API_KEY + AI_MODEL, plus AI_BASE_URL
  // when needed). The client's local model/key/baseUrl are stale or empty
  // in that scenario, so trust the env state. Without this short-circuit
  // the connection-status banner stays blank under env-lock.
  $: _hasAll = envLocks.ai
    ? !!envLocks.ai_enabled
    : (aiEnabledVal
        && !!aiModelVal?.trim()
        && !!aiApiKeyVal?.trim()
        && (aiProviderVal !== 'oai-compat' || !!aiBaseUrlVal?.trim()));
  $: testStatus = testing
    ? 'testing'
    : testError
      ? 'fail'
      : ($aiKeyVerified || _hasAll ? 'ok' : '');

  // Branded providers (claude/openai/gemini) render a <select>. To let users
  // pick a model outside the hardcoded list (e.g. after a vendor renames), the
  // select includes a 'Custom…' option that reveals a free-text input.
  //   aiModelSelectVal    — the <select>'s current option ('__custom__' or preset id)
  //   aiCustomModelVal    — the free-text input's value (only meaningful in custom mode)
  //   aiModelVal          — source-of-truth persisted to settings; derived from the two above
  let aiModelSelectVal;
  let aiCustomModelVal = '';
  {
    const saved = aiModelVal;
    const isPreset = AI_MODELS[aiProviderVal]?.some(m => m.value === saved && m.value !== '__custom__');
    if (saved && !isPreset && aiProviderVal !== 'oai-compat') {
      aiModelSelectVal = '__custom__';
      aiCustomModelVal = saved;
    } else {
      aiModelSelectVal = saved || AI_DEFAULT_MODELS[aiProviderVal] || '';
    }
  }

  // Explicit handlers (not reactives) to avoid a Svelte cyclical-dependency
  // error between aiModelVal, aiModelSelectVal, and _hasAll.
  function _syncModelFromSelect() {
    if (aiProviderVal === 'oai-compat') return;
    aiModelVal = (aiModelSelectVal === '__custom__')
      ? aiCustomModelVal.trim()
      : (aiModelSelectVal || '');
  }
  function _onProviderChange() {
    if (aiProviderVal === 'oai-compat') return;
    const isPreset = AI_MODELS[aiProviderVal]?.some(m => m.value === aiModelVal && m.value !== '__custom__');
    if (!aiModelVal || !isPreset) {
      // A custom name like "gpt-4o-turbo" won't work on Gemini, so don't
      // preserve custom across a switch — reset to the new provider's default.
      aiModelSelectVal = AI_DEFAULT_MODELS[aiProviderVal] || '';
      aiCustomModelVal = '';
      aiModelVal = aiModelSelectVal;
    } else {
      aiModelSelectVal = aiModelVal;
    }
  }

  // Reactive saves
  $: { aiEnabled.set(aiEnabledVal); }
  $: { aiProvider.set(aiProviderVal); _invalidate(); }
  $: { set('aiModel', aiModelVal); _invalidate(); }
  $: set('aiAssistantName', aiAssistantNameVal);
  $: { quickLogEnabled.set(quickLogEnabledVal); }

  // Any change to provider/model/key/baseUrl clears the prior verification —
  // the user must re-save (which re-tests) before the FAB unlocks again.
  function _invalidate() {
    if ($aiKeyVerified) aiKeyVerified.set(false);
    testError = '';
  }

  // Auto-save-on-blur for the API key + Base URL. The test only fires
  // when the value actually changed since the last save — blurring
  // without an edit shouldn't burn the user's API quota. Re-tests are
  // still available via the Test button on the ConnectionStatus banner.
  let _lastSavedApiKey = aiApiKeyVal;
  let _lastSavedBaseUrl = aiBaseUrlVal;
  async function saveAiKey() {
    if (aiApiKeyVal === _lastSavedApiKey) return;
    _lastSavedApiKey = aiApiKeyVal;
    set('aiApiKey', aiApiKeyVal);
    await testConnection();
  }

  async function saveAiBaseUrl() {
    const trimmed = aiBaseUrlVal.trim();
    if (trimmed === _lastSavedBaseUrl) return;
    _lastSavedBaseUrl = trimmed;
    set('aiBaseUrl', trimmed);
    await testConnection();
  }

  // Required fields the user must fill in for a meaningful test.
  $: canTest = !envLocks.ai
    && !!aiApiKeyVal?.trim() || envLocks.ai
    && !!aiModelVal?.trim()
    && (aiProviderVal !== 'oai-compat' || !!aiBaseUrlVal?.trim());

  async function testConnection() {
    if (!canTest && !envLocks.ai) {
      testError = 'Fill in provider, API key, and model first';
      return;
    }
    testing   = true;
    testError = '';
    try {
      const messages     = [{ role: 'user', content: 'Say "hi" in one word.' }];
      const systemPrompt = 'You are a test bot. Reply with exactly one short word.';
      let text;
      if (envLocks.ai) {
        text = await callAIProxy({ messages, systemPrompt });
      } else {
        text = await callAI({
          provider: aiProviderVal,
          apiKey:   aiApiKeyVal,
          model:    aiModelVal,
          baseUrl:  aiBaseUrlVal,
          messages,
          systemPrompt,
        });
      }
      if (!text || typeof text !== 'string') throw new Error($_('settings_trace.toast.empty_response'));
      aiKeyVerified.set(true);
      showSuccess($_('settings_trace.toast.connected'));
    } catch (e) {
      testError = e.message || $_('settings_trace.toast.test_failed');
      aiKeyVerified.set(false);
      showError(testError);
    } finally {
      testing = false;
    }
  }

  // Provider label for the connection badge.
  $: _providerLabel = envLocks.ai
    ? $_('settings_trace.provider_env_locked')
    : (AI_PROVIDERS.find(p => p.value === aiProviderVal)?.label || aiProviderVal || '');

  // (No shim needed — the reactive `_hasAll` derivation above gives
  // legacy users an immediate green banner whenever the required
  // fields are populated, without writing to aiKeyVerified.)
</script>

<div class="section-body" transition:slide={{ duration: 180 }}>
  {#if envLocks.ai}
    <div class="env-lock-banner">
      <span class="material-symbols-rounded">lock</span>
      {$_('settings_trace.env_lock_banner')}
    </div>
  {/if}
  <div class="card settings-card">
    {#if _displayedAiEnabled}
      <ConnectionStatus
        status={testStatus}
        connectedAs={_providerLabel}
        error={testError}
        onRetest={() => testConnection()}
        retestDisabled={testing}
      />
    {/if}
    <div class="setting-row">
      <div>
        <span class="setting-label">{$_('settings_trace.labels.enable')}</span>
        <div class="setting-desc">{$_('settings_trace.labels.enable_desc')}</div>
      </div>
      <Toggle checked={_displayedAiEnabled} on:change={e => aiEnabledVal = e.detail} disabled={envLocks.ai} />
    </div>

    {#if _displayedAiEnabled}
      <div class="setting-divider"></div>
      <div class="setting-row">
        <span class="setting-label">{$_('settings_trace.labels.provider')}</span>
        <select class="select sel-sm" style="width:auto" bind:value={aiProviderVal} on:change={_onProviderChange} disabled={envLocks.ai}>
          {#each AI_PROVIDERS as p}
            <option value={p.value}>{p.label}</option>
          {/each}
        </select>
      </div>

      <div class="setting-divider"></div>
      {#if aiProviderVal === 'oai-compat'}
        <!-- Custom OpenAI-compatible: free-text Base URL + Model name -->
        <div class="form-group" style="padding:10px 16px">
          <label class="form-label" for="ai-base-url">{$_('settings_trace.labels.base_url')}</label>
          <input id="ai-base-url" class="input" type="url"
            placeholder={$_('settings_trace.labels.base_url_ph')}
            bind:value={aiBaseUrlVal}
            on:blur={saveAiBaseUrl}
            autocomplete="off" style="width:100%" />
          <div class="setting-desc" style="margin-top:6px">
            {$_('settings_trace.labels.base_url_desc')}
          </div>
        </div>
        <div class="setting-divider"></div>
        <div class="setting-row">
          <span class="setting-label">{$_('settings_trace.labels.model')}</span>
          <input class="input" style="width:220px;text-align:right"
            placeholder="llama3.1:8b"
            bind:value={aiModelVal} disabled={envLocks.ai} />
        </div>
        <div class="setting-divider"></div>
        <div style="padding:10px 16px;display:flex;gap:8px;align-items:flex-start;background:color-mix(in srgb,#f59e0b 8%, transparent);border-left:3px solid #f59e0b">
          <span class="material-symbols-rounded" style="font-size:18px;color:#f59e0b;flex-shrink:0">info</span>
          <div class="setting-desc" style="margin:0;line-height:1.5">
            <strong>{$_('settings_trace.labels.reliability_title')}</strong> {$_('settings_trace.labels.reliability_body')}
          </div>
        </div>
      {:else}
        <div class="setting-row">
          <span class="setting-label">{$_('settings_trace.labels.model')}</span>
          <select class="select sel-sm" style="width:auto" bind:value={aiModelSelectVal} on:change={_syncModelFromSelect} disabled={envLocks.ai}>
            {#each (AI_MODELS[aiProviderVal] || []) as m}
              <option value={m.value}>{m.label}</option>
            {/each}
          </select>
        </div>
        {#if aiModelSelectVal === '__custom__'}
          <div class="setting-divider"></div>
          <div class="setting-row">
            <span class="setting-label">{$_('settings_trace.labels.custom_model_id')}</span>
            <input class="input" style="width:220px;text-align:right"
              placeholder={aiProviderVal === 'gemini' ? 'gemini-3.5-flash' : aiProviderVal === 'claude' ? 'claude-sonnet-5' : 'gpt-4o'}
              bind:value={aiCustomModelVal} on:input={_syncModelFromSelect} disabled={envLocks.ai} />
          </div>
          <div style="padding:8px 16px 12px;display:flex;gap:8px;align-items:flex-start">
            <span class="material-symbols-rounded" style="font-size:16px;color:var(--muted);flex-shrink:0;margin-top:2px">info</span>
            <div class="setting-desc" style="margin:0;line-height:1.5">
              {$_('settings_trace.labels.custom_model_hint')}
            </div>
          </div>
        {/if}
      {/if}

      {#if !envLocks.ai}
        <div class="setting-divider"></div>
        <div class="form-group" style="padding:10px 16px">
          <label class="form-label" for="ai-api-key">
            {$_('settings_trace.labels.api_key')}{aiProviderVal === 'oai-compat' ? $_('settings_trace.labels.api_key_optional_suffix') : ''}
          </label>
          <div style="display:flex;gap:8px;align-items:center">
            {#if aiShowKey}
              <input id="ai-api-key" class="input" type="text"
                placeholder={aiProviderVal === 'oai-compat' ? $_('settings_trace.labels.api_key_ph_local') : $_('settings_trace.labels.api_key_ph_cloud')}
                bind:value={aiApiKeyVal}
                on:blur={saveAiKey}
                autocomplete="off" style="flex:1" />
            {:else}
              <input id="ai-api-key" class="input" type="password"
                placeholder={aiProviderVal === 'oai-compat' ? $_('settings_trace.labels.api_key_ph_local') : $_('settings_trace.labels.api_key_ph_cloud')}
                bind:value={aiApiKeyVal}
                on:blur={saveAiKey}
                autocomplete="off" style="flex:1" />
            {/if}
            <button class="btn-icon" on:click={() => aiShowKey = !aiShowKey} title={aiShowKey ? $_('settings_trace.labels.hide') : $_('settings_trace.labels.show')}>
              <span class="material-symbols-rounded">{aiShowKey ? 'visibility_off' : 'visibility'}</span>
            </button>
          </div>
          <div class="setting-desc" style="margin-top:6px">
            {#if aiProviderVal === 'claude'}
              {$_('settings_trace.labels.key_hint_claude')} <a href="https://console.anthropic.com" target="_blank" rel="noopener" class="about-link">console.anthropic.com</a>
            {:else if aiProviderVal === 'openai'}
              {$_('settings_trace.labels.key_hint_openai')} <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener" class="about-link">platform.openai.com</a>
            {:else if aiProviderVal === 'gemini'}
              {$_('settings_trace.labels.key_hint_gemini')} <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener" class="about-link">aistudio.google.com</a>
            {:else if aiProviderVal === 'oai-compat'}
              {$_('settings_trace.labels.key_hint_oai_compat')}
            {/if}
            {#if isNative && !getServerUrl()}
              {$_('settings_trace.labels.key_stored_device')}
            {:else}
              {$_('settings_trace.labels.key_stored_server')}
            {/if}
          </div>
        </div>
      {/if}

      <div class="setting-divider"></div>
      <div class="setting-row">
        <span class="setting-label">{$_('settings_trace.labels.assistant_name')}</span>
        <input class="input" style="width:130px;text-align:right"
          placeholder={$_('settings_trace.labels.assistant_name_ph')}
          bind:value={aiAssistantNameVal} />
      </div>

      <div class="setting-divider"></div>
      <div class="setting-row">
        <div>
          <span class="setting-label">{$_('settings_trace.labels.smart_log')}</span>
          <div class="setting-desc">{$_('settings_trace.labels.smart_log_desc')}</div>
        </div>
        <Toggle checked={quickLogEnabledVal} on:change={e => quickLogEnabledVal = e.detail} />
      </div>
      {#if quickLogEnabledVal}
        <div class="setting-divider"></div>
        <div class="setting-row">
          <div>
            <span class="setting-label">{$_('settings_trace.labels.voice_lang')}</span>
            <div class="setting-desc">{$_('settings_trace.labels.voice_lang_desc')}</div>
          </div>
          <select class="select sel-sm" style="width:auto" value={$smartLogVoiceLang}
                  on:change={e => smartLogVoiceLang.set(e.target.value)}>
            {#each VOICE_LANGS as opt}
              <option value={opt.value}>{opt.label}</option>
            {/each}
          </select>
        </div>
        <div class="setting-divider"></div>
        <div class="setting-row" style="flex-direction:column;align-items:flex-start;gap:6px">
          <div class="setting-desc" style="line-height:1.55">
            <strong style="color:var(--text-2)">{$_('settings_trace.labels.trigger_words')}</strong>
            <div style="margin-top:4px">
              • <em>{$_('settings_trace.labels.trigger_meal')}</em><br/>
              • <em>{$_('settings_trace.labels.trigger_recipe')}</em><br/>
              • <em>{$_('settings_trace.labels.trigger_yesterday')}</em>
            </div>
            <div style="margin-top:8px">
              <a href="https://github.com/traceapps/nutritrace#smart-log--voice--ai-food-logging" target="_blank" rel="noopener" class="about-link">{$_('settings_trace.labels.smart_log_readme')}</a>
            </div>
          </div>
        </div>
      {/if}

      {#if $diaryShowActivity}
        <div class="setting-divider"></div>
        <div class="setting-row">
          <div>
            <span class="setting-label">{$_('settings_trace.labels.activity_estimate')}</span>
            <div class="setting-desc">{$_('settings_trace.labels.activity_estimate_desc')}</div>
          </div>
          <Toggle checked={$activityAutoEstimate} on:change={e => activityAutoEstimate.set(e.detail)} />
        </div>
      {/if}

      <div class="setting-divider"></div>
      <div class="setting-row">
        <div>
          <span class="setting-label">{$_('settings_trace.labels.goal_insights')}</span>
          <div class="setting-desc">{$_('settings_trace.labels.goal_insights_desc')}</div>
        </div>
        <Toggle checked={$aiGoalInsights} on:change={e => aiGoalInsights.set(e.detail)} />
      </div>
    {/if}
  </div>
</div>

<style>
  /* Mirror Settings.svelte scoped styles so cards look identical */
  .section-body { padding: 12px var(--page-px); display: flex; flex-direction: column; gap: 10px; }
  .settings-card {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  .setting-row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 13px 16px;
    min-height: 50px;
  }
  .setting-label { font-size: 14px; font-weight: 500; flex: 1; }
  .setting-divider { height: 1px; background: var(--border); margin: 0 16px; }
  .sel-sm { height: 36px; font-size: 13px; width: auto; max-width: 100%; }

  .form-group { display: flex; flex-direction: column; gap: 6px; }
  .form-label { font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-3); }

  .env-lock-banner {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 14px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    font-size: 13px;
    color: var(--text-3);
  }

  .about-link { color: var(--accent); text-decoration: underline; }
</style>
