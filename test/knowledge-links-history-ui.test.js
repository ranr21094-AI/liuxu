const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { JSDOM } = require('jsdom');

function makeDom() {
  const dom = new JSDOM(`<!doctype html><body>
    <textarea id="documentContent"></textarea><div id="knowledgeLinkPicker" hidden></div>
    <div id="knowledgeLinkIssues" hidden></div>
    <section id="knowledgeRelations"><details id="knowledgeRelationsDetails">
      <summary><span id="knowledgeRelationsSummary"></span></summary>
      <div class="knowledge-relations-tabs">
        <button type="button" class="active" data-knowledge-relations-tab="backlinks" aria-selected="true"><span id="knowledgeBacklinkCount">–</span></button>
        <button type="button" data-knowledge-relations-tab="revisions" aria-selected="false"><span id="knowledgeRevisionCount">–</span></button>
      </div>
      <div id="knowledgeBacklinksPanel"><div id="knowledgeBacklinksList"></div><button id="knowledgeBacklinksLoadMore"></button></div>
      <div id="knowledgeRevisionsPanel" hidden><input id="knowledgeRevisionName"><button id="saveKnowledgeRevision"></button><div id="knowledgeRevisionsList"></div><div id="knowledgeRevisionDetail" hidden></div><button id="knowledgeRevisionsLoadMore" hidden></button></div>
    </details></section><div id="toastContainer"></div>
  </body>`, { url: 'http://127.0.0.1/' });
  const old = { window: global.window, document: global.document, Event: global.Event };
  global.window = dom.window;
  global.document = dom.window.document;
  global.Event = dom.window.Event;
  return { dom, old };
}

function restoreGlobals(old) {
  for (const [key, value] of Object.entries(old)) {
    if (value === undefined) delete global[key];
    else global[key] = value;
  }
}

async function moduleUnderTest() {
  const url = pathToFileURL(path.join(__dirname, '../public/js/knowledge/links-history.js'));
  url.search = `ui=${Date.now()}-${Math.random()}`;
  return import(url.href);
}

test('revision tab loads on click, shows its own retry, and can recover from a failed request', async () => {
  const { dom, old } = makeDom();
  try {
    const { initKnowledgeEnhancements } = await moduleUnderTest();
    let calls = 0;
    const ui = initKnowledgeEnhancements({
      state: {}, navigate() {}, confirmAction: async () => true,
      apiFetch: async url => {
        if (String(url).includes('/revisions?')) {
          calls += 1;
          if (calls === 1) throw new Error('模拟历史接口错误');
          return { ok: true, json: async () => ({ total: 0, revisions: [], nextCursor: null }) };
        }
        return { ok: true, json: async () => ({ total: 0, backlinks: [], nextCursor: null }) };
      },
    });
    ui.setActiveDocument({ id: 'note:11', version: 1, content: '' });
    assert.equal(document.querySelector('[data-knowledge-relations-tab="revisions"]').hidden, false);
    document.querySelector('#knowledgeRelationsDetails summary').click();
    await new Promise(resolve => setTimeout(resolve, 0));
    document.querySelector('[data-knowledge-relations-tab="revisions"]').click();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.match(document.querySelector('#knowledgeRevisionsList').textContent, /模拟历史接口错误/);
    assert.doesNotMatch(document.querySelector('#knowledgeBacklinksList').textContent, /模拟历史接口错误/);
    document.querySelector('[data-retry-revisions]').click();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(calls, 2);
    assert.match(document.querySelector('#knowledgeRevisionsList').textContent, /还没有可恢复的历史版本/);
    assert.equal(document.querySelector('#knowledgeRevisionCount').textContent, '0');
    assert.equal(document.querySelector('#knowledgeRevisionsPanel').hidden, false);
    assert.equal(document.querySelector('#knowledgeBacklinksPanel').hidden, true);
  } finally {
    dom.window.close();
    restoreGlobals(old);
  }
});

