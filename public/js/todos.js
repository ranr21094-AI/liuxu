import { apiFetch as rawApiFetch } from './auth.js';

async function apiFetch(url, options = {}) {
  const response = await rawApiFetch(url, options);
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `请求失败（${response.status}）`);
  }
  return response;
}
import { showToast, escHtml, setupDragAndDrop, confirmDialog, $ } from './helpers.js';
import { businessDateString, parseBusinessDate } from './businessDate.js';
import { syncDatePickers } from './app/date-picker.js';
import { initTodoReminderPanel } from './app/todo-reminder-panel.js';
import { createTodoDetailController } from './app/todo-detail.js';
import { countdownTiming } from './countdownDate.js';
import { initSelectControls, syncSelectControls } from './selectControl.js';

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
  smtp: { useCustomSmtp: false, host: '', port: 465, secureMode: 'ssl', authUser: '', fromAddress: '', passwordConfigured: false, source: 'none', activeFromAddress: '' },
  lastStatus: 'idle',
  lastSentAt: '',
  lastError: '',
};
let todoReminderUiMessage = '';
let detailController;
let todoCategoryModalMode = 'add';
let todoCategoryOriginalName = '';
let todoCategoryReturnCategory = '';
let todoCategoryMenuName = '';
export async function leaveTodoView() {
  if (detailController && !(await detailController.allowDiscard())) return false;
  detailController?.discard();
  resetTodoForm(); resetCountdownForm();
  return true;
}

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
    smtp: {
      useCustomSmtp: data.smtp?.useCustomSmtp === true,
      host: typeof data.smtp?.host === 'string' ? data.smtp.host : '',
      port: Number(data.smtp?.port) || 465,
      secureMode: ['none', 'starttls', 'ssl'].includes(data.smtp?.secureMode) ? data.smtp.secureMode : 'ssl',
      authUser: typeof data.smtp?.authUser === 'string' ? data.smtp.authUser : '',
      fromAddress: typeof data.smtp?.fromAddress === 'string' ? data.smtp.fromAddress : '',
      passwordConfigured: data.smtp?.passwordConfigured === true,
      source: ['custom', 'environment'].includes(data.smtp?.source) ? data.smtp.source : 'none',
      activeFromAddress: typeof data.smtp?.activeFromAddress === 'string' ? data.smtp.activeFromAddress : '',
    },
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
  chip.textContent = todoReminderUiMessage.startsWith('保存失败') ? '保存失败' : !todoReminderSettings.mailReady ? '未配置' : todoReminderSettings.enabled ? '已启用' : '已关闭';
  const reminderButton = $('#todoReminderOpen');
  reminderButton.setAttribute('aria-label', `邮件提醒设置，${chip.textContent}`);
  reminderButton.title = `邮件提醒：${chip.textContent}`;
  reminderButton.querySelector('.todo-reminder-enabled-dot').hidden = !(todoReminderSettings.enabled && todoReminderSettings.mailReady);
  chip.classList.toggle('ready', todoReminderSettings.mailReady);
  chip.classList.toggle('missing', !todoReminderSettings.mailReady);

  const smtp = todoReminderSettings.smtp;
  $('#todoSmtpUseCustom').checked = smtp.useCustomSmtp;
  $('#todoSmtpFields').hidden = !smtp.useCustomSmtp;
  $('#todoSmtpHost').value = smtp.host;
  $('#todoSmtpPort').value = String(smtp.port);
  $('#todoSmtpSecureMode').value = smtp.secureMode;
  $('#todoSmtpFromAddress').value = smtp.fromAddress;
  $('#todoSmtpAuthUser').value = smtp.authUser;
  $('#todoSmtpPassword').value = '';
  $('#todoSmtpClearPassword').checked = false;
  $('#todoSmtpClearPassword').disabled = !smtp.passwordConfigured;
  $('#todoSmtpPasswordState').textContent = smtp.passwordConfigured
    ? '密码已加密保存；留空可继续使用。'
    : '尚未保存密码。无需认证的 SMTP 可留空。';
  $('#todoSmtpSource').textContent = smtp.source === 'custom'
    ? `当前使用自定义 SMTP：${smtp.host}:${smtp.port}`
    : smtp.source === 'environment'
      ? '当前使用服务环境中的 QQ SMTP 配置。'
      : '尚无可用的发件服务器配置。';
  $('#btnTodoReminderTest').disabled = !todoReminderSettings.mailReady;

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
    parts.push('请配置可用的 SMTP 发件服务器并保存后，再启用邮件提醒。');
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

function syncTodoSelectControls() {
  syncSelectControls({ ids: TODO_SELECT_IDS });
}

function initTodoSelectControls() {
  initSelectControls({ ids: TODO_SELECT_IDS });
}

