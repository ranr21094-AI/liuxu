const fs = require('fs');
const path = require('path');
const { businessDateString, daysInMonth, parseDateParts, startOfWeekMonday } = require('./business-date');

function createDatabase(dataDirectory = (process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data'))) {
const DATA_DIR = path.resolve(dataDirectory);
const DATA_FILE = path.join(DATA_DIR, 'logs.json');
const DIARY_CATEGORY = '\u65e5\u8bb0';
const OTHER_CATEGORY = '\u5176\u4ed6';
const PRIVATE_UPLOADS_FILE = path.join(DATA_DIR, 'private-uploads.json');
const AI_CHATS_FILE = path.join(DATA_DIR, 'ai-chats.json');
const AI_SETTINGS_FILE = path.join(DATA_DIR, 'ai-settings.json');
const TODO_REMINDER_SETTINGS_FILE = path.join(DATA_DIR, 'todo-reminder-settings.json');
const TODO_REMINDER_STATE_FILE = path.join(DATA_DIR, 'todo-reminder-state.json');
const PHOTO_WALL_FILE = path.join(DATA_DIR, 'photo-wall.json');
const COUNTDOWNS_FILE = path.join(DATA_DIR, 'countdowns.json');
const DEFAULT_AI_SETTINGS = {
  apiKey: '',
  model: 'deepseek-v4-flash',
  reasoningEffort: 'high',
  stream: false,
  userProfile: '',
  logContextEnabled: false,
  diaryContextEnabled: false,
  tavilyApiKey: '',
  perplexityApiKey: '',
  webSearchEnabled: false,
  webSearchDepth: 'basic',
  seedreamApiKey: '',
  seedreamModel: 'doubao-seedream-5-0-260128',
  seedreamSize: '2K',
  seedreamWatermark: true,
  logAccessPolicy: null,
  skills: {
    westock: { enabled: true },
    perplexity: { enabled: true },
  },
};

// In-memory cache
const cache = {
  logs: null,
  todos: null,
  countdowns: null,
  todoCategories: null,
  categories: null,
  privateUploads: null,
  aiChats: null,
  aiSettings: null,
  todoReminderSettings: null,
  todoReminderState: null,
  photoWall: null,
  maxLogId: 0,
  maxTodoId: 0,
  maxCountdownId: 0,
  maxPhotoWallId: 0,
};

function resetCache() {
  cache.logs = null;
  cache.todos = null;
  cache.countdowns = null;
  cache.todoCategories = null;
  cache.categories = null;
  cache.privateUploads = null;
  cache.aiChats = null;
  cache.aiSettings = null;
  cache.todoReminderSettings = null;
  cache.todoReminderState = null;
  cache.photoWall = null;
  cache.maxLogId = 0;
  cache.maxTodoId = 0;
  cache.maxCountdownId = 0;
  cache.maxPhotoWallId = 0;
}

function maxPositiveId(items) {
  return items.reduce((max, item) => {
    const id = Number(item?.id);
    return Number.isSafeInteger(id) && id > max ? id : max;
  }, 0);
}

function atomicWriteJson(file, value) {
  ensureDataDir();
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(value, null, 2), 'utf-8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, file);
  } catch (err) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
}

function failCorruptData(label, file, err) {
  let backup = '';
  try {
    if (fs.existsSync(file)) {
      backup = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}.bak`;
      fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
    }
  } catch (backupError) {
    console.error(`Failed to preserve corrupt ${label}:`, backupError.message);
  }
  const suffix = backup ? `; preserved at ${backup}` : '';
  const wrapped = new Error(`Failed to read ${label}: ${err.message}${suffix}`);
  wrapped.cause = err;
  throw wrapped;
}

function cloneLogs(logs) {
  return logs.map(log => {
    const pinned = log.pinned === true;
    return {
      ...log,
      pinned,
      pinned_at: pinned && typeof log.pinned_at === 'string' && log.pinned_at ? log.pinned_at : null,
    };
  });
}

function cloneTodos(todos) {
  return todos.map(todo => ({ ...todo }));
}

function cloneCountdowns(countdowns) {
  return countdowns.map(countdown => ({ ...countdown }));
}

function cloneCategories(categories) {
  return categories.map(category => ({ ...category, sub: [...(category.sub || [])] }));
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

const DEFAULT_TODO_REMINDER_SETTINGS = {
  enabled: false,
  recipientEmail: '',
  sendTime: '08:00',
};

const DEFAULT_TODO_REMINDER_STATE = {
  businessDate: '',
  capturedAt: '',
  status: 'idle',
  snapshot: [],
  sentAt: '',
  lastError: '',
};

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, '[]', 'utf-8');
  }
}

function isDiaryCategory(category) {
  return typeof category === 'string' && (category === DIARY_CATEGORY || category.startsWith(DIARY_CATEGORY + '/'));
}

function isSafeUploadFilename(filename) {
  return typeof filename === 'string' &&
    filename.length > 0 &&
    !filename.includes('..') &&
    !filename.includes('/') &&
    !filename.includes('\\');
}

function normalizeUploadFilename(filename) {
  if (!isSafeUploadFilename(filename)) return null;
  try {
    const decoded = decodeURIComponent(filename);
    return isSafeUploadFilename(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

function extractLocalUploadFilenames(content) {
  if (typeof content !== 'string' || !content) return [];
  const names = new Set();
  const pattern = /\/uploads\/([A-Za-z0-9._-]+)/gi;
  let match;
  while ((match = pattern.exec(content)) !== null) {
    const filename = normalizeUploadFilename(match[1]);
    if (filename) names.add(filename);
  }
  return [...names];
}

function isValidDate(str) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str || '');
  if (!match) return false;
  const [, y, m, d] = match;
  const date = new Date(Number(y), Number(m) - 1, Number(d));
  return date.getFullYear() === Number(y) &&
    date.getMonth() === Number(m) - 1 &&
    date.getDate() === Number(d);
}

function nowTimestamp() {
  return new Date().toISOString().replace('T', ' ').substring(0, 19);
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function toPositiveInteger(value) {
  const num = Number(value);
  return Number.isInteger(num) && num > 0 ? num : null;
}

function normalizeFiniteNumber(value, fallback, { min = -Infinity, max = Infinity } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  const num = Number(value);
  if (!Number.isFinite(num) || num < min || num > max) return null;
  return num;
}

function normalizeString(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function isValidEmail(value) {
  return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function isValidTime24h(value) {
  if (typeof value !== 'string') return false;
  const match = /^(\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) return false;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59;
}

function normalizeTodoReminderSnapshotItem(item) {
  if (!isPlainObject(item)) return null;
  const id = toPositiveInteger(item.id);
  if (!id) return null;
  return {
    id,
    title: normalizeString(item.title, '').trim().slice(0, 200),
    category: normalizeTodoCategoryName(item.category),
    priority: normalizeTodoPriority(item.priority),
    recurrence: normalizeTodoRecurrence(item.recurrence),
    due_date: isValidDate(item.due_date) ? item.due_date : '',
    notes: normalizeString(item.notes, '').slice(0, 1000),
    sort_order: Number.isFinite(Number(item.sort_order)) ? Number(item.sort_order) : 0,
  };
}

function normalizeTodoReminderSettings(data, { mailReady = true } = {}) {
  const source = isPlainObject(data) ? data : {};
  const enabled = typeof source.enabled === 'boolean' ? source.enabled : DEFAULT_TODO_REMINDER_SETTINGS.enabled;
  const recipientEmail = normalizeString(source.recipientEmail, '').trim().slice(0, 320);
  const sendTime = normalizeString(source.sendTime, DEFAULT_TODO_REMINDER_SETTINGS.sendTime).trim();
  if (recipientEmail && !isValidEmail(recipientEmail)) {
    return { error: 'Invalid reminder recipientEmail' };
  }
  if (!isValidTime24h(sendTime)) {
    return { error: 'Invalid reminder sendTime' };
  }
  if (enabled && !recipientEmail) {
    return { error: 'Reminder recipientEmail is required when reminders are enabled' };
  }
  if (enabled && !mailReady) {
    return { error: 'QQ mail credentials are required when reminders are enabled' };
  }
  return {
    enabled,
    recipientEmail,
    sendTime,
  };
}

function normalizeTodoReminderState(data) {
  const source = isPlainObject(data) ? data : {};
  const businessDate = isValidDate(source.businessDate) ? source.businessDate : '';
  const capturedAt = normalizeString(source.capturedAt, '').trim().slice(0, 40);
  const sentAt = normalizeString(source.sentAt, '').trim().slice(0, 40);
  const lastError = normalizeString(source.lastError, '').trim().slice(0, 500);
  const status = ['idle', 'pending', 'empty', 'sent'].includes(source.status)
    ? source.status
    : DEFAULT_TODO_REMINDER_STATE.status;
  const snapshot = Array.isArray(source.snapshot)
    ? source.snapshot.map(normalizeTodoReminderSnapshotItem).filter(Boolean)
    : [];
  return {
    businessDate,
    capturedAt,
    status,
    snapshot,
    sentAt,
    lastError,
  };
}

function readLogs() {
  if (cache.logs !== null) return cloneLogs(cache.logs);
  ensureDataDir();
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('logs.json must contain an array');
    cache.logs = parsed;
    cache.maxLogId = maxPositiveId(cache.logs);
    return cloneLogs(cache.logs);
  } catch (err) {
    return failCorruptData('logs.json', DATA_FILE, err);
  }
}

function writeLogs(logs) {
  const next = logs.map(log => ({ ...log }));
  atomicWriteJson(DATA_FILE, next);
  cache.logs = next;
  cache.maxLogId = maxPositiveId(next);
}

function readPrivateUploads() {
  if (cache.privateUploads !== null) return [...cache.privateUploads];
  ensureDataDir();
  if (!fs.existsSync(PRIVATE_UPLOADS_FILE)) {
    cache.privateUploads = [];
    return [];
  }
  try {
    const saved = JSON.parse(fs.readFileSync(PRIVATE_UPLOADS_FILE, 'utf-8'));
    if (!Array.isArray(saved)) throw new Error('private-uploads.json must contain an array');
    cache.privateUploads = [...new Set(saved.filter(isSafeUploadFilename))];
    return [...cache.privateUploads];
  } catch (err) {
    return failCorruptData('private-uploads.json', PRIVATE_UPLOADS_FILE, err);
  }
}

function writePrivateUploads(filenames) {
  const next = [...new Set(filenames.filter(isSafeUploadFilename))];
  atomicWriteJson(PRIVATE_UPLOADS_FILE, next);
  cache.privateUploads = next;
}

function emptyPhotoWall() {
  return { items: [] };
}

function normalizePhotoWallFilenameFromUrl(url) {
  if (typeof url !== 'string') return null;
  const match = /^\/uploads\/([^/?#]+)$/.exec(url.trim());
  if (!match) return null;
  return normalizeUploadFilename(match[1]);
}

function normalizePhotoWallNumber(value, fallback, { min, max } = {}) {
  const normalized = normalizeFiniteNumber(value, fallback, { min, max });
  return normalized === null ? null : Math.round(normalized * 100) / 100;
}

function normalizePhotoWallItem(item, { requireId = true, fallbackId = 0, now = nowTimestamp() } = {}) {
  if (!isPlainObject(item)) return { error: 'Invalid photo wall item' };

  const id = requireId ? toPositiveInteger(item.id) : (fallbackId || toPositiveInteger(item.id));
  if (!id) return { error: 'Photo wall item id must be a positive integer' };

  const filename = normalizeString(item.filename, '').trim() || normalizePhotoWallFilenameFromUrl(item.url);
  if (!isSafeUploadFilename(filename)) return { error: `Invalid photo wall filename for item ${id}` };

  const url = normalizeString(item.url, '').trim() || `/uploads/${filename}`;
  if (normalizePhotoWallFilenameFromUrl(url) !== filename) {
    return { error: `Invalid photo wall image URL for item ${id}` };
  }

  const x = normalizePhotoWallNumber(item.x, 0, { min: -1000000, max: 1000000 });
  const y = normalizePhotoWallNumber(item.y, 0, { min: -1000000, max: 1000000 });
  const width = normalizePhotoWallNumber(item.width, 320, { min: 40, max: 5000 });
  const height = normalizePhotoWallNumber(item.height, 240, { min: 40, max: 5000 });
  const z = normalizeFiniteNumber(item.z, 0, { min: 0, max: 1000000 });
  if ([x, y, width, height, z].some(value => value === null)) {
    return { error: `Invalid photo wall geometry for item ${id}` };
  }

  return {
    item: {
      id,
      url,
      filename,
      x,
      y,
      width,
      height,
      comment: normalizeString(item.comment, '').slice(0, 1000),
      z: Math.round(z),
      created_at: normalizeString(item.created_at, now),
      updated_at: normalizeString(item.updated_at, normalizeString(item.created_at, now)),
    },
  };
}

function normalizePhotoWallData(value, { requireIds = true } = {}) {
  if (value === undefined) return emptyPhotoWall();
  const sourceItems = Array.isArray(value) ? value : value?.items;
  if (!Array.isArray(sourceItems)) return { error: 'Invalid photoWall data' };
  const ids = new Set();
  const now = nowTimestamp();
  const items = [];
  let fallbackId = 0;
  for (const raw of sourceItems) {
    fallbackId += 1;
    const normalized = normalizePhotoWallItem(raw, { requireId: requireIds, fallbackId, now });
    if (normalized.error) return normalized;
    if (ids.has(normalized.item.id)) return { error: `Duplicate photo wall item id: ${normalized.item.id}` };
    ids.add(normalized.item.id);
    items.push(normalized.item);
  }
  return { items: items.sort((a, b) => a.z - b.z || a.id - b.id) };
}

function readPhotoWall() {
  if (cache.photoWall !== null) return { items: cache.photoWall.items.map(item => ({ ...item })) };
  ensureDataDir();
  if (!fs.existsSync(PHOTO_WALL_FILE)) {
    cache.photoWall = emptyPhotoWall();
    cache.maxPhotoWallId = 0;
    return emptyPhotoWall();
  }
  try {
    const saved = JSON.parse(fs.readFileSync(PHOTO_WALL_FILE, 'utf-8'));
    const normalized = normalizePhotoWallData(saved);
    if (normalized.error) throw new Error(normalized.error);
    cache.photoWall = normalized;
    cache.maxPhotoWallId = maxPositiveId(normalized.items);
    return { items: normalized.items.map(item => ({ ...item })) };
  } catch (err) {
    return failCorruptData('photo-wall.json', PHOTO_WALL_FILE, err);
  }
}

function writePhotoWall(photoWall) {
  const normalized = normalizePhotoWallData(photoWall);
  if (normalized.error) return normalized;
  atomicWriteJson(PHOTO_WALL_FILE, normalized);
  cache.photoWall = { items: normalized.items.map(item => ({ ...item })) };
  cache.maxPhotoWallId = maxPositiveId(normalized.items);
  return normalized;
}

function getPhotoWall() {
  const photoWall = readPhotoWall();
  return { items: photoWall.items.map(item => ({ ...item })) };
}

function createPhotoWallItem(data) {
  readPhotoWall();
  const now = nowTimestamp();
  const nextId = cache.maxPhotoWallId + 1;
  const normalized = normalizePhotoWallItem(
    { ...data, id: nextId, z: data?.z ?? readPhotoWall().items.length, created_at: now, updated_at: now },
    { requireId: true, now }
  );
  if (normalized.error) return { error: normalized.error };
  const photoWall = readPhotoWall();
  photoWall.items.push(normalized.item);
  writePhotoWall(photoWall);
  return normalized.item;
}

function updatePhotoWallItem(id, patch) {
  const itemId = toPositiveInteger(id);
  if (!itemId) return null;
  const photoWall = readPhotoWall();
  const index = photoWall.items.findIndex(item => item.id === itemId);
  if (index === -1) return null;
  const normalized = normalizePhotoWallItem(
    { ...photoWall.items[index], ...patch, id: itemId, updated_at: nowTimestamp() },
    { requireId: true }
  );
  if (normalized.error) return { error: normalized.error };
  photoWall.items[index] = normalized.item;
  writePhotoWall(photoWall);
  return normalized.item;
}

function deletePhotoWallItem(id) {
  const itemId = toPositiveInteger(id);
  if (!itemId) return false;
  const photoWall = readPhotoWall();
  const next = photoWall.items.filter(item => item.id !== itemId);
  if (next.length === photoWall.items.length) return false;
  writePhotoWall({ items: next });
  return true;
}

function reorderPhotoWallItems(orderedIds) {
  if (!Array.isArray(orderedIds)) return { error: 'orderedIds array required' };
  const photoWall = readPhotoWall();
  const order = new Map();
  orderedIds.forEach((id, index) => {
    const itemId = toPositiveInteger(id);
    if (itemId && !order.has(itemId)) order.set(itemId, index);
  });
  const sorted = [...photoWall.items].sort((a, b) => {
    const ai = order.has(a.id) ? order.get(a.id) : Number.MAX_SAFE_INTEGER;
    const bi = order.has(b.id) ? order.get(b.id) : Number.MAX_SAFE_INTEGER;
    if (ai !== bi) return ai - bi;
    return a.z - b.z || a.id - b.id;
  }).map((item, index) => ({ ...item, z: index, updated_at: nowTimestamp() }));
  writePhotoWall({ items: sorted });
  return { items: sorted };
}

function normalizeAiChatMessage(message) {
  const role = message && message.role;
  const content = typeof message?.content === 'string' ? message.content.slice(0, 4000) : '';
  if (!['user', 'assistant'].includes(role) || !content.trim()) return null;
  const sources = Array.isArray(message.sources)
    ? message.sources.slice(0, 5).map(source => ({
      title: normalizeString(source?.title, '').trim().slice(0, 120),
      url: normalizeString(source?.url, '').trim().slice(0, 800),
    })).filter(source => source.url)
    : [];
  const editorSuggestion = isPlainObject(message.editorSuggestion)
    ? {
      reply: normalizeString(message.editorSuggestion.reply, '').trim().slice(0, 4000),
      suggestedTitle: normalizeString(message.editorSuggestion.suggestedTitle, '').trim().slice(0, 200),
      suggestedContent: normalizeString(message.editorSuggestion.suggestedContent, '').slice(0, 20000),
      insertText: normalizeString(message.editorSuggestion.insertText, '').slice(0, 8000),
    }
    : null;
  const normalized = sources.length ? { role, content, sources } : { role, content };
  if (editorSuggestion) {
    Object.keys(editorSuggestion).forEach(key => {
      if (!editorSuggestion[key]) delete editorSuggestion[key];
    });
    if (Object.keys(editorSuggestion).length) normalized.editorSuggestion = editorSuggestion;
  }
  if (isPlainObject(message.imageGeneration)) {
    const imageGeneration = {
      status: ['optimizing', 'pending', 'generating', 'done', 'error', 'cancelled'].includes(message.imageGeneration.status) ? message.imageGeneration.status : 'pending',
      originalPrompt: normalizeString(message.imageGeneration.originalPrompt, '').trim().slice(0, 1200),
      optimizedPrompt: normalizeString(message.imageGeneration.optimizedPrompt, '').trim().slice(0, 1200),
      selectedPrompt: normalizeString(message.imageGeneration.selectedPrompt, '').trim().slice(0, 1200),
      promptMode: ['original', 'optimized'].includes(message.imageGeneration.promptMode) ? message.imageGeneration.promptMode : '',
      prompt: normalizeString(message.imageGeneration.prompt, '').trim().slice(0, 800),
      url: normalizeString(message.imageGeneration.url, '').trim().slice(0, 800),
      filename: normalizeString(message.imageGeneration.filename, '').trim().slice(0, 160),
      markdown: normalizeString(message.imageGeneration.markdown, '').trim().slice(0, 1000),
      error: normalizeString(message.imageGeneration.error, '').trim().slice(0, 240),
      model: normalizeString(message.imageGeneration.model, '').trim().slice(0, 80),
      size: normalizeString(message.imageGeneration.size, '').trim().slice(0, 40),
    };
    Object.keys(imageGeneration).forEach(key => {
      if (!imageGeneration[key]) delete imageGeneration[key];
    });
    normalized.imageGeneration = imageGeneration;
  }
  if (isPlainObject(message.toolCall)) {
    const toolCall = {
      skillId: normalizeString(message.toolCall.skillId, '').trim().slice(0, 40),
      tool: normalizeString(message.toolCall.tool, '').trim().slice(0, 40),
      args: isPlainObject(message.toolCall.args) ? message.toolCall.args : {},
      requiresConfirmation: message.toolCall.requiresConfirmation !== false,
      status: ['pending', 'running', 'done', 'error'].includes(message.toolCall.status) ? message.toolCall.status : 'pending',
      error: normalizeString(message.toolCall.error, '').trim().slice(0, 240),
    };
    if (toolCall.skillId && toolCall.tool) normalized.toolCall = toolCall;
  }
  if (isPlainObject(message.toolResult)) {
    const toolResult = {
      skillId: normalizeString(message.toolResult.skillId, '').trim().slice(0, 40),
      tool: normalizeString(message.toolResult.tool, '').trim().slice(0, 40),
      content: normalizeString(message.toolResult.content, '').slice(0, 60000),
    };
    if (toolResult.skillId && toolResult.tool && toolResult.content) normalized.toolResult = toolResult;
  }
  return normalized;
}

function normalizeAiConversation(item) {
  if (!isPlainObject(item) || typeof item.id !== 'string' || !item.id) return null;
  const messages = Array.isArray(item.messages)
    ? item.messages.map(normalizeAiChatMessage).filter(Boolean).slice(-50)
    : [];
  const title = typeof item.title === 'string' && item.title.trim()
    ? item.title.trim().slice(0, 40)
    : '\u65b0\u5bf9\u8bdd';
  const updatedAt = Number.isFinite(Number(item.updatedAt)) ? Number(item.updatedAt) : Date.now();
  const scope = item.scope === 'editor' ? 'editor' : 'global';
  const logKey = scope === 'editor' && typeof item.logKey === 'string'
    ? item.logKey.trim().slice(0, 120)
    : '';
  return {
    id: item.id.slice(0, 80),
    title,
    messages,
    updatedAt,
    scope,
    logKey,
    diarySensitive: item.diarySensitive === true,
  };
}

function readAiChats() {
  if (cache.aiChats !== null) return cloneJson(cache.aiChats);
  ensureDataDir();
  if (!fs.existsSync(AI_CHATS_FILE)) {
    cache.aiChats = { conversations: [], activeConversationId: '' };
    return cloneJson(cache.aiChats);
  }
  try {
    const saved = JSON.parse(fs.readFileSync(AI_CHATS_FILE, 'utf-8'));
    const conversations = Array.isArray(saved?.conversations)
      ? saved.conversations.map(normalizeAiConversation).filter(Boolean)
      : [];
    const activeConversationId = conversations.some(item => item.id === saved?.activeConversationId)
      ? saved.activeConversationId
      : (conversations[0]?.id || '');
    cache.aiChats = { conversations, activeConversationId };
    return cloneJson(cache.aiChats);
  } catch (err) {
    return failCorruptData('ai-chats.json', AI_CHATS_FILE, err);
  }
}

function writeAiChats(data) {
  ensureDataDir();
  const conversations = Array.isArray(data?.conversations)
    ? data.conversations.map(normalizeAiConversation).filter(Boolean).slice(0, 200)
    : [];
  const activeConversationId = conversations.some(item => item.id === data?.activeConversationId)
    ? data.activeConversationId
    : (conversations[0]?.id || '');
  const next = { conversations, activeConversationId };
  atomicWriteJson(AI_CHATS_FILE, next);
  cache.aiChats = cloneJson(next);
  return cloneJson(next);
}

function normalizeAiSettings(data) {
  const source = isPlainObject(data) ? data : {};
  const model = ['deepseek-v4-flash', 'deepseek-v4-pro'].includes(source.model)
    ? source.model
    : DEFAULT_AI_SETTINGS.model;
  const reasoningEffort = ['high', 'max'].includes(source.reasoningEffort)
    ? source.reasoningEffort
    : DEFAULT_AI_SETTINGS.reasoningEffort;
  const skillsSource = isPlainObject(source.skills) ? source.skills : {};
  const westockSource = isPlainObject(skillsSource.westock) ? skillsSource.westock : {};
  const perplexitySource = isPlainObject(skillsSource.perplexity) ? skillsSource.perplexity : {};
  const policySource = isPlainObject(source.logAccessPolicy) ? source.logAccessPolicy : null;
  const normalizePolicy = (policy) => {
    if (!policy) return null;
    const deniedSource = isPlainObject(policy.deniedSubcategories) ? policy.deniedSubcategories : {};
    const deniedSubcategories = {};
    Object.entries(deniedSource).forEach(([parent, subs]) => {
      if (typeof parent !== 'string' || !Array.isArray(subs)) return;
      const cleanParent = parent.trim().slice(0, 80);
      const cleanSubs = [...new Set(subs
        .filter(sub => typeof sub === 'string')
        .map(sub => sub.trim().slice(0, 80))
        .filter(Boolean))];
      if (cleanParent && cleanSubs.length) deniedSubcategories[cleanParent] = cleanSubs;
    });
    return {
      allowedParents: Array.isArray(policy.allowedParents)
        ? [...new Set(policy.allowedParents
          .filter(parent => typeof parent === 'string')
          .map(parent => parent.trim().slice(0, 80))
          .filter(Boolean))]
        : [],
      deniedSubcategories,
    };
  };
  return {
    apiKey: typeof source.apiKey === 'string' ? source.apiKey.trim().slice(0, 500) : '',
    model,
    reasoningEffort,
    stream: typeof source.stream === 'boolean' ? source.stream : DEFAULT_AI_SETTINGS.stream,
    userProfile: typeof source.userProfile === 'string' ? source.userProfile.trim().slice(0, 2000) : DEFAULT_AI_SETTINGS.userProfile,
    logContextEnabled: typeof source.logContextEnabled === 'boolean' ? source.logContextEnabled : DEFAULT_AI_SETTINGS.logContextEnabled,
    diaryContextEnabled: typeof source.diaryContextEnabled === 'boolean' ? source.diaryContextEnabled : DEFAULT_AI_SETTINGS.diaryContextEnabled,
    tavilyApiKey: typeof source.tavilyApiKey === 'string' ? source.tavilyApiKey.trim().slice(0, 500) : '',
    perplexityApiKey: typeof source.perplexityApiKey === 'string' ? source.perplexityApiKey.trim().slice(0, 500) : '',
    webSearchEnabled: typeof source.webSearchEnabled === 'boolean' ? source.webSearchEnabled : DEFAULT_AI_SETTINGS.webSearchEnabled,
    webSearchDepth: ['basic', 'advanced'].includes(source.webSearchDepth) ? source.webSearchDepth : DEFAULT_AI_SETTINGS.webSearchDepth,
    seedreamApiKey: typeof source.seedreamApiKey === 'string' ? source.seedreamApiKey.trim().slice(0, 500) : '',
    seedreamModel: ['doubao-seedream-5-0-260128', 'doubao-seedream-4-5-251128', 'doubao-seedream-4-0-250828'].includes(source.seedreamModel)
      ? source.seedreamModel
      : DEFAULT_AI_SETTINGS.seedreamModel,
    seedreamSize: typeof source.seedreamSize === 'string' && source.seedreamSize.trim()
      ? source.seedreamSize.trim().slice(0, 40)
      : DEFAULT_AI_SETTINGS.seedreamSize,
    seedreamWatermark: typeof source.seedreamWatermark === 'boolean' ? source.seedreamWatermark : DEFAULT_AI_SETTINGS.seedreamWatermark,
    logAccessPolicy: normalizePolicy(policySource),
    skills: {
      westock: {
        enabled: typeof westockSource.enabled === 'boolean' ? westockSource.enabled : true,
      },
      perplexity: {
        enabled: typeof perplexitySource.enabled === 'boolean' ? perplexitySource.enabled : true,
      },
    },
  };
}

function readAiSettings() {
  if (cache.aiSettings !== null) return cloneJson(cache.aiSettings);
  ensureDataDir();
  if (!fs.existsSync(AI_SETTINGS_FILE)) {
    cache.aiSettings = { ...DEFAULT_AI_SETTINGS };
    return cloneJson(cache.aiSettings);
  }
  try {
    cache.aiSettings = normalizeAiSettings(JSON.parse(fs.readFileSync(AI_SETTINGS_FILE, 'utf-8')));
    return cloneJson(cache.aiSettings);
  } catch (err) {
    return failCorruptData('ai-settings.json', AI_SETTINGS_FILE, err);
  }
}

function writeAiSettings(data) {
  const next = normalizeAiSettings(data);
  atomicWriteJson(AI_SETTINGS_FILE, next);
  cache.aiSettings = cloneJson(next);
  return cloneJson(next);
}

function readTodoReminderSettings() {
  if (cache.todoReminderSettings !== null) return { ...cache.todoReminderSettings };
  ensureDataDir();
  if (!fs.existsSync(TODO_REMINDER_SETTINGS_FILE)) {
    cache.todoReminderSettings = { ...DEFAULT_TODO_REMINDER_SETTINGS };
    return { ...cache.todoReminderSettings };
  }
  try {
    const normalized = normalizeTodoReminderSettings(JSON.parse(fs.readFileSync(TODO_REMINDER_SETTINGS_FILE, 'utf-8')));
    if (normalized.error) throw new Error(normalized.error);
    cache.todoReminderSettings = normalized;
    return { ...cache.todoReminderSettings };
  } catch (err) {
    return failCorruptData('todo-reminder-settings.json', TODO_REMINDER_SETTINGS_FILE, err);
  }
}

function writeTodoReminderSettings(data, options = {}) {
  ensureDataDir();
  const normalized = normalizeTodoReminderSettings(data, options);
  if (normalized.error) return normalized;
  atomicWriteJson(TODO_REMINDER_SETTINGS_FILE, normalized);
  cache.todoReminderSettings = { ...normalized };
  return { ...normalized };
}

function readTodoReminderState() {
  if (cache.todoReminderState !== null) return cloneJson(cache.todoReminderState);
  ensureDataDir();
  if (!fs.existsSync(TODO_REMINDER_STATE_FILE)) {
    cache.todoReminderState = { ...DEFAULT_TODO_REMINDER_STATE, snapshot: [] };
    return cloneJson(cache.todoReminderState);
  }
  try {
    cache.todoReminderState = normalizeTodoReminderState(JSON.parse(fs.readFileSync(TODO_REMINDER_STATE_FILE, 'utf-8')));
    return cloneJson(cache.todoReminderState);
  } catch (err) {
    return failCorruptData('todo-reminder-state.json', TODO_REMINDER_STATE_FILE, err);
  }
}

function writeTodoReminderState(data) {
  const next = normalizeTodoReminderState(data);
  atomicWriteJson(TODO_REMINDER_STATE_FILE, next);
  cache.todoReminderState = cloneJson(next);
  return cloneJson(next);
}

function markPrivateUpload(filename) {
  const normalized = normalizeUploadFilename(filename);
  if (!normalized) return false;
  const filenames = readPrivateUploads();
  if (!filenames.includes(normalized)) {
    writePrivateUploads([...filenames, normalized]);
  }
  return true;
}

function markPrivateUploadsFromContent(content) {
  const filenames = extractLocalUploadFilenames(content);
  filenames.forEach(markPrivateUpload);
  return filenames;
}

function unmarkPrivateUpload(filename) {
  const normalized = normalizeUploadFilename(filename);
  if (!normalized) return;
  const filenames = readPrivateUploads();
  if (filenames.includes(normalized)) {
    writePrivateUploads(filenames.filter(item => item !== normalized));
  }
}

function isPrivateUpload(filename) {
  const normalized = normalizeUploadFilename(filename);
  if (!normalized) return false;
  if (readPrivateUploads().includes(normalized)) return true;
  return readLogs().some(log =>
    isDiaryCategory(log.category) &&
    extractLocalUploadFilenames(log.content).includes(normalized)
  );
}

// CRUD operations

function getFilteredLogs(query = {}, diaryUnlocked = true) {
  let logs = readLogs();

  // Hide diary logs if locked
  if (!diaryUnlocked) {
    logs = logs.filter(l => !isDiaryCategory(l.category));
  }

  // Filter by date
  if (query.date) {
    logs = logs.filter(l => l.log_date === query.date);
    const hiddenParents = new Set(
      readCategories()
        .filter(category => category.calendar_day_visible === false)
        .map(category => category.name)
    );
    if (hiddenParents.size > 0) {
      logs = logs.filter(l => !hiddenParents.has(getParentCat(l.category)));
    }
  }

  // Filter by month (YYYY-MM)
  if (query.month) {
    logs = logs.filter(l => (l.log_date || '').startsWith(query.month));
  }

  // Filter by category — prefix match for parent (e.g. "开发" matches "开发/前端")
  if (query.category) {
    logs = logs.filter(l => l.category === query.category || l.category.startsWith(query.category + '/'));
  }

  // Search in title and content
  if (query.search) {
    const s = query.search.toLowerCase();
    logs = logs.filter(l =>
      l.title.toLowerCase().includes(s) ||
      l.content.toLowerCase().includes(s)
    );
  }

  // Category browsing promotes pinned logs before the existing date/manual order.
  logs.sort((a, b) => {
    if (query.category) {
      const pinnedDiff = Number(b.pinned === true) - Number(a.pinned === true);
      if (pinnedDiff !== 0) return pinnedDiff;
      if (a.pinned === true && b.pinned === true) {
        const pinnedAtDiff = (b.pinned_at || '').localeCompare(a.pinned_at || '');
        if (pinnedAtDiff !== 0) return pinnedAtDiff;
      }
    }
    const dateA = a.log_date || '';
    const dateB = b.log_date || '';
    if (dateA !== dateB) return dateB.localeCompare(dateA);
    if ((a.sort_order || 0) !== (b.sort_order || 0)) return (a.sort_order || 0) - (b.sort_order || 0);
    return b.id - a.id;
  });

  return logs;
}

function getAllUnpaginated(query = {}, diaryUnlocked = true) {
  return getFilteredLogs(query, diaryUnlocked).map(log => ({ ...log }));
}

function getAll(query = {}, diaryUnlocked = true) {
  const logs = getFilteredLogs(query, diaryUnlocked);

  // Pagination
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const limit = Math.min(500, Math.max(1, Number.parseInt(query.limit, 10) || 50));
  const total = logs.length;
  const totalPages = Math.ceil(total / limit);
  const start = (page - 1) * limit;
  const items = logs.slice(start, start + limit);

  return { items, total, page, totalPages };
}

function getById(id) {
  const logs = readLogs();
  return logs.find(l => l.id === id) || null;
}

function create(data, referenceDate = new Date()) {
  const logs = readLogs();
  cache.maxLogId++;
  const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
  const entry = {
    id: cache.maxLogId,
    title: data.title || '',
    content: data.content || '',
    category: data.category || 'general',
    hours: parseFloat(data.hours) || 0,
    log_date: data.log_date === undefined ? businessDateString(referenceDate) : (data.log_date || ''),
    sort_order: data.sort_order !== undefined ? data.sort_order : 0,
    pinned: data.pinned === true,
    pinned_at: data.pinned === true ? new Date().toISOString() : null,
    created_at: now,
    updated_at: now,
  };
  logs.push(entry);
  writeLogs(logs);
  if (isDiaryCategory(entry.category)) markPrivateUploadsFromContent(entry.content);
  return entry;
}

function update(id, data) {
  const logs = readLogs();
  const index = logs.findIndex(l => l.id === id);
  if (index === -1) return null;

  const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
  const entry = logs[index];
  if (isDiaryCategory(entry.category)) markPrivateUploadsFromContent(entry.content);
  if (data.title !== undefined) entry.title = data.title;
  if (data.content !== undefined) entry.content = data.content;
  if (data.category !== undefined) entry.category = data.category;
  if (data.hours !== undefined) entry.hours = parseFloat(data.hours) || 0;
  if (data.log_date !== undefined) entry.log_date = data.log_date;
  if (data.pinned !== undefined) {
    entry.pinned = data.pinned;
    entry.pinned_at = data.pinned ? new Date().toISOString() : null;
  }
  entry.updated_at = now;

  writeLogs(logs);
  if (isDiaryCategory(entry.category)) markPrivateUploadsFromContent(entry.content);
  return entry;
}

function remove(id) {
  const logs = readLogs();
  const index = logs.findIndex(l => l.id === id);
  if (index === -1) return false;
  if (isDiaryCategory(logs[index].category)) markPrivateUploadsFromContent(logs[index].content);
  logs.splice(index, 1);
  writeLogs(logs);
  return true;
}

function getStats(diaryUnlocked = true, referenceDate = new Date()) {
  let logs = readLogs();
  if (!diaryUnlocked) {
    logs = logs.filter(l => !isDiaryCategory(l.category));
  }
  const today = businessDateString(referenceDate);
  const todayParts = parseDateParts(today);

  // This week (Mon-Sun)
  const mondayStr = startOfWeekMonday(today);

  // This month
  const monthStr = today.substring(0, 7);

  const weekLogs = logs.filter(l => (l.log_date || '') >= mondayStr && (l.log_date || '') <= today);
  const monthLogs = logs.filter(l => (l.log_date || '').startsWith(monthStr));

  const weekHours = weekLogs.reduce((s, l) => s + l.hours, 0);
  const monthHours = monthLogs.reduce((s, l) => s + l.hours, 0);

  // Category breakdown (all time) — grouped by parent category
  const catMap = {};
  logs.forEach(l => {
    const parent = getParentCat(l.category);
    catMap[parent] = (catMap[parent] || 0) + l.hours;
  });
  const categoryBreakdown = Object.entries(catMap)
    .map(([name, hours]) => ({ name, hours: Math.round(hours * 10) / 10 }))
    .sort((a, b) => b.hours - a.hours);

  // Daily average this month
  const monthDays = daysInMonth(today);
  const dailyAvg = Math.round((monthHours / Math.min(todayParts.day, monthDays)) * 10) / 10;

  // Dates shown on the clickable calendar should match day-browsing visibility.
  const hiddenCalendarParents = new Set(
    readCategories()
      .filter(category => category.calendar_day_visible === false)
      .map(category => category.name)
  );
  const calendarLogs = logs.filter(log => !hiddenCalendarParents.has(getParentCat(log.category)));
  const datesWithLogs = [...new Set(calendarLogs.map(l => l.log_date).filter(Boolean))];

  return {
    totalLogs: logs.length,
    weekHours: Math.round(weekHours * 10) / 10,
    monthHours: Math.round(monthHours * 10) / 10,
    dailyAvg,
    categoryBreakdown,
    datesWithLogs,
  };
}

// Todo CRUD

const TODOS_FILE = path.join(DATA_DIR, 'todos.json');
const TODO_CATEGORIES_FILE = path.join(DATA_DIR, 'todo-categories.json');
const DEFAULT_TODO_CATEGORY = '\u5f85\u529e';

function normalizeTodoCategoryName(value, fallback = DEFAULT_TODO_CATEGORY) {
  const name = typeof value === 'string' ? value.trim() : '';
  return name ? name.slice(0, 24) : fallback;
}

function readTodos() {
  if (cache.todos !== null) return cloneTodos(cache.todos);
  ensureDataDir();
  if (!fs.existsSync(TODOS_FILE)) {
    fs.writeFileSync(TODOS_FILE, '[]', 'utf-8');
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(TODOS_FILE, 'utf-8'));
    if (!Array.isArray(parsed)) throw new Error('todos.json must contain an array');
    cache.todos = parsed;
    cache.maxTodoId = maxPositiveId(cache.todos);
    return cloneTodos(cache.todos);
  } catch (err) {
    return failCorruptData('todos.json', TODOS_FILE, err);
  }
}

function writeTodos(todos) {
  const next = cloneTodos(todos);
  atomicWriteJson(TODOS_FILE, next);
  cache.todos = next;
  cache.maxTodoId = maxPositiveId(next);
}

function readTodoCategories() {
  if (cache.todoCategories !== null) return [...cache.todoCategories];
  ensureDataDir();
  let categories = [];
  if (fs.existsSync(TODO_CATEGORIES_FILE)) {
    try {
      const saved = JSON.parse(fs.readFileSync(TODO_CATEGORIES_FILE, 'utf-8'));
      if (!Array.isArray(saved)) throw new Error('todo-categories.json must contain an array');
      categories = saved;
    } catch (err) {
      return failCorruptData('todo-categories.json', TODO_CATEGORIES_FILE, err);
    }
  }
  const names = new Set([DEFAULT_TODO_CATEGORY]);
  categories.forEach(name => names.add(normalizeTodoCategoryName(name)));
  readTodos().forEach(todo => names.add(normalizeTodoCategoryName(todo.category)));
  cache.todoCategories = [...names];
  return [...cache.todoCategories];
}

function writeTodoCategories(categories) {
  ensureDataDir();
  const names = [];
  const seen = new Set();
  [DEFAULT_TODO_CATEGORY, ...categories].forEach(name => {
    const normalized = normalizeTodoCategoryName(name);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      names.push(normalized);
    }
  });
  atomicWriteJson(TODO_CATEGORIES_FILE, names);
  cache.todoCategories = names;
}

function getTodoCategories() {
  return [...readTodoCategories()];
}

function addTodoCategory(name) {
  const normalized = normalizeTodoCategoryName(name, '');
  if (!normalized) return { error: 'Invalid todo category name' };
  const categories = readTodoCategories();
  if (categories.includes(normalized)) return { category: normalized, categories };
  const next = [...categories, normalized];
  writeTodoCategories(next);
  return { category: normalized, categories: next };
}

function deleteTodoCategory(name) {
  const normalized = normalizeTodoCategoryName(name, '');
  if (!normalized) return { error: 'Invalid todo category name' };
  if (normalized === DEFAULT_TODO_CATEGORY) return { error: 'Default todo category is protected' };
  const categories = readTodoCategories();
  if (!categories.includes(normalized)) return null;
  const next = categories.filter(category => category !== normalized);
  const todos = readTodos();
  todos.forEach(todo => {
    if (normalizeTodoCategoryName(todo.category) === normalized) todo.category = DEFAULT_TODO_CATEGORY;
  });
  writeTodos(todos);
  writeTodoCategories(next);
  return { categories: next };
}

function getAllTodos(query = {}) {
  let todos = readTodos();

  if (query.status === 'done') {
    todos = todos.filter(t => t.done);
  } else if (query.status === 'pending') {
    todos = todos.filter(t => !t.done);
  }

  // Sort: pending first, then sort_order asc, then by id desc
  todos.sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    if ((a.sort_order || 0) !== (b.sort_order || 0)) return (a.sort_order || 0) - (b.sort_order || 0);
    return b.id - a.id;
  });

  return todos.map(t => ({
    ...t,
    notes: typeof t.notes === 'string' ? t.notes : '',
    priority: normalizeTodoPriority(t.priority),
    recurrence: normalizeTodoRecurrence(t.recurrence),
    category: normalizeTodoCategoryName(t.category),
    due_date: t.due_date || null,
  }));
}

function normalizeTodoPriority(priority) {
  const value = typeof priority === 'string' && priority ? priority : 'none';
  const legacy = { low: 'normal', high: 'important' };
  const normalized = legacy[value] || value;
  return ['none', 'normal', 'important', 'urgent'].includes(normalized) ? normalized : 'none';
}

function normalizeTodoRecurrence(recurrence) {
  const value = typeof recurrence === 'string' && recurrence ? recurrence : 'none';
  return ['none', 'daily', 'weekly', 'monthly', 'yearly'].includes(value) ? value : 'none';
}

function formatTodoDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function daysInTodoMonth(year, monthIndex) {
  return new Date(year, monthIndex + 1, 0).getDate();
}

function addTodoRecurrenceDate(dueDate, recurrence) {
  if (!isValidDate(dueDate)) return null;
  const [, yearRaw, monthRaw, dayRaw] = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dueDate);
  const year = Number(yearRaw);
  const monthIndex = Number(monthRaw) - 1;
  const day = Number(dayRaw);

  if (recurrence === 'daily') return formatTodoDate(new Date(year, monthIndex, day + 1));
  if (recurrence === 'weekly') return formatTodoDate(new Date(year, monthIndex, day + 7));

  if (recurrence === 'monthly') {
    const target = new Date(year, monthIndex + 1, 1);
    const targetDay = Math.min(day, daysInTodoMonth(target.getFullYear(), target.getMonth()));
    return formatTodoDate(new Date(target.getFullYear(), target.getMonth(), targetDay));
  }

  if (recurrence === 'yearly') {
    const targetYear = year + 1;
    const targetDay = Math.min(day, daysInTodoMonth(targetYear, monthIndex));
    return formatTodoDate(new Date(targetYear, monthIndex, targetDay));
  }

  return null;
}

function createNextRecurringTodo(todos, source) {
  const recurrence = normalizeTodoRecurrence(source.recurrence);
  if (recurrence === 'none') return null;
  const nextDueDate = addTodoRecurrenceDate(source.due_date, recurrence);
  if (!nextDueDate) return null;

  cache.maxTodoId++;
  const entry = {
    id: cache.maxTodoId,
    title: source.title || '',
    done: false,
    sort_order: source.sort_order !== undefined ? source.sort_order : 0,
    due_date: nextDueDate,
    priority: normalizeTodoPriority(source.priority),
    recurrence,
    category: normalizeTodoCategoryName(source.category),
    notes: typeof source.notes === 'string' ? source.notes : '',
    created_at: nowTimestamp(),
  };
  todos.push(entry);
  addTodoCategory(entry.category);
  return entry;
}

function createTodo(data) {
  const todos = readTodos();
  cache.maxTodoId++;
  const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
  const entry = {
    id: cache.maxTodoId,
    title: data.title || '',
    done: false,
    sort_order: data.sort_order !== undefined ? data.sort_order : 0,
    due_date: data.due_date || null,
    priority: normalizeTodoPriority(data.priority),
    recurrence: normalizeTodoRecurrence(data.recurrence),
    category: normalizeTodoCategoryName(data.category),
    notes: typeof data.notes === 'string' ? data.notes : '',
    created_at: now,
  };
  todos.push(entry);
  addTodoCategory(entry.category);
  writeTodos(todos);
  return entry;
}

function updateTodo(id, data) {
  const todos = readTodos();
  const index = todos.findIndex(t => t.id === id);
  if (index === -1) return null;

  const entry = todos[index];
  const wasDone = !!entry.done;
  if (data.title !== undefined) entry.title = data.title;
  if (data.done !== undefined) entry.done = !!data.done;
  if (data.due_date !== undefined) entry.due_date = data.due_date;
  if (data.priority !== undefined) entry.priority = normalizeTodoPriority(data.priority);
  if (data.recurrence !== undefined) entry.recurrence = normalizeTodoRecurrence(data.recurrence);
  if (data.category !== undefined) {
    entry.category = normalizeTodoCategoryName(data.category);
    addTodoCategory(entry.category);
  }
  if (data.notes !== undefined) entry.notes = typeof data.notes === 'string' ? data.notes : '';
  if (!wasDone && entry.done) createNextRecurringTodo(todos, entry);

  writeTodos(todos);
  return {
    ...entry,
    notes: typeof entry.notes === 'string' ? entry.notes : '',
    priority: normalizeTodoPriority(entry.priority),
    recurrence: normalizeTodoRecurrence(entry.recurrence),
    category: normalizeTodoCategoryName(entry.category),
    due_date: entry.due_date || null,
  };
}

function removeTodo(id) {
  const todos = readTodos();
  const index = todos.findIndex(t => t.id === id);
  if (index === -1) return false;
  todos.splice(index, 1);
  writeTodos(todos);
  return true;
}

function removeCompletedTodos() {
  const todos = readTodos();
  const remaining = todos.filter(t => !t.done);
  const removedCount = todos.length - remaining.length;
  if (removedCount > 0) writeTodos(remaining);
  return removedCount;
}

function reorderLogs(orderedIds) {
  const logs = readLogs();
  const orderMap = new Map(orderedIds.map((id, i) => [id, i]));
  logs.forEach(l => { if (orderMap.has(l.id)) l.sort_order = orderMap.get(l.id); });
  writeLogs(logs);
}

function reorderTodos(orderedIds) {
  const todos = readTodos();
  const orderMap = new Map(orderedIds.map((id, i) => [id, i]));
  todos.forEach(t => { if (orderMap.has(t.id)) t.sort_order = orderMap.get(t.id); });
  writeTodos(todos);
}

// Countdown CRUD

function readCountdowns() {
  if (cache.countdowns !== null) return cloneCountdowns(cache.countdowns);
  ensureDataDir();
  if (!fs.existsSync(COUNTDOWNS_FILE)) {
    atomicWriteJson(COUNTDOWNS_FILE, []);
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(COUNTDOWNS_FILE, 'utf-8'));
    if (!Array.isArray(parsed)) throw new Error('countdowns.json must contain an array');
    cache.countdowns = parsed;
    cache.maxCountdownId = maxPositiveId(parsed);
    return cloneCountdowns(cache.countdowns);
  } catch (err) {
    return failCorruptData('countdowns.json', COUNTDOWNS_FILE, err);
  }
}

function writeCountdowns(countdowns) {
  const next = cloneCountdowns(countdowns);
  atomicWriteJson(COUNTDOWNS_FILE, next);
  cache.countdowns = next;
  cache.maxCountdownId = maxPositiveId(next);
}

function getAllCountdowns() {
  return readCountdowns().sort((a, b) => b.id - a.id);
}

function createCountdown(data) {
  const countdowns = readCountdowns();
  const now = nowTimestamp();
  cache.maxCountdownId += 1;
  const entry = {
    id: cache.maxCountdownId,
    title: data.title,
    target_date: data.target_date,
    repeat_yearly: data.repeat_yearly === true,
    notes: data.notes || '',
    created_at: now,
    updated_at: now,
  };
  countdowns.push(entry);
  writeCountdowns(countdowns);
  return { ...entry };
}

function updateCountdown(id, data) {
  const countdowns = readCountdowns();
  const index = countdowns.findIndex(item => item.id === id);
  if (index === -1) return null;
  const entry = countdowns[index];
  if (data.title !== undefined) entry.title = data.title;
  if (data.target_date !== undefined) entry.target_date = data.target_date;
  if (data.repeat_yearly !== undefined) entry.repeat_yearly = data.repeat_yearly;
  if (data.notes !== undefined) entry.notes = data.notes;
  entry.updated_at = nowTimestamp();
  writeCountdowns(countdowns);
  return { ...entry };
}

function removeCountdown(id) {
  const countdowns = readCountdowns();
  const index = countdowns.findIndex(item => item.id === id);
  if (index === -1) return false;
  countdowns.splice(index, 1);
  writeCountdowns(countdowns);
  return true;
}

const DEFAULT_CATEGORIES = [
  { name: '会议', sub: [], calendar_day_visible: true },
  { name: '开发', sub: [], calendar_day_visible: true },
  { name: '文档', sub: [], calendar_day_visible: true },
  { name: '测试', sub: [], calendar_day_visible: true },
  { name: '学习', sub: [], calendar_day_visible: true },
  { name: '其他', sub: [], calendar_day_visible: true },
];
const CATEGORIES_FILE = path.join(DATA_DIR, 'categories.json');

function migrateToTree(cats) {
  return cats.map(c => {
    if (typeof c === 'string') return { name: c, sub: [], calendar_day_visible: true };
    if (c && typeof c === 'object' && c.name) {
      return {
        name: c.name,
        sub: Array.isArray(c.sub) ? c.sub : [],
        calendar_day_visible: c.calendar_day_visible !== false,
      };
    }
    return null;
  }).filter(Boolean);
}

function readCategories() {
  if (cache.categories !== null) return cloneCategories(cache.categories);
  ensureDataDir();
  if (!fs.existsSync(CATEGORIES_FILE)) {
    fs.writeFileSync(CATEGORIES_FILE, JSON.stringify(DEFAULT_CATEGORIES, null, 2), 'utf-8');
    cache.categories = cloneCategories(DEFAULT_CATEGORIES);
    return cloneCategories(cache.categories);
  }
  try {
    let cats = JSON.parse(fs.readFileSync(CATEGORIES_FILE, 'utf-8'));
    if (!Array.isArray(cats)) throw new Error('categories.json must contain an array');
    const normalizedCats = migrateToTree(cats);
    if (JSON.stringify(normalizedCats) !== JSON.stringify(cats)) {
      cats = normalizedCats;
      writeCategories(cats);
    }
    cache.categories = cats;
    return cloneCategories(cats);
  } catch (err) {
    return failCorruptData('categories.json', CATEGORIES_FILE, err);
  }
}

function writeCategories(cats) {
  const next = cloneCategories(cats);
  atomicWriteJson(CATEGORIES_FILE, next);
  cache.categories = next;
}

function getCategoryLogCounts(diaryUnlocked = true) {
  const counts = new Map();
  const subCounts = new Map();
  const logs = diaryUnlocked
    ? readLogs()
    : readLogs().filter(log => !isDiaryCategory(log.category));

  logs.forEach(log => {
    const parsed = parseCategoryPath(log.category);
    counts.set(parsed.parent, (counts.get(parsed.parent) || 0) + 1);
    if (parsed.sub) {
      const key = `${parsed.parent}/${parsed.sub}`;
      subCounts.set(key, (subCounts.get(key) || 0) + 1);
    }
  });

  return { counts, subCounts };
}

function getAllCategories(diaryUnlocked = true, includeDiaryRoot = false) {
  const { counts, subCounts } = getCategoryLogCounts(diaryUnlocked);
  const categories = readCategories().map(category => ({
    name: category.name,
    sub: !diaryUnlocked && category.name === DIARY_CATEGORY ? [] : [...(category.sub || [])],
    log_count: counts.get(category.name) || 0,
    sub_log_counts: !diaryUnlocked && category.name === DIARY_CATEGORY
      ? {}
      : Object.fromEntries(
        (category.sub || []).map(sub => [sub, subCounts.get(`${category.name}/${sub}`) || 0])
      ),
    calendar_day_visible: category.calendar_day_visible !== false,
  }));
  if (includeDiaryRoot && !categories.some(category => category.name === DIARY_CATEGORY)) {
    categories.push({
      name: DIARY_CATEGORY,
      sub: [],
      log_count: counts.get(DIARY_CATEGORY) || 0,
      sub_log_counts: {},
      calendar_day_visible: true,
    });
  }
  return categories;
}

/** Split "开发/前端" into { parent: "开发", sub: "前端" } */
function parseCategoryPath(cat) {
  if (!cat) return { parent: '其他', sub: null };
  const idx = cat.indexOf('/');
  if (idx === -1) return { parent: cat, sub: null };
  return { parent: cat.substring(0, idx), sub: cat.substring(idx + 1) };
}

/** Get the parent category name from a log's category field */
function getParentCat(cat) {
  const idx = cat.indexOf('/');
  return idx === -1 ? cat : cat.substring(0, idx);
}

function addCategory(name, parent) {
  name = name.trim();
  if (!name) return null;
  const cats = readCategories();
  if (parent) {
    let p = cats.find(c => c.name === parent);
    if (!p && parent === DIARY_CATEGORY) {
      p = { name: DIARY_CATEGORY, sub: [], calendar_day_visible: true };
      cats.push(p);
    }
    if (!p) return null;
    if (p.sub.includes(name)) return null;
    p.sub.push(name);
    writeCategories(cats);
    return { name, parent };
  }
  // Parent-level category
  if (cats.some(c => c.name === name)) return null;
  cats.push({ name, sub: [], calendar_day_visible: true });
  writeCategories(cats);
  return { name, sub: [], calendar_day_visible: true };
}

function setCategoryCalendarDayVisible(name, visible) {
  const cats = readCategories();
  let category = cats.find(item => item.name === name);
  if (!category && name === DIARY_CATEGORY) {
    category = { name: DIARY_CATEGORY, sub: [], calendar_day_visible: true };
    cats.push(category);
  }
  if (!category) return null;
  category.calendar_day_visible = visible !== false;
  writeCategories(cats);
  return {
    name: category.name,
    sub: [...(category.sub || [])],
    calendar_day_visible: category.calendar_day_visible,
  };
}

function renameCategory(oldName, newName) {
  oldName = oldName.trim();
  newName = newName.trim();
  if (!oldName || !newName) return { error: 'Invalid names' };
  if (oldName === DIARY_CATEGORY || newName === DIARY_CATEGORY) {
    return { error: 'Diary root category is protected' };
  }
  const cats = readCategories();
  const parsed = parseCategoryPath(oldName);

  if (parsed.sub) {
    // Renaming a subcategory: "开发/前端" → "开发/新前端"
    const parent = cats.find(c => c.name === parsed.parent);
    if (!parent) return { error: 'Parent category not found' };
    const idx = parent.sub.indexOf(parsed.sub);
    if (idx === -1) return { error: 'Subcategory not found' };
    if (parent.sub.includes(newName)) return { error: 'New name already exists' };
    parent.sub[idx] = newName;
    writeCategories(cats);

    // Update all logs referencing this subcategory
    const logs = readLogs();
    logs.forEach(l => {
      if (l.category === oldName) l.category = parsed.parent + '/' + newName;
    });
    writeLogs(logs);
    return { success: true };
  }

  // Renaming a parent category: "开发" → "研发"
  const idx = cats.findIndex(c => c.name === oldName);
  if (idx === -1) return { error: 'Category not found' };
  if (cats.some(c => c.name === newName)) return { error: 'New name already exists' };
  cats[idx].name = newName;
  writeCategories(cats);

  const logs = readLogs();
  logs.forEach(l => {
    const p = parseCategoryPath(l.category);
    if (p.parent === oldName) {
      l.category = p.sub ? newName + '/' + p.sub : newName;
    }
  });
  writeLogs(logs);
  return { success: true };
}

function deleteCategory(name) {
  name = name.trim();
  if (name === OTHER_CATEGORY || name === DIARY_CATEGORY) return false;
  const cats = readCategories();
  const parsed = parseCategoryPath(name);

  if (parsed.sub) {
    // Delete a subcategory
    const parent = cats.find(c => c.name === parsed.parent);
    if (!parent) return false;
    const idx = parent.sub.indexOf(parsed.sub);
    if (idx === -1) return false;
    parent.sub.splice(idx, 1);
    writeCategories(cats);
    // Reassign logs with this subcategory to parent-only
    const logs = readLogs();
    logs.forEach(l => {
      if (l.category === name) l.category = parsed.parent;
    });
    writeLogs(logs);
    return true;
  }

  // Delete a parent category and all its subcategories
  const idx = cats.findIndex(c => c.name === name);
  if (idx === -1) return false;
  cats.splice(idx, 1);
  writeCategories(cats);

  const logs = readLogs();
  logs.forEach(l => {
    if (getParentCat(l.category) === name) l.category = '其他';
  });
  writeLogs(logs);
  return true;
}

function checkDataIntegrity() {
  const issues = [];
  const logs = readLogs();
  const cats = readCategories();
  readTodos();
  readCountdowns();
  readTodoCategories();
  readPrivateUploads();
  readPhotoWall();
  readAiChats();
  readAiSettings();
  readTodoReminderSettings();
  readTodoReminderState();

  // Check for duplicate IDs
  const ids = new Set();
  logs.forEach(l => {
    if (ids.has(l.id)) issues.push(`Duplicate log ID: ${l.id}`);
    ids.add(l.id);
  });

  // Check for orphaned categories (parent categories and subcategories)
  const validCats = new Set();
  cats.forEach(c => {
    validCats.add(c.name);
    (c.sub || []).forEach(s => validCats.add(c.name + '/' + s));
  });
  logs.forEach(l => {
    if (!validCats.has(l.category)) issues.push(`Log #${l.id} has unknown category: "${l.category}"`);
  });

  if (issues.length > 0) {
    console.warn('Data integrity issues found:');
    issues.forEach(i => console.warn(' - ' + i));
  }
  return issues;
}

