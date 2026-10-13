// Keep the existing fields and reader actions alive while presenting a compact file header.
export function initReaderHeader() {
  const doc = document;
  const workspace = doc.querySelector('#documentWorkspace');
  const header = workspace?.querySelector('.document-header');
  const tabs = doc.querySelector('#fileReaderTabs');
  if (!header || !tabs) return;
  const title = header.querySelector('.document-title-row');
  const context = header.querySelector('.document-context-row');
  const fields = header.querySelector('.document-inline-fields');
  const actions = header.querySelector('.document-toolbar-actions');
  const assistantButton = doc.querySelector('#assistantToggleButton');
  const browserButton = doc.querySelector('#noteBrowserToggleButton');
  const originalActionSlots = [assistantButton, browserButton].filter(Boolean).map(element => ({
    element, parent: element.parentNode, next: element.nextSibling,
  }));
  const original = doc.querySelector('.file-original-head');
  const tabsHome = tabs.parentElement;
  const tabsAnchor = tabs.nextSibling;
  const infoButton = doc.createElement('button');
  infoButton.type = 'button'; infoButton.className = 'icon-button reader-info-trigger';
  infoButton.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.75 3.75h7l4.5 4.5v12h-11.5z"/><path d="M13.75 3.75v4.5h4.5M9.5 12h6M9.5 15.5h6"/></svg>';
  infoButton.setAttribute('aria-label', '文件信息'); infoButton.title = '文件信息';
  const info = doc.createElement('section'); info.className = 'reader-info-popover';
  info.setAttribute('popover', 'auto'); info.setAttribute('aria-label', '文件信息');
  info.innerHTML = '<header class="reader-info-heading"><span class="reader-info-mark" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M6.75 3.75h7l4.5 4.5v12h-11.5z"/><path d="M13.75 3.75v4.5h4.5M9.5 12h6M9.5 15.5h6"/></svg></span><h3>文件信息</h3><button type="button" class="reader-info-close" aria-label="关闭文件信息">×</button></header><div class="reader-info-identity"></div><div class="reader-info-fields"></div><button type="button" class="reader-backlinks-entry"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 13.5 8.4 15a3.5 3.5 0 0 1-5-5l3-3a3.5 3.5 0 0 1 5 0M14 10.5l1.6-1.5a3.5 3.5 0 0 1 5 5l-3 3a3.5 3.5 0 0 1-5 0M8.5 12h7"/></svg><span>反向引用</span><svg class="reader-info-arrow" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg></button>';
  header.append(info); tabs.classList.add('reader-mode-switch');
  const readerTools = doc.createElement('div'); readerTools.className = 'reader-header-tools';
  const readerQuickActions = doc.createElement('div'); readerQuickActions.className = 'reader-header-quick-actions'; readerQuickActions.setAttribute('aria-label', '文件快捷操作');
  let isFile = false;
  const popovers = [[infoButton, info]];
  function closeAll() { for (const [button, panel] of popovers) { if (panel.matches(':popover-open')) panel.hidePopover(); button.setAttribute('aria-expanded', 'false'); } }
  const restoreActionButtons = () => {
    for (const slot of originalActionSlots) {
      const { element, parent, next } = slot;
      if (!parent || (element.parentNode === parent && element.nextSibling === next)) continue;
      parent.insertBefore(element, next?.parentNode === parent ? next : null);
    }
  };
  for (const [button, panel] of popovers) {
    button.setAttribute('aria-haspopup', 'true'); button.setAttribute('aria-expanded', 'false');
    button.onclick = () => {
      if (panel.matches(':popover-open')) { panel.hidePopover(); return; }
      closeAll(); panel.showPopover();
      const rect = button.getBoundingClientRect();
      const panelWidth = Math.min(panel === info ? 360 : 320, innerWidth - 24);
      panel.style.left = Math.max(12, Math.min(rect.left, innerWidth - panelWidth - 12)) + 'px';
      panel.style.top = Math.min(rect.bottom + 6, Math.max(12, innerHeight - panel.offsetHeight - 12)) + 'px';
      panel.querySelector('button.active,button,input')?.focus({ preventScroll: true });
    };
    panel.addEventListener('toggle', () => button.setAttribute('aria-expanded', String(panel.matches(':popover-open'))));
  }
  info.querySelector('.reader-info-close').onclick = () => { info.hidePopover(); infoButton.focus(); };
  doc.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || event.defaultPrevented || doc.querySelector('dialog[open],.date-picker-popup:not([hidden])')) return;
    const pair = popovers.find(([, panel]) => panel.matches(':popover-open'));
    if (pair) { event.preventDefault(); event.stopImmediatePropagation(); closeAll(); pair[0].focus(); }
  }, true);
  info.querySelector('.reader-backlinks-entry').onclick = () => {
    closeAll(); const relations = doc.querySelector('#knowledgeRelations');
    relations.hidden = false; relations.classList.add('file-relations-open');
    doc.querySelector('[data-knowledge-relations-tab="backlinks"]')?.click();
  };
  function sync() {
    const next = workspace.classList.contains('is-file-document');
    if (next !== isFile) {
      isFile = next; closeAll();
      if (isFile) {
        title.append(actions); info.querySelector('.reader-info-identity').append(original);
        info.querySelector('.reader-info-fields').append(fields);
        context.prepend(tabs, readerTools); context.append(readerQuickActions);
      } else {
        context.prepend(fields); context.append(actions); doc.querySelector('#fileOriginalPanel').prepend(original);
        restoreActionButtons();
        readerQuickActions.remove();
        tabsHome.insertBefore(tabs, tabsAnchor?.parentNode === tabsHome ? tabsAnchor : null);
        const toolbar = readerTools.querySelector('.file-preview-toolbar');
        const fileHost = doc.querySelector('#filePreviewHost');
        if (toolbar && fileHost) fileHost.prepend(toolbar);
        readerTools.remove();
      }
    }
    if (infoButton.hidden !== !isFile) infoButton.hidden = !isFile;
    const toolsHidden = !isFile || tabs.querySelector('button.active')?.dataset.fileReaderTab !== 'preview';
    if (readerTools.hidden !== toolsHidden) readerTools.hidden = toolsHidden;
    if (!isFile) return;
    const toolbar = doc.querySelector('#filePreviewHost > .file-preview-toolbar');
    if (toolbar && !toolbar.closest('.book-focus') && doc.querySelector('#filePreviewHost')?.dataset.headerReady === 'true' && toolbar.parentElement !== readerTools) readerTools.append(toolbar);
    if (readerQuickActions.parentElement !== context) context.append(readerQuickActions);
    for (const element of [infoButton, assistantButton, browserButton].filter(Boolean)) if (element.parentElement !== readerQuickActions) readerQuickActions.append(element);
  }
  new doc.defaultView.MutationObserver(sync).observe(workspace, { attributes: true, attributeFilter: ['class', 'data-header-ready'], childList: true, subtree: true });
  doc.defaultView.addEventListener('hashchange', closeAll);
  sync();
  return { close: closeAll };
}
