import {
  apiFetch,
  checkAuth,
  getDiaryStatus,
  unlockDiary,
  lockDiary,
  logoutSite,
} from './auth.js';
import { debounce, escHtml, showToast } from './helpers.js';
import { destroyFilePreview, renderFilePreview, shouldCollapseExtractText } from './knowledge/filePreview.js';

const $ = selector => document.querySelector(selector);
const TERMINAL_RUN_STATES = new Set(['completed', 'failed', 'cancelled']);
const ACTIVE_RUN_STATES = new Set(['queued', 'running', 'waiting_approval', 'waiting_client_tool']);

const state = {
  mode: 'agent',
  user: null,
  diaryUnlocked: false,
  sessions: [],
  activeSession: null,
  runId: '',
  runStatus: '',
  eventSource: null,
  runEventKeys: new Set(),
  documents: [],
  activeDocument: null,
  annotation: null,
  knowledgeTotal: 0,
  knowledgeNextCursor: null,
  knowledgeBases: [],
  selectedKnowledgeBase: '',
  selectedFolderPath: '',
  documentSaveTimer: null,
  annotationSaveTimer: null,
  documentDirty: false,
  annotationDirty: false,
  documentConflict: false,
  editorMode: 'edit',
  routeSerial: 0,
};

function renderMarkdown(value) {
  const source = String(value || '');
  if (!window.marked || !window.DOMPurify) return escHtml(source).replace(/\n/g, '<br>');
  return window.DOMPurify.sanitize(window.marked.parse(source, { breaks: true, gfm: true }));
}

function formatTime(value) {
  const date = new Date(value || 0);
  if (!Number.isFinite(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(date);
}

function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function autoResizeComposer() {
  const input = $('#agentInput');
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
}

function scrollMessagesToBottom() {
  const list = $('#agentMessageList');
  requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; });
}

const mobileSidebarQuery = window.matchMedia('(max-width: 840px)');

function syncMobileSidebarAccessibility() {
  const sidebar = $('#workspaceSidebar');
  const isOpen = document.body.classList.contains('sidebar-visible');
  const isHidden = mobileSidebarQuery.matches && !isOpen;
  sidebar.inert = isHidden;
  if (isHidden) sidebar.setAttribute('aria-hidden', 'true');
  else sidebar.removeAttribute('aria-hidden');
  $('#sidebarOpen').setAttribute('aria-expanded', String(mobileSidebarQuery.matches && isOpen));
}

function openMobileSidebar() {
  document.body.classList.add('sidebar-visible');
  syncMobileSidebarAccessibility();
  requestAnimationFrame(() => $('#sidebarClose').focus());
}

function closeMobileSidebar() {
  document.body.classList.remove('sidebar-visible');
  syncMobileSidebarAccessibility();
}

function parseRoute() {
  const raw = (window.location.hash || '#agent').slice(1);
  const question = raw.indexOf('?');
  const path = question >= 0 ? raw.slice(0, question) : raw;
  const query = new URLSearchParams(question >= 0 ? raw.slice(question + 1) : '');
  const [modeValue, ...rest] = path.split('/');
  const mode = modeValue === 'knowledge' ? 'knowledge' : 'agent';
  let id = '';
  try { id = decodeURIComponent(rest.join('/')); } catch { id = rest.join('/'); }
  return {
    mode,
    id,
    block: query.get('block') || '',
    offset: Number(query.get('offset')) || 0,
    knowledgeBase: query.get('base') || '',
    folderPath: query.get('folder') || '',
  };
}

function routeHash(mode, id = '', options = {}) {
  const path = id ? `${mode}/${encodeURIComponent(id)}` : mode;
  const query = new URLSearchParams();
  if (options.block) query.set('block', options.block);
  if (Number.isFinite(options.offset) && options.offset > 0) query.set('offset', String(options.offset));
  if (mode === 'knowledge' && !id && options.knowledgeBase) query.set('base', options.knowledgeBase);
  if (mode === 'knowledge' && !id && options.folderPath) query.set('folder', options.folderPath);
  return `#${path}${query.size ? `?${query.toString()}` : ''}`;
}

async function navigate(mode, id = '', options = {}, { replace = false } = {}) {
  const hash = routeHash(mode, id, options);
  if (replace) history.replaceState(null, '', hash);
  else if (window.location.hash !== hash) history.pushState(null, '', hash);
  await applyRoute();
}

function setModeUI(mode) {
  state.mode = mode;
  document.querySelectorAll('[data-mode]').forEach(button => {
    button.classList.toggle('active', button.dataset.mode === mode);
    button.setAttribute('aria-current', button.dataset.mode === mode ? 'page' : 'false');
  });
  document.querySelectorAll('[data-sidebar-mode]').forEach(panel => { panel.hidden = panel.dataset.sidebarMode !== mode; });
  document.querySelectorAll('[data-main-mode]').forEach(panel => { panel.hidden = panel.dataset.mainMode !== mode; });
  syncKnowledgeBrandActions();
  const brandHome = document.querySelector('.brand-home');
  if (brandHome) brandHome.setAttribute('href', mode === 'knowledge' ? '#knowledge' : '#agent');
  $('#topbarTitle').textContent = mode === 'agent' ? 'Agent' : '知识库';
  if (mode === 'agent') {
    $('#topbarSubtitle').textContent = state.activeSession?.title || '新会话';
  } else if (isKnowledgeRoot()) {
    $('#topbarSubtitle').textContent = `${state.knowledgeBases.length} 个知识库`;
  } else {
    $('#topbarSubtitle').textContent = state.activeDocument?.title || `${state.knowledgeTotal} 条知识`;
  }
  closeMobileSidebar();
}

async function applyRoute() {
  const route = parseRoute();
  const activeDocumentId = state.activeDocument?.id || '';
  const leavesActiveDocument = state.mode === 'knowledge'
    && activeDocumentId
    && (route.mode !== 'knowledge' || route.id !== activeDocumentId);
  if (leavesActiveDocument && !(await flushPendingSaves())) {
    history.replaceState(null, '', routeHash('knowledge', activeDocumentId));
    return;
  }
  const serial = ++state.routeSerial;
  if (route.mode === 'knowledge' && !route.id) {
    state.selectedKnowledgeBase = route.knowledgeBase;
    state.selectedFolderPath = route.folderPath;
  }
  setModeUI(route.mode);
  if (route.mode === 'agent') {
    if (route.id) await openSession(route.id, serial);
    else showEmptySession();
  } else if (route.id) {
    await openKnowledgeDocument(route.id, { block: route.block, offset: route.offset, serial });
    if (state.selectedKnowledgeBase) await loadDocuments();
  } else {
    showEmptyDocument();
    if (state.selectedKnowledgeBase) await loadDocuments();
    else clearKnowledgeDocuments();
  }
  if (route.mode === 'knowledge') {
    renderKnowledgeBaseList();
    if (state.selectedKnowledgeBase) renderKnowledgeTree();
    setKnowledgeSidebarLevel();
  }
}

