const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const {
  FILE_NAME,
  createReadingPositionStore,
  clearReadingPositionState,
} = require('../lib/knowledge/reading-position-state');
const { createTempDatabase } = require('./db-temp');
const { readingTime } = require('../lib/knowledge/reading-time');

test('desktop reading-position store persists bounded per-document data and clears it', t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'liuxu-reading-position-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const store = createReadingPositionStore(dataDir);
  const record = {
    sourceType: 'note', kind: 'note',
    position: { editTop: 1280.5, previewTop: 640, ignored: 'drop' },
  };

  assert.deepEqual(store.set({ documentId: 'note:42', record }), { saved: true });
  assert.deepEqual({ ...store.get({ documentId: 'note:42' }), savedAt: undefined }, {
    sourceType: 'note', kind: 'note', position: { editTop: 1280.5, previewTop: 640 }, savedAt: undefined,
  });
  assert.ok(fs.existsSync(path.join(dataDir, 'schedule.db')));
  assert.throws(() => store.set({ documentId: '../outside', record }), /无效/);

  store.set({ documentId: 'file:7', record: { sourceType: 'file', kind: 'pdf', position: { page: 4, offset: 82 } } });
  store.clear({ documentId: 'note:42' });
  assert.equal(store.get({ documentId: 'note:42' }), null);
  assert.equal(store.get({ documentId: 'file:7' }).position.page, 4);
  clearReadingPositionState(dataDir);
  assert.equal(store.get({ documentId: 'file:7' }), null);
});

test('browser reading positions use the checked database API and match reader kind', async t => {
  const previousFetch = global.fetch, previousDocument = global.document;
  const stored = new Map();
  global.document = { cookie: '' };
  global.fetch = async (url, options = {}) => {
    const id = decodeURIComponent(url.split('/').at(-2));
    if (options.method === 'POST') {
      const records = JSON.parse(options.body).records || {};
      for (const [key, record] of Object.entries(records)) if (!stored.has(key)) stored.set(key, record);
      return { ok: true, json: async () => ({ migrated: true }) };
    }
    if (options.method === 'PUT') { const value = JSON.parse(options.body); stored.set(id, value.record); }
    if (options.method === 'DELETE') { if (url.endsWith('/reading-positions')) stored.clear(); else stored.delete(id); }
    return { ok: true, json: async () => ({ record: stored.get(id) || null }) };
  };
  const previousWindow = global.window;
  const previousStorage = global.localStorage;
  const values = new Map();
  global.window = { liuxuDesktop: null };
  global.localStorage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  };
  t.after(() => {
    global.fetch = previousFetch; global.document = previousDocument;
    if (previousWindow === undefined) delete global.window;
    else global.window = previousWindow;
    if (previousStorage === undefined) delete global.localStorage;
    else global.localStorage = previousStorage;
  });

  const { saveReadingPosition, loadReadingPosition, clearReadingPosition, clearAllReadingPositions } = await import(pathToFileURL(path.resolve(__dirname, '../public/js/knowledge/reading-position.js')).href);
  const note = { id: 'note:1', sourceType: 'note' };
  const file = { id: 'file:1', sourceType: 'file' };
  assert.equal(await saveReadingPosition(note, 'note', { editTop: 220, previewTop: 33 }), true);
  assert.equal(await saveReadingPosition(file, 'pdf', { page: 9, offset: 14 }), true);
  assert.deepEqual(await loadReadingPosition(note, 'note'), { editTop: 220, previewTop: 33 });
  assert.equal(await loadReadingPosition(note, 'pdf'), null);
  assert.deepEqual(await loadReadingPosition(file, 'pdf'), { page: 9, offset: 14 });
  await clearReadingPosition(note.id);
  assert.equal(await loadReadingPosition(note, 'note'), null);
  await clearAllReadingPositions();
  assert.equal(values.get('liuxu.readingPositions.v1.database-migrated.v1'), '1');
  assert.equal(stored.size, 0);
});

test('desktop JSON reading positions migrate once with their source retained', t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'liuxu-reading-position-migration-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dataDir, FILE_NAME), JSON.stringify({ records: {
    'file:7': { sourceType: 'file', kind: 'pdf', position: { page: 3, anchor: 'page:3' } },
  } }));
  const store = createReadingPositionStore(dataDir);
  assert.equal(store.get({ documentId: 'file:7' }).migrationSource, 'desktop-json');
  store.set({ documentId: 'file:7', record: { sourceType: 'file', kind: 'pdf', position: { page: 4 } } });
  const reopened = createReadingPositionStore(dataDir);
  assert.equal(reopened.get({ documentId: 'file:7' }).position.page, 4);
  assert.equal(fs.existsSync(path.join(dataDir, FILE_NAME)), true, 'retain source until verified backups replace it');
});

