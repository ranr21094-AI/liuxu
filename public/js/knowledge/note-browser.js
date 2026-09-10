const STORAGE_KEY = 'liuxu.noteBrowser.v1';
const WIDTH_KEY = 'liuxu.noteBrowser.width';
const DEFAULT_WIDTH = 420;
const MIN_WIDTH = 320;
const MAX_WIDTH = 760;

let state;

function $(selector) { return document.querySelector(selector); }
function desktopBrowser() { return window.liuxuDesktop?.browser; }
function clampWidth(value, available = window.innerWidth) {
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.min(Number(value) || DEFAULT_WIDTH, Math.max(MIN_WIDTH, available - 420))));
}
function normalizeAddress(value) {
  const text = String(value || '').trim();
  if (!text) return 'https://www.google.com/';
  if (/^https?:\/\//i.test(text)) return text;
  if (/^[\w.-]+(?::\d+)?(?:\/|$)/.test(text)) return `https://${text}`;
  return `https://www.google.com/search?q=${encodeURIComponent(text)}`;
}
function loadRecords() {
  try { const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); return value && typeof value === 'object' ? value : {}; } catch { return {}; }
}
function saveRecords() {
  if (!state) return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.records));
  desktopBrowser()?.saveState?.({ records: state.records, width: state.width }).catch(state.onError);
}
function record(documentId = state?.documentId) {
  if (!state || !documentId) return null;
  return state.records[documentId] ||= { tabs: [], activeTabId: '', open: false, expanded: false };
}
function activeTab() { const current = record(); return current?.tabs.find(tab => tab.id === current.activeTabId) || null; }
function upsertTab(tab, { select = false } = {}) {
  if (!tab?.documentId || !state) return;
  const current = record(tab.documentId);
  const index = current.tabs.findIndex(item => item.id === tab.id);
  if (index >= 0) current.tabs[index] = { ...current.tabs[index], ...tab };
  else current.tabs.push(tab);
  if (select || !current.activeTabId) current.activeTabId = tab.id;
  saveRecords();
  if (tab.documentId === state.documentId) { render(); syncNative(); }
}
function removeTab(id, documentId = state?.documentId) {
  const current = record(documentId); if (!current) return;
  current.tabs = current.tabs.filter(tab => tab.id !== id);
  if (current.activeTabId === id) current.activeTabId = current.tabs.at(-1)?.id || '';
  if (!current.tabs.length) current.open = false;
  saveRecords();
  if (documentId === state.documentId) { render(); syncNative(); }
}
function nativeRect() {
  const viewport = $('#noteBrowserViewport');
  if (!viewport || viewport.hidden) return { x: 0, y: 0, width: 0, height: 0 };
  const rect = viewport.getBoundingClientRect();
  return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
}
function shouldShowNative() {
  const current = record();
  return Boolean(desktopBrowser() && current?.open && current.activeTabId && !state.covered && document.body.dataset.mode === 'knowledge');
}
async function syncNative() {
  if (!state || state.destroyed) return;
  const browser = desktopBrowser(); if (!browser) return;
  const tab = activeTab();
  try { await browser.activate({ documentId: state.documentId, tabId: tab?.id || '', visible: shouldShowNative(), rect: nativeRect() }); } catch {}
}
function render() {
  const browser = desktopBrowser();
  const button = $('#noteBrowserToggleButton');
  if (button) { button.hidden = !browser || !state.documentId; button.disabled = Boolean(state.loading); button.setAttribute('aria-expanded', String(Boolean(record()?.open))); }
  const panel = $('#noteBrowserPanel');
  if (!panel) return;
  const current = record();
  const open = Boolean(browser && current?.open);
  panel.hidden = !open;
  document.body.classList.toggle('note-browser-open', open);
  document.body.classList.toggle('note-browser-expanded', open && current.expanded);
  panel.style.width = `${state.width}px`;
  const tabs = $('#noteBrowserTabs');
  tabs.innerHTML = (current?.tabs || []).map(tab => `<button type="button" class="note-browser-tab${tab.id === current.activeTabId ? ' active' : ''}" data-browser-tab="${escapeHtml(tab.id)}" title="${escapeHtml(tab.url || '')}"><span>${escapeHtml(tab.title || '新标签页')}</span><i data-browser-close="${escapeHtml(tab.id)}" aria-label="关闭">×</i></button>`).join('');
  const tab = activeTab();
  $('#noteBrowserAddress').value = tab?.url || '';
  $('#noteBrowserBack').disabled = !tab?.canGoBack;
  $('#noteBrowserForward').disabled = !tab?.canGoForward;
  $('#noteBrowserReload').textContent = tab?.loading ? '停止' : '刷新';
  $('#noteBrowserViewport').dataset.empty = tab ? 'false' : 'true';
  $('#noteBrowserEmpty').hidden = Boolean(tab);
  requestAnimationFrame(syncNative);
  window.dispatchEvent(new window.Event('note-browser-layout'));
}
function escapeHtml(value) { const node = document.createElement('span'); node.textContent = String(value || ''); return node.innerHTML; }
async function openTab(url) {
  const tab = await desktopBrowser().open({ documentId: state.documentId, url: normalizeAddress(url) });
  state.hydrated.add(state.documentId);
  upsertTab(tab, { select: true });
}
async function hydrateDocument() {
  const current = record();
  if (!current || state.hydrated.has(state.documentId) || !current.tabs.length) return;
  const documentId = state.documentId;
  const saved = [...current.tabs];
  const activeIndex = Math.max(0, saved.findIndex(tab => tab.id === current.activeTabId));
  try {
    const existing = await desktopBrowser().activate({ documentId, tabId: current.activeTabId, visible: shouldShowNative(), rect: nativeRect() });
    if (existing?.tab) { state.hydrated.add(documentId); upsertTab(existing.tab, { select: true }); return; }
  } catch { /* desktop process restarted; rebuild tabs from saved URLs */ }
  const restored = [];
  state.hydrated.add(documentId);
  for (const savedTab of saved) {
    if (state.documentId !== documentId) return;
    const tab = await desktopBrowser().open({ documentId, url: savedTab.url });
    restored.push(tab);
  }
  current.tabs = restored;
  current.activeTabId = restored[activeIndex]?.id || restored[0]?.id || '';
  saveRecords(); render();
}
async function command(action, extra = {}) {
  const tab = activeTab(); if (!tab) return;
  const next = await desktopBrowser().command({ documentId: state.documentId, tabId: tab.id, action, rect: nativeRect(), ...extra });
  upsertTab(next, { select: true });
}
async function closeTab(id) {
  await desktopBrowser().close({ documentId: state.documentId, tabId: id });
  removeTab(id);
}
function toggle() {
  if (state?.loading) return;
  const current = record(); if (!current) return;
  current.open = !current.open;
  saveRecords(); render();
  if (current.open && !current.tabs.length) openTab('https://www.google.com/').catch(state.onError);
}
function bindResize() {
  const grip = $('#noteBrowserResize'); let drag;
  grip.addEventListener('pointerdown', event => { if (event.button !== 0) return; drag = { id: event.pointerId, x: event.clientX, width: state.width }; grip.setPointerCapture?.(event.pointerId); event.preventDefault(); });
  grip.addEventListener('pointermove', event => { if (!drag || drag.id !== event.pointerId) return; state.width = clampWidth(drag.width + drag.x - event.clientX, $('.workspace-main')?.clientWidth || innerWidth); render(); });
  const end = () => { if (!drag) return; localStorage.setItem(WIDTH_KEY, String(state.width)); drag = null; };
  grip.addEventListener('pointerup', end); grip.addEventListener('pointercancel', end);
  grip.addEventListener('keydown', event => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); state.width = event.key === 'Home' ? MIN_WIDTH : event.key === 'End' ? MAX_WIDTH : clampWidth(state.width + (event.key === 'ArrowLeft' ? 16 : -16)); localStorage.setItem(WIDTH_KEY, String(state.width)); render(); });
}
function updateCover() {
  if (!state || state.destroyed) return;
  const dialog = [...document.querySelectorAll('dialog[open],[role="dialog"]')].some(node => !node.hidden && node.id !== 'noteAssistantPanel');
  const assistant = $('#noteAssistantPanel:not([hidden])');
  state.covered = dialog || Boolean(assistant && !['docked', 'stacked'].includes(assistant.dataset.layout));
  syncNative();
}

