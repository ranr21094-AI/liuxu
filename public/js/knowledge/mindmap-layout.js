import { inspectTree, sideOf } from './mindmap-model.js';
export function nodeText(text, width = 232) {
  const lines = [];
  for (const paragraph of String(text || '未命名').split('\n')) {
    let line = '', size = 0;
    for (const char of paragraph) {
      const advance = /[\u0000-\u00ff]/.test(char) ? 7.5 : 14;
      if (size + advance > width && line) { lines.push(line); line = ''; size = 0; }
      line += char; size += advance;
    }
    lines.push(line);
  }
  const max = Math.max(...lines.map(line => [...line].reduce((n, c) => n + (/[\u0000-\u00ff]/.test(c) ? 7.5 : 14), 0)));
  return { lines, width: Math.max(120, Math.min(260, max + 28)), height: Math.max(44, lines.length * 22 + 22) };
}
export function layoutMindmap(model, { expanded = false } = {}) {
  const tree = inspectTree(model), positions = new Map();
  if (!tree.valid) {
    for (const node of model.nodes || []) positions.set(node.id, { ...nodeText(node.text), x: Number(node.x) || 0, y: Number(node.y) || 0 });
  } else {
    const sizes = new Map(model.nodes.map(node => [node.id, nodeText(node.text)]));
    const visibleChildren = id => !expanded && tree.byId.get(id).collapsed ? [] : tree.children.get(id);
    const spans = new Map();
    const span = id => { if (!spans.has(id)) spans.set(id, Math.max(sizes.get(id).height, visibleChildren(id).reduce((sum, child) => sum + span(child), 0) + Math.max(0, visibleChildren(id).length - 1) * 22)); return spans.get(id); };
    function place(id, x, y, sign) {
      const size = sizes.get(id); positions.set(id, { ...size, x, y });
      const children = visibleChildren(id), total = children.reduce((n, child) => n + span(child), 0) + Math.max(0, children.length - 1) * 22;
      let cursor = y - total / 2;
      for (const child of children) { const height = span(child); place(child, x + sign * (size.width / 2 + 64 + sizes.get(child).width / 2), cursor + height / 2, sign); cursor += height + 22; }
    }
    const root = sizes.get(tree.rootId); positions.set(tree.rootId, { ...root, x: 0, y: 0 });
    for (const side of ['left', 'right']) {
      const children = visibleChildren(tree.rootId).filter(id => sideOf(tree, id) === side);
      const total = children.reduce((n, child) => n + span(child), 0) + Math.max(0, children.length - 1) * 22;
      let cursor = -total / 2;
      for (const child of children) { const height = span(child), sign = side === 'left' ? -1 : 1; place(child, sign * (root.width / 2 + 64 + sizes.get(child).width / 2), cursor + height / 2, sign); cursor += height + 22; }
    }
  }
  const values = [...positions.values()];
  const minX = Math.min(...values.map(p => p.x - p.width / 2), 0) - 40, minY = Math.min(...values.map(p => p.y - p.height / 2), 0) - 40;
  const maxX = Math.max(...values.map(p => p.x + p.width / 2), 0) + 40, maxY = Math.max(...values.map(p => p.y + p.height / 2), 0) + 40;
  return { tree, positions, bounds: { x: minX, y: minY, width: maxX - minX, height: maxY - minY } };
}
