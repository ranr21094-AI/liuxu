const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const load = () => import(pathToFileURL(path.join(__dirname, '../public/js/knowledge/revision-migration.js')).href);

test('cleanup aborts before any API call on unsaved drafts or save conflicts', async () => {
  const { cleanupLegacyRevisions } = await load();
  let calls = 0;
  for (const flushPendingSaves of [async () => false, async () => { throw new Error('版本冲突'); }]) {
    await assert.rejects(cleanupLegacyRevisions({ flushPendingSaves, getActiveDocument: () => ({ id: 'note:1' }),
      apiFetch: async () => { calls++; } }));
  }
  assert.equal(calls, 0);
});

test('cleanup uses the version after flushing and propagates server conflicts', async () => {
  const { cleanupLegacyRevisions } = await load();
  let document = { id: 'note:1', sourceType: 'note', version: 1 };
  let body;
  const options = {
    flushPendingSaves: async () => { document = { ...document, version: 2 }; return true; },
    getActiveDocument: () => document,
    apiFetch: async (url, init) => {
      assert.equal(url, '/api/knowledge/revisions/cleanup');
      body = JSON.parse(init.body);
      return { ok: true, json: async () => ({ cleaned: true, deleted: 3 }) };
    },
  };
  assert.equal((await cleanupLegacyRevisions(options)).deleted, 3);
  assert.deepEqual(body, { documentId: 'note:1', baseVersion: 2 });
  await assert.rejects(cleanupLegacyRevisions({ ...options,
    apiFetch: async () => ({ ok: false, json: async () => ({ error: '版本冲突，清理已中止' }) }),
  }), /版本冲突/);
});

test('cleanup can finish without an active editable note and is harmless when already done', async () => {
  const { cleanupLegacyRevisions } = await load();
  for (const document of [null, { id: 'file:1', sourceType: 'file' }, { id: 'note:1', sourceType: 'note', status: 'archived' }]) {
    const result = await cleanupLegacyRevisions({ flushPendingSaves: async () => true,
      getActiveDocument: () => document, apiFetch: async (_url, init) => {
        assert.deepEqual(JSON.parse(init.body), {});
        return { ok: true, json: async () => ({ cleaned: false }) };
      },
    });
    assert.equal(result.cleaned, false);
  }
});
