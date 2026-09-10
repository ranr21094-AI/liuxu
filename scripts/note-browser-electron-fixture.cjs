const http = require('node:http');
const assert = require('node:assert/strict');
const { app, BrowserWindow, session } = require('electron');
const { createNoteBrowserManager } = require('../electron/note-browser');

function waitFor(emitter, event, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`等待 ${event} 超时`)); }, timeout);
    const handler = (...args) => { cleanup(); resolve(args); };
    const cleanup = () => { clearTimeout(timer); emitter.removeListener(event, handler); };
    emitter.once(event, handler);
  });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

const server = http.createServer((request, response) => {
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (request.url === '/next') return response.end('<!doctype html><title>下一页</title><main>navigation complete</main>');
  response.end(`<!doctype html><title>模拟网站</title>
    <a id="new" href="/next" target="_blank">新标签链接</a>
    <label>姓名 <input id="name"></label>
    <button id="apply" onclick="document.querySelector('#status').textContent=document.querySelector('#name').value">提交</button>
    <select id="choice"><option value="a">甲</option><option value="b">乙</option></select>
    <p id="status">等待</p>`);
});

app.whenReady().then(async () => {
  const port = await listen(server);
  const origin = `http://127.0.0.1:${port}`;
  const browserSession = session.fromPartition('persist:liuxu-note-browser');
  browserSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  browserSession.setPermissionCheckHandler(() => false);
  const host = new BrowserWindow({ show: true, width: 800, height: 700, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await host.loadURL('data:text/html,<title>Browser test host</title>');
  host.show();
  const events = [];
  const manager = createNoteBrowserManager({ window: host, send: event => events.push(event) });
  manager.activate({ documentId: 'note:integration', visible: true, rect: { x: 0, y: 0, width: 700, height: 600 } });
  const opened = manager.open({ documentId: 'note:integration', url: origin });
  const firstView = host.contentView.children[0];
  await waitFor(firstView.webContents, 'did-finish-load');
  const first = manager.activate({ documentId: 'note:integration', tabId: opened.id, visible: true }).tab;
  const read = await manager.executeTool({ documentId: 'note:integration', tabId: first.id, pageVersion: first.pageVersion, name: 'note_browser.read' });
  assert.match(read.data.text, /新标签链接/);
  const input = read.data.interactive.find(item => item.tag === 'input');
  const button = read.data.interactive.find(item => item.tag === 'button');
  const select = read.data.interactive.find(item => item.tag === 'select');
  await manager.executeTool({ documentId: 'note:integration', tabId: first.id, pageVersion: first.pageVersion, name: 'note_browser.type', args: { index: input.index, text: '留序' } });
  await manager.executeTool({ documentId: 'note:integration', tabId: first.id, pageVersion: first.pageVersion, name: 'note_browser.select', args: { index: select.index, value: 'b' } });
  await manager.executeTool({ documentId: 'note:integration', tabId: first.id, pageVersion: first.pageVersion, name: 'note_browser.click', args: { index: button.index } });
  assert.equal(await firstView.webContents.executeJavaScript("document.querySelector('#status').textContent"), '留序');
  assert.equal(await firstView.webContents.executeJavaScript("document.querySelector('#choice').value"), 'b');
  const isolation = await firstView.webContents.executeJavaScript("({node:typeof require,ipc:typeof window.liuxuDesktop,protocol:location.protocol})");
  assert.deepEqual(isolation, { node: 'undefined', ipc: 'undefined', protocol: 'http:' });
  const screenshot = await manager.executeTool({ documentId: 'note:integration', tabId: first.id, pageVersion: first.pageVersion, name: 'note_browser.screenshot' });
  assert.equal(screenshot.data.mimeType, 'image/jpeg');
  assert.ok(screenshot.data.image.length > 100);

  const created = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('新标签未创建')), 5000);
    const poll = setInterval(() => {
      const event = events.find(item => item.type === 'tab-created' && item.tab?.id !== first.id);
      if (!event) return;
      clearTimeout(timeout); clearInterval(poll); resolve(event.tab);
    }, 20);
  });
  await firstView.webContents.executeJavaScript("document.querySelector('#new').click()");
  const second = await created;
  assert.equal(second.documentId, 'note:integration');
  assert.equal(host.contentView.children.length, 2);
  const secondView = host.contentView.children[1];
  if (secondView.webContents.isLoading()) await waitFor(secondView.webContents, 'did-finish-load');

  manager.activate({ documentId: 'note:integration', tabId: first.id, visible: true });
  const beforeNavigation = manager.activate({ documentId: 'note:integration', tabId: first.id, visible: true }).tab.pageVersion;
  await manager.executeTool({ documentId: 'note:integration', tabId: first.id, pageVersion: beforeNavigation, name: 'note_browser.navigate', args: { url: `${origin}/next` } });
  await assert.rejects(manager.executeTool({ documentId: 'note:integration', tabId: first.id, pageVersion: beforeNavigation, name: 'note_browser.click', args: { index: 0 } }), /网页已变化/);

  const failedTab = manager.open({ documentId: 'note:integration', url: 'http://127.0.0.1:65534/unavailable' });
  const failedView = host.contentView.children.at(-1);
  await waitFor(failedView.webContents, 'did-fail-load');
  assert.ok(events.some(event => event.type === 'load-failed' && event.tab?.id === failedTab.id));
  manager.close({ documentId: 'note:integration', tabId: failedTab.id });

  const crashed = waitFor(secondView.webContents, 'render-process-gone');
  secondView.webContents.forcefullyCrashRenderer();
  await crashed;
  assert.ok(events.some(event => event.type === 'crashed' && event.tab?.id === second.id));

  manager.close({ documentId: 'note:integration', tabId: first.id });
  manager.close({ documentId: 'note:integration', tabId: second.id });
  assert.equal(host.contentView.children.length, 0);
  host.destroy();
  await new Promise(resolve => server.close(resolve));
  process.stdout.write('note browser electron integration: ok\n');
  app.quit();
}).catch(async error => {
  process.stderr.write(`${error.stack || error}\n`);
  try { await new Promise(resolve => server.close(resolve)); } catch {}
  app.exit(1);
});
