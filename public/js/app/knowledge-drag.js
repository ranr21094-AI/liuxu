const SOURCE_SELECTOR = '[data-knowledge-drag-type]';
const TARGET_SELECTOR = '[data-drop-base][data-drop-folder]';
const KNOWLEDGE_ZONE_SELECTOR = '#knowledgeDocumentList, #knowledgeBaseList, #knowledgeBreadcrumb, #knowledgeDropTargets';

function closestElement(target, selector) {
  const element = target?.nodeType === 1 ? target : target?.parentElement;
  return element?.closest(selector) || null;
}

function itemFromRow(row) {
  const type = row.dataset.knowledgeDragType;
  if (type === 'folder') {
    const path = row.dataset.knowledgeDragPath || '';
    return path ? { type, path } : null;
  }
  if (type === 'document') {
    const id = row.dataset.knowledgeDragId || '';
    return id ? { type, id } : null;
  }
  return null;
}

function isKnowledgeSource(row) {
  return Boolean(row?.closest('#knowledgeDocumentList'));
}

function resolveKnowledgeDropTarget(event, root) {
  const element = closestElement(event.target, TARGET_SELECTOR);
  if (!element || !root.contains(element) || !element.closest(KNOWLEDGE_ZONE_SELECTOR)) return null;
  return {
    element,
    knowledgeBase: element.dataset.dropBase || '',
    folderPath: element.dataset.dropFolder || '',
  };
}

export function initKnowledgeDragEvents({
  root,
  doc = root?.ownerDocument || document,
  onDrop,
  onDragStart = () => {},
  onDropStart = () => {},
  onClear = () => {},
  onError = () => {},
}) {
  if (!root) return { destroy() {} };

  let draggedItem = null;
  const clear = () => {
    draggedItem = null;
    doc.body?.classList.remove('knowledge-dragging');
    root.querySelectorAll('.knowledge-drop-active').forEach(element => element.classList.remove('knowledge-drop-active'));
    onClear();
  };

  const handleDragStart = event => {
    if (closestElement(event.target, 'button')) { event.preventDefault(); return; }
    const row = closestElement(event.target, SOURCE_SELECTOR);
    if (!row || !isKnowledgeSource(row)) return;
    draggedItem = itemFromRow(row);
    if (!draggedItem) { clear(); return; }
    try {
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('application/x-liuxu-knowledge-item', JSON.stringify(draggedItem));
        event.dataTransfer.setData('text/plain', draggedItem.type === 'folder' ? draggedItem.path : draggedItem.id);
      }
    } catch { /* Keep native drag available when a browser restricts custom MIME types. */ }
    doc.body?.classList.add('knowledge-dragging');
    onDragStart(draggedItem);
  };

  const handleDragOver = event => {
    if (!draggedItem) return;
    const target = resolveKnowledgeDropTarget(event, root);
    if (!target) return;
    event.preventDefault();
    try { if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'; } catch {}
    root.querySelectorAll('.knowledge-drop-active').forEach(element => {
      if (element !== target.element) element.classList.remove('knowledge-drop-active');
    });
    target.element.classList.add('knowledge-drop-active');
  };

  const handleDragLeave = event => {
    const target = resolveKnowledgeDropTarget(event, root);
    if (target && !target.element.contains(event.relatedTarget)) target.element.classList.remove('knowledge-drop-active');
  };

  const handleDrop = event => {
    const target = resolveKnowledgeDropTarget(event, root);
    if (!target || !draggedItem) return;
    event.preventDefault();
    event.stopPropagation();
    const item = draggedItem;
    onDropStart(item, target);
    clear();
    try {
      Promise.resolve(onDrop(item, target)).catch(onError);
    } catch (error) {
      onError(error);
    }
  };

  root.addEventListener('dragstart', handleDragStart);
  root.addEventListener('dragover', handleDragOver);
  root.addEventListener('dragleave', handleDragLeave);
  root.addEventListener('drop', handleDrop);
  root.addEventListener('dragend', clear);

  return {
    destroy() {
      root.removeEventListener('dragstart', handleDragStart);
      root.removeEventListener('dragover', handleDragOver);
      root.removeEventListener('dragleave', handleDragLeave);
      root.removeEventListener('drop', handleDrop);
      root.removeEventListener('dragend', clear);
      clear();
    },
  };
}
