import { state } from './state.js';
import { apiFetch, redirectToLogin } from './auth.js';
import { showToast, escHtml, confirmDialog, openModal, closeModal, $, $$ } from './helpers.js';
import { renderToHtmlUncached } from './markdown.js';
import { loadLogs, listView, syncArchiveFilterControls } from './logList.js';
import { loadStats } from './stats.js';
import { findAction, getAllShortcuts, setShortcut, resetAllShortcuts, formatKeys, isComboUsed, isImeComposingEvent } from './shortcuts.js';
import { closeCategoryManager, loadCategories, populateFilterCategory, populateEditorParentCategory, populateEditorSubCategory } from './categories.js';
import { renderCalendar } from './calendar.js';
import { AUTO_SAVE_MS, SAVE_STATUS_DURATION } from './constants.js';
import { businessDateString } from './businessDate.js';
import { renderTemplateVariables } from './templateDate.js';
import { createContentEditor } from './contentEditor.js';
import { enableMarkdownImagePreview } from './imagePreview.js';

const editorView = $('#editorView');
const categoryView = $('#categoryView');
const aiChatView = $('#aiChatView');
const aiSettingsView = $('#aiSettingsView');
const todoView = $('#todoView');
const photoWallView = $('#photoWallView');
const editTitle = $('#editTitle');
const editContent = $('#editContent');
const codeMirrorContentEditor = $('#codeMirrorContentEditor');
const contentEditor = createContentEditor(editContent, codeMirrorContentEditor);
const editorContentArea = document.querySelector('.editor-content-area');
const editPreview = $('#editPreview');
enableMarkdownImagePreview(editPreview);
const editDate = $('#editDate');
const editCategory = $('#editCategory');
const editSubcategory = $('#editSubcategory');
const editHours = $('#editHours');
const editorModeTabs = $('#editorModeTabs');
const saveStatus = $('#saveStatus');
const btnEditorFullscreen = $('#btnEditorFullscreen');
const editorToolbar = $('#editorToolbar');
const editorOutlineLayout = $('#editorOutlineLayout');
const editorOutlinePanel = $('#editorOutlinePanel');
const editorOutlineList = $('#editorOutlineList');
const btnEditorOutlinePanel = $('#btnEditorOutlinePanel');
const btnCloseOutlinePanel = $('#btnCloseOutlinePanel');
const btnEditorAiPanel = $('#btnEditorAiPanel');
const editorAiPanel = $('#editorAiPanel');
const editorAiMessages = $('#editorAiMessages');
const editorAiInput = $('#editorAiInput');
const btnEditorAiSend = $('#btnEditorAiSend');
const btnEditorAiImage = $('#btnEditorAiImage');
const btnEditorAiAttach = $('#btnEditorAiAttach');
const editorAiMediaInput = $('#editorAiMediaInput');
const editorAiMediaDrafts = $('#editorAiMediaDrafts');
const btnEditorAiNew = $('#btnEditorAiNew');
const btnEditorAiHistory = $('#btnEditorAiHistory');
const btnEditorAiSettings = $('#btnEditorAiSettings');
const btnEditorAiHistoryClose = $('#btnEditorAiHistoryClose');
const editorAiHistoryPopover = $('#editorAiHistoryPopover');
const editorAiHistoryList = $('#editorAiHistoryList');
const btnCloseEditorAiPanel = $('#btnCloseEditorAiPanel');
const editorAiBackdrop = $('#editorAiBackdrop');
const editorAiScopeLabel = $('#editorAiScopeLabel');
const editorAiDragHandle = $('#editorAiDragHandle');
const btnEditorAiModel = $('#btnEditorAiModel');
const editorAiModelLabelEl = $('#editorAiModelLabel');
const editorAiConversationMeta = $('#editorAiConversationMeta');
const editorAiRenameOverlay = $('#editorAiRenameOverlay');
const editorAiRenameInput = $('#editorAiRenameInput');
const btnEditorToolbarMore = $('#btnEditorToolbarMore');
const editorToolbarMoreMenu = $('#editorToolbarMoreMenu');
enableMarkdownImagePreview(editorAiMessages, '[data-ai-media-preview]');

function editorTitleActionIcon(name) {
  switch (name) {
    case 'fullscreen-exit':
      return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 4H4v6"/><path d="M4 4l7 7"/><path d="M14 4h6v6"/><path d="M20 4l-7 7"/><path d="M10 20H4v-6"/><path d="M4 20l7-7"/><path d="M14 20h6v-6"/><path d="M20 20l-7-7"/></svg>';
    case 'fullscreen-enter':
    default:
      return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H3v5"/><path d="M3 3l7 7"/><path d="M16 3h5v5"/><path d="M21 3l-7 7"/><path d="M8 21H3v-5"/><path d="M3 21l7-7"/><path d="M16 21h5v-5"/><path d="M21 21l-7-7"/></svg>';
  }
}

function renderEditorFullscreenButton(enabled) {
  btnEditorFullscreen.setAttribute('aria-pressed', String(enabled));
  btnEditorFullscreen.innerHTML = editorTitleActionIcon(enabled ? 'fullscreen-exit' : 'fullscreen-enter');
  btnEditorFullscreen.title = enabled ? '退出全屏编辑' : '进入全屏编辑';
  btnEditorFullscreen.setAttribute('aria-label', enabled ? '退出全屏编辑' : '进入全屏编辑');
}

