import { state } from './state.js';
import { apiFetch } from './auth.js';
import { showToast, escHtml, setupDragAndDrop, confirmDialog, $ } from './helpers.js';
import { loadLogs } from './logList.js';
import { loadStats } from './stats.js';
import { formatShortDateLabel } from './businessDate.js';

export async function loadCategories() {
  try {
    const res = await apiFetch('/api/categories');
    state.categories = await res.json();
    populateFilterCategory();
    populateEditorParentCategory();
  } catch (err) {
    console.error('Load categories failed:', err);
    showToast('加载分类失败', 'error');
  }
}

export function populateFilterCategory() {
  const sel = $('#filterCategory');
  const current = (state.category || '').split('/')[0] || sel.value;
  sel.innerHTML = '<option value="">全部分类</option>' +
    state.categories.map(c => `<option value="${escHtml(c.name)}">${escHtml(c.name)}</option>`).join('');
  if (state.categories.some(c => c.name === current)) sel.value = current;
  populateFilterSubCategory(sel.value || null);
}

export function populateFilterSubCategory(parent) {
  const sel = $('#filterSubcategory');
  if (!parent) {
    sel.style.display = 'none';
    sel.value = '';
    return;
  }
  const cat = state.categories.find(c => c.name === parent);
  if (!cat || !cat.sub || cat.sub.length === 0) {
    sel.style.display = 'none';
    sel.value = '';
    return;
  }
  const current = state.category.startsWith(parent + '/') ? state.category.slice(parent.length + 1) : '';
  sel.innerHTML = '<option value="">全部二级</option>' +
    cat.sub.map(s => `<option value="${escHtml(s)}">${escHtml(s)}</option>`).join('');
  sel.style.display = '';
  if (cat.sub.includes(current)) sel.value = current;
}

export function populateEditorParentCategory() {
  const sel = $('#editCategory');
  const current = sel.value;
  sel.innerHTML = state.categories.map(c => `<option value="${escHtml(c.name)}">${escHtml(c.name)}</option>`).join('');
  if (state.categories.some(c => c.name === current)) sel.value = current;
  // Update subcategory dropdown for the selected parent
  const parent = sel.value || (state.categories[0] && state.categories[0].name);
  if (parent) populateEditorSubCategory(parent);
}

export function populateEditorSubCategory(parent) {
  const sel = $('#editSubcategory');
  const current = sel.value;
  const cat = state.categories.find(c => c.name === parent);
  sel.innerHTML = '<option value="">（无）</option>' +
    (cat && cat.sub ? cat.sub.map(s => `<option value="${escHtml(s)}">${escHtml(s)}</option>`).join('') : '');
  if (cat && cat.sub && cat.sub.includes(current)) sel.value = current;
}

// Category Management View
let selectedCategoryName = null;
let editingSubcategory = null;
let subcategoryBrowseParent = null;
let selectedSubcategoryName = null;

function parentFromFilter() {
  return (state.category || '').split('/')[0] || null;
}

function getVisibleCategories() {
  const query = $('#catSearchInput').value.trim().toLowerCase();
  if (!query) return state.categories;
  return state.categories.filter(c =>
    c.name.toLowerCase().includes(query) ||
    (c.sub || []).some(s => s.toLowerCase().includes(query))
  );
}

function ensureSelectedCategory(cats) {
  const filteredParent = parentFromFilter();
  if (!selectedCategoryName && state.categories.some(c => c.name === filteredParent)) {
    selectedCategoryName = filteredParent;
  }
  if (!cats.some(c => c.name === selectedCategoryName)) {
    selectedCategoryName = cats[0]?.name || null;
  }
}

function updateCategorySummary() {
  const total = state.categories.length;
  const summary = $('#catManagerSummary');
  summary.textContent = total;
  summary.setAttribute('aria-label', `父分类数量：${total}`);
  summary.setAttribute('title', `父分类数量：${total}`);
}

function isProtectedRootCategory(name) {
  return name === '其他' || name === '日记';
}

function fullSubcategoryName(parent, sub) {
  return `${parent}/${sub}`;
}