function backup() {
  return {
    logs: readLogs(),
    todos: getAllTodos(),
    countdowns: getAllCountdowns(),
    todoCategories: getTodoCategories(),
    categories: readCategories(),
    privateUploads: readPrivateUploads(),
    photoWall: getPhotoWall(),
    exportedAt: new Date().toISOString(),
  };
}

function normalizePrivateUploadsForRestore(privateUploads) {
  if (privateUploads === undefined) return { privateUploads: [] };
  if (!Array.isArray(privateUploads)) return { error: 'Invalid privateUploads data' };
  const normalized = [];
  const seen = new Set();
  for (const filename of privateUploads) {
    const safeName = normalizeUploadFilename(filename);
    if (!safeName) return { error: 'Invalid private upload filename' };
    if (!seen.has(safeName)) {
      seen.add(safeName);
      normalized.push(safeName);
    }
  }
  return { privateUploads: normalized };
}

function normalizeCategoriesForRestore(categories) {
  const seenParents = new Set();
  const normalized = [];

  for (const cat of categories) {
    const normalizedCat = typeof cat === 'string'
      ? { name: cat, sub: [] }
      : cat;

    if (!normalizedCat || typeof normalizedCat.name !== 'string' || !normalizedCat.name.trim()) {
      return { error: 'Invalid category name' };
    }
    if (normalizedCat.sub !== undefined && !Array.isArray(normalizedCat.sub)) {
      return { error: `Invalid subcategories for category "${normalizedCat.name}"` };
    }
    if (normalizedCat.calendar_day_visible !== undefined &&
        typeof normalizedCat.calendar_day_visible !== 'boolean') {
      return { error: `Invalid calendar day visibility for category "${normalizedCat.name}"` };
    }

    const name = normalizedCat.name.trim();
    if (seenParents.has(name)) return { error: `Duplicate category: ${name}` };
    seenParents.add(name);

    const seenSubs = new Set();
    const sub = [];
    for (const item of normalizedCat.sub || []) {
      if (typeof item !== 'string' || !item.trim()) {
        return { error: `Invalid subcategory under "${name}"` };
      }
      const subName = item.trim();
      if (seenSubs.has(subName)) return { error: `Duplicate subcategory: ${name}/${subName}` };
      seenSubs.add(subName);
      sub.push(subName);
    }

    normalized.push({
      name,
      sub,
      calendar_day_visible: normalizedCat.calendar_day_visible !== false,
    });
  }

  return { categories: normalized };
}

