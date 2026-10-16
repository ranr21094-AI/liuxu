const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { app, BrowserWindow } = require('electron');
const repo = path.resolve(process.env.LIUXU_TEST_REPO || path.join(__dirname, '..'));
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'liuxu-file-ui-'));
const dataDir = path.join(temporary, 'data'), root = path.join(temporary, 'files');
fs.mkdirSync(dataDir); fs.mkdirSync(root);
app.setPath('userData', path.join(temporary, 'desktop'));
process.env.DATA_DIR = dataDir; process.env.AI_SECRETS_KEY_FILE = path.join(dataDir, 'key'); process.env.LIUXU_DESKTOP = '0';
fs.writeFileSync(path.join(dataDir, '.knowledge-file-workspace.json'), JSON.stringify({ format: 'liuxu-file-workspace', version: 1, rootPath: root }));
fs.writeFileSync(path.join(root, 'root-note.md'), 'first');
fs.writeFileSync(path.join(root, 'second.md'), 'second note');
async function until(condition, label) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { if (await condition()) return; await new Promise(resolve => setTimeout(resolve, 70)); }
  throw new Error(`Timed out: ${label}`);
}
async function main() {
  const db = require(path.join(repo, 'database'));
  const routes = require(path.join(repo, 'lib/knowledge/routes'));
  const knowledge = routes.serviceFor(db).knowledge; await knowledge.backgroundReady;
  const doc = knowledge.nativeDocuments().find(item => item.relativePath === 'root-note.md');
  const second = knowledge.nativeDocuments().find(item => item.relativePath === 'second.md');
  const server = await require(path.join(repo, 'server')).startServer(0, '127.0.0.1');
  const window = new BrowserWindow({ show: false, width: 1280, height: 850, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  const js = code => window.webContents.executeJavaScript(code);
  try {
    await window.loadURL(`http://127.0.0.1:${server.address().port}/#knowledge`);
    await until(() => js("document.querySelector('#knowledgeBaseList')?.textContent.includes('根目录')"), 'root directory');
    await js(`document.querySelector('[data-knowledge-base-open=":root:"]').click()`);
    await until(() => js(`Boolean(document.querySelector('[data-document-open="${doc.id}"]'))`), 'root file');
    await js(`document.querySelector('[data-document-open="${doc.id}"]').click()`);
    await until(() => js("document.querySelector('#documentContent')?.value === 'first'"), 'editor reads disk');
    await js(`window.retainedRow=document.querySelector('[data-document-open="${doc.id}"]');document.querySelector('[data-document-open="${second.id}"]').click()`);
    await until(() => js("document.querySelector('#documentContent')?.value === 'second note'"), 'same-folder next note');
    assert.equal(await js(`window.retainedRow===document.querySelector('[data-document-open="${doc.id}"]')`), true);
    await js(`document.querySelector('[data-document-open="${doc.id}"]').click()`);
    await until(() => js("document.querySelector('#documentContent')?.value === 'first'"), 'same-folder return');
    assert.equal(await js("document.querySelector('#renameKnowledgeFileButton').hidden"), false);
    await js("{const editor=document.querySelector('#documentContent');editor.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));editor.value='组合输入中';editor.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:true}));}");
    await new Promise(resolve => setTimeout(resolve, 950));
    assert.equal(fs.readFileSync(path.join(root, 'root-note.md'), 'utf8'), 'first');
    await js("{const editor=document.querySelector('#documentContent');editor.value='edited';editor.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));editor.dispatchEvent(new Event('input',{bubbles:true}));}");
    await until(() => fs.readFileSync(path.join(root, 'root-note.md'), 'utf8') === 'edited', 'autosave writes original');
    await until(() => js("document.querySelector('#documentSaveState').textContent === '已保存'"), 'save acknowledged');
    assert.equal(await js(`window.retainedRow===document.querySelector('[data-document-open="${doc.id}"]')`), true);
    assert.equal(await js("document.querySelector('[data-select-id=\"documentFolderPath\"] .select-control-menu').children.length"), 0);
    await js("document.querySelector('#renameKnowledgeFileButton').click()");
    await until(() => js("document.querySelector('#renameKnowledgeFileDialog').open"), 'rename dialog');
    await js("document.querySelector('#renameKnowledgeFileName').value='renamed.md';document.querySelector('#renameKnowledgeFileForm').requestSubmit();");
    await until(() => fs.existsSync(path.join(root, 'renamed.md')), 'renamed file');
    assert.equal(fs.existsSync(path.join(root, 'root-note.md')), false);
    assert.equal(fs.readFileSync(path.join(root, 'renamed.md'), 'utf8'), 'edited');
    await until(() => js("document.querySelector('#documentTitle').value === 'renamed'"), 'filename fallback title');
    fs.writeFileSync(path.join(root, 'renamed.md'), 'outside');
    const current = await js(`fetch('/api/knowledge/documents/${doc.id}').then(response=>response.json())`);
    assert.equal(current.content, 'outside');
    console.log('File-workspace Electron checks passed: root directory, row retention, IME composition, lazy menus, direct editor, autosave, rename, filename title, fresh external read.');
  } finally {
    window.destroy();
    await routes.shutdownKnowledgeServices();
    await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
    db.close();
  }
}
app.whenReady().then(main).then(() => { fs.rmSync(temporary, { recursive: true, force: true }); app.exit(0); })
  .catch(error => { console.error(error); app.exit(1); });
