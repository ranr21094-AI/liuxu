const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createDatabase } = require('../database');
const { createKnowledgeService } = require('../lib/knowledge/documents');
const { cleanupTempDataDir } = require('./db-temp');
const { exportWorkspace, restoreWorkspace } = require('../lib/workspace/zip');
const storage = require('../lib/knowledge/revision-storage');
const textFile = require('../lib/knowledge/text-file');

function setup(t, content = '第一行\r\n第二行\n第三行\r尾行😀\n', filename = 'source.txt') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'text-file-history-'));
  const db = createDatabase(dir);
  const k = createKnowledgeService(db, { startFolderSync: false });
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const doc = k.saveImportedFile({ buffer: bytes, filename, text: '这是截断或转换过的搜索文字', mimeType: 'text/plain' }).document;
  t.after(() => { k.folderSync.stop(); db.close(); cleanupTempDataDir(dir); });
  return { dir, db, k, doc, bytes };
}
function write(k, id, content, extra = {}) {
  const raw = k.getTextFile(id);
  return k.updateTextFile(id, { content, bom: raw.bom, baseVersion: raw.baseVersion, baseFingerprint: raw.baseFingerprint, ...extra });
}
function save(k, id, name = '版本') {
  const raw = k.getTextFile(id);
  return k.createNamedRevision(id, { name, baseVersion: raw.baseVersion || k.getDocument(id).version, baseFingerprint: raw.baseFingerprint || k.getDocument(id).fileMeta.sha256 });
}
const long = () => Array.from({ length: 800 }, (_, i) => `unique ${i} 中文 emoji 😀\r\n`).join('');

test('file versions use complete original UTF-8 bytes, preserve BOM and mixed line endings', t => {
  const source = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('头\r\n尾\r空白  \t😀\n')]);
  const { k, doc, bytes } = setup(t, source);
  const raw = k.getTextFile(doc.id);
  assert.equal(raw.bom, true); assert.equal(raw.editable, true);
  const first = save(k, doc.id).revision;
  assert.equal(first.snapshot.content, '头\r\n尾\r空白  \t😀\n');
  assert.equal(first.snapshot.file.sha256, textFile.digest(bytes));
  const updated = write(k, doc.id, '修改\r\n尾\r空白  \t😀\n');
  assert.equal(updated.document.content, updated.content);
  assert.equal(k.listRevisions(doc.id).total, 1);
  const restored = k.restoreRevision(doc.id, first.id, { baseVersion: updated.baseVersion, baseFingerprint: updated.baseFingerprint });
  assert.deepEqual(fs.readFileSync(k.filePathFor(restored.document)), bytes);
  assert.equal(k.listRevisions(doc.id).total, 1);
  const empty = write(k, doc.id, '', { bom: false });
  assert.deepEqual(fs.readFileSync(k.filePathFor(empty.document)), Buffer.alloc(0));
});

test('invalid UTF-8, binary controls, unsupported types and limits remain read-only', t => {
  for (const [bytes, filename] of [[Buffer.from([0xff, 0xfe, 0x41, 0]), 'utf16.txt'], [Buffer.from([0xd6, 0xd0]), 'gbk.txt'],
    [Buffer.from('abc\0def'), 'binary.txt'], [Buffer.from('a'.repeat(500001)), 'large.txt'], [Buffer.from('plain'), 'x.pdf']]) {
    const { k, doc } = setup(t, bytes, filename);
    assert.equal(k.getTextFile(doc.id).editable, false);
    assert.ok(save(k, doc.id).error);
    assert.equal(k.listRevisions(doc.id).total, 0);
    assert.deepEqual(fs.readFileSync(k.filePathFor(doc)), bytes);
  }
  assert.ok(textFile.encodeText('\ud800', false).error);
  assert.equal(textFile.encodeText('a'.repeat(500001), false).status, 413);
});

