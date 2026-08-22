const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { JSDOM } = require('jsdom');
const businessDate = require('../business-date');
const { DEFAULT_MEMORY_SETTINGS } = require('../lib/agent/memory-settings');
const { DEFAULT_AGENT_SETTINGS } = require('../lib/agent/agent-settings');
const { SEEDREAM_DEFAULT_SETTINGS } = require('../lib/agent/seedream');
const { GETOKEN_DEFAULT_SETTINGS } = require('../lib/agent/getoken');

const ROOT = path.resolve(__dirname, '..');
const DIARY_CATEGORY = '\u65e5\u8bb0';
const OTHER_CATEGORY = '\u5176\u4ed6';
const DIARY_MAGIC_PHRASE = '\u5982\u610f\u5982\u610f'; // 如意如意 — the fixed diary unlock phrase

function validPngBlob() {
  return new Blob([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], { type: 'image/png' });
}

function makeTempDataDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'schedule-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function clearAppModules() {
  for (const file of ['server.js', 'database.js', 'secret-store.js']) {
    delete require.cache[require.resolve(path.join(ROOT, file))];
  }
}

function loadFreshApp(t, { authToken, deepseekApiKey, deepseekBaseUrl, deepseekDefaultModel, moonshotApiKey, moonshotBaseUrl, openrouterApiKey, tavilyApiKey, tavilyBaseUrl, perplexityApiKey, perplexityBaseUrl, seedreamApiKey, seedreamBaseUrl, seedreamDefaultModel, westockNpxCommand, qqEmailAccount, qqEmailAuthCode } = {}) {
  const dataDir = makeTempDataDir(t);
  process.env.DATA_DIR = dataDir;
  process.env.AI_SECRETS_KEY_FILE = path.join(dataDir, 'ai-secrets.key');
  process.env.AUTH_TOKEN = authToken || '';
  process.env.ALLOW_INSECURE_NO_AUTH = authToken ? '' : '1';
  process.env.DEEPSEEK_API_KEY = deepseekApiKey || '';
  process.env.DEEPSEEK_BASE_URL = deepseekBaseUrl || 'https://api.deepseek.com';
  process.env.DEEPSEEK_DEFAULT_MODEL = deepseekDefaultModel || 'deepseek-v4-flash';
  process.env.MOONSHOT_API_KEY = moonshotApiKey || '';
  process.env.MOONSHOT_BASE_URL = moonshotBaseUrl || 'https://api.moonshot.cn/v1';
  process.env.OPENROUTER_API_KEY = openrouterApiKey || '';
  process.env.TAVILY_API_KEY = tavilyApiKey || '';
  process.env.TAVILY_BASE_URL = tavilyBaseUrl || 'https://api.tavily.com';
  process.env.PERPLEXITY_API_KEY = perplexityApiKey || '';
  process.env.PERPLEXITY_BASE_URL = perplexityBaseUrl || 'https://api.perplexity.ai';
  process.env.SEEDREAM_API_KEY = seedreamApiKey || '';
  process.env.SEEDREAM_BASE_URL = seedreamBaseUrl || 'https://ark.cn-beijing.volces.com/api/v3';
  process.env.SEEDREAM_DEFAULT_MODEL = seedreamDefaultModel || 'doubao-seedream-5-0-260128';
  process.env.WESTOCK_NPX_COMMAND = westockNpxCommand || 'npx -y westock-data-clawhub@1.0.4';
  process.env.QQ_EMAIL_ACCOUNT = qqEmailAccount || '';
  process.env.QQ_EMAIL_AUTH_CODE = qqEmailAuthCode || '';
  clearAppModules();

  const db = require(path.join(ROOT, 'database.js'));
  const { app } = require(path.join(ROOT, 'server.js'));
  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  t.after(() => new Promise(resolve => server.close(resolve)));
  t.after(() => {
    delete process.env.DATA_DIR;
    delete process.env.AI_SECRETS_KEY_FILE;
    delete process.env.AUTH_TOKEN;
    delete process.env.ALLOW_INSECURE_NO_AUTH;
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_BASE_URL;
    delete process.env.DEEPSEEK_DEFAULT_MODEL;
    delete process.env.MOONSHOT_API_KEY;
    delete process.env.MOONSHOT_BASE_URL;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.TAVILY_API_KEY;
    delete process.env.TAVILY_BASE_URL;
    delete process.env.PERPLEXITY_API_KEY;
    delete process.env.PERPLEXITY_BASE_URL;
    delete process.env.SEEDREAM_API_KEY;
    delete process.env.SEEDREAM_BASE_URL;
    delete process.env.SEEDREAM_DEFAULT_MODEL;
    delete process.env.WESTOCK_NPX_COMMAND;
    delete process.env.QQ_EMAIL_ACCOUNT;
    delete process.env.QQ_EMAIL_AUTH_CODE;
    clearAppModules();
  });

  return { app, db, baseUrl, dataDir, server };
}

function loadFreshDb(t) {
  const dataDir = makeTempDataDir(t);
  process.env.DATA_DIR = dataDir;
  process.env.AI_SECRETS_KEY_FILE = path.join(dataDir, 'ai-secrets.key');
  clearAppModules();
  const db = require(path.join(ROOT, 'database.js'));
  t.after(() => {
    delete process.env.DATA_DIR;
    delete process.env.AI_SECRETS_KEY_FILE;
    clearAppModules();
  });
  return db;
}

async function unlockDiary(baseUrl, password = DIARY_MAGIC_PHRASE, cookie) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(`${baseUrl}/api/auth/diary`, {
    method: 'POST',
    headers,
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

async function loginAndChangeBootstrapPassword(baseUrl, currentPassword, newPassword = 'new-secure-password') {
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: currentPassword }),
  });
  assert.equal(login.status, 200);
  const loginBody = await login.json();
  assert.equal(loginBody.must_change_password, true);
  const loginCookieHeader = login.headers.get('set-cookie') || '';
  assert.match(loginCookieHeader, /HttpOnly/);
  assert.match(loginCookieHeader, /SameSite=Strict/);
  assert.match(loginCookieHeader, /Max-Age=86(?:399|400)/);
  const loginCookie = loginCookieHeader.split(';')[0];
  assert.match(loginCookie, /^site_session=/);
  const changed = await fetch(`${baseUrl}/api/auth/password`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: loginCookie },
    body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
  });
  assert.equal(changed.status, 200);
  const cookie = (changed.headers.get('set-cookie') || '').split(';')[0];
  assert.match(cookie, /^site_session=/);
  return { cookie, newPassword };
}

async function loginAccount(baseUrl, username, password) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const body = await response.json().catch(() => ({}));
  const cookie = (response.headers.get('set-cookie') || '').split(';')[0];
  return { response, body, cookie };
}

async function changeAccountPassword(baseUrl, cookie, currentPassword, newPassword) {
  const response = await fetch(`${baseUrl}/api/auth/password`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
  });
  const body = await response.json().catch(() => ({}));
  return {
    response,
    body,
    cookie: (response.headers.get('set-cookie') || '').split(';')[0],
  };
}

async function jsonRequest(baseUrl, route, cookie, { method = 'GET', body } = {}) {
  const headers = { Cookie: cookie };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return fetch(`${baseUrl}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function restoreTestLogs(db, logs, categoryNames = ['开发', '会议', DIARY_CATEGORY]) {
  const result = db.restore({
    logs,
    todos: [],
    countdowns: [],
    categories: categoryNames.map(name => ({ name, sub: [], calendar_day_visible: true })),
    todoCategories: ['默认'],
    privateUploads: [],
  }, 'replace');
  assert.equal(result.success, true, result.error || 'failed to restore test logs');
}

function parseSseEvents(text) {
  return String(text || '')
    .split(/\r?\n\r?\n/)
    .map((block) => {
      let type = 'message';
      let data = '';
      block.split(/\r?\n/).forEach((line) => {
        if (line.startsWith('event:')) type = line.slice(6).trim();
        if (line.startsWith('data:')) data += line.slice(5).trimStart();
      });
      if (!data) return null;
      return { type, data: JSON.parse(data) };
    })
    .filter(Boolean);
}

test('diary lock protects detail, mutation, backup, restore, and reorder routes', async (t) => {
  const { db, baseUrl } = loadFreshApp(t);
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
  const { db, baseUrl } = loadFreshApp(t);
  db.addCategory(DIARY_CATEGORY, null);
  db.addCategory('notes', DIARY_CATEGORY);
  const diary = db.create({
    title: 'private',
    content: 'hidden',
    category: `${DIARY_CATEGORY}/notes`,
    log_date: '2026-05-16',
  });

  const lockedCategories = await (await fetch(`${baseUrl}/api/categories`)).json();
  assert.equal(lockedCategories.some(c => c.name === DIARY_CATEGORY), false);
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
  assert.equal((await fetch(`${baseUrl}/api/knowledge/documents/note:1`, {
    headers: { Cookie: cookie },
  })).status, 200);
});

test('unlocked system diary category can receive a new subcategory without prior stored root', async (t) => {
  const { baseUrl } = loadFreshApp(t);
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

test('category API reorders subcategories while preserving omitted items', async (t) => {
  const { db, baseUrl } = loadFreshApp(t);
  db.addCategory('Ordered', null);
  db.addCategory('Alpha', 'Ordered');
  db.addCategory('Beta', 'Ordered');
  db.addCategory('Gamma', 'Ordered');

  const invalid = await fetch(`${baseUrl}/api/categories/${encodeURIComponent('Ordered')}/subcategories/reorder`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderedSubs: 'Gamma' }),
  });
  assert.equal(invalid.status, 400);

  const missing = await fetch(`${baseUrl}/api/categories/${encodeURIComponent('Missing')}/subcategories/reorder`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderedSubs: ['Gamma'] }),
  });
  assert.equal(missing.status, 404);

  const reordered = await fetch(`${baseUrl}/api/categories/${encodeURIComponent('Ordered')}/subcategories/reorder`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderedSubs: ['Gamma', 'Alpha'] }),
  });
  assert.equal(reordered.status, 200);
  assert.deepEqual((await reordered.json()).sub, ['Gamma', 'Alpha', 'Beta']);

  const categories = await (await fetch(`${baseUrl}/api/categories`)).json();
  assert.deepEqual(categories.find(category => category.name === 'Ordered').sub, ['Gamma', 'Alpha', 'Beta']);
});

test('category route parameters are decoded exactly once', async (t) => {
  const { baseUrl } = loadFreshApp(t);
  const literalName = 'Literal%2FCategory';
  const created = await fetch(`${baseUrl}/api/categories`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: literalName }),
  });
  assert.equal(created.status, 201);
  const deleted = await fetch(`${baseUrl}/api/categories/${encodeURIComponent(literalName)}`, { method: 'DELETE' });
  assert.equal(deleted.status, 200);
  const categories = await (await fetch(`${baseUrl}/api/categories`)).json();
  assert.equal(categories.some(category => category.name === literalName), false);
});

test('diary routes are always protected until the magic phrase unlocks them', async (t) => {
  const { db, baseUrl } = loadFreshApp(t);
  const diary = db.create({
    title: 'private',
    content: 'hidden until unlocked',
    category: DIARY_CATEGORY,
    log_date: '2026-05-16',
  });

  assert.deepEqual(await (await fetch(`${baseUrl}/api/auth/diary/status`)).json(), {
    enabled: true,
    locked: true,
  });
  assert.equal((await fetch(`${baseUrl}/api/logs/${diary.id}`)).status, 403);
  assert.equal((await fetch(`${baseUrl}/api/backup`)).status, 403);
  assert.equal((await fetch(`${baseUrl}/api/logs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'new private',
      content: 'not allowed while locked',
      category: DIARY_CATEGORY,
      log_date: '2026-05-16',
    }),
  })).status, 403);

  const cookie = await unlockDiary(baseUrl);
  assert.deepEqual(await (await fetch(`${baseUrl}/api/auth/diary/status`, { headers: { Cookie: cookie } })).json(), {
    enabled: true,
    locked: false,
  });
  assert.equal((await fetch(`${baseUrl}/api/logs/${diary.id}`, { headers: { Cookie: cookie } })).status, 200);
});

test('site auth rejects the legacy bearer token and allows an authenticated account backup', async (t) => {
  const { baseUrl } = loadFreshApp(t, { authToken: 'backup-secret' });

  assert.equal((await fetch(`${baseUrl}/api/backup`)).status, 401);
  assert.equal((await fetch(`${baseUrl}/api/backup`, { headers: { Authorization: 'Bearer backup-secret' } })).status, 401);
  const { cookie } = await loginAndChangeBootstrapPassword(baseUrl, 'backup-secret');
  const diaryCookie = await unlockDiary(baseUrl, DIARY_MAGIC_PHRASE, cookie);
  const authorized = await fetch(`${baseUrl}/api/backup`, { headers: { Cookie: `${cookie}; ${diaryCookie}` } });
  assert.equal(authorized.status, 200);
  assert.match(
    authorized.headers.get('content-disposition') || '',
    /^attachment; filename=work-log-backup-\d{4}-\d{2}-\d{2}\.json$/,
  );
});

test('site authentication also protects uploaded files and supports an HttpOnly session cookie', async (t) => {
  const { baseUrl } = loadFreshApp(t, { authToken: 'site-secret' });
  const { cookie } = await loginAndChangeBootstrapPassword(baseUrl, 'site-secret');
  const authCheck = await fetch(`${baseUrl}/api/auth/check`, { headers: { Cookie: cookie } });
  assert.equal(authCheck.status, 200);
  assert.equal((await authCheck.json()).authenticated, true);

  const form = new FormData();
  form.append('image', validPngBlob(), 'protected.png');
  const upload = await fetch(`${baseUrl}/api/upload`, {
    method: 'POST',
    headers: { Cookie: cookie },
    body: form,
  });
  assert.equal(upload.status, 200);
  const image = await upload.json();
  assert.equal((await fetch(`${baseUrl}${image.url}`)).status, 401);
  assert.equal((await fetch(`${baseUrl}${image.url}`, { headers: { Cookie: cookie } })).status, 200);
});

test('account registry hashes credentials, persists sessions, expires them, and fails closed on corruption', (t) => {
  const { createAuthStore, SESSION_TTL_MS } = require('../auth-store');
  const dataDir = makeTempDataDir(t);
  let clock = Date.parse('2026-07-14T08:00:00.000Z');
  const store = createAuthStore({
    dataDir,
    bootstrapPassword: '123456',
    now: () => clock,
  });
  const admin = store.authenticate('ADMIN', '123456');
  assert.ok(admin);
  assert.equal(admin.username, 'admin');
  assert.equal(admin.must_change_password, true);
  assert.equal(admin.storage_key, 'legacy');
  const session = store.createSession(admin.id);
  assert.equal(session.expires_at - clock, SESSION_TTL_MS);

  const usersText = fs.readFileSync(path.join(dataDir, 'users.json'), 'utf8');
  const sessionsText = fs.readFileSync(path.join(dataDir, 'auth-sessions.json'), 'utf8');
  assert.match(usersText, /scrypt\$/);
  assert.doesNotMatch(usersText, /123456/);
  assert.doesNotMatch(sessionsText, new RegExp(session.token));
  assert.match(sessionsText, /token_hash/);

  const restarted = createAuthStore({ dataDir, bootstrapPassword: 'changed-env-value', now: () => clock });
  assert.equal(restarted.getSession(session.token)?.user.id, admin.id);
  assert.equal(restarted.authenticate('admin', 'changed-env-value'), null);

  clock += SESSION_TTL_MS + 1;
  const expired = createAuthStore({ dataDir, now: () => clock });
  assert.equal(expired.getSession(session.token), null);

  const missingDir = makeTempDataDir(t);
  assert.throws(
    () => createAuthStore({ dataDir: missingDir }),
    /AUTH_TOKEN is required to initialize the first administrator/,
  );

  fs.writeFileSync(path.join(dataDir, 'auth-sessions.json'), '{broken', 'utf8');
  assert.throws(() => createAuthStore({ dataDir, now: () => clock }), /Failed to read auth-sessions\.json/);
  assert.equal(fs.readdirSync(dataDir).some(name => name.startsWith('auth-sessions.json.corrupt-')), true);

  const corruptUsersDir = makeTempDataDir(t);
  createAuthStore({ dataDir: corruptUsersDir, bootstrapPassword: 'temporary-password' });
  fs.writeFileSync(path.join(corruptUsersDir, 'users.json'), '{}', 'utf8');
  assert.throws(() => createAuthStore({ dataDir: corruptUsersDir }), /Failed to read users\.json/);
  assert.equal(fs.readdirSync(corruptUsersDir).some(name => name.startsWith('users.json.corrupt-')), true);
});

