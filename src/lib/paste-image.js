/**
 * A picture pasted into a chat box (from nutritrace#304): the image to attach,
 * or null to let the browser paste as usual.
 *
 * Spreadsheets and word processors copy text together with a picture of it,
 * so a clipboard that has plain text pastes as text. Only a clipboard that is
 * just an image (a screenshot, "Copy Image" in a browser) is attached.
 *
 * The same file in every Trace app; scripts/paste-image.test.js pins its hash.
 */
export function pastedImage(clipboardData) {
  const file = Array.from(clipboardData?.files || [])
    .find(f => typeof f?.type === 'string' && f.type.startsWith('image/'));
  if (!file) return null;
  if (clipboardData.getData?.('text/plain')) return null;
  return file;
}
