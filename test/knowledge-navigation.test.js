const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

test('directory navigation shows only peers, focuses current item and preserves menu exclusivity', async () => {
  const dom = new JSDOM('<body><div id="knowledgeSidebarPanel"><nav id="knowledgeBreadcrumb"><button data-directory-menu="base">库</button><button data-directory-menu="a">a</button></nav></div></body>');
  const doc = dom.window.document;
  const proto = dom.window.HTMLElement.prototype;
  const matches = proto.matches;
  proto.matches = function(selector) { return selector === ':popover-open' ? !!this._open : matches.call(this, selector); };
  proto.showPopover = function() { this._open = true; };
  proto.hidePopover = function() { this._open = false; };
  const bases = [{ name: '库', folders: [{ name: 'a', path: 'a', children: [{ name: 'b', path: 'a/b', children: [] }] }, { name: 'c', path: 'c', children: [] }] }, { name: '其他', folders: [] }];
  const jumps = [];
  const { initKnowledgeNavigation } = await import('../public/js/app/knowledge-navigation.js');
  initKnowledgeNavigation({ doc, getBases: () => bases, getLocation: () => ({ knowledgeBase: '库', folderPath: 'a/b' }), navigate: (...args) => jumps.push(args) });
  const panel = doc.querySelector('.knowledge-navigation-menu');
  const clickText = text => [...panel.querySelectorAll('button')].find(button => button.querySelector('.knowledge-navigation-label')?.textContent === text).click();
  try {
    doc.querySelector('[data-directory-menu="base"]').click();
    assert.equal(panel._open, true);
    clickText('其他'); assert.deepEqual(jumps.pop(), ['其他', '']); assert.equal(panel._open, false);
    const trigger = doc.querySelector('[data-directory-menu="a"]'); trigger.click();
    assert.equal(panel.querySelector('[aria-current] .knowledge-navigation-label').textContent, 'a');
    assert.equal(doc.activeElement, panel.querySelector('[aria-current]'));
    assert.deepEqual([...panel.querySelectorAll('.knowledge-navigation-label')].map(el => el.textContent), ['a', 'c']);
    clickText('a'); assert.deepEqual(jumps.pop(), ['库', 'a']);
    trigger.click(); doc.activeElement.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    assert.equal(doc.activeElement.textContent, 'c');
    doc.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(panel._open, false); assert.equal(doc.activeElement, trigger);
    trigger.click(); doc.dispatchEvent(new dom.window.CustomEvent('knowledge-menu-open', { detail: {} }));
    assert.equal(panel._open, false);
    trigger.click(); doc.body.classList.add('sidebar-collapsed');
    await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(panel._open, false);
  } finally { dom.window.close(); }
});