test('first account migration validates existing data before creating users.json', (t) => {
  const dataDir = makeTempDataDir(t);
  fs.writeFileSync(path.join(dataDir, 'logs.json'), '[]', 'utf8');
  fs.writeFileSync(path.join(dataDir, 'categories.json'), JSON.stringify([
    { name: '开发', sub: [], calendar_day_visible: true },
    { name: '其他', sub: [], calendar_day_visible: true },
  ]), 'utf8');
  fs.writeFileSync(path.join(dataDir, 'todos.json'), '{broken', 'utf8');
  process.env.DATA_DIR = dataDir;
  process.env.AI_SECRETS_KEY_FILE = path.join(dataDir, 'ai-secrets.key');
  process.env.AUTH_TOKEN = '123456';
  process.env.ALLOW_INSECURE_NO_AUTH = '';
  clearAppModules();
  t.after(() => {
    delete process.env.DATA_DIR;
    delete process.env.AI_SECRETS_KEY_FILE;
    delete process.env.AUTH_TOKEN;
    delete process.env.ALLOW_INSECURE_NO_AUTH;
    clearAppModules();
  });

  assert.throws(() => require(path.join(ROOT, 'server.js')), /Failed to read todos\.json/);
  assert.equal(fs.existsSync(path.join(dataDir, 'users.json')), false);
  assert.equal(fs.readFileSync(path.join(dataDir, 'todos.json'), 'utf8'), '{broken');
  assert.equal(fs.readdirSync(dataDir).some(name => name.startsWith('todos.json.corrupt-')), true);
});

test('dedicated login and administrator-managed account lifecycle enforce forced password changes', async (t) => {
  const { baseUrl, dataDir, server } = loadFreshApp(t, { authToken: '123456' });

  const root = await fetch(`${baseUrl}/?from=calendar`, { redirect: 'manual' });
  assert.equal(root.status, 302);
  assert.match(root.headers.get('location') || '', /^\/login\?next=/);
  assert.equal((await fetch(`${baseUrl}/login`)).status, 200);
  assert.equal((await fetch(`${baseUrl}/api/logs`)).status, 401);
  assert.equal((await fetch(`${baseUrl}/api/logs`, { headers: { Authorization: 'Bearer 123456' } })).status, 401);

  const { cookie: adminCookie, newPassword: adminPassword } = await loginAndChangeBootstrapPassword(baseUrl, '123456', 'admin-password-2026');
  const usersResponse = await jsonRequest(baseUrl, '/api/admin/users', adminCookie);
  assert.equal(usersResponse.status, 200);
  const users = await usersResponse.json();
  const admin = users.find(user => user.username === 'admin');
  assert.ok(admin);
  assert.equal(admin.role, 'admin');
  assert.equal(admin.must_change_password, false);

  const createdResponse = await jsonRequest(baseUrl, '/api/admin/users', adminCookie, {
    method: 'POST',
    body: { username: 'Member.One', display_name: '成员一', temporary_password: 'member-temp-2026', role: 'member' },
  });
  assert.equal(createdResponse.status, 201);
  const member = await createdResponse.json();
  assert.equal(member.username, 'member.one');
  assert.equal(member.must_change_password, true);

  const duplicate = await jsonRequest(baseUrl, '/api/admin/users', adminCookie, {
    method: 'POST',
    body: { username: 'MEMBER.ONE', display_name: '重复', temporary_password: 'another-temp-2026' },
  });
  assert.equal(duplicate.status, 400);
  const invalidRole = await jsonRequest(baseUrl, '/api/admin/users', adminCookie, {
    method: 'POST',
    body: { username: 'bad.role', display_name: '错误角色', temporary_password: 'another-temp-2026', role: 'owner' },
  });
  assert.equal(invalidRole.status, 400);

  const memberLogin = await loginAccount(baseUrl, 'MEMBER.ONE', 'member-temp-2026');
  assert.equal(memberLogin.response.status, 200);
  assert.equal(memberLogin.body.must_change_password, true);
  const blockedWorkspace = await jsonRequest(baseUrl, '/api/logs', memberLogin.cookie);
  assert.equal(blockedWorkspace.status, 403);
  assert.equal((await blockedWorkspace.json()).code, 'PASSWORD_CHANGE_REQUIRED');

  const memberChanged = await changeAccountPassword(baseUrl, memberLogin.cookie, 'member-temp-2026', 'member-password-2026');
  assert.equal(memberChanged.response.status, 200);
  assert.match(memberChanged.cookie, /^site_session=/);
  let memberCookie = memberChanged.cookie;
  assert.equal((await jsonRequest(baseUrl, '/api/admin/users', memberCookie)).status, 403);

  const profile = await jsonRequest(baseUrl, '/api/auth/me', memberCookie, {
    method: 'PATCH',
    body: { display_name: '成员甲' },
  });
  assert.equal(profile.status, 200);
  assert.equal((await profile.json()).display_name, '成员甲');

  for (const body of [{ role: 'member' }, { status: 'disabled' }]) {
    const protectedAdmin = await jsonRequest(baseUrl, `/api/admin/users/${admin.id}`, adminCookie, { method: 'PATCH', body });
    assert.equal(protectedAdmin.status, 400);
    assert.match((await protectedAdmin.json()).error, /最后一个有效管理员/);
  }

  const disabled = await jsonRequest(baseUrl, `/api/admin/users/${member.id}`, adminCookie, {
    method: 'PATCH',
    body: { status: 'disabled' },
  });
  assert.equal(disabled.status, 200);
  assert.equal((await jsonRequest(baseUrl, '/api/auth/me', memberCookie)).status, 401);
  assert.equal((await loginAccount(baseUrl, 'member.one', 'member-password-2026')).response.status, 401);

  assert.equal((await jsonRequest(baseUrl, `/api/admin/users/${member.id}`, adminCookie, {
    method: 'PATCH', body: { status: 'active' },
  })).status, 200);
  assert.equal((await jsonRequest(baseUrl, `/api/admin/users/${member.id}/reset-password`, adminCookie, {
    method: 'POST', body: { temporary_password: 'member-reset-2026' },
  })).status, 200);
  assert.equal((await loginAccount(baseUrl, 'member.one', 'member-password-2026')).response.status, 401);
  const resetLogin = await loginAccount(baseUrl, 'member.one', 'member-reset-2026');
  assert.equal(resetLogin.response.status, 200);
  assert.equal(resetLogin.body.must_change_password, true);
  const promoted = await jsonRequest(baseUrl, `/api/admin/users/${member.id}`, adminCookie, {
    method: 'PATCH', body: { username: 'member.renamed', role: 'admin' },
  });
  assert.equal(promoted.status, 200);
  assert.equal((await promoted.json()).username, 'member.renamed');
  assert.equal((await jsonRequest(baseUrl, `/api/admin/users/${member.id}`, adminCookie, {
    method: 'PATCH', body: { role: 'member' },
  })).status, 200);

  await new Promise(resolve => server.close(resolve));
  process.env.AUTH_TOKEN = 'different-bootstrap-value';
  clearAppModules();
  const { app: restartedApp } = require(path.join(ROOT, 'server.js'));
  const restartedServer = restartedApp.listen(0);
  const restartedUrl = `http://127.0.0.1:${restartedServer.address().port}`;
  t.after(() => new Promise(resolve => restartedServer.close(resolve)));
  const persistedSession = await jsonRequest(restartedUrl, '/api/auth/me', adminCookie);
  assert.equal(persistedSession.status, 200);
  assert.equal((await persistedSession.json()).username, 'admin');
  assert.equal((await loginAccount(restartedUrl, 'admin', 'different-bootstrap-value')).response.status, 401);
  assert.equal((await loginAccount(restartedUrl, 'admin', adminPassword)).response.status, 200);

  const registryText = fs.readFileSync(path.join(dataDir, 'users.json'), 'utf8');
  assert.doesNotMatch(registryText, /123456|admin-password-2026|member-password-2026|member-reset-2026/);
});

test('login is limited to five attempts per IP and uses a generic credential error', async (t) => {
  const { baseUrl } = loadFreshApp(t, { authToken: '123456' });
  for (let attempt = 0; attempt < 5; attempt++) {
    const login = await loginAccount(baseUrl, 'admin', `wrong-${attempt}`);
    assert.equal(login.response.status, 401);
    assert.equal(login.body.error, '用户名或密码错误');
  }
  const limited = await loginAccount(baseUrl, 'admin', '123456');
  assert.equal(limited.response.status, 429);
});

test('logs, todos, countdowns, categories, AI state, reminders, uploads, and backups are isolated by account', async (t) => {
  const { baseUrl, dataDir } = loadFreshApp(t, {
    authToken: '123456',
    deepseekApiKey: 'legacy-admin-deepseek-key',
    perplexityApiKey: 'legacy-admin-perplexity-key',
    seedreamApiKey: 'legacy-admin-seedream-key',
  });
  const { cookie: adminCookie } = await loginAndChangeBootstrapPassword(baseUrl, '123456', 'admin-isolation-2026');
  const createdMember = await jsonRequest(baseUrl, '/api/admin/users', adminCookie, {
    method: 'POST',
    body: { username: 'isolated.member', display_name: '隔离成员', temporary_password: 'member-isolation-temp', role: 'member' },
  });
  assert.equal(createdMember.status, 201);
  const member = await createdMember.json();
  const memberLogin = await loginAccount(baseUrl, 'isolated.member', 'member-isolation-temp');
  const memberChanged = await changeAccountPassword(baseUrl, memberLogin.cookie, 'member-isolation-temp', 'member-isolation-2026');
  assert.equal(memberChanged.response.status, 200);
  const memberCookie = memberChanged.cookie;

  const makeLog = (title, content) => ({ title, content, category: '开发', hours: 1, log_date: '2026-07-14' });
  const adminLogResponse = await jsonRequest(baseUrl, '/api/logs', adminCookie, {
    method: 'POST', body: makeLog('admin workspace log', 'admin private content'),
  });
  const memberLogResponse = await jsonRequest(baseUrl, '/api/logs', memberCookie, {
    method: 'POST', body: makeLog('member workspace log', 'member private content'),
  });
  assert.equal(adminLogResponse.status, 201);
  assert.equal(memberLogResponse.status, 201);
  const adminLog = await adminLogResponse.json();
  const memberLog = await memberLogResponse.json();
  assert.equal(adminLog.id, 1);
  assert.equal(memberLog.id, 1);

  const adminTodo = await jsonRequest(baseUrl, '/api/todos', adminCookie, {
    method: 'POST', body: { title: 'admin todo', due_date: '2026-07-15', priority: 'normal' },
  });
  const memberTodo = await jsonRequest(baseUrl, '/api/todos', memberCookie, {
    method: 'POST', body: { title: 'member todo', due_date: '2026-07-16', priority: 'urgent' },
  });
  assert.equal((await adminTodo.json()).id, 1);
  assert.equal((await memberTodo.json()).id, 1);

  const adminCountdown = await jsonRequest(baseUrl, '/api/countdowns', adminCookie, {
    method: 'POST', body: { title: 'admin countdown', target_date: '2026-12-31', repeat_yearly: false, notes: '' },
  });
  const memberCountdown = await jsonRequest(baseUrl, '/api/countdowns', memberCookie, {
    method: 'POST', body: { title: 'member countdown', target_date: '2027-01-01', repeat_yearly: true, notes: 'member only' },
  });
  assert.equal((await adminCountdown.json()).id, 1);
  assert.equal((await memberCountdown.json()).id, 1);

  assert.equal((await jsonRequest(baseUrl, '/api/categories', adminCookie, {
    method: 'POST', body: { name: '管理员分类' },
  })).status, 201);
  assert.equal((await jsonRequest(baseUrl, '/api/categories', memberCookie, {
    method: 'POST', body: { name: '成员分类' },
  })).status, 201);

  assert.equal((await jsonRequest(baseUrl, '/api/ai/settings', adminCookie, {
    method: 'PUT', body: { webSearchEnabled: true },
  })).status, 200);
  assert.equal((await jsonRequest(baseUrl, '/api/ai/settings', memberCookie, {
    method: 'PUT', body: { webSearchEnabled: false },
  })).status, 200);

  assert.equal((await jsonRequest(baseUrl, '/api/todo-reminder-settings', adminCookie, {
    method: 'PUT', body: { enabled: false, recipientEmail: 'admin@example.com', sendTime: '08:10' },
  })).status, 200);
  assert.equal((await jsonRequest(baseUrl, '/api/todo-reminder-settings', memberCookie, {
    method: 'PUT', body: { enabled: false, recipientEmail: 'member@example.com', sendTime: '09:20' },
  })).status, 200);

  const registry = JSON.parse(fs.readFileSync(path.join(dataDir, 'users.json'), 'utf8')).users;
  const memberRecord = registry.find(user => user.id === member.id);
  const adminUploads = path.join(dataDir, 'uploads');
  const memberUploads = path.join(dataDir, 'accounts', memberRecord.storage_key, 'uploads');
  fs.mkdirSync(adminUploads, { recursive: true });
  fs.mkdirSync(memberUploads, { recursive: true });
  fs.writeFileSync(path.join(adminUploads, 'same-name.png'), Buffer.from('admin-image'));
  fs.writeFileSync(path.join(memberUploads, 'same-name.png'), Buffer.from('member-image'));

  const adminImage = await jsonRequest(baseUrl, '/uploads/same-name.png', adminCookie);
  const memberImage = await jsonRequest(baseUrl, '/uploads/same-name.png', memberCookie);
  assert.equal(await adminImage.text(), 'admin-image');
  assert.equal(await memberImage.text(), 'member-image');

  const memberUploadForm = new FormData();
  memberUploadForm.append('image', validPngBlob(), 'member-upload.png');
  const memberUploadResponse = await fetch(`${baseUrl}/api/upload`, {
    method: 'POST', headers: { Cookie: memberCookie }, body: memberUploadForm,
  });
  assert.equal(memberUploadResponse.status, 200);
  const memberUpload = await memberUploadResponse.json();
  assert.equal((await jsonRequest(baseUrl, memberUpload.url, adminCookie)).status, 404);
  assert.equal((await jsonRequest(baseUrl, memberUpload.url, memberCookie)).status, 200);

  const adminLogs = await (await jsonRequest(baseUrl, '/api/logs', adminCookie)).json();
  const memberLogs = await (await jsonRequest(baseUrl, '/api/logs', memberCookie)).json();
  assert.deepEqual(adminLogs.items.map(log => log.title), ['admin workspace log']);
  assert.deepEqual(memberLogs.items.map(log => log.title), ['member workspace log']);
  assert.deepEqual((await (await jsonRequest(baseUrl, '/api/todos', adminCookie)).json()).map(todo => todo.title), ['admin todo']);
  assert.deepEqual((await (await jsonRequest(baseUrl, '/api/todos', memberCookie)).json()).map(todo => todo.title), ['member todo']);
  assert.deepEqual((await (await jsonRequest(baseUrl, '/api/countdowns', adminCookie)).json()).map(item => item.title), ['admin countdown']);
  assert.deepEqual((await (await jsonRequest(baseUrl, '/api/countdowns', memberCookie)).json()).map(item => item.title), ['member countdown']);

  const adminCategories = await (await jsonRequest(baseUrl, '/api/categories', adminCookie)).json();
  const memberCategories = await (await jsonRequest(baseUrl, '/api/categories', memberCookie)).json();
  assert.equal(adminCategories.some(category => category.name === '管理员分类'), true);
  assert.equal(adminCategories.some(category => category.name === '成员分类'), false);
  assert.equal(memberCategories.some(category => category.name === '成员分类'), true);
  assert.equal(memberCategories.some(category => category.name === '管理员分类'), false);
  const adminAiSettings = await (await jsonRequest(baseUrl, '/api/ai/settings', adminCookie)).json();
  const memberAiSettings = await (await jsonRequest(baseUrl, '/api/ai/settings', memberCookie)).json();
  assert.equal(adminAiSettings.webSearchEnabled, true);
  assert.equal(memberAiSettings.webSearchEnabled, false);
  assert.equal(adminAiSettings.apiKeyConfigured, true);
  assert.equal(adminAiSettings.perplexityApiKeyConfigured, true);
  assert.equal(adminAiSettings.seedreamApiKeyConfigured, true);
  assert.equal(memberAiSettings.apiKeyConfigured, false);
  assert.equal(memberAiSettings.perplexityApiKeyConfigured, false);
  assert.equal(memberAiSettings.seedreamApiKeyConfigured, false);
  assert.equal((await (await jsonRequest(baseUrl, '/api/todo-reminder-settings', adminCookie)).json()).recipientEmail, 'admin@example.com');
  assert.equal((await (await jsonRequest(baseUrl, '/api/todo-reminder-settings', memberCookie)).json()).recipientEmail, 'member@example.com');

  const adminDiaryCookie = await unlockDiary(baseUrl, DIARY_MAGIC_PHRASE, adminCookie);
  const memberDiaryCookie = await unlockDiary(baseUrl, DIARY_MAGIC_PHRASE, memberCookie);
  const adminBackup = await (await jsonRequest(baseUrl, '/api/backup', `${adminCookie}; ${adminDiaryCookie}`)).json();
  const memberBackup = await (await jsonRequest(baseUrl, '/api/backup', `${memberCookie}; ${memberDiaryCookie}`)).json();
  assert.deepEqual(adminBackup.logs.map(log => log.title), ['admin workspace log']);
  assert.deepEqual(memberBackup.logs.map(log => log.title), ['member workspace log']);
  assert.equal(Object.hasOwn(adminBackup, 'users'), false);
  assert.equal(Object.hasOwn(memberBackup, 'sessions'), false);
  assert.equal(Object.hasOwn(adminBackup, 'aiChats'), false);
  assert.equal(Object.hasOwn(memberBackup, 'aiChats'), false);
  assert.equal(Object.hasOwn(adminBackup, 'aiMedia'), false);

  memberBackup.logs[0].title = 'member restored log';
  const memberRestore = await jsonRequest(baseUrl, '/api/restore', `${memberCookie}; ${memberDiaryCookie}`, {
    method: 'POST', body: memberBackup,
  });
  assert.equal(memberRestore.status, 200);
  const memberDocs = await (await jsonRequest(
    baseUrl,
    '/api/knowledge/documents',
    `${memberCookie}; ${memberDiaryCookie}`,
  )).json();
  assert.equal(memberDocs.documents.find(doc => doc.id === 'note:1')?.title, 'member restored log');
  assert.equal((await (await jsonRequest(baseUrl, `/api/logs/${adminLog.id}`, adminCookie)).json()).title, 'admin workspace log');

  assert.equal((await jsonRequest(baseUrl, `/api/logs/${adminLog.id}`, adminCookie, { method: 'DELETE' })).status, 200);
  const memberStillExists = await jsonRequest(
    baseUrl,
    `/api/knowledge/documents/note:1`,
    memberCookie,
  );
  assert.equal(memberStillExists.status, 200);
  assert.equal((await memberStillExists.json()).title, 'member restored log');

  const registryText = fs.readFileSync(path.join(dataDir, 'users.json'), 'utf8');
  assert.doesNotMatch(registryText, /admin workspace log|member workspace log|AI profile|AI history/);
});

