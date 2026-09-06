import { apiFetch } from '../auth.js';
import { escHtml, showToast, confirmDialog } from '../helpers.js';

// Per-document AI assistant floating window (kind: note_assist). The assistant
// shares the agent runtime with restricted tools; edit proposals arrive as
// note.edit_proposed events and are applied manually by the user in the editor.
const ACTIVE_RUN_STATES = new Set(['queued', 'running', 'waiting_approval', 'waiting_client_tool', 'waiting_user']);
const BOUNDS_KEY = 'liuxu.noteAssistant.bounds';
const MIN_WIDTH = 320;
const MIN_HEIGHT = 280;
const DEFAULT_WIDTH = 400;
const DEFAULT_HEIGHT = 560;

let state = null;
let bound = false;
let chromeGesture = null;

function panel() { return document.querySelector('#noteAssistantPanel'); }
function messagesHost() { return document.querySelector('#noteAssistantMessages'); }
function input() { return document.querySelector('#noteAssistantInput'); }

function viewportSize(viewport = {}) {
  const fallbackWidth = typeof window !== 'undefined' && window.innerWidth > 0 ? window.innerWidth : 1280;
  const fallbackHeight = typeof window !== 'undefined' && window.innerHeight > 0 ? window.innerHeight : 800;
  const width = Number(viewport.width);
  const height = Number(viewport.height);
  return {
    width: Number.isFinite(width) && width > 0 ? width : fallbackWidth,
    height: Number.isFinite(height) && height > 0 ? height : fallbackHeight,
  };
}

export function clampNoteAssistantBounds(bounds = {}, viewport) {
  const { width: vw, height: vh } = viewportSize(viewport);
  const minW = Math.min(MIN_WIDTH, vw);
  const minH = Math.min(MIN_HEIGHT, vh);
  const w = Math.min(Math.max(Number(bounds.w) || 0, minW), vw);
  const h = Math.min(Math.max(Number(bounds.h) || 0, minH), vh);
  const x = Math.min(Math.max(Number(bounds.x) || 0, 0), Math.max(0, vw - w));
  const y = Math.min(Math.max(Number(bounds.y) || 0, 0), Math.max(0, vh - h));
  return { x, y, w, h };
}

function defaultNoteAssistantBounds(viewport) {
  const { width: vw, height: vh } = viewportSize(viewport);
  const w = Math.min(DEFAULT_WIDTH, Math.max(0, vw - 24));
  const h = Math.min(DEFAULT_HEIGHT, Math.max(0, vh - 24));
  return clampNoteAssistantBounds({
    x: Math.max(0, vw - w - 16),
    y: Math.max(12, Math.round((vh - h) / 2)),
    w,
    h,
  }, viewport);
}

function readStoredBounds() {
  try {
    const raw = JSON.parse(localStorage.getItem(BOUNDS_KEY) || 'null');
    if (!raw || typeof raw !== 'object') return null;
    const x = Number(raw.x);
    const y = Number(raw.y);
    const w = Number(raw.w);
    const h = Number(raw.h);
    if (![x, y, w, h].every(Number.isFinite)) return null;
    return { x, y, w, h };
  } catch {
    return null;
  }
}

function persistBounds(bounds) {
  try {
    localStorage.setItem(BOUNDS_KEY, JSON.stringify(bounds));
  } catch {
    /* ignore quota / private mode */
  }
}

function applyBounds(bounds) {
  const host = panel();
  if (!host) return clampNoteAssistantBounds(bounds);
  const next = clampNoteAssistantBounds(bounds);
  host.style.position = 'fixed';
  host.style.zIndex = '40';
  host.style.left = `${next.x}px`;
  host.style.top = `${next.y}px`;
  host.style.width = `${next.w}px`;
  host.style.height = `${next.h}px`;
  host.style.right = 'auto';
  host.style.bottom = 'auto';
  return next;
}

function boundsFromPanel() {
  const host = panel();
  if (!host) return defaultNoteAssistantBounds();
  const rect = host.getBoundingClientRect();
  if (rect.width > 0 && rect.height > 0) {
    return clampNoteAssistantBounds({ x: rect.left, y: rect.top, w: rect.width, h: rect.height });
  }
  return clampNoteAssistantBounds(readStoredBounds() || defaultNoteAssistantBounds());
}