// Editor-internal state
const EDITOR_TAB_STORAGE_KEY = 'editorTabMode';
const AI_CONVERSATIONS_ENDPOINT = '/api/ai/conversations';
const AI_SETTINGS_ENDPOINT = '/api/ai/settings';
const AI_MODELS_ENDPOINT = '/api/ai/models';
const DEFAULT_EDITOR_AI_MODEL = 'deepseek-v4-flash';
const EDITOR_AI_WINDOW_POSITION_KEY = 'editorAiWindowPosition';
const DEFAULT_SEEDREAM_MODEL = 'doubao-seedream-5-0-260128';
const DEFAULT_SEEDREAM_SIZE = '2K';
const EDITOR_AI_MAX_MESSAGES = 20;
let editorTab = localStorage.getItem(EDITOR_TAB_STORAGE_KEY) || 'write';
if (!['write', 'preview', 'split'].includes(editorTab)) editorTab = 'write';
let editorFullscreenPreviousTab = '';
let autoSaveTimer = null;
let lastSavedContent = '';
let lastSavedTitle = '';
let lastSavedDate = '';
let lastSavedHours = '';
let lastSavedCategory = '';
let isDirty = false;
let isSaving = false;
let currentSavePromise = null;
let editorDocumentEpoch = 0;
let activeEditorLoadController = null;
let editorAiAllConversations = [];
let editorAiActiveConversationId = '';
let editorAiDraftSessionId = `draft-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const editorAiPendingByConversationId = new Set();
let editorAiRenameConversationId = '';
let editorAiPendingMedia = [];
let editorAiMediaUploading = false;
let editorAiModelsLoadedAt = 0;
let editorAiModels = [
  { id: 'deepseek-v4-flash', name: 'DeepSeek Flash', source: 'direct', provider: 'deepseek', inputModalities: ['text'], reasoning: { supported: true, supportedEfforts: ['high', 'max'], defaultEffort: 'high', mandatory: false } },
  { id: 'deepseek-v4-pro', name: 'DeepSeek Pro', source: 'direct', provider: 'deepseek', inputModalities: ['text'], reasoning: { supported: true, supportedEfforts: ['high', 'max'], defaultEffort: 'high', mandatory: false } },
  { id: 'kimi-k3', name: 'Kimi K3', source: 'direct', provider: 'moonshot', inputModalities: ['text', 'image', 'video'], reasoning: { supported: true, supportedEfforts: ['max'], defaultEffort: 'max', mandatory: true } },
  { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code', source: 'direct', provider: 'moonshot', inputModalities: ['text', 'image', 'video'], reasoning: { supported: true, supportedEfforts: [], mandatory: true } },
  { id: 'kimi-k2.6', name: 'Kimi K2.6', source: 'direct', provider: 'moonshot', inputModalities: ['text', 'image', 'video'], reasoning: { supported: true, supportedEfforts: [], mandatory: false } },
];
let editorAiSettings = {
  model: DEFAULT_EDITOR_AI_MODEL,
  reasoningMode: 'effort',
  reasoningEffort: 'high',
  thinkingMode: 'enabled',
  apiKeyConfigured: false,
  moonshotApiKeyConfigured: false,
  openrouterApiKeyConfigured: false,
};
let editorAiDragState = null;
const EDITOR_SELECT_IDS = ['editCategory', 'editSubcategory'];

function invalidateEditorRequests() {
  editorDocumentEpoch += 1;
  activeEditorLoadController?.abort();
  activeEditorLoadController = null;
  return editorDocumentEpoch;
}

function isOutlinePanelOpen() {
  return btnEditorOutlinePanel.getAttribute('aria-expanded') === 'true';
}

function isEditorAiPanelOpen() {
  return btnEditorAiPanel.getAttribute('aria-expanded') === 'true';
}

function syncEditorDrawerBackdrop() {
  if (!editorAiBackdrop) return;
  const isMobile = Boolean(window.matchMedia && window.matchMedia('(max-width: 768px)').matches);
  const mobileOutlineOverlay = isMobile && isOutlinePanelOpen();
  const mobileAiOverlay = isMobile && isEditorAiPanelOpen();
  const open = mobileOutlineOverlay || mobileAiOverlay;
  editorAiBackdrop.hidden = !open;
}

function isDesktopEditorAiWindow() {
  return Boolean(window.matchMedia && window.matchMedia('(min-width: 769px)').matches);
}

function readEditorAiWindowPosition() {
  try {
    const value = JSON.parse(localStorage.getItem(EDITOR_AI_WINDOW_POSITION_KEY) || 'null');
    return Number.isFinite(value?.left) && Number.isFinite(value?.top) ? value : null;
  } catch {
    return null;
  }
}

function clampEditorAiWindowPosition(left, top) {
  const rect = editorAiPanel.getBoundingClientRect();
  const margin = 12;
  return {
    left: Math.min(Math.max(margin, left), Math.max(margin, window.innerWidth - rect.width - margin)),
    top: Math.min(Math.max(margin, top), Math.max(margin, window.innerHeight - rect.height - margin)),
  };
}

function positionEditorAiWindow({ useSaved = true } = {}) {
  if (!editorAiPanel) return;
  if (!isDesktopEditorAiWindow()) {
    editorAiPanel.style.removeProperty('left');
    editorAiPanel.style.removeProperty('top');
    editorAiPanel.style.removeProperty('right');
    editorAiPanel.style.removeProperty('bottom');
    return;
  }
  const rect = editorAiPanel.getBoundingClientRect();
  const saved = useSaved ? readEditorAiWindowPosition() : null;
  const desiredLeft = saved?.left ?? (window.innerWidth - rect.width - 24);
  const desiredTop = saved?.top ?? Math.max(24, Math.round((window.innerHeight - rect.height) / 2));
  const next = clampEditorAiWindowPosition(desiredLeft, desiredTop);
  editorAiPanel.style.left = `${Math.round(next.left)}px`;
  editorAiPanel.style.top = `${Math.round(next.top)}px`;
  editorAiPanel.style.right = 'auto';
  editorAiPanel.style.bottom = 'auto';
}

function saveEditorAiWindowPosition() {
  if (!isDesktopEditorAiWindow()) return;
  const rect = editorAiPanel.getBoundingClientRect();
  try {
    localStorage.setItem(EDITOR_AI_WINDOW_POSITION_KEY, JSON.stringify({ left: Math.round(rect.left), top: Math.round(rect.top) }));
  } catch {}
}

function resetEditorAiWindowPosition() {
  try { localStorage.removeItem(EDITOR_AI_WINDOW_POSITION_KEY); } catch {}
  positionEditorAiWindow({ useSaved: false });
}

function startEditorAiWindowDrag(event) {
  if (!isDesktopEditorAiWindow() || event.button !== 0 || event.target.closest('button, input, textarea, a, [role="button"]')) return;
  const rect = editorAiPanel.getBoundingClientRect();
  editorAiDragState = {
    pointerId: event.pointerId,
    offsetX: event.clientX - rect.left,
    offsetY: event.clientY - rect.top,
  };
  editorAiPanel.classList.add('is-dragging');
  editorAiDragHandle.setPointerCapture?.(event.pointerId);
  event.preventDefault();
}

function moveEditorAiWindow(event) {
  if (!editorAiDragState || editorAiDragState.pointerId !== event.pointerId) return;
  const next = clampEditorAiWindowPosition(
    event.clientX - editorAiDragState.offsetX,
    event.clientY - editorAiDragState.offsetY,
  );
  editorAiPanel.style.left = `${Math.round(next.left)}px`;
  editorAiPanel.style.top = `${Math.round(next.top)}px`;
  editorAiPanel.style.right = 'auto';
  editorAiPanel.style.bottom = 'auto';
}

function endEditorAiWindowDrag(event) {
  if (!editorAiDragState || editorAiDragState.pointerId !== event.pointerId) return;
  try { editorAiDragHandle.releasePointerCapture?.(event.pointerId); } catch {}
  editorAiDragState = null;
  editorAiPanel.classList.remove('is-dragging');
  saveEditorAiWindowPosition();
}

function setOutlinePanelOpen(open, { closeAi = true } = {}) {
  if (open && closeAi && isEditorAiPanelOpen()) {
    void setEditorAiPanelOpen(false, { closeOutline: false, focusInput: false });
  }
  editorView.classList.toggle('editor-outline-open', open);
  editorOutlineLayout.classList.toggle('outline-panel-open', open);
  editorOutlinePanel.setAttribute('aria-hidden', String(!open));
  editorOutlinePanel.inert = !open;
  btnEditorOutlinePanel.setAttribute('aria-expanded', String(open));
  btnEditorOutlinePanel.title = open ? '收起标题大纲' : '展开标题大纲';
  if (open) {
    renderOutline();
    syncOutlineCurrent();
  }
  syncEditorDrawerBackdrop();
  requestAnimationFrame(() => contentEditor.layout());
}

function editorSelectControls() {
  return EDITOR_SELECT_IDS
    .map(id => document.querySelector(`[data-editor-select-control][data-select-id="${id}"]`))
    .filter(Boolean);
}

function closeEditorSelectControl(control) {
  if (!control) return;
  control.classList.remove('open');
  control.querySelector('.editor-select-trigger')?.setAttribute('aria-expanded', 'false');
  const menu = control.querySelector('.editor-select-menu');
  if (menu) menu.hidden = true;
}

function closeEditorSelectControls(except = null) {
  editorSelectControls().forEach(control => {
    if (control !== except) closeEditorSelectControl(control);
  });
}

function selectFromEditorOption(control, optionButton) {
  const select = document.getElementById(control.dataset.selectId);
  if (!select || !optionButton) return;
  select.value = optionButton.dataset.value || '';
  closeEditorSelectControl(control);
  select.dispatchEvent(new Event('change', { bubbles: true }));
  syncEditorSelectControls();
  control.querySelector('.editor-select-trigger')?.focus();
}

function focusEditorSelectOption(control, direction = 1) {
  const options = [...control.querySelectorAll('.editor-select-option')];
  if (!options.length) return;
  const activeIndex = options.indexOf(document.activeElement);
  const selectedIndex = options.findIndex(option => option.getAttribute('aria-selected') === 'true');
  const baseIndex = activeIndex >= 0 ? activeIndex : (selectedIndex >= 0 ? selectedIndex : 0);
  const nextIndex = (baseIndex + direction + options.length) % options.length;
  options[nextIndex].focus();
}

function openEditorSelectControl(control, { focusSelected = false } = {}) {
  const trigger = control.querySelector('.editor-select-trigger');
  const menu = control.querySelector('.editor-select-menu');
  if (!trigger || !menu) return;
  syncEditorSelectControls();
  closeEditorSelectControls(control);
  control.classList.add('open');
  trigger.setAttribute('aria-expanded', 'true');
  menu.hidden = false;
  if (focusSelected) {
    const selected = menu.querySelector('.editor-select-option[aria-selected="true"]');
    (selected || menu.querySelector('.editor-select-option'))?.focus();
  }
}

function toggleEditorSelectControl(control) {
  if (control.classList.contains('open')) {
    closeEditorSelectControl(control);
  } else {
    openEditorSelectControl(control);
  }
}

function syncEditorSelectControls() {
  editorSelectControls().forEach(control => {
    const select = document.getElementById(control.dataset.selectId);
    const trigger = control.querySelector('.editor-select-trigger');
    const value = control.querySelector('.editor-select-value');
    const menu = control.querySelector('.editor-select-menu');
    if (!select || !trigger || !value || !menu) return;

    const hidden = select.style.display === 'none' || select.hidden;
    control.style.display = hidden ? 'none' : '';
    if (hidden) {
      closeEditorSelectControl(control);
      return;
    }

    const options = [...select.options];
    const selected = select.selectedOptions[0] || options.find(option => option.value === select.value) || options[0];
    const hasValue = Boolean(select.value);
    value.textContent = selected?.textContent || '';
    control.classList.toggle('has-value', hasValue);
    trigger.setAttribute('aria-label', `${select.labels?.[0]?.textContent || '选择'}：${selected?.textContent || '未选择'}`);
    menu.innerHTML = options.map(option => `
      <button
        class="editor-select-option${option.value === select.value ? ' selected' : ''}"
        type="button"
        role="option"
        data-value="${escHtml(option.value)}"
        aria-selected="${option.value === select.value}"
        tabindex="-1"
      >${escHtml(option.textContent)}</button>
    `).join('');
  });
}

function initEditorSelectControls() {
  editorSelectControls().forEach(control => {
    const trigger = control.querySelector('.editor-select-trigger');
    const menu = control.querySelector('.editor-select-menu');
    trigger?.addEventListener('click', () => toggleEditorSelectControl(control));
    trigger?.addEventListener('keydown', (event) => {
      if (!['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) return;
      event.preventDefault();
      openEditorSelectControl(control, { focusSelected: true });
      if (event.key === 'ArrowUp') focusEditorSelectOption(control, -1);
    });
    menu?.addEventListener('click', (event) => {
      const option = event.target.closest('.editor-select-option');
      if (option) selectFromEditorOption(control, option);
    });
    menu?.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        focusEditorSelectOption(control, 1);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        focusEditorSelectOption(control, -1);
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        selectFromEditorOption(control, event.target.closest('.editor-select-option'));
      } else if (event.key === 'Escape') {
        event.preventDefault();
        closeEditorSelectControl(control);
        trigger?.focus();
      }
    });
  });
  document.addEventListener('click', (event) => {
    if (!event.target.closest('[data-editor-select-control]')) closeEditorSelectControls();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeEditorSelectControls();
  });
  syncEditorSelectControls();
}

function setEditorToolbarMoreOpen(open) {
  if (!btnEditorToolbarMore || !editorToolbarMoreMenu) return;
  btnEditorToolbarMore.setAttribute('aria-expanded', String(open));
  editorToolbarMoreMenu.hidden = !open;
}

function normalizeEditorAiConversations(items) {
  return Array.isArray(items)
    ? items
      .filter(item => item && typeof item.id === 'string' && Array.isArray(item.messages))
      .map(item => ({
        ...item,
        scope: item.scope === 'editor' ? 'editor' : 'global',
        logKey: typeof item.logKey === 'string' ? item.logKey : '',
        model: isEditorAiModelId(item.model) ? item.model : '',
      }))
    : [];
}

function isEditorAiModelId(value) {
  return typeof value === 'string' && value.length <= 200 && (
    ['deepseek-v4-flash', 'deepseek-v4-pro', 'kimi-k3', 'kimi-k2.7-code', 'kimi-k2.6'].includes(value) ||
    /^[a-z0-9][a-z0-9._-]{0,79}\/[a-z0-9][a-z0-9._:+-]{0,119}$/i.test(value)
  );
}

function normalizeEditorAiModel(value) {
  if (!value || !isEditorAiModelId(value.id) || typeof value.name !== 'string') return null;
  return {
    ...value,
    name: value.name.trim().slice(0, 160) || value.id,
    source: value.source === 'openrouter' ? 'openrouter' : 'direct',
    provider: typeof value.provider === 'string' ? value.provider : '',
    inputModalities: Array.isArray(value.inputModalities) ? value.inputModalities.filter(item => typeof item === 'string') : ['text'],
    reasoning: value.reasoning && typeof value.reasoning === 'object'
      ? value.reasoning
      : { supported: false, supportedEfforts: [], mandatory: false },
  };
}

function editorAiModelMeta(modelId) {
  return editorAiModels.find(model => model.id === modelId) || null;
}

function activeEditorAiModel(chat = activeEditorAiConversation()) {
  if (isEditorAiModelId(chat?.model)) return chat.model;
  return isEditorAiModelId(editorAiSettings.model) ? editorAiSettings.model : DEFAULT_EDITOR_AI_MODEL;
}

function syncEditorAiModelControl() {
  if (!btnEditorAiModel || !editorAiModelLabelEl) return;
  const chat = activeEditorAiConversation();
  const modelId = activeEditorAiModel(chat);
  const model = editorAiModelMeta(modelId);
  const label = model?.name || editorAiModelLabel(modelId);
  editorAiModelLabelEl.textContent = label;
  btnEditorAiModel.title = `下一条消息使用 ${label}（${modelId}）`;
  btnEditorAiModel.setAttribute('aria-label', `切换当前日志对话模型，当前为 ${label}`);
  btnEditorAiModel.disabled = isEditorAiConversationPending(chat.id);
  btnEditorAiModel.closest('.editor-ai-model-switcher')?.setAttribute('data-provider', model?.provider || '');
}

async function loadEditorAiModelContext({ forceModels = false, quiet = true } = {}) {
  const shouldLoadModels = forceModels || !editorAiModelsLoadedAt || Date.now() - editorAiModelsLoadedAt > 10 * 60 * 1000;
  try {
    const [settingsResponse, modelsResponse] = await Promise.all([
      apiFetch(AI_SETTINGS_ENDPOINT),
      shouldLoadModels ? apiFetch(AI_MODELS_ENDPOINT) : Promise.resolve(null),
    ]);
    const nextSettings = await settingsResponse.json().catch(() => ({}));
    if (!settingsResponse.ok) throw new Error(nextSettings.error || 'AI 设置加载失败');
    editorAiSettings = { ...editorAiSettings, ...nextSettings };
    if (modelsResponse) {
      const data = await modelsResponse.json().catch(() => ({}));
      if (!modelsResponse.ok) throw new Error(data.error || '模型目录加载失败');
      const models = Array.isArray(data.models) ? data.models.map(normalizeEditorAiModel).filter(Boolean) : [];
      if (models.length) editorAiModels = models;
      editorAiModelsLoadedAt = Date.now();
    }
    syncEditorAiModelControl();
    return true;
  } catch (err) {
    if (!quiet) showToast('模型目录加载失败：' + err.message, 'error');
    console.warn('Failed to load editor AI model context:', err);
    syncEditorAiModelControl();
    return false;
  }
}

function editorAiRequestOptions(chat) {
  const model = activeEditorAiModel(chat);
  const reasoning = editorAiModelMeta(model)?.reasoning || {};
  let reasoningMode = editorAiSettings.reasoningMode || 'effort';
  let reasoningEffort = editorAiSettings.reasoningEffort || 'high';
  if (reasoningMode === 'disabled' && (reasoning.supported === false || reasoning.mandatory)) reasoningMode = 'default';
  if (reasoningMode === 'effort') {
    const efforts = Array.isArray(reasoning.supportedEfforts) ? reasoning.supportedEfforts : [];
    if (!efforts.length) reasoningMode = 'default';
    else if (!efforts.includes(reasoningEffort)) reasoningEffort = reasoning.defaultEffort || efforts[0];
  }
  return {
    model,
    thinkingMode: reasoningMode === 'disabled' ? 'disabled' : 'enabled',
    reasoningMode,
    reasoningEffort,
  };
}

async function openEditorAiModelPicker() {
  await loadEditorAiModelContext({ quiet: true });
  const chat = activeEditorAiConversation();
  document.dispatchEvent(new CustomEvent('editor-ai-model-picker-request', {
    detail: { conversationId: chat.id, modelId: activeEditorAiModel(chat) },
  }));
}

async function selectEditorAiModel(event) {
  const detail = event.detail || {};
  const model = normalizeEditorAiModel(detail.model);
  const chat = findEditorAiConversationById(detail.conversationId);
  if (!model || !chat || chat.id !== editorAiActiveConversationId || isEditorAiConversationPending(chat.id)) return;
  const previousModel = chat.model;
  chat.model = model.id;
  chat.updatedAt = Date.now();
  const existingIndex = editorAiModels.findIndex(item => item.id === model.id);
  if (existingIndex >= 0) editorAiModels[existingIndex] = model;
  else editorAiModels.push(model);
  syncEditorAiModelControl();
  if (!await saveEditorAiConversations()) {
    chat.model = previousModel;
    syncEditorAiModelControl();
    return;
  }
  const missingKey = model.source === 'openrouter'
    ? !editorAiSettings.openrouterApiKeyConfigured
    : model.provider === 'moonshot' ? !editorAiSettings.moonshotApiKeyConfigured : !editorAiSettings.apiKeyConfigured;
  showToast(missingKey ? `已切换至 ${model.name}；请先配置对应 API Key` : `日志对话已切换至 ${model.name}`, missingKey ? 'info' : 'success');
}

function currentEditorLogKey() {
  return state.editingId ? `log:${state.editingId}` : `draft:${editorAiDraftSessionId}`;
}

function createEditorAiConversation(logKey = currentEditorLogKey()) {
  const label = editTitle.value.trim() || '当前日志';
  return {
    id: `editor-chat-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    title: label.slice(0, 40) || '日志对话',
    scope: 'editor',
    logKey,
    model: isEditorAiModelId(editorAiSettings.model) ? editorAiSettings.model : DEFAULT_EDITOR_AI_MODEL,
    diarySensitive: getCategoryValue().startsWith('日记'),
    messages: [],
    updatedAt: Date.now(),
  };
}

function activeEditorAiConversation() {
  const logKey = currentEditorLogKey();
  let chat = editorAiAllConversations.find(item => item.scope === 'editor' && item.logKey === logKey && item.id === editorAiActiveConversationId);
  if (!chat) {
    chat = editorAiAllConversations
      .filter(item => item.scope === 'editor' && item.logKey === logKey)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
  }
  if (!chat) {
    chat = createEditorAiConversation(logKey);
    editorAiAllConversations.push(chat);
  }
  editorAiActiveConversationId = chat.id;
  return chat;
}

function isEditorAiConversationPending(chatId = editorAiActiveConversationId) {
  return Boolean(chatId && editorAiPendingByConversationId.has(chatId));
}

function setEditorAiConversationPending(chatId, pending) {
  if (!chatId) return;
  if (pending) editorAiPendingByConversationId.add(chatId);
  else editorAiPendingByConversationId.delete(chatId);
}

function isEditorAiConversationVisible(chatId, logKey) {
  return editorAiActiveConversationId === chatId && currentEditorLogKey() === logKey;
}

function findEditorAiConversationById(id) {
  return editorAiAllConversations.find(item => item.scope === 'editor' && item.id === id) || null;
}

async function loadEditorAiConversations() {
  try {
    const res = await apiFetch(AI_CONVERSATIONS_ENDPOINT);
    if (!res.ok) return;
    const data = await res.json();
    editorAiAllConversations = normalizeEditorAiConversations(data.conversations)
      .filter(item => item.scope === 'editor');
  } catch (err) {
    console.warn('Failed to load editor AI conversations:', err);
  }
}

async function saveEditorAiConversations() {
  try {
    const res = await apiFetch(AI_CONVERSATIONS_ENDPOINT, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scope: 'editor',
        conversations: editorAiAllConversations.filter(item => item.scope === 'editor'),
        activeConversationId: editorAiActiveConversationId,
      }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'AI 历史保存失败');
    }
    return true;
  } catch (err) {
    console.warn('Failed to save editor AI conversations:', err);
    showToast('AI 历史保存失败：' + err.message, 'error');
    return false;
  }
}

async function migrateEditorAiDraftConversation(savedId) {
  const draftKey = `draft:${editorAiDraftSessionId}`;
  const logKey = `log:${savedId}`;
  let migrated = false;
  editorAiAllConversations.forEach(item => {
    if (item.scope === 'editor' && item.logKey === draftKey) {
      item.logKey = logKey;
      migrated = true;
    }
  });
  if (migrated) await saveEditorAiConversations();
  if (migrated) renderEditorAiHistory();
}

function conversationTitleFrom(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  return clean ? clean.slice(0, 40) : '日志对话';
}

function editorImagePromptFrom(text) {
  return String(text || '').trim().slice(0, 800);
}

function markdownForEditorGeneratedImage(imageGeneration) {
  return imageGeneration?.markdown || (imageGeneration?.url ? `![image](${imageGeneration.url})` : '');
}

