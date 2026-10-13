// Adapt the real format readers to one shell without changing their data contracts.
export function mountReaderShell({ host, toolbar, stage, signal, thumbnails = null }) {
  host.classList.add('reading-shell');
  const existingBody=stage.parentElement?.classList.contains('reader-body');
  const body = existingBody ? stage.parentElement : document.createElement('div'); body.className = 'reader-body';
  const side = document.createElement('aside'); side.className = 'reader-side'; side.hidden = true;
  side.innerHTML = '<header><strong></strong><button type="button" aria-label="关闭阅读面板">×</button></header><div class="reader-side-content"></div>';
  const content = side.lastElementChild;
  const settings = document.createElement('section'); settings.className = 'reader-settings'; settings.hidden = true;
  settings.setAttribute('aria-label', '阅读设置');
  const searchControls = document.createElement('div'); searchControls.className = 'reader-search-controls'; searchControls.hidden = true;
  const searchField = document.createElement('label'); searchField.className = 'sidebar-search-field reader-search-field';
  const searchLabel = document.createElement('span'); searchLabel.className = 'sidebar-search-label';
  searchLabel.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"></circle><path d="m16 16 4 4"></path></svg>';
  const searchClear = document.createElement('button'); searchClear.type = 'button'; searchClear.className = 'sidebar-search-clear reader-search-clear';
  searchClear.setAttribute('aria-label', '清空书内搜索'); searchClear.title = '清空搜索'; searchClear.textContent = '×'; searchClear.hidden = true;
  searchField.append(searchLabel, searchClear); searchControls.append(searchField);
  const footer = document.createElement('footer'); footer.className = 'reader-footer';
  const footerLeading = document.createElement('div'); footerLeading.className = 'reader-footer-leading'; footerLeading.setAttribute('aria-hidden', 'true');
  const footerNavigation = document.createElement('div'); footerNavigation.className = 'reader-footer-navigation'; footerNavigation.setAttribute('aria-label', '页面导航');
  const footerUtility = document.createElement('div'); footerUtility.className = 'reader-footer-utility';
  footer.append(footerLeading, footerNavigation, footerUtility);
  const nav = host.querySelector('.book-nav'); const notes = host.querySelector('.book-notes');
  if(!existingBody) { toolbar.after(body); body.append(stage); } body.prepend(side); host.append(settings, footer);
  for (const panel of [nav, notes, thumbnails].filter(Boolean)) { panel.hidden = true; content.append(panel); }
  content.prepend(searchControls);
  let trigger = null, active = '', settingsTrigger, searchInput = null;
  const narrow = () => host.clientWidth < 700;
  const close = (focus = false) => {
    side.hidden = true; active = ''; host.classList.remove('reader-side-open');
    for (const panel of [nav, notes, thumbnails].filter(Boolean)) panel.hidden = true;
    toolbar.querySelectorAll('[aria-expanded]').forEach(button => button.setAttribute('aria-expanded', 'false'));
    if (focus) trigger?.focus();
  };
  const open = (name, source, panel) => {
    settings.hidden = true; settingsTrigger?.setAttribute('aria-expanded', 'false');
    trigger = source; active = name;
    for (const other of [nav, notes, thumbnails].filter(Boolean)) other.hidden = other !== panel;
    searchControls.hidden = name !== '搜索';
    if (panel) panel.hidden = false;
    side.firstElementChild.querySelector('strong').textContent = name;
    side.hidden = false; host.classList.add('reader-side-open');
    toolbar.querySelectorAll('[aria-expanded]').forEach(button => button.setAttribute('aria-expanded', String(button === source)));
    if (name === '搜索') searchInput?.focus();
  };
  side.firstElementChild.querySelector('button').onclick = () => close(true);
  const controls = [...toolbar.children];
  const top = [];
  for (const control of controls) {
    const text = control.textContent.trim();
    if (control.matches('.reader-page-control') || text === '上一页' || text === '下一页') footerNavigation.append(control);
    else if (control.matches('.book-progress,.book-status,[data-pdf-result]')) footerUtility.append(control);
    else if (control.matches('[data-reader-bookmark]')) footerUtility.append(control);
    else if (control.querySelector('[data-pdf-page]') || control.dataset.fileAction === 'pdf-go') footerNavigation.append(control);
    else if (control.matches('input[type=search]')) { searchInput = control; searchLabel.append(control); }
    else if (text === '查找' || control.dataset.fileAction === 'pdf-find') control.remove();
    else if (text === '目录' && nav) {
      top.push(control); control.setAttribute('aria-expanded', 'false');
      control.addEventListener('click', () => { if (nav.hidden) close(); else open('目录', control, nav); });
    } else if (text === '书签与摘录') {
      top.push(control); control.setAttribute('aria-expanded', 'false');
      control.addEventListener('click', () => { if (notes.hidden) close(); else open('书签与摘录', control, notes); });
    } else if (text === '专注阅读') top.push(control);
    else if (control.matches('.file-preview-toolbar-spacer')) control.remove();
    else settings.append(control);
  }
  const makeButton = (name, fn) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = name; b.setAttribute('aria-expanded', 'false'); b.onclick = fn; return b; };
  if (thumbnails) {
    const b = makeButton('缩略图', () => active === '缩略图' ? close() : open('缩略图', b, thumbnails)); top.unshift(b);
    if (!narrow()) open('缩略图', b, thumbnails);
  }
  if (searchInput) {
    const showSearchHint = () => {
      if (!nav) return;
      nav.replaceChildren();
      const hint = document.createElement('p'); hint.className = 'reader-search-hint'; hint.textContent = '输入关键词并按 Enter 搜索'; nav.append(hint);
    };
    const updateSearchClear = () => { searchClear.hidden = !searchInput.value; };
    searchInput.addEventListener('input', updateSearchClear, { signal });
    searchInput.addEventListener('keydown', event => {
      if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      const find = host._filePreviewActions?.find;
      if (typeof find === 'function') Promise.resolve(find()).catch(error => {
        const status = host.querySelector('.book-status');
        if (status) status.textContent = error?.message || '搜索失败';
      });
    }, { signal });
    searchClear.addEventListener('click', () => {
      searchInput.value = ''; updateSearchClear(); searchInput.dispatchEvent(new searchInput.ownerDocument.defaultView.Event('input', { bubbles: true }));
      host._filePreviewActions?.clearSearch?.(); showSearchHint(); searchInput.focus({ preventScroll: true });
    }, { signal });
    const b = makeButton('搜索', () => {
      if (active === '搜索') return close();
      showSearchHint(); open('搜索', b, nav);
    }); top.splice(1, 0, b);
  }
  settingsTrigger = makeButton('阅读设置', () => {
    const visible = !settings.hidden; close(); settings.hidden = visible; settingsTrigger.setAttribute('aria-expanded', String(!visible));
    if (!visible) settings.querySelector('select,input,button')?.focus();
  });
  top.splice(Math.max(0, top.length - 1), 0, settingsTrigger);
  toolbar.replaceChildren(...top);
  if(active) trigger?.setAttribute('aria-expanded','true');
  const observer = new MutationObserver(() => {
    const panel = active === '书签与摘录' ? notes : active === '缩略图' ? thumbnails : nav;
    if (active && panel?.hidden) close();
  });
  for (const panel of [nav, notes, thumbnails].filter(Boolean)) observer.observe(panel, { attributes: true, attributeFilter: ['hidden'] });
  content.addEventListener('click', event => {
    if (narrow() && event.target.closest('[data-reader-jump]')) { close(); stage.focus({ preventScroll: true }); }
  });
  const onEscape = event => {
    if (event.key !== 'Escape' || event.defaultPrevented || document.querySelector('dialog[open],.date-picker-popup:not([hidden])')) return;
    if (!settings.hidden) { event.preventDefault(); event.stopImmediatePropagation(); settings.hidden = true; settingsTrigger.setAttribute('aria-expanded','false'); settingsTrigger.focus(); }
    else if (!side.hidden) { event.preventDefault(); event.stopImmediatePropagation(); close(true); }
  };
  document.addEventListener('keydown', onEscape, { capture: true, signal });
  document.addEventListener('pointerdown', event => { if (!settings.hidden && !settings.contains(event.target) && event.target !== settingsTrigger) { settings.hidden = true; settingsTrigger.setAttribute('aria-expanded','false'); } }, { signal });
  signal.addEventListener('abort', () => { observer.disconnect(); body.remove(); settings.remove(); footer.remove(); host.classList.remove('reading-shell','reader-side-open'); }, { once: true });
  host.dataset.headerReady = 'true';
  const focusObserver = new MutationObserver(() => {
    if (host.classList.contains('book-focus')) { if (toolbar.parentElement !== host) host.prepend(toolbar); }
    else { const target = document.querySelector('.reader-header-tools'); if (target && toolbar.parentElement !== target) target.append(toolbar); }
  });
  focusObserver.observe(host, { attributes: true, attributeFilter: ['class'] });
  signal.addEventListener('abort', () => { focusObserver.disconnect(); toolbar.remove(); delete host.dataset.headerReady; }, { once: true });
  return { footer, footerNavigation, footerUtility, open, close, side };
}