function syncMainCategoryFilter(category) {
  state.category = category;
  state.selectedDate = null;
  state.currentPage = 1;
  const [parent = '', ...subParts] = category.split('/');
  $('#filterCategory').value = parent;
  populateFilterSubCategory(parent || null);
  $('#filterSubcategory').value = subParts.join('/');
}

function setSubcategoryBrowseMode(enabled) {
  $('#catList').style.display = enabled ? 'none' : '';
  $('#catSubBrowseSidebar').style.display = enabled ? 'flex' : 'none';
  $('#catDetailEmpty').style.display = enabled ? 'none' : $('#catDetailEmpty').style.display;
  $('#catDetailContent').style.display = enabled ? 'none' : $('#catDetailContent').style.display;
  $('#catSubBrowseContent').style.display = enabled ? 'flex' : 'none';
}

function renderParentList() {
  subcategoryBrowseParent = null;
  selectedSubcategoryName = null;
  setSubcategoryBrowseMode(false);
  const cats = getVisibleCategories();
  const isSearching = Boolean($('#catSearchInput').value.trim());
  ensureSelectedCategory(cats);
  updateCategorySummary();
  if (!cats.length) {
    $('#catList').innerHTML = state.categories.length
      ? '<div class="cat-empty">没有匹配的分类</div>'
      : '<div class="cat-empty">暂无分类，先添加一个父分类。</div>';
    renderCategoryDetail();
    return;
  }
  $('#catList').innerHTML = cats.map(c => `
    <div class="cat-parent-item ${c.name === selectedCategoryName ? 'active' : ''}" data-cat="${escHtml(c.name)}" draggable="${!isSearching}">
      <span class="cat-drag-handle ${isSearching ? 'disabled' : ''}" title="${isSearching ? '搜索时暂不排序' : '拖动排序'}">⋮⋮</span>
      <button type="button" class="cat-parent-select" data-cat="${escHtml(c.name)}">
        <span class="cat-parent-name">${escHtml(c.name)}</span>
        ${isProtectedRootCategory(c.name) ? '<span class="cat-default-tag">不可删除</span>' : ''}
        <span class="cat-sub-count" title="子分类数量">${(c.sub || []).length}</span>
      </button>
    </div>
  `).join('');
  renderCategoryDetail();
}

function renderCategoryDetail() {
  const cat = state.categories.find(c => c.name === selectedCategoryName);
  const empty = $('#catDetailEmpty');
  const content = $('#catDetailContent');
  if (!cat) {
    empty.style.display = '';
    content.style.display = 'none';
    return;
  }
  empty.style.display = 'none';
  content.style.display = '';
  $('#catDetailName').textContent = cat.name;
  $('#catDetailLogCount').textContent = cat.log_count || 0;
  $('#catDetailLogCount').setAttribute('aria-label', `${cat.name} 日志数量：${cat.log_count || 0}`);
  $('#catDetailFallback').style.display = isProtectedRootCategory(cat.name) ? '' : 'none';
  $('#btnCatRename').style.display = cat.name === '日记' ? 'none' : '';
  $('#btnCatDelete').style.display = isProtectedRootCategory(cat.name) ? 'none' : '';
  $('#catCalendarDayVisible').checked = cat.calendar_day_visible !== false;
  $('#catCalendarDayVisible').setAttribute(
    'aria-label',
    `${cat.name}：点击日历日期时显示日志`
  );
  $('#catDetailSubCount').textContent = `${(cat.sub || []).length} 个`;
  $('#catRenameRow').style.display = 'none';
  $('#catSubNewInput').value = '';
  editingSubcategory = null;
  $('#catSubList').innerHTML = (cat.sub || []).map(s => `
    <div class="cat-detail-sub-item" data-sub="${escHtml(s)}" tabindex="0" role="button" aria-label="浏览子分类：${escHtml(s)}">
      <span class="cat-log-count" title="日志数量">${cat.sub_log_counts?.[s] || 0}</span>
      <span class="cat-detail-sub-name">${escHtml(s)}</span>
      <div class="cat-detail-sub-actions">
        <button class="cat-icon-action subcat-edit-btn" type="button" aria-label="重命名子分类：${escHtml(s)}" title="重命名子分类">✎</button>
        <button class="cat-icon-action danger subcat-del-btn" type="button" aria-label="删除子分类：${escHtml(s)}" title="删除子分类">×</button>
      </div>
    </div>
  `).join('');
}

