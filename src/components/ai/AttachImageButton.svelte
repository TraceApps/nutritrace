<script>
  // Trace's attach button. The same file in every Trace app, so keep the
  // copies identical: change one, change all four.
  //
  // On a phone, a tablet or the Android app it offers Camera or Gallery. On a
  // computer it opens the file picker straight away: desktop browsers ignore
  // the "open the camera" hint, so both choices would do the same thing.
  // In the Android app each choice goes straight to the camera or the system
  // photo picker instead of Android's generic chooser.
  //
  // Whatever the source, the parent gets the same thing: a `files` event
  // with an array of image Files.
  import { createEventDispatcher } from 'svelte';
  import { fade } from 'svelte/transition';
  import { _ } from 'svelte-i18n';
  import { isNative } from '../../lib/platform.js';

  /** Let the user pick several photos at once from the gallery. */
  export let multiple = false;
  export let disabled = false;
  /** Tooltip and accessible name, from the parent's own translations. */
  export let title = '';

  const dispatch = createEventDispatcher();
  let menuOpen = false;
  let wrap;
  let fileInput;
  let cameraInput;

  // A touch screen is where "Camera" means something; a mouse is not.
  const touch = isNative
    || (typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches);

  function onButton() {
    if (!touch) { fileInput?.click(); return; }
    menuOpen = !menuOpen;
  }

  function emit(files) {
    const images = files.filter(f => f && /^image\//.test(f.type));
    if (images.length) dispatch('files', images);
  }

  function onPicked(e) {
    emit(Array.from(e.target.files || []));
    e.target.value = '';
  }

  // A photo from the native picker, as a File like any other.
  async function toFile(webPath, format) {
    const blob = await (await fetch(webPath)).blob();
    const type = blob.type && blob.type.startsWith('image/') ? blob.type : `image/${format || 'jpeg'}`;
    return new File([blob], `photo.${(type.split('/')[1] || 'jpeg').replace('jpeg', 'jpg')}`, { type });
  }

  async function pickNative(fromCamera) {
    try {
      const { Camera, CameraResultType, CameraSource } = await import('@capacitor/camera');
      if (!fromCamera && multiple) {
        const { photos } = await Camera.pickImages({ quality: 80, width: 1024 });
        emit(await Promise.all((photos || []).map(p => toFile(p.webPath, p.format))));
        return;
      }
      const photo = await Camera.getPhoto({
        quality: 80,
        width: 1024,
        resultType: CameraResultType.Uri,
        source: fromCamera ? CameraSource.Camera : CameraSource.Photos,
      });
      emit([await toFile(photo.webPath, photo.format)]);
    } catch {
      // Closing the camera or the picker leaves things as they were.
    }
  }

  function choose(fromCamera) {
    menuOpen = false;
    if (isNative) pickNative(fromCamera);
    else (fromCamera ? cameraInput : fileInput)?.click();
  }

  function onWindowPointer(e) {
    if (menuOpen && wrap && !wrap.contains(e.target)) menuOpen = false;
  }
  function onWindowKey(e) {
    if (menuOpen && e.key === 'Escape') menuOpen = false;
  }
</script>

<svelte:window on:pointerdown={onWindowPointer} on:keydown={onWindowKey} />

<div class="attach" bind:this={wrap}>
  <button type="button" class="attach-image-btn" on:click={onButton} {disabled}
    {title} aria-label={title} aria-haspopup={touch ? 'menu' : undefined} aria-expanded={touch ? menuOpen : undefined}>
    <span class="material-symbols-rounded" aria-hidden="true">add_photo_alternate</span>
  </button>
  {#if menuOpen}
    <div class="attach-image-menu" role="menu" transition:fade={{ duration: 120 }}>
      <button type="button" role="menuitem" class="attach-image-option" on:click={() => choose(true)}>
        <span class="material-symbols-rounded" aria-hidden="true">photo_camera</span>
        {$_('attach_image.camera')}
      </button>
      <button type="button" role="menuitem" class="attach-image-option" on:click={() => choose(false)}>
        <span class="material-symbols-rounded" aria-hidden="true">photo_library</span>
        {$_('attach_image.gallery')}
      </button>
    </div>
  {/if}
  <input bind:this={fileInput} type="file" accept="image/*" {multiple} hidden on:change={onPicked} />
  <input bind:this={cameraInput} type="file" accept="image/*" capture="environment" hidden on:change={onPicked} />
</div>

<style>
  .attach { position: relative; flex-shrink: 0; }
  .attach-image-btn {
    width: 40px; height: 40px;
    border-radius: 50%;
    background: none;
    color: var(--text-3);
    border: 1px solid var(--border);
    cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    transition: color var(--dur-fast), border-color var(--dur-fast);
  }
  .attach-image-btn:hover:not(:disabled) { color: var(--accent); border-color: var(--accent); }
  .attach-image-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .attach-image-btn:disabled { opacity: 0.4; cursor: default; }
  .attach-image-btn .material-symbols-rounded { font-size: 20px; }
  .attach-image-menu {
    position: absolute;
    bottom: 48px;
    left: 0;
    z-index: 10;
    min-width: 160px;
    overflow: hidden;
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.2);
  }
  .attach-image-option {
    display: flex; align-items: center; gap: 10px;
    width: 100%;
    min-height: 48px;
    padding: 10px 14px;
    background: none;
    border: none;
    color: var(--text-1);
    font-size: 14px;
    text-align: left;
    cursor: pointer;
  }
  .attach-image-option .material-symbols-rounded { font-size: 20px; }
  .attach-image-option:hover { background: var(--surface-2); }
  .attach-image-option:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  .attach-image-option + .attach-image-option { border-top: 1px solid var(--border); }
</style>
