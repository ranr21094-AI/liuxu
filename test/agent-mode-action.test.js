const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
async function setup(createSession) {
  const dom = new JSDOM('<nav><button type="button">Agent</button></nav><button id="create" type="button">＋</button>');
  let switched = 0;
  const errors = [];
  const button = dom.window.document.getElementById('create');
  const { initSessionCreateAction } = await import('../public/js/app/agent-mode-action.js');
  const action = initSessionCreateAction(button, { createSession, onError: error => errors.push(error.message) });
  dom.window.document.querySelector('nav').addEventListener('click', () => switched++);
  return { dom, button, errors, action, get switched() { return switched; }, setMode() { action.sync(); } };
}
test('Agent navigation never creates; bottom new-session action creates once', async () => {
  let created = 0, finish;
  const ui = await setup(() => { created++; return new Promise(resolve => finish = resolve); });
  ui.dom.window.document.querySelector('nav button').click();
  ui.dom.window.document.querySelector('nav button').click(); assert.equal(ui.switched, 2); assert.equal(created, 0);
  ui.setMode('agent'); assert.equal(ui.button.getAttribute('aria-label'), '新建会话');
  ui.button.click(); ui.button.dispatchEvent(new ui.dom.window.Event('click', { bubbles: true }));
  assert.equal(created, 1); assert.equal(ui.switched, 2); assert.equal(ui.button.disabled, true);
  finish(); await Promise.resolve(); await Promise.resolve();
  assert.equal(ui.button.disabled, false); assert.equal(ui.button.getAttribute('aria-busy'), 'false');
  ui.dom.window.close();
});
test('failed creation restores the button and reports the error', async () => {
  const ui = await setup(async () => { throw new Error('offline'); });
  ui.setMode('agent'); ui.button.click();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(ui.button.disabled, false); assert.deepEqual(ui.errors, ['offline']);
  assert.equal(ui.button.getAttribute('aria-label'), '新建会话');
  ui.dom.window.close();
});
