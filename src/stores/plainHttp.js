import { writable, get } from 'svelte/store';

/** The plain-HTTP sheet (#194), rendered by <PlainHttpSheetMount /> in App.svelte.
 *
 *    if (!await askPlainHttp(url)) return;                 // warning: true for Connect Anyway
 *    await askPlainHttp(url, { kind: 'refuse' });          // refusal: always false
 *
 *  `stored`: the server this phone was already connected to (an update from
 *  a build that allowed plain HTTP), which changes what the sheet explains.
 */
export const plainHttpRequest = writable(null);

// One sheet at a time: a second request while one is open is answered
// "no" at once instead of replacing it (the first would never resolve).
export function askPlainHttp(url, { kind = 'ask', stored = false } = {}) {
  if (get(plainHttpRequest)) return Promise.resolve(false);
  return new Promise(resolve => {
    plainHttpRequest.set({ url, kind, stored, resolve });
  });
}
