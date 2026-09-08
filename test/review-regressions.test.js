const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const vm = require('node:vm');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'liuxu-regressions-'));
process.env.DATA_DIR = path.join(root, 'default');
process.env.AI_SECRETS_KEY_FILE = path.join(root, 'key');
const { createDatabase } = require('../database');
const { createKnowledgeService } = require('../lib/knowledge/documents');
const { createAgentStore } = require('../lib/agent/store');
const { createRuntime } = require('../lib/agent/runtime');
const { createMemoryService } = require('../lib/agent/memory');
const { restoreWorkspace, exportWorkspace } = require('../lib/workspace/zip');
const JSZip = require('jszip');
const tick = () => new Promise(resolve => setImmediate(resolve));
function dbFor(t) { const db = createDatabase(fs.mkdtempSync(path.join(root, 'db-'))); t.after(() => db.close()); return db; }
function runtimeFor(db, complete) { const store = createAgentStore(db); return { store, runtime: createRuntime({ db, store, memory: createMemoryService(store), modelClient: { complete }, hasDiaryAccessFlag: false }) }; }
test.after(() => { require('../lib/db/connection').closeAllDatabases(); fs.rmSync(root, { recursive: true, force: true }); });

test('real extension verifier accepts server signature and rejects changed arguments/signature', async () => {
  const src = fs.readFileSync(path.join(__dirname, '../chrome-extension/background.js'), 'utf8');
  const context = vm.createContext({ crypto: crypto.webcrypto, TextEncoder, Uint8Array, chrome: { storage: { local: { get: async () => ({ liuxuPairingKey: 'ab'.repeat(32) }) } } } });
  vm.runInContext(src.slice(src.indexOf('const PAIRING_KEY_STORAGE'), src.indexOf('async function detachTab')), context);
  context.command = { name: 'browser.scan', args: {}, nonce: 'regression-nonce' };
  context.command.signature = require('../lib/computer/chrome').sign('ab'.repeat(32), context.command.nonce, { name: context.command.name, args: context.command.args });
  assert.equal(await vm.runInContext('verifyAgentCommand(command)', context), true);
  context.command.args = { tampered: true };
  assert.equal(await vm.runInContext('verifyAgentCommand(command)', context), false);
  context.command.args = {}; context.command.signature = '00'.repeat(32);
  assert.equal(await vm.runInContext('verifyAgentCommand(command)', context), false);
});

for (const stale of [false, true]) test(`legacy ZIP imports structures and knowledge independently of leftover JSON (${stale})`, async t => {
  const db = dbFor(t); const zip = new JSZip();
  if (stale) fs.writeFileSync(path.join(db.dataDir, 'todos.json'), JSON.stringify([{ id: 99, title: 'stale' }]));
  zip.file('workspace.json', JSON.stringify({ ...db.backup(), todos: [{ id: 1, title: 'restored', done: false }] }));
  zip.file('knowledge-documents.json', JSON.stringify({ documents: [{ id: 'note:1', sourceType: 'note', title: 'legacy note', content: 'body', version: 1 }], nextNoteId: 2 }));
  await restoreWorkspace(db, await zip.generateAsync({ type: 'nodebuffer' }));
  assert.deepEqual(db.getAllTodos().map(item => item.title), ['restored']);
  assert.equal(createKnowledgeService(db).getDocument('note:1').content, 'body');
});

test('native ZIP ignores oversized redundant JSON for replacement and merge', async t => {
  const source = dbFor(t); const knowledge = createKnowledgeService(source);
  for (let i = 0; i < 22; i++) knowledge.createNote({ title: `large ${i}`, content: 'x'.repeat(490000) });
  const backup = await exportWorkspace(source);
  const zip = await JSZip.loadAsync(backup);
  assert.ok((await zip.file('knowledge-documents.json').async('nodebuffer')).length > 10 * 1024 * 1024);
  for (const mode of ['replace', 'merge']) {
    const target = dbFor(t); await restoreWorkspace(target, backup, mode);
    assert.equal(createKnowledgeService(target).nativeDocuments().length, 22);
  }
});

test('export rejects attachments larger than the restore limit', async t => {
  const db = dbFor(t); fs.mkdirSync(path.join(db.dataDir, 'uploads'), { recursive: true });
  fs.writeFileSync(path.join(db.dataDir, 'uploads', 'huge.bin'), Buffer.alloc(30 * 1024 * 1024 + 1));
  await assert.rejects(exportWorkspace(db), /too large/);
});

test('database replacement discards same-version persisted search index', async t => {
  const target = dbFor(t), source = dbFor(t); const routes = require('../lib/knowledge/routes');
  const old = routes.serviceFor(target); old.knowledge.createNote({ title: 'OLDORANGE', content: 'OLDORANGE' }); old.search.searchDocuments('OLDORANGE');
  routes.serviceFor(source).knowledge.createNote({ title: 'NEWBANANA', content: 'NEWBANANA' });
  await restoreWorkspace(target, await exportWorkspace(source));
  const fresh = routes.serviceFor(target);
  assert.equal(fresh.search.searchDocuments('NEWBANANA').length, 1);
  assert.equal(fresh.search.searchDocuments('OLDORANGE').length, 0);
});

