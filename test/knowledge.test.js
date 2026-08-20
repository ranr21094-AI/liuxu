const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createKnowledgeService } = require('../lib/knowledge/documents');
const { createSearchIndex } = require('../lib/knowledge/search');
const { treeForDocuments, documentSummary } = require('../lib/knowledge/routes');
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

test('knowledge searchDocuments applies tag and date filters before minisearch', (t) => {
  const { db } = tempDb(t);
  const knowledge = createKnowledgeService(db);
  knowledge.createNote({
    title: '苹果笔记',
    content: '正文里有苹果',
    tags: ['fruit'],
    documentDate: '2026-05-16',
  });
  knowledge.createNote({
    title: '香蕉笔记',
    content: '正文里也有苹果',
    tags: ['other'],
    documentDate: '2026-05-17',
  });
  const search = createSearchIndex(knowledge);
  const tagged = search.searchDocuments('苹果', { tag: 'fruit', status: 'active' }, {
    diaryUnlocked: false,
    summarize: documentSummary,
  });
  assert.equal(tagged.length, 1);
  assert.equal(tagged[0].title, '苹果笔记');
  assert.ok(tagged[0].searchSnippet);

  const dated = search.searchDocuments('苹果', { date: '2026-05-16', status: 'active' }, {
    diaryUnlocked: false,
    summarize: documentSummary,
  });
  assert.equal(dated.some(item => item.title === '苹果笔记'), true);
  assert.equal(dated.some(item => item.title === '香蕉笔记'), false);
});

test('knowledge searchDocuments aggregates chunk hits by document', (t) => {
  const { db } = tempDb(t);
  const knowledge = createKnowledgeService(db);
  knowledge.createNote({
    title: '长文',
    content: `${'苹果'.repeat(700)}\n\n中间\n\n${'苹果'.repeat(700)}`,
  });
  const search = createSearchIndex(knowledge);
  const raw = search.search('苹果', { diaryUnlocked: false, limit: 100 });
  assert.ok(raw.filter(item => item.documentId.startsWith('note:')).length >= 2);
  const docs = search.searchDocuments('苹果', { status: 'active' }, {
    diaryUnlocked: false,
    summarize: documentSummary,
  });
  const noteHits = docs.filter(item => item.id.startsWith('note:'));
  assert.equal(noteHits.length, 1);
  assert.ok(noteHits[0].searchSnippet);
  assert.equal(typeof noteHits[0].searchOffset, 'number');
});

test('parseSearchOptions defaults to smart preset and clamps fuzzy', () => {
  const { parseSearchOptions, DEFAULT_SEARCH_OPTIONS } = require('../lib/knowledge/search-options');
  assert.equal(DEFAULT_SEARCH_OPTIONS.preset, 'smart');
  assert.equal(DEFAULT_SEARCH_OPTIONS.prefix, true);
  assert.equal(parseSearchOptions({}).preset, 'smart');
  assert.equal(parseSearchOptions({ fuzzy: '9' }).fuzzy, 0.5);
  assert.deepEqual(parseSearchOptions({ fields: 'body,title,invalid' }).fields, ['body', 'title']);
  assert.equal(parseSearchOptions({ preset: 'exact' }).strict, true);
  assert.equal(parseSearchOptions({ preset: 'exact' }).prefix, false);
});