function sessionGroup(value) {
  const date = new Date(value || 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const day = new Date(date);
  day.setHours(0, 0, 0, 0);
  const diff = Math.floor((today - day) / 86400000);
  if (diff <= 0) return '今天';
  if (diff <= 7) return '最近 7 天';
  return '更早';
}

function renderSessions() {
  const list = $('#sessionList');
  const query = $('#sessionSearch').value.trim().toLowerCase();
  const sessions = state.sessions.filter(session => (
    !query || `${session.title || ''} ${session.lastMessagePreview || ''}`.toLowerCase().includes(query)
  ));
  if (!sessions.length) {
    list.innerHTML = `<p class="empty-list">${query ? '没有匹配的会话' : '还没有会话，创建一个开始吧。'}</p>`;
    return;
  }
  const groups = new Map();
  sessions.forEach(session => {
    const name = sessionGroup(session.updatedAt);
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(session);
  });
  list.innerHTML = [...groups.entries()].map(([name, items]) => `
    <section class="session-group">
      <h2 class="session-group-title">${escHtml(name)}</h2>
      ${items.map(session => `
        <div class="session-row ${state.activeSession?.id === session.id ? 'active' : ''}" data-session-row="${escHtml(session.id)}">
          <button class="session-select" type="button" data-session-open="${escHtml(session.id)}">
            <strong>${escHtml(session.title || '新会话')}</strong>
            <small>${escHtml(session.lastMessagePreview || formatTime(session.updatedAt) || '暂无消息')}</small>
          </button>
          <span class="session-actions">
            <button class="session-action" type="button" data-session-rename="${escHtml(session.id)}" title="重命名" aria-label="重命名 ${escHtml(session.title || '会话')}">✎</button>
            <button class="session-action" type="button" data-session-archive="${escHtml(session.id)}" title="归档" aria-label="归档 ${escHtml(session.title || '会话')}">⌁</button>
          </span>
        </div>`).join('')}
    </section>`).join('');
}

async function loadSessions() {
  const response = await apiFetch('/api/agent/sessions');
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || '会话加载失败');
  state.sessions = data.sessions || [];
  renderSessions();
}

function showEmptySession() {
  state.activeSession = null;
  state.eventSource?.close();
  state.eventSource = null;
  setRunStatus('');
  $('#topbarSubtitle').textContent = '新会话';
  $('#agentMessageList').innerHTML = `
    <div class="agent-empty-state">
      <span class="empty-mark" aria-hidden="true">✦</span>
      <h1>今天想一起完成什么？</h1>
      <p>我会先查找你的知识，再请求执行需要确认的操作。</p>
      <div class="starter-prompts">
        <button type="button" data-starter="帮我查找最近的项目记录并总结下一步">总结项目记录</button>
        <button type="button" data-starter="根据我的知识库规划今天最重要的三件事">规划今天</button>
      </div>
    </div>`;
  $('#executionTrace').hidden = true;
  renderSessions();
}

function addMessage(role, content, citations = []) {
  const list = $('#agentMessageList');
  list.querySelector('.agent-empty-state')?.remove();
  const article = document.createElement('article');
  article.className = `message ${role === 'user' ? 'user' : 'assistant'}`;
  const citationHtml = Array.isArray(citations) && citations.length ? `
    <div class="citation-list">
      ${citations.map((citation, index) => {
        const documentId = citation.documentId || String(citation.id || '').split('#')[0];
        const label = citation.title || citation.heading || `来源 ${index + 1}`;
        return `<button class="citation-button" type="button" data-citation-document="${escHtml(documentId)}" data-citation-block="${escHtml(citation.id || '')}" data-citation-offset="${Number(citation.offset) || 0}">${escHtml(label)}</button>`;
      }).join('')}
    </div>` : '';
  article.innerHTML = role === 'user'
    ? `<div class="message-body"><div class="message-content">${renderMarkdown(content)}</div></div>`
    : `<div class="message-avatar" aria-hidden="true">A</div><div class="message-body"><div class="message-content">${renderMarkdown(content)}</div>${citationHtml}</div>`;
  list.append(article);
  scrollMessagesToBottom();
  return article;
}

function renderSessionMessages(session) {
  const list = $('#agentMessageList');
  list.innerHTML = '';
  const visible = (session.messages || []).filter(message => message.role === 'user' || message.role === 'assistant');
  const deduped = visible.filter((message, index) => {
    const previous = visible[index - 1];
    return !previous || previous.role !== message.role || previous.content !== message.content;
  });
  deduped.forEach(message => addMessage(message.role, message.content));
  if (!deduped.length) showEmptySessionContent();
  scrollMessagesToBottom();
}

function showEmptySessionContent() {
  $('#agentMessageList').innerHTML = `
    <div class="agent-empty-state">
      <span class="empty-mark" aria-hidden="true">✦</span>
      <h1>从一个具体目标开始</h1>
      <p>描述希望得到的结果，Agent 会自行查找知识并规划步骤。</p>
    </div>`;
}

async function openSession(id, serial = state.routeSerial) {
  if (state.activeSession?.id === id && state.activeSession.messages) {
    $('#topbarSubtitle').textContent = state.activeSession.title || '新会话';
    renderSessions();
    return;
  }
  const response = await apiFetch(`/api/agent/sessions/${encodeURIComponent(id)}`);
  const data = await response.json().catch(() => ({}));
  if (serial !== state.routeSerial) return;
  if (!response.ok) {
    showToast(data.error || '会话不存在', 'error');
    await navigate('agent', '', {}, { replace: true });
    return;
  }
  state.activeSession = data;
  $('#topbarSubtitle').textContent = data.title || '新会话';
  renderSessionMessages(data);
  renderSessions();
  const latestRun = data.latestRun;
  if (latestRun && ACTIVE_RUN_STATES.has(latestRun.status)) subscribeRun(latestRun.id, latestRun.status);
  else setRunStatus('');
}

async function createSession(title = '新会话') {
  const response = await apiFetch('/api/agent/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || '无法创建会话');
  await loadSessions();
  await navigate('agent', data.id);
  $('#agentInput').focus();
  return data;
}

function startSessionRename(id) {
  const row = document.querySelector(`[data-session-row="${CSS.escape(id)}"]`);
  const session = state.sessions.find(item => item.id === id);
  if (!row || !session) return;
  row.innerHTML = `<input class="session-rename-input" maxlength="80" value="${escHtml(session.title || '新会话')}" aria-label="新会话标题">`;
  const input = row.querySelector('input');
  input.focus();
  input.select();
  let finished = false;
  const finish = async save => {
    if (finished) return;
    finished = true;
    const title = input.value.trim();
    if (save && title && title !== session.title) {
      const response = await apiFetch(`/api/agent/sessions/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      });
      if (!response.ok) showToast('会话重命名失败', 'error');
      else if (state.activeSession?.id === id) {
        state.activeSession.title = title;
        $('#topbarSubtitle').textContent = title;
      }
      await loadSessions();
    } else renderSessions();
  };
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); finish(true); }
    if (event.key === 'Escape') { event.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
}

function confirmAction({ title, message, confirmText = '确认' }) {
  const dialog = $('#confirmDialog');
  $('#confirmTitle').textContent = title;
  $('#confirmMessage').textContent = message;
  $('#confirmAccept').textContent = confirmText;
  dialog.showModal();
  return new Promise(resolve => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true });
  });
}

async function archiveSession(id) {
  const session = state.sessions.find(item => item.id === id);
  if (!session) return;
  const confirmed = await confirmAction({
    title: '归档会话',
    message: `“${session.title || '新会话'}”将从会话列表隐藏，运行记录和证据仍会保留。`,
    confirmText: '归档',
  });
  if (!confirmed) return;
  const response = await apiFetch(`/api/agent/sessions/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'archived' }),
  });
  if (!response.ok) return showToast('会话归档失败', 'error');
  if (state.activeSession?.id === id) await navigate('agent');
  await loadSessions();
  showToast('会话已归档', 'success');
}

