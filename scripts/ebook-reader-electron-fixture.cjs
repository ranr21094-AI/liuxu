const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const JSZip = require('jszip');
const { app, BrowserWindow } = require('electron');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'liuxu-ebook-'));
process.env.DATA_DIR = dataDir;
process.env.AI_SECRETS_KEY_FILE = path.join(dataDir, 'secrets');
process.env.LIUXU_KNOWLEDGE_ROOT = path.join(dataDir,'knowledge');
process.env.LIUXU_DESKTOP = '0';
app.setPath('userData', path.join(dataDir, 'electron-profile'));
function makePdf() {
  const stream = 'BT /F1 24 Tf 72 700 Td (PDF preview sample) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf, 'ascii');
}

async function epub() {
 const zip = new JSZip(); zip.file('mimetype', 'application/epub+zip');
 zip.file('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
 zip.file('book.opf', '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="uid">fixture</dc:identifier><dc:title>阅读测试</dc:title><dc:language>zh</dc:language></metadata><manifest><item id="picture" href="picture.png" media-type="image/png"/><item id="style" href="style.css" media-type="text/css"/><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="one" href="one.xhtml" media-type="application/xhtml+xml"/><item id="two" href="two.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="one"/><itemref idref="two"/></spine></package>');
 zip.file('nav.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>目录</title></head><body><nav epub:type="toc"><ol><li><a href="one.xhtml">第一章</a></li><li><a href="two.xhtml">第二章</a></li></ol></nav></body></html>');
 zip.file('picture.png',Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==','base64'));
 zip.file('style.css', 'h1 { color: rgb(123, 45, 67); }');
 for (const name of ['one','two']) zip.file(`${name}.xhtml`, `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${name}</title><link rel="stylesheet" href="style.css"/></head><body><img src="picture.png"/><h1>${name}</h1><script>parent.__bookScriptRan=true</script><img src="https://ebook-network.invalid/leak"/>${Array.from({length:80},(_,i)=>`<p>第${i}段 舒适阅读测试，这是可摘录的文字。 Reading sample.</p>`).join('')}</body></html>`);
 return zip.generateAsync({type:'nodebuffer'});
}
async function wait(w, code, label, timeout=20000) {
 const start=Date.now(); while(Date.now()-start<timeout) { if(await w.webContents.executeJavaScript(code)) return; await new Promise(r=>setTimeout(r,100)); }
 throw new Error(`Timeout ${label}: ${await w.webContents.executeJavaScript("document.querySelector('#filePreviewHost')?.textContent")}`);
}
(async()=>{
 const db=require('../database'); const { createKnowledgeService }=require('../lib/knowledge/documents'); const knowledge=createKnowledgeService(db, {startFolderSync:false});
 const add=(name,buffer)=>knowledge.saveImportedFile({filename:name,title:name,buffer,text:'',collectionPath:'测试书架'}).document;
 const books=[add('测试.epub',await epub()),add('小说.txt',Buffer.from('第一章 开始\n'+('舒适阅读测试。\n'.repeat(200))+'第二章 继续\n第二章文字'))];
 books.push(add('文字.pdf', makePdf()));
 const fixed = await JSZip.loadAsync(await epub());
 fixed.file('book.opf', (await fixed.file('book.opf').async('string')).replace('</metadata>', '<meta property="rendition:layout">pre-paginated</meta></metadata>'));
 for (const name of ['one','two']) fixed.file(`${name}.xhtml`, `<html xmlns="http://www.w3.org/1999/xhtml"><head><meta name="viewport" content="width=600,height=800"/><title>固定版式</title></head><body><h1>固定页面 ${name}</h1><p>排版测试</p></body></html>`);
 books.push(add('固定版式.epub', await fixed.generateAsync({type:'nodebuffer'})));
 const comic=new JSZip(); comic.file('page01.png',Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==','base64')); books.push(add('漫画.cbz',await comic.generateAsync({type:'nodebuffer'})));
 books.push(add('小说.fb2',Buffer.from('<?xml version="1.0"?><FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0"><description><title-info><book-title>测试小说</book-title><lang>zh</lang></title-info></description><body><section><title><p>第一章</p></title><p>舒适阅读测试正文</p></section></body></FictionBook>')));
 if(process.env.LIUXU_TEST_BOOKS) for(const name of fs.readdirSync(process.env.LIUXU_TEST_BOOKS).filter(x=>/\.(epub|mobi|pdf|azw3)$/i.test(x))) books.push(add(name,fs.readFileSync(path.join(process.env.LIUXU_TEST_BOOKS,name))));
 const server=await require('../server').startServer(0,'127.0.0.1'); await app.whenReady();
 const w=new BrowserWindow({show:true,width:1280,height:850,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
 w.webContents.on('console-message',event=>{ if(event.level>=2) console.error(`${event.message} (${event.sourceId}:${event.lineNumber})`); });
 const network=[]; w.webContents.session.webRequest.onBeforeRequest((details,done)=>{ if(details.url.startsWith('https://ebook-network.invalid')) network.push(details.url); done({}); });
 try {
 for(const book of books) {
   await w.loadURL(`http://127.0.0.1:${server.address().port}/#knowledge/${encodeURIComponent(book.id)}`);
   await wait(w, `document.querySelector('#fileName')?.textContent === ${JSON.stringify(book.fileMeta.filename)}`, 'correct file');
   if(book.fileMeta.filename.endsWith('.pdf')) await wait(w,"document.querySelector('.file-pdf-page-shell[data-rendered=true]')",book.title,45000);
   else {
     await wait(w,"document.querySelector('#filePreviewHost')?.dataset.bookReady === 'true'",book.title,45000);
     assert.ok(await w.webContents.executeJavaScript("document.querySelector('foliate-view').renderer.getContents().length > 0"));
   }
   console.log('OPENED',book.fileMeta.filename, await w.webContents.executeJavaScript("({name:document.querySelector('#fileName')?.textContent,url:location.hash,kind:document.querySelector('#filePreviewHost')?.dataset.previewKind})"));
   if(book===books[0]) {
     await wait(w, "document.querySelector('foliate-view').renderer.getContents()[0].doc.querySelector('img')?.naturalWidth > 0", 'embedded image');
     assert.equal(await w.webContents.executeJavaScript("(()=>{const d=document.querySelector('foliate-view').renderer.getContents()[0].doc;return d.defaultView.getComputedStyle(d.querySelector('h1')).color})()"), 'rgb(123, 45, 67)');
     await w.webContents.executeJavaScript("window.view=document.querySelector('foliate-view'); view.goTo(1)");
     await wait(w,"view.renderer.getContents().some(x=>x.index===1)",'second chapter');
     await w.webContents.executeJavaScript("let c=view.renderer.getContents()[0]; let p=c.doc.querySelector('p'); let r=c.doc.createRange();r.selectNodeContents(p);c.doc.getSelection().removeAllRanges();c.doc.getSelection().addRange(r);c.doc.dispatchEvent(new Event('selectionchange'))");
     await wait(w,"[...document.querySelectorAll('button')].some(b=>b.textContent==='划线摘录'&&!b.hidden)",'select quote');
     await w.webContents.executeJavaScript("[...document.querySelectorAll('button')].find(b=>b.textContent==='划线摘录').click()");
     await wait(w,"document.querySelector('.book-edit-dialog[open]')",'quote dialog');
     await w.webContents.executeJavaScript("document.querySelector('.book-edit-dialog [name=note]').value='验收想法';document.querySelector('.book-edit-dialog [data-save]').click()");
     await wait(w,"!document.querySelector('.book-edit-dialog')",'quote saved');
     assert.match(knowledge.getAnnotation(book.id).content,/验收想法/);
     assert.equal(await w.webContents.executeJavaScript('Boolean(window.__bookScriptRan)'),false);
     await new Promise(r=>setTimeout(r,500));
     await w.reload(); await wait(w,"document.querySelector('#filePreviewHost')?.dataset.bookReady === 'true'",'reload');
     assert.ok(await w.webContents.executeJavaScript("document.querySelector('foliate-view').renderer.getContents().some(x=>x.index===1)"));
     await w.webContents.executeJavaScript("document.querySelector('select[aria-label=字号]').value='28';document.querySelector('select[aria-label=字号]').dispatchEvent(new Event('change'));[...document.querySelectorAll('#filePreviewHost button')].find(b=>b.textContent==='书签与摘录').click();[...document.querySelectorAll('.book-notes button')].find(b=>b.textContent==='返回原文').click()");
     await wait(w, "document.querySelector('.book-notes').hidden && !document.querySelector('.book-status').textContent.includes('无法定位')", 'jump to quote after reflow');
     await w.webContents.executeJavaScript("document.querySelector('input[aria-label=搜索书内文字]').value='舒适阅读测试';[...document.querySelectorAll('#filePreviewHost button')].find(b=>b.textContent==='查找').click()");
     await wait(w, "document.querySelector('.book-status').textContent.includes('找到') && document.querySelectorAll('.book-nav button').length > 1", 'book search');
     await w.webContents.executeJavaScript("document.querySelectorAll('.book-nav button')[1].click();[...document.querySelectorAll('#filePreviewHost button')].find(b=>b.textContent==='专注阅读').click()");
     assert.ok(await w.webContents.executeJavaScript("document.querySelector('#filePreviewHost').classList.contains('book-focus')"));
     await w.webContents.executeJavaScript("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))");
     assert.equal(await w.webContents.executeJavaScript("document.querySelector('#filePreviewHost').classList.contains('book-focus')"), false);
     fs.writeFileSync('/tmp/liuxu-ebook-reader.png',(await w.webContents.capturePage()).toPNG());
     w.setSize(390,844);
     await new Promise(resolve => setTimeout(resolve, 250));
     assert.ok(await w.webContents.executeJavaScript("document.documentElement.scrollWidth <= window.innerWidth + 2"), 'narrow screen has no horizontal overflow');
     fs.writeFileSync('/tmp/liuxu-ebook-reader-mobile.png',(await w.webContents.capturePage()).toPNG());
     w.setSize(1280,850);

   }
   if(book.fileMeta.filename === '文字.pdf') {
     await wait(w, "document.querySelector('.file-pdf-text-layer span') && [...document.querySelectorAll('#filePreviewHost button')].some(b=>b.textContent==='加书签')", 'PDF tools');
     await w.webContents.executeJavaScript("let layer=document.querySelector('.file-pdf-text-layer');let r=document.createRange();r.selectNodeContents(layer);getSelection().removeAllRanges();getSelection().addRange(r);document.dispatchEvent(new Event('selectionchange'));[...document.querySelectorAll('#filePreviewHost button')].find(b=>b.textContent==='划线摘录').click()");
     await wait(w, "document.querySelector('.book-edit-dialog[open]')", 'PDF quote');
     await w.webContents.executeJavaScript("document.querySelector('.book-edit-dialog [data-save]').click()");
     await wait(w, "document.querySelector('.book-pdf-highlight')", 'PDF highlight');
     assert.match(knowledge.getAnnotation(book.id).content,/PDF preview sample/);
     await w.webContents.executeJavaScript("document.querySelector('[data-file-action=zoom-in]').click()");
     await wait(w, "document.querySelector('.file-pdf-page-shell[data-rendered=true] .book-pdf-highlight')", 'PDF highlight after zoom');
     await w.reload();
     await wait(w, "document.querySelector('.book-pdf-highlight')", 'PDF highlight after reload');

   }
   if(book.fileMeta.filename === '固定版式.epub') {
     await w.webContents.executeJavaScript("let d=document.querySelector('foliate-view').renderer.getContents()[0].doc;let r=d.createRange();r.selectNodeContents(d.querySelector('p'));d.getSelection().removeAllRanges();d.getSelection().addRange(r);d.dispatchEvent(new Event('selectionchange'))");
     await wait(w, "[...document.querySelectorAll('#filePreviewHost button')].some(b=>b.textContent==='划线摘录'&&!b.hidden)", 'fixed layout text selection');
     await w.webContents.executeJavaScript("[...document.querySelectorAll('#filePreviewHost button')].find(b=>b.textContent==='划线摘录').click();document.querySelector('.book-edit-dialog [data-save]').click()");
     await wait(w, "!document.querySelector('.book-edit-dialog')", 'fixed layout quote saved');
     assert.match(knowledge.getAnnotation(book.id).content,/排版测试/);
     await w.webContents.executeJavaScript("[...document.querySelectorAll('#filePreviewHost button')].find(b=>b.textContent==='双页').click()");
     await wait(w, "document.querySelector('foliate-view').renderer.getContents().length===2", 'two page spread');
   }
   if(book.fileMeta.filename.endsWith('.cbz')) {
     await wait(w, "document.querySelector('foliate-view').renderer.getContents().some(x=>x.doc.querySelector('img')?.naturalWidth>0)", 'comic image');
   }
   if(book.fileMeta.filename.endsWith('.cbz')) assert.equal(await w.webContents.executeJavaScript("[...document.querySelectorAll('#filePreviewHost button')].some(b=>b.textContent==='划线摘录')"),false);
 }
 assert.deepEqual(network,[],'book content cannot load remote resources');
 console.log('EBOOK ACCEPTANCE PASSED');
 } finally {w.destroy();server.close();require('../lib/db/connection').closeAllDatabases();fs.rmSync(dataDir,{recursive:true,force:true});app.quit();}
})().catch(e=>{console.error(e);app.exit(1)});