async function loadSubcategoryLogs(parent, sub) {
  const params = new URLSearchParams({
    category: fullSubcategoryName(parent, sub),
    page: '1',
    limit: '100',
  });
  const list = $('#catSubLogList');
  list.innerHTML = '<div class="loading-state">加载中...</div>';

  try {
    const res = await apiFetch(`/api/logs?${params}`);
    if (!res.ok) throw new Error('日志加载失败');
    const data = await res.json();
    $('#catSubBrowseLogCount').textContent = data.total || 0;
    $('#catSubBrowseLogCount').setAttribute('aria-label', `${sub} 日志数量：${data.total || 0}`);

    if (!data.items.length) {
      list.innerHTML = `<div class="cat-sub-log-empty">子分类「${escHtml(sub)}」暂无日志</div>`;
      return;
    }

    list.innerHTML = data.items.map((log, index) => `
      <button class="cat-sub-log-card" type="button" data-id="${log.id}" aria-label="打开日志：${escHtml(log.title || '未命名日志')}">
        <span class="cat-sub-log-index">${index + 1}</span>
        <span class="cat-sub-log-title">${escHtml(log.title || '未命名日志')}</span>
        <span class="cat-sub-log-date">${escHtml(formatShortDateLabel(log.log_date))}</span>
        <span class="cat-sub-log-arrow" aria-hidden="true">›</span>
      </button>
    `).join('');
  } catch (err) {
    list.innerHTML = `<div class="empty-state">加载失败: ${escHtml(err.message)}</div>`;
  }
}

async function openSubcategoryBrowse(subName) {
  const parent = selectedCategoryName;
  const cat = state.categories.find(c => c.name === parent);
  if (!parent || !cat || !(cat.sub || []).includes(subName)) return;

  subcategoryBrowseParent = parent;
  selectedSubcategoryName = subName;
  syncMainCategoryFilter(fullSubcategoryName(parent, subName));
  setSubcategoryBrowseMode(true);

  $('#catSubBrowseParent').textContent = parent;
  $('#catSubBrowseCrumb').textContent = parent;
  $('#catSubBrowseTitle').textContent = subName;
  $('#catSubBrowseList').innerHTML = (cat.sub || []).map(s => `
    <button class="cat-sub-browse-item ${s === selectedSubcategoryName ? 'active' : ''}" type="button" data-sub="${escHtml(s)}">
      <span>${escHtml(s)}</span>
      <span class="cat-log-count" title="日志数量">${cat.sub_log_counts?.[s] || 0}</span>
    </button>
  `).join('');
  await loadSubcategoryLogs(parent, subName);
}

async function refreshCategoryViews(preferredName = selectedCategoryName) {
  await loadCategories();
  selectedCategoryName = state.categories.some(c => c.name === preferredName) ? preferredName : null;
  renderParentList();
  await Promise.all([loadLogs(), loadStats()]);
}

export async function openCategoryManager() {
  await loadCategories();
  selectedCategoryName = parentFromFilter();
  subcategoryBrowseParent = null;
  selectedSubcategoryName = null;
  $('#catSearchInput').value = '';
  $('#catNewInput').value = '';
  $('#listView').style.display = 'none';
  $('#editorView').style.display = 'none';
  $('#aiChatView').style.display = 'none';
  $('#categoryView').style.display = 'flex';
  renderParentList();
  $('#catSearchInput').focus();
}

export function closeCategoryManager() {
  $('#categoryView').style.display = 'none';
  $('#aiChatView').style.display = 'none';
  $('#listView').style.display = 'flex';
  loadLogs();
  loadStats();
}

function updateFilterOnRename(oldName, newName) {
  if (state.category === oldName) state.category = newName;
  if (state.category.startsWith(oldName + '/')) state.category = newName + state.category.slice(oldName.length);
}

function clearFilterOnDelete(name) {
  if (state.category === name || state.category.startsWith(name + '/')) {
    state.category = '';
  }
}

