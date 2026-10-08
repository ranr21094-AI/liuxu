const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const load = file => import(pathToFileURL(path.join(__dirname, '../public/js/knowledge/', file)).href);
const treeModel = () => ({ version: 1, nodes: [{ id: 'r', text: '中心主题', x: 100, y: 100 }, { id: 'a', text: '分支 A', x: 200, y: 100 }, { id: 'b', text: '分支 B', x: 200, y: 200 }, { id: 'c', text: '后代 C', x: 300, y: 100 }], edges: [{ source: 'r', target: 'a' }, { source: 'r', target: 'b' }, { source: 'a', target: 'c' }], canvas: { width: 1200, height: 700 } });

test('tree moves retain IDs, reorder siblings, reject cycles, and delete whole branches', async () => {
  const { inspectTree, moveBranch, removeBranch, addBranch } = await load('mindmap-model.js');
  const model = treeModel();
  assert.equal(moveBranch(model, 'a', 'c'), false);
  assert.equal(moveBranch(model, 'r', 'a'), false);
  assert.equal(moveBranch(model, 'b', 'r', { beforeId: 'a', side: 'right' }), true);
  assert.deepEqual(inspectTree(model).children.get('r'), ['b', 'a']);
  assert.equal(moveBranch(model, 'c', 'b'), true);
  assert.equal(inspectTree(model).parents.get('c'), 'b');
  const sibling = addBranch(model, 'c', true);
  assert.deepEqual(inspectTree(model).children.get('b'), ['c', sibling]);
  assert.equal(removeBranch(model, 'b'), 'r');
  assert.deepEqual(model.nodes.map(n => n.id), ['r', 'a']);
});

test('layout wraps Chinese, separates branches, and expanded export includes folded descendants', async () => {
  const { layoutMindmap, nodeText } = await load('mindmap-layout.js');
  const model = treeModel(); model.nodes[1].collapsed = true;
  assert(nodeText('中文长主题'.repeat(20)).lines.length > 1);
  const folded = layoutMindmap(model);
  assert.equal(folded.positions.has('c'), false);
  assert(folded.positions.get('a').x > 0); assert(folded.positions.get('b').x < 0);
  assert.equal(layoutMindmap(model, { expanded: true }).positions.size, 4);
  assert.equal(model.nodes[1].collapsed, true);
  for (let i = model.nodes.length; i < 500; i++) {
    model.nodes.push({ id: `n${i}`, text: `中文主题 ${i}`, x: 0, y: 0 });
    model.edges.push({ source: 'r', target: `n${i}` });
  }
  const full = layoutMindmap(model, { expanded: true });
  assert.equal(full.positions.size, 500);
  for (const side of [-1, 1]) {
    const boxes = [...full.positions].filter(([id, box]) => model.edges.some(e => e.source === 'r' && e.target === id) && Math.sign(box.x) === side).map(([, p]) => p).sort((a, b) => a.y - b.y);
    for (let i = 1; i < boxes.length; i++) assert(boxes[i].y - boxes[i - 1].y >= (boxes[i].height + boxes[i - 1].height) / 2);
  }
});

