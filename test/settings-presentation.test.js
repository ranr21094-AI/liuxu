const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const fs = require('node:fs');
const vm = require('node:vm');

test('native settings validation reveals hidden panels and collapsed advanced fields', async () => {
  const dom = new JSDOM('<form><section data-settings-panel="agent" hidden><details><summary>Advanced</summary><input required></details></section></form>');
  const previous = global.requestAnimationFrame;
  global.requestAnimationFrame = callback => callback();
  try {
    const { initSettingsPresentation } = await import('../public/js/app/settings-presentation.js');
    let selected;
    initSettingsPresentation(dom.window.document.querySelector('form'), name => {
      selected = name; dom.window.document.querySelector('section').hidden = false;
    });
    dom.window.document.querySelector('input').dispatchEvent(new dom.window.Event('invalid'));
    assert.equal(selected, 'agent');
    assert.equal(dom.window.document.querySelector('details').open, true);
    assert.equal(dom.window.document.activeElement.tagName, 'INPUT');
  } finally { global.requestAnimationFrame = previous; dom.window.close(); }
});

test('settings save is locked during a request and failed drafts remain available for retry', async () => {
  const dom = new JSDOM('<button id="saveAgentSettings">保存设置</button><span id="settingsSaveStatus"></span><input id="draft" value="keep">');
  const source = fs.readFileSync('public/js/workbench.js', 'utf8');
  let calls = 0, resolve;
  const context = {
    state: { aiSettings: {} }, $: selector => dom.window.document.querySelector(selector),
    settingsSavePayload: () => ({ example: true }), showToast() {},
    apiFetch: () => { calls++; return new Promise(done => { resolve = done; }); },
  };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('let settingsSaving = false;'), source.indexOf('function syncComputerSettingsVisibility()')), context);
  const first = vm.runInContext('saveAgentSettings()', context);
  await vm.runInContext('saveAgentSettings()', context);
  assert.equal(calls, 1);
  assert.equal(dom.window.document.querySelector('button').disabled, true);
  resolve({ ok: false, json: async () => ({ error: 'Failed' }) });
  await first;
  assert.equal(dom.window.document.querySelector('#settingsSaveStatus').textContent, 'Failed');
  assert.equal(dom.window.document.querySelector('#draft').value, 'keep');
  assert.equal(dom.window.document.querySelector('button').disabled, false);
  const retry = vm.runInContext('saveAgentSettings()', context);
  assert.equal(calls, 2);
  resolve({ ok: false, json: async () => ({ error: 'Retry failed' }) });
  await retry;
  dom.window.close();
});