test('both document version and original fingerprint are required; external edits never get overwritten', t => {
  const { k, doc } = setup(t);
  assert.equal(k.updateTextFile(doc.id, { content: 'x', bom: false }).status, 400);
  assert.equal(write(k, doc.id, 'x', { baseVersion: doc.version + 1 }).status, 409);
  assert.equal(write(k, doc.id, 'x', { baseFingerprint: 'bad' }).status, 409);
  assert.equal(k.createNamedRevision(doc.id, { name: 'x', baseVersion: doc.version }).status, 409);
  fs.writeFileSync(k.filePathFor(doc), '外部修改');
  assert.equal(k.getTextFile(doc.id).status, 409);
  assert.equal(k.updateTextFile(doc.id, { content: '覆盖', bom: false, baseVersion: doc.version, baseFingerprint: doc.fileMeta.sha256 }).status, 409);
  assert.equal(fs.readFileSync(k.filePathFor(doc), 'utf8'), '外部修改');
  assert.equal(k.getDocument(doc.id).version, doc.version);
});

test('raw file changes update search/index, keep annotations separate, and create no automatic histories', t => {
  const { db, k, doc } = setup(t, '{"key":"old"}\n', 'source.json');
  const annotation = k.upsertAnnotation(doc.id, { content: '批注' }).document;
  const oldIndex = k.sourceSignature();
  const updated = write(k, doc.id, '{"key":"new", "literal":"[[不应改写]]"}\r\n');
  assert.equal(updated.document.content, '{"key":"new", "literal":"[[不应改写]]"}\r\n');
  assert.notEqual(k.sourceSignature(), oldIndex);
  assert.equal(k.getAnnotation(doc.id).content, '批注');
  assert.equal(k.listRevisions(doc.id).total, 0);
  assert.equal(k.listRevisions(annotation.id).total, 0);
  assert.equal(save(k, doc.id).revision.snapshot.snapshotKind, 'text_file');
  assert.equal(k.createNamedRevision(annotation.id, { name: '批注版本', baseVersion: annotation.version }).revision.snapshot.content, '批注');
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM knowledge_revisions').get().n, 2);
});

test('v2 delta chains preserve file metadata and survive baseline deletion', t => {
  const { db, k, doc } = setup(t, long());
  const snapshots = [];
  for (let i = 0; i < 12; i++) {
    write(k, doc.id, long().replace('unique 3 ', `edit ${i} `));
    snapshots.push(save(k, doc.id, `v${i}`).revision);
  }
  const rows = db.sqlite.prepare('SELECT * FROM knowledge_revisions WHERE document_id = ? ORDER BY id').all(doc.id);
  assert.equal(rows[0].storage_format, 'full-v2');
  assert.equal(rows[9].delta_depth, 9); assert.equal(rows[10].storage_format, 'full-v2');
  assert.equal(k.deleteNamedRevision(doc.id, snapshots[0].id).deleted, true);
  for (const snapshot of snapshots.slice(1)) assert.deepEqual(k.getRevision(doc.id, snapshot.id).revision.snapshot, snapshot.snapshot);
  db.sqlite.prepare("UPDATE knowledge_revisions SET snapshot_hash = 'bad' WHERE id = ?").run(snapshots[1].id);
  assert.throws(() => k.getRevision(doc.id, snapshots[1].id));
});

test('synced originals and cached binaries roll back on SQLite or manifest failures', t => {
  const { db, k, doc, bytes } = setup(t);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'text-file-sync-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  k.folderSync.migrateAll({ rootPath: root }); k.folderSync.stop();
  const current = k.getDocument(doc.id), original = k.filePathFor(current);
  const beforeNames = fs.readdirSync(k.filesDir);
  db.sqlite.exec("CREATE TRIGGER fail_text_save BEFORE UPDATE ON knowledge_documents BEGIN SELECT RAISE(ABORT, 'rollback test'); END");
  assert.throws(() => write(k, doc.id, '不会保存'), /rollback test/);
  assert.deepEqual(fs.readFileSync(original), bytes);
  assert.deepEqual(fs.readdirSync(k.filesDir), beforeNames);
  assert.equal(k.getDocument(doc.id).version, current.version);
  db.sqlite.exec('DROP TRIGGER fail_text_save');
  const persist = k.folderSync.persistManifest.bind(k.folderSync);
  let fail = true;
  k.folderSync.persistManifest = () => { if (fail) { fail = false; throw new Error('manifest failure'); } return persist(); };
  assert.throws(() => write(k, doc.id, 'manifest 不会保存'), /manifest failure/);
  assert.deepEqual(fs.readFileSync(original), bytes);
  assert.equal(k.getDocument(doc.id).version, current.version);
  const edited = write(k, doc.id, '正常保存\r\n');
  assert.equal(edited.document.content, '正常保存\r\n');
  assert.equal(fs.readFileSync(original, 'utf8'), '正常保存\r\n');
  assert.equal(k.getTextFile(doc.id).baseFingerprint, edited.baseFingerprint);
});

