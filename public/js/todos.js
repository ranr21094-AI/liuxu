import { apiFetch } from './auth.js';
import { showToast, escHtml, setupDragAndDrop, confirmDialog, openModal, closeModal, $ } from './helpers.js';
import { businessDateString } from './businessDate.js';
import { state } from './state.js';
import { renderCalendar } from './calendar.js';

const DEFAULT_TODO_CATEGORY = '待办';
const TODO_SELECT_IDS = ['todoFullCategory', 'todoFullPriority'];
let allTodos = [];
let todoCategories = [DEFAULT_TODO_CATEGORY];
let activeFilter = localStorage.getItem('todoFilter') || DEFAULT_TODO_CATEGORY;
if (activeFilter === 'all' || activeFilter === 'undated' || activeFilter === 'pending') activeFilter = DEFAULT_TODO_CATEGORY;
let selectedTodoId = null;
let todoSearchQuery = '';
let todoReminderSettings = {
  enabled: false,
  recipientEmail: '',
  sendTime: '08:00',
  mailReady: false,
  lastStatus: 'idle',
  lastSentAt: '',
  lastError: '',
};
let todoReminderUiMessage = '';

function todayString() {
  return businessDateString();
}

function normalizeTodo(todo) {
  return {
    ...todo,
    due_date: todo.due_date || '',
    priority: todo.priority || 'none',
    category: todo.category || DEFAULT_TODO_CATEGORY,
    notes: typeof todo.notes === 'string' ? todo.notes : '',
  };
}

function normalizeTodoReminderSettings(data = {}) {
  return {
    enabled: Boolean(data.enabled),
    recipientEmail: typeof data.recipientEmail === 'string' ? data.recipientEmail : '',
    sendTime: typeof data.sendTime === 'string' && data.sendTime ? data.sendTime : '08:00',
    mailReady: Boolean(data.mailReady),
    lastStatus: typeof data.lastStatus === 'string' ? data.lastStatus : 'idle',
    lastSentAt: typeof data.lastSentAt === 'string' ? data.lastSentAt : '',
    lastError: typeof data.lastError === 'string' ? data.lastError : '',
  };
}

function formatReminderDateTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
}

function renderTodoReminderSettings() {
  $('#todoReminderEnabled').checked = todoReminderSettings.enabled;
  $('#todoReminderRecipient').value = todoReminderSettings.recipientEmail || '';
  $('#todoReminderTime').value = todoReminderSettings.sendTime || '08:00';

  const chip = $('#todoReminderMailState');
  chip.textContent = todoReminderSettings.mailReady ? '可发送' : '未配置';
  chip.classList.toggle('ready', todoReminderSettings.mailReady);
  chip.classList.toggle('missing', !todoReminderSettings.mailReady);

  const statusMap = {
    idle: `系统会在每天 ${todoReminderSettings.sendTime || '08:00'} 检查当天到期待办。`,
    pending: '今日提醒已生成；若发信失败，服务会自动重试同一份汇总。',
    empty: '今天没有到期待办，本日不会发送提醒。',
    sent: todoReminderSettings.lastSentAt
      ? `最近一次提醒已发送：${formatReminderDateTime(todoReminderSettings.lastSentAt)}。`
      : '最近一次提醒已发送。',
  };
  const parts = [];
  if (!todoReminderSettings.mailReady) {
    parts.push('当前运行中的服务还没有可用的 QQ 发信配置；如果你刚修改了 .env，请重启服务后再启用提醒。');
  }
  parts.push(statusMap[todoReminderSettings.lastStatus] || statusMap.idle);
  if (todoReminderSettings.lastError) {
    parts.push(`最近错误：${todoReminderSettings.lastError}`);
  }
  if (todoReminderUiMessage) {
    parts.push(todoReminderUiMessage);
  }
  $('#todoReminderStatusText').textContent = parts.join(' ');
}

export async function loadTodos() {
  try {
    const [todosRes, categoriesRes, reminderRes] = await Promise.all([
      apiFetch('/api/todos'),
      apiFetch('/api/todo-categories'),
      apiFetch('/api/todo-reminder-settings'),
    ]);
    allTodos = (await todosRes.json()).map(normalizeTodo);
    todoCategories = normalizeTodoCategories(await categoriesRes.json());
    todoReminderSettings = normalizeTodoReminderSettings(await reminderRes.json());
    todoReminderUiMessage = '';
    if (activeFilter !== 'done' && !todoCategories.includes(activeFilter)) activeFilter = DEFAULT_TODO_CATEGORY;
    if (selectedTodoId && !allTodos.some(t => t.id === selectedTodoId)) resetTodoForm();
    refreshTodoCalendarDates();
    renderTodos();
  } catch (err) {
    console.error('Todo load failed:', err);
    showToast('加载待办失败', 'error');
  }
}

