export function createMessageFollower(list, button) {
  let following = true;
  let frame = 0;
  const nearBottom = () => list.scrollHeight - list.scrollTop - list.clientHeight < 80;
  const onScroll = () => { following = nearBottom(); button.hidden = following; };
  list.addEventListener('scroll', onScroll, { passive: true });
  function follow(force = false) {
    if (force) following = true;
    if (!following) { button.hidden = false; return; }
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      if (following) list.scrollTop = list.scrollHeight;
      button.hidden = following;
    });
  }
  const jump = () => follow(true);
  button.addEventListener('click', jump);
  return { follow, destroy() { cancelAnimationFrame(frame); list.removeEventListener('scroll', onScroll); button.removeEventListener('click', jump); } };
}

export function initWorkspaceControls() {
  const filters = document.querySelector('#knowledgeActiveFilters');
  const fields = ['knowledgeDateFilter','knowledgeTagFilter','knowledgeArchivedFilter'];
  function renderFilters() {
    filters.replaceChildren();
    for (const id of fields) {
      const field = document.getElementById(id);
      const value = field.type === 'checkbox' ? (field.checked ? '已归档' : '') : field.value.trim();
      if (!value) continue;
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = `${id === 'knowledgeTagFilter' ? '标签：' : ''}${value} ×`;
      button.title = `清除筛选：${value}`;
      button.addEventListener('click', () => {
        if (field.type === 'checkbox') field.checked = false;
        else field.value = '';
        field.dispatchEvent(new Event(id === 'knowledgeTagFilter' ? 'input' : 'change', { bubbles: true }));
        field.focus();
      });
      filters.append(button);
    }
    filters.hidden = !filters.childElementCount;
  }
  fields.forEach(id => {
    const field = document.getElementById(id);
    field.addEventListener('input', renderFilters);
    field.addEventListener('change', renderFilters);
  });
  renderFilters();
  const menu = document.querySelector('#documentMore');
  document.addEventListener('click', event => {
    if (!menu.contains(event.target) || event.target.closest('button')) menu.open = false;
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && menu.open) { menu.open = false; menu.querySelector('summary').focus(); }
  });
}
