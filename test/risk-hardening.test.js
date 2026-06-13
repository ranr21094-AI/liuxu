const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
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

function loadFreshApp(t, { diaryPassword, authToken, deepseekApiKey, deepseekBaseUrl, deepseekDefaultModel, tavilyApiKey, tavilyBaseUrl, perplexityApiKey, perplexityBaseUrl, seedreamApiKey, seedreamBaseUrl, seedreamDefaultModel, westockNpxCommand } = {}) {
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
  process.env.TAVILY_API_KEY = tavilyApiKey || '';
  process.env.TAVILY_BASE_URL = tavilyBaseUrl || 'https://api.tavily.com';
  process.env.PERPLEXITY_API_KEY = perplexityApiKey || '';
  process.env.PERPLEXITY_BASE_URL = perplexityBaseUrl || 'https://api.perplexity.ai';
  process.env.SEEDREAM_API_KEY = seedreamApiKey || '';
  process.env.SEEDREAM_BASE_URL = seedreamBaseUrl || 'https://ark.cn-beijing.volces.com/api/v3';
  process.env.SEEDREAM_DEFAULT_MODEL = seedreamDefaultModel || 'doubao-seedream-5-0-260128';
  process.env.WESTOCK_NPX_COMMAND = westockNpxCommand || 'npx -y westock-data-clawhub@1.0.4';
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
    delete process.env.TAVILY_API_KEY;
    delete process.env.TAVILY_BASE_URL;
    delete process.env.PERPLEXITY_API_KEY;
    delete process.env.PERPLEXITY_BASE_URL;
    delete process.env.SEEDREAM_API_KEY;
    delete process.env.SEEDREAM_BASE_URL;
    delete process.env.SEEDREAM_DEFAULT_MODEL;
    delete process.env.WESTOCK_NPX_COMMAND;
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

  const originalFetch = global.fetch;
  const { baseUrl } = loadFreshApp(t, { deepseekApiKey: 'test-key', deepseekBaseUrl: 'https://deepseek.test' });
  global.fetch = async (url, options = {}) => {
    if (String(url) === 'https://deepseek.test/chat/completions') {
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'AI reply without search' } }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return originalFetch(url, options);
  };
  t.after(() => {
    global.fetch = originalFetch;
  });
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

  const badStream = await fetch(`${baseUrl}/api/ai/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      stream: 'yes',
      messages: [{ role: 'user', content: 'hello' }],
    }),
  });
  assert.equal(badStream.status, 400);

  const badSearchDepth = await fetch(`${baseUrl}/api/ai/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      webSearchDepth: 'deep',
      messages: [{ role: 'user', content: 'hello' }],
    }),
  });
  assert.equal(badSearchDepth.status, 400);

  const missingTavilyKey = await fetch(`${baseUrl}/api/ai/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      apiKey: 'user-provided-key',
      webSearchEnabled: true,
      messages: [{ role: 'user', content: 'hello' }],
    }),
  });
  assert.equal(missingTavilyKey.status, 200);
  assert.deepEqual(await missingTavilyKey.json(), {
    message: { role: 'assistant', content: 'AI reply without search' },
    sources: [],
  });

  const badRole = await fetch(`${baseUrl}/api/ai/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [{ role: 'system', content: 'hidden prompt' }],
    }),
  });
  assert.equal(badRole.status, 400);
});

test('AI settings persist to local data storage and validate options', async (t) => {
  const { baseUrl, dataDir } = loadFreshApp(t);

  const defaults = await fetch(`${baseUrl}/api/ai/settings`);
  assert.equal(defaults.status, 200);
  assert.deepEqual(await defaults.json(), {
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
    skills: {
      westock: { enabled: true },
      perplexity: { enabled: true },
    },
  });

  const saved = await fetch(`${baseUrl}/api/ai/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      apiKey: 'sk-local-settings',
      model: 'deepseek-v4-pro',
      reasoningEffort: 'max',
      stream: true,
      userProfile: 'I prefer concise Chinese replies.',
      logContextEnabled: true,
      diaryContextEnabled: true,
      tavilyApiKey: 'tvly-local-settings',
      perplexityApiKey: 'pplx-local-settings',
      webSearchEnabled: true,
      webSearchDepth: 'advanced',
      seedreamApiKey: 'seedream-local-settings',
      seedreamModel: 'doubao-seedream-4-5-251128',
      seedreamSize: '2848x1600',
      seedreamWatermark: false,
      skills: {
        westock: { enabled: false },
        perplexity: { enabled: false },
      },
    }),
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), {
    apiKey: 'sk-local-settings',
    model: 'deepseek-v4-pro',
    reasoningEffort: 'max',
    stream: true,
    userProfile: 'I prefer concise Chinese replies.',
    logContextEnabled: true,
    diaryContextEnabled: true,
    tavilyApiKey: 'tvly-local-settings',
    perplexityApiKey: 'pplx-local-settings',
    webSearchEnabled: true,
    webSearchDepth: 'advanced',
    seedreamApiKey: 'seedream-local-settings',
    seedreamModel: 'doubao-seedream-4-5-251128',
    seedreamSize: '2848x1600',
    seedreamWatermark: false,
    skills: {
      westock: { enabled: false },
      perplexity: { enabled: false },
    },
  });
  assert.equal(fs.existsSync(path.join(dataDir, 'ai-settings.json')), true);
  assert.match(fs.readFileSync(path.join(dataDir, 'ai-settings.json'), 'utf8'), /sk-local-settings/);
  assert.match(fs.readFileSync(path.join(dataDir, 'ai-settings.json'), 'utf8'), /tvly-local-settings/);
  assert.match(fs.readFileSync(path.join(dataDir, 'ai-settings.json'), 'utf8'), /pplx-local-settings/);
  assert.match(fs.readFileSync(path.join(dataDir, 'ai-settings.json'), 'utf8'), /seedream-local-settings/);

  for (const body of [
    { model: 'bad-model' },
    { reasoningEffort: 'low' },
    { stream: 'true' },
    { userProfile: 123 },
    { logContextEnabled: 'true' },
    { diaryContextEnabled: 'true' },
    { webSearchEnabled: 'true' },
    { webSearchDepth: 'deep' },
    { seedreamModel: 'bad-seedream' },
    { seedreamSize: 'bad-size' },
    { seedreamWatermark: 'true' },
    { skills: { westock: { enabled: 'true' } } },
    { skills: { perplexity: { enabled: 'true' } } },
  ]) {
    const invalid = await fetch(`${baseUrl}/api/ai/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(invalid.status, 400);
  }
});

test('WeStock skill metadata, settings, and confirmed CLI execution are guarded', async (t) => {
  const childProcess = require('node:child_process');
  const originalSpawn = childProcess.spawn;
  const calls = [];
  childProcess.spawn = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    process.nextTick(() => {
      child.stdout.emit('data', Buffer.from('| code | last |\n|---|---:|\n| sh600000 | 10.20 |\n'));
      child.emit('close', 0);
    });
    return child;
  };
  t.after(() => {
    childProcess.spawn = originalSpawn;
  });

  const { baseUrl } = loadFreshApp(t, { westockNpxCommand: 'westock-cli --fixed' });
  const skills = await fetch(`${baseUrl}/api/ai/skills`);
  assert.equal(skills.status, 200);
  const skillsBody = await skills.json();
  assert.equal(skillsBody.skills.length, 1);
  assert.equal(skillsBody.skills[0].id, 'westock');
  assert.equal(skillsBody.skills[0].enabled, true);
  assert.ok(skillsBody.skills[0].tools.includes('kline'));

  const noConfirm = await fetch(`${baseUrl}/api/ai/skills/westock/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool: 'kline', args: { symbol: 'sh600000' } }),
  });
  assert.equal(noConfirm.status, 400);

  const badTool = await fetch(`${baseUrl}/api/ai/skills/westock/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool: 'shell', args: {}, confirmed: true }),
  });
  assert.equal(badTool.status, 400);

  const badArg = await fetch(`${baseUrl}/api/ai/skills/westock/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool: 'kline', args: { symbol: 'sh600000;rm' }, confirmed: true }),
  });
  assert.equal(badArg.status, 400);

  const ok = await fetch(`${baseUrl}/api/ai/skills/westock/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool: 'kline', args: { symbol: 'sh600000' }, confirmed: true }),
  });
  assert.equal(ok.status, 200);
  assert.match((await ok.json()).content, /sh600000/);
  assert.equal(calls[0].command, 'westock-cli');
  assert.deepEqual(calls[0].args, ['--fixed', 'kline', 'sh600000']);
  assert.equal(calls[0].options.shell, true);

  const disabled = await fetch(`${baseUrl}/api/ai/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ skills: { westock: { enabled: false } } }),
  });
  assert.equal(disabled.status, 200);
  const forbidden = await fetch(`${baseUrl}/api/ai/skills/westock/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool: 'kline', args: { symbol: 'sh600000' }, confirmed: true }),
  });
  assert.equal(forbidden.status, 403);
});

test('Perplexity skill settings and confirmed search execution are guarded', async (t) => {
  const originalFetch = global.fetch;
  const requests = [];
  const { baseUrl } = loadFreshApp(t, {
    perplexityApiKey: 'pplx-env-key',
    perplexityBaseUrl: 'https://perplexity.test',
  });
  global.fetch = async (target, options = {}) => {
    if (target === 'https://perplexity.test/search') {
      requests.push({ target, options, payload: JSON.parse(options.body) });
      return new Response(JSON.stringify({
        results: [
          { title: 'Perplexity Docs', url: 'https://docs.perplexity.ai', snippet: 'Grounded search result.' },
        ],
        citations: ['https://docs.perplexity.ai'],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return originalFetch(target, options);
  };
  t.after(() => {
    global.fetch = originalFetch;
  });

  const noConfirm = await fetch(`${baseUrl}/api/ai/skills/perplexity/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool: 'search', args: { query: 'latest ai news' } }),
  });
  assert.equal(noConfirm.status, 400);

  const badTool = await fetch(`${baseUrl}/api/ai/skills/perplexity/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool: 'shell', args: { query: 'latest ai news' }, confirmed: true }),
  });
  assert.equal(badTool.status, 400);

  const badArg = await fetch(`${baseUrl}/api/ai/skills/perplexity/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool: 'search', args: { queries: ['1', '2', '3', '4'] }, confirmed: true }),
  });
  assert.equal(badArg.status, 400);

  const ok = await fetch(`${baseUrl}/api/ai/skills/perplexity/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool: 'search', args: { query: 'latest ai news' }, confirmed: true }),
  });
  assert.equal(ok.status, 200);
  const okBody = await ok.json();
  assert.equal(okBody.skillId, 'perplexity');
  assert.equal(okBody.tool, 'search');
  assert.match(okBody.content, /Perplexity Docs/);
  assert.equal(requests[0].options.headers.Authorization, 'Bearer pplx-env-key');
  assert.deepEqual(requests[0].payload, { query: ['latest ai news'] });

  const saved = await fetch(`${baseUrl}/api/ai/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      perplexityApiKey: 'pplx-saved-key',
      skills: { perplexity: { enabled: true } },
    }),
  });
  assert.equal(saved.status, 200);

  const withSavedKey = await fetch(`${baseUrl}/api/ai/skills/perplexity/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool: 'search', args: { queries: ['query one', 'query two'] }, confirmed: true }),
  });
  assert.equal(withSavedKey.status, 200);
  assert.equal(requests[1].options.headers.Authorization, 'Bearer pplx-saved-key');
  assert.deepEqual(requests[1].payload, { query: ['query one', 'query two'] });

  const disabled = await fetch(`${baseUrl}/api/ai/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ skills: { perplexity: { enabled: false } } }),
  });
  assert.equal(disabled.status, 200);
  const forbidden = await fetch(`${baseUrl}/api/ai/skills/perplexity/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool: 'search', args: { query: 'latest ai news' }, confirmed: true }),
  });
  assert.equal(forbidden.status, 403);
});

