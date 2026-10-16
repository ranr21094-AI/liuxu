const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const source = fs.readFileSync(require.resolve('../public/js/workbench.js'), 'utf8');
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const tick = () => new Promise(resolve => setImmediate(resolve));

test('reconciliation preserves unchanged row nodes, focused controls and selection changes', async () => {
  const { reconcileRows } = await import('../public/js/knowledge/row-reconcile.js');
  const dom = new JSDOM('<div id="list"></div>');
  const doc = dom.window.document, list = doc.querySelector('#list');
  const desired = (title = 'A', active = 'note:1') => {
    const host = doc.createElement('div');
    host.innerHTML = ['note:1', 'note:2'].map((id, i) => `<div class="document-row ${id === active ? 'active' : ''}" data-document-open="${id}"><button>${i ? 'B' : title}</button></div>`).join('');
    return host;
  };
  reconcileRows(list, desired());
  const [first, second] = list.children;
  second.firstElementChild.focus();
  reconcileRows(list, desired('A', 'note:2'));
  assert.equal(list.children[0], first);
  assert.equal(list.children[1], second);
  assert.equal(doc.activeElement, second.firstElementChild);
  assert.equal(second.classList.contains('active'), true);
  reconcileRows(list, desired('Renamed', 'note:2'));
  assert.notEqual(list.children[0], first);
  assert.equal(list.children[1], second);
  const reordered = desired('Renamed', 'note:2');
  reordered.prepend(reordered.lastElementChild);
  reconcileRows(list, reordered);
  assert.equal(list.children[0], second);
  assert.equal(doc.activeElement, second.firstElementChild);
  dom.window.close();
});

test('closed select menus are lazy and reopening reflects changed options and selection', async () => {
  const dom = new JSDOM('<label for="folder">目录</label><select id="folder"><option value="a">A</option></select><div data-select-control data-select-id="folder"><button class="select-control-trigger"></button><span class="select-control-value"></span><div class="select-control-menu" hidden></div></div>');
  const previous = global.document;
  global.document = dom.window.document;
  try {
    const { initSelectControls, syncSelectControls } = await import(`../public/js/selectControl.js?performance=${Date.now()}`);
    initSelectControls();
    const menu = document.querySelector('.select-control-menu'), trigger = document.querySelector('button');
    assert.equal(menu.children.length, 0);
    trigger.click(); assert.equal(menu.children.length, 1);
    trigger.click();
    document.querySelector('select').innerHTML += '<option value="b">B</option>';
    document.querySelector('select').value = 'b'; syncSelectControls();
    assert.equal(menu.children.length, 1);
    trigger.click(); assert.equal(menu.children.length, 2);
    assert.equal(menu.querySelector('[aria-selected="true"]').dataset.value, 'b');
  } finally { global.document = previous; dom.window.close(); }
});

test('file-mode page is visible before the tree finishes and identical requests coalesce', async () => {
  const { createLatestRequest } = await import('../public/js/app/sidebar-search.js');
  const elements = { '#knowledgeSearch': { value: '' }, '#knowledgeArchivedFilter': { checked: false } };
  const state = { mode: 'knowledge', selectedKnowledgeBase: 'A', selectedFolderPath: 'child', documents: [], knowledgeSync: { storage: 'liuxu-file-workspace' } };
  let treeResolve, pageResolve; const calls = []; let renders = 0;
  const context = vm.createContext({ state, URLSearchParams, knowledgeRequests: createLatestRequest(),
    $: id => elements[id], knowledgeSearchQuery: () => new URLSearchParams(), knowledgeQuery: () => new URLSearchParams(),
    knowledgeFiltersActive: () => false, isKnowledgeRoot: () => false, setKnowledgeSidebarLevel() {},
    renderDocuments() { renders++; }, showToast() {},
    loadKnowledgeTree: () => new Promise(resolve => { treeResolve = resolve; }),
    apiFetch: url => { calls.push(url); return new Promise(resolve => { pageResolve = resolve; }); },
  });
  vm.runInContext(section('async function loadDocuments(', '\nfunction showEmptyDocument()'), context);
  const first = context.loadDocuments(), second = context.loadDocuments();
  state.knowledgeNextCursor = '60';
  await context.loadDocuments({ append: true });
  assert.equal(calls.length, 1); assert.match(calls[0], /\/documents\?/);
  pageResolve({ ok: true, json: async () => ({ documents: [{ id: 'note:1', version: 2 }], total: 1 }) });
  await Promise.all([first, second]);
  assert.equal(renders, 1); assert.equal(state.documents[0].version, 2);
  treeResolve();
});

