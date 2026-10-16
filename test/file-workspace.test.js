const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { FileWorkspace, digest, recordName } = require('../lib/knowledge/file-workspace');

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'liuxu-file-workspace-'));
  const workspace = await new FileWorkspace({ root, ...options }).open();
  t.after(async () => { await workspace.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, workspace };
}
const base = document => ({ baseVersion: document.version, baseFingerprint: document.baseFingerprint });

test('file workspace reads external bytes immediately and protects an old draft', async t => {
  const { root, workspace } = await fixture(t);
  const { document } = await workspace.create({ relativePath: 'note.md', content: 'first' });
  await fs.writeFile(path.join(root, 'note.md'), 'external');
  assert.equal((await workspace.read(document.id)).content, 'external');
  await assert.rejects(workspace.save(document.id, { ...base(document), content: 'draft' }), error => error.status === 409);
  assert.equal(await fs.readFile(path.join(root, 'note.md'), 'utf8'), 'external');
});

test('new notes are ordinary markdown; old unknown headers, BOM and CRLF survive saving', async t => {
  const { root, workspace } = await fixture(t);
  const { document } = await workspace.create({ relativePath: 'plain.md', content: 'hello' });
  assert.equal(await fs.readFile(path.join(root, 'plain.md'), 'utf8'), 'hello');
  const header = '\uFEFF---\r\nunknown: [one, two]\r\ntitle: old\r\n---\r\n\r\n';
  await fs.writeFile(path.join(root, 'plain.md'), header + 'external\r\n');
  const current = await workspace.read(document.id);
  await workspace.save(document.id, { ...base(current), content: 'edited\nnext\n', title: 'Display title' });
  assert.equal(await fs.readFile(path.join(root, 'plain.md'), 'utf8'), header + 'edited\r\nnext\r\n');
  assert.equal((await workspace.read(document.id)).relativePath, 'plain.md');
});

test('first-time discovery publishes document batches before the scan finishes', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'liuxu-file-discovery-'));
  for (let index = 0; index < 16; index += 1) await fs.writeFile(path.join(root, `note-${index}.md`), `body ${index}`);
  const workspace = await new FileWorkspace({ root }).open();
  t.after(async () => { await workspace.close(); await fs.rm(root, { recursive: true, force: true }); });
  let release;
  let blocked;
  const atNextBatch = new Promise(resolve => { blocked = resolve; });
  const nextBatchGate = new Promise(resolve => { release = resolve; });
  const persist = workspace.persist.bind(workspace);
  let writes = 0;
  workspace.persist = async record => {
    writes += 1;
    if (writes === 9) { blocked(); await nextBatchGate; }
    return persist(record);
  };
  const scanning = workspace.scan();
  await atNextBatch;
  assert.equal(workspace.scanStatus, 'scanning');
  assert.ok(workspace.fileGeneration > 0);
  assert.equal(workspace.records.size, 8);
  assert.equal(workspace.scanProgress.visited, 8);
  release();
  await scanning;
  assert.equal(workspace.records.size, 16);
});

test('index failure never rolls back committed content; reopening rebuilds it', async t => {
  let fail = false;
  const { root, workspace } = await fixture(t, { indexDocument: async () => { if (fail) throw new Error('SQLite unavailable'); } });
  const { document } = await workspace.create({ relativePath: 'note.md', content: 'first' });
  fail = true;
  const saved = await workspace.save(document.id, { ...base(document), content: 'committed' });
  assert.equal(saved.document.indexState, 'pending');
  assert.equal(await fs.readFile(path.join(root, 'note.md'), 'utf8'), 'committed');
  const indexed = [];
  const reopened = await new FileWorkspace({ root, indexDocument: doc => indexed.push(doc) }).open();
  t.after(() => reopened.close());
  await reopened.scan();
  assert.equal(indexed.find(doc => doc.id === document.id).content, 'committed');
});

