<script>
  import { onMount, onDestroy, createEventDispatcher } from 'svelte';
  import { fly } from 'svelte/transition';
  import { isNative } from '../../lib/platform.js';

  // Portal to document.body — prevents position:fixed being trapped by
  // ancestor transforms or opacity transitions (common iOS issue)
  function modalPortal(node) {
    document.body.appendChild(node);
    document.body.style.overflow = 'hidden';
    return {
      destroy() {
        node.remove();
        document.body.style.overflow = '';
      }
    };
  }
  import { barcodeBeep, barcodeFlashlight } from '../../stores/settings.js';

  export let open = false;

  const dispatch = createEventDispatcher();

  let readerId = 'scanner-' + Math.random().toString(36).slice(2);
  let scannerDiv;
  let engine = null;
  let detected = false;
  let continuousMode = true;
  let selectedEngine = localStorage.getItem('wl_scanEngine') || 'zxing';
  let selectedCamId  = localStorage.getItem('wl_scanCamId')  || '';
  let cameras = [];
  let status = 'Requesting camera…';
  let torchVisible = false;
  let torchOn = false;
  let manualCode = '';
  let scanlineVisible = false;
  let scanning = false;

  // CSS injected for quagga/html5qr video fill
  let styleEl = null;

  const _hideEl = el => {
    el.style.setProperty('display','none','important');
    el.style.setProperty('visibility','hidden','important');
  };

  let h5Observer = null;

  function playBeep() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.type = 'sine'; osc.frequency.value = 1046;
      gain.gain.setValueAtTime(0.4, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
      osc.start(ctx.currentTime); osc.stop(ctx.currentTime + 0.15);
    } catch(e) {}
  }

  async function stopEngine() {
    if (!engine) return;
    try {
      if (engine._type === 'zxing') {
        engine.reader.reset();
        if (engine.videoEl && engine.videoEl.srcObject) {
          engine.videoEl.srcObject.getTracks().forEach(t => t.stop());
          engine.videoEl.srcObject = null;
        }
      } else if (engine._type === 'html5qr' && engine.running) {
        await engine.reader.stop().catch(() => {});
      } else if (engine._type === 'quagga2') {
        try { window.Quagga && Quagga.stop(); } catch(e) {}
      }
    } catch(e) {}
    engine = null;
  }

  async function close() {
    detected = true;
    scanning = false;
    await stopEngine();
    if (h5Observer) { h5Observer.disconnect(); h5Observer = null; }
    if (styleEl) { styleEl.remove(); styleEl = null; }
    dispatch('close');
  }

  async function onCode(code) {
    if (detected) return;
    detected = true;
    if ($barcodeBeep) playBeep();
    scanlineVisible = true;
    setTimeout(() => scanlineVisible = false, 500);
    if (!continuousMode) {
      await close();
      dispatch('scan', { code });
    } else {
      dispatch('scan', { code });
      // Allow another scan in continuous mode after a short cooldown
      setTimeout(() => { detected = false; }, 1500);
    }
  }

  async function startCamera(deviceId) {
    if (detected || !deviceId || !scannerDiv) return;
    status = 'Starting camera…';
    torchVisible = false;
    torchOn = false;

    if (selectedEngine === 'zxing') {
      if (!window.ZXing || !ZXing.BrowserMultiFormatReader) { status = 'ZXing not loaded.'; return; }
      scannerDiv.innerHTML = '';
      const videoEl = document.createElement('video');
      videoEl.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block;position:absolute;top:0;left:0';
      videoEl.setAttribute('playsinline', ''); videoEl.setAttribute('muted', '');
      scannerDiv.appendChild(videoEl);
      const reader = new ZXing.BrowserMultiFormatReader();
      engine = { _type: 'zxing', reader, videoEl, torchOn: false };
      navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: deviceId } } })
        .then(stream => {
          videoEl.srcObject = stream;
          return videoEl.play().then(() => reader.decodeFromStream(stream, videoEl, async r => { if (r) await onCode(r.getText()); }));
        }).then(() => {
          if (!detected) status = continuousMode ? 'Continuous Scan' : 'Align Barcode';
          try {
            const t = videoEl.srcObject && videoEl.srcObject.getVideoTracks()[0];
            if (t) {
              const caps = t.getCapabilities ? t.getCapabilities() : {};
              if ('torch' in caps) {
                torchVisible = true;
                if ($barcodeFlashlight) {
                  torchOn = true; engine.torchOn = true;
                  t.applyConstraints({ advanced: [{ torch: true }] }).catch(() => {});
                }
              }
            }
          } catch(e) {}
        }).catch(err => { console.error('[ZXing]', err); status = 'Camera error — try another engine.'; });

    } else if (selectedEngine === 'html5qr') {
      if (!window.Html5Qrcode) { status = 'html5-qrcode not loaded.'; return; }
      scannerDiv.innerHTML = '';
      const hId = readerId + 'h';
      const inner = document.createElement('div');
      inner.id = hId; inner.style.cssText = 'width:100%;height:100%;position:relative';
      scannerDiv.appendChild(inner);

      if (h5Observer) h5Observer.disconnect();
      h5Observer = new MutationObserver(mutations => {
        mutations.forEach(m => {
          m.addedNodes && m.addedNodes.forEach(node => {
            if (node.nodeType !== 1) return;
            const id = node.id || '';
            if (id === 'qr-shaded-region' || id.includes('__scan_region__') || id.includes('__dashboard') || id.includes('__header')) {
              _hideEl(node);
            } else if (id.includes('__scan_region')) {
              node.style.setProperty('position','absolute','important');
              node.style.setProperty('inset','0','important');
              node.style.setProperty('width','100%','important');
              node.style.setProperty('height','100%','important');
              node.style.setProperty('border','none','important');
              node.style.setProperty('box-shadow','none','important');
            } else if (node.tagName === 'VIDEO') {
              node.style.cssText = 'width:100%!important;height:100%!important;object-fit:cover!important;position:absolute!important;top:0!important;left:0!important;display:block!important';
            } else if (node.tagName !== 'CANVAS' && id && id.startsWith(hId)) {
              _hideEl(node);
            }
          });
          if (m.type === 'attributes' && m.target && m.target.nodeType === 1) {
            const id = m.target.id || '';
            if (id === 'qr-shaded-region' || id.includes('__scan_region__') || id.includes('__dashboard') || id.includes('__header')) {
              _hideEl(m.target);
            }
          }
        });
      });
      h5Observer.observe(inner, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] });

      const reader = new Html5Qrcode(inner.id);
      engine = { _type: 'html5qr', reader, running: false, torchOn: false };
      reader.start(deviceId, { fps: 10 }, async t => await onCode(t), () => {})
        .then(() => {
          engine.running = true;
          if (!detected) status = continuousMode ? 'Continuous Scan' : 'Align Barcode';
          try {
            inner.querySelectorAll('div,img,button,span').forEach(el => _hideEl(el));
            const shaded = document.getElementById('qr-shaded-region');
            if (shaded) _hideEl(shaded);
            const vid = inner.querySelector('video');
            if (vid) {
              vid.style.setProperty('display','block','important');
              vid.style.setProperty('visibility','visible','important');
              vid.style.setProperty('width','100%','important');
              vid.style.setProperty('height','100%','important');
              vid.style.setProperty('object-fit','cover','important');
              vid.style.setProperty('position','absolute','important');
              vid.style.setProperty('top','0','important');
              vid.style.setProperty('left','0','important');
            }
          } catch(e) {}
          try {
            const caps = reader.getRunningTrackCameraCapabilities();
            const tf = caps.torchFeature();
            if (tf.isSupported()) {
              torchVisible = true;
              if ($barcodeFlashlight) {
                torchOn = true; engine.torchOn = true;
                tf.apply(true).catch(() => {});
              }
            }
          } catch(e) {}
        }).catch(err => { console.error('[html5qr]', err); status = 'Camera error — try another engine.'; });

    } else if (selectedEngine === 'quagga2') {
      if (!window.Quagga) { status = 'Quagga2 not loaded.'; return; }
      scannerDiv.innerHTML = '';
      engine = { _type: 'quagga2', torchOn: false };
      Quagga.init({
        inputStream: { type: 'LiveStream', target: scannerDiv, constraints: { deviceId: { exact: deviceId } } },
        decoder: { readers: ['ean_reader','ean_8_reader','upc_reader','upc_e_reader','code_128_reader','code_39_reader'] },
        locate: true
      }, err => {
        if (err) { console.error('[Quagga2]', err); status = 'Quagga2 error — try another engine.'; return; }
        Quagga.start();
        if (!detected) status = continuousMode ? 'Continuous Scan' : 'Align Barcode';
        setTimeout(() => {
          try {
            const t = window.Quagga && Quagga.CameraAccess && Quagga.CameraAccess.getActiveTrack && Quagga.CameraAccess.getActiveTrack();
            if (t) {
              const caps = t.getCapabilities ? t.getCapabilities() : {};
              if ('torch' in caps) {
                torchVisible = true;
                if ($barcodeFlashlight) {
                  torchOn = true; engine.torchOn = true;
                  t.applyConstraints({ advanced: [{ torch: true }] }).catch(() => {});
                }
              }
            }
          } catch(e) {}
        }, 800);
      });
      Quagga.offDetected();
      Quagga.onDetected(async result => { if (result && result.codeResult) await onCode(result.codeResult.code); });
    }
  }

  async function toggleTorch() {
    if (!engine) return;
    torchOn = !torchOn;
    engine.torchOn = torchOn;
    try {
      if (engine._type === 'zxing' && engine.videoEl && engine.videoEl.srcObject) {
        const t = engine.videoEl.srcObject.getVideoTracks()[0];
        if (t) await t.applyConstraints({ advanced: [{ torch: torchOn }] });
      } else if (engine._type === 'html5qr') {
        await engine.reader.getRunningTrackCameraCapabilities().torchFeature().apply(torchOn).catch(() => {});
      } else if (engine._type === 'quagga2') {
        const t = window.Quagga && Quagga.CameraAccess && Quagga.CameraAccess.getActiveTrack && Quagga.CameraAccess.getActiveTrack();
        if (t) await t.applyConstraints({ advanced: [{ torch: torchOn }] }).catch(() => {});
      }
    } catch(e) {}
  }

  async function onEngineChange(e) {
    selectedEngine = e.target.value;
    localStorage.setItem('wl_scanEngine', selectedEngine);
    await stopEngine();
    if (scannerDiv) scannerDiv.innerHTML = '';
    torchVisible = false;
    if (selectedCamId) setTimeout(() => startCamera(selectedCamId), 300);
  }

  async function onCamChange(e) {
    selectedCamId = e.target.value;
    localStorage.setItem('wl_scanCamId', selectedCamId);
    await stopEngine();
    if (scannerDiv) scannerDiv.innerHTML = '';
    torchVisible = false;
    setTimeout(() => startCamera(selectedCamId), 300);
  }

  async function refresh() {
    if (!selectedCamId) return;
    await stopEngine();
    if (scannerDiv) scannerDiv.innerHTML = '';
    torchVisible = false;
    setTimeout(() => startCamera(selectedCamId), 300);
  }

  async function toggleContinuous() {
    continuousMode = !continuousMode;
    status = continuousMode ? 'Continuous Scan' : 'Align Barcode';
  }

  async function doManual() {
    if (detected) return;
    const code = manualCode.trim();
    if (!code) return;
    detected = true;
    await close();
    dispatch('scan', { code });
  }

  function startScanner() {
    detected = false;
    scanning = true;

    // Inject video fill CSS
    styleEl = document.createElement('style');
    styleEl.textContent =
      '#' + readerId + ' video{width:100%!important;height:100%!important;object-fit:cover!important;position:absolute!important;top:0!important;left:0!important;display:block!important}' +
      '#' + readerId + ' canvas{width:100%!important;height:100%!important;position:absolute!important;top:0!important;left:0!important;pointer-events:none!important}';
    document.head.appendChild(styleEl);

    navigator.mediaDevices.getUserMedia({ video: true })
      .then(ps => { ps.getTracks().forEach(t => t.stop()); return navigator.mediaDevices.enumerateDevices(); })
      .then(devices => {
        if (detected) return;
        cameras = devices.filter(d => d.kind === 'videoinput').map((d, i) => ({
          deviceId: d.deviceId, label: d.label || ('Camera ' + (i + 1))
        }));
        if (!cameras.length) { status = 'No camera found.'; return; }
        const preferred = (selectedCamId && cameras.find(d => d.deviceId === selectedCamId))
                       || cameras.find(d => /back|rear|environment/i.test(d.label))
                       || cameras[0];
        selectedCamId = preferred.deviceId;
        localStorage.setItem('wl_scanCamId', selectedCamId);
        startCamera(selectedCamId);
      })
      .catch(() => { status = 'Camera access denied.'; });
  }

  // Native mode: use ML Kit barcode scanner instead of HTML5 camera
  async function startNativeScanner() {
    scanning = true;
    try {
      const { BarcodeScanner } = await import('@capacitor-mlkit/barcode-scanning');

      // Request camera permission
      const perms = await BarcodeScanner.requestPermissions();
      if (perms.camera !== 'granted') {
        const { showError } = await import('../../stores/toast.js');
        showError('Camera permission denied');
        open = false; scanning = false;
        return;
      }

      // Check/install the Google Barcode Scanner module (required for scan())
      try {
        const { available } = await BarcodeScanner.isGoogleBarcodeScannerModuleAvailable();
        if (!available) await BarcodeScanner.installGoogleBarcodeScannerModule();
      } catch {}

      // Scan — opens native Google Code Scanner (no format filter = scan all)
      const { barcodes } = await BarcodeScanner.scan();

      if (barcodes.length > 0) {
        const code = barcodes[0].rawValue;
        if ($barcodeBeep) playBeep();
        dispatch('scan', { code });
      }
      open = false; scanning = false;
    } catch (e) {
      console.error('[BarcodeScanner] Native scan failed:', e);
      const { showError } = await import('../../stores/toast.js');
      showError('Barcode scan failed: ' + (e?.message || 'Unknown error'));
      open = false; scanning = false;
    }
  }

  $: if (open && !scanning) {
    if (isNative) startNativeScanner();
    else startScanner();
  }
  $: if (!open && scanning) close();

  onDestroy(() => {
    detected = true;
    stopEngine();
    if (h5Observer) h5Observer.disconnect();
    if (styleEl) styleEl.remove();
  });