export function initNoteBrowser({ onError = console.error } = {}) {
  state = { documentId: '', records: loadRecords(), hydrated: new Set(), width: clampWidth(localStorage.getItem(WIDTH_KEY)), covered: false, loading: Boolean(desktopBrowser()?.loadState), onError };
  if (!desktopBrowser()) { render(); return { destroy() { if (state) state.destroyed = true; } }; }
  $('#noteBrowserToggleButton')?.addEventListener('click', toggle);
  $('#noteBrowserNewTab')?.addEventListener('click', () => openTab('https://www.google.com/').catch(onError));
  $('#noteBrowserClosePanel')?.addEventListener('click', toggle);
  $('#noteBrowserExpand')?.addEventListener('click', () => { const current = record(); current.expanded = !current.expanded; saveRecords(); render(); });
  $('#noteBrowserBack')?.addEventListener('click', () => command('back').catch(onError));
  $('#noteBrowserForward')?.addEventListener('click', () => command('forward').catch(onError));
  $('#noteBrowserReload')?.addEventListener('click', () => command(activeTab()?.loading ? 'stop' : 'reload').catch(onError));
  $('#noteBrowserExternal')?.addEventListener('click', () => command('external').catch(onError));
  $('#noteBrowserAddressForm')?.addEventListener('submit', event => { event.preventDefault(); const value = $('#noteBrowserAddress').value; activeTab() ? command('navigate', { url: normalizeAddress(value) }).catch(onError) : openTab(value).catch(onError); });
  $('#noteBrowserTabs')?.addEventListener('click', event => {
    const close = event.target.closest('[data-browser-close]'); if (close) { event.stopPropagation(); closeTab(close.dataset.browserClose).catch(onError); return; }
    const tab = event.target.closest('[data-browser-tab]'); if (!tab) return; record().activeTabId = tab.dataset.browserTab; saveRecords(); render(); syncNative();
  });
  bindResize();
  const unsubscribe = desktopBrowser().onEvent(event => {
    if (!event.tab?.documentId) return;
    if (event.type === 'tab-closed') removeTab(event.tab.id, event.tab.documentId);
    else upsertTab(event.tab, { select: event.type === 'tab-created' && event.tab.documentId === state.documentId });
    if (event.type === 'load-failed' || event.type === 'crashed') onError(new Error(event.error || '网页加载失败'));
  });
  const resizeObserver = new ResizeObserver(syncNative);
  resizeObserver.observe($('#noteBrowserViewport'));
  const mutationObserver = new MutationObserver(updateCover);
  mutationObserver.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['hidden', 'data-layout', 'data-mode', 'open'] });
  const onResize = () => { state.width = clampWidth(state.width); render(); };
  window.addEventListener('resize', onResize);
  render();
  if (desktopBrowser().loadState) {
    desktopBrowser().loadState().then(saved => {
      state.records = saved?.records && typeof saved.records === 'object' ? saved.records : {};
      state.width = clampWidth(saved?.width);
      state.loading = false;
      render();
      hydrateDocument().catch(state.onError);
    }).catch(error => { state.loading = false; onError(error); render(); });
  }
  return { destroy() { state.destroyed = true; unsubscribe?.(); resizeObserver.disconnect(); mutationObserver.disconnect(); window.removeEventListener('resize', onResize); } };
}

