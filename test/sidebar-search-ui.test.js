const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const html = fs.readFileSync(require.resolve('../public/index.html'), 'utf8');
const source = fs.readFileSync(require.resolve('../public/js/workbench.js'), 'utf8');
const helpers = () => import('../public/js/app/sidebar-search.js');

async function setup() {
  const dom = new JSDOM(html);
  const calls = { knowledge: 0, memory: 0, session: 0 };
  const { initSidebarSearch } = await helpers();
  const controls = initSidebarSearch({ document: dom.window.document,
    onKnowledgeChange: () => calls.knowledge++, onMemoryChange: () => calls.memory++, onSessionChange: () => calls.session++ });
  const document = dom.window.document;
  const proto = dom.window.HTMLElement.prototype, matches = proto.matches;
  proto.matches = function(selector) { return selector === ':popover-open' ? !!this._open : matches.call(this, selector); };
  proto.showPopover = function() { this._open = true; }; proto.hidePopover = function() { this._open = false; };
  const { initKnowledgeOperations } = await import('../public/js/app/knowledge-operations.js');
  document.getElementById('knowledgeSidebarPanel').hidden = false;
  initKnowledgeOperations({ doc: document, createNote: () => {} });
  const input = (id, value, event = 'input') => {
    document.getElementById(id).value = value;
    document.getElementById(id).dispatchEvent(new dom.window.Event(event, { bubbles: true }));
  };
  return { dom, document, controls, calls, input };
}

test('filter panel opens above search, Escape restores focus, outside click closes it', async () => {
  const { dom, document: d } = await setup();
  const toggle = d.getElementById('knowledgeFilterToggle');
  const panel = d.getElementById('knowledgeFilterPanel');
  toggle.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
  assert.equal(panel.hidden, false);
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(d.activeElement.id, 'knowledgeDateFilter');
  d.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(panel.hidden, true);
  assert.equal(d.activeElement, toggle);
  toggle.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })); d.getElementById('knowledgeSearch').click();
  assert.equal(panel.hidden, false);
  d.getElementById('workspaceBrand').click();
  assert.equal(panel.hidden, true);
  dom.window.close();
});

test('combined filter chips remove conditions and reset preserves search text', async () => {
  const { dom, document: d, input, calls, controls } = await setup();
  input('knowledgeSearch', 'report');
  input('knowledgeTagFilter', '<img src=x>');
  input('knowledgeDateFilter', '2026-10-10', 'change');
  const archived = d.getElementById('knowledgeArchivedFilter');
  archived.checked = true; archived.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  assert.equal(d.getElementById('knowledgeFilterCount').textContent, '3');
  assert.equal(d.querySelector('#knowledgeActiveFilters img'), null);
  d.querySelector('[data-filter-remove="knowledgeDateFilter"]').click();
  assert.equal(d.getElementById('knowledgeDateFilter').value, '');
  assert.equal(d.getElementById('knowledgeFilterCount').textContent, '2');
  d.querySelector('[data-filter-remove="all"]').click();
  assert.equal(d.getElementById('knowledgeSearch').value, 'report');
  assert.equal(d.getElementById('knowledgeActiveFilters').hidden, true);
  assert.equal(calls.knowledge, 6);
  controls.resetKnowledge();
  assert.equal(d.getElementById('knowledgeSearch').value, '');
  assert.equal(d.querySelector('[data-search-clear="knowledgeSearch"]').hidden, true);
  dom.window.close();
});

test('all three clear buttons refresh results and restore input focus', async () => {
  const { dom, document: d, input, calls } = await setup();
  for (const id of ['sessionSearch', 'memorySearch', 'knowledgeSearch']) {
    input(id, 'abc');
    const button = d.querySelector(`[data-search-clear="${id}"]`);
    assert.equal(button.hidden, false); button.click();
    assert.equal(d.getElementById(id).value, '');
    assert.equal(button.hidden, true);
    assert.equal(d.activeElement.id, id);
  }
  assert.deepEqual(calls, { knowledge: 2, memory: 2, session: 2 });
  dom.window.close();
});

