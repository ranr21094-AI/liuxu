const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createKnowledgeService } = require('../lib/knowledge/documents');
const { createSearchIndex } = require('../lib/knowledge/search');
const { treeForDocuments } = require('../lib/knowledge/routes');
const { extractText, inferPreviewKind } = require('../lib/knowledge/import');
const { chunkDocument } = require('../lib/knowledge/chunk');
const { decodeUploadedFilename, contentDisposition } = require('../lib/util/filename');

function tempDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  process.env.DATA_DIR = dir;
  process.env.AI_SECRETS_KEY_FILE = path.join(dir, 'ai-secrets.key');
  delete require.cache[require.resolve('../database.js')];
  const db = require('../database.js');
  db.create({ title: '公开日志', content: '混合检索正文苹果香蕉', category: '开发', hours: 2, pinned: true, log_date: '2026-05-16' });
  db.create({ title: '日记秘密', content: '不应出现', category: '日记', log_date: '2026-05-16' });
  return { db, dir };
}

test('knowledge adapter maps logs without rewriting them', (t) => {
  const { db } = tempDb(t);
  const knowledge = createKnowledgeService(db);
  const docs = knowledge.allDocuments({ diaryUnlocked: false });
  assert.equal(docs.some(doc => doc.id === 'log:1'), true);
  assert.equal(docs.find(doc => doc.id === 'log:1').knowledgeBase, '开发');
  assert.equal(docs.find(doc => doc.id === 'log:1').folderPath, '');
  assert.equal(docs.find(doc => doc.id === 'log:1').documentDate, '2026-05-16');
  assert.equal(docs.some(doc => doc.visibility === 'diary'), false);
  const unlocked = knowledge.allDocuments({ diaryUnlocked: true });
  assert.equal(unlocked.some(doc => doc.visibility === 'diary'), true);
  assert.equal(db.getById(1).title, '公开日志');
});

test('knowledge search filters diary chunks and returns citations', (t) => {
  const { db } = tempDb(t);
  const knowledge = createKnowledgeService(db);
  const search = createSearchIndex(knowledge);
  const locked = search.search('秘密', { diaryUnlocked: false });
  assert.equal(locked.some(item => item.documentId.startsWith('log:2')), false);
  const open = search.search('苹果', { diaryUnlocked: false });
  assert.equal(open.some(item => item.documentId === 'log:1'), true);
  assert.ok(open[0].id.includes('#'));
});

test('markdown and txt extraction stay under limits', async () => {
  const md = await extractText(Buffer.from('# 标题\n\n正文'), 'note.md', 'text/markdown');
  assert.equal(md.status, 'active');
  assert.equal(md.previewKind, 'text');
  assert.match(md.text, /正文/);
  const txt = await extractText(Buffer.from('hello world'), 'a.txt', 'text/plain');
  assert.match(txt.text, /hello/);
  const bad = await extractText(Buffer.from('x'), 'virus.exe', 'application/octet-stream');
  assert.equal(bad.status, 400);
});

test('image imports are recognized and stored with preview metadata', async (t) => {
  const { db } = tempDb(t);
  const knowledge = createKnowledgeService(db);
  const png = await extractText(Buffer.from([137, 80, 78, 71]), 'photo.png', 'image/png');
  assert.equal(png.status, 'active');
  assert.equal(png.previewKind, 'image');
  assert.equal(png.text, '');
  const saved = knowledge.saveImportedFile({
    buffer: Buffer.from('fake-image-bytes'),
    filename: 'photo.png',
    mimeType: 'image/png',
    title: '照片',
    collectionPath: '其他',
    text: '',
    status: 'active',
    previewKind: 'image',
    diaryUnlocked: false,
  }).document;
  assert.equal(saved.fileMeta.previewKind, 'image');
  assert.equal(saved.previewHtml, '');
  assert.ok(knowledge.filePathFor(saved));
});