test('file diary move hides annotation and synchronizes its version and images', t => {
  const db = dbFor(t), knowledge = createKnowledgeService(db);
  const file = knowledge.saveImportedFile({ buffer: Buffer.from('file'), filename: 'sample.txt', mimeType: 'text/plain', text: 'file', diaryUnlocked: true }).document;
  const annotation = knowledge.upsertAnnotation(file.id, { content: 'secret ![](/uploads/secret.png)' }, { diaryUnlocked: true }).document;
  knowledge.updateDocument(file.id, { knowledgeBase: '日记' }, { diaryUnlocked: true });
  assert.equal(knowledge.getDocument(file.id), null);
  assert.equal(knowledge.getDocument(annotation.id), null);
  const privateNote = knowledge.getDocument(annotation.id, { diaryUnlocked: true });
  assert.equal(privateNote.knowledgeBase, '日记'); assert.ok(privateNote.version > annotation.version);
  assert.ok(db.isPrivateUpload('secret.png'));
});

test('delegated repeated questions resume each child and parent only once', async t => {
  const db = dbFor(t); let parentCalls = 0, childCalls = 0;
  const { store, runtime } = runtimeFor(db, async ({ goal }) => goal === 'child'
    ? (++childCalls <= 2 ? { toolCalls: [{ name: 'ask_user', arguments: { question: `detail ${childCalls}?` } }] } : { text: 'child final' })
    : (++parentCalls === 1 ? { toolCalls: [{ name: 'agent.delegate', arguments: { prompt: 'child' } }] } : { text: 'parent final' }));
  const run = await runtime.start({ session: store.createSession('parent'), goal: 'parent', userMessage: 'parent' }); await tick();
  await runtime.resolveApproval(run.id, run.pendingApprovals[0].id, { approved: true });
  await runtime.resumeUserInput(run.id, 'one'); assert.equal(store.getRun(run.id).status, 'waiting_user');
  await runtime.resumeUserInput(run.id, 'two');
  assert.equal(parentCalls, 2); assert.equal(childCalls, 3);
  assert.equal(store.getRun(run.id).events.filter(e => e.type === 'run.completed').length, 1);
  await runtime.resumeUserInput(run.id, 'duplicate'); assert.equal(parentCalls, 2); assert.equal(childCalls, 3);
});

test('autosave drains edits made during delayed request and keeps failed input', async () => {
  const src = fs.readFileSync(path.join(__dirname, '../public/js/workbench.js'), 'utf8');
  const sent = []; const requests = []; const field = { value: 'first', selectionStart: 0, setSelectionRange() {} };
  const context = { state: { activeDocument: { id: 'note:A', version: 1 }, documentDirty: true }, clearTimeout() {}, setDocumentSaveState() {}, showToast() {}, $: () => field,
    currentDocumentPatch: () => ({ content: field.value, baseVersion: context.state.activeDocument.version }),
    editorMatchesSubmitted: patch => patch.content === field.value, scheduleDocumentSave() {}, knowledgeEnhancements: null, updateDocumentSummary() {}, loadKnowledgeTree: async () => {}, loadDocuments: async () => {},
    resolveDocumentConflict: async () => { context.state.documentConflict = true; return false; },
    apiFetch: async (url, options) => { sent.push(JSON.parse(options.body)); return new Promise(resolve => requests.push(resolve)); } };
  vm.createContext(context);
  vm.runInContext(src.slice(src.indexOf('const documentSaveRequests'), src.indexOf('let noteMutationLock')) + src.slice(src.indexOf('async function flushPendingSaves'), src.indexOf('async function createNote')), context);
  const first = vm.runInContext('saveDocument()', context); field.value = 'second'; let flushed = false;
  const flush = vm.runInContext('flushPendingSaves()', context).then(value => { flushed = true; return value; }); await tick(); assert.equal(flushed, false);
  requests.shift()({ ok: true, status: 200, json: async () => ({ id: 'note:A', content: 'first', version: 2 }) }); await first; await tick();
  assert.equal(sent[1].content, 'second'); assert.equal(sent[1].baseVersion, 2);
  requests.shift()({ ok: true, status: 200, json: async () => ({ id: 'note:A', content: 'second', version: 3 }) }); assert.equal(await flush, true);
  for (const status of [500, 409]) {
    field.value = 'unsaved'; context.state.documentDirty = true;
    const failure = vm.runInContext('flushPendingSaves()', context); await tick(); requests.shift()({ ok: false, status, json: async () => ({ error: 'failed' }) });
    assert.equal(await failure, false); assert.equal(field.value, 'unsaved'); assert.equal(context.state.documentDirty, true);
  }
});