function restoreBounds() {
  persistBounds(applyBounds(readStoredBounds() || defaultNoteAssistantBounds()));
}

function autoResizeNoteComposer() {
  const field = input();
  if (!field) return;
  field.style.height = 'auto';
  field.style.height = `${Math.min(field.scrollHeight, 180)}px`;
}

function isOpen() {
  return Boolean(panel() && !panel().hidden);
}

function setOpen(open) {
  const host = panel();
  if (!host) return;
  host.hidden = !open;
  document.querySelector('#assistantToggleButton')?.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (open) {
    restoreBounds();
    input()?.focus();
    autoResizeNoteComposer();
    scrollMessagesToBottom();
  }
}

function endChromeGesture() {
  const host = panel();
  host?.classList.remove('is-dragging', 'is-resizing');
  if (!chromeGesture) return;
  chromeGesture = null;
  if (isOpen()) persistBounds(boundsFromPanel());
}

function onChromePointerMove(event) {
  if (!chromeGesture || event.pointerId !== chromeGesture.pointerId) return;
  const dx = event.clientX - chromeGesture.startX;
  const dy = event.clientY - chromeGesture.startY;
  if (chromeGesture.kind === 'move') {
    applyBounds({
      ...chromeGesture.start,
      x: chromeGesture.start.x + dx,
      y: chromeGesture.start.y + dy,
    });
    return;
  }
  applyBounds({
    ...chromeGesture.start,
    w: chromeGesture.start.w + dx,
    h: chromeGesture.start.h + dy,
  });
}

function startChromeGesture(event, kind) {
  const host = panel();
  if (!host) return;
  chromeGesture = {
    kind,
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    start: boundsFromPanel(),
  };
  host.classList.toggle('is-dragging', kind === 'move');
  host.classList.toggle('is-resizing', kind === 'resize');
  host.setPointerCapture?.(event.pointerId);
}

function bindWindowChrome(host) {
  host.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    if (event.target.closest('[data-note-assistant-resize]')) {
      event.preventDefault();
      startChromeGesture(event, 'resize');
      return;
    }
    if (!event.target.closest('[data-note-assistant-drag]')) return;
    if (event.target.closest('button, a, input, select, textarea')) return;
    event.preventDefault();
    startChromeGesture(event, 'move');
  });
  window.addEventListener('pointermove', onChromePointerMove);
  window.addEventListener('pointerup', endChromeGesture);
  window.addEventListener('pointercancel', endChromeGesture);
  window.addEventListener('resize', () => {
    if (!isOpen()) return;
    persistBounds(applyBounds(boundsFromPanel()));
  });
}

function scrollMessagesToBottom() {
  const host = messagesHost();
  if (host) host.scrollTop = host.scrollHeight;
}

function setStatus(text, tone = '') {
  const host = document.querySelector('#noteAssistantStatus');
  if (!host) return;
  host.textContent = text || '';
  host.dataset.tone = tone;
  host.hidden = !text;
  syncComposer();
}

function syncComposer() {
  const busy = Boolean(state?.runId);
  const send = document.querySelector('#noteAssistantSend');
  const stop = document.querySelector('#noteAssistantStop');
  if (send) send.hidden = busy;
  if (stop) stop.hidden = !busy;
  if (input()) input().disabled = busy;
}

function renderMessage(role, content) {
  const host = messagesHost();
  if (!host) return;
  const item = document.createElement('div');
  item.className = `note-assistant-message is-${role === 'user' ? 'user' : 'assistant'}`;
  item.innerHTML = `<div class="note-assistant-bubble"></div>`;
  item.querySelector('.note-assistant-bubble').textContent = content;
  host.appendChild(item);
  scrollMessagesToBottom();
}

function renderStatusLine(text) {
  const host = messagesHost();
  if (!host) return;
  let line = host.querySelector('.note-assistant-runline');
  if (!text) {
    line?.remove();
    return;
  }
  if (!line) {
    line = document.createElement('div');
    line.className = 'note-assistant-runline';
    host.appendChild(line);
  }
  line.textContent = text;
  scrollMessagesToBottom();
}

function truncateMiddle(value, max = 400) {
  const text = String(value || '');
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.6);
  return `${text.slice(0, head)}\n…\n${text.slice(text.length - (max - head - 3))}`;
}

