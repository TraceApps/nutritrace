/**
 * Comma-tolerant decimal input helpers (#160).
 *
 * European (and much of Latin America / Africa / etc.) locales use
 * comma as the decimal separator. `<input type="number">` binds a
 * comma to a rejected keystroke on browsers whose locale expects
 * period, so a user in a comma-locale can be actively fighting the
 * form to enter "2,5" as "two and a half".
 *
 * This module provides two pieces you compose per input site:
 *
 *   1. `parseDecimal(str)` — accepts either "2,5" or "2.5" and returns
 *      2.5. Use it wherever the codebase currently calls parseFloat()
 *      on a form value so the SAVE path never sees a stray comma.
 *
 *   2. `decimalInput` — a Svelte action for `<input>` elements that
 *      intercepts comma characters (typing or paste) and rewrites them
 *      to period BEFORE the bound value updates. Use it in tandem with
 *      `type="text" inputmode="decimal"`: the input still gets a
 *      numeric keyboard on mobile, but text-mode means the browser
 *      won't reject the comma outright before we can catch it.
 *
 * We deliberately don't switch to a locale-aware display format (yet).
 * The reporter's pain is INPUT — they want to be able to type comma.
 * Rendering periods back after save is not surprising in the same way,
 * and a display-format switch would touch many more sites. If someone
 * asks for locale-formatted display later, that's a separate feature.
 */

/**
 * Parse a decimal string that may use either "." or "," as the
 * separator. Returns NaN on unparseable input. Handles leading/trailing
 * whitespace. Does NOT accept thousands separators (ambiguous per
 * locale — "1,234" could be 1234 or 1.234; we treat comma strictly as
 * decimal).
 */
export function parseDecimal(str) {
  if (typeof str === 'number') return str;
  if (str == null) return NaN;
  const trimmed = String(str).trim();
  if (!trimmed) return NaN;
  return parseFloat(trimmed.replace(',', '.'));
}

/**
 * Svelte action: rewrites comma characters to periods during input so
 * a comma-locale user can type "2,5" and the bound value receives
 * "2.5" instead. Also normalizes on paste. Intended for text-mode
 * inputs that hold decimal numbers.
 *
 * Usage:
 *   <input type="text" inputmode="decimal" use:decimalInput
 *          bind:value={foo} />
 */
export function decimalInput(node) {
  function _rewriteCommaSelection(input, insertText) {
    const start = input.selectionStart ?? input.value.length;
    const end   = input.selectionEnd   ?? input.value.length;
    const next  = input.value.slice(0, start) + insertText + input.value.slice(end);
    input.value = next;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const pos = start + insertText.length;
    try { input.setSelectionRange(pos, pos); } catch { /* not selectable */ }
  }

  function onBeforeInput(e) {
    // Only intercept insertions that carry data. Deletions, IME
    // composition state changes, etc. pass through untouched.
    if (e.inputType !== 'insertText' && e.inputType !== 'insertFromPaste') return;
    const data = e.data;
    if (typeof data !== 'string' || !data.includes(',')) return;
    e.preventDefault();
    _rewriteCommaSelection(node, data.replace(/,/g, '.'));
  }

  node.addEventListener('beforeinput', onBeforeInput);
  return {
    destroy() {
      node.removeEventListener('beforeinput', onBeforeInput);
    },
  };
}
