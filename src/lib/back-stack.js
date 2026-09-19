/**
 * back-stack.js: what Android's back button (or gesture) closes first.
 *
 * Sheets, dialogs and full-screen overlays register a handler while they're
 * open; back runs the most recent one instead of leaving the page underneath
 * (#226: back did nothing visible with Body Stats open, because it only knew
 * how to go back a page). With nothing registered, back goes back a page and
 * then offers to exit, as before.
 *
 * In markup, attach it to the element that exists only while the layer is
 * open, and pass the same close action as the layer's own close button:
 *
 *   <div class="sheet-backdrop" use:closeOnBack={close}>
 *
 * A layer that must be answered (the sync merge dialog) passes a no-op, so
 * back neither dismisses it nor navigates away underneath it.
 */
const stack = [];

/** Register `handler` for the next back press. Returns a release function. */
export function onBack(handler) {
  const entry = { handler };
  stack.push(entry);
  return () => {
    const i = stack.indexOf(entry);
    if (i >= 0) stack.splice(i, 1);
  };
}

/**
 * Run the topmost handler. True when something took the back press.
 *
 * The entry stays registered until its layer releases it (closeOnBack does
 * that when the element is removed), so a layer whose back action is a
 * deliberate no-op keeps catching back instead of letting the next press
 * navigate away underneath it.
 */
export function handleBack() {
  const entry = stack[stack.length - 1];
  if (!entry) return false;
  try { entry.handler(); } catch { /* the layer is gone either way */ }
  return true;
}

/** How many layers are waiting on back (for tests and diagnostics). */
export function backStackDepth() {
  return stack.length;
}

/**
 * Svelte action: register while the element is mounted, release when it's
 * removed (closed any other way, or the page changes).
 */
export function closeOnBack(node, handler) {
  let current = handler;
  const release = onBack(() => { if (typeof current === 'function') current(); });
  return {
    update(next) { current = next; },
    destroy: release,
  };
}