test('AI chat injects selected skill prompts only when selected and returns tool cards', async (t) => {
  const originalFetch = global.fetch;
  const { baseUrl } = loadFreshApp(t, {
    deepseekApiKey: 'sk-env-key',
    deepseekBaseUrl: 'https://deepseek.test',
  });
  const payloads = [];
  global.fetch = async (target, options = {}) => {
    if (target === 'https://deepseek.test/chat/completions') {
      const payload = JSON.parse(options.body);
      payloads.push(payload);
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: payload.messages.some(message => /WeStock Data skill/.test(message.content || ''))
              ? JSON.stringify({
                reply: '需要查询浦发银行行情。',
                toolCall: {
                  skillId: 'westock',
                  tool: 'kline',
                  args: { symbol: 'sh600000' },
                  requiresConfirmation: true,
                },
              })
              : '普通回答',
          },
        }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return originalFetch(target, options);
  };
  t.after(() => {
    global.fetch = originalFetch;
  });

  const normal = await fetch(`${baseUrl}/api/ai/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: '你好' }] }),
  });
  assert.equal(normal.status, 200);
  assert.equal((await normal.json()).toolCall, undefined);

  const withSkill = await fetch(`${baseUrl}/api/ai/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: '查浦发银行行情' }], skill: { id: 'westock' } }),
  });
  assert.equal(withSkill.status, 200);
  const body = await withSkill.json();
  assert.equal(body.message.content, '需要查询浦发银行行情。');
  assert.deepEqual(body.toolCall, {
    skillId: 'westock',
    tool: 'kline',
    args: { symbol: 'sh600000' },
    requiresConfirmation: true,
    status: 'pending',
  });
  assert.equal(payloads[0].messages.some(message => /WeStock Data skill/.test(message.content || '')), false);
  assert.equal(payloads[1].messages[0].role, 'system');
  assert.match(payloads[1].messages[0].content, /WeStock Data skill/);

  const withPerplexity = await fetch(`${baseUrl}/api/ai/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: '查一下最新 AI 新闻' }], skill: { id: 'perplexity' } }),
  });
  assert.equal(withPerplexity.status, 400);

  const badSkill = await fetch(`${baseUrl}/api/ai/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'test' }], skill: { id: 'unknown' } }),
  });
  assert.equal(badSkill.status, 400);
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
  assert.deepEqual(await res.json(), { message: { role: 'assistant', content: 'AI reply' }, sources: [] });
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

test('AI chat can include user profile and permitted logs without leaking locked diary entries', async (t) => {
  const originalFetch = global.fetch;
  const { db, baseUrl } = loadFreshApp(t, {
    diaryPassword: 'secret',
    deepseekBaseUrl: 'https://deepseek.test',
  });
  db.create({
    title: 'public planning',
    content: 'normal work log body',
    category: '开发',
    hours: 2,
    log_date: '2026-05-17',
  });
  db.create({
    title: 'private title',
    content: 'private diary content',
    category: DIARY_CATEGORY,
    log_date: '2026-05-16',
  });

  const capturedPayloads = [];
  global.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.startsWith('http://127.0.0.1')) return originalFetch(url, options);
    capturedPayloads.push(JSON.parse(options.body));
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

  const lockedRes = await fetch(`${baseUrl}/api/ai/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      apiKey: 'user-provided-key',
      userProfile: 'I prefer concise Chinese replies.',
      logContextEnabled: true,
      diaryContextEnabled: true,
      messages: [{ role: 'user', content: 'summarize my recent work' }],
    }),
  });
  assert.equal(lockedRes.status, 200);
  assert.equal(capturedPayloads[0].messages[0].role, 'system');
  assert.match(capturedPayloads[0].messages[0].content, /I prefer concise Chinese replies\./);
  assert.match(capturedPayloads[0].messages[0].content, /public planning/);
  assert.match(capturedPayloads[0].messages[0].content, /normal work log body/);
  assert.match(capturedPayloads[0].messages[0].content, /Diary logs included: no/);
  assert.doesNotMatch(JSON.stringify(capturedPayloads[0]), /private diary content|private title|user-provided-key/);

  const cookie = await unlockDiary(baseUrl, 'secret');
  const unlockedRes = await fetch(`${baseUrl}/api/ai/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({
      apiKey: 'user-provided-key',
      logContextEnabled: true,
      diaryContextEnabled: true,
      messages: [{ role: 'user', content: 'include diary too' }],
    }),
  });
  assert.equal(unlockedRes.status, 200);
  assert.match(capturedPayloads[1].messages[0].content, /Diary logs included: yes/);
  assert.match(capturedPayloads[1].messages[0].content, /private diary content/);
  assert.match(capturedPayloads[1].messages[0].content, /private title/);
  assert.doesNotMatch(JSON.stringify(capturedPayloads[1]), /user-provided-key/);
});