async function fixture({ model = treeModel(), confirmDelete = async () => true } = {}) {
  const dom = new JSDOM('<div class="mindmap-editor"><button data-mindmap-action="child"></button><button data-mindmap-action="undo"></button><button data-mindmap-action="collapse"></button><div class="mindmap-stage"><svg></svg></div><span data-mindmap-status></span></div>', { pretendToBeVisual: true });
  const canvas = dom.window.document.querySelector('svg');
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 450 });
  let enabled = true, changes = [];
  const { createMindmapEditor } = await load('mindmap.js');
  const ui = createMindmapEditor({ canvas, initial: model, canEdit: () => enabled, onChange: text => changes.push(JSON.parse(text)), confirmDelete });
  const key = (target, key, extra = {}) => target.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra }));
  const pointer = (target, type, x, y, extra = {}) => {
    const event = new dom.window.MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true });
    Object.defineProperties(event, { pointerId: { value: extra.pointerId || 1 }, pointerType: { value: extra.pointerType || 'mouse' } });
    target.dispatchEvent(event);
  };
  const point = id => {
    const layer = canvas.firstElementChild.getAttribute('transform').match(/translate\(([-.\d]+) ([-.\d]+)\) scale\(([-.\d]+)\)/);
    const node = canvas.querySelector(`[data-node-id="${id}"]`).getAttribute('transform').match(/translate\(([-.\d]+) ([-.\d]+)\)/);
    return { x: Number(layer[1]) + Number(node[1]) * Number(layer[3]), y: Number(layer[2]) + Number(node[2]) * Number(layer[3]) };
  };
  return { dom, canvas, ui, changes, key, pointer, point, lock: () => { enabled = false; ui.refreshAccess(); }, close: () => { ui.destroy(); dom.window.close(); } };
}

test('inline editing supports composition, mirrors drafts, commits once and undo/redo; keyboard adds nodes', async () => {
  const f = await fixture();
  try {
    f.ui.select('a'); f.ui.rename(); const input = f.dom.window.document.querySelector('textarea');
    input.value = '输入法中文\n多行'; input.dispatchEvent(new f.dom.window.Event('input'));
    assert.equal(f.changes.at(-1).nodes.find(n => n.id === 'a').text, input.value);
    input.dispatchEvent(new f.dom.window.Event('compositionstart')); f.key(input, 'Enter'); assert(input.isConnected);
    input.dispatchEvent(new f.dom.window.Event('compositionend')); f.key(input, 'Enter'); assert(!input.isConnected);
    f.ui.undo(); assert.equal(JSON.parse(f.ui.getContent()).nodes.find(n => n.id === 'a').text, '分支 A');
    f.ui.redo(); assert.equal(JSON.parse(f.ui.getContent()).nodes.find(n => n.id === 'a').text, '输入法中文\n多行');
    f.key(f.canvas, 'Tab'); f.ui.commitEdit(); assert.equal(JSON.parse(f.ui.getContent()).nodes.length, 5);
    f.key(f.canvas, 'Enter'); f.ui.commitEdit(); assert.equal(JSON.parse(f.ui.getContent()).nodes.length, 6);
    f.key(f.canvas, 'z', { metaKey: true }); assert.equal(JSON.parse(f.ui.getContent()).nodes.length, 5);
    f.key(f.canvas, 'z', { ctrlKey: true, shiftKey: true }); assert.equal(JSON.parse(f.ui.getContent()).nodes.length, 6);
    f.ui.select('r'); await f.ui.deleteNode(); assert.equal(JSON.parse(f.ui.getContent()).nodes.length, 6);
  } finally { f.close(); }
});

test('zoom-aware drag reparents branches, pan and zoom never save; cancelled drags never move', async () => {
  const f = await fixture();
  try {
    f.canvas.dispatchEvent(new f.dom.window.WheelEvent('wheel', { deltaY: -80, clientX: 400, clientY: 225, cancelable: true }));
    assert.equal(f.changes.length, 0);
    const a = f.point('a'), b = f.point('b');
    f.pointer(f.canvas.querySelector('[data-node-id="a"]'), 'pointerdown', a.x, a.y);
    f.pointer(f.canvas, 'pointermove', b.x, b.y);
    f.pointer(f.canvas, 'pointerup', b.x, b.y);
    assert.equal(JSON.parse(f.ui.getContent()).edges.find(e => e.target === 'a').source, 'b');
    assert.equal(f.changes.length, 1);
    const before = f.ui.getContent(), movedA = f.point('a');
    f.pointer(f.canvas.querySelector('[data-node-id="a"]'), 'pointerdown', movedA.x, movedA.y);
    f.pointer(f.canvas, 'pointermove', 10, 10); f.pointer(f.canvas, 'pointercancel', 10, 10);
    assert.equal(f.ui.getContent(), before);
    f.pointer(f.canvas, 'pointerdown', 15, 15); f.pointer(f.canvas, 'pointermove', 40, 40); f.pointer(f.canvas, 'pointerup', 40, 40);
    assert.equal(f.changes.length, 1);
  } finally { f.close(); }
});

