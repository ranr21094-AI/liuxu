const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

let modulePromise;
const loadTools = () => modulePromise ||= import('../public/js/knowledge/book-tools.js');

function setup() {
  const dom = new JSDOM('<main><div class="file-preview-toolbar"></div><div class="file-preview-stage" tabindex="0"></div></main>', { pretendToBeVisual: true, url: 'http://localhost/' });
  const { document } = dom.window;
  global.document = document;
  global.window = dom.window;
  const originalMatches = dom.window.Element.prototype.matches;
  dom.window.Element.prototype.matches = function (selector) {
    return selector === ':popover-open' ? !!this._popoverOpen : originalMatches.call(this, selector);
  };
  dom.window.HTMLElement.prototype.showPopover = function () { this._popoverOpen = true; };
  dom.window.HTMLElement.prototype.hidePopover = function () { this._popoverOpen = false; };
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new dom.window.Event('close')); };
  const controller = new dom.window.AbortController();
  const host = document.querySelector('main');
  const toolbar = host.querySelector('.file-preview-toolbar');
  host.querySelector('.file-preview-stage').getBoundingClientRect = () => ({ left: 0, top: 0, right: 1024, bottom: 768, width: 1024, height: 768 });
  const finish = () => { controller.abort(); dom.window.close(); delete global.document; delete global.window; delete global.fetch; };
  return { dom, document, host, toolbar, controller, finish };
}

function initial() { return { fingerprint: 'fingerprint', revision: 0, entries: [] }; }
function response(readingData, ok = true) { return { ok, json: async () => ok ? { readingData } : { error: '模拟保存失败' } }; }
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('bookmark saves current location once, reports duplicate, and permits retry after failure', async () => {
  const env = setup();
  try {
    let state = initial(), resolveWrite, writes = 0, fail = false;
    let location = { anchor: 'epubcfi(/6/2)', label: '第一章' };
    global.fetch = async (_url, options) => {
      if (options.method === 'GET') return { ok: true, json: async () => state };
      writes++;
      const payload = JSON.parse(options.body);
      if (fail) return response(null, false);
      return new Promise(resolve => { resolveWrite = () => { state = { ...payload, revision: state.revision + 1 }; resolve(response(state)); }; });
    };
    const { readingTools } = await loadTools();
    const tools = await readingTools({ doc: { id: 'file:1' }, host: env.host, toolbar: env.toolbar, signal: env.controller.signal, current: () => location, navigate: async () => {} });
    const bookmark = env.toolbar.querySelector('[data-reader-bookmark]');
    assert.equal(bookmark.getAttribute('aria-label'), '添加当前位置书签');
    bookmark.click(); bookmark.click();
    assert.equal(writes, 1);
    assert.equal(bookmark.disabled, true);
    resolveWrite(); await tick();
    assert.equal(bookmark.disabled, false);
    assert.equal(tools.entries.length, 1);
    bookmark.click();
    assert.equal(writes, 1);
    assert.match(env.toolbar.textContent, /此位置已有书签/);
    location = { anchor: 'epubcfi(/6/4)', label: '第二章' };
    fail = true; bookmark.click(); await tick();
    assert.equal(writes, 2);
    assert.equal(tools.entries.length, 1);
    assert.match(env.toolbar.textContent, /模拟保存失败/);
    assert.equal(bookmark.disabled, false);
  } finally { env.finish(); }
});

