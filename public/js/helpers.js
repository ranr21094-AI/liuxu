import { formatDateLabel as formatBusinessDateLabel } from './businessDate.js';

export const $ = (sel) => document.querySelector(sel);
export function $$(sel) { return document.querySelectorAll(sel); }

export function announce(message) {
  const region = document.getElementById('a11yStatus');
  if (!region) return;
  region.textContent = '';
  requestAnimationFrame(() => {
    region.textContent = message;
  });
}

export function showToast(message, type = 'info') {
  let container = document.getElementById('toastContainer');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toastContainer';
    container.setAttribute('aria-live', 'polite');
    container.setAttribute('aria-atomic', 'false');
    document.body.appendChild(container);
  }
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
  toast.textContent = message;
  container.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('show'));
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

export function formatDate(dateStr) {
  return formatBusinessDateLabel(dateStr);
}

export function escHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function highlightSearch(text, query) {
  const safe = escHtml(text || '');
  const needle = String(query || '').trim();
  if (!needle) return safe;
  const escapedNeedle = escHtml(needle).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!escapedNeedle) return safe;
  return safe.replace(new RegExp(`(${escapedNeedle})`, 'gi'), '<mark>$1</mark>');
}

export function cssNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

/** Only allow http(s) URLs for href attributes, neutralizing javascript:/data:/vbscript: schemes. */
export function safeExternalHref(value) {
  return (typeof value === 'string' && /^https?:\/\//i.test(value)) ? value : '#';
}

export function debounce(fn, ms) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}

const modalTriggers = new WeakMap();
const modalKeyHandlers = new WeakMap();

function modalFocusableElements(overlay) {
  return [...overlay.querySelectorAll(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )].filter(element => !element.hidden && element.style.display !== 'none');
}