test('Memory search combines title/body matching with type without mutating items', async () => {
  const { filterMemoryItems } = await helpers();
  const items = [{ id: '1', layer: 'L2', title: 'API', content: '指南' }, { id: '2', layer: 'L3', title: '流程', content: 'api 使用' }, { id: '3', layer: 'system' }];
  assert.deepEqual(filterMemoryItems(items, '', ' API ').map(i => i.id), ['1', '2']);
  assert.deepEqual(filterMemoryItems(items, 'L3', 'Api').map(i => i.id), ['2']);
  assert.deepEqual(filterMemoryItems(items, '', '指南').map(i => i.id), ['1']);
  assert.deepEqual(filterMemoryItems(items, '', '不存在'), []);
  assert.equal(items.length, 3);
});

async function requestContext() {
  const { createLatestRequest } = await helpers();
  const elements = { '#knowledgeSearch': { value: '' }, '#knowledgeArchivedFilter': { checked: false }, '#topbarSubtitle': {}, '#knowledgeDocumentList': { innerHTML: '' } };
  const state = { mode: 'knowledge', selectedKnowledgeBase: '', selectedFolderPath: '', documents: [], knowledgeNextCursor: null };
  const pending = [];
  const guard = createLatestRequest();
  const query = () => new URLSearchParams({ q: elements['#knowledgeSearch'].value, base: state.selectedKnowledgeBase, folder: state.selectedFolderPath });
  const context = vm.createContext({ state, knowledgeRequests: guard, URLSearchParams,
    $: id => elements[id], knowledgeSearchQuery: query, knowledgeQuery: query,
    knowledgeFiltersActive: () => Boolean(elements['#knowledgeSearch'].value || elements['#knowledgeArchivedFilter'].checked),
    isKnowledgeRoot: () => !state.selectedKnowledgeBase,
    clearKnowledgeDocuments: () => { state.documents = []; }, setKnowledgeSidebarLevel() {}, renderDocuments() {},
    loadKnowledgeTree: async () => {}, mergeDocumentPages: (a, b) => [...a, ...b],
    apiFetch: url => new Promise(resolve => pending.push({ url, resolve })),
  });
  vm.runInContext(source.slice(source.indexOf('async function loadDocuments('), source.indexOf('\nfunction showEmptyDocument()')), context);
  const resolve = (index, title, options = {}) => pending[index].resolve({ ok: true, json: async () => ({ documents: [{ title }], total: 1, ...options }) });
  return { context, state, elements, pending, guard, resolve };
}

test('full-library search drops older responses and invalidation works before next debounced request', async () => {
  const { context: c, state, elements: e, pending, guard, resolve } = await requestContext();
  e['#knowledgeSearch'].value = 'old';
  const old = c.loadDocuments({ refreshTree: false });
  e['#knowledgeSearch'].value = 'new'; guard.invalidate();
  const fresh = c.loadDocuments({ refreshTree: false });
  assert.match(pending[1].url, /^\/api\/knowledge\/search\?/);
  resolve(1, 'new'); await fresh;
  resolve(0, 'old'); await old;
  assert.equal(state.documents[0].title, 'new');
  const third = c.loadDocuments({ refreshTree: false });
  guard.invalidate(); // input has changed, but the next request has not started
  resolve(2, 'stale'); await third;
  assert.equal(state.documents[0].title, 'new');
});

test('scope changes reject in-flight results; archived searches use existing list pagination', async () => {
  const { context: c, state, elements: e, pending, resolve } = await requestContext();
  e['#knowledgeSearch'].value = 'term'; state.selectedKnowledgeBase = 'A';
  const before = c.loadDocuments({ refreshTree: false });
  state.selectedKnowledgeBase = 'B'; state.selectedFolderPath = 'child';
  resolve(0, 'wrong scope'); await before;
  assert.equal(state.documents.length, 0);
  e['#knowledgeArchivedFilter'].checked = true;
  const archived = c.loadDocuments({ refreshTree: false });
  assert.match(pending[1].url, /^\/api\/knowledge\/documents\?/);
  resolve(1, 'archived', { nextCursor: 'page2' }); await archived;
  assert.equal(state.knowledgeNextCursor, 'page2');
});