function normalizeTodoCategories(categories) {
  const names = new Set([DEFAULT_TODO_CATEGORY]);
  if (Array.isArray(categories)) {
    categories.forEach(name => {
      if (typeof name === 'string' && name.trim()) names.add(name.trim());
    });
  }
  allTodos.forEach(todo => names.add(todo.category || DEFAULT_TODO_CATEGORY));
  return [...names];
}

function todoStats() {
  const pending = allTodos.filter(t => !t.done);
  const done = allTodos.filter(t => t.done);
  const today = todayString();
  const overdue = pending.filter(t => t.due_date && t.due_date < today);
  const dueToday = pending.filter(t => t.due_date === today);
  return { pending, done, overdue, dueToday };
}

function refreshTodoCalendarDates() {
  state.datesWithTodos = [...new Set(allTodos.map(todo => todo.due_date).filter(Boolean))];
  renderCalendar();
}

function manualTodoOrder(a, b) {
  const orderDiff = (a.sort_order || 0) - (b.sort_order || 0);
  return orderDiff || ((b.id || 0) - (a.id || 0));
}

function dueDateTodoOrder(a, b) {
  const aDate = a.due_date || '9999-12-31';
  const bDate = b.due_date || '9999-12-31';
  if (aDate !== bDate) return aDate.localeCompare(bDate);
  return manualTodoOrder(a, b);
}

function sortTodosForView(todos, mode) {
  const list = [...todos];
  if (mode === 'done' || todoCategories.includes(mode)) return list.sort(dueDateTodoOrder);
  return list.sort(manualTodoOrder);
}

function todoSelectControls() {
  return TODO_SELECT_IDS
    .map(id => document.querySelector(`[data-todo-select-control][data-select-id="${id}"]`))
    .filter(Boolean);
}

function closeTodoSelectControl(control) {
  if (!control) return;
  control.classList.remove('open');
  control.querySelector('.todo-select-trigger')?.setAttribute('aria-expanded', 'false');
  const menu = control.querySelector('.todo-select-menu');
  if (menu) menu.hidden = true;
}

function closeTodoSelectControls(except = null) {
  todoSelectControls().forEach(control => {
    if (control !== except) closeTodoSelectControl(control);
  });
}

function selectFromTodoOption(control, optionButton) {
  const select = document.getElementById(control.dataset.selectId);
  if (!select || !optionButton) return;
  select.value = optionButton.dataset.value || '';
  closeTodoSelectControl(control);
  select.dispatchEvent(new Event('change', { bubbles: true }));
  syncTodoSelectControls();
  control.querySelector('.todo-select-trigger')?.focus();
}

function focusTodoOption(control, direction = 1) {
  const options = [...control.querySelectorAll('.todo-select-option')];
  if (!options.length) return;
  const activeIndex = options.indexOf(document.activeElement);
  const selectedIndex = options.findIndex(option => option.getAttribute('aria-selected') === 'true');
  const baseIndex = activeIndex >= 0 ? activeIndex : (selectedIndex >= 0 ? selectedIndex : 0);
  const nextIndex = (baseIndex + direction + options.length) % options.length;
  options[nextIndex].focus();
}

function openTodoSelectControl(control, { focusSelected = false } = {}) {
  const trigger = control.querySelector('.todo-select-trigger');
  const menu = control.querySelector('.todo-select-menu');
  if (!trigger || !menu) return;
  syncTodoSelectControls();
  closeTodoSelectControls(control);
  control.classList.add('open');
  trigger.setAttribute('aria-expanded', 'true');
  menu.hidden = false;
  if (focusSelected) {
    const selected = menu.querySelector('.todo-select-option[aria-selected="true"]');
    (selected || menu.querySelector('.todo-select-option'))?.focus();
  }
}

function toggleTodoSelectControl(control) {
  if (control.classList.contains('open')) closeTodoSelectControl(control);
  else openTodoSelectControl(control);
}

