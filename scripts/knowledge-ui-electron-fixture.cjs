const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'liuxu-ui-v149-'));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'liuxu-ui-root-'));
process.env.DATA_DIR = dataDir;
process.env.AI_SECRETS_KEY_FILE = path.join(dataDir, 'key');
process.env.LIUXU_DESKTOP = '0';
async function wait(wc, condition, label) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await wc.executeJavaScript(condition)) return;
    await new Promise(resolve => setTimeout(resolve, 70));
  }
  console.error(await wc.executeJavaScript("JSON.stringify({hash:location.hash,rows:document.querySelectorAll('[data-document-type]').length,text:document.querySelector('#knowledgeDocumentList')?.textContent.slice(0,1800)})"));
  throw new Error('Timed out: ' + label);
}
async function main() {
  const db = require('../database');
  const knowledge = require('../lib/knowledge/documents').createKnowledgeService(db);
  db.addCategory('验证'); db.addCategory('资料', '验证');
  const content = '# 标题\n\n正文\n\n## 子标题\n\n```md\n# 不应出现在目录\n```';
  const note = knowledge.createNote({ title: '目录验证', knowledgeBase: '验证', content }).document;
  const other = knowledge.createNote({ title: '另一篇', knowledgeBase: '验证', content: '# Another' }).document;
  for (const [filename, mimeType] of [['test.py','text/x-python'],['test.png','image/png'],['test.mp3','audio/mpeg'],['test.mp4','video/mp4'],['test.zip','application/zip'],['test.pdf','application/pdf']]) {
    knowledge.saveImportedFile({ buffer: Buffer.from('fixture ' + filename), filename, mimeType, text: '', knowledgeBase: '验证' });
  }
  knowledge.setDocumentPinned(note.id, true);
  db.setCategoryPinned('验证/资料', true);
  knowledge.folderSync.migrateAll({ rootPath: root });
  fs.writeFileSync(path.join(root, '验证', 'unknown.bin'), 'not synced');
  await knowledge.folderSync.syncNow();
  const server = await require('../server').startServer(0, '127.0.0.1');
  const win = new BrowserWindow({ width: 1280, height: 850, show: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const wc = win.webContents;
  const js = code => wc.executeJavaScript(code);
  try {
    await win.loadURL(`http://127.0.0.1:${server.address().port}/#knowledge`);
    await wait(wc, "Boolean(document.querySelector('[data-knowledge-base-open]'))", 'root');
    assert.equal(await js("document.querySelector('#knowledgeBaseList .knowledge-base-select small') === null"), true);
    assert.equal(await js("document.querySelector('#topbarSubtitle').textContent.includes('个')"), false);
    await js("document.querySelector('[data-knowledge-base-open=验证]').click()");
    await wait(wc, "document.querySelectorAll('#knowledgeDocumentList [data-document-type]').length===8", 'file types');
    assert.equal(await js("document.querySelectorAll('#knowledgeDocumentList [data-list-group=local]').length"), 1);
    assert.deepEqual(await js("[...document.querySelectorAll('#knowledgeDocumentList .knowledge-list-section')].map(e=>e.textContent)"), ['置顶','文件','未同步项']);
    assert.equal(await js("new Set([...document.querySelectorAll('[data-document-type]')].map(e=>e.dataset.documentType)).size"), 7);
    await js(`document.querySelector('[data-document-open="${note.id}"]').click()`);
    await wait(wc, "!document.querySelector('#markdownTocToggle').hidden", 'editor');
    assert.equal(await js("document.querySelector('#markdownToc').hidden"), true);
    await js("document.querySelector('#markdownTocToggle').click()");
    assert.equal(await js("document.querySelectorAll('#markdownToc a').length"), 2);
    await js("document.querySelectorAll('#markdownToc a')[1].click()");
    assert.equal(await js("document.querySelector('#documentContent').selectionStart"), content.indexOf('## 子标题'));
    const route = await js('location.hash');
    await js("const input=document.querySelector('#documentContent');input.value+='\\n\\n## 新标题';input.dispatchEvent(new Event('input',{bubbles:true}))");
    await wait(wc, "document.querySelectorAll('#markdownToc a').length===3", 'draft toc');
    for (const mode of ['preview','split','edit']) {
      await js(`document.querySelector('[data-editor-mode=${mode}]').click()`);
      await wait(wc, "!document.querySelector('#markdownToc').hidden", mode + ' toc');
    }
    await js("document.querySelector('[data-editor-mode=preview]').click();document.querySelector('#markdownToc a').click()");
    assert.equal(await js('location.hash'), route);
    await js(`document.querySelector('[data-document-open="${other.id}"]').click()`);
    await wait(wc, "document.querySelector('#documentTitle').value==='另一篇'", 'other document');
    assert.equal(await js("document.querySelector('#markdownToc').hidden"), true);
    await js(`document.querySelector('[data-document-open="${note.id}"]').click()`);
    await wait(wc, "document.querySelector('#documentTitle').value==='目录验证'", 'reopen');
    assert.equal(await js("document.querySelector('#markdownToc').hidden"), true);
    win.setSize(390, 844);
    await js("document.querySelector('#markdownTocToggle').click()");
    await wait(wc, "getComputedStyle(document.querySelector('#markdownToc')).gridRowStart==='1'", 'narrow toc');
    assert.equal(await js("document.documentElement.scrollWidth<=innerWidth"), true);
    assert.equal(await js("getComputedStyle(document.querySelector('#documentContent')).gridRowStart"), '2');
    await js("document.querySelector('#markdownTocToggle').click()");
    assert.equal(await js("document.querySelector('#noteEditor').classList.contains('has-markdown-toc')"), false);
    console.log('Knowledge UI Electron checks passed: root counts, type groups, mixed pins, source heading navigation, drafts, modes, route preservation, reopen reset, mobile layout.');
  } finally {
    win.destroy(); knowledge.folderSync.stop();
    require('../lib/knowledge/routes').invalidateKnowledgeCache(dataDir);
    await new Promise(resolve => server.close(resolve)); db.close();
  }
}
app.whenReady().then(main).then(() => { fs.rmSync(dataDir,{recursive:true,force:true});fs.rmSync(root,{recursive:true,force:true});app.exit(0); }).catch(error => { console.error(error);app.exit(1); });
