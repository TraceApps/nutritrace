// Portal action: mounts element directly on document.body to escape
// any CSS stacking context created by parent transforms/filters.
export function portal(node) {
  let target = document.body;
  target.appendChild(node);
  return {
    destroy() { if (node.parentNode) node.parentNode.removeChild(node); }
  };
}