function syncTodoSelectControls() {
  todoSelectControls().forEach(control => {
    const select = document.getElementById(control.dataset.selectId);
    const trigger = control.querySelector('.todo-select-trigger');
    const value = control.querySelector('.todo-select-value');
    const menu = control.querySelector('.todo-select-menu');
    if (!select || !trigger || !value || !menu) return;

    const options = [...select.options];
    const selected = select.selectedOptions[0] || options.find(option => option.value === select.value) || options[0];
    const hasValue = Boolean(select.value && select.value !== 'none');
    value.textContent = selected?.textContent || '';
    control.classList.toggle('has-value', hasValue);
    trigger.setAttribute('aria-label', `${select.labels?.[0]?.textContent || '选择'}：${selected?.textContent || '未选择'}`);
    menu.innerHTML = options.map(option => `
      <button
        class="todo-select-option${option.value === select.value ? ' selected' : ''}"
        type="button"
        role="option"
        data-value="${escHtml(option.value)}"
        aria-selected="${option.value === select.value}"
        tabindex="-1"
      >${escHtml(option.textContent)}</button>
    `).join('');
  });
}

function initTodoSelectControls() {
  todoSelectControls().forEach(control => {
    const trigger = control.querySelector('.todo-select-trigger');
    const menu = control.querySelector('.todo-select-menu');
    trigger?.addEventListener('click', () => toggleTodoSelectControl(control));
    trigger?.addEventListener('keydown', (event) => {
      if (!['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) return;
      event.preventDefault();
      openTodoSelectControl(control, { focusSelected: true });
      if (event.key === 'ArrowUp') focusTodoOption(control, -1);
    });
    menu?.addEventListener('click', (event) => {
      const option = event.target.closest('.todo-select-option');
      if (option) selectFromTodoOption(control, option);
    });
    menu?.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        focusTodoOption(control, 1);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        focusTodoOption(control, -1);
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        selectFromTodoOption(control, event.target.closest('.todo-select-option'));
      } else if (event.key === 'Escape') {
        event.preventDefault();
        closeTodoSelectControl(control);
        trigger?.focus();
      }
    });
  });
  document.addEventListener('click', (event) => {
    if (!event.target.closest('[data-todo-select-control]')) closeTodoSelectControls();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeTodoSelectControls();
  });
  syncTodoSelectControls();
}

function dueHtml(todo) {
  if (!todo.due_date) return '';
  const today = todayString();
  const isOverdue = !todo.done && todo.due_date < today;
  const isToday = todo.due_date === today;
  const cls = isOverdue ? 'due-overdue' : (isToday ? 'due-today' : 'due-future');
  return `<span class="todo-due ${cls}">${todo.due_date.substring(5)}</span>`;
}

function priorityBadge(todo) {
  const labels = { normal: 'P2 普通', important: 'P1 重要', urgent: 'P0 紧急' };
  const codes = { normal: 'P2', important: 'P1', urgent: 'P0' };
  return todo.priority && todo.priority !== 'none'
    ? `<span class="todo-priority prio-${todo.priority}" title="${labels[todo.priority] || todo.priority}">${codes[todo.priority] || ''}</span>`
    : '';
}

function todoItemHtml(todo, { full = false } = {}) {
  const selected = full && selectedTodoId === todo.id ? ' selected' : '';
  const title = escHtml(todo.title);
  const category = todo.category && todo.category !== DEFAULT_TODO_CATEGORY
    ? `<span class="todo-category-badge">${escHtml(todo.category)}</span>`
    : '';
  return `
    <div class="todo-item${selected}" data-id="${todo.id}" draggable="true">
      <div class="todo-drag" data-action="drag" title="拖动排序">⠿</div>
      <button type="button" class="todo-checkbox ${todo.done ? 'done' : ''}" data-action="toggle" role="checkbox" aria-checked="${todo.done}" aria-label="${todo.done ? '标记为未完成' : '标记为已完成'}：${title}"></button>
      <span class="todo-text ${todo.done ? 'done' : ''}">${priorityBadge(todo)}${category}${title}${dueHtml(todo)}</span>
      <button type="button" class="todo-delete" data-action="delete" aria-label="删除任务：${title}" title="删除">×</button>
    </div>
  `;
}

function filteredTodos() {
  let items = allTodos;
  if (activeFilter === 'done') items = items.filter(t => t.done);
  else items = items.filter(t => !t.done && (t.category || DEFAULT_TODO_CATEGORY) === activeFilter);
  const query = todoSearchQuery.trim().toLowerCase();
  if (query) {
    items = items.filter(t =>
      String(t.title || '').toLowerCase().includes(query) ||
      String(t.notes || '').toLowerCase().includes(query)
    );
  }
  return sortTodosForView(items, activeFilter);
}

