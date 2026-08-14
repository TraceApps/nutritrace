<script>
  import { createEventDispatcher } from 'svelte';
  import { portal } from '../../lib/portal.js';
  import { centeredSquareCrop, moveSquareCrop, resizeSquareCrop } from '../../lib/crop-geometry.js';

  export let src = '';
  export let title = 'Crop Photo';
  export let hint = 'Drag to reposition; drag the corner to resize';
  export let confirmLabel = 'Crop & Use';
  export let cancelLabel = 'Cancel';
  export let outputSize = null;

  const dispatch = createEventDispatcher();
  let container;
  let image;
  let imageOffsetX = 0;
  let crop = { x: 0, y: 0, size: 0 };
  let interaction = null;

  function initializeCrop() {
    if (!image) return;
    imageOffsetX = image.offsetLeft;
    crop = centeredSquareCrop(image.offsetWidth, image.offsetHeight);
  }

  function startInteraction(event, mode) {
    if (event.button != null && event.button !== 0) return;
    interaction = {
      mode,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      crop: { ...crop },
    };
    container?.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  }

  function updateInteraction(event) {
    if (!interaction || event.pointerId !== interaction.pointerId || !image) return;
    const deltaX = event.clientX - interaction.startX;
    const deltaY = event.clientY - interaction.startY;
    crop = interaction.mode === 'move'
      ? moveSquareCrop(interaction.crop, deltaX, deltaY, image.offsetWidth, image.offsetHeight)
      : resizeSquareCrop(interaction.crop, deltaX, deltaY, image.offsetWidth, image.offsetHeight);
    event.preventDefault();
  }

  function endInteraction(event) {
    if (!interaction || event.pointerId !== interaction.pointerId) return;
    if (container?.hasPointerCapture?.(event.pointerId)) container.releasePointerCapture(event.pointerId);
    interaction = null;
  }

  function confirm() {
    if (!image || crop.size <= 0) return;
    const scaleX = image.naturalWidth / image.offsetWidth;
    const scaleY = image.naturalHeight / image.offsetHeight;
    const naturalCropSize = Math.max(1, Math.round(Math.min(crop.size * scaleX, crop.size * scaleY)));
    const finalSize = outputSize == null ? naturalCropSize : Math.max(1, Math.round(outputSize));
    const canvas = document.createElement('canvas');
    canvas.width = finalSize;
    canvas.height = finalSize;
    canvas.getContext('2d').drawImage(
      image,
      crop.x * scaleX,
      crop.y * scaleY,
      crop.size * scaleX,
      crop.size * scaleY,
      0,
      0,
      finalSize,
      finalSize,
    );
    dispatch('confirm', { dataUrl: canvas.toDataURL('image/jpeg', 0.9) });
  }
</script>

<div class="crop-overlay" role="dialog" aria-modal="true" use:portal>
  <div class="crop-popup">
    <div class="crop-header">
      <span class="crop-title">{title}</span>
      <button class="btn-icon" on:click={() => dispatch('cancel')} aria-label={cancelLabel} title={cancelLabel}>
        <span class="material-symbols-rounded">close</span>
      </button>
    </div>
    <p class="crop-hint">{hint}</p>
    <div
      class="crop-container"
      bind:this={container}
      on:pointermove={updateInteraction}
      on:pointerup={endInteraction}
      on:pointercancel={endInteraction}
      role="img"
      aria-label={title}
    >
      <img bind:this={image} {src} class="crop-image" alt="" draggable="false" on:load={initializeCrop} />
      {#if crop.size > 0}
        <div
          class="crop-box"
          class:dragging={interaction?.mode === 'move'}
          style="left:{imageOffsetX + crop.x}px;top:{crop.y}px;width:{crop.size}px;height:{crop.size}px"
          on:pointerdown={(event) => startInteraction(event, 'move')}
          role="button"
          tabindex="0"
          aria-label="Drag to reposition crop"
          on:keydown={() => {}}
        >
          <button
            type="button"
            class="crop-resize-handle"
            on:pointerdown|stopPropagation={(event) => startInteraction(event, 'resize')}
            aria-label="Drag to resize crop"
          ></button>
        </div>
      {/if}
    </div>
    <div class="crop-footer">
      <button class="btn btn-primary" on:click={confirm}>{confirmLabel}</button>
    </div>
  </div>
</div>

<style>
  .crop-overlay {
    position: fixed;
    inset: 0;
    z-index: 9999;
    background: rgba(0, 0, 0, 0.9);
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .crop-popup {
    width: min(480px, 96vw);
    overflow: hidden;
    border-radius: var(--radius-xl);
    background: var(--surface-1);
    display: flex;
    flex-direction: column;
  }
  .crop-header {
    padding: 16px;
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-shrink: 0;
  }
  .crop-title { font-size: 17px; font-weight: 600; }
  .crop-hint { margin: 0; padding: 8px 16px; font-size: 12px; color: var(--text-3); }
  .crop-container {
    position: relative;
    overflow: hidden;
    user-select: none;
    touch-action: none;
  }
  .crop-image {
    display: block;
    margin: 0 auto;
    max-width: 100%;
    max-height: 55vh;
    user-select: none;
    pointer-events: none;
  }
  .crop-box {
    position: absolute;
    box-sizing: border-box;
    border: 2px solid #fff;
    box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.5);
    cursor: grab;
    touch-action: none;
  }
  .crop-box.dragging { cursor: grabbing; }
  .crop-resize-handle {
    position: absolute;
    right: -2px;
    bottom: -2px;
    width: 30px;
    height: 30px;
    padding: 0;
    border: 0;
    border-radius: 14px 0 0 0;
    background: var(--accent);
    cursor: nwse-resize;
    touch-action: none;
  }
  .crop-resize-handle::before {
    content: '';
    position: absolute;
    right: 6px;
    bottom: 6px;
    width: 10px;
    height: 10px;
    border-right: 2px solid #fff;
    border-bottom: 2px solid #fff;
  }
  .crop-footer {
    padding: 16px;
    border-top: 1px solid var(--border);
    display: flex;
    justify-content: center;
    flex-shrink: 0;
  }
</style>