test('slow local entries do not hold the page and stale summaries cannot undo a confirmed save', async () => {
  const { createLatestRequest } = await import('../public/js/app/sidebar-search.js');
  const state = { mode: 'knowledge', selectedKnowledgeBase: 'A', selectedFolderPath: '',
    documents: [{ id: 'note:1', version: 3, title: 'saved', collectionPath: 'A', status: 'active' }], localNameOnlyEntries: [] };
  const elements = { '#knowledgeSearch': { value: '' }, '#knowledgeArchivedFilter': { checked: false } };
  let localResolve; const renders = [];
  const context = vm.createContext({ state, URLSearchParams, knowledgeRequests: createLatestRequest(),
    $: id => elements[id], knowledgeSearchQuery: () => new URLSearchParams(), knowledgeQuery: () => new URLSearchParams(),
    knowledgeFiltersActive: () => false, isKnowledgeRoot: () => false, setKnowledgeSidebarLevel() {},
    renderDocuments() { renders.push(state.documents[0]?.title); },
    apiFetch: url => url.includes('local-entries') ? new Promise(resolve => { localResolve = resolve; })
      : Promise.resolve({ ok: true, json: async () => ({ documents: [{ id: 'note:1', version: 2, title: 'old', collectionPath: 'A', status: 'active' }], total: 1 }) }),
  });
  vm.runInContext(section('async function loadDocuments(', '\nfunction showEmptyDocument()'), context);
  await context.loadDocuments({ refreshTree: false });
  assert.deepEqual(renders, ['saved']); assert.equal(state.documents[0].version, 3);
  state.selectedKnowledgeBase = 'B';
  localResolve({ ok: true, json: async () => ({ entries: [{ name: 'stale.bin' }] }) });
  await tick(); assert.equal(state.localNameOnlyEntries.length, 0); assert.deepEqual(renders, ['saved']);
});

test('tree refresh coalesces reads and discards snapshots invalidated by a mutation', async () => {
  const pending = [], applied = [];
  const state = { mode: 'knowledge', knowledgeBases: [], selectedKnowledgeBase: 'A' };
  const context = vm.createContext({ state, apiFetch: () => new Promise(resolve => pending.push(resolve)),
    renderKnowledgeBaseList() { applied.push(state.knowledgeBases[0]?.name); }, renderKnowledgeTree() {},
    syncDocumentSelectOptions() {}, renderDocuments() {},
  });
  vm.runInContext(section('let knowledgeTreeRequest = null;', '\nasync function manageKnowledgeTree'), context);
  const first = context.loadKnowledgeTree({ invalidate: false });
  const duplicate = context.loadKnowledgeTree({ invalidate: false });
  assert.equal(pending.length, 1);
  const mutation = context.loadKnowledgeTree();
  pending.shift()({ ok: true, json: async () => ({ knowledgeBases: [{ name: 'old' }] }) });
  await tick(); assert.deepEqual(applied, []); assert.equal(pending.length, 1);
  pending.shift()({ ok: true, json: async () => ({ knowledgeBases: [{ name: 'new' }] }) });
  await Promise.all([first, duplicate, mutation]);
  assert.deepEqual(applied, ['new']);
});

test('navigation initiated during a pending save only commits the latest target', async () => {
  let route = { mode: 'knowledge', id: '', knowledgeBase: 'A', folderPath: 'first' };
  let release; const save = new Promise(resolve => { release = resolve; });
  const visited = [], hashes = [];
  const state = { mode: 'knowledge', routeSerial: 0, activeDocument: { id: 'note:1' } };
  const context = vm.createContext({ state, noteMutationLock: null, history: { replaceState: (...args) => hashes.push(args[2]) },
    parseRoute: () => ({ ...route }), routeHash: () => '', flushPendingSaves: () => save,
    rememberKnowledgeResume() {}, syncKnowledgeSearchScope() {}, setModeUI() {},
    showEmptyDocument() { state.activeDocument = null; }, renderKnowledgeTree() {}, renderKnowledgeBaseList() {},
    setKnowledgeSidebarLevel() {}, renderDocuments() {}, knowledgeFiltersActive: () => false,
    loadDocuments: async () => { visited.push(state.selectedFolderPath); }, rememberRecentItem() {},
  });
  vm.runInContext(section('async function applyRoute()', '\nfunction sessionGroup'), context);
  const first = context.applyRoute(); route.folderPath = 'last'; const last = context.applyRoute();
  release(true); await Promise.all([first, last]);
  assert.deepEqual(visited, ['last']); assert.deepEqual(hashes, []);
});