test('diary unlock uses the shared magic phrase and diary sessions are isolated per account', async (t) => {
  const { baseUrl } = loadFreshApp(t, { authToken: '123456' });
  const { cookie: adminCookie } = await loginAndChangeBootstrapPassword(baseUrl, '123456', 'admin-diary-account');
  const memberResponse = await jsonRequest(baseUrl, '/api/admin/users', adminCookie, {
    method: 'POST',
    body: { username: 'diary.member', display_name: '日记成员', temporary_password: 'diary-member-temp', role: 'member' },
  });
  const member = await memberResponse.json();
  const memberLogin = await loginAccount(baseUrl, 'diary.member', 'diary-member-temp');
  const memberChanged = await changeAccountPassword(baseUrl, memberLogin.cookie, 'diary-member-temp', 'diary-member-account');
  let memberCookie = memberChanged.cookie;

  // Diary protection is always enabled for every account.
  assert.deepEqual(await (await jsonRequest(baseUrl, '/api/auth/diary/status', adminCookie)).json(), { enabled: true, locked: true });
  assert.deepEqual(await (await jsonRequest(baseUrl, '/api/auth/diary/status', memberCookie)).json(), { enabled: true, locked: true });

  const adminUnlock = await jsonRequest(baseUrl, '/api/auth/diary', adminCookie, {
    method: 'POST', body: { password: DIARY_MAGIC_PHRASE },
  });
  assert.equal(adminUnlock.status, 200);
  const adminDiaryCookie = (adminUnlock.headers.get('set-cookie') || '').split(';')[0];
  assert.match(adminDiaryCookie, /^diary_session=/);

  // An admin diary session does not unlock the member's account.
  const wrongAccountStatus = await fetch(`${baseUrl}/api/auth/diary/status`, {
    headers: { Cookie: `${memberCookie}; ${adminDiaryCookie}` },
  });
  assert.deepEqual(await wrongAccountStatus.json(), { enabled: true, locked: true });
  const wrongPhrase = await jsonRequest(baseUrl, '/api/auth/diary', memberCookie, {
    method: 'POST', body: { password: 'not-the-phrase' },
  });
  assert.equal(wrongPhrase.status, 403);

  const memberUnlock = await jsonRequest(baseUrl, '/api/auth/diary', memberCookie, {
    method: 'POST', body: { password: DIARY_MAGIC_PHRASE },
  });
  assert.equal(memberUnlock.status, 200);
  const memberDiaryCookie = (memberUnlock.headers.get('set-cookie') || '').split(';')[0];
  const diaryLog = { title: 'member diary', content: 'member diary secret', category: DIARY_CATEGORY, hours: 0, log_date: '2026-07-14' };
  assert.equal((await jsonRequest(baseUrl, '/api/logs', memberCookie, { method: 'POST', body: diaryLog })).status, 403);
  assert.equal((await fetch(`${baseUrl}/api/logs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: `${memberCookie}; ${adminDiaryCookie}` },
    body: JSON.stringify(diaryLog),
  })).status, 403);
  assert.equal((await fetch(`${baseUrl}/api/logs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: `${memberCookie}; ${memberDiaryCookie}` },
    body: JSON.stringify(diaryLog),
  })).status, 201);

  // Resetting the member account password revokes their diary session.
  assert.equal((await jsonRequest(baseUrl, `/api/admin/users/${member.id}/reset-password`, adminCookie, {
    method: 'POST', body: { temporary_password: 'diary-member-reset' },
  })).status, 200);
  assert.equal((await jsonRequest(baseUrl, '/api/auth/me', memberCookie)).status, 401);
  const resetLogin = await loginAccount(baseUrl, 'diary.member', 'diary-member-reset');
  const afterReset = await changeAccountPassword(baseUrl, resetLogin.cookie, 'diary-member-reset', 'diary-member-final');
  assert.equal(afterReset.response.status, 200);
  memberCookie = afterReset.cookie;
  const revokedDiary = await fetch(`${baseUrl}/api/auth/diary/status`, {
    headers: { Cookie: `${memberCookie}; ${memberDiaryCookie}` },
  });
  assert.deepEqual(await revokedDiary.json(), { enabled: true, locked: true });
});

test('AI settings persist to local data storage and validate options', async (t) => {
  const { baseUrl, dataDir } = loadFreshApp(t);

  const defaults = await fetch(`${baseUrl}/api/ai/settings`);
  assert.equal(defaults.status, 200);
  assert.deepEqual(await defaults.json(), {
    apiKey: '',
    apiKeyConfigured: false,
    moonshotApiKey: '',
    moonshotApiKeyConfigured: false,
    openrouterApiKey: '',
    openrouterApiKeyConfigured: false,
    model: '',
    reasoningEffort: 'high',
    reasoningMode: 'effort',
    thinkingMode: 'enabled',
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
    getokenApiKey: '',
    getokenGrokImagineApiKey: '',
    getokenNanoBananaApiKey: '',
    getokenApiKeyConfigured: false,
    getokenGrokImagineApiKeyConfigured: false,
    getokenNanoBananaApiKeyConfigured: false,
    ...SEEDREAM_DEFAULT_SETTINGS,
    ...GETOKEN_DEFAULT_SETTINGS,
    seedreamModel: 'doubao-seedream-5-0-260128',
    seedreamSize: '2K',
    seedreamWatermark: true,
    skills: {
      westock: { enabled: true },
      perplexity: { enabled: true },
    },
    agentMaxRounds: 12,
    agentFileReadMaxMb: 4,
    ...DEFAULT_MEMORY_SETTINGS,
    ...DEFAULT_AGENT_SETTINGS,
    customProviders: [],
  });

  const saved = await fetch(`${baseUrl}/api/ai/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      apiKey: 'sk-local-settings',
      moonshotApiKey: 'sk-moonshot-settings',
      openrouterApiKey: 'sk-or-local-settings',
      model: 'deepseek-v4-pro',
      reasoningEffort: 'max',
      reasoningMode: 'default',
      tavilyApiKey: 'tvly-local-settings',
      perplexityApiKey: 'pplx-local-settings',
      webSearchEnabled: true,
      kimiWebSearchEnabled: true,
      openrouterZdrEnabled: false,
      webSearchDepth: 'advanced',
      seedreamApiKey: 'seedream-local-settings',
      seedreamModel: 'doubao-seedream-4-5-251128',
      seedreamSize: '2848x1600',
      seedreamWatermark: false,
      skills: {
        westock: { enabled: false },
        perplexity: { enabled: false },
      },
      agentMaxRounds: 100,
      agentFileReadMaxMb: 64,
      memoryRefreshMaxRounds: 8,
      memoryRefreshMaxProposals: 12,
      memoryRefreshSessionLimit: 10,
      memoryContextMaxL2: 30,
    }),
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), {
    apiKey: '',
    apiKeyConfigured: true,
    moonshotApiKey: '',
    moonshotApiKeyConfigured: true,
    openrouterApiKey: '',
    openrouterApiKeyConfigured: true,
    model: 'deepseek-v4-pro',
    reasoningEffort: 'max',
    reasoningMode: 'default',
    thinkingMode: 'enabled',
    tavilyApiKey: '',
    tavilyApiKeyConfigured: true,
    perplexityApiKey: '',
    perplexityApiKeyConfigured: true,
    webSearchEnabled: true,
    kimiWebSearchEnabled: true,
    openrouterZdrEnabled: false,
    webSearchDepth: 'advanced',
    seedreamApiKey: '',
    seedreamApiKeyConfigured: true,
    seedreamModel: 'doubao-seedream-4-5-251128',
    seedreamSize: '2848x1600',
    seedreamWatermark: false,
    seedreamOutputFormat: 'jpeg',
    seedreamOptimizePromptMode: 'standard',
    seedreamSequential: 'disabled',
    seedreamMaxImages: 15,
    seedreamWebSearch: false,
    seedreamLayerDecomposition: false,
    seedreamBackground: 'opaque',
    seedreamStream: true,
    getokenApiKey: '',
    getokenGrokImagineApiKey: '',
    getokenNanoBananaApiKey: '',
    getokenApiKeyConfigured: false,
    getokenGrokImagineApiKeyConfigured: false,
    getokenNanoBananaApiKeyConfigured: false,
    imageProvider: 'seedream',
    getokenModel: 'gpt-image-2',
    getokenSize: 'auto',
    getokenQuality: 'high',
    getokenN: 1,
    skills: {
      westock: { enabled: false },
      perplexity: { enabled: false },
    },
    agentMaxRounds: 100,
    agentFileReadMaxMb: 64,
    ...DEFAULT_MEMORY_SETTINGS,
    ...DEFAULT_AGENT_SETTINGS,
    memoryRefreshMaxRounds: 8,
    memoryRefreshMaxProposals: 12,
    memoryRefreshSessionLimit: 10,
    memoryContextMaxL2: 30,
    customProviders: [],
  });
  assert.equal(fs.existsSync(path.join(dataDir, 'ai-settings.json')), true);
  const encryptedSettings = fs.readFileSync(path.join(dataDir, 'ai-settings.json'), 'utf8');
  assert.doesNotMatch(encryptedSettings, /sk-local-settings|sk-moonshot-settings|sk-or-local-settings|tvly-local-settings|pplx-local-settings|seedream-local-settings/);
  assert.match(encryptedSettings, /enc:v1:/);
  assert.equal(fs.existsSync(path.join(dataDir, 'ai-secrets.key')), true);

  const preserved = await fetch(`${baseUrl}/api/ai/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey: '', moonshotApiKey: '', openrouterApiKey: '', tavilyApiKey: '', perplexityApiKey: '', seedreamApiKey: '' }),
  });
  assert.equal(preserved.status, 200);
  const preservedBody = await preserved.json();
  assert.equal(preservedBody.apiKeyConfigured, true);
  assert.equal(preservedBody.moonshotApiKeyConfigured, true);
  assert.equal(preservedBody.openrouterApiKeyConfigured, true);
  assert.equal(preservedBody.agentMaxRounds, 100);
  assert.equal(preservedBody.agentFileReadMaxMb, 64);
  assert.equal(preservedBody.memoryRefreshMaxProposals, 12);
  assert.equal(preservedBody.memoryContextMaxL2, 30);
  assert.doesNotMatch(fs.readFileSync(path.join(dataDir, 'ai-settings.json'), 'utf8'), /sk-local-settings|sk-moonshot-settings|sk-or-local-settings/);

  const cleared = await fetch(`${baseUrl}/api/ai/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clearApiKeys: true }),
  });
  assert.equal(cleared.status, 200);
  const clearedBody = await cleared.json();
  assert.equal(clearedBody.apiKeyConfigured, false);
  assert.equal(clearedBody.moonshotApiKeyConfigured, false);
  assert.equal(clearedBody.openrouterApiKeyConfigured, false);
  assert.doesNotMatch(fs.readFileSync(path.join(dataDir, 'ai-settings.json'), 'utf8'), /sk-local-settings|sk-moonshot-settings|sk-or-local-settings|tvly-local-settings|pplx-local-settings|seedream-local-settings/);

  for (const body of [
    { model: 'bad-model' },
    { reasoningEffort: 'extreme' },
    { reasoningMode: 'sometimes' },
    { thinkingMode: 'sometimes' },
    { webSearchEnabled: 'true' },
    { kimiWebSearchEnabled: 'true' },
    { openrouterZdrEnabled: 'true' },
    { webSearchDepth: 'deep' },
    { seedreamModel: 'bad-seedream' },
    { seedreamSize: 'bad-size' },
    { seedreamWatermark: 'true' },
    { skills: { westock: { enabled: 'true' } } },
    { skills: { perplexity: { enabled: 'true' } } },
    { agentMaxRounds: 3 },
    { agentMaxRounds: 12.5 },
    { agentFileReadMaxMb: 0 },
    { agentFileReadMaxMb: 4.5 },
    { memoryRefreshMaxProposals: 0 },
    { memoryRefreshSessionLimit: 2.5 },
  ]) {
    const invalid = await fetch(`${baseUrl}/api/ai/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(invalid.status, 400);
  }
});

