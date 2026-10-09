const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const JSZip = require('jszip');
const { createTempDatabase } = require('./db-temp');
const { createKnowledgeService } = require('../lib/knowledge/documents');
const { fileKind } = require('../lib/knowledge/file-formats');
const { validateOfficeArchive } = require('../lib/knowledge/import');
const { cleanPosition } = require('../lib/knowledge/reading-position-state');

test('ebook formats, positions, bounded archives and corrupted EPUBs', async t => {
  const { dir } = createTempDatabase(t, 'ebook-formats-');
  for (const ext of ['epub','mobi','azw3','fb2','cbz']) assert.equal(fileKind(`book.${ext}`).previewKind, 'ebook');
  assert.deepEqual(cleanPosition({ anchor:'epubcfi(/6/2!/4)', fingerprint:'f'.repeat(64), page:3, evil:1 }), { anchor:'epubcfi(/6/2!/4)', fingerprint:'f'.repeat(64), page:3 });
  const zip = new JSZip(); zip.file('META-INF/container.xml', '<container/>'); zip.file('chapter.xhtml', '<p>safe</p>');
  const target = path.join(dir, 'book.epub'); fs.writeFileSync(target, await zip.generateAsync({ type:'nodebuffer' }));
  assert.ok(await validateOfficeArchive(target, 'book.epub'));
  await assert.rejects(validateOfficeArchive(target, 'book.docx'), /不匹配/);
  zip.file('../escape', 'unsafe'); fs.writeFileSync(target, await zip.generateAsync({ type:'nodebuffer' }));
  await assert.rejects(validateOfficeArchive(target, 'book.epub'), /不安全|invalid relative path/);
});

test('reading data preserves handwritten notes, rejects conflicts and survives portable backup', t => {
  const { db } = createTempDatabase(t, 'ebook-data-'); const service = createKnowledgeService(db, { startFolderSync:false });
  const file = service.saveImportedFile({ buffer:Buffer.from('book'), filename:'book.epub', title:'Book', mimeType:'application/epub+zip', text:'' }).document;
  service.upsertAnnotation(file.id, { content:'我的手写内容' });
  let state = service.getReadingData(file.id);
  const entry = { id:'one', type:'highlight', anchor:'epubcfi(/6/2!/4)', fingerprint:state.fingerprint, quote:'原文', note:'想法', label:'第一章' };
  const update = entries => service.updateReadingData(file.id, { ...state, baseRevision:state.revision, entries });
  let result = update([entry]); assert.ok(result.readingData, JSON.stringify(result));
  assert.match(service.getAnnotation(file.id).content, /^我的手写内容/); assert.match(service.getAnnotation(file.id).content, /原文/);
  assert.equal(update([entry]).status,409);
  state = result.readingData; result = update([{ ...entry, note:'修改想法' }]); assert.ok(result.readingData);
  assert.match(service.getAnnotation(file.id).content, /修改想法/);
  const backup = db.backup(); assert.ok(JSON.stringify(backup).includes('epubcfi(/6/2!/4)'));
  state = result.readingData; result = update([]); assert.ok(result.readingData);
  assert.match(service.getAnnotation(file.id).content, /^我的手写内容/); assert.doesNotMatch(service.getAnnotation(file.id).content, /修改想法/);
  assert.equal(db.restore(backup).success, true);
  assert.equal(service.getReadingData(file.id).entries[0].note, '修改想法');
  assert.match(service.getAnnotation(file.id).content, /修改想法/);
  service.archiveDocument(file.id); state = service.getReadingData(file.id); assert.equal(update([]).status,403);
});

test('comic highlights and locked diary reading data are rejected', t => {
  const { db } = createTempDatabase(t, 'ebook-access-'); const service = createKnowledgeService(db, { startFolderSync:false });
  const file = service.saveImportedFile({ buffer:Buffer.from('comic'), filename:'book.cbz', title:'Book', text:'' }).document;
  const state = service.getReadingData(file.id);
  assert.equal(service.updateReadingData(file.id, { ...state, baseRevision:0, entries:[{ id:'one', type:'highlight', anchor:'page:1', fingerprint:state.fingerprint, quote:'x' }] }).status,400);
  const privateFile = service.saveImportedFile({ buffer:Buffer.from('private'), filename:'private.epub', collectionPath:'日记', diaryUnlocked:true }).document;
  assert.equal(service.getReadingData(privateFile.id),null);
  assert.equal(service.updateReadingData(privateFile.id, {}).status,404);
});

