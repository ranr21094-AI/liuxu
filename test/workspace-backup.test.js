const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const JSZip = require('jszip');
const { exportWorkspace, restoreWorkspace, workspaceCapacity } = require('../lib/workspace/zip');
const { createKnowledgeService } = require('../lib/knowledge/documents');
const { createTempDatabase, cleanupTempDataDir } = require('./db-temp');
const { resetSecretStoreForTests } = require('../secret-store');

function tempDb(t) {
  const { db, dir } = createTempDatabase(t, 'workspace-');
  db.create({ title: 'zip log', content: 'body', category: '开发', log_date: '2026-05-16' });
  fs.mkdirSync(path.join(dir, 'uploads'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'uploads', 'pic.png'), Buffer.from([1, 2, 3]));
  return { db, dir };
}

test('workspace capacity preflight reports exported database, files, entries and safe limits', t => {
  const { db } = tempDb(t);
  const capacity = workspaceCapacity(db);
  assert.equal(capacity.canExport, true);
  assert.ok(capacity.databaseBytes > 0);
  assert.equal(capacity.fileBytes, 3);
  assert.equal(capacity.entries, 7);
  assert.ok(capacity.estimatedUncompressedBytes >= capacity.databaseBytes);
  assert.ok(capacity.limits.entries >= 100000);
});

test('workspace zip export includes binaries and restores them', async (t) => {
  const { db, dir } = tempDb(t);
  const knowledge = createKnowledgeService(db);
  const note = knowledge.createNote({ title: 'ZIP 知识', content: '知识正文' }).document;
  knowledge.createNamedRevision(note.id, { name: 'ZIP 命名版本', baseVersion: note.version });
  const buffer = await exportWorkspace(db);
  assert.ok(buffer.length > 20);
  fs.rmSync(path.join(dir, 'uploads'), { recursive: true, force: true });
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-b-'));
  process.env.AI_SECRETS_KEY_FILE = path.join(other, 'ai-secrets.key');
  const { createDatabase } = require('../database.js');
  const db2 = createDatabase(other);
  t.after(() => {
    db2.close();
    cleanupTempDataDir(other);
  });
  const result = await restoreWorkspace(db2, buffer);
  assert.equal(result.success, true);
  assert.equal(result.includesBinaries, true);
  assert.ok(fs.existsSync(path.join(other, 'uploads', 'pic.png')));
  const restoredKnowledge = createKnowledgeService(db2);
  assert.equal(restoredKnowledge.allDocuments().length, 1);
  assert.equal(restoredKnowledge.allDocuments()[0].title, 'ZIP 知识');
  assert.equal(restoredKnowledge.listRevisions(note.id).revisions[0].name, 'ZIP 命名版本');
});

test('workspace zip carries the portable knowledge folder tree and restores it to the configured local root', async (t) => {
  const { db, dir } = createTempDatabase(t, 'workspace-folder-source-');
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-folder-source-root-'));
  t.after(() => fs.rmSync(sourceRoot, { recursive: true, force: true }));
  const sourceKnowledge = createKnowledgeService(db);
  sourceKnowledge.createNote({ title: '本地笔记', content: '来自文件夹', knowledgeBase: '资料' });
  sourceKnowledge.folderSync.migrateAll({ rootPath: sourceRoot });
  sourceKnowledge.folderSync.stop();
  fs.mkdirSync(path.join(sourceRoot, '资料', '空文件夹'), { recursive: true });

  const buffer = await exportWorkspace(db);
  const zip = await JSZip.loadAsync(buffer);
  assert.ok(zip.file('knowledge-folder/资料/本地笔记.md'));
  assert.ok(zip.folder('knowledge-folder/资料/空文件夹'));
  const workspace = JSON.parse(await zip.file('workspace.json').async('string'));
  assert.deepEqual(workspace.knowledgeFolder, { included: true, portable: true });
  assert.equal(JSON.stringify(workspace).includes(sourceRoot), false);

  const { db: targetDb, dir: targetDir } = createTempDatabase(t, 'workspace-folder-target-');
  const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-folder-target-root-'));
  t.after(() => fs.rmSync(targetRoot, { recursive: true, force: true }));
  fs.writeFileSync(path.join(targetRoot, 'before.txt'), 'keep in restore backup');
  fs.writeFileSync(path.join(targetDir, '.knowledge-folder.json'), JSON.stringify({ enabled: true, rootPath: targetRoot }));
  const result = await restoreWorkspace(targetDb, buffer, 'replace');
  assert.equal(result.knowledgeFolderRestored, true);
  assert.ok(result.knowledgeFolderBackupPath);
  assert.equal(fs.readFileSync(path.join(targetRoot, '资料', '本地笔记.md'), 'utf8').includes('来自文件夹'), true);
  assert.equal(fs.existsSync(path.join(targetRoot, '资料', '空文件夹')), true);
  assert.equal(fs.readFileSync(path.join(result.knowledgeFolderBackupPath, 'before.txt'), 'utf8'), 'keep in restore backup');
  fs.rmSync(result.knowledgeFolderBackupPath, { recursive: true, force: true });
});