export function noteBrowserSetDocument(document) {
  if (!state) return;
  state.private = document?.visibility === 'diary' || document?.knowledgeBase === '日记';
  state.documentId = document?.status === 'archived' ? '' : String(document?.id || '');
  desktopBrowser()?.activate({ documentId: state.documentId, tabId: '', visible: false, rect: { x: 0, y: 0, width: 0, height: 0 } }).catch(state.onError);
  render();
  hydrateDocument().catch(state.onError);
}
export function noteBrowserClear({ deleteDocument = false } = {}) {
  if (!state) return;
  if (deleteDocument && state.documentId) noteBrowserDeleteDocument(state.documentId);
  state.documentId = ''; render();
  desktopBrowser()?.activate({ documentId: '', tabId: '', visible: false, rect: { x: 0, y: 0, width: 0, height: 0 } }).catch(() => {});
}
export function noteBrowserDeleteDocument(documentId) {
  if (!state || !documentId) return;
  const id = String(documentId);
  for (const tab of state.records[id]?.tabs || []) desktopBrowser()?.close({ documentId: id, tabId: tab.id }).catch(() => {});
  delete state.records[id];
  state.hydrated.delete(id);
  if (state.documentId === id) state.documentId = '';
  if (!state.documentId) desktopBrowser()?.activate({ documentId: '', tabId: '', visible: false, rect: { x: 0, y: 0, width: 0, height: 0 } }).catch(() => {});
  saveRecords(); render();
}
export function noteBrowserLockPrivate() { if (state?.private) noteBrowserClear(); }
export function noteBrowserResetWorkspace() {
  if (!state) return;
  for (const [documentId, current] of Object.entries(state.records)) {
    for (const tab of current.tabs || []) desktopBrowser()?.close({ documentId, tabId: tab.id }).catch(() => {});
  }
  state.records = {}; state.hydrated.clear(); saveRecords(); desktopBrowser()?.clearState?.().catch(state.onError); noteBrowserClear();
}
export function relayNoteBrowserTool(entry, payload) {
  const request = payload?.request;
  if (!desktopBrowser() || !entry?.runId || !payload?.id || !request?.name?.startsWith('note_browser.')) return false;
  desktopBrowser().executeTool({ documentId: request.documentId, name: request.name, args: request.args, tabId: request.args?.tabId, pageVersion: request.args?.pageVersion })
    .then(result => fetch(`/api/agent/runs/${encodeURIComponent(entry.runId)}/client-tools/${encodeURIComponent(payload.id)}/result`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ result }) }))
    .catch(error => fetch(`/api/agent/runs/${encodeURIComponent(entry.runId)}/client-tools/${encodeURIComponent(payload.id)}/result`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ result: { ok: false, summary: error.message, errorCode: 'note_browser_failed', retryable: true } }) }));
  return true;
}

export { clampWidth, normalizeAddress };
