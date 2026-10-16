const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createTempDatabase } = require('./db-temp');
const { createKnowledgeService } = require('../lib/knowledge/documents');
const { createSearchIndex } = require('../lib/knowledge/search');
const { migrateFileWorkspace } = require('../lib/knowledge/file-workspace-migration');
const { createReadingPositionStore } = require('../lib/knowledge/reading-position-state');
const { readingTime } = require('../lib/knowledge/reading-time');
const base = doc => ({ baseVersion: doc.version, baseFingerprint: doc.baseFingerprint });
async function fixture(t) {
  const { db, dir } = createTempDatabase(t, 'file-service-');
  const root = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'file-root-'));
  const service = createKnowledgeService(db, { fileWorkspaceRoot: root, startFolderSync: false });
  await service.ready;
  await service.backgroundReady;
  t.after(async () => { await service.folderSync.shutdown(); await fs.rm(root, { recursive: true, force: true }); });
  return { db, dir, root, service };
}
test('tree membership never reads cached bodies and preserves root/archive/annotation visibility', async t => {
  const { service, db } = await fixture(t);
  const records = [
    { id: 'note:root', relativePath: 'root.md', status: 'active' },
    { id: 'note:deep', relativePath: 'Base/a/b/deep.md', status: 'active' },
    { id: 'note:old', relativePath: '.archive/Base/old.md', status: 'archived' },
    { id: 'note:deleted', relativePath: 'Base/deleted.md', status: 'deleted' },
    { id: 'note:annotation', relativePath: 'Base/a/note.md', status: 'active', documentRole: 'annotation' },
  ];
  for (const record of records) service.workspace.records.set(record.id, record);
  const prepare = db.sqlite.prepare;
  db.sqlite.prepare = () => { throw new Error('tree must not query SQLite bodies'); };
  try {
    assert.deepEqual(service.listDocumentTreeLocations(), [
      { knowledgeBase: ':root:', folderPath: '', collectionPath: ':root:', fileSync: { relativePath: 'root.md' } },
      { knowledgeBase: 'Base', folderPath: 'a/b', collectionPath: 'Base/a/b', fileSync: { relativePath: 'Base/a/b/deep.md' } },
    ]);
  } finally { db.sqlite.prepare = prepare; service.workspace.records.clear(); }
});