test('file-workspace ZIP uses workspace originals instead of the legacy attachment mirror', async t => {
  const { db, dir } = tempDb(t);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-files-mode-root-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'local.md'), 'workspace original');
  fs.mkdirSync(path.join(root, '.liuxu'), { recursive: true });
  fs.writeFileSync(path.join(root, '.liuxu', 'storage.json'), JSON.stringify({ format: 'liuxu-file-workspace', version: 1 }));
  fs.writeFileSync(path.join(dir, '.knowledge-file-workspace.json'), JSON.stringify({ format: 'liuxu-file-workspace', version: 1, rootPath: root }));
  fs.writeFileSync(path.join(dir, '.knowledge-folder.json'), JSON.stringify({ enabled: true, rootPath: root }));
  fs.mkdirSync(path.join(dir, 'knowledge-files'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'knowledge-files', 'legacy-copy.bin'), 'old mirror');

  const archive = await exportWorkspace(db, { knowledgeRootOverride: root });
  const zip = await JSZip.loadAsync(archive);
  const names = Object.keys(zip.files);
  const manifest = JSON.parse(await zip.file('workspace.json').async('string'));
  assert.equal(manifest.knowledgeStorage, 'liuxu-file-workspace');
  assert.ok(zip.file('knowledge-folder/local.md'));
  assert.equal(names.some(name => name.startsWith('knowledge-files/')), false);
  assert.equal(workspaceCapacity(db).fileBytes, 3 + Buffer.byteLength('workspace original')
    + fs.statSync(path.join(root, '.liuxu', 'storage.json')).size);
});

