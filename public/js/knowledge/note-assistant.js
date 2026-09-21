import { apiFetch } from '../auth.js';
import { escHtml, showToast, confirmDialog } from '../helpers.js';
import { createAssistantLayout } from './assistant-layout.js';

// Per-document AI assistant floating window (kind: note_assist). The assistant
// shares the full agent runtime; optional edit proposals arrive as
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
let layout = null;
let contextSerial = 0;

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
  if (panel()?.dataset.layout && panel().dataset.layout !== 'floating') return;
  applyBounds(readStoredBounds() || defaultNoteAssistantBounds());
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
  layout?.sync();
  document.querySelector('#assistantToggleButton')?.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (open) {
    restoreBounds();
    input()?.focus();
    autoResizeNoteComposer();
    scrollMessagesToBottom();
  } else if (host.contains(document.activeElement)) {
    const target = document.querySelector('#assistantToggleButton:not([hidden])') || document.querySelector('#sidebarOpen');
    target?.focus();
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
    if (host.dataset.layout && host.dataset.layout !== 'floating') return;
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
    if (!isOpen() || (host.dataset.layout && host.dataset.layout !== 'floating')) return;
    applyBounds(readStoredBounds() || boundsFromPanel());
  });
}

function scrollMessagesToBottom() {
  const host = messagesHost();
  if (host) host.scrollTop = host.scrollHeight;
}

function messagesAreNearBottom() {
  const host = messagesHost();
  if (!host) return true;
  return host.scrollHeight - host.scrollTop - host.clientHeight < 56;
}

function followMessages(wasNearBottom, force = false) {
  if (force || wasNearBottom) scrollMessagesToBottom();
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
  const busy = Boolean(state?.sending || (state?.runId && state?.runStatus !== 'waiting_user'));
  const send = document.querySelector('#noteAssistantSend');
  const stop = document.querySelector('#noteAssistantStop');
  if (send) send.hidden = busy;
  if (stop) stop.hidden = !state?.runId;
  if (input()) { input().disabled = busy; input().placeholder = state?.runStatus === 'waiting_user' ? '输入回答，继续当前任务…' : '询问本篇内容，或让留序 LiuXu 修改…'; }
}

function renderMessage(role, content, { follow = true, forceFollow = false } = {}) {
  const host = messagesHost();
  if (!host) return;
  const wasNearBottom = follow && messagesAreNearBottom();
  const item = document.createElement('div');
  item.className = `note-assistant-message is-${role === 'user' ? 'user' : 'assistant'}`;
  item.innerHTML = `<div class="note-assistant-bubble"></div>`;
  if (role !== 'user' && state.renderMarkdown) item.querySelector('.note-assistant-bubble').innerHTML = state.renderMarkdown(content);
  else item.querySelector('.note-assistant-bubble').textContent = content;
  host.appendChild(item);
  followMessages(wasNearBottom, forceFollow);
}

function renderToolImages(result, options = {}) {
  const images = result?.data?.images || (result?.data?.imageUrl ? [{ url: result.data.imageUrl }] : []);
  for (const image of images) {
    if (typeof image.url === 'string' && /^\/uploads\/[a-zA-Z0-9_.%/-]+$/.test(image.url)) renderMessage('assistant', `![工具图片](${image.url})`, options);
  }
}

const TOOL_LABELS = {
  'note.read': '读取当前笔记',
  'note.propose_edit': '生成修改提案',
  'knowledge.search': '检索知识库',
  'knowledge.list': '列出知识文档',
  'knowledge.tree': '读取知识目录',
  'knowledge.read': '读取知识文档',
  'knowledge.update': '更新知识文档',
  'knowledge.archive': '归档知识文档',
  'knowledge.restore': '恢复知识文档',
  'knowledge.delete': '删除知识文档',
  'memory.list': '读取记忆列表',
  'memory.search': '检索记忆',
  'memory.read': '读取记忆',
  'memory.propose': '生成记忆提案',
  'web.search': '搜索网页',
  'web.fetch': '读取网页',
  'image.generate': '生成图片',
  'agent.delegate': '执行子任务',
  'ask_user': '请求补充信息',
  'update_working_checkpoint': '更新工作进度',
};

