const test = require('node:test');
const assert = require('node:assert/strict');
const { Writable } = require('node:stream');
const JSZip = require('jszip');
const { createKnowledgeService } = require('../lib/knowledge/documents');
const { sendKnowledgeFile, listZipEntries, invalidateKnowledgeCache } = require('../lib/knowledge/routes');
const { createTempDatabase } = require('./db-temp');

function captureFileResponse(req, document, filePath) {
  const chunks = [];
  const headers = new Map();
  const response = new Writable({ write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
  response.headers = headers;
  response.statusCode = 200;
  response.setHeader = (name, value) => headers.set(name.toLowerCase(), String(value));
  response.status = code => { response.statusCode = code; return response; };
  sendKnowledgeFile(req, response, document, filePath);
  return new Promise((resolve, reject) => {
    response.once('finish', () => resolve({ status: response.statusCode, headers, body: Buffer.concat(chunks) }));
    response.once('error', reject);
  });
}

test('knowledge file reader helpers enforce protected byte ranges and ZIP listings', async t => {
  const { db } = createTempDatabase(t, 'knowledge-reader-');
  const knowledge = createKnowledgeService(db);
  const publicFile = knowledge.saveImportedFile({
    buffer: Buffer.from('0123456789abcdef'), filename: '读取测试.txt', mimeType: 'text/plain',
    title: '读取测试', collectionPath: '开发', text: '读取测试正文', diaryUnlocked: false,
  }).document;
  const diaryFile = knowledge.saveImportedFile({
    buffer: Buffer.from('diary secret'), filename: 'private.txt', mimeType: 'text/plain',
    title: '私密档案', collectionPath: '日记', text: '私密正文', diaryUnlocked: true,
  }).document;
  const zip = new JSZip(); zip.file('资料/说明.txt', '可列出但不解压');
  const archive = knowledge.saveImportedFile({
    buffer: await zip.generateAsync({ type: 'nodebuffer' }), filename: 'archive.zip', mimeType: 'application/zip',
    title: 'ZIP 目录', collectionPath: '开发', text: '', previewKind: 'archive', diaryUnlocked: false,
  }).document;

  t.after(() => invalidateKnowledgeCache(db.dataDir));
  const filePath = knowledge.filePathFor(publicFile);
  const ranged = await captureFileResponse({ method: 'GET', query: {}, headers: { range: 'bytes=2-5' } }, publicFile, filePath);
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get('content-range'), 'bytes 2-5/16');
  assert.equal(ranged.body.toString(), '2345');
  assert.match(ranged.headers.get('content-disposition'), /^inline; filename="[\x20-\x7E]+"; filename\*=UTF-8''/);
  const download = await captureFileResponse({ method: 'GET', query: { download: '1' }, headers: {} }, publicFile, filePath);
  assert.match(download.headers.get('content-disposition'), /^attachment;/);
  const head = await captureFileResponse({ method: 'HEAD', query: {}, headers: {} }, publicFile, filePath);
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), '16');
  assert.equal(head.body.length, 0);
  const invalidRange = await captureFileResponse({ method: 'GET', query: {}, headers: { range: 'bytes=0-1,4-5' } }, publicFile, filePath);
  assert.equal(invalidRange.status, 416);
  assert.equal(knowledge.getDocument(diaryFile.id, { diaryUnlocked: false }), null);
  const listing = await listZipEntries(knowledge.filePathFor(archive), 0, 100);
  assert.deepEqual(listing.entries.map(entry => entry.name), ['资料/说明.txt']);
});