test('missing originals and symlink escapes refuse editing and version creation', t => {
  const { k, doc } = setup(t);
  const file = k.filePathFor(doc);
  fs.unlinkSync(file);
  assert.equal(k.getTextFile(doc.id).status, 404);
  assert.equal(save(k, doc.id).status, 404);
  fs.symlinkSync('/etc/hosts', file);
  assert.equal(k.getTextFile(doc.id).status, 404);
});

test('raw conflict drafts can be stored and read with folder sync disabled', t => {
  const { k, doc } = setup(t);
  const saved = k.folderSync.saveDraft(doc.id, { rawText: true, content: '未保存\r\n', bom: true }, '原件冲突');
  assert.ok(saved.id);
  assert.equal(k.folderSync.listDrafts()[0].id, saved.id);
  assert.deepEqual(k.folderSync.readDraft(saved.id).draft, { rawText: true, content: '未保存\r\n', bom: true });
});

test('SQLite ZIP round-trips original file versions and their differences', async t => {
  const { db, k, doc } = setup(t, long(), 'source.csv');
  const first = save(k, doc.id).revision;
  write(k, doc.id, long() + '\r\n额外记录');
  const second = save(k, doc.id, '修改后').revision;
  const buffer = await exportWorkspace(db);
  const target = setup(t);
  target.k.folderSync.stop();
  assert.equal((await restoreWorkspace(target.db, buffer)).success, true);
  const restored = createKnowledgeService(target.db, { startFolderSync: false });
  t.after(() => restored.folderSync.stop());
  assert.equal(restored.finishRevisionCleanup().cleaned, false);
  assert.deepEqual(restored.getRevision(doc.id, second.id).revision.snapshot, second.snapshot);
  const raw = restored.getTextFile(doc.id);
  const outcome = restored.restoreRevision(doc.id, first.id, { baseVersion: raw.baseVersion, baseFingerprint: raw.baseFingerprint });
  assert.equal(restored.getTextFile(doc.id).content, first.snapshot.content);
  assert.equal(textFile.digest(fs.readFileSync(restored.filePathFor(outcome.document))), first.snapshot.file.sha256);
});

test('mindmap history restores all model fields and rejects invalid graphs without mutation', t => {
  const { k, db } = setup(t);
  const model = { version: 1, rootId: 'r', nodes: [{ id: 'r', text: '根', x: 11, y: 22, collapsed: true },
    { id: 'c', text: '子节点', x: 250, y: 32, side: 'right', collapsed: false }], edges: [{ source: 'r', target: 'c' }], canvas: { width: 600, height: 450 } };
  const note = k.createNote({ title: '导图', documentRole: 'mindmap', content: JSON.stringify(model) }).document;
  const revision = k.createNamedRevision(note.id, { name: '导图历史', baseVersion: note.version }).revision;
  assert.equal(revision.snapshot.snapshotKind, 'mindmap');
  const changed = structuredClone(model); changed.nodes[0].collapsed = false; changed.nodes[1].text = '修改';
  k.updateDocument(note.id, { content: JSON.stringify(changed), baseVersion: note.version });
  assert.deepEqual(JSON.parse(k.restoreRevision(note.id, revision.id, { baseVersion: k.getDocument(note.id).version }).document.content), model);
  const malformed = { ...revision.snapshot, content: JSON.stringify({ ...model, edges: [{ source: 'r', target: 'missing' }] }) };
  const stored = storage.encode(malformed);
  db.sqlite.prepare('UPDATE knowledge_revisions SET snapshot = ?, snapshot_hash = ?, content_length = ? WHERE id = ?').run(stored.snapshot, stored.snapshot_hash, stored.content_length, revision.id);
  const before = k.getDocument(note.id);
  assert.equal(k.restoreRevision(note.id, revision.id, { baseVersion: before.version }).status, 400);
  assert.deepEqual(k.getDocument(note.id), before);
});