$('#btnManageCats').addEventListener('click', openCategoryManager);
$('#btnCategoryBack').addEventListener('click', closeCategoryManager);
$('#catSearchInput').addEventListener('input', renderParentList);

$('#btnSubBrowseBack').addEventListener('click', () => {
  const parent = subcategoryBrowseParent;
  subcategoryBrowseParent = null;
  selectedSubcategoryName = null;
  selectedCategoryName = parent || selectedCategoryName;
  state.category = selectedCategoryName || '';
  $('#filterCategory').value = selectedCategoryName || '';
  populateFilterSubCategory(selectedCategoryName || null);
  $('#filterSubcategory').value = '';
  renderParentList();
});

$('#catList').addEventListener('click', async (e) => {
  const select = e.target.closest('.cat-parent-select');
  if (!select) return;
  selectedCategoryName = select.dataset.cat;
  renderParentList();
});

$('#catAddBtn').addEventListener('click', async () => {
  const input = $('#catNewInput');
  const name = input.value.trim();
  if (!name) return;
  try {
    const res = await apiFetch('/api/categories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) { const err = await res.json(); showToast(err.error, 'error'); return; }
    input.value = '';
    $('#catSearchInput').value = '';
    await refreshCategoryViews(name);
    showToast('分类已添加', 'success');
  } catch (err) { showToast('添加失败: ' + err.message, 'error'); }
});
$('#catNewInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); $('#catAddBtn').click(); }
});

$('#btnCatRename').addEventListener('click', () => {
  $('#catRenameInput').value = selectedCategoryName || '';
  $('#catRenameRow').style.display = 'flex';
  $('#catRenameInput').focus();
  $('#catRenameInput').select();
});
$('#btnCatRenameCancel').addEventListener('click', () => {
  $('#catRenameRow').style.display = 'none';
});
$('#btnCatRenameSave').addEventListener('click', async () => {
  const oldName = selectedCategoryName;
  const newName = $('#catRenameInput').value.trim();
  if (!oldName || !newName || oldName === newName) {
    $('#catRenameRow').style.display = 'none';
    return;
  }
  try {
    const res = await apiFetch(`/api/categories/${encodeURIComponent(oldName)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName }),
    });
    if (!res.ok) { const err = await res.json(); showToast(err.error, 'error'); return; }
    updateFilterOnRename(oldName, newName);
    await refreshCategoryViews(newName);
    showToast('分类已重命名', 'success');
  } catch (err) { showToast(err.message, 'error'); }
});
$('#catRenameInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); $('#btnCatRenameSave').click(); }
  if (e.key === 'Escape') { e.preventDefault(); $('#btnCatRenameCancel').click(); }
});

$('#catCalendarDayVisible').addEventListener('change', async (e) => {
  const name = selectedCategoryName;
  const visible = e.target.checked;
  if (!name) return;
  try {
    const res = await apiFetch(`/api/categories/${encodeURIComponent(name)}/calendar-day-visibility`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visible }),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || '设置失败');
    }
    await refreshCategoryViews(name);
    showToast(visible ? '日历按日查看将显示此分类日志' : '日历按日查看将隐藏此分类日志', 'success');
  } catch (err) {
    e.target.checked = !visible;
    showToast('设置失败: ' + err.message, 'error');
  }
});

$('#btnCatDelete').addEventListener('click', async () => {
  const name = selectedCategoryName;
  if (!name || name === '其他') return;
  const confirmed = await confirmDialog({
    title: '删除分类',
    message: `删除分类「${name}」及其所有子分类？已有日志将归为「其他」。`,
    confirmText: '删除',
  });
  if (!confirmed) return;
  try {
    const res = await apiFetch(`/api/categories/${encodeURIComponent(name)}`, { method: 'DELETE' });
    if (!res.ok) { showToast('删除失败', 'error'); return; }
    clearFilterOnDelete(name);
    selectedCategoryName = null;
    await refreshCategoryViews();
    showToast('分类已删除', 'success');
  } catch (err) { showToast(err.message, 'error'); }
});

$('#catSubAddBtn').addEventListener('click', async () => {
  const parent = selectedCategoryName;
  const input = $('#catSubNewInput');
  const name = input.value.trim();
  if (!parent || !name) return;
  try {
    const res = await apiFetch('/api/categories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, parent }),
    });
    if (!res.ok) { const err = await res.json(); showToast(err.error, 'error'); return; }
    await refreshCategoryViews(parent);
    showToast('子分类已添加', 'success');
  } catch (err) { showToast('添加失败: ' + err.message, 'error'); }
});
$('#catSubNewInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); $('#catSubAddBtn').click(); }
});

$('#catSubList').addEventListener('click', async (e) => {
  const item = e.target.closest('.cat-detail-sub-item');
  if (!item) return;
  const subName = item.dataset.sub;
  if (e.target.closest('.subcat-edit-btn')) {
    editingSubcategory = subName;
    item.innerHTML = `
      <input class="cat-detail-sub-input" value="${escHtml(subName)}" maxlength="20">
      <div class="cat-detail-sub-actions">
        <button class="btn-primary btn-sm subcat-save-btn" type="button">保存</button>
        <button class="btn-secondary btn-sm subcat-cancel-btn" type="button">取消</button>
      </div>
    `;
    item.querySelector('input').focus();
    item.querySelector('input').select();
    return;
  }
  if (e.target.closest('.subcat-cancel-btn')) {
    renderCategoryDetail();
    return;
  }
  if (e.target.closest('.subcat-save-btn')) {
    const newName = item.querySelector('input').value.trim();
    if (!newName || newName === subName) { renderCategoryDetail(); return; }
    try {
      const fullName = selectedCategoryName + '/' + subName;
      const res = await apiFetch(`/api/categories/${encodeURIComponent(fullName)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName }),
      });
      if (!res.ok) { const err = await res.json(); showToast(err.error, 'error'); return; }
      if (state.category === fullName) state.category = selectedCategoryName + '/' + newName;
      await refreshCategoryViews(selectedCategoryName);
      showToast('子分类已重命名', 'success');
    } catch (err) { showToast(err.message, 'error'); }
    return;
  }
  if (e.target.closest('.subcat-del-btn')) {
    const confirmed = await confirmDialog({
      title: '删除子分类',
      message: `删除子分类「${subName}」？已有日志将归为「${selectedCategoryName}」。`,
      confirmText: '删除',
    });
    if (!confirmed) return;
    try {
      const fullName = selectedCategoryName + '/' + subName;
      const res = await apiFetch(`/api/categories/${encodeURIComponent(fullName)}`, { method: 'DELETE' });
      if (!res.ok) { showToast('删除失败', 'error'); return; }
      if (state.category === fullName) state.category = selectedCategoryName;
      await refreshCategoryViews(selectedCategoryName);
      showToast('子分类已删除', 'success');
    } catch (err) { showToast(err.message, 'error'); }
    return;
  }
  await openSubcategoryBrowse(subName);
});

