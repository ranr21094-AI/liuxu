import { closeDatePickers, isDatePickerTarget, syncDatePickers } from './date-picker.js';
// Shared sidebar search controls; data loading stays with the workbench.
export function filterMemoryItems(items, layer = '', query = '') {
  const text = query.trim().toLocaleLowerCase();
  return items.filter(item => (!layer || item.layer === layer)
    && (!text || `${item.title || ''}\n${item.content || ''}`.toLocaleLowerCase().includes(text)));
}

export function createLatestRequest() {
  let generation = 0;
  return {
    invalidate() { generation += 1; },
    begin() { const token = ++generation; return () => token === generation; },
  };
}

export function initSidebarSearch({ document, onKnowledgeChange, onMemoryChange, onSessionChange }) {
  const $ = selector => document.querySelector(selector);
  const panel = $('#knowledgeFilterPanel');
  const toggle = $('#knowledgeFilterToggle');
  const filters = [
    { id: 'knowledgeDateFilter', label: '日期' },
    { id: 'knowledgeTagFilter', label: '标签' },
    { id: 'knowledgeArchivedFilter', label: '已归档', checkbox: true },
  ];
  function close({ focus = false } = {}) {
    document.dispatchEvent(new document.defaultView.Event('knowledge-operations-close'));
    closeDatePickers(document, 'knowledgeDateFilter');
    if (typeof panel.hidePopover === 'function' && panel.matches(':popover-open')) panel.hidePopover();
    panel.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
    if (focus) toggle.focus();
  }
  function sync() {
    document.querySelectorAll('[data-search-clear]').forEach(button => {
      button.hidden = !document.getElementById(button.dataset.searchClear).value;
    });
    const active = filters.filter(filter => filter.checkbox ? $(`#${filter.id}`).checked : $(`#${filter.id}`).value.trim());
    const chips = $('#knowledgeActiveFilters');
    chips.replaceChildren();
    chips.hidden = !active.length;
    for (const filter of active) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.filterRemove = filter.id;
      const label = filter.checkbox ? filter.label : `${filter.label}：${$(`#${filter.id}`).value.trim()}`;
      button.textContent = `${label} ×`;
      button.setAttribute('aria-label', `移除${label}筛选`);
      chips.append(button);
    }
    if (active.length) {
      const clear = document.createElement('button');
      clear.type = 'button';
      clear.dataset.filterRemove = 'all';
      clear.className = 'sidebar-filter-reset';
      clear.textContent = '清除筛选';
      chips.append(clear);
    }
    const badge = $('#knowledgeFilterCount');
    badge.hidden = !active.length;
    badge.textContent = String(active.length);
    toggle.classList.toggle('is-active', active.length > 0);
    syncDatePickers(document);
    toggle.setAttribute('aria-label', active.length ? `新建笔记，展开更多操作，已启用 ${active.length} 个筛选条件` : '新建笔记，展开更多操作');
    const sectionCount = $('#knowledgeFilterSectionCount');
    if (sectionCount) sectionCount.textContent = active.length ? String(active.length) : ''; 
  }
  function clearFilters(id = 'all') {
    filters.filter(filter => id === 'all' || filter.id === id).forEach(filter => {
      if (filter.checkbox) $(`#${filter.id}`).checked = false;
      else $(`#${filter.id}`).value = '';
    });
  }
  function changed(callback) { sync(); callback(); }
  for (const [id, callback] of [['sessionSearch', onSessionChange], ['knowledgeSearch', onKnowledgeChange], ['memorySearch', onMemoryChange]]) {
    document.getElementById(id).addEventListener('input', () => changed(callback));
  }
  filters.forEach(filter => $(`#${filter.id}`).addEventListener(filter.id === 'knowledgeTagFilter' ? 'input' : 'change', () => changed(onKnowledgeChange)));
  document.querySelectorAll('[data-search-clear]').forEach(button => button.addEventListener('click', () => {
    const input = document.getElementById(button.dataset.searchClear);
    input.value = '';
    input.dispatchEvent(new document.defaultView.Event('input', { bubbles: true }));
    input.focus();
  }));
  $('#knowledgeFilterClose').addEventListener('click', () => close({ focus: true }));
  $('#knowledgeActiveFilters').addEventListener('click', event => {
    const button = event.target.closest('[data-filter-remove]');
    if (!button) return;
    clearFilters(button.dataset.filterRemove);
    changed(onKnowledgeChange);
    toggle.focus();
  });
  document.addEventListener('click', event => {
    if (!panel.hidden && !panel.contains(event.target) && !$('#knowledgeSearchDock').contains(event.target) && !isDatePickerTarget(event.target, 'knowledgeDateFilter')) close();
  });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || panel.hidden) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    close({ focus: true });
  }, true);
  sync();
  return {
    sync, close,
    resetKnowledge() { $('#knowledgeSearch').value = ''; clearFilters(); close(); sync(); },
  };
}