function normalizeLogsForRestore(logs) {
  const ids = new Set();
  const now = nowTimestamp();
  const normalized = [];

  for (const item of logs) {
    if (!isPlainObject(item)) return { error: 'Invalid log entry' };

    const id = toPositiveInteger(item.id);
    if (!id) return { error: 'Log id must be a positive integer' };
    if (ids.has(id)) return { error: `Duplicate log id: ${id}` };
    ids.add(id);

    const hours = normalizeFiniteNumber(item.hours, 0, { min: 0, max: 24 });
    if (hours === null) return { error: `Invalid hours for log id ${id}` };

    let logDate = item.log_date === undefined || item.log_date === null ? '' : item.log_date;
    if (typeof logDate !== 'string' || (logDate && !isValidDate(logDate))) {
      return { error: `Invalid log_date for log id ${id}` };
    }

    const sortOrder = normalizeFiniteNumber(item.sort_order, 0);
    if (sortOrder === null) return { error: `Invalid sort_order for log id ${id}` };

    if (item.pinned !== undefined && typeof item.pinned !== 'boolean') {
      return { error: `Invalid pinned for log id ${id}` };
    }
    const pinned = item.pinned === true;
    let pinnedAt = item.pinned_at === undefined ? null : item.pinned_at;
    if (pinnedAt !== null && (typeof pinnedAt !== 'string' || !pinnedAt || !Number.isFinite(Date.parse(pinnedAt)))) {
      return { error: `Invalid pinned_at for log id ${id}` };
    }
    if (!pinned) pinnedAt = null;

    const createdAt = normalizeString(item.created_at, now);
    const updatedAt = normalizeString(item.updated_at, createdAt);
    if (pinned && !pinnedAt) {
      pinnedAt = Number.isFinite(Date.parse(updatedAt)) ? updatedAt : new Date().toISOString();
    }

    normalized.push({
      id,
      title: normalizeString(item.title, ''),
      content: normalizeString(item.content, ''),
      category: normalizeString(item.category, OTHER_CATEGORY) || OTHER_CATEGORY,
      hours,
      log_date: logDate,
      sort_order: sortOrder,
      pinned,
      pinned_at: pinnedAt,
      created_at: createdAt,
      updated_at: updatedAt,
    });
  }

  return { logs: normalized };
}

