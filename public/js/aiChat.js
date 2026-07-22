import { apiFetch } from './auth.js';
import { showToast, escHtml, openModal, closeModal, confirmDialog, $ } from './helpers.js';
import { renderToHtml } from './markdown.js';
import { handleInternalLogLinkClick } from './editor.js';
import { businessDateString } from './businessDate.js';
import { dailyQuoteForDate } from './aiDailyQuotes.js';

const DEFAULT_MODEL = 'deepseek-v4-flash';
const DEFAULT_REASONING = 'high';
const DEFAULT_SEEDREAM_MODEL = 'doubao-seedream-5-0-260128';
const DEFAULT_SEEDREAM_SIZE = '2K';
const MAX_MESSAGES = 20;
const DIRECT_AI_MODEL_LABELS = Object.freeze({
  'deepseek-v4-flash': 'DeepSeek Flash',
  'deepseek-v4-pro': 'DeepSeek Pro',
  'kimi-k3': 'Kimi K3',
  'kimi-k2.7-code': 'Kimi K2.7 Code',
  'kimi-k2.6': 'Kimi K2.6',
});
const API_KEY_STORAGE_KEY = 'deepseekApiKey';
const CHAT_STORAGE_KEY = 'aiChatConversations';
const ACTIVE_CHAT_STORAGE_KEY = 'aiChatActiveConversationId';
const AI_CONVERSATIONS_ENDPOINT = '/api/ai/conversations';
const AI_SETTINGS_ENDPOINT = '/api/ai/settings';
const AI_MODELS_ENDPOINT = '/api/ai/models';
const AI_SKILLS_ENDPOINT = '/api/ai/skills';
const AI_SETTINGS_SELECT_IDS = ['aiReasoningMode', 'aiReasoningEffort', 'aiSeedreamModel', 'aiSeedreamSize', 'aiWebSearchDepth'];

let conversations = [];
let activeConversationId = '';
let previousViewId = 'listView';
const conversationRequests = new Map();
let conversationSaveQueue = Promise.resolve();
let renameConversationId = '';
let availableSkills = [];
let selectedSkillId = '';
let aiAccessCategories = [];
let historySearchQuery = '';
let historySearchScope = 'title';
let historyMenuConversationId = '';
let historyMenuTrigger = null;
let pendingMedia = [];
let mediaUploading = false;
let availableModels = Object.entries(DIRECT_AI_MODEL_LABELS).map(([id, name]) => ({
  id, name, source: 'direct', provider: id.startsWith('kimi-') ? 'moonshot' : 'deepseek',
  inputModalities: id.startsWith('kimi-') ? ['text', 'image', 'video'] : ['text'],
  outputModalities: ['text'], contextLength: null, supportedParameters: [],
  reasoning: { supported: true, supportedEfforts: ['high', 'max'], mandatory: false },
  pricing: { inputPerMillion: null, outputPerMillion: null },
}));
let modelPickerTarget = '';
let modelPickerQuery = '';
let editorModelPickerContext = { conversationId: '', selectedModelId: '' };
let modelCatalogMeta = { configured: false, source: 'none', fetchedAt: null };
let modelsRefreshing = false;
let settings = {
  apiKey: '',
  apiKeyConfigured: false,
  moonshotApiKey: '',
  moonshotApiKeyConfigured: false,
  openrouterApiKey: '',
  openrouterApiKeyConfigured: false,
  model: DEFAULT_MODEL,
  reasoningEffort: DEFAULT_REASONING,
  reasoningMode: 'effort',
  thinkingMode: 'enabled',
  stream: false,
  userProfile: '',
  logContextEnabled: false,
  diaryContextEnabled: false,
  tavilyApiKey: '',
  tavilyApiKeyConfigured: false,
  perplexityApiKey: '',
  perplexityApiKeyConfigured: false,
  webSearchEnabled: false,
  kimiWebSearchEnabled: false,
  openrouterZdrEnabled: true,
  webSearchDepth: 'basic',
  seedreamApiKey: '',
  seedreamApiKeyConfigured: false,
  seedreamModel: DEFAULT_SEEDREAM_MODEL,
  seedreamSize: DEFAULT_SEEDREAM_SIZE,
  seedreamWatermark: true,
  logAccessPolicy: null,
  skills: {
    westock: { enabled: true },
    perplexity: { enabled: true },
  },
};

function isAiModelId(value) {
  return typeof value === 'string' && value.length <= 200 && (
    Object.hasOwn(DIRECT_AI_MODEL_LABELS, value) || /^[a-z0-9][a-z0-9._-]{0,79}\/[a-z0-9][a-z0-9._:+-]{0,119}$/i.test(value)
  );
}

function aiModelMeta(modelId) {
  return availableModels.find(model => model.id === modelId) || null;
}

function aiModelLabel(modelId) {
  return aiModelMeta(modelId)?.name || DIRECT_AI_MODEL_LABELS[modelId] || modelId || '未知模型';
}

function activeConversationModel() {
  const chat = activeConversation();
  return isAiModelId(chat?.model) ? chat.model : (isAiModelId(settings.model) ? settings.model : DEFAULT_MODEL);
}

export function clearAiStateForDiaryLock() {
  conversationRequests.forEach(request => request.controller?.abort());
  conversationRequests.clear();
  conversations = [];
  activeConversationId = '';
  pendingMedia = [];
  mediaUploading = false;
  const messages = $('#aiChatMessages');
  if (messages) messages.textContent = '';
}

function aiSettingsSelectControls() {
  return AI_SETTINGS_SELECT_IDS
    .map(id => document.querySelector(`[data-ai-settings-select-control][data-select-id="${id}"]`))
    .filter(Boolean);
}

function closeAiSettingsSelectControl(control) {
  if (!control) return;
  control.classList.remove('open');
  control.querySelector('.ai-settings-select-trigger')?.setAttribute('aria-expanded', 'false');
  const menu = control.querySelector('.ai-settings-select-menu');
  if (menu) menu.hidden = true;
}

function closeAiSettingsSelectControls(except = null) {
  aiSettingsSelectControls().forEach(control => {
    if (control !== except) closeAiSettingsSelectControl(control);
  });
}

function focusAiSettingsOption(control, direction = 1) {
  const options = [...control.querySelectorAll('.ai-settings-select-option')];
  if (!options.length) return;
  const activeIndex = options.indexOf(document.activeElement);
  const selectedIndex = options.findIndex(option => option.getAttribute('aria-selected') === 'true');
  const baseIndex = activeIndex >= 0 ? activeIndex : (selectedIndex >= 0 ? selectedIndex : 0);
  const nextIndex = (baseIndex + direction + options.length) % options.length;
  options[nextIndex].focus();
}

function openAiSettingsSelectControl(control, { focusSelected = false } = {}) {
  const trigger = control.querySelector('.ai-settings-select-trigger');
  const menu = control.querySelector('.ai-settings-select-menu');
  if (!trigger || !menu) return;
  syncAiSettingsSelectControls();
  closeAiSettingsSelectControls(control);
  control.classList.add('open');
  trigger.setAttribute('aria-expanded', 'true');
  menu.hidden = false;
  if (focusSelected) {
    const selected = menu.querySelector('.ai-settings-select-option[aria-selected="true"]');
    (selected || menu.querySelector('.ai-settings-select-option'))?.focus();
  }
}

function toggleAiSettingsSelectControl(control) {
  if (control.classList.contains('open')) closeAiSettingsSelectControl(control);
  else openAiSettingsSelectControl(control);
}

function selectFromAiSettingsOption(control, optionButton) {
  const select = document.getElementById(control.dataset.selectId);
  if (!select || !optionButton || optionButton.disabled) return;
  select.value = optionButton.dataset.value || '';
  closeAiSettingsSelectControl(control);
  select.dispatchEvent(new Event('change', { bubbles: true }));
  syncAiSettingsSelectControls();
  control.querySelector('.ai-settings-select-trigger')?.focus();
}

function syncAiSettingsSelectControls() {
  aiSettingsSelectControls().forEach(control => {
    const select = document.getElementById(control.dataset.selectId);
    const trigger = control.querySelector('.ai-settings-select-trigger');
    const value = control.querySelector('.ai-settings-select-value');
    const menu = control.querySelector('.ai-settings-select-menu');
    if (!select || !trigger || !value || !menu) return;

    const options = [...select.options];
    const selected = select.selectedOptions[0] || options.find(option => option.value === select.value) || options[0];
    value.textContent = selected?.textContent || '';
    trigger.setAttribute('aria-label', `${select.labels?.[0]?.textContent || '选择'}：${selected?.textContent || '未选择'}`);
    menu.innerHTML = options.map(option => `
      <button
        class="ai-settings-select-option${option.value === select.value ? ' selected' : ''}"
        type="button"
        role="option"
        data-value="${escHtml(option.value)}"
        aria-selected="${option.value === select.value}"
        ${option.disabled ? 'disabled aria-disabled="true"' : ''}
        tabindex="-1"
      >${escHtml(option.textContent)}</button>
    `).join('');
  });
}

function initAiSettingsSelectControls() {
  aiSettingsSelectControls().forEach(control => {
    const trigger = control.querySelector('.ai-settings-select-trigger');
    const menu = control.querySelector('.ai-settings-select-menu');
    trigger?.addEventListener('click', () => toggleAiSettingsSelectControl(control));
    trigger?.addEventListener('keydown', (event) => {
      if (!['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) return;
      event.preventDefault();
      openAiSettingsSelectControl(control, { focusSelected: true });
      if (event.key === 'ArrowUp') focusAiSettingsOption(control, -1);
    });
    menu?.addEventListener('click', (event) => {
      const option = event.target.closest('.ai-settings-select-option');
      if (option) selectFromAiSettingsOption(control, option);
    });
    menu?.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        focusAiSettingsOption(control, 1);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        focusAiSettingsOption(control, -1);
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        selectFromAiSettingsOption(control, event.target.closest('.ai-settings-select-option'));
      } else if (event.key === 'Escape') {
        event.preventDefault();
        closeAiSettingsSelectControl(control);
        trigger?.focus();
      }
    });
  });
  document.addEventListener('click', (event) => {
    if (!event.target.closest('[data-ai-settings-select-control]')) closeAiSettingsSelectControls();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeAiSettingsSelectControls();
  });
}

