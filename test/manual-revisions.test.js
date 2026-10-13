const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { createDatabase } = require('../database');
const { createKnowledgeService } = require('../lib/knowledge/documents');
const storage = require('../lib/knowledge/revision-storage');
const { cleanupTempDataDir } = require('./db-temp');
const { applySchema } = require('../lib/db/connection');

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-revisions-'));
  const db = createDatabase(dir);
  const knowledge = createKnowledgeService(db, { startFolderSync: false });
  t.after(() => { knowledge.folderSync.stop(); db.close(); cleanupTempDataDir(dir); });
  const note = knowledge.createNote({ title: '测试', content: longText(), knowledgeBase: '工作', folderPath: '草稿' }).document;
  return { dir, db, knowledge, note };
}
const longText = () => Array.from({ length: 1000 }, (_, i) => `第 ${i} 段：中文 emoji 😀 与空白  \t保留\r\n`).join('');
const save = (k, id, name = '版本') => k.createNamedRevision(id, { name, baseVersion: k.getDocument(id).version }).revision;
const rows = (db, id) => db.sqlite.prepare('SELECT * FROM knowledge_revisions WHERE document_id = ? ORDER BY id').all(id);

test('bounded multi-region patch round trips exact JS strings and falls back on budget', () => {
  const before = longText();
  const after = before.replace('第 3 段', '第 三 段').replace('第 900 段', '第 九百 段') + '\n尾部\r孤立代理项\ud800';
  const patch = storage.makePatch(before, after, 1000);
  assert.ok(patch.length >= 3);
  assert.equal(storage.applyPatch(before, patch), after);
  for (const [a, b] of [['', '😀\r\n  '], ['😀\r\n', ''], ['a\na\na\n', 'a\nx\na\n'], ['😀', '😁']]) {
    assert.equal(storage.applyPatch(a, storage.makePatch(a, b, 1000)), b);
  }
  assert.equal(storage.makePatch(before, after, -1), null);
  assert.throws(() => storage.applyPatch('abc', [[2, 5, 'x']]));
});

test('only manual versions are captured, with conflict checks and unbounded retention', t => {
  const { db, knowledge: k, note } = setup(t);
  assert.equal(k.createNamedRevision(note.id, { name: 'bad', baseVersion: note.version + 1 }).status, 409);
  assert.equal(k.checkpointRevision(note.id, { baseVersion: note.version }).checkpointed, false);
  for (const revisionReason of ['auto', 'agent_write', 'assistant_edit', 'external_sync', 'folder_migration', 'restore_merge']) {
    const current = k.getDocument(note.id);
    k.updateDocument(note.id, { content: current.content + revisionReason, baseVersion: current.version }, { revisionReason });
  }
  assert.equal(k.listRevisions(note.id).total, 0);
  const revision = save(k, note.id);
  const current = k.getDocument(note.id);
  k.updateDocument(note.id, { content: '新内容', baseVersion: current.version });
  k.restoreRevision(note.id, revision.id, { baseVersion: k.getDocument(note.id).version });
  assert.equal(k.listRevisions(note.id).total, 1);
  assert.equal(k.getDocument(note.id).content, revision.snapshot.content);
  for (let i = 0; i < 55; i++) save(k, note.id, `保存 ${i}`);
  db.sqlite.prepare("UPDATE knowledge_revisions SET captured_at = '2000-01-01' WHERE document_id = ?").run(note.id);
  assert.equal(k.listRevisions(note.id).total, 56);
});

test('full baselines bound delta depth and preserve all properties, with full fallback', t => {
  const { db, knowledge: k, note } = setup(t);
  const expected = [];
  for (let i = 0; i < 12; i++) {
    const current = k.getDocument(note.id);
    k.updateDocument(note.id, { content: longText().replace('第 5 段', `编辑 ${i}`), title: `标题 ${i}`,
      tags: ['标签', String(i)], documentDate: '2026-10-13', baseVersion: current.version });
    expected.push(save(k, note.id, `v${i}`));
  }
  const stored = rows(db, note.id);
  assert.equal(stored[0].storage_format, 'full-v1');
  assert.equal(stored[9].delta_depth, 9);
  assert.equal(stored[10].storage_format, 'full-v1');
  for (const revision of expected) assert.deepEqual(k.getRevision(note.id, revision.id).revision.snapshot, revision.snapshot);
  const latest = k.getDocument(note.id);
  k.updateDocument(note.id, { content: '', baseVersion: latest.version });
  const empty = save(k, note.id);
  assert.equal(rows(db, note.id).at(-1).storage_format, 'full-v1');
  assert.equal(empty.snapshot.content, '');
});