test('unchanged preview reuses sanitized DOM; changed source or link context renders again', () => {
  const dom = new JSDOM('<textarea id="documentContent">first</textarea><div id="documentPreview"></div><div id="markdownToc"></div>');
  const state = { activeDocument: { id: 'note:1', outgoingLinks: [] } }; let renders = 0;
  const context = vm.createContext({ state, $: selector => dom.window.document.querySelector(selector),
    previewSnapshot: null, previewRenderGeneration: 0, documentPreviewCleanup: null, knowledgeLinkCleanup: null,
    cancelScheduledPreview() {}, clearMarkdownToc() {}, syncMarkdownToc() {},
    renderKnowledgeMarkdown: content => { renders++; return `<p>${content}</p>`; },
    enableMarkdownImagePreview: () => () => {}, bindNoteImageSizing: () => () => {},
    bindKnowledgeLinkClicks: () => () => {}, openMarkdownImagePreview() {}, navigate() {},
  });
  vm.runInContext(section('function renderDocumentPreview()', "\nwindow.addEventListener('liuxu:markdown-ready'"), context);
  context.renderDocumentPreview(); const node = dom.window.document.querySelector('p');
  context.renderDocumentPreview(); assert.equal(renders, 1); assert.equal(dom.window.document.querySelector('p'), node);
  state.activeDocument.outgoingLinks = [{ targetId: 'note:2' }]; context.renderDocumentPreview(); assert.equal(renders, 2);
  dom.window.document.querySelector('textarea').value = 'changed'; context.renderDocumentPreview(); assert.equal(renders, 3);
  dom.window.close();
});

test('composition records dirty state but schedules no save until composition ends', () => {
  const state = { activeDocument: { id: 'note:1' }, documentComposing: true }; const timers = [];
  const context = vm.createContext({ state, clearTimeout() {}, setTimeout: (fn, delay) => timers.push(delay), setDocumentSaveState() {}, saveDocument() {} });
  vm.runInContext(section('function scheduleDocumentSave()', '\nasync function persistConflictDraft'), context);
  context.scheduleDocumentSave(); assert.equal(state.documentDirty, true); assert.deepEqual(timers, []);
  state.documentComposing = false; context.scheduleDocumentSave(); assert.deepEqual(timers, [800]);
});

test('sync reconciliation waits for local acknowledgement and ignores an older detail response', async () => {
  let releaseSave, releaseRead;
  const writes = new Map([['note:1', new Promise(resolve => { releaseSave = resolve; })]]);
  const state = { mode: 'knowledge', activeDocument: { id: 'note:1', version: 1 }, documentDirty: true,
    knowledgeSync: { fileGeneration: 2, directoryGeneration: 0 } };
  let reads = 0, replaced = 0;
  const context = vm.createContext({ state, documentSaveRequests: writes,
    apiFetch: () => { reads++; return new Promise(resolve => { releaseRead = resolve; }); },
    loadKnowledgeTree: async () => {}, loadDocuments: async () => {},
    renderActiveDocument: async () => { replaced++; }, persistConflictDraft: async () => assert.fail('own save is not an external conflict'),
  });
  vm.runInContext(section('async function reconcileKnowledgeSync(', '\nasync function loadKnowledgeSyncStatus'), context);
  const pending = context.reconcileKnowledgeSync({ fileGeneration: 1, directoryGeneration: 0 });
  assert.equal(reads, 0);
  state.activeDocument.version = 2; state.documentDirty = false; releaseSave(true);
  await tick(); assert.equal(reads, 1);
  state.activeDocument.version = 3; state.documentDirty = true;
  releaseRead({ ok: true, status: 200, json: async () => ({ id: 'note:1', version: 2 }) });
  await pending; assert.equal(replaced, 0); assert.equal(state.documentDirty, true);
});