function createConversation(title = '新对话') {
  return {
    id: `chat-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    title,
    scope: 'global',
    logKey: '',
    diarySensitive: false,
    model: isAiModelId(settings.model) ? settings.model : DEFAULT_MODEL,
    messages: [],
    updatedAt: Date.now(),
  };
}

function normalizeConversations(items) {
  return Array.isArray(items)
    ? items
      .filter(item => item && typeof item.id === 'string' && Array.isArray(item.messages))
      .map(item => ({
        ...item,
        scope: item.scope === 'editor' ? 'editor' : 'global',
        logKey: typeof item.logKey === 'string' ? item.logKey : '',
        model: isAiModelId(item.model) ? item.model : (isAiModelId(settings.model) ? settings.model : DEFAULT_MODEL),
      }))
    : [];
}

function normalizeLogAccessPolicy(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const allowedParents = Array.isArray(value.allowedParents)
    ? [...new Set(value.allowedParents.filter(parent => typeof parent === 'string' && parent.trim()).map(parent => parent.trim()))]
    : [];
  const deniedSource = value.deniedSubcategories && typeof value.deniedSubcategories === 'object' && !Array.isArray(value.deniedSubcategories)
    ? value.deniedSubcategories
    : {};
  const deniedSubcategories = {};
  Object.entries(deniedSource).forEach(([parent, subs]) => {
    if (typeof parent !== 'string' || !Array.isArray(subs)) return;
    const cleanSubs = [...new Set(subs.filter(sub => typeof sub === 'string' && sub.trim()).map(sub => sub.trim()))];
    if (parent.trim() && cleanSubs.length) deniedSubcategories[parent.trim()] = cleanSubs;
  });
  return { allowedParents, deniedSubcategories };
}

function defaultLogAccessPolicy(categories = aiAccessCategories) {
  return {
    allowedParents: categories.filter(category => category.name !== '日记').map(category => category.name),
    deniedSubcategories: {},
  };
}

function normalizeSettings(value) {
  const skills = value?.skills && typeof value.skills === 'object' ? value.skills : {};
  const westock = skills.westock && typeof skills.westock === 'object' ? skills.westock : {};
  const perplexity = skills.perplexity && typeof skills.perplexity === 'object' ? skills.perplexity : {};
  return {
    apiKey: typeof value?.apiKey === 'string' ? value.apiKey : '',
    apiKeyConfigured: value?.apiKeyConfigured === true || Boolean(value?.apiKey),
    moonshotApiKey: typeof value?.moonshotApiKey === 'string' ? value.moonshotApiKey : '',
    moonshotApiKeyConfigured: value?.moonshotApiKeyConfigured === true || Boolean(value?.moonshotApiKey),
    openrouterApiKey: typeof value?.openrouterApiKey === 'string' ? value.openrouterApiKey : '',
    openrouterApiKeyConfigured: value?.openrouterApiKeyConfigured === true || Boolean(value?.openrouterApiKey),
    model: isAiModelId(value?.model) ? value.model : DEFAULT_MODEL,
    reasoningEffort: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(value?.reasoningEffort) ? value.reasoningEffort : DEFAULT_REASONING,
    reasoningMode: ['default', 'disabled', 'effort'].includes(value?.reasoningMode) ? value.reasoningMode : 'effort',
    thinkingMode: ['enabled', 'disabled'].includes(value?.thinkingMode) ? value.thinkingMode : 'enabled',
    stream: typeof value?.stream === 'boolean' ? value.stream : false,
    userProfile: typeof value?.userProfile === 'string' ? value.userProfile.slice(0, 2000) : '',
    logContextEnabled: typeof value?.logContextEnabled === 'boolean' ? value.logContextEnabled : false,
    diaryContextEnabled: typeof value?.diaryContextEnabled === 'boolean' ? value.diaryContextEnabled : false,
    tavilyApiKey: typeof value?.tavilyApiKey === 'string' ? value.tavilyApiKey : '',
    tavilyApiKeyConfigured: value?.tavilyApiKeyConfigured === true || Boolean(value?.tavilyApiKey),
    perplexityApiKey: typeof value?.perplexityApiKey === 'string' ? value.perplexityApiKey : '',
    perplexityApiKeyConfigured: value?.perplexityApiKeyConfigured === true || Boolean(value?.perplexityApiKey),
    webSearchEnabled: typeof value?.webSearchEnabled === 'boolean' ? value.webSearchEnabled : false,
    kimiWebSearchEnabled: typeof value?.kimiWebSearchEnabled === 'boolean' ? value.kimiWebSearchEnabled : false,
    openrouterZdrEnabled: typeof value?.openrouterZdrEnabled === 'boolean' ? value.openrouterZdrEnabled : true,
    webSearchDepth: ['basic', 'advanced'].includes(value?.webSearchDepth) ? value.webSearchDepth : 'basic',
    seedreamApiKey: typeof value?.seedreamApiKey === 'string' ? value.seedreamApiKey : '',
    seedreamApiKeyConfigured: value?.seedreamApiKeyConfigured === true || Boolean(value?.seedreamApiKey),
    seedreamModel: ['doubao-seedream-5-0-260128', 'doubao-seedream-4-5-251128', 'doubao-seedream-4-0-250828'].includes(value?.seedreamModel) ? value.seedreamModel : DEFAULT_SEEDREAM_MODEL,
    seedreamSize: typeof value?.seedreamSize === 'string' && value.seedreamSize ? value.seedreamSize : DEFAULT_SEEDREAM_SIZE,
    seedreamWatermark: typeof value?.seedreamWatermark === 'boolean' ? value.seedreamWatermark : true,
    logAccessPolicy: normalizeLogAccessPolicy(value?.logAccessPolicy),
    skills: {
      westock: { enabled: typeof westock.enabled === 'boolean' ? westock.enabled : true },
      perplexity: { enabled: typeof perplexity.enabled === 'boolean' ? perplexity.enabled : true },
    },
  };
}

function loadLegacyConversations() {
  try {
    const parsed = JSON.parse(localStorage.getItem(CHAT_STORAGE_KEY) || '[]');
    return {
      conversations: normalizeConversations(parsed),
      activeConversationId: localStorage.getItem(ACTIVE_CHAT_STORAGE_KEY) || '',
    };
  } catch {
    return { conversations: [], activeConversationId: '' };
  }
}

async function loadConversations() {
  let loaded = { conversations: [], activeConversationId: '' };
  try {
    const res = await apiFetch(AI_CONVERSATIONS_ENDPOINT);
    if (res.ok) loaded = await res.json();
  } catch (err) {
    console.warn('Failed to load AI conversations:', err);
  }

  conversations = normalizeConversations(loaded.conversations).filter(item => item.scope === 'global');
  activeConversationId = loaded.activeConversationId || '';

  if (!conversations.length) {
    const legacy = loadLegacyConversations();
    conversations = normalizeConversations(legacy.conversations);
    activeConversationId = legacy.activeConversationId;
    if (conversations.length) await saveConversations();
  }

  if (!conversations.length) conversations = [createConversation()];
  if (!activeConversationId) activeConversationId = conversations[0].id;
  if (!activeConversation()) activeConversationId = conversations[0].id;
  await saveConversations();
}

function saveConversations() {
  const save = async () => {
    try {
      const res = await apiFetch(AI_CONVERSATIONS_ENDPOINT, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope: 'global',
          conversations: conversations.map(item => ({
            ...item,
            messages: (item.messages || []).filter(message => !message.streaming),
            scope: 'global',
            logKey: '',
          })),
          activeConversationId,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'AI 历史保存失败');
      }
      return true;
    } catch (err) {
      console.warn('Failed to save AI conversations:', err);
      showToast('AI 历史保存失败：' + err.message, 'error');
      return false;
    }
  };
  const pending = conversationSaveQueue.then(save, save);
  conversationSaveQueue = pending.then(() => undefined, () => undefined);
  return pending;
}

async function loadSettings() {
  try {
    const res = await apiFetch(AI_SETTINGS_ENDPOINT);
    if (res.ok) settings = normalizeSettings(await res.json());
  } catch (err) {
    console.warn('Failed to load AI settings:', err);
  }

  const legacyApiKey = localStorage.getItem(API_KEY_STORAGE_KEY) || '';
  if (!settings.apiKeyConfigured && legacyApiKey) {
    settings.apiKey = legacyApiKey;
    await saveSettings({ quiet: true });
    localStorage.removeItem(API_KEY_STORAGE_KEY);
  }
}

async function loadAccessCategories() {
  try {
    const res = await apiFetch('/api/categories');
    if (!res.ok) throw new Error('分类加载失败');
    const data = await res.json();
    aiAccessCategories = Array.isArray(data) ? data : [];
  } catch (err) {
    aiAccessCategories = [];
    console.warn('Failed to load AI access categories:', err);
  }
}

async function loadSkills() {
  try {
    const res = await apiFetch(AI_SKILLS_ENDPOINT);
    const data = await res.json().catch(() => ({}));
    if (res.ok && Array.isArray(data.skills)) {
      availableSkills = data.skills.filter(skill => skill && typeof skill.id === 'string');
    }
  } catch (err) {
    console.warn('Failed to load AI skills:', err);
    availableSkills = [];
  }
  if (selectedSkillId && !availableSkills.some(skill => skill.id === selectedSkillId && skill.enabled !== false)) {
    selectedSkillId = '';
  }
  renderSkillPicker();
  renderSelectedSkillChip();
}

async function saveSettings({ quiet = false, clearApiKeys = false } = {}) {
  const submitted = {
    ...settings,
    skills: {
      ...settings.skills,
      westock: { ...settings.skills?.westock },
      perplexity: { ...settings.skills?.perplexity },
    },
    clearApiKeys,
  };
  const res = await apiFetch(AI_SETTINGS_ENDPOINT, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(submitted),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'AI 设置保存失败');
  if (
    data.model !== submitted.model ||
    data.userProfile !== submitted.userProfile ||
    data.logContextEnabled !== submitted.logContextEnabled ||
    data.diaryContextEnabled !== submitted.diaryContextEnabled ||
    data.webSearchEnabled !== submitted.webSearchEnabled ||
    data.kimiWebSearchEnabled !== submitted.kimiWebSearchEnabled ||
    data.openrouterZdrEnabled !== submitted.openrouterZdrEnabled ||
    data.reasoningMode !== submitted.reasoningMode ||
    data.reasoningEffort !== submitted.reasoningEffort ||
    data.thinkingMode !== submitted.thinkingMode ||
    data.webSearchDepth !== submitted.webSearchDepth ||
    data.seedreamModel !== submitted.seedreamModel ||
    data.seedreamSize !== submitted.seedreamSize ||
    data.seedreamWatermark !== submitted.seedreamWatermark ||
    JSON.stringify(data.logAccessPolicy || null) !== JSON.stringify(submitted.logAccessPolicy || null) ||
    data.skills?.westock?.enabled !== submitted.skills?.westock?.enabled ||
    data.skills?.perplexity?.enabled !== submitted.skills?.perplexity?.enabled
  ) {
    throw new Error('服务端未保存 AI 设置，请重启应用后再试');
  }
  settings = normalizeSettings(data);
  if (submitted.openrouterApiKey || clearApiKeys) await loadModels({ quiet: true });
  await loadSkills();
  updateSettingsButton();
  syncChatModelSwitcherUi();
  syncWebSearchToggleUi();
  if (!quiet) showToast('AI 设置已保存', 'success');
}

function activeConversation() {
  return conversations.find(item => item.id === activeConversationId) || null;
}

function activeMessages() {
  return activeConversation()?.messages || [];
}

function isConversationSending(id = activeConversationId) {
  return Boolean(id && conversationRequests.has(id));
}

function beginConversationRequest(chat) {
  const request = {
    controller: new AbortController(),
    status: '正在思考...',
    startedAt: Date.now(),
  };
  conversationRequests.set(chat.id, request);
  return request;
}

function finishConversationRequest(id) {
  conversationRequests.delete(id);
}

function renderConversationIfActive(id) {
  if (id === activeConversationId) renderMessages();
  else renderHistory();
}

function visibleMainViewId() {
  for (const id of ['aiSettingsView', 'aiChatView', 'photoWallView', 'editorView', 'categoryView', 'todoView', 'listView']) {
    const el = document.getElementById(id);
    if (el && el.style.display !== 'none') return id;
  }
  return 'listView';
}

function setMainView(id) {
  for (const viewId of ['listView', 'editorView', 'categoryView', 'todoView', 'photoWallView', 'aiChatView', 'aiSettingsView']) {
    const el = document.getElementById(viewId);
    if (!el) continue;
    el.style.display = viewId === id ? 'flex' : 'none';
  }
}

function syncAiSidebarChrome() {
  document.body.classList.remove('sidebar-todo-mode', 'sidebar-category-mode', 'sidebar-photo-wall-mode', 'sidebar-tools-mode');
  document.body.classList.add('sidebar-ai-mode');
  localStorage.setItem('sidebarMode', 'ai');
  const title = $('#sidebarTitle');
  const trigger = $('#sidebarModeTrigger');
  if (title) title.textContent = 'AI 对话';
  if (trigger) trigger.title = '当前为 AI 历史对话';
  $('#sidebarModeMenu')?.querySelectorAll('[data-mode]').forEach(button => {
    button.classList.toggle('active', button.dataset.mode === 'ai');
  });
  const tools = $('#btnSidebarTools');
  if (tools) {
    tools.classList.remove('active');
    tools.setAttribute('aria-pressed', 'false');
    tools.title = '切换更多工具';
  }
}

function conversationTitleFrom(text) {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean ? clean.slice(0, 28) : '新对话';
}

function formatChatTime(timestamp) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export async function reloadAiChatHistory() {
  await loadConversations();
  renderMessages();
  renderHistory();
  updateSendState();
}

function messageTimeLabel(message, fallbackTimestamp) {
  return formatChatTime(message?.createdAt || fallbackTimestamp);
}

function historyGroupLabel(timestamp) {
  const date = timestamp ? new Date(timestamp) : new Date(0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const sevenDaysAgo = new Date(today);
  sevenDaysAgo.setDate(today.getDate() - 6);
  if (date >= today) return '今天';
  if (date >= sevenDaysAgo) return '一周内';
  return '更久以前';
}

function imagePromptFrom(text) {
  return String(text || '').trim().slice(0, 800);
}

function markdownForGeneratedImage(imageGeneration) {
  return imageGeneration?.markdown || (imageGeneration?.url ? `![image](${imageGeneration.url})` : '');
}

function selectedImagePrompt(imageGeneration) {
  if (!imageGeneration) return '';
  if (imageGeneration.promptMode === 'original') {
    return imageGeneration.originalPrompt || imageGeneration.prompt || '';
  }
  return imageGeneration.optimizedPrompt || imageGeneration.selectedPrompt || imageGeneration.prompt || imageGeneration.originalPrompt || '';
}

async function optimizeImagePrompt(prompt, context = '') {
  const aiOptions = currentSettings();
  const res = await apiFetch('/api/ai/image/prompt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt,
      context,
      model: aiOptions.model,
      reasoningMode: aiOptions.reasoningMode,
      reasoningEffort: aiOptions.reasoningEffort,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Prompt 优化失败');
  return String(data.prompt || '').trim().slice(0, 1200);
}

function copyTextFallback(text) {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.select();
  const ok = document.execCommand('copy');
  textarea.remove();
  if (!ok) throw new Error('复制命令不可用');
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  copyTextFallback(text);
}

let aiImagePreviewKeydown = null;

function ensureAiImagePreviewOverlay() {
  let overlay = $('#aiImagePreviewOverlay');
  if (overlay) return overlay;
  overlay = document.createElement('div');
  overlay.id = 'aiImagePreviewOverlay';
  overlay.className = 'modal-overlay ai-image-preview-overlay';
  overlay.style.display = 'none';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'aiImagePreviewTitle');
  overlay.innerHTML = `
    <div class="ai-image-lightbox">
      <button class="ai-image-lightbox-close" id="aiImagePreviewClose" type="button" aria-label="关闭图片预览" title="关闭">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        </svg>
      </button>
      <h2 id="aiImagePreviewTitle" class="sr-only">AI 生成图片预览</h2>
      <div class="ai-image-lightbox-frame">
        <img class="ai-image-lightbox-img" id="aiImagePreviewImage" alt="">
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', event => {
    if (event.target === overlay) closeAiImagePreview();
  });
  overlay.querySelector('#aiImagePreviewClose')?.addEventListener('click', closeAiImagePreview);
  return overlay;
}

function openAiImagePreview(url, alt = 'AI 生成图片') {
  if (!url) return;
  const overlay = ensureAiImagePreviewOverlay();
  const image = overlay.querySelector('#aiImagePreviewImage');
  if (image) {
    image.src = url;
    image.alt = alt || 'AI 生成图片';
  }
  if (aiImagePreviewKeydown) document.removeEventListener('keydown', aiImagePreviewKeydown);
  aiImagePreviewKeydown = event => {
    if (event.key === 'Escape') closeAiImagePreview();
  };
  document.addEventListener('keydown', aiImagePreviewKeydown);
  openModal(overlay, '#aiImagePreviewClose');
}

function closeAiImagePreview() {
  const overlay = $('#aiImagePreviewOverlay');
  if (!overlay) return;
  closeModal(overlay);
  const image = overlay.querySelector('#aiImagePreviewImage');
  if (image) image.removeAttribute('src');
  if (aiImagePreviewKeydown) {
    document.removeEventListener('keydown', aiImagePreviewKeydown);
    aiImagePreviewKeydown = null;
  }
}

function normalizeModelCatalogItem(value) {
  if (!value || !isAiModelId(value.id) || typeof value.name !== 'string') return null;
  return {
    id: value.id,
    name: value.name.trim().slice(0, 160) || value.id,
    source: value.source === 'openrouter' ? 'openrouter' : 'direct',
    provider: typeof value.provider === 'string' ? value.provider : '',
    contextLength: Number.isSafeInteger(Number(value.contextLength)) && Number(value.contextLength) > 0 ? Number(value.contextLength) : null,
    inputModalities: Array.isArray(value.inputModalities) ? value.inputModalities.filter(item => typeof item === 'string') : ['text'],
    outputModalities: Array.isArray(value.outputModalities) ? value.outputModalities.filter(item => typeof item === 'string') : ['text'],
    supportedParameters: Array.isArray(value.supportedParameters) ? value.supportedParameters.filter(item => typeof item === 'string') : [],
    reasoning: value.reasoning && typeof value.reasoning === 'object' ? value.reasoning : { supported: false, supportedEfforts: [], mandatory: false },
    pricing: value.pricing && typeof value.pricing === 'object' ? value.pricing : { inputPerMillion: null, outputPerMillion: null },
  };
}

