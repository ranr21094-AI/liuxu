export function initTodoReminderPanel(doc = document) {
  const panel = doc.getElementById('todoReminderDialog');
  const toggle = doc.getElementById('todoReminderOpen');
  const dock = doc.getElementById('todoSearchDock');
  const sidebar = doc.getElementById('todoSidebarPanel');
  const nested = () => !!doc.querySelector('dialog[open]');
  function close(focus = false) {
    panel.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
    if (focus) toggle.focus();
  }
  function fit() {
    if (panel.hidden) return;
    const available = dock.getBoundingClientRect().top - Math.max(12, sidebar.getBoundingClientRect().top + 20);
    panel.style.maxHeight = `${Math.max(40, available)}px`;
  }
  toggle.addEventListener('click', () => {
    if (!panel.hidden) return close();
    panel.hidden = false;
    toggle.setAttribute('aria-expanded', 'true');
    fit();
    doc.getElementById('todoReminderEnabled').focus();
  });
  doc.getElementById('todoReminderClose').addEventListener('click', () => close(true));
  doc.addEventListener('click', event => {
    if (!panel.hidden && !dock.contains(event.target) && !nested() && !event.target.closest('dialog')) close();
  });
  doc.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || panel.hidden || nested()) return;
    event.preventDefault(); event.stopImmediatePropagation(); close(true);
  }, true);
  const win = doc.defaultView;
  const observer = new win.MutationObserver(() => {
    if (sidebar.hidden || (win.matchMedia?.('(max-width: 840px)').matches && !doc.body.classList.contains('sidebar-visible'))) close();
    else fit();
  });
  observer.observe(sidebar, { attributes: true, attributeFilter: ['hidden'] });
  observer.observe(doc.body, { attributes: true, attributeFilter: ['class'] });
  win.addEventListener('resize', () => {
    if (win.matchMedia?.('(max-width: 840px)').matches && !doc.body.classList.contains('sidebar-visible')) close();
    else fit();
  });
  return { close, fit };
}