function selectedEditorImagePrompt(imageGeneration) {
  if (!imageGeneration) return '';
  if (imageGeneration.promptMode === 'original') {
    return imageGeneration.originalPrompt || imageGeneration.prompt || '';
  }
  return imageGeneration.optimizedPrompt || imageGeneration.selectedPrompt || imageGeneration.prompt || imageGeneration.originalPrompt || '';
}

function editorImagePromptContext() {
  const content = contentEditor.getValue();
  const selection = contentEditor.getSelection();
  const selectedText = content.slice(selection.start, selection.end).trim();
  return [
    editTitle.value.trim() ? `标题：${editTitle.value.trim()}` : '',
    selectedText ? `选区：${selectedText.slice(0, 800)}` : '',
    content.trim() ? `正文摘要：${content.trim().slice(0, 1200)}` : '',
  ].filter(Boolean).join('\n\n');
}

async function optimizeEditorImagePrompt(prompt, requestOptions = {}) {
  const res = await apiFetch('/api/ai/image/prompt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt,
      context: editorImagePromptContext(),
      ...requestOptions,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Prompt 优化失败');
  return String(data.prompt || '').trim().slice(0, 1200);
}

async function copyEditorText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.select();
  const ok = document.execCommand('copy');
  textarea.remove();
  if (!ok) throw new Error('复制失败');
}

function formatEditorAiChatTime(timestamp) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function editorAiConversationsForCurrentLog() {
  const logKey = currentEditorLogKey();
  return editorAiAllConversations
    .filter(item => item.scope === 'editor' && item.logKey === logKey)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

function renderEditorAiHistory() {
  if (!editorAiHistoryList) return;
  const chats = editorAiConversationsForCurrentLog();
  if (!chats.length) {
    editorAiHistoryList.innerHTML = '<div class="editor-ai-history-empty">暂无历史对话</div>';
    return;
  }
  editorAiHistoryList.innerHTML = chats.map(chat => `
    <div class="editor-ai-history-item${chat.id === editorAiActiveConversationId ? ' active' : ''}" data-id="${escHtml(chat.id)}">
      <button type="button" class="editor-ai-history-open" title="${escHtml(chat.title || '日志对话')}">
        <span class="editor-ai-history-title">${escHtml(chat.title || '日志对话')}</span>
        <span class="editor-ai-history-meta">${chat.messages.length} 条 · ${escHtml(formatEditorAiChatTime(chat.updatedAt))}</span>
      </button>
      <button type="button" class="editor-ai-history-action" data-action="rename" aria-label="重命名对话" title="重命名">✎</button>
      <button type="button" class="editor-ai-history-action danger" data-action="delete" aria-label="删除对话" title="删除">×</button>
    </div>
  `).join('');
}

function setEditorAiHistoryOpen(open) {
  if (!editorAiHistoryPopover || !btnEditorAiHistory) return;
  editorAiHistoryPopover.hidden = !open;
  btnEditorAiHistory.setAttribute('aria-expanded', String(open));
  if (open) renderEditorAiHistory();
}

function openEditorAiSettings() {
  const settingsButton = $('#btnAiApiKey');
  if (settingsButton) {
    settingsButton.click();
    return;
  }
  showToast('AI 设置入口暂不可用', 'error');
}

async function switchEditorAiConversation(id) {
  if (!editorAiConversationsForCurrentLog().some(chat => chat.id === id)) return;
  editorAiActiveConversationId = id;
  await saveEditorAiConversations();
  setEditorAiHistoryOpen(false);
  renderEditorAiMessages();
  updateEditorAiSendState();
  editorAiInput.focus();
}

function openEditorAiRenameModal(id) {
  const chat = editorAiConversationsForCurrentLog().find(item => item.id === id);
  if (!chat) return;
  editorAiRenameConversationId = id;
  editorAiRenameInput.value = chat.title || '日志对话';
  openModal(editorAiRenameOverlay, '#editorAiRenameInput');
}

function closeEditorAiRenameModal() {
  editorAiRenameConversationId = '';
  closeModal(editorAiRenameOverlay);
}

async function saveEditorAiRename() {
  const chat = editorAiConversationsForCurrentLog().find(item => item.id === editorAiRenameConversationId);
  if (!chat) return;
  const title = editorAiRenameInput.value.trim();
  if (!title) return;
  chat.title = title.slice(0, 40);
  chat.updatedAt = Date.now();
  await saveEditorAiConversations();
  renderEditorAiHistory();
  renderEditorAiMessages();
  closeEditorAiRenameModal();
}

async function deleteEditorAiConversation(id) {
  const chat = editorAiConversationsForCurrentLog().find(item => item.id === id);
  if (!chat) return;
  const confirmed = await confirmDialog({
    title: '删除日志内对话',
    message: `删除对话“${chat.title || '日志对话'}”？此操作只会删除当前日志的本地 AI 历史。`,
    confirmText: '删除',
    cancelText: '取消',
    danger: true,
  });
  if (!confirmed) return;
  editorAiAllConversations = editorAiAllConversations.filter(item => item.id !== id);
  setEditorAiConversationPending(id, false);
  if (editorAiActiveConversationId === id) editorAiActiveConversationId = '';
  activeEditorAiConversation();
  await saveEditorAiConversations();
  renderEditorAiHistory();
  renderEditorAiMessages();
  updateEditorAiSendState();
}

function getEditorAiSuggestion(message) {
  const suggestion = message?.editorSuggestion && typeof message.editorSuggestion === 'object'
    ? message.editorSuggestion
    : {};
  return {
    reply: typeof suggestion.reply === 'string' ? suggestion.reply : message?.content || '',
    suggestedTitle: typeof suggestion.suggestedTitle === 'string' ? suggestion.suggestedTitle : '',
    suggestedContent: typeof suggestion.suggestedContent === 'string' ? suggestion.suggestedContent : '',
    insertText: typeof suggestion.insertText === 'string' ? suggestion.insertText : '',
  };
}

function renderEditorAiSuggestionPreview(message, index) {
  const suggestion = getEditorAiSuggestion(message);
  const rows = [];
  if (suggestion.suggestedTitle) {
    rows.push(`
      <div class="editor-ai-suggestion-preview-row title">
        <span class="editor-ai-suggestion-label">标题建议</span>
        <div class="editor-ai-suggestion-title">${escHtml(suggestion.suggestedTitle)}</div>
      </div>
    `);
  }
  if (suggestion.insertText) {
    rows.push(`
      <div class="editor-ai-suggestion-preview-row">
        <span class="editor-ai-suggestion-label">插入/替换建议</span>
        <div class="editor-ai-suggestion-content markdown-body">${renderToHtmlUncached(suggestion.insertText)}</div>
      </div>
    `);
  }
  if (suggestion.suggestedContent) {
    rows.push(`
      <div class="editor-ai-suggestion-preview-row">
        <span class="editor-ai-suggestion-label">全文建议</span>
        <div class="editor-ai-suggestion-content markdown-body">${renderToHtmlUncached(suggestion.suggestedContent)}</div>
      </div>
    `);
  }
  if (!rows.length) return '';
  const rawLength = suggestion.suggestedContent.length + suggestion.insertText.length + suggestion.suggestedTitle.length;
  const expandable = rawLength > 420;
  return `
    <div class="editor-ai-suggestion-card${expandable ? ' collapsed' : ' expanded'}" data-suggestion-index="${index}">
      <div class="editor-ai-suggestion-head">
        <strong>可应用建议</strong>
        ${expandable ? `<button type="button" class="editor-ai-suggestion-toggle" data-editor-ai-toggle-suggestion="${index}" aria-expanded="false">展开</button>` : ''}
      </div>
      <div class="editor-ai-suggestion-preview">
        ${rows.join('')}
      </div>
    </div>
  `;
}

function renderEditorAiActions(message, index) {
  const suggestion = getEditorAiSuggestion(message);
  const actions = [];
  if (suggestion.suggestedTitle) actions.push(['title', '改标题']);
  if (suggestion.insertText || suggestion.suggestedContent) actions.push(['insert', '插入到光标']);
  if (suggestion.insertText || suggestion.suggestedContent) actions.push(['replace-selection', '替换选区']);
  if (suggestion.suggestedContent) actions.push(['replace-body', '替换全文']);
  if (!actions.length) return '';
  return `
    <div class="editor-ai-actions" aria-label="应用 AI 建议">
      ${actions.map(([action, label]) => `<button type="button" class="editor-ai-action" data-editor-ai-apply="${action}" data-message-index="${index}">${label}</button>`).join('')}
    </div>
  `;
}

function renderEditorAiAssistantBubble(message, index) {
  return `
    <div class="editor-ai-bubble editor-ai-assistant-bubble">
      <div class="editor-ai-answer markdown-body">
        ${renderToHtmlUncached(message.content)}
      </div>
      ${message.imageGeneration ? renderEditorImageGenerationCard(message.imageGeneration, index) : ''}
      ${renderEditorAiSuggestionPreview(message, index)}
      ${renderEditorAiActions(message, index)}
    </div>
  `;
}

function renderEditorImageGenerationCard(imageGeneration, index) {
  const status = imageGeneration.status || 'pending';
  const markdown = markdownForEditorGeneratedImage(imageGeneration);
  const originalPrompt = imageGeneration.originalPrompt || imageGeneration.prompt || '';
  const optimizedPrompt = imageGeneration.optimizedPrompt || '';
  const promptMode = imageGeneration.promptMode === 'original' || !optimizedPrompt ? 'original' : 'optimized';
  const currentPrompt = selectedEditorImagePrompt(imageGeneration);
  const promptOptions = status === 'pending' || status === 'error' ? `
    <div class="ai-image-prompt-options" role="group" aria-label="选择生图 prompt">
      <button type="button" class="ai-image-prompt-choice${promptMode === 'original' ? ' active' : ''}" data-action="choose-editor-image-prompt" data-prompt-mode="original">原始 prompt</button>
      <button type="button" class="ai-image-prompt-choice${promptMode === 'optimized' ? ' active' : ''}" data-action="choose-editor-image-prompt" data-prompt-mode="optimized"${optimizedPrompt ? '' : ' disabled'}>优化 prompt</button>
    </div>
    <div class="ai-image-prompt-list">
      <div class="ai-image-prompt-block${promptMode === 'original' ? ' active' : ''}">
        <span class="ai-image-prompt-label">原始</span>
        <div class="ai-image-prompt-text">${escHtml(originalPrompt)}</div>
      </div>
      ${optimizedPrompt ? `
        <div class="ai-image-prompt-block${promptMode === 'optimized' ? ' active' : ''}">
          <span class="ai-image-prompt-label">AI 优化</span>
          <div class="ai-image-prompt-text">${escHtml(optimizedPrompt)}</div>
        </div>
      ` : ''}
    </div>
  ` : `<div class="ai-image-prompt">${escHtml(currentPrompt)}</div>`;
  return `
    <div class="ai-image-card editor-ai-image-card ${status}" data-image-generation-index="${index}">
      <div class="ai-image-card-head">
        <strong>生图确认</strong>
        <span>${escHtml(imageGeneration.size || DEFAULT_SEEDREAM_SIZE)} · ${escHtml(imageGeneration.model || DEFAULT_SEEDREAM_MODEL)}</span>
      </div>
      ${status === 'optimizing' ? `
        <div class="ai-image-optimizing">
          <span>正在优化 prompt</span>
          <span class="ai-thinking-dots" aria-hidden="true"><i></i><i></i><i></i></span>
        </div>
        <div class="ai-image-prompt">${escHtml(originalPrompt)}</div>
      ` : promptOptions}
      ${status === 'done' && imageGeneration.url ? `
        <img class="ai-image-preview" src="${escHtml(imageGeneration.url)}" alt="AI 生成图片">
        <code class="ai-image-markdown">${escHtml(markdown)}</code>
      ` : ''}
      ${status === 'error' ? `<div class="ai-image-error">${escHtml(imageGeneration.error || '生图失败')}</div>` : ''}
      <div class="ai-image-actions">
        ${status === 'pending' ? `<button type="button" class="btn-primary btn-sm" data-action="generate-editor-image">生成图片</button><button type="button" class="btn-secondary btn-sm" data-action="cancel-editor-image">取消</button>` : ''}
        ${status === 'done' ? `<button type="button" class="btn-secondary btn-sm" data-action="copy-editor-image-markdown">复制 Markdown</button><button type="button" class="btn-primary btn-sm" data-action="insert-editor-image-markdown">插入到光标</button>` : ''}
        ${status === 'error' ? `<button type="button" class="btn-secondary btn-sm" data-action="generate-editor-image">重试</button>` : ''}
      </div>
    </div>
  `;
}

async function chooseEditorImagePrompt(index, mode) {
  const chat = activeEditorAiConversation();
  const imageGeneration = chat.messages[index]?.imageGeneration;
  if (!imageGeneration || !['original', 'optimized'].includes(mode)) return;
  if (mode === 'optimized' && !imageGeneration.optimizedPrompt) return;
  imageGeneration.promptMode = mode;
  imageGeneration.selectedPrompt = selectedEditorImagePrompt(imageGeneration);
  imageGeneration.prompt = imageGeneration.selectedPrompt;
  chat.updatedAt = Date.now();
  await saveEditorAiConversations();
  renderEditorAiMessages();
}

async function generateEditorImageForMessage(index) {
  const chat = activeEditorAiConversation();
  const message = chat.messages[index];
  const imageGeneration = message?.imageGeneration;
  const prompt = selectedEditorImagePrompt(imageGeneration);
  if (!prompt || isEditorAiConversationPending(chat.id)) return;
  imageGeneration.status = 'generating';
  imageGeneration.selectedPrompt = prompt;
  imageGeneration.prompt = prompt;
  message.content = '正在生成图片...';
  chat.updatedAt = Date.now();
  await saveEditorAiConversations();
  renderEditorAiMessages();
  try {
    const res = await apiFetch('/api/ai/image/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt,
        model: imageGeneration.model || DEFAULT_SEEDREAM_MODEL,
        size: imageGeneration.size || DEFAULT_SEEDREAM_SIZE,
        watermark: imageGeneration.watermark !== false,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '生图请求失败');
    imageGeneration.status = 'done';
    imageGeneration.url = data.url;
    imageGeneration.filename = data.filename;
    imageGeneration.model = data.model;
    imageGeneration.size = data.size;
    imageGeneration.markdown = `![image](${data.url})`;
    message.content = `图片已生成：\n\n![image](${data.url})`;
    chat.updatedAt = Date.now();
    await saveEditorAiConversations();
    renderEditorAiMessages();
    renderEditorAiHistory();
  } catch (err) {
    imageGeneration.status = 'error';
    imageGeneration.error = err.message;
    message.content = `生图失败：${err.message}`;
    chat.updatedAt = Date.now();
    await saveEditorAiConversations();
    renderEditorAiMessages();
    renderEditorAiHistory();
    showToast('生图失败：' + err.message, 'error');
  }
}

async function cancelEditorImageGeneration(index) {
  const chat = activeEditorAiConversation();
  const message = chat.messages[index];
  if (!message?.imageGeneration) return;
  message.imageGeneration.status = 'cancelled';
  message.content = '已取消生图。';
  chat.updatedAt = Date.now();
  await saveEditorAiConversations();
  renderEditorAiMessages();
}

async function copyEditorImageMarkdown(index) {
  const markdown = markdownForEditorGeneratedImage(activeEditorAiConversation().messages[index]?.imageGeneration);
  if (!markdown) return;
  try {
    await copyEditorText(markdown);
    showToast('图片 Markdown 已复制', 'success');
  } catch (err) {
    showToast('复制失败: ' + err.message, 'error');
  }
}

function insertEditorGeneratedImage(index) {
  const markdown = markdownForEditorGeneratedImage(activeEditorAiConversation().messages[index]?.imageGeneration);
  if (!markdown) return;
  contentEditor.insertAtSelection(markdown);
  contentEditor.focus();
  autoSave();
  showToast('图片已插入日志', 'success');
}

function renderEditorAiMediaAttachments(attachments = []) {
  if (!Array.isArray(attachments) || !attachments.length) return '';
  return `<div class="ai-message-media editor-ai-message-media">${attachments.map(item => item.kind === 'video' ? `
    <figure class="ai-message-media-item video">
      <video src="/api/ai/media/${encodeURIComponent(item.id)}/content" controls preload="metadata" aria-label="${escHtml(item.name || '视频')}"></video>
      <figcaption>${escHtml(item.name || '视频')}</figcaption>
    </figure>
  ` : `
    <figure class="ai-message-media-item image">
      <img src="/api/ai/media/${encodeURIComponent(item.id)}/content" alt="${escHtml(item.name || '图片')}" data-ai-media-preview>
      <figcaption>${escHtml(item.name || '图片')}</figcaption>
    </figure>
  `).join('')}</div>`;
}

function editorAiModelLabel(modelId) {
  const direct = {
    'deepseek-v4-flash': 'DeepSeek Flash', 'deepseek-v4-pro': 'DeepSeek Pro',
    'kimi-k3': 'Kimi K3', 'kimi-k2.7-code': 'Kimi K2.7 Code', 'kimi-k2.6': 'Kimi K2.6',
  };
  return direct[modelId] || String(modelId || '').split('/').at(-1) || 'AI';
}

function renderEditorAiPendingMedia() {
  if (!editorAiMediaDrafts) return;
  editorAiMediaDrafts.innerHTML = editorAiPendingMedia.map(item => `
    <div class="ai-media-draft" data-media-id="${escHtml(item.id)}">
      ${item.kind === 'image' ? `<img src="${escHtml(item.url)}" alt="">` : '<span class="ai-media-video-icon" aria-hidden="true">▶</span>'}
      <span title="${escHtml(item.name)}">${escHtml(item.name)}</span>
      <button type="button" data-action="remove-editor-ai-media" aria-label="移除 ${escHtml(item.name)}" title="移除">×</button>
    </div>
  `).join('');
  editorAiMediaDrafts.hidden = !editorAiPendingMedia.length;
}

async function uploadEditorAiMediaFiles(files) {
  const selected = [...files];
  if (!selected.length) return;
  if (editorAiPendingMedia.length + selected.length > 4) return showToast('每条消息最多添加 4 个附件', 'error');
  const totalBytes = editorAiPendingMedia.reduce((sum, item) => sum + (item.bytes || 0), 0) + selected.reduce((sum, file) => sum + file.size, 0);
  if (totalBytes > 100 * 1024 * 1024) return showToast('每条消息附件合计不能超过 100MB', 'error');
  editorAiMediaUploading = true;
  updateEditorAiSendState();
  try {
    for (const file of selected) {
      const form = new FormData();
      form.append('media', file);
      const res = await apiFetch('/api/ai/media', { method: 'POST', body: form });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `上传 ${file.name} 失败`);
      editorAiPendingMedia.push(data);
      renderEditorAiPendingMedia();
    }
  } catch (err) {
    showToast('附件上传失败：' + err.message, 'error');
  } finally {
    editorAiMediaUploading = false;
    if (editorAiMediaInput) editorAiMediaInput.value = '';
    updateEditorAiSendState();
  }
}

