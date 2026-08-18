import { state, DIARY_MAGIC_PHRASE } from './state.js';
import { apiFetch } from './auth.js';
import { formatDate, escHtml, setupDragAndDrop, showToast, $ } from './helpers.js';
import { renderToHtml } from './markdown.js';
import { renderCalendar } from './calendar.js';
import { handleInternalLogLinkClick, openEditor, openEditorFromNavigation } from './editor.js';
import { populateFilterSubCategory } from './categories.js';
import { formatShortDateLabel, getBusinessDateParts } from './businessDate.js';
import { enableMarkdownImagePreview } from './imagePreview.js';

let lastData = null;
const CARD_WIDTH_KEY = 'logCardWidth';
const CARD_NAV_COLLAPSED_KEY = 'cardNavCollapsed';
const CARD_SCROLL_TAP_SLOP = 8;
const CARD_SCROLL_SUPPRESS_MS = 420;

const logList = $('#logList');
const logCount = $('#logCount');
const listTitle = $('#listTitle');
export const listView = $('#listView');
const pagination = $('#pagination');
const filterPage = $('#filterPage');
const clearFiltersButton = $('#btnClearFilters');
const resetCardWidthButton = $('#btnResetCardWidth');
const cardNavPanel = $('#cardNavPanel');
const cardNavToggle = $('#cardNavToggle');
const cardNavCount = $('#cardNavCount');
const cardNavList = $('#cardNavList');
let cardNavPageInfo = null;
let previewTouchState = null;
let suppressCardOpenUntil = 0;
const ARCHIVE_FILTER_IDS = ['filterCategory', 'filterSubcategory', 'filterMonth', 'filterPage'];

enableMarkdownImagePreview(logList);

function archiveFilterControls() {
  return ARCHIVE_FILTER_IDS
    .map(id => document.querySelector(`[data-filter-control][data-select-id="${id}"]`))
    .filter(Boolean);
}

function closeArchiveFilterControl(control) {
  if (!control) return;
  control.classList.remove('open');
  control.querySelector('.archive-filter-trigger')?.setAttribute('aria-expanded', 'false');
  const menu = control.querySelector('.archive-filter-menu');
  if (menu) menu.hidden = true;
}

function closeArchiveFilterControls(except = null) {
  archiveFilterControls().forEach(control => {
    if (control !== except) closeArchiveFilterControl(control);
  });
}

function selectFromArchiveFilterOption(control, optionButton) {
  const select = document.getElementById(control.dataset.selectId);
  if (!select || !optionButton) return;
  select.value = optionButton.dataset.value || '';
  closeArchiveFilterControl(control);
  select.dispatchEvent(new Event('change', { bubbles: true }));
  syncArchiveFilterControls();
  control.querySelector('.archive-filter-trigger')?.focus();
}

function focusArchiveFilterOption(control, direction = 1) {
  const options = [...control.querySelectorAll('.archive-filter-option')];
  if (!options.length) return;
  const activeIndex = options.indexOf(document.activeElement);
  const selectedIndex = options.findIndex(option => option.getAttribute('aria-selected') === 'true');
  const baseIndex = activeIndex >= 0 ? activeIndex : (selectedIndex >= 0 ? selectedIndex : 0);
  const nextIndex = (baseIndex + direction + options.length) % options.length;
  options[nextIndex].focus();
}

function openArchiveFilterControl(control, { focusSelected = false } = {}) {
  const trigger = control.querySelector('.archive-filter-trigger');
  const menu = control.querySelector('.archive-filter-menu');
  if (!trigger || !menu) return;
  syncArchiveFilterControls();
  closeArchiveFilterControls(control);
  control.classList.add('open');
  trigger.setAttribute('aria-expanded', 'true');
  menu.hidden = false;
  if (focusSelected) {
    const selected = menu.querySelector('.archive-filter-option[aria-selected="true"]');
    (selected || menu.querySelector('.archive-filter-option'))?.focus();
  }
}

function toggleArchiveFilterControl(control) {
  if (control.classList.contains('open')) {
    closeArchiveFilterControl(control);
  } else {
    openArchiveFilterControl(control);
  }
}

