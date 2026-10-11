const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
test('unified operations support direct creation, keyboard menu and sidebar collapse', async () => {
  const dom = new JSDOM(fs.readFileSync('public/index.html', 'utf8'), { url: 'http://localhost' });
  const doc = dom.window.document;
  const proto = dom.window.HTMLElement.prototype, matches = proto.matches;
  proto.matches = function(selector) { return selector === ':popover-open' ? !!this._open : matches.call(this, selector); };
  proto.showPopover = function() { this._open = true; }; proto.hidePopover = function() { this._open = false; };
  doc.getElementById('knowledgeSidebarPanel').hidden = false;
  const { initKnowledgeOperations } = await import('../public/js/app/knowledge-operations.js');
  let created = 0;
  initKnowledgeOperations({ doc, createNote: () => created++ });
  const toggle = doc.getElementById('knowledgeFilterToggle'), menu = doc.getElementById('knowledgeFilterPanel');
  try {
    toggle.click(); assert.equal(created, 1); assert.equal(menu.hidden, true);
    toggle.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    assert.equal(menu.hidden, false); assert.equal(doc.activeElement.id, 'newNoteButton');
    doc.activeElement.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    assert.equal(doc.activeElement.id, 'newMindmapButton');
    doc.body.classList.add('sidebar-collapsed'); await tick(); assert.equal(menu.hidden, true);
    doc.body.classList.remove('sidebar-collapsed');
    doc.getElementById('knowledgeFilterCount').hidden = false;
    toggle.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    assert.equal(doc.getElementById('knowledgeFilterDetails').open, true);
    doc.dispatchEvent(new dom.window.CustomEvent('knowledge-menu-open', { detail: {} })); assert.equal(menu.hidden, true);
    const enter = new dom.window.Event('pointerenter'); Object.defineProperty(enter, 'pointerType', { value: 'mouse' });
    toggle.dispatchEvent(enter); await new Promise(resolve => setTimeout(resolve, 200)); assert.equal(menu.hidden, false);
    toggle.dispatchEvent(new dom.window.Event('pointerleave'));
    menu.dispatchEvent(new dom.window.Event('pointerenter'));
    await new Promise(resolve => setTimeout(resolve, 270)); assert.equal(menu.hidden, false);
    menu.dispatchEvent(new dom.window.Event('pointerleave'));
    doc.activeElement.blur(); await new Promise(resolve => setTimeout(resolve, 270)); assert.equal(menu.hidden, true);
    dom.window.matchMedia = () => ({ matches: true });
    toggle.dispatchEvent(new dom.window.MouseEvent('click', { detail: 1 })); assert.equal(menu.hidden, false); assert.equal(created, 1);
  } finally { dom.window.close(); }
});