async function loadModels({ quiet = true, force = false } = {}) {
  let result = { ok: false, data: null, error: null };
  try {
    const res = await apiFetch(force ? `${AI_MODELS_ENDPOINT}?refresh=1` : AI_MODELS_ENDPOINT);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '模型目录加载失败');
    const models = Array.isArray(data.models) ? data.models.map(normalizeModelCatalogItem).filter(Boolean) : [];
    if (models.length) availableModels = models;
    modelCatalogMeta = {
      configured: data.openrouterConfigured === true,
      source: ['network', 'cache', 'stale'].includes(data.openrouterCatalog?.source) ? data.openrouterCatalog.source : 'none',
      fetchedAt: typeof data.openrouterCatalog?.fetchedAt === 'string' ? data.openrouterCatalog.fetchedAt : null,
    };
    result = { ok: true, data, error: null };
  } catch (err) {
    if (!quiet) showToast('OpenRouter 模型目录加载失败：' + err.message, 'error');
    console.warn('Failed to load AI model catalog:', err);
    result.error = err;
  }
  const configuredModelIds = new Set(availableModels.map(model => model.id));
  for (const modelId of [settings.model, ...conversations.map(chat => chat.model)]) {
    if (isAiModelId(modelId) && !configuredModelIds.has(modelId)) {
      availableModels.push({
        id: modelId,
        name: DIRECT_AI_MODEL_LABELS[modelId] || modelId,
        source: Object.hasOwn(DIRECT_AI_MODEL_LABELS, modelId) ? 'direct' : 'openrouter',
        provider: modelId.split('/')[0] || '',
        inputModalities: ['text'], outputModalities: ['text'], supportedParameters: [],
        contextLength: null, reasoning: { supported: false, supportedEfforts: [], mandatory: false },
        pricing: { inputPerMillion: null, outputPerMillion: null }, unavailable: true,
      });
    }
  }
  syncModelControls();
  return result;
}

function formatModelContext(value) {
  if (!value) return '上下文未知';
  if (value >= 1000000) return `${(value / 1000000).toFixed(value % 1000000 ? 1 : 0)}M`;
  if (value >= 1000) return `${Math.round(value / 1000)}K`;
  return String(value);
}

function formatModelPrice(model) {
  const input = model.pricing?.inputPerMillion;
  const output = model.pricing?.outputPerMillion;
  if (input === null || input === undefined || output === null || output === undefined) return '价格未提供';
  return `$${Number(input).toLocaleString(undefined, { maximumFractionDigits: 4 })} / $${Number(output).toLocaleString(undefined, { maximumFractionDigits: 4 })} 每百万 Token`;
}

function modelModalityLabel(model) {
  const labels = ['文本'];
  if (model.inputModalities?.includes('image')) labels.push('图片');
  if (model.inputModalities?.includes('video')) labels.push('视频');
  return labels.join(' · ');
}

function formatModelCatalogTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

function selectedModelForPicker() {
  if (modelPickerTarget === 'default') return $('#aiModelSelect')?.value || settings.model;
  if (modelPickerTarget === 'editor') return editorModelPickerContext.selectedModelId || settings.model;
  return activeConversationModel();
}

function renderModelPicker() {
  const list = $('#aiModelPickerList');
  if (!list) return;
  const query = modelPickerQuery.trim().toLowerCase();
  const filtered = availableModels.filter(model => !query || `${model.name} ${model.id} ${model.provider}`.toLowerCase().includes(query));
  const summary = $('#aiModelPickerSummary');
  if (summary) {
    const openrouterCount = availableModels.filter(model => model.source === 'openrouter' && !model.unavailable).length;
    const countLabel = query ? `${filtered.length} / ${availableModels.length} 个模型` : `${availableModels.length} 个模型`;
    const refreshedAt = formatModelCatalogTime(modelCatalogMeta.fetchedAt);
    let catalogLabel = '未配置 OpenRouter Key';
    if (modelCatalogMeta.configured && modelCatalogMeta.source === 'network') catalogLabel = `OpenRouter ${openrouterCount} 个 · 已于 ${refreshedAt || '刚刚'} 更新`;
    if (modelCatalogMeta.configured && modelCatalogMeta.source === 'cache') catalogLabel = `OpenRouter ${openrouterCount} 个 · 缓存于 ${refreshedAt || '最近'}`;
    if (modelCatalogMeta.configured && modelCatalogMeta.source === 'stale') catalogLabel = `OpenRouter ${openrouterCount} 个 · 正在使用 ${refreshedAt || '较早'} 的旧目录`;
    summary.textContent = `${countLabel} · ${catalogLabel}`;
  }
  if (!filtered.length) {
    list.innerHTML = '<div class="ai-model-picker-empty">没有匹配的可用模型</div>';
    return;
  }
  const selectedId = selectedModelForPicker();
  list.innerHTML = filtered.map(model => `
    <button class="ai-model-option${model.id === selectedId ? ' selected' : ''}${model.unavailable ? ' unavailable' : ''}" type="button"
      role="option" aria-selected="${model.id === selectedId}" data-model-id="${escHtml(model.id)}" ${model.unavailable ? 'disabled' : ''}>
      <span class="ai-model-option-main">
        <strong>${escHtml(model.name)}</strong>
        <code>${escHtml(model.id)}</code>
      </span>
      <span class="ai-model-option-meta">
        <i>${model.source === 'openrouter' ? 'OpenRouter' : '直连'} · ${escHtml(modelModalityLabel(model))}</i>
        <i>${escHtml(formatModelContext(model.contextLength))} · ${escHtml(formatModelPrice(model))}</i>
      </span>
    </button>
  `).join('');
}

function syncModelSelect(select, selectedId) {
  if (!select) return;
  select.innerHTML = availableModels.map(model => `<option value="${escHtml(model.id)}">${escHtml(model.name)}</option>`).join('');
  if (isAiModelId(selectedId) && ![...select.options].some(option => option.value === selectedId)) {
    select.insertAdjacentHTML('beforeend', `<option value="${escHtml(selectedId)}">${escHtml(selectedId)}</option>`);
  }
  select.value = selectedId;
}

function syncModelControls() {
  const conversationModel = activeConversationModel();
  syncModelSelect($('#aiChatModelSelect'), conversationModel);
  syncModelSelect($('#aiModelSelect'), isAiModelId($('#aiModelSelect')?.value) ? $('#aiModelSelect').value : settings.model);
  const chatLabel = $('#aiChatModelLabel');
  if (chatLabel) chatLabel.textContent = aiModelLabel(conversationModel);
  const chatButton = $('#btnAiChatModel');
  if (chatButton) {
    chatButton.title = `下一条消息使用 ${aiModelLabel(conversationModel)}（${conversationModel}）`;
    chatButton.setAttribute('aria-label', `切换当前对话模型，当前为 ${aiModelLabel(conversationModel)}`);
  }
  const defaultModel = $('#aiModelSelect')?.value || settings.model;
  const defaultLabel = $('#aiDefaultModelLabel');
  if (defaultLabel) defaultLabel.textContent = aiModelLabel(defaultModel);
  renderModelPicker();
}

function openModelPicker(target) {
  modelPickerTarget = target === 'default' ? 'default' : (target === 'editor' ? 'editor' : 'conversation');
  modelPickerQuery = '';
  const overlay = $('#aiModelPickerOverlay');
  const search = $('#aiModelPickerSearch');
  if (!overlay || !search) return;
  $('#aiModelPickerTitle').textContent = modelPickerTarget === 'default'
    ? '选择默认模型'
    : modelPickerTarget === 'editor' ? '选择日志对话模型' : '选择当前对话模型';
  search.value = '';
  renderModelPicker();
  overlay.style.display = 'flex';
  requestAnimationFrame(() => search.focus());
}

function closeModelPicker({ restoreFocus = true } = {}) {
  const overlay = $('#aiModelPickerOverlay');
  if (overlay) overlay.style.display = 'none';
  if (restoreFocus) {
    const focusTarget = modelPickerTarget === 'default'
      ? $('#btnAiDefaultModel')
      : modelPickerTarget === 'editor' ? $('#btnEditorAiModel') : $('#btnAiChatModel');
    focusTarget?.focus();
  }
  modelPickerTarget = '';
  editorModelPickerContext = { conversationId: '', selectedModelId: '' };
}

async function refreshModelsFromPicker() {
  if (modelsRefreshing) return;
  const button = $('#btnAiModelRefresh');
  modelsRefreshing = true;
  if (button) {
    button.disabled = true;
    button.classList.add('refreshing');
    button.setAttribute('aria-busy', 'true');
    const label = button.querySelector('span');
    if (label) label.textContent = '刷新中';
  }
  try {
    const result = await loadModels({ quiet: false, force: true });
    if (!result.ok) return;
    if (!result.data?.openrouterConfigured) {
      showToast('请先在 AI 设置中配置 OpenRouter API Key', 'info');
    } else if (modelCatalogMeta.source === 'stale') {
      showToast('OpenRouter 暂时无法刷新，已继续使用旧模型目录', 'info');
    } else {
      const count = availableModels.filter(model => model.source === 'openrouter' && !model.unavailable).length;
      showToast(`已从 OpenRouter 刷新 ${count} 个模型`, 'success');
    }
  } finally {
    modelsRefreshing = false;
    if (button) {
      button.disabled = false;
      button.classList.remove('refreshing');
      button.removeAttribute('aria-busy');
      const label = button.querySelector('span');
      if (label) label.textContent = '刷新';
    }
  }
}

async function chooseModelFromPicker(modelId) {
  const model = aiModelMeta(modelId);
  if (!model || model.unavailable) return;
  if (modelPickerTarget === 'default') {
    $('#aiModelSelect').value = modelId;
    syncModelControls();
    syncModelSettingsUi();
    closeModelPicker();
    return;
  }
  if (modelPickerTarget === 'editor') {
    const conversationId = editorModelPickerContext.conversationId;
    closeModelPicker({ restoreFocus: false });
    document.dispatchEvent(new CustomEvent('editor-ai-model-selected', {
      detail: { conversationId, model: { ...model } },
    }));
    requestAnimationFrame(() => $('#btnEditorAiModel')?.focus());
    return;
  }
  const chat = activeConversation();
  if (!chat) return;
  const previousModel = chat.model;
  chat.model = modelId;
  chat.updatedAt = Date.now();
  syncModelControls();
  syncWebSearchToggleUi();
  closeModelPicker();
  if (!await saveConversations()) {
    chat.model = previousModel;
    syncModelControls();
    syncWebSearchToggleUi();
    showToast('模型切换失败，已恢复原模型', 'error');
    return;
  }
  const missingKey = model.source === 'openrouter'
    ? !settings.openrouterApiKeyConfigured
    : model.provider === 'moonshot' ? !settings.moonshotApiKeyConfigured : !settings.apiKeyConfigured;
  showToast(missingKey ? `已切换至 ${model.name}；请先配置对应 API Key` : `当前对话已切换至 ${model.name}`, missingKey ? 'info' : 'success');
}

