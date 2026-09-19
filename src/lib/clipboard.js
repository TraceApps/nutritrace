/**
 * clipboard.js: copy text wherever NutriTrace runs.
 *
 * navigator.clipboard only exists on secure pages (HTTPS or localhost).
 * Self-hosters often open their server over plain http on a LAN or tailnet,
 * where browsers leave it undefined, so every Copy button failed there
 * (#212: an iPhone could not copy its diagnostic logs). The fallback selects
 * the text in an off-screen element and runs the browser's copy command,
 * which Safari and Chrome still allow during a tap.
 *
 * Call it straight from the click handler, without awaiting anything first:
 * the fallback only works while the browser still counts the tap.
 */
export async function copyText(text) {
  const value = String(text ?? '');
  const secure = typeof window !== 'undefined' && window.isSecureContext;
  if (secure && typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // Denied or unsupported despite being present; try the copy command.
    }
  }
  if (!copyWithSelection(value)) throw new Error('Copying is not available in this browser');
}

/** The copy-command path on its own. Returns whether the browser reported success. */
export function copyWithSelection(value) {
  if (typeof document === 'undefined' || !document.body) return false;
  // A span with a range selection rather than a text field: selecting inside
  // a field needs focus, which opens the keyboard on phones.
  const holder = document.createElement('span');
  holder.textContent = value;
  holder.setAttribute('aria-hidden', 'true');
  holder.style.cssText = 'position:fixed;top:0;left:-9999px;white-space:pre;' +
    'user-select:text;-webkit-user-select:text;opacity:0;pointer-events:none;';
  document.body.appendChild(holder);

  const selection = document.getSelection();
  const saved = [];
  if (selection) for (let i = 0; i < selection.rangeCount; i++) saved.push(selection.getRangeAt(i));
  try {
    const range = document.createRange();
    range.selectNodeContents(holder);
    selection.removeAllRanges();
    selection.addRange(range);
    return document.execCommand('copy') === true;
  } catch {
    return false;
  } finally {
    if (selection) {
      selection.removeAllRanges();
      for (const r of saved) selection.addRange(r);
    }
    holder.remove();
  }
}
