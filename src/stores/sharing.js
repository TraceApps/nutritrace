/**
 * Whether an admin has sharing on, as last seen by the Foods page or the
 * meal editor (no request of its own): the editors' Share button shows when
 * it is, also with no connection (the sheet then says sharing needs one).
 * Kept per account on the device.
 */
import { writable } from 'svelte/store';

const _key = () => { try { return `nt:sharing-on:${localStorage.getItem('wl:userId') || ''}`; } catch { return null; } };
function _read() { try { const k = _key(); return k ? localStorage.getItem(k) === '1' : false; } catch { return false; } }

export const sharingOn = writable(typeof localStorage !== 'undefined' ? _read() : false);

/** From /api/app-config/sharing's answer. */
export function noteSharingStatus(s) {
  const on = s?.sharing_enabled === true;
  sharingOn.set(on);
  try { const k = _key(); if (k) localStorage.setItem(k, on ? '1' : '0'); } catch { /* private mode */ }
}

/** The account changed: what the last one saw doesn't count. */
export function resetSharingOn() { sharingOn.set(_read()); }
