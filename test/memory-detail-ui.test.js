const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const source = fs.readFileSync('public/js/workbench.js', 'utf8');
async function setup() {
  const dom = new JSDOM(fs.readFileSync('public/index.html', 'utf8'), { url: 'http://localhost' });
  const { filterMemoryItems } = await import('../public/js/app/sidebar-search.js');
  const state = { mode: 'memory', memories: { items: [
    { id: 'system', layer: 'system', kind: 'system', title: 'System instructions', content: 'original\nbody' },
    { id: 'fact', layer: 'L2', title: 'Fact', content: 'saved fact' },
  ], proposals: [{ id: 'proposal', title: 'Pending', content: 'proposal body' }] }, memorySelectedId: '', memoryLayer: '', memoryEditingId: '', memoryEditingDraft: '', memoryEditingOriginal: '', memorySearchAccepted: '', memoryLoadError: '', memoryWriteBusy: false };
  const context = { document: dom.window.document, state, filterMemoryItems, CSS: { escape: value => value },
    $: selector => dom.window.document.querySelector(selector), escHtml: value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;'),
    updateMemoryPendingBadge() {}, sidebarSearchControls: { sync() {} }, mobileSidebarQuery: { matches: false }, closeMobileSidebar() {}, confirmAction: async () => false, showToast() {} };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function memoryLayerLabel'), source.indexOf('function updateMemoryPendingBadge')) + source.slice(source.indexOf('function renderMemorySidebar'), source.indexOf('function setMemoryRefreshBusy')), context);
  return { dom, context, state, run: code => vm.runInContext(code, context) };
}

test('Memory directory selects one detail, retains the same DOM on repeated selection and preserves proposals during search', async () => {
  const { dom, context, state, run } = await setup();
  try {
    run('renderMemoryWorkspace()');
    assert.equal(state.memorySelectedId, 'system');
    assert.equal(dom.window.document.querySelectorAll('#agentMemoryItems [data-memory-item]').length, 1);
    assert.equal(dom.window.document.querySelector('[data-memory-select="system"]').getAttribute('aria-current'), 'true');
    await run("selectMemoryItem('fact')");
    assert.equal(dom.window.document.getElementById('memoryDetailTitle').textContent, 'Fact');
    const detail = dom.window.document.querySelector('[data-memory-item="fact"]');
    await run("selectMemoryItem('fact')"); assert.equal(dom.window.document.querySelector('[data-memory-item="fact"]'), detail);
    context.mobileSidebarQuery.matches = true; let closed = false; context.closeMobileSidebar = () => { closed = true; };
    await run("selectMemoryItem('system')"); assert.equal(closed, true); assert.equal(dom.window.document.activeElement.id, 'memoryDetailTitle');
    dom.window.document.getElementById('memorySearch').value = 'missing'; await run('changeMemorySearch()');
    assert.equal(state.memorySelectedId, '');
    assert.match(dom.window.document.getElementById('agentMemoryItems').textContent, /没有匹配/);
    assert.equal(dom.window.document.getElementById('agentMemoryProposals').querySelectorAll('[data-memory-proposal]').length, 1);
    assert.equal(dom.window.document.getElementById('memoryProposalsSection').hidden, false);
    dom.window.document.getElementById('memorySearch').value = ''; await run('changeMemorySearch()');
    assert.equal(state.memorySelectedId, 'system');
  } finally { dom.window.close(); }
});

test('dirty Memory edits prevent selection and search changes until discard is accepted', async () => {
  const { dom, context, state, run } = await setup();
  try {
    Object.assign(state, { memorySelectedId: 'system', memoryEditingId: 'system', memoryEditingOriginal: 'original\nbody', memoryEditingDraft: 'unsaved' });
    run('renderMemoryWorkspace()');
    await run("selectMemoryItem('fact')"); assert.equal(state.memorySelectedId, 'system'); assert.equal(state.memoryEditingDraft, 'unsaved');
    dom.window.document.getElementById('memorySearch').value = 'Fact'; await run('changeMemorySearch()');
    assert.equal(dom.window.document.getElementById('memorySearch').value, '');
    assert.equal(dom.window.document.querySelector('[data-memory-system-editor]').value, 'unsaved');
    context.confirmAction = async () => true;
    await run("selectMemoryItem('fact')"); assert.equal(state.memorySelectedId, 'fact'); assert.equal(state.memoryEditingId, '');
  } finally { dom.window.close(); }
});

test('system Memory save locks repeated writes and preserves failed drafts', async () => {
  const { dom, context, state, run } = await setup();
  try {
    Object.assign(state, { memorySelectedId: 'system', memoryEditingId: 'system', memoryEditingOriginal: 'original\nbody', memoryEditingDraft: 'unsaved' });
    run('renderMemoryWorkspace()');
    let resolveWrite, writes = 0;
    context.confirmSystemPromptChange = async () => true;
    context.apiFetch = async () => { writes++; return new Promise(resolve => { resolveWrite = resolve; }); };
    context.loadMemoriesPanel = async () => {};
    vm.runInContext(source.slice(source.indexOf('async function saveSystemMemoryItem'), source.indexOf('async function restoreSystemMemoryItem')), context);
    const pending = run("saveSystemMemoryItem('system')"); await Promise.resolve();
    await run("saveSystemMemoryItem('system')"); assert.equal(writes, 1);
    resolveWrite({ ok: false, json: async () => ({ error: 'failure' }) }); await pending;
    assert.equal(state.memoryEditingDraft, 'unsaved'); assert.equal(state.memoryEditingId, 'system');
    assert.equal(state.memoryWriteBusy, false); assert.equal(dom.window.document.querySelector('[data-memory-system-editor]').disabled, false);
  } finally { dom.window.close(); }
});

test('approving a proposal selects the saved record and clears incompatible filters without duplicate writes', async () => {
  const { dom, context, state, run } = await setup();
  try {
    state.memoryLayer = 'system'; state.memorySearchAccepted = 'System';
    dom.window.document.getElementById('memorySearch').value = 'System';
    run('renderMemoryWorkspace()');
    const saved = { id: 'saved', title: 'Approved fact', layer: 'L2', content: 'new body' };
    let writes = 0, resolveWrite;
    context.apiFetch = async () => { writes++; return new Promise(resolve => { resolveWrite = resolve; }); };
    context.loadMemoriesPanel = async () => { state.memories.items.push(saved); state.memories.proposals = []; run('renderMemoryWorkspace()'); };
    context.refreshMemoryPendingCount = async () => {};
    vm.runInContext(source.slice(source.indexOf('const memoryProposalWrites'), source.indexOf('async function confirmSystemPromptChange')), context);
    const pending = run("handleMemoryProposalAction('proposal', 'approve')");
    await run("handleMemoryProposalAction('proposal', 'approve')");
    assert.equal(writes, 1);
    resolveWrite({ ok: true, json: async () => saved }); await pending;
    assert.equal(state.memorySelectedId, 'saved'); assert.equal(state.memoryLayer, '');
    assert.equal(dom.window.document.getElementById('memorySearch').value, '');
    assert.equal(dom.window.document.getElementById('memoryDetailTitle').textContent, 'Approved fact');
    assert.equal(dom.window.document.getElementById('memoryProposalsSection').hidden, true);
  } finally { dom.window.close(); }
});
