const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

function fireDrag(dom, target, type, dataTransfer = null, relatedTarget = null) {
  const event = new dom.window.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    dataTransfer: { value: dataTransfer },
    relatedTarget: { value: relatedTarget },
  });
  target.dispatchEvent(event);
  return event;
}

function createTransfer() {
  const values = new Map();
  return {
    values,
    effectAllowed: '',
    dropEffect: '',
    setData(type, value) { values.set(type, value); },
  };
}

const shellHtml = `
  <body>
    <div id="workspaceShell">
      <aside id="workspaceSidebar">
        <section id="knowledgeSidebarPanel">
          <nav id="knowledgeBreadcrumb"><button id="breadcrumbTarget" data-drop-base="库" data-drop-folder="上层"><span>上层</span></button></nav>
          <div id="knowledgeBaseList"><button id="baseTarget" data-drop-base="另一个库" data-drop-folder=""><span>另一个库</span></button></div>
          <div id="knowledgeDocumentList">
            <div id="documentSource" draggable="true" data-knowledge-drag-type="document" data-knowledge-drag-id="file:1"><span id="documentHandle">档案</span></div>
            <div id="folderSource" draggable="true" data-knowledge-drag-type="folder" data-knowledge-drag-path="库/来源"><span id="folderHandle">来源文件夹</span></div>
            <div id="folderTarget" data-drop-base="库" data-drop-folder="目标"><span id="folderTargetLabel">目标文件夹</span></div>
            <div id="childTarget" data-drop-base="库" data-drop-folder="来源/子级"><span>子级</span></div>
          </div>
        </section>
      </aside>
      <main><section id="knowledgeView"></section><div id="todoList"><div id="todoTarget" draggable="true" data-drop-base="待办" data-drop-folder="其它"></div></div></main>
    </div>
  </body>`;

test('knowledge drag events are delegated across sidebar and main content without accepting unrelated drops', async () => {
  const dom = new JSDOM(shellHtml);
  const doc = dom.window.document;
  const root = doc.getElementById('workspaceShell');
  const moves = [];
  const failures = [];
  let rejectNext = false;
  const { initKnowledgeDragEvents } = await import('../public/js/app/knowledge-drag.js');
  const drag = initKnowledgeDragEvents({
    root,
    doc,
    onDrop: (item, target) => {
      if (rejectNext) { rejectNext = false; return Promise.reject(new Error('服务器拒绝移动')); }
      moves.push({ item, target: { knowledgeBase: target.knowledgeBase, folderPath: target.folderPath } });
    },
    onError: error => failures.push(error),
  });
  try {
    assert.equal(root.contains(doc.getElementById('knowledgeDocumentList')), true);
    assert.equal(doc.getElementById('knowledgeView').contains(doc.getElementById('knowledgeDocumentList')), false);

    const transfer = createTransfer();
    fireDrag(dom, doc.getElementById('documentHandle'), 'dragstart', transfer);
    assert.equal(doc.body.classList.contains('knowledge-dragging'), true);
    assert.deepEqual(JSON.parse(transfer.values.get('application/x-liuxu-knowledge-item')), { type: 'document', id: 'file:1' });
    const over = fireDrag(dom, doc.getElementById('folderTargetLabel'), 'dragover', transfer);
    assert.equal(over.defaultPrevented, true);
    assert.equal(doc.getElementById('folderTarget').classList.contains('knowledge-drop-active'), true);
    const drop = fireDrag(dom, doc.getElementById('folderTargetLabel'), 'drop', transfer);
    assert.equal(drop.defaultPrevented, true);
    await Promise.resolve();
    assert.deepEqual(moves[0], {
      item: { type: 'document', id: 'file:1' },
      target: { knowledgeBase: '库', folderPath: '目标' },
    });
    assert.equal(doc.body.classList.contains('knowledge-dragging'), false);
    assert.equal(doc.getElementById('folderTarget').classList.contains('knowledge-drop-active'), false);
    fireDrag(dom, doc.getElementById('folderTargetLabel'), 'drop', transfer);
    assert.equal(moves.length, 1, 'a completed drop cannot be replayed without a new dragstart');

    rejectNext = true;
    const failedTransfer = createTransfer();
    fireDrag(dom, doc.getElementById('documentHandle'), 'dragstart', failedTransfer);
    fireDrag(dom, doc.getElementById('baseTarget'), 'dragover', failedTransfer);
    fireDrag(dom, doc.getElementById('baseTarget'), 'drop', failedTransfer);
    await Promise.resolve();
    assert.equal(failures[0].message, '服务器拒绝移动');
    assert.equal(doc.body.classList.contains('knowledge-dragging'), false, 'failed moves still clean up drag state');

    const folderTransfer = createTransfer();
    fireDrag(dom, doc.getElementById('folderHandle'), 'dragstart', folderTransfer);
    const invalidTarget = fireDrag(dom, doc.getElementById('todoTarget'), 'dragover', folderTransfer);
    assert.equal(invalidTarget.defaultPrevented, false, 'matching data attributes outside knowledge controls are not valid targets');
    fireDrag(dom, doc.getElementById('todoTarget'), 'drop', folderTransfer);
    assert.equal(moves.length, 1);
    fireDrag(dom, doc.getElementById('baseTarget'), 'dragover', folderTransfer);
    fireDrag(dom, doc.getElementById('baseTarget'), 'drop', folderTransfer);
    await Promise.resolve();
    assert.deepEqual(moves[1], {
      item: { type: 'folder', path: '库/来源' },
      target: { knowledgeBase: '另一个库', folderPath: '' },
    });

    const unrelatedTransfer = createTransfer();
    fireDrag(dom, doc.getElementById('todoTarget'), 'dragstart', unrelatedTransfer);
    assert.equal(doc.body.classList.contains('knowledge-dragging'), false, 'non-knowledge drags are ignored');
    const ignored = fireDrag(dom, doc.getElementById('todoTarget'), 'dragover', unrelatedTransfer);
    assert.equal(ignored.defaultPrevented, false);
    fireDrag(dom, doc.getElementById('todoTarget'), 'drop', unrelatedTransfer);
    assert.equal(moves.length, 2);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].message, '服务器拒绝移动');
  } finally {
    drag.destroy();
    dom.window.close();
  }
});