test('docx imports produce searchable text and formatted preview html', async () => {
  const JSZip = require('jszip');
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`);
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body><w:p><w:r><w:t>预览正文</w:t></w:r></w:p></w:body>
</w:document>`);
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  const extracted = await extractText(buffer, 'brief.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.equal(extracted.previewKind, 'docx');
  assert.match(extracted.text, /预览正文/);
  assert.match(extracted.previewHtml, /预览正文/);
});

test('legacy imported files infer preview kind from filename and hydrate missing metadata', async (t) => {
  assert.equal(inferPreviewKind('', 'scan.pdf'), 'pdf');
  assert.equal(inferPreviewKind('', 'notes.docx'), 'docx');
  assert.equal(inferPreviewKind('', 'photo.PNG'), 'image');
  assert.equal(inferPreviewKind('', 'readme.txt'), 'text');

  const { db, dir } = tempDb(t);
  const knowledge = createKnowledgeService(db);
  const saved = knowledge.saveImportedFile({
    buffer: Buffer.from('%PDF-1.4 legacy'),
    filename: 'scan.pdf',
    mimeType: 'application/octet-stream',
    title: '扫描件',
    collectionPath: '其他',
    text: '提取出的纯文本',
    status: 'active',
    diaryUnlocked: false,
  }).document;
  const storePath = path.join(dir, 'knowledge-documents.json');
  const store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  const record = store.documents.find(item => item.id === saved.id);
  record.fileMeta.previewKind = '';
  record.fileMeta.mimeType = '';
  delete record.previewHtml;
  fs.writeFileSync(storePath, JSON.stringify(store, null, 2));

  const stale = knowledge.getDocument(saved.id);
  assert.equal(stale.fileMeta.previewKind, '');
  const hydrated = await knowledge.hydrateFilePreview(stale);
  assert.equal(hydrated.fileMeta.previewKind, 'pdf');
  const persisted = knowledge.getDocument(saved.id);
  assert.equal(persisted.fileMeta.previewKind, 'pdf');
});

test('chunks keep document id and heading', () => {
  const chunks = chunkDocument({ id: 'note:1', title: '指南', content: '# 步骤\n\n' + '内容'.repeat(400) });
  assert.equal(chunks[0].id, 'note:1#title');
  assert.ok(chunks.some(chunk => chunk.heading === '步骤'));
});

test('knowledge notes reject stale versions and imported file bodies stay read-only', (t) => {
  const { db } = tempDb(t);
  const knowledge = createKnowledgeService(db);
  const created = knowledge.createNote({ title: '方案', content: '第一版' }).document;
  const updated = knowledge.updateDocument(created.id, { content: '第二版', baseVersion: created.version }).document;
  assert.equal(updated.content, '第二版');
  const conflict = knowledge.updateDocument(created.id, { content: '过期覆盖', baseVersion: created.version });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.current.content, '第二版');

  const file = knowledge.saveImportedFile({
    buffer: Buffer.from('original'),
    filename: 'guide.txt',
    mimeType: 'text/plain',
    title: '指南',
    collectionPath: '开发',
    text: '只读原文',
    status: 'active',
    diaryUnlocked: false,
  }).document;
  const rejected = knowledge.updateDocument(file.id, { content: '改写原文', baseVersion: file.version });
  assert.equal(rejected.status, 400);
  const annotation = knowledge.upsertAnnotation(file.id, { content: '我的批注' }).document;
  assert.equal(annotation.parentDocumentId, file.id);
  assert.equal(annotation.documentRole, 'annotation');
  assert.equal(knowledge.getAnnotation(file.id).content, '我的批注');
});