test('deleting first, middle, and latest versions preserves dependent snapshots atomically', t => {
  const { db, knowledge: k, note } = setup(t);
  const revisions = [];
  for (let i = 0; i < 5; i++) {
    k.updateDocument(note.id, { content: longText().replace('第 5 段', `版本 ${i}`), baseVersion: k.getDocument(note.id).version });
    revisions.push(save(k, note.id, `v${i}`));
  }
  k.renameRevision(note.id, revisions[1].id, { name: '保留名称' });
  db.sqlite.exec(`CREATE TRIGGER fail_revision_delete BEFORE DELETE ON knowledge_revisions BEGIN SELECT RAISE(ABORT, 'test rollback'); END`);
  const before = rows(db, note.id);
  assert.throws(() => k.deleteNamedRevision(note.id, revisions[0].id), /test rollback/);
  assert.deepEqual(rows(db, note.id), before);
  db.sqlite.exec('DROP TRIGGER fail_revision_delete');
  for (const index of [0, 2, 4]) assert.equal(k.deleteNamedRevision(note.id, revisions[index].id).deleted, true);
  for (const index of [1, 3]) assert.deepEqual(k.getRevision(note.id, revisions[index].id).revision.snapshot, revisions[index].snapshot);
  assert.equal(k.getRevision(note.id, revisions[1].id).revision.name, '保留名称');
});

test('corrupt, missing, cyclic or foreign baselines stop reads/restores without changing the document', t => {
  const { db, knowledge: k, note } = setup(t);
  const first = save(k, note.id);
  k.updateDocument(note.id, { content: longText() + 'x', baseVersion: note.version });
  const second = save(k, note.id);
  const current = k.getDocument(note.id);
  const stored = rows(db, note.id)[1];
  for (const changes of [{ base_revision_id: 99999 }, { base_hash: 'bad' }, { snapshot_hash: 'bad' }, { base_revision_id: second.id }, { snapshot: '{}' }]) {
    for (const [field, value] of Object.entries(changes)) db.sqlite.prepare(`UPDATE knowledge_revisions SET ${field} = ? WHERE id = ?`).run(value, second.id);
    assert.throws(() => k.getRevision(note.id, second.id));
    assert.throws(() => k.restoreRevision(note.id, second.id, { baseVersion: current.version }));
    assert.deepEqual(k.getDocument(note.id), current);
    for (const field of Object.keys(changes)) db.sqlite.prepare(`UPDATE knowledge_revisions SET ${field} = ? WHERE id = ?`).run(stored[field], second.id);
  }
  const other = k.createNote({ title: '别的文档', content: 'other' }).document;
  const foreign = save(k, other.id);
  db.sqlite.prepare('UPDATE knowledge_revisions SET base_revision_id = ? WHERE id = ?').run(foreign.id, second.id);
  assert.throws(() => k.getRevision(note.id, second.id));
  assert.equal(k.getRevision(note.id, first.id).revision.snapshot.content, note.content);
});

test('upgrade cleanup is one-shot, checks saved version, rolls back, and protects new versions', t => {
  const { db, knowledge: k, note } = setup(t);
  const old = save(k, note.id, '旧命名');
  db.sqlite.prepare("UPDATE meta SET value = '6' WHERE key = 'schema_version'").run();
  db.sqlite.prepare("DELETE FROM meta WHERE key LIKE 'manual_revision_cleanup_%'").run();
  applySchema(db.sqlite);
  const fresh = save(k, note.id, '新手动');
  assert.equal(rows(db, note.id)[1].base_revision_id, null);
  assert.equal(k.finishRevisionCleanup({ documentId: note.id, baseVersion: note.version + 1 }).status, 409);
  assert.equal(rows(db, note.id).length, 2);
  db.sqlite.exec(`CREATE TRIGGER fail_cleanup BEFORE DELETE ON knowledge_revisions BEGIN SELECT RAISE(ABORT, 'cleanup rollback'); END`);
  assert.throws(() => k.finishRevisionCleanup(), /cleanup rollback/);
  assert.equal(db.sqlite.prepare("SELECT value FROM meta WHERE key = 'manual_revision_cleanup_done'").get(), undefined);
  db.sqlite.exec('DROP TRIGGER fail_cleanup');
  assert.equal(k.finishRevisionCleanup({ documentId: note.id, baseVersion: note.version }).deleted, 1);
  assert.equal(k.getRevision(note.id, old.id).status, 404);
  assert.equal(k.getRevision(note.id, fresh.id).revision.name, '新手动');
  assert.equal(k.finishRevisionCleanup().cleaned, false);
  assert.deepEqual(k.getDocument(note.id), note);
  assert.equal(k.getRevision(note.id, save(k, note.id).id).revision.snapshot.content, note.content);
});