function normalizeTodosForRestore(todos) {
  const ids = new Set();
  const now = nowTimestamp();
  const normalized = [];

  for (const item of todos) {
    if (!isPlainObject(item)) return { error: 'Invalid todo entry' };

    const id = toPositiveInteger(item.id);
    if (!id) return { error: 'Todo id must be a positive integer' };
    if (ids.has(id)) return { error: `Duplicate todo id: ${id}` };
    ids.add(id);

    let dueDate = item.due_date === undefined ? null : item.due_date;
    if (dueDate === '') dueDate = null;
    if (dueDate !== null && (typeof dueDate !== 'string' || !isValidDate(dueDate))) {
      return { error: `Invalid due_date for todo id ${id}` };
    }

    const sortOrder = normalizeFiniteNumber(item.sort_order, 0);
    if (sortOrder === null) return { error: `Invalid sort_order for todo id ${id}` };

    const rawPriority = normalizeString(item.priority, 'none') || 'none';
    if (!['none', 'normal', 'important', 'urgent', 'low', 'high'].includes(rawPriority)) {
      return { error: `Invalid priority for todo id ${id}` };
    }
    const priority = normalizeTodoPriority(rawPriority);
    const recurrence = normalizeTodoRecurrence(item.recurrence);

    const notes = item.notes === undefined ? '' : item.notes;
    if (typeof notes !== 'string') return { error: `Invalid notes for todo id ${id}` };
    const category = normalizeTodoCategoryName(item.category);

    normalized.push({
      id,
      title: normalizeString(item.title, ''),
      done: item.done === undefined ? false : !!item.done,
      sort_order: sortOrder,
      due_date: dueDate,
      priority,
      recurrence,
      category,
      notes,
      created_at: normalizeString(item.created_at, now),
    });
  }

  return { todos: normalized };
}

