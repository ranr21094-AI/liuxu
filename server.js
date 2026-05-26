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
