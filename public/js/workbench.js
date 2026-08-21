import {
  apiFetch,
  checkAuth,
  getDiaryStatus,
  unlockDiary,
  lockDiary,
  logoutSite,
} from './auth.js';
import { debounce, escHtml, highlightSearch, showToast } from './helpers.js';
import { destroyFilePreview, renderFilePreview, shouldCollapseExtractText } from './knowledge/filePreview.js';
import { enableMarkdownImagePreview, openMarkdownImagePreview } from './imagePreview.js';
import { renderToHtml, renderToHtmlUncached } from './markdown.js';
import { initTodos, loadTodos, showTodoView, getTodoSubtitle } from './todos.js';
import { fillAccountSettings, initAccounts } from './accounts.js';
import { createBackupActions } from './workbench-backup.js';
import { initSelectControls, syncSelectControls } from './selectControl.js';

const $ = selector => document.querySelector(selector);
const DOCUMENT_SELECT_IDS = ['documentKnowledgeBase', 'documentFolderPath'];
const TERMINAL_RUN_STATES = new Set(['completed', 'failed', 'cancelled']);
const ACTIVE_RUN_STATES = new Set(['queued', 'running', 'waiting_approval', 'waiting_client_tool', 'waiting_user']);
const BLOCKING_RUN_STATES = new Set(['queued', 'running', 'waiting_approval', 'waiting_client_tool']);

const state = {
  mode: 'agent',
  user: null,
  diaryUnlocked: false,
  sessions: [],
  archivedSessions: [],
  activeSession: null,
  runId: '',
  runStatus: '',
  eventSource: null,
  memoryRefreshSource: null,
  runEventKeys: new Set(),
  childEventSources: new Map(),
  childRunEventKeys: new Map(),
  activeChildRunId: '',
  documents: [],
  activeDocument: null,
  annotation: null,
  knowledgeTotal: 0,
  knowledgeNextCursor: null,
  knowledgeBases: [],
  selectedKnowledgeBase: '',
  selectedFolderPath: '',
  agentStatus: null,
  aiSettings: null,
  settingsPanel: 'appearance',
  documentSaveTimer: null,
  annotationSaveTimer: null,
  documentDirty: false,
  annotationDirty: false,
  documentConflict: false,
  editorMode: 'edit',
  routeSerial: 0,
  memoryLayer: '',
  memories: { items: [], proposals: [] },
  runImages: [],
  delegateTitle: '',
  computerPolicy: { computerToolsEnabled: true, allowedDirectories: [] },
};

function isSafeImageSrc(value) {
  const src = String(value || '').trim();
  if (/^\/uploads\/[A-Za-z0-9._-]+$/.test(src)) return true;
  if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(src)) return true;
  try {
    const url = new URL(src);
    return url.protocol === 'https:';
  } catch {
    return false;
  }
}

if (window.DOMPurify) {
  window.DOMPurify.addHook('afterSanitizeAttributes', node => {
    if (node.tagName === 'IMG' && !isSafeImageSrc(node.getAttribute('src'))) {
      node.removeAttribute('src');
    }
  });
}

function renderMarkdown(value) {
  return renderToHtml(String(value || ''));
}

let documentPreviewCleanup = null;

function renderDocumentPreview() {
  const host = $('#documentPreview');
  if (!host) return;
  if (documentPreviewCleanup) documentPreviewCleanup();
  documentPreviewCleanup = null;
  host.innerHTML = renderToHtmlUncached($('#documentContent').value || '*暂无正文*');
  documentPreviewCleanup = enableMarkdownImagePreview(host, '.markdown-preview img');
}

const refreshDocumentPreview = debounce(() => {
  if (state.editorMode === 'preview' || state.editorMode === 'split') renderDocumentPreview();
}, 300);