$('#catSubList').addEventListener('keydown', (e) => {
  const input = e.target.closest('.cat-detail-sub-input');
  if (input) {
    if (e.key === 'Enter') { e.preventDefault(); input.closest('.cat-detail-sub-item').querySelector('.subcat-save-btn').click(); }
    if (e.key === 'Escape') { e.preventDefault(); renderCategoryDetail(); }
    return;
  }
  const item = e.target.closest('.cat-detail-sub-item');
  if (item && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    openSubcategoryBrowse(item.dataset.sub);
  }
});

$('#catSubBrowseList').addEventListener('click', async (e) => {
  const item = e.target.closest('.cat-sub-browse-item');
  if (!item || !subcategoryBrowseParent) return;
  await openSubcategoryBrowse(item.dataset.sub);
});

$('#catSubLogList').addEventListener('click', async (e) => {
  const card = e.target.closest('.cat-sub-log-card');
  if (!card) return;
  const { openEditor } = await import('./editor.js');
  openEditor(parseInt(card.dataset.id, 10));
});

setupDragAndDrop({
  container: $('#catList'),
  itemSelector: '.cat-parent-item',
  getId: (el) => el.dataset.cat,
  onReorder: async (cats) => {
    if ($('#catSearchInput').value.trim()) return;
    await apiFetch('/api/categories/reorder', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderedCats: cats }),
    });
    await loadCategories();
    renderParentList();
  }
});