function historyActionIcon(action) {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="5" cy="12" r="1.4"></circle>
      <circle cx="12" cy="12" r="1.4"></circle>
      <circle cx="19" cy="12" r="1.4"></circle>
    </svg>
  `;
}

function closeHistoryMenu({ restoreFocus = false } = {}) {
  const menu = $('#aiHistoryContextMenu');
  const trigger = historyMenuTrigger;
  if (menu) {
    menu.hidden = true;
    menu.style.removeProperty('left');
    menu.style.removeProperty('top');
  }
  if (trigger) trigger.setAttribute('aria-expanded', 'false');
  historyMenuConversationId = '';
  historyMenuTrigger = null;
  if (restoreFocus && trigger?.isConnected) trigger.focus();
}

function positionHistoryMenu(trigger, menu) {
  menu.hidden = false;
  const triggerRect = trigger.getBoundingClientRect();
  const margin = 8;
  const gap = 6;
  const menuWidth = menu.offsetWidth || 156;
  const menuHeight = menu.offsetHeight || 92;
  const left = Math.max(margin, Math.min(window.innerWidth - menuWidth - margin, triggerRect.right - menuWidth));
  const below = triggerRect.bottom + gap;
  const top = below + menuHeight <= window.innerHeight - margin
    ? below
    : Math.max(margin, triggerRect.top - menuHeight - gap);
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
}

function openHistoryMenu(id, trigger, { focus = 'first' } = {}) {
  const menu = $('#aiHistoryContextMenu');
  if (!menu || !trigger || !conversations.some(chat => chat.id === id)) return;
  closeHistoryMenu();
  historyMenuConversationId = id;
  historyMenuTrigger = trigger;
  trigger.setAttribute('aria-expanded', 'true');
  positionHistoryMenu(trigger, menu);
  if (focus) {
    requestAnimationFrame(() => {
      const options = [...menu.querySelectorAll('[role="menuitem"]:not(:disabled)')];
      (focus === 'last' ? options.at(-1) : options[0])?.focus();
    });
  }
}

function toggleHistoryMenu(id, trigger) {
  if (historyMenuConversationId === id && !$('#aiHistoryContextMenu')?.hidden) {
    closeHistoryMenu({ restoreFocus: true });
    return;
  }
  openHistoryMenu(id, trigger, { focus: null });
}

function moveHistoryMenuFocus(direction) {
  const menu = $('#aiHistoryContextMenu');
  if (!menu || menu.hidden) return;
  const options = [...menu.querySelectorAll('[role="menuitem"]:not(:disabled)')];
  if (!options.length) return;
  const currentIndex = options.indexOf(document.activeElement);
  const nextIndex = currentIndex < 0
    ? (direction > 0 ? 0 : options.length - 1)
    : (currentIndex + direction + options.length) % options.length;
  options[nextIndex].focus();
}

function renderHistory() {
  const list = $('#aiSidebarHistoryList');
  if (!list) return;
  closeHistoryMenu();
  const sorted = [...conversations].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const filtered = sorted.filter(chat => historyMatchesSearch(chat));
  const summary = $('#aiSidebarHistorySummary');
  if (summary) {
    summary.textContent = historySearchQuery.trim()
      ? `${filtered.length} / ${sorted.length} 个对话`
      : `${sorted.length} 个对话`;
  }
  syncHistorySearchControls();
  if (!filtered.length) {
    list.innerHTML = `<div class="ai-history-empty">${historySearchQuery.trim() ? '没有匹配的历史对话' : '暂无历史对话'}</div>`;
    return;
  }
  let currentGroup = '';
  list.innerHTML = filtered.map(chat => {
    const group = historyGroupLabel(chat.updatedAt);
    const heading = group !== currentGroup
      ? `<div class="ai-history-group-title">${escHtml(group)}</div>`
      : '';
    currentGroup = group;
    return `
      ${heading}
      <div class="ai-history-item${chat.id === activeConversationId ? ' active' : ''}${isConversationSending(chat.id) ? ' is-sending' : ''}" data-id="${escHtml(chat.id)}">
        <button type="button" class="ai-history-open" title="${escHtml(chat.title || '新对话')}">
          <span class="ai-history-title">${escHtml(chat.title || '新对话')}</span>
          ${isConversationSending(chat.id) ? '<span class="ai-history-running" title="正在生成回答"><span class="sr-only">正在生成回答</span></span>' : ''}
        </button>
        <button type="button" class="ai-history-more" data-action="toggle-history-menu" aria-haspopup="menu" aria-expanded="false" aria-controls="aiHistoryContextMenu" title="更多对话操作" aria-label="更多对话操作">${historyActionIcon('more')}</button>
      </div>
    `;
  }).join('');
}

function historyMatchesSearch(chat) {
  const query = historySearchQuery.trim().toLowerCase();
  if (!query) return true;
  const title = String(chat?.title || '新对话').toLowerCase();
  if (title.includes(query)) return true;
  if (historySearchScope !== 'full') return false;
  return (chat?.messages || []).some(message => String(message?.content || '').toLowerCase().includes(query));
}

function syncHistorySearchControls() {
  const input = $('#aiHistorySearchInput');
  if (input && input.value !== historySearchQuery) input.value = historySearchQuery;
  document.querySelectorAll('[data-ai-history-search-scope]').forEach(button => {
    const active = button.dataset.aiHistorySearchScope === historySearchScope;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
}

function updateAiChatHeader() {
  const current = activeConversation();
  const title = $('#aiChatCurrentTitle');
  const meta = $('#aiChatCurrentMeta');
  const badge = $('#aiChatCurrentBadge');
  const skill = selectedSkill();
  const messageCount = current?.messages?.length || 0;
  const countLabel = `${messageCount} 条消息`;
  const scopeLabel = settings.logContextEnabled
    ? '日志访问会遵守当前访问范围'
    : '仅发送你主动输入的内容';
  if (title) title.textContent = current?.title || '新对话';
  if (meta) meta.textContent = `${countLabel} · ${scopeLabel}`;
  if (badge) {
    if (skill) {
      const metaInfo = skillMeta(skill.id);
      badge.textContent = `技能 · ${metaInfo.label || metaInfo.name}`;
    } else if (settings.webSearchEnabled) {
      const activeModel = activeConversationModel();
      badge.textContent = activeModel.startsWith('kimi-') && settings.kimiWebSearchEnabled
        ? 'Kimi 官方联网 · 实验'
        : aiModelMeta(activeModel)?.source === 'openrouter' ? 'OpenRouter 联网 · Beta' : '联网搜索已开';
    } else {
      badge.textContent = '本地对话';
    }
  }
}

function scrollMessagesToBottom() {
  const list = $('#aiChatMessages');
  if (!list) return;
  const scroller = list.closest('.ai-chat-body') || list;
  scroller.scrollTop = scroller.scrollHeight;
}

function renderReasoningDisclosure(message) {
  if (message?.role !== 'assistant' || typeof message.reasoningContent !== 'string' || !message.reasoningContent.trim()) return '';
  const characterCount = Array.from(message.reasoningContent).length;
  const streaming = Boolean(message.streaming);
  return `
    <details class="ai-reasoning${streaming ? ' is-streaming' : ''}"${streaming ? ' open' : ''}>
      <summary>
        <span class="ai-reasoning-indicator" aria-hidden="true"></span>
        <span class="ai-reasoning-label">${streaming ? '正在推理' : '推理过程'}</span>
        <span class="ai-reasoning-count">${characterCount} 字</span>
        <svg class="ai-reasoning-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="m8 10 4 4 4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </summary>
      <div class="ai-reasoning-content markdown-body">${renderToHtml(message.reasoningContent)}</div>
    </details>
  `;
}

function renderMessages() {
  const list = $('#aiChatMessages');
  const messages = activeMessages();
  const current = activeConversation();
  const currentSending = isConversationSending(current?.id);
  syncModelControls();
  $('#aiChatView')?.classList.toggle('is-empty', !messages.length);
  updateAiChatHeader();
  if (!messages.length) {
    const dailyQuote = dailyQuoteForDate(businessDateString());
    list.innerHTML = `
      <div class="ai-chat-empty">
        <div class="ai-chat-empty-copy">
          <blockquote class="ai-daily-quote">
            <p>${escHtml(dailyQuote.text)}</p>
            <cite>${escHtml(dailyQuote.source || dailyQuote.author || '佚名')}</cite>
          </blockquote>
          <span>输入你想讨论的问题。日志访问会遵守 AI 设置里的访问范围。</span>
        </div>
      </div>
    `;
    renderHistory();
    return;
  }

  list.innerHTML = messages.map((message, index) => `
    <div class="ai-message ${message.role}" data-message-index="${index}">
      <div class="ai-message-bubble">
        ${renderAiMediaAttachments(message.attachments)}
        ${renderReasoningDisclosure(message)}
        <div class="ai-message-content${message.role === 'assistant' ? ' markdown-body' : ''}">${message.role === 'assistant' ? renderToHtml(message.content) : escHtml(message.content)}</div>
        ${message.role === 'assistant' && message.imageGeneration ? renderImageGenerationCard(message.imageGeneration, index, { insertable: false }) : ''}
        ${message.role === 'assistant' && message.toolCall ? renderToolCallCard(message.toolCall, message.toolResult, index) : ''}
        <div class="ai-message-footer">
          <button type="button" class="ai-message-copy" data-action="copy-message" aria-label="复制${message.role === 'user' ? '问题' : '回答'}" title="复制${message.role === 'user' ? '问题' : '回答'}">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" stroke-width="2"/>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
            </svg>
          </button>
          ${message.role === 'assistant' && message.modelId ? `<span class="ai-message-model" title="${escHtml(`${message.provider || 'AI'} · ${message.modelId}`)}">${escHtml(aiModelLabel(message.modelId))}</span>` : ''}
          <span class="ai-message-time">${escHtml(messageTimeLabel(message, current?.updatedAt))}</span>
        </div>
      </div>
      ${message.role === 'assistant' && Array.isArray(message.sources) && message.sources.length ? `
        <div class="ai-message-sources" aria-label="联网搜索来源">
          <span>来源</span>
          ${message.sources.map((source, index) => {
            const provider = source.provider ? `${source.provider}: ` : '';
            return `<a href="${escHtml(source.url)}" target="_blank" rel="noopener noreferrer">${index + 1}. ${escHtml(provider + (source.title || source.url))}</a>`;
          }).join('')}
        </div>
      ` : ''}
    </div>
  `).join('') + (currentSending && !messages.at(-1)?.streaming ? `
    <div class="ai-message assistant ai-message-thinking">
      <div class="ai-message-content">
        <span class="ai-thinking-text">正在思考</span>
        <span class="ai-thinking-dots" aria-hidden="true"><i></i><i></i><i></i></span>
      </div>
    </div>
  ` : '');
  scrollMessagesToBottom();
  renderHistory();
}

function renderAiMediaAttachments(attachments = []) {
  if (!Array.isArray(attachments) || !attachments.length) return '';
  return `<div class="ai-message-media">${attachments.map(item => item.kind === 'video' ? `
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

function renderPendingMedia() {
  const container = $('#aiMediaDrafts');
  if (!container) return;
  container.innerHTML = pendingMedia.map(item => `
    <div class="ai-media-draft" data-media-id="${escHtml(item.id)}">
      ${item.kind === 'image'
        ? `<img src="${escHtml(item.url)}" alt="">`
        : '<span class="ai-media-video-icon" aria-hidden="true">▶</span>'}
      <span title="${escHtml(item.name)}">${escHtml(item.name)}</span>
      <button type="button" data-action="remove-ai-media" aria-label="移除 ${escHtml(item.name)}" title="移除">×</button>
    </div>
  `).join('');
  container.hidden = !pendingMedia.length;
}

function pastedAiImagesFromClipboard(event) {
  const clipboard = event.clipboardData;
  const hasImageExtension = file => /\.(png|jpe?g|webp|gif)$/i.test(String(file?.name || ''));
  const imageItems = [...(clipboard?.items || [])]
    .filter(item => item.kind === 'file' && String(item.type || '').toLowerCase().startsWith('image/'));
  const clipboardImageFiles = [...(clipboard?.files || [])]
    .filter(file => String(file.type || '').toLowerCase().startsWith('image/') || hasImageExtension(file));
  const itemFiles = imageItems.map(item => item.getAsFile()).filter(Boolean);
  const rawFiles = itemFiles.length ? itemFiles : clipboardImageFiles;
  const found = imageItems.length > 0 || clipboardImageFiles.length > 0;
  const extensionByType = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
  };
  const typeByExtension = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
  };
  const pastedAt = Date.now();
  const files = rawFiles.map((file, index) => {
    const originalName = String(file.name || '').trim();
    const originalExtension = originalName.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase() || '';
    const type = extensionByType[String(file.type || '').toLowerCase()]
      ? String(file.type).toLowerCase()
      : typeByExtension[originalExtension];
    const extension = extensionByType[type];
    if (!extension) return null;
    const validName = originalName && typeByExtension[originalExtension] === type;
    const name = validName ? originalName : `pasted-image-${pastedAt}-${index + 1}${extension}`;
    return new File([file], name, {
      type,
      lastModified: Number.isFinite(file.lastModified) ? file.lastModified : pastedAt,
    });
  }).filter(Boolean);
  return { found, files };
}

async function handleAiChatPaste(event) {
  const pasted = pastedAiImagesFromClipboard(event);
  if (!pasted.found) return;
  event.preventDefault();
  event.stopPropagation();
  if (isConversationSending() || mediaUploading) {
    showToast('请等待当前发送或上传完成后再粘贴图片', 'info');
    return;
  }
  if (!pasted.files.length) {
    showToast('仅支持粘贴 PNG、JPG、WebP 或 GIF 图片', 'error');
    return;
  }
  await uploadAiMediaFiles(pasted.files);
}

async function uploadAiMediaFiles(files) {
  const selected = [...files];
  if (!selected.length) return;
  if (pendingMedia.length + selected.length > 4) return showToast('每条消息最多添加 4 个附件', 'error');
  const totalBytes = pendingMedia.reduce((sum, item) => sum + (item.bytes || 0), 0) + selected.reduce((sum, file) => sum + file.size, 0);
  if (totalBytes > 100 * 1024 * 1024) return showToast('每条消息附件合计不能超过 100MB', 'error');
  mediaUploading = true;
  updateSendState();
  try {
    for (const file of selected) {
      const form = new FormData();
      form.append('media', file);
      const res = await apiFetch('/api/ai/media', { method: 'POST', body: form });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `上传 ${file.name} 失败`);
      pendingMedia.push(data);
      renderPendingMedia();
    }
  } catch (err) {
    showToast('附件上传失败：' + err.message, 'error');
  } finally {
    mediaUploading = false;
    const input = $('#aiMediaInput');
    if (input) input.value = '';
    updateSendState();
  }
}

async function removePendingMedia(id) {
  const item = pendingMedia.find(media => media.id === id);
  pendingMedia = pendingMedia.filter(media => media.id !== id);
  renderPendingMedia();
  updateSendState();
  if (!item) return;
  try { await apiFetch(`/api/ai/media/${encodeURIComponent(id)}`, { method: 'DELETE' }); } catch {}
}

function renderImageGenerationCard(imageGeneration, index, { insertable = false } = {}) {
  const status = imageGeneration.status || 'pending';
  const markdown = markdownForGeneratedImage(imageGeneration);
  const originalPrompt = imageGeneration.originalPrompt || imageGeneration.prompt || '';
  const optimizedPrompt = imageGeneration.optimizedPrompt || '';
  const promptMode = imageGeneration.promptMode === 'original' || !optimizedPrompt ? 'original' : 'optimized';
  const currentPrompt = selectedImagePrompt(imageGeneration);
  const promptOptions = status === 'pending' || status === 'error' ? `
    <div class="ai-image-prompt-options" role="group" aria-label="选择生图 prompt">
      <button type="button" class="ai-image-prompt-choice${promptMode === 'original' ? ' active' : ''}" data-action="choose-image-prompt" data-prompt-mode="original">原始 prompt</button>
      <button type="button" class="ai-image-prompt-choice${promptMode === 'optimized' ? ' active' : ''}" data-action="choose-image-prompt" data-prompt-mode="optimized"${optimizedPrompt ? '' : ' disabled'}>优化 prompt</button>
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
    <div class="ai-image-card ${status}" data-image-generation-index="${index}">
      <div class="ai-image-card-head">
        <strong>生图确认</strong>
        <span>${escHtml(imageGeneration.size || settings.seedreamSize || DEFAULT_SEEDREAM_SIZE)} · ${escHtml(imageGeneration.model || settings.seedreamModel || DEFAULT_SEEDREAM_MODEL)}</span>
      </div>
      ${status === 'optimizing' ? `
        <div class="ai-image-optimizing">
          <span>正在优化 prompt</span>
          <span class="ai-thinking-dots" aria-hidden="true"><i></i><i></i><i></i></span>
        </div>
        <div class="ai-image-prompt">${escHtml(originalPrompt)}</div>
      ` : promptOptions}
      ${status === 'done' && imageGeneration.url ? `
        <img class="ai-image-preview" src="${escHtml(imageGeneration.url)}" alt="AI 生成图片" data-action="open-image-preview" data-preview-url="${escHtml(imageGeneration.url)}" aria-label="双击放大 AI 生成图片" title="双击放大图片">
        <code class="ai-image-markdown">${escHtml(markdown)}</code>
      ` : ''}
      ${status === 'error' ? `<div class="ai-image-error">${escHtml(imageGeneration.error || '生图失败')}</div>` : ''}
      <div class="ai-image-actions">
        ${status === 'pending' ? `<button type="button" class="btn-primary btn-sm" data-action="generate-image">生成图片</button><button type="button" class="btn-secondary btn-sm" data-action="cancel-image">取消</button>` : ''}
        ${status === 'done' ? `<button type="button" class="btn-secondary btn-sm" data-action="copy-image-markdown">复制 Markdown</button>${insertable ? `<button type="button" class="btn-primary btn-sm" data-action="insert-image-markdown">插入到光标</button>` : ''}` : ''}
        ${status === 'error' ? `<button type="button" class="btn-secondary btn-sm" data-action="generate-image">重试</button>` : ''}
      </div>
    </div>
  `;
}

function enabledSkills() {
  return availableSkills.filter(skill => skill.enabled !== false);
}

function selectedSkill() {
  return enabledSkills().find(skill => skill.id === selectedSkillId) || null;
}

function skillMeta(skillId) {
  const skill = availableSkills.find(item => item.id === skillId) || {};
  const fallback = {
    westock: { name: 'WeStock Data', label: 'WeStock', runningText: '正在查询市场数据', errorText: 'WeStock 查询失败' },
    perplexity: { name: 'Perplexity Search', label: 'Perplexity', runningText: '正在搜索网页', errorText: 'Perplexity 搜索失败' },
    logs: { name: '日志管理', label: '日志', runningText: '正在执行日志操作', errorText: '日志操作失败' },
  }[skillId] || { name: 'AI Skill', label: 'Skill', runningText: '正在执行技能', errorText: '技能执行失败' };
  return {
    ...fallback,
    ...skill,
    label: skill.label || fallback.label,
    name: skill.name || fallback.name,
  };
}

function skillIconSvg(skillId) {
  const icons = {
    westock: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 17.5 9 12l3.2 3.2L20 6.5"></path><path d="M4 20h16"></path><path d="M4 4v16"></path></svg>',
    perplexity: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 4a7 7 0 1 0 4.95 11.95"></path><path d="m15 15 5 5"></path><path d="M8.5 10.5h5"></path><path d="M11 8v5"></path></svg>',
    logs: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4h9l3 3v13H6z"></path><path d="M14 4v4h4"></path><path d="M9 12h6"></path><path d="M9 16h4"></path></svg>',
  };
  return icons[skillId] || '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 1.85 5.05L19 9.9l-4.12 3.15L16.15 18 12 15.2 7.85 18l1.27-4.95L5 9.9l5.15-1.85L12 3Z"></path></svg>';
}

function renderSelectedSkillChip() {
  const row = $('#aiSkillChipRow');
  if (!row) return;
  const skill = selectedSkill();
  const meta = skill ? skillMeta(skill.id) : null;
  row.innerHTML = skill ? `
    <span class="ai-skill-chip" data-skill-id="${escHtml(skill.id)}">
      <span class="ai-skill-chip-icon">${skillIconSvg(skill.id)}</span>
      <span>${escHtml(meta.label || meta.name)}</span>
      <button type="button" id="btnAiSkillClear" aria-label="移除技能">&times;</button>
    </span>
  ` : '';
  $('#btnAiSkillClear')?.addEventListener('click', () => {
    selectedSkillId = '';
    renderSelectedSkillChip();
    renderSkillPicker();
  });
  updateAiChatHeader();
}

function renderSkillPicker() {
  const picker = $('#aiSkillPicker');
  if (!picker) return;
  const skills = enabledSkills();
  picker.innerHTML = skills.length ? `
    <div class="ai-skill-picker-title">选择技能</div>
    <div class="ai-skill-picker-list" role="listbox">
      ${skills.map((skill) => {
        const meta = skillMeta(skill.id);
        return `
        <button type="button" class="ai-skill-option${skill.id === selectedSkillId ? ' active' : ''}" data-skill-id="${escHtml(skill.id)}" role="option" aria-selected="${skill.id === selectedSkillId ? 'true' : 'false'}">
          <span class="ai-skill-option-icon">${skillIconSvg(skill.id)}</span>
          <span>
            <strong>${escHtml(meta.name)}</strong>
            <small>${escHtml(meta.description || 'AI 技能')}</small>
          </span>
        </button>
      `;
      }).join('')}
    </div>
  ` : '<div class="ai-skill-empty">暂无已启用技能，请到设置中开启</div>';
}

function closeSkillPicker() {
  const picker = $('#aiSkillPicker');
  const button = $('#btnAiSkill');
  if (!picker || picker.hidden) return;
  picker.hidden = true;
  button?.setAttribute('aria-expanded', 'false');
}

function toggleSkillPicker() {
  const picker = $('#aiSkillPicker');
  const button = $('#btnAiSkill');
  if (!picker) return;
  renderSkillPicker();
  picker.hidden = !picker.hidden;
  button?.setAttribute('aria-expanded', String(!picker.hidden));
}

function chooseSkill(id) {
  if (!enabledSkills().some(skill => skill.id === id)) return;
  selectedSkillId = id;
  closeSkillPicker();
  renderSelectedSkillChip();
  renderSkillPicker();
  $('#aiChatInput').focus();
}

function formatLogToolValue(value, fallback = '未设置') {
  const text = typeof value === 'string' ? value.trim() : value === undefined || value === null ? '' : String(value);
  return text || fallback;
}

function renderLogToolPreview(toolCall) {
  if (toolCall?.skillId !== 'logs') return '';
  const args = toolCall.args || {};
  const fields = [];
  if (toolCall.tool === 'update' || toolCall.tool === 'delete') fields.push(['日志 ID', formatLogToolValue(args.id)]);
  if (toolCall.tool !== 'delete' || args.title) fields.push(['标题', formatLogToolValue(args.title, toolCall.tool === 'update' ? '未修改' : '未命名日志')]);
  if (toolCall.tool !== 'delete' || args.category) fields.push(['分类', formatLogToolValue(args.category, toolCall.tool === 'update' ? '未修改' : '其他')]);
  if (toolCall.tool !== 'delete' || args.log_date) fields.push(['日期', formatLogToolValue(args.log_date, toolCall.tool === 'update' ? '未修改' : '默认日期')]);
  if (toolCall.tool !== 'delete' || args.hours !== undefined) fields.push(['工时', `${formatLogToolValue(args.hours, toolCall.tool === 'update' ? '未修改' : '0')}h`]);
  const content = typeof args.content === 'string' ? args.content.trim() : '';
  const contentPreview = content ? `${content.slice(0, 180)}${content.length > 180 ? '...' : ''}` : (toolCall.tool === 'update' ? '未修改正文' : '');
  const operation = {
    create: '新增日志',
    update: '编辑日志',
    delete: '删除日志',
  }[toolCall.tool] || '日志操作';
  return `
    <div class="ai-log-tool-summary">
      <div class="ai-log-tool-operation">${escHtml(operation)}</div>
      <div class="ai-log-tool-fields">
        ${fields.map(([label, value]) => `
          <span><strong>${escHtml(label)}</strong>${escHtml(value)}</span>
        `).join('')}
      </div>
      ${contentPreview ? `<p>${escHtml(contentPreview)}</p>` : ''}
    </div>
  `;
}

function renderToolCallCard(toolCall, toolResult, index) {
  if (!toolCall || !['westock', 'perplexity', 'logs'].includes(toolCall.skillId)) return '';
  const status = toolCall.status || 'pending';
  const argsJson = JSON.stringify(toolCall.args || {}, null, 2);
  const meta = skillMeta(toolCall.skillId);
  const dangerClass = toolCall.skillId === 'logs' && toolCall.tool === 'delete' ? ' danger' : '';
  return `
    <div class="ai-tool-card ${escHtml(status)}${dangerClass}" data-tool-message-index="${index}">
      <div class="ai-tool-card-head">
        <strong>${escHtml(meta.name)}</strong>
        <span>${escHtml(toolCall.tool)}</span>
      </div>
      ${renderLogToolPreview(toolCall)}
      <pre class="ai-tool-args"><code>${escHtml(argsJson)}</code></pre>
      ${status === 'running' ? `
        <div class="ai-tool-running">
          <span>${escHtml(meta.runningText)}</span>
          <span class="ai-thinking-dots" aria-hidden="true"><i></i><i></i><i></i></span>
        </div>
      ` : ''}
      ${status === 'error' ? `<div class="ai-tool-error">${escHtml(toolCall.error || meta.errorText)}</div>` : ''}
      ${toolResult?.content ? `<div class="ai-tool-result markdown-body">${renderToHtml(toolResult.content)}</div>` : ''}
      <div class="ai-tool-actions">
        ${status === 'pending' || status === 'error' ? `<button type="button" class="btn-primary btn-sm" data-action="execute-skill-tool">确认执行</button>` : ''}
      </div>
    </div>
  `;
}

async function chooseImagePrompt(index, mode) {
  const chat = activeConversation();
  const imageGeneration = chat?.messages[index]?.imageGeneration;
  if (!imageGeneration || !['original', 'optimized'].includes(mode)) return;
  if (mode === 'optimized' && !imageGeneration.optimizedPrompt) return;
  imageGeneration.promptMode = mode;
  imageGeneration.selectedPrompt = selectedImagePrompt(imageGeneration);
  imageGeneration.prompt = imageGeneration.selectedPrompt;
  chat.updatedAt = Date.now();
  await saveConversations();
  renderConversationIfActive(chat.id);
}

async function copyMessageByIndex(index) {
  const message = activeMessages()[index];
  if (!message?.content) return;
  try {
    await copyText(message.content);
    showToast(message.role === 'user' ? '问题已复制' : '回答已复制', 'success');
  } catch (err) {
    showToast('复制失败: ' + err.message, 'error');
  }
}

async function generateImageForMessage(index) {
  const chat = activeConversation();
  const message = chat?.messages[index];
  const imageGeneration = message?.imageGeneration;
  const prompt = selectedImagePrompt(imageGeneration);
  if (!chat || !prompt || isConversationSending(chat.id)) return;
  imageGeneration.status = 'generating';
  imageGeneration.selectedPrompt = prompt;
  imageGeneration.prompt = prompt;
  message.content = '正在生成图片...';
  chat.updatedAt = Date.now();
  await saveConversations();
  renderConversationIfActive(chat.id);
  try {
    const res = await apiFetch('/api/ai/image/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt,
        model: settings.seedreamModel || DEFAULT_SEEDREAM_MODEL,
        size: settings.seedreamSize || DEFAULT_SEEDREAM_SIZE,
        watermark: settings.seedreamWatermark !== false,
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
    await saveConversations();
    renderConversationIfActive(chat.id);
  } catch (err) {
    imageGeneration.status = 'error';
    imageGeneration.error = err.message;
    message.content = `生图失败：${err.message}`;
    chat.updatedAt = Date.now();
    await saveConversations();
    renderConversationIfActive(chat.id);
    showToast('生图失败：' + err.message, 'error');
  }
}

async function cancelImageGeneration(index) {
  const chat = activeConversation();
  const message = chat?.messages[index];
  if (!message?.imageGeneration) return;
  message.imageGeneration.status = 'cancelled';
  message.content = '已取消生图。';
  chat.updatedAt = Date.now();
  await saveConversations();
  renderConversationIfActive(chat.id);
}

async function copyImageMarkdown(index) {
  const markdown = markdownForGeneratedImage(activeMessages()[index]?.imageGeneration);
  if (!markdown) return;
  try {
    await copyText(markdown);
    showToast('图片 Markdown 已复制', 'success');
  } catch (err) {
    showToast('复制失败: ' + err.message, 'error');
  }
}

function updateSendState() {
  const input = $('#aiChatInput');
  const send = $('#btnAiSend');
  const image = $('#btnAiImage');
  const hasText = input.value.trim().length > 0;
  const hasMedia = pendingMedia.length > 0;
  const currentSending = isConversationSending();
  const disabled = currentSending || mediaUploading || (!hasText && !hasMedia);
  send.disabled = disabled;
  if (image) image.disabled = currentSending || mediaUploading || !hasText || hasMedia;
  const attach = $('#btnAiAttach');
  if (attach) attach.disabled = currentSending || mediaUploading || pendingMedia.length >= 4;
  const sendingStatus = $('#aiChatSending');
  if (sendingStatus) {
    sendingStatus.style.display = currentSending ? '' : 'none';
    if (currentSending) sendingStatus.textContent = conversationRequests.get(activeConversationId)?.status || '正在思考...';
  }
  resizeAiChatInput();
}

function resizeAiChatInput() {
  const input = $('#aiChatInput');
  if (!input) return;
  input.style.height = 'auto';
  const styles = window.getComputedStyle(input);
  const minHeight = Number.parseFloat(styles.minHeight) || 44;
  const maxHeight = Number.parseFloat(styles.maxHeight) || 144;
  const contentHeight = Math.max(minHeight, Math.min(input.scrollHeight, maxHeight));
  input.style.height = `${Math.round(contentHeight)}px`;
  input.style.overflowY = input.scrollHeight > maxHeight + 1 ? 'auto' : 'hidden';
}

function announceAiStatus(text) {
  const status = $('#aiChatStatus');
  if (!status) return;
  status.textContent = '';
  requestAnimationFrame(() => {
    status.textContent = text;
  });
}

function setAiSendingStatus(text = '正在思考...', { announce = true, conversationId = activeConversationId } = {}) {
  const request = conversationRequests.get(conversationId);
  if (request) request.status = text;
  if (conversationId !== activeConversationId) return;
  const status = $('#aiChatSending');
  if (status) status.textContent = text;
  if (announce) announceAiStatus(text);
}

function currentSettings() {
  const skill = selectedSkill();
  const model = activeConversationModel();
  const reasoning = aiModelMeta(model)?.reasoning || {};
  let reasoningMode = settings.reasoningMode || 'effort';
  let reasoningEffort = settings.reasoningEffort || DEFAULT_REASONING;
  if (reasoningMode === 'disabled' && (reasoning.supported === false || reasoning.mandatory)) reasoningMode = 'default';
  if (reasoningMode === 'effort') {
    const efforts = Array.isArray(reasoning.supportedEfforts) ? reasoning.supportedEfforts : [];
    if (!efforts.length) reasoningMode = 'default';
    else if (!efforts.includes(reasoningEffort)) reasoningEffort = reasoning.defaultEffort || efforts[0];
  }
  const request = {
    model,
    thinkingMode: reasoningMode === 'disabled' ? 'disabled' : 'enabled',
    reasoningMode,
    reasoningEffort,
    stream: skill || settings.logContextEnabled || (model.startsWith('kimi-') && settings.webSearchEnabled && settings.kimiWebSearchEnabled)
      ? false
      : Boolean(settings.stream),
    userProfile: settings.userProfile || '',
    logContextEnabled: Boolean(settings.logContextEnabled),
    diaryContextEnabled: Boolean(settings.diaryContextEnabled),
    webSearchEnabled: Boolean(settings.webSearchEnabled),
    kimiWebSearchEnabled: Boolean(settings.kimiWebSearchEnabled),
    openrouterZdrEnabled: Boolean(settings.openrouterZdrEnabled),
    webSearchDepth: settings.webSearchDepth || 'basic',
    logAccessPolicy: settings.logAccessPolicy,
  };
  if (skill) request.skill = { id: skill.id };
  return request;
}

function updateSettingsButton() {
  const button = $('#btnAiApiKey');
  if (!button) return;
  const hasKey = settings.apiKeyConfigured || settings.moonshotApiKeyConfigured || settings.openrouterApiKeyConfigured;
  button.classList.toggle('has-key', hasKey);
  button.title = hasKey ? 'AI 设置（API Key 已保存）' : 'AI 设置';
  button.setAttribute('aria-label', button.title);
}

function syncChatModelSwitcherUi() {
  syncModelControls();
}

async function switchChatModel(event) {
  const nextModel = event.currentTarget?.value;
  if (aiModelMeta(nextModel)) await chooseModelFromPicker(nextModel);
}

function syncWebSearchToggleUi() {
  const enabled = Boolean(settings.webSearchEnabled);
  const settingsToggle = $('#aiWebSearchToggle');
  const quickToggle = $('#aiChatWebSearchToggle');
  if (settingsToggle) settingsToggle.checked = enabled;
  if (quickToggle) {
    quickToggle.checked = enabled;
    const label = quickToggle.closest('.ai-chat-web-toggle');
    label?.classList.toggle('active', enabled);
    const model = activeConversationModel();
    const meta = aiModelMeta(model);
    if (label) label.title = model.startsWith('kimi-') && settings.kimiWebSearchEnabled
      ? '联网搜索（Kimi 官方 Formula，实验性）'
      : meta?.source === 'openrouter'
        ? '联网搜索（OpenRouter 官方工具，Beta）'
        : '联网搜索（Tavily/Perplexity）';
  }
  updateAiChatHeader();
}

function effectiveLogAccessPolicy() {
  return settings.logAccessPolicy || defaultLogAccessPolicy();
}

function renderPolicyTree(treeSelector, policy, emptyText) {
  const tree = $(treeSelector);
  if (!tree) return;
  if (!aiAccessCategories.length) {
    tree.innerHTML = `<div class="ai-access-empty">${escHtml(emptyText)}</div>`;
    return;
  }
  const allowed = new Set(policy.allowedParents || []);
  const denied = policy.deniedSubcategories || {};
  tree.innerHTML = aiAccessCategories.map(category => {
    const subs = Array.isArray(category.sub) ? category.sub : [];
    const parentAllowed = allowed.has(category.name);
    const deniedSubs = new Set(denied[category.name] || []);
    return `
      <div class="ai-access-parent" data-parent="${escHtml(category.name)}">
        <label class="ai-access-parent-row">
          <input type="checkbox" class="ai-access-parent-check" ${parentAllowed ? 'checked' : ''}>
          <span>
            <strong>${escHtml(category.name)}</strong>
            <small>${subs.length ? `${subs.length} 个子分类` : '无子分类'}${category.name === '日记' ? ' · 需解锁日记' : ''}</small>
          </span>
        </label>
        ${subs.length ? `
          <div class="ai-access-sublist">
            ${subs.map(sub => `
              <label class="ai-access-sub-row">
                <input type="checkbox" class="ai-access-sub-check" data-sub="${escHtml(sub)}" ${parentAllowed && !deniedSubs.has(sub) ? 'checked' : ''} ${parentAllowed ? '' : 'disabled'}>
                <span>${escHtml(sub)}</span>
              </label>
            `).join('')}
          </div>
        ` : ''}
      </div>
    `;
  }).join('');
}

function renderAccessTree() {
  renderPolicyTree('#aiAccessTree', effectiveLogAccessPolicy(), '暂无分类，保存后会默认允许非日记分类。');
}

function collectPolicyFromTree(selector) {
  const allowedParents = [];
  const deniedSubcategories = {};
  document.querySelectorAll(`${selector} .ai-access-parent`).forEach(parentEl => {
    const parent = parentEl.dataset.parent;
    const parentCheck = parentEl.querySelector('.ai-access-parent-check');
    if (!parent || !parentCheck?.checked) return;
    allowedParents.push(parent);
    const denied = [...parentEl.querySelectorAll('.ai-access-sub-check')]
      .filter(input => !input.checked)
      .map(input => input.dataset.sub)
      .filter(Boolean);
    if (denied.length) deniedSubcategories[parent] = denied;
  });
  return { allowedParents, deniedSubcategories };
}

function collectLogAccessPolicyFromPage() {
  return collectPolicyFromTree('#aiAccessTree');
}

function fillSettingsModal() {
  const apiKeyInput = $('#aiApiKeyInput');
  if (!apiKeyInput) return;
  apiKeyInput.value = '';
  apiKeyInput.placeholder = settings.apiKeyConfigured ? '已配置；留空保持不变' : 'sk-...';
  $('#aiMoonshotApiKeyInput').value = '';
  $('#aiMoonshotApiKeyInput').placeholder = settings.moonshotApiKeyConfigured ? '已配置；留空保持不变' : 'sk-...';
  $('#aiOpenRouterApiKeyInput').value = '';
  $('#aiOpenRouterApiKeyInput').placeholder = settings.openrouterApiKeyConfigured ? '已配置；留空保持不变' : 'sk-or-...';
  syncModelSelect($('#aiModelSelect'), settings.model || DEFAULT_MODEL);
  $('#aiModelSelect').value = settings.model || DEFAULT_MODEL;
  $('#aiThinkingMode').value = settings.thinkingMode || 'enabled';
  $('#aiReasoningMode').value = settings.reasoningMode || 'effort';
  $('#aiReasoningEffort').value = settings.reasoningEffort || DEFAULT_REASONING;
  $('#aiOpenRouterZdrToggle').checked = settings.openrouterZdrEnabled !== false;
  $('#aiStreamToggle').checked = Boolean(settings.stream);
  $('#aiUserProfileInput').value = settings.userProfile || '';
  $('#aiLogContextToggle').checked = Boolean(settings.logContextEnabled);
  $('#aiDiaryContextToggle').checked = Boolean(settings.diaryContextEnabled);
  $('#aiTavilyApiKeyInput').value = '';
  $('#aiTavilyApiKeyInput').placeholder = settings.tavilyApiKeyConfigured ? '已配置；留空保持不变' : 'tvly-...';
  $('#aiPerplexityApiKeyInput').value = '';
  $('#aiPerplexityApiKeyInput').placeholder = settings.perplexityApiKeyConfigured ? '已配置；留空保持不变' : 'pplx-...';
  syncWebSearchToggleUi();
  $('#aiWebSearchDepth').value = settings.webSearchDepth || 'basic';
  $('#aiSeedreamApiKeyInput').value = '';
  $('#aiSeedreamApiKeyInput').placeholder = settings.seedreamApiKeyConfigured ? '已配置；留空保持不变' : '4b45...';
  $('#aiSeedreamModel').value = settings.seedreamModel || DEFAULT_SEEDREAM_MODEL;
  $('#aiSeedreamSize').value = settings.seedreamSize || DEFAULT_SEEDREAM_SIZE;
  $('#aiSeedreamWatermark').checked = settings.seedreamWatermark !== false;
  $('#aiSkillWestockToggle').checked = settings.skills?.westock?.enabled !== false;
  $('#aiSkillPerplexityToggle').checked = settings.skills?.perplexity?.enabled !== false;
  $('#aiKimiWebSearchToggle').checked = Boolean(settings.kimiWebSearchEnabled);
  syncModelSettingsUi();
  renderAccessTree();
}

function syncModelSettingsUi() {
  const model = $('#aiModelSelect')?.value || settings.model || DEFAULT_MODEL;
  const meta = aiModelMeta(model);
  const reasoning = meta?.reasoning || {};
  const modeSelect = $('#aiReasoningMode');
  const thinkingField = $('#aiThinkingModeField');
  const reasoningField = $('#aiReasoningEffortField');
  if (thinkingField) thinkingField.hidden = true;
  const disabledMode = modeSelect?.querySelector('option[value="disabled"]');
  const effortMode = modeSelect?.querySelector('option[value="effort"]');
  if (disabledMode) disabledMode.disabled = reasoning.supported === false || reasoning.mandatory === true;
  if (effortMode) effortMode.disabled = reasoning.supported === false || !Array.isArray(reasoning.supportedEfforts) || !reasoning.supportedEfforts.length;
  if (modeSelect?.selectedOptions[0]?.disabled) modeSelect.value = 'default';
  const supportedEfforts = Array.isArray(reasoning.supportedEfforts) ? reasoning.supportedEfforts : [];
  [...($('#aiReasoningEffort')?.options || [])].forEach(option => {
    option.disabled = supportedEfforts.length > 0 && !supportedEfforts.includes(option.value);
  });
  if ($('#aiReasoningEffort')?.selectedOptions[0]?.disabled) {
    $('#aiReasoningEffort').value = reasoning.defaultEffort || supportedEfforts[0] || DEFAULT_REASONING;
  }
  if (reasoningField) reasoningField.hidden = modeSelect?.value !== 'effort' || effortMode?.disabled;
  syncModelControls();
  const hint = $('#aiModelCapabilityHint');
  if (hint) {
    const source = meta?.source === 'openrouter' ? 'OpenRouter' : '直连';
    hint.textContent = meta
      ? `${source} · ${modelModalityLabel(meta)} · ${formatModelContext(meta.contextLength)} 上下文 · ${formatModelPrice(meta)}`
      : '该模型当前不在可用目录中，发送前需要重新加载模型。';
  }
  syncAiSettingsSelectControls();
}

function setSettingsTab(tab) {
  const activeTab = ['access', 'image', 'skills'].includes(tab) ? tab : 'chat';
  const titles = {
    chat: '基础设置',
    access: '访问设置',
    image: '生图设置',
    skills: '技能设置',
  };
  document.querySelectorAll('[data-ai-settings-tab]').forEach(button => {
    const selected = button.dataset.aiSettingsTab === activeTab;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-selected', String(selected));
  });
  const title = $('#aiSettingsSectionTitle');
  if (title) title.textContent = titles[activeTab] || titles.chat;
  $('#aiSettingsPanelChat').hidden = activeTab !== 'chat';
  $('#aiSettingsPanelChat').classList.toggle('active', activeTab === 'chat');
  $('#aiSettingsPanelAccess').hidden = activeTab !== 'access';
  $('#aiSettingsPanelAccess').classList.toggle('active', activeTab === 'access');
  $('#aiSettingsPanelImage').hidden = activeTab !== 'image';
  $('#aiSettingsPanelImage').classList.toggle('active', activeTab === 'image');
  $('#aiSettingsPanelSkills').hidden = activeTab !== 'skills';
  $('#aiSettingsPanelSkills').classList.toggle('active', activeTab === 'skills');
}

function openSettingsPage(tab = 'chat') {
  fillSettingsModal();
  resetSkillConfigPanels();
  setSettingsTab(tab);
  document.body.classList.remove('editor-fullscreen');
  const fullscreenButton = $('#btnEditorFullscreen');
  if (fullscreenButton) {
    fullscreenButton.setAttribute('aria-pressed', 'false');
    fullscreenButton.textContent = '全屏编辑';
    fullscreenButton.title = '进入全屏编辑';
  }
  setMainView('aiSettingsView');
  requestAnimationFrame(() => $('#aiApiKeyInput')?.focus());
}

function closeSettingsPage() {
  syncAiSidebarChrome();
  setMainView('aiChatView');
  renderMessages();
  updateSendState();
  requestAnimationFrame(() => $('#aiChatInput')?.focus());
}

async function saveSettingsFromPage() {
  settings = normalizeSettings({
    apiKey: $('#aiApiKeyInput').value.trim(),
    moonshotApiKey: $('#aiMoonshotApiKeyInput').value.trim(),
    openrouterApiKey: $('#aiOpenRouterApiKeyInput').value.trim(),
    model: $('#aiModelSelect').value,
    thinkingMode: $('#aiReasoningMode').value === 'disabled' ? 'disabled' : 'enabled',
    reasoningMode: $('#aiReasoningMode').value,
    reasoningEffort: $('#aiReasoningEffort').value,
    openrouterZdrEnabled: $('#aiOpenRouterZdrToggle').checked,
    stream: $('#aiStreamToggle').checked,
    userProfile: $('#aiUserProfileInput').value.trim(),
    logContextEnabled: $('#aiLogContextToggle').checked,
    diaryContextEnabled: $('#aiDiaryContextToggle').checked,
    tavilyApiKey: $('#aiTavilyApiKeyInput').value.trim(),
    perplexityApiKey: $('#aiPerplexityApiKeyInput').value.trim(),
    webSearchEnabled: $('#aiWebSearchToggle').checked,
    kimiWebSearchEnabled: $('#aiKimiWebSearchToggle').checked,
    webSearchDepth: $('#aiWebSearchDepth').value,
    seedreamApiKey: $('#aiSeedreamApiKeyInput').value.trim(),
    seedreamModel: $('#aiSeedreamModel').value,
    seedreamSize: $('#aiSeedreamSize').value,
    seedreamWatermark: $('#aiSeedreamWatermark').checked,
    apiKeyConfigured: settings.apiKeyConfigured,
    moonshotApiKeyConfigured: settings.moonshotApiKeyConfigured,
    openrouterApiKeyConfigured: settings.openrouterApiKeyConfigured,
    tavilyApiKeyConfigured: settings.tavilyApiKeyConfigured,
    perplexityApiKeyConfigured: settings.perplexityApiKeyConfigured,
    seedreamApiKeyConfigured: settings.seedreamApiKeyConfigured,
    logAccessPolicy: collectLogAccessPolicyFromPage(),
    skills: {
      westock: { enabled: $('#aiSkillWestockToggle').checked },
      perplexity: { enabled: $('#aiSkillPerplexityToggle').checked },
    },
  });
  try {
    await saveSettings();
    closeSettingsPage();
  } catch (err) {
    showToast('AI 设置保存失败：' + err.message, 'error');
  }
}

async function refreshAfterLogToolRun() {
  const [{ loadLogs }, { loadStats }, { loadCategories }] = await Promise.all([
    import('./logList.js'),
    import('./stats.js'),
    import('./categories.js'),
  ]);
  await Promise.all([loadLogs(), loadStats(), loadCategories()]);
}

function setSkillConfigExpanded(card, expanded) {
  const trigger = card?.querySelector('[data-skill-config-toggle]');
  const panel = trigger ? document.getElementById(trigger.getAttribute('aria-controls')) : null;
  if (!trigger || !panel) return;
  trigger.setAttribute('aria-expanded', String(expanded));
  panel.hidden = !expanded;
  card.classList.toggle('expanded', expanded);
}

function resetSkillConfigPanels() {
  document.querySelectorAll('.ai-skill-config-card').forEach(card => setSkillConfigExpanded(card, false));
}

function toggleSkillConfigFromHeader(event) {
  const trigger = event.currentTarget;
  const card = trigger.closest('.ai-skill-config-card');
  setSkillConfigExpanded(card, trigger.getAttribute('aria-expanded') !== 'true');
}

async function clearApiKey() {
  settings.apiKey = '';
  settings.moonshotApiKey = '';
  settings.openrouterApiKey = '';
  settings.tavilyApiKey = '';
  settings.perplexityApiKey = '';
  settings.seedreamApiKey = '';
  $('#aiApiKeyInput').value = '';
  $('#aiMoonshotApiKeyInput').value = '';
  $('#aiOpenRouterApiKeyInput').value = '';
  $('#aiTavilyApiKeyInput').value = '';
  $('#aiPerplexityApiKeyInput').value = '';
  $('#aiSeedreamApiKeyInput').value = '';
  try {
    await saveSettings({ quiet: true, clearApiKeys: true });
    showToast('API Key 已清除', 'info');
  } catch (err) {
    showToast('API Key 清除失败：' + err.message, 'error');
  }
}

function openRenameModal(id) {
  const chat = conversations.find(item => item.id === id);
  if (!chat) return;
  closeHistoryMenu();
  renameConversationId = id;
  $('#aiRenameInput').value = chat.title || '新对话';
  openModal($('#aiRenameOverlay'), '#aiRenameInput');
}

function closeRenameModal() {
  renameConversationId = '';
  closeModal($('#aiRenameOverlay'));
}

async function newConversation() {
  closeHistoryMenu();
  const chat = createConversation();
  conversations.unshift(chat);
  activeConversationId = chat.id;
  renderMessages();
  updateSendState();
  $('#aiChatInput').focus();
  await saveConversations();
}

async function switchConversation(id) {
  if (!conversations.some(chat => chat.id === id)) return;
  closeHistoryMenu();
  activeConversationId = id;
  renderMessages();
  updateSendState();
  $('#aiChatInput').focus();
  await saveConversations();
}

async function saveRenameConversation() {
  const chat = conversations.find(item => item.id === renameConversationId);
  if (!chat) return;
  const title = $('#aiRenameInput').value.trim();
  if (!title) return;
  chat.title = title.slice(0, 40);
  chat.updatedAt = Date.now();
  await saveConversations();
  renderHistory();
  closeRenameModal();
}

async function deleteConversation(id) {
  const chat = conversations.find(item => item.id === id);
  if (!chat) return;
  closeHistoryMenu();
  if (isConversationSending(id)) {
    showToast('这个对话仍在生成回答，完成后再删除', 'info');
    return;
  }
  const confirmed = await confirmDialog({
    title: '删除对话',
    message: `删除对话「${chat.title || '新对话'}」？此操作只会删除本地历史记录。`,
    confirmText: '删除',
    cancelText: '取消',
    danger: true,
  });
  if (!confirmed) return;
  conversations = conversations.filter(item => item.id !== id);
  if (!conversations.length) conversations = [createConversation()];
  if (activeConversationId === id) activeConversationId = conversations[0].id;
  await saveConversations();
  renderMessages();
}

function scheduleStreamRender(conversationId = activeConversationId) {
  if (conversationId !== activeConversationId) return;
  if (scheduleStreamRender.pending) return;
  scheduleStreamRender.pending = true;
  requestAnimationFrame(() => {
    scheduleStreamRender.pending = false;
    if (conversationId === activeConversationId) renderMessages();
  });
}

function parseSseBlock(block) {
  const event = { type: 'message', data: '' };
  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('event:')) event.type = line.slice(6).trim() || 'message';
    if (line.startsWith('data:')) event.data += line.slice(5).trimStart();
  }
  return event;
}

async function readStreamingReply(res, assistantMessage, conversationId) {
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'AI 请求失败');
  }
  const reader = res.body?.getReader ? res.body.getReader() : null;
  if (!reader) throw new Error('浏览器不支持流式读取');

  const decoder = new TextDecoder();
  let buffer = '';
  let done = false;
  let reasoningStarted = false;
  let answerStarted = false;
  while (!done) {
    const chunk = await reader.read();
    done = chunk.done;
    buffer += decoder.decode(chunk.value || new Uint8Array(), { stream: !done });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() || '';
    for (const block of blocks) {
      const event = parseSseBlock(block);
      if (!event.data) continue;
      const data = JSON.parse(event.data);
      if (event.type === 'delta') {
        const content = typeof data.content === 'string' ? data.content : '';
        if (content) {
          if (!answerStarted) {
            answerStarted = true;
            setAiSendingStatus('正在生成回答...', { conversationId });
          }
          assistantMessage.content += content;
          scheduleStreamRender(conversationId);
        }
      }
      if (event.type === 'reasoning') {
        const content = typeof data.content === 'string' ? data.content : '';
        if (content) {
          if (!reasoningStarted && !answerStarted) {
            reasoningStarted = true;
            setAiSendingStatus('正在推理...', { conversationId });
          }
          assistantMessage.reasoningContent = (assistantMessage.reasoningContent || '') + content;
          scheduleStreamRender(conversationId);
        }
      }
      if (event.type === 'sources' && Array.isArray(data.sources)) {
        assistantMessage.sources = data.sources;
        scheduleStreamRender(conversationId);
      }
      if (event.type === 'error') throw new Error(data.error || 'AI 流式请求失败');
      if (event.type === 'done') {
        if (Array.isArray(data.sources) && data.sources.length) assistantMessage.sources = data.sources;
        if (data.provider) assistantMessage.provider = data.provider;
        if (data.modelId) assistantMessage.modelId = data.modelId;
        if (Array.isArray(data.openrouterReasoningDetails) && data.openrouterReasoningDetails.length) {
          assistantMessage.openrouterReasoningDetails = data.openrouterReasoningDetails;
        }
        return;
      }
    }
  }
  throw new Error('AI 流式响应未完整结束');
}

async function readLogBatchReply(res, chat) {
  const reader = res.body?.getReader ? res.body.getReader() : null;
  if (!reader) throw new Error('浏览器不支持批量日志流式读取');
  const decoder = new TextDecoder();
  let buffer = '';
  let resultReceived = false;
  while (true) {
    const chunk = await reader.read();
    buffer += decoder.decode(chunk.value || new Uint8Array(), { stream: !chunk.done });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() || '';
    for (const block of blocks) {
      const event = parseSseBlock(block);
      if (!event.data) continue;
      const data = JSON.parse(event.data);
      if (event.type === 'context') {
        setAiSendingStatus(`准备分析 ${data.logCount || 0} 条日志（${data.batchCount || 0} 批）...`, { conversationId: chat.id });
      } else if (event.type === 'progress' && data.phase === 'analyze') {
        setAiSendingStatus(`正在分析第 ${data.completed || 0}/${data.total || 0} 批日志...`, { conversationId: chat.id });
      } else if (event.type === 'progress' && data.phase === 'merge') {
        setAiSendingStatus(`正在合并日志证据（${data.completed || 0}/${data.total || 0}）...`, { conversationId: chat.id });
      } else if (event.type === 'result') {
        if (!data.message?.content) throw new Error('AI 没有返回内容');
        const assistantMessage = {
          role: 'assistant',
          content: data.message.content,
          createdAt: Date.now(),
          sources: Array.isArray(data.sources) ? data.sources : [],
        };
        if (data.message.reasoningContent) assistantMessage.reasoningContent = data.message.reasoningContent;
        if (Array.isArray(data.message.providerTrace) && data.message.providerTrace.length) assistantMessage.providerTrace = data.message.providerTrace;
        if (Array.isArray(data.message.openrouterReasoningDetails) && data.message.openrouterReasoningDetails.length) assistantMessage.openrouterReasoningDetails = data.message.openrouterReasoningDetails;
        if (data.message.provider) assistantMessage.provider = data.message.provider;
        if (data.message.modelId) assistantMessage.modelId = data.message.modelId;
        if (['westock', 'logs'].includes(data.toolCall?.skillId)) assistantMessage.toolCall = data.toolCall;
        chat.messages.push(assistantMessage);
        resultReceived = true;
      } else if (event.type === 'error') {
        throw new Error(data.error || 'AI 日志分析失败');
      }
    }
    if (chunk.done) break;
  }
  if (!resultReceived) throw new Error('AI 日志分析未返回完整结果');
}

async function sendJsonMessage(chat, requestSettings, { confirmLargeLogBatch = false, signal } = {}) {
  const res = await apiFetch('/api/ai/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: chat.messages, ...requestSettings, confirmLargeLogBatch }),
    signal,
  });
  if (res.status === 409) {
    const data = await res.json().catch(() => ({}));
    if (data.code === 'AI_LOG_BATCH_CONFIRMATION_REQUIRED') {
      const confirmed = await confirmDialog({
        title: '确认分析全部日志',
        message: `将读取 ${data.logCount || 0} 条日志，分为 ${data.batchCount || 0} 批，预计调用 AI ${data.estimatedCalls || data.batchCount || 0} 次。是否继续？`,
        confirmText: '继续分析',
        cancelText: '取消',
      });
      if (!confirmed) {
        const error = new Error('已取消全量日志分析');
        error.cancelled = true;
        throw error;
      }
      return sendJsonMessage(chat, requestSettings, { confirmLargeLogBatch: true, signal });
    }
    throw new Error(data.error || 'AI 请求失败');
  }
  if (res.ok && (res.headers.get('content-type') || '').includes('text/event-stream')) {
    return readLogBatchReply(res, chat);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'AI 请求失败');
  if (!data.message?.content) throw new Error('AI 没有返回内容');
  const assistantMessage = { role: 'assistant', content: data.message.content, createdAt: Date.now(), sources: Array.isArray(data.sources) ? data.sources : [] };
  if (data.message.reasoningContent) assistantMessage.reasoningContent = data.message.reasoningContent;
  if (Array.isArray(data.message.providerTrace) && data.message.providerTrace.length) assistantMessage.providerTrace = data.message.providerTrace;
  if (Array.isArray(data.message.openrouterReasoningDetails) && data.message.openrouterReasoningDetails.length) assistantMessage.openrouterReasoningDetails = data.message.openrouterReasoningDetails;
  if (data.message.provider) assistantMessage.provider = data.message.provider;
  if (data.message.modelId) assistantMessage.modelId = data.message.modelId;
  if (['westock', 'logs'].includes(data.toolCall?.skillId)) assistantMessage.toolCall = data.toolCall;
  chat.messages.push(assistantMessage);
}

async function executeSkillTool(index) {
  const chat = activeConversation();
  const message = chat?.messages[index];
  const toolCall = message?.toolCall;
  if (!chat || !toolCall || !['westock', 'perplexity', 'logs'].includes(toolCall.skillId) || isConversationSending(chat.id)) return;
  if (toolCall.skillId === 'logs' && toolCall.tool === 'delete') {
    const confirmedDelete = await confirmDialog({
      title: '删除日志',
      message: '确认删除这条日志？此操作不可撤销。',
      confirmText: '删除',
      cancelText: '取消',
      danger: true,
    });
    if (!confirmedDelete) return;
  }
  const meta = skillMeta(toolCall.skillId);
  toolCall.status = 'running';
  toolCall.error = '';
  chat.updatedAt = Date.now();
  await saveConversations();
  renderConversationIfActive(chat.id);
  try {
    const endpoint = toolCall.skillId === 'logs'
      ? '/api/ai/logs/run'
      : `/api/ai/skills/${encodeURIComponent(toolCall.skillId)}/run`;
    const res = await apiFetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tool: toolCall.tool,
        args: toolCall.args || {},
        confirmed: true,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || meta.errorText);
    toolCall.status = 'done';
    message.toolResult = {
      skillId: toolCall.skillId,
      tool: toolCall.tool,
      content: data.content || `${meta.name} 没有返回内容`,
    };
    if (toolCall.skillId === 'logs') {
      await refreshAfterLogToolRun();
    }
    chat.updatedAt = Date.now();
    await saveConversations();
    renderConversationIfActive(chat.id);
  } catch (err) {
    toolCall.status = 'error';
    toolCall.error = err.message;
    chat.updatedAt = Date.now();
    await saveConversations();
    renderConversationIfActive(chat.id);
    showToast(`${meta.errorText}：${err.message}`, 'error');
  }
}

async function sendStreamingMessage(chat, requestSettings, signal) {
  const model = requestSettings.model || activeConversationModel();
  const meta = aiModelMeta(model);
  const assistantMessage = { role: 'assistant', content: '', createdAt: Date.now(), streaming: true, modelId: model, provider: meta?.source === 'openrouter' ? 'openrouter' : meta?.provider };
  chat.messages.push(assistantMessage);
  renderConversationIfActive(chat.id);
  const res = await apiFetch('/api/ai/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: chat.messages.filter(message => !message.streaming), ...requestSettings }),
    signal,
  });
  try {
    await readStreamingReply(res, assistantMessage, chat.id);
    delete assistantMessage.streaming;
  } catch (err) {
    const index = chat.messages.indexOf(assistantMessage);
    if (index >= 0) chat.messages.splice(index, 1);
    throw err;
  }
}

async function sendMessage({ forceImage = false } = {}) {
  const input = $('#aiChatInput');
  const content = input.value.trim();
  const chat = activeConversation();
  if (!chat || isConversationSending(chat.id)) return;
  const attachments = forceImage ? [] : pendingMedia.map(item => ({ ...item }));
  if ((!content && !attachments.length) || mediaUploading) return;
  if (forceImage && pendingMedia.length) return showToast('生图和媒体理解是两个独立操作，请先发送或移除附件', 'info');
  const model = activeConversationModel();
  const modelMeta = aiModelMeta(model);
  if (!modelMeta || modelMeta.unavailable) return showToast('当前模型已不可用，请重新选择模型', 'error');
  const conversationAttachments = [...attachments, ...chat.messages.flatMap(message => message.attachments || [])];
  const needsVideo = conversationAttachments.some(item => item.kind === 'video' || String(item.mimeType || '').startsWith('video/'));
  const needsImage = conversationAttachments.some(item => !item.kind || item.kind === 'image' || String(item.mimeType || '').startsWith('image/'));
  if ((needsImage && !modelMeta.inputModalities?.includes('image')) || (needsVideo && !modelMeta.inputModalities?.includes('video'))) {
    return showToast(`${aiModelLabel(model)} 不支持当前会话中的附件类型，请新建对话或选择兼容模型`, 'error');
  }

  if (settings.diaryContextEnabled) chat.diarySensitive = true;
  const userMessage = { role: 'user', content, createdAt: Date.now() };
  if (attachments.length) userMessage.attachments = attachments;
  chat.messages.push(userMessage);
  if (chat.title === '新对话') chat.title = conversationTitleFrom(content || attachments.map(item => item.name).join('、'));
  if (chat.messages.length > MAX_MESSAGES) chat.messages = chat.messages.slice(-MAX_MESSAGES);
  chat.updatedAt = Date.now();
  input.value = '';
  if (attachments.length) {
    pendingMedia = [];
    renderPendingMedia();
  }
  if (forceImage) {
    const prompt = imagePromptFrom(content);
    const assistantMessage = {
      role: 'assistant',
      content: '正在优化生图 prompt，请稍等...',
      createdAt: Date.now(),
      imageGeneration: {
        status: 'optimizing',
        originalPrompt: prompt,
        selectedPrompt: prompt,
        promptMode: 'original',
        prompt,
        model: settings.seedreamModel || DEFAULT_SEEDREAM_MODEL,
        size: settings.seedreamSize || DEFAULT_SEEDREAM_SIZE,
      },
    };
    chat.messages.push(assistantMessage);
    chat.updatedAt = Date.now();
    await saveConversations();
    renderConversationIfActive(chat.id);
    updateSendState();
    try {
      const optimizedPrompt = await optimizeImagePrompt(prompt);
      assistantMessage.imageGeneration.optimizedPrompt = optimizedPrompt;
      assistantMessage.imageGeneration.promptMode = optimizedPrompt ? 'optimized' : 'original';
      assistantMessage.imageGeneration.selectedPrompt = selectedImagePrompt(assistantMessage.imageGeneration);
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
    await saveConversations();
    renderConversationIfActive(chat.id);
    if (chat.id === activeConversationId) input.focus();
    return;
  }
  const requestSettings = currentSettings();
  const request = beginConversationRequest(chat);
  setAiSendingStatus('正在思考...', { conversationId: chat.id });
  updateSendState();
  renderConversationIfActive(chat.id);
  try {
    await saveConversations();
    if (requestSettings.stream) {
      await sendStreamingMessage(chat, requestSettings, request.controller.signal);
    } else {
      await sendJsonMessage(chat, requestSettings, { signal: request.controller.signal });
    }
    if (chat.messages.length > MAX_MESSAGES) chat.messages = chat.messages.slice(-MAX_MESSAGES);
    chat.updatedAt = Date.now();
    await saveConversations();
    if (chat.id === activeConversationId) announceAiStatus('AI 回答已完成');
    else showToast(`对话「${chat.title || '新对话'}」回答已完成`, 'success');
    renderConversationIfActive(chat.id);
  } catch (err) {
    const cancelled = err.cancelled || err.name === 'AbortError';
    if (!cancelled) showToast(`对话「${chat.title || '新对话'}」失败：${err.message}`, 'error');
    if (chat.id === activeConversationId) {
      announceAiStatus(cancelled ? '已取消 AI 请求' : `AI 对话失败：${err.message}`);
    }
    const last = chat.messages.at(-1);
    if (last?.streaming) {
      chat.messages.pop();
    }
    chat.updatedAt = Date.now();
    await saveConversations();
    renderConversationIfActive(chat.id);
  } finally {
    finishConversationRequest(chat.id);
    if (chat.id === activeConversationId) {
      updateSendState();
      renderMessages();
      input.focus();
    } else {
      renderHistory();
    }
  }
}

export function showAiChatView() {
  previousViewId = visibleMainViewId();
  document.body.classList.remove('editor-fullscreen');
  const fullscreenButton = $('#btnEditorFullscreen');
  if (fullscreenButton) {
    fullscreenButton.setAttribute('aria-pressed', 'false');
    fullscreenButton.textContent = '全屏编辑';
    fullscreenButton.title = '进入全屏编辑';
  }
  setMainView('aiChatView');
  renderMessages();
  updateSendState();
  requestAnimationFrame(() => $('#aiChatInput').focus());
}

export function hideAiChatView() {
  setMainView(previousViewId);
}

export async function initAiChat() {
  await loadSettings();
  await Promise.all([loadConversations(), loadAccessCategories()]);
  await loadModels({ quiet: true });
  await loadSkills();
  const historyContextMenu = $('#aiHistoryContextMenu');
  if (historyContextMenu && historyContextMenu.parentElement !== document.body) document.body.appendChild(historyContextMenu);
  initAiSettingsSelectControls();
  updateSettingsButton();
  syncChatModelSwitcherUi();
  syncWebSearchToggleUi();
  renderMessages();
  renderPendingMedia();
  updateSendState();
  syncAiSettingsSelectControls();

  $('#btnAiSidebarNewChat').addEventListener('click', newConversation);
  $('#btnAiApiKey').addEventListener('click', () => openSettingsPage('chat'));
  $('#btnAiSettingsBack').addEventListener('click', closeSettingsPage);
  $('#btnAiApiKeyCancel').addEventListener('click', closeSettingsPage);
  $('#btnAiApiKeySave').addEventListener('click', saveSettingsFromPage);
  $('#btnAiApiKeyClear').addEventListener('click', clearApiKey);
  $('#btnAiAccessRefresh')?.addEventListener('click', async () => {
    await loadAccessCategories();
    renderAccessTree();
  });
  $('#aiRenameClose').addEventListener('click', closeRenameModal);
  $('#btnAiRenameCancel').addEventListener('click', closeRenameModal);
  $('#btnAiRenameSave').addEventListener('click', saveRenameConversation);
  $('#aiRenameOverlay').addEventListener('click', (event) => {
    if (event.target === $('#aiRenameOverlay')) closeRenameModal();
  });
  $('#aiRenameInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') saveRenameConversation();
  });
  document.querySelectorAll('[data-ai-settings-tab]').forEach(button => {
    button.addEventListener('click', () => setSettingsTab(button.dataset.aiSettingsTab));
  });
  $('#aiApiKeyInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) saveSettingsFromPage();
  });
  document.querySelectorAll('[data-skill-config-toggle]').forEach(button => {
    button.addEventListener('click', toggleSkillConfigFromHeader);
  });
  $('#aiAccessTree')?.addEventListener('change', (event) => {
    const parentEl = event.target.closest('.ai-access-parent');
    if (!parentEl) return;
    if (event.target.classList.contains('ai-access-parent-check')) {
      const enabled = event.target.checked;
      parentEl.querySelectorAll('.ai-access-sub-check').forEach(input => {
        input.disabled = !enabled;
        input.checked = enabled;
      });
    }
  });
  $('#aiSidebarHistoryList').addEventListener('click', (event) => {
    const item = event.target.closest('.ai-history-item');
    if (!item) return;
    const actionButton = event.target.closest('[data-action]');
    if (actionButton?.dataset.action === 'toggle-history-menu') {
      event.stopPropagation();
      return toggleHistoryMenu(item.dataset.id, actionButton);
    }
    switchConversation(item.dataset.id);
  });
  $('#aiModelSelect')?.addEventListener('change', syncModelSettingsUi);
  $('#aiReasoningMode')?.addEventListener('change', syncModelSettingsUi);
  $('#aiSidebarHistoryList').addEventListener('keydown', (event) => {
    const trigger = event.target.closest('.ai-history-more');
    if (!trigger || !['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    event.preventDefault();
    const item = trigger.closest('.ai-history-item');
    openHistoryMenu(item?.dataset.id, trigger, { focus: event.key === 'ArrowUp' ? 'last' : 'first' });
  });
  $('#aiHistoryContextMenu')?.addEventListener('click', (event) => {
    const item = event.target.closest('[data-history-menu-action]');
    if (!item) return;
    const id = historyMenuConversationId;
    const action = item.dataset.historyMenuAction;
    closeHistoryMenu({ restoreFocus: true });
    if (action === 'rename') return openRenameModal(id);
    if (action === 'delete') return deleteConversation(id);
  });
  $('#aiHistoryContextMenu')?.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveHistoryMenuFocus(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveHistoryMenuFocus(-1);
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      const options = [...event.currentTarget.querySelectorAll('[role="menuitem"]:not(:disabled)')];
      (event.key === 'Home' ? options[0] : options.at(-1))?.focus();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closeHistoryMenu({ restoreFocus: true });
    } else if (event.key === 'Tab') {
      closeHistoryMenu();
    }
  });
  $('#aiSidebarHistoryList')?.addEventListener('scroll', () => closeHistoryMenu(), { passive: true });
  window.addEventListener('resize', () => closeHistoryMenu());
  $('#aiHistorySearchInput')?.addEventListener('input', (event) => {
    historySearchQuery = event.target.value;
    renderHistory();
  });
  document.querySelectorAll('[data-ai-history-search-scope]').forEach(button => {
    button.addEventListener('click', () => {
      historySearchScope = button.dataset.aiHistorySearchScope === 'full' ? 'full' : 'title';
      renderHistory();
      $('#aiHistorySearchInput')?.focus();
    });
  });
  $('#btnAiSend').addEventListener('click', sendMessage);
  $('#btnAiImage')?.addEventListener('click', () => sendMessage({ forceImage: true }));
  $('#btnAiAttach')?.addEventListener('click', () => $('#aiMediaInput')?.click());
  $('#aiMediaInput')?.addEventListener('change', (event) => uploadAiMediaFiles(event.target.files || []));
  $('#aiMediaDrafts')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-action="remove-ai-media"]');
    const draft = button?.closest('[data-media-id]');
    if (draft) removePendingMedia(draft.dataset.mediaId);
  });
  $('#btnAiSkill')?.addEventListener('click', toggleSkillPicker);
  $('#btnAiChatModel')?.addEventListener('click', () => openModelPicker('conversation'));
  $('#btnAiDefaultModel')?.addEventListener('click', () => openModelPicker('default'));
  document.addEventListener('editor-ai-model-picker-request', (event) => {
    const detail = event.detail || {};
    editorModelPickerContext = {
      conversationId: typeof detail.conversationId === 'string' ? detail.conversationId : '',
      selectedModelId: isAiModelId(detail.modelId) ? detail.modelId : settings.model,
    };
    openModelPicker('editor');
  });
  $('#btnAiModelRefresh')?.addEventListener('click', refreshModelsFromPicker);
  $('#btnAiModelPickerClose')?.addEventListener('click', () => closeModelPicker());
  $('#aiModelPickerOverlay')?.addEventListener('click', (event) => {
    if (event.target === event.currentTarget) closeModelPicker();
  });
  $('#aiModelPickerSearch')?.addEventListener('input', (event) => {
    modelPickerQuery = event.target.value;
    renderModelPicker();
  });
  $('#aiModelPickerSearch')?.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      $('#aiModelPickerList')?.querySelector('.ai-model-option:not(:disabled)')?.focus();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closeModelPicker();
    }
  });
  $('#aiModelPickerList')?.addEventListener('click', (event) => {
    const option = event.target.closest('[data-model-id]');
    if (option && !option.disabled) chooseModelFromPicker(option.dataset.modelId);
  });
  $('#aiModelPickerList')?.addEventListener('keydown', (event) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'Escape'].includes(event.key)) return;
    event.preventDefault();
    if (event.key === 'Escape') return closeModelPicker();
    const options = [...event.currentTarget.querySelectorAll('.ai-model-option:not(:disabled)')];
    if (!options.length) return;
    if (event.key === 'Home') return options[0].focus();
    if (event.key === 'End') return options.at(-1).focus();
    const current = options.indexOf(document.activeElement);
    const next = event.key === 'ArrowDown'
      ? Math.min(options.length - 1, current + 1)
      : Math.max(0, current < 0 ? 0 : current - 1);
    options[next].focus();
  });
  $('#aiChatModelSelect')?.addEventListener('change', switchChatModel);
  $('#aiChatWebSearchToggle')?.addEventListener('change', async (event) => {
    const previous = Boolean(settings.webSearchEnabled);
    settings.webSearchEnabled = event.target.checked;
    syncWebSearchToggleUi();
    try {
      await saveSettings({ quiet: true });
      showToast(settings.webSearchEnabled ? '联网搜索已开启' : '联网搜索已关闭', 'success');
    } catch (err) {
      settings.webSearchEnabled = previous;
      syncWebSearchToggleUi();
      showToast('联网搜索开关保存失败：' + err.message, 'error');
    }
  });
  $('#aiSkillPicker')?.addEventListener('click', (event) => {
    const option = event.target.closest('[data-skill-id]');
    if (option) chooseSkill(option.dataset.skillId);
  });
  $('#aiChatMessages').addEventListener('click', async (event) => {
    if (await handleInternalLogLinkClick(event)) return;
    const toolAction = event.target.closest('.ai-tool-card [data-action]');
    if (toolAction) {
      const item = toolAction.closest('.ai-message');
      const index = Number(item?.dataset.messageIndex);
      if (Number.isInteger(index) && toolAction.dataset.action === 'execute-skill-tool') return executeSkillTool(index);
    }
    const imageAction = event.target.closest('.ai-image-card [data-action]');
    if (imageAction) {
      const item = imageAction.closest('.ai-message');
      const index = Number(item?.dataset.messageIndex);
      if (!Number.isInteger(index)) return;
      const action = imageAction.dataset.action;
      if (action === 'open-image-preview') return;
      if (action === 'choose-image-prompt') return chooseImagePrompt(index, imageAction.dataset.promptMode);
      if (action === 'generate-image') return generateImageForMessage(index);
      if (action === 'cancel-image') return cancelImageGeneration(index);
      if (action === 'copy-image-markdown') return copyImageMarkdown(index);
    }
    const copyButton = event.target.closest('[data-action="copy-message"]');
    if (!copyButton) return;
    const item = copyButton.closest('.ai-message');
    const index = Number(item?.dataset.messageIndex);
    if (Number.isInteger(index)) copyMessageByIndex(index);
  });
  $('#aiChatMessages').addEventListener('dblclick', (event) => {
    const mediaPreview = event.target.closest('[data-ai-media-preview]');
    if (mediaPreview) {
      event.preventDefault();
      return openAiImagePreview(mediaPreview.src, mediaPreview.alt || 'AI 图片附件');
    }
    const preview = event.target.closest('.ai-image-preview[data-action="open-image-preview"]');
    if (!preview) return;
    event.preventDefault();
    openAiImagePreview(preview.dataset.previewUrl || preview.src, preview.alt || 'AI 生成图片');
  });
  $('#aiChatInput').addEventListener('input', updateSendState);
  $('#aiChatInput').addEventListener('paste', handleAiChatPaste);
  $('#aiChatInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      sendMessage();
    }
  });
  document.addEventListener('click', (event) => {
    if (!event.target.closest('#aiHistoryContextMenu') && !event.target.closest('.ai-history-more')) closeHistoryMenu();
    if (event.target.closest('#btnAiSkill') || event.target.closest('#aiSkillPicker')) return;
    closeSkillPicker();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !$('#aiHistoryContextMenu')?.hidden) closeHistoryMenu({ restoreFocus: true });
    if (event.key === 'Escape' && $('#aiModelPickerOverlay')?.style.display !== 'none') closeModelPicker();
  });
}