function trace(text) {
  if (!text) return;
  const details = $('#executionTrace');
  details.hidden = false;
  const event = document.createElement('div');
  event.className = 'trace-event';
  event.textContent = text;
  $('#traceEvents').append(event);
  $('#traceEvents').scrollTop = $('#traceEvents').scrollHeight;
  $('#traceSummary').textContent = text;
}

function setRunStatus(status, text = '') {
  state.runStatus = status;
  const active = ACTIVE_RUN_STATES.has(status);
  $('#runStatus').hidden = !active;
  $('#stopRunButton').hidden = !active;
  $('#sendAgentButton').disabled = active;
  $('#agentSidebarStatus').classList.toggle('busy', active);
  const labels = {
    queued: '正在排队', running: '正在运行', waiting_approval: '等待确认', waiting_client_tool: '等待浏览器',
  };
  const label = text || labels[status] || 'Agent 已就绪';
  $('#runStatusText').textContent = label;
  $('#agentSidebarStatus span:last-child').textContent = label;
}

function renderApproval(payload) {
  const approvals = Array.isArray(payload.approvals) ? payload.approvals : [];
  if (!approvals.length) {
    const card = document.createElement('section');
    card.className = 'approval-card';
    card.innerHTML = '<h3>需要你的判断</h3><p>工具连续失败，Agent 已暂停。可以停止当前运行并调整目标后重试。</p>';
    $('#agentMessageList').append(card);
    scrollMessagesToBottom();
    return;
  }
  approvals.forEach(approval => {
    if (document.querySelector(`[data-approval-card="${CSS.escape(approval.id)}"]`)) return;
    const name = approval.call?.name || '未知操作';
    const args = JSON.stringify(approval.call?.arguments || {}, null, 2);
    const card = document.createElement('section');
    card.className = 'approval-card';
    card.dataset.approvalCard = approval.id;
    card.innerHTML = `
      <h3>确认执行 ${escHtml(name)}</h3>
      <p>Agent 请求执行一个会改变数据或访问外部服务的动作。</p>
      <div class="approval-risk"><strong>参数</strong><pre>${escHtml(args)}</pre></div>
      <div class="card-actions">
        <button class="secondary-action" type="button" data-approval-id="${escHtml(approval.id)}" data-approved="false">拒绝</button>
        <button class="primary-action compact" type="button" data-approval-id="${escHtml(approval.id)}" data-approved="true">允许执行</button>
      </div>`;
    $('#agentMessageList').append(card);
  });
  scrollMessagesToBottom();
}

function renderMemoryProposal(payload) {
  const proposal = payload.proposal || payload;
  if (!proposal?.id || document.querySelector(`[data-memory-card="${CSS.escape(proposal.id)}"]`)) return;
  const card = document.createElement('section');
  card.className = 'memory-card';
  card.dataset.memoryCard = proposal.id;
  card.innerHTML = `
    <h3>保存为长期记忆？</h3>
    <p><strong>${escHtml(proposal.title || '任务经验')}</strong><br>${escHtml(proposal.content || '')}</p>
    <div class="card-actions">
      <button class="secondary-action" type="button" data-memory-dismiss>暂不保存</button>
      <button class="primary-action compact" type="button" data-memory-approve="${escHtml(proposal.id)}">保存记忆</button>
    </div>`;
  $('#agentMessageList').append(card);
  scrollMessagesToBottom();
}

function runEventKey(event) {
  let payload = '';
  try { payload = JSON.stringify(event.payload || {}); } catch { payload = ''; }
  return `${event.type}|${event.at || ''}|${payload}`;
}

function handleRunEvent(event) {
  const key = runEventKey(event);
  if (state.runEventKeys.has(key)) return;
  state.runEventKeys.add(key);
  const payload = event.payload || {};
  if (event.type === 'run.started') { setRunStatus('running'); trace('正在分析目标'); }
  if (event.type === 'assistant.delta' && payload.text) trace('正在组织回答');
  if (event.type === 'tool.proposed') trace(`准备使用 ${payload.calls?.map(call => call.name).join('、') || '工具'}`);
  if (event.type === 'tool.started') trace(`正在执行 ${payload.name || payload.call?.name || '工具'}`);
  if (event.type === 'tool.completed') trace(payload.result?.summary || payload.call?.name || '工具执行完成');
  if (event.type === 'checkpoint.updated') trace('已更新工作进度');
  if (event.type === 'approval.required') { setRunStatus('waiting_approval'); trace('等待你的确认'); renderApproval(payload); }
  if (event.type === 'client_tool.requested') { setRunStatus('waiting_client_tool'); trace('等待浏览器返回结果'); }
  if (event.type === 'memory.proposed') renderMemoryProposal(payload);
  if (event.type === 'run.completed') {
    addMessage('assistant', payload.text || '已完成。', payload.citations || []);
    trace('运行完成');
    setRunStatus('');
    state.eventSource?.close();
    state.eventSource = null;
    loadSessions().catch(() => {});
  }
  if (event.type === 'run.failed') {
    const message = payload.error === 'cancelled' ? '运行已停止。' : `运行未完成：${payload.error || '未知错误'}`;
    const card = document.createElement('div');
    card.className = 'run-error';
    card.textContent = message;
    $('#agentMessageList').append(card);
    trace(message);
    setRunStatus('');
    state.eventSource?.close();
    state.eventSource = null;
    scrollMessagesToBottom();
  }
}

function subscribeRun(runId, initialStatus = 'queued') {
  state.eventSource?.close();
  state.runId = runId;
  state.runEventKeys = new Set();
  $('#traceEvents').innerHTML = '';
  $('#executionTrace').hidden = false;
  setRunStatus(initialStatus);
  const source = new EventSource(`/api/agent/runs/${encodeURIComponent(runId)}/events`);
  state.eventSource = source;
  [
    'run.started', 'assistant.delta', 'tool.proposed', 'approval.required', 'tool.started',
    'tool.completed', 'checkpoint.updated', 'client_tool.requested', 'memory.proposed',
    'run.completed', 'run.failed',
  ].forEach(type => source.addEventListener(type, raw => {
    try { handleRunEvent(JSON.parse(raw.data)); } catch { trace('收到无法识别的运行事件'); }
  }));
  source.onerror = () => {
    if (state.eventSource === source && ACTIVE_RUN_STATES.has(state.runStatus)) trace('连接暂时中断，正在自动重连');
  };
}

