<script>
  import { onMount, onDestroy, tick } from 'svelte';
  import { pop, push } from 'svelte-spa-router';
  import { _ } from 'svelte-i18n';
  import Chart from 'chart.js/auto';
  import { portal } from '../lib/portal.js';
  import { NtApi } from '../lib/api.js';
  import { takePhoto } from '../lib/camera.js';
  import { isNative } from '../lib/platform.js';
  import { fitImageDataUrl } from '../lib/image-fit.js';
  import { localDateStr } from '../lib/db.js';
  import { displayExerciseWeight, tagExerciseWeight } from '../lib/exercise-weight.js';
  import { parsePeople, normalizePerson, pickLogPerson } from '../lib/exercise-people.js';
  import DateInput from '../components/ui/DateInput.svelte';
  import { currentDate } from '../stores/diary.js';
  import { exerciseMuscles, exercisePeople, catName as _catName, catDisplay as _catDisplay, cropPhotos, weightUnit } from '../stores/settings.js';
  import { showSuccess, showError } from '../stores/toast.js';
  import { confirmDialog } from '../stores/confirmDialog.js';
  import { get } from 'svelte/store';

  export let params = {};

  let exercise = {
    name: '', imgUrl: '', notes: '', muscle: '',
    people: parsePeople((get(exercisePeople) || []).map(p => p?.name ?? p)),
  };
  let saving = false;
  let deleting = false;
  let loaded = false;

  // ── Photo ──────────────────────────────────────────────────────────────
  let fileInput;
  let showCamera = false;
  let showUrlInput = false;
  let photoUrl = '';
  let cameraVideo = null;
  let cameraStream = null;
  let showCrop = false;
  let cropSrc = '';
  let cropImg = null;
  let cropBox = null;
  let cropDragging = false, cropStartX, cropStartY, cropOrigL, cropOrigT;

  function applyPhotoUrl() {
    const url = photoUrl.trim();
    if (url) exercise.imgUrl = url;
    showUrlInput = false;
    photoUrl = '';
  }
  function openGallery() { fileInput && fileInput.click(); }
  function onFileChange(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async ev => {
      if ($cropPhotos) { cropSrc = ev.target.result; showCrop = true; }
      else exercise.imgUrl = await fitImageDataUrl(ev.target.result);
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
          else exercise.imgUrl = await fitImageDataUrl(ev.target.result);
        };
        reader.readAsDataURL(file);
      } catch { /* cancelled */ }
      return;
    }
    showCamera = true;
    await new Promise(r => setTimeout(r, 80));
    try {
      cameraStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } }
      });
      if (cameraVideo) { cameraVideo.srcObject = cameraStream; cameraVideo.play(); }
    } catch {
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
    if ($cropPhotos) { cropSrc = dataUrl; showCrop = true; }
    else exercise.imgUrl = await fitImageDataUrl(dataUrl);
  }
  function removePhoto() { exercise.imgUrl = ''; }
  function onCropImgLoad() {
    if (!cropImg || !cropBox) return;
    const w = cropImg.offsetWidth, h = cropImg.offsetHeight;
    cropBox.style.left = Math.round(w * 0.1) + 'px';
    cropBox.style.top = Math.round(h * 0.1) + 'px';
    cropBox.style.width = Math.round(w * 0.8) + 'px';
    cropBox.style.height = Math.round(h * 0.8) + 'px';
  }
  function cropStartDrag(e) {
    cropDragging = true;
    const pt = e.touches ? e.touches[0] : e;
    cropStartX = pt.clientX; cropStartY = pt.clientY;
    cropOrigL = parseInt(cropBox.style.left); cropOrigT = parseInt(cropBox.style.top);
    e.preventDefault();
  }
  function cropMoveDrag(e) {
    if (!cropDragging || !cropImg || !cropBox) return;
    const pt = e.touches ? e.touches[0] : e;
    const w = cropImg.offsetWidth, h = cropImg.offsetHeight;
    cropBox.style.left = Math.max(0, Math.min(w - parseInt(cropBox.style.width), cropOrigL + pt.clientX - cropStartX)) + 'px';
    cropBox.style.top  = Math.max(0, Math.min(h - parseInt(cropBox.style.height), cropOrigT + pt.clientY - cropStartY)) + 'px';
  }
  function cropEndDrag() { cropDragging = false; }
  function confirmCrop() {
    if (!cropImg || !cropBox) return;
    const scaleX = cropImg.naturalWidth / cropImg.offsetWidth;
    const scaleY = cropImg.naturalHeight / cropImg.offsetHeight;
    const cx = parseInt(cropBox.style.left) * scaleX;
    const cy = parseInt(cropBox.style.top) * scaleY;
    const cw = parseInt(cropBox.style.width) * scaleX;
    const ch = parseInt(cropBox.style.height) * scaleY;
    const canvas = document.createElement('canvas');
    canvas.width = cw; canvas.height = ch;
    canvas.getContext('2d').drawImage(cropImg, cx, cy, cw, ch, 0, 0, cw, ch);
    exercise.imgUrl = canvas.toDataURL('image/jpeg', 0.9);
    showCrop = false; cropSrc = '';
  }

  // ── Muscle ─────────────────────────────────────────────────────────────
  let newMuscle = '';
  function selectMuscle(name) {
    exercise.muscle = exercise.muscle === name ? '' : name;
  }
  function addMuscle() {
    const name = newMuscle.trim();
    if (!name) return;
    const cats = get(exerciseMuscles) || [];
    if (!cats.some(c => _catName(c) === name)) {
      exerciseMuscles.set([...cats, { name }]);
    }
    exercise.muscle = name;
    newMuscle = '';
  }

  // ── People ─────────────────────────────────────────────────────────────
  let newPerson = '';
  let logPerson = '';
  $: assignedPeople = parsePeople(exercise.people);
  $: if (assignedPeople.length) {
    if (!logPerson || !assignedPeople.includes(logPerson)) {
      logPerson = pickLogPerson(assignedPeople, logPerson);
    }
  }
  function togglePerson(name) {
    const cur = parsePeople(exercise.people);
    exercise.people = cur.includes(name) ? cur.filter(p => p !== name) : [...cur, name];
  }
  function addPerson() {
    const name = newPerson.trim();
    if (!name) return;
    const cats = get(exercisePeople) || [];
    if (!cats.some(c => _catName(c) === name)) {
      exercisePeople.set([...cats, { name }]);
    }
    const cur = parsePeople(exercise.people);
    if (!cur.includes(name)) exercise.people = [...cur, name];
    newPerson = '';
  }

  // ── Save / delete schema ───────────────────────────────────────────────
  async function save() {
    if (!exercise.name.trim()) {
      showError($_('common.errors.name_required'));
      return;
    }
    saving = true;
    try {
      const payload = {
        name: exercise.name.trim(),
        img_url: exercise.imgUrl || null,
        notes: exercise.notes || null,
        muscle: exercise.muscle || null,
        people: parsePeople(exercise.people),
      };
      const saved = exercise.id
        ? await NtApi.updateExercise(exercise.id, payload)
        : await NtApi.createExercise(payload);
      showSuccess($_('exercises.saved'));
      if (!exercise.id && saved?.id) {
        push(`/exercises/edit/${saved.id}`);
      }
    } catch (e) {
      showError(e.message || $_('common.errors.save_failed'));
    } finally {
      saving = false;
    }
  }

  async function remove() {
    if (!exercise.id) return;
    if (!await confirmDialog({
      title: $_('exercises.delete_title'),
      message: $_('exercises.delete_msg', { values: { name: exercise.name } }),
      confirmText: $_('common.delete'),
      dangerous: true,
    })) return;
    deleting = true;
    try {
      await NtApi.deleteExercise(exercise.id);
      showSuccess($_('exercises.deleted'));
      pop();
    } catch (e) {
      showError(e.message || $_('common.errors.delete_failed'));
    } finally {
      deleting = false;
    }
  }

  // ── Daily log ──────────────────────────────────────────────────────────
  let logDate = '';
  let logWeight = '';
  let logDifficulty = 0;
  let logSaving = false;
  let logs = [];
  let chartEl;
  let chart = null;

  function fillLogForm() {
    const row = logs.find(l => l.date === logDate && (l.person || '') === (logPerson || ''));
    if (row) {
      const w = displayExerciseWeight(row, $weightUnit);
      logWeight = w != null ? String(w) : '';
      logDifficulty = row.difficulty || 0;
    } else {
      logWeight = '';
      logDifficulty = 0;
    }
  }

  async function loadLogs() {
    if (!exercise.id) return;
    try {
      logs = await NtApi.getExerciseLogs(exercise.id) || [];
    } catch {
      logs = [];
    }
    const people = parsePeople(exercise.people);
    if (people.length) logPerson = pickLogPerson(people, logPerson);
    fillLogForm();
    await tick();
    renderChart();
  }

  async function saveLog() {
    if (!exercise.id) return;
    const people = parsePeople(exercise.people);
    if (people.length && !normalizePerson(logPerson)) {
      showError($_('exercises.person_required'));
      return;
    }
    const tagged = tagExerciseWeight(logWeight, $weightUnit);
    if (tagged.weight == null && !logDifficulty) {
      showError($_('exercises.log_required'));
      return;
    }
    logSaving = true;
    try {
      await NtApi.upsertExerciseLog(exercise.id, logDate, {
        person: normalizePerson(logPerson),
        weight: tagged.weight,
        weight_unit: tagged.weight_unit,
        difficulty: logDifficulty || null,
      });
      showSuccess($_('exercises.log_saved'));
      await loadLogs();
    } catch (e) {
      showError(e.message || $_('common.errors.save_failed'));
    } finally {
      logSaving = false;
    }
  }

  async function deleteLog(date, person) {
    if (!await confirmDialog({
      title: $_('exercises.delete_log_title'),
      message: $_('exercises.delete_log_msg'),
      confirmText: $_('common.delete'),
      dangerous: true,
    })) return;
    try {
      await NtApi.deleteExerciseLog(exercise.id, date, person);
      if (date === logDate && (person || '') === (logPerson || '')) { logWeight = ''; logDifficulty = 0; }
      await loadLogs();
    } catch (e) {
      showError(e.message || $_('common.errors.delete_failed'));
    }
  }

  function renderChart() {
    if (!chartEl) return;
    if (chart) { chart.destroy(); chart = null; }
    const withData = logs.filter(l => l.weight != null || l.difficulty != null);
    if (!withData.length) return;

    const isDark = document.documentElement.getAttribute('data-theme') !== 'light';
    const accent = isDark ? '#4FFFB0' : '#00C47A';
    const textColor = isDark ? 'rgba(240,242,248,0.55)' : 'rgba(13,15,20,0.55)';
    const gridColor = isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.07)';
    const unit = $weightUnit || 'kg';
    const palette = [
      accent,
      isDark ? '#4FC3F7' : '#0277BD',
      isDark ? '#CE93D8' : '#8E24AA',
      isDark ? '#FFB547' : '#E65100',
      isDark ? '#F48FB1' : '#C2185B',
    ];

    const peopleKeys = [...new Set(withData.map(l => l.person || ''))];
    const named = peopleKeys.some(p => p);
    const dates = [...new Set(withData.map(l => l.date))].sort();
    const labels = dates.map(d => {
      const dt = new Date(d + 'T12:00:00');
      return dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    });
    const pt = dates.length > 60 ? 0 : 3;

    const datasets = peopleKeys.flatMap((person, i) => {
      const color = palette[i % palette.length];
      const byDate = Object.fromEntries(
        withData.filter(l => (l.person || '') === person).map(l => [l.date, l])
      );
      const who = person || (named ? $_('exercises.solo') : '');
      const weightLabel = who
        ? `${who} · ${$_('exercises.weight')} (${unit})`
        : $_('exercises.weight') + ` (${unit})`;
      const diffLabel = who
        ? `${who} · ${$_('exercises.difficulty')}`
        : $_('exercises.difficulty');
      return [
        {
          label: weightLabel,
          data: dates.map(d => displayExerciseWeight(byDate[d], unit)),
          yAxisID: 'y',
          borderColor: color,
          backgroundColor: isDark ? 'rgba(79,255,176,0.08)' : 'rgba(0,196,122,0.08)',
          borderWidth: 2.5,
          pointRadius: pt,
          tension: 0.35,
          fill: peopleKeys.length === 1,
          spanGaps: true,
        },
        {
          label: diffLabel,
          data: dates.map(d => byDate[d]?.difficulty ?? null),
          yAxisID: 'y1',
          borderColor: color,
          borderWidth: 1.5,
          borderDash: [6, 4],
          pointRadius: pt,
          tension: 0.35,
          fill: false,
          spanGaps: true,
        },
      ];
    });

    chart = new Chart(chartEl, {
      type: 'line',
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { labels: { color: textColor, boxWidth: 12, font: { size: 11 } } },
        },
        scales: {
          x: { ticks: { color: textColor, maxTicksLimit: 8 }, grid: { color: gridColor } },
          y: {
            position: 'left',
            title: { display: true, text: unit, color: textColor, font: { size: 11 } },
            ticks: { color: textColor },
            grid: { color: gridColor },
          },
          y1: {
            position: 'right',
            min: 1, max: 5,
            title: { display: true, text: $_('exercises.difficulty'), color: textColor, font: { size: 11 } },
            ticks: { color: textColor, stepSize: 1 },
            grid: { drawOnChartArea: false },
          },
        },
      },
    });
  }

  function fmtLogDate(iso) {
    return new Date(iso + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  onMount(async () => {
    logDate = $currentDate || localDateStr();
    if (params.id) {
      try {
        const row = await NtApi.getExercise(params.id);
        if (row) exercise = { ...exercise, ...row, people: parsePeople(row.people) };
      } catch {
        showError($_('exercises.not_found'));
      }
    }
    loaded = true;
    if (exercise.id) await loadLogs();
  });

  $: if (loaded && exercise.id && logDate) {
    logPerson; $weightUnit; logs;
    fillLogForm();
  }

  onDestroy(() => { if (chart) chart.destroy(); });
</script>

<div class="page-shell editor-page">
  <header class="editor-header">
    <button class="btn-icon" on:click={pop} aria-label={$_('common.back')} title={$_('common.back')}>
      <span class="material-symbols-rounded">arrow_back</span>
    </button>
    <h2 class="editor-title">{exercise.id ? $_('exercises.edit_title') : $_('exercises.add_title')}</h2>
    <button class="btn btn-primary" style="height:36px;padding:0 16px;font-size:13px"
      on:click={save} disabled={saving}>
      {saving ? $_('common.saving') : $_('common.save')}
    </button>
  </header>

  {#if loaded}
  <div class="page-content editor-content">
    <div class="card editor-card photo-card">
      <div class="editor-card-title">{$_('food_editor.card_photo')}</div>
      <div class="photo-preview-wrap">
        {#if exercise.imgUrl}
          <img class="photo-preview-img" src={exercise.imgUrl} alt="" />
          <button class="photo-remove-btn btn-icon" on:click={removePhoto} aria-label={$_('food_editor.photo_remove')} title={$_('food_editor.photo_remove')}>
            <span class="material-symbols-rounded" style="font-size:18px">close</span>
          </button>
        {:else}
          <div class="photo-placeholder">
            <span class="material-symbols-rounded" style="font-size:48px;opacity:0.25">fitness_center</span>
          </div>
        {/if}
      </div>
      <div class="photo-btn-row">
        <button class="btn btn-ghost photo-action-btn" on:click={openCamera}>
          <span class="material-symbols-rounded">camera_alt</span>
          {$_('exercises.camera')}
        </button>
        <button class="btn btn-ghost photo-action-btn" on:click={openGallery}>
          <span class="material-symbols-rounded">photo_library</span>
          {$_('exercises.upload')}
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
          <button class="btn btn-primary" on:click={applyPhotoUrl}>{$_('exercises.get_url')}</button>
        </div>
      {/if}
      <input bind:this={fileInput} type="file" accept="image/*" style="display:none" on:change={onFileChange} />
    </div>

    {#if showCamera}
      <div class="cam-overlay" role="dialog" aria-modal="true" use:portal>
        <div class="cam-popup">
          <div class="cam-header">
            <span class="cam-title">{$_('food_editor.take_photo')}</span>
            <button class="btn-icon" on:click={stopCamera} aria-label={$_('common.close')}>
              <span class="material-symbols-rounded">close</span>
            </button>
          </div>
          <!-- svelte-ignore a11y-media-has-caption -->
          <video bind:this={cameraVideo} autoplay playsinline muted class="cam-video"></video>
          <div class="cam-footer">
            <button class="btn btn-primary cam-capture-btn" on:click={capturePhoto}>
              <span class="material-symbols-rounded">camera_alt</span>
              {$_('exercises.capture')}
            </button>
          </div>
        </div>
      </div>
    {/if}

    {#if showCrop}
      <div class="cam-overlay" role="dialog" aria-modal="true" use:portal>
        <div class="cam-popup">
          <div class="cam-header">
            <span class="cam-title">{$_('food_editor.crop_photo')}</span>
            <button class="btn-icon" on:click={() => { showCrop = false; cropSrc = ''; }} aria-label={$_('common.cancel')}>
              <span class="material-symbols-rounded">close</span>
            </button>
          </div>
          <p class="crop-hint">{$_('food_editor.crop_hint')}</p>
          <div class="crop-container"
            on:mousemove={cropMoveDrag} on:touchmove={cropMoveDrag}
            on:mouseup={cropEndDrag} on:touchend={cropEndDrag}>
            <img bind:this={cropImg} src={cropSrc} class="crop-img" alt="" on:load={onCropImgLoad} />
            <div bind:this={cropBox} class="crop-box"
              on:mousedown={cropStartDrag} on:touchstart={cropStartDrag}></div>
          </div>
          <div class="cam-footer">
            <button class="btn btn-primary" on:click={confirmCrop}>{$_('exercises.crop_use')}</button>
          </div>
        </div>
      </div>
    {/if}

    <div class="card editor-card">
      <div class="editor-card-title">{$_('exercises.details')}</div>
      <div class="form-group">
        <label class="form-label">{$_('exercises.name')} *</label>
        <input class="input" placeholder={$_('exercises.name_placeholder')} bind:value={exercise.name} />
      </div>
      <div class="form-group">
        <label class="form-label">{$_('exercises.muscle')}</label>
        <div class="muscle-chips">
          {#each ($exerciseMuscles || []) as m}
            <button type="button" class="chip" class:chip-active={exercise.muscle === _catName(m)}
              on:click={() => selectMuscle(_catName(m))}>{_catDisplay(m)}</button>
          {/each}
        </div>
        <div class="muscle-add">
          <input class="input" placeholder={$_('exercises.new_muscle_placeholder')} bind:value={newMuscle}
            on:keydown={e => e.key === 'Enter' && addMuscle()} />
          <button class="btn btn-secondary" type="button" on:click={addMuscle}>{$_('exercises.add')}</button>
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">{$_('exercises.people')}</label>
        <p class="diff-hint" style="margin-bottom:8px">{$_('exercises.people_hint')}</p>
        <div class="muscle-chips">
          {#each ($exercisePeople || []) as p}
            <button type="button" class="chip" class:chip-active={assignedPeople.includes(_catName(p))}
              on:click={() => togglePerson(_catName(p))}>{_catDisplay(p)}</button>
          {/each}
        </div>
        <div class="muscle-add">
          <input class="input" placeholder={$_('exercises.new_person_placeholder')} bind:value={newPerson}
            on:keydown={e => e.key === 'Enter' && addPerson()} />
          <button class="btn btn-secondary" type="button" on:click={addPerson}>{$_('exercises.add')}</button>
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">{$_('exercises.notes')}</label>
        <textarea class="input" rows="3" bind:value={exercise.notes} placeholder={$_('exercises.notes_placeholder')}></textarea>
      </div>
    </div>

    {#if exercise.id}
      <div class="card editor-card">
        <div class="editor-card-title">{$_('exercises.log_session')}</div>
        <div class="form-group">
          <label class="form-label">{$_('exercises.date')}</label>
          <DateInput bind:value={logDate} max={localDateStr()} />
        </div>
        {#if assignedPeople.length}
          <div class="form-group">
            <label class="form-label">{$_('exercises.person')}</label>
            <div class="muscle-chips">
              {#each assignedPeople as p}
                <button type="button" class="chip" class:chip-active={logPerson === p}
                  on:click={() => logPerson = p}>{p}</button>
              {/each}
            </div>
          </div>
        {/if}
        <div class="form-group">
          <label class="form-label">{$_('exercises.weight')} ({$weightUnit || 'kg'})</label>
          <input class="input" type="number" step="0.5" min="0" bind:value={logWeight}
            placeholder={$_('exercises.weight_placeholder')} />
        </div>
        <div class="form-group">
          <label class="form-label">{$_('exercises.difficulty')}</label>
          <div class="diff-row">
            {#each [1,2,3,4,5] as n}
              <button class="diff-btn" class:active={logDifficulty === n} type="button"
                on:click={() => logDifficulty = logDifficulty === n ? 0 : n}>{n}</button>
            {/each}
          </div>
          <div class="diff-hint">{$_('exercises.difficulty_hint')}</div>
        </div>
        <button class="btn btn-primary" type="button" disabled={logSaving} on:click={saveLog}>
          {logSaving ? $_('common.saving') : $_('exercises.save_log')}
        </button>
      </div>

      {#if logs.some(l => l.weight != null || l.difficulty != null)}
        <div class="card editor-card">
          <div class="editor-card-title">{$_('exercises.trend')}</div>
          <div class="chart-wrap">
            <canvas bind:this={chartEl}></canvas>
          </div>
        </div>
      {/if}

      {#if logs.length}
        <div class="card editor-card">
          <div class="editor-card-title">{$_('exercises.history')}</div>
          <div class="history-list">
            {#each [...logs].reverse() as row}
              <div class="history-row">
                <div>
                  <div class="history-date">{fmtLogDate(row.date)}</div>
                  <div class="history-meta">
                    {#if row.person}{row.person}{/if}
                    {#if row.person && (row.weight != null || row.difficulty)} · {/if}
                    {#if row.weight != null}{displayExerciseWeight(row, $weightUnit)} {$weightUnit}{/if}
                    {#if row.weight != null && row.difficulty} · {/if}
                    {#if row.difficulty}{row.difficulty}/5{/if}
                  </div>
                </div>
                <button class="btn-icon" on:click={() => deleteLog(row.date, row.person)} aria-label={$_('common.delete')}>
                  <span class="material-symbols-rounded" style="font-size:18px">close</span>
                </button>
              </div>
            {/each}
          </div>
        </div>
      {/if}

      <button class="btn btn-danger-ghost" type="button" disabled={deleting} on:click={remove}>
        {deleting ? $_('common.saving') : $_('exercises.delete')}
      </button>
    {/if}
  </div>
  {/if}
</div>

<style>
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
    width: 100%; height: 100%; object-fit: cover; background: var(--surface-2);
  }
  .photo-placeholder { display: flex; align-items: center; justify-content: center; width: 100%; height: 100%; }
  .photo-remove-btn {
    position: absolute; top: 8px; right: 8px;
    background: rgba(0,0,0,0.55); color: #fff; border-radius: 50%;
    width: 32px; height: 32px;
  }
  .photo-btn-row { display: flex; gap: 8px; }
  .photo-action-btn {
    flex: 1; display: flex; align-items: center; justify-content: center;
    gap: 6px; padding: 8px 12px; font-size: 13px;
  }
  .photo-action-btn .material-symbols-rounded { font-size: 18px; }
  .photo-url-row { display: flex; gap: 8px; margin-top: 8px; }
  .photo-url-input { flex: 1; }
  .muscle-chips { display: flex; flex-wrap: wrap; gap: 8px; }
  .muscle-chips :global(.chip) {
    padding: 6px 12px; border-radius: 99px;
    border: 1.5px solid var(--border); background: transparent;
    color: var(--text-2); font-size: 13px; cursor: pointer;
  }
  .muscle-chips :global(.chip-active) {
    border-color: var(--accent); background: var(--accent-dim);
    color: var(--accent); font-weight: 600;
  }
  .muscle-add { display: flex; gap: 8px; margin-top: 8px; }
  .diff-row { display: flex; gap: 8px; }
  .diff-btn {
    flex: 1; height: 40px; border-radius: var(--radius-md);
    border: 1.5px solid var(--border); background: transparent;
    color: var(--text-2); font-weight: 600; cursor: pointer;
  }
  .diff-btn.active {
    border-color: var(--accent); background: var(--accent-dim); color: var(--accent);
  }
  .diff-hint { font-size: 12px; color: var(--text-3); margin-top: 4px; }
  .chart-wrap { height: 220px; }
  .history-list { display: flex; flex-direction: column; }
  .history-row {
    display: flex; align-items: center; justify-content: space-between;
    padding: 10px 0;
    border-bottom: 1px solid var(--border);
  }
  .history-row:last-child { border-bottom: none; }
  .history-date { font-weight: 600; font-size: 14px; }
  .history-meta { font-size: 12px; color: var(--text-3); }
  .btn-danger-ghost {
    width: 100%; margin: 8px 0 32px; background: none; border: 1px solid var(--danger, #ef4444);
    color: var(--danger, #ef4444); height: 44px; border-radius: var(--radius-md); cursor: pointer;
  }

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
  }
  :global(.cam-title) { font-size: 17px; font-weight: 600; }
  :global(.cam-video) { width: 100%; max-height: 50vh; background: #000; display: block; }
  :global(.cam-footer) {
    padding: 16px; border-top: 1px solid var(--border);
    display: flex; justify-content: center;
  }
  :global(.cam-capture-btn) { gap: 6px; min-width: 140px; }
  :global(.crop-hint) { padding: 8px 16px 0; font-size: 12px; color: var(--text-3); }
  :global(.crop-container) { position: relative; overflow: hidden; user-select: none; touch-action: none; }
  :global(.crop-img) { display: block; max-width: 100%; max-height: 55vh; user-select: none; }
  :global(.crop-box) {
    position: absolute; border: 2px solid #fff;
    box-shadow: 0 0 0 9999px rgba(0,0,0,0.5);
    cursor: move; box-sizing: border-box; touch-action: none;
  }
</style>