export function syncArchiveFilterControls() {
  archiveFilterControls().forEach(control => {
    const select = document.getElementById(control.dataset.selectId);
    const trigger = control.querySelector('.archive-filter-trigger');
    const value = control.querySelector('.archive-filter-value');
    const menu = control.querySelector('.archive-filter-menu');
    if (!select || !trigger || !value || !menu) return;

    const hidden = select.style.display === 'none' || select.hidden;
    control.style.display = hidden ? 'none' : '';
    if (hidden) {
      closeArchiveFilterControl(control);
      return;
    }

    const options = [...select.options];
    const selected = select.selectedOptions[0] || options.find(option => option.value === select.value) || options[0];
    const hasValue = Boolean(select.value);
    value.textContent = selected?.textContent || '';
    control.classList.toggle('has-value', hasValue);
    trigger.setAttribute('aria-label', `${select.labels?.[0]?.textContent || '筛选'}：${selected?.textContent || '未选择'}`);
    menu.innerHTML = options.map(option => `
      <button
        class="archive-filter-option${option.value === select.value ? ' selected' : ''}"
        type="button"
        role="option"
        data-value="${escHtml(option.value)}"
        aria-selected="${option.value === select.value}"
        tabindex="-1"
      >${escHtml(option.textContent)}</button>
    `).join('');
  });
  syncClearFiltersButton();
}

function syncClearFiltersButton() {
  if (!clearFiltersButton) return;
  clearFiltersButton.hidden = !(state.search || state.selectedDate || state.category || state.month);
}

function savedCardWidth() {
  const value = parseInt(localStorage.getItem(CARD_WIDTH_KEY), 10);
  return Number.isFinite(value) && value >= 200 && value <= 800 ? value : null;
}

function syncCardWidthResetButton() {
  if (resetCardWidthButton) resetCardWidthButton.hidden = savedCardWidth() === null;
}

function initArchiveFilterControls() {
  archiveFilterControls().forEach(control => {
    const trigger = control.querySelector('.archive-filter-trigger');
    const menu = control.querySelector('.archive-filter-menu');
    trigger?.addEventListener('click', () => toggleArchiveFilterControl(control));
    trigger?.addEventListener('keydown', (event) => {
      if (!['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) return;
      event.preventDefault();
      openArchiveFilterControl(control, { focusSelected: true });
      if (event.key === 'ArrowUp') focusArchiveFilterOption(control, -1);
    });
    menu?.addEventListener('click', (event) => {
      const option = event.target.closest('.archive-filter-option');
      if (option) selectFromArchiveFilterOption(control, option);
    });
    menu?.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        focusArchiveFilterOption(control, 1);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        focusArchiveFilterOption(control, -1);
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        selectFromArchiveFilterOption(control, event.target.closest('.archive-filter-option'));
      } else if (event.key === 'Escape') {
        event.preventDefault();
        closeArchiveFilterControl(control);
        trigger?.focus();
      }
    });
  });
  document.addEventListener('click', (event) => {
    if (!event.target.closest('[data-filter-control]')) closeArchiveFilterControls();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeArchiveFilterControls();
  });
  syncArchiveFilterControls();
}

function loadSavedCardWidth() {
  const value = savedCardWidth();
  if (value !== null) {
    document.documentElement.style.setProperty('--card-width', value + 'px');
  }
  syncCardWidthResetButton();
}

function persistCardWidth(width) {
  const value = Math.min(800, Math.max(200, Math.round(width)));
  localStorage.setItem(CARD_WIDTH_KEY, String(value));
  document.documentElement.style.setProperty('--card-width', value + 'px');
  syncCardWidthResetButton();
}

loadSavedCardWidth();
applyCardNavCollapsed(localStorage.getItem(CARD_NAV_COLLAPSED_KEY) === 'true');

export async function loadLogs() {
  syncClearFiltersButton();
  const params = new URLSearchParams();
  if (state.selectedDate) params.set('date', state.selectedDate);
  if (state.month) params.set('month', state.month);
  if (state.category) params.set('category', state.category);
  if (state.search) params.set('search', state.search);
  params.set('page', state.currentPage);
  params.set('limit', 20);
  logList.innerHTML = '<div class="loading-state">加载中...</div>';

  try {
    const res = await apiFetch(`/api/logs?${params}`);
    const data = await res.json();
    state.currentPage = data.page || state.currentPage || 1;
    lastData = data;
    renderLogList(data);
    renderPagination(data);
    renderCardNavigator(data);
  } catch (err) {
    if (err.message !== 'Unauthorized') {
      logList.innerHTML = `<div class="empty-state">加载失败: ${escHtml(err.message)}</div>`;
      renderPagination({ totalPages: 0, page: 1 });
      renderCardNavigator({ items: [], total: 0, page: 1, totalPages: 0 });
    }
  }
}

