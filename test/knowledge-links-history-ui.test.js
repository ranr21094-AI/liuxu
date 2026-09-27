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
    assert.equal(document.querySelector('#knowledgeRevisionCount').textContent, '–');
  } finally {
    dom.window.close();
    restoreGlobals(old);
  }
});
