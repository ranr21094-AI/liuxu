const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'liuxu-mindmap-electron-'));
process.env.DATA_DIR = dataDir;
process.env.AI_SECRETS_KEY_FILE = path.join(dataDir, 'ai-secrets.key');
process.env.LIUXU_DESKTOP = '0';
const shots = path.join(__dirname, '../docs/images');
async function waitFor(wc, code, label) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) { if (await wc.executeJavaScript(code)) return; await new Promise(r => setTimeout(r, 60)); }
  throw new Error(`Timed out: ${label}`);
}
async function main() {
  const db = require('../database');
  const knowledge = require('../lib/knowledge/documents').createKnowledgeService(db);
  const nodes = [{ id: 'root', text: '项目计划', x: 0, y: 0 }], edges = [];
  for (const [i, text] of ['产品体验', '技术方案', '验证交付', '发布准备'].entries()) {
    const id = `b${i}`; nodes.push({ id, text, x: 0, y: 0, side: i % 2 ? 'left' : 'right' }); edges.push({ source: 'root', target: id });
    for (const [j, sub] of (i === 0 ? ['直接编辑主题', '拖动调整分支'] : i === 1 ? ['自动排列与缩放', '保存与冲突保护'] : i === 2 ? ['桌面与触屏测试', '完整回归测试'] : ['使用说明', '源码交付']).entries()) { nodes.push({ id: `${id}-${j}`, text: sub, x: 0, y: 0 }); edges.push({ source: id, target: `${id}-${j}` }); }
  }
  const map = knowledge.createNote({ title: '图形化思维导图', knowledgeBase: '导图验证', documentRole: 'mindmap', content: JSON.stringify({ version: 1, rootId: 'root', nodes, edges, canvas: { width: 1200, height: 700 } }) }).document;
  const plain = knowledge.createNote({ title: '普通笔记', content: '不应被旧画布修改', knowledgeBase: '导图验证' }).document;
  const server = await require('../server').startServer(0, '127.0.0.1');
  const win = new BrowserWindow({ width: 1280, height: 850, show: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const wc = win.webContents;
  const errors = []; wc.on('console-message', (_e, level, message) => { if (level >= 3) errors.push(message); });
  const downloaded = new Promise(resolve => wc.session.once('will-download', (_event, item) => { item.setSavePath(path.join(dataDir, 'map.png')); item.once('done', (_event, state) => resolve(state)); }));
  try {
    await win.loadURL(`http://127.0.0.1:${server.address().port}/#knowledge/${encodeURIComponent(map.id)}`);
    await waitFor(wc, "document.querySelectorAll('#mindmapCanvas [data-node-id]').length === 13 && document.querySelector('#documentContent').hidden", 'graphical editor');
    await new Promise(r => setTimeout(r, 200));
    fs.writeFileSync('/private/tmp/liuxu-mindmap-initial.png', (await wc.capturePage()).toPNG());
    const box = await wc.executeJavaScript("(() => { const r = document.querySelector('[data-node-id=\"b0\"] rect').getBoundingClientRect(); return {x: Math.round(r.x+r.width/2), y: Math.round(r.y+r.height/2)}; })()");
    wc.sendInputEvent({ type: 'mouseMove', ...box });
    wc.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...box }); wc.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...box });
    wc.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 2, ...box }); wc.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 2, ...box });
    await waitFor(wc, "Boolean(document.querySelector('.mindmap-inline-input'))", 'native double click');
    await wc.executeJavaScript("const input=document.querySelector('.mindmap-inline-input'); input.value='图形化编辑体验'; input.dispatchEvent(new Event('input',{bubbles:true}));");
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' }); wc.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
    await waitFor(wc, "!document.querySelector('.mindmap-inline-input') && document.querySelector('[data-node-id=\"b0\"]').textContent.includes('图形化')", 'inline commit');
    await waitFor(wc, "document.querySelector('#documentSaveState')?.textContent.includes('已保存') || document.querySelector('[data-save-state]')?.textContent.includes('已保存')", 'save status').catch(async () => {
      assert.equal(JSON.parse(knowledge.getDocument(map.id).content).nodes.find(n => n.id === 'b0').text, '图形化编辑体验');
    });
    await wc.executeJavaScript("document.querySelector('[data-mindmap-action=\"collapse\"]').click()");
    assert.equal(await wc.executeJavaScript("document.querySelectorAll('#mindmapCanvas [data-node-id]').length"), 11);
    await wc.executeJavaScript("document.querySelector('[data-mindmap-action=\"export\"]').click()");
    assert.equal(await downloaded, 'completed'); assert(fs.statSync(path.join(dataDir, 'map.png')).size > 1000);
    // The live map remains folded after exporting the complete tree.
    assert.equal(await wc.executeJavaScript("document.querySelectorAll('#mindmapCanvas [data-node-id]').length"), 11);
    await wc.executeJavaScript("document.querySelector('[data-mindmap-action=\"expand\"]').click(); document.querySelector('[data-mindmap-action=\"fit\"]').click()");
    await waitFor(wc, "document.querySelectorAll('#mindmapCanvas [data-node-id]').length===13 && document.querySelector('#documentSaveState').textContent.includes('已保存')", 'expanded saved map');
    await wc.executeJavaScript("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
    fs.mkdirSync(shots, { recursive: true }); fs.writeFileSync(path.join(shots, 'mindmap-desktop.png'), (await wc.capturePage()).toPNG());
    // Native pointer events must reparent under zoom, without changing document identity.
    const dragPoints = await wc.executeJavaScript("['b0-0','b2'].map(id=>{const r=document.querySelector('[data-node-id=\"'+id+'\"] rect').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})");
    wc.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...dragPoints[0] });
    wc.sendInputEvent({ type: 'mouseMove', ...dragPoints[1] });
    wc.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...dragPoints[1] });
    await waitFor(wc, "JSON.parse(document.querySelector('#documentContent').value).edges.some(e=>e.target==='b0-0'&&e.source==='b2')", 'native branch drag');
    await wc.executeJavaScript("document.querySelector('[data-mindmap-action=\"undo\"]').click()");
    assert.equal(await wc.executeJavaScript("JSON.parse(document.querySelector('#documentContent').value).edges.find(e=>e.target==='b0-0').source"), 'b0');
    await wc.executeJavaScript("document.documentElement.setAttribute('data-theme','dark')");
    await new Promise(r => setTimeout(r, 100));
    fs.writeFileSync(path.join(shots, 'mindmap-dark.png'), (await wc.capturePage()).toPNG());
    await wc.executeJavaScript("document.documentElement.setAttribute('data-theme','light')");
    await wc.executeJavaScript(`location.hash = '#knowledge/${encodeURIComponent(plain.id)}'`);
    await waitFor(wc, "document.querySelector('#documentTitle').value==='普通笔记'", 'switch to note');
    assert.equal(await wc.executeJavaScript("document.querySelector('#mindmapCanvas').childElementCount"), 0);
    assert.equal(knowledge.getDocument(plain.id).content, '不应被旧画布修改');
    await wc.executeJavaScript(`location.hash = '#knowledge/${encodeURIComponent(map.id)}'`);
    await waitFor(wc, "document.querySelectorAll('#mindmapCanvas [data-node-id]').length===13", 'reopen map');
    win.setSize(390, 844); await new Promise(r => setTimeout(r, 300));
    await wc.executeJavaScript("document.querySelector('[data-mindmap-action=\"fit\"]').click()");
    assert.equal(await wc.executeJavaScript("document.documentElement.scrollWidth <= window.innerWidth && document.querySelector('#mindmapCanvas').getBoundingClientRect().height > 180"), true);
    await wc.executeJavaScript("document.querySelector('[data-node-id=\"b1\"]').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:10,pointerType:'touch',clientX:150,clientY:250})); document.querySelector('#mindmapCanvas').dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:10,pointerType:'touch',clientX:150,clientY:250})); document.querySelector('[data-mindmap-action=\"edit\"]').click()");
    await waitFor(wc, "Boolean(document.querySelector('.mindmap-inline-input'))", 'touch toolbar edit');
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' }); wc.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await wc.executeJavaScript("document.querySelector('.mindmap-inline-input')?.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    await waitFor(wc, "!document.querySelector('.mindmap-inline-input')", 'close touch editor');
    fs.writeFileSync(path.join(shots, 'mindmap-mobile.png'), (await wc.capturePage()).toPNG());
    assert.deepEqual(errors, []);
    console.log('Mindmap Electron checks passed: inline edit, save, fold, complete PNG, document lifecycle, mobile layout and touch selection.');
  } finally { win.destroy(); knowledge.folderSync.stop(); await new Promise(resolve => server.close(resolve)); db.close(); fs.rmSync(dataDir, { recursive: true, force: true }); }
}
app.whenReady().then(main).then(() => app.quit()).catch(error => { console.error(error); fs.rmSync(dataDir, { recursive: true, force: true }); app.exit(1); });