test('workspace merge refuses knowledge-folder symlink escapes and rolls back partial file installation', async (t) => {
  const { db: sourceDb } = createTempDatabase(t, 'workspace-merge-folder-source-');
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-merge-folder-source-root-'));
  t.after(() => fs.rmSync(sourceRoot, { recursive: true, force: true }));
  const sourceKnowledge = createKnowledgeService(sourceDb);
  sourceKnowledge.createNote({ title: '先写入', content: 'A', knowledgeBase: 'A' });
  sourceKnowledge.createNote({ title: '后写入', content: 'B', knowledgeBase: 'B' });
  sourceKnowledge.folderSync.migrateAll({ rootPath: sourceRoot });
  sourceKnowledge.folderSync.stop();
  const buffer = await exportWorkspace(sourceDb);

  const { db: targetDb, dir: targetDir } = createTempDatabase(t, 'workspace-merge-folder-target-');
  const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-merge-folder-target-root-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-merge-folder-outside-'));
  t.after(() => {
    fs.rmSync(targetRoot, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(targetDir, '.knowledge-folder.json'), JSON.stringify({ enabled: true, rootPath: targetRoot }));
  fs.mkdirSync(path.join(targetRoot, 'B'));
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(targetRoot, 'B', '后写入.md'));

  await assert.rejects(() => restoreWorkspace(targetDb, buffer, 'merge'), /unsafe file/);
  assert.equal(fs.existsSync(path.join(targetRoot, 'A', '先写入.md')), false);
  assert.equal(fs.existsSync(path.join(outside, 'secret.txt')), false);
  assert.equal(createKnowledgeService(targetDb, { startFolderSync: false }).allDocuments().length, 0);

  fs.unlinkSync(path.join(targetRoot, 'B', '后写入.md'));
  fs.rmdirSync(path.join(targetRoot, 'B'));
  fs.symlinkSync(outside, path.join(targetRoot, 'B'));
  await assert.rejects(() => restoreWorkspace(targetDb, buffer, 'merge'), /unsafe directory/);
  assert.equal(fs.existsSync(path.join(outside, '后写入.md')), false);
});

test('SQLite workspace replace does not replay incompatible compatibility JSON', async (t) => {
  const { db } = tempDb(t);
  const zip = await JSZip.loadAsync(await exportWorkspace(db));
  const workspace = JSON.parse(await zip.file('workspace.json').async('string'));
  workspace.categories = [{
    name: '日记',
    sub: [{ name: '旧版嵌套分类', sub: [], calendar_day_visible: true }],
    calendar_day_visible: true,
  }];
  zip.file('workspace.json', JSON.stringify(workspace));
  const buffer = await zip.generateAsync({ type: 'nodebuffer' });

  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-sqlite-replace-'));
  process.env.AI_SECRETS_KEY_FILE = path.join(target, 'ai-secrets.key');
  const { createDatabase } = require('../database.js');
  const restored = createDatabase(target);
  t.after(() => {
    restored.close();
    cleanupTempDataDir(target);
  });

  const result = await restoreWorkspace(restored, buffer, 'replace');
  assert.equal(result.success, true);
  assert.equal(result.includesBinaries, true);
  assert.equal(restored.getAllUnpaginated().some(item => item.title === 'zip log'), true);
  assert.ok(fs.existsSync(path.join(target, 'uploads', 'pic.png')));
});

test('cross-device workspace restore clears only secrets encrypted with an unavailable key', async (t) => {
  const { db } = tempDb(t);
  const settings = db.getAiSettings();
  settings.imageProviders[0].apiKey = 'image-only-secret';
  db.saveAiSettings({ ...settings, apiKey: 'windows-only-secret' });
  db.saveTodoReminderSettings({
    ...db.getTodoReminderSettings(),
    smtp: {
      useCustomSmtp: true,
      host: 'smtp.example.com',
      port: 465,
      secureMode: 'ssl',
      authUser: 'sender@example.com',
      fromAddress: 'sender@example.com',
      password: 'smtp-only-secret',
    },
  });
  const buffer = await exportWorkspace(db);

  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-foreign-key-'));
  process.env.AI_SECRETS_KEY_FILE = path.join(target, 'mac-ai-secrets.key');
  resetSecretStoreForTests();
  const { createDatabase } = require('../database.js');
  const restored = createDatabase(target);
  t.after(() => {
    restored.close();
    cleanupTempDataDir(target);
    resetSecretStoreForTests();
  });

  const result = await restoreWorkspace(restored, buffer, 'replace');
  assert.equal(result.success, true);
  assert.equal(result.secretsReset, true);
  assert.equal(result.mailSecretsReset, true);
  assert.equal(restored.getAiSettings().apiKey, '');
  assert.equal(restored.getAiSettings().imageProviders.every(provider => provider.apiKey === ''), true);
  assert.equal(restored.getTodoReminderMailSettings().password, '');
  assert.equal(restored.getTodoReminderSettings().smtp.passwordConfigured, false);
  assert.equal(restored.getAllUnpaginated().some(item => item.title === 'zip log'), true);
});

test('ZIP merge keeps local-only knowledge notes and adds notes from the backup', async (t) => {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-merge-src-'));
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-merge-dst-'));
  process.env.AI_SECRETS_KEY_FILE = path.join(source, 'ai-secrets.key');
  const { createDatabase } = require('../database.js');
  const sourceDb = createDatabase(source);
  const sourceKnowledge = createKnowledgeService(sourceDb);
  sourceKnowledge.createNote({ title: '占位', content: '占 id' });
  sourceKnowledge.createNote({ title: '备份笔记', content: '来自 ZIP' });
  const buffer = await exportWorkspace(sourceDb);
  sourceDb.close();

  process.env.AI_SECRETS_KEY_FILE = path.join(target, 'ai-secrets.key');
  const targetDb = createDatabase(target);
  t.after(() => {
    targetDb.close();
    cleanupTempDataDir(source);
    cleanupTempDataDir(target);
  });
  const targetKnowledge = createKnowledgeService(targetDb);
  targetKnowledge.createNote({ title: '本地笔记', content: '不应消失' });
  const result = await restoreWorkspace(targetDb, buffer, 'merge');
  assert.equal(result.success, true);
  const merged = createKnowledgeService(targetDb).allDocuments();
  assert.equal(merged.some(item => item.title === '本地笔记'), true, merged.map(item => item.title).join(','));
  assert.equal(merged.some(item => item.title === '备份笔记'), true, merged.map(item => item.title).join(','));
});

test('corrupt ZIP schedule.db does not replace the live database', async (t) => {
  const { db } = tempDb(t);
  const knowledge = createKnowledgeService(db);
  knowledge.createNote({ title: '活库笔记', content: '保留' });
  const zip = await JSZip.loadAsync(await exportWorkspace(db));
  zip.file('schedule.db', Buffer.from('this is not a sqlite database'));
  const buffer = await zip.generateAsync({ type: 'nodebuffer' });
  await assert.rejects(() => restoreWorkspace(db, buffer, 'replace'), /corrupted/);
  const live = createKnowledgeService(db).allDocuments();
  assert.equal(live.some(item => item.title === '活库笔记'), true);
});

test('ZIP replace rebuilds the agent store on the new database connection', async (t) => {
  const { db } = tempDb(t);
  const { runtimeFor, invalidateAgentRuntime } = require('../lib/agent/routes');
  runtimeFor(db).store.createSession('导出会话');
  const buffer = await exportWorkspace(db);

  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-agent-reconnect-'));
  process.env.AI_SECRETS_KEY_FILE = path.join(target, 'ai-secrets.key');
  const { createDatabase } = require('../database.js');
  const restored = createDatabase(target);
  t.after(() => {
    restored.close();
    cleanupTempDataDir(target);
  });
  runtimeFor(restored).store.createSession('恢复前本地会话');
  const result = await restoreWorkspace(restored, buffer, 'replace');
  assert.equal(result.success, true);
  invalidateAgentRuntime(restored.dataDir);
  assert.doesNotThrow(() => runtimeFor(restored).store.listSessions());
  const titles = runtimeFor(restored).store.listSessions().map(item => item.title);
  assert.equal(titles.includes('导出会话'), true);
});

test('legacy ZIP replacement exits file mode instead of replaying newer originals', async t => {
  const { db } = createTempDatabase(t, 'legacy-replace-files-');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-replace-root-'));
  const backup = `${root}-migration-backup`;
  const legacy = createKnowledgeService(db, { startFolderSync: false });
  const note = legacy.createNote({ title: 'Original', content: 'backup text' }).document;
  const archive = await exportWorkspace(db);
  await legacy.folderSync.stop();
  await require('../lib/knowledge/file-workspace-migration').migrateFileWorkspace(db, { root, backupPath: backup });
  const routes = require('../lib/knowledge/routes');
  let service = routes.serviceFor(db).knowledge;
  t.after(async () => {
    await routes.shutdownKnowledgeServices();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(backup, { recursive: true, force: true });
  });
  await service.backgroundReady;
  const current = await service.getDocument(note.id);
  await service.updateDocument(note.id, { baseVersion: current.version, baseFingerprint: current.baseFingerprint, content: 'newer text' });
  const extra = (await service.createNote({ title: 'Extra', content: 'not in backup' })).document;
  await service.workspace.flushIndex();
  const restored = await restoreWorkspace(db, archive, 'replace');
  assert.equal(restored.success, true);
  service = routes.serviceFor(db).knowledge;
  assert.notEqual(service.storageMode, 'files');
  assert.equal((await service.getDocument(note.id)).content, 'backup text');
  assert.equal(await service.getDocument(extra.id), null);
  assert.equal(fs.existsSync(path.join(db.dataDir, '.knowledge-file-workspace.json')), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(db.dataDir, '.knowledge-folder.json'))).enabled, false);
});

