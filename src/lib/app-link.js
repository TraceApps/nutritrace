/**
 * app-link.js: reads a link that opens the app, such as the SSO return
 * <app>://oidc-callback?code=… or a home screen shortcut <app>://new/text.
 *
 * Not with new URL(): for a scheme the URL standard doesn't know, older
 * Android WebViews (seen on WebView 124; 145 is fine) leave the host empty
 * and put "//oidc-callback" in the path, so a check on url.hostname never
 * matched there and signing in with SSO never finished. The parts are read
 * here by hand, the same on every WebView. The same file serves each
 * TraceApps app.
 *
 * Returns { scheme, host, path, params } (host lowercase, params a
 * URLSearchParams), or null when the text isn't scheme://host… at all.
 */
export function parseAppLink(raw) {
  const m = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?(?:#.*)?$/i.exec(String(raw ?? '').trim());
  if (!m) return null;
  return {
    scheme: m[1].toLowerCase(),
    host: m[2].toLowerCase(),
    path: m[3],
    params: new URLSearchParams(m[4] || ''),
  };
}