const TOOL_PREFIX_LABELS = [
  ['note_browser.', '操作笔记浏览器'],
  ['browser.', '操作浏览器'],
  ['task.', '处理待办'],
  ['countdown.', '处理倒数日'],
  ['file.', '处理文件'],
  ['code.', '运行代码'],
  ['bash.', '运行脚本'],
  ['computer.', '操作电脑'],
];

function toolLabel(name) {
  const exact = TOOL_LABELS[String(name || '')];
  if (exact) return exact;
  return TOOL_PREFIX_LABELS.find(([prefix]) => String(name || '').startsWith(prefix))?.[1] || '执行工具';
}

function toolState(result, fallback = 'success') {
  if (!result) return fallback;
  const summary = String(result.summary || result.error || '').toLowerCase();
  if (result.ok === false) {
    if (summary.includes('reject') || summary.includes('拒绝')) return 'rejected';
    if (summary.includes('cancel') || summary.includes('取消') || summary.includes('停止')) return 'cancelled';
    return 'failed';
  }
  return 'success';
}

function toolStateLabel(status) {
  return ({ running: '执行中', success: '已完成', failed: '失败', rejected: '已拒绝', cancelled: '已取消' })[status] || '已完成';
}

function toolResultSummary(name, result, status) {
  const raw = String(result?.summary || result?.error || '').trim();
  if (!raw) return status === 'running' ? '正在处理…' : '';
  let match = raw.match(/^Read current document\s+["“]?(.+?)["”]?$/i);
  if (match) return `已读取“${match[1]}”`;
  match = raw.match(/^Found\s+(\d+)\s+document\(s\)$/i);
  if (match) return `找到 ${match[1]} 篇文档`;
  match = raw.match(/^Listed\s+(\d+)\s+document\(s\)$/i);
  if (match) return `列出 ${match[1]} 篇文档`;
  match = raw.match(/^Read\s+(.+)$/i);
  if (match && name === 'knowledge.read') return `已读取“${match[1].replace(/^["“]|["”]$/g, '')}”`;
  return raw;
}

function callIdentity(call = {}, payload = {}) {
  const id = call.id || call.callId || call.call_id || payload.requestId || payload.id || '';
  const delegated = payload.delegatedRunId || '';
  return id ? `${delegated}:${id}` : '';
}

function createExecutionTrace({ runId = '', historical = false } = {}) {
  const host = messagesHost();
  if (!host) return null;
  const wasNearBottom = !historical && messagesAreNearBottom();
  const details = document.createElement('details');
  details.className = 'note-assistant-execution';
  if (runId) details.dataset.runId = runId;
  details.innerHTML = `
    <summary><span class="note-assistant-execution-dot" aria-hidden="true"></span><span class="note-assistant-execution-summary">执行过程</span><span class="note-assistant-execution-chevron" aria-hidden="true">⌄</span></summary>
    <div class="note-assistant-execution-steps"></div>`;
  host.appendChild(details);
  followMessages(wasNearBottom);
  return details;
}

function traceSteps(trace) {
  return [...(trace?.querySelectorAll(':scope > .note-assistant-execution-steps > .note-assistant-tool-step') || [])];
}

function updateExecutionSummary(trace, { terminal = false } = {}) {
  if (!trace) return;
  const steps = traceSteps(trace);
  const completed = steps.filter(step => step.dataset.status !== 'running').length;
  const running = steps.findLast?.(step => step.dataset.status === 'running')
    || [...steps].reverse().find(step => step.dataset.status === 'running');
  const problems = steps.filter(step => ['failed', 'rejected', 'cancelled'].includes(step.dataset.status)).length;
  const summary = trace.querySelector('.note-assistant-execution-summary');
  let text = terminal || !running ? '执行过程' : `正在${running.dataset.label || '执行工具'}`;
  if (completed) text += ` · 已完成 ${completed} 项`;
  if (problems) text += ` · ${problems} 项异常`;
  summary.textContent = text;
  trace.classList.toggle('has-problem', problems > 0);
  trace.classList.toggle('is-running', Boolean(running) && !terminal);
}

