/**
 * drag-scroll.js — Svelte action that makes a horizontally-overflowing
 * container mouse-friendly on desktop:
 *
 *  - Click + drag scrolls horizontally (touch-style swipe with the mouse)
 *  - Mouse wheel translates vertical wheel ticks into horizontal scroll
 *
 * Touch devices keep their native swipe behaviour — we only attach
 * mouse / wheel listeners. Reported in #10: cearum on desktop with
 * mouse couldn't scroll the Statistics page metric / range chip rows
 * because they have hidden scrollbars and no native horizontal scroll
 * affordance for mouse users.
 *
 *   <div class="metric-scroll" use:dragScroll>...</div>
 *
 * The action attaches once per element and cleans up on destroy.
 */
export function dragScroll(node) {
  let isDown = false;
  let startX = 0;
  let startScroll = 0;
  let dragged = false;

  function onMouseDown(e) {
    // Only handle primary-button drags on the container itself; let
    // clicks on inner buttons (chips) work normally — we set isDown
    // but only translate to scroll if the user actually moves.
    if (e.button !== 0) return;
    isDown = true;
    dragged = false;
    startX = e.pageX;
    startScroll = node.scrollLeft;
  }
  function onMouseMove(e) {
    if (!isDown) return;
    const dx = e.pageX - startX;
    if (Math.abs(dx) > 3) {
      // The user moved enough to count as a drag — start scrolling
      // and suppress the click that would otherwise fire on release.
      dragged = true;
      node.scrollLeft = startScroll - dx;
      e.preventDefault();
    }
  }
  function onMouseUp() {
    isDown = false;
    if (dragged) {
      // Swallow the next click so a chip doesn't activate after a
      // drag-to-scroll gesture. One-shot capture-phase listener.
      const swallow = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
      node.addEventListener('click', swallow, { capture: true, once: true });
    }
  }
  function onMouseLeave() { isDown = false; }

  function onWheel(e) {
    // Translate vertical wheel ticks into horizontal scroll. Honor a
    // shift-modified wheel as the same horizontal intent. If the user
    // is already scrolling horizontally with a precision trackpad
    // (deltaX != 0), the browser handles it natively — we only step
    // in when deltaY dominates.
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    node.scrollLeft += e.deltaY;
    e.preventDefault();
  }

  node.addEventListener('mousedown',  onMouseDown);
  node.addEventListener('mousemove',  onMouseMove);
  node.addEventListener('mouseup',    onMouseUp);
  node.addEventListener('mouseleave', onMouseLeave);
  node.addEventListener('wheel',      onWheel, { passive: false });

  return {
    destroy() {
      node.removeEventListener('mousedown',  onMouseDown);
      node.removeEventListener('mousemove',  onMouseMove);
      node.removeEventListener('mouseup',    onMouseUp);
      node.removeEventListener('mouseleave', onMouseLeave);
      node.removeEventListener('wheel',      onWheel);
    },
  };
}
