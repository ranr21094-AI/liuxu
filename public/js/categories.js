import { state } from './state.js';
import { apiFetch } from './auth.js';
import { showToast, escHtml, setupDragAndDrop, confirmDialog, $ } from './helpers.js';
import { loadLogs, syncArchiveFilterControls } from './logList.js';
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
  syncArchiveFilterControls();
}

export function populateFilterSubCategory(parent) {
  const sel = $('#filterSubcategory');
  if (!parent) {
    sel.style.display = 'none';
    sel.value = '';
    syncArchiveFilterControls();
    return;
  }
  const cat = state.categories.find(c => c.name === parent);
  if (!cat || !cat.sub || cat.sub.length === 0) {
    sel.style.display = 'none';
    sel.value = '';
    syncArchiveFilterControls();
    return;
  }
  const current = state.category.startsWith(parent + '/') ? state.category.slice(parent.length + 1) : '';
  sel.innerHTML = '<option value="">全部二级</option>' +
    cat.sub.map(s => `<option value="${escHtml(s)}">${escHtml(s)}</option>`).join('');
  sel.style.display = '';
  if (cat.sub.includes(current)) sel.value = current;
  syncArchiveFilterControls();
}

export function populateEditorParentCategory() {
  const sel = $('#editCategory');
  const current = sel.value;
  sel.innerHTML = state.categories.map(c => `<option value="${escHtml(c.name)}">${escHtml(c.name)}</option>`).join('');
  if (state.categories.some(c => c.name === current)) sel.value = current;
  // Update subcategory dropdown for the selected parent
  const parent = sel.value || (state.categories[0] && state.categories[0].name);
  if (parent) populateEditorSubCategory(parent);
  document.dispatchEvent(new CustomEvent('editor-category-options-changed'));
}

export function populateEditorSubCategory(parent) {
  const sel = $('#editSubcategory');
  const current = sel.value;
  const cat = state.categories.find(c => c.name === parent);
  sel.innerHTML = '<option value="">（无）</option>' +
    (cat && cat.sub ? cat.sub.map(s => `<option value="${escHtml(s)}">${escHtml(s)}</option>`).join('') : '');
  if (cat && cat.sub && cat.sub.includes(current)) sel.value = current;
  document.dispatchEvent(new CustomEvent('editor-category-options-changed'));
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
  syncArchiveFilterControls();
}

function setSubcategoryBrowseMode(enabled) {
  $('#categoryView').classList.toggle('sub-browse-mode', enabled);
  $('#catList').style.display = '';
  $('#catSubBrowseSidebar').style.display = enabled ? 'flex' : 'none';
  $('#catDetailEmpty').style.display = enabled ? 'none' : '';
  $('#catSubBrowseContent').style.display = enabled ? 'flex' : 'none';
}

function setCategoryAddPanel(open) {
  const panel = $('#catAddPanel');
  panel.hidden = !open;
  $('#catAddToggle').classList.toggle('active', open);
  $('#catAddToggle').setAttribute('aria-expanded', open ? 'true' : 'false');
  if (open) {
    $('#catNewInput').focus();
    $('#catNewInput').select();
  } else {
    $('#catNewInput').value = '';
  }
}

async function selectParentCategory(parentName) {
  selectedCategoryName = parentName || null;
  subcategoryBrowseParent = null;
  selectedSubcategoryName = null;
  renderParentList();
  if (!selectedCategoryName) {
    syncMainCategoryFilter('');
    renderNoCategoryState();
    return;
  }
  await openSubcategoryBrowse();
}