function renderProposal(payload) {
  const host = messagesHost();
  if (!host || !payload?.id) return;
  const card = document.createElement('div');
  card.className = 'note-assistant-proposal';
  card.dataset.proposalId = payload.id;
  const summary = payload.append
    ? `在文末追加 ${String(payload.content || '').length} 字`
    : `替换 ${String(payload.find || '').length} 字 → ${String(payload.replace ?? '').length} 字`;
  card.innerHTML = `
    <div class="note-assistant-proposal-head">
      <strong>修改提案</strong><span>${escHtml(summary)}</span>
    </div>
    <pre class="note-assistant-proposal-body"></pre>
    <div class="note-assistant-proposal-actions">
      <button type="button" class="primary-action compact" data-note-assistant-action="apply">应用到笔记</button>
      <button type="button" class="secondary-action compact" data-note-assistant-action="ignore">忽略</button>
    </div>`;
  const body = card.querySelector('.note-assistant-proposal-body');
  body.textContent = payload.append
    ? truncateMiddle(payload.content)
    : `— 原文 —\n${truncateMiddle(payload.find)}\n— 改为 —\n${truncateMiddle(payload.replace ?? '')}`;
  host.appendChild(card);
  scrollMessagesToBottom();
}

function markProposal(proposalId, applied, note = '') {
  const card = messagesHost()?.querySelector(`.note-assistant-proposal[data-proposal-id="${CSS.escape(proposalId)}"]`);
  if (card) {
    card.classList.add(applied ? 'is-applied' : 'is-ignored');
    card.querySelectorAll('button').forEach(button => { button.disabled = true; });
    const head = card.querySelector('.note-assistant-proposal-head span');
    if (head) head.textContent = note || head.textContent;
  }
  state.proposalState.set(proposalId, applied ? 'applied' : 'ignored');
  updateBatchBar();
}

function pendingProposals() {
  const pending = [];
  for (const [id, status] of state.proposalState) {
    if (status === 'pending' && state.proposals.has(id)) pending.push(state.proposals.get(id));
  }
  return pending;
}

function updateBatchBar() {
  const bar = document.querySelector('#noteAssistantBatch');
  if (!bar) return;
  const pending = pendingProposals();
  const count = document.querySelector('#noteAssistantBatchCount');
  if (count) count.textContent = String(pending.length);
  bar.hidden = pending.length < 2;
}

async function applyProposal(payload, { silent = false } = {}) {
  const editor = document.querySelector('#documentContent');
  if (!editor) return { ok: false };
  if (payload.append) {
    state.applyEdit({
      append: true,
      content: String(payload.content || ''),
    });
    markProposal(payload.id, true, '已追加到文末');
    return { ok: true };
  }
  const current = editor.value;
  const find = String(payload.find || '');
  const occurrences = find ? current.split(find).length - 1 : 0;
  if (occurrences === 0) {
    markProposal(payload.id, false, '笔记已修改，无法定位原文');
    if (!silent) showToast('笔记内容已变化，无法定位提案原文；可从提案卡复制内容手动处理', 'error');
    return { ok: false };
  }
  if (occurrences > 1) {
    markProposal(payload.id, false, '原文出现多次，已跳过');
    if (!silent) showToast('提案原文在笔记中出现多次，为避免误改已跳过', 'error');
    return { ok: false };
  }
  state.applyEdit({ find, replace: String(payload.replace ?? '') });
  markProposal(payload.id, true, '已应用');
  return { ok: true };
}

async function applyAllProposals() {
  const pending = pendingProposals();
  if (!pending.length) return;
  let applied = 0;
  let failed = 0;
  for (const payload of pending) {
    const result = await applyProposal(payload, { silent: true });
    if (result?.ok) applied += 1;
    else failed += 1;
  }
  if (failed) showToast(`已应用 ${applied} 条，${failed} 条未能应用`, applied ? 'info' : 'error');
  else showToast(`已应用 ${applied} 条提案`, 'success');
}

function ignoreAllProposals() {
  const pending = pendingProposals();
  for (const payload of pending) markProposal(payload.id, false, '已忽略');
}

