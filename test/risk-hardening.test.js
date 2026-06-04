const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { JSDOM } = require('jsdom');
const createDOMPurify = require('dompurify');
const katex = require('katex');
const markedPackage = require('marked');
const businessDate = require('../business-date');

const ROOT = path.resolve(__dirname, '..');
const DIARY_CATEGORY = '\u65e5\u8bb0';
const OTHER_CATEGORY = '\u5176\u4ed6';

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function makeTempDataDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'schedule-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function clearAppModules() {
  for (const file of ['server.js', 'database.js']) {
    delete require.cache[require.resolve(path.join(ROOT, file))];
  }
}

function loadFreshApp(t, { diaryPassword, authToken, deepseekApiKey, deepseekBaseUrl, deepseekDefaultModel } = {}) {
  const dataDir = makeTempDataDir(t);
  process.env.DATA_DIR = dataDir;
  if (diaryPassword) {
    process.env.DIARY_PASSWORD_HASH = sha256(diaryPassword);
  } else {
    process.env.DIARY_PASSWORD_HASH = '';
  }
  process.env.AUTH_TOKEN = authToken || '';
  process.env.DEEPSEEK_API_KEY = deepseekApiKey || '';
  process.env.DEEPSEEK_BASE_URL = deepseekBaseUrl || 'https://api.deepseek.com';
  process.env.DEEPSEEK_DEFAULT_MODEL = deepseekDefaultModel || 'deepseek-v4-flash';
  clearAppModules();

  const db = require(path.join(ROOT, 'database.js'));
  const { app } = require(path.join(ROOT, 'server.js'));
  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  t.after(() => new Promise(resolve => server.close(resolve)));
  t.after(() => {
    delete process.env.DATA_DIR;
    delete process.env.DIARY_PASSWORD_HASH;
    delete process.env.AUTH_TOKEN;
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_BASE_URL;
    delete process.env.DEEPSEEK_DEFAULT_MODEL;
    clearAppModules();
  });

  return { app, db, baseUrl, dataDir };
}

function loadFreshDb(t) {
  const dataDir = makeTempDataDir(t);
  process.env.DATA_DIR = dataDir;
  clearAppModules();
  const db = require(path.join(ROOT, 'database.js'));
  t.after(() => {
    delete process.env.DATA_DIR;
    clearAppModules();
  });
  return db;
}

async function unlockDiary(baseUrl, password = 'secret') {
  const res = await fetch(`${baseUrl}/api/auth/diary`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.token, undefined);
  const setCookie = res.headers.get('set-cookie') || '';
  assert.match(setCookie, /^diary_session=/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  return setCookie.split(';')[0];
}

test('diary lock protects detail, mutation, backup, restore, and reorder routes', async (t) => {
  const { db, baseUrl } = loadFreshApp(t, { diaryPassword: 'secret' });
  const diary = db.create({
    title: 'private',
    content: 'hidden',
    category: DIARY_CATEGORY,
    log_date: '2026-05-16',
  });
  const normal = db.create({
    title: 'public',
    content: 'visible',
    category: '\u5f00\u53d1',
    log_date: '2026-05-16',
  });

  assert.equal((await fetch(`${baseUrl}/api/logs/${diary.id}`)).status, 403);
  assert.equal((await fetch(`${baseUrl}/api/logs/${diary.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'changed' }),
  })).status, 403);
  assert.equal((await fetch(`${baseUrl}/api/logs/${diary.id}`, { method: 'DELETE' })).status, 403);
  assert.equal((await fetch(`${baseUrl}/api/logs/reorder`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderedIds: [diary.id, normal.id] }),
  })).status, 403);
  assert.equal((await fetch(`${baseUrl}/api/logs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'new private',
      content: 'hidden',
      category: DIARY_CATEGORY,
      log_date: '2026-05-16',
    }),
  })).status, 403);
  assert.equal((await fetch(`${baseUrl}/api/backup`)).status, 403);
  assert.equal((await fetch(`${baseUrl}/api/restore`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ logs: [], todos: [], categories: [{ name: OTHER_CATEGORY, sub: [] }] }),
  })).status, 403);
  const lockedCategoryNames = (await (await fetch(`${baseUrl}/api/categories`)).json()).map(category => category.name);
  assert.equal(lockedCategoryNames.includes(DIARY_CATEGORY), false);

  let cookie = await unlockDiary(baseUrl);
  const formerToken = cookie.substring(cookie.indexOf('=') + 1);
  assert.equal((await fetch(`${baseUrl}/api/logs/${diary.id}?diary_token=${formerToken}`)).status, 403);
  assert.equal((await fetch(`${baseUrl}/api/logs/${diary.id}`, {
    headers: { Cookie: cookie },
  })).status, 200);
  assert.equal((await fetch(`${baseUrl}/api/backup`, {
    headers: { Cookie: cookie },
  })).status, 200);
  const unlockedCategoryNames = (await (await fetch(`${baseUrl}/api/categories`, {
    headers: { Cookie: cookie },
  })).json()).map(category => category.name);
  assert.equal(unlockedCategoryNames.includes(DIARY_CATEGORY), true);
  const diaryList = await (await fetch(`${baseUrl}/api/logs?category=${encodeURIComponent(DIARY_CATEGORY)}`, {
    headers: { Cookie: cookie },
  })).json();
  assert.equal(diaryList.total, 1);
  assert.equal(diaryList.items[0].id, diary.id);
  assert.equal((await fetch(`${baseUrl}/api/logs`, {
    headers: { Cookie: cookie },
  })).status, 200);
  assert.equal((await fetch(`${baseUrl}/api/logs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      diary_token: formerToken,
      title: 'body token private',
      content: 'hidden',
      category: `${DIARY_CATEGORY}/notes`,
      log_date: '2026-05-16',
    }),
  })).status, 403);
  assert.equal((await fetch(`${baseUrl}/api/logs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({
      title: 'new private',
      content: 'hidden',
      category: `${DIARY_CATEGORY}/notes`,
      log_date: '2026-05-16',
    }),
  })).status, 201);
});

