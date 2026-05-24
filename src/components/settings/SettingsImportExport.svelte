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
  import { showSuccess, showError } from '../../stores/toast.js';
  import { DB } from '../../lib/db.js';
  import { NtApi } from '../../lib/api.js';
  import { Nutrition } from '../../lib/nutrition.js';
  import { isNative, getServerUrl } from '../../lib/platform.js';
  import { get } from 'svelte/store';
  import { foodCategories, catName as _catName } from '../../stores/settings.js';

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
        scope: 'foods, meals, recipes, diary (with notes), activity, fasts, settings — wellness-tab data and workouts excluded by design.',
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
      showSuccess('Backup exported');
    } catch(e) { showError('Export failed: ' + e.message); }
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
          for (const [key, value] of Object.entries(data.settings)) DB.setSetting(key, value);
        }

        const importedCats = [...new Set((foodList || []).map(f => (f.categories && f.categories[0]) || f.category).filter(Boolean))];
        if (importedCats.length) {
          const existing = get(foodCategories) || [];
          const existingNames = new Set(existing.map(c => _catName(c)));
          const toAdd = importedCats.filter(n => !existingNames.has(n));
          if (toAdd.length) foodCategories.set([...existing, ...toAdd]);
        }

        showSuccess('Backup restored — reloading...');
        setTimeout(() => location.reload(), 1500);
      } catch(err) { showError('Import failed: ' + err.message); }
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
      const msg = skipped
        ? `Imported ${foods.length} food${foods.length === 1 ? '' : 's'} (${skipped} duplicate barcode${skipped === 1 ? '' : 's'} skipped)`
        : `Imported ${foods.length} food${foods.length === 1 ? '' : 's'}`;
      showSuccess(msg);
      bulkImportOpen = false;
    } catch (err) {
      showError('Import failed: ' + (err.message || 'Unknown error'));
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
      showSuccess('CSV exported');
    } catch(e) { showError('Export failed: ' + e.message); }
  }
</script>

<div class="section-body">
  <!-- Import card -->
  <p class="sub-label">Import</p>
  <div class="card settings-card">
    <button class="setting-row setting-action" on:click={openBulkImport}>
      <span class="material-symbols-rounded si" style="color:var(--accent)">playlist_add</span>
      <div>
        <span class="setting-label">Bulk Import Foods</span>
        <div class="setting-desc">Paste JSON or upload a CSV to add multiple foods at once. Useful for foods that aren't on Open Food Facts. A template is provided so an LLM can extract label data into the right shape.</div>
      </div>
      <span class="material-symbols-rounded text-3" style="font-size:18px;flex-shrink:0">chevron_right</span>
    </button>
    <div class="setting-divider"></div>
    <button class="setting-row setting-action" on:click={importBackup}>
      <span class="material-symbols-rounded si" style="color:var(--accent)">upload</span>
      <div>
        <span class="setting-label">Import JSON Backup</span>
        <div class="setting-desc">Restores from a previously exported JSON file. Merges with existing data, does not erase what's already here.</div>
      </div>
      <span class="material-symbols-rounded text-3" style="font-size:18px;flex-shrink:0">chevron_right</span>
    </button>
  </div>

  <!-- Export card -->
  <p class="sub-label">Export</p>
  <div class="card settings-card">
    <button class="setting-row setting-action" on:click={exportBackup}>
      <span class="material-symbols-rounded si" style="color:var(--accent)">download</span>
      <div>
        <span class="setting-label">Export JSON Backup</span>
        <div class="setting-desc">Lighter portable format, JSON only, no images. Useful for sharing data between accounts or quick text-based exports.</div>
      </div>
      <span class="material-symbols-rounded text-3" style="font-size:18px;flex-shrink:0">chevron_right</span>
    </button>
    <div class="setting-divider"></div>
    <button class="setting-row setting-action" on:click={exportCSV}>
      <span class="material-symbols-rounded si" style="color:var(--info)">table_chart</span>
      <div>
        <span class="setting-label">Export Diary As CSV</span>
        <div class="setting-desc">Downloads your full diary history as a spreadsheet. Useful for analysis in Excel or Google Sheets.</div>
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
  .setting-desc { font-size: 12px; color: var(--text-3); line-height: 1.5; font-weight: 400; }
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
