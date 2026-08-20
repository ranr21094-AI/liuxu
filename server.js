require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const childProcess = require('child_process');
const { AsyncLocalStorage } = require('async_hooks');
const multer = require('multer');
const nodemailer = require('nodemailer');
const database = require('./database');
const { createAuthStore } = require('./auth-store');
const { BUSINESS_TIME_ZONE, businessDateString, weekdayIndex } = require('./business-date');
const { isPrivateIpLiteral, validateGeneratedImageUrl } = require('./lib/net/ssrf');
const { toolResult, toProviderTools, fromProviderName } = require('./lib/agent/tools');
const { parseMemorySettingsInput } = require('./lib/agent/memory-settings');
const { serviceFor: knowledgeServiceFor } = require('./lib/knowledge/routes');

const app = express();
app.set('trust proxy', 'loopback');
let todoReminderService = null;
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');

// AUTH_TOKEN is used only to bootstrap the first administrator.
const AUTH_TOKEN = process.env.AUTH_TOKEN || null;
const ALLOW_INSECURE_NO_AUTH = process.env.ALLOW_INSECURE_NO_AUTH === '1';
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';
const DEEPSEEK_BASE_URL = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
const DEEPSEEK_DEFAULT_MODEL = process.env.DEEPSEEK_DEFAULT_MODEL || 'deepseek-v4-flash';
const MOONSHOT_API_KEY = process.env.MOONSHOT_API_KEY || '';
const MOONSHOT_BASE_URL = (process.env.MOONSHOT_BASE_URL || 'https://api.moonshot.cn/v1').replace(/\/+$/, '');
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const TAVILY_API_KEY = process.env.TAVILY_API_KEY || '';
const TAVILY_BASE_URL = (process.env.TAVILY_BASE_URL || 'https://api.tavily.com').replace(/\/+$/, '');
const PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY || '';
const PERPLEXITY_BASE_URL = (process.env.PERPLEXITY_BASE_URL || 'https://api.perplexity.ai').replace(/\/+$/, '');
const SEEDREAM_API_KEY = process.env.SEEDREAM_API_KEY || '';
const SEEDREAM_BASE_URL = (process.env.SEEDREAM_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3').replace(/\/+$/, '');
const SEEDREAM_DEFAULT_MODEL = process.env.SEEDREAM_DEFAULT_MODEL || 'doubao-seedream-5-0-260128';
const WESTOCK_NPX_COMMAND = process.env.WESTOCK_NPX_COMMAND || 'npx -y westock-data-clawhub@1.0.4';
const QQ_EMAIL_ACCOUNT = process.env.QQ_EMAIL_ACCOUNT || '';
const QQ_EMAIL_AUTH_CODE = process.env.QQ_EMAIL_AUTH_CODE || '';
const AI_MODEL_PROFILES = Object.freeze({
  'deepseek-v4-flash': { provider: 'deepseek', name: 'DeepSeek Flash', inputModalities: ['text'], outputModalities: ['text'], contextLength: null, supportsMedia: false, preserveReasoning: false },
  'deepseek-v4-pro': { provider: 'deepseek', name: 'DeepSeek Pro', inputModalities: ['text'], outputModalities: ['text'], contextLength: null, supportsMedia: false, preserveReasoning: false },
  'kimi-k3': { provider: 'moonshot', name: 'Kimi K3', inputModalities: ['text', 'image', 'video'], outputModalities: ['text'], contextLength: null, supportsMedia: true, preserveReasoning: true, thinking: 'k3' },
  'kimi-k2.7-code': { provider: 'moonshot', name: 'Kimi K2.7 Code', inputModalities: ['text', 'image', 'video'], outputModalities: ['text'], contextLength: null, supportsMedia: true, preserveReasoning: true, thinking: 'fixed' },
  'kimi-k2.6': { provider: 'moonshot', name: 'Kimi K2.6', inputModalities: ['text', 'image', 'video'], outputModalities: ['text'], contextLength: null, supportsMedia: true, preserveReasoning: true, thinking: 'optional' },
});
const AI_ALLOWED_MODELS = new Set(Object.keys(AI_MODEL_PROFILES));
const AI_ALLOWED_THINKING = new Set(['enabled', 'disabled']);
const AI_ALLOWED_REASONING = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const AI_ALLOWED_REASONING_MODES = new Set(['default', 'disabled', 'effort']);
const OPENROUTER_MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,79}\/[a-z0-9][a-z0-9._:+-]{0,119}$/i;
const AI_ALLOWED_SEARCH_DEPTH = new Set(['basic', 'advanced']);
const SEEDREAM_ALLOWED_MODELS = new Set(['doubao-seedream-5-0-260128', 'doubao-seedream-4-5-251128', 'doubao-seedream-4-0-250828']);
const SEEDREAM_ALLOWED_SIZE_KEYWORDS = new Set(['2K', '3K', '4K']);
const OPENROUTER_MODELS_CACHE_TTL_MS = 10 * 60 * 1000;
const OPENROUTER_MODELS_STALE_TTL_MS = 24 * 60 * 60 * 1000;
const OPENROUTER_MODELS_MAX_BYTES = 8 * 1024 * 1024;
const MOONSHOT_FORMULA_URI = 'moonshot/web-search:latest';
const MOONSHOT_TOOL_CACHE_TTL_MS = 10 * 60 * 1000;
const MOONSHOT_TOOL_MAX_ROUNDS = 4;
const MOONSHOT_TOOL_MAX_CALLS = 6;
const MOONSHOT_TOOL_MAX_RESULT_CHARS = 2 * 1024 * 1024;
const WESTOCK_MAX_OUTPUT_CHARS = 60000;
const WESTOCK_TIMEOUT_MS = 60000;
const PERPLEXITY_MAX_QUERIES = 3;
const PERPLEXITY_MAX_QUERY_CHARS = 300;
const PERPLEXITY_MAX_OUTPUT_CHARS = 12000;
const WESTOCK_ALLOWED_TOOLS = new Set([
  'search', 'kline', 'minute', 'finance', 'profile', 'asfund', 'hkfund', 'usfund',
  'technical', 'chip', 'shareholder', 'dividend', 'etf', 'etf-holdings', 'etf-nav',
  'etf-company', 'etf-holders', 'etf-financial',
  'hot', 'board', 'calendar', 'ipo', 'exdiv', 'reserve', 'suspension',
  'lhb', 'blocktrade', 'margintrade', 'buyback',
]);
const WESTOCK_MARKET_TOOLS = new Set(['ipo', 'suspension']);
const WESTOCK_SYMBOL_TOOLS = new Set([
  'kline', 'minute', 'finance', 'profile', 'asfund', 'hkfund', 'usfund',
  'technical', 'chip', 'shareholder', 'dividend', 'etf', 'etf-holdings', 'etf-nav',
  'etf-company', 'etf-holders', 'etf-financial',
  'lhb', 'blocktrade', 'margintrade', 'buyback',
  'exdiv', 'reserve',
]);
const WESTOCK_ALLOWED_FLAGS = new Set([
  'period', 'limit', 'fq', 'days', 'num', 'type', 'date', 'group', 'start', 'end',
  'years', 'all', 'sector', 'country', 'indicator',
]);
const TODO_REMINDER_INTERVAL_MS = 60000;
const TODO_PRIORITY_RANK = { urgent: 0, important: 1, normal: 2, none: 3 };
const businessClockFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: BUSINESS_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

// Diary is always hidden; unlock by typing the magic phrase in the search box.
// The phrase is fixed in code and kept in sync with public/js/state.js.
const DIARY_MAGIC_PHRASE = '如意如意';
database.checkDataIntegrity();
database.resetCache();
const authStore = createAuthStore({
  dataDir: DATA_DIR,
  bootstrapPassword: AUTH_TOKEN || '',
  allowInsecureNoAuth: ALLOW_INSECURE_NO_AUTH,
});
const databaseContext = new AsyncLocalStorage();
const databaseInstances = new Map();
databaseInstances.set('legacy', database);

function userDataDirectory(user) {
  if (!user || user.storage_key === 'legacy') return DATA_DIR;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(user.storage_key || '')) {
    throw new Error('Invalid user storage key');
  }
  const accountsRoot = path.resolve(DATA_DIR, 'accounts');
  const target = path.resolve(accountsRoot, user.storage_key);
  if (!target.startsWith(accountsRoot + path.sep)) throw new Error('Invalid user data directory');
  return target;
}

function databaseForUser(user) {
  const storageKey = user?.storage_key || 'legacy';
  if (!databaseInstances.has(storageKey)) {
    databaseInstances.set(storageKey, database.createDatabase(userDataDirectory(user), { secretScope: storageKey }));
  }
  return databaseInstances.get(storageKey);
}

for (const storedUser of authStore.listStoredUsers()) databaseForUser(storedUser).getAiSettings();

function currentDatabase() {
  return databaseContext.getStore() || database;
}

const db = new Proxy(database, {
  get(_target, property) {
    const value = currentDatabase()[property];
    return typeof value === 'function' ? value.bind(currentDatabase()) : value;
  },
});

const diaryTokens = new Map(); // token -> { userId, createdAt }
const moonshotFormulaToolCache = new Map(); // key fingerprint -> { expiresAt, tools }
const openrouterModelCatalogCache = new Map(); // key fingerprint -> normalized user model catalog
const DIARY_TOKEN_TTL = 24 * 60 * 60 * 1000; // 24h
const DIARY_COOKIE_NAME = 'diary_session';
const SITE_COOKIE_NAME = 'site_session';

// Clean expired diary tokens every hour
const diaryTokenCleanup = setInterval(() => {
  const now = Date.now();
  for (const [t, entry] of diaryTokens) {
    if (now - entry.createdAt > DIARY_TOKEN_TTL) diaryTokens.delete(t);
  }
}, 3600000);
if (diaryTokenCleanup.unref) diaryTokenCleanup.unref();

function generateToken() {
  return crypto.randomBytes(24).toString('hex');
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

function getCookie(req, name) {
  const cookies = String(req.headers.cookie || '').split(';');
  for (const cookie of cookies) {
    const separator = cookie.indexOf('=');
    if (separator === -1) continue;
    const key = cookie.substring(0, separator).trim();
    if (key !== name) continue;
    try {
      return decodeURIComponent(cookie.substring(separator + 1).trim());
    } catch {
      return '';
    }
  }
  return '';
}

function getDiaryToken(req) {
  return getCookie(req, DIARY_COOKIE_NAME);
}

function diaryCookieOptions(req, token, maxAge) {
  const parts = [
    `${DIARY_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAge}`,
  ];
  // Only trust req.secure: Express gates forwarded headers behind app.set('trust proxy'),
  // so a client-injected X-Forwarded-Proto on a plain HTTP connection cannot force Secure.
  if (req.secure) parts.push('Secure');
  return parts.join('; ');
}

function setDiaryCookie(req, res, token) {
  res.setHeader('Set-Cookie', diaryCookieOptions(req, token, Math.floor(DIARY_TOKEN_TTL / 1000)));
}

function clearDiaryCookie(req, res) {
  res.setHeader('Set-Cookie', diaryCookieOptions(req, '', 0));
}

function parsePositiveId(value) {
  const text = String(value ?? '');
  if (!/^\d+$/.test(text)) return null;
  const id = Number(text);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function validateLogInput(body, { partial = false } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'JSON object required' };
  }
  const payload = {};
  if (!partial || body.title !== undefined) {
    if (typeof body.title !== 'string' || !body.title.trim() || body.title.length > 200) {
      return { error: 'Title must be a non-empty string of at most 200 characters' };
    }
    payload.title = body.title.trim();
  }
  if (!partial || body.content !== undefined) {
    if (typeof body.content !== 'string' || !body.content || body.content.length > 100000) {
      return { error: 'Content must be a non-empty string of at most 100000 characters' };
    }
    payload.content = body.content;
  }
  if (body.category !== undefined) {
    if (typeof body.category !== 'string' || !body.category.trim() || body.category.length > 160) {
      return { error: 'Category must be a non-empty string of at most 160 characters' };
    }
    payload.category = body.category.trim();
  } else if (!partial) {
    payload.category = '其他';
  }
  if (body.hours !== undefined && body.hours !== null && body.hours !== '') {
    const hours = Number(body.hours);
    if (!Number.isFinite(hours) || hours < 0 || hours > 24) {
      return { error: '工时需为 0-24 之间的数字' };
    }
    payload.hours = hours;
  } else if (!partial) {
    payload.hours = 0;
  }
  if (body.log_date !== undefined) {
    if (typeof body.log_date !== 'string' || (body.log_date && !isValidDate(body.log_date))) {
      return { error: '日期格式无效' };
    }
    payload.log_date = body.log_date;
  }
  if (body.pinned !== undefined) {
    if (typeof body.pinned !== 'boolean') {
      return { error: 'pinned must be a boolean' };
    }
    payload.pinned = body.pinned;
  }
  return { payload };
}

function validateTodoInput(body, { partial = false } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'JSON object required' };
  }
  const payload = {};
  if (!partial || body.title !== undefined) {
    if (typeof body.title !== 'string' || !body.title.trim() || body.title.length > 500) {
      return { error: 'Title must be a non-empty string of at most 500 characters' };
    }
    payload.title = body.title.trim();
  }
  if (body.done !== undefined) {
    if (typeof body.done !== 'boolean') return { error: 'done must be a boolean' };
    payload.done = body.done;
  }
  if (body.due_date !== undefined) {
    if (body.due_date !== null && (typeof body.due_date !== 'string' || (body.due_date && !isValidDate(body.due_date)))) {
      return { error: 'due_date must be null, empty, or a valid YYYY-MM-DD date' };
    }
    payload.due_date = body.due_date || null;
  }
  if (body.priority !== undefined) {
    if (!['none', 'normal', 'important', 'urgent', 'low', 'high'].includes(body.priority)) {
      return { error: 'Unsupported priority' };
    }
    payload.priority = body.priority;
  }
  if (body.recurrence !== undefined) {
    if (!['none', 'daily', 'weekly', 'monthly', 'yearly'].includes(body.recurrence)) {
      return { error: 'Unsupported recurrence' };
    }
    payload.recurrence = body.recurrence;
  }
  if (body.category !== undefined) {
    if (typeof body.category !== 'string' || !body.category.trim() || body.category.length > 24) {
      return { error: 'Category must be a non-empty string of at most 24 characters' };
    }
    payload.category = body.category.trim();
  }
  if (body.notes !== undefined) {
    if (typeof body.notes !== 'string' || body.notes.length > 5000) {
      return { error: 'Notes must be a string of at most 5000 characters' };
    }
    payload.notes = body.notes;
  }
  return { payload };
}

