const svg = body => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
export const KNOWLEDGE_ICONS = {
  base: svg('<path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2.2h7a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"></path>'),
  rename: svg('<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"></path><path d="m13.5 6.5 4 4"></path>'),
  archive: svg('<path d="M3.5 5.5h17v4h-17zM5 9.5V18a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9.5M10 13.5h4"></path>'),
  delete: svg('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"></path>'),
};
export const PIN_ICON = svg('<path d="M8 3h8l-1 7 4 4H5l4-4zM12 14v7"></path>');

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

export function arrangeKnowledgeRows(list) {
  const rows = [...list.children];
  const groups = [
    ['置顶', rows.filter(row => row.dataset.pinnedAt).sort((a, b) => comparePinned({ pinnedAt: a.dataset.pinnedAt }, { pinnedAt: b.dataset.pinnedAt }))],
    ['文件夹', rows.filter(row => !row.dataset.pinnedAt && row.dataset.listGroup === 'folder')],
    ['文件', rows.filter(row => !row.dataset.pinnedAt && row.dataset.listGroup === 'file')],
    ['未同步项', rows.filter(row => row.dataset.listGroup === 'local')],
  ];
  list.replaceChildren();
  for (const [title, group] of groups) {
    if (!group.length) continue;
    const heading = list.ownerDocument.createElement('div');
    heading.className = 'knowledge-pin-section knowledge-list-section';
    heading.textContent = title;
    list.append(heading, ...group);
  }
}
