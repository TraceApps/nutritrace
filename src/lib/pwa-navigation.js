// How the service worker answers a page load (vite.config.js runtimeCaching).
//
// The app page comes from the server whenever it answers, so a refresh after
// an update loads the new version, and a sign-in proxy whose session ran out
// can show its sign-in page. The copy cached with the app (index.html) is the
// answer only when the server can't be reached, takes more than 3 seconds, or
// is down behind a proxy (5xx) (TraceApps/notetrace#37).
//
// Workbox copies these functions into the service worker as text, so each one
// has to stand alone: no imports, nothing from outside its own body.

// Every page load except the ones the server always answers itself: the API
// and uploaded files.
// Under BASE_URL the paths are read from the worker's own folder, so
// /nutritrace/api/ goes to the server like /api/.
export function isAppPageLoad({ request, url }) {
  const toServer = [/^\/api\//, /^\/uploads\//];
  const base = typeof self !== 'undefined' && self.registration ? new URL(self.registration.scope).pathname : '/';
  const path = url.pathname.startsWith(base) ? url.pathname.slice(base.length - 1) : url.pathname;
  return request.mode === 'navigate' && !toServer.some(r => r.test(path + url.search));
}

// A proxy in front of a stopped server answers 502 or 504: open the cached app,
// as when offline, rather than the proxy's error page.
export async function treatServerErrorAsOffline({ response }) {
  if (response.status >= 500) throw new Error(`Server answered ${response.status}`);
  return response;
}

// Nothing is kept from page loads: offline, the cached app page matches the
// cached app, whatever the server last sent.
export async function keepNoPageCopy() {
  return null;
}

// After 3 seconds Workbox looks for a page copy, finds none (keepNoPageCopy)
// and would keep waiting on the server: a captive portal or a dead signal left
// a blank window. Answer with the cached app page instead.
export async function useCachedAppOnTimeout({ cachedResponse }) {
  if (cachedResponse) return cachedResponse;
  const appPage = new URL('index.html', self.registration.scope).href;
  for (const name of await caches.keys()) {
    if (!name.startsWith('workbox-precache')) continue;
    const found = await (await caches.open(name)).match(appPage, { ignoreSearch: true });
    if (found) return found;
  }
  return null;
}
