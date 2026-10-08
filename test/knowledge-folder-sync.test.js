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

test('graphical mindmaps retain metadata through sync, conflicts, revisions and backup', async (t) => {
  const { db, root, knowledge } = setup(t);
  const model = { version: 1, rootId: 'r', nodes: [{ id: 'r', text: '中心', x: 0, y: 0 }, { id: 'a', text: '分支', x: -200, y: 0, side: 'left', collapsed: true }], edges: [{ source: 'r', target: 'a' }], canvas: { width: 500, height: 300 } };
  const note = knowledge.createNote({ title: '导图同步', documentRole: 'mindmap', content: JSON.stringify(model) }).document;
  knowledge.folderSync.migrateAll({ rootPath: root });
  const current = knowledge.getDocument(note.id);
  const localPath = knowledge.folderSync.localPathFor(current);
  assert.equal(parseFrontMatter(fs.readFileSync(localPath, 'utf8')).content, current.content);
  const external = structuredClone(model); external.nodes[1].text = '本地更新';
  fs.writeFileSync(localPath, serializeMarkdown({ ...current, content: JSON.stringify(external) }));
  const draft = structuredClone(model); draft.nodes[1].text = '未写入草稿';
  const conflict = knowledge.updateDocument(note.id, { content: JSON.stringify(draft), baseVersion: current.version });
  assert.equal(conflict.status, 409); assert.equal(conflict.draftSaved, true);
  await knowledge.folderSync.syncNow({ reason: 'mindmap-test' });
  const synced = knowledge.getDocument(note.id);
  assert.deepEqual(JSON.parse(synced.content), external);
  assert.equal(synced.documentRole, 'mindmap');
  const snapshot = db.backup(); db.restore(snapshot);
  assert.deepEqual(JSON.parse(knowledge.getDocument(note.id).content), external);
});

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

