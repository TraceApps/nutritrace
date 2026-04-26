<script>
  import { slide } from 'svelte/transition';
  import Toggle from './Toggle.svelte';
  import { showSuccess, showError } from '../../stores/toast.js';
  import {
    aiEnabled, aiProvider, aiApiKey, aiModel, aiAssistantName, quickLogEnabled, aiGoalInsights,
  } from '../../stores/settings.js';
  import { AI_PROVIDERS, AI_MODELS, AI_DEFAULT_MODELS } from '../../lib/aiChat.js';
  import { DB } from '../../lib/db.js';
  import { scheduleSave } from '../../stores/settings.js';

  export let envLocks = { ai: false };

  function set(key, value) { DB.setSetting(key, value); scheduleSave(key, value); }

  // ── AI Assistant state ───────────────────────────────────────────────────────
  let aiEnabledVal       = DB.getSetting('aiEnabled',       false);
  let aiProviderVal      = DB.getSetting('aiProvider',      'claude');
  let aiApiKeyVal        = DB.getSetting('aiApiKey',        '');
  let aiModelVal         = DB.getSetting('aiModel',         '');
  let aiAssistantNameVal = DB.getSetting('aiAssistantName', 'Trace');
  let quickLogEnabledVal = DB.getSetting('quickLogEnabled', false);
  let aiShowKey          = false;
  let aiKeySaved         = false;

  // Reset model to provider default when provider changes
  $: if (aiModelVal && !AI_MODELS[aiProviderVal]?.find(m => m.value === aiModelVal)) {
    aiModelVal = AI_DEFAULT_MODELS[aiProviderVal] || '';
  }

  // Reactive saves
  $: { aiEnabled.set(aiEnabledVal); }
  $: { aiProvider.set(aiProviderVal); }
  $: set('aiModel',         aiModelVal);
  $: set('aiAssistantName', aiAssistantNameVal);
  $: { quickLogEnabled.set(quickLogEnabledVal); }

  function saveAiKey() {
    set('aiApiKey', aiApiKeyVal);
    aiKeySaved = true;
    setTimeout(() => aiKeySaved = false, 2000);
  }
</script>

<div class="section-body" transition:slide={{ duration: 180 }}>
  {#if envLocks.ai}
    <div class="env-lock-banner">
      <span class="material-symbols-rounded">lock</span>
      Configured via environment variables — changes are disabled.
    </div>
  {/if}
  <div class="card settings-card">
    <div class="setting-row">
      <div>
        <span class="setting-label">Enable AI Assistant</span>
        <div class="setting-desc">Adds a floating chat button to all pages</div>
      </div>
      <Toggle checked={aiEnabledVal} on:change={e => aiEnabledVal = e.detail} disabled={envLocks.ai} />
    </div>

    {#if aiEnabledVal}
      <div class="setting-divider"></div>
      <div class="setting-row">
        <span class="setting-label">Assistant name</span>
        <input class="input" style="width:130px;text-align:right"
          placeholder="Trace"
          bind:value={aiAssistantNameVal} />
      </div>

      <div class="setting-divider"></div>
      <div class="setting-row">
        <span class="setting-label">Provider</span>
        <div class="select-wrap" style="width:170px">
          <select class="select sel-sm" bind:value={aiProviderVal} disabled={envLocks.ai}>
            {#each AI_PROVIDERS as p}
              <option value={p.value}>{p.label}</option>
            {/each}
          </select>
        </div>
      </div>

      <div class="setting-divider"></div>
      <div class="setting-row">
        <span class="setting-label">Model</span>
        <div class="select-wrap" style="width:200px">
          <select class="select sel-sm" bind:value={aiModelVal} disabled={envLocks.ai}>
            {#each (AI_MODELS[aiProviderVal] || []) as m}
              <option value={m.value}>{m.label}</option>
            {/each}
          </select>
        </div>
      </div>

      <div class="setting-divider"></div>
      <div class="setting-row">
        <div>
          <span class="setting-label">
            Smart Log
            <span class="labs-badge" style="background:linear-gradient(135deg,#6366f1,#8b5cf6);vertical-align:middle">Experimental</span>
          </span>
          <div class="setting-desc">Hold the assistant button, speak what you ate — AI parses the items and meal slot, matches your food database, then confirms before saving</div>
        </div>
        <Toggle checked={quickLogEnabledVal} on:change={e => quickLogEnabledVal = e.detail} />
      </div>
      {#if quickLogEnabledVal}
        <div class="setting-divider"></div>
        <div class="setting-row" style="flex-direction:column;align-items:flex-start;gap:6px">
          <div class="setting-desc" style="line-height:1.55">
            <strong style="color:var(--text-2)">Trigger words</strong>
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

      <div class="setting-divider"></div>
      <div class="setting-row">
        <div>
          <span class="setting-label">Goal Insights
            <span class="labs-badge" style="background:linear-gradient(135deg,#6366f1,#8b5cf6);vertical-align:middle">Experimental</span>
          </span>
          <div class="setting-desc">The assistant analyzes your intake trends and proactively suggests goal adjustments when patterns are consistent</div>
        </div>
        <Toggle checked={$aiGoalInsights} on:change={e => aiGoalInsights.set(e.detail)} />
      </div>

      {#if !envLocks.ai}
        <div class="setting-divider"></div>
        <div class="form-group" style="padding:10px 16px">
          <label class="form-label" for="ai-api-key">API Key</label>
          <div style="display:flex;gap:8px;align-items:center">
            {#if aiShowKey}
              <input id="ai-api-key" class="input" type="text"
                placeholder="Paste your API key here"
                bind:value={aiApiKeyVal} autocomplete="off" style="flex:1" />
            {:else}
              <input id="ai-api-key" class="input" type="password"
                placeholder="Paste your API key here"
                bind:value={aiApiKeyVal} autocomplete="off" style="flex:1" />
            {/if}
            <button class="btn-icon" on:click={() => aiShowKey = !aiShowKey} title={aiShowKey ? 'Hide' : 'Show'}>
              <span class="material-symbols-rounded">{aiShowKey ? 'visibility_off' : 'visibility'}</span>
            </button>
            <button class="btn btn-primary" style="height:40px;font-size:13px;white-space:nowrap" on:click={saveAiKey}>
              {#if aiKeySaved}<span class="material-symbols-rounded" style="font-size:16px">check</span>{:else}Save{/if}
            </button>
          </div>
          <div class="setting-desc" style="margin-top:6px">
            {#if aiProviderVal === 'claude'}
              Get your key at <a href="https://console.anthropic.com" target="_blank" rel="noopener" class="about-link">console.anthropic.com</a>
            {:else if aiProviderVal === 'openai'}
              Get your key at <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener" class="about-link">platform.openai.com</a>
            {:else if aiProviderVal === 'gemini'}
              Get your key at <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener" class="about-link">aistudio.google.com</a>
            {/if}
            Your key is stored securely on the server.
          </div>
        </div>
      {/if}
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
  .sel-sm { height: 36px; font-size: 13px; }

  .form-group { display: flex; flex-direction: column; gap: 6px; }
  .form-label { font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-3); }

  .labs-badge {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    background: linear-gradient(135deg, #f59e0b, #ef4444);
    color: #fff;
    padding: 2px 6px;
    border-radius: 99px;
    margin-left: 6px;
    vertical-align: middle;
  }

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