test('fetched slash model ids survive the full settings save cycle', async (t) => {
  const { baseUrl } = loadFreshApp(t);
  const models = Array.from({ length: 60 }, (_, index) => ({
    id: `vendor${index}/model-${index}:free`,
    name: `vendor${index}/model-${index}:free`,
  }));
  const provider = {
    id: 'p_or0001',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiFormat: 'openai',
    apiKey: 'sk-or-test',
    supportsMedia: false,
    thinking: '',
    zdr: true,
    models,
  };

  const initial = await fetch(`${baseUrl}/api/ai/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ customProviders: [provider], model: 'custom/p_or0001/vendor0/model-0:free' }),
  });
  const initialData = await initial.json().catch(() => ({}));
  assert.equal(initial.status, 200, JSON.stringify(initialData));
  assert.equal(initialData.model, 'custom/p_or0001/vendor0/model-0:free');
  assert.equal(initialData.customProviders[0].models.length, 60);

  // simulate the frontend save flow: take the public GET response, blank the
  // provider keys (draft style), PUT the whole payload back
  const publicResponse = await fetch(`${baseUrl}/api/ai/settings`);
  const publicSettings = await publicResponse.json();
  const draftProviders = publicSettings.customProviders.map(item => ({ ...item, apiKey: '' }));
  const resave = await fetch(`${baseUrl}/api/ai/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...publicSettings, customProviders: draftProviders }),
  });
  const resaveData = await resave.json().catch(() => ({}));
  assert.equal(resave.status, 200, JSON.stringify(resaveData));
  assert.equal(resaveData.customProviders[0].models.length, 60, 'models survive a re-save');
  assert.equal(resaveData.model, 'custom/p_or0001/vendor0/model-0:free');
  assert.equal(resaveData.customProviders[0].apiKeyConfigured, true, 'blank key keeps the stored secret');

  // quickSaveAgentModel path: PUT {model} alone against already-saved providers
  const quick = await fetch(`${baseUrl}/api/ai/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'custom/p_or0001/vendor7/model-7:free' }),
  });
  const quickData = await quick.json().catch(() => ({}));
  assert.equal(quick.status, 200, JSON.stringify(quickData));
  assert.equal(quickData.model, 'custom/p_or0001/vendor7/model-7:free');
  assert.equal(quickData.customProviders[0].models.length, 60);
});


test('legacy AI chat, editor, image, skills, and conversation routes are gone', async (t) => {
  const { baseUrl } = loadFreshApp(t);
  const paths = [
    ['POST', '/api/ai/chat'],
    ['POST', '/api/ai/editor'],
    ['GET', '/api/ai/conversations'],
    ['PUT', '/api/ai/conversations'],
    ['POST', '/api/ai/media'],
    ['POST', '/api/ai/image/prompt'],
    ['POST', '/api/ai/image/generate'],
    ['GET', '/api/ai/skills'],
    ['POST', '/api/ai/skills/westock/run'],
    ['POST', '/api/ai/skills/perplexity/run'],
    ['POST', '/api/ai/logs/run'],
  ];
  for (const [method, route] of paths) {
    const response = await fetch(`${baseUrl}${route}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify({}),
    });
    assert.equal(response.status, 404, `${method} ${route}`);
  }
  const serverSource = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.match(serverSource, /function createAgentWebSearch\(req\)/);
  assert.doesNotMatch(serverSource, /resolveAiChatOptions\(\{\s*stream:\s*false,\s*webSearchEnabled:\s*true\s*\}\)/);
  assert.match(serverSource, /Web search is disabled/);
  assert.match(serverSource, /function createAgentWestock\(req\)/);
  assert.match(serverSource, /function createAgentImageGenerate\(req\)/);
  assert.match(serverSource, /app\.get\('\/api\/ai\/settings'/);
  assert.match(serverSource, /app\.get\('\/api\/ai\/models'/);
  assert.doesNotMatch(serverSource, /app\.post\('\/api\/ai\/chat'/);
});

test('workbench frontend no longer exposes chat, editor AI, or user profile', () => {
  const indexHtml = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const workbenchSource = fs.readFileSync(path.join(ROOT, 'public', 'js', 'workbench.js'), 'utf8');
  const workbench = new JSDOM(indexHtml).window.document;

  assert.equal(fs.existsSync(path.join(ROOT, 'public', 'js', 'aiChat.js')), false);
  assert.equal(fs.existsSync(path.join(ROOT, 'public', 'legacy.html')), false);
  assert.equal(workbench.querySelector('#aiChatView'), null);
  assert.equal(workbench.querySelector('#editorAiPanel'), null);
  assert.equal(workbench.querySelector('#agentUserProfile'), null);
  assert.doesNotMatch(indexHtml, /legacy\.html/);
  assert.doesNotMatch(workbenchSource, /#agentUserProfile|userProfile: \$/);
  assert.doesNotMatch(indexHtml, /agentStreamToggle/);
});

test('OpenRouter discovers account models and preserves provider-specific reasoning, sources, ZDR, and media', async (t) => {
  const originalFetch = global.fetch;
  let catalogLoads = 0;
  let catalogUnavailable = false;
  const chatCalls = [];
  global.fetch = async (target, options = {}) => {
    const url = String(target);
    if (url === 'https://openrouter.ai/api/v1/models/user') {
      catalogLoads += 1;
      assert.equal(options.headers.Authorization, 'Bearer sk-or-test-key');
      if (catalogUnavailable) throw new Error('temporary catalog failure');
      return new Response(JSON.stringify({
        data: [{
          id: 'anthropic/test-reasoner',
          name: 'Test Reasoner',
          context_length: 128000,
          architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
          supported_parameters: ['reasoning'],
          reasoning: { supported_efforts: ['low', 'high'], default_effort: 'high', default_enabled: true },
          pricing: { prompt: '0.000003', completion: '0.000015', image: '0.002' },
        }, {
          id: 'vendor/no-text-output',
          name: 'Image only',
          context_length: 4096,
          architecture: { input_modalities: ['text'], output_modalities: ['image'] },
          supported_parameters: [],
          pricing: {},
        }, {
          id: 'vendor/tiny-context',
          name: 'Tiny context',
          context_length: 256,
          architecture: { input_modalities: ['text'], output_modalities: ['text'] },
          supported_parameters: [],
          pricing: { prompt: '0', completion: '0' },
        }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url === 'https://openrouter.ai/api/v1/chat/completions') {
      assert.equal(options.headers.Authorization, 'Bearer sk-or-test-key');
      assert.equal(options.headers['X-Title'], 'Work Log');
      chatCalls.push(JSON.parse(options.body));
      return new Response(JSON.stringify({
        choices: [{
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: 'OpenRouter answer',
            reasoning: 'hidden OpenRouter thought',
            reasoning_details: [{ type: 'reasoning.text', text: 'preserved trace' }],
            annotations: [{
              type: 'url_citation',
              url_citation: { url: 'https://example.com/source', title: 'Example source', content: 'A public source' },
            }],
          },
        }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return originalFetch(target, options);
  };
  t.after(() => { global.fetch = originalFetch; });
  const { baseUrl } = loadFreshApp(t, { openrouterApiKey: 'sk-or-test-key' });

  const modelsResponse = await fetch(`${baseUrl}/api/ai/models`);
  assert.equal(modelsResponse.status, 200);
  const catalog = await modelsResponse.json();
  const openrouterModel = catalog.models.find(model => model.id === 'anthropic/test-reasoner');
  assert.equal(catalog.openrouterConfigured, true);
  assert.equal(catalog.openrouterCatalog.source, 'network');
  assert.equal(Number.isNaN(Date.parse(catalog.openrouterCatalog.fetchedAt)), false);
  assert.equal(openrouterModel.source, 'openrouter');
  assert.equal(openrouterModel.provider, 'anthropic');
  assert.equal(openrouterModel.contextLength, 128000);
  assert.deepEqual(openrouterModel.inputModalities, ['text', 'image']);
  assert.deepEqual(openrouterModel.outputModalities, ['text']);
  assert.deepEqual(openrouterModel.reasoning.supportedEfforts, ['low', 'high']);
  assert.equal(openrouterModel.pricing.inputPerMillion, 3);
  assert.equal(openrouterModel.pricing.outputPerMillion, 15);
  assert.equal(catalog.models.some(model => model.id === 'vendor/no-text-output'), false);
  const searchedModels = await (await fetch(`${baseUrl}/api/ai/models?q=test-reasoner`)).json();
  assert.deepEqual(searchedModels.models.map(model => model.id), ['anthropic/test-reasoner']);
  assert.equal(searchedModels.openrouterCatalog.source, 'cache');
  assert.equal(catalogLoads, 1);

  const refreshedModels = await (await fetch(`${baseUrl}/api/ai/models?refresh=1`)).json();
  assert.equal(refreshedModels.openrouterCatalog.source, 'network');
  assert.equal(catalogLoads, 2);

  catalogUnavailable = true;
  const staleResponse = await fetch(`${baseUrl}/api/ai/models?refresh=1`);
  assert.equal(staleResponse.status, 200);
  assert.equal((await staleResponse.json()).openrouterCatalog.source, 'stale');
  assert.equal(catalogLoads, 3);
  catalogUnavailable = false;

  const settingsResponse = await fetch(`${baseUrl}/api/ai/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'anthropic/test-reasoner',
      reasoningMode: 'effort',
      reasoningEffort: 'high',
      openrouterZdrEnabled: true,
    }),
  });
  assert.equal(settingsResponse.status, 200);
  assert.equal((await settingsResponse.json()).model, 'anthropic/test-reasoner');
});

test('AI settings migrate plaintext secrets and fail closed when the encryption key is missing or wrong', (t) => {
  const dataDir = makeTempDataDir(t);
  const keyFile = path.join(dataDir, 'ai-secrets.key');
  const settingsFile = path.join(dataDir, 'ai-settings.json');
  process.env.DATA_DIR = dataDir;
  process.env.AI_SECRETS_KEY_FILE = keyFile;
  fs.writeFileSync(settingsFile, JSON.stringify({
    apiKey: 'sk-plaintext-deepseek',
    moonshotApiKey: 'sk-plaintext-moonshot',
    openrouterApiKey: 'sk-or-plaintext-openrouter',
    tavilyApiKey: 'tvly-plaintext',
    perplexityApiKey: 'pplx-plaintext',
    seedreamApiKey: 'seedream-plaintext',
    model: 'deepseek-v4-flash',
  }), 'utf8');
  clearAppModules();
  t.after(() => {
    delete process.env.DATA_DIR;
    delete process.env.AI_SECRETS_KEY_FILE;
    clearAppModules();
  });

  let freshDb = require(path.join(ROOT, 'database.js'));
  const migrated = freshDb.getAiSettings();
  assert.equal(migrated.apiKey, 'sk-plaintext-deepseek');
  assert.equal(migrated.openrouterApiKey, 'sk-or-plaintext-openrouter');
  const encrypted = fs.readFileSync(settingsFile, 'utf8');
  assert.match(encrypted, /enc:v1:/);
  assert.doesNotMatch(encrypted, /plaintext/);
  const validKey = fs.readFileSync(keyFile);

  clearAppModules();
  fs.rmSync(keyFile);
  freshDb = require(path.join(ROOT, 'database.js'));
  assert.throws(() => freshDb.getAiSettings(), error => error?.code === 'AI_SECRET_KEY_MISSING');

  fs.writeFileSync(keyFile, `v1:${crypto.randomBytes(32).toString('base64')}\n`, { mode: 0o600 });
  clearAppModules();
  freshDb = require(path.join(ROOT, 'database.js'));
  assert.throws(() => freshDb.getAiSettings(), error => error?.code === 'AI_SECRET_DECRYPT_FAILED');

  fs.writeFileSync(keyFile, validKey);
  clearAppModules();
  freshDb = require(path.join(ROOT, 'database.js'));
  assert.equal(freshDb.getAiSettings().moonshotApiKey, 'sk-plaintext-moonshot');
});

test('log and todo APIs reject malformed field types without poisoning persisted data', async (t) => {
  const { baseUrl } = loadFreshApp(t);
  const badLog = await fetch(`${baseUrl}/api/logs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: { nested: true }, content: [], category: OTHER_CATEGORY, hours: 'many' }),
  });
  assert.equal(badLog.status, 400);
  const badTodo = await fetch(`${baseUrl}/api/todos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: ['bad'], done: 'false', due_date: '2026-02-31' }),
  });
  assert.equal(badTodo.status, 400);
  assert.equal((await fetch(`${baseUrl}/api/stats`)).status, 200);
});

test('log pinning persists and is promoted only within category-filtered results', async (t) => {
  const { db, baseUrl, dataDir } = loadFreshApp(t);
  const newest = db.create({ title: 'newest normal', content: 'normal', category: '开发', log_date: '2026-12-01' });
  const firstPinned = db.create({ title: 'first pinned', content: 'pin one', category: '开发', log_date: '2025-01-01' });
  const nestedPinned = db.create({ title: 'nested pinned', content: 'pin two', category: '开发/前端', log_date: '2024-01-01' });
  const diary = db.create({ title: 'private', content: 'secret', category: DIARY_CATEGORY, log_date: '2026-01-01' });

  const setPinned = async (id, pinned) => fetch(`${baseUrl}/api/logs/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pinned }),
  });

  assert.equal((await setPinned(firstPinned.id, 'yes')).status, 400);
  assert.equal((await setPinned('invalid', true)).status, 400);
  assert.equal((await setPinned(999999, true)).status, 404);
  assert.equal((await setPinned(diary.id, true)).status, 403);

  const firstPinResponse = await setPinned(firstPinned.id, true);
  assert.equal(firstPinResponse.status, 200);
  const firstPinBody = await firstPinResponse.json();
  assert.equal(firstPinBody.pinned, true);
  assert.equal(Number.isFinite(Date.parse(firstPinBody.pinned_at)), true);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal((await setPinned(nestedPinned.id, true)).status, 200);

  const parentFiltered = await (await fetch(`${baseUrl}/api/logs?category=${encodeURIComponent('开发')}&page=1&limit=1`)).json();
  assert.equal(parentFiltered.total, 3);
  assert.equal(parentFiltered.totalPages, 3);
  assert.equal(parentFiltered.items[0].id, nestedPinned.id);

  const subcategoryFiltered = await (await fetch(`${baseUrl}/api/logs?category=${encodeURIComponent('开发/前端')}`)).json();
  assert.deepEqual(subcategoryFiltered.items.map(item => item.id), [nestedPinned.id]);

  const unfiltered = await (await fetch(`${baseUrl}/api/logs`)).json();
  assert.equal(unfiltered.items[0].id, newest.id);

  const combinedMonth = await (await fetch(`${baseUrl}/api/logs?category=${encodeURIComponent('开发')}&month=2026-12`)).json();
  assert.deepEqual(combinedMonth.items.map(item => item.id), [newest.id]);
  const combinedSearch = await (await fetch(`${baseUrl}/api/logs?category=${encodeURIComponent('开发')}&search=nested`)).json();
  assert.deepEqual(combinedSearch.items.map(item => item.id), [nestedPinned.id]);

  assert.equal((await fetch(`${baseUrl}/api/logs/reorder`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderedIds: [newest.id, firstPinned.id, nestedPinned.id] }),
  })).status, 200);
  const afterReorder = await (await fetch(`${baseUrl}/api/logs?category=${encodeURIComponent('开发')}`)).json();
  assert.deepEqual(afterReorder.items.slice(0, 2).map(item => item.id), [nestedPinned.id, firstPinned.id]);

  const unpinned = await setPinned(nestedPinned.id, false);
  assert.equal(unpinned.status, 200);
  assert.equal((await unpinned.json()).pinned_at, null);
  const afterUnpin = await (await fetch(`${baseUrl}/api/logs?category=${encodeURIComponent('开发')}`)).json();
  assert.equal(afterUnpin.items[0].id, firstPinned.id);

  const createdPinned = await fetch(`${baseUrl}/api/logs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'created pinned', content: 'body', category: '开发', log_date: '2023-01-01', pinned: true }),
  });
  assert.equal(createdPinned.status, 201);
  assert.equal((await createdPinned.json()).pinned, true);

  const stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'logs.json'), 'utf8'));
  assert.equal(stored.find(item => item.id === firstPinned.id).pinned, true);
  assert.equal(stored.find(item => item.id === nestedPinned.id).pinned, false);
});

test('image upload rejects svg and still accepts allowed extensions', async (t) => {
  const { baseUrl } = loadFreshApp(t);

  const svg = new FormData();
  svg.append('image', new Blob(['<svg></svg>'], { type: 'image/svg+xml' }), 'bad.svg');
  const rejected = await fetch(`${baseUrl}/api/upload`, { method: 'POST', body: svg });
  assert.equal(rejected.status, 400);

  const png = new FormData();
  png.append('image', validPngBlob(), 'ok.png');
  const accepted = await fetch(`${baseUrl}/api/upload`, { method: 'POST', body: png });
  assert.equal(accepted.status, 200);
  const body = await accepted.json();
  assert.match(body.url, /^\/uploads\/.+\.png$/);
  assert.equal((await fetch(`${baseUrl}${body.url}`)).status, 200);
});

test('diary images require unlocked cookie and remain private after reclassification', async (t) => {
  const { baseUrl } = loadFreshApp(t);

  const rejectedPrivate = new FormData();
  rejectedPrivate.append('image', validPngBlob(), 'locked.png');
  rejectedPrivate.append('private', 'true');
  assert.equal((await fetch(`${baseUrl}/api/upload`, {
    method: 'POST',
    body: rejectedPrivate,
  })).status, 403);

  let cookie = await unlockDiary(baseUrl);
  const privateForm = new FormData();
  privateForm.append('image', validPngBlob(), 'private.png');
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
  ordinaryForm.append('image', validPngBlob(), 'ordinary.png');
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
  const { baseUrl, dataDir } = loadFreshApp(t);
  const markdownForm = new FormData();
  markdownForm.append('image', validPngBlob(), 'markdown.png');
  const markdownImage = await (await fetch(`${baseUrl}/api/upload`, {
    method: 'POST',
    body: markdownForm,
  })).json();
  const htmlForm = new FormData();
  htmlForm.append('image', validPngBlob(), 'html.png');
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
  assert.match(db.restore({ ...base, logs: [{ id: 1, pinned: 'yes' }] }).error, /Invalid pinned/);
  assert.match(db.restore({ ...base, logs: [{ id: 1, pinned: true, pinned_at: 'not-a-date' }] }).error, /Invalid pinned_at/);
  assert.match(db.restore({ ...base, todos: [{ id: 1 }, { id: 1 }] }).error, /Duplicate todo id/);
  assert.match(db.restore({ ...base, todos: [{ id: 1, due_date: '2026-02-31' }] }).error, /Invalid due_date/);
  assert.match(db.restore({ ...base, todos: [{ id: 1, priority: 'critical' }] }).error, /Invalid priority/);
  assert.match(db.restore({ ...base, todos: [{ id: 1, notes: { text: 'bad' } }] }).error, /Invalid notes/);
  assert.match(db.restore({ ...base, countdowns: [{ id: 1, title: 'bad', target_date: '2026-02-31' }] }).error, /Invalid target_date/);
  assert.match(db.restore({ ...base, countdowns: [{ id: 1, title: 'bad', target_date: '2026-05-18', repeat_yearly: 'yes' }] }).error, /Invalid repeat_yearly/);
  assert.match(db.restore({ ...base, categories: [{ name: 'Bad', sub: 'not-array' }] }).error, /Invalid subcategories/);
  assert.match(db.restore({ ...base, categories: [{ name: 'Bad', sub: [], calendar_day_visible: 'no' }] }).error, /Invalid calendar day visibility/);
  assert.match(db.restore({ ...base, privateUploads: ['../secret.png'] }).error, /Invalid private upload filename/);

  assert.deepEqual(db.restore({ ...base, privateUploads: ['secret.png'] }).success, true);
  assert.equal(db.backup().format, 'structure');
  assert.equal(db.backup().includesBinaries, false);
  assert.equal(Object.hasOwn(db.backup(), 'aiChats'), false);
  db.stageLegacyAiChatsForMigration({
    aiChats: {
      conversations: [{
        id: 'legacy-restore-1',
        title: '恢复测试',
        scope: 'global',
        updatedAt: Date.now(),
        messages: [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'world' }],
      }],
    },
  });
  assert.equal(fs.existsSync(path.join(db.dataDir, 'ai-chats.json')), true);
  assert.equal(db.backup().logs[0].pinned, false);
  assert.equal(db.backup().logs[0].pinned_at, null);
  assert.equal(db.getAllTodos()[0].notes, '');
  assert.equal(db.getAllTodos()[0].recurrence, 'none');
  assert.deepEqual(db.backup().privateUploads, ['secret.png']);
  db.createCountdown({ title: 'removed by old replace backup', target_date: '2026-08-20' });
  assert.deepEqual(db.restore(base).success, true);
  assert.deepEqual(db.backup().privateUploads, []);
  assert.deepEqual(db.getAllCountdowns(), []);
  assert.equal(db.create({ title: 'next log', category: OTHER_CATEGORY }).id, 2);
  assert.equal(db.createTodo({ title: 'next todo' }).id, 2);

  assert.equal(db.restore({
    ...base,
    countdowns: [{ id: 1, title: 'birthday', target_date: '2020-02-29', repeat_yearly: true, notes: '' }],
  }).success, true);
  assert.equal(db.createCountdown({ title: 'next countdown', target_date: '2026-09-01' }).id, 2);
  assert.equal(db.restore(base, 'merge').success, true);
  assert.deepEqual(db.getAllCountdowns().map(item => item.id), [2, 1]);

  const pinnedBackup = {
    ...base,
    logs: [{ ...base.logs[0], pinned: true, pinned_at: '2026-06-01T12:00:00.000Z', updated_at: '2026-06-01T12:00:00.000Z' }],
  };
  assert.equal(db.restore(pinnedBackup).success, true);
  assert.equal(db.backup().logs[0].pinned, true);
  assert.equal(db.backup().logs[0].pinned_at, '2026-06-01T12:00:00.000Z');
});

test('corrupt JSON data fails closed and is preserved for recovery', (t) => {
  const db = loadFreshDb(t);
  const dataFile = path.join(process.env.DATA_DIR, 'logs.json');
  fs.writeFileSync(dataFile, '{not-json', 'utf8');
  assert.throws(() => db.getAll(), /Failed to read logs\.json/);
  assert.equal(fs.readFileSync(dataFile, 'utf8'), '{not-json');
  assert.equal(fs.readdirSync(process.env.DATA_DIR).some(name => /^logs\.json\.corrupt-.*\.bak$/.test(name)), true);
});

test('countdown API validates and persists independent countdown entries', async (t) => {
  const { baseUrl, dataDir } = loadFreshApp(t);
  assert.deepEqual(await (await fetch(`${baseUrl}/api/countdowns`)).json(), []);

  const created = await fetch(`${baseUrl}/api/countdowns`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: '旅行出发',
      target_date: '2026-08-20',
      repeat_yearly: false,
      notes: '准备行李',
    }),
  });
  assert.equal(created.status, 201);
  const entry = await created.json();
  assert.equal(entry.id, 1);
  assert.equal(entry.title, '旅行出发');
  assert.equal(entry.repeat_yearly, false);
  assert.equal(fs.existsSync(path.join(dataDir, 'countdowns.json')), true);

  const updated = await fetch(`${baseUrl}/api/countdowns/${entry.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: '周年旅行', repeat_yearly: true }),
  });
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).repeat_yearly, true);

  for (const body of [
    { title: '', target_date: '2026-08-20' },
    { title: 'bad date', target_date: '2026-02-31' },
    { title: 'bad repeat', target_date: '2026-08-20', repeat_yearly: 'yes' },
    { title: 'long notes', target_date: '2026-08-20', notes: 'x'.repeat(1001) },
  ]) {
    const invalid = await fetch(`${baseUrl}/api/countdowns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(invalid.status, 400);
  }
  assert.equal((await fetch(`${baseUrl}/api/countdowns/not-an-id`, { method: 'DELETE' })).status, 400);
  assert.equal((await fetch(`${baseUrl}/api/countdowns/${entry.id}`, { method: 'DELETE' })).status, 200);
  assert.deepEqual(await (await fetch(`${baseUrl}/api/countdowns`)).json(), []);
});

test('corrupt countdown storage fails closed and preserves a recovery copy', (t) => {
  const db = loadFreshDb(t);
  const file = path.join(process.env.DATA_DIR, 'countdowns.json');
  fs.writeFileSync(file, '{bad-countdowns', 'utf8');
  assert.throws(() => db.getAllCountdowns(), /Failed to read countdowns\.json/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{bad-countdowns');
  assert.equal(fs.readdirSync(process.env.DATA_DIR).some(name => /^countdowns\.json\.corrupt-.*\.bak$/.test(name)), true);
});

test('todo API stores due date, priority, recurrence, and notes', async (t) => {
  const { baseUrl } = loadFreshApp(t);

  const created = await fetch(`${baseUrl}/api/todos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'task',
      category: '待学习',
      due_date: '2026-05-18',
      priority: 'important',
      recurrence: 'weekly',
      notes: 'bring context',
    }),
  });
  assert.equal(created.status, 201);
  const createdBody = await created.json();
  assert.equal(createdBody.category, '待学习');
  assert.equal(createdBody.due_date, '2026-05-18');
  assert.equal(createdBody.priority, 'important');
  assert.equal(createdBody.recurrence, 'weekly');
  assert.equal(createdBody.notes, 'bring context');

  const updated = await fetch(`${baseUrl}/api/todos/${createdBody.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      priority: 'urgent',
      recurrence: 'monthly',
      category: '待办',
      notes: 'updated note',
    }),
  });
  assert.equal(updated.status, 200);
  const updatedBody = await updated.json();
  assert.equal(updatedBody.category, '待办');
  assert.equal(updatedBody.priority, 'urgent');
  assert.equal(updatedBody.recurrence, 'monthly');
  assert.equal(updatedBody.notes, 'updated note');

  const listed = await fetch(`${baseUrl}/api/todos`);
  assert.equal(listed.status, 200);
  const items = await listed.json();
  assert.equal(items[0].category, '待办');
  assert.equal(items[0].priority, 'urgent');
  assert.equal(items[0].recurrence, 'monthly');
  assert.equal(items[0].notes, 'updated note');
});

test('recurring todos generate the next pending occurrence only once when completed', (t) => {
  const db = loadFreshDb(t);
  const cases = [
    ['daily task', 'daily', '2026-01-31', '2026-02-01'],
    ['weekly task', 'weekly', '2026-01-31', '2026-02-07'],
    ['monthly task', 'monthly', '2026-01-31', '2026-02-28'],
    ['yearly task', 'yearly', '2024-02-29', '2025-02-28'],
  ];

  for (const [title, recurrence, dueDate, nextDueDate] of cases) {
    const created = db.createTodo({ title, due_date: dueDate, recurrence, category: '待办', priority: 'normal', notes: 'keep me' });
    const completed = db.updateTodo(created.id, { done: true });
    assert.equal(completed.done, true);

    const generated = db.getAllTodos().filter(todo => todo.title === title && !todo.done);
    assert.equal(generated.length, 1);
    assert.equal(generated[0].due_date, nextDueDate);
    assert.equal(generated[0].recurrence, recurrence);
    assert.equal(generated[0].priority, 'normal');
    assert.equal(generated[0].notes, 'keep me');

    db.updateTodo(created.id, { done: true });
    assert.equal(db.getAllTodos().filter(todo => todo.title === title && !todo.done).length, 1);
  }

  const invalid = db.createTodo({ title: 'invalid recurrence', due_date: '2026-05-18', recurrence: 'hourly' });
  assert.equal(db.getAllTodos().find(todo => todo.id === invalid.id).recurrence, 'none');

  const undated = db.createTodo({ title: 'undated recurrence', recurrence: 'daily' });
  db.updateTodo(undated.id, { done: true });
  assert.equal(db.getAllTodos().filter(todo => todo.title === 'undated recurrence').length, 1);
});

test('todo categories can be added and deleted while preserving tasks under default', async (t) => {
  const { baseUrl } = loadFreshApp(t);

  const categories = await fetch(`${baseUrl}/api/todo-categories`);
  assert.equal(categories.status, 200);
  assert.deepEqual(await categories.json(), ['待办']);

  const createdCategory = await fetch(`${baseUrl}/api/todo-categories`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '待学习' }),
  });
  assert.equal(createdCategory.status, 201);
  assert.deepEqual((await createdCategory.json()).categories, ['待办', '待学习']);

  const createdTodo = await fetch(`${baseUrl}/api/todos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'learn typescript', category: '待学习' }),
  });
  assert.equal(createdTodo.status, 201);
  assert.equal((await createdTodo.json()).category, '待学习');

  const deletedCategory = await fetch(`${baseUrl}/api/todo-categories/${encodeURIComponent('待学习')}`, {
    method: 'DELETE',
  });
  assert.equal(deletedCategory.status, 200);
  assert.deepEqual((await deletedCategory.json()).categories, ['待办']);
  assert.equal((await (await fetch(`${baseUrl}/api/todos`)).json())[0].category, '待办');

  const protectedDefault = await fetch(`${baseUrl}/api/todo-categories/${encodeURIComponent('待办')}`, {
    method: 'DELETE',
  });
  assert.equal(protectedDefault.status, 409);
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

