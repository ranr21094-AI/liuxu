import { state } from './state.js';
import { apiFetch } from './auth.js';
import { formatDate, escHtml, setupDragAndDrop, announce, showToast, $ } from './helpers.js';
import { renderToHtml, renderToText } from './markdown.js';
import { renderCalendar } from './calendar.js';
import { handleInternalLogLinkClick, openEditor, openEditorFromNavigation } from './editor.js';
import { populateFilterSubCategory } from './categories.js';
import { formatShortDateLabel, getBusinessDateParts } from './businessDate.js';

let previewFormat = localStorage.getItem('previewFormat') || 'plain';
let lastData = null;
const CARD_WIDTH_KEY = 'logCardWidth';
const CARD_NAV_COLLAPSED_KEY = 'cardNavCollapsed';

const logList = $('#logList');
const logCount = $('#logCount');
const listTitle = $('#listTitle');
export const listView = $('#listView');
const pagination = $('#pagination');
const cardNavPanel = $('#cardNavPanel');
const cardNavToggle = $('#cardNavToggle');
const cardNavCount = $('#cardNavCount');
const cardNavList = $('#cardNavList');
let cardNavPageInfo = null;

function loadSavedCardWidth() {
  const value = parseInt(localStorage.getItem(CARD_WIDTH_KEY), 10);
  if (Number.isFinite(value) && value >= 200 && value <= 800) {
    document.documentElement.style.setProperty('--card-width', value + 'px');
  }
}

function persistCardWidth(width) {
  const value = Math.min(800, Math.max(200, Math.round(width)));
  localStorage.setItem(CARD_WIDTH_KEY, String(value));
  document.documentElement.style.setProperty('--card-width', value + 'px');
}

loadSavedCardWidth();
applyCardNavCollapsed(localStorage.getItem(CARD_NAV_COLLAPSED_KEY) === 'true');