for (const status of [400, 404, 500]) test(`todo failed HTTP ${status} preserves form and reports error`, async () => {
  const src = fs.readFileSync(path.join(__dirname, '../public/js/todos.js'), 'utf8');
  let reset = false; const toasts = [];
  const context = { $: () => ({ value: 'unsaved task' }), DEFAULT_TODO_CATEGORY: '默认', rawApiFetch: async () => ({ ok: false, status, json: async () => ({ error: 'write failed' }) }), showToast: (message, type) => toasts.push({ message, type }), resetTodoForm: () => { reset = true; }, loadTodos: async () => {} };
  vm.createContext(context);
  vm.runInContext(src.slice(src.indexOf('async function apiFetch'), src.indexOf('\n}', src.indexOf('async function apiFetch')) + 2) + src.slice(src.indexOf('async function saveTodoFromFullForm'), src.indexOf('function openTodoCategoryModal')), context);
  await vm.runInContext('saveTodoFromFullForm()', context);
  assert.equal(reset, false); assert.equal(toasts.some(item => item.type === 'success'), false); assert.match(toasts.at(-1).message, /write failed/);
});

test('editor mutation bridge locks only after draft save and reconciles success, conflict, archive and deletion', async () => {
  const src = fs.readFileSync(path.join(__dirname, '../public/js/workbench.js'), 'utf8');
  const control = { disabled: false, closest: () => null }; let saveOkay = false; let refreshed = 0; let exited = 0;
  let response = { ok: true, status: 200, json: async () => ({ id: 'note:A', content: 'changed', status: 'active' }) };
  const context = { state: { activeDocument: { id: 'note:A' }, documentDirty: false }, document: { querySelectorAll: () => [control] },
    flushPendingSaves: async () => saveOkay, apiFetch: async () => response,
    renderActiveDocument: async () => { refreshed++; }, showEmptyDocument: () => { exited++; }, loadKnowledgeTree: async () => {}, loadDocuments: async () => {} };
  vm.createContext(context); vm.runInContext(src.slice(src.indexOf('let noteMutationLock'), src.indexOf('async function flushPendingSaves')), context);
  assert.equal(await vm.runInContext("beforeNoteMutation('note:A')", context), false); assert.equal(control.disabled, false);
  saveOkay = true;
  await vm.runInContext("beforeNoteMutation('note:A')", context); assert.equal(control.disabled, true);
  await vm.runInContext("afterNoteMutation('note:A', {disconnected: true})", context); assert.equal(control.disabled, true, 'uncertain write stays locked across disconnect');
  await vm.runInContext("afterNoteMutation('note:A', {result: {ok: true}})", context); assert.equal(control.disabled, false); assert.equal(refreshed, 1);
  await vm.runInContext("beforeNoteMutation('note:A')", context);
  await vm.runInContext("afterNoteMutation('note:A', {result: {ok: false}})", context); assert.equal(control.disabled, false); assert.equal(refreshed, 1, 'failed writes retain editor draft');
  for (const deleted of [false, true]) {
    response = { ok: !deleted, status: deleted ? 404 : 200, json: async () => ({ status: 'archived' }) };
    await vm.runInContext("beforeNoteMutation('note:A')", context);
    await vm.runInContext("afterNoteMutation('note:A', {result: {ok: true}})", context); assert.equal(control.disabled, false);
  }
  assert.equal(exited, 2);
});

test('invalid legacy payload is rejected before touching existing database or attachments', async t => {
  const db = dbFor(t); db.createTodo({ title: 'keep me' });
  const zip = new JSZip(); zip.file('workspace.json', JSON.stringify(db.backup())); zip.file('agent-sessions.json', JSON.stringify({ sessions: 'broken' }));
  zip.file('uploads/new.png', 'do not install');
  await assert.rejects(restoreWorkspace(db, await zip.generateAsync({ type: 'nodebuffer' })), /Invalid agent-sessions/);
  assert.equal(db.getAllTodos()[0].title, 'keep me'); assert.equal(fs.existsSync(path.join(db.dataDir, 'uploads/new.png')), false);
});

test('attachment installation failure rolls back the database and newly installed files', async t => {
  const source = dbFor(t), target = dbFor(t); target.createTodo({ title: 'original' }); source.createTodo({ title: 'replacement' });
  const zip = await JSZip.loadAsync(await exportWorkspace(source)); zip.file('uploads/first.txt', 'new'); zip.file('uploads/block/second.txt', 'new');
  fs.mkdirSync(path.join(target.dataDir, 'uploads'), { recursive: true }); fs.writeFileSync(path.join(target.dataDir, 'uploads/block'), 'existing file');
  await assert.rejects(restoreWorkspace(target, await zip.generateAsync({ type: 'nodebuffer' })));
  assert.equal(target.getAllTodos()[0].title, 'original'); assert.equal(fs.existsSync(path.join(target.dataDir, 'uploads/first.txt')), false);
  assert.equal(fs.readFileSync(path.join(target.dataDir, 'uploads/block'), 'utf8'), 'existing file');
});
