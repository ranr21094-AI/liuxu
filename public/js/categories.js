import { state } from './state.js';
import { apiFetch } from './auth.js';
import { showToast, escHtml, setupDragAndDrop, confirmDialog, announce, $ } from './helpers.js';
import { loadLogs } from './logList.js';
import { loadStats } from './stats.js';

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

function getSubCount(cats) {
  return cats.reduce((sum, c) => sum + (c.sub || []).length, 0);
}

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

function updateCategorySummary(visibleCount) {
  const total = state.categories.length;
  const subTotal = getSubCount(state.categories);
  const searching = Boolean($('#catSearchInput').value.trim());
  $('#catManagerSummary').textContent = searching
    ? `显示 ${visibleCount} / ${total} 个父分类，全部 ${subTotal} 个子分类`
    : `${total} 个父分类，${subTotal} 个子分类`;
}

function isProtectedRootCategory(name) {
  return name === '其他' || name === '日记';
}

function renderParentList() {
  const cats = getVisibleCategories();
  const isSearching = Boolean($('#catSearchInput').value.trim());
  ensureSelectedCategory(cats);
  updateCategorySummary(cats.length);
  if (!cats.length) {
    $('#catList').innerHTML = state.categories.length
      ? '<div class="cat-empty">没有匹配的分类</div>'
      : '<div class="cat-empty">暂无分类，先添加一个父分类。</div>';
    renderCategoryDetail();
    return;
  }
  $('#catList').innerHTML = cats.map((c, index) => `
    <div class="cat-parent-item ${c.name === selectedCategoryName ? 'active' : ''}" data-cat="${escHtml(c.name)}" draggable="${!isSearching}">
      <span class="cat-drag-handle ${isSearching ? 'disabled' : ''}" title="${isSearching ? '搜索时暂不排序' : '拖动排序'}">⋮⋮</span>
      <button type="button" class="cat-parent-select" data-cat="${escHtml(c.name)}">
        <span class="cat-parent-name">${escHtml(c.name)}</span>
        ${isProtectedRootCategory(c.name) ? '<span class="cat-default-tag">不可删除</span>' : ''}
        <span class="cat-sub-count">${(c.sub || []).length}</span>
      </button>
      <span class="item-order-controls" aria-label="调整父分类顺序">
        <button type="button" class="btn-order" data-cat-action="move-up" aria-label="上移分类：${escHtml(c.name)}" title="${isSearching ? '搜索时不可排序' : '上移分类'}" ${isSearching || index === 0 ? 'disabled' : ''}>↑</button>
        <button type="button" class="btn-order" data-cat-action="move-down" aria-label="下移分类：${escHtml(c.name)}" title="${isSearching ? '搜索时不可排序' : '下移分类'}" ${isSearching || index === cats.length - 1 ? 'disabled' : ''}>↓</button>
      </span>
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
    <div class="cat-detail-sub-item" data-sub="${escHtml(s)}">
      <span class="cat-detail-sub-name">${escHtml(s)}</span>
      <div class="cat-detail-sub-actions">
        <button class="btn-secondary btn-sm subcat-edit-btn" type="button">重命名</button>
        <button class="btn-danger btn-sm subcat-del-btn" type="button">删除</button>
      </div>
    </div>
  `).join('');
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
  $('#catSearchInput').value = '';
  $('#catNewInput').value = '';
  $('#listView').style.display = 'none';
  $('#editorView').style.display = 'none';
  $('#categoryView').style.display = 'flex';
  renderParentList();
  $('#catSearchInput').focus();
}

export function closeCategoryManager() {
  $('#categoryView').style.display = 'none';
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

async function moveCategory(name, delta, action) {
  if ($('#catSearchInput').value.trim()) return;
  const index = state.categories.findIndex(cat => cat.name === name);
  const targetIndex = index + delta;
  if (index < 0 || targetIndex < 0 || targetIndex >= state.categories.length) return;
  const ordered = state.categories.map(cat => cat.name);
  [ordered[index], ordered[targetIndex]] = [ordered[targetIndex], ordered[index]];
  try {
    const res = await apiFetch('/api/categories/reorder', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderedCats: ordered }),
    });
    if (!res.ok) throw new Error('服务器拒绝排序请求');
    await loadCategories();
    renderParentList();
    [...$('#catList').querySelectorAll('.cat-parent-item')]
      .find(item => item.dataset.cat === name)
      ?.querySelector(`[data-cat-action="${action}"]`)
      ?.focus();
    announce(`分类「${name}」已${delta < 0 ? '上移' : '下移'}`);
  } catch (err) {
    showToast('分类排序失败: ' + err.message, 'error');
    announce('分类排序失败');
  }
}

$('#catList').addEventListener('click', async (e) => {
  const moveButton = e.target.closest('[data-cat-action]');
  if (moveButton) {
    const item = moveButton.closest('.cat-parent-item');
    await moveCategory(item.dataset.cat, moveButton.dataset.catAction === 'move-up' ? -1 : 1, moveButton.dataset.catAction);
    return;
  }
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
  }
});

$('#catSubList').addEventListener('keydown', (e) => {
  const input = e.target.closest('.cat-detail-sub-input');
  if (!input) return;
  if (e.key === 'Enter') { e.preventDefault(); input.closest('.cat-detail-sub-item').querySelector('.subcat-save-btn').click(); }
  if (e.key === 'Escape') { e.preventDefault(); renderCategoryDetail(); }
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
