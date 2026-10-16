const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/js/workbench.js'), 'utf8');
const functions = source.slice(source.indexOf('async function loadFileAnnotation('), source.indexOf('\nasync function openKnowledgeDocument'));
function fixture(ok = true) {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const elements = Object.fromEntries(['fileAnnotationTitle', 'fileAnnotationContent', 'fileAnnotationState', 'saveFileAnnotation', 'fileExcerptSummary'].map(id => [`#${id}`, { value: id === 'fileAnnotationTitle' ? 'Title' : 'submitted' }]));
  const state = { activeDocument: { id: 'file:A', sourceType: 'file' }, fileAnnotation: { documentId: 'file:A', id: 'note:A', version: 1, title: 'Title', content: 'submitted', dirty: true }, fileAnnotationDrafts: new Map(), fileAnnotationSaving: new Set(), fileAnnotationLoadSerial: 0, fileAnnotationMode: 'edit' };
  state.fileAnnotationDrafts.set('file:A', state.fileAnnotation);
  const calls = [];
  const context = vm.createContext({ state, $: id => elements[id], showToast() {}, renderMarkdown: text => text,
    splitAnnotation: content => ({ personal: content, summary: '', valid: true }),
    apiFetch: async (_url, options) => {
      if (options) calls.push(JSON.parse(options.body));
      await gate;
      return { ok, json: async () => ({ annotation: { id: 'note:A', version: 2, baseFingerprint: 'saved-fingerprint', title: 'Title', content: 'submitted' }, error: 'save failed' }) };
    } });
  vm.runInContext(functions, context);
  return { context, state, elements, calls, release };
}
for (const ok of [true, false]) for (const switchFile of [true, false]) {
  test(`annotation keeps later edits after save (ok=${ok}, switch=${switchFile})`, async () => {
    const { context, state, elements, calls, release } = fixture(ok);
    const saving = context.saveFileAnnotation();
    elements['#fileAnnotationContent'].value = 'submitted plus later input';
    state.fileAnnotation = { ...state.fileAnnotation, content: 'submitted plus later input', dirty: true };
    state.fileAnnotationDrafts.set('file:A', state.fileAnnotation);
    if (switchFile) {
      state.activeDocument = { id: 'file:B', sourceType: 'file' };
      state.fileAnnotation = { documentId: 'file:B', title: 'B', content: 'other document', dirty: true };
      elements['#fileAnnotationContent'].value = 'other document';
      elements['#fileAnnotationState'].textContent = 'B state';
    }
    release(); await saving;
    assert.equal(calls[0].content, 'submitted');
    const draft = state.fileAnnotationDrafts.get('file:A');
    assert.equal(draft.content, 'submitted plus later input');
    assert.equal(draft.dirty, true);
    assert.equal(draft.version, ok ? 2 : 1);
    if (switchFile) {
      assert.equal(state.fileAnnotation.documentId, 'file:B');
      assert.equal(elements['#fileAnnotationState'].textContent, 'B state');
    } else {
      assert.equal(state.fileAnnotation.content, draft.content);
      assert.equal(state.fileAnnotation.dirty, true);
    }
    assert.equal(state.fileAnnotationSaving.size, 0);
  });
}
test('annotation load keeps edits made while its response is pending', async () => {
  const { context, state, elements, release } = fixture();
  state.fileAnnotationDrafts.clear();
  const loading = context.loadFileAnnotation('file:A');
  state.fileAnnotationDrafts.set('file:A', { ...state.fileAnnotation, content: 'new local draft' });
  release(); await loading;
  assert.equal(elements['#fileAnnotationContent'].value, 'new local draft');
  assert.equal(state.fileAnnotation.dirty, true);
});
test('annotation save prevents duplicate requests and clears only the submitted draft', async () => {
  const { context, state, elements, calls, release } = fixture();
  const saving = context.saveFileAnnotation();
  await context.saveFileAnnotation();
  release(); await saving;
  assert.equal(calls.length, 1);
  assert.equal(state.fileAnnotation.dirty, false);
  assert.equal(state.fileAnnotationDrafts.size, 0);
  assert.equal(elements['#saveFileAnnotation'].disabled, false);
});

test('returning to a file during save preserves its draft before annotation reload completes', async () => {
  const { context, state, elements, release } = fixture();
  const saving = context.saveFileAnnotation();
  state.fileAnnotationDrafts.set('file:A', { ...state.fileAnnotation, content: 'later draft' });
  // renderFileOriginalPanel resets the form when returning from another file.
  state.fileAnnotation = { documentId: 'file:A', id: '', title: '', content: '', dirty: false };
  elements['#fileAnnotationTitle'].value = '';
  elements['#fileAnnotationContent'].value = '';
  release(); await saving;
  assert.equal(state.fileAnnotation.content, 'later draft');
  assert.equal(state.fileAnnotation.dirty, true);
  assert.equal(elements['#fileAnnotationContent'].value, 'later draft');
  assert.equal(state.fileAnnotation.version, 2);
});
