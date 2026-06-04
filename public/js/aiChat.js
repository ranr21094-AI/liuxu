import { apiFetch } from './auth.js';
import { showToast, escHtml, openModal, closeModal, $ } from './helpers.js';

const DEFAULT_MODEL = 'deepseek-v4-flash';
const DEFAULT_REASONING = 'high';
const MAX_MESSAGES = 20;
const API_KEY_STORAGE_KEY = 'deepseekApiKey';
const CHAT_STORAGE_KEY = 'aiChatConversations';
const ACTIVE_CHAT_STORAGE_KEY = 'aiChatActiveConversationId';

let conversations = [];
let activeConversationId = '';
let previousViewId = 'listView';
let sending = false;
let apiKey = localStorage.getItem(API_KEY_STORAGE_KEY) || '';

function createConversation(title = '新对话') {
  return {
    id: `chat-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    title,
    messages: [],
    updatedAt: Date.now(),
  };
}

function loadConversations() {
  try {
    const parsed = JSON.parse(localStorage.getItem(CHAT_STORAGE_KEY) || '[]');
    conversations = Array.isArray(parsed)
      ? parsed.filter(item => item && typeof item.id === 'string' && Array.isArray(item.messages))
      : [];
  } catch {
    conversations = [];
  }
  if (!conversations.length) conversations = [createConversation()];
  activeConversationId = localStorage.getItem(ACTIVE_CHAT_STORAGE_KEY) || conversations[0].id;
  if (!activeConversation()) activeConversationId = conversations[0].id;
}

function saveConversations() {
  localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(conversations));
  localStorage.setItem(ACTIVE_CHAT_STORAGE_KEY, activeConversationId);
}

function activeConversation() {
  return conversations.find(item => item.id === activeConversationId) || null;
}

function activeMessages() {
  return activeConversation()?.messages || [];
}

function visibleMainViewId() {
  for (const id of ['editorView', 'categoryView', 'listView']) {
    const el = document.getElementById(id);
    if (el && el.style.display !== 'none') return id;
  }
  return 'listView';
}

function setMainView(id) {
  for (const viewId of ['listView', 'editorView', 'categoryView', 'aiChatView']) {
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

function renderHistory() {
  const list = $('#aiChatHistoryList');
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

  list.innerHTML = messages.map(message => `
    <div class="ai-message ${message.role}">
      <div class="ai-message-role">${message.role === 'user' ? '你' : 'AI'}</div>
      <div class="ai-message-content">${escHtml(message.content)}</div>
    </div>
  `).join('');
  list.scrollTop = list.scrollHeight;
  renderHistory();
}

function updateSendState() {
  const input = $('#aiChatInput');
  const send = $('#btnAiSend');
  const hasText = input.value.trim().length > 0;
  send.disabled = sending || !hasText;
  $('#aiChatSending').style.display = sending ? '' : 'none';
}

function currentSettings() {
  return {
    apiKey,
    model: $('#aiModelSelect').value || DEFAULT_MODEL,
    thinkingMode: 'enabled',
    reasoningEffort: $('#aiReasoningEffort').value || DEFAULT_REASONING,
  };
}

function updateApiKeyButton() {
  const button = $('#btnAiApiKey');
  button.classList.toggle('has-key', Boolean(apiKey));
  button.textContent = apiKey ? 'API Key 已保存' : 'API Key';
  button.title = apiKey ? '已保存 DeepSeek API Key' : '设置 DeepSeek API Key';
}

function openApiKeyModal() {
  $('#aiApiKeyInput').value = apiKey;
  openModal($('#aiApiKeyOverlay'), '#aiApiKeyInput');
}

function closeApiKeyModal() {
  closeModal($('#aiApiKeyOverlay'));
}

function openHistoryModal() {
  renderHistory();
  openModal($('#aiHistoryOverlay'), '#aiHistoryClose');
}

function closeHistoryModal() {
  closeModal($('#aiHistoryOverlay'));
}

function saveApiKey() {
  apiKey = $('#aiApiKeyInput').value.trim();
  if (apiKey) {
    localStorage.setItem(API_KEY_STORAGE_KEY, apiKey);
    showToast('API Key 已保存', 'success');
  } else {
    localStorage.removeItem(API_KEY_STORAGE_KEY);
    showToast('API Key 已清除', 'info');
  }
  updateApiKeyButton();
  closeApiKeyModal();
}

function clearApiKey() {
  apiKey = '';
  $('#aiApiKeyInput').value = '';
  localStorage.removeItem(API_KEY_STORAGE_KEY);
  updateApiKeyButton();
  showToast('API Key 已清除', 'info');
}

function newConversation() {
  const chat = createConversation();
  conversations.unshift(chat);
  activeConversationId = chat.id;
  saveConversations();
  renderMessages();
  $('#aiChatInput').focus();
}

function switchConversation(id) {
  if (!conversations.some(chat => chat.id === id)) return;
  activeConversationId = id;
  saveConversations();
  renderMessages();
  closeHistoryModal();
  $('#aiChatInput').focus();
}

function renameConversation(id) {
  const chat = conversations.find(item => item.id === id);
  if (!chat) return;
  const next = window.prompt('重命名对话', chat.title || '新对话');
  if (next === null) return;
  const title = next.trim();
  if (!title) return;
  chat.title = title.slice(0, 40);
  chat.updatedAt = Date.now();
  saveConversations();
  renderHistory();
}

function deleteConversation(id) {
  const chat = conversations.find(item => item.id === id);
  if (!chat) return;
  if (!window.confirm(`删除对话「${chat.title || '新对话'}」？`)) return;
  conversations = conversations.filter(item => item.id !== id);
  if (!conversations.length) conversations = [createConversation()];
  if (activeConversationId === id) activeConversationId = conversations[0].id;
  saveConversations();
  renderMessages();
}

async function sendMessage() {
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
  saveConversations();
  renderMessages();
  updateSendState();

  sending = true;
  updateSendState();
  try {
    const settings = currentSettings();
    const res = await apiFetch('/api/ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: chat.messages, ...settings }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'AI 请求失败');
    if (!data.message?.content) throw new Error('AI 没有返回内容');
    chat.messages.push({ role: 'assistant', content: data.message.content });
    if (chat.messages.length > MAX_MESSAGES) chat.messages = chat.messages.slice(-MAX_MESSAGES);
    chat.updatedAt = Date.now();
    saveConversations();
    renderMessages();
  } catch (err) {
    showToast(`AI 对话失败：${err.message}`, 'error');
    chat.messages.push({ role: 'assistant', content: `请求失败：${err.message}` });
    chat.updatedAt = Date.now();
    saveConversations();
    renderMessages();
  } finally {
    sending = false;
    updateSendState();
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

export function initAiChat() {
  loadConversations();
  $('#aiModelSelect').value = DEFAULT_MODEL;
  $('#aiReasoningEffort').value = DEFAULT_REASONING;
  updateApiKeyButton();
  renderMessages();
  updateSendState();

  $('#btnAiBack').addEventListener('click', hideAiChatView);
  $('#btnAiNewChat').addEventListener('click', newConversation);
  $('#btnAiHistory').addEventListener('click', openHistoryModal);
  $('#aiHistoryClose').addEventListener('click', closeHistoryModal);
  $('#aiHistoryOverlay').addEventListener('click', (event) => {
    if (event.target === $('#aiHistoryOverlay')) closeHistoryModal();
  });
  $('#btnAiApiKey').addEventListener('click', openApiKeyModal);
  $('#aiApiKeyClose').addEventListener('click', closeApiKeyModal);
  $('#btnAiApiKeyCancel').addEventListener('click', closeApiKeyModal);
  $('#btnAiApiKeySave').addEventListener('click', saveApiKey);
  $('#btnAiApiKeyClear').addEventListener('click', clearApiKey);
  $('#aiApiKeyOverlay').addEventListener('click', (event) => {
    if (event.target === $('#aiApiKeyOverlay')) closeApiKeyModal();
  });
  $('#aiApiKeyInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') saveApiKey();
  });
  $('#btnAiClear').addEventListener('click', () => {
    const chat = activeConversation();
    if (!chat) return;
    chat.messages = [];
    chat.updatedAt = Date.now();
    saveConversations();
    renderMessages();
    $('#aiChatInput').focus();
  });
  $('#aiChatHistoryList').addEventListener('click', (event) => {
    const item = event.target.closest('.ai-history-item');
    if (!item) return;
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'rename') return renameConversation(item.dataset.id);
    if (action === 'delete') return deleteConversation(item.dataset.id);
    switchConversation(item.dataset.id);
  });
  $('#btnAiSend').addEventListener('click', sendMessage);
  $('#aiChatInput').addEventListener('input', updateSendState);
  $('#aiChatInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      sendMessage();
    }
  });
}