function dueHtml(todo) {
  if (!todo.due_date) return '';
  const today = todayString();
  const isOverdue = !todo.done && todo.due_date < today;
  const isToday = todo.due_date === today;
  const cls = isOverdue ? 'due-overdue' : (isToday ? 'due-today' : 'due-future');
  return `<span class="todo-due ${cls}" title="${escHtml(todo.due_date)}" aria-label="${isOverdue ? '逾期：' : isToday ? '今天：' : '截止：'}${escHtml(todo.due_date)}">${isOverdue ? '逾期 · ' : isToday ? '今天 · ' : ''}${escHtml(((todo.due_date.slice(0, 4) === today.slice(0, 4) ? todo.due_date.slice(5) : todo.due_date)))}</span>`;
}

function priorityBadge(todo) {
  const labels = { normal: 'P2 普通', important: 'P1 重要', urgent: 'P0 紧急' };
  return todo.priority && todo.priority !== 'none'
    ? `<span class="todo-priority prio-${escHtml(todo.priority)}" title="${escHtml(labels[todo.priority] || todo.priority)}">${escHtml(labels[todo.priority]?.replace(/^P[0-2] /, '') || '')}</span>`
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
    <div class="todo-item${selected}" data-id="${escHtml(todo.id)}" tabindex="0" aria-label="编辑任务：${title}" draggable="true">
      <div class="todo-drag" data-action="drag" title="拖动排序">⠿</div>
      <button type="button" class="todo-checkbox ${todo.done ? 'done' : ''}" data-action="toggle" role="checkbox" aria-checked="${todo.done}" aria-label="${todo.done ? '标记为未完成' : '标记为已完成'}：${title}"></button>
      <div class="todo-item-body">
        <strong class="todo-text ${todo.done ? 'done' : ''}">${title}</strong>
        ${meta ? `<small class="todo-item-meta">${meta}</small>` : ''}
        ${todo.notes ? `<p class="todo-notes-preview">${escHtml(todo.notes)}</p>` : ''}
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
  closeTodoCategoryMenu();
  const systemFilter = (category, label, icon) => `
    <button class="todo-filter-pill todo-system-filter${activeFilter === category ? ' active' : ''}" data-filter="${category}" aria-pressed="${activeFilter === category}" title="${label}">
      <span class="todo-filter-leading">${icon}<span class="todo-filter-label">${label}</span></span>
    </button>`;
  const customCategories = todoCategories.filter(category => category !== DEFAULT_TODO_CATEGORY);
  const customFilters = customCategories.map((category, index) => {
    const selected = activeFilter === category;
    const menuId = `todoCategoryMenu${index}`;
    return `<div class="todo-filter-row${selected ? ' active' : ''}" data-todo-category-row="${escHtml(category)}">
      <button class="todo-filter-pill${selected ? ' active' : ''}" data-filter="${escHtml(category)}" data-category-filter="${escHtml(category)}" aria-pressed="${selected}" title="${escHtml(category)}">
        <span class="todo-filter-label">${escHtml(category)}</span>
      </button>
      <button class="todo-category-more" type="button" data-category-more="${escHtml(category)}" aria-label="${escHtml(category)}分类操作" title="分类操作" aria-haspopup="menu" aria-expanded="false" aria-controls="${menuId}">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.2"></circle><circle cx="12" cy="12" r="1.2"></circle><circle cx="19" cy="12" r="1.2"></circle></svg>
      </button>
      <div class="todo-category-menu" id="${menuId}" role="menu" aria-label="${escHtml(category)}分类操作" hidden>
        <button type="button" role="menuitem" data-action="rename-category" data-category="${escHtml(category)}">重命名</button>
        <button type="button" role="menuitem" data-action="delete-category" data-category="${escHtml(category)}">删除</button>
      </div>
    </div>`;
  }).join('');
  tabs.innerHTML = `${systemFilter(DEFAULT_TODO_CATEGORY, '待办', '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v14H4z"></path><path d="M4 12h4l2 3h4l2-3h4"></path></svg>')}
    ${systemFilter('done', '已完成', '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"></circle><path d="m8 12 2.5 2.5L16.5 9"></path></svg>')}
    ${customCategories.length ? '<div class="todo-filter-divider" role="separator"></div>' : ''}${customFilters}`;
}

function focusTodoFilter(filter) {
  [...($('#todoFilterTabs')?.querySelectorAll('[data-filter]') || [])]
    .find(button => button.dataset.filter === filter)?.focus();
}

