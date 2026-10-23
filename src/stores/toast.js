import { writable } from 'svelte/store';

export const toasts = writable([]);

let _id = 0;

export function showToast(message, duration = 3000, type = 'default') {
  const id = ++_id;
  toasts.update(list => [...list, { id, message, type }]);
  setTimeout(() => {
    toasts.update(list => list.filter(t => t.id !== id));
  }, duration);
}

export function showSuccess(msg) { showToast(msg, 2500, 'success'); }
// Long enough to read: a long error (what to check when the AI provider gave
// no answer, say) stays about as long as it takes to read, up to 15 s.
export function showError(msg)   { showToast(msg, Math.min(15000, Math.max(4000, String(msg ?? '').length * 60)), 'error'); }
export function showInfo(msg)    { showToast(msg, 3000, 'info'); }