test('browser position migration commits in restart-safe batches and records completion only at the end', t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'liuxu-browser-position-migration-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const store = createReadingPositionStore(dataDir);
  assert.deepEqual(store.migrateBrowserRecords({ 'note:one': { sourceType: 'note', kind: 'note', position: { editTop: 10 } } }, { complete: false, totalCount: 2 }),
    { migrated: true, count: 1, complete: false });
  assert.equal(store.get({ documentId: 'note:one' }).migrationSource, 'browser-localStorage');
  assert.deepEqual(store.migrateBrowserRecords({ 'file:two': { sourceType: 'file', kind: 'pdf', position: { page: 2 } } }, { complete: true, totalCount: 2 }),
    { migrated: true, count: 1, complete: true });
  assert.equal(store.migrateBrowserRecords({}).alreadyComplete, true);
  assert.equal(store.get({ documentId: 'file:two' }).position.page, 2);
});

test('position and time APIs persist by stable ID without requiring a knowledge index row', async t => {
  const { db } = createTempDatabase(t, 'reading-state-api-');
  const express = require('express');
  const { registerKnowledgeRoutes, invalidateKnowledgeCache } = require('../lib/knowledge/routes');
  const app = express(); app.use(express.json()); registerKnowledgeRoutes(app, { db });
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { invalidateKnowledgeCache(db.dataDir); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const id = 'file:unindexed-book';
  let response = await fetch(`${base}/api/knowledge/documents/${encodeURIComponent(id)}/reading-position`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ record: { sourceType: 'file', kind: 'pdf', position: { page: 5, anchor: 'page:5' } } }),
  });
  assert.equal(response.status, 200);
  response = await fetch(`${base}/api/knowledge/documents/${encodeURIComponent(id)}/reading-position`);
  assert.equal(response.status, 200); assert.equal((await response.json()).record.position.page, 5);
  response = await fetch(`${base}/api/knowledge/documents/${encodeURIComponent(id)}/reading-time`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: 'session-one', sequence: 1, milliseconds: 30000 }),
  });
  assert.equal(response.status, 200); assert.equal((await response.json()).milliseconds, 30000);
  response = await fetch(`${base}/api/knowledge/reading-positions/migrate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ records: { 'note:old-browser': { sourceType: 'note', kind: 'note', position: { editTop: 720 } } } }),
  });
  assert.equal(response.status, 200);
  assert.equal(createReadingPositionStore(db.dataDir).get({ documentId: 'note:old-browser' }).migrationSource, 'browser-localStorage');
});

test('JSON backup restores positions and idempotent time sessions for distinct same-content IDs', t => {
  const { db } = createTempDatabase(t, 'reading-state-backup-');
  const store = createReadingPositionStore(db.dataDir);
  const timeId = 'file:book-one';
  const sameContentButSeparateId = 'file:book-two';
  store.set({ documentId: timeId, record: { sourceType: 'file', kind: 'ebook', position: { anchor: 'cfi-one' } } });
  store.set({ documentId: sameContentButSeparateId, record: { sourceType: 'file', kind: 'ebook', position: { anchor: 'cfi-two' } } });
  readingTime(db.sqlite, timeId, { sessionId: 'session-one', sequence: 1, milliseconds: 60000 });
  const backup = db.backup();
  assert.equal(backup.readingPositions.length, 2);
  store.clear();
  readingTime(db.sqlite, timeId, { sessionId: 'session-one', sequence: 2, milliseconds: 120000 });
  assert.equal(db.restore(backup).success, true);
  assert.equal(store.get({ documentId: timeId }).position.anchor, 'cfi-one');
  assert.equal(store.get({ documentId: sameContentButSeparateId }).position.anchor, 'cfi-two');
  assert.equal(readingTime(db.sqlite, timeId).milliseconds, 60000);
  readingTime(db.sqlite, timeId, { sessionId: 'session-one', sequence: 2, milliseconds: 120000 });
  assert.equal(readingTime(db.sqlite, timeId).milliseconds, 120000);
});

test('desktop reading position bridge is used when present and never falls back to browser storage', async () => {
  const originalWindow = global.window;
  const originalStorage = global.localStorage;
  const calls = [];
  global.window = {
    liuxuDesktop: {
      readingPositions: {
        get: async payload => { calls.push(['get', payload]); return { sourceType: 'file', kind: 'spreadsheet', position: { sheet: '预算', top: 155 } }; },
        set: async payload => { calls.push(['set', payload]); },
        clear: async payload => { calls.push(['clear', payload]); },
      },
    },
  };
  global.localStorage = { getItem() { throw new Error('browser storage should not be used'); }, setItem() { throw new Error('browser storage should not be used'); } };
  try {
    const { saveReadingPosition, loadReadingPosition, clearReadingPosition } = await import(pathToFileURL(path.resolve(__dirname, '../public/js/knowledge/reading-position.js')).href);
    const file = { id: 'file:8', sourceType: 'file' };
    assert.deepEqual(await loadReadingPosition(file, 'spreadsheet'), { sheet: '预算', top: 155 });
    assert.equal(await saveReadingPosition(file, 'spreadsheet', { sheet: '预算', top: 320 }), true);
    await clearReadingPosition(file.id);
    assert.deepEqual(calls.map(call => call[0]), ['get', 'set', 'clear']);
  } finally {
    if (originalWindow === undefined) delete global.window;
    else global.window = originalWindow;
    if (originalStorage === undefined) delete global.localStorage;
    else global.localStorage = originalStorage;
  }
});