test('legacy full snapshots remain readable and restoration keeps current location by default', t => {
  const { db, knowledge: k, note } = setup(t);
  const snapshot = k.editableSnapshot(note);
  const result = db.sqlite.prepare(`INSERT INTO knowledge_revisions (document_id, document_version, captured_at, reason, snapshot, name)
    VALUES (?, 1, ?, 'manual', ?, '旧格式')`).run(note.id, new Date().toISOString(), JSON.stringify(snapshot));
  storage.preserveRestoredHistory(db.sqlite);
  assert.equal(k.finishRevisionCleanup().cleaned, false);
  assert.deepEqual(k.getRevision(note.id, result.lastInsertRowid).revision.snapshot, snapshot);
  k.updateDocument(note.id, { folderPath: '正式', content: '新版', baseVersion: note.version });
  assert.equal(k.restoreRevision(note.id, result.lastInsertRowid, { baseVersion: k.getDocument(note.id).version }).document.folderPath, '正式');
});

test('long-document small edits materially reduce history storage with measured read latency', t => {
  const { db, knowledge: k, note } = setup(t);
  let fullBytes = 0;
  const ids = [];
  for (let i = 0; i < 30; i++) {
    k.updateDocument(note.id, { content: longText().replace('第 5 段', `修改 ${i}`).replace('第 900 段', `尾段 ${i}`), baseVersion: k.getDocument(note.id).version });
    const revision = save(k, note.id, `性能 ${i}`);
    fullBytes += Buffer.byteLength(JSON.stringify(revision.snapshot)); ids.push(revision.id);
  }
  const storedBytes = rows(db, note.id).reduce((total, row) => total + Buffer.byteLength(row.snapshot) + 160, 0);
  const start = performance.now();
  for (const id of ids) k.getRevision(note.id, id);
  const elapsed = performance.now() - start;
  assert.ok(storedBytes < fullBytes * 0.35, `${storedBytes}/${fullBytes}`);
  t.diagnostic(`30 versions: ${storedBytes}/${fullBytes} bytes (${(100 * storedBytes / fullBytes).toFixed(1)}%); reads ${elapsed.toFixed(1)}ms`);
});

test('SQLite ZIP restores preserve delta chains and legacy history across reopen and cleanup', async t => {
  const { db, knowledge: k, note } = setup(t);
  const { exportWorkspace, restoreWorkspace } = require('../lib/workspace/zip');
  const expected = [save(k, note.id, '完整')];
  k.updateDocument(note.id, { content: longText() + '\n小幅编辑 😀', baseVersion: note.version });
  expected.push(save(k, note.id, '差异'));
  assert.equal(rows(db, note.id)[1].storage_format, 'delta-v1');
  const buffer = await exportWorkspace(db);
  const target = setup(t);
  target.knowledge.folderSync.stop();
  assert.equal((await restoreWorkspace(target.db, buffer)).success, true);
  const restored = createKnowledgeService(target.db, { startFolderSync: false });
  t.after(() => restored.folderSync.stop());
  assert.equal(restored.finishRevisionCleanup().cleaned, false);
  for (const revision of expected) assert.deepEqual(restored.getRevision(note.id, revision.id).revision.snapshot, revision.snapshot);
  applySchema(target.db.sqlite);
  assert.equal(restored.finishRevisionCleanup().cleaned, false);
  // Simulate an old SQLite archive: full snapshots and an older schema marker.
  db.sqlite.prepare('DELETE FROM knowledge_revisions WHERE id = ?').run(expected[1].id);
  db.sqlite.prepare("UPDATE knowledge_revisions SET storage_format = 'legacy', snapshot_hash = NULL, content_length = NULL, summary = NULL").run();
  db.sqlite.prepare("UPDATE meta SET value = '6' WHERE key = 'schema_version'").run();
  db.sqlite.prepare("DELETE FROM meta WHERE key LIKE 'manual_revision_cleanup_%'").run();
  const oldBuffer = await exportWorkspace(db);
  restored.folderSync.stop();
  assert.equal((await restoreWorkspace(target.db, oldBuffer)).success, true);
  const oldRestored = createKnowledgeService(target.db, { startFolderSync: false });
  t.after(() => oldRestored.folderSync.stop());
  assert.equal(oldRestored.finishRevisionCleanup().cleaned, false);
  assert.deepEqual(oldRestored.getRevision(note.id, expected[0].id).revision.snapshot, expected[0].snapshot);
  assert.equal(oldRestored.createNamedRevision(note.id, { name: '恢复后', baseVersion: oldRestored.getDocument(note.id).version }).revision.name, '恢复后');
});

test('list summaries do not reconstruct or read baseline bodies', t => {
  const { db, knowledge: k, note } = setup(t);
  const first = save(k, note.id, '完整');
  k.updateDocument(note.id, { content: longText() + '新增', baseVersion: note.version });
  const second = save(k, note.id, '差异');
  db.sqlite.prepare("UPDATE knowledge_revisions SET snapshot = '损坏的基准' WHERE id = ?").run(first.id);
  const listed = k.listRevisions(note.id);
  assert.equal(listed.total, 2);
  assert.equal(listed.revisions.find(row => row.id === second.id).contentLength, second.snapshot.content.length);
  assert.equal(listed.revisions.find(row => row.id === first.id).title, note.title);
  assert.throws(() => k.getRevision(note.id, second.id));
});
