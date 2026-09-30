const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/js/workbench.js'), 'utf8');
const reconcileSource = source.slice(
  source.indexOf('async function reconcileKnowledgeSync('),
  source.indexOf('async function loadKnowledgeSyncStatus('),
);
const conflictSource = source.slice(
  source.indexOf('async function persistConflictDraft('),
  source.indexOf('const documentSaveRequests = new Map();'),
);

function createContext({ failure = '', draftResponse } = {}) {
  const editor = { value: '未保存的内容' };
  const current = { id: 'note:1', version: 2, content: '磁盘上的新内容' };
  const calls = { renders: 0, clears: 0, drafts: [], toasts: [], status: '' };
  const state = {
    activeDocument: { id: 'note:1', version: 1, content: '旧内容' },
    documentDirty: true,
    documentConflict: false,
    knowledgeSync: { enabled: true, generation: 2 },
    mode: 'knowledge',
  };
  const apiFetch = async (url, options) => {
    if (url.startsWith('/api/knowledge/documents/')) {
      return { ok: true, status: 200, json: async () => current };
    }
    assert.equal(url, '/api/knowledge/sync/drafts');
    calls.drafts.push(JSON.parse(options.body));
    if (failure === 'network') throw new Error('network unavailable');
    if (draftResponse) return draftResponse();
    if (failure) return { ok: false, status: Number(failure), json: async () => ({ error: `HTTP ${failure}` }) };
    return { ok: true, status: 200, json: async () => ({ id: 'draft:1', documentId: 'note:1' }) };
  };
  const context = vm.createContext({
    state,
    apiFetch,
    clearTimeout() {},
    currentDocumentPatch: () => ({ content: editor.value, baseVersion: state.activeDocument.version }),
    editorMatchesSubmitted: draft => draft.content === editor.value,
    setDocumentSaveState: value => { calls.status = value; },
    showToast: (message, type) => calls.toasts.push({ message, type }),
    getDiaryStatus: async () => ({ enabled: true, locked: false }),
    showEmptyDocument: () => {
      calls.clears += 1;
      editor.value = '';
      state.activeDocument = null;
    },
    renderActiveDocument: async document => {
      calls.renders += 1;
      editor.value = document.content;
      state.activeDocument = document;
      state.documentDirty = false;
      state.documentConflict = false;
    },
    loadKnowledgeTree: async () => {},
    loadDocuments: async () => {},
    loadKnowledgeSyncStatus: async () => {},
  });
  vm.runInContext(reconcileSource + conflictSource, context);
  return { context, state, editor, current, calls };
}

for (const flow of ['autosave conflict', 'folder sync']) {
  for (const failure of ['409', '500', 'network']) {
    test(`${flow} keeps unsaved input when draft persistence fails (${failure})`, async () => {
      const { context, state, editor, current, calls } = createContext({ failure });
      if (flow === 'autosave conflict') assert.equal(await context.resolveDocumentConflict(current), false);
      else await context.reconcileKnowledgeSync(1);
      assert.equal(editor.value, '未保存的内容');
      assert.equal(state.activeDocument.version, 1);
      assert.equal(state.documentDirty, true);
      assert.equal(state.documentConflict, true);
      assert.equal(calls.renders, 0);
      assert.equal(calls.status, '保存冲突');
      assert.equal(calls.drafts.length, 1);
      assert.equal(calls.toasts.some(item => item.message.includes('已放入冲突草稿')), false);
      assert.ok(calls.toasts.some(item => item.message.includes('当前输入仍在编辑器中')));
    });
  }
}

test('a confirmed conflict draft allows loading the newer file', async () => {
  const { context, state, editor, current, calls } = createContext();
  assert.equal(await context.resolveDocumentConflict(current), true);
  assert.equal(calls.drafts[0].draft.content, '未保存的内容');
  assert.equal(calls.renders, 1);
  assert.equal(editor.value, '磁盘上的新内容');
  assert.equal(state.activeDocument.version, 2);
});

test('a draft response without an id does not discard the editor', async () => {
  const { context, state, editor, current, calls } = createContext({
    draftResponse: () => ({ ok: true, status: 200, json: async () => ({}) }),
  });
  assert.equal(await context.resolveDocumentConflict(current), false);
  assert.equal(editor.value, '未保存的内容');
  assert.equal(state.documentConflict, true);
  assert.equal(calls.renders, 0);
});

test('folder sync ignores a response for a document that was left while loading', async () => {
  const { context, state, editor, current, calls } = createContext();
  let finishRead;
  context.apiFetch = async url => {
    assert.equal(url, '/api/knowledge/documents/note%3A1');
    return new Promise(resolve => { finishRead = resolve; });
  };
  const pending = context.reconcileKnowledgeSync(1);
  state.activeDocument = { id: 'note:2', version: 1, content: '另一个文档' };
  editor.value = '另一个文档的草稿';
  finishRead({ ok: true, status: 200, json: async () => current });
  await pending;
  assert.equal(editor.value, '另一个文档的草稿');
  assert.equal(state.activeDocument.id, 'note:2');
  assert.equal(calls.drafts.length, 0);
  assert.equal(calls.renders, 0);
});

test('external deletion retains unsaved note input when the server returns 404', async () => {
  const { context, state, editor, calls } = createContext();
  context.apiFetch = async () => ({ ok: false, status: 404, json: async () => ({ error: 'Document not found' }) });
  await context.reconcileKnowledgeSync(1);
  assert.equal(editor.value, '未保存的内容');
  assert.equal(state.activeDocument.id, 'note:1');
  assert.equal(state.documentDirty, true);
  assert.equal(state.documentConflict, true);
  assert.equal(calls.clears, 0);
  assert.equal(calls.status, '保存冲突');
});

test('a locked diary is hidden even if the document request returns 404', async () => {
  const { context, state, editor, calls } = createContext();
  state.activeDocument.visibility = 'diary';
  context.getDiaryStatus = async () => ({ enabled: true, locked: true });
  context.apiFetch = async () => ({ ok: false, status: 404, json: async () => ({ error: 'Document not found' }) });
  await context.reconcileKnowledgeSync(1);
  assert.equal(calls.clears, 1);
  assert.equal(state.activeDocument, null);
  assert.equal(editor.value, '');
});
