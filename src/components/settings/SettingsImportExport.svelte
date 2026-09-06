<script>
  /**
   * Settings → Import & Export
   *
   * Holds the lightweight per-dataset import/export rows (JSON portable
   * export, JSON portable import, Bulk Import Foods, Export Diary as CSV).
   * Full-account backup snapshots live in SettingsBackup.svelte;
   * "Import from another app" (MFP/Cronometer/LoseIt) lives in
   * SettingsNutritionImport.svelte. Both render alongside this one under
   * the same Settings section.
   */
  import BulkImportModal from '../foods/BulkImportModal.svelte';
  import { _ } from 'svelte-i18n';
  import { showSuccess, showError } from '../../stores/toast.js';
  import { DB } from '../../lib/db.js';
  import { NtApi } from '../../lib/api.js';
  import { Nutrition, NUTRIMENTS } from '../../lib/nutrition.js';
  import { isNative, getServerUrl } from '../../lib/platform.js';
  import { get } from 'svelte/store';
  import { foodCategories, catName as _catName, bulkSet, customNutriments, mealNames } from '../../stores/settings.js';

  const isNativeLocal = isNative && !getServerUrl();

  // Native: use Capacitor Filesystem for downloads
  async function _nativeDownload(blob, filename) {
    const { Filesystem, Directory } = await import('@capacitor/filesystem');
    const reader = new FileReader();
    const base64 = await new Promise((res, rej) => {
      reader.onload = () => res(reader.result.split(',')[1]);
      reader.onerror = rej;
      reader.readAsDataURL(blob);
    });
    await Filesystem.writeFile({ path: `Download/${filename}`, data: base64, directory: Directory.ExternalStorage, recursive: true });
    showSuccess(`Saved to Downloads/${filename}`);
  }

  function _downloadBlob(blob, filename) {
    if (isNative) { _nativeDownload(blob, filename); return; }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ── Portable JSON Export ────────────────────────────────────────────────────
  async function exportBackup() {
    try {
      const [foodList, meals, recipes, diary] = await Promise.all([
        NtApi.getFoods(),
        NtApi.getMeals(),
        NtApi.getRecipes(),
        NtApi.getAllDiary(),
      ]);
      let activity = [];
      try { activity = await NtApi.getActivityRange('1900-01-01', '2999-12-31') || []; } catch {}
      let fasts = [];
      try { fasts = await NtApi.get('/api/fasts?limit=10000') || []; } catch {}

      const settings = DB.getAllSettings() || {};
      const { APP_VERSION } = await import('../../lib/version.js').catch(() => ({ APP_VERSION: 'unknown' }));
      const _manifest = {
        format: 'nutritrace-portable-export',
        schema_version: 1,
        app_version: APP_VERSION,
        exported_at: new Date().toISOString(),
        source: isNative ? (getServerUrl() ? 'native-server' : 'native-local') : 'web',
        includes_images: false,
        scope: 'foods, meals, recipes, diary (with notes), activity, fasts, settings. Excluded by design: wellness metrics + Trace-computed scores, workouts, AI chat history, food/meal sharing grants, federation API tokens, and OAuth wearable tokens. Use Local Full Backup (.zip) for those.',
        note: 'For a comprehensive backup with embedded image files, use Local Full Backup (.zip).',
        counts: {
          foods:     foodList?.length || 0,
          meals:     meals?.length    || 0,
          recipes:   recipes?.length  || 0,
          diary:     diary?.length    || 0,
          activity:  activity?.length || 0,
          fasts:     fasts?.length    || 0,
          settings:  Object.keys(settings).length,
        },
      };

      const data = {
        _manifest, foodList, meals, recipes, diary, activity, fasts, settings,
        exportedAt: _manifest.exported_at,
      };
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      _downloadBlob(blob, `nutritrace-backup-${new Date().toISOString().slice(0,10)}.json`);
      showSuccess($_('settings_import_export.toast.backup_exported'));
    } catch(e) { showError($_('settings_import_export.toast.export_failed_prefix', { values: { error: e.message } })); }
  }

  async function importBackup() {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = '.json';
    input.onchange = async (e) => {
      const file = e.target.files[0]; if (!file) return;
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        async function migrateImg(item) {
          if (!item.imgUrl || !item.imgUrl.startsWith('data:')) return item;
          try {
            const blob = await fetch(item.imgUrl).then(r => r.blob());
            const file = new File([blob], 'photo.jpg', { type: blob.type || 'image/jpeg' });
            const url = await NtApi.uploadImage(file);
            return { ...item, imgUrl: url };
          } catch { return { ...item, imgUrl: '' }; }
        }
        const migrateAll = arr => Promise.all((arr || []).map(migrateImg));
        const [foodList, meals, recipes] = await Promise.all([
          migrateAll(data.foodList),
          migrateAll(data.meals),
          migrateAll(data.recipes),
        ]);

        if (isNativeLocal) {
          const dbm = await import('../../lib/db-native.js');
          for (const food of (foodList || [])) await dbm.dbCreateFood(food).catch(() => {});
          for (const meal of (meals || [])) await dbm.dbCreateMeal(meal).catch(() => {});
          for (const meal of (recipes || [])) await dbm.dbCreateMeal({ ...meal, is_recipe: 1 }).catch(() => {});
          for (const entry of (data.diary || [])) {
            if (entry.date) await dbm.dbSaveDiaryDate(entry.date, entry).catch(() => {});
          }
          for (const a of (data.activity || [])) await dbm.dbCreateActivity(a).catch(() => {});
        } else {
          await NtApi.post('/api/data/import', { ...data, foodList, meals, recipes });
        }

        if (data.settings && typeof data.settings === 'object') {
          // bulkSet writes to localStorage + native SQLite AND pushes to the
          // server for USER_PREFS keys. A plain DB.setSetting() loop stops at
          // localStorage, so the next 30s server pull would rehydrate the old
          // pre-import values on PWA and silently blow away the imported ones.
          await bulkSet(data.settings);
        }

        const importedCats = [...new Set((foodList || []).map(f => (f.categories && f.categories[0]) || f.category).filter(Boolean))];
        if (importedCats.length) {
          const existing = get(foodCategories) || [];
          const existingNames = new Set(existing.map(c => _catName(c)));
          const toAdd = importedCats.filter(n => !existingNames.has(n));
          if (toAdd.length) foodCategories.set([...existing, ...toAdd]);
        }

        showSuccess($_('settings_import_export.toast.backup_restored_reload'));
        setTimeout(() => location.reload(), 1500);
      } catch(err) { showError($_('settings_import_export.toast.import_failed_prefix', { values: { error: err.message } })); }
    };
    input.click();
  }

  // ── Bulk Food Import ─────────────────────────────────────────────────────────
  let bulkImportOpen = false;
  let bulkImportBarcodes = [];

  async function openBulkImport() {
    try {
      if (isNativeLocal) {
        const dbm = await import('../../lib/db-native.js');
        const foods = await dbm.dbGetFoods();
        bulkImportBarcodes = (foods || []).map(f => f.barcode).filter(Boolean);
      } else {
        const foods = await NtApi.getFoods();
        bulkImportBarcodes = (foods || []).map(f => f.barcode).filter(Boolean);
      }
    } catch (_) {
      bulkImportBarcodes = [];
    }
    bulkImportOpen = true;
  }

  async function handleBulkImportCommit(e) {
    const { foods, skipped } = e.detail;
    if (!foods?.length) return;
    try {
      if (isNativeLocal) {
        const dbm = await import('../../lib/db-native.js');
        for (const f of foods) await dbm.dbCreateFood(f).catch(() => {});
      } else {
        await NtApi.post('/api/data/import', { foodList: foods });
        // Native server mode: foods now live on the server but won't appear
        // in the Android Foods tab until the background sync pulls them
        // (30-60s). Trigger an immediate sync so they show up right away
        // (#39 followup — nomad64).
        if (isNative && getServerUrl()) {
          try {
            const { fullSync } = await import('../../lib/sync.js');
            await fullSync(true);
          } catch (e) {
            // Sync failure is non-fatal — foods are safe on the server,
            // they'll appear on the next scheduled sync.
            console.warn('[bulk-import] post-import sync failed:', e.message);
          }
        }
      }
      const isOne = foods.length === 1;
      const msg = skipped
        ? $_(isOne ? 'settings_import_export.toast.imported_food_skipped' : 'settings_import_export.toast.imported_foods_skipped', { values: { n: foods.length, skipped } })
        : $_(isOne ? 'settings_import_export.toast.imported_foods_one' : 'settings_import_export.toast.imported_foods', { values: { n: foods.length } });
      showSuccess(msg);
      bulkImportOpen = false;
    } catch (err) {
      showError($_('settings_import_export.toast.import_failed_prefix', { values: { error: err.message || $_('settings_import_export.toast.unknown_error') } }));
    }
  }

  // ── Diary CSV Export ────────────────────────────────────────────────────────
  async function exportCSV() {
    try {
      const diary = await NtApi.getAllDiary();
      let csv = 'Date,Meal,Food,Amount,Unit,Calories,Fat,Carbs,Protein\n';
      diary.forEach(day => {
        (day.items || []).forEach(item => {
          const n = Nutrition.calculate(item);
          csv += `${day.date},${item.meal||0},"${item.name||''}",${item.portion||100},${item.unit||'g'},${Math.round(n.calories||0)},${(n.fat||0).toFixed(1)},${(n.carbohydrates||0).toFixed(1)},${(n.proteins||0).toFixed(1)}\n`;
        });
      });
      const blob = new Blob([csv], { type: 'text/csv' });
      _downloadBlob(blob, `nutritrace-diary-${new Date().toISOString().slice(0,10)}.csv`);
      showSuccess($_('settings_import_export.toast.csv_exported'));
    } catch(e) { showError($_('settings_import_export.toast.export_failed_prefix', { values: { error: e.message } })); }
  }

  // ── Full Nutrition CSV Export (#202) ────────────────────────────────────────
  // Long-form export intended for spreadsheets, personal databases, and
  // long-term analytics workflows (Cronometer refugees, TBCA users, etc).
  // One row per diary item. Columns:
  //   Date, Time, Meal, Food, Brand, Amount, Unit,
  //   <every built-in NUTRIMENT with unit in header>,
  //   <every user-defined custom nutrient with unit in header>.
  // Empty cells for absent nutrients so the target tool distinguishes
  // "unknown" from "zero" (reporter's spec, matches Cronometer's convention).
  // Time is ISO 8601 from item.addedAt when present, else empty; date is
  // the diary day. Meal renders the user's configured meal name (not the
  // raw 0..3 index) so the export is human-readable at a glance.
  async function exportFullNutritionCSV() {
    try {
      const diary = await NtApi.getAllDiary();
      const customs = get(customNutriments) || [];
      const meals   = get(mealNames) || ['Breakfast','Lunch','Dinner','Snacks'];
      const nutCols = [
        ...NUTRIMENTS.map(n => ({ id: n.id, header: `${n.label} (${n.unit})` })),
        ...customs.map(n => ({ id: n.id, header: `${n.label} (${n.unit || ''})`.replace(/ \(\)$/, '') })),
      ];
      const header = [
        'Date', 'Time', 'Meal', 'Food', 'Brand', 'Amount', 'Unit',
        ...nutCols.map(c => c.header),
      ].map(_csvEscape).join(',');
      const lines = [header];
      diary.forEach(day => {
        (day.items || []).forEach(item => {
          const n = Nutrition.calculate(item);
          const mealIdx = Number(item.meal) || 0;
          const mealName = meals[mealIdx] ?? `Meal ${mealIdx + 1}`;
          const time = item.addedAt || '';
          const row = [
            _csvEscape(day.date),
            _csvEscape(time),
            _csvEscape(mealName),
            _csvEscape(item.name || ''),
            _csvEscape(item.brand || ''),
            item.portion ?? 100,
            _csvEscape(item.unit || 'g'),
            ...nutCols.map(c => {
              const v = n[c.id];
              // Empty rather than zero when the value is absent, so the
              // consumer tool can tell "not measured" from "actually zero".
              if (v == null || v === '' || Number.isNaN(Number(v))) return '';
              return Number(v).toFixed(2).replace(/\.?0+$/, '');
            }),
          ];
          lines.push(row.join(','));
        });
      });
      const csv = lines.join('\n') + '\n';
      const blob = new Blob([csv], { type: 'text/csv' });
      _downloadBlob(blob, `nutritrace-diary-full-${new Date().toISOString().slice(0,10)}.csv`);
      showSuccess($_('settings_import_export.toast.csv_exported'));
    } catch(e) { showError($_('settings_import_export.toast.export_failed_prefix', { values: { error: e.message } })); }
  }

  // ── Activity CSV Export (#77) ───────────────────────────────────────────────
  // Separate from the diary export because rows have a different shape
  // (no meal / no portion / MET column). Same all-history range as diary.
  function _csvEscape(v) {
    if (v == null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }
  async function exportActivityCSV() {
    try {
      const rows = await NtApi.getActivityRange('1900-01-01', '2999-12-31') || [];
      let csv = 'Date,Name,Calories,DurationMin,Distance,Source,MET,IsTemplate\n';
      rows.forEach(r => {
        csv += [
          _csvEscape(r.date),
          _csvEscape(r.name),
          Math.max(0, Math.round(Number(r.kcal) || 0)),
          r.duration_min ?? '',
          _csvEscape(r.distance),
          _csvEscape(r.source || 'manual_form'),
          r.met != null ? Number(r.met).toFixed(1) : '',
          r.is_template ? 1 : 0,
        ].join(',') + '\n';
      });
      const blob = new Blob([csv], { type: 'text/csv' });
      _downloadBlob(blob, `nutritrace-activity-${new Date().toISOString().slice(0,10)}.csv`);
      showSuccess($_('settings_import_export.toast.activity_csv_exported'));
    } catch(e) { showError($_('settings_import_export.toast.export_failed_prefix', { values: { error: e.message } })); }
  }
</script>

<div class="section-body">
  <!-- Import card -->
  <p class="settings-group-heading">{$_('settings_import_export.sections.import')}</p>
  <p class="settings-group-sub">Pull data in: bulk-add foods by barcode list, or restore a NutriTrace JSON export.</p>
  <div class="card settings-card">
    <button class="setting-row setting-action" on:click={openBulkImport}>
      <span class="material-symbols-rounded si" style="color:var(--accent)">playlist_add</span>
      <div>
        <span class="setting-label">{$_('settings_import_export.actions.bulk_import')}</span>
        <div class="setting-desc">{$_('settings_import_export.actions.bulk_import_desc')}</div>
      </div>
      <span class="material-symbols-rounded text-3" style="font-size:18px;flex-shrink:0">chevron_right</span>
    </button>
    <div class="setting-divider"></div>
    <button class="setting-row setting-action" on:click={importBackup}>
      <span class="material-symbols-rounded si" style="color:var(--accent)">upload</span>
      <div>
        <span class="setting-label">{$_('settings_import_export.actions.import_json')}</span>
        <div class="setting-desc">{$_('settings_import_export.actions.import_json_desc')}</div>
      </div>
      <span class="material-symbols-rounded text-3" style="font-size:18px;flex-shrink:0">chevron_right</span>
    </button>
  </div>

  <!-- Export card -->
  <p class="settings-group-heading">{$_('settings_import_export.sections.export')}</p>
  <p class="settings-group-sub">Portable JSON snapshot or CSV of your diary or activity log.</p>
  <div class="card settings-card">
    <button class="setting-row setting-action" on:click={exportBackup}>
      <span class="material-symbols-rounded si" style="color:var(--accent)">download</span>
      <div>
        <span class="setting-label">{$_('settings_import_export.actions.export_json')}</span>
        <div class="setting-desc">{$_('settings_import_export.actions.export_json_desc')}</div>
      </div>
      <span class="material-symbols-rounded text-3" style="font-size:18px;flex-shrink:0">chevron_right</span>
    </button>
    <div class="setting-divider"></div>
    <button class="setting-row setting-action" on:click={exportCSV}>
      <span class="material-symbols-rounded si" style="color:var(--info)">table_chart</span>
      <div>
        <span class="setting-label">{$_('settings_import_export.actions.export_diary_csv')}</span>
        <div class="setting-desc">{$_('settings_import_export.actions.export_diary_csv_desc')}</div>
      </div>
      <span class="material-symbols-rounded text-3" style="font-size:18px;flex-shrink:0">chevron_right</span>
    </button>
    <div class="setting-divider"></div>
    <button class="setting-row setting-action" on:click={exportFullNutritionCSV}>
      <span class="material-symbols-rounded si" style="color:var(--info)">assessment</span>
      <div>
        <span class="setting-label">{$_('settings_import_export.actions.export_full_nutrition_csv')}</span>
        <div class="setting-desc">{$_('settings_import_export.actions.export_full_nutrition_csv_desc')}</div>
      </div>
      <span class="material-symbols-rounded text-3" style="font-size:18px;flex-shrink:0">chevron_right</span>
    </button>
    <div class="setting-divider"></div>
    <button class="setting-row setting-action" on:click={exportActivityCSV}>
      <span class="material-symbols-rounded si" style="color:var(--info)">directions_run</span>
      <div>
        <span class="setting-label">{$_('settings_import_export.actions.export_activity_csv')}</span>
        <div class="setting-desc">{$_('settings_import_export.actions.export_activity_csv_desc')}</div>
      </div>
      <span class="material-symbols-rounded text-3" style="font-size:18px;flex-shrink:0">chevron_right</span>
    </button>
  </div>
</div>

<BulkImportModal
  bind:open={bulkImportOpen}
  existingBarcodes={bulkImportBarcodes}
  on:commit={handleBulkImportCommit}
/>

<style>
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
  .setting-action {
    width: 100%;
    text-align: left;
    cursor: pointer;
    background: none;
    border: none;
    color: var(--text-1);
  }
  .setting-action:hover { background: var(--surface-2); }
  .setting-label { font-size: 14px; font-weight: 500; }
  .setting-divider { height: 1px; background: var(--border); margin: 0 16px; }
  .si { font-size: 22px; flex-shrink: 0; }
  .sub-label {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--text-3);
    margin: 14px 4px 4px;
  }
  .sub-label:first-child { margin-top: 4px; }
</style>