</script>

{#if open && !isNative}
  <div class="scanner-backdrop" use:modalPortal on:click={close} transition:fly={{ y: 20, duration: 220 }}>
    <div class="scanner-panel" on:click|stopPropagation>
      <!-- Header -->
      <div class="scanner-header">
        <span class="scanner-title">Scan Barcode</span>
        <button class="btn-icon" on:click={close} aria-label="Close" title="Close scanner">
          <span class="material-symbols-rounded">close</span>
        </button>
      </div>

      <!-- Engine + Camera selects -->
      <div class="scanner-controls">
        <div class="sc-field">
          <label class="sc-label">Library</label>
          <select class="sc-select" bind:value={selectedEngine} on:change={onEngineChange}>
            <option value="zxing">@zxing/library</option>
            <option value="html5qr">html5-qrcode</option>
            <option value="quagga2">quagga2</option>
          </select>
        </div>
        <div class="sc-field">
          <label class="sc-label">Camera</label>
          <select class="sc-select" bind:value={selectedCamId} on:change={onCamChange}>
            {#if cameras.length === 0}
              <option>Loading…</option>
            {:else}
              {#each cameras as cam}
                <option value={cam.deviceId}>{cam.label}</option>
              {/each}
            {/if}
          </select>
        </div>
      </div>

      <!-- Viewport -->
      <div class="scanner-viewport">
        <div id={readerId} bind:this={scannerDiv} class="scanner-feed"></div>
        <!-- Aim guide -->
        <div class="scanner-aim" aria-hidden="true">
          <div class="aim-box">
            <div class="aim-corner tl"></div>
            <div class="aim-corner tr"></div>
            <div class="aim-corner bl"></div>
            <div class="aim-corner br"></div>
            {#if scanlineVisible}
              <div class="aim-scanline"></div>
            {/if}
          </div>
        </div>
        <!-- Status pill -->
        <div class="scanner-status-pill">{status}</div>
      </div>

      <!-- Action buttons -->
      <div class="scanner-actions">
        <button class="sc-btn" class:sc-btn-active={continuousMode} on:click={toggleContinuous}>
          <span class="material-symbols-rounded">qr_code_scanner</span>
          {continuousMode ? 'Continuous' : 'Single Scan'}
        </button>
        <button class="sc-btn" on:click={refresh}>
          <span class="material-symbols-rounded">refresh</span>
          Refresh
        </button>
        {#if torchVisible}
          <button class="sc-btn" class:sc-btn-torch={torchOn} on:click={toggleTorch}>
            <span class="material-symbols-rounded">{torchOn ? 'flash_on' : 'flash_off'}</span>
            {torchOn ? 'Flash On' : 'Flash Off'}
          </button>
        {/if}
      </div>

      <!-- Manual entry -->
      <div class="scanner-manual">
        <input
          class="input"
          type="text"
          placeholder="Or type barcode manually…"
          bind:value={manualCode}
          on:keydown={e => e.key === 'Enter' && doManual()}
        />
        <button class="btn btn-primary" on:click={doManual}>Look Up</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .scanner-backdrop {
    position: fixed;
    inset: 0;
    z-index: 200;
    background: rgba(0,0,0,0.72);
    display: flex;
    align-items: center;
    justify-content: center;
    backdrop-filter: blur(4px);
    padding: 16px;
  }

  .scanner-panel {
    width: 100%;
    max-width: 440px;
    max-height: calc(100dvh - 32px);
    background: var(--surface-1);
    border-radius: var(--radius-xl);
    overflow: hidden;
    display: flex;
    flex-direction: column;
    box-shadow: 0 24px 64px rgba(0,0,0,0.6);
  }

  .scanner-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 16px 10px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  .scanner-title {
    font-size: 17px;
    font-weight: 600;
    color: var(--text-1);
  }

  .scanner-controls {
    display: flex;
    gap: 10px;
    padding: 10px 12px;
    background: var(--surface-2);
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  .sc-field { display: flex; flex-direction: column; flex: 1; min-width: 0; gap: 3px; }
  .sc-label { font-size: 11px; color: var(--text-3); text-transform: uppercase; letter-spacing: .5px; }
  .sc-select {
    flex: 1;
    padding: 6px 8px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-1);
    color: var(--text-1);
    font-size: 13px;
  }

  .scanner-viewport {
    position: relative;
    width: 100%;
    height: 260px;
    background: #000;
    flex-shrink: 0;
    overflow: hidden;
  }
  .scanner-feed {
    position: absolute;
    inset: 0;
    overflow: hidden;
  }
  .scanner-aim {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    pointer-events: none;
    z-index: 5;
  }
  .aim-box {
    position: relative;
    width: 68%;
    max-width: 260px;
    aspect-ratio: 2.2/1;
    border: 2px dashed rgba(255,255,255,0.4);
    border-radius: 4px;
    overflow: hidden;
  }
  .aim-scanline {
    position: absolute;
    left: 0; right: 0; height: 3px;
    background: var(--accent);
    top: 45%;
    box-shadow: 0 0 8px var(--accent);
  }
  .aim-corner {
    position: absolute;
    width: 16px; height: 16px;
  }
  .aim-corner.tl { top: -3px; left: -3px; border-top: 3px solid var(--accent); border-left: 3px solid var(--accent); }
  .aim-corner.tr { top: -3px; right: -3px; border-top: 3px solid var(--accent); border-right: 3px solid var(--accent); }
  .aim-corner.bl { bottom: -3px; left: -3px; border-bottom: 3px solid var(--accent); border-left: 3px solid var(--accent); }
  .aim-corner.br { bottom: -3px; right: -3px; border-bottom: 3px solid var(--accent); border-right: 3px solid var(--accent); }

  .scanner-status-pill {
    position: absolute;
    bottom: 8px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 6;
    pointer-events: none;
    font-size: 11px;
    color: #fff;
    background: rgba(0,0,0,0.65);
    padding: 3px 10px;
    border-radius: 10px;
    white-space: nowrap;
  }

  .scanner-actions {
    display: flex;
    gap: 8px;
    padding: 10px 12px;
    background: var(--surface-2);
    border-top: 1px solid var(--border);
    flex-wrap: wrap;
    flex-shrink: 0;
  }
  .sc-btn {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    border: 1px solid var(--border);
    border-radius: 16px;
    padding: 5px 12px;
    font-size: 12px;
    cursor: pointer;
    background: var(--surface-1);
    color: var(--text-2);
    white-space: nowrap;
    transition: background var(--dur-fast), color var(--dur-fast);
  }
  .sc-btn .material-symbols-rounded { font-size: 14px; }
  .sc-btn.sc-btn-active { background: color-mix(in srgb, var(--accent) 20%, transparent); color: var(--accent); border-color: var(--accent); }
  .sc-btn.sc-btn-torch  { background: color-mix(in srgb, #fbbf24 20%, transparent); color: #fbbf24; border-color: #fbbf24; }

  .scanner-manual {
    display: flex;
    gap: 8px;
    padding: 12px 16px;
    background: var(--surface-2);
    border-top: 1px solid var(--border);
    flex-shrink: 0;
    align-items: center;
  }
  .scanner-manual .input { flex: 1; }
  .scanner-manual .btn { flex-shrink: 0; white-space: nowrap; }
</style>