function findTraceStep(trace, call, payload, { completing = false } = {}) {
  const identity = callIdentity(call, payload);
  if (identity) {
    const existing = trace.querySelector(`[data-call-id="${CSS.escape(identity)}"]`);
    if (existing) return existing;
    const replay = traceSteps(trace).find(step => step.dataset.replayCandidate === 'true'
      && step.dataset.toolName === String(call?.name || payload?.name || ''));
    if (replay) {
      replay.dataset.callId = identity;
      delete replay.dataset.replayCandidate;
      return replay;
    }
  }
  if (!completing) {
    const replay = traceSteps(trace).find(step => step.dataset.replayCandidate === 'true'
      && step.dataset.toolName === String(call?.name || payload?.name || ''));
    if (replay) {
      delete replay.dataset.replayCandidate;
      return replay;
    }
  }
  if (completing) {
    const name = String(call?.name || payload?.name || '');
    return [...traceSteps(trace)].reverse().find(step => step.dataset.status === 'running'
      && step.dataset.toolName === name)
      || traceSteps(trace).find(step => step.dataset.replayCandidate === 'true' && step.dataset.toolName === name)
      || null;
  }
  return null;
}

function renderToolStep(trace, { call = {}, result = null, payload = {}, status = '', completing = false, follow = true } = {}) {
  if (!trace) return null;
  const wasNearBottom = follow && messagesAreNearBottom();
  const name = String(call.name || payload.name || '');
  const label = toolLabel(name);
  let step = findTraceStep(trace, call, payload, { completing });
  if (!step) {
    step = document.createElement('div');
    step.className = 'note-assistant-tool-step';
    const identity = callIdentity(call, payload);
    if (identity) step.dataset.callId = identity;
    step.innerHTML = `
      <span class="note-assistant-tool-state" aria-hidden="true"></span>
      <div class="note-assistant-tool-copy"><div class="note-assistant-tool-main"><strong></strong><span></span></div><div class="note-assistant-tool-result"></div><details class="note-assistant-tool-detail"><summary>技术详情</summary><pre></pre></details></div>`;
    trace.querySelector('.note-assistant-execution-steps').appendChild(step);
  }
  const nextStatus = status || (result ? toolState(result) : 'running');
  const delegateTitle = String(payload.delegateTitle || '');
  const summaryText = String(result?.summary || result?.error || '');
  step.dataset.status = nextStatus;
  step.dataset.toolName = name;
  step.dataset.label = label;
  step.querySelector('strong').textContent = delegateTitle ? `${label} · ${delegateTitle}` : label;
  step.querySelector('.note-assistant-tool-main span').textContent = toolStateLabel(nextStatus);
  const resultSummary = step.querySelector('.note-assistant-tool-result');
  resultSummary.textContent = toolResultSummary(name, result, nextStatus);
  resultSummary.hidden = !resultSummary.textContent;
  const detail = step.querySelector('.note-assistant-tool-detail');
  const raw = [name || 'unknown', summaryText, call.arguments && Object.keys(call.arguments).length ? JSON.stringify(call.arguments, null, 2) : ''].filter(Boolean).join('\n');
  detail.hidden = !raw;
  detail.querySelector('pre').textContent = raw;
  updateExecutionSummary(trace);
  followMessages(wasNearBottom);
  return step;
}

function realtimeTrace(runId = state?.runId) {
  const host = messagesHost();
  if (!host) return null;
  const selector = `.note-assistant-execution[data-run-id="${CSS.escape(String(runId || ''))}"]`;
  return host.querySelector(selector) || createExecutionTrace({ runId });
}