test('knowledge bases and folders normalize legacy paths and preserve log metadata', (t) => {
  const { db } = tempDb(t);
  const knowledge = createKnowledgeService(db);
  const note = knowledge.createNote({
    title: '行业笔记',
    content: '正文',
    knowledgeBase: '投资',
    folderPath: '行业洞悉',
    documentDate: '2026-08-18',
  }).document;
  assert.equal(note.collectionPath, '投资/行业洞悉');
  assert.equal(note.knowledgeBase, '投资');
  assert.equal(note.folderPath, '行业洞悉');
  assert.equal(note.documentDate, '2026-08-18');

  const moved = knowledge.updateDocument('log:1', {
    knowledgeBase: '投资',
    folderPath: '行业洞悉',
    documentDate: '2026-08-18',
  }, { diaryUnlocked: false }).document;
  assert.equal(moved.collectionPath, '投资/行业洞悉');
  assert.equal(moved.documentDate, '2026-08-18');
  const raw = db.getById(1);
  assert.equal(raw.category, '投资/行业洞悉');
  assert.equal(raw.log_date, '2026-08-18');
  assert.equal(raw.hours, 2);
  assert.equal(raw.pinned, true);

  knowledge.rewriteCollectionPath('投资/行业洞悉', '投资/事件');
  const rewritten = knowledge.getDocument(note.id);
  assert.equal(rewritten.collectionPath, '投资/事件');
  const rewrittenLog = knowledge.getDocument('log:1');
  assert.equal(rewrittenLog.collectionPath, '投资/行业洞悉');
});

test('knowledge tree maps category roots to bases and children to folders', () => {
  const db = { isDiaryCategory: value => value === '日记' || String(value).startsWith('日记/') };
  const tree = treeForDocuments([
    { name: '投资', sub: ['行业洞悉', '事件'] },
    { name: '日记', sub: ['人'] },
  ], [
    { knowledgeBase: '投资', folderPath: '行业洞悉', visibility: 'standard' },
    { knowledgeBase: '投资', folderPath: '', visibility: 'standard' },
  ], db);
  assert.deepEqual(tree.map(item => item.name), ['投资', '日记']);
  assert.equal(tree[0].documentCount, 2);
  assert.equal(tree[0].folders.find(item => item.name === '行业洞悉').documentCount, 1);
  assert.equal(tree[1].visibility, 'diary');
});

test('uploaded filenames recover UTF-8 Chinese from multer latin1 mojibake', async (t) => {
  const chinese = '测试.png';
  const mojibake = Buffer.from(chinese, 'utf8').toString('latin1');
  assert.equal(decodeUploadedFilename(mojibake), chinese);
  assert.equal(decodeUploadedFilename(chinese), chinese);
  assert.equal(decodeUploadedFilename('photo.png'), 'photo.png');
  assert.match(contentDisposition(mojibake), /filename\*=UTF-8''%E6%B5%8B%E8%AF%95\.png/);

  const { db, dir } = tempDb(t);
  const knowledge = createKnowledgeService(db);
  const imported = knowledge.saveImportedFile({
    buffer: Buffer.from('fake-image-bytes-cn'),
    filename: mojibake,
    mimeType: 'image/png',
    title: mojibake,
    collectionPath: '其他',
    text: '',
    status: 'active',
    previewKind: 'image',
    diaryUnlocked: false,
  }).document;
  assert.equal(imported.title, chinese);
  assert.equal(imported.fileMeta.filename, chinese);

  const ascii = knowledge.saveImportedFile({
    buffer: Buffer.from('fake-image-bytes-ascii'),
    filename: 'photo.png',
    mimeType: 'image/png',
    title: '照片',
    collectionPath: '其他',
    text: '',
    status: 'active',
    previewKind: 'image',
    diaryUnlocked: false,
  }).document;
  const storePath = path.join(dir, 'knowledge-documents.json');
  const store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  const record = store.documents.find(item => item.id === ascii.id);
  record.title = mojibake;
  record.fileMeta.filename = mojibake;
  fs.writeFileSync(storePath, JSON.stringify(store, null, 2));

  const loaded = knowledge.getDocument(ascii.id);
  assert.equal(loaded.title, chinese);
  assert.equal(loaded.fileMeta.filename, chinese);

  const hydrated = await knowledge.hydrateFilePreview(loaded);
  assert.equal(hydrated.title, chinese);
  assert.equal(hydrated.fileMeta.filename, chinese);
  const persisted = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  const after = persisted.documents.find(item => item.id === ascii.id);
  assert.equal(after.title, chinese);
  assert.equal(after.fileMeta.filename, chinese);
});
