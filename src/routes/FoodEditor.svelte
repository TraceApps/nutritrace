<script>
  import { onMount, tick } from 'svelte';
  import { slide } from 'svelte/transition';
  import { _ } from 'svelte-i18n';

  import { portal } from '../lib/portal.js';
  import { pop, push } from 'svelte-spa-router';
  import { NtApi } from '../lib/api.js';
  import { NUTRIMENTS } from '../lib/nutrition.js';
  import { showSuccess, showError } from '../stores/toast.js';
  import { editorState, clearFoodEditorState } from '../stores/editorState.js';
  import Toggle from '../components/settings/Toggle.svelte';
  import UnitPicker from '../components/ui/UnitPicker.svelte';
  import ImageCropper from '../components/ui/ImageCropper.svelte';
  import { takePhoto } from '../lib/camera.js';
  import { isNative } from '../lib/platform.js';
  import BarcodeScanner from '../components/foods/BarcodeScanner.svelte';
  import { foodsShowCategories, foodsShowLabels, foodsShowNotes, foodCategories, visibleNutriments, nutrimentsOrder, customNutriments, cropPhotos, offUsername, offPassword, offUploadCountry, aiEffectivelyEnabled, envLocks, aiProvider, aiApiKey, aiModel, aiBaseUrl, energyUnit, showUnitMetadata, warnUnitMismatch, catName as _catName, catDisplay as _catDisplay, disableAnimations } from '../stores/settings.js';
  import { callAI, callAIProxy } from '../lib/aiChat.js';
  import { fitImageDataUrl } from '../lib/image-fit.js';
  import { draftKey as _mkDraftKey, loadDraft, loadDraftImg, clearDraft, makeDebouncedPersist } from '../lib/editor-draft.js';
  import { acquireScreenWakeLock } from '../lib/wake-lock.js';
  import { decimalInput, parseDecimal } from '../lib/decimal-input.js';

  // ── Photo capture / upload ─────────────────────────────────
  let fileInput;
  let showCamera  = false;
  let showUrlInput = false;
  let photoUrl = '';
  function applyPhotoUrl() {
    const url = photoUrl.trim();
    if (url) { food.imgUrl = url; }
    showUrlInput = false;
    photoUrl = '';
  }
  let cameraVideo = null;
  let cameraStream = null;
  let showCrop    = false;
  let cropSrc     = '';

  function openGallery() { fileInput && fileInput.click(); }

  function onFileChange(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async ev => {
      if ($cropPhotos) {
        cropSrc = ev.target.result;
        showCrop = true;
      } else {
        // Downscale to keep payload under the server's 1MB JSON limit.
        // Preserves aspect ratio — no cropping.
        food.imgUrl = await fitImageDataUrl(ev.target.result);
      }
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  }

  async function openCamera() {
    if (isNative) {
      try {
        const file = await takePhoto();
        if (!file) return;
        const reader = new FileReader();
        reader.onload = async ev => {
          if ($cropPhotos) { cropSrc = ev.target.result; showCrop = true; }
          else { food.imgUrl = await fitImageDataUrl(ev.target.result); }
        };
        reader.readAsDataURL(file);
      } catch { /* user cancelled */ }
      return;
    }
    showCamera = true;
    await new Promise(r => setTimeout(r, 80));
    try {
      cameraStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } }
      });
      if (cameraVideo) { cameraVideo.srcObject = cameraStream; cameraVideo.play(); }
    } catch(err) {
      showCamera = false;
      showError($_('food_editor.toast.camera_denied'));
    }
  }

  function stopCamera() {
    if (cameraStream) { cameraStream.getTracks().forEach(t => t.stop()); cameraStream = null; }
    showCamera = false;
  }

  async function capturePhoto() {
    if (!cameraVideo) return;
    const canvas = document.createElement('canvas');
    canvas.width = cameraVideo.videoWidth;
    canvas.height = cameraVideo.videoHeight;
    canvas.getContext('2d').drawImage(cameraVideo, 0, 0);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
    stopCamera();
    if ($cropPhotos) {
      cropSrc = dataUrl;
      showCrop = true;
    } else {
      food.imgUrl = await fitImageDataUrl(dataUrl);
    }
  }

  function removePhoto() { food.imgUrl = ''; }

  export let params = {};

  let food = {
    name:'', brand:'', barcode:'', imgUrl:'',
    portion: 100, unit: 'g', categories: [], notes: '',
    // Issues #69 + #70: OFF unit metadata. nutrition_basis null = "unknown,
    // treat as today's behavior"; alt_units empty = no per-food unit
    // overrides; density null = no cross-system bridge available.
    nutrition_basis: null,
    alt_units: [],
    density_g_ml: null,
    calories: '', kilojoules: '', fat: '', 'saturated-fat': '', 'trans-fat': '', 'polyunsaturated-fat': '', 'monounsaturated-fat': '', carbohydrates: '',
    sugars: '', 'added-sugars': '', proteins: '', salt: '', fiber: '',
    sodium: '', cholesterol: '', potassium: '', caffeine: '', alcohol: '',
    calcium: '', iron: '', magnesium: '', zinc: '', phosphorus: '',
    'vitamin-c': '', 'vitamin-a': '', 'vitamin-d': '', 'vitamin-e': '', 'vitamin-k': '',
    b1: '', b2: '', b3: '', b6: '', b9: '', b12: '',
    // _derived: { sodium?: true, salt?: true } — set when sodium/salt was
    // auto-calculated from the other field via the regulatory factor (× 2.5
    // / × 0.4). Cleared when the user manually edits the field. Persisted
    // in nutrition._derived on the saved food so the calculator icon
    // survives reloads.
    _derived: {},
  };
  let store = 'foodList';
  let saving = false;
  let showAllNutrients = false;
  let contributing = false;
  let offSuccess = false;
  // Off by default — proportional scaling can surprise users editing a single
  // value (e.g. correcting a typo'd protein gram). User opts in via the link
  // toggle next to the unit selector.
  let linked = false;
  // Snapshot of values used as the baseline for proportional scaling.
  // Captured the moment the user flips `linked` on, NOT at mount: at
  // mount the food may be empty (new food), and even for edit-food the
  // user may have started typing before flipping linked on. Re-taking
  // it on toggle means the snapshot reflects the user's "lock these
  // proportions in" intent, not whatever was loaded.
  let _snapshot = null;
  let downloading = false;
  let downloadSuccess = false;
  let editorScannerOpen = false;
  // Cached list of the user's foods, used for client-side duplicate-barcode
  // detection. Populated once on mount; refreshed only when the editor saves
  // (so a save+stay-open flow can re-check). Whitespace + leading-zero
  // normalisation matches the picker-page lookup behaviour.
  let _myFoods = [];
  let duplicateOf = null;
  $: isNewFood = !(params && params.id);

  // ── Draft persistence (#157) ────────────────────────────────────────────
  // Samsung camera-mode lmkd kills the WebView renderer, Chromium kills
  // the host, Android cold-starts us into an empty form. Persisting the
  // draft to localStorage lets the remount restore what the user had
  // typed. See src/lib/editor-draft.js for the shared helper.
  // Draft key must be tied to the food's IDENTITY, not the URL. Every
  // food edit pushes /foods/edit with no :id, so params.id is undefined
  // whether the user is adding new or editing existing. The identity
  // lives on editorState.foodPrefill.id. Without this, every session
  // shares one 'new' draft key and typing while editing food A leaks
  // into a subsequent "add new food" (Wildenhaus, #157).
  $: _draftKey = _mkDraftKey('food', params?.id ?? editorState.foodPrefill?.id ?? null);
  let _draftReady = false;      // gate: don't persist before onMount overlays the draft
  let _persistDraft = null;
  $: if (_draftKey) _persistDraft = makeDebouncedPersist(_draftKey, 400);
  // Fire on every food change once we're past mount. Debounced inside
  // makeDebouncedPersist so rapid typing collapses into a single write.
  $: if (_draftReady && _persistDraft) _persistDraft(food);
  // Banner state: true once a draft has been overlaid, so the user can
  // tell "restored from earlier" apart from "clean form". Discard button
  // resets to the pre-overlay server baseline and clears the draft.
  let _draftRestored = false;
  let _serverBaseline = null;
  $: hasBarcode = !!(food.barcode && food.barcode.trim());

  function _normBarcode(b) {
    return String(b || '').trim().replace(/^0+/, '');
  }
  // Reactively check for a duplicate barcode in the user's library whenever
  // the field changes. Excludes the food currently being edited so editing
  // an existing food doesn't flag itself.
  $: {
    if (!food.barcode || !food.barcode.trim()) {
      duplicateOf = null;
    } else if (_myFoods && _myFoods.length) {
      const codeN = _normBarcode(food.barcode);
      duplicateOf = _myFoods.find(f =>
        f.id !== food.id && f.barcode && _normBarcode(f.barcode) === codeN
      ) || null;
    }
  }

  // Inline scan handler — populate the barcode field, then auto-prefill the
  // form from OFF if the user hasn't typed anything substantive yet. Skips
  // the auto-prefill when the user has already filled name + nutrition so
  // we don't clobber curated data.
  async function onEditorScan({ detail }) {
    const code = detail?.code;
    if (!code) return;
    food.barcode = code;
    food = food;
    const looksEmpty = !food.name?.trim() && !food.brand?.trim() &&
      (food.nutrition == null || Object.keys(food.nutrition || {}).length === 0) &&
      !NUTRIMENTS.some(n => food[n.id] != null && food[n.id] !== '');
    if (looksEmpty) {
      // Re-use the existing smart-fill that only writes empty fields.
      await downloadFromOFF();
    } else {
      showSuccess($_('food_editor.toast.barcode_set'));
    }
  }


  let offVerified    = null;  // null = unchecked, true = confirmed, false = not found yet
  // OFF presence check for the barcode, drives the Share vs View button
  // label. null = not yet checked. true = product is in OFF (button is
  // "View on OFF"). false = not in OFF (button is "Share to OFF").
  let offProductExists = null;
  let _lastCheckedBarcode = null;

  async function _refreshOffPresence() {
    if (!food.barcode) { offProductExists = null; return; }
    if (_lastCheckedBarcode === food.barcode) return; // no-op refresh
    _lastCheckedBarcode = food.barcode;
    try {
      const { API } = await import('../lib/api.js');
      const existing = await API.lookupBarcode(food.barcode);
      offProductExists = !!existing;
    } catch {
      // Network failure shouldn't lock the button — treat as "unknown,
      // assume not in OFF" so the Share path stays reachable.
      offProductExists = false;
    }
  }
  $: if (food.barcode && food.barcode !== _lastCheckedBarcode) _refreshOffPresence();

  async function _openOffPage() {
    const url = 'https://world.openfoodfacts.org/product/' + encodeURIComponent(food.barcode);
    try {
      const { isNative } = await import('../lib/platform.js');
      if (isNative) {
        const { Browser } = await import('@capacitor/browser');
        await Browser.open({ url });
      } else {
        window.open(url, '_blank', 'noopener');
      }
    } catch {
      window.open(url, '_blank', 'noopener');
    }
  }

  async function shareOrViewOnOFF() {
    if (offProductExists) {
      await _openOffPage();
      return;
    }
    contributing = true; offSuccess = false; offVerified = null;
    try {
      const { API } = await import('../lib/api.js');
      // Final pre-flight lookup in case the local cached state is stale
      // (e.g. someone else contributed the product after we last checked).
      const existing = await API.lookupBarcode(food.barcode);
      if (existing) {
        offProductExists = true;
        contributing = false;
        await _openOffPage();
        return;
      }
      await _doUploadToOFF(API);
      offProductExists = true; // we just contributed it, mark as present
    } catch(e) {
      showError($_('food_editor.toast.off_upload_failed', { values: { error: e.message } }));
      contributing = false;
    }
  }

  async function _doUploadToOFF(API) {
    const { NUTRIMENTS: NUT } = await import('../lib/nutrition.js');
    const nutrition = {};
    for (const n of NUT) {
      const v = food[n.id];
      if (v !== undefined && v !== '' && v !== null && !isNaN(parseFloat(v)))
        nutrition[n.id] = parseFloat(v);
    }
    await API.contributeToOFF(
      { name: food.name, barcode: food.barcode, brand: food.brand,
        portion: food.portion, unit: food.unit, nutrition },
      { offUsername: $offUsername, offPassword: $offPassword,
        offUploadCountry: $offUploadCountry }
    );
    offSuccess = true;
    contributing = false;
    // Give OFF a few seconds to index, then verify the product is live
    setTimeout(async () => {
      try {
        const found = await API.lookupBarcode(food.barcode);
        offVerified = !!found;
      } catch { offVerified = false; }
    }, 3000);
  }

  function takeSnapshot() {
    const allNuts = [...NUTRIMENTS, ...($customNutriments || [])];
    _snapshot = { portion: parseDecimal(food.portion) || 0 };
    for (const n of allNuts) _snapshot[n.id] = parseDecimal(food[n.id]) || 0;
  }

  let _scaleTimer = null;

  function applyProportional(changedId, newVal) {
    if (!linked || !_snapshot) return;
    const origVal = changedId === '__portion__' ? _snapshot.portion : _snapshot[changedId];
    if (!origVal || origVal <= 0 || newVal <= 0) return;
    const ratio = newVal / origVal;
    const allNuts = [...NUTRIMENTS, ...($customNutriments || [])];
    for (const n of allNuts) {
      if (n.id === changedId) continue;
      const v = _snapshot[n.id];
      if (v > 0) food[n.id] = Math.round(v * ratio * 10000) / 10000;
    }
    if (changedId !== '__portion__') {
      if (_snapshot.portion > 0) food.portion = Math.round(_snapshot.portion * ratio * 100) / 100;
    }
    food = { ...food };
  }

  function scheduleScale(changedId, getVal) {
    clearTimeout(_scaleTimer);
    _scaleTimer = setTimeout(() => { applyProportional(changedId, getVal()); }, 400);
  }

  function onPortionInput() { scheduleScale('__portion__', () => parseDecimal(food.portion) || 0); }
  function onNutInput(id)   {
    // Per-nutrient typing does NOT trigger proportional scaling. The
    // link toggle is for "scale all nutrients to a new serving size",
    // not "rescale everything when I correct a single value." Keeping
    // scale on nutrient edits would surprise users fixing a typo'd
    // protein gram with a cascade across every other field.
    if (id === 'sodium' || id === 'salt') _handleSaltSodiumDerivation(id);
  }

  // Sodium ↔ salt derivation in the editor. When the user types in one and
  // the other is empty, auto-fill via the regulatory factor (sodium_mg =
  // salt_g × 400; salt_g = sodium_mg / 400) and flag the auto-filled field
  // as derived. When the user manually types in a field, clear its derived
  // flag (now user-entered, not derived).
  function _handleSaltSodiumDerivation(changedId) {
    if (!food._derived) food._derived = {};
    // The user just typed in `changedId` — it's no longer derived.
    if (food._derived[changedId]) food._derived = { ...food._derived, [changedId]: false };

    const otherId = changedId === 'sodium' ? 'salt' : 'sodium';
    const changedVal = parseDecimal(food[changedId]);

    // Last-edited-wins. Sodium and salt are the same datum in different
    // units, so any edit to either side should recompute the other —
    // including over a value the user previously typed or that was
    // imported from a source with internally-inconsistent label data
    // (OFF / USDA sometimes reports both with values that don't agree).
    // Other nutrients keep the standard "preserve user input" rule;
    // only this pair gets last-edited-wins.
    if (Number.isFinite(changedVal) && changedVal > 0) {
      if (changedId === 'sodium') {
        food.salt   = Math.round((changedVal / 400) * 1000) / 1000;
        food._derived = { ...food._derived, salt: true };
      } else {
        food.sodium = Math.round((changedVal * 400) * 10) / 10;
        food._derived = { ...food._derived, sodium: true };
      }
    }
    food = food; // trigger Svelte reactivity
  }

  async function downloadFromOFF() {
    if (!food.barcode) return;
    downloading = true; downloadSuccess = false;
    try {
      const { API } = await import('../lib/api.js');
      const result = await API.lookupBarcode(food.barcode);
      if (!result) { showError($_('food_editor.toast.off_not_found')); return; }
      // Only fill empty fields (smart mode)
      if (!food.name && result.name)   food.name  = result.name;
      if (!food.brand && result.brand) food.brand = result.brand;
      if (result.nutrition) {
        for (const n of NUTRIMENTS) {
          const v = result.nutrition[n.id];
          if ((food[n.id] === '' || food[n.id] == null) && v != null) food[n.id] = v;
        }
      }
      if (!food.imgUrl && result.imgUrl) food.imgUrl = result.imgUrl;
      food = { ...food };
      downloadSuccess = true;
      setTimeout(() => downloadSuccess = false, 2500);
      showSuccess($_('food_editor.toast.off_refreshed'));
    } catch(e) {
      showError($_('food_editor.toast.refresh_failed', { values: { error: e.message } }));
    } finally { downloading = false; }
  }

  // ── Scan Label (AI vision) ──────────────────────────────────────────────────
  // Camera flow: user taps the icon in the Nutrition card header, takes a photo
  // of the food's nutrition label, the configured AI provider extracts values,
  // and OVERWRITES the form's nutrition fields (the label is the source of
  // truth in this moment, distinct from Refresh from OFF which smart-fills).
  // Gated on $aiEffectivelyEnabled — button is hidden when AI isn't configured.
  let scanningLabel = false;
  let scanLabelFileInput;

  async function _captureLabelPhoto() {
    if (isNative) {
      try {
        const { Camera, CameraResultType, CameraSource } = await import('@capacitor/camera');
        const photo = await Camera.getPhoto({
          quality: 80, resultType: CameraResultType.Base64,
          source: CameraSource.Camera, width: 1600,
        });
        return { base64: photo.base64String, mimeType: `image/${photo.format || 'jpeg'}` };
      } catch {
        return null;
      }
    }
    // Web: trigger the hidden file input + camera capture attribute and resolve
    // on change. The element lives in the template below.
    return new Promise((resolve) => {
      const handler = (e) => {
        scanLabelFileInput.removeEventListener('change', handler);
        const file = e.target.files?.[0];
        if (!file) { resolve(null); return; }
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result;
          // dataUrl: data:image/jpeg;base64,XXXX → split into mime + base64
          const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
          if (!m) { resolve(null); return; }
          resolve({ mimeType: m[1], base64: m[2] });
        };
        reader.readAsDataURL(file);
      };
      scanLabelFileInput.addEventListener('change', handler);
      scanLabelFileInput.value = '';
      scanLabelFileInput.click();
    });
  }

  function _buildLabelMessages(provider, image) {
    // Build the prompt + image payload. Each provider has its own multimodal
    // format. Same shape pattern used by Trace.svelte#_buildImageMessage.
    const prompt = [
      'Extract nutrition facts from this label image.',
      'Return ONLY a JSON object with these keys (omit keys you cannot read):',
      '  name (string, product name), brand (string), portion (number), unit (string, one of g/ml/oz/fl oz/cup/tsp/tbsp/lb/kg/l/each),',
      '  per_serving (boolean, true if the listed values are per serving, false if per 100g),',
      '  calories (kcal), kilojoules (kJ),',
      '  fat (g), saturated-fat (g), trans-fat (g), polyunsaturated-fat (g), monounsaturated-fat (g),',
      '  carbohydrates (g), sugars (g), added-sugars (g), fiber (g),',
      '  proteins (g),',
      '  sodium (mg), salt (g), potassium (mg), cholesterol (mg),',
      '  calcium (mg), iron (mg), magnesium (mg), zinc (mg), phosphorus (mg),',
      '  vitamin-d (µg), vitamin-a (µg), vitamin-c (mg), vitamin-e (mg), vitamin-k (µg),',
      '  b1 (mg), b2 (mg), b3 (mg), b6 (mg), b9 (µg), b12 (µg),',
      '  caffeine (mg), alcohol (g)',
      'Use numbers, not strings. Use the units specified, not the label\'s.',
      'No commentary, no markdown — JSON only.',
    ].join('\n');
    if (provider === 'claude') {
      return [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.base64 } },
        { type: 'text', text: prompt },
      ]}];
    }
    if (provider === 'openai' || provider === 'oai-compat') {
      return [{ role: 'user', content: [
        { type: 'image_url', image_url: { url: `data:${image.mimeType};base64,${image.base64}` } },
        { type: 'text', text: prompt },
      ]}];
    }
    if (provider === 'gemini') {
      return [{ role: 'user', content: prompt, _image: image }];
    }
    return [{ role: 'user', content: prompt }];
  }

  function _parseJsonFromReply(text) {
    if (!text) return null;
    // Strip ```json fences if the model added them despite the prompt.
    const cleaned = text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
    try { return JSON.parse(cleaned); } catch {}
    // Fallback: extract the first {...} block.
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch {} }
    return null;
  }

  async function scanLabel() {
    if (scanningLabel) return;
    const image = await _captureLabelPhoto();
    if (!image || !image.base64) return;
    scanningLabel = true;
    // #158: hold a screen wake lock while the model reads the label.
    // Slow self-hosted models can take a minute+; without this the
    // screen times out and the WebView suspends, killing the fetch.
    const _releaseWakeLock = await acquireScreenWakeLock();
    try {
      const provider = $aiProvider || 'claude';
      const messages = _buildLabelMessages(provider, image);
      const systemPrompt = 'You are a nutrition label parser. Return JSON only.';
      const reply = $envLocks.ai
        ? await callAIProxy({ messages, systemPrompt })
        : await callAI({
            provider, apiKey: $aiApiKey, model: $aiModel, baseUrl: $aiBaseUrl,
            messages, systemPrompt,
          });
      const parsed = _parseJsonFromReply(reply);
      if (!parsed || typeof parsed !== 'object') {
        showError($_('food_editor.toast.label_read_failed'));
        return;
      }
      // Overwrite (NOT smart-fill) — the label is the source of truth this moment.
      // Mirrors the user's preference: refresh-from-off smart-fills (OFF can be
      // stale), scan-label overwrites (label is what the user is holding now).
      if (typeof parsed.name === 'string' && parsed.name.trim()) food.name = parsed.name.trim();
      if (typeof parsed.brand === 'string' && parsed.brand.trim()) food.brand = parsed.brand.trim();
      if (parsed.portion != null && !isNaN(parseFloat(parsed.portion))) food.portion = parseFloat(parsed.portion);
      if (typeof parsed.unit === 'string' && parsed.unit.trim()) food.unit = parsed.unit.trim();
      for (const n of NUTRIMENTS) {
        const v = parsed[n.id];
        if (v != null && !isNaN(parseFloat(v))) food[n.id] = parseFloat(v);
      }
      food = { ...food };
      showSuccess($_('food_editor.toast.nutrition_extracted'));
    } catch (e) {
      showError($_('food_editor.toast.scan_failed', { values: { error: e?.message || $_('food_editor.toast.unknown_error') } }));
    } finally {
      scanningLabel = false;
      try { await _releaseWakeLock(); } catch { /* noop */ }
    }
  }


  onMount(async () => {
    store = editorState.foodStore || 'foodList';
    // Cache the user's library for duplicate-barcode detection. Best-effort —
    // if the call fails the duplicate warning just stays inactive.
    NtApi.getFoods().then(list => { _myFoods = list || []; }).catch(() => {});
    if (editorState.foodPrefill) {
      const prefill = editorState.foodPrefill;
      // Flatten nested nutrition into top-level fields for editing
      const flatNutrition = (prefill.nutrition && typeof prefill.nutrition === 'object') ? { ...prefill.nutrition } : {};
      food = { ...food, ...prefill, ...flatNutrition };
    } else if (params && params.id) {
      const existing = await NtApi.getFood(params.id).catch(() => null);
      if (existing) {
        const flatNutrition = (existing.nutrition && typeof existing.nutrition === 'object') ? { ...existing.nutrition } : {};
        food = { ...food, ...existing, ...flatNutrition };
      }
    }
    // ── Restore any in-progress draft (#157) ──────────────────────────
    // Overlays a fresh (<4h) draft on top of whatever we just loaded
    // above. The user gets a banner + Discard button so a restored draft
    // isn't invisible (Wildenhaus feedback on dev05). Draft was written
    // on every keystroke, so it captures whatever they typed up to the
    // moment of crash. Clears on save; no clear on back-out, so a real
    // back-tap-then-return within TTL also restores.
    //
    // Capture the pre-overlay state so the banner's Discard button can
    // reset the form to what actually came from the server (or empty,
    // for the "add new" path).
    _serverBaseline = { ...food };
    try {
      const _draft = loadDraft(_draftKey);
      if (_draft && typeof _draft === 'object' && Object.keys(_draft).length > 0) {
        food = { ...food, ..._draft };
        _draftRestored = true;
      }
    } catch { /* draft parse issues fall through to server-loaded state */ }
    // Photo lives in IndexedDB (see editor-draft.js). Async restore —
    // don't gate _draftReady on it; typing should be persistable even
    // if the photo restore is still in flight. If the photo lands after
    // the user has already picked a different one, don't clobber theirs.
    loadDraftImg(_draftKey).then((_img) => {
      if (_img && !food.imgUrl) {
        food = { ...food, imgUrl: _img };
        _draftRestored = true;
      }
    }).catch(() => { /* IDB unavailable or read failed; text draft still works */ });
    // Now that any draft has been overlaid, enable the reactive persist.
    _draftReady = true;

    // Default `linked` to ON when editing an existing food (the user is
    // almost always rescaling, and they expect serving size to preserve
    // density). For NEW food entry where the form starts empty, leave it
    // OFF so typing nutrient values from a label doesn't silently
    // cross-scale neighbouring fields. Fixes #28.
    const _hasNutrition = food.nutrition && Object.keys(food.nutrition || {}).length > 0;
    const _hasFlatNutrient = NUTRIMENTS.some(n => food[n.id] != null && food[n.id] !== '');
    if (_hasNutrition || _hasFlatNutrient) {
      linked = true;
      takeSnapshot();
    }
    // Snapshot otherwise is taken when the user flips `linked` on —
    // see the link-btn click handler.

  });

  // Read-only when viewing someone else's shared food. Server returns 403 on
  // PUT regardless, but locking the UI prevents the user from typing into a
  // form that won't save and gives them a single clear action: Save a Copy.
  $: _readOnly = !!food._shared_by;

  // Issues #69 + #70: gate the basis / serving units / density editor on
  // an opt-in toggle so the fields stay hidden for users who never need
  // them. Auto-on for anyone who turned on the warn-about-conversions
  // toggle (the natural opt-in signal). ALSO show whenever the current
  // food already has values populated in any of the three fields, so the
  // user can never lose access to edit or clear data they previously set
  // (or that an OFF import auto-populated). Without this last clause,
  // turning the master toggle off would leave their existing food rows
  // uneditable for those fields.
  $: _showUnitMetadataUI = $showUnitMetadata || $warnUnitMismatch
    || !!food.nutrition_basis
    || (Array.isArray(food.alt_units) && food.alt_units.length > 0)
    || (food.density_g_ml != null && food.density_g_ml !== '');

  async function saveAsCopy() {
    saving = true;
    try {
      // Strip the upstream id so it inserts as a new row owned by the current user.
      const copy = { ...food };
      const sourceId = food.id;
      delete copy.id;
      delete copy._shared_by;
      delete copy.user_id;
      delete copy.visibility;
      delete copy.favorite;
      const created = sourceId
        ? await NtApi.copyFood(sourceId)
        : await NtApi.createFood(copy);
      showSuccess($_('food_editor.toast.saved_copy'));
      clearFoodEditorState();
      pop();
    } catch (e) { showError($_('food_editor.toast.save_copy_failed', { values: { error: e.message } })); }
    saving = false;
  }

  async function save() {
    if (!food.name.trim()) {
      showError($_('food_editor.errors.name_required'));
      return;
    }
    saving = true;
    try {
      // Build nested nutrition object from flat fields for Nutrition.calculate() compatibility.
      // #201: iterate custom nutriments too so user-defined nutrients
      // survive the save. Nutrition.calculate iterates
      // Object.entries(item.nutrition) on the nested path so any key
      // written here flows through calculations without further changes.
      const _nutrition = {};
      for (const _n of [...NUTRIMENTS, ...($customNutriments || [])]) {
        const _v = food[_n.id];
        if (_v !== undefined && _v !== '' && _v !== null && !isNaN(parseDecimal(_v))) {
          _nutrition[_n.id] = parseDecimal(_v) || 0;
        }
      }
      // Persist the derived-flag map so the calculator icon survives reloads.
      // Strip falsy entries so empty maps don't bloat the JSON payload.
      if (food._derived) {
        const flags = {};
        for (const k of Object.keys(food._derived)) {
          if (food._derived[k]) flags[k] = true;
        }
        if (Object.keys(flags).length) _nutrition._derived = flags;
      }
      const item = { ...food, nutrition: _nutrition };
      const saved = food.id
        ? await NtApi.updateFood(food.id, item)
        : await NtApi.createFood(item);
      item.id = saved.id;
      // If called from diary pick mode, also add to diary
      const ctx = editorState.foodDiaryCtx;
      if (ctx) {
        const { addDiaryItem } = await import('../stores/diary.js');
        await addDiaryItem(
          { ...item, portion: item.portion || 100, unit: item.unit || 'g' },
          Number(ctx.meal) || 0,
          ctx.date
        );
      }
      clearFoodEditorState();
      // #157: draft persistence — clear the localStorage draft now that
      // the form has landed successfully. Any subsequent process death
      // shouldn't bring the pre-save state back.
      _draftReady = false;
      if (_persistDraft && typeof _persistDraft.cancel === 'function') _persistDraft.cancel();
      clearDraft(_draftKey);
      showSuccess(ctx ? $_('food_editor.added_to_diary') : $_('food_editor.saved'));
      if (ctx) {
        // Go back twice to return to diary
        history.go(-2);
      } else {
        pop();
      }
    } catch(e) {
      showError($_('food_editor.toast.save_failed', { values: { error: e.message || e } }));
    } finally {
      saving = false;
    }
  }

  function toggleCategory(cat) {
    const name = _catName(cat);
    food.categories = food.categories || [];
    if (food.categories.includes(name)) {
      food.categories = food.categories.filter(c => c !== name);
    } else {
      food.categories = [...food.categories, name];
    }
  }

  // Discard restored draft (#157 followup, Wildenhaus). Snaps form back
  // to what the server actually loaded (or empty for the add-new path)
  // and wipes both text + photo from the draft store. Banner disappears
  // once the state is reset.
  function _discardDraft() {
    // Drop any in-flight debounced write so it doesn't fire 400ms later
    // and re-save the pre-discard state back into the draft store.
    if (_persistDraft && typeof _persistDraft.cancel === 'function') _persistDraft.cancel();
    // Suppress the reactive persist for the assignment that follows,
    // then re-enable after Svelte's tick has settled.
    _draftReady = false;
    if (_serverBaseline) food = { ..._serverBaseline };
    clearDraft(_draftKey);
    _draftRestored = false;
    tick().then(() => { _draftReady = true; });
  }

  // Apply the user's custom nutriment order (set via drag-to-reorder in
  // Settings → Nutrients). Without this the editor stayed on the static
  // NUTRIMENTS array order even after the user reorganized.
  function _applyOrder(list) {
    const ord = $nutrimentsOrder || [];
    if (!ord.length) return list;
    return list.slice().sort((a, b) => {
      const ai = ord.indexOf(a.id);
      const bi = ord.indexOf(b.id);
      if (ai === -1 && bi === -1) return 0;
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    });
  }
  // #201 (@caioqv-dev): merge $customNutriments into both field lists
  // so nutrients the user created in Settings → Nutrients actually
  // appear in the Food Editor. Custom entries always show (the user
  // explicitly added them; they'd delete them from Settings rather
  // than expect a separate visibility toggle here). Built-in
  // nutriments still respect the visibleNutriments list / default
  // flag. _applyOrder sorts custom entries after any explicitly
  // ordered built-ins, matching how nutrimentsOrder handles unknown
  // ids. Custom entries have {id,label,unit} only; the render loop
  // reads n.label / n.unit / n.subOf and n.id === 'calories', all
  // of which tolerate the smaller shape (missing subOf is falsy,
  // custom ids never match 'calories').
  $: visibleFields = (() => {
    const vis = $visibleNutriments;
    const base = vis ? NUTRIMENTS.filter(n => vis.includes(n.id)) : NUTRIMENTS.filter(n => n.default);
    return _applyOrder([...base, ...($customNutriments || [])]);
  })();

  $: allFields = _applyOrder([...NUTRIMENTS, ...($customNutriments || [])]);
  $: displayFields = showAllNutrients ? allFields : visibleFields;
