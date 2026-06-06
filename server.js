require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const db = require('./database');
const { businessDateString } = require('./business-date');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');

// Auth token (optional — set AUTH_TOKEN env var to enable)
const AUTH_TOKEN = process.env.AUTH_TOKEN || null;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';
const DEEPSEEK_BASE_URL = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
const DEEPSEEK_DEFAULT_MODEL = process.env.DEEPSEEK_DEFAULT_MODEL || 'deepseek-v4-flash';
const TAVILY_API_KEY = process.env.TAVILY_API_KEY || '';
const TAVILY_BASE_URL = (process.env.TAVILY_BASE_URL || 'https://api.tavily.com').replace(/\/+$/, '');
const SEEDREAM_API_KEY = process.env.SEEDREAM_API_KEY || '';
const SEEDREAM_BASE_URL = (process.env.SEEDREAM_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3').replace(/\/+$/, '');
const SEEDREAM_DEFAULT_MODEL = process.env.SEEDREAM_DEFAULT_MODEL || 'doubao-seedream-5-0-260128';
const AI_ALLOWED_MODELS = new Set(['deepseek-v4-flash', 'deepseek-v4-pro']);
const AI_ALLOWED_THINKING = new Set(['enabled', 'disabled']);
const AI_ALLOWED_REASONING = new Set(['high', 'max']);
const AI_ALLOWED_SEARCH_DEPTH = new Set(['basic', 'advanced']);
const SEEDREAM_ALLOWED_MODELS = new Set(['doubao-seedream-5-0-260128', 'doubao-seedream-4-5-251128', 'doubao-seedream-4-0-250828']);
const SEEDREAM_ALLOWED_SIZE_KEYWORDS = new Set(['2K', '3K', '4K']);
const AI_MAX_MESSAGES = 20;
const AI_MAX_MESSAGE_CHARS = 4000;
const AI_EDITOR_MAX_TITLE_CHARS = 200;
const AI_EDITOR_MAX_CONTENT_CHARS = 20000;
const AI_EDITOR_MAX_SELECTION_CHARS = 4000;
const AI_EDITOR_MAX_REPLY_CHARS = 4000;
const AI_EDITOR_MAX_INSERT_CHARS = 8000;
const AI_IMAGE_PROMPT_MAX_CHARS = 1200;

// Diary lock (optional — set DIARY_PASSWORD_HASH env var to enable)
const DIARY_PASSWORD_HASH = process.env.DIARY_PASSWORD_HASH || null;
const diaryTokens = new Map(); // token -> createdAt(ms)
const DIARY_TOKEN_TTL = 24 * 60 * 60 * 1000; // 24h
const DIARY_COOKIE_NAME = 'diary_session';

// Clean expired diary tokens every hour
const diaryTokenCleanup = setInterval(() => {
  const now = Date.now();
  for (const [t, createdAt] of diaryTokens) {
    if (now - createdAt > DIARY_TOKEN_TTL) diaryTokens.delete(t);
  }
}, 3600000);
if (diaryTokenCleanup.unref) diaryTokenCleanup.unref();

function hashPassword(pw) {
  return crypto.createHash('sha256').update(pw).digest('hex');
}

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
  if (req.secure) parts.push('Secure');
  return parts.join('; ');
}

function setDiaryCookie(req, res, token) {
  res.setHeader('Set-Cookie', diaryCookieOptions(req, token, Math.floor(DIARY_TOKEN_TTL / 1000)));
}

function clearDiaryCookie(req, res) {
  res.setHeader('Set-Cookie', diaryCookieOptions(req, '', 0));
}

function isValidDiaryToken(token) {
  if (!DIARY_PASSWORD_HASH) return true;
  if (!token) return false;
  const createdAt = diaryTokens.get(token);
  if (!createdAt || Date.now() - createdAt > DIARY_TOKEN_TTL) {
    diaryTokens.delete(token);
    return false;
  }
  return true;
}