function closeTodoCategoryMenu({ restoreFocus = false } = {}) {
  if (!todoCategoryMenuName) return;
  const tabs = $('#todoFilterTabs');
  const row = [...(tabs?.querySelectorAll('[data-todo-category-row]') || [])]
    .find(element => element.dataset.todoCategoryRow === todoCategoryMenuName);
  const toggle = row?.querySelector('[data-category-more]');
  const menu = row?.querySelector('.todo-category-menu');
  if (menu) menu.hidden = true;
  toggle?.setAttribute('aria-expanded', 'false');
  const name = todoCategoryMenuName;
  todoCategoryMenuName = '';
  if (restoreFocus) toggle?.focus();
  return name;
}

function openTodoCategoryMenu(toggle, { focusFirst = false } = {}) {
  const category = toggle?.dataset.categoryMore;
  if (!category) return;
  if (todoCategoryMenuName && todoCategoryMenuName !== category) closeTodoCategoryMenu();
  const row = toggle.closest('[data-todo-category-row]');
  const menu = row?.querySelector('.todo-category-menu');
  if (!menu) return;
  const positionMenu = () => {
    const anchor = toggle.getBoundingClientRect();
    const panel = menu.getBoundingClientRect();
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
    const left = Math.max(12, Math.min(viewportWidth - panel.width - 12, anchor.right - panel.width));
    let top = anchor.bottom + 3;
    if (top + panel.height > viewportHeight - 12 && anchor.top - panel.height - 3 >= 12) top = anchor.top - panel.height - 3;
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  };
  if (focusFirst) {
    if (menu.hidden) {
      menu.hidden = false;
      toggle.setAttribute('aria-expanded', 'true');
      todoCategoryMenuName = category;
      positionMenu();
    }
    menu.querySelector('[role="menuitem"]')?.focus();
    return;
  }
  const opening = menu.hidden;
  menu.hidden = !opening;
  toggle.setAttribute('aria-expanded', String(opening));
  todoCategoryMenuName = opening ? category : '';
  if (opening) positionMenu();
}

