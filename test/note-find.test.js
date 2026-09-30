const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { JSDOM } = require('jsdom');

async function loadModule() {
  const url = pathToFileURL(path.join(__dirname, '../public/js/knowledge/note-find.js'));
  url.search = `test=${Date.now()}-${Math.random()}`;
  return import(url.href);
}

function makeNoteFind(module, { content = '', mode = 'edit', document: activeDocument = { id: 'note:1', sourceType: 'note' } } = {}) {
  const dom = new JSDOM(`<!doctype html><body>
    <button id="noteFindToggleButton" aria-expanded="false"></button>
    <div class="note-editor" id="noteEditor">
      <textarea id="documentContent"></textarea>
      <div id="documentPreview" tabindex="0" hidden><p>预览内容</p></div>
      <div id="noteFindBar" hidden>
        <input id="noteFindInput" type="search">
        <span id="noteFindCount"></span>
        <button id="noteFindPrevious"></button><button id="noteFindNext"></button><button id="noteFindClose"></button>
      </div>
    </div>
    <input id="knowledgeSearch">
  </body>`, { url: 'http://127.0.0.1/' });
  const { document } = dom.window;
  const editor = document.querySelector('#documentContent');
  const preview = document.querySelector('#documentPreview');
  editor.value = content;
  editor.hidden = mode === 'preview';
  preview.hidden = mode === 'edit';
  let currentDocument = activeDocument;
  let currentMode = mode;
  const ui = module.initNoteFind({
    root: document,
    getActiveDocument: () => currentDocument,
    canSearch: () => Boolean(currentDocument && currentDocument.sourceType !== 'file'),
    getEditorMode: () => currentMode,
    setEditorMode: next => {
      currentMode = next;
      editor.hidden = next === 'preview';
      preview.hidden = next === 'edit';
    },
  });
  ui.setActiveDocument(currentDocument);
  return {
    dom,
    document,
    editor,
    preview,
    ui,
    getMode: () => currentMode,
    setDocument: next => { currentDocument = next; ui.setActiveDocument(next); },
  };
}

function keydown(window, target, options, ui) {
  const event = new window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...options });
  target.dispatchEvent(event);
  ui?.handleKeydown(event);
  return event;
}

test('literal note search is case-insensitive and treats punctuation as text', async () => {
  const { findLiteralMatches } = await loadModule();
  assert.deepEqual(findLiteralMatches('Foo (bar) foo (BAR) 中文', 'foo (bar)'), [
    { start: 0, end: 9 },
    { start: 10, end: 19 },
  ]);
  assert.deepEqual(findLiteralMatches('中文在这里，中文也在这里', '中文'), [
    { start: 0, end: 2 },
    { start: 6, end: 8 },
  ]);
  assert.deepEqual(findLiteralMatches('anything', ''), []);
});

test('Command+F and Ctrl+F open the note search, select matches, wrap, and restore editor focus', async () => {
  const module = await loadModule();
  const app = makeNoteFind(module, { content: 'Alpha beta alpha' });
  try {
    app.editor.focus();
    app.editor.setSelectionRange(0, 5);
    const command = keydown(app.dom.window, app.editor, { key: 'f', metaKey: true }, app.ui);
    assert.equal(command.defaultPrevented, true);
    assert.equal(app.document.querySelector('#noteFindBar').hidden, false);
    assert.equal(app.document.querySelector('#noteFindInput').value, 'Alpha');
    assert.equal(app.document.querySelector('#noteFindCount').textContent, '1 / 2');

    const next = keydown(app.dom.window, app.document.querySelector('#noteFindInput'), { key: 'Enter' });
    assert.equal(next.defaultPrevented, true);
    assert.deepEqual([app.editor.selectionStart, app.editor.selectionEnd], [11, 16]);
    app.document.querySelector('#noteFindPrevious').click();
    assert.deepEqual([app.editor.selectionStart, app.editor.selectionEnd], [0, 5]);
    keydown(app.dom.window, app.document.querySelector('#noteFindInput'), { key: 'Enter', shiftKey: true });
    assert.deepEqual([app.editor.selectionStart, app.editor.selectionEnd], [11, 16]);
    keydown(app.dom.window, app.document.querySelector('#noteFindInput'), { key: 'Enter' });
    assert.deepEqual([app.editor.selectionStart, app.editor.selectionEnd], [0, 5]);
    assert.equal(app.document.activeElement.id, 'noteFindInput');

    app.document.querySelector('#noteFindClose').click();
    assert.equal(app.document.querySelector('#noteFindBar').hidden, true);
    assert.equal(app.document.activeElement, app.editor);

    const control = keydown(app.dom.window, app.editor, { key: 'f', ctrlKey: true }, app.ui);
    assert.equal(control.defaultPrevented, true);
  } finally {
    app.dom.window.close();
  }
});

test('search updates on edits, leaves the body unchanged, and clears when switching notes', async () => {
  const module = await loadModule();
  const app = makeNoteFind(module, { content: '中文 xx 中文' });
  try {
    app.ui.open();
    const input = app.document.querySelector('#noteFindInput');
    input.value = '中文';
    input.dispatchEvent(new app.dom.window.Event('input', { bubbles: true }));
    assert.equal(app.document.querySelector('#noteFindCount').textContent, '1 / 2');
    assert.deepEqual([app.editor.selectionStart, app.editor.selectionEnd], [0, 2]);

    app.editor.value = '中文';
    app.editor.setSelectionRange(2, 2);
    app.editor.dispatchEvent(new app.dom.window.Event('input', { bubbles: true }));
    assert.equal(app.document.querySelector('#noteFindCount').textContent, '1 / 1');
    assert.equal(app.editor.value, '中文');

    input.value = '不存在';
    input.dispatchEvent(new app.dom.window.Event('input', { bubbles: true }));
    assert.equal(app.document.querySelector('#noteFindCount').textContent, '0 个匹配');
    assert.equal(app.ui.getState().activeIndex, -1);

    app.setDocument({ id: 'note:2', sourceType: 'note' });
    assert.equal(app.document.querySelector('#noteFindBar').hidden, true);
    assert.equal(input.value, '');
    assert.equal(app.ui.getState().matches.length, 0);
  } finally {
    app.dom.window.close();
  }
});

test('preview search switches to source and keyboard shortcuts do not intercept unrelated controls', async () => {
  const module = await loadModule();
  const app = makeNoteFind(module, { content: 'first\nbeta here\nbeta', mode: 'preview' });
  try {
    const shortcut = keydown(app.dom.window, app.preview, { key: 'f', ctrlKey: true }, app.ui);
    assert.equal(shortcut.defaultPrevented, true);
    const input = app.document.querySelector('#noteFindInput');
    input.value = 'beta';
    input.dispatchEvent(new app.dom.window.Event('input', { bubbles: true }));
    assert.equal(app.getMode(), 'edit');
    assert.equal(app.editor.hidden, false);
    assert.deepEqual([app.editor.selectionStart, app.editor.selectionEnd], [6, 10]);
    app.document.querySelector('#noteFindNext').click();
    assert.deepEqual([app.editor.selectionStart, app.editor.selectionEnd], [16, 20]);

    const unrelated = app.document.querySelector('#knowledgeSearch');
    const event = keydown(app.dom.window, unrelated, { key: 'f', metaKey: true }, app.ui);
    assert.equal(event.defaultPrevented, false);

    app.setDocument({ id: 'file:1', sourceType: 'file' });
    assert.equal(app.ui.open(), false);
  } finally {
    app.dom.window.close();
  }
});
