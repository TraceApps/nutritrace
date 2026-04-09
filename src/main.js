import './styles/tokens.css';
import './styles/base.css';
import './styles/typography.css';
import './styles/animations.css';
import './styles/buttons.css';
import './styles/forms.css';
import App from './App.svelte';
import { DB } from './lib/db.js';

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
  .then(() => {
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
