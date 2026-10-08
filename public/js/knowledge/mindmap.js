import { emptyMindmap, cloneMap, inspectTree, descendants, addBranch, moveBranch, removeBranch, sideOf } from './mindmap-model.js';
import { layoutMindmap } from './mindmap-layout.js';
import { drawMap, svgElement } from './mindmap-view.js';
export { emptyMindmap } from './mindmap-model.js';

export function createMindmapEditor({ canvas, initial, onChange, canEdit = () => true, confirmDelete, onError = () => {} }) {
  const doc = canvas.ownerDocument, win = doc.defaultView, host = canvas.closest('.mindmap-editor'), stage = canvas.parentElement;
  let model = cloneMap(initial || emptyMindmap()), selected = inspectTree(model).rootId, destroyed = false;
  let layout, layer, edit = null, undo = [], redo = [], gesture = null, holdTimer, composing = false, suppressClick = false, deletePending = false;
  let scale = 1, pan = { x: 0, y: 0 }, size = { width: 0, height: 0 }, pointers = new Map(), pinch = null;
  const disposers = [];
  const listen = (target, name, fn, options) => { target.addEventListener(name, fn, options); disposers.push(() => target.removeEventListener(name, fn, options)); };
  const writable = () => !destroyed && inspectTree(model).valid && canEdit();
  const colors = () => {
    const styles = win.getComputedStyle(host || canvas), value = (key, fallback) => styles.getPropertyValue(key).trim() || fallback;
    return { surface: value('--surface', '#fff'), root: value('--accent-soft', '#e8ede7'), text: value('--text', '#20211f'), line: value('--line-strong', '#a8afa7'), accent: value('--accent', '#42684c'), font: styles.fontFamily || 'sans-serif' };
  };
  const bounds = () => { const r = canvas.getBoundingClientRect(); return { width: r.width || 800, height: r.height || 450 }; };
  function controls() {
    const tree = inspectTree(model), allowed = writable(), node = tree.byId.get(selected);
    host?.querySelectorAll('[data-mindmap-action]').forEach(button => {
      const action = button.dataset.mindmapAction;
      button.disabled = ['child', 'sibling', 'edit', 'delete', 'collapse', 'expand', 'undo', 'redo'].includes(action) && !allowed;
      if (action === 'delete' || action === 'sibling') button.disabled ||= selected === tree.rootId || !node;
      if (action === 'undo') button.disabled ||= !undo.length;
      if (action === 'redo') button.disabled ||= !redo.length;
      if (action === 'collapse') { button.disabled ||= !(tree.children.get(selected) || []).length; button.textContent = node?.collapsed ? '展开分支' : '折叠分支'; }
      if (action === 'child' || action === 'sibling') button.disabled ||= model.nodes.length >= 500;
    });
    const status = host?.querySelector('[data-mindmap-status]');
    if (status) status.textContent = tree.valid ? `${Math.round(scale * 100)}% · ${model.nodes.length} 个节点${!canEdit() ? ' · 只读' : ''}${gesture?.drop ? ' · 放开以移动分支' : ''}` : `旧导图只读：${tree.reason}。原始内容已保留。`;
  }
  function draw({ expanded = false, drag = null } = {}) {
    if (destroyed) return;
    layout = layoutMindmap(model, { expanded });
    const next = bounds();
    if (!size.width) pan = { x: next.width / 2, y: next.height / 2 };
    else { pan.x += (next.width - size.width) / 2; pan.y += (next.height - size.height) / 2; }
    size = next; canvas.setAttribute('viewBox', `0 0 ${size.width} ${size.height}`);
    layer = drawMap(doc, model, layout, { colors: colors(), selected, drop: gesture?.drop, drag });
    layer.setAttribute('transform', `translate(${pan.x} ${pan.y}) scale(${scale})`);
    canvas.replaceChildren(layer); controls(); positionEdit();
  }
  function emit() {
    const full = layoutMindmap(model, { expanded: true });
    model.rootId = full.tree.rootId;
    for (const node of model.nodes) { const p = full.positions.get(node.id); if (p) { node.x = p.x; node.y = p.y; } }
    model.canvas = { width: Math.ceil(full.bounds.width), height: Math.ceil(full.bounds.height) };
    onChange?.(JSON.stringify(model));
  }
  function mutate(fn) {
    if (!writable()) return false;
    const before = JSON.stringify(model);
    if (fn() === false || JSON.stringify(model) === before) return false;
    undo.push(before); if (undo.length > 100) undo.shift(); redo = []; draw(); emit(); reveal(); return true;
  }
  function paintSelection(id) {
    selected = id; const palette = colors();
    canvas.querySelectorAll('[data-node-id]').forEach(group => {
      const active = group.dataset.nodeId === selected;
      group.classList.toggle('selected', active); group.setAttribute('aria-pressed', String(active));
      const rect = group.querySelector('rect'); rect.setAttribute('stroke', active ? palette.accent : palette.line); rect.setAttribute('stroke-width', active ? '2.5' : '1.5');
    }); controls();
  }
  function select(id) { if (id !== selected && model.nodes.some(n => n.id === id)) { commitEdit(); paintSelection(id); } }
  function fit() {
    const b = layout.bounds; scale = Math.min(1.25, Math.max(.05, Math.min((size.width - 32) / b.width, (size.height - 32) / b.height)));
    pan = { x: size.width / 2 - (b.x + b.width / 2) * scale, y: size.height / 2 - (b.y + b.height / 2) * scale }; draw();
  }
  function zoom(factor, point = { x: size.width / 2, y: size.height / 2 }) {
    const next = Math.max(.05, Math.min(4, scale * factor)), ratio = next / scale;
    pan = { x: point.x - (point.x - pan.x) * ratio, y: point.y - (point.y - pan.y) * ratio }; scale = next; draw();
  }
  function local(event) { const r = canvas.getBoundingClientRect(); return { x: event.clientX - r.left, y: event.clientY - r.top }; }
  function world(point) { return { x: (point.x - pan.x) / scale, y: (point.y - pan.y) / scale }; }
  function reveal() {
    const p = layout.positions.get(selected); if (!p) return;
    const x = p.x * scale + pan.x, y = p.y * scale + pan.y;
    if (x < 40 || x > size.width - 40) pan.x = size.width / 2 - p.x * scale;
    if (y < 30 || y > size.height - 30) pan.y = size.height / 2 - p.y * scale;
    draw();
  }
  function positionEdit() {
    if (!edit) return;
    const p = layout.positions.get(edit.id); if (!p) return;
    Object.assign(edit.input.style, { left: `${p.x * scale + pan.x - Math.max(140, p.width * scale) / 2}px`, top: `${p.y * scale + pan.y - Math.max(44, p.height * scale) / 2}px`, width: `${Math.max(140, p.width * scale)}px`, height: `${Math.max(44, p.height * scale)}px`, fontSize: `${Math.max(14, 14 * scale)}px` });
  }
  function commitEdit(cancel = false, restoreDraft = true) {
    if (!edit || (!cancel && !writable())) return;
    const current = edit; edit = null; composing = false;
    current.input.remove();
    if (cancel && restoreDraft && writable() && current.input.value !== model.nodes.find(n => n.id === current.id)?.text) onChange?.(JSON.stringify(model));
    if (!cancel && writable()) { const node = model.nodes.find(n => n.id === current.id), text = current.input.value.trim().slice(0, 500); if (node && text && text !== node.text) mutate(() => { node.text = text; }); }
    canvas.focus();
  }
  function rename() {
    if (!writable()) return;
    commitEdit(); const node = model.nodes.find(n => n.id === selected); if (!node) return;
    const input = doc.createElement('textarea'); input.className = 'mindmap-inline-input'; input.value = node.text; input.maxLength = 500; input.setAttribute('aria-label', '编辑节点文字');
    edit = { id: selected, input }; stage.append(input); positionEdit(); input.focus(); input.select();
    input.addEventListener('input', () => { if (writable()) onChange?.(draftContent()); });
    input.addEventListener('compositionstart', () => { composing = true; }); input.addEventListener('compositionend', () => { composing = false; });
    input.addEventListener('keydown', event => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 's') event.stopPropagation(); if (composing || event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Escape') { event.preventDefault(); commitEdit(true); }
      if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); commitEdit(); }
      if (event.key === 'Tab') { event.preventDefault(); commitEdit(); }
    });
    input.addEventListener('blur', () => { if (edit?.input === input) commitEdit(); });
  }
  function addNode(sibling = false) {
    commitEdit(); if (mutate(() => { const id = addBranch(model, selected, sibling); if (!id) return false; selected = id; })) rename();
  }
  async function deleteNode() {
    commitEdit(); const tree = inspectTree(model), id = selected;
    if (!writable() || id === tree.rootId || deletePending) return;
    const count = descendants(tree, id).size, original = JSON.stringify(model);
    if (count > 1) {
      deletePending = true; let approved = false;
      try { approved = await confirmDelete?.({ title: '删除分支', message: `将删除“${tree.byId.get(id).text}”及其 ${count - 1} 个后代节点，可通过撤销找回。`, confirmText: '删除分支' }); }
      finally { deletePending = false; }
      if (!approved || !writable() || JSON.stringify(model) !== original || selected !== id) return;
    }
    mutate(() => { selected = removeBranch(model, id) || selected; });
  }
  function history(back) {
    commitEdit(); if (!writable()) return;
    const from = back ? undo : redo, to = back ? redo : undo; if (!from.length) return;
    to.push(JSON.stringify(model)); model = JSON.parse(from.pop());
    if (!model.nodes.some(n => n.id === selected)) selected = inspectTree(model).rootId;
    draw(); emit();
  }
  function toggle(id = selected) { commitEdit(); mutate(() => { const node = model.nodes.find(n => n.id === id); if (!node || !inspectTree(model).children.get(id)?.length) return false; node.collapsed = !node.collapsed; }); }
  function target(point, id) {
    if (point.x < 0 || point.y < 0 || point.x > size.width || point.y > size.height) return null;
    const p = world(point), tree = inspectTree(model), blocked = descendants(tree, id);
    for (const [nodeId, box] of layout.positions) {
      if (Math.abs(p.x - box.x) > box.width / 2 + 15 || Math.abs(p.y - box.y) > box.height / 2 + 12) continue;
      if (blocked.has(nodeId)) return null;
      if (nodeId !== tree.rootId && Math.abs(p.y - box.y) > box.height / 2 - 7) {
        const parentId = tree.parents.get(nodeId), siblings = tree.children.get(parentId), index = siblings.indexOf(nodeId);
        if (blocked.has(parentId)) return null;
        return { parentId, beforeId: p.y < box.y ? nodeId : siblings[index + 1] || null, side: sideOf(tree, nodeId) };
      }
      return { parentId: nodeId, side: p.x < 0 ? 'left' : 'right' };
    }
    const side = p.x < 0 ? 'left' : 'right';
    const siblings = tree.children.get(tree.rootId).filter(n => n !== id && sideOf(tree, n) === side);
    return { parentId: tree.rootId, side, beforeId: siblings.find(n => (layout.positions.get(n)?.y ?? Infinity) > p.y) || null };
  }
  listen(canvas, 'pointerdown', event => {
    if (event.button && event.pointerType !== 'touch') return;
    commitEdit(); canvas.focus(); const point = local(event); pointers.set(event.pointerId, point);
    if (pointers.size === 2) {
      clearTimeout(holdTimer); gesture = null; const [a, b] = [...pointers.values()]; pinch = { distance: Math.hypot(a.x - b.x, a.y - b.y), scale, center: world({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }) }; draw(); return;
    }
    if (event.target.closest?.('[data-collapse-id]')) return;
    const id = event.target.closest?.('[data-node-id]')?.dataset.nodeId;
    if (id && id !== selected) paintSelection(id);
    const draggable = id && writable() && id !== layout.tree.rootId;
    gesture = { id, start: point, pan: { ...pan }, type: draggable && event.pointerType !== 'touch' ? 'node' : 'pan', moved: false, touch: event.pointerType === 'touch', pointerId: event.pointerId };
    if (draggable && gesture.touch) holdTimer = win.setTimeout(() => { if (gesture && !gesture.moved) { gesture.type = 'node'; gesture.held = true; } }, 400);
  });
  listen(canvas, 'pointermove', event => {
    if (!pointers.has(event.pointerId)) return;
    const point = local(event); pointers.set(event.pointerId, point);
    if (pinch && pointers.size >= 2) {
      try { canvas.setPointerCapture(event.pointerId); } catch {}
      const [a, b] = [...pointers.values()], midpoint = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      scale = Math.max(.05, Math.min(4, pinch.scale * Math.hypot(a.x - b.x, a.y - b.y) / Math.max(1, pinch.distance)));
      pan = { x: midpoint.x - pinch.center.x * scale, y: midpoint.y - pinch.center.y * scale }; draw(); return;
    }
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const dx = point.x - gesture.start.x, dy = point.y - gesture.start.y;
    if (!gesture.moved && Math.hypot(dx, dy) < 5) return;
    gesture.moved = true; clearTimeout(holdTimer);
    try { canvas.setPointerCapture(event.pointerId); } catch {}
    if (gesture.type === 'node' && writable()) {
      gesture.drop = target(point, gesture.id); draw({ drag: { ids: descendants(layout.tree, gesture.id), dx: dx / scale, dy: dy / scale } });
    } else { pan = { x: gesture.pan.x + dx, y: gesture.pan.y + dy }; draw(); }
  });
  function endPointer(event, cancelled = false) {
    clearTimeout(holdTimer); pointers.delete(event.pointerId);
    if (pinch) { if (!pointers.size) pinch = null; gesture = null; suppressClick = true; draw(); return; }
    const current = gesture; gesture = null;
    if (current?.moved) {
      suppressClick = true;
      if (!cancelled && current.type === 'node' && current.drop) mutate(() => moveBranch(model, current.id, current.drop.parentId, current.drop));
    }
    if (current?.moved || cancelled) draw(); else controls();
  }
  listen(canvas, 'pointerup', event => endPointer(event)); listen(canvas, 'pointercancel', event => endPointer(event, true));
  listen(doc, 'pointerup', event => { if (pointers.has(event.pointerId) && !canvas.contains(event.target)) endPointer(event, true); });
  listen(win, 'blur', () => { clearTimeout(holdTimer); pointers.clear(); pinch = null; gesture = null; draw(); });
  listen(canvas, 'click', event => {
    if (suppressClick) { suppressClick = false; return; }
    const id = event.target.closest?.('[data-collapse-id]')?.dataset.collapseId;
    if (id) toggle(id); else { const node = event.target.closest?.('[data-node-id]'); if (node) select(node.dataset.nodeId); }
  });
  listen(canvas, 'dblclick', event => { const node = event.target.closest?.('[data-node-id]'); if (node && !event.target.closest?.('[data-collapse-id]')) { selected = node.dataset.nodeId; rename(); } });
  listen(canvas, 'wheel', event => { event.preventDefault(); zoom(Math.exp(-event.deltaY * .0015), local(event)); }, { passive: false });
  listen(canvas, 'keydown', event => {
    if (event.isComposing || !writable()) return;
    const mod = event.metaKey || event.ctrlKey;
    if (mod && event.key.toLowerCase() === 'z') { event.preventDefault(); history(!event.shiftKey); }
    else if (mod && event.key.toLowerCase() === 'y') { event.preventDefault(); history(false); }
    else if (!mod && !event.altKey && ['Tab', 'Enter', 'F2', 'Delete', 'Backspace'].includes(event.key)) {
      event.preventDefault(); if (event.key === 'Tab') addNode(); else if (event.key === 'Enter') addNode(true); else if (event.key === 'F2') rename(); else deleteNode();
    }
  });
  async function exportPng() {
    commitEdit(); const full = layoutMindmap(model, { expanded: true }), b = full.bounds;
    const svg = svgElement(doc, 'svg', { xmlns: 'http://www.w3.org/2000/svg', width: b.width, height: b.height, viewBox: `${b.x} ${b.y} ${b.width} ${b.height}` });
    const palette = colors(); svg.append(svgElement(doc, 'rect', { x: b.x, y: b.y, width: b.width, height: b.height, fill: palette.surface }), drawMap(doc, model, full, { colors: palette, interactive: false }));
    const xml = new win.XMLSerializer().serializeToString(svg), image = new win.Image();
    // Bound Canvas area for deep/large maps while retaining the entire map.
    const ratio = Math.min(2, 16384 / b.width, 16384 / b.height, Math.sqrt(32000000 / (b.width * b.height)));
    await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = () => reject(new Error('导图图像生成失败')); image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`; });
    if (destroyed) return;
    const out = doc.createElement('canvas'); out.width = Math.ceil(b.width * ratio); out.height = Math.ceil(b.height * ratio); out.getContext('2d').drawImage(image, 0, 0, out.width, out.height);
    const blob = await new Promise(resolve => out.toBlob(resolve, 'image/png')); if (!blob || destroyed) return;
    const url = win.URL.createObjectURL(blob), link = doc.createElement('a'); link.download = '思维导图.png'; link.href = url; link.click(); win.setTimeout(() => win.URL.revokeObjectURL(url), 1000); out.width = out.height = 0;
  }
  const actions = { child: () => addNode(), sibling: () => addNode(true), edit: rename, delete: deleteNode, collapse: () => toggle(), expand: () => { commitEdit(); mutate(() => { model.nodes.forEach(n => { n.collapsed = false; }); }); }, undo: () => history(true), redo: () => history(false), 'zoom-in': () => zoom(1.2), 'zoom-out': () => zoom(1 / 1.2), fit, export: () => exportPng().catch(error => onError(error.message)) };
  if (host) listen(host, 'click', event => { const button = event.target.closest('[data-mindmap-action]'); if (button && !button.disabled) actions[button.dataset.mindmapAction]?.(); });
  let visibleLayout = canvas.getBoundingClientRect().width > 0;
  const observer = win.ResizeObserver ? new win.ResizeObserver(() => { draw(); if (!visibleLayout && canvas.getBoundingClientRect().width > 0) { visibleLayout = true; fit(); } }) : null; observer?.observe(stage);
  const themeObserver = win.MutationObserver ? new win.MutationObserver(() => draw()) : null; themeObserver?.observe(doc.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
  canvas.setAttribute('tabindex', '0'); draw(); fit();
  function draftContent() { const draft = cloneMap(model); if (edit) { const node = draft.nodes.find(n => n.id === edit.id); if (node && edit.input.value.trim()) node.text = edit.input.value.trim().slice(0, 500); } return JSON.stringify(draft); }
  return { addNode, rename, deleteNode, exportPng, commitEdit, getContent: draftContent, select, undo: () => history(true), redo: () => history(false), refreshAccess() { if (edit) edit.input.readOnly = !canEdit(); draw(); }, destroy() { commitEdit(true, false); destroyed = true; clearTimeout(holdTimer); observer?.disconnect(); themeObserver?.disconnect(); disposers.forEach(dispose => dispose()); pointers.clear(); canvas.replaceChildren(); } };
}