function validateCountdownInput(body, { partial = false } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'JSON object required' };
  }
  const payload = {};
  if (!partial || body.title !== undefined) {
    if (typeof body.title !== 'string' || !body.title.trim() || body.title.length > 200) {
      return { error: 'Title must be a non-empty string of at most 200 characters' };
    }
    payload.title = body.title.trim();
  }
  if (!partial || body.target_date !== undefined) {
    if (typeof body.target_date !== 'string' || !isValidDate(body.target_date)) {
      return { error: 'target_date must be a valid YYYY-MM-DD date' };
    }
    payload.target_date = body.target_date;
  }
  if (body.repeat_yearly !== undefined) {
    if (typeof body.repeat_yearly !== 'boolean') return { error: 'repeat_yearly must be a boolean' };
    payload.repeat_yearly = body.repeat_yearly;
  } else if (!partial) {
    payload.repeat_yearly = false;
  }
  if (body.notes !== undefined) {
    if (typeof body.notes !== 'string' || body.notes.length > 1000) {
      return { error: 'Notes must be a string of at most 1000 characters' };
    }
    payload.notes = body.notes;
  } else if (!partial) {
    payload.notes = '';
  }
  return { payload };
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 60000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (timer.unref) timer.unref();
  const externalSignal = options.signal;
  const abortFromExternal = () => controller.abort();
  externalSignal?.addEventListener('abort', abortFromExternal, { once: true });
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', abortFromExternal);
  }
}

async function readResponseTextWithLimit(response, maxBytes, errorMessage) {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new Error(errorMessage);
  }
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(errorMessage);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

function siteCookieOptions(req, token, maxAge) {
  const parts = [
    `${SITE_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAge}`,
  ];
  if (req.secure) parts.push('Secure');
  return parts.join('; ');
}

function setSiteCookie(req, res, token, expiresAt) {
  const maxAge = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
  res.setHeader('Set-Cookie', siteCookieOptions(req, token, maxAge));
}

function clearSiteCookie(req, res) {
  res.setHeader('Set-Cookie', siteCookieOptions(req, '', 0));
}

function getSiteSession(req) {
  if (authStore.disabled) return authStore.getSession('');
  const token = getCookie(req, SITE_COOKIE_NAME);
  return authStore.getSession(token);
}

function isValidDiaryToken(req, token) {
  if (!token) return false;
  const entry = diaryTokens.get(token);
  if (!entry || entry.userId !== req.user.id || Date.now() - entry.createdAt > DIARY_TOKEN_TTL) {
    diaryTokens.delete(token);
    return false;
  }
  return true;
}

function hasDiaryAccess(req) {
  return isValidDiaryToken(req, getDiaryToken(req));
}

function revokeDiaryTokensForUser(userId) {
  for (const [token, entry] of diaryTokens) {
    if (entry.userId === userId) diaryTokens.delete(token);
  }
}

function isDiaryCategory(category) {
  return db.isDiaryCategory(category);
}

function rejectLockedDiary(res) {
  return res.status(403).json({ error: 'Diary is locked' });
}

function logRequiresDiaryAccess(log) {
  return log && isDiaryCategory(log.category);
}

function restoreRequiresDiaryAccess(req) {
  return true;
}

function isDiaryRoot(category) {
  return category === '\u65e5\u8bb0';
}

function cleanCategorySegment(value) {
  if (typeof value !== 'string') return '';
  const name = value.trim();
  return name && name.length <= 80 && !name.includes('/') && !name.includes('\\') ? name : '';
}

function qqMailReady() {
  return Boolean(QQ_EMAIL_ACCOUNT && QQ_EMAIL_AUTH_CODE);
}

function getBusinessClockParts(date = new Date()) {
  const parts = {};
  for (const part of businessClockFormatter.formatToParts(date)) {
    if (part.type === 'year' || part.type === 'month' || part.type === 'day' || part.type === 'hour' || part.type === 'minute') {
      parts[part.type] = Number(part.value);
    }
  }
  const businessDate = `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
  const time = `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
  return { ...parts, businessDate, time };
}

function createTodoReminderTransporter() {
  return nodemailer.createTransport({
    host: 'smtp.qq.com',
    port: 465,
    secure: true,
    disableFileAccess: true,
    disableUrlAccess: true,
    auth: {
      user: QQ_EMAIL_ACCOUNT,
      pass: QQ_EMAIL_AUTH_CODE,
    },
  });
}

async function sendTodoReminderEmail({ from = QQ_EMAIL_ACCOUNT, to, subject, text, textEncoding = 'base64' }) {
  if (!qqMailReady()) throw new Error('QQ mail credentials are not configured');
  const transporter = createTodoReminderTransporter();
  await transporter.sendMail({
    from,
    to,
    subject,
    text,
    textEncoding,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
}

function todoReminderPriorityRank(priority) {
  return Object.prototype.hasOwnProperty.call(TODO_PRIORITY_RANK, priority)
    ? TODO_PRIORITY_RANK[priority]
    : TODO_PRIORITY_RANK.none;
}

function sortTodosForReminder(todos) {
  return todos
    .map((todo, index) => ({ todo, index }))
    .sort((a, b) => {
      const priorityDiff = todoReminderPriorityRank(a.todo.priority) - todoReminderPriorityRank(b.todo.priority);
      if (priorityDiff !== 0) return priorityDiff;
      return a.index - b.index;
    })
    .map(({ todo }) => ({
      id: todo.id,
      title: todo.title || '',
      category: todo.category || '\u5f85\u529e',
      priority: todo.priority || 'none',
      due_date: todo.due_date || '',
      notes: typeof todo.notes === 'string' ? todo.notes : '',
      sort_order: Number.isFinite(Number(todo.sort_order)) ? Number(todo.sort_order) : 0,
    }));
}

function getDueTodosForReminder(reminderDb, businessDate, { allOpen = false } = {}) {
  return reminderDb.getAllTodos({ status: 'pending' }).filter(todo => {
    if (todo.done) return false;
    return allOpen ? true : todo.due_date === businessDate;
  });
}

function buildTodoReminderMail({ businessDate, snapshot }) {
  const lines = [
    `日期: ${businessDate}`,
    `待办数: ${snapshot.length}`,
    '',
  ];
  snapshot.forEach((todo, index) => {
    const category = todo.category || '\u5f85\u529e';
    lines.push(`${index + 1}. [${category}] ${todo.title || '未命名任务'}`);
    lines.push(`截止日期: ${todo.due_date || businessDate}`);
    if (todo.notes) lines.push(`备注: ${todo.notes}`);
    lines.push('');
  });
  return {
    subject: `待办到期提醒 (${businessDate})`,
    text: lines.join('\n').trim(),
  };
}

function createTodoReminderEmailMessage({ to, businessDate, snapshot }) {
  const mail = buildTodoReminderMail({ businessDate, snapshot });
  return {
    from: QQ_EMAIL_ACCOUNT,
    to,
    subject: mail.subject,
    text: mail.text,
    textEncoding: 'base64',
  };
}

function getTodoReminderResponse() {
  const saved = db.getTodoReminderSettings();
  const state = db.getTodoReminderState();
  return {
    enabled: saved.enabled,
    recipientEmail: saved.recipientEmail || QQ_EMAIL_ACCOUNT,
    sendTime: saved.sendTime,
    mailReady: qqMailReady(),
    lastStatus: state.status,
    lastSentAt: state.sentAt || '',
    lastError: state.lastError || '',
  };
}

function createTodoReminderService({
  db: reminderDb = db,
  sendMail = sendTodoReminderEmail,
  mailReady = qqMailReady,
  now = () => new Date(),
  intervalMs = TODO_REMINDER_INTERVAL_MS,
} = {}) {
  let timer = null;
  let running = false;

  async function attemptSend(state, settings) {
    if (!mailReady()) {
      reminderDb.saveTodoReminderState({
        ...state,
        status: 'pending',
        lastError: 'QQ mail credentials are not configured',
      });
      return false;
    }
    try {
      const mail = createTodoReminderEmailMessage({
        to: settings.recipientEmail,
        businessDate: state.businessDate,
        snapshot: state.snapshot,
      });
      await sendMail(mail);
      reminderDb.saveTodoReminderState({
        ...state,
        status: 'sent',
        sentAt: new Date(now()).toISOString(),
        lastError: '',
      });
      return true;
    } catch (err) {
      reminderDb.saveTodoReminderState({
        ...state,
        status: 'pending',
        lastError: err.message || 'Failed to send todo reminder email',
      });
      return false;
    }
  }

  async function tick() {
    if (running) return false;
    running = true;
    try {
      const settings = reminderDb.getTodoReminderSettings();
      if (!settings.enabled || !settings.recipientEmail) return false;

      const currentNow = now();
      const current = getBusinessClockParts(currentNow);
      const state = reminderDb.getTodoReminderState();
      if (state.businessDate === current.businessDate) {
        if (state.status === 'pending' && Array.isArray(state.snapshot) && state.snapshot.length > 0) {
          return attemptSend(state, settings);
        }
        return false;
      }

      if (current.time < settings.sendTime) return false;

      const dueToday = getDueTodosForReminder(reminderDb, current.businessDate);
      const snapshot = sortTodosForReminder(dueToday);
      const nextState = {
        businessDate: current.businessDate,
        capturedAt: new Date(currentNow).toISOString(),
        status: snapshot.length ? 'pending' : 'empty',
        snapshot,
        sentAt: '',
        lastError: '',
      };
      reminderDb.saveTodoReminderState(nextState);
      if (!snapshot.length) return false;
      return attemptSend(nextState, settings);
    } finally {
      running = false;
    }
  }

  function start() {
    if (timer) return service;
    void tick();
    timer = setInterval(() => { void tick(); }, intervalMs);
    if (timer.unref) timer.unref();
    return service;
  }

  function stop() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  const service = {
    start,
    stop,
    tick,
  };
  return service;
}

function createTodoReminderCoordinator({ intervalMs = TODO_REMINDER_INTERVAL_MS } = {}) {
  const services = new Map();
  let timer = null;
  let running = false;

  function sync() {
    const activeUsers = authStore.listActiveUsers();
    const activeIds = new Set(activeUsers.map(user => user.id));
    for (const user of activeUsers) {
      if (!services.has(user.id)) {
        const userDb = databaseForUser(user);
        userDb.checkDataIntegrity();
        services.set(user.id, createTodoReminderService({ db: userDb }));
      }
    }
    for (const userId of services.keys()) {
      if (!activeIds.has(userId)) services.delete(userId);
    }
    return services.size;
  }

  async function tick() {
    if (running) return false;
    running = true;
    try {
      sync();
      await Promise.all([...services.values()].map(service => service.tick()));
      return true;
    } finally {
      running = false;
    }
  }

  function start() {
    if (timer) return coordinator;
    void tick();
    timer = setInterval(() => { void tick(); }, intervalMs);
    if (timer.unref) timer.unref();
    return coordinator;
  }

  function stop() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  const coordinator = { sync, tick, start, stop };
  return coordinator;
}

function rateLimiter(maxAttempts, windowMs) {
  const entries = new Map();
  return (req, res, next) => {
    const key = req.ip || '127.0.0.1';
    const now = Date.now();
    if (entries.size > 10000) {
      for (const [candidate, value] of entries) {
        if (now > value.resetAt) entries.delete(candidate);
      }
    }
    let entry = entries.get(key);
    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs };
      entries.set(key, entry);
    }
    entry.count++;
    if (entry.count > maxAttempts) {
      return res.status(429).json({ error: '请求过于频繁，请稍后再试' });
    }
    next();
  };
}

function authMiddleware(req, res, next) {
  const siteToken = getCookie(req, SITE_COOKIE_NAME);
  const authenticated = getSiteSession(req);
  const isAppPage = req.path === '/' || req.path === '/index.html';
  const protectedPath = isAppPage || req.path.startsWith('/api/') || req.path.startsWith('/uploads/');
  if (!authenticated) {
    if (!protectedPath) return next();
    if (isAppPage) {
      return res.redirect(302, `/login?next=${encodeURIComponent(req.originalUrl || '/')}`);
    }
    return res.status(401).json({ error: 'Unauthorized' });
  }

  req.user = authenticated.user;
  req.siteToken = siteToken;
  const passwordChangeAllowed = ['/api/auth/me', '/api/auth/password', '/api/auth/logout'].includes(req.path);
  if (req.user.must_change_password && !passwordChangeAllowed) {
    if (isAppPage) return res.redirect(302, '/login?change=1');
    if (req.path.startsWith('/api/') || req.path.startsWith('/uploads/')) {
      return res.status(403).json({ error: 'Password change required', code: 'PASSWORD_CHANGE_REQUIRED' });
    }
  }
  return databaseContext.run(databaseForUser(req.user), next);
}

function concurrencyLimiter(maxConcurrent, keyFn = () => 'global') {
  const buckets = new Map();
  return (req, res, next) => {
    const key = keyFn(req);
    let state = buckets.get(key);
    if (!state) {
      state = { active: 0 };
      buckets.set(key, state);
    }
    if (state.active >= maxConcurrent) {
      return res.status(503).json({ error: '服务繁忙，请稍后再试' });
    }
    state.active += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      state.active = Math.max(0, state.active - 1);
    };
    res.once('finish', release);
    res.once('close', release);
    next();
  };
}

// Security headers
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self'");
  next();
});

app.use(express.json({ limit: '2mb' }));

app.get('/favicon.ico', (_req, res) => res.status(204).end());