function hasDiaryAccess(req) {
  return !DIARY_PASSWORD_HASH || isValidDiaryToken(getDiaryToken(req));
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

function restoreRequiresDiaryAccess() {
  return !!DIARY_PASSWORD_HASH;
}

function isDiaryRoot(category) {
  return category === '\u65e5\u8bb0';
}

// Simple in-memory rate limiter
const rateLimitMap = new Map(); // key -> {count, resetAt}
function rateLimiter(maxAttempts, windowMs) {
  return (req, res, next) => {
    const key = req.ip || '127.0.0.1';
    const now = Date.now();
    let entry = rateLimitMap.get(key);
    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs };
      rateLimitMap.set(key, entry);
    }
    entry.count++;
    if (entry.count > maxAttempts) {
      return res.status(429).json({ error: '请求过于频繁，请稍后再试' });
    }
    next();
  };
}

function authMiddleware(req, res, next) {
  if (!AUTH_TOKEN) return next();
  // Allow static files
  if (!req.path.startsWith('/api/')) return next();
  const auth = req.headers.authorization;
  if (auth === 'Bearer ' + AUTH_TOKEN) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}

app.use(authMiddleware);

// Security headers
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self'");
  next();
});

app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Image upload setup
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, _file, cb) => {
    const ext = path.extname(_file.originalname).toLowerCase();
    const name = Date.now() + '-' + crypto.randomBytes(6).toString('hex') + ext;
    cb(null, name);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
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

// Auth check endpoint
app.get('/api/auth/check', (req, res) => {
  if (!AUTH_TOKEN) return res.json({ authenticated: true });
  const auth = req.headers.authorization;
  res.json({ authenticated: auth === 'Bearer ' + AUTH_TOKEN });
});

// Diary unlock
app.post('/api/auth/diary', rateLimiter(5, 15 * 60 * 1000), (req, res) => {
  if (!DIARY_PASSWORD_HASH) return res.json({ unlocked: true });
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: '请输入密码' });
  if (hashPassword(password) === DIARY_PASSWORD_HASH) {
    const token = generateToken();
    diaryTokens.set(token, Date.now());
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

// Diary status
app.get('/api/auth/diary/status', (req, res) => {
  if (!DIARY_PASSWORD_HASH) return res.json({ enabled: false, locked: false });
  const token = getDiaryToken(req);
  if (!token) return res.json({ enabled: true, locked: true });
  res.json({ enabled: true, locked: !isValidDiaryToken(token) });
});

function normalizeAiMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > AI_MAX_MESSAGES) {
    throw new Error('messages must be a non-empty array with at most 20 items');
  }

  return messages.map((message) => {
    const role = message && message.role;
    const content = typeof message?.content === 'string' ? message.content.trim() : '';
    if (!['user', 'assistant'].includes(role)) {
      throw new Error('message role must be user or assistant');
    }
    if (!content || content.length > AI_MAX_MESSAGE_CHARS) {
      throw new Error('message content is required and must be 4000 characters or fewer');
    }
    return { role, content };
  });
}

function normalizeEditorContext(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('editorContext must be an object');
  }
  if (typeof value.title !== 'string' || typeof value.content !== 'string') {
    throw new Error('editorContext title and content must be strings');
  }

  const originalContent = value.content;
  const title = value.title.slice(0, AI_EDITOR_MAX_TITLE_CHARS);
  const content = originalContent.slice(0, AI_EDITOR_MAX_CONTENT_CHARS);
  const selection = value.selection && typeof value.selection === 'object' && !Array.isArray(value.selection)
    ? value.selection
    : {};
  const rawStart = Number(selection.start);
  const rawEnd = Number(selection.end);
  const start = Number.isFinite(rawStart)
    ? Math.max(0, Math.min(content.length, Math.trunc(rawStart)))
    : 0;
  const end = Number.isFinite(rawEnd)
    ? Math.max(start, Math.min(content.length, Math.trunc(rawEnd)))
    : start;

  return {
    logId: typeof value.logId === 'string' || typeof value.logId === 'number' ? String(value.logId).slice(0, 80) : '',
    title,
    content,
    contentTruncated: originalContent.length > content.length,
    selection: {
      start,
      end,
      text: content.slice(start, end).slice(0, AI_EDITOR_MAX_SELECTION_CHARS),
    },
  };
}