async function removeEditorAiPendingMedia(id) {
  const item = editorAiPendingMedia.find(media => media.id === id);
  editorAiPendingMedia = editorAiPendingMedia.filter(media => media.id !== id);
  renderEditorAiPendingMedia();
  updateEditorAiSendState();
  if (!item) return;
  try { await apiFetch(`/api/ai/media/${encodeURIComponent(id)}`, { method: 'DELETE' }); } catch {}
}

function renderEditorAiMessages() {
  if (!editorAiMessages) return;
  const chat = activeEditorAiConversation();
  const isPending = isEditorAiConversationPending(chat.id);
  syncEditorAiModelControl();
  editorAiScopeLabel.textContent = state.editingId ? `日志 #${state.editingId}` : '未保存草稿';
  if (editorAiConversationMeta) editorAiConversationMeta.textContent = `${chat.messages.length} 条消息`;
  if (!chat.messages.length) {
    editorAiMessages.innerHTML = `
      <div class="editor-ai-empty">
        <div class="editor-ai-empty-copy">
          <strong>从当前日志继续聊</strong>
          <span>围绕标题、正文或选区提问，AI 只给建议，是否写入由你决定。</span>
        </div>
      </div>
    `;
    return;
  }
  editorAiMessages.innerHTML = chat.messages.map((message, index) => `
    <div class="editor-ai-message ${message.role}" data-message-index="${index}">
      <div class="editor-ai-role"${message.role === 'assistant' && message.modelId ? ` title="${escHtml(`${message.provider || 'AI'} · ${message.modelId}`)}"` : ''}>${message.role === 'user' ? '你' : (message.modelId ? `AI · ${escHtml(editorAiModelLabel(message.modelId))}` : 'AI')}</div>
      ${renderEditorAiMediaAttachments(message.attachments)}
      ${message.role === 'assistant' ? renderEditorAiAssistantBubble(message, index) : `<div class="editor-ai-bubble">${escHtml(message.content)}</div>`}
      ${message.role === 'assistant' && Array.isArray(message.sources) && message.sources.length ? `
        <div class="editor-ai-sources" aria-label="联网搜索来源">
          ${message.sources.map((source, sourceIndex) => `<a href="${escHtml(source.url)}" target="_blank" rel="noopener noreferrer">${sourceIndex + 1}. ${escHtml(source.title || source.url)}</a>`).join('')}
        </div>
      ` : ''}
    </div>
  `).join('') + (isPending ? `
    <div class="editor-ai-message assistant editor-ai-thinking">
      <div class="editor-ai-role">AI</div>
      <div class="editor-ai-bubble">正在思考<span class="ai-thinking-dots" aria-hidden="true"><i></i><i></i><i></i></span></div>
    </div>
  ` : '');
  editorAiMessages.scrollTop = editorAiMessages.scrollHeight;
}

function updateEditorAiSendState() {
  if (!btnEditorAiSend || !editorAiInput) return;
  const isPending = isEditorAiConversationPending(editorAiActiveConversationId);
  const hasText = Boolean(editorAiInput.value.trim());
  const hasMedia = editorAiPendingMedia.length > 0;
  const disabled = isPending || editorAiMediaUploading || (!hasText && !hasMedia);
  btnEditorAiSend.disabled = disabled;
  if (btnEditorAiImage) btnEditorAiImage.disabled = isPending || editorAiMediaUploading || !hasText || hasMedia;
  if (btnEditorAiAttach) btnEditorAiAttach.disabled = isPending || editorAiMediaUploading || editorAiPendingMedia.length >= 4;
  syncEditorAiModelControl();
}

function resizeEditorAiInput() {
  if (!editorAiInput) return;
  editorAiInput.style.height = 'auto';
  const height = Math.min(Math.max(editorAiInput.scrollHeight, 56), 112);
  editorAiInput.style.height = `${height}px`;
  editorAiInput.style.overflowY = editorAiInput.scrollHeight > 112 ? 'auto' : 'hidden';
}

async function setEditorAiPanelOpen(open, { closeOutline = true, focusInput = true } = {}) {
  if (open && closeOutline && isOutlinePanelOpen()) {
    setOutlinePanelOpen(false, { closeAi: false });
  }
  editorView.classList.toggle('editor-ai-open', open);
  editorOutlineLayout.classList.toggle('editor-ai-open', open);
  editorAiPanel.setAttribute('aria-hidden', String(!open));
  editorAiPanel.inert = !open;
  btnEditorAiPanel.setAttribute('aria-expanded', String(open));
  btnEditorAiPanel.title = open ? '收起编辑器 AI' : '打开编辑器 AI';
  syncEditorDrawerBackdrop();
  if (open) {
    await Promise.all([
      editorAiAllConversations.length ? Promise.resolve() : loadEditorAiConversations(),
      loadEditorAiModelContext({ quiet: true }),
    ]);
  }
  if (open) {
    renderEditorAiMessages();
    renderEditorAiHistory();
    updateEditorAiSendState();
    requestAnimationFrame(() => {
      positionEditorAiWindow();
      contentEditor.layout();
      resizeEditorAiInput();
      if (focusInput) editorAiInput.focus();
    });
  } else {
    setEditorAiHistoryOpen(false);
    requestAnimationFrame(() => contentEditor.layout());
  }
}

function getEditorAiContext() {
  const content = contentEditor.getValue();
  const selection = contentEditor.getSelection();
  return {
    logId: state.editingId || '',
    title: editTitle.value,
    content,
    selection: {
      start: selection.start,
      end: selection.end,
      text: content.slice(selection.start, selection.end),
    },
  };
}

async function sendEditorAiMessage({ forceImage = false } = {}) {
  if (!editorAiInput) return;
  const content = editorAiInput.value.trim();
  const attachments = forceImage ? [] : editorAiPendingMedia.map(item => ({ ...item }));
  if ((!content && !attachments.length) || editorAiMediaUploading) return;
  if (forceImage && editorAiPendingMedia.length) return showToast('生图和媒体理解是两个独立操作，请先发送或移除附件', 'info');
  const chat = activeEditorAiConversation();
  if (isEditorAiConversationPending(chat.id)) return;
  await loadEditorAiModelContext({ quiet: true });
  const requestOptions = editorAiRequestOptions(chat);
  const selectedModel = editorAiModelMeta(requestOptions.model);
  if (!selectedModel) return showToast('当前模型已不在可用目录中，请重新选择模型', 'error');
  if (attachments.length || chat.messages.some(message => message.attachments?.length)) {
    const allAttachments = [...attachments, ...chat.messages.flatMap(message => message.attachments || [])];
    const needsVideo = allAttachments.some(item => item.kind === 'video' || String(item.mimeType || '').startsWith('video/'));
    const needsImage = allAttachments.some(item => !item.kind || item.kind === 'image' || String(item.mimeType || '').startsWith('image/'));
    if ((needsImage && !selectedModel.inputModalities?.includes('image')) ||
        (needsVideo && !selectedModel.inputModalities?.includes('video'))) {
      return showToast(`${selectedModel.name} 不支持当前会话中的附件类型，请切换兼容模型`, 'error');
    }
  }
  chat.model = requestOptions.model;
  if (getCategoryValue().startsWith('日记')) chat.diarySensitive = true;
  const userMessage = { role: 'user', content };
  if (attachments.length) userMessage.attachments = attachments;
  chat.messages.push(userMessage);
  if (!chat.title || chat.title === '日志对话' || chat.title === '当前日志') {
    chat.title = conversationTitleFrom(content || attachments.map(item => item.name).join('、'));
  }
  if (chat.messages.length > EDITOR_AI_MAX_MESSAGES) chat.messages = chat.messages.slice(-EDITOR_AI_MAX_MESSAGES);
  chat.updatedAt = Date.now();
  editorAiInput.value = '';
  resizeEditorAiInput();
  if (attachments.length) {
    editorAiPendingMedia = [];
    renderEditorAiPendingMedia();
  }
  if (forceImage) {
    const prompt = editorImagePromptFrom(content);
    const assistantMessage = {
      role: 'assistant',
      content: '正在优化生图 prompt，请稍等...',
      imageGeneration: {
        status: 'optimizing',
        originalPrompt: prompt,
        selectedPrompt: prompt,
        promptMode: 'original',
        prompt,
        model: DEFAULT_SEEDREAM_MODEL,
        size: DEFAULT_SEEDREAM_SIZE,
        watermark: true,
      },
    };
    chat.messages.push(assistantMessage);
    chat.updatedAt = Date.now();
    await saveEditorAiConversations();
    renderEditorAiMessages();
    renderEditorAiHistory();
    updateEditorAiSendState();
    try {
      const optimizedPrompt = await optimizeEditorImagePrompt(prompt, requestOptions);
      assistantMessage.imageGeneration.optimizedPrompt = optimizedPrompt;
      assistantMessage.imageGeneration.promptMode = optimizedPrompt ? 'optimized' : 'original';
      assistantMessage.imageGeneration.selectedPrompt = selectedEditorImagePrompt(assistantMessage.imageGeneration);
      assistantMessage.imageGeneration.prompt = assistantMessage.imageGeneration.selectedPrompt;
      assistantMessage.imageGeneration.status = 'pending';
      assistantMessage.content = optimizedPrompt
        ? '我已经优化了生图 prompt，你可以选择原始提问或优化版本后生成。'
        : '我保留了原始 prompt，请确认后生成图片。';
    } catch (err) {
      assistantMessage.imageGeneration.status = 'pending';
      assistantMessage.imageGeneration.promptMode = 'original';
      assistantMessage.imageGeneration.selectedPrompt = prompt;
      assistantMessage.imageGeneration.prompt = prompt;
      assistantMessage.content = `Prompt 优化失败，已保留原始提问，可直接生成图片。\n\n${err.message}`;
    }
    chat.updatedAt = Date.now();
    await saveEditorAiConversations();
    renderEditorAiMessages();
    renderEditorAiHistory();
    editorAiInput.focus();
    return;
  }
  const requestChatId = chat.id;
  const requestLogKey = chat.logKey;
  const requestMessages = chat.messages.map(message => ({ ...message }));
  const requestContext = getEditorAiContext();
  setEditorAiConversationPending(requestChatId, true);
  await saveEditorAiConversations();
  if (isEditorAiConversationVisible(requestChatId, requestLogKey)) renderEditorAiMessages();
  renderEditorAiHistory();
  updateEditorAiSendState();

  try {
    const res = await apiFetch('/api/ai/editor', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...requestOptions,
        messages: requestMessages,
        editorContext: requestContext,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'AI 请求失败');
    if (!data.message?.content) throw new Error('AI 没有返回内容');
    const targetChat = findEditorAiConversationById(requestChatId);
    if (targetChat) {
      const assistantMessage = {
        role: 'assistant',
        content: data.message.content,
        editorSuggestion: data.editorSuggestion || {},
        sources: Array.isArray(data.sources) ? data.sources : [],
      };
      if (data.message.reasoningContent) assistantMessage.reasoningContent = data.message.reasoningContent;
      if (Array.isArray(data.message.providerTrace) && data.message.providerTrace.length) assistantMessage.providerTrace = data.message.providerTrace;
      if (Array.isArray(data.message.openrouterReasoningDetails) && data.message.openrouterReasoningDetails.length) assistantMessage.openrouterReasoningDetails = data.message.openrouterReasoningDetails;
      if (data.message.provider) assistantMessage.provider = data.message.provider;
      if (data.message.modelId) assistantMessage.modelId = data.message.modelId;
      targetChat.messages.push(assistantMessage);
      if (targetChat.messages.length > EDITOR_AI_MAX_MESSAGES) targetChat.messages = targetChat.messages.slice(-EDITOR_AI_MAX_MESSAGES);
      targetChat.updatedAt = Date.now();
      await saveEditorAiConversations();
      renderEditorAiHistory();
    }
  } catch (err) {
    showToast('编辑器 AI 请求失败：' + err.message, 'error');
  } finally {
    setEditorAiConversationPending(requestChatId, false);
    if (isEditorAiConversationVisible(requestChatId, requestLogKey)) {
      renderEditorAiMessages();
      editorAiInput.focus();
    }
    updateEditorAiSendState();
  }
}

