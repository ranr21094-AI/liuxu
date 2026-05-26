import { apiFetch } from './auth.js';
import { showToast, escHtml, setupDragAndDrop, confirmDialog, announce, $ } from './helpers.js';
import { businessDateString } from './businessDate.js';

let allTodos = [];
let activeFilter = localStorage.getItem('todoFilter') || 'pending';
if (!['pending', 'all', 'done'].includes(activeFilter)) activeFilter = 'pending';
let selectedTodoId = null;

function todayString() {
  return businessDateString();
}

function normalizeTodo(todo) {
  return {
    ...todo,
    due_date: todo.due_date || '',
    priority: todo.priority || 'normal',
    notes: typeof todo.notes === 'string' ? todo.notes : '',
  };
}

export async function loadTodos() {
  try {
    const res = await apiFetch('/api/todos');
    allTodos = (await res.json()).map(normalizeTodo);
    if (selectedTodoId && !allTodos.some(t => t.id === selectedTodoId)) resetTodoForm();
    renderTodos();
  } catch (err) {
    console.error('Todo load failed:', err);
    showToast('加载待办失败', 'error');
  }
}

function todoStats() {
  const pending = allTodos.filter(t => !t.done);
  const done = allTodos.filter(t => t.done);
  const today = todayString();
  const overdue = pending.filter(t => t.due_date && t.due_date < today);
  const dueToday = pending.filter(t => t.due_date === today);
  return { pending, done, overdue, dueToday };
}

function dueHtml(todo) {
  if (!todo.due_date) return '';
  const today = todayString();
  const isOverdue = !todo.done && todo.due_date < today;
  const isToday = todo.due_date === today;
  const cls = isOverdue ? 'due-overdue' : (isToday ? 'due-today' : 'due-future');
  return `<span class="todo-due ${cls}">${todo.due_date.substring(5)}</span>`;
}

function priorityDot(todo) {
  return todo.priority && todo.priority !== 'normal'
    ? `<span class="todo-priority prio-${todo.priority}" title="${todo.priority}"></span>`
    : '';
}

function todoItemHtml(todo, { full = false } = {}) {
  const selected = full && selectedTodoId === todo.id ? ' selected' : '';
  const index = allTodos.findIndex(item => item.id === todo.id);
  const title = escHtml(todo.title);
  const notes = full && todo.notes
    ? `<span class="todo-notes-preview">${escHtml(todo.notes)}</span>`
    : '';
  return `
    <div class="todo-item${selected}" data-id="${todo.id}" draggable="true">
      <div class="todo-drag" data-action="drag" title="拖动排序">⠿</div>
      <button type="button" class="todo-checkbox ${todo.done ? 'done' : ''}" data-action="toggle" role="checkbox" aria-checked="${todo.done}" aria-label="${todo.done ? '标记为未完成' : '标记为已完成'}：${title}"></button>
      <span class="todo-text ${todo.done ? 'done' : ''}">${priorityDot(todo)}${title}${dueHtml(todo)}${notes}</span>
      <span class="item-order-controls" aria-label="调整任务顺序">
        <button type="button" class="btn-order" data-action="move-up" aria-label="上移任务：${title}" ${index <= 0 ? 'disabled' : ''}>↑</button>
        <button type="button" class="btn-order" data-action="move-down" aria-label="下移任务：${title}" ${index >= allTodos.length - 1 ? 'disabled' : ''}>↓</button>
      </span>
      <button type="button" class="todo-delete" data-action="delete" aria-label="删除任务：${title}" title="删除">×</button>
    </div>
  `;
}

function renderCompactTodos() {
  const { pending, done } = todoStats();
  $('#todoCount').textContent = pending.length;
  if (allTodos.length === 0) {
    $('#todoList').innerHTML = '<div class="todo-empty">暂无待办事项</div>';
    $('#btnTodoClear').style.display = 'none';
    return;
  }
  $('#todoList').innerHTML = allTodos.map(t => todoItemHtml(t)).join('');
  $('#btnTodoClear').style.display = done.length > 0 ? 'block' : 'none';
}

function filteredTodos() {
  if (activeFilter === 'done') return allTodos.filter(t => t.done);
  if (activeFilter === 'pending') return allTodos.filter(t => !t.done);
  return allTodos;
}

function sectionHtml(title, todos) {
  if (todos.length === 0) return '';
  return `<div class="todo-section-title">${title}</div>${todos.map(t => todoItemHtml(t, { full: true })).join('')}`;
}

