const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createDatabase } = require('../database.js');
const { createKnowledgeService } = require('../lib/knowledge/documents');
const { canonicalizeContent, parseWikiLinks, normalizeTitle } = require('../lib/knowledge/links');
const { cleanupTempDataDir } = require('./db-temp');

test('wiki link parser canonicalizes unique titles and reports ambiguity', () => {
  const resolved = canonicalizeContent('参见 [[目标]]', title => (
    title === normalizeTitle('目标') ? { status: 'resolved', documentId: 'note:7' } : { status: 'unresolved' }
  ));
  assert.equal(resolved.content, '参见 [[目标|note:7]]');
  assert.equal(resolved.issues.length, 0);
  assert.deepEqual(parseWikiLinks(resolved.content).map(item => item.targetId), ['note:7']);

  const ambiguous = canonicalizeContent('参见 [[目标]]', () => ({
    status: 'ambiguous',
    candidates: [{ id: 'note:1' }, { id: 'note:2' }],
  }));
  assert.equal(ambiguous.content, '参见 [[目标]]');
  assert.equal(ambiguous.issues[0].status, 'ambiguous');
});

test('knowledge links, backlinks, revisions, and restore use stable document ids', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-links-'));
  const db = createDatabase(dir);
  const knowledge = createKnowledgeService(db);
  t.after(() => {
    db.close();
    cleanupTempDataDir(dir);
  });

  const target = knowledge.createNote({ title: '目标笔记', content: '第一版' }).document;
  const source = knowledge.createNote({ title: '来源笔记', content: `参见 [[目标笔记]]` }).document;
  assert.equal(source.content, `参见 [[目标笔记|${target.id}]]`);
  assert.equal(knowledge.backlinks(target.id).backlinks[0].sourceId, source.id);
  assert.equal(knowledge.outgoingLinks(source.id).links[0].status, 'resolved');

  const updated = knowledge.updateDocument(target.id, { title: '目标重命名', content: '第二版' }).document;
  assert.equal(knowledge.outgoingLinks(source.id).links[0].targetId, updated.id);
  assert.equal(knowledge.backlinks(updated.id).total, 1);

  const listed = knowledge.listRevisions(target.id);
  assert.equal(listed.total, 1);
  assert.equal(listed.revisions[0].title, '目标笔记');
  const restored = knowledge.restoreRevision(target.id, listed.revisions[0].id, { baseVersion: updated.version });
  assert.equal(restored.document.title, '目标笔记');
  assert.equal(restored.document.content, '第一版');
  assert.equal(knowledge.listRevisions(target.id).total, 2);
});

test('named revisions survive automatic pruning, require the current version, and can be renamed or deleted', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-named-revisions-'));
  const db = createDatabase(dir);
  const knowledge = createKnowledgeService(db);
  t.after(() => {
    db.close();
    cleanupTempDataDir(dir);
  });
  const note = knowledge.createNote({ title: '命名测试', content: '当前正文' }).document;
  assert.equal(knowledge.createNamedRevision(note.id, { name: '发布前', baseVersion: note.version }).revision.name, '发布前');
  assert.equal(knowledge.createNamedRevision(note.id, { name: '过期版本', baseVersion: note.version + 1 }).status, 409);
  db.sqlite.prepare("UPDATE knowledge_revisions SET captured_at = '2020-01-01T00:00:00.000Z' WHERE document_id = ? AND name IS NOT NULL").run(note.id);
  const updated = knowledge.updateDocument(note.id, { title: '后续修改', content: '后续正文', baseVersion: note.version }, { revisionReason: 'agent_write' }).document;
  const revisions = knowledge.listRevisions(note.id).revisions;
  assert.equal(revisions[0].name, '发布前');
  assert.ok(revisions.some(item => item.reason === 'agent_write'));
  assert.equal(knowledge.renameRevision(note.id, revisions[0].id, { name: '改名版本' }).revision.name, '改名版本');
  assert.equal(knowledge.deleteNamedRevision(note.id, revisions[0].id).deleted, true);
  assert.equal(knowledge.getRevision(note.id, revisions[0].id).error, 'Revision not found');
  assert.equal(knowledge.getDocument(note.id).version, updated.version);
});

