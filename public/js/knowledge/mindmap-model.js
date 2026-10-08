// Tree operations do not touch the DOM; edges retain sibling order on disk.
export const MAX_NODES = 500;
export const cloneMap = model => JSON.parse(JSON.stringify(model));
export function emptyMindmap() {
  return { version: 1, rootId: 'node-1', nodes: [{ id: 'node-1', text: '中心主题', x: 0, y: 0 }], edges: [], canvas: { width: 1200, height: 700 } };
}
export function inspectTree(model) {
  const nodes = model?.nodes || [], edges = model?.edges || [];
  const byId = new Map(nodes.map(n => [n.id, n]));
  const children = new Map(nodes.map(n => [n.id, []])), parents = new Map();
  let reason = '';
  if (!nodes.length || byId.size !== nodes.length) reason = '节点数据无效';
  for (const edge of edges) {
    if (!byId.has(edge.source) || !byId.has(edge.target) || edge.source === edge.target) { reason = '连线无效或存在循环'; continue; }
    if (parents.has(edge.target)) reason = '同一节点有多个父节点';
    parents.set(edge.target, edge.source); children.get(edge.source).push(edge.target);
  }
  const roots = nodes.filter(n => !parents.has(n.id));
  const rootId = model?.rootId || roots[0]?.id || nodes[0]?.id;
  if (roots.length !== 1 || roots[0]?.id !== rootId) reason ||= '存在循环或孤立节点';
  const visited = new Set();
  function visit(id) {
    if (visited.has(id)) { reason ||= '存在循环'; return; }
    visited.add(id); (children.get(id) || []).forEach(visit);
  }
  if (byId.has(rootId)) visit(rootId);
  if (visited.size !== nodes.length) reason ||= '存在循环或孤立节点';
  return { valid: !reason, reason, rootId, byId, children, parents };
}
export function descendants(tree, id) {
  const result = new Set([id]), queue = [id];
  while (queue.length) for (const child of tree.children.get(queue.shift()) || []) if (!result.has(child)) { result.add(child); queue.push(child); }
  return result;
}
export function addBranch(model, selected, sibling = false) {
  const tree = inspectTree(model);
  if (!tree.valid || model.nodes.length >= MAX_NODES) return null;
  const parent = sibling ? tree.parents.get(selected) : selected;
  if (!parent || !tree.byId.has(parent)) return null;
  const id = `node-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
  model.rootId = tree.rootId;
  const node = { id, text: '新主题', x: 0, y: 0 };
  if (parent === tree.rootId) node.side = sibling ? (tree.byId.get(selected).side || sideOf(tree, selected)) : (tree.children.get(parent).length % 2 ? 'left' : 'right');
  model.nodes.push(node);
  const edge = { source: parent, target: id };
  const index = sibling ? model.edges.findIndex(e => e.target === selected) + 1 : model.edges.length;
  model.edges.splice(index, 0, edge);
  tree.byId.get(parent).collapsed = false;
  return id;
}
export function sideOf(tree, id) {
  let top = id;
  while (tree.parents.get(top) && tree.parents.get(top) !== tree.rootId) top = tree.parents.get(top);
  const index = (tree.children.get(tree.rootId) || []).indexOf(top);
  return tree.byId.get(top)?.side || (index % 2 ? 'left' : 'right');
}
export function moveBranch(model, id, parentId, { beforeId = null, side } = {}) {
  const tree = inspectTree(model);
  if (!tree.valid || id === tree.rootId || !tree.byId.has(parentId) || descendants(tree, id).has(parentId)) return false;
  if (beforeId && (!tree.children.get(parentId).includes(beforeId) || beforeId === id)) return false;
  model.rootId = tree.rootId;
  const edge = model.edges.find(e => e.target === id);
  model.edges = model.edges.filter(e => e !== edge);
  const at = beforeId ? model.edges.findIndex(e => e.target === beforeId) : model.edges.length;
  model.edges.splice(at, 0, { ...edge, source: parentId });
  if (parentId === tree.rootId) tree.byId.get(id).side = side || sideOf(tree, id);
  else delete tree.byId.get(id).side;
  tree.byId.get(parentId).collapsed = false;
  return true;
}
export function removeBranch(model, id) {
  const tree = inspectTree(model);
  if (!tree.valid || id === tree.rootId) return null;
  const removed = descendants(tree, id), parent = tree.parents.get(id);
  model.nodes = model.nodes.filter(n => !removed.has(n.id));
  model.edges = model.edges.filter(e => !removed.has(e.source) && !removed.has(e.target));
  return parent;
}