function applyCardNavCollapsed(collapsed) {
  if (!cardNavPanel || !cardNavToggle) return;
  cardNavPanel.classList.toggle('collapsed', collapsed);
  cardNavToggle.setAttribute('aria-expanded', String(!collapsed));
}

function renderCardNavigator(data) {
  if (!cardNavList || !cardNavCount) return;
  const { items = [], total = 0, page = 1, totalPages = 0 } = data || {};
  cardNavCount.textContent = items.length && total > items.length ? `${items.length}/${total}` : String(total);
  const controls = ensureCardNavPageInfo();

  if (items.length === 0) {
    cardNavList.innerHTML = '<div class="card-nav-empty">当前没有可导航的卡片</div>';
    if (controls) controls.innerHTML = '';
    return;
  }

  cardNavList.innerHTML = items.map((log) => {
    const active = state.editingId === log.id ? ' active' : '';
    return `
      <button class="card-nav-item${active}" data-id="${log.id}" title="${escHtml(log.title || '未命名日志')}">
        <span class="card-nav-main">
          <span class="card-nav-title">${escHtml(log.title || '未命名日志')}</span>
          <span class="card-nav-meta">${escHtml(log.log_date || '无日期')} · ${escHtml(log.category)} · ${log.hours}h</span>
        </span>
      </button>
    `;
  }).join('');

  if (controls) {
    controls.innerHTML = totalPages > 1 ? `
      <div class="card-nav-page-text">第 ${page} / ${totalPages} 页，当前 ${items.length} 张</div>
      <div class="card-nav-page-actions">
        <button class="card-nav-page-btn" data-page-action="prev" ${page <= 1 ? 'disabled' : ''}>上一页</button>
        <button class="card-nav-page-btn" data-page-action="next" ${page >= totalPages ? 'disabled' : ''}>下一页</button>
      </div>
    ` : '';
  }
}

function ensureCardNavPageInfo() {
  if (cardNavPageInfo || !cardNavPanel) return cardNavPageInfo;
  cardNavPageInfo = document.createElement('div');
  cardNavPageInfo.className = 'card-nav-page-info';
  cardNavPanel.appendChild(cardNavPageInfo);
  return cardNavPageInfo;
}

function setActiveNavItem(id) {
  cardNavList?.querySelectorAll('.card-nav-item.active').forEach(el => el.classList.remove('active'));
  const navItem = cardNavList?.querySelector(`.card-nav-item[data-id="${id}"]`);
  navItem?.classList.add('active');
}

async function focusLogCard(id) {
  if (listView.style.display === 'none') {
    const switched = await openEditorFromNavigation(id);
    if (switched) setActiveNavItem(id);
    return;
  }

  const card = logList.querySelector(`.log-card[data-id="${id}"]`);
  if (!card) return;

  logList.querySelectorAll('.log-card.nav-highlight').forEach(el => el.classList.remove('nav-highlight'));
  setActiveNavItem(id);
  card.classList.add('nav-highlight');
  card.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  requestAnimationFrame(() => card.focus({ preventScroll: true }));
  window.setTimeout(() => {
    card.classList.remove('nav-highlight');
  }, 1800);
}

cardNavToggle?.addEventListener('click', () => {
  const collapsed = !cardNavPanel.classList.contains('collapsed');
  applyCardNavCollapsed(collapsed);
  localStorage.setItem(CARD_NAV_COLLAPSED_KEY, String(collapsed));
});

cardNavList?.addEventListener('click', async (e) => {
  const item = e.target.closest('.card-nav-item');
  if (!item) return;
  await focusLogCard(parseInt(item.dataset.id, 10));
});

cardNavList?.addEventListener('keydown', async (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const item = e.target.closest('.card-nav-item');
  if (!item) return;
  e.preventDefault();
  await focusLogCard(parseInt(item.dataset.id, 10));
});