app.get('/login', (req, res) => {
  const authenticated = getSiteSession(req);
  if (authenticated && !authenticated.user.must_change_password) return res.redirect(302, '/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/api/auth/login', rateLimiter(5, 15 * 60 * 1000), (req, res) => {
  const username = typeof req.body?.username === 'string' ? req.body.username : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const user = authStore.authenticate(username, password);
  if (!user) return res.status(401).json({ error: '用户名或密码错误' });
  const session = authStore.createSession(user.id);
  if (session.token) setSiteCookie(req, res, session.token, session.expires_at);
  res.json({ authenticated: true, must_change_password: user.must_change_password === true, user: authStore.publicUser(user) });
});

app.get('/api/auth/check', (req, res) => {
  const authenticated = getSiteSession(req);
  res.json({
    authenticated: Boolean(authenticated),
    must_change_password: authenticated?.user?.must_change_password === true,
    user: authenticated ? authStore.publicUser(authenticated.user) : null,
  });
});

app.use(authMiddleware);

app.get(['/', '/index.html'], (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use(express.static(path.join(__dirname, 'public'), { index: false }));

app.use('/api/ai', rateLimiter(60, 60 * 1000));
app.use('/api/ai', concurrencyLimiter(4, req => req.user?.id || 'anon'));
app.use('/api/upload', rateLimiter(20, 60 * 1000));

// Image upload setup
function currentUploadsDirectory() {
  return path.join(currentDatabase().dataDir, 'uploads');
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    const directory = currentUploadsDirectory();
    fs.mkdirSync(directory, { recursive: true });
    cb(null, directory);
  },
  filename: (_req, _file, cb) => {
    const ext = path.extname(_file.originalname).toLowerCase();
    const name = Date.now() + '-' + crypto.randomBytes(6).toString('hex') + ext;
    cb(null, name);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 1,
    fields: 2,
    parts: 3,
    fieldNameSize: 64,
    fieldSize: 64,
  },
  fileFilter: (_req, _file, cb) => {
    const allowed = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'];
    const ext = path.extname(_file.originalname).toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only PNG, JPG, GIF, WebP, and BMP images are supported'));
    }
  },
});

function uploadedImageMatchesExtension(file) {
  const ext = path.extname(file.filename).toLowerCase();
  const header = Buffer.alloc(16);
  const fd = fs.openSync(file.path, 'r');
  let bytesRead = 0;
  try {
    bytesRead = fs.readSync(fd, header, 0, header.length, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (bytesRead < 2) return false;
  if (ext === '.png') return header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (ext === '.jpg' || ext === '.jpeg') return header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
  if (ext === '.gif') return header.subarray(0, 6).toString('ascii') === 'GIF87a' || header.subarray(0, 6).toString('ascii') === 'GIF89a';
  if (ext === '.webp') return header.subarray(0, 4).toString('ascii') === 'RIFF' && header.subarray(8, 12).toString('ascii') === 'WEBP';
  if (ext === '.bmp') return header.subarray(0, 2).toString('ascii') === 'BM';
  return false;
}

app.post('/api/auth/logout', (req, res) => {
  authStore.revokeSession(req.siteToken);
  const diaryToken = getDiaryToken(req);
  if (diaryToken) diaryTokens.delete(diaryToken);
  clearSiteCookie(req, res);
  res.append('Set-Cookie', diaryCookieOptions(req, '', 0));
  res.json({ success: true });
});

app.get('/api/auth/me', (req, res) => {
  res.json(authStore.publicUser(req.user));
});

app.patch('/api/auth/me', (req, res) => {
  const result = authStore.updateProfile(req.user.id, req.body?.display_name);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result.user);
});

app.put('/api/auth/password', (req, res) => {
  const result = authStore.changePassword(req.user.id, req.body?.current_password, req.body?.new_password);
  if (result.error) return res.status(400).json({ error: result.error });
  revokeDiaryTokensForUser(req.user.id);
  const session = authStore.createSession(req.user.id);
  if (session.token) setSiteCookie(req, res, session.token, session.expires_at);
  res.json({ success: true, user: result.user });
});

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Administrator access required' });
  next();
}

app.get('/api/admin/users', requireAdmin, (_req, res) => {
  res.json(authStore.listUsers());
});

app.post('/api/admin/users', requireAdmin, (req, res) => {
  const result = authStore.createUser(req.body);
  if (result.error) return res.status(400).json({ error: result.error });
  const user = authStore.getUserById(result.user.id);
  databaseForUser(user).checkDataIntegrity();
  todoReminderService?.sync?.();
  res.status(201).json(result.user);
});

app.patch('/api/admin/users/:id', requireAdmin, (req, res) => {
  const result = authStore.updateUser(req.params.id, req.body || {});
  if (result.error) return res.status(400).json({ error: result.error });
  if (result.user.status === 'disabled') revokeDiaryTokensForUser(result.user.id);
  todoReminderService?.sync?.();
  res.json(result.user);
});

app.post('/api/admin/users/:id/reset-password', requireAdmin, (req, res) => {
  const result = authStore.resetPassword(req.params.id, req.body?.temporary_password);
  if (result.error) return res.status(400).json({ error: result.error });
  revokeDiaryTokensForUser(result.user.id);
  res.json(result.user);
});

// Diary unlock — the magic phrase replaces the old per-account password. The
// limit is generous so unlock/lock toggling via the search box never trips it.
app.post('/api/auth/diary', rateLimiter(20, 15 * 60 * 1000), (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: '请输入密码' });
  if (typeof password === 'string' && password.trim() === DIARY_MAGIC_PHRASE) {
    const token = generateToken();
    diaryTokens.set(token, { userId: req.user.id, createdAt: Date.now() });
    setDiaryCookie(req, res, token);
    return res.json({ unlocked: true });
  }
  res.status(403).json({ unlocked: false, error: '密码错误' });
});

// Diary lock
app.post('/api/auth/diary/lock', (req, res) => {
  const token = getDiaryToken(req);
  if (token) diaryTokens.delete(token);
  clearDiaryCookie(req, res);
  res.json({ locked: true });
});

// Diary status — diary protection is always enabled now.
app.get('/api/auth/diary/status', (req, res) => {
  const token = getDiaryToken(req);
  res.json({ enabled: true, locked: !token || !isValidDiaryToken(req, token) });
});





function normalizeOpenRouterReasoningDetailsInput(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 128 || value.some(item => !item || typeof item !== 'object' || Array.isArray(item))) {
    throw new Error('Invalid OpenRouter reasoning details');
  }
  let serialized = '';
  try { serialized = JSON.stringify(value); } catch {}
  if (!serialized || Buffer.byteLength(serialized, 'utf8') > 1024 * 1024) {
    throw new Error('Invalid OpenRouter reasoning details');
  }
  return JSON.parse(serialized);
}















function safeDeepSeekError(status, data) {
  const parts = [];
  const error = data && typeof data === 'object' ? data.error : null;
  if (error && typeof error === 'object') {
    if (typeof error.message === 'string') parts.push(error.message);
    if (typeof error.code === 'string') parts.push(error.code);
    if (typeof error.type === 'string') parts.push(error.type);
  } else if (typeof error === 'string') {
    parts.push(error);
  }
  if (typeof data?.message === 'string') parts.push(data.message);

  const detail = parts
    .join(' ')
    .replace(/sk-[A-Za-z0-9_-]+/g, 'sk-***')
    .slice(0, 240)
    .trim();
  return detail
    ? `DeepSeek request failed (${status}): ${detail}`
    : `DeepSeek request failed (${status})`;
}

function sanitizeProviderText(value, maxLength = 240) {
  return String(value || '')
    .replace(/sk-[A-Za-z0-9_-]+/g, 'sk-***')
    .replace(/tvly-[A-Za-z0-9_-]+/g, 'tvly-***')
    .replace(/pplx-[A-Za-z0-9_-]+/g, 'pplx-***')
    .slice(0, maxLength)
    .trim();
}

function sanitizeToolText(value, maxLength = 1000) {
  return String(value || '')
    .replace(/sk-[A-Za-z0-9_-]+/g, 'sk-***')
    .replace(/tvly-[A-Za-z0-9_-]+/g, 'tvly-***')
    .replace(/pplx-[A-Za-z0-9_-]+/g, 'pplx-***')
    .replace(/[A-Za-z]:\\[^\s"'<>|]+/g, '[local-path]')
    .replace(/\bat .+\(.+:\d+:\d+\)/g, '')
    .replace(/\s+npx\s+-y\s+westock-data-clawhub@[^\s]+/g, ' westock')
    .slice(0, maxLength)
    .trim();
}

function safeTavilyError(status, data) {
  const detail = sanitizeProviderText(data?.error || data?.message || data?.detail || '', 240);
  return detail
    ? `Tavily request failed (${status}): ${detail}`
    : `Tavily request failed (${status})`;
}

function nextStoredSecret(body, field, current) {
  if (body?.clearApiKeys === true) return '';
  const value = body?.[field];
  if (typeof value !== 'string' || !value.trim()) return current || '';
  return value.trim().slice(0, 500);
}

function aiProviderLabel(provider) {
  if (provider === 'moonshot') return 'Kimi';
  if (provider === 'openrouter') return 'OpenRouter';
  return 'DeepSeek';
}

function safeAiProviderError(provider, status, data) {
  if (provider === 'deepseek') return safeDeepSeekError(status, data);
  if (provider === 'openrouter') return safeOpenRouterError(status, data);
  const detail = sanitizeProviderText(data?.error?.message || data?.error || data?.message || '', 240);
  return detail
    ? `Kimi request failed (${status}): ${detail}`
    : `Kimi request failed (${status})`;
}

function aiProviderChatUrl(options) {
  return `${options.baseUrl}/chat/completions`;
}

function apiKeyFingerprint(apiKey) {
  return crypto.createHash('sha256').update(String(apiKey || '')).digest('hex');
}

function openrouterApiKeyForUser(settings, user, override = '') {
  return override || settings?.openrouterApiKey || serverAiSecretForUser(user, OPENROUTER_API_KEY);
}

function millionTokenPrice(value) {
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 ? Number((amount * 1000000).toPrecision(8)) : null;
}

function normalizeOpenRouterReasoning(value, supportedParameters = []) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const hasEffortDeclaration = Object.prototype.hasOwnProperty.call(source, 'supported_efforts');
  const supportedEfforts = source.supported_efforts === null
    ? [...AI_ALLOWED_REASONING]
    : Array.isArray(source.supported_efforts)
      ? source.supported_efforts.filter(item => AI_ALLOWED_REASONING.has(item))
      : [];
  return {
    supported: supportedParameters.includes('reasoning') || hasEffortDeclaration || source.mandatory === true,
    supportedEfforts: [...new Set(supportedEfforts)],
    defaultEffort: AI_ALLOWED_REASONING.has(source.default_effort) ? source.default_effort : null,
    defaultEnabled: typeof source.default_enabled === 'boolean' ? source.default_enabled : null,
    mandatory: source.mandatory === true,
  };
}

function normalizeOpenRouterModel(item) {
  if (!item || typeof item !== 'object' || !OPENROUTER_MODEL_ID_PATTERN.test(item.id || '')) return null;
  const architecture = item.architecture && typeof item.architecture === 'object' ? item.architecture : {};
  const inputModalities = Array.isArray(architecture.input_modalities)
    ? [...new Set(architecture.input_modalities.filter(value => typeof value === 'string').map(value => value.toLowerCase()))]
    : [];
  const outputModalities = Array.isArray(architecture.output_modalities)
    ? [...new Set(architecture.output_modalities.filter(value => typeof value === 'string').map(value => value.toLowerCase()))]
    : [];
  if (!inputModalities.includes('text') || !outputModalities.includes('text')) return null;
  const supportedParameters = Array.isArray(item.supported_parameters)
    ? [...new Set(item.supported_parameters.filter(value => typeof value === 'string').map(value => value.slice(0, 80)))]
    : [];
  const contextLength = Number(item.context_length);
  return {
    id: item.id,
    name: typeof item.name === 'string' && item.name.trim() ? item.name.trim().slice(0, 160) : item.id,
    source: 'openrouter',
    provider: item.id.split('/')[0],
    contextLength: Number.isSafeInteger(contextLength) && contextLength > 0 ? contextLength : null,
    inputModalities,
    outputModalities,
    supportedParameters,
    reasoning: normalizeOpenRouterReasoning(item.reasoning, supportedParameters),
    pricing: {
      inputPerMillion: millionTokenPrice(item.pricing?.prompt),
      outputPerMillion: millionTokenPrice(item.pricing?.completion),
      image: Number.isFinite(Number(item.pricing?.image)) ? Number(item.pricing.image) : null,
      request: Number.isFinite(Number(item.pricing?.request)) ? Number(item.pricing.request) : null,
    },
  };
}

function directAiModelRecords() {
  return Object.entries(AI_MODEL_PROFILES).map(([id, profile]) => {
    let reasoning = { supported: true, supportedEfforts: ['high', 'max'], defaultEffort: 'high', defaultEnabled: true, mandatory: false };
    if (profile.thinking === 'k3') reasoning = { supported: true, supportedEfforts: ['max'], defaultEffort: 'max', defaultEnabled: true, mandatory: true };
    if (profile.thinking === 'fixed') reasoning = { supported: true, supportedEfforts: [], defaultEffort: null, defaultEnabled: true, mandatory: true };
    if (profile.thinking === 'optional') reasoning = { supported: true, supportedEfforts: [], defaultEffort: null, defaultEnabled: true, mandatory: false };
    return {
      id,
      name: profile.name,
      source: 'direct',
      provider: profile.provider,
      contextLength: profile.contextLength,
      inputModalities: profile.inputModalities,
      outputModalities: profile.outputModalities,
      supportedParameters: [],
      reasoning,
      pricing: { inputPerMillion: null, outputPerMillion: null, image: null, request: null },
    };
  });
}

function safeOpenRouterError(status, data) {
  const detail = sanitizeProviderText(data?.error?.message || data?.error || data?.message || '', 240);
  return detail ? `OpenRouter request failed (${status}): ${detail}` : `OpenRouter request failed (${status})`;
}

async function fetchOpenRouterModelCatalog(apiKey, signal) {
  let response;
  try {
    response = await fetchWithTimeout(`${OPENROUTER_BASE_URL}/models/user`, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Accept': 'application/json',
        'X-Title': 'Work Log',
      },
      signal,
    }, 20000);
  } catch (error) {
    if (signal?.aborted) throw error;
    const wrapped = new Error('OpenRouter model catalog is temporarily unavailable');
    wrapped.status = 503;
    throw wrapped;
  }
  const text = await readResponseTextWithLimit(response, OPENROUTER_MODELS_MAX_BYTES, 'OpenRouter model catalog exceeded the safe size limit');
  let data = {};
  try { data = JSON.parse(text); } catch {}
  if (!response.ok) {
    const error = new Error(safeOpenRouterError(response.status, data));
    error.status = response.status === 401 || response.status === 403 ? 400 : 503;
    throw error;
  }
  const models = Array.isArray(data?.data) ? data.data.map(normalizeOpenRouterModel).filter(Boolean) : [];
  if (!models.length) {
    const error = new Error('OpenRouter returned no compatible text models for this account');
    error.status = 503;
    throw error;
  }
  return models;
}

