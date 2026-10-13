import { apiFetch } from '../auth.js';
export const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
export function button(parent, text, action) {
  const element = document.createElement('button'); element.type = 'button'; element.textContent = text;
  element.addEventListener('click', action); parent.append(element); return element;
}
export function visibleSelectionRect(selection, viewport = globalThis.window, clipElement = null) {
  const range = selection?.range;
  if (!range?.getClientRects) return null;
  let rects = [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0)
    .map(rect => ({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }));
  let win = range.startContainer?.ownerDocument?.defaultView;
  while (win && win !== viewport) {
    const frame = win.frameElement;
    if (!frame) return null;
    const box = frame.getBoundingClientRect();
    const sx = box.width / (frame.clientWidth || box.width || 1);
    const sy = box.height / (frame.clientHeight || box.height || 1);
    rects = rects.map(rect => ({
      left: box.left + rect.left * sx, right: box.left + rect.right * sx,
      top: box.top + rect.top * sy, bottom: box.top + rect.bottom * sy,
    })).map(rect => ({
      left: Math.max(box.left, rect.left), right: Math.min(box.right, rect.right),
      top: Math.max(box.top, rect.top), bottom: Math.min(box.bottom, rect.bottom),
    })).filter(rect => rect.right > rect.left && rect.bottom > rect.top);
    win = frame.ownerDocument.defaultView;
  }
  if (win !== viewport) return null;
  const width = viewport?.innerWidth || document.documentElement.clientWidth;
  const height = viewport?.innerHeight || document.documentElement.clientHeight;
  const clip = clipElement?.getBoundingClientRect();
  return rects.map(rect => ({
    left: Math.max(12, clip?.left ?? 12, rect.left), right: Math.min(width - 12, clip?.right ?? width - 12, rect.right),
    top: Math.max(12, clip?.top ?? 12, rect.top), bottom: Math.min(height - 12, clip?.bottom ?? height - 12, rect.bottom),
  })).find(rect => rect.right > rect.left && rect.bottom > rect.top) || null;
}
export async function readingTools({ doc, host, toolbar, signal, current, selection, navigate, onChange = () => {} }) {
  const url = `/api/knowledge/documents/${encodeURIComponent(doc.id)}/reading-data`;
  const response = await apiFetch(url, { signal });
  if (!response.ok) { const error = await response.json().catch(() => ({})); throw new Error(error.error || '阅读笔记读取失败，请重新打开'); }
  let data = await response.json();
  signal.throwIfAborted();
  let busy = false, activeDialog = null, floatTimer = null, selectionSnapshot = null;
  const status = document.createElement('span'); status.className = 'book-status'; status.setAttribute('role', 'status'); toolbar.append(status);
  const report = message => { status.textContent = message; };
  const panel = document.createElement('section'); panel.className = 'book-notes'; panel.hidden = true; host.append(panel);
  let drawn = [];
  const redraw = () => {
    onChange(data.entries, drawn); drawn = [...data.entries];
    panel.replaceChildren();
    if (!data.entries.length) { const p = document.createElement('p'); p.textContent = '还没有书签或摘录。'; panel.append(p); }
    for (const item of data.entries) {
      const row = document.createElement('article'); row.dataset.readingEntry = item.id;
      row.innerHTML = `<strong>${esc(item.type === 'bookmark' ? '书签' : '摘录')} · ${esc(item.label)}</strong>${item.quote ? `<p class="book-note-quote">${esc(item.quote)}</p>` : ''}${item.note ? `<p>${esc(item.note)}</p>` : ''}`;
      button(row, item.fingerprint === data.fingerprint ? '返回原文' : '源文件已变化', () => jump(item)).dataset.readerJump = '';
      button(row, '编辑', event => edit(item, event.currentTarget));
      button(row, '删除', () => persist(data.entries.filter(x => x.id !== item.id)));
      panel.append(row);
    }
  };
  const jump = async item => {
    if (item.fingerprint !== data.fingerprint) return report('源文件已变化，旧定位已失效；摘录仍保留。');
    try { await navigate(item.anchor, item.quote); panel.hidden = true; host.querySelector('.file-preview-stage')?.focus({preventScroll:true}); }
    catch { report('无法定位原文，摘录仍保留。'); }
  };
  async function persist(entries) {
    if (busy || signal.aborted) return false;
    busy = true; bookmark.disabled = true; report('保存中…');
    try {
      // Do not abort a submitted write when navigating away: the server may have committed it.
      const res = await apiFetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...data, entries, baseRevision: data.revision }) });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || '保存失败');
      data = result.readingData;
      if (!signal.aborted) { redraw(); report('已保存'); }
      return true;
    } catch (error) { if (!signal.aborted) report(error.message); return false; }
    finally { busy = false; bookmark.disabled = false; }
  }
  function edit(item, source = null, isNew = false) {
    if (activeDialog) return;
    hideSelectionAction();
    const title = isNew ? '保存摘录' : item.type === 'bookmark' ? '编辑书签' : '编辑摘录';
    const dialog = document.createElement('dialog'); dialog.className = 'book-edit-dialog'; activeDialog = dialog;
    const titleId = `book-edit-title-${crypto.randomUUID()}`;
    dialog.setAttribute('aria-labelledby', titleId);
    dialog.innerHTML = `<form><header><h3 id="${titleId}">${title}</h3><button type="button" data-close aria-label="关闭编辑窗口" title="关闭">×</button></header><div class="book-edit-body">${item.quote ? `<blockquote>${esc(item.quote)}</blockquote>` : ''}<label>名称<input name="label" maxlength="300" value="${esc(item.label)}"></label><label>想法 <span>（可选）</span><textarea name="note" maxlength="10000">${esc(item.note)}</textarea></label><p class="book-edit-error" role="alert" hidden></p></div><footer><button type="button" data-cancel>取消</button><button type="submit" data-save>保存</button></footer></form>`;
    document.body.append(dialog);
    const abortDialog = () => { if (dialog.open) dialog.close(); else dialog.remove(); };
    const restore = () => {
      signal.removeEventListener('abort', abortDialog);
      activeDialog = null; dialog.remove();
      if (signal.aborted) return;
      if (isNew) { host.querySelector('.file-preview-stage')?.focus({ preventScroll: true }); return; }
      const replacement = [...panel.querySelectorAll('[data-reading-entry]')].find(row => row.dataset.readingEntry === item.id)?.querySelector('button:nth-last-child(2)');
      if ((source?.isConnected ? source : replacement)?.focus) (source?.isConnected ? source : replacement).focus({ preventScroll: true });
    };
    dialog.addEventListener('close', restore, { once: true });
    dialog.querySelector('[data-close]').onclick = dialog.querySelector('[data-cancel]').onclick = () => { if (!dialog.dataset.saving) dialog.close(); };
    dialog.addEventListener('cancel', event => { if (dialog.dataset.saving) event.preventDefault(); });
    dialog.querySelector('form').addEventListener('submit', async event => {
      event.preventDefault();
      if (dialog.dataset.saving) return;
      const saveButton = dialog.querySelector('[data-save]'), error = dialog.querySelector('.book-edit-error');
      const updated = { ...item, label: dialog.querySelector('[name=label]').value.trim(), note: dialog.querySelector('[name=note]').value };
      if (!updated.label) { error.textContent = '请输入名称'; error.hidden = false; return; }
      dialog.dataset.saving = 'true'; saveButton.disabled = true; saveButton.textContent = '保存中…'; error.hidden = true;
      const entries = data.entries.some(x => x.id === item.id) ? data.entries.map(x => x.id === item.id ? updated : x) : [...data.entries, updated];
      const ok = await persist(entries);
      if (ok) { report(isNew ? '摘录已保存' : '已保存'); dialog.close(); }
      else { error.textContent = status.textContent || '保存失败，请重试'; error.hidden = false; }
      delete dialog.dataset.saving; saveButton.disabled = false; saveButton.textContent = '保存';
    });
    dialog.showModal(); dialog.querySelector('[name=label]').focus();
    signal.addEventListener('abort', abortDialog, { once: true });
  }
  const bookmark = button(toolbar, '', async () => {
    if (busy) return;
    const location = current(); if (!location?.anchor) return report('当前位置尚未准备好，请稍后重试');
    if (data.entries.some(item => item.type === 'bookmark' && item.fingerprint === data.fingerprint && item.anchor === location.anchor)) return report('此位置已有书签');
    const entry = { id: crypto.randomUUID(), type: 'bookmark', anchor: location.anchor, label: location.label || '书签', fingerprint: data.fingerprint, quote: '', note: '' };
    if (await persist([...data.entries, entry])) report('书签已添加');
  });
  bookmark.className = 'reader-bookmark-action'; bookmark.dataset.readerBookmark = '';
  bookmark.setAttribute('aria-label', '添加当前位置书签'); bookmark.title = '添加当前位置书签';
  bookmark.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 4.5A1.5 1.5 0 0 1 7.5 3h9A1.5 1.5 0 0 1 18 4.5V21l-6-4-6 4z"/></svg>';
  let floatAction = null;
  if (selection) {
    floatAction = document.createElement('button'); floatAction.type = 'button'; floatAction.className = 'book-selection-action';
    floatAction.textContent = '划线摘录'; floatAction.setAttribute('aria-label', '划线摘录');
    floatAction.setAttribute('popover', 'manual'); floatAction.hidden = true; document.body.append(floatAction);
    floatAction.addEventListener('pointerdown', event => event.preventDefault());
    floatAction.addEventListener('click', () => {
      const value = selectionSnapshot;
      if (!value?.quote?.trim()) return;
      if (value.quote.length > 10000) { hideSelectionAction(); return report('一次摘录最多 10000 字'); }
      edit({ id: crypto.randomUUID(), type: 'highlight', anchor: value.anchor, quote: value.quote, label: value.label || '摘录', fingerprint: data.fingerprint, note: '' }, null, true);
    });
  }
  function hideSelectionAction() {
    clearTimeout(floatTimer); floatTimer = null; selectionSnapshot = null;
    if (floatAction?.matches(':popover-open')) floatAction.hidePopover();
    if (floatAction) floatAction.hidden = true;
  }
  function selectionChanged() {
    clearTimeout(floatTimer);
    const value = selection?.();
    if (!value?.quote?.trim() || !value.anchor) { hideSelectionAction(); return; }
    if (floatAction?.matches(':popover-open')) floatAction.hidePopover();
    if (floatAction) floatAction.hidden = true;
    selectionSnapshot = { anchor: value.anchor, quote: value.quote, label: value.label, range: value.range };
    floatTimer = setTimeout(() => {
      if (!floatAction || signal.aborted || activeDialog) return;
      const rect = visibleSelectionRect(selectionSnapshot, window, host.querySelector('.file-preview-stage'));
      if (!rect) return hideSelectionAction();
      floatAction.hidden = false;
      if (!floatAction.matches(':popover-open')) floatAction.showPopover();
      const width = floatAction.offsetWidth || 96, height = floatAction.offsetHeight || 36;
      const vw = window.innerWidth, vh = window.innerHeight;
      const left = Math.max(12, Math.min(vw - width - 12, (rect.left + rect.right - width) / 2));
      const top = rect.top >= height + 20 ? rect.top - height - 8 : Math.min(vh - height - 12, rect.bottom + 8);
      Object.assign(floatAction.style, { left: `${left}px`, top: `${top}px` });
    }, 180);
  }
  button(toolbar, '书签与摘录', () => { panel.hidden = !panel.hidden; hideSelectionAction(); });
  const focus = button(toolbar, '专注阅读', () => {
    hideSelectionAction(); host.classList.toggle('book-focus'); focus.textContent = host.classList.contains('book-focus') ? '退出专注' : '专注阅读';
  });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || event.defaultPrevented || activeDialog) return;
    if (floatAction?.matches(':popover-open')) { event.preventDefault(); event.stopImmediatePropagation(); hideSelectionAction(); return; }
  }, { capture: true, signal });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || event.defaultPrevented || document.querySelector('dialog[open]')) return;
    if (host.classList.contains('book-focus')) { event.preventDefault(); host.classList.remove('book-focus'); focus.textContent = '专注阅读'; focus.focus({ preventScroll: true }); }
  }, { signal });
  signal.addEventListener('abort', () => { hideSelectionAction(); floatAction?.remove(); host.classList.remove('book-focus'); panel.remove(); }, { once: true });
  redraw();
  return { report, get entries() { return data.entries; }, fingerprint: data.fingerprint,
    selectionChanged, hideSelectionAction,
    async restoreLink() {
      const id = new URLSearchParams(location.hash.split('?')[1] || '').get('reading');
      const item = data.entries.find(x => x.id === id); if (item) await jump(item);
    },
  };
}
