<script>
  import { slide } from 'svelte/transition';
  import Toggle from './Toggle.svelte';
  import ConnectionStatus from './ConnectionStatus.svelte';
  import { showSuccess, showError } from '../../stores/toast.js';
  import {
    aiEnabled, aiProvider, aiApiKey, aiModel, aiBaseUrl, aiAssistantName,
    aiKeyVerified, quickLogEnabled, aiGoalInsights,
    activityAutoEstimate, diaryShowActivity,
  } from '../../stores/settings.js';
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

  // Reset model to provider default when switching to a built-in provider.
  // 'oai-compat' has no model dropdown (free-text input), so skip the reset.
  $: if (aiProviderVal !== 'oai-compat' && aiModelVal && !AI_MODELS[aiProviderVal]?.find(m => m.value === aiModelVal)) {
    aiModelVal = AI_DEFAULT_MODELS[aiProviderVal] || '';
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
      if (!text || typeof text !== 'string') throw new Error('Empty response from AI');
      aiKeyVerified.set(true);
      showSuccess('Trace AI connected, assistant is ready');
    } catch (e) {
      testError = e.message || 'Test failed';
      aiKeyVerified.set(false);
      showError(testError);
    } finally {
      testing = false;
    }
  }

  // Provider label for the connection badge.
  $: _providerLabel = envLocks.ai
    ? 'Environment-locked'
    : (AI_PROVIDERS.find(p => p.value === aiProviderVal)?.label || aiProviderVal || '');

  // (No shim needed — the reactive `_hasAll` derivation above gives
  // legacy users an immediate green banner whenever the required
  // fields are populated, without writing to aiKeyVerified.)
</script>