function renderParentList() {
  const cats = getVisibleCategories();
  const isSearching = Boolean($('#catSearchInput').value.trim());
  ensureSelectedCategory(cats);
  if (!cats.length) {
    $('#catList').innerHTML = state.categories.length
      ? '<div class="cat-empty">没有匹配的分类</div>'
      : '<div class="cat-empty">暂无分类，先添加一个一级分类。</div>';
    return;
  }
  $('#catList').innerHTML = cats.map(c => `
    <div class="cat-parent-item ${c.name === selectedCategoryName ? 'active' : ''}" data-cat="${escHtml(c.name)}" draggable="${!isSearching}">
      <span class="cat-drag-handle ${isSearching ? 'disabled' : ''}" title="${isSearching ? '搜索时暂不排序' : '拖动排序'}">⋮⋮</span>
      <button type="button" class="cat-parent-select" data-cat="${escHtml(c.name)}">
        <span class="cat-parent-main">
          <span class="cat-parent-name">${escHtml(c.name)}</span>
          ${isProtectedRootCategory(c.name) ? '<span class="cat-default-tag">不可删除</span>' : ''}
        </span>
      </button>
      ${c.name === selectedCategoryName ? `
        <span class="cat-parent-actions">
          ${c.name === '日记' ? '' : `<button class="cat-icon-action cat-parent-rename-btn" type="button" data-cat-parent-action="rename" aria-label="重命名一级分类：${escHtml(c.name)}" title="重命名一级分类">${categoryIconSvg('edit')}</button>`}
          ${isProtectedRootCategory(c.name) ? '' : `<button class="cat-icon-action danger cat-parent-delete-btn" type="button" data-cat-parent-action="delete" aria-label="删除一级分类：${escHtml(c.name)}" title="删除一级分类">${categoryIconSvg('trash')}</button>`}
        </span>
      ` : ''}
    </div>
  `).join('');
}

function renderNoCategoryState(message = '选择一个一级分类进行管理') {
  setSubcategoryBrowseMode(false);
  $('#catDetailEmpty').textContent = message;
}

