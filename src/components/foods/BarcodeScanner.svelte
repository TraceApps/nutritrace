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

  // Lazy-load the barcode scanner libraries (~870 KB total) only when the
  // scanner actually opens. Cached promise so subsequent opens reuse loaded scripts.
  let _libsPromise = null;
  function _loadBarcodeLibs() {
    if (_libsPromise) return _libsPromise;
    const inject = (src) => new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.async = false;
      s.onload = resolve;
      s.onerror = () => reject(new Error('Failed to load ' + src));
      document.head.appendChild(s);
    });
    _libsPromise = Promise.all([
      inject('/vendor/zxing.min.js'),
      inject('/vendor/html5-qrcode.min.js'),
      inject('/vendor/quagga2.min.js'),
    ]).catch(e => {
      _libsPromise = null;          // allow retry
      throw e;
    });
    return _libsPromise;
  }

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
    await close();
    dispatch('scan', { code });
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
          if (!detected) status = 'Align Barcode';
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
          if (!detected) status = 'Align Barcode';
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
        if (!detected) status = 'Align Barcode';
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

  async function doManual() {
    if (detected) return;
    const code = manualCode.trim();
    if (!code) return;
    detected = true;
    await close();
    dispatch('scan', { code });
  }

  async function startScanner() {
    detected = false;
    scanning = true;
    status = 'Loading scanner…';
    try {
      await _loadBarcodeLibs();
    } catch (e) {
      status = 'Failed to load scanner libraries.';
      scanning = false;
      return;
    }

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

  // Native mode: use ML Kit bundled scanner. Runs camera BEHIND the
  // WebView (`startScan` API); we render our own overlay UI on top.
  // Critically, this path does NOT call the Google Code Scanner module
  // — no Google Play Services runtime dependency. Works on degoogled
  // ROMs (GrapheneOS, /e/, CalyxOS, etc.). Fixes #31.
  let _nativeListener = null;
  let _nativeBarcodeScannerRef = null;
  let nativeScannerActive = false;
  let nativeStatus = 'Starting camera…';
  let nativeTorchOn = false;

  async function startNativeScanner() {
    detected = false;  // reset detected guard so re-opening after a prior scan works
    scanning = true;
    nativeStatus = 'Requesting camera…';
    try {
      const { BarcodeScanner } = await import('@capacitor-mlkit/barcode-scanning');
      _nativeBarcodeScannerRef = BarcodeScanner;

      const perms = await BarcodeScanner.requestPermissions();
      if (perms.camera !== 'granted') {
        const { showError } = await import('../../stores/toast.js');
        showError('Camera permission denied');
        open = false; scanning = false;
        return;
      }

      // Make the WebView and everything else transparent so the camera
      // (behind the WebView) is visible. Class hooks into CSS at the
      // bottom of this file. App-wide global CSS opt-in is in main.js.
      document.body.classList.add('barcode-scanner-active');
      nativeScannerActive = true;
      nativeStatus = 'Align Barcode';

      _nativeListener = await BarcodeScanner.addListener('barcodeScanned', (event) => {
        const code = event?.barcode?.rawValue;
        if (!code) return;
        if (detected) return;
        detected = true;
        if ($barcodeBeep) playBeep();
        scanlineVisible = true;
        setTimeout(() => scanlineVisible = false, 500);
        // Set open=false FIRST. Don't call stopNativeScanner directly here.
        // If we did, scanning=false would fire BEFORE open=false, and the
        // reactive `$: if (open && !scanning) startNativeScanner()` would
        // re-fire during the await window inside stopNativeScanner —
        // because at that moment open is still true and scanning is now
        // false. That re-opens the scanner in a loop until CameraX hits
        // its surface-combination limit ("No supported surface combination
        // is found ... May be attempting to bind too many use cases").
        // The reactive `$: if (!open && scanning) stopNativeScanner()`
        // handles cleanup correctly once open=false propagates.
        open = false;
        dispatch('scan', { code });
      });

      await BarcodeScanner.startScan();

      // Auto-enable torch if the setting requests it
      if ($barcodeFlashlight) {
        try { await BarcodeScanner.enableTorch(); nativeTorchOn = true; } catch {}
      }
    } catch (e) {
      console.error('[BarcodeScanner] Native scan failed:', e);
      const { showError } = await import('../../stores/toast.js');
      showError('Barcode scan failed: ' + (e?.message || 'Unknown error'));
      await stopNativeScanner();
      open = false;
    }
  }

  async function stopNativeScanner() {
    scanning = false;
    nativeScannerActive = false;
    document.body.classList.remove('barcode-scanner-active');
    if (_nativeListener) {
      try { await _nativeListener.remove(); } catch {}
      _nativeListener = null;
    }
    if (_nativeBarcodeScannerRef) {
      try { await _nativeBarcodeScannerRef.stopScan(); } catch {}
    }
  }

  async function toggleNativeTorch() {
    if (!_nativeBarcodeScannerRef) return;
    try {
      if (nativeTorchOn) {
        await _nativeBarcodeScannerRef.disableTorch();
        nativeTorchOn = false;
      } else {
        await _nativeBarcodeScannerRef.enableTorch();
        nativeTorchOn = true;
      }
    } catch {}
  }

  function closeNative() {
    // Same ordering rule as the scan listener: open=false first so the
    // reactive cleans up. Avoids the re-open loop.
    open = false;
    dispatch('close');
  }

  function doManualNative() {
    if (detected) return;
    const code = manualCode.trim();
    if (!code) return;
    detected = true;
    open = false;
    dispatch('scan', { code });
  }

  $: if (open && !scanning) {
    if (isNative) startNativeScanner();
    else startScanner();
  }
  $: if (!open && scanning) {
    if (isNative) stopNativeScanner();
    else close();
  }

  onDestroy(() => {
    detected = true;
    if (isNative) stopNativeScanner();
    else {
      stopEngine();
      if (h5Observer) h5Observer.disconnect();
      if (styleEl) styleEl.remove();
    }
  });
</script>

{#if open && isNative && nativeScannerActive}
  <!-- Native scanner overlay. The actual camera renders BEHIND the
       WebView (ML Kit handles it); we just draw the UI on top, with
       body+root made transparent via .barcode-scanner-active. Portal
       to <body> so the visibility-hide CSS rule (which hides every
       body child except this overlay) doesn't sweep us up with #app. -->
  <div class="native-scanner-overlay" use:modalPortal>
    <div class="ns-top">
      <button class="btn-icon ns-close" on:click={closeNative} aria-label="Close scanner" title="Close scanner">
        <span class="material-symbols-rounded">close</span>
      </button>
      <div class="ns-status">{nativeStatus}</div>
      <button class="btn-icon ns-torch" class:active={nativeTorchOn} on:click={toggleNativeTorch} aria-label="Toggle flashlight" title="Toggle flashlight">
        <span class="material-symbols-rounded">{nativeTorchOn ? 'flash_on' : 'flash_off'}</span>
      </button>
    </div>

    <div class="ns-aim">
      <div class="ns-aim-box">
        <div class="aim-corner tl"></div>
        <div class="aim-corner tr"></div>
        <div class="aim-corner bl"></div>
        <div class="aim-corner br"></div>
        {#if scanlineVisible}
          <div class="aim-scanline"></div>
        {/if}
      </div>
    </div>

    <div class="ns-bottom">
      <div class="ns-manual">
        <input
          class="input"
          type="text"
          placeholder="Or type barcode manually…"
          bind:value={manualCode}
          on:keydown={e => e.key === 'Enter' && doManualNative()}
        />
        <button class="btn btn-primary" on:click={doManualNative}>Look Up</button>
      </div>
    </div>
  </div>
{/if}

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

  /* Native ML Kit scanner overlay (bundled, no Play Services) — camera
     renders BEHIND the WebView. We just draw chrome on top. */
  .native-scanner-overlay {
    position: fixed;
    inset: 0;
    z-index: 250;
    display: flex;
    flex-direction: column;
    pointer-events: none;
  }
  .native-scanner-overlay > * { pointer-events: auto; }

  .ns-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: calc(var(--safe-top) + 12px) 16px 12px;
    gap: 8px;
    background: linear-gradient(to bottom, rgba(0,0,0,0.55), transparent);
  }
  .ns-close, .ns-torch {
    background: rgba(0,0,0,0.5);
    color: #fff;
    border-radius: 50%;
    width: 40px;
    height: 40px;
  }
  .ns-torch.active { background: rgba(251,191,36,0.85); color: #000; }
  .ns-status {
    flex: 1;
    text-align: center;
    color: #fff;
    background: rgba(0,0,0,0.55);
    border-radius: 14px;
    padding: 6px 14px;
    font-size: 13px;
    font-weight: 500;
    margin: 0 8px;
    max-width: 220px;
    justify-self: center;
  }

  .ns-aim {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    pointer-events: none;
  }
  .ns-aim-box {
    position: relative;
    width: 78%;
    max-width: 320px;
    aspect-ratio: 2.2/1;
    border: 2px dashed rgba(255,255,255,0.5);
    border-radius: 6px;
  }
  .ns-aim-box .aim-corner.tl { top: -3px; left: -3px; border-top: 3px solid var(--accent); border-left: 3px solid var(--accent); }
  .ns-aim-box .aim-corner.tr { top: -3px; right: -3px; border-top: 3px solid var(--accent); border-right: 3px solid var(--accent); }
  .ns-aim-box .aim-corner.bl { bottom: -3px; left: -3px; border-bottom: 3px solid var(--accent); border-left: 3px solid var(--accent); }
  .ns-aim-box .aim-corner.br { bottom: -3px; right: -3px; border-bottom: 3px solid var(--accent); border-right: 3px solid var(--accent); }

  .ns-bottom {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 16px 16px calc(var(--safe-bottom) + 20px);
    background: linear-gradient(to top, rgba(0,0,0,0.65), transparent);
  }
  .ns-bottom .sc-btn {
    align-self: center;
    background: rgba(0,0,0,0.6);
    color: #fff;
    border-color: rgba(255,255,255,0.2);
  }
  .ns-bottom .sc-btn.sc-btn-active {
    background: color-mix(in srgb, var(--accent) 80%, transparent);
    color: #fff;
    border-color: var(--accent);
  }
  .ns-manual {
    display: flex;
    gap: 8px;
    background: rgba(0,0,0,0.55);
    border-radius: var(--radius-md);
    padding: 8px;
    align-items: center;
  }
  .ns-manual .input { flex: 1; background: rgba(255,255,255,0.92); color: #000; }
  .ns-manual .btn { flex-shrink: 0; white-space: nowrap; }
</style>