test('location navigation resets only search while preserving filter conditions', async () => {
  const { dom, document, controls, input } = await setup();
  const { createLatestRequest } = await helpers();
  const state = { selectedKnowledgeBase: 'A', selectedFolderPath: '' };
  const context = vm.createContext({ state, knowledgeRequests: createLatestRequest(), sidebarSearchControls: controls, clearKnowledgeDocuments() {} });
  vm.runInContext("let knowledgeSearchScope = '';\n" + source.slice(source.indexOf('function syncKnowledgeSearchScope()'), source.indexOf('let suppressKnowledgeClickUntil')), context);
  context.syncKnowledgeSearchScope();
  input('knowledgeSearch', 'term'); input('knowledgeTagFilter', 'tag');
  context.syncKnowledgeSearchScope();
  assert.equal(document.getElementById('knowledgeSearch').value, 'term');
  state.selectedFolderPath = 'child'; context.syncKnowledgeSearchScope();
  assert.equal(document.getElementById('knowledgeSearch').value, '');
  assert.equal(document.getElementById('knowledgeTagFilter').value, 'tag');
  dom.window.close();
});

test('Memory sidebar and selected detail share matching results while proposals remain visible', async () => {
  const { dom, document, input } = await setup();
  const { filterMemoryItems } = await helpers();
  const proposals = [{ id: 'pending1' }, { id: 'pending2' }];
  let shownProposals;
  const state = { mode: 'memory', memoryLayer: 'L2', memories: { items: [
    { id: '1', layer: 'L2', title: 'API guide', content: 'body' },
    { id: '2', layer: 'L2', title: 'Other', content: 'body' },
    { id: '3', layer: 'L3', title: 'API workflow', content: 'body' },
  ], proposals } };
  const c = vm.createContext({ state, document, filterMemoryItems, $: selector => document.querySelector(selector),
    escHtml: text => String(text), memoryBodyHtml: content => content, isSystemMemoryItem: () => false,
    memoryLayerLabel: layer => layer, updateMemoryPendingBadge() {}, setMemoryWriteBusy() {},
    renderMemoryProposalList: items => { shownProposals = items; },
  });
  for (const [start, end] of [
    ['function renderMemoryItems(', 'function updateMemoryPendingBadge('],
    ['function renderMemorySidebar(', 'function renderMemoryProposalList('],
  ]) vm.runInContext(source.slice(source.indexOf(start), source.indexOf(end)), c);
  input('memorySearch', 'api'); c.renderMemoryWorkspace();
  assert.equal(document.querySelectorAll('#agentMemoryItems article').length, 1);
  assert.equal(document.querySelectorAll('#memorySidebarList button').length, 1);
  assert.equal(document.querySelector('#agentMemoryItems article').dataset.memoryItem, '1');
  assert.equal(shownProposals, proposals);
  input('memorySearch', 'no match'); c.renderMemoryWorkspace();
  assert.match(document.getElementById('agentMemoryItems').textContent, /没有匹配的记忆/);
  assert.match(document.getElementById('memorySidebarList').textContent, /没有匹配的记忆/);
  assert.equal(shownProposals.length, 2);
  dom.window.close();
});

test('root searching uses the document result list and clearing restores bases with one shared search field', async () => {
  const { dom, document, input } = await setup();
  const state = { mode: 'knowledge', selectedKnowledgeBase: '', selectedFolderPath: '' };
  const c = vm.createContext({ state, $: selector => document.querySelector(selector),
    isKnowledgeRoot: () => !state.selectedKnowledgeBase,
    knowledgeFiltersActive: () => !!document.getElementById('knowledgeSearch').value,
    syncKnowledgeDocumentActions() {}, updateKnowledgeEmptyState() {},
  });
  vm.runInContext(source.slice(source.indexOf('function setKnowledgeSidebarLevel('), source.indexOf('function updateKnowledgeEmptyState(')), c);
  input('knowledgeSearch', 'term'); c.setKnowledgeSidebarLevel();
  assert.equal(document.getElementById('knowledgeBaseList').hidden, true);
  assert.equal(document.getElementById('knowledgeResultsSection').hidden, false);
  assert.equal(document.getElementById('knowledgeRootPanel').hidden, false);
  input('knowledgeSearch', ''); c.setKnowledgeSidebarLevel();
  assert.equal(document.getElementById('knowledgeBaseList').hidden, false);
  assert.equal(document.getElementById('knowledgeResultsSection').hidden, true);
  state.selectedKnowledgeBase = '库'; state.selectedFolderPath = 'parent/child'; c.setKnowledgeSidebarLevel();
  assert.equal(document.getElementById('knowledgeResultsSection').hidden, false);
  assert.equal(document.getElementById('knowledgeRootPanel').hidden, true);
  assert.equal(document.getElementById('knowledgeSearch').placeholder, '搜索「child」');
  assert.equal(document.querySelectorAll('#knowledgeSearch').length, 1);
  dom.window.close();
});