test('moving a knowledge folder moves its synchronized Markdown subtree', (t) => {
  const { db, root, knowledge } = setup(t);
  db.addCategory('来源库');
  db.addCategory('目标库');
  db.addCategory('项目', '来源库');
  db.addCategory('子项', '来源库/项目');
  const note = knowledge.createNote({
    title: '移动中的笔记',
    content: '内容保留',
    knowledgeBase: '来源库',
    folderPath: '项目/子项',
  }).document;
  knowledge.folderSync.migrateAll({ rootPath: root });
  const oldPath = knowledge.folderSync.localPathFor(knowledge.getDocument(note.id, { diaryUnlocked: true }));

  const moved = db.moveCategory('来源库/项目', '目标库');
  knowledge.rewriteCollectionPath(moved.oldPath, moved.newPath);
  knowledge.folderSync.removeCollectionDirectory(moved.oldPath, 'folder-moved');
  knowledge.folderSync.ensureDirectoryTree();

  const updated = knowledge.getDocument(note.id, { diaryUnlocked: true });
  const nextPath = knowledge.folderSync.localPathFor(updated);
  assert.equal(updated.collectionPath, '目标库/项目/子项');
  assert.ok(nextPath.endsWith(path.join('目标库', '项目', '子项', '移动中的笔记.md')));
  assert.equal(fs.readFileSync(nextPath, 'utf8').includes('内容保留'), true);
  assert.equal(fs.existsSync(oldPath), false);
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
  assert.match(synced.content, /<img src="\.\/legacy\.png" width="300">/);
  assert.match(fs.readFileSync(notePath, 'utf8'), /<img src="\.\/legacy\.png" width="300">/);
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

test('file previews reject a symlink that escapes the synchronized knowledge root', (t) => {
  const { root, knowledge } = setup(t);
  const file = knowledge.saveImportedFile({
    buffer: Buffer.from('original-file'), filename: 'guide.txt', mimeType: 'text/plain',
    title: '指南', knowledgeBase: '资料', text: 'original-file', diaryUnlocked: false,
  }).document;
  knowledge.folderSync.migrateAll({ rootPath: root });
  const synced = knowledge.getDocument(file.id);
  const localPath = knowledge.folderSync.localPathFor(synced);
  const outside = path.join(path.dirname(root), `${path.basename(root)}-outside.txt`);
  fs.writeFileSync(outside, 'private-file');
  t.after(() => fs.rmSync(outside, { force: true }));
  fs.unlinkSync(localPath);
  fs.symlinkSync(outside, localPath);
  assert.equal(knowledge.filePathFor(synced), null);
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

test('HTML image dimensions survive colocated copying, note moves and external synchronization',async(t)=>{
 const {dir,root,knowledge}=setup(t);fs.mkdirSync(path.join(dir,'uploads'),{recursive:true});fs.writeFileSync(path.join(dir,'uploads','尺寸.png'),Buffer.from('image'));
 const note=knowledge.createNote({title:'图片尺寸',content:'<img src="/uploads/%E5%B0%BA%E5%AF%B8.png" width="350" alt="中文">\n<img src="/uploads/%E5%B0%BA%E5%AF%B8.png" style="width:50%;height:auto">\n`<img src="/uploads/example.png">`',knowledgeBase:'图片'}).document;
 knowledge.folderSync.migrateAll({rootPath:root});let current=knowledge.getDocument(note.id);
 assert.match(current.content,/width="350"/);assert.match(current.content,/style="width:50%;height:auto"/);assert(current.content.includes('`<img src="/uploads/example.png">`'));
 const moved=knowledge.updateDocument(note.id,{folderPath:'新目录',baseVersion:current.version});assert.equal(moved.status,undefined);current=knowledge.getDocument(note.id);
 const local=knowledge.folderSync.localPathFor(current);assert(fs.existsSync(path.join(path.dirname(local),'尺寸.png')));
 const named=knowledge.createNamedRevision(note.id,{baseVersion:current.version,name:'原始图片尺寸'});
 const external=current.content.replace('width="350"','width="280"');fs.writeFileSync(local,serializeMarkdown({...current,content:external}));await knowledge.folderSync.syncNow({reason:'size-test'});
 assert.match(knowledge.getDocument(note.id).content,/width="280"/);assert.match(knowledge.getDocument(note.id).content,/style="width:50%;height:auto"/);
 const restored=knowledge.restoreRevision(note.id,named.revision.id,{baseVersion:knowledge.getDocument(note.id).version,restoreLocation:false});
 assert.equal(restored.status,undefined);assert.match(knowledge.getDocument(note.id).content,/width="350"/);
 assert.match(fs.readFileSync(local,'utf8'),/width="350"/);
});

test('sync skips nested app bundles but preserves ordinary files and excluded legacy records', async t => {
  const { root, knowledge } = setup(t);
  knowledge.folderSync.configure({ enabled: true, rootPath: root });
  await knowledge.folderSync.syncNow();
  knowledge.folderSync.stop();
  for (const bundle of ['Blender.app', 'nested/OTHER.APP']) {
    fs.mkdirSync(path.join(root, '项目', bundle, 'Contents'), { recursive: true });
    fs.writeFileSync(path.join(root, '项目', bundle, 'Contents', 'secret.txt'), 'bundle internals');
  }
  fs.writeFileSync(path.join(root, '项目', 'ordinary.txt'), 'ordinary content');
  fs.writeFileSync(path.join(root, '项目', 'ordinary.app'), 'ordinary app-named file');
  await knowledge.folderSync.syncNow();
  assert.equal(knowledge.allDocuments({ diaryUnlocked: true }).length, 1);
  assert.ok(knowledge.folderSync.scanFiles().nameOnlyEntries.some(file => file.relativePath === '项目/ordinary.app'));
  fs.unlinkSync(path.join(root, '项目', 'ordinary.app'));
  const old = knowledge.createNote({ title: 'legacy' }).document;
  fs.unlinkSync(knowledge.folderSync.localPathFor(old));
  const excluded = '项目/Blender.app/Contents/legacy.txt';
  knowledge.folderSync.manifest[old.id] = { relativePath: excluded, sourceType: 'file' };
  fs.rmSync(path.join(root, '项目', 'Blender.app'), { recursive: true });
  const second = await knowledge.folderSync.syncNow();
  assert.equal(second.report.deleted, 0);
  assert.ok(knowledge.getDocument(old.id));
  assert.equal(knowledge.folderSync.manifest[old.id].relativePath, excluded);
  assert.ok(!knowledge.folderSync.scanFiles().directories.some(value => /\.app(?:\/|$)/i.test(value)));
});

test('bundle filesystem notifications do not schedule a sync', async t => {
  let notify;
  t.mock.method(fs, 'watch', (_root, _options, callback) => {
    notify = callback;
    return { close() {}, on() {} };
  });
  const { root, knowledge } = setup(t);
  knowledge.folderSync.configure({ enabled: true, rootPath: root });
  await knowledge.folderSync.syncNow();
  knowledge.folderSync.stop();
  const bundle = path.join(root, 'Blender.APP', 'Contents');
  fs.mkdirSync(bundle, { recursive: true });
  knowledge.folderSync.restartWatcher();
  notify('change', 'Blender.APP/Contents/changed.txt');
  notify('rename', 'Blender.APP');
  notify('rename', 'removed.app');
  assert.equal(knowledge.folderSync.debounceTimer, null);
  notify('change', 'ordinary.txt');
  assert.ok(knowledge.folderSync.debounceTimer);
});

test('bulk sync serves an HTTP request before imports finish and uses the parent index', async t => {
  const http = require('node:http');
  const { db, root, knowledge } = setup(t);
  knowledge.folderSync.configure({ enabled: true, rootPath: root });
  await knowledge.folderSync.syncNow();
  knowledge.folderSync.stop();
  fs.mkdirSync(path.join(root, '批量'), { recursive: true });
  for (let i = 0; i < 100; i++) fs.writeFileSync(path.join(root, '批量', `${i}.txt`), `content ${i}`);
  const server = http.createServer((_req, res) => res.end('responsive'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  let done = false;
  const response = fetch(`http://127.0.0.1:${server.address().port}`).then(async result => {
    assert.equal(await result.text(), 'responsive');
    assert.equal(done, false);
  });
  const sync = knowledge.folderSync.syncNow().then(result => { done = true; return result; });
  await response;
  assert.equal((await sync).report.added, 100);
  const plan = db.sqlite.prepare("EXPLAIN QUERY PLAN SELECT body FROM knowledge_documents WHERE json_extract(body, '$.parentDocumentId') = ? ORDER BY rowid").all('file:1');
  assert.ok(plan.some(row => row.detail.includes('idx_knowledge_documents_parent')));
});

test('extension whitelist keeps excluded files as read-only names without copying or extracting', async t => {
  const { db, dir, root, knowledge } = setup(t);
  fs.mkdirSync(path.join(root, '项目', 'Tool.app', 'Contents'), { recursive: true });
  fs.writeFileSync(path.join(root, '项目', 'Tool.app', 'Contents', 'internal.py'), 'internal');
  fs.writeFileSync(path.join(root, '项目', 'main.CPP'), 'int main() { return 0; }');
  fs.writeFileSync(path.join(root, '项目', 'data.zip'), 'not a zip');
  fs.writeFileSync(path.join(root, '项目', 'unknown.bin'), 'unknown');
  fs.writeFileSync(path.join(root, '项目', 'README'), 'no extension');
  fs.mkdirSync(path.join(root, '日记'));
  fs.writeFileSync(path.join(root, '日记', 'secret.bin'), 'private');
  knowledge.folderSync.configure({ enabled: true, rootPath: root });
  await knowledge.folderSync.syncNow();
  const docs = knowledge.allDocuments({ diaryUnlocked: true });
  assert.equal(docs.length, 1);
  assert.equal(docs[0].title, 'main.CPP');
  assert.equal(docs[0].content, 'int main() { return 0; }');
  assert.equal(fs.readdirSync(path.join(dir, 'knowledge-files')).length, 1);
  assert.deepEqual(knowledge.folderSync.listNameOnlyEntries({ knowledgeBase: '项目' }).map(entry => entry.name).sort(), ['README', 'Tool.app', 'data.zip', 'unknown.bin']);
  assert.deepEqual(knowledge.folderSync.listNameOnlyEntries({ knowledgeBase: '日记' }), []);
  assert.equal(knowledge.folderSync.listNameOnlyEntries({ knowledgeBase: '日记', diaryUnlocked: true }).length, 1);
  const before = knowledge.folderSync.snapshot().syncExtensions;
  assert.throws(() => knowledge.folderSync.configure({ enabled: true, rootPath: root, syncExtensions: ['.exe'] }), /不支持/);
  assert.deepEqual(knowledge.folderSync.snapshot().syncExtensions, before);
  // Excluding an existing imported file preserves its last stored snapshot.
  knowledge.folderSync.configure({ enabled: true, rootPath: root, syncExtensions: ['.TXT'] });
  await knowledge.folderSync.syncNow();
  fs.unlinkSync(path.join(root, '项目', 'main.CPP'));
  await knowledge.folderSync.syncNow();
  assert.ok(knowledge.getDocument(docs[0].id));
  assert.deepEqual(knowledge.folderSync.snapshot().syncExtensions, ['.md', '.txt']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, '.knowledge-folder.json'))).syncExtensions, ['.md', '.txt']);
  assert.equal(db.sqlite.prepare('SELECT count(*) n FROM knowledge_documents').get().n, 1);
});

test('bundle names do not duplicate expandable historical folders while retained notes remain readable', t => {
  const { db, knowledge } = setup(t);
  const note = knowledge.createNote({ title: 'Retained README', knowledgeBase: '项目', folderPath: 'Tool.APP/Contents', content: 'keep' }).document;
  const { treeForDocuments } = require('../lib/knowledge/routes');
  const tree = treeForDocuments([{ name: '项目', sub: [{ name: 'Tool.APP', sub: [{ name: 'Contents', sub: [] }] }, { name: '正常', sub: [] }] }], [note], db, { hideAppBundles: true });
  assert.deepEqual(tree[0].folders.map(folder => folder.name), ['正常']);
  assert.equal(tree[0].documentCount, 0);
  assert.equal(knowledge.getDocument(note.id).content, 'keep');
});