function renderFullTodos() {
  const list = $('#todoFullList');
  if (!list) return;
  const { done } = todoStats();
  renderTodoFilterTabs();
  renderTodoCategorySelect($('#todoFullCategory')?.value || DEFAULT_TODO_CATEGORY);
  const todos = filteredTodos();
  const clearButton = $('#todoClearCompleted');
  if (clearButton) clearButton.hidden = todoPageMode !== 'todos' || activeFilter !== 'done' || done.length === 0;
  if (todoPageMode === 'todos') {
    $('#todoListHeading').textContent = activeFilter === 'done' ? '已完成' : activeFilter;
    $('#todoListCount').textContent = `${todos.length} 条${todoSearchQuery.trim() ? '匹配' : ''}`;
  }
  if (todos.length === 0) {
    list.innerHTML = `<div class="todo-empty">${todoSearchQuery.trim() ? '没有匹配的待办' : activeFilter === 'done' ? '当前没有已完成待办' : allTodos.length === 0 ? '还没有待办，记录下一件想完成的事' : `「${escHtml(activeFilter)}」下没有待办`}<button type="button" class="secondary-action compact" data-todo-empty-action>${todoSearchQuery.trim() ? '清空搜索' : '新建任务'}</button></div>`;
    return;
  }
  list.innerHTML = todos.map(todo => todoItemHtml(todo, { full: true })).join('');
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
          <span class="countdown-status">${timing.state === 'today' ? '就是今天' : `${timing.state === 'future' ? '还有' : '已过'} <b>${Math.abs(timing.days)}</b> 天`}</span>
          ${item.repeat_yearly ? '<span class="countdown-next-label">下一次</span>' : ''}<time datetime="${escHtml(timing.effectiveDate)}">${escHtml(formatCountdownDate(timing.effectiveDate))}</time>
          ${item.repeat_yearly ? '<span class="countdown-repeat-badge">每年</span>' : ''}
        </small>
        ${item.notes ? `<p class="todo-notes-preview">${escHtml(item.notes)}</p>` : ''}
      </div>
      <button class="countdown-delete" type="button" data-action="delete-countdown" aria-label="删除倒数日：${escHtml(item.title)}" title="删除">×</button>
    </article>
  `;
}

function renderCountdowns() {
  const grid = $('#countdownGrid');
  if (!grid) return;
  const countdowns = sortedFilteredCountdowns();
  const sidebar = $('#countdownSidebarList');
  if (sidebar) sidebar.innerHTML = countdowns.length ? countdowns.map(({ item, timing }) => `<button type="button" class="session-select countdown-sidebar-item${selectedCountdownId === item.id ? ' active' : ''}" data-countdown-select="${item.id}" aria-current="${selectedCountdownId === item.id}"><strong>${escHtml(item.title)}</strong><small>${escHtml(countdownLabel(timing))} · ${item.repeat_yearly ? '下一次 ' : ''}${escHtml(timing.effectiveDate)}</small></button>`).join('') : `<p class="empty-list">${todoSearchQuery.trim() ? '没有匹配的倒数日' : '还没有倒数日'}</p>`;
  if (todoPageMode === 'countdowns') {
    const clearButton = $('#todoClearCompleted');
    if (clearButton) clearButton.hidden = true;
    $('#todoListHeading').textContent = '倒数日';
    $('#todoListCount').textContent = `${countdowns.length} 个${todoSearchQuery.trim() ? '匹配' : ''}`;
  }
  if (!countdowns.length) {
    grid.innerHTML = `<div class="todo-empty countdown-empty">${todoSearchQuery.trim() ? '没有匹配的倒数日' : '还没有倒数日，添加一个值得期待的日子吧'}<button type="button" class="secondary-action compact" data-todo-empty-action>${todoSearchQuery.trim() ? '清空搜索' : '新建倒数日'}</button></div>`;
    return;
  }
  grid.innerHTML = countdowns.map(({ item, timing }) => countdownCardHtml(item, timing)).join('');
}

function syncTodoDetailState() {
  syncDatePickers();
  const todoEmpty = $('#todoFormEmpty');
  const todoBody = $('#todoFormBody');
  const countdownEmpty = $('#countdownFormEmpty');
  const countdownBody = $('#countdownFormBody');
  if (todoEmpty) todoEmpty.hidden = todoFormOpen;
  if (todoBody) todoBody.hidden = !todoFormOpen;
  if (countdownEmpty) countdownEmpty.hidden = countdownFormOpen;
  if (countdownBody) countdownBody.hidden = !countdownFormOpen;
  detailController?.syncLayout();
}

function renderModeStats() {
  const labels = [$('#todoStatLabelPending'), $('#todoStatLabelToday'), $('#todoStatLabelOverdue'), $('#todoStatLabelDone')];
  const values = [$('#todoStatPending'), $('#todoStatToday'), $('#todoStatOverdue'), $('#todoStatDone')];
  if (values.some(value => !value)) return;
  const alertStat = $('#todoStatAlert');
  if (todoPageMode === 'countdowns') {
    const stats = countdownStats();
    ['总数', '今天', '30天内', '已过'].forEach((label, index) => { labels[index].textContent = label; });
    [stats.total, stats.today, stats.soon, stats.elapsed].forEach((value, index) => { values[index].textContent = value; });
    alertStat?.classList.remove('is-alert');
  } else {
    const { pending, done, overdue, dueToday } = todoStats();
    ['待办', '今日', '逾期', '已完成'].forEach((label, index) => { labels[index].textContent = label; });
    [pending.length, dueToday.length, overdue.length, done.length].forEach((value, index) => { values[index].textContent = value; });
    alertStat?.classList.toggle('is-alert', overdue.length > 0);
  }
  $('.todo-page-stats')?.setAttribute('aria-label', todoPageMode === 'countdowns' ? '全部倒数日统计' : '全部待办统计');
}

function applyTodoPageMode() {
  const view = $('#todoView');
  if (!view) return;
  const countdownMode = todoPageMode === 'countdowns';
  view.classList.toggle('countdown-mode', countdownMode);
  $('#countdownSidebarList').hidden = !countdownMode;
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
  if (search) {
    search.placeholder = countdownMode ? '搜索倒数日' : '搜索待办';
    search.setAttribute('aria-label', search.placeholder);
    $('#todoSearchClear').hidden = !search.value;
    $('#todoSearchClear').setAttribute('aria-label', countdownMode ? '清空倒数日搜索' : '清空待办搜索');
  }
  const searchLabel = document.querySelector('label[for="todoSearchInput"]');
  if (searchLabel) {
    const text = countdownMode ? '搜索倒数日' : '搜索待办';
    searchLabel.setAttribute('aria-label', text);
  }
  const newButton = $('#btnTodoNew');
  if (newButton) {
    const label = countdownMode ? '新建倒数日' : '新建任务';
    const iconMode = countdownMode ? 'countdown' : 'todo';
    newButton.dataset.actionMode = iconMode;
    newButton.querySelector('.todo-new-action-label').textContent = label;
    newButton.querySelectorAll('[data-todo-new-icon]').forEach(icon => { icon.hidden = icon.dataset.todoNewIcon !== iconMode; });
    newButton.setAttribute('aria-label', label);
    newButton.title = label;
  }
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
  if (!open && detailController?.activeMode === 'todos') detailController.discard();
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

async function startNewTodo() {
  if (detailController && !(await detailController.allowDiscard())) return;
  resetTodoForm({ open: true });
  detailController?.open('todos', '新建任务');
  $('#todoFullTitle')?.focus();
}

async function fillTodoForm(todo) {
  if (selectedTodoId === todo.id && todoFormOpen) { $('#todoFullTitle').focus(); return; }
  if (detailController && !(await detailController.allowDiscard())) return;
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
  detailController?.open('todos', '编辑任务');
  syncTodoDetailState();
  renderFullTodos();
  $('#todoFullTitle').focus();
  $('#todoFullTitle').select();
}

function resetCountdownForm({ open = false } = {}) {
  if (!open && detailController?.activeMode === 'countdowns') detailController.discard();
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

async function startNewCountdown() {
  if (detailController && !(await detailController.allowDiscard())) return;
  resetCountdownForm({ open: true });
  detailController?.open('countdowns', '新建倒数日');
  $('#countdownTitle')?.focus();
}

async function fillCountdownForm(countdown) {
  if (selectedCountdownId === countdown.id && countdownFormOpen) { $('#countdownTitle').focus(); return; }
  if (detailController && !(await detailController.allowDiscard())) return;
  selectedCountdownId = countdown.id;
  countdownFormOpen = true;
  $('#countdownEditId').value = countdown.id;
  $('#countdownTitle').value = countdown.title;
  $('#countdownTargetDate').value = countdown.target_date;
  $('#countdownRepeatYearly').checked = countdown.repeat_yearly;
  $('#countdownNotes').value = countdown.notes;
  $('#btnCountdownSave').textContent = '更新倒数日';
  $('#countdownFormHint').textContent = '正在编辑倒数日';
  detailController?.open('countdowns', '编辑倒数日');
  syncTodoDetailState();
  renderCountdowns();
  $('#countdownTitle').focus();
  $('#countdownTitle').select();
}

async function saveCountdownFromForm() {
  if (detailController?.saving) return;
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
  detailController?.setSaving(true);
  try {
    await apiFetch(id ? `/api/countdowns/${id}` : '/api/countdowns', {
      method: id ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    showToast(id ? '倒数日已更新' : '倒数日已添加', 'success');
    detailController?.setSaving(false);
    detailController?.discard();
    resetCountdownForm();
    await loadTodos();
    (document.querySelector(`[data-countdown-id="${id}"]`) || $('#btnTodoNew'))?.focus();
  } catch (err) {
    showToast('保存倒数日失败: ' + err.message, 'error');
    const error = $('#countdownFormError');
    if (error) error.textContent = err.message;
  } finally { detailController?.setSaving(false); }
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
  if (detailController?.saving) return;
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
  detailController?.setSaving(true);
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
    detailController?.setSaving(false);
    detailController?.discard();
    resetTodoForm();
    await loadTodos();
    (document.querySelector(`.todo-item[data-id="${id}"]`) || $('#btnTodoNew'))?.focus();
  } catch (err) {
    showToast('保存失败: ' + err.message, 'error');
    const error = $('#todoFullFormError');
    if (error) error.textContent = err.message;
  } finally { detailController?.setSaving(false); }
}

function showTodoCategoryError(message = '') {
  const error = $('#todoCategoryError');
  if (!error) return;
  error.textContent = message;
  error.hidden = !message;
}

function openTodoCategoryModal({ mode = 'add', category = '', returnCategory = '' } = {}) {
  const dialog = $('#todoCategoryOverlay');
  const input = $('#todoCategoryInput');
  if (!dialog || !input) return;
  closeTodoCategoryMenu();
  todoCategoryModalMode = mode;
  todoCategoryOriginalName = mode === 'rename' ? category : '';
  todoCategoryReturnCategory = returnCategory;
  const renaming = mode === 'rename';
  $('#todoCategoryModalTitle').textContent = renaming ? '重命名分类' : '新增分类';
  $('#btnTodoCategoryAdd').textContent = renaming ? '保存' : '添加';
  input.value = renaming ? category : '';
  showTodoCategoryError('');
  if (!dialog.open) dialog.showModal();
  requestAnimationFrame(() => { input.focus(); if (renaming) input.select(); });
}

function closeTodoCategoryModal({ restoreFocus = true } = {}) {
  const dialog = $('#todoCategoryOverlay');
  const input = $('#todoCategoryInput');
  if (input) input.value = '';
  showTodoCategoryError('');
  if (dialog?.open) dialog.close();
  const returnCategory = todoCategoryReturnCategory;
  todoCategoryModalMode = 'add';
  todoCategoryOriginalName = '';
  todoCategoryReturnCategory = '';
  if (restoreFocus) requestAnimationFrame(() => {
    if (returnCategory) {
      const row = [...($('#todoFilterTabs')?.querySelectorAll('[data-todo-category-row]') || [])]
        .find(element => element.dataset.todoCategoryRow === returnCategory);
      row?.querySelector('[data-category-more]')?.focus();
    } else $('#btnTodoCategoryOpen')?.focus();
  });
}

async function addTodoCategoryFromForm(event) {
  event.preventDefault();
  const input = $('#todoCategoryInput');
  const name = input.value.trim();
  if (!name) { showTodoCategoryError('请输入分类名称。'); input.focus(); return; }
  if (name.length > 24) { showTodoCategoryError('分类名称不能超过 24 个字符。'); input.focus(); return; }
  const submit = $('#btnTodoCategoryAdd');
  if (submit.disabled) return;
  submit.disabled = true;
  showTodoCategoryError('');
  const mode = todoCategoryModalMode;
  const originalName = todoCategoryOriginalName;
  try {
    const res = await apiFetch(mode === 'rename'
      ? `/api/todo-categories/${encodeURIComponent(originalName)}`
      : '/api/todo-categories', {
      method: mode === 'rename' ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const body = await res.json();
    todoCategories = normalizeTodoCategories(body.categories || [body.category]);
    activeFilter = body.category || name;
    localStorage.setItem('todoFilter', activeFilter);
    if (mode === 'rename') {
      const selectedCategory = $('#todoFullCategory')?.value || DEFAULT_TODO_CATEGORY;
      renderTodoCategorySelect(selectedCategory === originalName ? name : selectedCategory);
      detailController?.renameCategory(originalName, name);
    }
    closeTodoCategoryModal({ restoreFocus: false });
    await loadTodos();
    focusTodoFilter(activeFilter);
    showToast(mode === 'rename' ? '待办分类已重命名' : '待办分类已添加', 'success');
  } catch (err) {
    const message = err.message === 'Todo category already exists' ? '已有同名分类。'
      : err.message === 'Default todo category is protected' ? '系统分类不能重命名。'
        : err.message || '请重试。';
    showTodoCategoryError(message);
    input.focus();
  } finally {
    submit.disabled = false;
  }
}

async function deleteTodoCategory(name) {
  const confirmed = await confirmDialog({
    title: '删除待办分类',
    message: `删除分类「${name}」？该分类下的未完成待办会移动到「${DEFAULT_TODO_CATEGORY}」。`,
    confirmText: '删除',
  });
  if (!confirmed) {
    const row = [...($('#todoFilterTabs')?.querySelectorAll('[data-todo-category-row]') || [])]
      .find(element => element.dataset.todoCategoryRow === name);
    row?.querySelector('[data-category-more]')?.focus();
    return;
  }
  try {
    const response = await apiFetch(`/api/todo-categories/${encodeURIComponent(name)}`, { method: 'DELETE' });
    const result = await response.json().catch(() => ({}));
    if (Array.isArray(result.categories)) todoCategories = [DEFAULT_TODO_CATEGORY, ...result.categories.filter(category => category !== DEFAULT_TODO_CATEGORY)];
    const currentCategory = $('#todoFullCategory')?.value || DEFAULT_TODO_CATEGORY;
    if (currentCategory === name) renderTodoCategorySelect(DEFAULT_TODO_CATEGORY);
    detailController?.renameCategory(name, DEFAULT_TODO_CATEGORY);
    if (activeFilter === name) activeFilter = DEFAULT_TODO_CATEGORY;
    localStorage.setItem('todoFilter', activeFilter);
    await loadTodos();
    focusTodoFilter(activeFilter);
    showToast('待办分类已删除', 'success');
  } catch (err) {
    showToast('删除分类失败: ' + err.message, 'error');
  }
}

async function toggleTodo(id) {
  const todo = allTodos.find(t => t.id === id);
  if (!todo) return;
  try {
    const response = await apiFetch(`/api/todos/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ done: !todo.done }),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${response.status}`);
    }
  } catch (err) {
    showToast('更新待办失败: ' + err.message, 'error');
  }
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
  try {
    const response = await apiFetch(`/api/todos/${id}`, { method: 'DELETE' });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${response.status}`);
    }
  } catch (err) {
    showToast('删除待办失败: ' + err.message, 'error');
  }
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
  const saveButton = $('#btnTodoReminderSave');
  if (saveButton.disabled) return;
  saveButton.disabled = true;
  const useCustomSmtp = $('#todoSmtpUseCustom').checked;
  const body = {
    enabled: $('#todoReminderEnabled').checked,
    recipientEmail: $('#todoReminderRecipient').value.trim(),
    sendTime: $('#todoReminderTime').value || '08:00',
    smtp: useCustomSmtp ? {
      useCustomSmtp: true,
      host: $('#todoSmtpHost').value.trim(),
      port: Number($('#todoSmtpPort').value),
      secureMode: $('#todoSmtpSecureMode').value,
      fromAddress: $('#todoSmtpFromAddress').value.trim(),
      authUser: $('#todoSmtpAuthUser').value.trim(),
      password: $('#todoSmtpPassword').value,
      clearPassword: $('#todoSmtpClearPassword').checked,
    } : { useCustomSmtp: false },
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
    $('#todoSmtpPassword').value = '';
    $('#todoSmtpClearPassword').checked = false;
    todoReminderUiMessage = '提醒设置已保存。';
    renderTodoReminderSettings();
    showToast('提醒设置已保存', 'success');
  } catch (err) {
    todoReminderUiMessage = '保存失败：' + err.message;
    $('#todoReminderStatusText').textContent = todoReminderUiMessage;
    $('#todoReminderMailState').textContent = '保存失败';
    $('#todoReminderOpen').setAttribute('aria-label', '邮件提醒设置，保存失败');
    $('#todoReminderOpen').title = '邮件提醒：保存失败';
    showToast('提醒保存失败: ' + err.message, 'error');
  } finally { saveButton.disabled = false; }
}

