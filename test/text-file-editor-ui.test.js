const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { JSDOM } = require('jsdom');
const load = file => import(pathToFileURL(path.join(__dirname, '../public/js/knowledge', file)).href);

test('textarea edits preserve untouched CRLF, CR, LF, BOM and trailing newline', async () => {
  const { createRawTextState } = await load('text-file-editor.js');
  const raw = '第一行\r\n第二行\n第三行\r尾行😀\r\n';
  const state = createRawTextState(raw, true, 'old');
  assert.equal(state.display, '第一行\n第二行\n第三行\n尾行😀\n');
  state.edit(state.display.replace('第二行', '修改后的第二行'));
  assert.equal(state.content, '第一行\r\n修改后的第二行\n第三行\r尾行😀\r\n');
  state.edit(state.display.replace('尾行😀', '尾行😁'));
  assert.equal(state.content, '第一行\r\n修改后的第二行\n第三行\r尾行😁\r\n');
  assert.equal(state.bom, true);
  state.acknowledge('new'); assert.equal(state.baseFingerprint, 'new');
  state.edit(''); assert.equal(state.content, '');
});

test('raw input during an in-flight save is retained while fingerprint advances', async () => {
  const { createRawTextState } = await load('text-file-editor.js');
  const state = createRawTextState('首行\r\n尾行', false, 'old');
  state.edit('首行\n尾行变更');
  const submitted = state.content;
  state.edit(state.display + '\n追加');
  state.acknowledge('saved-fingerprint');
  assert.notEqual(state.content, submitted);
  assert.equal(state.content, '首行\r\n尾行变更\r\n追加');
  assert.equal(state.baseFingerprint, 'saved-fingerprint');
});

test('read-only mindmap history uses stored positions and folding without mutating models', async () => {
  const { mountMindmapHistory } = await load('mindmap-history.js');
  const dom = new JSDOM('<div id="host"></div>', { pretendToBeVisual: true });
  const model = { version: 1, rootId: 'r', nodes: [{ id: 'r', text: '根', x: 31, y: 22, collapsed: true },
    { id: 'c', text: '子节点', x: 250, y: 45, side: 'right' }], edges: [{ source: 'r', target: 'c' }], canvas: { width: 600, height: 450 } };
  const host = dom.window.document.querySelector('#host');
  const before = JSON.stringify(model);
  const cleanup = mountMindmapHistory(host, before, before);
  assert.equal(host.querySelectorAll('svg').length, 2);
  assert.equal(host.querySelectorAll('[data-node-id="c"]').length, 0);
  const node = host.querySelector('[data-node-id="r"]');
  assert.equal(node.getAttribute('transform'), 'translate(31 22)');
  host.querySelector('[data-mindmap-action="zoom-in"]').click();
  assert.equal(JSON.stringify(model), before);
  cleanup();
  assert.equal(host.querySelector('svg').children.length, 0);
  dom.window.close();
});

test('raw text editor and file history do not replace annotation controls', () => {
  const fs = require('node:fs');
  const dom = new JSDOM(fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8'));
  assert.ok(dom.window.document.querySelector('#fileTextEditor'));
  assert.ok(dom.window.document.querySelector('#fileAnnotationContent'));
  assert.notEqual(dom.window.document.querySelector('#fileTextEditor'), dom.window.document.querySelector('#fileAnnotationContent'));
  dom.window.close();
});
