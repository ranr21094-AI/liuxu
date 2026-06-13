import { state } from './state.js';
import { $ } from './helpers.js';
import { loadLogs } from './logList.js';
import { businessDateString, formatDateLabel, formatTemplateDate } from './businessDate.js';

const calendarDays = $('#calendarDays');
const calYearSelect = $('#calendarYearSelect');
const calMonthSelect = $('#calendarMonthSelect');
const calendarWidget = $('#calendarWidget');
const calendarCollapseToggle = $('#calendarCollapseToggle');
const calendarMiniToday = $('#calendarMiniToday');
const CALENDAR_COLLAPSED_STORAGE_KEY = 'calendarCollapsed';
let calendarFocusDate = businessDateString();
let calendarCollapsed = loadCalendarCollapsed();

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
}

function updateCalendarFromSelects() {
  state.currentYear = parseInt(calYearSelect.value, 10);
  state.currentMonth = parseInt(calMonthSelect.value, 10);
  const currentDay = dateParts(calendarFocusDate).day;
  const lastDay = new Date(Date.UTC(state.currentYear, state.currentMonth + 1, 0)).getUTCDate();
  calendarFocusDate = dateString(state.currentYear, state.currentMonth, Math.min(currentDay, lastDay));
  renderCalendar();
}

calYearSelect.addEventListener('change', updateCalendarFromSelects);
calMonthSelect.addEventListener('change', updateCalendarFromSelects);

export function renderCalendar() {
  const { currentYear, currentMonth, selectedDate } = state;
  const today = businessDateString();
  const firstDay = new Date(Date.UTC(currentYear, currentMonth, 1)).getUTCDay();
  const monthDays = new Date(Date.UTC(currentYear, currentMonth + 1, 0)).getUTCDate();
  const prevMonthDays = new Date(Date.UTC(currentYear, currentMonth, 0)).getUTCDate();
  const visibleMonth = `${currentYear}-${String(currentMonth + 1).padStart(2, '0')}`;

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
    const hasLogs = state.datesWithLogs.includes(value);
    let cls = 'calendar-day';
    if (value === today) cls += ' today';
    if (value === selectedDate) cls += ' selected';
    if (hasLogs) cls += ' has-logs';
    const status = [
      value === today ? '今天' : '',
      value === selectedDate ? '已选择' : '',
      hasLogs ? '有日志' : '',
    ].filter(Boolean).join('，');
    const label = `${formatDateLabel(value)}${status ? `，${status}` : ''}`;
    html += `<button type="button" class="${cls}" data-date="${value}" role="gridcell" aria-label="${label}" aria-pressed="${value === selectedDate}" tabindex="${value === calendarFocusDate ? '0' : '-1'}">${day}</button>`;
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

function changeMonth(delta) {
  focusCalendarDate(moveMonth(calendarFocusDate, delta));
}

applyCalendarCollapsed();

calendarCollapseToggle.addEventListener('click', () => {
  calendarCollapsed = !calendarCollapsed;
  saveCalendarCollapsed(calendarCollapsed);
  applyCalendarCollapsed();
});

$('#prevMonth').addEventListener('click', () => changeMonth(-1));
$('#nextMonth').addEventListener('click', () => changeMonth(1));
