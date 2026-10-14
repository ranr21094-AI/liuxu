const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
// database.js constructs its default instance on import; isolate that instance too.
const bootstrap = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-test-bootstrap-'));
process.env.DATA_DIR = bootstrap;
process.env.AI_SECRETS_KEY_FILE = path.join(bootstrap, 'ai-secrets.key');
const database = require('../database');
const { createDatabase } = database;
test.after(() => { database.close(); fs.rmSync(bootstrap, { recursive: true, force: true }); });
const { createKnowledgeService } = require('../lib/knowledge/documents');
const { serializeMarkdown, parseFrontMatter } = require('../lib/knowledge/folder-sync');

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-incremental-db-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-incremental-root-'));
  const db = createDatabase(dir);
  let notify;
  t.mock.method(fs, 'watch', (_root, _options, callback) => {
    notify = callback;
    return { close() {}, on() {} };
  });
  const k = createKnowledgeService(db);
  const services = [k];
  t.after(async () => {
    for (const service of services) await service.folderSync.shutdown();
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const restart = async () => {
    await services.at(-1).folderSync.stop();
    const next = createKnowledgeService(db);
    services.push(next);
    await next.folderSync.syncNow();
    return next;
  };
  return { db, dir, root, k, restart, notify: (...args) => notify(...args) };
}

test('watch processes one file, validates self-writes, and preserves unrelated directories', async t => {
  const { k, root, notify } = setup(t);
  const a = k.createNote({ title: 'a', knowledgeBase: 'A', content: 'alpha' }).document;
  const b = k.createNote({ title: 'b', knowledgeBase: 'B', content: 'beta' }).document;
  k.folderSync.migrateAll({ rootPath: root });
  await k.folderSync.syncNow();
  const sync = k.folderSync;
  const current = k.getDocument(a.id);
  const relative = sync.manifest[a.id].relativePath;
  const scan = sync.scanFilesAsync.bind(sync);
  let scanned = 0;
  t.mock.method(sync, 'scanFilesAsync', async options => {
    assert.deepEqual([...options.paths], [relative]);
    const result = await scan(options); scanned += result.files.length; return result;
  });
  t.mock.method(sync.adapter, 'listLocations', () => { throw new Error('incremental scan read all locations'); });
  fs.writeFileSync(sync.localPathFor(current), serializeMarkdown({ ...current, content: 'external' }));
  notify('change', relative);
  const result = await sync.syncNow({ reason: 'watch' });
  assert.equal(result.report.updated, 1);
  assert.equal(scanned, 1);
  assert.equal(k.getDocument(a.id).content, 'external');
  assert.equal(k.getDocument(b.id).content, 'beta');
  const saved = k.updateDocument(a.id, { baseVersion: k.getDocument(a.id).version, content: 'saved' }).document;
  notify('change', relative);
  assert.equal((await sync.syncNow({ reason: 'watch' })).report.updated, 0);
  assert.equal(k.getDocument(a.id).version, saved.version);
  assert.equal(scanned, 2);
});

test('a new save invalidates an in-flight worker result and queued follow-up installs only current bytes', async t => {
  const { k, root, notify } = setup(t);
  const a = k.createNote({ title: 'race', content: 'alpha' }).document;
  k.folderSync.migrateAll({ rootPath: root });
  await k.folderSync.syncNow();
  const sync = k.folderSync, current = k.getDocument(a.id), relative = sync.manifest[a.id].relativePath;
  fs.writeFileSync(sync.localPathFor(current), serializeMarkdown({ ...current, content: 'external' }));
  const request = sync.worker.request.bind(sync.worker);
  let first = true;
  t.mock.method(sync.worker, 'request', async (type, payload) => {
    const result = await request(type, payload);
    if (type === 'inspect' && first) {
      first = false;
      // Install the externally changed bytes first, then make a newer local save.
      sync.adapter.upsertFromDisk(a.id, { ...current, content: 'external', fileSync: { ...current.fileSync, fingerprint: result.fingerprint } });
      sync.setEntry(a.id, { ...current.fileSync, fingerprint: result.fingerprint });
      const saved = k.updateDocument(a.id, { baseVersion: k.getDocument(a.id).version, content: 'newer save' });
      assert.ok(saved.document);
      notify('change', relative);
    }
    return result;
  });
  notify('change', relative);
  await sync.syncNow({ reason: 'watch' });
  assert.equal(k.getDocument(a.id).content, 'newer save');
  assert.equal(parseFrontMatter(fs.readFileSync(sync.localPathFor(k.getDocument(a.id)), 'utf8')).content, 'newer save');
});

test('directory rename/delete checks only its subtree and retains unrelated notes and categories', async t => {
  const { k, db, root, notify } = setup(t);
  const a = k.createNote({ title: 'moving', knowledgeBase: 'A', folderPath: 'old', content: 'a' }).document;
  const b = k.createNote({ title: 'staying', knowledgeBase: 'B', content: 'b' }).document;
  k.folderSync.migrateAll({ rootPath: root }); await k.folderSync.syncNow();
  fs.renameSync(path.join(root, 'A', 'old'), path.join(root, 'A', 'new'));
  notify('rename', 'A/old'); notify('rename', 'A/new');
  await k.folderSync.syncNow({ reason: 'watch' });
  assert.equal(k.getDocument(a.id).folderPath, 'new');
  fs.rmSync(path.join(root, 'A', 'new'), { recursive: true });
  notify('rename', 'A/new'); await k.folderSync.syncNow({ reason: 'watch' });
  assert.equal(k.getDocument(a.id), null);
  assert.equal(k.getDocument(b.id).content, 'b');
  assert.ok(db.getAllCategories().find(item => item.name === 'B'));
  fs.mkdirSync(path.join(root, 'B', 'empty'));
  notify('rename', 'B/empty'); await k.folderSync.syncNow({ reason: 'watch' });
  assert.ok(db.getAllCategories().find(item => item.name === 'B').sub.some(item => item.name === 'empty'));
  fs.rmdirSync(path.join(root, 'B', 'empty'));
  notify('rename', 'B/empty'); await k.folderSync.syncNow({ reason: 'watch' });
  assert.ok(!db.getAllCategories().find(item => item.name === 'B').sub.some(item => item.name === 'empty'));
});

test('saves append small deltas; unchanged scans do not write; compaction and torn-tail replay preserve data', async t => {
  const { k, root, restart } = setup(t);
  const note = k.createNote({ title: 'persisted', content: 'alpha' }).document;
  k.folderSync.migrateAll({ rootPath: root }); await k.folderSync.syncNow();
  await k.folderSync.compactManifest();
  const paths = k.folderSync.paths();
  const before = fs.readFileSync(paths.manifest, 'utf8');
  k.updateDocument(note.id, { baseVersion: 1, content: 'beta' });
  assert.equal(fs.readFileSync(paths.manifest, 'utf8'), before);
  assert.equal(fs.readFileSync(paths.deltas, 'utf8').trim().split('\n').length, 1);
  const deltas = fs.readFileSync(paths.deltas, 'utf8');
  await k.folderSync.syncNow({ reason: 'interval' });
  assert.equal(fs.readFileSync(paths.deltas, 'utf8'), deltas);
  fs.appendFileSync(paths.deltas, '{"sequence":');
  const next = await restart();
  assert.equal(next.folderSync.manifest[note.id].fingerprint.sha256, k.folderSync.manifest[note.id].fingerprint.sha256);
  assert.equal(next.getDocument(note.id).content, 'beta');
  await next.folderSync.compactManifest();
  assert.equal(JSON.parse(fs.readFileSync(paths.manifest)).documents[note.id].fingerprint.sha256, next.folderSync.manifest[note.id].fingerprint.sha256);
});

test('restart rolls back an uncommitted preparation even after its delta was flushed', async t => {
  const { k, root, restart } = setup(t);
  const note = k.createNote({ title: 'rollback', content: 'alpha' }).document;
  k.folderSync.migrateAll({ rootPath: root }); await k.folderSync.syncNow();
  const current = k.getDocument(note.id);
  k.folderSync.prepareWrite({ ...current, version: 2, content: 'uncommitted' }, current);
  k.folderSync.persistPrepared();
  const next = await restart();
  assert.equal(next.getDocument(note.id).version, 1);
  assert.equal(parseFrontMatter(fs.readFileSync(next.folderSync.localPathFor(current), 'utf8')).content, 'alpha');
  assert.equal(fs.existsSync(next.folderSync.paths().journal), false);
});

test('restart finishes a committed transaction whose recovery record was not cleared', async t => {
  const { k, root, restart } = setup(t);
  const note = k.createNote({ title: 'commit', content: 'alpha' }).document;
  k.folderSync.migrateAll({ rootPath: root }); await k.folderSync.syncNow();
  t.mock.method(k.folderSync, 'completePrepared', () => {});
  k.updateDocument(note.id, { baseVersion: 1, content: 'committed' });
  assert.ok(fs.existsSync(k.folderSync.paths().journal));
  const next = await restart();
  assert.equal(next.getDocument(note.id).content, 'committed');
  assert.equal(fs.existsSync(next.folderSync.paths().journal), false);
});

test('failed deletion restores the file, database and manifest before exposing the error', async t => {
  const { k, db, root } = setup(t);
  const note = k.createNote({ title: 'delete', content: 'keep' }).document;
  k.folderSync.migrateAll({ rootPath: root }); await k.folderSync.syncNow();
  const file = k.folderSync.localPathFor(k.getDocument(note.id));
  db.sqlite.exec("CREATE TRIGGER fail_delete BEFORE DELETE ON knowledge_documents BEGIN SELECT RAISE(ABORT, 'delete failure'); END");
  assert.throws(() => k.deleteDocument(note.id), /delete failure/);
  assert.equal(parseFrontMatter(fs.readFileSync(file, 'utf8')).content, 'keep');
  assert.equal(k.getDocument(note.id).content, 'keep');
  assert.ok(k.folderSync.manifest[note.id]);
});

test('failed compaction retains deltas and worker exit rejects outstanding requests and permits retry', async t => {
  const { k, root } = setup(t);
  const note = k.createNote({ title: 'worker', content: 'alpha' }).document;
  k.folderSync.migrateAll({ rootPath: root }); await k.folderSync.syncNow();
  const sync = k.folderSync, paths = sync.paths(), log = fs.readFileSync(paths.deltas, 'utf8');
  const request = sync.worker.request.bind(sync.worker);
  let fail = true;
  t.mock.method(sync.worker, 'request', (type, payload) => {
    if (type === 'compact' && fail) { fail = false; return Promise.reject(new Error('snapshot failure')); }
    return request(type, payload);
  });
  await assert.rejects(sync.compactManifest(), /snapshot failure/);
  assert.equal(fs.readFileSync(paths.deltas, 'utf8'), log);
  const payload = { root, file: sync.localPathFor(k.getDocument(note.id)), note: true, generation: sync.generation };
  const pending = request('inspect', payload);
  const rejected = assert.rejects(pending, /停止/);
  await sync.worker.worker.terminate(); await rejected;
  assert.equal((await request('inspect', payload)).parsed.content, 'alpha');
  await sync.compactManifest();
  assert.equal(fs.readFileSync(paths.deltas, 'utf8'), '');
});

test('watch batching has a two-second maximum and overflow requests reconciliation', async t => {
  const { k } = setup(t);
  const sync = k.folderSync;
  let calls = 0;
  t.mock.method(sync, 'syncNow', async () => { calls += 1; });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  sync.enqueuePath('A/one.md');
  for (let i = 0; i < 3; i++) { t.mock.timers.tick(600); sync.enqueuePath('A/one.md'); }
  t.mock.timers.tick(200);
  assert.equal(calls, 1);
  for (let i = 0; i <= 1000; i++) sync.enqueuePath(`A/${i}.md`);
  assert.equal(sync.forceReconcile, true);
  sync.stop(); t.mock.timers.reset();
});

test('corrupt complete delta records trigger reconciliation while preserving the evidence', async t => {
  const { k, root, restart } = setup(t);
  const note = k.createNote({ title: 'corrupt', content: 'keep' }).document;
  k.folderSync.migrateAll({ rootPath: root }); await k.folderSync.syncNow();
  await k.folderSync.compactManifest();
  fs.appendFileSync(k.folderSync.paths().deltas, '{invalid record}\n');
  const next = await restart();
  assert.equal(next.getDocument(note.id).content, 'keep');
  assert.equal(next.folderSync.manifestCorrupt, false);
  assert.ok(fs.readdirSync(next.folderSync.paths().conflicts).some(name => name.startsWith('manifest-corrupt-')));
  await next.folderSync.compactManifest();
});

test('asset dependencies survive note deletion, compaction and restart', async t => {
  const { k, root, restart, notify } = setup(t);
  const image = path.join(root, 'A', 'image.png');
  fs.mkdirSync(path.dirname(image)); fs.writeFileSync(image, 'image');
  const note = k.createNote({ title: 'image', knowledgeBase: 'A', content: '![image](./image.png)' }).document;
  fs.writeFileSync(path.join(root, 'A', 'image.md'), serializeMarkdown(note));
  k.folderSync.configure({ enabled: true, rootPath: root }); await k.folderSync.syncNow();
  assert.ok(k.folderSync.assetReferences.get('a/image.png')?.has(note.id));
  fs.writeFileSync(image, 'changed image'); notify('change', 'A/image.png');
  assert.equal((await k.folderSync.syncNow({ reason: 'watch' })).report.added, 0);
  k.deleteDocument(note.id); await k.folderSync.compactManifest();
  const next = await restart();
  assert.equal(next.allDocuments().length, 0);
  assert.ok(fs.existsSync(image));
});

test('configuration migration preserves custom intervals and applies the five-minute default once', async t => {
  const { k, root, dir } = setup(t);
  k.folderSync.configure({ enabled: true, rootPath: root }); await k.folderSync.syncNow();
  assert.equal(k.folderSync.config.version, 2);
  assert.equal(k.folderSync.config.scanIntervalMs, 300000);
  await k.folderSync.stop();
  fs.writeFileSync(path.join(dir, '.knowledge-folder.json'), JSON.stringify({ version: 1, enabled: false, rootPath: root, scanIntervalMs: 30000 }));
  assert.equal(k.folderSync.readConfig().scanIntervalMs, 300000);
  fs.writeFileSync(path.join(dir, '.knowledge-folder.json'), JSON.stringify({ version: 1, enabled: false, rootPath: root, scanIntervalMs: 60000 }));
  assert.equal(k.folderSync.readConfig().scanIntervalMs, 60000);
});

test('switching roots cancels old work, starts the new root, and never installs stale results', async t => {
  const { k, root } = setup(t);
  const secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-switch-root-'));
  t.after(() => fs.rmSync(secondRoot, { recursive: true, force: true }));
  const note = k.createNote({ title: 'root', content: 'old' }).document;
  k.folderSync.migrateAll({ rootPath: root }); await k.folderSync.syncNow();
  const sync = k.folderSync;
  const file = sync.localPathFor(k.getDocument(note.id));
  const oldTask = sync.worker.request('inspect', { root, file, note: true, generation: sync.generation });
  const rejected = assert.rejects(oldTask, /取消/);
  sync.configure({ enabled: true, rootPath: secondRoot });
  await rejected;
  await sync.syncNow();
  assert.equal(sync.config.rootPath, secondRoot);
  assert.equal(k.getDocument(note.id).content, 'old');
});

test('ZIP exports deltas and merge ignores foreign recovery metadata', async t => {
  const { k, db, root } = setup(t);
  const { exportWorkspace, restoreWorkspace } = require('../lib/workspace/zip');
  const JSZip = require('jszip');
  const note = k.createNote({ title: 'source', knowledgeBase: 'Source', content: 'original' }).document;
  k.folderSync.migrateAll({ rootPath: root }); await k.folderSync.syncNow();
  k.updateDocument(note.id, { baseVersion: 1, content: 'updated' });
  await k.folderSync.stop();
  const zip = await JSZip.loadAsync(await exportWorkspace(db));
  assert.ok(zip.file('knowledge-folder/.liuxu/manifest-deltas.jsonl'));
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-zip-target-db-'));
  const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-zip-target-root-'));
  const db2 = createDatabase(dir2), target = createKnowledgeService(db2);
  t.after(async () => { await target.folderSync.shutdown(); db2.close(); fs.rmSync(dir2, { recursive: true, force: true }); fs.rmSync(root2, { recursive: true, force: true }); });
  const local = target.createNote({ title: 'local', knowledgeBase: 'Local', content: 'keep' }).document;
  target.folderSync.migrateAll({ rootPath: root2 }); await target.folderSync.syncNow();
  await target.folderSync.stop();
  const deltas = fs.readFileSync(target.folderSync.paths().deltas, 'utf8');
  zip.file('knowledge-folder/.liuxu/manifest-deltas.jsonl', JSON.stringify({ sequence: 9999, operation: 'delete', id: local.id }) + '\n');
  zip.file('knowledge-folder/.liuxu/operations/foreign.bak', 'foreign backup');
  await restoreWorkspace(db2, await zip.generateAsync({ type: 'nodebuffer' }), 'merge');
  assert.equal(fs.readFileSync(target.folderSync.paths().deltas, 'utf8'), deltas);
  assert.equal(fs.existsSync(path.join(root2, '.liuxu', 'operations', 'foreign.bak')), false);
  assert.equal(createKnowledgeService(db2, { startFolderSync: false }).getDocument(local.id).content, 'keep');
});

test('normal shutdown waits for a compaction interrupted by worker cancellation', async t => {
  const { k, root } = setup(t);
  const note = k.createNote({ title: 'shutdown', content: 'keep' }).document;
  k.folderSync.migrateAll({ rootPath: root }); await k.folderSync.syncNow();
  const compact = k.folderSync.compactManifest();
  const cancelled = compact.catch(() => {});
  await k.folderSync.shutdown(); await cancelled;
  const manifest = JSON.parse(fs.readFileSync(k.folderSync.paths().manifest, 'utf8'));
  assert.ok(manifest.documents[note.id]);
  assert.equal(k.folderSync.worker.worker, null);
  assert.ok(!fs.readdirSync(k.folderSync.paths().internal).some(name => name.endsWith('.tmp')));
});

test('disabled synchronization never inspects or creates its unused root during shutdown', async t => {
  const { k, root } = setup(t);
  const unused = path.join(root, 'unused');
  k.folderSync.config.rootPath = unused;
  const exists = fs.existsSync;
  t.mock.method(fs, 'existsSync', file => {
    assert.ok(!String(file).startsWith(unused), 'disabled root was accessed');
    return exists(file);
  });
  assert.equal(k.folderSync.snapshot().pendingJournal, false);
  await k.folderSync.shutdown();
});

test('disabling an active root preserves pending deltas for the normal shutdown snapshot', async t => {
  const { k, root } = setup(t);
  const note = k.createNote({ title: 'disable', content: 'before' }).document;
  k.folderSync.migrateAll({ rootPath: root }); await k.folderSync.syncNow();
  k.updateDocument(note.id, { baseVersion: 1, content: 'after' });
  const expected = k.folderSync.manifest[note.id].fingerprint.sha256;
  k.folderSync.configure({ enabled: false, rootPath: root });
  await k.folderSync.shutdown();
  assert.equal(JSON.parse(fs.readFileSync(k.folderSync.paths().manifest, 'utf8')).documents[note.id].fingerprint.sha256, expected);
});

test('a shutdown failure still flushes the other cached workspaces', async t => {
  const { serviceFor, shutdownKnowledgeServices } = require('../lib/knowledge/routes');
  const workspaces = [];
  for (let i = 0; i < 2; i++) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-shutdown-db-'));
    const db = createDatabase(dir);
    workspaces.push({ db, dir, cached: serviceFor(db) });
  }
  t.after(async () => {
    for (const { db, dir, cached } of workspaces) {
      await cached.knowledge.folderSync.stop(); db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  let flushed = false, disposed = 0;
  t.mock.method(workspaces[0].cached.knowledge.folderSync, 'shutdown', async () => { throw new Error('injected flush failure'); });
  t.mock.method(workspaces[1].cached.knowledge.folderSync, 'shutdown', async () => { flushed = true; });
  for (const { cached } of workspaces) {
    const dispose = cached.search.dispose.bind(cached.search);
    t.mock.method(cached.search, 'dispose', () => { disposed++; dispose(); });
  }
  await assert.rejects(shutdownKnowledgeServices(), AggregateError);
  assert.equal(flushed, true);
  assert.equal(disposed, 2);
});