function formatTime(value) {
  const date = new Date(value || 0);
  if (!Number.isFinite(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(date);
}

function formatSessionDate(value) {
  const date = new Date(value || 0);
  if (!Number.isFinite(date.getTime())) return '';
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const day = new Date(date);
  day.setHours(0, 0, 0, 0);
  const diff = Math.floor((today - day) / 86400000);
  const time = new Intl.DateTimeFormat('zh-CN', { hour: 'numeric', minute: '2-digit' }).format(date);
  if (diff <= 0) return `今天 ${time}`;
  if (diff === 1) return `昨天 ${time}`;
  if (date.getFullYear() === today.getFullYear()) {
    const monthDay = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(date);
    return `${monthDay} ${time}`;
  }
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric' }).format(date);
}

function sessionMessageCount(session) {
  if (!session) return 0;
  const count = Number(session.messageCount);
  if (Number.isFinite(count) && count >= 0) return count;
  return Array.isArray(session.messages) ? session.messages.length : 0;
}

function formatSessionMeta(session) {
  if (!session) return '暂无消息';
  const count = sessionMessageCount(session);
  const countLabel = count ? `${count} 条消息` : '暂无消息';
  const dateLabel = formatSessionDate(session.updatedAt);
  return dateLabel ? `${dateLabel} · ${countLabel}` : countLabel;
}

function applyAgentTopbar(session) {
  if (!session) {
    $('#topbarTitle').textContent = '新会话';
    $('#topbarSubtitle').textContent = '';
    return;
  }
  $('#topbarTitle').textContent = session.title || '新会话';
  $('#topbarSubtitle').textContent = formatSessionMeta(session);
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

function localIsoDate(offsetDays = 0) {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function mentionQueryFromInput() {
  const input = $('#agentInput');
  const cursor = input.selectionStart ?? input.value.length;
  const before = input.value.slice(0, cursor);
  const at = before.lastIndexOf('@');
  if (at < 0) return null;
  const query = before.slice(at + 1);
  if (/[\s]/.test(query)) return null;
  return { start: at, query };
}

function mentionChoices(query = '') {
  const needle = String(query || '').toLowerCase();
  const bases = (state.knowledgeBases || [])
    .map(item => item.name)
    .filter(Boolean)
    .filter(name => !needle || name.toLowerCase().includes(needle) || `@${name}`.includes(query));
  const dates = [
    { id: 'today', label: `今天 ${localIsoDate(0)}`, value: localIsoDate(0) },
    { id: 'yesterday', label: `昨天 ${localIsoDate(-1)}`, value: localIsoDate(-1) },
  ].filter(item => !needle || item.label.includes(query) || item.value.includes(query) || '今天昨天日期'.includes(query));
  return [
    ...bases.map(name => ({ id: `base:${name}`, type: 'base', label: name, value: name })),
    ...dates.map(item => ({ id: `date:${item.id}`, type: 'date', label: item.label, value: item.value })),
  ];
}

function hideMentionMenu() {
  const menu = $('#mentionMenu');
  if (!menu) return;
  menu.hidden = true;
  menu.querySelectorAll('.mention-item').forEach(item => item.classList.remove('active'));
}

function renderMentionMenu() {
  const menu = $('#mentionMenu');
  const active = mentionQueryFromInput();
  if (!menu || !active) {
    hideMentionMenu();
    return;
  }
  const choices = mentionChoices(active.query);
  const list = $('#mentionBaseList');
  if (choices.some(item => item.type === 'base')) {
    list.innerHTML = choices.filter(item => item.type === 'base').map((item, index) => (
      `<button class="mention-item${index === 0 ? ' active' : ''}" type="button" role="option" data-mention="${escHtml(item.value)}">${escHtml(item.label)}</button>`
    )).join('');
  } else {
    list.innerHTML = '<p class="mention-empty">没有匹配的知识库</p>';
  }
  menu.querySelectorAll('[data-mention="today"], [data-mention="yesterday"]').forEach(button => {
    const isToday = button.dataset.mention === 'today';
    const item = mentionChoices(active.query).find(choice => choice.id === (isToday ? 'date:today' : 'date:yesterday'));
    button.hidden = !item;
    button.classList.remove('active');
  });
  const visible = [...menu.querySelectorAll('.mention-item:not([hidden])')];
  if (!visible.some(item => item.classList.contains('active')) && visible[0]) visible[0].classList.add('active');
  menu.hidden = false;
}

function insertMentionValue(value) {
  const input = $('#agentInput');
  const active = mentionQueryFromInput();
  if (!active) return;
  const token = `@${value} `;
  input.value = `${input.value.slice(0, active.start)}${token}${input.value.slice(input.selectionStart)}`;
  const cursor = active.start + token.length;
  input.setSelectionRange(cursor, cursor);
  hideMentionMenu();
  autoResizeComposer();
  input.focus();
}

function moveMentionSelection(delta) {
  const menu = $('#mentionMenu');
  if (!menu || menu.hidden) return;
  const items = [...menu.querySelectorAll('.mention-item:not([hidden])')];
  if (!items.length) return;
  const current = items.findIndex(item => item.classList.contains('active'));
  const next = (current + delta + items.length) % items.length;
  items.forEach(item => item.classList.remove('active'));
  items[next].classList.add('active');
  items[next].scrollIntoView({ block: 'nearest' });
}

function selectedMentionItem() {
  return $('#mentionMenu:not([hidden]) .mention-item.active');
}

function scrollMessagesToBottom() {
  const list = $('#agentMessageList');
  requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; });
}

const mobileSidebarQuery = window.matchMedia('(max-width: 840px)');
const desktopSidebarQuery = window.matchMedia('(min-width: 841px)');
const SIDEBAR_COLLAPSED_KEY = 'workbenchSidebarCollapsed';
const KNOWLEDGE_SEARCH_OPTIONS_KEY = 'knowledgeSearchOptions';

const KNOWLEDGE_SEARCH_PRESETS = {
  smart: {
    preset: 'smart',
    prefix: true,
    fuzzy: 0.2,
    strict: false,
    fields: ['title', 'heading', 'body', 'tags', 'path'],
  },
  exact: {
    preset: 'exact',
    prefix: false,
    fuzzy: 0,
    strict: true,
    fields: ['title', 'heading', 'body'],
  },
};

const KNOWLEDGE_SEARCH_FIELD_IDS = {
  title: 'knowledgeSearchFieldTitle',
  heading: 'knowledgeSearchFieldHeading',
  body: 'knowledgeSearchFieldBody',
  tags: 'knowledgeSearchFieldTags',
  path: 'knowledgeSearchFieldPath',
};

function defaultKnowledgeSearchOptions() {
  return {
    ...KNOWLEDGE_SEARCH_PRESETS.smart,
    fields: [...KNOWLEDGE_SEARCH_PRESETS.smart.fields],
  };
}

function normalizeKnowledgeSearchOptions(raw) {
  const fallback = defaultKnowledgeSearchOptions();
  const preset = ['smart', 'exact', 'custom'].includes(raw?.preset) ? raw.preset : fallback.preset;
  const base = preset === 'exact'
    ? KNOWLEDGE_SEARCH_PRESETS.exact
    : preset === 'smart'
      ? KNOWLEDGE_SEARCH_PRESETS.smart
      : fallback;
  const fields = Array.isArray(raw?.fields)
    ? raw.fields.filter(field => Object.keys(KNOWLEDGE_SEARCH_FIELD_IDS).includes(field))
    : [...base.fields];
  return {
    preset,
    prefix: raw?.prefix !== undefined ? Boolean(raw.prefix) : base.prefix,
    fuzzy: Number.isFinite(Number(raw?.fuzzy)) ? Math.min(0.5, Math.max(0, Number(raw.fuzzy))) : base.fuzzy,
    strict: raw?.strict !== undefined ? Boolean(raw.strict) : base.strict,
    fields: fields.length ? fields : [...base.fields],
  };
}

function loadKnowledgeSearchOptions() {
  try {
    const saved = JSON.parse(localStorage.getItem(KNOWLEDGE_SEARCH_OPTIONS_KEY) || 'null');
    return normalizeKnowledgeSearchOptions(saved);
  } catch {
    return defaultKnowledgeSearchOptions();
  }
}

function saveKnowledgeSearchOptions(options) {
  const normalized = normalizeKnowledgeSearchOptions(options);
  localStorage.setItem(KNOWLEDGE_SEARCH_OPTIONS_KEY, JSON.stringify(normalized));
  renderKnowledgeSearchModeHint(normalized);
  return normalized;
}

function applyKnowledgeSearchPreset(preset) {
  const next = preset === 'exact'
    ? { ...KNOWLEDGE_SEARCH_PRESETS.exact, fields: [...KNOWLEDGE_SEARCH_PRESETS.exact.fields] }
    : preset === 'custom'
      ? loadKnowledgeSearchOptions()
      : { ...KNOWLEDGE_SEARCH_PRESETS.smart, fields: [...KNOWLEDGE_SEARCH_PRESETS.smart.fields] };
  next.preset = preset;
  return saveKnowledgeSearchOptions(next);
}

function readKnowledgeSearchOptionsFromForm() {
  const preset = $('#knowledgeSearchPreset')?.value || 'smart';
  const fields = Object.entries(KNOWLEDGE_SEARCH_FIELD_IDS)
    .filter(([, id]) => $(`#${id}`)?.checked)
    .map(([field]) => field);
  return normalizeKnowledgeSearchOptions({
    preset,
    prefix: Boolean($('#knowledgeSearchPrefix')?.checked),
    fuzzy: $('#knowledgeSearchFuzzy')?.checked ? 0.2 : 0,
    strict: Boolean($('#knowledgeSearchStrict')?.checked),
    fields,
  });
}

function fillKnowledgeSearchOptionsForm(options = loadKnowledgeSearchOptions()) {
  const normalized = normalizeKnowledgeSearchOptions(options);
  if ($('#knowledgeSearchPreset')) $('#knowledgeSearchPreset').value = normalized.preset;
  if ($('#knowledgeSearchPrefix')) $('#knowledgeSearchPrefix').checked = normalized.prefix;
  if ($('#knowledgeSearchFuzzy')) $('#knowledgeSearchFuzzy').checked = normalized.fuzzy > 0;
  if ($('#knowledgeSearchStrict')) $('#knowledgeSearchStrict').checked = normalized.strict;
  Object.entries(KNOWLEDGE_SEARCH_FIELD_IDS).forEach(([field, id]) => {
    const input = $(`#${id}`);
    if (input) input.checked = normalized.fields.includes(field);
  });
  syncKnowledgeSearchCustomVisibility();
}

function syncKnowledgeSearchCustomVisibility() {
  const preset = $('#knowledgeSearchPreset')?.value || 'smart';
  const custom = $('#knowledgeSearchCustomOptions');
  if (custom) custom.hidden = preset !== 'custom';
  const disabled = preset !== 'custom';
  ['knowledgeSearchPrefix', 'knowledgeSearchFuzzy', 'knowledgeSearchStrict', ...Object.values(KNOWLEDGE_SEARCH_FIELD_IDS)].forEach(id => {
    const input = $(`#${id}`);
    if (input) input.disabled = disabled;
  });
}

function knowledgeSearchModeLabel(options = loadKnowledgeSearchOptions()) {
  const presetNames = { smart: '智能', exact: '精确', custom: '自定义' };
  const fieldNames = { title: '标题', heading: '小节', body: '正文', tags: '标签', path: '路径' };
  const fields = options.fields.length === 5
    ? '全字段'
    : options.fields.map(field => fieldNames[field] || field).join('+') || '无范围';
  return `搜索：${presetNames[options.preset] || '自定义'} · ${fields}`;
}

function renderKnowledgeSearchModeHint(options = loadKnowledgeSearchOptions()) {
  const hint = $('#knowledgeSearchModeHint');
  if (!hint) return;
  hint.textContent = knowledgeSearchModeLabel(options);
  hint.title = '打开知识库搜索设置';
  hint.hidden = false;
}

function knowledgeSearchOptionsQuery() {
  const options = loadKnowledgeSearchOptions();
  const params = new URLSearchParams();
  params.set('preset', options.preset);
  params.set('prefix', options.prefix ? '1' : '0');
  params.set('fuzzy', String(options.fuzzy));
  params.set('strict', options.strict ? '1' : '0');
  params.set('fields', options.fields.join(','));
  return params;
}

function commitKnowledgeSearchSettings({ reload = true } = {}) {
  const preset = $('#knowledgeSearchPreset')?.value || 'smart';
  const options = preset === 'custom'
    ? saveKnowledgeSearchOptions(readKnowledgeSearchOptionsFromForm())
    : applyKnowledgeSearchPreset(preset);
  fillKnowledgeSearchOptionsForm(options);
  if (reload && $('#knowledgeSearch')?.value.trim()) {
    loadDocuments().catch(error => showToast(error.message, 'error'));
  }
  return options;
}

function bindKnowledgeSearchSettingsEvents() {
  $('#knowledgeSearchModeHint')?.addEventListener('click', () => openSettings('knowledge'));
  $('#knowledgeSearchPreset')?.addEventListener('change', () => commitKnowledgeSearchSettings());
  ['knowledgeSearchPrefix', 'knowledgeSearchFuzzy', 'knowledgeSearchStrict', ...Object.values(KNOWLEDGE_SEARCH_FIELD_IDS)].forEach(id => {
    $(`#${id}`)?.addEventListener('change', () => {
      if ($('#knowledgeSearchPreset')?.value !== 'custom') $('#knowledgeSearchPreset').value = 'custom';
      commitKnowledgeSearchSettings();
    });
  });
}

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

function syncDesktopSidebar() {
  const collapsed = desktopSidebarQuery.matches && localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true';
  document.body.classList.toggle('sidebar-collapsed', collapsed);
  const toggle = $('#sidebarToggle');
  const expand = $('#sidebarExpand');
  if (toggle) {
    toggle.hidden = !desktopSidebarQuery.matches;
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.setAttribute('aria-label', collapsed ? '展开侧栏' : '收起侧栏');
    toggle.title = collapsed ? '展开侧栏' : '收起侧栏';
  }
  if (expand) expand.hidden = !desktopSidebarQuery.matches || !collapsed;
}

function toggleDesktopSidebar(forceCollapsed) {
  if (!desktopSidebarQuery.matches) return;
  const collapsed = typeof forceCollapsed === 'boolean'
    ? forceCollapsed
    : !document.body.classList.contains('sidebar-collapsed');
  localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(collapsed));
  syncDesktopSidebar();
}

function parseRoute() {
  const raw = (window.location.hash || '#agent').slice(1);
  const question = raw.indexOf('?');
  const path = question >= 0 ? raw.slice(0, question) : raw;
  const query = new URLSearchParams(question >= 0 ? raw.slice(question + 1) : '');
  const [modeValue, ...rest] = path.split('/');
  let id = '';
  try { id = decodeURIComponent(rest.join('/')); } catch { id = rest.join('/'); }
  const legacyTodos = modeValue === 'knowledge' && query.get('view') === 'todos' && !id;
  const mode = legacyTodos || modeValue === 'todos'
    ? 'todos'
    : (modeValue === 'knowledge' || modeValue === 'memory' ? modeValue : 'agent');
  return {
    mode,
    id: mode === 'todos' ? '' : id,
    block: query.get('block') || '',
    offset: Number(query.get('offset')) || 0,
    knowledgeBase: query.get('base') || '',
    folderPath: query.get('folder') || '',
    legacyTodos,
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
  document.querySelectorAll('.topbar-mode-switch [data-mode]').forEach(button => {
    button.classList.toggle('active', button.dataset.mode === mode);
    button.setAttribute('aria-current', button.dataset.mode === mode ? 'page' : 'false');
  });
  document.querySelectorAll('[data-sidebar-mode]').forEach(panel => { panel.hidden = panel.dataset.sidebarMode !== mode; });
  document.querySelectorAll('[data-main-mode]').forEach(panel => { panel.hidden = panel.dataset.mainMode !== mode; });
  syncKnowledgeBrandActions();
  const brandHome = document.querySelector('.brand-home');
  if (brandHome) {
    brandHome.setAttribute('href', mode === 'knowledge' ? '#knowledge' : mode === 'memory' ? '#memory' : mode === 'todos' ? '#todos' : '#agent');
  }
  if (mode === 'agent') {
    applyAgentTopbar(state.activeSession);
  } else {
    $('#topbarTitle').textContent = mode === 'memory' ? 'Memory' : mode === 'todos' ? '待办' : '知识库';
    if (mode === 'memory') {
      const saved = (state.memories?.items || []).length;
      const pending = (state.memories?.proposals || []).length;
      $('#topbarSubtitle').textContent = pending ? `${saved} 条记忆 · ${pending} 条待确认` : `${saved} 条记忆`;
    } else if (mode === 'todos') {
      $('#topbarSubtitle').textContent = getTodoSubtitle();
    } else if (isKnowledgeRoot()) {
      $('#topbarSubtitle').textContent = `${state.knowledgeBases.length} 个知识库`;
    } else {
      $('#topbarSubtitle').textContent = state.activeDocument?.title || `${state.knowledgeTotal} 条知识`;
    }
  }
  closeMobileSidebar();
}

async function applyRoute() {
  const route = parseRoute();
  if (route.legacyTodos) history.replaceState(null, '', '#todos');
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
  } else if (route.mode === 'memory') {
    await loadMemoriesPanel();
  } else if (route.mode === 'todos') {
    showEmptyDocument();
    await loadTodos();
    showTodoView();
    if (serial === state.routeSerial) $('#topbarSubtitle').textContent = getTodoSubtitle();
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
            <small>${escHtml(formatSessionMeta(session))}</small>
          </button>
          <span class="session-actions">
            <button class="session-action" type="button" data-session-rename="${escHtml(session.id)}" title="重命名" aria-label="重命名 ${escHtml(session.title || '会话')}">✎</button>
            <button class="session-action" type="button" data-session-archive="${escHtml(session.id)}" title="归档" aria-label="归档 ${escHtml(session.title || '会话')}">⌁</button>
          </span>
        </div>`).join('')}
    </section>`).join('');
}

async function loadAgentStatus() {
  try {
    const response = await apiFetch('/api/agent/status');
    const data = await response.json().catch(() => ({}));
    state.agentStatus = {
      configured: Boolean(data.configured),
      provider: data.provider || '',
      model: data.model || '',
    };
  } catch {
    state.agentStatus = { configured: false, provider: '', model: '' };
  }
  applyAgentStatus();
}

function idleAgentLabel() {
  if (state.agentStatus?.configured && state.agentStatus.model) {
    return `已就绪 · ${state.agentStatus.model}`;
  }
  if (state.agentStatus && state.agentStatus.configured === false) {
    return '未配置模型';
  }
  return 'Agent 已就绪';
}

function agentSetupHintHtml() {
  const hidden = state.agentStatus?.configured !== false ? ' hidden' : '';
  return `<p class="agent-setup-hint"${hidden}>尚未配置模型。请先在设置中填写 API Key，然后回到这里发送消息。<button type="button" data-open-settings>打开设置</button></p>`;
}

function applyAgentStatus() {
  document.querySelectorAll('.agent-setup-hint').forEach(hint => {
    hint.hidden = state.agentStatus?.configured !== false;
  });
  const composer = $('#agentComposerSettings');
  if (composer) composer.textContent = idleAgentLabel();
  if (!ACTIVE_RUN_STATES.has(state.runStatus)) setRunStatus(state.runStatus || '');
}

const DIRECT_AGENT_MODELS = [
  { id: 'deepseek-v4-flash', name: 'DeepSeek Flash' },
  { id: 'deepseek-v4-pro', name: 'DeepSeek Pro' },
  { id: 'kimi-k3', name: 'Kimi K3' },
  { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code' },
  { id: 'kimi-k2.6', name: 'Kimi K2.6' },
];

const MEMORY_SETTING_FIELDS = Object.freeze([
  { key: 'memoryRefreshMaxRounds', min: 1, fallback: 4 },
  { key: 'memoryRefreshMaxProposals', min: 1, fallback: 5 },
  { key: 'memoryRefreshSessionLimit', min: 1, fallback: 8 },
  { key: 'memoryRefreshMessageLimit', min: 1, fallback: 12 },
  { key: 'memoryRefreshMessageChars', min: 1, fallback: 8000 },
  { key: 'memoryRefreshSessionBlockChars', min: 1, fallback: 8000 },
  { key: 'memoryRefreshTotalChars', min: 1, fallback: 40000 },
  { key: 'memoryTitleMaxChars', min: 1, fallback: 40 },
  { key: 'memoryContentMaxCharsL2', min: 1, fallback: 240 },
  { key: 'memoryContentMaxCharsL3', min: 1, fallback: 1200 },
  { key: 'memoryContextMaxL2', min: 1, fallback: 20 },
  { key: 'memoryContextMaxL3', min: 1, fallback: 20 },
]);

const AGENT_SETTING_FIELDS = Object.freeze([
  { key: 'agentDelegateMaxRounds', min: 1, fallback: 8 },
  { key: 'agentMaxToolFailures', min: 1, fallback: 3 },
  { key: 'agentReadConcurrency', min: 1, fallback: 4 },
  { key: 'agentRepeatMutationLimit', min: 1, fallback: 3 },
  { key: 'agentWebFetchMaxKb', min: 1, fallback: 512 },
  { key: 'agentWebFetchTimeoutSec', min: 1, fallback: 15 },
  { key: 'agentKnowledgeSearchLimit', min: 1, fallback: 20 },
  { key: 'agentKnowledgeSearchMaxLimit', min: 1, fallback: 60 },
  { key: 'agentKnowledgeListLimit', min: 1, fallback: 40 },
  { key: 'agentKnowledgeListMaxLimit', min: 1, fallback: 100 },
  { key: 'agentMemorySearchLimit', min: 1, fallback: 20 },
  { key: 'agentMemorySearchMaxLimit', min: 1, fallback: 40 },
]);

function fillMemorySettingsForm(settings = {}) {
  for (const field of MEMORY_SETTING_FIELDS) {
    const input = $(`#${field.key}`);
    if (!input) continue;
    const value = Number(settings[field.key]);
    input.value = Number.isFinite(value) ? Math.max(field.min, Math.round(value)) : field.fallback;
  }
}

function fillAgentSettingsForm(settings = {}) {
  for (const field of AGENT_SETTING_FIELDS) {
    const input = $(`#${field.key}`);
    if (!input) continue;
    const value = Number(settings[field.key]);
    input.value = Number.isFinite(value) ? Math.max(field.min, Math.round(value)) : field.fallback;
  }
}

function readMemorySettingsFromForm(current = {}) {
  const values = {};
  for (const field of MEMORY_SETTING_FIELDS) {
    const input = $(`#${field.key}`);
    const parsed = Number(input?.value);
    const currentValue = Number(current[field.key]);
    values[field.key] = Number.isInteger(parsed) && parsed >= field.min
      ? parsed
      : (Number.isInteger(currentValue) ? currentValue : field.fallback);
  }
  return values;
}

function readAgentSettingsFromForm(current = {}) {
  const values = {};
  for (const field of AGENT_SETTING_FIELDS) {
    const input = $(`#${field.key}`);
    const parsed = Number(input?.value);
    const currentValue = Number(current[field.key]);
    values[field.key] = Number.isInteger(parsed) && parsed >= field.min
      ? parsed
      : (Number.isInteger(currentValue) ? currentValue : field.fallback);
  }
  return values;
}

function keyPlaceholder(configured, fallback) {
  return configured ? '已配置；留空保持不变' : fallback;
}

function populateAgentModelSelect(models, selected) {
  const select = $('#agentModelSelect');
  const list = DIRECT_AGENT_MODELS.map(item => ({ ...item }));
  (models || []).forEach(model => {
    if (!model?.id || list.some(item => item.id === model.id)) return;
    list.push({ id: model.id, name: model.name || model.id });
  });
  if (selected && !list.some(item => item.id === selected)) {
    list.unshift({ id: selected, name: selected });
  }
  select.innerHTML = list.map(item => `<option value="${escHtml(item.id)}">${escHtml(item.name)}</option>`).join('');
  select.value = selected || 'deepseek-v4-flash';
}

async function loadAgentSettingsForm() {
  $('#saveAgentSettings').disabled = true;
  try {
    const [settingsResponse, modelsResponse] = await Promise.all([
      apiFetch('/api/ai/settings'),
      apiFetch('/api/ai/models'),
    ]);
    const settings = await settingsResponse.json().catch(() => ({}));
    const modelsData = await modelsResponse.json().catch(() => ({}));
    if (!settingsResponse.ok) throw new Error(settings.error || '模型设置加载失败');
    state.aiSettings = settings;
    $('#agentDeepseekKey').value = '';
    $('#agentMoonshotKey').value = '';
    $('#agentOpenrouterKey').value = '';
    $('#agentTavilyApiKey').value = '';
    $('#agentPerplexityKey').value = '';
    $('#agentDeepseekKey').placeholder = keyPlaceholder(settings.apiKeyConfigured, 'sk-...');
    $('#agentMoonshotKey').placeholder = keyPlaceholder(settings.moonshotApiKeyConfigured, 'sk-...');
    $('#agentOpenrouterKey').placeholder = keyPlaceholder(settings.openrouterApiKeyConfigured, 'sk-or-...');
    $('#agentTavilyApiKey').placeholder = keyPlaceholder(settings.tavilyApiKeyConfigured, 'tvly-...');
    $('#agentPerplexityKey').placeholder = keyPlaceholder(settings.perplexityApiKeyConfigured, 'pplx-...');
    $('#agentSeedreamKey').value = '';
    $('#agentSeedreamKey').placeholder = keyPlaceholder(settings.seedreamApiKeyConfigured, 'ARK API Key');
    const seedreamModels = ['doubao-seedream-5-0-260128', 'doubao-seedream-4-5-251128', 'doubao-seedream-4-0-250828'];
    $('#agentSeedreamModel').value = seedreamModels.includes(settings.seedreamModel)
      ? settings.seedreamModel
      : 'doubao-seedream-5-0-260128';
    $('#agentSeedreamSize').value = settings.seedreamSize || '2K';
    $('#agentSeedreamWatermark').checked = settings.seedreamWatermark !== false;
    populateAgentModelSelect(modelsResponse.ok ? modelsData.models : [], settings.model);
    const rounds = Number(settings.agentMaxRounds);
    $('#agentMaxRounds').value = Number.isFinite(rounds) ? Math.max(4, Math.round(rounds)) : 12;
    const fileReadMb = Number(settings.agentFileReadMaxMb);
    $('#agentFileReadMaxMb').value = Number.isFinite(fileReadMb) ? Math.max(1, Math.round(fileReadMb)) : 4;
    fillMemorySettingsForm(settings);
    fillAgentSettingsForm(settings);
    $('#agentReasoningMode').value = ['default', 'disabled', 'effort'].includes(settings.reasoningMode) ? settings.reasoningMode : 'effort';
    $('#agentThinkingMode').value = settings.thinkingMode === 'disabled' ? 'disabled' : 'enabled';
    $('#agentReasoningEffort').value = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(settings.reasoningEffort)
      ? settings.reasoningEffort
      : 'high';
    $('#agentOpenRouterZdr').checked = settings.openrouterZdrEnabled !== false;
    $('#agentWebSearchToggle').checked = Boolean(settings.webSearchEnabled);
    $('#agentWebSearchDepth').value = settings.webSearchDepth === 'advanced' ? 'advanced' : 'basic';
    $('#agentKimiWebSearchToggle').checked = Boolean(settings.kimiWebSearchEnabled);
    $('#agentWestockToggle').checked = settings.skills?.westock?.enabled !== false;
    $('#agentPerplexityToggle').checked = settings.skills?.perplexity?.enabled !== false;
    await loadComputerPolicyForm();
    $('#saveAgentSettings').disabled = false;
  } catch (error) {
    populateAgentModelSelect([], state.aiSettings?.model || 'deepseek-v4-flash');
    showToast(error.message || '模型设置加载失败', 'error');
  }
}

function setSettingsPanel(panel) {
  const allowed = ['appearance', 'sessions', 'model', 'memory', 'network', 'image', 'skills', 'knowledge', 'data', 'computer', 'account'];
  let next = allowed.includes(panel) ? panel : 'appearance';
  if (next === 'computer' && state.user?.role !== 'admin') next = 'appearance';
  state.settingsPanel = next;
  document.querySelectorAll('[data-settings-nav]').forEach(button => {
    const active = button.dataset.settingsNav === next;
    button.classList.toggle('active', active);
    button.setAttribute('aria-current', active ? 'page' : 'false');
  });
  document.querySelectorAll('[data-settings-panel]').forEach(section => {
    section.hidden = section.dataset.settingsPanel !== next;
  });
  const saveButton = $('#saveAgentSettings');
  if (saveButton) saveButton.hidden = next === 'account' || next === 'knowledge' || next === 'data';
  if (next === 'sessions') loadArchivedSessions().catch(error => showToast(error.message, 'error'));
  if (next === 'account') fillAccountSettings().catch(error => showToast(error.message, 'error'));
  if (next === 'knowledge') fillKnowledgeSearchOptionsForm();
}

async function openSettings(panel = 'appearance') {
  $('#accountMenu').hidden = true;
  $('#accountButton').setAttribute('aria-expanded', 'false');
  setSettingsPanel(panel);
  $('#settingsDialog').showModal();
  await loadAgentSettingsForm();
}

function settingsSavePayload() {
  const current = state.aiSettings || {};
  const payload = { ...current };
  ['apiKeyConfigured', 'moonshotApiKeyConfigured', 'openrouterApiKeyConfigured', 'tavilyApiKeyConfigured', 'perplexityApiKeyConfigured', 'seedreamApiKeyConfigured'].forEach(key => {
    delete payload[key];
  });
  payload.apiKey = $('#agentDeepseekKey').value.trim();
  payload.moonshotApiKey = $('#agentMoonshotKey').value.trim();
  payload.openrouterApiKey = $('#agentOpenrouterKey').value.trim();
  payload.tavilyApiKey = $('#agentTavilyApiKey').value.trim();
  payload.perplexityApiKey = $('#agentPerplexityKey').value.trim();
  payload.seedreamApiKey = $('#agentSeedreamKey').value.trim();
  payload.seedreamModel = $('#agentSeedreamModel').value || current.seedreamModel || 'doubao-seedream-5-0-260128';
  payload.seedreamSize = $('#agentSeedreamSize').value.trim() || current.seedreamSize || '2K';
  payload.seedreamWatermark = $('#agentSeedreamWatermark').checked;
  payload.model = $('#agentModelSelect').value || current.model || 'deepseek-v4-flash';
  payload.reasoningMode = $('#agentReasoningMode').value || current.reasoningMode || 'effort';
  payload.thinkingMode = $('#agentThinkingMode').value || current.thinkingMode || 'enabled';
  payload.reasoningEffort = $('#agentReasoningEffort').value || current.reasoningEffort || 'high';
  payload.openrouterZdrEnabled = $('#agentOpenRouterZdr').checked;
  payload.webSearchEnabled = $('#agentWebSearchToggle').checked;
  payload.webSearchDepth = $('#agentWebSearchDepth').value === 'advanced' ? 'advanced' : 'basic';
  payload.kimiWebSearchEnabled = $('#agentKimiWebSearchToggle').checked;
  payload.skills = {
    westock: { enabled: $('#agentWestockToggle').checked },
    perplexity: { enabled: $('#agentPerplexityToggle').checked },
  };
  const rounds = Number($('#agentMaxRounds').value);
  payload.agentMaxRounds = Number.isInteger(rounds) && rounds >= 4
    ? rounds
    : (Number.isInteger(Number(current.agentMaxRounds)) ? Number(current.agentMaxRounds) : 12);
  const fileReadMb = Number($('#agentFileReadMaxMb').value);
  payload.agentFileReadMaxMb = Number.isInteger(fileReadMb) && fileReadMb >= 1
    ? fileReadMb
    : (Number.isInteger(Number(current.agentFileReadMaxMb)) ? Number(current.agentFileReadMaxMb) : 4);
  Object.assign(payload, readMemorySettingsFromForm(current));
  Object.assign(payload, readAgentSettingsFromForm(current));
  return payload;
}

async function saveAgentSettings() {
  if (state.settingsPanel === 'account') return;
  if (!state.aiSettings) {
    showToast('模型设置尚未加载，请关闭后重试', 'error');
    return;
  }
  const button = $('#saveAgentSettings');
  button.disabled = true;
  try {
    const response = await apiFetch('/api/ai/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settingsSavePayload()),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || '模型设置保存失败');
    state.aiSettings = data;
    await saveComputerPolicy();
    await loadAgentStatus();
    await loadAgentSettingsForm();
    showToast('设置已保存', 'success');
  } catch (error) {
    showToast(error.message || '模型设置保存失败', 'error');
    button.disabled = false;
  }
}

function isAdminUser() {
  return state.user?.role === 'admin';
}

function syncComputerSettingsVisibility() {
  const nav = document.querySelector('[data-settings-nav="computer"]');
  const show = isAdminUser();
  if (nav) nav.hidden = !show;
  if (!show && state.settingsPanel === 'computer') setSettingsPanel('appearance');
}

function renderComputerAllowlist() {
  const root = $('#computerAllowlist');
  if (!root) return;
  const dirs = state.computerPolicy?.allowedDirectories || [];
  if (!dirs.length) {
    root.innerHTML = '<p class="empty-list">还没有目录。添加后，Agent 只能在这些路径里读写文件和运行脚本。</p>';
    return;
  }
  root.innerHTML = dirs.map((dir, index) => `
    <div class="computer-allowlist-row">
      <code title="${escHtml(dir)}">${escHtml(dir)}</code>
      <button type="button" class="danger-action compact" data-allowlist-remove="${index}">移除</button>
    </div>
  `).join('');
}

async function loadComputerPolicyForm() {
  syncComputerSettingsVisibility();
  if (!isAdminUser()) return;
  const response = await apiFetch('/api/admin/agent-policy');
  if (response.status === 403) {
    const nav = document.querySelector('[data-settings-nav="computer"]');
    if (nav) nav.hidden = true;
    if (state.settingsPanel === 'computer') setSettingsPanel('appearance');
    return;
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || '电脑策略加载失败');
  state.computerPolicy = {
    computerToolsEnabled: data.computerToolsEnabled !== false,
    allowedDirectories: Array.isArray(data.allowedDirectories) ? data.allowedDirectories.map(String) : [],
  };
  $('#computerToolsToggle').checked = state.computerPolicy.computerToolsEnabled;
  renderComputerAllowlist();
}

function addComputerAllowlistEntry() {
  const input = $('#computerAllowlistInput');
  const value = String(input?.value || '').trim();
  if (!value) return;
  if (!state.computerPolicy) state.computerPolicy = { computerToolsEnabled: true, allowedDirectories: [] };
  const list = state.computerPolicy.allowedDirectories;
  if (!list.includes(value)) list.push(value);
  input.value = '';
  renderComputerAllowlist();
}

async function saveComputerPolicy() {
  if (!isAdminUser()) return;
  const response = await apiFetch('/api/admin/agent-policy', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      computerToolsEnabled: $('#computerToolsToggle')?.checked === true,
      allowedDirectories: state.computerPolicy?.allowedDirectories || [],
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || '电脑策略保存失败');
  state.computerPolicy = {
    computerToolsEnabled: data.computerToolsEnabled === true,
    allowedDirectories: Array.isArray(data.allowedDirectories) ? data.allowedDirectories.map(String) : [],
  };
  $('#computerToolsToggle').checked = state.computerPolicy.computerToolsEnabled;
  renderComputerAllowlist();
}

function memoryLayerLabel(layer) {
  if (layer === 'L3') return '流程';
  if (layer === 'L2') return '事实';
  return layer || '记忆';
}

function memoryBodyHtml(content) {
  const text = String(content || '').trim();
  if (!text) return '<p class="memory-empty">没有正文</p>';
  return `<div class="memory-body">${escHtml(text)}</div>`;
}

function renderMemoryItems(items) {
  const root = $('#agentMemoryItems');
  if (!root) return;
  const visible = state.memoryLayer ? items.filter(item => item.layer === state.memoryLayer) : items;
  if (!visible.length) {
    root.innerHTML = `<p class="memory-empty">${items.length ? '这一层还没有记忆' : '还没有长期记忆'}</p>`;
    return;
  }
  root.innerHTML = visible.map(item => `
    <article class="memory-item" data-memory-item="${escHtml(item.id)}">
      <header>
        <span class="memory-layer">${escHtml(memoryLayerLabel(item.layer))}</span>
        <h4>${escHtml(item.title || '未命名记忆')}</h4>
      </header>
      ${memoryBodyHtml(item.content)}
      <div class="card-actions">
        <button class="danger-action compact" type="button" data-memory-archive="${escHtml(item.id)}">删除</button>
      </div>
    </article>`).join('');
}

function updateMemoryPendingBadge(pendingCount) {
  const count = Math.max(0, Number(pendingCount) || 0);
  const badge = $('#memoryPendingBadge');
  const memoryButton = document.querySelector('.topbar-mode-switch [data-mode="memory"]');
  if (badge) {
    if (count > 0) {
      badge.hidden = false;
      badge.removeAttribute('aria-hidden');
      badge.textContent = count > 9 ? '9+' : String(count);
      badge.setAttribute('aria-label', `${count} 条记忆待确认`);
    } else {
      badge.hidden = true;
      badge.setAttribute('aria-hidden', 'true');
      badge.textContent = '';
      badge.removeAttribute('aria-label');
    }
  }
  memoryButton?.classList.toggle('has-pending', count > 0);
  const sidebarCount = $('#memorySidebarCount');
  if (sidebarCount) sidebarCount.classList.toggle('is-pending', count > 0);
}

function renderMemorySidebar() {
  const list = $('#memorySidebarList');
  const count = $('#memorySidebarCount');
  const items = state.memories?.items || [];
  const proposals = state.memories?.proposals || [];
  const visible = state.memoryLayer ? items.filter(item => item.layer === state.memoryLayer) : items;
  if (count) {
    count.textContent = proposals.length
      ? `${items.length} 条已保存 · ${proposals.length} 条待确认`
      : `${items.length} 条已保存`;
  }
  updateMemoryPendingBadge(proposals.length);
  document.querySelectorAll('[data-memory-layer]').forEach(button => {
    const active = (button.dataset.memoryLayer || '') === (state.memoryLayer || '');
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
  if (!list) return;
  if (!visible.length) {
    list.innerHTML = `<p class="empty-list">${items.length ? '这一层还没有记忆' : '还没有长期记忆'}</p>`;
    return;
  }
  list.innerHTML = visible.map(item => `
    <button class="session-select" type="button">
      <strong>${escHtml(item.title || '未命名记忆')}</strong>
      <small>${escHtml(memoryLayerLabel(item.layer))} · ${escHtml((item.content || '').replace(/\s+/g, ' ').trim().slice(0, 48) || '没有正文')}</small>
    </button>`).join('');
}

function updateMemorySubtitle() {
  if (state.mode !== 'memory') return;
  const saved = (state.memories?.items || []).length;
  const pending = (state.memories?.proposals || []).length;
  $('#topbarSubtitle').textContent = pending ? `${saved} 条记忆 · ${pending} 条待确认` : `${saved} 条记忆`;
}

function renderMemoryWorkspace() {
  const items = state.memories?.items || [];
  const proposals = state.memories?.proposals || [];
  renderMemoryProposalList(proposals);
  renderMemoryItems(items);
  renderMemorySidebar();
  updateMemorySubtitle();
}

function renderMemoryProposalList(proposals) {
  const root = $('#agentMemoryProposals');
  if (!root) return;
  if (!proposals.length) {
    root.innerHTML = '';
    return;
  }
  root.innerHTML = proposals.map(item => `
    <article class="memory-proposal" data-memory-proposal="${escHtml(item.id)}">
      <header>
        <span class="memory-layer">待确认</span>
        <h4>${escHtml(item.title || '记忆草稿')}</h4>
      </header>
      ${memoryBodyHtml(item.content)}
      <div class="card-actions">
        <button class="secondary-action" type="button" data-memory-dismiss="${escHtml(item.id)}">忽略</button>
        <button class="primary-action compact" type="button" data-memory-approve="${escHtml(item.id)}">保存</button>
      </div>
    </article>`).join('');
}

function setMemoryRefreshBusy(busy, message = '') {
  const button = $('#refreshAgentMemory');
  const status = $('#agentMemoryStatus');
  if (button) button.disabled = busy;
  if (!status) return;
  status.hidden = !message;
  status.textContent = message;
}

async function refreshMemoryPendingCount() {
  try {
    const response = await apiFetch('/api/agent/memories');
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return;
    const next = { items: data.items || [], proposals: data.proposals || [] };
    state.memories = next;
    updateMemoryPendingBadge(next.proposals.length);
    if (state.mode === 'memory') renderMemoryWorkspace();
  } catch {}
}

async function loadMemoriesPanel() {
  try {
    const response = await apiFetch('/api/agent/memories');
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || '记忆加载失败');
    state.memories = { items: data.items || [], proposals: data.proposals || [] };
    renderMemoryWorkspace();
    return state.memories;
  } catch (error) {
    state.memories = { items: [], proposals: [] };
    renderMemoryWorkspace();
    const root = $('#agentMemoryItems');
    if (root) root.innerHTML = `<p class="memory-empty">${escHtml(error.message || '记忆加载失败')}</p>`;
    return state.memories;
  }
}

function subscribeMemoryRefresh(runId) {
  state.memoryRefreshSource?.close();
  const source = new EventSource(`/api/agent/runs/${encodeURIComponent(runId)}/events`);
  state.memoryRefreshSource = source;
  const finish = async (message, type = 'success') => {
    if (state.memoryRefreshSource === source) {
      source.close();
      state.memoryRefreshSource = null;
    }
    const data = await loadMemoriesPanel();
    setMemoryRefreshBusy(false, '');
    const pending = (data.proposals || []).length;
    showToast(message || (pending ? '已提出记忆草稿，请确认' : '暂无新记忆'), type);
  };
  source.addEventListener('memory.proposed', () => {
    loadMemoriesPanel().catch(() => {});
  });
  source.addEventListener('run.completed', () => {
    finish();
  });
  source.addEventListener('run.failed', raw => {
    let error = '记忆更新失败';
    try { error = JSON.parse(raw.data)?.payload?.error || error; } catch { /* keep default */ }
    finish(error === 'cancelled' ? '记忆更新已停止' : `记忆更新失败：${error}`, 'error');
  });
  source.onerror = () => {
    if (state.memoryRefreshSource === source) setMemoryRefreshBusy(true, '正在根据近期对话整理…');
  };
}

async function refreshAgentMemory() {
  if (state.agentStatus?.configured === false) {
    showToast('请先配置模型', 'error');
    return;
  }
  setMemoryRefreshBusy(true, '正在根据近期对话整理…');
  try {
    const response = await apiFetch('/api/agent/memory/refresh', { method: 'POST' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || '记忆更新失败');
    subscribeMemoryRefresh(data.runId);
  } catch (error) {
    setMemoryRefreshBusy(false, '');
    showToast(error.message || '记忆更新失败', 'error');
  }
}

async function handleMemoryProposalAction(id, action) {
  if (!id) return;
  const path = action === 'approve' ? 'approve' : 'dismiss';
  const response = await apiFetch(`/api/agent/memory-proposals/${encodeURIComponent(id)}/${path}`, { method: 'POST' });
  if (!response.ok) {
    showToast(action === 'approve' ? '长期记忆保存失败' : '无法忽略这项记忆草稿', 'error');
    return;
  }
  document.querySelector(`[data-memory-card="${CSS.escape(id)}"]`)?.remove();
  if (state.mode === 'memory') await loadMemoriesPanel();
  else await refreshMemoryPendingCount();
  showToast(action === 'approve' ? '长期记忆已保存' : '已忽略这项记忆草稿', 'success');
}

async function archiveMemoryItem(id) {
  if (!id) return;
  const item = (state.memories?.items || []).find(entry => entry.id === id);
  const confirmed = await confirmAction({
    title: '删除长期记忆',
    message: `“${item?.title || '未命名记忆'}”将从 Memory 列表隐藏，之后也不会再注入 Agent。`,
    confirmText: '删除',
  });
  if (!confirmed) return;
  const response = await apiFetch(`/api/agent/memories/${encodeURIComponent(id)}`, { method: 'DELETE' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    showToast(data.error || '长期记忆删除失败', 'error');
    return;
  }
  await loadMemoriesPanel();
  showToast('长期记忆已删除', 'success');
}

async function loadSessions() {
  const response = await apiFetch('/api/agent/sessions');
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || '会话加载失败');
  state.sessions = data.sessions || [];
  if (state.activeSession?.id) {
    const summary = state.sessions.find(item => item.id === state.activeSession.id);
    if (summary) {
      state.activeSession.messageCount = summary.messageCount;
      state.activeSession.updatedAt = summary.updatedAt;
    }
  }
  renderSessions();
  if (state.mode === 'agent') applyAgentTopbar(state.activeSession);
}

function stopLiveTrace() {
  state.eventSource?.close();
  state.eventSource = null;
  for (const source of state.childEventSources.values()) source.close();
  state.childEventSources.clear();
  state.childRunEventKeys.clear();
  state.runId = '';
  state.activeChildRunId = '';
  state.runEventKeys = new Set();
  state.runImages = [];
}

function delegateTraceHost(childRunId) {
  if (!childRunId) return null;
  return document.querySelector(`[data-delegate-run-id="${CSS.escape(childRunId)}"]`);
}

function upsertDelegateTrace(child, parentRunId, { live = false } = {}) {
  if (!child?.id || !parentRunId) return null;
  const parent = runTraceHost(parentRunId) || upsertRunTrace({ id: parentRunId, trace: [] }, { live });
  if (!parent) return null;
  let host = parent.querySelector('.delegate-traces');
  if (!host) {
    host = document.createElement('div');
    host.className = 'delegate-traces';
    parent.querySelector('.trace-events')?.after(host);
  }
  let details = delegateTraceHost(child.id);
  if (!details) {
    details = document.createElement('details');
    details.className = 'execution-trace execution-trace-delegate';
    details.dataset.delegateRunId = child.id;
    details.innerHTML = `
      <summary><span class="trace-state-dot"></span><span class="trace-summary">子任务</span></summary>
      <div class="trace-events"></div>`;
    host.append(details);
  }
  if (live) details.open = true;
  const title = child.delegateTitle || '委派任务';
  details.dataset.delegateTitle = title;
  const lines = Array.isArray(child.trace) ? child.trace.map(item => String(item || '').trim()).filter(Boolean) : [];
  const eventsEl = details.querySelector('.trace-events');
  const summaryEl = details.querySelector('.trace-summary');
  summaryEl.textContent = lines.length ? `子任务「${title}」 · ${lines.at(-1)}` : `子任务「${title}」`;
  eventsEl.innerHTML = lines.map(text => `<div class="trace-event">${escHtml(text)}</div>`).join('');
  eventsEl.scrollTop = eventsEl.scrollHeight;
  return details;
}

function delegateTrace(text, childRunId) {
  if (!text || !childRunId) return;
  const details = delegateTraceHost(childRunId)
    || upsertDelegateTrace({ id: childRunId, delegateTitle: state.delegateTitle || '委派任务', trace: [] }, state.runId, { live: true });
  if (!details) return;
  const eventsEl = details.querySelector('.trace-events');
  const summaryEl = details.querySelector('.trace-summary');
  const title = state.delegateTitle || details.dataset.delegateTitle || '委派任务';
  const last = eventsEl.lastElementChild;
  if (last && last.textContent === text) {
    summaryEl.textContent = `子任务「${title}」 · ${text}`;
    return;
  }
  const event = document.createElement('div');
  event.className = 'trace-event';
  event.textContent = text;
  eventsEl.append(event);
  eventsEl.scrollTop = eventsEl.scrollHeight;
  summaryEl.textContent = `子任务「${title}」 · ${text}`;
}

function unsubscribeDelegateRun(childRunId) {
  const source = state.childEventSources.get(childRunId);
  if (source) {
    source.close();
    state.childEventSources.delete(childRunId);
  }
  state.childRunEventKeys.delete(childRunId);
  if (state.activeChildRunId === childRunId) state.activeChildRunId = '';
}

function handleDelegateRunEvent(childRunId, event) {
  let keys = state.childRunEventKeys.get(childRunId);
  if (!keys) {
    keys = new Set();
    state.childRunEventKeys.set(childRunId, keys);
  }
  const key = runEventKey(event);
  if (keys.has(key)) return;
  keys.add(key);
  const payload = event.payload || {};
  if (event.type === 'run.started') delegateTrace('正在分析目标', childRunId);
  if (event.type === 'assistant.delta' && payload.text) delegateTrace('正在组织回答', childRunId);
  if (event.type === 'tool.proposed') {
    delegateTrace(`准备使用 ${payload.calls?.map(call => call.name).join('、') || '工具'}`, childRunId);
  }
  if (event.type === 'tool.started') {
    delegateTrace(`正在执行 ${payload.name || payload.call?.name || '工具'}`, childRunId);
  }
  if (event.type === 'tool.completed') {
    delegateTrace(payload.result?.summary || payload.call?.name || '工具执行完成', childRunId);
  }
  if (event.type === 'checkpoint.updated') delegateTrace('已更新工作进度', childRunId);
  if (event.type === 'user_input.required') {
    delegateTrace(payload.question ? `等待你的回答：${payload.question}` : '等待你的回答', childRunId);
  }
  if (event.type === 'approval.required') delegateTrace('等待你的确认', childRunId);
  if (event.type === 'client_tool.requested') delegateTrace('等待浏览器返回结果', childRunId);
  if (event.type === 'run.completed') delegateTrace('运行完成', childRunId);
  if (event.type === 'run.failed') {
    const message = payload.error === 'cancelled' ? '运行已停止。' : `运行未完成：${payload.error || '未知错误'}`;
    delegateTrace(message, childRunId);
  }
}

function subscribeDelegateRun(childRunId, delegateTitle = '', parentRunId = '') {
  if (!childRunId || state.childEventSources.has(childRunId)) return;
  const parentId = parentRunId || state.runId;
  state.activeChildRunId = childRunId;
  if (delegateTitle) state.delegateTitle = delegateTitle;
  upsertDelegateTrace({ id: childRunId, delegateTitle: delegateTitle || '委派任务', trace: [] }, parentId, { live: true });
  const source = new EventSource(`/api/agent/runs/${encodeURIComponent(childRunId)}/events`);
  state.childEventSources.set(childRunId, source);
  [
    'run.started', 'assistant.delta', 'tool.proposed', 'approval.required', 'tool.started',
    'tool.completed', 'checkpoint.updated', 'client_tool.requested', 'user_input.required',
    'run.completed', 'run.failed',
  ].forEach(type => source.addEventListener(type, raw => {
    try { handleDelegateRunEvent(childRunId, JSON.parse(raw.data)); } catch { /* ignore */ }
  }));
  source.onerror = () => {
    if (state.childEventSources.get(childRunId) === source && ACTIVE_RUN_STATES.has(state.runStatus)) {
      delegateTrace('连接暂时中断，正在自动重连', childRunId);
    }
  };
}

function showEmptySession() {
  state.activeSession = null;
  stopLiveTrace();
  setRunStatus('');
  applyAgentTopbar(null);
  $('#agentMessageList').innerHTML = `
    <div class="agent-empty-state">
      <span class="empty-mark" aria-hidden="true">✦</span>
      <h1>今天想一起完成什么？</h1>
      <p>用 @知识库 或 @日期 带上材料，再描述你想完成的事。</p>
      ${agentSetupHintHtml()}
      <div class="starter-prompts">
        <button type="button" data-starter="@开发 总结最近的项目记录和下一步">总结项目记录</button>
        <button type="button" data-starter="@开发 根据这些材料规划今天最重要的三件事">规划今天</button>
      </div>
    </div>`;
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
  const runs = Array.isArray(session.runs) ? session.runs : [];
  if (!deduped.length && !runs.length) {
    showEmptySessionContent();
    scrollMessagesToBottom();
    return;
  }
  const liveId = session.latestRun && ACTIVE_RUN_STATES.has(session.latestRun.status)
    ? session.latestRun.id
    : '';
  let runIndex = 0;
  deduped.forEach(message => {
    addMessage(message.role, message.content);
    if (message.role === 'user' && runIndex < runs.length) {
      const run = runs[runIndex];
      upsertRunTrace(run.id === liveId ? { id: run.id, trace: [] } : run, { live: run.id === liveId });
      runIndex += 1;
    }
  });
  while (runIndex < runs.length) {
    const run = runs[runIndex];
    upsertRunTrace(run.id === liveId ? { id: run.id, trace: [] } : run, { live: run.id === liveId });
    runIndex += 1;
  }
  scrollMessagesToBottom();
}

function showEmptySessionContent() {
  $('#agentMessageList').innerHTML = `
    <div class="agent-empty-state">
      <span class="empty-mark" aria-hidden="true">✦</span>
      <h1>从一个具体目标开始</h1>
      <p>用 @知识库 或 @日期 带上材料，再描述希望得到的结果。</p>
      ${agentSetupHintHtml()}
    </div>`;
}

async function openSession(id, serial = state.routeSerial) {
  if (state.activeSession?.id === id && state.activeSession.messages) {
    applyAgentTopbar(state.activeSession);
    renderSessions();
    return;
  }
  stopLiveTrace();
  const response = await apiFetch(`/api/agent/sessions/${encodeURIComponent(id)}`);
  const data = await response.json().catch(() => ({}));
  if (serial !== state.routeSerial) return;
  if (!response.ok) {
    showToast(data.error || '会话不存在', 'error');
    await navigate('agent', '', {}, { replace: true });
    return;
  }
  state.activeSession = data;
  applyAgentTopbar(data);
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
        applyAgentTopbar(state.activeSession);
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

let pendingKnowledgeNameResolve = null;

function validateKnowledgeName(name) {
  const value = String(name || '').trim();
  if (!value) return '名称不能为空';
  if (value.length > 80) return '名称不能超过 80 个字符';
  if (/[\\/]/.test(value)) return '名称不能包含 / 或 \\';
  return '';
}

function finishKnowledgeNameDialog(value) {
  const dialog = $('#knowledgeNameDialog');
  const resolve = pendingKnowledgeNameResolve;
  pendingKnowledgeNameResolve = null;
  if (dialog?.open) dialog.close();
  if (resolve) resolve(value);
}

function promptKnowledgeName({ title, label, defaultValue = '', hint = '', submitText = '确认', selectOnOpen = false }) {
  const dialog = $('#knowledgeNameDialog');
  const input = $('#knowledgeNameInput');
  const hintEl = $('#knowledgeNameHint');
  if (!dialog || !input) return Promise.resolve(null);
  if (pendingKnowledgeNameResolve) finishKnowledgeNameDialog(null);
  $('#knowledgeNameTitle').textContent = title;
  $('#knowledgeNameLabel').textContent = label;
  $('#knowledgeNameSubmit').textContent = submitText;
  input.value = defaultValue;
  if (hint) {
    hintEl.textContent = hint;
    hintEl.hidden = false;
  } else {
    hintEl.textContent = '';
    hintEl.hidden = true;
  }
  if (dialog.open) dialog.close();
  dialog.showModal();
  return new Promise(resolve => {
    pendingKnowledgeNameResolve = resolve;
    requestAnimationFrame(() => {
      input.focus();
      if (selectOnOpen && defaultValue) input.select();
    });
  });
}

function submitKnowledgeNameForm(event) {
  event.preventDefault();
  const input = $('#knowledgeNameInput');
  const name = input.value.trim();
  const error = validateKnowledgeName(name);
  if (error) {
    showToast(error, 'error');
    input.focus();
    return;
  }
  finishKnowledgeNameDialog(name);
}

function initKnowledgeNameDialog() {
  const dialog = $('#knowledgeNameDialog');
  const form = $('#knowledgeNameForm');
  if (!dialog || !form) return;
  form.addEventListener('submit', submitKnowledgeNameForm);
  $('#knowledgeNameCancel').addEventListener('click', () => finishKnowledgeNameDialog(null));
  $('#knowledgeNameClose').addEventListener('click', () => finishKnowledgeNameDialog(null));
  dialog.addEventListener('click', event => {
    if (event.target === dialog) finishKnowledgeNameDialog(null);
  });
  dialog.addEventListener('cancel', () => finishKnowledgeNameDialog(null));
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
  if (state.settingsPanel === 'sessions' && $('#settingsDialog')?.open) {
    await loadArchivedSessions().catch(() => {});
  }
  showToast('会话已归档', 'success');
}

function renderArchivedSessions() {
  const host = $('#archivedSessionList');
  if (!host) return;
  const sessions = state.archivedSessions || [];
  if (!sessions.length) {
    host.innerHTML = '<p class="empty-list">没有归档会话。</p>';
    return;
  }
  host.innerHTML = sessions.map(session => `
    <div class="archived-session-row">
      <div>
        <strong>${escHtml(session.title || '新会话')}</strong>
        <small>${escHtml(formatSessionMeta(session))}</small>
      </div>
      <span class="archived-session-actions">
        <button class="secondary-action compact" type="button" data-archived-restore="${escHtml(session.id)}">恢复</button>
        <button class="danger-action compact" type="button" data-archived-delete="${escHtml(session.id)}">删除</button>
      </span>
    </div>`).join('');
}

async function loadArchivedSessions() {
  const host = $('#archivedSessionList');
  if (!host) return;
  const response = await apiFetch('/api/agent/sessions?status=archived');
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || '归档会话加载失败');
  state.archivedSessions = data.sessions || [];
  renderArchivedSessions();
}

async function restoreArchivedSession(id) {
  const response = await apiFetch(`/api/agent/sessions/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'active' }),
  });
  if (!response.ok) return showToast('会话恢复失败', 'error');
  await Promise.all([loadSessions(), loadArchivedSessions()]);
  showToast('会话已恢复', 'success');
}

async function deleteArchivedSession(id) {
  const session = (state.archivedSessions || []).find(item => item.id === id);
  const confirmed = await confirmAction({
    title: '删除归档会话',
    message: `将永久删除“${session?.title || '会话'}”及其运行记录，无法恢复。`,
    confirmText: '删除',
  });
  if (!confirmed) return;
  const response = await apiFetch(`/api/agent/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) return showToast(data.error || '删除失败', 'error');
  if (state.activeSession?.id === id) await navigate('agent');
  await Promise.all([loadSessions(), loadArchivedSessions()]);
  showToast('归档会话已删除', 'success');
}

function runTraceHost(runId) {
  if (!runId) return null;
  return document.querySelector(`[data-run-id="${CSS.escape(runId)}"]`);
}

function upsertRunTrace(run, { live = false } = {}) {
  if (!run?.id) return null;
  const list = $('#agentMessageList');
  list.querySelector('.agent-empty-state')?.remove();
  let details = runTraceHost(run.id);
  if (!details) {
    details = document.createElement('details');
    details.className = 'execution-trace';
    details.dataset.runId = run.id;
    details.innerHTML = `
      <summary><span class="trace-state-dot"></span><span class="trace-summary">查看执行过程</span></summary>
      <div class="trace-events"></div>`;
    list.append(details);
  }
  if (live) details.open = false;
  const lines = Array.isArray(run.trace) ? run.trace.map(item => String(item || '').trim()).filter(Boolean) : [];
  const eventsEl = details.querySelector('.trace-events');
  const summaryEl = details.querySelector('.trace-summary');
  eventsEl.innerHTML = lines.map(text => `<div class="trace-event">${escHtml(text)}</div>`).join('');
  if (lines.length) summaryEl.textContent = lines.at(-1);
  eventsEl.scrollTop = eventsEl.scrollHeight;
  for (const child of Array.isArray(run.delegateRuns) ? run.delegateRuns : []) {
    upsertDelegateTrace(child, run.id, { live: live && state.activeChildRunId === child.id });
  }
  return details;
}

function trace(text) {
  if (!text) return;
  const details = runTraceHost(state.runId) || upsertRunTrace({ id: state.runId, trace: [] }, { live: true });
  if (!details) return;
  const eventsEl = details.querySelector('.trace-events');
  const summaryEl = details.querySelector('.trace-summary');
  const last = eventsEl.lastElementChild;
  if (last && last.textContent === text) {
    summaryEl.textContent = text;
    return;
  }
  const event = document.createElement('div');
  event.className = 'trace-event';
  event.textContent = text;
  eventsEl.append(event);
  eventsEl.scrollTop = eventsEl.scrollHeight;
  summaryEl.textContent = text;
}

function setRunStatus(status, text = '') {
  state.runStatus = status;
  const active = ACTIVE_RUN_STATES.has(status);
  const blocking = BLOCKING_RUN_STATES.has(status);
  $('#runStatus').hidden = !active;
  $('#stopRunButton').hidden = !active;
  $('#sendAgentButton').disabled = blocking;
  $('#agentSidebarStatus').classList.toggle('busy', active);
  const labels = {
    queued: '正在排队', running: '正在运行', waiting_approval: '等待确认', waiting_client_tool: '等待浏览器',
    waiting_user: '等待你的回答',
  };
  const label = text || labels[status] || idleAgentLabel();
  $('#runStatusText').textContent = label;
  $('#agentSidebarStatus span:last-child').textContent = label;
  const input = $('#agentInput');
  if (input) {
    if (status === 'waiting_user') {
      input.placeholder = state.delegateTitle
        ? `回答子任务「${state.delegateTitle}」的问题…`
        : '回答 Agent 的问题…';
    } else {
      input.placeholder = '用 @ 引用知识库或日期，然后描述你想完成什么…';
    }
  }
}

function approvalBodyHtml(approval) {
  const name = approval.call?.name || '';
  const args = approval.call?.arguments && typeof approval.call.arguments === 'object' ? approval.call.arguments : {};
  if (name === 'image.generate') {
    const prompt = String(args.prompt || '').trim();
    const extras = [];
    if (args.size) extras.push(`尺寸 ${args.size}`);
    if (args.model) extras.push(`模型 ${args.model}`);
    if (typeof args.watermark === 'boolean') extras.push(args.watermark ? '含水印' : '无水印');
    return `
      <p>将用 Seedream 生成图片。确认提示词无误后再允许执行。</p>
      <div class="approval-risk"><strong>提示词</strong><pre>${escHtml(prompt || '（空）')}</pre>${extras.length ? `<p>${escHtml(extras.join(' · '))}</p>` : ''}</div>`;
  }
  return `<div class="approval-risk"><strong>参数</strong><pre>${escHtml(JSON.stringify(args, null, 2))}</pre></div>`;
}

function renderAgentQuestion(question, delegateTitle = '') {
  const text = String(question || '').trim();
  if (!text) return;
  const cardKey = delegateTitle ? `${delegateTitle}::${text}` : text;
  if (document.querySelector(`[data-agent-question="${CSS.escape(cardKey)}"]`)) return;
  const card = document.createElement('section');
  card.className = 'approval-card agent-question-card';
  card.dataset.agentQuestion = cardKey;
  const delegateHint = delegateTitle
    ? `<p class="approval-delegate-hint muted">子任务：${escHtml(delegateTitle)}</p>`
    : '';
  card.innerHTML = `
    <h3>Agent 需要你补充信息</h3>
    ${delegateHint}
    <p>${escHtml(text)}</p>
    <p class="muted">直接在下方输入框回复即可。</p>`;
  $('#agentMessageList').append(card);
  scrollMessagesToBottom();
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
    const card = document.createElement('section');
    card.className = 'approval-card';
    card.dataset.approvalCard = approval.id;
    card.innerHTML = `
      <h3>确认执行 ${escHtml(name)}</h3>
      ${approval.delegateTitle ? `<p class="approval-delegate-hint muted">子任务：${escHtml(approval.delegateTitle)}</p>` : ''}
      ${name === 'image.generate' ? '' : '<p>Agent 请求执行一个会改变数据或访问外部服务的动作。</p>'}
      ${approvalBodyHtml(approval)}
      <div class="card-actions">
        <button class="secondary-action" type="button" data-approval-id="${escHtml(approval.id)}" data-approved="false">拒绝</button>
        <button class="primary-action compact" type="button" data-approval-id="${escHtml(approval.id)}" data-approved="true">允许执行</button>
      </div>`;
    $('#agentMessageList').append(card);
  });
  scrollMessagesToBottom();
}

function renderGeneratedImage(url, alt = '生成图片') {
  if (!isSafeImageSrc(url) || !url.startsWith('/uploads/')) return;
  if (document.querySelector(`[data-generated-image="${CSS.escape(url)}"]`)) return;
  const card = document.createElement('section');
  card.className = 'agent-image-preview';
  card.dataset.generatedImage = url;
  card.innerHTML = `<img src="${escHtml(url)}" alt="${escHtml(alt)}" loading="lazy">`;
  $('#agentMessageList').append(card);
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
    <header class="memory-card-head">
      <span class="memory-layer">${escHtml(memoryLayerLabel(proposal.layer))}</span>
      <strong>${escHtml(proposal.title || '任务经验')}</strong>
    </header>
    ${memoryBodyHtml(proposal.content)}
    <div class="card-actions">
      <button class="secondary-action" type="button" data-memory-dismiss="${escHtml(proposal.id)}">暂不保存</button>
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
  if (event.type === 'tool.completed') {
    trace(payload.result?.summary || payload.call?.name || '工具执行完成');
    const url = payload.result?.data?.url;
    if (typeof url === 'string' && url.startsWith('/uploads/')) {
      if (!state.runImages.includes(url)) state.runImages.push(url);
      renderGeneratedImage(url, payload.call?.arguments?.prompt || '生成图片');
    }
  }
  if (event.type === 'checkpoint.updated') trace('已更新工作进度');
  if (event.type === 'delegate.started') {
    const childRunId = payload.childRunId || payload.child_run_id || '';
    const delegateTitle = payload.delegateTitle || payload.delegate_title || '';
    if (delegateTitle) state.delegateTitle = delegateTitle;
    trace(delegateTitle ? `已委派子任务「${delegateTitle}」` : '已委派子任务');
    if (childRunId) subscribeDelegateRun(childRunId, delegateTitle, state.runId);
  }
  if (event.type === 'delegate.completed') {
    const childRunId = payload.childRunId || payload.child_run_id || '';
    if (childRunId) unsubscribeDelegateRun(childRunId);
    const delegateTitle = payload.delegateTitle || payload.delegate_title || '';
    trace(delegateTitle ? `子任务「${delegateTitle}」已完成` : '子任务已完成');
  }
  if (event.type === 'user_input.required') {
    setRunStatus('waiting_user');
    state.delegateTitle = payload.delegateTitle || payload.delegate_title || '';
    renderAgentQuestion(payload.question, state.delegateTitle);
    const childRunId = payload.delegatedRunId || payload.delegated_run_id || state.activeChildRunId;
    if (childRunId) {
      subscribeDelegateRun(childRunId, state.delegateTitle, state.runId);
      delegateTrace(payload.question ? `等待你的回答：${payload.question}` : '等待你的回答', childRunId);
    } else {
      trace(payload.question ? `等待你的回答：${payload.question}` : '等待你的回答');
    }
  }
  if (event.type === 'approval.required') {
    setRunStatus('waiting_approval');
    state.delegateTitle = payload.delegateTitle || payload.delegate_title || state.delegateTitle;
    renderApproval(payload);
    const childRunId = payload.approvals?.[0]?.delegatedRunId || state.activeChildRunId;
    if (payload.delegated && childRunId) {
      subscribeDelegateRun(childRunId, state.delegateTitle, state.runId);
      delegateTrace('等待你的确认', childRunId);
    } else {
      trace('等待你的确认');
    }
  }
  if (event.type === 'client_tool.requested') {
    setRunStatus('waiting_client_tool');
    const delegateTitle = payload.delegateTitle || payload.delegate_title || '';
    if (delegateTitle) state.delegateTitle = delegateTitle;
    const childRunId = payload.delegatedRunId || payload.delegated_run_id || state.activeChildRunId;
    if (childRunId) {
      subscribeDelegateRun(childRunId, delegateTitle || state.delegateTitle, state.runId);
      delegateTrace('等待浏览器返回结果', childRunId);
    } else {
      trace('等待浏览器返回结果');
    }
  }
  if (event.type === 'memory.proposed') {
    renderMemoryProposal(payload);
    refreshMemoryPendingCount().catch(() => {});
  }
  if (event.type === 'run.completed') {
    let text = payload.text || '已完成。';
    for (const url of state.runImages) {
      if (text.includes(url)) continue;
      text += `\n\n![生成图片](${url})`;
    }
    addMessage('assistant', text, payload.citations || []);
    for (const url of state.runImages) {
      document.querySelector(`[data-generated-image="${CSS.escape(url)}"]`)?.remove();
    }
    trace('运行完成');
    setRunStatus('');
    state.delegateTitle = '';
    for (const childRunId of [...state.childEventSources.keys()]) unsubscribeDelegateRun(childRunId);
    state.eventSource?.close();
    state.eventSource = null;
    loadSessions().catch(() => {});
  }
  if (event.type === 'run.failed') {
    const message = payload.error === 'cancelled' ? '运行已停止。' : `运行未完成：${payload.error || '未知错误'}`;
    if (payload.error === 'cancelled') {
      document.querySelectorAll('[data-approval-card]').forEach(card => card.remove());
    }
    const card = document.createElement('div');
    card.className = 'run-error';
    card.textContent = message;
    $('#agentMessageList').append(card);
    trace(message);
    setRunStatus('');
    state.delegateTitle = '';
    for (const childRunId of [...state.childEventSources.keys()]) unsubscribeDelegateRun(childRunId);
    state.eventSource?.close();
    state.eventSource = null;
    scrollMessagesToBottom();
  }
}

function subscribeRun(runId, initialStatus = 'queued') {
  state.eventSource?.close();
  state.runId = runId;
  state.runEventKeys = new Set();
  state.runImages = [];
  state.delegateTitle = '';
  state.activeChildRunId = '';
  upsertRunTrace({ id: runId, trace: [] }, { live: true });
  setRunStatus(initialStatus);
  const source = new EventSource(`/api/agent/runs/${encodeURIComponent(runId)}/events`);
  state.eventSource = source;
  [
    'run.started', 'assistant.delta', 'tool.proposed', 'approval.required', 'tool.started',
    'tool.completed', 'checkpoint.updated', 'client_tool.requested', 'user_input.required', 'memory.proposed',
    'delegate.started', 'delegate.completed', 'run.completed', 'run.failed',
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
  const resuming = state.runStatus === 'waiting_user' && state.runId;
  addMessage('user', content);
  setRunStatus(resuming ? 'running' : 'queued');
  const response = await apiFetch(`/api/agent/sessions/${encodeURIComponent(session.id)}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    setRunStatus(resuming ? 'waiting_user' : '');
    throw new Error(data.error || 'Agent 启动失败');
  }
  if (data.resumed) {
    subscribeRun(data.runId, data.status || 'running');
    trace('已收到你的回答，继续运行');
  } else {
    subscribeRun(data.runId, data.status);
    trace('目标已提交');
  }
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
}

function knowledgeFiltersActive() {
  return Boolean(
    $('#knowledgeSearch')?.value.trim()
    || $('#knowledgeTagFilter')?.value.trim()
    || $('#knowledgeDateFilter')?.value
    || $('#knowledgeArchivedFilter')?.checked,
  );
}

function folderDisplayName(base, folderPath) {
  if (!folderPath) return '';
  const folder = base?.folders?.find(item => item.path === folderPath);
  return folder?.name || folderPath;
}

function renderKnowledgeBreadcrumb(base) {
  const nav = $('#knowledgeBreadcrumb');
  if (!nav || !base) return;
  const folderPath = state.selectedFolderPath;
  const folderName = folderDisplayName(base, folderPath);
  nav.innerHTML = `
    <button type="button" class="knowledge-breadcrumb-link" data-breadcrumb="root">知识库</button>
    <span class="knowledge-breadcrumb-sep" aria-hidden="true">/</span>
    <button type="button" class="knowledge-breadcrumb-link" data-breadcrumb="base">${escHtml(base.name)}</button>
    ${folderPath ? `<span class="knowledge-breadcrumb-sep" aria-hidden="true">/</span><span class="knowledge-breadcrumb-current">${escHtml(folderName)}</span>` : ''}`;
}

function documentListHeadingText() {
  const total = state.knowledgeTotal;
  if (state.selectedFolderPath) {
    const base = findKnowledgeBase(state.selectedKnowledgeBase);
    return `${folderDisplayName(base, state.selectedFolderPath)} · ${total}`;
  }
  return `文档 · ${total}`;
}

function activeKnowledgeSearchQuery() {
  return $('#knowledgeSearch')?.value.trim() || '';
}

function documentRowSubtitle(document) {
  if (document.searchSnippet) {
    return String(document.searchSnippet).replace(/\s+/g, ' ').trim().slice(0, 120);
  }
  const date = document.documentDate || formatTime(document.updatedAt);
  const location = [document.knowledgeBase, document.folderPath].filter(Boolean).join(' / ') || '其他';
  if (knowledgeFiltersActive()) {
    return date ? `${location} · ${date}` : location;
  }
  if (state.selectedFolderPath) return date || '';
  if (document.folderPath) return date ? `${document.folderPath} · ${date}` : document.folderPath;
  return date || '';
}

function documentRowTitleHtml(document) {
  const title = document.title || '未命名';
  const q = activeKnowledgeSearchQuery();
  return q ? highlightSearch(title, q) : escHtml(title);
}

function documentRowSubtitleHtml(document) {
  const q = activeKnowledgeSearchQuery();
  if (document.searchSnippet) {
    const snippet = String(document.searchSnippet).replace(/\s+/g, ' ').trim().slice(0, 120);
    return highlightSearch(snippet, q);
  }
  const text = documentRowSubtitle(document);
  if (!text) return '';
  return q ? highlightSearch(text, q) : escHtml(text);
}

function renderKnowledgeTree() {
  const tree = $('#knowledgeFolderTree');
  const base = findKnowledgeBase(state.selectedKnowledgeBase);
  if (!tree || !base) return;
  renderKnowledgeBreadcrumb(base);
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
      return `<div class="knowledge-tree-folder-row knowledge-tree-folder-row-nested">
        <button class="knowledge-tree-folder ${active ? 'active' : ''}" type="button" data-knowledge-folder="${escHtml(folder.path)}" data-knowledge-base="${escHtml(base.name)}" aria-current="${active ? 'page' : 'false'}"><span class="tree-folder-dot" aria-hidden="true"></span>${escHtml(folder.name)} <small>${Number(folder.documentCount) || 0}</small></button>
        <span class="tree-actions"><button class="tree-action" type="button" data-tree-rename-folder="${escHtml(base.name)}" data-tree-folder="${escHtml(folder.path)}" title="重命名文件夹" aria-label="重命名 ${escHtml(folder.name)}">✎</button><button class="tree-action" type="button" data-tree-delete-folder="${escHtml(base.name)}" data-tree-folder="${escHtml(folder.path)}" title="删除文件夹" aria-label="删除 ${escHtml(folder.name)}">⌫</button></span>
      </div>`;
    }).join('')}`;
}

async function loadKnowledgeTree() {
  const response = await apiFetch('/api/knowledge/tree');
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || '知识库加载失败');
  state.knowledgeBases = Array.isArray(data.knowledgeBases) ? data.knowledgeBases : [];
  renderKnowledgeBaseList();
  if (state.selectedKnowledgeBase) renderKnowledgeTree();
  syncDocumentSelectOptions();
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
  let name = null;
  if (action === 'add-base') {
    name = await promptKnowledgeName({
      title: '新建知识库',
      label: '知识库名称',
      submitText: '创建',
    });
  } else if (action === 'add-folder') {
    name = await promptKnowledgeName({
      title: '新建文件夹',
      label: '文件夹名称',
      hint: `位于「${baseName}」`,
      submitText: '创建',
    });
  } else if (action === 'rename-base') {
    name = await promptKnowledgeName({
      title: '重命名知识库',
      label: '新名称',
      defaultValue: baseName,
      submitText: '保存',
      selectOnOpen: true,
    });
  } else if (action === 'rename-folder') {
    name = await promptKnowledgeName({
      title: '重命名文件夹',
      label: '新名称',
      defaultValue: folderPath,
      submitText: '保存',
      selectOnOpen: true,
    });
  }
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
  await navigate('knowledge', '', { knowledgeBase: state.selectedKnowledgeBase, folderPath: state.selectedFolderPath });
}

function knowledgeQuery(cursor = '', { includeSearchText = false } = {}) {
  const params = new URLSearchParams();
  const values = {
    knowledgeBase: state.selectedKnowledgeBase,
    folderPath: state.selectedFolderPath,
    tag: $('#knowledgeTagFilter').value.trim(),
    date: $('#knowledgeDateFilter').value,
  };
  if (includeSearchText) {
    const q = $('#knowledgeSearch').value.trim();
    if (q) values.q = q;
  }
  Object.entries(values).forEach(([key, value]) => { if (value) params.set(key, value); });
  if ($('#knowledgeArchivedFilter').checked) params.set('status', 'archived');
  params.set('limit', '60');
  if (cursor) params.set('cursor', cursor);
  return params;
}

function knowledgeSearchQuery() {
  const params = knowledgeSearchOptionsQuery();
  const q = $('#knowledgeSearch').value.trim();
  if (q) params.set('q', q);
  const tag = $('#knowledgeTagFilter').value.trim();
  const date = $('#knowledgeDateFilter').value;
  if (tag) params.set('tag', tag);
  if (date) params.set('date', date);
  if (state.selectedKnowledgeBase) params.set('knowledgeBase', state.selectedKnowledgeBase);
  if (state.selectedFolderPath) params.set('folderPath', state.selectedFolderPath);
  params.set('limit', '60');
  return params;
}

function renderDocuments() {
  const list = $('#knowledgeDocumentList');
  const heading = $('#knowledgeDocumentListHeading');
  if (heading) heading.textContent = documentListHeadingText();
  if (!state.documents.length) {
    list.innerHTML = '<p class="empty-list">没有符合条件的知识文档。</p>';
  } else {
    list.innerHTML = state.documents.map(document => {
      const subtitleHtml = documentRowSubtitleHtml(document);
      return `
        <div class="document-row ${state.activeDocument?.id === document.id ? 'active' : ''}" role="button" tabindex="0" data-document-open="${escHtml(document.id)}"${document.searchOffset ? ` data-search-offset="${document.searchOffset}"` : ''}>
          <span class="document-row-body">
            <span class="document-row-title"><strong>${documentRowTitleHtml(document)}</strong>${document.visibility === 'diary' ? '<span class="private-mark" title="私密知识">◆</span>' : ''}</span>
            ${subtitleHtml ? `<small>${subtitleHtml}</small>` : ''}
          </span>
        </div>`;
    }).join('');
  }
  $('#knowledgeLoadMore').hidden = !state.knowledgeNextCursor;
}

async function loadDocuments({ append = false, refreshTree = true } = {}) {
  if (!append && refreshTree) await loadKnowledgeTree();
  const q = $('#knowledgeSearch').value.trim();
  const archived = $('#knowledgeArchivedFilter').checked;
  if (q && !archived) {
    if (append) return;
    const response = await apiFetch(`/api/knowledge/search?${knowledgeSearchQuery()}`);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || '知识库搜索失败');
    state.documents = data.documents || [];
    state.knowledgeTotal = Number(data.total) || state.documents.length;
    state.knowledgeNextCursor = null;
  } else {
    const cursor = append ? state.knowledgeNextCursor : '';
    if (append && !cursor) return;
    const response = await apiFetch(`/api/knowledge/documents?${knowledgeQuery(cursor, { includeSearchText: archived && Boolean(q) })}`);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || '知识库加载失败');
    state.documents = append ? [...state.documents, ...(data.documents || [])] : (data.documents || []);
    state.knowledgeTotal = Number(data.total) || 0;
    state.knowledgeNextCursor = data.nextCursor || null;
  }
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
  updateInsertImageButton();
}

function syncDocumentSelectOptions({ knowledgeBase, folderPath } = {}) {
  const kbSelect = $('#documentKnowledgeBase');
  const folderSelect = $('#documentFolderPath');
  if (!kbSelect || !folderSelect) return;

  const bases = state.knowledgeBases.length
    ? state.knowledgeBases
    : [{ name: '其他', folders: [] }];
  const currentKb = knowledgeBase ?? kbSelect.value ?? state.selectedKnowledgeBase ?? '其他';
  kbSelect.innerHTML = bases.map(base => `<option value="${escHtml(base.name)}">${escHtml(base.name)}</option>`).join('');
  const base = bases.find(item => item.name === currentKb) || bases[0];
  kbSelect.value = base?.name || '其他';

  const folders = Array.isArray(base?.folders) ? base.folders : [];
  const currentFolder = folderPath ?? folderSelect.value ?? '';
  folderSelect.innerHTML = [
    '<option value="">根目录</option>',
    ...folders.map(folder => `<option value="${escHtml(folder.path)}">${escHtml(folder.name || folder.path)}</option>`),
  ].join('');
  const folderExists = !currentFolder || folders.some(item => item.path === currentFolder);
  folderSelect.value = folderExists ? currentFolder : '';

  syncSelectControls({ ids: DOCUMENT_SELECT_IDS });
  updateDocumentMetaSummary();
}

function updateDocumentMetaSummary() {
  const summary = $('#documentMetaSummary');
  if (!summary) return;
  const kbSelect = $('#documentKnowledgeBase');
  const folderSelect = $('#documentFolderPath');
  const kb = kbSelect?.selectedOptions?.[0]?.textContent?.trim() || '其他';
  const folder = folderSelect?.selectedOptions?.[0]?.textContent?.trim() || '根目录';
  const date = $('#documentDate')?.value || '';
  const tagsRaw = $('#documentTags')?.value.trim() || '';
  const dateLabel = date || '无日期';
  const tagsLabel = tagsRaw
    ? (tagsRaw.length > 28 ? `${tagsRaw.slice(0, 28)}…` : tagsRaw)
    : '无标签';
  summary.textContent = `${kb} · ${folder} · ${dateLabel} · ${tagsLabel}`;
}

function setDocumentFormDisabled(disabled) {
  $('#documentKnowledgeBase').disabled = disabled;
  $('#documentFolderPath').disabled = disabled;
  syncSelectControls({ ids: DOCUMENT_SELECT_IDS });
}

function setDocumentSaveState(text, className = '') {
  const element = $('#documentSaveState');
  element.textContent = text;
  const stateClass = className || (text === '已保存' ? 'saved' : '');
  element.className = `save-state ${stateClass}`.trim();
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
  syncDocumentSelectOptions({
    knowledgeBase: state.selectedKnowledgeBase,
    folderPath: state.selectedFolderPath,
  });
  $('#documentDate').value = document.documentDate || '';
  $('#documentTags').value = (document.tags || []).join(', ');
  const metaPanel = $('#documentMetaPanel');
  if (metaPanel) metaPanel.open = false;
  updateDocumentMetaSummary();
  $('#documentContent').value = document.content || '';
  $('#topbarSubtitle').textContent = document.title || '未命名';
  setDocumentSaveState('已保存');
  const isFile = document.sourceType === 'file';
  $('#noteEditor').hidden = isFile;
  $('#fileReader').hidden = !isFile;
  $('#editorModeSwitch').hidden = isFile;
  $('#archiveDocumentButton').hidden = document.status === 'archived';
  $('#restoreDocumentButton').hidden = document.status !== 'archived';
  updateInsertImageButton();
  $('#documentTitle').readOnly = document.status === 'archived';
  setDocumentFormDisabled(document.status === 'archived');
  $('#documentDate').readOnly = document.status === 'archived';
  $('#documentTags').readOnly = document.status === 'archived';
  $('#documentContent').readOnly = document.status === 'archived';
  $('#annotationTitle').readOnly = document.status === 'archived';
  $('#annotationContent').readOnly = document.status === 'archived';
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
  const searchQuery = activeKnowledgeSearchQuery();
  if (searchQuery) $('#fileContent').innerHTML = highlightSearch(extractText, searchQuery);
  else $('#fileContent').textContent = extractText;
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
  const q = activeKnowledgeSearchQuery();
  const selectionEnd = q
    ? Math.min(content.length, position + q.length)
    : Math.min(content.length, position + 120);
  if (state.activeDocument?.sourceType === 'file') {
    const reader = $('#fileContent');
    requestAnimationFrame(() => {
      const mark = reader.querySelector('mark');
      if (mark) mark.scrollIntoView({ block: 'center' });
      else reader.scrollTop = content.length ? reader.scrollHeight * (position / content.length) : 0;
    });
    return;
  }
  setEditorMode('edit');
  const editor = $('#documentContent');
  requestAnimationFrame(() => {
    editor.focus();
    editor.setSelectionRange(position, selectionEnd);
    editor.scrollTop = content.length ? editor.scrollHeight * (position / content.length) : 0;
  });
}

function setEditorMode(mode) {
  const next = mode === 'preview' ? 'preview' : mode === 'split' ? 'split' : 'edit';
  state.editorMode = next;
  document.querySelectorAll('[data-editor-mode]').forEach(button => {
    button.classList.toggle('active', button.dataset.editorMode === next);
  });
  const editor = $('#noteEditor');
  const textarea = $('#documentContent');
  const preview = $('#documentPreview');
  editor?.classList.toggle('is-split', next === 'split');
  textarea.hidden = next === 'preview';
  preview.hidden = next === 'edit';
  if (next === 'preview' || next === 'split') renderDocumentPreview();
  else if (documentPreviewCleanup) {
    documentPreviewCleanup();
    documentPreviewCleanup = null;
  }
}

function cycleEditorMode() {
  const order = ['edit', 'split', 'preview'];
  const index = order.indexOf(state.editorMode);
  setEditorMode(order[(index + 1) % order.length]);
}

function isNoteEditorActive() {
  return state.mode === 'knowledge'
    && state.activeDocument?.sourceType === 'note'
    && !$('#noteEditor')?.hidden
    && !$('#documentWorkspace')?.hidden;
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
    documentDate: document.documentDate || '',
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
  const previous = state.activeDocument;
  state.activeDocument = data;
  state.documentDirty = false;
  setDocumentSaveState('已保存');
  $('#topbarSubtitle').textContent = data.title || '未命名';
  updateDocumentSummary(data);
  const locationChanged = previous && (
    (previous.knowledgeBase || '其他') !== (data.knowledgeBase || '其他')
    || String(previous.folderPath || '') !== String(data.folderPath || '')
  );
  await loadKnowledgeTree();
  if (locationChanged && state.mode === 'knowledge') {
    await loadDocuments({ refreshTree: false });
  }
  return true;
}

function scheduleAnnotationSave() {
  if (!state.activeDocument || state.activeDocument.sourceType !== 'file') return;
  if (state.activeDocument.status === 'archived') return;
  if (!state.annotation && !$('#annotationTitle').value.trim() && !$('#annotationContent').value.trim()) return;
  state.annotationDirty = true;
  $('#annotationSaveState').textContent = '等待保存';
  clearTimeout(state.annotationSaveTimer);
  state.annotationSaveTimer = setTimeout(() => saveAnnotation(), 800);
}

async function saveAnnotation() {
  clearTimeout(state.annotationSaveTimer);
  if (!state.activeDocument || state.activeDocument.sourceType !== 'file') return true;
  if (state.activeDocument.status === 'archived') return true;
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

function insertTextAtCursor(textarea, text) {
  const start = textarea.selectionStart ?? textarea.value.length;
  const end = textarea.selectionEnd ?? start;
  const before = textarea.value.slice(0, start);
  const after = textarea.value.slice(end);
  textarea.value = `${before}${text}${after}`;
  const next = start + text.length;
  textarea.setSelectionRange(next, next);
  textarea.focus();
  state.documentDirty = true;
  scheduleDocumentSave();
}

function noteImageAltFromFile(file) {
  const name = String(file?.name || '图片').replace(/\.[^.]+$/, '').trim();
  return name || '图片';
}

async function uploadNoteImage(file) {
  const body = new FormData();
  body.append('image', file);
  const response = await apiFetch('/api/upload', { method: 'POST', body });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || '图片上传失败');
  return data.url;
}

function updateInsertImageButton() {
  const button = $('#insertImageButton');
  if (!button) return;
  const doc = state.activeDocument;
  button.hidden = !(doc && doc.sourceType !== 'file' && doc.status !== 'archived' && !$('#noteEditor').hidden);
}

async function handleDocumentImageUpload(file) {
  if (!file || !state.activeDocument || state.activeDocument.sourceType === 'file') return;
  const button = $('#insertImageButton');
  button.disabled = true;
  try {
    const url = await uploadNoteImage(file);
    const alt = noteImageAltFromFile(file);
    insertTextAtCursor($('#documentContent'), `\n![${alt}](${url})\n`);
    if (state.editorMode === 'preview') setEditorMode('edit');
    showToast('图片已插入', 'success');
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    button.disabled = false;
    $('#documentImageInput').value = '';
  }
}

async function handleDocumentImagePaste(event) {
  if (!state.activeDocument || state.activeDocument.sourceType === 'file' || state.activeDocument.status === 'archived') return;
  const file = [...(event.clipboardData?.items || [])]
    .find(item => item.kind === 'file' && item.type.startsWith('image/'))
    ?.getAsFile();
  if (!file) return;
  event.preventDefault();
  await handleDocumentImageUpload(file);
}

async function archiveActiveDocument() {
  const document = state.activeDocument;
  if (!document) return;
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

async function restoreActiveDocument() {
  const document = state.activeDocument;
  if (!document || document.status !== 'archived') return;
  const response = await apiFetch(`/api/knowledge/documents/${encodeURIComponent(document.id)}/restore`, { method: 'POST' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) return showToast(data.error || '恢复失败', 'error');
  showToast('文档已恢复', 'success');
  $('#knowledgeArchivedFilter').checked = false;
  await loadDocuments();
  await renderActiveDocument(data);
}

function deleteConfirmCopy(document) {
  const title = document.title || '未命名';
  if (document.sourceType === 'file') {
    return {
      title: '删除知识文件',
      message: `“${title}”将永久删除这篇文档及磁盘上的原文件，关联笔记也会删除。`,
    };
  }
  return {
    title: '删除笔记',
    message: `“${title}”将永久删除这篇笔记，不可恢复。`,
  };
}

async function deleteActiveDocument() {
  const document = state.activeDocument;
  if (!document) return;
  const copy = deleteConfirmCopy(document);
  const confirmed = await confirmAction({
    title: copy.title,
    message: copy.message,
    confirmText: '删除',
  });
  if (!confirmed) return;
  const response = await apiFetch(`/api/knowledge/documents/${encodeURIComponent(document.id)}`, { method: 'DELETE' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) return showToast(data.error || '删除失败', 'error');
  showToast('文档已删除', 'success');
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
  syncComputerSettingsVisibility();
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
  initKnowledgeNameDialog();
  document.querySelector('.topbar-mode-switch').addEventListener('click', async event => {
    const button = event.target.closest('[data-mode]');
    if (!button) return;
    const targetMode = button.dataset.mode;
    let id = '';
    let options = {};
    if (targetMode === state.mode) {
      if (targetMode === 'agent') id = state.activeSession?.id || '';
      else if (targetMode === 'knowledge') {
        id = state.activeDocument?.id || '';
        if (!id && state.selectedKnowledgeBase) {
          options = { knowledgeBase: state.selectedKnowledgeBase, folderPath: state.selectedFolderPath };
        }
      }
    }
    if (targetMode === 'knowledge') await loadKnowledgeTree();
    navigate(targetMode, id, options);
  });
  $('#sidebarOpen').addEventListener('click', openMobileSidebar);
  $('#sidebarClose').addEventListener('click', closeMobileSidebar);
  $('#sidebarBackdrop').addEventListener('click', closeMobileSidebar);
  $('#sidebarToggle').addEventListener('click', () => toggleDesktopSidebar());
  $('#sidebarExpand').addEventListener('click', () => toggleDesktopSidebar(false));
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
    if (!content || BLOCKING_RUN_STATES.has(state.runStatus)) return;
    input.value = '';
    autoResizeComposer();
    try { await sendAgentMessage(content); } catch (error) { showToast(error.message, 'error'); }
  });
  $('#agentInput').addEventListener('input', () => {
    autoResizeComposer();
    renderMentionMenu();
  });
  $('#agentInput').addEventListener('keydown', event => {
    const menuOpen = !$('#mentionMenu')?.hidden;
    if (menuOpen && event.key === 'ArrowDown') {
      event.preventDefault();
      moveMentionSelection(1);
      return;
    }
    if (menuOpen && event.key === 'ArrowUp') {
      event.preventDefault();
      moveMentionSelection(-1);
      return;
    }
    if (menuOpen && event.key === 'Escape') {
      event.preventDefault();
      hideMentionMenu();
      return;
    }
    if (menuOpen && event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      const selected = selectedMentionItem();
      if (selected) {
        event.preventDefault();
        insertMentionValue(selected.dataset.mention === 'today'
          ? localIsoDate(0)
          : selected.dataset.mention === 'yesterday'
            ? localIsoDate(-1)
            : selected.dataset.mention);
        return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      $('#agentComposer').requestSubmit();
    }
  });
  $('#mentionMenu').addEventListener('mousedown', event => {
    const item = event.target.closest('[data-mention]');
    if (!item) return;
    event.preventDefault();
    insertMentionValue(item.dataset.mention === 'today'
      ? localIsoDate(0)
      : item.dataset.mention === 'yesterday'
        ? localIsoDate(-1)
        : item.dataset.mention);
  });
  $('#mentionDateInput').addEventListener('change', event => {
    if (!event.target.value) return;
    insertMentionValue(event.target.value);
    event.target.value = '';
  });
  document.addEventListener('click', event => {
    if (!event.target.closest('#agentComposer')) hideMentionMenu();
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
    if (event.target.closest('[data-open-settings]')) {
      openSettings('model').catch(error => showToast(error.message, 'error'));
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
      await handleMemoryProposalAction(memoryApprove.dataset.memoryApprove, 'approve');
      return;
    }
    const memoryDismiss = event.target.closest('[data-memory-dismiss]');
    if (memoryDismiss) {
      await handleMemoryProposalAction(memoryDismiss.dataset.memoryDismiss, 'dismiss');
      return;
    }
    const previewImage = event.target.closest('.message-content img, .agent-image-preview img');
    if (previewImage) {
      event.preventDefault();
      openMarkdownImagePreview(previewImage);
    }
  });

  const reloadKnowledge = debounce(() => loadDocuments().catch(error => showToast(error.message, 'error')), 220);
  $('#knowledgeSearch').addEventListener('input', reloadKnowledge);
  bindKnowledgeSearchSettingsEvents();
  ['knowledgeTagFilter', 'knowledgeDateFilter', 'knowledgeArchivedFilter'].forEach(id => {
    $(`#${id}`).addEventListener(id === 'knowledgeTagFilter' ? 'input' : 'change', reloadKnowledge);
  });
  $('#newKnowledgeBaseButton').addEventListener('click', () => manageKnowledgeTree('add-base'));
  $('#knowledgeBreadcrumb').addEventListener('click', event => {
    const link = event.target.closest('[data-breadcrumb]');
    if (!link) return;
    if (link.dataset.breadcrumb === 'root') {
      state.selectedKnowledgeBase = '';
      state.selectedFolderPath = '';
      navigate('knowledge');
      return;
    }
    if (link.dataset.breadcrumb === 'base' && state.selectedFolderPath) {
      state.selectedFolderPath = '';
      navigate('knowledge', '', { knowledgeBase: state.selectedKnowledgeBase });
    }
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
    if (row) {
      const offset = Number(row.dataset.searchOffset) || 0;
      navigate('knowledge', row.dataset.documentOpen, offset > 0 ? { offset } : {});
    }
  });
  $('#knowledgeDocumentList').addEventListener('keydown', event => {
    const row = event.target.closest('[data-document-open]');
    if (row && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      const offset = Number(row.dataset.searchOffset) || 0;
      navigate('knowledge', row.dataset.documentOpen, offset > 0 ? { offset } : {});
    }
  });
  ['documentTitle', 'documentDate', 'documentTags', 'documentContent'].forEach(id => {
    $(`#${id}`).addEventListener('input', () => {
      if (id === 'documentDate' || id === 'documentTags') updateDocumentMetaSummary();
      scheduleDocumentSave();
    });
  });
  $('#documentKnowledgeBase').addEventListener('change', () => {
    syncDocumentSelectOptions({
      knowledgeBase: $('#documentKnowledgeBase').value,
      folderPath: '',
    });
    updateDocumentMetaSummary();
    scheduleDocumentSave();
  });
  $('#documentFolderPath').addEventListener('change', () => {
    updateDocumentMetaSummary();
    scheduleDocumentSave();
  });
  initSelectControls({ ids: DOCUMENT_SELECT_IDS });
  $('#documentContent').addEventListener('input', refreshDocumentPreview);
  $('#editorModeSwitch').addEventListener('click', event => {
    const button = event.target.closest('[data-editor-mode]');
    if (button) setEditorMode(button.dataset.editorMode);
  });
  $('#documentContent').addEventListener('paste', event => {
    handleDocumentImagePaste(event).catch(error => showToast(error.message, 'error'));
  });
  $('#insertImageButton').addEventListener('click', () => $('#documentImageInput').click());
  $('#documentImageInput').addEventListener('change', event => {
    const file = event.target.files?.[0];
    if (file) handleDocumentImageUpload(file).catch(error => showToast(error.message, 'error'));
  });
  $('#archiveDocumentButton').addEventListener('click', archiveActiveDocument);
  $('#restoreDocumentButton').addEventListener('click', () => restoreActiveDocument().catch(error => showToast(error.message, 'error')));
  $('#deleteDocumentButton').addEventListener('click', deleteActiveDocument);
  ['annotationTitle', 'annotationContent'].forEach(id => $(`#${id}`).addEventListener('input', scheduleAnnotationSave));
  document.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'p' && isNoteEditorActive()) {
      event.preventDefault();
      cycleEditorMode();
      return;
    }
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
    syncDesktopSidebar();
  });
  desktopSidebarQuery.addEventListener('change', syncDesktopSidebar);
  syncDesktopSidebar();

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
  $('#settingsButton').addEventListener('click', () => openSettings().catch(error => showToast(error.message, 'error')));
  $('#accountSettings').addEventListener('click', () => openSettings('account').catch(error => showToast(error.message, 'error')));
  $('#agentComposerSettings').addEventListener('click', () => openSettings('model').catch(error => showToast(error.message, 'error')));
  $('#agentSidebarStatus').addEventListener('click', () => openSettings('model').catch(error => showToast(error.message, 'error')));
  $('#closeSettingsDialog').addEventListener('click', () => $('#settingsDialog').close());
  $('#settingsForm').addEventListener('submit', event => {
    event.preventDefault();
    saveAgentSettings();
  });
  document.querySelector('.settings-nav').addEventListener('click', event => {
    const button = event.target.closest('[data-settings-nav]');
    if (button) setSettingsPanel(button.dataset.settingsNav);
  });
  createBackupActions({
    confirmAction,
    reloadKnowledge: async () => {
      await loadKnowledgeTree();
      await loadDocuments();
    },
  }).bindBackupEvents();
  $('#btnComputerAllowlistAdd').addEventListener('click', addComputerAllowlistEntry);
  $('#computerAllowlistInput').addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      addComputerAllowlistEntry();
    }
  });
  $('#computerAllowlist').addEventListener('click', event => {
    const button = event.target.closest('[data-allowlist-remove]');
    if (!button) return;
    const index = Number(button.dataset.allowlistRemove);
    if (!Number.isInteger(index) || !state.computerPolicy?.allowedDirectories) return;
    state.computerPolicy.allowedDirectories.splice(index, 1);
    renderComputerAllowlist();
  });
  $('#archivedSessionList').addEventListener('click', event => {
    const restore = event.target.closest('[data-archived-restore]');
    const remove = event.target.closest('[data-archived-delete]');
    if (restore) restoreArchivedSession(restore.dataset.archivedRestore).catch(error => showToast(error.message, 'error'));
    if (remove) deleteArchivedSession(remove.dataset.archivedDelete).catch(error => showToast(error.message, 'error'));
  });
  $('#refreshAgentMemory').addEventListener('click', () => refreshAgentMemory().catch(error => showToast(error.message, 'error')));
  $('#memoryView').addEventListener('click', async event => {
    const approve = event.target.closest('[data-memory-approve]');
    if (approve) {
      await handleMemoryProposalAction(approve.dataset.memoryApprove, 'approve');
      return;
    }
    const dismiss = event.target.closest('[data-memory-dismiss]');
    if (dismiss) {
      await handleMemoryProposalAction(dismiss.dataset.memoryDismiss, 'dismiss');
      return;
    }
    const archive = event.target.closest('[data-memory-archive]');
    if (archive) await archiveMemoryItem(archive.dataset.memoryArchive);
  });
  $('#memorySidebarPanel').addEventListener('click', event => {
    const filter = event.target.closest('[data-memory-layer]');
    if (!filter) return;
    state.memoryLayer = filter.dataset.memoryLayer || '';
    renderMemoryWorkspace();
  });
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
  window.addEventListener('account-updated', event => {
    if (!event.detail) return;
    state.user = event.detail;
    $('#diaryUsername').value = state.user.username || state.user.display_name || '';
    syncComputerSettingsVisibility();
  });
}

async function initialize() {
  if (!(await checkAuth())) return;
  bindEvents();
  initAccounts();
  initTodos();
  syncMobileSidebarAccessibility();
  renderKnowledgeSearchModeHint();
  const savedTheme = localStorage.getItem('theme');
  $('#themeSelect').value = savedTheme === 'dark' || savedTheme === 'light' ? savedTheme : 'system';
  await Promise.all([loadAccount(), syncDiaryStatus(), loadAgentStatus()]);
  await Promise.all([loadKnowledgeTree(), loadSessions(), refreshMemoryPendingCount()]);
  if (!window.location.hash) history.replaceState(null, '', '#agent');
  await applyRoute();
}

initialize().catch(error => {
  console.error(error);
  showToast(`工作台初始化失败：${error.message}`, 'error');
});
