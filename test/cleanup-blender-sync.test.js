const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createTempDatabase } = require('./db-temp');
const { createKnowledgeService } = require('../lib/knowledge/documents');
const { cleanupBlenderSync, PREFIX } = require('../scripts/cleanup-blender-sync.cjs');
const { createSearchIndex } = require('../lib/knowledge/search');

function fixture(t) {
  const { db, dir } = createTempDatabase(t, 'blender-cleanup-');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blender-root-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const knowledge = createKnowledgeService(db, { startFolderSync: false });
  const create = (id, relativePath, extra = {}) => {
    const doc = { id, sourceType: 'file', title: id === 'file:1' ? 'uniqueblenderinternals' : id,
      content: id === 'file:1' ? 'uniqueblenderinternals' : '', status: 'active', visibility: 'standard',
      version: 1, collectionPath: 'Agent', knowledgeBase: 'Agent', folderPath: '',
      fileSync: { relativePath }, ...extra };
    db.sqlite.prepare('INSERT INTO knowledge_documents(id, body) VALUES (?, ?)').run(id, JSON.stringify(doc));
    return doc;
  };
  const records = [create('file:1', PREFIX + 'code.py'), create('file:2', PREFIX + 'annotated.py'),
    create('file:3', 'Agent/设计/haibara-card/tools/Blender.app-other/keep.txt'),
    create('note:1', PREFIX + 'note.md', { sourceType: 'note', documentRole: 'normal' }),
    create('note:2', 'Agent/批注.md', { sourceType: 'note', documentRole: 'annotation', parentDocumentId: 'file:2' })];
  fs.mkdirSync(path.join(root, '.liuxu'));
  fs.writeFileSync(path.join(root, '.liuxu', 'manifest.json'), JSON.stringify({ version: 1, documents: Object.fromEntries(records.map(doc => [doc.id, doc.fileSync])), assets: [] }));
  fs.writeFileSync(path.join(dir, '.knowledge-folder.json'), JSON.stringify({ enabled: false, rootPath: root }));
  fs.mkdirSync(path.join(root, PREFIX), { recursive: true });
  fs.writeFileSync(path.join(root, PREFIX, 'code.py'), 'original program');
  fs.mkdirSync(path.join(dir, 'knowledge-files'));
  fs.writeFileSync(path.join(dir, 'knowledge-files', 'copy.py'), 'stored copy');
  return { db, dir, root, knowledge };
}

test('offline cleanup backs up and removes only unannotated Blender imports, updating search and links', async t => {
  const { db, dir, root, knowledge } = fixture(t);
  const search = createSearchIndex(knowledge);
  // Build the search and link indexes before removal to exercise invalidation.
  search.search('uniqueblenderinternals', { diaryUnlocked: true });
  db.sqlite.prepare("INSERT INTO knowledge_link_targets(document_id, normalized_title, title) VALUES ('file:1', 'uniqueblenderinternals', 'uniqueblenderinternals')").run();
  db.sqlite.prepare("INSERT INTO knowledge_links(source_document_id,target_document_id,resolved) VALUES ('note:1','file:1',1)").run();
  const dry = await cleanupBlenderSync({ dataDir: dir });
  assert.deepEqual(dry.remove.map(row => row.id), ['file:1']);
  assert.deepEqual(dry.retainedWithChildren.map(row => row.id), ['file:2']);
  assert.ok(knowledge.getDocument('file:1'));
  const backupDir = path.join(root, 'backup');
  const result = await cleanupBlenderSync({ dataDir: dir, backupDir, apply: true });
  assert.equal(result.applied, true);
  assert.equal(knowledge.getDocument('file:1'), null);
  for (const id of ['file:2', 'file:3', 'note:1', 'note:2']) assert.ok(knowledge.getDocument(id));
  assert.equal(db.sqlite.prepare("SELECT count(*) n FROM knowledge_link_targets WHERE document_id='file:1'").get().n, 0);
  assert.deepEqual(db.sqlite.prepare("SELECT target_document_id, resolved FROM knowledge_links WHERE source_document_id='note:1'").get(), { target_document_id: null, resolved: 0 });
  const manifest = JSON.parse(fs.readFileSync(path.join(root, '.liuxu', 'manifest.json')));
  assert.equal(manifest.documents['file:1'], undefined);
  assert.ok(manifest.documents['file:2']);
  assert.equal(fs.readFileSync(path.join(root, PREFIX, 'code.py'), 'utf8'), 'original program');
  assert.equal(fs.readFileSync(path.join(dir, 'knowledge-files', 'copy.py'), 'utf8'), 'stored copy');
  assert.ok(fs.existsSync(path.join(backupDir, 'schedule.db')));
  const hits = search.search('uniqueblenderinternals', { diaryUnlocked: true });
  assert.ok(!JSON.stringify(hits).includes('file:1'));
});

test('cleanup refuses enabled sync and rolls back database and manifest on failure', async t => {
  const { db, dir, root, knowledge } = fixture(t);
  const configPath = path.join(dir, '.knowledge-folder.json');
  fs.writeFileSync(configPath, JSON.stringify({ enabled: true, rootPath: root }));
  await assert.rejects(cleanupBlenderSync({ dataDir: dir, backupDir: path.join(root, 'backup'), apply: true }), /Pause/);
  fs.writeFileSync(configPath, JSON.stringify({ enabled: false, rootPath: root }));
  const before = JSON.parse(fs.readFileSync(path.join(root, '.liuxu', 'manifest.json')));
  db.sqlite.exec("CREATE TRIGGER fail_cleanup BEFORE DELETE ON knowledge_documents BEGIN SELECT RAISE(ABORT,'injected failure'); END");
  await assert.rejects(cleanupBlenderSync({ dataDir: dir, backupDir: path.join(root, 'backup'), apply: true }), /injected failure/);
  assert.ok(knowledge.getDocument('file:1'));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, '.liuxu', 'manifest.json'))), before);
});
