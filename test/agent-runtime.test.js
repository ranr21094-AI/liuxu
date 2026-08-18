const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAgentStore } = require('../lib/agent/store');
const { createMemoryService } = require('../lib/agent/memory');
const { createRuntime, parseActionEnvelope } = require('../lib/agent/runtime');
const { defaultModelClient } = require('../lib/agent/model');
const { createKnowledgeService } = require('../lib/knowledge/documents');
const { createSearchIndex } = require('../lib/knowledge/search');
const { runtimeFor } = require('../lib/agent/routes');

function tempDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  process.env.DATA_DIR = dir;
  process.env.AI_SECRETS_KEY_FILE = path.join(dir, 'ai-secrets.key');
  delete require.cache[require.resolve('../database.js')];
  return require('../database.js');
}

test('action envelope parses tool calls', () => {
  const parsed = parseActionEnvelope('note {"action":"tool","tools":[{"name":"task.list","arguments":{}}]}');
  assert.equal(parsed.action, 'tool');
  assert.equal(parsed.tools[0].name, 'task.list');
});

test('agent runtime completes without tools and can pause for approval', async (t) => {
  const db = tempDb(t);
  const store = createAgentStore(db);
  const memory = createMemoryService(store);
  let round = 0;
  const runtime = createRuntime({
    db,
    store,
    memory,
    hasDiaryAccessFlag: false,
    modelClient: {
      async complete() {
        round += 1;
        if (round === 1) {
          return { text: '', toolCalls: [{ name: 'task.create', arguments: { title: '写周报' } }] };
        }
        return { text: '已创建任务', toolCalls: [] };
      },
    },
  });
  const session = store.createSession('test');
  const run = await runtime.start({ session, goal: '创建任务', userMessage: '创建任务' });
  await new Promise(resolve => setTimeout(resolve, 50));
  const live = store.getRun(run.id);
  assert.equal(live.status, 'waiting_approval');
  const approvalId = live.pendingApprovals[0].id;
  await runtime.resolveApproval(run.id, approvalId, { approved: true });
  const done = store.getRun(run.id);
  assert.equal(done.status, 'completed');
  assert.equal(db.getAllTodos()[0].title, '写周报');
});

test('memory proposals require evidence and filter secrets', (t) => {
  const db = tempDb(t);
  const store = createAgentStore(db);
  const memory = createMemoryService(store);
  assert.equal(memory.propose({ runId: 'r1', title: 'x', content: 'y', evidence: [] }).error, 'Memory requires evidence');
  assert.match(memory.propose({ runId: 'r1', title: 'key', content: 'api_key=abc', evidence: [{ id: 1 }] }).error, /secret/);
  const draft = memory.propose({ runId: 'r1', layer: 'L3', title: 'SOP', content: '先搜索再创建任务', evidence: [{ type: 'run', id: 'r1' }] });
  const saved = memory.approve(draft.proposal.id);
  assert.equal(saved.memory.layer, 'L3');
  assert.equal(memory.list({ layer: 'L3' })[0].title, 'SOP');
});

test('default agent search returns local citations without a provider key', async (t) => {
  const db = tempDb(t);
  db.create({ title: '发布流程', content: '先评审再发布', category: '开发' });
  const store = createAgentStore(db);
  const runtime = createRuntime({
    db,
    store,
    memory: createMemoryService(store),
    knowledgeSearch: (() => { const knowledge = createKnowledgeService(db); return { knowledge, search: createSearchIndex(knowledge) }; })(),
    hasDiaryAccessFlag: false,
    modelClient: await defaultModelClient(),
  });
  const session = store.createSession('search');
  const run = await runtime.start({ session, goal: '搜索发布流程', userMessage: '搜索发布流程' });
  await new Promise(resolve => setTimeout(resolve, 80));
  const saved = store.getRun(run.id);
  assert.equal(saved.status, 'completed');
  assert.equal(saved.citations.length > 0, true);
  assert.match(saved.finalText, /发布流程/);
});

test('agent session summaries stay lightweight and sessions can be renamed or archived', (t) => {
  const db = tempDb(t);
  const store = createAgentStore(db);
  const session = store.createSession('初始标题');
  store.saveSession({ ...session, messages: [{ role: 'user', content: '一段会话内容' }] });
  const summaries = store.listSessionSummaries();
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].lastMessagePreview, '一段会话内容');
  assert.equal('messages' in summaries[0], false);
  const renamed = store.updateSession(session.id, { title: '重命名后' });
  assert.equal(renamed.title, '重命名后');
  store.updateSession(session.id, { status: 'archived' });
  assert.equal(store.listSessionSummaries().length, 0);
  assert.equal(store.listSessionSummaries({ includeArchived: true })[0].status, 'archived');
  assert.equal(store.getSession(session.id).messages[0].content, '一段会话内容');
});

test('agent runtime picks up the model client after a read-only session listing initializes its cache', async (t) => {
  const db = tempDb(t);
  runtimeFor(db, { hasDiaryAccessFlag: false });
  const pack = runtimeFor(db, {
    hasDiaryAccessFlag: false,
    modelClient: { async complete() { return { text: '动态模型已连接', toolCalls: [] }; } },
  });
  const session = pack.store.createSession('生命周期');
  const run = await pack.runtime.start({ session, goal: '测试', userMessage: '测试' });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(pack.store.getRun(run.id).status, 'completed');
  assert.equal(pack.store.getRun(run.id).finalText, '动态模型已连接');
});