export async function loadLogs() {
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
    lastData = data;
    renderLogList(data);
    renderPagination(data);
    renderCardNavigator(data);
  } catch (err) {
    if (err.message !== 'Unauthorized') {
      logList.innerHTML = `<div class="empty-state">加载失败: ${err.message}</div>`;
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

  const offset = (page - 1) * 20;

  cardNavList.innerHTML = items.map((log, idx) => {
    const active = state.editingId === log.id ? ' active' : '';
    return `
      <button class="card-nav-item${active}" data-id="${log.id}" title="${escHtml(log.title || '未命名日志')}">
        <span class="card-nav-index">${offset + idx + 1}</span>
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

  logList.innerHTML = items.map((log, index) => {
    // Highlight search term in title
    let title = escHtml(log.title);
    let previewHtml;
    if (previewFormat === 'plain') {
      let text = renderToText(log.content);
      text = escHtml(text);
      if (state.search) {
        const re = new RegExp('(' + state.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
        text = text.replace(re, '<mark>$1</mark>');
      }
      previewHtml = `<div class="preview-plain">${text}</div>`;
    } else {
      previewHtml = `<div class="preview-md markdown-body">${renderToHtml(log.content)}</div>`;
    }
    if (state.search) {
      const re = new RegExp('(' + state.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
      title = title.replace(re, '<mark>$1</mark>');
    }
    const dateLabel = formatShortDateLabel(log.log_date);
    return `
      <div class="log-card" data-id="${log.id}" draggable="true" tabindex="0" role="button" aria-label="打开日志: ${escHtml(log.title)}">
        <div class="log-card-drag" title="拖动排序">⋮⋮</div>
        <span class="item-order-controls" aria-label="调整日志顺序">
          <button type="button" class="btn-order" data-action="move-up" aria-label="上移日志：${escHtml(log.title)}" ${index === 0 ? 'disabled' : ''}>↑</button>
          <button type="button" class="btn-order" data-action="move-down" aria-label="下移日志：${escHtml(log.title)}" ${index === items.length - 1 ? 'disabled' : ''}>↓</button>
        </span>
        <div class="log-card-top">
          <span class="log-card-title">${title}</span>
          <span class="log-card-category">${escHtml(log.category)}</span>
          <span class="log-card-hours">${log.hours}h</span>
          <button class="btn-preview-toggle${previewFormat === 'markdown' ? ' active' : ''}" data-action="toggle-preview" title="切换纯文本/Markdown" aria-label="切换日志预览格式" aria-pressed="${previewFormat === 'markdown'}">◧</button>
        </div>
        <div class="log-card-content log-card-preview">
          ${previewHtml}
        </div>
        <div class="log-card-date">${dateLabel}</div>
        <div class="card-resize-handle"></div>
      </div>
    `;
  }).join('');
}

async function moveVisibleLog(id, delta, action) {
  const items = lastData?.items || [];
  const index = items.findIndex(log => log.id === id);
  const targetIndex = index + delta;
  if (index < 0 || targetIndex < 0 || targetIndex >= items.length) return;
  const reordered = [...items];
  [reordered[index], reordered[targetIndex]] = [reordered[targetIndex], reordered[index]];
  try {
    const res = await apiFetch('/api/logs/reorder', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderedIds: reordered.map(log => log.id) }),
    });
    if (!res.ok) throw new Error('服务器拒绝排序请求');
    lastData = { ...lastData, items: reordered };
    renderLogList(lastData);
    renderCardNavigator(lastData);
    logList.querySelector(`.log-card[data-id="${id}"] [data-action="${action}"]`)?.focus();
    announce(`日志已${delta < 0 ? '上移' : '下移'}`);
  } catch (err) {
    showToast('日志排序失败: ' + err.message, 'error');
    announce('日志排序失败');
    console.error('Log reorder failed:', err);
  }
}

logList.addEventListener('click', async (e) => {
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
    await loadLogs();
    return;
  }
  if (await handleInternalLogLinkClick(e)) return;
  if (e.target.closest('.markdown-body a[href]')) {
    e.stopPropagation();
    return;
  }
  if (e.target.closest('.log-card-drag')) return;
  if (e.target.closest('.card-resize-handle')) return;
  const moveButton = e.target.closest('[data-action="move-up"], [data-action="move-down"]');
  if (moveButton) {
    const id = parseInt(moveButton.closest('.log-card').dataset.id, 10);
    await moveVisibleLog(id, moveButton.dataset.action === 'move-up' ? -1 : 1, moveButton.dataset.action);
    return;
  }
  const toggleBtn = e.target.closest('[data-action="toggle-preview"]');
  if (toggleBtn) {
    e.stopPropagation();
    previewFormat = previewFormat === 'plain' ? 'markdown' : 'plain';
    localStorage.setItem('previewFormat', previewFormat);
    if (lastData) renderLogList(lastData);
    return;
  }
  const card = e.target.closest('.log-card');
  if (!card) return;
  openEditor(parseInt(card.dataset.id));
});

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
    await apiFetch('/api/logs/reorder', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderedIds: ids }),
    });
  }
});

function renderPagination(data) {
  if (data.totalPages <= 1) { pagination.innerHTML = ''; return; }
  let html = '';
  for (let i = 1; i <= data.totalPages; i++) {
    html += `<button class="${i === data.page ? 'active' : ''}" data-page="${i}">${i}</button>`;
  }
  pagination.innerHTML = html;
}

pagination.addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  state.currentPage = parseInt(btn.dataset.page);
  loadLogs();
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

// Search & Filter
$('#searchInput').addEventListener('input', (() => {
  let timer;
  return () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      state.search = $('#searchInput').value.trim();
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

$('#filterCategory').addEventListener('change', () => {
  const parent = $('#filterCategory').value;
  state.category = parent;
  state.currentPage = 1;
  populateFilterSubCategory(parent || null);
  loadLogs();
});

$('#filterSubcategory').addEventListener('change', () => {
  const parent = $('#filterCategory').value;
  const sub = $('#filterSubcategory').value;
  state.category = parent && sub ? parent + '/' + sub : parent;
  state.currentPage = 1;
  loadLogs();
});

$('#filterMonth').addEventListener('change', () => {
  state.month = $('#filterMonth').value;
  state.selectedDate = null;
  state.currentPage = 1;
  loadLogs();
  listTitle.textContent = state.month ? `${state.month} 的日志` : '所有日志';
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
$('#btnResetCardWidth').addEventListener('click', () => {
  localStorage.removeItem(CARD_WIDTH_KEY);
  document.documentElement.style.removeProperty('--card-width');
  document.querySelectorAll('.log-card').forEach(c => { c.style.width = ''; });
});