async function loadSession(documentId) {
  setStatus('');
  try {
    const response = await apiFetch(`/api/agent/note-assist/${encodeURIComponent(documentId)}/session`);
    if (!response.ok) {
      state.sessionId = '';
      return;
    }
    const data = await response.json().catch(() => ({}));
    state.sessionId = data.session?.id || '';
    messagesHost().innerHTML = '';
    for (const message of data.session?.messages || []) {
      if (message.role === 'user' || message.role === 'assistant') {
        renderMessage(message.role, String(message.content || ''));
      }
    }
    if (!state.sessionId) renderStatusLine('还没有对话，向留序 LiuXu 提问或让它修改本篇内容。');
    if (data.activeRun && ACTIVE_RUN_STATES.has(data.activeRun.status)) {
      // A run is still in flight server-side; resubscribe to its events.
      state.runId = data.activeRun.id;
      subscribeRun(data.activeRun.id);
    }
  } catch {
    state.sessionId = '';
  }
}

function handleRunEvent(event) {
  const type = event?.type || '';
  if (type === 'tool.started') {
    const name = event.payload?.call?.name || '';
    if (name === 'note.read') renderStatusLine('正在读取笔记内容…');
    else if (name === 'knowledge.search') renderStatusLine('正在检索知识库…');
    else if (name === 'note.propose_edit') renderStatusLine('正在生成修改提案…');
    return;
  }
  if (type === 'note.edit_proposed') {
    renderStatusLine('');
    if (event.payload?.id) {
      state.proposals.set(event.payload.id, event.payload);
      state.proposalState.set(event.payload.id, 'pending');
    }
    renderProposal(event.payload);
    updateBatchBar();
    return;
  }
  if (type === 'run.completed') {
    finishRun();
    renderStatusLine('');
    renderMessage('assistant', String(event.payload?.text || '（无回复）'));
    return;
  }
  if (type === 'run.failed') {
    finishRun();
    renderStatusLine('');
    const error = String(event.payload?.error || '');
    if (error && error !== 'cancelled') renderMessage('assistant', `出错了：${error}`);
    else if (error === 'cancelled') renderMessage('assistant', '（已停止）');
    return;
  }
  if (type === 'user_input.required') {
    finishRun();
    renderStatusLine('');
    renderMessage('assistant', String(event.payload?.question || '（需要补充信息）'));
  }
}

function finishRun() {
  state.eventSource?.close();
  state.eventSource = null;
  state.runId = '';
  setStatus('');
}

function subscribeRun(runId) {
  state.eventSource?.close();
  setStatus('正在思考…', 'running');
  syncComposer();
  const source = new EventSource(`/api/agent/runs/${encodeURIComponent(runId)}/events`);
  state.eventSource = source;
  source.addEventListener('run.started', () => setStatus('正在思考…', 'running'));
  for (const type of ['tool.started', 'note.edit_proposed', 'run.completed', 'run.failed', 'user_input.required']) {
    source.addEventListener(type, event => {
      let payload = null;
      try { payload = JSON.parse(event.data || '{}'); } catch { payload = null; }
      handleRunEvent({ type, payload: payload?.payload ?? payload });
    });
  }
  source.onerror = () => {
    // Terminal runs end the stream server-side; only treat premature errors
    // as failures when the run is still considered active.
    if (!state.runId) {
      source.close();
      return;
    }
    source.close();
    state.eventSource = null;
    state.runId = '';
    setStatus('连接中断，请重试', 'error');
    syncComposer();
  };
}