function renderTodoCategorySelect(selected = DEFAULT_TODO_CATEGORY) {
  const select = $('#todoFullCategory');
  select.innerHTML = todoCategories
    .map(category => `<option value="${escHtml(category)}">${escHtml(category)}</option>`)
    .join('');
  select.value = todoCategories.includes(selected) ? selected : DEFAULT_TODO_CATEGORY;
  syncTodoSelectControls();
}

function renderTodoFilterTabs() {
  const tabs = $('#todoFilterTabs');
  const categoryButtons = todoCategories.map(category => {
    const selected = activeFilter === category;
    const removable = category !== DEFAULT_TODO_CATEGORY;
    return `
      <button class="todo-filter-pill${selected ? ' active' : ''}" data-filter="${escHtml(category)}" role="tab" aria-selected="${selected}">
        <span class="todo-filter-label">${escHtml(category)}</span>
        ${removable ? `
          <span
            class="todo-category-remove"
            role="button"
            tabindex="0"
            data-action="delete-category"
            data-category="${escHtml(category)}"
            aria-label="删除分类：${escHtml(category)}"
            title="删除分类"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 7h16"></path>
              <path d="M10 11v6"></path>
              <path d="M14 11v6"></path>
              <path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"></path>
              <path d="M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3"></path>
            </svg>
          </span>
        ` : ''}
      </button>
    `;
  }).join('');
  const doneSelected = activeFilter === 'done';
  tabs.innerHTML = `${categoryButtons}
    <button class="todo-filter-pill${doneSelected ? ' active' : ''}" data-filter="done" role="tab" aria-selected="${doneSelected}"><span class="todo-filter-label">已完成</span></button>`;
}

function sectionHtml(title, todos, { action = '' } = {}) {
  if (todos.length === 0) return '';
  return `
    <div class="todo-section-title">
      <span>${escHtml(title)}</span>
      ${action}
    </div>
    ${todos.map(t => todoItemHtml(t, { full: true })).join('')}
  `;
}

function renderFullTodos() {
  const { pending, done, overdue, dueToday } = todoStats();
  $('#todoStatPending').textContent = pending.length;
  $('#todoStatToday').textContent = dueToday.length;
  $('#todoStatOverdue').textContent = overdue.length;
  $('#todoStatDone').textContent = done.length;
  renderTodoFilterTabs();
  renderTodoCategorySelect($('#todoFullCategory').value || DEFAULT_TODO_CATEGORY);

  const list = $('#todoFullList');
  const todos = filteredTodos();
  if (todos.length === 0) {
    list.innerHTML = `<div class="todo-empty">${activeFilter === 'done' ? '当前没有已完成待办' : `「${escHtml(activeFilter)}」下没有待办`}</div>`;
    return;
  }

  if (activeFilter === 'done') {
    const clearAction = done.length > 0
      ? '<button class="btn-todo-clear todo-section-clear" type="button" data-action="clear-completed">清除已完成</button>'
      : '';
    list.innerHTML = sectionHtml('已完成', todos, { action: clearAction });
  } else {
    list.innerHTML = sectionHtml(activeFilter === DEFAULT_TODO_CATEGORY ? '待办' : activeFilter, todos);
  }
}

function renderTodos() {
  renderFullTodos();
  renderTodoReminderSettings();
}

export function showTodoView() {
  $('#listView').style.display = 'none';
  $('#editorView').style.display = 'none';
  $('#categoryView').style.display = 'none';
  $('#aiChatView').style.display = 'none';
  $('#aiSettingsView').style.display = 'none';
  $('#todoView').style.display = 'flex';
  refreshTodoCalendarDates();
  renderTodos();
  requestAnimationFrame(() => $('#todoSearchInput')?.focus());
}

function resetTodoForm() {
  selectedTodoId = null;
  $('#todoEditId').value = '';
  $('#todoFullTitle').value = '';
  renderTodoCategorySelect(DEFAULT_TODO_CATEGORY);
  $('#todoFullDueDate').value = '';
  $('#todoFullPriority').value = 'none';
  $('#todoFullNotes').value = '';
  $('#btnTodoFullSave').textContent = '保存任务';
  syncTodoSelectControls();
}

