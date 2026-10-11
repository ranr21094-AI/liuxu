const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
test('provider menu renames inline, updates selector and returns focus on Escape', async () => {
  const dom = new JSDOM('<div id="root"><section class="custom-provider-detail"><select class="provider-selector"><option>Before</option></select><details class="provider-more"><summary>More</summary><div><button data-provider-rename>Rename</button><button>Delete</button></div></details><label class="provider-name-editor" hidden><input value="Before"></label></section></div>');
  const old = global.document; global.document = dom.window.document;
  try {
    const { initProviderControls } = await import('../public/js/app/provider-controls.js');
    initProviderControls(document.querySelector('#root'));
    const menu = document.querySelector('details'); menu.open = true;
    document.querySelector('[data-provider-rename]').click();
    const input = document.querySelector('input');
    assert.equal(input.closest('label').hidden, false); assert.equal(document.activeElement, input);
    input.value = 'After'; input.blur();
    assert.equal(document.querySelector('select').selectedOptions[0].textContent, 'After');
    assert.equal(input.closest('label').hidden, true);
    menu.open = true; document.querySelector('summary').focus();
    document.querySelector('summary').dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));
    assert.equal(document.activeElement.textContent,'Rename');
    document.activeElement.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
    assert.equal(menu.open,false); assert.equal(document.activeElement.tagName,'SUMMARY');
    menu.open=true; document.body.dispatchEvent(new dom.window.Event('pointerdown',{bubbles:true})); assert.equal(menu.open,false);
  } finally { global.document=old; dom.window.close(); }
});