async function getOpenRouterModelCatalogResult(apiKey, { signal, force = false } = {}) {
  if (!apiKey) {
    const error = new Error('OpenRouter API key is not configured');
    error.status = 503;
    throw error;
  }
  const fingerprint = apiKeyFingerprint(apiKey);
  const now = Date.now();
  const cached = openrouterModelCatalogCache.get(fingerprint);
  if (!force && cached?.freshUntil > now) {
    return { models: cached.models, source: 'cache', fetchedAt: cached.fetchedAt };
  }
  try {
    const models = await fetchOpenRouterModelCatalog(apiKey, signal);
    const fetchedAt = Date.now();
    openrouterModelCatalogCache.set(fingerprint, {
      models,
      fetchedAt,
      freshUntil: fetchedAt + OPENROUTER_MODELS_CACHE_TTL_MS,
      staleUntil: fetchedAt + OPENROUTER_MODELS_STALE_TTL_MS,
    });
    return { models, source: 'network', fetchedAt };
  } catch (error) {
    if (cached?.staleUntil > now) {
      return { models: cached.models, source: 'stale', fetchedAt: cached.fetchedAt };
    }
    throw error;
  }
}

async function getOpenRouterModelCatalog(apiKey, options = {}) {
  return (await getOpenRouterModelCatalogResult(apiKey, options)).models;
}

async function resolveAiModelProfile(model, apiKey, signal) {
  if (AI_MODEL_PROFILES[model]) return AI_MODEL_PROFILES[model];
  if (!OPENROUTER_MODEL_ID_PATTERN.test(model || '')) {
    const error = new Error('Unsupported AI model');
    error.status = 400;
    throw error;
  }
  const models = await getOpenRouterModelCatalog(apiKey, { signal });
  const catalogModel = models.find(item => item.id === model);
  if (!catalogModel) {
    const error = new Error('The selected OpenRouter model is unavailable for this account');
    error.status = 400;
    throw error;
  }
  return {
    provider: 'openrouter',
    name: catalogModel.name,
    supportsMedia: catalogModel.inputModalities.includes('image') || catalogModel.inputModalities.includes('video'),
    preserveReasoning: catalogModel.reasoning.supported,
    inputModalities: catalogModel.inputModalities,
    outputModalities: catalogModel.outputModalities,
    contextLength: catalogModel.contextLength,
    supportedParameters: catalogModel.supportedParameters,
    reasoning: catalogModel.reasoning,
    catalogModel,
  };
}

function validateReasoningSelection(profile, mode, effort) {
  if (!AI_ALLOWED_REASONING_MODES.has(mode)) throw new Error('Unsupported reasoning mode');
  if (!AI_ALLOWED_REASONING.has(effort)) throw new Error('Unsupported reasoning effort');
  if (profile.provider !== 'openrouter') return;
  const reasoning = profile.reasoning || {};
  if (mode === 'disabled' && (!reasoning.supported || reasoning.mandatory)) {
    throw new Error(reasoning.mandatory
      ? 'The selected model requires reasoning and cannot disable it'
      : 'The selected model only supports its default reasoning behavior');
  }
  if (mode === 'effort') {
    if (!reasoning.supported || !reasoning.supportedEfforts?.length) {
      throw new Error('The selected model only supports its default reasoning behavior');
    }
    if (!reasoning.supportedEfforts.includes(effort)) {
      throw new Error('The selected model does not support this reasoning effort');
    }
  }
}

function parseAiSettingsInput(body, current = {}) {
  const model = body?.model ?? current.model ?? 'deepseek-v4-flash';
  const reasoningEffort = body?.reasoningEffort ?? current.reasoningEffort ?? 'high';
  const reasoningMode = body?.reasoningMode ?? current.reasoningMode ?? 'effort';
  const thinkingMode = body?.thinkingMode ?? current.thinkingMode ?? 'enabled';
  const webSearchEnabled = body?.webSearchEnabled === undefined ? Boolean(current.webSearchEnabled) : body.webSearchEnabled;
  const kimiWebSearchEnabled = body?.kimiWebSearchEnabled === undefined ? Boolean(current.kimiWebSearchEnabled) : body.kimiWebSearchEnabled;
  const openrouterZdrEnabled = body?.openrouterZdrEnabled === undefined
    ? current.openrouterZdrEnabled !== false
    : body.openrouterZdrEnabled;
  const webSearchDepth = body?.webSearchDepth ?? current.webSearchDepth ?? 'basic';
  const seedreamModel = body?.seedreamModel ?? current.seedreamModel ?? SEEDREAM_DEFAULT_MODEL;
  const seedreamSize = body?.seedreamSize ?? current.seedreamSize ?? '2K';
  const seedreamWatermark = body?.seedreamWatermark === undefined ? current.seedreamWatermark !== false : body.seedreamWatermark;
  if (!AI_ALLOWED_MODELS.has(model) && !OPENROUTER_MODEL_ID_PATTERN.test(model)) {
    throw new Error('Unsupported AI model');
  }
  if (!AI_ALLOWED_REASONING.has(reasoningEffort)) {
    throw new Error('Unsupported reasoning effort');
  }
  if (!AI_ALLOWED_REASONING_MODES.has(reasoningMode)) {
    throw new Error('Unsupported reasoning mode');
  }
  if (!AI_ALLOWED_THINKING.has(thinkingMode)) {
    throw new Error('Unsupported thinking mode');
  }
  if (typeof webSearchEnabled !== 'boolean') {
    throw new Error('Unsupported web search option');
  }
  if (typeof kimiWebSearchEnabled !== 'boolean') {
    throw new Error('Unsupported Kimi web search option');
  }
  if (typeof openrouterZdrEnabled !== 'boolean') {
    throw new Error('Unsupported OpenRouter ZDR option');
  }
  if (!AI_ALLOWED_SEARCH_DEPTH.has(webSearchDepth)) {
    throw new Error('Unsupported web search depth');
  }
  if (!SEEDREAM_ALLOWED_MODELS.has(seedreamModel)) {
    throw new Error('Unsupported Seedream model');
  }
  if (!isValidSeedreamSize(seedreamSize)) {
    throw new Error('Unsupported Seedream size');
  }
  if (typeof seedreamWatermark !== 'boolean') {
    throw new Error('Unsupported Seedream watermark option');
  }
  const skillSource = body?.skills && typeof body.skills === 'object' && !Array.isArray(body.skills)
    ? body.skills
    : (current.skills || {});
  const westockSource = skillSource.westock && typeof skillSource.westock === 'object' && !Array.isArray(skillSource.westock)
    ? skillSource.westock
    : {};
  const perplexitySource = skillSource.perplexity && typeof skillSource.perplexity === 'object' && !Array.isArray(skillSource.perplexity)
    ? skillSource.perplexity
    : {};
  if (westockSource.enabled !== undefined && typeof westockSource.enabled !== 'boolean') {
    throw new Error('Unsupported WeStock skill option');
  }
  if (perplexitySource.enabled !== undefined && typeof perplexitySource.enabled !== 'boolean') {
    throw new Error('Unsupported Perplexity skill option');
  }
  const agentMaxRounds = parseAgentMaxRoundsInput(body?.agentMaxRounds, current.agentMaxRounds);
  const agentFileReadMaxMb = parseAgentFileReadMaxMbInput(body?.agentFileReadMaxMb, current.agentFileReadMaxMb);
  const memorySettings = parseMemorySettingsInput(body, current);
  return {
    apiKey: nextStoredSecret(body, 'apiKey', current.apiKey),
    moonshotApiKey: nextStoredSecret(body, 'moonshotApiKey', current.moonshotApiKey),
    openrouterApiKey: nextStoredSecret(body, 'openrouterApiKey', current.openrouterApiKey),
    model,
    reasoningEffort,
    reasoningMode,
    thinkingMode,
    tavilyApiKey: nextStoredSecret(body, 'tavilyApiKey', current.tavilyApiKey),
    perplexityApiKey: nextStoredSecret(body, 'perplexityApiKey', current.perplexityApiKey),
    webSearchEnabled,
    kimiWebSearchEnabled,
    openrouterZdrEnabled,
    webSearchDepth,
    seedreamApiKey: nextStoredSecret(body, 'seedreamApiKey', current.seedreamApiKey),
    seedreamModel,
    seedreamSize,
    seedreamWatermark,
    skills: {
      westock: { enabled: westockSource.enabled !== false },
      perplexity: { enabled: perplexitySource.enabled !== false },
    },
    agentMaxRounds,
    agentFileReadMaxMb,
    ...memorySettings,
  };
}

function parseAgentMaxRoundsInput(value, fallback) {
  if (value === undefined || value === null || value === '') {
    const n = Number(fallback);
    return Number.isFinite(n) ? Math.max(4, Math.round(n)) : 12;
  }
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 4) {
    throw new Error('Unsupported agent max rounds option');
  }
  return n;
}

function parseAgentFileReadMaxMbInput(value, fallback) {
  if (value === undefined || value === null || value === '') {
    const n = Number(fallback);
    return Number.isFinite(n) ? Math.max(1, Math.round(n)) : 4;
  }
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
    throw new Error('Unsupported agent file read limit option');
  }
  return n;
}

function serverAiSecretForUser(user, secret) {
  return user?.storage_key === 'legacy' ? secret : '';
}

function publicAiSettings(settings, user) {
  const {
    stream: _stream,
    userProfile: _userProfile,
    logContextEnabled: _logContextEnabled,
    diaryContextEnabled: _diaryContextEnabled,
    logAccessPolicy: _logAccessPolicy,
    ...rest
  } = settings;
  return {
    ...rest,
    apiKey: '',
    moonshotApiKey: '',
    openrouterApiKey: '',
    tavilyApiKey: '',
    perplexityApiKey: '',
    seedreamApiKey: '',
    apiKeyConfigured: Boolean(settings.apiKey || serverAiSecretForUser(user, DEEPSEEK_API_KEY)),
    moonshotApiKeyConfigured: Boolean(settings.moonshotApiKey || serverAiSecretForUser(user, MOONSHOT_API_KEY)),
    openrouterApiKeyConfigured: Boolean(settings.openrouterApiKey || serverAiSecretForUser(user, OPENROUTER_API_KEY)),
    tavilyApiKeyConfigured: Boolean(settings.tavilyApiKey || serverAiSecretForUser(user, TAVILY_API_KEY)),
    perplexityApiKeyConfigured: Boolean(settings.perplexityApiKey || serverAiSecretForUser(user, PERPLEXITY_API_KEY)),
    seedreamApiKeyConfigured: Boolean(settings.seedreamApiKey || serverAiSecretForUser(user, SEEDREAM_API_KEY)),
  };
}







function isValidSeedreamSize(size) {
  if (typeof size !== 'string') return false;
  const value = size.trim();
  if (SEEDREAM_ALLOWED_SIZE_KEYWORDS.has(value)) return true;
  const match = /^(\d{3,5})x(\d{3,5})$/i.exec(value);
  if (!match) return false;
  const width = Number(match[1]);
  const height = Number(match[2]);
  const pixels = width * height;
  return width >= 512 && height >= 512 && pixels >= 921600 && pixels <= 16777216;
}

function safeSeedreamError(status, data) {
  const detail = sanitizeProviderText(data?.error?.message || data?.error || data?.message || '', 240);
  return detail
    ? `Seedream request failed (${status}): ${detail}`
    : `Seedream request failed (${status})`;
}

function resolveSeedreamOptions(body, user) {
  const saved = db.getAiSettings();
  const model = body?.model || saved.seedreamModel || SEEDREAM_DEFAULT_MODEL;
  const size = body?.size || saved.seedreamSize || '2K';
  const watermark = body?.watermark === undefined ? saved.seedreamWatermark !== false : body.watermark;
  if (!SEEDREAM_ALLOWED_MODELS.has(model)) {
    throw new Error('Unsupported Seedream model');
  }
  if (!isValidSeedreamSize(size)) {
    throw new Error('Unsupported Seedream size');
  }
  if (typeof watermark !== 'boolean') {
    throw new Error('Unsupported Seedream watermark option');
  }
  return {
    apiKey: saved.seedreamApiKey || serverAiSecretForUser(user, SEEDREAM_API_KEY),
    model,
    size,
    watermark,
  };
}

function extensionFromContentType(contentType, fallbackUrl = '') {
  if (/image\/png/i.test(contentType)) return '.png';
  if (/image\/jpe?g/i.test(contentType)) return '.jpg';
  if (/image\/webp/i.test(contentType)) return '.webp';
  if (/image\/gif/i.test(contentType)) return '.gif';
  if (/image\/bmp/i.test(contentType)) return '.bmp';
  const ext = path.extname(new URL(fallbackUrl, 'https://local.invalid').pathname).toLowerCase();
  return ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'].includes(ext) ? ext : '.png';
}

// Fetch the generated image with redirect: 'manual' and re-validate every hop,
// so a 3xx redirect to an internal/loopback address cannot bypass SSRF guards.
async function fetchGeneratedImageWithRedirectGuard(url, timeoutMs) {
  let current = url;
  for (let hop = 0; hop < 4; hop++) {
    const safeUrl = await validateGeneratedImageUrl(current);
    const response = await fetchWithTimeout(safeUrl, { redirect: 'manual' }, timeoutMs);
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => {});
      if (!location) throw new Error('Generated image redirect has no location');
      current = new URL(location, safeUrl).toString();
      continue;
    }
    return response;
  }
  throw new Error('Generated image redirect limit exceeded');
}

