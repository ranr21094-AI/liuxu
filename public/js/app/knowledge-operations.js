import { closeDatePickers, isDatePickerTarget } from './date-picker.js';
export function initKnowledgeOperations({ createNote, doc = document }) {
  const panel = doc.getElementById('knowledgeFilterPanel'), toggle = doc.getElementById('knowledgeFilterToggle');
  let opening, closing, keyboard = false;
  const clearTimers = () => { clearTimeout(opening); clearTimeout(closing); };
  const close = () => {
    clearTimers(); if (panel.hidden) return; closeDatePickers(doc, 'knowledgeDateFilter');
    if (panel.matches(':popover-open')) panel.hidePopover();
    panel.hidden = true; toggle.setAttribute('aria-expanded', 'false');
  };
  const position = () => {
    const dock = doc.getElementById('knowledgeSearchDock').getBoundingClientRect();
    panel.style.width = `${Math.min(dock.width, doc.defaultView.innerWidth - 24)}px`;
    panel.style.maxHeight = `${Math.max(80, dock.top - 12)}px`;
    panel.style.left = `${Math.max(12, Math.min(dock.left, doc.defaultView.innerWidth - panel.offsetWidth - 12))}px`;
    panel.style.top = `${Math.max(12, dock.top - panel.offsetHeight - 8)}px`;
  };
  const open = (fromKeyboard = false) => {
    clearTimers(); if (toggle.disabled) return;
    keyboard = fromKeyboard;
    doc.dispatchEvent(new doc.defaultView.CustomEvent('knowledge-menu-open', { detail: panel }));
    const details = doc.getElementById('knowledgeFilterDetails');
    details.open = !doc.getElementById('knowledgeFilterCount').hidden;
    panel.hidden = false; panel.showPopover(); toggle.setAttribute('aria-expanded', 'true'); position();
    if (fromKeyboard) panel.querySelector('button:not([disabled]):not(.sidebar-filter-close)')?.focus();
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
    if (!doc.querySelector('.date-picker-popup:popover-open') && !panel.querySelector(':focus-visible')) close();
  }, 250); };
  toggle.addEventListener('pointerleave', leave);
  panel.addEventListener('pointerenter', clearTimers); panel.addEventListener('pointerleave', leave);
  panel.addEventListener('click', event => { if (event.target.closest('#knowledgeDocumentActions button')) close(); });
  panel.addEventListener('keydown', event => {
    if (!event.target.closest('#knowledgeDocumentActions') || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault(); const buttons = [...panel.querySelectorAll('#knowledgeDocumentActions button')].filter(button => !button.hidden && !button.disabled);
    const index = buttons.indexOf(doc.activeElement); buttons[(index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus();
  });
  doc.getElementById('knowledgeFilterDetails').addEventListener('toggle', () => { if (!panel.hidden) position(); });
  for (const type of ['input', 'change']) panel.addEventListener(type, () => queueMicrotask(() => { if (!panel.hidden) position(); }));
  doc.addEventListener('knowledge-menu-open', event => { if (event.detail !== panel) close(); });
  doc.addEventListener('knowledge-operations-close', close);
  doc.addEventListener('pointerdown', event => { if (!panel.hidden && !panel.contains(event.target) && !toggle.contains(event.target) && !isDatePickerTarget(event.target, 'knowledgeDateFilter')) close(); });
  new doc.defaultView.MutationObserver(() => {
    if (doc.getElementById('knowledgeSidebarPanel').hidden || doc.body.classList.contains('sidebar-collapsed') || (doc.defaultView.innerWidth <= 840 && !doc.body.classList.contains('sidebar-visible'))) close();
  }).observe(doc.body, { attributes: true, subtree: true, attributeFilter: ['class', 'hidden'] });
  doc.defaultView.addEventListener('resize', close);
  return { close, open };
}
