import { apiFetch } from './auth.js';
import { showToast, escHtml, setupDragAndDrop, confirmDialog, $ } from './helpers.js';
import { businessDateString, parseBusinessDate } from './businessDate.js';
import { countdownTiming } from './countdownDate.js';

const DEFAULT_TODO_CATEGORY = '待办';
const TODO_SELECT_IDS = ['todoFullCategory', 'todoFullPriority', 'todoFullRecurrence'];
const TODO_RECURRENCE_LABELS = {
  daily: '每日',
  weekly: '每周',
  monthly: '每月',
  yearly: '每年',
};
let allTodos = [];
let allCountdowns = [];
let todoCategories = [DEFAULT_TODO_CATEGORY];
let todoPageMode = localStorage.getItem('todoPageMode') === 'countdowns' ? 'countdowns' : 'todos';
let activeFilter = localStorage.getItem('todoFilter') || DEFAULT_TODO_CATEGORY;
if (activeFilter === 'all' || activeFilter === 'undated' || activeFilter === 'pending') activeFilter = DEFAULT_TODO_CATEGORY;
let selectedTodoId = null;
let selectedCountdownId = null;
let todoFormOpen = false;
let countdownFormOpen = false;
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
    recurrence: todo.recurrence || 'none',
    category: todo.category || DEFAULT_TODO_CATEGORY,
    notes: typeof todo.notes === 'string' ? todo.notes : '',
  };
}