test('diary category root is reserved and subcategory details require unlock', async (t) => {
  const { db, baseUrl } = loadFreshApp(t, { diaryPassword: 'secret' });
  db.addCategory(DIARY_CATEGORY, null);
  db.addCategory('notes', DIARY_CATEGORY);
  const diary = db.create({
    title: 'private',
    content: 'hidden',
    category: `${DIARY_CATEGORY}/notes`,
    log_date: '2026-05-16',
  });

  const lockedCategories = await (await fetch(`${baseUrl}/api/categories`)).json();
  assert.deepEqual(lockedCategories.find(c => c.name === DIARY_CATEGORY).sub, []);
  assert.equal((await fetch(`${baseUrl}/api/categories`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'secret', parent: DIARY_CATEGORY }),
  })).status, 403);
  assert.equal((await fetch(`${baseUrl}/api/categories/${encodeURIComponent(`${DIARY_CATEGORY}/notes`)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'renamed' }),
  })).status, 403);
  assert.equal((await fetch(`${baseUrl}/api/categories/${encodeURIComponent(`${DIARY_CATEGORY}/notes`)}`, {
    method: 'DELETE',
  })).status, 403);
  assert.equal((await fetch(`${baseUrl}/api/categories/${encodeURIComponent(DIARY_CATEGORY)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'public' }),
  })).status, 409);
  assert.equal((await fetch(`${baseUrl}/api/categories/${encodeURIComponent(DIARY_CATEGORY)}`, {
    method: 'DELETE',
  })).status, 409);
  assert.equal((await (await fetch(`${baseUrl}/api/logs`)).json()).total, 0);

  const cookie = await unlockDiary(baseUrl);
  const unlockedCategories = await (await fetch(`${baseUrl}/api/categories`, {
    headers: { Cookie: cookie },
  })).json();
  assert.deepEqual(unlockedCategories.find(c => c.name === DIARY_CATEGORY).sub, ['notes']);
  assert.equal((await fetch(`${baseUrl}/api/categories/${encodeURIComponent(DIARY_CATEGORY)}`, {
    method: 'DELETE',
    headers: { Cookie: cookie },
  })).status, 409);
  assert.equal((await fetch(`${baseUrl}/api/categories/${encodeURIComponent(`${DIARY_CATEGORY}/notes`)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ name: 'renamed' }),
  })).status, 200);
  assert.equal((await fetch(`${baseUrl}/api/logs/${diary.id}`, {
    headers: { Cookie: cookie },
  })).status, 200);
});

test('unlocked system diary category can receive a new subcategory without prior stored root', async (t) => {
  const { baseUrl } = loadFreshApp(t, { diaryPassword: 'secret' });
  const cookie = await unlockDiary(baseUrl);

  const categories = await (await fetch(`${baseUrl}/api/categories`, {
    headers: { Cookie: cookie },
  })).json();
  assert.deepEqual(categories.find(category => category.name === DIARY_CATEGORY), {
    name: DIARY_CATEGORY,
    sub: [],
    log_count: 0,
    sub_log_counts: {},
    calendar_day_visible: true,
  });

  const created = await fetch(`${baseUrl}/api/categories`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ name: 'notes', parent: DIARY_CATEGORY }),
  });
  assert.equal(created.status, 201);
  const after = await (await fetch(`${baseUrl}/api/categories`, {
    headers: { Cookie: cookie },
  })).json();
  assert.deepEqual(after.find(category => category.name === DIARY_CATEGORY).sub, ['notes']);
});

test('category calendar-day visibility only hides logs from date browsing', async (t) => {
  const { db, baseUrl } = loadFreshApp(t);
  db.addCategory('隐藏日分类', null);
  const hidden = db.create({
    title: 'hidden on date',
    content: 'still accessible by month',
    category: '隐藏日分类',
    log_date: '2026-05-16',
  });
  const publicLog = db.create({
    title: 'visible on date',
    content: 'visible',
    category: OTHER_CATEGORY,
    log_date: '2026-05-17',
  });

  const updated = await fetch(`${baseUrl}/api/categories/${encodeURIComponent('隐藏日分类')}/calendar-day-visibility`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ visible: false }),
  });
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).calendar_day_visible, false);

  const categories = await (await fetch(`${baseUrl}/api/categories`)).json();
  assert.equal(categories.find(category => category.name === '隐藏日分类').calendar_day_visible, false);

  const dateItems = (await (await fetch(`${baseUrl}/api/logs?date=2026-05-16`)).json()).items;
  assert.deepEqual(dateItems.map(item => item.id), []);
  const publicDateItems = (await (await fetch(`${baseUrl}/api/logs?date=2026-05-17`)).json()).items;
  assert.deepEqual(publicDateItems.map(item => item.id), [publicLog.id]);

  const monthItems = (await (await fetch(`${baseUrl}/api/logs?month=2026-05`)).json()).items;
  assert.equal(monthItems.some(item => item.id === hidden.id), true);
  const stats = await (await fetch(`${baseUrl}/api/stats`)).json();
  assert.equal(stats.datesWithLogs.includes('2026-05-16'), false);
  assert.equal(stats.datesWithLogs.includes('2026-05-17'), true);
  assert.equal(db.backup().categories.find(category => category.name === '隐藏日分类').calendar_day_visible, false);
});

test('category API includes parent and subcategory log counts for manager badges', async (t) => {
  const { db, baseUrl } = loadFreshApp(t);
  db.addCategory('Counted', null);
  db.addCategory('SubA', 'Counted');
  db.addCategory('SubB', 'Counted');
  db.create({ title: 'parent', content: 'parent', category: 'Counted', log_date: '2026-05-16' });
  db.create({ title: 'sub a 1', content: 'sub', category: 'Counted/SubA', log_date: '2026-05-16' });
  db.create({ title: 'sub a 2', content: 'sub', category: 'Counted/SubA', log_date: '2026-05-17' });

  const categories = await (await fetch(`${baseUrl}/api/categories`)).json();
  const counted = categories.find(category => category.name === 'Counted');

  assert.equal(counted.log_count, 3);
  assert.deepEqual(counted.sub_log_counts, { SubA: 2, SubB: 0 });
});

test('diary routes remain compatible when diary lock is disabled', async (t) => {
  const { db, baseUrl } = loadFreshApp(t);
  const diary = db.create({
    title: 'private',
    content: 'visible without lock',
    category: DIARY_CATEGORY,
    log_date: '2026-05-16',
  });

  assert.equal((await fetch(`${baseUrl}/api/logs/${diary.id}`)).status, 200);
  assert.equal((await fetch(`${baseUrl}/api/backup`)).status, 200);
  assert.deepEqual(await (await fetch(`${baseUrl}/api/auth/diary/status`)).json(), {
    enabled: false,
    locked: false,
  });
  assert.equal((await fetch(`${baseUrl}/api/logs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'new private',
      content: 'allowed',
      category: DIARY_CATEGORY,
      log_date: '2026-05-16',
    }),
  })).status, 201);
});

test('backup accepts bearer authentication when site auth is enabled', async (t) => {
  const { baseUrl } = loadFreshApp(t, { authToken: 'backup-secret' });

  assert.equal((await fetch(`${baseUrl}/api/backup`)).status, 401);

  const authorized = await fetch(`${baseUrl}/api/backup`, {
    headers: { Authorization: 'Bearer backup-secret' },
  });
  assert.equal(authorized.status, 200);
  assert.match(
    authorized.headers.get('content-disposition') || '',
    /^attachment; filename=work-log-backup-\d{4}-\d{2}-\d{2}\.json$/,
  );
});

test('AI chat requires DeepSeek configuration and validates request options', async (t) => {
  const missing = loadFreshApp(t);
  const missingKey = await fetch(`${missing.baseUrl}/api/ai/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] }),
  });
  assert.equal(missingKey.status, 503);

  const { baseUrl } = loadFreshApp(t, { deepseekApiKey: 'test-key' });
  const badModel = await fetch(`${baseUrl}/api/ai/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'other-model',
      messages: [{ role: 'user', content: 'hello' }],
    }),
  });
  assert.equal(badModel.status, 400);

  const badThinking = await fetch(`${baseUrl}/api/ai/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      thinkingMode: 'maybe',
      messages: [{ role: 'user', content: 'hello' }],
    }),
  });
  assert.equal(badThinking.status, 400);

  const badRole = await fetch(`${baseUrl}/api/ai/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [{ role: 'system', content: 'hidden prompt' }],
    }),
  });
  assert.equal(badRole.status, 400);
});