function buildEditorContextPrompt(editorContext, search) {
  const searchContext = buildSearchContext(search);
  return [
    'You are an AI writing assistant embedded inside a Markdown work-log editor.',
    'Use only the editor context explicitly provided below and the user messages. Do not claim to have written to the log.',
    'Return ONLY valid JSON without Markdown fences. Schema: {"reply":"short explanation","suggestedTitle":"optional new title","suggestedContent":"optional full replacement Markdown","insertText":"optional Markdown to insert at cursor or replace selection"}.',
    'Keep suggestions focused on title and Markdown body only. Do not change dates, hours, categories, files, or storage.',
    searchContext ? `Optional web search context:\n${searchContext}` : '',
    'Current editor context:',
    `logId: ${editorContext.logId || 'draft'}`,
    `title: ${editorContext.title}`,
    `contentTruncated: ${editorContext.contentTruncated}`,
    `selectionStart: ${editorContext.selection.start}`,
    `selectionEnd: ${editorContext.selection.end}`,
    `selectionText:\n${editorContext.selection.text}`,
    `markdownContent:\n${editorContext.content}`,
  ].filter(Boolean).join('\n\n');
}

function extractJsonObject(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {}
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch {}
  }
  return null;
}

function normalizeEditorSuggestion(rawText) {
  const parsed = extractJsonObject(rawText);
  const source = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { reply: rawText };
  const reply = typeof source.reply === 'string'
    ? source.reply.trim().slice(0, AI_EDITOR_MAX_REPLY_CHARS)
    : String(rawText || '').trim().slice(0, AI_EDITOR_MAX_REPLY_CHARS);
  const suggestion = {
    reply: reply || '我整理了一些可应用到当前日志的建议。',
  };
  if (typeof source.suggestedTitle === 'string' && source.suggestedTitle.trim()) {
    suggestion.suggestedTitle = source.suggestedTitle.trim().slice(0, AI_EDITOR_MAX_TITLE_CHARS);
  }
  if (typeof source.suggestedContent === 'string' && source.suggestedContent.trim()) {
    suggestion.suggestedContent = source.suggestedContent.slice(0, AI_EDITOR_MAX_CONTENT_CHARS);
  }
  if (typeof source.insertText === 'string' && source.insertText.trim()) {
    suggestion.insertText = source.insertText.slice(0, AI_EDITOR_MAX_INSERT_CHARS);
  }
  return suggestion;
}

function normalizeImagePromptSuggestion(rawText, originalPrompt) {
  const parsed = extractJsonObject(rawText);
  const candidate = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed.prompt
    : rawText;
  const prompt = typeof candidate === 'string' ? candidate.trim() : '';
  return (prompt || originalPrompt).slice(0, AI_IMAGE_PROMPT_MAX_CHARS);
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
    .slice(0, maxLength)
    .trim();
}

function safeTavilyError(status, data) {
  const detail = sanitizeProviderText(data?.error || data?.message || data?.detail || '', 240);
  return detail
    ? `Tavily request failed (${status}): ${detail}`
    : `Tavily request failed (${status})`;
}