cardNavPanel?.addEventListener('click', (e) => {
  const btn = e.target.closest('.card-nav-page-btn');
  if (!btn || btn.disabled) return;

  const direction = btn.dataset.pageAction;
  const totalPages = lastData?.totalPages || 1;
  const nextPage = direction === 'next'
    ? Math.min(totalPages, state.currentPage + 1)
    : Math.max(1, state.currentPage - 1);

  if (nextPage === state.currentPage) return;
  state.currentPage = nextPage;
  loadLogs();
  logList.scrollTo({ left: 0, behavior: 'smooth' });
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

function renderLogList(data) {
  const { items, total } = data;
  logCount.textContent = `共 ${total} 条记录`;
  const isDiaryFilter = state.category === '日记' || state.category.startsWith('日记/');
  const isLockedDiaryFilter = isDiaryFilter && state.diaryLockEnabled && !state.diaryUnlocked;

  if (state.selectedDate) {
    listTitle.textContent = formatDate(state.selectedDate);
  } else if (state.month) {
    listTitle.textContent = `${state.month} 的日志`;
  } else {
    listTitle.textContent = '所有日志';
  }

  if (items.length === 0) {
    let msg = '暂无日志记录，点击「+ 新建日志」开始记录';
    let action = '';
    let className = 'empty-state';
    if (isLockedDiaryFilter) {
      msg = '日记已锁定，解锁后查看日记内容。';
      action = '<button type="button" class="btn-primary btn-sm" data-action="unlock-diary-from-list">解锁日记</button>';
      className += ' locked-diary-empty-state';
    }
    else if (state.search) msg = `未找到匹配「${escHtml(state.search)}」的日志`;
    else if (state.category === '日记') {
      msg = '日记分类暂无记录。旧版通过日记模板创建的记录可能仍在原分类中。';
      action = '<button type="button" class="btn-secondary btn-sm" data-action="find-legacy-diary">查找旧日记</button>';
    }
    else if (state.selectedDate) msg = `${state.selectedDate} 没有日志记录`;
    else if (state.category) msg = `分类「${escHtml(state.category)}」中暂无日志`;
    else if (state.month) msg = `${state.month} 没有日志记录`;
    logList.innerHTML = `<div class="${className}">${msg}${action ? `<div class="empty-state-action">${action}</div>` : ''}</div>`;
    return;
  }

  logList.innerHTML = items.map((log) => {
    // Highlight search term in title
    let title = escHtml(log.title);
    const previewHtml = `<div class="preview-md markdown-body">${renderToHtml(log.content)}</div>`;
    if (state.search) {
      const re = new RegExp('(' + state.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
      title = title.replace(re, '<mark>$1</mark>');
    }
    const dateLabel = formatShortDateLabel(log.log_date);
    const pinned = log.pinned === true;
    const pinLabel = pinned ? '取消置顶' : '置顶';
    return `
      <div class="log-card${pinned ? ' is-pinned' : ''}" data-id="${log.id}" data-pinned="${pinned}" draggable="true" tabindex="0" role="button" aria-label="打开日志: ${escHtml(log.title)}">
        <button class="log-card-pin${pinned ? ' active' : ''}" type="button" data-action="toggle-pin" aria-pressed="${pinned}" aria-label="${pinLabel}日志：${escHtml(log.title)}" title="${pinLabel}">
          <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
            <path class="log-card-pin-head" d="M9 3h6l-1 7 3 3v1H7v-1l3-3-1-7Z"/>
            <path d="M12 14v7"/>
          </svg>
        </button>
        <div class="log-card-top">
          <span class="log-card-title">${title}</span>
          <span class="log-card-category">${escHtml(log.category)}</span>
        </div>
        <div class="log-card-content log-card-preview">
          ${previewHtml}
        </div>
        <div class="log-card-meta-row">
          <span class="log-card-date">${dateLabel}</span>
          <span class="log-card-hours">${log.hours}h</span>
        </div>
        <div class="card-resize-handle"></div>
      </div>
    `;
  }).join('');
}

logList.addEventListener('click', async (e) => {
  const pinButton = e.target.closest('[data-action="toggle-pin"]');
  if (pinButton) {
    e.preventDefault();
    e.stopPropagation();
    const card = pinButton.closest('.log-card');
    if (!card || pinButton.disabled) return;
    const id = Number.parseInt(card.dataset.id, 10);
    const nextPinned = card.dataset.pinned !== 'true';
    pinButton.disabled = true;
    try {
      const res = await apiFetch(`/api/logs/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pinned: nextPinned }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || '更新置顶状态失败');
      }
      state.currentPage = 1;
      await loadLogs();
      showToast(nextPinned ? '日志已置顶' : '已取消置顶', 'success');
    } catch (err) {
      if (pinButton.isConnected) pinButton.disabled = false;
      if (err.message !== 'Unauthorized') showToast(err.message || '更新置顶状态失败', 'error');
    }
    return;
  }
  if (e.target.closest('[data-action="unlock-diary-from-list"]')) {
    e.preventDefault();
    window.dispatchEvent(new CustomEvent('request-diary-unlock'));
    return;
  }
  if (e.target.closest('[data-action="find-legacy-diary"]')) {
    state.category = '';
    state.month = '';
    state.search = '日记';
    state.currentPage = 1;
    $('#filterCategory').value = '';
    $('#filterSubcategory').value = '';
    $('#filterSubcategory').style.display = 'none';
    $('#filterMonth').value = '';
    $('#searchInput').value = '日记';
    $('#btnSearchClear').classList.add('visible');
    syncArchiveFilterControls();
    await loadLogs();
    return;
  }
  if (await handleInternalLogLinkClick(e)) return;
  if (Date.now() < suppressCardOpenUntil && e.target.closest('.log-card-preview')) {
    e.preventDefault();
    return;
  }
  if (e.target.closest('.markdown-body a[href]')) {
    e.stopPropagation();
    return;
  }
  if (e.target.closest('.log-card-preview .markdown-body img')) {
    e.stopPropagation();
    return;
  }
  if (e.target.closest('.card-resize-handle')) return;
  const card = e.target.closest('.log-card');
  if (!card) return;
  openEditor(parseInt(card.dataset.id));
});

logList.addEventListener('touchstart', (event) => {
  const preview = event.target.closest('.log-card-preview');
  if (!preview) {
    previewTouchState = null;
    return;
  }
  const touch = event.touches[0];
  if (!touch) return;
  previewTouchState = {
    preview,
    startY: touch.clientY,
    moved: false,
  };
}, { passive: true });

logList.addEventListener('touchmove', (event) => {
  if (!previewTouchState) return;
  const touch = event.touches[0];
  if (!touch) return;
  if (Math.abs(touch.clientY - previewTouchState.startY) > CARD_SCROLL_TAP_SLOP) {
    previewTouchState.moved = true;
    suppressCardOpenUntil = Date.now() + CARD_SCROLL_SUPPRESS_MS;
  }
}, { passive: true });

logList.addEventListener('touchend', () => {
  if (previewTouchState?.moved) {
    suppressCardOpenUntil = Date.now() + CARD_SCROLL_SUPPRESS_MS;
  }
  previewTouchState = null;
}, { passive: true });

logList.addEventListener('touchcancel', () => {
  previewTouchState = null;
}, { passive: true });

logList.addEventListener('keydown', (e) => {
  if (e.target.closest('a[href^="#log/"]')) return;
  const card = e.target.closest('.log-card');
  if (card && e.target === card && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    openEditor(parseInt(card.dataset.id));
  }
});

setupDragAndDrop({
  container: logList,
  itemSelector: '.log-card',
  getId: (el) => parseInt(el.dataset.id),
  onReorder: async (ids) => {
    const res = await apiFetch('/api/logs/reorder', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderedIds: ids }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || '日志排序失败');
    await loadLogs();
  }
});

function renderPagination(data) {
  pagination.innerHTML = '';
  if (!filterPage) return;
  if (data.totalPages <= 1) {
    filterPage.innerHTML = '<option value="1">第 1 / 1 页</option>';
    filterPage.value = '1';
    filterPage.style.display = 'none';
    syncArchiveFilterControls();
    return;
  }
  let html = '';
  for (let i = 1; i <= data.totalPages; i++) {
    html += `<option value="${i}" ${i === data.page ? 'selected' : ''}>第 ${i} / ${data.totalPages} 页</option>`;
  }
  filterPage.innerHTML = html;
  filterPage.value = String(data.page);
  filterPage.style.display = '';
  syncArchiveFilterControls();
}

filterPage?.addEventListener('change', () => {
  state.currentPage = parseInt(filterPage.value, 10) || 1;
  loadLogs();
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

// Search & Filter
$('#searchInput').addEventListener('input', (() => {
  let timer;
  return () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const value = $('#searchInput').value.trim();
      // Magic phrase toggles the hidden diary instead of searching.
      if (value === DIARY_MAGIC_PHRASE) {
        $('#searchInput').value = '';
        const btn = $('#btnSearchClear');
        if (btn) btn.classList.remove('visible');
        window.dispatchEvent(new CustomEvent('diary-magic-phrase'));
        return;
      }
      state.search = value;
      state.currentPage = 1;
      state.selectedDate = null;
      loadLogs();
      // Toggle clear button
      const btn = $('#btnSearchClear');
      if (btn) btn.classList.toggle('visible', state.search.length > 0);
    }, 300);
  };
})());

$('#btnSearchClear').addEventListener('click', () => {
  $('#searchInput').value = '';
  state.search = '';
  state.currentPage = 1;
  $('#btnSearchClear').classList.remove('visible');
  loadLogs();
});

clearFiltersButton?.addEventListener('click', () => {
  $('#searchInput').value = '';
  $('#btnSearchClear').classList.remove('visible');
  $('#filterCategory').value = '';
  $('#filterMonth').value = '';
  state.search = '';
  state.category = '';
  state.month = '';
  state.selectedDate = null;
  state.currentPage = 1;
  populateFilterSubCategory(null);
  syncArchiveFilterControls();
  renderCalendar();
  loadLogs();
});

$('#filterCategory').addEventListener('change', () => {
  const parent = $('#filterCategory').value;
  state.category = parent;
  state.currentPage = 1;
  populateFilterSubCategory(parent || null);
  syncArchiveFilterControls();
  loadLogs();
});

$('#filterSubcategory').addEventListener('change', () => {
  const parent = $('#filterCategory').value;
  const sub = $('#filterSubcategory').value;
  state.category = parent && sub ? parent + '/' + sub : parent;
  state.currentPage = 1;
  syncArchiveFilterControls();
  loadLogs();
});

$('#filterMonth').addEventListener('change', () => {
  state.month = $('#filterMonth').value;
  state.selectedDate = null;
  state.currentPage = 1;
  loadLogs();
  listTitle.textContent = state.month ? `${state.month} 的日志` : '所有日志';
  syncArchiveFilterControls();
});

export function populateMonthFilter() {
  const now = getBusinessDateParts();
  const cutoff = new Date(Date.UTC(now.year - 2, now.month - 1, 1));
  let html = '<option value="">全部月份</option>';
  for (let i = 0; i < 36; i++) {
    const d = new Date(Date.UTC(now.year, now.month - 1 - i, 1));
    if (d < cutoff) break;
    const val = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    html += `<option value="${val}" ${val === state.month ? 'selected' : ''}>${val}</option>`;
  }
  $('#filterMonth').innerHTML = html;
  syncArchiveFilterControls();
}

// Card resize
let resizing = null;

logList.addEventListener('mousedown', (e) => {
  const handle = e.target.closest('.card-resize-handle');
  if (!handle) return;
  e.preventDefault();
  e.stopPropagation();
  const card = handle.closest('.log-card');
  const startX = e.clientX;
  const startWidth = card.getBoundingClientRect().width;
  document.body.classList.add('resizing');
  resizing = { card, startX, startWidth };
});

document.addEventListener('mousemove', (e) => {
  if (!resizing) return;
  const delta = e.clientX - resizing.startX;
  const newWidth = Math.min(800, Math.max(200, resizing.startWidth + delta));
  resizing.currentWidth = newWidth;
  resizing.card.style.width = newWidth + 'px';
});

document.addEventListener('mouseup', () => {
  if (!resizing) return;
  if (resizing.currentWidth) {
    persistCardWidth(resizing.currentWidth);
    document.querySelectorAll('.log-card').forEach(c => { c.style.width = ''; });
  }
  document.body.classList.remove('resizing');
  resizing = null;
});

// Reset card widths
resetCardWidthButton.addEventListener('click', () => {
  localStorage.removeItem(CARD_WIDTH_KEY);
  document.documentElement.style.removeProperty('--card-width');
  document.querySelectorAll('.log-card').forEach(c => { c.style.width = ''; });
  syncCardWidthResetButton();
});

initArchiveFilterControls();
