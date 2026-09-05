const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const express = require('express');

process.env.AI_SECRETS_KEY_FILE = process.env.AI_SECRETS_KEY_FILE
  || path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'review3-')), 'ai-secrets.key');

const { createDatabase } = require('../database.js');
const { createAgentStore } = require('../lib/agent/store');
const { createMemoryService } = require('../lib/agent/memory');
const { createRuntime } = require('../lib/agent/runtime');
const { registerAgentRoutes } = require('../lib/agent/routes');
const { shouldPauseForRepeatedMutations } = require('../lib/agent/guards');
const { hasActiveAgentRuns } = require('../lib/agent/active-runs');
const { ensureLogsMigrated } = require('../lib/knowledge/migrate-logs');
const { createKnowledgeService } = require('../lib/knowledge/documents');
const { decryptSecret, encryptSecret, resetSecretStoreForTests } = require('../secret-store');

function tempDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review3-db-'));
  const db = createDatabase(dir);
  t.after(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return db;
}

test('repeated mutation guard catches alternating create/delete loops', () => {
  const run = { mutationHistory: [
    { name: 'task.create', fingerprint: 'a' },
    { name: 'task.delete', fingerprint: 'b' },
    { name: 'task.create', fingerprint: 'a' },
  ] };
  assert.match(shouldPauseForRepeatedMutations(run, 3), /重复/);
  // Identical repeats still pause (same name + same fingerprint).
  const same = { mutationHistory: [
    { name: 'countdown.create', fingerprint: 'x' },
    { name: 'countdown.create', fingerprint: 'x' },
    { name: 'countdown.create', fingerprint: 'x' },
  ] };
  assert.match(shouldPauseForRepeatedMutations(same, 3), /重复/);
  // A normal sequence of distinct writes does not pause.
  const varied = { mutationHistory: [
    { name: 'task.create', fingerprint: 'a' },
    { name: 'note.create', fingerprint: 'b' },
    { name: 'countdown.create', fingerprint: 'c' },
  ] };
  assert.equal(shouldPauseForRepeatedMutations(varied, 3), null);
});

test('cancelling during a model call prevents pending tools from executing', async (t) => {
  const db = tempDb(t);
  const store = createAgentStore(db);
  const memory = createMemoryService(store);
  let releaseModel;
  const modelGate = new Promise(resolve => { releaseModel = resolve; });
  let modelCalled = 0;
  const runtime = createRuntime({
    db,
    store,
    memory,
    hasDiaryAccessFlag: false,
    modelClient: {
      async complete() {
        modelCalled += 1;
        await modelGate;
        return { text: '', toolCalls: [{ name: 'task.create', arguments: { title: '不该被创建的任务' } }] };
      },
    },
  });
  const session = store.createSession('cancel-race');
  const run = await runtime.start({ session, goal: '取消竞态', userMessage: '取消竞态' });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(modelCalled, 1);

  runtime.cancel(run.id);
  releaseModel({ text: '', toolCalls: [{ name: 'task.create', arguments: { title: '不该被创建的任务' } }] });
  await new Promise(resolve => setTimeout(resolve, 50));

  const settled = store.getRun(run.id);
  assert.equal(settled.status, 'cancelled');
  assert.deepEqual(db.getAllTodos(), []);
  assert.equal((settled.pendingApprovals || []).length, 0);
});

test('cancel does not rewrite terminal runs and re-resolving needs no live map', async (t) => {
  const db = tempDb(t);
  const store = createAgentStore(db);
  const memory = createMemoryService(store);
  const runtime = createRuntime({
    db,
    store,
    memory,
    hasDiaryAccessFlag: false,
    modelClient: { async complete() { return { text: '完成', toolCalls: [] }; } },
  });
  const session = store.createSession('terminal');
  const run = await runtime.start({ session, goal: '完成', userMessage: '完成' });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(store.getRun(run.id).status, 'completed');

  const second = runtime.cancel(run.id);
  assert.equal(second.run.status, 'completed', 'cancel must not overwrite a completed run');
  assert.equal(store.getRun(run.id).status, 'completed');
});

test('run retention never evicts runs that are still waiting', (t) => {
  const db = tempDb(t);
  const store = createAgentStore(db);
  for (let index = 0; index < 210; index += 1) {
    store.saveRun({
      id: `completed-${index}`,
      sessionId: 'retention',
      status: 'completed',
      kind: '',
      createdAt: 1000 + index,
      messages: [],
      events: [],
    });
  }
  store.saveRun({
    id: 'waiting-1',
    sessionId: 'retention',
    status: 'waiting_approval',
    kind: '',
    createdAt: 5,
    messages: [],
    events: [],
  });
  assert.ok(store.getRun('waiting-1'), 'active run must survive the 200-run cap');
  assert.equal(store.getRun('completed-0'), null, 'oldest completed run is pruned');
  assert.ok(store.getRun('completed-209'));
});

test('active run detection reads SQLite and the legacy JSON fallback', (t) => {
  const db = tempDb(t);
  const store = createAgentStore(db);
  assert.equal(hasActiveAgentRuns(db), false);

  store.saveRun({ id: 'r1', sessionId: 's1', status: 'running', kind: '', createdAt: Date.now(), messages: [], events: [] });
  assert.equal(hasActiveAgentRuns(db), true);

  store.saveRun({ id: 'r1', sessionId: 's1', status: 'completed', kind: '', createdAt: Date.now(), messages: [], events: [] });
  assert.equal(hasActiveAgentRuns(db), false);

  fs.writeFileSync(path.join(db.dataDir, 'agent-runs.json'), JSON.stringify({
    runs: [{ id: 'legacy', status: 'waiting_user' }],
  }));
  assert.equal(hasActiveAgentRuns(db), true, 'pre-SQLite layout still blocks restores');
});