test('todo reminder settings and state persist with validation', (t) => {
  const db = loadFreshDb(t);

  assert.deepEqual(db.getTodoReminderSettings(), {
    enabled: false,
    recipientEmail: '',
    sendTime: '08:00',
  });
  assert.deepEqual(db.getTodoReminderState(), {
    businessDate: '',
    capturedAt: '',
    status: 'idle',
    snapshot: [],
    sentAt: '',
    lastError: '',
  });

  assert.match(db.saveTodoReminderSettings({
    enabled: false,
    recipientEmail: 'bad-email',
    sendTime: '08:00',
  }).error, /recipientEmail/);
  assert.match(db.saveTodoReminderSettings({
    enabled: false,
    recipientEmail: '',
    sendTime: '8:00',
  }).error, /sendTime/);
  assert.match(db.saveTodoReminderSettings({
    enabled: true,
    recipientEmail: 'notify@example.com',
    sendTime: '08:00',
  }, { mailReady: false }).error, /QQ mail credentials/);

  const savedSettings = db.saveTodoReminderSettings({
    enabled: true,
    recipientEmail: 'notify@example.com',
    sendTime: '09:15',
  }, { mailReady: true });
  assert.deepEqual(savedSettings, {
    enabled: true,
    recipientEmail: 'notify@example.com',
    sendTime: '09:15',
  });

  const savedState = db.saveTodoReminderState({
    businessDate: '2026-05-18',
    capturedAt: '2026-05-18T00:00:00.000Z',
    status: 'pending',
    snapshot: [{ id: 1, title: 'task', category: '待办', priority: 'urgent', due_date: '2026-05-18', notes: 'note', sort_order: 3 }],
    sentAt: '',
    lastError: 'SMTP failed',
  });
  assert.equal(savedState.status, 'pending');
  assert.equal(savedState.snapshot.length, 1);
  assert.equal(savedState.snapshot[0].priority, 'urgent');

  clearAppModules();
  const reloaded = require(path.join(ROOT, 'database.js'));
  assert.deepEqual(reloaded.getTodoReminderSettings(), savedSettings);
  assert.equal(reloaded.getTodoReminderState().businessDate, '2026-05-18');
  assert.equal(reloaded.getTodoReminderState().lastError, 'SMTP failed');
});

