// Install console.* wrappers BEFORE any other import logs anything,
// so the in-app diagnostic-log buffer captures the full app lifecycle.
import { setAppVersion } from './lib/log-capture.js';
import { APP_VERSION } from './lib/version.js';
setAppVersion(APP_VERSION);

import './styles/tokens.css';
import './styles/base.css';
import './styles/typography.css';
import './styles/animations.css';
import './styles/buttons.css';
import './styles/forms.css';
import App from './App.svelte';
import { DB } from './lib/db.js';
import { initI18n } from './i18n/index.js';

// Pick browser-detected locale for first paint; the App-level subscription to
// the `language` store flips it to the user's saved preference once that loads.
initI18n();

// Sync system theme changes when appearance = 'system'
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', e => {
  const appearance = localStorage.getItem('wl_appearance') || 'system';
  if (appearance === 'system') {
    document.documentElement.setAttribute('data-theme', e.matches ? 'dark' : 'light');
    const meta = document.getElementById('theme-color-meta');
    if (meta) meta.content = e.matches ? '#0A0B0F' : '#F5F7FA';
  }
});

// Boot
DB.init()
  .then(async () => {
    // Load cached image map before app renders — ensures resolveAssetUrl() has the map
    // ready on first paint (local SQLite read, no server dependency, ~5ms)
    const { isNative } = await import('./lib/platform.js');
    if (isNative) {
      const { loadImageMap } = await import('./lib/platform.js');
      await loadImageMap();
    }
    new App({ target: document.getElementById('app') });
  })
  .catch(err => {
    console.error('DB init failed:', err);
    document.getElementById('app').innerHTML = `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;
                  height:100dvh;padding:32px;text-align:center;gap:16px;font-family:sans-serif;">
        <span style="font-size:48px">⚠️</span>
        <h2 style="color:#F0F2F8">Database Error</h2>
        <p style="color:rgba(240,242,248,0.6);max-width:300px">
          Could not open the local database. Try closing other tabs or clearing site data.
        </p>
        <button onclick="location.reload()"
          style="padding:12px 24px;border-radius:12px;background:#4FFFB0;
                 color:#0A0B0F;font-weight:600;border:none;cursor:pointer;font-size:15px;">
          Retry
        </button>
      </div>`;
  });