test('category moves into the diary collection lock their documents', (t) => {
  const db = tempDb(t);
  ensureLogsMigrated(db);
  const knowledge = createKnowledgeService(db);
  const { document } = knowledge.createNote({
    title: '普通笔记',
    content: '正文',
    knowledgeBase: '工作',
  }, { diaryUnlocked: true });
  assert.equal(document.visibility, 'standard');

  knowledge.rewriteCollectionPath('工作', '日记/归档');
  const moved = knowledge.getDocument(document.id, { diaryUnlocked: true });
  assert.equal(moved.visibility, 'diary', 'documents moved into 日记 must be diary-locked');
  assert.equal(knowledge.getDocument(document.id, { diaryUnlocked: false }), null);

  // Moving back out is promote-only: a lock is never silently lifted.
  knowledge.rewriteCollectionPath('日记/归档', '工作');
  assert.equal(knowledge.getDocument(document.id, { diaryUnlocked: false }), null,
    'moving a diary document out of the diary must not unlock it');
  const restored = knowledge.getDocument(document.id, { diaryUnlocked: true });
  assert.equal(restored.visibility, 'diary');
  assert.equal(restored.knowledgeBase, '工作');
});

test('legacy migration re-encrypts image provider keys for the new scope', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review3-electron-'));
  t.after(() => {
    if (previousKeyFile === undefined) delete process.env.AI_SECRETS_KEY_FILE;
    else process.env.AI_SECRETS_KEY_FILE = previousKeyFile;
    resetSecretStoreForTests();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const previousKeyFile = process.env.AI_SECRETS_KEY_FILE;
  process.env.AI_SECRETS_KEY_FILE = path.join(root, 'ai-secrets.key');
  resetSecretStoreForTests();

  const source = path.join(root, 'legacy-data');
  const target = path.join(root, 'installed-data');
  fs.mkdirSync(source, { recursive: true });
  const sourceAad = (field) => `work-log-ai-settings:v1:${path.resolve(source)}:${field}`;
  const targetAad = (field) => `work-log-ai-settings:v1:${path.resolve(target)}:${field}`;
  const schedule = new Database(path.join(source, 'schedule.db'));
  schedule.exec('CREATE TABLE ai_settings (id INTEGER PRIMARY KEY, body TEXT NOT NULL)');
  const sourceSettings = {
    apiKey: '',
    customProviders: [],
    imageProviders: [{
      id: 'img-1',
      apiKey: encryptSecret('image-provider-secret', sourceAad('imageProvider:img-1')),
    }],
  };
  schedule.prepare('INSERT INTO ai_settings (id, body) VALUES (1, ?)').run(JSON.stringify(sourceSettings));
  schedule.close();

  const { reencryptAiSettingsScope } = require('../electron/runtime');
  const result = reencryptAiSettingsScope(path.join(source, 'schedule.db'), source, target);
  assert.equal(result.changed, true);
  assert.equal(result.secrets, 1);

  const installed = new Database(path.join(source, 'schedule.db'), { readonly: true });
  const settings = JSON.parse(installed.prepare('SELECT body FROM ai_settings WHERE id = 1').get().body);
  installed.close();
  assert.equal(decryptSecret(settings.imageProviders[0].apiKey, targetAad('imageProvider:img-1')), 'image-provider-secret');
  assert.throws(() => decryptSecret(settings.imageProviders[0].apiKey, sourceAad('imageProvider:img-1')), /Failed to decrypt/);
});

test('legacy migration aborts when a secret cannot be re-encrypted', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review3-electron-fail-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'legacy-data');
  const target = path.join(root, 'installed-data');
  fs.mkdirSync(source, { recursive: true });
  const previousKeyFile = process.env.AI_SECRETS_KEY_FILE;
  process.env.AI_SECRETS_KEY_FILE = path.join(root, 'ai-secrets.key');
  resetSecretStoreForTests();
  t.after(() => {
    if (previousKeyFile === undefined) delete process.env.AI_SECRETS_KEY_FILE;
    else process.env.AI_SECRETS_KEY_FILE = previousKeyFile;
    resetSecretStoreForTests();
  });

  // The ciphertext is bound to a scope the re-encryption source does not know;
  // the migration must abort instead of committing unreadable secrets.
  const sourceAad = (field) => `work-log-ai-settings:v1:${path.resolve(path.join(root, 'original-location'))}:${field}`;
  const schedule = new Database(path.join(source, 'schedule.db'));
  schedule.exec('CREATE TABLE ai_settings (id INTEGER PRIMARY KEY, body TEXT NOT NULL)');
  schedule.prepare('INSERT INTO ai_settings (id, body) VALUES (1, ?)').run(JSON.stringify({
    apiKey: encryptSecret('bound-to-another-scope', sourceAad('apiKey')),
  }));
  schedule.close();

  const { reencryptAiSettingsScope } = require('../electron/runtime');
  assert.throws(
    () => reencryptAiSettingsScope(path.join(source, 'schedule.db'), path.join(root, 'different-location'), target),
    /Failed to decrypt/,
  );
  assert.equal(fs.existsSync(target), false, 'a failing migration must not write the target');
});

test('client tool results return 404 for unknown or finished runs', async (t) => {
  const db = tempDb(t);
  const app = express();
  registerAgentRoutes(app, { db, hasDiaryAccess: () => false });
  const server = await new Promise(resolve => {
    const started = app.listen(0, '127.0.0.1', () => resolve(started));
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}/api/agent/runs/nope/client-tools/req1/result`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ result: { ok: true } }),
  });
  assert.equal(response.status, 404, 'a missing run must surface its error instead of {ok:true}');
});