async function send() {
  const text = String(input()?.value || '').trim();
  if (!text || state.runId || !state.activeDocumentId) return;
  input().value = '';
  autoResizeNoteComposer();
  renderMessage('user', text);
  try {
    const response = await apiFetch(`/api/agent/note-assist/${encodeURIComponent(state.activeDocumentId)}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: text,
        sessionId: state.sessionId || undefined,
        newSession: state.newSessionRequested === true,
      }),
    });
    state.newSessionRequested = false;
    const data = await response.json().catch(() => ({}));
    if (response.status === 403) {
      renderMessage('assistant', '日记已锁定，无法使用留序 LiuXu。');
      return;
    }
    if (!response.ok) throw new Error(data.error || '发送失败');
    state.sessionId = data.sessionId || state.sessionId;
    state.runId = data.runId;
    subscribeRun(data.runId);
  } catch (error) {
    showToast(error.message || '留序 LiuXu 发送失败', 'error');
  }
}

async function stop() {
  if (!state.runId) return;
  try {
    await apiFetch(`/api/agent/runs/${encodeURIComponent(state.runId)}/cancel`, { method: 'POST' });
  } catch { /* the SSE run.failed event resolves the UI */ }
}

async function loadSessionList() {
  if (!state.activeDocumentId) return;
  try {
    const response = await apiFetch(`/api/agent/note-assist/${encodeURIComponent(state.activeDocumentId)}/sessions`);
    const data = await response.json().catch(() => ({}));
    state.sessions = response.ok ? (data.sessions || []) : [];
  } catch {
    state.sessions = [];
  }
  renderSessionList();
}

function renderSessionList() {
  const host = document.querySelector('#noteAssistantSessionList');
  if (!host) return;
  host.hidden = !state.sessionListOpen;
  if (!state.sessionListOpen) return;
  const sessions = state.sessions || [];
  if (!sessions.length) {
    host.innerHTML = '<p class="note-assistant-sessions-empty">还没有历史会话。</p>';
    return;
  }
  host.innerHTML = sessions.map(session => {
    const active = session.id === state.sessionId;
    const title = escHtml(session.title || '留序 LiuXu');
    const preview = escHtml(session.preview || `${session.messageCount} 条消息`);
    return `<div class="note-assistant-session-row${active ? ' is-active' : ''}" data-note-assistant-action="switch-session" data-session-id="${escHtml(session.id)}" role="button" tabindex="0">
      <div class="note-assistant-session-copy">
        <strong>${title}</strong>
        <small>${preview}</small>
        <small>${session.messageCount} 条消息 · ${escHtml(new Date(session.updatedAt).toLocaleString())}</small>
      </div>
      <button type="button" class="icon-button note-assistant-session-delete" data-note-assistant-action="delete-session" data-session-id="${escHtml(session.id)}" aria-label="删除该会话" title="删除该会话">✕</button>
    </div>`;
  }).join('');
}

function toggleSessionList() {
  state.sessionListOpen = !state.sessionListOpen;
  if (state.sessionListOpen) loadSessionList();
  else renderSessionList();
}

async function switchSession(sessionId) {
  if (!sessionId || sessionId === state.sessionId) {
    state.sessionListOpen = false;
    renderSessionList();
    return;
  }
  // Detach the current stream first — an in-flight run keeps going server-side.
  state.eventSource?.close();
  state.eventSource = null;
  state.runId = '';
  state.proposals = new Map();
  state.proposalState = new Map();
  state.sessionId = sessionId;
  try {
    const response = await apiFetch(`/api/agent/note-assist/${encodeURIComponent(state.activeDocumentId)}/session?sessionId=${encodeURIComponent(sessionId)}`);
    if (!response.ok) throw new Error('会话不存在');
    const data = await response.json().catch(() => ({}));
    messagesHost().innerHTML = '';
    for (const message of data.session?.messages || []) {
      if (message.role === 'user' || message.role === 'assistant') {
        renderMessage(message.role, String(message.content || ''));
      }
    }
    if (data.activeRun && ACTIVE_RUN_STATES.has(data.activeRun.status)) {
      state.runId = data.activeRun.id;
      subscribeRun(data.activeRun.id);
    } else {
      syncComposer();
    }
  } catch (error) {
    showToast(error.message || '会话加载失败', 'error');
  }
  state.sessionListOpen = false;
  renderSessionList();
  updateBatchBar();
}

async function deleteSession(sessionId) {
  const confirmed = await confirmDialog({
    title: '删除会话',
    message: '删除该留序 LiuXu 会话及其全部运行记录？此操作不可撤销。',
    confirmText: '删除',
    danger: true,
  });
  if (!confirmed) return;
  try {
    const response = await apiFetch(`/api/agent/note-assist/${encodeURIComponent(state.activeDocumentId)}/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || '删除失败');
    }
    if (sessionId === state.sessionId) {
      // Removed the conversation currently on screen: fall back to an empty
      // new-conversation state.
      state.eventSource?.close();
      state.eventSource = null;
      state.runId = '';
      state.sessionId = '';
      state.proposals = new Map();
      state.proposalState = new Map();
      messagesHost().innerHTML = '';
      renderStatusLine('新对话已就绪。');
      syncComposer();
    }
    await loadSessionList();
    showToast('会话已删除', 'success');
  } catch (error) {
    showToast(error.message || '删除失败', 'error');
  }
}