test('late history responses from the previous note are discarded', async () => {
  const { dom, old } = makeDom();
  try {
    const { initKnowledgeEnhancements } = await moduleUnderTest();
    let finishOld;
    const ui = initKnowledgeEnhancements({
      state: {}, navigate() {}, confirmAction: async () => true,
      apiFetch: url => {
        if (String(url).includes('note%3A1/revisions?')) return new Promise(resolve => { finishOld = resolve; });
        return Promise.resolve({ ok: true, json: async () => ({ total: 0, revisions: [], nextCursor: null }) });
      },
    });
    ui.setActiveDocument({ id: 'note:1', version: 1, sourceType: 'note', content: '' });
    document.querySelector('#knowledgeRelationsDetails').open = true;
    await new Promise(resolve => setTimeout(resolve, 0));
    document.querySelector('[data-knowledge-relations-tab="revisions"]').click();
    for (let attempt = 0; attempt < 5 && !finishOld; attempt += 1) await new Promise(resolve => setTimeout(resolve, 0));
    ui.setActiveDocument({ id: 'note:2', version: 1, sourceType: 'note', content: '' });
    finishOld({ ok: true, json: async () => ({ total: 1, revisions: [{ id: 77, documentVersion: 1, title: '旧笔记内容', contentLength: 9 }], nextCursor: null }) });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.doesNotMatch(document.querySelector('#knowledgeRevisionsList').textContent, /旧笔记内容/);
    assert.equal(document.querySelector('#knowledgeRevisionCount').hidden, true);
  } finally {
    dom.window.close();
    restoreGlobals(old);
  }
});

function makeRedesignedDom() {
  const fs = require('node:fs');
  const { dom, old } = makeDom();
  dom.window.document.body.innerHTML = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const dialog = dom.window.document.querySelector('#knowledgeRevisionDialog');
  dialog.showModal = function () { this.open = true; this.querySelector('[data-close-revision]').focus(); };
  dialog.close = function () { this.open = false; };
  return { dom, old };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 10));

test('bottom entries open directly, toggle closed, load only the chosen list and preserve unknown counts', async () => {
  const { dom, old } = makeRedesignedDom();
  try {
    const { initKnowledgeEnhancements } = await moduleUnderTest();
    const calls = [];
    const ui = initKnowledgeEnhancements({ state: {}, navigate() {}, confirmAction: async () => true,
      apiFetch: async url => { calls.push(url); return { ok: true, json: async () => ({ total: 0, revisions: [], backlinks: [] }) }; },
    });
    ui.setActiveDocument({ id: 'note:1', version: 2, content: '', sourceType: 'note' });
    const revisions = document.querySelector('[data-knowledge-relations-tab="revisions"]');
    assert.equal(document.querySelector('#knowledgeRevisionCount').hidden, true);
    revisions.click(); await tick();
    assert.equal(revisions.getAttribute('aria-expanded'), 'true');
    assert.equal(calls.length, 1); assert.match(calls[0], /revisions\?/);
    assert.equal(document.querySelector('#knowledgeRevisionCount').textContent, '0');
    ui.onDocumentSaved({ id: 'note:1', version: 3 }); await tick();
    assert.equal(calls.length, 2); assert.ok(calls.every(url => url.includes('/revisions?')));
    revisions.click(); assert.equal(document.querySelector('#knowledgeRelationsDetails').open, false);
    const backlinks = document.querySelector('[data-knowledge-relations-tab="backlinks"]');
    backlinks.click(); await tick(); assert.match(calls.at(-1), /backlinks/);
    backlinks.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    assert.equal(document.querySelector('#knowledgeRelationsDetails').open, false);
    assert.equal(document.activeElement, backlinks);
  } finally { dom.window.close(); restoreGlobals(old); }
});