async function sendAgentMessage(content) {
  let session = state.activeSession;
  if (!session) session = await createSession(content.slice(0, 30));
  addMessage('user', content);
  setRunStatus('queued');
  trace('目标已提交');
  const response = await apiFetch(`/api/agent/sessions/${encodeURIComponent(session.id)}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    setRunStatus('');
    throw new Error(data.error || 'Agent 启动失败');
  }
  subscribeRun(data.runId, data.status);
  loadSessions().catch(() => {});
}

async function stopCurrentRun() {
  if (!state.runId) return;
  const response = await apiFetch(`/api/agent/runs/${encodeURIComponent(state.runId)}/cancel`, { method: 'POST' });
  if (!response.ok) showToast('无法停止当前运行', 'error');
}

function selectedKnowledgePath() {
  return [state.selectedKnowledgeBase, state.selectedFolderPath].filter(Boolean).join('/');
}

function findKnowledgeBase(name) {
  return state.knowledgeBases.find(item => item.name === name) || null;
}

function isKnowledgeRoot() {
  return state.mode === 'knowledge' && !state.selectedKnowledgeBase;
}

function shouldShowKnowledgeBrandActions() {
  return state.mode === 'knowledge' && Boolean(state.selectedKnowledgeBase);
}

function syncKnowledgeBrandActions() {
  const container = $('#knowledgeBrandActions');
  if (!container) return;
  const show = shouldShowKnowledgeBrandActions();
  container.hidden = !show;
  container.classList.toggle('is-visible', show);
  if ('inert' in container) container.inert = !show;
  container.querySelectorAll('button').forEach(button => {
    button.disabled = !show;
    button.tabIndex = show ? 0 : -1;
    button.setAttribute('aria-hidden', show ? 'false' : 'true');
  });
}

function setKnowledgeSidebarLevel() {
  if (state.mode !== 'knowledge') {
    syncKnowledgeBrandActions();
    return;
  }
  const atRoot = isKnowledgeRoot();
  const rootPanel = $('#knowledgeRootPanel');
  const insidePanel = $('#knowledgeInsidePanel');
  if (rootPanel) rootPanel.hidden = !atRoot;
  if (insidePanel) insidePanel.hidden = atRoot;
  syncKnowledgeBrandActions();
  updateKnowledgeEmptyState();
}

function updateKnowledgeEmptyState() {
  if (state.activeDocument || state.mode !== 'knowledge') return;
  const title = $('#knowledgeEmptyTitle');
  const text = $('#knowledgeEmptyText');
  const button = $('#emptyNewNoteButton');
  if (!title || !text) return;
  if (isKnowledgeRoot()) {
    title.textContent = '选择一个知识库开始浏览';
    text.textContent = '从左侧选择一个知识库，查看文件夹和文档。';
    if (button) button.hidden = true;
  } else {
    title.textContent = '选择一条知识开始阅读';
    text.textContent = '在此知识库新建或导入内容，或从左侧选择文档。';
    if (button) button.hidden = false;
  }
}

function clearKnowledgeDocuments() {
  state.documents = [];
  state.knowledgeTotal = 0;
  state.knowledgeNextCursor = null;
  renderDocuments();
}

function renderKnowledgeBaseList() {
  const list = $('#knowledgeBaseList');
  if (!list) return;
  if (!state.knowledgeBases.length) {
    list.innerHTML = '<p class="empty-list">还没有知识库。</p>';
    return;
  }
  list.innerHTML = state.knowledgeBases.map(base => {
    const canDeleteBase = !['其他', '日记'].includes(base.name);
    return `
      <div class="knowledge-base-row">
        <button class="knowledge-base-select" type="button" data-knowledge-base-open="${escHtml(base.name)}" aria-label="进入 ${escHtml(base.name)}">
          <span class="tree-folder-mark" aria-hidden="true">▰</span>
          <strong>${escHtml(base.name)}</strong>
          <small>${Number(base.documentCount) || 0}</small>
          <span class="knowledge-base-chevron" aria-hidden="true">›</span>
        </button>
        <span class="tree-actions">
          <button class="tree-action" type="button" data-tree-rename-base="${escHtml(base.name)}" title="重命名知识库" aria-label="重命名 ${escHtml(base.name)}">✎</button>
          ${canDeleteBase ? `<button class="tree-action" type="button" data-tree-delete-base="${escHtml(base.name)}" title="删除知识库" aria-label="删除 ${escHtml(base.name)}">⌫</button>` : ''}
        </span>
      </div>`;
  }).join('');
  $('#knowledgeBaseOptions').innerHTML = state.knowledgeBases.map(base => `<option value="${escHtml(base.name)}"></option>`).join('');
}

function renderKnowledgeTree() {
  const tree = $('#knowledgeFolderTree');
  const base = findKnowledgeBase(state.selectedKnowledgeBase);
  if (!tree || !base) return;
  const title = $('#knowledgeInsideTitle');
  if (title) title.textContent = base.name;
  const baseActive = !state.selectedFolderPath;
  const folders = Array.isArray(base.folders) ? base.folders : [];
  tree.innerHTML = `
    <div class="knowledge-tree-folder-row">
      <button class="knowledge-tree-folder ${baseActive ? 'active' : ''}" type="button" data-knowledge-folder="" data-knowledge-base="${escHtml(base.name)}" aria-current="${baseActive ? 'page' : 'false'}">全部文档 <small>${Number(base.documentCount) || 0}</small></button>
      <span class="tree-actions">
        <button class="tree-action" type="button" data-tree-add-folder="${escHtml(base.name)}" title="新建文件夹" aria-label="在 ${escHtml(base.name)} 下新建文件夹">＋</button>
      </span>
    </div>
    ${folders.map(folder => {
      const active = state.selectedFolderPath === folder.path;
      return `<div class="knowledge-tree-folder-row">
        <button class="knowledge-tree-folder ${active ? 'active' : ''}" type="button" data-knowledge-folder="${escHtml(folder.path)}" data-knowledge-base="${escHtml(base.name)}" aria-current="${active ? 'page' : 'false'}"><span aria-hidden="true">└</span>${escHtml(folder.name)} <small>${Number(folder.documentCount) || 0}</small></button>
        <span class="tree-actions"><button class="tree-action" type="button" data-tree-rename-folder="${escHtml(base.name)}" data-tree-folder="${escHtml(folder.path)}" title="重命名文件夹" aria-label="重命名 ${escHtml(folder.name)}">✎</button><button class="tree-action" type="button" data-tree-delete-folder="${escHtml(base.name)}" data-tree-folder="${escHtml(folder.path)}" title="删除文件夹" aria-label="删除 ${escHtml(folder.name)}">⌫</button></span>
      </div>`;
    }).join('')}`;
  const folderOptions = folders.map(folder => `<option value="${escHtml(folder.path)}"></option>`).join('');
  $('#folderOptions').innerHTML = folderOptions;
}

async function loadKnowledgeTree() {
  const response = await apiFetch('/api/knowledge/tree');
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || '知识库加载失败');
  state.knowledgeBases = Array.isArray(data.knowledgeBases) ? data.knowledgeBases : [];
  renderKnowledgeBaseList();
  if (state.selectedKnowledgeBase) renderKnowledgeTree();
}

async function manageKnowledgeTree(action, baseName, folderPath = '') {
  const currentPath = folderPath ? `${baseName}/${folderPath}` : baseName;
  if (action === 'delete-base' || action === 'delete-folder') {
    const confirmed = await confirmAction({
      title: action === 'delete-base' ? '删除知识库' : '删除文件夹',
      message: `“${currentPath}”中的文档会重新归入“其他”，正文不会删除。`,
      confirmText: '删除',
    });
    if (!confirmed) return;
    const response = await apiFetch(`/api/categories/${encodeURIComponent(currentPath)}`, { method: 'DELETE' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return showToast(data.error || '删除失败', 'error');
    if (state.selectedKnowledgeBase === baseName && (!folderPath || state.selectedFolderPath === folderPath)) {
      if (action === 'delete-base') {
        state.selectedKnowledgeBase = '';
        state.selectedFolderPath = '';
      } else {
        state.selectedFolderPath = '';
      }
    }
    await loadKnowledgeTree();
    if (action === 'delete-base' && !state.selectedKnowledgeBase) {
      await navigate('knowledge');
      return;
    }
    await navigate('knowledge', '', { knowledgeBase: state.selectedKnowledgeBase, folderPath: state.selectedFolderPath });
    return;
  }
  let name = '';
  if (action === 'add-base') name = window.prompt('新知识库名称', '') || '';
  if (action === 'add-folder') name = window.prompt(`在“${baseName}”下新建文件夹`, '') || '';
  if (action === 'rename-base') name = window.prompt('新的知识库名称', baseName) || '';
  if (action === 'rename-folder') name = window.prompt('新的文件夹名称', folderPath) || '';
  name = name.trim();
  if (!name || name === (action === 'rename-base' ? baseName : folderPath)) return;
  const response = action === 'add-base' || action === 'add-folder'
    ? await apiFetch('/api/categories', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(action === 'add-base' ? { name } : { name, parent: baseName }),
    })
    : await apiFetch(`/api/categories/${encodeURIComponent(currentPath)}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
    });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) return showToast(data.error || '知识库结构更新失败', 'error');
  await loadKnowledgeTree();
  if (action === 'add-base') {
    state.selectedKnowledgeBase = name;
    state.selectedFolderPath = '';
  } else if (action === 'add-folder') {
    state.selectedKnowledgeBase = baseName;
    state.selectedFolderPath = name;
  } else if (action === 'rename-base') {
    if (state.selectedKnowledgeBase === baseName) state.selectedKnowledgeBase = name;
  } else if (action === 'rename-folder' && state.selectedKnowledgeBase === baseName && state.selectedFolderPath === folderPath) {
    state.selectedFolderPath = name;
  }
  renderKnowledgeBaseList();
  renderKnowledgeTree();
  await navigate('knowledge', '', { knowledgeBase: state.selectedKnowledgeBase, folderPath: state.selectedFolderPath });
}