test('AI chat sends only explicit conversation messages to DeepSeek', async (t) => {
  const originalFetch = global.fetch;
  const { db, baseUrl } = loadFreshApp(t, {
    deepseekBaseUrl: 'https://deepseek.test',
  });
  db.create({
    title: 'private title',
    content: 'private diary content',
    category: DIARY_CATEGORY,
    log_date: '2026-05-16',
  });

  let capturedUrl = '';
  let capturedHeaders = {};
  let capturedPayload = null;
  global.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.startsWith('http://127.0.0.1')) return originalFetch(url, options);
    capturedUrl = target;
    capturedHeaders = options.headers || {};
    capturedPayload = JSON.parse(options.body);
    return new Response(JSON.stringify({
      choices: [{ message: { content: 'AI reply' } }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  t.after(() => {
    global.fetch = originalFetch;
  });

  const res = await fetch(`${baseUrl}/api/ai/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      apiKey: 'user-provided-key',
      model: 'deepseek-v4-pro',
      thinkingMode: 'enabled',
      reasoningEffort: 'max',
      messages: [
        { role: 'user', content: 'only this text' },
        { role: 'assistant', content: 'previous reply' },
      ],
    }),
  });

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { message: { role: 'assistant', content: 'AI reply' } });
  assert.equal(capturedUrl, 'https://deepseek.test/chat/completions');
  assert.equal(capturedHeaders.Authorization, 'Bearer user-provided-key');
  assert.deepEqual(capturedPayload, {
    model: 'deepseek-v4-pro',
    messages: [
      { role: 'user', content: 'only this text' },
      { role: 'assistant', content: 'previous reply' },
    ],
    thinking: { type: 'enabled' },
    stream: false,
    reasoning_effort: 'max',
  });
  assert.doesNotMatch(JSON.stringify(capturedPayload), /private diary content|private title/);
});

test('AI chat reports sanitized upstream DeepSeek errors', async (t) => {
  const originalFetch = global.fetch;
  const { baseUrl } = loadFreshApp(t, {
    deepseekBaseUrl: 'https://deepseek.test',
  });

  global.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.startsWith('http://127.0.0.1')) return originalFetch(url, options);
    return new Response(JSON.stringify({
      error: {
        message: 'Model unavailable for sk-secret-token',
        code: 'model_not_found',
      },
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  t.after(() => {
    global.fetch = originalFetch;
  });

  const res = await fetch(`${baseUrl}/api/ai/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      apiKey: 'user-provided-key',
      messages: [{ role: 'user', content: 'hello' }],
    }),
  });

  assert.equal(res.status, 502);
  const body = await res.json();
  assert.match(body.error, /^DeepSeek request failed \(400\):/);
  assert.match(body.error, /model_not_found/);
  assert.doesNotMatch(body.error, /sk-secret-token|user-provided-key/);
});

test('image upload rejects svg and still accepts allowed extensions', async (t) => {
  const { baseUrl } = loadFreshApp(t);

  const svg = new FormData();
  svg.append('image', new Blob(['<svg></svg>'], { type: 'image/svg+xml' }), 'bad.svg');
  const rejected = await fetch(`${baseUrl}/api/upload`, { method: 'POST', body: svg });
  assert.equal(rejected.status, 400);

  const png = new FormData();
  png.append('image', new Blob(['png-bytes'], { type: 'image/png' }), 'ok.png');
  const accepted = await fetch(`${baseUrl}/api/upload`, { method: 'POST', body: png });
  assert.equal(accepted.status, 200);
  const body = await accepted.json();
  assert.match(body.url, /^\/uploads\/.+\.png$/);
  assert.equal((await fetch(`${baseUrl}${body.url}`)).status, 200);
});

test('diary images require unlocked cookie and remain private after reclassification', async (t) => {
  const { baseUrl } = loadFreshApp(t, { diaryPassword: 'secret' });

  const rejectedPrivate = new FormData();
  rejectedPrivate.append('image', new Blob(['private'], { type: 'image/png' }), 'locked.png');
  rejectedPrivate.append('private', 'true');
  assert.equal((await fetch(`${baseUrl}/api/upload`, {
    method: 'POST',
    body: rejectedPrivate,
  })).status, 403);

  let cookie = await unlockDiary(baseUrl);
  const privateForm = new FormData();
  privateForm.append('image', new Blob(['private'], { type: 'image/png' }), 'private.png');
  privateForm.append('private', 'true');
  const privateResponse = await fetch(`${baseUrl}/api/upload`, {
    method: 'POST',
    headers: { Cookie: cookie },
    body: privateForm,
  });
  assert.equal(privateResponse.status, 200);
  const privateImage = await privateResponse.json();
  assert.equal((await fetch(`${baseUrl}${privateImage.url}`)).status, 403);
  assert.equal((await fetch(`${baseUrl}${privateImage.url}`, {
    headers: { Cookie: cookie },
  })).status, 200);
  assert.equal((await fetch(`${baseUrl}/api/auth/diary/lock`, {
    method: 'POST',
    headers: { Cookie: cookie },
  })).status, 200);
  assert.equal((await fetch(`${baseUrl}${privateImage.url}`, {
    headers: { Cookie: cookie },
  })).status, 403);
  cookie = await unlockDiary(baseUrl);
  assert.equal((await fetch(`${baseUrl}/api/uploads/${privateImage.filename}`, {
    method: 'DELETE',
  })).status, 403);
  assert.equal((await fetch(`${baseUrl}/api/uploads/${privateImage.filename}`, {
    method: 'DELETE',
    headers: { Cookie: cookie },
  })).status, 200);

  const ordinaryForm = new FormData();
  ordinaryForm.append('image', new Blob(['ordinary'], { type: 'image/png' }), 'ordinary.png');
  const ordinaryImage = await (await fetch(`${baseUrl}/api/upload`, {
    method: 'POST',
    body: ordinaryForm,
  })).json();
  const created = await fetch(`${baseUrl}/api/logs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'ordinary',
      content: `![attached](${ordinaryImage.url})`,
      category: OTHER_CATEGORY,
      log_date: '2026-05-16',
    }),
  });
  const log = await created.json();
  assert.equal((await fetch(`${baseUrl}${ordinaryImage.url}`)).status, 200);

  assert.equal((await fetch(`${baseUrl}/api/logs/${log.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ category: DIARY_CATEGORY }),
  })).status, 200);
  assert.equal((await fetch(`${baseUrl}${ordinaryImage.url}`)).status, 403);
  assert.equal((await fetch(`${baseUrl}/api/logs/${log.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ category: OTHER_CATEGORY }),
  })).status, 200);
  assert.equal((await fetch(`${baseUrl}${ordinaryImage.url}`)).status, 403);
});

test('historical diary image references are protected without a saved private marker', async (t) => {
  const { baseUrl, dataDir } = loadFreshApp(t, { diaryPassword: 'secret' });
  const markdownForm = new FormData();
  markdownForm.append('image', new Blob(['markdown'], { type: 'image/png' }), 'markdown.png');
  const markdownImage = await (await fetch(`${baseUrl}/api/upload`, {
    method: 'POST',
    body: markdownForm,
  })).json();
  const htmlForm = new FormData();
  htmlForm.append('image', new Blob(['html'], { type: 'image/png' }), 'html.png');
  const htmlImage = await (await fetch(`${baseUrl}/api/upload`, {
    method: 'POST',
    body: htmlForm,
  })).json();

  fs.writeFileSync(path.join(dataDir, 'logs.json'), JSON.stringify([{
    id: 1,
    title: 'historical',
    content: `![](${markdownImage.url})\n<img src="${htmlImage.url}">`,
    category: DIARY_CATEGORY,
    hours: 0,
    log_date: '2026-05-16',
    sort_order: 0,
  }]), 'utf8');

  assert.equal((await fetch(`${baseUrl}${markdownImage.url}`)).status, 403);
  assert.equal((await fetch(`${baseUrl}${htmlImage.url}`)).status, 403);
  const cookie = await unlockDiary(baseUrl);
  assert.equal((await fetch(`${baseUrl}${markdownImage.url}`, {
    headers: { Cookie: cookie },
  })).status, 200);
});

test('restore validation rejects unsafe or malformed backup data', (t) => {
  const db = loadFreshDb(t);
  const base = {
    logs: [{ id: 1, title: 'ok', content: 'ok', category: OTHER_CATEGORY, hours: 1, log_date: '2026-05-16' }],
    todos: [{ id: 1, title: 'todo' }],
    categories: [{ name: OTHER_CATEGORY, sub: [] }],
  };

  assert.deepEqual(db.restore({ logs: [{ id: 1 }], todos: [{ id: 1 }], categories: [OTHER_CATEGORY] }).success, true);
  assert.match(db.restore({ ...base, logs: [{ id: 1 }, { id: 1 }] }).error, /Duplicate log id/);
  assert.match(db.restore({ ...base, logs: [{ id: 1, log_date: '2026-02-31' }] }).error, /Invalid log_date/);
  assert.match(db.restore({ ...base, logs: [{ id: 1, hours: 25 }] }).error, /Invalid hours/);
  assert.match(db.restore({ ...base, todos: [{ id: 1 }, { id: 1 }] }).error, /Duplicate todo id/);
  assert.match(db.restore({ ...base, todos: [{ id: 1, due_date: '2026-02-31' }] }).error, /Invalid due_date/);
  assert.match(db.restore({ ...base, todos: [{ id: 1, priority: 'critical' }] }).error, /Invalid priority/);
  assert.match(db.restore({ ...base, todos: [{ id: 1, notes: { text: 'bad' } }] }).error, /Invalid notes/);
  assert.match(db.restore({ ...base, categories: [{ name: 'Bad', sub: 'not-array' }] }).error, /Invalid subcategories/);
  assert.match(db.restore({ ...base, categories: [{ name: 'Bad', sub: [], calendar_day_visible: 'no' }] }).error, /Invalid calendar day visibility/);
  assert.match(db.restore({ ...base, privateUploads: ['../secret.png'] }).error, /Invalid private upload filename/);

  assert.deepEqual(db.restore({ ...base, privateUploads: ['secret.png'] }).success, true);
  assert.equal(db.getAllTodos()[0].notes, '');
  assert.deepEqual(db.backup().privateUploads, ['secret.png']);
  assert.deepEqual(db.restore(base).success, true);
  assert.deepEqual(db.backup().privateUploads, []);
});

test('todo API stores due date, priority, and notes', async (t) => {
  const { baseUrl } = loadFreshApp(t);

  const created = await fetch(`${baseUrl}/api/todos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'task',
      due_date: '2026-05-18',
      priority: 'important',
      notes: 'bring context',
    }),
  });
  assert.equal(created.status, 201);
  const createdBody = await created.json();
  assert.equal(createdBody.due_date, '2026-05-18');
  assert.equal(createdBody.priority, 'important');
  assert.equal(createdBody.notes, 'bring context');

  const updated = await fetch(`${baseUrl}/api/todos/${createdBody.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      priority: 'urgent',
      notes: 'updated note',
    }),
  });
  assert.equal(updated.status, 200);
  const updatedBody = await updated.json();
  assert.equal(updatedBody.priority, 'urgent');
  assert.equal(updatedBody.notes, 'updated note');

  const listed = await fetch(`${baseUrl}/api/todos`);
  assert.equal(listed.status, 200);
  const items = await listed.json();
  assert.equal(items[0].priority, 'urgent');
  assert.equal(items[0].notes, 'updated note');
});

test('todo priorities preserve none normal important and urgent values', async (t) => {
  const { baseUrl } = loadFreshApp(t);
  const priorities = ['none', 'normal', 'important', 'urgent'];

  for (const priority of priorities) {
    const created = await fetch(`${baseUrl}/api/todos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: `task-${priority}`, priority }),
    });
    assert.equal(created.status, 201);
    assert.equal((await created.json()).priority, priority);
  }

  const listed = await (await fetch(`${baseUrl}/api/todos`)).json();
  const byTitle = new Map(listed.map(todo => [todo.title, todo.priority]));
  for (const priority of priorities) {
    assert.equal(byTitle.get(`task-${priority}`), priority);
  }
});

