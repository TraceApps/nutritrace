import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  server: {
    proxy: {
      '/api':     'http://localhost:3001',
      '/uploads': 'http://localhost:3001',
    }
  },
  // Capacitor native build: output to dist/ (default) — capacitor.config.ts points webDir here
  // The build is identical for web and native; platform branching happens at runtime via platform.js
  plugins: [
    svelte(),
    VitePWA({
      registerType: 'autoUpdate',
      workbox: {
        // Precache only the offline fallback page — everything else is handled
        // by HTTP Cache-Control headers (index.html: no-cache, /assets/*: immutable).
        // Precaching JS/CSS caused stale UI after deploys because the old SW
        // kept serving old bundles until the new SW fully activated.
        globPatterns: ['offline.html'],
        navigateFallback: '/offline.html',
        // Only use the offline fallback for navigation requests that aren't API calls
        navigateFallbackDenylist: [/^\/api\//],
        cleanupOutdatedCaches: true,
        runtimeCaching: [
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
        start_url: '/',
        scope: '/',
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