test('todo reminder settings API validates mail readiness and persists across restart', async (t) => {
  const first = loadFreshApp(t, {
    qqEmailAccount: 'sender@qq.com',
    qqEmailAuthCode: 'auth-code',
  });

  const initial = await fetch(`${first.baseUrl}/api/todo-reminder-settings`);
  assert.equal(initial.status, 200);
  const initialBody = await initial.json();
  assert.equal(initialBody.mailReady, true);
  assert.equal(initialBody.recipientEmail, 'sender@qq.com');
  assert.equal(initialBody.sendTime, '08:00');
  assert.equal(initialBody.lastStatus, 'idle');

  const saved = await fetch(`${first.baseUrl}/api/todo-reminder-settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      enabled: true,
      recipientEmail: 'notify@example.com',
      sendTime: '09:30',
    }),
  });
  assert.equal(saved.status, 200);
  const savedBody = await saved.json();
  assert.equal(savedBody.enabled, true);
  assert.equal(savedBody.recipientEmail, 'notify@example.com');
  assert.equal(savedBody.sendTime, '09:30');

  await new Promise(resolve => first.server.close(resolve));
  clearAppModules();
  const { app: reloadedApp } = require(path.join(ROOT, 'server.js'));
  const reloadedServer = reloadedApp.listen(0);
  const reloadedBaseUrl = `http://127.0.0.1:${reloadedServer.address().port}`;
  t.after(() => new Promise(resolve => reloadedServer.close(resolve)));

  const afterRestart = await fetch(`${reloadedBaseUrl}/api/todo-reminder-settings`);
  assert.equal(afterRestart.status, 200);
  const afterRestartBody = await afterRestart.json();
  assert.equal(afterRestartBody.enabled, true);
  assert.equal(afterRestartBody.recipientEmail, 'notify@example.com');
  assert.equal(afterRestartBody.sendTime, '09:30');

  process.env.QQ_EMAIL_ACCOUNT = '';
  process.env.QQ_EMAIL_AUTH_CODE = '';
  clearAppModules();
  const { app: noMailApp } = require(path.join(ROOT, 'server.js'));
  const noMailServer = noMailApp.listen(0);
  const noMailBaseUrl = `http://127.0.0.1:${noMailServer.address().port}`;
  t.after(() => new Promise(resolve => noMailServer.close(resolve)));

  const rejected = await fetch(`${noMailBaseUrl}/api/todo-reminder-settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      enabled: true,
      recipientEmail: 'notify@example.com',
      sendTime: '08:00',
    }),
  });
  assert.equal(rejected.status, 400);
  assert.match((await rejected.json()).error, /QQ mail credentials/);
});

test('todo reminder mail builder includes category titles due dates and notes in utf-8 text', (t) => {
  process.env.QQ_EMAIL_ACCOUNT = 'sender@qq.com';
  process.env.QQ_EMAIL_AUTH_CODE = 'auth-code';
  clearAppModules();
  t.after(() => {
    delete process.env.QQ_EMAIL_ACCOUNT;
    delete process.env.QQ_EMAIL_AUTH_CODE;
    clearAppModules();
  });

  const {
    buildTodoReminderMail,
    createTodoReminderEmailMessage,
  } = require(path.join(ROOT, 'server.js'));

  const snapshot = [
    {
      id: 1,
      title: '提交周报',
      category: '开发',
      priority: 'urgent',
      due_date: '2026-05-18',
      notes: '带上会议纪要',
      sort_order: 1,
    },
    {
      id: 2,
      title: '空备注任务',
      category: '测试',
      priority: 'normal',
      due_date: '2026-05-18',
      notes: '',
      sort_order: 2,
    },
  ];

  const mail = buildTodoReminderMail({
    businessDate: '2026-05-18',
    snapshot,
  });
  assert.equal(mail.subject, '待办到期提醒 (2026-05-18)');
  assert.match(mail.text, /日期: 2026-05-18/);
  assert.match(mail.text, /待办数: 2/);
  assert.match(mail.text, /1\. \[开发\] 提交周报/);
  assert.match(mail.text, /截止日期: 2026-05-18/);
  assert.match(mail.text, /备注: 带上会议纪要/);
  assert.match(mail.text, /2\. \[测试\] 空备注任务/);
  assert.equal((mail.text.match(/备注:/g) || []).length, 1);
  assert.doesNotMatch(mail.text, /优先级|紧急|重要|普通/);

  const message = createTodoReminderEmailMessage({
    to: 'notify@example.com',
    businessDate: '2026-05-18',
    snapshot,
  });
  assert.equal(message.from, 'sender@qq.com');
  assert.equal(message.to, 'notify@example.com');
  assert.equal(message.subject, mail.subject);
  assert.equal(message.text, mail.text);
  assert.equal(message.textEncoding, 'base64');
  assert.equal(message.html, undefined);
});

test('todo reminder service sends once per day and records empty days after the configured time', async (t) => {
  const db = loadFreshDb(t);
  const { createTodoReminderService } = require(path.join(ROOT, 'server.js'));
  let current = new Date('2026-05-17T23:30:00.000Z');
  const sent = [];

  db.saveTodoReminderSettings({
    enabled: true,
    recipientEmail: 'notify@example.com',
    sendTime: '08:00',
  }, { mailReady: true });
  db.createTodo({
    title: 'Submit report',
    due_date: '2026-05-18',
    priority: 'important',
    category: '待办',
    notes: 'Bring context',
  });
  db.createTodo({
    title: 'Review vocabulary',
    due_date: '2026-05-18',
    priority: 'normal',
    category: '学习',
    notes: 'custom category should be included',
  });
  db.createTodo({
    title: 'Already done',
    due_date: '2026-05-18',
    priority: 'urgent',
    category: '了解',
  });
  db.updateTodo(3, { done: true });
  db.createTodo({
    title: 'Tomorrow task',
    due_date: '2026-05-20',
    priority: 'urgent',
    category: '了解',
  });

  const service = createTodoReminderService({
    db,
    mailReady: () => true,
    sendMail: async (mail) => { sent.push(mail); },
    now: () => current,
    intervalMs: 100000,
  });

  await service.tick();
  assert.equal(sent.length, 0);

  current = new Date('2026-05-18T00:01:00.000Z');
  await service.tick();
  assert.equal(sent.length, 1);
  assert.match(sent[0].subject, /待办到期提醒 \(2026-05-18\)/);
  assert.match(sent[0].text, /\[待办\] Submit report/);
  assert.match(sent[0].text, /\[学习\] Review vocabulary/);
  assert.doesNotMatch(sent[0].text, /Already done|Tomorrow task/);
  assert.match(sent[0].text, /截止日期: 2026-05-18/);
  assert.match(sent[0].text, /Bring context/);
  assert.match(sent[0].text, /custom category should be included/);
  assert.equal(sent[0].textEncoding, 'base64');
  assert.equal(sent[0].html, undefined);
  assert.doesNotMatch(sent[0].text, /优先级/);
  assert.equal(db.getTodoReminderState().status, 'sent');
  assert.deepEqual(db.getTodoReminderState().snapshot.map(todo => todo.category), ['待办', '学习']);

  await service.tick();
  assert.equal(sent.length, 1);

  current = new Date('2026-05-19T00:01:00.000Z');
  await service.tick();
  const state = db.getTodoReminderState();
  assert.equal(state.businessDate, '2026-05-19');
  assert.equal(state.status, 'empty');
  assert.equal(sent.length, 1);
});

test('todo reminder service retries the same snapshot after failure and ignores later same-day todos', async (t) => {
  const db = loadFreshDb(t);
  const { createTodoReminderService } = require(path.join(ROOT, 'server.js'));
  let current = new Date('2026-05-18T00:02:00.000Z');
  let attempts = 0;
  const delivered = [];

  db.saveTodoReminderSettings({
    enabled: true,
    recipientEmail: 'notify@example.com',
    sendTime: '08:00',
  }, { mailReady: true });
  db.createTodo({
    title: 'First task',
    due_date: '2026-05-18',
    priority: 'important',
    category: '待办',
    notes: 'original snapshot',
  });

  const service = createTodoReminderService({
    db,
    mailReady: () => true,
    now: () => current,
    sendMail: async (mail) => {
      attempts++;
      if (attempts === 1) throw new Error('SMTP down');
      delivered.push(mail);
    },
    intervalMs: 100000,
  });

  await service.tick();
  assert.equal(attempts, 1);
  assert.equal(db.getTodoReminderState().status, 'pending');
  assert.equal(db.getTodoReminderState().snapshot.length, 1);
  assert.match(db.getTodoReminderState().lastError, /SMTP down/);

  db.createTodo({
    title: 'Second task',
    due_date: '2026-05-18',
    priority: 'urgent',
    category: '待办',
    notes: 'should not enter the old snapshot',
  });

  current = new Date('2026-05-18T01:05:00.000Z');
  await service.tick();
  assert.equal(attempts, 2);
  assert.equal(delivered.length, 1);
  assert.match(delivered[0].text, /First task/);
  assert.doesNotMatch(delivered[0].text, /Second task/);
  assert.equal(delivered[0].textEncoding, 'base64');
  assert.doesNotMatch(delivered[0].text, /优先级/);
  assert.equal(db.getTodoReminderState().status, 'sent');

  await service.tick();
  assert.equal(attempts, 2);
});

test('todo reminder dry-run script reuses the reminder text format', (t) => {
  const db = loadFreshDb(t);
  db.createTodo({
    title: '中文待办',
    due_date: '2026-05-18',
    priority: 'urgent',
    category: '开发',
    notes: '中文备注',
  });

  const output = childProcess.execFileSync(process.execPath, [
    path.join(ROOT, 'scripts', 'send-todo-reminder-mail.js'),
    '--dry-run',
    '--to',
    'notify@example.com',
    '--date',
    '2026-05-18',
  ], {
    cwd: ROOT,
    env: {
      ...process.env,
      DATA_DIR: process.env.DATA_DIR,
      DOTENV_CONFIG_QUIET: 'true',
      QQ_EMAIL_ACCOUNT: 'sender@qq.com',
      QQ_EMAIL_AUTH_CODE: 'auth-code',
    },
    encoding: 'utf8',
  });
  const preview = JSON.parse(output.slice(output.indexOf('{')));

  assert.equal(preview.to, 'notify@example.com');
  assert.equal(preview.subject, '待办到期提醒 (2026-05-18)');
  assert.equal(preview.textEncoding, 'base64');
  assert.match(preview.text, /\[开发\] 中文待办/);
  assert.match(preview.text, /截止日期: 2026-05-18/);
  assert.match(preview.text, /备注: 中文备注/);
  assert.doesNotMatch(preview.text, /优先级/);
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

test('countdown timing handles future, elapsed, annual, cross-year, and leap-day dates', async () => {
  const moduleUrl = `${pathToFileURL(path.join(ROOT, 'public', 'js', 'countdownDate.js')).href}?test=${Date.now()}`;
  const { countdownTiming } = await import(moduleUrl);

  assert.deepEqual(countdownTiming({ target_date: '2026-06-01', repeat_yearly: false }, '2026-05-30'), {
    effectiveDate: '2026-06-01', days: 2, state: 'future',
  });
  assert.equal(countdownTiming({ target_date: '2026-05-30', repeat_yearly: false }, '2026-05-30').state, 'today');
  assert.deepEqual(countdownTiming({ target_date: '2026-05-20', repeat_yearly: false }, '2026-05-30'), {
    effectiveDate: '2026-05-20', days: -10, state: 'elapsed',
  });
  assert.equal(countdownTiming({ target_date: '2026-01-01', repeat_yearly: false }, '2025-12-31').days, 1);

  const annual = countdownTiming({ target_date: '2020-05-01', repeat_yearly: true }, '2026-05-02');
  assert.equal(annual.effectiveDate, '2027-05-01');
  assert.equal(annual.state, 'future');
  const leapDay = countdownTiming({ target_date: '2020-02-29', repeat_yearly: true }, '2025-02-27');
  assert.deepEqual(leapDay, { effectiveDate: '2025-02-28', days: 1, state: 'future' });
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

test('all frontend scripts pass parser checks before browser loading', () => {
  const scriptsDir = path.join(ROOT, 'public', 'js');
  const scriptFiles = fs.readdirSync(scriptsDir)
    .filter(file => file.endsWith('.js'))
    .sort();

  for (const file of scriptFiles) {
    const result = childProcess.spawnSync(process.execPath, ['--check', path.join(scriptsDir, file)], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, `${file} failed to parse:\n${result.stderr || result.stdout}`);
  }
});

test('legacy log UI files are gone and vendor build no longer bundles CodeMirror', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const buildSource = fs.readFileSync(path.join(ROOT, 'scripts', 'build-editor.mjs'), 'utf8');
  const leftover = [
    'public/legacy.html',
    'public/style.css',
    'public/js/app.js',
    'public/js/logList.js',
    'public/js/calendar.js',
    'public/js/photoWall.js',
    'public/js/editor.js',
    'public/js/categories.js',
    'public/js/stats.js',
    'public/js/contentEditor.js',
    'public/js/shortcuts.js',
    'public/js/constants.js',
    'public/js/templateDate.js',
    'public/js/state.js',
    'public/js/aiChat.js',
    'public/js/knowledge/import.js',
    'src/codemirror/editor-entry.js',
  ];
  for (const relative of leftover) {
    assert.equal(fs.existsSync(path.join(ROOT, relative)), false, relative);
  }
  assert.equal(packageJson.dependencies.codemirror, undefined);
  assert.equal(packageJson.dependencies.esbuild, undefined);
  assert.equal(packageJson.dependencies['monaco-editor'], undefined);
  assert.match(buildSource, /vendorDir/);
  assert.doesNotMatch(buildSource, /codemirror|esbuild/);
});

test('login and workbench account settings keep cookie auth and admin user management', () => {
  const indexSource = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const loginSource = fs.readFileSync(path.join(ROOT, 'public', 'login.html'), 'utf8');
  const loginScript = fs.readFileSync(path.join(ROOT, 'public', 'js', 'login.js'), 'utf8');
  const accountsSource = fs.readFileSync(path.join(ROOT, 'public', 'js', 'accounts.js'), 'utf8');
  const workbenchSource = fs.readFileSync(path.join(ROOT, 'public', 'js', 'workbench.js'), 'utf8');
  const authSource = fs.readFileSync(path.join(ROOT, 'public', 'js', 'auth.js'), 'utf8');
  const loginStyle = fs.readFileSync(path.join(ROOT, 'public', 'login.css'), 'utf8');

  assert.match(loginSource, /id="loginForm"[\s\S]*autocomplete="username"[\s\S]*autocomplete="current-password"/);
  assert.match(loginSource, /id="passwordChangeForm"[\s\S]*minlength="10"[\s\S]*id="loginError" role="alert"/);
  assert.doesNotMatch(indexSource, /loginOverlay|login-overlay|legacy\.html/);
  assert.match(indexSource, /data-settings-nav="account"/);
  assert.match(indexSource, /id="accountDisplayNameInput"[\s\S]*id="btnSaveAccountProfile"/);
  assert.match(indexSource, /id="btnChangeAccountPassword"/);
  assert.match(indexSource, /id="userManagerDialog"[\s\S]*管理员只能管理账户资料，不能查看成员工作区/);
  assert.match(indexSource, /id="btnAdminUsers"/);
  assert.doesNotMatch(indexSource, /btnSaveDiaryPassword|diaryPasswordSettingsTitle|newDiaryPassword|disableDiaryPassword/);

  assert.match(loginScript, /target\.origin !== window\.location\.origin/);
  assert.match(loginScript, /window\.location\.replace\(safeNextPath\(\)\)/);
  assert.match(accountsSource, /api\/admin\/users/);
  assert.match(accountsSource, /userManagerDialog[\s\S]*showModal/);
  assert.match(workbenchSource, /from '\.\/accounts\.js'/);
  assert.match(workbenchSource, /initAccounts\(\)/);
  assert.match(workbenchSource, /openSettings\('account'\)/);
  assert.match(authSource, /window\.location\.assign\(`\/login\?\$\{params\.toString\(\)\}`\);/);
  assert.doesNotMatch(`${authSource}\n${workbenchSource}\n${accountsSource}`, /sessionStorage|getAuthToken|site_token|Authorization[^\n]*Bearer/);
  assert.match(loginStyle, /\[data-theme="dark"\]/);
  assert.match(loginStyle, /@media \(max-width: 520px\)/);
});

test('todo UI uses drag sorting, new priorities, and hides notes previews', () => {
  const todoSource = fs.readFileSync(path.join(ROOT, 'public', 'js', 'todos.js'), 'utf8');
  const helpersSource = fs.readFileSync(path.join(ROOT, 'public', 'js', 'helpers.js'), 'utf8');
  const styleSource = fs.readFileSync(path.join(ROOT, 'public', 'css', 'workbench.css'), 'utf8');
  const htmlSource = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const priorityStyleBlock = styleSource.match(/\.todo-priority\s*\{[\s\S]*?\n\}/)?.[0] || '';

  assert.match(htmlSource, /<option value="none">无<\/option>[\s\S]*<option value="normal">普通<\/option>[\s\S]*<option value="important">重要<\/option>[\s\S]*<option value="urgent">紧急<\/option>/);
  assert.match(htmlSource, /id="todoFullRecurrence"[\s\S]*<option value="none">不重复<\/option>[\s\S]*<option value="daily">每日<\/option>[\s\S]*<option value="weekly">每周<\/option>[\s\S]*<option value="monthly">每月<\/option>[\s\S]*<option value="yearly">每年<\/option>/);
  assert.match(htmlSource, /id="todoFullCategory"/);
  assert.match(htmlSource, /data-todo-select-control data-select-id="todoFullCategory"[\s\S]*id="todoFullCategoryMenu" role="listbox"/);
  assert.match(htmlSource, /data-todo-select-control data-select-id="todoFullPriority"[\s\S]*id="todoFullPriorityMenu" role="listbox"/);
  assert.match(htmlSource, /data-todo-select-control data-select-id="todoFullRecurrence"[\s\S]*id="todoFullRecurrenceMenu" role="listbox"/);
  assert.match(htmlSource, /id="btnTodoCategoryOpen"[\s\S]*<svg viewBox="0 0 24 24" aria-hidden="true">/);
  assert.match(htmlSource, /<dialog class="workspace-dialog" id="todoCategoryOverlay"/);
  assert.match(htmlSource, /id="todoCategoryOverlay"[\s\S]*id="todoCategoryAddForm"[\s\S]*id="todoCategoryInput"[\s\S]*id="btnTodoCategoryAdd"/);
  assert.match(htmlSource, /id="btnTodoCategoryCancel"/);
  assert.match(htmlSource, /dialog-eyebrow">待办/);
  assert.match(helpersSource, /getElementById\('confirmDialog'\)/);
  assert.match(helpersSource, /function confirmWorkspaceDialog/);
  assert.doesNotMatch(htmlSource, /todo-full-summary|id="btnTodoFullClear"/);
  assert.doesNotMatch(htmlSource, /data-filter="pending"|data-filter="undated"|>无日期<\/button>/);
  assert.doesNotMatch(htmlSource, /data-filter="all"|class="todo-panel"|id="todoInput"|id="todoList"|id="btnTodoClear"/);
  assert.doesNotMatch(todoSource, /data-action="move-up"/);
  assert.doesNotMatch(todoSource, /data-action="move-down"/);
  assert.doesNotMatch(todoSource, /moveTodo/);
  assert.doesNotMatch(todoSource, /#todoList|todoInput|btnTodoClear|renderCompactTodos|pending\.slice\(0, 6\)/);
  assert.doesNotMatch(todoSource, /todo-notes-preview/);
  assert.doesNotMatch(styleSource, /todo-notes-preview/);
  assert.match(todoSource, /priority: todo\.priority \|\| 'none'/);
  assert.match(todoSource, /recurrence: todo\.recurrence \|\| 'none'/);
  assert.match(todoSource, /const DEFAULT_TODO_CATEGORY = '待办';/);
  assert.match(todoSource, /const TODO_RECURRENCE_LABELS = \{[\s\S]*daily: '每日'[\s\S]*weekly: '每周'[\s\S]*monthly: '每月'[\s\S]*yearly: '每年'/);
  assert.match(todoSource, /category: todo\.category \|\| DEFAULT_TODO_CATEGORY/);
  assert.match(todoSource, /apiFetch\('\/api\/todo-categories'\)/);
  assert.match(todoSource, /function renderTodoFilterTabs\(\)/);
  assert.match(todoSource, /data-filter="\$\{escHtml\(category\)\}"/);
  assert.match(todoSource, /data-filter="done"[\s\S]*已完成/);
  assert.match(todoSource, /data-action="delete-category"/);
  assert.match(todoSource, /class="todo-category-remove"[\s\S]*role="button"[\s\S]*<svg viewBox="0 0 24 24"/);
  assert.doesNotMatch(todoSource, /title="删除分类">×/);
  assert.match(todoSource, /function addTodoCategoryFromForm\(event\)/);
  assert.match(todoSource, /function deleteTodoCategory\(name\)/);
  assert.match(todoSource, /function openTodoCategoryModal\(\)/);
  assert.match(todoSource, /dialog\.showModal\(\)/);
  assert.match(todoSource, /\$\('#btnTodoCategoryOpen'\)\.addEventListener\('click', openTodoCategoryModal\);/);
  assert.match(todoSource, /\$\('#btnTodoCategoryClose'\)\.addEventListener\('click', closeTodoCategoryModal\);/);
  assert.doesNotMatch(todoSource, /#todoCategoryClose/);
  assert.doesNotMatch(todoSource, /openModal\(\$\('#todoCategoryOverlay'/);
  assert.match(todoSource, /\$\('#todoCategoryOverlay'\)\.addEventListener\('cancel'/);
  assert.match(todoSource, /function priorityBadge\(todo\)/);
  assert.match(todoSource, /function recurrenceBadge\(todo\)/);
  assert.match(todoSource, /title="重复：\$\{label\}"/);
  assert.match(todoSource, /const labels = \{ normal: 'P2 普通', important: 'P1 重要', urgent: 'P0 紧急' \};/);
  assert.match(todoSource, /const codes = \{ normal: 'P2', important: 'P1', urgent: 'P0' \};/);
  assert.match(todoSource, /if \(activeFilter === 'all' \|\| activeFilter === 'undated' \|\| activeFilter === 'pending'\) activeFilter = DEFAULT_TODO_CATEGORY;/);
  assert.match(todoSource, /function sortTodosForView\(todos, mode\)/);
  assert.match(todoSource, /else items = items\.filter\(t => !t\.done && \(t\.category \|\| DEFAULT_TODO_CATEGORY\) === activeFilter\);/);
  assert.doesNotMatch(todoSource, /没有无截止日期的待办/);
  assert.doesNotMatch(todoSource, /items = items\.filter\(t => !t\.done && t\.due_date\)/);
  assert.doesNotMatch(todoSource, /items = items\.filter\(t => !t\.done && !t\.due_date\)/);
  assert.match(todoSource, /export function showTodoView\(\)/);
  assert.match(todoSource, /export function initTodos\(\)/);
  assert.match(todoSource, /export function getTodoSubtitle\(\)/);
  assert.doesNotMatch(todoSource, /\$\('#listView'\)\.style\.display/);
  assert.doesNotMatch(todoSource, /from '\.\/calendar\.js'/);
  assert.match(todoSource, /let todoSearchQuery = '';/);
  assert.match(todoSource, /\$\('#todoSearchInput'\)\.addEventListener\('input'/);
  assert.match(todoSource, /const TODO_SELECT_IDS = \['todoFullCategory', 'todoFullPriority', 'todoFullRecurrence'\];/);
  assert.match(todoSource, /from '\.\/selectControl\.js'/);
  assert.match(todoSource, /function syncTodoSelectControls\(\)/);
  const selectControlSource = fs.readFileSync(path.join(ROOT, 'public', 'js', 'selectControl.js'), 'utf8');
  assert.match(selectControlSource, /select\.dispatchEvent\(new Event\('change', \{ bubbles: true \}\)\);/);
  assert.match(selectControlSource, /todo-select-option/);
  assert.match(todoSource, /data-action="clear-completed"/);
  assert.match(todoSource, /message: '清除所有已完成待办，此操作不可撤销。'/);
  assert.doesNotMatch(todoSource, /todoFullSummary|btnTodoFullClear/);
  assert.match(todoSource, /String\(t\.notes \|\| ''\)\.toLowerCase\(\)\.includes\(query\)/);
  assert.match(todoSource, /重复待办需要先填写截止日期/);
  assert.match(todoSource, /recurrence,\s*[\r\n]\s*notes: \$\('#todoFullNotes'\)\.value/);
  assert.match(todoSource, /\[pending\.length, dueToday\.length, overdue\.length, done\.length\]/);
  assert.doesNotMatch(todoSource, /priorityDot/);
  assert.match(priorityStyleBlock, /min-width:\s*22px;/);
  assert.match(priorityStyleBlock, /border-radius:\s*5px;/);
  assert.doesNotMatch(priorityStyleBlock, /border-radius:\s*50%;/);
  assert.match(htmlSource, /class="todo-toolbar"/);
  assert.match(htmlSource, /id="btnTodoNew"/);
  assert.match(htmlSource, /id="todoFormEmpty"/);
  assert.doesNotMatch(htmlSource, /todo-stat-card|<h2>待办事项<\/h2>/);
  assert.match(todoSource, /todo-item-body/);
  assert.match(todoSource, /function startNewTodo\(\)/);
  assert.match(styleSource, /\.todo-priority\.prio-normal\s*\{[\s\S]*background: var\(--accent\);/);
  assert.match(styleSource, /\.todo-priority\.prio-important\s*\{[\s\S]*background: var\(--warning\);/);
  assert.match(styleSource, /\.todo-priority\.prio-urgent\s*\{\s*background: var\(--danger\); \}/);
  assert.match(styleSource, /\.todo-recurrence\s*\{[\s\S]*border:\s*1px solid var\(--line\);/);
  assert.match(styleSource, /\.todo-toolbar\s*\{[\s\S]*align-items:\s*center;/);
  assert.match(styleSource, /\.todo-page-stats\s*\{[\s\S]*flex-wrap:\s*wrap;/);
  assert.match(styleSource, /\.todo-page-layout\s*\{[\s\S]*grid-template-columns:\s*minmax\(0, 1fr\) 340px;/);
  assert.match(styleSource, /\.todo-search-box\s*\{[\s\S]*margin-top:\s*0;/);
  assert.match(styleSource, /\.todo-filter-tabs\s*\{[\s\S]*flex-direction:\s*column;/);
  assert.match(styleSource, /\.dialog-card\.compact-dialog\s*\{[\s\S]*max-width:\s*430px;/);
  assert.match(styleSource, /\.todo-category-remove\s*\{[\s\S]*border-radius:\s*7px;/);
  assert.match(styleSource, /\.todo-category-remove svg\s*\{[\s\S]*stroke-width:\s*1\.9;/);
  assert.match(styleSource, /\.todo-category-badge\s*\{[\s\S]*background:\s*var\(--accent-soft\);/);
  assert.match(styleSource, /\.todo-select-control\[data-select-id="todoFullCategory"\]\s*\{[\s\S]*grid-column:\s*1 \/ -1;/);
  assert.match(styleSource, /\.todo-native-select\s*\{[\s\S]*opacity:\s*0;[\s\S]*pointer-events:\s*none;/);
  assert.match(styleSource, /\.todo-select-trigger:hover\s*\{[\s\S]*border-color:\s*var\(--line-strong\);/);
  assert.match(styleSource, /\.todo-select-control\.has-value \.todo-select-trigger\s*\{[\s\S]*linear-gradient\(90deg, var\(--accent\) 0 3px, transparent 3px\),[\s\S]*var\(--panel\);/);
  assert.doesNotMatch(styleSource, /\.todo-select-control\.has-value \.todo-select-trigger\s*\{[^}]*linear-gradient\(135deg/);
  assert.match(styleSource, /\.todo-select-option:hover,\s*\.todo-select-option:focus-visible\s*\{[\s\S]*background:\s*var\(--accent-soft\);/);
  assert.match(styleSource, /\.todo-section-clear\s*\{[\s\S]*width:\s*auto;[\s\S]*min-height:\s*24px;/);
  assert.match(styleSource, /@media \(max-width: 768px\)[\s\S]*\.todo-page-layout\s*\{[\s\S]*grid-template-columns:\s*1fr;/);
  assert.match(styleSource, /\.todo-full-form textarea[\s\S]*min-height:\s*200px;/);
  assert.doesNotMatch(styleSource, /todo-stat-card|--todo-form-column|--todo-category-button-size/);
});

test('countdown UI provides a persistent independent card mode', () => {
  const todoSource = fs.readFileSync(path.join(ROOT, 'public', 'js', 'todos.js'), 'utf8');
  const styleSource = fs.readFileSync(path.join(ROOT, 'public', 'css', 'workbench.css'), 'utf8');
  const htmlSource = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

  assert.match(htmlSource, /id="todoModeTabs"[\s\S]*data-todo-page="todos"[\s\S]*data-todo-page="countdowns"/);
  assert.match(htmlSource, /id="countdownPanel"[\s\S]*id="countdownGrid"/);
  assert.match(htmlSource, /id="countdownForm"[\s\S]*id="countdownTitle"[\s\S]*id="countdownTargetDate"[\s\S]*id="countdownRepeatYearly"[\s\S]*id="countdownNotes"/);
  assert.match(todoSource, /localStorage\.getItem\('todoPageMode'\)/);
  assert.match(todoSource, /localStorage\.setItem\('todoPageMode', todoPageMode\)/);
  assert.match(todoSource, /apiFetch\('\/api\/countdowns'\)/);
  assert.match(todoSource, /function renderCountdowns\(\)/);
  assert.match(todoSource, /function saveCountdownFromForm\(\)/);
  assert.match(todoSource, /function deleteCountdown\(id\)/);
  assert.match(todoSource, /\['总数', '今天', '30天内', '已过期'\]/);
  assert.match(todoSource, /item\.title\.toLowerCase\(\)\.includes\(query\)[\s\S]*item\.notes\.toLowerCase\(\)\.includes\(query\)/);
  assert.doesNotMatch(todoSource, /state\.datesWithTodos[^;]*allCountdowns/);
  assert.match(todoSource, /countdown-item-body/);
  assert.match(htmlSource, /id="countdownFormEmpty"/);
  assert.match(styleSource, /\.countdown-grid\s*\{[\s\S]*flex-direction:\s*column;/);
  assert.match(styleSource, /\.countdown-item\s*\{/);
});

test('todo reminder UI loads, saves, and displays reminder status in the todo page', () => {
  const todoSource = fs.readFileSync(path.join(ROOT, 'public', 'js', 'todos.js'), 'utf8');
  const styleSource = fs.readFileSync(path.join(ROOT, 'public', 'css', 'workbench.css'), 'utf8');
  const htmlSource = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

  assert.match(htmlSource, /id="todoReminderHeading">邮件提醒/);
  assert.match(htmlSource, /所有分类中当天到期的未完成待办/);
  assert.match(htmlSource, /id="todoReminderEnabled"/);
  assert.match(htmlSource, /id="todoReminderRecipient"/);
  assert.match(htmlSource, /id="todoReminderTime"/);
  assert.match(htmlSource, /id="btnTodoReminderSave"/);
  assert.match(htmlSource, /id="todoReminderStatusText" role="status" aria-live="polite"/);
  assert.match(todoSource, /apiFetch\('\/api\/todo-reminder-settings'\)/);
  assert.match(todoSource, /function renderTodoReminderSettings\(\)/);
  assert.match(todoSource, /function saveTodoReminderSettings\(\)/);
  assert.match(todoSource, /\$\('#btnTodoReminderSave'\)\.addEventListener\('click', saveTodoReminderSettings\);/);
  assert.match(todoSource, /const \[todosRes, countdownsRes, categoriesRes, reminderRes\] = await Promise\.all\(\[/);
  assert.match(todoSource, /mailReady:\s*Boolean\(data\.mailReady\)/);
  assert.match(styleSource, /\.todo-reminder-card\s*\{[\s\S]*flex-direction:\s*column;/);
  assert.match(styleSource, /\.todo-reminder-chip\.ready\s*\{[\s\S]*0f766e/);
  assert.match(styleSource, /\.todo-reminder-grid\s*\{[\s\S]*grid-template-columns:\s*1fr;/);
  assert.match(styleSource, /\.todo-reminder-status\s*\{[\s\S]*font-size:\s*11px;/);
});

test('HTML escaping is safe in both text and quoted attribute contexts', async () => {
  const previousDocument = global.document;
  const dom = new JSDOM('<!doctype html><body></body>');
  global.document = dom.window.document;
  try {
    const helpers = await import(`${pathToFileURL(path.join(ROOT, 'public', 'js', 'helpers.js')).href}?escape=${Date.now()}`);
    assert.equal(helpers.escHtml(`\"'&<>`), '&quot;&#39;&amp;&lt;&gt;');
  } finally {
    dom.window.close();
    if (previousDocument === undefined) delete global.document;
    else global.document = previousDocument;
  }
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

test('markdown image preview opens on double-click and closes with Escape or backdrop', async () => {
  const previousDocument = globalThis.document;
  const previousRequestAnimationFrame = globalThis.requestAnimationFrame;
  const dom = new JSDOM(`
    <!doctype html><body>
      <div id="preview"><div class="markdown-body">
        <img id="plain" src="/uploads/example.png" alt="示例图片">
        <a href="https://example.com"><img id="linked" src="/uploads/linked.png" alt="链接图片"></a>
      </div></div>
    </body>
  `, { pretendToBeVisual: true, url: 'http://localhost/' });

  globalThis.document = dom.window.document;
  globalThis.requestAnimationFrame = callback => callback();
  try {
    const moduleUrl = pathToFileURL(path.join(ROOT, 'public', 'js', 'imagePreview.js')).href + `?preview=${Date.now()}`;
    const imagePreview = await import(moduleUrl);
    const preview = document.getElementById('preview');
    const disable = imagePreview.enableMarkdownImagePreview(preview);

    document.getElementById('plain').dispatchEvent(new dom.window.MouseEvent('dblclick', {
      bubbles: true,
      cancelable: true,
    }));
    let overlay = document.getElementById('markdownImagePreviewOverlay');
    assert.equal(overlay.style.display, 'flex');
    assert.equal(overlay.querySelector('.markdown-image-lightbox-img').getAttribute('src'), '/uploads/example.png');
    assert.equal(overlay.querySelector('.markdown-image-lightbox-img').alt, '示例图片');

    document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(overlay.style.display, 'none');
    assert.equal(overlay.querySelector('.markdown-image-lightbox-img').hasAttribute('src'), false);

    document.getElementById('plain').dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true }));
    overlay.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    assert.equal(overlay.style.display, 'none');

    document.getElementById('linked').dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true }));
    assert.equal(overlay.style.display, 'none');
    disable();
  } finally {
    dom.window.close();
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    if (previousRequestAnimationFrame === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = previousRequestAnimationFrame;
  }
});

