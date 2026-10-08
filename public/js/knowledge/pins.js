export function comparePinned(a, b) {
  const time = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : '';
  return time(b.pinnedAt).localeCompare(time(a.pinnedAt));
}
export function pinActionHtml({ kind, target, pinnedAt, scope = '', escape }) {
  const pinned = !!pinnedAt;
  return `<button type="button" class="tree-action knowledge-pin-action${pinned ? ' is-pinned' : ''}" data-knowledge-pin-kind="${kind}" data-knowledge-pin-target="${escape(target)}" data-knowledge-pin-parent="${escape(scope)}" data-knowledge-pin-value="${!pinned}" title="${pinned ? '取消置顶' : '置顶'}" aria-label="${pinned ? '取消置顶' : '置顶'}" aria-pressed="${pinned}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M8 3h8l-1 7 4 4H5l4-4zM12 14v7"></path></svg></button>`;
}
export function arrangePinnedRows(list) {
  const rows = [...list.children];
  rows.sort((a,b) => comparePinned({pinnedAt:a.dataset.pinnedAt},{pinnedAt:b.dataset.pinnedAt}));
  if (!rows.some(row => row.dataset.pinnedAt)) return;
  list.replaceChildren(); let group = '';
  for (const row of rows) {
    const next = row.dataset.pinnedAt ? '置顶' : '当前层级';
    if (next !== group) {
      const label = list.ownerDocument.createElement('div'); label.className = 'knowledge-pin-section'; label.textContent = next;
      list.append(label); group = next;
    }
    list.append(row);
  }
}

export function mergeDocumentPages(current, page) {
  return [...new Map([...current, ...page].map(document => [document.id, document])).values()];
}