function parseAiSettingsInput(body) {
  const model = body?.model || 'deepseek-v4-flash';
  const reasoningEffort = body?.reasoningEffort || 'high';
  const stream = body?.stream === undefined ? false : body.stream;
  const webSearchEnabled = body?.webSearchEnabled === undefined ? false : body.webSearchEnabled;
  const webSearchDepth = body?.webSearchDepth || 'basic';
  const seedreamModel = body?.seedreamModel || SEEDREAM_DEFAULT_MODEL;
  const seedreamSize = body?.seedreamSize || '2K';
  const seedreamWatermark = body?.seedreamWatermark === undefined ? true : body.seedreamWatermark;
  if (!AI_ALLOWED_MODELS.has(model)) {
    throw new Error('Unsupported AI model');
  }
  if (!AI_ALLOWED_REASONING.has(reasoningEffort)) {
    throw new Error('Unsupported reasoning effort');
  }
  if (typeof stream !== 'boolean') {
    throw new Error('Unsupported stream option');
  }
  if (typeof webSearchEnabled !== 'boolean') {
    throw new Error('Unsupported web search option');
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
  return {
    apiKey: typeof body?.apiKey === 'string' ? body.apiKey.trim() : '',
    model,
    reasoningEffort,
    stream,
    tavilyApiKey: typeof body?.tavilyApiKey === 'string' ? body.tavilyApiKey.trim() : '',
    webSearchEnabled,
    webSearchDepth,
    seedreamApiKey: typeof body?.seedreamApiKey === 'string' ? body.seedreamApiKey.trim() : '',
    seedreamModel,
    seedreamSize,
    seedreamWatermark,
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

function resolveSeedreamOptions(body) {
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
    apiKey: saved.seedreamApiKey || SEEDREAM_API_KEY,
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

async function downloadGeneratedImage(url) {
  const imageResponse = await fetch(url);
  if (!imageResponse.ok) {
    throw new Error(`Generated image download failed (${imageResponse.status})`);
  }
  const contentType = imageResponse.headers.get('content-type') || '';
  if (contentType && !/^image\//i.test(contentType)) {
    throw new Error('Generated image response was not an image');
  }
  const buffer = Buffer.from(await imageResponse.arrayBuffer());
  if (!buffer.length || buffer.length > 20 * 1024 * 1024) {
    throw new Error('Generated image size is invalid');
  }
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  const ext = extensionFromContentType(contentType, url);
  const filename = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`;
  fs.writeFileSync(path.join(UPLOADS_DIR, filename), buffer);
  return { filename, url: `/uploads/${filename}` };
}

function resolveAiChatOptions(body) {
  const saved = db.getAiSettings();
  const model = body?.model || saved.model || DEEPSEEK_DEFAULT_MODEL;
  const thinkingMode = body?.thinkingMode || 'enabled';
  const reasoningEffort = body?.reasoningEffort || saved.reasoningEffort || 'high';
  const stream = body?.stream === undefined ? Boolean(saved.stream) : body.stream;
  const webSearchEnabled = body?.webSearchEnabled === undefined ? Boolean(saved.webSearchEnabled) : body.webSearchEnabled;
  const webSearchDepth = body?.webSearchDepth || saved.webSearchDepth || 'basic';

  if (!AI_ALLOWED_MODELS.has(model)) {
    throw new Error('Unsupported AI model');
  }
  if (!AI_ALLOWED_THINKING.has(thinkingMode)) {
    throw new Error('Unsupported thinking mode');
  }
  if (thinkingMode === 'enabled' && !AI_ALLOWED_REASONING.has(reasoningEffort)) {
    throw new Error('Unsupported reasoning effort');
  }
  if (typeof stream !== 'boolean') {
    throw new Error('Unsupported stream option');
  }
  if (typeof webSearchEnabled !== 'boolean') {
    throw new Error('Unsupported web search option');
  }
  if (!AI_ALLOWED_SEARCH_DEPTH.has(webSearchDepth)) {
    throw new Error('Unsupported web search depth');
  }

  const requestApiKey = typeof body?.apiKey === 'string' ? body.apiKey.trim() : '';
  const requestTavilyApiKey = typeof body?.tavilyApiKey === 'string' ? body.tavilyApiKey.trim() : '';
  return {
    apiKey: requestApiKey || saved.apiKey || DEEPSEEK_API_KEY,
    model,
    thinkingMode,
    reasoningEffort,
    stream,
    tavilyApiKey: requestTavilyApiKey || saved.tavilyApiKey || TAVILY_API_KEY,
    webSearchEnabled,
    webSearchDepth,
  };
}

function inferTavilyTopic(query) {
  return /最新|最近|今天|今日|当前|新闻|current|latest|recent|today|news/i.test(query) ? 'news' : 'general';
}

function normalizeTavilySources(results) {
  if (!Array.isArray(results)) return [];
  return results.slice(0, 5).map((item) => ({
    title: sanitizeProviderText(item?.title || item?.url || 'Source', 120),
    url: typeof item?.url === 'string' ? item.url.slice(0, 800) : '',
    content: sanitizeProviderText(item?.content || '', 700),
    score: Number.isFinite(Number(item?.score)) ? Number(item.score) : null,
  })).filter(item => item.url);
}

function buildSearchContext(search) {
  if (!search) return '';
  const lines = [
    'Web search results from Tavily. Use them only to answer the user question, cite source URLs when relevant, and say when results are insufficient.',
    `Search query: ${search.query}`,
  ];
  if (search.answer) lines.push(`Tavily answer: ${search.answer}`);
  search.sources.forEach((source, index) => {
    lines.push(`[${index + 1}] ${source.title}`);
    lines.push(`URL: ${source.url}`);
    if (source.content) lines.push(`Snippet: ${source.content}`);
  });
  return lines.join('\n');
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
  const upstream = await fetch(`${TAVILY_BASE_URL}/search`, {
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

function sseWrite(res, event, data = {}) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function parseDeepSeekStreamEvent(block) {
  const event = { type: 'message', data: '' };
  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('event:')) event.type = line.slice(6).trim() || 'message';
    if (line.startsWith('data:')) event.data += line.slice(5).trimStart();
  }
  return event;
}

async function pipeDeepSeekStream(upstream, res, sources = []) {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  if (!upstream.ok) {
    const data = await upstream.json().catch(() => ({}));
    sseWrite(res, 'error', { error: safeDeepSeekError(upstream.status, data) });
    return res.end();
  }

  try {
    const reader = upstream.body?.getReader ? upstream.body.getReader() : null;
    if (!reader) throw new Error('DeepSeek stream is not readable');
    const decoder = new TextDecoder();
    let buffer = '';
    let doneSent = false;

    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() || '';
      for (const block of blocks) {
        const event = parseDeepSeekStreamEvent(block);
        if (!event.data) continue;
        if (event.data === '[DONE]') {
          sseWrite(res, 'done', { sources });
          doneSent = true;
          continue;
        }
        const data = JSON.parse(event.data);
        const delta = data?.choices?.[0]?.delta?.content || data?.choices?.[0]?.message?.content || '';
        if (typeof delta === 'string' && delta) sseWrite(res, 'delta', { content: delta });
      }
    }

    if (buffer.trim()) {
      const event = parseDeepSeekStreamEvent(buffer);
      if (event.data && event.data !== '[DONE]') {
        const data = JSON.parse(event.data);
        const delta = data?.choices?.[0]?.delta?.content || data?.choices?.[0]?.message?.content || '';
        if (typeof delta === 'string' && delta) sseWrite(res, 'delta', { content: delta });
      }
    }
    if (!doneSent) sseWrite(res, 'done', { sources });
    res.end();
  } catch {
    sseWrite(res, 'error', { error: 'DeepSeek stream failed' });
    res.end();
  }
}

app.get('/api/ai/settings', (_req, res) => {
  try {
    res.json(db.getAiSettings());
  } catch (err) {
    res.status(500).json({ error: 'Failed to load AI settings' });
  }
});

app.put('/api/ai/settings', (req, res) => {
  try {
    const saved = db.saveAiSettings(parseAiSettingsInput(req.body));
    res.json(saved);
  } catch (err) {
    res.status(400).json({ error: err.message || 'Failed to save AI settings' });
  }
});

app.post('/api/ai/image/prompt', async (req, res) => {
  try {
    const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
    const context = typeof req.body?.context === 'string' ? req.body.context.trim().slice(0, 2000) : '';
    if (!prompt || prompt.length > AI_IMAGE_PROMPT_MAX_CHARS) {
      return res.status(400).json({ error: 'Prompt is required and must be 1200 characters or fewer' });
    }
    const {
      apiKey,
      model,
      thinkingMode,
      reasoningEffort,
    } = resolveAiChatOptions({ ...req.body, stream: false, thinkingMode: 'enabled' });
    if (!apiKey) {
      return res.status(503).json({ error: 'DeepSeek API key is not configured' });
    }

    const systemPrompt = [
      'You refine user requests into image-generation prompts.',
      'Return ONLY valid JSON without Markdown fences: {"prompt":"..."}',
      'Preserve the user intent, subject, language, and important constraints.',
      'Make the prompt visually useful by adding concise composition, style, lighting, and detail hints when appropriate.',
      'Do not mention that you are an AI. Do not add unrelated people, brands, private data, or unsafe content.',
    ].join('\n');
    const userPrompt = [
      `Original user request:\n${prompt}`,
      context ? `Optional editor context for inspiration, provided by the user interface:\n${context}` : '',
    ].filter(Boolean).join('\n\n');

    const payload = {
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      thinking: { type: thinkingMode },
      stream: false,
    };
    if (thinkingMode === 'enabled') payload.reasoning_effort = reasoningEffort;

    const upstream = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      return res.status(502).json({ error: safeDeepSeekError(upstream.status, data) });
    }
    const reply = data?.choices?.[0]?.message?.content;
    if (typeof reply !== 'string') {
      return res.status(502).json({ error: 'DeepSeek response was empty' });
    }
    res.json({ prompt: normalizeImagePromptSuggestion(reply, prompt) });
  } catch (err) {
    const status = err.status || (/Prompt|Unsupported/.test(err.message) ? 400 : 500);
    res.status(status).json({ error: status === 400 || status === 503 || status === 502 ? err.message : 'Image prompt optimization failed' });
  }
});

app.post('/api/ai/image/generate', async (req, res) => {
  try {
    const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
    const image = typeof req.body?.image === 'string' ? req.body.image.trim() : '';
    if (!prompt || prompt.length > 1200) {
      return res.status(400).json({ error: 'Prompt is required and must be 1200 characters or fewer' });
    }
    if (image && image.length > 12000) {
      return res.status(400).json({ error: 'Reference image is too large' });
    }
    const { apiKey, model, size, watermark } = resolveSeedreamOptions(req.body);
    if (!apiKey) {
      return res.status(503).json({ error: 'Seedream API key is not configured' });
    }

    const payload = {
      model,
      prompt,
      size,
      response_format: 'url',
      extra_body: {
        watermark,
      },
    };
    if (image) payload.extra_body.image = image;

    const upstream = await fetch(`${SEEDREAM_BASE_URL}/images/generations`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      return res.status(502).json({ error: safeSeedreamError(upstream.status, data) });
    }
    const generatedUrl = data?.data?.[0]?.url;
    if (typeof generatedUrl !== 'string' || !generatedUrl) {
      return res.status(502).json({ error: 'Seedream response did not include an image URL' });
    }

    const saved = await downloadGeneratedImage(generatedUrl);
    res.json({ ...saved, prompt, model, size });
  } catch (err) {
    const status = /Unsupported|Prompt|Reference image/.test(err.message) ? 400 : 500;
    res.status(status).json({ error: status === 400 ? err.message : 'Seedream image generation failed' });
  }
});

app.post('/api/ai/chat', async (req, res) => {
  try {
    const messages = normalizeAiMessages(req.body?.messages);
    const {
      apiKey,
      model,
      thinkingMode,
      reasoningEffort,
      stream,
      tavilyApiKey,
      webSearchEnabled,
      webSearchDepth,
    } = resolveAiChatOptions(req.body);
    if (!apiKey) {
      return res.status(503).json({ error: 'DeepSeek API key is not configured' });
    }

    let search = null;
    let deepSeekMessages = messages;
    if (webSearchEnabled) {
      const lastUserMessage = [...messages].reverse().find(message => message.role === 'user');
      search = await runTavilySearch(lastUserMessage.content, { tavilyApiKey, webSearchDepth });
      deepSeekMessages = [
        { role: 'system', content: buildSearchContext(search) },
        ...messages,
      ];
    }

    const payload = {
      model,
      messages: deepSeekMessages,
      thinking: { type: thinkingMode },
      stream,
    };
    if (thinkingMode === 'enabled') payload.reasoning_effort = reasoningEffort;

    const upstream = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (stream) {
      return pipeDeepSeekStream(upstream, res, search?.sources || []);
    }

    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      return res.status(502).json({ error: safeDeepSeekError(upstream.status, data) });
    }

    const reply = data?.choices?.[0]?.message?.content;
    if (typeof reply !== 'string') {
      return res.status(502).json({ error: 'DeepSeek response was empty' });
    }

    res.json({ message: { role: 'assistant', content: reply }, sources: search?.sources || [] });
  } catch (err) {
    const status = err.status || (/messages|message role|message content|Unsupported/.test(err.message) ? 400 : 500);
    res.status(status).json({ error: status === 400 || status === 503 || status === 502 ? err.message : 'AI chat failed' });
  }
});

app.post('/api/ai/editor', async (req, res) => {
  try {
    const messages = normalizeAiMessages(req.body?.messages);
    const editorContext = normalizeEditorContext(req.body?.editorContext);
    const {
      apiKey,
      model,
      thinkingMode,
      reasoningEffort,
      tavilyApiKey,
      webSearchEnabled,
      webSearchDepth,
    } = resolveAiChatOptions({ ...req.body, stream: false, thinkingMode: 'enabled' });
    if (!apiKey) {
      return res.status(503).json({ error: 'DeepSeek API key is not configured' });
    }

    let search = null;
    if (webSearchEnabled) {
      const lastUserMessage = [...messages].reverse().find(message => message.role === 'user');
      search = await runTavilySearch(lastUserMessage.content, { tavilyApiKey, webSearchDepth });
    }

    const payload = {
      model,
      messages: [
        { role: 'system', content: buildEditorContextPrompt(editorContext, search) },
        ...messages,
      ],
      thinking: { type: thinkingMode },
      stream: false,
    };
    if (thinkingMode === 'enabled') payload.reasoning_effort = reasoningEffort;

    const upstream = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      return res.status(502).json({ error: safeDeepSeekError(upstream.status, data) });
    }

    const reply = data?.choices?.[0]?.message?.content;
    if (typeof reply !== 'string') {
      return res.status(502).json({ error: 'DeepSeek response was empty' });
    }

    const editorSuggestion = normalizeEditorSuggestion(reply);
    res.json({
      message: { role: 'assistant', content: editorSuggestion.reply },
      editorSuggestion,
      sources: search?.sources || [],
    });
  } catch (err) {
    const status = err.status || (/messages|message role|message content|editorContext|Unsupported/.test(err.message) ? 400 : 500);
    res.status(status).json({ error: status === 400 || status === 503 || status === 502 ? err.message : 'AI editor chat failed' });
  }
});

app.get('/api/ai/conversations', (_req, res) => {
  try {
    res.json(db.getAiChats());
  } catch (err) {
    res.status(500).json({ error: 'Failed to load AI conversations' });
  }
});

app.put('/api/ai/conversations', (req, res) => {
  try {
    const saved = db.saveAiChats({
      conversations: req.body?.conversations,
      activeConversationId: req.body?.activeConversationId,
    });
    res.json(saved);
  } catch (err) {
    res.status(400).json({ error: 'Failed to save AI conversations' });
  }
});

// List logs with filters
app.get('/api/logs', (req, res) => {
  try {
    const diaryUnlocked = hasDiaryAccess(req);
    const result = db.getAll(req.query, diaryUnlocked);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reorder logs (must be before :id routes)
app.put('/api/logs/reorder', (req, res) => {
  try {
    const { orderedIds } = req.body;
    if (!Array.isArray(orderedIds)) {
      return res.status(400).json({ error: 'orderedIds array required' });
    }
    const touchesDiary = orderedIds
      .map(id => db.getById(parseInt(id)))
      .some(logRequiresDiaryAccess);
    if (touchesDiary && !hasDiaryAccess(req)) return rejectLockedDiary(res);
    db.reorderLogs(orderedIds);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get single log
app.get('/api/logs/:id', (req, res) => {
  try {
    const log = db.getById(parseInt(req.params.id));
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
    const { title, content, category, hours, log_date } = req.body;
    if (!title || !content) {
      return res.status(400).json({ error: 'Title and content are required' });
    }
    if (hours !== undefined && hours !== null && hours !== '') {
      const h = parseFloat(hours);
      if (isNaN(h) || h < 0 || h > 24) return res.status(400).json({ error: '工时需为 0-24 之间的数字' });
    }
    if (log_date && !isValidDate(log_date)) {
      return res.status(400).json({ error: '日期格式无效' });
    }
    if (isDiaryCategory(category) && !hasDiaryAccess(req)) return rejectLockedDiary(res);
    const entry = db.create({ title, content, category, hours, log_date });
    res.status(201).json(entry);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update log
app.put('/api/logs/:id', (req, res) => {
  try {
    const { title, content, category, hours, log_date } = req.body;
    if (hours !== undefined && hours !== null && hours !== '') {
      const h = parseFloat(hours);
      if (isNaN(h) || h < 0 || h > 24) return res.status(400).json({ error: '工时需为 0-24 之间的数字' });
    }
    if (log_date && !isValidDate(log_date)) {
      return res.status(400).json({ error: '日期格式无效' });
    }
    const existing = db.getById(parseInt(req.params.id));
    if (!existing) return res.status(404).json({ error: 'Log not found' });
    if ((logRequiresDiaryAccess(existing) || isDiaryCategory(category)) && !hasDiaryAccess(req)) return rejectLockedDiary(res);
    const entry = db.update(parseInt(req.params.id), { title, content, category, hours, log_date });
    res.json(entry);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete log
app.delete('/api/logs/:id', (req, res) => {
  try {
    const log = db.getById(parseInt(req.params.id));
    if (!log) return res.status(404).json({ error: 'Log not found' });
    if (logRequiresDiaryAccess(log) && !hasDiaryAccess(req)) return rejectLockedDiary(res);
    const ok = db.remove(parseInt(req.params.id));
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
    if (restoreRequiresDiaryAccess() && !hasDiaryAccess(req)) return rejectLockedDiary(res);
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
    if (restoreRequiresDiaryAccess() && !hasDiaryAccess(req)) return rejectLockedDiary(res);
    const mode = req.query.mode === 'merge' ? 'merge' : 'replace';
    const result = db.restore(req.body, mode);
    if (result.error) return res.status(400).json(result);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Todo routes
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
    const { title } = req.body;
    if (!title || !title.trim()) {
      return res.status(400).json({ error: 'Title is required' });
    }
    const entry = db.createTodo(req.body);
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
    if (!Array.isArray(orderedIds)) {
      return res.status(400).json({ error: 'orderedIds array required' });
    }
    db.reorderTodos(orderedIds);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/todos/:id', (req, res) => {
  try {
    const entry = db.updateTodo(parseInt(req.params.id), req.body);
    if (!entry) return res.status(404).json({ error: 'Todo not found' });
    res.json(entry);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/todos/:id', (req, res) => {
  try {
    const ok = db.removeTodo(parseInt(req.params.id));
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
  const filePath = path.join(UPLOADS_DIR, filename);
  const resolved = path.resolve(filePath);
  const root = path.resolve(UPLOADS_DIR);
  return resolved.startsWith(root + path.sep) && resolved !== root ? resolved : null;
}

// Uploaded image access; diary-linked images require an unlocked diary session.
app.get('/uploads/:filename', (req, res) => {
  try {
    const filePath = resolveUploadPath(req.params.filename);
    if (!filePath) return res.status(403).json({ error: 'Invalid filename' });
    if (db.isPrivateUpload(req.params.filename) && !hasDiaryAccess(req)) return rejectLockedDiary(res);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: '文件不存在' });
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
    res.json(db.getAllCategories(diaryUnlocked, Boolean(DIARY_PASSWORD_HASH) && diaryUnlocked));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/categories', (req, res) => {
  try {
    const { name, parent } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Name required' });
    if ((isDiaryCategory(name.trim()) || isDiaryCategory(parent)) && !hasDiaryAccess(req)) {
      return rejectLockedDiary(res);
    }
    const result = db.addCategory(name, parent || null);
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

app.patch('/api/categories/:name/calendar-day-visibility', (req, res) => {
  try {
    const name = decodeURIComponent(req.params.name);
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
    const oldName = decodeURIComponent(req.params.oldName);
    const newName = req.body.name;
    if (isDiaryRoot(oldName) || isDiaryRoot(newName)) {
      return res.status(409).json({ error: 'Diary root category is protected' });
    }
    if ((isDiaryCategory(oldName) || isDiaryCategory(newName)) && !hasDiaryAccess(req)) {
      return rejectLockedDiary(res);
    }
    const result = db.renameCategory(oldName, newName);
    if (result.error) return res.status(400).json(result);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/categories/:name', (req, res) => {
  try {
    const name = decodeURIComponent(req.params.name);
    if (isDiaryRoot(name)) return res.status(409).json({ error: 'Diary root category is protected' });
    if (isDiaryCategory(name) && !hasDiaryAccess(req)) return rejectLockedDiary(res);
    const ok = db.deleteCategory(name);
    if (!ok) return res.status(404).json({ error: 'Category not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function startServer(port = PORT) {
  return app.listen(port, () => {
    console.log(`Work Log server running at http://localhost:${port}`);
    if (AUTH_TOKEN) console.log('Authentication enabled (AUTH_TOKEN is set)');
    db.checkDataIntegrity();
  });
}

if (require.main === module) {
  startServer();
}

module.exports = { app, startServer, hasDiaryAccess, isDiaryCategory };
