import { descendants } from './mindmap-model.js';
const NS = 'http://www.w3.org/2000/svg';
export function svgElement(doc, name, attrs = {}, text) {
  const el = doc.createElementNS(NS, name);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
  if (text !== undefined) el.textContent = text;
  return el;
}
export function drawMap(doc, model, layout, { colors, selected = '', drop, drag, interactive = true } = {}) {
  const layer = svgElement(doc, 'g');
  const at = id => {
    const p = layout.positions.get(id);
    return p && drag?.ids.has(id) ? { ...p, x: p.x + drag.dx, y: p.y + drag.dy } : p;
  };
  for (const edge of model.edges || []) {
    const a = at(edge.source), b = at(edge.target);
    if (!a || !b) continue;
    const sign = b.x >= a.x ? 1 : -1, x1 = a.x + sign * a.width / 2, x2 = b.x - sign * b.width / 2, mid = (x1 + x2) / 2;
    layer.append(svgElement(doc, 'path', { d: `M ${x1} ${a.y} C ${mid} ${a.y}, ${mid} ${b.y}, ${x2} ${b.y}`, fill: 'none', stroke: colors.line, 'stroke-width': 2 }));
  }
  for (const node of model.nodes || []) {
    const p = at(node.id); if (!p) continue;
    const group = svgElement(doc, 'g', { transform: `translate(${p.x} ${p.y})`, 'data-node-id': node.id, role: 'button', 'aria-label': `${node.text || '未命名'}${node.collapsed ? '，已折叠' : ''}`, 'aria-pressed': node.id === selected, class: `mindmap-node${node.id === selected ? ' selected' : ''}` });
    const highlight = drop?.parentId === node.id;
    group.append(svgElement(doc, 'rect', { x: -p.width / 2, y: -p.height / 2, width: p.width, height: p.height, rx: node.id === layout.tree.rootId ? 12 : 8, fill: node.id === layout.tree.rootId ? colors.root : colors.surface, stroke: highlight || node.id === selected ? colors.accent : colors.line, 'stroke-width': highlight || node.id === selected ? 2.5 : 1.5, ...(highlight ? { 'stroke-dasharray': '5 3' } : {}) }));
    const text = svgElement(doc, 'text', { 'text-anchor': 'middle', fill: colors.text, 'font-size': 14, 'font-family': colors.font, 'pointer-events': 'none' });
    // Individual baselines avoid dependence on CSS in exported SVGs.
    text.replaceChildren(...p.lines.map((line, i) => svgElement(doc, 'tspan', { x: 0, y: -((p.lines.length - 1) * 22) / 2 + i * 22 + 5 }, line)));
    group.append(text);
    if (interactive && layout.tree.valid && (layout.tree.children.get(node.id) || []).length) {
      const count = descendants(layout.tree, node.id).size - 1;
      const toggle = svgElement(doc, 'g', { 'data-collapse-id': node.id, class: 'mindmap-collapse', transform: `translate(${p.width / 2 + 11} 0)`, role: 'button', 'aria-label': node.collapsed ? `展开 ${count} 个节点` : '折叠分支' });
      toggle.append(svgElement(doc, 'circle', { r: 11, fill: colors.surface, stroke: colors.line }));
      toggle.append(svgElement(doc, 'text', { 'text-anchor': 'middle', y: 4, fill: colors.text, 'font-size': 11, 'pointer-events': 'none' }, node.collapsed ? String(count) : '−'));
      group.append(toggle);
    }
    layer.append(group);
  }
  if (drop?.beforeId) {
    const p = at(drop.beforeId);
    if (p) layer.append(svgElement(doc, 'path', { d: `M ${p.x - p.width / 2} ${p.y - p.height / 2 - 8} h ${p.width}`, stroke: colors.accent, 'stroke-width': 3 }));
  }
  return layer;
}
