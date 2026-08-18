<script>
  import { get } from 'svelte/store';
  import { _ } from 'svelte-i18n';
  import { exercisePeople, catName as _catName, catDisplay as _catDisplay } from '../../stores/settings.js';
  import 'emoji-picker-element';

  let newPersonName  = '';
  let newPersonLabel = '';

  let _emojiPortal = null;

  function _destroyEmojiPicker() {
    if (_emojiPortal) { _emojiPortal.remove(); _emojiPortal = null; }
    document.removeEventListener('pointerdown', _emojiOutside, true);
  }

  function _emojiOutside(e) {
    if (_emojiPortal && !_emojiPortal.contains(e.target)) _destroyEmojiPicker();
  }

  function openEmojiPicker(e) {
    if (_emojiPortal) { _destroyEmojiPicker(); return; }

    const rect    = e.currentTarget.getBoundingClientRect();
    const pickerH = 420;
    const pickerW = 320;
    const margin  = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let y = rect.bottom + margin;
    if (y + pickerH > vh - margin) y = rect.top - pickerH - margin;
    y = Math.min(Math.max(y, margin), vh - pickerH - margin);

    let x = rect.left;
    if (x + pickerW > vw - margin) x = vw - pickerW - margin;
    x = Math.max(x, margin);

    _emojiPortal = document.createElement('div');
    _emojiPortal.style.cssText =
      `position:fixed;left:${x}px;top:${y}px;z-index:99999;` +
      `border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,0.35)`;

    const picker = document.createElement('emoji-picker');
    picker.style.cssText =
      '--border-radius:12px;' +
      `--background:${getComputedStyle(document.documentElement).getPropertyValue('--surface-1').trim()};` +
      `--border-color:${getComputedStyle(document.documentElement).getPropertyValue('--border').trim()};` +
      `--input-border-color:${getComputedStyle(document.documentElement).getPropertyValue('--border').trim()};` +
      `--input-font-color:${getComputedStyle(document.documentElement).getPropertyValue('--text-1').trim()};` +
      `--input-placeholder-color:${getComputedStyle(document.documentElement).getPropertyValue('--text-3').trim()};` +
      '--category-emoji-size:1.1rem;--emoji-size:1.4rem';
    picker.addEventListener('emoji-click', ev => {
      newPersonLabel = ev.detail.unicode;
      _destroyEmojiPicker();
    });

    _emojiPortal.appendChild(picker);
    document.body.appendChild(_emojiPortal);
    setTimeout(() => document.addEventListener('pointerdown', _emojiOutside, true), 50);
  }

  function addPerson() {
    const name = newPersonName.trim();
    if (!name) return;
    const cats = get(exercisePeople) || [];
    if (cats.some(c => _catName(c) === name)) return;
    const label = newPersonLabel.trim();
    exercisePeople.set([...cats, label ? { name, label } : name]);
    newPersonName = '';
    newPersonLabel = '';
  }
  function removePerson(cat) {
    const n = _catName(cat);
    exercisePeople.set((get(exercisePeople) || []).filter(c => _catName(c) !== n));
  }
</script>

<div class="section-body">
  <div class="card settings-card">
    <p class="setting-desc" style="padding:14px 16px 0">{$_('settings.people.help')}</p>
    <div class="cat-chips-wrap">
      {#each ($exercisePeople || []) as cat}
        <div class="chip">
          {_catDisplay(cat)}
          <button class="chip-x" on:click={() => removePerson(cat)} aria-label={$_('common.delete')}>
            <span class="material-symbols-rounded" style="font-size:14px">close</span>
          </button>
        </div>
      {/each}
      {#if ($exercisePeople || []).length === 0}
        <span class="text-3 text-sm">{$_('settings.people.empty')}</span>
      {/if}
    </div>
    <div class="setting-divider"></div>
    <div class="cat-add-row">
      <div style="display:flex;flex-direction:column;gap:3px;flex-shrink:0;position:relative">
        <span style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--text-3);text-align:center">{$_('settings_stats.label')}</span>
        <button class="input emoji-btn" title={$_('settings.people.pick_label')}
          on:click={openEmojiPicker}>
          {newPersonLabel || '🏷️'}
        </button>
      </div>
      <div style="display:flex;flex-direction:column;gap:3px;flex:1">
        <span style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--text-3)">{$_('settings.people.name_label')}</span>
        <input class="input" style="height:40px" placeholder={$_('settings.people.name_placeholder')}
          bind:value={newPersonName} on:keydown={e => e.key==='Enter' && addPerson()} />
      </div>
      <button class="btn btn-secondary" style="height:40px;padding:0 16px;align-self:flex-end" on:click={addPerson}>{$_('exercises.add')}</button>
    </div>
  </div>
</div>