test('markdown image preview accepts a string URL for attachment thumbnails', async () => {
  const previousDocument = globalThis.document;
  const previousRequestAnimationFrame = globalThis.requestAnimationFrame;
  const dom = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true, url: 'http://localhost/' });

  globalThis.document = dom.window.document;
  globalThis.requestAnimationFrame = callback => callback();
  try {
    const moduleUrl = pathToFileURL(path.join(ROOT, 'public', 'js', 'imagePreview.js')).href + `?preview-url=${Date.now()}`;
    const imagePreview = await import(moduleUrl);
    assert.equal(imagePreview.openMarkdownImagePreview('/uploads/example.png'), true);
    const overlay = document.getElementById('markdownImagePreviewOverlay');
    assert.equal(overlay.style.display, 'flex');
    assert.equal(overlay.querySelector('.markdown-image-lightbox-img').getAttribute('src'), '/uploads/example.png');
    assert.equal(overlay.querySelector('.markdown-image-lightbox-img').alt, '附件图片');
    imagePreview.closeMarkdownImagePreview();
    assert.equal(overlay.style.display, 'none');
  } finally {
    dom.window.close();
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    if (previousRequestAnimationFrame === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = previousRequestAnimationFrame;
  }
});

test('upload image src normalization keeps safe agent markdown images', async () => {
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  const previousDOMPurify = globalThis.DOMPurify;
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost:3000/' });
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  const purifySource = fs.readFileSync(path.join(ROOT, 'public', 'vendor', 'dompurify', 'purify.min.js'), 'utf8');
  dom.window.eval(purifySource);
  const DOMPurify = globalThis.DOMPurify;
  try {
    const helpers = await import(`${pathToFileURL(path.join(ROOT, 'public', 'js', 'helpers.js')).href}?upload-src=${Date.now()}`);
    assert.equal(helpers.normalizeUploadSrc('/uploads/1735-abc.png'), '/uploads/1735-abc.png');
    assert.equal(
      helpers.normalizeUploadSrc('http://localhost:3000/uploads/1735-abc.png'),
      '/uploads/1735-abc.png',
    );
    assert.equal(helpers.normalizeUploadSrc('/uploads/1735-abc.png?v=1'), '/uploads/1735-abc.png');
    assert.equal(helpers.isSafeImageSrc('/uploads/1735-abc.png'), true);
    assert.equal(helpers.isSafeImageSrc('http://localhost:3000/uploads/1735-abc.png'), true);
    assert.equal(helpers.normalizeUploadSrc('uploads/1735-abc.png'), '/uploads/1735-abc.png');
    assert.equal(helpers.isSafeImageSrc('uploads/1735-abc.png'), true);
    assert.equal(helpers.isSafeImageSrc('javascript:alert(1)'), false);

    DOMPurify.addHook('afterSanitizeAttributes', node => {
      if (node.tagName !== 'IMG') return;
      const normalized = helpers.normalizeUploadSrc(node.getAttribute('src'));
      if (normalized && helpers.isSafeImageSrc(normalized)) {
        node.setAttribute('src', normalized);
      } else {
        node.removeAttribute('src');
      }
    });

    const host = document.createElement('div');
    host.innerHTML = DOMPurify.sanitize(
      '<img src="http://localhost:3000/uploads/1735-abc.png" alt="x">',
      { ADD_TAGS: ['img'], ADD_ATTR: ['src', 'alt'] },
    );
    assert.equal(host.querySelector('img')?.getAttribute('src'), '/uploads/1735-abc.png');

    host.innerHTML = DOMPurify.sanitize(
      '![x](/uploads/1735-abc.png)',
      { ADD_TAGS: ['img'], ADD_ATTR: ['src', 'alt'] },
    );
    assert.equal(host.querySelector('img'), null);

    host.innerHTML = DOMPurify.sanitize(
      '<img src="javascript:alert(1)" alt="bad">',
      { ADD_TAGS: ['img'], ADD_ATTR: ['src', 'alt'] },
    );
    assert.equal(host.querySelector('img')?.hasAttribute('src'), false);
  } finally {
    dom.window.close();
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousDOMPurify === undefined) delete globalThis.DOMPurify;
    else globalThis.DOMPurify = previousDOMPurify;
  }
});

