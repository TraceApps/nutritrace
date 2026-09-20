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
      // 'prompt' downloads new bundles but WAITS for the app to
      // call updateSW(true) before activating. That's what lets us
      // show a "Reload" banner instead of swapping the page out from
      // under the user with no warning. See src/lib/pwa-update.js
      // for the Svelte-side bridge.
      registerType: 'prompt',
      workbox: {
        // Precache the whole app shell, not just the fallback page. Without
        // this a reload with no connection loaded index.html and then failed
        // to fetch its own JavaScript, so the installed app looked broken
        // exactly when offline mode was supposed to carry it (#211).
        globPatterns: ['**/*.{js,mjs,css,html,woff2,woff,ttf,png,svg,ico,webmanifest}'],
        // The barcode scanner libraries are left out: scanning is only useful
        // with a connection anyway. So are the install icons, which the browser
        // fetches from the manifest. The icon font stays, or every button in the
        // app would read as a word offline.
        globIgnores: ['vendor/**', 'icons/**', '**/*.map'],
        // Chart, zip and emoji chunks are over the 2 MiB default.
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        // Navigation still prefers the network (see the NetworkFirst route
        // below, 3s timeout) so a deploy is picked up at once; the precached
        // index.html is what answers when the server can't be reached.
        navigateFallback: 'index.html',
        navigateFallbackDenylist: [/^\/api\//, /^\/uploads\//],
        cleanupOutdatedCaches: true,
        // Keep skipWaiting + clientsClaim: once WE call updateSW(true)
        // from the banner's Reload button, workbox activates immediately
        // and takes control of open tabs on next navigation.
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
