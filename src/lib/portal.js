// Portal action: mounts element directly on document.body to escape
// any CSS stacking context created by parent transforms/filters.
// Pass a selector or element to mount into a specific container instead,
// e.g. use:portal={'#bottom-dock-slot'}.
export function portal(node, target) {
  const host = (typeof target === 'string' ? document.querySelector(target) : target) || document.body;
  host.appendChild(node);
  return {
    destroy() { if (node.parentNode) node.parentNode.removeChild(node); }
  };
}
