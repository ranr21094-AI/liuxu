const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

class FakeWebContents extends EventEmitter {
  constructor() { super(); this.url = ''; this.title = ''; this.loading = false; this.closed = false; this.history = []; this.historyIndex = -1; }
  getURL() { return this.url; }
  getTitle() { return this.title; }
  isLoading() { return this.loading; }
  setWindowOpenHandler(handler) { this.windowHandler = handler; }
  async loadURL(url) { this.emit('did-start-navigation', {}, url, false, true); this.url = url; this.title = new URL(url).hostname; this.history = this.history.slice(0, this.historyIndex + 1); this.history.push(url); this.historyIndex++; this.emit('did-stop-loading'); }
  reload() { this.emit('did-start-loading'); this.emit('did-stop-loading'); }
  stop() { this.loading = false; }
  close() { this.closed = true; }
  async executeJavaScript(code) { this.lastCode = code; return { title: this.title, url: this.url, text: 'page', interactive: [] }; }
  async capturePage() { return { getSize: () => ({ width: 800, height: 600 }), toJPEG: () => Buffer.from('image') }; }
  navigationHistory = {
    canGoBack: () => this.historyIndex > 0,
    canGoForward: () => this.historyIndex < this.history.length - 1,
    goBack: () => { if (this.historyIndex > 0) this.url = this.history[--this.historyIndex]; },
    goForward: () => { if (this.historyIndex < this.history.length - 1) this.url = this.history[++this.historyIndex]; },
  };
}
class FakeView {
  constructor(options) { this.options = options; this.webContents = new FakeWebContents(); this.visible = false; }
  setVisible(value) { this.visible = value; }
  setBounds(value) { this.bounds = value; }
}

function loadManager() {
  const original = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return { WebContentsView: FakeView, shell: { openExternal() {} } };
    return original.call(this, request, parent, isMain);
  };
  const filename = require.resolve('../electron/note-browser');
  delete require.cache[filename];
  try { return require(filename); } finally { Module._load = original; }
}

test('note browser normalizes URLs and rejects local protocols', () => {
  const { normalizeBrowserUrl, normalizeBounds } = loadManager();
  assert.equal(normalizeBrowserUrl('example.com'), 'https://example.com/');
  assert.throws(() => normalizeBrowserUrl('file:///etc/passwd'), /http/);
  assert.deepEqual(normalizeBounds({ x: -1, y: 2.4, width: 400.7, height: 300 }), { x: 0, y: 2, width: 401, height: 300 });
});

test('note browser keeps tabs isolated by document and invalidates stale actions', async () => {
  const { createNoteBrowserManager } = loadManager();
  const children = [];
  const window = { contentView: { addChildView: view => children.push(view), removeChildView: view => children.splice(children.indexOf(view), 1) } };
  const events = [];
  const manager = createNoteBrowserManager({ window, send: event => events.push(event) });
  manager.activate({ documentId: 'note:1', visible: true, rect: { x: 10, y: 20, width: 400, height: 500 } });
  const first = manager.open({ documentId: 'note:1', url: 'https://example.com' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(children.length, 1);
  assert.equal(children[0].visible, true);
  const current = events.filter(event => event.tab?.id === first.id).at(-1).tab;
  const read = await manager.executeTool({ documentId: 'note:1', tabId: first.id, pageVersion: current.pageVersion, name: 'note_browser.read' });
  assert.equal(read.ok, true);
  assert.equal(read.data.text, 'page');
  const second = manager.open({ documentId: 'note:1', url: 'https://second.example' });
  await assert.rejects(manager.executeTool({ documentId: 'note:1', tabId: first.id, pageVersion: current.pageVersion, name: 'note_browser.click', args: { index: 0 } }), /切换浏览器标签/);
  manager.activate({ documentId: 'note:1', tabId: first.id, visible: true });
  manager.close({ documentId: 'note:1', tabId: second.id });
  manager.activate({ documentId: 'note:2', visible: false });
  await assert.rejects(manager.executeTool({ documentId: 'note:1', tabId: first.id, pageVersion: current.pageVersion, name: 'note_browser.read' }), /切换笔记/);
  manager.activate({ documentId: 'note:1', tabId: first.id, visible: true, rect: { width: 420, height: 500 } });
  await children[0].webContents.loadURL('https://example.org');
  await assert.rejects(manager.executeTool({ documentId: 'note:1', tabId: first.id, pageVersion: current.pageVersion, name: 'note_browser.click', args: { index: 0 } }), /网页已变化/);
  manager.close({ documentId: 'note:1', tabId: first.id });
  assert.equal(children[0], undefined);
});

test('note browser state is sanitized and persisted per desktop workspace file', (t) => {
  const { createNoteBrowserManager } = loadManager();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'note-browser-state-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const statePath = path.join(dir, 'state.json');
  const manager = createNoteBrowserManager({ window: { contentView: { addChildView() {}, removeChildView() {} } }, statePath });
  manager.saveState({ width: 999, records: { 'note:1': { open: true, tabs: [
    { id: 'one', url: 'https://user:secret@example.com/path', title: 'Example' },
    { id: 'bad', url: 'file:///etc/passwd', title: 'Bad' },
  ], activeTabId: 'one' } } });
  const restored = manager.loadState();
  assert.equal(restored.width, 760);
  assert.equal(restored.records['note:1'].tabs.length, 1);
  assert.equal(restored.records['note:1'].tabs[0].url, 'https://example.com/path');
  manager.clearState();
  assert.deepEqual(manager.loadState(), { records: {}, width: 420 });
});

test('workspace replacement cleanup removes persisted note browser associations', (t) => {
  const { clearNoteBrowserState } = require('../lib/computer/note-browser');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'note-browser-clear-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, '.note-browser-state.json'), '{}');
  clearNoteBrowserState(dir);
  assert.equal(fs.existsSync(path.join(dir, '.note-browser-state.json')), false);
  assert.doesNotThrow(() => clearNoteBrowserState(dir));
});

test('new-window links become note browser tabs and remote views are sandboxed', async () => {
  const { createNoteBrowserManager } = loadManager();
  const children = [];
  const manager = createNoteBrowserManager({ window: { contentView: { addChildView: view => children.push(view), removeChildView() {} } } });
  manager.activate({ documentId: 'note:1' });
  manager.open({ documentId: 'note:1', url: 'https://example.com' });
  children[0].webContents.windowHandler({ url: 'https://example.org' });
  assert.equal(children.length, 2);
  assert.equal(children[0].webContents.url, 'https://example.com/');
  assert.equal(children[0].options.webPreferences.nodeIntegration, false);
  assert.equal(children[0].options.webPreferences.sandbox, true);
  assert.equal(children[0].options.webPreferences.preload, undefined);
});
