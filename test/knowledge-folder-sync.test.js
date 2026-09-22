const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { execFileSync } = require('node:child_process');
const { createTempDatabase, cleanupTempDataDir } = require('./db-temp');
const { createKnowledgeService } = require('../lib/knowledge/documents');
const { parseFrontMatter, serializeMarkdown, sanitizeSegment } = require('../lib/knowledge/folder-sync');

function setup(t) {
  const { db, dir } = createTempDatabase(t, 'knowledge-folder-db-');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-folder-root-'));
  const knowledge = createKnowledgeService(db);
  t.after(() => {
    knowledge.folderSync.stop();
    cleanupTempDataDir(root);
  });
  return { db, dir, root, knowledge };
}

test('folder sync migrates notes, relative images, diary notes and empty folders', async (t) => {
  const { db, dir, root, knowledge } = setup(t);
  db.addCategory('项目');
  db.addCategory('空目录', '项目');
  fs.mkdirSync(path.join(dir, 'uploads'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'uploads', '示意图.png'), Buffer.from('png-bytes'));
  const note = knowledge.createNote({
    title: '方案：一',
    knowledgeBase: '项目',
    content: '正文\n\n![图](/uploads/%E7%A4%BA%E6%84%8F%E5%9B%BE.png)\n\n```md\n![示例](/uploads/not-real.png)\n```',
  }).document;
  const diary = knowledge.createNote({ title: '当天', content: '秘密', knowledgeBase: '日记' }, { diaryUnlocked: true }).document;

  const report = knowledge.folderSync.migrateAll({ rootPath: root });
  assert.equal(report.documents, 2);
  assert.equal(fs.existsSync(path.join(root, '项目', '空目录')), true);
  const migrated = knowledge.getDocument(note.id, { diaryUnlocked: true });
  const notePath = knowledge.folderSync.localPathFor(migrated);
  assert.ok(notePath.endsWith(`${sanitizeSegment(note.title)}.md`));
  const source = fs.readFileSync(notePath, 'utf8');
  assert.match(source, new RegExp(`liuxu_id: ${JSON.stringify(note.id)}`));
  assert.match(source, /!\[图\]\(\.\/%E7%A4%BA%E6%84%8F%E5%9B%BE\.png\)/);
  assert.match(source, /```md\n!\[示例\]\(\/uploads\/not-real\.png\)/);
  assert.deepEqual(fs.readFileSync(path.join(path.dirname(notePath), '示意图.png')), Buffer.from('png-bytes'));
  assert.ok(knowledge.folderSync.localPathFor(knowledge.getDocument(diary.id, { diaryUnlocked: true })).includes(`${path.sep}日记${path.sep}`));
});

test('external edits, moves, additions and deletes reconcile by stable id', async (t) => {
  const { root, knowledge } = setup(t);
  const note = knowledge.createNote({ title: '原名', content: '旧内容', knowledgeBase: '资料' }).document;
  knowledge.folderSync.migrateAll({ rootPath: root });
  const originalPath = knowledge.folderSync.localPathFor(knowledge.getDocument(note.id, { diaryUnlocked: true }));
  const parsed = parseFrontMatter(fs.readFileSync(originalPath, 'utf8'));
  fs.writeFileSync(originalPath, serializeMarkdown({
    ...knowledge.getDocument(note.id, { diaryUnlocked: true }), title: '外部标题', content: `${parsed.content}\n外部修改`,
  }));
  await knowledge.folderSync.syncNow({ reason: 'test-edit' });
  assert.equal(knowledge.getDocument(note.id, { diaryUnlocked: true }).title, '外部标题');
  assert.match(knowledge.getDocument(note.id, { diaryUnlocked: true }).content, /外部修改/);

  const movedDir = path.join(root, '资料', '移动后');
  fs.mkdirSync(movedDir, { recursive: true });
  const movedPath = path.join(movedDir, '改名.md');
  fs.renameSync(originalPath, movedPath);
  await knowledge.folderSync.syncNow({ reason: 'test-move' });
  const moved = knowledge.getDocument(note.id, { diaryUnlocked: true });
  assert.equal(moved.folderPath, '移动后');
  assert.equal(moved.title, '外部标题');

  const externalPath = path.join(root, '资料', '普通外部笔记.md');
  fs.writeFileSync(externalPath, '# 无元数据也可以\n');
  await knowledge.folderSync.syncNow({ reason: 'test-add' });
  const external = knowledge.nativeDocuments().find(item => item.title === '普通外部笔记');
  assert.ok(external);
  assert.match(fs.readFileSync(externalPath, 'utf8'), new RegExp(`liuxu_id: ${JSON.stringify(external.id)}`));

  fs.unlinkSync(movedPath);
  await knowledge.folderSync.syncNow({ reason: 'test-delete' });
  assert.equal(knowledge.getDocument(note.id, { diaryUnlocked: true }), null);
});

test('external note moves copy relative image dependencies into the new folder', async (t) => {
  const { dir, root, knowledge } = setup(t);
  fs.mkdirSync(path.join(dir, 'uploads'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'uploads', '岗位.png'), Buffer.from('role-image'));
  const note = knowledge.createNote({ title: '岗位职责', content: '![岗位](/uploads/%E5%B2%97%E4%BD%8D.png)', knowledgeBase: '工作' }).document;
  knowledge.folderSync.migrateAll({ rootPath: root });
  const originalPath = knowledge.folderSync.localPathFor(knowledge.getDocument(note.id, { diaryUnlocked: true }));
  const movedDirectory = path.join(root, '工作', '岗位文件');
  fs.mkdirSync(movedDirectory, { recursive: true });
  const movedPath = path.join(movedDirectory, path.basename(originalPath));
  fs.renameSync(originalPath, movedPath);

  await knowledge.folderSync.syncNow({ reason: 'move-note-with-image' });

  assert.deepEqual(fs.readFileSync(path.join(movedDirectory, '岗位.png')), Buffer.from('role-image'));
  assert.match(knowledge.getDocument(note.id, { diaryUnlocked: true }).content, /\.\/%E5%B2%97%E4%BD%8D\.png/);
});

test('sync backfills database-only notes and copies legacy HTML images as local Markdown assets', async (t) => {
  const { dir, root, knowledge } = setup(t);
  const existing = knowledge.createNote({ title: '已有笔记', content: '用于启用本地同步' }).document;
  knowledge.folderSync.migrateAll({ rootPath: root });
  knowledge.folderSync.configure({ enabled: false, rootPath: root });

  fs.mkdirSync(path.join(dir, 'uploads'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'uploads', 'legacy.png'), Buffer.from('legacy-image-bytes'));
  const note = knowledge.createNote({
    title: '9.21',
    knowledgeBase: '虎扑',
    folderPath: '工作',
    content: '记录正文\n\n<img src="/uploads/legacy.png" width="300">',
  }).document;
  knowledge.folderSync.configure({ enabled: true, rootPath: root });

  const snapshot = await knowledge.folderSync.syncNow({ reason: 'backfill-database-only-note' });
  const synced = knowledge.getDocument(note.id, { diaryUnlocked: true });
  const notePath = knowledge.folderSync.localPathFor(synced);
  assert.equal(snapshot.report.added, 1);
  assert.ok(notePath.endsWith(path.join('虎扑', '工作', '9.21.md')));
  assert.match(synced.content, /!\[image\]\(\.\/legacy\.png\)/);
  assert.match(fs.readFileSync(notePath, 'utf8'), /!\[image\]\(\.\/legacy\.png\)/);
  assert.deepEqual(fs.readFileSync(path.join(path.dirname(notePath), 'legacy.png')), Buffer.from('legacy-image-bytes'));
  assert.ok(knowledge.folderSync.localPathFor(knowledge.getDocument(existing.id, { diaryUnlocked: true })));
});

test('disk changes win application save conflicts and preserve the draft', (t) => {
  const { root, knowledge } = setup(t);
  const note = knowledge.createNote({ title: '冲突', content: '数据库正文' }).document;
  knowledge.folderSync.migrateAll({ rootPath: root });
  const current = knowledge.getDocument(note.id, { diaryUnlocked: true });
  const notePath = knowledge.folderSync.localPathFor(current);
  fs.writeFileSync(notePath, serializeMarkdown({ ...current, content: '磁盘正文' }));
  const result = knowledge.updateDocument(note.id, { content: '编辑器草稿', baseVersion: current.version }, { diaryUnlocked: true });
  assert.equal(result.status, 409);
  assert.equal(result.draftSaved, true);
  assert.equal(knowledge.folderSync.listDrafts().length, 1);
  assert.equal(parseFrontMatter(fs.readFileSync(notePath, 'utf8')).content, '磁盘正文');
});

test('folder migration stops before writing when a local image dependency is missing', (t) => {
  const { root, knowledge } = setup(t);
  knowledge.createNote({ title: '缺失图片', content: '![图](/uploads/not-found.png)' });
  assert.throws(() => knowledge.folderSync.migrateAll({ rootPath: root }), error => {
    assert.match(error.message, /缺失图片依赖/);
    assert.equal(error.report.missingDependencies[0].source, '/uploads/not-found.png');
    return true;
  });
  assert.equal(fs.readdirSync(root).length, 0);
  assert.equal(knowledge.folderSync.config.enabled, false);
  assert.equal(knowledge.nativeDocuments().length, 1);
});

test('images referenced by deleted notes stay beside the note without becoming orphan knowledge files', async (t) => {
  const { dir, root, knowledge } = setup(t);
  fs.mkdirSync(path.join(dir, 'uploads'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'uploads', 'shared.png'), Buffer.from('shared-image'));
  const note = knowledge.createNote({ title: '带图片', content: '![图](/uploads/shared.png)' }).document;
  knowledge.folderSync.migrateAll({ rootPath: root });
  const notePath = knowledge.folderSync.localPathFor(knowledge.getDocument(note.id, { diaryUnlocked: true }));
  const imagePath = path.join(path.dirname(notePath), 'shared.png');
  fs.unlinkSync(notePath);
  await knowledge.folderSync.syncNow({ reason: 'delete-note-with-image' });
  assert.equal(knowledge.getDocument(note.id, { diaryUnlocked: true }), null);
  assert.equal(fs.existsSync(imagePath), true);
  assert.equal(knowledge.nativeDocuments().some(item => item.fileMeta?.filename === 'shared.png'), false);
});

test('duplicate front matter ids create a new identity instead of stealing a note', async (t) => {
  const { root, knowledge } = setup(t);
  const note = knowledge.createNote({ title: '一号', content: 'A' }).document;
  knowledge.folderSync.migrateAll({ rootPath: root });
  const firstPath = knowledge.folderSync.localPathFor(knowledge.getDocument(note.id, { diaryUnlocked: true }));
  const duplicatePath = path.join(path.dirname(firstPath), '副本.md');
  fs.copyFileSync(firstPath, duplicatePath);
  await knowledge.folderSync.syncNow({ reason: 'duplicate-id' });
  const notes = knowledge.nativeDocuments().filter(item => item.sourceType === 'note');
  assert.equal(notes.length, 2);
  assert.equal(new Set(notes.map(item => item.id)).size, 2);
  assert.notEqual(parseFrontMatter(fs.readFileSync(duplicatePath, 'utf8')).metadata.liuxu_id, note.id);
});

test('offline migration script creates a verified backup before switching the folder root', (t) => {
  const { db, dir } = createTempDatabase(t, 'knowledge-folder-script-db-');
  const knowledge = createKnowledgeService(db);
  knowledge.createNote({ title: '脚本迁移', content: '离线迁移正文', knowledgeBase: '资料' });
  knowledge.folderSync.stop();
  db.close();
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-folder-script-out-'));
  const root = path.join(parent, '留序知识库');
  const backup = path.join(parent, '备份');
  t.after(() => cleanupTempDataDir(parent));
  const output = execFileSync(process.execPath, [
    path.join(__dirname, '..', 'scripts', 'migrate-knowledge-folder.cjs'),
    '--data-dir', dir,
    '--user-data', dir,
    '--root', root,
    '--backup-dir', backup,
  ], { encoding: 'utf8' });
  const report = JSON.parse(output);
  assert.equal(report.documents, 1);
  assert.equal(report.rootPath, root);
  assert.equal(fs.existsSync(path.join(backup, 'backup-manifest.json')), true);
  assert.equal(fs.existsSync(path.join(backup, 'migration-report.json')), true);
  assert.match(fs.readFileSync(path.join(root, '资料', '脚本迁移.md'), 'utf8'), /离线迁移正文/);
  const config = JSON.parse(fs.readFileSync(path.join(dir, '.knowledge-folder.json'), 'utf8'));
  assert.equal(config.rootPath, root);
  assert.equal(config.enabled, true);
});

test('offline migration records missing dependencies and leaves the source database intact', (t) => {
  const { db, dir } = createTempDatabase(t, 'knowledge-folder-missing-db-');
  const knowledge = createKnowledgeService(db);
  knowledge.createNote({ title: '缺图', content: '![图](/uploads/missing.png)' });
  knowledge.folderSync.stop();
  db.close();
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-folder-missing-out-'));
  const root = path.join(parent, '知识库');
  const backup = path.join(parent, '备份');
  t.after(() => cleanupTempDataDir(parent));
  assert.throws(() => execFileSync(process.execPath, [
    path.join(__dirname, '..', 'scripts', 'migrate-knowledge-folder.cjs'),
    '--data-dir', dir,
    '--user-data', dir,
    '--root', root,
    '--backup-dir', backup,
  ], { encoding: 'utf8' }), error => {
    assert.match(error.stderr, /缺失图片依赖/);
    return true;
  });
  const preflight = JSON.parse(fs.readFileSync(path.join(backup, 'migration-preflight-report.json'), 'utf8'));
  assert.equal(preflight.success, false);
  assert.equal(preflight.missingDependencies.length, 1);
  assert.equal(fs.existsSync(root), false);
  const restoredDb = new Database(path.join(dir, 'schedule.db'), { readonly: true });
  assert.equal(restoredDb.prepare('SELECT COUNT(*) AS count FROM knowledge_documents').get().count, 1);
  assert.equal(restoredDb.pragma('integrity_check', { simple: true }), 'ok');
  restoredDb.close();
});
