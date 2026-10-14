import { apiFetch } from '../auth.js';
const KEY = 'liuxu.readingTime.pending.v1';
const read = () => { try { const value = JSON.parse(localStorage.getItem(KEY) || '{}'); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; } catch { return {}; } };
const write = value => { try { localStorage.setItem(KEY, JSON.stringify(value)); return true; } catch { return false; } };
export function startReadingClock(doc, host, signal, eligible) {
  const sessionId = crypto.randomUUID();
  const volatilePending = new Map();
  let elapsed = 0, sequence = 0, total = 0, acknowledged = 0, last = performance.now(), activity = last, stopped = false, sending = false, saveState = '已保存';
  const display = document.createElement('span'); display.className = 'reader-time'; display.setAttribute('aria-label', '本次阅读和累计阅读时间');
  const value = document.createElement('span'); const state = document.createElement('small'); state.className = 'reader-time-state';
  display.append(value, state);
  (host.querySelector('.reader-footer') || host.querySelector('.file-preview-toolbar') || host).append(display);
  const format = ms => {
    const seconds = Math.floor(ms / 1000);
    if (seconds >= 3600) return `${Math.floor(seconds / 3600)}小时${Math.floor(seconds / 60) % 60}分`;
    if (seconds >= 60) return `${Math.floor(seconds / 60)}分${seconds % 60}秒`;
    return `${seconds}秒`;
  };
  const render = () => {
    value.textContent = `本次 ${format(elapsed)} · 累计 ${format(total + Math.max(0, elapsed - acknowledged))}`;
    state.textContent = saveState;
  };
  const active = () => !stopped && document.visibilityState === 'visible' && document.hasFocus() && eligible()
    && !document.querySelector('dialog[open]') && performance.now() - activity < 300000
    && !host.querySelector('foliate-view[hidden]') && !host.querySelector('.file-preview-text:not([hidden])');
  let wasActive = active();
  const tick = () => {
    const now = performance.now(), next = active();
    if (wasActive) elapsed += Math.max(0, Math.min(2000, now - last, activity + 300000 - last));
    last = now; wasActive = next; render();
  };
  const remember = () => {
    tick(); if (!elapsed) return;
    const pending = read();
    const item = { documentId: doc.id, sessionId, sequence: ++sequence, milliseconds: Math.floor(elapsed) };
    volatilePending.set(sessionId, item);
    pending[sessionId] = item;
    saveState = write(pending) ? '待保存' : '暂存失败'; render();
  };
  const submit = async () => {
    if (sending) return; sending = true;
    try {
      const pending = { ...read(), ...Object.fromEntries(volatilePending) };
      for (const [key, item] of Object.entries(pending)) {
        const response = await apiFetch(`/api/knowledge/documents/${encodeURIComponent(item.documentId)}/reading-time`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(item), keepalive: true });
        if (!response.ok) { if (item.documentId === doc.id) saveState = '保存失败，将重试'; continue; }
        const value = await response.json();
        const savedPending = read(); if (savedPending[key]?.sequence === item.sequence) { delete savedPending[key]; write(savedPending); }
        if (volatilePending.get(key)?.sequence === item.sequence) volatilePending.delete(key);
        if (item.documentId === doc.id) { total = value.milliseconds; if (key === sessionId) acknowledged = item.milliseconds; saveState = '已保存'; render(); }
      }
    } catch { saveState = '暂存本机，稍后重试'; display.title = saveState; render(); }
    finally { sending = false; render(); }
  };
  const interact = () => { tick(); activity = performance.now(); wasActive = active(); };
  const pause = () => { remember(); wasActive = active(); void submit(); };
  const options = { signal, passive: true };
  for (const event of ['pointerdown', 'keydown', 'wheel', 'touchstart']) window.addEventListener(event, interact, options);
  window.addEventListener('blur', pause, { signal }); window.addEventListener('focus', interact, { signal });
  document.addEventListener('visibilitychange', pause, { signal }); window.addEventListener('pagehide', pause, { signal });
  const watched = new WeakSet();
  const timer = setInterval(() => {
    tick(); remember();
    for (const frame of host.querySelectorAll('iframe')) {
      const inner = frame.contentDocument; if (!inner || watched.has(inner)) continue;
      watched.add(inner); for (const event of ['pointerdown', 'keydown', 'wheel', 'touchstart']) inner.addEventListener(event, interact, options);
    }
  }, 1000);
  const sync = setInterval(() => { remember(); void submit(); }, 30000);
  signal.addEventListener('abort', () => { remember(); stopped = true; wasActive = false; clearInterval(timer); clearInterval(sync); void submit(); display.remove(); }, { once: true });
  void (async () => {
    try { const response = await apiFetch(`/api/knowledge/documents/${encodeURIComponent(doc.id)}/reading-time`); if (response.ok) total = (await response.json()).milliseconds; }
    catch { saveState = '离线'; }
    render(); await submit();
  })();
  render();
}