function normalizeCountdown(countdown) {
  return {
    ...countdown,
    title: typeof countdown?.title === 'string' ? countdown.title : '',
    target_date: typeof countdown?.target_date === 'string' ? countdown.target_date : '',
    repeat_yearly: countdown?.repeat_yearly === true,
    notes: typeof countdown?.notes === 'string' ? countdown.notes : '',
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
  const enabled = $('#todoReminderEnabled');
  const recipient = $('#todoReminderRecipient');
  const time = $('#todoReminderTime');
  const chip = $('#todoReminderMailState');
  const status = $('#todoReminderStatusText');
  if (!enabled || !recipient || !time || !chip || !status) return;
  enabled.checked = todoReminderSettings.enabled;
  recipient.value = todoReminderSettings.recipientEmail || '';
  time.value = todoReminderSettings.sendTime || '08:00';
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
    const [todosRes, countdownsRes, categoriesRes, reminderRes] = await Promise.all([
      apiFetch('/api/todos'),
      apiFetch('/api/countdowns'),
      apiFetch('/api/todo-categories'),
      apiFetch('/api/todo-reminder-settings'),
    ]);
    allTodos = (await todosRes.json()).map(normalizeTodo);
    allCountdowns = (await countdownsRes.json()).map(normalizeCountdown);
    todoCategories = normalizeTodoCategories(await categoriesRes.json());
    todoReminderSettings = normalizeTodoReminderSettings(await reminderRes.json());
    todoReminderUiMessage = '';
    if (activeFilter !== 'done' && !todoCategories.includes(activeFilter)) activeFilter = DEFAULT_TODO_CATEGORY;
    if (selectedTodoId && !allTodos.some(t => t.id === selectedTodoId)) resetTodoForm();
    if (selectedCountdownId && !allCountdowns.some(item => item.id === selectedCountdownId)) resetCountdownForm();
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

function countdownStats() {
  const timing = allCountdowns.map(item => countdownTiming(item));
  return {
    total: timing.length,
    today: timing.filter(item => item.state === 'today').length,
    soon: timing.filter(item => item.state === 'future' && item.days <= 30).length,
    elapsed: timing.filter(item => item.state === 'elapsed').length,
  };
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

function recurrenceBadge(todo) {
  const recurrence = todo.recurrence || 'none';
  if (recurrence === 'none') return '';
  const label = TODO_RECURRENCE_LABELS[recurrence] || '';
  return label
    ? `<span class="todo-recurrence recur-${recurrence}" title="重复：${label}">${label}</span>`
    : '';
}

function todoItemHtml(todo, { full = false } = {}) {
  const selected = full && selectedTodoId === todo.id ? ' selected' : '';
  const title = escHtml(todo.title);
  const category = todo.category && todo.category !== DEFAULT_TODO_CATEGORY
    ? `<span class="todo-category-badge">${escHtml(todo.category)}</span>`
    : '';
  const meta = [priorityBadge(todo), recurrenceBadge(todo), category, dueHtml(todo)].filter(Boolean).join('');
  return `
    <div class="todo-item${selected}" data-id="${todo.id}" draggable="true">
      <div class="todo-drag" data-action="drag" title="拖动排序">⠿</div>
      <button type="button" class="todo-checkbox ${todo.done ? 'done' : ''}" data-action="toggle" role="checkbox" aria-checked="${todo.done}" aria-label="${todo.done ? '标记为未完成' : '标记为已完成'}：${title}"></button>
      <div class="todo-item-body">
        <strong class="todo-text ${todo.done ? 'done' : ''}">${title}</strong>
        ${meta ? `<small class="todo-item-meta">${meta}</small>` : ''}
      </div>
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
  if (!select) return;
  select.innerHTML = todoCategories
    .map(category => `<option value="${escHtml(category)}">${escHtml(category)}</option>`)
    .join('');
  select.value = todoCategories.includes(selected) ? selected : DEFAULT_TODO_CATEGORY;
  syncTodoSelectControls();
}

function renderTodoFilterTabs() {
  const tabs = $('#todoFilterTabs');
  if (!tabs) return;
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

function renderFullTodos() {
  const list = $('#todoFullList');
  if (!list) return;
  const { done } = todoStats();
  renderTodoFilterTabs();
  renderTodoCategorySelect($('#todoFullCategory')?.value || DEFAULT_TODO_CATEGORY);
  const todos = filteredTodos();
  if (todos.length === 0) {
    list.innerHTML = `<div class="todo-empty">${activeFilter === 'done' ? '当前没有已完成待办' : `「${escHtml(activeFilter)}」下没有待办`}</div>`;
    return;
  }
  const clearAction = activeFilter === 'done' && done.length > 0
    ? '<button class="btn-todo-clear todo-section-clear" type="button" data-action="clear-completed">清除已完成</button>'
    : '';
  list.innerHTML = `${clearAction}${todos.map(todo => todoItemHtml(todo, { full: true })).join('')}`;
}

function countdownLabel(timing) {
  if (timing.state === 'today') return '就是今天';
  if (timing.state === 'future') return `还有 ${timing.days} 天`;
  return `已过 ${Math.abs(timing.days)} 天`;
}

function formatCountdownDate(value) {
  const parts = parseBusinessDate(value);
  return parts ? `${parts.year}年${parts.month}月${parts.day}日` : value;
}

function sortedFilteredCountdowns() {
  const query = todoSearchQuery.trim().toLowerCase();
  return allCountdowns
    .filter(item => !query ||
      item.title.toLowerCase().includes(query) ||
      item.notes.toLowerCase().includes(query))
    .map(item => ({ item, timing: countdownTiming(item) }))
    .sort((a, b) => {
      const rank = value => value.timing.state === 'today' ? 0 : (value.timing.state === 'future' ? 1 : 2);
      const rankDiff = rank(a) - rank(b);
      if (rankDiff) return rankDiff;
      if (a.timing.state === 'elapsed') return b.timing.days - a.timing.days || b.item.id - a.item.id;
      return a.timing.days - b.timing.days || b.item.id - a.item.id;
    });
}

function countdownCardHtml(item, timing) {
  const selected = selectedCountdownId === item.id ? ' selected' : '';
  const stateClass = timing.state === 'today' ? ' is-today' : (timing.state === 'elapsed' ? ' is-elapsed' : '');
  return `
    <article class="countdown-item${selected}${stateClass}" data-countdown-id="${item.id}" tabindex="0" aria-label="编辑倒数日：${escHtml(item.title)}">
      <div class="countdown-item-body">
        <strong>${escHtml(item.title)}</strong>
        <small>
          <span class="countdown-status">${countdownLabel(timing)}</span>
          <time datetime="${escHtml(timing.effectiveDate)}">${escHtml(formatCountdownDate(timing.effectiveDate))}</time>
          ${item.repeat_yearly ? '<span class="countdown-repeat-badge">每年</span>' : ''}
        </small>
      </div>
      <button class="countdown-delete" type="button" data-action="delete-countdown" aria-label="删除倒数日：${escHtml(item.title)}" title="删除">×</button>
    </article>
  `;
}

function renderCountdowns() {
  const grid = $('#countdownGrid');
  if (!grid) return;
  const countdowns = sortedFilteredCountdowns();
  if (!countdowns.length) {
    grid.innerHTML = `<div class="todo-empty countdown-empty">${todoSearchQuery.trim() ? '没有匹配的倒数日' : '还没有倒数日，添加一个值得期待的日子吧'}</div>`;
    return;
  }
  grid.innerHTML = countdowns.map(({ item, timing }) => countdownCardHtml(item, timing)).join('');
}

function syncTodoDetailState() {
  const todoEmpty = $('#todoFormEmpty');
  const todoBody = $('#todoFormBody');
  const countdownEmpty = $('#countdownFormEmpty');
  const countdownBody = $('#countdownFormBody');
  if (todoEmpty) todoEmpty.hidden = todoFormOpen;
  if (todoBody) todoBody.hidden = !todoFormOpen;
  if (countdownEmpty) countdownEmpty.hidden = countdownFormOpen;
  if (countdownBody) countdownBody.hidden = !countdownFormOpen;
}

function renderModeStats() {
  const labels = [$('#todoStatLabelPending'), $('#todoStatLabelToday'), $('#todoStatLabelOverdue'), $('#todoStatLabelDone')];
  const values = [$('#todoStatPending'), $('#todoStatToday'), $('#todoStatOverdue'), $('#todoStatDone')];
  if (values.some(value => !value)) return;
  const alertStat = $('#todoStatAlert');
  if (todoPageMode === 'countdowns') {
    const stats = countdownStats();
    ['总数', '今天', '30天内', '已过期'].forEach((label, index) => { labels[index].textContent = label; });
    [stats.total, stats.today, stats.soon, stats.elapsed].forEach((value, index) => { values[index].textContent = value; });
    alertStat?.classList.toggle('is-alert', stats.elapsed > 0);
  } else {
    const { pending, done, overdue, dueToday } = todoStats();
    ['待办', '今日', '逾期', '已完成'].forEach((label, index) => { labels[index].textContent = label; });
    [pending.length, dueToday.length, overdue.length, done.length].forEach((value, index) => { values[index].textContent = value; });
    alertStat?.classList.toggle('is-alert', overdue.length > 0);
  }
  $('.todo-page-stats')?.setAttribute('aria-label', todoPageMode === 'countdowns' ? '倒数日统计' : '待办统计');
}

function applyTodoPageMode() {
  const view = $('#todoView');
  if (!view) return;
  const countdownMode = todoPageMode === 'countdowns';
  view.classList.toggle('countdown-mode', countdownMode);
  const fullPanel = $('#todoFullPanel');
  const fullForm = $('#todoFullForm');
  const countdownPanel = $('#countdownPanel');
  const countdownForm = $('#countdownForm');
  if (fullPanel) fullPanel.hidden = countdownMode;
  if (fullForm) fullForm.hidden = countdownMode;
  if (countdownPanel) countdownPanel.hidden = !countdownMode;
  if (countdownForm) countdownForm.hidden = !countdownMode;
  document.querySelectorAll('.todo-mode-only').forEach(element => { element.hidden = countdownMode; });
  const search = $('#todoSearchInput');
  if (search) search.placeholder = countdownMode ? '搜索倒数日标题或备注...' : '搜索标题或备注...';
  const searchLabel = document.querySelector('label[for="todoSearchInput"]');
  if (searchLabel) {
    const text = countdownMode ? '搜索倒数日' : '搜索待办';
    searchLabel.setAttribute('aria-label', text);
  }
  const newButton = $('#btnTodoNew');
  if (newButton) newButton.setAttribute('aria-label', countdownMode ? '新建倒数日' : '新建任务');
  document.querySelectorAll('#todoModeTabs [data-todo-page]').forEach(button => {
    const selected = button.dataset.todoPage === todoPageMode;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
  });
  renderModeStats();
  syncTodoDetailState();
}

function renderTodos() {
  if (!$('#todoView')) return;
  renderFullTodos();
  renderCountdowns();
  renderTodoReminderSettings();
  applyTodoPageMode();
}

export function getTodoSubtitle() {
  if (todoPageMode === 'countdowns') return `${allCountdowns.length} 个倒数日`;
  const pending = allTodos.filter(todo => !todo.done).length;
  return `${pending} 条待办`;
}

export function showTodoView() {
  const view = $('#todoView');
  if (!view) return;
  renderTodos();
  requestAnimationFrame(() => $('#todoSearchInput')?.focus());
}

function resetTodoForm({ open = false } = {}) {
  selectedTodoId = null;
  todoFormOpen = open;
  const editId = $('#todoEditId');
  const title = $('#todoFullTitle');
  if (editId) editId.value = '';
  if (title) title.value = '';
  renderTodoCategorySelect(DEFAULT_TODO_CATEGORY);
  const due = $('#todoFullDueDate');
  const priority = $('#todoFullPriority');
  const recurrence = $('#todoFullRecurrence');
  const notes = $('#todoFullNotes');
  const save = $('#btnTodoFullSave');
  if (due) due.value = '';
  if (priority) priority.value = 'none';
  if (recurrence) recurrence.value = 'none';
  if (notes) notes.value = '';
  if (save) save.textContent = '保存任务';
  syncTodoSelectControls();
  syncTodoDetailState();
  if ($('#todoFullList')) renderFullTodos();
}

function startNewTodo() {
  resetTodoForm({ open: true });
  $('#todoFullTitle')?.focus();
}

function fillTodoForm(todo) {
  selectedTodoId = todo.id;
  todoFormOpen = true;
  $('#todoEditId').value = todo.id;
  $('#todoFullTitle').value = todo.title || '';
  renderTodoCategorySelect(todo.category || DEFAULT_TODO_CATEGORY);
  $('#todoFullDueDate').value = todo.due_date || '';
  $('#todoFullPriority').value = todo.priority || 'none';
  $('#todoFullRecurrence').value = todo.recurrence || 'none';
  $('#todoFullNotes').value = todo.notes || '';
  $('#btnTodoFullSave').textContent = '更新任务';
  syncTodoDetailState();
  renderFullTodos();
  $('#todoFullTitle').focus();
  $('#todoFullTitle').select();
}

function resetCountdownForm({ open = false } = {}) {
  selectedCountdownId = null;
  countdownFormOpen = open;
  const editId = $('#countdownEditId');
  const title = $('#countdownTitle');
  const date = $('#countdownTargetDate');
  const yearly = $('#countdownRepeatYearly');
  const notes = $('#countdownNotes');
  const save = $('#btnCountdownSave');
  const hint = $('#countdownFormHint');
  if (editId) editId.value = '';
  if (title) title.value = '';
  if (date) date.value = '';
  if (yearly) yearly.checked = false;
  if (notes) notes.value = '';
  if (save) save.textContent = '保存倒数日';
  if (hint) hint.textContent = '记录值得期待的日子';
  syncTodoDetailState();
  renderCountdowns();
}

function startNewCountdown() {
  resetCountdownForm({ open: true });
  $('#countdownTitle')?.focus();
}

function fillCountdownForm(countdown) {
  selectedCountdownId = countdown.id;
  countdownFormOpen = true;
  $('#countdownEditId').value = countdown.id;
  $('#countdownTitle').value = countdown.title;
  $('#countdownTargetDate').value = countdown.target_date;
  $('#countdownRepeatYearly').checked = countdown.repeat_yearly;
  $('#countdownNotes').value = countdown.notes;
  $('#btnCountdownSave').textContent = '更新倒数日';
  $('#countdownFormHint').textContent = '正在编辑倒数日';
  syncTodoDetailState();
  renderCountdowns();
  $('#countdownTitle').focus();
  $('#countdownTitle').select();
}

async function saveCountdownFromForm() {
  const title = $('#countdownTitle').value.trim();
  const targetDate = $('#countdownTargetDate').value;
  if (!title) {
    showToast('请输入倒数日标题', 'error');
    $('#countdownTitle').focus();
    return;
  }
  if (!targetDate) {
    showToast('请选择目标日期', 'error');
    $('#countdownTargetDate').focus();
    return;
  }
  const id = parseInt($('#countdownEditId').value, 10);
  const body = {
    title,
    target_date: targetDate,
    repeat_yearly: $('#countdownRepeatYearly').checked,
    notes: $('#countdownNotes').value,
  };
  try {
    await apiFetch(id ? `/api/countdowns/${id}` : '/api/countdowns', {
      method: id ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    showToast(id ? '倒数日已更新' : '倒数日已添加', 'success');
    resetCountdownForm();
    await loadTodos();
  } catch (err) {
    showToast('保存倒数日失败: ' + err.message, 'error');
  }
}

async function deleteCountdown(id) {
  const countdown = allCountdowns.find(item => item.id === id);
  if (!countdown) return;
  const confirmed = await confirmDialog({
    title: '删除倒数日',
    message: `删除倒数日「${countdown.title}」？`,
    confirmText: '删除',
  });
  if (!confirmed) return;
  try {
    await apiFetch(`/api/countdowns/${id}`, { method: 'DELETE' });
    if (selectedCountdownId === id) resetCountdownForm();
    await loadTodos();
    showToast('倒数日已删除', 'success');
  } catch (err) {
    showToast('删除倒数日失败: ' + err.message, 'error');
  }
}

async function saveTodoFromFullForm() {
  const title = $('#todoFullTitle').value.trim();
  if (!title) {
    showToast('请输入任务标题', 'error');
    return;
  }
  const dueDate = $('#todoFullDueDate').value || null;
  const recurrence = $('#todoFullRecurrence').value || 'none';
  if (recurrence !== 'none' && !dueDate) {
    showToast('重复待办需要先填写截止日期', 'error');
    $('#todoFullDueDate').focus();
    return;
  }
  const id = parseInt($('#todoEditId').value, 10);
  const body = {
    title,
    category: $('#todoFullCategory').value || DEFAULT_TODO_CATEGORY,
    due_date: dueDate,
    priority: $('#todoFullPriority').value || 'none',
    recurrence,
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
  const dialog = $('#todoCategoryOverlay');
  const input = $('#todoCategoryInput');
  if (!dialog || !input) return;
  input.value = '';
  if (!dialog.open) dialog.showModal();
  requestAnimationFrame(() => input.focus());
}

function closeTodoCategoryModal() {
  const dialog = $('#todoCategoryOverlay');
  const input = $('#todoCategoryInput');
  if (input) input.value = '';
  if (dialog?.open) dialog.close();
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

function setupTodoDrag(container) {
  if (!container) return;
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

export function initTodos() {
  if (!$('#todoView')) return;
  $('#todoFullList').addEventListener('click', (e) => handleTodoListClick(e, { full: true }));
  $('#countdownGrid').addEventListener('click', (event) => {
    const card = event.target.closest('[data-countdown-id]');
    if (!card) return;
    const id = parseInt(card.dataset.countdownId, 10);
    if (event.target.closest('[data-action="delete-countdown"]')) {
      event.stopPropagation();
      deleteCountdown(id);
      return;
    }
    const countdown = allCountdowns.find(item => item.id === id);
    if (countdown) fillCountdownForm(countdown);
  });
  $('#countdownGrid').addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    if (event.target.closest('[data-action="delete-countdown"]')) return;
    const card = event.target.closest('[data-countdown-id]');
    if (!card) return;
    event.preventDefault();
    const countdown = allCountdowns.find(item => item.id === parseInt(card.dataset.countdownId, 10));
    if (countdown) fillCountdownForm(countdown);
  });
  setupTodoDrag($('#todoFullList'));
  $('#btnTodoNew').addEventListener('click', () => {
    if (todoPageMode === 'countdowns') startNewCountdown();
    else startNewTodo();
  });
  $('#btnTodoFullSave').addEventListener('click', saveTodoFromFullForm);
  $('#btnTodoFormCancel').addEventListener('click', resetTodoForm);
  $('#btnCountdownSave').addEventListener('click', saveCountdownFromForm);
  $('#btnCountdownCancel').addEventListener('click', resetCountdownForm);
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
    if (todoPageMode === 'countdowns') renderCountdowns();
    else renderFullTodos();
  });
  $('#todoModeTabs').addEventListener('click', (event) => {
    const button = event.target.closest('[data-todo-page]');
    if (!button || !['todos', 'countdowns'].includes(button.dataset.todoPage)) return;
    todoPageMode = button.dataset.todoPage;
    localStorage.setItem('todoPageMode', todoPageMode);
    todoSearchQuery = '';
    $('#todoSearchInput').value = '';
    if (todoPageMode === 'countdowns') resetTodoForm();
    else resetCountdownForm();
    renderTodos();
    $('#todoSearchInput').focus();
  });
  $('#todoModeTabs').addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    const nextMode = todoPageMode === 'todos' ? 'countdowns' : 'todos';
    document.querySelector(`#todoModeTabs [data-todo-page="${nextMode}"]`)?.click();
  });
  $('#countdownTitle').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      saveCountdownFromForm();
    }
  });
  $('#btnTodoCategoryOpen').addEventListener('click', openTodoCategoryModal);
  $('#btnTodoCategoryClose').addEventListener('click', closeTodoCategoryModal);
  $('#btnTodoCategoryCancel').addEventListener('click', closeTodoCategoryModal);
  $('#todoCategoryOverlay').addEventListener('click', (e) => {
    if (e.target === $('#todoCategoryOverlay')) closeTodoCategoryModal();
  });
  $('#todoCategoryOverlay').addEventListener('cancel', () => {
    const input = $('#todoCategoryInput');
    if (input) input.value = '';
  });
  $('#todoCategoryAddForm').addEventListener('submit', addTodoCategoryFromForm);
  initTodoSelectControls();
}