test('two clients saving the same baseline cannot overwrite each other', async t => {
  const { workspace } = await fixture(t);
  const { document } = await workspace.create({ relativePath: 'note.md', content: 'first' });
  const results = await Promise.allSettled(['one', 'two'].map(content => workspace.save(document.id, { ...base(document), content })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.status, 409);
});

test('metadata persistence failure retains recovery journal and committed bytes', async t => {
  const { root, workspace } = await fixture(t);
  const { document } = await workspace.create({ relativePath: 'note.md', content: 'first' });
  const original = workspace.persist;
  workspace.persist = async () => { throw new Error('disk metadata failure'); };
  const saved = await workspace.save(document.id, { ...base(document), content: 'committed' });
  assert.equal(saved.metadataState, 'pending');
  workspace.persist = original;
  const reopened = await new FileWorkspace({ root }).open();
  t.after(() => reopened.close());
  assert.equal((await reopened.read(document.id)).content, 'committed');
  assert.equal((await fs.readdir(path.join(root, '.liuxu/operations'))).length, 0);
});

test('duplicate content files remain distinct and a unique external rename keeps identity', async t => {
  const { root, workspace } = await fixture(t);
  await fs.writeFile(path.join(root, 'one.md'), 'same');
  await fs.writeFile(path.join(root, 'two.md'), 'same');
  await workspace.scan();
  const records = [...workspace.records.values()];
  assert.equal(records.length, 2); assert.notEqual(records[0].id, records[1].id);
  const created = (await workspace.create({ relativePath: 'unique.md', content: 'unique' })).document;
  await fs.rename(path.join(root, 'unique.md'), path.join(root, 'renamed.md'));
  await workspace.scan();
  assert.equal((await workspace.read(created.id)).relativePath, 'renamed.md');
});

test('root loss does not mark documents deleted; symlink and traversal access are rejected', async t => {
  const { root, workspace } = await fixture(t);
  const { document } = await workspace.create({ relativePath: 'note.md', content: 'first' });
  await assert.rejects(workspace.create({ relativePath: '../outside.md' }), error => error.status === 400);
  await fs.symlink(os.tmpdir(), path.join(root, 'linked'));
  await assert.rejects(workspace.create({ relativePath: 'linked/escape.md' }), error => error.status === 400);
  await fs.rename(root, `${root}-offline`);
  try { await assert.rejects(workspace.scan()); assert.equal(workspace.records.get(document.id).status, 'active'); }
  finally { await fs.rename(`${root}-offline`, root); }
});

test('move, archive, restore and delete operate on original files and preserve identity', async t => {
  const { root, workspace } = await fixture(t);
  let document = (await workspace.create({ relativePath: 'note.md', content: 'first' })).document;
  document = (await workspace.move(document.id, { ...base(document), relativePath: 'folder/renamed.md' })).document;
  assert.equal(document.relativePath, 'folder/renamed.md');
  document = (await workspace.move(document.id, base(document), 'archive')).document;
  assert.equal(document.status, 'archived');
  document = (await workspace.move(document.id, base(document), 'restore')).document;
  assert.equal(document.relativePath, 'folder/renamed.md');
  const result = await workspace.move(document.id, base(document), 'delete');
  assert.equal(result.deleted, true); assert.equal(await workspace.read(document.id), null);
  assert.equal(await fs.readFile(path.join(root, workspace.records.get(document.id).relativePath), 'utf8'), 'first');
});

test('recovery never overwrites a later external edit', async t => {
  const { root, workspace } = await fixture(t);
  const { document } = await workspace.create({ relativePath: 'note.md', content: 'first' });
  const previous = workspace.records.get(document.id);
  const next = { ...previous, version: 2, fingerprint: digest(Buffer.from('committed')) };
  const key = require('node:crypto').randomUUID();
  await workspace.journal({ key, records: [{ previous, next }] });
  await fs.writeFile(path.join(root, 'note.md'), 'external');
  const reopened = await new FileWorkspace({ root }).open(); t.after(() => reopened.close());
  const current = await reopened.read(document.id);
  assert.equal(current.content, 'external');
  assert.equal(JSON.parse(await fs.readFile(path.join(root, '.liuxu/documents', recordName(document.id)), 'utf8')).fingerprint, current.baseFingerprint);
});
test('restart completes a partially installed parent and annotation move without losing either file', async t => {
  const { root, workspace } = await fixture(t);
  const parent = (await workspace.create({ relativePath: 'book.pdf', sourceType: 'file', bytes: Buffer.from('binary') })).document;
  const child = (await workspace.create({ relativePath: 'book.annotation.md', parentDocumentId: parent.id, documentRole: 'annotation', content: 'annotation' })).document;
  const oldParent = workspace.records.get(parent.id), oldChild = workspace.records.get(child.id);
  const nextParent = { ...oldParent, relativePath: 'moved/book.pdf', version: 2 };
  const nextChild = { ...oldChild, relativePath: 'moved/book.annotation.md', version: 2 };
  await workspace.journal({ key: require('node:crypto').randomUUID(), records: [{ previous: oldParent, next: nextParent }, { previous: oldChild, next: nextChild }] });
  await fs.mkdir(path.join(root, 'moved'));
  await fs.rename(path.join(root, oldParent.relativePath), path.join(root, nextParent.relativePath));
  const reopened = await new FileWorkspace({ root }).open(); t.after(() => reopened.close());
  assert.equal((await reopened.read(parent.id)).relativePath, 'moved/book.pdf');
  assert.equal((await reopened.read(child.id)).content, 'annotation');
  await assert.rejects(fs.stat(path.join(root, oldChild.relativePath)), error => error.code === 'ENOENT');
});
test('an external rename plus identical new copy matches the original inode, not enumeration order', async t => {
  const { root, workspace } = await fixture(t);
  const original = (await workspace.create({ relativePath: 'original.md', content: 'same content' })).document;
  await fs.rename(path.join(root, 'original.md'), path.join(root, 'z-renamed.md'));
  await fs.writeFile(path.join(root, 'a-copy.md'), 'same content');
  await workspace.scan();
  assert.equal((await workspace.read(original.id)).relativePath, 'z-renamed.md');
  assert.equal([...workspace.records.values()].filter(record => record.status === 'active').length, 2);
});
test('invalid metadata is rejected before replacing saved content', async t => {
  const { root, workspace } = await fixture(t);
  const doc = (await workspace.create({ relativePath: 'note.md', content: 'first' })).document;
  await assert.rejects(workspace.save(doc.id, { ...base(doc), content: 'second', tags: { bad: true } }), error => error.status === 400);
  assert.equal(await fs.readFile(path.join(root, 'note.md'), 'utf8'), 'first');
});

test('path notifications update bytes and match renames without walking the root', async t => {
  const { root, workspace } = await fixture(t);
  const first = (await workspace.create({ relativePath: 'first.md', content: 'first' })).document;
  workspace.scan = async () => { throw new Error('Unexpected full traversal'); };
  await fs.writeFile(path.join(root, 'first.md'), 'external');
  await workspace.refreshPaths(['first.md']);
  assert.equal((await workspace.read(first.id)).content, 'external');
  await fs.rename(path.join(root, 'first.md'), path.join(root, 'renamed.md'));
  await workspace.refreshPaths(['first.md', 'renamed.md']);
  assert.equal((await workspace.read(first.id)).relativePath, 'renamed.md');
  await fs.writeFile(path.join(root, 'duplicate.md'), 'external');
  await workspace.refreshPaths(['duplicate.md']);
  assert.equal([...workspace.records.values()].filter(record => record.status === 'active').length, 2);
});

test('an unchanged workspace scan does not read files, hash content, reindex or bump generations', async t => {
  const { root, workspace } = await fixture(t);
  await fs.writeFile(path.join(root, 'note.md'), 'stable body');
  await workspace.scan(); await workspace.flushIndex();
  const generation = workspace.generation;
  let reads = 0, fingerprints = 0, indexes = 0;
  const readBytes = workspace.readBytes.bind(workspace), fingerprint = workspace.fingerprint.bind(workspace);
  workspace.readBytes = (...args) => { reads += 1; return readBytes(...args); };
  workspace.fingerprint = (...args) => { fingerprints += 1; return fingerprint(...args); };
  workspace.indexDocument = async () => { indexes += 1; };
  await workspace.scan(); await workspace.flushIndex();
  assert.deepEqual({ reads, fingerprints, indexes }, { reads: 0, fingerprints: 0, indexes: 0 });
  assert.equal(workspace.generation, generation);
});

test('moving a directory retains empty folders, relative assets and document identity', async t => {
  const { root, workspace } = await fixture(t);
  await workspace.createDirectory('source/empty');
  const first = (await workspace.create({ relativePath: 'source/note.md', content: '![image](image.png)' })).document;
  await fs.writeFile(path.join(root, 'source/image.png'), Buffer.from([1, 2, 3]));
  await workspace.moveDirectory('source', 'destination');
  assert.equal((await workspace.read(first.id)).relativePath, 'destination/note.md');
  assert.deepEqual(await fs.readFile(path.join(root, 'destination/image.png')), Buffer.from([1, 2, 3]));
  assert.equal((await fs.stat(path.join(root, 'destination/empty'))).isDirectory(), true);
});

test('queued indexes never delay a committed save and discard superseded queued content', async t => {
  let release;
  let started;
  const begins = new Promise(resolve => { started = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const indexed = [];
  const { root, workspace } = await fixture(t, { asyncIndex: true, indexDocument: async doc => {
    if (doc.content === 'first') { started(); await blocked; }
    indexed.push(doc.content);
  } });
  const created = (await workspace.create({ relativePath: 'note.md', content: 'first' })).document;
  await begins;
  const second = (await workspace.save(created.id, { ...base(created), content: 'second' })).document;
  assert.equal(second.indexState, 'pending');
  await workspace.save(created.id, { ...base(second), content: 'third' });
  assert.equal(await fs.readFile(path.join(root, 'note.md'), 'utf8'), 'third');
  release(); await workspace.flushIndex();
  assert.deepEqual(indexed, ['first', 'third']);
  assert.equal(workspace.pendingIndex.size, 0);
});

test('large binary fingerprints run through a background worker and retain exact bytes', async t => {
  const { root, workspace } = await fixture(t);
  const bytes = Buffer.alloc(8 * 1024 * 1024, 97);
  await fs.writeFile(path.join(root, 'large.bin'), bytes);
  const observed = await workspace.fingerprint('large.bin');
  assert.equal(observed.fingerprint, digest(bytes));
  assert.ok(workspace.hashWorker.worker);
});

test('a sidecar write failure does not hide fresh disk content while reading', async t => {
  const { root, workspace } = await fixture(t);
  const created = (await workspace.create({ relativePath: 'note.md', content: 'first' })).document;
  const persist = workspace.persist;
  workspace.persist = async () => { throw new Error('sidecar unavailable'); };
  await fs.writeFile(path.join(root, 'note.md'), 'latest disk content');
  const current = await workspace.read(created.id);
  assert.equal(current.content, 'latest disk content');
  assert.equal(current.metadataState, 'pending');
  assert.ok(current.version > created.version);
  workspace.persist = persist;
  await workspace.recover();
  assert.equal((await workspace.read(created.id)).content, 'latest disk content');
});

test('a changed sidecar version rejects an old baseline even when content bytes are identical', async t => {
  const { root, workspace } = await fixture(t);
  const created = (await workspace.create({ relativePath: 'note.md', content: 'first' })).document;
  const other = await new FileWorkspace({ root }).open(); t.after(() => other.close());
  await other.updateMetadata(created.id, { ...base(created), title: 'Other title' });
  await assert.rejects(workspace.save(created.id, { ...base(created), content: 'stale' }), error => error.status === 409);
  assert.equal((await workspace.read(created.id)).title, 'Other title');
  assert.equal(await fs.readFile(path.join(root, 'note.md'), 'utf8'), 'first');
});

test('native file watching notices external edits without opening the document', async t => {
  const { root, workspace } = await fixture(t);
  const created = (await workspace.create({ relativePath: 'watch.md', content: 'first' })).document;
  workspace.start();
  await new Promise(resolve => setTimeout(resolve, 100));
  if (!workspace.watcher) { t.skip('Recursive file watching is unavailable on this platform'); return; }
  await fs.writeFile(path.join(root, 'watch.md'), 'external watched');
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && workspace.records.get(created.id).fingerprint !== digest(Buffer.from('external watched'))) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(workspace.records.get(created.id).fingerprint, digest(Buffer.from('external watched')));
});

for (const existing of [false, true]) test(`oversized originals do not stop discovery (existing=${existing})`, async t => {
  const { root, workspace } = await fixture(t);
  if (existing) await workspace.create({ relativePath: 'existing.md', content: 'existing' });
  await fs.writeFile(path.join(root, 'new.md'), 'new');
  const handle = await fs.open(path.join(root, 'large.bin'), 'w');
  await handle.truncate(251 * 1024 * 1024); await handle.close();
  await workspace.scan();
  assert.ok([...workspace.records.values()].some(record => record.relativePath === 'new.md'));
  assert.deepEqual(workspace.snapshot().skippedFiles, ['large.bin']);
  await fs.unlink(path.join(root, 'large.bin'));
  await workspace.scan();
  assert.equal(workspace.snapshot().skippedFileCount, 0);
});

test('moving an annotated file and its directory concurrently drains all locks', { timeout: 5000 }, async t => {
  const { workspace } = await fixture(t);
  const parent = (await workspace.create({ sourceType: 'file', relativePath: 'folder/book.pdf', bytes: Buffer.from('pdf') })).document;
  const child = (await workspace.create({ relativePath: 'folder/book.annotation.md', content: 'notes', parentDocumentId: parent.id, documentRole: 'annotation' })).document;
  await Promise.all([
    workspace.move(parent.id, { ...base(parent), relativePath: 'folder/new.pdf' }),
    workspace.moveDirectory('folder', 'renamed'),
  ]);
  assert.equal((await workspace.read(parent.id)).relativePath, 'renamed/new.pdf');
  assert.ok((await workspace.read(child.id)).relativePath.startsWith('renamed/'));
  assert.equal(workspace.documentTails.size, 0);
});