async function newEditorAiConversation() {
  const chat = createEditorAiConversation();
  editorAiAllConversations.push(chat);
  editorAiActiveConversationId = chat.id;
  await saveEditorAiConversations();
  renderEditorAiMessages();
  renderEditorAiHistory();
  updateEditorAiSendState();
  editorAiInput.focus();
}

function applyEditorAiSuggestion(index, action) {
  const chat = activeEditorAiConversation();
  const message = chat.messages[index];
  const suggestion = getEditorAiSuggestion(message);
  const content = contentEditor.getValue();
  const selection = contentEditor.getSelection();
  const insertText = suggestion.insertText || suggestion.suggestedContent || suggestion.reply || '';
  if (action === 'title' && suggestion.suggestedTitle) {
    editTitle.value = suggestion.suggestedTitle;
    autoSave();
    showToast('已应用标题建议', 'success');
    return;
  }
  if (action === 'insert' && insertText) {
    contentEditor.insertAtSelection(insertText);
    contentEditor.focus();
    autoSave();
    showToast('已插入 AI 建议', 'success');
    return;
  }
  if (action === 'replace-selection' && insertText) {
    if (selection.start === selection.end) {
      showToast('请先选择要替换的正文', 'error');
      return;
    }
    const nextValue = content.slice(0, selection.start) + insertText + content.slice(selection.end);
    const cursor = selection.start + insertText.length;
    contentEditor.applyValue(nextValue, cursor, cursor);
    contentEditor.focus();
    autoSave();
    showToast('已替换选区', 'success');
    return;
  }
  if (action === 'replace-body' && suggestion.suggestedContent) {
    contentEditor.applyValue(suggestion.suggestedContent, suggestion.suggestedContent.length, suggestion.suggestedContent.length);
    contentEditor.focus();
    autoSave();
    showToast('已替换正文', 'success');
  }
}

function extractMarkdownHeadings(markdown) {
  const headings = [];
  const lines = (markdown || '').split(/\n/);
  let offset = 0;
  let inFence = false;
  let fenceMarker = '';

  lines.forEach(line => {
    const fence = /^(\s*)(`{3,}|~{3,})/.exec(line);
    if (fence) {
      const marker = fence[2][0];
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
      } else if (marker === fenceMarker) {
        inFence = false;
        fenceMarker = '';
      }
    }

    if (!inFence) {
      const match = /^(#{1,6})[ \t]+(.+?)[ \t#]*$/.exec(line);
      if (match) {
        const text = match[2]
          .replace(/\\([\\`*_[\]{}()#+\-.!>])/g, '$1')
          .replace(/[`*_~[\]]/g, '')
          .trim();
        if (text) headings.push({ level: match[1].length, text, pos: offset });
      }
    }
    offset += line.length + 1;
  });

  return headings;
}

function renderOutline() {
  const headings = extractMarkdownHeadings(contentEditor.getValue());
  if (!headings.length) {
    editorOutlineList.innerHTML = '<div class="editor-outline-empty">暂无标题</div>';
    return;
  }
  editorOutlineList.innerHTML = headings.map(heading => `
    <button type="button" class="editor-outline-item level-${heading.level}" style="--outline-level:${heading.level}" data-pos="${heading.pos}" title="${escHtml(heading.text)}">
      <span class="editor-outline-level">H${heading.level}</span>
      <span class="editor-outline-text">${escHtml(heading.text)}</span>
    </button>
  `).join('');
  syncOutlineCurrent();
}

function syncOutlineCurrent(cursor = contentEditor.getSelection().start) {
  const items = [...editorOutlineList.querySelectorAll('.editor-outline-item')];
  if (!items.length) return;
  let current = items[0];
  items.forEach(item => {
    const pos = parseInt(item.dataset.pos, 10);
    if (Number.isFinite(pos) && pos <= cursor) current = item;
  });
  items.forEach(item => {
    const active = item === current;
    item.classList.toggle('is-current', active);
    if (active) {
      item.setAttribute('aria-current', 'true');
    } else {
      item.removeAttribute('aria-current');
    }
  });
}

function setEditorFullscreen(enabled) {
  const wasEnabled = document.body.classList.contains('editor-fullscreen');
  if (enabled && !wasEnabled) {
    editorFullscreenPreviousTab = editorTab;
    if (editorTab !== 'write') switchTab('write');
    setOutlinePanelOpen(false, { closeAi: false });
    void setEditorAiPanelOpen(false, { closeOutline: false, focusInput: false });
  }
  document.body.classList.toggle('editor-fullscreen', enabled);
  renderEditorFullscreenButton(enabled);
  setEditorToolbarMoreOpen(false);
  if (!enabled && wasEnabled) {
    const tabToRestore = editorFullscreenPreviousTab;
    editorFullscreenPreviousTab = '';
    if (tabToRestore && tabToRestore !== editorTab) switchTab(tabToRestore);
  }
  requestAnimationFrame(() => contentEditor.layout());
}

export function showListView() {
  invalidateEditorRequests();
  setEditorFullscreen(false);
  setOutlinePanelOpen(false);
  setEditorAiPanelOpen(false);
  setEditorToolbarMoreOpen(false);
  listView.style.display = 'flex';
  editorView.style.display = 'none';
  categoryView.style.display = 'none';
  if (aiChatView) aiChatView.style.display = 'none';
  if (aiSettingsView) aiSettingsView.style.display = 'none';
  if (todoView) todoView.style.display = 'none';
  if (photoWallView) photoWallView.style.display = 'none';
  state.editingId = null;
  clearAutoSave();
  contentEditor.setVisible(false);
  loadLogs();
  if (state.listScrollY) {
    requestAnimationFrame(() => window.scrollTo({ top: state.listScrollY, behavior: 'instant' }));
    state.listScrollY = null;
  }
}

function showEditorView() {
  listView.style.display = 'none';
  categoryView.style.display = 'none';
  if (aiChatView) aiChatView.style.display = 'none';
  if (aiSettingsView) aiSettingsView.style.display = 'none';
  if (todoView) todoView.style.display = 'none';
  if (photoWallView) photoWallView.style.display = 'none';
  editorView.style.display = 'flex';
}

function getCategoryValue() {
  const parent = editCategory.value;
  const sub = editSubcategory.value;
  return sub ? parent + '/' + sub : parent;
}

function getNewLogCategory() {
  const [filteredParent = '', ...subParts] = (state.category || '').split('/');
  const filteredSub = subParts.join('/');
  const matchingCategory = state.categories.find(category => category.name === filteredParent);

  if (matchingCategory && (!filteredSub || (matchingCategory.sub || []).includes(filteredSub))) {
    return {
      parent: filteredParent,
      sub: filteredSub,
      value: filteredSub ? `${filteredParent}/${filteredSub}` : filteredParent,
    };
  }

  const fallback = state.categories.some(category => category.name === '其他')
    ? '其他'
    : state.categories[0]?.name || '其他';
  return { parent: fallback, sub: '', value: fallback };
}

function updateDirtyState() {
  const title = editTitle.value.trim();
  const content = contentEditor.getValue();
  const date = editDate.value;
  const hours = editHours.value;
  const category = getCategoryValue();

  const dirty = (
    title !== lastSavedTitle ||
    content !== lastSavedContent ||
    date !== lastSavedDate ||
    hours !== lastSavedHours ||
    category !== lastSavedCategory
  );

  if (dirty !== isDirty) {
    isDirty = dirty;
    if (dirty) {
      saveStatus.textContent = '●';
      saveStatus.title = '未保存';
      document.title = '* 工作日志';
    } else {
      saveStatus.textContent = '';
      saveStatus.title = '';
      document.title = '工作日志';
    }
  }
}

export async function openEditor(id) {
  const requestEpoch = invalidateEditorRequests();
  const controller = new AbortController();
  activeEditorLoadController = controller;
  try {
    const res = await apiFetch(`/api/logs/${id}`, { signal: controller.signal });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Load failed');
    const log = await res.json();
    if (requestEpoch !== editorDocumentEpoch || controller.signal.aborted) return false;
    activeEditorLoadController = null;
    state.editingId = id;
    state.listScrollY = window.scrollY;
    showEditorView();
    editTitle.value = log.title;
    contentEditor.loadDocument(log.content, `log-${id}`);
    renderOutline();
    editDate.value = log.log_date || '';
    editHours.value = log.hours;
    lastSavedContent = log.content;
    lastSavedTitle = log.title;
    lastSavedDate = log.log_date || '';
    lastSavedHours = String(log.hours);
    lastSavedCategory = log.category;

    // Parse "parent/sub" into parent and sub dropdowns
    const slashIdx = log.category.indexOf('/');
    const parent = slashIdx === -1 ? log.category : log.category.substring(0, slashIdx);
    const sub = slashIdx === -1 ? '' : log.category.substring(slashIdx + 1);
    if ([...editCategory.options].some(o => o.value === parent)) {
      editCategory.value = parent;
    } else {
      editCategory.value = '其他';
    }
    populateEditorSubCategory(editCategory.value);
    syncEditorSelectControls();
    if (sub) {
      setTimeout(() => {
        if (requestEpoch !== editorDocumentEpoch) return;
        if ([...editSubcategory.options].some(o => o.value === sub)) {
          editSubcategory.value = sub;
        }
        syncEditorSelectControls();
      }, 0);
    } else {
      syncEditorSelectControls();
    }

    isDirty = false;
    saveStatus.textContent = '';
    document.title = '工作日志';

    switchTab(editorTab);
    editorAiActiveConversationId = '';
    if (editorView.classList.contains('editor-ai-open')) {
      renderEditorAiMessages();
      updateEditorAiSendState();
    }
    if (editorTab !== 'preview') contentEditor.focus();
    return true;
  } catch (err) {
    if (err.name === 'AbortError' || requestEpoch !== editorDocumentEpoch) return false;
    activeEditorLoadController = null;
    console.error('Load log failed:', err);
    showToast('加载日志失败: ' + err.message, 'error');
    return false;
  }
}

export async function newLog() {
  if (currentSavePromise) await currentSavePromise;
  invalidateEditorRequests();
  const defaultDate = state.selectedDate || businessDateString();
  const defaultCategory = getNewLogCategory();
  editorAiDraftSessionId = `draft-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  editorAiActiveConversationId = '';
  state.listScrollY = window.scrollY;
  state.editingId = null;
  lastSavedContent = '';
  lastSavedTitle = '';
  lastSavedDate = defaultDate;
  lastSavedHours = '0';
  lastSavedCategory = defaultCategory.value;
  editTitle.value = '';
  contentEditor.loadDocument('', 'new-log');
  renderOutline();
  editDate.value = defaultDate;
  editHours.value = '0';
  editCategory.value = defaultCategory.parent;
  populateEditorSubCategory(defaultCategory.parent);
  editSubcategory.value = defaultCategory.sub;
  syncEditorSelectControls();
  saveStatus.textContent = '';
  isDirty = false;
  document.title = '工作日志';
  showEditorView();
  switchTab(editorTab);
  if (editorView.classList.contains('editor-ai-open')) {
    renderEditorAiMessages();
    updateEditorAiSendState();
  }
  if (editorTab !== 'preview') contentEditor.focus();
}

$('#btnNewLog').addEventListener('click', newLog);

export async function leaveEditorSafely({ showList = false } = {}) {
  if (editorView.style.display === 'none') return true;
  clearAutoSave();
  if (currentSavePromise) await currentSavePromise;
  updateDirtyState();

  if (state.editingId || editTitle.value.trim() || contentEditor.getValue().trim()) {
    const saved = await doSave(false);
    if (!saved) return false;
    updateDirtyState();
    if (isDirty) {
      showToast('仍有未保存内容，请稍后再返回', 'error');
      return false;
    }
  }
  if (showList) {
    showListView();
    loadStats();
  }
  return true;
}

async function returnToListAfterSave() {
  return leaveEditorSafely({ showList: true });
}

export function clearEditorForDiaryLock() {
  invalidateEditorRequests();
  clearAutoSave();
  state.editingId = null;
  editTitle.value = '';
  contentEditor.loadDocument('', 'diary-locked');
  editPreview.textContent = '';
  editorAiMessages.textContent = '';
  editorAiAllConversations = [];
  editorAiActiveConversationId = '';
  lastSavedContent = '';
  lastSavedTitle = '';
  isDirty = false;
}

export async function openEditorFromNavigation(id) {
  const targetId = parseInt(id, 10);
  if (!Number.isFinite(targetId)) return false;
  if (state.editingId === targetId) return true;

  const inEditor = editorView.style.display !== 'none';
  if (inEditor) {
    clearAutoSave();
    if (currentSavePromise) await currentSavePromise;
    updateDirtyState();

    if (state.editingId || editTitle.value.trim() || contentEditor.getValue().trim()) {
      const saved = await doSave(false);
      if (!saved) return false;
      updateDirtyState();
      if (isDirty) {
        showToast('仍有未保存内容，请稍后再切换', 'error');
        return false;
      }
    }
  }

  return openEditor(targetId);
}

$('#btnBack').addEventListener('click', () => {
  returnToListAfterSave();
});

btnEditorFullscreen.addEventListener('click', () => {
  setEditorFullscreen(!document.body.classList.contains('editor-fullscreen'));
});

btnEditorOutlinePanel.addEventListener('click', () => {
  const open = btnEditorOutlinePanel.getAttribute('aria-expanded') !== 'true';
  setOutlinePanelOpen(open);
});

btnCloseOutlinePanel.addEventListener('click', () => {
  setOutlinePanelOpen(false);
  btnEditorOutlinePanel.focus();
});

btnEditorAiPanel.addEventListener('click', () => {
  const open = btnEditorAiPanel.getAttribute('aria-expanded') !== 'true';
  setEditorAiPanelOpen(open);
});

btnCloseEditorAiPanel.addEventListener('click', () => {
  setEditorAiPanelOpen(false);
  btnEditorAiPanel.focus();
});
editorAiBackdrop?.addEventListener('click', () => {
  if (isEditorAiPanelOpen()) {
    setEditorAiPanelOpen(false);
    btnEditorAiPanel.focus();
    return;
  }
  if (isOutlinePanelOpen()) {
    setOutlinePanelOpen(false);
    btnEditorOutlinePanel.focus();
  }
});

btnEditorAiNew.addEventListener('click', newEditorAiConversation);
btnEditorAiHistory.addEventListener('click', () => {
  setEditorAiHistoryOpen(btnEditorAiHistory.getAttribute('aria-expanded') !== 'true');
});
btnEditorAiSettings.addEventListener('click', openEditorAiSettings);
btnEditorAiModel?.addEventListener('click', openEditorAiModelPicker);
document.addEventListener('editor-ai-model-selected', selectEditorAiModel);
btnEditorAiHistoryClose.addEventListener('click', () => setEditorAiHistoryOpen(false));
btnEditorAiSend.addEventListener('click', sendEditorAiMessage);
btnEditorAiImage?.addEventListener('click', () => sendEditorAiMessage({ forceImage: true }));
btnEditorAiAttach?.addEventListener('click', () => editorAiMediaInput?.click());
editorAiMediaInput?.addEventListener('change', (event) => uploadEditorAiMediaFiles(event.target.files || []));
editorAiMediaDrafts?.addEventListener('click', (event) => {
  const button = event.target.closest('[data-action="remove-editor-ai-media"]');
  const draft = button?.closest('[data-media-id]');
  if (draft) removeEditorAiPendingMedia(draft.dataset.mediaId);
});
editorAiInput.addEventListener('input', () => {
  resizeEditorAiInput();
  updateEditorAiSendState();
});
editorAiInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    sendEditorAiMessage();
  }
});
editorAiMessages.addEventListener('click', (event) => {
  const imageAction = event.target.closest('.ai-image-card [data-action]');
  if (imageAction) {
    const item = imageAction.closest('.editor-ai-message');
    const index = Number(item?.dataset.messageIndex);
    if (!Number.isInteger(index)) return;
    const action = imageAction.dataset.action;
    if (action === 'choose-editor-image-prompt') return chooseEditorImagePrompt(index, imageAction.dataset.promptMode);
    if (action === 'generate-editor-image') return generateEditorImageForMessage(index);
    if (action === 'cancel-editor-image') return cancelEditorImageGeneration(index);
    if (action === 'copy-editor-image-markdown') return copyEditorImageMarkdown(index);
    if (action === 'insert-editor-image-markdown') return insertEditorGeneratedImage(index);
  }
  const toggleButton = event.target.closest('[data-editor-ai-toggle-suggestion]');
  if (toggleButton) {
    const card = toggleButton.closest('.editor-ai-suggestion-card');
    const expanded = card?.classList.toggle('expanded');
    card?.classList.toggle('collapsed', !expanded);
    toggleButton.setAttribute('aria-expanded', String(Boolean(expanded)));
    toggleButton.textContent = expanded ? '收起' : '展开';
    return;
  }
  const button = event.target.closest('[data-editor-ai-apply]');
  if (!button) return;
  const index = Number(button.dataset.messageIndex);
  if (!Number.isInteger(index)) return;
  applyEditorAiSuggestion(index, button.dataset.editorAiApply);
});
editorAiHistoryList.addEventListener('click', (event) => {
  const item = event.target.closest('.editor-ai-history-item');
  if (!item) return;
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (action === 'rename') return openEditorAiRenameModal(item.dataset.id);
  if (action === 'delete') return deleteEditorAiConversation(item.dataset.id);
  switchEditorAiConversation(item.dataset.id);
});
editorAiRenameOverlay.addEventListener('click', (event) => {
  if (event.target === editorAiRenameOverlay) closeEditorAiRenameModal();
});
$('#editorAiRenameClose').addEventListener('click', closeEditorAiRenameModal);
$('#btnEditorAiRenameCancel').addEventListener('click', closeEditorAiRenameModal);
$('#btnEditorAiRenameSave').addEventListener('click', saveEditorAiRename);
editorAiRenameInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') saveEditorAiRename();
});
editorAiDragHandle?.addEventListener('pointerdown', startEditorAiWindowDrag);
editorAiDragHandle?.addEventListener('pointermove', moveEditorAiWindow);
editorAiDragHandle?.addEventListener('pointerup', endEditorAiWindowDrag);
editorAiDragHandle?.addEventListener('pointercancel', endEditorAiWindowDrag);
editorAiDragHandle?.addEventListener('dblclick', (event) => {
  if (event.target.closest('button, input, textarea, a, [role="button"]')) return;
  resetEditorAiWindowPosition();
  showToast('已恢复 AI 浮窗默认位置', 'success');
});
window.addEventListener('resize', () => {
  if (isEditorAiPanelOpen()) requestAnimationFrame(() => positionEditorAiWindow());
});