test('revision comparison uses a modal, shows changed fields, preserves failed restore, and closes after success', async () => {
  const { dom, old } = makeRedesignedDom();
  try {
    const { initKnowledgeEnhancements } = await moduleUnderTest();
    let fail = true, restoreCount = 0, confirmCount = 0;
    const snapshot = { title: '历史标题', content: '旧正文', tags: [], documentDate: '', knowledgeBase: '其他' };
    const revision = { id: 7, name: '初稿', documentVersion: 1, snapshot };
    const ui = initKnowledgeEnhancements({ state: {}, navigate() {}, beforeMutation: async () => true, afterMutation() {}, onRestore() {},
      confirmAction: async () => { confirmCount++; return true; },
      apiFetch: async (url, options) => {
        if (url.endsWith('/restore')) { restoreCount++; return { ok: !fail, status: fail ? 409 : 200, json: async () => fail ? { error: '模拟版本冲突' } : { document: { id: 'note:1', version: 3, ...snapshot } } }; }
        if (url.endsWith('/revisions/7')) return { ok: true, json: async () => ({ revision }) };
        return { ok: true, json: async () => ({ total: 1, revisions: [revision] }) };
      },
    });
    ui.setActiveDocument({ id: 'note:1', version: 2, sourceType: 'note', ...snapshot, title: '当前标题', content: '新正文' });
    document.querySelector('[data-knowledge-relations-tab="revisions"]').click(); await tick();
    document.querySelector('[data-revision-id="7"]').click(); await tick();
    const dialog = document.querySelector('#knowledgeRevisionDialog');
    assert.equal(dialog.open, true);
    assert.equal(document.querySelectorAll('.knowledge-revision-field').length, 1);
    assert.deepEqual([...document.querySelectorAll('.knowledge-revision-diff h4')].map(el => el.textContent), ['历史', '当前']);
    document.querySelector('[data-restore-location]').checked = true;
    document.querySelector('[data-restore-revision]').click(); await tick();
    assert.equal(dialog.open, true); assert.match(dialog.textContent, /模拟版本冲突/);
    assert.equal(document.querySelector('[data-restore-location]').checked, true);
    assert.equal(restoreCount, 1); assert.equal(confirmCount, 1);
    fail = false;
    document.querySelector('[data-restore-revision]').click(); await tick();
    assert.equal(dialog.open, false); assert.equal(restoreCount, 2);
    assert.equal(document.querySelector('#knowledgeRelationsDetails').open, true);
    assert.equal(document.querySelector('#knowledgeRevisionsPanel').hidden, false);
    assert.equal(document.querySelector('#knowledgeBacklinksPanel').hidden, true);
  } finally { dom.window.close(); restoreGlobals(old); }
});

test('comparison close restores row focus, saving does not reopen it, and switching notes resets auxiliary panels', async () => {
  const { dom, old } = makeRedesignedDom();
  try {
    const { initKnowledgeEnhancements } = await moduleUnderTest();
    const revision = { id: 7, documentVersion: 1, snapshot: { content: '旧' } };
    const ui = initKnowledgeEnhancements({ state: {}, navigate() {}, confirmAction: async () => false,
      apiFetch: async url => ({ ok: true, json: async () => url.endsWith('/revisions/7') ? { revision } : { total: 1, revisions: [revision] } }),
    });
    ui.setActiveDocument({ id: 'note:1', sourceType: 'note', content: '当前', version: 1 });
    document.querySelector('[data-knowledge-relations-tab="revisions"]').click(); await tick();
    document.querySelector('[data-revision-id="7"]').click(); await tick();
    document.querySelector('[data-close-revision]').click();
    assert.equal(document.activeElement.dataset.revisionId, '7');
    ui.onDocumentSaved({ id: 'note:1', version: 2 }); await tick();
    assert.equal(document.querySelector('#knowledgeRevisionDialog').open, false);
    document.querySelector('#knowledgeRevisionCreateToggle').click();
    assert.equal(document.querySelector('#knowledgeRevisionCreate').hidden, false);
    ui.setActiveDocument({ id: 'note:2', sourceType: 'note', version: 1 });
    assert.equal(document.querySelector('#knowledgeRevisionCreate').hidden, true);
    assert.equal(document.querySelector('#knowledgeRelationsDetails').open, false);
    assert.equal(document.querySelector('[data-knowledge-relations-tab="revisions"]').getAttribute('aria-expanded'), 'false');
  } finally { dom.window.close(); restoreGlobals(old); }
});

