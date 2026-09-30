const test = require('node:test');
const assert = require('node:assert/strict');
const { authorizedKnowledgeFilePath, authorizedKnowledgeDocumentFolder } = require('../electron/knowledge-file');

test('system opening resolves document IDs through permission-checked HTTP', async () => {
  let request;
  const result = await authorizedKnowledgeFilePath({
    documentId: 'file:7', appOrigin: 'http://127.0.0.1:43141', diaryToken: 'diary-token',
    request: async (url, options) => {
      request = { url, options };
      return { ok: true, json: async () => ({ path: '/tmp/authorized.pdf' }) };
    },
  });
  assert.equal(result, '/tmp/authorized.pdf');
  assert.equal(request.url, 'http://127.0.0.1:43141/api/knowledge/files/file%3A7/location');
  assert.equal(request.options.headers.Cookie, 'diary_session=diary-token');
  await assert.rejects(authorizedKnowledgeFilePath({ documentId: '/tmp/private.pdf', appOrigin: 'http://127.0.0.1' }), /标识/);
  await assert.rejects(authorizedKnowledgeFilePath({
    documentId: 'file:7', appOrigin: 'http://127.0.0.1',
    request: async () => ({ ok: false, json: async () => ({ error: 'Diary is locked' }) }),
  }), /Diary is locked/);
});

test('opening a document folder resolves only a permission-checked document ID', async () => {
  let request;
  const result = await authorizedKnowledgeDocumentFolder({
    documentId: 'note:12', appOrigin: 'http://127.0.0.1:43141', diaryToken: 'diary-token',
    request: async (url, options) => {
      request = { url, options };
      return { ok: true, json: async () => ({ path: '/tmp/knowledge/工作' }) };
    },
  });
  assert.equal(result, '/tmp/knowledge/工作');
  assert.equal(request.url, 'http://127.0.0.1:43141/api/knowledge/documents/note%3A12/location');
  assert.equal(request.options.headers.Cookie, 'diary_session=diary-token');
  await assert.rejects(authorizedKnowledgeDocumentFolder({
    documentId: '/tmp/private', appOrigin: 'http://127.0.0.1',
  }), /标识/);
  await assert.rejects(authorizedKnowledgeDocumentFolder({
    documentId: 'note:12', appOrigin: 'http://127.0.0.1',
    request: async () => ({ ok: false, json: async () => ({ error: 'Diary is locked' }) }),
  }), /Diary is locked/);
});
