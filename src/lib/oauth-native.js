/**
 * oauth-native.js — Opens OAuth URLs in the system browser on native,
 * and handles the callback deep link back into the app.
 *
 * Flow:
 * 1. App calls openOAuth(url) → opens Chrome/system browser
 * 2. User authorizes on provider site
 * 3. Provider redirects to server /callback?code=...
 * 4. Server exchanges code for token, redirects to nutritrace://callback?provider=connected
 * 5. Android receives deep link → App.svelte handles it via appUrlOpen listener
 */

import { Browser } from '@capacitor/browser';

/**
 * Open an OAuth authorization URL in the system browser.
 * On native, this opens Chrome (or default browser) instead of the WebView.
 */
export async function openOAuth(url) {
  await Browser.open({ url, presentationStyle: 'popover' });
}

/**
 * Close the system browser (called after callback is received).
 */
export async function closeBrowser() {
  try { await Browser.close(); } catch {}
}