editorOutlineList.addEventListener('click', (e) => {
  const item = e.target.closest('.editor-outline-item');
  if (!item) return;
  const pos = parseInt(item.dataset.pos, 10);
  if (!Number.isFinite(pos)) return;
  if (editorTab === 'preview') switchTab('write');
  syncOutlineCurrent(pos);
  contentEditor.setSelection(pos, pos);
  contentEditor.focus();
});

btnEditorToolbarMore?.addEventListener('click', (event) => {
  event.preventDefault();
  const open = btnEditorToolbarMore.getAttribute('aria-expanded') !== 'true';
  setEditorToolbarMoreOpen(open);
});

document.addEventListener('click', (event) => {
  if (!editorToolbarMoreMenu || !btnEditorToolbarMore) return;
  if (!event.target.closest('.toolbar-group-more')) setEditorToolbarMoreOpen(false);
});

// Auto-save with dirty detection
function autoSave() {
  updateDirtyState();
  clearAutoSave();
  if (!isDirty) return;
  autoSaveTimer = setTimeout(() => {
    if (state.editingId || editTitle.value.trim() || contentEditor.getValue().trim()) {
      doSave(true);
    }
  }, AUTO_SAVE_MS);
}

function clearAutoSave() {
  if (autoSaveTimer) {
    clearTimeout(autoSaveTimer);
    autoSaveTimer = null;
  }
}

export async function doSave(silent) {
  if (isSaving) return currentSavePromise || false;
  const title = editTitle.value.trim();
  const content = contentEditor.getValue();
  const log_date = editDate.value;
  const hours = parseFloat(editHours.value) || 0;
  const category = getCategoryValue();

  if (!content) {
    if (!silent) showToast('请填写内容', 'error');
    return false;
  }

  const finalTitle = title || '未命名日志';
  const body = { title: finalTitle, content, log_date, hours, category };
  const requestEpoch = editorDocumentEpoch;
  const requestEditingId = state.editingId;
  const wasNewLog = !requestEditingId;
  const url = requestEditingId ? `/api/logs/${requestEditingId}` : '/api/logs';
  const method = requestEditingId ? 'PUT' : 'POST';

  isSaving = true;
  currentSavePromise = (async () => {
    try {
      saveStatus.style.color = '';
      if (!silent) saveStatus.textContent = '保存中...';
      const res = await apiFetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Save failed');

      const saved = await res.json();
      const sameDocument = requestEpoch === editorDocumentEpoch && state.editingId === requestEditingId;
      if (!sameDocument) return true;
      if (wasNewLog) {
        state.editingId = saved.id;
      }
      lastSavedContent = content;
      lastSavedTitle = finalTitle;
      lastSavedDate = log_date;
      lastSavedHours = String(hours);
      lastSavedCategory = category;
      saveStatus.style.color = '';
      updateDirtyState();

      if (isDirty) {
        saveStatus.textContent = '●';
        saveStatus.title = '未保存';
        if (silent) autoSave();
      } else if (silent) {
        saveStatus.textContent = '已自动保存';
        setTimeout(() => { if (saveStatus.textContent === '已自动保存') { saveStatus.textContent = ''; } }, SAVE_STATUS_DURATION);
      } else {
        saveStatus.textContent = '已保存';
        setTimeout(() => { if (saveStatus.textContent === '已保存') { saveStatus.textContent = ''; } }, SAVE_STATUS_DURATION);
      }
      if (wasNewLog) await migrateEditorAiDraftConversation(saved.id);
      return true;
    } catch (err) {
      saveStatus.textContent = '保存失败';
      saveStatus.style.color = 'var(--color-danger)';
      showToast('保存失败: ' + err.message, 'error');
      console.error(err);
      return false;
    } finally {
      isSaving = false;
      currentSavePromise = null;
    }
  })();

  return currentSavePromise;
}

// Modal helpers
function closeAllModals() {
  closeModal($('#logLinkOverlay'));
  closeModal($('#templateModalOverlay'));
  closeModal($('#shortcutHelpOverlay'));
  closeModal($('#diaryUnlockOverlay'));
}

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  if (e.defaultPrevented) return;
  if (isImeComposingEvent(e) || contentEditor.isComposing()) return;
  const tag = document.activeElement.tagName;
  const isInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || contentEditor.hasFocus();

  const action = findAction(e);
  if (!action) return;
  if (isInput && action !== 'escape' && !e.ctrlKey && !e.metaKey && !e.altKey) return;

  const inEditor = editorView.style.display !== 'none';
  const focusedOnContent = contentEditor.hasFocus();

  switch (action) {
    case 'save':
      if (inEditor) { e.preventDefault(); doSave(); }
      break;
    case 'preview':
      if (inEditor) { e.preventDefault(); switchTab(nextEditorTab()); }
      break;
    case 'bold':
      if (focusedOnContent) { e.preventDefault(); insertMarkdown('bold'); }
      break;
    case 'italic':
      if (focusedOnContent) { e.preventDefault(); insertMarkdown('italic'); }
      break;
    case 'newLog':
      e.preventDefault(); newLog();
      break;
    case 'search':
      if (focusedOnContent && contentEditor.usesRichEditor()) return;
      e.preventDefault();
      { const si = $('#searchInput'); si.focus(); si.select(); }
      break;
    case 'clearFilter':
      e.preventDefault();
      state.search = ''; state.category = ''; state.month = '';
      state.selectedDate = null; state.currentPage = 1;
      $('#searchInput').value = '';
      $('#filterCategory').value = '';
      $('#filterSubcategory').value = '';
      $('#filterSubcategory').style.display = 'none';
      $('#filterMonth').value = '';
      syncArchiveFilterControls();
      renderCalendar();
      loadLogs();
      break;
    case 'help':
      if (!isInput) { e.preventDefault(); openModal($('#shortcutHelpOverlay'), '#shortcutHelpClose'); }
      break;
    case 'escape':
      if (document.getElementById('genericConfirmOverlay')?.style.display === 'flex') {
        e.preventDefault();
      } else if ($('#aiModelPickerOverlay')?.style.display === 'flex') {
        e.preventDefault();
      } else if ($('#logLinkOverlay').style.display === 'flex' || $('#templateModalOverlay').style.display === 'flex' || $('#shortcutHelpOverlay').style.display === 'flex' || $('#diaryUnlockOverlay').style.display === 'flex') {
        e.preventDefault(); closeAllModals();
      } else if (categoryView.style.display !== 'none') {
        e.preventDefault(); closeCategoryManager();
      } else if (inEditor) {
        if (focusedOnContent && contentEditor.hasOpenWidget()) return;
        if (btnEditorToolbarMore?.getAttribute('aria-expanded') === 'true') {
          e.preventDefault();
          setEditorToolbarMoreOpen(false);
          btnEditorToolbarMore.focus();
          return;
        }
        if (isEditorAiPanelOpen()) {
          e.preventDefault();
          setEditorAiPanelOpen(false);
          btnEditorAiPanel.focus();
          return;
        }
        if (isOutlinePanelOpen()) {
          e.preventDefault();
          setOutlinePanelOpen(false);
          btnEditorOutlinePanel.focus();
          return;
        }
        if (document.body.classList.contains('editor-fullscreen')) {
          e.preventDefault();
          setEditorFullscreen(false);
          return;
        }
        e.preventDefault(); returnToListAfterSave();
      }
      break;
  }
});

// Shortcut manager UI
let pendingEditAction = null;
let pendingNewKeys = null;

function renderShortcutList() {
  const list = $('#shortcutList');
  const all = getAllShortcuts();
  const actions = Object.keys(all);
  if (actions.length === 0) {
    list.innerHTML = '<div class="shortcut-empty">暂无快捷键</div>';
    return;
  }
  list.innerHTML = actions.map(action => {
    const s = all[action];
    return `
      <div class="shortcut-row">
        <span class="shortcut-desc">${escHtml(s.description || action)}</span>
        <button class="shortcut-keys ${s.custom ? 'is-custom' : ''}" data-action="${escHtml(action)}" title="点击修改快捷键">${renderKbd(s.keys)}</button>
        ${s.custom ? '<span class="shortcut-custom-tag">已修改</span>' : ''}
      </div>
    `;
  }).join('');
}

function renderKbd(combo) {
  return combo.split('+').map(p => `<kbd>${escHtml(p.trim())}</kbd>`).join('<span class="kbd-plus">+</span>');
}

function startRebind(action) {
  const el = document.querySelector(`.shortcut-keys[data-action="${CSS.escape(action)}"]`);
  if (!el) return;
  pendingEditAction = action;
  pendingNewKeys = { ctrl: false, shift: false, alt: false, key: '' };
  el.classList.add('listening');
  el.innerHTML = '<kbd class="kbd-listen">按下组合键...</kbd>';
  el.focus();
}

function cancelRebind() {
  pendingEditAction = null;
  pendingNewKeys = null;
  renderShortcutList();
}