function finalizeRealtimeTrace(status = 'success') {
  const trace = messagesHost()?.querySelector(`.note-assistant-execution[data-run-id="${CSS.escape(String(state?.runId || ''))}"]`);
  if (!trace) return;
  for (const step of traceSteps(trace)) {
    if (step.dataset.status !== 'running') continue;
    step.dataset.status = status;
    step.querySelector('.note-assistant-tool-main span').textContent = toolStateLabel(status);
    const result = step.querySelector('.note-assistant-tool-result');
    result.textContent = ({ success: '已结束', failed: '执行失败', rejected: '操作已拒绝', cancelled: '操作已取消' })[status] || '';
    result.hidden = !result.textContent;
  }
  updateExecutionSummary(trace, { terminal: true });
}

function parseToolResult(message) {
  try { return JSON.parse(message?.content || '{}'); } catch { return { ok: false, summary: String(message?.content || '') }; }
}

function renderSessionMessages(messages = []) {
  const host = messagesHost();
  if (!host) return;
  host.innerHTML = '';
  let trace = null;
  let trailingTrace = null;
  const closeTrace = () => { if (trace) updateExecutionSummary(trace, { terminal: true }); trace = null; };
  for (const message of messages) {
    if (message.role === 'tool') {
      if (!trace) trace = createExecutionTrace({ historical: true });
      const result = parseToolResult(message);
      renderToolStep(trace, { call: { name: message.name || '工具' }, result, completing: true, follow: false });
      trailingTrace = trace;
      renderToolImages(result, { follow: false });
      continue;
    }
    closeTrace();
    trailingTrace = null;
    if (message.kind === 'browser_screenshot') {
      for (const attachment of message.attachments || []) renderToolImages({ data: { imageUrl: attachment.url } }, { follow: false });
    } else if (message.role === 'user' || message.role === 'assistant') {
      renderMessage(message.role, String(message.content || ''), { follow: false });
    }
  }
  closeTrace();
  host.scrollTop = 0;
  return trailingTrace;
}

