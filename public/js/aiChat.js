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
const API_KEY_STORAGE_KEY = 'deepseekApiKey';
const CHAT_STORAGE_KEY = 'aiChatConversations';
const ACTIVE_CHAT_STORAGE_KEY = 'aiChatActiveConversationId';
const AI_CONVERSATIONS_ENDPOINT = '/api/ai/conversations';
const AI_SETTINGS_ENDPOINT = '/api/ai/settings';
const AI_SKILLS_ENDPOINT = '/api/ai/skills';
const AI_SETTINGS_SELECT_IDS = ['aiModelSelect', 'aiReasoningEffort', 'aiSeedreamModel', 'aiSeedreamSize', 'aiWebSearchDepth'];

let conversations = [];
let allConversations = [];
let activeConversationId = '';
let previousViewId = 'listView';
let sending = false;
let renameConversationId = '';
let availableSkills = [];
let selectedSkillId = '';
let aiAccessCategories = [];
let historySearchQuery = '';
let historySearchScope = 'title';
let settings = {
  apiKey: '',
  model: DEFAULT_MODEL,
  reasoningEffort: DEFAULT_REASONING,
  stream: false,
  userProfile: '',
  logContextEnabled: false,
  diaryContextEnabled: false,
  tavilyApiKey: '',
  perplexityApiKey: '',
  webSearchEnabled: false,
  webSearchDepth: 'basic',
  seedreamApiKey: '',
  seedreamModel: DEFAULT_SEEDREAM_MODEL,
  seedreamSize: DEFAULT_SEEDREAM_SIZE,
  seedreamWatermark: true,
  logAccessPolicy: null,
  skills: {
    westock: { enabled: true },
    perplexity: { enabled: true },
  },
};

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
  if (!select || !optionButton) return;
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
    model: ['deepseek-v4-flash', 'deepseek-v4-pro'].includes(value?.model) ? value.model : DEFAULT_MODEL,
    reasoningEffort: ['high', 'max'].includes(value?.reasoningEffort) ? value.reasoningEffort : DEFAULT_REASONING,
    stream: typeof value?.stream === 'boolean' ? value.stream : false,
    userProfile: typeof value?.userProfile === 'string' ? value.userProfile.slice(0, 2000) : '',
    logContextEnabled: typeof value?.logContextEnabled === 'boolean' ? value.logContextEnabled : false,
    diaryContextEnabled: typeof value?.diaryContextEnabled === 'boolean' ? value.diaryContextEnabled : false,
    tavilyApiKey: typeof value?.tavilyApiKey === 'string' ? value.tavilyApiKey : '',
    perplexityApiKey: typeof value?.perplexityApiKey === 'string' ? value.perplexityApiKey : '',
    webSearchEnabled: typeof value?.webSearchEnabled === 'boolean' ? value.webSearchEnabled : false,
    webSearchDepth: ['basic', 'advanced'].includes(value?.webSearchDepth) ? value.webSearchDepth : 'basic',
    seedreamApiKey: typeof value?.seedreamApiKey === 'string' ? value.seedreamApiKey : '',
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

  allConversations = normalizeConversations(loaded.conversations);
  conversations = allConversations.filter(item => item.scope !== 'editor');
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

async function saveConversations() {
  try {
    const nonGlobalConversations = allConversations.filter(item => item.scope === 'editor');
    allConversations = [...nonGlobalConversations, ...conversations.map(item => ({ ...item, scope: 'global', logKey: '' }))];
    await apiFetch(AI_CONVERSATIONS_ENDPOINT, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversations: allConversations, activeConversationId }),
    });
  } catch (err) {
    console.warn('Failed to save AI conversations:', err);
    showToast('AI 历史保存失败：' + err.message, 'error');
  }
}

