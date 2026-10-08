const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const moduleFor = name => import(pathToFileURL(path.join(__dirname, '../public/js/knowledge', name)).href);

test('list types prioritize roles and registered preview kinds, distinguishing code and unknown files', async () => {
  const { documentType } = await moduleFor('document-types.js');
  const docs = [
    { id: 'note:1' }, { id: 'note:2', documentRole: 'mindmap' },
    ...['pdf', 'image', 'audio', 'video', 'archive', 'unsupported'].map(previewKind => ({ id: 'file:1', fileMeta: { previewKind, filename: 'sample.bin' } })),
    { id: 'file:2', fileMeta: { previewKind: 'text', filename: 'main.PY' } },
    { id: 'file:3', fileMeta: { previewKind: 'text', filename: 'README.txt' } },
  ];
  assert.deepEqual(docs.map(doc => documentType(doc).kind), ['note', 'mindmap', 'document', 'image', 'audio', 'video', 'archive', 'file', 'code', 'document']);
  assert.equal(new Set(docs.slice(0, 7).map(doc => documentType(doc).icon)).size, 7);
});

test('grouping preserves mixed pinned order, regular ordering, and omits empty groups', async () => {
  const { arrangeKnowledgeRows } = await moduleFor('pins.js');
  const dom = new JSDOM('<div id="list"><div data-list-group="folder" id="folder"></div><div data-list-group="folder" id="pf" data-pinned-at="2026-10-08T00:00:00.000Z"></div><div data-list-group="file" id="pd" data-pinned-at="2026-10-08T01:00:00.000Z"></div><div data-list-group="file" id="first"></div><div data-list-group="file" id="second"></div><button data-list-group="local" id="local"></button></div>');
  try {
    const list = dom.window.document.querySelector('#list');
    arrangeKnowledgeRows(list);
    assert.deepEqual([...list.querySelectorAll('.knowledge-list-section')].map(node => node.textContent), ['置顶', '文件夹', '文件', '未同步项']);
    assert.deepEqual([...list.children].filter(node => node.id).map(node => node.id), ['pd', 'pf', 'folder', 'first', 'second', 'local']);
    list.innerHTML = '<div data-list-group="file">one</div>';
    arrangeKnowledgeRows(list);
    assert.equal(list.querySelector('.knowledge-list-section').textContent, '文件');
  } finally { dom.window.close(); }
});