async function downloadGeneratedImage(url) {
  const imageResponse = await fetchGeneratedImageWithRedirectGuard(url, 30000);
  if (!imageResponse.ok) {
    throw new Error(`Generated image download failed (${imageResponse.status})`);
  }
  const contentType = imageResponse.headers.get('content-type') || '';
  if (contentType && !/^image\//i.test(contentType)) {
    throw new Error('Generated image response was not an image');
  }
  const maxBytes = 20 * 1024 * 1024;
  const contentLength = Number(imageResponse.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error('Generated image size is invalid');
  }
  const chunks = [];
  let total = 0;
  const reader = imageResponse.body?.getReader();
  if (!reader) throw new Error('Generated image response body was empty');
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error('Generated image size is invalid');
    }
    chunks.push(Buffer.from(value));
  }
  const buffer = Buffer.concat(chunks, total);
  if (!buffer.length) throw new Error('Generated image size is invalid');
  const uploadsDirectory = currentUploadsDirectory();
  fs.mkdirSync(uploadsDirectory, { recursive: true });
  const ext = extensionFromContentType(contentType, url);
  const filename = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`;
  fs.writeFileSync(path.join(uploadsDirectory, filename), buffer);
  return { filename, url: `/uploads/${filename}` };
}

async function requestSeedreamImage({ prompt, model, size, watermark, apiKey }) {
  const response = await fetchWithTimeout(`${SEEDREAM_BASE_URL}/images/generations`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      prompt,
      size,
      response_format: 'url',
      watermark,
    }),
  }, 120000);
  const text = await readResponseTextWithLimit(response, 200000, 'Seedream response is too large');
  let data = {};
  try { data = JSON.parse(text); } catch { data = {}; }
  if (!response.ok) throw new Error(safeSeedreamError(response.status, data));
  const url = data?.data?.[0]?.url;
  if (typeof url !== 'string' || !url.trim()) throw new Error('Seedream did not return an image URL');
  return url.trim();
}

async function resolveAiChatOptions(body, user, signal) {
  const saved = db.getAiSettings();
  const model = body?.model || saved.model || DEEPSEEK_DEFAULT_MODEL;
  const thinkingMode = body?.thinkingMode || saved.thinkingMode || 'enabled';
  const reasoningEffort = body?.reasoningEffort || saved.reasoningEffort || 'high';
  const reasoningMode = body?.reasoningMode || saved.reasoningMode || 'effort';
  const webSearchEnabled = body?.webSearchEnabled === undefined ? Boolean(saved.webSearchEnabled) : body.webSearchEnabled;
  const kimiWebSearchEnabled = body?.kimiWebSearchEnabled === undefined
    ? Boolean(saved.kimiWebSearchEnabled)
    : body.kimiWebSearchEnabled;
  const requestedOpenrouterZdr = body?.openrouterZdrEnabled;
  if (requestedOpenrouterZdr !== undefined && typeof requestedOpenrouterZdr !== 'boolean') {
    throw new Error('Unsupported OpenRouter ZDR option');
  }
  const openrouterZdrEnabled = Boolean(saved.openrouterZdrEnabled) || requestedOpenrouterZdr === true;
  const webSearchDepth = body?.webSearchDepth || saved.webSearchDepth || 'basic';

  if (!AI_ALLOWED_MODELS.has(model) && !OPENROUTER_MODEL_ID_PATTERN.test(model)) {
    throw new Error('Unsupported AI model');
  }
  if (!AI_ALLOWED_THINKING.has(thinkingMode)) {
    throw new Error('Unsupported thinking mode');
  }
  if (!AI_ALLOWED_REASONING_MODES.has(reasoningMode)) {
    throw new Error('Unsupported reasoning mode');
  }
  if (!AI_ALLOWED_REASONING.has(reasoningEffort)) {
    throw new Error('Unsupported reasoning effort');
  }
  if (typeof webSearchEnabled !== 'boolean') {
    throw new Error('Unsupported web search option');
  }
  if (typeof kimiWebSearchEnabled !== 'boolean') {
    throw new Error('Unsupported Kimi web search option');
  }
  if (!AI_ALLOWED_SEARCH_DEPTH.has(webSearchDepth)) {
    throw new Error('Unsupported web search depth');
  }

  const requestApiKey = typeof body?.apiKey === 'string' ? body.apiKey.trim() : '';
  const requestMoonshotApiKey = typeof body?.moonshotApiKey === 'string' ? body.moonshotApiKey.trim() : '';
  const requestTavilyApiKey = typeof body?.tavilyApiKey === 'string' ? body.tavilyApiKey.trim() : '';
  const requestPerplexityApiKey = typeof body?.perplexityApiKey === 'string' ? body.perplexityApiKey.trim() : '';
  const openrouterApiKey = openrouterApiKeyForUser(saved, user);
  const profile = await resolveAiModelProfile(model, openrouterApiKey, signal);
  validateReasoningSelection(profile, reasoningMode, reasoningEffort);
  const providerApiKey = profile.provider === 'moonshot'
    ? (requestMoonshotApiKey || saved.moonshotApiKey || serverAiSecretForUser(user, MOONSHOT_API_KEY))
    : profile.provider === 'openrouter'
      ? openrouterApiKey
      : (requestApiKey || saved.apiKey || serverAiSecretForUser(user, DEEPSEEK_API_KEY));
  return {
    apiKey: providerApiKey,
    provider: profile.provider,
    profile,
    baseUrl: profile.provider === 'moonshot'
      ? MOONSHOT_BASE_URL
      : profile.provider === 'openrouter' ? OPENROUTER_BASE_URL : DEEPSEEK_BASE_URL,
    model,
    thinkingMode,
    reasoningEffort,
    reasoningMode,
    tavilyApiKey: requestTavilyApiKey || saved.tavilyApiKey || serverAiSecretForUser(user, TAVILY_API_KEY),
    perplexityApiKey: requestPerplexityApiKey || saved.perplexityApiKey || serverAiSecretForUser(user, PERPLEXITY_API_KEY),
    webSearchEnabled,
    kimiWebSearchEnabled: profile.provider === 'moonshot' && kimiWebSearchEnabled,
    openrouterZdrEnabled: profile.provider === 'openrouter' && openrouterZdrEnabled,
    webSearchDepth,
  };
}

function inferTavilyTopic(query) {
  return /最新|最近|今天|今日|当前|新闻|current|latest|recent|today|news/i.test(query) ? 'news' : 'general';
}

function normalizeTavilySources(results) {
  if (!Array.isArray(results)) return [];
  return results.slice(0, 5).map((item) => ({
    provider: 'tavily',
    title: sanitizeProviderText(item?.title || item?.url || 'Source', 120),
    url: typeof item?.url === 'string' ? item.url.slice(0, 800) : '',
    content: sanitizeProviderText(item?.content || '', 700),
    score: Number.isFinite(Number(item?.score)) ? Number(item.score) : null,
  })).filter(item => item.url);
}

function buildSearchContext(searches) {
  const rawList = Array.isArray(searches)
    ? searches
    : (Array.isArray(searches?.searches) ? searches.searches : (searches ? [searches] : []));
  const list = rawList.filter(Boolean);
  if (!list.length) return '';
  const lines = [
    'Web search results. Use them only to answer the user question, cite source URLs when relevant, and say when results are insufficient.',
  ];

  let sourceIndex = 1;
  for (const search of list) {
    const provider = search.provider === 'perplexity' ? 'Perplexity' : 'Tavily';
    lines.push('', `Provider: ${provider}`);
    lines.push(`Search query: ${search.query}`);
    if (search.answer) lines.push(`${provider} answer: ${search.answer}`);
    search.sources.forEach((source) => {
      lines.push(`[${sourceIndex}] ${source.title}`);
      lines.push(`Provider: ${provider}`);
      lines.push(`URL: ${source.url}`);
      if (source.content) lines.push(`Snippet: ${source.content}`);
      sourceIndex += 1;
    });
  }

  return lines.join('\n');
}

function mergeSearchResults(searches) {
  const list = Array.isArray(searches) ? searches.filter(Boolean) : [];
  const seen = new Set();
  const sources = [];
  for (const search of list) {
    for (const source of search.sources || []) {
      const url = source.url || '';
      if (!url || seen.has(url)) continue;
      seen.add(url);
      sources.push(source);
    }
  }
  return { searches: list, sources };
}

async function collectWebSearches(query, { tavilyApiKey, webSearchEnabled, webSearchDepth, perplexityApiKey }) {
  const tasks = [];
  if (webSearchEnabled) {
    tasks.push(runTavilySearch(query, { tavilyApiKey, webSearchDepth }));
  }
  if (perplexityEnabled()) {
    tasks.push(runPerplexityAutoSearch(query, { perplexityApiKey }));
  }
  if (!tasks.length) return { searches: [], sources: [] };

  const settled = await Promise.allSettled(tasks);
  return mergeSearchResults(settled
    .filter(item => item.status === 'fulfilled')
    .map(item => item.value));
}

function normalizePerplexitySources(data) {
  const results = normalizePerplexityResults(data).slice(0, 5).map((item) => ({
    provider: 'perplexity',
    title: sanitizeProviderText(item?.title || item?.name || item?.url || 'Source', 120),
    url: typeof item?.url === 'string' ? item.url.slice(0, 800) : '',
    content: sanitizeProviderText(item?.snippet || item?.content || item?.text || item?.description || '', 700),
    score: Number.isFinite(Number(item?.score)) ? Number(item.score) : null,
  })).filter(item => item.url);

  const seen = new Set(results.map(item => item.url));
  const citations = Array.isArray(data?.citations)
    ? data.citations.filter(item => typeof item === 'string' && item.trim()).slice(0, 8)
    : [];
  citations.forEach((url) => {
    const clipped = url.slice(0, 800);
    if (!clipped || seen.has(clipped)) return;
    seen.add(clipped);
    results.push({
      provider: 'perplexity',
      title: 'Perplexity citation',
      url: clipped,
      content: '',
      score: null,
    });
  });
  return results;
}



















































function westockEnabled() {
  return db.getAiSettings().skills?.westock?.enabled !== false;
}

function perplexityEnabled() {
  return db.getAiSettings().skills?.perplexity?.enabled !== false;
}











const LOG_TOOL_ALLOWED_TOOLS = new Set(['create', 'update', 'delete']);







function splitCommand(command) {
  const parts = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = pattern.exec(command || '')) !== null) {
    parts.push(match[1] ?? match[2] ?? match[3]);
  }
  return parts;
}

function safeWestockArg(value, name, { maxLength = 120 } = {}) {
  const text = String(value ?? '').trim();
  if (!text || text.length > maxLength) {
    throw new Error(`Invalid WeStock argument: ${name}`);
  }
  // We keep shell:true (npx resolves to npx.cmd on Windows, which cannot run under shell:false),
  // so argument values must be inert to both POSIX shells and cmd.exe. Reject every
  // command separator, redirect, glob, quote, escape and env-expansion character.
  if (/[\u0000-\u001f\u007f]/.test(text) || /[;&|<>`$!^"'()\[\]{}%=\\*?]/.test(text)) {
    throw new Error(`Invalid WeStock argument: ${name}`);
  }
  return text;
}

function pushWestockFlag(argv, flag, value) {
  if (!WESTOCK_ALLOWED_FLAGS.has(flag)) return;
  if (value === undefined || value === null || value === '' || value === false) return;
  if (value === true) {
    argv.push(`--${flag}`);
    return;
  }
  argv.push(`--${flag}`, safeWestockArg(value, flag, { maxLength: 80 }));
}

function buildWestockArgs(tool, rawArgs = {}) {
  if (!WESTOCK_ALLOWED_TOOLS.has(tool)) {
    throw new Error('Unsupported WeStock tool');
  }
  if (!rawArgs || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) {
    throw new Error('WeStock args must be an object');
  }
  const args = rawArgs;
  const argv = [tool];
  if (tool === 'search') {
    argv.push(safeWestockArg(args.query || args.keyword, 'query', { maxLength: 80 }));
    pushWestockFlag(argv, 'sector', args.sector);
  } else if (tool === 'hot') {
    argv.push(safeWestockArg(args.type || 'stock', 'type', { maxLength: 20 }));
  } else if (tool === 'calendar') {
    if (args.date) argv.push(safeWestockArg(args.date, 'date', { maxLength: 20 }));
  } else if (tool === 'board') {
    // No positional argument required.
  } else if (WESTOCK_MARKET_TOOLS.has(tool)) {
    argv.push(safeWestockArg(args.market || args.type || 'hs', 'market', { maxLength: 20 }));
  } else if (WESTOCK_SYMBOL_TOOLS.has(tool)) {
    argv.push(safeWestockArg(args.symbol || args.code || args.symbols, 'symbol', { maxLength: 120 }));
  } else {
    throw new Error('Unsupported WeStock tool');
  }

  for (const flag of WESTOCK_ALLOWED_FLAGS) {
    if (flag === 'sector' && tool === 'search') continue;
    pushWestockFlag(argv, flag, args[flag]);
  }
  return argv;
}

function runWestockCli(tool, args) {
  const base = splitCommand(WESTOCK_NPX_COMMAND);
  if (!base.length) {
    return Promise.reject(new Error('WeStock command is not configured'));
  }
  const cliArgs = buildWestockArgs(tool, args);
  const command = base[0];
  const commandArgs = [...base.slice(1), ...cliArgs];
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(command, commandArgs, {
      cwd: __dirname,
      windowsHide: true,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      child.kill('SIGKILL');
      reject(new Error('WeStock request timed out'));
    }, WESTOCK_TIMEOUT_MS);
    if (timer.unref) timer.unref();
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
      if (stdout.length > WESTOCK_MAX_OUTPUT_CHARS * 2) stdout = stdout.slice(-WESTOCK_MAX_OUTPUT_CHARS);
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(sanitizeToolText(stderr || stdout || `WeStock exited with code ${code}`, 500)));
        return;
      }
      resolve(sanitizeToolText(stdout, WESTOCK_MAX_OUTPUT_CHARS));
    });
  });
}

