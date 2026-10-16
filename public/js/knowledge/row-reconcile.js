// Reuse unchanged rows (including their popovers and focus) across refreshes.
export function reconcileRows(list, desired) {
  const focused = list.contains(list.ownerDocument.activeElement) ? list.ownerDocument.activeElement : null;
  const scrollTop = list.scrollTop;
  const key = node => node.dataset.documentOpen ? `document:${node.dataset.documentOpen}`
    : node.dataset.folderOpen !== undefined ? `folder:${node.dataset.dropBase}/${node.dataset.folderOpen}`
      : node.dataset.localEntry ? `local:${node.dataset.localEntry}`
        : `section:${node.firstChild?.textContent || node.textContent}`;
  const previous = new Map([...list.children].map(node => [key(node), node]));
  const retained = new Set();
  let cursor = list.firstElementChild;
  for (const next of [...desired.children]) {
    const active = next.classList.contains('active');
    next.classList.remove('active');
    const signature = next.outerHTML;
    const old = previous.get(key(next));
    const node = old?._rowMarkup === signature ? old : next;
    node._rowMarkup = signature;
    node.classList.toggle('active', active);
    retained.add(node);
    if (node !== cursor) list.insertBefore(node, cursor);
    cursor = node.nextElementSibling;
  }
  for (const node of [...list.children]) if (!retained.has(node)) node.remove();
  if (focused?.isConnected && list.ownerDocument.activeElement !== focused) focused.focus({ preventScroll: true });
  list.scrollTop = scrollTop;
}
