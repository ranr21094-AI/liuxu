const fs = require('fs');
const path = require('path');
const { businessDateString, daysInMonth, parseDateParts, startOfWeekMonday } = require('./business-date');

const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'logs.json');
const DIARY_CATEGORY = '\u65e5\u8bb0';
const OTHER_CATEGORY = '\u5176\u4ed6';
const PRIVATE_UPLOADS_FILE = path.join(DATA_DIR, 'private-uploads.json');
const AI_CHATS_FILE = path.join(DATA_DIR, 'ai-chats.json');
const AI_SETTINGS_FILE = path.join(DATA_DIR, 'ai-settings.json');
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
  categories: null,
  privateUploads: null,
  aiChats: null,
  aiSettings: null,
  maxLogId: 0,
  maxTodoId: 0,
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
  const markdownImage = /!\[[^\]]*\]\(\s*<?\/uploads\/([^)\s>"'?#]+)(?:[?#][^)\s>"']*)?>?(?:\s+["'][^)]*["'])?\s*\)/gi;
  const htmlImage = /<img\b[^>]*\bsrc\s*=\s*["']\/uploads\/([^"'?#\s>]+)(?:[?#][^"']*)?["'][^>]*>/gi;
  for (const pattern of [markdownImage, htmlImage]) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const filename = normalizeUploadFilename(match[1]);
      if (filename) names.add(filename);
    }
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

function readLogs() {
  if (cache.logs !== null) return cache.logs;
  ensureDataDir();
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf-8');
    cache.logs = JSON.parse(raw);
    cache.maxLogId = cache.logs.length > 0 ? Math.max(...cache.logs.map(l => l.id)) : 0;
    return cache.logs;
  } catch (err) {
    console.error('Failed to parse logs.json:', err.message);
    cache.logs = [];
    cache.maxLogId = 0;
    return [];
  }
}

function writeLogs(logs) {
  ensureDataDir();
  cache.logs = logs;
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(logs, null, 2), 'utf-8');
  fs.renameSync(tmp, DATA_FILE);
}

function readPrivateUploads() {
  if (cache.privateUploads !== null) return cache.privateUploads;
  ensureDataDir();
  if (!fs.existsSync(PRIVATE_UPLOADS_FILE)) {
    cache.privateUploads = [];
    return cache.privateUploads;
  }
  try {
    const saved = JSON.parse(fs.readFileSync(PRIVATE_UPLOADS_FILE, 'utf-8'));
    cache.privateUploads = Array.isArray(saved)
      ? [...new Set(saved.filter(isSafeUploadFilename))]
      : [];
    return cache.privateUploads;
  } catch (err) {
    console.error('Failed to parse private-uploads.json:', err.message);
    cache.privateUploads = [];
    return cache.privateUploads;
  }
}

function writePrivateUploads(filenames) {
  ensureDataDir();
  cache.privateUploads = [...new Set(filenames.filter(isSafeUploadFilename))];
  const tmp = PRIVATE_UPLOADS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cache.privateUploads, null, 2), 'utf-8');
  fs.renameSync(tmp, PRIVATE_UPLOADS_FILE);
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
  };
}

function readAiChats() {
  if (cache.aiChats !== null) return cache.aiChats;
  ensureDataDir();
  if (!fs.existsSync(AI_CHATS_FILE)) {
    cache.aiChats = { conversations: [], activeConversationId: '' };
    return cache.aiChats;
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
    return cache.aiChats;
  } catch (err) {
    console.error('Failed to parse ai-chats.json:', err.message);
    cache.aiChats = { conversations: [], activeConversationId: '' };
    return cache.aiChats;
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
  cache.aiChats = { conversations, activeConversationId };
  const tmp = AI_CHATS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cache.aiChats, null, 2), 'utf-8');
  fs.renameSync(tmp, AI_CHATS_FILE);
  return cache.aiChats;
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
  const deniedSource = isPlainObject(policySource?.deniedSubcategories) ? policySource.deniedSubcategories : {};
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
    logAccessPolicy: policySource ? {
      allowedParents: Array.isArray(policySource.allowedParents)
        ? [...new Set(policySource.allowedParents
          .filter(parent => typeof parent === 'string')
          .map(parent => parent.trim().slice(0, 80))
          .filter(Boolean))]
        : [],
      deniedSubcategories,
    } : null,
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
  if (cache.aiSettings !== null) return cache.aiSettings;
  ensureDataDir();
  if (!fs.existsSync(AI_SETTINGS_FILE)) {
    cache.aiSettings = { ...DEFAULT_AI_SETTINGS };
    return cache.aiSettings;
  }
  try {
    cache.aiSettings = normalizeAiSettings(JSON.parse(fs.readFileSync(AI_SETTINGS_FILE, 'utf-8')));
    return cache.aiSettings;
  } catch (err) {
    console.error('Failed to parse ai-settings.json:', err.message);
    cache.aiSettings = { ...DEFAULT_AI_SETTINGS };
    return cache.aiSettings;
  }
}

