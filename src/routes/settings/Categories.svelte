<script>
  import { get } from 'svelte/store';
  import { _ } from 'svelte-i18n';
  import { foodCategories, catName as _catName, catDisplay as _catDisplay } from '../../stores/settings.js';
  import 'emoji-picker-element';

  let newCategoryName  = '';
  let newCategoryLabel = '';

  // Emoji picker — mounted imperatively on document.body to avoid
  // position:fixed being trapped by any scrolling/transformed ancestor
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

    // Prefer below button; flip above if it would overflow bottom
    let y = rect.bottom + margin;
    if (y + pickerH > vh - margin) y = rect.top - pickerH - margin;
    // Final clamp so it never leaves the viewport
    y = Math.min(Math.max(y, margin), vh - pickerH - margin);

    let x = rect.left;
    if (x + pickerW > vw - margin) x = vw - pickerW - margin;
    x = Math.max(x, margin);

    _emojiPortal = document.createElement('div');
    _emojiPortal.style.cssText =
      `position:fixed;left:${x}px;top:${y}px;z-index:99999;` +
      `border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,0.35)`;

    const picker = document.createElement('emoji-picker');
    // Inherit CSS custom properties from the document root
    picker.style.cssText =
      '--border-radius:12px;' +
      `--background:${getComputedStyle(document.documentElement).getPropertyValue('--surface-1').trim()};` +
      `--border-color:${getComputedStyle(document.documentElement).getPropertyValue('--border').trim()};` +
      `--input-border-color:${getComputedStyle(document.documentElement).getPropertyValue('--border').trim()};` +
      `--input-font-color:${getComputedStyle(document.documentElement).getPropertyValue('--text-1').trim()};` +
      `--input-placeholder-color:${getComputedStyle(document.documentElement).getPropertyValue('--text-3').trim()};` +
      '--category-emoji-size:1.1rem;--emoji-size:1.4rem';
    picker.addEventListener('emoji-click', ev => {
      newCategoryLabel = ev.detail.unicode;
      _destroyEmojiPicker();
    });

    _emojiPortal.appendChild(picker);
    document.body.appendChild(_emojiPortal);
    setTimeout(() => document.addEventListener('pointerdown', _emojiOutside, true), 50);
  }

  function clickOutside(node, fn) {
    function handle(e) { if (!node.contains(e.target)) fn(); }
    document.addEventListener('pointerdown', handle, true);
    return { destroy() { document.removeEventListener('pointerdown', handle, true); } };
  }

  function addCategory() {
    const name = newCategoryName.trim();
    if (!name) return;
    const cats = get(foodCategories) || [];
    if (cats.some(c => _catName(c) === name)) return;
    const label = newCategoryLabel.trim();
    foodCategories.set([...cats, label ? { name, label } : name]);
    newCategoryName = '';
    newCategoryLabel = '';
  }
  function removeCategory(cat) {
    const n = _catName(cat);
    foodCategories.set((get(foodCategories) || []).filter(c => _catName(c) !== n));
  }
</script>

<div class="section-body">
  <div class="card settings-card">
    <div class="cat-chips-wrap">
      {#each ($foodCategories || []) as cat}
        <div class="chip">
          {_catDisplay(cat)}
          <button class="chip-x" on:click={() => removeCategory(cat)} aria-label={$_('diary.water.remove')}>
            <span class="material-symbols-rounded" style="font-size:14px">close</span>
          </button>
        </div>
      {/each}
      {#if ($foodCategories || []).length === 0}
        <span class="text-3 text-sm">{$_('settings_stats.no_categories')}</span>
      {/if}
    </div>
    <div class="setting-divider"></div>
    <div class="cat-add-row">
      <div style="display:flex;flex-direction:column;gap:3px;flex-shrink:0;position:relative">
        <span style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--text-3);text-align:center">{$_('settings_stats.label')}</span>
        <button class="input emoji-btn" title={$_('extracted.settings.pick_an_emoji_label_379')}
          on:click={openEmojiPicker}>
          {newCategoryLabel || '🏷️'}
        </button>
      </div>
      <div style="display:flex;flex-direction:column;gap:3px;flex:1">
        <span style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--text-3)">{$_('extracted.settings.category_name_380')}</span>
        <input class="input" style="height:40px" placeholder={$_('extracted.settings.e_g_dairy_proteins_381')}
          bind:value={newCategoryName} on:keydown={e => e.key==='Enter' && addCategory()} />
      </div>
      <button class="btn btn-secondary" style="height:40px;padding:0 16px;align-self:flex-end" on:click={addCategory}>{$_('diary.water.add')}</button>
    </div>
  </div>
</div>