test('AI chat can augment DeepSeek with Tavily search using only user input', async (t) => {
  const originalFetch = global.fetch;
  const { db, baseUrl } = loadFreshApp(t, {
    deepseekBaseUrl: 'https://deepseek.test',
    tavilyBaseUrl: 'https://tavily.test',
  });
  db.create({
    title: 'private title',
    content: 'private diary content',
    category: DIARY_CATEGORY,
    log_date: '2026-05-16',
  });

  let tavilyPayload = null;
  let tavilyHeaders = {};
  let deepSeekPayload = null;
  global.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.startsWith('http://127.0.0.1')) return originalFetch(url, options);
    if (target === 'https://tavily.test/search') {
      tavilyHeaders = options.headers || {};
      tavilyPayload = JSON.parse(options.body);
      return new Response(JSON.stringify({
        answer: 'Search says hello.',
        results: [{
          title: 'Trusted result',
          url: 'https://example.com/trusted',
          content: 'Fresh public snippet',
          score: 0.9,
          raw_content: 'should not be forwarded',
        }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    deepSeekPayload = JSON.parse(options.body);
    return new Response(JSON.stringify({
      choices: [{ message: { content: 'AI searched reply' } }],
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
      tavilyApiKey: 'tvly-user-provided-key',
      userProfile: 'I prefer concise Chinese replies.',
      webSearchEnabled: true,
      webSearchDepth: 'advanced',
      messages: [
        { role: 'user', content: 'old question' },
        { role: 'assistant', content: 'old answer' },
        { role: 'user', content: 'latest public fact?' },
      ],
    }),
  });

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    message: { role: 'assistant', content: 'AI searched reply' },
    sources: [{ provider: 'tavily', title: 'Trusted result', url: 'https://example.com/trusted', content: 'Fresh public snippet', score: 0.9 }],
  });
  assert.equal(tavilyHeaders.Authorization, 'Bearer tvly-user-provided-key');
  assert.deepEqual(tavilyPayload, {
    query: 'latest public fact?',
    search_depth: 'advanced',
    topic: 'news',
    max_results: 5,
    include_answer: true,
    include_raw_content: false,
    include_images: false,
  });
  assert.equal(deepSeekPayload.messages[0].role, 'system');
  assert.match(deepSeekPayload.messages[0].content, /Search says hello\./);
  assert.match(deepSeekPayload.messages[0].content, /https:\/\/example\.com\/trusted/);
  assert.equal(deepSeekPayload.messages[1].role, 'system');
  assert.match(deepSeekPayload.messages[1].content, /I prefer concise Chinese replies\./);
  assert.doesNotMatch(JSON.stringify(deepSeekPayload), /private diary content|private title|should not be forwarded|tvly-user-provided-key/);
});

test('AI chat can combine Tavily and Perplexity automatic web search sources', async (t) => {
  const originalFetch = global.fetch;
  const { baseUrl } = loadFreshApp(t, {
    deepseekBaseUrl: 'https://deepseek.test',
    tavilyBaseUrl: 'https://tavily.test',
    perplexityBaseUrl: 'https://perplexity.test',
  });

  let tavilyPayload = null;
  let perplexityPayload = null;
  let perplexityHeaders = {};
  let deepSeekPayload = null;
  global.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.startsWith('http://127.0.0.1')) return originalFetch(url, options);
    if (target === 'https://tavily.test/search') {
      tavilyPayload = JSON.parse(options.body);
      return new Response(JSON.stringify({
        answer: 'Tavily answer',
        results: [{ title: 'Tavily source', url: 'https://example.com/tavily', content: 'Tavily snippet', score: 0.8 }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (target === 'https://perplexity.test/search') {
      perplexityHeaders = options.headers || {};
      perplexityPayload = JSON.parse(options.body);
      return new Response(JSON.stringify({
        answer: 'Perplexity answer',
        results: [{ title: 'Perplexity source', url: 'https://example.com/perplexity', snippet: 'Perplexity snippet' }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    deepSeekPayload = JSON.parse(options.body);
    return new Response(JSON.stringify({
      choices: [{ message: { content: 'AI searched both' } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  t.after(() => {
    global.fetch = originalFetch;
  });

  const res = await fetch(`${baseUrl}/api/ai/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      apiKey: 'user-provided-key',
      tavilyApiKey: 'tvly-user-provided-key',
      perplexityApiKey: 'pplx-user-provided-key',
      webSearchEnabled: true,
      webSearchDepth: 'basic',
      messages: [{ role: 'user', content: 'latest public fact?' }],
    }),
  });

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.message.content, 'AI searched both');
  assert.equal(body.toolCall, undefined);
  assert.deepEqual(body.sources, [
    { provider: 'tavily', title: 'Tavily source', url: 'https://example.com/tavily', content: 'Tavily snippet', score: 0.8 },
    { provider: 'perplexity', title: 'Perplexity source', url: 'https://example.com/perplexity', content: 'Perplexity snippet', score: null },
  ]);
  assert.deepEqual(tavilyPayload, {
    query: 'latest public fact?',
    search_depth: 'basic',
    topic: 'news',
    max_results: 5,
    include_answer: true,
    include_raw_content: false,
    include_images: false,
  });
  assert.equal(perplexityHeaders.Authorization, 'Bearer pplx-user-provided-key');
  assert.deepEqual(perplexityPayload, { query: ['latest public fact?'] });
  assert.match(deepSeekPayload.messages[0].content, /Provider: Tavily/);
  assert.match(deepSeekPayload.messages[0].content, /Provider: Perplexity/);
  assert.match(deepSeekPayload.messages[0].content, /https:\/\/example\.com\/tavily/);
  assert.match(deepSeekPayload.messages[0].content, /https:\/\/example\.com\/perplexity/);
  assert.doesNotMatch(JSON.stringify(deepSeekPayload), /tvly-user-provided-key|pplx-user-provided-key/);
});

test('AI editor endpoint uses provided editor context without reading log storage', async (t) => {
  const originalFetch = global.fetch;
  const { db, baseUrl } = loadFreshApp(t, {
    deepseekBaseUrl: 'https://deepseek.test',
  });
  db.create({
    title: 'private stored title',
    content: 'private stored diary content',
    category: DIARY_CATEGORY,
    log_date: '2026-05-16',
  });

  let capturedPayload = null;
  global.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.startsWith('http://127.0.0.1')) return originalFetch(url, options);
    capturedPayload = JSON.parse(options.body);
    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            reply: '可以改得更清楚。',
            suggestedTitle: '清晰标题',
            insertText: '- 新增行动项',
            suggestedContent: '# 完整正文',
          }),
        },
      }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  t.after(() => {
    global.fetch = originalFetch;
  });

  const res = await fetch(`${baseUrl}/api/ai/editor`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      apiKey: 'user-provided-key',
      model: 'deepseek-v4-flash',
      reasoningEffort: 'high',
      messages: [{ role: 'user', content: '帮我润色当前日志' }],
      editorContext: {
        logId: 12,
        title: 'front title',
        content: 'front markdown body',
        selection: { start: 0, end: 5 },
      },
    }),
  });

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    message: { role: 'assistant', content: '可以改得更清楚。' },
    editorSuggestion: {
      reply: '可以改得更清楚。',
      suggestedTitle: '清晰标题',
      suggestedContent: '# 完整正文',
      insertText: '- 新增行动项',
    },
    sources: [],
  });
  assert.equal(capturedPayload.model, 'deepseek-v4-flash');
  assert.equal(capturedPayload.stream, false);
  assert.deepEqual(capturedPayload.thinking, { type: 'enabled' });
  assert.equal(capturedPayload.reasoning_effort, 'high');
  assert.equal(capturedPayload.messages[0].role, 'system');
  assert.match(capturedPayload.messages[0].content, /front title/);
  assert.match(capturedPayload.messages[0].content, /front markdown body/);
  assert.match(capturedPayload.messages[0].content, /selectionText:\nfront/);
  assert.deepEqual(capturedPayload.messages.slice(1), [{ role: 'user', content: '帮我润色当前日志' }]);
  assert.doesNotMatch(JSON.stringify(capturedPayload), /private stored diary content|private stored title|user-provided-key/);
});

test('AI editor validates input and keeps Tavily search limited to the user message', async (t) => {
  const originalFetch = global.fetch;
  const { baseUrl } = loadFreshApp(t, {
    deepseekBaseUrl: 'https://deepseek.test',
    tavilyBaseUrl: 'https://tavily.test',
  });

  const invalidContext = await fetch(`${baseUrl}/api/ai/editor`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      apiKey: 'user-provided-key',
      messages: [{ role: 'user', content: 'hello' }],
      editorContext: { title: 'missing content' },
    }),
  });
  assert.equal(invalidContext.status, 400);

  const invalidModel = await fetch(`${baseUrl}/api/ai/editor`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      apiKey: 'user-provided-key',
      model: 'bad-model',
      messages: [{ role: 'user', content: 'hello' }],
      editorContext: { title: '', content: '', selection: { start: 0, end: 0 } },
    }),
  });
  assert.equal(invalidModel.status, 400);

  let tavilyPayload = null;
  let deepSeekPayload = null;
  global.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.startsWith('http://127.0.0.1')) return originalFetch(url, options);
    if (target === 'https://tavily.test/search') {
      tavilyPayload = JSON.parse(options.body);
      return new Response(JSON.stringify({
        answer: 'Search answer',
        results: [{ title: 'Search source', url: 'https://example.com/source', content: 'public only' }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    deepSeekPayload = JSON.parse(options.body);
    return new Response(JSON.stringify({
      choices: [{ message: { content: '{"reply":"searched","insertText":"ok"}' } }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  t.after(() => {
    global.fetch = originalFetch;
  });

  const res = await fetch(`${baseUrl}/api/ai/editor`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      apiKey: 'user-provided-key',
      tavilyApiKey: 'tvly-user-provided-key',
      webSearchEnabled: true,
      webSearchDepth: 'basic',
      messages: [{ role: 'user', content: 'search public facts' }],
      editorContext: {
        title: 'log title',
        content: 'sensitive editor markdown should not be searched',
        selection: { start: 0, end: 0 },
      },
    }),
  });

  assert.equal(res.status, 200);
  assert.deepEqual(tavilyPayload, {
    query: 'search public facts',
    search_depth: 'basic',
    topic: 'general',
    max_results: 5,
    include_answer: true,
    include_raw_content: false,
    include_images: false,
  });
  assert.match(deepSeekPayload.messages[0].content, /sensitive editor markdown/);
  assert.match(deepSeekPayload.messages[0].content, /https:\/\/example\.com\/source/);
  assert.doesNotMatch(JSON.stringify(tavilyPayload), /sensitive editor markdown|log title|tvly-user-provided-key/);
});

test('AI image generation validates options and stores Seedream output locally', async (t) => {
  const originalFetch = global.fetch;
  const missing = loadFreshApp(t);
  const missingKey = await fetch(`${missing.baseUrl}/api/ai/image/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: '生成一张项目封面' }),
  });
  assert.equal(missingKey.status, 503);

  const { baseUrl, dataDir } = loadFreshApp(t, {
    seedreamApiKey: 'seedream-env-key',
    seedreamBaseUrl: 'https://seedream.test/api/v3',
  });

  for (const body of [
    { prompt: '' },
    { prompt: 'hello', model: 'bad-model' },
    { prompt: 'hello', size: 'tiny' },
    { prompt: 'hello', watermark: 'true' },
  ]) {
    const invalid = await fetch(`${baseUrl}/api/ai/image/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(invalid.status, 400);
  }

  let seedreamPayload = null;
  let seedreamHeaders = {};
  global.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.startsWith('http://127.0.0.1')) return originalFetch(url, options);
    if (target === 'https://seedream.test/api/v3/images/generations') {
      seedreamHeaders = options.headers || {};
      seedreamPayload = JSON.parse(options.body);
      return new Response(JSON.stringify({
        data: [{ url: 'https://seedream.test/generated/output.png' }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (target === 'https://seedream.test/generated/output.png') {
      return new Response(new Uint8Array([137, 80, 78, 71, 1, 2, 3]), {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      });
    }
    throw new Error(`Unexpected fetch: ${target}`);
  };
  t.after(() => {
    global.fetch = originalFetch;
  });

  const res = await fetch(`${baseUrl}/api/ai/image/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: '生成一张蓝色工作日志封面',
      image: 'https://example.com/reference.png',
      model: 'doubao-seedream-4-5-251128',
      size: '2848x1600',
      watermark: false,
    }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.match(body.url, /^\/uploads\/.+\.png$/);
  assert.match(body.filename, /\.png$/);
  assert.equal(body.prompt, '生成一张蓝色工作日志封面');
  assert.equal(body.model, 'doubao-seedream-4-5-251128');
  assert.equal(body.size, '2848x1600');
  assert.equal(seedreamHeaders.Authorization, 'Bearer seedream-env-key');
  assert.deepEqual(seedreamPayload, {
    model: 'doubao-seedream-4-5-251128',
    prompt: '生成一张蓝色工作日志封面',
    size: '2848x1600',
    response_format: 'url',
    extra_body: {
      watermark: false,
      image: 'https://example.com/reference.png',
    },
  });
  assert.equal(fs.existsSync(path.join(dataDir, 'uploads', body.filename)), true);
  assert.doesNotMatch(JSON.stringify(seedreamPayload), /private diary content|seedream-env-key/);
});

test('AI image prompt optimization uses only user-provided prompt and context', async (t) => {
  const originalFetch = global.fetch;
  const missing = loadFreshApp(t);
  const missingKey = await fetch(`${missing.baseUrl}/api/ai/image/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: '生成图片：保留触发词的项目封面' }),
  });
  assert.equal(missingKey.status, 503);

  const { baseUrl, dataDir } = loadFreshApp(t, {
    deepseekApiKey: 'sk-image-prompt-key',
    deepseekBaseUrl: 'https://deepseek.prompt.test',
  });

  const invalid = await fetch(`${baseUrl}/api/ai/image/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: '' }),
  });
  assert.equal(invalid.status, 400);

  let deepSeekPayload = null;
  let deepSeekHeaders = {};
  global.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.startsWith('http://127.0.0.1')) return originalFetch(url, options);
    assert.equal(target, 'https://deepseek.prompt.test/chat/completions');
    deepSeekHeaders = options.headers || {};
    deepSeekPayload = JSON.parse(options.body);
    return new Response(JSON.stringify({
      choices: [{ message: { content: '{"prompt":"优化后的视觉提示词，电影感光线，清晰构图"}' } }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  t.after(() => {
    global.fetch = originalFetch;
  });

  const res = await fetch(`${baseUrl}/api/ai/image/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: '生成图片：保留触发词的项目封面',
      context: '标题：周报\n选区：盈利图表',
      model: 'deepseek-v4-pro',
      reasoningEffort: 'max',
    }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.prompt, '优化后的视觉提示词，电影感光线，清晰构图');
  assert.equal(deepSeekHeaders.Authorization, 'Bearer sk-image-prompt-key');
  assert.equal(deepSeekPayload.model, 'deepseek-v4-pro');
  assert.equal(deepSeekPayload.stream, false);
  assert.equal(deepSeekPayload.reasoning_effort, 'max');
  assert.match(deepSeekPayload.messages[0].content, /Return ONLY valid JSON/);
  assert.match(deepSeekPayload.messages[1].content, /生成图片：保留触发词的项目封面/);
  assert.match(deepSeekPayload.messages[1].content, /标题：周报/);
  assert.doesNotMatch(JSON.stringify(deepSeekPayload), /sk-image-prompt-key|private diary content|logs\.json/);
  assert.equal(fs.existsSync(path.join(dataDir, 'ai-settings.json')), false);
});

test('AI chat streams sanitized DeepSeek SSE deltas', async (t) => {
  const originalFetch = global.fetch;
  const { baseUrl } = loadFreshApp(t, {
    deepseekBaseUrl: 'https://deepseek.test',
  });

  let capturedPayload = null;
  global.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.startsWith('http://127.0.0.1')) return originalFetch(url, options);
    capturedPayload = JSON.parse(options.body);
    const stream = [
      'data: {"choices":[{"delta":{"content":"Hel"}}]}',
      '',
      'data: {"choices":[{"delta":{"content":"lo"}}]}',
      '',
      'data: [DONE]',
      '',
      '',
    ].join('\n');
    return new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
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
      stream: true,
      messages: [{ role: 'user', content: 'hello' }],
    }),
  });

  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /text\/event-stream/);
  const text = await res.text();
  assert.match(text, /event: delta\s+data: \{"content":"Hel"\}/);
  assert.match(text, /event: delta\s+data: \{"content":"lo"\}/);
  assert.match(text, /event: done/);
  assert.equal(capturedPayload.stream, true);
  assert.deepEqual(capturedPayload.messages, [{ role: 'user', content: 'hello' }]);
  assert.doesNotMatch(text, /user-provided-key|sk-/);
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

test('AI conversations persist to local data storage separate from logs', async (t) => {
  const { baseUrl, dataDir } = loadFreshApp(t);

  const saved = await fetch(`${baseUrl}/api/ai/conversations`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      activeConversationId: 'chat-local-1',
      conversations: [{
        id: 'chat-local-1',
        title: 'local AI',
        updatedAt: 1780628000000,
        scope: 'global',
        logKey: '',
        messages: [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'hi' },
        ],
      }, {
        id: 'editor-chat-local-1',
        title: 'editor AI',
        updatedAt: 1780628000100,
        scope: 'editor',
        logKey: 'log:7',
        messages: [
          { role: 'user', content: 'edit this' },
          { role: 'assistant', content: 'ok', editorSuggestion: { suggestedTitle: 'new title', insertText: 'insert me' } },
        ],
      }],
    }),
  });
  assert.equal(saved.status, 200);

  const loaded = await fetch(`${baseUrl}/api/ai/conversations`);
  assert.equal(loaded.status, 200);
  assert.deepEqual(await loaded.json(), {
    activeConversationId: 'chat-local-1',
    conversations: [{
      id: 'chat-local-1',
      title: 'local AI',
      updatedAt: 1780628000000,
      scope: 'global',
      logKey: '',
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
      ],
    }, {
      id: 'editor-chat-local-1',
      title: 'editor AI',
      updatedAt: 1780628000100,
      scope: 'editor',
      logKey: 'log:7',
      messages: [
        { role: 'user', content: 'edit this' },
        { role: 'assistant', content: 'ok', editorSuggestion: { suggestedTitle: 'new title', insertText: 'insert me' } },
      ],
    }],
  });

  assert.equal(fs.existsSync(path.join(dataDir, 'ai-chats.json')), true);
  assert.equal(fs.readFileSync(path.join(dataDir, 'logs.json'), 'utf8'), '[]');
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
  assert.equal(document.querySelector('#btnEditorAiPanel').textContent, 'AI');
  assert.equal(document.querySelector('#btnEditorAiPanel').getAttribute('aria-controls'), 'editorAiPanel');
  assert.equal(document.querySelector('#btnEditorAiPanel').getAttribute('aria-expanded'), 'false');
  assert.equal(document.querySelector('#editorAiPanel').getAttribute('aria-hidden'), 'true');
  assert.equal(document.querySelector('#editorAiMessages').getAttribute('aria-live'), 'polite');
  assert.equal(document.querySelector('#editorAiInput').getAttribute('maxlength'), '4000');
  assert.equal(document.querySelector('#btnEditorAiSend').disabled, true);
  assert.equal(document.querySelector('#btnEditorAiNew').textContent, '新对话');
  assert.equal(document.querySelector('#btnEditorAiHistory').getAttribute('aria-controls'), 'editorAiHistoryPopover');
  assert.equal(document.querySelector('#btnEditorAiHistory').getAttribute('aria-expanded'), 'false');
  assert.equal(document.querySelector('#btnEditorAiSettings').getAttribute('aria-haspopup'), null);
  assert.equal(document.querySelector('#editorAiHistoryPopover').hasAttribute('hidden'), true);
  assert.equal(document.querySelector('#editorAiHistoryList') !== null, true);
  assert.equal(document.querySelector('#editorAiRenameOverlay').getAttribute('aria-labelledby'), 'editorAiRenameTitle');
  assert.equal(document.querySelector('#editorAiRenameInput').getAttribute('maxlength'), '40');
  assert.equal(document.querySelector('#btnEditorFullscreen').textContent, '全屏编辑');
  assert.equal(document.querySelector('#btnEditorFullscreen').getAttribute('aria-pressed'), 'false');
  assert.equal(document.querySelector('#btnBack').closest('.editor-nav-actions') !== null, true);
  assert.equal(document.querySelector('#aiChatView').style.display, 'none');
  assert.equal(document.querySelector('#aiSettingsView').style.display, 'none');
  assert.equal(document.querySelector('#btnAiBack'), null);
  assert.equal(document.querySelector('#aiChatView .ai-chat-header'), null);
  assert.equal(document.querySelector('#aiChatMessages').getAttribute('aria-live'), 'polite');
  assert.equal(document.querySelector('#sidebarModeTrigger').getAttribute('aria-haspopup'), 'menu');
  assert.equal(document.querySelector('#sidebarModeTrigger').getAttribute('aria-expanded'), 'false');
  assert.equal(document.querySelector('#sidebarModeMenu').getAttribute('role'), 'menu');
  assert.equal(document.querySelector('#sidebarModeMenu').style.display, 'none');
  assert.deepEqual([...document.querySelectorAll('#sidebarModeMenu [data-mode]')].map(button => button.dataset.mode), [
    'normal',
    'todo',
    'categories',
    'ai',
  ]);
  assert.equal(document.querySelector('#sidebarModeMenu [data-mode="nav"]'), null);
  assert.equal(document.querySelector('#sidebarModeMenu [data-mode="todo"]').textContent, '待办面板');
  assert.doesNotMatch(document.querySelector('#sidebarModeMenu').textContent, /代办/);
  assert.equal(document.querySelector('#cardNavPanel').closest('.sidebar') !== null, true);
  assert.equal(document.querySelector('#calendarCollapseToggle').getAttribute('aria-expanded'), 'true');
  assert.equal(document.querySelector('#calendarCollapseToggle').getAttribute('aria-controls'), 'calendarBody');
  assert.equal(document.querySelector('#calendarMiniToday').closest('#calendarCollapseToggle') !== null, true);
  assert.equal(document.querySelector('#calendarMiniSummary'), null);
  assert.equal(document.querySelector('#calendarMiniLogHint'), null);
  assert.equal(document.querySelector('#calendarBody').closest('#calendarWidget') !== null, true);
  assert.equal(document.querySelector('#diaryLockPanel').closest('.sidebar') !== null, true);
  assert.equal(document.querySelector('#btnBackup').closest('.backup-buttons') !== null, true);
  assert.equal(document.querySelector('#btnRestore').closest('.backup-buttons') !== null, true);
  assert.equal(document.querySelector('#todoView') !== null, true);
  assert.equal(document.querySelector('#todoView').style.display, 'none');
  assert.equal(document.querySelector('#todoSearchInput') !== null, true);
  assert.equal(document.querySelector('#todoStatPending') !== null, true);
  assert.equal(document.querySelector('#todoStatToday') !== null, true);
  assert.equal(document.querySelector('#todoStatOverdue') !== null, true);
  assert.equal(document.querySelector('#todoStatDone') !== null, true);
  assert.equal(document.querySelector('#todoFullPanel').closest('#todoView') !== null, true);
  assert.equal(document.querySelector('#todoFullTitle').closest('#todoView') !== null, true);
  assert.equal(document.querySelector('#todoSidebarPending').closest('.todo-panel') !== null, true);
  assert.equal(document.querySelector('#todoSidebarToday').closest('.todo-panel') !== null, true);
  assert.equal(document.querySelector('#todoSidebarOverdue').closest('.todo-panel') !== null, true);
  assert.equal(document.querySelector('#todoFullTitle').closest('.sidebar'), null);
  assert.equal(document.querySelector('#sidebarModeSelect'), null);
  assert.equal(document.querySelector('#btnSidebarMode'), null);
  assert.equal(document.querySelector('#btnTodoMode'), null);
  assert.equal(document.querySelector('#btnManageCats'), null);
  assert.equal(document.querySelector('#aiApiKeyInput').getAttribute('type'), 'password');
  assert.equal(document.querySelector('#aiApiKeyInput').getAttribute('autocomplete'), 'off');
  assert.equal(document.querySelector('#aiSettingsTitle').textContent, 'AI 设置');
  assert.equal(document.querySelector('#aiSettingsView .ai-settings-rail') !== null, true);
  assert.equal(document.querySelector('#aiSettingsView .ai-settings-page') !== null, true);
  assert.equal(document.querySelector('#aiSettingsTabChat').textContent, '基础设置');
  assert.equal(document.querySelector('#aiSettingsTabChat').getAttribute('aria-selected'), 'true');
  assert.equal(document.querySelector('#aiSettingsTabImage').textContent, '生图设置');
  assert.equal(document.querySelector('#aiSettingsTabImage').getAttribute('aria-controls'), 'aiSettingsPanelImage');
  assert.equal(document.querySelector('#aiSettingsTabSkills').getAttribute('aria-controls'), 'aiSettingsPanelSkills');
  assert.equal(document.querySelector('#aiSettingsTabSkills').textContent, '技能设置');
  assert.equal(document.querySelector('#aiSettingsPanelImage').hasAttribute('hidden'), true);
  assert.equal(document.querySelector('#aiSettingsPanelSkills').hasAttribute('hidden'), true);
  assert.equal(document.querySelector('label[for="aiApiKeyInput"] span').textContent, 'DeepSeek API Key');
  assert.equal(document.querySelector('#aiApiKeyOverlay'), null);
  assert.equal(document.querySelector('#btnAiApiKey').getAttribute('aria-haspopup'), null);
  assert.equal(document.querySelector('#btnAiApiKey').getAttribute('aria-label'), 'AI 设置');
  assert.equal(document.querySelector('#btnAiNewChat'), null);
  assert.equal(document.querySelector('#btnAiClear'), null);
  assert.equal(document.querySelector('#btnAiApiKey').closest('.ai-sidebar-actions') !== null, true);
  assert.equal(document.querySelector('#btnAiApiKey').classList.contains('ai-sidebar-settings'), true);
  assert.equal(document.querySelector('#btnAiApiKey svg') !== null, true);
  assert.equal(document.querySelector('#aiModelSelect').closest('#aiSettingsPanelChat') !== null, true);
  assert.equal(document.querySelector('#aiReasoningEffort').closest('#aiSettingsPanelChat') !== null, true);
  assert.equal(document.querySelector('#aiStreamToggle').closest('#aiSettingsPanelChat') !== null, true);
  assert.equal(document.querySelector('#aiUserProfileInput').closest('#aiSettingsPanelChat') !== null, true);
  assert.equal(document.querySelector('#aiUserProfileInput').getAttribute('maxlength'), '2000');
  assert.equal(document.querySelector('#aiLogContextToggle').closest('#aiSettingsPanelChat') !== null, true);
  assert.equal(document.querySelector('#aiDiaryContextToggle').closest('#aiSettingsPanelChat') !== null, true);
  assert.equal(document.querySelector('#aiTavilyApiKeyInput').closest('#aiSettingsPanelChat'), null);
  assert.equal(document.querySelector('#aiTavilyApiKeyInput').closest('#aiTavilyConfig') !== null, true);
  assert.equal(document.querySelector('#aiTavilyApiKeyInput').getAttribute('placeholder'), 'tvly-...');
  assert.equal(document.querySelector('#aiPerplexityApiKeyInput').closest('#aiSettingsPanelChat'), null);
  assert.equal(document.querySelector('#aiPerplexityApiKeyInput').closest('#aiPerplexityConfig') !== null, true);
  assert.equal(document.querySelector('#aiPerplexityApiKeyInput').getAttribute('placeholder'), 'pplx-...');
  assert.equal(document.querySelector('#aiWebSearchToggle').closest('#aiSettingsPanelSkills') !== null, true);
  assert.equal(document.querySelector('#aiWebSearchDepth').closest('#aiTavilyConfig') !== null, true);
  assert.equal(document.querySelector('#aiSeedreamApiKeyInput').closest('#aiSettingsPanelImage') !== null, true);
  assert.equal(document.querySelector('#aiSeedreamModel').closest('#aiSettingsPanelImage') !== null, true);
  assert.equal(document.querySelector('#aiSeedreamSize').closest('#aiSettingsPanelImage') !== null, true);
  assert.equal(document.querySelector('#aiSeedreamWatermark').closest('#aiSettingsPanelImage') !== null, true);
  assert.equal(document.querySelector('#aiSkillWestockToggle').closest('#aiSettingsPanelSkills') !== null, true);
  assert.equal(document.querySelector('#aiSkillPerplexityToggle').closest('#aiSettingsPanelSkills') !== null, true);
  assert.equal(document.querySelector('#aiTavilyConfig summary'), null);
  assert.equal(document.querySelector('#aiPerplexityConfig summary'), null);
  assert.equal(document.querySelector('[aria-controls="aiTavilyConfig"]').getAttribute('aria-expanded'), 'false');
  assert.equal(document.querySelector('[aria-controls="aiPerplexityConfig"]').getAttribute('aria-expanded'), 'false');
  assert.equal(document.querySelector('[aria-controls="aiTavilyConfig"]').closest('.ai-skill-config-card') !== null, true);
  assert.equal(document.querySelector('[aria-controls="aiPerplexityConfig"]').closest('.ai-skill-config-card') !== null, true);
  assert.deepEqual([...document.querySelectorAll('#aiSeedreamModel option')].map(option => option.value), [
    'doubao-seedream-5-0-260128',
    'doubao-seedream-4-5-251128',
    'doubao-seedream-4-0-250828',
  ]);
  assert.deepEqual([...document.querySelectorAll('#aiWebSearchDepth option')].map(option => option.value), [
    'basic',
    'advanced',
  ]);
  assert.equal(document.querySelector('.ai-chat-composer-actions #aiModelSelect'), null);
  assert.equal(document.querySelector('.ai-chat-composer-actions #aiReasoningEffort'), null);
  assert.equal(document.querySelector('#btnAiHistory'), null);
  assert.equal(document.querySelector('#aiHistoryOverlay'), null);
  assert.equal(document.querySelector('#aiSidebarHistoryList').closest('#aiSidebarHistoryPanel') !== null, true);
  assert.equal(document.querySelector('#btnAiSidebarNewChat').classList.contains('btn-sidebar-mode'), true);
  assert.equal(document.querySelector('#btnAiSidebarNewChat').classList.contains('ai-sidebar-new'), true);
  assert.equal(document.querySelector('#btnAiSidebarNewChat').getAttribute('aria-label'), '新建对话');
  assert.equal(document.querySelector('#btnAiApiKeySave').textContent, '保存');
  assert.equal(document.querySelector('#btnAiApiKeyClear').textContent, '清除 Key');
  assert.equal(document.querySelector('#btnAiSettingsBack').textContent, '返回对话');
  assert.equal(document.querySelector('#aiRenameOverlay').getAttribute('aria-labelledby'), 'aiRenameTitle');
  assert.equal(document.querySelector('#aiRenameInput').getAttribute('maxlength'), '40');
  assert.equal(document.querySelector('#aiChatInput').getAttribute('maxlength'), '4000');
  assert.equal(document.querySelector('#btnAiSkill').closest('.ai-chat-composer-actions') !== null, true);
  assert.equal(document.querySelector('#aiSkillPicker') !== null, true);
  assert.equal(document.querySelector('#aiSkillChipRow') !== null, true);
  assert.equal(document.querySelector('#btnAiSend').disabled, true);
  assert.equal(document.querySelector('#btnAiImage').disabled, true);
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
  assert.equal(document.querySelector('#btnCategoryBack'), null);
  assert.equal(document.querySelector('#categoryView .category-page-title h2'), null);
  assert.equal(document.querySelector('#catManagerSummary').closest('.category-page-header') !== null, true);
  assert.equal(document.querySelector('#catSearchInput').closest('.category-page-header') !== null, true);
  assert.equal(document.querySelector('#catSearchInput').closest('#categorySidebarPanel'), null);
  assert.equal(document.querySelector('#catNewInput').closest('#categorySidebarPanel') !== null, true);
  assert.equal(document.querySelector('#catAddBtn').closest('#categorySidebarPanel') !== null, true);
  assert.equal(document.querySelector('#catAddToggle').closest('.category-sidebar-header') !== null, true);
  assert.equal(document.querySelector('#catAddPanel').hasAttribute('hidden'), true);
  assert.equal(document.querySelector('#catList').closest('#categorySidebarPanel') !== null, true);
  assert.equal(document.querySelector('#catAddToggle').getAttribute('aria-label'), '添加父分类');
  assert.equal(document.querySelector('#catAddToggle').getAttribute('aria-expanded'), 'false');
  assert.equal(document.querySelector('#catAddBtn').getAttribute('aria-label'), '确认添加父分类');
  assert.equal(document.querySelector('#catAddCancelBtn').getAttribute('aria-label'), '取消添加父分类');
  assert.equal(document.querySelector('.cat-detail-actions #catCalendarDayVisible') !== null, true);
  assert.equal(document.querySelector('#catSubNewInput').closest('.cat-detail-actions') !== null, true);
  assert.equal(document.querySelector('#catSubAddBtn').closest('.cat-detail-actions') !== null, true);
  assert.equal(document.querySelector('#catSubAddBtn').getAttribute('aria-label'), '添加子分类');
  assert.equal(document.querySelector('#btnCatRename').getAttribute('aria-label'), '重命名分类');
  assert.equal(document.querySelector('#btnCatDelete').getAttribute('aria-label'), '删除分类');
  assert.equal(document.querySelector('#catDetailLogCount').closest('.cat-detail-heading') !== null, true);
  assert.equal(document.querySelector('#catViewListBtn').closest('.cat-view-toggle') !== null, true);
  assert.equal(document.querySelector('#catViewGraphBtn').closest('.cat-view-toggle') !== null, true);
  assert.equal(document.querySelector('#catViewListBtn').textContent.trim(), '列表');
  assert.equal(document.querySelector('#catViewGraphBtn').textContent.trim(), '图谱');
  assert.equal(document.querySelector('#catViewListBtn').getAttribute('aria-pressed'), 'true');
  assert.equal(document.querySelector('#catViewGraphBtn').getAttribute('aria-pressed'), 'false');
  assert.equal(document.querySelector('#catGraphView').closest('#catDetailContent') !== null, true);
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
  assert.match(categorySource, /class="cat-detail-sub-item"[\s\S]*draggable="true"/);
  assert.match(categorySource, /setupDragAndDrop\(\{[\s\S]*container: \$\('#catSubList'\),[\s\S]*itemSelector: '\.cat-detail-sub-item'/);
  assert.match(categorySource, /apiFetch\(`\/api\/categories\/\$\{encodeURIComponent\(selectedCategoryName\)\}\/subcategories\/reorder`/);
  assert.match(categorySource, /cat\.sub\.map\(s => `<option value="\$\{escHtml\(s\)\}">\$\{escHtml\(s\)\}<\/option>`\)\.join\(''\)/);
  assert.match(categorySource, /const CATEGORY_DETAIL_VIEW_STORAGE_KEY = 'categoryDetailViewMode';/);
  assert.match(categorySource, /localStorage\.getItem\(CATEGORY_DETAIL_VIEW_STORAGE_KEY\)/);
  assert.match(categorySource, /localStorage\.setItem\(CATEGORY_DETAIL_VIEW_STORAGE_KEY, mode\)/);
  assert.match(categorySource, /function renderCategoryGraph\(cat\)/);
  assert.match(categorySource, /const subs = cat\.sub \|\| \[\];/);
  assert.match(categorySource, /class="cat-graph-lines"/);
  assert.match(categorySource, /class="cat-graph-node cat-graph-parent"/);
  assert.match(categorySource, /class="cat-graph-node cat-graph-sub"[\s\S]*data-sub="\$\{escHtml\(point\.sub\)\}"/);
  assert.match(categorySource, /\$\{cat\.sub_log_counts\?\.\[point\.sub\] \|\| 0\}/);
  assert.match(categorySource, /\$\('#catGraphView'\)\.addEventListener\('click'[\s\S]*openSubcategoryBrowse\(node\.dataset\.sub\)/);
  assert.match(categorySource, /setCategoryDetailViewMode\(categoryDetailViewMode\)/);
  assert.match(htmlSource, /id="catViewListBtn"[\s\S]*aria-pressed="true"[\s\S]*>列表<\/button>/);
  assert.match(htmlSource, /id="catViewGraphBtn"[\s\S]*aria-pressed="false"[\s\S]*>图谱<\/button>/);
  assert.match(htmlSource, /<div class="cat-graph-view" id="catGraphView" style="display:none;"><\/div>/);
  assert.match(styleSource, /\.cat-icon-action\s*\{[\s\S]*width:\s*30px;[\s\S]*height:\s*30px;/);
  assert.match(styleSource, /\.cat-icon-action\.primary\s*\{[\s\S]*background:\s*var\(--color-primary\);/);
  assert.match(styleSource, /\.cat-view-toggle\s*\{[\s\S]*display:\s*inline-flex;/);
  assert.match(styleSource, /\.cat-view-toggle button\[aria-pressed="true"\]\s*\{[\s\S]*background:\s*var\(--color-card\);/);
  assert.match(styleSource, /\.cat-graph-view\s*\{[\s\S]*min-height:\s*min\(460px, 55vh\);/);
  assert.match(styleSource, /\.cat-graph-lines\s*\{[\s\S]*pointer-events:\s*none;/);
  assert.match(styleSource, /\.cat-graph-node\s*\{[\s\S]*position:\s*absolute;[\s\S]*transform:\s*translate\(-50%, -50%\);/);
  assert.match(styleSource, /\.cat-graph-parent\s*\{[\s\S]*background:\s*var\(--color-primary\);/);
  assert.match(styleSource, /\.cat-graph-empty\s*\{[\s\S]*justify-content:\s*center;/);
  assert.match(styleSource, /@media[\s\S]*\.cat-graph-view\s*\{[\s\S]*min-width:\s*520px;[\s\S]*min-height:\s*360px;/);
  assert.match(styleSource, /\.category-sidebar-panel\s*\{[\s\S]*display:\s*none;[\s\S]*background:\s*var\(--sidebar-bg-subtle\);/);
  assert.match(styleSource, /body\.sidebar-category-mode \.category-sidebar-panel\s*\{[\s\S]*display:\s*flex;[\s\S]*flex:\s*1;/);
  assert.doesNotMatch(styleSource, /category-sidebar-search|category-sidebar-toolbar/);
  assert.match(styleSource, /\.category-page-search\s*\{[\s\S]*justify-content:\s*flex-end;/);
  assert.match(styleSource, /\.cat-page-search-input\s*\{[\s\S]*width:\s*min\(460px, 44vw\);/);
  assert.match(styleSource, /\.category-sidebar-add\s*\{[\s\S]*grid-template-columns:\s*minmax\(0, 1fr\) 30px 30px;/);
  assert.match(styleSource, /\.category-sidebar-add\[hidden\]\s*\{[\s\S]*display:\s*none;/);
  assert.match(styleSource, /\.category-sidebar-panel \.cat-list\s*\{[\s\S]*overflow-y:\s*auto;/);
  assert.match(styleSource, /\.category-page-grid\s*\{[\s\S]*grid-template-columns:\s*minmax\(360px, 1fr\);/);
  assert.match(styleSource, /\.category-view\.sub-browse-mode \.category-page-grid\s*\{[\s\S]*grid-template-columns:\s*minmax\(280px, 340px\) minmax\(360px, 1fr\);/);
  assert.match(styleSource, /\.category-parent-panel\s*\{[\s\S]*display:\s*none;/);
  assert.match(styleSource, /\.category-view\.sub-browse-mode \.category-parent-panel\s*\{[\s\S]*display:\s*flex;/);
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
  assert.match(todoSource, /export function showTodoView\(\)/);
  assert.match(todoSource, /\$\('#todoView'\)\.style\.display = 'flex';/);
  assert.match(todoSource, /let todoSearchQuery = '';/);
  assert.match(todoSource, /\$\('#todoSearchInput'\)\.addEventListener\('input'/);
  assert.match(todoSource, /String\(t\.notes \|\| ''\)\.toLowerCase\(\)\.includes\(query\)/);
  assert.match(todoSource, /pending\.slice\(0, 6\)/);
  assert.match(todoSource, /\$\('#todoSidebarPending'\)\.textContent = pending\.length;/);
  assert.match(todoSource, /\$\('#todoStatOverdue'\)\.textContent = overdue\.length;/);
  assert.doesNotMatch(todoSource, /priorityDot/);
  assert.match(priorityStyleBlock, /min-width:\s*22px;/);
  assert.match(priorityStyleBlock, /border-radius:\s*5px;/);
  assert.doesNotMatch(priorityStyleBlock, /border-radius:\s*50%;/);
  assert.match(styleSource, /\.todo-priority\.prio-normal\s*\{[\s\S]*background: var\(--color-primary\);/);
  assert.match(styleSource, /\.todo-priority\.prio-important\s*\{[\s\S]*background: var\(--color-warning\);/);
  assert.match(styleSource, /\.todo-priority\.prio-urgent\s*\{ background: var\(--color-danger\); \}/);
  assert.match(styleSource, /\.todo-view\s*\{[\s\S]*flex-direction:\s*column;/);
  assert.match(styleSource, /\.todo-page-stats\s*\{[\s\S]*grid-template-columns:\s*repeat\(4, minmax\(0, 1fr\)\);/);
  assert.match(styleSource, /\.todo-page-layout\s*\{[\s\S]*grid-template-columns:\s*minmax\(0, 1fr\) minmax\(300px, 360px\);/);
  assert.match(styleSource, /\.todo-sidebar-stats\s*\{[\s\S]*grid-template-columns:\s*repeat\(3, 1fr\);/);
  assert.match(styleSource, /body\.sidebar-todo-mode \.todo-panel\s*\{[\s\S]*display:\s*flex;/);
  assert.match(styleSource, /\.todo-full-form textarea\s*\{[\s\S]*min-height:\s*200px;/);
});

test('application initialization waits for auth and diary selection before refreshing', () => {
  const appSource = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
  const authSource = fs.readFileSync(path.join(ROOT, 'public', 'js', 'auth.js'), 'utf8');

  assert.match(appSource, /const authenticated = await checkAuth\(\);[\s\S]*if \(!authenticated\) return;[\s\S]*const diarySelected = await initDiaryLock\(\);[\s\S]*if \(!diarySelected\) await refreshAll\(\);/);
  assert.match(appSource, /window\.addEventListener\('auth-success', async \(\) => \{[\s\S]*await initDiaryLock\(\)/);
  assert.match(authSource, /showLoginOverlay\(\);\s*return false;/);
});

test('default sidebar uses card navigation and a collapsible calendar', () => {
  const calendarSource = fs.readFileSync(path.join(ROOT, 'public', 'js', 'calendar.js'), 'utf8');
  const logListSource = fs.readFileSync(path.join(ROOT, 'public', 'js', 'logList.js'), 'utf8');
  const styleSource = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');

  assert.match(calendarSource, /const CALENDAR_COLLAPSED_STORAGE_KEY = 'calendarCollapsed';/);
  assert.match(calendarSource, /localStorage\.getItem\(CALENDAR_COLLAPSED_STORAGE_KEY\) === 'true'/);
  assert.match(calendarSource, /localStorage\.setItem\(CALENDAR_COLLAPSED_STORAGE_KEY, String\(collapsed\)\)/);
  assert.match(calendarSource, /calendarWidget\.classList\.toggle\('collapsed', calendarCollapsed\)/);
  assert.match(calendarSource, /calendarCollapseToggle\.setAttribute\('aria-expanded', String\(!calendarCollapsed\)\)/);
  assert.match(calendarSource, /import \{ businessDateString, formatDateLabel, formatTemplateDate \} from '\.\/businessDate\.js';/);
  assert.match(calendarSource, /calendarMiniToday\.textContent = formatTemplateDate\(today, 'MM月DD日 ddd'\)/);
  assert.doesNotMatch(calendarSource, /calendarMiniSummary|calendarMiniLogHint|monthLogDays/);
  assert.match(calendarSource, /calendarCollapseToggle\.addEventListener\('click'/);
  assert.match(logListSource, /renderCardNavigator\(data\)/);
  assert.match(styleSource, /\.calendar-widget\.collapsed \.calendar-body\s*\{[\s\S]*display:\s*none;/);
  assert.match(styleSource, /\.calendar-widget\.collapsed ~ \.diary-lock-panel,[\s\S]*\.calendar-widget\.collapsed ~ \.backup-buttons\s*\{[\s\S]*display:\s*none;/);
  assert.match(styleSource, /body\.sidebar-tools-mode \.calendar-widget\.collapsed ~ \.diary-lock-panel\s*\{[\s\S]*display:\s*block;/);
  assert.match(styleSource, /body\.sidebar-tools-mode \.calendar-widget\.collapsed ~ \.backup-buttons\s*\{[\s\S]*display:\s*flex;/);
  assert.match(styleSource, /\.calendar-collapse-toggle\s*\{[\s\S]*grid-template-columns:\s*minmax\(0, 1fr\) auto;/);
  assert.doesNotMatch(styleSource, /calendar-mini-summary|calendar-mini-log-hint/);
  assert.match(styleSource, /\.card-nav-panel\s*\{[\s\S]*display:\s*flex;[\s\S]*flex:\s*1;[\s\S]*min-height:\s*0;[\s\S]*flex-direction:\s*column;/);
  assert.match(styleSource, /\.card-nav-body\s*\{[\s\S]*flex:\s*1;[\s\S]*min-height:\s*0;[\s\S]*display:\s*flex;/);
  assert.match(styleSource, /\.card-nav-list\s*\{[\s\S]*max-height:\s*none;/);
  assert.match(styleSource, /\.todo-panel\s*\{[\s\S]*display:\s*none;/);
  assert.match(styleSource, /\.stats-panel\s*\{[\s\S]*display:\s*none;/);
  assert.match(styleSource, /body\.sidebar-todo-mode \.todo-panel\s*\{[\s\S]*display:\s*flex;/);
  assert.match(styleSource, /body\.sidebar-tools-mode \.stats-panel\s*\{[\s\S]*display:\s*block;/);
  assert.doesNotMatch(styleSource, /sidebar-nav-mode/);
});

test('AI chat frontend supports local history and fixed thinking mode', () => {
  const appSource = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
  const aiSource = fs.readFileSync(path.join(ROOT, 'public', 'js', 'aiChat.js'), 'utf8');
  const styleSource = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');

  assert.match(appSource, /import \{ initAiChat, showAiChatView \} from '\.\/aiChat\.js';/);
  assert.match(appSource, /const SIDEBAR_MODE_KEY = 'sidebarMode';/);
  assert.match(appSource, /function setSidebarMode\(mode, \{ updateMain = true \} = \{\}\)/);
  assert.match(appSource, /if \(!\['normal', 'todo', 'categories', 'ai'\]\.includes\(mode\)\) mode = 'normal';/);
  assert.match(appSource, /document\.body\.classList\.toggle\('sidebar-ai-mode', mode === 'ai'\);/);
  assert.match(appSource, /document\.body\.classList\.toggle\('sidebar-category-mode', mode === 'categories'\);/);
  assert.doesNotMatch(appSource, /sidebar-nav-mode|mode === 'nav'|当前为日志导航/);
  assert.match(appSource, /import \{ loadCategories, openCategoryManager \} from '\.\/categories\.js';/);
  assert.match(appSource, /import \{ loadTodos, showTodoView \} from '\.\/todos\.js';/);
  assert.match(appSource, /\$\('#sidebarModeTrigger'\)\.addEventListener\('click', toggleSidebarModeMenu\)/);
  assert.match(appSource, /\$\('#sidebarModeMenu'\)\.addEventListener\('click'/);
  assert.match(appSource, /function closeSidebarModeMenu\(\)/);
  assert.match(appSource, /function toggleSidebarModeMenu\(\)/);
  assert.match(appSource, /title\.textContent = '待办事项';[\s\S]*当前为待办面板/);
  assert.match(appSource, /mode === 'todo'[\s\S]*showTodoView\(\)/);
  assert.match(appSource, /function syncMainViewWithSidebarMode\(\)[\s\S]*activeSidebarMode\(\) === 'ai'[\s\S]*showAiChatView\(\)[\s\S]*activeSidebarMode\(\) === 'categories'[\s\S]*openCategoryManager\(\)[\s\S]*activeSidebarMode\(\) === 'todo'[\s\S]*showTodoView\(\)/);
  assert.match(appSource, /window\.addEventListener\('category-manager-closed'/);
  assert.doesNotMatch(appSource, /btnCategoryBack/);
  assert.match(aiSource, /for \(const id of \['aiSettingsView', 'aiChatView', 'editorView', 'categoryView', 'todoView', 'listView'\]\)/);
  assert.match(aiSource, /for \(const viewId of \['listView', 'editorView', 'categoryView', 'todoView', 'aiChatView', 'aiSettingsView'\]\)/);
  assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'public', 'js', 'categories.js'), 'utf8'), /btnManageCats/);
  assert.match(appSource, /if \(!diarySelected\) await refreshAll\(\);[\s\S]*syncMainViewWithSidebarMode\(\);/);
  assert.match(appSource, /\$\('#fabCapture'\)\.addEventListener\('click', \(\) => \{[\s\S]*setSidebarMode\('ai'\);[\s\S]*\}\);/);
  assert.doesNotMatch(appSource, /fabCapture[\s\S]{0,160}newLog\(\)/);
  assert.match(appSource, /initAiChat\(\);/);
  assert.match(aiSource, /body: JSON\.stringify\(\{ messages: chat\.messages, \.\.\.requestSettings \}\)/);
  assert.match(aiSource, /body: JSON\.stringify\(\{ messages: chat\.messages\.filter\(message => !message\.streaming\), \.\.\.requestSettings \}\)/);
  assert.match(aiSource, /import \{ renderToHtml \} from '\.\/markdown\.js';/);
  assert.match(aiSource, /confirmDialog/);
  assert.match(aiSource, /const API_KEY_STORAGE_KEY = 'deepseekApiKey';/);
  assert.match(aiSource, /const CHAT_STORAGE_KEY = 'aiChatConversations';/);
  assert.match(aiSource, /const ACTIVE_CHAT_STORAGE_KEY = 'aiChatActiveConversationId';/);
  assert.match(aiSource, /const AI_CONVERSATIONS_ENDPOINT = '\/api\/ai\/conversations';/);
  assert.match(aiSource, /const AI_SETTINGS_ENDPOINT = '\/api\/ai\/settings';/);
  assert.match(aiSource, /async function loadSettings\(\)/);
  assert.match(aiSource, /await saveSettings\(\{ quiet: true \}\);[\s\S]*localStorage\.removeItem\(API_KEY_STORAGE_KEY\);/);
  assert.match(aiSource, /westock: \{ \.\.\.settings\.skills\?\.westock \}/);
  assert.match(aiSource, /perplexity: \{ \.\.\.settings\.skills\?\.perplexity \}/);
  assert.match(aiSource, /服务端未保存 AI 设置，请重启应用后再试/);
  assert.match(aiSource, /apiKey: settings\.apiKey/);
  assert.match(aiSource, /model: settings\.model \|\| DEFAULT_MODEL/);
  assert.match(aiSource, /thinkingMode: 'enabled'/);
  assert.match(aiSource, /reasoningEffort: settings\.reasoningEffort \|\| DEFAULT_REASONING/);
  assert.match(aiSource, /stream: skill \? false : Boolean\(settings\.stream\)/);
  assert.match(aiSource, /userProfile: settings\.userProfile \|\| ''/);
  assert.match(aiSource, /logContextEnabled: Boolean\(settings\.logContextEnabled\)/);
  assert.match(aiSource, /diaryContextEnabled: Boolean\(settings\.diaryContextEnabled\)/);
  assert.match(aiSource, /tavilyApiKey: settings\.tavilyApiKey/);
  assert.match(aiSource, /perplexityApiKey: settings\.perplexityApiKey/);
  assert.match(aiSource, /webSearchEnabled: Boolean\(settings\.webSearchEnabled\)/);
  assert.match(aiSource, /webSearchDepth: settings\.webSearchDepth \|\| 'basic'/);
  assert.match(aiSource, /const DEFAULT_SEEDREAM_MODEL = 'doubao-seedream-5-0-260128';/);
  assert.match(aiSource, /seedreamApiKey: typeof value\?\.seedreamApiKey === 'string'/);
  assert.match(aiSource, /perplexityApiKey: typeof value\?\.perplexityApiKey === 'string'/);
  assert.match(aiSource, /seedreamModel: \['doubao-seedream-5-0-260128'/);
  assert.match(aiSource, /\$\('#aiPerplexityApiKeyInput'\)\.value = settings\.perplexityApiKey;/);
  assert.match(aiSource, /\$\('#aiSeedreamApiKeyInput'\)\.value = settings\.seedreamApiKey;/);
  assert.match(aiSource, /function setSettingsTab\(tab\)/);
  assert.match(aiSource, /document\.querySelectorAll\('\[data-ai-settings-tab\]'\)/);
  assert.match(aiSource, /function setSkillConfigExpanded\(card, expanded\)/);
  assert.match(aiSource, /trigger\.setAttribute\('aria-expanded', String\(expanded\)\)/);
  assert.match(aiSource, /panel\.hidden = !expanded/);
  assert.match(aiSource, /function resetSkillConfigPanels\(\)/);
  assert.match(aiSource, /function toggleSkillConfigFromHeader\(event\)/);
  assert.match(aiSource, /document\.querySelectorAll\('\[data-skill-config-toggle\]'\)/);
  assert.match(aiSource, /const AI_SKILLS_ENDPOINT = '\/api\/ai\/skills';/);
  assert.match(aiSource, /async function loadSkills\(\)/);
  assert.match(aiSource, /function renderSkillPicker\(\)/);
  assert.match(aiSource, /function renderSelectedSkillChip\(\)/);
  assert.match(aiSource, /function renderToolCallCard\(toolCall, toolResult, index\)/);
  assert.match(aiSource, /async function executeSkillTool\(index\)/);
  assert.match(aiSource, /request\.skill = \{ id: skill\.id \};/);
  assert.match(aiSource, /\$\('#btnAiSkill'\)\?\.addEventListener\('click', toggleSkillPicker\);/);
  assert.match(aiSource, /apiFetch\(`\/api\/ai\/skills\/\$\{encodeURIComponent\(toolCall\.skillId\)\}\/run`/);
  assert.match(aiSource, /data\.toolCall\?\.skillId === 'westock'/);
  assert.doesNotMatch(aiSource, /function isImageGenerationRequest\(text\)/);
  assert.doesNotMatch(aiSource, /isImageGenerationRequest\(content\)/);
  assert.match(aiSource, /function renderImageGenerationCard\(imageGeneration, index/);
  assert.match(aiSource, /async function generateImageForMessage\(index\)/);
  assert.match(aiSource, /apiFetch\('\/api\/ai\/image\/generate'/);
  assert.match(aiSource, /apiFetch\('\/api\/ai\/image\/prompt'/);
  assert.match(aiSource, /function selectedImagePrompt\(imageGeneration\)/);
  assert.match(aiSource, /function chooseImagePrompt\(index, mode\)/);
  assert.match(aiSource, /data-action="choose-image-prompt"/);
  assert.match(aiSource, /async function sendMessage\(\{ forceImage = false \} = \{\}\)/);
  assert.match(aiSource, /if \(forceImage\) \{/);
  assert.match(aiSource, /\$\('#btnAiImage'\)\?\.addEventListener\('click', \(\) => sendMessage\(\{ forceImage: true \}\)\);/);
  assert.match(aiSource, /originalPrompt: prompt/);
  assert.match(aiSource, /optimizedPrompt/);
  assert.match(aiSource, /promptMode: 'original'/);
  assert.match(aiSource, /data-action="generate-image"/);
  assert.match(aiSource, /data-action="copy-image-markdown"/);
  assert.match(aiSource, /function imagePromptFrom\(text\)\s*\{\s*return String\(text \|\| ''\)\.trim\(\)\.slice\(0, 800\);/);
  assert.match(aiSource, /if \(forceImage\) \{[\s\S]*imageGeneration: \{[\s\S]*status: 'optimizing'/);
  assert.match(aiSource, /await apiFetch\(AI_CONVERSATIONS_ENDPOINT,[\s\S]*method: 'PUT'/);
  assert.match(aiSource, /let allConversations = \[\];/);
  assert.match(aiSource, /const nonGlobalConversations = allConversations\.filter\(item => item\.scope === 'editor'\);/);
  assert.match(aiSource, /allConversations = \[\.\.\.nonGlobalConversations, \.\.\.conversations\.map\(item => \(\{ \.\.\.item, scope: 'global', logKey: '' \}\)\)\];/);
  assert.doesNotMatch(aiSource, /localStorage\.setItem\(CHAT_STORAGE_KEY|localStorage\.setItem\(ACTIVE_CHAT_STORAGE_KEY/);
  assert.match(aiSource, /async function newConversation\(\)/);
  assert.match(aiSource, /function openRenameModal\(id\)/);
  assert.match(aiSource, /function saveRenameConversation\(\)/);
  assert.match(aiSource, /function deleteConversation\(id\)/);
  assert.match(aiSource, /\$\('#btnAiSidebarNewChat'\)\.addEventListener\('click', newConversation\);/);
  assert.match(aiSource, /const list = \$\('#aiSidebarHistoryList'\);/);
  assert.match(aiSource, /\$\('#aiSidebarHistoryList'\)\.addEventListener\('click'/);
  assert.doesNotMatch(aiSource, /btnAiBack|btnAiHistory|aiHistoryOverlay|aiChatHistoryList/);
  assert.doesNotMatch(aiSource, /localStorage\.setItem\(API_KEY_STORAGE_KEY/);
  assert.match(aiSource, /localStorage\.removeItem\(API_KEY_STORAGE_KEY\);/);
  assert.match(aiSource, /function openSettingsPage\(tab = 'chat'\)/);
  assert.match(aiSource, /function closeSettingsPage\(\)/);
  assert.match(aiSource, /function saveSettingsFromPage\(\)/);
  assert.match(aiSource, /\$\('#btnAiApiKey'\)\.addEventListener\('click', \(\) => openSettingsPage\('chat'\)\);/);
  assert.match(aiSource, /\$\('#btnAiSettingsBack'\)\.addEventListener\('click', closeSettingsPage\);/);
  assert.match(aiSource, /\$\('#btnAiApiKeySave'\)\.addEventListener\('click', saveSettingsFromPage\);/);
  assert.match(aiSource, /\$\('#aiRenameClose'\)\.addEventListener\('click', closeRenameModal\);/);
  assert.match(aiSource, /\$\('#btnAiRenameSave'\)\.addEventListener\('click', saveRenameConversation\);/);
  assert.match(aiSource, /message\.role === 'assistant' \? renderToHtml\(message\.content\) : escHtml\(message\.content\)/);
  assert.match(aiSource, /function copyTextFallback\(text\)/);
  assert.match(aiSource, /navigator\.clipboard\?\.writeText/);
  assert.match(aiSource, /data-action="copy-message"/);
  assert.match(aiSource, /copyMessageByIndex\(index\)/);
  assert.match(aiSource, /\$\('#aiChatMessages'\)\.addEventListener\('click'/);
  assert.match(aiSource, /问题已复制/);
  assert.match(aiSource, /回答已复制/);
  assert.match(aiSource, /ai-message-sources/);
  assert.match(aiSource, /rel="noopener noreferrer"/);
  assert.match(aiSource, /ai-message-thinking/);
  assert.match(aiSource, /正在思考/);
  assert.doesNotMatch(aiSource, /window\.(prompt|confirm)/);
  assert.doesNotMatch(aiSource, /aiThinkingMode/);
  assert.match(aiSource, /send\.disabled = sending \|\| !hasText;/);
  assert.match(aiSource, /showToast\(`AI 对话失败：\$\{err\.message\}`/);
  assert.match(aiSource, /async function readStreamingReply\(res, assistantMessage\)/);
  assert.match(aiSource, /const decoder = new TextDecoder\(\);/);
  assert.match(aiSource, /event\.type === 'delta'/);
  assert.match(aiSource, /renderToHtml\(message\.content\)/);
  assert.match(styleSource, /\.ai-chat-composer\s*\{[\s\S]*border-radius:\s*8px;/);
  assert.match(styleSource, /\.sidebar-title-trigger\s*\{[\s\S]*color:\s*var\(--color-sidebar-heading\);[\s\S]*font-size:\s*1\.25rem;/);
  assert.match(styleSource, /\.sidebar-mode-menu\s*\{[\s\S]*position:\s*absolute;/);
  assert.match(styleSource, /\.ai-sidebar-history-panel\s*\{[\s\S]*display:\s*none;/);
  assert.match(styleSource, /body\.sidebar-ai-mode \.ai-sidebar-history-panel\s*\{[\s\S]*display:\s*flex;/);
  assert.match(styleSource, /\.ai-sidebar-new,[\s\S]*\.ai-sidebar-settings\s*\{[\s\S]*width:\s*30px;[\s\S]*height:\s*30px;/);
  assert.match(styleSource, /\.ai-sidebar-actions\s*\{[\s\S]*display:\s*inline-flex;/);
  assert.match(styleSource, /\.ai-sidebar-settings\s*\{[\s\S]*border-color:\s*transparent;[\s\S]*background:\s*transparent;[\s\S]*color:\s*#111;/);
  assert.match(styleSource, /\.ai-sidebar-settings\.has-key\s*\{[\s\S]*color:\s*#000;[\s\S]*background:\s*transparent;/);
  assert.match(styleSource, /\.ai-history-list\s*\{[\s\S]*gap:\s*0;[\s\S]*align-content:\s*start;/);
  assert.match(styleSource, /\.ai-history-item\s*\{[\s\S]*grid-template-columns:\s*minmax\(0, 1fr\) 28px 28px;[\s\S]*height:\s*78px;/);
  assert.match(styleSource, /\.ai-history-action\s*\{[\s\S]*width:\s*24px;[\s\S]*height:\s*24px;/);
  assert.match(styleSource, /\.ai-chat-composer-actions\s*\{[\s\S]*flex-wrap:\s*wrap;/);
  assert.match(styleSource, /\.ai-chat-composer\s*\{[\s\S]*position:\s*fixed;/);
  assert.match(styleSource, /\.ai-chat-composer textarea\s*\{[\s\S]*padding:\s*8px 150px 42px 10px;/);
  assert.match(styleSource, /\.ai-chat-composer-actions\s*\{[\s\S]*position:\s*absolute;[\s\S]*right:\s*20px;[\s\S]*bottom:\s*20px;/);
  assert.match(styleSource, /\.ai-chat-composer-actions \.btn-secondary\s*\{[\s\S]*pointer-events:\s*auto;/);
  assert.doesNotMatch(styleSource, /\.ai-chat-composer-actions\s*\{[^}]*border-top:\s*1px solid var\(--color-border\);/);
  assert.match(styleSource, /body\.sidebar-collapsed \.ai-chat-messages,[\s\S]*body\.sidebar-collapsed \.ai-chat-composer\s*\{[\s\S]*width:\s*min\(1080px, calc\(100% - 56px\)\);/);
  assert.match(styleSource, /body\.sidebar-collapsed:not\(\.editor-fullscreen\) \.main\s*\{[\s\S]*padding-left:\s*72px;/);
  assert.match(styleSource, /body\.sidebar-ai-mode \.main\s*\{[\s\S]*overflow:\s*hidden;/);
  assert.match(styleSource, /body\.sidebar-ai-mode \.ai-chat-body\s*\{[\s\S]*position:\s*fixed;[\s\S]*right:\s*0;[\s\S]*bottom:\s*156px;[\s\S]*left:\s*var\(--sidebar-width\);/);
  assert.match(styleSource, /body\.sidebar-collapsed \.ai-chat-body\s*\{[\s\S]*left:\s*0;/);
  assert.match(styleSource, /\.ai-chat-view::after\s*\{[\s\S]*position:\s*fixed;[\s\S]*left:\s*var\(--sidebar-width\);[\s\S]*height:\s*156px;[\s\S]*z-index:\s*80;/);
  assert.match(styleSource, /body\.sidebar-collapsed \.ai-chat-view::after\s*\{[\s\S]*left:\s*0;/);
  assert.match(styleSource, /\.ai-chat-body\s*\{[\s\S]*overflow-y:\s*auto;[\s\S]*overflow-x:\s*hidden;[\s\S]*padding-bottom:\s*0;/);
  assert.match(styleSource, /\.ai-chat-messages\s*\{[\s\S]*overflow:\s*visible;/);
  assert.match(styleSource, /\.ai-message-content\.markdown-body\s*\{[\s\S]*line-height:\s*1\.65;/);
  assert.match(styleSource, /\.ai-message-bubble\s*\{[\s\S]*position:\s*relative;/);
  assert.match(styleSource, /\.ai-message-copy\s*\{[\s\S]*position:\s*absolute;[\s\S]*right:\s*8px;/);
  assert.match(styleSource, /\.ai-message:hover \.ai-message-copy,[\s\S]*\.ai-message-copy:focus-visible\s*\{[\s\S]*opacity:\s*1;/);
  assert.match(styleSource, /\.ai-message-sources\s*\{[\s\S]*grid-column:\s*2;/);
  assert.match(styleSource, /\.ai-message-sources a\s*\{[\s\S]*border-radius:\s*999px;/);
  assert.match(styleSource, /\.ai-message-thinking \.ai-message-content\s*\{[\s\S]*display:\s*inline-flex;/);
  assert.match(styleSource, /@keyframes ai-thinking-pulse/);
  assert.doesNotMatch(styleSource, /\.ai-chat-header\s*\{/);
  assert.match(styleSource, /\.ai-settings-view\s*\{[\s\S]*display:\s*flex;/);
  assert.match(styleSource, /\.ai-settings-rail\s*\{[\s\S]*width:\s*min\(260px, 24vw\);/);
  assert.match(styleSource, /\.ai-settings-page\s*\{[\s\S]*flex-direction:\s*column;/);
  assert.match(styleSource, /\.ai-settings-toggle\s*\{[\s\S]*justify-content:\s*space-between;/);
  assert.match(styleSource, /\.ai-settings-tabs\s*\{[\s\S]*display:\s*grid;/);
  assert.match(styleSource, /\.ai-settings-panel\.active\s*\{[\s\S]*display:\s*grid;/);
  assert.match(styleSource, /\.ai-skill-settings-grid\s*\{[\s\S]*display:\s*grid;/);
  assert.match(styleSource, /\.ai-skill-config-card\s*\{[\s\S]*overflow:\s*hidden;[\s\S]*border:\s*1px solid var\(--color-border\);/);
  assert.match(styleSource, /\.ai-skill-config-head\s*\{[\s\S]*display:\s*flex;/);
  assert.match(styleSource, /\.ai-skill-config-trigger\s*\{[\s\S]*cursor:\s*pointer;/);
  assert.match(styleSource, /\.ai-skill-config-card\.expanded \.ai-skill-config-chevron\s*\{[\s\S]*transform:\s*rotate\(180deg\);/);
  assert.match(styleSource, /\.ai-skill-config\s*\{[\s\S]*border-top:\s*1px solid var\(--color-border\);/);
  assert.doesNotMatch(styleSource, /\.ai-skill-config summary/);
  assert.match(styleSource, /\.ai-image-card\s*\{[\s\S]*border:\s*1px solid rgba\(var\(--color-primary-rgb\), 0\.18\);/);
  assert.match(styleSource, /\.ai-image-optimizing\s*\{[\s\S]*display:\s*inline-flex;/);
  assert.match(styleSource, /\.ai-image-prompt-options\s*\{[\s\S]*display:\s*inline-flex;/);
  assert.match(styleSource, /\.ai-image-prompt-choice\.active\s*\{[\s\S]*background:\s*var\(--color-primary\);/);
  assert.match(styleSource, /\.ai-image-prompt-text\s*\{[\s\S]*max-height:\s*120px;[\s\S]*overflow-y:\s*auto;/);
  assert.match(styleSource, /\.ai-image-preview\s*\{[\s\S]*max-height:\s*360px;/);
  assert.match(styleSource, /\.ai-chat-composer\s*\{[\s\S]*margin:\s*0 auto 12px;/);
  assert.match(styleSource, /\.ai-chat-composer textarea\s*\{[\s\S]*min-height:\s*72px;[\s\S]*max-height:\s*120px;[\s\S]*resize:\s*none;/);
  assert.match(styleSource, /\.ai-settings-body\s*\{[\s\S]*overflow-y:\s*auto;/);
  assert.match(styleSource, /@media \(max-width: 768px\)[\s\S]*\.ai-settings-view\s*\{[\s\S]*flex-direction:\s*column;/);
  assert.match(styleSource, /@media \(max-width: 768px\)[\s\S]*\.ai-settings-tabs\s*\{[\s\S]*grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\);/);
  assert.match(styleSource, /@media \(max-width: 768px\)[\s\S]*\.ai-chat-view::after\s*\{[\s\S]*left:\s*0;[\s\S]*height:\s*calc\(132px \+ env\(safe-area-inset-bottom\)\);/);
  assert.match(styleSource, /@media \(max-width: 768px\)[\s\S]*\.ai-chat-messages\s*\{[\s\S]*padding:\s*16px 12px 210px;/);
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

test('editor AI panel sends current log context and applies suggestions explicitly', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const editorSource = fs.readFileSync(path.join(ROOT, 'public', 'js', 'editor.js'), 'utf8');
  const styleSource = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');
  const document = new JSDOM(html).window.document;

  assert.equal(document.querySelector('#btnEditorAiPanel') !== null, true);
  assert.equal(document.querySelector('#editorAiPanel') !== null, true);
  assert.equal(document.querySelector('#editorAiMessages') !== null, true);
  assert.equal(document.querySelector('#editorAiInput') !== null, true);
  assert.equal(document.querySelector('#btnEditorAiSend') !== null, true);
  assert.equal(document.querySelector('#btnEditorAiImage') !== null, true);
  assert.equal(document.querySelector('#btnEditorAiHistory') !== null, true);
  assert.equal(document.querySelector('#btnEditorAiSettings') !== null, true);
  assert.equal(document.querySelector('#editorAiHistoryPopover') !== null, true);
  assert.equal(document.querySelector('#editorAiRenameOverlay') !== null, true);
  assert.match(editorSource, /const AI_CONVERSATIONS_ENDPOINT = '\/api\/ai\/conversations';/);
  assert.match(editorSource, /function currentEditorLogKey\(\)[\s\S]*`log:\$\{state\.editingId\}`[\s\S]*`draft:\$\{editorAiDraftSessionId\}`/);
  assert.match(editorSource, /async function migrateEditorAiDraftConversation\(savedId\)/);
  assert.match(editorSource, /scope: 'editor'/);
  assert.match(editorSource, /logKey/);
  assert.match(editorSource, /const DEFAULT_SEEDREAM_MODEL = 'doubao-seedream-5-0-260128';/);
  assert.doesNotMatch(editorSource, /function isEditorImageGenerationRequest\(text\)/);
  assert.doesNotMatch(editorSource, /isEditorImageGenerationRequest\(content\)/);
  assert.match(editorSource, /function renderEditorImageGenerationCard\(imageGeneration, index\)/);
  assert.match(editorSource, /async function generateEditorImageForMessage\(index\)/);
  assert.match(editorSource, /apiFetch\('\/api\/ai\/image\/generate'/);
  assert.match(editorSource, /apiFetch\('\/api\/ai\/image\/prompt'/);
  assert.match(editorSource, /function selectedEditorImagePrompt\(imageGeneration\)/);
  assert.match(editorSource, /function chooseEditorImagePrompt\(index, mode\)/);
  assert.match(editorSource, /function editorImagePromptContext\(\)/);
  assert.match(editorSource, /function editorImagePromptFrom\(text\)\s*\{\s*return String\(text \|\| ''\)\.trim\(\)\.slice\(0, 800\);/);
  assert.match(editorSource, /const btnEditorAiImage = \$\('#btnEditorAiImage'\);/);
  assert.match(editorSource, /async function sendEditorAiMessage\(\{ forceImage = false \} = \{\}\)/);
  assert.match(editorSource, /if \(forceImage\) \{/);
  assert.match(editorSource, /btnEditorAiImage\?\.addEventListener\('click', \(\) => sendEditorAiMessage\(\{ forceImage: true \}\)\);/);
  assert.match(editorSource, /data-action="choose-editor-image-prompt"/);
  assert.match(editorSource, /originalPrompt: prompt/);
  assert.match(editorSource, /optimizedPrompt/);
  assert.match(editorSource, /promptMode: 'original'/);
  assert.match(editorSource, /data-action="generate-editor-image"/);
  assert.match(editorSource, /data-action="insert-editor-image-markdown"/);
  assert.match(editorSource, /if \(forceImage\) \{[\s\S]*imageGeneration: \{[\s\S]*status: 'optimizing'/);
  assert.match(editorSource, /function editorAiConversationsForCurrentLog\(\)[\s\S]*const logKey = currentEditorLogKey\(\);[\s\S]*item\.scope === 'editor' && item\.logKey === logKey/);
  assert.match(editorSource, /function renderEditorAiHistory\(\)/);
  assert.match(editorSource, /function setEditorAiHistoryOpen\(open\)/);
  assert.match(editorSource, /function openEditorAiSettings\(\)[\s\S]*\$\('#btnAiApiKey'\)[\s\S]*settingsButton\.click\(\)/);
  assert.match(editorSource, /async function switchEditorAiConversation\(id\)[\s\S]*editorAiActiveConversationId = id;[\s\S]*renderEditorAiMessages\(\);/);
  assert.match(editorSource, /function openEditorAiRenameModal\(id\)/);
  assert.match(editorSource, /async function saveEditorAiRename\(\)[\s\S]*chat\.title = title\.slice\(0, 40\);/);
  assert.match(editorSource, /async function deleteEditorAiConversation\(id\)[\s\S]*confirmDialog\(\{[\s\S]*删除日志内对话/);
  assert.match(editorSource, /function getEditorAiContext\(\)[\s\S]*title: editTitle\.value,[\s\S]*content,[\s\S]*selection:/);
  assert.match(editorSource, /contentEditor\.getSelection\(\)/);
  assert.match(editorSource, /apiFetch\('\/api\/ai\/editor'/);
  assert.match(editorSource, /body: JSON\.stringify\(\{[\s\S]*messages: chat\.messages,[\s\S]*editorContext: getEditorAiContext\(\),[\s\S]*\}\)/);
  assert.match(editorSource, /function renderEditorAiSuggestionPreview\(message, index\)/);
  assert.match(editorSource, /class="editor-ai-answer markdown-body"/);
  assert.match(editorSource, /class="editor-ai-suggestion-card\$\{expandable \? ' collapsed' : ' expanded'\}"/);
  assert.match(editorSource, /class="editor-ai-suggestion-preview"/);
  assert.match(editorSource, /suggestion\.suggestedTitle/);
  assert.match(editorSource, /renderToHtmlUncached\(suggestion\.insertText\)/);
  assert.match(editorSource, /renderToHtmlUncached\(suggestion\.suggestedContent\)/);
  assert.match(editorSource, /data-editor-ai-toggle-suggestion="\$\{index\}"/);
  assert.match(editorSource, /data-editor-ai-apply="\$\{action\}"/);
  assert.match(editorSource, /action === 'title'[\s\S]*editTitle\.value = suggestion\.suggestedTitle;[\s\S]*autoSave\(\);/);
  assert.match(editorSource, /action === 'insert'[\s\S]*contentEditor\.insertAtSelection\(insertText\);[\s\S]*autoSave\(\);/);
  assert.match(editorSource, /action === 'replace-selection'[\s\S]*contentEditor\.applyValue\(nextValue, cursor, cursor\);[\s\S]*autoSave\(\);/);
  assert.match(editorSource, /action === 'replace-body'[\s\S]*contentEditor\.applyValue\(suggestion\.suggestedContent, suggestion\.suggestedContent\.length, suggestion\.suggestedContent\.length\);[\s\S]*autoSave\(\);/);
  assert.match(editorSource, /function insertEditorGeneratedImage\(index\)[\s\S]*contentEditor\.insertAtSelection\(markdown\);[\s\S]*autoSave\(\);/);
  assert.match(editorSource, /btnEditorAiPanel\.addEventListener\('click'/);
  assert.match(editorSource, /btnEditorAiHistory\.addEventListener\('click'/);
  assert.match(editorSource, /btnEditorAiSettings\.addEventListener\('click', openEditorAiSettings\);/);
  assert.match(editorSource, /editorAiMessages\.addEventListener\('click'/);
  assert.match(editorSource, /const toggleButton = event\.target\.closest\('\[data-editor-ai-toggle-suggestion\]'\);[\s\S]*toggleButton\.textContent = expanded \? '收起' : '展开';[\s\S]*return;/);
  assert.match(editorSource, /editorAiHistoryList\.addEventListener\('click'/);
  assert.doesNotMatch(editorSource, /window\.(prompt|confirm)/);
  assert.match(styleSource, /\.editor-outline-layout\.editor-ai-open \.editor-ai-panel\s*\{[\s\S]*display:\s*flex;/);
  assert.match(styleSource, /\.editor-ai-panel\s*\{[\s\S]*flex:\s*0 0 380px;/);
  assert.match(styleSource, /\.editor-ai-history-popover\s*\{[\s\S]*position:\s*absolute;/);
  assert.match(styleSource, /\.editor-ai-history-item\s*\{[\s\S]*grid-template-columns:\s*minmax\(0, 1fr\) 28px 28px;[\s\S]*height:\s*58px;/);
  assert.match(styleSource, /\.ai-image-card\s*\{[\s\S]*display:\s*grid;/);
  assert.match(styleSource, /\.editor-ai-assistant-bubble\s*\{[\s\S]*flex-direction:\s*column;/);
  assert.match(styleSource, /\.editor-ai-suggestion-preview\s*\{[\s\S]*max-height:\s*280px;[\s\S]*overflow-y:\s*auto;/);
  assert.match(styleSource, /\.editor-ai-suggestion-card\.collapsed \.editor-ai-suggestion-preview\s*\{[\s\S]*max-height:\s*132px;/);
  assert.match(styleSource, /\.editor-ai-suggestion-card\.expanded \.editor-ai-suggestion-preview\s*\{[\s\S]*max-height:\s*360px;/);
  assert.match(styleSource, /\.editor-ai-composer textarea\s*\{[\s\S]*min-height:\s*84px;/);
  assert.match(styleSource, /body\.editor-fullscreen \.editor-outline-layout\.editor-ai-open \.editor-tabs/);
  assert.match(styleSource, /@media \(max-width: 768px\)[\s\S]*\.editor-outline-layout\.editor-ai-open\s*\{[\s\S]*flex-direction:\s*column;/);
  assert.match(styleSource, /@media \(max-width: 768px\)[\s\S]*\.editor-ai-history-popover\s*\{[\s\S]*position:\s*fixed;/);
  assert.match(styleSource, /@media \(max-width: 768px\)[\s\S]*\.editor-ai-suggestion-card\.expanded \.editor-ai-suggestion-preview\s*\{[\s\S]*max-height:\s*260px;/);
});

test('mobile layout uses compact on-demand sidebar panels and retains collapse controls', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const appSource = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
  const styleSource = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');
  const document = new JSDOM(html).window.document;
  const mobileStyles = styleSource.slice(styleSource.indexOf('@media (max-width: 768px)'), styleSource.indexOf('/* Collapsed sidebar */'));

  assert.equal(document.querySelector('#btnSidebarTools').getAttribute('aria-label'), '切换更多工具');
  assert.equal(document.querySelector('#sidebarModeTrigger') !== null, true);
  assert.equal(document.querySelector('#sidebarModeMenu') !== null, true);
  assert.doesNotMatch(mobileStyles, /\.btn-sidebar-toggle\s*\{\s*display:\s*none/);
  assert.match(mobileStyles, /\.btn-theme-toggle,[\s\S]*\.btn-sidebar-toggle\s*\{[\s\S]*min-width:\s*36px;[\s\S]*min-height:\s*36px;/);
  assert.match(mobileStyles, /\.btn-sidebar-tools\s*\{\s*display:\s*flex;/);
  assert.match(mobileStyles, /\.card-nav-panel,[\s\S]*\.category-sidebar-panel\s*\{\s*display:\s*none;/);
  assert.match(mobileStyles, /body\.sidebar-ai-mode \.ai-sidebar-history-panel\s*\{[\s\S]*display:\s*flex;/);
  assert.match(mobileStyles, /body\.sidebar-category-mode \.category-sidebar-panel\s*\{[\s\S]*display:\s*flex;/);
  assert.match(mobileStyles, /body\.sidebar-tools-mode \.stats-panel\s*\{[\s\S]*display:\s*block;/);
  assert.doesNotMatch(mobileStyles, /sidebar-nav-mode/);
  assert.match(mobileStyles, /body\.sidebar-collapsed \.sidebar\s*\{\s*display:\s*none;/);
  assert.match(appSource, /function collapseSidebar\(\)\s*\{\s*document\.body\.classList\.toggle\('sidebar-collapsed'\);\s*\}/);
  assert.match(appSource, /\$\('#btnToggleSidebar'\)\.addEventListener\('click', collapseSidebar\);[\s\S]*\$\('#btnSidebarExpand'\)\.addEventListener\('click', collapseSidebar\);/);
  assert.match(appSource, /function setSidebarToolsMode\(enabled\)[\s\S]*sidebar-tools-mode/);
  assert.match(appSource, /\$\('#sidebarModeTrigger'\)\.addEventListener\('click', toggleSidebarModeMenu\)/);
  assert.doesNotMatch(appSource, /localStorage\.(?:setItem|getItem)\([^)]*sidebar-collapsed/i);
});

test('mobile layout gives filters and editor controls touch-friendly responsive treatment', () => {
  const styleSource = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');
  const mobileStyles = styleSource.slice(styleSource.indexOf('@media (max-width: 768px)'), styleSource.indexOf('/* Collapsed sidebar */'));

  assert.match(mobileStyles, /\.toolbar\s*\{[\s\S]*display:\s*grid;[\s\S]*grid-template-columns:\s*repeat\(2,/);
  assert.match(mobileStyles, /#btnNewLog,[\s\S]*#filterSubcategory\s*\{[\s\S]*grid-column:\s*1 \/ -1;/);
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
  editor.setVisible(true);
  assert.equal(editor.usesRichEditor(), false);
  assert.equal(textarea.style.display, 'block');
  assert.equal(mount.style.display, 'none');
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

test('content editor defers textarea changes until IME composition ends', async (t) => {
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

  const moduleUrl = pathToFileURL(path.join(ROOT, 'public', 'js', 'contentEditor.js')).href + `?ime=${Date.now()}`;
  const { createContentEditor } = await import(moduleUrl);
  const textarea = document.querySelector('#body');
  const editor = createContentEditor(textarea, document.querySelector('#mount'));
  let changes = 0;
  let latest = '';
  editor.onDidChange(value => {
    changes += 1;
    latest = value;
  });

  textarea.dispatchEvent(new dom.window.CompositionEvent('compositionstart', { bubbles: true }));
  textarea.value = '中文，2';
  textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  assert.equal(editor.isComposing(), true);
  assert.equal(changes, 0);

  textarea.dispatchEvent(new dom.window.CompositionEvent('compositionend', { bubbles: true }));
  assert.equal(editor.isComposing(), false);
  assert.equal(changes, 1);
  assert.equal(latest, '中文，2');
  assert.equal(editor.getValue(), '中文，2');
});

test('shortcut matching ignores IME composition keyboard events', async () => {
  const moduleUrl = pathToFileURL(path.join(ROOT, 'public', 'js', 'shortcuts.js')).href + `?ime=${Date.now()}`;
  const { findAction, isImeComposingEvent } = await import(moduleUrl);

  assert.equal(isImeComposingEvent({ key: 'Process', keyCode: 229 }), true);
  assert.equal(findAction({ key: 'Process', keyCode: 229, ctrlKey: true, metaKey: false, altKey: false, shiftKey: false }), null);
  assert.equal(findAction({ key: 's', isComposing: true, ctrlKey: true, metaKey: false, altKey: false, shiftKey: false }), null);
});
