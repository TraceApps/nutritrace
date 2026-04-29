import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  // Use relative asset URLs so the bundle works regardless of the path the
  // server is mounted at. Combined with server-side BASE_URL support, this
  // lets the same image run at `/`, `/nutritrace/`, or any other prefix
  // without a rebuild.
  base: './',
  server: {
    proxy: {
      '/api':     'http://localhost:3001',
      '/uploads': 'http://localhost:3001',
    }
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          'charts':  ['chart.js'],
          'jszip':   ['jszip'],
          'emoji':   ['emoji-picker-element'],
        }
      }
    }
  },
  // Capacitor native build: output to dist/ (default) — capacitor.config.ts points webDir here
  // The build is identical for web and native; platform branching happens at runtime via platform.js
  plugins: [
    svelte(),
    VitePWA({
      registerType: 'autoUpdate',
      workbox: {
        // Precache the offline fallback page
        globPatterns: ['offline.html'],
        // navigateFallback explicitly disabled — navigation requests are
        // handled by the NetworkFirst runtimeCaching route below.
        navigateFallback: null,
        navigateFallbackDenylist: [/.*/],
        cleanupOutdatedCaches: true,
        // skipWaiting + clientsClaim ensure new SW activates immediately
        skipWaiting: true,
        clientsClaim: true,
        runtimeCaching: [
          {
            // Navigation: network first (3s timeout), cache index.html for
            // offline use. Deploys are picked up instantly because the
            // network response always wins when the server is reachable.
            urlPattern: ({ request }) => request.mode === 'navigate',
            handler: 'NetworkFirst',
            options: {
              cacheName: 'pages-cache',
              networkTimeoutSeconds: 3,
            }
          },
          {
            urlPattern: /^https:\/\/world\.openfoodfacts\.org\/.*/i,
            handler: 'NetworkFirst',
            options: { cacheName: 'off-api-cache', expiration: { maxEntries: 50, maxAgeSeconds: 86400 } }
          }
        ]
      },
      manifest: {
        name: 'NutriTrace',
        short_name: 'NutriTrace',
        description: 'Trace Every Bite — Personal Nutrition Tracker',
        theme_color: '#0A0B0F',
        background_color: '#0A0B0F',
        display: 'standalone',
        orientation: 'portrait-primary',
        // Relative URLs — browsers resolve them against the manifest's own
        // location. This makes PWA install work whether the app is mounted
        // at root (`/`) or at a subpath (`/nutritrace/`) without rebuilding.
        start_url: './',
        scope: './',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
        ]
      }
    })
  ]
});
