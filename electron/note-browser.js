const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { shell, WebContentsView } = require('electron');

const PARTITION = 'persist:liuxu-note-browser';
const MAX_TABS = 12;
const MAX_TEXT = 120000;

function normalizeBrowserUrl(value) {
  let raw = String(value || '').trim();
  if (!raw) return 'https://www.google.com/';
  if (!/^[a-z][a-z\d+.-]*:/i.test(raw)) raw = `https://${raw}`;
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('只允许打开 http(s) 网页');
  url.username = '';
  url.password = '';
  return url.toString();
}

function normalizeBounds(input = {}) {
  const number = key => Math.max(0, Math.round(Number(input[key]) || 0));
  return { x: number('x'), y: number('y'), width: number('width'), height: number('height') };
}

function sanitizeStoredState(input) {
  const records = {};
  const source = input?.records && typeof input.records === 'object' ? input.records : {};
  for (const [documentId, value] of Object.entries(source).slice(0, 5000)) {
    const id = String(documentId || '').slice(0, 300);
    if (!id || !value || typeof value !== 'object') continue;
    const storedTabs = [];
    for (const tab of (Array.isArray(value.tabs) ? value.tabs : []).slice(0, MAX_TABS)) {
      try {
        const stored = {
          id: String(tab?.id || '').slice(0, 100),
          documentId: id,
          title: String(tab?.title || '').slice(0, 500),
          url: normalizeBrowserUrl(tab?.url),
        };
        if (stored.id && stored.url) storedTabs.push(stored);
      } catch { /* discard unsafe or corrupt saved URLs */ }
    }
    records[id] = {
      tabs: storedTabs,
      activeTabId: String(value.activeTabId || '').slice(0, 100),
      open: Boolean(value.open),
      expanded: Boolean(value.expanded),
    };
  }
  return { records, width: Math.max(320, Math.min(760, Number(input?.width) || 420)) };
}