test('subtree deletion is confirmed and stale confirmations cannot delete later edits', async () => {
  let resolve;
  const f = await fixture({ confirmDelete: () => new Promise(r => { resolve = r; }) });
  try {
    f.ui.select('a'); const deletion = f.ui.deleteNode();
    f.ui.addNode(); f.ui.commitEdit(); resolve(true); await deletion;
    assert(JSON.parse(f.ui.getContent()).nodes.some(n => n.id === 'a'));
    f.ui.select('a'); const next = f.ui.deleteNode(); resolve(true); await next;
    assert(!JSON.parse(f.ui.getContent()).nodes.some(n => n.id === 'c'));
    f.ui.undo(); assert(JSON.parse(f.ui.getContent()).nodes.some(n => n.id === 'c'));
  } finally { f.close(); }
});

test('Escape restores mirrored text drafts and touch pinch/pan do not save; long press moves a branch', async () => {
  const f = await fixture();
  try {
    f.ui.select('a'); f.ui.rename(); const input = f.dom.window.document.querySelector('textarea');
    input.value = '取消的草稿'; input.dispatchEvent(new f.dom.window.Event('input')); f.key(input, 'Escape');
    assert.equal(f.changes.at(-1).nodes.find(n => n.id === 'a').text, '分支 A');
    const count = f.changes.length;
    f.pointer(f.canvas, 'pointerdown', 200, 150, { pointerId: 1, pointerType: 'touch' });
    f.pointer(f.canvas, 'pointerdown', 300, 150, { pointerId: 2, pointerType: 'touch' });
    f.pointer(f.canvas, 'pointermove', 400, 180, { pointerId: 2, pointerType: 'touch' });
    f.pointer(f.canvas, 'pointerup', 400, 180, { pointerId: 2, pointerType: 'touch' });
    f.pointer(f.canvas, 'pointerup', 200, 150, { pointerId: 1, pointerType: 'touch' });
    assert.equal(f.changes.length, count);
    const a = f.point('a'), b = f.point('b');
    f.pointer(f.canvas.querySelector('[data-node-id="a"]'), 'pointerdown', a.x, a.y, { pointerType: 'touch' });
    await new Promise(resolve => setTimeout(resolve, 430));
    f.pointer(f.canvas, 'pointermove', b.x, b.y, { pointerType: 'touch' });
    f.pointer(f.canvas, 'pointerup', b.x, b.y, { pointerType: 'touch' });
    assert.equal(JSON.parse(f.ui.getContent()).edges.find(e => e.target === 'a').source, 'b');
  } finally { f.close(); }
});

test('non-tree legacy maps remain unchanged and read-only; locking preserves inline draft and destroy removes handlers', async () => {
  const legacy = treeModel(); legacy.edges.push({ source: 'b', target: 'c' });
  const f = await fixture({ model: legacy });
  try { f.ui.addNode(); f.ui.rename(); assert.equal(f.ui.getContent(), JSON.stringify(legacy)); assert.equal(f.changes.length, 0); assert.match(f.dom.window.document.querySelector('[data-mindmap-status]').textContent, /只读/); } finally { f.close(); }
  const second = await fixture();
  second.ui.rename(); const input = second.dom.window.document.querySelector('textarea'); input.value = '尚未保存'; input.dispatchEvent(new second.dom.window.Event('input'));
  second.lock(); assert.equal(input.readOnly, true); assert.equal(JSON.parse(second.ui.getContent()).nodes[0].text, '尚未保存');
  const count = second.changes.length; second.ui.addNode(); assert.equal(second.changes.length, count);
  second.ui.destroy(); second.key(second.canvas, 'Tab'); assert.equal(second.changes.length, count); assert.equal(second.dom.window.document.querySelector('textarea'), null); second.dom.window.close();
});