async function toggle() {
  if (isOpen()) {
    setOpen(false);
    return;
  }
  setOpen(true);
  if (state.activeDocumentId && !state.sessionLoaded) {
    state.sessionLoaded = true;
    await loadSession(state.activeDocumentId);
  }
}

function newConversation() {
  state.sessionId = '';
  state.newSessionRequested = true;
  state.eventSource?.close();
  state.eventSource = null;
  state.runId = '';
  state.proposals = new Map();
  state.proposalState = new Map();
  messagesHost().innerHTML = '';
  renderStatusLine('新对话已就绪。');
  updateBatchBar();
  syncComposer();
  if (state.sessionListOpen) loadSessionList();
}

export function initNoteAssistant({ applyEdit }) {
  if (bound) return;
  const host = panel();
  if (!host) return;
  bound = true;
  state = {
    activeDocumentId: '',
    sessionLoaded: false,
    sessionId: '',
    runId: '',
    eventSource: null,
    proposals: new Map(),
    proposalState: new Map(),
    sessionListOpen: false,
    newSessionRequested: false,
    applyEdit: typeof applyEdit === 'function' ? applyEdit : () => {},
  };

  host.addEventListener('click', event => {
    const action = event.target.closest('[data-note-assistant-action]');
    if (!action) {
      // Clicks outside the session dropdown close it.
      if (state.sessionListOpen && !event.target.closest('#noteAssistantSessionList') && !event.target.closest('[data-note-assistant-action="sessions"]')) {
        state.sessionListOpen = false;
        renderSessionList();
      }
      return;
    }
    const kind = action.dataset.noteAssistantAction;
    if (kind === 'close') setOpen(false);
    if (kind === 'new') newConversation();
    if (kind === 'send') send();
    if (kind === 'stop') stop();
    if (kind === 'sessions') toggleSessionList();
    if (kind === 'apply-all') applyAllProposals();
    if (kind === 'ignore-all') ignoreAllProposals();
    if (kind === 'switch-session' || kind === 'delete-session') {
      const sessionId = action.dataset.sessionId
        || action.closest('[data-session-id]')?.dataset.sessionId
        || '';
      if (kind === 'delete-session') deleteSession(sessionId);
      else switchSession(sessionId);
      return;
    }
    if (kind === 'apply' || kind === 'ignore') {
      const card = action.closest('.note-assistant-proposal');
      const proposalId = card?.dataset.proposalId || '';
      const payload = state.proposals?.get(proposalId);
      if (!payload) return;
      if (kind === 'apply') applyProposal(payload);
      else markProposal(proposalId, false, '已忽略');
    }
  });
  host.addEventListener('input', event => {
    if (event.target === input()) autoResizeNoteComposer();
  });
  host.addEventListener('keydown', event => {
    if (event.target === input() && event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      send();
    }
  });
  bindWindowChrome(host);
  document.querySelector('#assistantToggleButton')?.addEventListener('click', toggle);
}

export function noteAssistantSetActiveDocument(doc) {
  if (!state) return;
  // Switching documents detaches the current stream; an in-flight run keeps
  // going server-side and its proposals stay bound to that document.
  state.eventSource?.close();
  state.eventSource = null;
  state.runId = '';
  state.sessionId = '';
  state.sessionLoaded = false;
  state.proposals = new Map();
  state.proposalState = new Map();
  state.sessionListOpen = false;
  state.activeDocumentId = doc?.id || '';
  messagesHost().innerHTML = '';
  setOpen(false);
  const toggleButton = document.querySelector('#assistantToggleButton');
  if (!toggleButton) return;
  if (doc?.id && doc?.status !== 'archived') toggleButton.removeAttribute('hidden');
  else toggleButton.setAttribute('hidden', '');
  syncComposer();
}

export function noteAssistantClear() {
  if (!state) return;
  state.eventSource?.close();
  state.eventSource = null;
  state.runId = '';
  state.activeDocumentId = '';
  state.sessionId = '';
  state.sessionLoaded = false;
  state.proposals = new Map();
  state.proposalState = new Map();
  state.sessionListOpen = false;
  messagesHost().innerHTML = '';
  setOpen(false);
  document.querySelector('#assistantToggleButton')?.setAttribute('hidden', '');
  updateBatchBar();
}
