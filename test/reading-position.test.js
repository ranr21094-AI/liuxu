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

test('desktop reading-position store persists bounded per-document data and clears it', t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'liuxu-reading-position-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const store = createReadingPositionStore(dataDir);
  const record = {
    sourceType: 'note', kind: 'note',
    position: { editTop: 1280.5, previewTop: 640, ignored: 'drop' },
  };

  assert.deepEqual(store.set({ documentId: 'note:42', record }), { saved: true });
  assert.deepEqual(store.get({ documentId: 'note:42' }), {
    sourceType: 'note', kind: 'note', position: { editTop: 1280.5, previewTop: 640 },
  });
  assert.equal((fs.statSync(path.join(dataDir, FILE_NAME)).mode & 0o777), 0o600);
  assert.throws(() => store.set({ documentId: '../outside', record }), /无效/);

  store.set({ documentId: 'file:7', record: { sourceType: 'file', kind: 'pdf', position: { page: 4, offset: 82 } } });
  store.clear({ documentId: 'note:42' });
  assert.equal(store.get({ documentId: 'note:42' }), null);
  assert.equal(store.get({ documentId: 'file:7' }).position.page, 4);
  clearReadingPositionState(dataDir);
  assert.equal(store.get({ documentId: 'file:7' }), null);
});

test('browser reading positions stay local and are matched to the reader kind', async t => {
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
  assert.equal(values.size, 0);
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