test('changed binaries reject stale highlights without changing annotations', t => {
  const { db } = createTempDatabase(t, 'ebook-changed-'); const service = createKnowledgeService(db, { startFolderSync:false });
  const file = service.saveImportedFile({ buffer:Buffer.from('original'), filename:'book.epub', title:'Book' }).document;
  const state = service.getReadingData(file.id);
  fs.writeFileSync(service.filePathFor(file), 'changed');
  const result = service.updateReadingData(file.id, { ...state, baseRevision:0, entries:[{ id:'one',type:'highlight',anchor:'x',fingerprint:state.fingerprint,quote:'old text' }] });
  assert.equal(result.status,409); assert.equal(service.getAnnotation(file.id),null); assert.equal(service.getReadingData(file.id).revision,0);
});

test('reading excerpt writes respect external annotation conflicts', t => {
  const { db, dir } = createTempDatabase(t, 'ebook-sync-'); const service = createKnowledgeService(db, { startFolderSync:false });
  t.after(() => service.folderSync.stop());
  const file = service.saveImportedFile({ buffer:Buffer.from('original'), filename:'book.epub', title:'Book' }).document;
  service.upsertAnnotation(file.id, { content:'手写内容' });
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'ebook-sync-root-'));
  t.after(() => fs.rmSync(root,{recursive:true,force:true}));
  service.folderSync.migrateAll({ rootPath:root }); service.folderSync.stop();
  const annotation = service.getAnnotation(file.id); const annotationPath = service.folderSync.localPathFor(annotation);
  fs.appendFileSync(annotationPath, '\n外部编辑尚未同步');
  const state = service.getReadingData(file.id);
  const result = service.updateReadingData(file.id, { ...state, baseRevision:0, entries:[{ id:'one',type:'highlight',anchor:'x',fingerprint:state.fingerprint,quote:'摘录' }] });
  assert.equal(result.status,409); assert.equal(service.getReadingData(file.id).revision,0);
  assert.match(fs.readFileSync(annotationPath,'utf8'),/外部编辑尚未同步/);
});

test('workspace ZIP restores reading entries and generated notes together', async t => {
  const { db } = createTempDatabase(t, 'ebook-zip-'); const service = createKnowledgeService(db, { startFolderSync:false });
  const file = service.saveImportedFile({ buffer:Buffer.from('original'), filename:'book.epub', title:'Book' }).document;
  const state = service.getReadingData(file.id);
  assert.ok(service.updateReadingData(file.id, { ...state, baseRevision:0, entries:[{ id:'one',type:'highlight',anchor:'x',fingerprint:state.fingerprint,quote:'摘录' }] }).readingData);
  const { exportWorkspace, restoreWorkspace } = require('../lib/workspace/zip');
  const zip = await exportWorkspace(db);
  const { db: target } = createTempDatabase(t,'ebook-zip-target-');
  await restoreWorkspace(target,zip);
  const restored = createKnowledgeService(target,{ startFolderSync:false });
  assert.equal(restored.getReadingData(file.id).entries[0].quote,'摘录');
  assert.match(restored.getAnnotation(file.id).content,/摘录/);
  assert.equal(fs.readFileSync(restored.filePathFor(restored.getDocument(file.id)),'utf8'),'original');
});

test('TXT encoding and chapter splitting preserve full text, and old default sync gains ebooks', async t => {
  const { decodeBookText, splitTextChapters } = await import('../public/js/knowledge/book-reader.js');
  assert.equal(decodeBookText(Buffer.from('中文')),'中文');
  assert.equal(decodeBookText(Buffer.from([0xff,0xfe,0x2d,0x4e])),'中');
  assert.equal(decodeBookText(Buffer.from([0xfe,0xff,0x4e,0x2d])),'中');
  assert.equal(decodeBookText(Buffer.from([0xd6,0xd0,0xce,0xc4])),'中文');
  assert.deepEqual(splitTextChapters('第一章 开始\n正文\n第二章 后续\n末尾').map(x=>x.title),['第一章 开始','第二章 后续']);
  const { db, dir } = createTempDatabase(t,'ebook-defaults-');
  const { DEFAULT_SYNC_EXTENSIONS } = require('../lib/knowledge/folder-sync');
  const old = DEFAULT_SYNC_EXTENSIONS.filter(ext=>!['.epub','.mobi','.azw3','.fb2','.cbz'].includes(ext));
  fs.writeFileSync(path.join(dir,'.knowledge-folder.json'),JSON.stringify({syncExtensions:old}));
  assert.ok(createKnowledgeService(db,{startFolderSync:false}).folderSync.config.syncExtensions.includes('.epub'));
  fs.writeFileSync(path.join(dir,'.knowledge-folder.json'),JSON.stringify({syncExtensions:['.md','.pdf']}));
  assert.deepEqual(createKnowledgeService(db,{startFolderSync:false}).folderSync.config.syncExtensions,['.md','.pdf']);
});
