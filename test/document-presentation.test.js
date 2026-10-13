const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { JSDOM } = require('jsdom');
test('document modes expose the active state and keep original controls', async () => {
  const dom = new JSDOM(fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8'));
  const old = global.document; global.document = dom.window.document;
  try {
    const url = pathToFileURL(path.join(__dirname, '../public/js/app/document-presentation.js'));
    const { initDocumentPresentation } = await import(url.href); initDocumentPresentation();
    const switcher = document.querySelector('#editorModeSwitch');
    assert.equal(switcher.getAttribute('role'), 'group');
    assert.equal(switcher.querySelectorAll('.mode-indicator').length, 1);
    const buttons = [...switcher.querySelectorAll('[data-editor-mode]')];
    buttons.forEach(button => button.classList.remove('active'));
    buttons[1].classList.add('active');
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(buttons[1].getAttribute('aria-pressed'), 'true');
    assert.equal(buttons[0].getAttribute('aria-pressed'), 'false');
    assert.ok(document.querySelector('#noteFindToggleButton'));
    assert.ok(document.querySelector('#assistantToggleButton'));
  } finally { if(old===undefined)delete global.document;else global.document=old;dom.window.close(); }
});