async function resetTodoSmtpSettings() {
  if (!todoReminderSettings.smtp.useCustomSmtp) return;
  const confirmed = await confirmDialog({
    title: '恢复环境配置',
    message: '清除已保存的自定义 SMTP 配置，改用服务环境中的邮件设置。',
    confirmText: '恢复',
    danger: false,
  });
  if (!confirmed) return;
  $('#todoSmtpUseCustom').checked = false;
  $('#todoSmtpFields').hidden = true;
  await saveTodoReminderSettings();
}

function openTodoTestEmailDialog() {
  if (!todoReminderSettings.mailReady) {
    showToast('请先配置并保存 SMTP 发件服务器', 'error');
    return;
  }
  $('#todoTestEmailInput').value = $('#todoReminderRecipient').value.trim();
  $('#todoTestEmailDialog').showModal();
  $('#todoTestEmailInput').focus();
  $('#todoTestEmailInput').select();
}

async function sendTodoReminderTestEmail(event) {
  event.preventDefault();
  const input = $('#todoTestEmailInput');
  const button = $('#todoTestEmailSend');
  const to = input.value.trim();
  if (!input.reportValidity()) return;
  button.disabled = true;
  try {
    const response = await apiFetch('/api/todo-reminder-settings/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to }),
    });
    const result = await response.json().catch(() => ({}));
    $('#todoTestEmailDialog').close();
    todoReminderUiMessage = `测试邮件已发送到 ${result.to || to}。`;
    renderTodoReminderSettings();
    showToast('测试邮件已发送', 'success');
  } catch (error) {
    todoReminderUiMessage = `测试邮件发送失败：${error.message}`;
    renderTodoReminderSettings();
    showToast('测试邮件发送失败: ' + error.message, 'error');
  } finally {
    button.disabled = false;
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
  detailController = createTodoDetailController({ onClose: () => { resetTodoForm(); resetCountdownForm(); } });
  $('#btnTodoDetailClose').addEventListener('click', () => detailController.close());
  $('#btnCountdownDetailClose').addEventListener('click', () => detailController.close());
  initTodoReminderPanel();
  $('#todoSearchClear').addEventListener('click', () => {
    const search = $('#todoSearchInput'); search.value = '';
    search.dispatchEvent(new Event('input', { bubbles: true })); search.focus();
  });
  $('#todoView').addEventListener('click', event => {
    if (!event.target.closest('[data-todo-empty-action]')) return;
    if (todoSearchQuery.trim()) { todoSearchQuery = ''; $('#todoSearchInput').value = ''; renderTodos(); $('#todoSearchInput').focus(); }
    else $('#btnTodoNew').click();
  });
  $('#todoFullList').addEventListener('keydown', event => {
    if (!['Enter', ' '].includes(event.key) || !event.target.matches('.todo-item')) return;
    event.preventDefault(); event.target.click();
  });
  $('#todoFullList').addEventListener('click', (e) => handleTodoListClick(e, { full: true }));
  $('#todoClearCompleted')?.addEventListener('click', clearCompletedTodos);
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
  $('#countdownSidebarList').addEventListener('click', async event => {
    const button = event.target.closest('[data-countdown-select]');
    if (!button) return;
    const item = allCountdowns.find(entry => entry.id === Number(button.dataset.countdownSelect));
    if (!item) return;
    await fillCountdownForm(item);
    if (selectedCountdownId !== item.id) return;
    if (window.matchMedia?.('(max-width: 840px)').matches) { document.body.classList.remove('sidebar-visible'); $('#workspaceSidebar').inert = true; $('#workspaceSidebar').setAttribute('aria-hidden', 'true'); $('#sidebarOpen').setAttribute('aria-expanded', 'false'); $('#sidebarBackdrop').hidden = true; $('#countdownTitle').focus(); }
  });
  setupTodoDrag($('#todoFullList'));
  $('#btnTodoNew').addEventListener('click', () => {
    if (todoPageMode === 'countdowns') startNewCountdown();
    else startNewTodo();
  });
  $('#btnTodoFullSave').addEventListener('click', saveTodoFromFullForm);
  $('#btnTodoFormCancel').addEventListener('click', () => detailController.close());
  $('#btnCountdownSave').addEventListener('click', saveCountdownFromForm);
  $('#btnCountdownCancel').addEventListener('click', () => detailController.close());
  $('#btnTodoReminderSave').addEventListener('click', saveTodoReminderSettings);
  $('#todoSmtpUseCustom').addEventListener('change', event => {
    $('#todoSmtpFields').hidden = !event.target.checked;
  });
  $('#btnTodoSmtpReset').addEventListener('click', resetTodoSmtpSettings);
  $('#btnTodoReminderTest').addEventListener('click', openTodoTestEmailDialog);
  $('#todoTestEmailClose').addEventListener('click', () => $('#todoTestEmailDialog').close());
  $('#todoTestEmailCancel').addEventListener('click', () => $('#todoTestEmailDialog').close());
  $('#todoTestEmailDialog').addEventListener('close', () => $('#btnTodoReminderTest').focus());
  $('#todoTestEmailForm').addEventListener('submit', sendTodoReminderTestEmail);
  $('#todoReminderEnabled').addEventListener('change', (e) => {
    if (!todoReminderSettings.mailReady && e.target.checked) {
      e.target.checked = false;
      todoReminderUiMessage = '请先配置 SMTP 发件服务器并保存，再启用每日提醒。';
      $('#todoReminderStatusText').textContent = todoReminderUiMessage;
      showToast('请先配置并保存 SMTP 发件服务器', 'error');
    } else {
      todoReminderUiMessage = '';
      $('#todoReminderStatusText').textContent = '设置已修改，请保存提醒。';
    }
  });
  $('#todoFullTitle').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); saveTodoFromFullForm(); }
  });
  const todoFilterTabs = $('#todoFilterTabs');
  todoFilterTabs.addEventListener('click', (event) => {
    const more = event.target.closest('[data-category-more]');
    if (more) { openTodoCategoryMenu(more); return; }
    const action = event.target.closest('[data-action="rename-category"], [data-action="delete-category"]');
    if (action) {
      const { category } = action.dataset;
      closeTodoCategoryMenu();
      if (action.dataset.action === 'rename-category') openTodoCategoryModal({ mode: 'rename', category, returnCategory: category });
      else deleteTodoCategory(category);
      return;
    }
    const button = event.target.closest('button[data-filter]');
    if (!button) return;
    closeTodoCategoryMenu();
    activeFilter = button.dataset.filter;
    localStorage.setItem('todoFilter', activeFilter);
    renderFullTodos();
    focusTodoFilter(activeFilter);
  });
  todoFilterTabs.addEventListener('keydown', (event) => {
    const more = event.target.closest('[data-category-more]');
    if (more && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
      event.preventDefault();
      openTodoCategoryMenu(more, { focusFirst: true });
      return;
    }
    const menu = event.target.closest('.todo-category-menu');
    if (menu) {
      const items = [...menu.querySelectorAll('[role="menuitem"]')];
      const index = items.indexOf(document.activeElement);
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation(); closeTodoCategoryMenu({ restoreFocus: true });
      } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
          : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
      }
    }
  });
  todoFilterTabs.addEventListener('focusout', (event) => {
    const row = event.target.closest('[data-todo-category-row]');
    if (!row) return;
    setTimeout(() => {
      if (todoCategoryMenuName && !row.contains(document.activeElement)) closeTodoCategoryMenu();
    }, 0);
  });
  document.addEventListener('pointerdown', event => {
    if (todoCategoryMenuName && !event.target.closest('#todoFilterTabs')) closeTodoCategoryMenu();
  });
  document.addEventListener('scroll', () => { if (todoCategoryMenuName) closeTodoCategoryMenu(); }, true);
  window.addEventListener('resize', () => { if (todoCategoryMenuName) closeTodoCategoryMenu(); });
  $('#todoSearchInput').addEventListener('input', (e) => {
    todoSearchQuery = e.target.value || '';
    $('#todoSearchClear').hidden = !todoSearchQuery;
    if (todoPageMode === 'countdowns') renderCountdowns();
    else renderFullTodos();
  });
  $('#todoModeTabs').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-todo-page]');
    if (!button || !['todos', 'countdowns'].includes(button.dataset.todoPage)) return;
    if (button.dataset.todoPage === todoPageMode) return;
    if (!(await detailController.allowDiscard())) return;
    detailController.discard();
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
  $('#todoCategoryOverlay').addEventListener('cancel', (event) => {
    event.preventDefault();
    closeTodoCategoryModal();
  });
  $('#todoCategoryInput').addEventListener('input', () => showTodoCategoryError(''));
  $('#todoCategoryAddForm').addEventListener('submit', addTodoCategoryFromForm);
  initTodoSelectControls();
}