function normalizePerplexityQueries(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error('Perplexity args must be an object');
  }
  const rawQueries = Array.isArray(args.queries) ? args.queries : [args.query];
  const queries = rawQueries
    .map(value => String(value ?? '').trim().replace(/\s+/g, ' '))
    .filter(Boolean);
  if (!queries.length) {
    throw new Error('Perplexity search query is required');
  }
  if (queries.length > PERPLEXITY_MAX_QUERIES) {
    throw new Error(`Perplexity supports at most ${PERPLEXITY_MAX_QUERIES} queries per request`);
  }
  for (const query of queries) {
    if (query.length > PERPLEXITY_MAX_QUERY_CHARS) {
      throw new Error(`Perplexity query must be ${PERPLEXITY_MAX_QUERY_CHARS} characters or fewer`);
    }
  }
  return queries;
}

function normalizePerplexityResults(data) {
  if (Array.isArray(data)) {
    return data.flatMap(item => {
      if (Array.isArray(item) || Array.isArray(item?.results)) return normalizePerplexityResults(item);
      return [item];
    });
  }
  if (Array.isArray(data?.results)) return data.results;
  const nested = Object.values(data || {}).filter(item => item && typeof item === 'object' && (item.title || item.url || item.snippet || item.content));
  return nested;
}





function safePerplexityError(status, data) {
  const detail = sanitizeProviderText(data?.error?.message || data?.error || data?.message || data?.detail || '', 240);
  return detail
    ? `Perplexity request failed (${status}): ${detail}`
    : `Perplexity request failed (${status})`;
}

async function fetchPerplexitySearch(queries, apiKey) {
  if (!apiKey) {
    const err = new Error('Perplexity API key is not configured');
    err.status = 503;
    throw err;
  }
  const upstream = await fetchWithTimeout(`${PERPLEXITY_BASE_URL}/search`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: queries }),
  });
  const data = await upstream.json().catch(() => ({}));
  if (!upstream.ok) {
    const err = new Error(safePerplexityError(upstream.status, data));
    err.status = 502;
    throw err;
  }
  return data;
}



async function runPerplexityAutoSearch(query, { perplexityApiKey }) {
  const queries = normalizePerplexityQueries({ query });
  const data = await fetchPerplexitySearch(queries, perplexityApiKey);
  return {
    provider: 'perplexity',
    query,
    answer: sanitizeProviderText(data?.answer || data?.summary || '', 1200),
    sources: normalizePerplexitySources(data),
  };
}

