<div class="section-body" transition:slide={{ duration: 180 }}>
  {#if envLocks.ai}
    <div class="env-lock-banner">
      <span class="material-symbols-rounded">lock</span>
      Configured via environment variables — changes are disabled.
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
        <span class="setting-label">Enable AI Assistant</span>
        <div class="setting-desc">Adds a floating chat button to all pages</div>
      </div>
      <Toggle checked={_displayedAiEnabled} on:change={e => aiEnabledVal = e.detail} disabled={envLocks.ai} />
    </div>

    {#if _displayedAiEnabled}
      <div class="setting-divider"></div>
      <div class="setting-row">
        <span class="setting-label">Provider</span>
        <select class="select sel-sm" style="width:auto" bind:value={aiProviderVal} disabled={envLocks.ai}>
          {#each AI_PROVIDERS as p}
            <option value={p.value}>{p.label}</option>
          {/each}
        </select>
      </div>

      <div class="setting-divider"></div>
      {#if aiProviderVal === 'oai-compat'}
        <!-- Custom OpenAI-compatible: free-text Base URL + Model name -->
        <div class="form-group" style="padding:10px 16px">
          <label class="form-label" for="ai-base-url">Base URL</label>
          <input id="ai-base-url" class="input" type="url"
            placeholder="http://localhost:11434  or  https://api.deepseek.com"
            bind:value={aiBaseUrlVal}
            on:blur={saveAiBaseUrl}
            autocomplete="off" style="width:100%" />
          <div class="setting-desc" style="margin-top:6px">
            Any OpenAI Compatible <code>/v1/chat/completions</code> endpoint — Ollama, LM Studio, LocalAI, vLLM, llama.cpp's server, DeepSeek, Groq, Together AI, Mistral La Plateforme, etc. Don't include the path; just the origin.
          </div>
        </div>
        <div class="setting-divider"></div>
        <div class="setting-row">
          <span class="setting-label">Model</span>
          <input class="input" style="width:220px;text-align:right"
            placeholder="llama3.1:8b"
            bind:value={aiModelVal} disabled={envLocks.ai} />
        </div>
        <div class="setting-divider"></div>
        <div style="padding:10px 16px;display:flex;gap:8px;align-items:flex-start;background:color-mix(in srgb,#f59e0b 8%, transparent);border-left:3px solid #f59e0b">
          <span class="material-symbols-rounded" style="font-size:18px;color:#f59e0b;flex-shrink:0">info</span>
          <div class="setting-desc" style="margin:0;line-height:1.5">
            <strong>Tool calls reliability varies by model.</strong> Llama 3.1+, Mistral, Qwen 2.5+ handle them well; smaller or older models may break Smart Log + Goal Insights silently. Vision (image attachments) needs a multimodal model. If you're unsure, start with a known-good model and check the chat works before relying on it.
          </div>
        </div>
      {:else}
        <div class="setting-row">
          <span class="setting-label">Model</span>
          <select class="select sel-sm" style="width:auto" bind:value={aiModelVal} disabled={envLocks.ai}>
            {#each (AI_MODELS[aiProviderVal] || []) as m}
              <option value={m.value}>{m.label}</option>
            {/each}
          </select>
        </div>
      {/if}

      {#if !envLocks.ai}
        <div class="setting-divider"></div>
        <div class="form-group" style="padding:10px 16px">
          <label class="form-label" for="ai-api-key">
            API Key{aiProviderVal === 'oai-compat' ? ' (optional)' : ''}
          </label>
          <div style="display:flex;gap:8px;align-items:center">
            {#if aiShowKey}
              <input id="ai-api-key" class="input" type="text"
                placeholder={aiProviderVal === 'oai-compat' ? 'Leave blank for local endpoints (Ollama, etc.)' : 'Paste your API key here'}
                bind:value={aiApiKeyVal}
                on:blur={saveAiKey}
                autocomplete="off" style="flex:1" />
            {:else}
              <input id="ai-api-key" class="input" type="password"
                placeholder={aiProviderVal === 'oai-compat' ? 'Leave blank for local endpoints (Ollama, etc.)' : 'Paste your API key here'}
                bind:value={aiApiKeyVal}
                on:blur={saveAiKey}
                autocomplete="off" style="flex:1" />
            {/if}
            <button class="btn-icon" on:click={() => aiShowKey = !aiShowKey} title={aiShowKey ? 'Hide' : 'Show'}>
              <span class="material-symbols-rounded">{aiShowKey ? 'visibility_off' : 'visibility'}</span>
            </button>
          </div>
          <div class="setting-desc" style="margin-top:6px">
            {#if aiProviderVal === 'claude'}
              Get your key at <a href="https://console.anthropic.com" target="_blank" rel="noopener" class="about-link">console.anthropic.com</a>
            {:else if aiProviderVal === 'openai'}
              Get your key at <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener" class="about-link">platform.openai.com</a>
            {:else if aiProviderVal === 'gemini'}
              Get your key at <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener" class="about-link">aistudio.google.com</a>
            {:else if aiProviderVal === 'oai-compat'}
              Local endpoints (Ollama, LM Studio, etc.) typically don't need a key. Cloud providers like DeepSeek or Groq do — get one from their dashboard.
            {/if}
            {#if isNative && !getServerUrl()}
              Your key is stored on this device.
            {:else}
              Your key is stored securely on the server.
            {/if}
          </div>
        </div>
      {/if}

      <div class="setting-divider"></div>
      <div class="setting-row">
        <span class="setting-label">Assistant Name</span>
        <input class="input" style="width:130px;text-align:right"
          placeholder="Trace"
          bind:value={aiAssistantNameVal} />
      </div>

      <div class="setting-divider"></div>
      <div class="setting-row">
        <div>
          <span class="setting-label">Smart Log</span>
          <div class="setting-desc">Hold the assistant button, speak what you ate — AI parses the items and meal slot, matches your food database, then confirms before saving</div>
        </div>
        <Toggle checked={quickLogEnabledVal} on:change={e => quickLogEnabledVal = e.detail} />
      </div>
      {#if quickLogEnabledVal}
        <div class="setting-divider"></div>
        <div class="setting-row" style="flex-direction:column;align-items:flex-start;gap:6px">
          <div class="setting-desc" style="line-height:1.55">
            <strong style="color:var(--text-2)">Trigger Words</strong>
            <div style="margin-top:4px">
              • <em>"my X <strong>meal</strong>"</em> → saved meals<br/>
              • <em>"my X <strong>recipe</strong>"</em> → saved recipes<br/>
              • <em>"<strong>same as yesterday</strong> for lunch"</em> → copy yesterday's items
            </div>
            <div style="margin-top:8px">
              See the <a href="https://github.com/traceapps/nutritrace#smart-log--voice--ai-food-logging" target="_blank" rel="noopener" class="about-link">Smart Log section in the README</a> for full examples and privacy details.
            </div>
          </div>
        </div>
      {/if}

      {#if $diaryShowActivity}
        <div class="setting-divider"></div>
        <div class="setting-row">
          <div>
            <span class="setting-label">Estimate Activity Calories</span>
            <div class="setting-desc">When you log a workout via Trace without a calorie number ("I hiked 10 miles"), let Trace estimate the burn from your body profile. Estimations need your <strong>weight, height, age, and sex</strong> on file — missing any pauses the estimator and Trace will ask for a number instead.</div>
          </div>
          <Toggle checked={$activityAutoEstimate} on:change={e => activityAutoEstimate.set(e.detail)} />
        </div>
      {/if}

      <div class="setting-divider"></div>
      <div class="setting-row">
        <div>
          <span class="setting-label">Goal Insights</span>
          <div class="setting-desc">The assistant analyzes your intake trends and proactively suggests goal adjustments when patterns are consistent</div>
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
  .setting-desc  { font-size: 12px; color: var(--text-3); margin-top: 2px; font-weight: 400; }
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
