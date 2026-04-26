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
export function showError(msg)   { showToast(msg, 4000, 'error'); }
export function showInfo(msg)    { showToast(msg, 3000, 'info'); }