test('new workspace exposes Agent, knowledge, and memory modes in a shared two-column shell', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const source = fs.readFileSync(path.join(ROOT, 'public', 'js', 'workbench.js'), 'utf8');
  const styles = fs.readFileSync(path.join(ROOT, 'public', 'css', 'workbench.css'), 'utf8');
  const document = new JSDOM(html).window.document;
  const modes = [...document.querySelectorAll('.topbar-mode-switch [data-mode]')].map(item => item.dataset.mode);
  assert.deepEqual(modes, ['agent', 'knowledge', 'memory', 'todos']);
  assert.equal(document.querySelector('[data-mode="tasks"]'), null);
  assert.equal(document.querySelector('#knowledgeViewSwitch'), null);
  assert.equal(document.querySelector('[data-knowledge-view]'), null);
  assert.equal(document.querySelector('#todoSidebarPanel') !== null, true);
  assert.equal(document.querySelector('#todoSidebarPanel').dataset.sidebarMode, 'todos');
  assert.equal(document.querySelector('#todoSidebarPanel').closest('#knowledgeSidebarPanel'), null);
  assert.equal(document.querySelector('#todoView') !== null, true);
  assert.equal(document.querySelector('#todoView').dataset.mainMode, 'todos');
  assert.equal(document.querySelector('#todoView').hasAttribute('hidden'), true);
  assert.equal(document.querySelector('#todoStatPending') !== null, true);
  assert.equal(document.querySelector('#btnTodoNew') !== null, true);
  assert.equal(document.querySelector('#todoFormEmpty') !== null, true);
  assert.equal(document.querySelector('#todoFullPanel').closest('#todoView') !== null, true);
  assert.equal(document.querySelector('#todoFullTitle').closest('#todoView') !== null, true);
  assert.equal(document.querySelector('#btnTodoCategoryOpen').closest('#todoSidebarPanel') !== null, true);
  assert.equal(document.querySelector('#todoReminderHeading') !== null, true);
  assert.match(source, /legacyTodos/);
  assert.match(source, /'#todos'/);
  assert.match(source, /from '\.\/todos\.js'/);
  assert.equal(document.querySelector('#agentSidebarPanel') !== null, true);
  assert.equal(document.querySelector('#knowledgeSidebarPanel') !== null, true);
  assert.equal(document.querySelector('#memorySidebarPanel') !== null, true);
  assert.equal(document.querySelector('#memoryView') !== null, true);
  assert.equal(document.querySelector('#agentMemorySection'), null);
  assert.equal(document.querySelector('#knowledgeRootPanel') !== null, true);
  assert.equal(document.querySelector('#knowledgeInsidePanel') !== null, true);
  assert.equal(document.querySelector('#knowledgeBaseList') !== null, true);
  assert.equal(document.querySelector('#knowledgeFolderTree') !== null, true);
  assert.equal(document.querySelector('#knowledgeBreadcrumb') !== null, true);
  assert.equal(document.querySelector('#knowledgeDocumentListHeading') !== null, true);
  assert.equal(document.querySelector('#knowledgeInsideTitle'), null);
  assert.equal(document.querySelector('#knowledgeDocumentCount'), null);
  assert.equal(document.querySelector('#knowledgeBackButton'), null);
  assert.match(source, /renderKnowledgeBreadcrumb/);
  assert.match(source, /documentRowSubtitle/);
  assert.match(source, /knowledgeFiltersActive/);
  assert.match(styles, /\.knowledge-breadcrumb/);
  assert.match(styles, /\.document-list-heading/);
  assert.equal(document.querySelector('#knowledgeTypeFilter'), null);
  assert.equal(document.querySelector('#knowledgeCollectionFilter'), null);
  assert.equal(document.querySelector('#agentView') !== null, true);
  assert.equal(document.querySelector('#knowledgeView') !== null, true);
  assert.equal(document.querySelector('#annotationContent') !== null, true);
  assert.equal(document.querySelector('#filePreviewHost') !== null, true);
  assert.equal(document.querySelector('#fileExtractDetails') !== null, true);
  assert.equal(document.querySelector('#deleteDocumentButton') !== null, true);
  assert.equal(document.querySelector('#insertImageButton') !== null, true);
  assert.equal(document.querySelector('#documentImageInput') !== null, true);
  assert.equal(document.querySelector('#knowledgeNameDialog') !== null, true);
  assert.equal(document.querySelector('#knowledgeNameInput') !== null, true);
  assert.match(html, /id="knowledgeNameDialog"[\s\S]*id="knowledgeNameForm"[\s\S]*id="knowledgeNameInput"[\s\S]*id="knowledgeNameSubmit"/);
  assert.match(source, /function promptKnowledgeName/);
  assert.match(source, /initKnowledgeNameDialog/);
  assert.doesNotMatch(source, /window\.prompt/);
  assert.match(source, /uploadNoteImage/);
  assert.match(source, /handleDocumentImageUpload/);
  assert.match(html, /image\/png/);
  assert.match(source, /renderFilePreview/);
  assert.match(source, /destroyFilePreview/);
  assert.match(source, /knowledge\/filePreview\.js/);
  assert.match(styles, /\.file-preview-host/);
  assert.equal(document.querySelector('#settingsDialog a[href="/legacy.html"]'), null);
  assert.equal(document.querySelector('[data-settings-nav="account"]') !== null, true);
  assert.equal(document.querySelector('#accountDisplayNameInput') !== null, true);
  assert.equal(document.querySelector('#btnChangeAccountPassword') !== null, true);
  assert.equal(document.querySelector('#userManagerDialog') !== null, true);
  assert.equal(document.querySelector('#btnAdminUsers') !== null, true);
  assert.equal(document.querySelector('#agentUserProfile'), null);
  assert.equal(document.querySelector('#aiChatView'), null);
  assert.equal(document.querySelector('#agentDeepseekKey'), null);
  assert.equal(document.querySelector('#agentMoonshotKey'), null);
  assert.equal(document.querySelector('#agentOpenrouterKey'), null);
  assert.equal(document.querySelector('#agentOpenRouterZdr'), null);
  assert.equal(document.querySelector('#refreshOpenRouterModels'), null);
  assert.equal(document.querySelector('#addCustomProvider') !== null, true);
  assert.equal(document.querySelector('#customProvidersList') !== null, true);
  assert.match(source, /function customProviderFormatLabel/);
  assert.match(source, /<details class="custom-provider-card"/);
  assert.match(source, /custom-provider-summary/);
  assert.match(styles, /\.custom-provider-conn-grid/);
  assert.match(source, /customProviderExpandIndex/);
  assert.match(source, /data-fetch-models/);
  assert.match(source, /function fetchProviderModels/);
  assert.match(source, /function openProviderModelsPicker/);
  assert.match(source, /function applyProviderModelsSelection/);
  assert.match(source, /provider-models-item/);
  assert.match(html, /id="providerModelsDialog"/);
  assert.match(html, /id="providerModelsSearch"/);
  assert.match(html, /id="providerModelsList"/);
  assert.match(styles, /\.provider-models-list/);
  assert.doesNotMatch(source, /custom-provider-fetch-query/);
  assert.match(source, /\$\('#settingsDialog'\)\?\.open && Array\.isArray\(state\.customProvidersDraft\)/);
  assert.match(source, /custom-provider-supports-media/);
  assert.match(source, /custom-provider-thinking-select/);
  assert.match(source, /custom-provider-zdr/);
  assert.match(styles, /\.custom-provider-capabilities/);
  assert.match(source, /function providerModelGroups/);
  assert.doesNotMatch(source, /DIRECT_AGENT_MODELS/);
  assert.equal(document.querySelector('#agentSeedreamKey') !== null, true);
  assert.equal(document.querySelector('#agentImageProvider') !== null, true);
  assert.equal(document.querySelector('#agentGetokenKey') !== null, true);
  assert.equal(document.querySelector('#agentGetokenGrokImagineKey') !== null, true);
  assert.equal(document.querySelector('#agentGetokenNanoBananaKey') !== null, true);
  assert.equal(document.querySelector('#agentGetokenModel') !== null, true);
  assert.match(source, /syncImageProviderSettingsUi/);
  assert.equal(document.querySelector('#agentSeedreamModel') !== null, true);
  assert.equal(document.querySelector('#agentSeedreamSize') !== null, true);
  assert.equal(document.querySelector('#agentSeedreamWatermark') !== null, true);
  assert.equal(document.querySelector('#agentSeedreamOutputFormat') !== null, true);
  assert.equal(document.querySelector('#agentSeedreamSequential') !== null, true);
  assert.equal(document.querySelector('#agentAttachButton') !== null, true);
  assert.match(source, /syncSeedreamSettingsUi/);
  assert.match(source, /\/api\/agent\/uploads/);
  assert.match(source, /function handleAgentImagePaste/);
  assert.match(source, /collectClipboardImageFiles/);
  assert.equal(document.querySelector('[data-settings-nav="image"]') !== null, true);
  assert.equal(document.querySelector('[data-settings-nav="sessions"]') !== null, true);
  assert.equal(document.querySelector('[data-settings-nav="computer"]') !== null, true);
  assert.equal(document.querySelector('#computerToolsToggle') !== null, true);
  assert.equal(document.querySelector('#computerAllowlist') !== null, true);
  assert.equal(document.querySelector('#btnComputerAllowlistAdd') !== null, true);
  assert.match(source, /\/api\/admin\/agent-policy/);
  assert.match(source, /function loadComputerPolicyForm/);
  assert.match(source, /function saveComputerPolicy/);
  assert.equal(document.querySelector('#archivedSessionList') !== null, true);
  assert.match(source, /async function deleteArchivedSession/);
  assert.match(source, /\/api\/agent\/sessions\?status=archived/);
  assert.match(styles, /\.archived-session-row/);
  assert.equal(document.querySelector('#agentModelSelect') !== null, true);
  assert.equal(document.querySelector('#saveAgentSettings') !== null, true);
  assert.equal(document.querySelector('#agentMaxRounds') !== null, true);
  assert.equal(document.querySelector('#agentFileReadMaxMb') !== null, true);
  assert.equal(document.querySelector('#agentDelegateMaxRounds') !== null, true);
  assert.equal(document.querySelector('#agentMaxToolFailures') !== null, true);
  assert.equal(document.querySelector('[data-settings-nav="memory"]') !== null, true);
  assert.equal(document.querySelector('#memoryRefreshMaxRounds') !== null, true);
  assert.equal(document.querySelector('#memoryRefreshMaxProposals') !== null, true);
  assert.equal(document.querySelector('#refreshAgentMemory') !== null, true);
  assert.equal(document.querySelector('#agentMemoryItems') !== null, true);
  assert.equal(document.querySelector('#executionTrace'), null);
  assert.match(source, /function stopLiveTrace/);
  assert.match(source, /function showEmptySession\(\)[\s\S]{0,400}stopLiveTrace\(\)/);
  assert.doesNotMatch(source, /async function openSession\([\s\S]{0,900}stopLiveTrace\(\)/);
  assert.match(source, /async function openSession\([\s\S]{0,1200}syncActiveSessionRunUi/);
  assert.match(source, /sessionRuns:\s*new Map\(\)/);
  assert.match(source, /dataset\.runId/);
  assert.match(source, /function upsertRunTrace/);
  assert.doesNotMatch(source, /\$\('#traceEvents'\)\.innerHTML = ''/);
  assert.match(styles, /\.message-list \.execution-trace/);
  assert.match(styles, /\.approval-card pre[^{]*\{[^}]*white-space:\s*pre-wrap/);
  assert.match(html, /id="agentComposer"[\s\S]*id="agentApprovalDock"[\s\S]*id="agentInput"/);
  assert.match(source, /function summarizeApprovalArgs/);
  assert.match(source, /approval-card-body/);
  assert.match(source, /agent-composer--question/);
  assert.match(styles, /\.agent-approval-dock \.approval-card-body/);
  assert.match(source, /function setComposerQuestionActive/);
  assert.match(source, /function renderAgentQuestion[\s\S]{0,500}#agentApprovalDock/);
  assert.doesNotMatch(source, /function renderAgentQuestion[\s\S]{0,500}#agentMessageList/);
  assert.match(source, /closest\('\[data-approval-id\]'\)[\s\S]{0,1600}setSessionRunStatus\(sessionId, 'running'\)/);
  assert.match(source, /const restoreCard = \(\) =>/);
  assert.match(source, /function formatSessionMeta/);
  assert.match(source, /function applyAgentTopbar/);
  assert.match(source, /formatSessionMeta\(session\)/);
  assert.doesNotMatch(source, /lastMessagePreview \|\| formatTime\(session\.updatedAt\)/);
  assert.match(source, /function buildAssistantMetaHtml/);
  assert.match(source, /Number\.isFinite\(time\)/);
  assert.doesNotMatch(source, /function buildAssistantMetaHtml[\s\S]{0,220}new Date\(createdAt\)\.toISOString\(\)/);
  assert.match(source, /lastRun\?\.completedAt/);
  assert.match(source, /function agentModelLabel/);
  assert.match(source, /buildAssistantMetaHtml\(createdAt, model\)/);
  assert.match(source, /class="message-model"/);
  assert.match(source, /from '\.\/markdown\.js'/);
  assert.match(source, /normalizeUploadSrc/);
  assert.match(source, /function findGeneratedImageCard/);
  assert.match(source, /function trackGeneratedImageUrl/);
  assert.match(source, /function trackGeneratedImageUrlsFromToolResult/);
  assert.match(source, /function removeRunImagePreviews/);
  assert.match(source, /collectKnownUploadUrls/);
  assert.match(source, /dedupeImageMarkdown/);
  assert.match(source, /dataset\.runId/);
  assert.match(source, /handleDelegateRunEvent[\s\S]{0,1200}trackGeneratedImageUrlsFromToolResult/);
  assert.doesNotMatch(source, /data-generated-image="\$\{CSS\.escape\(url\)\}"/);
  assert.match(source, /data-memory-archive/);
  assert.match(styles, /\.message-content img/);
  assert.match(source, /\/api\/agent\/memory\/refresh/);
  assert.equal(document.querySelector('#mentionMenu') !== null, true);
  assert.equal(document.querySelector('#mentionMenu [data-mention="today"]') !== null, true);
  assert.match(html, /@知识库/);
  assert.match(source, /data-mention/);
  assert.match(source, /renderMentionMenu/);
  assert.equal(document.querySelector('#agentComposerModelSelect') !== null, true);
  assert.equal(document.querySelector('#agentComposerModelSelect').getAttribute('aria-label'), '切换 Agent 模型');
  assert.equal(document.querySelector('#agentSidebarStatus')?.tagName, 'BUTTON');
  assert.equal(document.querySelector('.agent-empty-state [data-open-settings]') !== null, true);
  assert.match(source, /\/api\/agent\/status/);
  assert.match(source, /\/api\/ai\/settings/);
  assert.match(source, /未配置模型/);
  assert.match(source, /data-open-settings/);
  assert.match(source, /function quickSaveAgentModel/);
  assert.match(source, /\$\('#agentComposerModelSelect'\)[\s\S]{0,120}addEventListener\('change'/);
  assert.match(source, /\$\('#agentSidebarStatus'\)\.addEventListener\('click'/);
  assert.doesNotMatch(html, /id="settingsButton"/);
  assert.match(source, /openSettings\('model'\)/);
  assert.match(source, /baseVersion:\s*state\.activeDocument\?\.version/);
  assert.match(source, /data-citation-document/);
  assert.match(source, /knowledgeBase/);
  assert.match(source, /loadKnowledgeTree/);
  assert.match(source, /setTimeout\(\(\) => saveDocument\(\), 800\)/);
  assert.match(styles, /grid-template-columns:\s*var\(--sidebar-width\) minmax\(0, 1fr\)/);
  assert.match(styles, /\.brand-home[^{]*\{[^}]*flex:\s*0 0 auto/);
  assert.match(styles, /\.sidebar-scroll\s*\{[\s\S]*overflow-y:\s*auto;/);
  assert.match(styles, /\.note-editor,\s*\.file-reader\s*\{[\s\S]*overflow-y:\s*auto;/);
  assert.match(source, /brandHome\.setAttribute\('href', mode === 'knowledge' \? '#knowledge' : mode === 'memory' \? '#memory' : mode === 'todos' \? '#todos' : '#agent'\)/);
  assert.match(styles, /grid-template-columns:\s*auto auto auto auto/);
  assert.match(styles, /@media \(max-width: 840px\)[\s\S]*body\.sidebar-visible \.workspace-sidebar/);
  assert.equal(document.querySelector('#sidebarToggle') !== null, true);
  assert.equal(document.querySelector('#sidebarExpand') !== null, true);
  assert.match(source, /sidebar-collapsed/);
  assert.match(source, /workbenchSidebarCollapsed/);
  assert.match(styles, /body\.sidebar-collapsed \.workspace-shell/);
  assert.equal(document.querySelector('#restoreDocumentButton') !== null, true);
  assert.match(source, /restoreActiveDocument/);
  assert.match(source, /\/api\/knowledge\/documents\/\$\{encodeURIComponent\(document\.id\)\}\/restore/);
  assert.match(source, /\/api\/knowledge\/search\?/);
  assert.match(source, /data-search-offset/);
  assert.equal(document.querySelector('#knowledgeSearchModeHint') !== null, true);
  assert.equal(document.querySelector('[data-settings-nav="knowledge"]') !== null, true);
  assert.equal(document.querySelector('[data-settings-nav="data"]') !== null, true);
  assert.equal(document.querySelector('#exportJsonBackupButton') !== null, true);
  assert.equal(document.querySelector('#exportZipBackupButton') !== null, true);
  assert.equal(document.querySelector('#memoryPendingBadge') !== null, true);
  assert.equal(document.querySelector('[data-editor-mode="split"]') !== null, true);
  assert.match(source, /refreshMemoryPendingCount/);
  assert.match(source, /updateMemoryPendingBadge/);
  assert.match(source, /cycleEditorMode/);
  assert.match(source, /event\.shiftKey && event\.key\.toLowerCase\(\) === 'p'/);
  assert.match(html, /Ctrl\+Shift\+P/);
  assert.match(styles, /\.mode-pending-badge/);
  assert.match(styles, /\.note-editor\.is-split/);
  assert.match(source, /from '\.\/workbench-backup\.js'/);
  assert.match(source, /knowledgeSearchOptions/);
  assert.match(source, /knowledgeSearchOptionsQuery/);
  assert.match(styles, /\.knowledge-search-mode-hint/);
  assert.match(source, /highlightSearch/);
  assert.match(source, /documentRowSubtitleHtml/);
  assert.match(source, /documentRowTitleHtml/);
  assert.match(styles, /\.document-row small mark/);
  assert.match(styles, /\.file-reader mark/);
  assert.equal(fs.existsSync(path.join(ROOT, 'public', 'js', 'markdown.js')), true);
  assert.match(html, /vendor\/katex\/katex\.min\.css/);
  assert.match(html, /vendor\/katex\/katex\.min\.js/);
  assert.match(source, /from '\.\/markdown\.js'/);
  assert.match(source, /renderToHtmlUncached/);
  assert.match(source, /renderDocumentPreview/);
  assert.match(source, /enableMarkdownImagePreview\(host, '\.markdown-preview img'\)/);
  assert.match(styles, /\.prose table/);
  assert.match(styles, /\.markdown-preview img \{ cursor: zoom-in;/);
  assert.equal(fs.existsSync(path.join(ROOT, 'public', 'vendor', 'pdfjs', 'pdf.worker.min.js')), true);
  const toolSource = fs.readFileSync(path.join(ROOT, 'lib', 'agent', 'tools.js'), 'utf8');
  assert.match(toolSource, /name: 'knowledge\.import'/);
  assert.match(toolSource, /name: 'file\.delete'/);
});

test('agent status is unconfigured without an API key', async (t) => {
  const { baseUrl } = loadFreshApp(t);
  const response = await fetch(`${baseUrl}/api/agent/status`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.configured, false);
  assert.equal(body.provider, '');
  assert.equal(body.model, '');
  assert.equal('apiKey' in body, false);
});