test('searchDocuments honors strict mode and field filters', (t) => {
  const { db } = tempDb(t);
  const knowledge = createKnowledgeService(db);
  knowledge.createNote({
    title: '会议摘要',
    content: '正文不含关键词',
  });
  knowledge.createNote({
    title: '其他',
    content: '这里有苹果',
  });
  const search = createSearchIndex(knowledge);
  const { documentSummary } = require('../lib/knowledge/routes');

  const titleOnly = search.searchDocuments('会议', { status: 'active' }, {
    diaryUnlocked: false,
    summarize: documentSummary,
    searchOptions: {
      preset: 'custom',
      prefix: false,
      fuzzy: 0,
      strict: false,
      fields: ['title'],
      indexFields: ['title'],
    },
  });
  assert.equal(titleOnly.some(item => item.title === '会议摘要'), true);
  assert.equal(titleOnly.some(item => item.title === '其他'), false);

  const bodyOnly = search.searchDocuments('会议', { status: 'active' }, {
    diaryUnlocked: false,
    summarize: documentSummary,
    searchOptions: {
      preset: 'custom',
      prefix: false,
      fuzzy: 0,
      strict: false,
      fields: ['body'],
      indexFields: ['body'],
    },
  });
  assert.equal(bodyOnly.some(item => item.title === '会议摘要'), false);

  const strictApple = search.searchDocuments('苹果', { status: 'active' }, {
    diaryUnlocked: false,
    summarize: documentSummary,
    searchOptions: {
      preset: 'exact',
      prefix: false,
      fuzzy: 0,
      strict: true,
      fields: ['title', 'heading', 'body'],
      indexFields: ['title', 'heading', 'body'],
    },
  });
  assert.equal(strictApple.some(item => item.title === '其他'), true);
  assert.equal(strictApple.some(item => item.title === '会议摘要'), false);
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

test('docx imports embed images as data uris in preview html', async () => {
  const JSZip = require('jszip');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`);
  zip.file('word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>
</Relationships>`);
  zip.file('word/media/image1.png', png);
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
  xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
  xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
  xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
  <w:body>
    <w:p><w:r><w:t>图文</w:t></w:r></w:p>
    <w:p><w:r><w:drawing>
      <wp:inline distT="0" distB="0" distL="0" distR="0">
        <wp:extent cx="952500" cy="952500"/>
        <wp:docPr id="1" name="Picture 1"/>
        <a:graphic>
          <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
            <pic:pic>
              <pic:nvPicPr><pic:cNvPr id="0" name="image1.png"/><pic:cNvPicPr/></pic:nvPicPr>
              <pic:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>
              <pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="952500" cy="952500"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>
            </pic:pic>
          </a:graphicData>
        </a:graphic>
      </wp:inline>
    </w:drawing></w:r></w:p>
  </w:body>
</w:document>`);
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  const extracted = await extractText(buffer, 'image.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.equal(extracted.previewKind, 'docx');
  assert.match(extracted.previewHtml, /data:image\/png;base64,/);
  assert.match(extracted.previewHtml, /<img\b/i);
});

test('imported files keep Unicode stored filenames', (t) => {
  const { db } = tempDb(t);
  const knowledge = createKnowledgeService(db);
  const imported = knowledge.saveImportedFile({
    buffer: Buffer.from('docx content'),
    filename: '高质量学科标签数据.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    title: '高质量学科标签数据',
    collectionPath: '其他',
    text: '正文',
    previewHtml: '<p>正文</p>',
    previewKind: 'docx',
    status: 'active',
    diaryUnlocked: false,
  }).document;
  assert.equal(imported.fileMeta.filename, '高质量学科标签数据.docx');
  assert.match(imported.fileMeta.storedName, /高质量学科标签数据\.docx$/);
  assert.doesNotMatch(imported.fileMeta.storedName, /_+\.docx$/);
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

test('knowledge documents can be permanently deleted', (t) => {
  const { db } = tempDb(t);
  const knowledge = createKnowledgeService(db);

  const note = knowledge.createNote({ title: '草稿', content: '正文' }).document;
  const deletedNote = knowledge.deleteDocument(note.id);
  assert.equal(deletedNote.deleted, true);
  assert.equal(knowledge.getDocument(note.id), null);

  const file = knowledge.saveImportedFile({
    buffer: Buffer.from('file-bytes'),
    filename: 'guide.txt',
    mimeType: 'text/plain',
    title: '指南',
    collectionPath: '开发',
    text: '原文',
    status: 'active',
    diaryUnlocked: false,
  }).document;
  const annotation = knowledge.upsertAnnotation(file.id, { content: '批注' }).document;
  const storedPath = knowledge.filePathFor(file);
  assert.equal(fs.existsSync(storedPath), true);
  const deletedFile = knowledge.deleteDocument(file.id);
  assert.equal(deletedFile.deleted, true);
  assert.equal(fs.existsSync(storedPath), false);
  assert.equal(knowledge.getDocument(file.id), null);
  assert.equal(knowledge.getDocument(annotation.id), null);

  assert.equal(knowledge.getDocument('log:1') !== null, true);
  const deletedLog = knowledge.deleteDocument('log:1');
  assert.equal(deletedLog.deleted, true);
  assert.equal(knowledge.getDocument('log:1'), null);
  assert.equal(db.getById(1), null);

  const diaryNote = knowledge.createNote({
    title: '日记笔记',
    content: '秘密',
    collectionPath: '日记',
  }, { diaryUnlocked: true }).document;
  const locked = knowledge.deleteDocument(diaryNote.id, { diaryUnlocked: false });
  assert.equal(locked.status, 403);
  assert.equal(knowledge.getDocument(diaryNote.id, { diaryUnlocked: true }) !== null, true);
  const unlockedDelete = knowledge.deleteDocument(diaryNote.id, { diaryUnlocked: true });
  assert.equal(unlockedDelete.deleted, true);
  assert.equal(knowledge.getDocument(diaryNote.id, { diaryUnlocked: true }), null);
});

test('knowledge archive hides documents, rejects logs, and blocks updates', (t) => {
  const { db } = tempDb(t);
  const knowledge = createKnowledgeService(db);
  const note = knowledge.createNote({ title: '待归档', content: '正文' }).document;
  const archived = knowledge.archiveDocument(note.id).document;
  assert.equal(archived.status, 'archived');
  assert.equal(knowledge.allDocuments().some(item => item.id === note.id), false);
  assert.equal(knowledge.allDocuments({ includeArchived: true }).some(item => item.id === note.id), true);

  const blocked = knowledge.updateDocument(note.id, { content: '改写' });
  assert.equal(blocked.status, 403);

  const logArchive = knowledge.archiveDocument('log:1');
  assert.equal(logArchive.status, 400);
  assert.equal(knowledge.getDocument('log:1') !== null, true);
});

test('knowledge restore brings archived notes back and cascades file annotations', (t) => {
  const { db } = tempDb(t);
  const knowledge = createKnowledgeService(db);
  const note = knowledge.createNote({ title: '归档笔记', content: '正文' }).document;
  knowledge.archiveDocument(note.id);
  const restored = knowledge.restoreDocument(note.id).document;
  assert.equal(restored.status, 'active');
  assert.equal(knowledge.allDocuments().some(item => item.id === note.id), true);

  const file = knowledge.saveImportedFile({
    buffer: Buffer.from('file-bytes'),
    filename: 'guide.txt',
    mimeType: 'text/plain',
    title: '指南',
    collectionPath: '开发',
    text: '原文',
    status: 'active',
    diaryUnlocked: false,
  }).document;
  const annotation = knowledge.upsertAnnotation(file.id, { content: '批注' }).document;
  knowledge.archiveDocument(file.id);
  assert.equal(knowledge.getDocument(file.id).status, 'archived');
  assert.equal(knowledge.getDocument(annotation.id).status, 'archived');
  assert.equal(knowledge.getAnnotation(file.id), null);

  knowledge.restoreDocument(file.id);
  assert.equal(knowledge.getDocument(file.id).status, 'active');
  assert.equal(knowledge.getDocument(annotation.id).status, 'active');
  assert.equal(knowledge.getAnnotation(file.id)?.id, annotation.id);
});

test('archived imports dedupe by sha256 without creating duplicate files', (t) => {
  const { db, dir } = tempDb(t);
  const knowledge = createKnowledgeService(db);
  const buffer = Buffer.from('same-content');
  const first = knowledge.saveImportedFile({
    buffer,
    filename: 'guide.txt',
    mimeType: 'text/plain',
    title: '指南',
    collectionPath: '开发',
    text: '原文',
    status: 'active',
    diaryUnlocked: false,
  }).document;
  knowledge.archiveDocument(first.id);
  const second = knowledge.saveImportedFile({
    buffer,
    filename: 'guide.txt',
    mimeType: 'text/plain',
    title: '指南',
    collectionPath: '开发',
    text: '原文',
    status: 'active',
    diaryUnlocked: false,
  });
  assert.equal(second.duplicate, true);
  assert.equal(second.archived, true);
  assert.equal(second.document.id, first.id);
  assert.equal(fs.readdirSync(path.join(dir, 'knowledge-files')).length, 1);
});

test('docx hydrate does not rewrite store when preview html already exists', async (t) => {
  const { db, dir } = tempDb(t);
  const knowledge = createKnowledgeService(db);
  const saved = knowledge.saveImportedFile({
    buffer: Buffer.from('docx-bytes'),
    filename: 'brief.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    title: '简报',
    collectionPath: '其他',
    text: '正文',
    previewHtml: '<p>预览正文</p>',
    previewKind: 'docx',
    status: 'active',
    diaryUnlocked: false,
  }).document;
  const storePath = path.join(dir, 'knowledge-documents.json');
  const before = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  const record = before.documents.find(item => item.id === saved.id);
  const updatedAt = record.updatedAt;
  const version = record.version;

  const hydrated = await knowledge.hydrateFilePreview(knowledge.getDocument(saved.id));
  assert.match(hydrated.previewHtml, /预览正文/);

  const after = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  const persisted = after.documents.find(item => item.id === saved.id);
  assert.equal(persisted.updatedAt, updatedAt);
  assert.equal(persisted.version, version);
});