function normalizeTodoCategoriesForRestore(todoCategories, todos) {
  const names = new Set([DEFAULT_TODO_CATEGORY]);
  if (todoCategories !== undefined) {
    if (!Array.isArray(todoCategories)) return { error: 'Invalid todoCategories data' };
    for (const name of todoCategories) {
      const normalized = normalizeTodoCategoryName(name, '');
      if (!normalized) return { error: 'Invalid todo category name' };
      names.add(normalized);
    }
  }
  todos.forEach(todo => names.add(normalizeTodoCategoryName(todo.category)));
  return { todoCategories: [...names] };
}

function normalizeCountdownsForRestore(countdowns) {
  if (countdowns === undefined) return { countdowns: [] };
  if (!Array.isArray(countdowns)) return { error: 'Invalid countdowns data' };
  const ids = new Set();
  const now = nowTimestamp();
  const normalized = [];

  for (const item of countdowns) {
    if (!isPlainObject(item)) return { error: 'Invalid countdown entry' };
    const id = toPositiveInteger(item.id);
    if (!id) return { error: 'Countdown id must be a positive integer' };
    if (ids.has(id)) return { error: `Duplicate countdown id: ${id}` };
    ids.add(id);
    if (typeof item.title !== 'string' || !item.title.trim() || item.title.length > 200) {
      return { error: `Invalid title for countdown id ${id}` };
    }
    if (typeof item.target_date !== 'string' || !isValidDate(item.target_date)) {
      return { error: `Invalid target_date for countdown id ${id}` };
    }
    if (item.repeat_yearly !== undefined && typeof item.repeat_yearly !== 'boolean') {
      return { error: `Invalid repeat_yearly for countdown id ${id}` };
    }
    const notes = item.notes === undefined ? '' : item.notes;
    if (typeof notes !== 'string' || notes.length > 1000) {
      return { error: `Invalid notes for countdown id ${id}` };
    }
    normalized.push({
      id,
      title: item.title.trim(),
      target_date: item.target_date,
      repeat_yearly: item.repeat_yearly === true,
      notes,
      created_at: normalizeString(item.created_at, now),
      updated_at: normalizeString(item.updated_at, normalizeString(item.created_at, now)),
    });
  }
  return { countdowns: normalized };
}

