/**
 * oidc-return.js: where a web SSO sign-in comes back to (from
 * TraceApps/nutritrace#278). The page's address after the #, as the sign-in
 * page sent it ("#/?new=water" from an app icon shortcut waiting under it),
 * plus the outcome for the app to read: ?oidc=ok, ?oidc=linked or
 * ?oidc_error=..., joined with & when the address already has a query.
 * A leading # is dropped: it used to come back as "#/#/?oidc=ok", which no
 * route matched and which lost a waiting shortcut.
 */
export function oidcReturnHash(returnPath, error, ok) {
  let hash = String(returnPath || '/').replace(/^#+/, '') || '/';
  if (!hash.startsWith('/')) hash = '/' + hash;
  const sep = hash.includes('?') ? '&' : '?';
  let qs = '';
  if (error) qs = `${sep}oidc_error=${error}`;
  else if (ok) qs = `${sep}oidc=${ok}`;
  return hash + qs;
}
