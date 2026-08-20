import { escHtml } from './helpers.js';

const CONTROL_SELECTOR = '[data-select-control], [data-todo-select-control]';
const TRIGGER_SELECTOR = '.select-control-trigger, .todo-select-trigger';
const MENU_SELECTOR = '.select-control-menu, .todo-select-menu';
const VALUE_SELECTOR = '.select-control-value, .todo-select-value';
const OPTION_SELECTOR = '.select-control-option, .todo-select-option';

let globalListenersBound = false;

function selectControls({ root, ids } = {}) {
  const scope = root || document;
  let controls = [...scope.querySelectorAll(CONTROL_SELECTOR)];
  if (ids?.length) {
    controls = controls.filter(control => ids.includes(control.dataset.selectId));
  }
  return controls;
}

function closeSelectControl(control) {
  if (!control) return;
  control.classList.remove('open');
  control.querySelector(TRIGGER_SELECTOR)?.setAttribute('aria-expanded', 'false');
  const menu = control.querySelector(MENU_SELECTOR);
  if (menu) menu.hidden = true;
}

export function closeSelectControls(except = null) {
  selectControls().forEach(control => {
    if (control !== except) closeSelectControl(control);
  });
}

function selectFromOption(control, optionButton) {
  const select = document.getElementById(control.dataset.selectId);
  if (!select || !optionButton || select.disabled) return;
  select.value = optionButton.dataset.value ?? '';
  closeSelectControl(control);
  select.dispatchEvent(new Event('change', { bubbles: true }));
  syncSelectControls({ ids: [control.dataset.selectId] });
  control.querySelector(TRIGGER_SELECTOR)?.focus();
}

function focusOption(control, direction = 1) {
  const options = [...control.querySelectorAll(OPTION_SELECTOR)];
  if (!options.length) return;
  const activeIndex = options.indexOf(document.activeElement);
  const selectedIndex = options.findIndex(option => option.getAttribute('aria-selected') === 'true');
  const baseIndex = activeIndex >= 0 ? activeIndex : (selectedIndex >= 0 ? selectedIndex : 0);
  const nextIndex = (baseIndex + direction + options.length) % options.length;
  options[nextIndex].focus();
}

function openSelectControl(control, { focusSelected = false } = {}) {
  const select = document.getElementById(control.dataset.selectId);
  const trigger = control.querySelector(TRIGGER_SELECTOR);
  const menu = control.querySelector(MENU_SELECTOR);
  if (!select || select.disabled || !trigger || !menu) return;
  syncSelectControls({ ids: [control.dataset.selectId] });
  closeSelectControls(control);
  control.classList.add('open');
  trigger.setAttribute('aria-expanded', 'true');
  menu.hidden = false;
  if (focusSelected) {
    const selected = menu.querySelector(`${OPTION_SELECTOR}[aria-selected="true"]`);
    (selected || menu.querySelector(OPTION_SELECTOR))?.focus();
  }
}

function toggleSelectControl(control) {
  if (control.classList.contains('open')) closeSelectControl(control);
  else openSelectControl(control);
}

export function syncSelectControls({ root, ids } = {}) {
  selectControls({ root, ids }).forEach(control => {
    const select = document.getElementById(control.dataset.selectId);
    const trigger = control.querySelector(TRIGGER_SELECTOR);
    const value = control.querySelector(VALUE_SELECTOR);
    const menu = control.querySelector(MENU_SELECTOR);
    if (!select || !trigger || !value || !menu) return;

    const options = [...select.options];
    const selected = select.selectedOptions[0]
      || options.find(option => option.value === select.value)
      || options[0];
    const hasValue = Boolean(select.value && select.value !== 'none');
    const disabled = Boolean(select.disabled);

    value.textContent = selected?.textContent || '';
    control.classList.toggle('has-value', hasValue);
    control.classList.toggle('is-disabled', disabled);
    trigger.disabled = disabled;
    trigger.setAttribute('aria-disabled', String(disabled));
    trigger.setAttribute('aria-label', `${select.labels?.[0]?.textContent || '选择'}：${selected?.textContent || '未选择'}`);
    menu.innerHTML = options.map(option => `
      <button
        class="select-control-option todo-select-option${option.value === select.value ? ' selected' : ''}"
        type="button"
        role="option"
        data-value="${escHtml(option.value)}"
        aria-selected="${option.value === select.value}"
        tabindex="-1"
        ${disabled ? 'disabled' : ''}
      >${escHtml(option.textContent)}</button>
    `).join('');
  });
}

function bindGlobalListeners() {
  if (globalListenersBound) return;
  globalListenersBound = true;
  document.addEventListener('click', (event) => {
    if (!event.target.closest(CONTROL_SELECTOR)) closeSelectControls();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeSelectControls();
  });
}

export function initSelectControls({ root, ids } = {}) {
  bindGlobalListeners();
  selectControls({ root, ids }).forEach(control => {
    if (control.dataset.selectBound === 'true') return;
    control.dataset.selectBound = 'true';

    const trigger = control.querySelector(TRIGGER_SELECTOR);
    const menu = control.querySelector(MENU_SELECTOR);
    trigger?.addEventListener('click', () => toggleSelectControl(control));
    trigger?.addEventListener('keydown', (event) => {
      if (!['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) return;
      event.preventDefault();
      openSelectControl(control, { focusSelected: true });
      if (event.key === 'ArrowUp') focusOption(control, -1);
    });
    menu?.addEventListener('click', (event) => {
      const option = event.target.closest(OPTION_SELECTOR);
      if (option) selectFromOption(control, option);
    });
    menu?.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        focusOption(control, 1);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        focusOption(control, -1);
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        selectFromOption(control, event.target.closest(OPTION_SELECTOR));
      } else if (event.key === 'Escape') {
        event.preventDefault();
        closeSelectControl(control);
        trigger?.focus();
      }
    });
  });
  syncSelectControls({ root, ids });
}