function fillTodoForm(todo) {
  selectedTodoId = todo.id;
  $('#todoEditId').value = todo.id;
  $('#todoFullTitle').value = todo.title || '';
  renderTodoCategorySelect(todo.category || DEFAULT_TODO_CATEGORY);
  $('#todoFullDueDate').value = todo.due_date || '';
  $('#todoFullPriority').value = todo.priority || 'none';
  $('#todoFullNotes').value = todo.notes || '';
  $('#btnTodoFullSave').textContent = '更新任务';
  renderFullTodos();
  $('#todoFullTitle').focus();
  $('#todoFullTitle').select();
}

async function saveTodoFromFullForm() {
  const title = $('#todoFullTitle').value.trim();
  if (!title) {
    showToast('请输入任务标题', 'error');
    return;
  }
  const id = parseInt($('#todoEditId').value, 10);
  const body = {
    title,
    category: $('#todoFullCategory').value || DEFAULT_TODO_CATEGORY,
    due_date: $('#todoFullDueDate').value || null,
    priority: $('#todoFullPriority').value || 'none',
    notes: $('#todoFullNotes').value,
  };
  try {
    if (id) {
      await apiFetch(`/api/todos/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      showToast('任务已更新', 'success');
    } else {
      await apiFetch('/api/todos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      showToast('任务已添加', 'success');
    }
    resetTodoForm();
    await loadTodos();
  } catch (err) {
    showToast('保存失败: ' + err.message, 'error');
  }
}

function openTodoCategoryModal() {
  $('#todoCategoryInput').value = '';
  openModal($('#todoCategoryOverlay'), '#todoCategoryInput');
}

function closeTodoCategoryModal() {
  $('#todoCategoryInput').value = '';
  closeModal($('#todoCategoryOverlay'));
}

async function addTodoCategoryFromForm(event) {
  event.preventDefault();
  const input = $('#todoCategoryInput');
  const name = input.value.trim();
  if (!name) return;
  try {
    const res = await apiFetch('/api/todo-categories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const body = await res.json();
    todoCategories = normalizeTodoCategories(body.categories || [body.category]);
    activeFilter = body.category || name;
    localStorage.setItem('todoFilter', activeFilter);
    input.value = '';
    closeTodoCategoryModal();
    renderTodos();
    showToast('待办分类已添加', 'success');
  } catch (err) {
    showToast('添加分类失败: ' + err.message, 'error');
  }
}

async function deleteTodoCategory(name) {
  const confirmed = await confirmDialog({
    title: '删除待办分类',
    message: `删除分类「${name}」？该分类下的未完成待办会移动到「${DEFAULT_TODO_CATEGORY}」。`,
    confirmText: '删除',
  });
  if (!confirmed) return;
  try {
    await apiFetch(`/api/todo-categories/${encodeURIComponent(name)}`, { method: 'DELETE' });
    if (activeFilter === name) activeFilter = DEFAULT_TODO_CATEGORY;
    localStorage.setItem('todoFilter', activeFilter);
    await loadTodos();
    showToast('待办分类已删除', 'success');
  } catch (err) {
    showToast('删除分类失败: ' + err.message, 'error');
  }
}

async function toggleTodo(id) {
  const todo = allTodos.find(t => t.id === id);
  if (!todo) return;
  await apiFetch(`/api/todos/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ done: !todo.done }),
  });
  await loadTodos();
}

async function deleteTodo(id) {
  const todo = allTodos.find(t => t.id === id);
  const confirmed = await confirmDialog({
    title: '删除待办',
    message: `删除待办「${todo?.title || ''}」？`,
    confirmText: '删除',
  });
  if (!confirmed) return;
  await apiFetch(`/api/todos/${id}`, { method: 'DELETE' });
  if (selectedTodoId === id) resetTodoForm();
  await loadTodos();
}

async function clearCompletedTodos() {
  const confirmed = await confirmDialog({
    title: '清除已完成',
    message: '清除所有已完成待办，此操作不可撤销。',
    confirmText: '清除',
  });
  if (!confirmed) return;
  try {
    await apiFetch('/api/todos/completed', { method: 'DELETE' });
    resetTodoForm();
    await loadTodos();
  } catch (err) {
    showToast('清除失败: ' + err.message, 'error');
  }
}