test('selection opens an edit dialog; failure retains draft and retry creates excerpt', async () => {
  const env = setup();
  try {
    let state = initial(), writes = 0;
    const selected = { anchor: 'epubcfi(/6/2!/4/2:1,/1:0,/1:4)', label: '第二章', quote: '跨行文字', range: { startContainer: { ownerDocument: env.document }, getClientRects: () => [{ left: 60, right: 150, top: 100, bottom: 125, width: 90, height: 25 }] } };
    global.fetch = async (_url, options) => {
      if (options.method === 'GET') return { ok: true, json: async () => state };
      writes++;
      if (writes === 1) return response(null, false);
      state = { ...JSON.parse(options.body), revision: 1 };
      return response(state);
    };
    const { readingTools } = await loadTools();
    const tools = await readingTools({ doc: { id: 'file:1' }, host: env.host, toolbar: env.toolbar, signal: env.controller.signal, current: () => null, selection: () => selected, navigate: async () => {} });
    tools.selectionChanged();
    await new Promise(resolve => setTimeout(resolve, 210));
    const action = env.document.querySelector('.book-selection-action');
    assert.equal(action._popoverOpen, true);
    action.click();
    const dialog = env.document.querySelector('.book-edit-dialog');
    assert.equal(dialog.querySelector('h3').textContent, '保存摘录');
    assert.equal(dialog.querySelector('blockquote').textContent, '跨行文字');
    dialog.querySelector('[name=label]').value = '我的摘录';
    dialog.querySelector('[name=note]').value = '保留这段想法';
    dialog.querySelector('form').dispatchEvent(new env.dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await tick();
    assert.equal(dialog.open, true);
    assert.match(dialog.querySelector('[role=alert]').textContent, /模拟保存失败/);
    assert.equal(dialog.querySelector('[name=note]').value, '保留这段想法');
    dialog.querySelector('form').dispatchEvent(new env.dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await tick();
    assert.equal(tools.entries.length, 1);
    assert.equal(tools.entries[0].type, 'highlight');
    assert.equal(tools.entries[0].anchor, selected.anchor);
    assert.equal(tools.entries[0].note, '保留这段想法');
    assert.equal(env.document.querySelector('.book-edit-dialog'), null);
    assert.equal(env.document.activeElement, env.host.querySelector('.file-preview-stage'));
  } finally { env.finish(); }
});

test('selection geometry maps iframe pixels and clipping; Escape hides the floating action', async () => {
  const env = setup();
  try {
    const iframe = env.document.createElement('iframe'); env.host.append(iframe);
    iframe.getBoundingClientRect = () => ({ left: 100, top: 50, right: 500, bottom: 450, width: 400, height: 400 });
    Object.defineProperty(iframe, 'clientWidth', { value: 200 });
    Object.defineProperty(iframe, 'clientHeight', { value: 200 });
    const node = iframe.contentDocument.createTextNode('文字'); iframe.contentDocument.body.append(node);
    const range = { startContainer: node, getClientRects: () => [{ left: 20, top: 30, right: 70, bottom: 45, width: 50, height: 15 }] };
    const { visibleSelectionRect, readingTools } = await loadTools();
    const rect = visibleSelectionRect({ range }, env.dom.window);
    assert.deepEqual(rect, { left: 140, right: 240, top: 110, bottom: 140 });
    let state = initial();
    global.fetch = async () => ({ ok: true, json: async () => state });
    const tools = await readingTools({ doc: { id: 'file:1' }, host: env.host, toolbar: env.toolbar, signal: env.controller.signal, current: () => null, selection: () => ({ quote: '文字', anchor: 'cfi', range }), navigate: async () => {} });
    tools.selectionChanged(); await new Promise(resolve => setTimeout(resolve, 210));
    const action = env.document.querySelector('.book-selection-action');
    assert.equal(action._popoverOpen, true);
    env.document.dispatchEvent(new env.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    assert.equal(action._popoverOpen, false);
    assert.equal(action.hidden, true);
  } finally { env.finish(); }
});

test('bookmark and excerpt actions use accessible SVG controls and explain stale locations', async () => {
  const env = setup();
  try {
    const entries = [{ id: 'stale', type: 'highlight', anchor: 'old-anchor', fingerprint: 'old-fingerprint', quote: '旧文字', label: '旧摘录' }];
    global.fetch = async () => ({ ok: true, json: async () => ({ fingerprint: 'new-fingerprint', revision: 3, entries }) });
    const { readingTools } = await loadTools();
    await readingTools({ doc: { id: 'file:1' }, host: env.host, toolbar: env.toolbar, signal: env.controller.signal,
      current: () => null, navigate: async () => { throw new Error('should not navigate'); } });
    const actions = [...env.host.querySelectorAll('[data-reader-action]')];
    assert.deepEqual(actions.map(item => item.dataset.readerAction), ['jump', 'edit', 'delete']);
    for (const action of actions) {
      assert.ok(action.querySelector('svg'));
      assert.ok(action.getAttribute('aria-label'));
      assert.equal(action.title, action.getAttribute('aria-label'));
    }
    const jump = actions[0];
    assert.equal(jump.getAttribute('aria-disabled'), 'true');
    jump.click();
    assert.match(env.toolbar.querySelector('.book-status').textContent, /源文件已变化/);
  } finally { env.finish(); }
});