function categoryIconSvg(name) {
  if (name === 'trash') {
    return `
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 7h16"></path>
        <path d="M10 11v6"></path>
        <path d="M14 11v6"></path>
        <path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"></path>
        <path d="M9 7V4h6v3"></path>
      </svg>
    `;
  }
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 20h4.6L18.7 9.9a2.1 2.1 0 0 0 0-3L17.1 5.3a2.1 2.1 0 0 0-3 0L4 15.4V20Z"></path>
      <path d="m12.8 6.6 4.6 4.6"></path>
    </svg>
  `;
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
      list.innerHTML = `<div class="cat-sub-log-empty">二级分类「${escHtml(sub)}」暂无日志</div>`;
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

function renderSubcategoryWorkspace(cat, subName) {
  const subs = cat.sub || [];
  setSubcategoryBrowseMode(true);
  $('#catSubBrowseParent').textContent = cat.name;
  $('#catSubBrowseCrumb').textContent = cat.name;
  $('#catDetailSubCount').textContent = `${subs.length} 个`;
  $('#catCalendarDayVisible').checked = cat.calendar_day_visible !== false;
  $('#catCalendarDayVisible').setAttribute(
    'aria-label',
    `${cat.name}：点击日历日期时显示日志`
  );
  $('#catSubNewInput').value = '';
  $('#catSubBrowseList').innerHTML = subs.length ? subs.map(s => `
    <div class="cat-sub-browse-item ${s === subName ? 'active' : ''}" tabindex="0" role="button" draggable="true" data-sub="${escHtml(s)}" aria-label="浏览二级分类：${escHtml(s)}">
      <span class="cat-sub-drag-handle" aria-hidden="true">⋮⋮</span>
      <span class="cat-sub-browse-name">${escHtml(s)}</span>
      <span class="cat-log-count" title="日志数量">${cat.sub_log_counts?.[s] || 0}</span>
      <span class="cat-detail-sub-actions">
        <button class="cat-icon-action subcat-edit-btn" type="button" aria-label="重命名二级分类：${escHtml(s)}" title="重命名二级分类">${categoryIconSvg('edit')}</button>
        <button class="cat-icon-action danger subcat-del-btn" type="button" aria-label="删除二级分类：${escHtml(s)}" title="删除二级分类">${categoryIconSvg('trash')}</button>
      </span>
    </div>
  `).join('') : '<div class="cat-sub-empty">暂无二级分类，先在上方新增一个。</div>';
}

function renderSubcategoryEmpty(parent) {
  $('#catSubBrowseTitle').textContent = '暂无二级分类';
  $('#catSubBrowseLogCount').textContent = '0';
  $('#catSubBrowseLogCount').setAttribute('aria-label', `${parent} 二级分类日志数量：0`);
  $('#catSubLogList').innerHTML = '<div class="cat-sub-log-empty">先新增二级分类，再浏览对应日志。</div>';
}

async function openSubcategoryBrowse(subName = '') {
  const parent = selectedCategoryName;
  const cat = state.categories.find(c => c.name === parent);
  if (!parent || !cat) {
    renderNoCategoryState();
    return;
  }

  subcategoryBrowseParent = parent;
  const subs = cat.sub || [];
  const targetSub = subs.includes(subName) ? subName : (subs[0] || '');
  selectedSubcategoryName = targetSub || null;
  syncMainCategoryFilter(targetSub ? fullSubcategoryName(parent, targetSub) : parent);
  renderParentList();
  renderSubcategoryWorkspace(cat, targetSub);
  if (!targetSub) {
    renderSubcategoryEmpty(parent);
    return;
  }
  $('#catSubBrowseTitle').textContent = targetSub;
  await loadSubcategoryLogs(parent, targetSub);
}

async function refreshCategoryViews(preferredName = selectedCategoryName, preferredSub = selectedSubcategoryName) {
  await loadCategories();
  selectedCategoryName = state.categories.some(c => c.name === preferredName) ? preferredName : null;
  renderParentList();
  if (selectedCategoryName) {
    await openSubcategoryBrowse(preferredSub || '');
  } else {
    renderNoCategoryState();
  }
  await Promise.all([loadLogs(), loadStats()]);
}

export async function openCategoryManager() {
  await loadCategories();
  const activeCategory = state.category || '';
  const [activeParent = '', ...activeSubParts] = activeCategory.split('/');
  selectedCategoryName = state.categories.some(c => c.name === activeParent) ? activeParent : parentFromFilter();
  subcategoryBrowseParent = null;
  selectedSubcategoryName = activeSubParts.join('/') || null;
  $('#catSearchInput').value = '';
  setCategoryAddPanel(false);
  $('#listView').style.display = 'none';
  $('#editorView').style.display = 'none';
  $('#aiChatView').style.display = 'none';
  $('#aiSettingsView').style.display = 'none';
  $('#todoView').style.display = 'none';
  $('#photoWallView').style.display = 'none';
  $('#categoryView').style.display = 'flex';
  renderParentList();
  if (selectedCategoryName) {
    await openSubcategoryBrowse(selectedSubcategoryName || '');
  } else {
    renderNoCategoryState();
  }
  $('#catSearchInput').focus();
}

export function closeCategoryManager() {
  $('#categoryView').style.display = 'none';
  $('#aiChatView').style.display = 'none';
  $('#aiSettingsView').style.display = 'none';
  $('#todoView').style.display = 'none';
  $('#photoWallView').style.display = 'none';
  $('#listView').style.display = 'flex';
  loadLogs();
  loadStats();
  window.dispatchEvent(new CustomEvent('category-manager-closed'));
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

$('#catSearchInput').addEventListener('input', async () => {
  renderParentList();
  if (selectedCategoryName) await openSubcategoryBrowse(selectedSubcategoryName || '');
  else renderNoCategoryState();
});

$('#catAddToggle').addEventListener('click', () => {
  setCategoryAddPanel($('#catAddPanel').hidden);
});

$('#catAddCancelBtn').addEventListener('click', () => {
  setCategoryAddPanel(false);
});

$('#catList').addEventListener('click', async (e) => {
  const parentAction = e.target.closest('[data-cat-parent-action]');
  if (parentAction) {
    e.preventDefault();
    e.stopPropagation();
    if (parentAction.dataset.catParentAction === 'rename') return openParentRename();
    if (parentAction.dataset.catParentAction === 'delete') return deleteSelectedParentCategory();
  }
  const select = e.target.closest('.cat-parent-select');
  if (!select) return;
  await selectParentCategory(select.dataset.cat);
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
    setCategoryAddPanel(false);
    $('#catSearchInput').value = '';
    await refreshCategoryViews(name);
    showToast('分类已添加', 'success');
  } catch (err) { showToast('添加失败: ' + err.message, 'error'); }
});
$('#catNewInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); $('#catAddBtn').click(); }
  if (e.key === 'Escape') { e.preventDefault(); setCategoryAddPanel(false); }
});

function openParentRename() {
  $('#catRenameInput').value = selectedCategoryName || '';
  $('#catRenameRow').style.display = 'grid';
  $('#catRenameInput').focus();
  $('#catRenameInput').select();
}

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
    await refreshCategoryViews(newName, selectedSubcategoryName);
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

async function deleteSelectedParentCategory() {
  const name = selectedCategoryName;
  if (!name || name === '其他') return;
  const confirmed = await confirmDialog({
    title: '删除分类',
    message: `删除分类「${name}」及其所有二级分类？已有日志将归为「其他」。`,
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
}

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
    await refreshCategoryViews(parent, name);
    showToast('二级分类已添加', 'success');
  } catch (err) { showToast('添加失败: ' + err.message, 'error'); }
});
$('#catSubNewInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); $('#catSubAddBtn').click(); }
});

$('#catSubBrowseList').addEventListener('click', async (e) => {
  const item = e.target.closest('.cat-sub-browse-item');
  if (!item) return;
  const subName = item.dataset.sub;
  if (e.target.closest('.cat-detail-sub-input')) return;
  if (e.target.closest('.subcat-edit-btn')) {
    editingSubcategory = subName;
    item.draggable = false;
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
    await openSubcategoryBrowse(selectedSubcategoryName || subName);
    return;
  }
  if (e.target.closest('.subcat-save-btn')) {
    const newName = item.querySelector('input').value.trim();
    if (!newName || newName === subName) { await openSubcategoryBrowse(selectedSubcategoryName || subName); return; }
    try {
      const fullName = selectedCategoryName + '/' + subName;
      const res = await apiFetch(`/api/categories/${encodeURIComponent(fullName)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName }),
      });
      if (!res.ok) { const err = await res.json(); showToast(err.error, 'error'); return; }
      if (state.category === fullName) state.category = selectedCategoryName + '/' + newName;
      await refreshCategoryViews(selectedCategoryName, newName);
      showToast('二级分类已重命名', 'success');
    } catch (err) { showToast(err.message, 'error'); }
    return;
  }
  if (e.target.closest('.subcat-del-btn')) {
    const confirmed = await confirmDialog({
      title: '删除二级分类',
      message: `删除二级分类「${subName}」？已有日志将归为「${selectedCategoryName}」。`,
      confirmText: '删除',
    });
    if (!confirmed) return;
    try {
      const fullName = selectedCategoryName + '/' + subName;
      const res = await apiFetch(`/api/categories/${encodeURIComponent(fullName)}`, { method: 'DELETE' });
      if (!res.ok) { showToast('删除失败', 'error'); return; }
      if (state.category === fullName) state.category = selectedCategoryName;
      await refreshCategoryViews(selectedCategoryName, '');
      showToast('二级分类已删除', 'success');
    } catch (err) { showToast(err.message, 'error'); }
    return;
  }
  await openSubcategoryBrowse(subName);
});