export function openModal(overlay, initialFocus) {
  if (!overlay) return;
  const active = document.activeElement;
  if (active && active !== document.body && !overlay.contains(active)) {
    modalTriggers.set(overlay, active);
  }
  overlay.style.display = 'flex';

  const priorHandler = modalKeyHandlers.get(overlay);
  if (priorHandler) overlay.removeEventListener('keydown', priorHandler);
  const keyHandler = (event) => {
    if (event.key !== 'Tab') return;
    const focusable = modalFocusableElements(overlay);
    if (!focusable.length) {
      event.preventDefault();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  overlay.addEventListener('keydown', keyHandler);
  modalKeyHandlers.set(overlay, keyHandler);

  const target = typeof initialFocus === 'string'
    ? overlay.querySelector(initialFocus)
    : initialFocus;
  requestAnimationFrame(() => {
    const focusTarget = target || modalFocusableElements(overlay)[0] || overlay;
    if (!focusTarget.hasAttribute('tabindex') && focusTarget === overlay) {
      focusTarget.setAttribute('tabindex', '-1');
    }
    focusTarget.focus();
  });
}

export function closeModal(overlay) {
  if (!overlay) return;
  overlay.style.display = 'none';
  const keyHandler = modalKeyHandlers.get(overlay);
  if (keyHandler) {
    overlay.removeEventListener('keydown', keyHandler);
    modalKeyHandlers.delete(overlay);
  }
  const trigger = modalTriggers.get(overlay);
  if (trigger && trigger.isConnected) trigger.focus();
  modalTriggers.delete(overlay);
}

export function confirmDialog({
  title = '确认操作',
  message = '',
  confirmText = '确认',
  cancelText = '取消',
  danger = true,
} = {}) {
  const workspaceDialog = document.getElementById('confirmDialog');
  if (workspaceDialog && typeof workspaceDialog.showModal === 'function') {
    return confirmWorkspaceDialog(workspaceDialog, {
      title,
      message,
      confirmText,
      cancelText,
      danger,
    });
  }

  let overlay = document.getElementById('genericConfirmOverlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'genericConfirmOverlay';
    overlay.className = 'modal-overlay';
    overlay.style.display = 'none';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'genericConfirmTitle');
    overlay.innerHTML = `
      <div class="modal modal-sm">
        <div class="modal-header"><h2 id="genericConfirmTitle"></h2></div>
        <div class="modal-body"><p id="genericConfirmMessage"></p></div>
        <div class="modal-footer">
          <button class="btn-secondary" id="genericConfirmCancel"></button>
          <button class="btn-danger" id="genericConfirmOk"></button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
  }

  const titleEl = document.getElementById('genericConfirmTitle');
  const messageEl = document.getElementById('genericConfirmMessage');
  const cancelBtn = document.getElementById('genericConfirmCancel');
  const okBtn = document.getElementById('genericConfirmOk');

  titleEl.textContent = title;
  messageEl.textContent = message;
  cancelBtn.textContent = cancelText;
  okBtn.textContent = confirmText;
  okBtn.className = danger ? 'btn-danger' : 'btn-primary';
  openModal(overlay, okBtn);

  return new Promise(resolve => {
    const cleanup = (value) => {
      closeModal(overlay);
      overlay.removeEventListener('click', onOverlayClick);
      document.removeEventListener('keydown', onKeydown);
      cancelBtn.removeEventListener('click', onCancel);
      okBtn.removeEventListener('click', onOk);
      resolve(value);
    };
    const onOverlayClick = (e) => { if (e.target === overlay) cleanup(false); };
    const onKeydown = (e) => {
      if (e.key === 'Escape') cleanup(false);
    };
    const onCancel = () => cleanup(false);
    const onOk = () => cleanup(true);

    overlay.addEventListener('click', onOverlayClick);
    document.addEventListener('keydown', onKeydown);
    cancelBtn.addEventListener('click', onCancel);
    okBtn.addEventListener('click', onOk);
  });
}

function confirmWorkspaceDialog(dialog, { title, message, confirmText, cancelText, danger }) {
  const titleEl = document.getElementById('confirmTitle');
  const messageEl = document.getElementById('confirmMessage');
  const okBtn = document.getElementById('confirmAccept');
  const cancelBtn = document.getElementById('confirmCancel') || dialog.querySelector('[value="cancel"]');
  if (titleEl) titleEl.textContent = title;
  if (messageEl) messageEl.textContent = message;
  if (okBtn) {
    okBtn.textContent = confirmText;
    okBtn.className = danger ? 'danger-action' : 'primary-action compact';
  }
  if (cancelBtn) cancelBtn.textContent = cancelText;
  if (dialog.open) dialog.close();
  dialog.returnValue = '';
  dialog.showModal();

  return new Promise(resolve => {
    const onBackdropClick = (event) => {
      if (event.target !== dialog) return;
      dialog.returnValue = 'cancel';
      dialog.close();
    };
    dialog.addEventListener('click', onBackdropClick);
    dialog.addEventListener('close', () => {
      dialog.removeEventListener('click', onBackdropClick);
      resolve(dialog.returnValue === 'confirm');
    }, { once: true });
  });
}

// Reusable Drag-and-Drop
export function setupDragAndDrop({ container, itemSelector, getId, onReorder }) {
  let dragId = null;

  container.addEventListener('dragstart', (e) => {
    const item = e.target.closest(itemSelector);
    if (!item) return;
    if (e.target.closest('input') || e.target.closest('button')) { e.preventDefault(); return; }
    dragId = getId(item);
    item.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(dragId));
  });

  container.addEventListener('dragend', (e) => {
    const item = e.target.closest(itemSelector);
    if (item) item.classList.remove('dragging');
    container.querySelectorAll(itemSelector + '.drag-over').forEach(c => c.classList.remove('drag-over'));
    dragId = null;
  });

  container.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const item = e.target.closest(itemSelector);
    if (!item || getId(item) === dragId) return;
    item.classList.add('drag-over');
  });

  container.addEventListener('dragleave', (e) => {
    const item = e.target.closest(itemSelector);
    if (item) item.classList.remove('drag-over');
  });

  container.addEventListener('drop', async (e) => {
    e.preventDefault();
    const target = e.target.closest(itemSelector);
    if (!target || getId(target) === dragId) return;
    target.classList.remove('drag-over');

    const items = [...container.querySelectorAll(itemSelector)];
    const src = items.find(c => getId(c) === dragId);
    if (!src) return;

    // Save original order for rollback
    const originalOrder = items.map(c => getId(c));

    const srcIdx = items.indexOf(src);
    const tgtIdx = items.indexOf(target);
    if (srcIdx < tgtIdx) target.after(src); else target.before(src);

    const newOrder = [...container.querySelectorAll(itemSelector)].map(c => getId(c));
    try {
      await onReorder(newOrder);
    } catch (err) {
      console.error('Reorder failed:', err);
      // Rollback: restore original DOM order
      const currentItems = [...container.querySelectorAll(itemSelector)];
      const parent = container;
      originalOrder.forEach(siblingId => {
        const el = currentItems.find(c => getId(c) === siblingId);
        if (el) parent.appendChild(el);
      });
    }
  });
}