function commitRebind() {
  if (!pendingEditAction || !pendingNewKeys || !pendingNewKeys.key) {
    cancelRebind();
    return;
  }
  const newCombo = formatKeys(pendingNewKeys);
  const conflict = isComboUsed(newCombo, pendingEditAction);
  if (conflict) {
    showToast(`冲突: 已被「${getAllShortcuts()[conflict]?.description || conflict}」使用`, 'error');
    cancelRebind();
    return;
  }
  setShortcut(pendingEditAction, { keys: newCombo });
  pendingEditAction = null;
  pendingNewKeys = null;
  renderShortcutList();
  showToast('快捷键已更新', 'success');
}

$('#shortcutList').addEventListener('click', (e) => {
  const keysEl = e.target.closest('.shortcut-keys');
  if (keysEl) {
    startRebind(keysEl.dataset.action);
    return;
  }
});

$('#shortcutList').addEventListener('keydown', (e) => {
  if (!pendingEditAction) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.key === 'Escape') { cancelRebind(); return; }
  if (e.key === 'Enter') { commitRebind(); return; }
  // Capture modifier key combo
  const key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  if (['Control','Shift','Alt','Meta'].includes(e.key)) return;
  pendingNewKeys = {
    ctrl: e.ctrlKey || e.metaKey,
    shift: e.shiftKey,
    alt: e.altKey,
    key: key,
  };
  const el = document.querySelector(`.shortcut-keys[data-action="${CSS.escape(pendingEditAction)}"]`);
  if (el) el.innerHTML = renderKbd(formatKeys(pendingNewKeys));
});

// Close on click outside
$('#shortcutList').addEventListener('blur', (e) => {
  // Small delay to allow click on other elements
  if (pendingEditAction && !e.relatedTarget?.closest('.shortcut-keys') && !e.relatedTarget?.closest('#shortcutList')) {
    cancelRebind();
  }
}, true);

// Reset all shortcuts
$('#btnShortcutReset').addEventListener('click', () => {
  resetAllShortcuts();
  renderShortcutList();
  showToast('已恢复默认快捷键');
});

// Render list when modal opens
const shortcutOverlay = $('#shortcutHelpOverlay');
const observer = new MutationObserver(() => {
  if (shortcutOverlay.style.display === 'flex') renderShortcutList();
});
observer.observe(shortcutOverlay, { attributes: true, attributeFilter: ['style'] });

// Close handlers
$('#shortcutHelpClose').addEventListener('click', () => { closeModal(shortcutOverlay); });
$('#shortcutHelpDone').addEventListener('click', () => { closeModal(shortcutOverlay); });
shortcutOverlay.addEventListener('click', (e) => {
  if (e.target === shortcutOverlay) closeModal(shortcutOverlay);
});

// Internal log links
function parseInternalLogHref(href) {
  const match = /^#log\/(\d+)$/.exec(href || '');
  if (!match) return null;
  const id = parseInt(match[1], 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function handleInternalLogLinkClick(e) {
  const link = e.target.closest('a[href]');
  if (!link) return false;
  const id = parseInternalLogHref(link.getAttribute('href'));
  if (!id) return false;
  e.preventDefault();
  e.stopPropagation();
  const switched = await openEditorFromNavigation(id);
  if (!switched) showToast('无法打开目标日志', 'error');
  return true;
}

editPreview.addEventListener('click', handleInternalLogLinkClick);

function markdownLinkText(text) {
  return (text || '未命名日志').replace(/([\\\]])/g, '\\$1');
}

function insertLogLink(log) {
  const label = markdownLinkText(log.title || '未命名日志');
  const insert = `[${label}](#log/${log.id})`;
  const value = contentEditor.getValue();
  const { start, end } = contentEditor.getSelection();
  const nextValue = value.substring(0, start) + insert + value.substring(end);
  contentEditor.applyValue(nextValue, start + insert.length);
  contentEditor.focus();
}

let logLinkSearchTimer = null;
let logLinkSearchSeq = 0;
let logLinkResultsById = new Map();

function renderLogLinkResults(items) {
  const results = $('#logLinkResults');
  logLinkResultsById = new Map(items.map(log => [String(log.id), log]));
  if (!items.length) {
    results.innerHTML = '<div class="log-link-empty">没有找到可链接的日志</div>';
    return;
  }
  results.innerHTML = items.map(log => `
    <button type="button" class="log-link-item" data-id="${log.id}">
      <span class="log-link-title">${escHtml(log.title || '未命名日志')}</span>
      <span class="log-link-meta">${escHtml(log.log_date || '无日期')} · ${escHtml(log.category)} · ${log.hours || 0}h</span>
    </button>
  `).join('');
}

async function searchLogLinks() {
  const seq = ++logLinkSearchSeq;
  const query = $('#logLinkSearch').value.trim();
  const results = $('#logLinkResults');
  results.innerHTML = '<div class="log-link-loading">搜索中...</div>';
  const params = new URLSearchParams({ page: '1', limit: '20' });
  if (query) params.set('search', query);
  try {
    const res = await apiFetch(`/api/logs?${params}`);
    const data = await res.json();
    if (seq !== logLinkSearchSeq) return;
    renderLogLinkResults(data.items || []);
  } catch (err) {
    if (seq !== logLinkSearchSeq) return;
    results.innerHTML = `<div class="log-link-empty">搜索失败: ${escHtml(err.message)}</div>`;
  }
}

function openLogLinkPicker() {
  setEditorToolbarMoreOpen(false);
  openModal($('#logLinkOverlay'), '#logLinkSearch');
  $('#logLinkSearch').value = '';
  $('#logLinkResults').innerHTML = '<div class="log-link-loading">加载中...</div>';
  searchLogLinks();
  setTimeout(() => $('#logLinkSearch').focus(), 80);
}

function closeLogLinkPicker() {
  closeModal($('#logLinkOverlay'));
}

$('#btnLogLink').addEventListener('click', openLogLinkPicker);
$('#logLinkClose').addEventListener('click', closeLogLinkPicker);
$('#logLinkDone').addEventListener('click', closeLogLinkPicker);
$('#logLinkOverlay').addEventListener('click', (e) => {
  if (e.target === $('#logLinkOverlay')) closeLogLinkPicker();
});
$('#logLinkSearch').addEventListener('input', () => {
  clearTimeout(logLinkSearchTimer);
  logLinkSearchTimer = setTimeout(searchLogLinks, 250);
});
$('#logLinkSearch').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    $('#logLinkResults .log-link-item')?.click();
  }
});
$('#logLinkResults').addEventListener('click', (e) => {
  const item = e.target.closest('.log-link-item');
  if (!item) return;
  const log = logLinkResultsById.get(item.dataset.id);
  if (!log) return;
  insertLogLink(log);
  closeLogLinkPicker();
});

// Markdown formatting toolbar
function insertMarkdown(action) {
  const value = contentEditor.getValue();
  const { start, end } = contentEditor.getSelection();
  const sel = value.substring(start, end);
  const before = value.substring(0, start);
  const after = value.substring(end);
  let nextValue = value;
  let selectionStart = start;
  let selectionEnd = end;

  const inlineFormats = {
    bold:          { prefix: '**', suffix: '**', placeholder: '加粗文本' },
    italic:        { prefix: '*',  suffix: '*',  placeholder: '斜体文本' },
    strikethrough: { prefix: '~~', suffix: '~~', placeholder: '删除线文本' },
    code:          { prefix: '`',  suffix: '`',  placeholder: '代码' },
    mathInline:    { prefix: '$',  suffix: '$',  placeholder: '公式' },
  };

  const lineFormats = {
    h1:        { prefix: '# ',   placeholder: '标题' },
    h2:        { prefix: '## ',  placeholder: '标题' },
    h3:        { prefix: '### ', placeholder: '标题' },
    ul:        { prefix: '- ',   placeholder: '列表项' },
    ol:        { prefix: '1. ',  placeholder: '列表项' },
    checklist: { prefix: '- [ ] ', placeholder: '任务项' },
    quote:     { prefix: '> ',   placeholder: '引用文本' },
    codeblock:  { prefix: '```\n', suffix: '\n```', placeholder: '代码', line: true },
    mathBlock:  { prefix: '$$\n',  suffix: '\n$$',  placeholder: '公式', line: true },
  };

  if (inlineFormats[action]) {
    const fmt = inlineFormats[action];
    const text = sel || fmt.placeholder;
    const insert = fmt.prefix + text + fmt.suffix;
    nextValue = before + insert + after;
    selectionStart = start + fmt.prefix.length;
    selectionEnd = selectionStart + text.length;
  } else if (lineFormats[action]) {
    const fmt = lineFormats[action];
    if (fmt.line) {
      const text = sel || fmt.placeholder;
      const insert = fmt.prefix + text + fmt.suffix;
      nextValue = before + insert + after;
      selectionStart = start + fmt.prefix.length;
      selectionEnd = selectionStart + text.length;
    } else {
      const lineStart = before.lastIndexOf('\n') + 1;
      const lineEnd = value.indexOf('\n', end);
      const lineAfter = lineEnd === -1 ? '' : value.substring(lineEnd);

      if (sel && sel.includes('\n')) {
        const lines = sel.split('\n').map(l => fmt.prefix + l);
        const insert = lines.join('\n');
        nextValue = before + insert + after;
        selectionEnd = start + insert.length;
      } else {
        const lineContent = value.substring(lineStart, lineEnd === -1 ? value.length : lineEnd);
        const newLine = fmt.prefix + lineContent;
        nextValue = value.substring(0, lineStart) + newLine + lineAfter;
        const cursorPos = lineStart + newLine.length;
        selectionStart = cursorPos;
        selectionEnd = cursorPos;
      }
    }
  } else if (action === 'link') {
    const text = sel || '链接文本';
    const insert = `[${text}](url)`;
    nextValue = before + insert + after;
    const urlStart = start + text.length + 3;
    selectionStart = urlStart;
    selectionEnd = urlStart + 3;
  } else if (action === 'hr') {
    const needNewline = before.length > 0 && !before.endsWith('\n') ? '\n' : '';
    const insert = needNewline + '---\n';
    nextValue = before + insert + after;
    const cursorPos = start + insert.length;
    selectionStart = cursorPos;
    selectionEnd = cursorPos;
  }

  contentEditor.applyValue(nextValue, selectionStart, selectionEnd);
  contentEditor.focus();
}

$('#editorToolbar').addEventListener('click', (e) => {
  const emojiButton = e.target.closest('button[data-emoji]');
  if (emojiButton) {
    e.preventDefault();
    contentEditor.insertAtSelection(emojiButton.dataset.emoji);
    setEditorToolbarMoreOpen(false);
    contentEditor.focus();
    return;
  }
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  e.preventDefault();
  insertMarkdown(btn.dataset.action);
  if (editorToolbarMoreMenu?.contains(btn)) setEditorToolbarMoreOpen(false);
});

// Template insertion and management
const TEMPLATE_STORAGE_KEY = 'workLogTemplates';
const defaultTemplates = [
  { id: 'daily', name: '每日站会', title: '日报 {{today:MM月DD日}}', content: `## {{today}} 今日完成\n- \n\n## {{tomorrow}} 明日计划\n- \n\n## 遇到的问题\n- ` },
  { id: 'weekly', name: '周复盘', title: '周复盘 {{本周:MM月DD日}}', content: `## 本周回顾（{{本周:MM月DD日}}）\n- \n\n## 上周对比（{{上一周:MM月DD日}}）\n- \n\n## 下周计划（{{下一周:MM月DD日}}）\n- \n\n## 收获与反思\n- \n\n## 工时统计\n| 类别 | 小时 |\n|------|------|\n| 开发 | |\n| 会议 | |\n| 文档 | |\n| 其他 | |` },
  { id: 'meeting', name: '会议纪要', title: '会议纪要 {{today:MM月DD日}}', content: `## 会议主题\n\n- 日期：{{today}}\n\n## 参会人\n\n## 讨论内容\n- \n\n## 决议\n- \n\n## 待办事项\n- [ ] ` },
  { id: 'diary', name: '日记', title: '日记 {{today:MM月DD日}}', content: `# {{today:YYYY年MM月DD日 dddd}}\n\n## 今天的事\n\n\n## 心情/感受\n\n\n## 学到的东西\n` },
];
let templates = loadTemplates();
let selectedTemplateId = templates[0]?.id || null;

function renderTemplateContent(content) {
  const baseDate = editDate.value || businessDateString();
  return renderTemplateVariables(content, baseDate);
}

function cloneDefaultTemplates() {
  return defaultTemplates.map(t => ({ ...t }));
}

function loadTemplates() {
  try {
    const parsed = JSON.parse(localStorage.getItem(TEMPLATE_STORAGE_KEY));
    if (Array.isArray(parsed)) {
      return parsed
        .filter(t => t && typeof t.id === 'string' && typeof t.name === 'string' && typeof t.content === 'string')
        .map(t => ({
          id: t.id,
          name: t.name,
          title: typeof t.title === 'string' ? t.title : t.name,
          content: t.content,
        }));
    }
  } catch {
    // Fall back to defaults below.
  }
  return cloneDefaultTemplates();
}

function saveTemplates() {
  localStorage.setItem(TEMPLATE_STORAGE_KEY, JSON.stringify(templates));
}

function populateTemplateSelect() {
  const sel = $('#templateSelect');
  sel.innerHTML = '<option value="">模板</option>' +
    templates.map(t => `<option value="${escHtml(t.id)}">${escHtml(t.name)}</option>`).join('');
}

function insertTemplateContent(content) {
  const renderedContent = renderTemplateContent(content);
  const value = contentEditor.getValue();
  const hasContent = value.trim().length > 0;
  const prefix = hasContent ? '\n\n' : '';
  const { start } = contentEditor.getSelection();
  const nextValue = value.substring(0, start) + prefix + renderedContent + value.substring(start);
  contentEditor.applyValue(nextValue, start + prefix.length + renderedContent.length);
  contentEditor.focus();
}

function applyTemplate(template) {
  if (template.id === 'diary' && $('#btnDiaryLock').style.display !== 'none' &&
      [...editCategory.options].some(option => option.value === '日记')) {
    editCategory.value = '日记';
    populateEditorSubCategory('日记');
    editSubcategory.value = '';
  }
  if (!editTitle.value.trim()) {
    editTitle.value = renderTemplateContent(template.title || template.name);
  }
  insertTemplateContent(template.content);
}