$('#catSubBrowseList').addEventListener('keydown', async (e) => {
  const input = e.target.closest('.cat-detail-sub-input');
  if (input) {
    if (e.key === 'Enter') { e.preventDefault(); input.closest('.cat-sub-browse-item').querySelector('.subcat-save-btn').click(); }
    if (e.key === 'Escape') { e.preventDefault(); await openSubcategoryBrowse(selectedSubcategoryName || ''); }
    return;
  }
  const item = e.target.closest('.cat-sub-browse-item');
  if (item && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    await openSubcategoryBrowse(item.dataset.sub);
  }
});

$('#catSubLogList').addEventListener('click', async (e) => {
  const card = e.target.closest('.cat-sub-log-card');
  if (!card) return;
  const { openEditor } = await import('./editor.js');
  openEditor(parseInt(card.dataset.id, 10));
  window.dispatchEvent(new CustomEvent('category-log-opened'));
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

setupDragAndDrop({
  container: $('#catSubBrowseList'),
  itemSelector: '.cat-sub-browse-item',
  getId: (el) => el.dataset.sub,
  onReorder: async (subs) => {
    if (!selectedCategoryName || editingSubcategory) return;
    await apiFetch(`/api/categories/${encodeURIComponent(selectedCategoryName)}/subcategories/reorder`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderedSubs: subs }),
    });
    await loadCategories();
    await openSubcategoryBrowse(selectedSubcategoryName || '');
  }
});