test('legacy note rows without a source type keep their revision history', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-legacy-revision-'));
  const db = createDatabase(dir);
  const knowledge = createKnowledgeService(db);
  t.after(() => {
    db.close();
    cleanupTempDataDir(dir);
  });
  const note = knowledge.createNote({ title: '旧格式笔记', content: '保留历史' }).document;
  const row = db.sqlite.prepare('SELECT body FROM knowledge_documents WHERE id = ?').get(note.id);
  const body = JSON.parse(row.body);
  delete body.sourceType;
  db.sqlite.prepare('UPDATE knowledge_documents SET body = ? WHERE id = ?').run(JSON.stringify(body), note.id);

  const loaded = knowledge.getDocument(note.id);
  assert.equal(loaded.sourceType, 'note');
  assert.equal(knowledge.createNamedRevision(note.id, { name: '旧笔记仍可命名', baseVersion: loaded.version }).revision.name, '旧笔记仍可命名');
});

test('restore can keep the present location while restoring the historical note fields', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-revision-location-'));
  const db = createDatabase(dir);
  const knowledge = createKnowledgeService(db);
  t.after(() => {
    db.close();
    cleanupTempDataDir(dir);
  });
  const original = knowledge.createNote({ title: '初始标题', content: '初始正文', knowledgeBase: '工作', folderPath: '草稿' }).document;
  const moved = knowledge.updateDocument(original.id, {
    title: '新标题', content: '新正文', knowledgeBase: '工作', folderPath: '正式', baseVersion: original.version,
  }).document;
  const revision = knowledge.listRevisions(original.id).revisions[0];
  const restored = knowledge.restoreRevision(original.id, revision.id, { baseVersion: moved.version, restoreLocation: false }).document;
  assert.equal(restored.title, '初始标题');
  assert.equal(restored.content, '初始正文');
  assert.equal(restored.folderPath, '正式');
  assert.equal(restored.knowledgeBase, '工作');
});

test('knowledge link targets exclude archived documents and backlinks hide archived sources', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-link-privacy-'));
  const db = createDatabase(dir);
  const knowledge = createKnowledgeService(db);
  t.after(() => {
    db.close();
    cleanupTempDataDir(dir);
  });
  const target = knowledge.createNote({ title: '活动目标', content: '' }).document;
  const archived = knowledge.createNote({ title: '归档来源', content: `[[活动目标|${target.id}]]` }).document;
  knowledge.archiveDocument(archived.id);
  assert.equal(knowledge.linkTargets({ query: '归档来源' }).length, 0);
  assert.equal(knowledge.backlinks(target.id).total, 0);
});

test('direct links validate local targets and hide locked diary ids', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-link-validation-'));
  const db = createDatabase(dir);
  const knowledge = createKnowledgeService(db);
  t.after(() => {
    db.close();
    cleanupTempDataDir(dir);
  });
  const missing = knowledge.createNote({ title: '断链来源', content: '[[不存在|note:999]]' });
  assert.equal(missing.linkIssues[0].status, 'missing');
  assert.equal(knowledge.outgoingLinks(missing.document.id).links[0].status, 'missing');
  const diary = knowledge.createNote({ title: '私密目标', content: '', knowledgeBase: '日记' }, { diaryUnlocked: true }).document;
  const source = knowledge.createNote({ title: '来源', content: `[[私密目标|${diary.id}]]` });
  const outgoing = knowledge.outgoingLinks(source.document.id);
  assert.equal(outgoing.links[0].status, 'locked');
  assert.equal(outgoing.links[0].targetId, '');
});

test('a damaged title index is rebuilt lazily on first link target query', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-link-rebuild-'));
  const db = createDatabase(dir);
  const knowledge = createKnowledgeService(db);
  t.after(() => {
    db.close();
    cleanupTempDataDir(dir);
  });
  const note = knowledge.createNote({ title: '需要重建', content: '' }).document;
  knowledge.ensureLinkIndex();
  db.sqlite.prepare('DELETE FROM knowledge_link_targets').run();
  assert.equal(knowledge.linkTargets({ query: '需要重建' })[0].id, note.id);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM knowledge_link_targets').get().count, 1);
  const source = knowledge.createNote({ title: '含链接', content: `[[需要重建|${note.id}]]` }).document;
  knowledge.ensureLinkIndex();
  db.sqlite.prepare('DELETE FROM knowledge_links WHERE source_document_id = ?').run(source.id);
  assert.equal(knowledge.backlinks(note.id).backlinks[0].sourceId, source.id);
});