test('late revision detail cannot reopen the comparison after a document switch', async () => {
  const { dom, old } = makeRedesignedDom();
  try {
    const { initKnowledgeEnhancements } = await moduleUnderTest(); let finish;
    const ui = initKnowledgeEnhancements({ state: {}, navigate() {}, confirmAction: async () => false,
      apiFetch: url => url.endsWith('/revisions/7') ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ ok: true, json: async () => ({ total: 1, revisions: [{ id: 7, documentVersion: 1 }] }) }),
    });
    ui.setActiveDocument({ id: 'note:1', sourceType: 'note', version: 1 });
    document.querySelector('[data-knowledge-relations-tab="revisions"]').click(); await tick();
    document.querySelector('[data-revision-id="7"]').click(); await tick();
    ui.setActiveDocument({ id: 'note:2', sourceType: 'note', version: 1 });
    finish({ ok: true, json: async () => ({ revision: { id: 7, name: '旧记录', snapshot: { content: '旧正文' } } }) });await tick();
    assert.equal(document.querySelector('#knowledgeRevisionDialog').open, false);
    assert.equal(document.querySelector('#knowledgeRevisionDetail').hidden, true);
  } finally { dom.window.close(); restoreGlobals(old); }
});

test('text-file history compares original content and sends fingerprints, separate from extracted text', async () => {
  const { dom, old } = makeRedesignedDom();
  try {
    const { initKnowledgeEnhancements } = await moduleUnderTest();
    const sent = [];
    const snapshot = { title: 'source.txt', content: '历史原件\r\n', tags: [], snapshotKind: 'text_file', file: { bom: true, bytes: 20, sha256: 'old' } };
    const revision = { id: 8, name: '原件历史', documentVersion: 1, snapshot };
    const ui = initKnowledgeEnhancements({ state: {}, navigate() {}, beforeMutation: async () => true, afterMutation() {},
      confirmAction: async () => true,
      apiFetch: async (url, options) => {
        if (options?.method === 'POST') sent.push(JSON.parse(options.body));
        if (url.endsWith('/revisions/8')) return { ok: true, json: async () => ({ revision }) };
        if (options?.method === 'POST') return { ok: true, json: async () => ({ revision }) };
        return { ok: true, json: async () => ({ total: 1, revisions: [revision] }) };
      },
    });
    ui.setActiveDocument({ id: 'file:1', sourceType: 'file', version: 2, title: 'source.txt', textFileSupported: true,
      textFileEditable: true, rawContent: '当前原件\r\n', content: '错误的搜索提取文字', baseFingerprint: 'current' });
    assert.equal(document.querySelector('#knowledgeRelations').hidden, false);
    document.querySelector('[data-knowledge-relations-tab="revisions"]').click(); await tick();
    document.querySelector('[data-revision-id="8"]').click(); await tick();
    const dialog = document.querySelector('#knowledgeRevisionDialog');
    assert.match(dialog.textContent, /当前原件/); assert.doesNotMatch(dialog.textContent, /错误的搜索提取文字/);
    document.querySelector('[data-close-revision]').click();
    document.querySelector('#knowledgeRevisionName').value = '新版本';
    document.querySelector('#saveKnowledgeRevision').click(); await tick();
    assert.equal(sent[0].baseFingerprint, 'current');
    assert.equal(sent[0].baseVersion, 2);
  } finally { dom.window.close(); restoreGlobals(old); }
});
