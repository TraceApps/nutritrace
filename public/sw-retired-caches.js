// Caches an older service worker kept and this one doesn't. pages-cache held
// page loads of the API and uploads (exports, backups opened in a tab), which
// the next account on this browser could read (TraceApps/notetrace#37).
self.addEventListener('activate', event => {
  event.waitUntil(Promise.all(['pages-cache'].map(name => caches.delete(name))));
});