function normalizePhotoWallForRestore(photoWall) {
  const normalized = normalizePhotoWallData(photoWall);
  if (normalized.error) return normalized;
  return { photoWall: normalized };
}

function normalizeRestoreData(data) {
  if (!data || typeof data !== 'object') return { error: 'Invalid backup data' };
  if (!Array.isArray(data.logs)) return { error: 'Missing logs data' };
  if (!Array.isArray(data.todos)) return { error: 'Missing todos data' };
  if (!Array.isArray(data.categories)) return { error: 'Missing categories data' };

  const logs = normalizeLogsForRestore(data.logs);
  if (logs.error) return logs;

  const todos = normalizeTodosForRestore(data.todos);
  if (todos.error) return todos;

  const countdowns = normalizeCountdownsForRestore(data.countdowns);
  if (countdowns.error) return countdowns;

  const todoCategories = normalizeTodoCategoriesForRestore(data.todoCategories, todos.todos);
  if (todoCategories.error) return todoCategories;

  const categories = normalizeCategoriesForRestore(data.categories);
  if (categories.error) return categories;

  const privateUploads = normalizePrivateUploadsForRestore(data.privateUploads);
  if (privateUploads.error) return privateUploads;

  const photoWall = normalizePhotoWallForRestore(data.photoWall);
  if (photoWall.error) return photoWall;

  return {
    logs: logs.logs,
    todos: todos.todos,
    countdowns: countdowns.countdowns,
    todoCategories: todoCategories.todoCategories,
    categories: categories.categories,
    privateUploads: privateUploads.privateUploads,
    photoWall: photoWall.photoWall,
  };
}

