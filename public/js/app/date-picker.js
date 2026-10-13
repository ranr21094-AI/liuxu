const controllers = new WeakMap();
const IDS = ['knowledgeDateFilter', 'documentDate', 'mentionDateInput', 'todoFullDueDate', 'countdownTargetDate'];
const CALENDAR_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"></rect><path d="M16 3v4M8 3v4M3 11h18"></path></svg>';

export function parseDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number);
  if (year < 1 || year > 9999) return null;
  const date = new Date(0);
  date.setHours(12, 0, 0, 0);
  date.setFullYear(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null;
}
export function formatDate(date) {
  return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
export function shiftMonth(date, offset) {
  const next = new Date(date);
  const day = next.getDate();
  next.setDate(1);
  next.setMonth(next.getMonth() + offset);
  const last = new Date(next);
  last.setMonth(last.getMonth() + 1, 0);
  next.setDate(Math.min(day, last.getDate()));
  return next;
}
export function calendarDays(year, month) {
  const first = parseDate(`${String(year).padStart(4, '0')}-${String(month + 1).padStart(2, '0')}-01`);
  if (!first) return [];
  first.setDate(first.getDate() - (first.getDay() + 6) % 7);
  return Array.from({ length: 42 }, (_, index) => { const day = new Date(first); day.setDate(day.getDate() + index); return day; });
}
function dayIndex(date) {
  const utc = new Date(0);
  utc.setUTCHours(0, 0, 0, 0);
  utc.setUTCFullYear(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.floor(utc.getTime() / 86400000);
}
function allowed(input, date) {
  const value = formatDate(date);
  if (!parseDate(value) || (input.min && value < input.min) || (input.max && value > input.max)) return false;
  if (input.step && input.step !== 'any') {
    const step = Number(input.step);
    const base = parseDate(input.min) || parseDate(input.getAttribute('value')) || parseDate('1970-01-01');
    if (step > 0 && (dayIndex(date) - dayIndex(base)) % step !== 0) return false;
  }
  return true;
}
export function isDatePickerTarget(target, ownerId) {
  return target?.closest?.('[data-date-picker-owner]')?.dataset.datePickerOwner === ownerId;
}
export function syncDatePickers(document = globalThis.document) { controllers.get(document)?.sync(); }
export function closeDatePickers(document = globalThis.document, ownerId = '') { controllers.get(document)?.closeOwner(ownerId); }

export function initDatePickers(document = globalThis.document) {
  if (controllers.has(document)) return controllers.get(document);
  const window = document.defaultView;
  const fields = new Map();
  const popup = document.createElement('div');
  popup.id = 'sharedDatePicker';
  popup.className = 'date-picker-popup';
  popup.setAttribute('role', 'dialog');
  popup.setAttribute('aria-label', '选择日期');
  popup.setAttribute('popover', 'manual');
  popup.hidden = true;
  document.body.append(popup);
  let owner = null, ownerValue = '', cursor = null, shownYear = 0, shownMonth = 0;
  const editable = field => {
    const details = field.input.closest('details');
    return !field.input.disabled && !field.input.readOnly && !field.input.closest('[hidden], [inert]') && (!details || details.open);
  };
  function close({ focus = false } = {}) {
    const previous = owner;
    owner = null;
    if (typeof popup.hidePopover === 'function') { try { popup.hidePopover(); } catch {} }
    popup.hidden = true;
    previous?.button.setAttribute('aria-expanded', 'false');
    if (focus && previous && editable(previous)) previous.button.focus();
  }
  function position() {
    if (!owner) return;
    const anchor = owner.button.getBoundingClientRect();
    const height = window.innerHeight, width = window.innerWidth;
    popup.style.width = `${Math.max(0, Math.min(288, width - 24))}px`;
    popup.style.maxHeight = `${Math.max(0, height - 24)}px`;
    const panelHeight = popup.getBoundingClientRect().height;
    const down = height - anchor.bottom - 20;
    const up = anchor.top - 20;
    let top = anchor.bottom + 8;
    if (panelHeight > down && up > down) top = anchor.top - panelHeight - 8;
    popup.style.top = `${Math.max(12, Math.min(top, height - panelHeight - 12))}px`;
    popup.style.left = `${Math.max(12, Math.min(anchor.left, width - popup.getBoundingClientRect().width - 12))}px`;
  }
  function sync() {
    fields.forEach(field => {
      const { input, button, label } = field;
      const valueLabel = button.querySelector('.date-picker-value');
      const valueText = input.value || '选择日期';
      if (valueLabel.textContent !== valueText) valueLabel.textContent = valueText;
      button.classList.toggle('is-empty', !input.value);
      const disabled = input.disabled || input.readOnly;
      if (button.disabled !== disabled) button.disabled = disabled;
      button.setAttribute('aria-label', `${label}：${input.value || '选择日期'}${input.required ? '（必填）' : ''}`);
      button.title = button.getAttribute('aria-label');
    });
    if (owner && (!editable(owner) || owner.input.value !== ownerValue)) close();
  }
  function render({ focusPart = '' } = {}) {
    if (!owner) return;
    const input = owner.input;
    const today = formatDate(new Date());
    const days = calendarDays(shownYear, shownMonth);
    const selected = input.value;
    if (!days.some(day => formatDate(day) === formatDate(cursor) && allowed(input, day))) {
      cursor = days.find(day => day.getMonth() === shownMonth && allowed(input, day)) || days.find(day => allowed(input, day)) || cursor;
    }
    popup.innerHTML = `
      <div class="date-picker-heading">
        <button type="button" data-date-command="prev" aria-label="上一月" ${shownYear === 1 && shownMonth === 0 ? 'disabled' : ''}>‹</button>
        <div class="date-picker-month-year"><input type="number" data-date-year aria-label="年份" min="1" max="9999" value="${shownYear}"><span aria-hidden="true">年</span><select data-date-month aria-label="月份">${Array.from({ length: 12 }, (_, month) => `<option value="${month}" ${month === shownMonth ? 'selected' : ''}>${month + 1}月</option>`).join('')}</select></div>
        <button type="button" data-date-command="next" aria-label="下一月" ${shownYear === 9999 && shownMonth === 11 ? 'disabled' : ''}>›</button>
      </div>
      <div class="date-picker-grid" role="grid" aria-label="${shownYear}年${shownMonth + 1}月">
        <div class="date-picker-week" role="row">${['一', '二', '三', '四', '五', '六', '日'].map(day => `<span role="columnheader">${day}</span>`).join('')}</div>
        ${Array.from({ length: 6 }, (_, row) => `<div class="date-picker-week" role="row">${days.slice(row * 7, row * 7 + 7).map(day => {
          const value = formatDate(day);
          const valid = allowed(input, day);
          return `<span role="gridcell" aria-selected="${value === selected}"><button type="button" data-date-value="${value}" aria-label="${value}${value === today ? '，今天' : ''}" tabindex="${valid && value === formatDate(cursor) ? '0' : '-1'}" ${valid ? '' : 'disabled'} class="date-picker-day${day.getMonth() !== shownMonth ? ' is-adjacent' : ''}${value === selected ? ' is-selected' : ''}${value === today ? ' is-today' : ''}">${day.getDate()}</button></span>`;
        }).join('')}</div>`).join('')}
      </div>
      <div class="date-picker-footer"><button type="button" data-date-command="today" ${allowed(input, new Date()) ? '' : 'disabled'}>今天</button>${input.required ? '' : '<button type="button" data-date-command="clear">清空</button>'}<button type="button" data-date-command="close" aria-label="关闭日历">关闭</button></div>`;
    position();
    if (focusPart) {
      const selector = focusPart === 'day' ? '.date-picker-day[tabindex="0"]' : focusPart === 'year' ? '[data-date-year]' : focusPart === 'month' ? '[data-date-month]' : `[data-date-command="${focusPart}"]`;
      popup.querySelector(selector)?.focus();
    }
  }
  function open(field) {
    sync();
    if (!editable(field)) return;
    if (owner === field) return close({ focus: true });
    close();
    owner = field;
    ownerValue = field.input.value;
    cursor = parseDate(field.input.value) || parseDate(field.input.min) || new Date();
    cursor.setHours(12, 0, 0, 0);
    shownYear = cursor.getFullYear(); shownMonth = cursor.getMonth();
    popup.dataset.datePickerOwner = field.input.id;
    popup.hidden = false;
    field.button.setAttribute('aria-expanded', 'true');
    if (typeof popup.showPopover === 'function') { try { popup.showPopover(); } catch {} }
    render({ focusPart: 'day' });
  }
  function choose(value) {
    if (!owner || !editable(owner)) return close();
    const field = owner;
    const date = parseDate(value);
    if ((!value && field.input.required) || (value && (!date || !allowed(field.input, date)))) return;
    const changed = field.input.value !== value;
    field.input.value = value;
    close({ focus: true });
    sync();
    if (changed) {
      field.input.dispatchEvent(new window.Event('input', { bubbles: true }));
      field.input.dispatchEvent(new window.Event('change', { bubbles: true }));
    }
  }
  function changeMonth(offset, focusPart = 'day') {
    const next = shiftMonth(cursor, offset);
    if (next.getFullYear() < 1 || next.getFullYear() > 9999) return;
    cursor = next; shownYear = next.getFullYear(); shownMonth = next.getMonth();
    render({ focusPart });
  }
  IDS.forEach(id => {
    const input = document.getElementById(id);
    if (!input) return;
    const label = input.getAttribute('aria-label') || input.title || input.labels?.[0]?.textContent.trim() || '日期';
    const wrapper = document.createElement('span');
    wrapper.className = 'date-picker-field';
    input.before(wrapper); wrapper.append(input);
    input.classList.add('date-picker-native');
    input.tabIndex = -1;
    input.setAttribute('aria-hidden', 'true');
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'date-picker-trigger';
    button.dataset.dateInput = id;
    button.setAttribute('aria-haspopup', 'dialog');
    button.setAttribute('aria-controls', popup.id);
    button.setAttribute('aria-expanded', 'false');
    button.innerHTML = `<span class="date-picker-value"></span>${CALENDAR_ICON}`;
    wrapper.append(button);
    const field = { input, button, label }; fields.set(id, field);
    button.addEventListener('click', () => open(field));
    button.addEventListener('keydown', event => { if (event.key === 'ArrowDown') { event.preventDefault(); open(field); } });
    input.addEventListener('focus', () => button.focus());
    input.addEventListener('click', event => { event.preventDefault(); open(field); });
    input.addEventListener('input', sync); input.addEventListener('change', sync);
  });
  popup.addEventListener('click', event => {
    // Rendering replaces month/day nodes; do not let detached click targets
    // look like outside clicks to the calendar or its parent filter panel.
    event.stopPropagation();
    const day = event.target.closest('[data-date-value]');
    if (day && !day.disabled) return choose(day.dataset.dateValue);
    const command = event.target.closest('[data-date-command]')?.dataset.dateCommand;
    if (command === 'prev' || command === 'next') changeMonth(command === 'prev' ? -1 : 1, command);
    else if (command === 'today') choose(formatDate(new Date()));
    else if (command === 'clear') choose('');
    else if (command === 'close') close({ focus: true });
  });
  popup.addEventListener('change', event => {
    if (!owner) return;
    if (event.target.matches('[data-date-year]')) {
      const year = Number(event.target.value);
      if (!Number.isInteger(year) || year < 1 || year > 9999) { event.target.value = shownYear; return; }
      changeMonth((year - shownYear) * 12, 'year');
    } else if (event.target.matches('[data-date-month]')) changeMonth(Number(event.target.value) - shownMonth, 'month');
  });
  // Capture before sidebar Escape handlers, so nested calendars close first.
  document.addEventListener('keydown', event => {
    if (!owner) return;
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopImmediatePropagation(); close({ focus: true }); return;
    }
    if (!popup.contains(event.target)) return;
    if (event.key === 'Tab') {
      const focusable = [...popup.querySelectorAll('button:not(:disabled):not([tabindex="-1"]), input, select')];
      const index = focusable.indexOf(document.activeElement);
      if (event.shiftKey && index <= 0 || !event.shiftKey && index === focusable.length - 1) {
        event.preventDefault(); (event.shiftKey ? focusable.at(-1) : focusable[0])?.focus();
      }
      return;
    }
    if (!event.target.matches('[data-date-value]')) return;
    if (event.key === 'PageUp' || event.key === 'PageDown') { event.preventDefault(); changeMonth(event.key === 'PageUp' ? -1 : 1); return; }
    const weekday = (cursor.getDay() + 6) % 7;
    const delta = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7, Home: -weekday, End: 6 - weekday }[event.key];
    if (delta == null) return;
    event.preventDefault();
    const next = new Date(cursor); next.setDate(next.getDate() + delta);
    if (!allowed(owner.input, next)) return;
    cursor = next; shownYear = next.getFullYear(); shownMonth = next.getMonth(); render({ focusPart: 'day' });
  }, true);
  document.addEventListener('pointerdown', event => {
    if (owner && !popup.contains(event.target) && !owner.button.contains(event.target) && event.target !== owner.input) close();
  }, true);
  document.addEventListener('click', event => {
    if (owner && !popup.contains(event.target) && !owner.button.contains(event.target) && event.target !== owner.input) close();
  });
  document.addEventListener('scroll', position, true);
  window.addEventListener('resize', position);
  const observer = new window.MutationObserver(sync);
  observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['hidden', 'inert', 'disabled', 'readonly', 'open', 'min', 'max', 'required'] });
  const controller = { sync, closeOwner(id = '') { if (!id || owner?.input.id === id) close(); } };
  controllers.set(document, controller);
  sync();
  return controller;
}