function knowledgeQuery(cursor = '') {
  const params = new URLSearchParams();
  const values = {
    q: $('#knowledgeSearch').value.trim(),
    knowledgeBase: state.selectedKnowledgeBase,
    folderPath: state.selectedFolderPath,
    tag: $('#knowledgeTagFilter').value.trim(),
    date: $('#knowledgeDateFilter').value,
  };
  Object.entries(values).forEach(([key, value]) => { if (value) params.set(key, value); });
  if ($('#knowledgeArchivedFilter').checked) params.set('status', 'archived');
  params.set('limit', '60');
  if (cursor) params.set('cursor', cursor);
  return params;
}

function renderDocuments() {
  const list = $('#knowledgeDocumentList');
  $('#knowledgeDocumentCount').textContent = `${state.knowledgeTotal} 条知识`;
  if (!state.documents.length) {
    list.innerHTML = '<p class="empty-list">没有符合条件的知识文档。</p>';
  } else {
    list.innerHTML = state.documents.map(document => {
      const location = [document.knowledgeBase, document.folderPath].filter(Boolean).join(' / ') || '其他';
      const date = document.documentDate || formatTime(document.updatedAt);
      const subtitle = `${location}${date ? ` · ${date}` : ''}`;
      return `
        <div class="document-row ${state.activeDocument?.id === document.id ? 'active' : ''}" role="button" tabindex="0" data-document-open="${escHtml(document.id)}">
          <span class="document-row-body">
            <span class="document-row-title"><strong>${escHtml(document.title || '未命名')}</strong>${document.visibility === 'diary' ? '<span class="private-mark" title="私密知识">◆</span>' : ''}</span>
            <small>${escHtml(subtitle)}</small>
          </span>
        </div>`;
    }).join('');
  }
  $('#knowledgeLoadMore').hidden = !state.knowledgeNextCursor;
}

async function loadDocuments({ append = false } = {}) {
  const cursor = append ? state.knowledgeNextCursor : '';
  if (append && !cursor) return;
  const response = await apiFetch(`/api/knowledge/documents?${knowledgeQuery(cursor)}`);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || '知识库加载失败');
  state.documents = append ? [...state.documents, ...(data.documents || [])] : (data.documents || []);
  state.knowledgeTotal = Number(data.total) || 0;
  state.knowledgeNextCursor = data.nextCursor || null;
  renderKnowledgeTree();
  renderDocuments();
  if (state.mode === 'knowledge' && !state.activeDocument) {
    $('#topbarSubtitle').textContent = `${state.knowledgeTotal} 条知识`;
  }
}

function showEmptyDocument() {
  state.activeDocument = null;
  state.annotation = null;
  destroyFilePreview();
  clearTimeout(state.documentSaveTimer);
  clearTimeout(state.annotationSaveTimer);
  state.documentDirty = false;
  state.annotationDirty = false;
  $('#knowledgeEmptyState').hidden = false;
  $('#documentWorkspace').hidden = true;
  if (isKnowledgeRoot()) {
    $('#topbarSubtitle').textContent = `${state.knowledgeBases.length} 个知识库`;
  } else {
    $('#topbarSubtitle').textContent = `${state.knowledgeTotal} 条知识`;
  }
  updateKnowledgeEmptyState();
  renderDocuments();
}

function setDocumentSaveState(text, className = '') {
  const element = $('#documentSaveState');
  element.textContent = text;
  element.className = `save-state ${className}`.trim();
}

async function renderActiveDocument(document) {
  state.activeDocument = document;
  state.documentDirty = false;
  state.annotationDirty = false;
  state.documentConflict = false;
  state.editorMode = 'edit';
  state.selectedKnowledgeBase = document.knowledgeBase || String(document.collectionPath || '其他').split('/')[0] || '其他';
  state.selectedFolderPath = document.folderPath || String(document.collectionPath || '').split('/').slice(1).join('/');
  setKnowledgeSidebarLevel();
  $('#knowledgeEmptyState').hidden = true;
  $('#documentWorkspace').hidden = false;
  $('#documentTitle').value = document.title || '';
  $('#documentKnowledgeBase').value = state.selectedKnowledgeBase;
  $('#documentFolderPath').value = state.selectedFolderPath;
  $('#documentDate').value = document.documentDate || document.logDate || '';
  $('#documentTags').value = (document.tags || []).join(', ');
  $('#documentContent').value = document.content || '';
  $('#topbarSubtitle').textContent = document.title || '未命名';
  setDocumentSaveState('已保存');
  const isFile = document.sourceType === 'file';
  $('#noteEditor').hidden = isFile;
  $('#fileReader').hidden = !isFile;
  $('#editorModeSwitch').hidden = isFile;
  $('#archiveDocumentButton').hidden = document.sourceType === 'log' || document.status === 'archived';
  $('#documentTitle').readOnly = document.status === 'archived';
  $('#documentKnowledgeBase').readOnly = document.status === 'archived';
  $('#documentFolderPath').readOnly = document.status === 'archived';
  $('#documentDate').readOnly = document.status === 'archived';
  $('#documentTags').readOnly = document.status === 'archived';
  $('#documentContent').readOnly = document.status === 'archived';
  setEditorMode('edit');
  if (isFile) await renderFile(document);
  else destroyFilePreview();
  renderKnowledgeBaseList();
  renderKnowledgeTree();
  renderDocuments();
}