test('directory listing migration uses an index and preserves pinned and stable timestamp ordering', async t => {
  const { db, service } = await fixture(t);
  const insert = db.sqlite.prepare('INSERT INTO knowledge_documents(id, body) VALUES (?, ?)');
  for (const [id, pinnedAt] of [['note:1', ''], ['note:2', '2026-10-01'], ['note:3', '']]) {
    insert.run(id, JSON.stringify({ id, sourceType: 'note', status: 'active', knowledgeBase: 'Base', folderPath: 'child',
      collectionPath: 'Base/child', pinnedAt, updatedAt: '2026-10-01T00:00:00Z', content: 'body' }));
  }
  const page = service.listDocumentPage({ knowledgeBase: 'Base', folder: 'child' }, { pinSort: true });
  assert.deepEqual(page.documents.map(document => document.id), ['note:2', 'note:1', 'note:3']);
  const plan = db.sqlite.prepare(`EXPLAIN QUERY PLAN SELECT body FROM knowledge_documents
    WHERE COALESCE(NULLIF(json_extract(body, '$.status'), ''), 'active') = ?
      AND json_extract(body, '$.knowledgeBase') = ? AND COALESCE(json_extract(body, '$.folderPath'), '') = ?
    ORDER BY COALESCE(json_extract(body, '$.pinnedAt'), '') DESC,
      COALESCE(json_extract(body, '$.updatedAt'), json_extract(body, '$.createdAt'), '') DESC, rowid ASC LIMIT 60`).all('active', 'Base', 'child');
  assert.ok(plan.some(row => row.detail.includes('idx_knowledge_documents_directory_list')));
  assert.ok(plan.every(row => !row.detail.includes('TEMP B-TREE')));
});
test('file workspace becomes ready before the first full indexing pass completes', async t => {
  const { db } = createTempDatabase(t, 'file-startup-ready-');
  const root = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'file-startup-root-'));
  for (let index = 0; index < 40; index += 1) await fs.writeFile(path.join(root, `Note-${index}.md`), `startup ${index}`);
  const service = createKnowledgeService(db, { fileWorkspaceRoot: root, startFolderSync: false });
  t.after(async () => { await service.folderSync.shutdown(); await fs.rm(root, { recursive: true, force: true }); });
  let backgroundFinished = false;
  service.backgroundReady.then(() => { backgroundFinished = true; });
  await service.ready;
  assert.equal(backgroundFinished, false);
  assert.equal(service.workspace.scanStatus, 'scanning');
  await service.backgroundReady;
  assert.equal(service.workspace.records.size, 40);
});
test('file knowledge service saves disk originals and exposes an index-compatible search', async t => {
  const { service, root } = await fixture(t);
  const created = await service.createNote({ title: 'Hello', content: 'firstalpha', relativePath: 'Hello.md' });
  assert.equal(created.document.content, 'firstalpha');
  await fs.writeFile(path.join(root, 'Hello.md'), 'externalomega');
  const current = await service.getDocument(created.document.id);
  assert.equal(current.content, 'externalomega');
  await service.workspace.flushIndex();
  const search = createSearchIndex(service); t.after(() => search.dispose());
  assert.ok(search.searchDocuments('externalomega').some(doc => doc.id === current.id));
  const conflict = await service.updateDocument(current.id, { ...base(created.document), content: 'stale' });
  assert.equal(conflict.status, 409);
  const saved = await service.updateDocument(current.id, { ...base(current), content: 'savedbeta' });
  assert.equal(saved.document.content, 'savedbeta');
  await service.workspace.flushIndex();
  assert.ok(search.searchDocuments('savedbeta').some(doc => doc.id === current.id));
});
test('file observations persist as rebuildable SQLite metadata', async t => {
  const { db, service } = await fixture(t);
  const created = (await service.createNote({ title: 'Observed', content: 'cached state', relativePath: 'Observed.md' })).document;
  const row = db.sqlite.prepare('SELECT relative_path, fingerprint, file_state FROM knowledge_file_observations WHERE document_id = ?').get(created.id);
  assert.equal(row.relative_path, created.relativePath);
  assert.equal(row.fingerprint, created.baseFingerprint);
  assert.equal(JSON.parse(row.file_state).size, Buffer.byteLength('cached state'));
});
test('named history reads external content and restores via a guarded file save', async t => {
  const { service, root } = await fixture(t);
  let document = (await service.createNote({ title: 'History', content: 'first' })).document;
  await fs.writeFile(path.join(root, document.relativePath), 'external');
  document = await service.getDocument(document.id);
  const revision = await service.createNamedRevision(document.id, { ...base(document), name: 'snapshot' });
  assert.equal(revision.revision.snapshot.content, 'external');
  document = (await service.updateDocument(document.id, { ...base(document), content: 'second' })).document;
  const restored = await service.restoreRevision(document.id, revision.revision.id, base(document));
  assert.equal(restored.document.content, 'external');
});
test('migration preserves stable ids and disk content, records divergent database recovery, and is resumable', async t => {
  const { db, dir } = createTempDatabase(t, 'file-migration-');
  const root = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'file-migrate-root-'));
  const backup = `${root}-backup`;
  const legacy = createKnowledgeService(db, { startFolderSync: false });
  const doc = legacy.createNote({ title: 'Legacy', content: 'database' }).document;
  legacy.cacheFileDocument({ ...doc, fileSync: { relativePath: 'Legacy.md' } });
  await fs.writeFile(path.join(root, 'Legacy.md'), 'disk');
  await legacy.folderSync.stop();
  const report = await migrateFileWorkspace(db, { root, backupPath: backup });
  assert.equal(report.conflicts.length, 1);
  assert.equal(await fs.readFile(path.join(root, report.conflicts[0].recoveryPath), 'utf8'), 'database');
  const again = await migrateFileWorkspace(db, { root, backupPath: backup });
  assert.equal(again.completed.length, 1);
  const service = createKnowledgeService(db, { startFolderSync: false });
  t.after(async () => {
    await service.folderSync.shutdown();
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(backup, { recursive: true, force: true });
  });
  assert.equal((await service.getDocument(doc.id)).content, 'disk');
  await service.backgroundReady;
  assert.ok(await fs.stat(path.join(dir, '.knowledge-file-workspace.json')));
});
test('migration archives duplicate path identities and repairs a partially migrated sidecar', async t => {
  const { db, dir } = createTempDatabase(t, 'file-migration-duplicates-');
  const root = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'file-migrate-duplicates-'));
  const backup = `${root}-backup`;
  await fs.mkdir(backup);
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); await fs.rm(backup, { recursive: true, force: true }); });
  const legacy = createKnowledgeService(db, { startFolderSync: false });
  const first = legacy.createNote({ title: 'Duplicate one', content: 'first body' }).document;
  const second = legacy.createNote({ title: 'Canonical', content: 'second body' }).document;
  for (const document of [first, second]) legacy.cacheFileDocument({ ...document, fileSync: { relativePath: 'shared.md' } });
  await fs.writeFile(path.join(root, 'shared.md'), 'disk canonical');
  await fs.mkdir(path.join(root, '.liuxu'), { recursive: true });
  await fs.writeFile(path.join(root, '.liuxu', 'manifest.json'), JSON.stringify({ documents: {
    [first.id]: { relativePath: 'shared.md' },
    [second.id]: { relativePath: 'shared.md' },
  } }));

  const { FileWorkspace, digest } = require('../lib/knowledge/file-workspace');
  const workspace = await new FileWorkspace({ root }).open();
  const disk = await fs.readFile(path.join(root, 'shared.md'));
  await workspace.persist({ id: first.id, relativePath: 'shared.md', sourceType: 'note', version: 1,
    fingerprint: digest(disk), status: 'active', title: 'Duplicate one', tags: [], documentRole: 'normal' });
  await workspace.close();
  await fs.writeFile(path.join(dir, '.file-workspace-migration.json'), JSON.stringify({
    format: 'liuxu-file-workspace', version: 1, rootPath: root, backupPath: backup, completed: [first.id], conflicts: [],
  }));
  const report = await migrateFileWorkspace(db, { root, backupPath: backup });
  assert.equal(report.resolvedDuplicates.length, 1);
  assert.equal(report.resolvedDuplicates[0].id, second.id);
  assert.equal(await fs.readFile(path.join(root, 'shared.md'), 'utf8'), 'disk canonical');
  assert.equal(await fs.readFile(path.join(root, report.resolvedDuplicates[0].archivedPath), 'utf8'), 'second body');
  const metadata = JSON.parse(await fs.readFile(path.join(root, '.liuxu', 'documents',
    require('../lib/knowledge/file-workspace').recordName(second.id)), 'utf8'));
  assert.equal(metadata.status, 'archived');
  assert.equal(metadata.relativePath, report.resolvedDuplicates[0].archivedPath);
  assert.ok(report.completed.includes(first.id));
  assert.ok(report.completed.includes(second.id));
  await legacy.folderSync.shutdown();
});
test('file-workspace ZIP replacement and merge preserve originals without overwriting matching paths', async t => {
  const { db, dir, service, root } = await fixture(t);
  const { FORMAT, VERSION } = require('../lib/knowledge/file-workspace');
  await service.workspace.json('.liuxu/storage.json', { format: FORMAT, version: VERSION });
  await fs.writeFile(path.join(dir, '.knowledge-file-workspace.json'), JSON.stringify({ format: FORMAT, version: VERSION, rootPath: root }));
  await fs.writeFile(path.join(dir, '.knowledge-folder.json'), JSON.stringify({ enabled: true, rootPath: root }));
  const doc = (await service.createNote({ relativePath: 'same.md', content: 'original' })).document;
  const book = (await service.saveImportedFile({ buffer: Buffer.from('ebook original'), filename: 'same.epub', title: 'Same book' })).document;
  const initialReading = await service.getReadingData(book.id);
  const excerpt = { id: 'keep-this-id', type: 'highlight', anchor: 'epubcfi(/6/2!/4)', fingerprint: initialReading.fingerprint, quote: '摘录正文', note: '我的想法' };
  const readingUpdate = await service.updateReadingData(book.id, { ...initialReading, baseRevision: initialReading.revision, entries: [excerpt] });
  assert.ok(readingUpdate.readingData);
  createReadingPositionStore(dir).set({ documentId: book.id, record: { sourceType: 'file', kind: 'ebook', position: { anchor: 'epubcfi(/6/2!/4)' } } });
  readingTime(db.sqlite, book.id, { sessionId: 'reader-session', sequence: 1, milliseconds: 90000 });
  await service.workspace.flushIndex();
  assert.equal(Object.hasOwn(JSON.parse(db.sqlite.prepare('SELECT body FROM knowledge_documents WHERE id=?').get(book.id).body), 'readingData'), false);
  const oldFingerprint = readingUpdate.readingData.fingerprint;
  await fs.writeFile(path.join(root, book.relativePath), 'ebook replaced externally');
  const replaced = await service.getDocument(book.id);
  const retainedReading = await service.getReadingData(book.id);
  assert.notEqual(replaced.baseFingerprint, oldFingerprint);
  assert.equal(retainedReading.entries[0].id, excerpt.id);
  assert.equal(retainedReading.entries[0].fingerprint, oldFingerprint);
  service.removeFileIndex(book.id);
  assert.equal(JSON.parse(db.sqlite.prepare('SELECT body FROM knowledge_documents WHERE id=?').get(book.id).body).status, 'deleted');
  assert.equal((await service.getReadingData(book.id)).entries[0].id, excerpt.id);
  assert.equal(createReadingPositionStore(dir).get({ documentId: book.id }).position.anchor, 'epubcfi(/6/2!/4)');
  assert.equal(readingTime(db.sqlite, book.id).milliseconds, 90000);
  await service.workspace.scan(); await service.workspace.flushIndex();
  assert.equal(Object.hasOwn(JSON.parse(db.sqlite.prepare('SELECT body FROM knowledge_documents WHERE id=?').get(book.id).body), 'readingData'), false);
  const manual = await service.createNamedRevision(doc.id, { ...base(doc), name: 'original snapshot' });
  const store = require('../lib/agent/store').createAgentStore(db);
  const bound = store.createSession('Original assistant', { documentId: doc.id });
  store.saveSession({ ...bound, messages: [{ role: 'user', content: 'My document question', documentId: doc.id }] });
  const { exportWorkspace, restoreWorkspace } = require('../lib/workspace/zip');
  const archive = await exportWorkspace(db);
  await fs.writeFile(path.join(root, 'same.md'), 'later');
  await restoreWorkspace(db, archive, 'replace');
  assert.equal(await fs.readFile(path.join(root, 'same.md'), 'utf8'), 'original');
  const fresh = require('../lib/knowledge/routes').serviceFor(db).knowledge;
  await fresh.ready;
  await fresh.backgroundReady;
  assert.equal((await fresh.getReadingData(book.id)).entries[0].id, excerpt.id);
  assert.equal(createReadingPositionStore(dir).get({ documentId: book.id }).position.anchor, 'epubcfi(/6/2!/4)');
  assert.equal(readingTime(db.sqlite, book.id).milliseconds, 90000);
  await fresh.updateDocument(doc.id, { ...base(await fresh.getDocument(doc.id)), content: 'existing' });
  await restoreWorkspace(db, archive, 'merge');
  const merged = require('../lib/knowledge/routes').serviceFor(db).knowledge;
  await merged.ready;
  await merged.backgroundReady;
  assert.equal((await merged.getDocument(doc.id)).content, 'existing');
  const imported = merged.allDocuments().find(item => item.id !== doc.id && item.content === 'original');
  assert.ok(imported); assert.ok(imported.relativePath.startsWith('导入-'));
  assert.ok(merged.listRevisions(imported.id).revisions.some(item => item.name === manual.revision.name));
  const importedBound = db.sqlite.prepare('SELECT * FROM agent_sessions WHERE document_id = ?').get(imported.id);
  assert.ok(importedBound); assert.notEqual(importedBound.id, bound.id);
  const message = JSON.parse(db.sqlite.prepare('SELECT body FROM agent_messages WHERE session_id = ?').get(importedBound.id).body);
  assert.equal(message.documentId, imported.id);
  const importedBook = merged.allDocuments().find(item => item.id !== book.id && item.fileMeta?.filename === 'same.epub');
  assert.ok(importedBook);
  const importedReading = await merged.getReadingData(importedBook.id);
  assert.equal(importedReading.entries[0].id, excerpt.id);
  assert.equal(importedReading.entries[0].fingerprint, oldFingerprint);
  assert.equal(importedReading.revision, readingUpdate.readingData.revision);
  assert.equal(createReadingPositionStore(dir).get({ documentId: importedBook.id }).position.anchor, 'epubcfi(/6/2!/4)');
  assert.equal(readingTime(db.sqlite, importedBook.id).milliseconds, 90000);
  t.after(() => require('../lib/knowledge/routes').shutdownKnowledgeServices());
  for (const filename of await fs.readdir(path.dirname(root))) if (filename.startsWith(`${path.basename(root)}.restore-bak-`)) {
    t.after(() => fs.rm(path.join(path.dirname(root), filename), { recursive: true, force: true }));
  }
});
test('removing a file index retains manual history and excludes tombstones from searches', async t => {
  const { service } = await fixture(t);
  const doc = (await service.createNote({ relativePath: 'history.md', content: 'historyword' })).document;
  const history = await service.createNamedRevision(doc.id, { ...base(doc), name: 'keep' });
  await service.workspace.flushIndex();
  const search = createSearchIndex(service); t.after(() => search.dispose());
  assert.ok(search.searchDocuments('historyword').length);
  await service.deleteDocument(doc.id, base(doc));
  assert.equal(search.searchDocuments('historyword').length, 0);
  assert.equal(service.listRevisions(doc.id).revisions.some(item => item.id === history.revision.id), true);
});
test('inline uploads are copied next to the note and saved as relative image references', async t => {
  const { service, root, dir } = await fixture(t);
  await fs.mkdir(path.join(dir, 'uploads'));
  await fs.writeFile(path.join(dir, 'uploads', 'example.png'), Buffer.from('image'));
  const doc = (await service.createNote({ relativePath: 'folder/note.md', content: '' })).document;
  const saved = await service.updateDocument(doc.id, { ...base(doc), content: '![image](/uploads/example.png)' });
  assert.equal(saved.document.content, '![image](./example.png)');
  assert.equal(await fs.readFile(path.join(root, 'folder', 'example.png'), 'utf8'), 'image');
});
test('file imports copy from a staged source and read the workspace original', async t => {
  const { service, root, dir } = await fixture(t);
  const source = path.join(dir, 'upload.pdf'); await fs.writeFile(source, Buffer.from('pdf original'));
  const imported = await service.saveImportedFile({ sourceFilePath: source, filename: 'example.pdf' });
  assert.equal(await fs.readFile(path.join(root, imported.document.relativePath), 'utf8'), 'pdf original');
  assert.equal(service.filePathFor(imported.document), path.join(root, imported.document.relativePath));
});
test('HTTP file routes require original baselines and immediately observe external changes', async t => {
  const { db, dir, root } = await fixture(t);
  const { FORMAT, VERSION } = require('../lib/knowledge/file-workspace');
  await fs.writeFile(path.join(dir, '.knowledge-file-workspace.json'), JSON.stringify({ format: FORMAT, version: VERSION, rootPath: root }));
  const express = require('express'); const app = express(); app.use(express.json());
  const { registerKnowledgeRoutes, serviceFor, shutdownKnowledgeServices } = require('../lib/knowledge/routes');
  registerKnowledgeRoutes(app, { db });
  const http = await new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
  t.after(async () => { await new Promise(resolve => http.close(resolve)); await shutdownKnowledgeServices(); });
  const url = `http://127.0.0.1:${http.address().port}/api/knowledge`;
  const createdResponse = await fetch(`${url}/documents`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ relativePath: 'file.md', content: 'first' }) });
  assert.equal(createdResponse.status, 201); const document = await createdResponse.json();
  const patch = async input => fetch(`${url}/documents/${document.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  assert.equal((await patch({ content: 'missing' })).status, 400);
  await fs.writeFile(path.join(root, 'file.md'), 'outside');
  assert.equal((await (await fetch(`${url}/documents/${document.id}`)).json()).content, 'outside');
  assert.equal((await patch({ ...base(document), content: 'stale' })).status, 409);
  const current = await serviceFor(db).knowledge.getDocument(document.id);
  assert.equal((await patch({ ...base(current), content: 'current' })).status, 200);
  const rebuild = await fetch(`${url}/index/rebuild`, { method: 'POST' }); assert.equal(rebuild.status, 200);
});
test('note creation never treats extra arguments as a local-file import', async t => {
  const { service, dir } = await fixture(t);
  const source = path.join(dir, 'private.txt'); await fs.writeFile(source, 'private bytes');
  const result = await service.createNote({ title: 'Safe', content: 'requested content', sourceFilePath: source, sourceType: 'file', id: 'note:999' });
  assert.equal(result.document.content, 'requested content');
  assert.equal(result.document.sourceType, 'note'); assert.notEqual(result.document.id, 'note:999');
});

test('Agent approval retains the original fingerprint when disk changes while waiting', async t => {
  const { service, db, root } = await fixture(t);
  const document = (await service.createNote({ relativePath: 'approval.md', content: 'first' })).document;
  const { createAgentStore } = require('../lib/agent/store');
  const { createMemoryService } = require('../lib/agent/memory');
  const { createRuntime } = require('../lib/agent/runtime');
  const store = createAgentStore(db); const memory = createMemoryService(store);
  const original = { id: document.id, ...base(document), content: 'Agent replacement' };
  let round = 0;
  const runtime = createRuntime({ db, store, memory, knowledgeSearch: { knowledge: service }, modelClient: {
    async complete() { return ++round === 1 ? { text: '', toolCalls: [{ name: 'knowledge.update', arguments: original }] } : { text: 'Finished', toolCalls: [] }; },
  } });
  const run = await runtime.start({ session: store.createSession('file approval'), goal: 'edit', userMessage: 'edit' });
  for (let attempt = 0; attempt < 100 && store.getRun(run.id).status !== 'waiting_approval'; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  const waiting = store.getRun(run.id);
  assert.equal(waiting.status, 'waiting_approval');
  assert.deepEqual(waiting.pendingApprovals[0].call.arguments, original);
  await fs.writeFile(path.join(root, 'approval.md'), 'external while waiting');
  await runtime.resolveApproval(run.id, waiting.pendingApprovals[0].id, { approved: true });
  assert.equal(await fs.readFile(path.join(root, 'approval.md'), 'utf8'), 'external while waiting');
});

test('rebuild restores deleted cache rows and survives a service restart', async t => {
  const { db, root, service } = await fixture(t);
  const doc = (await service.createNote({ relativePath: 'keep.md', content: 'rebuild-search-token' })).document;
  await service.workspace.flushIndex();
  await service.rebuildIndex();
  assert.equal(service.listDocumentPage({}).total, 1);
  assert.equal(service.allDocuments().find(item => item.id === doc.id).content, 'rebuild-search-token');
  await service.folderSync.shutdown();
  const reopened = createKnowledgeService(db, { fileWorkspaceRoot: root, startFolderSync: false });
  try {
    await reopened.backgroundReady;
    assert.equal(reopened.listDocumentPage({}).total, 1);
    assert.equal((await reopened.getDocument(doc.id)).content, 'rebuild-search-token');
  } finally { await reopened.folderSync.shutdown(); }
});
