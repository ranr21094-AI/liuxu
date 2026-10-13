export function initKnowledgeNavigation({ getBases, getLocation, navigate, doc = document }) {
  const panel = doc.createElement('div');
  panel.className = 'knowledge-navigation-menu';
  panel.setAttribute('popover', 'manual');
  panel.setAttribute('aria-label', '切换知识目录');
  doc.body.append(panel);
  let trigger = null;
  const position = () => {
    const rect = trigger.getBoundingClientRect();
    panel.style.maxHeight = `${Math.max(80, doc.defaultView.innerHeight - 24)}px`;
    panel.style.left = `${Math.max(12, Math.min(rect.left, doc.defaultView.innerWidth - panel.offsetWidth - 12))}px`;
    panel.style.top = `${Math.max(12, Math.min(rect.bottom + 6, doc.defaultView.innerHeight - panel.offsetHeight - 12))}px`;
  };
  const close = (focus = false) => {
    if (panel.matches(':popover-open')) panel.hidePopover();
    trigger?.setAttribute('aria-expanded', 'false');
    if (focus && trigger?.isConnected) trigger.focus();
  };
  const children = (base, path) => {
    let nodes = base?.folders || [];
    for (const segment of path.split('/').filter(Boolean)) nodes = nodes.find(node => node.name === segment)?.children || [];
    return nodes;
  };
  const render = (baseName, path, showBases = false, currentFolder = '') => {
    panel.replaceChildren();
    const base = getBases().find(item => item.name === baseName);
    const add = (label, action, selected = false, title = label) => {
      const button = doc.createElement('button');
      button.type = 'button'; button.title = title;
      const text = doc.createElement('span'); text.className = 'knowledge-navigation-label'; text.textContent = label; button.append(text);
      const check = doc.createElement('span'); check.className = 'knowledge-navigation-check'; check.setAttribute('aria-hidden', 'true'); check.textContent = selected ? '✓' : ''; button.append(check);
      button.classList.toggle('active', selected);
      if (selected) button.setAttribute('aria-current', 'location');
      button.addEventListener('click', action);
      panel.append(button);
    };
    const jump = (name, folder) => { close(); navigate(name, folder); };
    if (showBases) {
      getBases().forEach(item => add(item.name, () => jump(item.name, ''), item.name === baseName));
    } else {
      const nodes = children(base, path);
      nodes.forEach(node => add(node.name, () => jump(baseName, node.path), currentFolder === node.path));
      if (!nodes.length) { const empty = doc.createElement('p'); empty.textContent = '没有同层目录'; panel.append(empty); }
    }
    if (panel.matches(':popover-open')) position();
  };
  doc.getElementById('knowledgeBreadcrumb').addEventListener('click', event => {
    const button = event.target.closest('[data-directory-menu]');
    if (!button) return;
    const same = trigger === button && panel.matches(':popover-open'); close();
    if (same) return;
    trigger = button;
    doc.dispatchEvent(new doc.defaultView.CustomEvent('knowledge-menu-open', { detail: panel }));
    const location = getLocation();
    const path = button.dataset.directoryMenu;
    render(location.knowledgeBase, path === 'base' ? '' : path.split('/').slice(0, -1).join('/'), path === 'base', path === 'base' ? '' : path);
    panel.showPopover(); button.setAttribute('aria-expanded', 'true');
    position();
    (panel.querySelector('[aria-current]') || panel.querySelector('button'))?.focus();
  });
  doc.addEventListener('pointerdown', event => { if (!panel.contains(event.target) && !trigger?.contains(event.target)) close(); });
  doc.addEventListener('keydown', event => {
    if (!panel.matches(':popover-open')) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close(true); }
    else if (panel.contains(event.target) && ['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); const buttons = [...panel.querySelectorAll('button')]; const index = buttons.indexOf(doc.activeElement);
      buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus();
    } else if (event.key === 'Tab') close(true);
  }, true);
  doc.addEventListener('knowledge-menu-open', event => { if (event.detail !== panel) close(); });
  new doc.defaultView.MutationObserver(() => {
    if (!trigger?.isConnected || doc.getElementById('knowledgeSidebarPanel').hidden || doc.body.classList.contains('sidebar-collapsed') || (doc.defaultView.innerWidth <= 840 && !doc.body.classList.contains('sidebar-visible'))) close();
  }).observe(doc.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'hidden'] });
  doc.defaultView.addEventListener('resize', () => close());
  return { close };
}