function capturePersistentState() {
  return {
    logs: readLogs(),
    todos: readTodos(),
    countdowns: readCountdowns(),
    todoCategories: readTodoCategories(),
    categories: readCategories(),
    privateUploads: readPrivateUploads(),
    photoWall: readPhotoWall(),
  };
}

function writePersistentState(next) {
  const previous = capturePersistentState();
  try {
    writeLogs(next.logs);
    writeTodos(next.todos);
    writeCountdowns(next.countdowns);
    writeTodoCategories(next.todoCategories);
    writeCategories(next.categories);
    writePrivateUploads(next.privateUploads);
    writePhotoWall(next.photoWall);
  } catch (err) {
    try {
      writeLogs(previous.logs);
      writeTodos(previous.todos);
      writeCountdowns(previous.countdowns);
      writeTodoCategories(previous.todoCategories);
      writeCategories(previous.categories);
      writePrivateUploads(previous.privateUploads);
      writePhotoWall(previous.photoWall);
    } catch (rollbackError) {
      err.message += `; rollback failed: ${rollbackError.message}`;
    }
    throw err;
  }
}

function restore(data, mode = 'replace') {
  if (!data || typeof data !== 'object') return { error: '无效的数据格式' };
  if (!Array.isArray(data.logs)) return { error: '缺少 logs 数据' };
  if (!Array.isArray(data.todos)) return { error: '缺少 todos 数据' };
  if (!Array.isArray(data.categories)) return { error: '缺少 categories 数据' };

  const normalized = normalizeRestoreData(data);
  if (normalized.error) return normalized;
  data = normalized;
  const previous = capturePersistentState();
  const historicalPrivateUploads = previous.logs
    .filter(log => isDiaryCategory(log.category))
    .flatMap(log => extractLocalUploadFilenames(log.content));

  if (mode === 'merge') {
    // Merge: upsert by ID, keeping newer data when conflicts
    const existingLogs = readLogs();
    const logMap = new Map(existingLogs.map(l => [l.id, l]));
    data.logs.forEach(l => {
      const existing = logMap.get(l.id);
      if (!existing || new Date(l.updated_at || 0) > new Date(existing.updated_at || 0)) {
        logMap.set(l.id, l);
      }
    });
    const mergedLogs = [...logMap.values()].sort((a, b) => b.id - a.id);

    const existingTodos = readTodos();
    const todoMap = new Map(existingTodos.map(t => [t.id, t]));
    data.todos.forEach(t => {
      const existing = todoMap.get(t.id);
      if (!existing || new Date(t.created_at || 0) > new Date(existing.created_at || 0)) {
        todoMap.set(t.id, t);
      }
    });
    const mergedTodos = [...todoMap.values()].sort((a, b) => b.id - a.id);

    const countdownMap = new Map(readCountdowns().map(item => [item.id, item]));
    data.countdowns.forEach(item => {
      const existing = countdownMap.get(item.id);
      if (!existing || new Date(item.updated_at || 0) > new Date(existing.updated_at || 0)) {
        countdownMap.set(item.id, item);
      }
    });
    const mergedCountdowns = [...countdownMap.values()].sort((a, b) => b.id - a.id);

    const existingCats = readCategories();
    // Normalize restore data to tree format
    const restoreCats = (data.categories.length > 0 && typeof data.categories[0] === 'string')
      ? migrateToTree(data.categories)
      : data.categories;
    const mergedCats = mergeCategoryTrees(existingCats, restoreCats);
    const mergedPrivateUploads = [...new Set([...readPrivateUploads(), ...data.privateUploads])];
    const mergedTodoCategories = [...new Set([...readTodoCategories(), ...data.todoCategories])];
    const photoWallMap = new Map(readPhotoWall().items.map(item => [item.id, item]));
    data.photoWall.items.forEach(item => {
      const existing = photoWallMap.get(item.id);
      if (!existing || new Date(item.updated_at || 0) > new Date(existing.updated_at || 0)) {
        photoWallMap.set(item.id, item);
      }
    });
    const mergedPhotoWall = { items: [...photoWallMap.values()].sort((a, b) => a.z - b.z || a.id - b.id) };

    const diaryUploads = mergedLogs
      .filter(log => isDiaryCategory(log.category))
      .flatMap(log => extractLocalUploadFilenames(log.content));
    writePersistentState({
      logs: mergedLogs,
      todos: mergedTodos,
      countdowns: mergedCountdowns,
      todoCategories: mergedTodoCategories,
      categories: mergedCats,
      privateUploads: [...new Set([...mergedPrivateUploads, ...historicalPrivateUploads, ...diaryUploads])],
      photoWall: mergedPhotoWall,
    });
    return { success: true, logs: mergedLogs.length, todos: mergedTodos.length, countdowns: mergedCountdowns.length, categories: mergedCats.length };
  }

  const categories = (data.categories.length > 0 && typeof data.categories[0] === 'string')
    ? migrateToTree(data.categories)
    : data.categories;
  const diaryUploads = data.logs
    .filter(log => isDiaryCategory(log.category))
    .flatMap(log => extractLocalUploadFilenames(log.content));
  writePersistentState({
    logs: data.logs,
    todos: data.todos,
    countdowns: data.countdowns,
    todoCategories: data.todoCategories,
    categories,
    privateUploads: [...new Set([...data.privateUploads, ...historicalPrivateUploads, ...diaryUploads])],
    photoWall: data.photoWall,
  });
  return { success: true, logs: data.logs.length, todos: data.todos.length, countdowns: data.countdowns.length, categories: data.categories.length };
}

