let openMenu = null;
let trigger = null;
let menuSerial = 0;

function closeMenu(restoreFocus = false) {
  if (!openMenu) return;
  if (openMenu.isConnected && openMenu.matches(':popover-open')) openMenu.hidePopover();
  trigger?.setAttribute('aria-expanded', 'false');
  if (restoreFocus) trigger?.focus();
  openMenu = null;
}

export function enhanceKnowledgeRowMenus(list) {
  if (openMenu && !openMenu.isConnected) closeMenu();
  list.querySelectorAll('.tree-actions').forEach((menu, index) => {
    if (menu.classList.contains('knowledge-row-menu')) return;
    menu.classList.add('knowledge-row-menu');
    menu.id = `knowledgeRowMenu${++menuSerial}`;
    menu.setAttribute('popover', 'manual');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'knowledge-row-more';
    button.textContent = '⋯';
    button.title = '更多操作';
    button.setAttribute('aria-label', `更多操作：${menu.closest('[data-list-group]')?.querySelector('strong')?.textContent || ''}`);
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-controls', menu.id);
    menu.before(button);
    menu.querySelectorAll('button').forEach(action => {
      const label = document.createElement('span');
      label.textContent = action.title || action.getAttribute('aria-label');
      action.append(label);
    });
    button.addEventListener('click', event => {
      event.stopPropagation();
      const alreadyOpen = openMenu === menu;
      closeMenu();
      if (alreadyOpen) return;
      trigger = button;
      openMenu = menu;
      document.dispatchEvent(new CustomEvent('knowledge-menu-open', { detail: menu }));
      button.setAttribute('aria-expanded', 'true');
      menu.showPopover();
      const rect = button.getBoundingClientRect();
      menu.style.left = `${Math.max(12, Math.min(innerWidth - menu.offsetWidth - 12, rect.right - menu.offsetWidth))}px`;
      menu.style.top = `${Math.max(12, Math.min(innerHeight - menu.offsetHeight - 12, rect.bottom + 4))}px`;
      menu.querySelector('button')?.focus();
    });
    button.addEventListener('keydown', event => event.stopPropagation());
    menu.addEventListener('keydown', event => {
      event.stopPropagation();
      if (event.key === 'Tab') { closeMenu(true); return; }
      const actions = [...menu.querySelectorAll('button')];
      const index = actions.indexOf(document.activeElement);
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        actions[(index + (event.key === 'ArrowDown' ? 1 : actions.length - 1)) % actions.length]?.focus();
      }
    });
    menu.addEventListener('click', () => closeMenu());
  });
}

document.addEventListener('pointerdown', event => {
  if (openMenu && !openMenu.contains(event.target) && !trigger.contains(event.target)) closeMenu();
});
document.addEventListener('keydown', event => {
  if (openMenu && event.key === 'Escape') {
    event.preventDefault();
    event.stopImmediatePropagation();
    closeMenu(true);
  }
}, true);
window.addEventListener('resize', () => closeMenu());
document.addEventListener('knowledge-menu-open', event => { if (event.detail !== openMenu) closeMenu(); });
document.addEventListener('scroll', () => closeMenu(), true);
new MutationObserver(() => {
  if (!openMenu) return;
  const panel = document.querySelector('#knowledgeSidebarPanel');
  if (!openMenu.isConnected || panel?.hidden || document.body.classList.contains('sidebar-collapsed') ||
      (innerWidth <= 840 && !document.body.classList.contains('sidebar-visible'))) closeMenu();
}).observe(document.body, { attributes: true, subtree: true, attributeFilter: ['class', 'hidden'] });
