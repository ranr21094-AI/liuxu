const KEY = 'liuxu.noteAssistant.layout';

export function resolveAssistantLayout({ preference = 'docked', mode = 'knowledge', mainWidth = 0, viewportWidth = 0, width = 380, browserWidth = 0 } = {}) {
  const dockWidth = Math.max(320, Math.min(480, Number(width) || 380));
  if (viewportWidth <= 840) return { mode: 'overlay', width: dockWidth };
  if (preference === 'floating' || mode !== 'knowledge') return { mode: 'floating', width: dockWidth };
  if (browserWidth > 0) {
    if (mainWidth - browserWidth - dockWidth >= 420) return { mode: 'docked', width: dockWidth };
    if (mainWidth - Math.max(browserWidth, dockWidth) >= 420) return { mode: 'stacked', width: dockWidth };
    return { mode: 'overlay', width: dockWidth };
  }
  return { mode: mainWidth - dockWidth >= 600 ? 'docked' : 'overlay', width: dockWidth };
}

// Layout only: moving the panel never remounts messages or reconnects a run.
export function createAssistantLayout(host, { restoreFloating } = {}) {
  const main = document.querySelector('.workspace-main');
  let preference = 'docked';
  let width = 380;
  let mode = document.body.dataset.mode || 'knowledge';
  try {
    const stored = JSON.parse(window.localStorage.getItem(KEY) || 'null');
    if (stored?.preference === 'floating') preference = 'floating';
    width = resolveAssistantLayout({ width: stored?.width }).width;
  } catch { /* storage is optional */ }
  const save = () => {
    try { window.localStorage.setItem(KEY, JSON.stringify({ preference, width })); } catch { /* optional */ }
  };
  function sync() {
    const browserPanel = document.querySelector('#noteBrowserPanel:not([hidden])');
    const browserWidth = browserPanel && !document.body.classList.contains('note-browser-expanded')
      ? browserPanel.getBoundingClientRect().width : 0;
    const available = main?.clientWidth || window.innerWidth;
    const next = resolveAssistantLayout({ preference, mode, mainWidth: available, viewportWidth: window.innerWidth, width, browserWidth });
    const previous = host.dataset.layout;
    host.dataset.layout = next.mode;
    document.body.classList.toggle('assistant-docked', !host.hidden && next.mode === 'docked');
    document.body.classList.toggle('assistant-stacked', !host.hidden && next.mode === 'stacked');
    document.body.style.setProperty('--assistant-dock-width', `${next.width}px`);
    document.body.style.setProperty('--assistant-stack-width', `${Math.max(browserWidth, next.width)}px`);
    const button = host.querySelector('[data-note-assistant-layout]');
    if (button) {
      button.textContent = preference === 'docked' ? '浮动' : '停靠';
      button.title = preference === 'docked' ? '切换为浮动窗口' : '停靠到正文右侧';
    }
    const grip = host.querySelector('.note-assistant-dock-resize');
    grip?.setAttribute('aria-valuenow', String(width));
    grip?.setAttribute('aria-valuemin', '320');
    grip?.setAttribute('aria-valuemax', '480');
    if (next.mode !== 'floating') {
      for (const key of ['left', 'top', 'right', 'bottom', 'width', 'height', 'position', 'zIndex']) host.style[key] = '';
    } else if (previous !== 'floating' && !host.hidden) restoreFloating?.();
  }
  host.querySelector('[data-note-assistant-layout]')?.addEventListener('click', () => {
    preference = preference === 'docked' ? 'floating' : 'docked';
    save(); sync();
  });
  const grip = host.querySelector('.note-assistant-dock-resize');
  let drag = null;
  grip?.addEventListener('pointerdown', event => {
    if (event.button !== 0 || host.dataset.layout !== 'docked') return;
    drag = { id: event.pointerId, x: event.clientX, width };
    grip.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  });
  grip?.addEventListener('pointermove', event => {
    if (!drag || drag.id !== event.pointerId) return;
    width = resolveAssistantLayout({ width: drag.width + drag.x - event.clientX }).width;
    // Keep the editor at least 600px wide throughout the gesture.
    width = Math.min(width, Math.max(320, (main?.clientWidth || 0) - 600));
    sync();
  });
  const end = () => { if (drag) save(); drag = null; };
  grip?.addEventListener('pointerup', end);
  grip?.addEventListener('pointercancel', end);
  grip?.addEventListener('keydown', event => {
    if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
    event.preventDefault();
    const requested = event.key === 'Home' ? 320 : event.key === 'End' ? 480 : width + (event.key === 'ArrowLeft' ? 16 : -16);
    width = Math.min(resolveAssistantLayout({ width: requested }).width, Math.max(320, (main?.clientWidth || 0) - 600));
    save(); sync();
  });
  const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(sync) : null;
  if (main) observer?.observe(main);
  window.addEventListener('resize', sync);
  window.addEventListener('note-browser-layout', sync);
  return { sync, setMode(next) { mode = next; sync(); }, destroy() { observer?.disconnect(); window.removeEventListener('resize', sync); window.removeEventListener('note-browser-layout', sync); } };
}
