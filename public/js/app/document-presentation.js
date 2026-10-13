import { initReaderHeader } from '../knowledge/reader-header.js';
export function initDocumentPresentation() {
  const header = document.querySelector('.document-header');
  if (!header) return;
  initReaderHeader();
  const win = document.defaultView;
  const switcher = document.querySelector('#editorModeSwitch');
  const syncSwitch = () => {
    const active = switcher?.querySelector('button.active');
    if (!active) return;
    switcher.style.setProperty('--indicator-x', active.offsetLeft + 'px');
    switcher.style.setProperty('--indicator-w', active.offsetWidth + 'px');
    switcher.querySelectorAll('[data-editor-mode]').forEach(button => button.setAttribute('aria-pressed', String(button === active)));
  };
  if (switcher) {
    const indicator = document.createElement('span'); indicator.className = 'mode-indicator'; indicator.setAttribute('aria-hidden', 'true'); switcher.prepend(indicator);
    switcher.setAttribute('role', 'group'); switcher.setAttribute('aria-label', '文档显示模式');
    new win.MutationObserver(syncSwitch).observe(switcher, { attributes: true, subtree: true, attributeFilter: ['class'] });
    if (typeof win.ResizeObserver === 'function') new win.ResizeObserver(syncSwitch).observe(switcher);
    win.addEventListener('resize', syncSwitch); syncSwitch();
  }
}
