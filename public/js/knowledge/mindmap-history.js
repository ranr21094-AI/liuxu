import { createMindmapEditor } from './mindmap.js';

export function mountMindmapHistory(host, previous, current) {
  const previews = [];
  for (const [label, content] of [['历史导图', previous], ['当前导图', current]]) {
    const section = host.ownerDocument.createElement('section');
    section.className = 'mindmap-editor mindmap-history-preview';
    const title = host.ownerDocument.createElement('h4'); title.textContent = label;
    const toolbar = host.ownerDocument.createElement('div'); toolbar.className = 'mindmap-history-toolbar';
    for (const [action, text] of [['zoom-in', '放大'], ['zoom-out', '缩小'], ['fit', '适应窗口']]) {
      const button = host.ownerDocument.createElement('button'); button.type = 'button';
      button.className = 'secondary-action compact'; button.dataset.mindmapAction = action; button.textContent = text; toolbar.append(button);
    }
    const stage = host.ownerDocument.createElement('div'); stage.className = 'mindmap-stage';
    const canvas = host.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'svg');
    canvas.setAttribute('aria-label', label); stage.append(canvas); section.append(title, toolbar, stage); host.append(section);
    try {
      const model = JSON.parse(content);
      if (!Array.isArray(model.nodes) || !Array.isArray(model.edges)) throw new Error('invalid model');
      previews.push(createMindmapEditor({ canvas, initial: model, canEdit: () => false, preserveInitialPositions: true }));
    } catch { stage.textContent = '此版本导图数据无法预览，请查看 JSON 对比。'; }
  }
  return () => previews.forEach(preview => preview.destroy());
}
