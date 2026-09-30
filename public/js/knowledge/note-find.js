function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function findLiteralMatches(content, query) {
  const source = String(content ?? '');
  const needle = String(query ?? '');
  if (!needle) return [];

  const expression = new RegExp(escapeRegExp(needle), 'giu');
  return [...source.matchAll(expression)].map(match => ({
    start: match.index,
    end: match.index + match[0].length,
  }));
}

export function initNoteFind({
  root = document,
  getActiveDocument = () => null,
  canSearch = () => false,
  getEditorMode = () => 'edit',
  setEditorMode = () => {},
} = {}) {
  const editor = root.querySelector('#documentContent');
  const preview = root.querySelector('#documentPreview');
  const panel = root.querySelector('#noteFindBar');
  const input = root.querySelector('#noteFindInput');
  const count = root.querySelector('#noteFindCount');
  const previousButton = root.querySelector('#noteFindPrevious');
  const nextButton = root.querySelector('#noteFindNext');
  const closeButton = root.querySelector('#noteFindClose');
  const toggleButton = root.querySelector('#noteFindToggleButton');
  if (!editor || !preview || !panel || !input || !count) return null;

  let activeDocumentId = '';
  let query = '';
  let matches = [];
  let activeIndex = -1;
  let isOpen = false;

  function syncCount() {
    if (!query) count.textContent = '输入关键词';
    else if (!matches.length) count.textContent = '0 个匹配';
    else count.textContent = `${activeIndex + 1} / ${matches.length}`;
  }

  function isCurrentDocumentSearchable() {
    const current = getActiveDocument();
    return Boolean(canSearch() && current?.id && current.sourceType !== 'file'
      && String(current.id) === activeDocumentId);
  }

  function locate(index, { returnFocus = false } = {}) {
    if (index < 0 || index >= matches.length || !isCurrentDocumentSearchable()) return false;
    if (getEditorMode() === 'preview') setEditorMode('edit');
    activeIndex = index;
    syncCount();
    const match = matches[index];
    editor.setSelectionRange(match.start, match.end);
    if (returnFocus) input.focus({ preventScroll: true });
    return true;
  }

  function refreshFromEditor({ locateFirst = false } = {}) {
    const oldMatchStart = matches[activeIndex]?.start;
    matches = findLiteralMatches(editor.value, query);
    if (!matches.length) {
      activeIndex = -1;
      syncCount();
      return;
    }
    if (locateFirst) {
      activeIndex = 0;
      locate(activeIndex);
      return;
    }
    const caret = Number.isFinite(editor.selectionStart) ? editor.selectionStart : 0;
    const anchor = Number.isFinite(oldMatchStart) ? oldMatchStart : caret;
    activeIndex = matches.reduce((bestIndex, match, index) => {
      const best = matches[bestIndex];
      const distance = anchor < match.start ? match.start - anchor : anchor > match.end ? anchor - match.end : 0;
      const bestDistance = anchor < best.start ? best.start - anchor : anchor > best.end ? anchor - best.end : 0;
      return distance < bestDistance ? index : bestIndex;
    }, 0);
    syncCount();
  }

  function open() {
    const current = getActiveDocument();
    if (!current?.id || current.sourceType === 'file' || !canSearch()) return false;
    if (String(current.id) !== activeDocumentId) setActiveDocument(current);

    isOpen = true;
    panel.hidden = false;
    toggleButton?.setAttribute('aria-expanded', 'true');
    const start = editor.selectionStart ?? 0;
    const end = editor.selectionEnd ?? start;
    const selected = editor.value.slice(start, end);
    if (selected && !/[\r\n]/.test(selected)) query = selected;
    input.value = query;
    refreshFromEditor();
    if (selected && matches.length) {
      const selectedMatch = matches.findIndex(match => match.start === start && match.end === end);
      if (selectedMatch >= 0) activeIndex = selectedMatch;
      else activeIndex = Math.max(0, matches.findIndex(match => match.start >= start));
      if (activeIndex < 0) activeIndex = matches.length - 1;
      locate(activeIndex);
    }
    else if (matches.length && activeIndex >= 0) locate(activeIndex);
    syncCount();
    input.focus({ preventScroll: true });
    input.select();
    return true;
  }

  function close({ restoreFocus = true } = {}) {
    isOpen = false;
    panel.hidden = true;
    toggleButton?.setAttribute('aria-expanded', 'false');
    if (!restoreFocus || !isCurrentDocumentSearchable()) return;
    const target = getEditorMode() === 'preview' ? preview : editor;
    target.focus?.({ preventScroll: true });
  }

  function move(direction) {
    if (!matches.length) return false;
    const index = activeIndex < 0
      ? (direction > 0 ? 0 : matches.length - 1)
      : (activeIndex + direction + matches.length) % matches.length;
    return locate(index, { returnFocus: true });
  }

  function setActiveDocument(document) {
    const nextId = document?.id && document.sourceType !== 'file' ? String(document.id) : '';
    if (nextId !== activeDocumentId) {
      close({ restoreFocus: false });
      activeDocumentId = nextId;
      query = '';
      matches = [];
      activeIndex = -1;
      input.value = '';
      syncCount();
    }
    if (nextId) refreshFromEditor();
  }

  function isFindableSurface(target) {
    if (!target || panel.contains(target)) return false;
    const inEditor = target === editor;
    const inPreview = target === preview || preview.contains(target);
    if (!inEditor && !inPreview) return false;
    if (target !== editor && target.closest?.('input, textarea, select, button, [contenteditable="true"]')) return false;
    return true;
  }

  function handleKeydown(event) {
    if (event.key === 'Escape' && isOpen) {
      const target = event.target;
      if (panel.contains(target) || editor === target || editor.contains(target)
        || preview === target || preview.contains(target) || target === toggleButton) {
        event.preventDefault();
        close();
        return true;
      }
      return false;
    }
    if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey || event.key.toLowerCase() !== 'f') return false;
    if (!isCurrentDocumentSearchable() || !isFindableSurface(event.target)) return false;
    event.preventDefault();
    open();
    return true;
  }

  toggleButton?.addEventListener('click', open);
  previousButton?.addEventListener('click', () => move(-1));
  nextButton?.addEventListener('click', () => move(1));
  closeButton?.addEventListener('click', () => close());
  input.addEventListener('input', () => {
    query = input.value;
    refreshFromEditor({ locateFirst: Boolean(query) });
    syncCount();
  });
  input.addEventListener('keydown', event => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    move(event.shiftKey ? -1 : 1);
  });
  editor.addEventListener('input', () => {
    if (isOpen) refreshFromEditor();
  });

  syncCount();
  return {
    open,
    close,
    move,
    setActiveDocument,
    refreshFromEditor,
    handleKeydown,
    getState: () => ({ isOpen, query, matches: matches.map(match => ({ ...match })), activeIndex }),
  };
}
