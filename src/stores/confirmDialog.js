import { writable } from 'svelte/store';

/** Global confirm-dialog store.
 *
 *  Usage from any component:
 *    import { confirmDialog } from '../../stores/confirmDialog.js';
 *    if (!await confirmDialog({ title: 'Delete?', message: '...', dangerous: true })) return;
 *
 *  A single <ConfirmDialogMount /> instance (mounted in App.svelte) renders
 *  the Dialog and resolves the awaiting promise on user action.
 */

export const confirmRequest = writable(null);

export function confirmDialog({
  title = 'Are you sure?',
  message = '',
  confirmText = 'OK',
  cancelText = 'Cancel',
  dangerous = false,
} = {}) {
  return new Promise(resolve => {
    confirmRequest.set({ title, message, confirmText, cancelText, dangerous, resolve });
  });
}