async function saveTodoReminderSettings() {
  const body = {
    enabled: $('#todoReminderEnabled').checked,
    recipientEmail: $('#todoReminderRecipient').value.trim(),
    sendTime: $('#todoReminderTime').value || '08:00',
  };
  try {
    const res = await apiFetch('/api/todo-reminder-settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '保存提醒失败');
    todoReminderSettings = normalizeTodoReminderSettings(data);
    todoReminderUiMessage = '提醒设置已保存。';
    renderTodoReminderSettings();
    showToast('提醒设置已保存', 'success');
  } catch (err) {
    todoReminderUiMessage = '保存失败：' + err.message;
    renderTodoReminderSettings();
    showToast('提醒保存失败: ' + err.message, 'error');
  }
}

async function handleTodoListClick(e, { full = false } = {}) {
  if (e.target.dataset.action === 'drag') return;
  if (e.target.closest('[data-action="clear-completed"]')) {
    await clearCompletedTodos();
    return;
  }
  const item = e.target.closest('.todo-item');
  if (!item) return;
  const id = parseInt(item.dataset.id, 10);
  const action = e.target.dataset.action;

  try {
    if (action === 'toggle' || e.target.classList.contains('todo-checkbox')) {
      await toggleTodo(id);
      return;
    }
    if (action === 'delete') {
      await deleteTodo(id);
      return;
    }
    if (full) {
      const todo = allTodos.find(t => t.id === id);
      if (todo) fillTodoForm(todo);
    }
  } catch (err) {
    showToast('操作失败: ' + err.message, 'error');
  }
}

$('#todoFullList').addEventListener('click', (e) => handleTodoListClick(e, { full: true }));

function setupTodoDrag(container) {
  setupDragAndDrop({
    container,
    itemSelector: '.todo-item',
    getId: (el) => parseInt(el.dataset.id, 10),
    onReorder: async (ids) => {
      await apiFetch('/api/todos/reorder', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderedIds: ids }),
      });
      await loadTodos();
    },
  });
}

setupTodoDrag($('#todoFullList'));

$('#btnTodoFullSave').addEventListener('click', saveTodoFromFullForm);
$('#btnTodoFormCancel').addEventListener('click', resetTodoForm);
$('#btnTodoReminderSave').addEventListener('click', saveTodoReminderSettings);
$('#todoReminderEnabled').addEventListener('change', (e) => {
  if (!todoReminderSettings.mailReady && e.target.checked) {
    e.target.checked = false;
    todoReminderUiMessage = '请先配置 QQ 发信账号并重启当前服务，再启用每日提醒。';
    renderTodoReminderSettings();
    showToast('请先重启服务以加载 QQ 邮件配置', 'error');
  } else {
    todoReminderSettings.enabled = e.target.checked;
    todoReminderUiMessage = '';
    renderTodoReminderSettings();
  }
});
$('#todoFullTitle').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); saveTodoFromFullForm(); }
});
$('#todoFilterTabs').addEventListener('click', (e) => {
  const deleteAction = e.target.closest('[data-action="delete-category"]');
  if (deleteAction) {
    e.stopPropagation();
    deleteTodoCategory(deleteAction.dataset.category);
    return;
  }
  const btn = e.target.closest('button[data-filter]');
  if (!btn) return;
  activeFilter = btn.dataset.filter;
  localStorage.setItem('todoFilter', activeFilter);
  renderFullTodos();
});

$('#todoFilterTabs').addEventListener('keydown', (e) => {
  const deleteAction = e.target.closest('[data-action="delete-category"]');
  if (!deleteAction || (e.key !== 'Enter' && e.key !== ' ')) return;
  e.preventDefault();
  e.stopPropagation();
  deleteTodoCategory(deleteAction.dataset.category);
});

$('#todoSearchInput').addEventListener('input', (e) => {
  todoSearchQuery = e.target.value || '';
  renderFullTodos();
});

$('#btnTodoCategoryOpen').addEventListener('click', openTodoCategoryModal);
$('#btnTodoCategoryClose').addEventListener('click', closeTodoCategoryModal);
$('#btnTodoCategoryCancel').addEventListener('click', closeTodoCategoryModal);
$('#todoCategoryOverlay').addEventListener('click', (e) => {
  if (e.target === $('#todoCategoryOverlay')) closeTodoCategoryModal();
});
$('#todoCategoryOverlay').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeTodoCategoryModal();
});
$('#todoCategoryAddForm').addEventListener('submit', addTodoCategoryFromForm);
initTodoSelectControls();