function renderFullTodos() {
  const { pending, done, overdue, dueToday } = todoStats();
  $('#todoFullSummary').textContent = `${pending.length} 项待办，${done.length} 项已完成`;
  $('#btnTodoFullClear').style.display = done.length > 0 ? 'block' : 'none';
  $('#todoFilterTabs').querySelectorAll('button').forEach(btn => {
    const selected = btn.dataset.filter === activeFilter;
    btn.classList.toggle('active', selected);
    btn.setAttribute('aria-selected', String(selected));
  });

  const list = $('#todoFullList');
  const todos = filteredTodos();
  if (todos.length === 0) {
    list.innerHTML = '<div class="todo-empty">当前筛选下没有待办</div>';
    return;
  }

  if (activeFilter === 'pending') {
    const urgentIds = new Set([...overdue, ...dueToday].map(t => t.id));
    list.innerHTML =
      sectionHtml('逾期 / 今日', todos.filter(t => urgentIds.has(t.id))) +
      sectionHtml('其他待办', todos.filter(t => !urgentIds.has(t.id)));
  } else if (activeFilter === 'done') {
    list.innerHTML = sectionHtml('已完成', todos);
  } else {
    list.innerHTML =
      sectionHtml('待办', todos.filter(t => !t.done)) +
      sectionHtml('已完成', todos.filter(t => t.done));
  }
}

function renderTodos() {
  renderCompactTodos();
  renderFullTodos();
}

function resetTodoForm() {
  selectedTodoId = null;
  $('#todoEditId').value = '';
  $('#todoFullTitle').value = '';
  $('#todoFullDueDate').value = '';
  $('#todoFullPriority').value = 'normal';
  $('#todoFullNotes').value = '';
  $('#btnTodoFullSave').textContent = '保存任务';
}

function fillTodoForm(todo) {
  selectedTodoId = todo.id;
  $('#todoEditId').value = todo.id;
  $('#todoFullTitle').value = todo.title || '';
  $('#todoFullDueDate').value = todo.due_date || '';
  $('#todoFullPriority').value = todo.priority || 'normal';
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
    due_date: $('#todoFullDueDate').value || null,
    priority: $('#todoFullPriority').value || 'normal',
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

async function moveTodo(id, delta, container, action) {
  const index = allTodos.findIndex(todo => todo.id === id);
  const targetIndex = index + delta;
  if (index < 0 || targetIndex < 0 || targetIndex >= allTodos.length) return;
  const reordered = [...allTodos];
  [reordered[index], reordered[targetIndex]] = [reordered[targetIndex], reordered[index]];
  try {
    await apiFetch('/api/todos/reorder', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderedIds: reordered.map(todo => todo.id) }),
    });
    await loadTodos();
    container.querySelector(`.todo-item[data-id="${id}"] [data-action="${action}"]`)?.focus();
    announce(`任务已${delta < 0 ? '上移' : '下移'}`);
  } catch (err) {
    showToast('排序失败: ' + err.message, 'error');
    announce('任务排序失败');
  }
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
    message: '清除所有已完成待办？此操作不可撤销。',
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

async function handleTodoListClick(e, { full = false, container } = {}) {
  if (e.target.dataset.action === 'drag') return;
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
    if (action === 'move-up' || action === 'move-down') {
      await moveTodo(id, action === 'move-up' ? -1 : 1, container, action);
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

$('#todoList').addEventListener('click', (e) => handleTodoListClick(e, { container: $('#todoList') }));
$('#todoFullList').addEventListener('click', (e) => handleTodoListClick(e, { full: true, container: $('#todoFullList') }));

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

setupTodoDrag($('#todoList'));
setupTodoDrag($('#todoFullList'));

$('#btnTodoAdd').addEventListener('click', async () => {
  const title = $('#todoInput').value.trim();
  if (!title) return;
  try {
    await apiFetch('/api/todos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    });
    $('#todoInput').value = '';
    await loadTodos();
  } catch (err) {
    showToast('添加失败: ' + err.message, 'error');
  }
});

$('#todoInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); $('#btnTodoAdd').click(); }
});

$('#btnTodoFullSave').addEventListener('click', saveTodoFromFullForm);
$('#btnTodoFormCancel').addEventListener('click', resetTodoForm);
$('#todoFullTitle').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); saveTodoFromFullForm(); }
});
$('#todoFilterTabs').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-filter]');
  if (!btn) return;
  activeFilter = btn.dataset.filter;
  localStorage.setItem('todoFilter', activeFilter);
  renderFullTodos();
});

$('#btnTodoClear').addEventListener('click', clearCompletedTodos);
$('#btnTodoFullClear').addEventListener('click', clearCompletedTodos);
