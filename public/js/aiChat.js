import { apiFetch } from './auth.js';
import { showToast, escHtml, openModal, closeModal, confirmDialog, $ } from './helpers.js';
import { renderToHtml } from './markdown.js';

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

let conversations = [];
let allConversations = [];
let activeConversationId = '';
let previousViewId = 'listView';
let sending = false;
let renameConversationId = '';
let availableSkills = [];
let selectedSkillId = '';
let settings = {
  apiKey: '',
  model: DEFAULT_MODEL,
  reasoningEffort: DEFAULT_REASONING,
  stream: false,
  userProfile: '',
  logContextEnabled: false,
  diaryContextEnabled: false,
  tavilyApiKey: '',
  webSearchEnabled: false,
  webSearchDepth: 'basic',
  seedreamApiKey: '',
  seedreamModel: DEFAULT_SEEDREAM_MODEL,
  seedreamSize: DEFAULT_SEEDREAM_SIZE,
  seedreamWatermark: true,
  skills: {
    westock: { enabled: true },
  },
};

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

function normalizeSettings(value) {
  const skills = value?.skills && typeof value.skills === 'object' ? value.skills : {};
  const westock = skills.westock && typeof skills.westock === 'object' ? skills.westock : {};
  return {
    apiKey: typeof value?.apiKey === 'string' ? value.apiKey : '',
    model: ['deepseek-v4-flash', 'deepseek-v4-pro'].includes(value?.model) ? value.model : DEFAULT_MODEL,
    reasoningEffort: ['high', 'max'].includes(value?.reasoningEffort) ? value.reasoningEffort : DEFAULT_REASONING,
    stream: typeof value?.stream === 'boolean' ? value.stream : false,
    userProfile: typeof value?.userProfile === 'string' ? value.userProfile.slice(0, 2000) : '',
    logContextEnabled: typeof value?.logContextEnabled === 'boolean' ? value.logContextEnabled : false,
    diaryContextEnabled: typeof value?.diaryContextEnabled === 'boolean' ? value.diaryContextEnabled : false,
    tavilyApiKey: typeof value?.tavilyApiKey === 'string' ? value.tavilyApiKey : '',
    webSearchEnabled: typeof value?.webSearchEnabled === 'boolean' ? value.webSearchEnabled : false,
    webSearchDepth: ['basic', 'advanced'].includes(value?.webSearchDepth) ? value.webSearchDepth : 'basic',
    seedreamApiKey: typeof value?.seedreamApiKey === 'string' ? value.seedreamApiKey : '',
    seedreamModel: ['doubao-seedream-5-0-260128', 'doubao-seedream-4-5-251128', 'doubao-seedream-4-0-250828'].includes(value?.seedreamModel) ? value.seedreamModel : DEFAULT_SEEDREAM_MODEL,
    seedreamSize: typeof value?.seedreamSize === 'string' && value.seedreamSize ? value.seedreamSize : DEFAULT_SEEDREAM_SIZE,
    seedreamWatermark: typeof value?.seedreamWatermark === 'boolean' ? value.seedreamWatermark : true,
    skills: {
      westock: { enabled: typeof westock.enabled === 'boolean' ? westock.enabled : true },
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
  const submitted = { ...settings, skills: { ...settings.skills, westock: { ...settings.skills?.westock } } };
  const res = await apiFetch(AI_SETTINGS_ENDPOINT, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(submitted),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'AI 设置保存失败');
  if (
    data.tavilyApiKey !== submitted.tavilyApiKey ||
    data.userProfile !== submitted.userProfile ||
    data.logContextEnabled !== submitted.logContextEnabled ||
    data.diaryContextEnabled !== submitted.diaryContextEnabled ||
    data.webSearchEnabled !== submitted.webSearchEnabled ||
    data.webSearchDepth !== submitted.webSearchDepth ||
    data.seedreamApiKey !== submitted.seedreamApiKey ||
    data.seedreamModel !== submitted.seedreamModel ||
    data.seedreamSize !== submitted.seedreamSize ||
    data.seedreamWatermark !== submitted.seedreamWatermark ||
    data.skills?.westock?.enabled !== submitted.skills?.westock?.enabled
  ) {
    throw new Error('服务端未保存 AI 设置，请重启应用后再试');
  }
  settings = normalizeSettings(data);
  await loadSkills();
  updateSettingsButton();
  if (!quiet) showToast('AI 设置已保存', 'success');
}

function activeConversation() {
  return conversations.find(item => item.id === activeConversationId) || null;
}

function activeMessages() {
  return activeConversation()?.messages || [];
}

function visibleMainViewId() {
  for (const id of ['editorView', 'categoryView', 'todoView', 'listView']) {
    const el = document.getElementById(id);
    if (el && el.style.display !== 'none') return id;
  }
  return 'listView';
}

function setMainView(id) {
  for (const viewId of ['listView', 'editorView', 'categoryView', 'todoView', 'aiChatView']) {
    const el = document.getElementById(viewId);
    if (!el) continue;
    el.style.display = viewId === id ? 'flex' : 'none';
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

function renderHistory() {
  const list = $('#aiSidebarHistoryList');
  if (!list) return;
  const sorted = [...conversations].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  list.innerHTML = sorted.map(chat => `
    <div class="ai-history-item${chat.id === activeConversationId ? ' active' : ''}" data-id="${escHtml(chat.id)}">
      <button type="button" class="ai-history-open" title="${escHtml(chat.title || '新对话')}">
        <span class="ai-history-title">${escHtml(chat.title || '新对话')}</span>
        <span class="ai-history-meta">${chat.messages.length} 条 · ${escHtml(formatChatTime(chat.updatedAt))}</span>
      </button>
      <button type="button" class="ai-history-action" data-action="rename" title="重命名对话" aria-label="重命名对话">✎</button>
      <button type="button" class="ai-history-action danger" data-action="delete" title="删除对话" aria-label="删除对话">×</button>
    </div>
  `).join('');
}

function renderMessages() {
  const list = $('#aiChatMessages');
  const messages = activeMessages();
  if (!messages.length) {
    list.innerHTML = `
      <div class="ai-chat-empty">
        <strong>AI 对话助手</strong>
        <span>输入你想讨论的问题。当前版本不会读取日志、待办或分类内容。</span>
      </div>
    `;
    renderHistory();
    return;
  }

  list.innerHTML = messages.map((message, index) => `
    <div class="ai-message ${message.role}" data-message-index="${index}">
      <div class="ai-message-role">${message.role === 'user' ? '你' : 'AI'}</div>
      <div class="ai-message-bubble">
        <button type="button" class="ai-message-copy" data-action="copy-message" aria-label="复制${message.role === 'user' ? '问题' : '回答'}" title="复制${message.role === 'user' ? '问题' : '回答'}">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" stroke-width="2"/>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          </svg>
        </button>
        <div class="ai-message-content${message.role === 'assistant' ? ' markdown-body' : ''}">${message.role === 'assistant' ? renderToHtml(message.content) : escHtml(message.content)}</div>
        ${message.role === 'assistant' && message.imageGeneration ? renderImageGenerationCard(message.imageGeneration, index, { insertable: false }) : ''}
        ${message.role === 'assistant' && message.toolCall ? renderToolCallCard(message.toolCall, message.toolResult, index) : ''}
      </div>
      ${message.role === 'assistant' && Array.isArray(message.sources) && message.sources.length ? `
        <div class="ai-message-sources" aria-label="联网搜索来源">
          <span>来源</span>
          ${message.sources.map((source, index) => `<a href="${escHtml(source.url)}" target="_blank" rel="noopener noreferrer">${index + 1}. ${escHtml(source.title || source.url)}</a>`).join('')}
        </div>
      ` : ''}
    </div>
  `).join('') + (sending && !messages.at(-1)?.streaming ? `
    <div class="ai-message assistant ai-message-thinking" aria-live="polite">
      <div class="ai-message-role">AI</div>
      <div class="ai-message-content">
        <span class="ai-thinking-text">正在思考</span>
        <span class="ai-thinking-dots" aria-hidden="true"><i></i><i></i><i></i></span>
      </div>
    </div>
  ` : '');
  list.scrollTop = list.scrollHeight;
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
        <img class="ai-image-preview" src="${escHtml(imageGeneration.url)}" alt="AI 生成图片">
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

function renderSelectedSkillChip() {
  const row = $('#aiSkillChipRow');
  if (!row) return;
  const skill = selectedSkill();
  row.innerHTML = skill ? `
    <span class="ai-skill-chip" data-skill-id="${escHtml(skill.id)}">
      <span class="ai-skill-chip-icon">W</span>
      <span>${escHtml(skill.label || skill.name || 'WeStock')}</span>
      <button type="button" id="btnAiSkillClear" aria-label="移除技能">&times;</button>
    </span>
  ` : '';
  $('#btnAiSkillClear')?.addEventListener('click', () => {
    selectedSkillId = '';
    renderSelectedSkillChip();
    renderSkillPicker();
  });
}

function renderSkillPicker() {
  const picker = $('#aiSkillPicker');
  if (!picker) return;
  const skills = enabledSkills();
  picker.innerHTML = skills.length ? `
    <div class="ai-skill-picker-title">选择技能</div>
    <div class="ai-skill-picker-list" role="listbox">
      ${skills.map(skill => `
        <button type="button" class="ai-skill-option${skill.id === selectedSkillId ? ' active' : ''}" data-skill-id="${escHtml(skill.id)}" role="option" aria-selected="${skill.id === selectedSkillId ? 'true' : 'false'}">
          <span class="ai-skill-option-icon">W</span>
          <span>
            <strong>${escHtml(skill.name || 'WeStock Data')}</strong>
            <small>${escHtml(skill.description || '股票市场数据查询')}</small>
          </span>
        </button>
      `).join('')}
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

function renderToolCallCard(toolCall, toolResult, index) {
  if (!toolCall || toolCall.skillId !== 'westock') return '';
  const status = toolCall.status || 'pending';
  const argsJson = JSON.stringify(toolCall.args || {}, null, 2);
  return `
    <div class="ai-tool-card ${escHtml(status)}" data-tool-message-index="${index}">
      <div class="ai-tool-card-head">
        <strong>WeStock Data</strong>
        <span>${escHtml(toolCall.tool)}</span>
      </div>
      <pre class="ai-tool-args"><code>${escHtml(argsJson)}</code></pre>
      ${status === 'running' ? `
        <div class="ai-tool-running">
          <span>正在查询市场数据</span>
          <span class="ai-thinking-dots" aria-hidden="true"><i></i><i></i><i></i></span>
        </div>
      ` : ''}
      ${status === 'error' ? `<div class="ai-tool-error">${escHtml(toolCall.error || 'WeStock 查询失败')}</div>` : ''}
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
  send.disabled = sending || !hasText;
  if (image) image.disabled = sending || !hasText;
  $('#aiChatSending').style.display = sending ? '' : 'none';
}

function currentSettings() {
  const skill = selectedSkill();
  const request = {
    apiKey: settings.apiKey,
    model: settings.model || DEFAULT_MODEL,
    thinkingMode: 'enabled',
    reasoningEffort: settings.reasoningEffort || DEFAULT_REASONING,
    stream: skill ? false : Boolean(settings.stream),
    userProfile: settings.userProfile || '',
    logContextEnabled: Boolean(settings.logContextEnabled),
    diaryContextEnabled: Boolean(settings.diaryContextEnabled),
    tavilyApiKey: settings.tavilyApiKey,
    webSearchEnabled: Boolean(settings.webSearchEnabled),
    webSearchDepth: settings.webSearchDepth || 'basic',
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

function fillSettingsModal() {
  $('#aiApiKeyInput').value = settings.apiKey;
  $('#aiModelSelect').value = settings.model || DEFAULT_MODEL;
  $('#aiReasoningEffort').value = settings.reasoningEffort || DEFAULT_REASONING;
  $('#aiStreamToggle').checked = Boolean(settings.stream);
  $('#aiUserProfileInput').value = settings.userProfile || '';
  $('#aiLogContextToggle').checked = Boolean(settings.logContextEnabled);
  $('#aiDiaryContextToggle').checked = Boolean(settings.diaryContextEnabled);
  $('#aiTavilyApiKeyInput').value = settings.tavilyApiKey;
  $('#aiWebSearchToggle').checked = Boolean(settings.webSearchEnabled);
  $('#aiWebSearchDepth').value = settings.webSearchDepth || 'basic';
  $('#aiSeedreamApiKeyInput').value = settings.seedreamApiKey;
  $('#aiSeedreamModel').value = settings.seedreamModel || DEFAULT_SEEDREAM_MODEL;
  $('#aiSeedreamSize').value = settings.seedreamSize || DEFAULT_SEEDREAM_SIZE;
  $('#aiSeedreamWatermark').checked = settings.seedreamWatermark !== false;
  $('#aiSkillWestockToggle').checked = settings.skills?.westock?.enabled !== false;
}

function setSettingsTab(tab) {
  const activeTab = ['image', 'skills'].includes(tab) ? tab : 'chat';
  document.querySelectorAll('[data-ai-settings-tab]').forEach(button => {
    const selected = button.dataset.aiSettingsTab === activeTab;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-selected', String(selected));
  });
  $('#aiSettingsPanelChat').hidden = activeTab !== 'chat';
  $('#aiSettingsPanelChat').classList.toggle('active', activeTab === 'chat');
  $('#aiSettingsPanelImage').hidden = activeTab !== 'image';
  $('#aiSettingsPanelImage').classList.toggle('active', activeTab === 'image');
  $('#aiSettingsPanelSkills').hidden = activeTab !== 'skills';
  $('#aiSettingsPanelSkills').classList.toggle('active', activeTab === 'skills');
}

function openSettingsModal() {
  fillSettingsModal();
  setSettingsTab('chat');
  openModal($('#aiApiKeyOverlay'), '#aiApiKeyInput');
}

function closeSettingsModal() {
  closeModal($('#aiApiKeyOverlay'));
}

async function saveSettingsFromModal() {
  settings = normalizeSettings({
    apiKey: $('#aiApiKeyInput').value.trim(),
    model: $('#aiModelSelect').value,
    reasoningEffort: $('#aiReasoningEffort').value,
    stream: $('#aiStreamToggle').checked,
    userProfile: $('#aiUserProfileInput').value.trim(),
    logContextEnabled: $('#aiLogContextToggle').checked,
    diaryContextEnabled: $('#aiDiaryContextToggle').checked,
    tavilyApiKey: $('#aiTavilyApiKeyInput').value.trim(),
    webSearchEnabled: $('#aiWebSearchToggle').checked,
    webSearchDepth: $('#aiWebSearchDepth').value,
    seedreamApiKey: $('#aiSeedreamApiKeyInput').value.trim(),
    seedreamModel: $('#aiSeedreamModel').value,
    seedreamSize: $('#aiSeedreamSize').value,
    seedreamWatermark: $('#aiSeedreamWatermark').checked,
    skills: {
      westock: { enabled: $('#aiSkillWestockToggle').checked },
    },
  });
  try {
    await saveSettings();
    closeSettingsModal();
  } catch (err) {
    showToast('AI 设置保存失败：' + err.message, 'error');
  }
}

async function clearApiKey() {
  settings.apiKey = '';
  settings.tavilyApiKey = '';
  settings.seedreamApiKey = '';
  $('#aiApiKeyInput').value = '';
  $('#aiTavilyApiKeyInput').value = '';
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
  const assistantMessage = { role: 'assistant', content: data.message.content, sources: Array.isArray(data.sources) ? data.sources : [] };
  if (data.toolCall?.skillId === 'westock') assistantMessage.toolCall = data.toolCall;
  chat.messages.push(assistantMessage);
}

async function executeSkillTool(index) {
  const chat = activeConversation();
  const message = chat?.messages[index];
  const toolCall = message?.toolCall;
  if (!chat || !toolCall || toolCall.skillId !== 'westock' || sending) return;
  toolCall.status = 'running';
  toolCall.error = '';
  chat.updatedAt = Date.now();
  await saveConversations();
  renderMessages();
  try {
    const res = await apiFetch('/api/ai/skills/westock/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tool: toolCall.tool,
        args: toolCall.args || {},
        confirmed: true,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'WeStock 查询失败');
    toolCall.status = 'done';
    message.toolResult = {
      skillId: 'westock',
      tool: toolCall.tool,
      content: data.content || 'WeStock 没有返回内容',
    };
    chat.updatedAt = Date.now();
    await saveConversations();
    renderMessages();
  } catch (err) {
    toolCall.status = 'error';
    toolCall.error = err.message;
    chat.updatedAt = Date.now();
    await saveConversations();
    renderMessages();
    showToast('WeStock 查询失败：' + err.message, 'error');
  }
}

async function sendStreamingMessage(chat, requestSettings) {
  const assistantMessage = { role: 'assistant', content: '', streaming: true };
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

  chat.messages.push({ role: 'user', content });
  if (chat.title === '新对话') chat.title = conversationTitleFrom(content);
  if (chat.messages.length > MAX_MESSAGES) chat.messages = chat.messages.slice(-MAX_MESSAGES);
  chat.updatedAt = Date.now();
  input.value = '';
  if (forceImage) {
    const prompt = imagePromptFrom(content);
    const assistantMessage = {
      role: 'assistant',
      content: '正在优化生图 prompt，请稍等...',
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
      chat.messages.push({ role: 'assistant', content: `请求失败：${err.message}` });
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
  await Promise.all([loadSettings(), loadConversations()]);
  await loadSkills();
  updateSettingsButton();
  renderMessages();
  updateSendState();

  $('#btnAiSidebarNewChat').addEventListener('click', newConversation);
  $('#btnAiApiKey').addEventListener('click', openSettingsModal);
  $('#aiApiKeyClose').addEventListener('click', closeSettingsModal);
  $('#btnAiApiKeyCancel').addEventListener('click', closeSettingsModal);
  $('#btnAiApiKeySave').addEventListener('click', saveSettingsFromModal);
  $('#btnAiApiKeyClear').addEventListener('click', clearApiKey);
  $('#aiRenameClose').addEventListener('click', closeRenameModal);
  $('#btnAiRenameCancel').addEventListener('click', closeRenameModal);
  $('#btnAiRenameSave').addEventListener('click', saveRenameConversation);
  $('#aiRenameOverlay').addEventListener('click', (event) => {
    if (event.target === $('#aiRenameOverlay')) closeRenameModal();
  });
  $('#aiRenameInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') saveRenameConversation();
  });
  $('#aiApiKeyOverlay').addEventListener('click', (event) => {
    if (event.target === $('#aiApiKeyOverlay')) closeSettingsModal();
  });
  document.querySelectorAll('[data-ai-settings-tab]').forEach(button => {
    button.addEventListener('click', () => setSettingsTab(button.dataset.aiSettingsTab));
  });
  $('#aiApiKeyInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) saveSettingsFromModal();
  });
  $('#aiSidebarHistoryList').addEventListener('click', (event) => {
    const item = event.target.closest('.ai-history-item');
    if (!item) return;
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'rename') return openRenameModal(item.dataset.id);
    if (action === 'delete') return deleteConversation(item.dataset.id);
    switchConversation(item.dataset.id);
  });
  $('#btnAiSend').addEventListener('click', sendMessage);
  $('#btnAiImage')?.addEventListener('click', () => sendMessage({ forceImage: true }));
  $('#btnAiSkill')?.addEventListener('click', toggleSkillPicker);
  $('#aiSkillPicker')?.addEventListener('click', (event) => {
    const option = event.target.closest('[data-skill-id]');
    if (option) chooseSkill(option.dataset.skillId);
  });
  $('#aiChatMessages').addEventListener('click', (event) => {
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