test('knowledge drag source and drop target wiring match the rendered workspace structure', () => {
  const html = fs.readFileSync('public/index.html', 'utf8');
  const source = fs.readFileSync('public/js/workbench.js', 'utf8');
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  const shell = doc.getElementById('workspaceShell');
  const list = doc.getElementById('knowledgeDocumentList');
  const view = doc.getElementById('knowledgeView');
  assert.ok(shell.contains(list));
  assert.ok(shell.contains(view));
  assert.equal(view.contains(list), false);
  assert.match(source, /initKnowledgeDragEvents\(\{\s*root,\s*doc: document/s);
  assert.match(source, /const root = \$\('#workspaceShell'\)/);
  dom.window.close();
});

test('folder move rejects drops into itself or its descendant before issuing a request', () => {
  const requests = [];
  const context = vmContext({
    state: { activeDocument: null, documents: [] },
    apiFetch: async (...args) => { requests.push(args); return { ok: true, json: async () => ({ moved: true }) }; },
  });
  return Promise.all([
    assert.rejects(context.moveKnowledgeItem({ type: 'folder', path: '库/来源' }, { knowledgeBase: '库', folderPath: '来源' }), /不能把文件夹移入自身/),
    assert.rejects(context.moveKnowledgeItem({ type: 'folder', path: '库/来源' }, { knowledgeBase: '库', folderPath: '来源/子级' }), /不能把文件夹移入自身/),
  ]).then(() => assert.equal(requests.length, 0));
});

test('notes and imported files are moved to the selected same-level folder with version checks', async () => {
  for (const document of [
    { id: 'note:21', version: 4, knowledgeBase: '库', folderPath: '来源' },
    { id: 'file:22', sourceType: 'file', version: 7, knowledgeBase: '库', folderPath: '来源' },
  ]) {
    let request;
    const context = vmContext({
      state: { activeDocument: document, documents: [] },
      apiFetch: async (url, options) => {
        request = { url, body: JSON.parse(options.body) };
        return { ok: true, json: async () => ({ ...document, folderPath: '目标', collectionPath: '库/目标' }) };
      },
    });
    await context.moveKnowledgeItem({ type: 'document', id: document.id }, { knowledgeBase: '库', folderPath: '目标' });
    assert.match(request.url, new RegExp(encodeURIComponent(document.id)));
    assert.deepEqual(request.body, { knowledgeBase: '库', folderPath: '目标', baseVersion: document.version });
  }
});

function vmContext(globals) {
  const source = fs.readFileSync('public/js/workbench.js', 'utf8');
  const start = source.indexOf('async function moveKnowledgeItem(');
  const end = source.indexOf('async function loadDocuments(', start);
  const context = vm.createContext({
    flushPendingSaves: async () => true,
    renderActiveDocument: async () => {},
    loadDocuments: async () => {},
    showToast() {},
    history: { replaceState() {} },
    routeHash: () => '',
    rememberKnowledgeResume() {},
    ...globals,
  });
  vm.runInContext(source.slice(start, end) + '; globalThis.moveKnowledgeItem = moveKnowledgeItem;', context);
  return context;
}
