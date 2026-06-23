import { state } from './state.js';
import { $, escHtml } from './helpers.js';
import { loadLogs } from './logList.js';
import { businessDateString, formatDateLabel, formatTemplateDate } from './businessDate.js';

const calendarDays = $('#calendarDays');
const calYearSelect = $('#calendarYearSelect');
const calMonthSelect = $('#calendarMonthSelect');
const calendarWidget = $('#calendarWidget');
const calendarCollapseToggle = $('#calendarCollapseToggle');
const calendarMiniToday = $('#calendarMiniToday');
const CALENDAR_COLLAPSED_STORAGE_KEY = 'calendarCollapsed';
const CALENDAR_SELECT_IDS = ['calendarYearSelect', 'calendarMonthSelect'];
let calendarFocusDate = businessDateString();
let calendarCollapsed = loadCalendarCollapsed();

function calendarSelectControls() {
  return CALENDAR_SELECT_IDS
    .map(id => document.querySelector(`[data-calendar-select-control][data-select-id="${id}"]`))
    .filter(Boolean);
}

function closeCalendarSelectControl(control) {
  if (!control) return;
  control.classList.remove('open');
  control.querySelector('.calendar-select-trigger')?.setAttribute('aria-expanded', 'false');
  const menu = control.querySelector('.calendar-select-menu');
  if (menu) menu.hidden = true;
}

function closeCalendarSelectControls(except = null) {
  calendarSelectControls().forEach(control => {
    if (control !== except) closeCalendarSelectControl(control);
  });
}

function focusCalendarSelectOption(control, direction = 1) {
  const options = [...control.querySelectorAll('.calendar-select-option')];
  if (!options.length) return;
  const activeIndex = options.indexOf(document.activeElement);
  const selectedIndex = options.findIndex(option => option.getAttribute('aria-selected') === 'true');
  const baseIndex = activeIndex >= 0 ? activeIndex : (selectedIndex >= 0 ? selectedIndex : 0);
  const nextIndex = (baseIndex + direction + options.length) % options.length;
  options[nextIndex].focus();
}

function openCalendarSelectControl(control, { focusSelected = false } = {}) {
  const trigger = control.querySelector('.calendar-select-trigger');
  const menu = control.querySelector('.calendar-select-menu');
  if (!trigger || !menu) return;
  syncCalendarSelectControls();
  closeCalendarSelectControls(control);
  control.classList.add('open');
  trigger.setAttribute('aria-expanded', 'true');
  menu.hidden = false;
  if (focusSelected) {
    const selected = menu.querySelector('.calendar-select-option[aria-selected="true"]');
    (selected || menu.querySelector('.calendar-select-option'))?.focus();
  }
}

function toggleCalendarSelectControl(control) {
  if (control.classList.contains('open')) closeCalendarSelectControl(control);
  else openCalendarSelectControl(control);
}

function selectFromCalendarOption(control, optionButton) {
  const select = document.getElementById(control.dataset.selectId);
  if (!select || !optionButton) return;
  select.value = optionButton.dataset.value || '';
  closeCalendarSelectControl(control);
  select.dispatchEvent(new Event('change', { bubbles: true }));
  syncCalendarSelectControls();
  control.querySelector('.calendar-select-trigger')?.focus();
}

function syncCalendarSelectControls() {
  calendarSelectControls().forEach(control => {
    const select = document.getElementById(control.dataset.selectId);
    const trigger = control.querySelector('.calendar-select-trigger');
    const value = control.querySelector('.calendar-select-value');
    const menu = control.querySelector('.calendar-select-menu');
    if (!select || !trigger || !value || !menu) return;

    const options = [...select.options];
    const selected = select.selectedOptions[0] || options.find(option => option.value === select.value) || options[0];
    value.textContent = selected?.textContent || '';
    trigger.setAttribute('aria-label', `${select.labels?.[0]?.textContent || '选择'}：${selected?.textContent || '未选择'}`);
    menu.innerHTML = options.map(option => `
      <button
        class="calendar-select-option${option.value === select.value ? ' selected' : ''}"
        type="button"
        role="option"
        data-value="${escHtml(option.value)}"
        aria-selected="${option.value === select.value}"
        tabindex="-1"
      >${escHtml(option.textContent)}</button>
    `).join('');
  });
}