async function runTavilySearch(query, { tavilyApiKey, webSearchDepth }) {
  if (!tavilyApiKey) {
    const err = new Error('Tavily API key is not configured');
    err.status = 503;
    throw err;
  }
  const payload = {
    query,
    search_depth: webSearchDepth,
    topic: inferTavilyTopic(query),
    max_results: 5,
    include_answer: true,
    include_raw_content: false,
    include_images: false,
  };
  const upstream = await fetchWithTimeout(`${TAVILY_BASE_URL}/search`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${tavilyApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const data = await upstream.json().catch(() => ({}));
  if (!upstream.ok) {
    const err = new Error(safeTavilyError(upstream.status, data));
    err.status = 502;
    throw err;
  }
  return {
    query,
    answer: sanitizeProviderText(data?.answer || '', 1200),
    sources: normalizeTavilySources(data?.results),
  };
}







app.get('/api/ai/models', async (req, res) => {
  try {
    const settings = db.getAiSettings();
    const apiKey = openrouterApiKeyForUser(settings, req.user);
    let models = directAiModelRecords();
    let openrouterCatalog = null;
    if (apiKey) {
      openrouterCatalog = await getOpenRouterModelCatalogResult(apiKey, {
        force: req.query?.refresh === '1',
      });
      models = models.concat(openrouterCatalog.models);
    }
    const query = typeof req.query?.q === 'string' ? req.query.q.trim().toLowerCase().slice(0, 100) : '';
    if (query) models = models.filter(model => `${model.name} ${model.id} ${model.provider}`.toLowerCase().includes(query));
    res.json({
      models,
      openrouterConfigured: Boolean(apiKey),
      openrouterCatalog: openrouterCatalog ? {
        source: openrouterCatalog.source,
        fetchedAt: new Date(openrouterCatalog.fetchedAt).toISOString(),
      } : null,
    });
  } catch (err) {
    const status = err.status && [400, 503].includes(err.status) ? err.status : 500;
    res.status(status).json({ error: status === 500 ? 'Failed to load AI models' : err.message });
  }
});

app.get('/api/ai/settings', (req, res) => {
  try {
    res.json(publicAiSettings(db.getAiSettings(), req.user));
  } catch (err) {
    res.status(500).json({ error: 'Failed to load AI settings' });
  }
});

app.put('/api/ai/settings', async (req, res) => {
  try {
    const current = db.getAiSettings();
    const candidate = parseAiSettingsInput(req.body, current);
    if (!AI_MODEL_PROFILES[candidate.model]) {
      const apiKey = openrouterApiKeyForUser(candidate, req.user);
      const profile = await resolveAiModelProfile(candidate.model, apiKey);
      validateReasoningSelection(profile, candidate.reasoningMode, candidate.reasoningEffort);
    }
    const saved = db.saveAiSettings(candidate);
    res.json(publicAiSettings(saved, req.user));
  } catch (err) {
    const status = err.status && [400, 503].includes(err.status) ? err.status : 400;
    res.status(status).json({ error: err.message || 'Failed to save AI settings' });
  }
});













// List logs with filters
app.get('/api/logs', (req, res) => {
  try {
    const diaryUnlocked = hasDiaryAccess(req);
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 50));
    const result = db.getAll({ ...req.query, page, limit }, diaryUnlocked);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reorder logs (must be before :id routes)
app.put('/api/logs/reorder', (req, res) => {
  try {
    const { orderedIds } = req.body;
    const ids = Array.isArray(orderedIds) ? orderedIds.map(parsePositiveId) : [];
    if (!Array.isArray(orderedIds) || ids.some(id => !id) || new Set(ids).size !== ids.length) {
      return res.status(400).json({ error: 'orderedIds must contain unique positive integers' });
    }
    const touchesDiary = ids
      .map(id => db.getById(id))
      .some(logRequiresDiaryAccess);
    if (touchesDiary && !hasDiaryAccess(req)) return rejectLockedDiary(res);
    db.reorderLogs(ids);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get single log
app.get('/api/logs/:id', (req, res) => {
  try {
    const id = parsePositiveId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid log id' });
    const log = db.getById(id);
    if (!log) return res.status(404).json({ error: 'Log not found' });
    if (logRequiresDiaryAccess(log) && !hasDiaryAccess(req)) return rejectLockedDiary(res);
    res.json(log);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create log
app.post('/api/logs', (req, res) => {
  try {
    const validated = validateLogInput(req.body);
    if (validated.error) return res.status(400).json({ error: validated.error });
    if (isDiaryCategory(validated.payload.category) && !hasDiaryAccess(req)) return rejectLockedDiary(res);
    const entry = db.create(validated.payload);
    res.status(201).json(entry);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update log
app.put('/api/logs/:id', (req, res) => {
  try {
    const id = parsePositiveId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid log id' });
    const validated = validateLogInput(req.body, { partial: true });
    if (validated.error) return res.status(400).json({ error: validated.error });
    if (!Object.keys(validated.payload).length) return res.status(400).json({ error: 'No log fields to update' });
    const existing = db.getById(id);
    if (!existing) return res.status(404).json({ error: 'Log not found' });
    if ((logRequiresDiaryAccess(existing) || isDiaryCategory(validated.payload.category)) && !hasDiaryAccess(req)) return rejectLockedDiary(res);
    const entry = db.update(id, validated.payload);
    res.json(entry);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete log
app.delete('/api/logs/:id', (req, res) => {
  try {
    const id = parsePositiveId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid log id' });
    const log = db.getById(id);
    if (!log) return res.status(404).json({ error: 'Log not found' });
    if (logRequiresDiaryAccess(log) && !hasDiaryAccess(req)) return rejectLockedDiary(res);
    const ok = db.remove(id);
    if (!ok) return res.status(404).json({ error: 'Log not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Statistics
app.get('/api/stats', (req, res) => {
  try {
    const diaryUnlocked = hasDiaryAccess(req);
    const stats = db.getStats(diaryUnlocked);
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Backup full data as JSON
app.get('/api/backup', (req, res) => {
  try {
    if (restoreRequiresDiaryAccess(req) && !hasDiaryAccess(req)) return rejectLockedDiary(res);
    const data = db.backup();
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename=work-log-backup-${businessDateString()}.json`);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Restore from backup JSON (?mode=merge for non-destructive merge)
app.post('/api/restore', (req, res) => {
  try {
    if (restoreRequiresDiaryAccess(req) && !hasDiaryAccess(req)) return rejectLockedDiary(res);
    const mode = req.query.mode === 'merge' ? 'merge' : 'replace';
    const result = db.restore(req.body, mode);
    if (result.error) return res.status(400).json(result);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Todo routes
app.get('/api/todo-categories', (req, res) => {
  try {
    res.json(db.getTodoCategories());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/todo-categories', (req, res) => {
  try {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name) return res.status(400).json({ error: 'Name is required' });
    const result = db.addTodoCategory(name);
    if (result.error) return res.status(400).json({ error: result.error });
    res.status(201).json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/todo-categories/:name', (req, res) => {
  try {
    const result = db.deleteTodoCategory(req.params.name);
    if (!result) return res.status(404).json({ error: 'Todo category not found' });
    if (result.error) return res.status(409).json({ error: result.error });
    res.json({ success: true, categories: result.categories });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/todo-reminder-settings', (_req, res) => {
  try {
    res.json(getTodoReminderResponse());
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to load todo reminder settings' });
  }
});

app.put('/api/todo-reminder-settings', (req, res) => {
  try {
    const result = db.saveTodoReminderSettings(req.body, { mailReady: qqMailReady() });
    if (result.error) {
      return res.status(400).json({ error: result.error });
    }
    if (todoReminderService) void todoReminderService.tick();
    res.json(getTodoReminderResponse());
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to save todo reminder settings' });
  }
});

app.get('/api/countdowns', (_req, res) => {
  try {
    res.json(db.getAllCountdowns());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/countdowns', (req, res) => {
  try {
    const validated = validateCountdownInput(req.body);
    if (validated.error) return res.status(400).json({ error: validated.error });
    res.status(201).json(db.createCountdown(validated.payload));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/countdowns/:id', (req, res) => {
  try {
    const id = parsePositiveId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid countdown id' });
    const validated = validateCountdownInput(req.body, { partial: true });
    if (validated.error) return res.status(400).json({ error: validated.error });
    if (!Object.keys(validated.payload).length) return res.status(400).json({ error: 'No countdown fields to update' });
    const entry = db.updateCountdown(id, validated.payload);
    if (!entry) return res.status(404).json({ error: 'Countdown not found' });
    res.json(entry);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/countdowns/:id', (req, res) => {
  try {
    const id = parsePositiveId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid countdown id' });
    if (!db.removeCountdown(id)) return res.status(404).json({ error: 'Countdown not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/todos', (req, res) => {
  try {
    const todos = db.getAllTodos(req.query);
    res.json(todos);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/todos', (req, res) => {
  try {
    const validated = validateTodoInput(req.body);
    if (validated.error) return res.status(400).json({ error: validated.error });
    const entry = db.createTodo(validated.payload);
    res.status(201).json(entry);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete completed todos (must be before :id routes)
app.delete('/api/todos/completed', (req, res) => {
  try {
    const count = db.removeCompletedTodos();
    res.json({ success: true, removed: count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/todos/reorder', (req, res) => {
  try {
    const { orderedIds } = req.body;
    const ids = Array.isArray(orderedIds) ? orderedIds.map(parsePositiveId) : [];
    if (!Array.isArray(orderedIds) || ids.some(id => !id) || new Set(ids).size !== ids.length) {
      return res.status(400).json({ error: 'orderedIds must contain unique positive integers' });
    }
    db.reorderTodos(ids);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/todos/:id', (req, res) => {
  try {
    const id = parsePositiveId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid todo id' });
    const validated = validateTodoInput(req.body, { partial: true });
    if (validated.error) return res.status(400).json({ error: validated.error });
    if (!Object.keys(validated.payload).length) return res.status(400).json({ error: 'No todo fields to update' });
    const entry = db.updateTodo(id, validated.payload);
    if (!entry) return res.status(404).json({ error: 'Todo not found' });
    res.json(entry);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/todos/:id', (req, res) => {
  try {
    const id = parsePositiveId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid todo id' });
    const ok = db.removeTodo(id);
    if (!ok) return res.status(404).json({ error: 'Todo not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Image upload
app.post('/api/upload', (req, res) => {
  upload.single('image')(req, res, (err) => {
    if (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: '文件大小不能超过 10MB' });
        return res.status(400).json({ error: err.message });
      }
      return res.status(400).json({ error: err.message });
    }
    if (!req.file) return res.status(400).json({ error: '请选择要上传的图片' });
    if (!uploadedImageMatchesExtension(req.file)) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: '文件内容与图片格式不匹配' });
    }
    const privateUpload = req.body.private === 'true' || req.body.private === '1';
    if (privateUpload && !hasDiaryAccess(req)) {
      fs.unlinkSync(req.file.path);
      return rejectLockedDiary(res);
    }
    if (privateUpload) db.markPrivateUpload(req.file.filename);
    res.json({ url: `/uploads/${req.file.filename}`, filename: req.file.filename });
  });
});

function resolveUploadPath(filename) {
  if (!db.isSafeUploadFilename(filename)) return null;
  const uploadsDirectory = currentUploadsDirectory();
  const filePath = path.join(uploadsDirectory, filename);
  const resolved = path.resolve(filePath);
  const root = path.resolve(uploadsDirectory);
  return resolved.startsWith(root + path.sep) && resolved !== root ? resolved : null;
}

// Uploaded image access; diary-linked images require an unlocked diary session.
app.get('/uploads/:filename', (req, res) => {
  try {
    const filePath = resolveUploadPath(req.params.filename);
    if (!filePath) return res.status(403).json({ error: 'Invalid filename' });
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: '文件不存在' });
    if (db.isPrivateUpload(req.params.filename) && !hasDiaryAccess(req)) return rejectLockedDiary(res);
    res.sendFile(filePath);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete uploaded image — with path traversal protection
app.delete('/api/uploads/:filename', (req, res) => {
  try {
    const filename = req.params.filename;
    const filePath = resolveUploadPath(filename);
    if (!filePath) return res.status(403).json({ error: 'Invalid filename' });
    if (db.isPrivateUpload(filename) && !hasDiaryAccess(req)) return rejectLockedDiary(res);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      db.unmarkPrivateUpload(filename);
      res.json({ success: true });
    } else {
      res.status(404).json({ error: '文件不存在' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Category routes
app.get('/api/categories', (req, res) => {
  try {
    const diaryUnlocked = hasDiaryAccess(req);
    res.json(db.getAllCategories(diaryUnlocked, diaryUnlocked));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/categories', (req, res) => {
  try {
    const { name, parent } = req.body;
    const cleanName = cleanCategorySegment(name);
    const cleanParent = parent === undefined || parent === null || parent === '' ? null : cleanCategorySegment(parent);
    if (!cleanName || (parent && !cleanParent)) return res.status(400).json({ error: 'Invalid category name' });
    if ((isDiaryCategory(cleanName) || isDiaryCategory(cleanParent)) && !hasDiaryAccess(req)) {
      return rejectLockedDiary(res);
    }
    const result = db.addCategory(cleanName, cleanParent);
    if (!result) {
      if (parent) return res.status(404).json({ error: 'Parent category not found' });
      return res.status(409).json({ error: 'Category already exists' });
    }
    res.status(201).json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/categories/reorder', (req, res) => {
  try {
    const { orderedCats } = req.body;
    if (!Array.isArray(orderedCats)) {
      return res.status(400).json({ error: 'orderedCats array required' });
    }
    db.reorderCategories(orderedCats);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/categories/:parent/subcategories/reorder', (req, res) => {
  try {
    const parent = req.params.parent;
    const { orderedSubs } = req.body;
    if (isDiaryCategory(parent) && !hasDiaryAccess(req)) return rejectLockedDiary(res);
    if (!Array.isArray(orderedSubs)) {
      return res.status(400).json({ error: 'orderedSubs array required' });
    }
    const result = db.reorderSubcategories(parent, orderedSubs);
    if (!result) return res.status(404).json({ error: 'Parent category not found' });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/categories/:name/calendar-day-visibility', (req, res) => {
  try {
    const name = req.params.name;
    if (isDiaryCategory(name) && !hasDiaryAccess(req)) return rejectLockedDiary(res);
    if (typeof req.body.visible !== 'boolean') {
      return res.status(400).json({ error: 'visible boolean required' });
    }
    const result = db.setCategoryCalendarDayVisible(name, req.body.visible);
    if (!result) return res.status(404).json({ error: 'Category not found' });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/categories/:oldName', (req, res) => {
  try {
    const oldName = req.params.oldName;
    const newName = cleanCategorySegment(req.body.name);
    if (!newName) return res.status(400).json({ error: 'Invalid category name' });
    if (isDiaryRoot(oldName) || isDiaryRoot(newName)) {
      return res.status(409).json({ error: 'Diary root category is protected' });
    }
    if ((isDiaryCategory(oldName) || isDiaryCategory(newName)) && !hasDiaryAccess(req)) {
      return rejectLockedDiary(res);
    }
    const result = db.renameCategory(oldName, newName);
    if (result.error) return res.status(400).json(result);
    const categorySeparator = oldName.indexOf('/');
    const rewrittenPath = categorySeparator >= 0
      ? `${oldName.slice(0, categorySeparator)}/${newName}`
      : newName;
    knowledgeServiceFor(db).knowledge.rewriteCollectionPath(oldName, rewrittenPath);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/categories/:name', (req, res) => {
  try {
    const name = req.params.name;
    if (isDiaryRoot(name)) return res.status(409).json({ error: 'Diary root category is protected' });
    if (isDiaryCategory(name) && !hasDiaryAccess(req)) return rejectLockedDiary(res);
    const ok = db.deleteCategory(name);
    if (!ok) return res.status(404).json({ error: 'Category not found' });
    knowledgeServiceFor(db).knowledge.reassignCollectionPath(name, '其他');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function isLoopbackHost(host) {
  return ['127.0.0.1', '::1', 'localhost'].includes(String(host).toLowerCase());
}

function acquireProcessLock() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const lockPath = path.join(DATA_DIR, '.schedule.lock');
  const tryAcquire = () => {
    const fd = fs.openSync(lockPath, 'wx', 0o600);
    fs.writeFileSync(fd, String(process.pid), 'utf-8');
    fs.fsyncSync(fd);
    return { fd, lockPath };
  };
  try {
    return tryAcquire();
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    const oldPid = Number.parseInt(fs.readFileSync(lockPath, 'utf-8'), 10);
    let alive = Number.isInteger(oldPid) && oldPid > 0;
    if (alive) {
      try { process.kill(oldPid, 0); } catch { alive = false; }
    }
    if (alive) throw new Error(`DATA_DIR is already in use by process ${oldPid}`);
    fs.unlinkSync(lockPath);
    return tryAcquire();
  }
}

function estimateAiContextTokens(value, key = '') {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'string') {
    if (key === 'url' && value.startsWith('data:image/')) return 1200;
    if (key === 'url' && value.startsWith('data:video/')) return 6000;
    let ascii = 0;
    let nonAscii = 0;
    for (const char of value) {
      if (char.codePointAt(0) <= 0x7f) ascii += 1;
      else nonAscii += 1;
    }
    return Math.ceil(ascii / 4) + nonAscii;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return 1;
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + estimateAiContextTokens(item), value.length);
  if (typeof value === 'object') {
    return Object.entries(value).reduce(
      (sum, [childKey, child]) => sum + estimateAiContextTokens(childKey) + estimateAiContextTokens(child, childKey),
      0,
    );
  }
  return 0;
}

function assertAiContextCapacity(options, payload) {
  const contextLength = Number(options?.profile?.contextLength);
  if (!Number.isSafeInteger(contextLength) || contextLength <= 0) return;
  const reservedOutputTokens = Math.min(4096, Math.max(512, Math.ceil(contextLength * 0.15)));
  const estimatedInputTokens = estimateAiContextTokens(payload?.messages || []) + estimateAiContextTokens(payload?.tools || []);
  if (estimatedInputTokens > contextLength - reservedOutputTokens) {
    const error = new Error('The selected model context window is too small for the current conversation');
    error.status = 413;
    throw error;
  }
}

async function fetchAiProviderUpstream(options, payload, signal) {
  assertAiContextCapacity(options, payload);
  try {
    const headers = {
      'Authorization': `Bearer ${options.apiKey}`,
      'Content-Type': 'application/json',
    };
    if (options.provider === 'openrouter') headers['X-Title'] = 'Work Log';
    return await fetchWithTimeout(aiProviderChatUrl(options), {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    const wrapped = new Error(`${aiProviderLabel(options.provider)} request failed: network error or timeout`);
    wrapped.status = 502;
    throw wrapped;
  }
}

function normalizeOpenRouterSources(annotations) {
  if (!Array.isArray(annotations)) return [];
  const seen = new Set();
  const sources = [];
  for (const annotation of annotations) {
    if (annotation?.type !== 'url_citation') continue;
    const citation = annotation.url_citation && typeof annotation.url_citation === 'object'
      ? annotation.url_citation
      : annotation;
    const rawUrl = typeof citation.url === 'string' ? citation.url.trim().slice(0, 800) : '';
    try {
      const parsed = new URL(rawUrl);
      if (!['http:', 'https:'].includes(parsed.protocol) || seen.has(parsed.href)) continue;
      seen.add(parsed.href);
      sources.push({
        provider: 'openrouter',
        title: sanitizeProviderText(citation.title || parsed.hostname || 'Source', 120),
        url: parsed.href.slice(0, 800),
        content: sanitizeProviderText(citation.content || '', 700),
        score: null,
      });
      if (sources.length >= 10) break;
    } catch {}
  }
  return sources;
}

function mergeAiSources(...groups) {
  const seen = new Set();
  return groups.flat().filter((source) => {
    if (!source?.url || seen.has(source.url)) return false;
    seen.add(source.url);
    return true;
  }).slice(0, 10);
}

async function fetchAiProviderReply({ options, payload, signal }) {
  const upstream = await fetchAiProviderUpstream(options, payload, signal);
  const data = await upstream.json().catch(() => ({}));
  if (!upstream.ok || data?.error) {
    const err = new Error(safeAiProviderError(options.provider, upstream.status, data));
    err.status = 502;
    throw err;
  }
  const message = data?.choices?.[0]?.message;
  const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  const reply = typeof message?.content === 'string' ? message.content : '';
  if (!reply && !toolCalls.length) {
    const err = new Error(`${aiProviderLabel(options.provider)} response was empty`);
    err.status = 502;
    throw err;
  }
  return {
    content: reply,
    reasoningContent: options.provider === 'openrouter'
      ? (typeof message?.reasoning === 'string' ? message.reasoning : (typeof message?.reasoning_content === 'string' ? message.reasoning_content : ''))
      : (shouldPreserveMoonshotReasoning(options) && typeof message?.reasoning_content === 'string' ? message.reasoning_content : ''),
    openrouterReasoningDetails: options.provider === 'openrouter'
      ? normalizeOpenRouterReasoningDetailsInput(message?.reasoning_details)
      : [],
    sources: options.provider === 'openrouter' ? normalizeOpenRouterSources(message?.annotations) : [],
    toolCalls,
    rawMessage: message,
    finishReason: data?.choices?.[0]?.finish_reason || '',
  };
}

function aiProviderPayload({ options, messages, stream = false, tools, toolChoice, enableWebSearch = false }) {
  const payload = {
    model: options.model,
    messages,
    stream,
  };
  if (options.provider === 'deepseek') {
    payload.thinking = { type: options.thinkingMode };
    if (options.thinkingMode === 'enabled') payload.reasoning_effort = options.reasoningEffort;
  } else if (options.profile.thinking === 'k3') {
    payload.reasoning_effort = 'max';
  } else if (options.profile.thinking === 'optional') {
    payload.thinking = options.thinkingMode === 'disabled'
      ? { type: 'disabled' }
      : { type: 'enabled', keep: 'all' };
  } else if (options.provider === 'openrouter') {
    if (options.reasoningMode === 'disabled') payload.reasoning = { enabled: false };
    if (options.reasoningMode === 'effort') payload.reasoning = { effort: options.reasoningEffort };
    if (options.openrouterZdrEnabled) payload.provider = { zdr: true };
    if (enableWebSearch) {
      payload.tools = [{
        type: 'openrouter:web_search',
        parameters: {
          engine: 'auto',
          max_total_results: options.webSearchDepth === 'advanced' ? 10 : 5,
        },
      }];
    }
  }
  if (Array.isArray(tools) && tools.length) payload.tools = tools;
  if (toolChoice) payload.tool_choice = toolChoice;
  return payload;
}

function shouldPreserveMoonshotReasoning(options) {
  return options.provider === 'moonshot' && options.profile.preserveReasoning &&
    (options.profile.thinking !== 'optional' || options.thinkingMode !== 'disabled');
}











async function buildAiProviderMessages(messages, options) {
  const output = [];
  const preserveReasoning = shouldPreserveMoonshotReasoning(options);
  for (const message of messages) {
    if (message.role === 'assistant' && options.provider === 'moonshot' &&
        (!message.provider || (message.provider === 'moonshot' && (!message.modelId || message.modelId === options.model)))) {
      for (const traceEntry of message.providerTrace || []) output.push(traceEntry);
    }
    const providerMessage = { role: message.role, content: message.content };
    if (message.role === 'assistant' && options.provider === 'moonshot' && preserveReasoning && message.reasoningContent) {
      providerMessage.reasoning_content = message.reasoningContent;
    }
    if (message.role === 'assistant' && options.provider === 'openrouter' &&
        message.provider === 'openrouter' && message.modelId === options.model && message.openrouterReasoningDetails?.length) {
      providerMessage.reasoning_details = message.openrouterReasoningDetails;
    }
    output.push(providerMessage);
  }
  return output;
}

async function getMoonshotFormulaTools(options, signal) {
  const fingerprint = apiKeyFingerprint(options.apiKey);
  const cached = moonshotFormulaToolCache.get(fingerprint);
  if (cached && cached.expiresAt > Date.now()) return cached.tools;
  let response;
  try {
    response = await fetchWithTimeout(`${options.baseUrl}/formulas/${MOONSHOT_FORMULA_URI}/tools`, {
      headers: { 'Authorization': `Bearer ${options.apiKey}` },
      signal,
    }, 30000);
  } catch (error) {
    if (signal?.aborted) throw error;
    const wrapped = new Error('Kimi Formula tool discovery failed: network error or timeout');
    wrapped.status = 502;
    throw wrapped;
  }
  const text = await readResponseTextWithLimit(
    response,
    MOONSHOT_TOOL_MAX_RESULT_CHARS,
    'Kimi Formula tool definition exceeded the safe size limit'
  );
  let data = {};
  try { data = JSON.parse(text); } catch {}
  if (!response.ok) {
    const err = new Error(safeAiProviderError('moonshot', response.status, data));
    err.status = 502;
    throw err;
  }
  const tools = Array.isArray(data?.tools) ? data.tools : [];
  if (tools.length !== 1 || tools[0]?.type !== 'function' || tools[0]?.function?.name !== 'web_search') {
    const err = new Error('Kimi Formula returned an unexpected web-search tool definition');
    err.status = 502;
    throw err;
  }
  moonshotFormulaToolCache.set(fingerprint, { expiresAt: Date.now() + MOONSHOT_TOOL_CACHE_TTL_MS, tools });
  return tools;
}

function validateMoonshotWebToolCall(call) {
  if (!call || call.type !== 'function' || call.function?.name !== 'web_search' ||
      typeof call.id !== 'string' || !call.id || call.id.length > 160) {
    throw new Error('Kimi requested an unsupported Formula tool');
  }
  const encodedArguments = call.function.arguments;
  if (typeof encodedArguments !== 'string' || encodedArguments.length > 2000) throw new Error('Kimi web-search arguments are invalid');
  let args;
  try { args = JSON.parse(encodedArguments); } catch { throw new Error('Kimi web-search arguments are invalid'); }
  if (!args || typeof args !== 'object' || Array.isArray(args) || typeof args.query !== 'string') {
    throw new Error('Kimi web-search query is invalid');
  }
  if (Object.keys(args).some(key => key !== 'query')) throw new Error('Kimi web-search arguments contain unsupported fields');
  const query = args.query.trim();
  if (!query || query.length > 500) throw new Error('Kimi web-search query must contain 1–500 characters');
  return { id: call.id, name: 'web_search', encodedArguments };
}

async function runMoonshotFormulaFiber(options, call, signal) {
  const validated = validateMoonshotWebToolCall(call);
  let response;
  try {
    response = await fetchWithTimeout(`${options.baseUrl}/formulas/${MOONSHOT_FORMULA_URI}/fibers`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${options.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: validated.name, arguments: validated.encodedArguments }),
      signal,
    }, 30000);
  } catch (error) {
    if (signal?.aborted) throw error;
    const wrapped = new Error('Kimi Formula web search failed: network error or timeout');
    wrapped.status = 502;
    throw wrapped;
  }
  const text = await readResponseTextWithLimit(
    response,
    MOONSHOT_TOOL_MAX_RESULT_CHARS,
    'Kimi Formula response exceeded the safe size limit'
  );
  let data = {};
  try { data = JSON.parse(text); } catch {}
  if (!response.ok || data?.status !== 'succeeded') {
    const detail = data?.error || data?.context?.error || data?.message || '';
    const err = new Error(`Kimi Formula web search failed${detail ? `: ${sanitizeProviderText(detail, 240)}` : ` (${response.status})`}`);
    err.status = 502;
    throw err;
  }
  const content = data?.context?.output || data?.context?.encrypted_output;
  if (typeof content !== 'string' || !content || content.length > MOONSHOT_TOOL_MAX_RESULT_CHARS) {
    const err = new Error('Kimi Formula web search returned no usable result');
    err.status = 502;
    throw err;
  }
  return { role: 'tool', tool_call_id: validated.id, content };
}

async function runMoonshotToolLoop({ options, messages, signal }) {
  const tools = await getMoonshotFormulaTools(options, signal);
  const workingMessages = [
    {
      role: 'system',
      content: 'Use the official web_search tool for current web information. In the final answer, include useful inline Markdown source links from the search evidence. Never expose encrypted tool payloads.',
    },
    ...messages,
  ];
  const providerTrace = [];
  let callCount = 0;
  let traceChars = 0;
  for (let round = 0; round <= MOONSHOT_TOOL_MAX_ROUNDS; round += 1) {
    const toolChoice = round === 0 && options.profile.thinking === 'k3' ? 'required' : 'auto';
    const reply = await fetchAiProviderReply({
      options,
      signal,
      payload: aiProviderPayload({ options, messages: workingMessages, tools, toolChoice }),
    });
    if (!reply.toolCalls.length) {
      if (!reply.content) throw new Error('Kimi returned no final answer after Formula web search');
      return { ...reply, providerTrace };
    }
    if (round === MOONSHOT_TOOL_MAX_ROUNDS) throw new Error('Kimi Formula tool loop exceeded 4 rounds');
    callCount += reply.toolCalls.length;
    if (callCount > MOONSHOT_TOOL_MAX_CALLS) throw new Error('Kimi Formula tool loop exceeded 6 searches');
    reply.toolCalls.forEach(validateMoonshotWebToolCall);
    const assistantTrace = {
      role: 'assistant',
      content: typeof reply.rawMessage?.content === 'string' ? reply.rawMessage.content : '',
      tool_calls: reply.toolCalls,
    };
    if (typeof reply.rawMessage?.reasoning_content === 'string' && reply.rawMessage.reasoning_content) {
      assistantTrace.reasoning_content = reply.rawMessage.reasoning_content;
    }
    const toolResults = await Promise.all(reply.toolCalls.map(call => runMoonshotFormulaFiber(options, call, signal)));
    traceChars += JSON.stringify(assistantTrace).length + toolResults.reduce((sum, item) => sum + item.content.length, 0);
    if (traceChars > MOONSHOT_TOOL_MAX_RESULT_CHARS) throw new Error('Kimi Formula context exceeded the safe response size limit');
    providerTrace.push(assistantTrace, ...toolResults);
    workingMessages.push(assistantTrace, ...toolResults);
  }
  throw new Error('Kimi Formula tool loop failed');
}













function releaseProcessLock(lock) {
  if (!lock) return;
  try { fs.closeSync(lock.fd); } catch {}
  try {
    if (fs.readFileSync(lock.lockPath, 'utf-8').trim() === String(process.pid)) {
      fs.unlinkSync(lock.lockPath);
    }
  } catch {}
}

function createAgentModelClient(req) {
  return {
    async complete({ goal, messages, tools, memories, checkpoint }) {
      const options = await resolveAiChatOptions({}, req.user);
      if (!options?.apiKey) throw new Error('Agent model is not configured');
      const toolList = (tools || []).map(item => `${item.name}: ${item.description}`).join('\n');
      const checkpointBlock = checkpoint && typeof checkpoint === 'object'
        ? `Working checkpoint:\n${JSON.stringify(checkpoint)}`
        : '';
      const system = [
        'You are the local Work Log Agent. Work only from @ injected local knowledge, tool results, and the user goal.',
        'Prefer native function tools. When you need a tool, call it instead of chatting.',
        'You may also return exactly one JSON object with no Markdown fences.',
        'For a tool call: {"action":"tool","tools":[{"name":"knowledge.read","arguments":{"id":"..."}}]} .',
        'For a final answer: {"action":"final","answer":"...","citations":[{"documentId":"...","id":"...","title":"..."}]} .',
        'For a clarifying question: {"action":"ask","question":"..."} .',
        'Use update_working_checkpoint during multi-step work to record next steps, notes, and verified facts.',
        'Use countdown.create for birthdays and anniversaries; do not use task.create for countdown entries.',
        'For todo reminders only, use task.create once with recurrence yearly and due_date. For countdown cards, use countdown.create once.',
        'Use knowledge.search and knowledge.tree to discover local notes before reading them with knowledge.read.',
        'Use knowledge.list to browse documents in a knowledge base or folder; use memory.search to find saved L2/L3 memories.',
        'Use code.run for short PowerShell or Python scripts (there is no separate shell.run tool).',
        'For complex sub-tasks use agent.delegate once; it requires confirmation and child write actions still need approval.',
        'Never invent local evidence. If the user did not @ a knowledge base or date and no evidence exists, say so. Writes and external actions are proposed for confirmation.',
        checkpointBlock,
        `Available tools:\n${toolList}`,
        `Memory context:\n${JSON.stringify(memories || {})}`,
      ].filter(Boolean).join('\n');
      const providerConversation = (messages || []).slice(-24).map(message => message.role === 'tool'
        ? { role: 'user', content: `Tool result (${message.name || 'tool'}):\n${message.content || ''}` }
        : message);
      const providerMessages = await buildAiProviderMessages([
        { role: 'system', content: system },
        ...providerConversation,
      ], options);
      const providerTools = toProviderTools(tools || []);
      const reply = await fetchAiProviderReply({
        options,
        payload: aiProviderPayload({
          options,
          messages: providerMessages,
          stream: false,
          tools: providerTools.length ? providerTools : undefined,
        }),
      });
      const nativeCalls = (reply.toolCalls || []).map(call => {
        const name = call?.function?.name || call?.name || '';
        let args = call?.function?.arguments || call?.arguments || {};
        if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
        return { name: fromProviderName(name, tools), arguments: args };
      }).filter(call => call.name);
      return { text: reply.content || '', toolCalls: nativeCalls, citations: reply.sources || [] };
    },
  };
}

async function createAgentStatus(req) {
  try {
    const options = await resolveAiChatOptions({}, req.user);
    const configured = Boolean(options?.apiKey);
    return {
      configured,
      provider: configured ? (options.provider || '') : '',
      model: configured ? (options.model || '') : '',
    };
  } catch {
    return { configured: false, provider: '', model: '' };
  }
}

function createAgentWebSearch(req) {
  return async function agentWebSearch(args = {}) {
    const query = String(args.query || '').trim().slice(0, 400);
    if (!query) return toolResult({ ok: false, summary: 'Search query is required', errorCode: 'invalid' });
    const options = await resolveAiChatOptions({}, req.user);
    if (!options.webSearchEnabled) {
      return toolResult({
        ok: false,
        summary: 'Web search is disabled. Enable it in Agent settings.',
        errorCode: 'disabled',
      });
    }
    const result = await collectWebSearches(query, {
      tavilyApiKey: options.tavilyApiKey,
      perplexityApiKey: options.perplexityApiKey,
      webSearchEnabled: true,
      webSearchDepth: options.webSearchDepth,
    });
    return toolResult({
      ok: true,
      summary: result.sources.length ? `Found ${result.sources.length} web sources` : 'No web sources found',
      data: result,
      evidence: result.sources.slice(0, 10).map(source => ({ type: 'web', url: source.url, title: source.title })),
    });
  };
}

function createAgentWebFetch(req) {
  const WEB_FETCH_MAX_BYTES = 512 * 1024;
  const WEB_FETCH_TIMEOUT_MS = 15000;
  return async function agentWebFetch(args = {}) {
    const url = String(args.url || '').trim();
    if (!url) return toolResult({ ok: false, summary: 'URL is required', errorCode: 'invalid' });
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return toolResult({ ok: false, summary: 'Invalid URL', errorCode: 'invalid' });
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return toolResult({ ok: false, summary: 'Only http and https URLs are allowed', errorCode: 'denied' });
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WEB_FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        redirect: 'follow',
        headers: { 'User-Agent': 'WorkLog-Agent/1.0' },
      });
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > WEB_FETCH_MAX_BYTES) {
        return toolResult({ ok: false, summary: `Response too large (${buffer.length} bytes)`, errorCode: 'too_large' });
      }
      const contentType = response.headers.get('content-type') || '';
      let text = buffer.toString('utf8');
      if (contentType.includes('html')) {
        text = text
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
      }
      return toolResult({
        ok: true,
        summary: `Fetched ${url}`,
        data: { url, status: response.status, contentType, text: text.slice(0, WEB_FETCH_MAX_BYTES) },
        evidence: [{ type: 'web', url }],
      });
    } catch (error) {
      const message = error?.name === 'AbortError' ? 'Fetch timed out' : error.message;
      return toolResult({ ok: false, summary: message, errorCode: 'fetch_failed', retryable: true });
    } finally {
      clearTimeout(timer);
    }
  };
}

function createAgentWestock(req) {
  return async function agentWestock(args = {}) {
    if (!westockEnabled()) return toolResult({ ok: false, summary: 'WeStock is disabled', errorCode: 'disabled' });
    const tool = typeof args.tool === 'string' ? args.tool : '';
    if (!WESTOCK_ALLOWED_TOOLS.has(tool)) return toolResult({ ok: false, summary: 'Unsupported WeStock tool', errorCode: 'invalid' });
    try {
      const content = await runWestockCli(tool, args.args || {});
      return toolResult({ ok: true, summary: `WeStock ${tool} completed`, data: { tool, content }, evidence: [{ type: 'westock', tool }] });
    } catch (error) {
      return toolResult({ ok: false, summary: error.message, errorCode: 'westock_failed', retryable: true });
    }
  };
}

function createAgentImageGenerate(req) {
  return async function agentImageGenerate(args = {}) {
    const prompt = String(args.prompt || '').trim();
    if (!prompt) return toolResult({ ok: false, summary: 'Image prompt is required', errorCode: 'invalid' });
    if (prompt.length > 4000) return toolResult({ ok: false, summary: 'Image prompt is too long', errorCode: 'invalid' });
    const body = {};
    if (typeof args.model === 'string' && args.model.trim()) body.model = args.model.trim();
    if (typeof args.size === 'string' && args.size.trim()) body.size = args.size.trim();
    if (typeof args.watermark === 'boolean') body.watermark = args.watermark;
    let options;
    try {
      options = resolveSeedreamOptions(body, req.user);
    } catch (error) {
      return toolResult({ ok: false, summary: error.message, errorCode: 'invalid' });
    }
    if (!options.apiKey) {
      return toolResult({
        ok: false,
        summary: 'Seedream API key is not configured. Add it in Agent settings.',
        errorCode: 'unconfigured',
      });
    }
    try {
      const remoteUrl = await requestSeedreamImage({ prompt, ...options });
      const saved = await downloadGeneratedImage(remoteUrl);
      const alt = prompt.slice(0, 80).replace(/[[\]]/g, '');
      const markdown = `![${alt}](${saved.url})`;
      return toolResult({
        ok: true,
        summary: `Generated image saved to ${saved.url}`,
        data: {
          url: saved.url,
          filename: saved.filename,
          markdown,
          prompt,
          model: options.model,
          size: options.size,
        },
        evidence: [{ type: 'image', url: saved.url }],
      });
    } catch (error) {
      return toolResult({ ok: false, summary: error.message, errorCode: 'generate_failed', retryable: true });
    }
  };
}

const { mountNewApis } = require('./lib/http/mount');
mountNewApis(app, { db, authStore, hasDiaryAccess, rejectLockedDiary, requireAdmin, modelClientFor: createAgentModelClient, agentStatusFor: createAgentStatus, webSearchFor: createAgentWebSearch, webFetchFor: createAgentWebFetch, westockRunFor: createAgentWestock, imageGenerateFor: createAgentImageGenerate });

function startServer(port = PORT, host = HOST) {
  if (!isLoopbackHost(host) && authStore.disabled) {
    throw new Error('Account authentication is required when HOST is not loopback');
  }
  const processLock = acquireProcessLock();
  todoReminderService = createTodoReminderCoordinator();
  const server = app.listen(port, host, () => {
    console.log(`Work Log server running at http://${host}:${port}`);
    if (!authStore.disabled) console.log('Account authentication enabled');
    db.checkDataIntegrity();
    todoReminderService.start();
  });
  server.on('error', () => {
    releaseProcessLock(processLock);
  });
  server.on('close', () => {
    todoReminderService?.stop();
    releaseProcessLock(processLock);
  });
  return server;
}

if (require.main === module) {
  startServer();
}

module.exports = {
  app,
  startServer,
  hasDiaryAccess,
  isDiaryCategory,
  createTodoReminderService,
  buildTodoReminderMail,
  createTodoReminderEmailMessage,
  sendTodoReminderEmail,
  getBusinessClockParts,
  sortTodosForReminder,
  getDueTodosForReminder,
};
