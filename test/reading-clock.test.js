const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

let modulePromise;
const loadClock = () => modulePromise ||= import('../public/js/knowledge/reading-clock.js');
const tickMicrotasks = async () => { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)); };

test('reading clock pauses after five idle minutes, resumes on input and retries saved time idempotently', async t => {
  const dom = new JSDOM('<main><footer class="reader-footer"></footer></main>', { pretendToBeVisual: true, url: 'http://localhost/' });
  const old = {
    window: global.window, document: global.document, localStorage: global.localStorage, fetch: global.fetch,
    setInterval: global.setInterval, clearInterval: global.clearInterval,
    performance: Object.getOwnPropertyDescriptor(global, 'performance'),
  };
  let now = 0, intervalId = 0, failFirstWrite = true;
  const intervals = new Map(), writes = [];
  Object.defineProperty(dom.window.document, 'visibilityState', { configurable: true, value: 'visible' });
  dom.window.document.hasFocus = () => true;
  global.window = dom.window; global.document = dom.window.document; global.localStorage = dom.window.localStorage;
  Object.defineProperty(global, 'performance', { configurable: true, value: { now: () => now } });
  global.setInterval = (callback, delay) => { const id = ++intervalId; intervals.set(id, { callback, delay }); return id; };
  global.clearInterval = id => intervals.delete(id);
  global.fetch = async (url, options = {}) => {
    if (String(url).endsWith('/reading-time') && options.method === 'PUT') {
      writes.push(JSON.parse(options.body));
      if (failFirstWrite) { failFirstWrite = false; return { ok: false, status: 503, json: async () => ({}) }; }
      return { ok: true, json: async () => ({ milliseconds: 421000 }) };
    }
    return { ok: true, json: async () => ({ milliseconds: 120000 }) };
  };
  t.after(() => {
    dom.window.close();
    for (const key of ['window', 'document', 'localStorage', 'fetch', 'setInterval', 'clearInterval']) {
      if (old[key] === undefined) delete global[key]; else global[key] = old[key];
    }
    if (old.performance) Object.defineProperty(global, 'performance', old.performance); else delete global.performance;
  });

  const controller = new dom.window.AbortController();
  const { startReadingClock } = await loadClock();
  const host = dom.window.document.querySelector('main');
  startReadingClock({ id: 'file:unindexed' }, host, controller.signal, () => true);
  await tickMicrotasks();
  const second = [...intervals.values()].find(item => item.delay === 1000).callback;
  const sync = [...intervals.values()].find(item => item.delay === 30000).callback;
  for (let i = 0; i < 300; i++) { now += 1000; second(); }
  now += 1000; second();
  assert.match(host.querySelector('.reader-time').textContent, /本次 5分0秒/);
  now += 5000; second();
  assert.match(host.querySelector('.reader-time').textContent, /本次 5分0秒/);

  dom.window.dispatchEvent(new dom.window.Event('pointerdown'));
  now += 1000; second();
  assert.match(host.querySelector('.reader-time').textContent, /本次 5分1秒/);
  sync(); await tickMicrotasks();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].milliseconds, 301000);
  assert.equal(host.querySelector('.reader-time-state').textContent, '保存失败，将重试');
  assert.ok(dom.window.localStorage.getItem('liuxu.readingTime.pending.v1'));

  sync(); await tickMicrotasks();
  assert.equal(writes.length, 2);
  assert.equal(writes[1].sessionId, writes[0].sessionId);
  assert.ok(writes[1].sequence > writes[0].sequence);
  assert.equal(dom.window.localStorage.getItem('liuxu.readingTime.pending.v1'), '{}');
  assert.equal(host.querySelector('.reader-time-state').textContent, '已保存');
  controller.abort(); await tickMicrotasks();
  assert.equal(host.querySelector('.reader-time'), null);
});

test('reading clock excludes the reader text-only mode', async t => {
  const dom = new JSDOM('<main><footer class="reader-footer"></footer><pre class="file-preview-text">原文</pre></main>', { pretendToBeVisual: true, url: 'http://localhost/' });
  const old = { window: global.window, document: global.document, localStorage: global.localStorage, fetch: global.fetch,
    setInterval: global.setInterval, clearInterval: global.clearInterval, performance: Object.getOwnPropertyDescriptor(global, 'performance') };
  let now = 0; const intervals = new Map(); let seq = 0;
  Object.defineProperty(dom.window.document, 'visibilityState', { configurable: true, value: 'visible' }); dom.window.document.hasFocus = () => true;
  global.window = dom.window; global.document = dom.window.document; global.localStorage = dom.window.localStorage;
  Object.defineProperty(global, 'performance', { configurable: true, value: { now: () => now } });
  global.setInterval = (callback, delay) => { const id = ++seq; intervals.set(id, { callback, delay }); return id; }; global.clearInterval = id => intervals.delete(id);
  global.fetch = async () => ({ ok: true, json: async () => ({ milliseconds: 0 }) });
  t.after(() => { dom.window.close(); for (const key of ['window', 'document', 'localStorage', 'fetch', 'setInterval', 'clearInterval']) { if (old[key] === undefined) delete global[key]; else global[key] = old[key]; } if (old.performance) Object.defineProperty(global, 'performance', old.performance); else delete global.performance; });
  const controller = new dom.window.AbortController(); const { startReadingClock } = await loadClock(); const host = dom.window.document.querySelector('main');
  startReadingClock({ id: 'file:text' }, host, controller.signal, () => true);
  await tickMicrotasks();
  const timer = [...intervals.values()].find(item => item.delay === 1000).callback;
  for (let i = 0; i < 4; i++) { now += 1000; timer(); }
  assert.match(host.querySelector('.reader-time').textContent, /本次 0秒/);
  controller.abort();
});