function initCalendarSelectControls() {
  calendarSelectControls().forEach(control => {
    const trigger = control.querySelector('.calendar-select-trigger');
    const menu = control.querySelector('.calendar-select-menu');
    trigger?.addEventListener('click', () => toggleCalendarSelectControl(control));
    trigger?.addEventListener('keydown', (event) => {
      if (!['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) return;
      event.preventDefault();
      openCalendarSelectControl(control, { focusSelected: true });
      if (event.key === 'ArrowUp') focusCalendarSelectOption(control, -1);
    });
    menu?.addEventListener('click', (event) => {
      const option = event.target.closest('.calendar-select-option');
      if (option) selectFromCalendarOption(control, option);
    });
    menu?.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        focusCalendarSelectOption(control, 1);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        focusCalendarSelectOption(control, -1);
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        selectFromCalendarOption(control, event.target.closest('.calendar-select-option'));
      } else if (event.key === 'Escape') {
        event.preventDefault();
        closeCalendarSelectControl(control);
        trigger?.focus();
      }
    });
  });
  document.addEventListener('click', (event) => {
    if (!event.target.closest('[data-calendar-select-control]')) closeCalendarSelectControls();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeCalendarSelectControls();
  });
}

function loadCalendarCollapsed() {
  try {
    return localStorage.getItem(CALENDAR_COLLAPSED_STORAGE_KEY) === 'true';
  } catch (err) {
    return false;
  }
}

function saveCalendarCollapsed(collapsed) {
  try {
    localStorage.setItem(CALENDAR_COLLAPSED_STORAGE_KEY, String(collapsed));
  } catch (err) {
    // Calendar collapse is a visual preference; storage failures should not block use.
  }
}