test('undated logs are saved and searchable from all months only', async (t) => {
  const { baseUrl } = loadFreshApp(t);

  const created = await fetch(`${baseUrl}/api/logs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'floating note',
      content: 'needle without date',
      category: OTHER_CATEGORY,
      hours: 0,
      log_date: '',
    }),
  });
  assert.equal(created.status, 201);
  const createdBody = await created.json();
  assert.equal(createdBody.log_date, '');

  const monthResult = await fetch(`${baseUrl}/api/logs?month=2026-05&search=needle`);
  assert.equal(monthResult.status, 200);
  assert.equal((await monthResult.json()).total, 0);

  const allMonthsResult = await fetch(`${baseUrl}/api/logs?search=needle`);
  assert.equal(allMonthsResult.status, 200);
  const allMonthsBody = await allMonthsResult.json();
  assert.equal(allMonthsBody.total, 1);
  assert.equal(allMonthsBody.items[0].id, createdBody.id);
});

test('Hong Kong business dates stay stable across UTC day boundaries', () => {
  assert.equal(businessDate.BUSINESS_TIME_ZONE, 'Asia/Hong_Kong');
  assert.equal(businessDate.businessDateString(new Date('2026-05-24T15:59:59.000Z')), '2026-05-24');
  assert.equal(businessDate.businessDateString(new Date('2026-05-24T16:00:00.000Z')), '2026-05-25');
  assert.equal(businessDate.businessDateString(new Date('2026-05-25T16:00:00.000Z')), '2026-05-26');
  assert.equal(businessDate.startOfWeekMonday('2026-05-25'), '2026-05-25');
  assert.equal(businessDate.shiftDateString('2026-05-25', 1), '2026-05-26');
});

test('default log dates and stats use the Hong Kong business day', (t) => {
  const db = loadFreshDb(t);
  const instant = new Date('2026-05-24T16:05:00.000Z');
  const defaulted = db.create({
    title: 'new day',
    content: 'created after Hong Kong midnight',
    category: OTHER_CATEGORY,
    hours: 1,
  }, instant);
  db.create({
    title: 'earlier this month',
    content: 'included in month only',
    category: OTHER_CATEGORY,
    hours: 4,
    log_date: '2026-05-01',
  });
  db.create({
    title: 'previous Sunday',
    content: 'not this week',
    category: OTHER_CATEGORY,
    hours: 7,
    log_date: '2026-05-24',
  });

  assert.equal(defaulted.log_date, '2026-05-25');
  const stats = db.getStats(true, instant);
  assert.equal(stats.weekHours, 1);
  assert.equal(stats.monthHours, 12);
  assert.equal(stats.dailyAvg, 0.5);
});

test('frontend business date formatting and template offsets use Hong Kong dates', async () => {
  const moduleUrl = pathToFileURL(path.join(ROOT, 'public', 'js', 'businessDate.js')).href + `?date=${Date.now()}`;
  const frontendDate = await import(moduleUrl);

  assert.equal(frontendDate.businessDateString(new Date('2026-05-24T16:00:00.000Z')), '2026-05-25');
  assert.equal(frontendDate.shiftBusinessDate('2026-05-25', -1), '2026-05-24');
  assert.equal(frontendDate.formatShortDateLabel('2026-05-25'), '5月25日 周一');
  assert.equal(frontendDate.formatTemplateDate('2026-05-25', 'YYYY/MM/DD ddd'), '2026/05/25 周一');
});

test('template variables support Chinese day names and week ranges', async () => {
  const moduleUrl = pathToFileURL(path.join(ROOT, 'public', 'js', 'templateDate.js')).href + `?template=${Date.now()}`;
  const templateDate = await import(moduleUrl);
  const baseDate = '2026-05-27';

  assert.equal(templateDate.renderTemplateVariables('{{今天:YYYY/MM/DD ddd}}', baseDate), '2026/05/27 周三');
  assert.equal(templateDate.renderTemplateVariables('{{日期:+7:MM月DD日}}', baseDate), '06月03日');
  assert.equal(templateDate.renderTemplateVariables('{{today:MM-DD}}', baseDate), '05-27');
  assert.equal(templateDate.renderTemplateVariables('{{本周:MM月DD日}}', baseDate), '05月25日 - 05月31日');
  assert.equal(templateDate.renderTemplateVariables('{{上一周:MM月DD日}}', baseDate), '05月18日 - 05月24日');
  assert.equal(templateDate.renderTemplateVariables('{{上一周.开始:YYYY-MM-DD}} 至 {{上一周.结束:YYYY-MM-DD}}', baseDate), '2026-05-18 至 2026-05-24');
});

test('primary controls expose accessible names and editor tab semantics', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const document = new JSDOM(html).window.document;

  assert.equal(document.querySelector('label[for="searchInput"]').textContent, '搜索日志');
  assert.equal(document.querySelector('#calendarDays').getAttribute('role'), 'grid');
  assert.equal(document.querySelector('#saveStatus').getAttribute('aria-live'), 'polite');
  assert.equal(document.querySelector('#a11yStatus').getAttribute('role'), 'status');
  assert.equal(document.querySelector('#editorTabWrite').getAttribute('role'), 'tab');
  assert.equal(document.querySelector('#editorTabWrite').getAttribute('aria-controls'), 'editorPanel');
  assert.equal(document.querySelector('#editorPanel').getAttribute('role'), 'tabpanel');
  assert.equal(document.querySelector('#codeMirrorContentEditor').getAttribute('aria-label'), '日志内容 Markdown 编辑器');
  assert.equal(document.querySelector('#btnEditorOutlinePanel').textContent, '标题');
  assert.equal(document.querySelector('#btnEditorOutlinePanel').getAttribute('aria-controls'), 'editorOutlinePanel');
  assert.equal(document.querySelector('#btnEditorOutlinePanel').getAttribute('aria-expanded'), 'false');
  assert.equal(document.querySelector('#editorOutlinePanel').getAttribute('aria-hidden'), 'true');
  assert.equal(document.querySelector('#editorOutlineList .editor-outline-empty').textContent, '暂无标题');
  assert.equal(document.querySelector('#editTitle').closest('#editorOutlinePanel'), null);
  assert.equal(document.querySelector('#btnEditorFullscreen').textContent, '全屏编辑');
  assert.equal(document.querySelector('#btnEditorFullscreen').getAttribute('aria-pressed'), 'false');
  assert.equal(document.querySelector('#btnBack').closest('.editor-nav-actions') !== null, true);
  assert.equal(document.querySelector('#aiChatView').style.display, 'none');
  assert.equal(document.querySelector('#btnAiBack').textContent.trim(), '← 返回');
  assert.equal(document.querySelector('#aiChatMessages').getAttribute('aria-live'), 'polite');
  assert.equal(document.querySelector('#aiApiKeyInput').getAttribute('type'), 'password');
  assert.equal(document.querySelector('#aiApiKeyInput').getAttribute('autocomplete'), 'off');
  assert.equal(document.querySelector('label[for="aiApiKeyInput"]').textContent, 'DeepSeek API Key');
  assert.equal(document.querySelector('#aiApiKeyOverlay').getAttribute('aria-labelledby'), 'aiApiKeyTitle');
  assert.equal(document.querySelector('#btnAiApiKey').getAttribute('aria-haspopup'), 'dialog');
  assert.equal(document.querySelector('#btnAiNewChat').textContent, '新建对话');
  assert.equal(document.querySelector('#btnAiHistory').getAttribute('aria-haspopup'), 'dialog');
  assert.equal(document.querySelector('#btnAiHistory').textContent, '历史记录');
  assert.equal(document.querySelector('#aiHistoryOverlay').getAttribute('aria-labelledby'), 'aiHistoryTitle');
  assert.equal(document.querySelector('#aiChatHistoryList').closest('.modal-ai-history') !== null, true);
  assert.equal(document.querySelector('.ai-chat-body .ai-chat-history'), null);
  assert.equal(document.querySelector('#btnAiApiKeySave').textContent, '保存');
  assert.equal(document.querySelector('#btnAiApiKeyClear').textContent, '清除');
  assert.equal(document.querySelector('#aiChatInput').getAttribute('maxlength'), '4000');
  assert.equal(document.querySelector('#btnAiSend').disabled, true);
  assert.deepEqual([...document.querySelectorAll('#aiModelSelect option')].map(option => option.value), [
    'deepseek-v4-flash',
    'deepseek-v4-pro',
  ]);
  assert.equal(document.querySelector('#aiThinkingMode'), null);
  assert.deepEqual([...document.querySelectorAll('#aiReasoningEffort option')].map(option => option.value), [
    'high',
    'max',
  ]);
  assert.equal(document.querySelector('#fabCapture').textContent, 'AI');
  assert.equal(document.querySelector('#fabCapture').getAttribute('aria-label'), '打开 AI 对话');
  assert.equal(document.querySelector('#diaryUnlockOverlay').getAttribute('aria-labelledby'), 'diaryUnlockTitle');
  assert.equal(document.querySelector('#catSearchInput').closest('.category-page-header') !== null, true);
  assert.equal(document.querySelector('#catNewInput').closest('.category-page-header') !== null, true);
  assert.equal(document.querySelector('#catAddBtn').closest('.category-page-header') !== null, true);
  assert.equal(document.querySelector('#catAddBtn').getAttribute('aria-label'), '添加父分类');
  assert.equal(document.querySelector('.cat-detail-actions #catCalendarDayVisible') !== null, true);
  assert.equal(document.querySelector('#catSubNewInput').closest('.cat-detail-actions') !== null, true);
  assert.equal(document.querySelector('#catSubAddBtn').closest('.cat-detail-actions') !== null, true);
  assert.equal(document.querySelector('#catSubAddBtn').getAttribute('aria-label'), '添加子分类');
  assert.equal(document.querySelector('#btnCatRename').getAttribute('aria-label'), '重命名分类');
  assert.equal(document.querySelector('#btnCatDelete').getAttribute('aria-label'), '删除分类');
  assert.equal(document.querySelector('#catDetailLogCount').closest('.cat-detail-heading') !== null, true);
  assert.equal(document.querySelector('#catSubBrowseSidebar').closest('.category-parent-panel') !== null, true);
  assert.equal(document.querySelector('#catSubBrowseContent').closest('.category-detail-panel') !== null, true);
  assert.equal(document.querySelector('#btnSubBrowseBack').textContent.trim(), '← 父分类');
  assert.deepEqual([...document.querySelectorAll('#todoFullPriority option')].map(option => [option.value, option.textContent]), [
    ['none', '无'],
    ['normal', '普通'],
    ['important', '重要'],
    ['urgent', '紧急'],
  ]);
  assert.match(document.querySelector('.cat-calendar-toggle').getAttribute('title'), /月份筛选仍可查看/);
  assert.equal(document.querySelector('.cat-calendar-toggle-label'), null);
  assert.equal(document.querySelector('#catManagerSummary').getAttribute('title'), '父分类数量');
  assert.match(document.querySelector('.template-token-hint').textContent, /\{\{上一周:MM月DD日\}\}/);
});

test('category manager uses drag sorting and log count badges without move buttons', () => {
  const categorySource = fs.readFileSync(path.join(ROOT, 'public', 'js', 'categories.js'), 'utf8');
  const styleSource = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');
  const htmlSource = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

  assert.doesNotMatch(categorySource, /<span class="cat-log-count" title="日志数量">\$\{c\.log_count \|\| 0\}<\/span>/);
  assert.match(categorySource, /<span class="cat-sub-count" title="子分类数量">\$\{\(c\.sub \|\| \[\]\)\.length\}<\/span>/);
  assert.match(categorySource, /\$\('#catDetailLogCount'\)\.textContent = cat\.log_count \|\| 0;/);
  assert.match(categorySource, /<span class="cat-log-count" title="日志数量">\$\{cat\.sub_log_counts\?\.\[s\] \|\| 0\}<\/span>/);
  assert.match(categorySource, /async function openSubcategoryBrowse\(subName\)/);
  assert.match(categorySource, /syncMainCategoryFilter\(fullSubcategoryName\(parent, subName\)\)/);
  assert.match(categorySource, /apiFetch\(`\/api\/logs\?\$\{params\}`\)/);
  assert.match(categorySource, /const \{ openEditor \} = await import\('\.\/editor\.js'\);/);
  assert.match(categorySource, /class="cat-sub-log-card"[\s\S]*data-id="\$\{log\.id\}"/);
  assert.match(categorySource, /<span class="cat-sub-log-index">\$\{index \+ 1\}<\/span>/);
  assert.match(categorySource, /<span class="cat-sub-log-date">\$\{escHtml\(formatShortDateLabel\(log\.log_date\)\)\}<\/span>/);
  assert.match(categorySource, /<span class="cat-sub-log-arrow" aria-hidden="true">›<\/span>/);
  assert.doesNotMatch(categorySource, /cat-sub-log-preview/);
  assert.doesNotMatch(categorySource, /cat-sub-log-meta/);
  assert.match(categorySource, /class="cat-icon-action subcat-edit-btn"[\s\S]*aria-label="重命名子分类：\$\{escHtml\(s\)\}"/);
  assert.match(categorySource, /class="cat-icon-action danger subcat-del-btn"[\s\S]*aria-label="删除子分类：\$\{escHtml\(s\)\}"/);
  assert.match(styleSource, /\.cat-icon-action\s*\{[\s\S]*width:\s*30px;[\s\S]*height:\s*30px;/);
  assert.match(styleSource, /\.cat-icon-action\.primary\s*\{[\s\S]*background:\s*var\(--color-primary\);/);
  assert.match(styleSource, /\.cat-header-add\s*\{[\s\S]*width:\s*min\(310px, 30vw\);/);
  assert.match(styleSource, /\.cat-header-search\s*\{[\s\S]*width:\s*min\(440px, 44vw\);/);
  assert.match(styleSource, /\.cat-manager-summary\s*\{[\s\S]*border:\s*1px solid rgba\(16, 185, 129, 0\.35\);/);
  assert.match(styleSource, /\.cat-manager-summary::before\s*\{[\s\S]*box-shadow:/);
  assert.match(categorySource, /summary\.textContent = total;/);
  assert.doesNotMatch(categorySource, /个父分类，/);
  assert.doesNotMatch(categorySource, /个子分类/);
  assert.doesNotMatch(htmlSource, /拖动父分类排序/);
  assert.doesNotMatch(htmlSource, /<span class="cat-calendar-toggle-label">日历显示<\/span>/);
  assert.match(categorySource, /setupDragAndDrop\(\{[\s\S]*itemSelector: '\.cat-parent-item'/);
  assert.doesNotMatch(categorySource, /data-cat-action/);
  assert.doesNotMatch(categorySource, /moveCategory/);
  assert.match(styleSource, /\.cat-log-count\s*\{[\s\S]*background:\s*var\(--color-primary\);[\s\S]*color:\s*var\(--color-card\);/);
  assert.match(styleSource, /\.cat-detail-log-count\s*\{[\s\S]*min-width:\s*30px;/);
  assert.match(styleSource, /\.cat-parent-select \.cat-sub-count\s*\{[\s\S]*border:\s*1px solid var\(--color-border\);/);
  assert.match(styleSource, /\.cat-sub-browse-sidebar\s*\{[\s\S]*flex-direction:\s*column;/);
  assert.match(styleSource, /\.cat-sub-log-list\s*\{[\s\S]*flex-direction:\s*column;/);
  assert.match(styleSource, /\.cat-sub-log-card\s*\{[\s\S]*min-height:\s*46px;[\s\S]*border:\s*1px solid var\(--color-border\);/);
  assert.match(styleSource, /\.cat-sub-log-index\s*\{[\s\S]*background:\s*rgba\(var\(--color-primary-rgb\), 0\.12\);/);
  assert.match(styleSource, /\.cat-sub-log-date\s*\{[\s\S]*border-radius:\s*999px;/);
  assert.match(styleSource, /\.cat-sub-log-card:hover \.cat-sub-log-arrow/);
  assert.match(styleSource, /\.cat-parent-item\s*\{[\s\S]*grid-template-columns:\s*24px minmax\(0, 1fr\);/);
});

test('todo UI uses drag sorting, new priorities, and hides notes previews', () => {
  const todoSource = fs.readFileSync(path.join(ROOT, 'public', 'js', 'todos.js'), 'utf8');
  const styleSource = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');
  const htmlSource = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const priorityStyleBlock = styleSource.match(/\.todo-priority\s*\{[\s\S]*?\n\}/)?.[0] || '';

  assert.match(htmlSource, /<option value="none">无<\/option>[\s\S]*<option value="normal">普通<\/option>[\s\S]*<option value="important">重要<\/option>[\s\S]*<option value="urgent">紧急<\/option>/);
  assert.doesNotMatch(todoSource, /data-action="move-up"/);
  assert.doesNotMatch(todoSource, /data-action="move-down"/);
  assert.doesNotMatch(todoSource, /moveTodo/);
  assert.doesNotMatch(todoSource, /todo-notes-preview/);
  assert.doesNotMatch(styleSource, /todo-notes-preview/);
  assert.match(todoSource, /priority: todo\.priority \|\| 'none'/);
  assert.match(todoSource, /function priorityBadge\(todo\)/);
  assert.match(todoSource, /const labels = \{ normal: 'P2 普通', important: 'P1 重要', urgent: 'P0 紧急' \};/);
  assert.match(todoSource, /const codes = \{ normal: 'P2', important: 'P1', urgent: 'P0' \};/);
  assert.doesNotMatch(todoSource, /priorityDot/);
  assert.match(priorityStyleBlock, /min-width:\s*22px;/);
  assert.match(priorityStyleBlock, /border-radius:\s*5px;/);
  assert.doesNotMatch(priorityStyleBlock, /border-radius:\s*50%;/);
  assert.match(styleSource, /\.todo-priority\.prio-normal\s*\{[\s\S]*background: var\(--color-primary\);/);
  assert.match(styleSource, /\.todo-priority\.prio-important\s*\{[\s\S]*background: var\(--color-warning\);/);
  assert.match(styleSource, /\.todo-priority\.prio-urgent\s*\{ background: var\(--color-danger\); \}/);
});

test('application initialization waits for auth and diary selection before refreshing', () => {
  const appSource = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
  const authSource = fs.readFileSync(path.join(ROOT, 'public', 'js', 'auth.js'), 'utf8');

  assert.match(appSource, /const authenticated = await checkAuth\(\);[\s\S]*if \(!authenticated\) return;[\s\S]*const diarySelected = await initDiaryLock\(\);[\s\S]*if \(!diarySelected\) await refreshAll\(\);/);
  assert.match(appSource, /window\.addEventListener\('auth-success', async \(\) => \{[\s\S]*await initDiaryLock\(\)/);
  assert.match(authSource, /showLoginOverlay\(\);\s*return false;/);
});

test('AI chat frontend supports local history and fixed thinking mode', () => {
  const appSource = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
  const aiSource = fs.readFileSync(path.join(ROOT, 'public', 'js', 'aiChat.js'), 'utf8');
  const styleSource = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');

  assert.match(appSource, /import \{ initAiChat, showAiChatView \} from '\.\/aiChat\.js';/);
  assert.match(appSource, /\$\('#fabCapture'\)\.addEventListener\('click', \(\) => \{[\s\S]*showAiChatView\(\);[\s\S]*\}\);/);
  assert.doesNotMatch(appSource, /fabCapture[\s\S]{0,160}newLog\(\)/);
  assert.match(appSource, /initAiChat\(\);/);
  assert.match(aiSource, /body: JSON\.stringify\(\{ messages: chat\.messages, \.\.\.settings \}\)/);
  assert.match(aiSource, /const API_KEY_STORAGE_KEY = 'deepseekApiKey';/);
  assert.match(aiSource, /const CHAT_STORAGE_KEY = 'aiChatConversations';/);
  assert.match(aiSource, /const ACTIVE_CHAT_STORAGE_KEY = 'aiChatActiveConversationId';/);
  assert.match(aiSource, /let apiKey = localStorage\.getItem\(API_KEY_STORAGE_KEY\) \|\| '';/);
  assert.match(aiSource, /apiKey,\s*model: \$\('#aiModelSelect'\)\.value \|\| DEFAULT_MODEL/);
  assert.match(aiSource, /thinkingMode: 'enabled'/);
  assert.match(aiSource, /reasoningEffort: \$\('#aiReasoningEffort'\)\.value \|\| DEFAULT_REASONING/);
  assert.match(aiSource, /localStorage\.setItem\(CHAT_STORAGE_KEY, JSON\.stringify\(conversations\)\);/);
  assert.match(aiSource, /localStorage\.setItem\(ACTIVE_CHAT_STORAGE_KEY, activeConversationId\);/);
  assert.match(aiSource, /function newConversation\(\)/);
  assert.match(aiSource, /function renameConversation\(id\)/);
  assert.match(aiSource, /function deleteConversation\(id\)/);
  assert.match(aiSource, /\$\('#btnAiNewChat'\)\.addEventListener\('click', newConversation\);/);
  assert.match(aiSource, /\$\('#btnAiHistory'\)\.addEventListener\('click', openHistoryModal\);/);
  assert.match(aiSource, /\$\('#aiHistoryClose'\)\.addEventListener\('click', closeHistoryModal\);/);
  assert.match(aiSource, /\$\('#aiChatHistoryList'\)\.addEventListener\('click'/);
  assert.match(aiSource, /localStorage\.setItem\(API_KEY_STORAGE_KEY, apiKey\);/);
  assert.match(aiSource, /localStorage\.removeItem\(API_KEY_STORAGE_KEY\);/);
  assert.match(aiSource, /\$\('#btnAiApiKey'\)\.addEventListener\('click', openApiKeyModal\);/);
  assert.match(aiSource, /model: \$\('#aiModelSelect'\)\.value \|\| DEFAULT_MODEL/);
  assert.doesNotMatch(aiSource, /aiThinkingMode/);
  assert.match(aiSource, /send\.disabled = sending \|\| !hasText;/);
  assert.match(aiSource, /showToast\(`AI 对话失败：\$\{err\.message\}`/);
  assert.match(styleSource, /\.ai-chat-composer\s*\{[\s\S]*border-radius:\s*8px;/);
  assert.match(styleSource, /\.modal-ai-history\s*\{[\s\S]*width:\s*520px;/);
  assert.match(styleSource, /\.ai-history-body\s*\{[\s\S]*overflow-y:\s*auto;/);
  assert.match(styleSource, /\.ai-history-item\s*\{[\s\S]*grid-template-columns:\s*minmax\(0, 1fr\) 30px 30px;/);
  assert.match(styleSource, /\.modal-ai-key\s*\{[\s\S]*width:\s*440px;/);
  assert.match(styleSource, /\.ai-key-button\.has-key\s*\{[\s\S]*color:\s*var\(--color-primary\);/);
  assert.match(styleSource, /@media \(max-width: 768px\)[\s\S]*\.ai-chat-composer\s*\{[\s\S]*position:\s*sticky;/);
});

test('modal helper traps tab navigation and restores the trigger focus', async () => {
  const dom = new JSDOM(`
    <!doctype html><body>
      <button id="trigger">打开</button>
      <div id="a11yStatus"></div>
      <div id="dialog" style="display:none"><button id="first">一</button><button id="last">二</button></div>
    </body>
  `, { pretendToBeVisual: true });
  globalThis.document = dom.window.document;
  globalThis.requestAnimationFrame = callback => callback();
  const moduleUrl = pathToFileURL(path.join(ROOT, 'public', 'js', 'helpers.js')).href + `?focus=${Date.now()}`;
  const helpers = await import(moduleUrl);
  const trigger = document.getElementById('trigger');
  const overlay = document.getElementById('dialog');

  trigger.focus();
  helpers.openModal(overlay, '#first');
  assert.equal(document.activeElement.id, 'first');
  document.getElementById('last').focus();
  overlay.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
  assert.equal(document.activeElement.id, 'first');
  helpers.closeModal(overlay);
  assert.equal(document.activeElement.id, 'trigger');
});

test('markdown preview renders normal markdown and latex with local globals', async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  globalThis.document = dom.window.document;
  globalThis.marked = markedPackage.marked || markedPackage;
  globalThis.katex = katex;
  globalThis.DOMPurify = createDOMPurify(dom.window);

  const moduleUrl = pathToFileURL(path.join(ROOT, 'public', 'js', 'markdown.js')).href + `?t=${Date.now()}`;
  const markdown = await import(moduleUrl);
  const html = markdown.renderToHtmlUncached('# Title\n\n**bold** and $E=mc^2$\n\n$$\n\\int_0^1 x^2 dx\n$$');

  assert.match(html, /<h1>Title<\/h1>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /katex/);
});

test('CodeMirror editor is bundled as a deferred Markdown editing asset', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const adapterSource = fs.readFileSync(path.join(ROOT, 'public', 'js', 'contentEditor.js'), 'utf8');
  const entrySource = fs.readFileSync(path.join(ROOT, 'src', 'codemirror', 'editor-entry.js'), 'utf8');
  const ignoreSource = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');

  assert.equal(packageJson.scripts.build, 'node scripts/build-editor.mjs');
  assert.equal(packageJson.dependencies['monaco-editor'], undefined);
  assert.equal(typeof packageJson.dependencies.codemirror, 'string');
  assert.match(adapterSource, /import\(CODEMIRROR_MODULE_URL\)/);
  assert.match(adapterSource, /module\.markdown\(\)/);
  assert.match(entrySource, /import \{ basicSetup \} from 'codemirror'/);
  assert.match(entrySource, /import \{ markdown \} from '@codemirror\/lang-markdown'/);
  assert.match(ignoreSource, /public\/generated\//);
});

test('editor exposes pasted image upload and common emoji insertion controls', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const editorSource = fs.readFileSync(path.join(ROOT, 'public', 'js', 'editor.js'), 'utf8');
  const styleSource = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');
  const document = new JSDOM(html).window.document;

  assert.equal(document.querySelector('button[data-emoji="✅"]').textContent, '✅');
  assert.match(editorSource, /editorContentArea\.addEventListener\('paste',[\s\S]*event\.stopPropagation\(\);[\s\S]*\}, true\);/);
  assert.match(editorSource, /uploadImageFile\(file, selection\)/);
  assert.match(styleSource, /#filterCategory,[\s\S]*field-sizing: content/);
  assert.match(styleSource, /#filterCategory:focus,[\s\S]*border-color: var\(--color-primary\)/);
});

test('new logs default to the selected calendar day or today and inherit the active category filter', () => {
  const editorSource = fs.readFileSync(path.join(ROOT, 'public', 'js', 'editor.js'), 'utf8');

  assert.match(editorSource, /function getNewLogCategory\(\)[\s\S]*\(state\.category \|\| ''\)\.split\('\/'\)/);
  assert.match(editorSource, /matchingCategory && \(!filteredSub \|\| \(matchingCategory\.sub \|\| \[\]\)\.includes\(filteredSub\)\)/);
  assert.match(editorSource, /export function newLog\(\) \{\s*const defaultDate = state\.selectedDate \|\| businessDateString\(\);\s*const defaultCategory = getNewLogCategory\(\);/);
  assert.match(editorSource, /lastSavedDate = defaultDate;[\s\S]*lastSavedCategory = defaultCategory\.value;/);
  assert.match(editorSource, /editDate\.value = defaultDate;[\s\S]*editCategory\.value = defaultCategory\.parent;[\s\S]*populateEditorSubCategory\(defaultCategory\.parent\);[\s\S]*editSubcategory\.value = defaultCategory\.sub;/);
});

test('editor fullscreen mode keeps navigation, preview tabs, shortcuts, and content surface visible', () => {
  const editorSource = fs.readFileSync(path.join(ROOT, 'public', 'js', 'editor.js'), 'utf8');
  const styleSource = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');

  assert.match(editorSource, /function setEditorFullscreen\(enabled\)[\s\S]*document\.body\.classList\.toggle\('editor-fullscreen', enabled\)/);
  assert.doesNotMatch(editorSource, /if \(enabled && editorTab !== 'write'\)/);
  assert.match(editorSource, /btnEditorFullscreen\.addEventListener\('click',[\s\S]*setEditorFullscreen\(!document\.body\.classList\.contains\('editor-fullscreen'\)\)/);
  assert.match(editorSource, /function setOutlinePanelOpen\(open[\s\S]*btnEditorOutlinePanel\.setAttribute\('aria-expanded', String\(open\)\)/);
  assert.match(editorSource, /function extractMarkdownHeadings\(markdown\)[\s\S]*#\{1,6\}/);
  assert.match(editorSource, /<span class="editor-outline-level">H\$\{heading\.level\}<\/span>/);
  assert.match(editorSource, /editorOutlineList\.addEventListener\('click'[\s\S]*contentEditor\.setSelection\(pos, pos\)/);
  assert.match(styleSource, /\.editor-outline-item::before[\s\S]*background:\s*var\(--outline-accent\)/);
  assert.match(styleSource, /\.editor-outline-item\.level-2[\s\S]*--outline-accent:\s*var\(--color-success\)/);
  assert.match(editorSource, /case 'preview':[\s\S]*if \(inEditor\) \{ e\.preventDefault\(\); switchTab\(nextEditorTab\(\)\); \}/);
  assert.match(editorSource, /case 'escape':[\s\S]*document\.body\.classList\.contains\('editor-fullscreen'\)[\s\S]*setEditorFullscreen\(false\);[\s\S]*return;/);
  assert.match(styleSource, /body\.editor-fullscreen \.sidebar,[\s\S]*body\.editor-fullscreen \.fab-capture\s*\{[\s\S]*display:\s*none !important;/);
  assert.match(styleSource, /body\.editor-fullscreen \.main\s*\{[\s\S]*position:\s*fixed;[\s\S]*inset:\s*0;/);
  assert.match(styleSource, /body\.editor-fullscreen \.editor-meta,[\s\S]*body\.editor-fullscreen \.btn-template-manage\s*\{[\s\S]*display:\s*none;/);
  assert.match(styleSource, /body\.editor-fullscreen \.editor-tabs\s*\{[\s\S]*border-top:\s*1px solid var\(--color-border\)/);
  assert.match(styleSource, /body\.editor-fullscreen \.editor-nav-actions\s*\{\s*width:\s*100%;\s*justify-content:\s*space-between;/);
});

test('mobile layout uses compact on-demand sidebar panels and retains collapse controls', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const appSource = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
  const styleSource = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');
  const document = new JSDOM(html).window.document;
  const mobileStyles = styleSource.slice(styleSource.indexOf('@media (max-width: 768px)'), styleSource.indexOf('/* Collapsed sidebar */'));

  assert.equal(document.querySelector('#btnSidebarTools').getAttribute('aria-label'), '切换更多工具');
  assert.doesNotMatch(mobileStyles, /\.btn-sidebar-toggle\s*\{\s*display:\s*none/);
  assert.match(mobileStyles, /\.btn-theme-toggle,[\s\S]*\.btn-sidebar-toggle\s*\{[\s\S]*min-width:\s*36px;[\s\S]*min-height:\s*36px;/);
  assert.match(mobileStyles, /\.btn-sidebar-tools\s*\{\s*display:\s*flex;/);
  assert.match(mobileStyles, /\.card-nav-panel,[\s\S]*\.backup-buttons\s*\{\s*display:\s*none;/);
  assert.match(mobileStyles, /body\.sidebar-tools-mode \.stats-panel\s*\{[\s\S]*display:\s*block;/);
  assert.match(mobileStyles, /body\.sidebar-collapsed \.sidebar\s*\{\s*display:\s*none;/);
  assert.match(appSource, /function collapseSidebar\(\)\s*\{\s*document\.body\.classList\.toggle\('sidebar-collapsed'\);\s*\}/);
  assert.match(appSource, /\$\('#btnToggleSidebar'\)\.addEventListener\('click', collapseSidebar\);[\s\S]*\$\('#btnSidebarExpand'\)\.addEventListener\('click', collapseSidebar\);/);
  assert.match(appSource, /function setSidebarToolsMode\(enabled\)[\s\S]*sidebar-tools-mode/);
  assert.match(appSource, /widget\.classList\.toggle\('mobile-show'\)/);
  assert.doesNotMatch(appSource, /localStorage\.(?:setItem|getItem)\([^)]*sidebar-collapsed/i);
});

test('mobile layout gives filters and editor controls touch-friendly responsive treatment', () => {
  const styleSource = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');
  const mobileStyles = styleSource.slice(styleSource.indexOf('@media (max-width: 768px)'), styleSource.indexOf('/* Collapsed sidebar */'));

  assert.match(mobileStyles, /\.toolbar\s*\{[\s\S]*display:\s*grid;[\s\S]*grid-template-columns:\s*repeat\(2,/);
  assert.match(mobileStyles, /#btnNewLog,[\s\S]*#btnManageCats\s*\{[\s\S]*grid-column:\s*1 \/ -1;/);
  assert.match(mobileStyles, /\.editor-meta\s*\{[\s\S]*grid-template-columns:\s*repeat\(2,/);
  assert.match(mobileStyles, /\.editor-toolbar\s*\{[\s\S]*overflow-x:\s*auto;/);
  assert.match(mobileStyles, /\.codemirror-content-editor\s*\{\s*min-height:\s*52vh;/);
});

test('textarea loading fallback preserves programmatic loads and selection inserts', async (t) => {
  const dom = new JSDOM('<!doctype html><textarea id="body"></textarea><div id="mount"></div>', {
    pretendToBeVisual: true,
  });
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const originalMutationObserver = globalThis.MutationObserver;
  t.after(() => {
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
    globalThis.MutationObserver = originalMutationObserver;
    dom.window.close();
  });

  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.MutationObserver = dom.window.MutationObserver;
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {} });

  const moduleUrl = pathToFileURL(path.join(ROOT, 'public', 'js', 'contentEditor.js')).href + `?fallback=${Date.now()}`;
  const { createContentEditor } = await import(moduleUrl);
  const textarea = document.querySelector('#body');
  const mount = document.querySelector('#mount');
  const editor = createContentEditor(textarea, mount);
  let changes = 0;
  editor.onDidChange(() => { changes += 1; });

  editor.loadDocument('alpha', 'log-1');
  assert.equal(changes, 0);
  textarea.selectionStart = textarea.selectionEnd = 5;
  editor.insertAtSelection(' beta');
  assert.equal(editor.getValue(), 'alpha beta');
  assert.equal(textarea.value, 'alpha beta');
  assert.deepEqual(editor.getSelection(), { start: 10, end: 10 });
  assert.equal(changes, 1);

  editor.setVisible(false);
  assert.equal(textarea.style.display, 'none');
  assert.equal(mount.style.display, 'none');
  assert.doesNotThrow(() => editor.layout());
});