async function renderFile(document) {
  const meta = document.fileMeta || {};
  $('#fileName').textContent = meta.filename || document.title || '文件';
  const metaParts = [formatBytes(meta.bytes)];
  if (document.status === 'needs_ocr') metaParts.push('扫描型 PDF');
  $('#fileMeta').textContent = metaParts.filter(Boolean).join(' · ');
  const extractText = document.content || (document.status === 'needs_ocr'
    ? '这是扫描型 PDF，当前版本尚未提供 OCR。'
    : '没有提取到正文。');
  $('#fileContent').textContent = extractText;
  const extractDetails = $('#fileExtractDetails');
  if (extractDetails) extractDetails.open = !shouldCollapseExtractText(document);
  $('#openOriginalFile').href = meta.url || `/api/knowledge/files/${encodeURIComponent(document.id)}/content`;
  await renderFilePreview(document, $('#filePreviewHost'));
  $('#annotationTitle').value = `${document.title || meta.filename || '文件'} · 笔记`;
  $('#annotationContent').value = '';
  $('#annotationSaveState').textContent = '输入后自动保存';
  state.annotationDirty = false;
  const response = await apiFetch(`/api/knowledge/documents/${encodeURIComponent(document.id)}/annotation`);
  const data = await response.json().catch(() => ({}));
  if (state.activeDocument?.id !== document.id || !response.ok) return;
  state.annotation = data.annotation || null;
  if (state.annotation) {
    $('#annotationTitle').value = state.annotation.title || '';
    $('#annotationContent').value = state.annotation.content || '';
    $('#annotationSaveState').textContent = '已保存';
  }
  state.annotationDirty = false;
}

async function openKnowledgeDocument(id, { block = '', offset = 0, serial = state.routeSerial } = {}) {
  if (state.activeDocument?.id === id) {
    if (block || offset) locateDocumentPosition(offset, state.activeDocument.content || '');
    return;
  }
  const response = await apiFetch(`/api/knowledge/documents/${encodeURIComponent(id)}`);
  const data = await response.json().catch(() => ({}));
  if (serial !== state.routeSerial) return;
  if (!response.ok) {
    showToast(data.error || '文档不存在或仍处于锁定状态', 'error');
    await navigate('knowledge', '', {}, { replace: true });
    return;
  }
  await renderActiveDocument(data);
  if (block || offset) locateDocumentPosition(offset, data.content || '');
}

function locateDocumentPosition(offset, content) {
  const position = Math.max(0, Math.min(Number(offset) || 0, content.length));
  if (state.activeDocument?.sourceType === 'file') {
    const reader = $('#fileContent');
    requestAnimationFrame(() => { reader.scrollTop = content.length ? reader.scrollHeight * (position / content.length) : 0; });
    return;
  }
  setEditorMode('edit');
  const editor = $('#documentContent');
  requestAnimationFrame(() => {
    editor.focus();
    editor.setSelectionRange(position, Math.min(content.length, position + 120));
    editor.scrollTop = content.length ? editor.scrollHeight * (position / content.length) : 0;
  });
}

function setEditorMode(mode) {
  state.editorMode = mode === 'preview' ? 'preview' : 'edit';
  document.querySelectorAll('[data-editor-mode]').forEach(button => button.classList.toggle('active', button.dataset.editorMode === state.editorMode));
  const preview = state.editorMode === 'preview';
  $('#documentContent').hidden = preview;
  $('#documentPreview').hidden = !preview;
  if (preview) $('#documentPreview').innerHTML = renderMarkdown($('#documentContent').value || '*暂无正文*');
}

function currentDocumentPatch() {
  const patch = {
    title: $('#documentTitle').value.trim() || '未命名',
    knowledgeBase: $('#documentKnowledgeBase').value.trim() || '其他',
    folderPath: $('#documentFolderPath').value.trim(),
    documentDate: $('#documentDate').value || '',
    tags: $('#documentTags').value.split(/[,，]/).map(tag => tag.trim()).filter(Boolean),
    baseVersion: state.activeDocument?.version,
  };
  if (state.activeDocument?.sourceType !== 'file') patch.content = $('#documentContent').value;
  return patch;
}

function updateDocumentSummary(document) {
  const index = state.documents.findIndex(item => item.id === document.id);
  if (index < 0) return;
  state.documents[index] = {
    ...state.documents[index],
    title: document.title,
    collectionPath: document.collectionPath,
    knowledgeBase: document.knowledgeBase,
    folderPath: document.folderPath,
    documentDate: document.documentDate || document.logDate || '',
    tags: document.tags,
    version: document.version,
    updatedAt: document.updatedAt,
    snippet: String(document.content || '').replace(/\s+/g, ' ').slice(0, 180),
  };
  state.documents.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  renderDocuments();
}

function scheduleDocumentSave() {
  if (!state.activeDocument || state.activeDocument.status === 'archived' || state.documentConflict) return;
  state.documentDirty = true;
  setDocumentSaveState('等待保存', 'saving');
  clearTimeout(state.documentSaveTimer);
  state.documentSaveTimer = setTimeout(() => saveDocument(), 800);
}

async function resolveDocumentConflict(current) {
  state.documentConflict = true;
  setDocumentSaveState('保存冲突', 'error');
  const reload = await confirmAction({
    title: '文档已在其他位置修改',
    message: '重新加载会显示服务器上的最新版本；取消可保留当前输入，方便先复制未保存内容。',
    confirmText: '重新加载',
  });
  if (reload && current) {
    await renderActiveDocument(current);
    return true;
  }
  showToast('当前内容尚未保存，请复制后重新打开文档', 'error');
  return false;
}

