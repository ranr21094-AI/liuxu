export function initKnowledgeOperations({ createNote, doc = document }) {
  const panel = doc.getElementById('knowledgeOperationsPanel'), toggle = doc.getElementById('knowledgeOperationsToggle');
  let opening, closing, keyboard = false;
  const clearTimers = () => { clearTimeout(opening); clearTimeout(closing); };
  const close = () => {
    clearTimers(); if (panel.hidden) return;
    if (panel.matches(':popover-open')) panel.hidePopover();
    panel.hidden = true; toggle.setAttribute('aria-expanded', 'false');
  };
  const position = () => {
    const dock = doc.getElementById('knowledgeSearchDock').getBoundingClientRect();
    const anchor = toggle.getBoundingClientRect();
    panel.style.width = `${Math.min(dock.width, doc.defaultView.innerWidth - 24)}px`;
    panel.style.maxHeight = `${Math.max(80, anchor.top - 20)}px`;
    panel.style.left = `${Math.max(12, Math.min(dock.left, doc.defaultView.innerWidth - panel.offsetWidth - 12))}px`;
    panel.style.top = `${Math.max(12, anchor.top - panel.offsetHeight - 8)}px`;
  };
  const open = (fromKeyboard = false) => {
    clearTimers(); if (toggle.disabled) return;
    keyboard = fromKeyboard;
    doc.dispatchEvent(new doc.defaultView.CustomEvent('knowledge-menu-open', { detail: panel }));
    panel.hidden = false; panel.showPopover(); toggle.setAttribute('aria-expanded', 'true'); position();
    if (fromKeyboard) [...panel.querySelectorAll('#knowledgeDocumentActions button')]
      .find(button => !button.hidden && !button.disabled)?.focus();
  };
  const touch = () => doc.defaultView.matchMedia?.('(hover: none), (pointer: coarse)').matches;
  toggle.addEventListener('click', event => {
    if (touch() && event.detail !== 0) { panel.hidden ? open() : close(); return; }
    close(); createNote();
  });
  toggle.addEventListener('keydown', event => {
    if (['ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); open(true); }
  });
  toggle.addEventListener('pointerenter', event => { if (event.pointerType === 'mouse' && !touch()) { clearTimers(); opening = setTimeout(() => open(), 180); } });
  const leave = () => { clearTimeout(opening); if (!keyboard) closing = setTimeout(() => {
    if (!panel.querySelector(':focus-visible')) close();
  }, 250); };
  toggle.addEventListener('pointerleave', leave);
  panel.addEventListener('pointerenter', clearTimers); panel.addEventListener('pointerleave', leave);
  panel.addEventListener('click', event => { if (event.target.closest('#knowledgeDocumentActions button')) close(); });
  panel.addEventListener('keydown', event => {
    if (!event.target.closest('#knowledgeDocumentActions') || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault(); const buttons = [...panel.querySelectorAll('#knowledgeDocumentActions button')].filter(button => !button.hidden && !button.disabled);
    const index = buttons.indexOf(doc.activeElement); buttons[(index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus();
  });
  for (const type of ['input', 'change']) panel.addEventListener(type, () => queueMicrotask(() => { if (!panel.hidden) position(); }));
  doc.addEventListener('knowledge-menu-open', event => { if (event.detail !== panel) close(); });
  doc.addEventListener('knowledge-operations-close', close);
  doc.getElementById('knowledgeOperationsClose').addEventListener('click', () => { close(); toggle.focus(); });
  doc.addEventListener('keydown', event => { if (event.key === 'Escape' && !panel.hidden) { event.preventDefault(); event.stopImmediatePropagation(); close(); toggle.focus(); } }, true);
  doc.addEventListener('pointerdown', event => { if (!panel.hidden && !panel.contains(event.target) && !toggle.contains(event.target)) close(); });
  new doc.defaultView.MutationObserver(() => {
    if (!doc.body || !doc.getElementById('knowledgeSidebarPanel')) return;
    if (doc.getElementById('knowledgeSidebarPanel').hidden || doc.body.classList.contains('sidebar-collapsed') || (doc.defaultView.innerWidth <= 840 && !doc.body.classList.contains('sidebar-visible'))) close();
  }).observe(doc.body, { attributes: true, subtree: true, attributeFilter: ['class', 'hidden'] });
  doc.defaultView.addEventListener('resize', close);
  return { close, open };
}