function attachTrailingTrace(trace, runId) {
  if (!trace || !runId) return;
  trace.dataset.runId = runId;
  for (const step of traceSteps(trace)) step.dataset.replayCandidate = 'true';
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
  const documentId = state.activeDocumentId;
  const serial = contextSerial;
  if (!documentId || (payload.documentId && payload.documentId !== documentId)) {
    setStatus('提案与当前文档不一致，无法应用', 'error');
    return { ok: false };
  }
  try {
    await state.ensureDocument?.(documentId);
  } catch (error) {
    setStatus(error.message, 'error');
    return { ok: false };
  }
  if (serial !== contextSerial || state.activeDocumentId !== documentId) return { ok: false };
  const editor = document.querySelector('#documentContent');
  if (!editor) return { ok: false };
  try {
  if (payload.append) {
    await state.applyEdit({
      documentId,
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
  await state.applyEdit({ documentId, find, replace: String(payload.replace ?? '') });
  markProposal(payload.id, true, '已应用');
  return { ok: true };
  } catch (error) {
    setStatus(error.message, 'error');
    return { ok: false };
  }
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
  const serial = contextSerial;
  setStatus('');
  try {
    const response = await apiFetch(`/api/agent/note-assist/${encodeURIComponent(documentId)}/session`);
    if (serial !== contextSerial) return;
    if (!response.ok) {
      state.sessionId = '';
      return;
    }
    const data = await response.json().catch(() => ({}));
    if (serial !== contextSerial) return;
    state.sessionId = data.session?.id || '';
    const trailingTrace = renderSessionMessages(data.session?.messages || []);
    if (!state.sessionId) renderStatusLine('还没有对话，向留序 LiuXu 提问或让它修改本篇内容。');
    if (data.activeRun && ACTIVE_RUN_STATES.has(data.activeRun.status)) {
      // A run is still in flight server-side; resubscribe to its events.
      state.runId = data.activeRun.id;
      attachTrailingTrace(trailingTrace, data.activeRun.id);
      subscribeRun(data.activeRun.id);
    }
  } catch {
    if (serial === contextSerial) state.sessionId = '';
  }
}

function approvalDock() { return document.querySelector('#noteAssistantApprovalDock'); }
function clearInteraction() {
  state.approval = null;
  const dock = approvalDock();
  if (dock) { dock.hidden = true; dock.innerHTML = ''; }
}
function showApproval(payload) {
  state.runStatus = 'waiting_approval';
  state.approval = payload.approvals?.[0] || null;
  const dock = approvalDock();
  if (!dock || !state.approval) return;
  const approval = state.approval;
  dock.hidden = false;
  dock.innerHTML = `<section class="approval-card"><div class="approval-card-body"><h3>确认执行 ${escHtml(approval.call?.name || '')}（${Number(payload.queueIndex) || 1}/${Number(payload.queueTotal) || 1}）</h3>${state.approvalBodyHtml?.(approval) || `<pre>${escHtml(JSON.stringify(approval.call?.arguments || {}, null, 2))}</pre>`}</div><div class="card-actions"><button type="button" data-note-approval="false">拒绝</button><button type="button" data-note-approval="true">允许执行</button></div></section>`;
  syncComposer();
}
async function resolveApproval(approved) {
  if (!state.approval || state.approving || state.mutationPending) return;
  const approval = state.approval;
  const runId = state.runId;
  const serial = contextSerial;
  const documentId = state.activeDocumentId;
  const call = approval.call || {};
  const mutation = approved && String(call.arguments?.id) === documentId && ['knowledge.update', 'knowledge.delete', 'knowledge.archive', 'knowledge.restore'].includes(call.name);
  state.approving = true;
  let requestStarted = false;
  let responseReceived = false;
  try {
    if (mutation && await state.beforeMutation?.(documentId) === false) throw new Error('草稿保存失败，请解决后再确认');
    if (serial !== contextSerial || runId !== state.runId) { if (mutation) await state.afterMutation?.(documentId, { failed: true }); return; }
    if (mutation) state.mutationPending = true;
    requestStarted = true;
    const response = await apiFetch(`/api/agent/runs/${encodeURIComponent(runId)}/approvals/${encodeURIComponent(approval.id)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ approved }),
    });
    responseReceived = true;
    if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.error || '无法处理确认'); }
    if (state.approval?.id === approval.id) { clearInteraction(); state.runStatus = 'running'; }
  } catch (error) {
    if (mutation && (!requestStarted || responseReceived)) { state.mutationPending = false; await state.afterMutation?.(documentId, { failed: true }); }
    showToast(error.message, 'error');
  } finally { state.approving = false; syncComposer(); }
}

function handleRunEvent(event) {
  const type = event?.type || '';
  const payload = event.payload || {};
  if (type === 'approval.required') { showApproval(payload); return; }
  if (type === 'client_tool.requested') { state.runStatus = 'waiting_client_tool'; state.relayClientToolRequest?.({ runId: state.runId }, payload); return; }
  if (type.startsWith('delegate.')) { renderStatusLine(`子任务：${payload.delegateTitle || ''} ${type === 'delegate.completed' ? '已完成' : '执行中'}`); return; }
  if (type === 'memory.proposed') {
    renderMessage('assistant', `记忆提案：\n${payload.content || ''}`);
    const actions = document.createElement('div');
    actions.innerHTML = `<button data-note-memory="approve" data-memory-id="${escHtml(payload.id)}">保存记忆</button><button data-note-memory="dismiss" data-memory-id="${escHtml(payload.id)}">忽略</button>`;
    messagesHost()?.append(actions); return;
  }
  if (type === 'tool.completed') {
    const call = payload.call || {};
    const trace = realtimeTrace();
    renderToolStep(trace, { call, result: payload.result || {}, payload, completing: true });
    renderToolImages(payload.result);
    if (String(call.arguments?.id) === state.activeDocumentId && ['knowledge.update', 'knowledge.delete', 'knowledge.archive', 'knowledge.restore'].includes(call.name)) {
      state.mutationPending = false;
      Promise.resolve(state.afterMutation?.(state.activeDocumentId, payload)).catch(error => showToast(error.message, 'error'));
    }
    return;
  }
  if (type === 'tool.started') {
    const call = payload.call || payload;
    renderToolStep(realtimeTrace(), { call, payload });
    renderStatusLine('');
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
    finalizeRealtimeTrace('success');
    finishRun();
    renderStatusLine('');
    renderMessage('assistant', String(event.payload?.text || '（无回复）'));
    return;
  }
  if (type === 'run.failed') {
    const error = String(event.payload?.error || '');
    finalizeRealtimeTrace(error === 'cancelled' ? 'cancelled' : 'failed');
    finishRun();
    renderStatusLine('');
    if (error && error !== 'cancelled') renderMessage('assistant', `出错了：${error}`);
    else if (error === 'cancelled') renderMessage('assistant', '（已停止）');
    return;
  }
  if (type === 'user_input.required') {
    state.runStatus = 'waiting_user';
    clearInteraction();
    const dock = approvalDock();
    if (dock) { dock.hidden = false; dock.innerHTML = `<div class="approval-card-body">${escHtml(payload.question || '请补充信息')}</div>`; }
    setStatus('等待你的回答');
    renderStatusLine('');
    renderMessage('assistant', String(event.payload?.question || '（需要补充信息）'));
  }
}

function finishRun() {
  state.mutationPending = false;
  clearInteraction();
  state.runStatus = '';
  Promise.resolve(state.afterMutation?.(state.activeDocumentId, { reconcile: true })).catch(() => {});
  state.eventSource?.close();
  state.eventSource = null;
  state.runId = '';
  setStatus('');
}

function subscribeRun(runId) {
  const serial = contextSerial;
  state.runStatus = 'running';
  state.eventSource?.close();
  setStatus('正在思考…', 'running');
  syncComposer();
  const source = new EventSource(`/api/agent/runs/${encodeURIComponent(runId)}/events`);
  state.eventSource = source;
  source.addEventListener('run.started', () => { if (serial === contextSerial && state.runId === runId) setStatus('正在思考…', 'running'); });
  for (const type of ['tool.started', 'tool.completed', 'approval.required', 'client_tool.requested', 'memory.proposed', 'delegate.started', 'delegate.completed', 'delegate.progress', 'note.edit_proposed', 'run.completed', 'run.failed', 'user_input.required']) {
    source.addEventListener(type, event => {
      if (serial !== contextSerial || state.runId !== runId) return;
      let payload = null;
      try { payload = JSON.parse(event.data || '{}'); } catch { payload = null; }
      const key = JSON.stringify([runId, type, payload?.at, payload?.payload ?? payload]);
      if (type !== 'approval.required' && state.eventKeys.has(key)) return;
      state.eventKeys.add(key);
      handleRunEvent({ type, payload: payload?.payload ?? payload });
    });
  }
  source.onerror = () => {
    if (serial !== contextSerial || state.eventSource !== source) { source.close(); return; }
    // Terminal runs end the stream server-side; only treat premature errors
    // as failures when the run is still considered active.
    if (!state.runId) {
      source.close();
      return;
    }
    if (source.readyState === 2) { finishRun(); setStatus('连接已关闭，请重新打开会话', 'error'); return; }
    setStatus('连接中断，正在恢复…', 'error');
    Promise.resolve(state.afterMutation?.(state.activeDocumentId, { disconnected: true })).catch(() => {});
    // Keep pending answers during native reconnect; replayed events are deduplicated above.
  };
}

async function send() {
  const serial = contextSerial;
  const text = String(input()?.value || '').trim();
  if (!text || state.sending || (state.runId && state.runStatus !== 'waiting_user') || !state.activeDocumentId) return;
  state.sending = true;
  syncComposer();
  input().value = '';
  autoResizeNoteComposer();
  renderMessage('user', text, { forceFollow: true });
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
    if (serial !== contextSerial) return;
    if (response.status === 403) {
      throw new Error('日记已锁定，无法使用留序 LiuXu。');
    }
    if (!response.ok) throw new Error(data.error || '发送失败');
    clearInteraction();
    state.sessionId = data.sessionId || state.sessionId;
    state.runId = data.runId;
    subscribeRun(data.runId);
  } catch (error) {
    if (serial === contextSerial && input() && !input().value) input().value = text;
    showToast(error.message || '留序 LiuXu 发送失败', 'error');
  } finally { state.sending = false; syncComposer(); }
}

async function stop() {
  if (!state.runId) return;
  try {
    await apiFetch(`/api/agent/runs/${encodeURIComponent(state.runId)}/cancel`, { method: 'POST' });
  } catch { /* the SSE run.failed event resolves the UI */ }
}

async function loadSessionList() {
  const serial = contextSerial;
  if (!state.activeDocumentId) return;
  try {
    const response = await apiFetch(`/api/agent/note-assist/${encodeURIComponent(state.activeDocumentId)}/sessions`);
    const data = await response.json().catch(() => ({}));
    if (serial !== contextSerial) return;
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
  const serial = ++contextSerial;
  clearInteraction(); state.runStatus = ''; state.eventKeys.clear();
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
    if (serial !== contextSerial) return;
    const trailingTrace = renderSessionMessages(data.session?.messages || []);
    if (data.activeRun && ACTIVE_RUN_STATES.has(data.activeRun.status)) {
      state.runId = data.activeRun.id;
      attachTrailingTrace(trailingTrace, data.activeRun.id);
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
  contextSerial += 1;
  clearInteraction();
  state.runStatus = '';
  state.eventKeys.clear();
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

export function initNoteAssistant({ applyEdit, ensureDocument, ...integrations }) {
  if (bound) return;
  const host = panel();
  if (!host) return;
  bound = true;
  state = {
    ...integrations,
    runStatus: '',
    eventKeys: new Set(),
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
    ensureDocument,
  };
  layout = createAssistantLayout(host, { restoreFloating: restoreBounds });
  layout.sync();

  host.addEventListener('click', event => {
    const approval = event.target.closest('[data-note-approval]');
    if (approval) { resolveApproval(approval.dataset.noteApproval === 'true'); return; }
    const memory = event.target.closest('[data-note-memory]');
    if (memory) { Promise.resolve(state.handleMemoryProposalAction?.(memory.dataset.memoryId, memory.dataset.noteMemory)).then(() => memory.parentElement.remove()).catch(error => showToast(error.message, 'error')); return; }
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
    if ((state.approving || state.mutationPending) && ['new', 'switch-session', 'delete-session'].includes(kind)) return;
    if (kind === 'document') Promise.resolve(state.ensureDocument?.(state.activeDocumentId)).catch(error => setStatus(error.message, 'error'));
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
    if (event.key === 'Escape') { event.preventDefault(); setOpen(false); return; }
    if (event.key === 'Tab' && host.dataset.layout === 'overlay') {
      const controls = [...host.querySelectorAll('button, textarea, select, [tabindex="0"]')].filter(el => !el.disabled && !el.hidden && el.getClientRects().length);
      const first = controls[0]; const last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
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
  state.activeDocument = doc;
  const label = document.querySelector('#noteAssistantDocument');
  if (label) { label.textContent = doc?.title || '未命名文档'; label.title = `返回：${doc?.title || '未命名文档'}`; }
  if (doc?.id === state.activeDocumentId && doc?.status !== 'archived') { layout?.sync(); return; }
  contextSerial += 1;
  clearInteraction();
  state.runStatus = '';
  state.eventKeys.clear();
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
  if (input()) input().value = '';
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
  Promise.resolve(state.afterMutation?.(state.activeDocumentId, { failed: true })).catch(() => {});
  contextSerial += 1;
  clearInteraction();
  state.runStatus = '';
  state.eventKeys.clear();
  state.activeDocument = null;
  if (input()) input().value = '';
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

export function noteAssistantSetMode(mode) { layout?.setMode(mode); }
export function noteAssistantLockPrivate() {
  if (state?.activeDocument?.visibility === 'diary' || state?.activeDocument?.knowledgeBase === '日记') noteAssistantClear();
}
