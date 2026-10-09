import { apiFetch } from '../auth.js';
export const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
export function button(parent, text, action) {
  const element = document.createElement('button'); element.type = 'button'; element.textContent = text;
  element.addEventListener('click', action); parent.append(element); return element;
}
export async function readingTools({ doc, host, toolbar, signal, current, selection, navigate, onChange = () => {} }) {
  const url = `/api/knowledge/documents/${encodeURIComponent(doc.id)}/reading-data`;
  const response = await apiFetch(url, { signal });
  if (!response.ok) { const error = await response.json().catch(() => ({})); throw new Error(error.error || '阅读笔记读取失败，请重新打开'); }
  let data = await response.json();
  signal.throwIfAborted();
  let busy = false;
  const status = document.createElement('span'); status.className = 'book-status'; status.setAttribute('role', 'status'); toolbar.append(status);
  const report = message => { status.textContent = message; };
  const panel = document.createElement('section'); panel.className = 'book-notes'; panel.hidden = true; host.append(panel);
  let drawn = [];
  const redraw = () => {
    onChange(data.entries, drawn); drawn = [...data.entries];
    panel.replaceChildren();
    button(panel, '关闭书签与摘录', () => { panel.hidden = true; });
    if (!data.entries.length) { const p = document.createElement('p'); p.textContent = '还没有书签或摘录。'; panel.append(p); }
    for (const item of data.entries) {
      const row = document.createElement('article'); row.innerHTML = `<strong>${esc(item.type === 'bookmark' ? '书签' : '摘录')} · ${esc(item.label)}</strong><p>${esc(item.quote)}</p><p>${esc(item.note)}</p>`;
      button(row, item.fingerprint === data.fingerprint ? '返回原文' : '源文件已变化', () => jump(item));
      button(row, '编辑', () => edit(item));
      button(row, '删除', () => persist(data.entries.filter(x => x.id !== item.id)));
      panel.append(row);
    }
  };
  const jump = async item => {
    if (item.fingerprint !== data.fingerprint) return report('源文件已变化，旧定位已失效；摘录仍保留。');
    try { await navigate(item.anchor, item.quote); panel.hidden = true; }
    catch { report('无法定位原文，摘录仍保留。'); }
  };
  async function persist(entries) {
    if (busy || signal.aborted) return false;
    busy = true; report('保存中…');
    try {
      // Do not abort a submitted write when navigating away: the server may have committed it.
      const res = await apiFetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...data, entries, baseRevision: data.revision }) });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || '保存失败');
      data = result.readingData;
      if (!signal.aborted) { redraw(); report('已保存'); }
      return true;
    } catch (error) { if (!signal.aborted) report(error.message); return false; }
    finally { busy = false; }
  }
  function edit(item) {
    const dialog = document.createElement('dialog'); dialog.className = 'book-edit-dialog';
    dialog.innerHTML = `<form method="dialog"><h3>${item.type === 'bookmark' ? '书签' : '摘录与想法'}</h3><blockquote>${esc(item.quote)}</blockquote><label>名称<input name="label" maxlength="300" value="${esc(item.label)}"></label><label>想法<textarea name="note" maxlength="10000">${esc(item.note)}</textarea></label><p role="status"></p><div><button value="cancel">取消</button><button type="button" data-save>保存</button></div></form>`;
    document.body.append(dialog); dialog.showModal();
    dialog.addEventListener('close', () => dialog.remove(), { once: true });
    signal.addEventListener('abort', () => { dialog.close(); dialog.remove(); }, { once: true });
    dialog.querySelector('[data-save]').onclick = async () => {
      const updated = { ...item, label: dialog.querySelector('[name=label]').value, note: dialog.querySelector('[name=note]').value };
      const entries = data.entries.some(x => x.id === item.id) ? data.entries.map(x => x.id === item.id ? updated : x) : [...data.entries, updated];
      if (await persist(entries)) dialog.close(); else dialog.querySelector('[role=status]').textContent = status.textContent;
    };
  }
  button(toolbar, '加书签', () => {
    const location = current(); if (!location?.anchor) return;
    edit({ id: crypto.randomUUID(), type: 'bookmark', ...location, fingerprint: data.fingerprint, quote: '', note: '' });
  });
  let highlight;
  if (selection) {
    highlight = button(toolbar, '划线摘录', () => {
      const value = selection();
      if (!value?.quote?.trim()) return report('请先在正文中选择文字');
      if (value.quote.length > 10000) return report('一次摘录最多 10000 字');
      edit({ id: crypto.randomUUID(), type: 'highlight', ...value, fingerprint: data.fingerprint, note: '' });
    });
    highlight.addEventListener('pointerdown', event => event.preventDefault());
    highlight.hidden = true;
  }
  button(toolbar, '书签与摘录', () => { panel.hidden = !panel.hidden; });
  const focus = button(toolbar, '专注阅读', () => {
    host.classList.toggle('book-focus'); focus.textContent = host.classList.contains('book-focus') ? '退出专注' : '专注阅读';
  });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') { host.classList.remove('book-focus'); focus.textContent = '专注阅读'; } }, { signal });
  signal.addEventListener('abort', () => { host.classList.remove('book-focus'); panel.remove(); }, { once: true });
  redraw();
  return { report, get entries() { return data.entries; }, fingerprint: data.fingerprint,
    selectionChanged() { if (highlight) highlight.hidden = !selection()?.quote?.trim(); },
    async restoreLink() {
      const id = new URLSearchParams(location.hash.split('?')[1] || '').get('reading');
      const item = data.entries.find(x => x.id === id); if (item) await jump(item);
    },
  };
}