function dateString(year, month, day) {
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function dateParts(value) {
  const [year, month, day] = value.split('-').map(Number);
  return { year, month: month - 1, day };
}

function moveDate(value, days) {
  const { year, month, day } = dateParts(value);
  const next = new Date(Date.UTC(year, month, day + days));
  return dateString(next.getUTCFullYear(), next.getUTCMonth(), next.getUTCDate());
}

function moveMonth(value, months) {
  const { year, month, day } = dateParts(value);
  const target = new Date(Date.UTC(year, month + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  return dateString(target.getUTCFullYear(), target.getUTCMonth(), Math.min(day, lastDay));
}

function applyCalendarCollapsed() {
  calendarWidget.classList.toggle('collapsed', calendarCollapsed);
  calendarCollapseToggle.setAttribute('aria-expanded', String(!calendarCollapsed));
  calendarCollapseToggle.title = calendarCollapsed ? '展开日历' : '收起日历';
}

function updateCalendarMiniSummary() {
  const today = businessDateString();
  calendarMiniToday.textContent = formatTemplateDate(today, 'MM月DD日 ddd');
}

function focusCalendarDate(value) {
  calendarFocusDate = value;
  const { year, month } = dateParts(value);
  state.currentYear = year;
  state.currentMonth = month;
  populateCalendarSelects();
  renderCalendar();
  requestAnimationFrame(() => {
    calendarDays.querySelector(`[data-date="${value}"]`)?.focus();
  });
}

export function populateCalendarSelects() {
  const thisYear = dateParts(businessDateString()).year;
  let yearOpts = '';
  for (let y = thisYear - 5; y <= thisYear + 5; y++) {
    yearOpts += `<option value="${y}" ${y === state.currentYear ? 'selected' : ''}>${y}年</option>`;
  }
  calYearSelect.innerHTML = yearOpts;

  let monthOpts = '';
  for (let m = 0; m < 12; m++) {
    monthOpts += `<option value="${m}" ${m === state.currentMonth ? 'selected' : ''}>${m + 1}月</option>`;
  }
  calMonthSelect.innerHTML = monthOpts;
  syncCalendarSelectControls();
}

function updateCalendarFromSelects() {
  state.currentYear = parseInt(calYearSelect.value, 10);
  state.currentMonth = parseInt(calMonthSelect.value, 10);
  const currentDay = dateParts(calendarFocusDate).day;
  const lastDay = new Date(Date.UTC(state.currentYear, state.currentMonth + 1, 0)).getUTCDate();
  calendarFocusDate = dateString(state.currentYear, state.currentMonth, Math.min(currentDay, lastDay));
  renderCalendar();
}

function isTodoCalendarMode() {
  return document.body.classList.contains('sidebar-todo-mode');
}

calYearSelect.addEventListener('change', updateCalendarFromSelects);
calMonthSelect.addEventListener('change', updateCalendarFromSelects);

export function renderCalendar() {
  const { currentYear, currentMonth, selectedDate } = state;
  const todoMode = isTodoCalendarMode();
  const today = businessDateString();
  const firstDay = new Date(Date.UTC(currentYear, currentMonth, 1)).getUTCDay();
  const monthDays = new Date(Date.UTC(currentYear, currentMonth + 1, 0)).getUTCDate();
  const prevMonthDays = new Date(Date.UTC(currentYear, currentMonth, 0)).getUTCDate();
  const visibleMonth = `${currentYear}-${String(currentMonth + 1).padStart(2, '0')}`;
  const markedDates = todoMode ? state.datesWithTodos : state.datesWithLogs;

  calYearSelect.value = currentYear;
  calMonthSelect.value = currentMonth;
  if (!calendarFocusDate.startsWith(visibleMonth)) {
    calendarFocusDate = selectedDate?.startsWith(visibleMonth)
      ? selectedDate
      : (today.startsWith(visibleMonth) ? today : dateString(currentYear, currentMonth, 1));
  }
  updateCalendarMiniSummary();

  let html = '';
  for (let i = firstDay - 1; i >= 0; i--) {
    html += `<span class="calendar-day other-month" aria-hidden="true">${prevMonthDays - i}</span>`;
  }
  for (let day = 1; day <= monthDays; day++) {
    const value = dateString(currentYear, currentMonth, day);
    const hasMarkedItem = markedDates.includes(value);
    let cls = 'calendar-day';
    if (value === today) cls += ' today';
    if (!todoMode && value === selectedDate) cls += ' selected';
    if (hasMarkedItem) cls += todoMode ? ' has-todos' : ' has-logs';
    const status = [
      value === today ? '今天' : '',
      !todoMode && value === selectedDate ? '已选择' : '',
      hasMarkedItem ? (todoMode ? '有待办' : '有日志') : '',
    ].filter(Boolean).join('，');
    const label = `${formatDateLabel(value)}${status ? `，${status}` : ''}`;
    html += `<button type="button" class="${cls}" data-date="${value}" role="gridcell" aria-label="${label}" aria-pressed="${!todoMode && value === selectedDate}" tabindex="${value === calendarFocusDate ? '0' : '-1'}">${day}</button>`;
  }
  const remaining = 7 - ((firstDay + monthDays) % 7);
  if (remaining < 7) {
    for (let day = 1; day <= remaining; day++) {
      html += `<span class="calendar-day other-month" aria-hidden="true">${day}</span>`;
    }
  }
  calendarDays.innerHTML = html;
}

function selectDate(value) {
  if (isTodoCalendarMode()) {
    calendarFocusDate = value;
    renderCalendar();
    return;
  }
  calendarFocusDate = value;
  if (state.selectedDate === value) {
    state.selectedDate = null;
  } else {
    state.selectedDate = value;
    state.month = '';
    $('#filterMonth').value = '';
  }
  state.currentPage = 1;
  renderCalendar();
  loadLogs();
}

calendarDays.addEventListener('click', (event) => {
  const day = event.target.closest('button.calendar-day[data-date]');
  if (!day) return;
  selectDate(day.dataset.date);
});

calendarDays.addEventListener('keydown', (event) => {
  const day = event.target.closest('button.calendar-day[data-date]');
  if (!day) return;
  let nextDate = null;
  if (event.key === 'ArrowLeft') nextDate = moveDate(day.dataset.date, -1);
  if (event.key === 'ArrowRight') nextDate = moveDate(day.dataset.date, 1);
  if (event.key === 'ArrowUp') nextDate = moveDate(day.dataset.date, -7);
  if (event.key === 'ArrowDown') nextDate = moveDate(day.dataset.date, 7);
  if (event.key === 'PageUp') nextDate = moveMonth(day.dataset.date, -1);
  if (event.key === 'PageDown') nextDate = moveMonth(day.dataset.date, 1);
  if (!nextDate) return;
  event.preventDefault();
  focusCalendarDate(nextDate);
});

applyCalendarCollapsed();
initCalendarSelectControls();
syncCalendarSelectControls();

calendarCollapseToggle.addEventListener('click', () => {
  calendarCollapsed = !calendarCollapsed;
  saveCalendarCollapsed(calendarCollapsed);
  applyCalendarCollapsed();
});