</script>

<div class="page-shell editor-page">
  <!-- Header -->
  <header class="editor-header">
    <button class="btn-icon" on:click={pop} aria-label={$_('common.back')} title={$_('common.back')}>
      <span class="material-symbols-rounded">arrow_back</span>
    </button>
    <h2 class="editor-title">{_readOnly ? `Shared by ${food._shared_by}` : (food.id ? 'Edit Food' : 'Add Food')}</h2>
    {#if food.id && !_readOnly}
      <button class="btn-icon fav-btn" class:on={!!food.favorite}
        on:click={() => { food.favorite = food.favorite ? 0 : 1; food = food; }}
        aria-label={food.favorite ? 'Unfavorite' : 'Favorite'}
        title={food.favorite ? 'Unfavorite' : 'Add to favorites'}>
        <span class="material-symbols-rounded">{food.favorite ? 'favorite' : 'favorite_border'}</span>
      </button>
    {/if}
    {#if _readOnly}
      <button class="btn btn-primary" style="height:36px;padding:0 14px;font-size:13px;white-space:nowrap"
        on:click={saveAsCopy} disabled={saving}>
        {saving ? 'Copying…' : 'Save to My Catalog'}
      </button>
    {:else}
      <button class="btn btn-primary" style="height:36px;padding:0 16px;font-size:13px"
        on:click={save} disabled={saving}>
        {saving ? 'Saving…' : 'Save'}
      </button>
    {/if}
  </header>

  {#if _readOnly}
    <div class="readonly-banner">
      <span class="material-symbols-rounded">lock</span>
      <div>
        <div class="readonly-title">Shared by {food._shared_by} — read only</div>
        <div class="readonly-sub">{$_('food_editor.readonly_sub')}</div>
      </div>
    </div>
  {/if}

  <div class="page-content editor-content" class:readonly-content={_readOnly} inert={_readOnly || null}>
    <!-- Left column (desktop ≥1024px): identity + metadata.
         Photo, Basic Info, Categories, Notes all stack here.
         Below 1024px this wrapper is display:contents so cards
         fall back to the single-column flex flow that used to
         live on .editor-content directly. -->
    <div class="editor-left-col">

    <!-- Photo -->
    <div class="card editor-card photo-card">
      <div class="editor-card-title">{$_('food_editor.card_photo')}</div>
      <div class="photo-preview-wrap">
        {#if food.imgUrl}
          <img class="photo-preview-img" src={food.imgUrl} alt="Food" />
          <button class="photo-remove-btn btn-icon" on:click={removePhoto} aria-label={$_('food_editor.photo_remove')} title={$_('food_editor.photo_remove')}>
            <span class="material-symbols-rounded" style="font-size:18px">close</span>
          </button>
        {:else}
          <div class="photo-placeholder">
            <span class="material-symbols-rounded" style="font-size:48px;opacity:0.25">photo_camera</span>
          </div>
        {/if}
      </div>
      <div class="photo-btn-row">
        <button class="btn btn-ghost photo-action-btn" on:click={openCamera}>
          <span class="material-symbols-rounded">camera_alt</span>
          Camera
        </button>
        <button class="btn btn-ghost photo-action-btn" on:click={openGallery}>
          <span class="material-symbols-rounded">photo_library</span>
          Upload
        </button>
        <button class="btn btn-ghost photo-action-btn" on:click={() => { showUrlInput = !showUrlInput; photoUrl = ''; }}>
          <span class="material-symbols-rounded">link</span>
          URL
        </button>
      </div>
      {#if showUrlInput}
        <div class="photo-url-row">
          <input class="input photo-url-input" placeholder="https://..." bind:value={photoUrl}
            on:keydown={e => e.key === 'Enter' && applyPhotoUrl()} />
          <button class="btn btn-primary" on:click={applyPhotoUrl}>Get</button>
        </div>
      {/if}
      <input bind:this={fileInput} type="file" accept="image/*" style="display:none" on:change={onFileChange} />
    </div>

    <!-- Camera popup -->
    {#if showCamera}
      <div class="cam-overlay" role="dialog" aria-modal="true" use:portal>
        <div class="cam-popup">
          <div class="cam-header">
            <span class="cam-title">{$_('food_editor.take_photo')}</span>
            <button class="btn-icon" on:click={stopCamera} aria-label={$_('food_editor.cancel')} title={$_('food_editor.close_camera')}>
              <span class="material-symbols-rounded">close</span>
            </button>
          </div>
          <!-- svelte-ignore a11y-media-has-caption -->
          <video bind:this={cameraVideo} autoplay playsinline muted class="cam-video"></video>
          <div class="cam-footer">
            <button class="btn btn-primary cam-capture-btn" on:click={capturePhoto}>
              <span class="material-symbols-rounded">camera_alt</span>
              Capture
            </button>
          </div>
        </div>
      </div>
    {/if}

    <!-- Crop popup -->
    {#if showCrop}
      <ImageCropper
        src={cropSrc}
        title={$_('food_editor.crop_photo')}
        hint={$_('food_editor.crop_hint')}
        cancelLabel={$_('food_editor.cancel')}
        outputSize={512}
        on:confirm={(event) => {
          food.imgUrl = event.detail.dataUrl;
          showCrop = false;
          cropSrc = '';
        }}
        on:cancel={() => { showCrop = false; cropSrc = ''; }}
      />
    {/if}

    <!-- Restored-draft banner (#157 followup). Only visible when a
         draft was overlaid at mount; Discard resets the form to the
         server-loaded (or empty) baseline and clears the draft store. -->
    {#if _draftRestored}
      <div class="draft-restored-banner">
        <span class="material-symbols-rounded">history</span>
        <span class="draft-restored-text">{$_('food_editor.draft_restored')}</span>
        <button type="button" class="draft-restored-discard" on:click={_discardDraft}>
          {$_('food_editor.draft_discard')}
        </button>
      </div>
    {/if}

    <!-- Basic info -->
    <div class="card editor-card">
      <div class="editor-card-title">{$_('food_editor.card_basic')}</div>
      <div class="form-group">
        <label class="form-label">Name *</label>
        <input class="input" placeholder={$_('food_editor.name_placeholder')} bind:value={food.name} />
      </div>
      <div class="form-group">
        <label class="form-label">{$_('food_editor.field_brand')}</label>
        <input class="input" placeholder={$_('food_editor.brand_placeholder')} bind:value={food.brand} />
      </div>
      <div class="form-row" style="align-items:flex-end">
        <div class="form-group" style="flex:1">
          <label class="form-label">{$_('food_editor.field_serving_size')}</label>
          <input class="input" type="text" inputmode="decimal" use:decimalInput bind:value={food.portion}
            on:input={onPortionInput} />
        </div>
        <div class="form-group" style="width:100px">
          <label class="form-label">{$_('food_editor.field_unit')}</label>
          <UnitPicker bind:value={food.unit} />
        </div>
        <button class="btn-icon link-btn" class:linked title={linked ? 'All fields scale proportionally' : 'Fields are independent'}
          on:click={() => { linked = !linked; if (linked) takeSnapshot(); }}>
          <span class="material-symbols-rounded" style="font-size:20px">{linked ? 'link' : 'link_off'}</span>
        </button>
      </div>

      <!-- Issues #69 + #70: nutrition_basis + alt_units + density editor.
           Gated on _showUnitMetadataUI: visible only when the user opted
           in via Settings, or when the current food already has values in
           any of the three fields. OFF imports auto-populate these fields
           on the underlying row regardless of UI visibility — the data
           always flows in, just the editor is hidden by default. -->
      {#if _showUnitMetadataUI}
      <div class="form-group">
        <label class="form-label">{$_('food_editor.field_nutrition_basis')}</label>
        <div class="basis-toggle">
          <button type="button" class="basis-opt" class:active={food.nutrition_basis === 'g'}
            on:click={() => food.nutrition_basis = food.nutrition_basis === 'g' ? null : 'g'}>
            Per 100 g
          </button>
          <button type="button" class="basis-opt" class:active={food.nutrition_basis === 'ml'}
            on:click={() => food.nutrition_basis = food.nutrition_basis === 'ml' ? null : 'ml'}>
            Per 100 ml
          </button>
        </div>
        <div class="form-hint">
          Defaults the unit picker when logging to the diary. Leave both off if unknown; math behaves like today's default.
        </div>
      </div>

      <!-- Per-food serving units (e.g. "1 slice = 35 g"). OFF imports add
           the first row from serving_size + serving_quantity; users can
           edit, add, or remove rows. Issues #69 + #70. -->
      <div class="form-group">
        <label class="form-label">{$_('food_editor.field_serving_units')}</label>
        <div class="alt-units">
          {#each (food.alt_units || []) as row, i}
            <div class="alt-unit-row">
              <input class="input alt-unit-abbr" placeholder="e.g. slice"
                bind:value={row.abbr} />
              <span class="alt-unit-eq">=</span>
              <input class="input alt-unit-grams" type="text" inputmode="decimal" use:decimalInput
                placeholder="grams" bind:value={row.grams} />
              <span class="alt-unit-suffix">g</span>
              <button type="button" class="btn-icon alt-unit-del"
                title={$_('food_editor.remove_serving_unit')} aria-label={$_('food_editor.remove_serving_unit')}
                on:click={() => food.alt_units = food.alt_units.filter((_, j) => j !== i)}>
                <span class="material-symbols-rounded">close</span>
              </button>
            </div>
          {/each}
          <button type="button" class="btn-link alt-unit-add"
            on:click={() => food.alt_units = [...(food.alt_units || []), { abbr: '', grams: '' }]}>
            <span class="material-symbols-rounded" style="font-size:18px;vertical-align:middle">add</span>
            Add serving unit
          </button>
        </div>
        <div class="form-hint">
          Lets you log "1 slice", "1 cookie", "1 bottle" etc. with the right gram conversion.
        </div>
      </div>

      <!-- Optional density for accurate cross-system (g ↔ ml) conversion.
           Defaults blank; only matters when you log this food in a unit
           that doesn't match the basis (g picked on a per-100-ml food).
           Issues #69. -->
      <div class="form-group">
        <label class="form-label">Density (g/ml)</label>
        <div style="display:flex;align-items:center;gap:6px">
          <input class="input" type="text" inputmode="decimal" use:decimalInput
            placeholder={$_('food_editor.placeholder_optional')}
            value={food.density_g_ml ?? ''}
            on:input={e => food.density_g_ml = e.target.value === '' ? null : Number(e.target.value)} />
          <span style="color:var(--text-3);font-size:13px">g/ml</span>
        </div>
        <div class="form-hint">
          Only used when the picked unit's system (mass vs volume) doesn't match the nutrition basis. Common values: water 1.00, milk 1.03, olive oil 0.91, honey 1.42.
        </div>
      </div>
      {/if}
      <div class="form-group">
        <label class="form-label">{$_('food_editor.field_barcode')}</label>
        <div class="barcode-input-wrap">
          <input class="input barcode-input" type="text" inputmode="numeric" placeholder={$_('food_editor.placeholder_optional')} bind:value={food.barcode} />
          <button type="button" class="btn-scan-inline" title={$_('food_editor.scan_barcode')} aria-label={$_('food_editor.scan_barcode')}
            on:click={() => editorScannerOpen = true}>
            <span class="material-symbols-rounded">barcode_scanner</span>
          </button>
        </div>
        {#if duplicateOf}
          <div class="barcode-dup-warn">
            <span class="material-symbols-rounded" style="font-size:16px;color:var(--warning,#f59e0b)">warning</span>
            <span>You already have a food with this barcode: <strong>{duplicateOf.name}</strong></span>
            <button type="button" class="btn-link" on:click={() => {
              clearFoodEditorState();
              editorState.foodStore = store;
              if (editorState.foodDiaryCtx) { /* preserve pick-mode context */ }
              push(`/foods/edit/${duplicateOf.id}`);
            }}>Open existing →</button>
          </div>
        {/if}
        {#if hasBarcode}
          <div class="form-row" style="gap:8px;margin-top:8px">
            <button class="btn btn-secondary" style="flex:1"
              on:click={shareOrViewOnOFF} disabled={contributing}>
              <span class="material-symbols-rounded" style="font-size:15px;vertical-align:middle;margin-right:4px">
                {offProductExists ? 'open_in_new' : 'upload'}
              </span>
              {contributing ? 'Uploading…' : offSuccess ? 'Submitted!' : offProductExists ? 'View on OFF' : 'Share to OFF'}
            </button>
            <button class="btn btn-secondary" style="flex:1"
              on:click={downloadFromOFF} disabled={downloading}>
              <span class="material-symbols-rounded" style="font-size:15px;vertical-align:middle;margin-right:4px">download</span>
              {downloading ? 'Loading…' : downloadSuccess ? 'Updated!' : 'Refresh from OFF'}
            </button>
          </div>
          {#if offSuccess}
            <div class="off-verify-row">
              {#if offVerified === null}
                <span class="off-verify-checking">
                  <span class="material-symbols-rounded" style="font-size:14px;vertical-align:middle">hourglass_top</span>
                  Verifying on Open Food Facts…
                </span>
              {:else if offVerified}
                <span class="off-verify-ok">
                  <span class="material-symbols-rounded" style="font-size:14px;vertical-align:middle">check_circle</span>
                  Confirmed live on Open Food Facts
                </span>
              {:else}
                <span class="off-verify-pending">
                  <span class="material-symbols-rounded" style="font-size:14px;vertical-align:middle">schedule</span>
                  Submitted — may take a few minutes to appear
                </span>
              {/if}
              <a class="off-verify-link" href="https://world.openfoodfacts.org/product/{food.barcode}" target="_blank" rel="noopener">
                View on Open Food Facts <span class="material-symbols-rounded" style="font-size:12px;vertical-align:middle">open_in_new</span>
              </a>
            </div>
          {/if}
        {/if}
      </div>
    </div>

    <!-- Categories -->
    {#if $foodsShowCategories && ($foodCategories || []).length > 0}
      <div class="card editor-card">
        <div class="editor-card-title">{$_('food_editor.card_categories')}</div>
        <div class="cat-chips">
          {#each $foodCategories as cat}
            <button class="chip" class:accent={(food.categories||[]).includes(_catName(cat))}
              on:click={() => toggleCategory(cat)}>
              {#if (food.categories||[]).includes(_catName(cat))}
                <span class="material-symbols-rounded" style="font-size:14px">check</span>
              {/if}
              {$foodsShowLabels ? _catDisplay(cat) : _catName(cat)}
            </button>
          {/each}
        </div>
      </div>
    {/if}

    <!-- Notes -->
    {#if $foodsShowNotes}
      <div class="card editor-card">
        <div class="editor-card-title">{$_('food_editor.card_notes')}</div>
        <textarea class="input textarea" placeholder={$_('food_editor.notes_placeholder')} bind:value={food.notes}></textarea>
      </div>
    {/if}

    </div><!-- /.editor-left-col -->

    <!-- Right column (desktop ≥1024px): the primary work area —
         Nutrition. On mobile this wrapper is display:contents so
         the card flows naturally under the left-column cards. -->
    <div class="editor-right-col">

    <!-- Nutrition -->
    <div class="card editor-card">
      <div class="editor-card-title" style="display:flex;align-items:center;justify-content:space-between;gap:8px">
        <span>{$_('food_editor.card_nutrition')}</span>
        {#if $aiEffectivelyEnabled}
          <button class="scan-label-btn" on:click={scanLabel} disabled={scanningLabel}
            title={$_('food_editor.scan_label_title')}
            aria-label="Scan nutrition label">
            <span class="material-symbols-rounded scan-icon" class:spin={scanningLabel}>
              {scanningLabel ? 'progress_activity' : 'document_scanner'}
            </span>
            <span>{scanningLabel ? 'Scanning…' : 'Scan Label'}</span>
          </button>
        {/if}
      </div>
      <!-- Hidden file input for the web Scan Label flow. On native we go
           through @capacitor/camera directly. -->
      <input bind:this={scanLabelFileInput} type="file" accept="image/*" capture="environment" style="display:none" />
      <!-- Nutrition fields grid. Single column on mobile / narrow
           so labels + inputs stack full-width. At ≥1024px (desktop
           editor pane) it becomes a 2-column grid so pairs like
           Fat / Saturated Fat + Carbs / Fiber sit side-by-side —
           each input capped to a sensible width instead of one
           number stretching across the ~1500px right column. -->
      <div class="nutrition-fields">
      {#each displayFields as n (n.id)}
        {@const _kjMode = n.id === 'calories' && $energyUnit === 'kJ'}
        <!-- Keyed by n.id so toggling 'Show All Nutrients' only
             animates the fields that actually get added/removed
             — visible fields don't jitter. slide|local scopes the
             transition to this each's mount/unmount inside the
             persistent nutrition-fields container. -->
        <div class="form-group nutrient-cell" class:nutrient-sub={n.subOf}
          in:slide|local={{ duration: $disableAnimations ? 0 : 180 }}
          out:slide|local={{ duration: $disableAnimations ? 0 : 140 }}>
          <label class="form-label">
            {_kjMode ? 'Energy' : n.label} ({_kjMode ? 'kJ' : n.unit})
            {#if (n.id === 'sodium' || n.id === 'salt') && food._derived && food._derived[n.id]}
              <span class="material-symbols-rounded" style="font-size:14px;color:var(--text-3);vertical-align:middle;margin-left:2px"
                title={n.id === 'sodium' ? 'Auto-calculated from salt (× 400 mg/g)' : 'Auto-calculated from sodium (÷ 400)'}>calculate</span>
            {/if}
          </label>
          {#if _kjMode}
            <input class="input" type="text" inputmode="decimal" use:decimalInput placeholder="0"
              value={food.calories ? Math.round(food.calories * 4.184) : ''}
              on:input={(e) => { const v = parseDecimal(e.target.value); food.calories = isNaN(v) ? '' : v / 4.184; onNutInput('calories'); }} />
          {:else}
            <input class="input" type="text" inputmode="decimal" use:decimalInput placeholder="0"
              bind:value={food[n.id]}
              on:input={() => onNutInput(n.id)} />
          {/if}
        </div>
      {/each}
      </div><!-- /.nutrition-fields -->
      <button class="btn btn-ghost w-full" style="margin-top:8px"
        on:click={() => showAllNutrients = !showAllNutrients}>
        {showAllNutrients ? 'Show Less' : 'Show All Nutrients'}
      </button>
    </div>

    <div style="height:16px"></div>
    </div><!-- /.editor-right-col -->
  </div>
</div>

<!-- Inline barcode scanner — fired by the scan button next to the Barcode field -->
<BarcodeScanner bind:open={editorScannerOpen} on:scan={onEditorScan} on:close={() => editorScannerOpen = false} />

<style>
  /* Indented sub-nutrient rows — Saturated Fat under Total Fat, Sugars
     under Carbs, etc. Mirrors the FDA Nutrition Facts label hierarchy
     and matches CookTrace's PantryEditor for cross-app consistency. */
  .nutrient-sub { padding-left: 12px; }
  .nutrient-sub .form-label { color: var(--text-3); font-weight: 500; }

  /* Barcode field — scan button absolutely positioned inside the input
     wrapper, mirroring the search-bar pattern in Foods.svelte. */
  .barcode-input-wrap {
    position: relative;
    display: flex;
    align-items: center;
  }
  .barcode-input {
    flex: 1;
    width: 100%;
    padding-right: 38px; /* leave room for the scan icon */
  }

  .barcode-dup-warn {
    display: flex; align-items: center; gap: 8px;
    margin-top: 8px;
    padding: 8px 12px;
    background: color-mix(in srgb, var(--warning, #f59e0b) 8%, transparent);
    border: 1px solid color-mix(in srgb, var(--warning, #f59e0b) 30%, transparent);
    border-radius: var(--radius-md);
    font-size: 13px;
    color: var(--text-1);
    flex-wrap: wrap;
  }
  .barcode-dup-warn .btn-link {
    background: none; border: none; cursor: pointer;
    color: var(--accent); font-weight: 600; font-size: 13px;
    padding: 0; margin-left: auto;
    font-family: inherit;
  }
  .barcode-dup-warn .btn-link:hover { text-decoration: underline; }

  .link-btn { color: var(--text-3); margin-bottom: 2px; }
  .link-btn.linked { color: var(--accent); }
  .editor-page {
    padding-top: 0;
    position: fixed;
    inset: 0;
    overflow-y: auto;
    z-index: 30;
    background: var(--bg);
  }
  .editor-header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: calc(var(--safe-top) + 12px) 16px 12px;
    border-bottom: 1px solid var(--border);
    background: var(--surface-1);
    position: sticky;
    top: 0;
    z-index: 10;
  }
  .editor-title { font-size: 17px; font-weight: 600; flex: 1; }
  .fav-btn { color: var(--text-3); }
  .fav-btn.on { color: var(--macro-protein, #ec4899); }
  .editor-content { display: flex; flex-direction: column; gap: 12px; padding-top: 16px; padding-bottom: 32px; }
  .readonly-content { opacity: 0.78; pointer-events: none; }

  /* Mobile default: column wrappers are display:contents so the
     cards fall through into the parent's flex-column flow, exactly
     as before the desktop split was introduced. */
  .editor-left-col,
  .editor-right-col { display: contents; }

  /* Desktop ≥1024px: two-column form layout.
     Left column (340px) — identity / metadata: Photo, Basic Info,
     Categories, Notes. Compact fields that don't need width.
     Right column (fills) — Nutrition. The primary work area; needs
     the wider column so each field row (label + value + unit) sits
     on one line without wrapping.
     Gated by :global(html:not(.force-mobile-layout)) so the Force
     Mobile Layout toggle collapses the editor back to a single
     column at every viewport. */
  @media (min-width: 1024px) {
    :global(html:not(.force-mobile-layout)) .editor-content {
      display: grid;
      grid-template-columns: 340px minmax(0, 1fr);
      column-gap: 16px;
      row-gap: 0;
      align-items: start;
    }
    :global(html:not(.force-mobile-layout)) .editor-left-col,
    :global(html:not(.force-mobile-layout)) .editor-right-col {
      display: flex;
      flex-direction: column;
      gap: 12px;
      min-width: 0;
    }
    /* Sticky left column — keeps photo + basic info visible while
       scrolling the tall Nutrition card on the right. No max-height
       or internal scroll: if the left stack ever exceeds viewport
       height, sticky just unsticks against .editor-content's bottom
       so the whole column is still reachable via page scroll. Users
       don't have to hunt for an internal scrollbar to see cards at
       the bottom of the left column. */
    :global(html:not(.force-mobile-layout)) .editor-left-col {
      position: sticky;
      top: calc(var(--safe-top, 0px) + 76px);
      align-self: start;
    }
    /* Left column is only ~340px wide on desktop — the shared
       .form-row (used by 'View on OFF' + 'Refresh from OFF' etc.)
       assumes width for two side-by-side buttons and clips long
       labels at this width. Force full-width buttons via
       flex-basis 100% on any .btn inside a left-col .form-row so
       button pairs stack vertically. Compact side-by-side inputs
       like Serving Size (input) + Unit (select) still fit because
       they aren't .btn elements. */
    :global(html:not(.force-mobile-layout)) .editor-left-col :global(.form-row) {
      flex-wrap: wrap;
    }
    :global(html:not(.force-mobile-layout)) .editor-left-col :global(.form-row) :global(> .btn) {
      flex: 1 1 100%;
    }
    /* Nutrition fields inside the right column: 2-column grid at
       ≥1024px so pairs of related fields sit side-by-side instead
       of every number spanning the full column width. */
    :global(html:not(.force-mobile-layout)) .nutrition-fields {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      column-gap: 16px;
      row-gap: 12px;
    }
    /* Sub-nutrients (Saturated Fat, Trans Fat, etc.) sit under
       their parent macro — in the 2-col grid they'd otherwise
       flow into the second column, breaking the visual grouping.
       Force them onto their own row with a narrow indent. */
    :global(html:not(.force-mobile-layout)) .nutrition-fields :global(.nutrient-sub) {
      grid-column: 1 / -1;
      padding-left: 16px;
    }
  }
  /* Three columns on ultrawide so short number fields don't span
     an entire ~700px half-column. Kicks in at ≥1600 so it only
     applies when there's genuinely room. */
  @media (min-width: 1600px) {
    :global(html:not(.force-mobile-layout)) .nutrition-fields {
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr);
    }
    :global(html:not(.force-mobile-layout)) .nutrition-fields :global(.nutrient-sub) {
      grid-column: auto;
      padding-left: 8px;
    }
  }
  .readonly-banner {
    display: flex; align-items: center; gap: 12px;
    padding: 12px var(--page-px);
    background: color-mix(in srgb, var(--accent) 8%, transparent);
    border-bottom: 1px solid var(--border);
    font-size: 13px;
  }
  .readonly-banner .material-symbols-rounded { color: var(--accent); font-size: 20px; flex-shrink: 0; }
  .readonly-title { font-weight: 600; }
  .readonly-sub   { color: var(--text-3); font-size: 12px; margin-top: 2px; line-height: 1.4; }
  .editor-card { padding: 16px; display: flex; flex-direction: column; gap: 12px; }
  /* Restored-draft banner (#157 followup). Sits above the first form
     card so the user knows their fields came from a prior session and
     can wipe them via Discard. Accent-tinted to be noticeable without
     alarming — this is informational, not an error. */
  .draft-restored-banner {
    display: flex; align-items: center; gap: 10px;
    padding: 10px 12px;
    background: var(--accent-dim, rgba(59,130,246,0.10));
    border: 1px solid var(--accent, #3b82f6);
    border-radius: var(--radius-md);
    color: var(--text-1);
    font-size: 13px;
  }
  .draft-restored-banner .material-symbols-rounded { font-size: 20px; color: var(--accent, #3b82f6); }
  .draft-restored-text { flex: 1; }
  .draft-restored-discard {
    background: transparent;
    border: 1px solid var(--accent, #3b82f6);
    color: var(--accent, #3b82f6);
    padding: 4px 12px;
    border-radius: var(--radius-sm);
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
  }
  .draft-restored-discard:hover { background: var(--accent, #3b82f6); color: #fff; }
  .editor-card-title { font-size: 12px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-3); margin-bottom: 4px; }
  .form-row { display: flex; gap: 12px; align-items: flex-end; }
  /* Issues #69 + #70: nutrition basis + alt-unit + density UI */
  .basis-toggle {
    display: flex; gap: 8px;
  }
  .basis-opt {
    flex: 1; padding: 8px 12px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    color: var(--text-2);
    font-size: 14px;
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s, color 0.15s;
  }
  .basis-opt:hover { background: var(--surface-3); }
  .basis-opt.active {
    background: var(--accent-dim);
    border-color: var(--accent);
    color: var(--accent);
    font-weight: 600;
  }
  .form-hint {
    margin-top: 4px;
    font-size: 12px;
    color: var(--text-3);
    line-height: 1.4;
  }
  .alt-units {
    display: flex; flex-direction: column; gap: 8px;
  }
  .alt-unit-row {
    display: flex; align-items: center; gap: 6px;
  }
  .alt-unit-abbr { flex: 1; min-width: 0; }
  .alt-unit-grams { width: 90px; }
  .alt-unit-eq, .alt-unit-suffix { color: var(--text-3); font-size: 14px; }
  .alt-unit-del {
    width: 32px; height: 32px;
    background: transparent;
    border: 1px solid transparent;
    color: var(--text-3);
  }
  .alt-unit-del:hover {
    color: var(--danger, #ef4444);
    border-color: var(--border);
  }
  .alt-unit-del .material-symbols-rounded { font-size: 18px; }
  .alt-unit-add {
    align-self: flex-start;
    color: var(--accent);
    background: none;
    border: none;
    padding: 4px 0;
    cursor: pointer;
    font-size: 14px;
  }
  .alt-unit-add:hover { text-decoration: underline; }
  .off-verify-row {
    display: flex; align-items: center; justify-content: space-between;
    gap: 8px; font-size: 12px; padding: 6px 2px 0;
  }
  .off-verify-checking { color: var(--text-3); }
  .off-verify-ok { color: var(--success, #4caf50); }
  .off-verify-pending { color: var(--text-3); }
  .off-verify-link {
    color: var(--accent); text-decoration: none; font-size: 12px;
    white-space: nowrap; flex-shrink: 0;
  }
  .off-verify-link:hover { text-decoration: underline; }
  .cat-chips { display: flex; flex-wrap: wrap; gap: 8px; }
  /* Photo section */
  .photo-card { gap: 10px; }
  .photo-preview-wrap {
    position: relative;
    width: min(360px, 100%);
    aspect-ratio: 1 / 1;
    margin: 0 auto;
    background: var(--surface-2);
    border-radius: var(--radius-lg);
    overflow: hidden;
    display: flex;
    align-items: center;
    justify-content: center;
    border: 2px dashed var(--border-strong);
  }
  .photo-preview-wrap:has(.photo-preview-img) {
    border-style: solid;
    border-color: transparent;
  }
  .photo-preview-img {
    width: 100%;
    height: 100%;
    /* cover = scale to fill, center-cropped on overflow edges. Looks
       better than letterboxing for food photos where the subject is
       typically centered in the frame. */
    object-fit: cover;
    background: var(--surface-2);
  }
  .photo-placeholder { display: flex; align-items: center; justify-content: center; width: 100%; height: 100%; }
  .photo-remove-btn {
    position: absolute;
    top: 8px; right: 8px;
    background: rgba(0,0,0,0.55);
    color: #fff;
    border-radius: 50%;
    width: 32px; height: 32px;
  }
  .photo-btn-row { display: flex; gap: 8px; }
  .photo-action-btn {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 8px 12px;
    font-size: 13px;
  }
  .photo-action-btn .material-symbols-rounded { font-size: 18px; }
  .photo-url-row { display: flex; gap: 8px; margin-top: 8px; }
  .photo-url-input { flex: 1; }

  /* Camera / crop overlay — shared with MealEditor via :global */
  :global(.cam-overlay) {
    position: fixed; inset: 0; z-index: 9999;
    background: rgba(0,0,0,0.9);
    display: flex; align-items: center; justify-content: center;
  }
  :global(.cam-popup) {
    background: var(--surface-1);
    border-radius: var(--radius-xl);
    width: min(480px, 96vw);
    overflow: hidden;
    display: flex; flex-direction: column;
  }
  :global(.cam-header) {
    display: flex; align-items: center; justify-content: space-between;
    padding: 16px; border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  :global(.cam-title) { font-size: 17px; font-weight: 600; }
  :global(.cam-video) { width: 100%; max-height: 50vh; background: #000; display: block; }
  :global(.cam-footer) {
    padding: 16px;
    border-top: 1px solid var(--border);
    display: flex; justify-content: center;
    flex-shrink: 0;
  }
  :global(.cam-capture-btn) { gap: 6px; min-width: 140px; }
  /* Scan Label button — sits in the Nutrition card title row. Icon + text
     so the action is obvious (camera alone could be confused with food
     photo / profile picture). Compact enough to fit the title row on
     mobile. */
  .scan-label-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 32px;
    padding: 0 12px;
    border-radius: var(--radius-md);
    background: var(--surface-2);
    color: var(--text-1);
    border: 1px solid var(--border);
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: background var(--dur-fast) var(--ease-out);
  }
  .scan-label-btn:hover { background: var(--surface-3); }
  .scan-label-btn:disabled { opacity: 0.6; cursor: not-allowed; }
  .scan-label-btn .material-symbols-rounded { font-size: 18px; }

  /* progress_activity glyph rotates while the AI vision call is in flight.
     Same pattern used elsewhere (ConnectionStatus, Wizard) but kept
     component-scoped. */
  .scan-icon.spin {
    animation: spin 1s linear infinite;
    display: inline-block;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

</style>
