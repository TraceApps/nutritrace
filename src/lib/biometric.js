/**
 * biometric.js — fingerprint / face unlock for Android server-mode login.
 *
 * Threat model: this is a UX layer, not an added security boundary. The
 * stored JWT lives in Capacitor Preferences which is already encrypted at
 * rest by Android File-Based Encryption (locked phone == encrypted disk
 * since Android 7). Biometric verification just gates unlocking that saved
 * token instead of the user retyping their password each time.
 *
 * Lifecycle:
 *   - Settings toggle 'biometricLoginEnabled' lights up after first
 *     successful password login (so a user always has to enter a real
 *     password at least once before biometric can unlock the app).
 *   - On password-login success: when the toggle is on, saveTokenForBiometric()
 *     stashes the JWT in a Preferences key.
 *   - On app open with a saved token: Login.svelte offers a biometric
 *     button. Tapping runs authenticate() → on success restoreToken().
 *   - On logout: clearSavedToken() wipes the stash.
 *
 * Local-only mode (no server) and PWA both no-op these helpers since
 * neither has a JWT-style auth flow that benefits from biometric unlock.
 */

import { Capacitor } from '@capacitor/core';
import { BiometricAuth } from '@aparajita/capacitor-biometric-auth';
import { isNative, getServerUrl } from './platform.js';

// NB: The Capacitor plugin import has to be STATIC. Dynamic import
// (`await import('...')`) silently fails to resolve the native bridge on
// Android in production builds — same gotcha the LocalNotifications plugin
// hit. See feedback_workmanager_reminders.md for the same pattern.
//
// Capacitor's WebView shares localStorage with the host app's process; on
// Android that storage is encrypted at rest by File-Based Encryption since
// Android 7, so a locked phone == disk-encrypted. Same threat model the rest
// of NutriTrace uses for cached data.
const TOKEN_KEY = 'nt:biometric:token';

function _getPlugin() {
  if (!Capacitor.isNativePlatform()) return null;
  return BiometricAuth || null;
}

/** Whether the device hardware supports biometric auth at all. */
export async function isAvailable() {
  const info = await getStatus();
  return !!info?.isAvailable;
}

/** Detailed status — distinguishes "no hardware" from "not enrolled". Used
 *  by the Settings toggle to surface the actual reason the user can't enable
 *  biometric (e.g. "Set up fingerprint in Android Settings first"). */
export async function getStatus() {
  if (!isNative) return { isAvailable: false, reason: 'PWA — biometric is Android-only', code: 'web' };
  const p = _getPlugin();
  if (!p) return { isAvailable: false, reason: 'Biometric plugin unavailable', code: 'noPlugin' };
  try {
    const info = await p.checkBiometry();
    return {
      isAvailable: !!info?.isAvailable,
      reason: info?.reason || '',
      code: info?.code || '',
      biometryType: info?.biometryType || '',
    };
  } catch (e) {
    return { isAvailable: false, reason: e?.message || 'Probe failed', code: 'error' };
  }
}

/** Trigger the OS biometric prompt. Returns true on success, false on cancel/fail. */
export async function authenticate(reason = 'Sign in to NutriTrace') {
  const p = _getPlugin();
  if (!p) return false;
  try {
    await p.authenticate({
      reason,
      cancelTitle: 'Use Password',
      androidTitle: 'NutriTrace',
      androidSubtitle: reason,
      androidConfirmationRequired: false,
    });
    return true;
  } catch {
    return false;
  }
}

/** Save the JWT for the current session so the next launch can unlock with biometric. */
export async function saveTokenForBiometric(token) {
  if (!isNative || !getServerUrl() || !token) return;
  localStorage.setItem(TOKEN_KEY, token);
}

/** Read the saved token (no biometric prompt — call authenticate() first). */
export async function readSavedToken() {
  if (!isNative) return null;
  return localStorage.getItem(TOKEN_KEY) || null;
}

/** Wipe any saved token. Called on logout / disable toggle / auth failure. */
export async function clearSavedToken() {
  localStorage.removeItem(TOKEN_KEY);
}