test('moving a text original rolls back a failure before manifest update without leaving a duplicate', t => {
  const { k, doc, bytes } = setup(t);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'text-file-move-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  k.folderSync.migrateAll({ rootPath: root }); k.folderSync.stop();
  const current = k.getDocument(doc.id), original = k.filePathFor(current);
  const move = k.folderSync.moveToTrash.bind(k.folderSync);
  let fail = true;
  k.folderSync.moveToTrash = (...args) => { const result = move(...args); if (fail) { fail = false; throw new Error('move failed after writing'); } return result; };
  assert.throws(() => write(k, doc.id, '新文件内容', { folderPath: 'new-folder' }), /move failed/);
  assert.deepEqual(fs.readFileSync(original), bytes);
  assert.equal(k.getDocument(doc.id).version, current.version);
  assert.equal(fs.existsSync(path.join(root, current.knowledgeBase, 'new-folder', current.fileMeta.filename)), false);
  assert.equal(k.getTextFile(doc.id).baseFingerprint, current.fileMeta.sha256);
});

test('registered Markdown originals remain files through sync; native notes retain their own workflow', async t => {
  const { k, doc } = setup(t, '# 原件\r\n[[保留字面文本]]\n', 'original.md');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'raw-md-sync-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  k.folderSync.migrateAll({ rootPath: root }); k.folderSync.stop();
  const updated = write(k, doc.id, '# 修改原件\r\n[[保留字面文本]]\n');
  assert.equal(updated.document.sourceType, 'file');
  await k.folderSync.syncNow(); k.folderSync.stop();
  assert.equal(k.getDocument(doc.id).sourceType, 'file');
  assert.equal(k.allDocuments().filter(doc => doc.sourceType === 'note').length, 0);
  assert.equal(k.getTextFile(doc.id).content, '# 修改原件\r\n[[保留字面文本]]\n');
});

test('internal original directory symlinks cannot redirect raw writes outside the account', t => {
  const { k, doc } = setup(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'raw-cache-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.cpSync(k.filesDir, outside, { recursive: true });
  fs.rmSync(k.filesDir, { recursive: true });
  fs.symlinkSync(outside, k.filesDir);
  assert.equal(k.getTextFile(doc.id).status, 404);
  assert.ok(k.updateTextFile(doc.id, { content: '不应写出', bom: false, baseVersion: doc.version, baseFingerprint: doc.fileMeta.sha256 }).error);
  assert.equal(fs.readdirSync(outside).length, 1);
  fs.unlinkSync(k.filesDir);
});

test('an in-flight folder extraction cannot overwrite a newer original edit', async t => {
  const { k, doc } = setup(t);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'raw-sync-race-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  k.folderSync.migrateAll({ rootPath: root }); k.folderSync.stop();
  const old = k.getDocument(doc.id), fullPath = k.filePathFor(old);
  const { fileFingerprint } = require('../lib/knowledge/folder-sync');
  const inFlight = k.folderSync.adapter.importBinary({ existing: old, fullPath, filename: old.fileMeta.filename,
    fingerprint: fileFingerprint(fullPath), relativePath: old.fileSync.relativePath,
    knowledgeBase: old.knowledgeBase, folderPath: old.folderPath, collectionPath: old.collectionPath });
  const result = write(k, doc.id, '应用内新版本\r\n');
  assert.ok(result.document);
  await assert.rejects(inFlight, /同步期间文档已更新/);
  assert.equal(k.getDocument(doc.id).version, result.document.version);
  assert.equal(k.getTextFile(doc.id).content, '应用内新版本\r\n');
});