function writeAiSettings(data) {
  ensureDataDir();
  cache.aiSettings = normalizeAiSettings(data);
  const tmp = AI_SETTINGS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cache.aiSettings, null, 2), 'utf-8');
  fs.renameSync(tmp, AI_SETTINGS_FILE);
  return cache.aiSettings;
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

function getAll(query = {}, diaryUnlocked = true) {
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

  // Sort: by date desc, sort_order asc, id desc
  logs.sort((a, b) => {
    const dateA = a.log_date || '';
    const dateB = b.log_date || '';
    if (dateA !== dateB) return dateB.localeCompare(dateA);
    if ((a.sort_order || 0) !== (b.sort_order || 0)) return (a.sort_order || 0) - (b.sort_order || 0);
    return b.id - a.id;
  });

  // Pagination
  const page = parseInt(query.page) || 1;
  const limit = parseInt(query.limit) || 50;
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

function readTodos() {
  if (cache.todos !== null) return cache.todos;
  ensureDataDir();
  if (!fs.existsSync(TODOS_FILE)) {
    fs.writeFileSync(TODOS_FILE, '[]', 'utf-8');
  }
  try {
    cache.todos = JSON.parse(fs.readFileSync(TODOS_FILE, 'utf-8'));
    cache.maxTodoId = cache.todos.length > 0 ? Math.max(...cache.todos.map(t => t.id)) : 0;
    return cache.todos;
  } catch (err) {
    console.error('Failed to parse todos.json:', err.message);
    cache.todos = [];
    cache.maxTodoId = 0;
    return [];
  }
}

function writeTodos(todos) {
  ensureDataDir();
  cache.todos = todos;
  const tmp = TODOS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(todos, null, 2), 'utf-8');
  fs.renameSync(tmp, TODOS_FILE);
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
    due_date: t.due_date || null,
  }));
}

function normalizeTodoPriority(priority) {
  const value = typeof priority === 'string' && priority ? priority : 'none';
  const legacy = { low: 'normal', high: 'important' };
  const normalized = legacy[value] || value;
  return ['none', 'normal', 'important', 'urgent'].includes(normalized) ? normalized : 'none';
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
    notes: typeof data.notes === 'string' ? data.notes : '',
    created_at: now,
  };
  todos.push(entry);
  writeTodos(todos);
  return entry;
}