async function loadSettings() {
  try {
    const res = await apiFetch(AI_SETTINGS_ENDPOINT);
    if (res.ok) settings = normalizeSettings(await res.json());
  } catch (err) {
    console.warn('Failed to load AI settings:', err);
  }

  const legacyApiKey = localStorage.getItem(API_KEY_STORAGE_KEY) || '';
  if (!settings.apiKey && legacyApiKey) {
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

async function saveSettings({ quiet = false } = {}) {
  const submitted = {
    ...settings,
    skills: {
      ...settings.skills,
      westock: { ...settings.skills?.westock },
      perplexity: { ...settings.skills?.perplexity },
    },
  };
  const res = await apiFetch(AI_SETTINGS_ENDPOINT, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(submitted),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'AI 设置保存失败');
  if (
    data.tavilyApiKey !== submitted.tavilyApiKey ||
    data.perplexityApiKey !== submitted.perplexityApiKey ||
    data.userProfile !== submitted.userProfile ||
    data.logContextEnabled !== submitted.logContextEnabled ||
    data.diaryContextEnabled !== submitted.diaryContextEnabled ||
    data.webSearchEnabled !== submitted.webSearchEnabled ||
    data.webSearchDepth !== submitted.webSearchDepth ||
    data.seedreamApiKey !== submitted.seedreamApiKey ||
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
  await loadSkills();
  updateSettingsButton();
  syncWebSearchToggleUi();
  if (!quiet) showToast('AI 设置已保存', 'success');
}

function activeConversation() {
  return conversations.find(item => item.id === activeConversationId) || null;
}

function activeMessages() {
  return activeConversation()?.messages || [];
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
  const res = await apiFetch('/api/ai/image/prompt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt,
      context,
      model: settings.model || DEFAULT_MODEL,
      reasoningEffort: settings.reasoningEffort || DEFAULT_REASONING,
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

function historyActionIcon(action) {
  if (action === 'rename') {
    return `
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 20h4.6L18.7 9.9a2.1 2.1 0 0 0 0-3L17.1 5.3a2.1 2.1 0 0 0-3 0L4 15.4V20Z"></path>
        <path d="m12.8 6.6 4.6 4.6"></path>
      </svg>
    `;
  }
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 7h16"></path>
      <path d="M10 11v6"></path>
      <path d="M14 11v6"></path>
      <path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"></path>
      <path d="M9 7V4h6v3"></path>
    </svg>
  `;
}

function renderHistory() {
  const list = $('#aiSidebarHistoryList');
  if (!list) return;
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
      <div class="ai-history-item${chat.id === activeConversationId ? ' active' : ''}" data-id="${escHtml(chat.id)}">
        <button type="button" class="ai-history-open" title="${escHtml(chat.title || '新对话')}">
          <span class="ai-history-title">${escHtml(chat.title || '新对话')}</span>
        </button>
        <button type="button" class="ai-history-action" data-action="rename" title="重命名对话" aria-label="重命名对话">${historyActionIcon('rename')}</button>
        <button type="button" class="ai-history-action danger" data-action="delete" title="删除对话" aria-label="删除对话">${historyActionIcon('delete')}</button>
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
      badge.textContent = '联网搜索已开';
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

function renderMessages() {
  const list = $('#aiChatMessages');
  const messages = activeMessages();
  const current = activeConversation();
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
  `).join('') + (sending && !messages.at(-1)?.streaming ? `
    <div class="ai-message assistant ai-message-thinking" aria-live="polite">
      <div class="ai-message-content">
        <span class="ai-thinking-text">正在思考</span>
        <span class="ai-thinking-dots" aria-hidden="true"><i></i><i></i><i></i></span>
      </div>
    </div>
  ` : '');
  scrollMessagesToBottom();
  renderHistory();
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
  renderMessages();
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
  if (!chat || !prompt || sending) return;
  imageGeneration.status = 'generating';
  imageGeneration.selectedPrompt = prompt;
  imageGeneration.prompt = prompt;
  message.content = '正在生成图片...';
  chat.updatedAt = Date.now();
  await saveConversations();
  renderMessages();
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
    renderMessages();
  } catch (err) {
    imageGeneration.status = 'error';
    imageGeneration.error = err.message;
    message.content = `生图失败：${err.message}`;
    chat.updatedAt = Date.now();
    await saveConversations();
    renderMessages();
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
  renderMessages();
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
  const disabled = sending || !hasText;
  send.disabled = disabled;
  if (image) image.disabled = disabled;
  $('#aiChatSending').style.display = sending ? '' : 'none';
}

function currentSettings() {
  const skill = selectedSkill();
  const request = {
    apiKey: settings.apiKey,
    model: settings.model || DEFAULT_MODEL,
    thinkingMode: 'enabled',
    reasoningEffort: settings.reasoningEffort || DEFAULT_REASONING,
    stream: skill || settings.logContextEnabled ? false : Boolean(settings.stream),
    userProfile: settings.userProfile || '',
    logContextEnabled: Boolean(settings.logContextEnabled),
    diaryContextEnabled: Boolean(settings.diaryContextEnabled),
    tavilyApiKey: settings.tavilyApiKey,
    perplexityApiKey: settings.perplexityApiKey,
    webSearchEnabled: Boolean(settings.webSearchEnabled),
    webSearchDepth: settings.webSearchDepth || 'basic',
    logAccessPolicy: settings.logAccessPolicy,
  };
  if (skill) request.skill = { id: skill.id };
  return request;
}

function updateSettingsButton() {
  const button = $('#btnAiApiKey');
  if (!button) return;
  button.classList.toggle('has-key', Boolean(settings.apiKey));
  button.title = settings.apiKey ? 'AI 设置（API Key 已保存）' : 'AI 设置';
  button.setAttribute('aria-label', button.title);
}

function syncWebSearchToggleUi() {
  const enabled = Boolean(settings.webSearchEnabled);
  const settingsToggle = $('#aiWebSearchToggle');
  const quickToggle = $('#aiChatWebSearchToggle');
  if (settingsToggle) settingsToggle.checked = enabled;
  if (quickToggle) {
    quickToggle.checked = enabled;
    quickToggle.closest('.ai-chat-web-toggle')?.classList.toggle('active', enabled);
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
  apiKeyInput.value = settings.apiKey;
  $('#aiModelSelect').value = settings.model || DEFAULT_MODEL;
  $('#aiReasoningEffort').value = settings.reasoningEffort || DEFAULT_REASONING;
  $('#aiStreamToggle').checked = Boolean(settings.stream);
  $('#aiUserProfileInput').value = settings.userProfile || '';
  $('#aiLogContextToggle').checked = Boolean(settings.logContextEnabled);
  $('#aiDiaryContextToggle').checked = Boolean(settings.diaryContextEnabled);
  $('#aiTavilyApiKeyInput').value = settings.tavilyApiKey;
  $('#aiPerplexityApiKeyInput').value = settings.perplexityApiKey;
  syncWebSearchToggleUi();
  $('#aiWebSearchDepth').value = settings.webSearchDepth || 'basic';
  $('#aiSeedreamApiKeyInput').value = settings.seedreamApiKey;
  $('#aiSeedreamModel').value = settings.seedreamModel || DEFAULT_SEEDREAM_MODEL;
  $('#aiSeedreamSize').value = settings.seedreamSize || DEFAULT_SEEDREAM_SIZE;
  $('#aiSeedreamWatermark').checked = settings.seedreamWatermark !== false;
  $('#aiSkillWestockToggle').checked = settings.skills?.westock?.enabled !== false;
  $('#aiSkillPerplexityToggle').checked = settings.skills?.perplexity?.enabled !== false;
  syncAiSettingsSelectControls();
  renderAccessTree();
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
    model: $('#aiModelSelect').value,
    reasoningEffort: $('#aiReasoningEffort').value,
    stream: $('#aiStreamToggle').checked,
    userProfile: $('#aiUserProfileInput').value.trim(),
    logContextEnabled: $('#aiLogContextToggle').checked,
    diaryContextEnabled: $('#aiDiaryContextToggle').checked,
    tavilyApiKey: $('#aiTavilyApiKeyInput').value.trim(),
    perplexityApiKey: $('#aiPerplexityApiKeyInput').value.trim(),
    webSearchEnabled: $('#aiWebSearchToggle').checked,
    webSearchDepth: $('#aiWebSearchDepth').value,
    seedreamApiKey: $('#aiSeedreamApiKeyInput').value.trim(),
    seedreamModel: $('#aiSeedreamModel').value,
    seedreamSize: $('#aiSeedreamSize').value,
    seedreamWatermark: $('#aiSeedreamWatermark').checked,
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
  settings.tavilyApiKey = '';
  settings.perplexityApiKey = '';
  settings.seedreamApiKey = '';
  $('#aiApiKeyInput').value = '';
  $('#aiTavilyApiKeyInput').value = '';
  $('#aiPerplexityApiKeyInput').value = '';
  $('#aiSeedreamApiKeyInput').value = '';
  try {
    await saveSettings({ quiet: true });
    showToast('API Key 已清除', 'info');
  } catch (err) {
    showToast('API Key 清除失败：' + err.message, 'error');
  }
}

function openRenameModal(id) {
  const chat = conversations.find(item => item.id === id);
  if (!chat) return;
  renameConversationId = id;
  $('#aiRenameInput').value = chat.title || '新对话';
  openModal($('#aiRenameOverlay'), '#aiRenameInput');
}

function closeRenameModal() {
  renameConversationId = '';
  closeModal($('#aiRenameOverlay'));
}

async function newConversation() {
  const chat = createConversation();
  conversations.unshift(chat);
  activeConversationId = chat.id;
  await saveConversations();
  renderMessages();
  $('#aiChatInput').focus();
}

async function switchConversation(id) {
  if (!conversations.some(chat => chat.id === id)) return;
  activeConversationId = id;
  await saveConversations();
  renderMessages();
  $('#aiChatInput').focus();
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

function scheduleStreamRender() {
  if (scheduleStreamRender.pending) return;
  scheduleStreamRender.pending = true;
  requestAnimationFrame(() => {
    scheduleStreamRender.pending = false;
    renderMessages();
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

async function readStreamingReply(res, assistantMessage) {
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'AI 请求失败');
  }
  const reader = res.body?.getReader ? res.body.getReader() : null;
  if (!reader) throw new Error('浏览器不支持流式读取');

  const decoder = new TextDecoder();
  let buffer = '';
  let done = false;
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
        assistantMessage.content += data.content || '';
        scheduleStreamRender();
      }
      if (event.type === 'error') throw new Error(data.error || 'AI 流式请求失败');
      if (event.type === 'done') {
        if (Array.isArray(data.sources) && data.sources.length) assistantMessage.sources = data.sources;
        return;
      }
    }
  }
}

async function sendJsonMessage(chat, requestSettings) {
  const res = await apiFetch('/api/ai/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: chat.messages, ...requestSettings }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'AI 请求失败');
  if (!data.message?.content) throw new Error('AI 没有返回内容');
  const assistantMessage = { role: 'assistant', content: data.message.content, createdAt: Date.now(), sources: Array.isArray(data.sources) ? data.sources : [] };
  if (['westock', 'logs'].includes(data.toolCall?.skillId)) assistantMessage.toolCall = data.toolCall;
  chat.messages.push(assistantMessage);
}

async function executeSkillTool(index) {
  const chat = activeConversation();
  const message = chat?.messages[index];
  const toolCall = message?.toolCall;
  if (!chat || !toolCall || !['westock', 'perplexity', 'logs'].includes(toolCall.skillId) || sending) return;
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
  renderMessages();
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
    renderMessages();
  } catch (err) {
    toolCall.status = 'error';
    toolCall.error = err.message;
    chat.updatedAt = Date.now();
    await saveConversations();
    renderMessages();
    showToast(`${meta.errorText}：${err.message}`, 'error');
  }
}

async function sendStreamingMessage(chat, requestSettings) {
  const assistantMessage = { role: 'assistant', content: '', createdAt: Date.now(), streaming: true };
  chat.messages.push(assistantMessage);
  renderMessages();
  const res = await apiFetch('/api/ai/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: chat.messages.filter(message => !message.streaming), ...requestSettings }),
  });
  await readStreamingReply(res, assistantMessage);
  delete assistantMessage.streaming;
}

async function sendMessage({ forceImage = false } = {}) {
  if (sending) return;
  const input = $('#aiChatInput');
  const content = input.value.trim();
  const chat = activeConversation();
  if (!content || !chat) return;

  chat.messages.push({ role: 'user', content, createdAt: Date.now() });
  if (chat.title === '新对话') chat.title = conversationTitleFrom(content);
  if (chat.messages.length > MAX_MESSAGES) chat.messages = chat.messages.slice(-MAX_MESSAGES);
  chat.updatedAt = Date.now();
  input.value = '';
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
    renderMessages();
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
    renderMessages();
    input.focus();
    return;
  }
  await saveConversations();
  renderMessages();
  updateSendState();

  sending = true;
  updateSendState();
  renderMessages();
  try {
    const requestSettings = currentSettings();
    if (requestSettings.stream) {
      await sendStreamingMessage(chat, requestSettings);
    } else {
      await sendJsonMessage(chat, requestSettings);
    }
    if (chat.messages.length > MAX_MESSAGES) chat.messages = chat.messages.slice(-MAX_MESSAGES);
    chat.updatedAt = Date.now();
    await saveConversations();
    renderMessages();
  } catch (err) {
    showToast(`AI 对话失败：${err.message}`, 'error');
    const last = chat.messages.at(-1);
    if (last?.streaming) {
      delete last.streaming;
      if (!last.content) last.content = `请求失败：${err.message}`;
    } else {
      chat.messages.push({ role: 'assistant', content: `请求失败：${err.message}`, createdAt: Date.now() });
    }
    chat.updatedAt = Date.now();
    await saveConversations();
    renderMessages();
  } finally {
    sending = false;
    updateSendState();
    renderMessages();
    input.focus();
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
  await Promise.all([loadSettings(), loadConversations(), loadAccessCategories()]);
  await loadSkills();
  initAiSettingsSelectControls();
  updateSettingsButton();
  syncWebSearchToggleUi();
  renderMessages();
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
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'rename') return openRenameModal(item.dataset.id);
    if (action === 'delete') return deleteConversation(item.dataset.id);
    switchConversation(item.dataset.id);
  });
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
  $('#btnAiSkill')?.addEventListener('click', toggleSkillPicker);
  $('#aiChatWebSearchToggle')?.addEventListener('change', async (event) => {
    const previous = Boolean(settings.webSearchEnabled);
    settings.webSearchEnabled = event.target.checked;
    syncWebSearchToggleUi();
    try {
      await saveSettings({ quiet: true });
      showToast(settings.webSearchEnabled ? 'Tavily 联网搜索已开启' : 'Tavily 联网搜索已关闭', 'success');
    } catch (err) {
      settings.webSearchEnabled = previous;
      syncWebSearchToggleUi();
      showToast('Tavily 开关保存失败：' + err.message, 'error');
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
    const preview = event.target.closest('.ai-image-preview[data-action="open-image-preview"]');
    if (!preview) return;
    event.preventDefault();
    openAiImagePreview(preview.dataset.previewUrl || preview.src, preview.alt || 'AI 生成图片');
  });
  $('#aiChatInput').addEventListener('input', updateSendState);
  $('#aiChatInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      sendMessage();
    }
  });
  document.addEventListener('click', (event) => {
    if (event.target.closest('#btnAiSkill') || event.target.closest('#aiSkillPicker')) return;
    closeSkillPicker();
  });
}