function createNoteBrowserManager({ window, send = () => {}, openExternal = url => shell.openExternal(url), statePath = '' } = {}) {
  const tabs = new Map();
  let active = null;
  let activeDocument = '';
  let bounds = { x: 0, y: 0, width: 0, height: 0 };
  let requestedVisible = false;

  function loadState() {
    if (!statePath || !fs.existsSync(statePath)) return { records: {}, width: 420 };
    try { return sanitizeStoredState(JSON.parse(fs.readFileSync(statePath, 'utf8'))); }
    catch { return { records: {}, width: 420 }; }
  }

  function saveState(input) {
    if (!statePath) return sanitizeStoredState(input);
    const next = sanitizeStoredState(input);
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const temporary = `${statePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(next)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, statePath);
    return next;
  }

  function clearState() {
    if (statePath) {
      try { fs.unlinkSync(statePath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return { cleared: true };
  }

  function publicTab(tab) {
    if (!tab) return null;
    const wc = tab.view.webContents;
    if (!wc || wc.isDestroyed?.()) return {
      id: tab.id, documentId: tab.documentId, title: tab.title || '新标签页', url: tab.url || '',
      loading: false, canGoBack: false, canGoForward: false, pageVersion: tab.pageVersion, crashed: tab.crashed,
    };
    const snapshot = {
      id: tab.id,
      documentId: tab.documentId,
      title: wc.getTitle() || tab.title || '新标签页',
      url: wc.getURL() || tab.url,
      loading: wc.isLoading(),
      canGoBack: wc.navigationHistory?.canGoBack?.() || false,
      canGoForward: wc.navigationHistory?.canGoForward?.() || false,
      pageVersion: tab.pageVersion,
      crashed: tab.crashed,
    };
    tab.title = snapshot.title;
    tab.url = snapshot.url;
    return snapshot;
  }

  function emit(type, tab, extra = {}) {
    send({ type, tab: publicTab(tab), ...extra });
  }

  function updateVisibility() {
    for (const tab of tabs.values()) {
      const visible = requestedVisible && active === tab.id && bounds.width > 0 && bounds.height > 0;
      tab.view.setVisible(visible);
      if (visible) tab.view.setBounds(bounds);
    }
  }

  function requireTab(documentId, tabId, pageVersion) {
    const tab = tabs.get(String(tabId || ''));
    if (!tab || tab.documentId !== String(documentId || '')) throw new Error('浏览器标签已关闭或不属于当前笔记');
    if (pageVersion !== undefined && Number(pageVersion) !== tab.pageVersion) throw new Error('网页已变化，请重新读取后再操作');
    return tab;
  }

  function wire(tab) {
    const wc = tab.view.webContents;
    const guard = (event, url) => {
      try { normalizeBrowserUrl(url); } catch { event.preventDefault(); }
    };
    wc.on('will-navigate', guard);
    wc.on('will-redirect', guard);
    const changed = () => {
      tab.pageVersion += 1;
      tab.crashed = false;
      emit('tab-updated', tab);
    };
    wc.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => { if (isMainFrame) changed(); });
    wc.on('did-start-loading', () => emit('tab-updated', tab));
    wc.on('did-stop-loading', () => emit('tab-updated', tab));
    wc.on('page-title-updated', () => emit('tab-updated', tab));
    wc.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      if (isMainFrame && !tab.closed) emit('load-failed', tab, { error: description, code, url });
    });
    wc.on('render-process-gone', (_event, details) => {
      tab.crashed = true;
      tab.pageVersion += 1;
      if (!tab.closed) emit('crashed', tab, { reason: details.reason });
    });
    wc.setWindowOpenHandler(({ url }) => {
      try { open({ documentId: tab.documentId, url }); } catch { openExternal(url); }
      return { action: 'deny' };
    });
  }

  function open({ documentId, url, tabId } = {}) {
    const owner = String(documentId || '');
    if (!owner) throw new Error('缺少关联笔记');
    const existing = tabId ? tabs.get(String(tabId)) : null;
    if (!existing && [...tabs.values()].filter(tab => tab.documentId === owner).length >= MAX_TABS) throw new Error(`每篇笔记最多打开 ${MAX_TABS} 个标签`);
    const target = normalizeBrowserUrl(url);
    const tab = existing || {
      id: crypto.randomUUID(), documentId: owner, url: target, title: '加载中…', pageVersion: 0, crashed: false,
      view: new WebContentsView({ webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } }),
    };
    if (!existing) {
      tabs.set(tab.id, tab);
      window.contentView.addChildView(tab.view);
      wire(tab);
    } else if (tab.documentId !== owner) {
      throw new Error('浏览器标签不属于当前笔记');
    }
    active = tab.id;
    requestedVisible = true;
    updateVisibility();
    tab.loadPromise = tab.view.webContents.loadURL(target).catch(error => {
      if (!tab.closed) emit('load-failed', tab, { error: error.message, url: target });
    });
    emit(existing ? 'tab-updated' : 'tab-created', tab);
    return publicTab(tab);
  }

  function activate({ documentId, tabId, visible = true, rect } = {}) {
    activeDocument = String(documentId || '');
    bounds = normalizeBounds(rect || bounds);
    requestedVisible = Boolean(visible);
    if (tabId) requireTab(documentId, tabId);
    active = tabId ? String(tabId) : null;
    updateVisibility();
    return { activeTabId: active, visible: requestedVisible, bounds, tab: active ? publicTab(tabs.get(active)) : null };
  }

  function command({ documentId, tabId, action, url, rect } = {}) {
    if (rect) bounds = normalizeBounds(rect);
    const tab = requireTab(documentId, tabId);
    const wc = tab.view.webContents;
    if (action === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
    else if (action === 'forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
    else if (action === 'reload') wc.reload();
    else if (action === 'stop') wc.stop();
    else if (action === 'navigate') void wc.loadURL(normalizeBrowserUrl(url));
    else if (action === 'external') openExternal(wc.getURL());
    else throw new Error('不支持的浏览器命令');
    return publicTab(tab);
  }

  function close({ documentId, tabId } = {}) {
    const tab = requireTab(documentId, tabId);
    if (active === tab.id) active = null;
    emit('tab-closed', tab);
    tab.closed = true;
    window.contentView.removeChildView(tab.view);
    tab.view.webContents.close();
    tabs.delete(tab.id);
    updateVisibility();
    return { closed: true, tabId: tab.id };
  }

  async function executeTool({ documentId, tabId, pageVersion, name, args = {} } = {}) {
    if (!activeDocument || String(documentId || '') !== activeDocument) throw new Error('用户已切换笔记，请重新读取当前浏览器');
    if (name === 'note_browser.open') {
      const created = open({ documentId, url: args.url });
      const tab = tabs.get(created.id);
      await tab?.loadPromise;
      return { ok: true, summary: '已打开网页', data: publicTab(tab) };
    }
    if (name === 'note_browser.tabs') {
      const data = [...tabs.values()].filter(item => item.documentId === String(documentId || '')).map(publicTab);
      return { ok: true, summary: `找到 ${data.length} 个内置浏览器标签`, data: { tabs: data } };
    }
    const tab = requireTab(documentId, tabId || active, pageVersion);
    if (['note_browser.navigate', 'note_browser.click', 'note_browser.type', 'note_browser.select', 'note_browser.scroll', 'note_browser.close'].includes(name) && active !== tab.id) {
      throw new Error('用户已切换浏览器标签，请重新读取目标网页');
    }
    const wc = tab.view.webContents;
    const code = {
      'note_browser.read': `(() => { const clean = document.body.cloneNode(true); clean.querySelectorAll('script,style,noscript,template,input[type=password]').forEach(n=>n.remove()); const interactive=[...document.querySelectorAll('a[href],button,input:not([type=password]),textarea,select,[role=button]')].slice(0,300).map((el,index)=>({index,tag:el.tagName.toLowerCase(),text:(el.innerText||el.textContent||el.getAttribute('aria-label')||el.placeholder||'').trim().slice(0,300),type:el.type||'',href:el.href||'',disabled:!!el.disabled})); return {title:document.title,url:location.href,text:(clean.innerText||clean.textContent||'').trim().slice(0,${MAX_TEXT}),interactive}; })()`,
      'note_browser.click': `(() => { const els=[...document.querySelectorAll('a[href],button,input:not([type=password]),textarea,select,[role=button]')]; const el=els[${Number(args.index)}]; if(!el) throw new Error('目标元素不存在'); el.click(); return {clicked:true}; })()`,
      'note_browser.type': `(() => { const els=[...document.querySelectorAll('a[href],button,input:not([type=password]),textarea,select,[role=button]')]; const el=els[${Number(args.index)}]; if(!el || !('value' in el)) throw new Error('目标输入框不存在'); el.focus(); const proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype; const setter=Object.getOwnPropertyDescriptor(proto,'value')?.set; setter?setter.call(el,${JSON.stringify(String(args.text || ''))}):el.value=${JSON.stringify(String(args.text || ''))}; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); return {typed:true}; })()`,
      'note_browser.select': `(() => { const els=[...document.querySelectorAll('a[href],button,input:not([type=password]),textarea,select,[role=button]')]; const el=els[${Number(args.index)}]; if(!el || el.tagName!=='SELECT') throw new Error('目标选择框不存在'); el.value=${JSON.stringify(String(args.value || ''))}; el.dispatchEvent(new Event('change',{bubbles:true})); return {selected:true}; })()`,
      'note_browser.scroll': `(() => { window.scrollBy({top:${Math.max(-10000, Math.min(10000, Number(args.y) || 0))},left:${Math.max(-10000, Math.min(10000, Number(args.x) || 0))},behavior:'auto'}); return {x:scrollX,y:scrollY}; })()`,
    }[name];
    let data;
    if (name === 'note_browser.screenshot') {
      let encoded;
      try {
        const captured = await wc.capturePage();
        const size = captured.getSize();
        let image = size.width > 1024 ? captured.resize({ width: 1024 }) : captured;
        encoded = image.toJPEG(60);
        if (encoded.length > 1400000 && image.resize) {
          image = captured.resize({ width: 720 });
          encoded = image.toJPEG(48);
        }
      } catch (captureError) {
        if (!wc.debugger) throw captureError;
        const attached = wc.debugger.isAttached();
        try {
          if (!attached) wc.debugger.attach('1.3');
          const captured = await wc.debugger.sendCommand('Page.captureScreenshot', { format: 'jpeg', quality: 55, captureBeyondViewport: false });
          encoded = Buffer.from(captured.data, 'base64');
        } finally {
          if (!attached && wc.debugger.isAttached()) wc.debugger.detach();
        }
      }
      if (encoded.length > 1400000) throw new Error('网页截图过大，请缩小网页后重试');
      data = { image: encoded.toString('base64'), mimeType: 'image/jpeg', title: wc.getTitle(), url: wc.getURL() };
    }
    else if (name === 'note_browser.navigate') { await wc.loadURL(normalizeBrowserUrl(args.url)); data = publicTab(tab); }
    else if (name === 'note_browser.close') return close({ documentId, tabId: tab.id });
    else if (code) data = await wc.executeJavaScript(code, name === 'note_browser.click');
    else throw new Error('不支持的内置浏览器工具');
    if (name === 'note_browser.read') {
      data.url = normalizeBrowserUrl(data.url);
      for (const item of data.interactive || []) {
        if (!item.href) continue;
        try { item.href = normalizeBrowserUrl(item.href); } catch { item.href = ''; }
      }
    }
    return { ok: true, summary: `${name} 完成`, data: { ...data, tabId: tab.id, pageVersion: tab.pageVersion } };
  }

  function destroy() {
    for (const tab of [...tabs.values()]) close({ documentId: tab.documentId, tabId: tab.id });
  }

  return { open, activate, command, close, executeTool, loadState, saveState, clearState, destroy, normalizeBrowserUrl };
}

module.exports = { createNoteBrowserManager, normalizeBrowserUrl, normalizeBounds, sanitizeStoredState, MAX_TABS };
