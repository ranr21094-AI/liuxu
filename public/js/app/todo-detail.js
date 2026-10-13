import { confirmDialog } from '../helpers.js';
import { closeDatePickers } from './date-picker.js';
import { closeSelectControls } from '../selectControl.js';

const fields = {
  todos: ['todoFullTitle', 'todoFullCategory', 'todoFullDueDate', 'todoFullPriority', 'todoFullRecurrence', 'todoFullNotes'],
  countdowns: ['countdownTitle', 'countdownTargetDate', 'countdownRepeatYearly', 'countdownNotes'],
};
export function createTodoDetailController({ document: doc = document, confirm = confirmDialog, onClose }) {
  let mode = null, baseline = '', origin = null, pending = null, saving = false;
  const snapshot = kind => JSON.stringify(fields[kind].map(id => {
    const field = doc.getElementById(id);
    return field?.type === 'checkbox' ? field.checked : field?.value || '';
  }));
  const form = () => doc.getElementById(mode === 'countdowns' ? 'countdownForm' : 'todoFullForm');
  const overlay = () => doc.getElementById('todoView')?.getBoundingClientRect().width < 760;
  function syncLayout() {
    const view = doc.getElementById('todoView');
    view?.classList.toggle('detail-open', !!mode);
    view?.classList.toggle('detail-overlay', !!mode && overlay());
    for (const id of ['todoFullForm', 'countdownForm']) {
      const panel = doc.getElementById(id);
      const active = mode === (id === 'todoFullForm' ? 'todos' : 'countdowns');
      if (!panel) continue;
      panel.hidden = !active;
      if (active && overlay()) { panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true'); }
      else { panel.removeAttribute('role'); panel.removeAttribute('aria-modal'); }
    }
    const list = view?.querySelector('.todo-list-column');
    if (list) list.inert = !!mode && overlay();
  }
  function open(kind, title) {
    origin = doc.activeElement;
    mode = kind;
    baseline = snapshot(kind);
    doc.getElementById(kind === 'countdowns' ? 'countdownFormTitle' : 'todoFullFormTitle').textContent = title;
    doc.getElementById(kind === 'countdowns' ? 'countdownFormError' : 'todoFullFormError')?.replaceChildren();
    syncLayout();
  }
  function discard() {
    closeDatePickers(); closeSelectControls();
    mode = null; baseline = ''; syncLayout();
  }
  async function allowDiscard() {
    if (saving) return false;
    if (!mode || baseline === snapshot(mode)) return true;
    if (!pending) pending = confirm({ title: '放弃未保存的修改？', message: '当前修改尚未保存。', confirmText: '放弃修改', cancelText: '继续编辑' }).finally(() => { pending = null; });
    return pending;
  }
  async function close() {
    if (!(await allowDiscard())) return;
    discard(); onClose();
    const source = origin?.dataset?.id ? doc.querySelector(`.todo-item[data-id="${origin.dataset.id}"]`) : origin?.dataset?.countdownSelect ? doc.querySelector(`[data-countdown-select="${origin.dataset.countdownSelect}"]`) : origin?.dataset?.countdownId ? doc.querySelector(`[data-countdown-id="${origin.dataset.countdownId}"]`) : null;
    const hiddenMobileDirectory = origin?.dataset?.countdownSelect && doc.defaultView.matchMedia?.('(max-width: 840px)').matches && !doc.body.classList.contains('sidebar-visible');
    (hiddenMobileDirectory ? doc.getElementById('btnTodoNew') : origin?.isConnected ? origin : source || doc.getElementById('btnTodoNew'))?.focus();
  }
  function setSaving(value) {
    saving = value;
    const panel = form();
    if (panel) {
      panel.setAttribute('aria-busy', String(value));
      panel.querySelectorAll('button, input, textarea, select').forEach(field => { field.disabled = value; });
    }
  }
  function renameCategory(previousName, nextName) {
    const field = doc.getElementById('todoFullCategory');
    if (field?.value === previousName) field.value = nextName;
    if (mode !== 'todos' || !baseline) return;
    const index = fields.todos.indexOf('todoFullCategory');
    const values = JSON.parse(baseline);
    if (values[index] === previousName) {
      values[index] = nextName;
      baseline = JSON.stringify(values);
    }
  }
  doc.getElementById('todoView')?.addEventListener('keydown', event => {
    if (!mode) return;
    if (event.key === 'Escape') {
      const menu = form()?.querySelector('.todo-select-control.open');
      event.preventDefault(); event.stopPropagation();
      if (menu) { closeSelectControls(); menu.querySelector('button')?.focus(); }
      else close();
    } else if (event.key === 'Tab' && overlay()) {
      const controls = [...form().querySelectorAll('button, input, textarea, select, [tabindex]')].filter(el => !el.disabled && el.tabIndex >= 0 && el.getClientRects().length);
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && doc.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && doc.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  });
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(syncLayout).observe(doc.getElementById('todoView'));
  return { open, discard, allowDiscard, close, syncLayout, setSaving, renameCategory, get saving() { return saving; }, get activeMode() { return mode; } };
}