function reorderCategories(orderedCats) {
  const cats = readCategories();
  // orderedCats is an array of parent category names
  const orderMap = new Map(orderedCats.map((name, i) => [name, i]));
  cats.sort((a, b) => {
    const ai = orderMap.get(a.name);
    const bi = orderMap.get(b.name);
    if (ai !== undefined && bi !== undefined) return ai - bi;
    if (ai !== undefined) return -1;
    if (bi !== undefined) return 1;
    return 0;
  });
  writeCategories(cats);
}

function reorderSubcategories(parentName, orderedSubs) {
  const cats = readCategories();
  const parent = cats.find(c => c.name === parentName);
  if (!parent) return null;
  const existing = Array.isArray(parent.sub) ? parent.sub : [];
  const seen = new Set();
  const ordered = [];
  orderedSubs.forEach(name => {
    if (typeof name !== 'string') return;
    if (!existing.includes(name) || seen.has(name)) return;
    seen.add(name);
    ordered.push(name);
  });
  existing.forEach(name => {
    if (!seen.has(name)) ordered.push(name);
  });
  parent.sub = ordered;
  writeCategories(cats);
  return { name: parent.name, sub: [...parent.sub] };
}

/** Merge two category trees, deduplicating by parent name and unioning subcategories */
function mergeCategoryTrees(existing, incoming) {
  const merged = existing.map(c => ({
    name: c.name,
    sub: [...(c.sub || [])],
    calendar_day_visible: c.calendar_day_visible !== false,
  }));
  const existingNames = new Set(merged.map(c => c.name));
  incoming.forEach(c => {
    if (existingNames.has(c.name)) {
      const target = merged.find(m => m.name === c.name);
      (c.sub || []).forEach(s => {
        if (!target.sub.includes(s)) target.sub.push(s);
      });
    } else {
      merged.push({
        name: c.name,
        sub: [...(c.sub || [])],
        calendar_day_visible: c.calendar_day_visible !== false,
      });
    }
  });
  return merged;
}

return {
  dataDir: DATA_DIR,
  getAll,
  getAllUnpaginated,
  getById,
  create,
  update,
  remove,
  getStats,
  reorderLogs,
  getAllTodos,
  createTodo,
  updateTodo,
  removeTodo,
  removeCompletedTodos,
  reorderTodos,
  getAllCountdowns,
  createCountdown,
  updateCountdown,
  removeCountdown,
  getTodoCategories,
  addTodoCategory,
  deleteTodoCategory,
  getTodoReminderSettings: readTodoReminderSettings,
  saveTodoReminderSettings: writeTodoReminderSettings,
  getTodoReminderState: readTodoReminderState,
  saveTodoReminderState: writeTodoReminderState,
  getAllCategories,
  addCategory,
  renameCategory,
  deleteCategory,
  reorderCategories,
  reorderSubcategories,
  setCategoryCalendarDayVisible,
  getAiChats: readAiChats,
  saveAiChats: writeAiChats,
  getAiSettings: readAiSettings,
  saveAiSettings: writeAiSettings,
  getPhotoWall,
  createPhotoWallItem,
  updatePhotoWallItem,
  deletePhotoWallItem,
  reorderPhotoWallItems,
  backup,
  restore,
  checkDataIntegrity,
  resetCache,
  isDiaryCategory,
  isSafeUploadFilename,
  isPrivateUpload,
  markPrivateUpload,
  unmarkPrivateUpload,
  extractLocalUploadFilenames,
};
}

const defaultDatabase = createDatabase();

module.exports = {
  ...defaultDatabase,
  createDatabase,
};
