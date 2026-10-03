/**
 * Native SSO hand-off.
 *
 * The Android app finishes SSO through a nutritrace://oidc-callback deep link,
 * which any installed app can register for. So the link no longer carries the
 * session token: before opening the sign-in page the app makes a random
 * secret, sends only its SHA-256 (app_challenge), and the link comes back
 * with a single-use code. The app then swaps code + secret for the token at
 * POST /api/auth/oidc/handoff; another app that caught the link has the code
 * but not the secret.
 */
import { apiUrl } from './platform.js';

const KEY = 'nt:oidc_app_verifier';

function _b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Query-string fragment to append to the native login URL. */
export async function appChallengeParam() {
  // Without WebCrypto (not a secure context) fall back to the old link that
  // carries the token, rather than not signing in at all.
  if (!globalThis.crypto?.subtle) return '';
  const raw = new Uint8Array(32);
  crypto.getRandomValues(raw);
  const verifier = _b64url(raw);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  try { localStorage.setItem(KEY, verifier); } catch {}
  return `&app_challenge=${_b64url(digest)}`;
}

/** Swap the deep link's code for { token, id_token_hint, provider_id }. */
export async function redeemHandoff(code) {
  let verifier = null;
  try { verifier = localStorage.getItem(KEY); localStorage.removeItem(KEY); } catch {}
  const res = await fetch(apiUrl('/api/auth/oidc/handoff'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, verifier }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.token) throw new Error(data.error || 'Sign-in failed');
  return data;
}