async function saveDocument() {
  clearTimeout(state.documentSaveTimer);
  if (!state.activeDocument || !state.documentDirty || state.documentConflict) return true;
  const id = state.activeDocument.id;
  setDocumentSaveState('正在保存', 'saving');
  const response = await apiFetch(`/api/knowledge/documents/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(currentDocumentPatch()),
  });
  const data = await response.json().catch(() => ({}));
  if (state.activeDocument?.id !== id) return false;
  if (response.status === 409) {
    return resolveDocumentConflict(data.current);
  }
  if (!response.ok) {
    setDocumentSaveState('保存失败', 'error');
    showToast(data.error || '文档保存失败', 'error');
    return false;
  }
  state.activeDocument = data;
  state.documentDirty = false;
  setDocumentSaveState('已保存');
  $('#topbarSubtitle').textContent = data.title || '未命名';
  updateDocumentSummary(data);
  return true;
}

function scheduleAnnotationSave() {
  if (!state.activeDocument || state.activeDocument.sourceType !== 'file') return;
  if (!state.annotation && !$('#annotationTitle').value.trim() && !$('#annotationContent').value.trim()) return;
  state.annotationDirty = true;
  $('#annotationSaveState').textContent = '等待保存';
  clearTimeout(state.annotationSaveTimer);
  state.annotationSaveTimer = setTimeout(() => saveAnnotation(), 800);
}

async function saveAnnotation() {
  clearTimeout(state.annotationSaveTimer);
  if (!state.activeDocument || state.activeDocument.sourceType !== 'file') return true;
  if (!state.annotationDirty) return true;
  const id = state.activeDocument.id;
  const payload = {
    title: $('#annotationTitle').value.trim() || `${state.activeDocument.title || '文件'} · 笔记`,
    content: $('#annotationContent').value,
    baseVersion: state.annotation?.version,
  };
  $('#annotationSaveState').textContent = '正在保存';
  const response = await apiFetch(`/api/knowledge/documents/${encodeURIComponent(id)}/annotation`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  if (state.activeDocument?.id !== id) return false;
  if (!response.ok) {
    $('#annotationSaveState').textContent = response.status === 409 ? '保存冲突，请重新打开文件' : '保存失败';
    showToast(data.error || '关联笔记保存失败', 'error');
    return false;
  }
  state.annotation = data;
  state.annotationDirty = false;
  $('#annotationSaveState').textContent = '已保存';
  return true;
}

async function flushPendingSaves() {
  const documentSaved = await saveDocument();
  const annotationSaved = await saveAnnotation();
  return documentSaved && annotationSaved;
}

async function createNote() {
  const response = await apiFetch('/api/knowledge/documents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: '未命名笔记',
      content: '',
      knowledgeBase: state.selectedKnowledgeBase || '其他',
      folderPath: state.selectedFolderPath || '',
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) return showToast(data.error || '笔记创建失败', 'error');
  await loadDocuments();
  await navigate('knowledge', data.id);
  $('#documentTitle').focus();
  $('#documentTitle').select();
}

async function importKnowledgeFile(file) {
  const body = new FormData();
  body.append('file', file);
  if (state.selectedKnowledgeBase) body.append('knowledgeBase', state.selectedKnowledgeBase);
  if (state.selectedFolderPath) body.append('folderPath', state.selectedFolderPath);
  $('#importFileButton').disabled = true;
  $('#importFileButton').textContent = '…';
  try {
    const response = await apiFetch('/api/knowledge/imports', { method: 'POST', body });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || '文件导入失败');
    await loadDocuments();
    await navigate('knowledge', data.document.id);
    showToast(data.duplicate ? '文件已存在，已打开原文档' : '文件已加入知识库', 'success');
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    $('#importFileButton').disabled = false;
    $('#importFileButton').textContent = '↑';
  }
}

async function archiveActiveDocument() {
  const document = state.activeDocument;
  if (!document || document.sourceType === 'log') return;
  const confirmed = await confirmAction({
    title: '归档知识文档',
    message: `“${document.title || '未命名'}”将从默认列表和检索结果中隐藏，原文件不会被删除。`,
    confirmText: '归档',
  });
  if (!confirmed) return;
  const response = await apiFetch(`/api/knowledge/documents/${encodeURIComponent(document.id)}/archive`, { method: 'POST' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) return showToast(data.error || '归档失败', 'error');
  showToast('文档已归档', 'success');
  await loadDocuments();
  await navigate('knowledge');
}

async function syncDiaryStatus() {
  const status = await getDiaryStatus();
  state.diaryUnlocked = status.enabled === false || !status.locked;
  const button = $('#diaryButton');
  button.textContent = state.diaryUnlocked ? '私密知识已解锁' : '私密知识已锁定';
  button.classList.toggle('unlocked', state.diaryUnlocked);
}

async function toggleDiary() {
  if (!state.diaryUnlocked) {
    $('#diaryPassword').value = '';
    $('#diaryDialog').showModal();
    requestAnimationFrame(() => $('#diaryPassword').focus());
    return;
  }
  const confirmed = await confirmAction({
    title: '锁定私密知识',
    message: '日记将立即从知识列表、搜索和后续 Agent 上下文中移除。',
    confirmText: '立即锁定',
  });
  if (!confirmed) return;
  await flushPendingSaves();
  await lockDiary();
  state.diaryUnlocked = false;
  if (state.activeDocument?.visibility === 'diary') await navigate('knowledge');
   await Promise.all([syncDiaryStatus(), loadKnowledgeTree(), loadDocuments()]);
  showToast('私密知识已锁定', 'success');
}

async function loadAccount() {
  const response = await apiFetch('/api/auth/me');
  if (!response.ok) return;
  state.user = await response.json();
  const name = state.user.display_name || state.user.username || '用户';
  $('#diaryUsername').value = state.user.username || name;
  $('#accountInitial').textContent = [...name][0] || '用';
  $('#accountName').textContent = name;
  $('#accountRole').textContent = state.user.role === 'admin' ? '管理员账户' : '普通账户';
}

function applyTheme(value) {
  if (value === 'system') {
    localStorage.removeItem('theme');
    document.documentElement.setAttribute('data-theme', window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  } else {
    localStorage.setItem('theme', value);
    document.documentElement.setAttribute('data-theme', value);
  }
}

function bindEvents() {
  document.querySelector('.mode-switch').addEventListener('click', async event => {
    const button = event.target.closest('[data-mode]');
    if (!button) return;
    const targetMode = button.dataset.mode;
    let id = '';
    let options = {};
    if (targetMode === state.mode) {
      id = targetMode === 'agent' ? (state.activeSession?.id || '') : (state.activeDocument?.id || '');
      if (targetMode === 'knowledge' && !id && state.selectedKnowledgeBase) {
        options = { knowledgeBase: state.selectedKnowledgeBase, folderPath: state.selectedFolderPath };
      }
    }
    if (targetMode === 'knowledge') await loadKnowledgeTree();
    navigate(targetMode, id, options);
  });
  $('#sidebarOpen').addEventListener('click', openMobileSidebar);
  $('#sidebarClose').addEventListener('click', closeMobileSidebar);
  $('#sidebarBackdrop').addEventListener('click', closeMobileSidebar);
  $('#newSessionButton').addEventListener('click', () => createSession().catch(error => showToast(error.message, 'error')));
  $('#sessionSearch').addEventListener('input', renderSessions);
  $('#sessionList').addEventListener('click', event => {
    const open = event.target.closest('[data-session-open]');
    const rename = event.target.closest('[data-session-rename]');
    const archive = event.target.closest('[data-session-archive]');
    if (open) navigate('agent', open.dataset.sessionOpen);
    if (rename) startSessionRename(rename.dataset.sessionRename);
    if (archive) archiveSession(archive.dataset.sessionArchive);
  });
  $('#agentComposer').addEventListener('submit', async event => {
    event.preventDefault();
    const input = $('#agentInput');
    const content = input.value.trim();
    if (!content || ACTIVE_RUN_STATES.has(state.runStatus)) return;
    input.value = '';
    autoResizeComposer();
    try { await sendAgentMessage(content); } catch (error) { showToast(error.message, 'error'); }
  });
  $('#agentInput').addEventListener('input', autoResizeComposer);
  $('#agentInput').addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      $('#agentComposer').requestSubmit();
    }
  });
  $('#stopRunButton').addEventListener('click', stopCurrentRun);
  $('#agentMessageList').addEventListener('click', async event => {
    const starter = event.target.closest('[data-starter]');
    if (starter) {
      $('#agentInput').value = starter.dataset.starter;
      autoResizeComposer();
      $('#agentComposer').requestSubmit();
      return;
    }
    const citation = event.target.closest('[data-citation-document]');
    if (citation) {
      await navigate('knowledge', citation.dataset.citationDocument, {
        block: citation.dataset.citationBlock,
        offset: Number(citation.dataset.citationOffset) || 0,
      });
      return;
    }
    const approval = event.target.closest('[data-approval-id]');
    if (approval) {
      approval.closest('.approval-card').querySelectorAll('button').forEach(button => { button.disabled = true; });
      const response = await apiFetch(`/api/agent/runs/${encodeURIComponent(state.runId)}/approvals/${encodeURIComponent(approval.dataset.approvalId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approved: approval.dataset.approved === 'true' }),
      });
      if (!response.ok) {
        approval.closest('.approval-card').querySelectorAll('button').forEach(button => { button.disabled = false; });
        return showToast('无法处理这项确认', 'error');
      }
      approval.closest('.approval-card').remove();
      setRunStatus('running');
      return;
    }
    const memoryApprove = event.target.closest('[data-memory-approve]');
    if (memoryApprove) {
      const response = await apiFetch(`/api/agent/memory-proposals/${encodeURIComponent(memoryApprove.dataset.memoryApprove)}/approve`, { method: 'POST' });
      if (!response.ok) return showToast('长期记忆保存失败', 'error');
      memoryApprove.closest('.memory-card').remove();
      showToast('长期记忆已保存', 'success');
      return;
    }
    event.target.closest('[data-memory-dismiss]')?.closest('.memory-card')?.remove();
  });

  const reloadKnowledge = debounce(() => loadDocuments().catch(error => showToast(error.message, 'error')), 220);
  $('#knowledgeSearch').addEventListener('input', reloadKnowledge);
  ['knowledgeTagFilter', 'knowledgeDateFilter', 'knowledgeArchivedFilter'].forEach(id => {
    $(`#${id}`).addEventListener(id === 'knowledgeTagFilter' ? 'input' : 'change', reloadKnowledge);
  });
  $('#newKnowledgeBaseButton').addEventListener('click', () => manageKnowledgeTree('add-base'));
  $('#knowledgeBackButton').addEventListener('click', () => {
    state.selectedKnowledgeBase = '';
    state.selectedFolderPath = '';
    navigate('knowledge');
  });
  $('#knowledgeBaseList').addEventListener('click', event => {
    const open = event.target.closest('[data-knowledge-base-open]');
    const renameBase = event.target.closest('[data-tree-rename-base]');
    const deleteBase = event.target.closest('[data-tree-delete-base]');
    if (renameBase) return manageKnowledgeTree('rename-base', renameBase.dataset.treeRenameBase);
    if (deleteBase) return manageKnowledgeTree('delete-base', deleteBase.dataset.treeDeleteBase);
    if (open) navigate('knowledge', '', { knowledgeBase: open.dataset.knowledgeBaseOpen });
  });
  $('#knowledgeFolderTree').addEventListener('click', event => {
    const folder = event.target.closest('[data-knowledge-folder]');
    const addFolder = event.target.closest('[data-tree-add-folder]');
    const renameFolder = event.target.closest('[data-tree-rename-folder]');
    const deleteFolder = event.target.closest('[data-tree-delete-folder]');
    if (addFolder) return manageKnowledgeTree('add-folder', addFolder.dataset.treeAddFolder);
    if (renameFolder) return manageKnowledgeTree('rename-folder', renameFolder.dataset.treeRenameFolder, renameFolder.dataset.treeFolder);
    if (deleteFolder) return manageKnowledgeTree('delete-folder', deleteFolder.dataset.treeDeleteFolder, deleteFolder.dataset.treeFolder);
    if (!folder) return;
    const baseName = folder.dataset.knowledgeBase || state.selectedKnowledgeBase;
    const folderPath = folder.dataset.knowledgeFolder || '';
    state.selectedKnowledgeBase = baseName;
    state.selectedFolderPath = folderPath;
    renderKnowledgeTree();
    navigate('knowledge', '', { knowledgeBase: baseName, folderPath });
  });
  $('#newNoteButton').addEventListener('click', createNote);
  $('#emptyNewNoteButton').addEventListener('click', createNote);
  $('#importFileButton').addEventListener('click', () => $('#knowledgeFileInput').click());
  $('#knowledgeFileInput').addEventListener('change', event => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) importKnowledgeFile(file);
  });
  $('#knowledgeLoadMore').addEventListener('click', () => loadDocuments({ append: true }).catch(error => showToast(error.message, 'error')));
  $('#knowledgeDocumentList').addEventListener('click', event => {
    const row = event.target.closest('[data-document-open]');
    if (row) navigate('knowledge', row.dataset.documentOpen);
  });
  $('#knowledgeDocumentList').addEventListener('keydown', event => {
    const row = event.target.closest('[data-document-open]');
    if (row && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      navigate('knowledge', row.dataset.documentOpen);
    }
  });
  ['documentTitle', 'documentKnowledgeBase', 'documentFolderPath', 'documentDate', 'documentTags', 'documentContent'].forEach(id => $(`#${id}`).addEventListener('input', scheduleDocumentSave));
  $('#editorModeSwitch').addEventListener('click', event => {
    const button = event.target.closest('[data-editor-mode]');
    if (button) setEditorMode(button.dataset.editorMode);
  });
  $('#archiveDocumentButton').addEventListener('click', archiveActiveDocument);
  ['annotationTitle', 'annotationContent'].forEach(id => $(`#${id}`).addEventListener('input', scheduleAnnotationSave));
  document.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && state.mode === 'knowledge') {
      event.preventDefault();
      flushPendingSaves();
    }
    if (event.key === 'Escape') closeMobileSidebar();
  });
  window.addEventListener('beforeunload', event => {
    if (!state.documentDirty && !state.annotationDirty) return;
    event.preventDefault();
  });
  window.addEventListener('popstate', applyRoute);
  window.addEventListener('hashchange', applyRoute);
  mobileSidebarQuery.addEventListener('change', () => {
    document.body.classList.remove('sidebar-visible');
    syncMobileSidebarAccessibility();
  });

  $('#diaryButton').addEventListener('click', toggleDiary);
  $('#closeDiaryDialog').addEventListener('click', () => $('#diaryDialog').close());
  $('#cancelDiaryDialog').addEventListener('click', () => $('#diaryDialog').close());
  $('#diaryForm').addEventListener('submit', async event => {
    event.preventDefault();
    const ok = await unlockDiary($('#diaryPassword').value);
    if (!ok) return showToast('私密知识口令不正确', 'error');
    $('#diaryDialog').close();
     await Promise.all([syncDiaryStatus(), loadKnowledgeTree(), state.selectedKnowledgeBase ? loadDocuments() : Promise.resolve()]);
    showToast('私密知识已解锁', 'success');
  });
  $('#settingsButton').addEventListener('click', () => $('#settingsDialog').showModal());
  $('#accountSettings').addEventListener('click', () => { $('#accountMenu').hidden = true; $('#settingsDialog').showModal(); });
  $('#themeSelect').addEventListener('change', event => applyTheme(event.target.value));
  $('#accountButton').addEventListener('click', event => {
    event.stopPropagation();
    const menu = $('#accountMenu');
    menu.hidden = !menu.hidden;
    $('#accountButton').setAttribute('aria-expanded', String(!menu.hidden));
  });
  document.addEventListener('click', event => {
    if (!event.target.closest('#accountMenu') && !event.target.closest('#accountButton')) {
      $('#accountMenu').hidden = true;
      $('#accountButton').setAttribute('aria-expanded', 'false');
    }
  });
  $('#logoutButton').addEventListener('click', logoutSite);
}

async function initialize() {
  if (!(await checkAuth())) return;
  bindEvents();
  syncMobileSidebarAccessibility();
  const savedTheme = localStorage.getItem('theme');
  $('#themeSelect').value = savedTheme === 'dark' || savedTheme === 'light' ? savedTheme : 'system';
  await Promise.all([loadAccount(), syncDiaryStatus()]);
   await loadKnowledgeTree();
  await loadSessions();
  if (!window.location.hash) history.replaceState(null, '', '#agent');
  await applyRoute();
}

initialize().catch(error => {
  console.error(error);
  showToast(`工作台初始化失败：${error.message}`, 'error');
});
