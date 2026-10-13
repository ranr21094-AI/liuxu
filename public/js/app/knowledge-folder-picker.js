export function normalizeRelativeFolder(value) {
  const text = String(value || '').trim().replace(/\\/g, '/');
  if (/^(?:\/|[a-zA-Z][a-zA-Z\d+.-]*:)/.test(text)) return null;
  const parts = text.split('/').filter(part => part && part !== '.');
  if (parts.some(part => part === '..')) return null;
  return parts.join('/');
}

export function initKnowledgeFolderPicker({ doc, input, trigger, getNodes, onChange }) {
  const popup = doc.createElement('div'); popup.className = 'knowledge-folder-picker'; popup.setAttribute('popover', 'manual'); popup.setAttribute('aria-label', '选择目标文件夹'); popup.hidden = true;
  popup.id = 'knowledgeMoveFolderMenu'; trigger.setAttribute('aria-controls', popup.id);
  trigger.after(popup); trigger.setAttribute('aria-expanded', 'false');
  let trail = [], timer;
  const compact = () => doc.defaultView.innerWidth <= 600 || doc.defaultView.matchMedia?.('(hover: none), (pointer: coarse)').matches;
  const button = (text, action, label) => { const el = doc.createElement('button'); el.type = 'button'; el.textContent = text; if (label) el.setAttribute('aria-label', label); el.addEventListener('click', action); return el; };
  function close(focus = false) {
    clearTimeout(timer); if (!popup.hidden && typeof popup.hidePopover === 'function') popup.hidePopover();
    popup.hidden = true; trigger.setAttribute('aria-expanded', 'false'); if (focus) trigger.focus();
  }
  function choose(path) { input.value = path; onChange(); close(true); }
  function position() {
    const rect = trigger.getBoundingClientRect(), win = doc.defaultView;
    popup.style.maxWidth = Math.max(180, win.innerWidth - 24) + 'px';
    popup.style.maxHeight = Math.max(80, win.innerHeight - 24) + 'px';
    popup.style.left = Math.max(12, Math.min(rect.left, win.innerWidth - popup.offsetWidth - 12)) + 'px';
    popup.style.top = Math.max(12, Math.min(rect.bottom + 6, win.innerHeight - popup.offsetHeight - 12)) + 'px';
  }
  function expand(node, depth, focus = false) {
    clearTimeout(timer); trail = trail.slice(0, depth); trail.push(node); render();
    if (focus) popup.querySelector('.knowledge-folder-column:last-child [data-folder-choice]')?.focus({ preventScroll: true });
  }
  function render() {
    popup.replaceChildren(); popup.classList.toggle('is-compact', compact());
    const levels = [{ nodes: getNodes(), parent: null }, ...trail.map(node => ({ nodes: node.children || [], parent: node }))];
    (compact() ? levels.slice(-1) : levels).forEach((level, index) => {
      const depth = compact() ? levels.length - 1 : index;
      const column = doc.createElement('section'); column.className = 'knowledge-folder-column';
      const heading = doc.createElement('div'); heading.className = 'knowledge-folder-heading'; heading.textContent = level.parent?.name || '一级文件夹';
      if (compact() && level.parent) heading.prepend(button('‹', () => { trail.pop(); render(); popup.querySelector('[data-folder-choice]')?.focus(); }, '返回上一级文件夹'));
      column.append(heading);
      const list = doc.createElement('div'); list.className = 'knowledge-folder-options'; list.setAttribute('role', 'menu');
      if (!level.parent || compact()) {
        const root = button(level.parent ? '选择此文件夹' : '根目录', () => choose(level.parent?.path || ''));
        root.dataset.folderChoice = level.parent?.path || ''; if (normalizeRelativeFolder(input.value) === root.dataset.folderChoice) root.setAttribute('aria-current', 'true'); root.setAttribute('role', 'menuitem'); list.append(root);
      }
      for (const node of level.nodes) {
        const row = doc.createElement('div'); row.className = 'knowledge-folder-choice-row';
        const select = button(node.name, () => choose(node.path)); select.title = node.path; select.dataset.folderChoice = node.path; select.setAttribute('role', 'menuitem');
        if (normalizeRelativeFolder(input.value) === node.path) select.setAttribute('aria-current', 'true');
        row.append(select);
        if (node.children?.length) {
          const next = button('›', () => expand(node, depth, true), `展开 ${node.name} 的下级文件夹`); next.className = 'knowledge-folder-next'; next.setAttribute('aria-expanded', String(trail[depth]?.path === node.path)); row.append(next);
          row.addEventListener('pointerenter', event => { if (event.pointerType === 'mouse' && !compact()) { clearTimeout(timer); timer = setTimeout(() => expand(node, depth), 160); } });
        } else row.addEventListener('pointerenter', event => { if (event.pointerType === 'mouse' && !compact() && trail.length > depth) { clearTimeout(timer); trail = trail.slice(0, depth); render(); } });
        row.addEventListener('pointerleave', () => clearTimeout(timer));
        select.addEventListener('keydown', event => { if (event.key === 'ArrowRight' && node.children?.length) { event.preventDefault(); expand(node, depth, true); } });
        list.append(row);
      }
      if (!level.nodes.length) { const empty = doc.createElement('p'); empty.textContent = '没有下级文件夹'; list.append(empty); }
      column.append(list); popup.append(column);
    });
    position();
  }
  function open() {
    if (trigger.disabled) return;
    trail = []; popup.hidden = false;
    if (typeof popup.showPopover === 'function') popup.showPopover();
    trigger.setAttribute('aria-expanded', 'true'); render();
    popup.querySelector('[aria-current], [data-folder-choice]')?.focus({ preventScroll: true });
  }
  trigger.addEventListener('click', () => popup.hidden ? open() : close(true));
  trigger.addEventListener('keydown', event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); open(); } });
  popup.addEventListener('keydown', event => {
    if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); const column = event.target.closest('.knowledge-folder-column'), choices = [...column.querySelectorAll('[data-folder-choice]')];
      const index = choices.indexOf(doc.activeElement); const next = event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : choices.length - 1)) % choices.length; choices[next]?.focus({ preventScroll: true });
    }
    if (event.key === 'ArrowLeft' && trail.length) { event.preventDefault(); const parent = trail.pop(); render(); [...popup.querySelectorAll('[data-folder-choice]')].find(el => el.dataset.folderChoice === parent.path)?.focus({ preventScroll: true }); }
    if (event.key === 'Tab') close();
  });
  const dialog = input.closest('dialog');
  dialog.addEventListener('keydown', event => { if (event.key === 'Escape' && !popup.hidden) { event.preventDefault(); event.stopImmediatePropagation(); close(true); } }, true);
  doc.addEventListener('pointerdown', event => { if (!popup.hidden && !popup.contains(event.target) && !trigger.contains(event.target)) close(); });
  doc.defaultView.addEventListener('resize', () => close());
  return { close, open };
}