test('global and scoped date/tag/archive filters include descendants while normal browsing lists exact folder', () => {
  const elements = { '#knowledgeSearch': { value: '' }, '#knowledgeTagFilter': { value: '' }, '#knowledgeDateFilter': { value: '' }, '#knowledgeArchivedFilter': { checked: false } };
  const state = { selectedKnowledgeBase: '', selectedFolderPath: '' };
  const c = vm.createContext({ state, URLSearchParams, $: selector => elements[selector],
    knowledgeFiltersActive: () => !!(elements['#knowledgeSearch'].value || elements['#knowledgeTagFilter'].value || elements['#knowledgeDateFilter'].value || elements['#knowledgeArchivedFilter'].checked),
  });
  vm.runInContext(source.slice(source.indexOf('function knowledgeQuery('), source.indexOf('function knowledgeSearchQuery(')), c);
  elements['#knowledgeDateFilter'].value = '2026-10-10';
  let params = c.knowledgeQuery();
  assert.equal(params.has('folder'), false);
  assert.equal(params.has('knowledgeBase'), false);
  state.selectedKnowledgeBase = 'A'; state.selectedFolderPath = 'child';
  elements['#knowledgeArchivedFilter'].checked = true;
  elements['#knowledgeSearch'].value = 'term';
  params = c.knowledgeQuery('', { includeSearchText: true });
  assert.equal(params.get('knowledgeBase'), 'A');
  assert.equal(params.get('folderPath'), 'child');
  assert.equal(params.get('status'), 'archived');
  assert.equal(params.get('q'), 'term');
  assert.equal(params.has('folder'), false);
  elements['#knowledgeDateFilter'].value = ''; elements['#knowledgeArchivedFilter'].checked = false; elements['#knowledgeSearch'].value = '';
  params = c.knowledgeQuery();
  assert.equal(params.get('folder'), 'child');
  assert.equal(params.has('folderPath'), false);
});


test('current search errors expose a retry instead of keeping the loading message; stale errors are ignored', async () => {
  const { context: c, elements: e, pending, guard } = await requestContext();
  e['#knowledgeSearch'].value = 'term';
  const request = c.loadDocuments({ refreshTree: false });
  pending[0].resolve({ ok: false, json: async () => ({ error: 'offline' }) });
  await assert.rejects(request, /offline/);
  assert.match(e['#knowledgeDocumentList'].innerHTML, /data-knowledge-search-retry/);
  e['#knowledgeDocumentList'].innerHTML = 'fresh';
  const stale = c.loadDocuments({ refreshTree: false }); guard.invalidate();
  pending[1].resolve({ ok: false, json: async () => ({ error: 'old error' }) });
  await stale;
  assert.equal(e['#knowledgeDocumentList'].innerHTML, 'fresh');
});

test('independent filter clear preserves the keyword and operations opening does not inherit filters', async () => {
  const { dom, document:d, input, controls }=await setup();
  try {
    input('knowledgeSearch','report');input('knowledgeTagFilter','tag');
    const clear=d.getElementById('knowledgeClearFilters');assert.equal(clear.disabled,false);
    d.getElementById('knowledgeFilterToggle').click();assert.equal(d.getElementById('knowledgeFilterPanel').hidden,false);
    d.getElementById('knowledgeOperationsToggle').dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true}));
    assert.equal(d.getElementById('knowledgeFilterPanel').hidden,true);
    assert.equal(d.getElementById('knowledgeOperationsPanel').hidden,false);
    assert.equal(d.getElementById('knowledgeTagFilter').value,'tag');
    controls.resetKnowledge();assert.equal(d.getElementById('knowledgeTagFilter').value,'tag');
    input('knowledgeSearch','report');clear.click();assert.equal(d.getElementById('knowledgeSearch').value,'report');
    assert.equal(d.getElementById('knowledgeTagFilter').value,'');assert.equal(clear.disabled,true);
  } finally { dom.window.close(); }
});