function renderTemplateManager() {
  const list = $('#templateList');
  if (!templates.length) {
    list.innerHTML = '<div class="template-empty">暂无模板</div>';
    selectedTemplateId = null;
    $('#templateNameInput').value = '';
    $('#templateTitleInput').value = '';
    $('#templateContentInput').value = '';
    return;
  }
  if (!templates.some(t => t.id === selectedTemplateId)) selectedTemplateId = templates[0].id;
  list.innerHTML = templates.map(t => `
    <button class="template-list-item ${t.id === selectedTemplateId ? 'active' : ''}" data-id="${escHtml(t.id)}">
      ${escHtml(t.name)}
    </button>
  `).join('');
  const selected = templates.find(t => t.id === selectedTemplateId);
  $('#templateNameInput').value = selected?.name || '';
  $('#templateTitleInput').value = selected?.title || selected?.name || '';
  $('#templateContentInput').value = selected?.content || '';
}

function openTemplateManager() {
  renderTemplateManager();
  openModal($('#templateModalOverlay'), '#templateNameInput');
}

function closeTemplateManager() {
  closeModal($('#templateModalOverlay'));
  populateTemplateSelect();
}

populateTemplateSelect();

$('#templateSelect').addEventListener('change', () => {
  const sel = $('#templateSelect');
  const val = sel.value;
  if (!val) return;
  const template = templates.find(t => t.id === val);
  if (!template) return;
  applyTemplate(template);
  sel.value = '';
});

$('#btnManageTemplates').addEventListener('click', openTemplateManager);
$('#templateModalClose').addEventListener('click', closeTemplateManager);
$('#templateModalDone').addEventListener('click', closeTemplateManager);
$('#templateModalOverlay').addEventListener('click', (e) => {
  if (e.target === $('#templateModalOverlay')) closeTemplateManager();
});

$('#templateList').addEventListener('click', (e) => {
  const item = e.target.closest('.template-list-item');
  if (!item) return;
  selectedTemplateId = item.dataset.id;
  renderTemplateManager();
});

$('#btnTemplateNew').addEventListener('click', () => {
  const id = 'tpl-' + Date.now().toString(36);
  templates.push({ id, name: '新模板', title: '新日志 {{today:MM月DD日}}', content: '' });
  selectedTemplateId = id;
  saveTemplates();
  populateTemplateSelect();
  renderTemplateManager();
});

$('#btnTemplateSave').addEventListener('click', () => {
  const name = $('#templateNameInput').value.trim();
  const title = $('#templateTitleInput').value.trim();
  const content = $('#templateContentInput').value;
  if (!name) { showToast('请输入模板名称', 'error'); return; }
  if (!selectedTemplateId) {
    selectedTemplateId = 'tpl-' + Date.now().toString(36);
    templates.push({ id: selectedTemplateId, name, title: title || name, content });
  } else {
    const tpl = templates.find(t => t.id === selectedTemplateId);
    if (tpl) {
      tpl.name = name;
      tpl.title = title || name;
      tpl.content = content;
    }
  }
  saveTemplates();
  populateTemplateSelect();
  renderTemplateManager();
  showToast('模板已保存', 'success');
});

$('#btnTemplateDelete').addEventListener('click', async () => {
  if (!selectedTemplateId) return;
  const selected = templates.find(t => t.id === selectedTemplateId);
  const confirmed = await confirmDialog({
    title: '删除模板',
    message: `删除模板「${selected?.name || ''}」？`,
    confirmText: '删除',
  });
  if (!confirmed) return;
  templates = templates.filter(t => t.id !== selectedTemplateId);
  selectedTemplateId = templates[0]?.id || null;
  saveTemplates();
  populateTemplateSelect();
  renderTemplateManager();
});

$('#btnTemplateReset').addEventListener('click', async () => {
  const confirmed = await confirmDialog({
    title: '恢复默认模板',
    message: '恢复默认模板会覆盖当前模板列表。',
    confirmText: '恢复',
    danger: false,
  });
  if (!confirmed) return;
  templates = cloneDefaultTemplates();
  selectedTemplateId = templates[0]?.id || null;
  saveTemplates();
  populateTemplateSelect();
  renderTemplateManager();
});

// Input listeners
editTitle.addEventListener('input', autoSave);
contentEditor.onDidChange(() => {
  autoSave();
  renderOutline();
  if (editorTab !== 'write') renderPreview();
});
editDate.addEventListener('change', autoSave);
editHours.addEventListener('change', autoSave);
editCategory.addEventListener('change', () => {
  populateEditorSubCategory(editCategory.value);
  editSubcategory.value = '';
  syncEditorSelectControls();
  autoSave();
});
editSubcategory.addEventListener('change', () => {
  syncEditorSelectControls();
  autoSave();
});

// Tab switching
function nextEditorTab() {
  if (editorTab === 'write') return 'preview';
  if (editorTab === 'preview') return 'split';
  return 'write';
}

export function switchTab(tab) {
  if (!['write', 'preview', 'split'].includes(tab)) tab = 'write';
  editorTab = tab;
  localStorage.setItem(EDITOR_TAB_STORAGE_KEY, tab);
  setEditorToolbarMoreOpen(false);
  editorToolbar.classList.toggle('preview-mode', tab === 'preview');
  $$('.editor-tab').forEach(t => {
    const selected = t.dataset.tab === tab;
    t.classList.toggle('active', selected);
    t.setAttribute('aria-selected', String(selected));
    t.tabIndex = selected ? 0 : -1;
    if (selected) editorContentArea.setAttribute('aria-labelledby', t.id);
  });
  editorContentArea.classList.toggle('split', tab === 'split');
  if (tab === 'write') {
    contentEditor.setVisible(true);
    editPreview.style.display = 'none';
  } else if (tab === 'preview') {
    renderPreview();
    contentEditor.setVisible(false);
    editPreview.style.display = 'block';
  } else {
    renderPreview();
    contentEditor.setVisible(true);
    editPreview.style.display = 'block';
  }
  requestAnimationFrame(() => contentEditor.layout());
}

editorModeTabs.addEventListener('click', (e) => {
  const tab = e.target.closest('.editor-tab');
  if (!tab) return;
  switchTab(tab.dataset.tab);
});

editorModeTabs.addEventListener('keydown', (e) => {
  const tab = e.target.closest('.editor-tab');
  if (!tab || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
  const tabs = [...$$('.editor-tab')];
  const index = tabs.indexOf(tab);
  let targetIndex = index;
  if (e.key === 'ArrowLeft') targetIndex = (index - 1 + tabs.length) % tabs.length;
  if (e.key === 'ArrowRight') targetIndex = (index + 1) % tabs.length;
  if (e.key === 'Home') targetIndex = 0;
  if (e.key === 'End') targetIndex = tabs.length - 1;
  e.preventDefault();
  switchTab(tabs[targetIndex].dataset.tab);
  tabs[targetIndex].focus();
});

initEditorSelectControls();
document.addEventListener('editor-category-options-changed', syncEditorSelectControls);

// Image upload
$('#btnUploadImg').addEventListener('click', () => {
  $('#imgFileInput').click();
});

function showUploadProgress() {
  const status = $('#uploadStatus');
  status.innerHTML = '<span class="upload-progress-bar"><span class="upload-progress-fill" id="uploadProgressFill"></span></span> 上传中...';
  return status;
}

function pastedImageFile(file) {
  if (!file) return null;
  if (/\.(png|jpe?g|gif|webp|bmp)$/i.test(file.name || '')) return file;
  const extensionByType = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/bmp': '.bmp',
  };
  const extension = extensionByType[file.type];
  if (!extension) return null;
  return new File([file], `pasted-image-${Date.now()}${extension}`, { type: file.type });
}

function insertUploadedImage(url, selection) {
  const imgMd = `![image](${url})`;
  if (!selection) {
    contentEditor.insertAtSelection(imgMd);
    return;
  }
  const value = contentEditor.getValue();
  const nextValue = value.substring(0, selection.start) + imgMd + value.substring(selection.end);
  const cursor = selection.start + imgMd.length;
  contentEditor.applyValue(nextValue, cursor, cursor);
}

function uploadImageFile(file, selection = null) {
  const status = showUploadProgress();
  const formData = new FormData();
  formData.append('image', file);
  formData.append('private', String(getCategoryValue() === '日记' || getCategoryValue().startsWith('日记/')));

  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/upload');

  xhr.upload.addEventListener('progress', (e) => {
    if (e.lengthComputable) {
      const pct = Math.round((e.loaded / e.total) * 100);
      const fill = document.getElementById('uploadProgressFill');
      if (fill) fill.style.width = pct + '%';
      status.childNodes[status.childNodes.length - 1].textContent = ' ' + pct + '%';
    }
  });

  xhr.addEventListener('load', () => {
    if (xhr.status >= 200 && xhr.status < 300) {
      const data = JSON.parse(xhr.responseText);
      insertUploadedImage(data.url, selection);
      contentEditor.focus();
      status.textContent = '已插入';
      setTimeout(() => { if (status.textContent === '已插入') status.textContent = ''; }, SAVE_STATUS_DURATION);
    } else {
      let message = '上传失败';
      let errorCode = '';
      try {
        const data = JSON.parse(xhr.responseText);
        message = data.error || message;
        errorCode = data.code || '';
      } catch {}
      if (xhr.status === 401 || errorCode === 'PASSWORD_CHANGE_REQUIRED') {
        redirectToLogin({ passwordChange: errorCode === 'PASSWORD_CHANGE_REQUIRED' });
        return;
      }
      status.textContent = '上传失败';
      showToast(message, 'error');
    }
  });

  xhr.addEventListener('error', () => {
    status.textContent = '上传失败';
    showToast('上传失败: 网络错误', 'error');
  });

  xhr.addEventListener('abort', () => {
    status.textContent = '已取消';
  });

  xhr.send(formData);
}

$('#imgFileInput').addEventListener('change', () => {
  const fileInput = $('#imgFileInput');
  const file = fileInput.files[0];
  if (!file) return;
  uploadImageFile(file);
  fileInput.value = '';
});

editorContentArea.addEventListener('paste', (event) => {
  if (!contentEditor.hasFocus()) return;
  const imageItem = [...(event.clipboardData?.items || [])]
    .find(item => item.kind === 'file' && item.type.startsWith('image/'));
  if (!imageItem) return;
  const file = pastedImageFile(imageItem.getAsFile());
  if (!file) {
    showToast('仅支持粘贴 PNG、JPG、GIF、WebP 或 BMP 图片', 'error');
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  const selection = contentEditor.getSelection();
  uploadImageFile(file, selection);
}, true);

function renderPreview() {
  editPreview.innerHTML = renderToHtmlUncached(contentEditor.getValue());
}

function copyTextFallback(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand('copy');
  ta.remove();
  if (!ok) throw new Error('复制失败');
}

async function copyMarkdownText() {
  const content = contentEditor.getValue();
  if (!content.trim()) {
    showToast('没有可复制的 Markdown 内容', 'error');
    return;
  }

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(content);
    } else {
      copyTextFallback(content);
    }
    showToast('Markdown 已复制', 'success');
  } catch (err) {
    showToast('复制失败: ' + err.message, 'error');
  }
}

$('#btnCopyMarkdown').addEventListener('click', copyMarkdownText);

function exportMarkdownText() {
  const content = contentEditor.getValue();
  if (!content.trim()) {
    showToast('没有可导出的 Markdown 内容', 'error');
    return;
  }

  const title = (editTitle.value.trim() || '未命名日志')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .trim()
    .slice(0, 80) || '未命名日志';
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${title}.md`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  showToast('Markdown 已导出', 'success');
}

$('#btnExportMarkdown').addEventListener('click', exportMarkdownText);

// Delete
$('#btnDeleteEditor').addEventListener('click', async () => {
  if (!state.editingId) return;
  const deleteId = state.editingId;
  const confirmed = await confirmDialog({
    title: '确认删除',
    message: '确定要删除这条日志吗？此操作不可撤销。',
    confirmText: '确认删除',
  });
  if (!confirmed) return;
  try {
    await apiFetch(`/api/logs/${deleteId}`, { method: 'DELETE' });
    state.editingId = null;
    showListView();
    await loadStats();
  } catch (err) {
    showToast('删除失败: ' + err.message, 'error');
  }
});

// Table grid popup
(function initTableGrid() {
  const btnTable = $('#btnTable');
  const popup = $('#tableGridPopup');
  const grid = $('#tableGrid');
  const dimLabel = $('#tableGridDim');
  const COLS = 7, ROWS = 5;
  let open = false;

  // Build grid cells
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const cell = document.createElement('div');
      cell.className = 'table-grid-cell';
      cell.dataset.row = r + 1;
      cell.dataset.col = c + 1;
      grid.appendChild(cell);
    }
  }

  function highlightCells(col, row) {
    grid.querySelectorAll('.table-grid-cell').forEach(cell => {
      cell.classList.toggle('highlight',
        parseInt(cell.dataset.col) <= col && parseInt(cell.dataset.row) <= row);
    });
  }

  function clearHighlight() {
    grid.querySelectorAll('.table-grid-cell').forEach(c => c.classList.remove('highlight'));
  }

  function insertTable(rows, cols) {
    const value = contentEditor.getValue();
    const { start } = contentEditor.getSelection();
    const before = value.substring(0, start);
    const after = value.substring(start);
    const needNewline = before.length > 0 && !before.endsWith('\n') ? '\n' : '';

    let table = '\n|';
    for (let c = 0; c < cols; c++) table += ` 列${c + 1} |`;
    table += '\n|';
    for (let c = 0; c < cols; c++) table += '-----|';
    for (let r = 0; r < rows - 1; r++) {
      table += '\n|';
      for (let c = 0; c < cols; c++) table += '     |';
    }
    table += '\n';

    const nextValue = before + needNewline + table + after;
    const cursorPos = start + needNewline.length + 2;
    contentEditor.applyValue(nextValue, cursorPos);
    contentEditor.focus();
  }

  grid.addEventListener('mouseover', (e) => {
    const cell = e.target.closest('.table-grid-cell');
    if (!cell) return;
    highlightCells(parseInt(cell.dataset.col), parseInt(cell.dataset.row));
    dimLabel.textContent = `${cell.dataset.row} × ${cell.dataset.col}`;
  });

  grid.addEventListener('mouseleave', () => {
    clearHighlight();
    dimLabel.textContent = '';
  });

  grid.addEventListener('click', (e) => {
    const cell = e.target.closest('.table-grid-cell');
    if (!cell) return;
    insertTable(parseInt(cell.dataset.row), parseInt(cell.dataset.col));
    popup.style.display = 'none';
    open = false;
  });

  btnTable.addEventListener('click', (e) => {
    e.stopPropagation();
    open = !open;
    popup.style.display = open ? 'block' : 'none';
    clearHighlight();
    dimLabel.textContent = '';
  });

  document.addEventListener('click', (e) => {
    if (open && !popup.contains(e.target) && e.target !== btnTable) {
      popup.style.display = 'none';
      open = false;
    }
  });
})();