function updateTodo(id, data) {
  const todos = readTodos();
  const index = todos.findIndex(t => t.id === id);
  if (index === -1) return null;

  const entry = todos[index];
  if (data.title !== undefined) entry.title = data.title;
  if (data.done !== undefined) entry.done = !!data.done;
  if (data.due_date !== undefined) entry.due_date = data.due_date;
  if (data.priority !== undefined) entry.priority = normalizeTodoPriority(data.priority);
  if (data.notes !== undefined) entry.notes = typeof data.notes === 'string' ? data.notes : '';

  writeTodos(todos);
  return {
    ...entry,
    notes: typeof entry.notes === 'string' ? entry.notes : '',
    priority: normalizeTodoPriority(entry.priority),
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
  if (cache.categories !== null) return cache.categories;
  ensureDataDir();
  if (!fs.existsSync(CATEGORIES_FILE)) {
    fs.writeFileSync(CATEGORIES_FILE, JSON.stringify(DEFAULT_CATEGORIES, null, 2), 'utf-8');
    cache.categories = DEFAULT_CATEGORIES;
    return cache.categories;
  }
  try {
    let cats = JSON.parse(fs.readFileSync(CATEGORIES_FILE, 'utf-8'));
    if (!Array.isArray(cats)) cats = [];
    const normalizedCats = migrateToTree(cats);
    if (JSON.stringify(normalizedCats) !== JSON.stringify(cats)) {
      cats = normalizedCats;
      writeCategories(cats);
    }
    cache.categories = cats;
    return cats;
  } catch (err) {
    console.error('Failed to parse categories.json:', err.message);
    cache.categories = [...DEFAULT_CATEGORIES];
    return cache.categories;
  }
}

function writeCategories(cats) {
  ensureDataDir();
  cache.categories = cats;
  const tmp = CATEGORIES_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cats, null, 2), 'utf-8');
  fs.renameSync(tmp, CATEGORIES_FILE);
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
    sub_log_counts: Object.fromEntries(
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
    categories: readCategories(),
    privateUploads: readPrivateUploads(),
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

    normalized.push({
      id,
      title: normalizeString(item.title, ''),
      content: normalizeString(item.content, ''),
      category: normalizeString(item.category, OTHER_CATEGORY) || OTHER_CATEGORY,
      hours,
      log_date: logDate,
      sort_order: sortOrder,
      created_at: normalizeString(item.created_at, now),
      updated_at: normalizeString(item.updated_at, normalizeString(item.created_at, now)),
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

    const notes = item.notes === undefined ? '' : item.notes;
    if (typeof notes !== 'string') return { error: `Invalid notes for todo id ${id}` };

    normalized.push({
      id,
      title: normalizeString(item.title, ''),
      done: item.done === undefined ? false : !!item.done,
      sort_order: sortOrder,
      due_date: dueDate,
      priority,
      notes,
      created_at: normalizeString(item.created_at, now),
    });
  }

  return { todos: normalized };
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

  const categories = normalizeCategoriesForRestore(data.categories);
  if (categories.error) return categories;

  const privateUploads = normalizePrivateUploadsForRestore(data.privateUploads);
  if (privateUploads.error) return privateUploads;

  return {
    logs: logs.logs,
    todos: todos.todos,
    categories: categories.categories,
    privateUploads: privateUploads.privateUploads,
  };
}

function restore(data, mode = 'replace') {
  if (!data || typeof data !== 'object') return { error: '无效的数据格式' };
  if (!Array.isArray(data.logs)) return { error: '缺少 logs 数据' };
  if (!Array.isArray(data.todos)) return { error: '缺少 todos 数据' };
  if (!Array.isArray(data.categories)) return { error: '缺少 categories 数据' };

  const normalized = normalizeRestoreData(data);
  if (normalized.error) return normalized;
  data = normalized;
  readLogs().filter(l => isDiaryCategory(l.category)).forEach(l => markPrivateUploadsFromContent(l.content));

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

    const existingCats = readCategories();
    // Normalize restore data to tree format
    const restoreCats = (data.categories.length > 0 && typeof data.categories[0] === 'string')
      ? migrateToTree(data.categories)
      : data.categories;
    const mergedCats = mergeCategoryTrees(existingCats, restoreCats);
    const mergedPrivateUploads = [...new Set([...readPrivateUploads(), ...data.privateUploads])];

    writeLogs(mergedLogs);
    writeTodos(mergedTodos);
    writeCategories(mergedCats);
    writePrivateUploads(mergedPrivateUploads);
    mergedLogs.filter(l => isDiaryCategory(l.category)).forEach(l => markPrivateUploadsFromContent(l.content));
    return { success: true, logs: mergedLogs.length, todos: mergedTodos.length, categories: mergedCats.length };
  }

  writeLogs(data.logs);
  writeTodos(data.todos);
  writeCategories((data.categories.length > 0 && typeof data.categories[0] === 'string')
    ? migrateToTree(data.categories)
    : data.categories);
  writePrivateUploads(data.privateUploads);
  data.logs.filter(l => isDiaryCategory(l.category)).forEach(l => markPrivateUploadsFromContent(l.content));
  return { success: true, logs: data.logs.length, todos: data.todos.length, categories: data.categories.length };
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

module.exports = { getAll, getById, create, update, remove, getStats, reorderLogs, getAllTodos, createTodo, updateTodo, removeTodo, removeCompletedTodos, reorderTodos, getAllCategories, addCategory, renameCategory, deleteCategory, reorderCategories, reorderSubcategories, setCategoryCalendarDayVisible, getAiChats: readAiChats, saveAiChats: writeAiChats, getAiSettings: readAiSettings, saveAiSettings: writeAiSettings, backup, restore, checkDataIntegrity, isDiaryCategory, isSafeUploadFilename, isPrivateUpload, markPrivateUpload, unmarkPrivateUpload, extractLocalUploadFilenames };