test('the default database export remains usable after HTTP ZIP replacement', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'default-http-restore-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const script = `
    const assert = require('node:assert/strict');
    const db = require('./database');
    const { startServer } = require('./server');
    (async () => {
      const server = await startServer(0, '127.0.0.1');
      const origin = 'http://127.0.0.1:' + server.address().port;
      try {
        const created = await fetch(origin + '/api/knowledge/documents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Original', content: 'backup text' }) });
        assert.equal(created.status, 201);
        const exported = await fetch(origin + '/api/workspace/export');
        assert.equal(exported.status, 200);
        const form = new FormData(); form.append('archive', await exported.blob(), 'backup.zip');
        const oldConnection = db.sqlite;
        const restored = await fetch(origin + '/api/workspace/restore?mode=replace', { method: 'POST', headers: { Origin: origin }, body: form });
        assert.equal(restored.status, 200, await restored.text());
        assert.equal(oldConnection.open, false);
        assert.equal(db.sqlite.open, true);
        assert.notEqual(db.sqlite, oldConnection);
        const list = await fetch(origin + '/api/knowledge/documents');
        assert.equal(list.status, 200);
        assert.equal((await list.json()).total, 1);
        const exportedAgain = await fetch(origin + '/api/workspace/export');
        assert.equal(exportedAgain.status, 200); await exportedAgain.arrayBuffer();
      } finally {
        await require('./lib/knowledge/routes').shutdownKnowledgeServices();
        await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }); db.close();
      }
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  require('node:child_process').execFileSync(process.execPath, ['-e', script], {
    cwd: path.join(__dirname, '..'), timeout: 30000,
    env: { ...process.env, DATA_DIR: path.join(temp, 'data'), AI_SECRETS_KEY_FILE: path.join(temp, 'key') },
    stdio: 'pipe',
  });
});
