const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { JSDOM } = require('jsdom');

const HTML = `<!doctype html><body data-mode="knowledge"><main class="workspace-main"><section class="knowledge-view"><article id="documentWorkspace"></article><button id="noteBrowserToggleButton" hidden></button><aside id="noteBrowserPanel" hidden><div id="noteBrowserResize"></div><div id="noteBrowserTabs"></div><button id="noteBrowserNewTab"></button><button id="noteBrowserExpand"></button><button id="noteBrowserClosePanel"></button><form id="noteBrowserAddressForm"><button id="noteBrowserBack"></button><button id="noteBrowserForward"></button><button id="noteBrowserReload"></button><input id="noteBrowserAddress"><button type="submit"></button><button id="noteBrowserExternal"></button></form><div id="noteBrowserViewport"><div id="noteBrowserEmpty"></div></div></aside></section><aside id="noteAssistantPanel" hidden></aside></main></body>`;

function setup() {
  const dom = new JSDOM(HTML, { url: 'http://127.0.0.1/' });
  const previous = {};
  for (const key of ['window', 'document', 'localStorage', 'MutationObserver', 'ResizeObserver', 'requestAnimationFrame', 'innerWidth']) previous[key] = global[key];
  global.window = dom.window; global.document = dom.window.document; global.localStorage = dom.window.localStorage;
  global.MutationObserver = dom.window.MutationObserver;
  global.ResizeObserver = class { observe() {} disconnect() {} };
  global.requestAnimationFrame = callback => setTimeout(callback, 0); global.innerWidth = 1400;
  const listeners = [];
  const calls = { opened: [], activated: [], closed: [], commands: [] };
  let id = 0;
  dom.window.liuxuDesktop = { browser: {
    available: true,
    open: async ({ documentId, url }) => { const tab = { id: `tab-${++id}`, documentId, url, title: new URL(url).hostname, pageVersion: 1, canGoBack: false, canGoForward: false, loading: false }; calls.opened.push(tab); return tab; },
    activate: async payload => { calls.activated.push(payload); const all = calls.opened; return { tab: all.find(tab => tab.id === payload.tabId) || null }; },
    close: async payload => { calls.closed.push(payload); return { closed: true }; },
    command: async payload => { calls.commands.push(payload); const tab = calls.opened.find(item => item.id === payload.tabId); return { ...tab, url: payload.url || tab.url }; },
    executeTool: async () => ({ ok: true }), onEvent: callback => { listeners.push(callback); return () => {}; },
  } };
  return { dom, previous, calls, listeners };
}
function cleanup(ctx) {
  ctx.controller?.destroy();
  ctx.dom.window.close();
  for (const [key, value] of Object.entries(ctx.previous)) value === undefined ? delete global[key] : global[key] = value;
}
async function load() {
  const url = pathToFileURL(path.join(__dirname, '../public/js/knowledge/note-browser.js')); url.search = `${Date.now()}-${Math.random()}`;
  return import(url.href);
}

test('browser sidebar keeps independent multi-tab state for each note', async () => {
  const ctx = setup();
  try {
    const browser = await load(); ctx.controller = browser.initNoteBrowser();
    browser.noteBrowserSetDocument({ id: 'note:1', status: 'active' });
    document.querySelector('#noteBrowserToggleButton').click();
    await new Promise(resolve => setTimeout(resolve, 20));
    document.querySelector('#noteBrowserNewTab').click(); await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(ctx.calls.opened.filter(tab => tab.documentId === 'note:1').length, 2);
    browser.noteBrowserSetDocument({ id: 'note:2', status: 'active' });
    document.querySelector('#noteBrowserToggleButton').click(); await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(ctx.calls.opened.filter(tab => tab.documentId === 'note:2').length, 1);
    browser.noteBrowserSetDocument({ id: 'note:1', status: 'active' }); await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(document.querySelectorAll('.note-browser-tab').length, 2);
    assert.equal(document.querySelector('#noteBrowserPanel').hidden, false);
  } finally { cleanup(ctx); }
});

test('sidebar normalizes search text, resizes by keyboard, and clears restored workspace state', async () => {
  const ctx = setup();
  try {
    const browser = await load(); ctx.controller = browser.initNoteBrowser(); browser.noteBrowserSetDocument({ id: 'note:1', status: 'active' });
    document.querySelector('#noteBrowserToggleButton').click(); await new Promise(resolve => setTimeout(resolve, 20));
    const input = document.querySelector('#noteBrowserAddress'); input.value = 'browser sidebar query';
    document.querySelector('#noteBrowserAddressForm').dispatchEvent(new ctx.dom.window.Event('submit', { bubbles: true, cancelable: true })); await new Promise(resolve => setTimeout(resolve, 10));
    assert.match(ctx.calls.commands.at(-1).url, /^https:\/\/www\.google\.com\/search\?q=/);
    document.querySelector('#noteBrowserResize').dispatchEvent(new ctx.dom.window.KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    assert.equal(document.querySelector('#noteBrowserPanel').style.width, '320px');
    browser.noteBrowserResetWorkspace(); await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(document.querySelector('#noteBrowserPanel').hidden, true);
    assert.ok(ctx.calls.closed.length >= 1);
  } finally { cleanup(ctx); }
});

test('diary lock hides private browser but leaves a public note browser available', async () => {
  const ctx = setup();
  try {
    const browser = await load(); ctx.controller = browser.initNoteBrowser();
    browser.noteBrowserSetDocument({ id: 'note:1', status: 'active', visibility: 'standard' }); browser.noteBrowserLockPrivate();
    assert.equal(document.querySelector('#noteBrowserToggleButton').hidden, false);
    browser.noteBrowserSetDocument({ id: 'note:2', status: 'active', visibility: 'diary' }); browser.noteBrowserLockPrivate();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(document.querySelector('#noteBrowserToggleButton').hidden, true);
    assert.equal(ctx.calls.activated.at(-1).visible, false);
  } finally { cleanup(ctx); }
});
